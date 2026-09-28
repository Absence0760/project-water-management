"""Importer fixes from a hydrology check of the b023 import (issue #54).

    .venv/bin/python -m unittest discover -s scripts/wbt-import

A transfer whose draw formula is the constant 0 imports switched off; the run
covers [Home]'s calculation window when it cuts [Flow data] short; the summary
line gives the span the series cover. The browser importer's transfers.test.ts
and modelWindow.test.ts check the same cases with the same text.
"""

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import is_zero_formula, model_window, series_span, transfer_off_note  # noqa: E402


class ZeroFormula(unittest.TestCase):
    def test_a_constant_zero_is_switched_off(self):
        for f in ["=0", "0", " = 0 ", "=0.0", 0, 0.0]:
            self.assertTrue(is_zero_formula(f), repr(f))

    def test_a_real_draw_or_a_blank_is_not(self):
        for f in ["=IF(fIsMthIn($H7, O$14), fGetTrfVolCapped('Farm A'!$Q6,O$10,O$11,O$16), 0)", "", None, "=10", 1, False]:
            self.assertFalse(is_zero_formula(f), repr(f))

    def test_the_warning_text(self):
        self.assertEqual(
            transfer_off_note("Farm A", "Farm B", "O"),
            "WARNING: transfer Farm A -> Farm B (column O): its draw formula is the constant 0, so the workbook never moved "
            "this water; it is imported switched off (Transfers tab, Enabled) (issue #54)",
        )


class FakeWorkbook:
    """Just the ref / block calls model_window makes."""

    def __init__(self, cells: dict[str, object]):
        self.cells = cells

    def ref(self, name):
        if name not in self.cells:
            raise KeyError(name)
        return ("Home", 5, 14 if name.endswith("1") else 15, 5, 14)

    def block(self, sheet, c1, r1, c2, r2):
        return [[self.cells["zHome_CalcDate1" if r1 == 14 else "zHome_CalcDateN"]]]


DATES = ["1960-01-01", "1960-01-02", "2001-10-01", "2024-09-29", "2024-09-30"]


def home(d1, dn):
    cells = {}
    if d1 is not None:
        cells["zHome_CalcDate1"] = dt.datetime.fromisoformat(d1)
    if dn is not None:
        cells["zHome_CalcDateN"] = dt.datetime.fromisoformat(dn)
    return FakeWorkbook(cells)


class ModelWindow(unittest.TestCase):
    def test_the_home_window_when_it_cuts_the_flow_record_short(self):
        self.assertEqual(
            model_window(home("2001-10-01", "2024-09-29"), DATES),
            (
                "2001-10-01",
                "2024-09-29",
                "[Home] the workbook calculates 2001-10-01 to 2024-09-29, inside [Flow data]'s 1960-01-01 to 2024-09-30: "
                "runs cover that window (settings.simulationStart / End); every series keeps its full record",
            ),
        )
        self.assertEqual(model_window(home("2001-10-01", "2024-09-30"), DATES)[:2], ("2001-10-01", None))

    def test_the_whole_record_otherwise(self):
        for d1, dn in [("1960-01-01", "2024-09-30"), ("1940-01-01", "2030-01-01"), ("2024-09-29", "2001-10-01"), (None, None)]:
            self.assertEqual(model_window(home(d1, dn), DATES), (None, None, None), (d1, dn))


class SeriesSpan(unittest.TestCase):
    def test_the_span_all_series_cover(self):
        series = [{"startDate": "1960-01-01", "values": [0] * 3}, {"startDate": "1960-01-02", "values": [0] * 5}]
        self.assertEqual(series_span(series), "6 days from 1960-01-01")
        self.assertEqual(series_span([]), "no days")


if __name__ == "__main__":
    unittest.main()
