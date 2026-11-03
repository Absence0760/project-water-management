// Transfers split between destinations, and a maximum or a formula by month
// (engine 1.114.0, docs/model.md §2.6 *Split between destinations* and §2.6a
// *A maximum or a formula by month*). Hand examples with invented numbers: a
// canal of 10 000 m³/day split 40/60, a three-way split of a diversion curve,
// a month with a formula beside a month with a maximum, a split sized to the
// destinations' need, and a dam rule whose receiver has little room. Each run
// passes every self-check (the split one included) and closes its balance.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { modelRuleProblems } from './modelRules';
import { diversionShareOf, type DiversionCurve } from './network/offtake';
import { type DemandObject, type ModelInput, type NetworkNode, type RunSeries, type Transfer } from './project';
import { runModelWith, withVerification } from './run';
import { checkInvariants } from './verify/checks';

const flat = (v: number) => new Array(12).fill(v);
const CAP = 10_000; // m³/day
const RATE = CAP / 86_400;

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

/** A canal from the river unit S, up to 10 000 m³/day, every month. */
const canal = (over: Partial<Transfer> = {}): Transfer => ({
	id: 'canal',
	fromNodeId: 'S',
	toNodeId: 'A',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: RATE,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	handsOffM3Day: null,
	handsOffEwr: false,
	lossPct: 0,
	sizing: 'capacity',
	topUpDam: false,
	...over
});

// The river unit S gets all the runoff; A, B and C (no dam, no demand unless given) drain to the outlet gauge G.
function model(transfers: Transfer[], days: number, opts: { nodes?: NetworkNode[]; objects?: DemandObject[]; start?: string } = {}): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly },
		model: {
			nodes: opts.nodes ?? [node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }), node('S', { areaKm2: 1, sortOrder: 1 }), node('A', { sortOrder: 2 }), node('B', { sortOrder: 3 }), node('C', { sortOrder: 4 })],
			crops: [],
			cropAreas: [],
			transfers,
			demandObjects: opts.objects ?? []
		},
		series: { rain_catchment_mm: { startDate: opts.start ?? '2021-01-01', values: new Array(days).fill(0) } }
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

const split = (...d: [string | null, number][]) => ({ toNodeId: d[0]![0], destinations: d.map(([nodeId, pct]) => ({ nodeId, pct })) });

