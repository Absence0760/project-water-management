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
        "id": i, "name": i, "kind": kind, "downstreamNodeId": down, "sortOrder": 0, "areaKm2": 0,
        "pctUpstreamToDam": 0, "pctRunoffToDam": 0, "damCapacityM3": 0,
        "damInitialPct": 0, "damMinPct": 0, "divertCapacityM3Day": 0, "irrigationEfficiency": 1,
        "returnFlowFraction": 0, "damAreaFullM2": 1, "damAreaExponent": 0.7, "damSeepagePerDay": 0,
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
    """A 60 mm reading after 150 blank days (an outage). Bias-corrected
    CHIRPS has 100 mm early in the outage but only 10 mm in its last 92
    days, and none on the reading day or either side of it. The run test
    reads the outage's last 92 days, so the reading is not set aside and the
    60 mm stays on its day; reading the whole outage would set it aside.
    (Up to engine 1.83.0 this probe was 150 zeros and a window's run; since
    1.84.0 zeros are no run and a window's run is at most 7 blank days, so
    the 92-day limit bounds only an outage.)"""
    days = 200
    reading = 170
    catch = [None] * days
    for j in range(reading - 150):
        catch[j] = 0.0
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


def priority_user_fixed_restriction() -> dict:
    """A Priority user's fixed restriction % (§2.7c, engine 1.86.0, issue #523
    B3) with no drought restriction rule: it acts only in the curtailment table
    and under the rule (§2.7i), both outside this cross-check, so every daily
    series is the user's without it: it takes its whole demand, and the farm
    upstream passes its whole claim."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "user", "o", userDemandM3Day=[3000] * 12, userPriority="senior", userReturnPct=0, userRestrictionPct=0.4),
        _node("f", "farm", "s", areaKm2=2, damCapacityM3=50000, damInitialPct=0.5, pctUpstreamToDam=1, pctRunoffToDam=1),
    ]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": _steady(60, 8.0)}


def offtake_keep_bands() -> dict:
    """Three river off-takes of one priority from one farm (§2.6a): two keep a
    hands-off flow of 2 000 m³/day, the third keeps nothing and may take
    1 m³/day. The flow between two successive keeps goes to the rules keeping
    that much or less, so the two never leave the river below 2 000 m³/day
    beside the third's 1 m³ (scaled to the flow above the lowest keep, they
    took down to 2 × 2 000 − the flow). The rain rises over the run, so the
    flow crosses the keep on some days and twice it on others."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=3),
        _node("d1", "farm", "o", areaKm2=0.1),
        _node("d2", "farm", "o", areaKm2=0.1),
        _node("d3", "farm", "o", areaKm2=0.1),
    ]

    def ot(i, b, m3_day, hands_off):
        return {
            "id": i, "fromNodeId": "s", "toNodeId": b, "months": list(range(1, 13)), "maxRateM3s": m3_day / 86400,
            "dailyCapM3": None, "minStoragePct": 0, "enabled": True, "priority": 0, "source": "river",
            "handsOffM3Day": hands_off, "handsOffEwr": False, "lossPct": 0, "sizing": "capacity", "topUpDam": False,
        }

    transfers = [ot("b1", "d1", 20000, 2000), ot("b2", "d2", 20000, 2000), ot("c", "d3", 1, None)]
    days = 150
    series = {"rain_catchment_mm": {"startDate": "2020-01-01", "values": [round(0.2 * k, 1) for k in range(days)]}}
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": transfers}, "series": series}


def cap_before_licence() -> dict:
    """An allocation cap (§2.12a) on a farm whose only surface licence starts
    on 1 October 2020, the second of two water years: the first year has none
    of its allocations in force, so it isn't capped (engine >= 1.70.0; before,
    its budget was 0 and the farm took nothing), and its room column is blank.
    The dam starts full and holds far more than the crop asks, so the cap is
    all that limits the second year."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=1, damCapacityM3=1e7, damInitialPct=1)]
    crops, areas = _crop("f", 100000)
    alloc = [{
        "id": "a", "nodeId": "f", "waterSource": "surface", "volumeM3PerYear": 20000, "storageM3": None,
        "validFrom": "2020-10-01", "validTo": None, "months": [], "maxRateM3s": None,
    }]
    s = _settings(allocationMode="cap", effectiveRainFraction=0)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": [], "allocations": alloc},
            "series": _dry(731, "2019-10-01")}


def cap_licence_from_september() -> dict:
    """An allocation cap (§2.12a) whose only licence starts on 1 September 2020,
    the last month of the run's first water year, and a second that ends on
    31 March 2022: the cap holds only on the days a licence is in force, and
    the use on the other days of the year doesn't count against its prorated
    budget (engine >= 1.70.0). Before, October-August's use spent September's
    30/365 share, so September took nothing. The dam is large and full."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=1, damCapacityM3=1e7, damInitialPct=1)]
    crops, areas = _crop("f", 100000)
    alloc = [
        {"id": "a", "nodeId": "f", "waterSource": "surface", "volumeM3PerYear": 30000, "storageM3": None,
         "validFrom": "2020-09-01", "validTo": "2022-03-31", "months": [], "maxRateM3s": None},
    ]
    s = _settings(allocationMode="cap", effectiveRainFraction=0)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": [], "allocations": alloc},
            "series": _dry(1096, "2019-10-01")}


