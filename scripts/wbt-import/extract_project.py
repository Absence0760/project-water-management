"""Convert a b023 WBT workbook into a project for this app.

    python scripts/wbt-import/extract_project.py WORKBOOK.xlsm OUTDIR
        [--gauge-as-reference [--gauge-scaling-from YYYY-MM-DD --gauge-scale-factor F]]

--gauge-as-reference imports the [Flow data] gauge column as a
flow_reference_m3s series (a gauge on another river: a regional wet/dry index
the engine never reads) instead of flow_observed_m3s. The scaling options undo
a known scaling of that column: values on or after the date are divided by F.
See scripts/wbt-import/README.md and docs/model.md section 2.10.

Writes
  OUTDIR/project.json   { name, description, settings, model, series }
                        settings = ProjectSettings, model = ProjectModel,
                        series = [{ kind, name, unit, startDate, values }]
                        (packages/engine/src/project.ts)
  OUTDIR/expected.json  the workbook's own daily results (cached cell values)
                        per Element sheet + catchment, for the engine's
                        regression test (packages/engine/src/run.test.ts).

Everything is located through the workbook's named ranges (zNetwork_*,
zFarmSpec_*, ...) so row/column moves between workbook builds don't matter.
The workbook is opened read-only with cached values (data_only=True): it must
have been calculated and saved in Excel. Ids are uuid5s of the project and
element names, so re-importing the same workbook yields the same ids.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
import uuid
from pathlib import Path
from typing import Any

from openpyxl.utils.cell import column_index_from_string, get_column_letter

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:  # written alongside this script; falls back to engine defaults if absent
    from calibration import extract_calibration, extract_calibration_window, summer_months_note  # type: ignore
except ImportError:  # pragma: no cover
    extract_calibration = None
    extract_calibration_window = None
    summer_months_note = None

_REF = re.compile(r"^'?(?P<sheet>.+?)'?!\$?(?P<c1>[A-Z]+)\$?(?P<r1>\d+)(?::\$?(?P<c2>[A-Z]+)\$?(?P<r2>\d+))?$")

# Defaults from packages/engine/src/project.ts defaultProjectSettings().
DEFAULT_CALIBRATION = {
    "a": 0.09,
    "b": 1.2,
    "rainThresholdMm": 2,
    "summerFactor": 0.1,
    "winterFactor": 1,
    "summerMonths": [10, 11, 12, 1, 2, 3],
    "baseFlowInitial": 300,
}

# b023 rounding precisions the engine hard-codes (packages/engine/src/network/round.ts).
MONTHS_WY = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]

# [Flow data] hydrology columns F..K, in order. Column F (Pitman flow) is not
# imported: the app has no Pitman input (docs/engine-audit.md P1).
FLOW_DATA_KINDS: list[tuple[str | None, str]] = [
    (None, "m3/s"),
    ("flow_observed_m3s", "m3/s"),
    ("flow_logger_m3s", "m3/s"),
    ("rain_catchment_mm", "mm"),
    ("rain_chirps_mm", "mm"),
    ("rain_forecast_mm", "mm"),
]

# FarmTemplate columns (row 19 headers) -> expected.json keys (= engine RunSeries keys).
FARM_COLS = {
    "F": "demand",
    "G": "supplied",
    "H": "inflow_upstream",
    "I": "runoff",
    "J": "transfer",
    "Q": "dam_storage",
    "R": "spill",
    "U": "outflow",
    "W": "deficit",
    "Y": "ewr",
    "Z": "ewr_cumulative",
    "AA": "ewr_shortfall",
    "AB": "ewr_shortfall_incremental",
}
GAUGE_COLS = {"F": "observed", "G": "outflow", "H": "ewr_cumulative", "I": "ewr_shortfall"}

# --gauge-as-reference: the workbook's gauge column (column G) becomes this kind.
GAUGE_KIND = "flow_observed_m3s"
REFERENCE_KIND = "flow_reference_m3s"
LOGGER_KIND = "flow_logger_m3s"


class Workbook:
    def __init__(self, wb) -> None:
        self.wb = wb
        self.notes: list[str] = []

    def ref(self, name: str) -> tuple[str, int, int, int, int]:
        """Named range -> (sheet, min_col, min_row, max_col, max_row)."""
        dn = self.wb.defined_names.get(name)
        if dn is None:
            raise KeyError(f"workbook has no defined name {name!r}")
        m = _REF.match(dn.attr_text.strip())
        if not m:
            raise ValueError(f"{name!r} is not a plain cell/range reference: {dn.attr_text}")
        c1, r1 = column_index_from_string(m["c1"]), int(m["r1"])
        c2 = column_index_from_string(m["c2"]) if m["c2"] else c1
        r2 = int(m["r2"]) if m["r2"] else r1
        return m["sheet"].replace("''", "'"), c1, r1, c2, r2

    def block(self, sheet: str, c1: int, r1: int, c2: int, r2: int) -> list[list[Any]]:
        ws = self.wb[sheet]
        rows = [list(r) for r in ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True)]
        # read-only sheets can return short rows at the end of the used range
        return [r + [None] * (c2 - c1 + 1 - len(r)) for r in rows] + [[None] * (c2 - c1 + 1)] * (r2 - r1 + 1 - len(rows))

    def named(self, name: str) -> list[list[Any]]:
        s, c1, r1, c2, r2 = self.ref(name)
        return self.block(s, c1, r1, c2, r2)

    def cell(self, name: str) -> Any:
        return self.named(name)[0][0]


def num(v: Any, default: float = 0.0) -> float:
    """Excel treats blanks as 0 in arithmetic."""
    if v is None or v == "":
        return default
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except ValueError:
        return default


def clean(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def is_name(v: Any) -> bool:
    s = clean(v)
    return bool(s) and s != "|" and not s.startswith("--")


def iso(d: Any) -> str:
    if isinstance(d, dt.datetime):
        return d.date().isoformat()
    if isinstance(d, dt.date):
        return d.isoformat()
    raise ValueError(f"not a date: {d!r}")


def farm_operating_rules(name: str, spec: dict[str, Any], notes: list[str]) -> dict[str, Any]:
    """The node's operating-rule fields (engine >= 0.15.0, docs/engine-audit.md).

    Q5: the app's damMinPct is the dam's minimum operating level (irrigation
    stops there). The workbook's [Farm spec] "min %" is the minimum for
    transfers, which each transfer rule already carries as minStoragePct, so it
    is not imported as an operating level: damMinPct is 0 (irrigation may empty
    the dam, as in the workbook), with a note when the workbook had one.

    N1: the workbook's irrigation return flow % r becomes an application
    efficiency and a loss return fraction, as migration 006 maps it: r = 0 ->
    e = 1, beta = 0; r > 0 -> e = 1 - r (at least 0.01), beta = 1. The balance
    per unit supplied is the workbook's, and the crop is now fully supplied.

    N2: the workbook has no dam surface areas, so damAreaFullM2 is None (the
    run estimates capacity / 3 m and warns), with the default area exponent
    0.7 and no seepage; the caller notes the dams once.
    """
    wb_min = num(spec.get("damMinPct"))
    if wb_min:
        notes.append(
            f"farm {name}: [Farm spec] min dam % {wb_min:g} is the workbook's transfer minimum (each transfer rule "
            "keeps its own); the dam's minimum operating level is left at 0 (docs/engine-audit.md Q5)"
        )
    r = num(spec.get("returnFlowPct"))
    if r > 0:
        irrigation = {"irrigationEfficiency": max(1 - min(r, 1), 0.01), "lossReturnFraction": 1}
    else:
        irrigation = {"irrigationEfficiency": 1, "lossReturnFraction": 0}
    return {"damMinPct": 0, **irrigation, "damAreaFullM2": None, "damAreaExponent": 0.7, "damSeepagePerDay": 0}


def month_list(v: Any) -> list[int]:
    """The months a b023 month-list cell ("1,2,11,12") names.

    The workbook matches months with a substring FIND, so "11" also switches on
    January and "12" February. The importer keeps the listed months only and
    notes any month the workbook would have added (docs/engine-audit.md M1).
    """
    if v is None:
        return []
    text = str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
    return sorted({int(x) for x in re.findall(r"\d+", text) if 1 <= int(x) <= 12})


def substring_extra_months(v: Any) -> list[int]:
    """Months the workbook's substring FIND matches although the list doesn't name them."""
    if v is None:
        return []
    text = str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
    text = text.replace(" ", "")
    return sorted({m for m in range(1, 13) if f"{m}," in text + ","} - set(month_list(v)))


def table_rows(wb: Workbook, name_range: str) -> tuple[str, list[int], list[str]]:
    """A b023 config table's name column: (sheet, row numbers, names), header and '--' row excluded."""
    sheet, c, r1, _, r2 = wb.ref(name_range)
    col = wb.block(sheet, c, r1 + 1, c, r2)
    rows, names = [], []
    for i, (v,) in enumerate(col):
        if clean(v).startswith("--"):
            break
        if is_name(v):
            rows.append(r1 + 1 + i)
            names.append(clean(v))
    return sheet, rows, names


