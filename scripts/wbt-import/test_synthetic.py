"""The synthetic b023 workbook fixture can't drift from its generator or from the importer.

    .venv/bin/python -m unittest discover -s scripts/wbt-import

scripts/wbt-import/fixtures/synthetic_b023.* is the fixture the in-browser
importer's parity test compares against (WP-1.31). This test regenerates the
workbook into a temp dir and checks that extract_project.py gives exactly the
committed project JSON and notes, for both the regenerated and the committed
workbook. If it fails after a deliberate importer or generator change, run
`python scripts/wbt-import/make_synthetic_workbook.py` and commit the result
(and the TypeScript port must follow the change).
"""

import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_synthetic_workbook as gen  # noqa: E402


class SyntheticWorkbook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fresh = Path(cls.tmp.name) / gen.WORKBOOK_NAME
        gen.write_workbook(cls.fresh)
        cls.fresh_outputs = gen.expected_outputs(cls.fresh)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def committed(self, name: str) -> str:
        return (gen.FIXTURES / name).read_text(encoding="utf-8")

    def test_the_committed_outputs_match_a_regenerated_workbook(self):
        for name, text in self.fresh_outputs.items():
            with self.subTest(name=name):
                self.assertEqual(text, self.committed(name), f"{name} is stale: rerun make_synthetic_workbook.py")

    def test_the_committed_workbook_gives_the_committed_outputs(self):
        for name, text in gen.expected_outputs(gen.FIXTURES / gen.WORKBOOK_NAME).items():
            with self.subTest(name=name):
                self.assertEqual(text, self.committed(name), f"the committed workbook no longer gives {name}")

    def test_regenerating_is_deterministic(self):
        again = Path(self.tmp.name) / "again" / gen.WORKBOOK_NAME
        again.parent.mkdir()
        gen.write_workbook(again)
        self.assertEqual(again.read_bytes(), self.fresh.read_bytes())

    def test_small_enough_to_commit(self):
        # pre-commit's check-added-large-files caps a file at 500 KB.
        for path in gen.FIXTURES.glob(f"{gen.STEM}*"):
            with self.subTest(path=path.name):
                self.assertLess(path.stat().st_size, 500 * 1024)

    def test_the_fixture_exercises_the_importer_branches(self):
        # A guard on the generator: each case in README "The synthetic workbook" still shows up.
        project = json.loads(self.committed(f"{gen.STEM}.project.json"))
        notes = self.committed(f"{gen.STEM}.notes.txt").splitlines()
        ref_notes = self.committed(f"{gen.STEM}.gauge-reference.notes.txt").splitlines()
        m = project["model"]
        nodes = {n["name"]: n for n in m["nodes"]}

        self.assertIn("Echo Farm", nodes)  # "Echo  Farm" in [Network]: whitespace normalised
        self.assertEqual({n["kind"] for n in m["nodes"]}, {"farm", "gauge"})
        self.assertEqual([n["name"] for n in m["nodes"] if n["downstreamNodeId"] is None], ["Outlet Gauge"])
        self.assertIsNone(nodes["Delta Farm"]["flowShareManual"])  # missing from [Farm spec]
        self.assertEqual(nodes["Charlie Farm"]["flowShareManual"], 0)  # Specific method, blank cell
        self.assertEqual(nodes["Foxtrot Farm"]["divertCapacityM3Day"], 4320)  # typed as text
        self.assertEqual(nodes["India Farm"]["damCapacityM3"], 20)  # the dummy dam is imported as it is, and only flagged
        self.assertEqual(project["settings"]["flowShareMethod"], "manual")
        self.assertEqual(len(m["transfers"]), 6)  # 9 columns: no destination, rate 0 and unknown element dropped
        self.assertEqual([t["months"] for t in m["transfers"]], [[1, 2, 3, 11, 12], [11, 12], [7], [5, 6, 7], [10], list(range(1, 13))])
        # The last two columns' draw formulas are =0: switched off in the workbook, imported disabled (issue #54).
        self.assertEqual([t["enabled"] for t in m["transfers"]], [True, True, True, True, False, False])
        # From India's dummy dam into Delta (no dam, no demand): a river off-take up to capacity (engine 1.14.0); the rest from a dam.
        self.assertEqual([t.get("source", "dam") for t in m["transfers"]], ["dam"] * 5 + ["river"])
        self.assertEqual({k: m["transfers"][5][k] for k in ("handsOffM3Day", "handsOffEwr", "lossPct", "sizing", "topUpDam")}, {"handsOffM3Day": None, "handsOffEwr": False, "lossPct": 0, "sizing": "capacity", "topUpDam": False})
        self.assertIsNone(project["settings"]["simulationStart"])  # [Home] calculates the whole flow record
        # Only what outlived the legacy runoff model (engine 1.0.0): the rain threshold and catchment area.
        self.assertEqual(sorted(project["settings"]["calibration"]), ["catchmentAreaKm2", "rainThresholdMm"])
        self.assertEqual(
            [s["kind"] for s in project["series"]], ["flow_observed_m3s", "flow_logger_m3s", "rain_catchment_mm", "rain_chirps_mm"]
        )
        self.assertEqual({len(s["values"]) for s in project["series"]}, {(gen.END - gen.START).days + 1})
        rain = next(s for s in project["series"] if s["kind"] == "rain_catchment_mm")
        self.assertIn(None, rain["values"])
        self.assertEqual(project["series"][3]["name"], "rain_chirps_mm")  # blank header

        for fragment in (
            "substring match also runs it in months [1, 2]",
            "farm Bravo Farm: [Farm spec] min dam % 0.3 is the workbook's transfer minimum",
            "is missing from [Farm spec]",
            "dam(s) have no surface area",
            "crop Hops X is not in [Crop demand]",
            "WARNING: [Crop demand] crop Fodder E: Dec factor is 0 between Nov 0.5 and Jan 0.5 (a lone month out of the ground)",
            "WARNING: [Crop demand] crop Pasture F: its 12 factors are the same as Pasture C's",
            "farm Kilo Farm is not in [Network]",
            "names an unknown element; skipped",
            "run(s) of zero rain",
            "Pitman flow column has 120 days",
            "no Element sheet for Hotel Farm",
            "WARNING: [Farm demand] Charlie Farm: the gross demand in 12 of 12 months doesn't follow from its crop areas",
            "WARNING: farm India Farm: probable run-of-river",
        ):
            with self.subTest(note=fragment):
                self.assertEqual(sum(fragment in n for n in notes), 1, fragment)
        self.assertTrue(any("imported as flow_reference_m3s" in n and "divided by 0.8" in n for n in ref_notes))
        # Charlie Farm's typed-over demand (no crops) is imported as a municipal demand object (issue #54, 2b).
        charlie = next(n for n in project["model"]["nodes"] if n["name"] == "Charlie Farm")
        (town,) = project["model"]["demandObjects"]
        self.assertEqual((town["nodeId"], town["category"], town["monthlyM3Day"]), (charlie["id"], "municipal", [150.0] * 12))
        self.assertTrue(any(n.startswith("WARNING: ") and "runs use the logger record" in n for n in ref_notes))