def full_allocation_gap_year() -> dict:
    """A full allocation (§2.12a) with one licence to 30 September 2020 and one
    from 1 October 2021: the 2020/21 water year between them has none in force,
    so the farm keeps its modelled demand there (factor 1, engine >= 1.70.0;
    before, 0, and the summary listed it scaled to 0 m³)."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5, damCapacityM3=1e7, damInitialPct=1)]
    crops, areas = _crop("f", 200000)
    alloc = [
        {"id": "a", "nodeId": "f", "waterSource": "surface", "volumeM3PerYear": 20000, "storageM3": None,
         "validFrom": None, "validTo": "2020-09-30", "months": [], "maxRateM3s": None},
        {"id": "b", "nodeId": "f", "waterSource": "groundwater", "volumeM3PerYear": 15000, "storageM3": None,
         "validFrom": "2021-10-01", "validTo": None, "months": [], "maxRateM3s": None},
    ]
    s = _settings(allocationMode="fullAllocation", apanMm=[150] * 12, effectiveRainFraction=0)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": [], "allocations": alloc},
            "series": _dry(1096, "2019-10-01")}


def offtake_into_capped_unit() -> dict:
    """A demand-sized river off-take with 20 % losses into a farm under an
    allocation cap of 6 000 m³ a year at most 150 m³/day (§2.6a, §2.12a): the
    rule sizes to the demand the cap still allows, MIN(demand, the room), and
    grosses that up for the losses (engine >= 1.70.0; before, it sized to the
    whole demand, the rest flowed on below the farm and its losses left the
    catchment). The room runs out partway through."""
    nodes = [_node("o", "gauge", None), _node("s", "farm", "o", areaKm2=3), _node("d", "farm", "o", areaKm2=0.1)]
    crops, areas = _crop("d", 100000)
    alloc = [{
        "id": "a", "nodeId": "d", "waterSource": "surface", "volumeM3PerYear": 6000, "storageM3": None,
        "validFrom": None, "validTo": None, "months": [], "maxRateM3s": 150 / 86400,
    }]
    transfers = [{
        "id": "c", "fromNodeId": "s", "toNodeId": "d", "months": list(range(1, 13)), "maxRateM3s": 5000 / 86400,
        "dailyCapM3": None, "minStoragePct": 0, "enabled": True, "priority": 0, "source": "river",
        "handsOffM3Day": None, "handsOffEwr": False, "lossPct": 0.2, "sizing": "demand", "topUpDam": False,
    }]
    s = _settings(allocationMode="cap", effectiveRainFraction=0)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": transfers, "allocations": alloc},
            "series": _steady(90, 6.0, "2020-10-01")}


def outage_reading_set_aside() -> dict:
    """A 30 mm reading after 150 blank days (a logger back from a fault,
    issue #393 item 11 (b)). Bias-corrected CHIRPS rains 2 mm a day over the
    outage and nothing on the reading day or either side of it. Engine
    ≥ 1.70.0: more than 7 blank days end the run, so there is no window; the
    reading passes the tests read over the outage's last 92 days and is set
    aside: CHIRPS fills its day (0 mm) and the outage alike. Spreading it
    (≤ 1.69.0) would put 30 mm over 93 days in place of ~184 mm of CHIRPS;
    keeping it would put 30 mm on the reading day."""
    days = 200
    reading = 170
    catch = [None] * days
    for j in range(reading - 150):
        catch[j] = 0.0
    catch[reading] = 30.0
    for j in range(reading + 1, days):
        catch[j] = 1.0
    ch = [0.0] * days
    for j in range(reading - 150, reading - 1):
        ch[j] = 2.0
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": catch},
        "rain_chirps_mm": {"startDate": "2020-01-01", "values": ch},
    }
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def short_blank_run_window() -> dict:
    """A 40 mm reading after 4 zeros and 7 blank days (a holiday gauge): the
    blank stretch is 7 days, not more, so it is a run, and (engine ≥ 1.84.0)
    only those 7 blanks after the last 0: the 8-day window is spread by
    CHIRPS (4 mm a day over the gap, none on the reading day ± 1). With 8
    blanks it would be an outage and the reading would be set aside instead;
    counting the zeros too (up to 1.83.0) would make 11 days, an outage
    under that mutant."""
    days = 60
    reading = 30
    catch = [0.0] * days
    for j in range(reading - 7, reading):
        catch[j] = None
    catch[reading] = 40.0
    ch = [0.0] * days
    for j in range(reading - 11, reading - 1):
        ch[j] = 4.0
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": catch},
        "rain_chirps_mm": {"startDate": "2020-01-01", "values": ch},
    }
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def flagged_zero_run_outage() -> dict:
    """A 40 mm reading after a 200-day zero run that §2.4c flags (no
    climatology in a 400-day record, so 180 days in any season) and fills
    from CHIRPS (3 mm a day over the run, none on the reading day or either
    side). Engine ≥ 1.84.0 (issue #523 A2, provisional): the flagged zeros
    read as blank for §2.4d, so more than 7 of them are an outage and the
    reading is set aside: CHIRPS fills its day (0 mm) like the run's. Kept as
    a reading the zeros would end the run, and the 40 mm would stay on its
    day beside the run's CHIRPS fill, counting that rain twice."""
    days = 400
    reading = 200
    catch = [0.0] * reading + [40.0] + [1.0] * (days - reading - 1)
    ch = [3.0] * (reading - 1) + [0.0] * 3 + [0.0] * (days - reading - 2)
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": catch},
        "rain_chirps_mm": {"startDate": "2020-01-01", "values": ch},
    }
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def offtake_release_keep_and_floor() -> dict:
    """Engine 1.70.0 (issue #90 Q26, Q27; §2.6a). (1) An off-take of up to
    20 000 m³/day from a farm whose dam (off the river, nothing flows into it)
    has a pass-inflow release targeting 1 500 m³/day leaves the target in the
    river: it takes only the flow above 1 500. The rain rises over the run, so
    the flow crosses the target on some days and is well above it on others.
    (2) A demand-sized off-take from a larger source tops up a 5 000 m³ dam
    held near its dead storage (2 750, dead 2 500) with a fixed release of
    400 m³/day: its room counts the release in full, 5 000 − 2 750 + 400, so
    the dam ends the first day full (the floor, MIN(400, 2 750 − 2 500) = 250,
    would leave it 150 short)."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=3, damCapacityM3=1000, damInitialPct=1, damReleaseRule="passInflow", damReleaseM3Day=[1500] * 12),
        _node("c", "farm", "o", areaKm2=0.1),
        _node("s2", "farm", "o", areaKm2=30),
        _node("d", "farm", "o", areaKm2=0.1, damCapacityM3=5000, damInitialPct=0.55, damMinPct=0.5, damReleaseRule="fixed", damReleaseM3Day=[400] * 12),
    ]

    def ot(i, a, b, sizing, top_up):
        return {
            "id": i, "fromNodeId": a, "toNodeId": b, "months": list(range(1, 13)), "maxRateM3s": 20000 / 86400,
            "dailyCapM3": None, "minStoragePct": 0, "enabled": True, "priority": 0, "source": "river",
            "handsOffM3Day": None, "handsOffEwr": False, "lossPct": 0, "sizing": sizing, "topUpDam": top_up,
        }

    transfers = [ot("t", "s", "c", "capacity", False), ot("u", "s2", "d", "demand", True)]
    days = 150
    series = {"rain_catchment_mm": {"startDate": "2020-01-01", "values": [round(0.2 * k, 1) for k in range(days)]}}
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": transfers}, "series": series}


def dam_rules_rationing_and_release() -> dict:
    """Engine 1.70.0 (issue #90 Q25, Q26; §2.6): two dam rules of one priority
    from a 5 000 m³ dam that runs dry, limits 3 000 and 1 000: they share what
    is left 3 : 1 (each asks its limit, never capped at the free water, which
    would make it 1 : 1 on the second day). A third rule fills a 1 000 m³ dam
    held near its dead storage (500, dead 400) that releases 300 m³/day: its
    room counts the release in full, 1 000 − 500 + 300 = 800, so the dam ends
    full (the floor, MIN(300, 500 − 400) = 100, would leave it at 800). And
    (engine 1.70.0's rounds) an empty source beside a full one into one
    receiver: the full one fills the room; one source into three receivers
    whose rooms fill one after another: the water a filled receiver couldn't
    take is offered to the others again, twice over."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=1, damCapacityM3=5000, damInitialPct=1),
        _node("a", "farm", "o", damCapacityM3=1e6),
        _node("b", "farm", "o", damCapacityM3=1e6),
        _node("s2", "farm", "o", damCapacityM3=1e6, damInitialPct=1),
        _node("d", "farm", "o", damCapacityM3=1000, damInitialPct=0.5, damMinPct=0.4, damReleaseRule="fixed", damReleaseM3Day=[300] * 12),
    ]
    # An empty source beside a full one into one receiver (room 400): the full one fills it. One source of 900
    # into rooms of 100, 350 and 2 000: room a source couldn't fill is offered again, twice (100, 350, 450).
    nodes += [
        _node("e1", "farm", "o", damCapacityM3=1000, damInitialPct=0),
        _node("e2", "farm", "o", damCapacityM3=5000, damInitialPct=1),
        _node("r", "farm", "o", damCapacityM3=1000, damInitialPct=0.6),
        _node("w", "farm", "o", damCapacityM3=900, damInitialPct=1),
        _node("r1", "farm", "o", damCapacityM3=1000, damInitialPct=0.9),
        _node("r2", "farm", "o", damCapacityM3=1000, damInitialPct=0.65),
        _node("r3", "farm", "o", damCapacityM3=5000, damInitialPct=0.6),
    ]
    transfers = [
        _rule("ta", "s", "a", 3000, 0), _rule("tb", "s", "b", 1000, 0), _rule("td", "s2", "d", 100000, 0),
        _rule("te1", "e1", "r", 300, 0), _rule("te2", "e2", "r", 500, 0),
        _rule("tw1", "w", "r1", 1000, 0), _rule("tw2", "w", "r2", 1000, 0), _rule("tw3", "w", "r3", 1000, 0),
    ]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": transfers}, "series": _dry(4)}


def transfer_out_of_catchment() -> dict:
    """Engine 1.86.0 (issue #523 B5, §2.6): a dam rule out of the catchment
    (toNodeId null) runs as any dam rule, but no unit receives it, so it has
    no room to fill. From a full 1 000 m³ dam keeping 50 %: rule xo (out, 300
    m³/day) and rule xi (into x's empty dam, 300 m³/day) share the 500 m³
    above the reserve pro rata, 250 each on day 0, nothing after. A second
    source t (1 000 m³, full) sends out at priority 0, 400 m³/day keeping 20 %,
    and into y (room 100) at priority 1: day 0 out 400 and y 100 (its room);
    day 1 out the 300 left above the reserve, y nothing (no room, none free)."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=1),
        _node("x", "farm", "o", areaKm2=1, damCapacityM3=100000, damInitialPct=0),
        _node("t", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=1),
        _node("y", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=0.9),
    ]
    rules = [
        _rule("xo", "s", None, 300, 0.5),
        _rule("xi", "s", "x", 300, 0.5),
        _rule("to", "t", None, 400, 0.2),
        _rule("ty", "t", "y", 400, 0.2, priority=1),
    ]
    return {"settings": _settings(), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": rules}, "series": _dry(4)}


def transfer_out_of_catchment_cap() -> dict:
    """Engine-audit.md X1 (decided 2026-10-12): water pumped out of the
    catchment is its source unit's surface use, so under an allocation cap it
    is held to the source's surface room. s (1 000 m³, full, keeping 50 %) has
    250 m³ a year. Priority 0: the source shares its 500 m³ above the reserve
    among xo1 out (100 m³/day), xo2 out (300) and xi into x's empty dam (300);
    the two rules out share the 250 of room 1 : 3 (62.5 and 187.5), and xi
    (water into a dam is not use) gets the 250 m³ of dam water they leave.
    Priority 1: xo3 out 50 m³/day finds no room left, and from day 1 nothing
    moves out of s (the room is spent). t (2 000 m³, full, keeping 20 %) has
    1 000 m³ a year: its rule out (100 m³/day) runs ten days, until the volume
    is spent, with 600 m³ still above its reserve."""
    nodes = [
        _node("o", "gauge", None),
        _node("s", "farm", "o", areaKm2=1, damCapacityM3=1000, damInitialPct=1, pctUpstreamToDam=1),
        _node("x", "farm", "o", areaKm2=1, damCapacityM3=100000, damInitialPct=0),
        _node("t", "farm", "o", areaKm2=1, damCapacityM3=2000, damInitialPct=1, pctUpstreamToDam=1),
    ]
    rules = [
        _rule("xo1", "s", None, 100, 0.5),
        _rule("xo2", "s", None, 300, 0.5),
        _rule("xi", "s", "x", 300, 0.5),
        _rule("xo3", "s", None, 50, 0.5, priority=1),
        _rule("to", "t", None, 100, 0.2),
    ]
    alloc = [
        {"id": "as", "nodeId": "s", "waterSource": "surface", "volumeM3PerYear": 250, "storageM3": None,
         "validFrom": None, "validTo": None, "months": [], "maxRateM3s": None},
        {"id": "at", "nodeId": "t", "waterSource": "surface", "volumeM3PerYear": 1000, "storageM3": None,
         "validFrom": None, "validTo": None, "months": [], "maxRateM3s": None},
    ]
    return {"settings": _settings(allocationMode="cap"), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": rules, "allocations": alloc},
            "series": _dry(14, "2020-10-01")}


# Runoff from each unit's own rain (§2.4h, engine >= 1.78.0).


def _wave(start: dt.date, n: int, k: int, scale: float = 1.0) -> list:
    """Invented daily rain: a wet day every few days, a different depth each
    year, so annual totals differ from year to year."""
    out = []
    for i in range(n):
        d = start + dt.timedelta(days=i)
        out.append(round(scale * ((i * 7 + k) % 11) * (1 + 0.3 * (d.year % 4)), 1) if (i + k) % 3 == 0 else 0.0)
    return out


def unit_rain_rules() -> dict:
    """Eleven years of rain and eight farms under per-unit rain (gauge MAP
    600 mm), one per point of the forcing rule: u1 its own gauge (gaps filled
    by its CHIRPS at its MAP, then the gauge × its MAP ratio, then the
    catchment's rain × the ratio); u2 the gauge × a MAP ratio clamped to 4,
    its CHIRPS filling the gauge's gap and its negative reading not (the
    reading runs as 0); u3 its CHIRPS at its MAP, u8 at a MAP factor clamped
    to 4; u4 its CHIRPS without a MAP
    (the catchment's monthly factors); u5 a MAP but no complete CHIRPS year
    (the factors too); u6 an own gauge with only negative values (no reading:
    rule 2, the gauge × the ratio before its CHIRPS); u7 nothing of its own (the catchment forcing);
    z a farm without area with a gauge of its own (not a land unit). A
    six-day forecast tail ends the run: × the ratio on u1, u2 and u6, × 1 on
    the rest. catchmentAreaKm2 is ignored (the units' areas sum). The MAP
    period, 2010–2019, holds ten of the eleven complete years (issue #500
    item 4's minimum): u3's CHIRPS MAP factor averages those ten only, while
    u1's and u2's CHIRPS, with a gap in 2015, have nine there and average
    every complete year of the record."""
    start = dt.date(2009, 1, 1)
    k = (dt.date(2014, 1, 1) - start).days + 1  # the 2014 indices below from 2009, a multiple of 3 so _wave's wet days stay put
    n = (dt.date(2019, 12, 31) - start).days + 1
    catch: list = _wave(start, n, 0)
    for j in range(k + 400, k + 420):
        catch[j] = None
    catch[k + 602] = -3.0  # u2's CHIRPS rains that day
    catch[k + 603] = 12.0
    chirps = [round(v * 0.8, 2) for v in _wave(start, n, 1)]
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": catch},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": chirps},
        "rain_forecast_mm": {"startDate": "2020-01-01", "values": [4.0, 0.0, 9.0, 1.0, 0.0, 6.0]},
    }
    own1: list = _wave(start, n, 2, 1.3)
    for j in list(range(k + 100, k + 130)) + list(range(k + 395, k + 425)):
        own1[j] = None
    own1[k + 705] = -2.0  # a no-data code on a day u1's CHIRPS rains
    ch1: list = _wave(start, n, 3, 0.9)
    for j in range(k + 390, k + 410):
        ch1[j] = None
    ch2: list = _wave(start, n, 4, 1.1)
    for j in range(k + 405, k + 415):
        ch2[j] = None
    ch5: list = _wave(start, n, 5)
    for y in range(11):
        ch5[y * 365 + 100] = None
    series["rain_catchment_mm@u1"] = {"startDate": start.isoformat(), "values": own1}
    series["rain_chirps_mm@u1"] = {"startDate": start.isoformat(), "values": ch1}
    series["rain_chirps_mm@u2"] = {"startDate": start.isoformat(), "values": ch2}
    series["rain_chirps_mm@u3"] = {"startDate": start.isoformat(), "values": _wave(start, n, 6, 0.7)}
    series["rain_chirps_mm@u4"] = {"startDate": start.isoformat(), "values": _wave(start, n, 7, 1.2)}
    series["rain_chirps_mm@u5"] = {"startDate": start.isoformat(), "values": ch5}
    series["rain_catchment_mm@u6"] = {"startDate": start.isoformat(), "values": [-9999.0] * 50}
    series["rain_chirps_mm@u6"] = {"startDate": start.isoformat(), "values": _wave(start, n, 9, 0.6)}
    series["rain_chirps_mm@u8"] = {"startDate": start.isoformat(), "values": _wave(start, n, 10)}
    series["rain_catchment_mm@z"] = {"startDate": start.isoformat(), "values": _wave(start, n, 8, 3)}
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("u1", "farm", "o", areaKm2=3, mapMm=800, **src),
        _node("u2", "farm", "u1", areaKm2=2, mapMm=3000, **src),
        _node("u3", "farm", "o", areaKm2=4, mapMm=900, **src),
        _node("u4", "farm", "o", areaKm2=1.5),
        _node("u5", "farm", "o", areaKm2=2.5, mapMm=700, **src),
        _node("u6", "farm", "o", areaKm2=1, mapMm=450, **src),
        _node("u7", "farm", "o", areaKm2=5),
        _node("u8", "farm", "o", areaKm2=0.5, mapMm=11000, **src),
        _node("z", "farm", "o", areaKm2=0, mapMm=500, **src),
    ]
    s = _settings(
        gr4j={"x1": 300, "x2": -0.5, "x3": 80, "x4": 1.8, "warmupDays": 400},
        calibration={"rainThresholdMm": 2, "catchmentAreaKm2": 50},
        unitRain={"mode": "perUnit", "gaugeMapMm": 600, "gaugeMapSource": "invented", "mapPeriod": {"start": "2010-01-01", "end": "2019-12-31"}},
    )
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def unit_rain_forecast_warmup() -> dict:
    """The forecast-tail warm-up probe under per-unit rain: 40 days of
    records, 6 forecast days and a 365-day warm-up. Each unit's warm-up
    cycles its 40 historical days only, never the tail (§2.4h, §2.4f); one
    unit on its own gauge, one on the gauge × its MAP ratio."""
    doc = forecast_tail_warmup()
    rain = doc["series"]["rain_catchment_mm"]["values"]
    doc["series"]["rain_catchment_mm@f"] = {"startDate": "2020-01-01", "values": [v * 1.5 for v in rain]}
    doc["model"]["nodes"].append(_node("h", "farm", "o", areaKm2=3, mapMm=900, mapSource="invented"))
    doc["settings"]["unitRain"] = {"mode": "perUnit", "gaugeMapMm": 600, "gaugeMapSource": "invented"}
    return doc


def unit_rain_map_period() -> dict:
    """CHIRPS MAP factors (§2.4h rule 3) over six complete calendar years
    and a MAP period holding two of them: fewer than 10, so units a and b
    average every complete year of the record; a third unit's CHIRPS reads 0 on every day of its complete years (a mean
    annual rain of 0) and rains in its incomplete last one. Engine 1.78.0
    ran it raw (this probe settled that); issue #500 item 7a makes such
    CHIRPS unusable, so unit c runs on the catchment's rain (× 1, no gauge
    MAP) on every day, its incomplete year's rainy CHIRPS days too. A
    complete year of 0 mm among rainy ones still counts in the mean."""
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    series: dict = {"rain_catchment_mm": {"startDate": start.isoformat(), "values": _wave(start, n, 0)}}
    series["rain_chirps_mm@a"] = {"startDate": start.isoformat(), "values": _wave(start, n, 1)}
    series["rain_chirps_mm@b"] = {"startDate": start.isoformat(), "values": _wave(start, n, 2)}
    zero = [0.0] * n
    zero[n - 10] = None
    for j in range(n - 300, n - 11):
        zero[j] = 5.0 if j % 4 == 0 else 0.0
    series["rain_chirps_mm@c"] = {"startDate": start.isoformat(), "values": zero}
    dry_first: list = _wave(start, n, 3)
    for j in range(365):
        dry_first[j] = 0.0
    series["rain_chirps_mm@d"] = {"startDate": start.isoformat(), "values": dry_first}
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("a", "farm", "o", areaKm2=3, mapMm=700, **src),
        _node("b", "farm", "o", areaKm2=2, mapMm=500, **src),
        _node("c", "farm", "o", areaKm2=1, mapMm=500, **src),
        _node("d", "farm", "o", areaKm2=1, mapMm=600, **src),
    ]
    s = _settings(unitRain={"mode": "perUnit", "mapPeriod": {"start": "2015-01-01", "end": "2016-12-31"}})
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def unit_rain_no_land_unit() -> dict:
    """Per-unit rain with no land unit (the one farm has no area) and a
    catchmentAreaKm2 set. Read literally, §2.4h makes the catchment area the
    land units' areas summed, 0, which §2.4a refuses; the engine instead runs
    GR4J on the catchment rain over catchmentAreaKm2, with a warning, as if
    the setting were off. Not in the docs until this probe; now in §2.4h."""
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=0)]
    s = _settings(calibration={"rainThresholdMm": 2, "catchmentAreaKm2": 25}, unitRain={"mode": "perUnit"})
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": _steady(30, 4.0)}


def unit_rain_reference() -> dict:
    """The reference gauge (§2.4h, engine >= 1.80.0) at its edges: the
    catchment gauge against unit r's cell, the gauge × 0.5 (factor 2) except
    January with exactly 90 shared days (fits), February with 89 (factor 1),
    March under 50 mm of CHIRPS (factor 1) and July × 0.15 (clamped to 4),
    and a no-data code. Since issue #500 item 1a each unit's CHIRPS is
    v × f[month] × k_unit, k_unit = clamp(unit MAP ÷ its mean annual
    (CHIRPS × f)) over every complete year (six, fewer than 10 in the MAP
    period): a's MAP of 3000 mm gives k_unit ≈ 2.25 (inside the clamp, so
    no longer the clamped 3000 ÷ 500 ratio), b has no MAP (the factors
    alone), the reference unit r is levelled to its own MAP too (k ≈ 0.38,
    no longer 1), g's own gauge has gaps its levelled CHIRPS fills."""
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    gauge = _wave(start, n, 0)
    cell: list = []
    jan = feb = 0
    for i, g in enumerate(gauge):
        d = start + dt.timedelta(days=i)
        v = round(g * (0.15 if d.month == 7 else 0.05 if d.month == 3 else 0.5), 2)
        if d.month == 1:
            jan += 1
            v = v if jan <= 90 else None
        if d.month == 2:
            feb += 1
            v = v if feb <= 89 else None
        cell.append(v)
    cell[200] = -9999.0
    own_g: list = _wave(start, n, 4, 1.2)
    for j in range(30, 70):
        own_g[j] = None
    series: dict = {"rain_catchment_mm": {"startDate": start.isoformat(), "values": gauge}}
    series["rain_chirps_cell_mm@r"] = {"startDate": start.isoformat(), "values": cell}
    for k, uid in enumerate(["r", "a", "b", "g"]):
        series[f"rain_chirps_mm@{uid}"] = {"startDate": start.isoformat(), "values": _wave(start, n, k + 1, 0.6 + 0.1 * k)}
    series["rain_catchment_mm@g"] = {"startDate": start.isoformat(), "values": own_g}
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("r", "farm", "o", areaKm2=2, mapMm=500, **src),
        _node("a", "farm", "o", areaKm2=3, mapMm=3000, **src),
        _node("b", "farm", "o", areaKm2=1),
        _node("g", "farm", "o", areaKm2=1.5, mapMm=650, **src),
    ]
    s = _settings(unitRain={"mode": "perUnit", "reference": {"gauge": "rain_catchment_mm", "unitId": "r"}})
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def unit_rain_reference_not_land() -> dict:
    """A reference unit without area (not a land unit): no cell to fit on,
    so the units' CHIRPS is levelled as without a reference (§2.4h). The
    catchment has CHIRPS here, so b (no MAP) takes its §2.4b factors: with
    factors of 1 the reference would equal rule 3 on every unit with a MAP
    (k_unit is then the MAP factor), so only b tells the two apart."""
    doc = unit_rain_reference()
    start = dt.date(2014, 1, 1)
    n = len(doc["series"]["rain_catchment_mm"]["values"])
    doc["series"]["rain_chirps_mm"] = {"startDate": start.isoformat(), "values": [round(v * 0.7, 2) for v in _wave(start, n, 9)]}
    doc["model"]["nodes"].append(_node("z", "farm", "o", areaKm2=0, mapMm=500, mapSource="invented"))
    doc["series"]["rain_chirps_cell_mm@z"] = doc["series"].pop("rain_chirps_cell_mm@r")
    doc["settings"]["unitRain"]["reference"] = {"gauge": "rain_catchment_mm", "unitId": "z"}
    return doc


def baseflow_loss_and_gain() -> dict:
    """A unit's base-flow loss and gain (§2.6b, engine >= 1.86.0): unit a
    loses up to 3 000 m³/day of its own runoff, all of it on the dry days, and
    sends half of what is left into its dam; unit b gains 500 m³/day from
    outside the catchment on every day, rain or not, and a priority user
    below both takes from the river. The runoff column stays natural × share;
    the split, the dam, the priority pass and the outflow read I − MIN(loss,
    I) + gain. Read on the gross runoff instead, or with the loss uncapped,
    the dam and the user's take differ."""
    days = 120
    rain = [0.0] * days
    for t in range(days):
        if t % 9 in (0, 1):
            rain[t] = 25.0 if t % 27 < 9 else 8.0
    nodes = [
        _node("o", "gauge", None),
        _node("p", "user", "o", userDemandM3Day=[1500] * 12, userPriority="senior"),
        _node("a", "farm", "p", areaKm2=6, pctRunoffToDam=0.5, damCapacityM3=40000, damInitialPct=0.2, baseflowLossM3Day=3000),
        _node("b", "farm", "p", areaKm2=2, baseflowGainM3Day=500),
    ]
    s = _settings(gr4j={"x1": 250, "x2": 0, "x3": 60, "x4": 1.5, "warmupDays": 0})
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": {"rain_catchment_mm": {"startDate": "2020-01-01", "values": rain}}}
# Issue #500's decisions (operator, 2026-10-09; built in engine 1.84.x+): k_unit, the
# 10-year minimum, unusable CHIRPS, the CHIRPS-GEFS forecast, checked gauges.

WET = (11, 12, 1, 2, 3, 4)


def _season(start: dt.date, n: int, k: int, scale: float = 1.0) -> list:
    """_wave with a wet season (November to April × 2, the rest × 0.5), so
    §2.10a's six wettest months are November to April."""
    return [
        round(v * (2 if (start + dt.timedelta(days=i)).month in WET else 0.5), 1)
        for i, v in enumerate(_wave(start, n, k, scale))
    ]


def _idx(start: dt.date, y: int, m: int, d: int) -> int:
    return (dt.date(y, m, d) - start).days


def _net(nodes: list, series: dict, **settings) -> dict:
    return {"settings": _settings(**settings), "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def unit_rain_reference_kunit() -> dict:
    """k_unit and the 10-year minimum under a reference gauge (issue #500
    items 1a, 4, 7a). Twelve years (2008–2019), MAP period 2010–2019 (ten
    complete years). The cell is the catchment gauge × 0.5 (factor 2), × 0.1
    in May (factor 10, clamped to 4) and absent in June (factor 1), so k_unit
    has to make up the clamped and defaulted months. p: complete CHIRPS in
    all twelve years, its 2008–2009 × 3 wetter, so k_unit averages the ten
    MAP-period years only; q: a gap in 2012 leaves nine there, so every
    complete year (eleven); n: a gap in every year, no complete year, so the
    factors alone (k = 1) though it has a MAP; z: complete years of 0 mm and
    rain in its incomplete last year: unusable, so the catchment's rain (× 1)
    on every day; t: a MAP of 40 mm, k_unit clamped to 0.25; r: the
    reference unit, levelled to its own MAP."""
    start = dt.date(2008, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    gauge = _wave(start, n, 0)
    cell: list = []
    for i, g in enumerate(gauge):
        m = (start + dt.timedelta(days=i)).month
        cell.append(None if m == 6 else round(g * (0.1 if m == 5 else 0.5), 2))
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": gauge},
        "rain_chirps_cell_mm@r": {"startDate": start.isoformat(), "values": cell},
    }
    two = _idx(start, 2010, 1, 1)
    p_ch = [round(v * (3 if i < two else 1), 2) for i, v in enumerate(_wave(start, n, 1, 0.7))]
    q_ch = _wave(start, n, 2, 0.8)
    q_ch[_idx(start, 2012, 7, 4)] = None
    n_ch = _wave(start, n, 3)
    for y in range(12):
        n_ch[y * 365 + 40] = None
    z_ch = [0.0] * n
    z_ch[n - 5] = None
    for j in range(n - 200, n - 6):
        z_ch[j] = 6.0 if j % 4 == 0 else 0.0
    series["rain_chirps_mm@p"] = {"startDate": start.isoformat(), "values": p_ch}
    series["rain_chirps_mm@q"] = {"startDate": start.isoformat(), "values": q_ch}
    series["rain_chirps_mm@n"] = {"startDate": start.isoformat(), "values": n_ch}
    series["rain_chirps_mm@z"] = {"startDate": start.isoformat(), "values": z_ch}
    series["rain_chirps_mm@t"] = {"startDate": start.isoformat(), "values": _wave(start, n, 4)}
    series["rain_chirps_mm@r"] = {"startDate": start.isoformat(), "values": _wave(start, n, 5, 0.9)}
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("r", "farm", "o", areaKm2=2, mapMm=650, **src),
        _node("p", "farm", "o", areaKm2=3, mapMm=700, **src),
        _node("q", "farm", "o", areaKm2=1, mapMm=800, **src),
        _node("n", "farm", "o", areaKm2=1, mapMm=900, **src),
        _node("z", "farm", "o", areaKm2=1, mapMm=500, **src),
        _node("t", "farm", "o", areaKm2=0.5, mapMm=40, **src),
    ]
    ur = {"mode": "perUnit", "mapPeriod": {"start": "2010-01-01", "end": "2019-12-31"}, "reference": {"gauge": "rain_catchment_mm", "unitId": "r"}}
    return _net(nodes, series, unitRain=ur)


def unit_rain_unusable_chirps() -> dict:
    """CHIRPS averaging 0 mm a year without a reference (issue #500 item
    7a): complete years of 0 mm, rain only in an incomplete last year. c3
    (rule 3, a MAP) and c0 (rule 3, no MAP) run on the catchment's rain on
    every day, never their CHIRPS (engine 1.78.0: c3 raw, c0 × the §2.4b
    factors, both 0 mm on most days); c1, its own gauge with gaps, fills
    them from the catchment's rain, not from its CHIRPS. c0 pins that the
    test doesn't need a MAP (the unit's CHIRPS mean is computed either
    way); the catchment has CHIRPS, so §2.4b factors exist."""
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    catch: list = _wave(start, n, 0)
    for j in range(300, 330):
        catch[j] = None
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": catch},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": [round(v * 0.7, 2) for v in _wave(start, n, 1)]},
    }
    zero = [0.0] * n
    zero[n - 5] = None
    for j in range(n - 200, n - 6):
        zero[j] = 5.0 if j % 4 == 0 else 0.0
    own: list = _wave(start, n, 2, 1.1)
    for j in list(range(500, 540)) + list(range(n - 150, n - 120)):
        own[j] = None
    for uid in ("c3", "c0", "c1"):
        series[f"rain_chirps_mm@{uid}"] = {"startDate": start.isoformat(), "values": list(zero)}
    series["rain_catchment_mm@c1"] = {"startDate": start.isoformat(), "values": own}
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("c3", "farm", "o", areaKm2=2, mapMm=600, **src),
        _node("c0", "farm", "o", areaKm2=1),
        _node("c1", "farm", "o", areaKm2=1.5, mapMm=700, **src),
    ]
    return _net(nodes, series, unitRain={"mode": "perUnit"})


