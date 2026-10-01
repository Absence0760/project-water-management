"""Hand-built inputs that pin the points the documentation left open until
this cross-check (verify/README.md § Findings). Each one was worked out by
hand for the documented reading and for the plausible other readings, and
the engine's output picked the documented one; diff.py runs them on every
`pnpm test:verify`, and test_verify.py's mutants show each one sees the
difference. All data is invented.
"""

from __future__ import annotations

import datetime as dt


def _node(i: str, kind: str, down: str | None, **kw) -> dict:
    n = {
        "id": i, "name": i, "kind": kind, "downstreamNodeId": down, "sortOrder": 0, "areaKm2": 0, "areaHiKm2": 0,
        "areaLoKm2": 0, "flowShareManual": None, "pctUpstreamToDam": 0, "pctRunoffToDam": 0, "damCapacityM3": 0,
        "damInitialPct": 0, "damMinPct": 0, "divertCapacityM3Day": 0, "irrigationEfficiency": 1,
        "lossReturnFraction": 0, "damAreaFullM2": 1, "damAreaExponent": 0.7, "damSeepagePerDay": 0,
    }
    n.update(kw)
    return n


def _settings(**kw) -> dict:
    s = {
        "runoffModel": "gr4j",
        "apanMm": [100] * 12,
        "panCoefficient": [0.7] * 12,
        "gr4j": {"x1": 350, "x2": 0, "x3": 90, "x4": 1.7, "warmupDays": 0},
        "lakeEvapFactor": 0,
        "ewrPragmaticM3PerDay": [0] * 12,
        "effectiveRainStoreMm": 0,
    }
    s.update(kw)
    return s


def _rule(i, a, b, rate_m3_day, reserve, priority=0) -> dict:
    return {
        "id": i, "fromNodeId": a, "toNodeId": b, "months": list(range(1, 13)), "maxRateM3s": rate_m3_day / 86400,
        "dailyCapM3": None, "minStoragePct": reserve, "enabled": True, "priority": priority,
    }


def _dry(days: int, start="2020-01-01") -> dict:
    return {"rain_catchment_mm": {"startDate": start, "values": [0.0] * days}}


def band_and_room() -> dict:
    """One priority, one source dam (1 000 m³, full): rule a keeps 50 % and
    may send 400 m³/day into a receiver with 100 m³ of room; rule b keeps 0 %
    and may send 800 m³/day into an empty dam. The receiver's room is shared
    first (a wants 100), then the source's bands: 1 000–500 m³ is shared
    100 : 800 (a 55.6, b 444.4), 500–0 m³ goes to b (355.6 more), so a moves
    55.6 and b 800. Bands first and the room after would give a 100."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=1),
        _node("x", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=0.9),
        _node("y", "farm", "o", areaKm2=1, damCapacityM3=100000, damInitialPct=0),
    ]
    rules = [_rule("ra", "s", "x", 400, 0.5), _rule("rb", "s", "y", 800, 0.0)]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": rules}, "series": _dry(5)}


def room_while_sending() -> dict:
    """A full receiver that also sends at a lower priority the same day: its
    room is counted from yesterday's storage (§2.6: cap − storage[t−1] …), so
    what it sends first does not make room for what it receives."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=1),
        _node("x", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=1),
        _node("y", "farm", "o", areaKm2=1, damCapacityM3=100000, damInitialPct=0),
    ]
    rules = [_rule("r1", "x", "y", 300, 0.0, priority=0), _rule("r2", "s", "x", 300, 0.0, priority=1)]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": rules}, "series": _dry(5)}


