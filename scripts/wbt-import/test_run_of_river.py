"""A b023 "dummy dam" flagged as probable run-of-river (issue #54, 2d).

    .venv/bin/python -m unittest discover -s scripts/wbt-import

The browser importer's farms.test.ts checks the same cases with the same text.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import as_run_of_river, extract, run_of_river_note  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "synthetic_b023.xlsx"

TAIL = (
    ". b023 has no river abstraction, so a unit that pumps from the river is entered as a dummy dam; the app imports it "
    "as a farm dam, so its dam results (storage, spill, level) mean nothing (issue #54, 2d)"
)


class RunOfRiverNote(unittest.TestCase):
    def test_a_pool_with_a_large_diversion_is_flagged(self):
        self.assertEqual(
            run_of_river_note("Pump unit", 1.0, 0.4, 12960, 0.25),
            "WARNING: farm Pump unit: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the "
            "upstream inflow and is a pool of 0.4 m³ against a diversion capacity of 12960 m³/day" + TAIL,
        )

    def test_a_placeholder_under_1_m3_is_flagged_without_a_diversion(self):
        note = run_of_river_note("Pump unit", 1.0, 0.5, 0, 0)
        self.assertIsNotNone(note)
        self.assertIn("and is a pool of 0.5 m³. b023", note)

    def test_a_dam_holding_a_whole_number_of_m3_s_for_one_day_is_flagged(self):
        self.assertEqual(
            run_of_river_note("River pool", 1.0, 259200, 0, 0),
            "WARNING: farm River pool: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the "
            "upstream inflow and holds exactly 3 m³/s for one day (259200 m³) and takes none of the farm's own runoff" + TAIL,
        )
        self.assertIsNotNone(run_of_river_note("One cumec", 1.0, 86400.4, 0, 0))

    def test_a_real_on_channel_dam_with_all_the_upstream_inflow_is_not_flagged(self):
        # Negative controls: 100 % upstream inflow, but real storage.
        self.assertIsNone(run_of_river_note("Farm dam", 1.0, 310000, 0, 0.35))
        self.assertIsNone(run_of_river_note("Farm dam", 1.0, 240000, 12960, 0))  # not a whole day of m³/s
        self.assertIsNone(run_of_river_note("Small dam", 1.0, 4000, 12960, 0.15))  # 31 % of a day's diversion
        self.assertIsNone(run_of_river_note("Rounded dam", 1.0, 432000, 12960, 0.2))  # 5 m³/s x 1 day, but catches its runoff

    def test_a_pool_just_over_1_percent_of_the_diversion_is_not_flagged(self):
        self.assertIsNotNone(run_of_river_note("Pool", 1.0, 129.5, 12960, 0.25))
        self.assertIsNone(run_of_river_note("Pond", 1.0, 129.7, 12960, 0.25))

    def test_less_than_100_percent_upstream_inflow_is_not_flagged(self):
        self.assertIsNone(run_of_river_note("Off-channel", 0.99, 0.4, 12960, 0.25))
        self.assertIsNone(run_of_river_note("Off-channel", 0, 259200, 0, 0))
        self.assertIsNone(run_of_river_note("No dam", 0.5, 0, 12960, 0))

    def test_no_dam_with_all_the_upstream_inflow_is_flagged(self):
        # The engine lets a dam-less farm irrigate from the river routed to it, with no limit (issue #54).
        self.assertEqual(
            run_of_river_note("No dam", 1.0, 0, 12960, 0),
            "WARNING: farm No dam: probable run-of-river, for the modeller to confirm: it has no dam but takes 100 % of the "
            "upstream inflow, and a farm without a dam irrigates straight from the river routed to it, with no pump limit. Set its supply rule to run of river with a pump capacity to cap it (issue #54, 2d)",
        )


class RunOfRiverOption(unittest.TestCase):
    """--run-of-river: the flagged units imported with the run-of-river supply rule (issue #54, 2c/2d)."""

    def test_a_dummy_dam_loses_its_storage_and_gets_an_uncapped_pump(self):
        node = {"name": "River pool", "damCapacityM3": 259200.0, "damInitialPct": 0.5}
        note = as_run_of_river(node, source_of_transfer=False)
        self.assertEqual(node, {"name": "River pool", "damCapacityM3": 0, "damInitialPct": 0, "supplyRule": "runOfRiver", "pumpCapacityM3Day": None})
        self.assertTrue(note.startswith("WARNING: farm River pool: imported as run of river (--run-of-river): its 259200 m³ dummy dam is dropped"))
        self.assertIn("so the pump is uncapped and each run warns", note)

    def test_a_dam_an_enabled_transfer_draws_on_is_left_alone(self):
        node = {"name": "Source", "damCapacityM3": 259200.0, "damInitialPct": 0.5}
        note = as_run_of_river(node, source_of_transfer=True)
        self.assertEqual(node["damCapacityM3"], 259200.0)
        self.assertNotIn("supplyRule", node)
        self.assertIn("not imported as run of river", note)

    def test_off_by_default_and_on_it_converts_exactly_the_flagged_units(self):
        plain, _, plain_notes = extract(FIXTURE)
        ror, _, notes = extract(FIXTURE, run_of_river=True)
        self.assertFalse(any("supplyRule" in n for n in plain["model"]["nodes"]))
        self.assertFalse(any("--run-of-river" in n for n in plain_notes))
        by_name = {n["name"]: n for n in ror["model"]["nodes"]}
        converted = sorted(n["name"] for n in ror["model"]["nodes"] if n.get("supplyRule") == "runOfRiver")
        flagged = sorted(n.removeprefix("WARNING: farm ").split(":")[0] for n in plain_notes if "probable run-of-river" in n)
        self.assertEqual(converted, flagged)
        self.assertEqual(converted, ["Delta Farm", "India Farm"])
        self.assertEqual(by_name["India Farm"]["damCapacityM3"], 0)
        self.assertIsNone(by_name["India Farm"]["pumpCapacityM3Day"])
        self.assertEqual(sum("imported as run of river" in n for n in notes), 2)
        # Everything else is the default import.
        others = [n for n in ror["model"]["nodes"] if n["name"] not in converted]
        self.assertEqual(others, [n for n in plain["model"]["nodes"] if n["name"] not in converted])


if __name__ == "__main__":
    unittest.main()
