// CHIRPS fallback bias correction (audit B1). All fixtures are synthetic.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { defaultDataQualitySettings, type DailySeries, type ModelInput, type NetworkNode, type SeriesKind, type ZeroRainSettings } from './project';
import {
	applyChirpsCorrection,
	CHIRPS_FACTOR_MAX,
	CHIRPS_FACTOR_MIN_DAYS,
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	fitExclusionText,
	KEEP_DRY_DOUBT_ANNUAL_SHARE,
	KEEP_DRY_DOUBT_MIN_MM,
	keepDryDoubtWarnings,
	resolveZeroRain,
	ZERO_RAIN_COLUMN,
	zeroRainMask
} from './rain';
import { rainVsChirps, usualAnnualRainMm, zeroRainRuns } from './quality';
import { runModel } from './run';
import { checkInvariants } from './testing/invariants';
import { prepareRun } from './prepare';

/** The accumulation fields (engine ≥ 0.20.0) at their defaults. */
const ACC: Pick<ZeroRainSettings, 'accumulationMode' | 'keepReadings' | 'addAccumulations'> = { accumulationMode: 'spread', keepReadings: [], addAccumulations: [] };

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

/**
 * The day indices of a zero run zeroed from `from` to `to` (inclusive), grown
 * over the fixture's own dry days on either side, as the flagged run will be.
 */
function zeroRun(from: string, to: string): number[] {
	const c = catchment(chirps());
	const core = Array.from({ length: DAYS }, (_, i) => i).filter((i) => dateAt(i) >= from && dateAt(i) <= to);
	let a = core[0]!;
	let b = core[core.length - 1]!;
	while (c[a - 1] === 0) a--;
	while (c[b + 1] === 0) b++;
	return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}
