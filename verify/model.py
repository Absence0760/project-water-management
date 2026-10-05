"""An independent Python implementation of the water-balance model's core
daily chain, written only from the documentation (verify/README.md says which
parts and which docs). It never reads packages/engine/src: where the docs
don't say what the engine does, that is a documentation finding, fixed in
docs/model.md from the engine's observed outputs, not from its code.

Stdlib only. `run(input_doc)` takes a ModelInput document (the JSON the
engine's `runModel` takes) and returns
    { startDate, endDate, days, series: [{ nodeId, key, values }], diag, summary }
with NaN where a day has no value.

Phase 1 covers: rain used (source order, threshold, CHIRPS fill with the
monthly bias factors, zero-rain runs and multi-day accumulations as
documented), GR4J, crop demand with the soil-water store and efficiency /
return share (N1), the farm dam balance (evaporation, rain on the dam,
seepage and its return share, minimum operating level, spill), routing down
the tree, dam-to-dam transfers (priority, bands at each rule's reserve, pro
rata, the receiver's room) and the EWR at sites with its attribution (Q17).
Phase 2a adds boreholes and stream depletion (§2.7d), allocations, the
licence cap and full-allocation runs (§2.12a, with the summary's capReached,
limitBound and scaled rows), demand factors (§2.3 item 4a), demand objects
and the basic-needs floor (§2.7f), river off-takes and canal seepage (§2.6a),
other water users (§2.7c), supply rules and the river pump (§2.7e), dam
survey curves and releases (§2.7a) and hands-off flows with River to dam by
month (§2.7h). `unsupported(input_doc)` lists what an input uses beyond that.
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
ACC_MAX_BLANK_DAYS = 7


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


def detect_accumulations(c: Series, h: Series, factors, blocked: set[int], missing: set[int]):
    """§2.4d: reading ≥ 20 mm after ≥ 3 days of 0 or blank; CHIRPS × the
    factors (raw where a month has none) little on the reading day ± 1 and a
    lot over the window's run days (the day before the reading left out).
    Engine ≥ 1.70.0: a day listed as missing reads as blank, and a stretch of
    more than 7 blank days in a row (measured whole) is an outage that ends
    the run; a reading straight after one is judged over the outage's last
    92 days instead and, when it passes, set aside. Returns (windows,
    set-aside reading days)."""
    wins = []
    set_aside = []
    if not c or not h:
        return wins, set_aside

    def ch(o):
        v = corrected_chirps(h, factors, o, True)
        return 0.0 if v is None else v

    def blank(j):
        u = c.values[j]
        return (c.start + j) in missing or u is None or (isinstance(u, float) and not math.isfinite(u))

    for i, v in enumerate(c.values):
        if blank(i) or v < ACC_MIN_MM:
            continue
        r = c.start + i
        k = 0
        outage = 0
        j = i - 1
        while j >= 0:
            if blank(j):
                s = j
                while s >= 0 and blank(s):
                    s -= 1
                if j - s > ACC_MAX_BLANK_DAYS:
                    outage = j - s
                    break
                k += j - s
                j = s
            elif c.values[j] == 0:
                k += 1
                j -= 1
            else:
                break
        if h.get(r) is None:
            continue
        if k >= ACC_MIN_RUN_DAYS:
            run_days = list(range(r - min(k, ACC_MAX_RUN_DAYS), r))
        elif k == 0 and outage > 0:
            run_days = list(range(r - min(outage, ACC_MAX_RUN_DAYS), r))
        else:
            continue
        if ch(r - 1) + ch(r) + ch(r + 1) >= ACC_READING_DAY_SHARE * v:
            continue
        if sum(ch(o) for o in run_days if o != r - 1) < ACC_RUN_SHARE * v:
            continue
        if k == 0:
            if r not in blocked:
                set_aside.append(r)
            continue
        window = run_days + [r]
        if any(o in blocked for o in window):
            continue
        wins.append({"days": window, "reading": r, "total": v})
    return wins, set_aside


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
    windows, outage_readings = detect_accumulations(c, h, det_factors, blocked, missing_days)
    window_days = {o for w in windows for o in w["days"]}
    # A reading after an outage is left out of the fit in either mode; in
    # 'spread' mode its day is set aside (CHIRPS, then forecast, fill it).
    factors = fit_chirps_factors(c, h, base_left_out | window_days | set(outage_readings), low_years)

    set_aside = ((flagged_days - kept_dry) if mode == "missing" else set()) | missing_days
    set_aside -= window_days - missing_days
    if acc_mode != "asRecorded":
        set_aside |= set(outage_readings)

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
        "zero_run_days_set_aside": len(set_aside - missing_days - set(outage_readings)),
        "accumulation_windows": len(windows),
        "accumulation_readings_set_aside": len(outage_readings),
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


# model.md §2.3: the SABI 2021 systems a model without its own table runs on (engine DEFAULT_IRRIGATION_SYSTEMS).
DEFAULT_SYSTEMS = {"drip": 0.9, "micro": 0.82, "pivot": 0.85, "sprinkler": 0.8, "movable": 0.75, "surface": 0.7}


def farm_efficiency(node: dict, rows: list[tuple[dict, float, dict]], apan: list[float], systems: dict[str, float]) -> float:
    """§2.3 item 6: the harmonic mean of the plantings' efficiencies weighted by
    their annual gross requirement at the monthly A-pan. A planting's efficiency
    (engine >= 1.72.0) is its own system on the unit's, else its crop's default
    system's (`systems`, the model's table by id), else the crop's own (before
    1.72.0), else the unit's."""
    e_f = node["irrigationEfficiency"]

    def valid(e):
        return e if isinstance(e, (int, float)) and 0 < e <= 1 else None

    def own(crop, planting):
        # The planting's system, then the crop's: one the table lacks is skipped for the next.
        for sid in (planting.get("irrigationSystemId"), crop.get("irrigationSystemId")):
            if sid is not None and valid(systems.get(sid)) is not None:
                return systems[sid]
        return valid(crop.get("irrigationEfficiency"))

    if not any(own(c, p) is not None for c, a, p in rows if a > 0):
        return e_f
    ws = []
    for crop, area, _ in rows:
        ws.append(area * sum(max(0.0, crop["cropFactor"][m]) * max(0.0, apan[m]) for m in range(12)))
    if sum(ws) == 0:
        ws = [area * sum(max(0.0, crop["cropFactor"][m]) for m in range(12)) for crop, area, _ in rows]
    num = 0.0
    den = 0.0
    for (crop, area, planting), w in zip(rows, ws):
        e = own(crop, planting) or e_f
        num += w
        den += w / e
    return num / den if den > 0 else e_f


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------


