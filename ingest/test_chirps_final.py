"""chirps_final.py through lambda_handler.handler: the listing and its diff, a
new month, a re-copy with the same values (no bump), changed values (a bump
with `changes`), the 304, the 403 that stops the run, the time budget, the
pacing, backfill of a named month, the lease, and MirrorLagDays on every exit.

No network: CHC is fixturehttp.FixtureOpener over fixtures/chirps/ (or a
scripted opener), S3 is fakes3.FakeS3 where it matters, and time is a fake
clock whose sleep moves it forward.

    ingest/.venv/bin/python -m unittest test_chirps_final   (from ingest/)
"""

import datetime as dt
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures"))
sys.path.insert(0, str(HERE / "fixtures" / "chirps"))

import chcnetcdf  # noqa: E402
import chirps_final  # noqa: E402
import cloudwatch  # noqa: E402
import fixturehttp  # noqa: E402
import lambda_handler  # noqa: E402
import lease  # noqa: E402
import make_chirps_fixtures as fx  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402

T0 = 1_800_000_000.0  # a whole second, so lastDownloadAt round-trips exactly
TODAY = dt.date(2024, 4, 30)
JAN, FEB = chirps_final.file_url("rnl", 2024, 1), chirps_final.file_url("rnl", 2024, 2)
LISTING = chirps_final.listing_url("rnl")


class Clock:
    def __init__(self, t=T0):
        self.t = t
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


class Context:
    """A Lambda context whose remaining time runs down with the fake clock."""

    def __init__(self, clock, seconds):
        self.clock = clock
        self.deadline = clock() + seconds

    def get_remaining_time_in_millis(self):
        return int((self.deadline - self.clock()) * 1000)


class Opener:
    """FixtureOpener, recording when each request was made; a file download
    costs `cost` seconds of the fake clock; `fail` maps a URL to an exception."""

    def __init__(self, clock, variant=None, cost=0.0, fail=None):
        self.inner = fixturehttp.FixtureOpener(variant=variant)
        self.clock = clock
        self.cost = cost
        self.fail = fail or {}
        self.log = []

    def __call__(self, req, timeout=None):
        url = req.full_url
        self.log.append((url, self.clock(), dict(req.header_items())))
        if url in self.fail:
            raise self.fail[url]
        res = self.inner(req, timeout)
        if url != LISTING and not url.endswith("/"):
            self.clock.t += self.cost
        return res

    def urls(self):
        return [u for u, _, _ in self.log]


def http_error(url, code):
    return urllib.error.HTTPError(url, code, "x", {}, None)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "mirror"
        self.env = unittest.mock.patch.dict(os.environ, {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "live"})
        self.env.start()
        self.clock = Clock()
        self.metrics = cloudwatch.LocalSink()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_job(self, event=None, opener=None, seconds=None, **kw):
        opener = opener or Opener(self.clock, **kw)
        ctx = Context(self.clock, seconds) if seconds is not None else None
        out = lambda_handler.handler(event or {"product": "rnl", "mode": "monthly"}, ctx, opener=opener, metrics=self.metrics, clock=self.clock, sleep=self.clock.sleep, today=lambda: TODAY)
        return out, opener

    def manifest(self, product="rnl"):
        return manifest.read(zarrstore.Mirror.from_url(f"file://{self.root}"), product)

    def chunk_mtimes(self):
        return sorted((p.as_posix(), p.stat().st_mtime_ns) for p in (self.root / "rnl" / "c").rglob("*") if p.is_file())


