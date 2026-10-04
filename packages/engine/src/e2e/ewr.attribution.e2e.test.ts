// End-to-end: EWR attribution (docs/model.md §2.7b, §2.7c "EWR attribution"),
// through the whole model on small invented catchments whose every flow is
// worked out by hand. Natural flow is fed directly (runModelWith), as the
// workbook regression test does, so each day's farm runoff is known exactly.
//
//   A (farm, area 1) → U1 (junior user) → G (gauge, EWR site) → B (farm, area 1) → U2 (junior user) → O (outlet gauge)
//
// Users take MIN(demand, flow) and return nothing, so their net impact is what
// they take. Farm runoff = natural × ½ each; pragmatic EWR fragments ½ / ½.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';

const START = '2003-10-01';
const END = '2004-09-30'; // a leap February inside
const DAYS = toEpochDay(END) - toEpochDay(START) + 1;

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const farm = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { downstreamNodeId: down, areaKm2: 1, ...over });
const gauge = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { kind: 'gauge', downstreamNodeId: down, ...over });
const user = (id: string, down: string, demand: number | number[], over: Partial<NetworkNode> = {}) =>
	node(id, {
		kind: 'user',
		downstreamNodeId: down,
		userDemandM3Day: Array.isArray(demand) ? demand : new Array(12).fill(demand),
		userPriority: 'junior',
		userReturnPct: 0,
		...over
	});

function input(nodes: NetworkNode[], ewr: number | number[], settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: {
			ewrPragmaticM3PerDay: (Array.isArray(ewr) ? ewr : new Array(12).fill(ewr)) as never,
			apanMm: new Array(12).fill(0) as never,
			...settings
		},
		model: { nodes, crops: [], cropAreas: [], transfers: [] },
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}

const run = (inp: ModelInput, natural: (t: number) => number) => runModelWith(inp, () => ({ naturalFlowM3Day: Array.from({ length: DAYS }, (_, t) => natural(t)) }));
const ser = (out: ModelOutput, nodeId: string | null, key: string) => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}; have ${out.series.filter((x) => x.nodeId === nodeId).map((x) => x.key).join(', ')}`);
	return s.values;
};
/** The engine's own self-checks (checkEwrAttribution among them) pass on this run. */
const verified = (inp: ModelInput, natural: (t: number) => number = () => 1000) => {
	const v = withVerification(inp, run(inp, natural)).summary.verification!;
	expect(v.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`)).toEqual([]);
	expect(v.checks.some((c) => /EWR/i.test(c.label))).toBe(true);
};
const has = (out: ModelOutput, nodeId: string | null, key: string) => out.series.some((x) => x.nodeId === nodeId && x.key === key);

/** The chain A → U1 → G → B → U2 → O. */
const chain = (d1: number, d2: number, gOver: Partial<NetworkNode> = {}) => [
	farm('A', 'U1'),
	user('U1', 'G', d1),
	gauge('G', 'B', gOver),
	farm('B', 'U2'),
	user('U2', 'O', d2),
	gauge('O', null)
];

