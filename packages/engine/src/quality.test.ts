import { describe, expect, it } from 'vitest';
import {
	agreementOptions,
	agreementWarning,
	areaMismatches,
	areaMismatchWarning,
	checkSeries,
	FLATLINE_FLOW_MAX_DAYS,
	FLATLINE_FLOW_RECESSION_PER_DAY,
	FLATLINE_FLOW_RESOLUTION_STEPS,
	FLATLINE_MIN_DAYS,
	flatlineDaysOf,
	flowFlatlineMinDays,
	seriesResolution,
	LOW_VS_CHIRPS_MIN_DAYS,
	LOW_VS_CHIRPS_RATIO,
	MAX_LISTED,
	observedAgreement,
	OUTLIER_FACTOR,
	outlierFactorOf,
	rainVsChirps,
	rainVsChirpsCheck,
	resolveDataQuality,
	seriesChecks,
	seriesRowFlags,
	usualAnnualRainMm,
	ZERO_RUN_MIN_WET_DAYS,
	ZERO_RUN_PLAIN_DAYS,
	zeroRainCheck,
	zeroRainRuns
} from './quality';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearLabel } from './calendar';
import { defaultDataQualitySettings, defaultProjectSettings, SERIES_KINDS, type NetworkNode } from './project';
import { clientCatchmentDirs } from './testing/client-catchment-fixture';

// 1 m³/s for one day = 0.0864 Mm³.
const constant = (startDate: string, days: number, v: number | null) => ({ startDate, values: new Array(days).fill(v) });

describe('observedAgreement', () => {
	it('returns null unless both observed records exist and overlap', () => {
		expect(observedAgreement({ flow_observed_m3s: constant('2020-10-01', 10, 1) })).toBeNull();
		expect(
			observedAgreement({ flow_observed_m3s: constant('2020-10-01', 10, 1), flow_logger_m3s: constant('2021-10-01', 10, 1) })
		).toBeNull();
	});

	it('sums volumes per water year on shared days only and flags out-of-band years', () => {
		// Water year 2020 (Oct 2020 – Sep 2021): gauge 1, logger 1 → agree.
		// Water year 2021: gauge 0.1, logger 1 → 10 %, flagged.
		const gauge = { startDate: '2020-10-01', values: [...new Array(365).fill(1), ...new Array(365).fill(0.1)] };
		const logger = { startDate: '2020-10-01', values: new Array(730).fill(1) };
		// a gap in the logger: those gauge days must not count
		logger.values[10] = null;
		const ag = observedAgreement({ flow_observed_m3s: gauge, flow_logger_m3s: logger })!;
		expect(ag.years.map((y) => y.waterYear)).toEqual([2020, 2021]);
		expect(ag.years[0]).toMatchObject({ days: 364, flagged: false });
		expect(ag.years[0]!.ratio).toBeCloseTo(1, 12);
		expect(ag.years[0]!.volumeAMm3).toBeCloseTo(364 * 0.0864, 9);
		expect(ag.years[1]!.ratio).toBeCloseTo(0.1, 12);
		expect(ag.flaggedYears).toEqual([2021]);
		expect(agreementWarning(ag)).toMatch(/observed gauge flow as a share of the logger flow volume .*: 2021\/22: 10 %\./);
	});

	it('flags too-high ratios and ignores years with too few shared days', () => {
		const ag = observedAgreement(
			{ flow_observed_m3s: constant('2020-10-01', 60, 3), flow_logger_m3s: constant('2020-10-01', 60, 1) },
			{ minDays: 90 }
		)!;
		expect(ag.years[0]!.ratio).toBeCloseTo(3, 12);
		expect(ag.flaggedYears).toEqual([]); // only 60 days
		expect(observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 3), flow_logger_m3s: constant('2020-10-01', 100, 1) })!.flaggedYears).toEqual([2020]);
	});

	it('flags a year where one record is zero and the other is not', () => {
		const ag = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 1), flow_logger_m3s: constant('2020-10-01', 100, 0) })!;
		expect(ag.years[0]!.ratio).toBeNull();
		expect(ag.flaggedYears).toEqual([2020]);
		expect(agreementWarning(ag)).toMatch(/2020\/21: the logger flow recorded nothing/);
	});

	it('skips negative readings as invalid, like missing days', () => {
		const gauge = constant('2020-10-01', 100, 1);
		const logger = constant('2020-10-01', 100, 1);
		gauge.values[0] = -5;
		logger.values[1] = -0.001;
		const y = observedAgreement({ flow_observed_m3s: gauge, flow_logger_m3s: logger })!.years[0]!;
		expect(y.days).toBe(98);
		expect(y.ratio).toBeCloseTo(1, 12);
	});

	it('handles a single shared day, and series that are empty or entirely missing', () => {
		const one = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 1, 2), flow_logger_m3s: constant('2020-10-01', 1, 1) })!;
		expect(one.years).toEqual([{ waterYear: 2020, days: 1, volumeAMm3: 2 * 0.0864, volumeBMm3: 0.0864, ratio: 2, flagged: false }]);
		expect(observedAgreement({ flow_observed_m3s: constant('2020-10-01', 50, null), flow_logger_m3s: constant('2020-10-01', 50, 1) })).toBeNull();
		expect(observedAgreement({ flow_observed_m3s: { startDate: '2020-10-01', values: [] }, flow_logger_m3s: constant('2020-10-01', 5, 1) })).toBeNull();
		// Both zero all year: nothing to compare, nothing flagged.
		const dry = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 0), flow_logger_m3s: constant('2020-10-01', 100, 0) })!;
		expect(dry.years[0]).toMatchObject({ ratio: null, flagged: false });
	});

	it('puts 29 February in the water year that contains it and splits years on 1 October', () => {
		// 2019-09-30 … 2020-10-01: WY 2018 has 1 day, WY 2019 has 366 (leap), WY 2020 has 1.
		const n = 368;
		const ag = observedAgreement({ flow_observed_m3s: constant('2019-09-30', n, 1), flow_logger_m3s: constant('2019-09-30', n, 1) })!;
		expect(ag.years.map((y) => [y.waterYear, y.days])).toEqual([
			[2018, 1],
			[2019, 366],
			[2020, 1]
		]);
	});

	it('uses the thresholds it is given, including the minimum shared days', () => {
		const s = { flow_observed_m3s: constant('2020-10-01', 100, 0.8), flow_logger_m3s: constant('2020-10-01', 100, 1) };
		expect(observedAgreement(s)!.flaggedYears).toEqual([]); // 80 % is inside 2/3 … 3/2
		expect(observedAgreement(s, { minRatio: 0.9, maxRatio: 1.1, minDays: 90 })!.flaggedYears).toEqual([2020]);
		expect(observedAgreement(s, { minRatio: 0.9, maxRatio: 1.1, minDays: 101 })!.flaggedYears).toEqual([]);
		const ag = observedAgreement(s, agreementOptions({ agreementMinRatio: 0.9, agreementMaxRatio: 1.1, agreementMinDays: 30 }))!;
		expect([ag.minRatio, ag.maxRatio, ag.minDays]).toEqual([0.9, 1.1, 30]);
		expect(agreementWarning(ag)).toMatch(/expected 90–110 %\): 2020\/21: 80 %/);
		expect(() => observedAgreement(s, { minRatio: 2, maxRatio: 1.5 })).toThrow(RangeError);
		expect(() => observedAgreement(s, { minRatio: 0 })).toThrow(RangeError);
	});

	it('shows a tiny ratio as <1 %, not 0 %', () => {
		const ag = observedAgreement({ flow_observed_m3s: constant('2020-10-01', 100, 0.001), flow_logger_m3s: constant('2020-10-01', 100, 1) })!;
		expect(agreementWarning(ag)).toMatch(/2020\/21: <1 %/);
	});

	it('labels water years', () => {
		expect(waterYearLabel(2016)).toBe('2016/17');
		expect(waterYearLabel(1999)).toBe('1999/00');
	});
});

