"""era5land.py: the day each 00 UTC step totals, m to mm, the 0.1 deg remap
and where a cell-day lands in the finals chunks; submit on one run and
collect on a later one (state lost included), one request per month, a
failed request's backoff, a revision only when the values change, a 401/403
that stops the run, the lease, and MirrorLagDays{Product=era5l} on every exit.

No network and no key: the CDS is fakecds.FakeCds, which writes the
synthetic NetCDF of fixtures/era5land/make_era5land_fixture.py.

    ingest/.venv/bin/python -m unittest test_era5land   (from ingest/)
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
sys.path.insert(0, str(HERE / "fixtures" / "era5land"))

import cloudwatch  # noqa: E402
import era5land as e5  # noqa: E402
import fakecds  # noqa: E402
import lambda_handler  # noqa: E402
import lease  # noqa: E402
import make_era5land_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402

T0 = 1_800_000_000.0
MARCH = (2024, 3)
TODAY = dt.date(2024, 4, 20)  # 2024-03 is the newest complete month (31 Mar + 6 days <= 20 Apr)


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def by_day(step, i, j):
    """tp at the 00 UTC step of `step`: (step's day of month) mm everywhere, in m."""
    return np.full(i.shape, step.day * 0.001)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mirror = zarrstore.LocalMirror(self.root)
        self.clock = Clock()
        self.metrics = cloudwatch.LocalSink()
        env = {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "fixtures"}
        self.env = unittest.mock.patch.dict(os.environ, env)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.tmp.cleanup)

    def call(self, cds, today=TODAY, mode="monthly", month=None):
        ev = {"product": "era5l", "mode": mode, **({"month": month} if month else {})}
        return e5.handler(ev, cds=cds, metrics=self.metrics, clock=self.clock, today=lambda: today)

    def state(self):
        return json.loads((self.root / e5.state_key()).read_text())["months"]

    def manifest(self):
        return manifest.read(self.mirror, "era5l")


# --- days, units and the grid --------------------------------------------------------


class ReadMonth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "m.nc"

    def test_each_00utc_step_is_the_day_before_in_mm(self):
        fx.write_month(self.path, *MARCH, values=by_day)
        mv = e5.read_month(str(self.path), MARCH)
        # The 1 March 00 UTC step is 29 February's total (2024 is a leap year).
        self.assertEqual(mv.first_day, dt.date(2024, 2, 29))
        self.assertEqual(mv.last_day, dt.date(2024, 3, 30))
        self.assertEqual(mv.values.shape, (31, e5.GRID.rows, e5.GRID.cols))
        self.assertEqual(mv.values.dtype, np.float32)
        land = ~np.isnan(mv.values[0])
        np.testing.assert_allclose(mv.values[0][land], 1.0, rtol=1e-6)  # step 1 Mar: 0.001 m = 1 mm
        np.testing.assert_allclose(mv.values[9][land], 10.0, rtol=1e-6)  # 9 Mar's total, from the 10 Mar step
        self.assertFalse(mv.preliminary)

    def test_written_days_and_the_record_start(self):
        self.assertEqual(e5.written_days(MARCH), (dt.date(2024, 2, 29), dt.date(2024, 3, 30)))
        self.assertEqual(e5.written_days((1950, 1)), (dt.date(1950, 1, 1), dt.date(1950, 1, 30)))
        fx.write_month(self.path, 1950, 1, values=by_day)
        mv = e5.read_month(str(self.path), (1950, 1))
        self.assertEqual((mv.first_day, mv.values.shape[0]), (dt.date(1950, 1, 1), 30))  # the 1949-12-31 total is dropped
        np.testing.assert_allclose(np.nanmax(mv.values[0]), 2.0, rtol=1e-6)

    def test_a_cell_is_the_mean_of_its_four_corner_points(self):
        # Point (i, j) holds i mm + j/100 mm: the cell (r, c) mean is (r + 0.5) + (c + 0.5)/100.
        fx.write_month(self.path, *MARCH, values=lambda s, i, j: (i + j / 100.0) * 0.001)
        mv = e5.read_month(str(self.path), MARCH)
        r, c = 100, 200  # well inside the land
        self.assertAlmostEqual(float(mv.values[3, r, c]), (r + 0.5) + (c + 0.5) / 100, places=3)
        # A cell whose four corners are all sea is NaN; a coastal cell takes its land corners.
        sea = fx.sea()
        self.assertTrue(np.isnan(mv.values[0, 0, 0]))
        coast = next((r, c) for r in range(e5.GRID.rows) for c in range(e5.GRID.cols) if 0 < (~sea[r : r + 2, c : c + 2]).sum() < 4)
        corners = [(coast[0] + a, coast[1] + b) for a in (0, 1) for b in (0, 1) if not sea[coast[0] + a, coast[1] + b]]
        expect = np.mean([i + j / 100 for i, j in corners])
        self.assertAlmostEqual(float(mv.values[0, coast[0], coast[1]]), expect, places=3)

    def test_packing_noise_is_zero_and_a_real_negative_fails(self):
        fx.write_month(self.path, *MARCH, values=lambda s, i, j: np.full(i.shape, -5e-7))  # -0.0005 mm
        mv = e5.read_month(str(self.path), MARCH)
        self.assertEqual(float(np.nanmin(mv.values)), 0.0)
        fx.write_month(self.path, *MARCH, values=lambda s, i, j: np.where((i == 50) & (j == 60), -0.001, 0.0))
        with self.assertRaises(e5.ImplausibleValueError):
            e5.read_month(str(self.path), MARCH)

    def test_more_than_2000_mm_fails(self):
        fx.write_month(self.path, *MARCH, values=lambda s, i, j: np.full(i.shape, 2.5))  # 2500 mm
        with self.assertRaises(e5.ImplausibleValueError):
            e5.read_month(str(self.path), MARCH)

    def test_a_file_for_another_month_is_refused(self):
        fx.write_month(self.path, 2024, 4, values=by_day)
        with self.assertRaisesRegex(ValueError, "not every day of 2024-03"):
            e5.read_month(str(self.path), MARCH)

    def test_the_phase_comes_from_expver(self):
        fx.write_month(self.path, *MARCH, preliminary=True)
        self.assertTrue(e5.read_month(str(self.path), MARCH).preliminary)


