"""wr2012_quat_info.py reads WR2012's quaternary spreadsheets by their header text.

    .venv/bin/python -m unittest discover -s scripts/wbt-import

The spreadsheets are built here, in a temp dir, with invented codes in region
Z and invented numbers laid out as WR2012's "Quat Info WMA nn" files are (a
title, a four-row header, a blank row, then one row per quaternary), once as
most WMAs have it and once shifted by a column with a single MAP column, as
another WMA's file is. Real WR2012 files are never committed.
"""

import csv
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import openpyxl  # noqa: E402

import wr2012_quat_info as q  # noqa: E402

HEADER = [
    ["SPREADSHEET/DATABASE OF QUATERNARY CATCHMENT INFORMATION (SYNTHETIC)"],
    [None, None, None, None, None, None, None, None, None, "NATURALISED FLOW MARs "],
    ["Quaternary catchment", "BASIC INFORMATION", None, None, None, None, None, None, None, "1920 - 1989", "1920 - 2004", "1920 - 2009", "Change in MAR"],
    [None, "Catchment area", None, "S-pan evaporation", None, None, "Rainfall", None, None, "MAR (WR90)", "MAR (WR2005)", "MAR (WR2012)", "WR2005 to WR2012"],
    [None, "Gross", "Net", "evap", "MAE WR2005", "MAE WR90", "Rainfall", "MAP WR90", "MAP WR2005", "Net", "Net", "Net", None, "NETWORK"],
    [None, "(km2)", "(km2)", "zone", "(mm)", "(mm)", "zone", "(mm)", "(mm)", "(mcm)", "(mcm)", "(mcm)", "(percent)"],
    [],
]
ROWS = [
    ["Z01A", 642, 640, "9a", 1500, 1480, "Z1A", 600, 620, 20.1, 21.0, 22.7, 8.1, "→ Z01B"],
    # A part row of a split quaternary: its values in brackets, skipped.
    ["Z01B", "(35)", "(35)", "9A", 1560, 1540, "Z1A", None, "(540)", None, "(3.06)", 5.63],
    ["Z01B", 642, 600, "9A", 1560, 1540, "Z1A", 530, 540, 16.0, 16.5, 17.0, 3.0, "→ Z02A"],
    ["Total", 1284],
]


def write_sheet(path, header, rows, shift=0):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "WMA 99"
    for r in header + rows:
        # Shifted: an extra empty column after the code's, as one WMA's file has.
        ws.append(r[:1] + [None] * shift + r[1:] if r and shift else r)
    wb.save(path)


