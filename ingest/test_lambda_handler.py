"""lambda_handler.py: the event shape, the single-file path (ingest_file), and
the fixtures-mode run end to end into a temp copy. The monthly/backfill logic
itself (listing, pacing, budget, 403, the metric on every exit) is in
test_chirps_final.py.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import datetime as dt
import os
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures"))

import chcnetcdf  # noqa: E402
import chirps_final  # noqa: E402
import grid  # noqa: E402
import json  # noqa: E402
import lease  # noqa: E402
import polite  # noqa: E402
import lambda_handler  # noqa: E402
import make_chc_fixture as fx  # noqa: E402
sys.path.insert(0, str(HERE / "fixtures" / "chirps"))
import make_chirps_fixtures as chirps_fx  # noqa: E402
import manifest  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402

FIXTURE = HERE / "fixtures" / "chc" / fx.NAME
# A backfill execution as the state machine names it ($$.Execution.Id).
EXECUTION = "arn:aws:states:af-south-1:000000000000:execution:water-management-mirror-backfill:run-1"
OTHER_EXECUTION = "arn:aws:states:af-south-1:000000000000:execution:water-management-mirror-backfill:run-2"


def month_slice(first_day: dt.date, days: int = 3, bump: float = 0.0) -> chcnetcdf.RegionSlice:
    """The fixture's values moved to other days (the last `days` of a month)."""
    v = fx.region_values()[:days].copy()
    v[~np.isnan(v)] += np.float32(bump)
    return chcnetcdf.RegionSlice(first_day=first_day, values=v)


