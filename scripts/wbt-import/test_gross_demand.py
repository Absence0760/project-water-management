"""[Farm demand] gross demand that doesn't follow from the crop areas (issue #54).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import gross_demand_note, non_crop_demand, non_crop_demand_object  # noqa: E402

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


class NonCropDemand(unittest.TestCase):
    """The part of the gross demand above the crop areas becomes a demand object (issue #54, 2b)."""

    def test_a_typed_demand_with_no_crops_is_all_non_crop(self):
        self.assertEqual(non_crop_demand({"Orchard": 0}, [800.0] * 12, FACTORS, APAN, DAYS), [800.0] * 12)
        note = gross_demand_note("Town dam", {"Orchard": 0}, [800.0] * 12, FACTORS, APAN, DAYS)
        self.assertIn('is imported as the demand object "Non-crop demand"', note)
        self.assertIn("The part above the crop areas, 800 m³/day on average", note)

    def test_a_typed_demand_on_top_of_crops_keeps_the_crops_and_adds_the_rest(self):
        areas = {"Orchard": 100000}
        crops = formula(areas)
        gross = [round(v, 1) + (300.0 if m < 6 else 0.0) for m, v in enumerate(crops)]
        extra = non_crop_demand(areas, gross, FACTORS, APAN, DAYS)
        self.assertIsNotNone(extra)
        for m in range(12):
            # Six months typed over; the rest are the formula within the sheet's rounding, so none.
            self.assertAlmostEqual(extra[m], 300.0 if m < 6 else 0.0, delta=0.06)
        # Crops + the object give the workbook's demand in every month, to the sheet's rounding.
        for m in range(12):
            self.assertAlmostEqual(crops[m] + extra[m], gross[m], delta=0.06)

    def test_a_formula_that_skips_a_crop_gives_no_object(self):
        areas = {"Orchard": 100000, "Vegetables": 200000}
        gross = [round(v, 1) for v in formula({"Orchard": 100000})]
        self.assertIsNone(non_crop_demand(areas, gross, FACTORS, APAN, DAYS))
        note = gross_demand_note("B", areas, gross, FACTORS, APAN, DAYS)
        self.assertIn("The app computes demand from the crop areas, so it models the second figure", note)

    def test_both_directions_say_both(self):
        areas = {"Orchard": 100000}
        gross = [v + (500.0 if m == 0 else -200.0 if m == 1 else 0.0) for m, v in enumerate(formula(areas))]
        note = gross_demand_note("M", areas, gross, FACTORS, APAN, DAYS)
        self.assertIn("in 2 of 12 months", note)
        self.assertIn("In 1 month(s) the crop areas give more than the workbook", note)
        self.assertEqual([round(v, 6) for v in non_crop_demand(areas, gross, FACTORS, APAN, DAYS)], [500.0] + [0.0] * 11)

    def test_the_object_returns_the_farm_s_return_flow_and_is_municipal_without_crops(self):
        uid = lambda key: f"id:{key}"  # noqa: E731
        town = non_crop_demand_object(uid, "Town dam", "n1", [800.0] * 12, cropped=False, return_pct=0.2)
        self.assertEqual(town["category"], "municipal")
        self.assertEqual(town["returnPct"], 0.2)
        self.assertEqual((town["sizing"], town["priority"], town["destination"], town["enabled"]), ("monthly", "shared", "internal", True))
        self.assertEqual(town["id"], "id:demand-object:Town dam")
        self.assertEqual(non_crop_demand_object(uid, "Farm", "n2", [1.0] * 12, cropped=True, return_pct=0)["category"], "other")


if __name__ == "__main__":
    unittest.main()
