// Cumulative impact properties on random networks (roadmap WP-3.11):
//  - disjoint scenarios (no conflict) combine to the same run in either
//    order: every daily series to the bit, the summary within float noise
//    (testing/invariants.ts orderFreeDifference);
//  - one scenario combined is that scenario alone, to the bit;
//  - a scenario combined with a copy of itself always conflicts (every op
//    writes or removes something), so nothing is ever merged silently;
//  - the conflicts found don't depend on the order the scenarios are given.
// Soak: SCENARIO_FUZZ_CASES=2000 pnpm -C packages/engine exec vitest run src/scenario/combine.invariants.test.ts
import { describe, expect, it } from 'vitest';
import type { ModelInput } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { orderFreeDifference, sameOutput } from '../testing/invariants';
import { randomOps } from '../testing/scenarioFuzz';
import { combineScenarios, scenarioConflicts, type CombineScenario } from './combine';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.SCENARIO_FUZZ_CASES ?? 150);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
const GEN = { maxNodes: 10, maxDays: 400, allocationModes: false };

/** The ops of a random list that apply alone, kept only if they still all apply as a list (an edit group can depend on a skipped op). */
function clean(base: ModelInput, ops: ScenarioOp[]): ScenarioOp[] | null {
	const kept = applyScenario(base, ops).applied.map((a) => a.op);
	return kept.length && !applyScenario(base, kept).problems.length ? kept : null;
}

const key = (s: CombineScenario[], base: ModelInput) =>
	scenarioConflicts(base, s)
		.map((c) => `${c.reason}|${c.target}|${[c.a.scenarioId, c.b.scenarioId].sort().join('+')}`)
		.sort();

describe('combineScenarios on random networks', () => {
	it(`disjoint scenarios combine to the same run in either order (${CASES} pairs)`, () => {
		const failures: string[] = [];
		let compared = 0;
		for (let seed = SEED0; seed < SEED0 + CASES && failures.length < 3; seed++) {
			const base = randomInput(seed, GEN);
			const a = clean(base, randomOps(base, seed, 3));
			const raw = clean(base, randomOps(base, seed + 1_000_000, 3));
			if (!a || !raw) continue;
			// Drop B's ops that meet A's, so most pairs are disjoint; then B must still apply alone. Conflicts are
			// listed once per target, so another of B's ops on the same target shows only on the next pass.
			let b: ScenarioOp[] | null = raw;
			for (let pass = 0; b && pass < 6; pass++) {
				const meet = new Set(scenarioConflicts(base, [{ id: 'a', ops: a }, { id: 'b', ops: b }]).map((c) => (c.a.scenarioId === 'b' ? c.a.opIndex : c.b.opIndex)));
				if (!meet.size) break;
				const kept: ScenarioOp[] = b.filter((_, i) => !meet.has(i));
				b = clean(base, kept);
			}
			if (!b) continue;
			const ab = combineScenarios(base, [{ id: 'a', ops: a }, { id: 'b', ops: b }]);
			const ba = combineScenarios(base, [{ id: 'b', ops: b }, { id: 'a', ops: a }]);
			if (ab.conflicts.length) {
				failures.push(`seed ${seed}: conflicts left after dropping B's meeting ops: ${ab.conflicts.map((c) => c.message).join('; ')}`);
				continue;
			}
			// Together they can still break a save rule (two new names alike): refused in both orders' own way, nothing to compare.
			if (!ab.input || !ba.input) continue;
			let d: string | null;
			try {
				d = orderFreeDifference(runModel(ab.input), runModel(ba.input));
			} catch (e) {
				// The engine refusing an input is the same in either order, or a difference.
				const other = (() => {
					try {
						runModel(ba.input);
						return 'ran';
					} catch (f) {
						return (f as Error).message;
					}
				})();
				d = other === (e as Error).message ? null : `A then B threw "${(e as Error).message}", B then A: ${other}`;
			}
			if (d) failures.push(`seed ${seed}: ${d}\n  A: ${JSON.stringify(a)}\n  B: ${JSON.stringify(b)}`);
			else compared++;
		}
		expect(failures.join('\n\n')).toBe('');
		// The property is only as good as the pairs it compared.
		expect(compared).toBeGreaterThan(CASES / 3);
	}, 300_000);

	it(`one scenario combined is that scenario alone (${Math.floor(CASES / 3)} scenarios)`, () => {
		let n = 0;
		for (let seed = SEED0; seed < SEED0 + Math.floor(CASES / 3); seed++) {
			const base = randomInput(seed, GEN);
			const ops = clean(base, randomOps(base, seed, 4));
			if (!ops) continue;
			const one = combineScenarios(base, [{ id: 's', ops }]);
			expect(one.conflicts).toEqual([]);
			expect(one.problems).toEqual([]);
			let alone;
			try {
				alone = runModel(applyScenario(base, ops).input);
			} catch {
				expect(() => runModel(one.input!)).toThrow();
				continue;
			}
			expect(sameOutput(runModel(one.input!), alone), `seed ${seed}`).toBe(true);
			n++;
		}
		expect(n).toBeGreaterThan(CASES / 6);
	}, 300_000);

	it(`a scenario combined with a copy of itself always conflicts, and the conflicts don't depend on order (${CASES} cases)`, () => {
		for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
			const base = randomInput(seed, GEN);
			const ops = randomOps(base, seed, 4);
			const twice = combineScenarios(base, [{ id: 'x', ops }, { id: 'y', ops }]);
			expect(twice.conflicts.length, `seed ${seed}: ${JSON.stringify(ops)}`).toBeGreaterThan(0);
			expect(twice.input).toBeNull();
			const other = randomOps(base, seed + 2_000_000, 4);
			const s: CombineScenario[] = [{ id: 'x', ops }, { id: 'z', ops: other }];
			expect(key([...s].reverse(), base)).toEqual(key(s, base));
		}
	}, 300_000);
});