# ---------------------------------------------------------------------------


def read_network(wb: Workbook) -> tuple[list[dict[str, Any]], str]:
    sheet, rows, names = table_rows(wb, "zNetwork_ElementNameLst")
    _, tc, *_ = wb.ref("zNetwork_ElementTypeLst")
    _, uc1, _, uc2, _ = wb.ref("zNetwork_UpstreamTbl")
    elements = []
    for r, name in zip(rows, names):
        etype = clean(wb.block(sheet, tc, r, tc, r)[0][0]).lower()
        ups = [clean(v) for v in wb.block(sheet, uc1, r, uc2, r)[0] if is_name(v)]
        elements.append({"name": name, "kind": "gauge" if etype == "gauge" else "farm", "upstream": ups})
    outflow = clean(wb.cell("zNetwork_OutflowGauge"))
    return elements, outflow


def read_farm_spec(wb: Workbook) -> tuple[dict[str, dict[str, Any]], str, dict[str, float], float]:
    sheet, rows, names = table_rows(wb, "zFarmSpec_FarmNameLst")
    col = lambda n: wb.ref(n)[1]  # noqa: E731
    c_area_total = wb.ref("rFarmSpec_AreaTotal")[1]
    _, c_hi, _, c_lo, _ = wb.ref("rFarmSpec_DataAreas")
    c_sel = col("zFarmSpec_PercFragmLst")
    c_ext = c_sel - 1  # "External fragmentation copied (%)" sits just left of "Selected"
    cols = {
        "areaKm2": c_area_total,
        "areaHiKm2": c_hi,
        "areaLoKm2": c_lo,
        "flowShareManual": c_ext,
        "selectedShare": c_sel,
        "pctUpstreamToDam": col("zFarmSpec_PercUpstrInflowToDamLst"),
        "pctRunoffToDam": col("zFarmSpec_PercFarmRunoffToDamList"),
        "damCapacityM3": col("zFarmSpec_CompositeDamVol"),
        "damInitialPct": col("zFarmSpec_StartStoragePercLst"),
        "damMinPct": col("zFarmSpec_CompositeDamMinPerc"),
        "divertCapacityM3Day": col("zFarmSpec_DiversionToDam"),
        "returnFlowPct": col("zFarmSpec_PercIrrReturnFlow"),
    }
    cmin, cmax = min(cols.values()), max(cols.values())
    farms = {}
    for r, name in zip(rows, names):
        row = wb.block(sheet, cmin, r, cmax, r)[0]
        farms[name] = {k: num(row[c - cmin]) for k, c in cols.items()}
    method_raw = clean(wb.cell("rFarmSpec_SelectedMethod"))
    methods = [clean(v[0]) for v in wb.named("rFarmSpec_Methods")]  # Area, Hi/Lo, Specific
    method = {0: "area", 1: "hiLo", 2: "manual"}.get(methods.index(method_raw) if method_raw in methods else 0)
    if method_raw not in methods:
        wb.notes.append(f"unknown fragmentation method {method_raw!r}; using area")
    s, _, r_sel, _, _ = wb.ref("rFarmSpec_SelectedMethod")
    hi, lo = wb.block(s, c_hi, r_sel, c_lo, r_sel)[0]
    tol = num(wb.cell("rFarmSpec_FragmentationTolerance"), 0.0002)
    return farms, method, {"hi": num(hi, 0.81), "lo": num(lo, 0.19)}, tol


