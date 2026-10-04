// End-to-end: hands-off flows and River to dam by month (docs/model.md §2.7h),
// the river pump's keep (§2.7e) and river abstractions beside a unit's dam
// with their pools (§2.7j), each worked by hand and run through the whole
// model. Synthetic names and values only.
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


/** Upstream unit A (all the runoff) → B (no area, the unit under test) → G: B's L + N is the natural flow. */
const ab = (b: Partial<NetworkNode>, opts: { objects?: DemandObject[]; days: number; start?: string; settings?: Partial<ProjectSettings> }) =>
	build({ nodes: [gauge(), farm('A', { downstreamNodeId: 'B' }), farm('B', { areaKm2: 0, ...b })], objects: opts.objects ?? [], days: opts.days, ...(opts.start ? { start: opts.start } : {}), ...(opts.settings ? { settings: opts.settings } : {}) });
const offChannel = { damCapacityM3: 100_000, damInitialPct: 0 };
const byWaterYear = (oct: number, sep: number, rest = 0) => {
	const r = flat(rest);
	r[0] = oct;
	r[11] = sep;
	return r;
};

describe('the hands-off flow with a dam: River to dam leaves MIN(L + N, keep) (§2.7h)', () => {
	it('cuts the diversion so the threshold passes, and takes nothing below it', () => {
		const input = ab({ ...offChannel, divertCapacityM3Day: 500, handsOffM3Day: flat(300) }, { days: 4 });
		const out = run(input, [1000, 600, 200, 300]);
		near(get(out, 'B', 'diverted_to_dam'), [500, 300, 0, 0]);
		near(get(out, 'B', 'below_dam_not_diverted'), [500, 300, 200, 300]);
		near(get(out, 'B', 'dam_storage'), [500, 800, 800, 800]);
		near(get(out, 'G', 'outflow'), [500, 300, 200, 300]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('binds exactly at the threshold', () => {
		const out = run(ab({ ...offChannel, divertCapacityM3Day: 500, handsOffM3Day: flat(300) }, { days: 3 }), [300, 300.5, 299.5]);
		near(get(out, 'B', 'diverted_to_dam'), [0, 0.5, 0]);
		near(get(out, 'B', 'outflow'), [300, 300, 299.5]);
	});

	it('switches from September’s to October’s hands-off flow on 1 October', () => {
		const input = ab({ ...offChannel, divertCapacityM3Day: 1000, handsOffM3Day: byWaterYear(800, 300) }, { days: 4, start: '2021-09-29' });
		const out = run(input, [1000, 1000, 1000, 1000]);
		near(get(out, 'B', 'diverted_to_dam'), [700, 700, 200, 200]);
		passes(input, out);
	});

	it('keeps the EWR required at the unit (its Z) with handsOffEwr', () => {
		// Pragmatic EWR 600; A has all the share, so Z at B is 600.
		const input = ab({ ...offChannel, divertCapacityM3Day: 1000, handsOffEwr: true }, { days: 3, settings: { ewrPragmaticM3PerDay: flat(600) as unknown as Monthly } });
		const out = run(input, [1000, 500, 650]);
		near(get(out, 'B', 'ewr_cumulative'), [600, 600, 600]);
		near(get(out, 'B', 'diverted_to_dam'), [400, 0, 50]);
		near(get(out, 'B', 'outflow'), [600, 500, 600]);
		passes(input, out);
	});

	it('never cuts what the on-channel split sends into the dam (K, M)', () => {
		// Half the upstream inflow enters the dam; the hands-off flow of 800 is above what passes, so O = 0 but K stays.
		const input = ab({ ...offChannel, pctUpstreamToDam: 0.5, divertCapacityM3Day: 300, handsOffM3Day: flat(800) }, { days: 1 });
		const out = run(input, [1000]);
		near(get(out, 'B', 'upstream_to_dam'), [500]);
		near(get(out, 'B', 'diverted_to_dam'), [0]);
		near(get(out, 'B', 'outflow'), [500]);
		passes(input, out);
	});
});

describe('River to dam by month (§2.7h)', () => {
	it('replaces the one capacity month by month, switching on 1 October', () => {
		const input = ab({ ...offChannel, divertCapacityM3Day: 999, divertMonthlyM3Day: byWaterYear(400, 100) }, { days: 4, start: '2021-09-29' });
		const out = run(input, [1000, 1000, 1000, 1000]);
		near(get(out, 'B', 'diverted_to_dam'), [100, 100, 400, 400]);
		near(get(out, 'B', 'dam_storage'), [100, 200, 600, 1000]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('a month at 0 diverts nothing (winter-only filling)', () => {
		const out = run(ab({ ...offChannel, divertMonthlyM3Day: byWaterYear(0, 250) }, { days: 3, start: '2021-09-30' }), [1000, 1000, 1000]);
		near(get(out, 'B', 'diverted_to_dam'), [250, 0, 0]);
	});
});

describe('the hands-off flow on a unit without a dam: K, M and O are abstraction (§2.7h)', () => {
	it('model.md’s example: 100 % upstream into the absent dam, hands-off 700, H 1000, demand 2000 → irrigates 300, leaves 700', () => {
		const input = ab({ pctUpstreamToDam: 1, handsOffM3Day: flat(700) }, { objects: [town('B', 2000)], days: 3 });
		const out = run(input, [1000, 500, 700]);
		near(get(out, 'B', 'supplied'), [300, 0, 0]);
		near(get(out, 'B', 'outflow'), [700, 500, 700]);
		farmBalances(input, out);
		passes(input, out);
	});
});

describe('the hands-off flow across a dam’s in-service date (§2.7g, §2.7h)', () => {
	it('before the dam is there K is abstraction and is cut; from its first day only O would be', () => {
		// Half the upstream inflow is routed to the dam, hands-off 700, demand 2000, H 1000.
		const input = ab({ damCapacityM3: 10_000, pctUpstreamToDam: 0.5, handsOffM3Day: flat(700), damInServiceFrom: '2021-01-03' }, { objects: [town('B', 2000)], days: 4 });
		const out = run(input, [1000, 1000, 1000, 1000]);
		// No dam: K cut from 500 to 300, irrigated, 700 passes. With the dam: K 500 into it, drawn the same day.
		near(get(out, 'B', 'upstream_to_dam'), [300, 300, 500, 500]);
		near(get(out, 'B', 'supplied'), [300, 300, 500, 500]);
		near(get(out, 'B', 'outflow'), [700, 700, 500, 500]);
		passes(input, out);
	});
});

describe('the river pump keeps the hands-off flow (§2.7e, §2.7h)', () => {
	it('river first: the pump takes S − keep, the dam the rest of the demand', () => {
		const input = ab({ damCapacityM3: 10_000, damInitialPct: 1, supplyRule: 'riverFirst', pumpCapacityM3Day: 1000, handsOffM3Day: flat(400) }, { objects: [town('B', 800)], days: 2 });
		const out = run(input, [1000, 300]);
		near(get(out, 'B', 'river_abstraction'), [600, 0]);
		near(get(out, 'B', 'supplied'), [800, 800]);
		near(get(out, 'B', 'dam_storage'), [9800, 9000]);
		near(get(out, 'B', 'outflow'), [400, 300]);
		farmBalances(input, out);
		passes(input, out);
	});

	it('run of river: the pump up to its capacity, above the hands-off flow', () => {
		const input = ab({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 250, handsOffM3Day: flat(400) }, { objects: [town('B', 800)], days: 3 });
		const out = run(input, [1000, 500, 300]);
		near(get(out, 'B', 'supplied'), [250, 100, 0]);
		near(get(out, 'B', 'outflow'), [750, 400, 300]);
		passes(input, out);
	});
});

describe('river abstractions beside a unit’s dam (§2.7j)', () => {
	const riverObj = (over: Partial<DemandObject>) => town('A', 0, { id: 'pump1', name: 'River pump', priority: 'shared', waterSource: 'river', ...over });

	it('the dam side first; the river take sees the dam’s spill, up to its pump; the pump-limited demand', () => {
		// A: dam 1000 full, all its runoff into the dam; a town of 100 on the dam, a river take of 200 with a 150 pump.
		const input = build({
			nodes: [gauge(), farm('A', { damCapacityM3: 1000, damInitialPct: 1, pctRunoffToDam: 1 })],
			objects: [town('A', 100), riverObj({ monthlyM3Day: flat(200), riverPumpM3Day: 150 })],
			days: 2
		});
		const out = run(input, [500, 0]);
		// Day 1: avail 1500, the town 100, P 1400, Q 1000, spill 400; the take 150 of the 400 past the dam; U 250.
		near(get(out, 'A', 'spill'), [400, 0]);
		near(get(out, 'A', 'river_take@pump1'), [150, 0]);
		near(get(out, 'A', 'river_pump_limited@pump1'), [50, 0]);
		near(get(out, 'A', 'supplied'), [250, 100]);
		near(get(out, 'A', 'dam_storage'), [1000, 900]);
		near(get(out, 'A', 'outflow'), [250, 0]);
		near(get(out, 'A', 'object_supplied@town-A'), [100, 100]);
		passes(input, out);
	});

	it('a pool: drawn when the river is dry, refilled from the flow above what must pass', () => {
		const input = build({
			nodes: [gauge(), farm('A', {})],
			objects: [riverObj({ monthlyM3Day: flat(200), riverPumpM3Day: null, riverPoolM3: 300 })],
			days: 3
		});
		const out = run(input, [0, 1000, 0]);
		near(get(out, 'A', 'river_take@pump1'), [200, 200, 200]);
		near(get(out, 'A', 'river_pool@pump1'), [100, 300, 100]);
		// Day 2: 200 taken and 200 refilled from the 1000.
		near(get(out, 'A', 'outflow'), [0, 600, 0]);
		passes(input, out);
	});

	it('leaves the unit’s hands-off flow in the river', () => {
		const input = build({
			nodes: [gauge(), farm('A', { handsOffM3Day: flat(300) })],
			objects: [riverObj({ monthlyM3Day: flat(500), riverPumpM3Day: 1000 })],
			days: 3
		});
		const out = run(input, [400, 1000, 200]);
		near(get(out, 'A', 'river_take@pump1'), [100, 500, 0]);
		near(get(out, 'A', 'outflow'), [300, 500, 200]);
		passes(input, out);
	});
});
