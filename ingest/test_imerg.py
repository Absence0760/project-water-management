"""imerg.py (issue #604 R4-D): IMERG Late's recent days into `imerg_late`.

Orientation and row order against a synthetic *global* file in IMERG's real
layout (lon before lat), units, the CMR search and recent-day selection
(skipping held days, newest first), keeping 30 days, the per-day version, a
403 or 401 that stops the run and marks the day, the lease, MirrorLagDays on
every exit, and the token sent only where it belongs.

No network and no token: CMR and OPeNDAP are imerg_fixture.FakeEarthdata,
which cuts its OPeNDAP subsets out of fixtures/imerg's synthetic field.

    ingest/.venv/bin/python -m unittest test_imerg   (from ingest/)
"""

import datetime as dt
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error
import urllib.parse
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures" / "imerg"))

import cloudwatch  # noqa: E402
import imerg  # noqa: E402
import imerg_fixture  # noqa: E402
import lambda_handler  # noqa: E402
import lease  # noqa: E402
import make_imerg_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402

TODAY = dt.date(2024, 10, 12)
EVENT = {"product": "imerg_late", "mode": "recent"}


def region_expected(day: dt.date) -> np.ndarray:
    """The copy's (lat, lon) values for `day`, built cell by cell from the fixture's own coordinates."""
    out = np.empty((imerg.GRID.rows, imerg.GRID.cols), dtype=np.float32)
    g = fx.global_values(day)
    for r in range(imerg.GRID.rows):
        j = fx.lat_index(imerg.GRID.origin["lat"] + r * imerg.GRID.step)
        for c in range(imerg.GRID.cols):
            out[r, c] = g[fx.lon_index(imerg.GRID.origin["lon"] + c * imerg.GRID.step), j]
    return out


def read_day(root: Path, day: dt.date) -> np.ndarray:
    import zarr

    arr = zarr.open_array(store=zarr.storage.LocalStore(root), path=imerg.PRODUCT, mode="r", zarr_format=3)
    i = (day - dt.date.fromisoformat(arr.attrs["firstDay"])).days
    return np.array(arr[i])


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "mirror"
        self.env = unittest.mock.patch.dict(os.environ, {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "fixtures"})
        self.env.start()
        self.metrics = cloudwatch.LocalSink()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_job(self, opener=None, today=TODAY, event=EVENT, **kw):
        opener = opener if opener is not None else imerg_fixture.FakeEarthdata(latest=today - dt.timedelta(days=1))
        self.opener = opener
        return lambda_handler.handler(dict(event), opener=opener, metrics=self.metrics, today=lambda: today, **kw)

    def manifest(self):
        return json.loads((self.root / "imerg_late" / "manifest.json").read_text())


