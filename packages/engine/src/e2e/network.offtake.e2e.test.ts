// End-to-end: river off-takes (docs/model.md §2.6a): capacity and demand
// sizing, conveyance losses and their seepage back to the river, the source's
// hands-off flow and EWR, topping up a dam, monthly rates, priorities, a
// canal that skips nodes and rejoins (a diamond), and the run order. Each
// worked by hand and run through the whole model. Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { DemandObject, LandCoverPatch, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';

const flat = (v: number) => new Array(12).fill(v);

function farm(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 1,
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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const gauge = (id = 'G', over: Partial<NetworkNode> = {}): NetworkNode => farm(id, { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, sortOrder: 99, ...over });

const town = (nodeId: string, m3Day: number, over: Partial<DemandObject> = {}): DemandObject => ({
	id: `town-${nodeId}`,
	nodeId,
	name: `Town at ${nodeId}`,
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
	note: '',
	...over
});

interface Build {
	nodes: NetworkNode[];
	transfers?: Transfer[];
	objects?: DemandObject[];
	landCover?: LandCoverPatch[];
	settings?: Partial<ProjectSettings>;
	start?: string;
	days: number;
}
function build(b: Build): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, ...b.settings } as ModelInput['settings'],
		model: { nodes: b.nodes, crops: [], cropAreas: [], transfers: b.transfers ?? [], demandObjects: b.objects ?? [], ...(b.landCover ? { landCover: b.landCover } : {}) },
		series: { rain_catchment_mm: { startDate: b.start ?? '2021-01-01', values: new Array(b.days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const opt = (out: { series: RunSeries[] }, nodeId: string, key: string, days: number): number[] => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values ?? new Array(days).fill(0);
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}

/**
 * Every farm's balance, every day, rebuilt from the published series alone
 * (model.md §2.7 V, §2.6a, no groundwater, no pools):
 * H + I + J + Pd + offtake in + seepage back − offtake out = (G − T) + E + ΔQ + U + seepage lost.
 */
function farmBalances(input: ModelInput, out: ModelOutput) {
	const days = out.days;
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const s = (k: string) => opt(out, n.id, k, days);
		const [H, I, J, Q, U, G, T, Pd, E, xin, xout, xret, lost] = [
			'inflow_upstream',
			'runoff',
			'transfer',
			'dam_storage',
			'outflow',
			'supplied',
			'return_flow',
			'rain_on_dam',
			'dam_evaporation',
			'offtake_in',
			'offtake_out',
			'offtake_loss_return',
			'dam_seepage_lost'
		].map(s) as [number[], number[], number[], number[], number[], number[], number[], number[], number[], number[], number[], number[], number[]];
		let q = n.damInitialPct * n.damCapacityM3;
		for (let t = 0; t < days; t++) {
			const lhs = H[t]! + I[t]! + J[t]! + Pd[t]! + xin[t]! + xret[t]! - xout[t]!;
			const rhs = G[t]! - T[t]! + E[t]! + (Q[t]! - q) + U[t]! + lost[t]!;
			expect(lhs - rhs, `${n.id} day ${t}: in ${lhs} vs out ${rhs}`).toBeCloseTo(0, 6);
			q = Q[t]!;
		}
	}
}


const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** A river off-take, sized to capacity unless said, up to `cap` m³/day. */
const ot = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: ALL,
	maxRateM3s: 1,
	dailyCapM3: cap,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'capacity',
	lossPct: 0,
	handsOffM3Day: null,
	handsOffEwr: false,
	topUpDam: false,
	...over
});
/** The source S (all the runoff) and a canal head D (no area), both draining to G. */
const sd = (tr: Transfer[], opts: { d?: Partial<NetworkNode>; objects?: DemandObject[]; days: number; start?: string; settings?: Partial<ProjectSettings> }) =>
	build({
		nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { areaKm2: 0, ...opts.d })],
		transfers: tr,
		objects: opts.objects ?? [],
		days: opts.days,
		...(opts.start ? { start: opts.start } : {}),
		...(opts.settings ? { settings: opts.settings } : {})
	});