class QuatInfo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = q.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def read_csv(self, path):
        with open(path, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def test_reads_the_columns_by_header_with_wr2005s_mae_by_default(self):
        f = self.dir / "a.xlsx"
        write_sheet(f, HEADER, ROWS)
        out = self.dir / "values.csv"
        code, stdout, stderr = self.run_main(str(f), "--out", str(out))
        self.assertEqual(code, 0, stderr)
        rows = self.read_csv(out)
        self.assertEqual(list(rows[0]), q.COLUMNS)
        self.assertEqual(
            rows,
            [
                {"code": "Z01A", "area_km2": "642", "map_mm": "620", "mar_mm3": "22.7", "mae_mm": "1500", "evap_zone": "9A", "period_start": "1920", "period_end": "2009"},
                {"code": "Z01B", "area_km2": "642", "map_mm": "540", "mar_mm3": "17", "mae_mm": "1560", "evap_zone": "9A", "period_start": "1920", "period_end": "2009"},
            ],
        )
        self.assertIn("skipped 1 part row(s) whose area isn't a number: Z01B", stderr)
        self.assertIn("MAE WR2005 (S-pan)", stdout)

    def test_wr90s_mae_when_asked_and_says_so_in_the_source(self):
        f = self.dir / "a.xlsx"
        write_sheet(f, HEADER, ROWS)
        out = self.dir / "values.csv"
        code, stdout, _ = self.run_main(str(f), "--out", str(out), "--mae", "wr90")
        self.assertEqual(code, 0)
        self.assertEqual([r["mae_mm"] for r in self.read_csv(out)], ["1480", "1540"])
        self.assertIn("MAE WR90 (S-pan)", stdout)

    def test_a_shifted_sheet_with_one_map_column_reads_the_same(self):
        header = [list(r) for r in HEADER]
        header[4] = [None, "Gross", "Net", "evap", "MAE WR2005", "MAE WR90", "Rainfall", "MAP", None, "Net", "Net", "Net"]
        header[5] = [None, "(km2)", "(km2)", "zone", "(mm)", "(mm)", "zone", "(mm)", None, "(mcm)", "(mcm)", "(mcm)", "(percent)"]
        f = self.dir / "shifted.xlsx"
        write_sheet(f, header, [ROWS[0]], shift=1)
        rows, parts = q.read_sheet(f)
        self.assertEqual(parts, [])
        self.assertEqual(rows[0]["map_mm"], "600")
        self.assertEqual(rows[0]["mae_mm"], "1500")
        self.assertEqual(rows[0]["mar_mm3"], "22.7")
        self.assertEqual(rows[0]["evap_zone"], "9A")

    def test_several_files_make_one_csv_and_a_conflict_is_refused(self):
        a, b = self.dir / "a.xlsx", self.dir / "b.xlsx"
        write_sheet(a, HEADER, ROWS)
        write_sheet(b, HEADER, [ROWS[0], ["Z02A", 600, 600, "9B", 1450, 1440, "Z1A", 680, 700, 25.0, 25.5, 26.0, 2.0]])
        out = self.dir / "values.csv"
        code, _, stderr = self.run_main(str(a), str(b), "--out", str(out))
        self.assertEqual(code, 0, stderr)
        self.assertEqual([r["code"] for r in self.read_csv(out)], ["Z01A", "Z01B", "Z02A"])
        changed = list(ROWS[0])
        changed[4] = 1499
        write_sheet(b, HEADER, [changed])
        code, _, stderr = self.run_main(str(a), str(b), "--out", str(out))
        self.assertEqual(code, 1)
        self.assertIn("refused: Z01A differs between a.xlsx and b.xlsx", stderr)

    def test_refuses_two_files_for_one_wma_unless_one_is_excluded(self):
        a, b = self.dir / "Synthetic Quat Info WMA 99_Jul2015.xlsx", self.dir / "Synthetic Quat Info WMA 99_Jul2015-2.xlsx"
        write_sheet(a, HEADER, ROWS)
        write_sheet(b, HEADER, ROWS)
        out = self.dir / "values.csv"
        code, _, stderr = self.run_main(str(a), str(b), "--out", str(out))
        self.assertEqual(code, 1)
        self.assertIn("refused: two files for WMA 99: Synthetic Quat Info WMA 99_Jul2015.xlsx, Synthetic Quat Info WMA 99_Jul2015-2.xlsx", stderr)
        code, _, stderr = self.run_main(str(a), str(b), "--out", str(out), "--exclude", b.name)
        self.assertEqual(code, 0, stderr)

    def test_refuses_an_xls_a_sheet_without_quaternaries_or_a_missing_column(self):
        code, _, stderr = self.run_main(str(self.dir / "old.xls"), "--out", str(self.dir / "o.csv"))
        self.assertEqual(code, 2)
        self.assertIn("soffice --headless --convert-to xlsx", stderr)
        empty = self.dir / "empty.xlsx"
        write_sheet(empty, HEADER, [])
        with self.assertRaisesRegex(q.SheetError, "no row starts with a quaternary code"):
            q.read_sheet(empty)
        header = [list(r) for r in HEADER]
        header[4] = [None, "Gross", "Net", "evap", "MAE", "MAE WR90"]
        bad = self.dir / "bad.xlsx"
        write_sheet(bad, header, [ROWS[0]])
        with self.assertRaisesRegex(q.SheetError, "no MAE WR2005 column"):
            q.read_sheet(bad)


if __name__ == "__main__":
    unittest.main()
