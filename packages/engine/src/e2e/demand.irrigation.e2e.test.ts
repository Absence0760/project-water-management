// End-to-end: irrigation demand (docs/model.md §2.3, §2.3a) through the
// whole runModel, against an independent re-derivation from the formulas in
// model.md. Synthetic one-unit catchments with invented names and values.
//
// Unit A has a dam far larger than anything it can use, full on day 0, with
// no evaporation, seepage or runoff into it, so every day it is supplied its
// whole abstraction demand D and the series under test are the demand chain
// alone: gross_demand → effective_rain / soil_water → crop_requirement F →
// demand D = F ÷ e.
import { describe, expect, it } from 'vitest';
import type { CropArea, CropDef, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, withVerification } from '../run';
import { Rng } from '../testing/fuzz';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const calMonth = (d: number) => new Date(d * DAY).getUTCMonth() + 1;
/** Water-year month index: Oct = 0 … Sep = 11 (model.md §2.1). */
const wyIndex = (d: number) => (calMonth(d) + 2) % 12;

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

interface Spec {
	start: string;
	rain: (number | null)[];
	apanMm: number[];
	crops: CropDef[];
	areas: CropArea[];
	units?: NetworkNode[];
	settings?: Record<string, unknown>;
	apanDaily?: { startDate: string; values: (number | null)[] };
}

function input(s: Spec): ModelInput {
	const end = iso(epoch(s.start) + s.rain.length - 1);
	return {
		settings: {
			apanMm: s.apanMm as never,
			ewrPragmaticM3PerDay: new Array(12).fill(0) as never,
			lakeEvapFactor: 0,
			simulationStart: s.start,
			simulationEnd: end,
			...s.settings
		},
		model: { nodes: [...(s.units ?? [unit('A')]), gauge()], crops: s.crops, cropAreas: s.areas, transfers: [] },
		series: {
			rain_catchment_mm: { startDate: s.start, values: s.rain },
			...(s.apanDaily ? { evap_apan_mm: s.apanDaily } : {})
		}
	};
}

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}

/** Relative closeness for whole series. */
function expectSeriesClose(actual: number[], expected: number[], what: string, rel = 1e-9) {
	expect(actual.length, `${what}: length`).toBe(expected.length);
	for (let t = 0; t < expected.length; t++) {
		const a = actual[t]!;
		const e = expected[t]!;
		const tol = rel * Math.max(1, Math.abs(e));
		if (!(Math.abs(a - e) <= tol)) throw new Error(`${what}: day ${t} expected ${e}, got ${a}`);
	}
}

// ---------------------------------------------------------------------------
// An independent re-derivation of §2.3 steps 1–5 (and §2.3a), written from the
// doc rather than from demand.ts.
// ---------------------------------------------------------------------------

interface Expect {
	gross: number[];
	effective: number[];
	soil: number[];
	F: number[];
}

function reference(o: {
	start: string;
	rain: (number | null)[];
	apanMm: number[];
	crops: { cf: number[]; area: number }[];
	threshold?: number;
	er?: number;
	erMonthly?: number[];
	storeMm?: number;
	feb?: number;
	apanDaily?: (number | null)[];
}): Expect {
	const thr = o.threshold ?? 2;
	const er = o.er ?? 0.65;
	const store = o.storeMm ?? 25;
	const feb = o.feb ?? 28.25;
	const dim = [31, 30, 31, 31, feb, 31, 30, 31, 30, 31, 31, 30];
	const area = o.crops.reduce((s, c) => s + c.area, 0);
	const smax = (area * store) / 1000;
	const d0 = epoch(o.start);
	const out: Expect = { gross: [], effective: [], soil: [], F: [] };
	let W = 0;
	for (let t = 0; t < o.rain.length; t++) {
		const m = wyIndex(d0 + t);
		const daily = o.apanDaily?.[t];
		const useDaily = typeof daily === 'number' && Number.isFinite(daily) && daily >= 0;
		let gross = 0;
		for (const c of o.crops) gross += useDaily ? (c.area * c.cf[m]! * daily) / 1000 : (c.area * o.apanMm[m]! * c.cf[m]!) / 1000 / dim[m]!;
		const r = o.rain[t] ?? 0;
		const rainUsed = r > thr ? r : 0;
		const frac = o.erMonthly ? o.erMonthly[m]! : er;
		const pe = (area * frac * rainUsed) / 1000;
		const available = W + pe;
		const need = Math.max(0, gross);
		const used = need - available <= 1e-12 * need ? need : available;
		W = Math.min(smax, Math.max(0, available - used));
		out.gross.push(gross);
		out.effective.push(used);
		out.soil.push(area > 0 ? (W * 1000) / area : 0);
		out.F.push(need - used);
	}
	return out;
}

