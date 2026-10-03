// End-to-end: the river off-take decisions of engine 1.70.0 (issue #393, the
// provisional answers to issue #90 Q25, Q26 and Q27; docs/model.md §2.6a,
// §2.7e). Each case is a small invented catchment worked by hand from the
// docs, never from what the engine returned before.
//
// - Q25: rules of one priority still share a short river pro rata to what
//   each can take (no method change), and a run warns about rules that look
//   like one licence split up (same source, same destination, same priority,
//   a month in common), since splitting raises the licence's share.
// - Q26: a demand-sized off-take topping up a dam counts the dam's fixed
//   release floor in its room, as a dam rule's room does (§2.6, engine ≥
//   1.29.0); the dam's own inflow that day is still left out.
// - Q27: an off-take's keep includes its source's pass-inflow release target,
//   as the unit's own river pump does (§2.7e).
//
// Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { Rng } from '../random';
import { runModelWith, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';

const flat = (v: number) => new Array(12).fill(v) as number[];
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function farm(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
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
const gauge = (): NetworkNode => farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 });
const seniorUser = (id: string, down: string, m3Day: number): NetworkNode =>
	farm(id, { kind: 'user', downstreamNodeId: down, damAreaFullM2: null, userDemandM3Day: flat(m3Day), userReturnPct: 0, userPriority: 'senior' });
const town = (nodeId: string, m3Day: number): DemandObject => ({
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
	note: ''
});
/** A river off-take sized to capacity unless said, up to `cap` m³/day, every month. */
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

