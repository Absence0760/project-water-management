// Double-mass check against CHIRPS (engine ≥ 0.18.0, CR-20). All fixtures are synthetic.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import {
	DOUBLE_MASS_MIN_CHANGE,
	DOUBLE_MASS_MIN_YEARS,
	doubleMass,
	doubleMassCheck,
	doubleMassRunWarning,
	pettittP
} from './doublemass';
import { defaultProjectSettings, type DailySeries, type ModelInput, type SeriesKind, type ZeroRainSettings } from './project';
import { chirpsBiasFactors } from './rain';
import { runModel } from './run';

/** The accumulation fields (engine ≥ 0.20.0) at their defaults. */
const ACC: Pick<ZeroRainSettings, 'accumulationMode' | 'keepReadings' | 'addAccumulations'> = { accumulationMode: 'spread', keepReadings: [], addAccumulations: [] };

type Series = Partial<Record<SeriesKind, DailySeries>>;

const FIRST_WY = 1990;
const S = `${FIRST_WY}-10-01`;
const d0 = toEpochDay(S);
/** CHIRPS rain on every third day, mm, by calendar month (a winter-rainfall shape). */
const BASE = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];

/** A small deterministic generator (LCG), so every run of the tests sees the same "noise". */
function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/**
 * `ratios[k]` water years from 1 October FIRST_WY: CHIRPS with a year-to-year
 * wetness factor, the catchment ratios[k] × CHIRPS with ±3 % noise per year.
 */
function build(ratios: number[], seed = 7): { c: (number | null)[]; h: (number | null)[]; days: number } {
	const rnd = lcg(seed);
	const days = toEpochDay(`${FIRST_WY + ratios.length}-10-01`) - d0;
	const wet = ratios.map(() => 0.7 + 0.6 * rnd());
	const noise = ratios.map(() => 1 + 0.06 * (rnd() - 0.5));
	const h: (number | null)[] = [];
	const c: (number | null)[] = [];
	for (let i = 0; i < days; i++) {
		const k = Number(fromEpochDay(d0 + i).slice(0, 4)) - FIRST_WY - (monthOfEpochDay(d0 + i) >= 10 ? 0 : 1);
		const v = i % 3 === 0 ? BASE[monthOfEpochDay(d0 + i)]! * wet[k]! : 0;
		h.push(v);
		c.push(v * ratios[k]! * noise[k]!);
	}
	return { c, h, days };
}
const series = (c: (number | null)[], h: (number | null)[]): Series => ({
	rain_catchment_mm: { startDate: S, values: c },
	rain_chirps_mm: { startDate: S, values: h }
});
const repeat = (v: number, n: number) => new Array<number>(n).fill(v);
const indexOfDate = (iso: string) => toEpochDay(iso) - d0;

describe('pettittP', () => {
	it('is 1 for a flat sequence and small for a clear step', () => {
		expect(pettittP(repeat(2, 20))).toBe(1);
		expect(pettittP([...repeat(2, 10), ...repeat(3, 10)])).toBeLessThan(0.01);
		expect(pettittP([1])).toBe(1);
	});

	it('finds no change in an alternating sequence', () => {
		expect(pettittP(Array.from({ length: 20 }, (_, i) => (i % 2 ? 2.1 : 1.9)))).toBeGreaterThan(0.5);
	});
});

