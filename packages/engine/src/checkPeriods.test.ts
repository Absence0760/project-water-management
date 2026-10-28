import { describe, expect, it } from 'vitest';
import { checkItemId, checkPeriods, runCheckPeriods, type CheckPeriod } from './checkPeriods';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearOf } from './calendar';
import { checkSeries, rainVsChirpsCheck, rainVsChirps } from './quality';
import { defaultDataQualitySettings, type DailySeries, type RunSummary } from './project';
import type { DoubleMass } from './doublemass';
import type { FlowDoubleMass } from './plausibility';

const S = '2010-10-01';
const D0 = toEpochDay(S);
const DAYS = 6 * 365;
const WINTER = [4, 5, 6, 7, 8, 9];
const at = (iso: string) => toEpochDay(iso) - D0;

/** Synthetic winter rain: 4–8 mm every day of the wet months (never one value twice running), 2 mm every third day of the others. */
function seasonal(): (number | null)[] {
	return Array.from({ length: DAYS }, (_, i) => (WINTER.includes(monthOfEpochDay(D0 + i)) ? 4 + (i % 5) : i % 3 === 0 ? 2 : 0));
}
function fill(v: (number | null)[], from: string, to: string, x: number | null): void {
	for (let i = at(from); i <= at(to); i++) v[i] = x;
}

/** Rain with 7 flat stretches, 7 outlier periods (one two days long), 2 negative days and a wet-season zero run. */
function rain(): DailySeries {
	const v = seasonal();
	// Flat stretches of 3 mm, 5 days each, in the dry season of each year (and two more in the last).
	const flats = ['2010-11-02', '2011-11-02', '2012-11-02', '2013-11-02', '2014-11-02', '2015-11-02', '2015-12-10'];
	for (const f of flats) fill(v, f, fromEpochDay(toEpochDay(f) + 4), 3);
	// Outliers: far above 5 × the 99th percentile (8 mm; ~1,450 rain days, so seven outliers don't move it).
	for (const d of ['2011-05-04', '2012-08-04', '2013-05-04', '2014-05-04', '2015-05-04', '2016-05-04']) v[at(d)] = 400;
	v[at('2013-07-10')] = 500;
	v[at('2013-07-11')] = 450;
	// Negatives.
	v[at('2012-02-02')] = -1;
	v[at('2014-02-02')] = -999;
	// A 75-day zero run in the wet season, a missing day either side ending it cleanly.
	fill(v, '2012-04-01', '2012-06-14', 0);
	v[at('2012-03-31')] = 5;
	v[at('2012-06-15')] = 5;
	return { startDate: S, values: v };
}

/** Flow at resolution 0.001, with 7 non-zero flat stretches of 20 days, a zero one past the cap, negative placeholders and two outlier periods. */
function flow(): DailySeries {
	const v: (number | null)[] = Array.from({ length: DAYS }, (_, i) => 1 + ((i * 7) % 113) * 0.001);
	for (let k = 0; k < 7; k++) {
		const i = 30 + k * 300;
		for (let j = 0; j < 20; j++) v[i + j] = 2;
	}
	for (let j = 0; j < 95; j++) v[2200 - 200 + j] = 0;
	for (const i of [100, 101, 102, 900]) v[i] = -999;
	v[500] = 50; // l/s loaded as m³/s?
	v[501] = 60;
	v[1500] = 40;
	return { startDate: S, values: v };
}

const by = (xs: CheckPeriod[], check: string) => xs.filter((x) => x.check === check);
const sum = (xs: CheckPeriod[]) => xs.reduce((a, x) => a + x.days, 0);

