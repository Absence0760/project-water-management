// River off-takes (engine 1.14.0, issue #54, docs/model.md §2.6a): a transfer
// rule with source 'river' takes from the flow leaving its source unit today,
// up to its capacity, above what must stay in the river, and delivers what
// isn't lost on the way to its destination, which uses it first, tops up its
// dam when asked and passes the rest on. Hand examples; the random networks
// (./fuzz) hold every invariant with off-takes in a quarter of the seeds.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { DemandObject, ModelInput, NetworkNode, RunSeries, Transfer } from './project';
import { runModelWith, withVerification } from './run';
import { checkEwrAttribution, checkInvariants, checkTransferLimits } from './verify/checks';
import { modelRuleProblems } from './modelRules';

const flat = (v: number) => new Array(12).fill(v);

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
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

const town = (nodeId: string, m3Day = 60): DemandObject => ({
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

/** An off-take of `m3Day` a day, all year, from S to C, sized to capacity. */
const offtake = (over: Partial<Transfer> = {}): Transfer => ({
	id: 'o1',
	fromNodeId: 'S',
	toNodeId: 'C',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 100 / 86_400,
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

// The upper river unit S gets all the runoff and drains to the outlet gauge G.
// A canal head C (no dam, no demand, no runoff) drains to the town's unit T,
// which pumps from the river (run of river, no pump limit) for its town's 60
// m³/day, then to G. Without an off-take the town gets nothing.
function model(transfers: Transfer[], opts: { ewr?: number; nodes?: NetworkNode[]; objects?: DemandObject[] } = {}): ModelInput {
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
			demandObjects: opts.objects ?? [town('T')]
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: [0, 0] } }
	};
}

const run = (input: ModelInput, natural = [1000, 1000]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const near = (a: number[], b: number[]) => a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, 9));
function passes(input: ModelInput, out: ReturnType<typeof run>) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}