class Layout(unittest.TestCase):
    """The reader against IMERG's global layout: (time, lon, lat), south first."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.day = dt.date(2024, 10, 1)
        self.path = fx.write(Path(self.tmp.name) / fx.file_name(self.day), self.day)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_fixture_is_imergs_layout(self):
        import h5netcdf

        with h5netcdf.File(self.path, "r") as f:
            p = f.variables["precipitation"]
            self.assertEqual(p.dimensions, ("time", "lon", "lat"))
            self.assertEqual(p.shape, (1, 3600, 1800))
            self.assertEqual(p.attrs["units"], "mm/day")
            self.assertAlmostEqual(float(f.variables["lat"][0]), -89.95, places=4)
            self.assertAlmostEqual(float(f.variables["lon"][0]), -179.95, places=4)
            self.assertGreater(float(f.variables["lat"][1]), float(f.variables["lat"][0]))

    def test_a_known_cell_lands_at_its_lat_lon(self):
        """Put one unique value at a known coordinate in the global grid and find it at the copy's [row, col]."""
        values = np.zeros((fx.NLON, fx.NLAT), dtype=np.float32)
        lat, lon = -33.95, 18.45  # a Western Cape cell
        values[fx.lon_index(lon), fx.lat_index(lat)] = 123.5
        values[fx.lon_index(lon + 0.1), fx.lat_index(lat)] = 7.0  # its eastern neighbour
        values[fx.lon_index(lon), fx.lat_index(lat + 0.1)] = 9.0  # its northern neighbour
        path = fx.write(Path(self.tmp.name) / "one.nc4", self.day, values)
        got = imerg.read_region(str(path), self.day)
        row, col = round((lat - imerg.GRID.origin["lat"]) / imerg.GRID.step), round((lon - imerg.GRID.origin["lon"]) / imerg.GRID.step)
        self.assertEqual((row, col), (15, 84))
        self.assertEqual(got[row, col], 123.5)
        self.assertEqual(got[row, col + 1], 7.0)  # east is the next column
        self.assertEqual(got[row + 1, col], 9.0)  # north is the next row
        self.assertEqual(int((got != 0).sum()), 3)

    def test_the_regions_corners(self):
        values = np.zeros((fx.NLON, fx.NLAT), dtype=np.float32)
        corners = {(0, 0): (-35.45, 10.05), (0, 309): (-35.45, 40.95), (274, 0): (-8.05, 10.05), (274, 309): (-8.05, 40.95)}
        for k, (rc, (lat, lon)) in enumerate(corners.items()):
            values[fx.lon_index(lon), fx.lat_index(lat)] = 10.0 + k
        got = imerg.read_region(str(fx.write(Path(self.tmp.name) / "c.nc4", self.day, values)), self.day)
        for k, rc in enumerate(corners):
            self.assertEqual(got[rc], 10.0 + k, rc)
        # The cells just outside the region aren't copied.
        values[fx.lon_index(10.05 - 0.1), fx.lat_index(-35.45)] = 99.0
        values[fx.lon_index(10.05), fx.lat_index(-35.45 - 0.1)] = 99.0
        got = imerg.read_region(str(fx.write(Path(self.tmp.name) / "c2.nc4", self.day, values)), self.day)
        self.assertNotIn(99.0, got)

    def test_the_whole_region_matches_cell_by_cell(self):
        got = imerg.read_region(str(self.path), self.day)
        np.testing.assert_array_equal(got, region_expected(self.day))
        self.assertTrue(np.isnan(got[0, 0]))  # the fixture's fill block reads as NaN
        self.assertTrue(np.isnan(got).any() and not np.isnan(got).all())

    def test_an_opendap_subset_reads_the_same_as_the_global_file(self):
        sub = fx.write(Path(self.tmp.name) / "sub.nc4", self.day, None, slice(imerg.LON_I0, imerg.LON_I0 + imerg.GRID.cols), slice(imerg.LAT_I0, imerg.LAT_I0 + imerg.GRID.rows))
        np.testing.assert_array_equal(imerg.read_region(str(sub), self.day), imerg.read_region(str(self.path), self.day))

    def test_the_opendap_index_ranges(self):
        self.assertEqual((imerg.LON_I0, imerg.LAT_I0), (1900, 545))
        self.assertAlmostEqual(fx.lons()[imerg.LON_I0], 10.05, places=4)
        self.assertAlmostEqual(fx.lats()[imerg.LAT_I0], -35.45, places=4)
        self.assertAlmostEqual(fx.lons()[imerg.LON_I0 + imerg.GRID.cols - 1], 40.95, places=4)
        self.assertAlmostEqual(fx.lats()[imerg.LAT_I0 + imerg.GRID.rows - 1], -8.05, places=4)
        g = imerg.Granule(self.day, "V07", "V07C", imerg_fixture.opendap_url(self.day, "07"))
        ce = urllib.parse.parse_qs(urllib.parse.urlparse(imerg.subset_url(g)).query)["dap4.ce"][0]
        self.assertEqual(ce, "/precipitation[0:1:0][1900:1:2209][545:1:819];/lon[1900:1:2209];/lat[545:1:819];/time[0:1:0]")
        self.assertTrue(imerg.subset_url(g).startswith(g.url + ".dap.nc4?"))

    def test_a_north_first_lat_lon_file_still_places_cells_by_coordinate(self):
        """A file in (time, lat, lon) with latitude descending: the reader goes by coordinates, not order."""
        import h5netcdf

        g = fx.global_values(self.day)
        lat = fx.lats()[::-1]
        data = np.where(np.isnan(g), fx.FILL, g).T[::-1][None]
        path = Path(self.tmp.name) / "flip.nc4"
        with h5netcdf.File(path, "w") as f:
            f.dimensions = {"time": 1, "lat": fx.NLAT, "lon": fx.NLON}
            f.create_variable("lat", ("lat",), "f4")[:] = lat
            f.create_variable("lon", ("lon",), "f4")[:] = fx.lons()
            p = f.create_variable("precipitation", ("time", "lat", "lon"), "f4", fillvalue=fx.FILL)
            p[:] = data
            p.attrs["units"] = "mm/day"
        np.testing.assert_array_equal(imerg.read_region(str(path), self.day), region_expected(self.day))