class Placement(Base):
    def test_a_known_cell_and_day_land_at_the_right_index_and_chunk(self):
        # Cell (lat -33.95, lon 18.45) is row 15, column 84; 9 March 2024 (the
        # 10 March step) is doy 68; 2024 is year index 74 from 1950.
        r, c = round((-33.95 - e5.GRID.origin["lat"]) / e5.GRID.step), round((18.45 - e5.GRID.origin["lon"]) / e5.GRID.step)
        self.assertEqual((r, c), (15, 84))
        marker = 123.0

        def values(step, i, j):
            v = np.full(i.shape, 0.001)
            if step == dt.date(2024, 3, 10):
                v = np.where((i >= r) & (i <= r + 1) & (j >= c) & (j <= c + 1), marker / 1000, v)
            return v

        cds = fakecds.FakeCds(today=TODAY, values=values)
        self.call(cds)  # submit
        self.call(cds)  # collect
        import zarr

        arr = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="era5l", mode="r", zarr_format=3)
        self.assertEqual(arr.shape, (75, 366, 275, 310))
        self.assertEqual(arr.chunks, (1, 366, 20, 20))
        self.assertEqual(arr.attrs["grid"], {"origin": {"lat": -35.45, "lon": 10.05}, "step": 0.1})
        self.assertEqual(arr.attrs["firstYear"], 1950)
        self.assertIn("Copernicus", arr.attrs["attribution"])
        doy = (dt.date(2024, 3, 9) - dt.date(2024, 1, 1)).days
        self.assertEqual(doy, 68)
        self.assertAlmostEqual(float(arr[74, doy, r, c]), marker, places=3)
        self.assertAlmostEqual(float(arr[74, doy, r, c + 1]), (marker * 2 + 2) / 4, places=3)  # half its corners
        self.assertAlmostEqual(float(arr[74, doy + 1, r, c]), 1.0, places=5)
        self.assertTrue((self.root / "era5l" / "c" / "74" / "0" / "0" / "4").exists())  # row 15 // 20, col 84 // 20
        m = self.manifest()
        self.assertEqual(m["grid"], {"origin": {"lat": -35.45, "lon": 10.05}, "step": 0.1})
        self.assertEqual(m["region"], {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0})
        self.assertEqual(m["finalThrough"], "2024-03-30")
        self.assertEqual(m["files"][0]["url"], "cds://reanalysis-era5-land/total_precipitation/2024-03")


# --- submit, then collect ---------------------------------------------------------------


