"""Cell text made one line (issue #385): clean() turns line breaks, tabs and other
control characters into single spaces, as the browser importer's clean() does
(frontend/src/lib/spreadsheet/import/cells.test.ts holds the same cases), because
the app refuses control characters in names (packages/engine/src/names.ts).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import clean, is_name  # noqa: E402

# The engine's NAME_CONTROL_CHARS.
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")

CASES = [
    ("Golf\nFarm", "Golf Farm"),  # Alt+Enter in a cell
    ("Golf\r\nFarm\n", "Golf Farm"),
    ("Echo\t\tFarm", "Echo Farm"),
    ("\x01Alpha\x07 Farm\x1b", "Alpha Farm"),  # C0 controls
    ("Vines\x9fD", "Vines D"),  # C1
    ("a\x7fb", "a b"),  # DEL
    ("a\x85b", "a b"),  # NEL
    ("a\u2028b\u2029c", "a b c"),  # line and paragraph separators
    ("Café Farm", "Café Farm"),
    ("a﻿b", "a﻿b"),  # not whitespace or a control: kept
]


class Clean(unittest.TestCase):
    def test_line_breaks_and_control_characters_become_one_space(self):
        for raw, want in CASES:
            with self.subTest(raw=raw):
                self.assertEqual(clean(raw), want)
                self.assertIsNone(CONTROL.search(clean(raw)))

    def test_a_cell_of_only_control_characters_is_blank(self):
        self.assertEqual(clean("\n\x01\x9f"), "")
        self.assertFalse(is_name("\r\n\x1b"))


if __name__ == "__main__":
    unittest.main()
