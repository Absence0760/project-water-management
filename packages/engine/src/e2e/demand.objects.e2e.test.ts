// End-to-end: demand objects (docs/model.md §2.7f), their schedules
// (network/demandSchedule.ts), supply order with ranks, demand factors per
// part and the basic-needs floor, all through runModel. Invented names and
// values only.
//
// Unit A's dam holds a known volume on day 0 and gets nothing more (no
// runoff into it, no rain on it, no evaporation), so its supply each day is
// exactly MIN(storage left, demand) and every split can be worked by hand.
import { describe, expect, it } from 'vitest';
import type { CropArea, CropDef, DemandObject, DemandScheduleWindow, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, withVerification } from '../run';

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const flat = (v: number) => new Array(12).fill(v);

function unit(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
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
		damCapacityM3: 1e12,
		damInitialPct: 1,
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
const gauge = (): NetworkNode => unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, damCapacityM3: 0, damInitialPct: 0, sortOrder: 9 });

const obj = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'town',
	nodeId: 'A',
	name: 'Town (invented)',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: flat(100),
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

const win = (over: Partial<DemandScheduleWindow>): DemandScheduleWindow => ({ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: null, factor: 1, ...over });

interface Spec {
	start: string;
	days: number;
	objects?: DemandObject[];
	units?: NetworkNode[];
	crops?: CropDef[];
	areas?: CropArea[];
	apanMm?: number[];
	settings?: Record<string, unknown>;
}

function input(s: Spec): ModelInput {
	return {
		settings: {
			apanMm: (s.apanMm ?? flat(100)) as never,
			ewrPragmaticM3PerDay: flat(0) as never,
			lakeEvapFactor: 0,
			simulationStart: s.start,
			simulationEnd: iso(epoch(s.start) + s.days - 1),
			...s.settings
		},
		model: { nodes: [...(s.units ?? [unit('A')]), gauge()], crops: s.crops ?? [], cropAreas: s.areas ?? [], transfers: [], ...(s.objects ? { demandObjects: s.objects } : {}) },
		series: { rain_catchment_mm: { startDate: s.start, values: new Array(s.days).fill(0) } }
	};
}

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const has = (out: { series: RunSeries[] }, nodeId: string | null, key: string) => out.series.some((x) => x.nodeId === nodeId && x.key === key);
function run(i: ModelInput): ModelOutput {
	const out = withVerification(i, runModel(i));
	if (!out.summary.verification) throw new Error("no self-checks ran");
	const bad = out.summary.verification.checks.filter((c) => !c.passed) ?? [];
	if (bad.length) throw new Error(`self-check failed: ${JSON.stringify(bad).slice(0, 2000)}`);
	return out;
}
const round = (a: number[], dp = 9) => a.map((v) => +v.toFixed(dp));

// ---------------------------------------------------------------------------
// An independent schedule evaluator, written from the §2.7f table.
// ---------------------------------------------------------------------------

/** Western Easter Sundays for the years used here, from published calendars. */
const EASTER: Record<number, string> = { 2021: '2021-04-04', 2022: '2022-04-17', 2023: '2023-04-09', 2024: '2024-03-31', 2025: '2025-04-20' };

function scheduleFactor(windows: DemandScheduleWindow[], day: number): number {
	const d = new Date(day * DAY);
	const y = d.getUTCFullYear();
	const md = iso(day).slice(5);
	const weekday = ((d.getUTCDay() + 6) % 7) + 1; // ISO: Mon 1 … Sun 7
	let f = 1;
	for (const w of windows) {
		if (w.weekdays && !w.weekdays.includes(weekday)) continue;
		let hit = false;
		if (w.span === 'always') hit = true;
		else if (w.span === 'yearly') hit = w.from! <= w.to! ? md >= w.from! && md <= w.to! : md >= w.from! || md <= w.to!;
		else if (w.span === 'range') hit = iso(day) >= w.from! && iso(day) <= w.to!;
		else if (w.span === 'easter') {
			const e = epoch(EASTER[y]!);
			hit = day >= e + w.easterFrom! && day <= e + w.easterTo!;
		}
		if (hit) f = w.factor;
	}
	return f;
}

