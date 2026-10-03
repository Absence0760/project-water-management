// End-to-end: rain to natural flow through GR4J (docs/model.md §2.4, §2.4a),
// run through the whole model (runModel) on small invented catchments and
// checked against an independent GR4J written here from model.md's equations
// (Perrin, Michel & Andréassian 2003), not against the engine's own numbers.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { prepareRun } from '../prepare';
import { runForecastChecked } from '../forecast';

// --- a tiny catchment --------------------------------------------------------

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep, mm/month
const NODE = {
	sortOrder: 0,
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
	damSeepagePerDay: 0
};

function catchment(series: ModelInput['series'], settings: Record<string, unknown> = {}, farms: number[] = [12.5]): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, ...settings } as unknown as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				...farms.map((a, i) => ({ ...NODE, id: `F${i}`, name: `Unit ${i}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2: a }))
			] as never,
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series
	};
}

const col = (out: ModelOutput, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;

/** Deterministic invented rain: dry spells, drizzle and storms. */
function rainRecord(n: number, seed = 1): number[] {
	let s = seed >>> 0;
	const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
	return Array.from({ length: n }, () => {
		const u = r();
		return u < 0.6 ? 0 : u < 0.8 ? Math.round(r() * 40) / 10 : u < 0.97 ? Math.round(r() * 300) / 10 : 60 + Math.round(r() * 900) / 10;
	});
}

// --- an independent GR4J, from model.md §2.4a ---------------------------------

interface P4 {
	x1: number;
	x2: number;
	x3: number;
	x4: number;
}

function ordinates(x4: number) {
	const sh1 = (t: number) => (t <= 0 ? 0 : t < x4 ? (t / x4) ** 2.5 : 1);
	const sh2 = (t: number) => (t <= 0 ? 0 : t <= x4 ? 0.5 * (t / x4) ** 2.5 : t < 2 * x4 ? 1 - 0.5 * (2 - t / x4) ** 2.5 : 1);
	const n1 = Math.ceil(x4);
	const n2 = Math.ceil(2 * x4);
	return {
		uh1: Array.from({ length: n1 }, (_, i) => sh1(i + 1) - sh1(i)),
		uh2: Array.from({ length: n2 }, (_, i) => sh2(i + 1) - sh2(i))
	};
}

/** Reference GR4J run: stores half full, `warm` days cycling the first `cycle` days of the forcing, then the output days. */
function refGr4j(p: P4, P: number[], E: number[], warm: number, cycle = P.length) {
	const { uh1, uh2 } = ordinates(p.x4);
	let S = 0.5 * p.x1;
	let R = 0.5 * p.x3;
	// queue[k] = water leaving k days from today
	let q1 = new Array<number>(uh1.length).fill(0);
	let q2 = new Array<number>(uh2.length).fill(0);
	const store = () => S + R + q1.reduce((a, b) => a + b, 0) + q2.reduce((a, b) => a + b, 0);
	const step = (rain: number, pet: number) => {
		let pn = 0;
		let en = 0;
		if (rain >= pet) pn = rain - pet;
		else en = pet - rain;
		let ps = 0;
		let es = 0;
		if (pn > 0) ps = (p.x1 * (1 - (S / p.x1) ** 2) * Math.tanh(pn / p.x1)) / (1 + (S / p.x1) * Math.tanh(pn / p.x1));
		if (en > 0) es = (S * (2 - S / p.x1) * Math.tanh(en / p.x1)) / (1 + (1 - S / p.x1) * Math.tanh(en / p.x1));
		S = S - es + ps;
		const perc = S * (1 - (1 + ((4 * S) / (9 * p.x1)) ** 4) ** -0.25);
		S -= perc;
		const pr = perc + (pn - ps);
		q1 = q1.map((v, k) => v + uh1[k]! * 0.9 * pr);
		q2 = q2.map((v, k) => v + uh2[k]! * 0.1 * pr);
		const Q9 = q1.shift()!;
		q1.push(0);
		const Q1 = q2.shift()!;
		q2.push(0);
		const F = p.x2 * (R / p.x3) ** 3.5;
		const r0 = R;
		R = Math.max(0, R + Q9 + F);
		const qr = R * (1 - (1 + (R / p.x3) ** 4) ** -0.25);
		R -= qr;
		const qd = Math.max(0, Q1 + F);
		const exchange = R + qr - r0 - Q9 + (qd - Q1);
		return { q: qr + qd, aet: Math.min(rain, pet) + es, exchange };
	};
	for (let k = 0; k < warm; k++) step(P[k % cycle]!, E[k % cycle]!);
	const start = store();
	const out = P.map((rain, t) => step(rain, E[t]!));
	return { q: out.map((o) => o.q), aet: out.map((o) => o.aet), exchange: out.map((o) => o.exchange), start, end: store() };
}

/** PET as model.md §2.4a states it: pan coefficient × A-pan of the month, spread evenly over its real calendar days. */
function refPet(startDate: string, n: number, k = 0.7, apan = APAN): number[] {
	const d0 = Date.parse(`${startDate}T00:00:00Z`);
	return Array.from({ length: n }, (_, t) => {
		const d = new Date(d0 + t * 86_400_000);
		const m = d.getUTCMonth() + 1;
		const wy = (m + 2) % 12; // Oct = 0 … Sep = 11
		const dim = new Date(Date.UTC(d.getUTCFullYear(), m, 0)).getUTCDate();
		return (k * apan[wy]!) / dim;
	});
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe('GR4J through runModel matches an independent implementation of model.md §2.4a', () => {
	it('natural flow = Q (mm) × area (km²) × 1000 every day, with X2 = 0, a warm-up and a leap February', () => {
		const n = 2 * 365 + 1; // 2023-10-01 … 2025-09-30, through 29 Feb 2024
		const rain = rainRecord(n, 7);
		const p = { x1: 220, x2: 0, x3: 70, x4: 2.3 };
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2023-10-01', values: rain } }, { gr4j: { ...p, warmupDays: 400 }, calibration: { rainThresholdMm: 2, catchmentAreaKm2: 37.5 } }));
		expect(out.days).toBe(n);
		const pet = refPet('2023-10-01', n);
		const ref = refGr4j(p, rain, pet, 400);
		const nat = col(out, 'natural_flow')!;
		let worst = 0;
		for (let t = 0; t < n; t++) worst = Math.max(worst, rel(nat[t]!, ref.q[t]! * 37.5 * 1000));
		expect(worst).toBeLessThan(1e-9);
		// The forcing series the model reports are the forcing it ran on.
		const pe = col(out, 'pet')!;
		for (let t = 0; t < n; t++) expect(pe[t]).toBeCloseTo(pet[t]!, 12);
		// 29 Feb 2024 is day 151 (Oct 31 + Nov 30 + Dec 31 + Jan 31 + 28): a 29-day February.
		expect(pe[151]).toBeCloseTo((0.7 * 180) / 29, 12);
		const aet = col(out, 'aet')!;
		for (let t = 0; t < n; t++) expect(Math.abs(aet[t]! - ref.aet[t]!)).toBeLessThan(1e-9);
	});

	it('with X2 ≠ 0 (export and import) the flow and the applied exchange match, and the whole-run balance closes', () => {
		const n = 500;
		const rain = rainRecord(n, 11);
		for (const x2 of [-2.5, 1.5]) {
			const p = { x1: 150, x2, x3: 40, x4: 1.2 };
			const out = runModel(catchment({ rain_catchment_mm: { startDate: '2021-10-01', values: rain } }, { gr4j: { ...p, warmupDays: 30 }, calibration: { rainThresholdMm: 2, catchmentAreaKm2: 10 } }));
			const ref = refGr4j(p, rain, refPet('2021-10-01', n), 30);
			const nat = col(out, 'natural_flow')!;
			for (let t = 0; t < n; t++) expect(Math.abs(nat[t]! / 10_000 - ref.q[t]!)).toBeLessThan(1e-9);
			const ex = col(out, 'exchange')!;
			expect(ex).toBeDefined();
			for (let t = 0; t < n; t++) expect(Math.abs(ex[t]! - ref.exchange[t]!)).toBeLessThan(1e-9);
			const b = out.summary.runoff!;
			expect(Math.abs(b.rainMm - b.aetMm - b.flowMm + b.exchangeMm - (b.storageEndMm - b.storageStartMm))).toBeLessThan(1e-7);
			expect(b.storageStartMm).toBeCloseTo(ref.start, 9);
			expect(b.storageEndMm).toBeCloseTo(ref.end, 9);
		}
	});

	it('X4 below 1 day and a whole number of days give the right unit hydrographs (⌈X4⌉ / ⌈2·X4⌉ ordinates)', () => {
		const n = 200;
		const rain = rainRecord(n, 3);
		for (const x4 of [0.5, 1, 2, 3.0001]) {
			const p = { x1: 300, x2: 0, x3: 90, x4 };
			const out = runModel(catchment({ rain_catchment_mm: { startDate: '2022-01-01', values: rain } }, { gr4j: { ...p, warmupDays: 0 } }));
			const ref = refGr4j(p, rain, refPet('2022-01-01', n), 0);
			const nat = col(out, 'natural_flow')!;
			// Area = the farm's 12.5 km² (no override).
			for (let t = 0; t < n; t++) expect(Math.abs(nat[t]! / 12_500 - ref.q[t]!)).toBeLessThan(1e-9);
		}
	});

	it('the catchment area is the sum of the units when no override is set, and the override wins', () => {
		const rain = rainRecord(120, 5);
		const series = { rain_catchment_mm: { startDate: '2022-10-01', values: rain } };
		const a = runModel(catchment(series, { gr4j: { warmupDays: 0 } }, [3, 4.5]));
		const b = runModel(catchment(series, { gr4j: { warmupDays: 0 } }, [7.5]));
		const c = runModel(catchment(series, { gr4j: { warmupDays: 0 }, calibration: { rainThresholdMm: 2, catchmentAreaKm2: 15 } }, [3, 4.5]));
		const na = col(a, 'natural_flow')!;
		const nb = col(b, 'natural_flow')!;
		const nc = col(c, 'natural_flow')!;
		for (let t = 0; t < 120; t++) {
			expect(na[t]).toBeCloseTo(nb[t]!, 9);
			expect(nc[t]).toBeCloseTo(2 * na[t]!, 9);
		}
		expect(a.summary.runoff!.areaKm2).toBe(7.5);
		expect(c.summary.runoff!.areaKm2).toBe(15);
	});

	it('a zero catchment area is refused', () => {
		expect(() => runModel(catchment({ rain_catchment_mm: { startDate: '2022-10-01', values: [1, 2, 3] } }, {}, [0]))).toThrow(/catchment area is 0/);
	});

	it('no evaporation in any month is refused (GR4J_NO_PET)', () => {
		expect(() => runModel(catchment({ rain_catchment_mm: { startDate: '2022-10-01', values: [1, 2, 3] } }, { apanMm: new Array(12).fill(0) as never }))).toThrow(/potential evaporation/);
	});
});

describe('GR4J water balance on a whole run', () => {
	it('rain − AET − flow + exchange = Δstorage, daily from the store series, and the runoff coefficient is flow ÷ rain volume', () => {
		const n = 3 * 365;
		const rain = rainRecord(n, 21);
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2019-10-01', values: rain } }, { gr4j: { x1: 180, x2: 0, x3: 50, x4: 1.9, warmupDays: 365 }, calibration: { rainThresholdMm: 2, catchmentAreaKm2: 20 } }));
		const P = col(out, 'rain_used')!;
		const aet = col(out, 'aet')!;
		const nat = col(out, 'natural_flow')!;
		const S = col(out, 'production_store')!;
		const R = col(out, 'routing_store')!;
		const U = col(out, 'uh_store')!;
		const b = out.summary.runoff!;
		let prev = b.storageStartMm;
		for (let t = 0; t < n; t++) {
			const now = S[t]! + R[t]! + U[t]!;
			const q = nat[t]! / 20_000;
			expect(Math.abs(P[t]! - aet[t]! - q - (now - prev))).toBeLessThan(1e-9);
			expect(S[t]).toBeGreaterThanOrEqual(0);
			expect(S[t]).toBeLessThanOrEqual(180 + 1e-9);
			expect(aet[t]).toBeLessThanOrEqual(col(out, 'pet')![t]! + 1e-12);
			prev = now;
		}
		const rainSum = rain.reduce((s, v) => s + v, 0);
		expect(b.rainMm).toBeCloseTo(rainSum, 6);
		const flowM3 = nat.reduce((s, v) => s + v, 0);
		expect(out.summary.catchment.runoffCoefficient).toBeCloseTo(flowM3 / (rainSum * 20 * 1000), 12);
	});

	it('a single storm on a long dry spell never returns more water than fell (X2 = 0, stores drained first)', () => {
		const n = 730;
		const rain = new Array(n).fill(0);
		rain[400] = 120;
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2020-10-01', values: rain } }, { gr4j: { x1: 100, x2: 0, x3: 30, x4: 1.5, warmupDays: 3650 }, calibration: { rainThresholdMm: 2, catchmentAreaKm2: 1 } }));
		const nat = col(out, 'natural_flow')!;
		// The storm's own flow: the flow after day 400 minus the recession that was already running.
		const before = nat[399]!;
		let extra = 0;
		for (let t = 400; t < n; t++) extra += Math.max(0, nat[t]! - before) / 1000;
		expect(extra).toBeLessThan(120);
		expect(extra).toBeGreaterThan(0);
	});
});

describe('GR4J forcing edge cases', () => {
	it('negative catchment readings run as 0 mm and still block CHIRPS; NaN/null fall back to CHIRPS', () => {
		const n = 10;
		const catchmentRain = [5, -3, null, Number.NaN, 0, 2, 2, 2, 2, 2];
		const chirps = [9, 9, 4, 6, 9, 9, 9, 9, 9, 9];
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: '2022-10-01', values: catchmentRain as never }, rain_chirps_mm: { startDate: '2022-10-01', values: chirps } },
				{ chirpsBiasCorrection: 'none', gr4j: { warmupDays: 0 } }
			)
		);
		const used = col(out, 'rain_used')!;
		expect(used.slice(0, n)).toEqual([5, 0, 4, 6, 0, 2, 2, 2, 2, 2]);
		const fin = col(out, 'rain_final')!;
		expect(fin[1]).toBe(-3); // shown as recorded (§2.4b)
	});

	it('a NaN gap at the start and end of the only rain record moves the default window in to the first and last reading', () => {
		const vals = [null, null, Number.NaN, 4, 0, 3, null, null] as never;
		const prep = prepareRun(catchment({ rain_catchment_mm: { startDate: '2022-12-30', values: vals } }));
		expect(prep.startDate).toBe('2023-01-02');
		expect(prep.days).toBe(3);
	});

	it('a NaN gap inside the record runs dry and the warning names its dates', () => {
		const vals = [3, 3, null, null, null, 3, 3] as never;
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2023-02-27', values: vals } }, { gr4j: { warmupDays: 0 } }));
		const used = col(out, 'rain_used')!;
		expect(used).toEqual([3, 3, 0, 0, 0, 3, 3]);
		const w = out.summary.warnings.join('\n');
		expect(w).toMatch(/2023-03-01/);
		expect(w).toMatch(/2023-03-03/);
	});

	it('a daily A-pan series covering only part of a month: covered days are k × A-pan, the rest the month mean share', () => {
		const n = 31; // March 2023
		const apanDaily = new Array<number | null>(n).fill(null);
		for (let t = 10; t < 20; t++) apanDaily[t] = 9;
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: '2023-03-01', values: new Array(n).fill(1) }, evap_apan_mm: { startDate: '2023-03-01', values: apanDaily as never } },
				{ panCoefficient: new Array(12).fill(0.8) as never, gr4j: { warmupDays: 0 } }
			)
		);
		const pet = col(out, 'pet')!;
		expect(pet[10]).toBeCloseTo(0.8 * 9, 12);
		expect(pet[0]).toBeCloseTo((0.8 * APAN[5]!) / 31, 12); // March = water-year index 5
	});

	it('a monthly PE row replaces Kp × A-pan for GR4J, spread over the real days of each month (leap February)', () => {
		const pe = [10, 20, 30, 40, 58, 60, 70, 80, 90, 100, 110, 120];
		const out = runModel(
			catchment({ rain_catchment_mm: { startDate: '2024-02-01', values: new Array(60).fill(1) } }, { pe: { kind: 'monthly', mm: pe, source: 'invented' }, gr4j: { warmupDays: 0 } })
		);
		const pet = col(out, 'pet')!;
		expect(pet[0]).toBeCloseTo(58 / 29, 12);
		const feb = pet.slice(0, 29).reduce((s, v) => s + v, 0);
		expect(feb).toBeCloseTo(58, 10);
		expect(pet[29]).toBeCloseTo(60 / 31, 12);
	});
});

describe('GR4J across a forecast tail (§2.4f, engine-audit K1)', () => {
	it('a warm-up longer than the history cycles the history only; the tail continues from it (independent GR4J)', () => {
		const hist = rainRecord(161, 9);
		const tail = [40, 25, 0, 12, 3];
		const p = { x1: 260, x2: 0, x3: 80, x4: 1.7 };
		const input = catchment(
			{ rain_catchment_mm: { startDate: '2020-10-01', values: hist }, rain_forecast_mm: { startDate: '2021-03-11', values: tail } },
			{ gr4j: { ...p, warmupDays: 400 }, calibration: { rainThresholdMm: 2, catchmentAreaKm2: 5 } }
		);
		const out = runForecastChecked(input);
		expect(out.forecastFrom).toBe('2021-03-11');
		const P = [...hist, ...tail];
		const ref = refGr4j(p, P, refPet('2020-10-01', P.length), 400, hist.length);
		const nat = col(out, 'natural_flow')!;
		expect(nat.length).toBe(P.length);
		for (let t = 0; t < P.length; t++) expect(Math.abs(nat[t]! / 5000 - ref.q[t]!)).toBeLessThan(1e-9);
	});

	it('the areal factor scales forecast rain too (it applies to whatever rain GR4J runs on)', () => {
		const input = catchment(
			{ rain_catchment_mm: { startDate: '2021-03-01', values: [5, 5, 5] }, rain_forecast_mm: { startDate: '2021-03-04', values: [10, 10] } },
			{ arealRain: { factors: new Array(12).fill(1.5), method: 'map', source: 'invented' }, gr4j: { warmupDays: 0 } }
		);
		const out = runModel(input);
		expect(col(out, 'rain_used')).toEqual([7.5, 7.5, 7.5, 15, 15]);
	});
});