class Listing(unittest.TestCase):
    def test_parses_the_fixture_listing(self):
        entries = chirps_final.parse_listing((fx.HERE / "listing.html").read_text(), "rnl")
        self.assertEqual([e.name for e in entries], [fx.name(2024, 1), fx.name(2024, 2)])  # README and ../ ignored
        self.assertEqual(entries[1].url, FEB)
        self.assertEqual(entries[1].month, (2024, 2))
        self.assertEqual(entries[1].modified, dt.datetime(2024, 4, 17, 14, 5, tzinfo=dt.UTC))
        self.assertIsNone(entries[1].size)  # the fancy index rounds sizes (28.1 KiB)

    def test_committed_listings_match_their_files(self):
        for variant in (None, "rewritten", "changed"):
            o = fixturehttp.FixtureOpener(variant=variant)
            listing = (fx.HERE / (f"listing-{variant}.html" if variant else "listing.html")).read_text()
            names = [e.name for e in chirps_final.parse_listing(listing, "rnl")]
            self.assertEqual(names, [fx.name(2024, 1), fx.name(2024, 2)], variant)
            for n in names:
                self.assertTrue(o._path(n).is_file(), (variant, n))
            # The page the generator writes for the committed files themselves (not regenerated ones: HDF5
            # builds differ by a few bytes, which moves the rounded size).
            feb_time = {None: fx.MTIME[(2024, 2)], "rewritten": fx.MTIME_REWRITTEN, "changed": fx.MTIME_CHANGED}[variant]
            readme = ("README.txt", dt.datetime(2024, 1, 2, 3, 4, tzinfo=dt.UTC), 1234)
            jan = (fx.name(2024, 1), fx.MTIME[(2024, 1)], o._path(fx.name(2024, 1)).stat().st_size)
            feb = (fx.name(2024, 2), feb_time, o._path(fx.name(2024, 2)).stat().st_size)
            self.assertEqual(listing, fx.listing_html([readme, jan, feb]), variant)

    def test_committed_files_match_their_generator(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx.write(Path(tmp))
            for rel, (y, mo, variant) in {
                fx.name(2024, 1): (2024, 1, "original"),
                fx.name(2024, 2): (2024, 2, "original"),
                f"rewritten/{fx.name(2024, 2)}": (2024, 2, "original"),
                f"changed/{fx.name(2024, 2)}": (2024, 2, "changed"),
            }.items():
                committed = chcnetcdf.read_region(str(fx.HERE / rel))
                fresh = chcnetcdf.read_region(str(Path(tmp) / rel))
                self.assertEqual(committed.first_day, fx.first_day(y, mo))
                np.testing.assert_array_equal(committed.values, fx.month_values(y, mo, variant), err_msg=rel)
                np.testing.assert_array_equal(fresh.values, committed.values, err_msg=rel)

    def test_rounded_sizes_other_files_and_early_months(self):
        html = (
            '<a href="chirps-v3.0.2000.05.days_p05.nc">x</a>  01-Jan-2001 00:00  346M\n'
            '<a href="chirps-v3.0.2000.06.days_p05.nc">x</a>  01-Jan-2001 00:00  346M\n'
            '<a href="chirps-v3.0.2000.days_p05.nc">x</a>  01-Jan-2001 00:00  4G\n'
            '<a href="sub/">sub/</a>  01-Jan-2001 00:00  -\n'
        )
        entries = chirps_final.parse_listing(html, "sat")
        self.assertEqual([(e.month, e.size) for e in entries], [((2000, 6), None)])  # sat starts 2000-06
        self.assertEqual(len(chirps_final.parse_listing(html, "rnl")), 2)

    def test_parses_chcs_fancy_index_rows(self):
        # The structure of CHC's byMonth listing on 2026-10-27 (sizes and times invented).
        html = (
            '<tr><td class="link"><a href="../">Parent directory/</a></td><td class="size">-</td><td class="date">-</td></tr>\n'
            '<tr><td class="link"><a href="chirps-v3.0.1981.01.days_p05.nc" title="chirps-v3.0.1981.01.days_p05.nc">chirps-v3.0.1981.01.days_p05.nc</a></td>'
            '<td class="size">354.2 MiB</td><td class="date">2025-Sep-15 18:09</td></tr>\n'
            '<tr><td class="link"><a href="chirps-v3.0.2024.06.days_p05.nc" title="chirps-v3.0.2024.06.days_p05.nc">chirps-v3.0.2024.06.days_p05.nc</a></td>'
            '<td class="size">346.0 MiB</td><td class="date">2026-May-27 18:19</td></tr>\n'
        )
        entries = chirps_final.parse_listing(html, "rnl")
        self.assertEqual([(e.month, e.size) for e in entries], [((1981, 1), None), ((2024, 6), None)])
        self.assertEqual(entries[1].modified, dt.datetime(2026, 5, 27, 18, 19, tzinfo=dt.UTC))
        self.assertIsNone(chirps_final.needs_copy(entries[1], {"size": 362853441, "lastModified": "Wed, 27 May 2026 18:19:55 GMT"}))

    def test_parses_plain_autoindex_too(self):
        html = fx.autoindex_html([(fx.name(2024, 1), dt.datetime(2024, 3, 18, 9, 41, tzinfo=dt.UTC), 28723)])
        [e] = chirps_final.parse_listing(html, "rnl")
        self.assertEqual((e.month, e.size, e.modified), ((2024, 1), 28723, dt.datetime(2024, 3, 18, 9, 41, tzinfo=dt.UTC)))

    def test_a_listing_with_no_byMonth_file_is_refused(self):
        for html in ("", "<html><body>Maintenance</body></html>", '<a href="../">../</a>'):
            with self.assertRaises(chirps_final.ListingError):
                chirps_final.parse_listing(html, "rnl")

    def test_needs_copy(self):
        e = chirps_final.ListingEntry(fx.name(2024, 2), FEB, (2024, 2), dt.datetime(2024, 4, 17, 14, 5, tzinfo=dt.UTC), 100)
        held = {"size": 100, "lastModified": "Wed, 17 Apr 2024 14:05:59 GMT"}
        self.assertEqual(chirps_final.needs_copy(e, None), "new")
        self.assertIsNone(chirps_final.needs_copy(e, held))  # the listing's time is to the minute
        self.assertEqual(chirps_final.needs_copy(e, {**held, "size": 101}), "changed")
        self.assertEqual(chirps_final.needs_copy(e, {**held, "lastModified": "Wed, 17 Apr 2024 14:06:00 GMT"}), "changed")
        self.assertEqual(chirps_final.needs_copy(e, {**held, "lastModified": None}), "changed")
        rounded = chirps_final.ListingEntry(e.name, e.url, e.month, e.modified, None)
        self.assertIsNone(chirps_final.needs_copy(rounded, {**held, "size": 5}))  # a rounded size can't be compared


class Monthly(Base):
    def test_a_new_month(self):
        out, opener = self.run_job()
        self.assertEqual([(f["url"], f["outcome"], f["reason"]) for f in out["files"]], [(JAN, "added", "new"), (FEB, "added", "new")])
        self.assertEqual(opener.urls(), [LISTING, JAN, FEB])
        m = self.manifest()
        self.assertEqual((m["revision"], m["finalThrough"], m["changes"]), (1, "2024-02-29", []))
        self.assertEqual(m["files"][1]["valuesSha256"], manifest.values_sha256(fx.month_values(2024, 2)))
        self.assertEqual(m["files"][1]["etag"], f'"{int(dt.datetime(2024, 4, 17, 14, 5, tzinfo=dt.UTC).timestamp()):x}-{m["files"][1]["size"]:x}"')
        self.assertEqual(self.metrics.published, [("rnl", (TODAY - dt.date(2024, 2, 29)).days)])
        self.assertEqual(out["lagDays"], 61)

        # A listing that changed but names nothing new costs only the listing.
        listing = (fx.HERE / "listing.html").read_text()
        with unittest.mock.patch.object(fixturehttp.FixtureOpener, "_listing", lambda self: listing + "\n<!-- moved -->"):
            out, opener = self.run_job()
        self.assertEqual(out["files"], [])
        self.assertEqual(opener.urls(), [LISTING])

    def test_a_rewrite_with_the_same_values_does_not_bump(self):
        self.run_job()
        before = self.chunk_mtimes()
        out, opener = self.run_job(variant="rewritten")
        self.assertEqual(opener.urls(), [LISTING, FEB])  # January is as listed
        self.assertEqual([(f["outcome"], f["reason"]) for f in out["files"]], [("unchanged", "changed")])
        m = self.manifest()
        self.assertEqual((m["revision"], m["changes"]), (1, []))
        feb = manifest.file_entry(m, FEB)
        self.assertEqual(feb["size"], (fx.HERE / "rewritten" / fx.name(2024, 2)).stat().st_size)
        self.assertEqual(feb["lastModified"], "Mon, 03 Aug 2026 06:12:00 GMT")
        self.assertEqual(feb["revision"], 1)
        self.assertEqual(self.chunk_mtimes(), before)  # no chunk rewritten
        # ...and the next run knows it holds the rewrite.
        out, opener = self.run_job(variant="rewritten")
        self.assertEqual(opener.urls(), [LISTING])

    def test_a_rewrite_with_changed_values_bumps_with_a_change(self):
        self.run_job()
        out, _ = self.run_job(variant="changed")
        self.assertEqual([(f["outcome"], f["revision"]) for f in out["files"]], [("changed", 2)])
        m = self.manifest()
        self.assertEqual(m["revision"], 2)
        self.assertEqual(manifest.file_entry(m, FEB)["revision"], 2)
        self.assertEqual(manifest.file_entry(m, JAN)["revision"], 1)
        # Two cells: one land cell +1.5 mm on the 28th, one sea cell that now has rain (not in maxAbsDiff).
        self.assertEqual(m["changes"], [{"revision": 2, "days": ["2024-02-27", "2024-02-29"], "cellsChanged": 2, "maxAbsDiff": 1.5}])
        import zarr

        a = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="rnl", mode="r")
        self.assertEqual(a[43, 59, 500, 600], np.float32(7.5))

    def test_304_ends_the_run_and_still_publishes_the_metric(self):
        self.run_job()
        self.metrics.published.clear()
        before = self.chunk_mtimes()
        out, opener = self.run_job()
        self.assertEqual(out["listing"], "not-modified")
        self.assertEqual(opener.urls(), [LISTING])
        self.assertIn("If-None-Match", {k.title() for k in opener.log[0][2]})
        self.assertEqual(self.metrics.published, [("rnl", 61)])
        self.assertEqual(self.chunk_mtimes(), before)

    def test_a_403_stops_the_run_with_no_retry(self):
        clock = self.clock
        opener = Opener(clock, fail={JAN: http_error(JAN, 403)})
        with self.assertRaises(polite.StopRun):
            self.run_job(opener=opener)
        self.assertEqual(opener.urls(), [LISTING, JAN])  # one try, and February never asked for
        self.assertIsNone(self.manifest())
        self.assertEqual(self.metrics.published, [("rnl", (TODAY - dt.date(1980, 12, 31)).days)])  # nothing held yet
        # On the listing too.
        opener = Opener(clock, fail={LISTING: http_error(LISTING, 403)})
        with self.assertRaises(polite.StopRun):
            self.run_job(opener=opener)
        self.assertEqual(opener.urls(), [LISTING])

    def test_the_time_budget_stops_before_a_new_download(self):
        # 400 s left: January starts (>= 360 s left), February would start 60 s
        # later with 340 s left, so it waits for the next run.
        out, opener = self.run_job(seconds=400)
        self.assertEqual(opener.urls(), [LISTING, JAN])
        self.assertEqual((len(out["files"]), out["pending"]), (1, 1))
        self.assertEqual(self.metrics.published[-1], ("rnl", (TODAY - dt.date(2024, 1, 31)).days))
        state = json.loads((self.root / "ingest-state" / "rnl" / "state.json").read_text())
        self.assertIsNone(state["listing"])  # so the next run reads the listing again, not a 304
        out, opener = self.run_job(seconds=900)
        self.assertEqual(opener.urls(), [LISTING, FEB])
        self.assertNotIn("If-None-Match", {k.title() for k in opener.log[0][2]})
        self.assertEqual(out["pending"], 0)
        self.assertIsNotNone(json.loads((self.root / "ingest-state" / "rnl" / "state.json").read_text())["listing"])

    def test_too_little_time_from_the_start_downloads_nothing(self):
        out, opener = self.run_job(seconds=300)
        self.assertEqual(opener.urls(), [LISTING])
        self.assertEqual(out["pending"], 2)
        self.assertEqual(self.metrics.published, [("rnl", (TODAY - dt.date(1980, 12, 31)).days)])

    def test_downloads_are_paced_at_one_a_minute(self):
        out, opener = self.run_job(cost=25.0)  # each download takes 25 s
        starts = [t for u, t, _ in opener.log if u != LISTING]
        self.assertEqual(len(starts), 2)
        self.assertGreaterEqual(starts[1] - starts[0], 60.0)
        self.assertIn(35.0, self.clock.sleeps)  # 60 s (+1 s of polite spacing) from the first slot, less the 25 s it took
        # Across runs: a backfill right after waits out the rest of the minute.
        out, opener = self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-01"})
        self.assertGreaterEqual(opener.log[0][1] - starts[1], 60.0)

    def test_a_listing_time_that_is_not_the_files_time_stops_the_run(self):
        listing = (fx.HERE / "listing.html").read_text().replace("2024-Apr-17 14:05", "2024-Apr-17 16:05")
        opener = Opener(self.clock)
        entries = opener.inner._entries()  # the files keep their real Last-Modified; only the page shifts by two hours
        with unittest.mock.patch.object(fixturehttp.FixtureOpener, "_listing", lambda self: listing):
            with unittest.mock.patch.object(opener.inner, "_entries", lambda: entries):
                with self.assertRaisesRegex(chirps_final.ListingError, "another time zone"):
                    self.run_job(opener=opener)
        self.assertEqual([f["url"] for f in self.manifest()["files"]], [JAN])  # stopped before writing February
        self.assertEqual(len(self.metrics.published), 1)

    def test_an_implausible_file_fails_and_still_publishes(self):
        def bad(path):
            raise chcnetcdf.ImplausibleValueError("2000.5 mm")

        with unittest.mock.patch.object(chcnetcdf, "read_region", bad):
            with self.assertRaises(chcnetcdf.ImplausibleValueError):
                self.run_job()
        self.assertIsNone(self.manifest())
        self.assertEqual(len(self.metrics.published), 1)


