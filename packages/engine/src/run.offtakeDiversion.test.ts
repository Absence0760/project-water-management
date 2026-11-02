// River off-takes sized by a diversion curve (engine 1.113.0, docs/model.md
// §2.6a): the rule diverts a share of the river's flow at the off-take,
// MIN(maxShare, a · x^b ÷ 100) of it, then its capacity, its keeps and the
// receiver hold it as they hold any off-take. A canal of the shape the client's
// hydrologist gave (2026-11-02), with invented numbers (2000 · x^−0.9 %, at
// most 95 %, a canal of 0.25 m³/s), under each candidate flow unit, and the
// invariants a run keeps whatever the curve. The random networks (./fuzz)
// give half their capacity-sized off-takes a curve; e2e/deep.offtakeFuzz replays them.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { modelRuleProblems } from './modelRules';
import { diversionShareOf, type DiversionCurve } from './network/offtake';
import { DIVERSION_FLOW_UNIT_M3_DAY, type DemandObject, type DiversionFlowUnit, type ModelInput, type NetworkNode, type RunSeries, type Transfer } from './project';
import { runModelWith, withVerification } from './run';
import { checkInvariants } from './verify/checks';

const flat = (v: number) => new Array(12).fill(v);

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
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

const town = (nodeId: string, m3Day: number): DemandObject => ({
	id: `town-${nodeId}`,
	nodeId,
	name: 'Town',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: flat(m3Day),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: ''
});

const CANAL_M3S = 0.25;
const CANAL_M3_DAY = CANAL_M3S * 86_400;

/** The canal: from the river unit S into the canal head C, 2000 · x^−0.9 % of the flow, at most 95 %, 0.25 m³/s. */
const canal = (over: Partial<Transfer> = {}): Transfer => ({
	id: 'canal',
	fromNodeId: 'S',
	toNodeId: 'C',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: CANAL_M3S,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	handsOffM3Day: null,
	handsOffEwr: false,
	lossPct: 0,
	sizing: 'diversionCurve',
	topUpDam: false,
	diversionCoefficient: 2000,
	diversionExponent: -0.9,
	diversionMaxPct: 0.95,
	diversionFlowUnit: 'L/s',
	diversionFlowBasis: 'modelled',
	...over
});

// The river unit S gets all the runoff and drains to the outlet gauge G; the canal head C (no dam, no demand) drains to
// the town's unit T, which pumps from the river for its town, then to G.
function model(transfers: Transfer[], days: number, opts: { ewr?: number; nodes?: NetworkNode[]; objects?: DemandObject[] } = {}): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(opts.ewr ?? 0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly },
		model: {
			nodes: opts.nodes ?? [
				node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
				node('S', { areaKm2: 1, sortOrder: 1 }),
				node('C', { downstreamNodeId: 'T', sortOrder: 2 }),
				node('T', { sortOrder: 3, supplyRule: 'runOfRiver', pumpCapacityM3Day: null })
			],
			crops: [],
			cropAreas: [],
			transfers,
			demandObjects: opts.objects ?? [town('T', 60)]
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const near = (a: number[], b: number[], digits = 6) => a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
function passes(input: ModelInput, out: ReturnType<typeof run>) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	expect(out.summary.waterBalance?.total.residualM3).toBeCloseTo(0, 4);
}
const curveIn = (unit: DiversionFlowUnit): DiversionCurve => ({ a: 2000, b: -0.9, maxShare: 0.95, m3DayPerUnit: DIVERSION_FLOW_UNIT_M3_DAY[unit], natural: false });

// A dry day, 20 L/s (the 95 % cap), 100 L/s, 1 000 L/s, 0.5 m³/s and 10 m³/s, in m³/day.
const FLOWS = [0, 1_728, 8_640, 86_400, 43_200, 864_000];

