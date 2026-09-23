"""Extract the rain -> natural-flow calibration from a b023 WBT workbook.

`extract_calibration(wb)` returns a dict shaped like the engine's
`CalibrationParams` (packages/engine/src/project.ts, camelCase keys), read from
the [Flow Calibration Cfg] sheet via the workbook's named ranges so it keeps
working when rows move between workbook versions.

The workbook must be opened with `data_only=True` (cached values); read-only
mode is fine and recommended for the large client workbooks.

    python scripts/wbt-import/calibration.py path/to/workbook.xlsm
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from openpyxl.utils.cell import column_index_from_string

_REF = re.compile(r"^'?(?P<sheet>.+?)'?!\$?(?P<c1>[A-Z]+)\$?(?P<r1>\d+)(?::\$?(?P<c2>[A-Z]+)\$?(?P<r2>\d+))?$")


def _resolve(wb, name: str) -> tuple[str, int, int, int, int]:
    """Named range -> (sheet, min_col, min_row, max_col, max_row)."""
    dn = wb.defined_names.get(name)
    if dn is None:
        raise KeyError(f"workbook has no defined name {name!r}")
    m = _REF.match(dn.attr_text.strip())
    if not m:
        raise ValueError(f"{name!r} is not a plain cell/range reference: {dn.attr_text}")
    c1, r1 = column_index_from_string(m["c1"]), int(m["r1"])
    c2 = column_index_from_string(m["c2"]) if m["c2"] else c1
    r2 = int(m["r2"]) if m["r2"] else r1
    return m["sheet"].replace("''", "'"), c1, r1, c2, r2


def _block(wb, sheet: str, c1: int, r1: int, c2: int, r2: int) -> list[list[Any]]:
    ws = wb[sheet]
    return [list(row) for row in ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True)]


def _column(wb, name: str) -> list[Any]:
    sheet, c1, r1, c2, r2 = _resolve(wb, name)
    return [row[0] for row in _block(wb, sheet, c1, r1, c1, r2)]


def _cell(wb, name: str) -> Any:
    return _column(wb, name)[0]


def _num(v: Any) -> float:
    """Excel coerces a blank cell to 0 in arithmetic."""
    if v is None or v == "":
        return 0
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).strip())
    except ValueError as exc:
        raise ValueError(f"expected a number, got {v!r}") from exc


def summer_months(month_list: Any) -> list[int]:
    """Months the workbook treats as summer.

    fSorW2 tests ISNUMBER(FIND(Mth & ",", List & ",")) - a substring search, so
    "11,12," also matches months 1 and 2 ("11," contains "1,"). Replicate that
    here so the engine can use a plain membership test and still match Excel.
    """
    text = "" if month_list is None else str(month_list)
    # A cell holding a single number comes back as int/float.
    if isinstance(month_list, float) and month_list.is_integer():
        text = str(int(month_list))
    return [m for m in range(1, 13) if f"{m}," in text + ","]


def extract_calibration(wb) -> dict[str, Any]:
    factors = [_num(v) for v in _column(wb, "rCalibration_RecessionFactors")]
    curve = [_num(v) for v in _column(wb, "rCalibration_Curve")]

    # Initial base flow sits in the "reserved" row under the Flow data header,
    # in the "Underlying Base Flow" column (one right of "Use rain").
    sheet, col, row, _, _ = _resolve(wb, "zFlowData_HeaderUseRain")
    base_init = _block(wb, sheet, col + 1, row + 1, col + 1, row + 1)[0][0]

    return {
        "a": _num(_cell(wb, "rCalibration_PeakCoef_a")),
        "b": _num(_cell(wb, "rCalibration_PeakExp_b")),
        "rainThresholdMm": _num(_cell(wb, "rCalibration_RainThreshold")),
        "summerFactor": _num(_cell(wb, "rCalibration_FactorSummer")),
        "winterFactor": _num(_cell(wb, "rCalibration_FactorWinter")),
        "summerMonths": summer_months(_cell(wb, "rCalibration_SummerMths")),
        "baseFlowInitial": _num(base_init),
        "catchmentAreaKm2": _num(_cell(wb, "rFarmSpec_AreaTotal")),
        "baseResetRatio": _num(_cell(wb, "rCalibration_MinFlowRatioToResetBase")),
        "winterTodayRainMm": _num(_cell(wb, "rCalibration_WinterTodayThresh")),
        "winterNextDayRainMm": _num(_cell(wb, "rCalibration_WinterNextDayThresh")),
        "shiftPeakIndexLo": _num(_cell(wb, "rCalibration_ShiftPeakIndexLo")),
        "shiftPeakIndexHi": _num(_cell(wb, "rCalibration_ShiftPeakIndexHi")),
        "amplitudeM3Day": _num(_cell(wb, "rCalibration_Amplitude")),
        "recessionDaysMax": _num(_cell(wb, "rCalibration_DaysMax")),
        "recessionFactors": factors,
        "recessionCurveM3Day": curve,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} WORKBOOK.xlsm", file=sys.stderr)
        return 2
    import openpyxl

    wb = openpyxl.load_workbook(argv[1], read_only=True, data_only=True, keep_vba=False)
    try:
        print(json.dumps(extract_calibration(wb), indent=2))
    finally:
        wb.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
