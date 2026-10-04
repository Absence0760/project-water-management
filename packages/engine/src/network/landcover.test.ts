// Land-cover streamflow reductions (WP-1.35, docs/model.md §2.5a):
// hand-worked cases on a fixed natural flow.
import { describe, expect, it } from 'vitest';
import type { LandCoverPatch, ModelInput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkLandCover } from '../verify/checks';
import { landCoverReduction, lowFlowThreshold, resolveLandCover } from './landcover';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 10 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
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

const patch = (over: Partial<LandCoverPatch>): LandCoverPatch => ({ id: 'p', nodeId: 'A', coverClass: 'pine', areaKm2: 2, densityPct: 1, factors: null, ...over });

/** Two farms of 10 km² each (area shares ½) above the outlet, no demand. */
function input(landCover: LandCoverPatch[], days: number): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(0) as never },
		model: { nodes: [node('G', 'gauge', null), node('A', 'farm', 'G'), node('B', 'farm', 'G', { sortOrder: 1 })], crops: [], cropAreas: [], transfers: [], landCover },
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)!.values;

describe('land cover (WP-1.35)', () => {
	it('the low-flow threshold is the natural flow exceeded 75 % of the days', () => {
		expect(lowFlowThreshold([10, 20, 30, 40, 50])).toBe(20);
		expect(lowFlowThreshold([0, 100])).toBe(25);
		expect(lowFlowThreshold([])).toBe(0);
	});

	it('reduces the low part of the flow by the low-flow share and the rest by the MAR share', () => {
		// 20 % of the unit under a class removing 50 % of flows above q and 80 % of low flow:
		// MAR 0.1, LOW 0.16. I0 = 300, q = 100: 0.16 × 100 + 0.1 × 200 = 36.
		expect(landCoverReduction(300, 100, { mar: 0.1, lowFlow: 0.16 })).toBeCloseTo(36, 12);
		// Below the threshold only the low-flow share applies.
		expect(landCoverReduction(50, 100, { mar: 0.1, lowFlow: 0.16 })).toBeCloseTo(8, 12);
		expect(landCoverReduction(0, 100, { mar: 1, lowFlow: 1 })).toBe(0);
		// Never more than the flow.
		expect(landCoverReduction(10, 5, { mar: 1, lowFlow: 1 })).toBe(10);
	});

	it('a patch’s share of its unit is area × density ÷ the unit’s area; the class defaults apply unless overridden', () => {
		const warnings: string[] = [];
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G')];
		const [, a] = resolveLandCover({ nodes, landCover: [patch({ areaKm2: 4, densityPct: 0.5 }), patch({ id: 'q', coverClass: 'other', factors: { mar: 0.2, lowFlow: 0.3 }, areaKm2: 1 })] }, warnings);
		// Pine (0.40 / 0.55) on 4 × 0.5 = 2 of 10 km²: 0.08 / 0.11; the override on 1 of 10: 0.02 / 0.03.
		expect(a!.mar).toBeCloseTo(0.1, 12);
		expect(a!.lowFlow).toBeCloseTo(0.14, 12);
		expect(a!.condensedKm2).toEqual({ pine: 2, other: 1 });
		expect(warnings).toEqual([]);
		// More than the unit is scaled down to it, with a warning; a gauge can't carry any.
		const w2: string[] = [];
		const over = resolveLandCover({ nodes, landCover: [patch({ areaKm2: 30 }), patch({ id: 'g', nodeId: 'G' })] }, w2);
		expect(over[1]!.mar).toBeCloseTo(0.4, 12);
		expect(over[0]).toBeUndefined();
		expect(w2.join(' | ')).toMatch(/covers 300 % .* scaled down/);
		expect(w2.join(' | ')).toMatch(/land cover on "G" skipped/);
	});

	it('takes the reduction off the farm’s runoff as its own series; zero patches change nothing, and clearing them returns the natural series', () => {
		const natural = [100, 200, 1000, 4000, 300];
		const none = run(input([], 5), natural);
		const cleared = run(input([patch({ areaKm2: 0 })], 5), natural);
		const pine = run(input([patch({})], 5), natural);
		for (const o of [none, cleared, pine]) expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(none.series.some((s) => s.key === 'landcover_reduction')).toBe(false);
		expect(none.summary.landCover).toBeUndefined();
		expect(col(cleared, null, 'simulated_outflow')).toEqual(col(none, null, 'simulated_outflow'));
		// Pine on 2 of A's 10 km²: MAR 0.08, LOW 0.11. q = 200 (the 25th percentile) × ½ = 100.
		// A's runoff I0 = natural / 2 = 50, 100, 500, 2000, 150.
		const want = [50, 100, 500, 2000, 150].map((i0) => 0.11 * Math.min(i0, 100) + 0.08 * Math.max(i0 - 100, 0));
		col(pine, 'A', 'landcover_reduction').forEach((v, t) => expect(v).toBeCloseTo(want[t]!, 9));
		col(pine, null, 'landcover_reduction').forEach((v, t) => expect(v).toBeCloseTo(want[t]!, 9));
		col(pine, 'A', 'runoff').forEach((v, t) => expect(v).toBeCloseTo(natural[t]! / 2 - want[t]!, 9));
		// Natural flow itself is unchanged: the reduction is reported, never hidden in it.
		expect(col(pine, null, 'natural_flow')).toEqual(natural);
		const outlet = col(pine, null, 'simulated_outflow');
		outlet.forEach((v, t) => expect(v).toBeCloseTo(natural[t]! - want[t]!, 9));
		const lc = pine.summary.landCover!;
		expect(lc.lowFlowThresholdM3Day).toBe(200);
		expect(lc.reductionM3Day).toBeCloseTo(want.reduce((a, b) => a + b, 0) / 5, 9);
		expect(lc.byClass).toHaveLength(1);
		expect(lc.byClass[0]).toMatchObject({ coverClass: 'pine', condensedKm2: 2 });
		// mm/yr over the 2 km² condensed: mean m³/day ÷ 2000 m³ per mm × 365.25.
		expect(lc.byClass[0]!.mmPerYear).toBeCloseTo((lc.reductionM3Day / 2000) * 365.25, 9);
		expect(pine.summary.waterBalance!.total.landCoverReductionM3).toBeCloseTo(want.reduce((a, b) => a + b, 0), 9);
	});

	it('the reduction never exceeds the natural runoff, even under a closed stand removing everything', () => {
		const o = run(input([patch({ areaKm2: 10, factors: { mar: 1, lowFlow: 1 } })], 3), [100, 0, 500]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'runoff')).toEqual([0, 0, 0]);
		expect(col(o, 'A', 'landcover_reduction')).toEqual([50, 0, 250]);
	});

	it('the self-check catches a reduction that does not follow the patches', () => {
		const i = input([patch({})], 4);
		const o = run(i, [100, 200, 300, 400]);
		expect(checkLandCover(i, o)).toBeNull();
		const broken = structuredClone(o);
		col(broken, 'A', 'landcover_reduction')[2]! += 5;
		expect(checkLandCover(i, broken)).toMatch(/A day 2/);
		const moreCover = structuredClone(i);
		moreCover.model.landCover![0]!.areaKm2 = 4;
		expect(checkLandCover(moreCover, o)).toMatch(/land-cover reduction .* ≠/);
	});
});
