"""apan_grid.py: the modelled Class-A pan grid (PenPan) end to end against
power_fixture.FakePower's synthetic weather (no network), and its validation
against invented stations (fixtures/apan/stations.synthetic.csv: SYN-PAN-1 …
3, made-up values; SYN-PAN-3 lies outside the tests' box on purpose).

    ingest/.venv/bin/python -m unittest test_apan_grid   (from ingest/)
"""

import csv
import datetime as dt
import gzip
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import apan_grid  # noqa: E402
import penpan  # noqa: E402
import polite  # noqa: E402
import power_fixture  # noqa: E402

BOX = (20.5, -34.5, 22.5, -32.5)
STATIONS = HERE / "fixtures" / "apan" / "stations.synthetic.csv"
#: The committed output, read by backend/src/geo/penpanGrid.test.ts (the TS side reads what Python writes).
FIXTURE = HERE / "fixtures" / "apan" / "penpan.synthetic.json"


def fixture_text() -> str:
    """The committed fixture: one year (2020) of FakePower's weather over BOX, gridded with the defaults."""
    with tempfile.TemporaryDirectory() as d:
        apan_grid.fetch(polite.PoliteClient(min_interval=0.0, opener=power_fixture.FakePower(latest=dt.date(2025, 1, 1)), sleep=lambda s: None), [2020], d, BOX, log=lambda s: None)
        doc = apan_grid.grid_doc([apan_grid.read_reduced(apan_grid.reduced_path(d, 2020))], BOX)
    return json.dumps({"_comment": "Synthetic: PenPan from power_fixture.FakePower's invented weather (test_apan_grid.py --write-fixture), not NASA data.", **doc}, indent=None) + "\n"


def client(fake):
    return polite.PoliteClient(min_interval=0.0, opener=fake, sleep=lambda s: None)


def expected_means(lat, lon, year, month):
    """The month's mean of FakePower's daily values at a point, as fetch reduces them."""
    days = [d for d in apan_grid.year_days(year) if d.month == month]
    v = lambda p: [power_fixture.value(p, d, lat, lon) for d in days]  # noqa: E731
    mean = lambda xs: sum(xs) / len(xs)  # noqa: E731
    return {
        "tmax": mean(v("T2M_MAX")),
        "tmin": mean(v("T2M_MIN")),
        "ea": mean([penpan.sat_vapour_pressure(x) for x in v("T2MDEW")]),
        "u2": mean(v("WS2M")),
        "rs": mean(v("ALLSKY_SFC_SW_DWN")),
        "p": mean(v("PS")),
    }


class Fetch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_one_request_per_parameter_tile_and_year_reduced_to_monthly_means(self):
        fake = power_fixture.FakePower(latest=dt.date(2025, 1, 1))
        written = apan_grid.fetch(client(fake), [2019, 2020], self.dir, BOX, log=lambda s: None)
        self.assertEqual([os.path.basename(p) for p in written], ["2019.power-monthly.json", "2020.power-monthly.json"])
        self.assertEqual(len(fake.requests), 2 * 6)  # one tile, six parameters, two years
        self.assertTrue(all("community=AG" in u and ("start=20190101" in u or "start=20200101" in u) for u in fake.requests))
        doc = apan_grid.read_reduced(apan_grid.reduced_path(self.dir, 2020))
        self.assertEqual(doc["variables"], list(apan_grid.VARIABLES))
        self.assertEqual(len(doc["points"]), 16)  # 4 x 4 points of FakePower's 0.5° lattice in the box
        lat, lon, means = next(p for p in doc["points"] if p[0] == -33.75 and p[1] == 21.25)
        want = expected_means(-33.75, 21.25, 2020, 2)  # a leap February: 29 days
        for k in apan_grid.VARIABLES:
            self.assertAlmostEqual(means[k][1], want[k], places=3, msg=k)

    def test_a_year_already_reduced_is_not_asked_again(self):
        fake = power_fixture.FakePower(latest=dt.date(2025, 1, 1))
        apan_grid.fetch(client(fake), [2020], self.dir, BOX, log=lambda s: None)
        n = len(fake.requests)
        self.assertEqual(apan_grid.fetch(client(fake), [2020], self.dir, BOX, log=lambda s: None), [])
        self.assertEqual(len(fake.requests), n)

    def test_a_missing_day_leaves_the_points_month_null(self):
        fake = power_fixture.FakePower(latest=dt.date(2025, 1, 1), fill={("WS2M", dt.date(2020, 3, 14), -33.75, 21.25)})
        apan_grid.fetch(client(fake), [2020], self.dir, BOX, log=lambda s: None)
        doc = apan_grid.read_reduced(apan_grid.reduced_path(self.dir, 2020))
        means = next(p[2] for p in doc["points"] if p[0] == -33.75 and p[1] == 21.25)
        self.assertIsNone(means["u2"][2])
        self.assertIsNotNone(means["u2"][1])
        self.assertIsNotNone(means["rs"][2])

    def test_a_403_stops_the_fetch(self):
        with self.assertRaises(polite.StopRun):
            apan_grid.fetch(client(power_fixture.FakePower(refuse=403)), [2020], self.dir, BOX, log=lambda s: None)
        self.assertFalse(os.path.exists(apan_grid.reduced_path(self.dir, 2020)))