def _forecast_doc(reference: bool) -> dict:
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 25) - start).days + 1
    gauge = _wave(start, n, 0)
    # A few gauge gaps, filled on rule-2 units from their own CHIRPS: s's at its factors × its MAP ratio.
    for j in (40, 41, 42, 400, 401, 800, 1200, 1201, 1202, 1203):
        gauge[j] = None
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": gauge},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": [round(v * 0.6, 2) for v in _wave(start, n, 1)]},
        # Ten forecast days over the turn of the year, so two calendar months' factors.
        "rain_forecast_mm": {"startDate": "2019-12-26", "values": [3.0, 0.0, 8.0, 1.5, 0.0, 12.0, 4.0, 0.0, 6.5, 2.0]},
    }
    if reference:
        cell = [None if g is None else round(g * (0.4 if (start + dt.timedelta(days=i)).month in (12, 1) else 0.8), 2) for i, g in enumerate(gauge)]
        series["rain_chirps_cell_mm@r"] = {"startDate": start.isoformat(), "values": cell}
    for k, uid in enumerate(["r", "a", "e"]):
        series[f"rain_chirps_mm@{uid}"] = {"startDate": start.isoformat(), "values": _wave(start, n, k + 2, 0.5 + 0.2 * k)}
    zero = [0.0] * n
    zero[n - 3] = None
    series["rain_chirps_mm@d"] = {"startDate": start.isoformat(), "values": zero}
    # s: a MAP (so a MAP ratio) but a CHIRPS with a gap in every year, so no complete year: no k_unit, no MAP factor.
    gappy = _wave(start, n, 6, 0.6)
    for y in range(6):
        gappy[y * 365 + 100] = None
    series["rain_chirps_mm@s"] = {"startDate": start.isoformat(), "values": gappy}
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("r", "farm", "o", areaKm2=2, mapMm=650, **src),
        _node("a", "farm", "o", areaKm2=3, mapMm=900, **src),
        _node("b", "farm", "o", areaKm2=1, mapMm=400, **src),
        _node("d", "farm", "o", areaKm2=1, mapMm=500, **src),
        _node("e", "farm", "o", areaKm2=1.5),
        _node("s", "farm", "o", areaKm2=1.2, mapMm=750, **src),
    ]
    ur: dict = {"mode": "perUnit", "gaugeMapMm": 600, "gaugeMapSource": "invented"}
    if reference:
        ur["reference"] = {"gauge": "rain_catchment_mm", "unitId": "r"}
    doc = _net(nodes, series, unitRain=ur)
    doc["forecastRainSource"] = "chirps_gefs"
    return doc