interface Build {
	nodes: NetworkNode[];
	transfers: Transfer[];
	objects?: DemandObject[];
	/** The outlet's pragmatic EWR, m³/day, every month; fragmented to the units by their share (§2.5). */
	ewr?: number;
	settings?: Partial<ProjectSettings>;
	days?: number;
}
function build(b: Build): ModelInput {
	const days = b.days ?? 1;
	return {
		settings: { ewrPragmaticM3PerDay: flat(b.ewr ?? 0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, ...b.settings } as ModelInput['settings'],
		model: { nodes: b.nodes, crops: [], cropAreas: [], transfers: b.transfers, demandObjects: b.objects ?? [] },
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const opt = (out: { series: RunSeries[] }, nodeId: string, key: string): number[] => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values ?? [];
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
/** Mass balance and every self-check (the off-take limits, the workings, the attribution), and no negative flow anywhere. */
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	for (const s of out.series) if (['outflow', 'spill', 'dam_storage', 'dam_release', 'offtake_out', 'offtake_in'].includes(s.key) || s.key.startsWith('transfer_rule@')) s.values.forEach((v, t) => expect(v, `${s.nodeId}/${s.key} day ${t}`).toBeGreaterThanOrEqual(0));
}
const splitWarnings = (out: ModelOutput) => out.summary.warnings.filter((w) => /one licence split up/.test(w));

// ── Q25: same-priority rules share a short river pro rata to what each can take ─────────────────────────────

describe('Q25 (§2.6a): rules of one priority share a short river pro rata to their limits, and a split licence gains', () => {
	// One source S with all the runoff; three destinations with no demand (capacity sizing).
	const net = (transfers: Transfer[]) => build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D1'), farm('D2'), farm('D3')], transfers });

	it('one band (every keep 0): licence A of 300 beside B of 100 on 200 m³ gets 133.3; split into two rules of 150 it gets 150', () => {
		// Limits MIN(cap, free): A 200, B 100 → 300 asked of 200: A 200 × 200/300 = 133.33, B 66.67.
		const one = net([ot('a', 'S', 'D1', 300), ot('b', 'S', 'D2', 100)]);
		const o1 = run(one, [200]);
		near(get(o1, 'S', 'transfer_rule@a'), [400 / 3]);
		near(get(o1, 'S', 'transfer_rule@b'), [200 / 3]);
		passes(one, o1);
		// Split: limits 150, 150, 100 → 400 asked of 200: a1 75, a2 75 (A = 150), B 50. The licence gains 16.67, B loses it.
		const two = net([ot('a1', 'S', 'D1', 150), ot('a2', 'S', 'D1', 150), ot('b', 'S', 'D2', 100)]);
		const o2 = run(two, [200]);
		near(get(o2, 'S', 'transfer_rule@a1'), [75]);
		near(get(o2, 'S', 'transfer_rule@a2'), [75]);
		near(get(o2, 'S', 'transfer_rule@b'), [50]);
		near(get(o2, 'D1', 'offtake_in'), [150]);
		passes(two, o2);
		// The river below S is 0 either way: the total taken is the same, only the shares move.
		near(get(o1, 'S', 'outflow'), [0]);
		near(get(o2, 'S', 'outflow'), [0]);
	});

	it('with plenty of water splitting changes nothing: every rule takes its capacity', () => {
		const two = net([ot('a1', 'S', 'D1', 150), ot('a2', 'S', 'D1', 150), ot('b', 'S', 'D2', 100)]);
		const out = run(two, [1000]);
		near(get(out, 'S', 'transfer_rule@a1'), [150]);
		near(get(out, 'S', 'transfer_rule@a2'), [150]);
		near(get(out, 'S', 'transfer_rule@b'), [100]);
		near(get(out, 'S', 'outflow'), [600]);
		passes(two, out);
	});

	it('banded keeps: licence A of 600 keeping 600 beside C of 400 keeping 0, on 1 000 m³: A 200, C 400; split 300 + 300, A gets 240', () => {
		// One rule: limits A MIN(600, 1 000 − 600) = 400, C MIN(400, 1 000) = 400. Band 1 000–600 (400) shared by
		// both (A keeps 600, C 0 ≤ 600): 400 asked each → 200 : 200. Band 600–0 to C alone: 200 more (its 400). A 200, C 400.
		const one = net([ot('a', 'S', 'D1', 600, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 400)]);
		const o1 = run(one, [1000]);
		near(get(o1, 'S', 'transfer_rule@a'), [200]);
		near(get(o1, 'S', 'transfer_rule@c'), [400]);
		near(get(o1, 'S', 'outflow'), [400]);
		passes(one, o1);
		// Split: a1, a2 limits MIN(300, 400) = 300 each, C 400: the top band's 400 shared 300 : 300 : 400 → 120, 120,
		// 160; C's other 240 from the band below. A = 240, C = 400, and the river below S ends at 360, not 400:
		// the split licence's gain (40) comes out of the flow C's band would have left, not out of C.
		const two = net([ot('a1', 'S', 'D1', 300, { handsOffM3Day: 600 }), ot('a2', 'S', 'D1', 300, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 400)]);
		const o2 = run(two, [1000]);
		near(get(o2, 'S', 'transfer_rule@a1'), [120]);
		near(get(o2, 'S', 'transfer_rule@a2'), [120]);
		near(get(o2, 'S', 'transfer_rule@c'), [400]);
		near(get(o2, 'S', 'outflow'), [360]);
		// A's rules never take the river below their keep: A takes from the band above 600 only (1 000 − 240 − 160 = 600).
		expect(1000 - 240 - 160).toBeGreaterThanOrEqual(600);
		passes(two, o2);
		expect(splitWarnings(o2)).toHaveLength(1);
	});

	it('warns once for two rules of one priority from one source to one unit, naming them, and the run still shares as documented', () => {
		const out = run(net([ot('a2', 'S', 'D1', 150), ot('a1', 'S', 'D1', 150), ot('b', 'S', 'D2', 100)]), [200]);
		expect(splitWarnings(out)).toEqual([
			'river off-take Unit S → Unit D1: 2 rules of priority 0 (a1, a2) take from the same river for the same unit. If they are one licence split up, enter it as one rule: rules of one priority share a short river pro rata to what each can take, so a licence split into several rules gets a larger share than the same licence as one rule'
		]);
	});

	it('three rules of one group: one warning naming all three; a second group at another priority warns on its own', () => {
		const out = run(
			net([ot('a1', 'S', 'D1', 50), ot('a2', 'S', 'D1', 50), ot('a3', 'S', 'D1', 50), ot('p1', 'S', 'D2', 50, { priority: 1 }), ot('p2', 'S', 'D2', 50, { priority: 1 })]),
			[100]
		);
		const w = splitWarnings(out);
		expect(w).toHaveLength(2);
		expect(w[0]).toMatch(/Unit S → Unit D1: 3 rules of priority 0 \(a1, a2, a3\)/);
		expect(w[1]).toMatch(/Unit S → Unit D2: 2 rules of priority 1 \(p1, p2\)/);
	});

	it('no warning for different priorities, different destinations, different sources, a single rule, or a disabled twin', () => {
		const cases: Transfer[][] = [
			[ot('a1', 'S', 'D1', 150), ot('a2', 'S', 'D1', 150, { priority: 1 })],
			[ot('a1', 'S', 'D1', 150), ot('a2', 'S', 'D2', 150)],
			[ot('a1', 'S', 'D1', 150), ot('a2', 'D3', 'D1', 150)],
			[ot('a1', 'S', 'D1', 300)],
			[ot('a1', 'S', 'D1', 150), ot('a2', 'S', 'D1', 150, { enabled: false })]
		];
		for (const transfers of cases) expect(splitWarnings(run(net(transfers), [200])), JSON.stringify(transfers.map((t) => t.id))).toEqual([]);
	});

	it('no warning for twins that never run in the same month (one in summer, one in winter); a third sharing a month brings it back', () => {
		const summer = { months: [10, 11, 12, 1, 2, 3] };
		const winter = { months: [4, 5, 6, 7, 8, 9] };
		expect(splitWarnings(run(net([ot('a1', 'S', 'D1', 150, summer), ot('a2', 'S', 'D1', 150, winter)]), [200]))).toEqual([]);
		// a3 runs in March with a1: those two warn, a2 (winter only) meets neither.
		const w = splitWarnings(run(net([ot('a1', 'S', 'D1', 150, summer), ot('a2', 'S', 'D1', 150, winter), ot('a3', 'S', 'D1', 150, { months: [3] })]), [200]));
		expect(w).toHaveLength(1);
		expect(w[0]).toMatch(/2 rules of priority 0 \(a1, a3\)/);
	});

	it('no warning for a dam rule beside a river off-take between the same units (only river off-takes share a river)', () => {
		const out = run(
			build({
				nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 1 }), farm('D1', { damCapacityM3: 1000 })],
				transfers: [ot('a1', 'S', 'D1', 150), { ...ot('a2', 'S', 'D1', 150), source: 'dam' }]
			}),
			[200]
		);
		expect(splitWarnings(out)).toEqual([]);
	});
});

