// End-to-end: development that changes during a run (docs/model.md §2.7g) —
// a dam in service from a date, sediment, abstraction from a date — and the
// dam storage reset (settings.damStorageReset, §2.15a), each run through the
// whole model on a small synthetic catchment with a fixed natural flow and
// checked day by day against values worked by hand. Invented values only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
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
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];
const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
const DIM = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];

interface Spec {
	nodes: NetworkNode[];
	days: number;
	start?: string;
	settings?: ModelInput['settings'];
	/** Crop factor per water-year month chosen so the gross demand is this m³/day every month (area 1000 m²). */
	need?: Record<string, number>;
}

function input(s: Spec): ModelInput {
	const crops = Object.entries(s.need ?? {}).map(([id, need]) => ({ id: `c-${id}`, name: `Crop ${id}`, cropFactor: APAN.map((a, m) => (need * DIM[m]! * 1000) / (a * 1000)) }));
	return {
		settings: { apanMm: APAN as never, effectiveRainFraction: 0, lakeEvapFactor: 0, ewrPragmaticM3PerDay: flat(0) as never, ...(s.settings ?? {}) },
		model: {
			nodes: s.nodes,
			crops,
			cropAreas: Object.keys(s.need ?? {}).map((nodeId) => ({ nodeId, cropId: `c-${nodeId}`, areaM2: 1000 })),
			transfers: []
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
const opt = (o: ModelOutput, id: string | null, key: string) => o.series.find((x) => x.nodeId === id && x.key === key)?.values;
const checksPass = (o: ModelOutput) => expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
const closeAll = (got: number[], want: number[], what: string, digits = 6) => {
	expect(got.length, what).toBe(want.length);
	want.forEach((v, t) => expect(got[t], `${what} day ${t}`).toBeCloseTo(v, digits));
};
/** Series and summary but the warnings (a dated field adds its own). */
const body = (o: ModelOutput) => ({ series: o.series.filter((s) => s.key !== 'dam_capacity'), farms: o.summary.farms });

describe('a dam in service from a date (§2.7g)', () => {
	const nodes = (from: string | null) => [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 1000, damInitialPct: 0.5, damInServiceFrom: from })];

	it('before the date the unit has no dam: what is routed to it spills; from the date it fills from empty', () => {
		const o = run(input({ nodes: nodes('2021-01-04'), days: 7 }), new Array(7).fill(300));
		closeAll(col(o, 'A', 'dam_capacity'), [0, 0, 0, 1000, 1000, 1000, 1000], 'capacity');
		// The initial level × the first day's capacity (0) = 0.
		closeAll(col(o, 'A', 'dam_storage'), [0, 0, 0, 300, 600, 900, 1000], 'storage');
		closeAll(col(o, 'A', 'spill'), [300, 300, 300, 0, 0, 0, 200], 'spill');
		closeAll(col(o, 'A', 'outflow'), [300, 300, 300, 0, 0, 0, 200], 'outflow');
		checksPass(o);
	});

	it('in service from 1 October, with a run starting in September', () => {
		const o = run(input({ nodes: nodes('2021-10-01'), days: 4, start: '2021-09-29' }), new Array(4).fill(300));
		closeAll(col(o, 'A', 'dam_storage'), [0, 0, 300, 600], 'storage');
		closeAll(col(o, 'A', 'spill'), [300, 300, 0, 0], 'spill');
	});

	it('in service on or before the run’s first day runs as a dam without the field, to the bit', () => {
		const natural = new Array(5).fill(300);
		const plain = run(input({ nodes: nodes(null), days: 5 }), natural);
		for (const d of ['2021-01-01', '2019-06-30']) {
			const o = run(input({ nodes: nodes(d), days: 5 }), natural);
			expect(body(o), d).toEqual(body(plain));
		}
		expect(col(plain, 'A', 'dam_storage')[0]).toBe(800);
	});

	it('in service after the run’s last day: no dam on any day, the same as a unit without one', () => {
		const natural = [300, 0, 500, 100];
		const later = run(input({ nodes: nodes('2030-01-01'), days: 4, need: { A: 200 } }), natural);
		const none = run(input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G')], days: 4, need: { A: 200 } }), natural);
		for (const k of ['supplied', 'outflow', 'deficit']) expect(col(later, 'A', k), k).toEqual(col(none, 'A', k));
		closeAll(col(later, 'A', 'dam_storage'), [0, 0, 0, 0], 'storage');
	});
});

describe('sediment (§2.7g)', () => {
	it('the capacity falls linearly from the survey; a full dam spills what it can no longer hold', () => {
		// 36 525 m³ at 10 %/year: 10 m³ a day.
		const days = 6;
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 36_525, damInitialPct: 1, damSurveyDate: '2021-01-03', damSedimentPctPerYear: 0.1 })],
			days
		});
		const o = run(i, new Array(days).fill(0));
		// Two days before the survey the dam held 20 m³ more.
		const cap = [36_545, 36_535, 36_525, 36_515, 36_505, 36_495];
		closeAll(col(o, 'A', 'dam_capacity'), cap, 'capacity');
		// Starting full at the first day's capacity, then held at each day's capacity.
		closeAll(col(o, 'A', 'dam_storage'), cap, 'storage');
		closeAll(col(o, 'A', 'spill'), [0, 10, 10, 10, 10, 10], 'spill');
		checksPass(o);
	});

	it('dead storage scales with the day’s capacity', () => {
		const days = 3;
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 36_525, damInitialPct: 0.5, damMinPct: 0.4, damSurveyDate: '2020-01-01', damSedimentPctPerYear: 0.2 })],
			days,
			need: { A: 100_000 }
		});
		const o = run(i, new Array(days).fill(0));
		const cap = col(o, 'A', 'dam_capacity');
		// 2021-01-01 is 366 days after the survey: k = 1 − 0.2 × 366 / 365.25.
		expect(cap[0]).toBeCloseTo(36_525 * (1 - (0.2 * 366) / 365.25), 6);
		// Day 0: storage 0.5 × cap0, drawn to 0.4 × cap0.
		expect(col(o, 'A', 'supplied')[0]).toBeCloseTo(0.1 * cap[0]!, 6);
		expect(col(o, 'A', 'dam_storage')[0]).toBeCloseTo(0.4 * cap[0]!, 6);
		// Day 1: dead storage is 0.4 × cap1, which is 0.4 × 20 m³ lower: that much is supplied.
		expect(col(o, 'A', 'supplied')[1]).toBeCloseTo(0.4 * (cap[0]! - cap[1]!), 6);
	});
});