def unit_rain_forecast_gefs() -> dict:
    """A CHIRPS-GEFS forecast under a reference gauge (issue #500 item 5,
    ModelInput.forecastRainSource 'chirps_gefs'): ten forecast days over the
    turn of the year. r and a (rule 2, CHIRPS of their own) take the
    forecast × f[month] × k_unit, December's and January's factor each on
    its days, not × their MAP ratio; e (rule 3, no MAP) × f[month] alone;
    s (rule 2, a MAP but no complete CHIRPS year, so no k_unit) × f[month]
    × its MAP ratio, the factors shaping the season and the ratio setting
    the level its history's gauge × ratio reads at (and so on the gauge's
    gap days, which it fills from its CHIRPS × f × the ratio); b (rule 2, no CHIRPS)
    and d (unusable CHIRPS, item 7a) keep × the MAP ratio. The historical
    days are unchanged by the setting."""
    return _forecast_doc(True)


def unit_rain_forecast_gefs_noref() -> dict:
    """The same CHIRPS-GEFS forecast without a reference gauge: "corrected
    like the unit's CHIRPS" read as the unit's rule-3 levelling, whatever it
    is. r and a: × their CHIRPS MAP factor (unit MAP ÷ the mean annual
    CHIRPS); e (no MAP): × the catchment's §2.4b factor for the day's month;
    s (a MAP, no complete CHIRPS year): × the §2.4b factor × its MAP ratio,
    on the forecast and on the gauge's gap days alike;
    b and d: × the MAP ratio as before. A reading of item 5 for units
    without a reference (the issue speaks of f × k_unit only), so a
    disagreement here is a point for the docs to settle, not a defect."""
    return _forecast_doc(False)


def unit_rain_forecast_other() -> dict:
    """The same forecast with `forecastRainSource` 'other' (an uploaded
    forecast, which may already be at gauge level): every unit keeps × its
    MAP ratio (× 1 on e) on the forecast days (issue #500 item 5)."""
    doc = _forecast_doc(True)
    doc["forecastRainSource"] = "other"
    return doc


def _zero_run_gauge(start: dt.date, n: int, k: int, scale: float) -> list:
    """Seasonal rain with a 76-day run of zeros in the wet season
    (2015-12-16 to 2016-02-29), which §2.10a flags (60+ wet-season days)."""
    g = _season(start, n, k, scale)
    for j in range(_idx(start, 2015, 12, 16), _idx(start, 2016, 3, 1)):
        g[j] = 0.0
    g[_idx(start, 2015, 12, 15)] = 4.0
    g[_idx(start, 2016, 3, 1)] = 5.0
    return g


def _run_chirps(start: dt.date, n: int, k: int) -> list:
    """CHIRPS reading 3 mm on the zero run's days (above the 2 mm fill
    threshold, so they are filled), 1 mm on every fifth (at most the
    threshold, so the gauge's 0 stands)."""
    c = [round(v * 0.8, 2) for v in _season(start, n, k)]
    for j in range(_idx(start, 2015, 12, 16), _idx(start, 2016, 3, 1)):
        c[j] = 1.0 if j % 5 == 0 else 3.0
    return c


def unit_rain_gauge_checks() -> dict:
    """A unit's own gauge gets the catchment gauge's checks with the
    catchment's settings (issue #500 item 6), the days they remove falling to
    the next link of rule 1 (its own CHIRPS; raw here: no MAP, bias
    correction 'none'). u's gauge has a flagged 76-day zero run in the wet
    season: days whose CHIRPS reads 3 mm take it, every fifth (1 mm, at most
    the threshold) keeps the gauge's 0. In June 2018 a 60 mm reading after
    five blank days, with CHIRPS 40 mm on four of them and 0 on the day
    before and the reading's days, is an accumulation, spread 15 mm a day over
    the four ('spread' mode). The catchment's CHIRPS is the same series as
    u's, so the probe doesn't depend on which CHIRPS the checks read. The
    catchment gauge itself is clean."""
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    ch = _run_chirps(start, n, 1)
    own = _zero_run_gauge(start, n, 2, 1.2)
    r = _idx(start, 2018, 6, 10)
    for j in range(r - 5, r):
        own[j] = None
    own[r] = 60.0
    own[r - 6] = 0.0
    for j in range(r - 5, r - 1):
        ch[j] = 40.0
    for j in (r - 1, r, r + 1):
        ch[j] = 0.0
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": _season(start, n, 0)},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": ch},
        "rain_catchment_mm@u": {"startDate": start.isoformat(), "values": own},
        "rain_chirps_mm@u": {"startDate": start.isoformat(), "values": list(ch)},
    }
    nodes = [_node("o", "gauge", None), _node("u", "farm", "o", areaKm2=2)]
    return _net(nodes, series, unitRain={"mode": "perUnit"}, chirpsBiasCorrection="none")


def unit_rain_gauge_catchment_settings() -> dict:
    """What a unit gauge's checks take from the catchment (engine 1.85.0,
    issue #500 item 6). u1 (its own gauge and CHIRPS): the catchment's
    listed missing period, 2016-03-01 to 2016-03-31, names days of the
    catchment gauge's record, not u1's, so u1 keeps its readings there
    (the catchment's own rain does take CHIRPS on them). u2 has a gauge with
    the flagged wet-season zero run and no CHIRPS of its own: the checks
    compare with the catchment's CHIRPS, so a run day where it reads 1 mm
    (at most the 2 mm threshold) keeps u2's 0, and the rest (3 mm) are set
    aside and fall to the catchment's rain."""
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    ch = _run_chirps(start, n, 1)
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": _season(start, n, 0)},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": ch},
        "rain_catchment_mm@u1": {"startDate": start.isoformat(), "values": _season(start, n, 2, 1.3)},
        "rain_chirps_mm@u1": {"startDate": start.isoformat(), "values": _season(start, n, 4, 0.6)},
        "rain_catchment_mm@u2": {"startDate": start.isoformat(), "values": _zero_run_gauge(start, n, 3, 1.1)},
    }
    nodes = [_node("o", "gauge", None), _node("u1", "farm", "o", areaKm2=2), _node("u2", "farm", "o", areaKm2=1)]
    zr = {
        "mode": "missing", "keepDry": [], "accumulationMode": "spread", "keepReadings": [], "addAccumulations": [],
        "missing": [{"start": "2016-03-01", "end": "2016-03-31", "reason": "invented"}],
    }
    return _net(nodes, series, unitRain={"mode": "perUnit"}, chirpsBiasCorrection="none", zeroRainRuns=zr)