class Grid(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        apan_grid.fetch(client(power_fixture.FakePower(latest=dt.date(2025, 1, 1))), [2019, 2020], cls.tmp.name, BOX, log=lambda s: None)
        cls.years = [apan_grid.read_reduced(apan_grid.reduced_path(cls.tmp.name, y)) for y in (2019, 2020)]
        cls.doc = apan_grid.grid_doc(cls.years, BOX)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_apan_form_labelled_as_modelled(self):
        d = self.doc
        self.assertEqual((d["kind"], d["cellDeg"], d["firstYear"], d["lastYear"]), ("apan", 0.1, 2019, 2020))
        self.assertTrue(d["source"].startswith("Modelled Class-A pan (PenPan)"))
        self.assertIn("not a measured pan", d["source"])
        self.assertEqual(d["model"]["name"], "penpan")
        self.assertEqual((d["model"]["groundAlbedo"], d["model"]["screen"]), (0.23, 1.0))
        self.assertIn("(POWER) Project, CC BY 4.0", d["attribution"])

    def test_every_cell_centre_in_the_box_on_x_x5(self):
        cells = self.doc["cells"]
        self.assertEqual(len(cells), 20 * 20)
        lons = sorted({c[0] for c in cells})
        lats = sorted({c[1] for c in cells})
        self.assertEqual((lons[0], lons[-1], lats[0], lats[-1]), (20.55, 22.45, -34.45, -32.55))
        for c in cells:
            self.assertEqual(len(c[2]), 12)
            self.assertTrue(all(0 <= v <= 1000 for v in c[2]))

    def test_a_cell_is_its_nearest_points_penpan_averaged_over_the_years_in_water_year_order(self):
        cell = next(c for c in self.doc["cells"] if c[0] == 21.35 and c[1] == -33.65)  # nearest point: 21.25, -33.75
        cal = []
        for m in range(1, 13):
            tot = []
            for y in (2019, 2020):
                w = expected_means(-33.75, 21.25, y, m)
                tot.append(penpan.monthly_mm(y, m, tmax_c=w["tmax"], tmin_c=w["tmin"], ea_kpa=w["ea"], u2_ms=w["u2"], rs=w["rs"], p_kpa=w["p"], lat_deg=-33.75))
            cal.append(sum(tot) / 2)
        want = [round(x, 1) for x in cal[9:] + cal[:9]]
        for got, exp in zip(cell[2], want):
            self.assertAlmostEqual(got, exp, delta=0.15)
        # Southern summer evaporates more than winter: January (index 3) over July (index 9).
        self.assertGreater(cell[2][3], cell[2][9] * 1.5)

    def test_screen_and_albedo_change_the_values_and_are_recorded(self):
        screened = apan_grid.grid_doc(self.years, BOX, screen=0.93)
        self.assertEqual(screened["model"]["screen"], 0.93)
        a, b = self.doc["cells"][0][2][3], screened["cells"][0][2][3]
        self.assertAlmostEqual(b, a * 0.93, delta=0.2)

    def test_a_point_missing_a_month_is_left_out_and_years_must_run_on(self):
        years = json.loads(json.dumps(self.years))
        p = next(p for p in years[0]["points"] if p[0] == -33.75 and p[1] == 21.25)
        p[2]["rs"][5] = None
        doc = apan_grid.grid_doc(years, BOX)
        self.assertFalse(any(c[0] == 21.35 and c[1] == -33.65 for c in doc["cells"]))
        self.assertEqual(len(doc["cells"]), 400 - 25)
        gap = json.loads(json.dumps(self.years))
        gap[1]["year"] = 2022
        with self.assertRaisesRegex(apan_grid.GridError, "skip from 2019 to 2022"):
            apan_grid.grid_doc(gap, BOX)
        with self.assertRaisesRegex(apan_grid.GridError, "twice"):
            apan_grid.grid_doc([self.years[0], self.years[0]], BOX)

    def test_an_implausible_month_is_refused(self):
        years = json.loads(json.dumps(self.years))
        for p in years[0]["points"]:
            p[2]["u2"][0] = 400.0
        with self.assertRaisesRegex(apan_grid.GridError, "outside 0"):
            apan_grid.grid_doc(years, BOX)

    def test_a_box_beyond_the_points_has_no_cells(self):
        with self.assertRaisesRegex(apan_grid.GridError, "no cell"):
            apan_grid.grid_doc(self.years, (30.0, -25.0, 31.0, -24.0))


class Validate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        apan_grid.fetch(client(power_fixture.FakePower(latest=dt.date(2025, 1, 1))), [2020], cls.tmp.name, BOX, log=lambda s: None)
        cls.doc = apan_grid.grid_doc([apan_grid.read_reduced(apan_grid.reduced_path(cls.tmp.name, 2020))], BOX)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_stations_at_a_known_ratio(self):
        at = apan_grid.grid_lookup(self.doc)
        g1, g2 = at(-33.70, 21.30), at(-33.05, 22.10)
        stations = [
            {"station": "A", "lat": -33.70, "lon": 21.30, "monthly": [v / 1.1 for v in g1]},  # the grid 10 % high
            {"station": "B", "lat": -33.05, "lon": 22.10, "monthly": [v / 1.1 for v in g2]},
            {"station": "C", "lat": -20.0, "lon": 30.0, "monthly": [100.0] * 12},
        ]
        r = apan_grid.validate(self.doc, stations)
        self.assertEqual(r["overall"]["stations"], 2)
        self.assertEqual(r["overall"]["outside"], ["C"])
        self.assertAlmostEqual(r["overall"]["ratio"], 1.1, places=9)
        for m in r["months"]:
            self.assertAlmostEqual(m["ratio"], 1.1, places=9)
            self.assertEqual(m["n"], 2)
            want = [g1[m["month"]] - g1[m["month"]] / 1.1, g2[m["month"]] - g2[m["month"]] / 1.1]
            self.assertAlmostEqual(m["bias"], sum(want) / 2, places=9)
            self.assertAlmostEqual(m["rmse"], math.sqrt((want[0] ** 2 + want[1] ** 2) / 2), places=9)

    def test_the_lookup_returns_january_first(self):
        at = apan_grid.grid_lookup(self.doc)
        cell = next(c for c in self.doc["cells"] if c[0] == 21.35 and c[1] == -33.65)
        self.assertEqual(at(-33.65, 21.35), cell[2][3:] + cell[2][:3])
        self.assertIsNone(at(-10.0, 21.35))

    def test_the_command_writes_the_report(self):
        grid = os.path.join(self.tmp.name, "apan.json.gz")
        with gzip.open(grid, "wt", encoding="utf-8") as f:
            json.dump(self.doc, f)
        out = os.path.join(self.tmp.name, "report.md")
        self.assertEqual(apan_grid.main(["validate", "--grid", grid, "--stations", str(STATIONS), "--out", out]), 0)
        text = Path(out).read_text(encoding="utf-8")
        self.assertIn("# PenPan Class-A pan grid against station pans", text)
        self.assertIn("2 inside the grid, 1 outside it (SYN-PAN-3)", text)
        self.assertIn("| SYN-PAN-1 |", text)
        self.assertIn("| Jan | 2 |", text)
        self.assertIn("hydrologist signs off", text)

    def test_a_bad_station_file_is_refused(self):
        bad = os.path.join(self.tmp.name, "bad.csv")
        with open(bad, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["station", "lat", "lon", *apan_grid.MONTHS])
            w.writerow(["X", "-33", "21", *(["10"] * 11), "-1"])
        with self.assertRaisesRegex(apan_grid.GridError, "negative"):
            apan_grid.read_stations(bad)


class Fixture(unittest.TestCase):
    def test_the_committed_fixture_matches_its_generator(self):
        self.assertEqual(FIXTURE.read_text(encoding="utf-8"), fixture_text(), "re-run: ingest/.venv/bin/python ingest/test_apan_grid.py --write-fixture")


class Command(unittest.TestCase):
    def test_fetch_then_grid_with_fixtures(self):
        with tempfile.TemporaryDirectory() as d:
            box = ",".join(str(x) for x in BOX)
            self.assertEqual(apan_grid.main(["fetch", "--years", "2020", "2020", "--dir", d, "--bbox", box, "--fixtures"]), 0)
            out = os.path.join(d, "apan.json")
            self.assertEqual(apan_grid.main(["grid", "--dir", d, "--years", "2020", "2020", "--out", out, "--bbox", box]), 0)
            doc = json.loads(Path(out).read_text(encoding="utf-8"))
            self.assertEqual((doc["kind"], len(doc["cells"])), ("apan", 400))
            # A year never fetched: refused, naming it.
            self.assertEqual(apan_grid.main(["grid", "--dir", d, "--years", "2020", "2021", "--out", out, "--bbox", box]), 1)


if __name__ == "__main__":
    if sys.argv[1:] == ["--write-fixture"]:
        FIXTURE.write_text(fixture_text(), encoding="utf-8")
        print(f"wrote {FIXTURE}")
    else:
        unittest.main()