describe('abstraction from a date (§2.7g)', () => {
	it('a farm’s demand is 0 before the date and in full from it; before the run = always, after it = never', () => {
		const days = 4;
		const make = (from: string | null) => input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { pctRunoffToDam: 1, abstractionFrom: from })], days, need: { A: 200 } });
		const natural = new Array(days).fill(1000);
		const o = run(make('2021-01-03'), natural);
		closeAll(col(o, 'A', 'demand'), [0, 0, 200, 200], 'demand');
		closeAll(col(o, 'A', 'supplied'), [0, 0, 200, 200], 'supplied');
		closeAll(col(o, 'A', 'outflow'), [1000, 1000, 800, 800], 'outflow');
		const always = run(make(null), natural);
		expect(body(run(make('2020-05-05'), natural))).toEqual(body(always));
		closeAll(col(run(make('2021-02-01'), natural), 'A', 'demand'), [0, 0, 0, 0], 'after the run');
		const f = o.summary.farms[0]!;
		expect(f.avgDemandM3Day).toBeCloseTo(100, 9);
		expect(f.fractionSupplied).toBeCloseTo(1, 12);
	});

	it('a senior user’s claim on the farms upstream starts with its abstraction date', () => {
		const days = 4;
		const nodes = [
			node('G', 'gauge', null),
			node('T', 'user', 'G', { userDemandM3Day: flat(400), userPriority: 'senior', abstractionFrom: '2021-01-03' }),
			node('A', 'farm', 'T', { damCapacityM3: 1e6 })
		];
		const o = run(input({ nodes, days }), new Array(days).fill(1000));
		closeAll(col(o, 'A', 'senior_requirement'), [0, 0, 400, 400], 'Zs');
		closeAll(col(o, 'T', 'supplied'), [0, 0, 400, 400], 'T supplied');
		closeAll(col(o, 'A', 'dam_storage'), [1000, 2000, 2600, 3200], 'A storage');
	});
});