def read_crops(wb: Workbook) -> tuple[list[dict[str, Any]], list[float], float]:
    sheet, rows, names = table_rows(wb, "zCropDemand_CropNameLst")
    _, fc1, hr, fc2, _ = wb.ref("zCropDemand_FactorsTbl")
    header = [clean(v) for v in wb.block(sheet, fc1, hr, fc2 + 14, hr)[0]]
    try:
        c0 = fc1 + header.index("Oct")
    except ValueError as exc:
        raise ValueError("[Crop demand] factor header has no 'Oct' column") from exc
    if [header[c0 - fc1 + i] for i in range(12)] != MONTHS_WY:
        raise ValueError(f"[Crop demand] factor months are not Oct..Sep: {header}")
    crops = []
    for r, name in zip(rows, names):
        vals = wb.block(sheet, c0, r, c0 + 11, r)[0]
        crops.append({"name": name, "cropFactor": [num(v) for v in vals]})
    # A-pan row: the row above the factor table whose label mentions A-pan.
    label_col = wb.ref("zCropDemand_CropNameLst")[1]
    apan = None
    for i, row in enumerate(wb.block(sheet, label_col, max(1, hr - 20), c0 + 11, hr - 1)):
        if "a-pan" in " ".join(clean(v) for v in row[: c0 - label_col]).lower():
            apan = [num(v) for v in row[c0 - label_col : c0 - label_col + 12]]
    if apan is None:
        raise ValueError("[Crop demand] has no 'A-pan' evaporation row")
    erf = num(wb.cell("rCropDemand_EffectiveRainfall"), 0.65)
    return crops, apan, erf


def read_crop_areas(wb: Workbook) -> tuple[dict[str, dict[str, float]], dict[str, list[float]]]:
    sheet, rows, names = table_rows(wb, "zFarmDemand_FarmNameLst")
    _, cc1, hr, cc2, _ = wb.ref("zFarmDemand_CropNameLst")
    crop_hdr = wb.block(sheet, cc1, hr, cc2, hr)[0]
    crop_cols = [(cc1 + i, clean(v)) for i, v in enumerate(crop_hdr) if is_name(v)]
    _, gc1, _, gc2, _ = wb.ref("zFarmDemand_GrossMth")
    areas, gross = {}, {}
    for r, name in zip(rows, names):
        row = wb.block(sheet, cc1, r, gc2, r)[0]
        areas[name] = {crop: num(row[c - cc1]) for c, crop in crop_cols}
        gross[name] = [num(v) for v in row[gc1 - cc1 : gc2 - cc1 + 1]]
    return areas, gross


