// End-to-end: who gets the water at a unit — other water users (§2.7c),
// boreholes and stream depletion (§2.7d), supply rules and the river pump
// (§2.7e) — run through the whole model on 1–4 node synthetic catchments
// with a fixed natural flow, each day checked against values worked by hand
// from docs/model.md. Invented names and values only.
import { describe, expect, it } from 'vitest';
import type { Borehole, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
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

const flat = (v: number) => new Array(12).fill(v) as number[];
const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
/** Crop area (crop factor 1) whose gross demand is `need` m³/day in water-year month `m` (default January). */
const areaFor = (need: number, m = 3) => {
	const days = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30][m]!;
	return (need * days * 1000) / APAN[m]!;
};

interface Spec {
	nodes: NetworkNode[];
	days: number;
	start?: string;
	settings?: ModelInput['settings'];
	areas?: Record<string, number>;
	boreholes?: Borehole[];
}

function input(s: Spec): ModelInput {
	return {
		settings: { apanMm: APAN as never, effectiveRainFraction: 0, lakeEvapFactor: 0, ewrPragmaticM3PerDay: flat(0) as never, ...(s.settings ?? {}) },
		model: {
			nodes: s.nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: Object.entries(s.areas ?? {}).map(([nodeId, areaM2]) => ({ nodeId, cropId: 'c', areaM2 })),
			transfers: [],
			...(s.boreholes ? { boreholes: s.boreholes } : {})
		},
		series: { rain_catchment_mm: { startDate: s.start ?? '2021-01-01', values: new Array(s.days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ModelOutput, id: string | null, key: string): number[] => {
	const s = o.series.find((x) => x.nodeId === id && x.key === key);
	if (!s) throw new Error(`no series ${id}/${key}; have ${o.series.filter((x) => x.nodeId === id).map((x) => x.key).join(', ')}`);
	return s.values;
};
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const checksPass = (o: ModelOutput) => expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
const closeAll = (got: number[], want: number[], what: string, digits = 6) => {
	expect(got.length, what).toBe(want.length);
	want.forEach((v, t) => expect(got[t], `${what} day ${t}`).toBeCloseTo(v, digits));
};
const bh = (over: Partial<Borehole> & Pick<Borehole, 'id' | 'nodeId'>): Borehole => ({
	name: over.id,
	capacityM3Day: 0,
	annualCapM3: null,
	mode: 'supplemental',
	emergencyBelowPct: 0.3,
	target: 'direct',
	depletionFactor: 0,
	...over
});

describe('other water users (§2.7c)', () => {
	it('a senior user below a dam that would catch everything: the farm passes MIN(Zs, H + I) first, the user takes it, returns r × G', () => {
		const nodes = [
			node('G', 'gauge', null),
			node('T', 'user', 'G', { userDemandM3Day: flat(500), userPriority: 'senior', userReturnPct: 0.2 }),
			node('A', 'farm', 'T', { damCapacityM3: 1e6 })
		];
		const o = run(input({ nodes, days: 3 }), [800, 300, 500]);
		// Zs at A = 500 × share_A / Σ shares upstream of T = 500.
		closeAll(col(o, 'A', 'senior_requirement'), [500, 500, 500], 'Zs');
		closeAll(col(o, 'A', 'dam_storage'), [300, 300, 300], 'A storage');
		closeAll(col(o, 'A', 'outflow'), [500, 300, 500], 'A outflow');
		closeAll(col(o, 'T', 'supplied'), [500, 300, 500], 'T supplied');
		closeAll(col(o, 'T', 'deficit'), [0, 200, 0], 'T deficit');
		closeAll(col(o, 'T', 'return_flow'), [100, 60, 100], 'T return');
		closeAll(col(o, 'T', 'outflow'), [100, 60, 100], 'T outflow');
		// Below a senior user its own claim is gone from the requirement.
		closeAll(col(o, 'T', 'senior_requirement'), [0, 0, 0], 'Zs below T');
		const u = o.summary.users!.find((x) => x.nodeId === 'T')!;
		expect(u.avgSuppliedM3Day).toBeCloseTo(1300 / 3, 9);
		expect(u.fractionSupplied).toBeCloseTo(1300 / 1500, 12);
		expect(u.avgReturnedM3Day).toBeCloseTo(260 / 3, 9);
		checksPass(o);
	});

	it('a junior user above a senior one leaves the senior requirement in the river', () => {
		const nodes = [
			node('G', 'gauge', null),
			node('S', 'user', 'G', { userDemandM3Day: flat(500), userPriority: 'senior' }),
			node('J', 'user', 'S', { userDemandM3Day: flat(400), userPriority: 'junior' }),
			node('A', 'farm', 'J', { pctUpstreamToDam: 0, pctRunoffToDam: 0 })
		];
		const o = run(input({ nodes, days: 3 }), [700, 1000, 300]);
		closeAll(col(o, 'J', 'supplied'), [200, 400, 0], 'junior');
		closeAll(col(o, 'S', 'supplied'), [500, 500, 300], 'senior');
		closeAll(col(o, 'S', 'outflow'), [0, 100, 0], 'below S');
		checksPass(o);
	});

	it('a user’s river pump caps what it takes, and a senior user claims only what its pump can lift', () => {
		const nodes = [
			node('G', 'gauge', null),
			node('T', 'user', 'G', { userDemandM3Day: flat(500), userPriority: 'senior', pumpCapacityM3Day: 200 }),
			node('A', 'farm', 'T', { damCapacityM3: 1e6 })
		];
		const o = run(input({ nodes, days: 2 }), [800, 100]);
		closeAll(col(o, 'A', 'senior_requirement'), [200, 200], 'Zs = MIN(D, P)');
		closeAll(col(o, 'A', 'outflow'), [200, 100], 'A passes the capped claim');
		closeAll(col(o, 'T', 'supplied'), [200, 100], 'T supplied');
		closeAll(col(o, 'T', 'pump_limited'), [0, 0], 'pump limited');
		checksPass(o);
	});
});

describe('boreholes and stream depletion (§2.7d)', () => {
	it('supplemental pumping with same-day depletion: owed while the reach is dry, repaid from the first flow back', () => {
		// No dam and nothing routed to one: groundwater is A's only source. Its runoff passes below it.
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { pctUpstreamToDam: 0, pctRunoffToDam: 0, boreholeCapacityM3Day: 300, boreholeRule: 'supplemental', streamDepletionFrac: 0.5, streamDepletionLagDays: 0 })];
		const o = run(input({ nodes, days: 6, areas: { A: areaFor(500) } }), [0, 0, 0, 1000, 100, 1000]);
		closeAll(col(o, 'A', 'groundwater_used'), new Array(6).fill(300), 'GW');
		closeAll(col(o, 'A', 'supplied'), new Array(6).fill(300), 'G');
		closeAll(col(o, 'A', 'deficit'), new Array(6).fill(200), 'deficit');
		// due = 150 a day. Owed: 150, 300, 450; day 3 owes 600 and the river has 1000.
		closeAll(col(o, 'A', 'baseflow_depletion'), [0, 0, 0, 600, 100, 200], 'depletion taken');
		closeAll(col(o, 'A', 'depletion_deficit'), [150, 300, 450, 0, 50, 0], 'deficit owed');
		closeAll(col(o, 'A', 'outflow'), [0, 0, 0, 400, 0, 800], 'outflow');
		checksPass(o);
	});

	it('a lagged depletion (k = 2 days) follows the linear reservoir, and the volume is conserved', () => {
		const days = 12;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { pctUpstreamToDam: 0, pctRunoffToDam: 0, streamDepletionLagDays: 2 })];
		// 300 m³/day until its 900 m³ annual cap stops it on day 3.
		const boreholes = [bh({ id: 'b1', nodeId: 'A', capacityM3Day: 300, annualCapM3: 900, depletionFactor: 0.8 })];
		const o = run(input({ nodes, days, areas: { A: areaFor(1000) }, boreholes }), new Array(days).fill(10_000));
		const alpha = 1 - Math.exp(-1 / 2);
		const gw = [300, 300, 300, ...new Array(days - 3).fill(0)];
		closeAll(col(o, 'A', 'groundwater_used'), gw, 'GW');
		let store = 0;
		const due: number[] = [];
		const st: number[] = [];
		for (let t = 0; t < days; t++) {
			store += 0.8 * gw[t]!;
			const d = alpha * store;
			store -= d;
			due.push(d);
			st.push(store);
		}
		closeAll(col(o, 'A', 'baseflow_depletion'), due, 'depletion');
		closeAll(col(o, 'A', 'depletion_store'), st, 'store');
		closeAll(col(o, 'A', 'outflow'), due.map((d) => 10_000 - d), 'outflow');
		expect(sum(due) + st.at(-1)!).toBeCloseTo(0.8 * 900, 6);
		const f = o.summary.farms.find((x) => x.nodeId === 'A')!;
		expect(f.avgGroundwaterM3Day).toBeCloseTo(900 / days, 9);
		expect(f.avgBaseflowDepletionM3Day).toBeCloseTo(mean(due), 9);
		checksPass(o);
	});

	it('an annual cap resets on 1 October: a run from 28 September pumps 100, 100, 50, then a fresh 250 from October', () => {
		const days = 7;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { pctUpstreamToDam: 0, pctRunoffToDam: 0 })];
		const boreholes = [bh({ id: 'b1', nodeId: 'A', capacityM3Day: 100, annualCapM3: 250 })];
		// Demand > 100 both sides of the boundary (September and October).
		const o = run(input({ nodes, days, start: '2021-09-28', areas: { A: Math.max(areaFor(500, 11), areaFor(500, 0)) }, boreholes }), new Array(days).fill(0));
		closeAll(col(o, 'A', 'groundwater_used'), [100, 100, 50, 100, 100, 50, 0], 'GW');
		const annual = o.summary.groundwaterAnnualUse!.filter((x) => x.nodeId === 'A');
		expect(annual.map((y) => [y.waterYear, y.days, y.abstractionM3])).toEqual([
			[2020, 3, 250],
			[2021, 4, 250]
		]);
		checksPass(o);
	});

	it('primary boreholes pump first and the dam covers the rest', () => {
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 1, boreholeCapacityM3Day: 200, boreholeRule: 'primary' })];
		const o = run(input({ nodes, days: 3, areas: { A: areaFor(500) } }), [0, 0, 0]);
		closeAll(col(o, 'A', 'groundwater_used'), [200, 200, 200], 'GW');
		closeAll(col(o, 'A', 'dam_storage'), [9700, 9400, 9100], 'storage');
		closeAll(col(o, 'A', 'supplied'), [500, 500, 500], 'G');
	});

	it('the drought rule pumps only while yesterday’s storage is strictly below the trigger', () => {
		const at = (init: number) =>
			run(
				input({
					nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: init, damMinPct: 0.25, boreholeCapacityM3Day: 400, boreholeRule: 'drought', boreholeTriggerPct: 0.3 })],
					days: 3,
					areas: { A: areaFor(1000) }
				}),
				[0, 0, 0]
			);
		// 3500 ≥ 3000: the dam gives 1000 (down to dead storage 2500); then 2500 < 3000: boreholes.
		const a = at(0.35);
		closeAll(col(a, 'A', 'groundwater_used'), [0, 400, 400], 'GW from 35 %');
		// Exactly at the trigger (3000): not below it, so day 0 is the dam's 500 above dead storage alone.
		const b = at(0.3);
		closeAll(col(b, 'A', 'groundwater_used'), [0, 400, 400], 'GW from 30 %');
		closeAll(col(b, 'A', 'supplied'), [500, 400, 400], 'G from 30 %');
	});
});

