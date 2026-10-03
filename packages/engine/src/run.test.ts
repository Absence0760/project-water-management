import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { CropArea, CropDef, ModelInput, NetworkNode, ProjectSettings, RunSeries, Transfer } from './project';
import { DEFAULT_GAUGE_PICK_WARNING, pickObservedKind, resolveReportWindow, runModel, runModelWith, withVerification } from './run';
import { defaultProjectSettings, irrigationFromReturnFlow, OBSERVED_SERIES_LABEL } from './project';

import { calibrationStats } from './network/stats';
import { ewrCompliance } from './network/ewr';
import { toEpochDay, waterYearIndex } from './calendar';
import { zeroRainRuns } from './quality';
import { ACC_MIN_MM } from './accumulation';
import { buildTopology } from './network/topology';
import { shortfall } from './network/simulate';
import { checkTransferLimits } from './verify/checks';
import { transferRatesM3s, withMonthlyRates } from './network/transferRates';
import { netDailyDemandM3 } from './demand';
import { computeCurtailment, type ReportWindow } from './network/curtailment';
import { loadClientCatchmentFixture, type Expected } from './testing/client-catchment-fixture';
import { prepareRun } from './prepare';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const zeros = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as unknown as Monthly;
const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
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

interface Fixture {
	nodes: NetworkNode[];
	crops?: CropDef[];
	cropAreas?: CropArea[];
	transfers?: Transfer[];
	settings?: Partial<ProjectSettings>;
	natural: number[];
	startDate?: string;
	rain?: (number | null)[];
	observed?: (number | null)[];
}

function input(f: Fixture): ModelInput {
	const days = f.natural.length;
	const startDate = f.startDate ?? '2020-01-01';
	return {
		settings: { ewrPragmaticM3PerDay: zeros, ...f.settings },
		model: { nodes: f.nodes, crops: f.crops ?? [], cropAreas: f.cropAreas ?? [], transfers: f.transfers ?? [] },
		series: {
			rain_catchment_mm: { startDate, values: f.rain ?? new Array(days).fill(0) },
			...(f.observed ? { flow_observed_m3s: { startDate, values: f.observed } } : {})
		}
	};
}

const run = (f: Fixture) => runModelWith(input(f), () => ({ naturalFlowM3Day: f.natural }));

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}

// ---------------------------------------------------------------------------
// Synthetic networks — always run
// ---------------------------------------------------------------------------

describe('runModel — three-node network (A → B → gauge)', () => {
	// Two farms of equal area share natural flow 50/50. A has a dam that takes
	// all its own runoff and irrigates at 50 % efficiency, half its losses
	// returning (N1); B has no dam and a 50% runoff-to-dam split (no dam, so
	// that water just passes the "full" dam as spill).
	const nodes = [
		node('A', {
			downstreamNodeId: 'B',
			pctRunoffToDam: 1,
			damCapacityM3: 1000,
			damInitialPct: 0.9,
			irrigationEfficiency: 0.5,
			lossReturnFraction: 0.5
		}),
		node('B', { downstreamNodeId: 'G', sortOrder: 1, pctRunoffToDam: 0.5, irrigationEfficiency: 1, lossReturnFraction: 0 }),
		node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 2 })
	];
	// A: one crop, 1000 m², crop factor 1.
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
	const cropAreas: CropArea[] = [{ nodeId: 'A', cropId: 'c', areaM2: 1000 }];
	const settings: Partial<ProjectSettings> = { apanMm: flat(31 * 100) as Monthly };
	// October: 31 days → gross = 1000 m² × 3100 mm / 1000 / 31 = 100 m³/day of crop
	// requirement, so A abstracts 100 / 0.5 = 200 m³/day.

	const out = run({
		nodes,
		crops,
		cropAreas,
		settings,
		natural: [200, 0, 1601],
		startDate: '2020-10-01'
	});

	it('splits natural flow by area share, unrounded (audit R1)', () => {
		expect(get(out, 'A', 'runoff')).toEqual([100, 0, 800.5]); // the workbook: ROUND(800.5) = 801
		expect(get(out, 'B', 'runoff')).toEqual([100, 0, 800.5]);
	});

	it('supplies demand from the dam and carries storage day to day', () => {
		// Day 0: Qprev 900 + M 100 → avail 1000, G = 200, P = 800, Q = 800.
		// Day 1: avail 800 → G 200, Q 600.
		// Day 2: avail 600 + 800.5 = 1400.5 → G 200, P 1200.5, Q 1000, spill 200.5.
		expect(get(out, 'A', 'crop_requirement')).toEqual([100, 100, 100]);
		expect(get(out, 'A', 'demand')).toEqual([200, 200, 200]);
		expect(get(out, 'A', 'supplied')).toEqual([200, 200, 200]);
		expect(get(out, 'A', 'dam_storage')).toEqual([800, 600, 1000]);
		expect(get(out, 'A', 'spill')).toEqual([0, 0, 200.5]);
		// U = spill + below-dam (0) + return β (1 − e) G = 0.5 × 0.5 × 200 = 50
		expect(get(out, 'A', 'return_flow')).toEqual([50, 50, 50]);
		expect(get(out, 'A', 'outflow')).toEqual([50, 50, 250.5]);
	});

	it('routes upstream outflow into the next farm and on to the gauge', () => {
		expect(get(out, 'B', 'inflow_upstream')).toEqual([50, 50, 250.5]);
		// B: capacity 0, pctUpstreamToDam 0. M = I × 0.5 goes to the (zero) dam and
		// spills; the upstream inflow and N pass below the dam (engine ≥ 0.9.0, Q1).
		// U = R + S + T = M + (L + N) + 0 = H + I.
		expect(get(out, 'B', 'spill')).toEqual([50, 0, 400.25]); // M only
		expect(get(out, 'B', 'outflow')).toEqual([150, 50, 1051]);
		expect(get(out, 'G', 'outflow')).toEqual([150, 50, 1051]);
		expect(get(out, null, 'simulated_outflow')).toEqual([150, 50, 1051]);
	});

	it('adds an EWR compliance grid for the outlet and each farm', () => {
		const withEwr = run({ nodes, crops, cropAreas, settings: { ...settings, ewrPragmaticM3PerDay: flat(100) }, natural: [200, 0, 1601], startDate: '2020-10-01' });
		const g = withEwr.summary.ewrCompliance!;
		expect(g.waterYears).toEqual([2020]);
		expect(g.days[0]![0]).toBe(3);
		// Outflow [150, 50, 1051] vs EWR 100: only day 1 is short, by 50.
		expect(g.outlet.name).toBe('G');
		expect(g.outlet.daysNotMet[0]![0]).toBe(1);
		expect(g.outlet.shortfallM3[0]![0]).toBe(50);
		expect(g.farms.map((f) => f.nodeId)).toEqual(['A', 'B']);
		const ewrDays = get(withEwr, null, 'ewr_shortfall').filter((v) => v < 0).length;
		expect(ewrDays).toBe(withEwr.summary.catchment.ewrDaysNotMet);
	});

	it('reports per-farm averages', () => {
		const a = out.summary.farms.find((f) => f.nodeId === 'A')!;
		expect(a.avgDemandM3Day).toBe(200);
		expect(a.avgCropRequirementM3Day).toBe(100);
		expect(a.fractionSupplied).toBe(1);
		const b = out.summary.farms.find((f) => f.nodeId === 'B')!;
		expect(b.avgDemandM3Day).toBe(0);
		expect(b.fractionSupplied).toBe(1);
		expect(out.summary.farms.map((f) => f.nodeId)).toEqual(['A', 'B']); // gauges have no farm summary
		expect(out.summary.catchment.meanSimulatedOutflowM3Day).toBeCloseTo((150 + 50 + 1051) / 3, 10);
	});

	it('puts the dam storage figures in the summary of a farm with a dam only (engine 1.2.0, issue #55)', () => {
		// dam_storage [800, 600, 1000]: the end 1000, the low 600 on day 1, no minimum level.
		const a = out.summary.farms.find((f) => f.nodeId === 'A')!;
		expect(a).toMatchObject({ damEndM3: 1000, damAgoM3: null, damLowM3: 600, damLowDate: '2020-10-02', damDaysAtMin: 0 });
		const b = out.summary.farms.find((f) => f.nodeId === 'B')!;
		for (const k of ['damEndM3', 'damAgoM3', 'damLowM3', 'damLowDate', 'damDaysAtMin']) expect(b).not.toHaveProperty(k);
		// At a 60 % minimum, the day at 600 m³ counts.
		const atMin = run({ nodes: nodes.map((n) => (n.id === 'A' ? { ...n, damMinPct: 0.6 } : n)), crops, cropAreas, settings, natural: [200, 0, 1601], startDate: '2020-10-01' });
		expect(atMin.summary.farms[0]!.damDaysAtMin).toBeGreaterThan(0);
	});

	it('runs over the rainfall period and emits catchment series', () => {
		expect(out.startDate).toBe('2020-10-01');
		expect(out.endDate).toBe('2020-10-03');
		expect(out.days).toBe(3);
		expect(get(out, null, 'natural_flow')).toEqual([200, 0, 1601]);
		// B has no dam but takes upstream inflow to it: it irrigates from the river with no limit, and the run says so (issue #54).
		expect(out.summary.warnings).toEqual([
			'unit "B": it has no dam, so what is routed to its dam (upstream inflow, runoff, diversion) is irrigated straight from the river, with no pump limit; to cap it, set the supply rule to run of river with a pump capacity',
			'no observed flow series: calibration statistics not computed'
		]);
	});
});

describe('runModel — flow share in the farm summary (engine 0.27.0)', () => {
	it('reports each farm\'s share, the factor behind its runoff (I) and EWR (Y), and the shares add to 1', () => {
		// Areas 3 and 1 km²: area shares 0.75 and 0.25.
		const nodes = [node('A', { areaKm2: 3, downstreamNodeId: 'B' }), node('B', { areaKm2: 1, sortOrder: 1 })];
		const natural = [400, 0, 1234.5];
		const out = run({ nodes, natural, settings: { ewrPragmaticM3PerDay: flat(100) as Monthly } });
		const share = new Map(out.summary.farms.map((f) => [f.nodeId, f.flowShare]));
		expect(share).toEqual(new Map([['A', 0.75], ['B', 0.25]]));
		for (const id of ['A', 'B']) {
			expect(get(out, id, 'runoff')).toEqual(natural.map((q) => q * share.get(id)!));
			expect(get(out, id, 'ewr')).toEqual(natural.map(() => 100 * share.get(id)!));
		}
	});
});

describe('runModel — no rounding in the balance (audit R1)', () => {
	it('fragmentation conserves natural flow: Σ farm runoff = natural flow', () => {
		// Four equal farms: ROUND(0.25) = 0 lost 1 m³/day; ROUND(0.5) = 1 created 2 m³/day from 2.
		const nodes = ['A', 'B', 'C', 'D'].map((id, i) => node(id, { sortOrder: i, downstreamNodeId: i < 3 ? 'ABCD'[i + 1]! : null }));
		const natural = [1, 2, 5, 1234.5];
		const out = run({ nodes, natural });
		for (let t = 0; t < natural.length; t++) {
			const sum = nodes.reduce((s, n) => s + get(out, n.id, 'runoff')[t]!, 0);
			expect(sum).toBeCloseTo(natural[t]!, 9);
		}
		expect(get(out, null, 'simulated_outflow')).toEqual(natural.map((v) => expect.closeTo(v, 9)));
	});

	it('keeps a sub-m³ dam and the exact return flow', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const out = run({
			nodes: [node('D', { damCapacityM3: 0.4, damInitialPct: 1, irrigationEfficiency: 0.8, lossReturnFraction: 0.5 })],
			crops,
			cropAreas: [{ nodeId: 'D', cropId: 'c', areaM2: 1 }],
			settings: { apanMm: flat(31) as Monthly }, // 1 m² × 31 mm / 1000 / 31 = 0.001 m³/day
			natural: [0],
			startDate: '2020-10-01'
		});
		expect(get(out, 'D', 'crop_requirement')[0]).toBeCloseTo(0.001, 12);
		expect(get(out, 'D', 'demand')[0]).toBeCloseTo(0.00125, 12); // ÷ 0.8 efficiency
		expect(get(out, 'D', 'supplied')[0]).toBeCloseTo(0.00125, 12);
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(0.39875, 12);
		expect(get(out, 'D', 'outflow')[0]).toBeCloseTo(0.000125, 12); // 0.5 × 0.2 × 0.00125
	});
});

describe('runModel — dam behaviour', () => {
	it('with pctUpstreamToDam = 0 upstream inflow passes below the dam (L); only the diversion reaches it (Q1, engine 0.9.0)', () => {
		// Upstream U farm drains 1000 m³/day of runoff into D. D takes none of it
		// into the dam; the 300 m³/day diversion brings some back.
		const out = run({
			nodes: [
				node('U', { downstreamNodeId: 'D' }),
				node('D', {
					areaKm2: 0,
					sortOrder: 1,
					pctUpstreamToDam: 0,
					divertCapacityM3Day: 300,
					damCapacityM3: 10_000
				})
			],
			natural: [1000, 1000]
		});
		expect(get(out, 'D', 'inflow_upstream')).toEqual([1000, 1000]);
		expect(get(out, 'D', 'dam_storage')).toEqual([300, 600]);
		expect(get(out, 'D', 'outflow')).toEqual([700, 700]);
	});

	it('splits a fraction: pctUpstreamToDam = 0.25 puts a quarter of the upstream inflow into the dam', () => {
		const out = run({
			nodes: [
				node('U', { downstreamNodeId: 'D' }),
				node('D', { areaKm2: 0, sortOrder: 1, pctUpstreamToDam: 0.25, damCapacityM3: 10_000 })
			],
			natural: [1000]
		});
		expect(get(out, 'D', 'dam_storage')).toEqual([250]);
		expect(get(out, 'D', 'outflow')).toEqual([750]);
	});

	it('with pctUpstreamToDam = 1 all upstream inflow enters the dam (K), as the label says (Q1, engine 0.9.0)', () => {
		const out = run({
			nodes: [
				node('U', { downstreamNodeId: 'D' }),
				node('D', { areaKm2: 0, sortOrder: 1, pctUpstreamToDam: 1, damCapacityM3: 1500 })
			],
			natural: [1000, 1000]
		});
		expect(get(out, 'D', 'dam_storage')).toEqual([1000, 1500]);
		expect(get(out, 'D', 'spill')).toEqual([0, 500]);
		expect(get(out, 'D', 'outflow')).toEqual([0, 500]);
	});

	it('a dam on the river (pctUpstreamToDam = 1) takes no River to dam, and the run says so (engine 1.68.0)', () => {
		// U and D each make 1000 m³/day of runoff. D's dam takes all of U's outflow
		// (K = 1000); its own runoff passes below it (N = 1000), where the stored
		// 300 m³/day River to dam is not used: that is for an off-channel dam.
		const onRiver = run({
			nodes: [node('U', { downstreamNodeId: 'D' }), node('D', { sortOrder: 1, pctUpstreamToDam: 1, divertCapacityM3Day: 300, damCapacityM3: 10_000 })],
			natural: [2000]
		});
		expect(get(onRiver, 'D', 'dam_storage')).toEqual([1000]);
		expect(get(onRiver, 'D', 'outflow')).toEqual([1000]);
		expect(onRiver.summary.warnings.filter((w) => w.includes('River to dam isn')).length).toBe(1);
		// Positive control: a dam that lets any of the upstream inflow past takes River to dam.
		const offRiver = run({
			nodes: [node('U', { downstreamNodeId: 'D' }), node('D', { sortOrder: 1, pctUpstreamToDam: 0.99, divertCapacityM3Day: 300, damCapacityM3: 10_000 })],
			natural: [2000]
		});
		expect(get(offRiver, 'D', 'dam_storage')).toEqual([1290]);
		expect(get(offRiver, 'D', 'outflow')).toEqual([710]);
		expect(offRiver.summary.warnings.some((w) => w.includes('River to dam isn'))).toBe(false);
		// By month too: an on-river dam ignores River to dam by month.
		const byMonth = run({
			nodes: [node('U', { downstreamNodeId: 'D' }), node('D', { sortOrder: 1, pctUpstreamToDam: 1, divertMonthlyM3Day: new Array(12).fill(300), damCapacityM3: 10_000 })],
			natural: [2000]
		});
		expect(get(byMonth, 'D', 'dam_storage')).toEqual([1000]);
	});

	it('initial storage is pct × capacity, unrounded (the Element sheet: ROUND(pct × ROUND(capacity)))', () => {
		const out = run({
			nodes: [node('D', { damCapacityM3: 1001.4, damInitialPct: 0.5 })],
			natural: [0]
		});
		expect(get(out, 'D', 'dam_storage')).toEqual([500.7]); // the workbook: ROUND(0.5 × 1001) = 501
	});

	it('records a deficit when the dam runs dry', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const out = run({
			nodes: [node('D', { damCapacityM3: 150, damInitialPct: 1 })],
			crops,
			cropAreas: [{ nodeId: 'D', cropId: 'c', areaM2: 1000 }],
			settings: { apanMm: flat(3100) as Monthly },
			natural: [0, 0],
			startDate: '2020-10-01'
		});
		expect(get(out, 'D', 'supplied')).toEqual([100, 50]);
		expect(get(out, 'D', 'deficit')).toEqual([0, 50]);
		const s = out.summary.farms[0]!;
		expect(s.avgDeficitM3Day).toBe(25);
		expect(s.fractionSupplied).toBe(0.75);
	});

	it('irrigation stops at the minimum operating level: storage below it is dead storage (Q5, engine 0.16.0)', () => {
		// 150 m³ dam, full, minimum 20 % = 30 m³ dead storage; demand 100 m³/day.
		// Day 0 takes 100 (120 above the floor), day 1 only the 20 left above it, day 2 nothing.
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const out = run({
			nodes: [node('D', { damCapacityM3: 150, damInitialPct: 1, damMinPct: 0.2 })],
			crops,
			cropAreas: [{ nodeId: 'D', cropId: 'c', areaM2: 1000 }],
			settings: { apanMm: flat(3100) as Monthly },
			natural: [0, 0, 0],
			startDate: '2020-10-01'
		});
		expect(get(out, 'D', 'supplied')).toEqual([100, 20, 0]);
		expect(get(out, 'D', 'dam_storage')).toEqual([50, 30, 30]);
		expect(get(out, 'D', 'deficit')).toEqual([0, 80, 100]);
	});

	it('a dam that starts below its minimum operating level supplies nothing until it fills above it (Q5)', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const out = run({
			nodes: [node('D', { damCapacityM3: 1000, damInitialPct: 0.1, damMinPct: 0.3, pctRunoffToDam: 1 })],
			crops,
			cropAreas: [{ nodeId: 'D', cropId: 'c', areaM2: 1000 }],
			settings: { apanMm: flat(3100) as Monthly },
			// 100 m³ in the dam, floor 300: day 0 gets 150 of runoff (250, still below), day 1 another 150 (400: 100 above).
			natural: [150, 150],
			startDate: '2020-10-01'
		});
		expect(get(out, 'D', 'supplied')).toEqual([0, 100]);
		expect(get(out, 'D', 'dam_storage')).toEqual([250, 300]);
	});
});