describe('a transfer split between destinations (engine 1.114.0)', () => {
	it('splits a canal run to capacity 40/60, after its losses: 50 000 m³ in the river takes 10 000, 3 600 and 5 400 arrive', () => {
		const input = model([canal({ lossPct: 0.1, ...split(['A', 0.4], ['B', 0.6]) })], 2);
		const out = run(input, [50_000, 5_000]);
		passes(input, out);
		// What it took, per destination (each piece's own series under the rule's id), and Σ at the source.
		near(get(out, 'S', 'transfer_rule@canal#0'), [4_000, 2_000]);
		near(get(out, 'S', 'transfer_rule@canal#1'), [6_000, 3_000]);
		near(get(out, 'S', 'offtake_out'), [10_000, 5_000]);
		// Diverted → losses → split: each destination gets its share of what arrives.
		near(get(out, 'A', 'offtake_in'), [3_600, 1_800]);
		near(get(out, 'B', 'offtake_in'), [5_400, 2_700]);
		near(get(out, 'S', 'outflow'), [40_000, 0]);
		expect(out.series.some((s) => s.key === 'transfer_rule@canal')).toBe(false);
	});

	it('takes what the one rule takes, split three ways 20/30/50 by a curve', () => {
		const curve = { sizing: 'diversionCurve' as const, diversionCoefficient: 2000, diversionExponent: -0.9, diversionMaxPct: 0.95, diversionFlowUnit: 'L/s' as const, diversionFlowBasis: 'modelled' as const };
		const flows = [500, 2_000, 8_000, 40_000, 200_000];
		const one = run(model([canal({ ...curve })], flows.length), flows);
		const three = model([canal({ ...curve, ...split(['A', 0.2], ['B', 0.3], ['C', 0.5]) })], flows.length);
		const out = run(three, flows);
		passes(three, out);
		const whole = get(one, 'S', 'offtake_out');
		// The curve by hand: MIN(10 000, MIN(95 %, 2000 · (x/86.4)^−0.9 %) × x).
		const c: DiversionCurve = { a: 2000, b: -0.9, maxShare: 0.95, m3DayPerUnit: 86.4, natural: false };
		near(whole, flows.map((x) => Math.min(CAP, diversionShareOf(c, x) * x)));
		near(get(out, 'S', 'offtake_out'), whole);
		[0.2, 0.3, 0.5].forEach((p, k) =>
			near(
				get(out, 'S', `transfer_rule@canal#${k}`),
				whole.map((v) => v * p)
			)
		);
		near(get(out, 'C', 'offtake_in'), whole.map((v) => v * 0.5));
	});

	it('splits a rule sized to its destinations’ need by its shares: 1 000 needed at A, none at B, 500 each arrive', () => {
		const input = model([canal({ sizing: 'demand', ...split(['A', 0.5], ['B', 0.5]) })], 2, { objects: [town('A', 1_000)] });
		const out = run(input, [50_000, 50_000]);
		passes(input, out);
		// The demand is the sum of the destinations' needs (1 000), and the split still applies: A gets half.
		near(get(out, 'S', 'offtake_out'), [1_000, 1_000]);
		near(get(out, 'A', 'offtake_in'), [500, 500]);
		near(get(out, 'B', 'offtake_in'), [500, 500]);
		near(get(out, 'A', 'offtake_used'), [500, 500]);
		// B needs none of it: its 500 flows on below it, as a capacity-sized rule's surplus does.
		near(get(out, 'B', 'outflow'), [500, 500]);
	});

	it('under an allocation cap, sizes to the destinations’ capped needs together and still splits by its shares (engine-audit SP1)', () => {
		// A and B each have a town of 1 000 m³/day; B's licence leaves it no surface room, so the rule takes for A's 1 000 alone.
		const input = model([canal({ sizing: 'demand', lossPct: 0.2, ...split(['A', 0.5], ['B', 0.5]) })], 2, { objects: [town('A', 1_000), town('B', 1_000)] });
		input.settings = { ...input.settings, allocationMode: 'cap' } as ModelInput['settings'];
		input.model.allocations = [
			{ id: 'LA', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 1e9 },
			{ id: 'LB', nodeId: 'B', waterSource: 'surface', volumeM3PerYear: 0 }
		];
		const out = run(input, [50_000, 50_000]);
		passes(input, out);
		// Σ need ÷ (1 − l) = 1 000 ÷ 0.8 = 1 250 taken; 500 arrives at each, B uses none of it and it flows on.
		near(get(out, 'S', 'offtake_out'), [1_250, 1_250]);
		near(get(out, 'A', 'offtake_in'), [500, 500]);
		near(get(out, 'B', 'offtake_in'), [500, 500]);
		near(get(out, 'A', 'offtake_used'), [500, 500]);
		near(get(out, 'B', 'offtake_used'), [0, 0]);
	});

	it('with a top-up, a share its destination doesn’t need fills its dam and spills what doesn’t fit, the balance closed', () => {
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('S', { areaKm2: 1, sortOrder: 1 }),
			node('A', { sortOrder: 2 }),
			node('B', { sortOrder: 3, damCapacityM3: 300, damInitialPct: 0 })
		];
		const input = model([canal({ sizing: 'demand', topUpDam: true, ...split(['A', 0.5], ['B', 0.5]) })], 2, { nodes, objects: [town('A', 1_000)] });
		const out = run(input, [50_000, 50_000]);
		passes(input, out);
		// Day 1: A's need 1 000 and B's dam room 300 together, 1 300, half each: B's 650 fills its dam (300), 350 spills on.
		near(get(out, 'S', 'offtake_out'), [1_300, 1_000]);
		near(get(out, 'B', 'dam_storage'), [300, 300]);
		near(get(out, 'A', 'offtake_used'), [650, 500]);
	});

	it('sends a dam rule’s shares only as far as each receiver’s room: A full at 100, B 600, the rest stays', () => {
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('S', { sortOrder: 1, damCapacityM3: 10_000, damInitialPct: 1 }),
			node('A', { sortOrder: 2, damCapacityM3: 1_000, damInitialPct: 0.9 }),
			node('B', { sortOrder: 3, damCapacityM3: 10_000, damInitialPct: 0 })
		];
		const rule = canal({ source: 'dam', sizing: 'demand', maxRateM3s: 1_000 / 86_400, ...split(['A', 0.4], ['B', 0.6]) });
		const input = model([rule], 1, { nodes });
		const out = run(input, [0]);
		passes(input, out);
		near(get(out, 'S', 'transfer_rule@canal#0'), [100]);
		near(get(out, 'S', 'transfer_rule@canal#1'), [600]);
		near(get(out, 'S', 'dam_storage'), [9_300]);
	});

	it('runs a rule with one destination listed as the rule itself, to the bit', () => {
		const flows = [500, 20_000, 80_000];
		const a = run(model([canal()], 3), flows);
		const b = run(model([canal({ ...split(['A', 1]) })], 3), flows);
		expect(b.series.map((s) => [s.nodeId, s.key, s.values])).toEqual(a.series.map((s) => [s.nodeId, s.key, s.values]));
	});
});