def unsupported(doc: dict) -> list[str]:
    """What an input uses beyond phases 1 and 2a (verify/README.md § Phase 2b)."""
    s = doc.get("settings", {}) or {}
    m = doc.get("model", {}) or {}
    out = []
    if m.get("landCover"):
        out.append("land cover")
    for n in m.get("nodes", []):
        if n.get("damSedimentPctPerYear") or n.get("damInServiceFrom") or n.get("abstractionFrom"):
            out.append("time-varying development")
        if n.get("partDemandFactor"):
            out.append("demand factors by part (demand.scale by part)")
    if s.get("chirpsQuantileMap"):
        out.append("CHIRPS quantile map")
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
    if s.get("damStorageReset"):
        out.append("dam storage reset (outlook only)")
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
                charge_days=0, multi_site_charge_days=0, dead_storage_days=0, spill_days=0,
                # Phase 2a: days (unit-days) each feature did something.
                borehole_days=0, borehole_to_dam_days=0, borehole_annual_cap_days=0, depletion_owed_days=0,
                cap_bound_days=0, full_allocation_units=0, floor_days=0, object_shortage_days=0,
                offtake_days=0, offtake_return_days=0, user_days=0, junior_short_days=0, senior_pass_days=0,
                river_pump_days=0, river_take_days=0, trigger_hold_days=0, curve_days=0, release_days=0, hands_off_days=0,
                divert_by_month_days=0)

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


    # ---- demand (§2.3, §2.3 item 4a, §2.7c, §2.7f) ------------------------
    crops = {c["id"]: c for c in model.get("crops", [])}
    shares = flow_shares(settings, farms)
    eff_monthly = settings.get("effectiveRainFractionMonthly")
    store_mm = settings["effectiveRainStoreMm"]
    nodes = model["nodes"]
    by_id = {x["id"]: x for x in nodes}
    users = [x for x in nodes if x["kind"] == "user"]
    # §2.3 item 4a: the nodes' demand factors, from settings.demandFactorFrom on.
    dff = settings.get("demandFactorFrom")
    dff_o = iso_to_ord(dff) if isinstance(dff, str) and _is_iso(dff) else None

    def dfac(x, i):
        f = x.get("demandFactor")
        if not f or (dff_o is not None and days[i] < dff_o):
            return 1.0
        return float(f[wm[i]])

    fd: dict[str, dict] = {}
    # The model's irrigation systems by id (engine >= 1.72.0), else the SABI defaults.
    systems = {x["id"]: x["efficiency"] for x in model["irrigationSystems"]} if model.get("irrigationSystems") else dict(DEFAULT_SYSTEMS)
    for f in farms:
        rows = [
            (crops[a["cropId"]], a["areaM2"], a)
            for a in sorted(
                (a for a in model.get("cropAreas", []) if a["nodeId"] == f["id"] and a["cropId"] in crops),
                key=lambda a: (a["cropId"], a["areaM2"]),
            )
        ]
        cropped = 0.0
        for _, a, _p in rows:
            cropped += a
        e = farm_efficiency(f, rows, apan, systems)
        smax = cropped * store_mm / 1000
        w = 0.0
        gross_s, eff_s, soil_s, F_s, D_s, F0_s = [], [], [], [], [], []
        for i, m in enumerate(wm):
            gross = 0.0
            for crop, a, _p in rows:
                gross += a * (apan[m] * crop["cropFactor"][m]) / 1000 / mdays[m]
            frac = eff_monthly[m] if eff_monthly else settings["effectiveRainFraction"]
            pe_m3 = cropped * frac / 1000 * rain_demand[i]
            available = w + pe_m3
            need = max(0.0, gross)
            # Rain short of the need by no more than 1e-12 of it covers it (§2.3).
            used = need if need - available <= 1e-12 * need else available
            F0_s.append(need - used)
            F = (need - used) * dfac(f, i)
            w = min(smax, max(0.0, available - used))
            gross_s.append(gross)
            eff_s.append(used)
            soil_s.append(w / cropped * 1000 if cropped > 0 else 0.0)
            F_s.append(F)
            D_s.append(F / e)
        fd[f["id"]] = {"gross": gross_s, "eff": eff_s, "soil": soil_s, "F": F_s, "Dc": D_s, "e": e, "F0": F0_s}

    # Demand objects (§2.7f): enabled, on a farm, in id order.
    objs: dict[str, list[dict]] = {f["id"]: [] for f in farms}
    for ob in sorted(model.get("demandObjects") or [], key=lambda o: o["id"]):
        if not ob.get("enabled", True) or ob.get("nodeId") not in by_id or by_id[ob["nodeId"]]["kind"] != "farm":
            continue
        objs[ob["nodeId"]].append(ob)
    obj_dem: dict[str, list[float]] = {}
    obj_floor: dict[str, list[float]] = {}
    # Each object's demand before the demand factor (its month × its schedule): a full allocation fits on it.
    obj_raw: dict[str, list[float]] = {}
    obj_B: dict[str, float] = {}
    for fid, lst in objs.items():
        x = by_id[fid]
        for ob in lst:
            per_unit = ob.get("sizing") == "perUnit"
            loss = (ob.get("lossPct") or 0.0) if per_unit else 0.0
            if per_unit:
                mf = ob.get("monthlyFactor")
                base = [ob["count"] * ob["litresPerUnitDay"] / 1000 * (mf[m] if mf else 1.0) / (1 - loss) for m in range(12)]
            else:
                base = [float(v) for v in ob["monthlyM3Day"]]
            pop = ob.get("population")
            if pop is None and per_unit:
                pop = ob.get("count")
            B = None
            if ob.get("category") in ("domestic", "municipal") and pop is not None:
                B = pop * BASIC_LITRES / 1000 / (1 - loss)
            sched = ob.get("schedule") or []
            dem, flo, raw = [], [], []
            for i, o in enumerate(days):
                s = schedule_factor(sched, o)
                raw.append(base[wm[i]] * s)
                f_ = dfac(x, i)
                v = base[wm[i]] * f_ * s
                if B is not None and f_ < 1:
                    if min(B, base[wm[i]] * s) > v:
                        diag["floor_days"] += 1
                    v = max(v, min(B, base[wm[i]] * s))
                dem.append(v)
                flo.append(min(B, v) if B is not None else NAN)
            obj_dem[ob["id"]] = dem
            obj_floor[ob["id"]] = flo
            obj_raw[ob["id"]] = raw
            if B is not None:
                obj_B[ob["id"]] = B

    # The unit's abstraction demand, D (after its demand factors), and D_base before them: a full
    # allocation's factor is fitted on D_base and the demand factors apply after it (§2.12a, engine 1.70.0).
    D_fact: dict[str, list[float]] = {}
    D_base: dict[str, list[float]] = {}
    for f in farms:
        dd, db = [], []
        for i in range(n):
            v = fd[f["id"]]["Dc"][i]
            b = fd[f["id"]]["F0"][i] / fd[f["id"]]["e"]
            for ob in objs[f["id"]]:
                v += obj_dem[ob["id"]][i]
                b += obj_raw[ob["id"]][i]
            dd.append(v)
            db.append(b)
        D_fact[f["id"]] = dd
        D_base[f["id"]] = db
    for u in users:
        ud = u.get("userDemandM3Day")
        D_base[u["id"]] = [float(ud[wm[i]]) if ud else 0.0 for i in range(n)]
        D_fact[u["id"]] = [float(ud[wm[i]]) * dfac(u, i) if ud else 0.0 for i in range(n)]

    # ---- allocations (§2.12a) -------------------------------------------
    alloc_mode = settings.get("allocationMode") or "none"
    allocs = read_allocations(model, by_id)
    ald: dict[str, dict[str, list[dict]]] = {}
    for a in allocs:
        ald.setdefault(a["nodeId"], {}).setdefault(a["waterSource"], []).append(a)
    kf: dict[str, list[float]] = {}
    fa_scaled: dict[str, list] = {}
    if alloc_mode == "fullAllocation":
        for nid, bysrc in ald.items():
            both = sorted(bysrc.get("surface", []) + bysrc.get("groundwater", []), key=lambda a: a["id"])
            # Each water year over its run days; the year a forecast tail
            # starts in over its historical days only (§2.4f). A later year,
            # all tail, is an ordinary part year.
            # (A tail that starts on 1 October starts a year with no historical
            # days: that year is a part year over its tail days.)
            tail_y = water_year(days[hist]) if 0 < hist < n and water_year(days[hist - 1]) == water_year(days[hist]) else None
            yrs: dict[int, list[int]] = {}
            for i in range(n):
                if i >= hist and water_year(days[i]) == tail_y:
                    continue
                yrs.setdefault(water_year(days[i]), []).append(i)
            fac_y: dict[int, float] = {}
            vol_y: dict[int, float] = {}
            dem_y: dict[int, float] = {}
            scaled_rows: list = []
            fa_scaled[nid] = scaled_rows
            unlicensed: set[int] = set()
            for y, idx in yrs.items():
                # §2.12a (engine >= 1.70.0): no allocation in force on the days a year is scaled
                # on: the unit keeps its modelled demand there (factor 1), not listed as scaled.
                if not any(a["from"] <= days[i] <= a["to"] for a in both for i in idx):
                    unlicensed.add(y)
                    fac_y[y] = 1.0
                    continue
                vol = 0.0
                for a in both:
                    inside = sum(1 for i in idx if a["from"] <= days[i] <= a["to"])
                    vol += a["volume"] * inside / wy_length(y)
                tot = 0.0
                for i in idx:
                    tot += D_base[nid][i]
                fac_y[y] = vol / tot if tot > 0 else 0.0
                vol_y[y] = vol
                dem_y[y] = tot
            # The summary's rows: the demand before over every run day of the
            # year (a forecast tail's too) and the volume it was scaled to.
            ally: dict[int, list[int]] = {}
            for i in range(n):
                ally.setdefault(water_year(days[i]), []).append(i)
            for y, idx in sorted(ally.items()):
                if y in unlicensed:
                    continue
                tot = 0.0
                for i in idx:
                    tot += D_base[nid][i]
                # A year with no demand on the days it is scaled on can't be
                # scaled: the row keeps the volume registered over those days,
                # the year a forecast tail starts in too (its historical days).
                if dem_y.get(y, 0.0) > 0:
                    reg = fac_y.get(y, 0.0) * tot
                else:
                    reg = vol_y.get(y, 0.0)
                scaled_rows.append({"waterYear": y, "demandM3": tot, "registeredM3": reg})
            ks = []
            for i in range(n):
                y = water_year(days[i])
                ks.append(fac_y.get(y, 0.0))
            kf[nid] = ks
            diag["full_allocation_units"] += 1
    Dn: dict[str, list[float]] = {}
    for nid, dd in D_base.items():
        if nid in kf:
            k = kf[nid]
            if nid in fd:
                fd[nid]["F"] = [fd[nid]["F"][i] * k[i] for i in range(n)]
                fd[nid]["Dc"] = [fd[nid]["Dc"][i] * k[i] for i in range(n)]
                # Each object: its raw demand × k, then the demand factor, never below MIN(floor, raw × k).
                for ob in objs[nid]:
                    od = obj_dem[ob["id"]]
                    rw = obj_raw[ob["id"]]
                    B = obj_B.get(ob["id"])
                    x = by_id[nid]
                    for i in range(n):
                        f_ = dfac(x, i)
                        v = rw[i] * k[i] * f_
                        if B is not None and f_ < 1:
                            v = max(v, min(B, rw[i] * k[i]))
                        od[i] = v
                dn = []
                for i in range(n):
                    v = fd[nid]["Dc"][i]
                    for ob in objs[nid]:
                        v += obj_dem[ob["id"]][i]
                    dn.append(v)
                Dn[nid] = dn
            else:
                Dn[nid] = [D_fact[nid][i] * k[i] for i in range(n)]
        else:
            Dn[nid] = list(D_fact[nid])
    capped = alloc_mode == "cap"

    # ---- river abstractions beside a unit's dam (§2.7j) -------------------
    # Each demand with water source 'river' (the crops, or an enabled object) has its own pump (None = no
    # limit) and a pool (capacity > 0; it starts full, its full area 7.2 × capacity^0.77, b = 0.7). Its supply
    # level is its place in the unit's supply order (supply_key; the crops with 'shared'). The dam side serves
    # the other demands only.
    # ---- the crop supply table (§2.7k) ------------------------------------
    # Shares of the crop demand asked of the unit's dam side, the river (the crops' river abstraction) and
    # another unit's dam. All three None = no table (cropWaterSource); a share outside [0, 1] counts 0; shares
    # not adding up to 1 are scaled to; all on the dam or all on the river is that water source.
    tab: dict[str, dict] = {}
    one_src: dict[str, str] = {}
    for f in farms:
        raw = [f.get("cropShareDam"), f.get("cropShareRiver"), f.get("cropShareRemote")]
        if all(v is None for v in raw):
            continue
        sh = [v if v is not None and 0 <= v <= 1 else 0.0 for v in raw]
        tot = sh[0] + sh[1] + sh[2]
        if not tot > 0:
            continue
        if abs(tot - 1) > 1e-6:
            sh = [v / tot for v in sh]
        if sh[1] == 0 and sh[2] == 0:
            one_src[f["id"]] = "dam"
        elif sh[0] == 0 and sh[2] == 0:
            one_src[f["id"]] = "river"
        else:
            tab[f["id"]] = {"dam": sh[0], "river": sh[1], "remote": sh[2]}

    def crop_share(fid, src):
        """The share of the crops' demand asked of the dam side or the river (§2.7j, §2.7k)."""
        if fid in tab:
            return tab[fid][src]
        on = one_src.get(fid, by_id[fid].get("cropWaterSource"))
        return (1.0 if on == "river" else 0.0) if src == "river" else (0.0 if on == "river" else 1.0)

    # The remote shares the run can supply, in the receivers' id order: another unit with a dam, which the
    # receiver doesn't drain into along the river, the river off-takes or a remote share accepted before it.
    down = {x["id"]: x.get("downstreamNodeId") for x in nodes}
    links: dict[str, list[str]] = {x["id"]: [] for x in nodes}
    for t in model.get("transfers", []):
        if t.get("source") == "river" and t.get("enabled", True) and t["fromNodeId"] in links and t["toNodeId"] in links and t["fromNodeId"] != t["toNodeId"]:
            links[t["fromNodeId"]].append(t["toNodeId"])

    def reaches(a, b):
        seen, stack = set(), [a]
        while stack:
            k = stack.pop()
            if k == b:
                return True
            if k in seen or k is None:
                continue
            seen.add(k)
            stack.append(down.get(k))
            stack.extend(links.get(k, []))
        return False

    remote: dict[str, dict] = {}
    for fid in sorted(f for f in tab if tab[f]["remote"] > 0):
        src = by_id[fid].get("cropRemoteNodeId")
        sx = by_id.get(src) if src else None
        if sx is None or sx["kind"] != "farm" or src == fid or not sx["damCapacityM3"] > 0 or reaches(fid, src):
            continue
        links[src].append(fid)
        pc_ = by_id[fid].get("cropRemoteCapM3Day")
        remote[fid] = {"from": src, "share": tab[fid]["remote"], "cap": math.inf if pc_ is None else pc_}
    remote_into: dict[str, list[str]] = {}
    for fid in sorted(remote):
        remote_into.setdefault(remote[fid]["from"], []).append(fid)

    riv: dict[str, list[dict]] = {}
    for f in farms:
        ts = []

        def kit(pump_, pool_):
            return {"pump": math.inf if pump_ is None else pump_, "pool": pool_ if pool_ is not None and pool_ > 0 else None}

        if crop_share(f["id"], "river") > 0:
            ts.append({"key": "crops", "ob": None, "level": (1, 0), **kit(f.get("cropRiverPumpM3Day"), f.get("cropRiverPoolM3"))})
        for ob in objs[f["id"]]:
            if ob.get("waterSource") == "river":
                ts.append({"key": ob["id"], "ob": ob, "level": supply_key(ob), **kit(ob.get("riverPumpM3Day"), ob.get("riverPoolM3"))})
        if ts:
            riv[f["id"]] = ts
    pool_q = {fid: [t["pool"] or 0.0 for t in ts] for fid, ts in riv.items()}
    on_river_obj = {ob["id"] for ts in riv.values() for t in ts if t["ob"] is not None for ob in [t["ob"]]}

    # The dam side's demand: its dam-sourced demands only (the crops' abstraction, or its share of it under a
    # table, §2.7k; the objects not on the river).
    Dd: dict[str, list[float]] = {}
    for fid in sorted(set(riv) | set(tab)):
        dd = []
        for i in range(n):
            v = crop_share(fid, "dam") * fd[fid]["Dc"][i]
            for ob in objs[fid]:
                if ob["id"] not in on_river_obj:
                    v += obj_dem[ob["id"]][i]
            dd.append(v)
        Dd[fid] = dd

    def dam_dem(fid, i):
        return Dd[fid][i] if fid in Dd else Dn[fid][i]

    # ---- network (§2.5–§2.7h) -------------------------------------------
    order = network_order(nodes, model.get("transfers", []), [(r["from"], fid) for fid, r in remote.items()])
    ups: dict[str, list[str]] = {x["id"]: [] for x in nodes}
    for x in nodes:
        d = x.get("downstreamNodeId")
        if d is not None:
            ups[d].append(x["id"])
    for k in ups:
        ups[k].sort()
    outlet = next(x for x in nodes if x.get("downstreamNodeId") is None)
    upstream_set: dict[str, set[str]] = {}
    for x in topo_order(nodes):
        s = {x["id"]}
        for u in ups[x["id"]]:
            s |= upstream_set[u]
        upstream_set[x["id"]] = s

    ewr = [float(settings["ewrPragmaticM3PerDay"][m]) for m in wm]
    k_lake = settings.get("lakeEvapFactorMonthly") or [settings["lakeEvapFactor"]] * 12

    # Senior users' requirement fragmented to the farms upstream (§2.7c).
    seniors = sorted((u for u in users if u.get("userPriority", "senior") != "junior"), key=lambda u: u["id"])
    sen_y: dict[str, list[float]] = {f["id"]: [0.0] * n for f in farms}
    any_senior = False
    for u in seniors:
        up_farms = sorted(f["id"] for f in farms if f["id"] in upstream_set[u["id"]])
        tot = 0.0
        for fid in up_farms:
            tot += shares.get(fid, 0.0)
        if tot <= 0:
            continue
        if any(v > 0 for v in Dn[u["id"]]):
            any_senior = True
        for fid in up_farms:
            for i in range(n):
                sen_y[fid][i] += Dn[u["id"]][i] * shares.get(fid, 0.0) / tot

    # Transfer rules: dam rules (§2.6) and river off-takes (§2.6a).
    rules = []
    offtakes = []
    for t in model.get("transfers", []):
        if not t.get("enabled", True):
            continue
        if t["fromNodeId"] not in by_id or t["toNodeId"] not in by_id:
            continue
        if by_id[t["fromNodeId"]]["kind"] != "farm" or by_id[t["toNodeId"]]["kind"] != "farm":
            continue
        if t.get("source", "dam") == "river":
            offtakes.append(t)
        else:
            rules.append(t)
    rules.sort(key=lambda t: t["id"])
    offtakes.sort(key=lambda t: t["id"])
    ot_from: dict[str, list[dict]] = {}
    ot_into: dict[str, list[dict]] = {}
    for t in offtakes:
        ot_from.setdefault(t["fromNodeId"], []).append(t)
        ot_into.setdefault(t["toNodeId"], []).append(t)

    def rule_rate(t, o, m):
        mr = t.get("monthlyRateM3s")
        if mr:
            return mr[m]
        return t["maxRateM3s"] if cal_month(o) in (t.get("months") or []) else 0.0

    def rule_limit(t, o, m):
        rate = rule_rate(t, o, m)
        if not rate > 0:
            return 0.0
        lim = rate * 86400
        if t.get("dailyCapM3") is not None:
            lim = min(lim, t["dailyCapM3"])
        return lim

    def can_move(t):
        mr = t.get("monthlyRateM3s")
        lim_cap = t.get("dailyCapM3")
        if lim_cap is not None and lim_cap <= 0:
            return False
        if mr:
            return any(r > 0 for r in mr)
        return bool(t.get("months")) and t["maxRateM3s"] > 0

    # Pumping units per node (§2.7d): the combined capacity first, then the
    # individual boreholes in id order.
    units: dict[str, list[dict]] = {}
    for x in nodes:
        if x["kind"] not in ("farm", "user"):
            continue
        lst = []
        c = x.get("boreholeCapacityM3Day")
        if c:
            rule = x.get("boreholeRule") or "supplemental"
            lst.append({
                "id": None, "cap": float(c), "annual": None,
                "mode": "emergency" if rule == "drought" else rule,
                "level": x.get("boreholeTriggerPct", 0.3) if x.get("boreholeTriggerPct") is not None else 0.3,
                "target": "direct", "d": x.get("streamDepletionFrac") or 0.0,
            })
        for b in sorted((b for b in model.get("boreholes") or [] if b.get("nodeId") == x["id"]), key=lambda b: b["id"]):
            if b.get("mode", "none") == "none":
                continue
            lst.append({
                "id": b["id"], "cap": float(b["capacityM3Day"]), "annual": b.get("annualCapM3"), "mode": b["mode"],
                "level": b.get("emergencyBelowPct", 0.3), "target": b.get("target", "direct"),
                "d": b.get("depletionFactor") or 0.0,
            })
        has_dam = x["kind"] == "farm" and x["damCapacityM3"] > 0
        for u_ in lst:
            if not has_dam:
                if u_["mode"] == "emergency":
                    u_["mode"] = "supplemental"
                u_["target"] = "direct"
        if lst:
            units[x["id"]] = lst
    has_bh = {x["id"] for x in nodes if x["kind"] in ("farm", "user") and (x.get("boreholeCapacityM3Day") or any(b.get("nodeId") == x["id"] for b in model.get("boreholes") or []))}

    def supply_rule(x):
        r = x.get("supplyRule") or "damFirst"
        if r == "trigger" and x["damCapacityM3"] <= 0:
            return "riverFirst"
        if r == "runOfRiver" and x["damCapacityM3"] > 0:
            return "riverFirst"
        return r

    names = [
        "inflow_upstream", "runoff", "transfer", "upstream_to_dam", "upstream_below_dam", "runoff_to_dam",
        "runoff_below_dam", "diverted_to_dam", "dam_area", "rain_on_dam", "dam_evaporation", "dam_seepage",
        "supplied", "interim_storage", "dam_storage", "spill", "below_dam_not_diverted", "return_flow", "outflow",
        "balance_residual", "deficit", "ewr", "ewr_cumulative", "ewr_shortfall", "ewr_shortfall_incremental",
        "dam_seepage_lost", "dam_release", "river_abstraction", "groundwater_used", "groundwater_to_dam",
        "baseflow_depletion", "depletion_deficit", "depletion_store", "senior_requirement", "passed_for_senior",
        "offtake_out", "offtake_in", "offtake_used", "offtake_to_dam", "offtake_loss_return",
        "allocation_room_surface", "allocation_room_groundwater", "allocation_left_surface", "allocation_left_groundwater",
        "basic_needs", "remote_dam_in", "remote_dam_out",
    ]
    col = {x["id"]: {k: [0.0] * n for k in names} for x in nodes}
    rule_vol = {t["id"]: [0.0] * n for t in rules + offtakes}
    obj_sup = {ob["id"]: [0.0] * n for lst in objs.values() for ob in lst}
    # Each river abstraction's take, pool storage and pool evaporation (§2.7j).
    river_cols = {fid: {t["key"]: {"take": [0.0] * n, "pool": [0.0] * n, "evap": [0.0] * n} for t in ts} for fid, ts in riv.items()}
    storage = {f["id"]: f["damInitialPct"] * f["damCapacityM3"] for f in farms}
    on_river = {f["id"]: False for f in farms}
    sd_store = {x["id"]: 0.0 for x in nodes}
    dd_owed = {x["id"]: 0.0 for x in nodes}
    bh_used = {x["id"]: [0.0] * len(units.get(x["id"], [])) for x in nodes}
    al_used = {(nid, s): 0.0 for nid, bysrc in ald.items() for s in bysrc}
    al_budget: dict[tuple, float] = {}
    al_capped_y: set[tuple] = set()
    lb_days: dict[tuple, dict] = {}
    sim_out = [0.0] * n
    cat_short = [0.0] * n
    ewr_share = {x["id"]: shares.get(x["id"], 0.0) for x in farms}
    use_y: dict[tuple, float] = {}

    def spend(nid, src, v):
        # §2.12a (engine >= 1.70.0): use on a day none of the source's allocations is in
        # force isn't capped and doesn't count against the year's volume.
        if not math.isfinite(room[(nid, src)][3]):
            return
        al_used[(nid, src)] += v
        k_ = (nid, src, water_year(days[i]))
        use_y[k_] = use_y.get(k_, 0.0) + v

    def noise_short(z, u):
        d = z - u
        if d <= 1e-12 * max(abs(z), abs(u)):
            return 0.0
        return -d

    def area_of(f, s0):
        cap = f["damCapacityM3"]
        curve = usable_curve(f.get("damCurve"))
        if curve:
            return curve_area(curve, s0)
        a_full = f.get("damAreaFullM2")
        if a_full is None:
            # Maaren & Moolman (1985) via Sawunyama (2013): A = 7.2 C^0.77 m² (engine >= 1.61.0).
            a_full = 7.2 * cap ** 0.77
        b = f.get("damAreaExponent", 0.7)
        return (a_full * (s0 / cap) ** b if s0 > 0 else 0.0), None

    for i, o in enumerate(days):
        m = wm[i]
        rf = p_used[i]
        wy = water_year(o)
        if i == 0 or (_dt.date.fromordinal(o).month == 10 and _dt.date.fromordinal(o).day == 1):
            for k in bh_used:
                bh_used[k] = [0.0] * len(bh_used[k])
            for k in al_used:
                al_used[k] = 0.0
        # Allocation rooms at the start of the day (§2.12a).
        room = {}
        for (nid, s) in al_used:
            if not capped:
                continue
            lst = ald[nid][s]
            if (nid, s, wy) not in al_budget:
                b = 0.0
                for a in lst:
                    b += a["volume"] * overlap_days(wy, a["from"], a["to"]) / wy_length(wy)
                al_budget[(nid, s, wy)] = b
            # §2.12a (engine >= 1.70.0): a day none of the unit's allocations of the source is
            # in force on isn't capped, as a unit with no allocation of it: no room, no budget.
            if not any(a["from"] <= o <= a["to"] for a in lst):
                room[(nid, s)] = (math.inf, math.inf, math.inf, math.inf)
                continue
            al_capped_y.add((nid, s, wy))
            budget = al_budget[(nid, s, wy)]
            left = max(0.0, budget - al_used[(nid, s)])
            limit = licence_limit(lst, o)
            room[(nid, s)] = (min(left, limit), left, limit, budget)
        # Start-of-day dam terms, before the transfers' clamps (§2.7a, §2.6).
        pre = {}
        for f in farms:
            cap = f["damCapacityM3"]
            s0 = storage[f["id"]]
            if cap > 0:
                area, slope = area_of(f, s0)
                pd = rf * area / 1000
                seep = f.get("damSeepagePerDay") or 0.0
                e_raw = k_lake[m] * apan[m] / mdays[m] / 1000 * area
                if slope is None:
                    b = f.get("damAreaExponent", 0.7)
                    if b > 1:
                        e_raw = min(e_raw, (1 - seep) * s0 / b)
                elif slope > 0 and area > 0 and s0 * slope / area > 1:
                    e_raw = min(e_raw, (1 - seep) * area / slope)
                sp_raw = seep * s0
            else:
                area = pd = e_raw = sp_raw = 0.0
            pre[f["id"]] = (area, pd, e_raw, sp_raw)

        def draw_bound(fid):
            """§2.6: the most the dam can be drawn for the demand today (its dam side's, §2.7j)."""
            dem = dam_dem(fid, i)
            prim = 0.0
            for k_, u_ in enumerate(units.get(fid, [])):
                if u_["mode"] == "primary" and u_["target"] == "direct":
                    prim += unit_room(u_, bh_used[fid][k_])
            g = room.get((fid, "groundwater"))
            if g is not None:
                prim = min(prim, g[0])
            v = max(0.0, dem - prim)
            s_ = room.get((fid, "surface"))
            if s_ is not None:
                v = min(v, s_[0])
            return v

        # Dam transfers (§2.6): by priority; each rule above its own reserve.
        J = {f["id"]: 0.0 for f in farms}
        drawn = {f["id"]: 0.0 for f in farms}
        sched = {f["id"]: 0.0 for f in farms}
        active = []
        for t in rules:
            lim = rule_limit(t, o, m)
            if lim > 0 or rule_rate(t, o, m) > 0:
                active.append((t, lim))
        for prio in sorted({t["priority"] for t, _ in active}):
            group = [(t, lim) for t, lim in active if t["priority"] == prio]
            # Proportional rationing in rounds (engine >= 1.70.0, issue #90 Q25, §2.6): what each rule
            # still asks (its limit alone, never first cut to its source's free water or its receiver's room).
            rem = {}
            reserve = {}
            for t, lim in group:
                src = by_id[t["fromNodeId"]]
                reserve[t["id"]] = src["damCapacityM3"] * max(t.get("minStoragePct") or 0.0, src.get("damMinPct") or 0.0)
                rem[t["id"]] = lim
            # Each receiver's room.
            room_left = {}
            for dst in sorted({t["toNodeId"] for t, _ in group}):
                f = by_id[dst]
                area, pd, e_raw, sp_raw = pre[dst]
                after = storage[dst] + pd - e_raw - sp_raw
                floor_rel = 0.0
                if f["damCapacityM3"] > 0 and f.get("damReleaseRule") == "fixed" and f.get("damReleaseM3Day"):
                    # A fixed release's MIN(amount, outlet), in full (engine >= 1.70.0, issue #90 Q26).
                    outlet_c = f.get("damOutletCapacityM3Day")
                    floor_rel = max(0.0, min(f["damReleaseM3Day"][m], math.inf if outlet_c is None else outlet_c))
                rm = f["damCapacityM3"] - after + draw_bound(dst) + floor_rel - sched[dst]
                room_left[dst] = max(0.0, rm)
            full = {d for d, v in room_left.items() if not v > 0}
            vol = {t["id"]: 0.0 for t, _ in group}
            taken = {}
            while True:
                # (1) At each source, its water above each rule's reserve, in bands at the reserves, pro rata
                # to what each rule into a receiver that isn't full still asks.
                given = {t["id"]: 0.0 for t, _ in group}
                for src in sorted({t["fromNodeId"] for t, _ in group}):
                    from_src = [t for t, _ in group if t["fromNodeId"] == src and rem[t["id"]] > 0 and t["toNodeId"] not in full]
                    cur = storage[src] - drawn[src] - taken.get(src, 0.0)
                    left = {t["id"]: rem[t["id"]] for t in from_src}
                    levels = sorted({reserve[t["id"]] for t in from_src}, reverse=True)
                    if len(levels) > 1:
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
                            given[t["id"]] += give
                            left[t["id"]] -= give
                # (2) Each receiver's room, pro rata to what the sources gave; a receiver given more is full.
                basis = given
                filled = False
                for dst in sorted(room_left):
                    if dst in full:
                        continue
                    into = [t for t, _ in group if t["toNodeId"] == dst and rem[t["id"]] > 0]
                    tot = sum(basis[t["id"]] for t in into)
                    rm_left = room_left[dst]
                    for t in into:
                        x = min(given[t["id"]], basis[t["id"]] * rm_left / tot) if tot > rm_left else given[t["id"]]
                        x = min(x, max(0.0, storage[t["fromNodeId"]] - drawn[t["fromNodeId"]] - taken.get(t["fromNodeId"], 0.0)))
                        vol[t["id"]] += x
                        rem[t["id"]] -= x
                        taken[t["fromNodeId"]] = taken.get(t["fromNodeId"], 0.0) + x
                    if tot > rm_left:
                        diag["room_bound"] += 1
                        full.add(dst)
                        room_left[dst] = 0.0
                        filled = True
                    else:
                        room_left[dst] = rm_left - tot
                # (3) Room a source couldn't fill is offered again, while a receiver filled this round.
                if not filled:
                    break
            if any(vol[t["id"]] > 0 for t, _ in group):
                diag["transfer_days"] += 1
            for t, _ in group:
                v = vol[t["id"]]
                rule_vol[t["id"]][i] = v
                J[t["fromNodeId"]] -= v
                J[t["toNodeId"]] += v
                drawn[t["fromNodeId"]] += v
                sched[t["toNodeId"]] += v

        # River off-takes (§2.6a): each rule's share of its destination's
        # need, fixed before the day runs.
        ot_need: dict[str, float] = {}
        for dst, lst in ot_into.items():
            # Σ cap over the demand-sized rules into dst (a capacity-sized one takes no share of the need).
            caps = [(t, rule_limit(t, o, m)) for t in lst if t.get("sizing", "demand") != "capacity"]
            tot_cap = 0.0
            for t, c in caps:
                tot_cap += c
            f = by_id[dst]
            area, pd, e_raw, sp_raw = pre[dst]
            # The room after today's step: losses clamped as the step clamps them, today's
            # dam-rule receipts counted (engine >= 1.69.0); what it sends makes no room.
            held = storage[dst] + pd + J[dst]
            e_c = min(e_raw, max(held, 0.0))
            sp_c = min(sp_raw, max(held - e_c, 0.0))
            # A fixed release's MIN(amount, outlet) in full (engine >= 1.70.0, issue #90 Q26), as a dam rule's room.
            floor_ot = 0.0
            if f["damCapacityM3"] > 0 and f.get("damReleaseRule") == "fixed" and f.get("damReleaseM3Day"):
                outlet_o = f.get("damOutletCapacityM3Day")
                floor_ot = max(0.0, min(f["damReleaseM3Day"][m], math.inf if outlet_o is None else outlet_o))
            rm_dst = max(0.0, f["damCapacityM3"] - (storage[dst] + pd + sched[dst] - e_c - sp_c) + floor_ot)
            for t, c in caps:
                # Under an allocation cap, the demand the cap still allows (§2.6a, §2.12a, engine >= 1.70.0):
                # at most the destination's surface room at the start of the day; the top-up isn't capped.
                sr_ = room.get((dst, "surface"))
                need = min(dam_dem(dst, i), sr_[0] if sr_ else math.inf) + (rm_dst if t.get("topUpDam") else 0.0)
                ot_need[t["id"]] = need * c / tot_cap if tot_cap > 0 else 0.0
        arrived: dict[str, list[float]] = {}
        back_to: dict[str, list[tuple[str, float]]] = {}
        # The remote shares' asks (§2.7k), known before any unit runs: the share of the crop demand, up to the pipe
        # and, under a cap, the receiver's surface room at the start of the day. What each got is set at its source.
        rm_ask: dict[str, float] = {}
        rm_got: dict[str, float] = {}
        for fid, r_ in remote.items():
            a_ = min(r_["share"] * fd[fid]["Dc"][i], r_["cap"])
            sr_ = room.get((fid, "surface"))
            if sr_:
                a_ = min(a_, sr_[0])
            rm_ask[fid] = max(a_, 0.0)
            rm_got[fid] = 0.0

        # Nodes in network order (§2.7, §2.7c, §2.6a).
        U: dict[str, float] = {}
        Z: dict[str, float] = {}
        AA: dict[str, float] = {}
        ZS: dict[str, float] = {}
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
            zs_in = 0.0
            for u in ups[xid]:
                zs_in += ZS[u]
            cc["inflow_upstream"][i] = H
            if x["kind"] == "gauge":
                U[xid] = H
                Z[xid] = zu
                ZS[xid] = zs_in
                AA[xid] = noise_short(zu, H)
                cc["outflow"][i] = H
                cc["ewr_cumulative"][i] = zu
                cc["ewr_shortfall"][i] = AA[xid]
                cc["senior_requirement"][i] = zs_in
                continue
            dem = Dn[xid][i]
            sroom = room.get((xid, "surface"))
            groom = room.get((xid, "groundwater"))
            s_left = sroom[0] if sroom else math.inf
            g_left = groom[0] if groom else math.inf
            ulist = units.get(xid, [])
            used_u = bh_used[xid]
            pumped = [0.0] * len(ulist)

            def pump(k_, want_):
                nonlocal g_left
                v = max(0.0, min(unit_room(ulist[k_], used_u[k_] + pumped[k_]), want_, g_left))
                if ulist[k_]["annual"] is not None and want_ > v and v < ulist[k_]["cap"] and v < g_left:
                    diag["borehole_annual_cap_days"] += 1
                pumped[k_] += v
                g_left -= v
                return v

            if x["kind"] == "user":
                z = zu
                river = H if x.get("userPriority", "senior") != "junior" else max(0.0, H - zs_in)
                GW = 0.0
                for k_, u_ in enumerate(ulist):
                    if u_["mode"] == "primary":
                        GW += pump(k_, dem - GW)
                take = max(0.0, min(dem - GW, river, s_left))
                for k_, u_ in enumerate(ulist):
                    if u_["mode"] == "supplemental":
                        GW += pump(k_, dem - take - GW)
                G = take + GW
                diag["user_days"] += 1 if G > 0 else 0
                diag["borehole_days"] += 1 if GW > 0 else 0
                if x.get("userPriority", "senior") == "junior" and take < min(dem - GW, H) * (1 - 1e-9):
                    diag["junior_short_days"] += 1
                T = (x.get("userReturnPct") or 0.0) * G
                flow = H - take + T
                dep = deplete(x, xid, ulist, pumped, flow, sd_store, dd_owed, cc, i)
                Uo = flow - dep
                for k_ in range(len(ulist)):
                    used_u[k_] += pumped[k_]
                if sroom:
                    spend(xid, "surface", take)
                if groom:
                    spend(xid, "groundwater", GW)
                note_limit(lb_days, xid, wy, room, "surface", take, sroom, dem, dem - G, o, ald)
                note_limit(lb_days, xid, wy, room, "groundwater", GW, groom, dem, dem - G, o, ald)
                zs_out = max(0.0, zs_in - dem) if x.get("userPriority", "senior") != "junior" else zs_in
                for key, val in (("supplied", G), ("return_flow", T), ("outflow", Uo), ("deficit", dem - G),
                                 ("ewr_cumulative", z), ("groundwater_used", GW)):
                    cc[key][i] = val
                AA[xid] = noise_short(z, Uo)
                cc["ewr_shortfall"][i] = AA[xid]
                cc["senior_requirement"][i] = zs_out
                U[xid] = Uo
                Z[xid] = z
                ZS[xid] = zs_out
                for s_, r_ in (("surface", sroom), ("groundwater", groom)):
                    if r_:
                        # Blank (NaN) in a water year the source isn't capped in (§2.12a, engine >= 1.70.0).
                        cc[f"allocation_room_{s_}"][i] = r_[0] if math.isfinite(r_[3]) else math.nan
                        cc[f"allocation_left_{s_}"][i] = r_[1] if math.isfinite(r_[3]) else math.nan
                continue

            # A farm (§2.7). With river abstractions (§2.7j) its dam side is asked for its dam-sourced demand only.
            dem_all = dem
            if xid in Dd:
                dem = Dd[xid][i]
            d = fd[xid]
            # The remote share (§2.7k) has arrived (its source ran first): the unit's first surface use.
            gin = rm_got.get(xid, 0.0)
            if gin > 0:
                s_left = max(0.0, s_left - gin)
            cap = x["damCapacityM3"]
            s_prev = storage[xid]
            area, pd, e_raw, sp_raw = pre[xid]
            j = J[xid]
            rule_ = supply_rule(x)
            I = natural[i] * shares.get(xid, 0.0)
            y_ewr = ewr[i] * ewr_share[xid]
            z = y_ewr + zu
            zs = sen_y[xid][i] + zs_in
            if rule_ == "runOfRiver":
                K = M = 0.0
            else:
                K = H * x["pctUpstreamToDam"]
                M = I * x["pctRunoffToDam"]
            L = H - K
            N = I - M
            dm = x.get("divertMonthlyM3Day")
            dcap = float(dm[m]) if dm else (x.get("divertCapacityM3Day") or 0.0)
            if x["pctUpstreamToDam"] >= 1:
                dcap = 0.0  # a dam on the river takes no River to dam (§2.7 row O, engine >= 1.68.0)
            O = 0.0 if rule_ == "runOfRiver" else min(dcap, L + N)
            # The senior users' pass (§2.7c): O first, then K and M pro rata.
            passed = 0.0
            need = min(zs, H + I)
            if L + N - O < need:
                cut = min(O, need - (L + N - O))
                O -= cut
                passed += cut
                rest = need - (L + N - O)
                if need >= H + I and K + M > 0:
                    # Everything passes: K and M exactly 0.
                    passed += K + M
                    K = M = 0.0
                    L, N = H, I
                elif rest > 0 and K + M > 0:
                    kc = rest * K / (K + M)
                    mc = rest - kc
                    K -= kc
                    M -= mc
                    L = H - K
                    N = I - M
                    passed += rest
            # The hands-off flow (§2.7h).
            ho = x.get("handsOffM3Day")
            keep_h = max(float(ho[m]) if ho else 0.0, z if x.get("handsOffEwr") else 0.0)
            if keep_h > 0:
                o_before = O
                if cap > 0:
                    O = min(O, max(0.0, L + N - keep_h))
                else:
                    need = min(H + I, keep_h)
                    if L + N - O < need:
                        cut = min(O, need - (L + N - O))
                        O -= cut
                        rest = need - (L + N - O)
                        if need >= H + I and K + M > 0:
                            K = M = 0.0
                            L, N = H, I
                        elif rest > 0 and K + M > 0:
                            kc = rest * K / (K + M)
                            mc = rest - kc
                            K -= kc
                            M -= mc
                            L = H - K
                            N = I - M
            if keep_h > 0 and O < o_before:
                diag["hands_off_days"] += 1
            S = L + N - O
            if cap > 0:
                E = min(e_raw, s_prev + pd + j)
                Sp = min(sp_raw, s_prev + pd + j - E)
            else:
                E = Sp = 0.0
            startd = s_prev + pd - E - Sp
            avail = startd + M + O + K + j
            dead = cap * (x.get("damMinPct") or 0.0)
            # Off-take water arriving (§2.6a): used first for the demand.
            arr_up = arr_other = 0.0
            # Summed in the rules' id order, however the sources are ordered (§6, the ordering rule).
            for t, v in sorted(arrived.get(xid, []), key=lambda tv: tv[0]["id"]):
                if t.get("topUpDam"):
                    arr_up += v
                else:
                    arr_other += v
            arrives = arr_up + arr_other
            used_off = max(0.0, min(arrives, dem, s_left))
            s_left -= used_off
            rem = dem - used_off
            # What is left of it tops up the dam from top-up rules (before the
            # release, which draws on it), else flows on below the unit.
            left_off = arrives - used_off
            to_dam = left_off * arr_up / arrives if arrives > 0 else 0.0
            passed_on = left_off - to_dam
            avail += to_dam
            # A release from the dam before irrigation (§2.7a).
            X = 0.0
            rel = x.get("damReleaseRule") or "none"
            outlet_c = x.get("damOutletCapacityM3Day")
            outlet_c = math.inf if outlet_c is None else outlet_c
            amts = x.get("damReleaseM3Day")
            pass_target = None
            if cap > 0 and rel == "passInflow":
                pass_target = float(amts[m]) if amts else z
                X = max(0.0, min(K + M + O, pass_target - S, outlet_c, avail))
            elif cap > 0 and rel == "fixed" and amts:
                X = max(0.0, min(float(amts[m]), outlet_c, avail - dead))
            avail -= X
            # The river pump's room (§2.7e).
            if rule_ in ("riverFirst", "runOfRiver"):
                on = True
            elif rule_ == "trigger":
                trig = x.get("supplyTriggerPct", 0.4)
                stop = max(trig, x.get("supplyStopPct", 0.6))
                on = s_prev < stop * cap if on_river[xid] else s_prev < trig * cap
                hold = on and not s_prev < trig * cap
            else:
                on = False
            on_river[xid] = on
            pc = x.get("pumpCapacityM3Day")
            pc = math.inf if pc is None else pc
            keep = max(zs, pass_target if pass_target is not None else 0.0, keep_h)
            proom = max(0.0, min(pc, S - keep)) if on else 0.0
            # Supply order (§2.7d): primary direct, river first, dam targets, the dam, supplemental.
            GW = 0.0
            for k_, u_ in enumerate(ulist):
                if u_["mode"] == "primary" and u_["target"] == "direct":
                    GW += pump(k_, rem - GW)
            gwp = GW
            Gr = 0.0
            if rule_ in ("riverFirst", "trigger") and on:
                Gr = max(0.0, min(proom, rem - gwp, s_left))
                if rule_ == "trigger" and hold and Gr > 0:
                    diag["trigger_hold_days"] += 1
            dr = min(rem - gwp - Gr, s_left - Gr)
            GWd = 0.0
            took_dr = False
            for k_, u_ in enumerate(ulist):
                if u_["target"] != "dam":
                    continue
                hroom = cap - avail - GWd
                if u_["mode"] == "primary":
                    want_ = hroom if dr > 1e-12 * dem else 0.0
                elif u_["mode"] == "supplemental":
                    asked = dr - (avail + GWd - dead)
                    want_ = min(hroom, asked)
                else:
                    want_ = hroom if (dr > 1e-12 * dem and s_prev < u_["level"] * cap) else 0.0
                v = pump(k_, want_)
                GWd += v
                if u_["mode"] == "supplemental" and v > 0:
                    took_dr = v >= asked
            if rule_ == "runOfRiver":
                Gs = max(0.0, min(max(j, 0.0), rem - gwp, s_left))
                Gr = max(0.0, min(proom, rem - gwp - Gs, s_left - Gs))
            else:
                Gs = min(max(avail + GWd - dead, 0.0), rem - gwp - Gr, s_left - Gr)
                if took_dr:
                    Gs = dr
                Gs = max(0.0, Gs)
            for k_, u_ in enumerate(ulist):
                if u_["target"] == "direct" and u_["mode"] == "supplemental":
                    GW += pump(k_, rem - Gs - Gr - GW)
            for k_, u_ in enumerate(ulist):
                if u_["target"] == "direct" and u_["mode"] == "emergency" and s_prev < u_["level"] * cap:
                    GW += pump(k_, rem - Gs - Gr - GW)
            G = min(used_off + Gs + Gr + GW, dem)
            # The demand objects' split of G (§2.7f).
            # The return flow r, a share of the water supplied, at most the losses 1 − e (model.md §2.7, engine ≥ 1.71.0).
            r_ret = x["returnFlowFraction"]
            r_ret = (1 - d["e"]) if r_ret > 1 - d["e"] + 1e-9 else max(r_ret, 0)
            if objs[xid]:
                left_g = G
                g_crop = 0.0
                # Supply order: by class, then by rank within 'first' and 'last' (engine >= 1.64.0);
                # the crops with the 'shared' objects; each level pro rata. The dam side's demands only (§2.7j).
                dam_obs = [ob for ob in objs[xid] if ob["id"] not in on_river_obj]
                keys = sorted({supply_key(ob) for ob in dam_obs} | {(1, 0)})
                classes = [
                    ([("c", None)] if key == (1, 0) and crop_share(xid, "dam") > 0 else []) + [("o", ob) for ob in dam_obs if supply_key(ob) == key]
                    for key in keys
                ]
                for cls in classes:
                    want_c = [(kind, ob, crop_share(xid, "dam") * d["Dc"][i] if kind == "c" else obj_dem[ob["id"]][i]) for kind, ob in cls]
                    tot = 0.0
                    for _, _, w_ in want_c:
                        tot += w_
                    for kind, ob, w_ in want_c:
                        g_ = w_ if left_g >= tot else (left_g * w_ / tot if tot > 0 else 0.0)
                        if kind == "c":
                            g_crop = g_
                        else:
                            obj_sup[ob["id"]][i] = g_
                    left_g = max(0.0, left_g - min(tot, left_g))
                T = r_ret * g_crop
                for ob in dam_obs:
                    r_ = 0.0 if ob.get("destination") == "external" else (ob.get("returnPct") or 0.0)
                    T += r_ * obj_sup[ob["id"]][i]
                # basic_needs: Σ MIN(B_k, o_k) on the day's final demand (after a full allocation's factor).
                bn = 0.0
                for ob in objs[xid]:
                    if ob["id"] in obj_B:
                        bn += min(obj_B[ob["id"]], obj_dem[ob["id"]][i])
                cc["basic_needs"][i] = bn
            else:
                T = r_ret * G
            if gin > 0:
                T += r_ret * gin
            P = avail + GWd - Gs
            # Other units' remote shares from this dam (§2.7k): after its own dam side and release, from the storage
            # above dead storage, before the spill, pro rata to the asks (summed in the receivers' id order).
            xr = 0.0
            if xid in remote_into:
                ask_t = 0.0
                for fid in remote_into[xid]:
                    ask_t += rm_ask[fid]
                if ask_t > 0 and cap > 0:
                    xr = min(ask_t, max(P - dead, 0.0))
                    for fid in remote_into[xid]:
                        rm_got[fid] = rm_ask[fid] if xr >= ask_t else rm_ask[fid] * xr / ask_t
                P -= xr
            Q = min(P, cap)
            R = max(P - cap, 0.0)
            ret = x.get("damSeepageReturnPct", 1)
            if ret is None:
                ret = 1
            flow = R + S - Gr + T + Sp * ret + X + passed_on
            # River abstractions beside the dam (§2.7j): from the flow passing the dam (spill, release and
            # returned seepage too, not the return flows) above the unit pump's keep, by supply level, the
            # flow first and then each one's own pool; the pools refill last from the flow left.
            g_riv = 0.0
            pool_chg = 0.0
            if xid in riv:
                ts = riv[xid]
                past = R + S - Gr + Sp * ret + X + passed_on
                free = max(0.0, past - keep)
                rroom = (sroom[0] if sroom else math.inf) - gin - (G - GW)
                q = pool_q[xid]
                held = []
                evs = []
                for a, t in enumerate(ts):
                    ev = 0.0
                    if t["pool"]:
                        prev = q[a]
                        ar = 7.2 * t["pool"] ** 0.77 * min(prev / t["pool"], 1.0) ** 0.7 if prev > 0 else 0.0
                        ev = min(k_lake[m] * apan[m] / mdays[m] / 1000 * ar, prev)
                    evs.append(ev)
                    held.append(q[a] - ev)
                want_t = [crop_share(xid, "river") * d["Dc"][i] if t["ob"] is None else obj_dem[t["ob"]["id"]][i] for t in ts]
                got = [0.0] * len(ts)
                left_p = [t["pump"] for t in ts]
                from_flow = 0.0
                for lvl in sorted({t["level"] for t in ts}):
                    idx = [a for a, t in enumerate(ts) if t["level"] == lvl]
                    w = {a: max(0.0, min(want_t[a], left_p[a])) for a in idx}
                    tot = sum(w.values())
                    if not tot > 0 or not rroom > 0:
                        continue
                    ff = min(tot, free, rroom)
                    for a in idx:
                        v = w[a] * ff / tot
                        got[a] += v
                        left_p[a] -= v
                        w[a] -= v
                    free = max(0.0, free - ff)
                    rroom -= ff
                    from_flow += ff
                    pw = sum(min(w[a], held[a]) for a in idx if ts[a]["pool"])
                    if pw > 0 and rroom > 0:
                        g_ = min(1.0, rroom / pw)
                        dr_ = 0.0
                        for a in idx:
                            if ts[a]["pool"]:
                                v = min(w[a], held[a]) * g_
                                got[a] += v
                                held[a] = max(0.0, held[a] - v)
                                dr_ += v
                        rroom -= dr_
                rsum = sum(max(0.0, t["pool"] - held[a]) for a, t in enumerate(ts) if t["pool"])
                refill = 0.0
                if rsum > 0 and free > 0:
                    g_ = min(1.0, free / rsum)
                    for a, t in enumerate(ts):
                        if t["pool"]:
                            v = max(0.0, t["pool"] - held[a]) * g_
                            held[a] += v
                            refill += v
                back_r = 0.0
                for a, t in enumerate(ts):
                    g_riv += got[a]
                    if t["ob"] is None:
                        back_r += r_ret * got[a]
                    else:
                        obj_sup[t["ob"]["id"]][i] = got[a]
                        r_ = 0.0 if t["ob"].get("destination") == "external" else (t["ob"].get("returnPct") or 0.0)
                        back_r += r_ * got[a]
                    cc_t = river_cols[xid][t["key"]]
                    cc_t["take"][i] = got[a]
                    if t["pool"]:
                        pool_chg += held[a] - q[a] + evs[a]
                        q[a] = held[a]
                        cc_t["pool"][i] = held[a]
                        cc_t["evap"][i] = evs[a]
                T += back_r
                flow = max(0.0, past - from_flow - refill) + T
                diag["river_take_days"] += 1 if g_riv > 0 else 0
            dep = deplete(x, xid, ulist, pumped, flow, sd_store, dd_owed, cc, i)
            U0 = flow - dep
            lost = Sp * (1 - ret)
            for k_ in range(len(ulist)):
                used_u[k_] += pumped[k_]
            if sroom:
                spend(xid, "surface", G - GW + g_riv + gin)
            if groom:
                spend(xid, "groundwater", GW + GWd)
            # The unit's whole use, demand and shortfall: its river abstractions' too (§2.7j).
            # What the unit got in all (§2.7k: with the remote share), at most its demand under a table.
            g_all = G + g_riv + gin
            if xid in tab:
                g_all = min(g_all, dem_all)
            note_limit(lb_days, xid, wy, room, "surface", G - GW + g_riv + gin, sroom, dem_all, dem_all - g_all, o, ald)
            note_limit(lb_days, xid, wy, room, "groundwater", GW + GWd, groom, dem_all, dem_all - g_all, o, ald)
            # Off-takes from this unit (§2.6a), by priority.
            taken = 0.0
            ots = [t for t in ot_from.get(xid, []) if rule_limit(t, o, m) > 0]
            for prio in sorted({t["priority"] for t in ots}):
                grp = [t for t in ots if t["priority"] == prio]
                wants = {}
                keeps = {}
                for t in grp:
                    hk = t.get("handsOffM3Day")
                    # Engine >= 1.70.0 (issue #90 Q27): the source dam's pass-inflow target is kept too.
                    keep_k = max(zs, pass_target if pass_target is not None else 0.0, hk if hk is not None else 0.0, z if t.get("handsOffEwr") else 0.0)
                    keeps[t["id"]] = keep_k
                    lim = rule_limit(t, o, m)
                    # Asks MIN(capacity, need share), never capped at the flow above its keep (engine >= 1.70.0,
                    # issue #90 Q25); the bands keep it above its keep.
                    v = lim
                    if t.get("sizing", "demand") != "capacity":
                        v = min(v, ot_need.get(t["id"], 0.0) / (1 - (t.get("lossPct") or 0.0)))
                    wants[t["id"]] = max(0.0, v)
                # Shared in bands at the rules' keeps (§2.6a): the flow between two successive keeps, highest
                # first, goes to the rules keeping that much or less, pro rata to what each still wants.
                act = sorted((tid for tid in wants if wants[tid] > 0), key=lambda tid: (-keeps[tid], tid))
                vs = {tid: 0.0 for tid in wants}
                top = U0 - taken
                jb = 0
                while jb < len(act):
                    floor = keeps[act[jb]]
                    band = max(0.0, top - floor)
                    tot = sum(wants[tid] for tid in act[jb:])
                    if tot > band:
                        for tid in act[jb:]:
                            g_ = wants[tid] * band / tot
                            vs[tid] += g_
                            wants[tid] -= g_
                    else:
                        for tid in act[jb:]:
                            vs[tid] += wants[tid]
                        break
                    top = min(top, floor)
                    while jb < len(act) and keeps[act[jb]] == floor:
                        jb += 1
                for t in grp:
                    v = vs[t["id"]]
                    rule_vol[t["id"]][i] = v
                    taken += v
                    lp = t.get("lossPct") or 0.0
                    arrived.setdefault(t["toNodeId"], []).append((t, v * (1 - lp)))
                    rp = t.get("lossReturnPct") or 0.0
                    if rp > 0:
                        rn = t.get("lossReturnNodeId") or xid
                        back_to.setdefault(rn, []).append((t["id"], v * lp * rp))
            back = 0.0
            for _, bv in sorted(back_to.get(xid, [])):
                back += bv
            Uo = U0 - taken + back
            V = (H + I + j + pd + GW + GWd + arrives + back + gin) - (g_all - T) - E - (Q - s_prev) - Uo - dep - lost - taken - pool_chg - xr
            aa = noise_short(z, Uo)
            ab = min(aa - aau, 0.0)
            for key, val in (
                ("runoff", I), ("transfer", j), ("upstream_to_dam", K), ("upstream_below_dam", L),
                ("runoff_to_dam", M), ("runoff_below_dam", N), ("diverted_to_dam", O), ("dam_area", area),
                ("rain_on_dam", pd), ("dam_evaporation", E), ("dam_seepage", Sp), ("supplied", g_all),
                ("interim_storage", P), ("dam_storage", Q), ("spill", R), ("below_dam_not_diverted", S),
                ("return_flow", T), ("outflow", Uo), ("balance_residual", V), ("deficit", dem_all - g_all), ("ewr", y_ewr),
                ("ewr_cumulative", z), ("ewr_shortfall", aa), ("ewr_shortfall_incremental", ab),
                ("dam_seepage_lost", lost), ("dam_release", X), ("river_abstraction", Gr), ("groundwater_used", GW),
                ("groundwater_to_dam", GWd), ("senior_requirement", zs), ("passed_for_senior", passed),
                ("offtake_out", taken), ("offtake_in", arrives), ("offtake_used", used_off), ("offtake_to_dam", to_dam),
                ("offtake_loss_return", back), ("remote_dam_in", gin), ("remote_dam_out", xr),
            ):
                cc[key][i] = val
            for s_, r_ in (("surface", sroom), ("groundwater", groom)):
                if r_:
                    # Blank (NaN) in a water year the source isn't capped in (§2.12a, engine >= 1.70.0).
                    cc[f"allocation_room_{s_}"][i] = r_[0] if math.isfinite(r_[3]) else math.nan
                    cc[f"allocation_left_{s_}"][i] = r_[1] if math.isfinite(r_[3]) else math.nan
            if cap > 0 and G < dem and avail > 0 and avail <= dead + 1e-9 * cap:
                diag["dead_storage_days"] += 1
            if R > 0 and cap > 0:
                diag["spill_days"] += 1
            diag["borehole_days"] += 1 if GW + GWd > 0 else 0
            diag["borehole_to_dam_days"] += 1 if GWd > 0 else 0
            diag["offtake_days"] += 1 if taken > 0 else 0
            diag["offtake_return_days"] += 1 if back > 0 else 0
            diag["senior_pass_days"] += 1 if passed > 0 else 0
            diag["river_pump_days"] += 1 if Gr > 0 else 0
            diag["release_days"] += 1 if X > 0 else 0
            diag["curve_days"] += 1 if cap > 0 and area > 0 and usable_curve(x.get("damCurve")) else 0
            diag["divert_by_month_days"] += 1 if x.get("divertMonthlyM3Day") and O > 0 else 0
            if objs[xid] and any(obj_sup[ob["id"]][i] < obj_dem[ob["id"]][i] * (1 - 1e-9) for ob in objs[xid]):
                diag["object_shortage_days"] += 1
            storage[xid] = Q
            U[xid] = Uo
            Z[xid] = z
            AA[xid] = aa
            ZS[xid] = zs
        sim_out[i] = U[outlet["id"]]
        cat_short[i] = noise_short(ewr[i], sim_out[i])

    put(None, "simulated_outflow", sim_out)
    diag["depletion_owed_days"] = sum(1 for x in nodes for v in col[x["id"]]["depletion_deficit"] if v > 0)
    diag["cap_bound_days"] = sum(r["days"] for r in lb_days.values())
    put(None, "ewr", ewr)
    put(None, "ewr_shortfall", cat_short)

    # ---- EWR attribution (§2.7b, §2.7c, §2.6a) ----------------------------
    sites = [(None, outlet["id"])] + [
        (x["id"], x["id"])
        for x in sorted(nodes, key=lambda x: x["id"])
        if x["kind"] == "gauge" and x.get("ewrSite", True) is not False and x["id"] != outlet["id"]
    ]
    contrib = sorted(x["id"] for x in nodes if x["kind"] in ("farm", "user"))
    depth = {}
    for x in reversed(topo_order(nodes)):
        dn = x.get("downstreamNodeId")
        depth[x["id"]] = 0 if dn is None else depth[dn] + 1
    charge = {f: [0.0] * n for f in contrib}
    site_index = {site_node: k for k, (_, site_node) in enumerate(sites)}
    n_sites_above = {f: sum(1 for _, sn in sites if f in upstream_set[sn]) for f in contrib}
    binding = {f: [NAN] * n for f in contrib if n_sites_above[f] >= 2 and by_id[f]["kind"] == "farm"}
    charge_irr = {f: [0.0] * n for f in contrib}
    site_series = {}
    for site_key, site_node in sites:
        members = [f for f in contrib if f in upstream_set[site_node]]
        site_series[site_key] = (members, [0.0] * n, [0.0] * n)
    legs = []  # (from, to, volume series): the internal legs a site may count
    for t in rules:
        legs.append((t["fromNodeId"], t["toNodeId"], rule_vol[t["id"]], None))
    for t in offtakes:
        legs.append((t["fromNodeId"], t["toNodeId"], rule_vol[t["id"]], None))
        lp = t.get("lossPct") or 0.0
        rp = t.get("lossReturnPct") or 0.0
        if lp > 0 and rp > 0:
            rn = t.get("lossReturnNodeId") or t["fromNodeId"]
            legs.append((t["fromNodeId"], rn, [v * lp * rp for v in rule_vol[t["id"]]], t["toNodeId"]))
    # A remote share (§2.7k) moves water from the supplying unit to the receiving one, as a transfer does.
    for fid, r_ in sorted(remote.items()):
        legs.append((r_["from"], fid, col[fid]["remote_dam_in"], None))
    for i in range(n):
        best: dict[str, tuple] = {}
        for site_key, site_node in sites:
            members, charged_s, natural_s = site_series[site_key]
            if site_key is None:
                short = -cat_short[i]
            else:
                short = -col[site_node]["ewr_shortfall"][i]
            mset = set(members)
            jint = {f: 0.0 for f in members}
            for a, b, vol, dst in legs:
                v = vol[i]
                if dst is not None:
                    # A canal seepage leg (§2.6a): into its return unit, from
                    # the destination when that is upstream of the site too.
                    if b not in mset:
                        continue
                    a = dst if dst in mset else a
                    if a not in mset:
                        continue
                    jint[a] -= v
                    jint[b] += v
                    continue
                if a in mset and b in mset:
                    jint[a] -= v
                    jint[b] += v
            imp = {}
            for f in members:
                cc = col[f]
                e_f = cc["inflow_upstream"][i] + cc["runoff"][i] + jint[f] - cc["outflow"][i]
                scale = max(abs(cc["inflow_upstream"][i]), abs(cc["runoff"][i]), abs(cc["outflow"][i]), abs(jint[f]))
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
        extra = []
        if xid in has_bh:
            extra += ["groundwater_used", "baseflow_depletion", "depletion_deficit", "depletion_store"]
            if any(u_["target"] == "dam" for u_ in units.get(xid, [])):
                extra.append("groundwater_to_dam")
        for s_ in ("surface", "groundwater"):
            if capped and (xid, s_) in al_used:
                extra.append(f"allocation_room_{s_}")
                if any(a["months"] or a["rate"] is not None for a in ald[xid][s_]):
                    extra.append(f"allocation_left_{s_}")
        if xid in kf:
            put(xid, "allocation_demand_factor", kf[xid])
        if any_senior:
            extra.append("senior_requirement")
        if x["kind"] == "farm":
            d = fd[xid]
            put(xid, "gross_demand", d["gross"])
            put(xid, "effective_rain", d["eff"])
            put(xid, "soil_water", d["soil"])
            put(xid, "crop_requirement", d["F"])
            put(xid, "demand", Dn[xid])
            base = names[: names.index("dam_seepage_lost") + 1]
            for k in base:
                put(xid, k, cc[k])
            if x["damCapacityM3"] > 0 and (x.get("damReleaseRule") or "none") != "none":
                put(xid, "dam_release", cc["dam_release"])
            if supply_rule(x) != "damFirst" or (x.get("supplyRule") or "damFirst") != "damFirst":
                put(xid, "river_abstraction", cc["river_abstraction"])
            if any_senior:
                extra.append("passed_for_senior")
            if xid in ot_from:
                extra += ["offtake_out"]
            if xid in ot_into:
                extra += ["offtake_in", "offtake_used", "offtake_to_dam"]
            if any((t.get("lossReturnNodeId") or t["fromNodeId"]) == xid and (t.get("lossReturnPct") or 0) > 0 for t in offtakes):
                extra.append("offtake_loss_return")
            if any(ob["id"] in obj_B for ob in objs[xid]):
                extra.append("basic_needs")
            # The remote share (§2.7k): on a receiving unit, and on a unit whose dam supplies one.
            if xid in remote:
                extra.append("remote_dam_in")
            if xid in remote_into:
                extra.append("remote_dam_out")
            for ob in objs[xid]:
                put(xid, f"object_demand@{ob['id']}", obj_dem[ob["id"]])
                put(xid, f"object_supplied@{ob['id']}", obj_sup[ob["id"]])
            for t in riv.get(xid, []):
                c_ = river_cols[xid][t["key"]]
                put(xid, f"river_take@{t['key']}", c_["take"])
                if t["pool"]:
                    put(xid, f"river_pool@{t['key']}", c_["pool"])
                    put(xid, f"river_pool_evaporation@{t['key']}", c_["evap"])
            for k in extra:
                put(xid, k, cc[k])
            put(xid, "ewr_charge", charge[xid])
            put(xid, "ewr_charge_irrigation", charge_irr[xid])
            if xid in binding:
                put(xid, "ewr_binding_site", binding[xid])
        elif x["kind"] == "user":
            put(xid, "demand", Dn[xid])
            for k in ("inflow_upstream", "supplied", "deficit", "outflow", "return_flow", "ewr_cumulative", "ewr_shortfall"):
                put(xid, k, cc[k])
            for k in extra:
                put(xid, k, cc[k])
            put(xid, "ewr_charge", charge[xid])
            if xid in binding:
                put(xid, "ewr_binding_site", binding[xid])
        else:
            for k in ("inflow_upstream", "outflow", "ewr_cumulative", "ewr_shortfall"):
                put(xid, k, cc[k])
            if any_senior:
                put(xid, "senior_requirement", cc["senior_requirement"])
    for site_key, _ in sites:
        _, charged_s, natural_s = site_series[site_key]
        put(site_key, "ewr_charged", charged_s)
        put(site_key, "ewr_natural", natural_s)
    for t in rules + offtakes:
        if can_move(t):
            put(t["fromNodeId"], f"transfer_rule@{t['id']}", rule_vol[t["id"]])

    # RunSummary.allocations' run-dependent parts (§2.12a): per capped unit and
    # source the years the cap bound (capReached) and the days the limit held
    # use back (limitBound); per scaled unit the demand and volume per year.
    summary: dict = {}
    if capped:
        for (nid, s_, wy), budget in sorted(al_budget.items()):
            ent = summary.setdefault((nid, s_), {"capReached": [], "limitBound": []})
            used_ = use_y.get((nid, s_, wy), 0.0)
            if (nid, s_, wy) in al_capped_y and used_ >= budget - 1e-9 * budget:
                ent["capReached"].append({"waterYear": wy, "budgetM3": budget, "usedM3": used_})
            row = lb_days.get((nid, s_, wy))
            if row:
                ent["limitBound"].append({"waterYear": wy, **row})
    elif fa_scaled:
        for nid, rows_ in fa_scaled.items():
            summary[(nid, "scaled")] = sorted(rows_, key=lambda r: r["waterYear"])
    return {"startDate": ord_to_iso(start), "endDate": ord_to_iso(end), "days": n, "series": out, "diag": diag,
            "summary": summary}


