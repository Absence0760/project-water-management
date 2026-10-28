"""The cross-language round trip (issue #604 R2-A): Python writes the copy
from the synthetic NetCDF (the finals job in fixtures mode, then the
`changed` rewrite), and Node's reader (backend/src/mirror/: openStore,
readManifest, openFinals + readFinalsBlock, manifestHash) reads it back
through tests/roundtrip.ts. Every value of the region on every day must be
bit-equal to what chcnetcdf decoded, sea (NaN) included, and Node's hash and
manifest must agree with Python's.

The 0.1 deg products (issue #604 R4) go the same way through the app's cell
reader: era5land.py (fake CDS) and imerg.py (fake Earthdata) write their
copies, and Node validates each manifest (readManifest) and reads known
cells on known days through readCells, which must give the stored float32's
bits, the days held and no others, and imerg_late's per-day versions.

The reference evaporation products (issue #604 R5-E) are read whole:
agera5.py (fake CDS) and nasapower.py (fake POWER) write `agera5_et0` and
`power_et0`, and Node validates each manifest and reads every cell of every
held day back bit for bit, its hash agreeing with the manifest's.

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
sys.path.insert(0, str(HERE / "fixtures" / "imerg"))

import numpy as np  # noqa: E402

import chcnetcdf  # noqa: E402
import chirps_final  # noqa: E402
import cloudwatch  # noqa: E402
import agera5  # noqa: E402
import era5land  # noqa: E402
import fakecds  # noqa: E402
import grid  # noqa: E402
import imerg  # noqa: E402
import imerg_fixture  # noqa: E402
import lambda_handler  # noqa: E402
import make_chirps_fixtures as fx  # noqa: E402
import manifest  # noqa: E402
import nasapower  # noqa: E402
import power_fixture  # noqa: E402
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

    def node_cells(self, mirror_url: str, product: str, window: tuple[dt.date, dt.date], cells: list[tuple[int, int]]) -> dict:
        spec = self.dir / f"cells-{product}.json"
        spec.write_text(json.dumps({"mode": "cells", "product": product, "window": {"start": window[0].isoformat(), "end": window[1].isoformat()}, "cells": [{"y": y, "x": x} for y, x in cells]}))
        p = subprocess.run([str(TSX), str(SCRIPT), mirror_url, str(spec)], cwd=ROOT / "backend", capture_output=True, text=True, timeout=300)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    @staticmethod
    def cell_bits(v) -> int:
        """readCells' encoding of a stored value: its float32 bits, -1 for NaN (no data), +0 for -0."""
        v = np.float32(v)
        return -1 if np.isnan(v) else int((v if v != 0 else np.float32(0)).view(np.uint32))

    def check_cells(self, out: dict, expected: np.ndarray, cells: list[tuple[int, int]], read: str) -> None:
        """`expected` (days held, rows, cols) is what Python stored for the window's days marked f in `read`."""
        self.assertEqual(out["read"], read)
        held = [i for i, c in enumerate(read) if c == "f"]
        for k, (y, x) in enumerate(cells):
            want = [None] * len(read)
            for n, i in enumerate(held):
                want[i] = self.cell_bits(expected[n, y, x])
            self.assertEqual(out["values"][k], want, f"cell (y {y}, x {x})")

    def test_era5l_python_writes_node_validates_and_reads_its_cells_bit_for_bit(self):
        url = f"file://{self.dir / 'mirror'}"
        today = dt.date(2024, 4, 20)  # 2024-03 is the newest complete month
        cds = fakecds.FakeCds(today=today, ready_after=0)
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": url, "FEED_SOURCE": "fixtures"}):
            for _ in range(2):  # submit, then collect
                out = era5land.handler({"product": "era5l", "mode": "monthly"}, cds=cds, metrics=cloudwatch.LocalSink(), clock=lambda: 1_800_000_000.0, today=lambda: today)
        # 2024-03's request holds 29 February (its 1 March 00 UTC step) through 30 March.
        self.assertEqual(out["finalThrough"], "2024-03-30")
        mirror = zarrstore.Mirror.from_url(url)
        py = manifest.read(mirror, "era5l")
        first, days = dt.date(2024, 2, 29), 31
        stored = zarrstore.read_finals(Path(url[len("file://") :]), "era5l", first, days)
        sea = tuple(int(i) for i in np.argwhere(np.isnan(stored[0]))[0])
        cells = [(15, 84), (0, 0), (274, 309), (137, 155), sea]
        self.assertFalse(np.isnan(stored[:, 15, 84]).any())
        node = self.node_cells(url, "era5l", (dt.date(2024, 2, 28), dt.date(2024, 3, 31)), cells)
        self.assertEqual(node["manifest"]["files"], [{"url": "cds://reanalysis-era5-land/total_precipitation/2024-03", "valuesSha256": py["files"][0]["valuesSha256"]}])
        self.assertEqual((node["manifest"]["finalThrough"], node["manifest"]["prelimThrough"], node["manifest"]["years"]), ("2024-03-30", None, {"first": 2024, "last": 2024}))
        # Not the day before the request's first, nor the day its successor brings.
        self.check_cells(node, stored, cells, "-" + "f" * days + "-")
        self.assertNotIn("versions", node)

    def test_imerg_late_python_writes_node_validates_and_reads_its_cells_bit_for_bit(self):
        url = f"file://{self.dir / 'mirror'}"
        today = dt.date(2024, 10, 12)
        v08 = today - dt.timedelta(days=2)
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": url, "FEED_SOURCE": "fixtures"}):
            lambda_handler.handler({"product": "imerg_late", "mode": "recent"}, opener=imerg_fixture.FakeEarthdata(latest=today - dt.timedelta(days=1), v08_from=v08), metrics=cloudwatch.LocalSink(), today=lambda: today)
        mirror = zarrstore.Mirror.from_url(url)
        py = manifest.read(mirror, "imerg_late")
        first, last = imerg.granule_day(py["files"][0]["url"])[0], dt.date.fromisoformat(py["prelimThrough"])
        self.assertEqual((first, last), (today - dt.timedelta(days=imerg.RECENT_DAYS), today - dt.timedelta(days=1)))
        days = (last - first).days + 1
        root = Path(url[len("file://") :])
        stored = np.stack([zarrstore.read_daily_day(root, "imerg_late", first + dt.timedelta(days=i)) for i in range(days)])
        cells = [(15, 84), (0, 0), (274, 309), (137, 155)]
        node = self.node_cells(url, "imerg_late", (first - dt.timedelta(days=1), last + dt.timedelta(days=1)), cells)
        # The manifest Node validated is the one Python wrote, version and all.
        self.assertEqual(node["manifest"]["files"], [{"url": f["url"], "valuesSha256": f["valuesSha256"], "version": f["version"]} for f in py["files"]])
        self.assertEqual((node["manifest"]["finalThrough"], node["manifest"]["prelimThrough"]), (None, last.isoformat()))
        self.check_cells(node, stored, cells, "-" + "f" * days + "-")
        self.assertEqual(node["versions"], [None] + ["V08" if first + dt.timedelta(days=i) >= v08 else "V07" for i in range(days)] + [None])

    def test_imerg_late_a_missing_day_is_not_held_and_blocks_no_later_day_in_python_or_node(self):
        url = f"file://{self.dir / 'mirror'}"
        today = dt.date(2024, 10, 12)
        gap = today - dt.timedelta(days=5)
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": url, "FEED_SOURCE": "fixtures"}):
            lambda_handler.handler({"product": "imerg_late", "mode": "recent"}, opener=imerg_fixture.FakeEarthdata(latest=today - dt.timedelta(days=1), missing={gap}), metrics=cloudwatch.LocalSink(), today=lambda: today)
        py = manifest.read(zarrstore.Mirror.from_url(url), "imerg_late")
        first, last = today - dt.timedelta(days=imerg.RECENT_DAYS), today - dt.timedelta(days=1)
        self.assertEqual(py["prelimThrough"], last.isoformat())
        window = [first + dt.timedelta(days=i) for i in range((last - first).days + 1)]
        held = [d for d in window if d != gap]
        root = Path(url[len("file://") :])
        stored = np.stack([zarrstore.read_daily_day(root, "imerg_late", d) for d in held])
        cells = [(15, 84), (137, 155)]
        node = self.node_cells(url, "imerg_late", (first, last), cells)
        self.assertEqual(node["manifest"]["prelimThrough"], last.isoformat())
        self.check_cells(node, stored, cells, "".join("-" if d == gap else "f" for d in window))

    def node_blocks(self, mirror_url: str, product: str, files: list[tuple[str, dt.date, np.ndarray]]) -> dict:
        entries = []
        for n, (file_url, start, values) in enumerate(files):
            path = self.dir / f"{product}-{n}.f32"
            path.write_bytes(np.ascontiguousarray(values, dtype="<f4").tobytes(order="C"))
            entries.append({"url": file_url, "start": start.isoformat(), "days": int(values.shape[0]), "values": str(path)})
        spec = self.dir / f"blocks-{product}.json"
        spec.write_text(json.dumps({"mode": "blocks", "product": product, "files": entries}))
        p = subprocess.run([str(TSX), str(SCRIPT), mirror_url, str(spec)], cwd=ROOT / "backend", capture_output=True, text=True, timeout=300)
        self.assertIn(p.returncode, (0, 1), p.stderr)
        out = json.loads(p.stdout)
        for f in out["files"]:
            self.assertEqual(f["mismatches"], 0, f"{f['url']}: Node read {f['mismatches']} values that differ from Python's, the first at flat index {f['firstMismatch']}")
        self.assertEqual(p.returncode, 0, p.stderr)
        return out

    def check_blocks(self, out: dict, py: dict) -> None:
        self.assertEqual(out["manifest"]["files"], [{"url": f["url"], "valuesSha256": f["valuesSha256"]} for f in py["files"]])
        self.assertEqual((out["manifest"]["revision"], out["manifest"]["finalThrough"], out["manifest"]["prelimThrough"], out["manifest"]["years"]), (py["revision"], py["finalThrough"], py["prelimThrough"], py["years"]))
        by_url = {f["url"]: f["valuesSha256"] for f in py["files"]}
        for f in out["files"]:
            self.assertEqual(f["nodeSha256"], by_url[f["url"]], f["url"])

    def test_agera5_et0_python_writes_node_validates_and_reads_it_bit_for_bit(self):
        url = f"file://{self.dir / 'mirror'}"
        today = dt.date(2024, 4, 20)  # 2024-03 is the newest complete month
        cds = fakecds.FakeAgera5Cds(today=today)
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": url, "FEED_SOURCE": "fixtures"}):
            for _ in range(2):  # submit, then collect
                out = agera5.handler({"product": "agera5_et0", "mode": "monthly"}, cds=cds, metrics=cloudwatch.LocalSink(), clock=lambda: 1_800_000_000.0, today=lambda: today)
        self.assertEqual(out["finalThrough"], "2024-03-31")
        py = manifest.read(zarrstore.Mirror.from_url(url), "agera5_et0")
        first = dt.date(2024, 3, 1)
        stored = zarrstore.read_finals(Path(url[len("file://") :]), "agera5_et0", first, 31)
        self.assertTrue(np.isnan(stored).any() and not np.isnan(stored).all(), "sea and land both cross")
        self.check_blocks(self.node_blocks(url, "agera5_et0", [(agera5.file_url((2024, 3)), first, stored)]), py)

    def test_power_et0_python_writes_node_validates_and_reads_it_bit_for_bit(self):
        url = f"file://{self.dir / 'mirror'}"
        today = dt.date(2024, 3, 20)
        newest = today - dt.timedelta(days=nasapower.LAG_DAYS)
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": url, "FEED_SOURCE": "fixtures"}):
            lambda_handler.handler({"product": "power_et0", "mode": "recent", "days": 3}, opener=power_fixture.FakePower(latest=newest), metrics=cloudwatch.LocalSink(), today=lambda: today)
        py = manifest.read(zarrstore.Mirror.from_url(url), "power_et0")
        self.assertEqual(py["prelimThrough"], newest.isoformat())
        root = Path(url[len("file://") :])
        days = [newest - dt.timedelta(days=k) for k in (2, 1, 0)]
        files = [(nasapower.day_url(d), d, zarrstore.read_daily_day(root, "power_et0", d)[None]) for d in days]
        self.check_blocks(self.node_blocks(url, "power_et0", files), py)

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
