"""An independent Python implementation of the water-balance model's core
daily chain, written only from the documentation (verify/README.md says which
parts and which docs). It never reads packages/engine/src: where the docs
don't say what the engine does, that is a documentation finding, fixed in
docs/model.md from the engine's observed outputs, not from its code.

Stdlib only. `run(input_doc)` takes a ModelInput document (the JSON the
engine's `runModel` takes) and returns
    { startDate, endDate, days, series: [{ nodeId, key, values }] }
with NaN where a day has no value.

Phase 1 covers: rain used (source order, threshold, CHIRPS fill with the
monthly bias factors, zero-rain runs and multi-day accumulations as
documented), GR4J, crop demand with the soil-water store and efficiency /
return share (N1), the farm dam balance (evaporation, rain on the dam,
seepage and its return share, minimum operating level, spill), routing down
the tree, dam-to-dam transfers (priority, bands at each rule's reserve, pro
rata, the receiver's room) and the EWR at sites with its attribution (Q17).
`unsupported(input_doc)` lists what an input uses beyond that.
"""

from __future__ import annotations

import datetime as _dt
import math

NAN = float("nan")


class Refused(Exception):
    """A run the documentation says the engine refuses."""

# --------------------------------------------------------------------------
# Calendar (docs/model.md §2.1, §2.3): water-year months Oct … Sep.
# --------------------------------------------------------------------------

DAYS_IN_WY_MONTH = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30]


def iso_to_ord(s: str) -> int:
    return _dt.date.fromisoformat(s).toordinal()


def ord_to_iso(o: int) -> str:
    return _dt.date.fromordinal(o).isoformat()


def wy_month(o: int) -> int:
    """Water-year month index 0 (Oct) … 11 (Sep) of a day ordinal."""
    return (_dt.date.fromordinal(o).month - 10) % 12


def cal_month(o: int) -> int:
    return _dt.date.fromordinal(o).month


def water_year(o: int) -> int:
    """A water year is labelled by the calendar year its October falls in."""
    d = _dt.date.fromordinal(o)
    return d.year if d.month >= 10 else d.year - 1


def calendar_days_in_month(o: int) -> int:
    d = _dt.date.fromordinal(o)
    nxt = _dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return (nxt - _dt.date(d.year, d.month, 1)).days


def month_days(settings: dict) -> list[float]:
    days = list(DAYS_IN_WY_MONTH)
    days[4] = settings["februaryDays"]
    return days


# --------------------------------------------------------------------------
# Settings: the documented defaults (docs/model.md, project.ts shape) with the
# input's settings merged over them, nested objects one level deep.
# --------------------------------------------------------------------------


def default_settings() -> dict:
    return {
        "februaryDays": 28.25,
        "effectiveRainFraction": 0.65,
        "effectiveRainFractionMonthly": None,
        "effectiveRainStoreMm": 25,
        "lakeEvapFactor": 0.75,
        "lakeEvapFactorMonthly": None,
        "apanMm": [0] * 12,
        "flowShareMethod": "area",
        "hiLoSplit": {"hi": 0.5, "lo": 0.5},
        "gr4j": {"x1": 350, "x2": 0, "x3": 90, "x4": 1.7, "warmupDays": 365},
        "panCoefficient": [0.7] * 12,
        "pe": {"kind": "pan"},
        "chirpsBiasCorrection": "monthly",
        "zeroRainRuns": {
            "mode": "missing",
            "keepDry": [],
            "missing": [],
            "accumulationMode": "spread",
            "keepReadings": [],
            "addAccumulations": [],
        },
        "calibration": {"rainThresholdMm": 2, "catchmentAreaKm2": None},
        "ewrPragmaticM3PerDay": [0] * 12,
        "simulationStart": None,
        "simulationEnd": None,
        "dataQuality": {"zeroRunMinWetDays": 60},
    }


def merge_settings(raw: dict) -> dict:
    s = default_settings()
    for k, v in (raw or {}).items():
        if isinstance(v, dict) and isinstance(s.get(k), dict):
            s[k] = {**s[k], **v}
        else:
            s[k] = v
    return s


# --------------------------------------------------------------------------
# Series
# --------------------------------------------------------------------------


class Series:
    def __init__(self, doc: dict | None):
        self.start = iso_to_ord(doc["startDate"]) if doc else 0
        self.values = list(doc["values"]) if doc else []

    def __bool__(self) -> bool:
        return bool(self.values)

    @property
    def end(self) -> int:
        return self.start + len(self.values) - 1

    def get(self, o: int):
        i = o - self.start
        if 0 <= i < len(self.values):
            v = self.values[i]
            if v is None or (isinstance(v, float) and not math.isfinite(v)):
                return None
            return v
        return None


def valid(v) -> bool:
    """A reading the CHIRPS fit and the checks use: present, finite, ≥ 0."""
    return v is not None and math.isfinite(v) and v >= 0


def period_days(p: dict) -> range:
    if "waterYear" in p and p.get("waterYear") is not None:
        y = int(p["waterYear"])
        return range(_dt.date(y, 10, 1).toordinal(), _dt.date(y + 1, 9, 30).toordinal() + 1)
    return range(iso_to_ord(p["start"]), iso_to_ord(p["end"]) + 1)


def days_of(periods) -> set[int]:
    out: set[int] = set()
    for p in periods or []:
        out.update(period_days(p))
    return out


# --------------------------------------------------------------------------
# Rain (docs/model.md §2.4b–§2.4d, §2.10a)
# --------------------------------------------------------------------------