describe('resolveDataQuality', () => {
	it('defaults to 2/3 … 3/2 on 90 shared days', () => {
		expect(resolveDataQuality(undefined)).toMatchObject({ agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 });
		expect(resolveDataQuality(undefined)).toEqual(defaultProjectSettings().dataQuality);
	});

	it('keeps valid values and replaces each invalid one with its default, with a warning', () => {
		expect(resolveDataQuality({ agreementMinRatio: 0.5, agreementMaxRatio: 2, agreementMinDays: 30 })).toEqual({
			...defaultProjectSettings().dataQuality,
			agreementMinRatio: 0.5,
			agreementMaxRatio: 2,
			agreementMinDays: 30
		});
		const warnings: string[] = [];
		const dq = resolveDataQuality({ agreementMinRatio: 1.2, agreementMaxRatio: 0.5, agreementMinDays: 12.5 }, warnings);
		expect(dq).toEqual(defaultProjectSettings().dataQuality);
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toMatch(/agreementMinRatio = 1.2 is invalid/);
		for (const bad of [0, -1, NaN, '0.5', Infinity]) {
			const w: string[] = [];
			expect(resolveDataQuality({ agreementMinRatio: bad }, w).agreementMinRatio).toBe(2 / 3);
			expect(w, String(bad)).toHaveLength(1);
		}
		expect(resolveDataQuality({ agreementMinDays: 367 }).agreementMinDays).toBe(90);
		expect(resolveDataQuality('nonsense')).toEqual(defaultProjectSettings().dataQuality);
	});
});

describe('checkSeries', () => {
	// Deterministic "rain": wet every third day, 1–20 mm.
	const rain = (days: number) => Array.from({ length: days }, (_, i) => (i % 3 === 0 ? 1 + ((i * 7) % 20) : 0));

	it('finds nothing wrong with clean data, a single day, empty or all-missing series', () => {
		expect(checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: rain(1000) })).toEqual([]);
		expect(checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: [] })).toEqual([]);
		expect(checkSeries('flow_observed_m3s', constant('2020-01-01', 400, null))).toEqual([]);
		expect(checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: [3] })).toEqual([]);
	});

	it('reports negative values with their dates', () => {
		const v = rain(20);
		v[4] = -2;
		const [c] = checkSeries('rain_catchment_mm', { startDate: '2020-02-27', values: v });
		expect(c).toMatchObject({ check: 'negative', days: 1, examples: [{ date: '2020-03-02', value: -2 }] });
		expect(c!.text).toMatch(/^Rainfall \(catchment\): 1 negative value \(2020-03-02: -2 mm\)/);
	});

	it('flags values far above the 99th percentile, largest first, once there are enough wet days', () => {
		const v: (number | null)[] = rain(1000);
		v[10] = 900; // a typo
		v[20] = 1200;
		const [c] = checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: v });
		expect(c).toMatchObject({ check: 'outlier', days: 2 });
		expect(c!.examples.map((e) => e.value)).toEqual([1200, 900]);
		expect(c!.text).toMatch(/2 days above 5× the 99th percentile/);
		// Too few positive values to judge: no outlier check.
		expect(checkSeries('rain_catchment_mm', { startDate: '2020-01-01', values: [...rain(90), 5000] })).toEqual([]);
		// Flow uses the wider factor: 6× the P99 is not an outlier, 20× is.
		const flow = Array.from({ length: 500 }, (_, i) => 1 + (i % 10) / 10);
		expect(checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: [...flow, 12] })).toEqual([]);
		expect(checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: [...flow, 40] })[0]).toMatchObject({ check: 'outlier', days: 1 });
	});

	it('flags long stretches of one value, and ignores short ones, zero flow under the cap and missing days', () => {
		const n = FLATLINE_MIN_DAYS.flow_logger_m3s!;
		// Resolution 0.15 (5.35 vs 5.5): at these flows the 14-day floor applies.
		const v: (number | null)[] = [1, 2, ...new Array(n).fill(5.35), 3, ...new Array(n - 1).fill(5.5), ...new Array(FLATLINE_FLOW_MAX_DAYS - 1).fill(0), null, null];
		const [c] = checkSeries('flow_logger_m3s', { startDate: '2021-01-01', values: v });
		expect(c).toMatchObject({ check: 'flatline', days: n, examples: [{ date: '2021-01-03', value: 5.35, runDays: n }] });
		expect(c!.text).toBe(
			"Logger flow: 1 flat stretch of more days than a slow recession holds one value at the record's resolution of 0.15 m³/s (14 to 90 days by flow) with the same value (2021-01-03: 5.35 m³/s for 14 days). A stuck logger or a filled-in gap?"
		);
		// Rain: five identical wet days in a row.
		expect(checkSeries('rain_chirps_mm', { startDate: '2021-01-01', values: [0, 4.2, 4.2, 4.2, 4.2, 4.2, 0] })[0]).toMatchObject({
			check: 'flatline',
			days: 5
		});
	});

	it('flow: the days a value must hold depend on the record’s resolution and the flow (issue #46 item 17, GSIM Part 2)', () => {
		expect([FLATLINE_MIN_DAYS.flow_observed_m3s, FLATLINE_FLOW_MAX_DAYS, FLATLINE_FLOW_RECESSION_PER_DAY, FLATLINE_FLOW_RESOLUTION_STEPS]).toEqual([14, 90, 0.01, 3]);
		// max(14, ⌈3·r / (0.01·Q)⌉), capped at 90.
		expect(flowFlatlineMinDays(1, 0.001)).toBe(14);
		expect(flowFlatlineMinDays(0.01, 0.001)).toBe(30);
		expect(flowFlatlineMinDays(0.004, 0.001)).toBe(75);
		expect(flowFlatlineMinDays(0.002, 0.001)).toBe(90);
		expect(flowFlatlineMinDays(0, 0.001)).toBe(90);
		expect(flowFlatlineMinDays(0, null)).toBe(90);
		expect(flowFlatlineMinDays(0.5, null)).toBe(14);
		expect(flowFlatlineMinDays(-0.5, null)).toBe(14);
		// The resolution: the smallest difference between distinct values, float noise aside.
		expect(seriesResolution([0.004, 0.005, null, 0.007, 0.004])).toBeCloseTo(0.001, 12);
		expect(seriesResolution([0.1 + 0.2, 0.3, 0.5])).toBeCloseTo(0.2, 12);
		expect(seriesResolution([1, 1, null])).toBeNull();

		// 300 days varying 1–1.3 m³/s at three decimals (resolution 0.001), then one value repeated.
		const varied = Array.from({ length: 300 }, (_, i) => 1 + ((i * 7) % 300) / 1000);
		const flat = (v: number, n: number) => [...varied, ...new Array(n).fill(v), 2.5];
		const flags = (v: number, n: number) => checkSeries('flow_observed_m3s', { startDate: '2020-01-01', values: flat(v, n) }).filter((c) => c.check === 'flatline');
		// A steady dry-season low flow of 0.004 m³/s: 75 days.
		expect(flags(0.004, 74)).toEqual([]);
		expect(seriesRowFlags('flow_observed_m3s', { startDate: '2020-01-01', values: flat(0.004, 74) }).flatline.some(Boolean)).toBe(false);
		expect(flags(0.004, 75)[0]).toMatchObject({ days: 75, examples: [{ value: 0.004, runDays: 75 }] });
		expect(flags(0.004, 75)[0]!.text).toMatch(/at the record's resolution of 0\.001 m³\/s \(14 to 90 days by flow\)/);
		// A logger stuck at a high flow: 14 days.
		expect(flags(9.5, 13)).toEqual([]);
		expect(flags(9.5, 14)[0]).toMatchObject({ days: 14 });
		expect(seriesRowFlags('flow_observed_m3s', { startDate: '2020-01-01', values: flat(9.5, 14) }).flatline.filter(Boolean)).toHaveLength(14);
		// Zero flow is treated like any low flow: the cap.
		expect(flags(0, 89)).toEqual([]);
		expect(flags(0, 90)[0]).toMatchObject({ days: 90, examples: [{ value: 0, runDays: 90 }] });
		// Rain keeps its single 5-day limit, and never counts zeros.
		expect(checkSeries('rain_chirps_mm', { startDate: '2021-01-01', values: [...rain(400), 0.2, 0.2, 0.2, 0.2, 0.2, ...new Array(200).fill(0)] }).find((c) => c.check === 'flatline')).toMatchObject({ days: 5 });
	});

	it('seriesChecks runs every present series in kind order', () => {
		const bad = { startDate: '2020-01-01', values: [-1] };
		expect(seriesChecks({ flow_logger_m3s: bad, rain_catchment_mm: bad }).map((c) => c.seriesKind)).toEqual(['rain_catchment_mm', 'flow_logger_m3s']);
	});
});