describe('checkPeriods (issue #611)', () => {
	it('lists every flagged period, not the five checkSeries examples', () => {
		const s = rain();
		const items = checkPeriods('rain-1', 'rain_catchment_mm', s);
		const flat = by(items, 'flatline');
		expect(flat).toHaveLength(7);
		expect(flat.map((x) => [x.start, x.end, x.days])).toContainEqual(['2015-12-10', '2015-12-14', 5]);
		const out = by(items, 'outlier');
		expect(out).toHaveLength(7); // six one-day periods and one of two days
		expect(out.find((x) => x.start === '2013-07-10')).toMatchObject({ end: '2013-07-11', days: 2, params: { max: 500 } });
		expect(by(items, 'negative').map((x) => [x.start, x.params.min, x.treatment])).toEqual([
			['2012-02-02', -1, 'none'],
			['2014-02-02', -999, 'none']
		]);
		expect(by(checkPeriods('unit-gauge', 'rain_catchment_mm', s, undefined, null, { negativeAsMissing: true }), 'negative').map((x) => x.treatment)).toEqual(['missing', 'missing']);
		expect(by(items, 'zerorun')).toEqual([
			expect.objectContaining({ start: '2012-04-01', end: '2012-06-14', days: 75, treatment: 'setAside', severity: 'warning' })
		]);
		// checkSeries holds at most five examples of each.
		const checks = checkSeries('rain_catchment_mm', s);
		expect(checks.find((c) => c.check === 'flatline')!.examples).toHaveLength(5);
		expect(checks.find((c) => c.check === 'outlier')!.examples).toHaveLength(5);
		// In date order.
		expect(items.map((x) => x.start)).toEqual([...items.map((x) => x.start)].sort());
	});

	it('agrees with checkSeries day counts, rain and flow, under the project limits', () => {
		const dq = { ...defaultDataQualitySettings(), flatlineRainDays: 4, outlierFactorFlow: 15 };
		for (const [kind, s] of [
			['rain_catchment_mm', rain()],
			['flow_observed_m3s', flow()]
		] as const) {
			const items = checkPeriods('x', kind, s, dq);
			const checks = checkSeries(kind, s, dq);
			for (const c of checks) expect([kind, c.check, sum(by(items, c.check))]).toEqual([kind, c.check, c.days]);
			expect(new Set(items.map((x) => x.check))).toEqual(new Set(checks.map((c) => c.check)));
		}
	});

	it('gives flow periods their default treatment: negative missing, outlier and non-zero flat left out of the fit, a zero stretch as recorded', () => {
		const items = checkPeriods('flow-1', 'flow_observed_m3s', flow());
		expect(by(items, 'negative').map((x) => [x.start, x.days, x.treatment])).toEqual([
			[fromEpochDay(D0 + 100), 3, 'missing'],
			[fromEpochDay(D0 + 900), 1, 'missing']
		]);
		const flat = by(items, 'flatline');
		expect(flat.filter((x) => x.params.value === 2)).toHaveLength(7);
		expect(flat.filter((x) => x.params.value === 2).every((x) => x.treatment === 'fitExcluded' && x.days === 20)).toBe(true);
		expect(flat.find((x) => x.params.value === 0)).toMatchObject({ days: 95, treatment: 'none' });
		expect(by(items, 'outlier').map((x) => [x.start, x.days, x.params.max, x.treatment])).toEqual([
			[fromEpochDay(D0 + 500), 2, 60, 'fitExcluded'],
			[fromEpochDay(D0 + 1500), 1, 40, 'fitExcluded']
		]);
		expect(by(items, 'zerorun')).toEqual([]); // the catchment rain kind only
	});

	it('keeps ids across a recheck and gives a period that grows a new one', () => {
		const s = rain();
		const a = checkPeriods('rain-1', 'rain_catchment_mm', s);
		const again = checkPeriods('rain-1', 'rain_catchment_mm', { startDate: S, values: [...s.values] });
		expect(again.map((x) => x.id)).toEqual(a.map((x) => x.id));
		expect(a[0]!.id).toBe(checkItemId(a[0]!.check, 'rain-1', a[0]!.start, a[0]!.end));
		expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
		// New data at the end leaves every earlier id alone.
		const longer = checkPeriods('rain-1', 'rain_catchment_mm', { startDate: S, values: [...s.values, 1, 2, 0, 4] });
		expect(longer.map((x) => x.id)).toEqual(expect.arrayContaining(a.filter((x) => x.check !== 'outlier').map((x) => x.id)));
		// A flat stretch one day longer: a new id for it, the others unchanged.
		const v = [...s.values];
		v[at('2013-11-07')] = 3;
		const grown = checkPeriods('rain-1', 'rain_catchment_mm', { startDate: S, values: v });
		const old = 'flatline:rain-1:2013-11-02:2013-11-06';
		expect(a.map((x) => x.id)).toContain(old);
		expect(grown.map((x) => x.id)).not.toContain(old);
		expect(grown.map((x) => x.id)).toContain('flatline:rain-1:2013-11-02:2013-11-07');
		expect(grown.filter((x) => x.check === 'flatline' && x.id !== 'flatline:rain-1:2013-11-02:2013-11-07').map((x) => x.id)).toEqual(
			a.filter((x) => x.check === 'flatline' && x.id !== old).map((x) => x.id)
		);
		// Another series' same period has its own id.
		expect(checkPeriods('rain-2', 'rain_catchment_mm', s)[0]!.id).not.toBe(a[0]!.id);
	});

	it("lists a zero run's CHIRPS verdict, one CHIRPS reads as dry with severity info and kept as recorded", () => {
		const s = rain();
		fill(s.values, '2014-04-01', '2014-06-14', 0);
		s.values[at('2014-03-31')] = 5;
		s.values[at('2014-06-15')] = 5;
		const chirps: DailySeries = { startDate: S, values: seasonal() };
		fill(chirps.values, '2014-04-01', '2014-06-14', 0); // CHIRPS dry there too
		const dq = { ...defaultDataQualitySettings(), zeroRunChirpsCheck: true };
		const z = by(checkPeriods('rain-1', 'rain_catchment_mm', s, dq, chirps), 'zerorun');
		expect(z.map((x) => [x.start, x.params.verdict, x.severity, x.treatment])).toEqual([
			['2012-04-01', 'probablyMissing', 'warning', 'setAside'],
			['2014-04-01', 'maybeDry', 'info', 'none']
		]);
		// checkSeries counts the flagged run only.
		expect(checkSeries('rain_catchment_mm', s, dq, chirps).find((c) => c.check === 'zerorun')!.days).toBe(sum(z.filter((x) => x.severity === 'warning')));
	});

	it('lists each low-vs-CHIRPS water year when asked, and each double-mass break as the segment after it', () => {
		const chirps: DailySeries = { startDate: S, values: seasonal() };
		const c = [...chirps.values];
		for (let i = 0; i < c.length; i++) if (waterYearOf(D0 + i) === 2013 && c[i]) c[i] = c[i]! * 0.2;
		const s: DailySeries = { startDate: S, values: c };
		expect(by(checkPeriods('rain-1', 'rain_catchment_mm', s, undefined, chirps), 'lowvschirps')).toEqual([]);
		const low = by(checkPeriods('rain-1', 'rain_catchment_mm', s, undefined, chirps, { lowVsChirps: true }), 'lowvschirps');
		expect(low.map((x) => [x.id, x.treatment])).toEqual([['lowvschirps:rain-1:2013-10-01:2014-09-30', 'none']]);
		const check = rainVsChirpsCheck(rainVsChirps({ rain_catchment_mm: s, rain_chirps_mm: chirps }))!;
		expect(sum(low)).toBe(check.days);
		expect(low[0]!.params.ratio).toBeCloseTo(0.2, 6);

		const dm = {
			years: [],
			skippedYears: [],
			wholeSlope: 1,
			segments: [
				{ fromWaterYear: 1990, toWaterYear: 1999, years: 10, days: 3600, slope: 1 },
				{ fromWaterYear: 2000, toWaterYear: 2004, years: 5, days: 1800, slope: 0.7 },
				{ fromWaterYear: 2005, toWaterYear: 2012, years: 8, days: 2900, slope: 1.1 }
			],
			breaks: [
				{ afterWaterYear: 1999, slopeBefore: 1, slopeAfter: 0.7, change: -0.3, pettittP: 0.01, bicGain: 9 },
				{ afterWaterYear: 2004, slopeBefore: 0.7, slopeAfter: 1.1, change: 0.57, pettittP: 0.02, bicGain: 7 }
			]
		} satisfies DoubleMass;
		const breaks = by(checkPeriods('rain-1', 'rain_catchment_mm', { startDate: S, values: [] }, undefined, null, { doubleMass: dm }), 'doublemass');
		expect(breaks.map((x) => [x.start, x.end, x.days, x.params.change])).toEqual([
			['2000-10-01', '2005-09-30', 1800, -0.3],
			['2005-10-01', '2013-09-30', 2900, 0.57]
		]);
	});

	it('gives identical items at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const chirps: DailySeries = { startDate: S, values: seasonal() };
		const all = () =>
			JSON.stringify([
				checkPeriods('rain-1', 'rain_catchment_mm', rain(), { ...defaultDataQualitySettings(), zeroRunChirpsCheck: true }, chirps, { lowVsChirps: true }),
				checkPeriods('flow-1', 'flow_observed_m3s', flow())
			]);
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = all();
			env.TZ = 'Pacific/Pago_Pago';
			const west = all();
			env.TZ = 'UTC';
			expect(east).toBe(all());
			expect(west).toBe(all());
			expect(east).toContain('"id":"zerorun:rain-1:2012-04-01:2012-06-14"');
			expect(east).toContain('"id":"negative:rain-1:2012-02-02:2012-02-02"');
		} finally {
			env.TZ = tz;
		}
	});
});