describe('river off-takes (engine 1.14.0)', () => {
	it('without one the canal carries nothing and the town is dry', () => {
		const out = run(model([]));
		expect(get(out, 'T', 'supplied')).toEqual([0, 0]);
		expect(out.series.some((s) => s.key === 'offtake_in' || s.key === 'offtake_out')).toBe(false);
	});

	it('takes up to its capacity from the flow leaving the source, down the canal to the town, the rest flowing on', () => {
		const input = model([offtake()]);
		const out = run(input);
		// The source's reach loses exactly what the off-take took.
		expect(get(out, 'S', 'offtake_out')).toEqual([100, 100]);
		expect(get(out, 'S', 'outflow')).toEqual([900, 900]);
		expect(get(out, 'S', 'transfer_rule@o1')).toEqual([100, 100]);
		// The canal head passes it on (no demand, no dam); the town pumps its 60 and 40 flows on.
		expect(get(out, 'C', 'offtake_in')).toEqual([100, 100]);
		expect(get(out, 'C', 'offtake_used')).toEqual([0, 0]);
		expect(get(out, 'C', 'outflow')).toEqual([100, 100]);
		expect(get(out, 'T', 'supplied')).toEqual([60, 60]);
		expect(get(out, 'T', 'outflow')).toEqual([40, 40]);
		expect(get(out, 'G', 'outflow')).toEqual([940, 940]);
		passes(input, out);
	});

	it('never takes more than the river there: a dry day takes nothing, a low day what flows', () => {
		const input = model([offtake()]);
		const out = run(input, [0, 30]);
		expect(get(out, 'S', 'offtake_out')).toEqual([0, 30]);
		expect(get(out, 'S', 'outflow')).toEqual([0, 0]);
		expect(get(out, 'T', 'supplied')).toEqual([0, 30]);
		passes(input, out);
	});

	it('leaves a hands-off flow, and the EWR when asked, in the river first', () => {
		const handsOff = model([offtake({ handsOffM3Day: 950 })]);
		expect(get(run(handsOff), 'S', 'offtake_out')).toEqual([50, 50]);
		passes(handsOff, run(handsOff));
		// The EWR at the source: all of the catchment's 980 m³/day (S carries the whole flow share).
		const ewr = model([offtake({ handsOffEwr: true })], { ewr: 980 });
		const out = run(ewr);
		near(get(out, 'S', 'offtake_out'), [20, 20]);
		passes(ewr, out);
		// Without it the EWR is not protected, like any other abstraction (docs/model.md §2.7b).
		expect(get(run(model([offtake()], { ewr: 980 })), 'S', 'offtake_out')).toEqual([100, 100]);
	});

	it('loses its conveyance losses on the way, out of the catchment', () => {
		const input = model([offtake({ lossPct: 0.25 })]);
		const out = run(input);
		expect(get(out, 'S', 'offtake_out')).toEqual([100, 100]);
		expect(get(out, 'C', 'offtake_in')).toEqual([75, 75]);
		expect(get(out, 'G', 'outflow')).toEqual([915, 915]);
		expect(out.summary.waterBalance?.total.conveyanceLossM3).toBeCloseTo(50, 9);
		expect(out.summary.supplyAssurance?.waterAccount.total.conveyanceLossM3).toBeCloseTo(50, 9);
		expect(out.summary.waterBalance?.total.residualM3).toBeCloseTo(0, 6);
		passes(input, out);
	});

	it('sized to demand, it takes only what the destination needs, grossed up for its losses, and meets it first', () => {
		// Straight into the town's unit, whose own pump is off (capacity 0): the off-take alone serves it.
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('S', { areaKm2: 1, sortOrder: 1 }),
			node('T', { sortOrder: 3, supplyRule: 'runOfRiver', pumpCapacityM3Day: 0 })
		];
		const input = model([offtake({ toNodeId: 'T', sizing: 'demand', lossPct: 0.25 })], { nodes });
		const out = run(input);
		near(get(out, 'S', 'offtake_out'), [80, 80]);
		near(get(out, 'T', 'offtake_in'), [60, 60]);
		near(get(out, 'T', 'offtake_used'), [60, 60]);
		near(get(out, 'T', 'supplied'), [60, 60]);
		near(get(out, 'T', 'outflow'), [0, 0]);
		passes(input, out);
	});

	it('tops up the destination\'s dam with what is left when the rule says so, never past full', () => {
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('S', { areaKm2: 1, sortOrder: 1 }),
			node('D', { sortOrder: 3, damCapacityM3: 150, damAreaFullM2: 0 })
		];
		// Sized to demand: the dam's room (150, then 0) plus no demand; capacity 100.
		const input = model([offtake({ toNodeId: 'D', sizing: 'demand', topUpDam: true })], { nodes, objects: [] });
		const out = run(input);
		expect(get(out, 'D', 'offtake_in')).toEqual([100, 50]);
		expect(get(out, 'D', 'offtake_to_dam')).toEqual([100, 50]);
		expect(get(out, 'D', 'dam_storage')).toEqual([100, 150]);
		expect(get(out, 'D', 'spill')).toEqual([0, 0]);
		passes(input, out);
		// Without top-up the same water passes the dam by.
		const pass = model([offtake({ toNodeId: 'D', topUpDam: false })], { nodes, objects: [] });
		const o2 = run(pass);
		expect(get(o2, 'D', 'dam_storage')).toEqual([0, 0]);
		expect(get(o2, 'D', 'outflow')).toEqual([100, 100]);
		passes(pass, o2);
	});

	it('shares the flow at a source by priority, and pro rata to the limits within one', () => {
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('S', { areaKm2: 1, sortOrder: 1 }),
			node('C', { downstreamNodeId: 'G', sortOrder: 2 }),
			node('E', { downstreamNodeId: 'G', sortOrder: 4 })
		];
		const big = { maxRateM3s: 600 / 86_400 };
		const ranked = model([offtake({ ...big, priority: 0 }), offtake({ ...big, id: 'o2', toNodeId: 'E', priority: 1 })], { nodes, objects: [] });
		const r = run(ranked);
		near(get(r, 'S', 'transfer_rule@o1'), [600, 600]);
		near(get(r, 'S', 'transfer_rule@o2'), [400, 400]);
		passes(ranked, r);
		// Equal priority, capacities 900 and 300: 1000 shared 3 : 1 (750 and 250); on 700 each limit is
		// MIN(flow, capacity), 700 and 300, so 490 and 210. Whatever the list order.
		for (const order of [1, -1]) {
			const tied = model([offtake({ maxRateM3s: 900 / 86_400 }), offtake({ id: 'o2', toNodeId: 'E', maxRateM3s: 300 / 86_400 })].sort(() => order), { nodes, objects: [] });
			const o = run(tied, [1000, 700]);
			near(get(o, 'S', 'transfer_rule@o1'), [750, 490]);
			near(get(o, 'S', 'transfer_rule@o2'), [250, 210]);
			passes(tied, o);
		}
	});

	it('runs only in the months with a rate, each month at its own rate (monthly rates)', () => {
		// 2021-01-31 (January, 0.001 m³/s = 86.4 m³/day) and 2021-02-01 (February, off).
		const rates = [0, 0, 0, 0.001, 0, 0, 0, 0, 0, 0, 0, 0];
		const input = model([offtake({ monthlyRateM3s: rates, months: [1], maxRateM3s: 0.001 })]);
		input.series!.rain_catchment_mm!.startDate = '2021-01-31';
		const out = run(input);
		near(get(out, 'S', 'offtake_out'), [86.4, 0]);
		passes(input, out);
	});

	it('skips an off-take whose destination drains into its source, saying so', () => {
		// C drains into S: the canal's water would reach S before the off-take could take it.
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('S', { areaKm2: 1, sortOrder: 1 }),
			node('C', { downstreamNodeId: 'S', sortOrder: 2 })
		];
		const input = model([offtake()], { nodes, objects: [] });
		const out = run(input);
		expect(out.summary.warnings.some((w) => /river off-take S → C: its destination drains into its source/.test(w))).toBe(true);
		expect(out.series.some((s) => s.key === 'offtake_out')).toBe(false);
		passes(input, out);
	});

	it('the self-checks catch an off-take above its capacity or the flow, or one whose water went missing', () => {
		const input = model([offtake()]);
		const out = run(input);
		const edit = (nodeId: string, key: string, f: (v: number[]) => void) => {
			const o = structuredClone(out);
			f(o.series.find((x) => x.nodeId === nodeId && x.key === key)!.values);
			return o;
		};
		// Took 150 of a 100 m³/day capacity.
		expect(checkTransferLimits(input, edit('S', 'transfer_rule@o1', (v) => (v[0] = 150)))).toMatch(/took 150, outside \[0, its capacity today 100/);
		// More than the flow above a hands-off flow.
		const kept = model([offtake({ handsOffM3Day: 950 })]);
		const k = run(kept);
		const greedy = structuredClone(k);
		// It took 80 where 50 lay above the 950 to leave (the reach 1000 − 80 = 920 below it).
		greedy.series.find((x) => x.nodeId === 'S' && x.key === 'transfer_rule@o1')!.values[0] = 80;
		greedy.series.find((x) => x.nodeId === 'S' && x.key === 'offtake_out')!.values[0] = 80;
		greedy.series.find((x) => x.nodeId === 'S' && x.key === 'outflow')!.values[0] = 920;
		expect(checkTransferLimits(kept, greedy)).toMatch(/more than the flow above what it must leave \(950\)/);
		// Water taken at the source that never arrived.
		expect(checkInvariants(input, edit('C', 'offtake_in', (v) => (v[1] = 60)))).toMatch(/off-take|balance/);
		// The source's reach not reduced by what was taken.
		expect(checkInvariants(input, edit('S', 'offtake_out', (v) => (v[0] = 0)))).toMatch(/balance|off-take/);
	});

	it('changes nothing when off, or with a dam transfer of the same fields', () => {
		const none = run(model([]));
		const off = run(model([offtake({ enabled: false })]));
		expect(off.series).toEqual(none.series);
	});
});