describe('seriesRowFlags', () => {
	const rain = (days: number) => Array.from({ length: days }, (_, i) => (i % 3 === 0 ? 1 + ((i * 7) % 20) : 0));

	it('returns all-false arrays of the series length for clean, empty or all-missing data', () => {
		expect(seriesRowFlags('rain_catchment_mm', { startDate: '2020-01-01', values: rain(50) })).toEqual({
			negative: new Array(50).fill(false),
			outlier: new Array(50).fill(false),
			flatline: new Array(50).fill(false)
		});
		expect(seriesRowFlags('flow_observed_m3s', { startDate: '2020-01-01', values: [] })).toEqual({ negative: [], outlier: [], flatline: [] });
		const n = seriesRowFlags('flow_observed_m3s', constant('2020-01-01', 5, null));
		expect(n.negative).toEqual(new Array(5).fill(false));
	});

	it('flags exactly the days checkSeries reports as negative', () => {
		const v = rain(20);
		v[4] = -2;
		v[11] = -1;
		const flags = seriesRowFlags('rain_catchment_mm', { startDate: '2020-02-27', values: v });
		expect(flags.negative).toEqual(v.map((x) => x !== null && x < 0));
		const [c] = checkSeries('rain_catchment_mm', { startDate: '2020-02-27', values: v });
		expect(flags.negative.filter(Boolean).length).toBe(c!.days);
	});

	it('flags exactly the days checkSeries reports as outliers', () => {
		const v: (number | null)[] = rain(1000);
		v[10] = 900;
		v[20] = 1200;
		const flags = seriesRowFlags('rain_catchment_mm', { startDate: '2020-01-01', values: v });
		expect(flags.outlier[10]).toBe(true);
		expect(flags.outlier[20]).toBe(true);
		expect(flags.outlier.filter(Boolean)).toHaveLength(2);
		// Too few positive values to judge an outlier threshold: nothing flagged.
		const short = seriesRowFlags('rain_catchment_mm', { startDate: '2020-01-01', values: [...rain(90), 5000] });
		expect(short.outlier.some(Boolean)).toBe(false);
	});

	it('flags every day inside a qualifying flat stretch, and keeps adjacent different-value runs distinct', () => {
		const n = FLATLINE_MIN_DAYS.flow_logger_m3s!;
		// Resolution 0.15: the 14-day floor at these flows; the zero run stays under the 90-day cap.
		const v: (number | null)[] = [1, 2, ...new Array(n).fill(5.35), ...new Array(n).fill(5.5), ...new Array(FLATLINE_FLOW_MAX_DAYS - 1).fill(0), null, null];
		const flags = seriesRowFlags('flow_logger_m3s', { startDate: '2021-01-01', values: v });
		// Both runs qualify (each >= n days of one value), even though they sit back to back.
		expect(flags.flatline.slice(2, 2 + n).every(Boolean)).toBe(true);
		expect(flags.flatline.slice(2 + n, 2 + 2 * n).every(Boolean)).toBe(true);
		expect(flags.flatline[0]).toBe(false); // the value '1' day, too short a run
		expect(flags.flatline.slice(2 + 2 * n).every((f) => !f)).toBe(true); // the trailing zeros and missing days
		const [c] = checkSeries('flow_logger_m3s', { startDate: '2021-01-01', values: v });
		expect(flags.flatline.filter(Boolean)).toHaveLength(c!.days);
	});

	it('a day can carry more than one flag (a flat stretch of an impossible negative value)', () => {
		const n = FLATLINE_MIN_DAYS.flow_logger_m3s!;
		const v: (number | null)[] = new Array(n).fill(-0.5);
		const flags = seriesRowFlags('flow_logger_m3s', { startDate: '2021-01-01', values: v });
		expect(flags.negative.every(Boolean)).toBe(true);
		expect(flags.flatline.every(Boolean)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Catchment rain recorded as 0 when it is really missing (issue #2)
// ---------------------------------------------------------------------------

const WINTER = [4, 5, 6, 7, 8, 9];
const SUMMER = [1, 2, 3, 10, 11, 12];

/** Synthetic rain: 8 mm every third day in the wet months, 2 mm every ninth day in the others. */
function seasonal(startDate: string, days: number, wetMonths: number[]): (number | null)[] {
	const d0 = toEpochDay(startDate);
	return Array.from({ length: days }, (_, i) =>
		wetMonths.includes(monthOfEpochDay(d0 + i)) ? (i % 3 === 0 ? 8 : 0) : i % 9 === 0 ? 2 : 0
	);
}

/** Zero `from`…`to` (inclusive) and put 5 mm on the day either side, so the run is exactly that long. */
function gap(v: (number | null)[], startDate: string, from: string, to: string): void {
	const d0 = toEpochDay(startDate);
	const a = toEpochDay(from) - d0;
	const b = toEpochDay(to) - d0;
	for (let i = a; i <= b; i++) v[i] = 0;
	if (a > 0) v[a - 1] = 5;
	if (b + 1 < v.length) v[b + 1] = 5;
}

describe('zeroRainRuns (issue #2)', () => {
	const S = '2010-01-01';
	const DAYS = 6 * 365;

	it('flags a long zero run in the wet season of a winter-rainfall catchment, not a longer one in its dry season', () => {
		const v = seasonal(S, DAYS, WINTER);
		gap(v, S, '2012-06-01', '2012-08-15'); // 76 winter days
		gap(v, S, '2013-11-01', '2014-02-28'); // 120 summer days: a dry spell
		const z = zeroRainRuns({ startDate: S, values: v });
		expect(z.wetMonths).toEqual(WINTER);
		expect(z.runs).toHaveLength(1);
		expect(z.runs[0]).toMatchObject({ startDate: '2012-06-01', endDate: '2012-08-15', days: 76, wetDays: 76 });
		// Winter rain is 8/3 mm a day (203 mm over 76 days); the gap's own zeros
		// pull the June–August means down a little, so the estimate is lower.
		expect(z.runs[0]!.usualMm).toBeGreaterThan(160);
		expect(z.runs[0]!.usualMm).toBeLessThan(203);
	});

	it("uses the series' own climatology: the same June–August gap is a dry spell in a summer-rainfall catchment", () => {
		const v = seasonal(S, DAYS, SUMMER);
		gap(v, S, '2012-06-01', '2012-08-15');
		gap(v, S, '2012-12-01', '2013-02-14'); // 76 summer days
		const z = zeroRainRuns({ startDate: S, values: v });
		expect(z.wetMonths).toEqual(SUMMER);
		expect(z.runs.map((r) => [r.startDate, r.endDate])).toEqual([['2012-12-01', '2013-02-14']]);
	});

	it(`counts only the wet-season days toward the ${ZERO_RUN_MIN_WET_DAYS}`, () => {
		// From 1 March: March is dry, then April (30) + May.
		const at = (end: string) => {
			const v = seasonal(S, DAYS, WINTER);
			gap(v, S, '2012-03-01', end);
			return zeroRainRuns({ startDate: S, values: v }).runs;
		};
		expect(at('2012-05-29')).toEqual([]); // 59 wet days out of 90
		expect(at('2012-05-30')).toMatchObject([{ days: 91, wetDays: 60 }]);
	});

	it('a blank (or any non-zero) day ends a run', () => {
		const v = seasonal(S, DAYS, WINTER);
		gap(v, S, '2012-06-01', '2012-08-15');
		v[toEpochDay('2012-07-10') - toEpochDay(S)] = null;
		expect(zeroRainRuns({ startDate: S, values: v }).runs).toEqual([]);
		v[toEpochDay('2012-07-10') - toEpochDay(S)] = -1;
		expect(zeroRainRuns({ startDate: S, values: v }).runs).toEqual([]);
		v[toEpochDay('2012-07-10') - toEpochDay(S)] = 0;
		expect(zeroRainRuns({ startDate: S, values: v }).runs).toHaveLength(1);
	});

	it(`without about two years of data, falls back to a plain ${ZERO_RUN_PLAIN_DAYS}-day rule in any season`, () => {
		const short = (zeros: number) => [3, ...new Array(zeros).fill(0), 3, ...new Array(200).fill(3)];
		expect(zeroRainRuns({ startDate: S, values: short(ZERO_RUN_PLAIN_DAYS - 1) })).toMatchObject({ wetMonths: null, runs: [] });
		const z = zeroRainRuns({ startDate: S, values: short(ZERO_RUN_PLAIN_DAYS) });
		expect(z.runs).toEqual([{ startDate: '2010-01-02', endDate: '2010-06-30', days: 180, wetDays: 180, usualMm: null }]);
		expect(zeroRainCheck(z)!.text).toMatch(/180\+ days \(too little data to tell the wet season\)/);
		// A long series that never rains has no climatology either: the plain rule applies.
		expect(zeroRainRuns({ startDate: S, values: new Array(DAYS).fill(0) }).runs).toMatchObject([{ days: DAYS }]);
		expect(zeroRainRuns({ startDate: S, values: [] })).toMatchObject({ wetMonths: null, runs: [] });
	});

	it('warns only on the catchment rain, naming the dates and the blocked CHIRPS fallback', () => {
		const v = seasonal(S, DAYS, WINTER);
		gap(v, S, '2012-06-01', '2012-08-15');
		const [c] = checkSeries('rain_catchment_mm', { startDate: S, values: v });
		expect(c).toMatchObject({
			seriesKind: 'rain_catchment_mm',
			check: 'zerorun',
			days: 76,
			examples: [{ date: '2012-06-01', endDate: '2012-08-15', value: 0, runDays: 76 }]
		});
		expect(c!.text).toMatch(/^Rainfall \(catchment\): 1 run of zero rain covering 60\+ days of the wet season \(Apr, May, Jun, Jul, Aug, Sep: this series' six wettest months\)/);
		expect(c!.text).toMatch(/2012-06-01 to 2012-08-15 \(76 days, 76 in the wet season, which usually brings about \d+ mm\)/);
		expect(c!.text).toMatch(/on its own it blocks the fallback to CHIRPS \(then forecast\) rain that a blank day gets\. A run treats these runs as missing, so CHIRPS fills them, unless Settings → Zero-rain runs keeps them as recorded/);
		// CHIRPS and forecast zeros block nothing that matters here: not checked.
		expect(checkSeries('rain_chirps_mm', { startDate: S, values: v })).toEqual([]);
		// Negative control: the same series without the gap.
		expect(checkSeries('rain_catchment_mm', { startDate: S, values: seasonal(S, DAYS, WINTER) })).toEqual([]);
	});

	it(`lists at most ${MAX_LISTED} runs in the text`, () => {
		const runs = Array.from({ length: MAX_LISTED + 2 }, (_, k) => ({
			startDate: `${2000 + k}-06-01`,
			endDate: `${2000 + k}-08-15`,
			days: 76,
			wetDays: 76,
			usualMm: 200
		}));
		const c = zeroRainCheck({ wetMonths: WINTER, runs })!;
		expect(c.text).toMatch(/^Rainfall \(catchment\): 14 runs/);
		expect(c.text).toContain('2011-06-01 to 2011-08-15');
		expect(c.text).not.toContain('2012-06-01');
		expect(c.text).toMatch(/; and 2 more\./);
		expect(c.examples).toHaveLength(5);
		expect(c.days).toBe(76 * 14);
		expect(zeroRainCheck({ wetMonths: WINTER, runs: [] })).toBeNull();
	});
});

describe('rainVsChirps (issue #2)', () => {
	// Water years 2010/11 … 2017/18. CHIRPS is the seasonal rain; the catchment
	// reads twice CHIRPS (a systematic bias), except in the years scaled below.
	const S = '2010-10-01';
	const DAYS = toEpochDay('2018-10-01') - toEpochDay(S);
	const build = (scale: Record<number, number> = {}) => {
		const chirps = seasonal(S, DAYS, WINTER);
		const d0 = toEpochDay(S);
		const catchment = chirps.map((v, i): number | null => {
			const wy = Number(fromEpochDay(d0 + i).slice(0, 4)) - (monthOfEpochDay(d0 + i) >= 10 ? 0 : 1);
			return v! * 2 * (scale[wy] ?? 1);
		});
		return { rain_catchment_mm: { startDate: S, values: catchment }, rain_chirps_mm: { startDate: S, values: chirps } };
	};

	it("flags a year far below the record's usual catchment / CHIRPS ratio, not one that is merely low", () => {
		const r = rainVsChirps(build({ 2013: 0.4, 2015: 0.6 }))!;
		expect(r.usualRatio).toBeCloseTo(2, 12);
		expect(r.flaggedYears).toEqual([2013]);
		const y = (wy: number) => r.years.find((x) => x.waterYear === wy)!;
		// 0.8 in absolute terms, which a plain "catchment < ½ CHIRPS" rule would miss.
		expect(y(2013)).toMatchObject({ days: 365, flagged: true });
		expect(y(2013).ratio).toBeCloseTo(0.8, 12);
		expect(y(2015).ratio).toBeCloseTo(1.2, 12);
		expect(y(2015).flagged).toBe(false);
		expect(y(2013).catchmentMm).toBeCloseTo(y(2013).chirpsMm * 0.8, 9);
	});

	it('flags nothing when every year keeps the usual ratio', () => {
		const r = rainVsChirps(build())!;
		expect(r.years).toHaveLength(8);
		expect(r.flaggedYears).toEqual([]);
		expect(rainVsChirpsCheck(r)).toBeNull();
	});

	it('takes the usual ratio as 1 with fewer than five judged years', () => {
		const three = (factor: number) => {
			const chirps = seasonal(S, 3 * 365, WINTER);
			return { rain_catchment_mm: { startDate: S, values: chirps.map((v) => v! * factor) }, rain_chirps_mm: { startDate: S, values: chirps } };
		};
		const low = rainVsChirps(three(0.4))!;
		expect(low.usualRatio).toBe(1);
		expect(low.flaggedYears).toEqual([2010, 2011, 2012]);
		expect(rainVsChirps(three(0.6))!.flaggedYears).toEqual([]);
	});

	it(`judges a year only with ${LOW_VS_CHIRPS_MIN_DAYS}+ shared days and 50+ mm of CHIRPS rain on them`, () => {
		const s = build({ 2013: 0 });
		const d0 = toEpochDay(S);
		const blank = (from: string, to: string) => {
			for (let i = toEpochDay(from) - d0; i <= toEpochDay(to) - d0; i++) s.rain_catchment_mm.values[i] = null;
		};
		const y2013 = () => rainVsChirps(s)!.years.find((y) => y.waterYear === 2013);
		// 2013/14: blank catchment rain to 3 April leaves 180 shared days: judged …
		blank('2013-10-01', '2014-04-03');
		expect(y2013()).toMatchObject({ days: 180, flagged: true });
		// … one more blank day leaves 179: not judged.
		blank('2014-04-04', '2014-04-04');
		expect(y2013()).toMatchObject({ days: 179, flagged: false });

		// A year whose CHIRPS total is under 50 mm (the dry half only here: 2 mm
		// every ninth day, about 40 mm) is not judged either.
		const dry = build({ 2013: 0 });
		for (let i = toEpochDay('2014-04-01') - d0; i < toEpochDay('2014-10-01') - d0; i++) dry.rain_chirps_mm.values[i] = 0;
		const y = rainVsChirps(dry)!.years.find((x) => x.waterYear === 2013)!;
		expect(y.chirpsMm).toBeLessThan(50);
		expect(y.flagged).toBe(false);
	});

	it('does not flag a year CHIRPS recorded no rain in, and needs both series to overlap', () => {
		const s = build();
		const d0 = toEpochDay(S);
		for (let i = toEpochDay('2013-10-01') - d0; i < toEpochDay('2014-10-01') - d0; i++) {
			s.rain_chirps_mm.values[i] = 0;
			s.rain_catchment_mm.values[i] = 0;
		}
		expect(rainVsChirps(s)!.years.find((y) => y.waterYear === 2013)).toMatchObject({ ratio: null, flagged: false });
		expect(rainVsChirps({ rain_catchment_mm: s.rain_catchment_mm })).toBeNull();
		expect(rainVsChirps({ rain_chirps_mm: s.rain_chirps_mm })).toBeNull();
		expect(rainVsChirps({ ...s, rain_chirps_mm: { startDate: '2030-01-01', values: [1, 2] } })).toBeNull();
	});

	it('warns naming the water years and the blocked CHIRPS fallback, right after the catchment rain checks', () => {
		const s = build({ 2013: 0.4 });
		const c = rainVsChirpsCheck(rainVsChirps(s))!;
		expect(c).toMatchObject({ seriesKind: 'rain_catchment_mm', check: 'lowvschirps', days: 365 });
		expect(c.examples).toEqual([{ date: '2013-10-01', endDate: '2014-09-30', value: expect.closeTo(0.8, 12), runDays: 365 }]);
		expect(c.text).toMatch(/^Rainfall \(catchment\): 1 water year below 50 % of the usual catchment \/ CHIRPS rain ratio \(200 %\), on the days both have a reading: 2013\/14: \d+ mm vs \d+ mm, 80 % \(365 days\)\./);
		expect(c.text).toMatch(/blocks the fallback to CHIRPS/);
		// seriesChecks: catchment rain's own checks, then this one, then CHIRPS's.
		s.rain_catchment_mm.values[5] = -1;
		s.rain_chirps_mm.values[5] = -1;
		expect(seriesChecks(s).map((x) => [x.seriesKind, x.check])).toEqual([
			['rain_catchment_mm', 'negative'],
			['rain_catchment_mm', 'lowvschirps'],
			['rain_chirps_mm', 'negative']
		]);
	});
	it('lists every flagged year, not the first few (engine 1.30.1, issue #70)', () => {
		// Seven flagged years: the validation statement's table lists what the check's examples hold.
		const years = Array.from({ length: 7 }, (_, k) => ({ waterYear: 2000 + k, days: 365, catchmentMm: 200, chirpsMm: 500, ratio: 0.4, flagged: true }));
		const c = rainVsChirpsCheck({ usualRatio: 1, years, flaggedYears: years.map((y) => y.waterYear), ratioLimit: 0.5, baseline: 'record' })!;
		expect(c.examples.map((e) => e.date)).toEqual(years.map((y) => `${y.waterYear}-10-01`));
		expect(c.examples.at(-1)).toEqual({ date: '2006-10-01', endDate: '2007-09-30', value: 0.4, runDays: 365 });
		expect(c.text).toMatch(/^Rainfall \(catchment\): 7 water years below 50 %/);
	});
});

describe('data-quality limits as settings (engine 1.20.0, issue #66)', () => {
	const dq = defaultDataQualitySettings();

	it('defaults to the constants they replaced, so a project that never sets them runs as before', () => {
		expect(dq).toMatchObject({
			outlierFactorRain: OUTLIER_FACTOR.rain,
			outlierFactorFlow: OUTLIER_FACTOR.flow,
			flatlineRainDays: FLATLINE_MIN_DAYS.rain_catchment_mm,
			flatlineEvapDays: FLATLINE_MIN_DAYS.evap_apan_mm,
			flatlineFlowMinDays: FLATLINE_MIN_DAYS.flow_observed_m3s,
			flatlineFlowMaxDays: FLATLINE_FLOW_MAX_DAYS,
			zeroRunRule: 'wetDays',
			zeroRunMinWetDays: ZERO_RUN_MIN_WET_DAYS,
			zeroRunChirpsCheck: false,
			lowVsChirpsRatio: LOW_VS_CHIRPS_RATIO,
			lowVsChirpsBaseline: 'record',
			lowVsChirpsMinimum: 'fixed'
		});
		for (const k of SERIES_KINDS) expect(flatlineDaysOf(k, dq), k).toBe(FLATLINE_MIN_DAYS[k]);
		expect(defaultProjectSettings().dataQuality).toEqual(dq);
	});

	it('resolves each new field, replacing an invalid one with its default and a warning', () => {
		const w: string[] = [];
		const r = resolveDataQuality(
			{ outlierFactorRain: 1, flatlineRainDays: 1.5, zeroRunRule: 'weekly', zeroRunChirpsCheck: 'yes', lowVsChirpsRatio: 1, lowVsChirpsBaseline: 'moving', zeroRunUsualShare: 0.3 },
			w
		);
		expect(r).toEqual({ ...dq, lowVsChirpsBaseline: 'moving', zeroRunUsualShare: 0.3 });
		expect(w).toHaveLength(5);
		expect(w.join('\n')).toMatch(/zeroRunRule = "weekly" is invalid \(needs one of wetDays, usualRain\)/);
		expect(w.join('\n')).toMatch(/zeroRunChirpsCheck = "yes" is invalid \(needs true or false\)/);
		// A flow flat-line cap below its floor is raised to the floor.
		const w2: string[] = [];
		expect(resolveDataQuality({ flatlineFlowMinDays: 30, flatlineFlowMaxDays: 20 }, w2)).toMatchObject({ flatlineFlowMinDays: 30, flatlineFlowMaxDays: 30 });
		expect(w2).toEqual(['data-quality setting flatlineFlowMaxDays = 20 is below flatlineFlowMinDays = 30; using 30 for both']);
	});

	it('outlier factors: a wider factor clears a value the default flags, per-day flags included', () => {
		const v = Array.from({ length: 200 }, (_, i) => 1 + (i % 10) / 10);
		v[50] = 20; // 20 / p99 ≈ 10.5×
		const rain = { startDate: '2020-01-01', values: v };
		expect(checkSeries('rain_catchment_mm', rain).map((c) => c.check)).toEqual(['outlier']);
		expect(checkSeries('rain_catchment_mm', rain, { ...dq, outlierFactorRain: 12 })).toEqual([]);
		expect(checkSeries('rain_catchment_mm', rain, { ...dq, outlierFactorRain: 8 })[0]!.text).toMatch(/above 8× the 99th percentile/);
		expect(seriesRowFlags('rain_catchment_mm', rain, { ...dq, outlierFactorRain: 12 }).outlier[50]).toBe(false);
		// Flow reads its own factor (10 by default, so 10.5× is flagged, 12 isn't).
		expect(checkSeries('flow_observed_m3s', rain).map((c) => c.check)).toEqual(['outlier']);
		expect(checkSeries('flow_observed_m3s', rain, { ...dq, outlierFactorFlow: 12 })).toEqual([]);
		expect(outlierFactorOf('flow_logger_m3s', { ...dq, outlierFactorFlow: 3 })).toBe(3);
		expect(outlierFactorOf('evap_apan_mm', { ...dq, outlierFactorRain: 7 })).toBe(7);
	});

	it('flat-line limits: rain, A-pan and the flow floor and cap', () => {
		const flat = (n: number, v: number) => ({ startDate: '2020-01-01', values: [1, ...new Array(n).fill(v), 2] });
		expect(checkSeries('rain_catchment_mm', flat(5, 3)).map((c) => c.check)).toEqual(['flatline']);
		expect(checkSeries('rain_catchment_mm', flat(5, 3), { ...dq, flatlineRainDays: 6 })).toEqual([]);
		expect(checkSeries('evap_apan_mm', flat(6, 3), { ...dq, flatlineEvapDays: 6 }).map((c) => c.check)).toEqual(['flatline']);
		expect(checkSeries('evap_apan_mm', flat(6, 3))).toEqual([]);
		// Flow: the floor for an unknown resolution, the cap for zero flow.
		expect(flowFlatlineMinDays(1, null, { flatlineFlowMinDays: 10, flatlineFlowMaxDays: 40 })).toBe(10);
		expect(flowFlatlineMinDays(0, 0.001, { flatlineFlowMinDays: 10, flatlineFlowMaxDays: 40 })).toBe(40);
		expect(flowFlatlineMinDays(0.004, 0.001, { flatlineFlowMinDays: 10, flatlineFlowMaxDays: 40 })).toBe(40); // 75 capped
		expect(flowFlatlineMinDays(0.004, 0.001)).toBe(75);
		const zeroFlow = { startDate: '2020-01-01', values: [0.5, 0.25, ...new Array(40).fill(0), 1] };
		expect(checkSeries('flow_observed_m3s', zeroFlow)).toEqual([]);
		const c = checkSeries('flow_observed_m3s', zeroFlow, { ...dq, flatlineFlowMinDays: 10, flatlineFlowMaxDays: 40 });
		expect(c.map((x) => x.check)).toEqual(['flatline']);
		expect(c[0]!.text).toMatch(/\(10 to 40 days by flow\)/);
		expect(seriesRowFlags('flow_observed_m3s', zeroFlow, { ...dq, flatlineFlowMinDays: 10, flatlineFlowMaxDays: 40 }).flatline.filter(Boolean)).toHaveLength(40);
	});

	describe('zero-rain runs', () => {
		const S = '2010-01-01';
		const DAYS = 6 * 365;
		const winterGap = (from: string, to: string) => {
			const v = seasonal(S, DAYS, WINTER);
			gap(v, S, from, to);
			return { startDate: S, values: v };
		};

		it('the wet-season minimum is a setting, and the warning names it', () => {
			const s = winterGap('2012-06-01', '2012-08-15'); // 76 winter days
			expect(zeroRainRuns(s, { dq: { ...dq, zeroRunMinWetDays: 76 } }).runs).toHaveLength(1);
			expect(zeroRainRuns(s, { dq: { ...dq, zeroRunMinWetDays: 77 } }).runs).toEqual([]);
			expect(zeroRainCheck(zeroRainRuns(s, { dq: { ...dq, zeroRunMinWetDays: 70 } }))!.text).toMatch(/covering 70\+ days of the wet season/);
		});

		it("'usualRain' judges a run by the rain its days usually bring, with a minimum length", () => {
			const usual = { ...dq, zeroRunRule: 'usualRain' as const, zeroRunUsualShare: 0.2, zeroRunMinDays: 45 };
			const s = winterGap('2012-06-01', '2012-07-20'); // 50 winter days: under the 60 wet days the default needs
			const annual = usualAnnualRainMm(s)!;
			expect(zeroRainRuns(s).runs).toEqual([]);
			const z = zeroRainRuns(s, { dq: usual });
			expect(z.runs).toHaveLength(1);
			expect(z.runs[0]!.usualMm!).toBeGreaterThanOrEqual(0.2 * annual);
			expect(zeroRainCheck(z)!.text).toMatch(new RegExp(`covering 45\\+ days that the series' monthly means would give 20 % or more of its usual ${Math.round(annual)} mm a year: 2012-06-01 to 2012-07-20 \\(50 days, which usually bring about \\d+ mm\\)`));
			// The length floor.
			expect(zeroRainRuns(s, { dq: { ...usual, zeroRunMinDays: 51 } }).runs).toEqual([]);
			// A share the run's usual rain doesn't reach.
			expect(zeroRainRuns(s, { dq: { ...usual, zeroRunUsualShare: (z.runs[0]!.usualMm! + 1) / annual } }).runs).toEqual([]);
			// A long dry-season spell brings little rain: never flagged, however long (the default rule agrees).
			const dry = winterGap('2013-10-01', '2014-03-15');
			expect(zeroRainRuns(dry, { dq: usual }).runs).toEqual([]);
			// Without a climatology the plain rule still applies.
			const short = { startDate: S, values: [3, ...new Array(ZERO_RUN_PLAIN_DAYS).fill(0), 3, ...new Array(200).fill(3)] };
			expect(zeroRainRuns(short, { dq: usual }).runs).toHaveLength(1);
		});

		it('the CHIRPS check splits runs into probably missing (flagged) and dry spells that may be real (not flagged)', () => {
			const s = winterGap('2012-06-01', '2012-08-15');
			const on = { ...dq, zeroRunChirpsCheck: true };
			// CHIRPS rained through the run as usual: probably missing data.
			const wet = { startDate: S, values: seasonal(S, DAYS, WINTER) };
			const zw = zeroRainRuns(s, { dq: on, chirps: wet });
			expect(zw.runs).toMatchObject([{ startDate: '2012-06-01', verdict: 'probablyMissing' }]);
			expect(zw.runs[0]!.chirpsShare).toBeGreaterThan(0.9);
			expect(zw.dryRuns).toEqual([]);
			expect(zeroRainCheck(zw)!.text).toMatch(/CHIRPS read \d+ % of its usual rain over it/);
			expect(zeroRainCheck(zw)!.text).toMatch(/Checked against CHIRPS: a run is flagged when CHIRPS read 50 % or more/);
			// CHIRPS dry over the run too: a dry spell that may be real.
			const dryChirps = { startDate: S, values: [...wet.values] };
			gap(dryChirps.values, S, '2012-06-01', '2012-08-15');
			const zd = zeroRainRuns(s, { dq: on, chirps: dryChirps });
			expect(zd.runs).toEqual([]);
			expect(zd.dryRuns).toMatchObject([{ startDate: '2012-06-01', verdict: 'maybeDry', chirpsShare: 0 }]);
			const cd = zeroRainCheck(zd)!;
			expect(cd).toMatchObject({ check: 'zerorun', days: 0, examples: [] });
			expect(cd.text).toMatch(/^Rainfall \(catchment\): no zero-rain run is flagged\. 1 run CHIRPS also reads as dry \(under 50 % of its usual rain\) is not flagged/);
			// CHIRPS blank over most of the run can't judge it: flagged as before.
			const blank = { startDate: S, values: [...wet.values] as (number | null)[] };
			for (let i = toEpochDay('2012-06-01') - toEpochDay(S); i <= toEpochDay('2012-08-01') - toEpochDay(S); i++) blank.values[i] = null;
			const zb = zeroRainRuns(s, { dq: on, chirps: blank });
			expect(zb.runs).toMatchObject([{ verdict: null, chirpsShare: null }]);
			expect(zeroRainCheck(zb)!.text).toMatch(/too little CHIRPS to judge it/);
			// Off (the default): CHIRPS is not read, and the result has no verdicts.
			const off = zeroRainRuns(s, { dq, chirps: dryChirps });
			expect(off.runs).toHaveLength(1);
			expect(off.runs[0]).not.toHaveProperty('verdict');
			expect(off.dryRuns).toBeUndefined();
			// seriesChecks hands the CHIRPS series to the catchment rain's check.
			const checks = seriesChecks({ rain_catchment_mm: s, rain_chirps_mm: dryChirps }, on);
			expect(checks.find((c) => c.check === 'zerorun')!.days).toBe(0);
			expect(seriesChecks({ rain_catchment_mm: s, rain_chirps_mm: dryChirps }).find((c) => c.check === 'zerorun')!.days).toBe(76);
		});
	});

	describe('low vs CHIRPS', () => {
		/** Water years from 2000/01: CHIRPS is the seasonal rain, the catchment reads it × ratio(water year). */
		const record = (years: number, ratio: (wy: number) => number) => {
			const S = '2000-10-01';
			const n = toEpochDay(`${2000 + years}-10-01`) - toEpochDay(S);
			const chirps = seasonal(S, n, WINTER);
			const d0 = toEpochDay(S);
			const catchment = chirps.map((v, i): number | null => {
				const wy = Number(fromEpochDay(d0 + i).slice(0, 4)) - (monthOfEpochDay(d0 + i) >= 10 ? 0 : 1);
				return v! * ratio(wy);
			});
			return { rain_catchment_mm: { startDate: S, values: catchment }, rain_chirps_mm: { startDate: S, values: chirps } };
		};

		it('the ratio cutoff is a setting', () => {
			const s = record(8, (wy) => (wy === 2003 ? 0.8 : 2)); // 2003/04 at 40 % of the usual 2
			expect(rainVsChirps(s)!.flaggedYears).toEqual([2003]);
			expect(rainVsChirps(s, { ...dq, lowVsChirpsRatio: 0.39 })!.flaggedYears).toEqual([]);
			expect(rainVsChirps(s, { ...dq, lowVsChirpsRatio: 0.41 })!.flaggedYears).toEqual([2003]);
			expect(rainVsChirpsCheck(rainVsChirps(s, { ...dq, lowVsChirpsRatio: 0.45 }))!.text).toMatch(/below 45 % of the usual catchment \/ CHIRPS rain ratio \(200 %\)/);
		});

		it("a moving median follows a record whose ratio drifts, where the record-wide median flags a whole era", () => {
			// A new catchment average from 2008/09: the ratio drops from 4 to 1; 2012/13 is zero-filled at 0.4.
			const s = record(16, (wy) => (wy < 2008 ? 4 : wy === 2012 ? 0.4 : 1));
			const whole = rainVsChirps(s)!;
			expect(whole.usualRatio).toBeCloseTo(2.5, 12);
			expect(whole.flaggedYears).toEqual([2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015]); // every year of the new era
			const moving = rainVsChirps(s, { ...dq, lowVsChirpsBaseline: 'moving' })!;
			expect(moving.flaggedYears).toEqual([2012]);
			const y = (wy: number) => moving.years.find((x) => x.waterYear === wy)!;
			expect(y(2012).usualRatio).toBe(1);
			expect(y(2003).usualRatio).toBe(4);
			const c = rainVsChirpsCheck(moving)!;
			expect(c.text).toMatch(/below 50 % of the usual catchment \/ CHIRPS rain ratio of the water years around each \(a moving median over ±5 years; 250 % over the record\)/);
			expect(c.text).toMatch(/2012\/13: \d+ mm vs \d+ mm, 40 %, usual 100 % \(365 days\)/);
			// With too few judged years nearby, a year falls back to the record's usual ratio.
			const short = rainVsChirps(record(6, () => 2), { ...dq, lowVsChirpsBaseline: 'moving' })!;
			expect(short.years.every((x) => x.usualRatio === short.usualRatio)).toBe(true);
		});

		it('a scaled CHIRPS minimum stops judging a year with too little CHIRPS rain for the catchment', () => {
			const s = record(8, (wy) => (wy === 2003 ? 0 : 2));
			// 2003/04: catchment blank from April to August leaves 212 shared days and about 120 mm of CHIRPS on them.
			const d0 = toEpochDay('2000-10-01');
			for (let i = toEpochDay('2004-04-01') - d0; i <= toEpochDay('2004-08-31') - d0; i++) s.rain_catchment_mm.values[i] = null;
			const fixed = rainVsChirps(s)!;
			const y = fixed.years.find((x) => x.waterYear === 2003)!;
			expect(y.days).toBeGreaterThanOrEqual(LOW_VS_CHIRPS_MIN_DAYS);
			expect(y.chirpsMm).toBeGreaterThan(50);
			expect(fixed.minMm).toBe(50);
			expect(fixed.flaggedYears).toEqual([2003]);
			const scaled = rainVsChirps(s, { ...dq, lowVsChirpsMinimum: 'scaled' })!;
			expect(scaled.minMm).toBeGreaterThan(y.chirpsMm);
			expect(scaled.minMm).toBeCloseTo(0.25 * usualAnnualRainMm(s.rain_chirps_mm)!, -1);
			expect(scaled.flaggedYears).toEqual([]);
			// In a dry catchment the 50 mm floor holds.
			const arid = record(8, () => 1);
			arid.rain_chirps_mm.values = arid.rain_chirps_mm.values.map((v) => v! / 10);
			expect(rainVsChirps(arid, { ...dq, lowVsChirpsMinimum: 'scaled' })!.minMm).toBe(50);
		});
	});
});

describe('areaMismatches (engine-review F7)', () => {
	const farm = (id: string, areaKm2: number, hi: number, lo: number, kind: NetworkNode['kind'] = 'farm'): NetworkNode => ({
		id,
		name: id,
		kind,
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2,
		areaHiKm2: hi,
		areaLoKm2: lo,
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
	});

	it('flags a difference over 1 % and passes one under it', () => {
		// 30 vs 30.1 is 0.33 %: fine. 10 vs 10.2 is 1.96 %: flagged. Gauges are ignored.
		const nodes = [farm('ok', 30, 20, 10.1), farm('off', 10, 8, 2.2), farm('g', 5, 0, 1, 'gauge')];
		const m = areaMismatches(nodes, 'area');
		expect(m.map((x) => x.nodeId)).toEqual(['off']);
		expect(m[0]!.difference).toBeCloseTo(0.2 / 10.2, 12);
		expect(areaMismatchWarning(m)).toMatch(/more than 1 % \(off: 10 km² vs 10.2 km²\)/);
		expect(areaMismatchWarning([])).toBeNull();
	});

	it('skips farms without a hi/lo split unless the hi/lo method is used', () => {
		const nodes = [farm('plain', 12, 0, 0), farm('empty', 0, 0, 0)];
		expect(areaMismatches(nodes, 'area')).toEqual([]);
		expect(areaMismatches(nodes, 'manual')).toEqual([]);
		expect(areaMismatches(nodes, 'hiLo').map((x) => x.nodeId)).toEqual(['plain']);
	});
});

describe('quality checks do not depend on the local time zone', () => {
	it('gives identical results at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const v: (number | null)[] = Array.from({ length: 800 }, (_, i) => (i % 3 === 0 ? 1 + (i % 17) : 0));
		v[59] = -1;
		v[400] = 9000;
		const series = {
			rain_catchment_mm: { startDate: '2019-12-31', values: v },
			flow_observed_m3s: { startDate: '2019-09-30', values: new Array(800).fill(1) },
			flow_logger_m3s: { startDate: '2019-09-30', values: new Array(800).fill(2) }
		};
		const both = () => JSON.stringify([seriesChecks(series), observedAgreement(series)]);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = both();
			env.TZ = 'Pacific/Pago_Pago';
			const west = both();
			env.TZ = 'UTC';
			expect(east).toBe(both());
			expect(west).toBe(both());
			expect(east).toContain('"date":"2020-02-28"'); // index 59 from 2019-12-31
		} finally {
			env.TZ = tz;
		}
	});

	it('finds the same zero runs, wet months and low-vs-CHIRPS years at UTC+14 and UTC−11 (issue #2)', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const S = '2010-10-01';
		const chirps = seasonal(S, 6 * 365, WINTER);
		const catchment = [...chirps];
		gap(catchment, S, '2012-04-01', '2012-06-14'); // on a month and water-year edge
		const series = { rain_catchment_mm: { startDate: S, values: catchment }, rain_chirps_mm: { startDate: S, values: chirps } };
		const both = () => JSON.stringify([zeroRainRuns(series.rain_catchment_mm), rainVsChirps(series), seriesChecks(series)]);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = both();
			env.TZ = 'Pacific/Pago_Pago';
			const west = both();
			env.TZ = 'UTC';
			expect(east).toBe(both());
			expect(west).toBe(both());
			expect(east).toContain('"startDate":"2012-04-01","endDate":"2012-06-14","days":75,"wetDays":75');
		} finally {
			env.TZ = tz;
		}
	});
});

// The client catchment regression data, when present: the checks run on a
// real record. Skipped when the gitignored client data is absent. Only
// invariants that hold for any record are asserted (no year, ratio, count or
// pattern), since those would be client data.
type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
const fsSpecifier = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as Fs;
const dataDir = clientCatchmentDirs().find((p) => fs.existsSync(`${p}/project.json`));

describe.skipIf(!dataDir)('series checks on the client catchment (needs data/client-catchment)', () => {
	const load = () => {
		const project = JSON.parse(fs.readFileSync(`${dataDir}/project.json`, 'utf8')) as {
			series: { kind: string; startDate: string; values: (number | null)[] }[];
		};
		return Object.fromEntries(project.series.map((s) => [s.kind, s]));
	};
	const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

	it('observedAgreement: flags exactly the out-of-band years with enough shared days, in order', () => {
		const ag = observedAgreement(load());
		if (!ag) return; // one observed record only: nothing to compare
		expect(ascending(ag.years.map((y) => y.waterYear))).toBe(true);
		expect(ag.flaggedYears).toEqual(ag.years.filter((y) => y.flagged).map((y) => y.waterYear));
		for (const y of ag.years) {
			expect(y.days).toBeGreaterThan(0);
			const outOfBand = y.ratio === null ? y.volumeAMm3 > 0 : y.ratio < ag.minRatio || y.ratio > ag.maxRatio;
			expect(y.flagged, String(y.waterYear)).toBe(y.days >= ag.minDays && outOfBand);
		}
	});

	// Issue #2: zero-filled stretches suppress the CHIRPS fallback.
	it('zeroRainRuns and rainVsChirps: well-formed runs and flags (issue #2)', () => {
		const series = load();
		const z = zeroRainRuns(series.rain_catchment_mm!);
		let prevEnd = '';
		for (const r of z.runs) {
			expect(r.startDate > prevEnd).toBe(true);
			expect(r.endDate >= r.startDate).toBe(true);
			expect(r.wetDays).toBeLessThanOrEqual(r.days);
			prevEnd = r.endDate;
		}
		const rc = rainVsChirps(series);
		if (!rc) return;
		expect(ascending(rc.years.map((y) => y.waterYear))).toBe(true);
		expect(rc.flaggedYears).toEqual(rc.years.filter((y) => y.flagged).map((y) => y.waterYear));
		for (const y of rc.years) if (y.flagged) expect(y.ratio!).toBeLessThan(LOW_VS_CHIRPS_RATIO * rc.usualRatio);
	});
});