describe('runCheckPeriods (issue #611)', () => {
	const window = (start: string, end: string, status: string) => ({
		start,
		end,
		source: 'detected',
		reason: null,
		status,
		keptReason: null,
		totalMm: 60,
		readingMm: 60,
		runDays: 4,
		nearChirpsMm: 30,
		runChirpsMm: 40,
		chirpsMm: 40,
		outageDays: null,
		daysInRun: 5,
		usedMm: 60
	});
	const fdm = {
		flowKind: 'flow_logger_m3s',
		years: [],
		skippedYears: [],
		wholeSlope: 0.1,
		segments: [
			{ fromWaterYear: 2000, toWaterYear: 2007, years: 8, days: 2900, slope: 0.12 },
			{ fromWaterYear: 2008, toWaterYear: 2015, years: 8, days: 2850, slope: 0.08 }
		],
		breaks: [
			{
				afterWaterYear: 2007,
				slopeBefore: 0.12,
				slopeAfter: 0.08,
				change: -1 / 3,
				pettittP: 0.01,
				bicGain: 8,
				simulatedSlopeBefore: 0.11,
				simulatedSlopeAfter: 0.11,
				unexplained: -1 / 3,
				unexplainedDry: -0.5,
				unexplainedWet: -0.2,
				hint: 'newUse'
			}
		]
	} satisfies FlowDoubleMass;
	const summary = {
		rainAccumulation: { windows: [window('2012-01-01', '2012-01-05', 'spread'), window('2011-03-01', '2011-03-03', 'kept'), window('2013-02-01', '2013-02-04', 'setAside')] },
		plausibility: { flowDoubleMass: fdm }
	} as unknown as Pick<RunSummary, 'rainAccumulation' | 'plausibility'>;
	const ids = (k: string) => ({ rain_catchment_mm: 'rain-1', flow_logger_m3s: 'logger-1' })[k] ?? null;

	it("lists the run's accumulation windows with what it did, and the flow double-mass breaks on the scored record", () => {
		const items = runCheckPeriods(summary, ids);
		expect(items.map((x) => [x.id, x.days, x.treatment])).toEqual([
			['flowdoublemass:logger-1:2008-10-01:2016-09-30', 2850, 'none'],
			['accumulation:rain-1:2011-03-01:2011-03-03', 3, 'none'],
			['accumulation:rain-1:2012-01-01:2012-01-05', 5, 'spread'],
			['accumulation:rain-1:2013-02-01:2013-02-04', 4, 'setAside']
		]);
		expect(items[0]!.params).toMatchObject({ afterWaterYear: 2007, change: -1 / 3, hint: 'newUse' });
		expect(items[0]!.seriesKind).toBe('flow_logger_m3s');
		expect(items[2]!.params).toMatchObject({ status: 'spread', totalMm: 60, source: 'detected' });
	});

	it('names no series it is not given, and copes with an older run', () => {
		expect(runCheckPeriods(summary, () => null)).toEqual([]);
		expect(runCheckPeriods(summary, (k) => (k === 'flow_observed_m3s' ? 'gauge-1' : null))).toEqual([]);
		expect(runCheckPeriods({} as Pick<RunSummary, 'rainAccumulation' | 'plausibility'>, ids)).toEqual([]);
		expect(runCheckPeriods(null, ids)).toEqual([]);
	});
});
