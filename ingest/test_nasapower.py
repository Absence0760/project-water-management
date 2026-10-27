"""nasapower.py: NASA POWER's daily meteorology as FAO-56 ET0 in `power_et0`.
One parameter a request over tiles of at most 10 deg, POWER's JSON parsed
strictly (fill -999 and missing days NaN, units checked), the nearest POWER
point for each 0.1 deg cell, a day POWER doesn't have yet skipped, a revision
only when a day's values change, the 120-day window, a 403 or 401 that stops
the run and the rest of the UTC day, and MirrorLagDays{Product=power_et0} on
every exit.

No network: POWER is power_fixture.FakePower.

    ingest/.venv/bin/python -m unittest test_nasapower   (from ingest/)
"""

import datetime as dt
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
import urllib.parse
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import cloudwatch  # noqa: E402
import fao56  # noqa: E402
import lambda_handler  # noqa: E402
import lease  # noqa: E402
import manifest  # noqa: E402
import nasapower as npw  # noqa: E402
import polite  # noqa: E402
import power_fixture  # noqa: E402
import zarrstore  # noqa: E402

TODAY = dt.date(2024, 3, 20)
NEWEST = TODAY - dt.timedelta(days=npw.LAG_DAYS)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mirror = zarrstore.LocalMirror(self.root)
        self.metrics = cloudwatch.LocalSink()
        self.env = unittest.mock.patch.dict(os.environ, {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "fixtures"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.tmp.cleanup)

    def call(self, fake, today=TODAY, days=3):
        return npw.handle({"product": "power_et0", "mode": "recent", "days": days}, opener=fake, metrics=self.metrics, today=lambda: today, clock=lambda: 1_800_000_000.0)

    def manifest(self):
        return manifest.read(self.mirror, "power_et0")

    def day(self, d):
        return zarrstore.read_daily_day(self.root, "power_et0", d)


class Requests(unittest.TestCase):
    def test_tiles_cover_d1_evenly_at_most_10_degrees(self):
        t = npw.tiles()
        self.assertEqual(len(t), 12)
        for x in t:
            self.assertLessEqual(x.n - x.s, 10.0)
            self.assertLessEqual(x.e - x.w, 10.0)
        self.assertEqual((min(x.s for x in t), max(x.n for x in t), min(x.w for x in t), max(x.e for x in t)), (-35.5, -8.0, 10.0, 41.0))
        area = sum((x.n - x.s) * (x.e - x.w) for x in t)
        self.assertAlmostEqual(area, 27.5 * 31.0, places=3)

    def test_one_parameter_a_request_in_ag_json_lst(self):
        url = npw.request_url("T2M_MAX", npw.tiles()[0], dt.date(2024, 3, 1), dt.date(2024, 3, 17))
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
        self.assertTrue(url.startswith(npw.BASE + "?"))
        self.assertEqual((q["parameters"], q["community"], q["format"], q["time-standard"], q["start"], q["end"]), ("T2M_MAX", "AG", "JSON", "LST", "20240301", "20240317"))

    def test_events(self):
        for ev in ({"product": "power_et0", "mode": "monthly"}, {"product": "power_et0", "mode": "recent", "days": 0}, {"product": "power_et0", "mode": "recent", "days": 61}, {"product": "power_et0", "mode": "recent", "x": 1}):
            with self.subTest(ev=ev), self.assertRaises(npw.BadEvent):
                npw.validate_event(ev)
        self.assertEqual(npw.validate_event({"product": "power_et0", "mode": "recent"})["days"], 30)


class Parse(unittest.TestCase):
    def body(self, **kw):
        fake = power_fixture.FakePower(latest=NEWEST, **kw)

        class Req:
            full_url = npw.request_url("PS", npw.Tile(-34.0, -33.0, 18.0, 19.0), NEWEST - dt.timedelta(days=1), NEWEST + dt.timedelta(days=1))

        return fake(Req()).read()

    def test_fill_and_days_past_the_newest_are_nan_and_points_keyed_by_coordinate(self):
        days = [NEWEST - dt.timedelta(days=1), NEWEST, NEWEST + dt.timedelta(days=1)]
        out = npw.parse_response(self.body(fill={("PS", NEWEST, -33.75, 18.25)}), "PS", days)
        self.assertEqual(set(out), {(-33.75, 18.25), (-33.75, 18.75), (-33.25, 18.25), (-33.25, 18.75)})
        v = out[(-33.75, 18.25)]
        self.assertFalse(np.isnan(v[0]))
        self.assertTrue(np.isnan(v[1]), "the fill value")
        self.assertTrue(np.isnan(v[2]), "a day POWER doesn't have yet")

    def test_wrong_units_or_shape_is_refused(self):
        with self.assertRaisesRegex(npw.PowerFormatError, "expected 'kPa'"):
            npw.parse_response(self.body(units={"PS": "hPa"}), "PS", [NEWEST])
        with self.assertRaises(npw.PowerFormatError):
            npw.parse_response(b'{"type": "Feature"}', "PS", [NEWEST])
        with self.assertRaises(npw.PowerFormatError):
            npw.parse_response(b"<html>", "PS", [NEWEST])


class Placement(unittest.TestCase):
    def test_each_cell_takes_the_nearest_point_and_cells_beyond_are_nan(self):
        pts = {(la, lo): np.array([la * 100 + lo]) for la in (-35.25, -34.75) for lo in (10.25, 10.75, 11.25)}
        out = npw.place(pts, 1)
        g = npw.GRID
        r = lambda lat: round((lat - g.origin["lat"]) / g.step)  # noqa: E731
        c = lambda lon: round((lon - g.origin["lon"]) / g.step)  # noqa: E731
        self.assertAlmostEqual(float(out[0, r(-35.45), c(10.05)]), -35.25 * 100 + 10.25, places=2)
        self.assertAlmostEqual(float(out[0, r(-34.85), c(10.95)]), -34.75 * 100 + 10.75, places=2)  # 0.2 from 10.75, 0.3 from 11.25
        self.assertAlmostEqual(float(out[0, r(-34.55), c(11.45)]), -34.75 * 100 + 11.25, places=2)
        self.assertTrue(np.isnan(out[0, r(-34.45), c(10.05)]), "more than half a spacing north of the last row")
        self.assertTrue(np.isnan(out[0, r(-35.45), c(11.55)]), "more than half a spacing east of the last column")

    def test_points_that_are_not_a_lattice_are_refused(self):
        with self.assertRaisesRegex(npw.PowerFormatError, "regular lattice"):
            npw.place({(-35.25, 10.25): np.array([1.0]), (-34.75, 10.75): np.array([1.0])}, 1)


class Run(Base):
    def test_a_run_writes_the_window_and_et0_is_fao56_of_the_nearest_point(self):
        fake = power_fixture.FakePower(latest=NEWEST)
        out = self.call(fake)
        self.assertEqual(len(fake.requests), 6 * 12, "one request per parameter per tile")
        self.assertEqual([c["outcome"] for c in out["copied"]], ["added"] * 3)
        m = self.manifest()
        self.assertEqual((m["prelimThrough"], m["finalThrough"], m["revision"]), (NEWEST.isoformat(), None, 1))
        self.assertEqual([f["url"] for f in m["files"]], [npw.day_url(NEWEST - dt.timedelta(days=k)) for k in (2, 1, 0)])
        # Cape Town's cell (-33.95, 18.45) takes the POWER point (-33.75, 18.25).
        r, c = round((-33.95 - npw.GRID.origin["lat"]) / 0.1), round((18.45 - npw.GRID.origin["lon"]) / 0.1)
        p = lambda k: power_fixture.value(k, NEWEST, -33.75, 18.25)  # noqa: E731
        want = fao56.et0(p("T2M_MAX"), p("T2M_MIN"), p("T2MDEW"), p("WS2M"), p("ALLSKY_SFC_SW_DWN"), p("PS"), -33.75, NEWEST.timetuple().tm_yday)
        self.assertAlmostEqual(float(self.day(NEWEST)[r, c]), float(want), places=4)
        import zarr

        arr = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="power_et0", mode="r", zarr_format=3)
        self.assertEqual((arr.attrs["firstDay"], arr.attrs["attribution"]), ("1981-01-01", npw.ATTRIBUTION))
        self.assertEqual(self.metrics.published[-1], ("power_et0", npw.LAG_DAYS))

    def test_a_day_power_lacks_is_skipped_and_a_point_with_a_fill_is_nan(self):
        fake = power_fixture.FakePower(latest=NEWEST - dt.timedelta(days=1), fill={("WS2M", NEWEST - dt.timedelta(days=1), -33.75, 18.25)})
        self.call(fake)
        m = self.manifest()
        self.assertEqual(m["prelimThrough"], (NEWEST - dt.timedelta(days=1)).isoformat())
        self.assertNotIn(npw.day_url(NEWEST), [f["url"] for f in m["files"]])
        r, c = round((-33.95 - npw.GRID.origin["lat"]) / 0.1), round((18.45 - npw.GRID.origin["lon"]) / 0.1)
        self.assertTrue(np.isnan(self.day(NEWEST - dt.timedelta(days=1))[r, c]))

    def test_same_values_no_bump_changed_values_bump_with_a_change(self):
        self.call(power_fixture.FakePower(latest=NEWEST))
        out = self.call(power_fixture.FakePower(latest=NEWEST))
        self.assertEqual([c["outcome"] for c in out["copied"]], ["unchanged"] * 3)
        self.assertEqual(self.manifest()["revision"], 1)

        def warmer(p, d, la, lo):
            v = power_fixture.value(p, d, la, lo)
            return v + 2.0 if (p == "T2M_MAX" and d == NEWEST and (la, lo) == (-33.75, 18.25)) else v

        out = self.call(power_fixture.FakePower(latest=NEWEST, values=warmer))
        self.assertEqual([c["outcome"] for c in out["copied"]], ["unchanged", "unchanged", "changed"])
        m = self.manifest()
        self.assertEqual(m["revision"], 2)
        self.assertEqual(m["changes"][-1]["days"], [NEWEST.isoformat()] * 2)
        self.assertEqual(m["changes"][-1]["cellsChanged"], 25, "the 25 copy cells nearest that POWER point")

    def test_days_older_than_the_window_are_dropped(self):
        self.call(power_fixture.FakePower(latest=NEWEST))
        later = TODAY + dt.timedelta(days=npw.KEEP_DAYS + 1)
        self.call(power_fixture.FakePower(latest=later - dt.timedelta(days=npw.LAG_DAYS)), today=later, days=1)
        m = self.manifest()
        self.assertEqual([f["url"] for f in m["files"]], [npw.day_url(later - dt.timedelta(days=npw.LAG_DAYS))])
        self.assertTrue(np.isnan(self.day(NEWEST)).all(), "the dropped day's chunk is gone")

    def test_an_implausible_et0_fails_before_writing(self):
        hot = lambda p, d, la, lo: 60.0 if p == "T2M_MAX" else (5.0 if p == "T2MDEW" else (20.0 if p == "WS2M" else power_fixture.value(p, d, la, lo)))  # noqa: E731
        with self.assertRaises(npw.ImplausibleValueError):
            self.call(power_fixture.FakePower(latest=NEWEST, values=hot))
        self.assertIsNone(self.manifest())

    def test_a_deadline_writes_nothing(self):
        class Budget:
            def allows(self, wait):
                return False

        out = npw.run_recent(self.mirror, polite.PoliteClient(min_interval=0.0, opener=power_fixture.FakePower(latest=NEWEST)), TODAY, 3, Budget())
        self.assertEqual(out["stopped"], "deadline")
        self.assertIsNone(self.manifest())


