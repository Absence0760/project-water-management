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

    # The retired flow-share method's and specific shares' draws (engine 1.105.0, issue #616), kept so the rest of a
    # seed's network is what it was.
    rng.choice(["area", "area", "hiLo", "manual"])
    farms = [n for n in nodes if n["kind"] == "farm"]
    for _ in farms:
        rng.random()
    if farms:
        rng.uniform(0.7, 1.0)
    for idx, n in enumerate(nodes):
        n["sortOrder"] = idx
        base = {
            "areaKm2": 0, "pctUpstreamToDam": 0,
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
        rng.uniform(0.2, 0.8)  # the retired high-MAP area's draw (issue #616)
        # The same draws, in the same order, as before engine 1.71.0: β, a share of the losses, is
        # stored as the return flow r = β(1 − e), a share of the water supplied.
        up = rng.choice([0, 0, 1, round(rng.random(), 2)])
        ro = rng.choice([0, 1, 1, round(rng.random(), 2)])
        e = rng.choice([1, 0.9, 0.85, 0.01, round(rng.uniform(0.5, 1), 2)])
        beta = rng.choice([0, 0.5, 1, round(rng.random(), 2)])
        n.update(
            areaKm2=area,
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
        # The retired Hi/Lo split's draw (issue #616), kept in place so the rest of a seed is what it was; dropped below.
        "_retiredHiLoDraw": rng.random(),
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
    del settings["_retiredHiLoDraw"]
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
    add_baseflow(random.Random(seed * 2750159 + 7), doc, dense)
    add_unit_rain_decisions(random.Random(seed * 32452843 + 7), doc)
    add_external_transfers(random.Random(seed * 49979687 + 13), doc, dense)
    add_rain_stations(random.Random(seed * 67867967 + 5), doc, start, days, dense)
    add_calibration_zones(random.Random(seed * 86028121 + 17), doc, dense)
    add_calibration_locations(random.Random(seed * 52368691 + 23), doc)
    add_apan_daily(random.Random(seed * 15485867 + 29), doc, start, days, dense)
    add_demand_parts(random.Random(seed * 32452867 + 31), doc, start, days, dense)
    add_land_cover(random.Random(seed * 49979693 + 37), doc, dense)
    add_development(random.Random(seed * 67867979 + 41), doc, start, days, dense)
    add_diversion_curves(random.Random(seed * 86028157 + 43), doc, dense)
    add_monthly_diversions(random.Random(seed * 15485927 + 47), doc, dense)
    add_transfer_splits(random.Random(seed * 32452939 + 53), doc, dense)
    # Its own stream (both branches had taken 15485927 + 47), so the CHIRPS choice draws apart from the monthly diversions.
    add_unit_chirps_choice(random.Random(seed * 49979687 + 59), doc, dense)
    # Each unit's own A-pan (§2.3b, engine >= 1.117.0): its own stream, last, so no other draw moves.
    add_apan_units(random.Random(seed * 67867999 + 61), doc, dense)
    # The EWR split by each unit's natural MAR (§2.5b) is every network's from engine 1.105.0 (issue #615): no
    # setting to draw any more (add_ewr_split's stream was the last, so no other draw moves).
    return doc


def add_apan_units(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """CCWR A-pan (Hydrological Unit) (§2.3b, engine >= 1.117.0): in 25 % of networks (50 % dense) the settings
    store each of most land units' own 12-month A-pan row (the catchment row × a unit factor, now and then a month
    of its own), some land units left without one (they run on the covered units' area-weighted row), now and then
    a row for a node that isn't a land unit (ignored). Most of those choose the 'units' basis; the rest keep the
    catchment row with the rows stored, which must change nothing."""
    if rng.random() >= (0.5 if dense else 0.25):
        return
    s = doc["settings"]
    land = [x for x in doc["model"]["nodes"] if x["kind"] == "farm" and (x.get("areaKm2") or 0) > 0]
    if not land:
        return
    base = [max(1.0, float(v)) if v else rng.uniform(40, 250) for v in s["apanMm"]]
    units = {}
    for x in land:
        if rng.random() < 0.2:
            continue
        k = rng.uniform(0.7, 1.4)
        row = [round(v * k, 1) for v in base]
        if rng.random() < 0.2:
            row[rng.randrange(12)] = round(rng.uniform(0, 300), 1)
        units[x["id"]] = row
    others = [x for x in doc["model"]["nodes"] if x not in land]
    if others and rng.random() < 0.2:
        units[rng.choice(others)["id"]] = [round(v, 1) for v in base]
    if not units:
        return
    s["apanUnits"] = {"dataset": "synthetic", "source": "synthetic A-pan grid, area-weighted over each unit's outline", "units": units}
    s["apanBasis"] = "units" if rng.random() < 0.8 else rng.choice(["catchment", None])


def add_apan_daily(rng: random.Random, doc: dict, start: dt.date, days: int, dense: bool = False) -> None:
    """A daily A-pan record (§2.3a, engine >= 0.38.0, `evap_apan_mm`), from its
    own stream so the rest of a network is unchanged: in 25 % of networks (60 %
    dense), the month's mean spread over its days × a day's weather, starting
    before or after the rain and ending before or after it, with blank
    stretches and now and then a negative (no-data) value and a 0. Now and then
    the monthly means are all 0, so the record is the only A-pan."""
    if rng.random() >= (0.6 if dense else 0.25):
        return
    s = doc["settings"]
    if rng.random() < 0.15:
        s["apanMm"] = [0] * 12
    mean = [max(1.0, float(v)) if v else rng.uniform(40, 250) for v in s["apanMm"]]
    off = rng.randint(-120, days // 2)
    length = rng.randint(30, days + 200 - max(0, off))
    a0 = start + dt.timedelta(days=off)
    vals: list = []
    for k in range(length):
        d = a0 + dt.timedelta(days=k)
        wm = (d.month - 10) % 12
        mdays = (dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1) - dt.date(d.year, d.month, 1)).days
        vals.append(round(mean[wm] / mdays * rng.uniform(0.3, 1.8), 2))
    for _ in range(rng.randint(0, 4)):
        a = rng.randrange(length)
        for j in range(a, min(length, a + rng.randint(1, 50))):
            vals[j] = None
    for _ in range(rng.randint(0, 3)):
        vals[rng.randrange(length)] = rng.choice([-1, -999, 0.0])
    doc["series"]["evap_apan_mm"] = {"startDate": a0.isoformat(), "values": vals}


DEMAND_PARTS = ["crops", "domestic", "municipal", "industrial", "livestock", "irrigation", "external", "other"]


def add_demand_parts(rng: random.Random, doc: dict, start: dt.date, days: int, dense: bool = False) -> None:
    """Demand factors by part (`partDemandFactor`, engine >= 1.45.0) and dated
    demand factors (`demandFactorWindows`, engine >= 1.82.0), §2.3 item 4a and
    scenarios.md § Demand scaling, from their own stream so the rest of a
    network is unchanged: in 25 % of networks (65 % dense). On some farms a
    factor for the crops or for a category of demand object (its own, or one
    the farm has none of), cuts and rises; on some farms and users one to
    three windows, each from–to (open now and then, sometimes outside the
    run), 12 multipliers (1 in the months a months-only op leaves out), a
    farm's window now and then on one part."""
    if rng.random() >= (0.65 if dense else 0.25):
        return
    m = doc["model"]
    cats: dict[str, list[str]] = {}
    for ob in m.get("demandObjects") or []:
        cats.setdefault(ob["nodeId"], []).append(ob["category"])

    def row() -> list[float]:
        if rng.random() < 0.3:
            v = round(rng.uniform(0, 1.6), 2)
            months = set(rng.sample(range(12), rng.randint(1, 6)))
            return [v if k in months else 1 for k in range(12)]
        return _monthly(rng, 0, 1.4, 2)

    def date(lo: int, hi: int) -> str:
        return (start + dt.timedelta(days=rng.randint(lo, hi))).isoformat()

    for x in m["nodes"]:
        if x["kind"] not in ("farm", "user") or rng.random() >= 0.6:
            continue
        own = cats.get(x["id"], [])
        if x["kind"] == "farm" and rng.random() < 0.6:
            parts = {}
            for _ in range(rng.randint(1, 3)):
                p = rng.choice(["crops", "crops"] + own + [rng.choice(DEMAND_PARTS)])
                parts[p] = row()
            x["partDemandFactor"] = parts
        if rng.random() < 0.6:
            wins = []
            for _ in range(rng.randint(1, 3)):
                a = rng.randint(-200, days)
                w: dict = {"factor": row()}
                if rng.random() < 0.85:
                    w["from"] = date(a, a)
                if rng.random() < 0.85:
                    w["to"] = date(a + rng.randint(0, 400), a + 400)
                if x["kind"] == "farm" and rng.random() < 0.35:
                    w["part"] = rng.choice(["crops"] + own + ["domestic"])
                wins.append(w)
            x["demandFactorWindows"] = wins


LAND_COVER_CLASSES = ["eucalyptus", "pine", "invasive", "invasiveRiparian", "other"]


def add_land_cover(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """Land-cover patches (§2.5a, engine >= 0.24.0), from their own stream so
    the rest of a network is unchanged: in 25 % of networks (65 % dense), on
    about half the farms one to three patches of a random class, from a
    sliver to more than the unit (so some units' condensed cover is scaled
    down to it), a cover 0–1, now and then the patch's own reductions; now and
    then a patch on a gauge, a user or a farm without area (skipped)."""
    if rng.random() >= (0.65 if dense else 0.25):
        return
    m = doc["model"]
    patches = []
    for x in m["nodes"]:
        land = x["kind"] == "farm" and (x.get("areaKm2") or 0) > 0
        if rng.random() >= (0.5 if land else 0.08):
            continue
        a = float(x.get("areaKm2") or 1)
        for _ in range(rng.randint(1, 3)):
            patches.append({
                "id": _uuid(rng), "nodeId": x["id"], "coverClass": rng.choice(LAND_COVER_CLASSES),
                "areaKm2": round(a * rng.choice([rng.uniform(0.01, 0.3), rng.uniform(0.3, 1.3)]), 3),
                "densityPct": rng.choice([1, round(rng.uniform(0.05, 1), 2)]),
                "factors": None if rng.random() < 0.6 else {"mar": round(rng.random(), 2), "lowFlow": round(rng.random(), 2)},
            })
    rng.shuffle(patches)
    m["landCover"] = patches


def add_development(rng: random.Random, doc: dict, start: dt.date, days: int, dense: bool = False) -> None:
    """Development that changes during a run (§2.7g, engine >= 1.30.0), from
    its own stream so the rest of a network is unchanged: in 25 % of networks
    (65 % dense), on about half the dams a survey date (before, inside or after
    the run) with a sediment rate of up to 0.2 a year (so some dams fill up and
    some run back past their entered capacity), now and then a survey date
    without a rate, and an in-service date (before the run or inside it); on
    some farms and users the first day they take water."""
    if rng.random() >= (0.65 if dense else 0.25):
        return

    def date(lo: int, hi: int) -> str:
        return (start + dt.timedelta(days=rng.randint(lo, hi))).isoformat()

    for x in doc["model"]["nodes"]:
        if x["kind"] == "farm" and (x.get("damCapacityM3") or 0) > 0 and rng.random() < 0.55:
            if rng.random() < 0.7:
                x["damSurveyDate"] = date(-5 * 365, days + 2 * 365)
                if rng.random() < 0.85:
                    x["damSedimentPctPerYear"] = rng.choice([0.005, 0.02, round(rng.uniform(0, 0.2), 3), 0.2])
            if rng.random() < 0.5:
                x["damInServiceFrom"] = date(-200, days - 30)
        if x["kind"] in ("farm", "user") and rng.random() < 0.2:
            x["abstractionFrom"] = date(-100, days)


def add_calibration_locations(rng: random.Random, doc: dict) -> None:
    """Calibration locations (§2.10n, engine 1.110.0, issue #659), from their
    own stream so the other draws don't move (the last stream drawn). In 60 %
    of networks with calibration rows, the settings are in the locations'
    shape: the outlet ticked or not, a rest rule of the three, now and then a
    headline pointer at a ticked row (or at a gauge that isn't one), and in
    half of them one land unit taking a row's parameters (Parameters from),
    preferably a gauge it doesn't drain to. The other 40 % stay in the shape
    of before (read as legacy), half of those with a site at a gauge inside
    the network."""
    s = doc["settings"]
    rows = s.get("calibrationZones") or []
    if not rows:
        return
    nodes = doc["model"]["nodes"]
    by_id = {n["id"]: n for n in nodes}
    if rng.random() >= 0.6:
        # The shape of before: in half of them a site at a gauge inside the network, read as its location.
        inner = sorted(n["id"] for n in nodes if n["kind"] == "gauge" and n.get("downstreamNodeId") is not None)
        if inner and rng.random() < 0.5:
            s["calibrationSiteNodeId"] = rng.choice(inner)
        return

    def down(i):
        out = []
        while i is not None and i not in out:
            out.append(i)
            i = by_id[i].get("downstreamNodeId")
        return out

    s["calibrateAtOutlet"] = rng.random() < 0.5
    s["calibrationRest"] = rng.choice(["nearest", "headline", "default"])
    ticked = [z["nodeId"] for z in rows if z.get("enabled")]
    r = rng.random()
    s["calibrationSiteNodeId"] = rng.choice(ticked) if ticked and r < 0.3 else (rng.choice([z["nodeId"] for z in rows]) if r < 0.4 else None)
    units = sorted((n for n in nodes if n["kind"] == "farm" and (n.get("areaKm2") or 0) > 0), key=lambda n: n["id"])
    if units and rng.random() < 0.5:
        u = rng.choice(units)
        others = [z["nodeId"] for z in rows if z["nodeId"] not in down(u["id"])]
        s["unitParamsFrom"] = {u["id"]: rng.choice(others or [z["nodeId"] for z in rows])}


def add_calibration_zones(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """Calibration zones (§2.10n, engine 1.106.0, issue #555), from their own
    stream so the other draws don't move (the last stream drawn). Under Per
    unit, in 90 % of networks with a gauge inside the network that a land unit
    drains to (a dense one without such a gauge gets one, put on a land unit's
    way down), a row for most gauges inside the network, most ticked, each
    with its own X1–X4 inside the bounds, now and then none (not fitted yet)
    or one outside them. Under the retired catchment mode (Fragmentation, which
    runs Per unit since engine 1.109.0), in 30 % of networks with a gauge
    inside, rows too."""
    s = doc["settings"]
    nodes = doc["model"]["nodes"]
    per_unit = (s.get("unitRain") or {}).get("mode") == "perUnit"
    by_id = {n["id"]: n for n in nodes}

    def down(i):
        out = []
        while i is not None and i not in out:
            out.append(i)
            i = by_id[i].get("downstreamNodeId")
        return out

    units = sorted((n for n in nodes if n["kind"] == "farm" and (n.get("areaKm2") or 0) > 0), key=lambda n: n["id"])
    inner = {n["id"] for n in nodes if n["kind"] == "gauge" and n.get("downstreamNodeId") is not None}
    reached = {g for u in units for g in down(u["id"])[1:] if g in inner}
    if per_unit and dense and not reached and units:
        u = rng.choice(units)
        gid = _uuid(rng)
        nodes.append({
            "id": gid, "name": "Zone weir", "kind": "gauge", "downstreamNodeId": u["downstreamNodeId"], "sortOrder": len(nodes),
            "areaKm2": 0, "pctUpstreamToDam": 0, "pctRunoffToDam": 0, "damCapacityM3": 0, "damInitialPct": 0, "damMinPct": 0,
            "divertCapacityM3Day": 0, "irrigationEfficiency": 1, "returnFlowFraction": 0, "damAreaFullM2": None, "damAreaExponent": 0.7,
            "damSeepagePerDay": 0,
        })
        u["downstreamNodeId"] = gid
        inner.add(gid)
        reached.add(gid)
    if not inner or rng.random() >= (0.9 if per_unit and reached else 0.3):
        return
    rows = []
    for gid in sorted(inner):
        if rng.random() < (0.15 if gid in reached else 0.5):
            continue
        p = {"x1": round(rng.uniform(50, 1500), 1), "x2": rng.choice([0, 0, round(rng.uniform(-2, 1), 2)]), "x3": round(rng.uniform(10, 400), 1), "x4": round(rng.uniform(0.6, 5), 2)}
        r = rng.random()
        gr4j = None if r < 0.15 else ({**p, "x1": 5} if r < 0.22 else p)
        rows.append({
            "nodeId": gid,
            "enabled": rng.random() < 0.85,
            "calibrationStart": None,
            "calibrationEnd": None,
            "calibrationFlowKind": None,
            "calibrationExclusions": [],
            "qualityFlags": None,
            "gr4j": gr4j,
            "fitRecord": None,
        })
    s["calibrationZones"] = rows


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
    those networks the setting is the retired `catchment` instead, which runs
    Per unit all the same (engine >= 1.109.0, issue #658)."""
    if rng.random() >= (0.75 if dense else 0.35):
        return
    s = doc["settings"]
    series = doc["series"]
    # Now and then the retired catchment mode (Fragmentation): it runs Per unit (§2.4h, engine >= 1.109.0).
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


def add_unit_chirps_choice(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """CHIRPS as a unit's driver (§2.4h, engine >= 1.114.0), from its own
    stream so the rest of a network is unchanged: in 60 % of the per-unit
    networks (90 % dense), about 60 % of the farms (a farm without area too,
    which isn't a land unit) get settings.unitRain.chirpsUnits[id], `bias`
    or `raw`; a farm without CHIRPS of its own or with a station keeps it,
    which the run ignores."""
    s = doc["settings"]
    ur = s.get("unitRain")
    if not isinstance(ur, dict) or rng.random() >= (0.9 if dense else 0.6):
        return
    farms = [x for x in doc["model"]["nodes"] if x["kind"] == "farm"]
    choices = {f["id"]: {"correction": rng.choice(["bias", "raw"])} for f in farms if rng.random() < 0.6}
    if choices:
        ur["chirpsUnits"] = choices


def add_unit_rain_decisions(rng: random.Random, doc: dict) -> None:
    """Issue #500's decisions (operator, 2026-10-09), from their own stream
    so the rest of a per-unit network is unchanged: the forecast's source
    (`forecastRainSource` 'chirps_gefs', 'other' or absent, item 5) where
    there is a forecast; now and then a unit's CHIRPS reading 0 mm on every
    day (unusable, item 7a); and in a unit's own gauge a long run of zeros or
    a big reading after a few blank days, for the catchment's checks to find
    or not (item 6, and 1c when it is the reference gauge)."""
    ur = doc["settings"].get("unitRain") or {}
    if ur.get("mode") != "perUnit":
        return
    series = doc["series"]
    if "rain_forecast_mm" in series:
        src = rng.choice(["chirps_gefs", "chirps_gefs", "other", None])
        if src is not None:
            doc["forecastRainSource"] = src
    for f in (x for x in doc["model"]["nodes"] if x["kind"] == "farm"):
        ch = series.get(f"rain_chirps_mm@{f['id']}")
        if ch and rng.random() < 0.12:
            ch["values"] = [None if v is None else (v if v < 0 else 0.0) for v in ch["values"]]
        g = series.get(f"rain_catchment_mm@{f['id']}")
        if not g or len(g["values"]) < 400:
            continue
        vals = g["values"]
        if rng.random() < 0.35:
            a = rng.randrange(len(vals) - 200)
            for j in range(a, a + rng.randint(70, 180)):
                vals[j] = 0.0
        if rng.random() < 0.35:
            for _ in range(rng.randint(1, 3)):
                r = rng.randrange(20, len(vals))
                for j in range(r - rng.randint(3, 10), r):
                    vals[j] = None
                vals[r] = round(rng.uniform(20, 90), 1)


def _station_record(rng: random.Random, start: dt.date, days: int) -> dict:
    """A station's record: its own synthetic rain from up to six years
    before the network's start (so a pairing may have five complete years)
    or a little after it, to about its end, with gaps, now and then a
    no-data code, a long run of zeros (§2.4c) or a big reading after a few
    blank days (§2.4d)."""
    off = -rng.choice([0, 0, rng.randint(1, 6) * 365 + rng.randint(-20, 20), rng.randint(0, 120)])
    if rng.random() < 0.2:
        off = rng.randint(30, 500)
    s0 = start + dt.timedelta(days=off)
    n = max(30, days - off + rng.randint(-200, 60))
    vals: list = [round(v * rng.uniform(0.6, 1.6), 1) for v in _rain(rng, s0, n, rng.random() < 0.5)]
    for _ in range(rng.choice([0, 0, 1, 2, 4])):
        a = rng.randrange(n)
        for j in range(a, min(n, a + rng.randint(1, 50))):
            vals[j] = None
    if rng.random() < 0.15:
        vals[rng.randrange(n)] = -9999.0
    if rng.random() < 0.3 and n > 400:
        a = rng.randrange(n - 200)
        for j in range(a, a + rng.randint(70, 180)):
            vals[j] = 0.0
    if rng.random() < 0.3 and n > 60:
        for _ in range(rng.randint(1, 3)):
            r = rng.randrange(20, n)
            for j in range(r - rng.randint(3, 10), r):
                vals[j] = None
            vals[r] = round(rng.uniform(20, 90), 1)
    return {"startDate": s0.isoformat(), "values": vals}


def add_rain_stations(rng: random.Random, doc: dict, start: dt.date, days: int, dense: bool = False) -> None:
    """Rainfall stations (§2.4i, engine >= 1.91.0), from their own stream so
    the rest of a network is unchanged: in 30 % of networks (65 % dense), one
    to three stations (records from _station_record; a MAP or, now and
    then, none; now and then the one that is the catchment gauge), each with
    a CHIRPS cell, a site in a farm (whose CHIRPS may not exist) or neither,
    and now and then unreliable periods. Half the time the catchment has a
    station (sometimes unscaled, corrected against another, with a
    catchment MAP, one out of range, or the farms' mean, which needs every
    land unit's MAP); under per-unit rain each land unit has one 60 % of the
    time, often with CHIRPS of its own for the gaps. Now and then an
    assignment names a station with no record, or has no station id. Last,
    so every draw above is as before: a patching priority (issue #612) on
    40 % of the assignments, a shuffled list of other stations (now and then
    the main one, a repeat or one with no record) with CHIRPS somewhere or
    absent, and now and then empty."""
    if rng.random() >= (0.65 if dense else 0.3):
        return
    s = doc["settings"]
    series = doc["series"]
    farms = [x for x in doc["model"]["nodes"] if x["kind"] == "farm"]
    per_unit = (s.get("unitRain") or {}).get("mode") == "perUnit"
    ids = [f"st{k}" for k in range(rng.randint(1, 3))]
    stations: dict = {}
    rs: dict = {}
    for sid in ids:
        series[f"rain_station_mm#{sid}"] = _station_record(rng, start, days)
        mp = None if rng.random() < 0.1 else rng.choice([round(rng.uniform(300, 1200)), round(rng.uniform(300, 1200)), round(rng.uniform(20, 120))])
        stations[sid] = {"name": f"Station {sid}", "mapMm": mp, "mapSource": None if mp is None else "synthetic", "lat": None, "lon": None}
        where = rng.random()
        if where < 0.5:
            rec = series[f"rain_station_mm#{sid}"]
            bias = [None] + [rng.choice([rng.uniform(0.5, 1.6), rng.uniform(0.5, 1.6), rng.uniform(0.1, 0.2), rng.uniform(5, 8)]) for _ in range(12)]
            s0 = dt.date.fromisoformat(rec["startDate"])
            cell = [None if (v is None or v < 0) else round(v * bias[(s0 + dt.timedelta(days=i)).month] * rng.uniform(0.6, 1.4), 2) for i, v in enumerate(rec["values"])]
            # Where the station has no reading the cell still rains, now and then with a gap of its own.
            for i, v in enumerate(cell):
                if v is None and rng.random() < 0.9:
                    cell[i] = round(rng.gammavariate(0.4, 6), 2)
            if rng.random() < 0.3:
                a = rng.randrange(len(cell))
                for j in range(a, min(len(cell), a + rng.randint(1, 40))):
                    cell[j] = None
            series[f"rain_chirps_station_mm#{sid}"] = {"startDate": rec["startDate"], "values": cell}
        elif where < 0.85 and farms:
            rs.setdefault("sites", {})[sid] = {"unitId": rng.choice(farms)["id"]}
        if rng.random() < 0.3:
            rec = series[f"rain_station_mm#{sid}"]
            s0 = dt.date.fromisoformat(rec["startDate"])
            periods = []
            for _ in range(rng.randint(1, 2)):
                a = s0 + dt.timedelta(days=rng.randrange(len(rec["values"])))
                periods.append([a.isoformat(), (a + dt.timedelta(days=rng.randint(0, 60))).isoformat()])
            rs.setdefault("unreliable", {})[sid] = periods
    if rng.random() < 0.3:
        stations[rng.choice(ids)]["isCatchmentGauge"] = True

    def assignment() -> dict:
        if rng.random() < 0.04:
            return {"stationId": "no-such-station"}
        a: dict = {"stationId": rng.choice(ids)}
        if rng.random() < 0.15:
            a["scaleToMap"] = False
        if rng.random() < 0.2:
            a["correctAgainst"] = rng.choice(ids)
        return a

    if rng.random() < 0.5:
        rs["catchment"] = assignment() if rng.random() > 0.03 else {"stationId": ""}
        if rng.random() < 0.3:
            rs["catchmentMapMm"] = rng.choice([round(rng.uniform(300, 1500)), round(rng.uniform(300, 1500)), 20000])
            rs["catchmentMapSource"] = "synthetic"
        # The catchment MAP is the farms' mean: give them MAPs, now and then not all of them.
        if not per_unit:
            every = rng.random() < 0.8
            for f in farms:
                if every or rng.random() < 0.5:
                    f["mapMm"] = round(rng.uniform(250, 1500))
                    f["mapSource"] = "synthetic"
    if per_unit:
        units: dict = {}
        for f in farms:
            if (f.get("areaKm2") or 0) > 0 and rng.random() < 0.6:
                units[f["id"]] = assignment()
                key = f"rain_chirps_mm@{f['id']}"
                if key not in series and rng.random() < 0.6:
                    series[key] = _unit_series(rng, start, days, rng.uniform(0.4, 1.5), True)
        if units:
            rs["units"] = units
    if not rs.get("catchment") and not rs.get("units"):
        return
    for a in [rs.get("catchment"), *(rs.get("units") or {}).values()]:
        if not a or rng.random() >= 0.4:
            continue
        if rng.random() < 0.1:
            a["patch"] = []
            continue
        pool = [x for x in ids if rng.random() < 0.7] + (["no-such-station"] if rng.random() < 0.05 else [])
        rng.shuffle(pool)
        patch = [{"source": "station", "stationId": x} for x in pool]
        if rng.random() < 0.75:
            patch.insert(rng.randint(0, len(patch)), {"source": "chirps"})
        if patch and rng.random() < 0.05:
            patch.append(dict(patch[0]))
        a["patch"] = patch
    s["rainStations"] = rs
    doc["stations"] = stations


SABI_SYSTEMS = [("drip", "Drip", 0.9), ("micro", "Micro-sprinkler", 0.82), ("pivot", "Centre pivot / linear move", 0.85), ("sprinkler", "Sprinkler (permanent)", 0.8), ("movable", "Sprinkler (movable)", 0.75), ("surface", "Flood / furrow", 0.7)]


def add_baseflow(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """A unit's base-flow loss and gain (§2.6b, engine >= 1.86.0), from their
    own stream so the rest of a network is unchanged: in 25 % of networks
    (70 % dense), on each unit half the time, a loss, a gain or both, from a
    trickle to more than a day's runoff (so the loss takes all of it some
    days)."""
    if rng.random() >= (0.7 if dense else 0.25):
        return
    for x in doc["model"]["nodes"]:
        if x["kind"] != "farm" or rng.random() >= 0.5:
            continue
        which = rng.randrange(3)
        size = lambda: rng.choice([round(rng.uniform(1, 200), 1), round(rng.uniform(200, 20000)), round(rng.uniform(20000, 500000))])
        if which != 1:
            x["baseflowLossM3Day"] = size()
        if which != 0:
            x["baseflowGainM3Day"] = size()
        # By water-year month (engine >= 1.116.0), a third of the time: a wet-season loss and a dry-season gain.
        if rng.random() < 0.35:
            row = lambda: [rng.choice([0, size()]) for _ in range(12)]
            if which != 1:
                x["baseflowLossMonthlyM3Day"] = row()
            if which != 0:
                x["baseflowGainMonthlyM3Day"] = row()


def add_external_transfers(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """Dam rules out of the catchment (§2.6, engine >= 1.86.0, toNodeId
    null), from their own stream so the rest of a network is unchanged: in
    20 % of networks (50 % dense), a third of the dam rules (never a river
    off-take) sent out instead, and one or two new ones from a unit with a
    dam, some at a rate the dam can't keep up, some above a minimum level."""
    if rng.random() >= (0.5 if dense else 0.2):
        return
    m = doc["model"]
    kind = {x["id"]: x["kind"] for x in m["nodes"]}
    for t in m["transfers"]:
        if t.get("source") != "river" and kind.get(t["fromNodeId"]) == "farm" and rng.random() < 0.35:
            t["toNodeId"] = None
    dams = [x for x in m["nodes"] if x["kind"] == "farm" and x.get("damCapacityM3", 0) > 0]
    if not dams:
        return
    for _ in range(rng.randint(1, 2)):
        src = rng.choice(dams)
        m["transfers"].append({
            "id": _uuid(rng), "fromNodeId": src["id"], "toNodeId": None,
            "months": sorted(rng.sample(range(1, 13), rng.randint(1, 12))),
            "maxRateM3s": rng.choice([round(rng.uniform(0.0001, 0.01), 5), round(rng.uniform(0.01, 0.2), 4)]),
            "dailyCapM3": None if rng.random() < 0.6 else round(rng.uniform(100, 8000)),
            "minStoragePct": rng.choice([0, 0.2, round(rng.uniform(0, 0.6), 2)]),
            "enabled": rng.random() > 0.1, "priority": rng.randint(0, 2),
        })


def add_diversion_curves(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """River off-takes sized by a diversion curve (§2.6a, engine >= 1.113.0), from their own stream so the rest of a
    network is unchanged: a third of the off-takes (two thirds dense) divert a · x^b percent of the river, b either
    side of -1 (-0.9, a canal's shape, among them), a largest share now and then, any of the four flow units,
    the natural flow read a quarter of the time, and now and then an incomplete curve (the rule diverts nothing)."""
    for t in doc["model"]["transfers"]:
        if t.get("source") != "river" or rng.random() >= (0.67 if dense else 0.33):
            continue
        t["sizing"] = "diversionCurve"
        t["diversionCoefficient"] = None if rng.random() < 0.03 else rng.choice([2000, round(10 ** rng.uniform(-2, 5), 4)])
        t["diversionExponent"] = rng.choice([0, -0.9, round(rng.uniform(-1.5, 0.5), 3)])
        t["diversionMaxPct"] = rng.choice([None, 1, 0.95, round(rng.uniform(0.01, 1), 2)])
        t["diversionFlowUnit"] = rng.choice(["L/s", "m3/s", "m3/day", "Ml/day"])
        t["diversionFlowBasis"] = "natural" if rng.random() < 0.25 else rng.choice([None, "modelled"])


def add_monthly_diversions(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """A maximum or a formula by month (§2.6a, engine >= 1.114.0), from its own stream so the rest of a network is
    unchanged: half the rules sized by a curve (two thirds dense) take it month by month instead, each month the
    rule's curve, another curve, or none (a month up to its rate), at least one month a curve; the rule's one curve
    is then emptied. Now and then a month's curve is incomplete (the rule diverts nothing)."""
    for t in doc["model"]["transfers"]:
        if t.get("sizing") != "diversionCurve" or rng.random() >= (0.67 if dense else 0.5):
            continue
        own = {"coefficient": t.get("diversionCoefficient") or 2000, "exponent": t.get("diversionExponent") if t.get("diversionExponent") is not None else -0.9,
               "maxPct": t.get("diversionMaxPct")}
        months = []
        for _ in range(12):
            r = rng.random()
            if r < 0.35:
                months.append(None)
            elif r < 0.7:
                months.append(dict(own))
            else:
                months.append({"coefficient": 0 if rng.random() < 0.02 else round(10 ** rng.uniform(-2, 5), 4),
                               "exponent": rng.choice([0, -0.9, round(rng.uniform(-1.5, 0.5), 3)]),
                               "maxPct": rng.choice([None, 1, round(rng.uniform(0.01, 1), 2)])})
        if all(x is None for x in months):
            months[rng.randrange(12)] = dict(own)
        t["monthlyDiversion"] = months
        t["diversionCoefficient"] = t["diversionExponent"] = t["diversionMaxPct"] = None


def add_transfer_splits(rng: random.Random, doc: dict, dense: bool = False) -> None:
    """Splits between destinations (§2.6, engine >= 1.114.0), from their own stream so the rest of a network is
    unchanged: a third of the rules (two thirds dense) send to two to five destinations, their own first and other
    units after it (a dam rule now and then outside the catchment; a river off-take never to a unit that drains
    back into its source), with random shares adding up to 100 %. Now and then a split the run can't use (the shares
    off, or a destination twice): it runs as all of it to the first."""
    m = doc["model"]
    by_id = {x["id"]: x for x in m["nodes"]}
    farms = [x["id"] for x in m["nodes"] if x["kind"] == "farm"]
    succ = {x["id"]: ({x["downstreamNodeId"]} if x["downstreamNodeId"] else set()) for x in m["nodes"]}
    for t in m["transfers"]:
        if t.get("source") == "river" and t.get("toNodeId") in succ:
            succ[t["fromNodeId"]].add(t["toNodeId"])

    def reach(a, b):
        st, seen = [a], set()
        while st:
            k = st.pop()
            if k == b:
                return True
            if k in seen:
                continue
            seen.add(k)
            st.extend(succ.get(k, ()))
        return False

    for t in m["transfers"]:
        if t["fromNodeId"] not in by_id or rng.random() >= (0.67 if dense else 0.33):
            continue
        river = t.get("source") == "river"
        want = rng.randint(2, 5)
        ends = [t.get("toNodeId")]
        pool = [f for f in farms if f != t["fromNodeId"] and f not in ends and not (river and reach(f, t["fromNodeId"]))]
        rng.shuffle(pool)
        while len(ends) < want and (pool or (not river and None not in ends)):
            if not river and None not in ends and (not pool or rng.random() < 0.15):
                ends.append(None)
            else:
                ends.append(pool.pop())
        if len(ends) < 2:
            continue
        if river:
            for e in ends[1:]:
                succ[t["fromNodeId"]].add(e)
        w = [rng.uniform(0.05, 1) for _ in ends]
        tot = sum(w)
        dest = [{"nodeId": e, "pct": x / tot} for e, x in zip(ends, w)]
        r = rng.random()
        if r < 0.04:
            dest[0]["pct"] *= 0.5
        elif r < 0.07:
            dest[1]["nodeId"] = dest[0]["nodeId"]
        t["destinations"] = dest


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
                "sortOrder": len(nodes), "areaKm2": 0,
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
        # By water-year month (engine >= 1.116.0): on a third of those nodes a share and/or a cap row, some months
        # 0, so the reach loses on some days only and a senior claim is grossed up by the day's month.
        for x in nodes:
            if not x.get("reachLossFrac") or rng.random() >= 0.35:
                continue
            which = rng.randrange(3)
            if which != 1:
                x["reachLossFracMonthly"] = [rng.choice([0, round(rng.uniform(0, 0.5), 3), 1, 0.8]) for _ in range(12)]
            if which != 0:
                x["reachLossMaxMonthlyM3Day"] = [rng.choice([0, round(rng.uniform(10, 500)), round(rng.uniform(500, 50000))]) for _ in range(12)]


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
