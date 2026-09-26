"""[Farm demand] gross demand that doesn't follow from the crop areas (issue #54).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import gross_demand_note  # noqa: E402

APAN = [200.0] * 12
DAYS = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30]
FACTORS = {"Orchard": [0.5] * 12, "Vegetables": [0.3] * 12}


def formula(per_crop: dict[str, float], crops=FACTORS) -> list[float]:
    return [sum(a * crops[c][m] * APAN[m] / 1000 / DAYS[m] for c, a in per_crop.items() if c in crops) for m in range(12)]


class GrossDemandNote(unittest.TestCase):
    def test_the_sheet_s_rounding_is_not_flagged(self):
        areas = {"Orchard": 100000, "Vegetables": 20000}
        gross = [round(v, 1) for v in formula(areas)]
        self.assertIsNone(gross_demand_note("A", areas, gross, FACTORS, APAN, DAYS))

    def test_a_typed_demand_with_no_crop_areas_is_flagged(self):
        note = gross_demand_note("Town dam", {"Orchard": 0}, [800.0] * 12, FACTORS, APAN, DAYS)
        self.assertIsNotNone(note)
        self.assertTrue(note.startswith("WARNING: [Farm demand] Town dam: the gross demand in 12 of 12 months"))
        self.assertIn("the workbook has 800 m³/day on average, the crop areas give 0.", note)

    def test_a_formula_that_skips_a_crop_is_flagged(self):
        # The workbook's formula left a crop out (its crop index cell blank): the app's figure is the higher one.
        areas = {"Orchard": 100000, "Vegetables": 200000}
        gross = [round(v, 1) for v in formula({"Orchard": 100000})]
        note = gross_demand_note("B", areas, gross, FACTORS, APAN, DAYS)
        self.assertIsNotNone(note)
        self.assertIn("in 12 of 12 months", note)

    def test_a_difference_under_one_percent_is_not_flagged(self):
        areas = {"Orchard": 1000000}
        gross = [v * 1.009 for v in formula(areas)]
        self.assertIsNone(gross_demand_note("C", areas, gross, FACTORS, APAN, DAYS))

    def test_a_small_farm_s_difference_under_1_m3_is_not_flagged(self):
        areas = {"Orchard": 1000}
        gross = [v + 0.9 for v in formula(areas)]
        self.assertIsNone(gross_demand_note("D", areas, gross, FACTORS, APAN, DAYS))

    def test_undefined_crops_are_left_out_as_the_import_does(self):
        areas = {"Orchard": 100000, "Hops": 50000}
        gross = [round(v, 1) for v in formula({"Orchard": 100000})]
        self.assertIsNone(gross_demand_note("E", areas, gross, FACTORS, APAN, DAYS))


if __name__ == "__main__":
    unittest.main()
