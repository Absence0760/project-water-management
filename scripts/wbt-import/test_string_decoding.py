"""The string-decoding fixture can't drift from its generator or from openpyxl (issue #22).

    .venv/bin/python -m unittest discover -s scripts/wbt-import

fixtures/string_decoding.* pins how openpyxl decodes cell text; the in-browser
reader's stringDecoding.test.ts compares against the committed JSON. If this
fails after a deliberate generator change, run
`python scripts/wbt-import/make_string_decoding_fixture.py` and commit the result.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_string_decoding_fixture as gen  # noqa: E402


class StringDecodingFixture(unittest.TestCase):
    def committed_cells(self) -> str:
        return (gen.FIXTURES / gen.CELLS_NAME).read_text(encoding="utf-8")

    def test_the_committed_workbook_is_what_the_generator_writes(self):
        self.assertEqual((gen.FIXTURES / gen.WORKBOOK_NAME).read_bytes(), gen.workbook_bytes())

    def test_the_committed_cells_are_what_openpyxl_reads(self):
        self.assertEqual(gen.dump_cells(gen.read_cells(gen.FIXTURES / gen.WORKBOOK_NAME)), self.committed_cells())

    def test_a_regenerated_workbook_reads_the_same(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / gen.WORKBOOK_NAME
            path.write_bytes(gen.workbook_bytes())
            self.assertEqual(gen.dump_cells(gen.read_cells(path)), self.committed_cells())

    def test_the_fixture_covers_both_cases_of_issue_22(self):
        # A guard on the generator: the two openpyxl behaviours the TypeScript reader must match.
        cells = json.loads(self.committed_cells())
        self.assertEqual(cells["A2"], "Flow_x000D__x000A_(m3/day)")  # _xHHHH_ left as written
        self.assertEqual(cells["B2"], "Alpha &amp; Bravo")  # t="str": one entity decode
        self.assertEqual(cells["A3"], "Literal _x000D_ text")  # shared strings drop 'x005F_'
        self.assertEqual(cells["C1"], "Inline &amp; _x000D_ x005F_")  # inline strings don't
        self.assertEqual(cells["A5"], "CR LF ref\r\nnext")  # a CR written as a reference stays


if __name__ == "__main__":
    unittest.main()