class Refusal(Base):
    def test_a_403_or_401_stops_the_run_and_the_rest_of_the_day(self):
        for status in (403, 401):
            with self.subTest(status=status):
                (self.root / npw.refused_key()).unlink(missing_ok=True)
                with self.assertRaises(polite.StopRun):
                    self.call(power_fixture.FakePower(latest=NEWEST, refuse=status))
                self.assertEqual(json.loads((self.root / npw.refused_key()).read_text())["day"], TODAY.isoformat())
                ok = power_fixture.FakePower(latest=NEWEST)
                out = self.call(ok)
                self.assertEqual((out["stopped"], ok.requests), ("refused_today", []))
        out = self.call(power_fixture.FakePower(latest=NEWEST + dt.timedelta(days=1)), today=TODAY + dt.timedelta(days=1))
        self.assertEqual(out["stopped"], "copied")


class Metric(Base):
    def test_every_exit_publishes_the_lag(self):
        with self.assertRaises(polite.StopRun):
            self.call(power_fixture.FakePower(latest=NEWEST, refuse=403))
        self.assertEqual(self.metrics.published[-1], ("power_et0", npw.LAG_DAYS + npw.RECENT_DAYS + 1))
        self.call(power_fixture.FakePower(latest=NEWEST))  # refused today: still publishes
        with lease.hold(self.mirror, "power_et0"):
            out = self.call(power_fixture.FakePower(latest=NEWEST), today=TODAY + dt.timedelta(days=1))
        self.assertEqual(out["stopped"], "busy")
        self.assertEqual(len(self.metrics.published), 3)

    def test_lambda_handler_hands_power_et0_to_nasapower_in_fixtures_mode(self):
        out = lambda_handler.handler({"product": "power_et0", "mode": "recent", "days": 2}, metrics=self.metrics, today=lambda: TODAY)
        self.assertEqual((out["product"], out["source"], out["prelimThrough"]), ("power_et0", "fixtures", NEWEST.isoformat()))


class Manifest(unittest.TestCase):
    def entry(self, day, **kw):
        return {"url": npw.day_url(day), "etag": None, "lastModified": None, "size": None, "valuesSha256": "0" * 64, "revision": 1, "fetchedAt": "2024-04-20T00:00:00Z", **kw}

    def test_the_rules_hold(self):
        m = manifest.new("power_et0")
        m.update(files=[self.entry(dt.date(2024, 3, 1)), self.entry(dt.date(2024, 3, 3))], years={"first": 2024, "last": 2024}, prelimThrough="2024-03-03")
        manifest.validate(m)
        self.assertEqual(manifest.power_held_days(m["files"]), {"2024-03-01", "2024-03-03"})
        for bad in ({"prelimThrough": "2024-03-04"}, {"finalThrough": "2024-03-01"}, {"files": [self.entry(dt.date(2024, 3, 1), etag='"x"')]}, {"files": [{**self.entry(dt.date(2024, 3, 1)), "url": "power://x/2024-03-01"}]}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                manifest.validate({**m, **bad})


if __name__ == "__main__":
    unittest.main()