ZERO_RUN_PLAIN_DAYS = 180
CLIMATOLOGY_MIN_DAYS_PER_MONTH = 56
LOW_VS_CHIRPS_MIN_DAYS = 180
LOW_VS_CHIRPS_MIN_MM = 50
RATIO_BASELINE_MIN_YEARS = 5
FIT_MIN_DAYS = 90
FIT_MIN_MM = 50
FACTOR_MIN, FACTOR_MAX = 0.25, 4.0
ACC_MIN_MM = 20
ACC_MIN_RUN_DAYS = 3
ACC_READING_DAY_SHARE = 0.25
ACC_RUN_SHARE = 0.5
ACC_MAX_RUN_DAYS = 92


def flagged_zero_runs(c: Series, min_wet_days: int) -> list[list[int]]:
    """§2.10a: runs of exact zeros with 60+ days in the series' six wettest
    calendar months, or 180+ days when there is no usable climatology."""
    if not c:
        return []
    sums = [0.0] * 13
    counts = [0] * 13
    for i, v in enumerate(c.values):
        if valid(v):
            m = cal_month(c.start + i)
            sums[m] += v
            counts[m] += 1
    usable = all(counts[m] >= CLIMATOLOGY_MIN_DAYS_PER_MONTH for m in range(1, 13)) and any(
        sums[m] > 0 for m in range(1, 13)
    )
    wet: set[int] = set()
    if usable:
        means = sorted(range(1, 13), key=lambda m: (-(sums[m] / counts[m]), m))
        wet = set(means[:6])
    runs: list[list[int]] = []
    cur: list[int] = []
    for i, v in enumerate(c.values):
        o = c.start + i
        if v is not None and math.isfinite(v) and v == 0:
            cur.append(o)
        else:
            if cur:
                runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    out = []
    for r in runs:
        if usable:
            if sum(1 for o in r if cal_month(o) in wet) >= min_wet_days:
                out.append(r)
        elif len(r) >= ZERO_RUN_PLAIN_DAYS:
            out.append(r)
    return out


def low_vs_chirps_years(c: Series, h: Series) -> set[int]:
    """§2.10a: water years whose catchment/CHIRPS ratio is below 50 % of the
    record's usual (median) ratio."""
    if not c or not h:
        return set()
    per: dict[int, list[float]] = {}
    for i, v in enumerate(c.values):
        o = c.start + i
        w = h.get(o)
        if valid(v) and valid(w):
            acc = per.setdefault(water_year(o), [0, 0.0, 0.0])
            acc[0] += 1
            acc[1] += v
            acc[2] += w
    judged = {y: a[1] / a[2] for y, a in per.items() if a[0] >= LOW_VS_CHIRPS_MIN_DAYS and a[2] >= LOW_VS_CHIRPS_MIN_MM}
    if len(judged) >= RATIO_BASELINE_MIN_YEARS:
        vals = sorted(judged.values())
        n = len(vals)
        usual = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
    else:
        usual = 1.0
    return {y for y, r in judged.items() if r < 0.5 * usual}


def fit_chirps_factors(c: Series, h: Series, left_out_days: set[int], left_out_years: set[int]):
    """§2.4b: factor(m) = Σ catchment / Σ CHIRPS over the shared days of
    calendar month m, with the minimum sample, the pooled fallback and the
    clamp. Returns 13 entries (index = calendar month), None = no factor."""
    sc = [0.0] * 13
    sh = [0.0] * 13
    n = [0] * 13
    if c and h:
        for i, v in enumerate(c.values):
            o = c.start + i
            if o in left_out_days or water_year(o) in left_out_years:
                continue
            w = h.get(o)
            if valid(v) and valid(w):
                m = cal_month(o)
                sc[m] += v
                sh[m] += w
                n[m] += 1
    pc, ph, pn = sum(sc), sum(sh), sum(n)
    pooled = pc / ph if pn >= FIT_MIN_DAYS and ph >= FIT_MIN_MM else None
    out: list = [None] * 13
    for m in range(1, 13):
        f = sc[m] / sh[m] if n[m] >= FIT_MIN_DAYS and sh[m] >= FIT_MIN_MM else pooled
        out[m] = None if f is None else min(FACTOR_MAX, max(FACTOR_MIN, f))
    return out


def corrected_chirps(h: Series, factors, o: int, apply: bool):
    w = h.get(o)
    if w is None:
        return None
    f = factors[cal_month(o)] if apply else None
    return w * f if f is not None else w


def detect_accumulations(c: Series, h: Series, factors, blocked: set[int]):
    """§2.4d: reading ≥ 20 mm after ≥ 3 days of 0 or blank; CHIRPS × the
    factors (raw where a month has none) little on the reading day ± 1 and a
    lot over the window's run days (the day before the reading left out)."""
    wins = []
    if not c or not h:
        return wins

    def ch(o):
        v = corrected_chirps(h, factors, o, True)
        return 0.0 if v is None else v

    for i, v in enumerate(c.values):
        if v is None or not math.isfinite(v) or v < ACC_MIN_MM:
            continue
        r = c.start + i
        k = 0
        j = i - 1
        while j >= 0:
            u = c.values[j]
            if u is None or (isinstance(u, float) and not math.isfinite(u)) or u == 0:
                k += 1
                j -= 1
            else:
                break
        if k < ACC_MIN_RUN_DAYS or h.get(r) is None:
            continue
        run_days = list(range(r - min(k, ACC_MAX_RUN_DAYS), r))
        if ch(r - 1) + ch(r) + ch(r + 1) >= ACC_READING_DAY_SHARE * v:
            continue
        if sum(ch(o) for o in run_days if o != r - 1) < ACC_RUN_SHARE * v:
            continue
        window = run_days + [r]
        if any(o in blocked for o in window):
            continue
        wins.append({"days": window, "reading": r, "total": v})
    return wins