describe('abstraction from a date keeps the soil water running (§2.7g)', () => {
	it('from the start date the demand is the one the run without the date has, the soil-water store included', () => {
		const days = 60;
		const rain = Array.from({ length: days }, (_, t) => (t % 5 === 0 ? 25 : t % 7 === 0 ? 8 : 0));
		const make = (from: string | null): ModelInput => {
			const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { abstractionFrom: from })], days, need: { A: 300 }, settings: { effectiveRainFraction: 0.8 } });
			i.series.rain_catchment_mm = { startDate: '2021-01-01', values: rain };
			return i;
		};
		const natural = new Array(days).fill(500);
		const plain = run(make(null), natural);
		const late = run(make('2021-01-20'), natural);
		const d0 = col(plain, 'A', 'demand');
		const d1 = col(late, 'A', 'demand');
		// Effective rain really bites some days, so the soil store matters.
		expect(d0.some((v) => v < 300 - 1)).toBe(true);
		expect(d1.slice(0, 19)).toEqual(new Array(19).fill(0));
		expect(d1.slice(19)).toEqual(d0.slice(19));
	});

	it('warns when sediment run back from the survey makes the dam more than 1.25 × its surveyed capacity', () => {
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 1000, damSurveyDate: '2031-01-01', damSedimentPctPerYear: 0.05 })], days: 3 });
		const o = run(i, [0, 0, 0]);
		expect(col(o, 'A', 'dam_capacity')[0]).toBeCloseTo(1000 * (1 + (0.05 * (epochOf('2031-01-01') - epochOf('2021-01-01'))) / 365.25), 6);
		expect(o.summary.warnings.some((w) => w.includes('unit "A"') && w.includes('× its surveyed capacity'))).toBe(true);
	});
});

const epochOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

describe('dam storage reset (settings.damStorageReset)', () => {
	it('the dam starts the reset day from the storage set; the step is published and the balance closes with it', () => {
		const days = 6;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.5 })];
		const i = input({ nodes, days, need: { A: 1000 }, settings: { damStorageReset: { date: '2021-01-04', storageM3: { A: 8000 } } } });
		const o = run(i, new Array(days).fill(200));
		// 5000 → 4200 → 3400 → (set 8000) 7200 → 6400 → 5600
		closeAll(col(o, 'A', 'dam_storage'), [4200, 3400, 2600, 7200, 6400, 5600], 'storage');
		closeAll(col(o, 'A', 'dam_storage_set'), [0, 0, 0, 8000 - 2600, 0, 0], 'step');
		const wb = o.summary.waterBalance!;
		expect(wb.total.storageSetM3).toBeCloseTo(5400, 6);
		expect(Math.abs(wb.total.residualM3)).toBeLessThan(1e-6);
		checksPass(o);
	});

	it('a reset on the run’s first day replaces the initial storage; one above capacity is clamped to it', () => {
		const days = 2;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.5 })];
		const o = run(input({ nodes, days, settings: { damStorageReset: { date: '2021-01-01', storageM3: { A: 25_000 } } } }), [100, 100]);
		closeAll(col(o, 'A', 'dam_storage_set'), [5000, 0], 'step');
		closeAll(col(o, 'A', 'dam_storage'), [10_000, 10_000], 'storage');
		closeAll(col(o, 'A', 'spill'), [100, 100], 'spill');
	});

	it('a reset on a dam whose capacity changes is clamped to that day’s capacity', () => {
		const days = 3;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 36_525, damInitialPct: 0, damSurveyDate: '2021-01-01', damSedimentPctPerYear: 0.1 })];
		const o = run(input({ nodes, days, settings: { damStorageReset: { date: '2021-01-02', storageM3: { A: 1e9 } } } }), [0, 0, 0]);
		closeAll(col(o, 'A', 'dam_storage'), [0, 36_515, 36_505], 'storage');
		closeAll(col(o, 'A', 'spill'), [0, 0, 10], 'spill');
		expect(opt(o, 'A', 'dam_storage_set')![1]).toBeCloseTo(36_515, 6);
	});
});