def unit_rain_reference_checked() -> dict:
    """The reference fit reads the checked gauge rain (issue #500 item 1c):
    the catchment gauge has the flagged wet-season zero run, which §2.4c sets
    aside (its CHIRPS reads 3 mm), so those days are out of the fit. The cell
    is the gauge × 0.5 elsewhere (factor 2) and reads 3 mm on the run's days:
    read as stored, the run's zeros against 3 mm would pull December's,
    January's and February's factors well below 2; checked, those days are
    out. Every fifth run day, CHIRPS at 1 mm (at most the 2 mm threshold),
    keeps the gauge's 0 and so stays in the fit, 0 against 1 mm. In June
    2018 a 60 mm reading after five blanks is an accumulation, spread 15 mm
    a day over four of them against a cell of 40 mm; the fit leaves the
    window's days out as §2.4b does (engine 1.85.0), so June stays at 2."""
    start = dt.date(2014, 1, 1)
    n = (dt.date(2019, 12, 31) - start).days + 1
    gauge = _zero_run_gauge(start, n, 0, 1.0)
    ch = _run_chirps(start, n, 1)
    run = range(_idx(start, 2015, 12, 16), _idx(start, 2016, 3, 1))
    # The accumulation (engine 1.85.0: its window is out of the fit, as in §2.4b).
    r = _idx(start, 2018, 6, 10)
    for j in range(r - 5, r):
        gauge[j] = None
    gauge[r] = 60.0
    gauge[r - 6] = 0.0
    for j in range(r - 5, r - 1):
        ch[j] = 40.0
    for j in (r - 1, r, r + 1):
        ch[j] = 0.0
    window = range(r - 5, r + 2)
    cell = [ch[i] if (i in run or i in window) else round(g * 0.5, 2) for i, g in enumerate(gauge)]
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": gauge},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": ch},
        "rain_chirps_cell_mm@r": {"startDate": start.isoformat(), "values": cell},
        "rain_chirps_mm@r": {"startDate": start.isoformat(), "values": _season(start, n, 3, 0.7)},
        "rain_chirps_mm@a": {"startDate": start.isoformat(), "values": _season(start, n, 4, 0.9)},
    }
    src = {"mapSource": "invented"}
    nodes = [_node("o", "gauge", None), _node("r", "farm", "o", areaKm2=2, mapMm=650, **src), _node("a", "farm", "o", areaKm2=3, mapMm=800, **src)]
    return _net(nodes, series, unitRain={"mode": "perUnit", "reference": {"gauge": "rain_catchment_mm", "unitId": "r"}})


def unit_rain_reference_unit_gauge_checked() -> dict:
    """The same with a unit's own gauge as the reference (items 1c and 6):
    unit g's gauge has the flagged zero run (its own CHIRPS reads 3 mm
    there) and the June 2018 accumulation, the catchment gauge is clean. The
    fit leaves the run's filled days and the window out, and g's own chain
    takes its levelled CHIRPS (f × k_unit) on the filled days and the spread
    rain on the window."""
    doc = unit_rain_reference_checked()
    s = doc["series"]
    start = dt.date(2014, 1, 1)
    n = len(s["rain_catchment_mm"]["values"])
    s["rain_catchment_mm@g"] = s["rain_catchment_mm"]
    s["rain_chirps_mm@g"] = {"startDate": start.isoformat(), "values": list(s["rain_chirps_mm"]["values"])}
    s["rain_catchment_mm"] = {"startDate": start.isoformat(), "values": _season(start, n, 6)}
    s["rain_chirps_mm"] = {"startDate": start.isoformat(), "values": [round(v * 0.8, 2) for v in _season(start, n, 7)]}
    doc["model"]["nodes"].append(_node("g", "farm", "o", areaKm2=1.5, mapMm=700, mapSource="invented"))
    doc["settings"]["unitRain"]["reference"] = {"gauge": "rain_catchment_mm@g", "unitId": "r"}
    return doc


def pool_storage_only() -> dict:
    """A pool at the crops' river pump (§2.7j) under a high A-pan with a lake
    factor of 1, on a unit with no dam: it holds up to its capacity with no
    rain and no evaporation (engine 1.86.0, issue #523 B2), so it loses only
    what the pump draws on dry days and refills from the flow left on wet
    ones. Engines 1.65.0–1.85.x took ~200 m³/day of evaporation off it."""
    nodes = [
        _node("o", "gauge", None),
        _node("f", "farm", "o", areaKm2=1, cropWaterSource="river", cropRiverPumpM3Day=2000, cropRiverPoolM3=30000),
    ]
    crops, areas = _crop("f", 80000)
    s = _settings(apanMm=[300] * 12, lakeEvapFactor=1, effectiveRainFraction=0)
    rain = [60.0 if t % 15 == 0 else 0.0 for t in range(90)]
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": []},
            "series": {"rain_catchment_mm": {"startDate": "2020-01-01", "values": rain}}}


# --------------------------------------------------------------------------
# Rainfall stations (issue #553, engine >= 1.91.0, docs/model.md §2.4i).
# --------------------------------------------------------------------------


def _station(name: str, map_mm) -> dict:
    return {"name": name, "mapMm": map_mm, "mapSource": None if map_mm is None else "invented", "lat": None, "lon": None}


def station_units() -> dict:
    """Stations under per-unit rain (§2.4i), twelve years (2006–2017). Station
    A (MAP 600) stands in u1 (its pairing reads u1's CHIRPS), with gaps
    (July 2009, February 2013), an unreliable period (March 2015), a flagged
    wet-season zero run (late 2016), an accumulation after five blank days
    (June 2012) and a no-data code (−9999, January 2011, a gap), so five
    complete years in common (2006–2008, 2010, 2014) and a fitted pairing,
    its July factor 1 (u1's CHIRPS has under 50 mm in July); station B (MAP
    900) has a CHIRPS cell of its own, its May factor clamped to 4, and gaps
    (May 2011, September 2014). The
    units: u1 (MAP 720, ratio 1.2) and u2 (MAP 420, 0.7) share A; u3 on B at
    MAP 9 000 (ratio 10, clamped to 4); u4 on A at MAP 100 (1/6, clamped to
    0.25); u5 on A with scaleToMap false (× 1) and its CHIRPS corrected
    against B; u7 on B with no CHIRPS of its own (its gaps fall to the
    catchment forcing); u8 on A without a MAP (× 1); u6 has no station (the
    §2.4h chain, bit for bit). Every unit's CHIRPS reads a different level,
    so the pairing factors (A's against u1's CHIRPS, B's against its cell)
    show on every gap day."""
    start = dt.date(2006, 1, 1)
    n = (dt.date(2017, 12, 31) - start).days + 1
    a: list = _season(start, n, 0, 1.1)
    for j in list(range(_idx(start, 2013, 2, 1), _idx(start, 2013, 2, 21))) + list(range(_idx(start, 2009, 7, 5), _idx(start, 2009, 7, 15))):
        a[j] = None
    for j in range(_idx(start, 2016, 11, 1), _idx(start, 2017, 2, 15)):
        a[j] = 0.0
    r = _idx(start, 2012, 6, 20)
    for j in range(r - 5, r):
        a[j] = None
    a[r] = 64.0
    # A no-data code on a day u1's CHIRPS rains: a gap, so the corrected CHIRPS fills it.
    neg = _idx(start, 2011, 1, 3)
    a[neg] = -9999.0
    b: list = _season(start, n, 3, 1.6)
    for j in list(range(_idx(start, 2014, 9, 1), _idx(start, 2014, 10, 1))) + list(range(_idx(start, 2011, 5, 3), _idx(start, 2011, 5, 13))):
        b[j] = None
    # u1's CHIRPS, where A's pairing reads, × 0.05 in July (under 50 mm in twelve Julys: factor 1).
    ch_u1 = [round(v * (0.04 if (start + dt.timedelta(days=i)).month == 7 else 0.8), 2) for i, v in enumerate(_season(start, n, 1))]
    # CHIRPS rains on A's accumulation blanks and not on the reading's days, so §2.4d finds the window.
    for j in range(r - 5, r):
        ch_u1[j] = 9.0
    for j in (r - 1, r, r + 1):
        ch_u1[j] = 0.0
    ch_u1[neg] = 14.0
    iso = start.isoformat()
    series: dict = {
        "rain_catchment_mm": {"startDate": iso, "values": _season(start, n, 5)},
        "rain_chirps_mm": {"startDate": iso, "values": [round(v * 0.7, 2) for v in _season(start, n, 6)]},
        "rain_station_mm#A": {"startDate": iso, "values": a},
        "rain_station_mm#B": {"startDate": iso, "values": b},
        # B's cell × 0.25 in May: a factor past 4, clamped.
        "rain_chirps_station_mm#B": {"startDate": iso, "values": [round(v * (0.25 if (start + dt.timedelta(days=i)).month == 5 else 1.3), 2) for i, v in enumerate(_season(start, n, 4))]},
        "rain_chirps_mm@u1": {"startDate": iso, "values": ch_u1},
        "rain_chirps_mm@u2": {"startDate": iso, "values": [round(v * 0.5, 2) for v in _season(start, n, 7)]},
        "rain_chirps_mm@u3": {"startDate": iso, "values": [round(v * 1.4, 2) for v in _season(start, n, 8)]},
        "rain_chirps_mm@u4": {"startDate": iso, "values": [round(v * 0.9, 2) for v in _season(start, n, 9)]},
        "rain_chirps_mm@u5": {"startDate": iso, "values": [round(v * 1.1, 2) for v in _season(start, n, 10)]},
        "rain_chirps_mm@u6": {"startDate": iso, "values": [round(v * 0.6, 2) for v in _season(start, n, 2)]},
        "rain_chirps_mm@u8": {"startDate": iso, "values": [round(v * 0.75, 2) for v in _season(start, n, 11)]},
    }
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("u1", "farm", "o", areaKm2=3, mapMm=720, **src),
        _node("u2", "farm", "u1", areaKm2=2, mapMm=420, **src),
        _node("u3", "farm", "o", areaKm2=1.5, mapMm=9000, **src),
        _node("u4", "farm", "o", areaKm2=1, mapMm=100, **src),
        _node("u5", "farm", "o", areaKm2=2.5, mapMm=1500, **src),
        _node("u6", "farm", "o", areaKm2=1.2, mapMm=650, **src),
        _node("u7", "farm", "o", areaKm2=0.8, mapMm=800, **src),
        _node("u8", "farm", "o", areaKm2=0.6),
    ]
    stations = {
        "A": {"stationId": "A"},
        "B": {"stationId": "B"},
    }
    rs = {
        "units": {
            "u1": stations["A"], "u2": stations["A"], "u3": stations["B"], "u4": stations["A"],
            "u5": {"stationId": "A", "scaleToMap": False, "correctAgainst": "B"}, "u7": stations["B"], "u8": stations["A"],
        },
        "sites": {"A": {"unitId": "u1"}},
        "unreliable": {"A": [["2015-03-01", "2015-03-31"]]},
    }
    # A listed missing period of the catchment gauge's: not A's or B's (§2.4i: neither is the catchment gauge).
    zr = {"missing": [{"start": "2009-05-01", "end": "2009-05-20", "reason": "invented"}]}
    doc = _net(
        nodes, series,
        zeroRainRuns=zr,
        gr4j={"x1": 300, "x2": -0.3, "x3": 80, "x4": 1.8, "warmupDays": 200},
        unitRain={"mode": "perUnit", "gaugeMapMm": 600, "gaugeMapSource": "invented"},
        rainStations=rs,
    )
    doc["stations"] = {"A": _station("A", 600), "B": _station("B", 900)}
    return doc


