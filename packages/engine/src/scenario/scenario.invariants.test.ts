// Scenario properties on random networks (roadmap WP-3.2):
//  - every applied scenario still passes every engine invariant (checkAll,
//    order invariance included);
//  - no silent change: every op that changes the resolved input shows up as
//    at least one InputChange in run comparison (compare.ts diffInputs), and
//    an empty op list shows none;
//  - applied ops keep a valid network and never mutate the base;
//  - demand.scale (issue #53 R1): factor 1 is the identity, factor 0 takes
//    nothing for the nodes it targets, and a scaled node's demand is the
//    base's × the month's factor, never met beyond it.
// Soak: SCENARIO_FUZZ_CASES=5000 pnpm -C packages/engine exec vitest run src/scenario/scenario.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { diffInputs, type RunInputsSnapshot } from '../compare';
import { buildTopology } from '../network/topology';
import { defaultProjectSettings, upgradeLegacyModel, type ModelInput, type ModelOutput } from '../project';
import { randomInput } from '../testing/fuzz';
import { checkAll, sameOutput } from '../testing/invariants';
import { randomOps } from '../testing/scenarioFuzz';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { Rng } from '../random';
import { runModel } from '../run';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';

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

	/** The 0-based ops a problem names: `op 3 (…)`, `ops 3–5 (…)` or `ops 3, 5 (…)` (1-based). */
	const opsNamed = (p: string): number[] => {
		const m = /^ops? ([\d–, ]+?) \(/.exec(p);
		if (!m) return [];
		return m[1]!.split(', ').flatMap((part) => {
			const [a, b = a] = part.split('–').map(Number) as [number, number?];
			return Array.from({ length: b! - a + 1 }, (_, k) => a + k - 1);
		});
	};

	it('applied ops keep a valid tree and never touch the base', () => {
		let problems = 0;
		for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
			const base = baseFor(seed);
			const before = JSON.stringify(base);
			const r = applyScenario(base, randomOps(base, seed, 12));
			problems += r.problems.length;
			expect(JSON.stringify(base)).toBe(before);
			expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
			// Every op applied or named by exactly one problem; an edit group's problem names each of its ops (`ops 4–5 (node.set, …)`).
			const named = r.problems.flatMap((p) => opsNamed(p));
			expect([...r.applied.map((a) => a.index), ...named].sort((a, b) => a - b), `seed ${seed}: ${JSON.stringify(r.problems)}`).toEqual(Array.from({ length: 12 }, (_, i) => i));
		}
		// The generator aims some ops at missing or invalid targets: the problem path runs.
		expect(problems).toBeGreaterThan(CASES / 2);
	});
});

describe('demand.scale on random networks (issue #53 R1)', () => {
	const N = Math.max(20, Math.floor(CASES / 5));
	const col = (out: ModelOutput, nodeId: string, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;
	/** The ops for every farm and every user, each only if the network has one (an op on none is a problem). */
	const everyone = (input: ModelInput, factor: number, extra: Partial<Extract<ScenarioOp, { op: 'demand.scale' }>> = {}): ScenarioOp[] =>
		(['farm', 'user'] as const).filter((c) => input.model.nodes.some((n) => n.kind === c)).map((category) => ({ op: 'demand.scale', factor, category, ...extra }));

	it(`factor 1 is the identity on ${N} networks`, () => {
		for (let seed = SEED0; seed < SEED0 + N; seed++) {
			const base = baseFor(seed);
			const r = applyScenario(base, everyone(base, 1, { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }));
			expect(r.problems).toEqual([]);
			expect(sameOutput(runModel(r.input), runModel(base)), `seed ${seed}`).toBe(true);
		}
	});

	it(`factor 0 takes nothing for the nodes it targets and leaves the rest their demand, on ${N} networks`, () => {
		let targeted = 0;
		for (let seed = SEED0; seed < SEED0 + N; seed++) {
			const base = baseFor(seed);
			const g = new Rng(seed);
			const takers = base.model.nodes.filter((n) => n.kind !== 'gauge');
			const zeroed = new Set(takers.filter(() => g.bool(0.5)).map((n) => n.id));
			const ops: ScenarioOp[] = (['farm', 'user'] as const).flatMap((category) => {
				const ids = takers.filter((n) => n.kind === category && zeroed.has(n.id)).map((n) => n.id);
				return ids.length ? [{ op: 'demand.scale', factor: 0, category, nodeIds: ids } as ScenarioOp] : [];
			});
			const r = applyScenario(base, ops);
			expect(r.problems).toEqual([]);
			const [x, y] = [runModel(base), runModel(r.input)];
			for (const n of takers) {
				const [D, G, GW] = ['demand', 'supplied', 'groundwater_used'].map((k) => col(y, n.id, k));
				if (!zeroed.has(n.id)) {
					expect(D, `seed ${seed} ${n.id}`).toEqual(col(x, n.id, 'demand'));
					continue;
				}
				targeted++;
				expect(D!.every((v) => v === 0), `seed ${seed} ${n.id}: demand`).toBe(true);
				expect(G!.every((v) => v === 0), `seed ${seed} ${n.id}: supplied`).toBe(true);
				if (GW) expect(GW.every((v) => v === 0), `seed ${seed} ${n.id}: groundwater`).toBe(true);
			}
			expect(checkAll(r.input, seed), `seed ${seed}`).toBeNull();
		}
		expect(targeted).toBeGreaterThan(N);
	}, 300_000);

	it(`a scaled node's demand is the base's × the month's factor, and is never met beyond it, on ${N} networks`, () => {
		for (let seed = SEED0; seed < SEED0 + N; seed++) {
			const base = baseFor(seed);
			const g = new Rng(seed ^ 0x3c6ef372);
			const factor = g.float(0, 2);
			const months = [...new Set(Array.from({ length: g.int(1, 12) }, () => g.int(1, 12)))];
			const r = applyScenario(base, everyone(base, factor, { months }));
			expect(r.problems).toEqual([]);
			const [x, y] = [runModel(base), runModel(r.input)];
			const day0 = toEpochDay(y.startDate);
			for (const n of base.model.nodes) {
				if (n.kind === 'gauge') continue;
				const [D0, D, G] = [col(x, n.id, 'demand')!, col(y, n.id, 'demand')!, col(y, n.id, 'supplied')!];
				for (let t = 0; t < D.length; t++) {
					const k = months.includes(monthOfEpochDay(day0 + t)) ? factor : 1;
					expect(Math.abs(D[t]! - k * D0[t]!), `seed ${seed} ${n.id} day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, D0[t]!));
					expect(G[t]!, `seed ${seed} ${n.id} day ${t}: supplied`).toBeLessThanOrEqual(D[t]! * (1 + 1e-12) + 1e-12);
				}
			}
		}
	}, 300_000);
});