def accumulation_window_run() -> dict:
    """A 60 mm reading after 150 days of zeros. Bias-corrected CHIRPS has
    100 mm early in the run but only 10 mm in its last 92 days, and none on
    the reading day or either side of it. The run test reads the window's
    run days (at most 92), so this is no accumulation and the 60 mm stays on
    its day; reading the whole run would spread it."""
    days = 200
    reading = 170
    catch = [0.0] * days
    catch[reading] = 60.0
    for j in range(reading + 1, days):
        catch[j] = 1.0
    ch = [0.0] * days
    for j in range(reading - 150, reading - 130):
        ch[j] = 5.0  # 100 mm, outside the last 92 days
    for j in range(reading - 60, reading - 50):
        ch[j] = 1.0  # 10 mm inside them
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": catch},
        "rain_chirps_mm": {"startDate": "2020-01-01", "values": ch},
    }
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def low_vs_chirps_median() -> dict:
    """Eight judged water years with catchment/CHIRPS ratios 0.52, 0.57, 0.9,
    1.0, 1.2, 1.3, 1.4 and 1.5. The usual ratio is their median, the mean of
    the middle two (1.1), so only 0.52 is below half of it and left out of the
    CHIRPS fit (the lower middle would leave out neither, the upper both).
    Each year has a blank fortnight, so the factors show in the filled rain."""
    ratios = [0.52, 0.57, 0.9, 1.0, 1.2, 1.3, 1.4, 1.5]
    start = dt.date(2010, 10, 1)
    end = dt.date(2010 + len(ratios), 9, 30)
    days = (end - start).days + 1
    catch: list = []
    ch: list = []
    for k in range(days):
        d = start + dt.timedelta(days=k)
        wy = d.year if d.month >= 10 else d.year - 1
        r = ratios[wy - 2010]
        c = 2.0 + (k % 5)
        catch.append(None if (d.month == 3 and d.day <= 14) else c)
        ch.append(c / r)
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": catch},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": ch},
    }
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def negative_reading() -> dict:
    """A negative catchment reading is still a reading: it blocks the CHIRPS
    fallback, shows as recorded in rain_final and runs as 0 mm (GR4J, demand
    and rain on the dam)."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5, damCapacityM3=20000, damInitialPct=0.5, damAreaFullM2=8000)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": [1.0, -3.0, None, 4.0, 0.0]},
        "rain_chirps_mm": {"startDate": "2020-01-01", "values": [9.0, 10.0, 11.0, 12.0, 13.0]},
    }
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def zero_catchment_area() -> dict:
    """Farms without area and no catchmentAreaKm2: GR4J has no area to turn
    millimetres into m³, so the run is refused."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=0)]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": _dry(5)}


def binding_site_tie() -> dict:
    """One farm upstream of a gauge that is an EWR site and of the outlet,
    with the same EWR at both (its share is 1) and the same flow: equal
    charges, so the binding site is the most downstream one, the outlet
    (index 0 in ewr_binding_site)."""
    nodes = [
        _node("o", "gauge", None),
        _node("g", "gauge", "o"),
        _node("f", "farm", "g", areaKm2=5, damCapacityM3=50000, damInitialPct=1, pctRunoffToDam=1),
    ]
    crops = [{"id": "c", "name": "c", "cropFactor": [1.0] * 12}]
    areas = [{"nodeId": "f", "cropId": "c", "areaM2": 500000}]
    rain = [0.0, 30.0, 5.0] + [0.0] * 27
    s = _settings(ewrPragmaticM3PerDay=[20000] * 12)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": []},
            "series": {"rain_catchment_mm": {"startDate": "2020-01-01", "values": rain}}}


