"""Random networks for the cross-check (verify/README.md), this harness's own
generator: seeded, stdlib `random` only, and independent of the engine's fuzz
generator (packages/engine/src/testing/fuzz.ts is never read). Every input is
synthetic and uses only phase-1 features (model.unsupported() is empty).

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


def random_input(seed: int) -> dict:
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
            "irrigationEfficiency": 1, "lossReturnFraction": 0, "damAreaFullM2": None, "damAreaExponent": 0.7,
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
        n.update(
            areaKm2=area,
            areaHiKm2=hi,
            areaLoKm2=round(area - hi, 2),
            flowShareManual=math.floor(manual[farms.index(n)] / tot * 1e4) / 1e4 if method == "manual" else None,
            pctUpstreamToDam=rng.choice([0, 0, 1, round(rng.random(), 2)]),
            pctRunoffToDam=rng.choice([0, 1, 1, round(rng.random(), 2)]),
            irrigationEfficiency=rng.choice([1, 0.9, 0.85, 0.01, round(rng.uniform(0.5, 1), 2)]),
            lossReturnFraction=rng.choice([0, 0.5, 1, round(rng.random(), 2)]),
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

    return {"settings": settings, "model": {"nodes": nodes, "crops": crops, "cropAreas": crop_areas, "transfers": transfers}, "series": series}
