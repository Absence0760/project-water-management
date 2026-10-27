"""lambda_handler.py: the event shape, and the fixtures-mode run end to end into a temp copy.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import datetime as dt
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures"))

import chcnetcdf  # noqa: E402
import lambda_handler  # noqa: E402
import make_chc_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402

FIXTURE = HERE / "fixtures" / "chc" / fx.NAME


class Event(unittest.TestCase):
    def test_valid_events(self):
        self.assertEqual(lambda_handler.validate_event({"product": "rnl", "mode": "monthly"}), {"product": "rnl", "mode": "monthly", "month": None})
        self.assertEqual(lambda_handler.validate_event({"product": "sat", "mode": "backfill", "month": "2000-06"})["month"], "2000-06")

    def test_invalid_events(self):
        for ev in [
            None,
            [],
            {"product": "rnl"},
            {"mode": "monthly"},
            {"product": "prelim", "mode": "monthly"},
            {"product": "rnl", "mode": "daily"},
            {"product": "rnl", "mode": "monthly", "month": "2024-13"},
            {"product": "rnl", "mode": "monthly", "month": "2024-6"},
            {"product": "rnl", "mode": "monthly", "month": 202406},
            {"product": "rnl", "mode": "monthly", "extra": 1},
        ]:
            with self.assertRaises(lambda_handler.BadEvent, msg=repr(ev)):
                lambda_handler.validate_event(ev)


class Fixture(unittest.TestCase):
    def test_fixture_reads_as_chc_layout_into_the_region(self):
        region = chcnetcdf.read_region(str(FIXTURE))
        self.assertEqual(region.first_day, fx.FIRST_DAY)
        self.assertEqual(region.values.dtype, np.float32)
        np.testing.assert_array_equal(region.values, fx.region_values())
        self.assertEqual(region.values[0, 0, 0], np.float32(fx.value(0, 0, 0)))
        self.assertEqual(region.values[2, 100, 350], np.float32(fx.value(2, 100, 350)))
        self.assertTrue(np.isnan(region.values[1, 549, 619]))  # sea: -9999 became NaN

    def test_committed_fixture_matches_its_generator(self):
        with tempfile.TemporaryDirectory() as tmp:
            fresh = fx.write(Path(tmp))
            a, b = chcnetcdf.read_region(str(fresh)), chcnetcdf.read_region(str(FIXTURE))
        self.assertEqual(a.first_day, b.first_day)
        np.testing.assert_array_equal(a.values, b.values)

    def test_refuses_off_layout_time_units(self):
        self.assertEqual(chcnetcdf.time_origin("days since 1980-1-1"), dt.date(1980, 1, 1))
        self.assertEqual(chcnetcdf.time_origin("days since 1980-01-01 00:00:00"), dt.date(1980, 1, 1))
        with self.assertRaises(ValueError):
            chcnetcdf.time_origin("hours since 1980-1-1")


class FixturesRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        env = {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "fixtures"}
        self.env = unittest.mock.patch.dict(os.environ, env)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_writes_the_copy_and_its_manifest(self):
        out = lambda_handler.handler({"product": "rnl", "mode": "backfill"}, None)
        self.assertEqual(out["revision"], 1)
        self.assertEqual(out["finalThrough"], "2024-02-29")
        self.assertEqual([f["outcome"] for f in out["files"]], ["added"])

        import zarr

        a = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="rnl", mode="r")
        # 29 Feb 2024 (fixture day 2) at doy index 59 of year index 43, south-west corner.
        self.assertEqual(a[43, 59, 0, 0], np.float32(fx.value(2, 0, 0)))
        self.assertEqual(a[43, 57, 100, 350], np.float32(fx.value(0, 100, 350)))
        self.assertTrue(np.isnan(a[43, 60, 0, 0]))

        m = manifest.loads((self.root / "rnl" / "manifest.json").read_text())
        self.assertEqual(m["years"], {"first": 2024, "last": 2024})
        self.assertEqual(m["files"][0]["url"], f"fixture:chc/{fx.NAME}")
        self.assertEqual(m["files"][0]["valuesSha256"], manifest.values_sha256(fx.region_values()))
        self.assertEqual(m["changes"], [])

    def test_a_rerun_with_the_same_values_keeps_the_revision(self):
        lambda_handler.handler({"product": "sat", "mode": "monthly", "month": "2024-02"})
        before = sorted(p.stat().st_mtime_ns for p in (self.root / "sat" / "c").rglob("*") if p.is_file())
        out = lambda_handler.handler({"product": "sat", "mode": "monthly"})
        self.assertEqual(out["files"][0]["outcome"], "unchanged")
        self.assertEqual(out["revision"], 1)
        after = sorted(p.stat().st_mtime_ns for p in (self.root / "sat" / "c").rglob("*") if p.is_file())
        self.assertEqual(before, after)  # no chunk rewritten

    def test_changed_values_bump_the_revision_with_a_change(self):
        lambda_handler.handler({"product": "rnl", "mode": "backfill"})
        real = chcnetcdf.read_region

        def rewritten(path):
            r = real(path)
            r.values[1, 100, 350] += 1.5
            r.values[2, 0, 0] = np.nan
            return r

        with unittest.mock.patch.object(chcnetcdf, "read_region", rewritten):
            out = lambda_handler.handler({"product": "rnl", "mode": "backfill"})
        self.assertEqual(out["files"][0]["outcome"], "changed")
        m = manifest.loads((self.root / "rnl" / "manifest.json").read_text())
        self.assertEqual(m["revision"], 2)
        self.assertEqual(m["files"][0]["revision"], 2)
        self.assertEqual(m["changes"], [{"revision": 2, "days": ["2024-02-27", "2024-02-29"], "cellsChanged": 2, "maxAbsDiff": 1.5}])

    def test_the_same_run_through_s3(self):
        s3 = FakeS3()
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            out = lambda_handler.handler({"product": "rnl", "mode": "monthly", "month": "2024-02"}, None, s3_client=s3)
        self.assertEqual(out["revision"], 1)
        keys = s3.keys("mirror")
        self.assertIn("rnl/manifest.json", keys)
        self.assertIn("rnl/zarr.json", keys)
        self.assertIn("rnl/c/43/0/0/0", keys)
        self.assertTrue(all(k == "zarr.json" or k.startswith("rnl/") for k in keys))

    def test_live_and_unknown_sources_refuse(self):
        with unittest.mock.patch.dict(os.environ, {"FEED_SOURCE": "live"}):
            with self.assertRaises(NotImplementedError):
                lambda_handler.handler({"product": "rnl", "mode": "monthly"})
        with unittest.mock.patch.dict(os.environ, {"FEED_SOURCE": "nope"}):
            with self.assertRaises(RuntimeError):
                lambda_handler.handler({"product": "rnl", "mode": "monthly"})
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": ""}):
            with self.assertRaises(RuntimeError):
                lambda_handler.handler({"product": "rnl", "mode": "monthly"})

    def test_a_month_with_no_fixture_is_refused(self):
        with self.assertRaises(lambda_handler.BadEvent):
            lambda_handler.handler({"product": "rnl", "mode": "monthly", "month": "1999-01"})


class Diff(unittest.TestCase):
    def test_diff_counts_cells_not_cell_days(self):
        old = np.array([[[1.0, np.nan, 2.0]], [[1.0, np.nan, 2.0]]], dtype=np.float32)
        new = old.copy()
        new[:, 0, 0] = 3.0  # one cell, two days
        new[0, 0, 1] = 0.5  # NaN to a value: changed, not in maxAbsDiff
        self.assertEqual(lambda_handler._diff(old, new), (2, 2.0))
        self.assertEqual(lambda_handler._diff(old, old.copy()), (0, 0.0))


if __name__ == "__main__":
    unittest.main()