describe('runModel — irrigation efficiency and loss return (audit N1, engine 0.16.0)', () => {
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
	// 1000 m² × 3100 mm / 1000 / 31 = 100 m³/day of crop requirement in October.
	const farm = (over: Partial<NetworkNode>, natural = [0]) =>
		run({
			nodes: [node('F', { areaKm2: 0, damCapacityM3: 10_000, damInitialPct: 1, ...over })],
			crops,
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 1000 }],
			settings: { apanMm: flat(3100) as Monthly },
			natural,
			startDate: '2020-10-01'
		});

	it('abstracts crop requirement ÷ efficiency, so a fully supplied crop gets all it needs (F = 100, e = 0.9)', () => {
		const out = farm({ irrigationEfficiency: 0.9, lossReturnFraction: 1 });
		const G = get(out, 'F', 'supplied')[0]!;
		expect(get(out, 'F', 'crop_requirement')[0]).toBe(100);
		expect(get(out, 'F', 'demand')[0]).toBeCloseTo(111.111111, 5);
		expect(G).toBeCloseTo(111.111111, 5);
		expect(0.9 * G).toBeCloseTo(100, 9); // crop use = e × G
		expect(get(out, 'F', 'deficit')[0]).toBe(0);
		// All the losses return: T = 1 × 0.1 × G, consumptive use = G − T = the crop's 100.
		expect(get(out, 'F', 'return_flow')[0]).toBeCloseTo(0.1 * G, 9);
		expect(G - get(out, 'F', 'return_flow')[0]!).toBeCloseTo(100, 9);
	});

	it('returns only the share β of the losses; the rest leaves the catchment', () => {
		const out = farm({ irrigationEfficiency: 0.8, lossReturnFraction: 0.25 });
		const G = get(out, 'F', 'supplied')[0]!;
		expect(G).toBeCloseTo(125, 9);
		expect(get(out, 'F', 'return_flow')[0]).toBeCloseTo(0.25 * 0.2 * 125, 9);
		expect(get(out, 'F', 'outflow')[0]).toBeCloseTo(6.25, 9);
		expect(Math.abs(get(out, 'F', 'balance_residual')[0]!)).toBeLessThan(1e-9);
	});

	it('measures a shortage against the abstraction demand: deficit = D − G, supplied fraction = G / D', () => {
		// 60 m³ in the dam and no inflow: D = 125, G = 60.
		const out = farm({ damCapacityM3: 60, irrigationEfficiency: 0.8, lossReturnFraction: 0.5 });
		expect(get(out, 'F', 'supplied')).toEqual([60]);
		expect(get(out, 'F', 'deficit')[0]).toBeCloseTo(65, 9);
		const s = out.summary.farms[0]!;
		expect(s.avgDemandM3Day).toBeCloseTo(125, 9);
		expect(s.avgCropRequirementM3Day).toBe(100);
		expect(s.fractionSupplied).toBeCloseTo(0.48, 9); // = crop use 48 / crop requirement 100
		expect(out.summary.curtailment!.farms[0]!.demandM3Day).toBeCloseTo(125, 9);
	});

	it('e = 1 and β = 0 is the workbook with no return flow, bit for bit', () => {
		const out = farm({ irrigationEfficiency: 1, lossReturnFraction: 0.7 });
		expect(get(out, 'F', 'demand')).toEqual([100]);
		expect(get(out, 'F', 'supplied')).toEqual([100]);
		expect(get(out, 'F', 'return_flow')).toEqual([0]);
	});

	it('runs a model saved before engine 0.16.0 as migration 006 stores it (r = 0.2 → e = 0.8, β = 1)', () => {
		const legacy = farm({});
		const input0 = input({
			nodes: [node('F', { areaKm2: 0, damCapacityM3: 10_000, damInitialPct: 1 })],
			crops,
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 1000 }],
			settings: { apanMm: flat(3100) as Monthly },
			natural: [0],
			startDate: '2020-10-01'
		});
		for (const n of input0.model.nodes as unknown as Record<string, unknown>[]) {
			delete n.irrigationEfficiency;
			delete n.lossReturnFraction;
			n.returnFlowPct = 0.2;
		}
		const old = runModelWith(input0, () => ({ naturalFlowM3Day: [0] }));
		const now = farm({ irrigationEfficiency: 0.8, lossReturnFraction: 1 });
		expect(get(old, 'F', 'supplied')).toEqual(get(now, 'F', 'supplied'));
		expect(get(old, 'F', 'return_flow')).toEqual(get(now, 'F', 'return_flow'));
		expect(get(legacy, 'F', 'supplied')).toEqual([100]);
	});

	it('warns and runs e = 1 for an efficiency outside (0, 1] instead of dividing by 0', () => {
		const out = farm({ irrigationEfficiency: 0, lossReturnFraction: 0.5 });
		expect(get(out, 'F', 'demand')).toEqual([100]);
		expect(out.summary.warnings.some((w) => w.includes('irrigation efficiency 0 is not in (0, 1]'))).toBe(true);
	});
});

describe('runModel — dam evaporation and seepage (audit N2, engine 0.16.0)', () => {
	// October (31 days), A-pan 248 mm: 0.75 × 248 / 31 = 6 mm/day of open-water evaporation.
	const dam = (over: Partial<NetworkNode>, f: Partial<Fixture> = {}) =>
		run({
			nodes: [node('D', { areaKm2: 0, damCapacityM3: 100_000, damInitialPct: 1, damAreaFullM2: 30_000, ...over })],
			settings: { apanMm: flat(248) as Monthly },
			natural: [0],
			startDate: '2020-10-01',
			...f
		});

	it('evaporates lake factor × A-pan from the surface: 100 000 m³, 3 ha, 6 mm/day ≈ 180 m³/day', () => {
		const out = dam({});
		expect(get(out, 'D', 'dam_area')).toEqual([30_000]);
		expect(get(out, 'D', 'dam_evaporation')[0]).toBeCloseTo(180, 9);
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(100_000 - 180, 9);
		expect(Math.abs(get(out, 'D', 'balance_residual')[0]!)).toBeLessThan(1e-9);
	});

	it('shrinks the surface with the storage: A = A_full × (Q[t−1] / capacity)^b', () => {
		const out = dam({ damInitialPct: 0.5, damAreaExponent: 0.7 });
		expect(get(out, 'D', 'dam_area')[0]).toBeCloseTo(30_000 * Math.pow(0.5, 0.7), 9);
		expect(get(out, 'D', 'dam_evaporation')[0]).toBeCloseTo((6 * 30_000 * Math.pow(0.5, 0.7)) / 1000, 9);
	});

	it('adds the rain on the surface, before any rain threshold, and the lake factor setting scales evaporation', () => {
		const out = dam({ damInitialPct: 0.5 }, { settings: { apanMm: flat(248) as Monthly, lakeEvapFactor: 0 }, rain: [1.5] });
		const A = 30_000 * Math.pow(0.5, 0.7);
		expect(get(out, 'D', 'dam_evaporation')).toEqual([0]);
		expect(get(out, 'D', 'rain_on_dam')[0]).toBeCloseTo((1.5 * A) / 1000, 9); // 1.5 mm is below the 2 mm threshold
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(50_000 + (1.5 * A) / 1000, 9);
	});

	it('seeps a fraction of the storage, which joins the outflow the same day', () => {
		const out = dam({ damSeepagePerDay: 0.01 }, { settings: { apanMm: flat(0) as Monthly } });
		expect(get(out, 'D', 'dam_seepage')).toEqual([1000]);
		expect(get(out, 'D', 'outflow')).toEqual([1000]);
		expect(get(out, 'D', 'dam_storage')).toEqual([99_000]);
	});

	it('never takes a dam below empty: evaporation takes at most what is there, seepage what is left', () => {
		const out = dam({ damCapacityM3: 10, damAreaFullM2: 1e6, damSeepagePerDay: 1 });
		expect(get(out, 'D', 'dam_evaporation')).toEqual([10]);
		expect(get(out, 'D', 'dam_seepage')).toEqual([0]);
		expect(get(out, 'D', 'dam_storage')).toEqual([0]);
		// Empty, the dam has no surface: nothing more evaporates.
		const two = dam({ damCapacityM3: 10, damAreaFullM2: 1e6 }, { natural: [0, 0] });
		expect(get(two, 'D', 'dam_area')).toEqual([1e6, 0]);
		expect(get(two, 'D', 'dam_evaporation')).toEqual([10, 0]);
	});

	it('engine 0.21.1: with b > 1 a fuller dam never ends the day with less water (fuzz seeds 4197, 7686, 15979, 17277)', () => {
		// 100 m³ with 10 ha when full (1 mm mean depth), b = 3, 6 mm/day: E = 600 × f³ m³ at f = Q[t−1] / capacity.
		// The uncapped step left 100f − 600f³, which peaks near f = 0.24 and is 0 above f ≈ 0.41, so a fuller
		// dam ended the day emptier. The cap E ≤ (1 − seepage) × Q[t−1] / b keeps the order.
		const end = (f: number, over: Partial<NetworkNode> = {}) =>
			get(dam({ damCapacityM3: 100, damInitialPct: f, damAreaFullM2: 100_000, damAreaExponent: 3, ...over }), 'D', 'dam_storage')[0]!;
		const fs = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
		for (const seepage of [0, 0.3]) {
			const ends = fs.map((f) => end(f, { damSeepagePerDay: seepage }));
			for (let i = 1; i < ends.length; i++) expect(ends[i]!, `seepage ${seepage}, f ${fs[i]}`).toBeGreaterThanOrEqual(ends[i - 1]!);
		}
		// Full: E = MIN(600, 100 / 3); with seepage 0.3, E = 0.7 × 100 / 3 and Sp = 30.
		expect(end(1)).toBeCloseTo(200 / 3, 9);
		expect(end(1, { damSeepagePerDay: 0.3 })).toBeCloseTo(100 - 70 / 3 - 30, 9);
		// Where 1/b of the dam is more than a day's evaporation the cap doesn't bind: f = 0.2 loses 600 × 0.008 = 4.8 m³.
		expect(end(0.2)).toBeCloseTo(20 - 4.8, 9);
		// b ≤ 1 is untouched: at b = 1 the whole 100 m³ still evaporates (600 m³ asked for).
		expect(end(1, { damAreaExponent: 1 })).toBe(0);
	});

	it('engine 1.63.0: runs an older document\'s b > 1 as entered, and says a save now needs b ≤ 1 (issue #90)', () => {
		const warn = (over: Partial<NetworkNode>) => dam(over).summary.warnings.filter((w) => w.includes('dam area exponent'));
		expect(warn({ damAreaExponent: 1.5 })).toEqual([
			'unit "D": dam area exponent 1.5 is above 1, which no real basin has (the surface would grow faster than the volume); it runs as entered, with the b > 1 limiter, but a save now needs 0 < b ≤ 1. Use 0.7, or enter the dam\'s survey curve'
		]);
		// Positive control: b = 1 and the default say nothing.
		expect(warn({ damAreaExponent: 1 })).toEqual([]);
		expect(warn({})).toEqual([]);
	});

	it('estimates an unknown area as 7.2 × capacity^0.77 (Maaren & Moolman 1985) and says how many dams used the estimate (W6)', () => {
		const out = run({
			nodes: [
				node('D', { areaKm2: 0, damCapacityM3: 90_000, damInitialPct: 1, damAreaFullM2: null, downstreamNodeId: 'G' }),
				node('E', { areaKm2: 0, damCapacityM3: 90_000, damInitialPct: 1, damAreaFullM2: 20_000, downstreamNodeId: 'G' }),
				node('F', { areaKm2: 0, damCapacityM3: 0, damAreaFullM2: null, downstreamNodeId: 'G' }),
				node('G', { kind: 'gauge', areaKm2: 0 })
			],
			settings: { apanMm: flat(248) as Monthly },
			natural: [0],
			startDate: '2020-10-01'
		});
		// 7.2 × 90 000^0.77 ≈ 47 000 m², a mean depth of about 1.9 m (engine ≥ 1.63.0; capacity ÷ 3 m gave 30 000 before).
		expect(get(out, 'D', 'dam_area')[0]).toBeCloseTo(7.2 * 90_000 ** 0.77, 6);
		expect(get(out, 'D', 'dam_area')[0]).toBeCloseTo(47_000.15, 1);
		expect(get(out, 'E', 'dam_area')).toEqual([20_000]);
		const w6 = out.summary.warnings.filter((w) => w.includes('no full-supply area'));
		expect(w6).toEqual([
			'1 dam has no full-supply area, so dam evaporation uses an estimate: 7.2 × capacity^0.77 (Maaren & Moolman 1985) m², a regional relation that can be far out for any one dam. Enter the area for (D)'
		]);
	});

	it('leaves a farm without a dam alone', () => {
		const out = dam({ damCapacityM3: 0, damInitialPct: 0, damAreaFullM2: null, damSeepagePerDay: 1 }, { rain: [50] });
		for (const k of ['dam_area', 'dam_evaporation', 'rain_on_dam', 'dam_seepage', 'outflow']) expect(get(out, 'D', k), k).toEqual([0]);
		expect(out.summary.warnings.some((w) => w.includes('no full-supply area'))).toBe(false);
	});

	it('takes the losses before irrigation, and the water balance still closes', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const out = run({
			nodes: [node('D', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 0.1, damAreaFullM2: 10_000, damSeepagePerDay: 0.05 })],
			crops,
			cropAreas: [{ nodeId: 'D', cropId: 'c', areaM2: 100_000 }], // 800 m³/day of demand
			settings: { apanMm: flat(248) as Monthly },
			natural: [0],
			startDate: '2020-10-01'
		});
		// 100 m³ in the dam: A = 10 000 × 0.1^0.7; E = 6 mm × A; seepage 5 m³; irrigation gets the rest.
		const A = 10_000 * Math.pow(0.1, 0.7);
		const E = (6 * A) / 1000;
		expect(get(out, 'D', 'supplied')[0]).toBeCloseTo(100 - E - 5, 9);
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(0, 9);
		expect(get(out, 'D', 'outflow')[0]).toBeCloseTo(5, 9); // the seepage
		expect(Math.abs(get(out, 'D', 'balance_residual')[0]!)).toBeLessThan(1e-9);
	});
});