/** Catchment K × CHIRPS with `run` zeroed; `dryChirps` zeroes CHIRPS there too (a real dry spell). */
function seriesWithRun(run: number[], dryChirps = false): Series {
	const h = chirps();
	const c = catchment(h);
	for (const i of run) {
		c[i] = 0;
		if (dryChirps) h[i] = 0;
	}
	return series(c, h);
}
const keep = (run: number[]) => ({ start: dateAt(run[0]!), end: dateAt(run[run.length - 1]!), reason: 'confirmed dry' });

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

	it('leaves out a low-vs-CHIRPS water year whole', () => {
		const h = chirps();
		const c0 = catchment(h);
		// 2003/04: catchment rain recorded as 0 through the wet season (May–Sep),
		// which would drag those months' factors towards 0.
		for (let i = 0; i < DAYS; i++) if (inWaterYear(i, 2003) && monthAt(i) >= 5 && monthAt(i) <= 9) c0[i] = 0;
		const s = series(c0, h);
		expect(rainVsChirps(s)!.flaggedYears).toEqual([2003]);
		const c = chirpsBiasFactors(s, 'monthly')!;
		expect(c.excludedWaterYears).toEqual([2003]);
		expect(c.lowVsChirpsYears).toEqual([2003]);
		expect(c.flaggedDaysLeftOut).toBe(0); // the run's days are inside the excluded year
		for (const m of c.months) expect(m.factor).toBeCloseTo(K[m.month]!, 12);
		// A negative reading is not a reading either.
		c0[3] = -5;
		expect(chirpsBiasFactors(series(c0, h), 'monthly')!.months[9]!.factor).toBeCloseTo(K[10]!, 12);
	});

	it('leaves a flagged zero run out day by day, keeping the rest of its water year (engine ≥ 0.18.0)', () => {
		const run = zeroRun('2003-04-01', '2003-06-05');
		const s = seriesWithRun(run);
		expect(zeroRainRuns(s.rain_catchment_mm!).runs).toHaveLength(1);
		expect(rainVsChirps(s)!.flaggedYears).toEqual([]); // the year alone would not be left out
		const c = chirpsBiasFactors(s, 'monthly')!;
		expect(c.excludedWaterYears).toEqual([]);
		expect(c.flaggedDaysLeftOut).toBe(run.length);
		expect([c.missingDaysLeftOut, c.keptDryDaysInFit, c.doubtfulKeepDry]).toEqual([0, 0, []]);
		expect(c.pooled.days).toBe(DAYS - run.length);
		for (const m of c.months) expect(m.factor).toBeCloseTo(K[m.month]!, 12);
		// 'asRecorded' runs the zeros dry, but that is no evidence they are real: still left out.
		const asRec = chirpsBiasFactors(s, 'monthly', { ...ACC, mode: 'asRecorded', keepDry: [keep(run)], missing: [] })!;
		expect([asRec.flaggedDaysLeftOut, asRec.keptDryDaysInFit]).toEqual([run.length, 0]);
		expect(fitExclusionText(c)).toBe(` Left out of the fit as suspect catchment rain: ${run.length} days of flagged zero runs treated as missing.`);
	});

	it('keeps kept-dry days in the fit as confirmed readings, and a listed missing day wins over keep-dry', () => {
		// A real dry spell: CHIRPS is dry over it too.
		const run = zeroRun('2003-04-01', '2003-06-05');
		const s = seriesWithRun(run, true);
		const zr = { ...ACC, mode: 'missing' as const, keepDry: [keep(run)], missing: [] };
		const c = chirpsBiasFactors(s, 'monthly', zr)!;
		expect([c.flaggedDaysLeftOut, c.keptDryDaysInFit, c.excludedWaterYears, c.doubtfulKeepDry]).toEqual([0, run.length, [], []]);
		expect(c.pooled.days).toBe(DAYS);
		for (const m of c.months) expect(m.factor).toBeCloseTo(K[m.month]!, 12); // 0 mm on both sides
		// Positive control: the same run, not kept dry, is left out.
		expect(chirpsBiasFactors(s, 'monthly')!.flaggedDaysLeftOut).toBe(run.length);
		// Ten of its days also listed as missing: those are left out, the rest stay in.
		const listed = { start: dateAt(run[0]!), end: dateAt(run[9]!), reason: 'logger fault' };
		const m = chirpsBiasFactors(s, 'monthly', { ...zr, missing: [listed] })!;
		expect([m.missingDaysLeftOut, m.keptDryDaysInFit]).toEqual([10, run.length - 10]);
		expect(fitExclusionText(m)).toBe(
			` Left out of the fit as suspect catchment rain: 10 days listed as missing. ${run.length - 10} kept-dry days stay in the fit as confirmed readings.`
		);
	});

	it('kept-dry days with some CHIRPS rain pull the factor down: why they belong in the fit only when confirmed', () => {
		const run = zeroRun('2003-04-01', '2003-06-05');
		const s = seriesWithRun(run);
		const kept = chirpsBiasFactors(s, 'monthly', { ...ACC, mode: 'missing', keepDry: [keep(run)], missing: [] })!;
		expect(kept.doubtfulKeepDry).toEqual([]); // under the limit, so trusted
		expect(kept.keptDryDaysInFit).toBe(run.length);
		expect(kept.months[4]!.factor!).toBeLessThan(K[5]!); // May
	});

	it('doubts a keep-dry that bias-corrected CHIRPS contradicts, and leaves its water year out whole', () => {
		const run = zeroRun('2003-05-01', '2003-07-15');
		const s = seriesWithRun(run);
		expect(rainVsChirps(s)!.flaggedYears).toEqual([]);
		const c = chirpsBiasFactors(s, 'monthly', { ...ACC, mode: 'missing', keepDry: [keep(run)], missing: [] })!;
		expect(c.doubtfulKeepDry).toHaveLength(1);
		const d = c.doubtfulKeepDry![0]!;
		const usual = usualAnnualRainMm(s.rain_catchment_mm!)!;
		expect(d.limitMm).toBeCloseTo(Math.max(KEEP_DRY_DOUBT_MIN_MM, KEEP_DRY_DOUBT_ANNUAL_SHARE * usual), 9);
		// The guard's factors trust no flagged day, so they are the true K: corrected CHIRPS = what the catchment lost.
		const lost = run.reduce((a, i) => a + chirps()[i]! * K[monthAt(i)]!, 0);
		expect(d.chirpsMm).toBeCloseTo(lost, 9);
		expect(d.chirpsMm).toBeGreaterThan(d.limitMm);
		expect([d.start, d.end, d.days, d.waterYears]).toEqual([dateAt(run[0]!), dateAt(run[run.length - 1]!), run.length, [2002]]);
		expect([c.excludedWaterYears, c.lowVsChirpsYears, c.keptDryDaysInFit]).toEqual([[2002], [], 0]);
		for (const m of c.months) expect(m.factor).toBeCloseTo(K[m.month]!, 12);
		expect(keepDryDoubtWarnings(c)).toEqual([
			`Kept-dry zero run ${d.start} to ${d.end} looks doubtful: bias-corrected CHIRPS reads ${Math.round(d.chirpsMm)} mm over its ${run.length} kept-dry days, ` +
				`above the ${Math.round(d.limitMm)} mm limit (the larger of 50 mm and 25 % of the catchment's usual annual rain). ` +
				'Those days still run dry, but water year 2002/03 stay out of the CHIRPS factor fit. Check the keep-dry in Settings → Zero-rain runs.'
		]);
		expect(fitExclusionText(c)).toBe(' Left out of the fit as suspect catchment rain: water years of kept-dry runs that CHIRPS contradicts (2002/03).');
		// In mode 'none' (CHIRPS already corrected to the catchment) the guard reads it as stored:
		// here that is under the limit, so the keep-dry is trusted and its days stay in.
		const rawMm = run.reduce((a, i) => a + chirps()[i]!, 0);
		expect(rawMm).toBeLessThan(d.limitMm);
		const raw = chirpsBiasFactors(s, 'none', { ...ACC, mode: 'missing', keepDry: [keep(run)], missing: [] })!;
		expect([raw.doubtfulKeepDry, raw.keptDryDaysInFit]).toEqual([[], run.length]);
		// And the run warns through prepareRun.
		const prepared = prepareRun({
			settings: { zeroRainRuns: { ...ACC, mode: 'missing', keepDry: [keep(run)], missing: [] } },
			model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
			series: s
		});
		expect(prepared.warnings).toContain(keepDryDoubtWarnings(c)[0]);
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
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
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
		// No soil-water store (N3), so a fallback day's rain can't carry into the days after it.
		const on = runModel(runInput({ effectiveRainStoreMm: 0 }));
		const off = runModel(runInput({ chirpsBiasCorrection: 'none', effectiveRainStoreMm: 0 }));
		expect(checkInvariants(runInput({ effectiveRainStoreMm: 0 }), on)).toBeNull();
		expect(checkInvariants(runInput(), runModel(runInput()))).toBeNull();
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
		for (const i of fallbackDays) if (h[i] !== null) expect(rain[i]).toBeCloseTo(corrected[i]!, 12);
		// Final rainfall: catchment where present, corrected CHIRPS where not, gaps where neither; no threshold.
		const final = get(out, null, 'rain_final');
		expect(keys.indexOf('rain_final')).toBe(keys.indexOf('rain_chirps') - 1);
		const c = input.series.rain_catchment_mm!.values;
		for (let i = 0; i < DAYS; i++) {
			if (c[i] !== null) expect(final[i]).toBe(c[i]);
			else if (h[i] === null) expect(final[i]).toBeNaN();
			else expect(final[i]).toBeCloseTo(corrected[i]!, 12);
		}
		// GR4J uses the rain as it is (no threshold, missing days 0): rain used is final rainfall.
		for (let i = 0; i < DAYS; i++) expect(rain[i]).toBe(Number.isNaN(final[i]!) ? 0 : final[i]);
		expect(corrected.some((v, i) => h[i] !== null && h[i]! > 0 && v !== raw[i])).toBe(true);
		// The day's monthly factor sits in the next column: 12 values, one per calendar month.
		expect(keys.indexOf('chirps_factor')).toBe(keys.indexOf('rain_chirps_corrected') + 1);
		const factor = get(out, null, 'chirps_factor');
		for (let i = 0; i < DAYS; i++) expect(factor[i]).toBe(factors[monthAt(i) - 1]);
		expect(new Set(factor).size).toBe(12);
	});

	it("outputs only the uploaded CHIRPS column in mode 'none', and neither without CHIRPS", () => {
		const off = runModel(runInput({ chirpsBiasCorrection: 'none' }));
		expect(off.series.some((x) => x.key === 'rain_chirps')).toBe(true);
		expect(off.series.some((x) => x.key === 'rain_chirps_corrected' || x.key === 'chirps_factor')).toBe(false);
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

// ---------------------------------------------------------------------------
// Zero-rain runs treated as missing (CR-20, audit B2)
// ---------------------------------------------------------------------------

/**
 * A zero run in the wet season (the fixture rains most in May–Aug): 120 days
 * zeroed, which joins the fixture's own dry days on either side (CHIRPS rains
 * every third day), so the flagged run is a little longer.
 */
const runDays = (() => {
	const c = catchment(chirps());
	const core = Array.from({ length: DAYS }, (_, i) => i).filter((i) => dateAt(i) >= '2003-05-01' && dateAt(i) <= '2003-08-28');
	let a = core[0]!;
	let b = core[core.length - 1]!;
	while (c[a - 1] === 0) a--;
	while (c[b + 1] === 0) b++;
	return Array.from({ length: b - a + 1 }, (_, k) => a + k);
})();
const RUN_FROM = dateAt(runDays[0]!);
const RUN_TO = dateAt(runDays[runDays.length - 1]!);
const RUN_N = runDays.length;

/** Catchment rain K × CHIRPS everywhere except a zero run; no blank days. */
function zeroRunInput(over: ModelInput['settings'] = {}, edit?: (c: (number | null)[]) => void): ModelInput {
	const input = runInput(over);
	const h = chirps();
	const c = catchment(h);
	for (const i of runDays) c[i] = 0;
	edit?.(c);
	input.series = series(c, h);
	return input;
}

describe('zero-rain runs treated as missing (CR-20, B2)', () => {
	it('fills a flagged wet-season zero run with corrected CHIRPS and leaves every other day as recorded', () => {
		const input = zeroRunInput({ runoffModel: 'gr4j' });
		const out = runModel(input);
		expect(checkInvariants(input, out)).toBeNull();
		const rain = get(out, null, 'rain_used');
		const c = input.series.rain_catchment_mm!.values;
		const h = input.series.rain_chirps_mm!.values;
		const inRun = new Set(runDays);
		for (let i = 0; i < DAYS; i++) {
			if (inRun.has(i)) expect(rain[i]).toBeCloseTo(h[i]! * K[monthAt(i)]!, 12);
			else expect(rain[i]).toBe(c[i]); // the fixture's own 2-day dry gaps stay 0: not flagged
		}
		const z = out.summary.zeroRainInfill!;
		expect(z.mode).toBe('missing');
		expect(z.periods).toEqual([
			{ start: RUN_FROM, end: RUN_TO, source: 'flagged', reason: null, days: RUN_N, recordedMm: 0, filledMm: expect.any(Number), unfilledDays: 0 }
		]);
		const filled = runDays.reduce((a, i) => a + rain[i]!, 0);
		expect(filled).toBeGreaterThan(100);
		expect(z.filledMm).toBeCloseTo(filled, 9);
		expect(z.days).toBe(RUN_N);
		// The per-day flag marks exactly the run.
		const col = get(out, null, ZERO_RAIN_COLUMN.key);
		expect(col.filter((v, i) => (v === 1) !== inRun.has(i))).toEqual([]);
		// The run's water year stays out of the fit, so the factors are still the true ones.
		expect(out.summary.chirpsCorrection!.excludedWaterYears).toEqual([2002]);
		for (const m of out.summary.chirpsCorrection!.months) expect(m.factor).toBeCloseTo(K[m.month]!, 12);
		expect(out.summary.warnings.find((w) => w.startsWith('Catchment rain treated as missing'))).toMatch(
			new RegExp(`^Catchment rain treated as missing on ${RUN_N} days: ${RUN_FROM} to ${RUN_TO} \\(${RUN_N} days, flagged zero run\\)\\. CHIRPS \\(bias-corrected\\) then forecast rain stand in, ${Math.round(filled)} mm in all\\. The stored series is unchanged\\.`)
		);
	});

	it('"asRecorded" runs the zero run dry (positive control: the same run makes less flow)', () => {
		const filled = runModel(zeroRunInput({ runoffModel: 'gr4j' }));
		const input = zeroRunInput({ runoffModel: 'gr4j', zeroRainRuns: { ...ACC, mode: 'asRecorded', keepDry: [], missing: [] } });
		const dry = runModel(input);
		expect(checkInvariants(input, dry)).toBeNull();
		const rain = get(dry, null, 'rain_used');
		expect(runDays.every((i) => rain[i] === 0)).toBe(true);
		expect(dry.series.some((s) => s.key === ZERO_RAIN_COLUMN.key)).toBe(false);
		expect(dry.summary.zeroRainInfill).toMatchObject({ mode: 'asRecorded', periods: [], days: 0, asRecordedDays: RUN_N });
		expect(dry.summary.warnings).toContain(
			`Flagged zero runs run as recorded (dry) on ${RUN_N} days: Settings → Zero-rain runs is "as recorded", so CHIRPS doesn't fill them.`
		);
		const flow = (o: typeof dry) => o.series.find((s) => s.key === 'natural_flow')!.values.reduce((a, b) => a + b, 0);
		expect(flow(filled)).toBeGreaterThan(flow(dry));
		// Every day outside the run's reach is identical: GR4J stores carry the difference on, so compare the rain only.
		const rainOn = get(filled, null, 'rain_used');
		expect(rain.filter((v, i) => !runDays.includes(i) && v !== rainOn[i])).toEqual([]);
	});

	it('a keep-dry period keeps the flagged days inside it as recorded, and says so', () => {
		const keepDry = [{ start: '2003-04-01', end: '2003-06-30', reason: 'hydrologist: real drought' }];
		const out = runModel(zeroRunInput({ zeroRainRuns: { ...ACC, mode: 'missing', keepDry, missing: [] } }));
		const rain = get(out, null, 'rain_used');
		const kept = runDays.filter((i) => dateAt(i) <= '2003-06-30');
		expect(kept.every((i) => rain[i] === 0)).toBe(true);
		const h = chirps();
		for (const i of runDays.filter((i) => dateAt(i) > '2003-06-30')) expect(rain[i]).toBeCloseTo(h[i]! * K[monthAt(i)]!, 12);
		const z = out.summary.zeroRainInfill!;
		expect(z.keptDry).toEqual([{ ...keepDry[0], days: kept.length }]);
		expect(z.days).toBe(RUN_N - kept.length);
		expect(out.summary.warnings.find((w) => w.startsWith('Flagged zero runs kept as recorded'))).toBe(
			`Flagged zero runs kept as recorded (dry) on ${kept.length} days, as Settings → Zero-rain runs says: 2003-04-01 to 2003-06-30 (${kept.length} days: hydrologist: real drought).`
		);
	});

	it('a listed missing period replaces recorded rain, in either mode, and leaves the fit', () => {
		// Corrupt August 2001 (10× too wet): the fit's August factor is dragged up …
		const bad = (c: (number | null)[]) => {
			for (let i = 0; i < DAYS; i++) if (dateAt(i).startsWith('2001-08')) c[i] = c[i]! * 10;
		};
		const skewed = runModel(zeroRunInput({}, bad));
		expect(skewed.summary.chirpsCorrection!.months[7]!.factor).toBeGreaterThan(K[8]! * 1.3); // clamped at 4
		// … until the period is listed as missing: then corrected CHIRPS stands in and the factor is true again.
		const missing = [{ start: '2001-08-01', end: '2001-08-31', reason: 'logger fault' }];
		for (const mode of ['missing', 'asRecorded'] as const) {
			const out = runModel(zeroRunInput({ zeroRainRuns: { ...ACC, mode, keepDry: [], missing } }, bad));
			expect(out.summary.chirpsCorrection!.months[7]!.factor).toBeCloseTo(K[8]!, 12);
			const rain = get(out, null, 'rain_used');
			const h = chirps();
			for (let i = 0; i < DAYS; i++) if (dateAt(i).startsWith('2001-08')) expect(rain[i]).toBeCloseTo(h[i]! * K[8]!, 12);
			const listed = out.summary.zeroRainInfill!.periods.find((p) => p.source === 'listed')!;
			expect(listed).toMatchObject({ start: '2001-08-01', end: '2001-08-31', reason: 'logger fault', days: 31 });
			expect(listed.recordedMm).toBeGreaterThan(listed.filledMm * 5);
		}
	});

	it('counts days with nothing to fill them and warns; the model runs them as 0 mm', () => {
		const input = zeroRunInput({}, () => {});
		const h = input.series.rain_chirps_mm!.values.slice();
		const gapDays = runDays.slice(0, 10);
		for (const i of gapDays) h[i] = null;
		input.series = { ...input.series, rain_chirps_mm: { startDate: S, values: h } };
		const out = runModel(input);
		expect(checkInvariants(input, out)).toBeNull();
		expect(out.summary.zeroRainInfill!.unfilledDays).toBe(10);
		expect(out.summary.zeroRainInfill!.periods[0]!.unfilledDays).toBe(10);
		expect(out.summary.warnings.find((w) => w.startsWith('Catchment rain treated as missing'))).toMatch(
			/ 10 of those days have no CHIRPS or forecast value either and run as 0 mm\./
		);
	});

	it('does nothing without catchment rain, or without a flagged run', () => {
		const noCatchment = runModel({ ...runInput(), series: series(null, chirps()) });
		expect(noCatchment.summary.zeroRainInfill).toBeNull();
		const clean = runModel(runInput());
		expect(clean.summary.zeroRainInfill).toMatchObject({ periods: [], keptDry: [], asRecordedDays: 0, days: 0 });
		expect(clean.summary.warnings.some((w) => /zero runs|treated as missing/.test(w))).toBe(false);
	});

	it('only claims days inside the run window, and a day in two periods once', () => {
		const h = chirps();
		const c = catchment(h);
		for (const i of runDays) c[i] = 0;
		const m = zeroRainMask(
			{ startDate: S, values: c },
			{ ...ACC, mode: 'missing', keepDry: [], missing: [{ start: '2003-08-01', end: '2003-09-10', reason: 'overlap' }] },
			toEpochDay('2003-06-01'),
			92 // 2003-06-01 … 2003-08-31
		)!;
		expect(m.infill.periods.map((p) => [p.source, p.days])).toEqual([
			['flagged', toEpochDay(RUN_TO) - toEpochDay('2003-06-01') + 1],
			['listed', toEpochDay('2003-08-31') - toEpochDay(RUN_TO)] // the flagged run already has the rest
		]);
		expect(m.mask.reduce((a, b) => a + b, 0)).toBe(92);
	});
});

describe('data-quality limits decide which zero runs a run fills (settings.dataQuality, engine 1.20.0, issue #66)', () => {
	const dq = defaultDataQualitySettings();
	const filledDays = (input: ModelInput) => runModel(input).summary.zeroRainInfill!.days;

	it('a higher wet-season minimum leaves the run as recorded; the default fills it', () => {
		const wet = zeroRainRuns(zeroRunInput().series.rain_catchment_mm!).runs[0]!.wetDays;
		expect(filledDays(zeroRunInput())).toBe(RUN_N);
		expect(filledDays(zeroRunInput({ dataQuality: { ...dq, zeroRunMinWetDays: wet } }))).toBe(RUN_N);
		expect(filledDays(zeroRunInput({ dataQuality: { ...dq, zeroRunMinWetDays: wet + 1 } }))).toBe(0);
	});

	it('with the CHIRPS check on, fills a run CHIRPS saw rain over and keeps one CHIRPS reads as dry, saying why', () => {
		const on = { dataQuality: { ...dq, zeroRunChirpsCheck: true } };
		// The fixture's CHIRPS rains through the run: probably missing data, filled as before.
		expect(filledDays(zeroRunInput(on))).toBe(RUN_N);
		// CHIRPS dry over the run too: a dry spell that may be real, run as recorded.
		const dry = zeroRunInput(on);
		for (const i of runDays) dry.series.rain_chirps_mm!.values[i] = 0;
		const out = runModel(dry);
		expect(checkInvariants(dry, out)).toBeNull();
		expect(out.summary.zeroRainInfill!.days).toBe(0);
		expect(runDays.every((i) => get(out, null, 'rain_used')[i] === 0)).toBe(true);
		const check = out.summary.dataQuality!.seriesChecks!.find((c) => c.check === 'zerorun')!;
		expect(check.days).toBe(0);
		expect(check.text).toMatch(/1 run CHIRPS also reads as dry .* is not flagged, a long dry spell that may be real/);
		// Negative control: the same series with the check off fills the run, as today.
		const off = zeroRunInput();
		for (const i of runDays) off.series.rain_chirps_mm!.values[i] = 0;
		expect(runModel(off).summary.zeroRainInfill!.periods.find((p) => p.source === 'flagged')?.start).toBe(RUN_FROM);
	});

	it('the CHIRPS fit leaves out what the limits flag: the low-vs-CHIRPS ratio decides the years, the zero-run rule the days', () => {
		const fit = (over: ModelInput['settings']) => runModel(zeroRunInput(over)).summary.chirpsCorrection!;
		// By default the run's water year reads far below CHIRPS and is left out whole.
		const base = fit({});
		expect(base.lowVsChirpsYears!.length).toBeGreaterThan(0);
		// A stricter ratio keeps the year; the flagged run's days are then left out one by one.
		const strict = fit({ dataQuality: { ...dq, lowVsChirpsRatio: 0.01 } });
		expect(strict.lowVsChirpsYears).toEqual([]);
		expect(strict.flaggedDaysLeftOut).toBe(RUN_N);
		// … unless the zero-run rule no longer flags the run.
		expect(fit({ dataQuality: { ...dq, lowVsChirpsRatio: 0.01, zeroRunMinWetDays: 366 } }).flaggedDaysLeftOut).toBe(0);
	});
});


describe('resolveZeroRain', () => {
	it('defaults to treating flagged runs as missing, and drops what it cannot use with a warning', () => {
		const w: string[] = [];
		expect(resolveZeroRain(undefined, w)).toEqual({ ...ACC, mode: 'missing', keepDry: [], missing: [] });
		expect(resolveZeroRain({ mode: 'sometimes', keepDry: [{ start: '2003-01-01', end: '2002-01-01', reason: 'x' }], missing: 'no' }, w)).toEqual({
			...ACC,
			mode: 'missing',
			keepDry: [],
			missing: []
		});
		expect(w).toEqual([
			'unknown zero-rain run mode "sometimes"; using missing',
			'keep-dry period {"start":"2003-01-01","end":"2002-01-01","reason":"x"} ends before it starts; ignored',
			'missing-rain periods are not a list; ignored'
		]);
		expect(resolveZeroRain({ mode: 'asRecorded', missing: [{ waterYear: 2003, reason: ' gauge moved ' }] }, [])).toEqual({
			...ACC,
			mode: 'asRecorded',
			keepDry: [],
			missing: [{ waterYear: 2003, reason: 'gauge moved' }]
		});
	});

	it('resolves the accumulation fields (engine ≥ 0.20.0): spread by default, an unknown mode or bad period dropped with a warning', () => {
		const w: string[] = [];
		const r = resolveZeroRain(
			{
				accumulationMode: 'smear',
				keepReadings: [{ start: '2003-06-10', end: '2003-06-10', reason: ' real storm ' }, { start: '2003-06-10', end: '2003-06-01', reason: 'x' }],
				addAccumulations: 'no'
			},
			w
		);
		expect(r).toMatchObject({ accumulationMode: 'spread', keepReadings: [{ start: '2003-06-10', end: '2003-06-10', reason: 'real storm' }], addAccumulations: [] });
		expect(w).toEqual([
			'unknown accumulation mode "smear"; using spread',
			'keep-reading period {"start":"2003-06-10","end":"2003-06-01","reason":"x"} ends before it starts; ignored',
			'listed accumulations are not a list; ignored'
		]);
		expect(resolveZeroRain({ accumulationMode: 'asRecorded' }, []).accumulationMode).toBe('asRecorded');
	});
});