describe('EWR attribution on a two-site chain, by hand (§2.7b)', () => {
	// Q = 1000 m³/day natural: A and B each get 500. U1 takes 300, U2 takes 200.
	// Flow at G = 200, at O = 1000 − 300 − 200 = 500.
	it('a shortfall the users caused: each site is charged in full, pro rata to net impact, the max binds', () => {
		// EWR 800: Z_G = 400 (A's half), D_G = 200; Z_O = 800, D_O = 300.
		const out = run(input(chain(300, 200), 800), () => 1000);
		const t = 40;
		expect(ser(out, 'G', 'outflow')[t]).toBeCloseTo(200, 9);
		expect(ser(out, null, 'simulated_outflow')[t]).toBeCloseTo(500, 9);
		expect(ser(out, 'G', 'ewr_cumulative')[t]).toBeCloseTo(400, 9);
		expect(ser(out, null, 'ewr_shortfall')[t]).toBeCloseTo(-300, 9);
		// Site G: E = 300 (U1), D* = 200, natural 0.
		expect(ser(out, 'G', 'ewr_charged')[t]).toBeCloseTo(-200, 9);
		expect(ser(out, 'G', 'ewr_natural')[t]).toBe(0);
		// Outlet: E = 300 + 200 = 500, D* = 300 → U1 180, U2 120.
		expect(ser(out, null, 'ewr_charged')[t]).toBeCloseTo(-300, 9);
		expect(ser(out, null, 'ewr_natural')[t]).toBe(0);
		// U1 is charged max(200 at G, 180 at O) = 200; U2 120.
		expect(ser(out, 'U1', 'ewr_charge')[t]).toBeCloseTo(-200, 9);
		expect(ser(out, 'U2', 'ewr_charge')[t]).toBeCloseTo(-120, 9);
		// Farms without any net impact are never charged.
		expect(ser(out, 'A', 'ewr_charge').every((v) => v === 0)).toBe(true);
		expect(ser(out, 'B', 'ewr_charge').every((v) => v === 0)).toBe(true);
		// Summaries: every day the same, so the means are the day's charge.
		const users = out.summary.users!;
		expect(users.find((u) => u.nodeId === 'U1')!.avgEwrChargeM3Day).toBeCloseTo(200, 9);
		expect(users.find((u) => u.nodeId === 'U1')!.daysEwrNotMet).toBe(DAYS);
		expect(users.find((u) => u.nodeId === 'U2')!.avgEwrChargeM3Day).toBeCloseTo(120, 9);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(DAYS);
		verified(input(chain(300, 200), 800));
	});

	it('a user above two sites carries the larger share; on a tie the larger is still its whole impact', () => {
		// EWR 1200: Z_G = 600, D_G = 400 > E_G = 300 → U1 charged 300 at G (its whole impact), natural 100.
		// Outlet: D = 1200 − 500 = 700 > E = 500 → U1 300, U2 200, natural 200.
		const tie = run(input(chain(300, 200), 1200), () => 1000);
		expect(ser(tie, 'G', 'ewr_charged')[3]).toBeCloseTo(-300, 9);
		expect(ser(tie, 'G', 'ewr_natural')[3]).toBeCloseTo(-100, 9);
		expect(ser(tie, null, 'ewr_charged')[3]).toBeCloseTo(-500, 9);
		expect(ser(tie, null, 'ewr_natural')[3]).toBeCloseTo(-200, 9);
		expect(ser(tie, 'U1', 'ewr_charge')[3]).toBeCloseTo(-300, 9);
		expect(ser(tie, 'U2', 'ewr_charge')[3]).toBeCloseTo(-200, 9);
		// Never more than a unit's own impact.
		for (let t = 0; t < DAYS; t++) expect(-ser(tie, 'U1', 'ewr_charge')[t]!).toBeLessThanOrEqual(300 + 1e-9);
		// The binding series is stored for farms only (§2.7b), not for users.
		expect(has(tie, 'U1', 'ewr_binding_site')).toBe(false);
	});

	it('the binding site of a farm above two sites: the gauge (index 1) when its share is larger, the outlet (0) on a tie', () => {
		// A's dam keeps all its runoff (500/day, e_A = 500); U2 takes 200 below B.
		// EWR 800: G: Z 400, flow 0, D 400 → A 400. Outlet: flow 300, D 500, E 700 → A 500·500/700, U2 500·200/700.
		const nodes = (d2: number) => [farm('A', 'G', { damCapacityM3: 1e9, pctRunoffToDam: 1 }), gauge('G', 'B'), farm('B', 'U2'), user('U2', 'O', d2), gauge('O', null)];
		const out = run(input(nodes(200), 800), () => 1000);
		expect(ser(out, 'A', 'ewr_charge')[7]).toBeCloseTo(-400, 9);
		expect(ser(out, 'U2', 'ewr_charge')[7]).toBeCloseTo(-(500 * 200) / 700, 9);
		expect(ser(out, 'A', 'ewr_binding_site').every((v) => v === 1)).toBe(true);
		// EWR 1000: G: Z 500, D 500 → A 500. Outlet: flow 300, D 700 = E → A 500, U2 200. A ties → the outlet.
		const tie = run(input(nodes(200), 1000), () => 1000);
		expect(ser(tie, 'A', 'ewr_charge')[7]).toBeCloseTo(-500, 9);
		expect(ser(tie, 'U2', 'ewr_charge')[7]).toBeCloseTo(-200, 9);
		expect(ser(tie, 'A', 'ewr_binding_site').every((v) => v === 0)).toBe(true);
		// The curtailment table names the site that set most of A's charged volume.
		const curt = (o: ModelOutput) => o.summary.curtailment!.farms.find((f) => f.nodeId === 'A')!;
		expect(curt(out).ewrBindingSiteId).toBe('G');
		expect(curt(tie).ewrBindingSiteId).toBe('O');
		verified(input(nodes(200), 800));
		verified(input(nodes(200), 1000));
	});

	it('three nested gauges: the binding site is the index in the run’s site list (outlet, then gauges by id), not in river order', () => {
		// A (dam keeps its 250/day) → G3 → B → G1 → C → G2 → D → O; four farms, 250 m³/day of runoff each.
		const nodes = [
			farm('A', 'G3', { damCapacityM3: 1e9, pctRunoffToDam: 1 }),
			gauge('G3', 'B'),
			farm('B', 'G1'),
			gauge('G1', 'C'),
			farm('C', 'G2'),
			gauge('G2', 'D'),
			farm('D', 'O'),
			gauge('O', null)
		];
		// EWR 800 (200 a farm): shortfalls 200 at G3, 150 at G1, 100 at G2, 50 at O, each all A's → A carries 200, set by G3.
		const out = run(input(nodes, 800), () => 1000);
		expect(out.summary.curtailment!.ewrSites!.map((x) => x.nodeId)).toEqual(['O', 'G1', 'G2', 'G3']);
		expect(ser(out, 'G3', 'ewr_charged')[0]).toBeCloseTo(-200, 9);
		expect(ser(out, 'G1', 'ewr_charged')[0]).toBeCloseTo(-150, 9);
		expect(ser(out, 'G2', 'ewr_charged')[0]).toBeCloseTo(-100, 9);
		expect(ser(out, null, 'ewr_charged')[0]).toBeCloseTo(-50, 9);
		expect(ser(out, 'A', 'ewr_charge')[0]).toBeCloseTo(-200, 9);
		expect(ser(out, 'A', 'ewr_binding_site').every((v) => v === 3)).toBe(true);
		// EWR 1200 (300 a farm): every site's shortfall exceeds A's 250 → A's share is 250 at all four → the outlet binds.
		const tie = run(input(nodes, 1200), () => 1000);
		expect(ser(tie, 'A', 'ewr_charge')[0]).toBeCloseTo(-250, 9);
		expect(ser(tie, 'G3', 'ewr_natural')[0]).toBeCloseTo(-50, 9);
		expect(ser(tie, null, 'ewr_natural')[0]).toBeCloseTo(-200, 9);
		expect(ser(tie, 'A', 'ewr_binding_site').every((v) => v === 0)).toBe(true);
		verified(input(nodes, 800));
		verified(input(nodes, 1200));
	});

	it('a farm that supplies a demand from its dam and stores the rest: the charge splits into its consumptive and storage parts (§2.7b, Q13)', () => {
		// A: a dam taking all 500/day of its runoff (outlet farm-only catchment: A → O), a demand object of 300/day
		// returning 20 %. G = 300, T = 60 (joins the outflow), the dam gains 200: U = 60, e = 500 − 60 = 440,
		// c = G − T = 240, o = e − c = 200. EWR 800 → D = 740 > 440 → A = 440, A_irr = 440 × 240 / 440 = 240.
		const nodes = [farm('A', 'O', { areaKm2: 2, damCapacityM3: 1e9, pctRunoffToDam: 1 }), gauge('O', null)];
		const inp = input(nodes, 800);
		inp.model.demandObjects = [
			{ id: 'obj1', nodeId: 'A', name: 'Invented village', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(300), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0.2, priority: 'first', destination: 'internal', enabled: true, note: '' }
		];
		const out = run(inp, () => 500);
		expect(ser(out, 'A', 'supplied')[3]).toBeCloseTo(300, 9);
		expect(ser(out, null, 'simulated_outflow')[3]).toBeCloseTo(60, 9);
		expect(ser(out, 'A', 'ewr_charge')[3]).toBeCloseTo(-440, 9);
		expect(ser(out, 'A', 'ewr_charge_irrigation')[3]).toBeCloseTo(-240, 9);
		expect(ser(out, null, 'ewr_natural')[3]).toBeCloseTo(-300, 9);
		verified(inp, () => 500);
	});

	it('flow exactly at the EWR is met: no shortfall, no charge, no day not met (≥, not >)', () => {
		// Pick the EWR so the outlet is exactly met (flow 500) and G is exactly met (flow 200 = Z_G = ½ EWR... no: ½ × 500 = 250 > 200).
		// So use U1 = 250 → flow at G = 250 = Z_G when EWR = 500; outlet flow = 1000 − 250 − 250 = 500 = EWR.
		const out = run(input(chain(250, 250), 500), () => 1000);
		expect(ser(out, 'G', 'outflow')[5]).toBe(250);
		expect(ser(out, null, 'simulated_outflow')[5]).toBe(500);
		expect(ser(out, null, 'ewr_shortfall').every((v) => v === 0)).toBe(true);
		expect(ser(out, 'G', 'ewr_shortfall').every((v) => v === 0)).toBe(true);
		expect(ser(out, 'U1', 'ewr_charge').every((v) => v === 0)).toBe(true);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		// One more m³ taken: short every day.
		const short = run(input(chain(251, 250), 500), () => 1000);
		expect(short.summary.catchment.ewrDaysNotMet).toBe(DAYS);
		expect(ser(short, null, 'ewr_shortfall')[5]).toBeCloseTo(-1, 9);
		expect(ser(short, 'G', 'ewr_shortfall')[5]).toBeCloseTo(-1, 9);
	});

	it('a drought the users did not cause: the whole shortfall is natural, nobody is charged', () => {
		// No demand at all: E = 0 → N = D at both sites.
		const out = run(input(chain(0, 0), 3000), () => 1000);
		expect(ser(out, null, 'ewr_natural')[0]).toBeCloseTo(-2000, 9);
		expect(ser(out, null, 'ewr_charged')[0]).toBe(0);
		expect(ser(out, 'G', 'ewr_natural')[0]).toBeCloseTo(-1000, 9);
		expect(ser(out, 'U1', 'ewr_charge').every((v) => v === 0)).toBe(true);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(DAYS);
		// The compliance grid: the outlet fails every day; no farm is charged.
		const g = out.summary.ewrCompliance!;
		const notMet = g.outlet.daysNotMet.flat().reduce((a, b) => a + b, 0);
		expect(notMet).toBe(DAYS);
		for (const f of g.farms) expect(f.daysNotMet.flat().every((v) => v === 0)).toBe(true);
	});

	it('a site with zero EWR never fails and charges nobody, whatever is taken', () => {
		const out = run(input(chain(500, 500), 0), () => 1000);
		expect(ser(out, null, 'simulated_outflow')[0]).toBe(0);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		expect(ser(out, 'U1', 'ewr_charge').every((v) => v === 0)).toBe(true);
		expect(ser(out, 'U2', 'ewr_charge').every((v) => v === 0)).toBe(true);
		// No-flow days: outflow 0 < 86.4 m³/day every day.
		expect(out.summary.catchment.noFlow).toEqual({ thresholdM3Day: 86.4, days: DAYS, longestRun: DAYS });
	});

	it('a gauge taken off the EWR sites charges nobody: U1 then carries only its outlet share', () => {
		const out = run(input(chain(300, 200, { ewrSite: false }), 800), () => 1000);
		expect(has(out, 'G', 'ewr_charged')).toBe(false);
		expect(ser(out, 'U1', 'ewr_charge')[9]).toBeCloseTo(-180, 9);
		expect(ser(out, 'U2', 'ewr_charge')[9]).toBeCloseTo(-120, 9);
		// One site only above U1 now: no binding series.
		expect(has(out, 'U1', 'ewr_binding_site')).toBe(false);
		expect(out.summary.curtailment!.ewrSites!.map((s) => s.nodeId)).toEqual(['O']);
	});

	it('a dam storing its farm’s runoff is a net impact (storage gain), charged as a storage condition', () => {
		// A has a 1e9 m³ dam taking all its runoff (500/day, never full): A's outflow is 0 and e_A = 500.
		// No users. G: Z = 400, flow 0 → D = 400 ≤ 500 → A charged 400. Outlet: flow = B's 500; D = 300; E = 500 (A only) → A 300.
		// A's charge = max(400, 300) = 400, all storage (no irrigation).
		const nodes = [farm('A', 'G', { damCapacityM3: 1e9, pctRunoffToDam: 1 }), gauge('G', 'B'), farm('B', 'O'), gauge('O', null)];
		const out = run(input(nodes, 800), () => 1000);
		expect(ser(out, 'G', 'outflow')[10]).toBeCloseTo(0, 9);
		expect(ser(out, 'A', 'ewr_charge')[10]).toBeCloseTo(-400, 9);
		expect(ser(out, 'A', 'ewr_charge_irrigation')[10]).toBe(0);
		expect(ser(out, null, 'ewr_charged')[10]).toBeCloseTo(-300, 9);
		expect(ser(out, 'B', 'ewr_charge').every((v) => v === 0)).toBe(true);
		// The farm grid of the compliance pivot follows A's charge: every day, 400 m³ a day.
		const g = out.summary.ewrCompliance!;
		const a = g.farms.find((f) => f.nodeId === 'A')!;
		expect(a.daysNotMet.flat().reduce((x, y) => x + y, 0)).toBe(DAYS);
		expect(a.shortfallM3.flat().reduce((x, y) => x + y, 0)).toBeCloseTo(400 * DAYS, 6);
		// February 2004 (leap): 29 days.
		expect(g.days[0]![4]).toBe(29);
		expect(a.daysNotMet[0]![4]).toBe(29);
		expect(a.shortfallM3[0]![4]).toBeCloseTo(400 * 29, 6);
		const fs = out.summary.farms.find((f) => f.nodeId === 'A')!;
		expect(fs.daysEwrNotMet).toBe(DAYS);
		expect(fs.avgEwrShortfallM3Day).toBeCloseTo(400, 9);
		verified(input(nodes, 800));
	});

	it('two branches: a user on one branch is never charged for a site on the other', () => {
		//   A → U1 → G1 ┐
		//               O
		//   B → U2 → G2 ┘
		// A and B each 500; U1 takes 400 (G1 = 100), U2 takes 0 (G2 = 500).
		// EWR 600 → Z_G1 = Z_G2 = 300: G1 short 200, G2 met. Outlet 600 vs 600: met.
		const nodes = [farm('A', 'U1'), user('U1', 'G1', 400), gauge('G1', 'O'), farm('B', 'U2'), user('U2', 'G2', 0), gauge('G2', 'O'), gauge('O', null)];
		const out = run(input(nodes, 600), () => 1000);
		expect(ser(out, null, 'simulated_outflow')[0]).toBeCloseTo(600, 9);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		expect(ser(out, 'G1', 'ewr_charged')[0]).toBeCloseTo(-200, 9);
		expect(ser(out, 'G2', 'ewr_charged')[0]).toBe(0);
		expect(ser(out, 'U1', 'ewr_charge')[0]).toBeCloseTo(-200, 9);
		expect(ser(out, 'U2', 'ewr_charge').every((v) => v === 0)).toBe(true);
		// Sites listed outlet first, then gauges by id.
		expect(out.summary.curtailment!.ewrSites!.map((s) => s.nodeId)).toEqual(['O', 'G1', 'G2']);
		// Served in full while a site fails: U1 is served every day G1 fails; U2 has no demand so isn't listed.
		const served = out.summary.servedWhileEwrFails!;
		expect(served.map((s) => [s.nodeId, s.daysNotMet])).toEqual([
			[null, 0],
			['G1', DAYS],
			['G2', 0]
		]);
		expect(served[1]!.units).toEqual([{ nodeId: 'U1', name: 'U1', kind: 'user', days: DAYS }]);
		expect(served[2]!.units).toEqual([]);
	});

	it('a user served only in part is not "served in full" on a failing day', () => {
		// U1 wants 600 but A gives 500: G = 0 vs Z 400. Not served in full on any day.
		const out = run(input(chain(600, 0), 800), () => 1000);
		const atG = out.summary.servedWhileEwrFails!.find((s) => s.nodeId === 'G')!;
		expect(atG.daysNotMet).toBe(DAYS);
		expect(atG.units).toEqual([{ nodeId: 'U1', name: 'U1', kind: 'user', days: 0 }]);
	});

	it('a river off-take from above a gauge to below it: charged at the gauge as an export, not at the outlet (J_int)', () => {
		// A → G → B → O; an off-take takes 300 m³/day from the flow leaving A and delivers it to B.
		// G: flow 200 vs Z 400 → D 200, e_A = H + I − U = 300 (the export counts) → A charged 200.
		// O: flow 1000 ≥ 800, and inside O's catchment the off-take is internal (e_A = e_B = 0).
		const nodes = [farm('A', 'G'), gauge('G', 'B'), farm('B', 'O'), gauge('O', null)];
		const inp = input(nodes, 800);
		inp.model.transfers = [
			{ id: 't1', fromNodeId: 'A', toNodeId: 'B', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 300 / 86_400, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 1, source: 'river', sizing: 'capacity' } as never
		];
		const out = run(inp, () => 1000);
		expect(ser(out, 'G', 'outflow')[5]).toBeCloseTo(200, 6);
		expect(ser(out, null, 'simulated_outflow')[5]).toBeCloseTo(1000, 6);
		expect(ser(out, 'G', 'ewr_charged')[5]).toBeCloseTo(-200, 6);
		expect(ser(out, 'A', 'ewr_charge')[5]).toBeCloseTo(-200, 6);
		expect(ser(out, 'B', 'ewr_charge').every((v) => v === 0)).toBe(true);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		verified(inp);
	});

	it('a user’s net impact is what it takes less what it returns', () => {
		// A → U (takes 400, returns 25 %: net 300) → O. EWR 900: flow 1000 − 300 = 700 → D 200 → U charged 200.
		// EWR 1200: D 500 > 300 → U charged 300 (its net impact), 200 natural.
		const nodes = [farm('A', 'U'), user('U', 'O', 400, { userReturnPct: 0.25 }), gauge('O', null)];
		const a = run(input(nodes, 900), () => 1000);
		expect(ser(a, null, 'simulated_outflow')[0]).toBeCloseTo(700, 9);
		expect(ser(a, 'U', 'ewr_charge')[0]).toBeCloseTo(-200, 9);
		const b = run(input(nodes, 1200), () => 1000);
		expect(ser(b, 'U', 'ewr_charge')[0]).toBeCloseTo(-300, 9);
		expect(ser(b, null, 'ewr_natural')[0]).toBeCloseTo(-200, 9);
		verified(input(nodes, 1200));
	});

	it('float noise against the EWR counts as met; a real shortfall, however small, does not', () => {
		const nodes = [farm('A', 'O'), gauge('O', null)];
		// 1e-10 m³ on 1000 is 1e-13 relative: below SHORTFALL_NOISE (1e-12), met.
		expect(run(input(nodes, 1000 + 1e-10), () => 1000).summary.catchment.ewrDaysNotMet).toBe(0);
		// 1e-6 m³ is 1e-9 relative: a shortfall every day.
		expect(run(input(nodes, 1000 + 1e-6), () => 1000).summary.catchment.ewrDaysNotMet).toBe(DAYS);
	});

	it('the EWR sites table: days not met and the window means of shortfall, charged and natural', () => {
		const out = run(input(chain(300, 200), 1200), () => 1000);
		const sites = out.summary.curtailment!.ewrSites!;
		const o = sites.find((s) => s.isOutlet)!;
		const g = sites.find((s) => s.nodeId === 'G')!;
		expect(o).toMatchObject({ nodeId: 'O', farmCount: 4, daysNotMet: DAYS });
		expect(Math.abs(o.shortfallM3Day)).toBeCloseTo(700, 9);
		expect(Math.abs(o.chargedM3Day)).toBeCloseTo(500, 9);
		expect(Math.abs(o.naturalM3Day)).toBeCloseTo(200, 9);
		// G: A and U1 upstream (users count as units, §2.7c).
		expect(g).toMatchObject({ farmCount: 2, daysNotMet: DAYS });
		expect(Math.abs(g.chargedM3Day)).toBeCloseTo(300, 9);
		expect(Math.abs(g.naturalM3Day)).toBeCloseTo(100, 9);
	});

	it('the shortfall splits pro rata on a day-by-day varying flow, and Σ charged + natural = shortfall at each site', () => {
		const natural = (t: number) => 600 + 500 * Math.sin(t / 9);
		const inp = input(chain(150, 220), [700, 700, 900, 900, 900, 400, 400, 400, 400, 300, 300, 500]);
		const out = run(inp, natural);
		const sh = ser(out, null, 'ewr_shortfall');
		const ch = ser(out, null, 'ewr_charged');
		const na = ser(out, null, 'ewr_natural');
		const shG = ser(out, 'G', 'ewr_shortfall');
		const chG = ser(out, 'G', 'ewr_charged');
		const naG = ser(out, 'G', 'ewr_natural');
		const c1 = ser(out, 'U1', 'ewr_charge');
		const c2 = ser(out, 'U2', 'ewr_charge');
		const g1 = ser(out, 'U1', 'supplied');
		const g2 = ser(out, 'U2', 'supplied');
		let shortDays = 0;
		for (let t = 0; t < DAYS; t++) {
			expect(ch[t]! + na[t]!).toBeCloseTo(sh[t]!, 6);
			expect(chG[t]! + naG[t]!).toBeCloseTo(shG[t]!, 6);
			// By hand: outlet D* = MIN(D, g1 + g2), split g1 : g2.
			const D = -sh[t]!;
			const E = g1[t]! + g2[t]!;
			const Ds = Math.min(D, E);
			const aO1 = E > 0 ? (Ds * g1[t]!) / E : 0;
			const aO2 = E > 0 ? (Ds * g2[t]!) / E : 0;
			const aG1 = Math.min(-shG[t]!, g1[t]!);
			expect(-c1[t]!).toBeCloseTo(Math.max(aO1, aG1), 6);
			expect(-c2[t]!).toBeCloseTo(aO2, 6);
			if (D > 0) shortDays++;
		}
		expect(shortDays).toBeGreaterThan(30);
		expect(shortDays).toBeLessThan(DAYS);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(shortDays);
		verified(inp, natural);
	});
});