describe('runModel — irrigation demand', () => {
	it('offsets gross demand by effective rain above the threshold', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(0.5)] }];
		const out = run({
			nodes: [node('F', { damCapacityM3: 1e9, damInitialPct: 1 })],
			crops,
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 10_000 }],
			// A-pan 100 mm × 0.5 = 50 mm; 10 000 m² × 50 mm / 1000 / 31 = 16.129 m³/day
			settings: { apanMm: flat(100) as Monthly },
			startDate: '2021-01-01',
			natural: [0, 0, 0, 0],
			// 2 mm is at the threshold → ignored; 3 mm → 10 000 × 0.65/1000 × 3 = 19.5 → floored at 0
			rain: [0, 2, 1, 3]
		});
		expect(get(out, 'F', 'demand')).toEqual([500 / 31, 500 / 31, 500 / 31, 0]);
	});

	it('falls back to CHIRPS rain when catchment rain is missing', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const base = input({
			nodes: [node('F', { damCapacityM3: 1e9, damInitialPct: 1 })],
			crops,
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 1000 }],
			settings: { apanMm: flat(3100) as Monthly },
			startDate: '2020-10-01',
			natural: [0, 0],
			rain: [null, 0]
		});
		base.series.rain_chirps_mm = { startDate: '2020-10-01', values: [100, 100] };
		const out = runModelWith(base, () => ({ naturalFlowM3Day: [0, 0] }));
		// day 0: CHIRPS 100 mm → offset 1000 × 0.65 × 0.1 = 65 → 35; day 1: catchment 0 wins
		expect(get(out, 'F', 'demand')).toEqual([35, 100]);
	});

	describe('soil-water store (N3, engine 0.14.0)', () => {
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(0.5)] }];
		const fixture = (rain: number[], settings: Partial<ProjectSettings> = {}): Fixture => ({
			nodes: [node('F', { damCapacityM3: 1e9, damInitialPct: 1 })],
			crops,
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 10_000 }],
			// 10 000 m² × 50 mm / 1000 / 31 = 500/31 m³/day gross in January
			settings: { apanMm: flat(100) as Monthly, ...settings },
			startDate: '2021-01-01',
			natural: rain.map(() => 0),
			rain
		});
		const G = 500 / 31;

		it('carries the effective rain the crop could not use on the day into the following days', () => {
			// 30 mm → 10 000 × 0.65 / 1000 × 30 = 195 m³: G used today, 195 − G kept (17.9 mm < 25 mm).
			const out = run(fixture([0, 30, 0, 0, 0, 0]));
			expect(get(out, 'F', 'demand')).toEqual([G, 0, 0, 0, 0, 0]);
			expect(get(out, 'F', 'effective_rain').slice(1)).toEqual([G, G, G, G, G]);
			const store = get(out, 'F', 'soil_water');
			expect(store[0]).toBe(0);
			for (let t = 2; t < 6; t++) expect(store[t]).toBeCloseTo(((195 - t * G) * 1000) / 10_000, 9);
			expect(out.summary.warnings.filter((w) => w.includes('soil-water'))).toEqual([]);
		});

		it('with a 0 mm store the demand is bit for bit the workbook rule, day by day', () => {
			const rain = Array.from({ length: 62 }, (_, t) => [0, 1, 2, 2.5, 7, 30, 0, 0, 120, 0.3][t % 10]!);
			const out = run(fixture(rain, { effectiveRainStoreMm: 0 }));
			const gross = get(out, 'F', 'gross_demand');
			const demand = get(out, 'F', 'demand');
			const bad = demand.filter((d, t) => !Object.is(d, netDailyDemandM3(gross[t]!, 10_000, rain[t]! > 2 ? rain[t]! : 0, 0.65)));
			expect(bad).toEqual([]);
			expect(get(out, 'F', 'soil_water').every((w) => w === 0)).toBe(true);
			// … and the default store only ever lowers demand.
			const withStore = get(run(fixture(rain)), 'F', 'demand');
			expect(withStore.every((d, t) => d <= demand[t]!)).toBe(true);
			expect(withStore.reduce((a, b) => a + b, 0)).toBeLessThan(demand.reduce((a, b) => a + b, 0));
		});

		it('falls back to the default 25 mm, with a warning, for a size that is not one', () => {
			for (const bad of [-1, Number.NaN, '10' as unknown as number]) {
				const out = run(fixture([30, 0], { effectiveRainStoreMm: bad }));
				expect(out.summary.warnings.some((w) => w.includes('soil-water store') && w.includes('using 25 mm'))).toBe(true);
				expect(get(out, 'F', 'demand')).toEqual(get(run(fixture([30, 0], { effectiveRainStoreMm: 25 })), 'F', 'demand'));
			}
		});
	});
});

