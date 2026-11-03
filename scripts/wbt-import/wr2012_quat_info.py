"""WR2012's quaternary catchment spreadsheets -> the values CSV `pnpm import:quaternaries --values` reads.

    python scripts/wbt-import/wr2012_quat_info.py "WR2012 Breede Quat Info WMA 18_Jul2015.xlsx" [more.xlsx …] \\
        --out wr2012-values.csv [--mae wr2005|wr90]

WR2012 (Water Resources of South Africa 2012 Study, WRC 2015) publishes one
spreadsheet per WMA, "WR2012 <Basin> Quat Info WMA nn_*.xls":
one sheet, a multi-row header (about rows 3-6), then one row per quaternary
catchment, its code in the first column. Among the columns: gross and net
area (km²), the evaporation zone, the MAE (mean annual Symons-pan
evaporation, mm) of WR2005 and of WR90, the rainfall zone, the MAP, and the
naturalised MAR of WR90, WR2005 and WR2012 (Mm³). There are no monthly flows
and no table of the zones' monthly distribution in these files.

The columns are found by their header text, never by position (one WMA's
file is shifted by a column): each column's header is the text of its header
rows joined (e.g. "S-pan evaporation evap zone", "MAE WR2005 (mm)",
"MAR (WR2012) Net (mcm)"), and

  area_km2   the gross catchment area ("Gross" with "(km2)"; WR2012's areas are gross, docs/maps.md)
  evap_zone  "evap" with "zone"
  mae_mm     "MAE WR2005" (the default, the newer) or "MAE WR90" (--mae wr90)
  map_mm     "MAP WR2005" if there is one, else the one MAP column ("MAP" or "MAP WR90")
  mar_mm3    the column in Mm³ ("(mcm)") whose header names WR2012
  period     the "YYYY - YYYY" above that MAR column, when there is one

Only openpyxl, so the files must be .xlsx: convert WR2012's .xls first with
LibreOffice, `soffice --headless --convert-to xlsx <file>.xls` (the sheet is
copied as it is). Several files make one CSV; a quaternary in two files must
have the same values in both (a repeated, identical row is kept once). Two
files for the same WMA (by "WMA nn" in the name: a local correction beside
the original, as WMA 17's "-2" copy is) are refused: list only the one to use,
or `--exclude` the other.

The output is `code,area_km2,map_mm,mar_mm3,mae_mm,evap_zone,period_start,period_end`,
and the line to give `--source` is printed (it names the MAE chosen). Real
WR2012 files and their values are never committed: the repo is public.
"""

import argparse
import csv
import re
import sys
from pathlib import Path

CODE = re.compile(r"^[A-Z]\d\d[A-Z]$")  # the loader's; DWS uses A-X and A-M, the synthetic tests region Z
PERIOD = re.compile(r"(\d{4})\s*-\s*(\d{4})")
HEADER_ROWS_MAX = 12
COLUMNS = ["code", "area_km2", "map_mm", "mar_mm3", "mae_mm", "evap_zone", "period_start", "period_end"]
MAE_LABEL = {"wr2005": "MAE WR2005", "wr90": "MAE WR90"}


class SheetError(ValueError):
    """A spreadsheet the extractor can't read, with why."""


def _text(v):
    return "" if v is None else str(v).strip()


def header_labels(rows):
    """Each column's header: its header rows' texts joined with spaces, lower case."""
    width = max((len(r) for r in rows), default=0)
    return [" ".join(t for t in (_text(r[c]) if c < len(r) else "" for r in rows) if t).lower() for c in range(width)]


def find_columns(labels, mae="wr2005"):
    """The column index of each value, by header text; raises SheetError naming what's missing."""

    def one(name, pred, required=True):
        hits = [i for i, label in enumerate(labels) if pred(label)]
        if not hits:
            if required:
                raise SheetError(f"no {name} column (looked for its header text)")
            return None
        return hits[0]

    cols = {
        "area_km2": one("gross area", lambda s: "gross" in s and "km2" in s),
        "evap_zone": one("evaporation zone", lambda s: "evap" in s and "zone" in s),
        "mae_mm": one(MAE_LABEL[mae], lambda s: MAE_LABEL[mae].lower() in s),
    }
    map2005 = one("MAP WR2005", lambda s: "map wr2005" in s, required=False)
    cols["map_mm"] = map2005 if map2005 is not None else one("MAP", lambda s: re.search(r"\bmap\b", s) is not None)
    cols["mar_mm3"] = one("MAR (WR2012)", lambda s: "wr2012" in s and "mcm" in s)
    return cols


def _num(v):
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None


def _fmt(n):
    if n is None:
        return ""
    return str(int(n)) if float(n).is_integer() else f"{n:.6g}"