def forecast_tail_warmup() -> dict:
    """40 days of recorded rain, then 6 days of forecast rain, and a 365-day
    warm-up: the warm-up cycles the 40 historical days only, never the
    forecast tail (§2.4a, §2.4f)."""
    rain = [0.0, 12.0, 3.0, 0.0, 25.0, 0.0, 0.0, 8.0] * 5
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": rain},
        "rain_forecast_mm": {"startDate": "2020-02-10", "values": [40.0, 30.0, 20.0, 60.0, 10.0, 5.0]},
    }
    s = _settings(gr4j={"x1": 200, "x2": 0, "x3": 60, "x4": 1.5, "warmupDays": 365})
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def scaled_no_demand_tail_year() -> dict:
    """A full allocation on a farm with no demand at all, over two water
    years, the second ending in a six-day forecast tail. Neither year can be
    scaled; the summary's row for each lists the volume registered over the
    days it would have been scaled on: the ordinary year's run days, the
    historical days of the year the tail starts in (§2.12a; engine ≥ 1.57.0,
    before which that year listed k × its demand, 0)."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5, damCapacityM3=0)]
    alloc = [{
        "id": "a", "nodeId": "f", "waterSource": "surface", "volumeM3PerYear": 36500, "storageM3": None,
        "validFrom": None, "validTo": None, "months": [], "maxRateM3s": None,
    }]
    start = dt.date(2019, 10, 1)
    hist = (dt.date(2021, 3, 31) - start).days + 1
    series = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": [float(k % 4) for k in range(hist)]},
        "rain_forecast_mm": {"startDate": "2021-04-01", "values": [3.0, 0.0, 5.0, 0.0, 1.0, 2.0]},
    }
    s = _settings(allocationMode="fullAllocation")
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": [], "allocations": alloc},
            "series": series}


def full_allocation_tail_new_year() -> dict:
    """A full allocation whose forecast tail starts on 26 September and runs
    into the next water year: the tail's September days keep the factor of
    the year it started in (over that year's historical days), while its
    October days are a part year of their own, scaled to the volume
    prorated over them (§2.12a, §2.4f)."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    crops, areas = _crop("f", 200000)
    alloc = [{
        "id": "a", "nodeId": "f", "waterSource": "surface", "volumeM3PerYear": 36500, "storageM3": None,
        "validFrom": None, "validTo": None, "months": [], "maxRateM3s": None,
    }]
    start = dt.date(2019, 10, 1)
    hist = (dt.date(2020, 9, 25) - start).days + 1
    series = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": [float(k % 7 == 0) * 6 for k in range(hist)]},
        "rain_forecast_mm": {"startDate": "2020-09-26", "values": [0.0, 2.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]},
    }
    s = _settings(allocationMode="fullAllocation", apanMm=[150] * 12)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": [], "allocations": alloc},
            "series": series}


# Coverage probes: rules the docs settle but random networks rarely reach in
# a way a one-line change would show; each has a mutant in test_verify.py.


def _steady(days: int, mm: float, start="2020-01-01") -> dict:
    return {"rain_catchment_mm": {"startDate": start, "values": [mm] * days}}


def _crop(node: str, m2: float) -> tuple[list, list]:
    return [{"id": "c", "name": "c", "cropFactor": [1.0] * 12}], [{"nodeId": node, "cropId": "c", "areaM2": m2}]


def trigger_hysteresis() -> dict:
    """A trigger farm (§2.7e) whose dam starts below its 40 % trigger and
    rises while the pump covers most of the demand: the river pump stays on
    until the dam holds 70 % (the stop level), not only while it is below
    the trigger."""
    nodes = [
        _node("o", "gauge", None),
        _node("f", "farm", "o", areaKm2=1, damCapacityM3=20000, damInitialPct=0.35, pctRunoffToDam=0.05,
              supplyRule="trigger", supplyTriggerPct=0.4, supplyStopPct=0.7, pumpCapacityM3Day=300),
    ]
    crops, areas = _crop("f", 120000)
    s = _settings(effectiveRainFraction=0)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": []}, "series": _steady(90, 20.0)}


def junior_user() -> dict:
    """A junior water user (§2.7c) above a senior one on the same reach
    takes only what the river carries beyond the senior's requirement."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "user", "o", userDemandM3Day=[3000] * 12, userPriority="senior", userReturnPct=0),
        _node("j", "user", "s", userDemandM3Day=[3000] * 12, userPriority="junior", userReturnPct=0),
        _node("f", "farm", "j", areaKm2=2),
    ]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": _steady(60, 8.0)}


PROBES = {
    "forecast-tail-warmup": forecast_tail_warmup(),
    "band-and-room": band_and_room(),
    "room-while-sending": room_while_sending(),
    "accumulation-window-run": accumulation_window_run(),
    "low-vs-chirps-median": low_vs_chirps_median(),
    "negative-reading": negative_reading(),
    "zero-catchment-area": zero_catchment_area(),
    "binding-site-tie": binding_site_tie(),
    "scaled-no-demand-tail-year": scaled_no_demand_tail_year(),
    "full-allocation-tail-new-year": full_allocation_tail_new_year(),
    "trigger-hysteresis": trigger_hysteresis(),
    "junior-user": junior_user(),
}