def station_patch() -> dict:
    """The patching priority (§2.4i, issue #612, engine 1.105.0) on
    station_units' network and records, with a third station C (no MAP,
    every day read): u1 (MAP 720) on A patched from B (MAP 900, ratio 0.8,
    not A's 1.2) then CHIRPS, so A's gaps read B where B reads and u1's
    CHIRPS on B's own gaps; u2 on A with CHIRPS before B, so B fills
    nothing; u4 on A patched from C first, skipped (no MAP under scaling),
    then B; u5 (scaleToMap false) patched from C × 1; u8 on A with an empty
    priority, its gaps to the catchment forcing."""
    doc = station_units()
    n = len(doc["series"]["rain_station_mm#A"]["values"])
    start = dt.date.fromisoformat(doc["series"]["rain_station_mm#A"]["startDate"])
    doc["series"]["rain_station_mm#C"] = {"startDate": start.isoformat(), "values": _season(start, n, 12, 0.9)}
    doc["stations"]["C"] = _station("C", None)
    u = doc["settings"]["rainStations"]["units"]
    b, c, ch = {"source": "station", "stationId": "B"}, {"source": "station", "stationId": "C"}, {"source": "chirps"}
    u["u1"] = {"stationId": "A", "patch": [b, ch]}
    u["u2"] = {"stationId": "A", "patch": [ch, b]}
    u["u4"] = {"stationId": "A", "patch": [c, b, ch]}
    u["u5"] = {**u["u5"], "patch": [c, ch]}
    u["u8"] = {"stationId": "A", "patch": []}
    return doc


def ewr_split_station_units() -> dict:
    """The EWR split by each unit's natural MAR (§2.5b, engine >= 1.94.0) on
    station_units' network: u1 and u2 share station A, u2 drains into u1, so
    u1's requirement adds both shares; the period is the complete water years
    2006/07 … 2016/17 of the twelve calendar years."""
    doc = station_units()
    doc["settings"]["ewrPragmaticM3PerDay"] = [4000, 4000, 5000, 6000, 6000, 5000, 4000, 3000, 2500, 2500, 3000, 3500]
    return doc


def ewr_split_fragmentation() -> dict:
    """The same network under Fragmentation (engine >= 1.105.0, issues #615,
    #616): the unit shares come from GR4J once per land unit on the Per unit
    forcing (the stations, the gauge MAP), the same shares as under Per unit,
    and they split both the catchment's one GR4J run's flow and the EWR."""
    doc = ewr_split_station_units()
    doc["settings"]["unitRain"] = {**doc["settings"]["unitRain"], "mode": "catchment"}
    return doc


def unit_shares_senior_user() -> dict:
    """The senior users' claims on the unit shares (§2.7c, engine >= 1.105.0,
    issue #616): ewr-split-fragmentation's network with a senior user s
    between u1 and the outlet, so u1 and u2 (one station, MAPs 720 and 420,
    areas 3 and 2) carry its demand by their natural MAR shares, not their
    areas."""
    doc = ewr_split_fragmentation()
    nodes = doc["model"]["nodes"]
    next(x for x in nodes if x["id"] == "u1")["downstreamNodeId"] = "s"
    nodes.append(_node("s", "user", "o", userDemandM3Day=[2000, 2000, 2500, 3000, 3000, 2500, 2000, 1500, 1200, 1200, 1500, 1800], userPriority="senior", userReturnPct=0))
    return doc


def ewr_split_short_run() -> dict:
    """The same split on a run of 1 January – 31 August 2010, which holds no
    complete water year: the units' natural MAR over the whole run (§2.5b)."""
    doc = ewr_split_station_units()
    doc["settings"]["simulationStart"] = "2010-01-01"
    doc["settings"]["simulationEnd"] = "2010-08-31"
    return doc


def station_pairing_refused() -> dict:
    """Pairings at the five-year minimum (§2.4i): station C (MAP 500) starts
    on 1 March 2013, so 2014–2017 are its four complete calendar years in
    common with the CHIRPS at it (refused); D (MAP 800) from 1 January 2013
    has five (fitted). Unit p on C: C's days × 1.4, its gaps the catchment
    forcing (no pairing to correct its CHIRPS with). Unit q on D with its
    CHIRPS corrected against C: D's days × its ratio, its gaps the catchment
    forcing too. Unit d on D: its gaps (before 2013) D's corrected CHIRPS.
    Station E (MAP 700) is D's record with an accumulation in June 2014:
    four blank days, then 60 mm. Spread, the blanks hold rain in the checked
    record, so 2014 is complete (the window's days count as read, engine
    1.96.0, engine-audit.md RS6): five years, fitted, though the factors
    leave the window out (up to engine 1.95.0 it was refused). Unit e on E:
    its gaps (before 2013) E's corrected CHIRPS.
    station-pairing-as-recorded runs the same with the window run as
    recorded, so E is refused there.
    Station F (MAP 450) has neither a cell nor a site, so no CHIRPS at it:
    refused, though seven complete years (2011–2017) would fit it on the
    catchment's CHIRPS; unit f on it fills its gaps (four days of 2010)
    from the catchment forcing."""
    start = dt.date(2010, 1, 1)
    n = (dt.date(2017, 12, 31) - start).days + 1
    c: list = _season(start, n, 0, 1.2)
    d: list = _season(start, n, 2, 0.9)
    for j in range(_idx(start, 2013, 3, 1)):
        c[j] = None
    for j in range(_idx(start, 2013, 1, 1)):
        d[j] = None
    for j in range(_idx(start, 2015, 8, 1), _idx(start, 2015, 8, 12)):
        c[j] = None
    e: list = list(d)
    r = _idx(start, 2014, 6, 20)
    for j in range(r - 4, r):
        e[j] = None
    e[r] = 60.0
    ch_e = [round(v * 1.2, 2) for v in _season(start, n, 3)]
    for j in range(r - 4, r):
        ch_e[j] = 12.0
    for j in (r - 1, r, r + 1):
        ch_e[j] = 0.0
    iso = start.isoformat()
    series: dict = {
        "rain_catchment_mm": {"startDate": iso, "values": _season(start, n, 5)},
        "rain_chirps_mm": {"startDate": iso, "values": [round(v * 0.7, 2) for v in _season(start, n, 6)]},
        "rain_station_mm#C": {"startDate": iso, "values": c},
        "rain_station_mm#D": {"startDate": iso, "values": d},
        "rain_chirps_station_mm#C": {"startDate": iso, "values": [round(v * 0.6, 2) for v in _season(start, n, 1)]},
        "rain_chirps_station_mm#D": {"startDate": iso, "values": [round(v * 1.2, 2) for v in _season(start, n, 3)]},
        "rain_chirps_mm@p": {"startDate": iso, "values": [round(v * 0.8, 2) for v in _season(start, n, 7)]},
        "rain_chirps_mm@q": {"startDate": iso, "values": [round(v * 0.9, 2) for v in _season(start, n, 8)]},
        "rain_chirps_mm@d": {"startDate": iso, "values": [round(v * 1.1, 2) for v in _season(start, n, 9)]},
        "rain_station_mm#E": {"startDate": iso, "values": e},
        "rain_station_mm#F": {"startDate": iso, "values": [None if j % 97 == 0 and j < 365 else v for j, v in enumerate(_season(start, n, 11))]},
        "rain_chirps_mm@f": {"startDate": iso, "values": [round(v * 0.9, 2) for v in _season(start, n, 12)]},
        "rain_chirps_station_mm#E": {"startDate": iso, "values": ch_e},
        "rain_chirps_mm@e": {"startDate": iso, "values": [round(v * 0.7, 2) for v in _season(start, n, 10)]},
    }
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("p", "farm", "o", areaKm2=2, mapMm=700, **src),
        _node("q", "farm", "o", areaKm2=1, mapMm=600, **src),
        _node("d", "farm", "o", areaKm2=1.5, mapMm=880, **src),
        _node("e", "farm", "o", areaKm2=0.5, mapMm=650, **src),
        _node("f", "farm", "o", areaKm2=0.7, mapMm=500, **src),
    ]
    rs = {"units": {"p": {"stationId": "C"}, "q": {"stationId": "D", "correctAgainst": "C"}, "d": {"stationId": "D"}, "e": {"stationId": "E"}, "f": {"stationId": "F"}}}
    doc = _net(nodes, series, unitRain={"mode": "perUnit", "gaugeMapMm": 640, "gaugeMapSource": "invented"}, rainStations=rs)
    doc["stations"] = {"C": _station("C", 500), "D": _station("D", 800), "E": _station("E", 700), "F": _station("F", 450)}
    return doc


def station_pairing_as_recorded() -> dict:
    """station-pairing-refused with accumulations run as recorded (§2.4d
    "Run as recorded (one day)"): station E's 60 mm stays on its day and
    the window's four blank days stay blank, so the station doesn't supply
    them and 2014 isn't complete (RS6: only a spread total counts as read):
    four years, refused. Unit e's gaps fall to the catchment forcing."""
    doc = station_pairing_refused()
    doc["settings"]["zeroRainRuns"] = {
        "mode": "missing", "keepDry": [], "missing": [], "accumulationMode": "asRecorded", "keepReadings": [], "addAccumulations": [],
    }
    return doc


def station_catchment() -> dict:
    """The catchment's station (§2.4i) under Fragmentation: station S (MAP
    560) with gaps and an unreliable fortnight, its pairing on its CHIRPS
    cell; no catchmentMapMm, so the catchment MAP is the farms' area-weighted
    mean (3 × 800 + 1 × 400 + 2 × 650) / 6 = 683.3 and the ratio 1.22. Gap
    days read the catchment CHIRPS (`rain_chirps_mm`) × S's factors, as is;
    a forecast tail past both. The stored catchment gauge is ignored. S is
    the catchment gauge (`isCatchmentGauge`), so the catchment's listed
    missing period (March 2010) is a gap too, and its checks compare with the
    catchment's CHIRPS: a wet-season zero run (November 2015 to January
    2016) where its cell reads 0 too is set aside wherever the catchment
    CHIRPS reads over 2 mm. S has four complete years in common with its
    cell (2009, 2011, 2013, 2017: the gaps, the missing period, the
    unreliable fortnight and the zero run make the others incomplete), so
    its pairing is refused: gap days fall to the forecast, else dry."""
    start = dt.date(2009, 1, 1)
    n = (dt.date(2017, 12, 31) - start).days + 1
    st: list = _season(start, n, 0, 1.3)
    for j in range(_idx(start, 2012, 1, 10), _idx(start, 2012, 2, 10)):
        st[j] = None
    for j in range(_idx(start, 2016, 12, 1), _idx(start, 2016, 12, 6)):
        st[j] = None
    # A wet-season zero run (§2.4c flags it). S's cell reads 0 there too, the catchment CHIRPS rains: as the
    # catchment gauge, S is checked against the catchment CHIRPS, so its days are set aside, not kept dry.
    z0, z1 = _idx(start, 2015, 11, 1), _idx(start, 2016, 1, 31)
    for j in range(z0, z1):
        st[j] = 0.0
    cell = [round(v * 0.9, 2) for v in _season(start, n, 1)]
    ch = [round(v * 0.7, 2) for v in _season(start, n, 6)]
    for j in range(z0, z1):
        cell[j] = 0.0
        ch[j] = max(ch[j], 3.0) if j % 2 else ch[j]
    iso = start.isoformat()
    series: dict = {
        "rain_catchment_mm": {"startDate": iso, "values": [v * 3 for v in _season(start, n, 5)]},
        "rain_chirps_mm": {"startDate": iso, "values": ch},
        "rain_station_mm#S": {"startDate": iso, "values": st},
        "rain_chirps_station_mm#S": {"startDate": iso, "values": cell},
        "rain_forecast_mm": {"startDate": "2018-01-01", "values": [3.0, 0.0, 8.0, 1.5, 0.0, 12.0]},
    }
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("f1", "farm", "o", areaKm2=3, mapMm=800, **src),
        _node("f2", "farm", "f1", areaKm2=1, mapMm=400, **src),
        _node("f3", "farm", "o", areaKm2=2, mapMm=650, **src),
    ]
    rs = {"catchment": {"stationId": "S"}, "unreliable": {"S": [["2014-02-01", "2014-02-14"]]}}
    # S is the catchment gauge, so the catchment's listed missing period blanks its days (§2.4i).
    zr = {"missing": [{"start": "2010-03-01", "end": "2010-03-25", "reason": "invented"}]}
    doc = _net(nodes, series, rainStations=rs, zeroRainRuns=zr)
    doc["stations"] = {"S": {**_station("S", 560), "isCatchmentGauge": True}}
    return doc


