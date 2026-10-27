"""The cross-language round trip (issue #604 R2-A): Python writes the copy
from the synthetic NetCDF (the finals job in fixtures mode, then the
`changed` rewrite), and Node's reader (backend/src/mirror/: openStore,
readManifest, openFinals + readFinalsBlock, manifestHash) reads it back
through tests/roundtrip.ts. Every value of the region on every day must be
bit-equal to what chcnetcdf decoded, sea (NaN) included, and Node's hash and
manifest must agree with Python's.

Needs the pnpm install (backend/node_modules/.bin/tsx). Without it the test
skips, unless INGEST_REQUIRE_NODE=1 (CI's ingest job sets it), when it fails.
"""

import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures"))
sys.path.insert(0, str(HERE / "fixtures" / "chirps"))

import chcnetcdf  # noqa: E402
import chirps_final  # noqa: E402
import cloudwatch  # noqa: E402
import grid  # noqa: E402
import lambda_handler  # noqa: E402
import make_chirps_fixtures as fx  # noqa: E402
import manifest  # noqa: E402
import zarrstore  # noqa: E402

TSX = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
SCRIPT = HERE / "tests" / "roundtrip.ts"


@unittest.skipUnless(TSX.exists() or os.environ.get("INGEST_REQUIRE_NODE") == "1", "needs the pnpm install (backend/node_modules/.bin/tsx); CI sets INGEST_REQUIRE_NODE=1")
class RoundTrip(unittest.TestCase):
    def setUp(self):
        self.assertTrue(TSX.exists(), f"{TSX} is missing: run pnpm install --frozen-lockfile")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def node(self, mirror_url: str, product: str, files: list[tuple[int, int, Path]]) -> dict:
        months = []
        for y, mo, path in files:
            region = chcnetcdf.read_region(str(path))
            values = self.dir / f"{product}-{y}-{mo:02d}.f32"
            values.write_bytes(region.values.astype("<f4").tobytes(order="C"))
            last = region.first_day + dt.timedelta(days=region.values.shape[0] - 1)
            months.append({"url": chirps_final.file_url(product, y, mo), "year": y, "doy0": grid.doy_index(region.first_day), "doy1": grid.doy_index(last), "values": str(values)})
        spec = self.dir / "spec.json"
        spec.write_text(json.dumps({"product": product, "months": months}))
        p = subprocess.run([str(TSX), str(SCRIPT), mirror_url, str(spec)], cwd=ROOT / "backend", capture_output=True, text=True, timeout=300)
        self.assertIn(p.returncode, (0, 1), p.stderr)
        out = json.loads(p.stdout)
        for m in out["months"]:
            self.assertEqual(m["mismatches"], 0, f"{m['url']}: Node read {m['mismatches']} values that differ from Python's, the first at flat index {m['firstMismatch']}")
        self.assertEqual(p.returncode, 0, p.stderr)
        return out

    def write(self, mirror_url: str, variant: str | None = None, s3_client=None) -> None:
        env = {"MIRROR_URL": mirror_url, "FEED_SOURCE": "fixtures", "INGEST_FIXTURE_VARIANT": variant or ""}
        with unittest.mock.patch.dict(os.environ, env):
            lambda_handler.handler({"product": "rnl", "mode": "monthly"}, s3_client=s3_client, metrics=cloudwatch.LocalSink())

    def check_manifest(self, out: dict, mirror_url: str) -> None:
        py = manifest.read(zarrstore.Mirror.from_url(mirror_url), "rnl")
        self.assertEqual(out["manifest"]["revision"], py["revision"])
        self.assertEqual(out["manifest"]["finalThrough"], py["finalThrough"])
        self.assertEqual(out["manifest"]["years"], py["years"])
        self.assertEqual(out["manifest"]["changes"], py["changes"])
        self.assertEqual(out["manifest"]["files"], [{"url": f["url"], "valuesSha256": f["valuesSha256"]} for f in py["files"]])
        by_url = {f["url"]: f["valuesSha256"] for f in py["files"]}
        for m in out["months"]:
            self.assertEqual(m["nodeSha256"], by_url[m["url"]], m["url"])

    def test_node_reads_what_python_wrote_bit_for_bit(self):
        url = f"file://{self.dir / 'mirror'}"
        self.write(url)
        out = self.node(url, "rnl", [(2024, 1, fx.HERE / fx.name(2024, 1)), (2024, 2, fx.HERE / fx.name(2024, 2))])
        self.check_manifest(out, url)
        self.assertEqual(out["manifest"]["revision"], 1)
        self.assertEqual(out["manifest"]["finalThrough"], "2024-02-29")

        # A rewrite with changed values: Node reads the new values and the revision's change.
        self.write(url, "changed")
        out = self.node(url, "rnl", [(2024, 1, fx.HERE / fx.name(2024, 1)), (2024, 2, fx.HERE / "changed" / fx.name(2024, 2))])
        self.check_manifest(out, url)
        self.assertEqual(out["manifest"]["revision"], 2)
        self.assertEqual(out["manifest"]["changes"][0]["cellsChanged"], 2)

    def test_the_s3_staging_path_writes_the_same_objects(self):
        """zarrstore.S3Mirror stages through a temporary directory: its objects, laid out as files, read the same."""
        from fakes3 import FakeS3

        s3 = FakeS3()
        self.write("s3://mirror", s3_client=s3)
        copy = self.dir / "from-s3"
        for (bucket, key), body in s3.objects.items():
            (copy / key).parent.mkdir(parents=True, exist_ok=True)
            (copy / key).write_bytes(body)
        shutil.rmtree(copy / "ingest-state")
        url = f"file://{copy}"
        out = self.node(url, "rnl", [(2024, 1, fx.HERE / fx.name(2024, 1)), (2024, 2, fx.HERE / fx.name(2024, 2))])
        self.check_manifest(out, url)


if __name__ == "__main__":
    unittest.main()