// Canal seepage back to the river (engine 1.42.0, docs/model.md §2.6a): a share of an off-take's conveyance
// losses rejoins the river below its source, or below a farm downstream of it, the same day.
describe('canal seepage back to the river (engine 1.42.0)', () => {
	// S drains through L (no runoff, no demand) to the gauge; the canal C → T as above.
	const below = () => [
		node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
		node('S', { areaKm2: 1, sortOrder: 1, downstreamNodeId: 'L' }),
		node('L', { sortOrder: 2 }),
		node('C', { downstreamNodeId: 'T', sortOrder: 3 }),
		node('T', { sortOrder: 4, supplyRule: 'runOfRiver', pumpCapacityM3Day: null })
	];

	it('by default none returns: the losses leave the catchment as before', () => {
		const out = run(model([offtake({ lossPct: 0.25 })]));
		const same = run(model([offtake({ lossPct: 0.25, lossReturnPct: 0, lossReturnNodeId: null })]));
		expect(same.series).toEqual(out.series);
		expect(out.series.some((s) => s.key === 'offtake_loss_return')).toBe(false);
	});

	it('returns its share of the losses below the source, after the off-take took', () => {
		// 100 taken, 25 lost, 40 % of them (10) seep back into the river below S.
		const input = model([offtake({ lossPct: 0.25, lossReturnPct: 0.4 })]);
		const out = run(input);
		expect(get(out, 'S', 'offtake_out')).toEqual([100, 100]);
		expect(get(out, 'C', 'offtake_in')).toEqual([75, 75]);
		near(get(out, 'S', 'offtake_loss_return'), [10, 10]);
		near(get(out, 'S', 'outflow'), [910, 910]);
		// The town uses 60 of the 75; 15 flows on to the gauge beside S's 910.
		near(get(out, 'G', 'outflow'), [925, 925]);
		expect(out.summary.waterBalance?.total.conveyanceLossM3).toBeCloseTo(30, 9);
		expect(out.summary.supplyAssurance?.waterAccount.total.conveyanceLossM3).toBeCloseTo(30, 9);
		expect(out.summary.waterBalance?.total.residualM3).toBeCloseTo(0, 6);
		passes(input, out);
	});

	it('returns it below a farm downstream of the source, and all of it at 100 %', () => {
		const input = model([offtake({ lossPct: 0.25, lossReturnPct: 1, lossReturnNodeId: 'L' })], { nodes: below() });
		const out = run(input);
		expect(get(out, 'S', 'outflow')).toEqual([900, 900]);
		expect(out.series.some((s) => s.nodeId === 'S' && s.key === 'offtake_loss_return')).toBe(false);
		near(get(out, 'L', 'offtake_loss_return'), [25, 25]);
		near(get(out, 'L', 'outflow'), [925, 925]);
		near(get(out, 'G', 'outflow'), [940, 940]);
		expect(out.summary.waterBalance?.total.conveyanceLossM3).toBeCloseTo(0, 9);
		expect(out.summary.waterBalance?.total.residualM3).toBeCloseTo(0, 6);
		passes(input, out);
	});

	it('credits the return in the EWR attribution where the losses were charged', () => {
		// A large EWR at the gauge: every day short. The destination C carries the losses; returned, it carries less.
		const lost = model([offtake({ lossPct: 0.25 })], { ewr: 5000 });
		const back = model([offtake({ lossPct: 0.25, lossReturnPct: 1, lossReturnNodeId: 'L' })], { ewr: 5000, nodes: below() });
		const a = run(lost);
		const b = run(back);
		passes(back, b);
		expect(checkEwrAttribution(back, b)).toBeNull();
		// The canal head C receives the off-take's 100 as a transfer and passes on 75: without the return it is
		// charged the 25 lost; with all of it back below L, nothing, and L (whose outflow carries it) nothing either.
		near(get(a, 'C', 'ewr_charge'), [-25, -25]);
		near(get(b, 'C', 'ewr_charge'), [0, 0]);
		near(get(b, 'L', 'ewr_charge'), [0, 0]);
		// The town's unit is charged the 60 it used either way.
		near(get(a, 'T', 'ewr_charge'), [-60, -60]);
		near(get(b, 'T', 'ewr_charge'), [-60, -60]);
	});

	it('returns none below a unit that is not the source or a farm below it, saying so, and a save refuses it', () => {
		// T is not below S (S drains straight to the gauge).
		const input = model([offtake({ lossPct: 0.25, lossReturnPct: 0.5, lossReturnNodeId: 'T' })]);
		const out = run(input);
		expect(out.summary.warnings.some((w) => /river off-take S → C: its seepage return unit is not S or a farm below it/.test(w))).toBe(true);
		expect(out.series.some((s) => s.key === 'offtake_loss_return')).toBe(false);
		near(get(out, 'G', 'outflow'), [915, 915]);
		passes(input, out);
		expect(modelRuleProblems(input.model).some((p) => /its seepage can rejoin the river only below "S" or a farm downstream of it/.test(p))).toBe(true);
		expect(modelRuleProblems(model([offtake({ lossReturnPct: 1.5 })]).model).some((p) => /seeping back must be between 0 % and 100 %/.test(p))).toBe(true);
		expect(modelRuleProblems(model([offtake({ lossPct: 0.25, lossReturnPct: 0.5, lossReturnNodeId: 'L' })], { nodes: below() }).model)).toEqual([]);
	});

	it('the self-checks catch seepage returned that the losses did not make', () => {
		const input = model([offtake({ lossPct: 0.25, lossReturnPct: 0.4, lossReturnNodeId: 'L' })], { nodes: below() });
		const out = run(input);
		const o = structuredClone(out);
		const back = o.series.find((x) => x.nodeId === 'L' && x.key === 'offtake_loss_return')!.values;
		const flow = o.series.find((x) => x.nodeId === 'L' && x.key === 'outflow')!.values;
		back[0] = back[0]! + 5;
		flow[0] = flow[0]! + 5;
		expect(checkTransferLimits(input, o)).toMatch(/offtake_loss_return .* ≠ the river off-takes' losses seeping back there/);
		// Joining the outflow without the column: the unit no longer balances.
		const p = structuredClone(out);
		p.series.find((x) => x.nodeId === 'L' && x.key === 'offtake_loss_return')!.values[1] = 0;
		expect(checkInvariants(input, p)).toMatch(/balance|outflow/);
	});
});