describe('doubleMass', () => {
	it('finds no break in a steady ratio, and its cumulative residual ends at 0', () => {
		const { c, h } = build(repeat(2, 20));
		const dm = doubleMass(series(c, h))!;
		expect(dm.years).toHaveLength(20);
		expect(dm.breaks).toEqual([]);
		expect(dm.segments).toHaveLength(1);
		expect(dm.segments[0]).toMatchObject({ fromWaterYear: 1990, toWaterYear: 2009, years: 20 });
		expect(dm.wholeSlope).toBeCloseTo(2, 1);
		expect(dm.segments[0]!.slope).toBe(dm.wholeSlope);
		const last = dm.years[dm.years.length - 1]!;
		expect(last.residualPct).toBeCloseTo(0, 9);
		expect(last.cumCatchmentMm).toBeCloseTo(dm.years.reduce((a, y) => a + y.catchmentMm, 0), 6);
		for (const y of dm.years) expect(Math.abs(y.residualPct!)).toBeLessThan(5);
		expect(doubleMassCheck(dm)).toBeNull();
	});

	it('finds one break, where it is, with its slopes', () => {
		const { c, h } = build([...repeat(2, 12), ...repeat(2.8, 12)]);
		const dm = doubleMass(series(c, h))!;
		expect(dm.breaks).toHaveLength(1);
		const b = dm.breaks[0]!;
		expect(b.afterWaterYear).toBe(2001);
		expect(b.slopeBefore).toBeCloseTo(2, 1);
		expect(b.slopeAfter).toBeCloseTo(2.8, 1);
		expect(b.change).toBeGreaterThan(DOUBLE_MASS_MIN_CHANGE);
		expect(b.pettittP).toBeLessThan(0.05);
		expect(dm.segments.map((s) => [s.fromWaterYear, s.toWaterYear])).toEqual([
			[1990, 2001],
			[2002, 2013]
		]);
		const check = doubleMassCheck(dm)!;
		expect(check.check).toBe('doublemass');
		expect(check.seriesKind).toBe('rain_catchment_mm');
		expect(check.examples).toEqual([{ date: '2002-10-01', endDate: '2014-09-30', value: b.slopeAfter / b.slopeBefore, runDays: dm.segments[1]!.days }]);
		expect(check.text).toMatch(
			new RegExp(
				`^Rainfall \\(catchment\\): on the double-mass curve against CHIRPS \\(24 water years, whole-record slope \\d\\.\\d\\d\\), ` +
					`catchment rain changes slope after 2001/02 \\(${b.slopeBefore.toFixed(2)} → ${b.slopeAfter.toFixed(2)}, \\+${Math.round(b.change * 100)} %\\)\\. `
			)
		);
	});

	it('finds a rise followed by a fall (two breaks), which a single-change test misses', () => {
		const { c, h } = build([...repeat(2, 10), ...repeat(2.8, 8), ...repeat(1, 7)]);
		const dm = doubleMass(series(c, h))!;
		expect(dm.breaks.map((b) => b.afterWaterYear)).toEqual([1999, 2007]);
		expect(dm.segments.map((s) => +s.slope.toFixed(1))).toEqual([2, 2.8, 1]);
		expect(dm.breaks[1]!.change).toBeLessThan(-0.5);
		expect(doubleMassCheck(dm)!.text).toMatch(/after 1999\/00 \(.*\+\d+ %\) and after 2007\/08 \(.*−\d+ %\)/);
	});

	it('does not report a slope change under 20 %, however clean', () => {
		const { c, h } = build([...repeat(2, 12), ...repeat(2.2, 12)]);
		const dm = doubleMass(series(c, h))!;
		expect(dm.breaks).toEqual([]);
		expect(dm.segments).toHaveLength(1);
	});

	it('keeps every segment at least 5 water years long: a late 3-year shift is not a break', () => {
		const { c, h } = build([...repeat(2, 15), ...repeat(3, 3)]);
		const dm = doubleMass(series(c, h))!;
		expect(dm.segments.every((s) => s.years >= 5)).toBe(true);
		expect(dm.breaks.every((b) => b.afterWaterYear <= 2002)).toBe(true);
	});

	it(`needs ${DOUBLE_MASS_MIN_YEARS} judged water years, and skips short or near-dry ones`, () => {
		const nine = build(repeat(2, 9));
		expect(doubleMass(series(nine.c, nine.h))).toBeNull();
		const { c, h } = build(repeat(2, 11));
		// Water year 1995/96: 100 blank days leave 266 shared days, under 300.
		for (let i = indexOfDate('1995-11-01'); i < indexOfDate('1995-11-01') + 100; i++) c[i] = null;
		const dm = doubleMass(series(c, h))!;
		expect(dm.skippedYears).toEqual([1995]);
		expect(dm.years.map((y) => y.waterYear)).not.toContain(1995);
		expect(dm.years).toHaveLength(10);
		// One more short year and it is too short to judge.
		for (let i = indexOfDate('1997-11-01'); i < indexOfDate('1997-11-01') + 100; i++) c[i] = null;
		expect(doubleMass(series(c, h))).toBeNull();
		// No CHIRPS, no result.
		expect(doubleMass({ rain_catchment_mm: { startDate: S, values: c } })).toBeNull();
	});

	it('leaves a flagged zero run out unless it is kept dry, and a listed missing period always', () => {
		const { c, h } = build(repeat(2, 12));
		// A 90-day wet-season zero run in 1996 (water year 1995/96): flagged, 276 shared days left.
		const from = indexOfDate('1996-05-01');
		for (let i = from; i < from + 90; i++) c[i] = 0;
		const dm = doubleMass(series(c, h))!;
		expect(dm.skippedYears).toContain(1995);
		const period = { start: fromEpochDay(d0 + from - 3), end: fromEpochDay(d0 + from + 92), reason: 'confirmed dry' };
		const kept = doubleMass(series(c, h), { ...ACC, mode: 'missing', keepDry: [period], missing: [] })!;
		expect(kept.skippedYears).not.toContain(1995);
		expect(kept.years.find((y) => y.waterYear === 1995)!.ratio).toBeLessThan(1.8); // the zeros count
		// Listed missing wins over keep-dry.
		const listed = doubleMass(series(c, h), { ...ACC, mode: 'missing', keepDry: [period], missing: [period] })!;
		expect(listed.skippedYears).toContain(1995);
	});

	it('gives the same result at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const { c, h } = build([...repeat(2, 12), ...repeat(2.8, 12)]);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = JSON.stringify(doubleMass(series(c, h)));
			env.TZ = 'Pacific/Pago_Pago';
			const west = JSON.stringify(doubleMass(series(c, h)));
			env.TZ = 'UTC';
			expect(east).toBe(JSON.stringify(doubleMass(series(c, h))));
			expect(west).toBe(east);
		} finally {
			env.TZ = tz;
		}
	});
});