const APAN = [150, 190, 230, 250, 200, 170, 110, 70, 50, 55, 80, 115]; // Oct … Sep, mm/month (invented)
const CF_A = [0.4, 0.55, 0.7, 0.7, 0.65, 0.6, 0.45, 0.3, 0.2, 0.2, 0.25, 0.35];
const CF_B = [0, 0, 0, 0, 0, 0, 0.3, 0.6, 0.8, 0.8, 0.5, 0.1]; // a winter crop: in the ground Apr–Sep

function randomRain(seed: number, days: number): (number | null)[] {
	const rng = new Rng(seed);
	return Array.from({ length: days }, () => {
		if (rng.bool(0.03)) return null;
		if (rng.bool(0.7)) return 0;
		return Math.round(rng.logFloat(0.5, 60) * 10) / 10;
	});
}

function run(i: ModelInput): ModelOutput {
	const out = withVerification(i, runModel(i));
	if (!out.summary.verification) throw new Error("no self-checks ran");
	const bad = out.summary.verification.checks.filter((c) => !c.passed) ?? [];
	if (bad.length) throw new Error(`self-check failed: ${JSON.stringify(bad).slice(0, 2000)}`);
	return out;
}

// ---------------------------------------------------------------------------

describe('irrigation demand end to end (§2.3)', () => {
	it('gross demand is area × A-pan × crop factor ÷ 1000 ÷ days in month, 28.25-day February even on 29 February', () => {
		// 2019-10-01 … 2020-09-30: a water year with a leap February. No rain, so F = gross and D = F ÷ e.
		const days = epoch('2020-09-30') - epoch('2019-10-01') + 1;
		const out = run(
			input({
				start: '2019-10-01',
				rain: new Array(days).fill(0),
				apanMm: APAN,
				crops: [{ id: 'a', name: 'Citrus (invented)', cropFactor: CF_A }],
				areas: [{ nodeId: 'A', cropId: 'a', areaM2: 50_000 }],
				units: [unit('A', { irrigationEfficiency: 0.8 })]
			})
		);
		const gross = get(out, 'A', 'gross_demand');
		const F = get(out, 'A', 'crop_requirement');
		const D = get(out, 'A', 'demand');
		const d0 = epoch('2019-10-01');
		// Hand values: October 50 000 m² × 150 mm × 0.4 ÷ 1000 ÷ 31 = 96.774… m³/day.
		expect(gross[0]).toBeCloseTo((50_000 * 150 * 0.4) / 1000 / 31, 9);
		// 29 February 2020: 50 000 × 200 × 0.65 ÷ 1000 ÷ 28.25 (not ÷ 29).
		const feb29 = epoch('2020-02-29') - d0;
		expect(iso(d0 + feb29)).toBe('2020-02-29');
		expect(gross[feb29]).toBeCloseTo((50_000 * 200 * 0.65) / 1000 / 28.25, 9);
		// 30 September: the last water-year month (index 11).
		expect(gross[days - 1]).toBeCloseTo((50_000 * 115 * 0.35) / 1000 / 30, 9);
		for (let t = 0; t < days; t++) {
			expect(F[t]).toBe(gross[t]);
			expect(D[t]).toBeCloseTo(F[t]! / 0.8, 9);
		}
		// Over a leap February, 29 days × the daily rate: 29 ÷ 28.25 of the month's volume (the documented 28.25 convention).
		const febStart = epoch('2020-02-01') - d0;
		const febVol = gross.slice(febStart, febStart + 29).reduce((a, b) => a + b, 0);
		expect(febVol).toBeCloseTo(((50_000 * 200 * 0.65) / 1000) * (29 / 28.25), 6);
		// Every other month sums to exactly its monthly volume.
		for (const [m0, len, wy] of [
			['2019-10-01', 31, 0],
			['2019-11-01', 30, 1],
			['2020-04-01', 30, 6],
			['2020-09-01', 30, 11]
		] as const) {
			const s = epoch(m0) - d0;
			const vol = gross.slice(s, s + len).reduce((a, b) => a + b, 0);
			expect(vol).toBeCloseTo((50_000 * APAN[wy]! * CF_A[wy]!) / 1000, 6);
		}
	});

	it('settings.februaryDays 28 and 29 change only February', () => {
		const days = epoch('2021-03-31') - epoch('2021-01-01') + 1;
		const base = { start: '2021-01-01', rain: new Array(days).fill(0), apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }] };
		const d0 = epoch('2021-01-01');
		for (const feb of [28, 29]) {
			const g = get(run(input({ ...base, settings: { februaryDays: feb } })), 'A', 'gross_demand');
			const ref = reference({ start: base.start, rain: base.rain, apanMm: APAN, crops: [{ cf: CF_A, area: 10_000 }], feb });
			expectSeriesClose(g, ref.gross, `februaryDays ${feb}`);
			const febDay = epoch('2021-02-10') - d0;
			expect(g[febDay]).toBeCloseTo((10_000 * 200 * 0.65) / 1000 / feb, 9);
			expect(g[epoch('2021-01-10') - d0]).toBeCloseTo((10_000 * 250 * 0.7) / 1000 / 31, 9);
		}
	});

	it('matches an independent re-derivation day by day over 2½ years of random rain (two crops, mid-water-year start and end)', () => {
		const start = '2019-07-15';
		const days = epoch('2022-03-10') - epoch(start) + 1;
		const rain = randomRain(7, days);
		const crops = [
			{ id: 'b', name: 'Winter veg (invented)', cropFactor: CF_B },
			{ id: 'a', name: 'Orchard (invented)', cropFactor: CF_A }
		];
		// Two rows for crop a: they add up (§2.3 "Σ crop areas").
		const areas: CropArea[] = [
			{ nodeId: 'A', cropId: 'a', areaM2: 30_000 },
			{ nodeId: 'A', cropId: 'b', areaM2: 12_500 },
			{ nodeId: 'A', cropId: 'a', areaM2: 7_500 }
		];
		const out = run(input({ start, rain, apanMm: APAN, crops, areas, units: [unit('A', { irrigationEfficiency: 0.85 })] }));
		const ref = reference({ start, rain, apanMm: APAN, crops: [{ cf: CF_A, area: 37_500 }, { cf: CF_B, area: 12_500 }] });
		expectSeriesClose(get(out, 'A', 'gross_demand'), ref.gross, 'gross');
		expectSeriesClose(get(out, 'A', 'effective_rain'), ref.effective, 'effective rain');
		expectSeriesClose(get(out, 'A', 'soil_water'), ref.soil, 'soil water');
		expectSeriesClose(get(out, 'A', 'crop_requirement'), ref.F, 'crop requirement');
		expectSeriesClose(
			get(out, 'A', 'demand'),
			ref.F.map((f) => f / 0.85),
			'demand'
		);
		// Fully supplied: supplied = demand, deficit 0.
		expectSeriesClose(get(out, 'A', 'supplied'), get(out, 'A', 'demand'), 'supplied');
		for (const v of get(out, 'A', 'deficit')) expect(Math.abs(v)).toBeLessThan(1e-9);
	});

	it('rain exactly at the threshold counts as 0; just above counts in full; a missing day is dry', () => {
		const start = '2021-10-01';
		// Day 0: 2 mm (= threshold, not counted). Day 1: 2.0001 mm. Day 2: missing. Day 3: 40 mm. No store.
		const rain = [2, 2.0001, null, 40, 0];
		const crops = [{ id: 'a', name: 'Crop', cropFactor: new Array(12).fill(1) }];
		const apan = new Array(12).fill(310); // October gross = 10 000 × 310 ÷ 1000 ÷ 31 = 100 m³/day
		const out = run(input({ start, rain, apanMm: apan, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }], settings: { effectiveRainStoreMm: 0, effectiveRainFraction: 0.5 } }));
		const F = get(out, 'A', 'crop_requirement');
		expect(F[0]).toBeCloseTo(100, 9);
		// 10 000 × 0.5 ÷ 1000 × 2.0001 = 10.0005 m³
		expect(F[1]).toBeCloseTo(100 - 10.0005, 9);
		expect(F[2]).toBeCloseTo(100, 9);
		// 40 mm → 200 m³ of effective rain covers the day; with no store nothing carries over.
		expect(F[3]).toBe(0);
		expect(F[4]).toBeCloseTo(100, 9);
		expect(get(out, 'A', 'effective_rain')).toEqual([0, expect.closeTo(10.0005, 9), 0, expect.closeTo(100, 9), 0]);
	});

	it('a custom rain threshold of 0 counts every drop; a large one ignores storms below it', () => {
		const start = '2021-10-01';
		const rain = [0.1, 5, 19.9, 20, 20.5];
		const crops = [{ id: 'a', name: 'Crop', cropFactor: new Array(12).fill(1) }];
		const apan = new Array(12).fill(310);
		for (const thr of [0, 20]) {
			const out = run(
				input({ start, rain, apanMm: apan, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }], settings: { effectiveRainStoreMm: 0, effectiveRainFraction: 0.5, calibration: { rainThresholdMm: thr } } })
			);
			const ref = reference({ start, rain, apanMm: apan, crops: [{ cf: new Array(12).fill(1), area: 10_000 }], threshold: thr, er: 0.5, storeMm: 0 });
			expectSeriesClose(get(out, 'A', 'crop_requirement'), ref.F, `threshold ${thr}`);
		}
	});

	it('the soil-water store carries a storm over the next days, capped at its size, and across a month boundary', () => {
		// 31 October: a 100 mm storm on 10 000 m² at 0.65 = 650 m³; the day needs 100, the store (25 mm = 250 m³) keeps 250.
		// 1–2 November (gross 10 000 × 300 ÷ 1000 ÷ 30 = 100): the store covers 1 Nov in full and 2 Nov with 150 left → 0, then 50 short… worked below.
		const start = '2021-10-31';
		const rain = [100, 0, 0, 0];
		const apan = new Array(12).fill(0);
		apan[0] = 310; // Oct
		apan[1] = 300; // Nov
		const crops = [{ id: 'a', name: 'Crop', cropFactor: new Array(12).fill(1) }];
		const out = run(input({ start, rain, apanMm: apan, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }] }));
		// Day 0: available 650, used 100, store min(250, 550) = 250 → 25 mm.
		// Day 1: available 250, used 100, store 150 → 15 mm. Day 2: used 100, store 50 → 5 mm. Day 3: used 50, F = 50, store 0.
		expect(get(out, 'A', 'crop_requirement').map((v) => +v.toFixed(9))).toEqual([0, 0, 0, 50]);
		expect(get(out, 'A', 'soil_water').map((v) => +v.toFixed(9))).toEqual([25, 15, 5, 0]);
		expect(get(out, 'A', 'effective_rain').map((v) => +v.toFixed(9))).toEqual([100, 100, 100, 50]);
	});

	it('the monthly effective-rain fraction takes the day’s own month, and the annual written 12 times is the same run', () => {
		const start = '2021-09-28';
		const days = 8; // 28 Sep … 5 Oct: across the water-year boundary
		const rain = [10, 0, 30, 12, 0, 50, 0, 3];
		const erM = [0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.2]; // Oct 0.9, Sep 0.2
		const crops = [{ id: 'a', name: 'Crop', cropFactor: CF_A }];
		const areas = [{ nodeId: 'A', cropId: 'a', areaM2: 20_000 }];
		const out = run(input({ start, rain, apanMm: APAN, crops, areas, settings: { effectiveRainFractionMonthly: erM } }));
		const ref = reference({ start, rain, apanMm: APAN, crops: [{ cf: CF_A, area: 20_000 }], erMonthly: erM });
		expect(ref.F.length).toBe(days);
		expectSeriesClose(get(out, 'A', 'crop_requirement'), ref.F, 'monthly fraction');
		expectSeriesClose(get(out, 'A', 'effective_rain'), ref.effective, 'monthly fraction, effective');
		const annual = run(input({ start, rain, apanMm: APAN, crops, areas, settings: { effectiveRainFraction: 0.4 } }));
		const twelve = run(input({ start, rain, apanMm: APAN, crops, areas, settings: { effectiveRainFraction: 0.4, effectiveRainFractionMonthly: new Array(12).fill(0.4) } }));
		expect(get(twelve, 'A', 'crop_requirement')).toEqual(get(annual, 'A', 'crop_requirement'));
	});

	it('the crop factor month switches exactly at 30 September → 1 October (water-year index 11 → 0)', () => {
		const start = '2021-09-29';
		const cf = new Array(12).fill(0);
		cf[11] = 1; // September only
		cf[0] = 2; // October only
		const apan = new Array(12).fill(0);
		apan[11] = 300;
		apan[0] = 310;
		const out = run(input({ start, rain: [0, 0, 0, 0], apanMm: apan, crops: [{ id: 'a', name: 'Crop', cropFactor: cf }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }] }));
		// Sep: 1000 × 300 × 1 ÷ 1000 ÷ 30 = 10; Oct: 1000 × 310 × 2 ÷ 1000 ÷ 31 = 20.
		expect(get(out, 'A', 'gross_demand').map((v) => +v.toFixed(9))).toEqual([10, 10, 20, 20]);
	});

	it('a unit with zero crop area, or an area for a crop the model doesn’t know, has no demand', () => {
		const out = run(
			input({
				start: '2021-10-01',
				rain: [0, 0, 0],
				apanMm: APAN,
				crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }],
				areas: [
					{ nodeId: 'A', cropId: 'a', areaM2: 0 },
					{ nodeId: 'B', cropId: 'ghost', areaM2: 5000 }
				],
				units: [unit('A'), unit('B')]
			})
		);
		for (const id of ['A', 'B']) {
			expect(get(out, id, 'demand')).toEqual([0, 0, 0]);
			expect(get(out, id, 'crop_requirement')).toEqual([0, 0, 0]);
		}
		expect(out.summary.warnings.some((w) => w.includes('unknown crop'))).toBe(true);
		const s = out.summary.farms.find((f) => f.nodeId === 'A')!;
		expect(s.avgDemandM3Day).toBe(0);
		expect(s.fractionSupplied).toBe(1);
	});

	it('a negative crop factor needs no water (MAX(0, gross)), and the store isn’t drained by it', () => {
		const cf = new Array(12).fill(-0.5);
		const out = run(input({ start: '2021-10-01', rain: [50, 0], apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: cf }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }] }));
		expect(get(out, 'A', 'crop_requirement')).toEqual([0, 0]);
		expect(get(out, 'A', 'demand')).toEqual([0, 0]);
		// 50 mm × 0.65 = 32.5 mm into a 25 mm store: 25 mm kept, and none used on either day.
		expect(get(out, 'A', 'soil_water').map((v) => +v.toFixed(9))).toEqual([25, 25]);
	});

	it('the order of crops and crop-area rows doesn’t change a bit of the demand', () => {
		const start = '2020-01-01';
		const rain = randomRain(11, 200);
		const crops = [
			{ id: 'a', name: 'A', cropFactor: CF_A },
			{ id: 'b', name: 'B', cropFactor: CF_B },
			{ id: 'c', name: 'C', cropFactor: CF_A.map((x) => x * 0.37) }
		];
		const areas = [
			{ nodeId: 'A', cropId: 'a', areaM2: 1234.5 },
			{ nodeId: 'A', cropId: 'b', areaM2: 0.1 },
			{ nodeId: 'A', cropId: 'c', areaM2: 98_765.4 }
		];
		const one = run(input({ start, rain, apanMm: APAN, crops, areas }));
		const two = run(input({ start, rain, apanMm: APAN, crops: [...crops].reverse(), areas: [...areas].reverse() }));
		expect(get(two, 'A', 'demand')).toEqual(get(one, 'A', 'demand'));
	});

	it('per-crop efficiency: D = F ÷ e*, e* the harmonic mean weighted by each crop’s annual gross at the monthly A-pan (§2.3 item 6)', () => {
		const start = '2021-10-01';
		const rain = new Array(40).fill(0);
		const crops: CropDef[] = [
			{ id: 'a', name: 'Drip crop', cropFactor: CF_A, irrigationEfficiency: 0.9 },
			{ id: 'b', name: 'Sprinkler crop', cropFactor: CF_B }
		];
		const areas = [
			{ nodeId: 'A', cropId: 'a', areaM2: 20_000 },
			{ nodeId: 'A', cropId: 'b', areaM2: 30_000 }
		];
		const out = run(input({ start, rain, apanMm: APAN, crops, areas, units: [unit('A', { irrigationEfficiency: 0.75 })] }));
		const wA = 20_000 * CF_A.reduce((s, f, m) => s + f * APAN[m]!, 0);
		const wB = 30_000 * CF_B.reduce((s, f, m) => s + f * APAN[m]!, 0);
		const eStar = (wA + wB) / (wA / 0.9 + wB / 0.75);
		expect(eStar).toBeGreaterThan(0.75);
		expect(eStar).toBeLessThan(0.9);
		const F = get(out, 'A', 'crop_requirement');
		const D = get(out, 'A', 'demand');
		for (let t = 0; t < F.length; t++) expect(D[t]).toBeCloseTo(F[t]! / eStar, 9);
	});

	it('a crop efficiency outside (0, 1] is ignored with a warning and the unit’s efficiency is used', () => {
		const crops: CropDef[] = [{ id: 'a', name: 'Odd crop', cropFactor: CF_A, irrigationEfficiency: 1.5 }];
		const out = run(input({ start: '2021-10-01', rain: [0, 0], apanMm: APAN, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }], units: [unit('A', { irrigationEfficiency: 0.5 })] }));
		const F = get(out, 'A', 'crop_requirement');
		expect(get(out, 'A', 'demand')[0]).toBeCloseTo(F[0]! / 0.5, 12);
		expect(out.summary.warnings.some((w) => w.includes('Odd crop') && w.includes('not in (0, 1]'))).toBe(true);
	});

	it('the summary means are the means of the daily series they summarise', () => {
		const start = '2019-12-01';
		const rain = randomRain(3, 500);
		const out = run(input({ start, rain, apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 40_000 }], units: [unit('A', { irrigationEfficiency: 0.7 })] }));
		const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
		const s = out.summary.farms.find((f) => f.nodeId === 'A')!;
		expect(s.avgDemandM3Day).toBeCloseTo(mean(get(out, 'A', 'demand')), 9);
		expect(s.avgSuppliedM3Day).toBeCloseTo(mean(get(out, 'A', 'supplied')), 9);
		expect(s.avgCropRequirementM3Day!).toBeCloseTo(mean(get(out, 'A', 'crop_requirement')), 9);
		expect(s.avgDeficitM3Day).toBeCloseTo(mean(get(out, 'A', 'deficit')), 9);
		expect(s.avgDemandM3Day).toBeCloseTo(s.avgCropRequirementM3Day! / 0.7, 9);
		expect(s.fractionSupplied).toBeCloseTo(1, 12);
	});

	it('a unit starved of water: deficit = demand − supplied, and the fraction supplied is Σ supplied ÷ Σ demand', () => {
		// No dam, no inflow (no rain): nothing is supplied, everything is deficit.
		const start = '2021-10-01';
		const out = run(input({ start, rain: new Array(30).fill(0), apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }], units: [unit('A', { damCapacityM3: 0, damInitialPct: 0 })] }));
		const D = get(out, 'A', 'demand');
		const G = get(out, 'A', 'supplied');
		const W = get(out, 'A', 'deficit');
		for (let t = 0; t < D.length; t++) expect(W[t]).toBeCloseTo(D[t]! - G[t]!, 9);
		const s = out.summary.farms.find((f) => f.nodeId === 'A')!;
		const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
		expect(s.fractionSupplied).toBeCloseTo(sum(G) / sum(D), 9);
	});
});

