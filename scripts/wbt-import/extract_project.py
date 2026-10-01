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
    from calibration import extract_calibration, extract_calibration_window  # type: ignore
except ImportError:  # pragma: no cover
    extract_calibration = None
    extract_calibration_window = None

_REF = re.compile(r"^'?(?P<sheet>.+?)'?!\$?(?P<c1>[A-Z]+)\$?(?P<r1>\d+)(?::\$?(?P<c2>[A-Z]+)\$?(?P<r2>\d+))?$")

# Defaults from packages/engine/src/project.ts defaultProjectSettings().
DEFAULT_CALIBRATION = {"rainThresholdMm": 2, "catchmentAreaKm2": None}

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
    """The node's operating-rule fields (engine >= 0.16.0, docs/engine-audit.md).

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


# A probable run-of-river unit (issue #54, 2d). b023 has no river abstraction,
# so a unit that pumps straight from the river is entered as a "dummy dam": a
# dam that takes 100 % of the upstream inflow and either
#
# - is a pool: it holds less than 1 % of a day of its diversion capacity, or
#   less than 1 m³ (a placeholder, not a dam). At 1 % the diversion refills it
#   in under 15 minutes, so it stores nothing across the model's daily step; a
#   real farm dam holds days to months of its diversion (a small one of a few
#   thousand m³ is tens of % of a 0.1 m³/s = 8,640 m³/day diversion), or
# - holds exactly a day of river flow: its capacity is a whole number of m³/s
#   times 86,400 s (within 1 m³), and none of the farm's own runoff enters
#   it. A surveyed capacity is rarely an exact multiple of
#   86,400 m³, and one rounded to 1,000 m³ can be (432,000 m³ is 5 m³/s), so
#   the runoff condition rules out a real on-channel dam, which catches the
#   runoff draining into it as well as the river.
#
# The importer still imports it as a farm dam and only warns: the modeller
# confirms it, and run-of-river supply waits for pump capacity (#54, 2c).
RUN_OF_RIVER_PCT_UPSTREAM = 0.9999  # 100 %, allowing for float rounding
RUN_OF_RIVER_POOL_SHARE_OF_DIVERSION = 0.01
RUN_OF_RIVER_POOL_MAX_M3 = 1.0
SECONDS_PER_DAY = 86400


def no_dam_note(name: str) -> str:
    """The WARNING for a farm with no dam that takes 100 % of the upstream inflow (same text in the browser importer)."""
    return (
        f"WARNING: farm {name}: probable run-of-river, for the modeller to confirm: it has no dam but takes 100 % of the "
        "upstream inflow, and a farm without a dam irrigates straight from the river routed to it, with no pump limit. "
        "Set its supply rule to run of river with a pump capacity to cap it (issue #54, 2d)"
    )


def run_of_river_note(name: str, pct_upstream: float, capacity: float, divert: float, pct_runoff: float) -> str | None:
    """A WARNING when a farm's dam looks like b023's dummy dam for a unit that pumps from the river (issue #54, 2d)."""
    if pct_upstream < RUN_OF_RIVER_PCT_UPSTREAM:
        return None
    # No dam at all: the engine lets a dam-less farm irrigate from the river routed to it, with no limit
    # (docs/model.md §2.7e), where b023's formula gave it nothing (issue #54).
    if capacity <= 0:
        return no_dam_note(name)
    if capacity < RUN_OF_RIVER_POOL_MAX_M3 or capacity < RUN_OF_RIVER_POOL_SHARE_OF_DIVERSION * divert:
        why = f"is a pool of {capacity:g} m³"
        if divert > 0:
            why += f" against a diversion capacity of {math.floor(divert + 0.5)} m³/day"
    else:
        rate = math.floor(capacity / SECONDS_PER_DAY + 0.5)
        if rate < 1 or abs(capacity - rate * SECONDS_PER_DAY) > 1 or pct_runoff != 0:
            return None
        why = f"holds exactly {rate} m³/s for one day ({math.floor(capacity + 0.5)} m³) and takes none of the farm's own runoff"
    return (
        f"WARNING: farm {name}: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the upstream "
        f"inflow and {why}. b023 has no river abstraction, so a unit that pumps from the river is entered as a dummy dam; "
        "the app imports it as a farm dam, so its dam results (storage, spill, level) mean nothing (issue #54, 2d)"
    )


def as_run_of_river(node: dict[str, Any], source_of_transfer: bool) -> str:
    """With --run-of-river: turn a flagged unit (run_of_river_note) into a run-of-river unit, in place, and say so.

    b023 has no pump capacity, and nothing in it caps what a dummy dam or a
    dam-less farm takes from the water routed to it, so the river pump is left
    uncapped (null), which is what the workbook did; the modeller enters the
    real capacity. A dummy dam's storage is dropped: run of river has no dam
    (the model rules refuse one). A unit that is the source of an enabled
    transfer keeps its dam, since a transfer draws on that storage, and the
    note says why nothing changed."""
    name = node["name"]
    if source_of_transfer:
        return (
            f"WARNING: farm {name}: not imported as run of river (--run-of-river): an enabled transfer draws on its dam, "
            "so it stays a farm dam; convert it by hand once the transfer is settled (issue #54, 2d)"
        )
    dropped = node["damCapacityM3"]
    node.update({"damCapacityM3": 0, "damInitialPct": 0, "supplyRule": "runOfRiver", "pumpCapacityM3Day": None})
    what = f"its {math.floor(dropped + 0.5)} m³ dummy dam is dropped" if dropped > 0 else "it has no dam"
    return (
        f"WARNING: farm {name}: imported as run of river (--run-of-river): {what}, and a river pump takes its demand "
        "from the river below it. The workbook gives no pump capacity (b023 has none, and nothing there capped this "
        "unit's take), so the pump is uncapped and each run warns; enter the capacity in the Network tab's Supply "
        "section (issue #54, 2c/2d)"
    )


def offtake_fields() -> dict[str, Any]:
    """A river off-take's fields as the importers set them: up to capacity (a canal that runs full), no
    hands-off flow, the EWR not kept, no losses, no dam top-up: what the workbook's transfer would move, from
    the river rather than a dummy dam. The modeller sets the real values (the note says which)."""
    return {"source": "river", "handsOffM3Day": None, "handsOffEwr": False, "lossPct": 0, "sizing": "capacity", "topUpDam": False}


def offtake_note(frm: str, to: str, rate: float, enabled: bool) -> str:
    """The WARNING for a transfer imported as a river off-take (same text in the browser importer)."""
    state = "" if enabled else " It is switched off, as in the workbook: switch it on (Transfers tab, Enabled) once they are set."
    return (
        f"WARNING: transfer {frm} -> {to} imported as a river off-take (issue #54): {to} has no dam and no demand, so the "
        f"workbook's transfer from {frm}'s dummy dam stands for a canal fed from the river. It takes up to the workbook's "
        f"{rate} m³/s ({math.floor(rate * SECONDS_PER_DAY + 0.5)} m³/day), sized to capacity, with no hands-off flow, no losses and the EWR "
        "not kept: set the canal's real capacity (by month if it varies), its hands-off flow or EWR condition, its losses "
        f"and whether it runs full or only draws what is needed.{state}"
    )


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
    return farms, method, {"hi": num(hi, 0.5), "lo": num(lo, 0.5)}, tol


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


# Checks of the [Crop demand] factor table (issue #289; same rules and text in the browser importer, crops.ts).
# b023's table has rows pasted from another crop and one-month slips (a lone 0, a spike above 1; issue #54 item 1).
# The factors are imported as they are; each finding is a WARNING for the modeller to check.
# CEILING: the Crops tab's high-factor hint. A-pan factors are Kp x Kc: FAO-56 Kc mid-season is at most about 1.2
# (Table 12) and Class A pan Kp at most 0.85 (Table 5), about 1.0; the ARC/SABI tables in the crop library peak at 0.7.
CROP_FACTOR_CEILING = 1.0
# LONE_STEP: a month more than this above (or below) both its neighbours. The ARC/SABI tables' largest step between
# adjacent months is 0.3 (table grapes Mar -> Apr, pecan), and no month there stands off both neighbours by more than 0.15.
CROP_FACTOR_LONE_STEP = 0.3
# Float noise in a difference of two typed factors (0.65 - 0.35 is 0.30000000000000004).
CROP_FACTOR_EPS = 1e-9


def crop_row_findings(factors: list[float]) -> list[str]:
    """The suspect months of one crop's 12 factors (Oct..Sep; the year wraps, so Oct's neighbours are Sep and Nov)."""
    out = []
    for m, x in enumerate(factors):
        pm, nm = (m - 1) % 12, (m + 1) % 12
        a, b = factors[pm], factors[nm]
        around = f"{MONTHS_WY[pm]} {a:g} and {MONTHS_WY[nm]} {b:g}"
        if x < 0:
            out.append(f"{MONTHS_WY[m]} factor {x:g} is negative")
        elif x == 0 and a > 0 and b > 0:
            out.append(f"{MONTHS_WY[m]} factor is 0 between {around} (a lone month out of the ground)")
        elif x - a > CROP_FACTOR_LONE_STEP + CROP_FACTOR_EPS and x - b > CROP_FACTOR_LONE_STEP + CROP_FACTOR_EPS:
            out.append(f"{MONTHS_WY[m]} factor {x:g} is more than {CROP_FACTOR_LONE_STEP:g} above both {around} (a lone spike)")
        elif a - x > CROP_FACTOR_LONE_STEP + CROP_FACTOR_EPS and b - x > CROP_FACTOR_LONE_STEP + CROP_FACTOR_EPS:
            out.append(f"{MONTHS_WY[m]} factor {x:g} is more than {CROP_FACTOR_LONE_STEP:g} below both {around} (a lone dip)")
        if x > CROP_FACTOR_CEILING:
            out.append(f"{MONTHS_WY[m]} factor {x:g} is above {CROP_FACTOR_CEILING:g} (more water than an open A-pan loses)")
    return out


def crop_table_notes(crops: list[dict[str, Any]]) -> list[str]:
    """WARNINGs for [Crop demand] rows copied from another crop and for suspect months (issue #289).

    A row identical to an earlier, differently named crop's (not all zero) names that crop; its months aren't
    checked again, since the first crop's note covers them."""
    notes = []
    for i, c in enumerate(crops):
        f = c["cropFactor"]
        first = next((d["name"] for d in crops[:i] if d["name"] != c["name"] and d["cropFactor"] == f), None)
        if first is not None and any(x != 0 for x in f):
            notes.append(
                f"WARNING: [Crop demand] crop {c['name']}: its 12 factors are the same as {first}'s, a row copied from "
                "another crop by the look of it; imported as they are, so give it its own curve if it has one (issue #289)"
            )
            continue
        findings = crop_row_findings(f)
        if findings:
            notes.append(
                f"WARNING: [Crop demand] crop {c['name']}: {'; '.join(findings)}; imported as they are, so check "
                "them against the workbook (issue #289)"
            )
    return notes


def read_crop_areas(wb: Workbook) -> tuple[dict[str, dict[str, float]], dict[str, list[float]], list[float] | None]:
    """(m² per crop per farm, the sheet's gross demand in m³/day per farm per month, its days per month or None)."""
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
    try:
        days = [num(v) for v in wb.named("zFarmDemand_GrossMthDays")[0]]
    except KeyError:
        days = None
    return areas, gross, days


# A month's [Farm demand] gross demand doesn't follow from the crop areas when it
# differs from Σ area × factor × A-pan / 1000 / days by more than both of
# these: the sheet rounds to 0.1 m³/day and each crop's gross mm to 0.01.
GROSS_DEMAND_TOLERANCE_M3_DAY = 1.0
GROSS_DEMAND_TOLERANCE_REL = 0.01


def crop_formula(per_crop: dict[str, float], factors: dict[str, list[float]], apan: list[float], days: list[float]) -> list[float]:
    """[Farm demand]'s crop formula per month: sum of area x factor x A-pan / 1000 / days (m3/day)."""
    return [
        sum(a * factors[crop][m] * apan[m] / 1000 / days[m] for crop, a in per_crop.items() if crop in factors) for m in range(12)
    ]


def gross_demand_off(gross: list[float], formula: list[float]) -> list[int]:
    """The months whose gross demand differs from the crop formula by more than the sheet's rounding."""
    return [
        m
        for m in range(12)
        if abs(gross[m] - formula[m]) > max(GROSS_DEMAND_TOLERANCE_M3_DAY, GROSS_DEMAND_TOLERANCE_REL * max(abs(gross[m]), abs(formula[m])))
    ]


def non_crop_demand(
    per_crop: dict[str, float], gross: list[float], factors: dict[str, list[float]], apan: list[float], days: list[float]
) -> list[float] | None:
    """What a farm's [Farm demand] gross demand has above its crop formula, per month (m3/day), or None.

    Only the months that are off by more than the sheet's rounding count, and
    only where the workbook is higher: a town's potable demand typed over the
    formula (issue #54, 2b). Where the workbook is lower (a formula that skips a
    crop) the crop areas win, as before."""
    formula = crop_formula(per_crop, factors, apan, days)
    off = set(gross_demand_off(gross, formula))
    surplus = [gross[m] - formula[m] if m in off and gross[m] > formula[m] else 0.0 for m in range(12)]
    return surplus if any(v > 0 for v in surplus) else None


NON_CROP_DEMAND_NAME = "Non-crop demand"


def non_crop_demand_object(uid, farm: str, node_id: str, monthly: list[float], cropped: bool, return_pct: float) -> dict[str, Any]:
    """The demand object for a farm's non-crop demand (engine 1.7.0, docs/model.md 2.7f).

    It is supplied with the farm's crops ("shared"), as the workbook's one
    demand is, and returns the farm's irrigation return flow %, so what it
    takes and gives back is the workbook's: supplied x r back, (1 - r) consumed.
    A farm with no crops at all is a town or scheme (municipal); otherwise the
    category is left as other for the modeller to set. Its source is 'other'
    (engine 1.56.0): the workbook's number, not a meter record, AADD or norm."""
    return {
        "id": uid(f"demand-object:{farm}"),
        "nodeId": node_id,
        "name": NON_CROP_DEMAND_NAME,
        "category": "other" if cropped else "municipal",
        "sizing": "monthly",
        "monthlyM3Day": monthly,
        "count": None,
        "litresPerUnitDay": None,
        "lossPct": 0,
        "monthlyFactor": None,
        "returnPct": min(max(return_pct, 0.0), 1.0),
        "priority": "shared",
        "destination": "internal",
        "enabled": True,
        # The workbook's typed-over demand is neither a meter record, an AADD nor a norm by rule (engine 1.56.0).
        "source": "other",
        "note": "b023 [Farm demand]: the gross demand above what the crop areas give (typed over the crop formula)",
    }


def gross_demand_note(
    farm: str, per_crop: dict[str, float], gross: list[float], factors: dict[str, list[float]], apan: list[float], days: list[float]
) -> str | None:
    """A WARNING when a farm's gross demand doesn't follow from its crop areas: a non-crop
    demand typed over the formula, or a formula whose crop index is blank so it skips that crop
    (issue #54), saying what the import did about it: the part
    above the crop areas becomes a demand object (non_crop_demand), the crop areas win below."""
    formula = crop_formula(per_crop, factors, apan, days)
    off = gross_demand_off(gross, formula)
    if not off:
        return None
    surplus = non_crop_demand(per_crop, gross, factors, apan, days)
    below = sum(1 for m in off if gross[m] < formula[m])
    head = (
        f"WARNING: [Farm demand] {farm}: the gross demand in {len(off)} of 12 months doesn't follow from its crop areas "
        f"(a value typed over the formula, or a formula that skips a crop): the workbook has {math.floor(sum(gross) / 12 + 0.5)} "
        f"m³/day on average, the crop areas give {math.floor(sum(formula) / 12 + 0.5)}. "
    )
    if surplus is None:
        return head + "The app computes demand from the crop areas, so it models the second figure (issue #54, 2b)"
    text = (
        head
        + f"The part above the crop areas, {math.floor(sum(surplus) / 12 + 0.5)} m³/day on average, is imported as the demand object "
        f'"{NON_CROP_DEMAND_NAME}" (supplied with the crops, returning the farm\'s return flow %), so the modelled demand '
        "follows the workbook's; confirm its category, priority and return share (issue #54, 2b)"
    )
    if below:
        text += f". In {below} month(s) the crop areas give more than the workbook, and the app models the crop areas there"
    return text


# A draw formula that is the constant 0 ("=0", or "0" in the text copy): the
# hydrologist switched the transfer off in the workbook, which never moved
# that water (issue #54).
_ZERO_FORMULA = re.compile(r"^=?\s*0+(?:\.0*)?\s*$")


def is_zero_formula(v: Any) -> bool:
    """True for a [Transfers] text-copy formula that is the constant 0."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v == 0
    return isinstance(v, str) and bool(_ZERO_FORMULA.match(v.strip()))


def transfer_off_note(frm: str, to: str, column: str) -> str:
    """The WARNING for a transfer whose draw formula is the constant 0 (same text in the browser importer)."""
    return (
        f"WARNING: transfer {frm} -> {to} (column {column}): its draw formula is the constant 0, so the workbook never "
        "moved this water; it is imported switched off (Transfers tab, Enabled) (issue #54)"
    )


def model_window(wb: Workbook, dates: list[str]) -> tuple[str | None, str | None, str | None]:
    """simulationStart / End from [Home] zHome_CalcDate1 / CalcDateN (issue #54), and a note.

    The window the workbook last calculated. [Flow data] can hold a gauge
    record decades longer than the rain (a workbook whose flow record starts
    decades before its rain), and a run over all of it has decades with no rain.
    Each end is used only when it lies inside [Flow data] and cuts some of it
    off; otherwise the run covers the flow record, as before.
    """
    def at(name: str) -> str | None:
        try:
            s, c, r, _, _ = wb.ref(name)
            v = wb.block(s, c, r, c, r)[0][0]
        except (KeyError, ValueError):  # no such name, a missing sheet or an odd range: no window
            return None
        return iso(v) if isinstance(v, (dt.datetime, dt.date)) else None

    if not dates:
        return None, None, None
    d1, dn = at("zHome_CalcDate1"), at("zHome_CalcDateN")
    start = d1 if d1 and dates[0] < d1 <= dates[-1] else None
    end = dn if dn and dates[0] <= dn < dates[-1] else None
    if start and end and start > end:
        return None, None, None
    if not start and not end:
        return None, None, None
    note = (
        f"[Home] the workbook calculates {start or dates[0]} to {end or dates[-1]}, inside [Flow data]'s {dates[0]} to "
        f"{dates[-1]}: runs cover that window (settings.simulationStart / End); every series keeps its full record"
    )
    return start, end, note


def series_span(series: list[dict[str, Any]]) -> str:
    """'N days from D': the span the imported series cover (the summary line; expected.json's window can be shorter)."""
    if not series:
        return "no days"
    first = min(dt.date.fromisoformat(s["startDate"]) for s in series)
    last = max(dt.date.fromisoformat(s["startDate"]) + dt.timedelta(days=len(s["values"]) - 1) for s in series)
    return f"{(last - first).days + 1} days from {first.isoformat()}"


def read_transfers(wb: Workbook) -> list[dict[str, Any]]:
    sheet, c1, hr, c2, _ = wb.ref("zTransfers_HeaderFarmsFrom")
    try:
        txt_sheet, _, txt_row, _, _ = wb.ref("zTransfers_FormulasAsTxt")
    except KeyError:
        txt_sheet, txt_row = None, None
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
        formula = wb.block(txt_sheet, c, txt_row, c, txt_row)[0][0] if txt_sheet else None
        off = is_zero_formula(formula)
        if off:
            wb.notes.append(transfer_off_note(clean(v), to, get_column_letter(c)))
        out.append(
            {
                "from": clean(v),
                "to": to,
                "months": months,
                "maxRateM3s": rate,
                "minStoragePct": num(cfg.get("min")),
                "column": get_column_letter(c),
                "enabled": not off,
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

    For a workbook whose "gauge" column is measured elsewhere, that record is
    not observed flow for the modelled catchment. It becomes a
    flow_reference_m3s series, which the engine never uses as a calibration or
    validation record or in the EWR comparison. With scaling_from and
    scale_factor, values on or after scaling_from are divided by scale_factor,
    undoing a known rescaling of part of the record. If rUseFlow pointed
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


def duplicate_logger_note(series: list[dict[str, Any]], settings: dict[str, Any]) -> str | None:
    """Drop a logger column that is a copy of the gauge column, in place, and say so; else None.

    Some workbooks fill [Flow data]'s logger column with the gauge column
    (the same value on every day). Imported, the copy would score as perfect
    agreement between two instruments (docs/model.md section 2.10a) and could
    be picked as an "independent" validation record (section 2.10b), which it
    is not. So it is left out. A calibration choice of the logger moves to the
    gauge, the same record. The browser importer (gauge.ts duplicateLogger)
    does the same, with the same text. Run before --gauge-as-reference, so
    the comparison is of the two columns as the workbook holds them.
    """
    gauge = next((s for s in series if s["kind"] == GAUGE_KIND), None)
    logger = next((s for s in series if s["kind"] == LOGGER_KIND), None)
    if gauge is None or logger is None or gauge["startDate"] != logger["startDate"] or gauge["values"] != logger["values"]:
        return None
    series.remove(logger)
    moved = settings.get("calibrationFlowKind") == LOGGER_KIND
    if moved:
        settings["calibrationFlowKind"] = GAUGE_KIND
    return (
        "WARNING: [Flow data] the logger column is a copy of the gauge column (the same value on every day), so it is "
        "not imported as a second record: a copy would read as two instruments agreeing, and as an independent "
        "validation record, which it is not"
        + ("; rUseFlow's logger choice now names the gauge, the same record" if moved else "")
        + " (issue #54)"
    )


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
        "Runs treat them as missing (engine >= 0.15.0, settings.zeroRainRuns, default mode 'missing'), so "
        "bias-corrected CHIRPS fills them; if they are real dry spells, keep them dry in Settings -> Zero-rain runs"
    )


def element_sheet_start(wb: Workbook, name: str) -> str | None:
    """The first date in an Element sheet's date column (E, from row 20), or None."""
    for (d,) in wb.wb[name].iter_rows(min_row=20, min_col=5, max_col=5, values_only=True):
        if isinstance(d, (dt.datetime, dt.date)):
            return iso(d)
    return None


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
                raise ValueError(f"[{name}] starts on {iso(d)}, the other Element sheets on {first_date}")
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
    run_of_river: bool = False,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """(project, expected, notes). gauge_reference and the scaling: see gauge_as_reference().
    run_of_river: import the units flagged as probable run-of-river as run of river (as_run_of_river)."""
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
        areas, gross_sheet, gross_days = read_crop_areas(wb)
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
        flagged = []
        for n in nodes:
            if n["kind"] == "farm":
                note = run_of_river_note(n["name"], n["pctUpstreamToDam"], n["damCapacityM3"], n["divertCapacityM3Day"], n["pctRunoffToDam"])
                if note:
                    wb.notes.append(note)
                    flagged.append(n)
        dams = [n["name"] for n in nodes if n["kind"] == "farm" and n["damCapacityM3"] > 0]
        if dams:
            wb.notes.append(
                f"{len(dams)} dam(s) have no surface area in the workbook; runs estimate it as capacity / 3 m for dam "
                "evaporation (docs/engine-audit.md N2). Enter the areas in the app for a better figure"
            )

        wb.notes.extend(crop_table_notes(crops))
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
        demand_objects: list[dict[str, Any]] = []
        if gross_days is not None and len(gross_days) == 12 and all(d > 0 for d in gross_days):
            factors = {c["name"]: c["cropFactor"] for c in crops}
            for farm, per_crop in areas.items():
                if farm not in node_id or len(gross_sheet[farm]) != 12:
                    continue
                note = gross_demand_note(farm, per_crop, gross_sheet[farm], factors, apan, gross_days)
                if note:
                    wb.notes.append(note)
                # A demand above the crop areas (a town's, typed over the formula) becomes a demand object (issue #54, 2b).
                extra = non_crop_demand(per_crop, gross_sheet[farm], factors, apan, gross_days)
                if extra is not None:
                    cropped = any(a > 0 and c in factors for c, a in per_crop.items())
                    ret = num(spec.get(farm, {}).get("returnFlowPct"))
                    demand_objects.append(non_crop_demand_object(uid, farm, node_id[farm], extra, cropped, ret))

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
                    "enabled": t["enabled"],
                    # The workbook's columns ran in order; equal priorities would share a dam (Q18).
                    "priority": len(model_transfers),
                }
            )

        # A transfer the workbook fakes as a canal off-take (engine >= 1.14.0, docs/model.md 2.6a): into a unit
        # with no dam and no demand (crops or a demand object), from a probable run-of-river unit, is a river
        # off-take. Before the run-of-river conversion, which drops the source's dummy dam.
        flagged_ids = {n["id"] for n in flagged}
        by_id = {n["id"]: n for n in nodes}
        demanding = {a["nodeId"] for a in crop_areas if a["areaM2"] > 0} | {o["nodeId"] for o in demand_objects}
        for t in model_transfers:
            dst = by_id[t["toNodeId"]]
            if t["fromNodeId"] in flagged_ids and dst["kind"] == "farm" and dst["damCapacityM3"] <= 0 and dst["id"] not in demanding:
                t.update(offtake_fields())
                wb.notes.append(offtake_note(by_id[t["fromNodeId"]]["name"], dst["name"], t["maxRateM3s"], t["enabled"]))

        # --run-of-river (issue #54, 2c/2d): the flagged units become run of river, after the transfers are known.
        # A river off-take draws on the river, not the source's dam, so it doesn't keep the dam.
        if run_of_river:
            sources = {t["fromNodeId"] for t in model_transfers if t["enabled"] and t.get("source", "dam") == "dam"}
            for n in flagged:
                wb.notes.append(as_run_of_river(n, n["id"] in sources))

        if extract_calibration is not None:
            calibration = extract_calibration(wb.wb)
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
        sim_start, sim_end, window_note = model_window(wb, dates)
        if window_note:
            settings["simulationStart"], settings["simulationEnd"] = sim_start, sim_end
            wb.notes.append(window_note)
        zero_note = zero_rain_note(flow["series"])
        if zero_note:
            wb.notes.append(zero_note)
        dup_note = duplicate_logger_note(flow["series"], settings)
        if dup_note:
            wb.notes.append(dup_note)
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
            "model": {
                "nodes": nodes,
                "crops": crop_defs,
                "cropAreas": crop_areas,
                "transfers": model_transfers,
                **({"demandObjects": demand_objects} if demand_objects else {}),
            },
            "series": flow["series"],
        }

        # The Element sheets hold the workbook's model window, which can start
        # after [Flow data] does (a long gauge record before the rain record):
        # expected.json covers that window.
        sheets = [e for e in elements if e["name"] in wb.wb.sheetnames]
        start = element_sheet_start(wb, sheets[0]["name"]) if sheets else None
        start = start or dates[0]
        if start not in dates:
            raise ValueError(f"[{sheets[0]['name']}] starts on {start}, outside [Flow data] ({dates[0]} to {dates[-1]})")
        offset = dates.index(start)
        days = len(dates) - offset
        expected_nodes = {}
        for e in elements:
            if e["name"] not in wb.wb.sheetnames:
                wb.notes.append(f"no Element sheet for {e['name']}; not in expected.json")
                continue
            expected_nodes[e["name"]] = {
                "kind": e["kind"],
                **read_element_sheet(wb, e["name"], e["kind"], days, start),
            }
        expected = {
            "source": path.name,
            "startDate": start,
            "days": days,
            "outflowGauge": outflow,
            "shareTolerance": tol,
            "farmShares": {n: s["selectedShare"] for n, s in spec.items()},
            "grossDemandM3Day": gross_sheet,
            "catchment": {k: v[offset:] for k, v in flow["calc"].items()},
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
    p.add_argument(
        "--run-of-river",
        action="store_true",
        help="import the units flagged as probable run-of-river (dummy dam or no dam, 100 %% of the upstream inflow) "
        "with the run-of-river supply rule and no dam (issue #54, 2c/2d)",
    )
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
    project, expected, notes = extract(src, a.gauge_as_reference, a.gauge_scaling_from, a.gauge_scale_factor, a.run_of_river)
    out.mkdir(parents=True, exist_ok=True)
    (out / "project.json").write_text(json.dumps(project, separators=(",", ":")))
    (out / "expected.json").write_text(json.dumps(expected, separators=(",", ":")))
    m = project["model"]
    print(
        f"{project['name']}: {len(m['nodes'])} nodes, {len(m['crops'])} crops, {len(m['cropAreas'])} crop areas, "
        f"{len(m['transfers'])} transfers, {len(project['series'])} series ({series_span(project['series'])}); "
        f"expected.json {expected['days']} days from {expected['startDate']} -> {out}"
    )
    for n in notes:
        if n.startswith("WARNING: "):
            print(f"  {n}", file=sys.stderr)
        else:
            print(f"  note: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
