// End-to-end: the river off-take decisions of engine 1.70.0 (issue #393, the
// provisional answers to issue #90 Q25, Q26 and Q27; docs/model.md §2.6a,
// §2.7e). Each case is a small invented catchment worked by hand from the
// docs, never from what the engine returned before.
//
// - Q25: rules of one priority share a short river (an off-take) or a dam's
//   water (a dam rule) in proportion to what each asks, MIN(capacity, need),
//   band by band at their keeps, never capped at the free flow first:
//   proportional rationing, so a licence split into parts gets what it gets
//   as one rule. A run warns about rules that may be one licence entered more
//   than once at full size (same source, destination, priority, a month in
//   common), which still takes that many times the licence.
// - Q26: a room into a dam with a fixed release (a demand-sized off-take's
//   top-up and a dam rule's room alike) counts MIN(amount, outlet) in full,
//   since the water moved in arrives before the release; the dam's own
//   inflow that day is still left out.
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
const splitWarnings = (out: ModelOutput) => out.summary.warnings.filter((w) => /more than once at its full size/.test(w));
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// ── Q25: proportional rationing within a priority (engine ≥ 1.70.0) ───────────────────────────────────────

describe('Q25 (§2.6, §2.6a): rules of one priority share in proportion to MIN(capacity, need), so splitting a licence gains nothing', () => {
	// One source S with all the runoff; three destinations with no demand (capacity sizing).
	const net = (transfers: Transfer[]) => build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D1'), farm('D2'), farm('D3')], transfers });

	it('one band (every keep 0): licence A of 300 beside B of 100 on 200 m³ gets 150 as one rule and 150 split into two of 150', () => {
		// One rule: asks 300 and 100 (never capped at the 200 there), 3 : 1 → A 150, B 50. Before 1.70.0 A asked
		// MIN(300, 200) = 200 → 133.3 and B 66.7, and the split pieces asked 150 + 150 → A 150: splitting paid.
		const one = net([ot('a', 'S', 'D1', 300), ot('b', 'S', 'D2', 100)]);
		const o1 = run(one, [200]);
		near(get(o1, 'S', 'transfer_rule@a'), [150]);
		near(get(o1, 'S', 'transfer_rule@b'), [50]);
		passes(one, o1);
		// Split: asks 150, 150, 100 → 75, 75, 50. A = 150 and B = 50, as before the split.
		const two = net([ot('a1', 'S', 'D1', 150), ot('a2', 'S', 'D1', 150), ot('b', 'S', 'D2', 100)]);
		const o2 = run(two, [200]);
		near(get(o2, 'S', 'transfer_rule@a1'), [75]);
		near(get(o2, 'S', 'transfer_rule@a2'), [75]);
		near(get(o2, 'S', 'transfer_rule@b'), [50]);
		near(get(o2, 'D1', 'offtake_in'), [150]);
		near(get(o1, 'S', 'outflow'), [0]);
		near(get(o2, 'S', 'outflow'), [0]);
		passes(two, o2);
	});

	it('a licence entered twice at full size takes double: 300 + 300 beside B of 100 on 200 gets 171.4, and 600 with plenty of water', () => {
		// Asks 300, 300, 100 on 200 → × 2/7: 85.7, 85.7, 28.6. With 1 000 there: 300 + 300 + 100. The warning's case.
		const twice = net([ot('a1', 'S', 'D1', 300), ot('a2', 'S', 'D1', 300), ot('b', 'S', 'D2', 100)]);
		const short = run(twice, [200]);
		near(get(short, 'D1', 'offtake_in'), [1200 / 7]);
		near(get(short, 'S', 'transfer_rule@b'), [200 / 7]);
		expect(splitWarnings(short)).toHaveLength(1);
		const plenty = run(twice, [1000]);
		near(get(plenty, 'D1', 'offtake_in'), [600]);
		passes(twice, plenty);
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

	it('banded keeps: licence A of 600 keeping 600 beside C of 400 keeping 0, on 1 000 m³: A 240, C 400, as one rule or split 300 + 300', () => {
		// Asks 600 and 400. Band 1 000–600 (400): both (C keeps 0 ≤ 600), 6 : 4 → A 240, C 160. Band 600–0: C alone,
		// its other 240. A 240, C 400, 360 passes (≥ A's keep 600 − its own band: the river at A's level is
		// 1 000 − 240 − 160 = 600, so A never took below its keep). Split: asks 300, 300, 400 → 120, 120, 160, then
		// C's 240: the same. (Before 1.70.0: one rule A 200, river 400; split A 240, river 360.)
		const one = net([ot('a', 'S', 'D1', 600, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 400)]);
		const o1 = run(one, [1000]);
		near(get(o1, 'S', 'transfer_rule@a'), [240]);
		near(get(o1, 'S', 'transfer_rule@c'), [400]);
		near(get(o1, 'S', 'outflow'), [360]);
		passes(one, o1);
		const two = net([ot('a1', 'S', 'D1', 300, { handsOffM3Day: 600 }), ot('a2', 'S', 'D1', 300, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 400)]);
		const o2 = run(two, [1000]);
		near(get(o2, 'S', 'transfer_rule@a1'), [120]);
		near(get(o2, 'S', 'transfer_rule@a2'), [120]);
		near(get(o2, 'S', 'transfer_rule@c'), [400]);
		near(get(o2, 'S', 'outflow'), [360]);
		passes(two, o2);
	});

	it('dam rules too: a full 1 000 m³ dam keeping 70 % (300 free), licence A of 400 beside B of 200: A 200 as one rule or split 200 + 200', () => {
		// Asks 400 and 200 → 2 : 1 of the 300 → A 200, B 100. Split 200 + 200 + 200 → 100 each: A 200. (Before 1.70.0
		// one rule asked MIN(400, 300) = 300 → A 180, B 120; split, each asked 200 → A 200: splitting paid.)
		const dams = (transfers: Transfer[]) =>
			build({
				nodes: [gauge(), farm('S', { damCapacityM3: 1000, damInitialPct: 1 }), farm('D1', { damCapacityM3: 5000 }), farm('D2', { damCapacityM3: 5000 })],
				transfers
			});
		const rule = (id: string, to: string, cap: number): Transfer => ({ ...ot(id, 'S', to, cap), source: 'dam', minStoragePct: 0.7 });
		const one = dams([rule('a', 'D1', 400), rule('b', 'D2', 200)]);
		const o1 = run(one, [0]);
		near(get(o1, 'S', 'transfer_rule@a'), [200]);
		near(get(o1, 'S', 'transfer_rule@b'), [100]);
		near(get(o1, 'S', 'dam_storage'), [700]);
		passes(one, o1);
		const two = dams([rule('a1', 'D1', 200), rule('a2', 'D1', 200), rule('b', 'D2', 200)]);
		const o2 = run(two, [0]);
		near(get(o2, 'D1', 'transfer'), [200]);
		near(get(o2, 'S', 'transfer_rule@b'), [100]);
		passes(two, o2);
	});

	it('property: random licences split into 1–4 random parts get the same totals, for off-takes and dam rules alike', () => {
		const g = new Rng(25);
		let short = 0;
		for (let k = 0; k < 150; k++) {
			const dam = g.bool(0.5);
			const n = g.int(1, 4);
			const licences = Array.from({ length: n }, (_, j) => ({
				id: `L${j}`,
				to: `D${g.int(0, 2)}`,
				cap: g.float(10, 1500),
				keep: dam ? g.pick([0, 0.2, 0.5, 0.8]) : g.pick([0, 0, g.float(0, 1500)]),
				priority: g.pick([0, 0, 1])
			}));
			const flow = g.pick([0, g.float(0, 3000)]);
			const make = (split: boolean, seed: number) => {
				const h = new Rng(seed);
				const transfers: Transfer[] = [];
				for (const l of licences) {
					const parts = split ? h.int(1, 4) : 1;
					const w = Array.from({ length: parts }, () => h.float(0.1, 1));
					const tot = sum(w);
					w.forEach((x, p) => {
						const base = ot(`${l.id}-${p}`, 'S', l.to, (l.cap * x) / tot, { priority: l.priority });
						transfers.push(dam ? { ...base, source: 'dam', minStoragePct: l.keep } : { ...base, handsOffM3Day: l.keep || null });
					});
				}
				const nodes = [gauge(), farm('S', dam ? { damCapacityM3: 2000, damInitialPct: flow / 3000 } : { areaKm2: 1 }), ...['D0', 'D1', 'D2'].map((id) => farm(id, dam ? { damCapacityM3: 1e6 } : {}))];
				return build({ nodes, transfers });
			};
			const totals = (input: ModelInput, out: ModelOutput) => {
				const t = new Map<string, number>();
				for (const tr of input.model.transfers) {
					const lid = tr.id.split('-')[0]!;
					t.set(lid, (t.get(lid) ?? 0) + get(out, 'S', `transfer_rule@${tr.id}`)[0]!);
				}
				return t;
			};
			const a = make(false, k);
			const b = make(true, 1000 + k);
			const oa = run(a, [dam ? 0 : flow]);
			const ob = run(b, [dam ? 0 : flow]);
			const ta = totals(a, oa);
			const tb = totals(b, ob);
			for (const l of licences) expect(tb.get(l.id), `case ${k} ${dam ? 'dam' : 'river'} licence ${l.id}`).toBeCloseTo(ta.get(l.id)!, 6);
			if (sum([...ta.values()]) < sum(licences.map((l) => l.cap)) - 1e-6) short++;
			passes(a, oa);
			passes(b, ob);
		}
		// Most cases are short, where the old rule paid a split.
		expect(short).toBeGreaterThan(60);
	});

	it('warns once for two rules of one priority from one source to one unit, naming them in id order', () => {
		const out = run(net([ot('a2', 'S', 'D1', 150), ot('a1', 'S', 'D1', 150), ot('b', 'S', 'D2', 100)]), [200]);
		expect(splitWarnings(out)).toEqual([
			'river off-take Unit S → Unit D1: 2 rules of priority 0 (a1, a2) take from the same river for the same unit. If they are one licence entered more than once at its full size, it takes that many times its licence: enter each licence once (a licence split into parts runs the same as one rule)'
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

// ── Q26: a room into a dam with a fixed release counts MIN(amount, outlet) in full ────────────────────────

describe('Q26 (§2.6, §2.6a): a room into a dam with a fixed release counts MIN(amount, outlet), so the dam ends full and never spills', () => {
	// S has 10 000 m³/day; D has a 1 000 m³ dam, no runoff of its own (area 0): the day has no inflow to the dam, so
	// all it receives is the off-take's water. No rain, evaporation or seepage (A-pan 0, area 0).
	// need = demand + (cap − held) + MIN(amount, outlet).
	const net = (dam: Partial<NetworkNode>, transfers: Transfer[] = [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true })], extra: NetworkNode[] = [], days = 1) =>
		build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: 1000, ...dam }), ...extra], transfers, days });
	const fixed = (m3Day: number, over: Partial<NetworkNode> = {}): Partial<NetworkNode> => ({ damReleaseRule: 'fixed', damReleaseM3Day: flat(m3Day), ...over });

	it('a release (300) larger than the room (100): the off-take brings 400, the dam releases 300 and ends full, nothing spills', () => {
		// Before 1.70.0 it brought 100 and the dam ended at 700.
		const input = net({ damInitialPct: 0.9, ...fixed(300) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [400]);
		near(get(out, 'D', 'offtake_to_dam'), [400]);
		near(get(out, 'D', 'dam_release'), [300]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
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

	it('the outlet caps it: release 300 through a 120 m³/day outlet on a full dam brings 120; an outlet of 0 makes no room', () => {
		const input = net({ damInitialPct: 1, ...fixed(300, { damOutletCapacityM3Day: 120 }) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [120]);
		near(get(out, 'D', 'dam_release'), [120]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
		const shut = net({ damInitialPct: 1, ...fixed(300, { damOutletCapacityM3Day: 0 }) });
		const o0 = run(shut, [10_000]);
		near(get(o0, 'S', 'transfer_rule@o'), [0]);
		near(get(o0, 'D', 'dam_release'), [0]);
		passes(shut, o0);
	});

	it('a dam near its dead storage ends full: 500 m³ held, dead storage 400, release 300 → the off-take brings 800', () => {
		// room 1 000 − 500 + MIN(300, ∞) = 800. The day: 500 + 800 = 1 300, 900 above dead storage, so it releases its
		// full 300 and ends at 1 000. Day 2, full: brings 300, releases 300, full. (Before 1.70.0 the room counted only
		// the floor MIN(300, 500 − 400) = 100: 600 brought and the dam ended at 800.)
		const input = net({ damInitialPct: 0.5, damMinPct: 0.4, ...fixed(300) }, undefined, [], 2);
		const out = run(input, [10_000, 10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [800, 300]);
		near(get(out, 'D', 'dam_release'), [300, 300]);
		near(get(out, 'D', 'dam_storage'), [1000, 1000]);
		near(get(out, 'D', 'spill'), [0, 0]);
		passes(input, out);
	});

	it('a dam below its dead storage whose source is short: the release is cut to the water above dead storage and the dam ends at dead storage, not over', () => {
		// held 300 < dead 400; room 1 000 − 300 + 300 = 1 000, but the off-take is capped at 150 a day. The day: 300 +
		// 150 = 450, release MIN(300, 450 − 400) = 50, the dam ends at 400 = its dead storage ≤ its capacity.
		const input = net({ damInitialPct: 0.3, damMinPct: 0.4, ...fixed(300) }, [ot('o', 'S', 'D', 150, { sizing: 'demand', topUpDam: true })]);
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [150]);
		near(get(out, 'D', 'dam_release'), [50]);
		near(get(out, 'D', 'dam_storage'), [400]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
	});

	it('a pass-inflow release adds nothing to the room (it is at most the day’s inflow, which the room leaves out)', () => {
		const input = net({ damInitialPct: 0.9, damReleaseRule: 'passInflow', damReleaseM3Day: flat(300) });
		const out = run(input, [10_000]);
		near(get(out, 'S', 'transfer_rule@o'), [100]);
		near(get(out, 'D', 'dam_release'), [0]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		passes(input, out);
	});

	it('with a dam rule’s receipts: 900 m³ in a 1 000 m³ dam, 250 by a dam rule, release 300: the off-take brings 150', () => {
		// The dam rule settles first: its room is 1 000 − 900 + 300 = 400 ≥ 250, so D receives 250. The top-up: held
		// 1 150, need = MAX(0, 1 000 − 1 150 + 300) = 150. The day: 1 150 + 150 − 300 = 1 000, full, no spill.
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

	it('a dam rule alone into a dam near its dead storage: the room counts the full release too, and the dam ends full', () => {
		// D at 500, dead 400, release 300, no demand: room = 1 000 − 500 + 0 + 300 = 800. 500 + 800 − 300 = 1 000.
		const input = net({ damInitialPct: 0.5, damMinPct: 0.4, ...fixed(300) }, [{ ...ot('t', 'S2', 'D', 5000), source: 'dam' }], [farm('S2', { damCapacityM3: 5000, damInitialPct: 1 })]);
		const out = run(input, [10_000]);
		near(get(out, 'S2', 'transfer_rule@t'), [800]);
		near(get(out, 'D', 'dam_release'), [300]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [0]);
		passes(input, out);
	});

	it('with a demand at the destination (200): the off-take brings demand + room + release, the demand met first', () => {
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
		// The step holds 900 + 1 000 + 400 = 2 300, releases 300 and spills 1 000, the inflow exactly: it is known only
		// once the network runs, after the off-takes are sized (§2.6a: the room leaves the day's inflow out).
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { areaKm2: 1, pctRunoffToDam: 1, damCapacityM3: 1000, damInitialPct: 0.9, ...fixed(300) })],
			transfers: [ot('o', 'S', 'D', 5000, { sizing: 'demand', topUpDam: true })]
		});
		const out = run(input, [2000]);
		near(get(out, 'S', 'transfer_rule@o'), [400]);
		near(get(out, 'D', 'dam_release'), [300]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		near(get(out, 'D', 'spill'), [1000]);
		passes(input, out);
	});

	it('property, both paths: on days with no inflow the delivery is demand + room + MIN(amount, outlet) (up to its capacity), and nothing overfills or spills', () => {
		const g = new Rng(26);
		let cut = 0;
		for (let k = 0; k < 300; k++) {
			const viaDamRule = g.bool(0.5);
			const cap = g.float(100, 5000);
			const init = g.frac();
			const dead = g.pick([0, g.frac()]);
			const amount = g.pick([0, g.float(0, 2000)]);
			const outlet = g.pick([null, 0, g.float(0, 1500)]);
			const demand = g.pick([0, g.float(0, 1000)]);
			const limit = g.pick([1e7, g.float(0, 3000)]);
			const dam = { damCapacityM3: cap, damInitialPct: init, damMinPct: dead, ...fixed(amount, { damOutletCapacityM3Day: outlet }) };
			const input = viaDamRule
				? build({
						nodes: [gauge(), farm('S2', { damCapacityM3: 1e8, damInitialPct: 1 }), farm('D', dam)],
						transfers: [{ ...ot('o', 'S2', 'D', limit), source: 'dam' }],
						objects: demand > 0 ? [town('D', demand)] : []
					})
				: build({
						nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', dam)],
						transfers: [ot('o', 'S', 'D', limit, { sizing: 'demand', topUpDam: true })],
						objects: demand > 0 ? [town('D', demand)] : []
					});
			const out = run(input, [1e7]);
			const held = init * cap;
			// The dam rule's room counts the demand its dam meets (D), the off-take's need its demand: the same D here.
			const want = Math.min(limit, demand + (cap - held) + Math.min(amount, outlet ?? Infinity));
			const from = viaDamRule ? 'S2' : 'S';
			const where = `case ${k} (${viaDamRule ? 'dam rule' : 'off-take'}): cap ${cap}, held ${held}, dead ${dead * cap}, release ${amount}, outlet ${outlet}, demand ${demand}, limit ${limit}`;
			expect(get(out, from, 'transfer_rule@o')[0], where).toBeCloseTo(want, 6);
			expect(get(out, 'D', 'spill')[0], where).toBeCloseTo(0, 6);
			expect(get(out, 'D', 'dam_storage')[0], where).toBeLessThanOrEqual(cap * (1 + 1e-12));
			if (get(out, 'D', 'dam_release')[0]! < Math.min(amount, outlet ?? Infinity) - 1e-9) cut++;
			passes(input, out);
		}
		// Some days the release is cut to the water above dead storage (a short source): the dam then ends at dead storage.
		expect(cut).toBeGreaterThan(10);
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

	it('banded with a sibling of the same priority keeping more: target 400, sibling keeps 700, on 1 000: o 450, s 150', () => {
		// keeps: o MAX(400, 0) = 400, s MAX(400, 700) = 700. Each asks its 2 000 (engine ≥ 1.70.0, never capped at the flow).
		// Band 1 000–700 (300) shared 1 : 1 → o 150, s 150. Band 700–400 (300) to o alone: o 450 in all, s 150; 400 passes.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 1, damReleaseRule: 'passInflow', damReleaseM3Day: flat(400) }), farm('D'), farm('D2')],
			transfers: [ot('o', 'S', 'D', 2000), ot('s', 'S', 'D2', 2000, { handsOffM3Day: 700 })]
		});
		const out = run(input, [1000]);
		near(get(out, 'S', 'transfer_rule@o'), [450]);
		near(get(out, 'S', 'transfer_rule@s'), [150]);
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
