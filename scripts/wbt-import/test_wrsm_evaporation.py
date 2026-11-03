"""wrsm_evaporation.py reads the monthly S-pan and A-pan of WRSM2000 network modules per quaternary.

    .venv/bin/python -m unittest discover -s scripts/wbt-import

The module files are written here, in a temp dir, as WRSM2000 lays them out
(line 1 the number and label, the S-pan on line 4 of a runoff module, the
A-pan on line 8 of an irrigation module), with invented region Z labels and
invented numbers. Real WR2012 configurations are never committed.
"""

import csv
import io
import sys
import tempfile
import unittest
import unittest.mock
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wrsm_evaporation as w  # noqa: E402

SPAN = [140, 195, 240, 245, 200, 185, 115, 65, 42, 41, 58, 90]
APAN = [180, 250, 305, 310, 255, 236, 146, 82, 54, 52, 73, 115]


def row(values):
    return " ".join(f"{v:.2f}" for v in values)


def ru(label, values=SPAN, n=1):
    """A runoff module: S-pan on line 4."""
    return f"    {n} '{label}'  7\n  1  2  3\n 0.5 0.5\n{row(values)}\n 10 20\n".encode("latin-1")


def rr(label, values=APAN, n=4):
    """An irrigation module: a factor row on line 7, A-pan on line 8, crop factors on line 9."""
    lines = [f"  {n}  '{label}' 32", "1", "2", "3", "4", "5", row([1.0] * 11 + [0.9]), row(values), row([0.6] * 12)]
    return ("\n".join(lines) + "\n").encode("latin-1")


class Labels(unittest.TestCase):
    def test_lists_ranges_parts_and_lower_case(self):
        self.assertEqual(w.quaternaries("Z40A,B"), ["Z40A", "Z40B"])
        self.assertEqual(w.quaternaries("CR Z24G-K"), ["Z24G", "Z24H", "Z24J", "Z24K"])
        self.assertEqual(w.quaternaries("Runoff Z22F High MAP"), ["Z22F"])
        self.assertEqual(w.quaternaries("DRR Z40A,B & Z41C"), ["Z40A", "Z40B", "Z41C"])
        self.assertEqual(w.quaternaries("forestry Z10Da"), ["Z10D"])
        self.assertEqual(w.quaternaries("fdam irrg z40b"), ["Z40B"])
        self.assertEqual(w.quaternaries("Alien vegetation"), [])
        self.assertEqual(w.quaternaries("Forestry"), [])


class Summary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, rel, data):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def run_main(self):
        out = self.root / "out.csv"
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = w.main([str(self.root / "net"), "--out", str(out)])
        with open(out, newline="", encoding="utf-8") as fh:
            return code, {r["code"]: r for r in csv.DictReader(fh)}, buf.getvalue()

    def test_reads_s_pan_from_runoff_and_a_pan_from_irrigation_modules(self):
        self.put("net/99 Testland WMA/Z40/Z4RU1.DAT", ru("Z40A,B"))
        self.put("net/99 Testland WMA/Z40/Z4RR4.DAT", rr("DRR Z40A,B"))
        code, rows, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(sorted(rows), ["Z40A", "Z40B"])
        r = rows["Z40A"]
        self.assertEqual([r[f"span_{m}"] for m in w.MONTHS], [str(v) for v in SPAN])
        self.assertEqual([r[f"apan_{m}"] for m in w.MONTHS], [str(v) for v in APAN])
        self.assertEqual(r["span_total_mm"], str(sum(SPAN)))
        self.assertEqual(r["apan_over_span"], f"{sum(APAN) / sum(SPAN):.3f}")
        self.assertEqual((r["span_modules"], r["span_agree"], r["span_files"]), ("1", "1", "Z4RU1.DAT"))
        self.assertEqual(r["wma"], "99 Testland WMA")
        self.assertIn("2 with S-pan, 2 with A-pan", out)

    def test_skips_placeholders_unnamed_sub_modules_and_short_rows(self):
        self.put("net/Z1RU1.DAT", ru("Z10A"))
        self.put("net/Z1RU11.DAT", ru("Z10B", [100] * 12))
        self.put("net/Z1RU111.DAT", ru("Forestry"))
        self.put("net/Z1RR4.DAT", rr("River Irrig Z10A", APAN[:11]))
        self.put("net/Z1RR5.DAT", rr("River Irrig Z10C", [10] * 11 + [11]))
        self.put("net/Z1RV3.DAT", ru("Reservoir Z10D"))
        code, rows, out = self.run_main()
        self.assertEqual(sorted(rows), ["Z10A"])
        self.assertEqual(rows["Z10A"]["apan_oct"], "")
        for why in ["RU: a flat placeholder row", "RU: no quaternary in its label", "RR: no row of 12 numbers", "RR: an implausible annual total"]:
            self.assertIn(f"skipped 1 module file(s): {why}", out)

    def test_reads_a_file_once_from_a_folder_and_a_nested_zip(self):
        data = ru("Z20A")
        self.put("net/Z2/Z2RU1.DAT", data)
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as z:
            z.writestr("Z2/Z2RU1.DAT", data)
        outer = io.BytesIO()
        with zipfile.ZipFile(outer, "w") as z:
            z.writestr("copy/inner.zip", inner.getvalue())
        self.put("net/Z2 copy.zip", outer.getvalue())
        _, rows, out = self.run_main()
        self.assertEqual(rows["Z20A"]["span_modules"], "1")
        self.assertIn("skipped 1 module file(s): the same file again", out)

    def test_keeps_the_row_most_modules_give_and_lists_the_others(self):
        other = [v + 10 for v in SPAN]
        self.put("net/Z3RU1.DAT", ru("Z30A", other, 1))
        self.put("net/Z3RU2.DAT", ru("Z30A", SPAN, 2))
        self.put("net/Z3RU3.DAT", ru("forestry Z30Aa", SPAN, 3))
        # A tie keeps the first by file name.
        self.put("net/Z3RR4.DAT", rr("Irrig Z30A", [v + 5 for v in APAN], 4))
        self.put("net/Z3RR5.DAT", rr("Irrig Z30A", APAN, 5))
        _, rows, out = self.run_main()
        r = rows["Z30A"]
        self.assertEqual(r["span_oct"], str(SPAN[0]))
        self.assertEqual((r["span_modules"], r["span_agree"], r["span_other_totals"], r["span_files"]), ("3", "2", str(sum(other)), "Z3RU2.DAT Z3RU3.DAT"))
        self.assertEqual((r["apan_oct"], r["apan_agree"], r["apan_other_totals"]), (str(APAN[0] + 5), "1", str(sum(APAN))))
        self.assertIn("1 with modules that disagree (the majority row kept): Z30A", out)

    def test_no_module_file(self):
        (self.root / "net").mkdir()
        buf = io.StringIO()
        with redirect_stdout(buf), unittest.mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(w.main([str(self.root / "net"), "--out", str(self.root / "o.csv")]), 1)


if __name__ == "__main__":
    unittest.main()