describe('river off-takes sized by a diversion curve (engine 1.113.0)', () => {
	it('in L/s: 95 % at low flows, a falling share above 29.5 L/s, and the 0.25 m³/s canal never full', () => {
		const input = model([canal()], FLOWS.length);
		const out = run(input, FLOWS);
		const want = FLOWS.map((x) => Math.min(CANAL_M3_DAY, diversionShareOf(curveIn('L/s'), x) * x));
		near(get(out, 'S', 'offtake_out'), want);
		// 20 L/s: 95 % of it; 100 L/s: 31.7 %; 1 000 L/s: 3.99 %; 10 m³/s: 0.50 %, 4 341 m³/day, below the canal's 21 600.
		expect(want[1]).toBeCloseTo(0.95 * 1_728, 9);
		expect(want[2]! / 8_640).toBeCloseTo(0.317, 4);
		expect(want[3]! / 86_400).toBeCloseTo(0.0399, 4);
		expect(want[5]).toBeLessThan(CANAL_M3_DAY);
		expect(want[5]).toBeCloseTo(4_340.5, 0);
		// The river loses exactly what was taken; the canal head passes it on to the town.
		near(get(out, 'S', 'outflow'), FLOWS.map((x, t) => x - want[t]!));
		near(get(out, 'C', 'offtake_in'), want);
		expect(get(out, 'S', 'offtake_out')[0]).toBe(0);
		passes(input, out);
	});

	it('in m³/s (or Ml/day), the same numbers take 95 % of the river up to the canal\'s 0.25 m³/s', () => {
		for (const unit of ['m3/s', 'Ml/day'] as const) {
			const input = model([canal({ diversionFlowUnit: unit })], FLOWS.length);
			const out = run(input, FLOWS);
			near(get(out, 'S', 'offtake_out'), FLOWS.map((x) => Math.min(CANAL_M3_DAY, 0.95 * x)));
			passes(input, out);
		}
	});

	it('in m³/day the curve is under the cap above 29.5 m³/day, so it takes a small share of a real river', () => {
		const input = model([canal({ diversionFlowUnit: 'm3/day' })], FLOWS.length);
		const out = run(input, FLOWS);
		near(get(out, 'S', 'offtake_out'), FLOWS.map((x) => Math.min(CANAL_M3_DAY, diversionShareOf(curveIn('m3/day'), x) * x)));
		passes(input, out);
	});

	it('the share is of the flow leaving the source after its own use, and the day\'s capacity and keeps still hold it', () => {
		// A fixed 50 % (b = 0) of 1 000: 500, held to a canal of 300 m³/day, then to what a 900 m³/day hands-off flow leaves.
		const half = canal({ diversionCoefficient: 50, diversionExponent: 0, diversionMaxPct: null, diversionFlowUnit: 'm3/day' });
		expect(get(run(model([half], 2), [1000, 1000]), 'S', 'offtake_out')).toEqual([500, 500]);
		const capped = model([{ ...half, maxRateM3s: 300 / 86_400 }], 2);
		near(get(run(capped, [1000, 1000]), 'S', 'offtake_out'), [300, 300], 9);
		const keep = model([{ ...half, handsOffM3Day: 900 }], 2);
		const out = run(keep, [1000, 1000]);
		near(get(out, 'S', 'offtake_out'), [100, 100], 9);
		passes(keep, out);
		// The EWR at the source when asked: 980 of the 1 000 stays.
		const ewr = model([{ ...half, handsOffEwr: true }], 2, { ewr: 980 });
		near(get(run(ewr, [1000, 1000]), 'S', 'offtake_out'), [20, 20], 9);
	});

	it('reads the modelled flow after upstream use by default, or the natural flow when asked, and takes its share of the river there', () => {
		// An upper unit U with a town pumping 400 m³/day from the river, above the river unit S. 100 / x percent × 100
		// (a = 10 000, b = −1, in m³/day): read at the modelled flow it takes 100 m³/day whatever the flow; read at the
		// natural flow (all of the catchment's 1 000) it takes 10 % of what reaches the off-take.
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('U', { areaKm2: 1, downstreamNodeId: 'S', sortOrder: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: null }),
			node('S', { areaKm2: 1, sortOrder: 1 }),
			node('C', { downstreamNodeId: 'T', sortOrder: 2 }),
			node('T', { sortOrder: 3, supplyRule: 'runOfRiver', pumpCapacityM3Day: null })
		];
		const curve = { diversionCoefficient: 10_000, diversionExponent: -1, diversionMaxPct: null, diversionFlowUnit: 'm3/day' as const };
		const objects = [town('U', 400), town('T', 60)];
		const modelled = model([canal({ ...curve, diversionFlowBasis: 'modelled' })], 2, { nodes, objects });
		const a = run(modelled, [1000, 1000]);
		const U0 = (out: ReturnType<typeof run>) => get(out, 'S', 'outflow').map((v, t) => v + get(out, 'S', 'offtake_out')[t]!);
		// 400 of the 1 000 is pumped above, so 600 reaches the off-take.
		near(U0(a), [600, 600], 9);
		near(get(a, 'S', 'offtake_out'), [100, 100], 9);
		passes(modelled, a);
		const natural = model([canal({ ...curve, diversionFlowBasis: 'natural' })], 2, { nodes, objects });
		const b = run(natural, [1000, 1000]);
		near(U0(b), [600, 600], 9);
		near(get(b, 'S', 'offtake_out'), [60, 60], 9);
		passes(natural, b);
		// Absent basis is the modelled flow.
		near(get(run(model([canal({ ...curve, diversionFlowBasis: null })], 2, { nodes, objects }), [1000, 1000]), 'S', 'offtake_out'), [100, 100], 9);
	});

	it('what the destination doesn\'t use flows on, and conveyance losses leave the catchment, as for a rule sized to capacity', () => {
		const input = model([canal({ diversionFlowUnit: 'm3/s', lossPct: 0.2 })], 2);
		const out = run(input, [1000, 1000]);
		near(get(out, 'S', 'offtake_out'), [950, 950], 9);
		near(get(out, 'C', 'offtake_in'), [760, 760], 9);
		// The town takes its 60 from what the canal brought; the other 700 flows on.
		near(get(out, 'T', 'supplied'), [60, 60], 9);
		expect(out.summary.waterBalance?.total.conveyanceLossM3).toBeCloseTo(2 * 190, 6);
		passes(input, out);
	});

	it('runs an incomplete curve as a rule that takes nothing, saying why, and a save refuses one', () => {
		const input = model([canal({ diversionFlowUnit: null })], 2);
		const out = run(input, [1000, 1000]);
		expect(get(out, 'S', 'offtake_out')).toEqual([0, 0]);
		expect(out.summary.warnings).toContain('river off-take S → C: sized by a diversion curve, but its flow unit must be one of L/s, m3/s, m3/day, Ml/day; it takes nothing');
		passes(input, out);
		expect(modelRuleProblems(input.model)).toContain('river off-take canal: sized by a diversion curve, its flow unit must be one of L/s, m3/s, m3/day, Ml/day');
		expect(modelRuleProblems(model([canal({ diversionMaxPct: 1.2 })], 2).model).some((p) => /largest share must be above 0 % and at most 100 %/.test(p))).toBe(true);
		expect(modelRuleProblems(model([canal({ diversionCoefficient: 0 })], 2).model).some((p) => /coefficient a must be a number above 0/.test(p))).toBe(true);
		// The curve's fields are inert on another sizing: a capacity-sized rule with half a curve saves.
		expect(modelRuleProblems(model([canal({ sizing: 'capacity', diversionFlowUnit: null })], 2).model)).toEqual([]);
		expect(modelRuleProblems(model([canal()], 2).model)).toEqual([]);
	});

	it('shares a short river with a rule of its priority pro rata to what each asks, never below either keep', () => {
		// The curve asks 95 % (in m³/s) of 1 000; a capacity rule beside it asks 300. Together 1 250 > 1 000: 950 : 300.
		const other: Transfer = { ...canal(), id: 'pump', sizing: 'capacity', maxRateM3s: 300 / 86_400, diversionCoefficient: null, diversionExponent: null, diversionMaxPct: null, diversionFlowUnit: null };
		const input = model([canal({ diversionFlowUnit: 'm3/s' }), other], 2);
		const out = run(input, [1000, 1000]);
		near(get(out, 'S', 'transfer_rule@canal'), [(1000 * 950) / 1250, (1000 * 950) / 1250], 6);
		near(get(out, 'S', 'transfer_rule@pump'), [(1000 * 300) / 1250, (1000 * 300) / 1250], 6);
		passes(input, out);
	});
});
