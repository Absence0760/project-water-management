"""agera5.py: AgERA5's daily reference ET into `agera5_et0`. The download's
forms (a zip of daily files, one NetCDF) and lattices (x.x5 cells taken as
they are, x.x0 points remapped), the month's own days, the 0–30 mm check;
submit on one run and collect on a later one through cdsjob.py, a revision
only when the values change, a 401/403 that stops the run, the backfill's
bounds, the manifest's URL rule, and MirrorLagDays{Product=agera5_et0} on
every exit.

No network and no key: the CDS is fakecds.FakeAgera5Cds, which writes
fixtures/agera5/make_agera5_fixture.py's synthetic zip.

    ingest/.venv/bin/python -m unittest test_agera5   (from ingest/)
"""

import datetime as dt
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures" / "agera5"))

import agera5 as ag  # noqa: E402
import cloudwatch  # noqa: E402
import fakecds  # noqa: E402
import lambda_handler  # noqa: E402
import make_agera5_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402

T0 = 1_800_000_000.0
MARCH = (2024, 3)
TODAY = dt.date(2024, 4, 20)  # 2024-03 is the newest complete month (31 Mar + 10 days <= 20 Apr)


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def by_day(day, i, j):
    """(day of month) / 4 mm everywhere."""
    return np.full(i.shape, day.day / 4.0)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mirror = zarrstore.LocalMirror(self.root)
        self.clock = Clock()
        self.metrics = cloudwatch.LocalSink()
        self.env = unittest.mock.patch.dict(os.environ, {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "fixtures"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.tmp.cleanup)

    def call(self, cds, today=TODAY, mode="monthly", month=None):
        ev = {"product": "agera5_et0", "mode": mode, **({"month": month} if month else {})}
        return ag.handler(ev, cds=cds, metrics=self.metrics, clock=self.clock, today=lambda: today)

    def manifest(self):
        return manifest.read(self.mirror, "agera5_et0")


class ReadMonth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "m.zip"

    def test_a_zip_of_daily_files_is_the_months_days_cell_for_cell(self):
        fx.write_month(self.path, *MARCH, values=by_day)
        mv = ag.read_month(str(self.path), MARCH)
        self.assertEqual((mv.first_day, mv.last_day), (dt.date(2024, 3, 1), dt.date(2024, 3, 31)))
        self.assertEqual(mv.values.shape, (31, ag.GRID.rows, ag.GRID.cols))
        self.assertEqual(mv.values.dtype, np.float32)
        self.assertIsNone(mv.preliminary)
        land = ~np.isnan(mv.values[0])
        np.testing.assert_allclose(mv.values[9][land], 2.5, rtol=1e-6)  # 10 March: 10 / 4
        # Placed by coordinates: south-up cell (r, c) holds the fixture's (r, c) though the file is north first.
        mv2 = ag.read_month(str(fx.write_month(Path(self.tmp.name) / "v.zip", *MARCH, values=lambda d, i, j: i / 100.0 + j / 1e4)), MARCH)
        self.assertAlmostEqual(float(mv2.values[0, 200, 150]), 2.0 + 0.015, places=4)
        self.assertTrue(np.isnan(mv2.values[0, 0, 0]), "sea is NaN")

    def test_one_netcdf_and_corner_points_read_too(self):
        fx.write_month(self.path, *MARCH, values=by_day, single=True)
        np.testing.assert_allclose(np.nanmax(ag.read_month(str(self.path), MARCH).values[0]), 0.25, rtol=1e-6)
        corners = Path(self.tmp.name) / "c.nc"
        fx.write_month(corners, *MARCH, values=lambda d, i, j: i / 100.0 + j / 1e4, single=True, lattice="corners")
        mv = ag.read_month(str(corners), MARCH)
        self.assertAlmostEqual(float(mv.values[2, 100, 200]), 100.5 / 100 + 200.5 / 1e4, places=4)  # the mean of its four corners

    def test_a_missing_day_another_unit_or_two_variables_is_refused(self):
        fx.write_month(self.path, *MARCH, days=[dt.date(2024, 3, d) for d in range(1, 31)])
        with self.assertRaisesRegex(ag.AgEra5FormatError, "not every day of 2024-03"):
            ag.read_month(str(self.path), MARCH)
        fx.write_month(self.path, *MARCH, units="W m-2")
        with self.assertRaisesRegex(ag.AgEra5FormatError, "expected mm/day"):
            ag.read_month(str(self.path), MARCH)

    def test_more_than_30_mm_or_a_negative_fails_and_packing_noise_is_zero(self):
        fx.write_month(self.path, *MARCH, values=lambda d, i, j: np.where((i == 100) & (j == 100) & (d.day == 3), 31.0, 2.0))
        with self.assertRaises(ag.ImplausibleValueError):
            ag.read_month(str(self.path), MARCH)
        fx.write_month(self.path, *MARCH, values=lambda d, i, j: np.where((i == 100) & (j == 100), -0.0005, 2.0))
        self.assertEqual(float(ag.read_month(str(self.path), MARCH).values[0, 100, 100]), 0.0)
        fx.write_month(self.path, *MARCH, values=lambda d, i, j: np.where((i == 100) & (j == 100), -0.5, 2.0))
        with self.assertRaises(ag.ImplausibleValueError):
            ag.read_month(str(self.path), MARCH)


class Requests(unittest.TestCase):
    def test_the_request_asks_for_the_months_days_over_d1_and_is_recognised(self):
        req = ag.month_request((2024, 2))
        self.assertEqual(req["day"], [f"{d:02d}" for d in range(1, 30)])
        self.assertEqual((req["variable"], req["version"], req["area"]), ("reference_evapotranspiration", "2_0", [-8.0, 10.0, -35.5, 41.0]))
        self.assertEqual(ag.request_month(req), (2024, 2))
        self.assertIsNone(ag.request_month({**req, "variable": "2m_temperature"}))
        self.assertIsNone(ag.request_month({**req, "version": "1_1"}))
        self.assertEqual(ag.file_url((2024, 2)), "cds://sis-agrometeorological-indicators/reference_evapotranspiration/2024-02")
        self.assertEqual(ag.url_month(ag.file_url((2024, 2))), (2024, 2))

    def test_newest_complete_month_and_events(self):
        self.assertEqual(ag.newest_complete_month(dt.date(2024, 4, 10)), (2024, 3))
        self.assertEqual(ag.newest_complete_month(dt.date(2024, 4, 9)), (2024, 2))
        for ev in ({"product": "agera5_et0", "mode": "backfill", "month": "1978-12"}, {"product": "agera5_et0", "mode": "backfill", "month": "2024-04"}, {"product": "agera5_et0", "mode": "monthly", "month": "2024-01"}, {"product": "agera5_et0", "mode": "recent"}, {"product": "agera5_et0", "mode": "monthly", "x": 1}):
            with self.subTest(ev=ev), self.assertRaises(ag.BadEvent):
                ag.validate_event(ev, TODAY)
        self.assertEqual(ag.validate_event({"product": "agera5_et0", "mode": "backfill", "month": "1979-01"}, TODAY)["month"], "1979-01")


class SubmitThenCollect(Base):
    def test_one_run_submits_a_later_one_collects_into_the_finals(self):
        cds = fakecds.FakeAgera5Cds(today=TODAY, values=by_day)
        out = self.call(cds)
        self.assertEqual([s["month"] for s in out["submitted"]], ["2024-03"])
        self.assertIsNone(self.manifest())
        out = self.call(cds)
        self.assertEqual([c["outcome"] for c in out["collected"]], ["added"])
        m = self.manifest()
        self.assertEqual((m["finalThrough"], m["prelimThrough"], m["revision"]), ("2024-03-31", None, 1))
        self.assertEqual([f["url"] for f in m["files"]], [ag.file_url(MARCH)])
        self.assertEqual((m["files"][0]["etag"], m["files"][0]["lastModified"]), (None, None))
        self.assertEqual(m["grid"]["step"], 0.1)
        # Placement in the finals array: the year index from 1979, the day of year, the cell.
        import zarr

        arr = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="agera5_et0", mode="r", zarr_format=3)
        self.assertEqual(arr.attrs["firstYear"], 1979)
        self.assertEqual(arr.attrs["attribution"], ag.ATTRIBUTION)
        self.assertAlmostEqual(float(arr[2024 - 1979, 31 + 29 + 9, 150, 200]), 2.5, places=5)  # 10 March 2024
        self.assertEqual(json.loads((self.root / ag.state_key()).read_text())["months"]["2024-03"]["requestId"], None)

    def test_a_backfill_month_from_1979_is_submitted_then_collected(self):
        cds = fakecds.FakeAgera5Cds(today=TODAY)
        self.call(cds, mode="backfill", month="1979-01")
        out = self.call(cds, mode="backfill", month="1979-01")
        self.assertEqual([c["month"] for c in out["collected"]], ["1979-01"])
        self.assertEqual(self.manifest()["finalThrough"], "1979-01-31")

    def test_lambda_handler_hands_agera5_et0_to_agera5_in_fixtures_mode(self):
        out = lambda_handler.handler({"product": "agera5_et0", "mode": "monthly"}, metrics=self.metrics, clock=self.clock, today=lambda: TODAY)
        self.assertEqual((out["product"], out["source"]), ("agera5_et0", "fixtures"))
        out = lambda_handler.handler({"product": "agera5_et0", "mode": "monthly"}, metrics=self.metrics, clock=self.clock, today=lambda: TODAY)
        self.assertEqual(out["finalThrough"], "2024-03-31")