class SubmitThenCollect(Base):
    def test_one_run_submits_a_later_one_collects(self):
        cds = fakecds.FakeCds(today=TODAY, ready_after=1)
        out = self.call(cds)
        self.assertEqual([s["month"] for s in out["submitted"]], ["2024-03"])
        self.assertEqual(out["collected"], [])
        self.assertIsNone(self.manifest())
        self.assertEqual(self.state()["2024-03"]["requestId"], "fake-2024-03-1")
        self.assertNotIn("download", [c[0] for c in cds.calls])

        out = self.call(cds)  # still running
        self.assertEqual((out["submitted"], out["collected"], out["inFlight"]), ([], [], 1))

        out = self.call(cds)
        self.assertEqual([c["month"] for c in out["collected"]], ["2024-03"])
        self.assertEqual(out["finalThrough"], "2024-03-30")
        self.assertIsNone(self.state()["2024-03"]["requestId"])
        self.assertEqual(cds.submits, ["2024-03"])

    def test_one_submit_per_month_however_often_it_runs(self):
        cds = fakecds.FakeCds(today=TODAY, ready_after=100)
        for _ in range(5):
            self.call(cds)
        self.assertEqual(cds.submits, ["2024-03"])

    def test_a_held_month_is_not_requested_again(self):
        cds = fakecds.FakeCds(today=TODAY, preliminary=lambda y, m: False)
        self.call(cds)
        self.call(cds)
        self.call(cds)
        self.assertEqual(cds.submits, ["2024-03"])
        self.assertIsNone(self.state()["2024-03"]["recheckAt"])

    def test_months_between_the_newest_held_and_the_newest_complete_are_requested(self):
        cds = fakecds.FakeCds(today=TODAY, ready_after=100)
        m = manifest.new(e5.PRODUCT)
        m["files"] = [{"url": e5.file_url((2023, 12)), "etag": None, "lastModified": None, "size": 1, "valuesSha256": "0" * 64, "revision": 1, "fetchedAt": "2024-03-20T00:00:00Z"}]
        manifest.write(self.mirror, m)
        self.call(cds)
        self.assertEqual(cds.submits, ["2024-01", "2024-02", "2024-03"])

    def test_state_lost_while_a_request_is_queued_adopts_it(self):
        cds = fakecds.FakeCds(today=TODAY, ready_after=0)
        self.call(cds)
        (self.root / e5.state_key()).unlink()
        out = self.call(cds)
        self.assertEqual(cds.submits, ["2024-03"])  # found, not resubmitted
        self.assertEqual(out["submitted"], [{"month": "2024-03", "purpose": "new", "requestId": "fake-2024-03-1"}])
        out = self.call(cds)
        self.assertEqual([c["month"] for c in out["collected"]], ["2024-03"])

    def test_an_intent_without_an_id_looks_before_it_submits(self):
        cds = fakecds.FakeCds(today=TODAY, ready_after=5)
        rid = cds.submit(e5.DATASET, e5.month_request(MARCH))  # the submit a crash cut off before the state
        self.mirror.write_json(e5.state_key(), {"months": {"2024-03": {"submittedAt": "2027-01-15T08:00:00Z", "purpose": "new"}}})
        self.call(cds)
        self.assertEqual(cds.submits, ["2024-03"])
        self.assertEqual(self.state()["2024-03"]["requestId"], rid)

    def test_state_lost_after_collecting_does_not_refetch_a_held_month(self):
        cds = fakecds.FakeCds(today=TODAY, preliminary=lambda y, m: False)
        self.call(cds)
        self.call(cds)
        (self.root / e5.state_key()).unlink()
        self.call(cds)
        self.assertEqual(cds.submits, ["2024-03"])
        self.assertIsNotNone(self.state()["2024-03"]["collectedAt"])

    def test_a_failed_request_backs_off_then_gives_up_loudly(self):
        cds = fakecds.FakeCds(today=TODAY, fail={"2024-03"})
        self.call(cds)  # submit 1
        out = self.call(cds)  # it failed: attempt 1, wait a day
        self.assertEqual(out["failed"][0]["attempts"], 1)
        self.assertEqual(cds.submits, ["2024-03"])
        self.call(cds)
        self.call(cds)
        self.assertEqual(cds.submits, ["2024-03"], "no resubmit inside the backoff")
        waits = []
        for attempt in range(1, e5.MAX_ATTEMPTS):
            self.clock.t += e5.backoff_seconds(attempt) + 1
            waits.append(e5.backoff_seconds(attempt) / 86400)
            self.call(cds)  # resubmit
            if attempt < e5.MAX_ATTEMPTS - 1:
                self.call(cds)  # it failed again
        self.assertEqual(waits, [1, 2, 4, 8])
        self.assertEqual(len(cds.submits), e5.MAX_ATTEMPTS)
        with self.assertRaises(e5.RequestsFailed):
            self.call(cds)  # the fifth failure: give up, and say so
        self.clock.t += 30 * 86400
        with self.assertRaises(e5.RequestsFailed):
            self.call(cds)  # and every run after, until the operator clears it
        self.assertEqual(len(cds.submits), e5.MAX_ATTEMPTS, "never resubmitted after MAX_ATTEMPTS")
        self.assertEqual(self.metrics.published[-1][0], "era5l")

    def test_no_more_than_max_in_flight(self):
        cds = fakecds.FakeCds(today=TODAY, ready_after=100)
        self.call(cds, mode="backfill", month="2023-01")
        for mo in range(2, 9):
            self.call(cds, mode="backfill", month=f"2023-{mo:02d}")
        self.assertEqual(len(cds.submits), e5.MAX_IN_FLIGHT)
        wanted = [k for k, e in self.state().items() if e["wanted"] and not e["requestId"]]
        self.assertEqual(len(wanted), 8 - e5.MAX_IN_FLIGHT)
        cds.ready_after = 0
        self.call(cds)  # the daily run collects the four and fills the slots again
        self.assertEqual(len(cds.submits), 8)


