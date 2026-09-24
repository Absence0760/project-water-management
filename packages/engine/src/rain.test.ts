// CHIRPS fallback bias correction (audit B1). All fixtures are synthetic.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import type { DailySeries, ModelInput, NetworkNode, SeriesKind } from './project';
import {
	applyChirpsCorrection,
	CHIRPS_FACTOR_MAX,
	CHIRPS_FACTOR_MIN_DAYS,
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	suspectRainYears
} from './rain';
import { prepareRun, runModel } from './run';
import { checkInvariants } from './testing/invariants';

type Series = Partial<Record<SeriesKind, DailySeries>>;

const S = '2000-10-01';
const DAYS = toEpochDay('2006-10-01') - toEpochDay(S);
/** CHIRPS rain on every third day, mm, by calendar month (a winter-rainfall shape). */
const BASE = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
/** The catchment reads K[m] × CHIRPS: the factor the fit should find. */
const K = [0, 1.1, 0.9, 1.2, 1.5, 2.0, 2.5, 3.0, 2.8, 2.2, 1.6, 1.3, 1.0];
const d0 = toEpochDay(S);
const monthAt = (i: number) => monthOfEpochDay(d0 + i);
const dateAt = (i: number) => fromEpochDay(d0 + i);
const inWaterYear = (i: number, wy: number) => dateAt(i) >= `${wy}-10-01` && dateAt(i) <= `${wy + 1}-09-30`;

function chirps(): number[] {
	return Array.from({ length: DAYS }, (_, i) => (i % 3 === 0 ? BASE[monthAt(i)]! : 0));
}
function catchment(ch: number[], k = K): (number | null)[] {
	return ch.map((v, i) => v * k[monthAt(i)]!);
}
const series = (c: (number | null)[] | null, h: (number | null)[] | null, extra: Series = {}): Series => ({
	...(c ? { rain_catchment_mm: { startDate: S, values: c } } : {}),
	...(h ? { rain_chirps_mm: { startDate: S, values: h } } : {}),
	...extra
});