class Units(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.day = dt.date(2024, 10, 1)

    def tearDown(self):
        self.tmp.cleanup()

    def test_mm_per_day_is_read_as_the_days_mm(self):
        values = np.zeros((fx.NLON, fx.NLAT), dtype=np.float32)
        values[fx.lon_index(20.05), fx.lat_index(-30.05)] = 42.25
        got = imerg.read_region(str(fx.write(Path(self.tmp.name) / "a.nc4", self.day, values)), self.day)
        self.assertEqual(float(np.nansum(got)), 42.25)

    def test_a_rate_per_hour_is_refused(self):
        path = fx.write(Path(self.tmp.name) / "hr.nc4", self.day, units="mm/hr")
        with self.assertRaisesRegex(imerg.ImergFormatError, "units are \"mm/hr\""):
            imerg.read_region(str(path), self.day)

    def test_v06s_precipitationCal_is_refused_by_name(self):
        path = fx.write(Path(self.tmp.name) / "v6.nc4", self.day, var="precipitationCal", units="mm")
        with self.assertRaisesRegex(imerg.ImergFormatError, "V06's name"):
            imerg.read_region(str(path), self.day)

    def test_the_wrong_day_is_refused(self):
        path = fx.write(Path(self.tmp.name) / "d.nc4", self.day)
        with self.assertRaisesRegex(imerg.ImergFormatError, "not on 2024-10-02"):
            imerg.read_region(str(path), self.day + dt.timedelta(days=1))

    def test_an_implausible_value_fails_the_read(self):
        values = np.zeros((fx.NLON, fx.NLAT), dtype=np.float32)
        values[fx.lon_index(25.05), fx.lat_index(-25.05)] = 2500.0
        path = fx.write(Path(self.tmp.name) / "big.nc4", self.day, values)
        with self.assertRaisesRegex(Exception, r"implausible.*2500.0 mm on 2024-10-01 at -25.05, 25.05"):
            imerg.read_region(str(path), self.day)

    def test_a_login_page_instead_of_a_file_is_refused(self):
        path = Path(self.tmp.name) / "page.nc4"
        path.write_bytes(b"<!DOCTYPE html><html>Earthdata Login</html>")
        with self.assertRaisesRegex(imerg.ImergFormatError, "not NetCDF-4"):
            imerg.read_region(str(path), self.day)


class Search(unittest.TestCase):
    def test_the_search_url(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(imerg.search_url(dt.date(2024, 10, 2), dt.date(2024, 10, 11))).query)
        self.assertEqual(q["short_name"], ["GPM_3IMERGDL"])
        self.assertEqual(q["version[]"], ["07", "08"])
        self.assertEqual(q["temporal"], ["2024-10-02T00:00:00Z,2024-10-11T23:59:59Z"])

    def test_the_newest_version_a_day_has_wins(self):
        d = dt.date(2024, 10, 5)
        body = json.dumps({"items": [imerg_fixture.umm_item(d, "07"), imerg_fixture.umm_item(d, "08"), imerg_fixture.umm_item(d - dt.timedelta(days=1), "07")]}).encode()
        got = imerg.parse_search(body, d - dt.timedelta(days=9), d)
        self.assertEqual(got[d].version, "V08")
        self.assertEqual(got[d].tag, "V08A")
        self.assertEqual(got[d - dt.timedelta(days=1)].version, "V07")

    def test_a_granule_with_no_opendap_link_stops_the_run(self):
        item = imerg_fixture.umm_item(dt.date(2024, 10, 5), "07")
        item["umm"]["RelatedUrls"] = [u for u in item["umm"]["RelatedUrls"] if u.get("Subtype") != "OPENDAP DATA"]
        with self.assertRaisesRegex(imerg.ImergFormatError, "one OPeNDAP link"):
            imerg.parse_search(json.dumps({"items": [item]}).encode(), dt.date(2024, 10, 1), dt.date(2024, 10, 9))

    def test_a_granule_whose_time_is_not_its_day_stops_the_run(self):
        item = imerg_fixture.umm_item(dt.date(2024, 10, 5), "07")
        item["umm"]["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"] = "2024-10-06T00:00:00.000Z"
        with self.assertRaisesRegex(imerg.ImergFormatError, "not the day the file names"):
            imerg.parse_search(json.dumps({"items": [item]}).encode(), dt.date(2024, 10, 1), dt.date(2024, 10, 9))


class Recent(Base):
    def test_the_last_ten_days_newest_first(self):
        out = self.run_job()
        days = [c["day"] for c in out["copied"]]
        expected = [(TODAY - dt.timedelta(days=k)).isoformat() for k in range(1, 11)]
        self.assertEqual(days, expected)  # newest first
        self.assertEqual(out["stopped"], "copied")
        m = self.manifest()
        self.assertEqual(m["product"], "imerg_late")
        self.assertEqual(m["grid"], {"origin": {"lat": -35.45, "lon": 10.05}, "step": 0.1})
        self.assertIsNone(m["finalThrough"])
        self.assertEqual(m["prelimThrough"], (TODAY - dt.timedelta(days=1)).isoformat())
        self.assertEqual(m["revision"], 1)
        self.assertEqual(len(m["files"]), 10)
        # Each day's values and hash.
        for k in (1, 5, 10):
            d = TODAY - dt.timedelta(days=k)
            np.testing.assert_array_equal(read_day(self.root, d), region_expected(d))
            f = next(f for f in m["files"] if imerg.granule_day(f["url"])[0] == d)
            self.assertEqual(f["valuesSha256"], manifest.values_sha256(region_expected(d)[None]))
        # The array's metadata: the shared brief's 0.1 deg daily layout.
        meta = json.loads((self.root / "imerg_late" / "zarr.json").read_text())
        self.assertEqual(meta["shape"][1:], [275, 310])
        self.assertEqual(meta["chunk_grid"]["configuration"]["chunk_shape"], [1, 55, 62])
        self.assertEqual(meta["dimension_names"], ["day", "lat", "lon"])
        self.assertEqual(meta["attributes"]["grid"], m["grid"])
        self.assertEqual(meta["attributes"]["region"], m["region"])
        self.assertEqual(meta["attributes"]["firstDay"], (TODAY - dt.timedelta(days=30)).isoformat())
        self.assertEqual(self.metrics.published, [("imerg_late", 1)])

    def test_held_days_are_skipped_with_no_request(self):
        self.run_job()
        out = self.run_job()
        self.assertEqual(out["copied"], [])
        self.assertEqual(out["stopped"], "up_to_date")
        self.assertEqual(len(self.opener.requests), 1)  # the CMR search only
        self.assertTrue(self.opener.requests[0][0].startswith(imerg.CMR_SEARCH))

    def test_the_next_day_copies_only_the_new_day(self):
        self.run_job()
        out = self.run_job(today=TODAY + dt.timedelta(days=1))
        self.assertEqual([c["day"] for c in out["copied"]], [TODAY.isoformat()])
        self.assertEqual(len(self.opener.requests), 2)
        self.assertEqual(self.manifest()["prelimThrough"], TODAY.isoformat())

    def test_a_day_not_published_yet_leaves_a_gap_and_prelimThrough_is_the_newest_day(self):
        gap = TODAY - dt.timedelta(days=4)
        self.run_job(opener=imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), missing={gap}))
        m = self.manifest()
        self.assertEqual(len(m["files"]), 9)
        self.assertNotIn(gap.isoformat(), manifest.imerg_held_days(m["files"]))
        # Each held day stands on its own: the gap doesn't hold prelimThrough (or the lag) back.
        self.assertEqual(m["prelimThrough"], (TODAY - dt.timedelta(days=1)).isoformat())
        self.assertEqual(self.metrics.published[-1], ("imerg_late", 1))
        # The gap appears: the next run copies just it.
        out = self.run_job()
        self.assertEqual([c["day"] for c in out["copied"]], [gap.isoformat()])
        self.assertEqual(self.manifest()["prelimThrough"], (TODAY - dt.timedelta(days=1)).isoformat())

    def test_a_gap_older_than_the_look_back_blocks_no_later_day(self):
        gap = TODAY - dt.timedelta(days=4)
        self.run_job(opener=imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), missing={gap}))
        # Eleven days on, the gap is past the 10-day search and never comes back; the copy runs on past it.
        later = TODAY + dt.timedelta(days=11)
        self.run_job(today=later)
        m = self.manifest()
        held = manifest.imerg_held_days(m["files"])
        self.assertNotIn(gap.isoformat(), held)
        self.assertIn((gap + dt.timedelta(days=1)).isoformat(), held)
        self.assertEqual(m["prelimThrough"], (later - dt.timedelta(days=1)).isoformat())
        manifest.validate(m)
        self.assertEqual(self.metrics.published[-1], ("imerg_late", 1))

    def test_a_shorter_window_from_the_event(self):
        out = self.run_job(event={**EVENT, "days": 3})
        self.assertEqual(len(out["copied"]), 3)

    def test_bad_events_are_refused(self):
        for ev in ({**EVENT, "mode": "monthly"}, {**EVENT, "days": 0}, {**EVENT, "days": 31}, {**EVENT, "month": "2024-10"}, {**EVENT, "days": True}):
            with self.subTest(ev=ev), self.assertRaises(imerg.BadEvent):
                lambda_handler.handler(ev, metrics=self.metrics)
        self.assertEqual(self.metrics.published, [])

    def test_the_time_budget_stops_before_a_request(self):
        class Context:
            def get_remaining_time_in_millis(self):
                return 30_000  # under REQUEST_RESERVE_S

        out = self.run_job(context=Context())
        self.assertEqual(out["stopped"], "deadline")
        self.assertEqual(out["copied"], [])
        self.assertEqual(self.metrics.published, [("imerg_late", 11)])