describe('daily A-pan evaporation end to end (§2.3a)', () => {
	it('a covered day uses Σ area × factor × A-pan[t] ÷ 1000; a blank, negative or out-of-record day the monthly mean; the summary counts them', () => {
		const start = '2021-10-01';
		const days = 10;
		// The record starts on day 2 and has a blank on day 4 and a negative on day 6; it ends after day 7.
		const daily: (number | null)[] = [5, null, 7, -1, 0, 6.5];
		const apanDaily = { startDate: '2021-10-03', values: daily };
		const aligned: (number | null)[] = [null, null, ...daily, null, null];
		const crops = [{ id: 'a', name: 'Crop', cropFactor: CF_A }];
		const out = run(input({ start, rain: new Array(days).fill(0), apanMm: APAN, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }], apanDaily }));
		const ref = reference({ start, rain: new Array(days).fill(0), apanMm: APAN, crops: [{ cf: CF_A, area: 10_000 }], apanDaily: aligned });
		expectSeriesClose(get(out, 'A', 'gross_demand'), ref.gross, 'gross with daily A-pan');
		// Day 2 by hand: 10 000 × 0.4 × 5 ÷ 1000 = 20 m³; day 6 (0 mm) has no demand at all.
		expect(get(out, 'A', 'gross_demand')[2]).toBeCloseTo(20, 12);
		expect(get(out, 'A', 'gross_demand')[6]).toBe(0);
		expect(out.summary.apanDaily).toEqual({ dailyDays: 4, fallbackDays: 6, invalidDays: 1, first: '2021-10-03', last: '2021-10-08' });
		expect(out.summary.warnings.some((w) => w.includes('daily A-pan evaporation covers 4 of 10 run days'))).toBe(true);
	});

	it('a daily record on 29 February is used as is (no 28.25 spreading)', () => {
		const start = '2024-02-28';
		const crops = [{ id: 'a', name: 'Crop', cropFactor: new Array(12).fill(1) }];
		const out = run(input({ start, rain: [0, 0, 0], apanMm: APAN, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }], apanDaily: { startDate: '2024-02-28', values: [4, 8, 2] } }));
		expect(get(out, 'A', 'gross_demand')).toEqual([4, 8, 2]);
	});

	it('the per-crop efficiency weights stay on the monthly A-pan even with a daily record (documented)', () => {
		const crops: CropDef[] = [
			{ id: 'a', name: 'Drip', cropFactor: CF_A, irrigationEfficiency: 0.9 },
			{ id: 'b', name: 'Flood', cropFactor: CF_B, irrigationEfficiency: 0.6 }
		];
		const areas = [
			{ nodeId: 'A', cropId: 'a', areaM2: 10_000 },
			{ nodeId: 'A', cropId: 'b', areaM2: 10_000 }
		];
		const out = run(input({ start: '2022-04-01', rain: [0, 0], apanMm: APAN, crops, areas, apanDaily: { startDate: '2022-04-01', values: [9, 9] } }));
		const wA = 10_000 * CF_A.reduce((s, f, m) => s + f * APAN[m]!, 0);
		const wB = 10_000 * CF_B.reduce((s, f, m) => s + f * APAN[m]!, 0);
		const eStar = (wA + wB) / (wA / 0.9 + wB / 0.6);
		const F = get(out, 'A', 'crop_requirement');
		expect(F[0]).toBeCloseTo((10_000 * (CF_A[6]! + CF_B[6]!) * 9) / 1000, 9);
		expect(get(out, 'A', 'demand')[0]).toBeCloseTo(F[0]! / eStar, 9);
	});
});