def read_sheet(path, mae="wr2005"):
    """The quaternary rows of one WR2012 spreadsheet's first sheet, as dicts of COLUMNS (strings), and the codes of
    the part rows skipped (a row whose area isn't a number, such as "(35)")."""
    import openpyxl  # imported here so --help works without it

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
    finally:
        wb.close()
    first = next((i for i, r in enumerate(rows) if r and CODE.match(_text(r[0]))), None)
    if first is None:
        raise SheetError(f"{Path(path).name}: no row starts with a quaternary code")
    if first > HEADER_ROWS_MAX:
        raise SheetError(f"{Path(path).name}: the first quaternary is on row {first + 1}, past the header rows")
    head = rows[:first]
    try:
        cols = find_columns(header_labels(head), mae)
    except SheetError as e:
        raise SheetError(f"{Path(path).name}: {e}") from None
    period = None
    for r in head:
        m = PERIOD.search(_text(r[cols["mar_mm3"]]) if cols["mar_mm3"] < len(r) else "")
        if m:
            period = (m.group(1), m.group(2))
    out = []
    parts = []
    for r in rows[first:]:
        code = _text(r[0]) if r else ""
        if not CODE.match(code):
            continue
        cell = lambda k: r[cols[k]] if cols[k] < len(r) else None  # noqa: E731
        # A part row (a share of a quaternary split between areas) gives its values in brackets, "(35)": skipped.
        if _num(cell("area_km2")) is None:
            parts.append(code)
            continue
        zone = _text(cell("evap_zone")).upper()
        out.append(
            {
                "code": code,
                "area_km2": _fmt(_num(cell("area_km2"))),
                "map_mm": _fmt(_num(cell("map_mm"))),
                "mar_mm3": _fmt(_num(cell("mar_mm3"))),
                "mae_mm": _fmt(_num(cell("mae_mm"))),
                "evap_zone": zone,
                "period_start": period[0] if period else "",
                "period_end": period[1] if period else "",
            }
        )
    return out, parts


def wma_key(path):
    """The WMA number a WR2012 file's name gives ("… Quat Info WMA 17_Jul2015.xlsx" -> "17"), or ''."""
    m = re.search(r"WMA\s*(\d+)", Path(path).name, re.I)
    return m.group(1) if m else ""


def merge(sheets):
    """One row per code across files; a code with different values in two files is an error."""
    by_code = {}
    problems = []
    for name, rows in sheets:
        for row in rows:
            seen = by_code.get(row["code"])
            if seen is None:
                by_code[row["code"]] = (name, row)
            elif seen[1] != row:
                problems.append(f"{row['code']} differs between {seen[0]} and {name}")
    return [by_code[c][1] for c in sorted(by_code)], problems


def source_line(mae):
    return f"WR2012, Water Resources of South Africa 2012 Study (Water Research Commission, 2015), quaternary catchment information per WMA; MAE {MAE_LABEL[mae][4:]} (S-pan)"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("files", nargs="+", help="WR2012 Quat Info spreadsheets, .xlsx (convert .xls with LibreOffice first)")
    ap.add_argument("--out", required=True, help="the values CSV to write")
    ap.add_argument("--mae", choices=sorted(MAE_LABEL), default="wr2005", help="which MAE: WR2005's (default, the newer) or WR90's")
    ap.add_argument("--exclude", action="append", default=[], metavar="FILE", help="leave out a file the list (or a glob) names, by its name: e.g. a second copy of a WMA")
    a = ap.parse_args(argv)
    files = [f for f in a.files if Path(f).name not in {Path(x).name for x in a.exclude}]
    # One file per WMA: two copies of a WMA (a local correction beside the original) must not be merged by accident.
    by_wma = {}
    for f in files:
        by_wma.setdefault(wma_key(f), []).append(Path(f).name)
    twice = {k: v for k, v in by_wma.items() if k and len(v) > 1}
    if twice:
        for k, v in sorted(twice.items()):
            print(f"refused: two files for WMA {k}: {', '.join(v)}; list only the one to use, or --exclude the other", file=sys.stderr)
        return 1
    sheets = []
    for f in files:
        if Path(f).suffix.lower() == ".xls":
            print(f"{f}: an .xls; convert it first: soffice --headless --convert-to xlsx \"{f}\"", file=sys.stderr)
            return 2
        try:
            rows, parts = read_sheet(f, a.mae)
        except SheetError as e:
            print(e, file=sys.stderr)
            return 1
        if parts:
            print(f"{Path(f).name}: skipped {len(parts)} part row(s) whose area isn't a number: {', '.join(parts)}", file=sys.stderr)
        sheets.append((Path(f).name, rows))
    rows, problems = merge(sheets)
    for p in problems:
        print(f"refused: {p}", file=sys.stderr)
    if problems:
        return 1
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} quaternaries written to {a.out}")
    for k in COLUMNS[1:6]:
        empty = sum(1 for r in rows if not r[k])
        if empty:
            print(f"  {empty} without {k} (left empty: the loader then keeps none for it)")
    print(f'load with --values {a.out} --source "{source_line(a.mae)}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
