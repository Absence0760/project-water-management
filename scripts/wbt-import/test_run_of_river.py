"""A b023 "dummy dam" flagged as probable run-of-river (issue #54, 2d).

    .venv/bin/python -m unittest discover -s scripts/wbt-import

The browser importer's farms.test.ts checks the same cases with the same text.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import run_of_river_note  # noqa: E402

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
            run_of_river_note("River pool", 1.0, 691200, 0, 0),
            "WARNING: farm River pool: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the "
            "upstream inflow and holds exactly 8 m³/s for one day (691200 m³) and takes none of the farm's own runoff" + TAIL,
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

    def test_less_than_100_percent_upstream_inflow_or_no_dam_is_not_flagged(self):
        self.assertIsNone(run_of_river_note("Off-channel", 0.99, 0.4, 12960, 0.25))
        self.assertIsNone(run_of_river_note("Off-channel", 0, 691200, 0, 0))
        self.assertIsNone(run_of_river_note("No dam", 1.0, 0, 12960, 0))


if __name__ == "__main__":
    unittest.main()