class Keep(Base):
    def test_days_older_than_30_are_dropped_with_their_chunks(self):
        self.run_job(event={**EVENT, "days": 30})
        oldest = TODAY - dt.timedelta(days=30)
        self.assertEqual(len(self.manifest()["files"]), 30)
        chunk_dir = self.root / "imerg_late" / "c" / "0"
        self.assertTrue(chunk_dir.is_dir())  # day index 0 is the oldest day, TODAY - 30
        later = TODAY + dt.timedelta(days=3)
        out = self.run_job(today=later)
        self.assertEqual(out["dropped"], [(oldest + dt.timedelta(days=k)).isoformat() for k in range(3)])
        m = self.manifest()
        held = sorted(imerg.granule_day(f["url"])[0] for f in m["files"])
        self.assertEqual(held[0], later - dt.timedelta(days=30))
        self.assertEqual(len(held), 30)
        self.assertEqual(m["years"], {"first": held[0].year, "last": held[-1].year})
        for i in range(3):
            self.assertFalse((self.root / "imerg_late" / "c" / str(i)).exists())
        self.assertTrue((self.root / "imerg_late" / "c" / "3").is_dir())
        self.assertTrue(np.isnan(read_day(self.root, oldest)).all())


class Versions(Base):
    def test_each_day_records_its_version(self):
        self.run_job()
        for f in self.manifest()["files"]:
            self.assertEqual(f["version"], "V07")
            self.assertIn(".V07C.nc4", urllib.parse.unquote(f["url"]))
            self.assertEqual(list(f), ["url", "etag", "lastModified", "size", "valuesSha256", "revision", "fetchedAt", "version"])

    def test_v08_replaces_a_held_v07_day_and_bumps_the_revision(self):
        self.run_job()
        v08 = TODAY - dt.timedelta(days=2)

        def changed(day, version):
            v = fx.global_values(day).copy()
            if version == "08":
                v[fx.lon_index(18.45), fx.lat_index(-33.95)] = 77.0
            return v

        out = self.run_job(opener=imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), v08_from=v08, values=changed))
        self.assertEqual([(c["day"], c["version"], c["outcome"]) for c in out["copied"]], [((TODAY - dt.timedelta(days=1)).isoformat(), "V08", "changed"), (v08.isoformat(), "V08", "changed")])
        m = self.manifest()
        versions = {imerg.granule_day(f["url"])[0]: f["version"] for f in m["files"]}
        self.assertEqual(versions[v08], "V08")
        self.assertEqual(versions[v08 - dt.timedelta(days=1)], "V07")
        self.assertEqual(m["revision"], 3)
        self.assertEqual([c["days"] for c in m["changes"]], [[(TODAY - dt.timedelta(days=1)).isoformat()] * 2, [v08.isoformat()] * 2])
        self.assertEqual([c["cellsChanged"] for c in m["changes"]], [1, 1])
        self.assertEqual(read_day(self.root, v08)[15, 84], 77.0)

    def test_a_new_granule_with_the_same_values_moves_the_url_not_the_revision(self):
        self.run_job()
        d = TODAY - dt.timedelta(days=1)
        out = self.run_job(opener=imerg_fixture.FakeEarthdata(latest=d, v08_from=d))
        self.assertEqual([c["outcome"] for c in out["copied"]], ["unchanged"])
        m = self.manifest()
        self.assertEqual(m["revision"], 1)
        self.assertEqual(next(f for f in m["files"] if imerg.granule_day(f["url"])[0] == d)["version"], "V08")

    def test_the_manifest_check_refuses_a_missing_or_wrong_version(self):
        self.run_job(event={**EVENT, "days": 1})
        m = self.manifest()
        del m["files"][0]["version"]
        with self.assertRaisesRegex(ValueError, "must carry its version"):
            imerg._checked(m)
        m["files"][0]["version"] = "V08"
        with self.assertRaisesRegex(ValueError, "is a V07C file but says version V08"):
            imerg._checked(m)
        m["files"][0]["version"] = "7"
        with self.assertRaisesRegex(ValueError, "must be an IMERG version"):
            imerg._checked(m)