// ── Q26: a top-up's room counts the destination dam's fixed release floor ───────────────────────────────────

describe('Q26 (§2.6a): a demand-sized top-up counts the dam’s fixed release floor, as a dam rule’s room does', () => {
	// S has 10 000 m³/day; D has a 1 000 m³ dam, no demand, no runoff of its own (area 0): the day has no inflow
	// to the dam, so all it receives is the off-take's water. No rain, evaporation or seepage (A-pan 0, area 0).
	// room = cap − held; floor = MIN(amount, outlet, held − dead), never below 0; need = room + floor.
	const net = (dam: Partial<NetworkNode>, transfers: Transfer[] = [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true })], extra: NetworkNode[] = [], days = 1) =>
		build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: 1000, ...dam }), ...extra], transfers, days });
	const fixed = (m3Day: number, over: Partial<NetworkNode> = {}): Partial<NetworkNode> => ({ damReleaseRule: 'fixed', damReleaseM3Day: flat(m3Day), ...over });

	it('a release (300) larger than the room (100): the off-take brings 400, the dam releases 300 and ends full, nothing spills', () => {
		// held 900, room 100, floor MIN(300, 900 − 0) = 300 → 400. Before 1.70.0 it brought 100 and the dam ended at 700.
		const input = net({ damInitialPct: 0.9, ...fixed(300) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [400]);
		near(get(out, 'D', 'offtake_to_dam'), [400]);
		near(get(out, 'D', 'dam_release'), [300]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		// What leaves D is the release alone: 300.
		near(get(out, 'D', 'outflow'), [300]);
		passes(input, out);
	});

	it('a release (50) smaller than the room (100): the off-take brings 150 and the dam ends full', () => {
		const input = net({ damInitialPct: 0.9, ...fixed(50) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [150]);
		near(get(out, 'D', 'dam_release'), [50]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
	});

	it('a full dam (zero room): the off-take brings exactly the release (300), which leaves again; without a release it brings nothing', () => {
		const withRel = net({ damInitialPct: 1, ...fixed(300) });
		const o1 = run(withRel, [10_000]);
		near(get(o1, 'S', 'transfer_rule@o'), [300]);
		near(get(o1, 'D', 'dam_release'), [300]);
		near(get(o1, 'D', 'dam_storage'), [1000]);
		near(get(o1, 'D', 'spill'), [0]);
		passes(withRel, o1);
		const without = net({ damInitialPct: 1 });
		const o2 = run(without, [10_000]);
		near(get(o2, 'S', 'transfer_rule@o'), [0]);
		near(get(o2, 'D', 'spill'), [0]);
		near(get(o2, 'D', 'dam_storage'), [1000]);
		passes(without, o2);
	});

	it('the outlet caps the floor: release 300 through a 120 m³/day outlet on a full dam brings 120', () => {
		const input = net({ damInitialPct: 1, ...fixed(300, { damOutletCapacityM3Day: 120 }) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [120]);
		near(get(out, 'D', 'dam_release'), [120]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
	});

	it('a dam near its dead storage: the floor is cut to the water above it, so the dam ends below full but never spills (the floor is a lower bound)', () => {
		// held 500, dead 40 % = 400: floor MIN(300, 500 − 400) = 100, room 500 → 600. The day's release then sees
		// 500 + 600 = 1 100, 700 above dead storage, so it releases its full 300 and the dam ends at 800, not 1 000:
		// counting only the floor never overfills, at the cost of a dam that fills over two days rather than one.
		const input = net({ damInitialPct: 0.5, damMinPct: 0.4, ...fixed(300) }, undefined, [], 2);
		const out = run(input, [10_000, 10_000]);
		// Day 2: held 800, floor MIN(300, 800 − 400) = 300, room 200 → 500; 800 + 500 − 300 = 1 000.
		near(get(out, 'S', 'transfer_rule@o'), [600, 500]);
		near(get(out, 'D', 'dam_release'), [300, 300]);
		near(get(out, 'D', 'dam_storage'), [800, 1000]);
		near(get(out, 'D', 'spill'), [0, 0]);
		passes(input, out);
	});

	it('a pass-inflow release adds nothing to the room (it is at most the day’s inflow, which the room leaves out)', () => {
		const input = net({ damInitialPct: 0.9, damReleaseRule: 'passInflow', damReleaseM3Day: flat(300) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [100]);
		// No inflow to the dam today, so nothing to pass.
		near(get(out, 'D', 'dam_release'), [0]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		passes(input, out);
	});

	it('with a dam rule’s receipts: 900 m³ in a 1 000 m³ dam, 250 by a dam rule, release 300: the off-take brings 150', () => {
		// The dam rule settles first: D receives 250 (its room, §2.6: 1 000 − 900 + the floor 300 = 400 ≥ 250). Then
		// the top-up: held 900 + 250 = 1 150, floor MIN(300, 1 150 − 0) = 300, need = MAX(0, 1 000 − 1 150 + 300) = 150.
		// The day: 1 150 + 150 − 300 = 1 000, full, no spill. (Before 1.70.0 the off-take brought 0, the dam ended at 850.)
		const input = net({ damInitialPct: 0.9, ...fixed(300) }, [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true }), { ...ot('t', 'S2', 'D', 250), source: 'dam' }], [
			farm('S2', { damCapacityM3: 5000, damInitialPct: 1 })
		]);
		const out = run(input, [10_000]);
		near(get(out, 'S2', 'transfer_rule@t'), [250]);
		near(get(out, 'S', 'transfer_rule@o'), [150]);
		near(get(out, 'D', 'dam_release'), [300]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
	});

	it('with a demand at the destination (200): the off-take brings demand + room + floor, the demand met first', () => {
		// need = 200 + 100 + 300 = 600: 200 used, 400 into the dam, which releases 300 and ends full.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: 1000, damInitialPct: 0.9, ...fixed(300) })],
			transfers: [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true })],
			objects: [town('D', 200)]
		});
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [600]);
		near(get(out, 'D', 'offtake_used'), [200]);
		near(get(out, 'D', 'offtake_to_dam'), [400]);
		near(get(out, 'D', 'supplied'), [200]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
	});

	it('a dam not yet in service (no dam today) has no room and no release: the off-take brings only the demand', () => {
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: 1000, damInitialPct: 0.9, damInServiceFrom: '2021-06-01', ...fixed(300) })],
			transfers: [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true })],
			objects: [town('D', 200)]
		});
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [200]);
		near(get(out, 'D', 'dam_release'), [0]);
		passes(input, out);
	});

	it('the dam’s own inflow is left out: with 1 000 m³ of runoff into a dam at 900 and a release of 300, the off-take still brings 400 and the inflow spills', () => {
		// D's runoff goes into its dam (pctRunoffToDam 100 %): the step holds 900 + 1 000 + 400 = 2 300, releases 300 and
		// spills 1 000, the inflow exactly. That inflow is known only once the network runs, after the off-takes are
		// sized, so the off-take brought room + floor as documented (§2.6a: the room leaves the day's inflow out).
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { areaKm2: 1, pctRunoffToDam: 1, damCapacityM3: 1000, damInitialPct: 0.9, ...fixed(300) })],
			transfers: [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true })]
		});
		const out = run(input, [2000]);
		// Area shares: S and D each 1 km² → 1 000 m³ each.
		near(get(out, 'S', 'transfer_rule@o'), [400]);
		near(get(out, 'D', 'dam_release'), [300]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [1000]);
		passes(input, out);
	});

	it('swept by hand: on days with no inflow the off-take brings room + floor and nothing ever spills from it', () => {
		const g = new Rng(26);
		for (let k = 0; k < 200; k++) {
			const cap = g.float(100, 5000);
			const init = g.frac();
			const dead = g.pick([0, g.frac()]);
			const amount = g.pick([0, g.float(0, 2000)]);
			const outlet = g.pick([null, g.float(0, 1500)]);
			const demand = g.pick([0, g.float(0, 1000)]);
			const input = build({
				nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: cap, damInitialPct: init, damMinPct: dead, ...fixed(amount, { damOutletCapacityM3Day: outlet }) })],
				transfers: [ot('o', 'S', 'D', 1e7, { sizing: 'demand', topUpDam: true })],
				objects: demand > 0 ? [town('D', demand)] : []
			});
			const out = run(input, [1e7]);
			const held = init * cap;
			const floor = Math.max(0, Math.min(amount, outlet ?? Infinity, held - dead * cap));
			const want = demand + (cap - held) + floor;
			const where = `case ${k}: cap ${cap}, held ${held}, dead ${dead * cap}, release ${amount}, outlet ${outlet}, demand ${demand}`;
			expect(get(out, 'S', 'transfer_rule@o')[0], where).toBeCloseTo(want, 6);
			expect(get(out, 'D', 'spill')[0], where).toBeCloseTo(0, 6);
			expect(get(out, 'D', 'dam_storage')[0], where).toBeLessThanOrEqual(cap * (1 + 1e-12));
			passes(input, out);
		}
	});
});

