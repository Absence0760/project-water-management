// The applicant's view of an application run's results (applicantResults.ts,
// WP-3.3, D2's recommended default pending the client): EWR sites, the
// catchment under the k rule, their own units, other units downstream only
// as an anonymous name and a rounded percentage, what ran on their units by
// the ids they gave; and nothing but EWR months when an op was a baseline
// assumption. Each "hidden" has its positive control.
import { applyScenario, type ModelInput, type NetworkNode, type RunSummary, type ScenarioOp } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applicationMask } from './applicant.js';
import { downstreamOf, projectResultsForApplicant, type ApplicantResultsInput } from './applicantResults.js';

const monthly = (v: number) => new Array(12).fill(v);
const node = (id: string, name: string, kind: NetworkNode['kind'], downstreamNodeId: string | null, sortOrder: number, extra: Partial<NetworkNode> = {}) =>
	({
		id,
		name,
		kind,
		downstreamNodeId,
		sortOrder,
		areaKm2: 12,
		areaHiKm2: 1,
		areaLoKm2: 1,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0.5,
		damCapacityM3: 80_000,
		damInitialPct: 0.5,
		damMinPct: 0.1,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0.1,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		userDemandM3Day: null,
		userPriority: 'senior',
		...extra
	}) as NetworkNode;

// Gauge ← Waterval (hidden) ← Rooikloof (theirs); Gauge ← Bergvliet (hidden, a side branch); Gauge ← Town (hidden user) ← Doornhoek (hidden).
const G = '00000000-0000-4000-8000-000000000001';
const MINE = '00000000-0000-4000-8000-000000000002';
const BELOW = '00000000-0000-4000-8000-000000000003';
const SIDE = '00000000-0000-4000-8000-000000000004';
const TOWN = '00000000-0000-4000-8000-000000000005';
const NEW = '00000000-0000-4000-8000-000000000006';
const CITRUS = '00000000-0000-4000-8000-0000000000c1';
const LUCERNE = '00000000-0000-4000-8000-0000000000c2';
const HIDDEN_NAMES = ['Waterval', 'Bergvliet', 'Town', 'Lucerne', 'Neighbour hole'];

const base: ModelInput = {
	settings: { apanMm: monthly(150) } as unknown as ModelInput['settings'],
	model: {
		nodes: [
			node(G, 'Gauge', 'gauge', null, 0),
			node(MINE, 'Rooikloof', 'farm', BELOW, 1),
			node(BELOW, 'Waterval', 'farm', G, 2),
			node(SIDE, 'Bergvliet', 'farm', G, 3),
			node(TOWN, 'Town', 'user', G, 4, { userDemandM3Day: monthly(500) })
		],
		crops: [
			{ id: CITRUS, name: 'Citrus', cropFactor: monthly(0.7) },
			{ id: LUCERNE, name: 'Lucerne', cropFactor: monthly(0.9) }
		],
		cropAreas: [
			{ nodeId: MINE, cropId: CITRUS, areaM2: 50_000 },
			{ nodeId: BELOW, cropId: LUCERNE, areaM2: 30_000 }
		],
		transfers: [],
		boreholes: [{ id: 'b2', nodeId: BELOW, name: 'Neighbour hole', capacityM3Day: 90, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }],
		demandObjects: [
			{ id: 'd2', nodeId: BELOW, name: 'Neighbour village', category: 'municipal', sizing: 'monthly', monthlyM3Day: monthly(300), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0.5, priority: 'first', destination: 'internal', enabled: true, note: '' }
		]
	},
	series: {}
} as unknown as ModelInput;

