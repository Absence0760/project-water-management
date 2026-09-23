import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { CropArea, CropDef, ModelInput, NetworkNode, ProjectSettings, RunSeries, Transfer } from './project';
import { runModel, runModelWith } from './run';
import { calibrationStats } from './network/stats';
import { ewrCompliance } from './network/ewr';
import { waterYearIndex } from './calendar';
import { buildTopology } from './network/topology';
import { excelRound, excelRoundDown } from './network/round';

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
		returnFlowPct: 0,
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
	// all its own runoff; B has no dam and a 50% runoff-to-dam split (no dam, so
	// that water just passes the "full" dam as spill).
	const nodes = [
		node('A', {
			downstreamNodeId: 'B',
			pctRunoffToDam: 1,
			damCapacityM3: 1000,
			damInitialPct: 0.5,
			returnFlowPct: 0.1
		}),
		node('B', { downstreamNodeId: 'G', sortOrder: 1, pctRunoffToDam: 0.5, returnFlowPct: 0 }),
		node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 2 })
	];
	// A: one crop, 1000 m², crop factor 1.
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }];
	const cropAreas: CropArea[] = [{ nodeId: 'A', cropId: 'c', areaM2: 1000 }];
	const settings: Partial<ProjectSettings> = { apanMm: flat(31 * 100) as Monthly };
	// October: 31 days → gross = 1000 m² × 3100 mm / 1000 / 31 = 100 m³/day.

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
		// Day 0: Qprev 500 + M 100 → avail 600, G = 100, P = 500, Q = 500.
		// Day 1: avail 500 → G 100, Q 400.
		// Day 2: avail 400 + 800.5 = 1200.5 → G 100, P 1100.5, Q 1000, spill 100.5.
		expect(get(out, 'A', 'demand')).toEqual([100, 100, 100]);
		expect(get(out, 'A', 'supplied')).toEqual([100, 100, 100]);
		expect(get(out, 'A', 'dam_storage')).toEqual([500, 400, 1000]);
		expect(get(out, 'A', 'spill')).toEqual([0, 0, 100.5]);
		// U = spill + below-dam (0) + return 100 × 0.1 = 10
		expect(get(out, 'A', 'outflow')).toEqual([10, 10, 110.5]);
	});

	it('routes upstream outflow into the next farm and on to the gauge', () => {
		expect(get(out, 'B', 'inflow_upstream')).toEqual([10, 10, 110.5]);
		// B: capacity 0. M = I × 0.5 goes to the (zero) dam and spills; N below dam.
		// U = R + S + T = (K + M) + N + 0 = H + I.
		expect(get(out, 'B', 'spill')).toEqual([60, 10, 510.75]); // K + M: 10 + 50, 10 + 0, 110.5 + 400.25
		expect(get(out, 'B', 'outflow')).toEqual([110, 10, 911]);
		expect(get(out, 'G', 'outflow')).toEqual([110, 10, 911]);
		expect(get(out, null, 'simulated_outflow')).toEqual([110, 10, 911]);
	});

	it('adds an EWR compliance grid for the outlet and each farm', () => {
		const withEwr = run({ nodes, crops, cropAreas, settings: { ...settings, ewrPragmaticM3PerDay: flat(100) }, natural: [200, 0, 1601], startDate: '2020-10-01' });
		const g = withEwr.summary.ewrCompliance!;
		expect(g.waterYears).toEqual([2020]);
		expect(g.days[0]![0]).toBe(3);
		// Outflow [110, 10, 911] vs EWR 100: only day 1 is short, by 90.
		expect(g.outlet.name).toBe('G');
		expect(g.outlet.daysNotMet[0]![0]).toBe(1);
		expect(g.outlet.shortfallM3[0]![0]).toBe(90);
		expect(g.farms.map((f) => f.nodeId)).toEqual(['A', 'B']);
		const ewrDays = get(withEwr, null, 'ewr_shortfall').filter((v) => v < 0).length;
		expect(ewrDays).toBe(withEwr.summary.catchment.ewrDaysNotMet);
	});

	it('reports per-farm averages', () => {
		const a = out.summary.farms.find((f) => f.nodeId === 'A')!;
		expect(a.avgDemandM3Day).toBe(100);
		expect(a.fractionSupplied).toBe(1);
		const b = out.summary.farms.find((f) => f.nodeId === 'B')!;
		expect(b.avgDemandM3Day).toBe(0);
		expect(b.fractionSupplied).toBe(1);
		expect(out.summary.farms.map((f) => f.nodeId)).toEqual(['A', 'B']); // gauges have no farm summary
		expect(out.summary.catchment.meanSimulatedOutflowM3Day).toBeCloseTo((110 + 10 + 911) / 3, 10);
	});

	it('runs over the rainfall period and emits catchment series', () => {
		expect(out.startDate).toBe('2020-10-01');
		expect(out.endDate).toBe('2020-10-03');
		expect(out.days).toBe(3);
		expect(get(out, null, 'natural_flow')).toEqual([200, 0, 1601]);
		expect(out.summary.warnings).toEqual(['no observed flow series: calibration statistics not computed']);
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
			nodes: [node('D', { damCapacityM3: 0.4, damInitialPct: 1, returnFlowPct: 0.25 })],
			crops,
			cropAreas: [{ nodeId: 'D', cropId: 'c', areaM2: 1 }],
			settings: { apanMm: flat(31) as Monthly }, // 1 m² × 31 mm / 1000 / 31 = 0.001 m³/day
			natural: [0],
			startDate: '2020-10-01'
		});
		expect(get(out, 'D', 'demand')[0]).toBeCloseTo(0.001, 12);
		expect(get(out, 'D', 'supplied')[0]).toBeCloseTo(0.001, 12);
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(0.399, 12);
		expect(get(out, 'D', 'outflow')[0]).toBeCloseTo(0.00025, 12);
	});
});