describe('supply rules and the river pump (§2.7e)', () => {
	it('river first: the pump takes the flow below the dam up to its capacity, the dam covers the rest', () => {
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 1, pctRunoffToDam: 0, supplyRule: 'riverFirst', pumpCapacityM3Day: 300 })];
		const o = run(input({ nodes, days: 3, areas: { A: areaFor(500) } }), [1000, 100, 0]);
		closeAll(col(o, 'A', 'river_abstraction'), [300, 100, 0], 'Gr');
		closeAll(col(o, 'A', 'dam_storage'), [9800, 9400, 8900], 'storage');
		closeAll(col(o, 'A', 'outflow'), [700, 0, 0], 'outflow');
		closeAll(col(o, 'A', 'supplied'), [500, 500, 500], 'G');
		expect(o.summary.farms[0]!.avgRiverAbstractionM3Day).toBeCloseTo(400 / 3, 9);
		checksPass(o);
	});

	it('run of river: no dam, everything below it, the pump takes up to its capacity, the rest is a deficit', () => {
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { supplyRule: 'runOfRiver', pumpCapacityM3Day: 300, divertCapacityM3Day: 999 })];
		const o = run(input({ nodes, days: 3, areas: { A: areaFor(500) } }), [1000, 200, 0]);
		closeAll(col(o, 'A', 'river_abstraction'), [300, 200, 0], 'Gr');
		closeAll(col(o, 'A', 'deficit'), [200, 300, 500], 'deficit');
		closeAll(col(o, 'A', 'outflow'), [700, 0, 0], 'outflow');
		checksPass(o);
	});

	it('trigger: to the river below the trigger level, back to the dam only at the stop level (start-of-day storage)', () => {
		const nodes = [
			node('G', 'gauge', null),
			node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, supplyRule: 'trigger', supplyTriggerPct: 0.4, supplyStopPct: 0.6, pumpCapacityM3Day: 2000 })
		];
		const days = 9;
		const o = run(input({ nodes, days, areas: { A: areaFor(4000) } }), new Array(days).fill(5000));
		closeAll(col(o, 'A', 'river_abstraction'), [0, 2000, 2000, 2000, 2000, 2000, 0, 0, 2000], 'Gr');
		closeAll(col(o, 'A', 'dam_storage'), [3500, 4000, 4500, 5000, 5500, 6000, 4500, 3000, 3500], 'storage');
		checksPass(o);
	});
});