const farm = (nodeId: string, name: string, supplied: number, extra: Record<string, unknown> = {}) => ({
	nodeId,
	name,
	avgDemandM3Day: 100,
	avgSuppliedM3Day: supplied,
	avgDeficitM3Day: 100 - supplied,
	fractionSupplied: supplied / 100,
	avgEwrShortfallM3Day: 3,
	daysEwrNotMet: 4,
	damEndM3: 40_000,
	damLowM3: 10_000,
	...extra
});
const site = (nodeId: string | null, name: string, met: number, deficitM3: number) => ({
	nodeId,
	name,
	isOutlet: nodeId === null,
	overall: { months: 24, met, rate: met / 24, deficitM3, longestNotMetRun: 24 - met, meanShortfallPct: null }
});
const summary = (s: { mine: number; below: number; side: number; town: number; outflow: number; met: number }) =>
	({
		farms: [farm(MINE, 'Rooikloof', s.mine), farm(BELOW, 'Waterval', s.below), farm(SIDE, 'Bergvliet', s.side)],
		users: [{ nodeId: TOWN, name: 'Town', priority: 'senior', avgDemandM3Day: 500, avgSuppliedM3Day: s.town, avgDeficitM3Day: 0, fractionSupplied: 1, avgReturnedM3Day: 0, avgEwrChargeM3Day: 0, daysEwrNotMet: 0 }],
		catchment: { meanNaturalFlowM3Day: 9_000, meanSimulatedOutflowM3Day: s.outflow, ewrDaysNotMet: 24 - s.met, ewrFractionDaysNotMet: (24 - s.met) / 24 },
		calibration: null,
		ewrAssurance: [site(null, 'Waterval outlet', s.met, 1_234), site(G, 'Gauge', s.met, 567)]
	}) as unknown as RunSummary;

const baseSummary = summary({ mine: 80, below: 50, side: 70, town: 500, outflow: 6_000, met: 20 });

/** The application's ops applied as the run applied them (the applicant's namespace), and its summary. */
function scenario(ops: ScenarioOp[], runSummary: RunSummary, extra: Partial<ApplicantResultsInput> = {}): ApplicantResultsInput {
	const r = applyScenario(base, ops, { mask: applicationMask(base, [MINE]) });
	expect(r.problems).toEqual([]);
	return {
		base,
		baseSummary,
		runModel: r.input.model,
		runSummary,
		reIds: r.reIds,
		ownNodeIds: [MINE],
		allProposals: true,
		farmHoldersOk: true,
		series: null,
		...extra
	};
}

const damRaise: ScenarioOp = { op: 'node.set', nodeId: MINE, field: 'damCapacityM3', value: 200_000 };
const raised = summary({ mine: 95, below: 47.9, side: 70, town: 500, outflow: 5_800, met: 18 });