describe('runModel — transfers', () => {
	const transfer = (over: Partial<Transfer> = {}): Transfer => ({
		id: 't1',
		fromNodeId: 'S',
		toNodeId: 'R',
		months: [1],
		maxRateM3s: 0.01, // 864 m³/day
		dailyCapM3: null,
		minStoragePct: 0.3,
		enabled: true,
		priority: 0,
		...over
	});
	// S and R (and R2 below) drain into the outflow gauge G.
	const nodes = () => [
		node('S', { areaKm2: 0, damCapacityM3: 10_000, damInitialPct: 0.4, downstreamNodeId: 'G' }),
		node('R', { areaKm2: 0, damCapacityM3: 10_000, sortOrder: 1, downstreamNodeId: 'G' }),
		node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 9 })
	];

	it("draws from the source's previous-day storage above the minimum, capped by the rate", () => {
		// S: start 4000, keep 3000 → day 0 moves min(1000, 864) = 864, day 1 moves 136, then nothing.
		const out = run({ nodes: nodes(), transfers: [transfer()], natural: [0, 0, 0], startDate: '2021-01-30' });
		expect(get(out, 'S', 'transfer')).toEqual([-864, -136, 0]);
		expect(get(out, 'R', 'transfer')).toEqual([864, 136, 0]);
		expect(get(out, 'S', 'dam_storage')).toEqual([3136, 3000, 3000]);
		expect(get(out, 'R', 'dam_storage')).toEqual([864, 1000, 1000]);
	});

	it('only runs in its months', () => {
		// 2021-01-31 is January, 2021-02-01 is not.
		const out = run({ nodes: nodes(), transfers: [transfer()], natural: [0, 0], startDate: '2021-01-31' });
		expect(get(out, 'R', 'transfer')).toEqual([864, 0]);
	});

	it('honours an explicit daily cap and the enabled flag', () => {
		const capped = run({
			nodes: nodes(),
			transfers: [transfer({ dailyCapM3: 100 })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(capped, 'R', 'transfer')).toEqual([100]);
		const off = run({
			nodes: nodes(),
			transfers: [transfer({ enabled: false })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(off, 'R', 'transfer')).toEqual([0]);
	});

	it('shares one dam between several transfers on the same day (never overdraws), lower priority first (Q18)', () => {
		// S: start 4000, keep 3000 → 1000 available. Two 864 m³/day rules from S:
		// priority 0 takes 864, priority 1 only the remaining 136. Before engine
		// 0.9 each rule saw yesterday's full storage and 1728 left the dam.
		const out = run({
			nodes: [...nodes(), node('R2', { areaKm2: 0, damCapacityM3: 10_000, sortOrder: 2, downstreamNodeId: 'G' })],
			// Listed second but served first would change nothing: the priority decides, not the list.
			transfers: [transfer({ id: 't2', toNodeId: 'R2', priority: 1 }), transfer({ priority: 0 })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(out, 'R', 'transfer')).toEqual([864]);
		expect(get(out, 'R2', 'transfer')).toEqual([136]);
		expect(get(out, 'S', 'transfer')).toEqual([-1000]);
		expect(get(out, 'S', 'dam_storage')).toEqual([3000]);
	});

	it("keeps the source dam's minimum operating level when it is above the rule's minimum (Q5, engine 0.16.0)", () => {
		// S: start 4000 of 10 000; rule keeps 30 %, the dam's own floor is 35 % → 3500 kept, 500 moves.
		const out = run({
			nodes: nodes().map((n) => (n.id === 'S' ? { ...n, damMinPct: 0.35 } : n)),
			transfers: [transfer()],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(out, 'R', 'transfer')).toEqual([500]);
		expect(get(out, 'S', 'dam_storage')).toEqual([3500]);
	});

	it('shares a dam pro rata to each rule\'s limit when the rules have the same priority, whatever the list order (Q18)', () => {
		// 1000 available; limits 864 and 432 (a 0.005 m³/s rule): 1000 × 864/1296 and 1000 × 432/1296.
		const both = (order: 1 | -1) =>
			run({
				nodes: [...nodes(), node('R2', { areaKm2: 0, damCapacityM3: 10_000, sortOrder: 2, downstreamNodeId: 'G' })],
				transfers: [transfer({ priority: 3 }), transfer({ id: 't2', toNodeId: 'R2', maxRateM3s: 0.005, priority: 3 })].sort(() => order),
				natural: [0],
				startDate: '2021-01-01'
			});
		for (const out of [both(1), both(-1)]) {
			expect(get(out, 'R', 'transfer')[0]).toBeCloseTo(2000 / 3, 9);
			expect(get(out, 'R2', 'transfer')[0]).toBeCloseTo(1000 / 3, 9);
			expect(get(out, 'S', 'dam_storage')[0]).toBeCloseTo(3000, 9);
		}
	});

	describe('rules of one priority from one dam keep each rule\'s own reserve (engine 1.36.0)', () => {
		// S: 1000 m³ dam, full. Each moving rule's limit is 400 m³/day.
		const rate = 400 / 86_400;
		const dests = ['R', 'R2', 'R3'].map((id, i) => node(id, { areaKm2: 0, damCapacityM3: 10_000, sortOrder: i + 1, downstreamNodeId: 'G' }));
		const withDests = () => [node('S', { areaKm2: 0, damCapacityM3: 1000, damInitialPct: 1, downstreamNodeId: 'G' }), ...dests, node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 9 })];
		const fx = (transfers: Transfer[], order: 1 | -1 = 1) => ({ nodes: withDests(), transfers: [...transfers].sort(() => order), natural: [0], startDate: '2021-01-01' });
		const go = (transfers: Transfer[], order: 1 | -1 = 1) => run(fx(transfers, order));

		it('a rule that moves nothing this month (rate 0) does not lower its siblings\' reserve', () => {
			const halves = [transfer({ id: 'a', maxRateM3s: rate, minStoragePct: 0.5 }), transfer({ id: 'b', toNodeId: 'R2', maxRateM3s: rate, minStoragePct: 0.5 })];
			const idle = transfer({ id: 'c', toNodeId: 'R3', maxRateM3s: 0, minStoragePct: 0 });
			for (const order of [1, -1] as const) {
				const alone = go(halves, order);
				const beside = go([...halves, idle], order);
				for (const out of [alone, beside]) {
					// 500 m³ above the 50 % reserve, shared evenly; 800 m³ moved before 1.36.0 with the idle rule beside them.
					expect(get(out, 'R', 'transfer')).toEqual([250]);
					expect(get(out, 'R2', 'transfer')).toEqual([250]);
					expect(get(out, 'R3', 'transfer')).toEqual([0]);
					expect(get(out, 'S', 'dam_storage')).toEqual([500]);
				}
				expect(beside.series.filter((s) => s.nodeId !== 'R3' && s.key !== 'transfer_rule@c')).toEqual(alone.series.filter((s) => s.nodeId !== 'R3'));
			}
		});

		it('a lower-reserve rule does not let a higher-reserve rule draw below its own reserve', () => {
			// a keeps 500, b keeps 0. The 500 m³ above 500 is shared pro rata to their limits (250 each);
			// below it only b may draw, up to its 400 limit (150 more). Before 1.36.0 both moved 400
			// and the dam ended at 200 m³, below a's reserve.
			for (const order of [1, -1] as const) {
				const out = go([transfer({ id: 'a', maxRateM3s: rate, minStoragePct: 0.5 }), transfer({ id: 'b', toNodeId: 'R2', maxRateM3s: rate, minStoragePct: 0 })], order);
				expect(get(out, 'R', 'transfer')).toEqual([250]);
				expect(get(out, 'R2', 'transfer')).toEqual([400]);
				expect(get(out, 'S', 'dam_storage')).toEqual([350]);
			}
		});

		it('the transfer self-check catches rules drawn below their own reserve (the pre-1.36.0 result)', () => {
			const f = fx([transfer({ id: 'a', maxRateM3s: rate, minStoragePct: 0.5 }), transfer({ id: 'b', toNodeId: 'R2', maxRateM3s: rate, minStoragePct: 0.5 }), transfer({ id: 'c', toNodeId: 'R3', maxRateM3s: 0, minStoragePct: 0 })]);
			const out = run(f);
			expect(checkTransferLimits(input(f), out)).toBeNull();
			// What engine 1.35.0 moved: 400 each, the dam left at 200, below both rules' 500. The farm
			// totals pass the per-farm check (the idle rule's 0 % is the lowest reserve); the rules don't.
			const old = structuredClone(out);
			const set = (nodeId: string, key: string, v: number) => (old.series.find((x) => x.nodeId === nodeId && x.key === key)!.values[0] = v);
			set('S', 'transfer', -800);
			set('S', 'transfer_rule@a', 400);
			set('S', 'transfer_rule@b', 400);
			set('R', 'transfer', 400);
			set('R2', 'transfer', 400);
			expect(checkTransferLimits(input(f), old)).toMatch(/S day 0: rule a .* sent 800 > storage 1000 − 0 sent first − its reserve = 500/);
		});

		it('three reserves: each band is shared by the rules allowed to reach it, pro rata to what each still wants', () => {
			// a keeps 800, b 500, c 0; limits 400, each asking its 400 (engine ≥ 1.70.0: not capped at the water
			// above its own reserve, issue #90 Q25; before, a asked MIN(400, 1000 − 800) = 200 → 40, 230, 400, 330).
			// Band 1000–800 (200): a, b, c, pro rata 400:400:400 → 66.67 each.
			// Band 800–500 (300): b and c, each still wanting 333.33 → 150 each.
			// Band 500–0: c alone, its remaining 183.33. The dam ends at 1000 − 683.33 = 316.67.
			for (const order of [1, -1] as const) {
				const out = go(
					[
						transfer({ id: 'a', maxRateM3s: rate, minStoragePct: 0.8 }),
						transfer({ id: 'b', toNodeId: 'R2', maxRateM3s: rate, minStoragePct: 0.5 }),
						transfer({ id: 'c', toNodeId: 'R3', maxRateM3s: rate, minStoragePct: 0 })
					],
					order
				);
				expect(get(out, 'R', 'transfer')[0]).toBeCloseTo(200 / 3, 9);
				expect(get(out, 'R2', 'transfer')[0]).toBeCloseTo(650 / 3, 9);
				expect(get(out, 'R3', 'transfer')[0]).toBeCloseTo(400, 9);
				expect(get(out, 'S', 'dam_storage')[0]).toBeCloseTo(950 / 3, 9);
			}
		});
	});

	it('moves at most each month\'s own rate, and nothing in a month whose rate is 0 (monthly rates, engine 1.14.0)', () => {
		// 30 Nov – 2 Dec: November's rate 0.001 m³/s (86.4 m³/day), December's 0.002 (172.8), January's 0 (off).
		const rates = [0, 0.001, 0.002, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const out = run({
			nodes: nodes(),
			transfers: [transfer({ ...withMonthlyRates(rates) })],
			natural: [0, 0, 0],
			startDate: '2020-11-30'
		});
		expect(get(out, 'R', 'transfer')).toEqual([86.4, 172.8, 172.8]);
		const jan = run({ nodes: nodes(), transfers: [transfer({ ...withMonthlyRates(rates) })], natural: [0], startDate: '2021-01-01' });
		expect(get(jan, 'R', 'transfer')).toEqual([0]);
		// The months and the max rate kept beside the list follow it.
		expect(withMonthlyRates(rates)).toEqual({ monthlyRateM3s: rates, months: [11, 12], maxRateM3s: 0.002 });
	});

	it('runs a rule written as monthly rates equal to its one rate in its months to the bit as before (engine 1.14.0)', () => {
		const one = transfer({ months: [1, 2, 12], maxRateM3s: 0.004 });
		const monthly = { ...one, ...withMonthlyRates(transferRatesM3s(one)) };
		expect(monthly.months).toEqual([1, 2, 12]);
		const a = run({ nodes: nodes(), transfers: [one], natural: [5, 0, 7, 1, 0], startDate: '2021-01-30' });
		const b = run({ nodes: nodes(), transfers: [monthly], natural: [5, 0, 7, 1, 0], startDate: '2021-01-30' });
		expect(b.series).toEqual(a.series);
	});

	it('caps a transfer at the destination\'s room: free space in its dam plus its demand that day (N4)', () => {
		// R's dam is 99 % full (9900 of 10 000) with no demand: only 100 m³ fits, none spills.
		const full = run({
			nodes: nodes().map((n) => (n.id === 'R' ? { ...n, damInitialPct: 0.99 } : n)),
			transfers: [transfer()],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(full, 'R', 'transfer')).toEqual([100]);
		expect(get(full, 'R', 'spill')).toEqual([0]);
		expect(get(full, 'S', 'dam_storage')).toEqual([3900]);
	});

	it('still serves the demand of a destination without a dam (N4)', () => {
		// R has no dam and needs 100 m³/day (1000 m² × 3100 mm ÷ 1000 ÷ 31 in January): the transfer brings exactly that.
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const out = run({
			nodes: nodes().map((n) => (n.id === 'R' ? { ...n, damCapacityM3: 0 } : n)),
			crops,
			cropAreas: [{ nodeId: 'R', cropId: 'c', areaM2: 1000 }],
			transfers: [transfer()],
			settings: { apanMm: flat(3100) as Monthly },
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(out, 'R', 'transfer')).toEqual([100]);
		expect(get(out, 'R', 'supplied')).toEqual([100]);
		expect(get(out, 'R', 'deficit')).toEqual([0]);
	});

	it("counts the destination dam's own losses today in its room (N4 with N2, engine 0.19.0; fuzz seed 921)", () => {
		// R: 900 of 1000 m³, dead storage 800, loses half its storage to seepage
		// (450) before irrigating, needs 100 m³/day. Room = 1000 − (900 − 450) +
		// 100 = 650, which S (1000 above its reserve, 864 a day) can send: R
		// irrigates in full and ends the day full. Up to 0.18.0 the room ignored
		// the seepage (1000 − 900 + 100 = 200): R had 450 + 200 = 650 m³, under
		// its dead storage, so it supplied nothing while S kept water it was free
		// to send. That shortfall (the seepage) did not grow with the demand, so
		// doubling R's crop area raised its supply fraction.
		const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
		const fixture = (areaM2: number) => ({
			nodes: nodes().map((n) => (n.id === 'R' ? { ...n, damCapacityM3: 1000, damInitialPct: 0.9, damMinPct: 0.8, damSeepagePerDay: 0.5 } : n)),
			crops,
			cropAreas: [{ nodeId: 'R', cropId: 'c', areaM2 }],
			transfers: [transfer()],
			settings: { apanMm: flat(3100) as Monthly },
			natural: [0],
			startDate: '2021-01-01'
		});
		const out = run(fixture(1000));
		expect(get(out, 'R', 'dam_seepage')).toEqual([450]);
		expect(get(out, 'R', 'transfer')).toEqual([650]);
		expect(get(out, 'R', 'supplied')).toEqual([100]);
		expect(get(out, 'R', 'deficit')).toEqual([0]);
		expect(get(out, 'R', 'dam_storage')).toEqual([1000]);
		expect(get(out, 'R', 'spill')).toEqual([0]);
		expect(checkTransferLimits(input(fixture(1000)), out)).toBeNull();
		// The transfers self-check reads the room the same way: the old 200 m³ is water held back.
		const held = structuredClone(out);
		held.series.find((s) => s.nodeId === 'S' && s.key === 'transfer')!.values[0] = -200;
		held.series.find((s) => s.nodeId === 'R' && s.key === 'transfer')!.values[0] = 200;
		expect(checkTransferLimits(input(fixture(1000)), held)).toMatch(/sent only 200; the rules and the destinations' room allowed 650/);
		// Twice the area is served in full too: the supply fraction stays 1.
		const doubled = run(fixture(2000));
		expect(get(doubled, 'R', 'transfer')).toEqual([750]);
		expect(get(doubled, 'R', 'supplied')).toEqual([200]);
	});

	it('shares a destination\'s room pro rata between two sources of the same priority (N4)', () => {
		// S and S2 both 1000 above their reserve; R has room for 300; limits 864 and 432 → 200 and 100.
		const out = run({
			nodes: [
				...nodes().map((n) => (n.id === 'R' ? { ...n, damCapacityM3: 1000, damInitialPct: 0.7 } : n)),
				node('S2', { areaKm2: 0, damCapacityM3: 10_000, damInitialPct: 0.4, sortOrder: 3, downstreamNodeId: 'G' })
			],
			transfers: [transfer(), transfer({ id: 't2', fromNodeId: 'S2', maxRateM3s: 0.005 })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(out, 'S', 'transfer')[0]).toBeCloseTo(-200, 9);
		expect(get(out, 'S2', 'transfer')[0]).toBeCloseTo(-100, 9);
		expect(get(out, 'R', 'dam_storage')[0]).toBeCloseTo(1000, 9);
		expect(get(out, 'R', 'spill')).toEqual([0]);
	});

	it('skips transfers involving a gauge, with a warning', () => {
		const out = run({
			nodes: nodes(),
			transfers: [transfer({ toNodeId: 'G' })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(out.summary.warnings.some((w) => w.includes('transfers must be between units'))).toBe(true);
	});
});

describe('shortfall (review F8)', () => {
	it('is MIN(a − b, 0), with float noise of the volumes involved reported as 0', () => {
		expect(shortfall(80, 100, 100)).toBe(-20);
		expect(shortfall(120, 100, 120)).toBe(0);
		// 5e9 − (5e9 + one ULP) is noise, not a shortfall: exactly the residue that
		// counted as a day "not met" depending on node order.
		const big = 5e9;
		const residue = big - (big + 1e-6);
		expect(residue).toBeLessThan(0);
		expect(shortfall(big, big + 1e-6, big)).toBe(0);
		// A real shortfall of 0.1 m³ on the same volumes is kept.
		expect(shortfall(big, big + 0.1, big)).toBeCloseTo(-0.1, 6);
	});

	it('makes upstream sums independent of node order', () => {
		// Three branches whose shortfalls cancel in exact arithmetic.
		const nodes = [
			node('G', { kind: 'gauge', areaKm2: 0 }),
			node('A', { downstreamNodeId: 'G', sortOrder: 1 }),
			node('B', { downstreamNodeId: 'G', sortOrder: 2 }),
			node('C', { downstreamNodeId: 'G', sortOrder: 3 })
		];
		const settings = { ewrPragmaticM3PerDay: flat(0.3) as Monthly };
		const a = run({ nodes, natural: [0.1 + 0.2], settings });
		const b = run({ nodes: [nodes[0]!, nodes[3]!, nodes[1]!, nodes[2]!].map((n, i) => ({ ...n, sortOrder: 9 - i })), natural: [0.1 + 0.2], settings });
		expect(get(b, 'G', 'ewr_shortfall')).toEqual(get(a, 'G', 'ewr_shortfall'));
		expect(get(a, 'G', 'ewr_shortfall')).toEqual([0]);
		expect(a.summary.catchment.ewrDaysNotMet).toBe(0);
	});
});

describe('runModel — EWR', () => {
	// X and Y are headwater farms draining into Z, which drains into gauge G.
	// Equal areas → each farm carries a third of the EWR.
	const nodes = [
		node('X', { downstreamNodeId: 'Z' }),
		node('Y', { downstreamNodeId: 'Z', sortOrder: 1, damCapacityM3: 1e9, pctRunoffToDam: 1 }),
		node('Z', { downstreamNodeId: 'G', sortOrder: 2 }),
		node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 3 })
	];
	// Natural 300 → 100 per farm. X passes its 100 on, Y stores its 100 (no outflow), Z adds 100.
	const out = run({
		nodes,
		natural: [300, 300],
		settings: { ewrPragmaticM3PerDay: flat(150) as Monthly }
	});

	it('fragments the EWR and accumulates it downstream', () => {
		expect(get(out, 'X', 'ewr')).toEqual([50, 50]);
		expect(get(out, 'Z', 'ewr_cumulative')).toEqual([150, 150]);
		expect(get(out, 'G', 'ewr_cumulative')).toEqual([150, 150]);
	});

	it('keeps the reach shortfall (AB) as a diagnostic, but charges no one while the EWR sites are met (Q17)', () => {
		expect(get(out, 'X', 'ewr_shortfall')).toEqual([0, 0]); // 100 out ≥ 50
		expect(get(out, 'Y', 'ewr_shortfall')).toEqual([-50, -50]); // 0 out < 50
		expect(get(out, 'Y', 'ewr_shortfall_incremental')).toEqual([-50, -50]);
		// Z: out 200 ≥ 150 → met; incremental = MIN(0 − (0 + −50), 0) = 0
		expect(get(out, 'Z', 'ewr_shortfall')).toEqual([0, 0]);
		expect(get(out, 'Z', 'ewr_shortfall_incremental')).toEqual([0, 0]);
		// Y is short on its own reach, but the only EWR site (the outlet gauge G)
		// is met, so Y is not charged: engine ≥ 0.17.0 (audit Q17). Before, AB
		// asked Y to cut 50 m³/day.
		expect(get(out, 'Y', 'ewr_charge')).toEqual([0, 0]);
		const y = out.summary.farms.find((f) => f.nodeId === 'Y')!;
		expect(y.avgEwrShortfallM3Day).toBe(0);
		expect(y.daysEwrNotMet).toBe(0);
		expect(get(out, null, 'ewr_charged')).toEqual([0, 0]);
		expect(get(out, null, 'ewr_natural')).toEqual([0, 0]);
	});

	it('charges a short outlet to the farms upstream, pro rata to their net impact (Q17)', () => {
		// EWR 250 at the outlet; outflow 200 → D = 50. Net impact: X 0 (passes its
		// 100 on), Y 100 (stores all of it), Z 0. Y carries all 50; nothing is natural.
		const short = run({ nodes, natural: [300, 300], settings: { ewrPragmaticM3PerDay: flat(250) as Monthly } });
		expect(get(short, null, 'ewr_shortfall')).toEqual([-50, -50]);
		expect(get(short, null, 'ewr_charged')).toEqual([-50, -50]);
		expect(get(short, null, 'ewr_natural')).toEqual([0, 0]);
		expect(get(short, 'Y', 'ewr_charge')).toEqual([-50, -50]);
		// Y has no irrigation: all of its charge is "store less / pass inflow".
		expect(get(short, 'Y', 'ewr_charge_irrigation')).toEqual([0, 0]);
		expect(get(short, 'X', 'ewr_charge')).toEqual([0, 0]);
		expect(get(short, 'Z', 'ewr_charge')).toEqual([0, 0]);
		const y = short.summary.curtailment!.farms.find((f) => f.nodeId === 'Y')!;
		expect([y.ewrShortfallM3Day, y.ewrChargeIrrigationM3Day, y.ewrChargeStorageM3Day, y.ewrSupplyCutM3Day, y.ewrBindingSiteId]).toEqual([-50, 0, -50, 0, 'G']);
		expect(short.summary.curtailment!.ewrSites).toEqual([
			{ nodeId: 'G', name: 'G', isOutlet: true, farmCount: 3, daysNotMet: 2, shortfallM3Day: -50, chargedM3Day: -50, naturalM3Day: 0 }
		]);
		// With EWR 350 the farms' total impact (100) is below the shortfall (150): the rest is natural.
		const drought = run({ nodes, natural: [300, 300], settings: { ewrPragmaticM3PerDay: flat(350) as Monthly } });
		expect(get(drought, null, 'ewr_charged')).toEqual([-100, -100]);
		expect(get(drought, null, 'ewr_natural')).toEqual([-50, -50]);
		expect(get(drought, 'Y', 'ewr_charge')).toEqual([-100, -100]);
	});

	it('counts catchment days where simulated outflow is below the EWR', () => {
		expect(get(out, null, 'ewr')).toEqual([150, 150]);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		const dry = run({ nodes, natural: [0, 300], settings: { ewrPragmaticM3PerDay: flat(150) as Monthly } });
		expect(dry.summary.catchment.ewrDaysNotMet).toBe(1);
		expect(get(dry, null, 'ewr_shortfall')).toEqual([-150, 0]);
	});
});

describe('runModel — EWR agreement with the observed record (issue #4)', () => {
	// One farm into gauge G; EWR 150 m³/day. Natural flow 100/300/100/300 → the
	// outflow is below the EWR on days 0 and 2. Observed (m³/s): below on 0 and 1.
	const nodes = [node('A', { downstreamNodeId: 'G' }), node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })];
	const settings = { ewrPragmaticM3PerDay: flat(150) as Monthly };
	const natural = [100, 300, 100, 300];

	it('cross-tabulates the outlet EWR test on observed days, next to ewrDaysNotMet', () => {
		const out = run({ nodes, natural, settings, observed: [50 / 86_400, 50 / 86_400, null, 300 / 86_400] });
		const a = out.summary.catchment.ewrAgreement!;
		expect(out.summary.catchment.ewrDaysNotMet).toBe(2);
		// Day 2 has no observation, so it is skipped even though the model fails it.
		expect(a.days).toBe(3);
		expect(a.overall).toMatchObject({ bothBelow: 1, falseAlarm: 0, miss: 1, bothAbove: 1 });
		expect(a.overall.hitRate).toBe(0.5);
		expect(a.overall.frequencyBias).toBe(0.5);
		expect(a.byMonth[3]!.days).toBe(3); // January
	});

	it('scores every observed day, not only the calibration window', () => {
		const out = run({
			nodes,
			natural,
			settings: { ...settings, calibrationStart: '2020-01-04', calibrationEnd: null },
			observed: [50 / 86_400, 50 / 86_400, 50 / 86_400, 300 / 86_400]
		});
		expect(out.summary.calibration!.days).toBe(1);
		expect(out.summary.catchment.ewrAgreement!.days).toBe(4);
	});

	it('is null without an observed record', () => {
		expect(run({ nodes, natural, settings }).summary.catchment.ewrAgreement).toBeNull();
	});

	it('uses the chosen logger record', () => {
		const i = input({ nodes, natural, settings, observed: [300 / 86_400, 300 / 86_400, 300 / 86_400, 300 / 86_400] });
		i.series.flow_logger_m3s = { startDate: '2020-01-01', values: [50 / 86_400, null, null, null] };
		i.settings.calibrationFlowKind = 'flow_logger_m3s';
		const a = runModelWith(i, () => ({ naturalFlowM3Day: natural })).summary.catchment.ewrAgreement!;
		expect(a.days).toBe(1);
		expect(a.overall.bothBelow).toBe(1);
	});
});

describe('runModel — EWR at a confluence gauge (audit G1)', () => {
	it("a gauge's shortfall is its own flow against its own requirement, not the sum of its branches' shortfalls", () => {
		// A stores all its runoff (outflow 0, 100 short of its 100 EWR share); B passes
		// its 200 (100 spare). At gauge G the flow 200 meets the EWR 200 — no shortfall.
		// The workbook's GaugeTemplate sums the branches' AA: −100.
		const out = run({
			nodes: [
				node('A', { downstreamNodeId: 'G', pctRunoffToDam: 1, damCapacityM3: 1e9 }),
				node('B', { downstreamNodeId: 'G', sortOrder: 1 }),
				node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 2 })
			],
			natural: [400],
			settings: { ewrPragmaticM3PerDay: flat(200) as Monthly }
		});
		expect(get(out, 'A', 'ewr_shortfall')).toEqual([-100]);
		expect(get(out, 'B', 'ewr_shortfall')).toEqual([0]);
		expect(get(out, 'G', 'outflow')).toEqual([200]);
		expect(get(out, 'G', 'ewr_cumulative')).toEqual([200]);
		expect(get(out, 'G', 'ewr_shortfall')).toEqual([0]);
		// Consistent with the catchment series at the outlet.
		expect(get(out, null, 'ewr_shortfall')).toEqual([0]);
	});
});

describe('runModel — curtailment report', () => {
	// D runs dry on day 1 (demand 100, dam 150): supplied [100, 50].
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
	const fixture = (settings: Partial<ProjectSettings> = {}): Fixture => ({
		nodes: [
			node('D', { damCapacityM3: 150, damInitialPct: 1, downstreamNodeId: 'W' }),
			node('W', { sortOrder: 1, damCapacityM3: 1e6, damInitialPct: 1 })
		],
		crops,
		cropAreas: [
			{ nodeId: 'D', cropId: 'c', areaM2: 1000 },
			{ nodeId: 'W', cropId: 'c', areaM2: 1000 }
		],
		settings: { apanMm: flat(3100) as Monthly, ...settings },
		natural: [0, 0],
		startDate: '2020-10-01'
	});

	it('covers the whole run by default and redistributes supply equitably', () => {
		const c = run(fixture()).summary.curtailment!;
		expect([c.reportStart, c.reportEnd, c.days]).toEqual(['2020-10-01', '2020-10-02', 2]);
		// D: demand 100, supplied ROUND(75) = 75; W: 100 / 100. Σ 175 / 200 = 0.875.
		expect(c.equitableFraction).toBe(0.875);
		expect(c.farms.map((f) => [f.name, f.targetM3Day, f.reduceGainM3Day])).toEqual([
			['D', 87.5, 12.5],
			['W', 87.5, -12.5]
		]);
	});

	it('honours settings.reportStart / reportEnd', () => {
		const c = run(fixture({ reportStart: '2020-10-01', reportEnd: '2020-10-01' })).summary.curtailment!;
		expect(c.days).toBe(1);
		expect(c.equitableFraction).toBe(1); // day 0: both farms fully supplied
		expect(c.farms.every((f) => f.reduceGainM3Day === 0)).toBe(true);
	});
});

describe('runModel — flow shares', () => {
	it('warns when manual shares do not sum to 1 and applies them anyway', () => {
		const out = run({
			nodes: [node('A', { flowShareManual: 0.5 }), node('B', { flowShareManual: 0.3, sortOrder: 1 })].map((n) =>
				n.id === 'A' ? { ...n, downstreamNodeId: 'B' } : n
			),
			settings: { flowShareMethod: 'manual' },
			natural: [1000]
		});
		expect(get(out, 'A', 'runoff')).toEqual([500]);
		expect(get(out, 'B', 'runoff')).toEqual([300]);
		expect(out.summary.warnings.some((w) => w.includes('sum to 80.00%'))).toBe(true);
	});

	it('refuses manual shares over 100 %: the farms would make water the catchment never had', () => {
		const over = () =>
			run({
				nodes: [node('A', { flowShareManual: 0.5 }), node('B', { flowShareManual: 0.6, sortOrder: 1 })].map((n) =>
					n.id === 'A' ? { ...n, downstreamNodeId: 'B' } : n
				),
				settings: { flowShareMethod: 'manual' },
				natural: [1000]
			});
		expect(over).toThrow(/sum to 110\.00%, more than 100%/);
	});

	it('refuses a high/low MAP split over 100 %, and runs one within the tolerance', () => {
		const nodes = [
			node('A', { downstreamNodeId: 'B', areaKm2: 4, areaHiKm2: 3, areaLoKm2: 1 }),
			node('B', { sortOrder: 1, areaKm2: 4, areaHiKm2: 1, areaLoKm2: 3 })
		];
		expect(() => run({ nodes, settings: { flowShareMethod: 'hiLo', hiLoSplit: { hi: 0.9, lo: 0.9 } }, natural: [1000] })).toThrow(/sum to 180\.00%/);
		const out = run({ nodes, settings: { flowShareMethod: 'hiLo', hiLoSplit: { hi: 0.6, lo: 0.4001 } }, natural: [1000] });
		expect(out.summary.warnings.some((w) => w.includes('flow shares sum'))).toBe(false);
	});

	it('hi/lo shares weight the high- and low-MAP areas by the split', () => {
		const out = run({
			nodes: [
				node('A', { downstreamNodeId: 'B', areaKm2: 4, areaHiKm2: 3, areaLoKm2: 1 }),
				node('B', { sortOrder: 1, areaKm2: 4, areaHiKm2: 1, areaLoKm2: 3 })
			],
			settings: { flowShareMethod: 'hiLo', hiLoSplit: { hi: 0.8, lo: 0.2 } },
			natural: [1000]
		});
		// A: 3/4 × 0.8 + 1/4 × 0.2 = 0.65; B: 0.35
		expect(get(out, 'A', 'runoff')[0]).toBeCloseTo(650, 9);
		expect(get(out, 'B', 'runoff')[0]).toBeCloseTo(350, 9);
		expect(out.summary.warnings.some((w) => w.includes('flow shares'))).toBe(false);
	});
});

describe('runModel — validation and window', () => {
	it('rejects a network with a cycle', () => {
		expect(() =>
			run({ nodes: [node('A', { downstreamNodeId: 'B' }), node('B', { downstreamNodeId: 'A' })], natural: [0] })
		).toThrow(/outflow node|cycle/);
	});

	it('rejects a network with more than one outflow node, whatever the array order', () => {
		// Without the check the outlet was whichever root came first (or the first
		// gauge), and the other root's water silently left the balance.
		const nodes = [node('A', { downstreamNodeId: 'G' }), node('G', { kind: 'gauge', areaKm2: 0 }), node('Lost', { sortOrder: 1 })];
		for (const order of [nodes, [...nodes].reverse()]) {
			expect(() => run({ nodes: order, natural: [0] })).toThrow(/2 outflow nodes \((G, Lost|Lost, G)\).*exactly one/);
			expect(() => buildTopology(order)).toThrow(/outflow nodes/);
		}
		// One root is fine; so is an empty network (no outlet at all).
		expect(buildTopology(nodes.slice(0, 2)).outflow).toBe(1);
		expect(buildTopology([]).outflow).toBe(-1);
	});

	it('rejects a link to an unknown node', () => {
		expect(() => run({ nodes: [node('A', { downstreamNodeId: 'nope' })], natural: [0] })).toThrow(/unknown node/);
	});

	it('needs a rainfall series to define the period', () => {
		const i = input({ nodes: [node('A')], natural: [0] });
		i.series = {};
		expect(() => runModelWith(i, () => ({ naturalFlowM3Day: [] }))).toThrow(/no rainfall series/);
		// A Pitman series left over from engine ≤ 0.9.0 no longer sets the period (audit P1).
		(i.series as Record<string, unknown>).flow_pitman_m3s = { startDate: '2020-01-01', values: [1, 1] };
		expect(() => runModelWith(i, () => ({ naturalFlowM3Day: [] }))).toThrow(/no rainfall series/);
	});

	it('honours simulationStart/End', () => {
		const i = input({ nodes: [node('A')], natural: [0, 0, 0, 0], startDate: '2020-01-01' });
		i.settings.simulationStart = '2020-01-02';
		i.settings.simulationEnd = '2020-01-03';
		let seen = 0;
		const out = runModelWith(i, (ctx) => {
			seen = ctx.days;
			return { naturalFlowM3Day: [5, 6] };
		});
		expect(seen).toBe(2);
		expect(out.startDate).toBe('2020-01-02');
		expect(get(out, null, 'natural_flow')).toEqual([5, 6]);
	});

	it('orders nodes upstream-first regardless of input order', () => {
		const t = buildTopology([
			node('G', { kind: 'gauge' }),
			node('B', { downstreamNodeId: 'G' }),
			node('A', { downstreamNodeId: 'B' })
		]);
		expect(Array.from(t.order)).toEqual([2, 1, 0]);
		expect(t.outflow).toBe(0);
	});
});

describe('runModel — calibration statistics', () => {
	it('compares simulated outflow with observed flow on overlapping days', () => {
		const out = run({
			nodes: [node('A')],
			natural: [86_400, 2 * 86_400, 3 * 86_400],
			observed: [1, null, 4]
		});
		const c = out.summary.calibration!;
		expect(c.days).toBe(2);
		expect(c.meanObservedM3s).toBe(2.5);
		expect(c.meanSimulatedM3s).toBe(2);
		expect(c.rmseM3s).toBeCloseTo(Math.sqrt(0.5), 12);
		expect(c.pbias).toBeCloseTo(20, 12); // 100 × (0 + 1) / 5
		expect(c.nse).toBeCloseTo(1 - 1 / 4.5, 12);
		expect(get(out, null, 'observed_flow')).toEqual([86_400, NaN, 345_600]);
	});

	it('scores only the calibration window and reports it', () => {
		const out = run({
			nodes: [node('A')],
			natural: [86_400, 2 * 86_400, 3 * 86_400],
			observed: [1, null, 4],
			settings: { calibrationStart: '2020-01-02', calibrationEnd: null }
		});
		const c = out.summary.calibration!;
		expect(c.days).toBe(1);
		expect(c.windowStart).toBe('2020-01-02');
		expect(c.windowEnd).toBe('2020-01-03');
		expect(c.flowKind).toBe('flow_observed_m3s');
		expect(c.annualVolumes).toHaveLength(1);
	});

	it('warns when the calibration window holds no observations', () => {
		const out = run({
			nodes: [node('A')],
			natural: [0, 0],
			observed: [1, 1],
			settings: { calibrationStart: '2030-01-01', calibrationEnd: '2030-12-31' }
		});
		expect(out.summary.calibration!.days).toBe(0);
		expect(out.summary.warnings).toContain('observed flow has no values inside the calibration window');
	});

	it('ignores an invalid or reversed calibration window with a warning', () => {
		const bad = run({ nodes: [node('A')], natural: [0], observed: [1], settings: { calibrationStart: '01/02/2020' } });
		expect(bad.summary.warnings.some((w) => /calibrationStart .* not an ISO date/.test(w))).toBe(true);
		expect(bad.summary.calibration!.days).toBe(1);
		const rev = run({
			nodes: [node('A')],
			natural: [0],
			observed: [1],
			settings: { calibrationStart: '2020-02-01', calibrationEnd: '2020-01-01' }
		});
		expect(rev.summary.warnings.some((w) => /ends before it starts/.test(w))).toBe(true);
		expect(rev.summary.calibration!.days).toBe(1);
	});

	it('calibrates against the configured flow record (workbook rUseFlow)', () => {
		const i = input({ nodes: [node('A')], natural: [86_400, 86_400], observed: [5, 5] });
		i.series.flow_logger_m3s = { startDate: '2020-01-01', values: [1, null] };
		const auto = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 86_400] }));
		expect(auto.summary.calibration!.flowKind).toBe('flow_observed_m3s');
		expect(auto.summary.calibration!.days).toBe(2);

		i.settings.calibrationFlowKind = 'flow_logger_m3s';
		const logger = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 86_400] }));
		expect(logger.summary.calibration!.flowKind).toBe('flow_logger_m3s');
		expect(logger.summary.calibration!.days).toBe(1);
		expect(logger.series.find((s) => s.key === 'observed_flow')!.label).toBe('Observed flow (logger)');

		delete i.series.flow_logger_m3s;
		const missing = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 86_400] }));
		expect(missing.summary.calibration!.flowKind).toBe('flow_observed_m3s');
		expect(missing.summary.warnings.some((w) => /flow_logger_m3s.*missing/.test(w))).toBe(true);

		// A Pitman record chosen under engine ≤ 0.9.0 is no longer a calibration record (audit P1).
		(i.settings as Record<string, unknown>).calibrationFlowKind = 'flow_pitman_m3s';
		(i.series as Record<string, unknown>).flow_pitman_m3s = { startDate: '2020-01-01', values: [1, 1] };
		const stale = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 86_400] }));
		expect(stale.summary.calibration!.flowKind).toBe('flow_observed_m3s');
		expect(stale.summary.warnings).toContain('unknown calibration flow series "flow_pitman_m3s"; using the default');
	});

	it('writes the other flow record beside the calibration record, labelled by source, never scored (issue #45)', () => {
		const nat = () => ({ naturalFlowM3Day: [86_400, 86_400] });
		const i = input({ nodes: [node('A')], natural: [86_400, 86_400], observed: [5, 5] });
		const only = runModelWith(i, nat);
		expect(only.series.find((s) => s.key === 'observed_flow')!.label).toBe('Observed flow');
		expect(only.series.some((s) => s.key === 'observed_flow_other')).toBe(false);

		i.series.flow_logger_m3s = { startDate: '2020-01-01', values: [1, null] };
		i.settings.calibrationFlowKind = 'flow_logger_m3s';
		const both = runModelWith(i, nat);
		const obs = both.series.find((s) => s.key === 'observed_flow')!;
		const other = both.series.find((s) => s.key === 'observed_flow_other')!;
		expect([obs.label, other.label]).toEqual([OBSERVED_SERIES_LABEL.flow_logger_m3s, OBSERVED_SERIES_LABEL.flow_observed_m3s]);
		expect(obs.values[0]).toBe(86_400);
		expect(Number.isNaN(obs.values[1])).toBe(true);
		expect(other.values).toEqual([5 * 86_400, 5 * 86_400]);
		// Only the calibration record is scored.
		expect(both.summary.calibration!.flowKind).toBe('flow_logger_m3s');
		expect(both.summary.calibration!.days).toBe(1);
		// No fit record: the scores are not in-sample.
		expect(both.summary.calibration!.fitStatus).toBe('notFitted');
	});

	it('warns once when it picks the gauge by default over a logger (issue #1)', () => {
		const nat = () => ({ naturalFlowM3Day: [86_400, 86_400] });
		const i = input({ nodes: [node('A')], natural: [86_400, 86_400], observed: [5, 5] });
		i.series.flow_logger_m3s = { startDate: '2020-01-01', values: [1, 1] };
		const auto = runModelWith(i, nat);
		expect(auto.summary.calibration!.flowKind).toBe('flow_observed_m3s');
		expect(auto.summary.warnings.filter((w) => w === DEFAULT_GAUGE_PICK_WARNING)).toHaveLength(1);
		expect(DEFAULT_GAUGE_PICK_WARNING).toMatch(/Settings → calibration flow series/);

		// Positive controls: a chosen record (either one) gets no default-pick warning.
		for (const kind of ['flow_observed_m3s', 'flow_logger_m3s'] as const) {
			i.settings.calibrationFlowKind = kind;
			const chosen = runModelWith(i, nat);
			expect(chosen.summary.calibration!.flowKind).toBe(kind);
			expect(chosen.summary.warnings).not.toContain(DEFAULT_GAUGE_PICK_WARNING);
		}

		// Only one of the two records: nothing to choose between, so no warning.
		i.settings.calibrationFlowKind = null;
		delete i.series.flow_logger_m3s;
		expect(runModelWith(i, nat).summary.warnings).not.toContain(DEFAULT_GAUGE_PICK_WARNING);
	});

	it('pickObservedKind: default order and the default-pick warning', () => {
		const s = (v: number[]) => ({ startDate: '2020-01-01', values: v });
		const w: string[] = [];
		expect(pickObservedKind(null, { flow_observed_m3s: s([1]), flow_logger_m3s: s([1]) }, w)).toBe('flow_observed_m3s');
		expect(w).toEqual([DEFAULT_GAUGE_PICK_WARNING]);
		const none: string[] = [];
		expect(pickObservedKind(null, { flow_logger_m3s: s([1]) }, none)).toBe('flow_logger_m3s');
		expect(pickObservedKind(null, { flow_observed_m3s: s([1]) }, none)).toBe('flow_observed_m3s');
		expect(pickObservedKind(null, {}, none)).toBeNull();
		expect(pickObservedKind('flow_logger_m3s', { flow_observed_m3s: s([1]), flow_logger_m3s: s([1]) }, none)).toBe('flow_logger_m3s');
		expect(none).toEqual([]);
	});

	it('scores a gauge or logger record against the impacted outflow, not natural flow', () => {
		// A's dam keeps every drop, so the outflow is 0 while natural flow matches the record.
		const i = input({
			nodes: [node('A', { pctRunoffToDam: 1, damCapacityM3: 1e9 })],
			natural: [86_400, 2 * 86_400, 3 * 86_400],
			observed: [1, 2, 3]
		});
		const c = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 2 * 86_400, 3 * 86_400] })).summary.calibration!;
		expect(c.simulatedKey).toBe('simulated_outflow');
		expect(c.pbias).toBeCloseTo(100, 12);
	});

	it('returns null NSE when observations are constant', () => {
		expect(calibrationStats([86_400, 86_400], [1, 1]).nse).toBeNull();
		expect(calibrationStats([1], [null]).days).toBe(0);
	});
});