class Backfill(Base):
    def test_a_backfill_month_is_submitted_then_collected(self):
        cds = fakecds.FakeCds(today=TODAY)
        out = self.call(cds, mode="backfill", month="2001-07")
        self.assertEqual([s["month"] for s in out["submitted"]], ["2001-07"])
        out = self.call(cds, mode="backfill", month="2001-07")
        self.assertEqual([c["month"] for c in out["collected"]], ["2001-07"])
        self.assertEqual(out["finalThrough"], "2001-07-30")
        self.assertFalse(self.state()["2001-07"]["wanted"])

    def test_events_are_checked(self):
        for ev in (
            {"product": "era5l", "mode": "monthly", "month": "2024-01"},
            {"product": "era5l", "mode": "backfill"},
            {"product": "era5l", "mode": "backfill", "month": "1949-12"},
            {"product": "era5l", "mode": "backfill", "month": "2024-04"},  # not complete on 20 April
            {"product": "era5l", "mode": "nightly"},
            {"product": "era5l", "mode": "monthly", "extra": 1},
        ):
            with self.subTest(ev=ev), self.assertRaises(e5.BadEvent):
                e5.validate_event(ev, TODAY)
        self.assertEqual(e5.newest_complete_month(dt.date(2024, 4, 6)), (2024, 3))
        self.assertEqual(e5.newest_complete_month(dt.date(2024, 4, 5)), (2024, 2))


# --- revisions -----------------------------------------------------------------------------


class Revisions(Base):
    def collect_march(self, cds):
        with unittest.mock.patch.object(e5, "newest_complete_month", return_value=MARCH):
            self.call(cds, today=self.today)
            self.call(cds, today=self.today)

    def test_a_recheck_with_the_same_values_keeps_the_revision(self):
        self.today = TODAY
        self.collect_march(fakecds.FakeCds(today=self.today))  # preliminary (ERA5-Land-T)
        e = self.state()["2024-03"]
        self.assertTrue(e["preliminary"])
        self.assertEqual(e["recheckAt"], (dt.date(2024, 3, 31) + dt.timedelta(days=e5.RECHECK_AFTER_DAYS)).isoformat())
        first = self.manifest()

        self.today = dt.date.fromisoformat(e["recheckAt"])
        self.clock.t += 60 * 86400
        cds = fakecds.FakeCds(today=self.today, preliminary=lambda y, m: False)
        self.collect_march(cds)
        self.assertEqual(cds.submits, ["2024-03"])
        m = self.manifest()
        self.assertEqual((m["revision"], m["changes"]), (1, []))
        self.assertEqual(m["files"][0]["valuesSha256"], first["files"][0]["valuesSha256"])
        e = self.state()["2024-03"]
        self.assertFalse(e["preliminary"])
        self.assertIsNone(e["recheckAt"], "a consolidated month is never asked for again")

    def test_changed_values_bump_the_revision_with_a_changes_entry(self):
        self.today = TODAY
        self.collect_march(fakecds.FakeCds(today=self.today))
        self.today = dt.date(2024, 6, 14)
        cds = fakecds.FakeCds(variant="revised", today=self.today, preliminary=lambda y, m: False)
        self.collect_march(cds)
        m = self.manifest()
        self.assertEqual(m["revision"], 2)
        self.assertEqual(len(m["changes"]), 1)
        ch = m["changes"][0]
        self.assertEqual(ch["revision"], 2)
        self.assertEqual(ch["days"], ["2024-02-29", "2024-03-30"])
        # One point moved by 2.5 mm: the four cells it is a corner of, each by a quarter.
        self.assertEqual(ch["cellsChanged"], 4)
        self.assertAlmostEqual(ch["maxAbsDiff"], fx.REVISED_DELTA_M * 1000 / 4, places=4)
        self.assertEqual(m["files"][0]["revision"], 2)

    def test_a_preliminary_month_is_checked_again_while_it_stays_preliminary(self):
        self.today = TODAY
        self.collect_march(fakecds.FakeCds(today=self.today))
        self.today = dt.date(2024, 6, 14)
        self.collect_march(fakecds.FakeCds(today=self.today, preliminary=lambda y, m: True))
        self.assertEqual(self.state()["2024-03"]["recheckAt"], (self.today + dt.timedelta(days=e5.RECHECK_EVERY_DAYS)).isoformat())


