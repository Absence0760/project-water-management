"""ecmwf.py: the ECMWF ENS forecast into the copy (issue #604 R4-C). No
network: the fixture opener (ecmwf_fixturehttp.py) serves the committed
synthetic step files, and the structured tests write their own.

    ingest/.venv/bin/python -m unittest test_ecmwf
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
sys.path.insert(0, str(HERE / "fixtures" / "ecmwf"))

import cloudwatch  # noqa: E402
import ecmwf  # noqa: E402
import ecmwf_fixturehttp  # noqa: E402
import lambda_handler  # noqa: E402
import lease  # noqa: E402
import make_ecmwf_fixtures as fx  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402

TODAY = dt.date(2026, 10, 27)
NOW = "2026-10-27T10:00:00Z"


def client(opener):
    return polite.PoliteClient(min_interval=0.0, opener=opener)


class Context:
    """A Lambda context whose time left drops to `then` seconds after `calls` asks."""

    def __init__(self, calls: int, then: float = 30.0, first: float = 900.0):
        self.calls, self.then, self.first, self.n = calls, then, first, 0

    def get_remaining_time_in_millis(self):
        self.n += 1
        return int((self.first if self.n <= self.calls else self.then) * 1000)


def expected_issue_stats():
    """The committed fixture's statistics, the same in every cell: (stats, days)."""
    m = np.array([[fx.fixture_daily_mm(k, d) for d in range(15)] for k in range(1, fx.FIXTURE_MEMBERS + 1)])
    return np.stack([m.mean(0), np.quantile(m, 0.1, axis=0), np.quantile(m, 0.5, axis=0), np.quantile(m, 0.9, axis=0)])


class Index(unittest.TestCase):
    def setUp(self):
        self.text = (fx.HERE / fx.name(fx.FIXTURE_ISSUE, 48, "index")).read_text()

    def test_tp_fields_only_sorted_by_member(self):
        got = ecmwf.tp_fields(self.text, fx.FIXTURE_ISSUE, 48)
        self.assertEqual([f.member for f in got], [1, 2, 3, 4])
        recs = [json.loads(line) for line in self.text.splitlines()]
        tp = {int(r["number"]): (r["_offset"], r["_length"]) for r in recs if r["param"] == "tp"}
        self.assertEqual({f.member: (f.offset, f.length) for f in got}, tp)
        self.assertGreater(sum(r["param"] == "2t" for r in recs), 0)  # control: there was something to skip

    def test_ranges_are_the_tp_messages(self):
        blob = (fx.HERE / fx.name(fx.FIXTURE_ISSUE, 48, "grib2")).read_bytes()
        for f in ecmwf.tp_fields(self.text, fx.FIXTURE_ISSUE, 48):
            msg = blob[f.offset : f.offset + f.length]
            self.assertEqual(msg[:4], b"GRIB")
            self.assertEqual(msg[-4:], b"7777")
            values, _ = ecmwf.decode_field(msg, fx.FIXTURE_ISSUE, 48, f.member)
            self.assertAlmostEqual(float(values[0, 0]), fx.cum_fixture_m(f.member, 48), places=6)

    def test_refuses_another_run_or_step_or_a_member_twice(self):
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "another run or step"):
            ecmwf.tp_fields(self.text, fx.FIXTURE_ISSUE, 72)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "another run or step"):
            ecmwf.tp_fields(self.text, fx.FIXTURE_ISSUE + dt.timedelta(days=1), 48)
        line = next(x for x in self.text.splitlines() if '"tp"' in x)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "two tp fields"):
            ecmwf.tp_fields(self.text + line + "\n", fx.FIXTURE_ISSUE, 48)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "not JSON"):
            ecmwf.tp_fields("{nope\n", fx.FIXTURE_ISSUE, 48)