def station_catchment_map() -> dict:
    """The catchment's station with a catchment MAP entered (§2.4i): 3 000 mm
    over station T's 600 (ratio 5, clamped to 4), T's pairing on the CHIRPS
    of unit t1, where it stands; under per-unit rain, so t1 (on station V,
    whose pairing is refused, three years in common) takes the catchment
    forcing on V's gaps, and t2 (no station) the §2.4h chain on the
    catchment's rain. One farm has no MAP, which the entered MAP makes moot."""
    start = dt.date(2011, 1, 1)
    n = (dt.date(2017, 12, 31) - start).days + 1
    t: list = _season(start, n, 0)
    for j in range(_idx(start, 2013, 5, 1), _idx(start, 2013, 6, 15)):
        t[j] = None
    v: list = _season(start, n, 2, 1.4)
    for j in range(_idx(start, 2015, 1, 1)):
        v[j] = None
    for j in range(_idx(start, 2016, 3, 1), _idx(start, 2016, 3, 20)):
        v[j] = None
    iso = start.isoformat()
    series: dict = {
        "rain_catchment_mm": {"startDate": iso, "values": _season(start, n, 5)},
        "rain_chirps_mm": {"startDate": iso, "values": [round(x * 0.7, 2) for x in _season(start, n, 6)]},
        "rain_station_mm#T": {"startDate": iso, "values": t},
        "rain_station_mm#V": {"startDate": iso, "values": v},
        "rain_chirps_mm@t1": {"startDate": iso, "values": [round(x * 1.2, 2) for x in _season(start, n, 1)]},
        "rain_chirps_station_mm#V": {"startDate": iso, "values": [round(x * 0.8, 2) for x in _season(start, n, 3)]},
    }
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("t1", "farm", "o", areaKm2=3, mapMm=900, **src),
        _node("t2", "farm", "o", areaKm2=2, mapMm=500, **src),
        _node("t3", "farm", "t2", areaKm2=1),
    ]
    rs = {
        "catchment": {"stationId": "T"}, "catchmentMapMm": 3000, "catchmentMapSource": "invented",
        "units": {"t1": {"stationId": "V"}}, "sites": {"T": {"unitId": "t1"}},
    }
    doc = _net(nodes, series, unitRain={"mode": "perUnit", "gaugeMapMm": 600, "gaugeMapSource": "invented"}, rainStations=rs)
    doc["stations"] = {"T": _station("T", 600), "V": _station("V", 750)}
    return doc


def station_catchment_reference() -> dict:
    """A §2.4h reference gauge on the catchment rain while the catchment
    runs on its station (§2.4i): every reader of the catchment rain sees
    station S × r (r = 900 ÷ 600 = 1.5) and "the stored rain_catchment_mm is
    not read", so the reference factors are fitted on S × 1.5 against unit
    r's CHIRPS cell. The stored gauge has another season (× 2 November to
    April, × 0.5 the rest), so fitting on it gives other factors: unit a0
    (no MAP: its CHIRPS × f alone) and a1 (MAP 700: f × k_unit, where only
    the factors' shape shows) both see the difference. Engine 1.91.0 first
    fitted on the stored gauge; fixed in the engine (86b2b80dc). S has an
    accumulation (January 2015) whose window the fit leaves out, as the
    pairing does."""
    start = dt.date(2010, 1, 1)
    n = (dt.date(2017, 12, 31) - start).days + 1
    stn: list = _season(start, n, 0, 1.2)
    for j in range(_idx(start, 2013, 3, 1), _idx(start, 2013, 3, 20)):
        stn[j] = None
    # An accumulation in S (January 2015, five blanks then 70 mm), which the reference fit leaves out.
    acc = _idx(start, 2015, 1, 20)
    for j in range(acc - 5, acc):
        stn[j] = None
    stn[acc] = 70.0
    stored = [None if v is None else round(v * (2.5 if (start + dt.timedelta(days=i)).month in WET else 0.4), 1) for i, v in enumerate(_season(start, n, 3))]
    iso = start.isoformat()
    series: dict = {
        "rain_catchment_mm": {"startDate": iso, "values": stored},
        "rain_chirps_mm": {"startDate": iso, "values": [round(v * 0.7, 2) for v in _season(start, n, 6)]},
        "rain_station_mm#S": {"startDate": iso, "values": stn},
        "rain_chirps_station_mm#S": {"startDate": iso, "values": [9.0 if acc - 5 <= i < acc else (0.0 if acc - 1 <= i <= acc + 1 else round(v * 0.9, 2)) for i, v in enumerate(_season(start, n, 1))]},
        "rain_chirps_cell_mm@r": {"startDate": iso, "values": [round(v * 0.8, 2) for v in _season(start, n, 2)]},
        "rain_chirps_mm@a0": {"startDate": iso, "values": [round(v * 0.6, 2) for v in _season(start, n, 4)]},
        "rain_chirps_mm@a1": {"startDate": iso, "values": [round(v * 1.1, 2) for v in _season(start, n, 5)]},
    }
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("r", "farm", "o", areaKm2=2, mapMm=650, **src),
        _node("a0", "farm", "o", areaKm2=3),
        _node("a1", "farm", "o", areaKm2=1.5, mapMm=700, **src),
    ]
    rs = {"catchment": {"stationId": "S"}, "catchmentMapMm": 900, "catchmentMapSource": "invented"}
    doc = _net(nodes, series, unitRain={"mode": "perUnit", "reference": {"gauge": "rain_catchment_mm", "unitId": "r"}}, rainStations=rs)
    doc["stations"] = {"S": _station("S", 600)}
    return doc


def station_catchment_window() -> dict:
    """The run window under the catchment's station (§2.4i: it "follows the
    station's record in the gauge's place"): the first and last day the
    catchment rain has a value. Station Q's record runs 2015-01-01 to
    2016-12-31, blank for its first ten days and unreliable for its last
    fifteen, and has no CHIRPS at it (refused), so the catchment CHIRPS
    (mid-2014 to mid-2017) corrects nothing and the window is Q's checked
    days, 2015-01-11 to 2016-12-16, not the stored record's span or the
    CHIRPS's. Random seeds 4, 5 and 12 first showed it."""
    start = dt.date(2014, 6, 1)
    n = (dt.date(2017, 6, 30) - start).days + 1
    q0 = _idx(start, 2015, 1, 1)
    qn = (dt.date(2016, 12, 31) - dt.date(2015, 1, 1)).days + 1
    q: list = _season(dt.date(2015, 1, 1), qn, 0, 1.1)
    for j in range(10):
        q[j] = None
    series: dict = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": _season(start, n, 5)},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": [round(v * 0.7, 2) for v in _season(start, n, 6)]},
        "rain_station_mm#Q": {"startDate": (start + dt.timedelta(days=q0)).isoformat(), "values": q},
    }
    src = {"mapSource": "invented"}
    nodes = [_node("o", "gauge", None), _node("g1", "farm", "o", areaKm2=2, mapMm=500, **src), _node("g2", "farm", "o", areaKm2=1, mapMm=800, **src)]
    rs = {"catchment": {"stationId": "Q"}, "unreliable": {"Q": [["2016-12-17", "2016-12-31"]]}}
    doc = _net(nodes, series, rainStations=rs)
    doc["stations"] = {"Q": _station("Q", 550)}
    return doc


def station_catchment_rule2(station_map=600) -> dict:
    """§2.4h rule 2 under the catchment's station (§2.4i "Rule 2's MAP
    ratio"): the catchment rain is station S × r, r = 900 ÷ 600 = 1.5, at
    the level S's MAP × r = 900 mm, so a rule-2 unit divides its MAP by 900,
    not by `gaugeMapMm` (450, which still switches rule 2 on). b1 (MAP 720:
    ratio 0.8, not 1.6) has nothing of its own; b2 (MAP 1 080: 1.2) has
    CHIRPS, which fills S's gaps (its §2.4b factors are off under the
    station, so raw × the ratio); both take the forecast tail × their ratio.
    b3 has no MAP (rule 4)."""
    start = dt.date(2011, 1, 1)
    n = (dt.date(2016, 12, 31) - start).days + 1
    stn: list = _season(start, n, 0, 1.2)
    for j in range(_idx(start, 2013, 3, 1), _idx(start, 2013, 3, 25)):
        stn[j] = None
    iso = start.isoformat()
    series: dict = {
        "rain_catchment_mm": {"startDate": iso, "values": _season(start, n, 3, 2.0)},
        "rain_chirps_mm": {"startDate": iso, "values": [round(v * 0.7, 2) for v in _season(start, n, 6)]},
        "rain_station_mm#S": {"startDate": iso, "values": stn},
        "rain_chirps_mm@b2": {"startDate": iso, "values": [round(v * 0.9, 2) for v in _season(start, n, 4)]},
        "rain_forecast_mm": {"startDate": "2017-01-01", "values": [3.0, 0.0, 8.0, 1.5, 0.0, 12.0]},
    }
    src = {"mapSource": "invented"}
    nodes = [
        _node("o", "gauge", None),
        _node("b1", "farm", "o", areaKm2=2, mapMm=720, **src),
        _node("b2", "farm", "o", areaKm2=1.5, mapMm=1080, **src),
        _node("b3", "farm", "o", areaKm2=1),
    ]
    rs = {"catchment": {"stationId": "S"}, "catchmentMapMm": 900, "catchmentMapSource": "invented"}
    doc = _net(nodes, series, unitRain={"mode": "perUnit", "gaugeMapMm": 450, "gaugeMapSource": "invented"}, rainStations=rs)
    doc["stations"] = {"S": _station("S", station_map)}
    return doc


def station_catchment_rule2_no_map() -> dict:
    """The same with no MAP on station S (§2.4i): the catchment rain's level
    is unknown, so rule 2 doesn't apply (b1 takes the catchment forcing, b2
    its CHIRPS), though `gaugeMapMm` is set; the catchment's own ratio is 1."""
    return station_catchment_rule2(None)


def daily_et0_monthly_pe(pe_kind: str = "monthly", zero_row: bool = False) -> dict:
    """A daily reference ET record under a monthly PE row (§2.4a, engine ≥
    1.104.0, issue #604 R5-E): on the days it has a value ≥ 0 GR4J's PE is the
    value as it stands; a missing day and a negative one fall back to the row's
    share of the month; the record ends before the run, so its last days are
    the row's. `pe_kind` "pan": the record is never read. `zero_row`: the row
    is 0, and the record alone gives GR4J evaporation (no GR4J_NO_PET)."""
    rain = [0.0, 12.0, 3.0, 0.0, 25.0, 0.0, 0.0, 8.0] * 8
    et0 = [5.0, 4.5, None, 6.25, -1.0, 3.0] * 8
    nodes = [_node("o", "gauge", None), _node("f", "farm", "o", areaKm2=5)]
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": rain},
        "evap_et0_mm": {"startDate": "2020-01-03", "values": et0},
    }
    row = [0] * 12 if zero_row else [150, 140, 120, 90, 60, 45, 40, 55, 80, 110, 130, 150]
    pe = {"kind": "monthly", "mm": row, "source": "invented climatology"} if pe_kind == "monthly" else {"kind": "pan"}
    s = _settings(pe=pe, gr4j={"x1": 200, "x2": 0, "x3": 60, "x4": 1.5, "warmupDays": 30})
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def _zone(gauge: str, gr4j: dict | None, enabled: bool = True) -> dict:
    return {
        "nodeId": gauge, "enabled": enabled, "calibrationStart": None, "calibrationEnd": None, "calibrationFlowKind": None,
        "calibrationExclusions": [], "qualityFlags": None, "gr4j": gr4j, "fitRecord": None,
    }


