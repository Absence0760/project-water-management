// Boreholes and stream depletion (WP-1.34, docs/model.md §2.7d): hand-worked
// cases on a fixed natural flow.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkGroundwater, checkInvariants } from '../verify/checks';
import { randomInput } from '../testing/fuzz';
import { checkDoubledCropAreas, droughtBoreholesAsSupplemental } from '../testing/invariants';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];

/**
 * A January run of `natural.length` dry days. Farm A needs `need` m³/day
 * (31 000 m² of a crop with factor 1, the January A-pan set to the need,
 * efficiency 1, no effective rain) and drains into the outlet gauge G.
 */
function input(a: Partial<NetworkNode>, need: number, days: number): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = need;
	return {
		settings: { runoffModel: 'legacy', apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', a)],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)!.values;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('boreholes (WP-1.34)', () => {
	it('supplemental boreholes cover only what the river cannot; primary ones pump first', () => {
		// A dam-less farm needing 2000 m³/day, a borehole of 800 m³/day, no depletion.
		const natural = [1000, 10_000, 1500];
		const supp = run(input({ boreholeCapacityM3Day: 800, boreholeRule: 'supplemental' }, 2000, 3), natural);
		const prim = run(input({ boreholeCapacityM3Day: 800, boreholeRule: 'primary' }, 2000, 3), natural);
		for (const o of [supp, prim]) expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		// Supplemental: river 1000 + 800 pumped (200 short); wet day none pumped; 1500 + 500.
		expect(col(supp, 'A', 'groundwater_used')).toEqual([800, 0, 500]);
		expect(col(supp, 'A', 'supplied')).toEqual([1800, 2000, 2000]);
		expect(col(supp, 'A', 'deficit')).toEqual([200, 0, 0]);
		// Primary: 800 pumped every day, the river covers the rest.
		expect(col(prim, 'A', 'groundwater_used')).toEqual([800, 800, 800]);
		expect(col(prim, 'A', 'supplied')).toEqual([1800, 2000, 2000]);
		// So the river keeps more on a wet day: 10 000 − 1200 instead of − 2000.
		expect(col(prim, null, 'simulated_outflow')[1]).toBe(8800);
		expect(col(supp, null, 'simulated_outflow')[1]).toBe(8000);
		expect(supp.summary.farms[0]).toMatchObject({ avgGroundwaterM3Day: 1300 / 3, avgBaseflowDepletionM3Day: 0 });
	});

	it('drought boreholes run only while the dam is below its trigger', () => {
		// A dam of 10 000 m³ starting full, no inflow, 3000 m³/day demand, trigger 50 %:
		// day 0 (10 000 at the start) the dam gives 3000; day 1 (7000) 3000; day 2 (4000 < 5000) the dam gives 3000 and nothing is pumped
		// because it covers the demand; day 3 (1000) the dam gives 1000 and the borehole 2000 (capacity 2500).
		const a = { damCapacityM3: 10_000, damInitialPct: 1, pctRunoffToDam: 1, boreholeCapacityM3Day: 2500, boreholeRule: 'drought' as const, boreholeTriggerPct: 0.5 };
		const o = run(input(a, 3000, 5), [0, 0, 0, 0, 0]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'groundwater_used')).toEqual([0, 0, 0, 2000, 2500]);
		expect(col(o, 'A', 'supplied')).toEqual([3000, 3000, 3000, 3000, 2500]);
		// Supplemental pumps as soon as the dam falls short, whatever its level.
		const s = run(input({ ...a, boreholeRule: 'supplemental' }, 3000, 5), [0, 0, 0, 0, 0]);
		expect(col(s, 'A', 'groundwater_used')).toEqual([0, 0, 0, 2000, 2500]);
		// With the trigger at 0 the drought rule never pumps.
		const never = run(input({ ...a, boreholeTriggerPct: 0 }, 3000, 5), [0, 0, 0, 0, 0]);
		expect(col(never, 'A', 'groundwater_used')).toEqual([0, 0, 0, 0, 0]);
	});

	it('stream depletion d × pumping is taken from the river, the same day without a lag', () => {
		// Primary 1000 m³/day, d = 0.4, no lag: 400 leaves the river below the farm each day.
		const o = run(input({ boreholeCapacityM3Day: 1000, boreholeRule: 'primary', streamDepletionFrac: 0.4 }, 1000, 3), [5000, 5000, 5000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'baseflow_depletion')).toEqual([400, 400, 400]);
		// The river keeps all 5000 of its runoff (the borehole covers the farm) less the depletion.
		expect(col(o, null, 'simulated_outflow')).toEqual([4600, 4600, 4600]);
		const wb = o.summary.waterBalance!.total;
		expect(wb.groundwaterM3).toBe(3000);
		expect(wb.streamDepletionM3).toBe(1200);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-9);
	});

	it('the lag spreads the depletion out and conserves its volume: over a long run Σ depletion → d × Σ pumping', () => {
		// Pump 1000 m³/day for 10 days, then stop; d = 0.5, k = 20 days; the river always has water.
		const days = 2000;
		const i = input({ boreholeCapacityM3Day: 1000, boreholeRule: 'primary', streamDepletionFrac: 0.5, streamDepletionLagDays: 20 }, 1000, days);
		// Demand only in January of the first year: 31 days of pumping.
		const o = run(i, new Array(days).fill(1e6));
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const pumped = sum(col(o, 'A', 'groundwater_used'));
		const dep = col(o, 'A', 'baseflow_depletion');
		const store = col(o, 'A', 'depletion_store');
		// Day 0: 500 into the store, α = 1 − e^(−1/20) of it out.
		const alpha = 1 - Math.exp(-1 / 20);
		expect(dep[0]).toBeCloseTo(500 * alpha, 9);
		// Depletion keeps going after the pumping stops (January is 31 days; it runs every January).
		const firstFeb = 31;
		expect(col(o, 'A', 'groundwater_used')[firstFeb]).toBe(0);
		expect(dep[firstFeb]).toBeGreaterThan(0);
		// Volume: d × Σ pumped = Σ depletion + what is still in the store.
		expect(sum(dep) + store.at(-1)!).toBeCloseTo(0.5 * pumped, 6);
	});

	it('depletion never takes the river below 0: the unmet part is reported and warned about', () => {
		// The farm takes the whole river, and pumps the rest; d = 1: nothing is left to deplete.
		const o = run(input({ boreholeCapacityM3Day: 5000, boreholeRule: 'supplemental', streamDepletionFrac: 1 }, 3000, 2), [1000, 1000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'baseflow_depletion')).toEqual([0, 0]);
		expect(col(o, 'A', 'depletion_unmet')).toEqual([2000, 2000]);
		expect(col(o, null, 'simulated_outflow')).toEqual([0, 0]);
		expect(o.summary.warnings.some((w) => w.startsWith('stream depletion of 4000 m³ over the run could not be taken from the river'))).toBe(true);
	});

	it('a farm with boreholes shows less deficit, and the outlet shows the depletion', () => {
		const natural = [800, 800, 800];
		const without = run(input({}, 2000, 3), natural);
		const withB = run(input({ boreholeCapacityM3Day: 1000, streamDepletionFrac: 0.3 }, 2000, 3), [5000, 5000, 5000]);
		const withSame = run(input({ boreholeCapacityM3Day: 1000, streamDepletionFrac: 0.3 }, 2000, 3), natural);
		expect(withSame.summary.farms[0]!.avgDeficitM3Day).toBeLessThan(without.summary.farms[0]!.avgDeficitM3Day);
		// Wet enough that the farm is served from the river: no pumping, no depletion.
		expect(col(withB, 'A', 'groundwater_used')).toEqual([0, 0, 0]);
		// Dry: pumped 1000 a day, 300 of which the river can't give (it's all taken): unmet.
		expect(col(withSame, 'A', 'groundwater_used')).toEqual([1000, 1000, 1000]);
		expect(col(withSame, 'A', 'depletion_unmet')).toEqual([300, 300, 300]);
	});

	it('an other water user can have boreholes too', () => {
		const i = input({}, 0, 2);
		i.model.nodes.push(node('U', 'user', 'G', { userDemandM3Day: flat(1500), boreholeCapacityM3Day: 1000, streamDepletionFrac: 0.5 }));
		i.model.nodes.find((n) => n.id === 'A')!.downstreamNodeId = 'U';
		const o = run(i, [1000, 3000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		// Day 0: 1000 from the river, 500 pumped, 250 depletion — but the river below has 0 left: unmet.
		expect(col(o, 'U', 'groundwater_used')).toEqual([500, 0]);
		expect(col(o, 'U', 'supplied')).toEqual([1500, 1500]);
		expect(col(o, 'U', 'depletion_unmet')).toEqual([250, 0]);
		expect(o.summary.users![0]!.avgGroundwaterM3Day).toBe(250);
	});

	it('no boreholes: no groundwater series or summary fields, and the self-checks catch a broken lag', () => {
		const plain = run(input({}, 1000, 2), [5000, 5000]);
		expect(plain.series.some((s) => s.key === 'groundwater_used')).toBe(false);
		expect(plain.summary.farms[0]!.avgGroundwaterM3Day).toBeUndefined();
		expect(plain.summary.waterBalance!.total.groundwaterM3).toBeUndefined();
		const i = input({ boreholeCapacityM3Day: 1000, boreholeRule: 'primary', streamDepletionFrac: 0.4, streamDepletionLagDays: 3 }, 1000, 3);
		const o = run(i, [5000, 5000, 5000]);
		expect(checkInvariants(i, o)).toBeNull();
		const broken = structuredClone(o);
		col(broken, 'A', 'depletion_store')[1]! -= 10;
		expect(checkGroundwater(i, broken)).toMatch(/A day 1: depletion store|A day 2/);
		const greedy = structuredClone(o);
		col(greedy, 'A', 'groundwater_used')[0] = 2000;
		expect(checkGroundwater(i, greedy)).toMatch(/groundwater 2000 outside/);
	});

	it('a drought rule can legitimately raise the supply fraction when demand grows (seed 1450), so the doubled-crop-area law is checked without it', () => {
		const input = randomInput(1450, { runoffModel: 'gr4j' });
		expect(checkDoubledCropAreas(input)).toMatch(/doubling crop areas raised n16's supply fraction/);
		expect(checkDoubledCropAreas(droughtBoreholesAsSupplemental(input))).toBeNull();
	});
});
