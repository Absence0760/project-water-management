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

from mutants import MUTANTS  # noqa: E402  (the list lives apart so diff.py can read it without importing this file)


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
            # Phase 2b: the daily A-pan record (§2.3a).
            "apan_daily_days",
            # Dated demand factors (§2.3 item 4a).
            "demand_window_days",
            # Land cover (§2.5a).
            "land_cover_units", "land_cover_scaled", "land_cover_above_q",
            # Development during the run (§2.7g).
            "dev_dams", "dev_no_capacity_days", "dev_shrink_spill_days", "abstraction_from_units",
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

    def test_drought_restrictions_are_refused(self):
        # §2.7i isn't modelled yet: an input with the rule is named, not cross-checked.
        self.assertEqual(model.unsupported({"settings": {"droughtRestriction": {"levels": []}}, "model": {}}), ["drought restrictions"])

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
