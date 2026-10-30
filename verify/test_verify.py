"""The cross-check's guard (`pnpm test:verify`, CI job `verify`):

- the engine and verify/model.py agree on the example catchments, the probes,
  VERIFY_TEST_RANDOM random networks (default 12; CI runs more) and
  VERIFY_TEST_DENSE dense ones (every phase-2a feature in most; default 12);
- the harness can see each rule it claims to check: every mutant below (a
  one-line change to model.py that breaks one documented rule) must disagree
  with the engine somewhere, or the cases don't exercise that rule;
- the generator stays inside phases 1 and 2a and is a pure function of its seed.

The agreement sweep, the engine runs and the mutants run on VERIFY_WORKERS
processes (default the cores, at most 4); every case is a fixed seed and the
results are merged in case order, so the worker count never changes them.
VERIFY_SHARD=k/K splits the mutants K ways (CI runs K jobs; see shard()).

Run: python3 -u verify/test_verify.py (pnpm test:verify), or
python3 -m unittest discover -s verify
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import diff  # noqa: E402
import generate  # noqa: E402
import model  # noqa: E402

MUTANT_RANDOM = 12
MUTANT_DENSE = 12


def shard() -> tuple[int, int]:
    """VERIFY_SHARD=k/K (default 1/1): CI's verify job runs K of these at once.
    Shard 1 runs the agreement sweep (all of it: its coverage check needs every
    case) and the determinism check; every shard runs every K-th mutant from
    the k-th, each on the same cases, so together they run each mutant once."""
    k, _, n = os.environ.get("VERIFY_SHARD", "1/1").partition("/")
    k, n = int(k), int(n or 1)
    if not 1 <= k <= n:
        raise ValueError(f"VERIFY_SHARD={k}/{n}: want k/K with 1 <= k <= K")
    return k, n


SHARD, SHARDS = shard()

# (what the mutant breaks, text in model.py, replacement), or (what, (text,
# replacement), …) for a mutant of several edits, applied in order. Each
# text must occur exactly once when its edit is applied.
MUTANTS = [
    (
        "a blank stretch of any length is a run (before engine 1.70.0, Q31)",
        "if n > ACC_MAX_BLANK_DAYS:",
        "if False:",
    ),
    (
        "days of 0 count towards an accumulation's run like blanks (before engine 1.84.0, issue #523 A2)",
        "while j >= 0 and blank(j):",
        "while j >= 0 and (blank(j) or c.values[j] == 0):",
    ),
    (
        "a flagged zero run set aside as missing ends an accumulation's run, so its CHIRPS fill and the reading both count (issue #523 A2)",
        "missing_days | flagged_blank)",
        "missing_days)",
    ),
    (
        "a flagged zero-rain day is filled whatever CHIRPS reads (before engine 1.81.0, B2)",
        'set_aside = ((flagged_days - kept_dry - chirps_dry) if mode == "missing" else set()) | missing_days',
        'set_aside = ((flagged_days - kept_dry) if mode == "missing" else set()) | missing_days',
    ),
    (
        "a reading after a blank outage stays on its day (Q31)",
        "set_aside |= set(outage_readings)",
        "pass",
    ),
    (
        "a blank stretch of exactly 7 days ends the run (Q31 limit off by one)",
        "if n > ACC_MAX_BLANK_DAYS:",
        "if n >= ACC_MAX_BLANK_DAYS:",
    ),
    ("transfers ignore the receiver's room (N4)", "room_left[dst] = max(0.0, rm)", "room_left[dst] = math.inf"),
    ("a transfer out of the catchment moves nothing, as if outside had no room (engine 1.86.0, issue #523 B5)", 'room_left[("out", src)] = math.inf', 'room_left[("out", src)] = 0.0'),
    (
        "an allocation cap doesn't hold back a transfer out of the catchment (engine-audit.md X1)",
        'room_left[("out", src)] = max(0.0, sr_[0] - rm_ask.get(src, 0.0) - ext_out[src])',
        'room_left[("out", src)] = math.inf',
    ),
    (
        "a transfer out of the catchment isn't counted against its source's cap (engine-audit.md X1)",
        'spend(xid, "surface", G - GW + g_riv + gin + gx)',
        'spend(xid, "surface", G - GW + g_riv + gin)',
    ),
    (
        "a source's rules share one pool down to the lowest reserve (N6, before engine 1.36.0)",
        'elig = [t for t in from_src if reserve[t["id"]] <= level and left[t["id"]] > 0]',
        'elig = [t for t in from_src if left[t["id"]] > 0]',
    ),
    (
        "the receiver's room leaves out its dam's own rain, evaporation and seepage (before engine 0.19.0)",
        "(storage[dst] + pd + sched[dst] - e_c - sp_c)",
        "storage[dst]",
    ),
    ("a run with no catchment area runs (on 0 m³ of natural flow)", "    if not area_km2 > 0:\n        raise Refused", "    if False:\n        raise Refused"),
    ("the receiver's room counts what it sent earlier the same day", "- sched[dst]\n", "- sched[dst] + drawn[dst]\n"),
    ("no soil-water store (N3)", "w = min(smax, max(0.0, available - used))", "w = 0.0"),
    ("flagged zero runs run as recorded (B2)", 'mode = zr.get("mode", "missing")', 'mode = "asRecorded"'),
    ("accumulations stay on their reading day (B4)", 'if acc_mode == "spread":', "if False:"),
    (
        "an outage reading's run test reads CHIRPS over the whole outage, not its last 92 days",
        "sum(ch(o) for o in run_days if o != r - 1)",
        "sum(ch(o) for o in range(r - max(k, outage), r) if o != r - 1)",
    ),
    (
        "the usual low-vs-CHIRPS ratio of an even count is the upper middle year",
        "usual = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2",
        "usual = vals[n // 2]",
    ),
    ("CHIRPS fills gaps raw (B1)", 'bias_on = settings["chirpsBiasCorrection"] == "monthly"', "bias_on = False"),
    (
        "a negative catchment reading lets CHIRPS fill the day",
        "            v = c.get(o)\n            if v is not None:\n                return v, 0",
        "            v = c.get(o)\n            if v is not None and v >= 0:\n                return v, 0",
    ),
    ("a tied binding site goes to the most upstream site", "sd < cur[1]", "sd > cur[1]"),
    ("seepage never returns to the river", "+ T + Sp * ret + X", "+ T + X"),
    ("irrigation ignores the dam's minimum operating level (Q5)", 'dead = cap * (x.get("damMinPct") or 0.0)', "dead = 0.0"),
    (
        "the attribution leaves out the internal transfers (Q17 J_int)",
        "if a in mset and b in mset:",
        "if False:",
    ),
    ("rain equal to the threshold offsets demand", "v if v > thr else 0.0", "v if v >= thr else 0.0"),
    ("the warm-up cycles the forecast tail too", "            hist = tail[0]\n", "            pass\n"),
    (
        "planting efficiencies are ignored (farm e only)",
        "if not any(own(c, p) is not None for c, a, p in rows if a > 0):",
        "if True:",
    ),
    ("a unit's own system on a planting is ignored (the crop's default only)", 'for sid in (planting.get("irrigationSystemId"), crop.get("irrigationSystemId")):', 'for sid in (crop.get("irrigationSystemId"),):'),
    ("a crop's default system is ignored", 'for sid in (planting.get("irrigationSystemId"), crop.get("irrigationSystemId")):', 'for sid in (planting.get("irrigationSystemId"),):'),
    ("the project's systems table is ignored (the SABI defaults)", 'if model.get("irrigationSystems") else dict(DEFAULT_SYSTEMS)', 'if False else dict(DEFAULT_SYSTEMS)'),
    ("GR4J's PE uses the 28.25-day February", "pet.append(monthly / calendar_days_in_month(o))", "pet.append(monthly / mdays[m])"),
    ("dam evaporation uses calendar days", "e_raw = k_lake[m] * apan[m] / mdays[m] / 1000 * area", "e_raw = k_lake[m] * apan[m] / calendar_days_in_month(o) / 1000 * area"),
    ("return flow is the whole loss (r ignored, N1)", "T = r_ret * G", "T = (1 - d[\"e\"]) * G"),
    ("return flow above the losses is not capped at 1 − e (engine 1.71.0)", 'r_ret = (1 - d["e"]) if r_ret > 1 - d["e"] + 1e-9 else max(r_ret, 0)', "r_ret = max(r_ret, 0)"),
    ("GR4J's routing store gets no exchange", "r = max(0.0, self.r + q9 + f)", "r = max(0.0, self.r + q9)"),
    # Phase 2a.
    # Boreholes and stream depletion (§2.7d).
    ("a borehole's annual cap is ignored", 'room = min(room, u["annual"] - used)', "room = room"),
    ("stream depletion has no lag", "alpha = 1.0 if k == 0 else 1 - math.exp(-1 / k)", "alpha = 1.0"),
    ("depletion the river can't pay is forgiven", "dd_owed[xid] = dd_owed[xid] + due - dep", "dd_owed[xid] = 0.0"),
    (
        "an emergency borehole ignores the dam's level",
        'if u_["target"] == "direct" and u_["mode"] == "emergency" and s_prev < u_["level"] * cap:',
        'if u_["target"] == "direct" and u_["mode"] == "emergency":',
    ),
    (
        "supplemental boreholes pump before the dam",
        '            if rule_ == "runOfRiver":\n                Gs = max',
        '            for k_, u_ in enumerate(ulist):\n                if u_["target"] == "direct" and u_["mode"] == "supplemental":\n                    GW += pump(k_, rem - Gr - GW)\n            if rule_ == "runOfRiver":\n                Gs = max',
    ),
    (
        "annual counts (borehole caps, allocations) never reset on 1 October",
        "if i == 0 or (_dt.date.fromordinal(o).month == 10 and _dt.date.fromordinal(o).day == 1):",
        "if i == 0:",
    ),
    # Allocations and the licence cap (§2.12a).
    (
        "the cap's volume isn't prorated by the allocation's dates",
        'b += a["volume"] * overlap_days(wy, a["from"], a["to"]) / wy_length(wy)',
        'b += a["volume"]',
    ),
    (
        "a day with no licence in force is capped at 0 when the year has none (engine 1.69.0)",
        "            if not any(a[\"from\"] <= o <= a[\"to\"] for a in lst):\n                room[(nid, s)] = (math.inf, math.inf, math.inf, math.inf)\n                continue\n",
        "",
    ),
    (
        "the cap holds from 1 October of a licence's first year, counting the use before its start (the first 1.70.0 draft)",
        'if not any(a["from"] <= o <= a["to"] for a in lst):',
        'if not any(overlap_days(wy, a["from"], a["to"]) > 0 for a in lst):',
    ),
    (
        "use on a day with no licence in force counts against the year's volume",
        "        if not math.isfinite(room[(nid, src)][3]):\n            return\n",
        "",
    ),
    (
        "a full allocation scales a year with no licence in force to 0 (before engine 1.70.0)",
        "fac_y[y] = 1.0",
        "fac_y[y] = 0.0",
    ),
    (
        "an off-take into a capped unit sizes to its whole demand (before engine 1.70.0)",
        "need = min(dam_dem(dst, i), max(0.0, sr_[0] - ext_out[dst]) if sr_ else math.inf)",
        "need = dam_dem(dst, i)",
    ),
    ("the licence rate ignores its months", 'if a["months"] and m not in a["months"]:\n            continue', "if False:\n            continue"),
    ("the rate limit is ignored", '        lim += a["rate"] * 86400\n', '        return math.inf\n'),
    (
        "every limit-bound day counts as the volume",
        "if left <= limit + 1e-9 * max(budget, 1.0):",
        "if True:",
    ),
    (
        "a full allocation scales to the surface allocations only",
        'both = sorted(bysrc.get("surface", []) + bysrc.get("groundwater", []), key=lambda a: a["id"])',
        'both = sorted(bysrc.get("surface", []), key=lambda a: a["id"])',
    ),
    ("the tail-start year's no-demand row lists k × demand, 0", "if dem_y.get(y, 0.0) > 0:", "if dem_y.get(y, 0.0) > 0 or y == tail_y:"),
    (
        "a forecast tail's later water years keep the factor of the year it started in",
        ("if i >= hist and water_year(days[i]) == tail_y:\n                    continue", "if i >= hist:\n                    continue"),
        ("ks.append(fac_y.get(y, 0.0))", "ks.append(fac_y.get(tail_y if i >= hist else y, 0.0))"),
    ),
    # Demand objects and the basic-needs floor (§2.7f).
    (
        "a demand factor cuts below the basic-needs floor",
        "if B is not None and f_ < 1:\n                    if min",
        "if False:\n                    if min",
    ),
    ("a per-unit object's losses aren't added", "/ (1 - loss) for m in range(12)]", "for m in range(12)]"),
    ("the first schedule window wins, not the last", "    for w in sched:\n", "    for w in reversed(sched):\n"),
    (
        "'first' objects share with the crop",
        ("        return (0, object_rank(ob))", "        return (1, 0)"),
    ),
    ("ranks within a class are ignored", "        return int(r)\n    return 1", "        return 1\n    return 1"),
    # River abstractions beside a unit's dam (§2.7j).
    ("a river abstraction takes what must pass the unit", "free = max(0.0, past - keep)", "free = max(0.0, past)"),
    ("a river abstraction's pool never refills", "if rsum > 0 and free > 0:", "if False:"),
    ("a river abstraction's pool evaporates (engines before 1.86.0)", "held = list(q)", "held = [v * 0.99 for v in q]"),
    # River off-takes and canal seepage (§2.6a).
    ("the canal loses nothing on the way", "append((t, v * (1 - lp)))", "append((t, v))"),
    (
        "a demand-sized off-take isn't grossed up for its loss",
        'v = min(v, ot_need.get(t["id"], 0.0) / (1 - (t.get("lossPct") or 0.0)))',
        'v = min(v, ot_need.get(t["id"], 0.0))',
    ),
    (
        "an off-take ignores its hands-off flow",
        'keep_k = max(zs, pass_target if pass_target is not None else 0.0, hk if hk is not None else 0.0, z if t.get("handsOffEwr") else 0.0)',
        'keep_k = max(zs, pass_target if pass_target is not None else 0.0)',
    ),
    (
        "an off-take takes its source's pass-inflow release target (before engine 1.70.0)",
        'keep_k = max(zs, pass_target if pass_target is not None else 0.0, hk if hk is not None else 0.0, z if t.get("handsOffEwr") else 0.0)',
        'keep_k = max(zs, hk if hk is not None else 0.0, z if t.get("handsOffEwr") else 0.0)',
    ),
    (
        "off-takes of one priority ask MIN(limit, the flow above their keep) (before engine 1.70.0)",
        "                    v = lim\n",
        "                    v = min(max(0.0, U0 - taken - keep_k), lim)\n",
    ),
    (
        "dam rules of one priority ask MIN(limit, their source's free water) (before engine 1.70.0)",
        'rem[t["id"]] = lim',
        'rem[t["id"]] = min(lim, max(0.0, storage[src["id"]] - drawn[src["id"]] - reserve[t["id"]]))',
    ),
    (
        "a receiver's room is shared by what the rules ask, not what their sources gave (wasted room)",
        "                basis = given\n",
        "                basis = rem\n",
    ),
    ("room a source couldn't fill is never offered again (one round)", "                if not filled:\n                    break\n", "                break\n"),
    (
        "an off-take's top-up counts only a fixed release's floor (before engine 1.70.0)",
        'floor_ot = max(0.0, min(f["damReleaseM3Day"][m], math.inf if outlet_o is None else outlet_o))',
        'floor_ot = max(0.0, min(f["damReleaseM3Day"][m], math.inf if outlet_o is None else outlet_o, max(held, 0.0) - e_c - sp_c - f["damCapacityM3"] * (f.get("damMinPct") or 0.0)))',
    ),
    (
        "a dam rule's room counts only a fixed release's floor (before engine 1.70.0)",
        'floor_rel = max(0.0, min(f["damReleaseM3Day"][m], math.inf if outlet_c is None else outlet_c))',
        'floor_rel = max(0.0, min(f["damReleaseM3Day"][m], math.inf if outlet_c is None else outlet_c, after - drawn[dst] - f["damCapacityM3"] * (f.get("damMinPct") or 0.0)))',
    ),
    (
        "a fixed release makes no room for an off-take's top-up (before engine 1.70.0)",
        'rm_dst = max(0.0, f["damCapacityM3"] - (storage[dst] + pd + sched[dst] - e_c - sp_c) + floor_ot)',
        'rm_dst = max(0.0, f["damCapacityM3"] - (storage[dst] + pd + sched[dst] - e_c - sp_c))',
    ),
    (
        "off-takes of one priority share the flow above the lowest keep among them",
        "band = max(0.0, top - floor)",
        "band = max(0.0, top - keeps[act[-1]])",
    ),
    ("canal seepage always returns at the source", 'rn = t.get("lossReturnNodeId") or xid', "rn = xid"),
    ("off-take water left over always tops up the dam", "to_dam = left_off * arr_up / arrives if arrives > 0 else 0.0", "to_dam = left_off"),
    # Other water users (§2.7c).
    ("a junior user takes the seniors' water", 'river = H if x.get("userPriority", "senior") != "junior" else max(0.0, H - zs_in)', "river = H"),
    ("a user returns nothing", 'T = (x.get("userReturnPct") or 0.0) * G', "T = 0.0"),
    ("farms pass nothing for senior users", "need = min(zs, H + Ib)", "need = 0.0"),
    # Supply rules and the river pump (§2.7e).
    ("the trigger rule has no stop level", "on = s_prev < stop * cap if on_river[xid] else s_prev < trig * cap", "on = s_prev < trig * cap"),
    ("the river pump has no capacity", 'pc = math.inf if pc is None else pc', "pc = math.inf"),
    ("the river pump takes the water kept for others", "proom = max(0.0, min(pc, S - keep)) if on else 0.0", "proom = max(0.0, min(pc, S)) if on else 0.0"),
    # Dam survey curves and releases (§2.7a).
    ("the survey curve is ignored", 'curve = usable_curve(f.get("damCurve"))', "curve = None"),
    ("a pass-inflow release ignores the outlet", "min(K + M + O, pass_target - S, outlet_c, avail)", "min(K + M + O, pass_target - S, avail)"),
    ("a fixed release draws dead storage", "min(float(amts[m]), outlet_c, avail - dead)", "min(float(amts[m]), outlet_c, avail)"),
    (
        "a fixed release makes no room for transfers",
        'rm = f["damCapacityM3"] - after + draw_bound(dst) + floor_rel - sched[dst]',
        'rm = f["damCapacityM3"] - after + draw_bound(dst) - sched[dst]',
    ),
    # Hands-off flows and River to dam by month (§2.7h).
    ("a dam farm diverts through its hands-off flow", "O = min(O, max(0.0, L + N - keep_h))", "pass"),
    (
        "the hands-off flow ignores the EWR flag",
        'keep_h = max(float(ho[m]) if ho else 0.0, z if x.get("handsOffEwr") else 0.0)',
        "keep_h = float(ho[m]) if ho else 0.0",
    ),
    (
        "a dam on the river takes River to dam",
        "                dcap = 0.0  # a dam on the river takes no River to dam (§2.7 row O, engine >= 1.68.0)",
        "                pass",
    ),
    (
        "River to dam by month is ignored",
        'dcap = float(dm[m]) if dm else (x.get("divertCapacityM3Day") or 0.0)',
        'dcap = x.get("divertCapacityM3Day") or 0.0',
    ),
    # Bed losses in the reaches (§2.6b).
    ("bed losses are left in the river", "                    H += U[u] - lost", "                    H += U[u]"),
    ("bed losses ignore the daily cap", "return min(c_, f_ * q) if q > 0 else 0.0", "return f_ * q if q > 0 else 0.0"),
    ("a senior claim is not grossed up for the reaches on the way", "                sen_y[fid][i] += v", "                sen_y[fid][i] += Dn[u[\"id\"]][i] * shares.get(fid, 0.0) / tot"),
    (
        "the senior requirement crosses a reach whole",
        "                zs_in += ZS[u] - min(ZS[u], sen_led[u][i]) if u in sen_led else ZS[u]",
        "                zs_in += ZS[u]",
    ),
    # A unit's base-flow loss and gain (§2.6b, engine 1.86.0).
    ("a base-flow loss is not capped at the runoff", "                lost_bf = min(bl_, I) if I > 0 else 0.0", "                lost_bf = bl_"),
    ("the base-flow gain is left out of the runoff", "                Ib = I - lost_bf + bg_", "                Ib = I - lost_bf"),
    ("the runoff split reads the runoff before the base flow", '                M = Ib * x["pctRunoffToDam"]', '                M = I * x["pctRunoffToDam"]'),
    # Runoff from each unit's own rain (§2.4h, engine 1.78.0).
    # Per unit is the only method (engine 1.109.0, issue #658): the retired catchment mode and an absent setting run it.
    ("the retired Fragmentation still runs when unitRain is absent, null or catchment (before engine 1.109.0)", "    per_unit = True\n", '    per_unit = (settings.get("unitRain") or {}).get("mode") == "perUnit"\n'),
    ("a unit's local inflow is natural × share, not its own runoff", "I = natural[i] * shares.get(xid, 0.0) if local is None else", "I = natural[i] * shares.get(xid, 0.0) if True else"),
    ("the catchment area is catchmentAreaKm2 under per-unit rain", "if per_unit or area_km2 is None:", "if area_km2 is None:"),
    ("per-unit rain with no land unit is refused", "        per_unit = False\n", '        raise Refused("catchment area is 0")\n'),
    ("the catchment's GR4J series weight every unit alike", 'acc["rain"][i] += a * pu[i]', 'acc["rain"][i] += pu[i] * area_km2 / len(units)'),
    ("a unit's warm-up cycles the forecast tail", "                i = k % hist if hist > 0 else 0\n                gu.step", "                i = k % n if n > 0 else 0\n                gu.step"),
    ("a unit's gauge record of blanks and no-data codes picks rule 1", "has_g = any(valid(v) for v in own_g.values)", "has_g = bool(own_g)"),
    ("a unit's own negative gauge value is a reading", 'g = {"startDate": raw["startDate"], "values": [v if valid(v) else None for v in raw["values"]]}', 'g = {"startDate": raw["startDate"], "values": list(raw["values"])}'),
    ("a unit with CHIRPS takes it before the gauge × its MAP ratio", "        elif cond2:\n            rule = 2", "        elif cond2 and not has_c:\n            rule = 2"),
    ("the gauge MAP ratio isn't clamped", "ratio = _clamp(map_mm / gauge_level, diag) if cond2", "ratio = map_mm / gauge_level if cond2"),
    ("the CHIRPS MAP factor isn't clamped", "lev_f = _clamp(map_mm / mean, diag)", "lev_f = map_mm / mean"),
    ("the CHIRPS MAP factor ignores the MAP period", "use = inside if len(inside) >= UNIT_MAP_MIN_YEARS else years", "use = years"),
    ("the CHIRPS MAP factor takes the period's years however few", "use = inside if len(inside) >= UNIT_MAP_MIN_YEARS else years", "use = inside or years"),
    ("the CHIRPS MAP factor counts incomplete years", "            if not valid(v):\n                ok = False\n                break\n", "            if not valid(v):\n                continue\n"),
    ("a unit's CHIRPS without a MAP runs raw (no §2.4b factors)", "has_bias = any(f is not None for f in fac[1:])", "has_bias = False"),
    ("rule 1 skips the unit's CHIRPS", "chain = [own, lev] +", "chain = [own] +"),
    ("rule 2 never falls to the unit's CHIRPS", "else v * r, lev]", "else v * r]"),
    ("the gauge rain G includes the CHIRPS infill", "            return v if src == 0 else None", "            return v"),
    ("a negative catchment reading lets the unit's CHIRPS fill a gauge-MAP day", "            return v if src == 0 else None", "            return v if src == 0 and v >= 0 else None"),
    ("the catchment's rain fills a unit's gap × 1, not × its MAP ratio", "                    v = cr * ratio", "                    v = cr"),
    # The reference gauge (§2.4h, engine 1.80.0, issue #500).
    ("the reference factor isn't clamped", "out.append(_clamp(g[m] / c[m], diag))", "out.append(g[m] / c[m])"),
    ("the reference fit takes 89 shared days", "if n[m] >= 90 and c[m] >= 50:", "if n[m] >= 89 and c[m] >= 50:"),
    ("the reference fit takes a month under 50 mm of CHIRPS", "if n[m] >= 90 and c[m] >= 50:", "if n[m] >= 90:"),
    ("a no-data code is a reading in the reference fit", "if valid(cv) and valid(gv):", "if cv is not None and gv is not None:"),
    ("a reference unit without land still sets the factors (1)", '        diag["unit_ref_not_land"] += 1\n        return None', '        return [None] + [1.0] * 12, {}'),
    # Issue #500's decisions (operator, 2026-10-09).
    ("no k_unit on the reference factors (item 1a)", "return kinded(lambda v, o, k=k: v * f[cal_month(o)] * k, kind)", "return kinded(lambda v, o, k=k: v * f[cal_month(o)], kind)"),
    ("k_unit from the raw CHIRPS mean, not CHIRPS × f (item 1a)", "mean = unit_chirps_mean(own_c, period, lambda o: f[cal_month(o)], diag)", "mean = unit_chirps_mean(own_c, period, None, diag)"),
    ("k_unit isn't clamped (item 2)", "k = _clamp(map_mm / mean, diag)", "k = map_mm / mean"),
    ("the CHIRPS mean takes the MAP period from 9 complete years (item 4: 10)", "UNIT_MAP_MIN_YEARS = 10", "UNIT_MAP_MIN_YEARS = 9"),
    ("the CHIRPS mean needs 11 complete years in the MAP period (item 4: 10)", "UNIT_MAP_MIN_YEARS = 10", "UNIT_MAP_MIN_YEARS = 11"),
    (
        "CHIRPS averaging 0 mm is levelled by the old fallback, not skipped (item 7a, no reference)",
        '    mean = unit_chirps_mean(own_c, period, None, diag)\n    if mean is not None and not mean > 0:\n        diag["unit_chirps_unusable"] += 1\n        return None\n',
        "    mean = unit_chirps_mean(own_c, period, None, diag)\n    if mean is not None and not mean > 0:\n        mean = None\n",
    ),
    (
        "CHIRPS averaging 0 mm runs on the reference factors alone (item 7a, with a reference)",
        '        if mean is not None and not mean > 0:\n            diag["unit_chirps_unusable"] += 1\n            return None\n',
        "        if mean is not None and not mean > 0:\n            mean = None\n",
    ),
    (
        "only a unit with a MAP can have unusable CHIRPS (item 7a)",
        "    mean = unit_chirps_mean(own_c, period, None, diag)\n    if mean is not None and not mean > 0:",
        "    mean = unit_chirps_mean(own_c, period, None, diag)\n    if mean is not None and not mean > 0 and map_mm is not None:",
    ),
    ("a CHIRPS-GEFS forecast keeps the MAP ratio (item 5)", 'gefs = forecast_source == "chirps_gefs"', "gefs = False"),
    ("an uploaded forecast is levelled like CHIRPS too (item 5)", 'gefs = forecast_source == "chirps_gefs"', "gefs = forecast_source is not None"),
    (
        "a gauge gap filled from a level short of the MAP drops the MAP ratio",
        'return level(v, o) * (ratio if level.kind == "shape" else 1.0)',
        "return level(v, o)",
    ),
    (
        "a CHIRPS-GEFS forecast on a level short of the MAP drops the MAP ratio (item 5)",
        'v = level(cr, o) * (1.0 if level.kind == "map" else ratio)',
        "v = level(cr, o)",
    ),
    (
        "a unit's own gauge is read as recorded, without the catchment's checks (item 6)",
        'own = unit_gauge_checked(settings, series, f"rain_catchment_mm@{uid}", diag) if has_g else (lambda o: None)',
        "own = (lambda o, s_=own_g: v if valid(v := s_.get(o)) else None) if has_g else (lambda o: None)",
    ),
    ("a unit gauge's accumulations aren't spread (item 6)", 'zr = {**settings["zeroRainRuns"], "missing": []', 'zr = {**settings["zeroRainRuns"], "accumulationMode": "asRecorded", "missing": []'),
    ("the catchment's listed missing periods blank a unit gauge's days (engine 1.85.0)", 'zr = {**settings["zeroRainRuns"], "missing": [], ', 'zr = {**settings["zeroRainRuns"], '),
    ("a unit gauge without CHIRPS of its own is checked against none (engine 1.85.0)", 'or series.get("rain_chirps_mm")\n', "\n"),
    ("the reference fit keeps the catchment gauge's accumulation windows (engine 1.85.0)", 'out_of_fit = rain["fit_window_days"]', "out_of_fit = set()"),
    ("the reference fit keeps a unit gauge's accumulation windows (engine 1.85.0)", 'out_of_fit = prep["fit_window_days"] if for_fit else set()', "out_of_fit = set()"),
    ("the reference fit reads the gauge as stored (item 1c)", "gv = gauge(o)", "gv = stored.get(o)"),
    # Rainfall stations (§2.4i, engine 1.91.0, issue #553).
    ("a station's MAP ratio isn't clamped", "        f = area_map / st_map\n        r = min(FACTOR_MAX, max(FACTOR_MIN, f))", "        f = area_map / st_map\n        r = f"),
    ("scaleToMap false still scales by the MAP ratio", 'if a.get("scaleToMap") is False:', "if False:"),
    ("a station's MAP ratio is 1 whatever the MAPs", "        f = area_map / st_map\n", "        f = 1.0\n"),
    ("an area's gap days take its corrected CHIRPS × the MAP ratio too", 'return w * f[cal_month(o)], "chirps"', 'return w * f[cal_month(o)] * r, "chirps"'),
    ("an area's gap days take its raw CHIRPS (no pairing factors)", 'return w * f[cal_month(o)], "chirps"', 'return w, "chirps"'),
    ("a unit's station gaps beyond its CHIRPS are dry, not the catchment forcing", "                    v = p_used[i]\n", "                    v = 0.0\n"),
    ("correctAgainst is ignored (the area's own station corrects it)", 'against = a.get("correctAgainst") or sid', "against = sid"),
    # The pairing per area and the patching priority (issue #612, engine 1.105.0).
    ("a pairing's station rain isn't taken to the area's MAP (no × r)", "            g[m] += sv * r\n", "            g[m] += sv\n"),
    ("a pairing reads the CHIRPS at the station, not the area's", "f = self.pairing(against, area_id, chirps, self.ratio(a, against, area_map))", "f = self.pairing(against, area_id, (self.record(against).at if self.record(against) else None) or chirps, self.ratio(a, against, area_map))"),
    ("a pairing is the station's alone, shared by every area", "        key = (sid, area_id)\n", "        key = (sid, None)\n"),
    ("the patching priority is ignored (CHIRPS alone)", 'for p in resolve_patch(a.get("patch"), sid):', 'for p in ["chirps"]:'),
    ("a patch station is read at the main station's ratio", 'links.append(("patch", (prec, self.ratio(a, p, area_map))))', 'links.append(("patch", (prec, r)))'),
    ("a patch station without a MAP is read × 1 under scaling", '            if prec is None or (a.get("scaleToMap") is not False and (self.stations.get(p) or {}).get("mapMm") is None):', "            if prec is None:"),
    ("the patching priority's order is ignored (CHIRPS before the stations)", "            for kind, f in links:\n", '            for kind, f in sorted(links, key=lambda l: l[0] != "chirps"):\n'),
    ("a pairing takes 4 complete years in common (5)", "STATION_PAIRING_MIN_YEARS = 5", "STATION_PAIRING_MIN_YEARS = 4"),
    ("a pairing needs 6 complete years in common (5)", "STATION_PAIRING_MIN_YEARS = 5", "STATION_PAIRING_MIN_YEARS = 6"),
    ("a pairing keeps the station's accumulation windows", "sv, cv = rec.fit_value(o), h.get(o)", "sv, cv = rec.value(o), h.get(o)"),
    ("a pairing's complete years leave a spread accumulation's days out (engine 1.95.0, before RS6)", "yv = rec.value(o)", "yv = rec.fit_value(o)"),
    ("a pairing month needs no 50 mm of CHIRPS", "        if n[m] >= FIT_MIN_DAYS and c[m] >= FIT_MIN_MM:\n            f = g[m] / c[m]", "        if n[m] >= FIT_MIN_DAYS:\n            f = g[m] / c[m]"),
    ("a pairing factor isn't clamped", "            cf = min(FACTOR_MAX, max(FACTOR_MIN, f))", "            cf = f"),
    ("a station's unreliable periods are read", "return v if src == 0 and o not in self.unreliable else None", "return v if src == 0 else None"),
    ("a station's record is read as stored, without the checks", '        v, src = self.prep["pick"](o)\n        return v if src == 0 and o not in self.unreliable', "        v, src = self.stored.get(o), 0\n        return v if src == 0 and o not in self.unreliable"),
    ("a station's negative value is a reading", '"values": [None if not valid(v) else v for v in raw["values"]]}', '"values": list(raw["values"])}'),
    ("every station gets the catchment gauge's dated lists", '        if not meta.get("isCatchmentGauge"):\n            zr.update(', "        if False:\n            zr.update("),
    ("the catchment gauge's station doesn't get its dated lists", '        if not meta.get("isCatchmentGauge"):\n            zr.update(', "        if True:\n            zr.update("),
    ("the catchment gauge's station is checked against the CHIRPS at it", 'chirps = series.get("rain_chirps_mm") if meta.get("isCatchmentGauge") else', "chirps = at if meta.get(\"isCatchmentGauge\") and at else"),
    ("the catchment's station is ignored (the stored gauge runs)", '    if not a or st.record(a["stationId"]) is None:\n        return rain', "    if True:\n        return rain"),
    ("the catchment MAP is the units' plain mean, not area-weighted", ('num += f["mapMm"] * f["areaKm2"]', 'num += f["mapMm"]'), ('den += f["areaKm2"]', "den += 1")),
    ("catchmentMapMm is ignored", "if isinstance(m, (int, float)) and MAP_MM_MIN <= m <= MAP_MM_MAX:", "if False:"),
    ("the run window follows the station's stored record, not its checked days", "if area(o)[0] is not None]", "if area(o)[0] is not None or rec.stored.get(o) is not None]"),
    ("the run window counts the catchment CHIRPS a refused pairing doesn't correct", "if area(o)[0] is not None]", "if area(o)[0] is not None or valid(h.get(o))]"),
    ("rule 2 divides by gaugeMapMm under the catchment's station (before 3e949975f)", '        gauge_level = rain["gauge_level"]\n', "        gauge_level = gauge_map\n"),
    ("rule 2's level under the catchment's station is the station MAP, without r", '"gauge_level": None if st_map is None else st_map * r,', '"gauge_level": None if st_map is None else st_map,'),
    ("rule 2 applies on gaugeMapMm when the catchment's station has no MAP", '        gauge_level = rain["gauge_level"]\n', '        gauge_level = rain["gauge_level"] or gauge_map\n'),
    ("the reference fit keeps the catchment station's accumulation windows", '"fit_window_days": rec.prep["fit_window_days"],', '"fit_window_days": set(),'),
    # The one natural MAR share per unit (§2.5, §2.5b: the EWR from engine 1.94.0, issue #553; the senior claims too from
    # 1.105.0, issue #616; Per unit only from 1.109.0, issue #658).
    ("the natural MAR share is ignored (no unit gets a share)", "    if split_src is not None:", "    if False:"),
    ("the EWR is split by area, the flow by the natural MAR share", 'ewr_share = {x["id"]: shares.get(x["id"], 0.0) for x in farms}', 'ewr_share = dict(area_share)'),
    ("the senior users' claims are split by area, not the natural MAR share", ("            tot += shares.get(fid, 0.0)\n", "            tot += area_share.get(fid, 0.0)\n"), ('v = Dn[u["id"]][i] * shares.get(fid, 0.0) / tot', 'v = Dn[u["id"]][i] * area_share.get(fid, 0.0) / tot')),
    ("the natural MAR is taken over every day, not the complete water years", "period = full if full else list(range(hist))", "period = list(range(hist))"),
    # Calibration zones (§2.10n, engine 1.106.0, issue #555); calibration locations (engine 1.110.0, issue #659).
    ("a unit in a calibration zone runs on the site's parameters, not its zone's", 'zp = zone_p.get(u["id"], g)', "zp = g"),
    ("an unticked zone row still gives its units their own parameters", 'if z.get("enabled") is not True or not inner_gauge(z["nodeId"]):', 'if not inner_gauge(z["nodeId"]):'),
    ("a zone's parameters outside the bounds are used as they are", 'if ok else g\n', 'if ok else ({k: p[k] for k in GR4J_BOUNDS} if isinstance(p, dict) else g)\n'),
    ("a unit's zone is the ticked gauge nearest the outlet, not the first on its way down", "        for i in down(u):\n            if i in params:", "        for i in reversed(down(u)):\n            if i in params:"),
    ("a borrowed unit is ignored and takes its own zone", "        if isinstance(t, str) and t in params:\n            group = t", "        if False:\n            group = t"),
    ("the nearest rule takes the location nearest the outlet, not the fewest hops up", "key = (path.index(x), name_of(k), node_of(k))", "key = (-path.index(x), name_of(k), node_of(k))"),
    ("a legacy inner site's rows below it are still used", '({**z, "enabled": False} if z.get("enabled") is True and z["nodeId"] in below else z) for z', 'z for z'),
    # diff.py notes a series only the engine writes rather than failing, so the exchange series' zone rule is
    # proven the other way: python writing it under Per unit whatever the zones' X2 is caught.
    ("the exchange series is written under Per unit whatever the zones' X2", 'if g["x2"] != 0 or (per_unit and any(p["x2"] != 0 for p in location_params(', 'if g["x2"] != 0 or (per_unit or any(p["x2"] != 0 for p in location_params('),
    # Future climate (§2.17, engine 1.107.0, issue #621).
    ("climate.delta leaves the MAPs as they were", "    if k != 1:\n        for n in doc", "    if False:\n        for n in doc"),
    ("climate.delta reads rain factors by water-year month", "vals = [v * f[cal_month(o0 + t) - 1] if", "vals = [v * f[wy_month(o0 + t)] if"),
    ("climate.delta's A-pan row takes the water-year month's own index", 's["apanMm"] = [v * ef[(w + 9) % 12] for', 's["apanMm"] = [v * ef[w] for'),
    ("climate.delta's annual factor is the plain mean of the rain factors", "    return sum(w[m] * f[m] for m in range(12)) / sum(w)", "    return sum(f) / 12"),
]


# One mutant's model module (diff.build_mutant, which the self-test's worker
# processes call).
mutant = diff.build_mutant


class CrossCheck(unittest.TestCase):
    tmp: tempfile.TemporaryDirectory
    cases: list
    seed: int

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="verify-test-")
        n = int(os.environ.get("VERIFY_TEST_RANDOM", "12"))
        nd = int(os.environ.get("VERIFY_TEST_DENSE", "12"))
        cls.seed = int(os.environ.get("VERIFY_SEED", "1"))
        if SHARD != 1:
            # Only the mutants run here, on the first MUTANT_RANDOM and MUTANT_DENSE networks.
            n, nd = MUTANT_RANDOM, MUTANT_DENSE
        # VERIFY_WORKERS processes (default the cores, at most 4): the results never depend on it.
        cls.workers = diff.default_workers()
        t0 = time.monotonic()
        cls.cases = diff.build_cases(
            Path(cls.tmp.name), max(n, MUTANT_RANDOM), cls.seed, True, max(nd, MUTANT_DENSE), cls.workers
        )
        print(f"verify: engine ran {len(cls.cases)} cases on {cls.workers} worker(s), {time.monotonic() - t0:.0f}s", flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_engine_and_python_agree(self):
        if SHARD != 1:
            self.skipTest(f"the agreement sweep runs in shard 1/{SHARDS}")
        r = diff.evaluate(self.cases, model, workers=self.workers, progress=diff.Progress("agreement", self.cases))
        self.assertEqual(r["failures"], [], "\n".join(r["failures"][:20]))
        # The cases reach the paths the mutants target.
        cov = r["coverage"]
        for k in (
            "zero_run_days_set_aside", "accumulation_windows", "accumulation_readings_set_aside", "chirps_days", "band_split", "room_bound",
            "multi_site_charge_days", "forecast_tail",
            # Phase 2a.
            "borehole_days", "borehole_to_dam_days", "borehole_annual_cap_days", "depletion_owed_days",
            "cap_bound_days", "full_allocation_units", "floor_days", "object_shortage_days", "offtake_days",
            "offtake_return_days", "user_days", "junior_short_days", "senior_pass_days", "river_pump_days",
            "trigger_hold_days", "curve_days", "release_days", "hands_off_days", "divert_by_month_days", "reach_loss_days", "baseflow_days",
            # Per-unit rain (§2.4h).
            "unit_rule_gauge", "unit_rule_gauge_map", "unit_rule_chirps", "unit_rule_catchment", "unit_clamped",
            "unit_map_all_years", "unit_chirps_bias", "unit_link_days", "unit_catchment_days",
            "unit_chirps_reference", "unit_ref_months_fitted", "unit_ref_not_land",
            # Issue #500's decisions.
            "unit_k_from_map", "unit_chirps_unusable", "unit_forecast_levelled", "unit_forecast_shape_ratio", "unit_gauge_set_aside",
            "unit_gauge_windows", "unit_ref_days_checked_out", "unit_ref_window_days_out",
            # Rainfall stations (§2.4i).
            *model.STATION_DIAG,
            # Calibration zones (§2.10n).
            "zone_units",
        ):
            self.assertGreater(cov[k][0], 0, f"no case exercises {k}")

    def test_every_mutant_is_caught(self):
        # The examples, the probes and the first MUTANT_RANDOM random and
        # MUTANT_DENSE dense cases: a larger VERIFY_TEST_RANDOM or
        # VERIFY_TEST_DENSE widens the agreement test, not this one.
        def mutant_case(name):
            if name.startswith("random-"):
                return int(name.split("-")[1]) < self.seed + MUTANT_RANDOM
            if name.startswith("dense-"):
                return int(name.split("-")[1]) < self.seed + MUTANT_DENSE
            return True

        cases = [c for c in self.cases if mutant_case(c[0])]
        mine = MUTANTS[SHARD - 1 :: SHARDS]
        edit_lists = [[tuple(edits)] if isinstance(edits[0], str) else list(edits) for _, *edits in mine]
        t0 = time.monotonic()
        seen = {"caught": 0}
        label = f"mutants (shard {SHARD}/{SHARDS})" if SHARDS > 1 else "mutants"

        def progress(i, caught):
            seen["caught"] += 1 if caught else 0
            if (i + 1) % 25 == 0 or i + 1 == len(mine):
                s_ = int(time.monotonic() - t0)
                print(f"{label}: {i + 1}/{len(mine)} run, {seen['caught']} caught, {s_ // 60}m{s_ % 60:02d}s", flush=True)

        results = diff.mutants_caught(cases, edit_lists, self.workers, progress)
        for (what, *_), (error, failures) in zip(mine, results):
            with self.subTest(what):
                if error:
                    raise AssertionError(error)
                self.assertNotEqual(failures, [], f"the cases don't see: {what}")


    def test_workers_do_not_change_the_result(self):
        if SHARD != 1:
            self.skipTest(f"runs in shard 1/{SHARDS}")
        # A few cases of each kind, on one process and on two: the same failures, columns and coverage.
        cases = [c for c in self.cases if c[0].startswith(("probe-unit-rain", "random-", "dense-"))]
        cases = [c for c in cases if not c[0][-1:].isdigit() or int(c[0].rsplit("-", 1)[1]) < self.seed + 3]
        runs = []
        for w in (1, 2):
            notes: list[str] = []
            runs.append(diff.evaluate(cases, model, notes, workers=w) | {"notes": notes})
        self.assertGreater(len(cases), 6)
        self.assertEqual(runs[0], runs[1])
        edits = [[tuple(m[1:])] for m in MUTANTS[:4] if isinstance(m[1], str)]
        self.assertEqual(diff.mutants_caught(cases, edits, 1), diff.mutants_caught(cases, edits, 2))


class Generator(unittest.TestCase):
    def test_in_scope_and_seeded(self):
        for seed in range(1, 200):
            for dense in (False, True):
                doc = generate.random_input(seed, dense)
                self.assertEqual(model.unsupported(doc), [], f"seed {seed}")
        self.assertEqual(json.dumps(generate.random_input(7)), json.dumps(generate.random_input(7)))
        self.assertEqual(json.dumps(generate.random_input(7, True)), json.dumps(generate.random_input(7, True)))

    def test_per_unit_rain_is_in_scope(self):
        # model.md §2.4h (issue #482): ported, so a per-unit input is cross-checked, and the generator makes some.
        self.assertEqual(model.unsupported({"settings": {"unitRain": {"mode": "perUnit"}}, "model": {"nodes": []}}), [])
        modes = [(generate.random_input(seed).get("settings", {}).get("unitRain") or {}).get("mode") for seed in range(1, 60)]
        self.assertIn("perUnit", modes)
        self.assertIn("catchment", modes)
        # The outlook's engine-only per-unit inputs stay out, with forecast mode.
        self.assertEqual(model.unsupported({"settings": {"unitRain": {"mode": "perUnit", "pinned": []}}, "model": {}}), [])
        self.assertEqual(len(model.unsupported({"settings": {"unitRain": {"mode": "perUnit", "pinned": [{"nodeId": "u"}]}}, "model": {}})), 1)
        # So do the ensemble's pinned reference factors (§2.4h); a reference itself is in scope.
        self.assertEqual(model.unsupported({"settings": {"unitRain": {"mode": "perUnit", "reference": {"gauge": "rain_catchment_mm", "unitId": "u"}}}, "model": {}}), [])
        self.assertEqual(len(model.unsupported({"settings": {"unitRain": {"mode": "perUnit", "reference": {"gauge": "rain_catchment_mm", "unitId": "u", "pinnedFactors": [1] * 12}}}, "model": {}})), 1)
        self.assertEqual(len(model.unsupported({"settings": {}, "model": {}, "series": {"rain_forecast_mm@u": {"startDate": "2020-01-01", "values": [1]}}})), 1)

    def test_known_differences_name_their_followup(self):
        for key, why in diff.KNOWN_DIFFERENCES.items():
            self.assertIn("followups.md", why, key)


class Gr4jPieces(unittest.TestCase):
    def test_unit_hydrographs(self):
        for x4 in (0.5, 1.0, 1.7, 2.5, 4.0, 10.0):
            uh1, uh2 = model.uh_ordinates(x4)
            self.assertAlmostEqual(sum(uh1), 1.0, places=12)
            self.assertAlmostEqual(sum(uh2), 1.0, places=12)
            self.assertEqual(len(uh1), -(-x4 // 1))
            self.assertTrue(all(v >= 0 for v in uh1 + uh2))

    def test_daily_balance_closes(self):
        g = model.Gr4j(300, 0, 80, 2.2)
        before = g.s + g.r + g.uh_store()
        rain = [0, 30, 5, 0, 0, 60, 2, 0, 0, 0] * 20
        tot_p = tot_aet = tot_q = 0.0
        for p in rain:
            r = g.step(p, 3.0)
            tot_p += p
            tot_aet += r["aet"]
            tot_q += r["q"]
        after = g.s + g.r + g.uh_store()
        self.assertAlmostEqual(tot_p - tot_aet - tot_q, after - before, places=9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