describe('demand object sizing (§2.7f)', () => {
	it('perUnit: count × litres ÷ 1000 × the month’s factor ÷ (1 − losses); monthly: the month’s value; months follow the water year', () => {
		const profile = flat(1);
		profile[2] = 1.5; // December
		const village = obj({ id: 'v', name: 'Village', category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 1000, litresPerUnitDay: 230, lossPct: 0.2, monthlyFactor: profile });
		const monthly = flat(10);
		monthly[3] = 40; // January
		const stock = obj({ id: 's', name: 'Stock', category: 'livestock', monthlyM3Day: monthly, priority: 'last' });
		const out = run(input({ start: '2021-11-30', days: 34, objects: [village, stock] }));
		const v = get(out, 'A', 'object_demand@v');
		const s = get(out, 'A', 'object_demand@s');
		// 30 Nov: 1000 × 230 ÷ 1000 ÷ 0.8 = 287.5; 1–31 Dec × 1.5 = 431.25; 1–2 Jan 287.5.
		expect(v[0]).toBeCloseTo(287.5, 12);
		expect(v[1]).toBeCloseTo(431.25, 12);
		expect(v[31]).toBeCloseTo(431.25, 12);
		expect(v[32]).toBeCloseTo(287.5, 12);
		expect(s[31]).toBe(10);
		expect(s[32]).toBe(40);
		// The unit's demand is the objects' sum (no crops), all supplied.
		const D = get(out, 'A', 'demand');
		for (let t = 0; t < 34; t++) expect(D[t]).toBeCloseTo(v[t]! + s[t]!, 9);
		expect(get(out, 'A', 'supplied')).toEqual(D);
	});

	it('a disabled object leaves the run as it was without it', () => {
		const crops = [{ id: 'c', name: 'Crop', cropFactor: flat(0.5) }];
		const areas = [{ nodeId: 'A', cropId: 'c', areaM2: 5000 }];
		const base = { start: '2021-10-01', days: 20, crops, areas, apanMm: flat(150) };
		const a = run(input(base));
		const b = run(input({ ...base, objects: [obj({ enabled: false })] }));
		expect(get(b, 'A', 'demand')).toEqual(get(a, 'A', 'demand'));
		expect(has(b, 'A', 'object_demand@town')).toBe(false);
	});
});

describe('demand object schedules (§2.7f, demandSchedule.ts)', () => {
	const windows = [
		win({ label: 'Weekends at half', span: 'always', weekdays: [6, 7], factor: 0.5 }),
		win({ label: 'Holiday shutdown', span: 'yearly', from: '12-24', to: '01-02', factor: 0 }),
		win({ label: 'Leap-day peak', span: 'yearly', from: '02-29', to: '02-29', factor: 3 }),
		win({ label: 'Easter weekend', span: 'easter', easterFrom: -2, easterTo: 1, factor: 0 }),
		win({ label: 'Works shutdown', span: 'range', from: '2024-03-04', to: '2024-03-06', factor: 0.25 })
	];

	for (const [start, end] of [
		['2023-12-15', '2024-04-15'],
		['2022-12-15', '2023-04-20'],
		['2024-12-15', '2025-04-30']
	] as const) {
		it(`matches the window rules day by day, ${start} … ${end} (year-end wrap, 29 February, Easter, weekdays, later window wins)`, () => {
			const days = epoch(end) - epoch(start) + 1;
			const out = run(input({ start, days, objects: [obj({ schedule: windows })] }));
			const got = get(out, 'A', 'object_demand@town');
			const d0 = epoch(start);
			const want = Array.from({ length: days }, (_, t) => 100 * scheduleFactor(windows, d0 + t));
			for (let t = 0; t < days; t++) if (Math.abs(got[t]! - want[t]!) > 1e-9) throw new Error(`${iso(d0 + t)}: expected ${want[t]}, got ${got[t]}`);
			// Days off are counted, and are never days short.
			const o = out.summary.farms.find((f) => f.nodeId === 'A')!.demandObjects![0]!;
			expect(o.daysOff).toBe(want.filter((v) => v === 0).length);
			expect(o.daysShort).toBe(0);
		});
	}

	it('hand-checked days around Easter 2024 and the leap day', () => {
		const start = '2024-02-27';
		const days = 40;
		const out = run(input({ start, days, objects: [obj({ schedule: windows })] }));
		const v = get(out, 'A', 'object_demand@town');
		const at = (s: string) => v[epoch(s) - epoch(start)];
		expect(at('2024-02-28')).toBe(100); // Wednesday
		expect(at('2024-02-29')).toBe(300); // Thursday, leap-day peak
		expect(at('2024-03-02')).toBe(50); // Saturday
		expect(at('2024-03-05')).toBe(25); // works shutdown
		expect(at('2024-03-28')).toBe(100); // Maundy Thursday
		expect(at('2024-03-29')).toBe(0); // Good Friday (−2)
		expect(at('2024-03-31')).toBe(0); // Easter Sunday
		expect(at('2024-04-01')).toBe(0); // Family Day (+1)
		expect(at('2024-04-02')).toBe(100);
	});

	it('a schedule window that changes nothing runs to the bit as no schedule', () => {
		const start = '2021-10-01';
		const a = run(input({ start, days: 30, objects: [obj()] }));
		const b = run(input({ start, days: 30, objects: [obj({ schedule: [win({ factor: 1 }), win({ span: 'range', from: '2030-01-01', to: '2030-01-31', factor: 0 })] })] }));
		expect(get(b, 'A', 'object_demand@town')).toEqual(get(a, 'A', 'object_demand@town'));
		expect(get(b, 'A', 'supplied')).toEqual(get(a, 'A', 'supplied'));
	});

	it('a bad window is skipped with a warning and the rest still run', () => {
		const out = run(input({ start: '2021-10-01', days: 3, objects: [obj({ schedule: [win({ factor: 11 }), win({ span: 'range', from: '2021-10-02', to: '2021-10-02', factor: 0 })] })] }));
		expect(get(out, 'A', 'object_demand@town')).toEqual([100, 0, 100]);
		expect(out.summary.warnings.some((w) => w.includes('schedule window 1') && w.includes('skipped'))).toBe(true);
	});
});

