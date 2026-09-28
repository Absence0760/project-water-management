"""Month-list parsing (docs/engine-audit.md M1).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
    (or: uv run --no-project --with openpyxl python -m unittest discover -s scripts/wbt-import)
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import month_list, substring_extra_months  # noqa: E402


class MonthLists(unittest.TestCase):
    def test_keeps_the_listed_months_only(self):
        # The workbook's FIND("1,", "11,12,") also matches January and February.
        self.assertEqual(month_list("11,12"), [11, 12])
        self.assertEqual(substring_extra_months("11,12"), [1, 2])

    def test_lists_that_already_name_january_and_february_are_unchanged(self):
        for text in ("1,2,3,4,10,11,12", "10,11,12,1,2,3", "4,5,6,7,8,9"):
            self.assertEqual(substring_extra_months(text), [], text)

    def test_cells_holding_a_number_or_spaces(self):
        self.assertEqual(month_list(7.0), [7])
        self.assertEqual(month_list(" 1, 2 , 12"), [1, 2, 12])
        self.assertEqual(month_list(None), [])
        self.assertEqual(month_list("0,13,6"), [6])


if __name__ == "__main__":
    unittest.main()