class Decode(unittest.TestCase):
    # A regional 0.1 deg grid wider than D1, north first, as a structured field.
    GRID = {"ni": 331, "nj": 291, "lat1": -6.5, "lon1": 9.0, "lat2": -35.5 - 0.5, "lon2": 42.0, "step": 0.1}

    def field(self, fn):
        lats = self.GRID["lat1"] - np.arange(self.GRID["nj"]) * 0.1
        lons = self.GRID["lon1"] + np.arange(self.GRID["ni"]) * 0.1
        return fn(lats[:, None], lons[None, :])

    def test_cells_are_the_corner_mean_at_0_1_deg(self):
        lin = lambda lat, lon: 0.001 * (lat + 40.0) + 0.0005 * lon  # noqa: E731  linear: the corner mean is the centre value
        msg = fx.message(TODAY, 24, 1, self.field(lin), self.GRID)
        values, g = ecmwf.decode_field(msg, TODAY, 24, 1)
        cells = ecmwf.region_cells(values, g)
        self.assertEqual(cells.shape, (ecmwf.ROWS, ecmwf.COLS))
        # Row 0 is the south-west cell, centred at -35.45, 10.05; rows grow northwards.
        for r, c in [(0, 0), (0, 309), (274, 0), (274, 309), (137, 155)]:
            lat, lon = ecmwf.ORIGIN["lat"] + r * 0.1, ecmwf.ORIGIN["lon"] + c * 0.1
            self.assertAlmostEqual(float(cells[r, c]), lin(lat, lon), places=6, msg=(r, c))

    def test_a_single_wet_point_shares_into_its_four_cells(self):
        def spike(lat, lon):
            return np.where((np.abs(lat + 20.0) < 1e-6) & (np.abs(lon - 25.0) < 1e-6), 0.004, 0.0)

        values, g = ecmwf.decode_field(fx.message(TODAY, 24, 1, self.field(spike), self.GRID), TODAY, 24, 1)
        cells = ecmwf.region_cells(values, g)
        # Point (-20.0, 25.0) is the corner of cells rows 154–155, cols 149–150.
        wet = np.argwhere(cells > 0)
        self.assertEqual(sorted(map(tuple, wet)), [(154, 149), (154, 150), (155, 149), (155, 150)])
        self.assertTrue(np.allclose(cells[cells > 0], 0.001, atol=1e-6))

    def test_longitudes_wrap(self):
        g = ecmwf.LatLonGrid(ni=3600, nj=1801, lat1=90.0, lon1=-180.0, di=0.1, dj=0.1, j_south=False)
        self.assertEqual(g.col(10.0), 1900)
        self.assertEqual(g.row(-35.5), 1255)
        g0 = ecmwf.LatLonGrid(ni=3600, nj=1801, lat1=90.0, lon1=0.0, di=0.1, dj=0.1, j_south=False)
        self.assertEqual(g0.col(41.0), 410)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "not a point"):
            ecmwf.LatLonGrid(ni=1440, nj=721, lat1=90.0, lon1=0.0, di=0.25, dj=0.25, j_south=False).row(-35.4)

    def test_a_grid_that_misses_the_region_fails(self):
        small = {**self.GRID, "lat2": -30.0, "nj": 366 - 300}
        small["nj"] = int(round((small["lat1"] - small["lat2"]) / 0.1)) + 1
        values, g = ecmwf.decode_field(fx.message(TODAY, 24, 1, 0.0, small), TODAY, 24, 1)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "outside"):
            ecmwf.region_cells(values, g)

    def test_refuses_the_wrong_field(self):
        for msg, why in [
            (fx.message(TODAY, 24, 1, 280.0, self.GRID, short="2t"), "holds 2t"),
            (fx.message(TODAY, 48, 1, 0.0, self.GRID), "accumulated over 0-48"),
            (fx.message(TODAY, 24, 2, 0.0, self.GRID), "member 2"),
            (fx.message(TODAY - dt.timedelta(days=1), 24, 1, 0.0, self.GRID), "run"),
        ]:
            with self.subTest(why), self.assertRaisesRegex(ecmwf.EcmwfFormatError, why):
                ecmwf.decode_field(msg, TODAY, 24, 1)