describe('how much an off-take takes (§2.6a)', () => {
	it('sized to capacity: MIN(capacity, the flow leaving the source); the source’s reach loses exactly that', () => {
		const input = sd([ot('o', 'S', 'D', 100)], { days: 3 });
		const out = run(input, [1000, 60, 0]);
		near(get(out, 'S', 'transfer_rule@o'), [100, 60, 0]);
		near(get(out, 'S', 'offtake_out'), [100, 60, 0]);
		near(get(out, 'S', 'outflow'), [900, 0, 0]);
		near(get(out, 'D', 'offtake_in'), [100, 60, 0]);
		near(get(out, 'D', 'outflow'), [100, 60, 0]);
		near(get(out, 'G', 'outflow'), [1000, 60, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('sized to demand with conveyance losses: takes need ÷ (1 − l), delivers the need, the loss leaves the catchment', () => {
		const input = sd([ot('o', 'S', 'D', 1000, { sizing: 'demand', lossPct: 0.1 })], { objects: [town('D', 90)], days: 2 });
		const out = run(input, [1000, 50]);
		near(get(out, 'S', 'transfer_rule@o'), [100, 50]);
		near(get(out, 'D', 'offtake_in'), [90, 45]);
		near(get(out, 'D', 'offtake_used'), [90, 45]);
		near(get(out, 'D', 'supplied'), [90, 45]);
		near(get(out, 'D', 'outflow'), [0, 0]);
		near(get(out, 'G', 'outflow'), [900, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a destination whose dam is at dead storage is still served by the off-take', () => {
		const input = sd([ot('o', 'S', 'D', 1000, { sizing: 'demand' })], { d: { damCapacityM3: 1000, damInitialPct: 0.5, damMinPct: 0.5 }, objects: [town('D', 80)], days: 2 });
		const out = run(input, [500, 500]);
		near(get(out, 'D', 'offtake_used'), [80, 80]);
		near(get(out, 'D', 'supplied'), [80, 80]);
		near(get(out, 'D', 'dam_storage'), [500, 500]);
		passes(input, out);
	});

	it('the source’s hands-off flow: nothing until the river carries more, binding exactly at it', () => {
		const input = sd([ot('o', 'S', 'D', 100, { handsOffM3Day: 950 })], { days: 4 });
		const out = run(input, [1000, 950, 2000, 949]);
		near(get(out, 'S', 'transfer_rule@o'), [50, 0, 100, 0]);
		near(get(out, 'S', 'outflow'), [950, 950, 1900, 949]);
		passes(input, out);
	});

	it('handsOffEwr keeps the EWR at the source (its Z)', () => {
		const input = sd([ot('o', 'S', 'D', 1000, { handsOffEwr: true })], { days: 3, settings: { ewrPragmaticM3PerDay: flat(600) as unknown as Monthly } });
		const out = run(input, [650, 500, 2000]);
		near(get(out, 'S', 'transfer_rule@o'), [50, 0, 1000]);
		near(get(out, 'S', 'outflow'), [600, 500, 1000]);
		passes(input, out);
	});

	it('monthly rates switch on 1 October', () => {
		const rates = flat(0);
		rates[0] = 0.002;
		rates[11] = 0.001;
		const input = sd([ot('o', 'S', 'D', 0, { dailyCapM3: null, monthlyRateM3s: rates, months: [9, 10], maxRateM3s: 0.002 })], { days: 4, start: '2021-09-29' });
		const out = run(input, [1000, 1000, 1000, 1000]);
		near(get(out, 'S', 'transfer_rule@o'), [86.4, 86.4, 172.8, 172.8]);
		passes(input, out);
	});
});

describe('topping up a dam (§2.6a)', () => {
	it('sized to demand with topUpDam: the dam’s room, up to capacity, into the dam', () => {
		const input = sd([ot('o', 'S', 'D', 600, { sizing: 'demand', topUpDam: true })], { d: { damCapacityM3: 1000 }, days: 3 });
		const out = run(input, [5000, 5000, 5000]);
		near(get(out, 'S', 'transfer_rule@o'), [600, 400, 0]);
		near(get(out, 'D', 'offtake_to_dam'), [600, 400, 0]);
		near(get(out, 'D', 'dam_storage'), [600, 1000, 1000]);
		near(get(out, 'D', 'spill'), [0, 0, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('sized to capacity with topUpDam: the rest after the demand into the dam, spilling what doesn’t fit', () => {
		const input = sd([ot('o', 'S', 'D', 600, { topUpDam: true })], { d: { damCapacityM3: 1000, damInitialPct: 0.5 }, objects: [town('D', 100)], days: 2 });
		const out = run(input, [5000, 5000]);
		// Day 1: 600 arrive, 100 used, 500 into the dam: full. Day 2: 100 used, 500 in, 500 spill.
		near(get(out, 'D', 'offtake_used'), [100, 100]);
		near(get(out, 'D', 'offtake_to_dam'), [500, 500]);
		near(get(out, 'D', 'dam_storage'), [1000, 1000]);
		near(get(out, 'D', 'spill'), [0, 500]);
		farmBalances(input, out);
		passes(input, out);
	});
});

describe('seepage back to the river (§2.6a, engine ≥ 1.42.0)', () => {
	it('returns v × l × r below the source by default', () => {
		const input = sd([ot('o', 'S', 'D', 100, { lossPct: 0.5, lossReturnPct: 0.4 })], { days: 1 });
		const out = run(input, [1000]);
		near(get(out, 'D', 'offtake_in'), [50]);
		near(get(out, 'S', 'offtake_loss_return'), [20]);
		near(get(out, 'S', 'outflow'), [920]);
		near(get(out, 'G', 'outflow'), [970]);
		// Lost from the catchment: 100 × 0.5 × (1 − 0.4) = 30.
		expect(out.summary.waterBalance!.total.conveyanceLossM3).toBeCloseTo(30, 9);
		expect(out.summary.waterBalance!.total.residualM3).toBeCloseTo(0, 6);
		farmBalances(input, out);
		passes(input, out);
	});

	it('returns at a farm downstream of the source, the same day', () => {
		// S → R → G; the canal runs to D → G.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, downstreamNodeId: 'R' }), farm('R', { areaKm2: 0 }), farm('D', { areaKm2: 0 })],
			transfers: [ot('o', 'S', 'D', 100, { lossPct: 0.5, lossReturnPct: 0.4, lossReturnNodeId: 'R' })],
			days: 2
		});
		const out = run(input, [1000, 40]);
		near(get(out, 'S', 'outflow'), [900, 0]);
		near(get(out, 'R', 'offtake_loss_return'), [20, 8]);
		near(get(out, 'R', 'outflow'), [920, 8]);
		near(get(out, 'G', 'outflow'), [970, 28]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a return unit that isn’t below the source returns nothing, with a warning', () => {
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('X', { areaKm2: 0 }), farm('D', { areaKm2: 0 })],
			transfers: [ot('o', 'S', 'D', 100, { lossPct: 0.5, lossReturnPct: 1, lossReturnNodeId: 'X' })],
			days: 1
		});
		const out = run(input, [1000]);
		expect(out.summary.warnings.some((w) => /seepage return unit/.test(w))).toBe(true);
		near(get(out, 'G', 'outflow'), [950]);
		passes(input, out);
	});
});

describe('the network around an off-take', () => {
	it('a canal that skips two units and rejoins at the outlet: the outlet gets everything back (a diamond)', () => {
		// S → M1 → M2 → G by river; S → D → G by canal.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 2, downstreamNodeId: 'M1' }), farm('M1', { areaKm2: 1, downstreamNodeId: 'M2' }), farm('M2', { areaKm2: 1 }), farm('D', { areaKm2: 0 })],
			transfers: [ot('o', 'S', 'D', 300)],
			days: 2
		});
		const out = run(input, [1000, 400]);
		// S makes 500 / 200: 300 / 200 down the canal, 200 / 0 down the river.
		near(get(out, 'M1', 'inflow_upstream'), [200, 0]);
		near(get(out, 'M2', 'outflow'), [700, 200]);
		near(get(out, 'D', 'outflow'), [300, 200]);
		near(get(out, 'G', 'outflow'), [1000, 400]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a canal to a unit downstream on the same river: the unit gets the canal and what the river leaves', () => {
		const input = build({ nodes: [gauge(), farm('S', { areaKm2: 1, downstreamNodeId: 'D' }), farm('D', { areaKm2: 0 })], transfers: [ot('o', 'S', 'D', 300)], objects: [town('D', 350)], days: 1 });
		const out = run(input, [1000]);
		near(get(out, 'D', 'inflow_upstream'), [700]);
		near(get(out, 'D', 'offtake_in'), [300]);
		near(get(out, 'D', 'supplied'), [300]);
		passes(input, out);
	});

	it('canal to canal: off-take water passing the first head is taken on by an off-take there', () => {
		// S → G by river; S ⇒ D1 (300), D1 ⇒ D2 (200), all canal heads draining to G.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D1', { areaKm2: 0 }), farm('D2', { areaKm2: 0 })],
			transfers: [ot('o1', 'S', 'D1', 300), ot('o2', 'D1', 'D2', 200, { lossPct: 0.25 })],
			days: 1
		});
		const out = run(input, [1000]);
		near(get(out, 'D1', 'offtake_in'), [300]);
		near(get(out, 'D1', 'transfer_rule@o2'), [200]);
		near(get(out, 'D1', 'outflow'), [100]);
		near(get(out, 'D2', 'offtake_in'), [150]);
		near(get(out, 'G', 'outflow'), [950]);
		const wb = out.summary.waterBalance!.total;
		expect(wb.conveyanceLossM3).toBeCloseTo(50, 9);
		expect(wb.residualM3).toBeCloseTo(0, 6);
		farmBalances(input, out);
		passes(input, out);
	});

	it('two off-takes in a loop (S ⇒ D and D ⇒ S): the one that would need tomorrow’s water is skipped', () => {
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { areaKm2: 1 })],
			transfers: [ot('a', 'S', 'D', 100), ot('b', 'D', 'S', 100)],
			days: 1
		});
		const out = run(input, [1000]);
		expect(out.summary.warnings.some((w) => /Unit D → Unit S: its destination drains into its source/.test(w))).toBe(true);
		near(get(out, 'S', 'transfer_rule@a'), [100]);
		near(get(out, 'D', 'outflow'), [600]);
		passes(input, out);
	});

	it('an off-take whose destination drains into its source is skipped with a warning', () => {
		const input = build({ nodes: [gauge(), farm('D', { areaKm2: 0, downstreamNodeId: 'S' }), farm('S', { areaKm2: 1 })], transfers: [ot('o', 'S', 'D', 300)], days: 1 });
		const out = run(input, [1000]);
		expect(out.summary.warnings.some((w) => /drains into its source/.test(w))).toBe(true);
		near(get(out, 'G', 'outflow'), [1000]);
		expect(out.series.some((s) => s.key === 'offtake_out')).toBe(false);
	});

	it('rules at one source by priority, lowest first; equal priorities share pro rata to their limits', () => {
		const three = (p1: number) =>
			build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D1', { areaKm2: 0 }), farm('D2', { areaKm2: 0 })], transfers: [ot('a', 'S', 'D1', 300, { priority: 0 }), ot('b', 'S', 'D2', 100, { priority: p1 })], days: 2 });
		const byPriority = run(three(1), [400, 200]);
		near(get(byPriority, 'S', 'transfer_rule@a'), [300, 200]);
		near(get(byPriority, 'S', 'transfer_rule@b'), [100, 0]);
		const shared = run(three(0), [400, 200]);
		// Day 2: capacities 300 and 100 share the 200 in proportion, 3 : 1: 150 and 50 (engine ≥ 1.70.0, issue #90
		// Q25; before, each asked MIN(cap, free 200), 200 and 100: 133.3 and 66.7).
		near(get(shared, 'S', 'transfer_rule@a'), [300, 150]);
		near(get(shared, 'S', 'transfer_rule@b'), [100, 50]);
		passes(three(0), shared);
	});

	it('demand-sized rules into one unit split its need pro rata to their capacity, fixed before the day runs', () => {
		// D needs 200; capacities 300 and 100 → 150 and 50, whatever each source has. S2 is dry: its 50 is not made up.
		const input = build({
			nodes: [gauge(), farm('S1', { areaKm2: 1 }), farm('S2', { areaKm2: 0 }), farm('D', { areaKm2: 0 })],
			transfers: [ot('a', 'S1', 'D', 300, { sizing: 'demand' }), ot('b', 'S2', 'D', 100, { sizing: 'demand' })],
			objects: [town('D', 200)],
			days: 1
		});
		const out = run(input, [1000]);
		near(get(out, 'S1', 'transfer_rule@a'), [150]);
		near(get(out, 'S2', 'transfer_rule@b'), [0]);
		near(get(out, 'D', 'supplied'), [150]);
		passes(input, out);
	});
});
