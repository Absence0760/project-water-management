// End-to-end, round 2: features that round 1 tested one at a time, here
// together on one reach, every flow worked by hand from docs/model.md and run
// through the whole model with the engine's self-checks on.
//
//   - a dam transfer (§2.6) into an off-channel dam whose River to dam has a
//     hands-off flow (§2.7h), an EWR site gauge below it (§2.7b), and a river
//     off-take (§2.6a) from the transfer's own source unit, out of that
//     site's catchment: the attribution charges the source for the off-take
//     at the gauge (an export) and moves it to the canal at the outlet;
//   - a senior other water user (§2.7c) below a farm with a hands-off flow,
//     and an off-take from that farm: the off-take keeps the senior
//     requirement, never the farm's hands-off flow (§2.7h decision);
//   - an EWR shortfall caused partly by a junior off-take and partly by a
//     dam transfer out of the site's catchment (§2.7b, §2.6a "Who is charged").
// Natural flow is fed directly (runModelWith). Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { AllocationEntry } from '../allocations/compare';
import type { DemandObject, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';

const flat = (v: number) => new Array(12).fill(v);
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'O',
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
const gauge = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { kind: 'gauge', downstreamNodeId: down, sortOrder: 90, ...over });
const town = (id: string, nodeId: string, m3Day: number, over: Partial<DemandObject> = {}): DemandObject => ({
	id,
	nodeId,
	name: `Town ${id}`,
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
const damRule = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: ALL,
	maxRateM3s: 1,
	dailyCapM3: cap,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	...over
});
const offtake = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer =>
	damRule(id, from, to, cap, { source: 'river', sizing: 'capacity', lossPct: 0, handsOffM3Day: null, handsOffEwr: false, topUpDam: false, ...over });