describe('runModel — input data quality', () => {
	it('compares gauge and logger with the project thresholds', () => {
		const days = 120;
		const i = input({ nodes: [node('A')], natural: new Array(days).fill(0), observed: new Array(days).fill(0.8) });
		i.series.flow_logger_m3s = { startDate: '2020-01-01', values: new Array(days).fill(1) };
		const dq = (o: ReturnType<typeof run>) => o.summary.dataQuality!.observedAgreement!;
		const nat = () => ({ naturalFlowM3Day: new Array(days).fill(0) });
		const byDefault = runModelWith(i, nat);
		expect(dq(byDefault)).toMatchObject({ minRatio: 2 / 3, maxRatio: 1.5, minDays: 90, flaggedYears: [] });
		i.settings.dataQuality = { ...defaultProjectSettings().dataQuality, agreementMinRatio: 0.9, agreementMaxRatio: 1.1, agreementMinDays: 60 };
		const strict = runModelWith(i, nat);
		expect(dq(strict)).toMatchObject({ minRatio: 0.9, maxRatio: 1.1, minDays: 60, flaggedYears: [2019] });
		expect(strict.summary.warnings.some((w) => /Observed flow records disagree.*expected 90–110 %/.test(w))).toBe(true);
		// A bad stored value falls back to the default with a warning instead of failing the run.
		i.settings.dataQuality = { ...i.settings.dataQuality!, agreementMinRatio: 3 };
		const bad = runModelWith(i, nat);
		expect(dq(bad).minRatio).toBe(2 / 3);
		expect(bad.summary.warnings.some((w) => /agreementMinRatio = 3 is invalid/.test(w))).toBe(true);
	});

	it('reports negative, outlying and flat input values as warnings and in dataQuality', () => {
		const rain = Array.from({ length: 400 }, (_, t) => (t % 2 ? 0 : 1 + (t % 13)));
		rain[3] = -4;
		rain[100] = 5000;
		const out = run({ nodes: [node('A')], natural: new Array(400).fill(0), rain });
		const checks = out.summary.dataQuality!.seriesChecks!;
		expect(checks.map((c) => [c.seriesKind, c.check])).toEqual([
			['rain_catchment_mm', 'negative'],
			['rain_catchment_mm', 'outlier']
		]);
		for (const c of checks) expect(out.summary.warnings).toContain(c.text);
	});

	it('warns about zero catchment rain that may be missing data (issue #2)', () => {
		// Three years of synthetic winter rain (6 mm every other day April to
		// September, 1 mm every sixth day otherwise) with zeros from 1 June to
		// 15 August 2021. CHIRPS has 2 mm every other day throughout.
		const days = 3 * 365;
		const d0 = toEpochDay('2020-01-01');
		const rain = Array.from({ length: days }, (_, t) => {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			return m >= 4 && m <= 9 ? (t % 2 ? 0 : 6) : t % 6 ? 0 : 1;
		});
		const a = toEpochDay('2021-06-01') - d0;
		const b = toEpochDay('2021-08-15') - d0;
		for (let t = a; t <= b; t++) rain[t] = 0;
		rain[a - 1] = rain[b + 1] = 6;
		const i = input({ nodes: [node('A')], natural: new Array(days).fill(0), rain });
		i.series.rain_chirps_mm = { startDate: '2020-01-01', values: Array.from({ length: days }, (_, t) => (t % 2 ? 0 : 2)) };
		const out = runModelWith(i, () => ({ naturalFlowM3Day: new Array(days).fill(0) }));
		const checks = out.summary.dataQuality!.seriesChecks!;
		expect(checks.map((c) => c.check)).toEqual(['zerorun']);
		expect(checks[0]!.examples[0]).toMatchObject({ date: '2021-06-01', endDate: '2021-08-15', runDays: 76 });
		expect(out.summary.warnings).toContain(checks[0]!.text);
		expect(checks[0]!.text).toMatch(/blocks the fallback to CHIRPS/);
	});

	it('warns when a farm area and its hi + lo areas differ by more than 1 % (F7)', () => {
		const out = run({
			nodes: [node('A', { areaKm2: 10, areaHiKm2: 6, areaLoKm2: 3 }), node('B', { areaKm2: 5, areaHiKm2: 4, areaLoKm2: 1, downstreamNodeId: 'A' })],
			natural: [0]
		});
		expect(out.summary.dataQuality!.areaMismatches!.map((m) => m.nodeId)).toEqual(['A']);
		expect(out.summary.warnings.some((w) => /A: 10 km² vs 9 km²/.test(w))).toBe(true);
	});
});

