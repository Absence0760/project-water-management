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
    blank stretch is 7 days, not more, so it counts like zeros and the 11-day
    run is a window; the total is spread by CHIRPS (2 mm a day over the run,
    none on the reading day ± 1). With 8 blanks it would be an outage and the
    reading would be set aside instead."""
    days = 60
    reading = 30
    catch = [0.0] * days
    for j in range(reading - 7, reading):
        catch[j] = None
    catch[reading] = 40.0
    ch = [0.0] * days
    for j in range(reading - 11, reading - 1):
        ch[j] = 2.0
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


PROBES = {
    "forecast-tail-warmup": forecast_tail_warmup(),
    "band-and-room": band_and_room(),
    "room-while-sending": room_while_sending(),
    "accumulation-window-run": accumulation_window_run(),
    "outage-reading-set-aside": outage_reading_set_aside(),
    "short-blank-run-window": short_blank_run_window(),
    "low-vs-chirps-median": low_vs_chirps_median(),
    "negative-reading": negative_reading(),
    "zero-catchment-area": zero_catchment_area(),
    "binding-site-tie": binding_site_tie(),
    "scaled-no-demand-tail-year": scaled_no_demand_tail_year(),
    "full-allocation-tail-new-year": full_allocation_tail_new_year(),
    "trigger-hysteresis": trigger_hysteresis(),
    "junior-user": junior_user(),
    "offtake-keep-bands": offtake_keep_bands(),
    "cap-before-licence": cap_before_licence(),
    "offtake-into-capped-unit": offtake_into_capped_unit(),
    "cap-licence-from-september": cap_licence_from_september(),
    "full-allocation-gap-year": full_allocation_gap_year(),
    "offtake-release-keep-and-floor": offtake_release_keep_and_floor(),
    "dam-rules-rationing-and-release": dam_rules_rationing_and_release(),
}