# --- refusals, the lease, the metric ----------------------------------------------------------


class Refusal(Base):
    def test_a_403_or_401_stops_the_run_and_the_rest_of_the_day(self):
        for status in (403, 401):
            with self.subTest(status=status):
                (self.root / e5.refused_key()).unlink(missing_ok=True)
                with self.assertRaises(polite.StopRun) as caught:
                    self.call(fakecds.FakeCds(today=TODAY, refuse=status))
                self.assertEqual(caught.exception.status, status)
                self.assertEqual(json.loads((self.root / e5.refused_key()).read_text())["date"], TODAY.isoformat())
                ok = fakecds.FakeCds(today=TODAY)
                with self.assertRaises(polite.StopRun):
                    self.call(ok)
                self.assertEqual(ok.calls, [], "no call to the CDS after a refusal the same day")
                self.assertEqual(self.metrics.published[-1][0], "era5l")
        ok = fakecds.FakeCds(today=TODAY + dt.timedelta(days=1))
        self.call(ok, today=TODAY + dt.timedelta(days=1))
        self.assertEqual(ok.submits, ["2024-03"])

    def test_live_maps_401_and_403_to_stoprun_and_404_to_missing(self):
        import requests

        live = e5.LiveCds.__new__(e5.LiveCds)
        live.sleep, live.clock, live._last = (lambda s: None), (lambda: 0.0), None

        def raising(status):
            resp = requests.Response()
            resp.status_code = status

            class Client:
                def get_remote(self, rid):
                    raise requests.HTTPError(response=resp)

                def submit(self, d, r):
                    raise requests.HTTPError(response=resp)

            return Client()

        for status in (401, 403):
            live.client = raising(status)
            with self.assertRaises(polite.StopRun) as caught:
                live.status("x")
            self.assertEqual(caught.exception.status, status)
        live.client = raising(404)
        self.assertEqual(live.status("x"), "missing")
        live.client = raising(503)
        with self.assertRaises(e5.CdsError):
            live.submit(e5.DATASET, {})


class Lease(Base):
    def test_a_held_lease_ends_a_monthly_run_and_fails_a_backfill(self):
        cds = fakecds.FakeCds(today=TODAY)
        with lease.hold(self.mirror, "era5l", self.clock):
            out = self.call(cds)
            self.assertIn("busy", out)
            with self.assertRaises(lease.MirrorBusy):
                self.call(cds, mode="backfill", month="2020-01")
        self.assertEqual(cds.calls, [])
        self.assertEqual([p for p, _ in self.metrics.published], ["era5l", "era5l"])
        self.call(cds)
        self.assertFalse((self.root / lease.lease_key("era5l")).exists(), "released after the run")