function build(nodes: NetworkNode[], o: { transfers?: Transfer[]; objects?: DemandObject[]; ewr?: number; days: number; settings?: Partial<ProjectSettings>; allocations?: AllocationEntry[] }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(o.ewr ?? 0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, ...o.settings } as ModelInput['settings'],
		model: { nodes, crops: [], cropAreas: [], transfers: o.transfers ?? [], demandObjects: o.objects ?? [], ...(o.allocations ? { allocations: o.allocations } : {}) },
		series: { rain_catchment_mm: { startDate: '2021-01-04', values: new Array(o.days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}; have ${out.series.filter((x) => x.nodeId === nodeId).map((x) => x.key).join(', ')}`);
	return s.values;
}
const opt = (out: { series: RunSeries[] }, nodeId: string, key: string, days: number) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values ?? new Array(days).fill(0);
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	expect(out.summary.waterBalance!.total.residualM3).toBeCloseTo(0, 6);
}

/**
 * Every farm's daily balance from its published columns (§2.7 V with §2.6a's
 * off-take legs): H + I + J + Pd + in + back − out = (G − T) + E + ΔQ + U + lost.
 */
function farmBalances(input: ModelInput, out: ModelOutput) {
	const days = out.days;
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const s = (k: string) => opt(out, n.id, k, days);
		const [H, I, J, Q, U, G, T, Pd, E, xin, xout, xret, lost] = ['inflow_upstream', 'runoff', 'transfer', 'dam_storage', 'outflow', 'supplied', 'return_flow', 'rain_on_dam', 'dam_evaporation', 'offtake_in', 'offtake_out', 'offtake_loss_return', 'dam_seepage_lost'].map(s) as number[][];
		let q = n.damInitialPct * n.damCapacityM3;
		for (let t = 0; t < days; t++) {
			const lhs = H![t]! + I![t]! + J![t]! + Pd![t]! + xin![t]! + xret![t]! - xout![t]!;
			const rhs = G![t]! - T![t]! + E![t]! + (Q![t]! - q) + U![t]! + lost![t]!;
			expect(lhs - rhs, `${n.id} day ${t}`).toBeCloseTo(0, 6);
			q = Q![t]!;
		}
	}
}

describe('a dam transfer into an off-channel dam with a hands-off flow, an EWR site below, and an off-take from the same source', () => {
	// A (area 1, a full 10 000 m³ dam that catches nothing) sends 200 m³/day by a dam rule to B's
	// off-channel dam (1 000 m³, half full, River to dam 400 m³/day, hands-off 250 m³/day) and, by a
	// river off-take sized to capacity (300 m³/day, its own hands-off 100), to the canal head D, whose
	// town uses 150 m³/day. B's town uses 300. A → B → G (an EWR site) → O; D → O.
	// Pragmatic EWR 600 m³/day: A and B each carry 300 (equal areas), D none (no area).
	const nodes = [
		gauge('O', null),
		gauge('G', 'O'),
		node('A', { areaKm2: 1, downstreamNodeId: 'B', damCapacityM3: 10_000, damInitialPct: 1 }),
		node('B', { areaKm2: 1, downstreamNodeId: 'G', damCapacityM3: 1000, damInitialPct: 0.5, divertCapacityM3Day: 400, handsOffM3Day: flat(250) }),
		node('D', { downstreamNodeId: 'O' })
	];
	const transfers = [damRule('t1', 'A', 'B', 200), offtake('o1', 'A', 'D', 300, { handsOffM3Day: 100 })];
	const objects = [town('tb', 'B', 300), town('td', 'D', 150)];
	const input = build(nodes, { transfers, objects, ewr: 600, days: 5 });
	const Q = [2000, 800, 300, 0, 1200];
	const out = run(input, Q);

	it('the flows: the off-take leaves its own hands-off flow at A, River to dam leaves B’s, the transfer fills B’s dam within its room', () => {
		// A's runoff Q/2 = 1000, 400, 150, 0, 600; the off-take takes MIN(300, runoff − 100).
		near(get(out, 'A', 'transfer_rule@o1'), [300, 300, 50, 0, 300]);
		near(get(out, 'A', 'outflow'), [700, 100, 100, 0, 300]);
		// The dam rule: B's room = 1000 − yesterday's storage + its demand 300, more than 200 every day.
		near(get(out, 'A', 'transfer_rule@t1'), [200, 200, 200, 200, 200]);
		near(get(out, 'A', 'dam_storage'), [9800, 9600, 9400, 9200, 9000]);
		// B: L + N = A's outflow + B's runoff = 1700, 500, 250, 0, 900; River to dam MIN(400, L + N − 250).
		near(get(out, 'B', 'diverted_to_dam'), [400, 250, 0, 0, 400]);
		near(get(out, 'B', 'transfer'), [200, 200, 200, 200, 200]);
		near(get(out, 'B', 'supplied'), [300, 300, 300, 300, 300]);
		// 500 + 400 + 200 − 300 = 800; + 250 + 200 − 300 = 950; 850; 750; 1050 → 1000 and 50 spilt.
		near(get(out, 'B', 'dam_storage'), [800, 950, 850, 750, 1000]);
		near(get(out, 'B', 'spill'), [0, 0, 0, 0, 50]);
		near(get(out, 'B', 'outflow'), [1300, 250, 250, 0, 550]);
		near(get(out, 'G', 'outflow'), [1300, 250, 250, 0, 550]);
		// D: what arrives meets its town first, the rest flows on.
		near(get(out, 'D', 'offtake_in'), [300, 300, 50, 0, 300]);
		near(get(out, 'D', 'supplied'), [150, 150, 50, 0, 150]);
		near(get(out, 'D', 'outflow'), [150, 150, 0, 0, 150]);
		near(get(out, null, 'simulated_outflow'), [1450, 400, 250, 0, 700]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('the EWR: at G the off-take is A’s export (charged to A); at the outlet it moves to D; the transfer stays inside both', () => {
		// Z at G = 600 (A's and B's shares). Shortfalls at G: 0, 350, 350, 600, 50; at the outlet: 0, 200, 350, 600, 0.
		near(get(out, 'G', 'ewr_cumulative'), [600, 600, 600, 600, 600]);
		near(get(out, 'G', 'ewr_shortfall'), [0, -350, -350, -600, -50]);
		near(get(out, null, 'ewr_shortfall'), [0, -200, -350, -600, 0]);
		// Net impacts at G, e = H + I + J_int − U (J_int: the transfer only; the off-take crosses G's boundary):
		//   A: 0 + runoff − 200 − outflow = 100, −150, −200, 100 on days 1–4; B: 450, 200, 200, 550.
		// Day 1: E = 550 ≥ 350 → A 350 × 100/550, B 350 × 450/550. Day 2: A ≤ 0, E = 200 < 350 → B 200, natural 150.
		// Day 3: B 200, natural 400. Day 4: E = 650 → A 50 × 100/650, B 50 × 550/650.
		near(get(out, 'G', 'ewr_charged'), [0, -350, -200, -200, -50]);
		near(get(out, 'G', 'ewr_natural'), [0, 0, -150, -400, 0]);
		// At the outlet the off-take is internal: A's impact falls by what it took (−200, −200, −200), D's is
		// what it used (150, 50, 0). Day 1: E = 450 + 150 = 600, D = 200 → B 150, D 50. Day 2: E = 250, D = 350
		// → B 200, D 50, natural 100. Day 3: B 200, natural 400.
		near(get(out, null, 'ewr_charged'), [0, -200, -250, -200, 0]);
		near(get(out, null, 'ewr_natural'), [0, 0, -100, -400, 0]);
		// Each unit carries the larger of its two shares.
		near(get(out, 'A', 'ewr_charge'), [0, -(350 * 100) / 550, 0, 0, -(50 * 100) / 650]);
		near(get(out, 'B', 'ewr_charge'), [0, -(350 * 450) / 550, -200, -200, -(50 * 550) / 650]);
		near(get(out, 'D', 'ewr_charge'), [0, -50, -50, 0, 0]);
		// A's charge is a storage/export condition: it irrigates nothing.
		near(opt(out, 'A', 'ewr_charge_irrigation', 5), [0, 0, 0, 0, 0]);
		// Binding site of A (above both sites): G (index 1) on days 1 and 4.
		const bind = get(out, 'A', 'ewr_binding_site');
		expect([bind[1], bind[4]]).toEqual([1, 1]);
	});
});

describe('a senior water user below a farm with a hands-off flow and an off-take from that farm', () => {
	// F (area 1, an empty off-channel 5 000 m³ dam, River to dam 1 000 m³/day, hands-off 500) → U (senior,
	// 300 m³/day, no return) → O. An off-take F ⇒ C (canal head, town 100), capacity 400, with no hands-off
	// of its own. The senior requirement at F is 300 (F carries all the flow share).
	const nodes = [
		gauge('O', null),
		node('F', { areaKm2: 1, downstreamNodeId: 'U', damCapacityM3: 5000, divertCapacityM3Day: 1000, handsOffM3Day: flat(500) }),
		node('U', { kind: 'user', downstreamNodeId: 'O', userDemandM3Day: flat(300), userPriority: 'senior', userReturnPct: 0 }),
		node('C', { downstreamNodeId: 'O' })
	];
	const Q = [3000, 1200, 700, 400, 100];

	it('River to dam keeps the hands-off flow; the off-take keeps only the senior requirement, so the user is still served in full', () => {
		const input = build(nodes, { transfers: [offtake('o', 'F', 'C', 400)], objects: [town('tc', 'C', 100)], days: 5 });
		const out = run(input, Q);
		near(get(out, 'F', 'senior_requirement'), [300, 300, 300, 300, 300]);
		// O = MIN(1000, Q − 500): 1000, 700, 200, 0, 0 (the senior pass, 300, binds only below the hands-off).
		near(get(out, 'F', 'diverted_to_dam'), [1000, 700, 200, 0, 0]);
		near(get(out, 'F', 'dam_storage'), [1000, 1700, 1900, 1900, 1900]);
		// The off-take takes MIN(400, S − 300) from S = 2000, 500, 500, 400, 100.
		near(get(out, 'F', 'transfer_rule@o'), [400, 200, 200, 100, 0]);
		near(get(out, 'F', 'outflow'), [1600, 300, 300, 300, 100]);
		near(get(out, 'U', 'supplied'), [300, 300, 300, 300, 100]);
		near(get(out, 'U', 'deficit'), [0, 0, 0, 0, 200]);
		near(get(out, 'U', 'outflow'), [1300, 0, 0, 0, 0]);
		near(get(out, 'C', 'supplied'), [100, 100, 100, 100, 0]);
		near(get(out, 'C', 'outflow'), [300, 100, 100, 0, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('with handsOffEwr on the off-take and an EWR of 400 at F, the off-take keeps MAX(senior 300, Z 400)', () => {
		const input = build(nodes, { transfers: [offtake('o', 'F', 'C', 400, { handsOffEwr: true })], objects: [town('tc', 'C', 100)], ewr: 400, days: 5 });
		const out = run(input, Q);
		near(get(out, 'F', 'ewr_cumulative'), [400, 400, 400, 400, 400]);
		near(get(out, 'F', 'transfer_rule@o'), [400, 100, 100, 0, 0]);
		near(get(out, 'F', 'outflow'), [1600, 400, 400, 400, 100]);
		// The user takes its 300; 100 of the EWR then passes it (it has no EWR share of its own).
		near(get(out, 'U', 'outflow'), [1300, 100, 100, 100, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a junior user is not protected: the off-take takes the river down to its own keep (none)', () => {
		const junior = nodes.map((n) => (n.id === 'U' ? { ...n, userPriority: 'junior' as const } : n));
		const input = build(junior, { transfers: [offtake('o', 'F', 'C', 400)], objects: [town('tc', 'C', 100)], days: 5 });
		const out = run(input, Q);
		// No senior requirement now: River to dam keeps only the hands-off flow; the off-take takes MIN(400, S).
		near(get(out, 'F', 'diverted_to_dam'), [1000, 700, 200, 0, 0]);
		near(get(out, 'F', 'transfer_rule@o'), [400, 400, 400, 400, 100]);
		near(get(out, 'U', 'supplied'), [300, 100, 100, 0, 0]);
		expect(out.series.some((s) => s.key === 'senior_requirement')).toBe(false);
		passes(input, out);
	});
});

describe('an EWR shortfall caused partly by an off-take and partly by a dam transfer out of the site’s catchment', () => {
	// Two branches into an EWR-site gauge G, then the outlet: P (area 1, a full 5 000 m³ dam on the river
	// catching all its runoff) → G and R (area 1, no dam) → G. P's dam rule sends 300 m³/day to X, and R's
	// river off-take (capacity 400, no keep) to Y; X and Y drain to the outlet below G, so at G both leave
	// the catchment. Without the dam rule P's full dam would spill all its runoff: the room the rule opens
	// is river water P keeps. EWR 1 000 m³/day: P and R each carry 500; X and Y none.
	const nodes = [
		gauge('O', null),
		gauge('G', 'O'),
		node('P', { areaKm2: 1, downstreamNodeId: 'G', damCapacityM3: 5000, damInitialPct: 1, pctRunoffToDam: 1 }),
		node('R', { areaKm2: 1, downstreamNodeId: 'G' }),
		node('X', { downstreamNodeId: 'O' }),
		node('Y', { downstreamNodeId: 'O' })
	];
	const transfers = [damRule('t', 'P', 'X', 300), offtake('o', 'R', 'Y', 400)];
	// X and Y each use all they get (towns larger than the deliveries).
	const objects = [town('tx', 'X', 1000), town('ty', 'Y', 1000)];
	const input = build(nodes, { transfers, objects, ewr: 1000, days: 3 });
	// Each farm's runoff Q/2: 600, 300, 1000.
	const out = run(input, [1200, 600, 2000]);

	it('the flows', () => {
		// X has no dam: its room is its demand, 1000, so the rule moves its 300 every day.
		near(get(out, 'P', 'transfer_rule@t'), [300, 300, 300]);
		// P: 5000 − 300 + runoff, spilling above 5000: 300, 0, 700.
		near(get(out, 'P', 'spill'), [300, 0, 700]);
		near(get(out, 'P', 'dam_storage'), [5000, 5000, 5000]);
		near(get(out, 'R', 'transfer_rule@o'), [400, 300, 400]);
		near(get(out, 'R', 'outflow'), [200, 0, 600]);
		near(get(out, 'G', 'outflow'), [500, 0, 1300]);
		near(get(out, 'X', 'supplied'), [300, 300, 300]);
		near(get(out, 'Y', 'supplied'), [400, 300, 400]);
		near(get(out, null, 'simulated_outflow'), [500, 0, 1300]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('at G both sources are charged pro rata to what left the site (P 300, R its take); at the outlet the receivers are', () => {
		// D_G = 500, 1000, 0. e_P = runoff − outflow = 300, 300; e_R = 400, 300.
		// Day 0: E = 700 ≥ 500 → P 500 × 3/7, R 500 × 4/7. Day 1: E = 600 < 1000 → P 300, R 300, natural 400.
		near(get(out, 'G', 'ewr_charged'), [-500, -600, 0]);
		near(get(out, 'G', 'ewr_natural'), [0, -400, 0]);
		near(get(out, 'P', 'ewr_charge'), [(-500 * 3) / 7, -300, 0]);
		near(get(out, 'R', 'ewr_charge'), [(-500 * 4) / 7, -300, 0]);
		// P's charge is all storage ("store less / pass inflow"); it irrigates nothing.
		near(opt(out, 'P', 'ewr_charge_irrigation', 3), [0, 0, 0]);
		// At the outlet both rules are internal: P and R have no net impact (what they sent is the receivers'),
		// X used 300, Y 400 / 300. Same shortfalls, the same split, charged to the receivers.
		near(get(out, null, 'ewr_charged'), [-500, -600, 0]);
		near(get(out, 'X', 'ewr_charge'), [(-500 * 3) / 7, -300, 0]);
		near(get(out, 'Y', 'ewr_charge'), [(-500 * 4) / 7, -300, 0]);
		// Y's use is all consumptive (G − T, §2.7f), so its whole charge is met by taking less.
		near(opt(out, 'Y', 'ewr_charge_irrigation', 3), get(out, 'Y', 'ewr_charge'));
	});
});

describe('rules that read a unit’s demand, where another feature changes that demand', () => {
	it('an off-take sized to demand sizes to the restricted demand of a unit under a drought restriction (§2.6a, §2.7i)', () => {
		// A: a dam 20 % full (the rule reads it alone), the off-take's source. D: a town of 300 m³/day, cut by
		// half at level 1 (below 50 %). The off-take (25 % losses) takes 150 ÷ 0.75 = 200 and delivers 150.
		const rule: DroughtRestrictionRule = { reviewDates: ['01-04'], levels: [{ label: 'L1', belowPct: 0.5, cuts: { municipal: 0.5 } }], basis: 'dams', damNodeIds: ['A'], nodeIds: ['D'] };
		const nodes = [gauge('O', null), node('A', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 0.2 }), node('D', {})];
		const input = build(nodes, { transfers: [offtake('o', 'A', 'D', 1000, { sizing: 'demand', lossPct: 0.25 })], objects: [town('td', 'D', 300)], days: 2, settings: { droughtRestriction: rule } });
		const out = run(input, [1000, 1000]);
		expect(get(out, null, 'restriction_level')).toEqual([1, 1]);
		near(get(out, 'D', 'restricted_demand'), [150, 150]);
		near(get(out, 'A', 'transfer_rule@o'), [200, 200]);
		near(get(out, 'D', 'offtake_in'), [150, 150]);
		near(get(out, 'D', 'supplied'), [150, 150]);
		near(get(out, 'D', 'deficit'), [150, 150]);
		near(get(out, 'A', 'outflow'), [800, 800]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a dam transfer’s room reads only the dam-sourced demand of a unit with a river abstraction beside its dam (§2.6, §2.7j)', () => {
		// B: a full 1 000 m³ dam, a town of 100 on the dam and an irrigation object of 300 on its own river pump.
		// The rule from A (up to 500) may bring only what the dam is drawn for: 100. The river pump takes 300
		// from B's runoff.
		const nodes = [gauge('O', null), node('A', { damCapacityM3: 5000, damInitialPct: 1 }), node('B', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 1 })];
		const objects = [town('tb', 'B', 100), town('ib', 'B', 300, { category: 'irrigation', priority: 'shared', waterSource: 'river', riverPumpM3Day: 300 })];
		const input = build(nodes, { transfers: [damRule('t', 'A', 'B', 500)], objects, days: 2 });
		const out = run(input, [1000, 1000]);
		near(get(out, 'A', 'transfer_rule@t'), [100, 100]);
		near(get(out, 'B', 'dam_storage'), [1000, 1000]);
		near(get(out, 'B', 'spill'), [0, 0]);
		near(get(out, 'B', 'river_take@ib'), [300, 300]);
		near(get(out, 'B', 'supplied'), [400, 400]);
		near(get(out, 'B', 'outflow'), [700, 700]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a senior user under a full allocation passes its scaled claim to the farm above (§2.12a, §2.7c)', () => {
		// U asks 400 m³/day; registered 73 000 m³ a year, so over 4 days of one water year k = 73 000 × 4/365 ÷ 1 600 = 0.5.
		// F's dam (on the river, catching all its runoff) keeps 200 below it for U, not 400.
		const nodes = [gauge('O', null), node('F', { areaKm2: 1, downstreamNodeId: 'U', damCapacityM3: 10_000, pctRunoffToDam: 1 }), node('U', { kind: 'user', downstreamNodeId: 'O', userDemandM3Day: flat(400), userPriority: 'senior', userReturnPct: 0 })];
		const input = build(nodes, { days: 4, allocations: [{ id: 'u', nodeId: 'U', waterSource: 'surface', volumeM3PerYear: 73_000 }], settings: { allocationMode: 'fullAllocation' } });
		const out = run(input, [1000, 1000, 100, 0]);
		near(get(out, 'U', 'demand'), [200, 200, 200, 200]);
		near(get(out, 'F', 'senior_requirement'), [200, 200, 200, 200]);
		near(get(out, 'F', 'outflow'), [200, 200, 100, 0]);
		near(get(out, 'F', 'dam_storage'), [800, 1600, 1600, 1600]);
		near(get(out, 'U', 'supplied'), [200, 200, 100, 0]);
		passes(input, out);
	});

	it('off-take water under an allocation cap: used up to the surface room, the rest tops up the dam (topUpDam), the dam drawn only within the room (§2.6a, §2.12a)', () => {
		// D: an empty 1 000 m³ dam and a town of 300; 100 m³ registered for the year. The off-take sized to
		// capacity (500) with topUpDam: day 0 uses 100 (the room), 400 into the dam; then nothing may be used.
		const nodes = [gauge('O', null), node('S', { areaKm2: 1 }), node('D', { damCapacityM3: 1000 })];
		const input = build(nodes, { transfers: [offtake('o', 'S', 'D', 500, { topUpDam: true })], objects: [town('td', 'D', 300)], days: 3, allocations: [{ id: 'd', nodeId: 'D', waterSource: 'surface', volumeM3PerYear: 100 }], settings: { allocationMode: 'cap' } });
		const out = run(input, [2000, 2000, 2000]);
		near(get(out, 'D', 'allocation_room_surface'), [100, 0, 0]);
		near(get(out, 'D', 'offtake_in'), [500, 500, 500]);
		near(get(out, 'D', 'offtake_used'), [100, 0, 0]);
		near(get(out, 'D', 'supplied'), [100, 0, 0]);
		near(get(out, 'D', 'offtake_to_dam'), [400, 500, 500]);
		near(get(out, 'D', 'dam_storage'), [400, 900, 1000]);
		near(get(out, 'D', 'spill'), [0, 0, 400]);
		farmBalances(input, out);
		passes(input, out);
	});
});