# --------------------------------------------------------------------------
# Helpers for the network (§2.7a curves, §2.7d boreholes, §2.7f schedules,
# §2.12a allocations, §2.6a off-take order)
# --------------------------------------------------------------------------

BASIC_LITRES = 25


def _is_iso(s: str) -> bool:
    try:
        _dt.date.fromisoformat(s)
        return len(s) == 10
    except ValueError:
        return False


def wy_length(y: int) -> int:
    return (_dt.date(y + 1, 10, 1) - _dt.date(y, 10, 1)).days


def overlap_days(y: int, a: int, b: int) -> int:
    lo = max(a, _dt.date(y, 10, 1).toordinal())
    hi = min(b, _dt.date(y + 1, 9, 30).toordinal())
    return max(0, hi - lo + 1)


def easter(y: int) -> int:
    """Western (Gregorian) Easter Sunday, the anonymous Gregorian algorithm."""
    a = y % 19
    b, c = divmod(y, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31
    day = (h + l_ - 7 * m + 114) % 31 + 1
    return _dt.date(y, month, day).toordinal()


def window_covers(w: dict, o: int) -> bool:
    d = _dt.date.fromordinal(o)
    wd = w.get("weekdays")
    if wd and d.isoweekday() not in wd:
        return False
    span = w.get("span")
    if span == "always":
        return True
    if span == "range":
        return iso_to_ord(w["from"]) <= o <= iso_to_ord(w["to"])
    if span == "yearly":
        fm, fdy = (int(v) for v in w["from"].split("-"))
        tm, tdy = (int(v) for v in w["to"].split("-"))
        md = (d.month, d.day)
        if (fm, fdy) <= (tm, tdy):
            return (fm, fdy) <= md <= (tm, tdy)
        return md >= (fm, fdy) or md <= (tm, tdy)
    if span == "easter":
        e = easter(d.year)
        return e + w["easterFrom"] <= o <= e + w["easterTo"]
    return False


def supply_key(ob: dict) -> tuple[int, int]:
    """A demand object's place in its unit's supply order (§2.7f): its class,
    then its rank within 'first' or 'last' (a whole number 1-99; none = 1,
    engine >= 1.64.0). A 'shared' object goes with the crops, (1, 0)."""
    p = ob.get("priority", "shared")
    if p == "first":
        return (0, object_rank(ob))
    if p == "last":
        return (2, object_rank(ob))
    return (1, 0)


def object_rank(ob: dict) -> int:
    r = ob.get("rank")
    if isinstance(r, (int, float)) and not isinstance(r, bool) and math.isfinite(r) and r == int(r) and 1 <= r <= 99:
        return int(r)
    return 1


def schedule_factor(sched: list, o: int) -> float:
    f = 1.0
    for w in sched:
        if window_covers(w, o):
            f = float(w["factor"])
    return f


def usable_curve(rows):
    if not rows or len(rows) < 2 or len(rows) > 200:
        return None
    pts = sorted(rows, key=lambda r: r["volumeM3"])
    for r in pts:
        for k in ("levelM", "areaM2", "volumeM3"):
            if not isinstance(r.get(k), (int, float)) or not math.isfinite(r[k]):
                return None
        if r["areaM2"] < 0 or r["volumeM3"] < 0:
            return None
    for a, b in zip(pts, pts[1:]):
        if not b["volumeM3"] > a["volumeM3"] or b["levelM"] < a["levelM"] or b["areaM2"] < a["areaM2"]:
            return None
    if not any(r["areaM2"] > 0 for r in pts):
        return None
    return pts


def curve_area(pts, s0):
    """Area (m²) at storage s0 and the segment's slope dA/dV (None above the top)."""
    if s0 <= 0:
        return 0.0, None
    prev_v, prev_a = 0.0, 0.0
    if s0 < pts[0]["volumeM3"]:
        v1, a1 = pts[0]["volumeM3"], pts[0]["areaM2"]
        slope = (a1 - prev_a) / (v1 - prev_v)
        return prev_a + slope * (s0 - prev_v), slope
    for a, b in zip(pts, pts[1:]):
        if s0 <= b["volumeM3"]:
            slope = (b["areaM2"] - a["areaM2"]) / (b["volumeM3"] - a["volumeM3"])
            return a["areaM2"] + slope * (s0 - a["volumeM3"]), slope
    return pts[-1]["areaM2"], 0.0


def unit_room(u: dict, used: float) -> float:
    room = u["cap"]
    if u["annual"] is not None:
        room = min(room, u["annual"] - used)
    return max(0.0, room)


def deplete(x, xid, ulist, pumped, flow, sd_store, dd_owed, cc, i):
    """§2.7d: the lagged stream depletion taken from the flow leaving the node."""
    if not ulist and not sd_store[xid] and not dd_owed[xid]:
        return 0.0
    add = 0.0
    for u_, p in zip(ulist, pumped):
        add += u_["d"] * p
    sd = sd_store[xid] + add
    k = x.get("streamDepletionLagDays") or 0
    alpha = 1.0 if k == 0 else 1 - math.exp(-1 / k)
    due = alpha * sd
    sd -= due
    dep = min(dd_owed[xid] + due, max(0.0, flow))
    dd_owed[xid] = dd_owed[xid] + due - dep
    sd_store[xid] = sd
    cc["baseflow_depletion"][i] = dep
    cc["depletion_deficit"][i] = dd_owed[xid]
    cc["depletion_store"][i] = sd
    return dep


def read_allocations(model: dict, by_id: dict) -> list[dict]:
    out = []
    for a in sorted(model.get("allocations") or [], key=lambda a: a["id"]):
        x = by_id.get(a.get("nodeId"))
        if x is None or x["kind"] not in ("farm", "user"):
            continue
        # §2.12a: a storage-only (s21b) row is not a take; it neither caps nor scales a unit.
        if a.get("waterUse") == "21b":
            continue
        v = a.get("volumeM3PerYear")
        if not isinstance(v, (int, float)) or not v >= 0 or a.get("waterSource") not in ("surface", "groundwater"):
            continue
        lo = iso_to_ord(a["validFrom"]) if a.get("validFrom") else -(10**9)
        hi = iso_to_ord(a["validTo"]) if a.get("validTo") else 10**9
        if lo > hi:
            continue
        rate = a.get("maxRateM3s")
        out.append({"id": a["id"], "nodeId": a["nodeId"], "waterSource": a["waterSource"], "volume": float(v),
                    "from": lo, "to": hi, "months": list(a.get("months") or []), "rate": rate})
    return out


def licence_limit(lst: list[dict], o: int) -> float:
    """§2.12a: Σ rate × 86 400 over the source's allocations in force on the
    day whose months include it; none in force = no limit."""
    inforce = [a for a in lst if a["from"] <= o <= a["to"]]
    if not inforce:
        return math.inf
    m = cal_month(o)
    lim = 0.0
    for a in inforce:
        if a["months"] and m not in a["months"]:
            continue
        if a["rate"] is None:
            return math.inf
        lim += a["rate"] * 86400
    return lim


def note_limit(lb, nid, wy, room, src, use, r_, dem, short, o, ald):
    """§2.12a Which limit bound: the day's kind, when it counts."""
    if not r_:
        return
    rm, left, limit, budget = r_
    if not (use >= rm - 1e-9 * max(rm, 1.0) and short > 1e-9 * max(dem, 1.0)):
        return
    if left <= limit + 1e-9 * max(budget, 1.0):
        kind = "volumeDays"
    else:
        lst = ald[nid][src]
        inforce = [a for a in lst if a["from"] <= o <= a["to"]]
        outside = bool(inforce) and all(a["months"] and cal_month(o) not in a["months"] for a in inforce)
        kind = "monthsDays" if outside else "rateDays"
    row = lb.setdefault((nid, src, wy), {"days": 0, "volumeDays": 0, "rateDays": 0, "monthsDays": 0})
    row["days"] += 1
    row[kind] += 1


def network_order(nodes: list[dict], transfers: list[dict], extra: list[tuple[str, str]] = ()) -> list[dict]:
    """Upstream first, and a river off-take's destination after its source
    (§2.6a), and a remote share's receiving unit after the unit whose dam
    supplies it (§2.7k, `extra`): a topological order, ties by id."""
    by_id = {x["id"]: x for x in nodes}
    succ: dict[str, set[str]] = {x["id"]: set() for x in nodes}
    for x in nodes:
        if x.get("downstreamNodeId") is not None:
            succ[x["id"]].add(x["downstreamNodeId"])
    for t in transfers:
        if t.get("source") == "river" and t.get("enabled", True) and t["fromNodeId"] in by_id and t["toNodeId"] in by_id:
            succ[t["fromNodeId"]].add(t["toNodeId"])
    for a, b in extra:
        succ[a].add(b)
    indeg = {k: 0 for k in succ}
    for k, vs in succ.items():
        for v in vs:
            indeg[v] += 1
    ready = sorted(k for k, d in indeg.items() if d == 0)
    order = []
    while ready:
        k = ready.pop(0)
        order.append(by_id[k])
        for v in sorted(succ[k]):
            indeg[v] -= 1
            if indeg[v] == 0:
                ready.append(v)
                ready.sort()
    if len(order) != len(nodes):
        raise Refused("an off-take loop (the generator never makes one)")
    return order
