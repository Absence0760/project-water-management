"""[Crop demand] rows copied from another crop and suspect months (issue #289; same rules and text in crops.ts).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import crop_row_findings, crop_table_notes  # noqa: E402

# Invented factors: a smooth curve, and single slips put into it.
SMOOTH = [0.4, 0.45, 0.5, 0.55, 0.55, 0.5, 0.45, 0.4, 0.35, 0.35, 0.35, 0.4]


def put(m: int, v: float, row: list[float] = SMOOTH) -> list[float]:
    return [v if i == m else x for i, x in enumerate(row)]


class CropRowFindings(unittest.TestCase):
    def test_smooth_dormant_and_the_steepest_published_steps_pass(self):
        self.assertEqual(crop_row_findings(SMOOTH), [])
        self.assertEqual(crop_row_findings([0.3, 0.4, 0.5, 0.5, 0.4, 0.3, 0.2, 0, 0, 0, 0.1, 0.2]), [])
        # Pecan's 0.65 <-> 0.35 (ARC Table 4.10): steps of 0.3, no lone month; float noise in 0.65 - 0.35 doesn't count.
        self.assertEqual(crop_row_findings([0.65] * 7 + [0.35] * 3 + [0.65] * 2), [])
        self.assertEqual(crop_row_findings(put(3, 0.85, [0.55] * 12)), [])

    def test_a_lone_zero_wrapping_the_year_end(self):
        self.assertEqual(crop_row_findings(put(4, 0)), ["Feb factor is 0 between Jan 0.55 and Mar 0.5 (a lone month out of the ground)"])
        self.assertEqual(crop_row_findings(put(0, 0)), ["Oct factor is 0 between Sep 0.4 and Nov 0.45 (a lone month out of the ground)"])

    def test_a_lone_spike_or_dip(self):
        self.assertEqual(crop_row_findings(put(6, 0.9)), ["Apr factor 0.9 is more than 0.3 above both Mar 0.5 and May 0.4 (a lone spike)"])
        self.assertEqual(crop_row_findings(put(3, 0.1)), ["Jan factor 0.1 is more than 0.3 below both Dec 0.5 and Feb 0.55 (a lone dip)"])
        self.assertEqual(crop_row_findings(put(7, 0.85, put(6, 0.9))), [])

    def test_above_one_and_negative(self):
        self.assertEqual(
            crop_row_findings(put(3, 1.05, put(2, 0.9, put(4, 0.9)))), ["Jan factor 1.05 is above 1 (more water than an open A-pan loses)"]
        )
        self.assertEqual(crop_row_findings(put(5, -0.2)), ["Mar factor -0.2 is negative"])


class CropTableNotes(unittest.TestCase):
    def test_copies_name_the_first_crop_and_skip_their_months(self):
        rows = [("Apples", SMOOTH), ("Plums", put(2, 1.4)), ("Pecans", SMOOTH), ("Pears", put(2, 1.4))]
        crops = [{"name": n, "cropFactor": f} for n, f in rows]
        notes = crop_table_notes(crops)
        self.assertEqual(len(notes), 3)
        self.assertTrue(notes[0].startswith("WARNING: [Crop demand] crop Plums: Dec factor 1.4 is more than 0.3 above both"))
        self.assertEqual(
            notes[1],
            "WARNING: [Crop demand] crop Pecans: its 12 factors are the same as Apples's, a row copied from another crop by the look "
            "of it; imported as they are, so give it its own curve if it has one (issue #289)",
        )
        self.assertIn("crop Pears: its 12 factors are the same as Plums's", notes[2])

    def test_zeros_a_repeated_name_and_a_near_copy_pass(self):
        rows = [("Spare 1", [0.0] * 12), ("Spare 2", [0.0] * 12), ("Apples", SMOOTH), ("Apples", SMOOTH), ("Quince", put(0, 0.41))]
        crops = [{"name": n, "cropFactor": f} for n, f in rows]
        self.assertEqual(crop_table_notes(crops), [])


if __name__ == "__main__":
    unittest.main()
