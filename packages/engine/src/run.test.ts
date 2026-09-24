import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { CropArea, CropDef, ModelInput, NetworkNode, ProjectSettings, RunSeries, Transfer } from './project';
import { DEFAULT_GAUGE_PICK_WARNING, pickObservedKind, prepareRun, resolveReportWindow, runModel, runModelWith, withVerification } from './run';
import { defaultProjectSettings } from './project';

const defaultCal = () => defaultProjectSettings().calibration;
import { calibrationStats } from './network/stats';
import { ewrCompliance } from './network/ewr';
import { toEpochDay, waterYearIndex } from './calendar';
import { buildTopology } from './network/topology';
import { shortfall } from './network/simulate';
import { netDailyDemandM3 } from './demand';
import { computeCurtailment, type ReportWindow } from './network/curtailment';

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
		// B: capacity 0, pctUpstreamToDam 0. M = I × 0.5 goes to the (zero) dam and
		// spills; the upstream inflow and N pass below the dam (engine ≥ 0.9.0, Q1).
		// U = R + S + T = M + (L + N) + 0 = H + I.
		expect(get(out, 'B', 'spill')).toEqual([50, 0, 400.25]); // M only
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

	it('shares one dam between several transfers on the same day (never overdraws)', () => {
		// S: start 4000, keep 3000 → 1000 available. Two 864 m³/day rules from S:
		// the first (document order) takes 864, the second only the remaining 136.
		// Previously each rule saw yesterday's full storage and 1728 left the dam.
		const out = run({
			nodes: [...nodes(), node('R2', { areaKm2: 0, damCapacityM3: 10_000, sortOrder: 2, downstreamNodeId: 'G' })],
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
			nodes: nodes(),
			transfers: [transfer({ toNodeId: 'G' })],
			natural: [0],
			startDate: '2021-01-01'
		});
		expect(out.summary.warnings.some((w) => w.includes('transfers must be between farms'))).toBe(true);
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
		i.settings.dataQuality = { agreementMinRatio: 0.9, agreementMaxRatio: 1.1, agreementMinDays: 60 };
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
		// Q1 (engine ≥ 0.9.0): the engine puts pctUpstreamToDam of the upstream
		// inflow INTO the dam, as the column's label says; the workbook's formula
		// put it below the dam. Replay the workbook by feeding 1 − pct, so the
		// comparison below still tests the port, not the corrected meaning.
		// N3 (engine ≥ 0.14.0): effective rain carries over through a soil-water
		// store; the workbook has none. The replay switches it off (0 mm), which
		// is bit for bit the workbook's rule; the N3 test below runs it on.
		const modelInput: ModelInput = {
			// The workbook's natural flow is the legacy recession model's; GR4J is the default.
			settings: { ...project.settings, runoffModel: 'legacy', effectiveRainStoreMm: 0 },
			model: { ...project.model, nodes: project.model.nodes.map((n) => ({ ...n, pctUpstreamToDam: 1 - n.pctUpstreamToDam })) },
			series: Object.fromEntries(project.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }]))
		};
		// B1: days where CHIRPS stands in for blank catchment rain. The engine
		// bias-corrects CHIRPS there; the workbook uses it raw.
		const chirpsFallback = (() => {
			const d0 = toEpochDay(expected.startDate);
			const at = (kind: string, t: number) => {
				const s = project.series.find((x) => x.kind === kind);
				if (!s) return null;
				const v = s.values[d0 + t - toEpochDay(s.startDate)];
				return typeof v === 'number' && Number.isFinite(v) ? v : null;
			};
			return Uint8Array.from({ length: expected.days }, (_, t) =>
				at('rain_catchment_mm', t) === null && at('rain_chirps_mm', t) !== null ? 1 : 0
			);
		})();
		// Feed the workbook's own natural flow so this isolates the network port from the rain model.
		const natural = expected.catchment.natural_flow!.map((v) => v ?? 0);
		const t0 = Date.now();
		const out = runModelWith(modelInput, () => ({ naturalFlowM3Day: natural }));
		const elapsedMs = Date.now() - t0;
		const idByName = new Map(project.model.nodes.map((n) => [n.name, n.id]));
		const nodeByName = new Map(project.model.nodes.map((n) => [n.name, n]));
		const topo = buildTopology(project.model.nodes);
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
		//          fallback days; natural flow end to end is compared year by year
		//          with the correction off, and with it on only years holding
		//          fallback days may differ. The mean columns fed by demand
		//          (supplied, deficit, …) stay within their R1 bound.
		//   N3     (engine ≥ 0.14.0) effective rain carries over through a
		//          soil-water store (default 25 mm). Demand, and everything fed
		//          by it (supplied, deficit, storage, spill, outflow, the EWR
		//          shortfalls, curtailment), differ on the days after rain. Every
		//          comparison here runs with effectiveRainStoreMm: 0, the
		//          workbook's rule; the "N3:" test checks the store's effect.
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
			it(`matches Element sheet "${name}" within the deviation list`, () => {
				const id = idByName.get(name)!;
				const report: Record<string, string> = {};
				for (const key of keys) {
					if (!(key in want) || (want.kind === 'gauge' && !['outflow', 'ewr_cumulative', 'ewr_shortfall'].includes(key)))
						continue;
					const bad = compare(get(out, id, key), want[key]!, nodeRule(name, key));
					if (bad) report[key] = bad;
				}
				expect(report).toEqual({});
			});
		}

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

		it('matches the catchment simulated outflow and EWR within the deviation list', () => {
			expect(compare(get(out, null, 'simulated_outflow'), expected.catchment.simulated_outflow!, { kind: 'mean' })).toBeNull(); // R1
			expect(compare(get(out, null, 'ewr'), expected.catchment.ewr!, { kind: 'exact' })).toBeNull();
			expect(compare(get(out, null, 'ewr_shortfall'), expected.catchment.ewr_not_met!, { kind: 'mean' })).toBeNull(); // R1
		});

		/** Water years whose end-to-end natural flow is off the workbook's by more than E1/R1 allow. */
		function naturalFlowYearsOff(full: ReturnType<typeof runModel>): { wy: number; text: string }[] {
			// E1 (day-1 base flow) and R1 (no rounding floor in the recessions): compare
			// water-year volumes, allowing 2 % plus the workbook's rounding floor
			// 0.5 / (1 − f_max) m³/day, which the engine no longer adds on dry days.
			const cal = { ...defaultCal(), ...(project.settings.calibration as object | undefined) } as ReturnType<typeof defaultCal>;
			const floor = 0.5 / (1 - Math.max(...cal.recessionFactors)) + 1;
			const got = get(full, null, 'natural_flow');
			const want = expected.catchment.natural_flow!;
			const d0 = Math.round(Date.parse(`${expected.startDate}T00:00:00Z`) / 86_400_000);
			const years = new Map<number, { e: number; w: number; days: number }>();
			for (let t = 0; t < want.length; t++) {
				const d = new Date((d0 + t) * 86_400_000);
				const wy = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
				const y = years.get(wy) ?? { e: 0, w: 0, days: 0 };
				y.e += got[t]!;
				y.w += want[t] ?? 0;
				y.days++;
				years.set(wy, y);
			}
			return [...years]
				.filter(([, y]) => Math.abs(y.e - y.w) > 0.02 * y.w + y.days * floor)
				.map(([wy, y]) => ({ wy, text: `${wy}: engine ${y.e.toFixed(0)} vs workbook ${y.w.toFixed(0)} m³` }));
		}

		it('end to end (natural flow from the rain model too) stays within the deviation list', () => {
			// With the CHIRPS correction off, rain used is the workbook's: every year within E1/R1.
			const t1 = Date.now();
			const raw = runModel({ ...modelInput, settings: { ...modelInput.settings, chirpsBiasCorrection: 'none' } });
			expect(Date.now() - t1).toBeLessThan(1000);
			expect(naturalFlowYearsOff(raw).map((y) => y.text)).toEqual([]);
			// With it on (the default), only water years that hold corrected fallback days may differ (B1).
			const full = runModel(modelInput);
			const d0 = toEpochDay(expected.startDate);
			const b1Years = new Set<number>();
			chirpsFallback.forEach((f, t) => {
				if (!f) return;
				const d = new Date((d0 + t) * 86_400_000);
				b1Years.add(d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
			});
			expect(naturalFlowYearsOff(full).filter((y) => !b1Years.has(y.wy)).map((y) => y.text)).toEqual([]);
			const cal = { ...defaultCal(), ...(project.settings.calibration as object | undefined) } as ReturnType<typeof defaultCal>;
			const floor = 0.5 / (1 - Math.max(...cal.recessionFactors)) + 1;
			const sim = get(raw, null, 'simulated_outflow');
			const simW = expected.catchment.simulated_outflow!;
			const mean = (v: ArrayLike<number | null>) => Array.from(v).reduce<number>((s, x) => s + (x ?? 0), 0) / v.length;
			expect(Math.abs(mean(sim) - mean(simW))).toBeLessThanOrEqual(0.02 * mean(simW) + floor);
			expect(full.summary.calibration?.days).toBeGreaterThan(0);
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

		// The pivot table is written by a VBA macro, not by formulas, so it is only
		// as fresh as the last time someone ran it. In the client workbook
		// about a quarter of the farm-months hold volumes from an earlier model
		// state (e.g. one farm's Feb 1981 is 28 × its daily AB value in the Element
		// sheet *and* the [EWR shortfalls] sheet, but the pivot has a different
		// sum). So: every farm-month whose volume is current must match exactly,
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
		const wbCurtailment = (window: ReportWindow) =>
			computeCurtailment(
				Object.entries(expected.nodes)
					.filter(([, n]) => n.kind === 'farm')
					.map(([name, n]) => ({
						nodeId: idByName.get(name)!,
						name,
						demand: n.demand!.map((v) => v ?? 0),
						supplied: n.supplied!.map((v) => v ?? 0),
						ewrShortfallIncremental: n.ewr_shortfall_incremental!.map((v) => v ?? 0)
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
			// The saved reporting period is fully supplied, so it never exercises a non-trivial
			// target. Over the whole run the client catchment has deficits: replay the sheet's cell
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
				close(got.volumeLeftM3Day, M + r.R);
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

	it('W1: warns when the rain model makes more runoff than the rain that fell, and reports the runoff coefficient', () => {
		// One 10 mm winter storm on a dry 100 km² catchment: the base flow resets to the
		// storm peak and recedes along the slow part of the default curve, giving ~7× the rain volume.
		const rain = new Array(400).fill(0);
		rain[1] = 10;
		const out = runModel(rainInput(rain, '2021-07-01', { runoffModel: 'legacy', calibration: { ...defaultCal(), baseFlowInitial: 0 } }));
		const c = out.summary.catchment.runoffCoefficient!;
		const natural = get(out, null, 'natural_flow').reduce((a, b) => a + b, 0);
		expect(c).toBeCloseTo(natural / (10 * 100 * 1000), 9);
		expect(c).toBeGreaterThan(1);
		expect(warns(out, /more runoff than rainfall/)).toHaveLength(1);
		// A plausible catchment: no warning.
		const calm = runModel(rainInput(new Array(30).fill(5), '2021-01-01'));
		expect(calm.summary.catchment.runoffCoefficient!).toBeLessThan(1);
		expect(warns(calm, /more runoff than rainfall/)).toHaveLength(0);
	});

	it('W2: counts days with no rainfall value from any source (treated as dry)', () => {
		const out = runModel(rainInput([0, null, 3, null, null, 0], '2021-01-01'));
		expect(warns(out, /3 of 6 days have no rainfall value/)).toHaveLength(1);
		expect(warns(runModel(rainInput([0, 1, 2], '2021-01-01')), /no rainfall value/)).toHaveLength(0);
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

	it('W4: warns about a recession table that cannot describe a recession', () => {
		const cal = defaultCal();
		const factors = [...cal.recessionFactors];
		factors[3] = 1.2;
		const curve = [...cal.recessionCurveM3Day];
		curve[10] = curve[9]! + 1;
		const out = runModel(rainInput([0, 0], '2021-01-01', { runoffModel: 'legacy', calibration: { ...cal, recessionFactors: factors, recessionCurveM3Day: curve } }));
		expect(warns(out, /recession factor 4 is 1.2/)).toHaveLength(1);
		expect(warns(out, /recession curve rises/)).toHaveLength(1);
		expect(warns(runModel(rainInput([0, 0], '2021-01-01')), /recession/)).toHaveLength(0);
	});

	it('P1: natural flow never falls back to a Pitman series, so there is no W5 warning', () => {
		const i = rainInput([0, 0, 20], '2021-07-01', { runoffModel: 'legacy', calibration: { ...defaultCal(), baseFlowInitial: 0 } });
		(i.series as Record<string, unknown>).flow_pitman_m3s = { startDate: '2021-07-01', values: [0.5, 0.5, 0.5] };
		const out = runModel(i);
		expect(get(out, null, 'natural_flow').slice(0, 2)).toEqual([0, 0]);
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
		expect(resolveCatchmentAreaKm2({ catchmentAreaKm2: 205.1 }, input)).toBe(205.1);
	});
});