class Revisions(Base):
    def collect(self, cds, today):
        with unittest.mock.patch.object(ag, "newest_complete_month", return_value=MARCH):
            self.call(cds, today=today)
            return self.call(cds, today=today)

    def test_same_values_keep_the_revision_and_changed_values_bump_it(self):
        self.collect(fakecds.FakeAgera5Cds(today=TODAY), TODAY)
        e = json.loads((self.root / ag.state_key()).read_text())["months"]["2024-03"]
        self.assertEqual(e["recheckAt"], (dt.date(2024, 3, 31) + dt.timedelta(days=ag.RECHECK_AFTER_DAYS)).isoformat(), "unknown phase: checked again")
        later = dt.date(2024, 6, 15)
        out = self.collect(fakecds.FakeAgera5Cds(today=later), later)
        self.assertEqual([c["outcome"] for c in out["collected"]], ["unchanged"])
        self.assertEqual(self.manifest()["revision"], 1)
        later2 = dt.date(2024, 7, 20)
        out = self.collect(fakecds.FakeAgera5Cds(today=later2, variant="revised"), later2)
        self.assertEqual([c["outcome"] for c in out["collected"]], ["changed"])
        m = self.manifest()
        self.assertEqual(m["revision"], 2)
        self.assertEqual(m["changes"][-1]["days"], ["2024-03-01", "2024-03-31"])
        self.assertEqual(m["changes"][-1]["cellsChanged"], 1)
        self.assertAlmostEqual(m["changes"][-1]["maxAbsDiff"], fx.REVISED_DELTA_MM, places=4)

    def test_the_recheck_stops_at_the_cap(self):
        self.assertIsNone(ag.recheck_at(MARCH, None, dt.date(2024, 3, 31) + dt.timedelta(days=ag.RECHECK_UNKNOWN_CAP_DAYS)))