describe('a maximum or a formula by month (engine 1.114.0)', () => {
	it('takes the curve’s share in a formula month and up to its maximum in the next, in one rule', () => {
		const curve = { coefficient: 50, exponent: 0, maxPct: null };
		// Oct–Mar a formula (50 % of the river), Apr–Sep a maximum; both up to the canal's 10 000 m³/day.
		const rule = canal({ sizing: 'diversionCurve', monthlyDiversion: [curve, curve, curve, curve, curve, curve, null, null, null, null, null, null], diversionFlowUnit: 'm3/day' });
		const input = model([rule], 4, { start: '2021-03-30' });
		expect(modelRuleProblems(input.model as never)).toEqual([]);
		const out = run(input, [8_000, 30_000, 8_000, 30_000]);
		passes(input, out);
		// 30 and 31 March: half the river, at most the canal; 1 and 2 April: the canal takes all it can.
		near(get(out, 'S', 'offtake_out'), [4_000, 10_000, 8_000, 10_000]);
	});

	it('reads a curve rule stored by engine 1.113.0 (one curve) as the same curve in every month', () => {
		const one = canal({ sizing: 'diversionCurve', diversionCoefficient: 2000, diversionExponent: -0.9, diversionMaxPct: 0.95, diversionFlowUnit: 'L/s' });
		const m = { coefficient: 2000, exponent: -0.9, maxPct: 0.95 };
		const monthly = canal({ sizing: 'diversionCurve', monthlyDiversion: new Array(12).fill(m), diversionFlowUnit: 'L/s' });
		const flows = [500, 2_000, 8_000, 40_000];
		const a = run(model([one], flows.length), flows);
		const b = run(model([monthly], flows.length), flows);
		expect(get(b, 'S', 'offtake_out')).toEqual(get(a, 'S', 'offtake_out'));
	});
});

describe('the save rules for splits and formulas (modelRuleIssues)', () => {
	const problems = (t: Transfer) => modelRuleProblems(model([t], 1).model as never).join(' | ');
	it('refuses shares that don’t add up to 100 %, more than five, one twice, the source, and a first that isn’t toNodeId', () => {
		expect(problems(canal({ ...split(['A', 0.4], ['B', 0.5]) }))).toMatch(/must add up to 100 % \(they add up to 90 %\)/);
		expect(problems(canal({ ...split(['A', 0.4], ['B', 0.60005]) }))).toBe('');
		const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => [id, 1 / 6] as [string, number]);
		expect(problems(canal({ ...split(...six) }))).toMatch(/at most 5 destinations/);
		expect(problems(canal({ ...split(['A', 0.5], ['A', 0.5]) }))).toMatch(/one destination twice/);
		expect(problems(canal({ ...split(['A', 0.5], ['S', 0.5]) }))).toMatch(/its own source/);
		expect(problems(canal({ toNodeId: 'B', destinations: [{ nodeId: 'A', pct: 0.5 }, { nodeId: 'B', pct: 0.5 }] }))).toMatch(/first split destination/);
		expect(problems(canal({ ...split(['A', 0], ['B', 1]) }))).toMatch(/above 0 %/);
		// A river off-take can't send a share out of the catchment; a dam rule can.
		expect(problems(canal({ ...split(['A', 0.5], [null, 0.5]) }))).toMatch(/can't send water out of the catchment/);
		const nodes = [node('G', { kind: 'gauge', downstreamNodeId: null }), node('S', { damCapacityM3: 100 }), node('A')];
		expect(modelRuleProblems(model([canal({ source: 'dam', ...split(['A', 0.5], [null, 0.5]) })], 1, { nodes }).model as never)).toEqual([]);
	});

	it('refuses a formula on a rule from the dam, and an incomplete month', () => {
		expect(problems(canal({ source: 'dam', sizing: 'diversionCurve', monthlyDiversion: new Array(12).fill({ coefficient: 1, exponent: 0, maxPct: null }), diversionFlowUnit: 'm3/day' }))).toMatch(
			/a formula takes a share of the river’s flow, so it needs the river as its source/
		);
		const list = new Array(12).fill(null);
		list[3] = { coefficient: 0, exponent: 0, maxPct: null };
		expect(problems(canal({ sizing: 'diversionCurve', monthlyDiversion: list, diversionFlowUnit: 'm3/day' }))).toMatch(/in January its coefficient a must be a number above 0/);
		expect(problems(canal({ sizing: 'diversionCurve', monthlyDiversion: new Array(12).fill(null), diversionFlowUnit: 'm3/day' }))).toMatch(/no month has a formula/);
		expect(problems(canal({ sizing: 'capacity', monthlyDiversion: new Array(12).fill(null) }))).toMatch(/must be sized by a diversion curve/);
	});
});