describe('runModel — dam behaviour', () => {
	it('mirrors the b023 upstream split: pctUpstreamToDam sends inflow *below* the dam (L), capped by the diversion', () => {
		// Upstream U farm drains 1000 m³/day of runoff into D. D has pctUpstreamToDam = 1,
		// which in b023 makes L = H (below dam); only the 300 m³/day diversion reaches the dam.
		const out = run({
			nodes: [
				node('U', { downstreamNodeId: 'D' }),
				node('D', {
					areaKm2: 0,
					sortOrder: 1,
					pctUpstreamToDam: 1,
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

	it('with pctUpstreamToDam = 0 all upstream inflow enters the dam (K)', () => {
		const out = run({
			nodes: [
				node('U', { downstreamNodeId: 'D' }),
				node('D', { areaKm2: 0, sortOrder: 1, damCapacityM3: 1500 })
			],
			natural: [1000, 1000]
		});
		expect(get(out, 'D', 'dam_storage')).toEqual([1000, 1500]);
		expect(get(out, 'D', 'spill')).toEqual([0, 500]);
		expect(get(out, 'D', 'outflow')).toEqual([0, 500]);
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
		...over
	});
	const nodes = () => [
		node('S', { areaKm2: 0, damCapacityM3: 10_000, damInitialPct: 0.4 }),
		node('R', { areaKm2: 0, damCapacityM3: 10_000, sortOrder: 1 })
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

	it('shares one dam between several transfers on the same day (never overdraws)', () => {
		// S: start 4000, keep 3000 → 1000 available. Two 864 m³/day rules from S:
		// the first (document order) takes 864, the second only the remaining 136.
		// Previously each rule saw yesterday's full storage and 1728 left the dam.
		const out = run({
			nodes: [...nodes(), node('R2', { areaKm2: 0, damCapacityM3: 10_000, sortOrder: 2 })],
			transfers: [transfer(), transfer({ id: 't2', toNodeId: 'R2' })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(get(out, 'R', 'transfer')).toEqual([864]);
		expect(get(out, 'R2', 'transfer')).toEqual([136]);
		expect(get(out, 'S', 'transfer')).toEqual([-1000]);
		expect(get(out, 'S', 'dam_storage')).toEqual([3000]);
	});

	it('skips transfers involving a gauge, with a warning', () => {
		const out = run({
			nodes: [...nodes(), node('G', { kind: 'gauge', areaKm2: 0 })].map((n) =>
				n.id === 'G' ? n : { ...n, downstreamNodeId: 'G' }
			),
			transfers: [transfer({ toNodeId: 'G' })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(out.summary.warnings.some((w) => w.includes('transfers must be between farms'))).toBe(true);
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

	it('attributes shortfalls to the farm that causes them', () => {
		expect(get(out, 'X', 'ewr_shortfall')).toEqual([0, 0]); // 100 out ≥ 50
		expect(get(out, 'Y', 'ewr_shortfall')).toEqual([-50, -50]); // 0 out < 50
		expect(get(out, 'Y', 'ewr_shortfall_incremental')).toEqual([-50, -50]);
		// Z: out 200 ≥ 150 → met; incremental = MIN(0 − (0 + −50), 0) = 0
		expect(get(out, 'Z', 'ewr_shortfall')).toEqual([0, 0]);
		expect(get(out, 'Z', 'ewr_shortfall_incremental')).toEqual([0, 0]);
		const y = out.summary.farms.find((f) => f.nodeId === 'Y')!;
		expect(y.avgEwrShortfallM3Day).toBe(50);
		expect(y.daysEwrNotMet).toBe(2);
	});

	it('counts catchment days where simulated outflow is below the EWR', () => {
		expect(get(out, null, 'ewr')).toEqual([150, 150]);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		const dry = run({ nodes, natural: [0, 300], settings: { ewrPragmaticM3PerDay: flat(150) as Monthly } });
		expect(dry.summary.catchment.ewrDaysNotMet).toBe(1);
		expect(get(dry, null, 'ewr_shortfall')).toEqual([-150, 0]);
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

	it('hi/lo shares weight the high- and low-MAP areas by the split', () => {
		const out = run({
			nodes: [
				node('A', { downstreamNodeId: 'B', areaHiKm2: 3, areaLoKm2: 1 }),
				node('B', { sortOrder: 1, areaHiKm2: 1, areaLoKm2: 3 })
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

	it('rejects a link to an unknown node', () => {
		expect(() => run({ nodes: [node('A', { downstreamNodeId: 'nope' })], natural: [0] })).toThrow(/unknown node/);
	});

	it('needs a rainfall or Pitman series to define the period', () => {
		const i = input({ nodes: [node('A')], natural: [0] });
		i.series = {};
		expect(() => runModelWith(i, () => ({ naturalFlowM3Day: [] }))).toThrow(/no rainfall or Pitman/);
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

		i.settings.calibrationFlowKind = 'flow_pitman_m3s';
		const missing = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 86_400] }));
		expect(missing.summary.calibration!.flowKind).toBe('flow_observed_m3s');
		expect(missing.summary.warnings.some((w) => /flow_pitman_m3s.*missing/.test(w))).toBe(true);
	});

	it('scores natural flow, not the impacted outflow, against naturalised Pitman flow (audit C1)', () => {
		// A's dam keeps every drop, so the outflow is 0 while natural flow equals Pitman.
		const i = input({
			nodes: [node('A', { pctRunoffToDam: 1, damCapacityM3: 1e9 })],
			natural: [86_400, 2 * 86_400, 3 * 86_400]
		});
		i.series.flow_pitman_m3s = { startDate: '2020-01-01', values: [1, 2, 3] };
		i.settings.calibrationFlowKind = 'flow_pitman_m3s';
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [86_400, 2 * 86_400, 3 * 86_400] }));
		const c = out.summary.calibration!;
		expect(c.flowKind).toBe('flow_pitman_m3s');
		expect(c.simulatedKey).toBe('natural_flow');
		expect(c.nse).toBeCloseTo(1, 12);
		expect(c.pbias).toBeCloseTo(0, 12);
		// A gauge or logger record is impacted flow: it is scored against the outflow.
		expect(run({ nodes: [node('A')], natural: [86_400], observed: [1] }).summary.calibration!.simulatedKey).toBe('simulated_outflow');
	});

	it('returns null NSE when observations are constant', () => {
		expect(calibrationStats([86_400, 86_400], [1, 1]).nse).toBeNull();
		expect(calibrationStats([1], [null]).days).toBe(0);
	});
});

describe('excelRound', () => {
	it('rounds half away from zero and survives binary representation error', () => {
		expect(excelRound(2.5)).toBe(3);
		expect(excelRound(-2.5)).toBe(-3);
		expect(excelRound(2.675, 2)).toBe(2.68);
		expect(excelRound(1.005, 2)).toBe(1.01);
		expect(excelRound(0.49)).toBe(0);
	});
});

describe('runModel — end to end with the rain model', () => {
	it('produces natural flow from rain and runs the network', () => {
		const days = 60;
		const rain = Array.from({ length: days }, (_, i) => (i % 10 === 0 ? 30 : 0));
		const i = input({ nodes: [node('A', { downstreamNodeId: 'G' }), node('G', { kind: 'gauge' })], natural: [] });
		i.series = { rain_catchment_mm: { startDate: '2020-06-01', values: rain } };
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

interface Expected {
	startDate: string;
	days: number;
	catchment: Record<string, (number | null)[]>;
	nodes: Record<string, { kind: string } & Record<string, (number | null)[]>>;
	shortfalls: {
		periodStart: string;
		periodEnd: string;
		farms: ({ name: string; avgDemand: number; avgSupplied: number; avgEwrShortfall: number } & Partial<
			Record<ShortfallCol, number | null>
		>)[];
		/** The totals row; present once extract_project.py reads the curtailment columns. */
		totals?: Record<string, number | null>;
	} | null;
	/** [EWR shortfalls Pivot Data], written by the workbook's VBA (absent in older extracts). */
	ewrPivot?: { year: number; month: number; farm: string; volM3: number; daysNotMet: number }[] | null;
}
/** [Shortfalls] curtailment columns in expected.json (scripts/wbt-import SHORTFALLS_COLS). */
type ShortfallCol =
	| 'deficit'
	| 'fractionSupplied'
	| 'target'
	| 'reduceGain'
	| 'reduceGainLs'
	| 'targetFraction'
	| 'totalChange'
	| 'totalChangeLs'
	| 'volumeLeft'
	| 'fractionOfDemandLeft';
interface ImportedProject {
	settings: ModelInput['settings'];
	model: ModelInput['model'];
	series: { kind: string; startDate: string; values: (number | null)[] }[];
}

// No @types/node in this package: reach node:fs through an untyped dynamic import.
type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
const fsSpecifier = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.';
const dataDir = ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment']
	.map((p) => `${cwd}/${p}`)
	.find((p) => fs.existsSync(`${p}/expected.json`));

describe.skipIf(!dataDir)(
	'workbook regression: client catchment (needs data/client-catchment from scripts/wbt-import/extract_project.py)',
	() => {
		// vitest still runs a skipped describe's body to collect its tests: don't
		// read the (absent) fixtures then, but register one test so the run
		// reports the suite as skipped rather than silently empty.
		if (!dataDir) {
			it('needs data/client-catchment', () => {});
			return;
		}
		const project = JSON.parse(fs.readFileSync(`${dataDir}/project.json`, 'utf8')) as ImportedProject;
		const expected = JSON.parse(fs.readFileSync(`${dataDir}/expected.json`, 'utf8')) as Expected;
		const modelInput: ModelInput = {
			settings: project.settings,
			model: project.model,
			series: Object.fromEntries(project.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }]))
		};
		// Feed the workbook's own natural flow so this isolates the network port from the rain model.
		const natural = expected.catchment.natural_flow!.map((v) => v ?? 0);
		const t0 = Date.now();
		const out = runModelWith(modelInput, () => ({ naturalFlowM3Day: natural }));
		const elapsedMs = Date.now() - t0;
		const idByName = new Map(project.model.nodes.map((n) => [n.name, n.id]));

		/** Days where engine and workbook differ by more than 1e-6. */
		function mismatches(actual: number[], want: (number | null)[]): number[] {
			const bad: number[] = [];
			for (let t = 0; t < want.length; t++) {
				const w = want[t] ?? 0;
				if (!(Math.abs(actual[t]! - w) <= 1e-6)) bad.push(t);
			}
			return bad;
		}

		it('covers the same period as the workbook', () => {
			expect(out.startDate).toBe(expected.startDate);
			expect(out.days).toBe(expected.days);
		});

		it('runs 13 nodes × 16k days well under a second', () => {
			expect(elapsedMs).toBeLessThan(1000);
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
			it(`matches every daily value on Element sheet "${name}"`, () => {
				const id = idByName.get(name)!;
				const report: Record<string, string> = {};
				for (const key of keys) {
					if (!(key in want) || (want.kind === 'gauge' && !['outflow', 'ewr_cumulative', 'ewr_shortfall'].includes(key)))
						continue;
					const bad = mismatches(get(out, id, key), want[key]!);
					if (bad.length) {
						const t = bad[0]!;
						report[key] = `${bad.length} days differ, first day ${t}: engine ${get(out, id, key)[t]} vs workbook ${want[key]![t]}`;
					}
				}
				expect(report).toEqual({});
			});
		}

		it('matches the catchment simulated outflow and EWR', () => {
			expect(mismatches(get(out, null, 'simulated_outflow'), expected.catchment.simulated_outflow!)).toEqual([]);
			expect(mismatches(get(out, null, 'ewr'), expected.catchment.ewr!)).toEqual([]);
			expect(mismatches(get(out, null, 'ewr_shortfall'), expected.catchment.ewr_not_met!)).toEqual([]);
		});

		it('end to end (natural flow from the rain model too) reproduces the workbook outflow', () => {
			const t1 = Date.now();
			const full = runModel(modelInput);
			expect(Date.now() - t1).toBeLessThan(1000);
			expect(mismatches(get(full, null, 'natural_flow'), expected.catchment.natural_flow!)).toEqual([]);
			expect(mismatches(get(full, null, 'simulated_outflow'), expected.catchment.simulated_outflow!)).toEqual([]);
			expect(full.summary.calibration?.days).toBeGreaterThan(0);
		});

		// The pivot table is written by a VBA macro, not by formulas, so it is only
		// as fresh as the last time someone ran it. In the client catchment workbook
		// about a quarter of the farm-months hold volumes from an earlier model
		// state (e.g. one farm's Feb 1981 is 28 × its daily AB value in the Element
		// sheet *and* the [EWR shortfalls] sheet, but the pivot has a different
		// sum). So: every farm-month whose volume is current must match exactly,
		// counts included under the running-total rule, and most must be current.
		it('reproduces the [EWR shortfalls Pivot Data] counts (running-total rule) wherever the pivot is current', () => {
			if (!expected.ewrPivot?.length) return;
			const farms = project.model.nodes
				.filter((n) => n.kind === 'farm')
				.map((n) => ({ nodeId: n.id, name: n.name, shortfallM3Day: get(out, n.id, 'ewr_shortfall_incremental') }));
			const outlet = { nodeId: null, name: 'outlet', shortfallM3Day: get(out, null, 'ewr_shortfall') };
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

		it('matches the [Shortfalls] sheet averages over its reporting period', () => {
			if (!expected.shortfalls) return;
			const { periodStart, periodEnd, farms } = expected.shortfalls;
			const day = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
			const a = day(periodStart) - day(expected.startDate);
			const b = day(periodEnd) - day(expected.startDate);
			const avg = (v: number[]) => v.slice(a, b + 1).reduce((s, x) => s + x, 0) / (b - a + 1);
			for (const f of farms) {
				const id = idByName.get(f.name)!;
				expect(excelRound(avg(get(out, id, 'demand')))).toBe(f.avgDemand);
				expect(excelRound(avg(get(out, id, 'supplied')))).toBe(f.avgSupplied);
				expect(excelRound(avg(get(out, id, 'ewr_shortfall_incremental')))).toBe(f.avgEwrShortfall);
			}
		});

		it('matches every [Shortfalls] curtailment column over its reporting period', () => {
			const sf = expected.shortfalls;
			if (!sf?.totals) return; // expected.json from before the curtailment columns were extracted
			const inWindow = runModelWith(
				{ ...modelInput, settings: { ...modelInput.settings, reportStart: sf.periodStart, reportEnd: sf.periodEnd } },
				() => ({ naturalFlowM3Day: natural })
			).summary.curtailment!;
			expect([inWindow.reportStart, inWindow.reportEnd]).toEqual([sf.periodStart, sf.periodEnd]);
			const byName = new Map(inWindow.farms.map((f) => [f.name, f]));
			const report: Record<string, string> = {};
			const cols: [ShortfallCol | 'avgDemand' | 'avgSupplied' | 'avgEwrShortfall', keyof (typeof inWindow.farms)[number]][] = [
				['avgDemand', 'demandM3Day'],
				['avgSupplied', 'suppliedM3Day'],
				['deficit', 'deficitM3Day'],
				['fractionSupplied', 'fractionSupplied'],
				['target', 'targetM3Day'],
				['reduceGain', 'reduceGainM3Day'],
				['reduceGainLs', 'reduceGainLs'],
				['targetFraction', 'targetFraction'],
				['avgEwrShortfall', 'ewrShortfallM3Day'],
				['totalChange', 'totalChangeM3Day'],
				['totalChangeLs', 'totalChangeLs'],
				['volumeLeft', 'volumeLeftM3Day'],
				['fractionOfDemandLeft', 'fractionOfDemandLeft']
			];
			for (const want of sf.farms) {
				const got = byName.get(want.name);
				if (!got) {
					report[want.name] = 'missing from engine report';
					continue;
				}
				for (const [wk, gk] of cols) {
					const w = want[wk] ?? null;
					const g = got[gk] as number | null;
					if (w === null ? g !== null : g === null || Math.abs(g - w) > 1e-9) report[`${want.name}.${wk}`] = `engine ${g} vs workbook ${w}`;
				}
			}
			const t = inWindow.totals;
			const totals: [string, number | null][] = [
				['avgDemand', t.demandM3Day],
				['avgSupplied', t.suppliedM3Day],
				['deficit', t.deficitM3Day],
				['fractionSupplied', inWindow.equitableFraction],
				['target', t.targetM3Day],
				['reduceGain', t.reduceGainM3Day],
				['reduceGainLs', t.reduceGainLs],
				['avgEwrShortfall', t.ewrShortfallM3Day],
				['totalChange', t.totalChangeM3Day],
				['volumeLeft', t.volumeLeftM3Day]
			];
			for (const [k, g] of totals) {
				const w = sf.totals[k] ?? null;
				if (w === null ? g !== null : g === null || Math.abs(g - w) > 1e-6) report[`totals.${k}`] = `engine ${g} vs workbook ${w}`;
			}
			expect(report).toEqual({});
		});

		it('reproduces the [Shortfalls] cell formulas over the whole run from the workbook\'s own daily columns', () => {
			// The saved reporting period is fully supplied, so it never exercises a non-trivial
			// target. Over the whole run client catchment has deficits: replay the sheet's cell
			// formulas, written out independently here, on the Element sheet values.
			const c = out.summary.curtailment!;
			expect([c.reportStart, c.days]).toEqual([expected.startDate, expected.days]);
			const mean = (v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0) / v.length;
			const farmNames = Object.entries(expected.nodes)
				.filter(([, n]) => n.kind === 'farm')
				.map(([name]) => name);
			const rows = farmNames.map((name) => {
				const n = expected.nodes[name]!;
				return {
					name,
					H: excelRound(mean(n.demand!)),
					I: excelRound(mean(n.supplied!)),
					R: excelRound(mean(n.ewr_shortfall_incremental!))
				};
			});
			const K = rows.reduce((s, r) => s + r.I, 0) / rows.reduce((s, r) => s + r.H, 0);
			expect(K).toBeLessThan(1); // the whole run does have deficits
			expect(c.equitableFraction).toBeCloseTo(K, 12);
			for (const r of rows) {
				const M = excelRound(r.H * K, 1);
				const N = M - r.I;
				const S = N + r.R;
				const got = c.farms.find((f) => f.name === r.name)!;
				expect({
					M: got.targetM3Day,
					N: got.reduceGainM3Day,
					O: got.reduceGainLs,
					S: got.totalChangeM3Day,
					T: got.totalChangeLs,
					U: got.volumeLeftM3Day
				}).toEqual({
					M,
					N: excelRound(N, 1),
					O: excelRoundDown(N / 86.4, 1),
					S: excelRound(S, 1),
					T: excelRoundDown(S / 86.4, 1),
					U: excelRound(M + r.R, 1)
				});
			}
			// Some farm must give water up and another may gain it.
			expect(c.farms.some((f) => f.reduceGainM3Day < 0)).toBe(true);
			expect(c.farms.some((f) => f.reduceGainM3Day > 0)).toBe(true);
		});
	}
);

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
		expect(resolveCatchmentAreaKm2({ catchmentAreaKm2: 205.1 }, input)).toBe(205.1);
	});
});
