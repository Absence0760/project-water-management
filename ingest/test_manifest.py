"""manifest.py: the spec round-trips, bad manifests are refused, and valuesSha256 is stable.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import manifest  # noqa: E402


def full():
    m = manifest.new("rnl")
    m.update(revision=2, years={"first": 1981, "last": 2026}, finalThrough="2024-06-30", prelimThrough="2026-10-26")
    m["files"] = [
        {
            "url": "https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/chirps-v3.0.2024.06.days_p05.nc",
            "etag": '"6a1735cb-15a0b441"',
            "lastModified": "Wed, 27 May 2026 18:19:55 GMT",
            "size": 362853441,
            "valuesSha256": "0" * 64,
            "revision": 2,
            "fetchedAt": "2026-10-27T09:00:00Z",
        }
    ]
    m["changes"] = [{"revision": 2, "days": ["2024-06-01", "2024-06-30"], "cellsChanged": 12, "maxAbsDiff": 0.5}]
    return m


class RoundTrip(unittest.TestCase):
    def test_round_trip_is_exact(self):
        m = full()
        text = manifest.dumps(m)
        self.assertEqual(manifest.loads(text), m)
        self.assertEqual(manifest.dumps(manifest.loads(text)), text)

    def test_keys_in_spec_order(self):
        m = full()
        shuffled = dict(reversed(list(m.items())))
        doc = json.loads(manifest.dumps(shuffled))
        self.assertEqual(list(doc), ["product", "revision", "region", "grid", "years", "finalThrough", "prelimThrough", "files", "changes"])
        self.assertEqual(list(doc["files"][0]), ["url", "etag", "lastModified", "size", "valuesSha256", "revision", "fetchedAt"])
        self.assertEqual(list(doc["changes"][0]), ["revision", "days", "cellsChanged", "maxAbsDiff"])

    def test_new_manifest_is_valid(self):
        m = manifest.new("sat")
        manifest.validate(m)
        self.assertEqual(m["revision"], 1)
        self.assertEqual(m["grid"], {"origin": {"lat": -35.475, "lon": 10.025}, "step": 0.05})
        self.assertEqual(m["region"], {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0})

    def test_a_file_without_a_size_is_valid_as_in_node(self):
        m = full()
        m["files"][0]["size"] = None
        manifest.validate(m)  # backend/src/mirror/manifest.ts: size is nullable
        m["files"][0]["size"] = -1
        with self.assertRaisesRegex(ValueError, "size"):
            manifest.validate(m)

    def test_upsert_replaces_by_url(self):
        m = full()
        e = dict(m["files"][0], size=1)
        manifest.upsert_file(m, e)
        self.assertEqual(len(m["files"]), 1)
        self.assertEqual(manifest.file_entry(m, e["url"])["size"], 1)


def month_url(y, mo, product="rnl"):
    return f"https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/{product}/netcdf/byMonth/chirps-v3.0.{y:04d}.{mo:02d}.days_p05.nc"


def with_months(months, final_through):
    m = full()
    m["files"] = [dict(m["files"][0], url=month_url(y, mo)) for y, mo in months]
    m["finalThrough"] = final_through
    return m


class Coverage(unittest.TestCase):
    def test_contiguous_months_from_the_first(self):
        self.assertIsNone(manifest.finals_coverage([]))
        files = lambda months: [{"url": month_url(y, mo)} for y, mo in months]  # noqa: E731
        self.assertEqual(manifest.finals_coverage(files([(2024, 2)])), ("2024-02-01", "2024-02-29"))
        self.assertEqual(manifest.finals_coverage(files([(2023, 11), (2023, 12), (2024, 1)])), ("2023-11-01", "2024-01-31"))
        # A gap: the run stops before it, however new the later month.
        self.assertEqual(manifest.finals_coverage(files([(2000, 1), (2000, 2), (2026, 9)])), ("2000-01-01", "2000-02-29"))
        self.assertEqual(manifest.file_month("fixture:chc/chirps-v3.0.2024.02.days_p05.nc"), (2024, 2))
        self.assertIsNone(manifest.file_month("https://example.org/chirps-v3.0.prelim.2026.01.01.tif"))

    def test_finalThrough_must_not_run_past_the_contiguous_months(self):
        # Positive controls: at the run's end, and before it.
        manifest.validate(with_months([(2000, 1), (2000, 2), (2026, 9)], "2000-02-29"))
        manifest.validate(with_months([(2024, 6)], "2024-06-15"))
        manifest.validate(with_months([], None))
        for months, through in [
            ([(2000, 1), (2000, 2), (2026, 9)], "2000-03-01"),  # into the gap
            ([(2000, 1), (2000, 2), (2026, 9)], "2026-09-30"),  # the newest month's end, past the gap
            ([], "2024-06-30"),  # no files at all
        ]:
            with self.assertRaisesRegex(ValueError, "runs past", msg=f"{months} {through}"):
                manifest.validate(with_months(months, through))

    def test_finals_files_must_name_their_month(self):
        m = with_months([(2024, 6)], "2024-06-30")
        m["files"][0]["url"] = "https://example.org/somefile.nc"
        with self.assertRaisesRegex(ValueError, "names no month"):
            manifest.validate(m)
        # A daily product's files are not byMonth files.
        m["product"], m["finalThrough"] = "prelim", None
        manifest.validate(m)


class Refusals(unittest.TestCase):
    def bad(self, mutate):
        m = copy.deepcopy(full())
        mutate(m)
        with self.assertRaises(ValueError):
            manifest.validate(m)

    def test_refuses_off_spec_manifests(self):
        self.bad(lambda m: m.pop("prelimThrough"))
        self.bad(lambda m: m.update(extra=1))
        self.bad(lambda m: m.update(revision=0))
        self.bad(lambda m: m.update(revision=True))
        self.bad(lambda m: m.update(finalThrough="2026-9-30"))
        self.bad(lambda m: m.update(finalThrough="2026-02-30"))
        self.bad(lambda m: m["files"][0].update(valuesSha256="ABC"))
        self.bad(lambda m: m["files"][0].update(fetchedAt="2026-10-27T09:00:00+02:00"))
        self.bad(lambda m: m["files"][0].pop("etag"))
        self.bad(lambda m: m["changes"][0].update(days=["2024-06-01"]))
        self.bad(lambda m: m["changes"][0].update(maxAbsDiff=-1))
        self.bad(lambda m: m["grid"].update(step="0.05"))

    def test_nan_never_reaches_json(self):
        m = full()
        m["changes"][0]["maxAbsDiff"] = float("nan")
        with self.assertRaises(ValueError):
            manifest.dumps(m)


class ValuesHash(unittest.TestCase):
    def test_known_bytes(self):
        a = np.array([[[1.0, np.nan]]], dtype=np.float32)
        expected = hashlib.sha256(np.array([0x3F800000, 0x7FC00000], dtype="<u4").tobytes()).hexdigest()
        self.assertEqual(manifest.values_sha256(a), expected)

    def test_every_nan_hashes_the_same(self):
        a = np.array([[[0.0, 1.5, np.nan]]], dtype=np.float32)
        b = a.copy()
        b.view(np.uint32)[0, 0, 2] = 0xFFC00001  # a negative NaN with a payload
        c = a.copy()
        c.view(np.uint32)[0, 0, 2] = 0x7F800001  # a signalling NaN
        self.assertTrue(np.isnan(b[0, 0, 2]) and np.isnan(c[0, 0, 2]))
        self.assertEqual(manifest.values_sha256(a), manifest.values_sha256(b))
        self.assertEqual(manifest.values_sha256(a), manifest.values_sha256(c))

    def test_layout_and_byte_order_do_not_matter_but_values_do(self):
        a = np.arange(24, dtype=np.float32).reshape(2, 3, 4)
        self.assertEqual(manifest.values_sha256(a), manifest.values_sha256(np.asfortranarray(a)))
        self.assertEqual(manifest.values_sha256(a), manifest.values_sha256(a.astype(">f4")))
        b = a.copy()
        b[1, 2, 3] = np.nextafter(b[1, 2, 3], np.float32(100))
        self.assertNotEqual(manifest.values_sha256(a), manifest.values_sha256(b))
        # -0.0 and 0.0 are different bits, and so different values to the copy.
        self.assertNotEqual(manifest.values_sha256(np.zeros((1, 1, 1), np.float32)), manifest.values_sha256(-np.zeros((1, 1, 1), np.float32)))

    def test_does_not_mutate_its_input(self):
        a = np.array([[[np.nan]]], dtype=np.float32)
        a.view(np.uint32)[0, 0, 0] = 0xFFC00001
        manifest.values_sha256(a)
        self.assertEqual(int(a.view(np.uint32)[0, 0, 0]), 0xFFC00001)


if __name__ == "__main__":
    unittest.main()