def calibration_zones_nested(zone_x2: float = -1.0) -> dict:
    """Calibration zones (§2.10n, engine 1.106.0, issue #555) one inside the
    other, under Per unit with the catchment's X2 at 0: u1 drains through
    the ticked gauges g1 then g2, so it takes g1's zone (the first ticked
    gauge on its way down), not g2's; u2 drains to g2 alone and takes g2's;
    u3 joins the outlet beside them, on the catchment's parameters. g1's
    zone has X2 = zone_x2, so the exchange series is written when that is
    not 0 although the catchment's X2 is; at 0 (the second probe) it is not
    written, though an unticked row on g3 holds an X2 of -2. Two years of
    invented rain on the catchment's own gauge."""
    start = dt.date(2019, 1, 1)
    n = (dt.date(2020, 12, 31) - start).days + 1
    nodes = [
        _node("o", "gauge", None),
        _node("g2", "gauge", "o"),
        _node("g1", "gauge", "g2"),
        _node("g3", "gauge", "o"),
        _node("u1", "farm", "g1", areaKm2=3),
        _node("u2", "farm", "g2", areaKm2=2),
        _node("u3", "farm", "g3", areaKm2=4),
    ]
    s = _settings(
        gr4j={"x1": 350, "x2": 0, "x3": 90, "x4": 1.7, "warmupDays": 200},
        unitRain={"mode": "perUnit", "gaugeMapMm": 600, "gaugeMapSource": "invented"},
        calibrationZones=[
            _zone("g1", {"x1": 120, "x2": zone_x2, "x3": 40, "x4": 1.2}),
            _zone("g2", {"x1": 900, "x2": 0, "x3": 250, "x4": 3.1}),
            _zone("g3", {"x1": 60, "x2": -2, "x3": 20, "x4": 0.8}, enabled=False),
        ],
    )
    series = {"rain_catchment_mm": {"startDate": start.isoformat(), "values": _wave(start, n, 0)}}
    return {"settings": s, "model": {"nodes": nodes, "crops": [], "cropAreas": [], "transfers": []}, "series": series}


def forecast_member_rescaled() -> dict:
    """A member of the forecast-conditioned outlook (issue #620, §2.15d) is an
    ordinary run: 91 days of recorded rain (January–March 2020), then a
    forecast tail for April and May made of the record's own first 61 days
    rescaled month by month, as a member whose analogue is that stretch: April
    × 1.5 (a wetter month than the analogue's), May × 0.4, and the tail's last
    week × 0 (a dry month asked to stay dry). Its dam, demand and EWR run on
    the tail as on any rain (§2.4a, §2.4f, §2.15)."""
    rain = [0.0, 14.0, 3.0, 0.0, 0.0, 22.0, 0.0, 6.5, 0.0, 0.0, 1.5, 9.0, 0.0] * 7
    factor = [1.5] * 30 + [0.4] * 24 + [0.0] * 7
    nodes = [
        _node("o", "gauge", None),
        _node("f", "farm", "o", areaKm2=4, damCapacityM3=150000, damInitialPct=0.3, damMinPct=0.05,
              pctUpstreamToDam=1, pctRunoffToDam=0.3),
    ]
    crops, areas = _crop("f", 400000)
    series = {
        "rain_catchment_mm": {"startDate": "2020-01-01", "values": rain},
        "rain_forecast_mm": {"startDate": "2020-04-01", "values": [r * k for r, k in zip(rain, factor)]},
    }
    s = _settings(ewrPragmaticM3PerDay=[400] * 12, effectiveRainFraction=0)
    return {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": []}, "series": series}


def _climate(doc: dict, rain: list[float], evap: list[float]) -> dict:
    """`doc` under a future climate (issue #621, §2.17): verify/'s scenarioOps
    field, which run_engine.ts applies with applyScenario and model.py itself."""
    op = {"op": "climate.delta", "rainFactorByMonth": rain, "evapFactorByMonth": evap, "label": "SYN-A ssp245 2036-2065", "source": "invented factors"}
    return {**doc, "scenarioOps": [op]}


# Invented factor rows, a different one each calendar month, both sides of 1, the clamp's ends included.
CLIMATE_RAIN = [0.8, 0.5, 1.1, 0.95, 1.5, 0.7, 1.25, 0.9, 1.05, 0.6, 1.2, 1.0]
CLIMATE_EVAP = [1.1, 1.2, 1.05, 1.0, 1.15, 1.3, 0.9, 1.08, 1.12, 1.5, 1.02, 0.95]


def climate_delta() -> dict:
    """A future climate on a dam, a crop and an EWR (§2.17): fourteen months
    of catchment rain with a gap CHIRPS fills and a no-data code, the monthly
    A-pan row under pan coefficient x A-pan, each calendar month at its own
    factor. Demand, dam evaporation, rain on the dam and GR4J all read the
    scaled inputs; the gap's CHIRPS keeps its bias factors (both series move
    by the same factor)."""
    start = dt.date(2019, 11, 1)
    n = (dt.date(2020, 12, 31) - start).days + 1
    catch: list = _wave(start, n, 0)
    for j in range(40, 55):
        catch[j] = None
    catch[200] = -9999.0
    series = {
        "rain_catchment_mm": {"startDate": start.isoformat(), "values": catch},
        "rain_chirps_mm": {"startDate": start.isoformat(), "values": [round(v * 0.8, 2) for v in _wave(start, n, 0)]},
    }
    nodes = [
        _node("o", "gauge", None),
        _node("f", "farm", "o", areaKm2=6, damCapacityM3=120000, damInitialPct=0.5, damMinPct=0.05,
              pctUpstreamToDam=1, pctRunoffToDam=0.4, damAreaFullM2=30000, returnFlowFraction=0.1, irrigationEfficiency=0.8),
    ]
    crops, areas = _crop("f", 300000)
    s = _settings(apanMm=[150, 190, 230, 240, 200, 170, 110, 80, 55, 55, 75, 105], lakeEvapFactor=0.75,
                  ewrPragmaticM3PerDay=[300] * 12, effectiveRainFraction=0.5)
    doc = {"settings": s, "model": {"nodes": nodes, "crops": crops, "cropAreas": areas, "transfers": []}, "series": series}
    return _climate(doc, CLIMATE_RAIN, CLIMATE_EVAP)


PROBES = {
    "forecast-tail-warmup": forecast_tail_warmup(),
    "band-and-room": band_and_room(),
    "room-while-sending": room_while_sending(),
    "accumulation-window-run": accumulation_window_run(),
    "outage-reading-set-aside": outage_reading_set_aside(),
    "short-blank-run-window": short_blank_run_window(),
    "flagged-zero-run-outage": flagged_zero_run_outage(),
    "low-vs-chirps-median": low_vs_chirps_median(),
    "negative-reading": negative_reading(),
    "zero-catchment-area": zero_catchment_area(),
    "binding-site-tie": binding_site_tie(),
    "scaled-no-demand-tail-year": scaled_no_demand_tail_year(),
    "full-allocation-tail-new-year": full_allocation_tail_new_year(),
    "trigger-hysteresis": trigger_hysteresis(),
    "junior-user": junior_user(),
    "priority-user-fixed-restriction": priority_user_fixed_restriction(),
    "offtake-keep-bands": offtake_keep_bands(),
    "cap-before-licence": cap_before_licence(),
    "offtake-into-capped-unit": offtake_into_capped_unit(),
    "cap-licence-from-september": cap_licence_from_september(),
    "full-allocation-gap-year": full_allocation_gap_year(),
    "offtake-release-keep-and-floor": offtake_release_keep_and_floor(),
    "dam-rules-rationing-and-release": dam_rules_rationing_and_release(),
    "transfer-out-of-catchment": transfer_out_of_catchment(),
    "transfer-out-of-catchment-cap": transfer_out_of_catchment_cap(),
    "unit-rain-rules": unit_rain_rules(),
    "unit-rain-forecast-warmup": unit_rain_forecast_warmup(),
    "unit-rain-map-period": unit_rain_map_period(),
    "unit-rain-no-land-unit": unit_rain_no_land_unit(),
    "unit-rain-reference": unit_rain_reference(),
    "unit-rain-reference-not-land": unit_rain_reference_not_land(),
    "baseflow-loss-and-gain": baseflow_loss_and_gain(),
    # Issue #500's decisions.
    "unit-rain-reference-kunit": unit_rain_reference_kunit(),
    "unit-rain-unusable-chirps": unit_rain_unusable_chirps(),
    "unit-rain-forecast-gefs": unit_rain_forecast_gefs(),
    "unit-rain-forecast-gefs-noref": unit_rain_forecast_gefs_noref(),
    "unit-rain-forecast-other": unit_rain_forecast_other(),
    "unit-rain-gauge-checks": unit_rain_gauge_checks(),
    "unit-rain-gauge-catchment-settings": unit_rain_gauge_catchment_settings(),
    "unit-rain-reference-checked": unit_rain_reference_checked(),
    "unit-rain-reference-unit-gauge-checked": unit_rain_reference_unit_gauge_checked(),
    "pool-storage-only": pool_storage_only(),
    # Rainfall stations (issue #553).
    "station-units": station_units(),
    "station-patch": station_patch(),
    "station-pairing-refused": station_pairing_refused(),
    "station-pairing-as-recorded": station_pairing_as_recorded(),
    "station-catchment": station_catchment(),
    "station-catchment-map": station_catchment_map(),
    "station-catchment-window": station_catchment_window(),
    "station-catchment-reference": station_catchment_reference(),
    "station-catchment-rule2": station_catchment_rule2(),
    "station-catchment-rule2-no-map": station_catchment_rule2_no_map(),
    # The EWR split (issue #553 round 4).
    "ewr-split-station-units": ewr_split_station_units(),
    "ewr-split-short-run": ewr_split_short_run(),
    "ewr-split-fragmentation": ewr_split_fragmentation(),
    "unit-shares-senior-user": unit_shares_senior_user(),
    # Daily reference ET (issue #604 R5-E).
    "daily-et0-monthly-pe": daily_et0_monthly_pe(),
    "daily-et0-pan-pe": daily_et0_monthly_pe("pan"),
    "daily-et0-zero-row": daily_et0_monthly_pe(zero_row=True),
    # The forecast-conditioned outlook's member (issue #620 step 6).
    "forecast-member-rescaled": forecast_member_rescaled(),
    # Future climate (issue #621, §2.17): the op on a dam, then on the per-unit rules (the MAPs by the annual
    # factor: rule 3's level moves, rule 2's ratio doesn't), the stations' MAPs and a monthly PE row with daily ET.
    "climate-delta": climate_delta(),
    "climate-delta-unit-map": _climate(unit_rain_rules(), CLIMATE_RAIN, CLIMATE_EVAP),
    "climate-delta-stations": _climate(station_units(), CLIMATE_RAIN, CLIMATE_EVAP),
    "climate-delta-monthly-pe": _climate(daily_et0_monthly_pe(), CLIMATE_RAIN, CLIMATE_EVAP),
    # Calibration zones (issue #555).
    "calibration-zones-nested": calibration_zones_nested(),
    "calibration-zones-no-exchange": calibration_zones_nested(0.0),
}
