// Scenario properties on random networks (roadmap WP-3.2):
//  - every applied scenario still passes every engine invariant (checkAll,
//    order invariance included);
//  - no silent change: every op that changes the resolved input shows up as
//    at least one InputChange in run comparison (compare.ts diffInputs), and
//    an empty op list shows none;
//  - applied ops keep a valid network and never mutate the base.
// Soak: SCENARIO_FUZZ_CASES=5000 pnpm -C packages/engine exec vitest run src/scenario/scenario.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { diffInputs, type RunInputsSnapshot } from '../compare';
import { buildTopology } from '../network/topology';
import { defaultProjectSettings, upgradeLegacyModel, type ModelInput } from '../project';
import { randomInput } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';
import { randomOps } from '../testing/scenarioFuzz';
import { applyScenario } from './overrides';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.SCENARIO_FUZZ_CASES ?? 250);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
// Small networks and short runs keep checkAll (four model runs a case) fast enough for `pnpm test`.
const GEN = { maxNodes: 12, maxDays: 500 };

/**
 * The settings as a run stores them: merged over the defaults, as the
 * backend's loadModelInput does (backend/src/projects/settings.ts
 * mergeSettings), so "resolved input changed" means what a run would see.
 */
function resolveSettings(raw: ModelInput['settings']): ModelInput['settings'] {
	const d = defaultProjectSettings() as unknown as Record<string, unknown>;
	const r = raw as Record<string, unknown>;
	const merge = (k: string) => ({ ...(d[k] as object), ...((r[k] as object | undefined) ?? {}) });
	return { ...d, ...r, calibration: merge('calibration'), hiLoSplit: merge('hiLoSplit'), gr4j: merge('gr4j'), zeroRainRuns: merge('zeroRainRuns'), dataQuality: merge('dataQuality'), wr2012: merge('wr2012') } as ModelInput['settings'];
}

/** What a run stores about its input (backend runs/execute.ts); the values' JSON stands in for their SHA-256. */
function snapshot(x: ModelInput): RunInputsSnapshot {
	return {
		settings: x.settings,
		model: x.model,
		series: Object.fromEntries(Object.entries(x.series).map(([k, s]) => [k, { startDate: s!.startDate, length: s!.values.length, valuesSha256: JSON.stringify(s!.values) }]))
	};
}

/** Key-order-free JSON, so adding a field that was absent at its default doesn't count as a change. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object') {
		return `{${Object.keys(v)
			.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(v);
}

/** The input as the engine and compare resolve it: settings merged, older node fields at their defaults, no land cover = []. */
const resolved = (x: ModelInput) => {
	const s = snapshot(x);
	return canonical({ ...s, settings: resolveSettings(s.settings), model: upgradeLegacyModel({ landCover: [], ...s.model }) });
};

function baseFor(seed: number): ModelInput {
	const x = randomInput(seed, GEN);
	return { ...x, settings: resolveSettings(x.settings) };
}

describe('scenarios on random networks', () => {
	it(`${CASES} random scenarios keep every engine invariant`, () => {
		const failures: string[] = [];
		for (let seed = SEED0; seed < SEED0 + CASES && failures.length < 3; seed++) {
			const base = baseFor(seed);
			const ops = randomOps(base, seed);
			const { input } = applyScenario(base, ops);
			const bad = checkAll(input, seed);
			if (bad) failures.push(`seed ${seed}: ${bad}\n  ops: ${JSON.stringify(ops)}`);
		}
		expect(failures.join('\n\n')).toBe('');
	}, 300_000);

	it(`no silent change over ${CASES * 4} random scenarios: every op that changes the input is an InputChange`, () => {
		const failures: string[] = [];
		let changed = 0;
		for (let seed = SEED0; seed < SEED0 + CASES * 4 && failures.length < 3; seed++) {
			const base = baseFor(seed);
			const empty = applyScenario(base, []);
			const none = diffInputs(snapshot(base), snapshot(empty.input));
			if (none.length || resolved(empty.input) !== resolved(base)) failures.push(`seed ${seed}: the empty scenario changed the input: ${JSON.stringify(none)}`);
			let cur = base;
			for (const op of randomOps(base, seed)) {
				const r = applyScenario(cur, [op]);
				if (resolved(r.input) !== resolved(cur)) {
					changed++;
					if (diffInputs(snapshot(cur), snapshot(r.input)).length === 0) failures.push(`seed ${seed}: silent change from ${JSON.stringify(op)}`);
				}
				// A skipped op changes nothing at all.
				if (r.problems.length && resolved(r.input) !== resolved(cur)) failures.push(`seed ${seed}: skipped op changed the input: ${JSON.stringify(op)}`);
				cur = r.input;
			}
		}
		expect(failures.join('\n')).toBe('');
		// The property is only as good as the changes it saw.
		expect(changed).toBeGreaterThan(CASES * 4);
	}, 300_000);

	it('applied ops keep a valid tree and never touch the base', () => {
		let problems = 0;
		for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
			const base = baseFor(seed);
			const before = JSON.stringify(base);
			const r = applyScenario(base, randomOps(base, seed, 12));
			problems += r.problems.length;
			expect(JSON.stringify(base)).toBe(before);
			expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
			expect(r.applied.length + r.problems.length).toBe(12);
		}
		// The generator aims some ops at missing or invalid targets: the problem path runs.
		expect(problems).toBeGreaterThan(CASES / 2);
	});
});