class Daily(unittest.TestCase):
    def test_deaccumulates_to_mm(self):
        a = np.array([[[0.001, 0.0]]], dtype=np.float32)
        b = np.array([[[0.0035, 0.0]]], dtype=np.float32)
        self.assertTrue(np.allclose(ecmwf.daily_mm(None, a, 0), [[[1.0, 0.0]]], atol=1e-4))
        self.assertTrue(np.allclose(ecmwf.daily_mm(a, b, 1), [[[2.5, 0.0]]], atol=1e-4))

    def test_round_off_below_zero_is_zero_and_a_real_drop_fails(self):
        a = np.array([[[0.01]]], dtype=np.float32)
        self.assertEqual(float(ecmwf.daily_mm(a, a - np.float32(0.00005), 3)[0, 0, 0]), 0.0)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "falls"):
            ecmwf.daily_mm(a, a - np.float32(0.001), 3)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "over 2000"):
            ecmwf.daily_mm(None, np.array([[[2.5]]], dtype=np.float32), 0)
        with self.assertRaisesRegex(ecmwf.EcmwfFormatError, "missing"):
            ecmwf.daily_mm(None, np.array([[[np.nan]]], dtype=np.float32), 0)

    def test_stats(self):
        members = np.arange(1, 51, dtype=np.float64).reshape(50, 1, 1)
        s = ecmwf.stats(members)
        self.assertEqual(s.shape, (4, 1, 1))
        self.assertAlmostEqual(float(s[0, 0, 0]), 25.5)
        self.assertAlmostEqual(float(s[1, 0, 0]), np.quantile(np.arange(1, 51), 0.1), places=4)
        self.assertAlmostEqual(float(s[2, 0, 0]), 25.5)
        self.assertAlmostEqual(float(s[3, 0, 0]), np.quantile(np.arange(1, 51), 0.9), places=4)


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mirror = zarrstore.LocalMirror(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def go(self, today=TODAY, opener=None, context=None, metrics=None):
        self.opener = opener or ecmwf_fixturehttp.EcmwfFixtureOpener()
        self.metrics = metrics or cloudwatch.LocalSink()
        return ecmwf.handle({"product": "ecmwf", "mode": "daily"}, context, mirror=self.mirror, live=False, opener=self.opener, metrics=self.metrics, today=today)

    def test_only_the_step_files_it_writes_count_as_held(self):
        prefix = ecmwf.work_prefix(TODAY)
        for name in ("step-24.npy", "step-48.npy", "step-24.npy.tmp", "step-x.npy", "step-.npy", "step-25.npy", "notes.json"):
            ecmwf._put(self.mirror, prefix + name, b"")
        self.assertEqual(ecmwf._steps_held(self.mirror, TODAY), {24, 48})  # 25 isn't one of STEPS

    def test_copies_the_issue_whole_with_its_stats_manifest_and_index(self):
        r = self.go()
        self.assertEqual((r["stopped"], r["copied"], r["lagDays"]), ("copied", TODAY.isoformat(), 0))
        # The last step's index first (is the issue out?), then per step its index and one range per member.
        self.assertEqual(r["requests"], 1 + 15 * (1 + fx.FIXTURE_MEMBERS))
        ranged = [h for _, h in self.opener.requests if "Range" in h]
        self.assertEqual(len(ranged), 15 * fx.FIXTURE_MEMBERS)
        got = np.stack([ecmwf.read_issue(self.root, TODAY, s) for s in ecmwf.STATS])  # (stats, days, rows, cols)
        want = expected_issue_stats()
        self.assertEqual(got.shape, (4, 15, ecmwf.ROWS, ecmwf.COLS))
        for r_, c_ in [(0, 0), (274, 309), (100, 200)]:
            self.assertTrue(np.allclose(got[:, :, r_, c_], want, atol=1e-3), (r_, c_))
        attrs = json.loads((self.root / "ecmwf" / TODAY.isoformat() / "zarr.json").read_text())
        self.assertEqual(attrs["shape"], [4, 15, 275, 310])
        self.assertEqual(attrs["chunk_grid"]["configuration"]["chunk_shape"], [1, 1, 55, 62])
        self.assertEqual(attrs["dimension_names"], ["stat", "day", "lat", "lon"])
        self.assertEqual(attrs["attributes"]["grid"], {"origin": {"lat": -35.45, "lon": 10.05}, "step": 0.1})
        self.assertEqual(attrs["attributes"]["firstDay"], TODAY.isoformat())
        self.assertEqual(attrs["attributes"]["members"], fx.FIXTURE_MEMBERS)
        m = manifest.read(self.mirror, f"ecmwf/{TODAY.isoformat()}")
        self.assertEqual(len(m["files"]), 15)
        self.assertTrue(m["files"][0]["url"].endswith("20261027000000-24h-enfo-ef-sfc.grib2"))
        self.assertEqual(m["files"][3]["valuesSha256"], manifest.values_sha256(got[0, 3:4]))
        self.assertEqual(json.loads((self.root / "ecmwf/index.json").read_text()), {"issues": [TODAY.isoformat()], "archived": []})
        self.assertFalse((self.root / ecmwf.work_prefix(TODAY)).exists())  # the work is cleared
        self.assertEqual(self.metrics.published, [("ecmwf", 0)])

    def test_a_held_issue_asks_nothing(self):
        self.go()
        r = self.go()
        self.assertEqual((r["stopped"], r["requests"]), ("up_to_date", 0))
        self.assertEqual(self.metrics.published, [("ecmwf", 0)])

    def test_today_not_out_copies_yesterday_and_none_out_publishes_nothing(self):
        r = self.go(opener=ecmwf_fixturehttp.EcmwfFixtureOpener(published_through=TODAY - dt.timedelta(days=1)))
        self.assertEqual((r["copied"], r["lagDays"]), ((TODAY - dt.timedelta(days=1)).isoformat(), 1))
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mirror = zarrstore.LocalMirror(self.root)
        r = self.go(opener=ecmwf_fixturehttp.EcmwfFixtureOpener(published_through=TODAY - dt.timedelta(days=5)))
        self.assertEqual((r["stopped"], r["requests"], r["lagDays"]), ("not_published", 2, None))
        self.assertEqual(self.metrics.published, [])  # nothing held: no value (the alarm treats missing data as breaching)

    def test_a_partial_issue_is_never_listed(self):
        r = self.go(opener=ecmwf_fixturehttp.EcmwfFixtureOpener(missing_steps=(120,)))
        self.assertEqual((r["stopped"], r["copied"], r["stepsDone"]), ("partial", None, 4))
        self.assertIsNone(self.mirror.read_json("ecmwf/index.json"))
        self.assertFalse((self.root / "ecmwf" / TODAY.isoformat()).exists())

    def test_the_budget_stops_a_run_and_the_next_one_resumes(self):
        r1 = self.go(context=Context(calls=6))
        self.assertEqual((r1["stopped"], r1["stepsDone"]), ("deadline", 6))
        self.assertIsNone(r1["copied"])
        r2 = self.go()
        self.assertEqual((r2["stopped"], r2["copied"], r2["stepsDone"]), ("copied", TODAY.isoformat(), 15))
        # Only the 9 steps the first run hadn't done (no publication check: work was held).
        self.assertEqual(r2["requests"], 9 * (1 + fx.FIXTURE_MEMBERS))
        got = ecmwf.read_issue(self.root, TODAY, "mean")
        self.assertTrue(np.allclose(got[:, 10, 10], expected_issue_stats()[0], atol=1e-3))

    def test_no_time_to_finish_leaves_the_steps_for_the_next_run(self):
        r = self.go(context=Context(calls=15))  # every step, then too little time to write the issue
        self.assertEqual((r["stopped"], r["stepsDone"]), ("deadline", 15))
        r2 = self.go()
        self.assertEqual((r2["stopped"], r2["requests"]), ("copied", 0))

    def test_keeps_seven_and_archives_the_rest_as_their_mean(self):
        for back in range(8, -1, -1):
            self.go(today=TODAY - dt.timedelta(days=back))
        idx = json.loads((self.root / "ecmwf/index.json").read_text())
        self.assertEqual(idx["issues"], [(TODAY - dt.timedelta(days=b)).isoformat() for b in range(7)])
        self.assertEqual(idx["archived"], [(TODAY - dt.timedelta(days=b)).isoformat() for b in (7, 8)])
        old = self.root / "ecmwf" / (TODAY - dt.timedelta(days=8)).isoformat()
        self.assertTrue((old / "c" / "0").exists())
        for i in (1, 2, 3):
            self.assertFalse((old / "c" / str(i)).exists())
        self.assertTrue((self.root / "ecmwf" / TODAY.isoformat() / "c" / "3").exists())  # control: a held issue keeps all four
        self.assertTrue(np.allclose(ecmwf.read_issue(self.root, (TODAY - dt.timedelta(days=8)).isoformat())[:, 0, 0], expected_issue_stats()[0], atol=1e-3))

    def probe_503(self, times: int):
        """An opener whose publication probe (the last step's index) answers 503 `times` times, as S3 did on 2026-10-27."""
        import urllib.error

        probe = ecmwf.file_url(TODAY, ecmwf.STEPS[-1], "index")
        inner = ecmwf_fixturehttp.EcmwfFixtureOpener()
        left = [times]

        def opener(req, timeout=None):
            if req.full_url == probe and left[0] > 0:
                left[0] -= 1
                inner.requests.append((req.full_url, {}))
                raise urllib.error.HTTPError(req.full_url, 503, "Slow Down", ecmwf_fixturehttp._headers({}), None)
            return inner(req, timeout)

        return opener, inner

    def test_a_503_on_the_publication_probe_is_retried_with_backoff(self):
        opener, inner = self.probe_503(2)
        slept: list[float] = []
        r = ecmwf.handle({"product": "ecmwf", "mode": "daily"}, None, mirror=self.mirror, live=False, opener=opener, metrics=cloudwatch.LocalSink(), today=TODAY, sleep=slept.append)
        self.assertEqual(r["stopped"], "copied")
        self.assertEqual(slept, [30.0, 60.0])  # polite.PoliteClient's default backoff, doubling
        self.assertEqual(r["requests"], 2 + 1 + 15 * (1 + fx.FIXTURE_MEMBERS))

    def test_a_503_that_persists_on_the_probe_fails_the_run_after_three_retries_and_writes_nothing(self):
        opener, inner = self.probe_503(10)
        slept: list[float] = []
        with self.assertRaises(polite.RetryLater):
            ecmwf.handle({"product": "ecmwf", "mode": "daily"}, None, mirror=self.mirror, live=False, opener=opener, metrics=cloudwatch.LocalSink(), today=TODAY, sleep=slept.append)
        self.assertEqual(len(inner.requests), 4)  # the probe and 3 retries
        self.assertEqual(slept, [30.0, 60.0, 120.0])
        self.assertIsNone(self.mirror.read_json("ecmwf/index.json"))
        self.assertIsNone(self.mirror.read_json("ecmwf/refused.json"))  # not a refusal: the next scheduled run asks again

    def test_a_403_stops_writes_the_marker_and_the_day_asks_nothing_more(self):
        self.go(today=TODAY - dt.timedelta(days=1))  # something held, so the lag has a value
        refuse = ecmwf_fixturehttp.EcmwfFixtureOpener(refuse=True)
        with unittest.mock.patch.object(manifest, "utc_now", return_value=NOW), self.assertRaises(polite.StopRun):
            ecmwf.handle({"product": "ecmwf", "mode": "daily"}, None, mirror=self.mirror, live=False, opener=refuse, metrics=self.metrics, today=TODAY)
        self.assertEqual(len(refuse.requests), 1)  # never retried
        self.assertEqual(self.mirror.read_json("ecmwf/refused.json"), {"v": 1, "at": NOW})
        self.assertEqual(self.metrics.published, [("ecmwf", 0), ("ecmwf", 1)])  # published on the way out
        r = self.go(opener=ecmwf_fixturehttp.EcmwfFixtureOpener(refuse=True), metrics=self.metrics)
        self.assertEqual((r["stopped"], r["requests"], r["refusedAt"]), ("refused_today", 0, NOW))
        self.assertEqual(self.metrics.published[-1], ("ecmwf", 1))
        # The next UTC day tries again.
        r = self.go(today=TODAY + dt.timedelta(days=1))
        self.assertEqual(r["stopped"], "copied")

    def test_another_run_holding_the_lease_is_left_alone(self):
        self.go(today=TODAY - dt.timedelta(days=2))
        with lease.hold(self.mirror, "ecmwf"):
            r = self.go()
        self.assertEqual((r["stopped"], r["requests"], r["lagDays"]), ("busy", 0, 2))
        self.assertEqual(self.metrics.published, [("ecmwf", 2)])
        self.assertEqual(self.go()["stopped"], "copied")  # control: released, the next run works

    def test_a_bad_file_fails_the_run_and_still_publishes(self):
        self.go(today=TODAY - dt.timedelta(days=1))
        with unittest.mock.patch.object(ecmwf, "daily_mm", side_effect=ecmwf.EcmwfFormatError("day 0 has 9999 mm")), self.assertRaises(ecmwf.EcmwfFormatError):
            self.go()
        self.assertEqual(self.metrics.published, [("ecmwf", 1)])

    def test_sweeps_old_work_and_unlisted_arrays(self):
        stale = TODAY - dt.timedelta(days=3)
        self.go(today=stale, context=Context(calls=2))  # leaves work for an issue three days ago
        self.assertTrue((self.root / ecmwf.work_prefix(stale)).exists())
        ecmwf.write_issue(self.mirror, TODAY - dt.timedelta(days=4), np.zeros((4, 15, ecmwf.ROWS, ecmwf.COLS), np.float32), 4)
        r = self.go()
        self.assertFalse((self.root / ecmwf.work_prefix(stale)).exists())
        self.assertFalse((self.root / "ecmwf" / (TODAY - dt.timedelta(days=4)).isoformat()).exists())
        self.assertIn((TODAY - dt.timedelta(days=4)).isoformat(), r["swept"])
        self.assertTrue((self.root / "ecmwf" / TODAY.isoformat()).exists())

    def test_through_s3(self):
        s3 = FakeS3()
        self.mirror = zarrstore.S3Mirror(s3, "bucket", "")
        r = self.go()
        self.assertEqual(r["stopped"], "copied")
        keys = s3.keys("bucket")
        self.assertIn("ecmwf/index.json", keys)
        self.assertIn(f"ecmwf/{TODAY.isoformat()}/zarr.json", keys)
        self.assertIn("ecmwf/zarr.json", keys)
        self.assertFalse(any(k.startswith("ingest-state/ecmwf/work/") for k in keys))
        self.assertNotIn("ingest-state/ecmwf/lease.json", keys)  # released
        self.assertEqual(sum(k.startswith(f"ecmwf/{TODAY.isoformat()}/c/") for k in keys), 4 * 15 * 25)


class Handler(unittest.TestCase):
    def test_routes_the_event_and_refuses_another_shape(self):
        with tempfile.TemporaryDirectory() as tmp, unittest.mock.patch.dict(os.environ, {"MIRROR_URL": Path(tmp).as_uri(), "FEED_SOURCE": "fixtures"}):
            sink = cloudwatch.LocalSink()
            r = lambda_handler.handler({"product": "ecmwf", "mode": "daily"}, metrics=sink, today=lambda: TODAY)
            self.assertEqual((r["stopped"], r["source"]), ("copied", "fixtures"))
            self.assertEqual(sink.published, [("ecmwf", 0)])
            for ev in [{"product": "ecmwf"}, {"product": "ecmwf", "mode": "monthly"}, {"product": "ecmwf", "mode": "daily", "month": "2026-01"}]:
                with self.subTest(ev), self.assertRaises(ecmwf.BadEvent):
                    lambda_handler.handler(ev)
            with self.assertRaises(lambda_handler.BadEvent):  # control: the finals' validation is unchanged
                lambda_handler.handler({"product": "nope", "mode": "daily"})



class Shipping(unittest.TestCase):
    def test_the_image_copies_the_ecmwf_job_and_its_imports_but_no_test_code(self):
        import re
        import shutil
        import subprocess

        files = [f for ln in (HERE / "Dockerfile").read_text().splitlines() if ln.startswith("COPY ") for f in re.findall(r"(\S+\.py)", ln)]
        self.assertIn("ecmwf.py", files)
        self.assertNotIn("ecmwf_fixturehttp.py", files)
        self.assertNotIn("ecmwf_qm_fit.py", files)
        with tempfile.TemporaryDirectory() as tmp:
            for f in files:
                shutil.copy(HERE / f, tmp)
            p = subprocess.run([sys.executable, "-E", "-s", "-c", "import lambda_handler, ecmwf"], cwd=tmp, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_the_committed_fixture_matches_its_generator(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx.main(Path(tmp))
            made = sorted(p.name for p in Path(tmp).iterdir())
            committed = sorted(p.name for p in fx.HERE.iterdir() if p.suffix in (".grib2", ".index"))
            self.assertEqual(made, committed)
            self.assertEqual(len(made), 30)
            for name in made:
                self.assertEqual((Path(tmp) / name).read_bytes(), (fx.HERE / name).read_bytes(), name)


if __name__ == "__main__":
    unittest.main()