describe('demand factor and its start date (§2.3 item 4a)', () => {
	it('scales F after the soil-water store, month by month, from settings.demandFactorFrom on', () => {
		const start = '2021-10-29';
		const rain = [30, 0, 0, 0, 0, 0];
		const factor = new Array(12).fill(1);
		factor[0] = 0.5; // Oct
		factor[1] = 0.8; // Nov
		const crops = [{ id: 'a', name: 'Crop', cropFactor: CF_A }];
		const areas = [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }];
		const plain = run(input({ start, rain, apanMm: APAN, crops, areas }));
		const scaled = run(input({ start, rain, apanMm: APAN, crops, areas, units: [unit('A', { demandFactor: factor, irrigationEfficiency: 0.8 })], settings: { demandFactorFrom: '2021-10-31' } }));
		const F0 = get(plain, 'A', 'crop_requirement');
		const F1 = get(scaled, 'A', 'crop_requirement');
		// The store and the effective rain don't move.
		expect(get(scaled, 'A', 'soil_water')).toEqual(get(plain, 'A', 'soil_water'));
		expect(get(scaled, 'A', 'effective_rain')).toEqual(get(plain, 'A', 'effective_rain'));
		// 29–30 Oct before the start: × 1. 31 Oct: × 0.5. 1–3 Nov: × 0.8.
		const want = F0.map((f, t) => f * (t < 2 ? 1 : t === 2 ? 0.5 : 0.8));
		expectSeriesClose(F1, want, 'scaled F');
		expectSeriesClose(get(scaled, 'A', 'demand'), want.map((f) => f / 0.8), 'scaled D');
	});

	it('a unit takes nothing before its abstraction date', () => {
		const start = '2021-10-01';
		const out = run(input({ start, rain: new Array(6).fill(0), apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 3100 }], units: [unit('A', { abstractionFrom: '2021-10-04' })] }));
		const g = (3100 * 150 * 0.4) / 1000 / 31;
		expectSeriesClose(get(out, 'A', 'demand'), [0, 0, 0, g, g, g], 'demand before/after abstraction date');
	});
});

