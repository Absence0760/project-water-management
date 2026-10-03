// End-to-end: dam-to-dam transfers (docs/model.md §2.6): the m³/s → m³/day
// limit, the daily cap, the months and the monthly rates switching on the 1st,
// the source's reserve, the destination's room (a full dam, a farm with no
// dam), an empty source, yesterday's storage, priorities and the pro-rata
// sharing with each rule's own reserve (audit N6), each worked by hand and run
// through the whole model. Synthetic names and values only.
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
		lossReturnFraction: 0,
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
const rule = (id: string, from: string, to: string, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: ALL,
	maxRateM3s: 1,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	...over
});
/** A source dam S (no runoff), a destination D with no dam and a town of `want` m³/day, both draining to G. */
const pair = (src: Partial<NetworkNode>, tr: Transfer[], want = 10_000, days = 3, start?: string) =>
	build({
		nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 10_000, damInitialPct: 1, ...src }), farm('D', { areaKm2: 0 })],
		transfers: tr,
		objects: [town('D', want)],
		days,
		...(start ? { start } : {})
	});
const zeros = (n: number) => new Array(n).fill(0);

describe('a transfer’s daily limit (§2.6)', () => {
	it('moves max rate × 86 400 m³ a day: 0.001 m³/s is 86.4 m³/day', () => {
		const input = pair({}, [rule('r', 'S', 'D', { maxRateM3s: 0.001 })]);
		const out = run(input, zeros(3));
		near(get(out, 'S', 'transfer_rule@r'), [86.4, 86.4, 86.4]);
		near(get(out, 'S', 'transfer'), [-86.4, -86.4, -86.4]);
		near(get(out, 'D', 'transfer'), [86.4, 86.4, 86.4]);
		near(get(out, 'D', 'supplied'), [86.4, 86.4, 86.4]);
		near(get(out, 'S', 'dam_storage'), [10_000 - 86.4, 10_000 - 172.8, 10_000 - 259.2]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a daily cap can only lower it', () => {
		const out = run(pair({}, [rule('r', 'S', 'D', { maxRateM3s: 0.001, dailyCapM3: 50 })]), zeros(3));
		near(get(out, 'S', 'transfer_rule@r'), [50, 50, 50]);
		const out2 = run(pair({}, [rule('r', 'S', 'D', { maxRateM3s: 0.001, dailyCapM3: 500 })]), zeros(3));
		near(get(out2, 'S', 'transfer_rule@r'), [86.4, 86.4, 86.4]);
	});

	it('runs only in its listed months, switching on the 1st', () => {
		const input = pair({}, [rule('r', 'S', 'D', { maxRateM3s: 0.001, months: [2] })], 10_000, 4, '2021-01-30');
		const out = run(input, zeros(4));
		near(get(out, 'S', 'transfer_rule@r'), [0, 0, 86.4, 86.4]);
		near(get(out, 'D', 'supplied'), [0, 0, 86.4, 86.4]);
		passes(input, out);
	});

	it('monthly rates (Oct–Sep) switch from September’s to October’s on 1 October; a month at 0 is off', () => {
		const rates = flat(0);
		rates[0] = 0.002; // Oct
		rates[11] = 0.001; // Sep
		const input = pair({}, [rule('r', 'S', 'D', { monthlyRateM3s: rates, months: [9, 10], maxRateM3s: 0.002 })], 10_000, 4, '2021-09-29');
		const out = run(input, zeros(4));
		near(get(out, 'S', 'transfer_rule@r'), [86.4, 86.4, 172.8, 172.8]);
		passes(input, out);
		// November is 0: off.
		const nov = pair({}, [rule('r', 'S', 'D', { monthlyRateM3s: rates, months: [9, 10], maxRateM3s: 0.002 })], 10_000, 3, '2021-10-30');
		near(get(run(nov, zeros(3)), 'S', 'transfer_rule@r'), [172.8, 172.8, 0]);
	});

	it('the monthly rate’s daily limit is MIN(rate × 86 400, daily cap)', () => {
		const rates = flat(0.01); // 864 m³/day every month
		const input = pair({}, [rule('r', 'S', 'D', { monthlyRateM3s: rates, months: ALL, maxRateM3s: 0.01, dailyCapM3: 300 })], 10_000, 2);
		near(get(run(input, zeros(2)), 'S', 'transfer_rule@r'), [300, 300]);
	});
});

describe('what the source can give (§2.6, Q5)', () => {
	it('keeps the rule’s minimum storage in the source', () => {
		const input = pair({ damCapacityM3: 1000 }, [rule('r', 'S', 'D', { minStoragePct: 0.6 })], 1000);
		const out = run(input, zeros(3));
		near(get(out, 'S', 'transfer_rule@r'), [400, 0, 0]);
		near(get(out, 'S', 'dam_storage'), [600, 600, 600]);
		passes(input, out);
	});

	it('or the source dam’s minimum operating level, when that is higher', () => {
		const out = run(pair({ damCapacityM3: 1000, damMinPct: 0.7 }, [rule('r', 'S', 'D', { minStoragePct: 0.6 })], 1000, 2), zeros(2));
		near(get(out, 'S', 'transfer_rule@r'), [300, 0]);
	});

	it('an empty source, or a unit with no dam, sends nothing', () => {
		const empty = pair({ damInitialPct: 0 }, [rule('r', 'S', 'D')]);
		const o1 = run(empty, zeros(3));
		near(get(o1, 'S', 'transfer_rule@r'), [0, 0, 0]);
		near(get(o1, 'D', 'supplied'), [0, 0, 0]);
		passes(empty, o1);
		// A source with no dam, its own runoff flowing past: still nothing (a dam transfer draws on storage only).
		const nodam = pair({ damCapacityM3: 0, damInitialPct: 0 }, [rule('r', 'S', 'D')]);
		const o2 = run(nodam, [500, 500, 500]);
		near(get(o2, 'S', 'transfer_rule@r'), [0, 0, 0]);
		near(get(o2, 'S', 'outflow'), [500, 500, 500]);
		passes(nodam, o2);
	});

	it('draws on yesterday’s storage: what flows into the source today moves tomorrow', () => {
		const input = pair({ damCapacityM3: 1000, damInitialPct: 0, pctRunoffToDam: 1 }, [rule('r', 'S', 'D')], 1000);
		const out = run(input, [500, 0, 0]);
		near(get(out, 'S', 'transfer_rule@r'), [0, 500, 0]);
		near(get(out, 'S', 'dam_storage'), [500, 0, 0]);
		near(get(out, 'D', 'supplied'), [0, 500, 0]);
		farmBalances(input, out);
		passes(input, out);
	});
});

describe('what the destination can take (§2.6, N4)', () => {
	it('into a full dam: only what the dam is drawn for today, so nothing spills', () => {
		const input = build({
			nodes: [gauge(), farm('S', { damCapacityM3: 10_000, damInitialPct: 1 }), farm('D', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 1 })],
			transfers: [rule('r', 'S', 'D')],
			objects: [town('D', 100)],
			days: 3
		});
		const out = run(input, zeros(3));
		near(get(out, 'S', 'transfer_rule@r'), [100, 100, 100]);
		near(get(out, 'D', 'supplied'), [100, 100, 100]);
		near(get(out, 'D', 'dam_storage'), [1000, 1000, 1000]);
		near(get(out, 'D', 'spill'), [0, 0, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('into a full dam that evaporates: the room counts today’s evaporation, so the dam ends full and nothing spills', () => {
		// January A-pan 31 mm, lake factor 1: 1 mm/day over 10 000 m² = 10 m³/day. Room = 1000 − (1000 − 10) + 100 = 110.
		const apan = flat(0);
		apan[3] = 31;
		const input = build({
			nodes: [gauge(), farm('S', { damCapacityM3: 10_000, damInitialPct: 1 }), farm('D', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 1, damAreaFullM2: 10_000 })],
			transfers: [rule('r', 'S', 'D')],
			objects: [town('D', 100)],
			settings: { apanMm: apan as unknown as Monthly, lakeEvapFactor: 1 },
			days: 2
		});
		const out = run(input, zeros(2));
		near(get(out, 'D', 'dam_evaporation'), [10, 10]);
		near(get(out, 'S', 'transfer_rule@r'), [110, 110]);
		near(get(out, 'D', 'dam_storage'), [1000, 1000]);
		near(get(out, 'D', 'spill'), [0, 0]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('into a half-full dam with no demand: its room, once', () => {
		const input = build({
			nodes: [gauge(), farm('S', { damCapacityM3: 10_000, damInitialPct: 1 }), farm('D', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 0.5 })],
			transfers: [rule('r', 'S', 'D')],
			days: 3
		});
		const out = run(input, zeros(3));
		near(get(out, 'S', 'transfer_rule@r'), [500, 0, 0]);
		near(get(out, 'D', 'dam_storage'), [1000, 1000, 1000]);
		passes(input, out);
	});

	it('to a unit with no dam: its demand, never more', () => {
		const out = run(pair({}, [rule('r', 'S', 'D')], 250, 2), zeros(2));
		near(get(out, 'S', 'transfer_rule@r'), [250, 250]);
		near(get(out, 'D', 'spill'), [0, 0]);
		near(get(out, 'D', 'outflow'), [0, 0]);
	});

	it('rules into one destination share its room pro rata to their limits', () => {
		// D: dam 1000 at 80 %, no demand: room 200. Limits 100 and 300 → 50 and 150.
		const input = build({
			nodes: [
				gauge(),
				farm('S1', { damCapacityM3: 10_000, damInitialPct: 1 }),
				farm('S2', { damCapacityM3: 10_000, damInitialPct: 1 }),
				farm('D', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 0.8 })
			],
			transfers: [rule('a', 'S1', 'D', { dailyCapM3: 100 }), rule('b', 'S2', 'D', { dailyCapM3: 300 })],
			days: 1
		});
		const out = run(input, [0]);
		near(get(out, 'S1', 'transfer_rule@a'), [50]);
		near(get(out, 'S2', 'transfer_rule@b'), [150]);
		near(get(out, 'D', 'dam_storage'), [1000]);
		passes(input, out);
	});

	it('the transfer to a gauge is skipped, with a warning', () => {
		const input = build({ nodes: [gauge(), farm('S', { damCapacityM3: 1000, damInitialPct: 1 })], transfers: [rule('r', 'S', 'G')], days: 1 });
		const out = run(input, [0]);
		expect(out.summary.warnings.some((w) => /transfers must be between units/.test(w))).toBe(true);
		near(get(out, 'S', 'dam_storage'), [1000]);
	});
});

describe('several rules (§2.6, Q18, N6)', () => {
	const three = (tr: Transfer[], want1 = 600, want2 = 600) =>
		build({
			nodes: [gauge(), farm('S', { damCapacityM3: 1000, damInitialPct: 1 }), farm('D1', { areaKm2: 0 }), farm('D2', { areaKm2: 0 })],
			transfers: tr,
			objects: [town('D1', want1), town('D2', want2)],
			days: 2
		});

	it('lower priority first: the second rule gets what the first leaves', () => {
		const input = three([rule('r1', 'S', 'D1', { priority: 1 }), rule('r0', 'S', 'D2', { priority: 0 })]);
		const out = run(input, zeros(2));
		near(get(out, 'S', 'transfer_rule@r0'), [600, 0]);
		near(get(out, 'S', 'transfer_rule@r1'), [400, 0]);
		passes(input, out);
	});

	it('equal priority: the free water shared pro rata to each rule’s limit, never capped at the free water (engine ≥ 1.70.0)', () => {
		// Both keep 70 %: free 300. Limits 200 and 400 → 1 : 2 → 100 and 200 (issue #90 Q25: proportional rationing;
		// before 1.70.0 each asked MIN(limit, free), 200 and 300 → 120 and 180).
		const input = three([rule('a', 'S', 'D1', { dailyCapM3: 200, minStoragePct: 0.7 }), rule('b', 'S', 'D2', { dailyCapM3: 400, minStoragePct: 0.7 })], 1000, 1000);
		const out = run(input, zeros(2));
		near(get(out, 'S', 'transfer_rule@a'), [100, 0]);
		near(get(out, 'S', 'transfer_rule@b'), [200, 0]);
		near(get(out, 'S', 'dam_storage'), [700, 700]);
		passes(input, out);
	});

	it('each rule draws only above its own reserve: model.md’s worked example (a 250, b 400, the dam ends at 350)', () => {
		const input = three([rule('a', 'S', 'D1', { dailyCapM3: 400, minStoragePct: 0.5 }), rule('b', 'S', 'D2', { dailyCapM3: 400, minStoragePct: 0 })], 1000, 1000);
		const out = run(input, zeros(2));
		near(get(out, 'S', 'transfer_rule@a'), [250, 0]);
		near(get(out, 'S', 'transfer_rule@b'), [400, 350]);
		near(get(out, 'S', 'dam_storage'), [350, 0]);
		passes(input, out);
	});

	it('the source’s bands first, then the room: model.md’s band-and-room example (a 100, b 800; engine ≥ 1.70.0)', () => {
		// a keeps 50 % and may send 400 into R (dam 1000 at 95 %, demand 50: room 100); b keeps 0 % and may send 800 into an empty dam.
		// The source rations first: band 1000–500 shared 400 : 800 → a 166.7, b 333.3; b its other 466.7 below. R's room
		// cuts a to 100 and R is full, so nothing is offered again. (Before 1.70.0 the room came first, a was cut to 100
		// and the band 1000–500 shared 100 : 800: a 55.6, b 800.)
		const input = build({
			nodes: [gauge(), farm('S', { damCapacityM3: 1000, damInitialPct: 1 }), farm('R', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 0.95 }), farm('E', { areaKm2: 0, damCapacityM3: 1000 })],
			transfers: [rule('a', 'S', 'R', { dailyCapM3: 400, minStoragePct: 0.5 }), rule('b', 'S', 'E', { dailyCapM3: 800 })],
			objects: [town('R', 50)],
			days: 1
		});
		const out = run(input, [0]);
		near(get(out, 'S', 'transfer_rule@a'), [100]);
		near(get(out, 'S', 'dam_storage'), [100]);
		near(get(out, 'S', 'transfer_rule@b'), [800]);
		passes(input, out);
	});

	it('a chain A → B → C the same day: B sends from yesterday’s storage, what it receives today stays', () => {
		const input = build({
			nodes: [gauge(), farm('A', { damCapacityM3: 1000, damInitialPct: 1 }), farm('B', { areaKm2: 0, damCapacityM3: 1000 }), farm('C', { areaKm2: 0 })],
			transfers: [rule('ab', 'A', 'B', { dailyCapM3: 300 }), rule('bc', 'B', 'C', { dailyCapM3: 300 })],
			objects: [town('C', 1000)],
			days: 3
		});
		const out = run(input, zeros(3));
		near(get(out, 'A', 'transfer_rule@ab'), [300, 300, 300]);
		near(get(out, 'B', 'transfer_rule@bc'), [0, 300, 300]);
		near(get(out, 'B', 'dam_storage'), [300, 300, 300]);
		near(get(out, 'C', 'supplied'), [0, 300, 300]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a transfer upstream (against the river) carries water back up; the network still balances', () => {
		// U (dam) → L (dam) on the river; L sends 200 a day back up to U's town.
		const input = build({
			nodes: [gauge(), farm('U', { downstreamNodeId: 'L', areaKm2: 1 }), farm('L', { areaKm2: 1, damCapacityM3: 5000, damInitialPct: 1, pctUpstreamToDam: 1, pctRunoffToDam: 1 })],
			transfers: [rule('up', 'L', 'U', { dailyCapM3: 200 })],
			objects: [town('U', 200)],
			days: 3
		});
		const out = run(input, [400, 0, 0]);
		near(get(out, 'L', 'transfer_rule@up'), [200, 200, 200]);
		near(get(out, 'U', 'supplied'), [200, 200, 200]);
		// Day 1: U's runoff 200 passes (its town is served by the transfer), L's dam takes 200 + 200 in, 200 out: full, spills 200.
		near(get(out, 'L', 'dam_storage'), [5000, 4800, 4600]);
		near(get(out, 'G', 'outflow'), [200, 0, 0]);
		farmBalances(input, out);
		passes(input, out);
	});
});