describe('runModel — end to end with the rain model', () => {
	it('produces natural flow from rain and runs the network', () => {
		const days = 60;
		const rain = Array.from({ length: days }, (_, i) => (i % 10 === 0 ? 30 : 0));
		const i = input({ nodes: [node('A', { downstreamNodeId: 'G' }), node('G', { kind: 'gauge' })], natural: [] });
		i.series = { rain_catchment_mm: { startDate: '2020-06-01', values: rain } };
		i.settings.apanMm = [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110]; // GR4J needs evaporation
		const out = runModel(i);
		expect(out.days).toBe(days);
		const nat = get(out, null, 'natural_flow');
		expect(nat).toHaveLength(days);
		expect(nat.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
		expect(Math.max(...nat)).toBeGreaterThan(0);
		// A is the only farm: its runoff is the whole natural flow, passed straight through.
		expect(get(out, 'G', 'outflow')).toEqual(nat);
	});
});

// ---------------------------------------------------------------------------
// Workbook regression — client catchment (client data, local only)
// ---------------------------------------------------------------------------

const clientCatchmentFixture = await loadClientCatchmentFixture();

describe.skipIf(!clientCatchmentFixture)(
	'workbook regression: client catchment (needs data/client-catchment from scripts/wbt-import/extract_project.py)',
	() => {
		// vitest still runs a skipped describe's body to collect its tests: don't
		// read the (absent) fixtures then, but register one test so the run
		// reports the suite as skipped rather than silently empty.
		if (!clientCatchmentFixture) {
			it('needs data/client-catchment', () => {});
			return;
		}
		const { project, expected, modelInput, natural, chirpsFallback } = clientCatchmentFixture;
		// Timing: see run.perf.test.ts, which builds the same fixture and takes
		// the median of several runs against a budget — the unit suite here
		// asserts nothing about wall-clock time (docs/followups.md, 2026-09-24).
		const out = runModelWith(modelInput, () => ({ naturalFlowM3Day: natural }));
		const idByName = new Map(project.model.nodes.map((n) => [n.name, n.id]));
		const nodeByName = new Map(project.model.nodes.map((n) => [n.name, n]));
		const topo = buildTopology(project.model.nodes);
		// N1 (engine ≥ 0.16.0): a farm's return flow % r becomes irrigation
		// efficiency e = 1 − r with every loss returning (migration 006, which
		// runModel also applies to an older fixture's returnFlowPct; the current
		// importer writes e and β itself, e < 1 exactly where r > 0). The crop is then
		// fully supplied, so the farm abstracts F / (1 − r) where the workbook
		// abstracted F: supplied and everything it feeds differ. Affected: every
		// farm with r > 0, everything downstream of one, and both ends of a
		// transfer touching an affected dam.
		const n1Affected = (() => {
			const legacy = project.model.nodes as unknown as {
				id: string;
				downstreamNodeId: string | null;
				returnFlowPct?: number;
				irrigationEfficiency?: number;
			}[];
			// An extract from either importer: returnFlowPct (before engine 0.16.0) or irrigationEfficiency.
			const hit = new Set(legacy.filter((n) => (n.returnFlowPct ?? 0) > 0 || (n.irrigationEfficiency ?? 1) < 1).map((n) => n.id));
			for (let grown = true; grown; ) {
				grown = false;
				const add = (id: string | null | undefined) => {
					if (id && !hit.has(id)) {
						hit.add(id);
						grown = true;
					}
				};
				for (const n of legacy) if (hit.has(n.id)) add(n.downstreamNodeId);
				for (const t of project.model.transfers) {
					if (hit.has(t.fromNodeId)) add(t.toNodeId);
					if (hit.has(t.toNodeId)) add(t.fromNodeId);
				}
			}
			return hit;
		})();
		// The N1 replay: the workbook abstracted F and returned r·G; with e = 1 − r
		// and β = 1 the engine abstracts F ÷ e and returns β(1 − e)·G = r·G. A
		// demand factor of e on those farms (NetworkNode.demandFactor scales F
		// before the ÷ e) makes the engine abstract F again, so its supplied,
		// return flow and everything downstream are the workbook's again, and
		// the N1 columns are compared against this run instead of skipped. That
		// needs β = 1, which is what migration 006 and the importer write for
		// r > 0; the "N1 replay" test fails on any N1 farm without it.
		// An older extract carries returnFlowPct only: take e and β as migration 006 does.
		const irrigation = (n: NetworkNode) => {
			const r = (n as NetworkNode & { returnFlowPct?: number }).returnFlowPct;
			return n.irrigationEfficiency === undefined && r !== undefined
				? irrigationFromReturnFlow(r)
				: { irrigationEfficiency: n.irrigationEfficiency ?? 1, lossReturnFraction: n.lossReturnFraction ?? 0 };
		};
		const replaysN1 = (n: NetworkNode) => irrigation(n).irrigationEfficiency < 1 && irrigation(n).lossReturnFraction === 1;
		const n1Input: ModelInput = {
			...modelInput,
			model: {
				...modelInput.model,
				nodes: modelInput.model.nodes.map((n) =>
					replaysN1(n) ? { ...n, ...irrigation(n), demandFactor: Array<number>(12).fill(irrigation(n).irrigationEfficiency) } : n
				)
			}
		};
		const outN1 = runModelWith(n1Input, () => ({ naturalFlowM3Day: natural }));
		const outletId = topo.outflow >= 0 ? project.model.nodes[topo.outflow]!.id : '';
		const outletN1 = n1Affected.has(outletId);
		const N1_KEYS = new Set(['supplied', 'deficit', 'inflow_upstream', 'transfer', 'dam_storage', 'spill', 'outflow', 'ewr_shortfall', 'ewr_shortfall_incremental']);
		// N4 (engine ≥ 0.16.0): a transfer is capped at the destination's room,
		// where the workbook pours into a full dam that spills. The N1 replay
		// can't undo that (no input sets a transfer's volume), so where the room
		// binds, the transfer, both ends' state and the timing of what flows on
		// differ from the workbook. The volume doesn't: what the engine leaves in
		// the source spills there instead. So on both ends, and below one end
		// only, the N1 columns are skipped; below the node where the ends' flows
		// join, outflow and inflow_upstream are still compared (mean) and only
		// the columns that depend on the day are skipped.
		const N4_TIMING_KEYS = new Set(['supplied', 'deficit', 'transfer', 'dam_storage', 'spill', 'ewr_shortfall', 'ewr_shortfall_incremental']);
		const nodeById = new Map(project.model.nodes.map((n) => [n.id, n]));
		const downstreamOf = (id: string) => {
			const below = new Set<string>();
			for (let d = nodeById.get(id)?.downstreamNodeId; d && !below.has(d); d = nodeById.get(d)?.downstreamNodeId) below.add(d);
			return below;
		};
		const n4Ends = new Set<string>();
		const n4OneEnd = new Set<string>();
		const n4Joined = new Set<string>();
		for (const t of project.model.transfers.filter((r) => r.enabled !== false)) {
			n4Ends.add(t.fromNodeId).add(t.toNodeId);
			const a = downstreamOf(t.fromNodeId);
			const b = downstreamOf(t.toNodeId);
			for (const id of new Set([...a, ...b])) (a.has(id) && b.has(id) ? n4Joined : n4OneEnd).add(id);
		}
		for (const id of n4Ends) n4OneEnd.delete(id);
		for (const id of [...n4Ends, ...n4OneEnd]) n4Joined.delete(id);
		const index = new Map(project.model.nodes.map((n, i) => [n.id, i]));
		const farmCount = (i: number): number =>
			(project.model.nodes[i]!.kind === 'farm' ? 1 : 0) + Array.from(topo.upstream[i]!).reduce((s, u) => s + farmCount(u), 0);
		const croppedM2 = (id: string) => project.model.cropAreas.filter((c) => c.nodeId === id).reduce((s, c) => s + c.areaM2, 0);
		/** Confluence gauges: the workbook's gauge summed its branches' AA (audit G1). */
		const confluenceGauge = (i: number) => project.model.nodes[i]!.kind === 'gauge' && topo.upstream[i]!.length > 1;

		// -------------------------------------------------------------------------
		// DEVIATION LIST — where engine ≥ 0.4.0 differs from the workbook on purpose
		// (docs/engine-audit.md). Up to 0.3.1 every column below matched exactly.
		//
		//   exact  the algorithm is unchanged and nothing is rounded: equal to 1e-6.
		//   daily  differs only by the workbook's ROUND steps (R1): every day,
		//          |engine − workbook| ≤ the sum of the half-units those steps drop.
		//   mean   a state that carries from day to day (storage and all that is
		//          routed through it) or depends on one: the workbook's rounding
		//          (R1) shifts the state and the shift propagates, so compare the
		//          whole-run mean: |Δmean| ≤ 1 % of mean|workbook| + 1 m³/day.
		//   skip   not comparable, with the reason.
		//
		//   B1     (engine ≥ 0.7.0) CHIRPS used as fallback rain is bias-corrected
		//          per calendar month. Demand is compared per day except on the
		//          fallback days (natural flow end to end was compared year by
		//          year until engine 1.0.0 removed the legacy model; see the
		//          RETIRED note below). The mean columns fed by demand
		//          (supplied, deficit, …) stay within their R1 bound.
		//   N3     (engine ≥ 0.14.0) effective rain carries over through a
		//          soil-water store (default 25 mm). Demand, and everything fed
		//          by it (supplied, deficit, storage, spill, outflow, the EWR
		//          shortfalls, curtailment), differ on the days after rain. Every
		//          comparison here runs with effectiveRainStoreMm: 0, the
		//          workbook's rule; the "N3:" test checks the store's effect.
		//   B2     (engine ≥ 0.15.0) flagged zero-rain runs in the catchment rain
		//          are treated as missing, so corrected CHIRPS fills them. Rain
		//          used, natural flow, demand and everything downstream differ
		//          in and after those runs. Every comparison here runs with
		//          zeroRainRuns.mode 'asRecorded', the workbook's rule; the "B2:"
		//          test checks what the default sets aside.
		//
		//   N1     (engine ≥ 0.16.0) abstraction demand = crop requirement ÷
		//          irrigation efficiency; return flow = β (1 − e) × supplied.
		//          Workbook F is compared with `crop_requirement` (daily, R1).
		//          supplied, deficit, inflow_upstream, transfer, dam_storage,
		//          spill, outflow, ewr_shortfall and ewr_shortfall_incremental
		//          on the nodes n1Affected names, and the catchment outflow and
		//          EWR-not-met when the outlet is one, come from the N1 replay
		//          (outN1: a demand factor of e, so D = F and T = r·G).
		//   N4     (engine ≥ 0.16.0) a transfer is capped at the destination's
		//          room. The replay can't undo it: the N1 columns are skipped on
		//          both ends and below only one end (n4Ends, n4OneEnd), and
		//          below the join only the day-dependent ones (n4Joined).
		//
		//   N2     (engine ≥ 0.16.0) dams evaporate, seep and catch the rain on
		//          their surface. Every comparison here runs with each dam's
		//          area 0 m² and seepage 0, which is the workbook's dam bit for
		//          bit; the "N2:" test checks the losses with estimated areas.
		// -------------------------------------------------------------------------
		type Rule =
			| { kind: 'exact' }
			| { kind: 'daily'; bound: number; except?: { days: Uint8Array; why: 'B1' } }
			| { kind: 'mean' }
			| { kind: 'skip'; why: string };
		const MEAN_REL = 0.01;
		const MEAN_ABS = 1;
		function nodeRule(name: string, key: string): Rule {
			const n = nodeByName.get(name)!;
			const i = index.get(n.id)!;
			if ((n4Ends.has(n.id) || n4OneEnd.has(n.id)) && N1_KEYS.has(key)) return { kind: 'skip', why: 'N4' };
			if (n4Joined.has(n.id) && N4_TIMING_KEYS.has(key)) return { kind: 'skip', why: 'N4' };
			switch (key) {
				case 'demand':
					// R1: net ROUND(,0) 0.5 + farm ROUND(,1) 0.05 + crop mm ROUND(,2) 0.005 mm on the cropped area.
					// B1: the effective-rain offset uses bias-corrected CHIRPS on fallback days.
					return {
						kind: 'daily',
						bound: 0.55 + (croppedM2(n.id) * 0.005) / 1000 / 28 + 1e-6,
						except: { days: chirpsFallback, why: 'B1' }
					};
				case 'runoff':
				case 'ewr':
					return { kind: 'daily', bound: 0.5 + 1e-6 }; // R1: ROUND(value × share, 0)
				case 'ewr_cumulative':
					return { kind: 'daily', bound: 0.5 * farmCount(i) + 1e-6 }; // R1: one ROUNDed fragment per farm at or above
				case 'ewr_shortfall':
					// G1: a confluence gauge's shortfall is MIN(U − Z, 0), not Σ branch AA; checked separately below.
					return confluenceGauge(i) ? { kind: 'skip', why: 'G1' } : { kind: 'mean' };
				case 'ewr_shortfall_incremental':
					// G1: AB = MIN(AA − Σ upstream AA, 0) reads the AA of a confluence gauge directly upstream.
					return Array.from(topo.upstream[i]!).some(confluenceGauge) ? { kind: 'skip', why: 'G1' } : { kind: 'mean' };
				default:
					// supplied, deficit, inflow_upstream, transfer, dam_storage, spill, outflow: R1 via the state.
					return { kind: 'mean' };
			}
		}

		function compare(actual: ArrayLike<number>, want: (number | null)[], rule: Rule): string | null {
			if (rule.kind === 'skip') return null;
			const n = want.length;
			if (rule.kind === 'mean') {
				let a = 0;
				let w = 0;
				let wAbs = 0;
				for (let t = 0; t < n; t++) {
					a += actual[t]!;
					w += want[t] ?? 0;
					wAbs += Math.abs(want[t] ?? 0);
				}
				const d = Math.abs(a - w) / n;
				const bound = (MEAN_REL * wAbs) / n + MEAN_ABS;
				return d <= bound ? null : `mean differs by ${d.toFixed(3)} m³/day (bound ${bound.toFixed(3)}): engine ${(a / n).toFixed(3)} vs workbook ${(w / n).toFixed(3)}`;
			}
			const bound = rule.kind === 'exact' ? 1e-6 : rule.bound;
			let bad = 0;
			let first = -1;
			let worst = 0;
			const except = rule.kind === 'daily' ? rule.except?.days : undefined;
			for (let t = 0; t < n; t++) {
				if (except?.[t]) continue;
				const d = Math.abs(actual[t]! - (want[t] ?? 0));
				worst = Math.max(worst, d);
				if (!(d <= bound)) {
					bad++;
					if (first < 0) first = t;
				}
			}
			return bad === 0 ? null : `${bad} days beyond ±${bound}, worst ${worst}, first day ${first}: engine ${actual[first]} vs workbook ${want[first]}`;
		}

		it('covers the same period as the workbook', () => {
			expect(out.startDate).toBe(expected.startDate);
			expect(out.days).toBe(expected.days);
		});

		const keys = [
			'demand',
			'supplied',
			'inflow_upstream',
			'runoff',
			'transfer',
			'dam_storage',
			'spill',
			'outflow',
			'deficit',
			'ewr',
			'ewr_cumulative',
			'ewr_shortfall',
			'ewr_shortfall_incremental'
		];
		for (const [name, want] of Object.entries(expected.nodes)) {
			it(`matches Element sheet "${name}" within the deviation list`, () => {
				const id = idByName.get(name)!;
				const report: Record<string, string> = {};
				for (const key of keys) {
					if (!(key in want) || (want.kind === 'gauge' && !['outflow', 'ewr_cumulative', 'ewr_shortfall'].includes(key)))
						continue;
					// The workbook's F is the crop requirement; the engine's `demand` is F ÷ efficiency (N1).
					const engineKey = key === 'demand' && want.kind !== 'gauge' ? 'crop_requirement' : key;
					// N1: the columns F ÷ e moves come from the N1 replay (outN1) on the nodes it reaches.
					const from = n1Affected.has(id) && N1_KEYS.has(key) ? outN1 : out;
					const bad = compare(get(from, id, engineKey), want[key]!, nodeRule(name, key));
					if (bad) report[key] = bad;
				}
				expect(report).toEqual({});
			});
		}

		it("N1 replay: a replayed farm abstracts the workbook's F and returns r·G, as the workbook does", () => {
			// The replay's demand factor applies from day one (settings.demandFactorFrom unset).
			expect(n1Input.settings.demandFactorFrom ?? null).toBeNull();
			// Every farm N1 touches replays (β = 1), so no N1 column is skipped for N1.
			expect(modelInput.model.nodes.filter((n) => irrigation(n).irrigationEfficiency < 1 && !replaysN1(n)).map((n) => n.name)).toEqual([]);
			const replayed = modelInput.model.nodes.filter(replaysN1);
			if (n1Affected.size > 0) expect(replayed.length).toBeGreaterThan(0);
			const bad: string[] = [];
			for (const n of replayed) {
				const r = 1 - irrigation(n).irrigationEfficiency;
				const F = get(out, n.id, 'crop_requirement');
				const D = get(outN1, n.id, 'demand');
				const G = get(outN1, n.id, 'supplied');
				const T = get(outN1, n.id, 'return_flow');
				for (let t = 0; t < D.length; t++) {
					const tol = 1e-9 * Math.max(1, F[t]!);
					if (Math.abs(D[t]! - F[t]!) > tol || Math.abs(T[t]! - r * G[t]!) > tol) {
						bad.push(`${n.name} day ${t}: D ${D[t]} vs F ${F[t]}, T ${T[t]} vs r·G ${r * G[t]!}`);
						break;
					}
				}
			}
			expect(bad).toEqual([]);
			expect(withVerification(n1Input, outN1).summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		});

		it('N1 replay: the N1 columns on N1 nodes are compared, not all skipped', () => {
			// Guards the coverage the replay restored against a skip set that grows to cover everything.
			let compared = 0;
			for (const [name, want] of Object.entries(expected.nodes)) {
				if (want.kind === 'gauge' || !n1Affected.has(idByName.get(name)!)) continue;
				for (const key of N1_KEYS) if (key in want && nodeRule(name, key).kind !== 'skip') compared++;
			}
			if (n1Affected.size > n4Ends.size + n4OneEnd.size) expect(compared).toBeGreaterThan(0);
		});

		it('G1: every gauge reports its own shortfall MIN(flow − cumulative EWR, 0)', () => {
			for (const n of project.model.nodes.filter((x) => x.kind === 'gauge')) {
				const U = get(out, n.id, 'outflow');
				const Z = get(out, n.id, 'ewr_cumulative');
				expect(get(out, n.id, 'ewr_shortfall')).toEqual(U.map((u, t) => Math.min(u - Z[t]!, 0)));
			}
		});

		it('N3: the soil-water store only lowers demand, and only on days it starts with water in it', () => {
			const withStore: ModelInput = { ...modelInput, settings: { ...modelInput.settings, effectiveRainStoreMm: defaultProjectSettings().effectiveRainStoreMm } };
			const on = withVerification(withStore, runModelWith(withStore, () => ({ naturalFlowM3Day: natural })));
			expect(on.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
			let lowered = 0;
			const bad: string[] = [];
			for (const n of project.model.nodes.filter((x) => x.kind === 'farm')) {
				const dOn = get(on, n.id, 'demand');
				const dOff = get(out, n.id, 'demand');
				const store = get(on, n.id, 'soil_water');
				for (let t = 0; t < dOn.length; t++) {
					const carried = t > 0 && store[t - 1]! > 0;
					if (carried ? dOn[t]! > dOff[t]! : !Object.is(dOn[t], dOff[t])) bad.push(`${n.name} day ${t}: ${dOn[t]} vs ${dOff[t]}`);
					if (dOn[t]! < dOff[t]!) lowered++;
				}
			}
			expect(bad.slice(0, 5)).toEqual([]);
			expect(lowered).toBeGreaterThan(0);
		});

		it('N2: with the estimated dam areas every self-check passes, the dams evaporate, and W6 counts them', () => {
			const withAreas: ModelInput = {
				...modelInput,
				model: { ...modelInput.model, nodes: modelInput.model.nodes.map((n) => ({ ...n, damAreaFullM2: null })) }
			};
			const on = withVerification(withAreas, runModelWith(withAreas, () => ({ naturalFlowM3Day: natural })));
			expect(on.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
			const dams = project.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
			const evap = dams.reduce((s, n) => s + get(on, n.id, 'dam_evaporation').reduce((a, v) => a + v, 0), 0);
			expect(evap).toBeGreaterThan(0);
			expect(on.summary.warnings.some((w) => w.startsWith(`${dams.length} dam`) && w.includes('no full-supply area'))).toBe(true);
			// Water only leaves: the catchment's total storage never ends a day above the run without losses... on average.
			const store = (o: typeof out) => dams.reduce((s, n) => s + get(o, n.id, 'dam_storage').reduce((a, v) => a + v, 0), 0);
			expect(store(on)).toBeLessThan(store(out));
		});

		it('matches the catchment simulated outflow and EWR within the deviation list', () => {
			// N1: when farms upstream of the outlet have return flow, its flow and shortfall come from the N1 replay.
			// N4: at or below one end of a transfer both are skipped; below the join only the shortfall is.
			const from = outletN1 ? outN1 : out;
			const n4 = n4Ends.has(outletId) || n4OneEnd.has(outletId);
			const flowRule: Rule = n4 ? { kind: 'skip', why: 'N4' } : { kind: 'mean' };
			const shortfallRule: Rule = n4 || n4Joined.has(outletId) ? { kind: 'skip', why: 'N4' } : { kind: 'mean' };
			expect(compare(get(from, null, 'simulated_outflow'), expected.catchment.simulated_outflow!, flowRule)).toBeNull(); // R1
			expect(compare(get(out, null, 'ewr'), expected.catchment.ewr!, { kind: 'exact' })).toBeNull();
			expect(compare(get(from, null, 'ewr_shortfall'), expected.catchment.ewr_not_met!, shortfallRule)).toBeNull(); // R1
		});

		// RETIRED (engine 1.0.0, issue #16): the end-to-end comparison of natural
		// flow from rain with the workbook's [Flow data] column. It needed the
		// legacy b023 recession model, which engine 1.0.0 removed (audit H1: it
		// doesn't conserve water at the event scale). Its last run, on engine
		// 0.45.0 (2026-09-26), passed: with the CHIRPS correction off, every water
		// year's natural flow was within E1/R1 (2 % plus the workbook's rounding
		// floor) of the workbook's, and with it on only the B1 years differed. That
		// is the written record that the port was faithful before it was removed.
		// Every other comparison here feeds the workbook's own natural flow
		// (`natural`), so the network port is still checked against the workbook.
		// Legacy vs GR4J: the two don't agree day by day, and aren't meant to;
		// docs/engine-audit.md H1 and docs/model.md §2.4 record why GR4J replaced
		// it. The client figures are in the private repo's Research/.
		it('end to end on GR4J (natural flow from rain): runs, scores the logger and passes its self-checks', () => {
			const full = withVerification(modelInput, runModel(modelInput));
			expect(full.summary.runoff?.model).toBe('gr4j');
			expect(full.summary.calibration?.days).toBeGreaterThan(0);
			expect(full.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		});

		it('B1: changes CHIRPS only on the fallback days, by the month factor, and never catchment rain', () => {
			const on = prepareRun(modelInput);
			const off = prepareRun({ ...modelInput, settings: { ...modelInput.settings, chirpsBiasCorrection: 'none' } });
			const c = on.chirpsCorrection!;
			expect(c.months.every((m) => m.factor !== null)).toBe(true);
			expect(c.correctedDays).toBe(chirpsFallback.reduce((a, f) => a + f, 0));
			expect(on.aligned('rain_catchment_mm')).toEqual(off.aligned('rain_catchment_mm'));
			const a = on.aligned('rain_chirps_mm');
			const b = off.aligned('rain_chirps_mm');
			const bad: number[] = [];
			for (let t = 0; t < a.length; t++) {
				const want = chirpsFallback[t] ? b[t]! * c.months[on.month[t]! - 1]!.factor! : b[t];
				if (a[t] !== want) bad.push(t);
			}
			expect(bad.slice(0, 5)).toEqual([]);
		});

		it('B2: sets aside exactly the flagged zero runs, fills them from CHIRPS, and changes no other day', () => {
			const recorded = prepareRun(modelInput);
			// The default zero-run handling, with accumulations as recorded so B2 is judged alone (B4 below runs both).
			const settings = { ...modelInput.settings, zeroRainRuns: { ...defaultProjectSettings().zeroRainRuns, accumulationMode: 'asRecorded' as const } };
			const filled = prepareRun({ ...modelInput, settings });
			const z = filled.zeroRain!.infill;
			const catchmentSeries = modelInput.series.rain_catchment_mm!;
			const flagged = zeroRainRuns(catchmentSeries).runs;
			expect(recorded.zeroRain!.infill.days).toBe(0);
			expect(z.mode).toBe('missing');
			// Every flagged run inside the run window is set aside whole, and nothing else.
			const d0 = toEpochDay(filled.startDate);
			const want = new Uint8Array(filled.days);
			for (const r of flagged) {
				for (let day = toEpochDay(r.startDate); day <= toEpochDay(r.endDate); day++) {
					if (day >= d0 && day < d0 + filled.days) want[day - d0] = 1;
				}
			}
			expect(Array.from(filled.zeroRain!.mask)).toEqual(Array.from(want));
			expect(z.periods.every((p) => p.source === 'flagged' && p.recordedMm === 0)).toBe(true);
			const a = filled.aligned('rain_catchment_mm');
			const b = recorded.aligned('rain_catchment_mm');
			const bad: number[] = [];
			for (let t = 0; t < filled.days; t++) if (want[t] ? a[t] !== null : a[t] !== b[t]) bad.push(t);
			expect(bad.slice(0, 5)).toEqual([]);
			// CHIRPS is expected to cover every set-aside day, so none runs as 0 mm.
			expect(z.unfilledDays).toBe(0);
			if (z.days > 0) expect(z.filledMm).toBeGreaterThan(0);
			// The model still conserves water with the default on.
			const input = { ...modelInput, settings };
			const full = withVerification(input, runModel(input));
			expect(full.summary.verification!.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
		});

		it('B4: spreads each detected accumulation over its window, keeping its total, and the zero-run fill leaves those days alone', () => {
			const recorded = prepareRun(modelInput);
			const settings = { ...modelInput.settings } as Record<string, unknown>;
			delete settings.zeroRainRuns; // the default: zero runs missing, accumulations spread
			const run = prepareRun({ ...modelInput, settings });
			const acc = run.accumulation!;
			expect(acc.info.mode).toBe('spread');
			const spread = acc.info.windows.filter((w) => w.status === 'spread');
			expect(spread.length).toBeGreaterThan(0);
			expect(spread.every((w) => w.source === 'detected' && w.totalMm >= w.readingMm && w.readingMm >= ACC_MIN_MM)).toBe(true);
			const d0 = toEpochDay(run.startDate);
			const a = run.aligned('rain_catchment_mm');
			const b = recorded.aligned('rain_catchment_mm');
			const inWindow = new Uint8Array(run.days);
			for (const w of spread) {
				const from = toEpochDay(w.start);
				const to = toEpochDay(w.end);
				let sum = 0;
				for (let day = from; day <= to; day++) {
					if (day < d0 || day >= d0 + run.days) continue;
					inWindow[day - d0] = 1;
					sum += a[day - d0]!;
				}
				// A window wholly inside the run adds up to what the gauge recorded over it: nothing lost, nothing added.
				if (w.daysInRun === to - from + 1) expect(sum).toBeCloseTo(w.totalMm, 9);
			}
			expect(Array.from(acc.mask)).toEqual(Array.from(inWindow));
			// No window day is also set aside as a zero run (the 0.19 double count), and outside the windows
			// and the zero-run days the catchment rain is as recorded.
			const bad: number[] = [];
			for (let t = 0; t < run.days; t++) {
				if (inWindow[t] && run.zeroRain!.mask[t]) bad.push(t);
				if (!inWindow[t] && !run.zeroRain!.mask[t] && a[t] !== b[t]) bad.push(t);
			}
			expect(bad.slice(0, 5)).toEqual([]);
			// The windows are left out of the CHIRPS factor fit, day by day.
			expect(run.chirpsCorrection!.accumulationDaysLeftOut).toBeGreaterThan(0);
			// The model still conserves water with both on.
			const input = { ...modelInput, settings };
			const full = withVerification(input, runModel(input));
			expect(full.summary.verification!.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
			expect(full.summary.rainAccumulation!.spreadDays).toBe(inWindow.reduce((x, v) => x + v, 0));
		});

		// The pivot table is written by a VBA macro, not by formulas, so it is only
		// as fresh as the last time someone ran it, and some farm-months can
		// hold volumes from an earlier model state (a month's
		// volume is days × its daily AB value in the Element sheet *and* the
		// [EWR shortfalls] sheet, but the pivot has a different sum). So: every farm-month whose volume is current must match exactly,
		// counts included under the running-total rule, and most must be current.
		// The grid is fed the workbook's own daily AB, so this tests ewr.ts alone
		// (the engine's AB differs from the workbook's by R1).
		it('reproduces the [EWR shortfalls Pivot Data] counts (running-total rule) wherever the pivot is current', () => {
			if (!expected.ewrPivot?.length) return;
			const wbAB = (name: string) => expected.nodes[name]!.ewr_shortfall_incremental!.map((v) => v ?? 0);
			const farms = project.model.nodes
				.filter((n) => n.kind === 'farm')
				.map((n) => ({ nodeId: n.id, name: n.name, shortfallM3Day: wbAB(n.name) }));
			const outlet = { nodeId: null, name: 'outlet', shortfallM3Day: expected.catchment.ewr_not_met!.map((v) => v ?? 0) };
			const g = ewrCompliance(out.startDate, out.days, outlet, farms, 'runningTotal');
			const byName = new Map(g.farms.map((f) => [f.name, f]));
			const bad: string[] = [];
			let current = 0;
			for (const p of expected.ewrPivot) {
				const f = byName.get(p.farm);
				if (!f) {
					bad.push(`no farm ${p.farm}`);
					continue;
				}
				const row = (p.month >= 10 ? p.year : p.year - 1) - g.waterYears[0]!;
				const col = waterYearIndex(p.month);
				if (f.shortfallM3[row]![col] !== -p.volM3) continue; // stale pivot row
				current++;
				if (f.daysNotMet[row]![col] !== p.daysNotMet) {
					bad.push(`${p.farm} ${p.year}-${p.month}: engine ${f.daysNotMet[row]![col]} days vs pivot ${p.daysNotMet}`);
				}
			}
			expect(current / expected.ewrPivot.length).toBeGreaterThan(0.5);
			expect(bad.slice(0, 5)).toEqual([]);
			// The run summary uses the per-day count, which can only be lower.
			const daily = ewrCompliance(out.startDate, out.days, outlet, farms);
			const total = (x: typeof g) => x.farms.reduce((a, f) => a + f.daysNotMet.flat().reduce((b, v) => b + v, 0), 0);
			expect(total(daily)).toBeLessThanOrEqual(total(g));
			expect(out.summary.ewrCompliance!.outlet.daysNotMet.flat().reduce((a, b) => a + b, 0)).toBe(
				out.summary.catchment.ewrDaysNotMet
			);
		});

		// Q17 (engine ≥ 0.17.0): the EWR charge replaces AB as what drives
		// curtailment. AB is still compared with the workbook above (a diagnostic
		// series now); the farms' EWR grids, FarmSummary EWR means and curtailment R,
		// S, T, U and V come from the charge, which the workbook doesn't have.
		it('Q17: every EWR site splits exactly into charged + natural, and the self-checks pass', () => {
			const checked = withVerification(modelInput, out);
			expect(checked.summary.verification!.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`)).toEqual([]);
			const sites = out.summary.curtailment!.ewrSites!;
			expect(sites[0]!.isOutlet).toBe(true);
			expect(sites.length).toBe(1 + project.model.nodes.filter((n) => n.kind === 'gauge' && n.downstreamNodeId !== null).length);
			for (const s of sites) {
				expect(s.chargedM3Day + s.naturalM3Day).toBeCloseTo(s.shortfallM3Day, 6);
				expect(s.chargedM3Day).toBeLessThanOrEqual(0);
				expect(s.naturalM3Day).toBeLessThanOrEqual(0);
			}
			for (const f of out.summary.curtailment!.farms) {
				expect(f.ewrShortfallM3Day).toBeCloseTo(f.ewrChargeIrrigationM3Day! + f.ewrChargeStorageM3Day!, 9);
				expect(f.ewrShortfallM3Day).toBeLessThanOrEqual(0);
			}
		});

		it('scores the calibration window from the workbook settings (plausible NSE)', () => {
			const full = runModel(modelInput);
			const c = full.summary.calibration!;
			const s = project.settings as { calibrationStart?: string | null; calibrationFlowKind?: string | null };
			if (s.calibrationStart) expect(c.windowStart! >= s.calibrationStart).toBe(true);
			if (s.calibrationFlowKind) expect(c.flowKind).toBe(s.calibrationFlowKind);
			expect(c.days).toBeGreaterThan(365);
			for (const v of [c.nse, c.kge, c.logNse, c.r2]) {
				expect(Number.isFinite(v)).toBe(true);
				expect(v!).toBeGreaterThan(-1);
				expect(v!).toBeLessThan(1);
			}
			expect(c.annualVolumes!.length).toBeGreaterThan(0);
			// Annual volumes add up to the whole-window volume error.
			const obs = c.annualVolumes!.reduce((a, y) => a + y.observedMm3, 0);
			const sim = c.annualVolumes!.reduce((a, y) => a + y.simulatedMm3, 0);
			expect((100 * (sim - obs)) / obs).toBeCloseTo(c.volumeErrorPct!, 8);
		});

		// [Shortfalls]: computeCurtailment is fed the workbook's own daily F, G and AB,
		// so these test curtailment.ts alone, not the network's R1 differences.
		// Q17 (engine ≥ 0.17.0): the engine's own R is the EWR charge at the EWR
		// sites (network/attribution.ts), not AB, so R and everything built on it
		// (S, T, U, V) differ from the sheet on the engine's own run. The replay
		// feeds AB in as the charge, all of it irrigation with k = 1 (the old way),
		// so the sheet's formulas can still be checked.
		const wbCurtailment = (window: ReportWindow) =>
			computeCurtailment(
				Object.entries(expected.nodes)
					.filter(([, n]) => n.kind === 'farm')
					.map(([name, n]) => ({
						nodeId: idByName.get(name)!,
						name,
						demand: n.demand!.map((v) => v ?? 0),
						supplied: n.supplied!.map((v) => v ?? 0),
						ewrCharge: n.ewr_shortfall_incremental!.map((v) => v ?? 0)
					})),
				window
			);

		it("matches the [Shortfalls] sheet's averages over its reporting period, within the sheet's ROUND", () => {
			const sf = expected.shortfalls;
			if (!sf) return;
			const w = resolveReportWindow({ reportStart: sf.periodStart, reportEnd: sf.periodEnd }, toEpochDay(expected.startDate), expected.days, []);
			const c = wbCurtailment(w);
			expect([c.reportStart, c.reportEnd]).toEqual([sf.periodStart, sf.periodEnd]);
			const byName = new Map(c.farms.map((f) => [f.name, f]));
			const report: Record<string, string> = {};
			// H, I, R are ROUND(average, 0) on the sheet (R1): ±0.5; J = I − H: ±1.
			const cols: [string, number, (f: (typeof c.farms)[number]) => number, (w: NonNullable<Expected['shortfalls']>['farms'][number]) => number | null | undefined][] = [
				['avgDemand', 0.5, (f) => f.demandM3Day, (w) => w.avgDemand],
				['avgSupplied', 0.5, (f) => f.suppliedM3Day, (w) => w.avgSupplied],
				['avgEwrShortfall', 0.5, (f) => f.ewrShortfallM3Day, (w) => w.avgEwrShortfall],
				['deficit', 1, (f) => f.deficitM3Day, (w) => w.deficit]
			];
			for (const want of sf.farms) {
				const got = byName.get(want.name);
				if (!got) {
					report[want.name] = 'missing from engine report';
					continue;
				}
				for (const [k, bound, g, wv] of cols) {
					const v = wv(want);
					if (v == null) continue;
					if (!(Math.abs(g(got) - v) <= bound + 1e-9)) report[`${want.name}.${k}`] = `engine ${g(got)} vs sheet ${v}`;
				}
			}
			// K total: Σ I / Σ H; the sheet divides the rounded averages (Q14): |ΔK| ≤ n·0.5·(1 + K) / (ΣH − n·0.5).
			const Kw = sf.totals?.fractionSupplied;
			if (Kw != null && c.equitableFraction !== null) {
				const n = c.farms.length;
				const bound = (n * 0.5 * (1 + Kw)) / (c.totals.demandM3Day - n * 0.5);
				if (!(Math.abs(c.equitableFraction - Kw) <= bound)) report.equitableFraction = `engine ${c.equitableFraction} vs sheet ${Kw}`;
			}
			// The derived columns (M, N, O, P, S, T, U, V) are functions of these; the
			// whole-run replay below checks their formulas. The sheet's values differ
			// further only by its own ROUND / ROUNDDOWN (R1, Q14, Q15).
			expect(report).toEqual({});
		});

		it('reproduces the [Shortfalls] formulas, unrounded, over the whole run from the workbook\'s own daily columns', () => {
			// A saved reporting period may be fully supplied, and then never exercises a non-trivial
			// target. Over the whole run there are deficits: replay the sheet's cell
			// formulas, written out independently here without the sheet's rounding (R1).
			const c = wbCurtailment({ from: 0, to: expected.days - 1, reportStart: expected.startDate, reportEnd: out.endDate });
			const mean = (v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0) / v.length;
			const rows = Object.entries(expected.nodes)
				.filter(([, n]) => n.kind === 'farm')
				.map(([name, n]) => ({ name, H: mean(n.demand!), I: mean(n.supplied!), R: mean(n.ewr_shortfall_incremental!) }));
			const K = rows.reduce((s, r) => s + r.I, 0) / rows.reduce((s, r) => s + r.H, 0);
			expect(K).toBeLessThan(1); // the whole run does have deficits
			expect(c.equitableFraction).toBeCloseTo(K, 12);
			for (const r of rows) {
				const M = r.H * K;
				const N = M - r.I;
				const S = N + r.R;
				const got = c.farms.find((f) => f.name === r.name)!;
				const close = (g: number, w: number) => expect(g).toBeCloseTo(w, 6);
				close(got.targetM3Day, M);
				close(got.reduceGainM3Day, N);
				close(got.reduceGainLs, N / 86.4);
				close(got.totalChangeM3Day, S);
				close(got.totalChangeLs, S / 86.4);
				// Q13 (engine ≥ 0.17.0): the volume left is never below 0; the sheet's M + R can be.
				close(got.volumeLeftM3Day, Math.max(M + r.R, 0));
			}
			// Some farm must give water up and another may gain it.
			expect(c.farms.some((f) => f.reduceGainM3Day < 0)).toBe(true);
			expect(c.farms.some((f) => f.reduceGainM3Day > 0)).toBe(true);
			// The engine's own report (on its own daily columns) covers the whole run by default.
			expect([out.summary.curtailment!.reportStart, out.summary.curtailment!.days]).toEqual([expected.startDate, expected.days]);
		});
	}
);

describe('runModel — soundness warnings (audit W1–W5)', () => {
	const rainInput = (rain: (number | null)[], startDate = '2021-07-01', over: Partial<ProjectSettings> = {}): ModelInput => ({
		// A-pan: GR4J (the default) refuses to run without evaporation. No crops, so no demand.
		settings: { ewrPragmaticM3PerDay: zeros, apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], ...over },
		model: { nodes: [node('A', { areaKm2: 100, downstreamNodeId: 'G' }), node('G', { kind: 'gauge', areaKm2: 0 })], crops: [], cropAreas: [], transfers: [] },
		series: { rain_catchment_mm: { startDate, values: rain } }
	});
	const warns = (out: { summary: { warnings: string[] } }, re: RegExp) => out.summary.warnings.filter((w) => re.test(w));

	it('W1: warns when natural flow is more than the rain that fell, and reports the runoff coefficient', () => {
		// GR4J conserves water, so only its stores draining can do it: a short run from half-full stores, no warm-up.
		const rain = new Array(20).fill(0);
		rain[19] = 0.1;
		const short = runModel(rainInput(rain, '2021-07-01', { gr4j: { ...defaultProjectSettings().gr4j, warmupDays: 0 } }));
		const c = short.summary.catchment.runoffCoefficient!;
		const natural = get(short, null, 'natural_flow').reduce((a, b) => a + b, 0);
		expect(c).toBeCloseTo(natural / (0.1 * 100 * 1000), 9);
		expect(c).toBeGreaterThan(1);
		expect(warns(short, /× the rain volume over the run: the GR4J stores held/)).toHaveLength(1);
		// Natural flow a caller supplies (runModelWith) has no stores to blame: the plain warning.
		const supplied = runModelWith(rainInput([10, 0, 0], '2021-07-01'), () => ({ naturalFlowM3Day: [2e6, 1e6, 5e5] }));
		expect(warns(supplied, /more runoff than rainfall/)).toHaveLength(1);
		// A plausible catchment: no warning.
		const calm = runModel(rainInput(new Array(30).fill(5), '2021-01-01'));
		expect(calm.summary.catchment.runoffCoefficient!).toBeLessThan(1);
		expect(warns(calm, /more runoff than rainfall|× the rain volume/)).toHaveLength(0);
	});

	it('W2: counts days with no rainfall value from any source (treated as dry)', () => {
		const out = runModel(rainInput([0, null, 3, null, null, 0], '2021-01-01'));
		expect(warns(out, /3 of 6 days have no rainfall value/)).toHaveLength(1);
		expect(warns(runModel(rainInput([0, 1, 2], '2021-01-01')), /no rainfall value/)).toHaveLength(0);
	});

	it('W2: names the blank days’ dates and how many fall in the reporting window', () => {
		const out = runModel(rainInput([0, null, 3, null, null, 0], '2021-01-01'));
		expect(warns(out, /no rainfall value/)).toEqual([
			'3 of 6 days have no rainfall value (catchment, CHIRPS or forecast); the model treats them as dry (0 mm): 2021-01-02, 2021-01-04 to 2021-01-05'
		]);
		const windowed = runModel(rainInput([0, null, 3, null, null, 0], '2021-01-01', { reportStart: '2021-01-04', reportEnd: '2021-01-06' }));
		expect(warns(windowed, /no rainfall value/)[0]).toMatch(/: 2021-01-02, 2021-01-04 to 2021-01-05; 2 of them fall in the reporting window \(2021-01-04 to 2021-01-06\)$/);
		// More periods than it lists: counted, not named.
		const patchy = runModel(rainInput([1, null, 1, null, 1, null, 1, null, 1, null, 1], '2021-01-01'));
		expect(warns(patchy, /no rainfall value/)[0]).toMatch(/^5 of 11 days .*: 2021-01-02, 2021-01-04, 2021-01-06 and 2 more periods$/);
	});

	it('W3: hi/lo shares warn when a farm area differs from its hi + lo areas (rain volume uses the area)', () => {
		const out = run({
			nodes: [node('A', { areaKm2: 10, areaHiKm2: 6, areaLoKm2: 3, downstreamNodeId: 'B' }), node('B', { sortOrder: 1, areaKm2: 5, areaHiKm2: 2, areaLoKm2: 3 })],
			settings: { flowShareMethod: 'hiLo' },
			natural: [0]
		});
		// One warning for the run (quality.ts areaMismatches), naming A only.
		expect(warns(out, /high-MAP \+ low-MAP area/)).toHaveLength(1);
		expect(warns(out, /A: 10 km² vs 9 km²/)).toHaveLength(1);
		expect(warns(out, /B: /)).toHaveLength(0);
		expect(out.summary.dataQuality!.areaMismatches!.map((m) => m.nodeId)).toEqual(['A']);
	});

	it('P1: natural flow never falls back to a Pitman series, so there is no W5 warning', () => {
		const without = runModel(rainInput([0, 0, 20], '2021-07-01'));
		const i = rainInput([0, 0, 20], '2021-07-01');
		(i.series as Record<string, unknown>).flow_pitman_m3s = { startDate: '2021-07-01', values: [0.5, 0.5, 0.5] };
		const out = runModel(i);
		expect(get(out, null, 'natural_flow')).toEqual(get(without, null, 'natural_flow'));
		expect(warns(out, /Pitman/)).toHaveLength(0);
	});

});

describe('catchment area', () => {
	it('defaults to the sum of farm areas and honours an explicit override', async () => {
		const { resolveCatchmentAreaKm2 } = await import('./run');
		const nodes = [
			{ kind: 'gauge', areaKm2: 99 },
			{ kind: 'farm', areaKm2: 30 },
			{ kind: 'farm', areaKm2: 20.5 }
		];
		const input = { model: { nodes } } as unknown as Parameters<typeof resolveCatchmentAreaKm2>[1];
		expect(resolveCatchmentAreaKm2({ catchmentAreaKm2: null }, input)).toBe(50.5);
		expect(resolveCatchmentAreaKm2({ catchmentAreaKm2: 0 }, input)).toBe(50.5);
		expect(resolveCatchmentAreaKm2({ catchmentAreaKm2: 150 }, input)).toBe(150);
	});
});

describe('runModel — forecast rain days (engine 0.28.0)', () => {
	// 10 days: recorded catchment rain on the first 7, forecast on the last 3.
	const withForecast = (settings: Partial<ProjectSettings> = {}) => {
		const x = input({ nodes: [node('A')], natural: new Array(10).fill(100), rain: [1, 0, 2, 0, 0, 3, 0, null, null, null], settings });
		x.series!.rain_forecast_mm = { startDate: '2020-01-06', values: [9, 9, 4, 5, 6] };
		return runModelWith(x, () => ({ naturalFlowM3Day: new Array(10).fill(100) }));
	};

	it('names the days that ran on forecast rain and how many the reporting window holds', () => {
		const out = withForecast();
		// Days 6–7 have recorded rain, so their forecast values are not used.
		expect(out.summary.forecastRain).toEqual({ days: 3, from: '2020-01-08', to: '2020-01-10', inReport: 3, lastRecorded: '2020-01-07' });
		expect(out.summary.warnings).toContain(
			'3 days (2020-01-08 to 2020-01-10) of this run use forecast rain, not recorded rain (catchment or CHIRPS); all of them fall in the reporting window (2020-01-01 to 2020-01-10), so curtailment and the EWR sites cover forecast days'
		);
	});

	it('counts only the forecast days inside a narrower reporting window, and says nothing of it when none are', () => {
		expect(withForecast({ reportStart: '2020-01-04', reportEnd: '2020-01-08' }).summary.forecastRain?.inReport).toBe(1);
		const before = withForecast({ reportStart: '2020-01-01', reportEnd: '2020-01-07' });
		expect(before.summary.forecastRain?.inReport).toBe(0);
		expect(before.summary.warnings.find((w) => w.includes('forecast rain'))).toBe('3 days (2020-01-08 to 2020-01-10) of this run use forecast rain, not recorded rain (catchment or CHIRPS)');
	});

	it('is null when a forecast series is never used, and absent without one (positive control: no warning)', () => {
		const x = input({ nodes: [node('A')], natural: new Array(5).fill(100), rain: [1, 1, 1, 1, 1] });
		x.series!.rain_forecast_mm = { startDate: '2020-01-01', values: [9, 9, 9, 9, 9] };
		const used = runModelWith(x, () => ({ naturalFlowM3Day: new Array(5).fill(100) }));
		expect(used.summary.forecastRain).toBeNull();
		expect(used.summary.warnings.some((w) => w.includes('forecast rain'))).toBe(false);
		expect('forecastRain' in run({ nodes: [node('A')], natural: [100] }).summary).toBe(false);
	});
});
