"""Farm and dam operating rules the importer writes (engine >= 0.14.0, docs/engine-audit.md Q5).

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


if __name__ == "__main__":
    unittest.main()
