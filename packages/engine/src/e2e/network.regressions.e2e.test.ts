// Regression tests for the network routing bugs the engine end-to-end tests found
// (docs/model.md §2.6a, §6 "The ordering rule"; fixed in engine 1.69.0, erratum
// ER-14). The comment above each says what was wrong, where, and why.
// Synthetic names and values only.
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

describe('fixed in 1.69.0: river off-takes of one priority break each other’s hands-off flow (the N6 analogue, §2.6a)', () => {
	// network/simulate.ts, the off-take loop (`freeMax` / `scaleBy`): the rules of one priority at a source
	// are scaled to the flow above the *most permissive* keep among them, while each rule's own keep caps
	// only its own volume. So a sibling with a lower keep (even one taking 1 m³/day) lifts the others'
	// floor: two rules with a 900 m³/day hands-off flow take 100 m³ together on 1 000 m³ alone, but 200 m³
	// (leaving 799 m³, below both their hands-off flows) once a 1 m³/day rule without one sits beside them.
	// A hands-off flow is "left in the river below the source before anything is taken" (§2.6a fields);
	// audit N6 fixed exactly this for dam rules (each rule draws only above its own reserve, engine
	// 1.36.0), but §2.6a still says off-takes share "as dam rules share a dam (Q18)", the pre-N6 rule.
	// Fix: share the source's flow in bands at the rules' keeps, as step 3 of the dam transfers does; and
	// add the N6 invariant to checkTransferLimits' off-take part (rules keeping ≥ k take together at most
	// MAX(0, U₀ − taken by lower priorities − k)), which today passes this run.
	const net = (withTiny: boolean) =>
		build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D1', { areaKm2: 0 }), farm('D2', { areaKm2: 0 }), farm('D3', { areaKm2: 0 })],
			transfers: [
				ot('b1', 'S', 'D1', 100, { handsOffM3Day: 900 }),
				ot('b2', 'S', 'D2', 100, { handsOffM3Day: 900 }),
				...(withTiny ? [ot('a', 'S', 'D3', 1)] : [])
			],
			days: 1
		});

	it('without a sibling: the two hands-off rules share the 100 m³ above 900 (holds today)', () => {
		const input = net(false);
		const out = run(input, [1000]);
		farmBalances(input, out);
		near(get(out, 'S', 'transfer_rule@b1'), [50]);
		near(get(out, 'S', 'transfer_rule@b2'), [50]);
		near(get(out, 'S', 'outflow'), [900]);
	});

	it('a 1 m³/day sibling without a hands-off flow must not let them take more than the 100 m³ above their 900', () => {
		const input = net(true);
		const out = run(input, [1000]);
		farmBalances(input, out);
		const both = get(out, 'S', 'transfer_rule@b1')[0]! + get(out, 'S', 'transfer_rule@b2')[0]!;
		expect(both).toBeLessThanOrEqual(100 + 1e-9);
		// The river below the source keeps 900 less at most the 1 m³ the rule without a hands-off flow may take below it.
		expect(get(out, 'S', 'outflow')[0]!).toBeGreaterThanOrEqual(899 - 1e-9);
	});
});

describe('fixed in 1.69.0: off-take water arriving at a unit is summed in simulation order, not id order (§6 "The ordering rule")', () => {
	// network/simulate.ts: `otIn[o.to] += got` (and `otRet[o.returnAt] += …`, `otInDam[o.to] += got`) runs
	// as each off-take's *source* is simulated, so a unit fed by three or more off-takes from different
	// sources adds their deliveries in the calculation order, which follows sortOrder and the node list
	// (network/topology.ts buildTopology). Floating-point addition is not associative: 0.1 + 0.2 + 0.3
	// gives 0.6000000000000001 in one order and 0.6 in the other. §6 requires every sum that feeds the
	// daily balance to run in id order and every daily series to be identical to the last bit however the
	// nodes are listed (checkOrderInvariance); the fuzz rarely builds three off-takes into one unit.
	// Fix: collect each destination's (and return unit's) contributions per rule and add them in the
	// rules' id order when the destination is simulated (its sources are all simulated before it).
	const net = (reversed: boolean) => {
		const nodes = [
			gauge(),
			farm('S1', { sortOrder: reversed ? 3 : 1 }),
			farm('S2', { sortOrder: 2 }),
			farm('S3', { sortOrder: reversed ? 1 : 3 }),
			farm('D', { areaKm2: 0, sortOrder: 4 })
		];
		return build({
			nodes: reversed ? nodes.reverse() : nodes,
			transfers: [ot('a', 'S1', 'D', 0.1), ot('b', 'S2', 'D', 0.2), ot('c', 'S3', 'D', 0.3)],
			days: 1
		});
	};

	it('offtake_in, and everything below it, is the same to the last bit whatever the listing', () => {
		const a = run(net(false), [300]);
		const b = run(net(true), [300]);
		passes(net(false), a);
		farmBalances(net(false), a);
		farmBalances(net(true), b);
		const mb = new Map(b.series.map((s) => [`${s.nodeId}/${s.key}`, s.values]));
		expect(get(b, 'D', 'offtake_in')).toEqual(get(a, 'D', 'offtake_in'));
		for (const s of a.series) expect(mb.get(`${s.nodeId}/${s.key}`), `${s.nodeId}/${s.key}`).toEqual(s.values);
	});
});