class Backfill(Base):
    def test_backfill_of_a_named_month(self):
        out, opener = self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-02"})
        self.assertEqual(opener.urls(), [FEB])  # one request: no listing
        self.assertEqual([f["outcome"] for f in out["files"]], ["added"])
        m = self.manifest()
        self.assertEqual([f["url"] for f in m["files"]], [FEB])
        self.assertEqual(m["finalThrough"], "2024-02-29")
        # Again: a conditional GET, a 304, nothing changes.
        before = self.chunk_mtimes()
        out, opener = self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-02"})
        self.assertEqual(out["files"][0]["outcome"], "not-modified")
        self.assertIn("If-None-Match", {k.title() for k in opener.log[0][2]})
        self.assertEqual(self.chunk_mtimes(), before)
        self.assertEqual(self.metrics.published, [("rnl", 61), ("rnl", 61)])
        # The changed variant is fetched and bumps the revision.
        out, _ = self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-02"}, variant="changed")
        self.assertEqual(out["revision"], 2)

    def test_backfill_403_stops(self):
        opener = Opener(self.clock, fail={FEB: http_error(FEB, 403)})
        with self.assertRaises(polite.StopRun):
            self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-02"}, opener=opener)
        self.assertEqual(opener.urls(), [FEB])
        self.assertEqual(len(self.metrics.published), 1)