describe('doubleMassRunWarning', () => {
	/** A rise then a fall; catchment rain blank in the last two water years, so CHIRPS fills them. */
	function gapInLastSegment() {
		const ratios = [...repeat(2, 10), ...repeat(2.8, 8), ...repeat(1, 8)];
		const { c, h, days } = build(ratios);
		const gap = indexOfDate(`${FIRST_WY + ratios.length - 2}-10-01`);
		for (let i = gap; i < days; i++) c[i] = null;
		return { c, h, days, gap };
	}

	it('warns when CHIRPS fills days in a segment whose ratio differs from the pooled fit', () => {
		const { c, h, days, gap } = gapInLastSegment();
		const s = series(c, h);
		const dm = doubleMass(s)!;
		expect(dm.segments).toHaveLength(3);
		const corr = chirpsBiasFactors(s, 'monthly')!;
		const pooled = corr.pooled.ownFactor!;
		const w = doubleMassRunWarning(dm, corr, c, h, d0)!;
		const last = dm.segments[2]!;
		expect(w).toBe(
			`CHIRPS fills catchment-rain gaps with factors fitted on the whole record (pooled catchment / CHIRPS ${pooled.toFixed(2)}), ` +
				`but the double-mass check finds the ratio changed: ${days - gap} days from ${last.fromWaterYear}/${String((last.fromWaterYear + 1) % 100).padStart(2, '0')} on, ` +
				`where catchment rain reads ${last.slope.toFixed(2)} × CHIRPS (−${Math.round((1 - last.slope / pooled) * 100)} %). ` +
				"Those days may run too wet or too dry. The Data tab's double-mass chart shows the segments; " +
				'Settings → CHIRPS fit period can fit the factors per water-year range instead, and propose ranges from these breaks.'
		);
	});

	it('is silent without a break, in mode none, or when CHIRPS fills nothing', () => {
		const { c, h, gap } = gapInLastSegment();
		const s = series(c, h);
		const dm = doubleMass(s)!;
		expect(doubleMassRunWarning(dm, chirpsBiasFactors(s, 'none'), c, h, d0)).toBeNull();
		expect(doubleMassRunWarning({ ...dm, breaks: [] }, chirpsBiasFactors(s, 'monthly'), c, h, d0)).toBeNull();
		expect(doubleMassRunWarning(dm, chirpsBiasFactors(s, 'monthly'), c.slice(0, gap), h.slice(0, gap), d0)).toBeNull();
		expect(doubleMassRunWarning(null, chirpsBiasFactors(s, 'monthly'), c, h, d0)).toBeNull();
	});

	it('reaches a run: summary, data check after the catchment rain checks, and the warning', () => {
		const { c, h } = gapInLastSegment();
		const input: ModelInput = { settings: { apanMm: repeat(150, 12) as unknown as Monthly, calibration: { ...defaultProjectSettings().calibration, catchmentAreaKm2: 10 } }, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: series(c, h) };
		const out = runModel(input);
		const dm = out.summary.dataQuality!.doubleMass!;
		expect(dm.breaks).toHaveLength(2);
		const checks = out.summary.dataQuality!.seriesChecks!;
		const at = checks.findIndex((x) => x.check === 'doublemass');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(checks.slice(0, at).every((x) => x.seriesKind === 'rain_catchment_mm')).toBe(true);
		expect(out.summary.warnings).toContain(checks[at]!.text);
		expect(out.summary.warnings.some((w) => w.startsWith('CHIRPS fills catchment-rain gaps'))).toBe(true);
		// The check never changes the fit: same factors as without it.
		expect(out.summary.chirpsCorrection!.months).toEqual(chirpsBiasFactors(input.series, 'monthly')!.months.map((m, i) => ({ ...m, fallbackDays: out.summary.chirpsCorrection!.months[i]!.fallbackDays })));
	});
});
