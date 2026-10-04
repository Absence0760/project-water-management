// End-to-end: routing water through the node network (docs/model.md §2.5
// fragmentation, §2.5a land cover, §2.7 the farm balance, the gauges, the
// EWR's accumulation down the network). Small invented networks run through
// the whole model (runModelWith a fixed natural flow, then the self-checks;
// one case through runModel's own GR4J), every expected number worked out by
// hand from the formulas in model.md. Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { DemandObject, LandCoverPatch, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { runModel, runModelWith, withVerification } from '../run';
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

describe('fragmentation and accumulation down the network (§2.5, §2.7)', () => {
	it('a chain A → B → C → G: each unit adds its area share of natural flow and passes the rest on, the gauge sees all of it', () => {
		// Area shares 1 : 2 : 1 of 4 km² = 0.25, 0.5, 0.25.
		const input = build({
			nodes: [gauge(), farm('A', { downstreamNodeId: 'B', areaKm2: 1 }), farm('B', { downstreamNodeId: 'C', areaKm2: 2 }), farm('C', { areaKm2: 1 })],
			days: 4
		});
		const nat = [400, 800, 0, 1200];
		const out = run(input, nat);
		expect(get(out, 'A', 'runoff')).toEqual([100, 200, 0, 300]);
		expect(get(out, 'B', 'runoff')).toEqual([200, 400, 0, 600]);
		expect(get(out, 'C', 'runoff')).toEqual([100, 200, 0, 300]);
		expect(get(out, 'B', 'inflow_upstream')).toEqual([100, 200, 0, 300]);
		expect(get(out, 'C', 'inflow_upstream')).toEqual([300, 600, 0, 900]);
		expect(get(out, 'C', 'outflow')).toEqual([400, 800, 0, 1200]);
		expect(get(out, 'G', 'inflow_upstream')).toEqual(nat);
		expect(get(out, 'G', 'outflow')).toEqual(nat);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a confluence and a unit of zero area: the branches add at the junction, the zero-area unit makes no runoff and passes its inflow', () => {
		//   A ─┐
		//      ├─ J → Z (area 0) → G
		//   B ─┘
		const input = build({
			nodes: [
				gauge(),
				farm('A', { downstreamNodeId: 'J', areaKm2: 3 }),
				farm('B', { downstreamNodeId: 'J', areaKm2: 1 }),
				farm('J', { downstreamNodeId: 'Z', areaKm2: 4 }),
				farm('Z', { areaKm2: 0 })
			],
			days: 3
		});
		const out = run(input, [800, 80, 8]);
		// Shares 3/8, 1/8, 4/8, 0.
		expect(get(out, 'A', 'outflow')).toEqual([300, 30, 3]);
		expect(get(out, 'B', 'outflow')).toEqual([100, 10, 1]);
		expect(get(out, 'J', 'inflow_upstream')).toEqual([400, 40, 4]);
		expect(get(out, 'J', 'outflow')).toEqual([800, 80, 8]);
		expect(get(out, 'Z', 'runoff')).toEqual([0, 0, 0]);
		expect(get(out, 'Z', 'outflow')).toEqual([800, 80, 8]);
		expect(get(out, 'G', 'outflow')).toEqual([800, 80, 8]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('two gauges in series: an inner gauge carries its branch, the outlet the whole catchment', () => {
		// A → G1 → B → G (outlet); G1 is an inner gauge.
		const input = build({
			nodes: [gauge(), farm('A', { downstreamNodeId: 'G1' }), gauge('G1', { downstreamNodeId: 'B', sortOrder: 1 }), farm('B')],
			days: 2
		});
		const out = run(input, [100, 50]);
		expect(get(out, 'G1', 'outflow')).toEqual([50, 25]);
		expect(get(out, 'B', 'inflow_upstream')).toEqual([50, 25]);
		expect(get(out, 'G', 'outflow')).toEqual([100, 50]);
		passes(input, out);
	});

	it('manual shares below 100 %: the missing share never reaches the river, with a warning', () => {
		const input = build({
			nodes: [gauge(), farm('A', { flowShareManual: 0.3, downstreamNodeId: 'B' }), farm('B', { flowShareManual: 0.5 })],
			settings: { flowShareMethod: 'manual' },
			days: 2
		});
		const out = run(input, [1000, 10]);
		expect(get(out, 'A', 'runoff')).toEqual([300, 3]);
		expect(get(out, 'B', 'runoff')).toEqual([500, 5]);
		expect(get(out, 'G', 'outflow')).toEqual([800, 8]);
		expect(out.summary.warnings.some((w) => /sum to 80\.00%/.test(w))).toBe(true);
	});

	it('manual shares above 100 % are refused: water from nowhere', () => {
		const input = build({
			nodes: [gauge(), farm('A', { flowShareManual: 0.7 }), farm('B', { flowShareManual: 0.5 })],
			settings: { flowShareMethod: 'manual' },
			days: 2
		});
		expect(() => run(input, [1, 1])).toThrow(/more than 100%/);
	});

	it('hi/lo shares: hi/Σhi × split.hi + lo/Σlo × split.lo', () => {
		// hi areas 1, 3 (Σ 4); lo areas 2, 2 (Σ 4); split 0.6 / 0.4.
		// A: 0.25 × 0.6 + 0.5 × 0.4 = 0.35; B: 0.75 × 0.6 + 0.5 × 0.4 = 0.65.
		const input = build({
			nodes: [gauge(), farm('A', { areaKm2: 3, areaHiKm2: 1, areaLoKm2: 2 }), farm('B', { areaKm2: 5, areaHiKm2: 3, areaLoKm2: 2 })],
			settings: { flowShareMethod: 'hiLo', hiLoSplit: { hi: 0.6, lo: 0.4 } },
			days: 1
		});
		const out = run(input, [1000]);
		near(get(out, 'A', 'runoff'), [350]);
		near(get(out, 'B', 'runoff'), [650]);
		near(get(out, 'G', 'outflow'), [1000]);
	});

	it('the EWR: Y = pragmatic × share, Z = Y + Σ upstream Z, by water-year month, switching on 1 October', () => {
		// Pragmatic EWR per water-year month (Oct … Sep): Oct 1200, Sep 600, others 0.
		const ewr = flat(0);
		ewr[0] = 1200;
		ewr[11] = 600;
		const input = build({
			nodes: [gauge(), farm('A', { downstreamNodeId: 'B', areaKm2: 1 }), farm('B', { areaKm2: 2 })],
			settings: { ewrPragmaticM3PerDay: ewr as unknown as Monthly },
			start: '2021-09-29',
			days: 4
		});
		// Natural flow 900 / day: A makes 300, B 600; outflow 900.
		const out = run(input, [900, 900, 900, 900]);
		// 29, 30 Sep: 600 × 1/3, 600 × 2/3; 1, 2 Oct: 1200 × …
		near(get(out, 'A', 'ewr'), [200, 200, 400, 400]);
		near(get(out, 'B', 'ewr'), [400, 400, 800, 800]);
		near(get(out, 'B', 'ewr_cumulative'), [600, 600, 1200, 1200]);
		near(get(out, 'G', 'ewr_cumulative'), [600, 600, 1200, 1200]);
		// The outflow 900 meets Sep's 600 and is 300 short of October's 1200.
		near(get(out, 'G', 'ewr_shortfall'), [0, 0, -300, -300]);
		// A: 300 against 400 in October.
		near(get(out, 'A', 'ewr_shortfall'), [0, 0, -100, -100]);
		passes(input, out);
	});
});

describe('the farm balance with a dam (§2.7)', () => {
	it('an on-channel dam takes its upstream and runoff shares, irrigates the town, spills when full; by hand', () => {
		// A (no dam) → B (dam 1000 m³, 50 % full, 100 % of upstream and 50 % of runoff into it) → G.
		// B's town wants 100 m³/day and returns 20 % below the unit.
		const input = build({
			nodes: [gauge(), farm('A', { downstreamNodeId: 'B' }), farm('B', { damCapacityM3: 1000, damInitialPct: 0.5, pctUpstreamToDam: 1, pctRunoffToDam: 0.5 })],
			objects: [town('B', 100, { returnPct: 0.2 })],
			days: 3
		});
		const out = run(input, [600, 2000, 0]);
		// Day 1: H 300, I 300 → K 300, M 150, N 150; avail 500 + 450 = 950; G 100; P 850; Q 850; S 150; T 20; U 170.
		// Day 2: H 1000, I 1000 → K 1000, M 500, N 500; avail 850 + 1500 = 2350; G 100; P 2250; Q 1000; R 1250; U 1250 + 500 + 20 = 1770.
		// Day 3: nothing flows; avail 1000; G 100; Q 900; U 20 (the return).
		expect(get(out, 'B', 'supplied')).toEqual([100, 100, 100]);
		expect(get(out, 'B', 'dam_storage')).toEqual([850, 1000, 900]);
		expect(get(out, 'B', 'spill')).toEqual([0, 1250, 0]);
		expect(get(out, 'B', 'below_dam_not_diverted')).toEqual([150, 500, 0]);
		near(get(out, 'B', 'return_flow'), [20, 20, 20]);
		near(get(out, 'B', 'outflow'), [170, 1770, 20]);
		near(get(out, 'G', 'outflow'), [170, 1770, 20]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('River to dam fills an off-channel dam from the flow below it, up to its capacity', () => {
		// Off-channel dam (nothing routed in), River to dam 250 m³/day.
		const input = build({
			nodes: [gauge(), farm('A', { downstreamNodeId: 'B' }), farm('B', { damCapacityM3: 600, damInitialPct: 0, divertCapacityM3Day: 250 })],
			days: 4
		});
		// H = I = nat / 2; L + N = nat.
		const out = run(input, [1000, 100, 1000, 1000]);
		near(get(out, 'B', 'diverted_to_dam'), [250, 100, 250, 250]);
		// Storage 250, 350, 600; on day 4 the dam is full: O 250 diverted, 250 spills back.
		near(get(out, 'B', 'dam_storage'), [250, 350, 600, 600]);
		near(get(out, 'B', 'spill'), [0, 0, 0, 250]);
		near(get(out, 'B', 'outflow'), [750, 0, 750, 1000]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a dam on the river (100 % upstream into it) ignores River to dam', () => {
		const input = build({
			nodes: [gauge(), farm('A', { downstreamNodeId: 'B' }), farm('B', { damCapacityM3: 10_000, pctUpstreamToDam: 1, divertCapacityM3Day: 300 })],
			days: 1
		});
		const out = run(input, [1000]);
		// K 500 into the dam, N 500 below it, O 0.
		near(get(out, 'B', 'diverted_to_dam'), [0]);
		near(get(out, 'B', 'dam_storage'), [500]);
		near(get(out, 'B', 'outflow'), [500]);
		expect(out.summary.warnings.some((w) => /River to dam isn't used/.test(w))).toBe(true);
	});

	it('dead storage: irrigation draws only above the minimum operating level', () => {
		// Dam 1000, 30 % full, minimum 25 %: 50 m³ above dead storage, no inflow.
		const input = build({
			nodes: [gauge(), farm('B', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 0.3, damMinPct: 0.25 })],
			objects: [town('B', 40)],
			days: 3
		});
		const out = run(input, [0, 0, 0]);
		near(get(out, 'B', 'supplied'), [40, 10, 0]);
		near(get(out, 'B', 'dam_storage'), [260, 250, 250]);
		near(get(out, 'B', 'deficit'), [0, 30, 40]);
		passes(input, out);
	});
});

describe('land-cover reductions (§2.5a)', () => {
	it('reduction = LOW × MIN(I0, q) + MAR × MAX(I0 − q, 0), q = share × the natural flow exceeded 75 % of days', () => {
		// Two units of 2 km² each (share 0.5). On A a patch of 1 km² at 50 % cover (f = 0.25) with its own
		// reductions mar 0.4, lowFlow 0.6: MAR_u 0.1, LOW_u 0.15.
		// Natural flow 100, 200, 300, 400: the 25th percentile is 100 + 0.75 × 100 = 175, so q = 87.5.
		const input = build({
			nodes: [gauge(), farm('A', { areaKm2: 2, downstreamNodeId: 'B' }), farm('B', { areaKm2: 2 })],
			landCover: [{ id: 'p1', nodeId: 'A', coverClass: 'other', areaKm2: 1, densityPct: 0.5, factors: { mar: 0.4, lowFlow: 0.6 } } as LandCoverPatch],
			days: 4
		});
		const out = run(input, [100, 200, 300, 400]);
		// I0 = 50, 100, 150, 200.
		// 0.15 × 50 = 7.5; 0.15 × 87.5 + 0.1 × 12.5 = 14.375; + 0.1 × 62.5 = 19.375; + 0.1 × 112.5 = 24.375.
		near(get(out, 'A', 'landcover_reduction'), [7.5, 14.375, 19.375, 24.375]);
		near(get(out, 'A', 'runoff'), [42.5, 85.625, 130.625, 175.625]);
		// B has none; the catchment loses exactly A's reduction.
		near(get(out, 'B', 'runoff'), [50, 100, 150, 200]);
		near(get(out, 'G', 'outflow'), [92.5, 185.625, 280.625, 375.625]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('patches covering more than the unit are scaled down to it; a patch on a unit without area is skipped with a warning', () => {
		const input = build({
			nodes: [gauge(), farm('A', { areaKm2: 1, downstreamNodeId: 'Z' }), farm('Z', { areaKm2: 0 })],
			landCover: [
				{ id: 'p1', nodeId: 'A', coverClass: 'other', areaKm2: 1, densityPct: 1, factors: { mar: 0.5, lowFlow: 0.5 } } as LandCoverPatch,
				{ id: 'p2', nodeId: 'A', coverClass: 'other', areaKm2: 1, densityPct: 1, factors: { mar: 0.5, lowFlow: 0.5 } } as LandCoverPatch,
				{ id: 'p3', nodeId: 'Z', coverClass: 'other', areaKm2: 1, densityPct: 1, factors: { mar: 0.9, lowFlow: 0.9 } } as LandCoverPatch
			],
			days: 2
		});
		const out = run(input, [100, 100]);
		// Two patches of f = 1 each, scaled to 0.5 each: the unit loses 50 %.
		near(get(out, 'A', 'landcover_reduction'), [50, 50]);
		near(get(out, 'G', 'outflow'), [50, 50]);
		expect(out.summary.warnings.some((w) => /scaled down/.test(w))).toBe(true);
		expect(out.summary.warnings.some((w) => /land cover on "Unit Z" skipped/.test(w))).toBe(true);
		passes(input, out);
	});
});

describe('order independence', () => {
	// A six-unit network with dams, transfers, an off-take and a confluence.
	//   A ─┐            D (dam) ─┐
	//      ├─ C (dam) ──────────┴─ E → G
	//   B ─┘
	const nodes = (): NetworkNode[] => [
		gauge(),
		farm('A', { downstreamNodeId: 'C', areaKm2: 2 }),
		farm('B', { downstreamNodeId: 'C', areaKm2: 1, damCapacityM3: 500, damInitialPct: 0.4, pctRunoffToDam: 1 }),
		farm('C', { downstreamNodeId: 'E', areaKm2: 1.5, damCapacityM3: 2000, damInitialPct: 0.7, pctUpstreamToDam: 0.6, pctRunoffToDam: 0.3, divertCapacityM3Day: 80 }),
		farm('D', { downstreamNodeId: 'E', areaKm2: 0.5, damCapacityM3: 900, damInitialPct: 0.9 }),
		farm('E', { areaKm2: 1, irrigationEfficiency: 0.8, returnFlowFraction: 0.1 })
	];
	const transfers = (): Transfer[] => [
		{ id: 't1', fromNodeId: 'C', toNodeId: 'D', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.002, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 },
		{ id: 't2', fromNodeId: 'D', toNodeId: 'B', months: [1, 2], maxRateM3s: 0.001, dailyCapM3: 70, minStoragePct: 0, enabled: true, priority: 1 },
		{
			id: 't3',
			fromNodeId: 'A',
			toNodeId: 'E',
			months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			maxRateM3s: 0.003,
			dailyCapM3: null,
			minStoragePct: 0,
			enabled: true,
			priority: 0,
			source: 'river',
			sizing: 'demand',
			lossPct: 0.1,
			handsOffM3Day: 20
		}
	];
	const objects = (): DemandObject[] => [town('B', 30), town('C', 120), town('D', 60), town('E', 200, { returnPct: 0.1 })];
	const nat = Array.from({ length: 40 }, (_, t) => [900, 50, 0, 3000, 400][t % 5]! * (1 + (t % 7) / 10));
	const base = () => build({ nodes: nodes(), transfers: transfers(), objects: objects(), days: 40, start: '2021-01-20' });
	const byKey = (out: ModelOutput) => new Map(out.series.map((s) => [`${s.nodeId}/${s.key}`, s.values]));

	it('listing the nodes, transfers and demand objects in another order, with other sort orders, changes no series to the bit', () => {
		const a = run(base(), nat);
		passes(base(), a);
		farmBalances(base(), a);
		const shuffled = base();
		shuffled.model.nodes = [...shuffled.model.nodes].reverse().map((n, k) => ({ ...n, sortOrder: 50 - k }));
		shuffled.model.transfers = [...shuffled.model.transfers].reverse();
		shuffled.model.demandObjects = [...(shuffled.model.demandObjects ?? [])].reverse();
		const b = run(shuffled, nat);
		const ma = byKey(a);
		const mb = byKey(b);
		expect([...mb.keys()].sort()).toEqual([...ma.keys()].sort());
		for (const [k, v] of ma) expect(mb.get(k), k).toEqual(v);
	});

	it('renaming every node id (same network) changes no series beyond float noise', () => {
		const rename = (id: string | null) => (id === null ? null : `n-${'GFEDCBA'.indexOf(id)}-${id.toLowerCase()}`);
		const renamed = base();
		renamed.model.nodes = renamed.model.nodes.map((n) => ({ ...n, id: rename(n.id)!, downstreamNodeId: rename(n.downstreamNodeId) }));
		renamed.model.transfers = renamed.model.transfers.map((tr) => ({ ...tr, fromNodeId: rename(tr.fromNodeId)!, toNodeId: rename(tr.toNodeId)! }));
		renamed.model.demandObjects = (renamed.model.demandObjects ?? []).map((o) => ({ ...o, nodeId: rename(o.nodeId)! }));
		const a = run(base(), nat);
		const b = run(renamed, nat);
		passes(renamed, b);
		const mb = byKey(b);
		for (const s of a.series) {
			const k = `${rename(s.nodeId)}/${s.key}`;
			const v = mb.get(k);
			expect(v, k).toBeDefined();
			s.values.forEach((x, t) => expect(Math.abs(x - v![t]!), `${k} day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(x))));
		}
	});
});

describe('through runModel and its own GR4J', () => {
	it('every unit balances and the outlet carries the natural flow less what the units consumed and stored', () => {
		const days = 120;
		const rain = Array.from({ length: days }, (_, t) => (t % 9 === 0 ? 35 : t % 4 === 0 ? 6 : 0));
		const input: ModelInput = {
			settings: { ewrPragmaticM3PerDay: flat(50) as unknown as Monthly, apanMm: flat(150) as unknown as Monthly, lakeEvapFactor: 0.8 } as ModelInput['settings'],
			model: {
				nodes: [
					gauge(),
					farm('A', { downstreamNodeId: 'C', areaKm2: 4 }),
					farm('B', { downstreamNodeId: 'C', areaKm2: 3, damCapacityM3: 20_000, damInitialPct: 0.5, pctRunoffToDam: 0.8, damAreaFullM2: 8000 }),
					farm('C', { areaKm2: 5, damCapacityM3: 50_000, damInitialPct: 0.3, pctUpstreamToDam: 1, pctRunoffToDam: 1, damAreaFullM2: 15_000 })
				],
				crops: [],
				cropAreas: [],
				transfers: [{ id: 'tb', fromNodeId: 'B', toNodeId: 'A', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.002, dailyCapM3: null, minStoragePct: 0.1, enabled: true, priority: 0 }],
				demandObjects: [town('A', 150), town('C', 400, { returnPct: 0.3 })]
			},
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: rain } }
		};
		const out = withVerification(input, runModel(input));
		passes(input, out);
		farmBalances(input, out);
		// The catchment: Σ natural flow = outlet + Σ (G − T) + Σ E − Σ Pd + Σ ΔQ (no losses elsewhere).
		const nat = get(out, null, 'natural_flow');
		let lhs = 0;
		let rhs = 0;
		for (let t = 0; t < days; t++) {
			lhs += nat[t]!;
			rhs += get(out, 'G', 'outflow')[t]!;
		}
		for (const id of ['A', 'B', 'C']) {
			const n = input.model.nodes.find((x) => x.id === id)!;
			const Q = get(out, id, 'dam_storage');
			rhs += Q[days - 1]! - n.damInitialPct * n.damCapacityM3;
			const s = (k: string) => opt(out, id, k, days).reduce((a, v) => a + v, 0);
			rhs += s('supplied') - s('return_flow') + s('dam_evaporation') - s('rain_on_dam');
		}
		expect(lhs - rhs).toBeCloseTo(0, 4);
	});
});
