"""Farm and dam operating rules the importer writes (engine >= 0.16.0, docs/engine-audit.md Q5, N1, N2).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
    (or: uv run --no-project --with openpyxl python -m unittest discover -s scripts/wbt-import)
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import farm_operating_rules  # noqa: E402


class OperatingRules(unittest.TestCase):
    def test_q5_the_workbook_min_is_the_transfer_minimum_not_an_operating_level(self):
        notes: list[str] = []
        self.assertEqual(farm_operating_rules("Synthetic farm", {"damMinPct": 0.3}, notes)["damMinPct"], 0)
        self.assertEqual(len(notes), 1)
        self.assertIn("transfer minimum", notes[0])

    def test_q5_no_note_without_a_workbook_min(self):
        notes: list[str] = []
        self.assertEqual(farm_operating_rules("Synthetic farm", {}, notes)["damMinPct"], 0)
        self.assertEqual(notes, [])

    def test_n1_return_flow_becomes_efficiency_with_every_loss_returning(self):
        ops = farm_operating_rules("Synthetic farm", {"returnFlowPct": 0.2}, [])
        self.assertAlmostEqual(ops["irrigationEfficiency"], 0.8)
        self.assertEqual(ops["returnFlowFraction"], 0.2)
        self.assertNotIn("returnFlowPct", ops)

    def test_n1_no_return_flow_is_full_efficiency_and_no_return(self):
        ops = farm_operating_rules("Synthetic farm", {"returnFlowPct": 0}, [])
        self.assertEqual((ops["irrigationEfficiency"], ops["returnFlowFraction"]), (1, 0))

    def test_n1_all_returning_maps_to_the_smallest_efficiency(self):
        self.assertEqual(farm_operating_rules("Synthetic farm", {"returnFlowPct": 1}, [])["irrigationEfficiency"], 0.01)

    def test_n2_no_surface_area_in_the_workbook(self):
        ops = farm_operating_rules("Synthetic farm", {"damCapacityM3": 90000}, [])
        self.assertEqual((ops["damAreaFullM2"], ops["damAreaExponent"], ops["damSeepagePerDay"]), (None, 0.7, 0))


if __name__ == "__main__":
    unittest.main()