class Refusal(Base):
    def test_a_403_stops_the_run_and_marks_the_day(self):
        for host, status in (("opendap.earthdata.nasa.gov", 403), ("opendap.earthdata.nasa.gov", 401), ("cmr.earthdata.nasa.gov", 403)):
            with self.subTest(host=host, status=status):
                self.tearDown()
                self.setUp()
                fake = imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), refuse={host: status})
                with self.assertRaises(polite.StopRun) as caught:
                    self.run_job(opener=fake)
                self.assertEqual(caught.exception.status, status)
                n = len(fake.requests)
                self.assertEqual(n, 1 if host.startswith("cmr") else 2)  # never retried
                marker = json.loads((self.root / "ingest-state" / "imerg_late" / "refused.json").read_text())
                self.assertEqual((marker["v"], marker["status"], marker["host"]), (1, status, host))
                self.assertEqual(self.metrics.published, [("imerg_late", 11)])
                # Later runs that UTC day ask nothing.
                out = self.run_job(opener=fake)
                self.assertEqual(out["stopped"], "refused_today")
                self.assertEqual(len(fake.requests), n)
                self.assertEqual(len(self.metrics.published), 2)

    def test_the_next_utc_day_tries_again(self):
        fake = imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), refuse={"opendap.earthdata.nasa.gov": 403})
        clock = lambda: dt.datetime.combine(TODAY, dt.time(10), dt.UTC).timestamp()  # noqa: E731
        with self.assertRaises(polite.StopRun):
            self.run_job(opener=fake, clock=clock)
        marker = imerg.read_refused(zarrstore.LocalMirror(self.root))
        self.assertEqual((marker["day"], marker["at"]), (TODAY.isoformat(), f"{TODAY.isoformat()}T10:00:00Z"))
        out = self.run_job(today=TODAY + dt.timedelta(days=1))
        self.assertEqual(out["stopped"], "copied")

    def test_a_broken_marker_never_blocks_a_run(self):
        (self.root / "ingest-state" / "imerg_late").mkdir(parents=True)
        (self.root / "ingest-state" / "imerg_late" / "refused.json").write_text('{"v": 2}')
        self.assertEqual(self.run_job()["stopped"], "copied")

    def test_a_day_copied_before_the_refusal_is_kept(self):
        class Flaky(imerg_fixture.FakeEarthdata):
            def _subset(self, url):
                if sum(1 for u, _ in self.requests if u.startswith(imerg_fixture.OPENDAP)) > 2:
                    raise urllib.error.HTTPError(url, 403, "Forbidden", imerg_fixture._headers({}), None)
                return super()._subset(url)

        with self.assertRaises(polite.StopRun):
            self.run_job(opener=Flaky(latest=TODAY - dt.timedelta(days=1)))
        self.assertEqual(len(self.manifest()["files"]), 2)