def read_transfers(wb: Workbook) -> list[dict[str, Any]]:
    sheet, c1, hr, c2, _ = wb.ref("zTransfers_HeaderFarmsFrom")
    label_col = c1  # the first column of the From block holds the row labels
    labels = {}
    for i, (v,) in enumerate(wb.block(sheet, label_col, 1, label_col, hr - 1), start=1):
        lab = clean(v).lower()
        for key, pat in [
            ("cap", "dam capacity"),
            ("min", "min capacity"),
            ("to", "transfer to"),
            ("months", "transfer months"),
            ("rate", "max transfer"),
            ("daily", "transfer capacity max"),
        ]:
            if lab.startswith(pat):
                labels[key] = i
    missing = {"to", "months", "rate", "min"} - labels.keys()
    if missing:
        raise ValueError(f"[Transfers] config rows not found: {sorted(missing)}")
    header = wb.block(sheet, c1, hr, c2, hr)[0]
    out = []
    for i, v in enumerate(header):
        if not is_name(v) or i == 0:
            continue
        c = c1 + i
        cfg = {k: wb.block(sheet, c, r, c, r)[0][0] for k, r in labels.items()}
        to = clean(cfg.get("to"))
        rate = num(cfg.get("rate"))
        if not is_name(to) or rate <= 0:
            continue
        months_raw = cfg.get("months")
        months = month_list(months_raw)
        extra = substring_extra_months(months_raw)
        if extra:
            wb.notes.append(
                f"transfer {clean(v)} -> {to}: the workbook's substring match also runs it in months {extra}, "
                f"which {months_raw!r} doesn't list; the app uses the listed months only (audit M1)"
            )
        out.append(
            {
                "from": clean(v),
                "to": to,
                "months": months,
                "maxRateM3s": rate,
                "minStoragePct": num(cfg.get("min")),
                "column": get_column_letter(c),
            }
        )
    return out


def month_days(wb: Workbook) -> float:
    labels = [clean(r[0]) for r in wb.named("rAppSet_MonthLbls")]
    days = [num(r[0]) for r in wb.named("zAppSet_MonthDays")]
    return days[labels.index("Feb")] if "Feb" in labels else 28.25


# ---------------------------------------------------------------------------