describe('supply order on a short day (§2.7f, ranks)', () => {
	// Crops: F = 200 m³/day in October (6 200 m² × 1 000 mm × 1 ÷ 1000 ÷ 31), e = 0.5, so 400 abstracted, β = 0.5.
	const crops = [{ id: 'c', name: 'Crop', cropFactor: flat(1) }];
	const areas = [{ nodeId: 'A', cropId: 'c', areaM2: 6200 }];
	const apan = flat(1000);
	const objects = [
		obj({ id: 'o1', name: 'Senior town', priority: 'first', rank: 1, monthlyM3Day: flat(300), returnPct: 0.4 }),
		obj({ id: 'o2', name: 'Junior town', priority: 'first', rank: 2, monthlyM3Day: flat(500), returnPct: 0 }),
		obj({ id: 'o3', name: 'Packhouse', category: 'industrial', priority: 'shared', monthlyM3Day: flat(100), returnPct: 1 }),
		obj({ id: 'o4', name: 'Bulk export', category: 'external', priority: 'last', monthlyM3Day: flat(200), destination: 'external', returnPct: 0 })
	];
	const dam = (m3: number) => unit('A', { damCapacityM3: m3, damInitialPct: 1, irrigationEfficiency: 0.5, returnFlowFraction: 0.25 });

	it('each level in full before the next; the crops share their level pro rata with the shared objects', () => {
		// 1 000 m³ in the dam, 1 400 wanted: o1 300, o2 500, then 200 for crops (400) + o3 (100) → 4/5 each... 200/500 = 0.4.
		const out = run(input({ start: '2021-10-01', days: 2, crops, areas, apanMm: apan, objects, units: [dam(1000)] }));
		expect(get(out, 'A', 'demand')[0]).toBeCloseTo(1500, 9);
		expect(get(out, 'A', 'supplied')[0]).toBeCloseTo(1000, 9);
		expect(get(out, 'A', 'object_supplied@o1')[0]).toBeCloseTo(300, 9);
		expect(get(out, 'A', 'object_supplied@o2')[0]).toBeCloseTo(500, 9);
		expect(get(out, 'A', 'object_supplied@o3')[0]).toBeCloseTo(40, 9);
		expect(get(out, 'A', 'object_supplied@o4')[0]).toBeCloseTo(0, 9);
		// Crops got 160. T = β(1 − e) × 160 + 0.4 × 300 + 1 × 40 = 40 + 120 + 40 = 200.
		expect(get(out, 'A', 'return_flow')[0]).toBeCloseTo(200, 9);
		expect(get(out, 'A', 'deficit')[0]).toBeCloseTo(500, 9);
		// Day 1: the dam is empty.
		expect(get(out, 'A', 'supplied')[1]).toBe(0);
	});

	it('a dam that covers everything gives every member its demand exactly', () => {
		const out = run(input({ start: '2021-10-01', days: 1, crops, areas, apanMm: apan, objects, units: [dam(1e6)] }));
		expect([1, 2, 3, 4].map((k) => get(out, 'A', `object_supplied@o${k}`)[0])).toEqual([300, 500, 100, 200]);
		// T = 0.25 × 400 + 120 + 0 + 100 + 0 = 320 (the external object returns nothing).
		expect(get(out, 'A', 'return_flow')[0]).toBeCloseTo(320, 9);
	});

	it('two objects of one rank share pro rata; a short first level leaves the crops nothing', () => {
		const two = [obj({ id: 'p', monthlyM3Day: flat(300) }), obj({ id: 'q', monthlyM3Day: flat(100) })];
		const out = run(input({ start: '2021-10-01', days: 1, crops, areas, apanMm: apan, objects: two, units: [dam(200)] }));
		expect(get(out, 'A', 'object_supplied@p')[0]).toBeCloseTo(150, 9);
		expect(get(out, 'A', 'object_supplied@q')[0]).toBeCloseTo(50, 9);
		expect(get(out, 'A', 'supplied')[0]).toBeCloseTo(200, 9);
		// Nothing for the crops: return flow is only the objects' (0 here).
		expect(get(out, 'A', 'return_flow')[0]).toBeCloseTo(0, 9);
	});

	it('object summaries are the means of the object series', () => {
		const out = run(input({ start: '2021-10-01', days: 3, crops, areas, apanMm: apan, objects, units: [dam(2000)] }));
		const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
		const f = out.summary.farms.find((x) => x.nodeId === 'A')!;
		for (const o of f.demandObjects!) {
			const d = get(out, 'A', `object_demand@${o.id}`);
			const g = get(out, 'A', `object_supplied@${o.id}`);
			expect(o.avgDemandM3Day).toBeCloseTo(mean(d), 9);
			expect(o.avgSuppliedM3Day).toBeCloseTo(mean(g), 9);
			expect(o.daysShort).toBe(d.filter((v, t) => g[t]! < v * (1 - 1e-12)).length);
		}
		expect(f.avgDemandM3Day).toBeCloseTo(mean(get(out, 'A', 'demand')), 9);
		// The irrigation part is the unit's demand less the objects' (FarmSummary doc).
		expect(f.avgDemandM3Day - f.demandObjects!.reduce((s, o) => s + o.avgDemandM3Day, 0)).toBeCloseTo(400, 9);
	});
});