class Variants(unittest.TestCase):
    """Branches the committed workbook can't reach, on a variant of it (not committed)."""

    def extract(self, **kwargs):
        project, _expected, notes = self.extract_all(**kwargs)
        return project, notes

    def extract_all(self, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / gen.WORKBOOK_NAME
            gen.write_workbook(path)
            return gen.extract(path, **kwargs)

    def test_element_sheets_that_start_after_flow_data_set_the_expected_window(self):
        # A workbook whose gauge record starts decades before the model window (issue #54).
        with unittest.mock.patch.object(gen, "ELEMENT_START_OFFSET", 30):
            project, expected, _ = self.extract_all()
        _, base, _ = self.extract_all()
        self.assertEqual(expected["startDate"], (gen.START + gen.dt.timedelta(days=30)).isoformat())
        self.assertEqual(expected["days"], base["days"] - 30)
        for k, v in expected["catchment"].items():
            with self.subTest(column=k):
                self.assertEqual(v, base["catchment"][k][30:])
        self.assertEqual(len(expected["nodes"]["Alpha Farm"]["demand"]), gen.ELEMENT_DAYS)
        self.assertEqual({s["startDate"] for s in project["series"]}, {gen.START.isoformat()})  # the project keeps every day

    def test_element_sheets_that_start_before_flow_data_are_refused(self):
        with unittest.mock.patch.object(gen, "ELEMENT_START_OFFSET", -5), self.assertRaisesRegex(ValueError, r"outside \[Flow data\]"):
            self.extract_all()

    def test_unknown_fragmentation_method_falls_back_to_area(self):
        with unittest.mock.patch.object(gen, "FRAGMENTATION_METHOD", "Equal shares"):
            project, notes = self.extract()
        self.assertEqual(project["settings"]["flowShareMethod"], "area")
        self.assertIn("unknown fragmentation method 'Equal shares'; using area", notes)

    def test_a_second_root_is_noted(self):
        network = [(n, t, [u for u in ups if u != "Golf Farm"]) for n, t, ups in gen.NETWORK]
        with unittest.mock.patch.object(gen, "NETWORK", network):
            _, notes = self.extract()
        self.assertIn("elements ['Golf Farm', 'Outlet Gauge'] have no downstream element; only Outlet Gauge is the outflow gauge", notes)

    def test_rUseFlow_on_pitman_is_unset_with_a_warning(self):
        with unittest.mock.patch.object(gen, "USE_FLOW", 1):
            project, notes = self.extract()
        self.assertIsNone(project["settings"]["calibrationFlowKind"])
        self.assertTrue(any(n.startswith("WARNING: [Flow data] rUseFlow calibrates against Pitman flow") for n in notes))

    def test_rUseFlow_on_an_empty_series_is_unset(self):
        with unittest.mock.patch.object(gen, "USE_FLOW", 3), unittest.mock.patch.object(gen, "LOGGER_FROM", gen.END + gen.dt.timedelta(days=30)):
            project, notes = self.extract()
        self.assertIsNone(project["settings"]["calibrationFlowKind"])
        self.assertNotIn("flow_logger_m3s", [s["kind"] for s in project["series"]])
        self.assertIn("[Flow data] rUseFlow picks flow_logger_m3s, which has no values; calibrationFlowKind left unset", notes)

    def test_a_calibration_window_that_ends_before_it_starts_is_dropped(self):
        swapped = {"D11": gen.CALIBRATION["D12"], "D12": gen.CALIBRATION["D11"]}
        with unittest.mock.patch.dict(gen.CALIBRATION, swapped):
            project, _ = self.extract()
        self.assertEqual((project["settings"]["calibrationStart"], project["settings"]["calibrationEnd"]), (None, None))


if __name__ == "__main__":
    unittest.main()
