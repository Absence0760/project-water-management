import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { RAIN_SOURCE_CODE } from '../rainSourcePeriods';
import {
	censoredObserved,
	dayQuality,
	defaultQualityFlags,
	FLOW_DAY_FLAGS,
	FLOW_FLAG_CODE,
	flaggedDayMask,
	flowDayFlags,
	qualityFlagChanges,
	rainDayFlags,
	ratingError,
	ratingText,
	resolveQualityFlags,
	scoringDays,
	type QualityFlagSettings
} from './dayFlags';

const start = '2000-10-01';
const d0 = toEpochDay(start);
const code = (f: (typeof FLOW_DAY_FLAGS)[number]) => FLOW_FLAG_CODE[f];
const names = (flags: Uint8Array) => Array.from(flags, (c) => FLOW_DAY_FLAGS[c]);

/** A flow record that varies day to day (no flat stretch, no outlier), m³/s. */
const varying = (n: number) => Array.from({ length: n }, (_, i) => 1 + 0.37 * Math.sin(i) + i / 1000);

describe('flowDayFlags (CR-18)', () => {
	it('classes each day: missing, suspect, above and below the gauged range, in range', () => {
		const values: (number | null)[] = varying(200);
		values[3] = null;
		values[4] = Number.NaN;
		values[5] = -999; // a "no reading" placeholder, as alignFlow reads it
		values[10] = 5; // above the highest gauging
		values[11] = 0.2; // below the lowest gauging
		values[12] = 0; // zero flow: a dry weir reads it reliably, never "below the rating"
		values[150] = 500; // > 10 × the 99th percentile: an outlier
		const flags = flowDayFlags({ kind: 'flow_observed_m3s', series: { startDate: start, values }, start: d0, days: 200, rating: { gaugedMaxM3s: 4, gaugedMinM3s: 0.5, source: 'rating table' } });
		const got = names(flags);
		expect(got.slice(3, 6)).toEqual(['missing', 'missing', 'missing']);
		expect(got[10]).toBe('aboveRating');
		expect(got[11]).toBe('belowRating');
		expect(got[12]).toBe('inRange');
		// Suspect wins over above-rating: the check says the value itself is doubtful.
		expect(got[150]).toBe('suspect');
		expect(got.filter((f) => f === 'inRange').length).toBe(200 - 6);
	});

	it('marks a flat stretch suspect by the same rule as the Data checks', () => {
		const values: (number | null)[] = varying(100);
		for (let i = 20; i < 40; i++) values[i] = 1.234; // 20 days of one non-zero value (the floor is 14)
		const got = names(flowDayFlags({ kind: 'flow_logger_m3s', series: { startDate: start, values }, start: d0, days: 100 }));
		expect(got.slice(20, 40).every((f) => f === 'suspect')).toBe(true);
		expect(got[19]).toBe('inRange');
		expect(got[40]).toBe('inRange');
	});

	it('with no rating recorded, nothing is flagged as extrapolated (positive control: the same record with one is)', () => {
		const values = varying(60).map((v, i) => (i === 7 ? 50 : v));
		const series = { startDate: start, values };
		expect(names(flowDayFlags({ kind: 'flow_observed_m3s', series, start: d0, days: 60 }))[7]).toBe('inRange');
		expect(names(flowDayFlags({ kind: 'flow_observed_m3s', series, start: d0, days: 60, rating: { gaugedMaxM3s: 10, gaugedMinM3s: null, source: 's' } }))[7]).toBe('aboveRating');
	});

	it('an infilled day wins over every class but missing', () => {
		const values: (number | null)[] = varying(60);
		values[5] = 50;
		values[6] = null;
		const infilled = new Uint8Array(60);
		infilled[5] = 1;
		infilled[6] = 1;
		const got = names(flowDayFlags({ kind: 'flow_observed_m3s', series: { startDate: start, values }, start: d0, days: 60, rating: { gaugedMaxM3s: 10, gaugedMinM3s: null, source: 's' }, infilled }));
		expect(got[5]).toBe('infilled');
		expect(got[6]).toBe('missing');
	});

	it('aligns a record that starts before or after the run, and marks days it doesn’t cover missing', () => {
		const values = varying(30);
		const flags = flowDayFlags({ kind: 'flow_observed_m3s', series: { startDate: '2000-09-21', values }, start: d0, days: 40 });
		// The record's day 10 is the run's day 0; it ends on run day 19.
		expect(names(flags).slice(0, 20).every((f) => f === 'inRange')).toBe(true);
		expect(names(flags).slice(20).every((f) => f === 'missing')).toBe(true);
		expect(names(flowDayFlags({ kind: 'flow_observed_m3s', series: undefined, start: d0, days: 3 }))).toEqual(['missing', 'missing', 'missing']);
	});

	it('flaggedDayMask marks extrapolated, suspect and infilled days, never missing or in-range ones', () => {
		const flags = Uint8Array.from(FLOW_DAY_FLAGS.map((f) => code(f)));
		expect(Array.from(flaggedDayMask(flags))).toEqual(FLOW_DAY_FLAGS.map((f) => (['aboveRating', 'belowRating', 'suspect', 'infilled'].includes(f) ? 1 : 0)));
	});
});

