"""The cross-check's guard (`pnpm test:verify`, CI job `verify`):

- the engine and verify/model.py agree on the example catchments, the probes,
  VERIFY_TEST_RANDOM random networks (default 12; CI runs more) and
  VERIFY_TEST_DENSE dense ones (every phase-2a feature in most; default 12);
- the harness can see each rule it claims to check: every mutant below (a
  one-line change to model.py that breaks one documented rule) must disagree
  with the engine somewhere, or the cases don't exercise that rule;
- the generator stays inside phases 1 and 2a and is a pure function of its seed.

Run: python3 -m unittest discover -s verify
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import diff  # noqa: E402
import generate  # noqa: E402
import model  # noqa: E402

MUTANT_RANDOM = 12
MUTANT_DENSE = 12

# (what the mutant breaks, text in model.py, replacement), or (what, (text,
# replacement), …) for a mutant of several edits, applied in order. Each
# text must occur exactly once when its edit is applied.
MUTANTS = [
    (
        "blank days count like zeros however many (before engine 1.70.0, Q31)",
        "if j - s > ACC_MAX_BLANK_DAYS:",
        "if False:",
    ),
    (
        "a reading after a blank outage stays on its day (Q31)",
        "set_aside |= set(outage_readings)",
        "pass",
    ),
    (
        "a blank stretch of exactly 7 days ends the run (Q31 limit off by one)",
        "if j - s > ACC_MAX_BLANK_DAYS:",
        "if j - s >= ACC_MAX_BLANK_DAYS:",
    ),
    ("transfers ignore the receiver's room (N4)", "room_left[dst] = max(0.0, rm)", "room_left[dst] = math.inf"),
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
        "the accumulation test reads CHIRPS over the whole run, not the window's run days",
        "sum(ch(o) for o in run_days if o != r - 1)",
        "sum(ch(o) for o in range(r - k, r) if o != r - 1)",
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
        "need = min(dam_dem(dst, i), sr_[0] if sr_ else math.inf)",
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
    ("farms pass nothing for senior users", "need = min(zs, H + I)", "need = 0.0"),
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
]


def mutant(*edits: tuple[str, str]) -> types.ModuleType:
    src = (HERE / "model.py").read_text()
    for old, new in edits:
        if src.count(old) != 1:
            raise AssertionError(f"mutant text found {src.count(old)} times in model.py: {old!r}")
        src = src.replace(old, new)
    mod = types.ModuleType("model_mutant")
    mod.__file__ = str(HERE / "model.py")
    sys.modules["model_mutant"] = mod
    exec(compile(src, "model_mutant", "exec"), mod.__dict__)
    return mod


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
        cls.cases = diff.build_cases(Path(cls.tmp.name), max(n, MUTANT_RANDOM), cls.seed, True, max(nd, MUTANT_DENSE))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_engine_and_python_agree(self):
        r = diff.evaluate(self.cases, model)
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
            "trigger_hold_days", "curve_days", "release_days", "hands_off_days", "divert_by_month_days", "reach_loss_days",
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
        for what, *edits in MUTANTS:
            if isinstance(edits[0], str):
                edits = [tuple(edits)]
            with self.subTest(what):
                r = diff.evaluate(cases, mutant(*edits), stop_first=True)
                self.assertNotEqual(r["failures"], [], f"the cases don't see: {what}")


class Generator(unittest.TestCase):
    def test_in_scope_and_seeded(self):
        for seed in range(1, 200):
            for dense in (False, True):
                doc = generate.random_input(seed, dense)
                self.assertEqual(model.unsupported(doc), [], f"seed {seed}")
        self.assertEqual(json.dumps(generate.random_input(7)), json.dumps(generate.random_input(7)))
        self.assertEqual(json.dumps(generate.random_input(7, True)), json.dumps(generate.random_input(7, True)))

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
    unittest.main()
