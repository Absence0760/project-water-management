"""The cross-check's guard (`pnpm test:verify`, CI job `verify`):

- the engine and verify/model.py agree on the example catchments, the probes
  and VERIFY_TEST_RANDOM random networks (default 12; CI runs more);
- the harness can see each rule it claims to check: every mutant below (a
  one-line change to model.py that breaks one documented rule) must disagree
  with the engine somewhere, or the cases don't exercise that rule;
- the generator stays inside phase 1 and is a pure function of its seed.

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

# (what the mutant breaks, text in model.py, replacement), or (what, (text,
# replacement), …) for a mutant of several edits, applied in order. Each
# text must occur exactly once when its edit is applied.
MUTANTS = [
    ("transfers ignore the receiver's room (N4)", "if tot > room and tot > 0:", "if False:"),
    (
        "a source's rules share one pool down to the lowest reserve (N6, before engine 1.36.0)",
        'elig = [t for t in from_src if reserve[t["id"]] <= level and left[t["id"]] > 0]',
        'elig = [t for t in from_src if left[t["id"]] > 0]',
    ),
    (
        "the receiver's room leaves out its dam's own rain, evaporation and seepage (before engine 0.19.0)",
        "(storage[dst] + pd - e_raw - sp_raw)",
        "storage[dst]",
    ),
    (
        "within a priority the source's bands are shared first and the receiver's room after",
        ("if tot > room and tot > 0:", "if False:"),
        (
            '            if any(vol[t["id"]] > 0 for t, _ in group):',
            """            for dst in sorted({t["toNodeId"] for t, _ in group}):
                area, pd, e_raw, sp_raw = pre[dst]
                room = max(0.0, by_id[dst]["damCapacityM3"] - (storage[dst] + pd - e_raw - sp_raw) + fd[dst]["D"][i] - sched[dst])
                into = [t for t, _ in group if t["toNodeId"] == dst]
                tot = sum(vol[t["id"]] for t in into)
                if tot > room and tot > 0:
                    for t in into:
                        vol[t["id"]] = vol[t["id"]] * room / tot
            if any(vol[t["id"]] > 0 for t, _ in group):""",
        ),
    ),
    ("a run with no catchment area runs (on 0 m³ of natural flow)", "    if not area_km2 > 0:\n        raise Refused", "    if False:\n        raise Refused"),
    ("the receiver's room counts what it sent earlier the same day", "- sched[dst]\n", "- sched[dst] + drawn[dst]\n"),
    ("no soil-water store (N3)", "w = min(smax, available - used)", "w = 0.0"),
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
    ("seepage never returns to the river", "Uo = R + S + T + Sp * ret", "Uo = R + S + T"),
    ("irrigation ignores the dam's minimum operating level (Q5)", 'dead = cap * (x.get("damMinPct") or 0.0)', "dead = 0.0"),
    (
        "the attribution counts every transfer as internal (Q17 J_int)",
        'if t["fromNodeId"] in mset and t["toNodeId"] in mset:',
        "if True:",
    ),
    ("rain equal to the threshold offsets demand", "v if v > thr else 0.0", "v if v >= thr else 0.0"),
    ("the warm-up cycles the forecast tail too", "            hist = tail[0]\n", "            pass\n"),
    (
        "crop efficiencies are ignored (farm e only)",
        "if not any(own(c) is not None for c, a in rows if a > 0):",
        "if True:",
    ),
    ("GR4J's PE uses the 28.25-day February", "pet.append(monthly / calendar_days_in_month(o))", "pet.append(monthly / mdays[m])"),
    ("dam evaporation uses calendar days", "e_raw = k_lake[m] * apan[m] / mdays[m] / 1000 * area", "e_raw = k_lake[m] * apan[m] / calendar_days_in_month(o) / 1000 * area"),
    ("return flow is the whole loss (β ignored, N1)", "T = beta * (1 - d[\"e\"]) * G", "T = (1 - d[\"e\"]) * G"),
    ("GR4J's routing store gets no exchange", "r = max(0.0, self.r + q9 + f)", "r = max(0.0, self.r + q9)"),
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
        cls.seed = int(os.environ.get("VERIFY_SEED", "1"))
        cls.cases = diff.build_cases(Path(cls.tmp.name), max(n, MUTANT_RANDOM), cls.seed, True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_engine_and_python_agree(self):
        r = diff.evaluate(self.cases, model)
        self.assertEqual(r["failures"], [], "\n".join(r["failures"][:20]))
        # The cases reach the paths the mutants target.
        cov = r["coverage"]
        for k in ("zero_run_days_set_aside", "accumulation_windows", "chirps_days", "band_split", "room_bound", "multi_site_charge_days", "forecast_tail"):
            self.assertGreater(cov[k][0], 0, f"no case exercises {k}")

    def test_every_mutant_is_caught(self):
        # The examples, the probes and the first MUTANT_RANDOM random cases:
        # a larger VERIFY_TEST_RANDOM widens the agreement test, not this one.
        cases = [c for c in self.cases if not c[0].startswith("random-") or int(c[0].split("-")[1]) < self.seed + MUTANT_RANDOM]
        for what, *edits in MUTANTS:
            if isinstance(edits[0], str):
                edits = [tuple(edits)]
            with self.subTest(what):
                r = diff.evaluate(cases, mutant(*edits))
                self.assertNotEqual(r["failures"], [], f"the cases don't see: {what}")


class Generator(unittest.TestCase):
    def test_phase_one_only_and_seeded(self):
        for seed in range(1, 200):
            doc = generate.random_input(seed)
            self.assertEqual(model.unsupported(doc), [], f"seed {seed}")
        self.assertEqual(json.dumps(generate.random_input(7)), json.dumps(generate.random_input(7)))

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
