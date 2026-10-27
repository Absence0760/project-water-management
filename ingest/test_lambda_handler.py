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
import grid  # noqa: E402
import lambda_handler  # noqa: E402
import make_chc_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402

FIXTURE = HERE / "fixtures" / "chc" / fx.NAME


def month_slice(first_day: dt.date, days: int = 3, bump: float = 0.0) -> chcnetcdf.RegionSlice:
    """The fixture's values moved to other days (the last `days` of a month)."""
    v = fx.region_values()[:days].copy()
    v[~np.isnan(v)] += np.float32(bump)
    return chcnetcdf.RegionSlice(first_day=first_day, values=v)


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

    def test_refuses_an_implausible_value_before_anything_is_written(self):
        import h5netcdf

        land = (fx.MARGIN + 50, fx.MARGIN + 350)  # a land cell of the region
        for bad in (2000.5, -0.5, np.inf):
            with tempfile.TemporaryDirectory() as tmp:
                path = fx.write(Path(tmp))
                with h5netcdf.File(path, "a") as f:
                    f["precip"][1, land[0], land[1]] = np.float32(bad)
                with self.assertRaisesRegex(chcnetcdf.ImplausibleValueError, r"1 implausible value.*2024-02-28.*region row 50, col 350", msg=bad):
                    chcnetcdf.read_region(str(path))
                # The handler's run fails with it, and no copy or manifest exists.
                root = Path(tmp) / "mirror"
                with self.assertRaises(chcnetcdf.ImplausibleValueError):
                    lambda_handler.ingest_file(zarrstore.Mirror.from_url(f"file://{root}"), "rnl", f"fixture:chc/{fx.NAME}", path)
                self.assertFalse(root.exists())
        # Positive control: the bounds themselves are plausible, and NaN (sea) is skipped.
        edge = np.full((2, grid.ROWS, grid.COLS), np.nan, dtype=np.float32)
        edge[0, 0, 0], edge[1, 0, 0] = 0.0, 2000.0
        chcnetcdf.check_plausible(edge, fx.FIRST_DAY)

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

    def test_finalThrough_stops_at_a_gap_in_the_months(self):
        mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        url = lambda y, mo: f"fixture:chc/chirps-v3.0.{y:04d}.{mo:02d}.days_p05.nc"  # noqa: E731
        slices = {
            url(2024, 2): month_slice(dt.date(2024, 2, 27)),
            url(2024, 3): month_slice(dt.date(2024, 3, 29), bump=1.0),
            url(2024, 5): month_slice(dt.date(2024, 5, 29), bump=2.0),
        }

        def ingest(u):
            with unittest.mock.patch.object(chcnetcdf, "read_region", lambda _path: slices[u]):
                return lambda_handler.ingest_file(mirror, "rnl", u, FIXTURE)

        ingest(url(2024, 2))
        self.assertEqual(manifest.read(mirror, "rnl")["finalThrough"], "2024-02-29")
        # May arrives before March and April: the run still ends in February.
        ingest(url(2024, 5))
        m = manifest.read(mirror, "rnl")
        self.assertEqual(m["finalThrough"], "2024-02-29")
        self.assertEqual(m["years"], {"first": 2024, "last": 2024})
        # March closes part of the gap: the run reaches March, not May.
        ingest(url(2024, 3))
        self.assertEqual(manifest.read(mirror, "rnl")["finalThrough"], "2024-03-31")

    def test_a_file_whose_days_are_not_its_months_end_is_refused(self):
        mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        for u, sl in [
            ("fixture:chc/chirps-v3.0.2024.03.days_p05.nc", month_slice(dt.date(2024, 2, 27))),  # another month
            ("fixture:chc/chirps-v3.0.2024.02.days_p05.nc", month_slice(dt.date(2024, 2, 20))),  # stops short of the end
            ("fixture:chc/no-month.nc", month_slice(dt.date(2024, 2, 27))),
        ]:
            with unittest.mock.patch.object(chcnetcdf, "read_region", lambda _path, sl=sl: sl):
                with self.assertRaises(ValueError, msg=u):
                    lambda_handler.ingest_file(mirror, "rnl", u, FIXTURE)
        self.assertIsNone(manifest.read(mirror, "rnl"))

    def test_a_retry_after_a_crash_between_upload_and_manifest_claims_every_cell(self):
        s3 = FakeS3()
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            lambda_handler.handler({"product": "rnl", "mode": "backfill"}, None, s3_client=s3)
            real = chcnetcdf.read_region

            def rewritten(path):
                r = real(path)
                r.values[1, 100, 350] += 1.5
                return r

            # The run dies after the chunks went up but before the manifest did.
            with unittest.mock.patch.object(chcnetcdf, "read_region", rewritten):
                with unittest.mock.patch.object(manifest, "write", side_effect=RuntimeError("Lambda timed out")):
                    with self.assertRaises(RuntimeError):
                        lambda_handler.handler({"product": "rnl", "mode": "backfill"}, None, s3_client=s3)
                mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
                m = manifest.read(mirror, "rnl")
                self.assertEqual(m["revision"], 1)  # the manifest still names the old values
                with mirror.stage(zarrstore.finals_year_prefixes("rnl", fx.FIRST_DAY, fx.DAYS)) as root:
                    held = zarrstore.read_finals(root, "rnl", fx.FIRST_DAY, fx.DAYS)
                self.assertEqual(held[1, 100, 350], np.float32(fx.value(1, 100, 350) + 1.5))  # ...but the new chunks are up

                out = lambda_handler.handler({"product": "rnl", "mode": "backfill"}, None, s3_client=s3)
        self.assertEqual(out["files"][0]["outcome"], "changed")
        m = manifest.read(mirror, "rnl")
        self.assertEqual(m["revision"], 2)
        # The old values are unknown, so the entry claims the whole region and the widest plausible difference, never 0.
        self.assertEqual(m["changes"], [{"revision": 2, "days": ["2024-02-27", "2024-02-29"], "cellsChanged": 550 * 620, "maxAbsDiff": 2000.0}])

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