// ── Q27: an off-take's keep includes the source's pass-inflow release target ────────────────────────────────

describe('Q27 (§2.6a, §2.7e): an off-take leaves its source’s pass-inflow release target in the river, as the unit’s pump does', () => {
	// S has a 1 000 m³ dam off the river (nothing flows into it) with a pass-inflow release, and 1 000 m³/day of
	// runoff below the dam. One capacity-sized off-take of 2 000 to D: v = MIN(2 000, MAX(0, 1 000 − keep)),
	// keep = MAX(Zs, target, hands-off, [handsOffEwr] Z). Before 1.70.0 the target was not in the keep.
	const net = (target: number[] | null, rule: Partial<Transfer> = {}, b: Partial<Build> = {}, src: Partial<NetworkNode> = {}) =>
		build({
			nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 1, damReleaseRule: 'passInflow', damReleaseM3Day: target, ...src }), farm('D'), ...(b.nodes ?? [])],
			transfers: [ot('o', 'S', 'D', 2000, rule)],
			...(b.ewr !== undefined ? { ewr: b.ewr } : {}),
			...(b.objects ? { objects: b.objects } : {})
		});

	it('a target (600) above the hands-off flow (300): the off-take takes 400 and 600 stays below S', () => {
		const input = net(flat(600), { handsOffM3Day: 300 });
		const out = run(input, [1000]);
		near(get(out, 'S', 'transfer_rule@o'), [400]);
		near(get(out, 'S', 'outflow'), [600]);
		passes(input, out);
	});

	it('a target (200) below the hands-off flow (300): the hands-off flow binds, 700 taken', () => {
		const input = net(flat(200), { handsOffM3Day: 300 });
		const out = run(input, [1000]);
		near(get(out, 'S', 'transfer_rule@o'), [700]);
		near(get(out, 'S', 'outflow'), [300]);
		passes(input, out);
	});

	it('a release targeting the EWR (no amounts): the EWR (500) is kept though the rule does not ask for it', () => {
		// The outlet EWR 500, all of it fragmented to S (the only unit with area): Z = 500 at S.
		const input = net(null, {}, { ewr: 500 });
		const out = run(input, [1000]);
		near(get(out, 'S', 'ewr_cumulative'), [500]);
		near(get(out, 'S', 'transfer_rule@o'), [500]);
		near(get(out, 'S', 'outflow'), [500]);
		passes(input, out);
	});

	it('the rule’s own EWR keep (800) above the target (600): 200 taken; the target (600) above the EWR (400) kept: 400 taken', () => {
		const a = net(flat(600), { handsOffEwr: true }, { ewr: 800 });
		const oa = run(a, [1000]);
		near(get(oa, 'S', 'transfer_rule@o'), [200]);
		passes(a, oa);
		const b = net(flat(600), { handsOffEwr: true }, { ewr: 400 });
		const ob = run(b, [1000]);
		near(get(ob, 'S', 'transfer_rule@o'), [400]);
		passes(b, ob);
	});

	it('senior users below S: their requirement (700) above the target (600) binds; a target of 900 above them binds', () => {
		// The senior user U sits between S and the gauge and asks 700, so Zs = 700 at S.
		const withSenior = (target: number) =>
			build({
				nodes: [gauge(), seniorUser('U', 'G', 700), farm('S', { areaKm2: 1, downstreamNodeId: 'U', damCapacityM3: 1000, damInitialPct: 1, damReleaseRule: 'passInflow', damReleaseM3Day: flat(target) }), farm('D')],
				transfers: [ot('o', 'S', 'D', 2000)]
			});
		const a = withSenior(600);
		const oa = run(a, [1000]);
		near(get(oa, 'S', 'senior_requirement'), [700]);
		near(get(oa, 'S', 'transfer_rule@o'), [300]);
		passes(a, oa);
		const b = withSenior(900);
		const ob = run(b, [1000]);
		near(get(ob, 'S', 'transfer_rule@o'), [100]);
		near(get(ob, 'S', 'outflow'), [900]);
		passes(b, ob);
	});

	it('a target above the flow (1 500 on 1 000): the off-take takes nothing and the whole flow passes', () => {
		const input = net(flat(1500));
		const out = run(input, [1000]);
		near(get(out, 'S', 'transfer_rule@o'), [0]);
		near(get(out, 'D', 'offtake_in'), [0]);
		near(get(out, 'S', 'outflow'), [1000]);
		passes(input, out);
	});

	it('the target is the month’s: 600 in January, 0 in February (1 000 a day either side of 1 February)', () => {
		// damReleaseM3Day runs October → September: January is index 3, February 4.
		const target = flat(0);
		target[3] = 600;
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 1, damReleaseRule: 'passInflow', damReleaseM3Day: target }), farm('D')],
			transfers: [ot('o', 'S', 'D', 2000)],
			days: 32
		});
		const out = run(input, new Array(32).fill(1000));
		expect(get(out, 'S', 'transfer_rule@o')[30]).toBeCloseTo(400, 9);
		expect(get(out, 'S', 'transfer_rule@o')[31]).toBeCloseTo(1000, 9);
		passes(input, out);
	});

	it('a fixed release has no target: the off-take takes the flow above its own keep', () => {
		const input = net(flat(600), {}, {}, { damReleaseRule: 'fixed' });
		const out = run(input, [1000]);
		// The fixed release (600 a day from a full dam) joins the flow below the dam: U₀ = 1 000 + 600; keep 0.
		near(get(out, 'S', 'dam_release'), [600]);
		near(get(out, 'S', 'transfer_rule@o'), [1600]);
		passes(input, out);
	});

	it('a dam not yet in service has no release, so no target: the off-take takes it all', () => {
		const input = net(flat(600), {}, {}, { damInServiceFrom: '2021-06-01' });
		const out = run(input, [1000]);
		near(get(out, 'S', 'transfer_rule@o'), [1000]);
		passes(input, out);
	});

	it('the unit’s own river pump and its off-take keep the same target: pump 300 of the 1 000, the off-take 100, 600 passes', () => {
		// riverFirst with a 300 m³/day pump and a 300 m³/day town: the pump takes MIN(300, 1 000 − 600) = 300; the
		// flow leaving S is 700, and the off-take takes 700 − 600 = 100.
		const input = net(flat(600), {}, { objects: [town('S', 300)] }, { supplyRule: 'riverFirst', pumpCapacityM3Day: 300 });
		const out = run(input, [1000]);
		near(get(out, 'S', 'river_abstraction'), [300]);
		near(get(out, 'S', 'transfer_rule@o'), [100]);
		near(get(out, 'S', 'outflow'), [600]);
		passes(input, out);
	});

	it('banded with a sibling of the same priority keeping more: target 400, sibling keeps 700, on 1 000: the band 1 000–700 shared, the rest above 400 to o', () => {
		// keeps: o MAX(400, 0) = 400, s MAX(400, 700) = 700. Limits 2 000 → MIN(2 000, 600) = 600 and MIN(2 000, 300) = 300.
		// Band 1 000–700 (300) shared 600 : 300 → o 200, s 100. Band 700–400 (300) to o alone: o 500 in all, s 100; 400 passes.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 1, damReleaseRule: 'passInflow', damReleaseM3Day: flat(400) }), farm('D'), farm('D2')],
			transfers: [ot('o', 'S', 'D', 2000), ot('s', 'S', 'D2', 2000, { handsOffM3Day: 700 })]
		});
		const out = run(input, [1000]);
		near(get(out, 'S', 'transfer_rule@o'), [500]);
		near(get(out, 'S', 'transfer_rule@s'), [100]);
		near(get(out, 'S', 'outflow'), [400]);
		passes(input, out);
	});

	it('swept by hand: v = MIN(cap, MAX(0, U₀ − keep)), and the river below the off-take never under its keep when it took anything', () => {
		const g = new Rng(27);
		let took = 0;
		let bound = 0;
		for (let k = 0; k < 300; k++) {
			const flow = g.pick([0, g.float(0, 3000)]);
			const target = g.pick([0, g.float(0, 3000)]);
			const ho = g.pick([null, g.float(0, 3000)]);
			const ewr = g.pick([0, g.float(0, 3000)]);
			const ewrKeep = g.bool(0.4);
			const senior = g.pick([0, g.float(0, 3000)]);
			const cap = g.float(1, 3000);
			const nodes: NetworkNode[] = [gauge(), farm('S', { areaKm2: 1, downstreamNodeId: senior > 0 ? 'U' : 'G', damCapacityM3: 1000, damInitialPct: 1, damReleaseRule: 'passInflow', damReleaseM3Day: g.bool(0.7) ? flat(target) : null }), farm('D')];
			if (senior > 0) nodes.push(seniorUser('U', 'G', senior));
			const input = build({ nodes, transfers: [ot('o', 'S', 'D', cap, { handsOffM3Day: ho, handsOffEwr: ewrKeep })], ewr });
			const out = run(input, [flow]);
			const Z = get(out, 'S', 'ewr_cumulative')[0]!;
			const Zs = opt(out, 'S', 'senior_requirement')[0] ?? 0;
			const rt = input.model.nodes[1]!.damReleaseM3Day ? target : Z;
			const keep = Math.max(Zs, rt, ho ?? 0, ewrKeep ? Z : 0);
			const v = get(out, 'S', 'transfer_rule@o')[0]!;
			const U = get(out, 'S', 'outflow')[0]!;
			const where = `case ${k}: flow ${flow}, target ${rt}, hands-off ${ho}, Z ${Z}${ewrKeep ? ' kept' : ''}, Zs ${Zs}, cap ${cap}`;
			expect(v, where).toBeCloseTo(Math.min(cap, Math.max(0, flow - keep)), 6);
			if (v > 0) {
				took++;
				expect(U, where).toBeGreaterThanOrEqual(keep - 1e-9 * Math.max(1, keep));
				if (cap > flow - keep) bound++;
			}
			expect(U, where).toBeGreaterThanOrEqual(0);
			passes(input, out);
		}
		// Both branches are exercised: the keep binding and the capacity binding.
		expect(took).toBeGreaterThan(50);
		expect(bound).toBeGreaterThan(20);
	});
});