describe('demand factors per part and the basic-needs floor (§2.7f)', () => {
	const crops = [{ id: 'c', name: 'Crop', cropFactor: flat(1) }];
	const areas = [{ nodeId: 'A', cropId: 'c', areaM2: 3100 }]; // F = 100 m³/day in October at A-pan 1 000
	const village = (over: Partial<DemandObject> = {}) => obj({ id: 'v', name: 'Village', category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 1000, litresPerUnitDay: 230, ...over });

	it('a unit factor × a part factor scales crops and objects month by month', () => {
		const unitF = flat(0.8);
		const out = run(
			input({
				start: '2021-10-01',
				days: 2,
				crops,
				areas,
				apanMm: flat(1000),
				objects: [village(), obj({ id: 'mill', category: 'industrial', monthlyM3Day: flat(50) })],
				units: [unit('A', { demandFactor: unitF, partDemandFactor: { crops: flat(0.5), industrial: flat(0.25) } })]
			})
		);
		expect(get(out, 'A', 'crop_requirement')[0]).toBeCloseTo(100 * 0.8 * 0.5, 9);
		// The village has a floor of 25 m³/day; 230 × 0.8 = 184 stays above it.
		expect(get(out, 'A', 'object_demand@v')[0]).toBeCloseTo(184, 9);
		expect(get(out, 'A', 'object_demand@mill')[0]).toBeCloseTo(50 * 0.8 * 0.25, 9);
	});

	it('a restriction never takes a domestic object below MIN(floor, its demand); a day off stays off', () => {
		// Floor B = 1000 × 25 ÷ 1000 = 25 m³/day. Factor 0.05: 11.5 → held at 25. Sunday off.
		const sched = [win({ weekdays: [7], factor: 0 })];
		const out = run(input({ start: '2021-10-01', days: 3, objects: [village({ schedule: sched })], units: [unit('A', { demandFactor: flat(0.05) })] }));
		// 1 Oct 2021 Friday, 2 Saturday, 3 Sunday.
		expect(round(get(out, 'A', 'object_demand@v'))).toEqual([25, 25, 0]);
		expect(round(get(out, 'A', 'basic_needs'))).toEqual([25, 25, 0]);
		const o = out.summary.farms.find((f) => f.nodeId === 'A')!.demandObjects![0]!;
		expect(o.basicNeedsM3Day).toBe(25);
		expect(o.basicNeedsPopulation).toBe(1000);
		expect(o.daysBelowBasicNeeds).toBe(0);
		// At the tap: mean supplied (50 ÷ 3) × 1000 ÷ 1000 people.
		expect(o.avgSuppliedLitresPerPersonDay).toBeCloseTo(50 / 3, 9);
	});

	it('the floor is grossed up for losses on a per-unit object', () => {
		const out = run(input({ start: '2021-10-01', days: 1, objects: [village({ lossPct: 0.5 })], units: [unit('A', { demandFactor: flat(0) })] }));
		// B = 25 ÷ 0.5 = 50 m³/day abstracted, so 25 m³ reach the tap.
		expect(get(out, 'A', 'object_demand@v')[0]).toBeCloseTo(50, 9);
	});

	it('a floor above the demand holds the unrestricted demand, not more', () => {
		const out = run(input({ start: '2021-10-01', days: 1, objects: [village({ population: 20_000 })], units: [unit('A', { demandFactor: flat(0.5) })] }));
		// B = 500 > 230: MAX(115, MIN(500, 230)) = 230.
		expect(get(out, 'A', 'object_demand@v')[0]).toBeCloseTo(230, 9);
	});

	it('a monthly municipal object without a population has no floor; a livestock object never has one', () => {
		const out = run(
			input({
				start: '2021-10-01',
				days: 1,
				objects: [obj({ id: 'm', monthlyM3Day: flat(100) }), obj({ id: 'l', category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 500, litresPerUnitDay: 45 })],
				units: [unit('A', { demandFactor: flat(0) })]
			})
		);
		expect(get(out, 'A', 'object_demand@m')[0]).toBe(0);
		expect(get(out, 'A', 'object_demand@l')[0]).toBe(0);
		expect(has(out, 'A', 'basic_needs')).toBe(false);
	});

	it('a short day below the floor is reported as days below basic needs', () => {
		// 10 m³ in the dam for a 25 m³ floor on a fully cut day.
		const out = run(input({ start: '2021-10-01', days: 2, objects: [village()], units: [unit('A', { demandFactor: flat(0), damCapacityM3: 10, damInitialPct: 1 })] }));
		const o = out.summary.farms.find((f) => f.nodeId === 'A')!.demandObjects![0]!;
		expect(round(get(out, 'A', 'object_supplied@v'))).toEqual([10, 0]);
		expect(o.daysBelowBasicNeeds).toBe(2);
		expect(o.avgBelowBasicNeedsM3Day).toBeCloseTo((15 + 25) / 2, 9);
	});
});

