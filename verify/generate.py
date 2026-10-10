"""Random networks for the cross-check (verify/README.md), this harness's own
generator: seeded, stdlib `random` only, and independent of the engine's fuzz
generator (packages/engine/src/testing/fuzz.ts is never read). Every input is
synthetic and uses only the features verify/ covers (model.unsupported() is empty).

`random_input(seed)` returns a ModelInput document.
"""

from __future__ import annotations

import datetime as dt
import math
import random


def _uuid(rng: random.Random) -> str:
    h = "%032x" % rng.getrandbits(128)
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:32]}"


def _monthly(rng, lo, hi, digits=3):
    return [round(rng.uniform(lo, hi), digits) for _ in range(12)]


def _rain(rng: random.Random, start: dt.date, days: int, winter: bool) -> list[float]:
    """Daily rain with a seasonal wet-day chance and gamma-ish depths."""
    out = []
    wet = False
    for i in range(days):
        d = start + dt.timedelta(days=i)
        season = math.cos((d.month - (7 if winter else 1)) / 12 * 2 * math.pi)
        p = 0.18 + 0.14 * season
        p = p + 0.3 if wet else p
        wet = rng.random() < p
        out.append(round(rng.gammavariate(0.7, 9 + 5 * season), 1) if wet else 0.0)
    return out