describe('projectResultsForApplicant', () => {
	it('shows their own unit, the EWR sites and the catchment, and the units below theirs only by anonymous name and a rounded %', () => {
		const out = projectResultsForApplicant(scenario([damRaise], raised));
		expect(out.units).toEqual([
			{
				nodeId: MINE,
				name: 'Rooikloof',
				kind: 'farm',
				added: false,
				base: expect.objectContaining({ avgSuppliedM3Day: 80, damEndM3: 40_000 }),
				application: expect.objectContaining({ avgSuppliedM3Day: 95, fractionSupplied: 0.95 })
			}
		]);
		// Waterval is below Rooikloof: −4.2 % → −4. Bergvliet (a side branch) and Town are not below it.
		expect(out.downstream).toEqual([{ nodeId: BELOW, name: 'Farm 1', kind: 'farm', supplyChangePct: -4 }]);
		expect(out.ewrSites).toEqual([
			{ nodeId: null, name: null, isOutlet: true, base: { months: 24, met: 20, rate: 20 / 24, longestNotMetRun: 4, deficitM3: 1_234 }, application: expect.objectContaining({ met: 18, deficitM3: 1_234 }) },
			{ nodeId: G, name: 'Gauge', isOutlet: false, base: expect.objectContaining({ met: 20, deficitM3: 567 }), application: expect.objectContaining({ met: 18 }) }
		]);
		expect(out.catchment.figures).toEqual({
			base: { meanNaturalFlowM3Day: 9_000, meanSimulatedOutflowM3Day: 6_000, ewrDaysNotMet: 4, ewrFractionDaysNotMet: 4 / 24 },
			application: { meanNaturalFlowM3Day: 9_000, meanSimulatedOutflowM3Day: 5_800, ewrDaysNotMet: 6, ewrFractionDaysNotMet: 6 / 24 }
		});
		expect(out.catchment.withheld).toBeNull();
		expect(out.unitsWithheld).toBeNull();
		// The WP-2.1 string scan: no hidden unit's, crop's or borehole's name, nor a hidden crop's or borehole's id.
		const text = JSON.stringify(out);
		for (const hidden of [...HIDDEN_NAMES, LUCERNE, 'b2']) expect(text, hidden).not.toContain(hidden);
		// Positive control: their own names are there.
		for (const own of ['Rooikloof', 'Citrus']) expect(text).toContain(own);
	});

	it('shows a unit their ops add as their own, and what lies below it', () => {
		const added = node(NEW, 'New weir', 'farm', SIDE, 9);
		const withNew = { ...raised, farms: [...raised.farms, farm(NEW, 'New weir', 30)] } as RunSummary;
		const out = projectResultsForApplicant(scenario([{ op: 'node.add', node: added }], withNew));
		expect(out.units.map((u) => [u.name, u.added, u.base, u.application?.avgSuppliedM3Day])).toEqual([
			['Rooikloof', false, expect.anything(), 95],
			['New weir', true, null, 30]
		]);
		// Bergvliet (Farm 2) is below the new one; Waterval (Farm 1) below theirs. 70 → 70: 0 %.
		expect(out.downstream.map((d) => [d.name, d.supplyChangePct])).toEqual([
			['Farm 1', -4],
			['Farm 2', 0]
		]);
		expect(out.model.nodes.map((n) => n.name)).toEqual(['Rooikloof', 'New weir']);
	});

	it('gives no percentage for a unit that had no supply in the base', () => {
		const dry = { ...baseSummary, farms: baseSummary.farms.map((f) => (f.nodeId === BELOW ? { ...f, avgSuppliedM3Day: 0 } : f)) } as RunSummary;
		const out = projectResultsForApplicant({ ...scenario([damRaise], raised), baseSummary: dry });
		expect(out.downstream).toEqual([{ nodeId: BELOW, name: 'Farm 1', kind: 'farm', supplyChangePct: null }]);
	});

	it('shows only the EWR months and days when an op was a baseline assumption (control: all proposals, above)', () => {
		const out = projectResultsForApplicant(scenario([{ op: 'node.set', nodeId: BELOW, field: 'damCapacityM3', value: 0 }], raised, { allProposals: false }));
		expect(out.units).toEqual([]);
		expect(out.downstream).toEqual([]);
		expect(out.unitsWithheld).toBe('baseline_assumptions');
		expect(out.catchment).toMatchObject({ figures: null, series: null, withheld: 'baseline_assumptions', ewrDaysNotMet: { base: 4, application: 6 } });
		expect(out.ewrSites.map((s) => [s.base?.met, s.application?.met, s.base?.deficitM3, s.application?.deficitM3])).toEqual([
			[20, 18, null, null],
			[20, 18, null, null]
		]);
	});

	it('leaves the use (outflow, its series, EWR volumes) out below 5 farm holders, and keeps the river and their own units (164)', () => {
		const series = { outflow: { base: { startDate: '2020-01-01', values: [1] }, application: { startDate: '2020-01-01', values: [2] } }, ewr: { base: { startDate: '2020-01-01', values: [3] }, application: { startDate: '2020-01-01', values: [3] } } };
		const few = projectResultsForApplicant(scenario([damRaise], raised, { farmHoldersOk: false, series }));
		expect(few.catchment.withheld).toBe('few_farm_holders');
		expect(few.catchment.figures).toEqual({
			base: { meanNaturalFlowM3Day: 9_000, meanSimulatedOutflowM3Day: null, ewrDaysNotMet: 4, ewrFractionDaysNotMet: 4 / 24 },
			application: { meanNaturalFlowM3Day: 9_000, meanSimulatedOutflowM3Day: null, ewrDaysNotMet: 6, ewrFractionDaysNotMet: 6 / 24 }
		});
		expect(few.catchment.series).toEqual({ ewr: series.ewr, outflow: null });
		expect(JSON.stringify(few.catchment)).not.toContain('5800');
		expect(few.ewrSites.every((s) => s.base?.deficitM3 === null && s.application?.deficitM3 === null)).toBe(true);
		expect(few.units).toHaveLength(1);
		expect(few.downstream).toHaveLength(1);
		// Positive control: at 5 or more, the series pass through.
		expect(projectResultsForApplicant(scenario([damRaise], raised, { series })).catchment.series).toEqual({ ewr: series.ewr, outflow: series.outflow });
	});

	it('shows an item their ops added under a hidden item’s id by the id they gave it (the run holds it under a fresh one)', () => {
		const ops: ScenarioOp[] = [
			{ op: 'crop.add', crop: { id: LUCERNE, name: 'Pecans', cropFactor: monthly(0.8) } },
			{ op: 'cropArea.set', nodeId: MINE, cropId: LUCERNE, areaM2: 20_000 },
			{
				op: 'borehole.add',
				borehole: { id: 'b2', nodeId: MINE, name: 'My new hole', capacityM3Day: 10, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
			},
			{
				op: 'demandObject.add',
				demandObject: { id: 'd2', nodeId: MINE, name: 'My cottages', category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 10, litresPerUnitDay: 230, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'first', destination: 'internal', enabled: true, note: '' }
			}
		];
		const input = scenario(ops, raised);
		// The run holds them under fresh ids (for the assessors: the hidden ones keep theirs).
		expect(input.reIds.map((r) => [r.kind, r.id])).toEqual(expect.arrayContaining([['crop', LUCERNE], ['borehole', 'b2'], ['demandObject', 'd2']]));
		expect(input.runModel.boreholes!.find((b) => b.name === 'My new hole')!.id).toBe('b2-2');
		const out = projectResultsForApplicant(input);
		expect(out.model.crops.map((c) => [c.id, c.name])).toEqual([
			[CITRUS, 'Citrus'],
			[LUCERNE, 'Pecans']
		]);
		expect(out.model.cropAreas.map((a) => [a.cropId, a.areaM2])).toEqual(expect.arrayContaining([[LUCERNE, 20_000], [CITRUS, 50_000]]));
		expect(out.model.boreholes).toEqual([expect.objectContaining({ id: 'b2', name: 'My new hole', nodeId: MINE })]);
		expect(out.model.demandObjects).toEqual([expect.objectContaining({ id: 'd2', name: 'My cottages', nodeId: MINE })]);
		// The hidden ones stay out: no Lucerne, no Neighbour hole or village, no fresh id.
		const text = JSON.stringify(out);
		for (const hidden of ['Lucerne', 'Neighbour hole', 'Neighbour village', 'b2-2', 'd2-2', `${LUCERNE}-2`]) expect(text, hidden).not.toContain(hidden);
	});
});

describe('downstreamOf', () => {
	it('walks each start down to the outlet, never past a loop', () => {
		const nodes = [
			{ id: 'g', downstreamNodeId: null },
			{ id: 'a', downstreamNodeId: 'b' },
			{ id: 'b', downstreamNodeId: 'g' },
			{ id: 'c', downstreamNodeId: 'g' },
			{ id: 'x', downstreamNodeId: 'y' },
			{ id: 'y', downstreamNodeId: 'x' }
		];
		expect([...downstreamOf(nodes, ['a'])].sort()).toEqual(['b', 'g']);
		expect([...downstreamOf(nodes, ['a', 'c'])].sort()).toEqual(['b', 'g']);
		expect([...downstreamOf(nodes, ['x'])]).toEqual(['y']);
		expect([...downstreamOf(nodes, ['g'])]).toEqual([]);
	});
});