describe('chirpsBiasFactors', () => {
	it('recovers a known factor for every calendar month', () => {
		const h = chirps();
		const c = chirpsBiasFactors(series(catchment(h), h), 'monthly')!;
		expect(c.excludedWaterYears).toEqual([]);
		for (const m of c.months) {
			expect(m.source).toBe('month');
			expect(m.factor).toBeCloseTo(K[m.month]!, 12);
			expect(m.clamped).toBe(false);
			expect(m.days).toBeGreaterThanOrEqual(CHIRPS_FACTOR_MIN_DAYS);
		}
		const pooled = c.months.reduce((a, m) => a + m.catchmentMm, 0) / c.months.reduce((a, m) => a + m.chirpsMm, 0);
		expect(c.pooled.factor).toBeCloseTo(pooled, 12);
	});

	it('pools a month with too few shared days, or too little CHIRPS rain', () => {
		const h = chirps();
		const c0 = catchment(h);
		// July: catchment rain only in one year (31 days < 90). January: CHIRPS never rains.
		for (let i = 0; i < DAYS; i++) {
			if (monthAt(i) === 7 && !inWaterYear(i, 2002)) c0[i] = null;
			if (monthAt(i) === 1) h[i] = 0;
		}
		const c = chirpsBiasFactors(series(c0, h), 'monthly')!;
		const jul = c.months[6]!;
		const jan = c.months[0]!;
		expect(jul.days).toBe(31);
		expect([jul.source, jan.source]).toEqual(['pooled', 'pooled']);
		expect(jul.ownFactor).toBeNull();
		expect(jan.ownFactor).toBeNull();
		expect(jul.factor).toBeCloseTo(c.pooled.factor!, 12);
		expect(jan.factor).toBeCloseTo(c.pooled.factor!, 12);
		expect(c.months[5]!.factor).toBeCloseTo(K[6]!, 12); // June still has its own
	});

	it('has no factor, and corrects nothing, without enough overlap', () => {
		const h = chirps();
		const c0: (number | null)[] = catchment(h).map((v, i) => (i < 60 ? v : null));
		const c = chirpsBiasFactors(series(c0, h), 'monthly')!;
		expect(c.pooled.factor).toBeNull();
		expect(c.months.every((m) => m.factor === null && m.source === null)).toBe(true);
		const run = prepareRun({ settings: {}, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: series(c0, h) });
		expect(run.aligned('rain_chirps_mm')).toEqual(h);
		expect(run.chirpsCorrection!.correctedDays).toBe(0);
		expect(run.chirpsCorrection!.fallbackDays).toBe(DAYS - 60);
		expect(run.warnings.find((w) => w.startsWith('CHIRPS rain stands in'))).toMatch(/on 2131 days and is not bias-corrected/);
	});

	it('clamps an implausible factor', () => {
		const h = chirps();
		const c = chirpsBiasFactors(series(catchment(h, K.map(() => 10)), h), 'monthly')!;
		expect(c.months.every((m) => m.factor === CHIRPS_FACTOR_MAX && m.clamped && m.ownFactor! > 9.99)).toBe(true);
		expect(c.pooled.clamped).toBe(true);
	});

	it('leaves out water years the issue #2 checks flag', () => {
		const h = chirps();
		const c0 = catchment(h);
		// 2003/04: catchment rain recorded as 0 through the wet season (May–Sep),
		// which would drag those months' factors towards 0.
		for (let i = 0; i < DAYS; i++) if (inWaterYear(i, 2003) && monthAt(i) >= 5 && monthAt(i) <= 9) c0[i] = 0;
		const s = series(c0, h);
		expect(suspectRainYears(s)).toContain(2003);
		const c = chirpsBiasFactors(s, 'monthly')!;
		expect(c.excludedWaterYears).toEqual(suspectRainYears(s));
		for (const m of c.months) expect(m.factor).toBeCloseTo(K[m.month]!, 12);
		// A negative reading is not a reading either.
		c0[3] = -5;
		expect(chirpsBiasFactors(series(c0, h), 'monthly')!.months[9]!.factor).toBeCloseTo(K[10]!, 12);
	});

	it('is null without a CHIRPS series', () => {
		expect(chirpsBiasFactors(series(catchment(chirps()), null), 'monthly')).toBeNull();
		expect(chirpsCorrectionWarning(null)).toBeNull();
	});

	it('gives the same factors and correction at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const h = chirps();
		const c0 = catchment(h).map((v, i) => (inWaterYear(i, 2004) ? null : v));
		const input: ModelInput = { settings: {}, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: series(c0, h) };
		const both = () => {
			const r = prepareRun(input);
			return JSON.stringify([r.chirpsCorrection, r.aligned('rain_chirps_mm')]);
		};
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = both();
			env.TZ = 'Pacific/Pago_Pago';
			const west = both();
			env.TZ = 'UTC';
			expect(east).toBe(both());
			expect(west).toBe(both());
			expect(JSON.parse(east)[0].correctedDays).toBe(365); // water year 2004/05, on the month edges
		} finally {
			env.TZ = tz;
		}
	});
});

