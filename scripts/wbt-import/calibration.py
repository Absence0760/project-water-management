"""Extract the catchment calibration settings from a b023 WBT workbook.

`extract_calibration_window(wb)` returns the top-level settings
`calibrationStart` / `calibrationEnd` / `calibrationFlowKind` (the window and
flow record the workbook calibrates against).

`extract_calibration(wb)` returns a dict shaped like the engine's
`CalibrationParams` (packages/engine/src/project.ts, camelCase keys): the rain
threshold and the catchment area, read via the workbook's named ranges so it
keeps working when rows move between workbook versions. The rest of the
[Flow Calibration Cfg] sheet (peak-flow coefficients, season factors, summer
months, recession tables) configured the legacy b023 runoff model, which
engine 1.0.0 removed (issue #16), so it is not read.

The workbook must be opened with `data_only=True` (cached values); read-only
mode is fine and recommended for the large client workbooks.

    python scripts/wbt-import/calibration.py path/to/workbook.xlsm
"""

from __future__ import annotations

import datetime as dt
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


def extract_calibration(wb) -> dict[str, Any]:
    return {
        "rainThresholdMm": _num(_cell(wb, "rCalibration_RainThreshold")),
        "catchmentAreaKm2": _num(_cell(wb, "rFarmSpec_AreaTotal")),
    }


# [Flow data] rUseFlow picks Flow A/B/C = columns F/G/H. 1 (Pitman) is kept so
# extract_project.py can warn that the app doesn't calibrate against it.
_USE_FLOW_KINDS = {1: "flow_pitman_m3s", 2: "flow_observed_m3s", 3: "flow_logger_m3s"}


def _iso_or_none(v: Any) -> str | None:
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    return None


def extract_calibration_window(wb) -> dict[str, Any]:
    """Top-level ProjectSettings for calibration scoring.

    calibrationStart/End come from [Flow Calibration Cfg] zCalibration_Date1 /
    zCalibration_DateN (the window the hydrologist calibrated on);
    calibrationFlowKind from [Flow data] rUseFlow (1 Pitman, 2 gauge, 3 logger).
    Anything missing or unreadable becomes null (= the engine's default).
    """
    out: dict[str, Any] = {"calibrationStart": None, "calibrationEnd": None, "calibrationFlowKind": None}
    for key, name in (("calibrationStart", "zCalibration_Date1"), ("calibrationEnd", "zCalibration_DateN")):
        try:
            out[key] = _iso_or_none(_cell(wb, name))
        except (KeyError, ValueError):
            pass
    try:
        use = _cell(wb, "rUseFlow")
        out["calibrationFlowKind"] = _USE_FLOW_KINDS.get(int(use)) if isinstance(use, (int, float)) else None
    except (KeyError, ValueError):
        pass
    if out["calibrationStart"] and out["calibrationEnd"] and out["calibrationStart"] > out["calibrationEnd"]:
        out["calibrationStart"] = out["calibrationEnd"] = None
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} WORKBOOK.xlsm", file=sys.stderr)
        return 2
    import openpyxl

    wb = openpyxl.load_workbook(argv[1], read_only=True, data_only=True, keep_vba=False)
    try:
        print(json.dumps({"calibration": extract_calibration(wb), **extract_calibration_window(wb)}, indent=2))
    finally:
        wb.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