def prepare_rain(settings: dict, series: dict) -> dict:
    """Rain final per day for any ordinal, plus the run window. Returns a dict
    with `final(o)` (None = no value), `source(o)`, `chirps_factor`, and the
    first / last usable rain days."""
    c = Series(series.get("rain_catchment_mm"))
    h = Series(series.get("rain_chirps_mm"))
    fc = Series(series.get("rain_forecast_mm"))
    zr = settings["zeroRainRuns"]
    mode = zr.get("mode", "missing")
    acc_mode = zr.get("accumulationMode", "spread")
    bias_on = settings["chirpsBiasCorrection"] == "monthly"

    flagged = flagged_zero_runs(c, int(settings["dataQuality"].get("zeroRunMinWetDays", 60)))
    flagged_days = {o for r in flagged for o in r}
    missing_days = days_of(zr.get("missing"))
    keep_dry = days_of(zr.get("keepDry"))
    low_years = low_vs_chirps_years(c, h)

    kept_dry = flagged_days & keep_dry if mode == "missing" else set()
    flagged_out = flagged_days - kept_dry  # left out of the fit, day by day
    base_left_out = flagged_out | missing_days
    det_factors = fit_chirps_factors(c, h, base_left_out, low_years)
    blocked = missing_days | (keep_dry if mode == "missing" else set())
    windows = detect_accumulations(c, h, det_factors, blocked)
    window_days = {o for w in windows for o in w["days"]}
    factors = fit_chirps_factors(c, h, base_left_out | window_days, low_years)

    set_aside = ((flagged_days - kept_dry) if mode == "missing" else set()) | missing_days
    set_aside -= window_days - missing_days

    spread: dict[int, float] = {}
    if acc_mode == "spread":
        for w in windows:
            vals = {}
            for o in w["days"][:-1]:
                v = corrected_chirps(h, factors, o, bias_on)
                vals[o] = 0.0 if v is None else v
            vr = corrected_chirps(h, factors, w["reading"], bias_on)
            total_ch = sum(vals.values()) + (0.0 if vr is None else vr)
            if total_ch > 0:
                acc = 0.0
                for o in w["days"][:-1]:
                    spread[o] = w["total"] * vals[o] / total_ch
                    acc += spread[o]
                spread[w["reading"]] = w["total"] - acc
            else:
                for o in w["days"][:-1]:
                    spread[o] = 0.0
                spread[w["reading"]] = w["total"]

    def pick(o: int):
        if o in spread:
            return spread[o], 0
        if o not in set_aside:
            v = c.get(o)
            if v is not None:
                return v, 0
        v = corrected_chirps(h, factors, o, bias_on)
        if v is not None:
            return v, 2
        v = fc.get(o)
        if v is not None:
            return v, 4
        return None, None

    # §2.1: the run follows the rain record: the first (last) day with a
    # catchment reading (set aside or not), CHIRPS or forecast rain.
    cands = []
    for s in (c, h, fc):
        firsts = [s.start + i for i, v in enumerate(s.values) if v is not None and math.isfinite(v)]
        if firsts:
            cands.append((firsts[0], firsts[-1]))
    first = min(a for a, _ in cands) if cands else None
    last = max(b for _, b in cands) if cands else None
    diag = {
        "zero_run_days_set_aside": len(set_aside - missing_days),
        "accumulation_windows": len(windows),
        "low_vs_chirps_years": len(low_years),
    }
    return {
        "diag": diag,
        "pick": pick,
        "factors": factors if bias_on else [None] * 13,
        "fit_factors": factors,
        "first": first,
        "last": last,
        "chirps": h,
        "bias_on": bias_on,
    }


# --------------------------------------------------------------------------
# GR4J (docs/model.md §2.4a)
# --------------------------------------------------------------------------


def uh_ordinates(x4: float):
    def sh1(t):
        if t <= 0:
            return 0.0
        if t < x4:
            return (t / x4) ** 2.5
        return 1.0

    def sh2(t):
        if t <= 0:
            return 0.0
        if t <= x4:
            return 0.5 * (t / x4) ** 2.5
        if t < 2 * x4:
            return 1 - 0.5 * (2 - t / x4) ** 2.5
        return 1.0

    n1 = math.ceil(x4)
    n2 = math.ceil(2 * x4)
    return [sh1(j) - sh1(j - 1) for j in range(1, n1 + 1)], [sh2(j) - sh2(j - 1) for j in range(1, n2 + 1)]


class Gr4j:
    def __init__(self, x1, x2, x3, x4):
        self.x1, self.x2, self.x3, self.x4 = x1, x2, x3, x4
        self.uh1, self.uh2 = uh_ordinates(x4)
        self.s = 0.5 * x1
        self.r = 0.5 * x3
        self.q1 = [0.0] * len(self.uh1)
        self.q2 = [0.0] * len(self.uh2)

    def step(self, p: float, e: float):
        x1, x2, x3 = self.x1, self.x2, self.x3
        if p >= e:
            pn, en = p - e, 0.0
        else:
            pn, en = 0.0, e - p
        s = self.s
        ps = es = 0.0
        if pn > 0:
            tw = math.tanh(pn / x1)
            ps = x1 * (1 - (s / x1) ** 2) * tw / (1 + (s / x1) * tw)
        if en > 0:
            tw = math.tanh(en / x1)
            es = s * (2 - s / x1) * tw / (1 + (1 - s / x1) * tw)
        s = s - es + ps
        perc = s * (1 - (1 + (4 * s / (9 * x1)) ** 4) ** -0.25)
        s -= perc
        pr = perc + (pn - ps)

        def route(queue, ords, inflow):
            n = len(ords)
            new = [0.0] * n
            for k in range(n - 1):
                new[k] = queue[k + 1] + ords[k] * inflow
            new[n - 1] = ords[n - 1] * inflow
            return new

        self.q1 = route(self.q1, self.uh1, 0.9 * pr)
        self.q2 = route(self.q2, self.uh2, 0.1 * pr)
        q9 = self.q1[0]
        q1 = self.q2[0]
        self.q1[0] = 0.0
        self.q2[0] = 0.0
        f = x2 * (self.r / x3) ** 3.5 if x2 != 0 else 0.0
        r_before = self.r
        r = max(0.0, self.r + q9 + f)
        applied = r - r_before - q9
        qr = r * (1 - (1 + (r / x3) ** 4) ** -0.25)
        r -= qr
        qd = max(0.0, q1 + f)
        self.s = s
        self.r = r
        aet = min(p, e) + es
        # The exchange left after the two clips (§2.4a "Fluxes recorded").
        return {"q": qr + qd, "aet": aet, "exchange": applied + (qd - q1)}

    def uh_store(self) -> float:
        return sum(self.q1) + sum(self.q2)