describe('resolveQualityFlags and ratingError', () => {
	it('defaults: censor above the rating, leave the other flagged classes out, no rating', () => {
		expect(resolveQualityFlags(undefined)).toEqual({ ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' });
		expect(resolveQualityFlags(undefined)).toEqual(defaultQualityFlags());
	});

	it('an invalid field falls back to its default with a warning; a valid one is kept', () => {
		const warnings: string[] = [];
		const q = resolveQualityFlags({ aboveRating: 'drop', suspect: 'include', ratings: { flow_observed_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: 0.1, source: ' DWS gaugings ' } } }, warnings);
		expect(q.aboveRating).toBe('censor');
		expect(q.suspect).toBe('include');
		expect(q.ratings.flow_observed_m3s).toEqual({ gaugedMaxM3s: 12, gaugedMinM3s: 0.1, source: 'DWS gaugings' });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/aboveRating/);
	});

	it('drops an invalid rating with a warning, and ignores a kind that can’t be calibrated against', () => {
		const warnings: string[] = [];
		const q = resolveQualityFlags({ ratings: { flow_logger_m3s: { gaugedMaxM3s: 1, gaugedMinM3s: 2, source: 's' }, flow_reference_m3s: { gaugedMaxM3s: 1, gaugedMinM3s: null, source: 's' } } }, warnings);
		expect(q.ratings).toEqual({});
		expect(warnings).toEqual([expect.stringMatching(/flow_logger_m3s rating the lowest gauging must be below the highest/)]);
	});

	it('ratingError: numbers ≥ 0 or empty, highest above 0 and above the lowest, and a source once a bound is set', () => {
		expect(ratingError({ gaugedMaxM3s: null, gaugedMinM3s: null, source: '' })).toBeNull();
		expect(ratingError({ gaugedMaxM3s: 10, gaugedMinM3s: null, source: 'table' })).toBeNull();
		expect(ratingError({ gaugedMaxM3s: 10, gaugedMinM3s: null, source: ' ' })).toMatch(/source/);
		expect(ratingError({ gaugedMaxM3s: 0, gaugedMinM3s: null, source: 's' })).toMatch(/above 0/);
		expect(ratingError({ gaugedMaxM3s: -1, gaugedMinM3s: null, source: 's' })).toMatch(/≥ 0/);
		expect(ratingError({ gaugedMaxM3s: 2, gaugedMinM3s: 2, source: 's' })).toMatch(/below the highest/);
		expect(ratingError({ gaugedMaxM3s: 2, gaugedMinM3s: null, source: 'x'.repeat(201) })).toMatch(/at most 200/);
		expect(ratingError('12')).toMatch(/not a rating/);
	});
});

describe('scoringDays and censoredObserved (CR-19)', () => {
	const flags = Uint8Array.from([code('inRange'), code('aboveRating'), code('belowRating'), code('suspect'), code('infilled'), code('missing'), code('humanUse')]);
	const all = [0, 1, 2, 3, 4, 5, 6];
	const rating = { gaugedMaxM3s: 2, gaugedMinM3s: 0.1, source: 's' };
	const q = (over: Partial<QualityFlagSettings> = {}): QualityFlagSettings => ({ ...defaultQualityFlags(), ...over });

	it('by default scores in-range and human-use days, censors above-rating ones and leaves the rest out', () => {
		const s = scoringDays(all, flags, q(), rating, 7);
		expect(Array.from(s.idx)).toEqual([0, 1, 6]);
		expect(s.censor![1]).toBe(2 * 86_400);
		expect(Number.isNaN(s.censor![0]!)).toBe(true);
	});

	it('"include" scores a class as recorded; missing days are never scored', () => {
		const s = scoringDays(all, flags, q({ aboveRating: 'include', belowRating: 'include', suspect: 'include', infilled: 'include' }), rating, 7);
		expect(Array.from(s.idx)).toEqual([0, 1, 2, 3, 4, 6]);
		expect(s.censor).toBeNull();
	});

	it('"exclude" leaves above-rating days out, with nothing censored', () => {
		const s = scoringDays(all, flags, q({ aboveRating: 'exclude' }), rating, 7);
		expect(Array.from(s.idx)).toEqual([0, 6]);
		expect(s.censor).toBeNull();
	});

	it('a censored day reads the simulation once it reaches the highest gauging, else the highest gauging', () => {
		const censor = Float64Array.from([NaN, 100, 100]);
		const obs = Float64Array.from([10, 500, 500]);
		expect(Array.from(censoredObserved(obs, [9, 150, 40], [0, 1, 2], censor))).toEqual([10, 150, 100]);
		// Only the scored positions change; the input is not modified.
		expect(Array.from(censoredObserved(obs, [9, 150, 40], [0], censor))).toEqual([10, 500, 500]);
		expect(Array.from(obs)).toEqual([10, 500, 500]);
		expect(censoredObserved(obs, [0, 0, 0], [0, 1, 2], null)).toBe(obs);
	});
});

