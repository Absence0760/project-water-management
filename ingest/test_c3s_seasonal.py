"""c3s_seasonal.py: C3S seasonal forecasts and hindcasts into `c3s/<init>` and
`c3s-hc/<system>/<MM>` (issue #620). The 1 deg grid (the third grid spec),
the requests and their keys, the release days, the GRIB's de-accumulation
into mm/day (any lead count, a missing field, packing noise, the checks),
submit on one run and collect on a later one (never waiting, at most
MAX_IN_FLIGHT queued, adopting a lost request, backoff and giving up, a
401/403 that stops the run), the arrays' layout and attributes (the credit
and the contributing centres), the manifests, the index, the hindcast's
years, and MirrorLagDays{Product=c3s} on every exit.

No network and no key: the CDS is fakecds.FakeC3sCds, which writes
fixtures/c3s/make_c3s_fixture.py's synthetic GRIB.

    ingest/.venv/bin/python -m unittest test_c3s_seasonal   (from ingest/)
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
sys.path.insert(0, str(HERE / "fixtures" / "c3s"))

import c3s_seasonal as c3  # noqa: E402
import c3srequest  # noqa: E402
import cloudwatch  # noqa: E402
import fakecds  # noqa: E402
import grid  # noqa: E402
import lambda_handler  # noqa: E402
import make_c3s_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402

#: 28 October 2026, 14:00 UTC: every system's October init is out (ECMWF's on the 6th, the rest on the 10th).
NOW = dt.datetime(2026, 10, 28, 14, tzinfo=dt.UTC)
TODAY = NOW.date()
LEADS = 5


class Clock:
    def __init__(self, t: dt.datetime = NOW):
        self.t = t.timestamp()

    def __call__(self):
        return self.t


def open_array(root: Path, product: str):
    import zarr

    store = zarr.storage.LocalStore(root)
    return zarr.open_group(store=store, path=product, mode="r", zarr_format=3), zarr.open_array(store=store, path=f"{product}/tp_mm", mode="r", zarr_format=3)


def expected(system, year, member, leads=LEADS):
    """(leads, rows, cols) south-up: make_c3s_fixture.daily_mm on the 1 deg grid."""
    i, j = np.meshgrid(np.arange(grid.C3S.rows), np.arange(grid.C3S.cols), indexing="ij")
    return np.stack([fx.daily_mm(system, year, member, d, i, j) for d in range(leads)])


class TheGrid(unittest.TestCase):
    def test_a_third_grid_of_whole_degree_centres_over_d1_snapped_outward(self):
        g = grid.C3S
        self.assertEqual((g.rows, g.cols, g.step), (29, 32, 1.0))
        self.assertEqual(g.origin, {"lat": -36.0, "lon": 10.0})
        self.assertEqual(g.region, {"w": 9.5, "s": -36.5, "e": 41.5, "n": -7.5})
        self.assertEqual(grid.seasonal_region(grid.REGION), grid.SEASONAL_REGION)
        # Every D1 corner lies inside the box; its centres run 36-8 S, 10-41 E.
        self.assertEqual(g.row_index(-8.0), 28)
        self.assertEqual(g.col_index(41.0), 31)
        with self.assertRaises(ValueError):
            g.row_index(-7.0)
        self.assertIs(grid.for_product("c3s/2026-10"), g)
        self.assertIs(grid.for_product("c3s-hc/meteo_france-9/01"), g)
        for bad in ("c3s/2026-13", "c3s/2026-10-01", "c3s-hc/ecmwf/10", "c3s-hc/ecmwf-51/13"):
            with self.assertRaises(ValueError, msg=bad):
                grid.for_product(bad)
        # The other grids keep D1 as their box (positive control).
        self.assertEqual(grid.ERA5L.attrs["region"], grid.REGION)
        self.assertEqual(grid.CHC.attrs["region"], grid.REGION)

    def test_the_manifest_knows_its_step(self):
        self.assertEqual(manifest.product_step("c3s/2026-10"), 1.0)
        self.assertEqual(manifest.product_step("c3s-hc/ecmwf-51/10"), 1.0)
        self.assertEqual(manifest.new("c3s/2026-10")["grid"], {"origin": {"lat": -36.0, "lon": 10.0}, "step": 1.0})


class Requests(unittest.TestCase):
    def test_a_request_names_its_key_back(self):
        for key in [("fc", "ecmwf-51", "2026-10"), ("hc", "ukmo-604", "03"), ("fc", "meteo_france-9", "2027-01")]:
            req = c3srequest.request(key)
            self.assertEqual(c3srequest.request_key(req), key)
            self.assertEqual(req["area"], [-8.0, 10.0, -36.0, 41.0])
            self.assertEqual(req["leadtime_hour"][0], "24")
            self.assertEqual(req["leadtime_hour"][-1], "5160")
            self.assertEqual(len(req["leadtime_hour"]), 215)
        hc = c3srequest.request(("hc", "ecmwf-51", "10"))
        self.assertEqual((hc["year"][0], hc["year"][-1], len(hc["year"])), ("1993", "2016", 24))
        self.assertEqual((hc["originating_centre"], hc["system"], hc["month"]), ("ecmwf", "51", ["10"]))

    def test_someone_elses_request_is_not_ours(self):
        req = c3srequest.request(("fc", "ecmwf-51", "2026-10"))
        self.assertIsNone(c3srequest.request_key({**req, "variable": ["2m_temperature"]}))
        self.assertIsNone(c3srequest.request_key({**req, "leadtime_hour": ["24"]}))
        self.assertIsNone(c3srequest.request_key({**req, "year": ["2010"]}))
        self.assertIsNone(c3srequest.request_key({"variable": "total_precipitation"}))
        self.assertIsNone(c3srequest.parse_key("fc/ecmwf-51/2026-13"))
        self.assertIsNone(c3srequest.parse_key("hc/ecmwf-51/2026-10"))

    def test_ecmwf_is_out_on_the_6th_and_the_others_on_the_10th_after_12_utc(self):
        at = lambda d, h, mi=0: dt.datetime(2026, 10, d, h, mi, tzinfo=dt.UTC)  # noqa: E731
        self.assertEqual(c3.newest_released("ecmwf-51", at(6, 12, 29)), "2026-09")
        self.assertEqual(c3.newest_released("ecmwf-51", at(6, 12, 30)), "2026-10")
        self.assertEqual(c3.newest_released("ukmo-604", at(9, 23)), "2026-09")
        self.assertEqual(c3.newest_released("ukmo-604", at(10, 13)), "2026-10")
        self.assertEqual(c3.newest_released("ncep-2", dt.datetime(2026, 1, 3, tzinfo=dt.UTC)), "2025-12")


class ReadRequest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "r.grib"

    def test_de_accumulates_into_mm_a_day_south_up_and_pads_the_leads(self):
        key = ("fc", "dwd-22", "2026-10")
        fx.write_request(self.path, key, members=2, leads=LEADS)
        d = c3.read_request(str(self.path), key)
        self.assertEqual((d.years, d.members, d.values.shape), ([2026], 2, (1, 2, 215, 29, 32)))
        self.assertEqual(d.values.dtype, np.float32)
        for m in range(2):
            np.testing.assert_allclose(d.values[0, m, :LEADS], expected("dwd-22", 2026, m), atol=1e-3)
        self.assertTrue(np.isnan(d.values[0, :, LEADS:]).all())

    def test_a_missing_field_leaves_the_two_days_it_bounds_nan(self):
        key = ("fc", "dwd-22", "2026-10")
        fx.write_request(self.path, key, members=1, leads=LEADS, skip=lambda y, m, h: h == 48)
        v = c3.read_request(str(self.path), key).values[0, 0]
        self.assertTrue(np.isnan(v[1]).all() and np.isnan(v[2]).all())
        np.testing.assert_allclose(v[0], expected("dwd-22", 2026, 0)[0], atol=1e-3)
        np.testing.assert_allclose(v[3], expected("dwd-22", 2026, 0)[3], atol=1e-3)

    def test_packing_noise_is_clamped_and_a_real_drop_or_flood_fails(self):
        key = ("fc", "dwd-22", "2026-10")
        fx.write_request(self.path, key, members=1, leads=3, values=lambda s, y, m, d, i, j: np.full(i.shape, -0.01 if d == 1 else 1.0))
        v = c3.read_request(str(self.path), key).values[0, 0]
        self.assertEqual(float(v[1].max()), 0.0)
        np.testing.assert_allclose(v[2], 1.0, atol=1e-3)
        fx.write_request(self.path, key, members=1, leads=3, values=lambda s, y, m, d, i, j: np.full(i.shape, -20.0 if d == 1 else 30.0))
        with self.assertRaisesRegex(c3.C3sFormatError, "outside 0-2000 mm"):
            c3.read_request(str(self.path), key)
        fx.write_request(self.path, key, members=1, leads=2, values=lambda s, y, m, d, i, j: np.full(i.shape, 2500.0))
        with self.assertRaisesRegex(c3.C3sFormatError, "outside"):
            c3.read_request(str(self.path), key)

    def test_refuses_another_requests_file(self):
        fx.write_request(self.path, ("fc", "dwd-22", "2026-09"), members=1, leads=2)
        with self.assertRaisesRegex(c3.C3sFormatError, "not fc/dwd-22/2026-10's"):
            c3.read_request(str(self.path), ("fc", "dwd-22", "2026-10"))
        self.path.write_bytes(self.path.read_bytes() * 2)  # every field twice
        with self.assertRaisesRegex(c3.C3sFormatError, "twice"):
            c3.read_request(str(self.path), ("fc", "dwd-22", "2026-09"))

    def test_a_hindcast_holds_the_years_the_system_has(self):
        key = ("hc", "ecmwf-51", "02")
        fx.write_request(self.path, key, members=2, leads=3, years=[1993, 1994, 2016])
        d = c3.read_request(str(self.path), key)
        self.assertEqual(d.years, [1993, 1994, 2016])
        np.testing.assert_allclose(d.values[2, 1, :3], expected("ecmwf-51", 2016, 1, 3), atol=1e-3)


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

    def cds(self, **kw):
        return fakecds.FakeC3sCds(today=TODAY, leads=LEADS, **kw)

    def call(self, cds, **ev):
        event = {"product": "c3s", "mode": "monthly", **ev}
        return c3.handler(event, cds=cds, metrics=self.metrics, clock=self.clock, today=lambda: TODAY)

    def drain(self, cds, runs=5, **ev):
        out = []
        for _ in range(runs):
            out.append(self.call(cds, **ev))
        return out


class SubmitThenCollect(Base):
    def test_the_first_run_only_submits_and_a_later_one_collects(self):
        cds = self.cds()
        r = self.call(cds)
        self.assertEqual(len(r["submitted"]), c3.MAX_IN_FLIGHT)
        self.assertEqual(r["collected"], [])
        self.assertFalse([c for c in cds.calls if c[0] == "download"])
        # Forecasts newest first, ECMWF first: the queue order SYSTEMS gives.
        self.assertEqual([s["request"] for s in r["submitted"]], [f"fc/{s}/2026-10" for s in list(c3.SYSTEMS)[:4]])
        self.assertIsNone(r["lagDays"])
        self.assertEqual(self.metrics.published, [])  # nothing held: nothing to publish (the alarm breaches)
        rs = self.drain(cds, runs=3)
        self.assertEqual(sum(len(x["collected"]) for x in [r, *rs]), len(c3.SYSTEMS))
        self.assertEqual(rs[-1]["lagDays"], (TODAY - dt.date(2026, 10, 1)).days)
        self.assertEqual(self.metrics.published[-1], ("c3s", 27))
        # Done: a further run asks the CDS for nothing new.
        n = len(cds.submits)
        self.assertEqual(self.call(cds)["submitted"], [])
        self.assertEqual(len(cds.submits), n)

    def test_a_slow_request_waits_for_a_later_run(self):
        cds = self.cds(ready_after=1)
        self.call(cds)
        r = self.call(cds)
        self.assertEqual((r["collected"], r["submitted"], r["inFlight"]), ([], [], 4))
        self.assertEqual(len(self.call(cds)["collected"]), 4)

    def test_the_array_holds_every_system_padded_to_the_largest_with_the_credit_and_centres(self):
        cds = self.cds()
        self.drain(cds)
        g, arr = open_array(self.root, "c3s/2026-10")
        self.assertEqual(tuple(arr.metadata.dimension_names), ("system", "member", "lead_day", "lat", "lon"))
        self.assertEqual(arr.shape, (9, 3, 215, 29, 32))
        self.assertEqual(g.attrs["systems"], list(c3.SYSTEMS))
        self.assertEqual(g.attrs["members"], [3, 2, 2, 2, 2, 2, 2, 2, 2])
        self.assertEqual(g.attrs["source"], "C3S seasonal-original-single-levels")
        self.assertIn("Additional licence to use non European contributions", g.attrs["licence"])
        self.assertTrue(g.attrs["credit"].startswith("Contains modified Copernicus Climate Change Service information"))
        self.assertEqual(len(g.attrs["centres"]), 8)  # ECCC's two systems are one centre
        self.assertIn("Japan Meteorological Agency (JMA)", g.attrs["centres"])
        self.assertEqual((g.attrs["init"], g.attrs["firstDay"], g.attrs["leadDays"]), ("2026-10", "2026-10-01", 215))
        self.assertEqual(arr.attrs["units"], "mm/day")
        data = np.asarray(arr[:])
        s = g.attrs["systems"].index("ukmo-604")
        np.testing.assert_allclose(data[s, 1, :LEADS], expected("ukmo-604", 2026, 1), atol=1e-3)
        self.assertTrue(np.isnan(data[s, 2]).all())  # padding: ukmo has 2 members, ecmwf 3
        np.testing.assert_allclose(data[0, 2, :LEADS], expected("ecmwf-51", 2026, 2), atol=1e-3)

    def test_each_request_is_a_manifest_file_and_the_index_lists_what_is_held(self):
        self.drain(self.cds())
        m = manifest.read(self.mirror, "c3s/2026-10")
        self.assertEqual(len(m["files"]), 9)
        self.assertIn("cds://seasonal-original-single-levels/total_precipitation/ecmwf-51/2026-10", [f["url"] for f in m["files"]])
        self.assertEqual(m["years"], {"first": 2026, "last": 2027})
        self.assertEqual(m["grid"]["step"], 1.0)
        self.assertEqual(m["region"], grid.SEASONAL_REGION)
        self.assertEqual(c3.read_index(self.mirror)["inits"]["2026-10"], list(c3.SYSTEMS))

    def test_a_forecast_collected_again_with_other_values_is_a_new_revision(self):
        self.drain(self.cds())
        st, _ = c3.read_state(self.mirror)
        # The operator cleared the index and state (a lost copy of the state): it is asked for again.
        (self.root / c3.INDEX_KEY).unlink()
        (self.root / c3.state_key()).unlink()
        self.drain(self.cds(variant="revised"))
        m = manifest.read(self.mirror, "c3s/2026-10")
        self.assertEqual(m["revision"], 2)
        self.assertEqual(m["changes"][0]["days"], ["2026-10-01", "2027-05-03"])
        # Only ecmwf-51's values changed; the others came back the same.
        self.assertEqual(len(m["changes"]), 1)

    def test_catches_up_a_missed_month_but_not_further(self):
        cds = self.cds()
        self.clock = Clock(dt.datetime(2026, 7, 20, tzinfo=dt.UTC))
        self.drain(cds)
        self.clock = Clock(NOW)  # August's, September's and October's are out; July is held
        r = self.call(cds)
        asked = {s["request"].split("/")[2] for s in r["submitted"]}
        self.assertEqual(asked, {"2026-10"})  # newest first; September waits for a slot
        self.drain(cds, runs=8)
        idx = c3.read_index(self.mirror)
        # September fills the gap after July; August is past CATCH_UP_INITS (a backfill's, were it wanted).
        self.assertEqual(sorted(idx["inits"]), ["2026-07", "2026-09", "2026-10"])


class Failures(Base):
    def test_a_failed_request_backs_off_and_gives_up_after_max_attempts(self):
        cds = self.cds(fail={"fc/ecmwf-51/2026-10"})
        self.call(cds)
        r = self.call(cds)
        self.assertEqual([f["request"] for f in r["failed"]], ["fc/ecmwf-51/2026-10"])
        st, _ = c3.read_state(self.mirror)
        e = st["requests"]["fc/ecmwf-51/2026-10"]
        self.assertEqual(e["attempts"], 1)
        self.assertEqual(e["retryAt"], "2026-10-29T14:00:00Z")
        # Not before retryAt, though slots are free.
        self.assertNotIn("fc/ecmwf-51/2026-10", [s["request"] for s in self.call(cds)["submitted"]])
        e["attempts"] = c3.MAX_ATTEMPTS
        e["retryAt"] = None
        c3.write_state(self.mirror, st)
        with self.assertRaises(c3.RequestsFailed):
            self.call(cds)

    def test_a_refusal_stops_the_run_for_the_day(self):
        cds = self.cds(refuse=403)
        with self.assertRaises(polite.StopRun):
            self.call(cds)
        self.assertEqual(self.mirror.read_json("ingest-state/c3s/refused.json")["status"], 403)
        ok = self.cds()
        with self.assertRaises(polite.StopRun):
            self.call(ok)
        self.assertEqual(ok.calls, [])  # nothing asked again that day

    def test_a_lost_state_adopts_the_request_already_queued(self):
        cds = self.cds(ready_after=5)
        self.call(cds)
        (self.root / c3.state_key()).unlink()
        r = self.call(cds)
        self.assertEqual(len(cds.submits), 4)  # adopted, not submitted again
        self.assertEqual(len(r["submitted"]), 4)
        self.assertTrue([c for c in cds.calls if c[0] == "find"])

    def test_a_bad_event_is_refused(self):
        for ev in [
            {"product": "c3s", "mode": "monthly", "month": "10"},
            {"product": "c3s", "mode": "backfill"},
            {"product": "c3s", "mode": "backfill", "month": "2026-10"},
            {"product": "c3s", "mode": "backfill", "month": "13"},
            {"product": "c3s", "mode": "backfill", "month": "10", "system": "ecmwf-50"},
            {"product": "c3s", "mode": "daily"},
            {"product": "c3s", "mode": "monthly", "days": 3},
        ]:
            with self.assertRaises(c3.BadEvent, msg=ev):
                c3.validate_event(ev)
        self.assertEqual(c3.validate_event({"product": "c3s", "mode": "backfill", "month": "03"})["system"], None)


class Hindcast(Base):
    def test_a_backfill_copies_one_init_months_hindcast_and_records_its_years(self):
        cds = self.cds(years=[1993, 1994])
        r = self.call(cds, mode="backfill", month="03", system="ncep-2")
        self.assertEqual([s["request"] for s in r["submitted"]], ["hc/ncep-2/03"])
        self.call(cds)  # the daily run collects it (and asks for the forecasts)
        g, arr = open_array(self.root, "c3s-hc/ncep-2/03")
        self.assertEqual(tuple(arr.metadata.dimension_names), ("year", "member", "lead_day", "lat", "lon"))
        self.assertEqual(arr.shape, (2, 2, 215, 29, 32))
        self.assertEqual((g.attrs["years"], g.attrs["initMonth"], g.attrs["system"]), ([1993, 1994], 3, "ncep-2"))
        self.assertEqual(g.attrs["centres"], ["NOAA National Centers for Environmental Prediction (NCEP)"])
        np.testing.assert_allclose(np.asarray(arr[1, 0, :LEADS]), expected("ncep-2", 1994, 0), atol=1e-3)
        m = manifest.read(self.mirror, "c3s-hc/ncep-2/03")
        self.assertEqual(m["years"], {"first": 1993, "last": 1994})
        self.assertEqual([f["url"] for f in m["files"]], ["cds://seasonal-original-single-levels/total_precipitation/ncep-2/hindcast/03"])
        self.assertEqual(c3.read_index(self.mirror)["hindcasts"], {"ncep-2": ["03"]})

    def test_a_backfill_for_every_system_is_drained_by_the_daily_runs_after_the_forecasts(self):
        cds = self.cds(years=[1993])
        self.call(cds, mode="backfill", month="11")
        st, _ = c3.read_state(self.mirror)
        self.assertEqual(sum(1 for k, e in st["requests"].items() if k.startswith("hc/") and e["wanted"]), 9)
        self.drain(cds, runs=8)
        self.assertEqual(len(c3.read_index(self.mirror)["hindcasts"]), 9)


class Manifests(unittest.TestCase):
    def good(self, product, url):
        m = manifest.new(product)
        m["years"] = {"first": 2026, "last": 2027}
        m["files"] = [{"url": url, "etag": None, "lastModified": None, "size": 1, "valuesSha256": "0" * 64, "revision": 1, "fetchedAt": "2026-10-28T14:00:00Z"}]
        return m

    def test_a_c3s_file_is_its_products_request_and_nothing_else(self):
        base = "cds://seasonal-original-single-levels/total_precipitation"
        manifest.validate(self.good("c3s/2026-10", f"{base}/ecmwf-51/2026-10"))
        manifest.validate(self.good("c3s-hc/ecmwf-51/10", f"{base}/ecmwf-51/hindcast/10"))
        for product, url in [
            ("c3s/2026-10", f"{base}/ecmwf-51/2026-09"),
            ("c3s/2026-10", f"{base}/ecmwf-51/hindcast/10"),
            ("c3s-hc/ecmwf-51/10", f"{base}/ukmo-604/hindcast/10"),
            ("c3s-hc/ecmwf-51/10", f"{base}/ecmwf-51/hindcast/11"),
            ("c3s/2026-10", "https://example.org/x.grib"),
        ]:
            with self.assertRaises(ValueError, msg=(product, url)):
                manifest.validate(self.good(product, url))
        m = self.good("c3s/2026-10", f"{base}/ecmwf-51/2026-10")
        m["finalThrough"] = "2026-10-05"
        with self.assertRaisesRegex(ValueError, "no final or preliminary"):
            manifest.validate(m)
        m = self.good("c3s/2026-10", f"{base}/ecmwf-51/2026-10")
        m["files"][0]["etag"] = '"x"'
        with self.assertRaisesRegex(ValueError, "etag"):
            manifest.validate(m)
        m = self.good("c3s/2026-10", f"{base}/ecmwf-51/2026-10")
        m["grid"]["step"] = 0.1
        with self.assertRaisesRegex(ValueError, "grid.step"):
            manifest.validate(m)


class Handler(Base):
    def test_lambda_handler_hands_c3s_events_to_the_job(self):
        with unittest.mock.patch.object(c3, "_fake", lambda v, t: fakecds.FakeC3sCds(today=t, leads=2)):
            r = lambda_handler.handler({"product": "c3s", "mode": "monthly"}, metrics=self.metrics, clock=self.clock, today=lambda: TODAY)
        self.assertEqual((r["product"], r["mode"], r["source"], len(r["submitted"])), ("c3s", "monthly", "fixtures", 4))

    def test_publishes_the_lag_on_a_failure_too(self):
        self.drain(self.cds())
        before = len(self.metrics.published)
        self.clock = Clock(dt.datetime(2026, 11, 12, tzinfo=dt.UTC))  # November's inits are due: the run asks, and is refused
        with self.assertRaises(polite.StopRun):
            self.call(self.cds(refuse=401))
        self.assertEqual(self.metrics.published[before:], [("c3s", 27)])

    def test_the_credit_is_the_engines(self):
        # The app's credit (packages/engine/src/liability/rainCredits.ts) says the same words and names the same centres.
        ts = (HERE.parent / "packages" / "engine" / "src" / "liability" / "rainCredits.ts").read_text().replace("\t", " ")
        self.assertIn("Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.", ts)
        self.assertIn(c3.CITATION, ts)
        for name in c3srequest.CENTRE_NAMES.values():
            self.assertIn(f"'{name}'", ts)


if __name__ == "__main__":
    unittest.main()