# --------------------------------------------------------------------------
# Network helpers
# --------------------------------------------------------------------------


def topo_order(nodes: list[dict]) -> list[dict]:
    by_id = {n["id"]: n for n in nodes}
    ups: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for n in nodes:
        d = n.get("downstreamNodeId")
        if d is not None:
            ups[d].append(n["id"])
    order: list[dict] = []
    seen: set[str] = set()

    def visit(i):
        if i in seen:
            return
        seen.add(i)
        for u in sorted(ups[i]):
            visit(u)
        order.append(by_id[i])

    for n in sorted(nodes, key=lambda n: n["id"]):
        if n.get("downstreamNodeId") is None:
            visit(n["id"])
    return order


def flow_shares(settings: dict, farms: list[dict]) -> dict[str, float]:
    method = settings["flowShareMethod"]
    fs = sorted(farms, key=lambda n: n["id"])
    if method == "manual":
        return {n["id"]: float(n.get("flowShareManual") or 0) for n in fs}
    if method == "hiLo":
        hi = 0.0
        lo = 0.0
        for n in fs:
            hi += n.get("areaHiKm2") or 0
        for n in fs:
            lo += n.get("areaLoKm2") or 0
        sp = settings["hiLoSplit"]
        out = {}
        for n in fs:
            a = (n.get("areaHiKm2") or 0) / hi * sp["hi"] if hi > 0 else 0.0
            b = (n.get("areaLoKm2") or 0) / lo * sp["lo"] if lo > 0 else 0.0
            out[n["id"]] = a + b
        return out
    tot = 0.0
    for n in fs:
        tot += n.get("areaKm2") or 0
    return {n["id"]: ((n.get("areaKm2") or 0) / tot if tot > 0 else 0.0) for n in fs}


def farm_efficiency(node: dict, rows: list[tuple[dict, float]], apan: list[float]) -> float:
    """§2.3 item 6: the harmonic mean of the crops' efficiencies weighted by
    their annual gross requirement at the monthly A-pan."""
    e_f = node["irrigationEfficiency"]

    def own(crop):
        e = crop.get("irrigationEfficiency")
        return e if isinstance(e, (int, float)) and 0 < e <= 1 else None

    if not any(own(c) is not None for c, a in rows if a > 0):
        return e_f
    ws = []
    for crop, area in rows:
        ws.append(area * sum(max(0.0, crop["cropFactor"][m]) * max(0.0, apan[m]) for m in range(12)))
    if sum(ws) == 0:
        ws = [area * sum(max(0.0, crop["cropFactor"][m]) for m in range(12)) for crop, area in rows]
    num = 0.0
    den = 0.0
    for (crop, area), w in zip(rows, ws):
        e = own(crop) or e_f
        num += w
        den += w / e
    return num / den if den > 0 else e_f


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------


def unsupported(doc: dict) -> list[str]:
    """What an input uses beyond phase 1 (verify/README.md § Phase 2)."""
    s = doc.get("settings", {}) or {}
    m = doc.get("model", {}) or {}
    out = []
    if m.get("boreholes"):
        out.append("individual boreholes")
    if m.get("landCover"):
        out.append("land cover")
    if m.get("demandObjects"):
        out.append("demand objects")
    if m.get("allocations") and s.get("allocationMode") not in (None, "none"):
        out.append("allocations")
    for n in m.get("nodes", []):
        if n.get("kind") == "user":
            out.append("other water users")
        if n.get("boreholeCapacityM3Day"):
            out.append("boreholes")
        if n.get("supplyRule") not in (None, "damFirst"):
            out.append("supply rules")
        if n.get("damCurve"):
            out.append("dam survey curves")
        if n.get("damReleaseRule") not in (None, "none"):
            out.append("dam releases")
        if n.get("handsOffM3Day") or n.get("handsOffEwr") or n.get("divertMonthlyM3Day"):
            out.append("hands-off flow / River to dam by month")
        if n.get("damSedimentPctPerYear") or n.get("damInServiceFrom") or n.get("abstractionFrom"):
            out.append("time-varying development")
        if n.get("demandFactor"):
            out.append("demand factors")
    for t in m.get("transfers", []):
        if t.get("source") == "river":
            out.append("river off-takes")
    if s.get("rainSource"):
        out.append("rain-source periods")
    if s.get("arealRain"):
        out.append("areal rainfall correction")
    if s.get("ewrRules"):
        out.append("Reserve rule tables")
    if isinstance(s.get("chirpsFitPeriod"), list):
        out.append("CHIRPS fit ranges")
    zr = s.get("zeroRainRuns") or {}
    if zr.get("keepDry") or zr.get("keepReadings") or zr.get("addAccumulations"):
        out.append("keep-dry / keep-readings / listed accumulations")
    dq = s.get("dataQuality") or {}
    for k in ("zeroRunRule", "zeroRunChirpsCheck", "lowVsChirpsRatio", "lowVsChirpsBaseline", "lowVsChirpsMinimum"):
        if k in dq and dq[k] not in (None, "wetDays", False, 0.5, "record", "fixed"):
            out.append("non-default data-quality limits")
    if (doc.get("series") or {}).get("evap_apan_mm"):
        out.append("daily A-pan series")
    if s.get("damStorageReset") or s.get("demandFactorFrom"):
        out.append("outlook-only settings")
    return sorted(set(out))