describe('the workbook form and what the run refuses (§2.3)', () => {
	it('with no soil-water store, F is bit for bit MAX(0, gross − area × (fraction ÷ 1000) × rain)', () => {
		const start = '2020-02-01';
		const rain = randomRain(19, 120);
		const crops = [{ id: 'a', name: 'Crop', cropFactor: CF_A }];
		const out = run(input({ start, rain, apanMm: APAN, crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 12_345 }], settings: { effectiveRainStoreMm: 0, effectiveRainFraction: 0.65 } }));
		const gross = get(out, 'A', 'gross_demand');
		const F = get(out, 'A', 'crop_requirement');
		for (let t = 0; t < rain.length; t++) {
			const r = rain[t] ?? 0;
			const pe = 12_345 * (0.65 / 1000) * (r > 2 ? r : 0);
			const wb = gross[t]! - pe <= 1e-12 * gross[t]! ? 0 : Math.max(0, gross[t]! - pe);
			expect(F[t]).toBe(wb);
		}
	});

	it('a monthly effective-rain row of zeros means rain never reduces demand, and says so', () => {
		const out = run(input({ start: '2021-10-01', rain: [40, 40], apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }], settings: { effectiveRainFractionMonthly: new Array(12).fill(0) } }));
		expect(get(out, 'A', 'crop_requirement')).toEqual(get(out, 'A', 'gross_demand'));
		expect(out.summary.warnings).toContain('the monthly effective rain fraction is 0 in every month, so rain never reduces irrigation demand');
	});

	it('a monthly effective-rain row that isn’t 12 numbers in 0–1 is ignored with a warning: the annual fraction runs', () => {
		const base = { start: '2021-10-01', rain: [10, 0, 30], apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }] };
		const bad = run(input({ ...base, settings: { effectiveRainFraction: 0.4, effectiveRainFractionMonthly: [1.5, ...new Array(11).fill(0.5)] } }));
		const plain = run(input({ ...base, settings: { effectiveRainFraction: 0.4 } }));
		expect(get(bad, 'A', 'crop_requirement')).toEqual(get(plain, 'A', 'crop_requirement'));
		expect(bad.summary.warnings.some((w) => w.startsWith('monthly effective rain fractions should be 12 numbers'))).toBe(true);
	});

	it('a demand factor row with missing or bad months runs those months at 1, with warnings', () => {
		const base = { start: '2021-10-01', rain: [0, 0], apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }] };
		const plain = run(input(base));
		// October (index 0) is −1: runs as 1. A short row: the missing months are 1.
		const bad = run(input({ ...base, units: [unit('A', { demandFactor: [-1, 0.5] })] }));
		expect(get(bad, 'A', 'crop_requirement')).toEqual(get(plain, 'A', 'crop_requirement'));
		expect(bad.summary.warnings.some((w) => w.includes('demand factor should have 12 monthly values'))).toBe(true);
		expect(bad.summary.warnings.some((w) => w.includes("demand factor that isn't a number ≥ 0 runs as 1"))).toBe(true);
	});

	it('the areal rainfall correction changes the rain GR4J runs on, never the rain irrigation demand reads (§2.4g)', () => {
		const base = { start: '2021-10-01', rain: [10, 20, 0, 35], apanMm: APAN, crops: [{ id: 'a', name: 'Crop', cropFactor: CF_A }], areas: [{ nodeId: 'A', cropId: 'a', areaM2: 1000 }] };
		const plain = run(input(base));
		const areal = run(input({ ...base, settings: { arealRain: { factors: new Array(12).fill(0.5), method: 'map', source: 'invented MAP ratio' } } }));
		expect(get(areal, 'A', 'crop_requirement')).toEqual(get(plain, 'A', 'crop_requirement'));
		expect(get(areal, 'A', 'effective_rain')).toEqual(get(plain, 'A', 'effective_rain'));
	});

	it('CHIRPS fills a blank catchment day for demand, and forecast rain fills where both are blank', () => {
		const start = '2021-10-01';
		const crops = [{ id: 'a', name: 'Crop', cropFactor: new Array(12).fill(1) }];
		const i = input({ start, rain: [null, null, 0], apanMm: new Array(12).fill(310), crops, areas: [{ nodeId: 'A', cropId: 'a', areaM2: 10_000 }], settings: { effectiveRainStoreMm: 0, effectiveRainFraction: 0.5, chirpsBiasCorrection: 'none' } });
		i.series.rain_chirps_mm = { startDate: start, values: [10, null, null] };
		i.series.rain_forecast_mm = { startDate: start, values: [99, 6, 99] };
		const out = run(i);
		// Day 0: CHIRPS 10 mm → 50 m³ off 100. Day 1: forecast 6 mm → 30 m³. Day 2: catchment 0 (recorded) wins over the forecast.
		expect(get(out, 'A', 'crop_requirement').map((v) => +v.toFixed(9))).toEqual([50, 70, 100]);
	});
});