class Lease(Base):
    def test_monthly_ends_quietly_while_another_run_holds_the_product(self):
        mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        with lease.hold(mirror, "rnl", self.clock):
            out, opener = self.run_job()
            self.assertIn("busy", out)
            self.assertEqual(opener.urls(), [])  # nothing asked of CHC
            with self.assertRaises(lease.MirrorBusy):
                self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-01"})
            out, _ = self.run_job({"product": "sat", "mode": "monthly"})  # another product isn't held
            self.assertEqual(len(out["files"]), 2)
        self.assertEqual([p for p, _ in self.metrics.published], ["rnl", "rnl", "sat"])
        out, _ = self.run_job()  # released
        self.assertEqual(len(out["files"]), 2)

    def test_an_expired_lease_is_taken_over(self):
        mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        p = self.root / lease.lease_key("rnl")
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"owner": "dead", "expires": self.clock() - 1}))
        out, _ = self.run_job()
        self.assertEqual(len(out["files"]), 2)
        self.assertFalse(p.exists())
        with lease.hold(mirror, "rnl", self.clock):
            pass

    def test_s3_lease_uses_conditional_writes(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://mirror", s3_client=s3)
        with lease.hold(mirror, "rnl", self.clock):
            with self.assertRaises(lease.MirrorBusy):
                with lease.hold(mirror, "rnl", self.clock):
                    pass
            self.assertIn("ingest-state/rnl/lease.json", s3.keys("mirror"))
        self.assertNotIn("ingest-state/rnl/lease.json", s3.keys("mirror"))
        # A dead run's lease, expired: taken over with If-Match on its ETag.
        s3.objects[("mirror", "ingest-state/rnl/lease.json")] = json.dumps({"owner": "dead", "expires": self.clock() - 1}).encode()
        with lease.hold(mirror, "rnl", self.clock) as owner:
            self.assertEqual(json.loads(s3.objects[("mirror", "ingest-state/rnl/lease.json")])["owner"], owner)
        # Not yet expired: busy.
        s3.objects[("mirror", "ingest-state/rnl/lease.json")] = json.dumps({"owner": "live", "expires": self.clock() + 600}).encode()
        with self.assertRaisesRegex(lease.MirrorBusy, "live"):
            with lease.hold(mirror, "rnl", self.clock):
                pass

    def test_a_whole_run_through_s3_releases_its_lease(self):
        s3 = FakeS3()
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://mirror"}):
            opener = Opener(self.clock)
            lambda_handler.handler({"product": "rnl", "mode": "monthly"}, None, s3_client=s3, opener=opener, metrics=self.metrics, clock=self.clock, sleep=self.clock.sleep, today=lambda: TODAY)
        self.assertNotIn("ingest-state/rnl/lease.json", s3.keys("mirror"))
        self.assertIn(("put", "ingest-state/rnl/lease.json"), s3.calls)


class MetricOnEveryExit(Base):
    """The lag alarms treat a missing datapoint as breaching: every way out of
    the handler, once it knows its product and its copy, publishes exactly once."""

    def scenarios(self):
        """(name, run_job kwargs (made fresh), the error it raises, whether a full run goes first)."""
        fail = lambda url, e: lambda: dict(opener=Opener(self.clock, fail={url: e()}))  # noqa: E731
        yield "success", dict, None, False
        yield "304", dict, None, True
        yield "budget", lambda: dict(seconds=400), None, False
        yield "no time at all", lambda: dict(seconds=10), None, False
        yield "403 file", fail(JAN, lambda: http_error(JAN, 403)), polite.StopRun, False
        yield "403 listing", fail(LISTING, lambda: http_error(LISTING, 403)), polite.StopRun, False
        yield "404 listing", fail(LISTING, lambda: http_error(LISTING, 404)), polite.HttpError, False
        yield "network", fail(LISTING, lambda: urllib.error.URLError("unreachable")), urllib.error.URLError, False
        yield "503 forever", fail(LISTING, lambda: urllib.error.HTTPError(LISTING, 503, "x", {"Retry-After": "9999"}, None)), polite.RetryLater, False
        yield "backfill", lambda: dict(event={"product": "rnl", "mode": "backfill", "month": "2024-01"}), None, False
        yield "backfill 304", lambda: dict(event={"product": "rnl", "mode": "backfill", "month": "2024-01"}), None, True
        yield "backfill 404", lambda: dict(event={"product": "rnl", "mode": "backfill", "month": "2023-01"}), polite.HttpError, False

    def test_every_exit_publishes(self):
        for name, kw, error, prerun in self.scenarios():
            with self.subTest(name):
                self.root = Path(self.tmp.name) / name.replace(" ", "-")
                with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": f"file://{self.root}"}):
                    if prerun:
                        self.run_job()
                    self.metrics.published.clear()
                    if error:
                        with self.assertRaises(error):
                            self.run_job(**kw())
                    else:
                        self.run_job(**kw())
                self.assertEqual(len(self.metrics.published), 1, name)
                self.assertEqual(self.metrics.published[0][0], "rnl")

    def test_a_failure_inside_the_write_publishes_before_reraising(self):
        with unittest.mock.patch.object(zarrstore, "write_finals", side_effect=MemoryError("out of memory")):
            with self.assertRaises(MemoryError):
                self.run_job()
        self.assertEqual(len(self.metrics.published), 1)

    def test_busy_publishes(self):
        mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        with lease.hold(mirror, "rnl", self.clock):
            self.run_job()
            with self.assertRaises(lease.MirrorBusy):
                self.run_job({"product": "rnl", "mode": "backfill", "month": "2024-01"})
        self.assertEqual(len(self.metrics.published), 2)

    def test_a_failing_metric_does_not_hide_the_runs_error(self):
        class Broken:
            def publish(self, product, value):
                raise RuntimeError("CloudWatch is down")

        self.metrics = Broken()
        with self.assertRaises(polite.StopRun), self.assertLogs("ingest", "ERROR") as logged:
            self.run_job(opener=Opener(self.clock, fail={LISTING: http_error(LISTING, 403)}))
        self.assertIn("could not publish MirrorLagDays", logged.output[0])
        # On a run that otherwise succeeded, the metric's failure is the run's failure (the errors alarm sees it).
        with self.assertRaisesRegex(RuntimeError, "CloudWatch"):
            self.run_job()

    def test_cloudwatch_sink_sends_the_alarms_metric(self):
        calls = []

        class Client:
            def put_metric_data(self, **kw):
                calls.append(kw)

        cloudwatch.CloudWatchSink(Client()).publish("sat", 12)
        self.assertEqual(calls, [{"Namespace": "water-management/Mirror", "MetricData": [{"MetricName": "MirrorLagDays", "Dimensions": [{"Name": "Product", "Value": "sat"}], "Value": 12.0, "Unit": "None"}]}])

    def test_lag_with_nothing_copied_counts_from_the_products_start(self):
        self.assertEqual(cloudwatch.lag_days("sat", None, dt.date(2000, 6, 2)), 2)
        self.assertEqual(cloudwatch.lag_days("rnl", "2024-02-29", dt.date(2024, 3, 1)), 1)


if __name__ == "__main__":
    unittest.main()