class Event(unittest.TestCase):
    def test_valid_events(self):
        self.assertEqual(lambda_handler.validate_event({"product": "rnl", "mode": "monthly"}), {"product": "rnl", "mode": "monthly", "month": None, "hold": None})
        self.assertEqual(lambda_handler.validate_event({"product": "sat", "mode": "backfill", "month": "2000-06"})["month"], "2000-06")
        self.assertEqual(lambda_handler.validate_event({"product": "rnl", "mode": "backfill", "month": "1981-01"})["month"], "1981-01")
        # The state machine's month: its execution's hold rides along (infra/ingest_backfill.tf).
        hold = {"execution": EXECUTION, "pauseSeconds": 60}
        self.assertEqual(lambda_handler.validate_event({"product": "rnl", "mode": "backfill", "month": "1981-01", "hold": hold})["hold"], hold)
        self.assertEqual(lambda_handler.validate_release({"mode": "release_hold", "hold": {"execution": EXECUTION}}), {"execution": EXECUTION})

    def test_invalid_events(self):
        for ev in [
            None,
            [],
            {"product": "rnl"},
            {"mode": "monthly"},
            {"product": "prelim", "mode": "monthly"},
            {"product": "rnl", "mode": "daily"},
            {"product": "rnl", "mode": "backfill", "month": "2024-13"},
            {"product": "rnl", "mode": "backfill", "month": "2024-6"},
            {"product": "rnl", "mode": "backfill", "month": 202406},
            {"product": "rnl", "mode": "monthly", "extra": 1},
            {"product": "rnl", "mode": "backfill"},  # a backfill names its month
            {"product": "rnl", "mode": "monthly", "month": "2024-02"},  # a monthly run takes none
            {"product": "sat", "mode": "backfill", "month": "2000-05"},  # before sat's first file
            {"product": "rnl", "mode": "backfill", "month": "1980-12"},
            # A hold: only on a backfill, exactly an execution id and whole seconds of pause.
            {"product": "rnl", "mode": "monthly", "hold": {"execution": EXECUTION, "pauseSeconds": 60}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": EXECUTION}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": EXECUTION, "pauseSeconds": 60, "x": 1}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": "a b", "pauseSeconds": 60}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": "", "pauseSeconds": 60}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": "x:", "pauseSeconds": 60}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": EXECUTION, "pauseSeconds": 60.5}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": EXECUTION, "pauseSeconds": True}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": {"execution": EXECUTION, "pauseSeconds": 3601}},
            {"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": EXECUTION},
        ]:
            with self.assertRaises(lambda_handler.BadEvent, msg=repr(ev)):
                lambda_handler.validate_event(ev)

    def test_invalid_releases(self):
        for ev in [
            {"mode": "release_hold"},
            {"mode": "release_hold", "hold": {}},
            {"mode": "release_hold", "hold": {"execution": EXECUTION, "pauseSeconds": 60}},
            {"mode": "release_hold", "hold": {"execution": "a b"}},
            {"mode": "release_hold", "hold": {"execution": EXECUTION}, "product": "rnl"},
        ]:
            with self.assertRaises(lambda_handler.BadEvent, msg=repr(ev)):
                lambda_handler.validate_release(ev)


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
        out = lambda_handler.handler({"product": "rnl", "mode": "monthly"}, None)
        self.assertEqual(out["revision"], 1)
        self.assertEqual(out["finalThrough"], "2024-02-29")
        self.assertEqual([f["outcome"] for f in out["files"]], ["added", "added"])

        import zarr

        a = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="rnl", mode="r")
        feb = chirps_fx.month_values(2024, 2)
        # 29 Feb 2024 (the file's day 2) at doy index 59 of year index 43, south-west corner.
        self.assertEqual(a[43, 59, 0, 0], feb[2, 0, 0])
        self.assertEqual(a[43, 57, 100, 350], feb[0, 100, 350])
        self.assertEqual(a[43, 30, 100, 350], chirps_fx.month_values(2024, 1)[2, 100, 350])  # 31 Jan
        self.assertTrue(np.isnan(a[43, 60, 0, 0]))

        m = manifest.loads((self.root / "rnl" / "manifest.json").read_text())
        self.assertEqual(m["years"], {"first": 2024, "last": 2024})
        self.assertEqual([f["url"] for f in m["files"]], [chirps_final.file_url("rnl", 2024, 1), chirps_final.file_url("rnl", 2024, 2)])
        self.assertEqual(m["files"][1]["valuesSha256"], manifest.values_sha256(feb))
        self.assertEqual(m["files"][1]["lastModified"], "Wed, 17 Apr 2024 14:05:00 GMT")
        self.assertEqual(m["changes"], [])

    def test_a_rerun_is_one_304_and_rewrites_nothing(self):
        lambda_handler.handler({"product": "sat", "mode": "monthly"})
        before = sorted(p.stat().st_mtime_ns for p in (self.root / "sat" / "c").rglob("*") if p.is_file())
        out = lambda_handler.handler({"product": "sat", "mode": "monthly"})
        self.assertEqual(out["listing"], "not-modified")
        self.assertEqual(out["files"], [])
        self.assertEqual(out["revision"], 1)
        after = sorted(p.stat().st_mtime_ns for p in (self.root / "sat" / "c").rglob("*") if p.is_file())
        self.assertEqual(before, after)  # no chunk rewritten

    def test_variants_through_the_environment(self):
        lambda_handler.handler({"product": "rnl", "mode": "monthly"})
        with unittest.mock.patch.dict(os.environ, {"INGEST_FIXTURE_VARIANT": "rewritten"}):
            out = lambda_handler.handler({"product": "rnl", "mode": "monthly"})
        self.assertEqual([(f["outcome"], f["reason"]) for f in out["files"]], [("unchanged", "changed")])
        self.assertEqual(out["revision"], 1)
        with unittest.mock.patch.dict(os.environ, {"INGEST_FIXTURE_VARIANT": "changed"}):
            out = lambda_handler.handler({"product": "rnl", "mode": "monthly"})
        self.assertEqual([f["outcome"] for f in out["files"]], ["changed"])
        self.assertEqual(out["revision"], 2)

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
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        url = f"fixture:chc/{fx.NAME}"
        lambda_handler.ingest_file(mirror, "rnl", url, FIXTURE)
        real = chcnetcdf.read_region

        def rewritten(path):
            r = real(path)
            r.values[1, 100, 350] += 1.5
            return r

        with unittest.mock.patch.object(chcnetcdf, "read_region", rewritten):
            # The run dies after the chunks went up but before the manifest did.
            with unittest.mock.patch.object(manifest, "write", side_effect=RuntimeError("Lambda timed out")):
                with self.assertRaises(RuntimeError):
                    lambda_handler.ingest_file(mirror, "rnl", url, FIXTURE)
            m = manifest.read(mirror, "rnl")
            self.assertEqual(m["revision"], 1)  # the manifest still names the old values
            with mirror.stage(zarrstore.finals_year_prefixes("rnl", fx.FIRST_DAY, fx.DAYS)) as root:
                held = zarrstore.read_finals(root, "rnl", fx.FIRST_DAY, fx.DAYS)
            self.assertEqual(held[1, 100, 350], np.float32(fx.value(1, 100, 350) + 1.5))  # ...but the new chunks are up

            out = lambda_handler.ingest_file(mirror, "rnl", url, FIXTURE)
        self.assertEqual(out["outcome"], "changed")
        m = manifest.read(mirror, "rnl")
        self.assertEqual(m["revision"], 2)
        # The old values are unknown, so the entry claims the whole region and the widest plausible difference, never 0.
        self.assertEqual(m["changes"], [{"revision": 2, "days": ["2024-02-27", "2024-02-29"], "cellsChanged": 550 * 620, "maxAbsDiff": 2000.0}])

    def test_the_same_run_through_s3(self):
        s3 = FakeS3()
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            out = lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, None, s3_client=s3)
        self.assertEqual(out["revision"], 1)
        keys = s3.keys("mirror")
        self.assertIn("rnl/manifest.json", keys)
        self.assertIn("rnl/zarr.json", keys)
        self.assertIn("rnl/c/43/0/0/0", keys)
        self.assertIn("ingest-state/rnl/state.json", keys)
        self.assertNotIn("ingest-state/rnl/lease.json", keys)  # released
        self.assertTrue(all(k == "zarr.json" or k.startswith(("rnl/", "ingest-state/rnl/")) for k in keys), keys)

    def test_chc_request_slot_is_taken_for_the_run_and_released(self):
        # Positive control: slot free, the run asks CHC and releases the slot.
        s3 = FakeS3()
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            out = lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, None, s3_client=s3)
        self.assertEqual(out["revision"], 1)
        slot = lease.host_slot_key("chc")
        self.assertEqual(slot, "ingest-state/hosts/chc/lease.json")
        self.assertEqual(s3.calls[0], ("put", slot))  # taken before anything else, CHC included
        self.assertIn(("delete", slot), s3.calls)
        self.assertNotIn(slot, s3.keys("mirror"))  # released

    def _held_by_fetcher(self, s3=None):
        body = json.dumps({"owner": "fetcher-run", "expires": time.time() + 600, "holder": "fetcher"}).encode()
        if s3 is not None:
            s3.objects[("mirror", lease.host_slot_key("chc"))] = body
        else:
            p = self.root / lease.host_slot_key("chc")
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)

    def test_a_backfill_month_raises_host_busy_while_the_fetcher_holds_the_slot(self):
        s3 = FakeS3()
        self._held_by_fetcher(s3)
        asked = []

        def opener(*a, **k):
            asked.append(a)
            raise AssertionError("asked CHC")

        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            with self.assertRaises(lease.HostBusy) as caught:
                lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, None, s3_client=s3, opener=opener)
        # The state machine retries it by this name (infra/ingest_backfill.tf), and it is a MirrorBusy.
        self.assertEqual(type(caught.exception).__name__, "HostBusy")
        self.assertIsInstance(caught.exception, lease.MirrorBusy)
        self.assertRegex(str(caught.exception), "fetcher")
        self.assertEqual(asked, [])
        self.assertFalse(any(k.startswith("rnl/") for k in s3.keys("mirror")))
        self.assertNotIn(("put", lease.lease_key("rnl")), s3.calls)  # the product lease was never taken
        # The fetcher's slot is left alone.
        self.assertEqual(json.loads(s3.objects[("mirror", lease.host_slot_key("chc"))])["owner"], "fetcher-run")

    def test_a_daily_run_ends_quietly_while_the_slot_is_held_locally(self):
        self._held_by_fetcher()
        out = lambda_handler.handler({"product": "sat", "mode": "monthly"})
        self.assertRegex(out["busy"], "chc request slot")
        self.assertEqual(out["files"], [])
        self.assertIsNone(out["revision"])
        # Control: once the holder lets go, the next run copies.
        (self.root / lease.host_slot_key("chc")).unlink()
        self.assertEqual(lambda_handler.handler({"product": "sat", "mode": "monthly"})["revision"], 1)

    def test_an_expired_slot_is_taken_over_and_the_expiry_follows_the_deadline(self):
        s3 = FakeS3()
        slot = lease.host_slot_key("chc")
        s3.objects[("mirror", slot)] = json.dumps({"owner": "dead", "expires": 1.0}).encode()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        with lease.hold_host(mirror, "chc", 300.0, holder="ingest:rnl:monthly", now=lambda: 1000.0) as owner:
            held = json.loads(s3.objects[("mirror", slot)])
            self.assertEqual(held, {"owner": owner, "expires": 1000.0 + 300.0 + lease.HOST_SLOT_MARGIN_S, "holder": "ingest:rnl:monthly"})
            with self.assertRaises(lease.HostBusy):
                with lease.hold_host(mirror, "chc", None, holder="other", now=lambda: 1001.0):
                    pass
        self.assertNotIn(slot, s3.keys("mirror"))
        with self.assertRaises(ValueError):
            lease.host_slot_key("dws")

    # --- A backfill execution's hold (issue #618 step 4) -------------------------------

    def _month(self, s3, month, execution=EXECUTION, pause=60, **kw):
        ev = {"product": "rnl", "mode": "backfill", "month": month, "hold": {"execution": execution, "pauseSeconds": pause}}
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            return lambda_handler.handler(ev, None, s3_client=s3, **kw)

    def _release(self, s3, execution=EXECUTION):
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            return lambda_handler.handler({"mode": "release_hold", "hold": {"execution": execution}}, None, s3_client=s3)

    def _slot(self, s3):
        raw = s3.objects.get(("mirror", lease.host_slot_key("chc")))
        return json.loads(raw) if raw is not None else None

    def test_a_backfill_keeps_the_slot_across_its_months_and_releases_it_at_the_end(self):
        s3 = FakeS3()
        slot = lease.host_slot_key("chc")
        out = self._month(s3, "2024-01")
        self.assertEqual(out["revision"], 1)
        # Kept through the pause, not released: the execution's owner, its name, and an expiry of the pause plus the margin.
        held = self._slot(s3)
        self.assertEqual(held["owner"], lease.backfill_owner(EXECUTION))
        self.assertEqual(held["holder"], "ingest:backfill:run-1")
        self.assertAlmostEqual(held["expires"], time.time() + 60 + lease.BACKFILL_HOLD_MARGIN_S, delta=30)
        self.assertNotIn(("delete", slot), s3.calls)
        # Anyone else (the fetcher's per-feed fetch, a daily run) meets it held, by name.
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        with self.assertRaisesRegex(lease.HostBusy, "ingest:backfill:run-1"):
            with lease.hold_host(mirror, "chc", 300.0, holder="fetcher:chirps"):
                pass
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            daily = lambda_handler.handler({"product": "sat", "mode": "monthly"}, None, s3_client=s3)
        self.assertRegex(daily["busy"], "ingest:backfill:run-1")
        self.assertFalse(any(k.startswith("sat/") for k in s3.keys("mirror")))
        # The next month of the same execution recognises the hold as its own and copies.
        out = self._month(s3, "2024-02")
        self.assertEqual(out["finalThrough"], "2024-02-29")
        self.assertEqual(self._slot(s3)["owner"], lease.backfill_owner(EXECUTION))
        self.assertNotIn(("delete", slot), s3.calls)
        # Another execution's month waits (HostBusy, retried by the state machine) and asks CHC nothing.
        with self.assertRaisesRegex(lease.HostBusy, "ingest:backfill:run-1"):
            self._month(s3, "2024-01", execution=OTHER_EXECUTION, opener=lambda *a, **k: self.fail("asked CHC"))
        self.assertEqual(self._slot(s3)["owner"], lease.backfill_owner(EXECUTION))
        # The execution's last step releases it: the slot is free for the fetcher again.
        self.assertEqual(self._release(s3), {"mode": "release_hold", "holder": "ingest:backfill:run-1", "released": True})
        self.assertIsNone(self._slot(s3))
        self.assertEqual(self._release(s3)["released"], False)  # a second release (a retried step) is harmless

    def test_the_hold_is_kept_through_a_failed_month(self):
        # A month that fails keeps the hold (a retried Lambda error must find it its own); the release step ends it.
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        def failing_month():
            with lease.hold_host_for_backfill(mirror, "chc", 900.0, EXECUTION, 60, now=lambda: 1000.0):
                self.assertEqual(self._slot(s3)["expires"], 1000.0 + 900.0 + 60 + lease.BACKFILL_HOLD_MARGIN_S)
                raise RuntimeError("the month failed")

        with self.assertRaises(RuntimeError):
            failing_month()
        held = self._slot(s3)
        self.assertEqual(held["owner"], lease.backfill_owner(EXECUTION))
        self.assertEqual(held["expires"], 1000.0 + 60 + lease.BACKFILL_HOLD_MARGIN_S)  # kept through the pause, not released

    def test_a_hold_taken_over_meanwhile_is_left_alone_on_the_way_out(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        with lease.hold_host_for_backfill(mirror, "chc", 900.0, EXECUTION, 60, now=lambda: 1000.0):
            # Expired under us and taken over (it can't, in a Lambda; the code mustn't assume so).
            s3.objects[("mirror", lease.host_slot_key("chc"))] = json.dumps({"owner": "fetcher-run", "expires": 5000.0, "holder": "fetcher:chirps"}).encode()
        self.assertEqual(self._slot(s3)["owner"], "fetcher-run")
        self.assertFalse(lease.release_backfill_hold(mirror, "chc", EXECUTION))  # release removes only our own hold
        self.assertEqual(self._slot(s3)["owner"], "fetcher-run")

    def test_an_expired_hold_is_taken_over(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        slot = ("mirror", lease.host_slot_key("chc"))
        # An execution stopped by hand (no release step): its hold expires, and the fetcher takes the slot.
        s3.objects[slot] = json.dumps({"owner": lease.backfill_owner(OTHER_EXECUTION), "expires": 999.0, "holder": "ingest:backfill:run-2"}).encode()
        with lease.hold_host(mirror, "chc", 300.0, holder="fetcher:chirps", now=lambda: 1000.0) as owner:
            self.assertEqual(self._slot(s3)["owner"], owner)
        self.assertIsNone(self._slot(s3))
        # Another execution's expired hold: a new execution's month takes it over.
        s3.objects[slot] = json.dumps({"owner": lease.backfill_owner(OTHER_EXECUTION), "expires": 999.0}).encode()
        with lease.hold_host_for_backfill(mirror, "chc", 900.0, EXECUTION, 60, now=lambda: 1000.0):
            self.assertEqual(self._slot(s3)["owner"], lease.backfill_owner(EXECUTION))
        # Control: still live, it is busy.
        with self.assertRaises(lease.HostBusy):
            with lease.hold_host_for_backfill(mirror, "chc", 900.0, OTHER_EXECUTION, 60, now=lambda: 1001.0):
                pass

    def test_a_waiting_backfill_reserves_the_next_turn(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        slot, reserved = ("mirror", lease.host_slot_key("chc")), ("mirror", lease.host_reservation_key("chc"))
        self.assertEqual(reserved[1], "ingest-state/hosts/chc/reserved.json")
        s3.objects[slot] = json.dumps({"owner": "fetcher-run", "expires": 1600.0, "holder": "fetcher:chirps"}).encode()
        # The fetcher holds it: the backfill month is busy, and reserves the next turn.
        with self.assertRaisesRegex(lease.HostBusy, "reserved the next turn"):
            with lease.hold_host_for_backfill(mirror, "chc", 900.0, EXECUTION, 60, now=lambda: 1000.0):
                pass
        r = json.loads(s3.objects[reserved])
        self.assertEqual((r["owner"], r["holder"], r["expires"]), (lease.backfill_owner(EXECUTION), "ingest:backfill:run-1", 1000.0 + lease.RESERVATION_S))
        # Another execution waiting meanwhile doesn't steal the reservation.
        with self.assertRaisesRegex(lease.HostBusy, "fetcher:chirps"):
            with lease.hold_host_for_backfill(mirror, "chc", 900.0, OTHER_EXECUTION, 60, now=lambda: 1010.0):
                pass
        self.assertEqual(json.loads(s3.objects[reserved])["owner"], lease.backfill_owner(EXECUTION))
        # The fetcher lets go; a daily run (any other taker) gets the free slot but gives it back to the reservation.
        del s3.objects[slot]
        with self.assertRaisesRegex(lease.HostBusy, "ingest:backfill:run-1 reserved"):
            with lease.hold_host(mirror, "chc", 300.0, holder="ingest:sat:monthly", now=lambda: 1100.0):
                self.fail("ran past a live reservation")
        self.assertNotIn(slot, s3.objects)
        # The backfill's retry takes it and clears its reservation.
        with lease.hold_host_for_backfill(mirror, "chc", 900.0, EXECUTION, 60, now=lambda: 1120.0):
            self.assertEqual(self._slot(s3)["owner"], lease.backfill_owner(EXECUTION))
            self.assertNotIn(reserved, s3.objects)

    def test_an_expired_reservation_is_ignored(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        s3.objects[("mirror", lease.host_reservation_key("chc"))] = json.dumps({"owner": lease.backfill_owner(EXECUTION), "expires": 999.0}).encode()
        with lease.hold_host(mirror, "chc", 300.0, holder="ingest:rnl:monthly", now=lambda: 1000.0) as owner:
            self.assertEqual(self._slot(s3)["owner"], owner)

    def test_the_release_also_drops_its_own_reservation_only(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        reserved = ("mirror", lease.host_reservation_key("chc"))
        s3.objects[reserved] = json.dumps({"owner": lease.backfill_owner(OTHER_EXECUTION), "expires": time.time() + 300}).encode()
        self.assertFalse(lease.release_backfill_hold(mirror, "chc", EXECUTION))
        self.assertIn(reserved, s3.objects)  # another execution's: left alone
        s3.objects[reserved] = json.dumps({"owner": lease.backfill_owner(EXECUTION), "expires": time.time() + 300}).encode()
        lease.release_backfill_hold(mirror, "chc", EXECUTION)
        self.assertNotIn(reserved, s3.objects)

    def test_a_backfill_hold_on_a_local_copy(self):
        # The same through a file:// copy (dev): kept across two months, then released.
        hold = {"execution": "local-run", "pauseSeconds": 60}
        lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-01", "hold": hold})
        p = self.root / lease.host_slot_key("chc")
        self.assertEqual(json.loads(p.read_text())["holder"], "ingest:backfill:local-run")
        self.assertEqual(p.stat().st_mode & 0o077, 0)
        out = lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02", "hold": hold})
        self.assertEqual(out["finalThrough"], "2024-02-29")
        self.assertTrue(lambda_handler.handler({"mode": "release_hold", "hold": {"execution": "local-run"}})["released"])
        self.assertFalse(p.exists())

    def test_unknown_source_and_missing_mirror_refuse(self):
        with unittest.mock.patch.dict(os.environ, {"FEED_SOURCE": "nope"}):
            with self.assertRaises(RuntimeError):
                lambda_handler.handler({"product": "rnl", "mode": "monthly"})
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": ""}):
            with self.assertRaises(RuntimeError):
                lambda_handler.handler({"product": "rnl", "mode": "monthly"})

    def _truncating(self, times: int):
        """The fixture server, but its first `times` file bodies end early (a dropped connection)."""
        import fixturehttp

        base = fixturehttp.FixtureOpener()
        state = {"short": 0, "files": 0}

        def opener(req, timeout=None):
            res = base(req, timeout=timeout)
            if not req.full_url.endswith(".nc"):
                return res
            state["files"] += 1
            if state["short"] >= times:
                return res
            state["short"] += 1
            body = res.read()
            return fixturehttp._Response(body[: len(body) // 3], 200, res.headers)

        return opener, state

    def test_a_file_that_ends_early_is_asked_for_again(self):
        opener, state = self._truncating(1)
        out = lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, None, opener=opener)
        self.assertEqual([f["outcome"] for f in out["files"]], ["added"])
        self.assertEqual(state, {"short": 1, "files": 2})

    def test_a_file_that_keeps_ending_early_fails_the_month_by_name(self):
        opener, state = self._truncating(99)
        with self.assertRaises(polite.TruncatedDownload) as caught:
            lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, None, opener=opener)
        # The backfill state machine retries it by this name (infra/ingest_backfill.tf).
        self.assertEqual(type(caught.exception).__name__, "TruncatedDownload")
        self.assertEqual(state["files"], 4)  # the first try and polite's 3 retries
        self.assertFalse((self.root / "rnl" / "manifest.json").exists())  # never reached the reader

    def test_no_retry_once_a_whole_download_no_longer_fits(self):
        opener, state = self._truncating(99)

        class Context:
            def get_remaining_time_in_millis(self):
                # Plenty to start; under DOWNLOAD_RESERVE_S once the first body ended early.
                return 900_000 if state["short"] == 0 else 300_000

        with self.assertRaises(polite.TruncatedDownload):
            lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, Context(), opener=opener)
        self.assertEqual(state["files"], 1)

    def test_a_file_chc_keeps_answering_429_fails_the_month_as_retry_later(self):
        import email.message
        import urllib.error

        import fixturehttp

        base = fixturehttp.FixtureOpener()
        asked = {"files": 0}

        def opener(req, timeout=None):
            if not req.full_url.endswith(".nc"):
                return base(req, timeout=timeout)
            asked["files"] += 1
            h = email.message.Message()
            h["Retry-After"] = "0"
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", h, None)

        with self.assertLogs("ingest", level="WARNING") as logs, self.assertRaises(polite.RetryLater) as caught:
            lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "2024-02"}, None, opener=opener)
        # The backfill state machine retries it by this exact name, with long
        # waits (infra/ingest_backfill.tf); TruncatedDownload has its own rule.
        self.assertEqual(type(caught.exception).__name__, "RetryLater")
        self.assertIn("HTTP 429 after 3 retries (Retry-After '0')", str(caught.exception))
        self.assertEqual(asked["files"], 4)  # the first try and polite's 3 retries
        self.assertEqual(sum("answered HTTP 429" in r.getMessage() for r in logs.records), 4)
        self.assertFalse((self.root / "rnl" / "manifest.json").exists())

    def test_a_month_chc_does_not_list_is_a_404(self):
        with self.assertRaises(polite.HttpError) as caught:
            lambda_handler.handler({"product": "rnl", "mode": "backfill", "month": "1999-01"})
        self.assertEqual(caught.exception.status, 404)


class Image(unittest.TestCase):
    def test_the_dockerfile_copies_every_module_the_handler_imports(self):
        """The image ships only the files its COPY line names: a module the
        handler imports but the image lacks would fail every production run."""
        import re
        import shutil
        import subprocess

        line = next(ln for ln in (HERE / "Dockerfile").read_text().splitlines() if ln.startswith("COPY ") and "lambda_handler.py" in ln)
        files = re.findall(r"(\S+\.py)", line)
        with tempfile.TemporaryDirectory() as tmp:
            for f in files:
                shutil.copy(HERE / f, tmp)
            p = subprocess.run([sys.executable, "-E", "-s", "-c", "import lambda_handler, chirps_final, lease, cloudwatch"], cwd=tmp, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_the_image_does_not_run_as_root(self):
        """Trivy's DS-0002: the last USER names a user other than root."""
        users = [ln.split()[1] for ln in (HERE / "Dockerfile").read_text().splitlines() if ln.startswith("USER ")]
        self.assertTrue(users, "the Dockerfile sets no USER")
        self.assertNotIn(users[-1].split(":")[0], ("root", "0"))


class Diff(unittest.TestCase):
    def test_diff_counts_cells_not_cell_days(self):
        old = np.array([[[1.0, np.nan, 2.0]], [[1.0, np.nan, 2.0]]], dtype=np.float32)
        new = old.copy()
        new[:, 0, 0] = 3.0  # one cell, two days
        new[0, 0, 1] = 0.5  # NaN to a value: changed, not in maxAbsDiff
        self.assertEqual(chirps_final._diff(old, new), (2, 2.0))
        self.assertEqual(chirps_final._diff(old, old.copy()), (0, 0.0))


if __name__ == "__main__":
    unittest.main()