class Refusal(Base):
    def test_a_403_or_401_stops_the_run_and_the_rest_of_the_day(self):
        for status in (403, 401):
            with self.subTest(status=status):
                (self.root / ag.refused_key()).unlink(missing_ok=True)
                with self.assertRaises(polite.StopRun):
                    self.call(fakecds.FakeAgera5Cds(today=TODAY, refuse=status))
                ok = fakecds.FakeAgera5Cds(today=TODAY)
                with self.assertRaises(polite.StopRun):
                    self.call(ok)
                self.assertEqual(ok.calls, [], "no call to the CDS after a refusal the same day")
                self.assertEqual(self.metrics.published[-1][0], "agera5_et0")


class Metric(Base):
    def test_every_exit_publishes_the_lag(self):
        cds = fakecds.FakeAgera5Cds(today=TODAY)
        self.call(cds)
        self.assertEqual(self.metrics.published[-1], ("agera5_et0", (TODAY - dt.date(1978, 12, 31)).days))
        self.call(cds)
        self.assertEqual(self.metrics.published[-1], ("agera5_et0", (TODAY - dt.date(2024, 3, 31)).days))
        with unittest.mock.patch.object(ag, "ingest_month", side_effect=RuntimeError("boom")):
            cds2 = fakecds.FakeAgera5Cds(today=TODAY)
            with self.assertRaises(RuntimeError):
                self.call(cds2, mode="backfill", month="2020-01")
                self.call(cds2, mode="backfill", month="2020-01")
        self.assertEqual(len(self.metrics.published), 4)

    def test_the_key_message_names_agera5_and_its_runbook(self):
        with self.assertRaisesRegex(RuntimeError, "CDS_KEY_SECRET_ARN is not set: live agera5_et0"):
            ag.read_cds_key("")


class Manifest(unittest.TestCase):
    def entry(self, url, **kw):
        return {"url": url, "etag": None, "lastModified": None, "size": 1, "valuesSha256": "0" * 64, "revision": 1, "fetchedAt": "2024-04-20T00:00:00Z", **kw}

    def test_coverage_stops_at_a_gap_and_the_rules_hold(self):
        files = [self.entry(ag.file_url(ym)) for ym in [(2024, 1), (2024, 2), (2024, 4)]]
        self.assertEqual(manifest.agera5_coverage(files), ("2024-01-01", "2024-02-29"))
        m = manifest.new("agera5_et0")
        m.update(files=files, years={"first": 2024, "last": 2024}, finalThrough="2024-02-29")
        manifest.validate(m)
        for bad in (
            {"finalThrough": "2024-04-30"},
            {"prelimThrough": "2024-02-01"},
            {"files": [self.entry("cds://reanalysis-era5-land/total_precipitation/2024-01")]},
            {"files": [self.entry(ag.file_url((2024, 1)), etag='"x"')]},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                manifest.validate({**m, **bad})


if __name__ == "__main__":
    unittest.main()