def run(doc: dict) -> dict:
    settings = merge_settings(doc.get("settings") or {})
    model = doc["model"]
    series = doc.get("series") or {}
    rain = prepare_rain(settings, series)

    start = iso_to_ord(settings["simulationStart"]) if settings.get("simulationStart") else rain["first"]
    end = iso_to_ord(settings["simulationEnd"]) if settings.get("simulationEnd") else rain["last"]
    days = list(range(start, end + 1))
    n = len(days)
    wm = [wy_month(o) for o in days]
    mdays = month_days(settings)

    out: list[dict] = []
    diag = dict(rain["diag"])
    diag.update(chirps_days=0, forecast_days=0, forecast_tail=0, room_bound=0, band_split=0, transfer_days=0,
                charge_days=0, multi_site_charge_days=0, dead_storage_days=0, spill_days=0)

    def put(node_id, key, values):
        out.append({"nodeId": node_id, "key": key, "values": values})

    # ---- rain -----------------------------------------------------------
    finals = []
    sources = []
    for o in days:
        v, src = rain["pick"](o)
        finals.append(NAN if v is None else v)
        sources.append(src)
    diag["chirps_days"] = sum(1 for x in sources if x == 2)
    diag["forecast_days"] = sum(1 for x in sources if x == 4)
    p_used = [0.0 if (math.isnan(v) or v < 0) else v for v in finals]
    thr = settings["calibration"]["rainThresholdMm"]
    rain_demand = [v if v > thr else 0.0 for v in p_used]
    put(None, "rain_final", finals)

    # ---- GR4J -----------------------------------------------------------
    g = settings["gr4j"]
    apan = [float(x) for x in settings["apanMm"]]
    pe = settings["pe"]
    pet = []
    for o, m in zip(days, wm):
        if pe.get("kind") == "monthly":
            monthly = pe["mm"][m]
        else:
            monthly = settings["panCoefficient"][m] * apan[m]
        pet.append(monthly / calendar_days_in_month(o))
    # §2.4f: the forecast tail (forecast-sourced days after the last day of
    # any other source) is never cycled into the warm-up.
    last_obs = max((i for i, s in enumerate(sources) if s in (0, 1, 2, 3)), default=None)
    hist = n
    if last_obs is not None:
        tail = [i for i in range(last_obs + 1, n) if sources[i] == 4]
        if tail:
            hist = tail[0]
            diag["forecast_tail"] = n - hist
    # §2.4a: no evaporation, no run (GR4J_NO_PET).
    if pe.get("kind") == "monthly":
        no_pet = all(x == 0 for x in pe["mm"])
    else:
        no_pet = all(settings["panCoefficient"][m] * apan[m] == 0 for m in range(12))
    if no_pet:
        raise Refused("GR4J_NO_PET")
    model_g = Gr4j(g["x1"], g["x2"], g["x3"], g["x4"])
    for k in range(int(g.get("warmupDays", 365))):
        i = k % hist if hist > 0 else 0
        model_g.step(p_used[i], pet[i])
    farms = [x for x in model["nodes"] if x["kind"] == "farm"]
    area_km2 = settings["calibration"].get("catchmentAreaKm2")
    if area_km2 is None:
        area_km2 = 0.0
        for f in sorted(farms, key=lambda x: x["id"]):
            area_km2 += f.get("areaKm2") or 0
    if not area_km2 > 0:
        raise Refused("catchment area is 0")
    shares_all = flow_shares(settings, farms)
    tot_share = 0.0
    for f in sorted(farms, key=lambda x: x["id"]):
        tot_share += shares_all[f["id"]]
    if tot_share > 1 + 0.0002:
        raise Refused("flow shares over 1")
    natural, aet, prod, rout, uhs, exch = [], [], [], [], [], []
    for i in range(n):
        r = model_g.step(p_used[i], pet[i])
        natural.append(r["q"] * area_km2 * 1000)
        aet.append(r["aet"])
        prod.append(model_g.s)
        rout.append(model_g.r)
        uhs.append(model_g.uh_store())
        exch.append(r["exchange"])
    put(None, "rain_used", p_used)
    put(None, "pet", pet)
    put(None, "aet", aet)
    put(None, "production_store", prod)
    put(None, "routing_store", rout)
    put(None, "uh_store", uhs)
    put(None, "natural_flow", natural)
    if g["x2"] != 0:
        put(None, "exchange", exch)
    if rain["chirps"] and rain["bias_on"] and any(f is not None for f in rain["fit_factors"][1:]):
        put(None, "chirps_factor", [NAN if rain["fit_factors"][cal_month(o)] is None else rain["fit_factors"][cal_month(o)] for o in days])
        put(
            None,
            "rain_chirps_corrected",
            [NAN if (v := corrected_chirps(rain["chirps"], rain["fit_factors"], o, True)) is None else v for o in days],
        )

    # ---- demand (§2.3) --------------------------------------------------
    crops = {c["id"]: c for c in model.get("crops", [])}
    shares = flow_shares(settings, farms)
    eff_monthly = settings.get("effectiveRainFractionMonthly")
    store_mm = settings["effectiveRainStoreMm"]
    fd: dict[str, dict] = {}
    for f in farms:
        rows = [
            (crops[a["cropId"]], a["areaM2"])
            for a in sorted(
                (a for a in model.get("cropAreas", []) if a["nodeId"] == f["id"] and a["cropId"] in crops),
                key=lambda a: (a["cropId"], a["areaM2"]),
            )
        ]
        cropped = 0.0
        for _, a in rows:
            cropped += a
        e = farm_efficiency(f, rows, apan)
        smax = cropped * store_mm / 1000
        w = 0.0
        gross_s, eff_s, soil_s, F_s, D_s = [], [], [], [], []
        for i, m in enumerate(wm):
            gross = 0.0
            for crop, a in rows:
                gross += a * (apan[m] * crop["cropFactor"][m]) / 1000 / mdays[m]
            frac = eff_monthly[m] if eff_monthly else settings["effectiveRainFraction"]
            pe_m3 = cropped * frac / 1000 * rain_demand[i]
            available = w + pe_m3
            used = min(available, max(0.0, gross))
            F = max(0.0, gross) - used
            w = min(smax, available - used)
            gross_s.append(gross)
            eff_s.append(used)
            soil_s.append(w / cropped * 1000 if cropped > 0 else 0.0)
            F_s.append(F)
            D_s.append(F / e)
        fd[f["id"]] = {"gross": gross_s, "eff": eff_s, "soil": soil_s, "F": F_s, "D": D_s, "e": e}

    # ---- network (§2.5–§2.7b) -------------------------------------------
    nodes = model["nodes"]
    by_id = {x["id"]: x for x in nodes}
    order = topo_order(nodes)
    ups: dict[str, list[str]] = {x["id"]: [] for x in nodes}
    for x in nodes:
        d = x.get("downstreamNodeId")
        if d is not None:
            ups[d].append(x["id"])
    for k in ups:
        ups[k].sort()
    outlet = next(x for x in order if x.get("downstreamNodeId") is None)
    # Every node upstream of (or at) each node, for the EWR sites.
    upstream_set: dict[str, set[str]] = {}
    for x in order:
        s = {x["id"]}
        for u in ups[x["id"]]:
            s |= upstream_set[u]
        upstream_set[x["id"]] = s

    ewr = [float(settings["ewrPragmaticM3PerDay"][m]) for m in wm]
    k_lake = settings.get("lakeEvapFactorMonthly") or [settings["lakeEvapFactor"]] * 12

    rules = []
    for t in model.get("transfers", []):
        if not t.get("enabled", True) or t.get("source", "dam") != "dam":
            continue
        if t["fromNodeId"] not in by_id or t["toNodeId"] not in by_id:
            continue
        if by_id[t["fromNodeId"]]["kind"] != "farm" or by_id[t["toNodeId"]]["kind"] != "farm":
            continue
        rules.append(t)
    rules.sort(key=lambda t: t["id"])

    def rule_rate(t, o, m):
        mr = t.get("monthlyRateM3s")
        if mr:
            return mr[m]
        return t["maxRateM3s"] if cal_month(o) in (t.get("months") or []) else 0.0

    def can_move(t):
        mr = t.get("monthlyRateM3s")
        lim_cap = t.get("dailyCapM3")
        if lim_cap is not None and lim_cap <= 0:
            return False
        if mr:
            return any(r > 0 for r in mr)
        return bool(t.get("months")) and t["maxRateM3s"] > 0

    names = [
        "inflow_upstream", "runoff", "transfer", "upstream_to_dam", "upstream_below_dam", "runoff_to_dam",
        "runoff_below_dam", "diverted_to_dam", "dam_area", "rain_on_dam", "dam_evaporation", "dam_seepage",
        "supplied", "interim_storage", "dam_storage", "spill", "below_dam_not_diverted", "return_flow", "outflow",
        "balance_residual", "deficit", "ewr", "ewr_cumulative", "ewr_shortfall", "ewr_shortfall_incremental",
        "dam_seepage_lost",
    ]
    col = {x["id"]: {k: [0.0] * n for k in names} for x in nodes}
    rule_vol = {t["id"]: [0.0] * n for t in rules}
    storage = {f["id"]: f["damInitialPct"] * f["damCapacityM3"] for f in farms}
    sim_out = [0.0] * n
    cat_short = [0.0] * n

    def noise_short(z, u):
        d = z - u
        if d <= 1e-12 * max(abs(z), abs(u)):
            return 0.0
        return -d

    for i, o in enumerate(days):
        m = wm[i]
        rf = p_used[i]
        # Start-of-day dam terms, before the transfers' clamps (§2.7a, §2.6).
        pre = {}
        for f in farms:
            cap = f["damCapacityM3"]
            s0 = storage[f["id"]]
            if cap > 0:
                a_full = f.get("damAreaFullM2")
                if a_full is None:
                    a_full = cap / 3
                b = f.get("damAreaExponent", 0.7)
                area = a_full * (s0 / cap) ** b if s0 > 0 else 0.0
                pd = rf * area / 1000
                seep = f.get("damSeepagePerDay") or 0.0
                e_raw = k_lake[m] * apan[m] / mdays[m] / 1000 * area
                if b > 1:
                    e_raw = min(e_raw, (1 - seep) * s0 / b)
                sp_raw = seep * s0
            else:
                area = pd = e_raw = sp_raw = 0.0
            pre[f["id"]] = (area, pd, e_raw, sp_raw)

        # Transfers (§2.6): by priority; each rule above its own reserve.
        J = {f["id"]: 0.0 for f in farms}
        drawn = {f["id"]: 0.0 for f in farms}
        sched = {f["id"]: 0.0 for f in farms}
        active = []
        for t in rules:
            rate = rule_rate(t, o, m)
            if rate > 0:
                lim = rate * 86400
                if t.get("dailyCapM3") is not None:
                    lim = min(lim, t["dailyCapM3"])
                active.append((t, lim))
        for prio in sorted({t["priority"] for t, _ in active}):
            group = [(t, lim) for t, lim in active if t["priority"] == prio]
            want = {}
            reserve = {}
            for t, lim in group:
                src = by_id[t["fromNodeId"]]
                res = src["damCapacityM3"] * max(t.get("minStoragePct") or 0.0, src.get("damMinPct") or 0.0)
                reserve[t["id"]] = res
                free = max(0.0, storage[src["id"]] - drawn[src["id"]] - res)
                want[t["id"]] = min(lim, free)
            # The receiver's room, shared pro rata to the rules' limits.
            for dst in sorted({t["toNodeId"] for t, _ in group}):
                f = by_id[dst]
                area, pd, e_raw, sp_raw = pre[dst]
                room = f["damCapacityM3"] - (storage[dst] + pd - e_raw - sp_raw) + fd[dst]["D"][i] - sched[dst]
                room = max(0.0, room)
                into = [t for t, _ in group if t["toNodeId"] == dst]
                tot = sum(want[t["id"]] for t in into)
                if tot > room and tot > 0:
                    diag["room_bound"] += 1
                    for t in into:
                        want[t["id"]] = want[t["id"]] * room / tot
            # The source's water in bands at its rules' reserves.
            vol = {t["id"]: 0.0 for t, _ in group}
            for src in sorted({t["fromNodeId"] for t, _ in group}):
                from_src = [t for t, _ in group if t["fromNodeId"] == src]
                top = storage[src] - drawn[src]
                cur = top
                left = {t["id"]: want[t["id"]] for t in from_src}
                levels = sorted({reserve[t["id"]] for t in from_src}, reverse=True)
                if len(levels) > 1 and any(want[t["id"]] > 0 for t in from_src):
                    diag["band_split"] += 1
                for level in levels:
                    band = max(0.0, cur - level)
                    cur = min(cur, level)
                    elig = [t for t in from_src if reserve[t["id"]] <= level and left[t["id"]] > 0]
                    tot = sum(left[t["id"]] for t in elig)
                    if band <= 0 or tot <= 0:
                        continue
                    for t in elig:
                        give = left[t["id"]] if tot <= band else band * left[t["id"]] / tot
                        vol[t["id"]] += give
                        left[t["id"]] -= give
            if any(vol[t["id"]] > 0 for t, _ in group):
                diag["transfer_days"] += 1
            for t, _ in group:
                v = vol[t["id"]]
                rule_vol[t["id"]][i] = v
                J[t["fromNodeId"]] -= v
                J[t["toNodeId"]] += v
                drawn[t["fromNodeId"]] += v
                sched[t["toNodeId"]] += v

        # Nodes, upstream first (§2.7).
        U: dict[str, float] = {}
        Z: dict[str, float] = {}
        AA: dict[str, float] = {}
        for x in order:
            xid = x["id"]
            cc = col[xid]
            H = 0.0
            for u in ups[xid]:
                H += U[u]
            zu = 0.0
            for u in ups[xid]:
                zu += Z[u]
            aau = 0.0
            for u in ups[xid]:
                aau += AA[u]
            cc["inflow_upstream"][i] = H
            if x["kind"] != "farm":
                U[xid] = H
                Z[xid] = zu
                AA[xid] = noise_short(zu, H)
                cc["outflow"][i] = H
                cc["ewr_cumulative"][i] = zu
                cc["ewr_shortfall"][i] = AA[xid]
                continue
            d = fd[xid]
            cap = x["damCapacityM3"]
            s_prev = storage[xid]
            area, pd, e_raw, sp_raw = pre[xid]
            j = J[xid]
            I = natural[i] * shares.get(xid, 0.0)
            K = H * x["pctUpstreamToDam"]
            L = H - K
            M = I * x["pctRunoffToDam"]
            N = I - M
            O = min(x.get("divertCapacityM3Day") or 0.0, L + N)
            if cap > 0:
                E = min(e_raw, s_prev + pd + j)
                Sp = min(sp_raw, s_prev + pd + j - E)
            else:
                E = Sp = 0.0
            startd = s_prev + pd - E - Sp
            avail = startd + M + O + K + j
            dead = cap * (x.get("damMinPct") or 0.0)
            D = d["D"][i]
            G = min(max(avail - dead, 0.0), D)
            P = avail - G
            Q = min(P, cap)
            R = max(P - cap, 0.0)
            S = L + N - O
            beta = x["lossReturnFraction"]
            T = beta * (1 - d["e"]) * G
            ret = x.get("damSeepageReturnPct", 1)
            if ret is None:
                ret = 1
            Uo = R + S + T + Sp * ret
            lost = Sp * (1 - ret)
            V = (H + I + j + pd) - (G - T) - E - (Q - s_prev) - Uo - lost
            Y = ewr[i] * shares.get(xid, 0.0)
            z = Y + zu
            aa = noise_short(z, Uo)
            ab = min(aa - aau, 0.0)
            for key, val in (
                ("runoff", I), ("transfer", j), ("upstream_to_dam", K), ("upstream_below_dam", L),
                ("runoff_to_dam", M), ("runoff_below_dam", N), ("diverted_to_dam", O), ("dam_area", area),
                ("rain_on_dam", pd), ("dam_evaporation", E), ("dam_seepage", Sp), ("supplied", G),
                ("interim_storage", P), ("dam_storage", Q), ("spill", R), ("below_dam_not_diverted", S),
                ("return_flow", T), ("outflow", Uo), ("balance_residual", V), ("deficit", D - G), ("ewr", Y),
                ("ewr_cumulative", z), ("ewr_shortfall", aa), ("ewr_shortfall_incremental", ab),
                ("dam_seepage_lost", lost),
            ):
                cc[key][i] = val
            if cap > 0 and G < D and avail > 0 and avail <= dead + 1e-9 * cap:
                diag["dead_storage_days"] += 1
            if R > 0 and cap > 0:
                diag["spill_days"] += 1
            storage[xid] = Q
            U[xid] = Uo
            Z[xid] = z
            AA[xid] = aa
        sim_out[i] = U[outlet["id"]]
        cat_short[i] = noise_short(ewr[i], sim_out[i])

    put(None, "simulated_outflow", sim_out)
    put(None, "ewr", ewr)
    put(None, "ewr_shortfall", cat_short)

    # ---- EWR attribution (§2.7b) ----------------------------------------
    sites = [(None, outlet["id"])] + [
        (x["id"], x["id"])
        for x in sorted(nodes, key=lambda x: x["id"])
        if x["kind"] == "gauge" and x.get("ewrSite", True) is not False and x["id"] != outlet["id"]
    ]
    farm_ids = sorted(f["id"] for f in farms)
    depth = {}
    for x in reversed(order):
        dn = x.get("downstreamNodeId")
        depth[x["id"]] = 0 if dn is None else depth[dn] + 1
    charge = {f: [0.0] * n for f in farm_ids}
    site_index = {site_node: k for k, (_, site_node) in enumerate(sites)}
    n_sites_above = {f: sum(1 for _, sn in sites if f in upstream_set[sn]) for f in farm_ids}
    binding = {f: [NAN] * n for f in farm_ids if n_sites_above[f] >= 2}
    charge_irr = {f: [0.0] * n for f in farm_ids}
    site_series = {}
    for site_key, site_node in sites:
        members = [f for f in farm_ids if f in upstream_set[site_node]]
        site_series[site_key] = (members, [0.0] * n, [0.0] * n)
    for i in range(n):
        best: dict[str, tuple[float, int, float]] = {}
        for site_key, site_node in sites:
            members, charged_s, natural_s = site_series[site_key]
            if site_key is None:
                short = -cat_short[i]
            else:
                short = -col[site_node]["ewr_shortfall"][i]
            mset = set(members)
            imp = {}
            for f in members:
                jint = 0.0
                for t in rules:
                    v = rule_vol[t["id"]][i]
                    if t["fromNodeId"] in mset and t["toNodeId"] in mset:
                        if t["fromNodeId"] == f:
                            jint -= v
                        if t["toNodeId"] == f:
                            jint += v
                cc = col[f]
                e_f = cc["inflow_upstream"][i] + cc["runoff"][i] + jint - cc["outflow"][i]
                scale = max(abs(cc["inflow_upstream"][i]), abs(cc["runoff"][i]), abs(cc["outflow"][i]), abs(jint))
                imp[f] = e_f if e_f > 1e-12 * scale else 0.0
            members_sorted = sorted(members, key=lambda f: (-depth[f], f))
            E_s = 0.0
            for f in members_sorted:
                E_s += imp[f]
            dstar = min(short, E_s)
            charged_s[i] = -dstar if dstar > 0 else 0.0
            natural_s[i] = -(short - dstar) if short - dstar > 0 else 0.0
            for f in members:
                a = dstar * imp[f] / E_s if E_s > 0 and dstar > 0 else 0.0
                sd = depth[site_node]
                cur = best.get(f)
                if cur is None or a > cur[0] + 1e-9 or (abs(a - cur[0]) <= 1e-9 and sd < cur[1]):
                    best[f] = (a, sd, imp[f], site_index[site_node])
        if any(b[0] > 0 for b in best.values()):
            diag["charge_days"] += 1
        for f, (a, _, e_bind, site_k) in best.items():
            if a <= 0:
                continue
            if f in binding:
                binding[f][i] = float(site_k)
                diag["multi_site_charge_days"] += 1
            G = col[f]["supplied"][i]
            T = col[f]["return_flow"][i]
            c = G - T
            o_ = e_bind - c
            den = c + max(o_, 0.0)
            a_irr = a * c / den if den > 0 else 0.0
            charge[f][i] = -a
            charge_irr[f][i] = -a_irr

    # ---- write the node series ------------------------------------------
    for x in nodes:
        xid = x["id"]
        cc = col[xid]
        if x["kind"] == "farm":
            d = fd[xid]
            put(xid, "gross_demand", d["gross"])
            put(xid, "effective_rain", d["eff"])
            put(xid, "soil_water", d["soil"])
            put(xid, "crop_requirement", d["F"])
            put(xid, "demand", d["D"])
            for k in names:
                put(xid, k, cc[k])
            put(xid, "ewr_charge", charge[xid])
            put(xid, "ewr_charge_irrigation", charge_irr[xid])
            if xid in binding:
                put(xid, "ewr_binding_site", binding[xid])
        else:
            for k in ("inflow_upstream", "outflow", "ewr_cumulative", "ewr_shortfall"):
                put(xid, k, cc[k])
    for site_key, _ in sites:
        _, charged_s, natural_s = site_series[site_key]
        put(site_key, "ewr_charged", charged_s)
        put(site_key, "ewr_natural", natural_s)
    for t in rules:
        if can_move(t):
            put(t["fromNodeId"], f"transfer_rule@{t['id']}", rule_vol[t["id"]])

    return {"startDate": ord_to_iso(start), "endDate": ord_to_iso(end), "days": n, "series": out, "diag": diag}