describe('applyChirpsCorrection', () => {
	it('scales CHIRPS only where catchment rain is blank, and counts those days', () => {
		const corr = chirpsBiasFactors(series(catchment(chirps()), chirps()), 'monthly')!;
		const month = Uint8Array.from([1, 1, 7, 7]);
		const out = applyChirpsCorrection(corr, [null, 3, null, 0], [2, 2, 5, null], month);
		expect(out[0]).toBeCloseTo(2 * K[1]!, 12);
		expect(out.slice(1)).toEqual([2, 5 * corr.months[6]!.factor!, null]);
		expect([corr.fallbackDays, corr.correctedDays, corr.months[0]!.fallbackDays, corr.months[6]!.fallbackDays]).toEqual([2, 2, 1, 1]);
		expect(corr.fallbackRawMm).toBe(7);
		expect(corr.fallbackCorrectedMm).toBeCloseTo(2 * K[1]! + 5 * K[7]!, 12);
	});

	it("does nothing in mode 'none', but still counts the fallback days", () => {
		const corr = chirpsBiasFactors(series(catchment(chirps()), chirps()), 'none')!;
		const out = applyChirpsCorrection(corr, [null, null], [2, 4], Uint8Array.from([6, 6]));
		expect(out).toEqual([2, 4]);
		expect([corr.fallbackDays, corr.correctedDays]).toEqual([2, 0]);
		expect(chirpsCorrectionWarning(corr)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Through a run
// ---------------------------------------------------------------------------

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;
const farm = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
	id,
	name: id,
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 20,
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
});

/** Catchment rain blank in water year 2004/05, so CHIRPS fills in there. */
function runInput(over: ModelInput['settings'] = {}, extra: Series = {}): ModelInput {
	const h = chirps();
	const c = catchment(h).map((v, i) => (inWaterYear(i, 2004) ? null : v));
	return {
		settings: { apanMm: flat(150), ewrPragmaticM3PerDay: flat(0), ...over },
		model: {
			nodes: [farm('A', { downstreamNodeId: 'G', damCapacityM3: 50_000 }), farm('G', { kind: 'gauge', areaKm2: 0 })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: [...flat(0.8)] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		},
		series: series(c, h, extra)
	};
}
const get = (out: ReturnType<typeof runModel>, nodeId: string | null, key: string) =>
	out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
const fallbackDays = Array.from({ length: DAYS }, (_, i) => i).filter((i) => inWaterYear(i, 2004));

describe('runModel with the CHIRPS correction', () => {
	it('GR4J rain used is catchment rain where present and corrected CHIRPS where not; the water balance still closes', () => {
		const input = runInput({ runoffModel: 'gr4j' });
		const out = runModel(input);
		expect(checkInvariants(input, out)).toBeNull();
		const rain = get(out, null, 'rain_used');
		const c = input.series.rain_catchment_mm!.values;
		const h = input.series.rain_chirps_mm!.values;
		for (let i = 0; i < DAYS; i++) {
			if (c[i] !== null) expect(rain[i]).toBe(c[i]); // catchment rain untouched
			else expect(rain[i]).toBeCloseTo(h[i]! * K[monthAt(i)]!, 12);
		}
		expect(out.summary.chirpsCorrection!.correctedDays).toBe(fallbackDays.length);
		expect(out.summary.runoff!.rainMm).toBeCloseTo(rain.reduce((a, b) => a + b, 0), 6);
		expect(out.summary.warnings.find((w) => w.startsWith('CHIRPS rain bias-corrected'))).toMatch(
			/on 365 days where catchment rain is blank .*Oct 1\.60, Nov 1\.30, Dec 1\.00, Jan 1\.10.*Sep 2\.20\..*Catchment and forecast rain are not changed/
		);
		// With the correction off, the fallback year gets raw CHIRPS and less flow.
		const raw = runModel(runInput({ runoffModel: 'gr4j', chirpsBiasCorrection: 'none' }));
		expect(checkInvariants(input, raw)).toBeNull();
		const sum = (o: typeof out) => fallbackDays.reduce((a, i) => a + get(o, null, 'natural_flow')[i]!, 0);
		expect(sum(out)).toBeGreaterThan(sum(raw));
		expect(raw.summary.chirpsCorrection!.correctedDays).toBe(0);
		expect(raw.summary.warnings.some((w) => w.startsWith('CHIRPS'))).toBe(false);
	});

	it('the legacy model and irrigation demand see the corrected rain too; days with catchment rain do not change', () => {
		const on = runModel(runInput());
		const off = runModel(runInput({ chirpsBiasCorrection: 'none' }));
		expect(checkInvariants(runInput(), on)).toBeNull();
		const dOn = get(on, 'A', 'demand');
		const dOff = get(off, 'A', 'demand');
		const fallback = new Set(fallbackDays);
		for (let i = 0; i < DAYS; i++) if (!fallback.has(i)) expect(dOn[i]).toBe(dOff[i]);
		// More (corrected) rain offsets more demand on the fallback days.
		const tot = (d: number[]) => fallbackDays.reduce((a, i) => a + d[i]!, 0);
		expect(tot(dOn)).toBeLessThan(tot(dOff));
		const nf = (o: typeof on) => get(o, null, 'natural_flow').reduce((a, b) => a + b, 0);
		expect(nf(on)).toBeGreaterThan(nf(off));
	});

	it('leaves forecast rain alone', () => {
		// CHIRPS ends where the forecast begins; catchment is blank there too.
		const input = runInput({ runoffModel: 'gr4j', simulationEnd: '2006-10-10' }, { rain_forecast_mm: { startDate: '2006-10-01', values: new Array(10).fill(7) } });
		const out = runModel(input);
		expect(get(out, null, 'rain_used').slice(DAYS)).toEqual(new Array(10).fill(7));
	});

	it('is a no-op without CHIRPS', () => {
		const input = runInput({ runoffModel: 'gr4j' });
		delete input.series.rain_chirps_mm;
		const out = runModel(input);
		expect(out.summary.chirpsCorrection).toBeNull();
		expect(out.summary.warnings.some((w) => w.startsWith('CHIRPS'))).toBe(false);
		expect(get(out, null, 'rain_used').slice(0, fallbackDays[0])).toEqual(input.series.rain_catchment_mm!.values.slice(0, fallbackDays[0]));
	});

	it('outputs CHIRPS as uploaded and, beside it, CHIRPS × the monthly factor on every day', () => {
		const input = runInput();
		const h = input.series.rain_chirps_mm!.values;
		h[5] = null; // a missing CHIRPS day is a gap in both columns
		const out = runModel(input);
		const keys = out.series.filter((x) => x.nodeId === null).map((x) => x.key);
		expect(keys.indexOf('rain_chirps_corrected')).toBe(keys.indexOf('rain_chirps') + 1);
		const raw = get(out, null, 'rain_chirps');
		const corrected = get(out, null, 'rain_chirps_corrected');
		const factors = out.summary.chirpsCorrection!.months.map((m) => m.factor!);
		for (let i = 0; i < DAYS; i++) {
			if (h[i] === null) {
				expect(raw[i]).toBeNaN();
				expect(corrected[i]).toBeNaN();
				continue;
			}
			expect(raw[i]).toBe(h[i]);
			// Every day, not only where CHIRPS filled in for blank catchment rain.
			expect(corrected[i]).toBeCloseTo(h[i]! * factors[monthAt(i) - 1]!, 12);
		}
		// Rain used only takes the corrected value on the fallback days.
		const rain = get(out, null, 'rain_used');
		for (const i of fallbackDays) if (h[i]! > 2) expect(rain[i]).toBeCloseTo(corrected[i]!, 12);
		// Final rainfall: catchment where present, corrected CHIRPS where not, gaps where neither; no threshold.
		const final = get(out, null, 'rain_final');
		expect(keys.indexOf('rain_final')).toBe(keys.indexOf('rain_chirps') - 1);
		const c = input.series.rain_catchment_mm!.values;
		for (let i = 0; i < DAYS; i++) {
			if (c[i] !== null) expect(final[i]).toBe(c[i]);
			else if (h[i] === null) expect(final[i]).toBeNaN();
			else expect(final[i]).toBeCloseTo(corrected[i]!, 12);
		}
		expect(final.some((v, i) => v > 0 && v <= 2 && rain[i] === 0)).toBe(true);
		expect(corrected.some((v, i) => h[i] !== null && h[i]! > 0 && v !== raw[i])).toBe(true);
	});

	it("outputs only the uploaded CHIRPS column in mode 'none', and neither without CHIRPS", () => {
		const off = runModel(runInput({ chirpsBiasCorrection: 'none' }));
		expect(off.series.some((x) => x.key === 'rain_chirps')).toBe(true);
		expect(off.series.some((x) => x.key === 'rain_chirps_corrected')).toBe(false);
		const input = runInput();
		delete input.series.rain_chirps_mm;
		expect(runModel(input).series.some((x) => x.key.startsWith('rain_chirps'))).toBe(false);
	});

	it('falls back to the default for an unknown setting, with a warning', () => {
		const out = runModel(runInput({ chirpsBiasCorrection: 'yearly' as never }));
		expect(out.summary.warnings).toContain('unknown CHIRPS bias correction "yearly"; using monthly');
		expect(out.summary.chirpsCorrection!.mode).toBe('monthly');
	});
});
