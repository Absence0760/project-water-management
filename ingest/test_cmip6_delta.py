"""cmip6_delta.py: NEX-GDDP-CMIP6's monthly aggregates for D1 (issue #621).
The calendars, the cut of D1 placed by coordinate (a margin dropped, a
north-first file), the monthly totals and means (a leap February, a 360-day
year, a missing day), the refusals, the plan (the highest version, a missing
file, two variants), the copy (arrays, attributes, the manifest with each
file's version and `license` attribute verbatim, the index), resuming, a new
version with the same and with other values, S3 on both sides (ranged reads
of the source, the staged copy), the command, and the committed backend
fixture's layout.

No network: the source is fixtures/cmip6/make_cmip6_fixture.py's synthetic
tree in a temporary directory, or a fake S3 serving it.

    ingest/.venv/bin/python -m unittest test_cmip6_delta   (from ingest/)
"""

import datetime as dt
import io
import json
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures" / "cmip6"))

import cmip6_delta as c6  # noqa: E402
import fakes3  # noqa: E402
import grid  # noqa: E402
import make_cmip6_fixture as fx  # noqa: E402
import manifest  # noqa: E402
import zarrstore  # noqa: E402

REPO = HERE.parent
BACKEND_FIXTURE = REPO / "backend" / "fixtures" / "mirror" / "cmip6"
NOW = "2026-10-29T00:00:00Z"
FIXTURE_YEARS = {s: tuple(fx.YEARS[s]) for s in c6.SCENARIOS}


def cell(lat: float, lon: float) -> tuple[int, int]:
    """The region (row, col) of a cell centre."""
    return grid.CMIP6.row_index(lat), grid.CMIP6.col_index(lon)


def expected_months(model: str, scenario: str, var: str, year: int, lat: float, lon: float, version=None) -> np.ndarray:
    """The fixture's own monthly aggregate at a land cell, from its daily formula (independent of the reader)."""
    days = fx.calendar_days(fx.MODELS[model]["calendar"], year)
    raw = fx.values(model, scenario, var, year, version)
    i, j = round((lat - fx.LAT0) / fx.STEP), round((lon - fx.LON0) / fx.STEP)
    series = raw[:, i, j].astype(np.float64)
    series[series == np.float64(fx.FILL)] = np.nan
    series = series * 86400 if var == "pr" else series - 273.15
    months = np.array([m for m, _ in days])
    return np.array([series[months == m].sum() if var == "pr" else series[months == m].mean() for m in range(1, 13)])


_TREE = None


def setUpModule():
    global _TREE
    _TREE = tempfile.TemporaryDirectory()
    fx.write_tree(Path(_TREE.name))


def tearDownModule():
    _TREE.cleanup()