describe('the water balance per water year (summary.waterBalance)', () => {
	it('each row is the sum of the daily series over its water year, opening = the previous closing, and it closes', () => {
		// 2021-09-01 … 2022-11-29: three water years, a dam in service from 15 October, sediment, a reset, a user and boreholes.
		const days = 455;
		const nodes = [
			node('G', 'gauge', null),
			node('T', 'user', 'G', { userDemandM3Day: flat(150), userPriority: 'senior', userReturnPct: 0.3, boreholeCapacityM3Day: 40, streamDepletionFrac: 0.5, streamDepletionLagDays: 3 }),
			node('A', 'farm', 'T', { damCapacityM3: 20_000, damInitialPct: 0.4, damMinPct: 0.1, damAreaFullM2: 9_000, damSeepagePerDay: 0.002, damSeepageReturnPct: 0.6, damSurveyDate: '2022-01-01', damSedimentPctPerYear: 0.05, irrigationEfficiency: 0.8, lossReturnFraction: 0.5, boreholeCapacityM3Day: 60, streamDepletionFrac: 1 }),
			node('B', 'farm', 'A', { damCapacityM3: 6_000, damInitialPct: 1, damAreaFullM2: 3_000, damInServiceFrom: '2021-10-15', damReleaseRule: 'fixed', damReleaseM3Day: flat(20) })
		];
		const natural = Array.from({ length: days }, (_, t) => (t % 9 === 0 ? 3000 : 120 + 80 * Math.sin(t / 30)));
		const i = input({ nodes, days, start: '2021-09-01', need: { A: 180, B: 60 }, settings: { lakeEvapFactor: 0.75, damStorageReset: { date: '2022-03-01', storageM3: { A: 15_000 } } } });
		const o = run(i, natural);
		checksPass(o);
		const wb = o.summary.waterBalance!;
		expect(wb.years.map((y) => [y.waterYear, y.days])).toEqual([
			[2020, 30],
			[2021, 365],
			[2022, 60]
		]);
		const z = new Array(days).fill(0);
		const tot = (key: string, ids: string[]) => z.map((_, t) => ids.reduce((a, id) => a + (opt(o, id, key)?.[t] ?? 0), 0));
		const farms = ['A', 'B'];
		const storage = tot('dam_storage', farms);
		const sums = {
			naturalFlowM3: natural,
			farmRunoffM3: tot('runoff', farms),
			suppliedM3: tot('supplied', farms),
			returnFlowM3: tot('return_flow', farms),
			damEvaporationM3: tot('dam_evaporation', farms),
			damSeepageLostM3: tot('dam_seepage_lost', farms),
			damReleaseM3: tot('dam_release', farms),
			spillM3: tot('spill', farms),
			outflowM3: col(o, 'G', 'outflow'),
			groundwaterM3: z.map((_, t) => tot('groundwater_used', ['A', 'T'])[t]!),
			streamDepletionM3: tot('baseflow_depletion', ['A', 'T']),
			storageSetM3: tot('dam_storage_set', ['A']),
			otherUseM3: z.map((_, t) => col(o, 'T', 'supplied')[t]! - col(o, 'T', 'return_flow')[t]!)
		};
		let from = 0;
		// A at its initial level × the first day's capacity; B is not in service on day 0.
		let opening = 0.4 * col(o, 'A', 'dam_capacity')[0]!;
		for (const y of wb.years) {
			const to = from + y.days;
			expect(y.openingStorageM3, `${y.waterYear} opening`).toBeCloseTo(opening, 6);
			for (const [k, s] of Object.entries(sums)) expect((y as unknown as Record<string, number>)[k], `${y.waterYear} ${k}`).toBeCloseTo(s.slice(from, to).reduce((a, v) => a + v, 0), 4);
			expect(y.closingStorageM3, `${y.waterYear} closing`).toBeCloseTo(storage[to - 1]!, 6);
			expect(Math.abs(y.residualM3), `${y.waterYear} residual`).toBeLessThan(1e-6 * (y.naturalFlowM3 + y.openingStorageM3));
			opening = y.closingStorageM3;
			from = to;
		}
	});
});