class Metric(Base):
    def test_every_exit_publishes_the_lag(self):
        cds = fakecds.FakeCds(today=TODAY, preliminary=lambda y, m: False)
        self.call(cds)  # nothing held yet: counted from 1949-12-31
        self.assertEqual(self.metrics.published[-1], ("era5l", (TODAY - dt.date(1949, 12, 31)).days))
        self.call(cds)  # collected
        self.assertEqual(self.metrics.published[-1], ("era5l", (TODAY - dt.date(2024, 3, 30)).days))
        with unittest.mock.patch.object(e5, "ingest_month", side_effect=RuntimeError("boom")):
            cds2 = fakecds.FakeCds(today=TODAY)
            with self.assertRaises(RuntimeError):
                self.call(cds2, mode="backfill", month="2020-01")
                self.call(cds2, mode="backfill", month="2020-01")
        self.assertEqual(len(self.metrics.published), 4)

    def test_lag_publishes_through_cloudwatch_in_live_mode(self):
        class CW:
            def __init__(self):
                self.calls = []

            def put_metric_data(self, **kw):
                self.calls.append(kw)

        cw = CW()
        sink = cloudwatch.CloudWatchSink(client=cw)
        sink.publish("era5l", 3)
        d = cw.calls[0]["MetricData"][0]
        self.assertEqual((cw.calls[0]["Namespace"], d["MetricName"], d["Dimensions"]), ("water-management/Mirror", "MirrorLagDays", [{"Name": "Product", "Value": "era5l"}]))


class Secret(Base):
    def test_the_key_is_read_by_arn_and_never_without_one(self):
        class SM:
            def __init__(self, value):
                self.value, self.asked = value, []

            def get_secret_value(self, SecretId):
                self.asked.append(SecretId)
                return {"SecretString": self.value}

        sm = SM("  synthetic-not-a-key \n")
        self.assertEqual(e5.read_cds_key("arn:aws:secretsmanager:af-south-1:000000000000:secret:x", sm), "synthetic-not-a-key")
        self.assertEqual(sm.asked, ["arn:aws:secretsmanager:af-south-1:000000000000:secret:x"])
        with self.assertRaisesRegex(RuntimeError, "CDS_KEY_SECRET_ARN"):
            e5.read_cds_key("", sm)
        with self.assertRaisesRegex(RuntimeError, "no value yet"):
            e5.read_cds_key("arn:x", SM(""))

    def test_live_mode_reads_no_secret_when_the_run_needs_no_cds(self):
        self.mirror.write_json(e5.refused_key(), {"date": TODAY.isoformat(), "status": 403})

        class SM:
            def get_secret_value(self, SecretId):
                raise AssertionError("the secret was read")

        with unittest.mock.patch.dict(os.environ, {"FEED_SOURCE": "live", "CDS_KEY_SECRET_ARN": "arn:x"}):
            with self.assertRaises(polite.StopRun):
                e5.handler({"product": "era5l", "mode": "monthly"}, metrics=self.metrics, clock=self.clock, today=lambda: TODAY, secrets_client=SM())


class Handler(Base):
    def test_lambda_handler_hands_era5l_to_era5land_in_fixtures_mode(self):
        out = lambda_handler.handler({"product": "era5l", "mode": "monthly"}, metrics=self.metrics, clock=self.clock, today=lambda: TODAY)
        self.assertEqual((out["product"], out["source"]), ("era5l", "fixtures"))
        self.assertEqual([s["month"] for s in out["submitted"]], ["2024-03"])
        out = lambda_handler.handler({"product": "era5l", "mode": "monthly"}, metrics=self.metrics, clock=self.clock, today=lambda: TODAY)
        self.assertEqual(out["finalThrough"], "2024-03-30")  # a fresh FakeCds still knows the earlier job

    def test_the_request_asks_for_00utc_steps_over_d1(self):
        req = e5.month_request((2024, 2))
        self.assertEqual(req["day"], [f"{d:02d}" for d in range(1, 30)])
        self.assertEqual((req["time"], req["variable"], req["area"]), (["00:00"], ["total_precipitation"], [-8.0, 10.0, -35.5, 41.0]))
        self.assertEqual(e5.request_month(req), (2024, 2))
        self.assertEqual(e5.request_month({**req, "year": ["2024"], "month": ["02"]}), (2024, 2))
        self.assertIsNone(e5.request_month({**req, "variable": ["2m_temperature"]}))

    def test_coverage_stops_at_a_gap(self):
        files = [{"url": e5.file_url(ym)} for ym in [(2024, 1), (2024, 2), (2024, 4)]]
        self.assertEqual(e5.coverage(files), ("2023-12-31", "2024-02-28"))


if __name__ == "__main__":
    unittest.main()