class Lease(Base):
    def test_a_run_ends_quietly_while_another_holds_the_product(self):
        mirror = zarrstore.LocalMirror(self.root)
        with lease.hold(mirror, "imerg_late"):
            out = self.run_job()
        self.assertEqual(out["stopped"], "busy")
        self.assertEqual(self.opener.requests, [])
        self.assertEqual(self.metrics.published, [("imerg_late", 11)])
        self.assertFalse((self.root / "ingest-state" / "imerg_late" / "lease.json").exists())

    def test_a_run_through_s3_takes_and_releases_the_lease(self):
        s3 = FakeS3()
        with unittest.mock.patch.dict(os.environ, {"MIRROR_URL": "s3://bucket"}):
            out = self.run_job(s3_client=s3, event={**EVENT, "days": 2})
        self.assertEqual(len(out["copied"]), 2)
        keys = s3.keys("bucket")
        self.assertIn("imerg_late/manifest.json", keys)
        self.assertNotIn("ingest-state/imerg_late/lease.json", keys)
        self.assertIn(("put", "ingest-state/imerg_late/lease.json"), s3.calls)
        self.assertTrue(any(k.startswith("imerg_late/c/29/") for k in keys))


class MetricOnEveryExit(Base):
    def test_every_exit_publishes(self):
        self.run_job()  # copied
        self.run_job()  # up to date
        with self.assertRaises(polite.StopRun):  # refused
            self.run_job(opener=imerg_fixture.FakeEarthdata(latest=TODAY, refuse={"cmr.earthdata.nasa.gov": 403}))
        self.run_job()  # refused today
        self.assertEqual(self.metrics.published, [("imerg_late", 1)] * 4)

    def test_a_format_failure_publishes_before_reraising(self):
        def bad(day, version):
            v = fx.global_values(day).copy()
            v[fx.lon_index(20.05), fx.lat_index(-20.05)] = 5000.0
            return v

        with self.assertRaisesRegex(Exception, "implausible"):
            self.run_job(opener=imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), values=bad))
        self.assertEqual(self.metrics.published, [("imerg_late", 11)])

    def test_a_missing_secret_arn_in_live_mode_publishes_and_fails(self):
        with unittest.mock.patch.dict(os.environ, {"FEED_SOURCE": "live"}):
            os.environ.pop("EARTHDATA_TOKEN_SECRET_ARN", None)
            with self.assertRaisesRegex(RuntimeError, "EARTHDATA_TOKEN_SECRET_ARN"):
                lambda_handler.handler(dict(EVENT), metrics=self.metrics, today=lambda: TODAY)
        self.assertEqual(self.metrics.published, [("imerg_late", 11)])

    def test_a_secret_with_no_value_yet_says_so(self):
        class NoValue:
            def get_secret_value(self, SecretId):
                e = Exception("no value")
                e.response = {"Error": {"Code": "ResourceNotFoundException"}}
                raise e

        with self.assertRaisesRegex(RuntimeError, "has no value yet"):
            imerg.fetch_token("arn:aws:secretsmanager:af-south-1:000000000000:secret:x", NoValue())

    def test_the_cloudwatch_sink_sends_the_alarms_metric(self):
        sent = []

        class Client:
            def put_metric_data(self, **kw):
                sent.append(kw)

        cloudwatch.CloudWatchSink(Client()).publish("imerg_late", 2)
        self.assertEqual(sent[0]["Namespace"], "water-management/Mirror")
        self.assertEqual(sent[0]["MetricData"][0]["MetricName"], "MirrorLagDays")
        self.assertEqual(sent[0]["MetricData"][0]["Dimensions"], [{"Name": "Product", "Value": "imerg_late"}])


