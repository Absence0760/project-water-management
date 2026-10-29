// climate.delta's invariants (issue #621, docs/model.md §2.17):
//  - every factor 1 reproduces the run to the bit, on random networks;
//  - a run under a delta still passes every engine invariant (checkAll: the
//    mass balance, the water account, order invariance);
//  - on a single dam with no return flow, firm yield never falls as the rain
//    factors rise (a property over random factor rows).
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { firmYield } from '../network/yield';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { checkAll, sameOutput } from '../testing/invariants';
import type { ClimateDeltaOp } from './climate';
import { applyScenario } from './overrides';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.CLIMATE_FUZZ_CASES ?? 40);
const GEN = { maxNodes: 10, maxDays: 500 };

const op = (rain: number[], evap: number[]): ClimateDeltaOp => ({ op: 'climate.delta', rainFactorByMonth: rain, evapFactorByMonth: evap, label: 'invariant', source: 'random factors (test)' });
const row = (g: Rng, lo = 0.5, hi = 1.5) => Array.from({ length: 12 }, () => lo + (hi - lo) * g.next());
const apply = (input: ModelInput, o: ClimateDeltaOp) => {
	const r = applyScenario(input, [o]);
	expect(r.problems).toEqual([]);
	return r.input;
};

describe('climate.delta invariants on random networks', () => {
	it('every factor 1 gives the same run, bit for bit', () => {
		const ones = new Array<number>(12).fill(1);
		for (let seed = 1; seed <= CASES; seed++) {
			const input = randomInput(seed, GEN);
			expect(sameOutput(runModel(apply(input, op(ones, ones))), runModel(input)), `seed ${seed}`).toBe(true);
		}
	});

	it('a run under random factors passes every engine invariant', () => {
		for (let seed = 1; seed <= CASES; seed++) {
			const g = new Rng(seed ^ 0x51a7e);
			const input = apply(randomInput(seed, GEN), op(row(g), row(g)));
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
		}
	});
});

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 5,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** One dam taking all its unit's runoff, no return flow, on GR4J from a seeded rain record (three water years) and an A-pan row. */
function singleDam(seed: number): ModelInput {
	const g = new Rng(seed);
	const days = 3 * 365;
	const rain = Array.from({ length: days }, () => (g.next() < 0.25 ? 40 * g.next() ** 2 : 0));
	return {
		settings: {
			ewrPragmaticM3PerDay: new Array(12).fill(0) as unknown as Monthly,
			apanMm: [150, 190, 230, 240, 200, 170, 110, 80, 55, 55, 75, 105] as unknown as Monthly,
			gr4j: { x1: 300, x2: 0, x3: 80, x4: 1.5, warmupDays: 0 } as never
		},
		model: {
			nodes: [node('dam', { downstreamNodeId: 'g', pctRunoffToDam: 1, damCapacityM3: 200_000, damInitialPct: 1 }), node('g', { kind: 'gauge', areaKm2: 0 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2001-10-01', values: rain } }
	};
}

describe('climate.delta and firm yield', () => {
	it('on a single dam with no return flow, firm yield does not fall as the rain factors rise', () => {
		const tol = 1e-3;
		const ones = new Array<number>(12).fill(1);
		let rose = 0;
		for (let seed = 1; seed <= 8; seed++) {
			const g = new Rng(seed ^ 0xd4a);
			const input = singleDam(seed);
			// Two rows, the second at least the first in every month, the evaporation held.
			const lo = row(g, 0.5, 1.2);
			const hi = lo.map((v) => Math.min(1.5, v + 0.3 * g.next()));
			const yLo = firmYield(apply(input, op(lo, ones)), 'dam', { tolerance: tol }).yieldM3Day;
			const yHi = firmYield(apply(input, op(hi, ones)), 'dam', { tolerance: tol }).yieldM3Day;
			// Within the bisection's tolerance of each.
			expect(yLo, `seed ${seed}`).toBeGreaterThan(0);
			expect(yHi, `seed ${seed}`).toBeGreaterThanOrEqual(yLo * (1 - 2 * tol));
			if (yHi > yLo * 1.01) rose++;
		}
		// Not vacuous: the wetter row yields more on most seeds.
		expect(rose).toBeGreaterThanOrEqual(6);
	});
});