describe('rainDayFlags', () => {
	it('observed where the catchment gauge reads, infilled where another source stands in, missing where nothing does', () => {
		expect(Array.from(rainDayFlags([1, null, null, 0], [1, 2.5, null, 0]))).toEqual([0, 1, 2, 0]);
	});

	it('a rain-source period’s replaced days are infilled even though the catchment column holds their value', () => {
		const src = [RAIN_SOURCE_CODE.catchment, RAIN_SOURCE_CODE.series, RAIN_SOURCE_CODE.chirps];
		expect(Array.from(rainDayFlags([1, 2, null], [1, 2, 3], src))).toEqual([0, 1, 1]);
	});
});

describe('dayQuality (CR-22)', () => {
	const settings = defaultQualityFlags();
	const base = (over: Partial<Parameters<typeof dayQuality>[0]> = {}) => {
		const flags = Uint8Array.from([code('inRange'), code('inRange'), code('suspect'), code('suspect'), code('missing'), code('inRange')]);
		const observed = Float64Array.from([5, 6, 0, 3, NaN, 7]);
		const windowIdx = [0, 1, 2, 3, 4, 5];
		return dayQuality({ flowKind: 'flow_observed_m3s', settings, windowIdx, flags, scoring: scoringDays(windowIdx, flags, settings, null, 6), observed, rainFlags: null, zeroRunMask: null, ...over });
	};

	it('counts days by class, scored and left out, and suspect zero flow', () => {
		const q = base();
		expect(q.windowDays).toBe(6);
		expect(q.flow).toEqual({ inRange: 3, humanUse: 0, belowRating: 0, aboveRating: 0, suspect: 2, infilled: 0, missing: 1 });
		expect(q.scoredDays).toBe(3);
		expect(q.leftOutDays).toBe(2);
		expect(q.censoredDays).toBe(0);
		expect(q.suspectZeroDays).toBe(1);
		expect(q.rain).toBeNull();
		expect(q.use).toEqual({ aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' });
	});

	it('says what the record can’t support: no rating, suspect days left out, zero flow among them, and a large share left out', () => {
		const notes = base().notes.join('\n');
		expect(notes).toMatch(/No highest gauging is recorded for the gauge record/);
		expect(notes).toMatch(/2 days flagged suspect .* are left out/);
		expect(notes).toMatch(/1 of the suspect days is zero flow/);
		expect(notes).toMatch(/leave out 40 % of the observed days/);
	});

	it('counts the scored days’ rain and calls out heavy infilling and zero runs set aside', () => {
		const rainFlags = Uint8Array.from([0, 1, 0, 0, 2, 1]);
		const zeroRunMask = Uint8Array.from([0, 1, 0, 0, 0, 0]);
		const q = base({ rainFlags, zeroRunMask });
		// Scored days are 0, 1 and 5.
		expect(q.rain).toEqual({ observed: 1, infilled: 2, missing: 0, zeroRunDays: 1 });
		expect(q.notes.join('\n')).toMatch(/On 67 % of the scored days the rain is filled/);
		expect(q.notes.join('\n')).toMatch(/Of the scored days, 1 day falls in zero-rain runs/);
	});

	it('names the censoring bound when above-rating days are censored', () => {
		const s: QualityFlagSettings = { ...settings, ratings: { flow_observed_m3s: { gaugedMaxM3s: 4, gaugedMinM3s: null, source: 'table' } } };
		const flags = Uint8Array.from([code('inRange'), code('aboveRating')]);
		const q = dayQuality({ flowKind: 'flow_observed_m3s', settings: s, windowIdx: [0, 1], flags, scoring: scoringDays([0, 1], flags, s, s.ratings.flow_observed_m3s!, 2), observed: Float64Array.from([1, 9]), rainFlags: null, zeroRunMask: null });
		expect(q.censoredDays).toBe(1);
		expect(q.rating).toEqual(s.ratings.flow_observed_m3s);
		expect(q.notes).toEqual([expect.stringMatching(/^1 day read above the highest gauging \(4 m³\/s\)\. The fit only asks the model to reach 4 m³\/s/)]);
	});
});

describe('qualityFlagChanges and ratingText', () => {
	it('lists a gauged range and a treatment that changed, and nothing when they are the same', () => {
		const a = defaultQualityFlags();
		const b: QualityFlagSettings = { ...a, suspect: 'include', ratings: { flow_logger_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: 0.05, source: 's' } } };
		expect(qualityFlagChanges(a, a)).toEqual([]);
		expect(qualityFlagChanges(a, b)).toEqual([
			{ subject: 'Gauged range (logger record)', text: 'Gauged range (logger record): none → 0.05–12 m³/s' },
			{ subject: 'Suspect days in the fit', text: 'Suspect days in the fit: left out → scored as recorded' }
		]);
	});

	it('ratingText', () => {
		expect(ratingText(null)).toBe('none');
		expect(ratingText({ gaugedMaxM3s: 12, gaugedMinM3s: null, source: '' })).toBe('up to 12 m³/s');
		expect(ratingText({ gaugedMaxM3s: null, gaugedMinM3s: 0.05, source: '' })).toBe('from 0.05 m³/s');
	});
});
