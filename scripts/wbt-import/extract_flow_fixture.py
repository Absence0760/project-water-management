"""Write the rain -> natural-flow regression fixture from a b023 workbook.

Reads the [Flow data] inputs (rain, Pitman) and the workbook's own computed
columns (season, rain used, base / response / resultant flow, natural flow)
plus the calibration, and writes them as JSON for
packages/engine/src/flow.test.ts. The output is client data: it goes under
data/ (gitignored) and is never committed.

    python scripts/wbt-import/extract_flow_fixture.py \
        "../project-water-management-source/Original/<client workbook>.xlsm" \
        data/fixtures/client-catchment-flow.json
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from calibration import _resolve, extract_calibration  # noqa: E402

# Flow data column -> (fixture key, header text prefix it must carry).
COLUMNS = {
    "E": ("date", "Date"),
    "F": ("flowPitmanM3s", "Pitman"),
    "I": ("rainCatchmentMm", "Average Catchment Rainfall"),
    "J": ("rainChirpsMm", "Rainfall CHIRPS"),
    "K": ("rainForecastMm", "Forecast"),
    "N": ("isSummer", "Is Summer?"),
    "R": ("rainUsedMm", "Use rain"),
    "S": ("baseFlow", "Underlying Base Flow"),
    "T": ("baseIndex", "Base Flow Recession Index"),
    "U": ("responseStart", "Response flow (start)"),
    "V": ("rainFlow", "Rain added Flow"),
    "W": ("addedIndex", "Index Added flow"),
    "X": ("responseAdded", "Response & Added Flow recede"),
    "Y": ("resultantFlow", "Resultant Response flow"),
    "Z": ("resultantIndex", "Resultant Recession index"),
    "AB": ("naturalFlowM3Day", "Resultant"),
}


def _col(letter: str) -> int:
    n = 0
    for ch in letter:
        n = n * 26 + ord(ch) - 64
    return n


def _iso(v) -> str:
    if isinstance(v, dt.datetime):
        v = v.date()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (int, float)):  # Excel serial (1900 date system)
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    raise ValueError(f"not a date: {v!r}")


def extract(path: str) -> dict:
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_vba=False)
    try:
        calibration = extract_calibration(wb)
        sheet, _, header_row, _, _ = _resolve(wb, "zFlowData_HeaderTbl")
        ws = wb[sheet]
        idx = {letter: _col(letter) - 1 for letter in COLUMNS}
        out: dict[str, list] = {key: [] for key, _ in COLUMNS.values()}
        rows = ws.iter_rows(min_row=header_row, max_col=_col("AB"), values_only=True)
        header = next(rows)
        for letter, (key, label) in COLUMNS.items():
            text = str(header[idx[letter]] or "").strip()
            if not text.startswith(label):
                raise ValueError(f"column {letter}: expected header {label!r}, found {text!r}")
        next(rows)  # the "reserved" row holding the initial base flow
        for row in rows:
            if row[idx["E"]] in (None, ""):
                break
            for letter, (key, _) in COLUMNS.items():
                v = row[idx[letter]]
                out[key].append(_iso(v) if key == "date" else (None if v == "" else v))
    finally:
        wb.close()

    dates = out.pop("date")
    for a, b in zip(dates, dates[1:]):
        if dt.date.fromisoformat(b) - dt.date.fromisoformat(a) != dt.timedelta(days=1):
            raise ValueError(f"date series not contiguous at {a} -> {b}")
    return {
        "source": Path(path).name,
        "startDate": dates[0],
        "days": len(dates),
        "calibration": calibration,
        "inputs": {k: out[k] for k in ("rainCatchmentMm", "rainChirpsMm", "rainForecastMm", "flowPitmanM3s")},
        "expected": {k: v for k, v in out.items() if k not in ("rainCatchmentMm", "rainChirpsMm", "rainForecastMm", "flowPitmanM3s")},
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} WORKBOOK.xlsm OUT.json", file=sys.stderr)
        return 2
    data = extract(argv[1])
    out = Path(argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out}: {data['days']} days from {data['startDate']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