def read_flow_data(wb: Workbook) -> dict[str, Any]:
    sheet, cd, hr, _, _ = wb.ref("zFlowData_HeaderDate")
    last = wb.cell("zFlowData_DateE_DateSeries")
    _, h1, _, h2, _ = wb.ref("zFlowData_HeaderHydrologyData")
    header = wb.block(sheet, h1, hr, h2, hr)[0]
    want = {
        "natural_flow": wb.ref("zFlowData_HeaderResultFlow")[1],
        "ewr": wb.ref("zFlowData_HeaderEWRpragma")[1],
        "simulated_outflow": wb.ref("zFlowData_HeaderSimulated")[1],
        "rain_used": wb.ref("zFlowData_HeaderUseRain")[1],
        "observed_flow": wb.ref("zFlowData_HeaderObserved")[1],
        "ewr_not_met": wb.ref("zFlowData_HeaderEWRvolumeNotMet")[1],
    }
    cmax = max([h2, *want.values()])
    ws = wb.wb[sheet]
    dates, raw, calc = [], [[] for _ in range(6)], {k: [] for k in want}
    for row in ws.iter_rows(min_row=hr + 2, min_col=cd, max_col=cmax, values_only=True):
        d = row[0] if row else None
        if not isinstance(d, (dt.datetime, dt.date)):
            break
        row = list(row) + [None] * (cmax - cd + 1 - len(row))
        dates.append(iso(d))
        for i in range(6):
            v = row[h1 + 1 + i - cd]
            raw[i].append(v if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
        for k, c in want.items():
            v = row[c - cd]
            calc[k].append(v if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
        if isinstance(last, (dt.datetime, dt.date)) and iso(d) == iso(last):
            break
    for a, b in zip(dates, dates[1:]):
        if (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days != 1:
            raise ValueError(f"[Flow data] dates are not consecutive at {a} -> {b}")
    series = []
    pitman_days = 0
    for i, (kind, unit) in enumerate(FLOW_DATA_KINDS):
        values = raw[i]
        if kind is None:
            pitman_days = sum(v is not None for v in values)
            continue
        if all(v is None for v in values):
            continue
        series.append(
            {"kind": kind, "name": clean(header[1 + i]) or kind, "unit": unit, "startDate": dates[0], "values": values}
        )
    return {"dates": dates, "series": series, "calc": calc, "pitman_days": pitman_days}


def gauge_as_reference(
    series: list[dict[str, Any]],
    settings: dict[str, Any],
    scaling_from: str | None = None,
    scale_factor: float | None = None,
) -> list[str]:
    """Re-label the workbook's gauge column as a reference gauge, in place. Returns notes.

    For a workbook whose "gauge" column is measured on a different river (a
    neighbouring sub-catchment), that record is not observed flow for the
    modelled catchment. It becomes a flow_reference_m3s series, which the engine
    never uses as a calibration or validation record or in the EWR comparison.
    With scaling_from and scale_factor, values on or after scaling_from are
    divided by scale_factor, undoing a scaling the workbook applied to part of
    the record (e.g. by a catchment-area ratio). If rUseFlow pointed
    calibration at the gauge, calibrationFlowKind is left unset (null) and a
    WARNING note says so: the run then falls back to the logger when there is
    one, with no default-pick warning because there is nothing to choose.
    """
    if (scaling_from is None) != (scale_factor is None):
        raise ValueError("--gauge-scaling-from and --gauge-scale-factor go together")
    if scale_factor is not None and not (math.isfinite(scale_factor) and scale_factor > 0):
        raise ValueError(f"--gauge-scale-factor must be a positive number, got {scale_factor}")
    cutoff = dt.date.fromisoformat(scaling_from) if scaling_from is not None else None

    notes: list[str] = []
    gauge = next((s for s in series if s["kind"] == GAUGE_KIND), None)
    if gauge is None:
        notes.append("--gauge-as-reference: the workbook has no gauge values; nothing to re-label")
    else:
        gauge["kind"] = REFERENCE_KIND
        msg = (
            f"[Flow data] gauge column imported as {REFERENCE_KIND} (a reference gauge on another river), "
            f"not {GAUGE_KIND}: runs never calibrate against it"
        )
        if cutoff is not None:
            d0 = dt.date.fromisoformat(gauge["startDate"])
            first = max(0, (cutoff - d0).days)
            changed = 0
            for i in range(first, len(gauge["values"])):
                v = gauge["values"][i]
                if v is not None:
                    gauge["values"][i] = v / scale_factor
                    changed += 1
            msg += f"; values from {cutoff.isoformat()} divided by {scale_factor:g} ({changed} days)"
        notes.append(msg)
    if settings.get("calibrationFlowKind") == GAUGE_KIND:
        settings["calibrationFlowKind"] = None
        has_logger = any(s["kind"] == LOGGER_KIND for s in series)
        notes.append(
            "WARNING: [Flow data] rUseFlow calibrates against the gauge column, which --gauge-as-reference says is "
            "another river. calibrationFlowKind is left unset"
            + (
                ", so runs use the logger record. Check that choice in Settings -> calibration flow series"
                if has_logger
                else " and the project has no observed flow record to calibrate against"
            )
        )
    return notes


# Zero-rain runs (issue #2): the engine's zeroRainRuns rule in
# packages/engine/src/quality.ts (docs/model.md section 2.10a). Keep in step.
ZERO_RUN_MIN_WET_DAYS = 60
ZERO_RUN_PLAIN_DAYS = 180
CLIMATOLOGY_MIN_DAYS_PER_MONTH = 56


def zero_rain_runs(start_date: str, values: list[float | None]) -> tuple[list[int] | None, list[tuple[str, str, int]]]:
    """(wet months, [(first day, last day, days)]) of the zero runs the engine warns about.

    A run of consecutive exact zeros is flagged with 60+ days in the six
    calendar months of highest mean daily rain in the series itself, or 180+
    days in any season when some month has fewer than 56 valid days or the
    series never rains. A blank, negative or non-zero day ends a run.
    """
    d0 = dt.date.fromisoformat(start_date)
    months = [(d0 + dt.timedelta(days=i)).month for i in range(len(values))]
    total, count = [0.0] * 13, [0] * 13
    for m, v in zip(months, values):
        if v is not None and v >= 0:
            total[m] += v
            count[m] += 1
    wet_months: list[int] | None = None
    if all(count[m] >= CLIMATOLOGY_MIN_DAYS_PER_MONTH for m in range(1, 13)) and any(total[1:]):
        mean = {m: total[m] / count[m] for m in range(1, 13)}
        wet_months = sorted(sorted(range(1, 13), key=lambda m: (-mean[m], m))[:6])
    min_days = ZERO_RUN_MIN_WET_DAYS if wet_months else ZERO_RUN_PLAIN_DAYS
    runs, i = [], 0
    while i < len(values):
        if values[i] != 0:
            i += 1
            continue
        j = i
        while j < len(values) and values[j] == 0:
            j += 1
        wet = sum(1 for m in months[i:j] if wet_months is None or m in wet_months)
        if wet >= min_days:
            runs.append((iso(d0 + dt.timedelta(days=i)), iso(d0 + dt.timedelta(days=j - 1)), j - i))
        i = j
    return wet_months, runs


def zero_rain_note(series: list[dict[str, Any]]) -> str | None:
    """The importer's note for zero runs in the catchment rain, or None."""
    rain = next((s for s in series if s["kind"] == "rain_catchment_mm"), None)
    if rain is None:
        return None
    wet, runs = zero_rain_runs(rain["startDate"], rain["values"])
    if not runs:
        return None
    rule = (
        f"{ZERO_RUN_MIN_WET_DAYS}+ days in the wet season (months {','.join(map(str, wet))})"
        if wet
        else f"{ZERO_RUN_PLAIN_DAYS}+ days"
    )
    spans = "; ".join(f"{a} to {b} ({n} days)" for a, b, n in runs)
    return (
        f"[Flow data] catchment rain has {len(runs)} run(s) of zero rain covering {rule}: {spans}. "
        "A zero blocks the CHIRPS fallback a blank day gets; if these are missing data, re-export them as blank"
    )


def read_element_sheet(wb: Workbook, name: str, kind: str, days: int, first_date: str) -> dict[str, list]:
    ws = wb.wb[name]
    cols = FARM_COLS if kind == "farm" else GAUGE_COLS
    idx = {k: column_index_from_string(c) for c, k in cols.items()}
    c0, c1 = column_index_from_string("E"), max(idx.values())
    out: dict[str, list] = {k: [] for k in idx}
    started = False
    for row in ws.iter_rows(min_row=20, min_col=c0, max_col=c1, values_only=True):
        d = row[0] if row else None
        if not isinstance(d, (dt.datetime, dt.date)):
            if started:
                break
            continue
        if not started:
            if iso(d) != first_date:
                raise ValueError(f"[{name}] starts on {iso(d)}, [Flow data] on {first_date}")
            started = True
        row = list(row) + [None] * (c1 - c0 + 1 - len(row))
        for k, c in idx.items():
            v = row[c - c0]
            out[k].append(v if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
        if len(out[next(iter(out))]) == days:
            break
    return out


# [Shortfalls] columns as offsets from zShortfalls_Tbl's first column (E) -> expected.json keys.
# The first three are the original keys; the rest are the curtailment columns
# (engine CurtailmentFarm, packages/engine/src/network/curtailment.ts).
SHORTFALLS_COLS = {
    "avgDemand": 3,  # H
    "avgSupplied": 4,  # I
    "avgEwrShortfall": 13,  # R
    "deficit": 5,  # J
    "fractionSupplied": 6,  # K ("-" when demand is 0)
    "target": 8,  # M
    "reduceGain": 9,  # N
    "reduceGainLs": 10,  # O
    "targetFraction": 11,  # P
    "totalChange": 14,  # S
    "totalChangeLs": 15,  # T
    "volumeLeft": 16,  # U
    "fractionOfDemandLeft": 17,  # V
}
# Columns the totals row (just below the "-- do NOT delete this row" sentinel) fills. K there is Σ I / Σ H.
SHORTFALLS_TOTALS = (
    "avgDemand",
    "avgSupplied",
    "deficit",
    "fractionSupplied",
    "target",
    "reduceGain",
    "reduceGainLs",
    "avgEwrShortfall",
    "totalChange",
    "volumeLeft",
)


def num_or_none(v: Any) -> float | None:
    """A [Shortfalls] cell: a number, or None for "-", an error value or a blank."""
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def read_shortfalls(wb: Workbook) -> dict[str, Any] | None:
    try:
        sheet, c1, r1, _, r2 = wb.ref("zShortfalls_Tbl")
        s, pc, pr, _, _ = wb.ref("zShortfalls_PeriodStart")
    except KeyError:
        return None
    start, end = wb.block(s, pc, pr, pc, pr + 1)
    width = max(SHORTFALLS_COLS.values())
    farms = []
    for row in wb.block(sheet, c1, r1 + 1, c1 + width, r2):
        if not is_name(row[2]):
            continue
        farm: dict[str, Any] = {"name": clean(row[2])}
        for key, off in SHORTFALLS_COLS.items():
            farm[key] = num(row[off]) if key in ("avgDemand", "avgSupplied", "avgEwrShortfall") else num_or_none(row[off])
        farms.append(farm)
    # zShortfalls_Tbl ends on the sentinel row; the totals row is the next one.
    tot = wb.block(sheet, c1, r2 + 1, c1 + width, r2 + 1)[0]
    totals = {k: num_or_none(tot[SHORTFALLS_COLS[k]]) for k in SHORTFALLS_TOTALS}
    return {"periodStart": iso(start[0]), "periodEnd": iso(end[0]), "farms": farms, "totals": totals}


def read_ewr_pivot(wb: Workbook) -> list[dict[str, Any]] | None:
    """[EWR shortfalls Pivot Data]: per calendar year x month x farm, the summed
    incremental EWR shortfall (m3, <= 0) and the count of days "not met".

    The table is written by VBA (sProEp_GenerateEWRpivotData), so it is only as
    fresh as the last time that macro ran. Its count uses a running monthly
    total; see packages/engine/src/network/ewr.ts.
    """
    try:
        rows = wb.named("zEWRshortPivotData_DataTbl")
    except KeyError:
        return None
    out = []
    for r in rows[1:]:
        year, month, farm, vol, cnt = r[0], r[1], r[2], r[3], r[4]
        if not isinstance(year, (int, float)) or not is_name(farm):
            continue
        out.append({"year": int(year), "month": int(month), "farm": clean(farm), "volM3": num(vol), "daysNotMet": int(num(cnt))})
    return out


# ---------------------------------------------------------------------------


def project_name(path: Path) -> str:
    stem = path.stem
    return stem.split("_WBT")[0] or stem


def extract(
    path: Path,
    gauge_reference: bool = False,
    scaling_from: str | None = None,
    scale_factor: float | None = None,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """(project, expected, notes). gauge_reference and the scaling: see gauge_as_reference()."""
    import openpyxl

    if not gauge_reference and (scaling_from is not None or scale_factor is not None):
        raise ValueError("the gauge scaling options need --gauge-as-reference")

    wb = Workbook(openpyxl.load_workbook(path, read_only=True, data_only=True, keep_vba=False))
    try:
        name = project_name(path)
        ns = uuid.uuid5(uuid.NAMESPACE_URL, f"https://water-management.local/wbt-import/{name}")
        uid = lambda key: str(uuid.uuid5(ns, key))  # noqa: E731

        elements, outflow = read_network(wb)
        spec, method, split, tol = read_farm_spec(wb)
        crops, apan, erf = read_crops(wb)
        areas, gross_sheet = read_crop_areas(wb)
        transfers = read_transfers(wb)

        by_name = {e["name"]: e for e in elements}
        downstream: dict[str, str | None] = {e["name"]: None for e in elements}
        for e in elements:
            for u in e["upstream"]:
                if u not in by_name:
                    raise ValueError(f"[Network] {e['name']} lists unknown upstream element {u!r}")
                if downstream[u] is not None:
                    raise ValueError(f"[Network] {u} drains into both {downstream[u]} and {e['name']}")
                downstream[u] = e["name"]
        roots = [n for n, d in downstream.items() if d is None]
        if outflow and outflow in roots and len(roots) > 1:
            wb.notes.append(f"elements {roots} have no downstream element; only {outflow} is the outflow gauge")

        nodes = []
        for order, e in enumerate(elements):
            s = spec.get(e["name"], {}) if e["kind"] == "farm" else {}
            if e["kind"] == "farm" and not s:
                wb.notes.append(f"farm {e['name']} is missing from [Farm spec]; its parameters are 0, except upstream inflow to dam (100 %)")
            nodes.append(
                {
                    "id": uid(f"node:{e['name']}"),
                    "name": e["name"],
                    "kind": e["kind"],
                    "downstreamNodeId": uid(f"node:{downstream[e['name']]}") if downstream[e["name"]] else None,
                    "sortOrder": order,
                    "areaKm2": s.get("areaKm2", 0),
                    "areaHiKm2": s.get("areaHiKm2", 0),
                    "areaLoKm2": s.get("areaLoKm2", 0),
                    "flowShareManual": s.get("flowShareManual") if e["kind"] == "farm" else None,
                    "pctUpstreamToDam": s.get("pctUpstreamToDam", 1),
                    "pctRunoffToDam": s.get("pctRunoffToDam", 0),
                    "damCapacityM3": s.get("damCapacityM3", 0),
                    "damInitialPct": s.get("damInitialPct", 0),
                    "divertCapacityM3Day": s.get("divertCapacityM3Day", 0),
                    **farm_operating_rules(e["name"], s, wb.notes),
                }
            )
        node_id = {n["name"]: n["id"] for n in nodes}
        dams = [n["name"] for n in nodes if n["kind"] == "farm" and n["damCapacityM3"] > 0]
        if dams:
            wb.notes.append(
                f"{len(dams)} dam(s) have no surface area in the workbook; runs estimate it as capacity / 3 m for dam "
                "evaporation (docs/engine-audit.md N2). Enter the areas in the app for a better figure"
            )

        crop_defs = [{"id": uid(f"crop:{c['name']}"), "name": c["name"], "cropFactor": c["cropFactor"]} for c in crops]
        crop_id = {c["name"]: c["id"] for c in crop_defs}
        crop_areas = []
        for farm, per_crop in areas.items():
            if farm not in node_id:
                wb.notes.append(f"[Farm demand] farm {farm} is not in [Network]; ignored")
                continue
            for crop, a in per_crop.items():
                if a == 0:
                    continue
                if crop not in crop_id:
                    wb.notes.append(f"[Farm demand] crop {crop} is not in [Crop demand]; ignored")
                    continue
                crop_areas.append({"nodeId": node_id[farm], "cropId": crop_id[crop], "areaM2": a})

        model_transfers = []
        for t in transfers:
            if t["from"] not in node_id or t["to"] not in node_id:
                wb.notes.append(f"transfer {t['from']} -> {t['to']} names an unknown element; skipped")
                continue
            model_transfers.append(
                {
                    "id": uid(f"transfer:{t['from']}>{t['to']}:{t['column']}"),
                    "fromNodeId": node_id[t["from"]],
                    "toNodeId": node_id[t["to"]],
                    "months": t["months"],
                    "maxRateM3s": t["maxRateM3s"],
                    "dailyCapM3": None,
                    "minStoragePct": t["minStoragePct"],
                    "enabled": True,
                }
            )

        if extract_calibration is not None:
            calibration = extract_calibration(wb.wb)
            note = summer_months_note(wb.wb) if summer_months_note is not None else None
            if note:
                wb.notes.append(note)
        else:
            calibration = dict(DEFAULT_CALIBRATION)
            wb.notes.append("calibration.py not found: settings.calibration uses engine defaults")

        ewr = [num(r[0]) for r in wb.named("zEWR_Pragmatic")]
        settings = {
            "februaryDays": month_days(wb),
            "effectiveRainFraction": erf,
            "apanMm": apan,
            "flowShareMethod": method,
            "hiLoSplit": split,
            "calibration": calibration,
            "ewrPragmaticM3PerDay": ewr,
            "simulationStart": None,
            "simulationEnd": None,
            "calibrationStart": None,
            "calibrationEnd": None,
            "calibrationFlowKind": None,
        }
        if extract_calibration_window is not None:
            settings.update(extract_calibration_window(wb.wb))

        flow = read_flow_data(wb)
        dates = flow["dates"]
        zero_note = zero_rain_note(flow["series"])
        if zero_note:
            wb.notes.append(zero_note)
        if gauge_reference:
            wb.notes.extend(gauge_as_reference(flow["series"], settings, scaling_from, scale_factor))
        if flow["pitman_days"]:
            wb.notes.append(
                f"[Flow data] Pitman flow column has {flow['pitman_days']} days of values; not imported "
                "(the app has no Pitman input, so natural flow comes only from the rain model)"
            )
        kind = settings["calibrationFlowKind"]
        if kind == "flow_pitman_m3s":
            wb.notes.append(
                "WARNING: [Flow data] rUseFlow calibrates against Pitman flow, which the app doesn't support; "
                "calibrationFlowKind left unset (runs use the gauge, else the logger)"
            )
            settings["calibrationFlowKind"] = None
        elif kind and kind not in {s["kind"] for s in flow["series"]}:
            wb.notes.append(f"[Flow data] rUseFlow picks {kind}, which has no values; calibrationFlowKind left unset")
            settings["calibrationFlowKind"] = None
        project = {
            "name": name,
            "description": f"Imported from {path.name}",
            "settings": settings,
            "model": {"nodes": nodes, "crops": crop_defs, "cropAreas": crop_areas, "transfers": model_transfers},
            "series": flow["series"],
        }

        expected_nodes = {}
        for e in elements:
            if e["name"] not in wb.wb.sheetnames:
                wb.notes.append(f"no Element sheet for {e['name']}; not in expected.json")
                continue
            expected_nodes[e["name"]] = {
                "kind": e["kind"],
                **read_element_sheet(wb, e["name"], e["kind"], len(dates), dates[0]),
            }
        expected = {
            "source": path.name,
            "startDate": dates[0],
            "days": len(dates),
            "outflowGauge": outflow,
            "shareTolerance": tol,
            "farmShares": {n: s["selectedShare"] for n, s in spec.items()},
            "grossDemandM3Day": gross_sheet,
            "catchment": flow["calc"],
            "nodes": expected_nodes,
            "shortfalls": read_shortfalls(wb),
            "ewrPivot": read_ewr_pivot(wb),
        }
        return project, expected, wb.notes
    finally:
        wb.wb.close()


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog=Path(argv[0]).name, description="Convert a b023 WBT workbook into a project.")
    p.add_argument("workbook", type=Path)
    p.add_argument("outdir", type=Path)
    p.add_argument(
        "--gauge-as-reference",
        action="store_true",
        help="import the gauge column as flow_reference_m3s (a gauge on another river), not flow_observed_m3s",
    )
    p.add_argument("--gauge-scaling-from", metavar="YYYY-MM-DD", help="first day the workbook scaled the gauge column")
    p.add_argument("--gauge-scale-factor", metavar="F", type=float, help="divide gauge values from that day by F")
    a = p.parse_args(argv[1:])
    if (a.gauge_scaling_from is None) != (a.gauge_scale_factor is None):
        p.error("--gauge-scaling-from and --gauge-scale-factor go together")
    if a.gauge_scaling_from is not None and not a.gauge_as_reference:
        p.error("--gauge-scaling-from/--gauge-scale-factor need --gauge-as-reference")
    if a.gauge_scaling_from is not None:
        try:
            dt.date.fromisoformat(a.gauge_scaling_from)
        except ValueError:
            p.error(f"--gauge-scaling-from is not a YYYY-MM-DD date: {a.gauge_scaling_from}")
    if a.gauge_scale_factor is not None and not (math.isfinite(a.gauge_scale_factor) and a.gauge_scale_factor > 0):
        p.error(f"--gauge-scale-factor must be a positive number, got {a.gauge_scale_factor}")
    return a


def main(argv: list[str]) -> int:
    a = parse_args(argv)
    src, out = a.workbook, a.outdir
    project, expected, notes = extract(src, a.gauge_as_reference, a.gauge_scaling_from, a.gauge_scale_factor)
    out.mkdir(parents=True, exist_ok=True)
    (out / "project.json").write_text(json.dumps(project, separators=(",", ":")))
    (out / "expected.json").write_text(json.dumps(expected, separators=(",", ":")))
    m = project["model"]
    print(
        f"{project['name']}: {len(m['nodes'])} nodes, {len(m['crops'])} crops, {len(m['cropAreas'])} crop areas, "
        f"{len(m['transfers'])} transfers, {len(project['series'])} series x {expected['days']} days "
        f"from {expected['startDate']} -> {out}"
    )
    for n in notes:
        if n.startswith("WARNING: "):
            print(f"  {n}", file=sys.stderr)
        else:
            print(f"  note: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