class Tree(unittest.TestCase):
    """A fresh copy of the synthetic tree (written once for the module) and an empty local copy per test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src_root = Path(self.tmp.name) / "src"
        shutil.copytree(_TREE.name, self.src_root)
        self.source = c6.LocalSource(self.src_root)
        self.root = Path(self.tmp.name) / "mirror"
        self.mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        self.logs = []

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, model, scenario, var, year, version=None):
        path = self.src_root / fx.file_key(model, scenario, var, year, version)
        with open(path, "rb") as fh:
            return c6.read_file(fh, var, year, str(path))

    def plans(self, models=("SYN-A", "SYN-B", "SYN-C"), scenarios=c6.SCENARIOS):
        return c6.make_plan(self.source, {m: None for m in models}, scenarios, FIXTURE_YEARS)

    def copy(self, **kw):
        return c6.copy(self.mirror, self.source, kw.pop("plans", None) or self.plans(), now=lambda: NOW, log=self.logs.append, **kw)

    def array(self, product, var):
        import zarr

        return zarr.open_array(store=zarr.storage.LocalStore(self.root), path=f"{product}/{c6.ARRAYS[var]}", mode="r")


class Calendars(unittest.TestCase):
    def test_each_calendar_decodes_days_and_hours_at_any_time_of_day(self):
        self.assertEqual(c6.decode_time(np.array([0.5, 1.5, 59.5]), "days since 2024-01-01", "proleptic_gregorian"), [(2024, 1, 1), (2024, 1, 2), (2024, 2, 29)])
        self.assertEqual(c6.decode_time(np.array([59.0]), "days since 2023-01-01 00:00:00", "standard"), [(2023, 3, 1)])
        # noleap: no 29 February in a leap year; 365 days a year from the epoch.
        self.assertEqual(c6.decode_time(np.array([59.0, 365.0]), "days since 2024-01-01", "noleap"), [(2024, 3, 1), (2025, 1, 1)])
        self.assertEqual(c6.decode_time(np.array([59.0]), "days since 2023-01-01", "all_leap"), [(2023, 2, 29)])
        # 360_day: 30-day months, and hours since an epoch at noon.
        self.assertEqual(c6.decode_time(np.array([12.0, 24 * 59 + 12.0, 24 * 360 + 12.0]), "hours since 1950-01-01", "360_day"), [(1950, 1, 1), (1950, 2, 30), (1951, 1, 1)])
        # An epoch with a time of day counts from that time.
        self.assertEqual(c6.decode_time(np.array([0.6]), "days since 2000-01-01 12:00:00", "standard"), [(2000, 1, 2)])
        self.assertEqual(c6.month_days("360_day", 2024), [30] * 12)
        self.assertEqual(c6.month_days("noleap", 2024)[1], 28)
        self.assertEqual(c6.month_days("gregorian", 2024)[1], 29)
        self.assertEqual(c6.month_days("gregorian", 2100)[1], 28)

    def test_unknown_calendars_and_units_are_refused(self):
        for units, cal in [("months since 2000-01-01", "standard"), ("days after 2000-01-01", "standard"), ("days since 2000-01-01", "julian"), ("days since 1500-01-01", "standard")]:
            with self.assertRaises(c6.Cmip6FormatError, msg=f"{units} {cal}"):
                c6.decode_time(np.array([0.0]), units, cal)


class Subset(Tree):
    def test_a_land_cell_lands_at_its_coordinates_and_nothing_else_is_held(self):
        fm = self.read("SYN-A", "historical", "pr", 2013)
        self.assertEqual(fm.values.shape, (12, 110, 124))
        self.assertEqual(fm.values.dtype, np.float32)
        held = {(int(r), int(c)) for r, c in np.argwhere(~np.isnan(fm.values[0]))}
        self.assertEqual(held, {cell(*p) for p in fx.LAND})
        # D1's south-west cell is [0, 0]; the margin cells (with implausible values) never arrive.
        self.assertEqual(cell(*fx.CORNER), (0, 0))
        np.testing.assert_allclose(fm.values[:, 0, 0], expected_months("SYN-A", "historical", "pr", 2013, *fx.CORNER), rtol=1e-5)
        lat, lon = fx.BLOCK[5]
        np.testing.assert_allclose(fm.values[:, cell(lat, lon)[0], cell(lat, lon)[1]], expected_months("SYN-A", "historical", "pr", 2013, lat, lon), rtol=1e-5)

    def test_a_north_first_file_is_placed_by_coordinate(self):
        # SYN-B's latitude runs north to south: the same cells, each its own value.
        for var in c6.VARIABLES:
            fm = self.read("SYN-B", "ssp245", var, 2036)
            for lat, lon in [fx.BLOCK[0], fx.BLOCK[3], fx.BLOCK[12], fx.CORNER]:
                r, c = cell(lat, lon)
                np.testing.assert_allclose(fm.values[:, r, c], expected_months("SYN-B", "ssp245", var, 2036, lat, lon), rtol=1e-5, atol=1e-4, err_msg=f"{var} {lat} {lon}")

    def test_the_file_license_attribute_is_returned_verbatim(self):
        self.assertEqual(self.read("SYN-A", "ssp245", "pr", 2036).license, fx.LICENSE)
        self.assertEqual(self.read("SYN-C", "historical", "tasmin", 2013).license, fx.OLD_LICENSE)
        self.assertIsNone(self.read("SYN-C", "ssp585", "pr", 2066).license)


class Aggregation(Tree):
    def test_pr_is_the_month_total_in_mm_and_temperatures_the_month_mean_in_celsius(self):
        lat, lon = fx.BLOCK[9]
        r, c = cell(lat, lon)
        pr = self.read("SYN-A", "ssp245", "pr", 2036).values[:, r, c]
        # By hand: January's 31 days of mm, from the fixture's formula.
        jan = sum(fx.daily_mm("SYN-A", "ssp245", 2036, k, 1, lat, lon) for k in range(31))
        self.assertAlmostEqual(float(pr[0]), jan, places=3)
        # 2036 is a leap year in SYN-A's proleptic Gregorian calendar: February has 29 days.
        feb = sum(fx.daily_mm("SYN-A", "ssp245", 2036, k, 2, lat, lon) for k in range(31, 60))
        self.assertAlmostEqual(float(pr[1]), feb, places=3)
        tmax = self.read("SYN-A", "historical", "tasmax", 2013).values[:, r, c]
        jan_c = np.mean([fx.daily_k("tasmax", "SYN-A", "historical", 2013, k, 365, lat, lon) for k in range(31)]) - 273.15
        self.assertAlmostEqual(float(tmax[0]), jan_c, places=4)

    def test_a_noleap_and_a_360_day_year(self):
        lat, lon = fx.BLOCK[0]
        r, c = cell(lat, lon)
        # SYN-B (noleap): February 2036 has 28 days, though 2036 is a leap year.
        pr = self.read("SYN-B", "ssp245", "pr", 2036).values[:, r, c]
        self.assertAlmostEqual(float(pr[1]), sum(fx.daily_mm("SYN-B", "ssp245", 2036, k, 2, lat, lon) for k in range(31, 59)), places=3)
        # SYN-C (360_day): every month 30 days; December is days 330-359.
        pr = self.read("SYN-C", "historical", "pr", 2013).values[:, r, c]
        self.assertAlmostEqual(float(pr[11]), sum(fx.daily_mm("SYN-C", "historical", 2013, k, 12, lat, lon) for k in range(330, 360)), places=3)

    def test_a_month_with_a_missing_day_is_nan_for_that_cell_only(self):
        model, scenario, var, year, k, lat, lon = fx.GAP
        fm = self.read(model, scenario, var, year)
        r, c = cell(lat, lon)
        self.assertTrue(np.isnan(fm.values[1, r, c]), "February (noleap day 40 is 10 Feb) should be NaN")
        self.assertFalse(np.isnan(fm.values[[0, *range(2, 12)], r, c]).any())
        r2, c2 = cell(*fx.BLOCK[1])
        self.assertFalse(np.isnan(fm.values[1, r2, c2]))

    def test_the_hash_is_the_aggregates_hash(self):
        fm = self.read("SYN-A", "historical", "pr", 2013)
        self.assertEqual(manifest.values_sha256(fm.values), manifest.values_sha256(fm.values.copy(order="F")))


def _write(path: Path, var="pr", year=2013, lat=None, lon=None, units=None, calendar="noleap", time=None, data=None, packed=False):
    """A small hand-made file for the refusals."""
    import h5netcdf

    lat = np.arange(-36.125, -7.874, 0.25) if lat is None else lat
    lon = np.arange(9.875, 41.126, 0.25) if lon is None else lon
    n = 365 if time is None else len(time)
    data = np.full((n, len(lat), len(lon)), 1e-5 if var == "pr" else 290.0, dtype=np.float32) if data is None else data
    with h5netcdf.File(path, "w") as f:
        f.dimensions = {"time": n, "lat": len(lat), "lon": len(lon)}
        t = f.create_variable("time", ("time",), "f8")
        t[:] = (np.arange(n) + (year - 1950) * 365) if time is None else time
        t.attrs["units"] = "days since 1950-01-01"
        t.attrs["calendar"] = calendar
        f.create_variable("lat", ("lat",), "f8")[:] = lat
        f.create_variable("lon", ("lon",), "f8")[:] = lon
        x = f.create_variable(var, ("time", "lat", "lon"), "f4", fillvalue=np.float32(1e20))
        x[:] = data
        x.attrs["units"] = units or ("kg m-2 s-1" if var == "pr" else "K")
        if packed:
            x.attrs["scale_factor"] = np.float32(0.1)
    return path


class Refusals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def refuse(self, path, var="pr", year=2013, error=c6.Cmip6FormatError, match=""):
        with open(path, "rb") as fh, self.assertRaisesRegex(error, match):
            c6.read_file(fh, var, year, str(path))

    def test_a_plain_file_reads(self):
        with open(_write(self.dir / "ok.nc"), "rb") as fh:
            fm = c6.read_file(fh, "pr", 2013)
        self.assertAlmostEqual(float(fm.values[0, 0, 0]), 31 * 1e-5 * 86400, places=3)

    def test_layouts_it_refuses(self):
        self.refuse(_write(self.dir / "u.nc", units="mm/day"), match="expected kg m-2 s-1")
        self.refuse(_write(self.dir / "k.nc", var="tasmax", units="degC"), var="tasmax", match="expected K")
        self.refuse(_write(self.dir / "p.nc", packed=True), match="scale_factor")
        self.refuse(_write(self.dir / "s.nc", lat=np.arange(-36.0, -7.9, 0.5), lon=np.arange(10.0, 41.1, 0.5)), match="0.25 deg steps")
        self.refuse(_write(self.dir / "c.nc", lat=np.arange(-30.125, -7.874, 0.25)), match="does not cover the region")
        self.refuse(_write(self.dir / "o.nc", lat=np.arange(-36.0, -7.9, 0.25)), match="off the 0.25 deg grid")
        self.refuse(_write(self.dir / "y.nc", year=2014), year=2013, match="every day of 2013")
        self.refuse(_write(self.dir / "d.nc", time=np.arange(364) + (2013 - 1950) * 365), match="holds 364 days")
        self.refuse(_write(self.dir / "cal.nc", calendar="julian"), match="calendar")
        with open(_write(self.dir / "v.nc"), "rb") as fh, self.assertRaisesRegex(c6.Cmip6FormatError, "no variable tasmax"):
            c6.read_file(fh, "tasmax", 2013)

    def test_implausible_values_fail_before_anything_is_written(self):
        d = np.full((365, 114, 126), 1e-5, dtype=np.float32)
        d[40, 50, 60] = 2500 / 86400
        self.refuse(_write(self.dir / "wet.nc", data=d), error=c6.ImplausibleValueError, match="outside -0.01-2000 mm/day")
        d[40, 50, 60] = -1 / 86400
        self.refuse(_write(self.dir / "neg.nc", data=d), error=c6.ImplausibleValueError, match="-1.000")
        t = np.full((365, 114, 126), 290.0, dtype=np.float32)
        t[3, 5, 5] = 400.0
        self.refuse(_write(self.dir / "hot.nc", var="tasmin", data=t), var="tasmin", error=c6.ImplausibleValueError, match="outside 170-340 K")

    def test_round_off_below_zero_is_clamped(self):
        d = np.full((365, 114, 126), 0.0, dtype=np.float32)
        d[:, 1, 1] = -0.005 / 86400
        with open(_write(self.dir / "noise.nc", data=d), "rb") as fh:
            fm = c6.read_file(fh, "pr", 2013)
        self.assertEqual(float(fm.values[:, 0, 0].min()), 0.0)


class Plan(Tree):
    def test_the_highest_version_is_read_and_strays_are_ignored(self):
        p = next(x for x in self.plans(("SYN-A",), ("ssp245",)))
        self.assertEqual((p.variant, p.grid_label, p.missing, p.problems), ("r1i1p1f1", "gn", [], []))
        self.assertEqual(sorted(p.files), sorted((v, y) for v in c6.VARIABLES for y in fx.YEARS["ssp245"]))
        self.assertTrue(p.files[("tasmax", 2036)].key.endswith("_2036_v1.1.nc"))
        self.assertTrue(p.files[("tasmax", 2066)].key.endswith("_2066.nc"))
        self.assertIn("6 files (v1.0, v1.1)", c6.plan_text([p]))

    def test_a_missing_file_stops_the_copy_before_any_read(self):
        (self.src_root / fx.file_key("SYN-B", "historical", "tasmin", 2014)).unlink()
        plans = self.plans(("SYN-A", "SYN-B"), ("historical",))
        self.assertEqual(plans[1].missing, [("tasmin", 2014)])
        self.assertIn("missing tasmin 2014", c6.plan_text(plans))
        with self.assertRaisesRegex(c6.MissingFilesError, "cmip6/SYN-B/historical"):
            self.copy(plans=plans)
        self.assertFalse(self.root.exists())

    def test_two_variants_need_a_pin(self):
        other = self.src_root / c6.ROOT / "SYN-A" / "historical" / "r2i1p1f1" / "pr" / "pr_day_SYN-A_historical_r2i1p1f1_gn_2013.nc"
        other.parent.mkdir(parents=True)
        shutil.copy(self.src_root / fx.file_key("SYN-A", "historical", "pr", 2013), other)
        p = c6.plan_product(self.source, "SYN-A", "historical", fx.YEARS["historical"])
        self.assertIn("pin one in MODELS", p.problems[0])
        pinned = c6.plan_product(self.source, "SYN-A", "historical", fx.YEARS["historical"], "r1i1p1f1")
        self.assertEqual((pinned.problems, pinned.missing), ([], []))

    def test_years_outside_the_windows_are_not_planned(self):
        p = c6.plan_product(self.source, "SYN-A", "ssp245", (2036,))
        self.assertEqual(sorted({y for _, y in p.files}), [2036])


class Copy(Tree):
    def test_writes_the_arrays_their_attributes_the_manifests_and_the_index(self):
        out = self.copy()
        self.assertEqual(out["products"]["cmip6/SYN-A/historical"], {"added": 2, "replaced": 0, "changed": 0, "skipped": 0, "revision": 1, "years": {"first": 2013, "last": 2014}})
        import zarr

        g = zarr.open_group(store=zarr.storage.LocalStore(self.root), path="cmip6/SYN-C/ssp585", mode="r")
        self.assertEqual(g.attrs["calendar"], "360_day")
        self.assertEqual(g.attrs["variant"], "r1i1p1f1")
        self.assertEqual(g.attrs["firstYear"], 2015)
        self.assertEqual(g.attrs["grid"], {"origin": {"lat": -35.375, "lon": 10.125}, "step": 0.25})
        self.assertEqual(g.attrs["licence"], c6.LICENCE)
        self.assertEqual(g.attrs["citation"], c6.CITATION)
        a = self.array("cmip6/SYN-B/historical", "tasmin")
        self.assertEqual((a.shape, a.chunks, tuple(a.metadata.dimension_names)), ((65, 12, 110, 124), c6.CHUNKS, c6.DIMS))
        self.assertEqual((a.attrs["units"], a.attrs["aggregation"], a.attrs["firstYear"]), ("degC", "monthly mean", 1950))
        # A known cell and year at its index: year - firstYear.
        lat, lon = fx.BLOCK[6]
        r, c = cell(lat, lon)
        np.testing.assert_allclose(a[2014 - 1950, :, r, c], expected_months("SYN-B", "historical", "tasmin", 2014, lat, lon), rtol=1e-5)
        self.assertTrue(np.isnan(a[2012 - 1950]).all())
        pr = self.array("cmip6/SYN-A/ssp245", "pr")
        self.assertEqual(pr.attrs["units"], "mm")
        np.testing.assert_allclose(pr[2066 - 2015, :, r, c], expected_months("SYN-A", "ssp245", "pr", 2066, lat, lon), rtol=1e-5)
        # The v1.1 file's values (0.5 K warmer), not the first release's.
        tmax = self.array("cmip6/SYN-A/ssp245", "tasmax")
        np.testing.assert_allclose(tmax[2036 - 2015, :, r, c], expected_months("SYN-A", "ssp245", "tasmax", 2036, lat, lon, "v1.1"), rtol=1e-5)
        # Only the chunks holding land are written: the block's and the corner's, per variable and year.
        chunks = [p for p in (self.root / "cmip6/SYN-A/historical/pr_mm/c").rglob("*") if p.is_file()]
        self.assertEqual(len(chunks), 2 * 2)

        m = manifest.read(self.mirror, "cmip6/SYN-A/ssp245")
        self.assertEqual((m["revision"], m["years"], m["finalThrough"], m["prelimThrough"], m["changes"]), (1, {"first": 2036, "last": 2066}, None, None, []))
        self.assertEqual(len(m["files"]), 6)
        by_url = {f["url"]: f for f in m["files"]}
        v11 = by_url[c6.file_url(fx.file_key("SYN-A", "ssp245", "tasmax", 2036, "v1.1"))]
        self.assertEqual((v11["version"], v11["license"], v11["fetchedAt"]), ("v1.1", fx.LICENSE, NOW))
        self.assertNotIn(c6.file_url(fx.file_key("SYN-A", "ssp245", "tasmax", 2036)), by_url)
        self.assertEqual(v11["valuesSha256"], manifest.values_sha256(self.read("SYN-A", "ssp245", "tasmax", 2036, "v1.1").values))
        self.assertEqual(v11["size"], (self.src_root / fx.file_key("SYN-A", "ssp245", "tasmax", 2036, "v1.1")).stat().st_size)
        # The license attribute verbatim: the old licence, and null for a file with none.
        old = manifest.read(self.mirror, "cmip6/SYN-C/historical")
        self.assertEqual({f["license"] for f in old["files"]}, {fx.OLD_LICENSE})
        none = manifest.read(self.mirror, "cmip6/SYN-C/ssp585")
        self.assertIsNone(next(f for f in none["files"] if "/pr/" in f["url"] and "_2066" in f["url"])["license"])
        # Every distinct license attribute the run met, with its count (9 products x 6 files).
        self.assertEqual(out["licenses"], {fx.LICENSE: 47, fx.OLD_LICENSE: 6, "(no license attribute)": 1})

        idx = json.loads((self.root / "cmip6/index.json").read_text())
        self.assertEqual(idx, {"products": {m: {s: list(fx.YEARS[s]) for s in c6.SCENARIOS} for m in ("SYN-A", "SYN-B", "SYN-C")}})

    def test_a_rerun_reads_and_rewrites_nothing(self):
        plans = lambda: self.plans(("SYN-B",), ("ssp585",))  # noqa: E731
        self.copy(plans=plans())
        before = {p: p.stat().st_mtime_ns for p in self.root.rglob("*") if p.is_file()}
        opened = []
        real = self.source.open
        self.source.open = lambda obj: opened.append(obj.key) or real(obj)
        out = self.copy(plans=plans())
        self.assertEqual(opened, [])
        self.assertEqual(out["products"]["cmip6/SYN-B/ssp585"]["skipped"], 2)
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in self.root.rglob("*") if p.is_file()})
        # --recheck reads again and, with the same values, bumps nothing.
        out = self.copy(plans=plans(), recheck=True)
        self.assertEqual(out["products"]["cmip6/SYN-B/ssp585"], {"added": 0, "replaced": 2, "changed": 0, "skipped": 0, "revision": 1, "years": {"first": 2036, "last": 2066}})
        self.assertGreater(len(opened), 0)

    def test_a_run_cut_short_resumes(self):
        plans = self.plans(("SYN-A",), ("historical",))
        plans[0].files = {k: v for k, v in plans[0].files.items() if k[1] == 2013}
        self.copy(plans=plans)
        self.assertEqual(manifest.read(self.mirror, "cmip6/SYN-A/historical")["years"], {"first": 2013, "last": 2013})
        out = self.copy(plans=self.plans(("SYN-A",), ("historical",)))
        self.assertEqual(out["products"]["cmip6/SYN-A/historical"]["skipped"], 1)
        self.assertEqual(out["products"]["cmip6/SYN-A/historical"]["added"], 1)

    def _new_version(self, model, scenario, var, year, version, delta=0.0):
        """Add a re-released file to the source: the same values (bytes copied), or shifted by `delta` K."""
        dst = self.src_root / fx.file_key(model, scenario, var, year, version)
        if delta == 0.0:
            shutil.copy(self.src_root / fx.file_key(model, scenario, var, year), dst)
        else:
            import h5py

            shutil.copy(self.src_root / fx.file_key(model, scenario, var, year), dst)
            with h5py.File(dst, "r+") as f:
                x = f[var]
                for lat, lon in fx.LAND:
                    i, j = round((lat - fx.LAT0) / fx.STEP), round((lon - fx.LON0) / fx.STEP)
                    if fx.MODELS[model]["descending"]:
                        i = fx.NLAT - 1 - i
                    x[:, i, j] = x[:, i, j] + np.float32(delta)
        return dst

    def test_a_new_version_with_the_same_values_keeps_the_revision(self):
        self.copy(plans=self.plans(("SYN-A",), ("historical",)))
        self._new_version("SYN-A", "historical", "pr", 2013, "v1.2")
        out = self.copy(plans=self.plans(("SYN-A",), ("historical",)))
        self.assertEqual(out["products"]["cmip6/SYN-A/historical"]["replaced"], 1)
        m = manifest.read(self.mirror, "cmip6/SYN-A/historical")
        self.assertEqual((m["revision"], m["changes"]), (1, []))
        pr = [f for f in m["files"] if "/pr/" in f["url"]]
        self.assertEqual(sorted(f["version"] for f in pr), ["v1.0", "v1.2"])  # 2014 still v1.0, 2013 now v1.2
        self.assertNotIn(c6.file_url(fx.file_key("SYN-A", "historical", "pr", 2013)), {f["url"] for f in m["files"]})

    def test_a_new_version_with_other_values_is_a_revision_with_its_change(self):
        self.copy(plans=self.plans(("SYN-B",), ("ssp245",)))
        self._new_version("SYN-B", "ssp245", "tasmax", 2066, "v2.0", delta=1.0)
        out = self.copy(plans=self.plans(("SYN-B",), ("ssp245",)))
        self.assertEqual(out["products"]["cmip6/SYN-B/ssp245"]["changed"], 1)
        m = manifest.read(self.mirror, "cmip6/SYN-B/ssp245")
        self.assertEqual(m["revision"], 2)
        self.assertEqual(len(m["changes"]), 1)
        ch = m["changes"][0]
        self.assertEqual((ch["revision"], ch["days"], ch["cellsChanged"]), (2, ["2066-01-01", "2066-12-31"], len(fx.LAND)))
        self.assertAlmostEqual(ch["maxAbsDiff"], 1.0, places=3)
        entry = next(f for f in m["files"] if "tasmax" in f["url"] and "_2066" in f["url"])
        self.assertEqual((entry["version"], entry["revision"]), ("v2.0", 2))
        # The unchanged files keep revision 1.
        self.assertEqual({f["revision"] for f in m["files"] if f is not entry}, {1})
        lat, lon = fx.BLOCK[2]
        r, c = cell(lat, lon)
        np.testing.assert_allclose(self.array("cmip6/SYN-B/ssp245", "tasmax")[2066 - 2015, :, r, c], expected_months("SYN-B", "ssp245", "tasmax", 2066, lat, lon) + 1.0, rtol=1e-5)

    def test_a_change_over_values_the_copy_no_longer_holds_claims_every_cell(self):
        self.copy(plans=self.plans(("SYN-C",), ("ssp245",)))
        # As if a run had written new chunks and died before its manifest.
        import zarr

        a = zarr.open_array(store=zarr.storage.LocalStore(self.root), path="cmip6/SYN-C/ssp245/tasmax_c", mode="r+")
        a[2036 - 2015] = np.asarray(a[2036 - 2015]) + 3.0
        self._new_version("SYN-C", "ssp245", "tasmax", 2036, "v1.1", delta=0.25)
        self.copy(plans=self.plans(("SYN-C",), ("ssp245",)))
        ch = manifest.read(self.mirror, "cmip6/SYN-C/ssp245")["changes"][0]
        self.assertEqual((ch["cellsChanged"], ch["maxAbsDiff"]), (110 * 124, c6.UNKNOWN_MAX_ABS_DIFF))

    def test_a_product_never_mixes_calendars_or_variants(self):
        self.copy(plans=self.plans(("SYN-A",), ("historical",)))
        p = self.plans(("SYN-A",), ("historical",))[0]
        p.variant = "r9i1p1f1"
        months = {v: np.zeros((12, 110, 124), np.float32) for v in c6.VARIABLES}
        with self.assertRaisesRegex(ValueError, "holds variant 'r1i1p1f1'"):
            c6.write_year(self.mirror, "SYN-A", "historical", 2013, months, c6.group_attrs("SYN-A", "historical", "r9i1p1f1", "gn", "proleptic_gregorian"))
        with self.assertRaisesRegex(ValueError, "holds calendar"):
            c6.write_year(self.mirror, "SYN-A", "historical", 2013, months, c6.group_attrs("SYN-A", "historical", "r1i1p1f1", "gn", "noleap"))

    def test_tasmin_above_tasmax_fails_the_year(self):
        import h5py

        path = self.src_root / fx.file_key("SYN-A", "historical", "tasmin", 2013)
        with h5py.File(path, "r+") as f:
            i, j = round((fx.CORNER[0] - fx.LAT0) / fx.STEP), round((fx.CORNER[1] - fx.LON0) / fx.STEP)
            f["tasmin"][:, i, j] = f["tasmin"][:, i, j] + np.float32(20)
        with self.assertRaisesRegex(c6.ImplausibleValueError, "tasmin is .* above its mean tasmax"):
            self.copy(plans=self.plans(("SYN-A",), ("historical",)))
        self.assertIsNone(manifest.read(self.mirror, "cmip6/SYN-A/historical"))


class RangeS3(fakes3.FakeS3):
    """A fake of the source bucket: ranged GETs, sizes, ETags and dates in the listing."""

    ranges: list = []

    def get_object(self, Bucket, Key, Range=None):
        self.ranges.append(Range)
        out = super().get_object(Bucket, Key)
        if Range:
            lo, hi = (int(x) for x in Range.removeprefix("bytes=").split("-"))
            out["Body"] = fakes3._Body(self.objects[(Bucket, Key)][lo : hi + 1])
        return out

    def get_paginator(self, name):
        fake = self

        class _P:
            def paginate(self, Bucket, Prefix):
                keys = sorted(k for b, k in fake.objects if b == Bucket and k.startswith(Prefix))
                yield {"Contents": [{"Key": k, "Size": len(fake.objects[(Bucket, k)]), "ETag": fake.etag(fake.objects[(Bucket, k)]), "LastModified": dt.datetime(2024, 3, 5, 10, 0, tzinfo=dt.UTC)} for k in keys]}

        return _P()


class S3(Tree):
    def test_reads_the_bucket_in_ranges_and_writes_a_staged_s3_copy(self):
        src = RangeS3()
        src.ranges = []
        for key in fx.write_tree(Path(self.tmp.name) / "s3src", models=("SYN-B",), scenarios=("ssp585",)):
            src.objects[(c6.BUCKET, key)] = (Path(self.tmp.name) / "s3src" / key).read_bytes()
        dst = fakes3.FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://copy-bucket/mirror", dst)
        source = c6.S3Source(src)
        plans = c6.make_plan(source, {"SYN-B": None}, ["ssp585"], FIXTURE_YEARS)
        c6.copy(mirror, source, plans, now=lambda: NOW, log=self.logs.append)
        self.assertIn("mirror/cmip6/SYN-B/ssp585/manifest.json", dst.keys("copy-bucket"))
        self.assertIn("mirror/cmip6/index.json", dst.keys("copy-bucket"))
        m = manifest.read(mirror, "cmip6/SYN-B/ssp585")
        f = m["files"][0]
        self.assertTrue(f["etag"].startswith('"'))
        self.assertEqual(f["lastModified"], "Tue, 05 Mar 2024 10:00:00 GMT")
        # The same aggregates as the local read.
        self.assertEqual({x["url"]: x["valuesSha256"] for x in m["files"]}, {c6.file_url(k): manifest.values_sha256(self.read("SYN-B", "ssp585", *self._var_year(k)).values) for k in (src.keys(c6.BUCKET))})
        # Ranged reads only: every GET of the source names a range.
        self.assertTrue(src.ranges and all(r and r.startswith("bytes=") for r in src.ranges))

    @staticmethod
    def _var_year(key):
        k = manifest.cmip6_file_key(c6.file_url(key))
        return k["var"], k["year"]

    def test_the_range_file_serves_any_slice_through_its_cache(self):
        data = bytes(range(256)) * 40
        s3 = RangeS3()
        s3.ranges = []
        s3.objects[("b", "k")] = data
        f = c6.S3RangeFile(s3, "b", "k", len(data), block=1000, blocks=2)
        f.seek(995)
        self.assertEqual(f.read(10), data[995:1005])
        f.seek(-6, io.SEEK_END)
        self.assertEqual(f.read(100), data[-6:])
        self.assertEqual(f.read(1), b"")
        f.seek(0)
        f.read(5)
        self.assertEqual(f.requests, 4)  # blocks 0, 1, 10, then 0 again (evicted)


class Manifests(unittest.TestCase):
    def sample(self):
        url = c6.file_url(fx.file_key("SYN-A", "ssp245", "pr", 2036, "v1.1"))
        m = manifest.new("cmip6/SYN-A/ssp245")
        m["years"] = {"first": 2036, "last": 2036}
        m["files"] = [{"url": url, "etag": None, "lastModified": None, "size": 1, "valuesSha256": "a" * 64, "revision": 1, "fetchedAt": NOW, "version": "v1.1", "license": None}]
        return m

    def test_the_cmip6_rules(self):
        self.assertEqual(manifest.new("cmip6/SYN-A/ssp245")["grid"]["step"], 0.25)
        manifest.validate(self.sample())
        manifest.loads(manifest.dumps(self.sample()))
        for change, match in [
            (lambda m: m["files"][0].pop("license"), "version and license"),
            (lambda m: m["files"][0].pop("version"), "version and license"),
            (lambda m: m["files"][0].update(version="v1.0"), "file name's version"),
            (lambda m: m["files"][0].update(license=3), "license must be a string or null"),
            (lambda m: m["files"][0].update(url=m["files"][0]["url"].replace("SYN-A_ssp245", "SYN-B_ssp245")), "not a NEX-GDDP-CMIP6 file"),
            (lambda m: m.update(product="cmip6/SYN-A/ssp585"), "another model or scenario"),
            (lambda m: m.update(finalThrough="2036-12-31"), "projection"),
            (lambda m: m["grid"].update(step=0.1), "grid.step must be 0.25"),
        ]:
            m = self.sample()
            change(m)
            with self.assertRaisesRegex(ValueError, match):
                manifest.validate(m)

    def test_only_cmip6_files_carry_a_license(self):
        m = manifest.new("rnl")
        m["files"] = [{"url": "https://x/chirps-v3.0.2024.01.days_p05.nc", "etag": None, "lastModified": None, "size": 1, "valuesSha256": "a" * 64, "revision": 1, "fetchedAt": NOW, "license": "CC0"}]
        with self.assertRaisesRegex(ValueError, "only cmip6's do"):
            manifest.validate(m)

    def test_the_product_names(self):
        self.assertIs(grid.for_product("cmip6/ACCESS-CM2/ssp585"), grid.CMIP6)
        for bad in ("cmip6/SYN-A/ssp126", "cmip6/SYN-A", "cmip6//historical"):
            with self.assertRaises(ValueError, msg=bad):
                grid.for_product(bad)
        self.assertEqual((grid.CMIP6.rows, grid.CMIP6.cols, grid.CMIP6.origin), (110, 124, {"lat": -35.375, "lon": 10.125}))


class Command(Tree):
    def test_plan_and_copy_in_fixtures_mode(self):
        url = f"file://{self.root}"
        self.assertEqual(c6.main(["plan", "--mirror", url, "--source", "fixtures"], log=self.logs.append), 0)
        self.assertIn("cmip6/SYN-C/ssp585: variant r1i1p1f1, grid gn, 6 files (v1.0), 6 to read", self.logs[0])
        self.assertEqual(c6.main(["copy", "--mirror", url, "--source", "fixtures", "--models", "SYN-B", "--scenarios", "historical"], log=self.logs.append), 0)
        self.assertEqual(sorted(p.name for p in (self.root / "cmip6").iterdir()), ["SYN-B", "index.json", "zarr.json"])
        self.logs.clear()
        c6.main(["plan", "--mirror", url, "--source", "fixtures", "--models", "SYN-B", "--scenarios", "historical"], log=self.logs.append)
        self.assertIn("0 to read", self.logs[0])
        # A local tree in the bucket's layout (--source <dir>) reads the same files into the same aggregates.
        other = self.root.parent / "other"
        with unittest.mock.patch.dict(c6.MODELS, {"SYN-B": None}, clear=True), unittest.mock.patch.dict(c6.YEARS, FIXTURE_YEARS):
            self.assertEqual(c6.main(["copy", "--mirror", f"file://{other}", "--source", str(self.src_root), "--scenarios", "historical"], log=self.logs.append), 0)
        a, b = (json.loads((r / "cmip6/SYN-B/historical/manifest.json").read_text())["files"] for r in (self.root, other))
        self.assertEqual([(f["url"], f["valuesSha256"]) for f in a], [(f["url"], f["valuesSha256"]) for f in b])

    def test_bad_arguments(self):
        import contextlib

        for extra in (["--models", "NOPE"], ["--scenarios", "ssp126"]):
            err = io.StringIO()
            with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
                c6.main(["copy", "--mirror", f"file://{self.root}", "--source", "fixtures", *extra])
            self.assertIn("NOPE" if "--models" in extra else "ssp126", err.getvalue())
        self.assertFalse(self.root.exists())

    def test_not_in_the_image(self):
        import re

        files = [f for ln in (HERE / "Dockerfile").read_text().splitlines() if ln.startswith("COPY ") for f in re.findall(r"(\S+\.py)", ln)]
        self.assertNotIn("cmip6_delta.py", files)


class BackendFixture(unittest.TestCase):
    """The committed copy the backend reads (backend/scripts/cmip6-fixture.ts) has the layout this writer writes."""

    def test_the_committed_cmip6_products_have_this_writers_layout(self):
        import zarr

        self.assertTrue((BACKEND_FIXTURE / "index.json").exists(), "run pnpm gen:mirror-fixture")
        root = BACKEND_FIXTURE.parent
        store = zarr.storage.LocalStore(root)
        idx = json.loads((BACKEND_FIXTURE / "index.json").read_text())
        self.assertEqual(sorted(idx["products"]), ["SYN-A", "SYN-B", "SYN-C"])
        for model, scenarios in idx["products"].items():
            self.assertEqual(list(scenarios), list(c6.SCENARIOS))
            for scenario, years in scenarios.items():
                product = c6.product_of(model, scenario)
                g = zarr.open_group(store=store, path=product, mode="r")
                self.assertEqual(set(g.attrs), set(c6.group_attrs(model, scenario, "v", "g", "c")), product)
                self.assertEqual((g.attrs["model"], g.attrs["scenario"], g.attrs["firstYear"], g.attrs["grid"]), (model, scenario, c6.RECORD[scenario][0], grid.CMIP6.attrs["grid"]))
                # The same words as this writer's, and the synthetic tree's variant, grid label and calendar.
                for k in ("source", "licence", "credit", "citation", "method", "variables", "region"):
                    self.assertEqual(g.attrs[k], c6.group_attrs(model, scenario, "v", "g", "c")[k], f"{product} {k}")
                spec = fx.MODELS[model]
                self.assertEqual((g.attrs["variant"], g.attrs["gridLabel"], g.attrs["calendar"]), (spec["variant"], spec["grid"], spec["calendar"]))
                self.assertEqual(years, list(fx.YEARS[scenario]))
                for var, name in c6.ARRAYS.items():
                    a = zarr.open_array(store=store, path=f"{product}/{name}", mode="r")
                    first, last = c6.RECORD[scenario]
                    self.assertEqual((a.shape, a.chunks, tuple(a.metadata.dimension_names), a.dtype), ((last - first + 1, 12, 110, 124), c6.CHUNKS, c6.DIMS, np.float32), f"{product}/{name}")
                    self.assertEqual(a.attrs["firstYear"], first)
                    self.assertEqual(a.attrs["units"], "mm" if var == "pr" else "degC")
                m = manifest.loads((root / product / "manifest.json").read_text())
                self.assertEqual(c6.held_years(m), years)
                # The files the synthetic tree's highest versions name, with their license attributes.
                want = {}
                for var in c6.VARIABLES:
                    for y in years:
                        key = (model, scenario, var, y)
                        lic = None if key in fx.NO_LICENSE else fx.OLD_LICENSE if (model, scenario) == ("SYN-C", "historical") else fx.LICENSE
                        want[c6.file_url(fx.file_key(*key, "v1.1" if key in fx.V11 else None))] = lic
                self.assertEqual({f["url"]: f["license"] for f in m["files"]}, want)
                for f in m["files"]:
                    k = manifest.cmip6_file_key(f["url"])
                    a = zarr.open_array(store=store, path=f"{product}/{c6.ARRAYS[k['var']]}", mode="r")
                    self.assertEqual(f["valuesSha256"], manifest.values_sha256(np.asarray(a[k["year"] - c6.RECORD[scenario][0]])), f["url"])


if __name__ == "__main__":
    unittest.main()