describe('return of piped-out and internal objects (§2.7f)', () => {
	it('an external object returns nothing even with a return share entered, and the run warns', () => {
		const out = run(input({ start: '2021-10-01', days: 1, objects: [obj({ id: 'x', category: 'external', destination: 'external', returnPct: 0.6 }), obj({ id: 'y', returnPct: 0.25, priority: 'last' })] }));
		// 100 to each; only y returns 25.
		expect(get(out, 'A', 'return_flow')[0]).toBeCloseTo(25, 9);
		expect(out.summary.warnings.some((w) => w.includes('piped out of the catchment'))).toBe(true);
		const f = out.summary.farms.find((x) => x.nodeId === 'A')!;
		expect(f.demandObjects!.find((o) => o.id === 'x')!.avgReturnedM3Day).toBe(0);
		expect(f.demandObjects!.find((o) => o.id === 'y')!.avgReturnedM3Day).toBeCloseTo(25, 9);
	});

	it('an object on a gauge is skipped with a warning', () => {
		const out = run(input({ start: '2021-10-01', days: 1, objects: [obj({ nodeId: 'G' })] }));
		expect(has(out, 'G', 'object_demand@town')).toBe(false);
		expect(out.summary.warnings.some((w) => w.includes('only a unit has demand objects'))).toBe(true);
	});
});