class Token(Base):
    def test_live_mode_reads_the_secret_and_sends_it_to_opendap_only(self):
        token = "test-token-not-real"

        class Secrets:
            def __init__(self):
                self.asked = []

            def get_secret_value(self, SecretId):
                self.asked.append(SecretId)
                return {"SecretString": token + "\n"}

        secrets = Secrets()
        fake = imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), token=token)
        arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/ingest/earthdata-token-AbCdEf"
        # The real EarthdataOpener, over the fake server instead of urllib's network opener.
        with unittest.mock.patch.dict(os.environ, {"FEED_SOURCE": "live", "EARTHDATA_TOKEN_SECRET_ARN": arn}):
            with unittest.mock.patch.object(imerg, "EarthdataOpener", lambda t: _Opener(t, fake)):
                out = imerg.handle({**EVENT, "days": 2}, metrics=self.metrics, today=lambda: TODAY, secrets_client=secrets, sleep=lambda s: None)
        self.assertEqual(secrets.asked, [arn])
        self.assertEqual(len(out["copied"]), 2)
        for url, headers in fake.requests:
            host = urllib.parse.urlparse(url).hostname
            if host == "cmr.earthdata.nasa.gov":
                self.assertNotIn("Authorization", headers)
            else:
                self.assertEqual(headers.get("Authorization"), f"Bearer {token}")
        self.assertNotIn(token, json.dumps(out))
        self.assertNotIn(token, repr(_Opener(token, fake)))

    def test_the_token_is_never_sent_on_a_redirect(self):
        req = urllib.request.Request("https://opendap.earthdata.nasa.gov/x")
        captured = {}

        def base(r, timeout=None):
            captured["redirectable"] = dict(r.headers)
            captured["all"] = dict(r.header_items())
            raise urllib.error.HTTPError(r.full_url, 404, "x", None, None)

        with self.assertRaises(urllib.error.HTTPError):
            imerg.EarthdataOpener("t0k", base)(req)
        self.assertNotIn("Authorization", captured["redirectable"])
        self.assertEqual(captured["all"]["Authorization"], "Bearer t0k")

    def test_no_token_for_other_hosts(self):
        seen = {}

        def base(r, timeout=None):
            seen.update(dict(r.header_items()))
            raise urllib.error.HTTPError(r.full_url, 404, "x", None, None)

        with self.assertRaises(urllib.error.HTTPError):
            imerg.EarthdataOpener("t0k", base)(urllib.request.Request("https://cmr.earthdata.nasa.gov/search"))
        self.assertNotIn("Authorization", seen)

    def test_landing_on_earthdata_login_is_a_401(self):
        class Landed:
            headers = imerg_fixture._headers({})

            def geturl(self):
                return "https://urs.earthdata.nasa.gov/oauth/authorize?client_id=x"

            def close(self):
                pass

        with self.assertRaises(urllib.error.HTTPError) as caught:
            imerg.EarthdataOpener("t0k", lambda r, timeout=None: Landed())(urllib.request.Request("https://opendap.earthdata.nasa.gov/x"))
        self.assertEqual(caught.exception.code, 401)


_RealOpener = imerg.EarthdataOpener


def _Opener(token, fake):
    return _RealOpener(token, fake)


if __name__ == "__main__":
    unittest.main()