def random_input(seed: int, dense: bool = False) -> dict:
    rng = random.Random(seed * 7919 + 17)
    years = rng.randint(3, 6) if rng.random() < 0.85 else 1
    start = dt.date(rng.randint(2001, 2016), rng.choice([1, 4, 7, 10]), 1)
    days = years * 365 + rng.randint(0, 200)
    winter = rng.random() < 0.5
    truth = _rain(rng, start, days, winter)

    # Catchment rain: gaps (blank), sometimes a long zero run (a missing
    # stretch exported as 0) and sometimes an untagged accumulation.
    catch: list = list(truth)
    for _ in range(rng.randint(0, 4)):
        a = rng.randrange(days)
        for j in range(a, min(days, a + rng.randint(1, 40))):
            catch[j] = None
    if rng.random() < 0.4:
        a = rng.randrange(days // 3, days - 150)
        for j in range(a, min(days, a + rng.randint(120, 200))):
            catch[j] = 0.0
    if rng.random() < 0.3:
        a = rng.randrange(60, days - 60)
        n = rng.randint(5, 25)
        tot = sum(v or 0 for v in catch[a : a + n])
        if tot >= 25:
            for j in range(a, a + n - 1):
                catch[j] = 0.0
            catch[a + n - 1] = round(tot, 1)

    if rng.random() < 0.1:
        for _ in range(rng.randint(1, 3)):
            catch[rng.randrange(days)] = -round(rng.uniform(0.1, 5), 1)
    series: dict = {"rain_catchment_mm": {"startDate": start.isoformat(), "values": catch}}
    if rng.random() < 0.8:
        bias = [rng.uniform(0.5, 1.4) for _ in range(12)]
        off = rng.randint(-200, 100)
        ch_start = start + dt.timedelta(days=off)
        ch = []
        for i in range(days - off + rng.randint(0, 60)):
            d = ch_start + dt.timedelta(days=i)
            j = i + off
            base = truth[j] if 0 <= j < days else round(rng.gammavariate(0.4, 6), 1)
            v = base / bias[d.month - 1] * rng.uniform(0.6, 1.4)
            ch.append(round(v, 2) if rng.random() > 0.02 else None)
        series["rain_chirps_mm"] = {"startDate": ch_start.isoformat(), "values": ch}
    if rng.random() < 0.3:
        fstart = start + dt.timedelta(days=days - rng.randint(0, 5))
        series["rain_forecast_mm"] = {
            "startDate": fstart.isoformat(),
            "values": [round(rng.gammavariate(0.6, 5), 1) for _ in range(rng.randint(3, 16))],
        }

    # Network: an outlet gauge, farms and gauges hung below existing nodes.
    nodes = []
    outlet = {"id": _uuid(rng), "name": "Outlet", "kind": "gauge", "downstreamNodeId": None}
    nodes.append(outlet)
    n_farms = rng.randint(1, 7)
    n_gauges = rng.randint(0, 2)
    kinds = ["farm"] * n_farms + ["gauge"] * n_gauges
    rng.shuffle(kinds)
    if kinds and kinds[0] == "gauge" and "farm" in kinds:
        kinds.remove("farm")
        kinds.insert(0, "farm")
    for k, kind in enumerate(kinds):
        below = rng.choice(nodes)
        nodes.append({"id": _uuid(rng), "name": f"{kind} {k}", "kind": kind, "downstreamNodeId": below["id"]})

    method = rng.choice(["area", "area", "hiLo", "manual"])
    farms = [n for n in nodes if n["kind"] == "farm"]
    manual = [rng.random() for _ in farms]
    tot = sum(manual) / rng.uniform(0.7, 1.0) if manual else 1
    for idx, n in enumerate(nodes):
        n["sortOrder"] = idx
        base = {
            "areaKm2": 0, "areaHiKm2": 0, "areaLoKm2": 0, "flowShareManual": None, "pctUpstreamToDam": 0,
            "pctRunoffToDam": 0, "damCapacityM3": 0, "damInitialPct": 0, "damMinPct": 0, "divertCapacityM3Day": 0,
            "irrigationEfficiency": 1, "returnFlowFraction": 0, "damAreaFullM2": None, "damAreaExponent": 0.7,
            "damSeepagePerDay": 0,
        }
        for k2, v in base.items():
            n.setdefault(k2, v)
        if n["kind"] == "gauge":
            if n is not outlet and rng.random() < 0.3:
                n["ewrSite"] = False
            continue
        area = round(rng.uniform(0.5, 60), 2) if rng.random() > 0.05 else 0
        hi = round(area * rng.uniform(0.2, 0.8), 2)
        # The same draws, in the same order, as before engine 1.71.0: β, a share of the losses, is
        # stored as the return flow r = β(1 − e), a share of the water supplied.
        up = rng.choice([0, 0, 1, round(rng.random(), 2)])
        ro = rng.choice([0, 1, 1, round(rng.random(), 2)])
        e = rng.choice([1, 0.9, 0.85, 0.01, round(rng.uniform(0.5, 1), 2)])
        beta = rng.choice([0, 0.5, 1, round(rng.random(), 2)])
        n.update(
            areaKm2=area,
            areaHiKm2=hi,
            areaLoKm2=round(area - hi, 2),
            flowShareManual=math.floor(manual[farms.index(n)] / tot * 1e4) / 1e4 if method == "manual" else None,
            pctUpstreamToDam=up,
            pctRunoffToDam=ro,
            irrigationEfficiency=e,
            returnFlowFraction=beta * (1 - e),
        )
        if rng.random() < 0.75:
            cap = rng.choice([0.4, 500, 5_000, 50_000, 300_000, 2_000_000]) * rng.uniform(0.5, 1.5)
            n.update(
                damCapacityM3=round(cap) if cap >= 1 else cap,
                damInitialPct=round(rng.random(), 2),
                damMinPct=rng.choice([0, 0, 0.1, round(rng.uniform(0, 0.4), 2)]),
                divertCapacityM3Day=rng.choice([0, 0, round(rng.uniform(0, 5000))]),
                damAreaFullM2=None if rng.random() < 0.3 else round(cap / rng.uniform(1.5, 8)),
                damAreaExponent=round(rng.uniform(0.5, 1.0), 2) if rng.random() < 0.85 else round(rng.uniform(1.0, 3.0), 2),
                damSeepagePerDay=rng.choice([0, 0, round(rng.uniform(0, 0.01), 4)]),
            )
            if rng.random() < 0.3:
                n["damSeepageReturnPct"] = round(rng.random(), 2)

    crops = []
    for c in range(rng.randint(1, 4)):
        crop = {"id": _uuid(rng), "name": f"Crop {c}", "cropFactor": _monthly(rng, 0, 1.2, 2)}
        if rng.random() < 0.3:
            crop["irrigationEfficiency"] = rng.choice([0.9, 0.82, 0.75, 0.7])
        crops.append(crop)
    crop_areas = []
    for f in farms:
        for crop in crops:
            if rng.random() < 0.6:
                crop_areas.append({"nodeId": f["id"], "cropId": crop["id"], "areaM2": round(rng.uniform(1e4, 2e6))})

    transfers = []
    if len(farms) >= 2:
        for _ in range(rng.choice([0, 0, 1, 2, 3, 4])):
            a, b = rng.sample(farms, 2)
            t = {
                "id": _uuid(rng),
                "fromNodeId": a["id"],
                "toNodeId": b["id"],
                "months": sorted(rng.sample(range(1, 13), rng.randint(1, 12))),
                "maxRateM3s": round(rng.uniform(0, 0.1), 4),
                "dailyCapM3": None if rng.random() < 0.6 else rng.choice([0, round(rng.uniform(100, 8000))]),
                "minStoragePct": round(rng.uniform(0, 0.6), 2),
                "enabled": rng.random() > 0.1,
                "priority": rng.randint(0, 2),
            }
            if rng.random() < 0.25:
                rates = [0 if rng.random() < 0.4 else round(rng.uniform(0, 0.1), 4) for _ in range(12)]
                t["monthlyRateM3s"] = rates
                t["months"] = [(m + 9) % 12 + 1 for m in range(12) if rates[m] > 0]
                t["maxRateM3s"] = max(rates)
            transfers.append(t)
        # A dam feeding several rules of one priority at different reserves
        # (bands, audit N6), and receivers shared by several rules (room).
        dams = [f for f in farms if f["damCapacityM3"] > 0]
        if dams and rng.random() < 0.35:
            hub = rng.choice(dams)
            prio = rng.randint(0, 1)
            for _ in range(rng.randint(2, 4)):
                dst = rng.choice([f for f in farms if f is not hub])
                transfers.append({
                    "id": _uuid(rng), "fromNodeId": hub["id"], "toNodeId": dst["id"],
                    "months": list(range(1, 13)), "maxRateM3s": rng.choice([0, round(rng.uniform(0.001, 0.2), 4)]),
                    "dailyCapM3": None, "minStoragePct": rng.choice([0, 0.2, 0.5, round(rng.random(), 2)]),
                    "enabled": True, "priority": prio,
                })

    apan = _monthly(rng, 40, 280, 0)
    settings = {
        "runoffModel": "gr4j",
        "apanMm": apan,
        "panCoefficient": _monthly(rng, 0.6, 0.85, 2),
        "gr4j": {
            "x1": round(rng.uniform(100, 1200), 1),
            "x2": 0 if rng.random() < 0.75 else round(rng.uniform(-2, 1), 2),
            "x3": round(rng.uniform(20, 300), 1),
            "x4": round(rng.uniform(0.6, 4), 2),
            "warmupDays": rng.choice([0, 30, 365, 3000]),
        },
        "flowShareMethod": method,
        "hiLoSplit": {"hi": 0.5, "lo": 0.5} if rng.random() < 0.5 else {"hi": 0.7, "lo": 0.3},
        "effectiveRainFraction": round(rng.uniform(0, 1), 2),
        "effectiveRainStoreMm": rng.choice([0, 25, round(rng.uniform(0, 60), 1)]),
        "lakeEvapFactor": rng.choice([0.75, 0, round(rng.uniform(0.5, 1), 2)]),
        "ewrPragmaticM3PerDay": _monthly(rng, 0, 20000, 0),
        "chirpsBiasCorrection": rng.choice(["monthly", "monthly", "none"]),
        "calibration": {"rainThresholdMm": rng.choice([0, 2, 5]), "catchmentAreaKm2": None if rng.random() < 0.7 else round(rng.uniform(5, 200), 1)},
        "zeroRainRuns": {
            "mode": rng.choice(["missing", "missing", "asRecorded"]),
            "keepDry": [],
            "missing": [],
            "accumulationMode": rng.choice(["spread", "spread", "asRecorded"]),
            "keepReadings": [],
            "addAccumulations": [],
            # §2.4c (engine ≥ 1.81.0): the CHIRPS fill threshold, from its own stream so the other draws don't move.
            "fillAboveChirpsMm": random.Random(seed * 999983 + 5).choice([2, 2, 0, 0.5, 5]),
        },
    }
    if rng.random() < 0.2:
        settings["effectiveRainFractionMonthly"] = _monthly(rng, 0, 1, 2)
    if rng.random() < 0.2:
        settings["lakeEvapFactorMonthly"] = _monthly(rng, 0.5, 1.1, 2)
    if rng.random() < 0.15:
        settings["pe"] = {"kind": "monthly", "mm": _monthly(rng, 20, 200, 1), "source": "synthetic"}
    if rng.random() < 0.3:
        a = rng.randrange(days - 30)
        s0 = start + dt.timedelta(days=a)
        settings["zeroRainRuns"]["missing"].append(
            {"start": s0.isoformat(), "end": (s0 + dt.timedelta(days=rng.randint(3, 30))).isoformat(), "reason": "synthetic"}
        )
    if rng.random() < 0.3:
        wy = start.year + rng.randint(0, years)
        settings["zeroRainRuns"]["missing"].append({"waterYear": wy, "reason": "synthetic"})
    if rng.random() < 0.3:
        s0 = start + dt.timedelta(days=rng.randrange(-40, days // 2))
        settings["simulationStart"] = s0.isoformat()
    if rng.random() < 0.2:
        settings["simulationEnd"] = (start + dt.timedelta(days=days - rng.randint(-40, 300))).isoformat()
        if settings.get("simulationStart") and settings["simulationStart"] > settings["simulationEnd"]:
            settings.pop("simulationStart")

    doc = {"settings": settings, "model": {"nodes": nodes, "crops": crops, "cropAreas": crop_areas, "transfers": transfers}, "series": series}
    add_phase_two(rng, doc, start, days, dense)
    add_irrigation_systems(random.Random(seed * 104729 + 3), doc, dense)
    add_unit_rain(random.Random(seed * 15485863 + 11), doc, start, days, dense)
    return doc


def _unit_series(rng: random.Random, start: dt.date, days: int, scale: float, chirps: bool) -> dict:
    """A unit's own record: its own synthetic rain, from a little before or
    after the catchment's start to a little before or after its end, with
    gaps, now and then a negative (no-data) value, and now and then nothing
    but blanks (a series with no reading)."""
    off = rng.randint(-120, 400) if rng.random() < 0.5 else 0
    s0 = start + dt.timedelta(days=off)
    n = max(1, days - off + rng.randint(-300, 60))
    vals: list = [round(v * scale, 2 if chirps else 1) for v in _rain(rng, s0, n, rng.random() < 0.5)]
    for _ in range(rng.randint(0, 4)):
        a = rng.randrange(n)
        for j in range(a, min(n, a + rng.randint(1, 60))):
            vals[j] = None
    if rng.random() < 0.15:
        for _ in range(rng.randint(1, 3)):
            vals[rng.randrange(n)] = -9999.0 if chirps else -round(rng.uniform(0.1, 5), 1)
    if rng.random() < 0.05:
        vals = [None] * n
    return {"startDate": s0.isoformat(), "values": vals}


def add_unit_rain(rng: random.Random, doc: dict, start: dt.date, days: int, dense: bool = False) -> None:
    """Runoff from each unit's own rain (§2.4h, engine >= 1.78.0), from its
    own stream so the rest of a network is unchanged: in 35 % of networks
    (75 % dense), settings.unitRain perUnit, with or without a gauge MAP and
    a MAP period (sometimes too short or outside the record for 5 complete
    years); per farm (a farm without area too, which isn't a land unit) its
    own gauge, its own CHIRPS, both or neither, and a MAP or none, a few far
    enough from the gauge MAP or the CHIRPS mean to be clamped; now and then
    a forecast tail the units reach through the catchment's rain. In 15 % of
    those networks the setting is `catchment` instead, the units' records
    and MAPs in the input but unused."""
    if rng.random() >= (0.75 if dense else 0.35):
        return
    s = doc["settings"]
    series = doc["series"]
    # Now and then the records and MAPs with the setting off: they change nothing (§2.4h).
    ur: dict = {"mode": "perUnit" if rng.random() < 0.85 else "catchment"}
    if rng.random() < 0.65:
        ur["gaugeMapMm"] = round(rng.uniform(300, 1200))
        ur["gaugeMapSource"] = "synthetic"
    if rng.random() < 0.4:
        y0 = start.year + rng.randint(-2, 4)
        ur["mapPeriod"] = {"start": f"{y0}-01-01", "end": f"{y0 + rng.randint(0, 6)}-12-31"}
    s["unitRain"] = ur
    farms = [x for x in doc["model"]["nodes"] if x["kind"] == "farm"]
    for f in farms:
        kind = rng.choice(["gauge", "chirps", "chirps", "both", "none"])
        if kind in ("gauge", "both"):
            series[f"rain_catchment_mm@{f['id']}"] = _unit_series(rng, start, days, rng.uniform(0.5, 1.8), False)
        if kind in ("chirps", "both"):
            series[f"rain_chirps_mm@{f['id']}"] = _unit_series(rng, start, days, rng.uniform(0.4, 1.5), True)
        if rng.random() < 0.7:
            f["mapMm"] = rng.choice([round(rng.uniform(250, 1500)), round(rng.uniform(250, 1500)), round(rng.uniform(1, 60)), round(rng.uniform(5000, 12000))])
            f["mapSource"] = "synthetic"
    if "rain_forecast_mm" not in series and rng.random() < 0.4:
        fstart = start + dt.timedelta(days=days - rng.randint(0, 5))
        series["rain_forecast_mm"] = {"startDate": fstart.isoformat(), "values": [round(rng.gammavariate(0.6, 5), 1) for _ in range(rng.randint(3, 16))]}
    add_unit_rain_reference(rng, doc, start, days)


def add_unit_rain_reference(rng: random.Random, doc: dict, start: dt.date, days: int) -> None:
    """A reference gauge for the units' CHIRPS (§2.4h, engine >= 1.80.0), in
    half the per-unit networks, drawn last from add_unit_rain's stream so the
    rest is unchanged: the catchment gauge or a farm's own (which may not
    exist), a reference farm (now and then one without area, which isn't a
    land unit), and its CHIRPS cell: the gauge × a bias per calendar month,
    some far enough out to be clamped, with gaps and no-data codes, or no
    cell series at all."""
    s = doc["settings"]
    series = doc["series"]
    ur = s.get("unitRain") or {}
    farms = [x for x in doc["model"]["nodes"] if x["kind"] == "farm"]
    if ur.get("mode") != "perUnit" or not farms or rng.random() >= 0.5:
        return
    ref_unit = rng.choice(farms)
    gauge = "rain_catchment_mm" if rng.random() < 0.7 else f"rain_catchment_mm@{rng.choice(farms)['id']}"
    ur["reference"] = {"gauge": gauge, "unitId": ref_unit["id"]}
    if rng.random() < 0.1:
        return
    bias = [None] + [rng.choice([rng.uniform(0.3, 1.5), rng.uniform(0.3, 1.5), rng.uniform(0.1, 0.2), rng.uniform(5, 8)]) for _ in range(12)]
    src = series.get(gauge)
    if src:
        s0 = dt.date.fromisoformat(src["startDate"])
        vals = [None if (v is None or v < 0) else round(v * bias[(s0 + dt.timedelta(days=i)).month], 2) for i, v in enumerate(src["values"])]
        cell = {"startDate": src["startDate"], "values": vals}
    else:
        cell = _unit_series(rng, start, days, rng.uniform(0.4, 1.5), True)
    for _ in range(rng.randint(0, 3)):
        a = rng.randrange(len(cell["values"])) if cell["values"] else 0
        for j in range(a, min(len(cell["values"]), a + rng.randint(1, 90))):
            cell["values"][j] = None
    if cell["values"] and rng.random() < 0.2:
        cell["values"][rng.randrange(len(cell["values"]))] = -9999.0
    series[f"rain_chirps_cell_mm@{ref_unit['id']}"] = cell


SABI_SYSTEMS = [("drip", "Drip", 0.9), ("micro", "Micro-sprinkler", 0.82), ("pivot", "Centre pivot / linear move", 0.85), ("sprinkler", "Sprinkler (permanent)", 0.8), ("movable", "Sprinkler (movable)", 0.75), ("surface", "Flood / furrow", 0.7)]


def add_irrigation_systems(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """Irrigation systems (§2.3 item 6, engine >= 1.72.0), from their own
    stream so the rest of a network is unchanged: in 40 % of networks (70 %
    dense), the SABI table as given (no table) or edited with rows of the
    project's own, a default system on some crops and a system of the unit's
    own on some plantings, now and then one the table lacks. Efficiencies in
    (0, 1]."""
    if rng.random() >= (0.7 if dense else 0.4):
        return
    m = doc["model"]
    ids = [i for i, _, _ in SABI_SYSTEMS]
    if rng.random() < 0.5:
        table = [{"id": i, "name": nm, "efficiency": rng.choice([e, 1, round(rng.uniform(0.5, 1), 2)]), "preset": i, "sortOrder": k} for k, (i, nm, e) in enumerate(SABI_SYSTEMS)]
        for k in range(rng.randint(0, 2)):
            table.append({"id": f"own-{k}", "name": f"Own {k}", "efficiency": rng.choice([1, round(rng.uniform(0.3, 1), 2)]), "preset": None, "sortOrder": len(table)})
        m["irrigationSystems"] = table
        ids = [t["id"] for t in table]

    def pick() -> str:
        return "no-such-system" if rng.random() < 0.05 else rng.choice(ids)

    for crop in m["crops"]:
        if rng.random() < 0.4:
            crop["irrigationSystemId"] = pick()
    for a in m["cropAreas"]:
        if rng.random() < 0.3:
            a["irrigationSystemId"] = pick()


def _day(rng, start: dt.date, days: int) -> str:
    return (start + dt.timedelta(days=rng.randrange(-60, days + 60))).isoformat()


def add_phase_two(rng: random.Random, doc: dict, start: dt.date, days: int, dense: bool = False) -> None:
    """Phase 2a features (verify/README.md), each in a share of the networks,
    drawn after every phase-1 draw so a seed's phase-1 part is unchanged.
    `dense` puts each feature in most networks (the mutation self-test's
    extra cases), so a few networks reach every phase-2a rule."""

    def gate(p: float) -> float:
        return 0.85 if dense else p

    m = doc["model"]
    s = doc["settings"]
    nodes = m["nodes"]
    by_id = {x["id"]: x for x in nodes}

    # Other water users (§2.7c), put in the middle of a reach so farms drain into them.
    if rng.random() < gate(0.3):
        for k in range(rng.randint(1, 3)):
            child = rng.choice([x for x in nodes if x["downstreamNodeId"] is not None])
            u = {
                "id": _uuid(rng), "name": f"user {k}", "kind": "user", "downstreamNodeId": child["downstreamNodeId"],
                "sortOrder": len(nodes), "areaKm2": 0, "areaHiKm2": 0, "areaLoKm2": 0, "flowShareManual": None,
                "pctUpstreamToDam": 0, "pctRunoffToDam": 0, "damCapacityM3": 0, "damInitialPct": 0, "damMinPct": 0,
                "divertCapacityM3Day": 0, "irrigationEfficiency": 1, "returnFlowFraction": 0, "damAreaFullM2": None,
                "damAreaExponent": 0.7, "damSeepagePerDay": 0,
                "userDemandM3Day": None if rng.random() < 0.1 else _monthly(rng, 0, rng.choice([200, 3000, 30000]), 0),
                "userReturnPct": rng.choice([0, 0, 0.5, round(rng.random(), 2)]),
                "userPriority": rng.choice(["senior", "senior", "junior"]),
            }
            child["downstreamNodeId"] = u["id"]
            nodes.append(u)
            by_id[u["id"]] = u
    farms = [x for x in nodes if x["kind"] == "farm"]
    units = farms + [x for x in nodes if x["kind"] == "user"]

    # Demand factors (§2.3 item 4a), from a date now and then.
    if rng.random() < gate(0.2):
        for x in rng.sample(units, rng.randint(1, len(units))):
            x["demandFactor"] = _monthly(rng, 0, 1.2, 2)
        if rng.random() < 0.4:
            s["demandFactorFrom"] = _day(rng, start, days)

    # Supply rules and the river pump (§2.7e).
    if rng.random() < gate(0.3):
        for f in farms:
            if rng.random() < 0.5:
                continue
            rule = rng.choice(["riverFirst", "trigger", "runOfRiver", "damFirst"])
            f["supplyRule"] = rule
            if rule == "runOfRiver" and rng.random() < 0.8:
                f["damCapacityM3"] = 0
            f["pumpCapacityM3Day"] = rng.choice([None, 0, round(rng.uniform(50, 3000)), round(rng.uniform(1000, 50000))])
            if rule == "trigger":
                f["supplyTriggerPct"] = round(rng.uniform(0, 0.7), 2)
                f["supplyStopPct"] = round(rng.uniform(0, 1), 2)

    # Hands-off flows and River to dam by month (§2.7h).
    if rng.random() < gate(0.3):
        for f in farms:
            if rng.random() < 0.5:
                continue
            r = rng.random()
            if r < 0.4:
                f["handsOffM3Day"] = _monthly(rng, 0, rng.choice([500, 5000, 50000]), 0)
            elif r < 0.5:
                f["handsOffM3Day"] = [0] * 12
            f["handsOffEwr"] = rng.random() < 0.4
            if rng.random() < 0.5:
                f["divertMonthlyM3Day"] = [0 if rng.random() < 0.4 else round(rng.uniform(0, 5000)) for _ in range(12)]

    # Dam survey curves, releases and seepage shares (§2.7a).
    dams = [f for f in farms if f["damCapacityM3"] > 0]
    if dams and rng.random() < gate(0.3):
        for f in dams:
            if rng.random() < 0.5:
                cap = f["damCapacityM3"]
                rows = []
                v = 0.0
                a = 0.0
                lvl = rng.uniform(0, 100)
                for _ in range(rng.randint(2, 7)):
                    v += cap * rng.uniform(0.1, 0.5)
                    a += cap / rng.uniform(2, 12) * rng.uniform(0.1, 0.6)
                    lvl += rng.uniform(0.2, 2)
                    rows.append({"levelM": round(lvl, 2), "areaM2": round(a, 1), "volumeM3": round(v, 1)})
                rng.shuffle(rows)
                f["damCurve"] = rows
            if rng.random() < 0.5:
                f["damReleaseRule"] = rng.choice(["passInflow", "fixed", "none"])
                f["damReleaseM3Day"] = None if rng.random() < 0.3 else _monthly(rng, 0, f["damCapacityM3"] / rng.choice([50, 500]), 1)
                f["damOutletCapacityM3Day"] = rng.choice([None, round(f["damCapacityM3"] / rng.uniform(20, 400), 1)])

    # Boreholes (§2.7d): the combined capacity and individual ones.
    if rng.random() < gate(0.35):
        bhs = []
        for x in units:
            if rng.random() < 0.5:
                continue
            if rng.random() < 0.5:
                x["boreholeCapacityM3Day"] = round(rng.uniform(20, 3000))
                x["boreholeRule"] = rng.choice(["supplemental", "primary", "drought"])
                x["boreholeTriggerPct"] = round(rng.uniform(0, 0.8), 2)
            x["streamDepletionFrac"] = rng.choice([0, 0.5, 1, round(rng.random(), 2)])
            x["streamDepletionLagDays"] = rng.choice([0, 0, 3, round(rng.uniform(0, 60), 1)])
            for _ in range(rng.choice([0, 1, 2, 3])):
                bhs.append({
                    "id": _uuid(rng), "nodeId": x["id"], "name": "bh", "capacityM3Day": round(rng.uniform(10, 2000)),
                    "annualCapM3": rng.choice([None, round(rng.uniform(500, 20000)), round(rng.uniform(20000, 300000))]),
                    "mode": rng.choice(["none", "supplemental", "supplemental", "primary", "emergency"]),
                    "emergencyBelowPct": round(rng.uniform(0, 0.8), 2),
                    "target": rng.choice(["direct", "direct", "dam"]),
                    "depletionFactor": rng.choice([0, 1, round(rng.random(), 2)]),
                })
        m["boreholes"] = bhs

    # Demand objects with schedules and the basic-needs floor (§2.7f).
    if rng.random() < gate(0.3):
        objs = []
        for f in farms:
            if rng.random() < 0.5:
                continue
            for _ in range(rng.randint(1, 3)):
                cat = rng.choice(["domestic", "municipal", "industrial", "livestock", "irrigation", "external", "other"])
                per = rng.random() < 0.5
                ob = {
                    "id": _uuid(rng), "nodeId": f["id"], "name": "obj", "category": cat,
                    "sizing": "perUnit" if per else "monthly",
                    "monthlyM3Day": None if per else _monthly(rng, 0, rng.choice([50, 1000, 10000]), 1),
                    "count": rng.randint(1, 3000) if per else None,
                    "litresPerUnitDay": rng.choice([25, 45, 230, round(rng.uniform(10, 400), 1)]) if per else None,
                    "lossPct": round(rng.uniform(0, 0.4), 2) if per else 0,
                    "monthlyFactor": (_monthly(rng, 0.5, 1.5, 2) if rng.random() < 0.5 else None) if per else None,
                    "returnPct": round(rng.random(), 2), "priority": rng.choice(["first", "shared", "last"]),
                    "destination": "internal", "enabled": rng.random() > 0.1, "note": "",
                }
                # Its rank within its class (engine >= 1.64.0): sometimes none, sometimes 1-3,
                # from its own stream so the rest of every seed's network stays as it was.
                own = random.Random(ob["id"])
                if own.random() < 0.5:
                    ob["rank"] = own.choice([1, 2, 3])
                if rng.random() < 0.2:
                    ob["destination"] = "external"
                    ob["returnPct"] = 0
                if not per and rng.random() < 0.5:
                    ob["population"] = rng.randint(1, 20000)
                if rng.random() < 0.5:
                    ob["schedule"] = [_window(rng, start, days) for _ in range(rng.randint(1, 4))]
                objs.append(ob)
        m["demandObjects"] = objs

    # River off-takes and canal seepage return (§2.6a), never in a loop.
    if len(farms) >= 2 and rng.random() < gate(0.3):
        succ = {x["id"]: set() for x in nodes}
        for x in nodes:
            if x["downstreamNodeId"] is not None:
                succ[x["id"]].add(x["downstreamNodeId"])

        def reach(a, b):
            seen, st = set(), [a]
            while st:
                k = st.pop()
                if k == b:
                    return True
                if k in seen:
                    continue
                seen.add(k)
                st.extend(succ[k])
            return False

        for _ in range(rng.randint(1, 3)):
            a, b = rng.sample(farms, 2)
            if reach(b["id"], a["id"]):
                continue
            succ[a["id"]].add(b["id"])
            t = {
                "id": _uuid(rng), "fromNodeId": a["id"], "toNodeId": b["id"],
                "months": sorted(rng.sample(range(1, 13), rng.randint(1, 12))),
                "maxRateM3s": round(rng.uniform(0.001, 0.2), 4), "dailyCapM3": rng.choice([None, None, round(rng.uniform(100, 8000))]),
                "minStoragePct": 0, "enabled": rng.random() > 0.1, "priority": rng.randint(0, 2), "source": "river",
                "handsOffM3Day": rng.choice([None, None, round(rng.uniform(0, 5000))]), "handsOffEwr": rng.random() < 0.3,
                "lossPct": rng.choice([0, 0.1, round(rng.uniform(0, 0.6), 2)]), "sizing": rng.choice(["demand", "demand", "capacity"]),
                "topUpDam": rng.random() < 0.4,
            }
            if rng.random() < 0.25:
                rates = [0 if rng.random() < 0.4 else round(rng.uniform(0.001, 0.2), 4) for _ in range(12)]
                t["monthlyRateM3s"] = rates
                t["months"] = [(k + 9) % 12 + 1 for k in range(12) if rates[k] > 0]
                t["maxRateM3s"] = max(rates)
            if t["lossPct"] > 0 and rng.random() < 0.5:
                t["lossReturnPct"] = rng.choice([1, round(rng.random(), 2)])
                below = []
                k = a["downstreamNodeId"]
                while k is not None:
                    if by_id[k]["kind"] == "farm":
                        below.append(k)
                    k = by_id[k]["downstreamNodeId"]
                t["lossReturnNodeId"] = rng.choice([None] + below)
            m["transfers"].append(t)

    # Allocations: compare only, the cap with licence conditions, or a full allocation (§2.12a).
    if rng.random() < gate(0.35):
        s["allocationMode"] = rng.choice(["none", "cap", "cap", "fullAllocation"])
        allocs = []
        for x in units:
            if rng.random() < 0.3:
                continue
            for src in ("surface", "groundwater"):
                if rng.random() < 0.4:
                    continue
                for _ in range(rng.choice([1, 1, 2])):
                    a = {
                        "id": _uuid(rng), "nodeId": x["id"], "waterSource": src,
                        "volumeM3PerYear": rng.choice([0, round(rng.uniform(1000, 50000)), round(rng.uniform(50000, 2000000))]),
                        "storageM3": None, "validFrom": None, "validTo": None, "months": [], "maxRateM3s": None,
                    }
                    if rng.random() < 0.3:
                        a["validFrom"] = _day(rng, start, days)
                    if rng.random() < 0.3:
                        a["validTo"] = _day(rng, start, days)
                        if a["validFrom"] and a["validFrom"] > a["validTo"]:
                            a["validFrom"], a["validTo"] = a["validTo"], a["validFrom"]
                    if rng.random() < 0.4:
                        a["months"] = sorted(rng.sample(range(1, 13), rng.randint(1, 12)))
                    if rng.random() < 0.4:
                        a["maxRateM3s"] = rng.choice([0, round(rng.uniform(0.0005, 0.05), 4)])
                    allocs.append(a)
            # A dam's registered storage (s21b, engine 1.59.0): never a take, so no mode reads it;
            # now and then with a volume on it, which the engine ignores with a warning.
            if rng.random() < 0.25:
                allocs.append({
                    "id": _uuid(rng), "nodeId": x["id"], "waterSource": "surface", "waterUse": "21b",
                    "volumeM3PerYear": rng.choice([0, 0, round(rng.uniform(1000, 50000))]),
                    "storageM3": round(rng.uniform(10000, 500000)), "validFrom": None, "validTo": None, "months": [], "maxRateM3s": None,
                })
        m["allocations"] = allocs

    # River abstractions beside a unit's dam (§2.7j): the crops or a demand object on a pump of their own,
    # now and then with a pool; drawn last, so every other feature of a seed is unchanged.
    if rng.random() < gate(0.3):
        pump = lambda: rng.choice([None, 0, round(rng.uniform(50, 3000)), round(rng.uniform(1000, 50000))])
        pool = lambda: rng.choice([None, None, 0, round(rng.uniform(20, 500)), round(rng.uniform(500, 50000))])
        for f in farms:
            if rng.random() < 0.4:
                f["cropWaterSource"] = "river"
                f["cropRiverPumpM3Day"] = pump()
                f["cropRiverPoolM3"] = pool()
        for ob in m.get("demandObjects") or []:
            if rng.random() < 0.5:
                ob["waterSource"] = rng.choice(["river", "river", "dam"])
                ob["riverPumpM3Day"] = pump()
                ob["riverPoolM3"] = pool()

    # The crop supply table (§2.7k): the crops' demand in shares of the unit's dam, the river and another
    # unit's dam (any other unit: with a dam or not, upstream, downstream or on another branch, which the
    # run skips with a warning), through a pipe of no limit to tight; drawn last of all.
    if rng.random() < gate(0.3):
        for f in farms:
            if rng.random() >= 0.5:
                continue
            w = [rng.choice([0, rng.random()]), rng.choice([0, rng.random()]), rng.random()]
            tot = sum(w)
            f["cropShareDam"], f["cropShareRiver"], f["cropShareRemote"] = (v / tot for v in w)
            others = [g for g in farms if g is not f]
            f["cropRemoteNodeId"] = rng.choice(others)["id"] if others else None
            f["cropRemoteCapM3Day"] = rng.choice([None, 0, round(rng.uniform(10, 500)), round(rng.uniform(500, 50000))])
            if f.get("cropRiverPumpM3Day") is None and rng.random() < 0.5:
                f["cropRiverPumpM3Day"] = round(rng.uniform(50, 5000))

    # Bed losses in the reach below a node (§2.6b): any kind of node, the outlet too (ignored), a share up to the
    # whole flow (f = 1, WRSM's Bedloss with a cap; now and then out of range, clamped) with no cap, a tight cap or a loose one; drawn last of all.
    if rng.random() < gate(0.3):
        for x in nodes:
            if rng.random() >= 0.5:
                continue
            x["reachLossFrac"] = rng.choice([round(rng.uniform(0, 0.5), 3), 0.5, round(rng.uniform(0, 0.05), 3), 0.8, 1, 1.3])
            x["reachLossMaxM3Day"] = rng.choice([None, None, 0, round(rng.uniform(10, 500)), round(rng.uniform(500, 50000))])


def _window(rng, start: dt.date, days: int) -> dict:
    span = rng.choice(["always", "yearly", "range", "easter"])
    w = {"label": "", "span": span, "from": None, "to": None, "easterFrom": None, "easterTo": None,
         "weekdays": None, "factor": rng.choice([0, 0, 0.5, 1.5, round(rng.uniform(0, 3), 2)])}
    if span == "yearly":
        a = dt.date(2001, 1, 1) + dt.timedelta(days=rng.randrange(365))
        b = dt.date(2001, 1, 1) + dt.timedelta(days=rng.randrange(365))
        w["from"], w["to"] = a.strftime("%m-%d"), b.strftime("%m-%d")
    elif span == "range":
        a, b = sorted([_day(rng, start, days), _day(rng, start, days)])
        w["from"], w["to"] = a, b
    elif span == "easter":
        a, b = sorted([rng.randint(-60, 60), rng.randint(-60, 60)])
        w["easterFrom"], w["easterTo"] = a, b
    if span == "always" or rng.random() < 0.3:
        w["weekdays"] = sorted(rng.sample(range(1, 8), rng.randint(1, 6)))
    return w
