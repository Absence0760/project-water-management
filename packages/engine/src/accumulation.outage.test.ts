// Blank days and logger outages in the accumulation check (engine ≥ 1.70.0,
// Q31 in issue #90, issue #393, docs/model.md §2.4d). A stretch of up to
// ACC_MAX_BLANK_DAYS blank days counts towards a run like zeros; a longer one
// is an outage that ends the run. A ≥ 20 mm reading straight after an outage
// that passes the CHIRPS tests over it is set aside as missing. Expected
// values are worked by hand from §2.4d; synthetic fixtures only.
import { describe, expect, it } from 'vitest';
import {
	ACC_MAX_BLANK_DAYS,
	ACC_MAX_RUN_DAYS,
	ACC_MIN_MM,
	ACC_MIN_RUN_DAYS,
	ACC_READING_DAY_SHARE,
	ACC_RUN_SHARE,
	ACCUMULATION_CRITERIA,
	accumulationWarnings,
	applyAccumulations,
	detectAccumulations,
	finishSetAside,
	fitExcludedWindows,
	rainAccumulations,
	spreadAccumulations,
	type AccumulationCandidate
} from './accumulation';
import { fromEpochDay, toEpochDay } from './calendar';
import { defaultZeroRainSettings, type DailySeries, type SeriesKind, type ZeroRainSettings } from './project';
import { Rng } from './random';

type V = number | null;
const S = '2001-06-01';
const s0 = toEpochDay(S);
const ds = (values: V[]): DailySeries => ({ startDate: S, values });
const one = () => 1;
const zr = (over: Partial<ZeroRainSettings> = {}): ZeroRainSettings => ({ ...defaultZeroRainSettings(), ...over });
const B = null;
const rep = (n: number, v: V): V[] => new Array<V>(n).fill(v);
const day = (i: number) => s0 + i;
const iso = (i: number) => fromEpochDay(day(i));

/**
 * A record: a 5 mm reading, then `gap` (zeros and blanks), then a reading of
 * `reading` mm, then a 5 mm day. CHIRPS: `wet` mm on every gap day but the
 * last, 0 on the day before the reading, the reading day and the day after,
 * 5 mm on the bounding days. Returns the reading's index.
 */
function rec(gap: V[], reading = 60, wet = 4) {
	const c: V[] = [5, ...gap, reading, 5];
	const h: V[] = [5, ...gap.map(() => wet), 0, 0];
	const r = gap.length + 1;
	h[r - 1] = 0;
	return { c, h, r };
}
const detect = (c: V[], h: V[], factor: (d: number) => number = one) => detectAccumulations(ds(c), ds(h), factor);

describe('blank stretches in the run (ACC_MAX_BLANK_DAYS)', () => {
	it('is 7 days, and the run criteria report it', () => {
		expect(ACC_MAX_BLANK_DAYS).toBe(7);
		expect(ACCUMULATION_CRITERIA.maxBlankDays).toBe(7);
	});

	it('exactly 7 blank days count: the window is the 7 days and the reading day', () => {
		// CHIRPS over the run, the day before left out: 6 × 10 = 60 mm ≥ 30 mm.
		const { c, h, r } = rec(rep(7, B), 60, 10);
		expect(detect(c, h)).toEqual([{ from: day(1), to: day(r), readingMm: 60, runDays: 7, nearChirpsMm: 0, runChirpsMm: 60 }]);
	});

	it('8 blank days break the run: no window, and the reading is an outage candidate on its own day', () => {
		const { c, h, r } = rec(rep(8, B), 60, 10);
		// CHIRPS over the outage's 8 days, the day before left out: 7 × 10 = 70 ≥ 30.
		expect(detect(c, h)).toEqual([{ from: day(r), to: day(r), readingMm: 60, runDays: 8, nearChirpsMm: 0, runChirpsMm: 70, outageDays: 8 }]);
	});

	it('blanks and zeros mixed, in different orders, each blank stretch ≤ 7: the whole mix is the run', () => {
		for (const gap of [
			[...rep(5, 0), ...rep(7, B)],
			[...rep(7, B), ...rep(5, 0)],
			[...rep(4, B), 0, ...rep(4, B), 0, 0, 0],
			[0, B, 0, B, B, 0, ...rep(7, B), 0]
		]) {
			const { c, h, r } = rec(gap, 60, 10);
			expect(detect(c, h)).toMatchObject([{ from: day(1), to: day(r), runDays: gap.length }]);
			expect(detect(c, h)[0]!.outageDays).toBeUndefined();
		}
	});

	it('NaN counts as blank, and two short stretches split by a zero are two stretches (4 + 4 ≠ 8)', () => {
		const gap = [...rep(4, Number.NaN), 0, ...rep(4, B)];
		const { c, h, r } = rec(gap, 60, 10);
		expect(detect(c, h)).toMatchObject([{ from: day(1), to: day(r), runDays: 9 }]);
		const nan8 = rec(rep(8, Number.NaN), 60, 10);
		expect(detect(nan8.c, nan8.h)).toMatchObject([{ outageDays: 8 }]);
	});

	it('zeros before an outage are cut off: zeros, 8 blanks, reading is an outage reading, not a window over the zeros', () => {
		const { c, h, r } = rec([...rep(5, 0), ...rep(8, B)], 60, 10);
		expect(detect(c, h)).toMatchObject([{ from: day(r), to: day(r), outageDays: 8, runDays: 8 }]);
	});

	it('a long outage before the reading with fewer than 3 days after it: no window, no candidate; the reading stays on its day', () => {
		for (const after of [[], [0], [0, 0], [0, B], [B, 0]] as V[][]) {
			const gap = [...rep(20, B), ...after];
			const { c, h } = rec(gap, 60, 10);
			// With nothing after it, it is an outage reading (checked below); with 1–2 days after, nothing at all.
			const found = detect(c, h);
			if (after.length === 0) expect(found).toMatchObject([{ outageDays: 20 }]);
			else expect(found).toEqual([]);
		}
		// Blank days straight after the outage are the outage: 20 + 2 blanks is a 22-day outage.
		const merged = rec([...rep(20, B), B, B], 60, 10);
		expect(detect(merged.c, merged.h)).toMatchObject([{ outageDays: 22 }]);
	});

	it('a long outage before the reading with ≥ 3 days after it: the window is only those days and the reading day', () => {
		const { c, h } = rec([...rep(20, B), 0, B, 0], 60, 10);
		// The run's days are r-3 … r-1; CHIRPS on r-3 and r-2 (the day before left out) = 20 mm ≥ 30? No: 20 < 30.
		expect(detect(c, h)).toEqual([]);
		const big = rec([...rep(20, B), 0, B, 0], 30, 10); // 20 ≥ 15
		expect(detect(big.c, big.h)).toEqual([{ from: day(big.r - 3), to: day(big.r), readingMm: 30, runDays: 3, nearChirpsMm: 0, runChirpsMm: 20 }]);
	});

	it('CHIRPS rain in or before the outage does not count towards a window after it', () => {
		// 20 blank days that CHIRPS rains 50 mm a day on, then 3 zeros it is dry on: no window (0 < 15).
		const { c, h, r } = rec([...rep(20, B), 0, 0, 0], 30, 50);
		h[r - 3] = 0;
		h[r - 2] = 0;
		expect(detect(c, h)).toEqual([]);
	});

	it('a long outage in the middle of a zero run: the window is the zeros after it', () => {
		const { c, h, r } = rec([...rep(40, 0), ...rep(10, B), ...rep(20, 0)], 60, 10);
		expect(detect(c, h)).toEqual([{ from: day(r - 20), to: day(r), readingMm: 60, runDays: 20, nearChirpsMm: 0, runChirpsMm: 190 }]);
	});

	it(`the ${ACC_MAX_RUN_DAYS}-day cap never reaches back into an outage: 10 blanks then 88 zeros is an 88-day window`, () => {
		const { c, h, r } = rec([...rep(10, B), ...rep(88, 0)], 60, 1);
		const [w] = detect(c, h);
		expect(w).toMatchObject({ to: day(r), runDays: 88 });
		expect(w!.to - w!.from).toBe(88);
	});

	it('an outage at the start of the record: blanks before the first reading count the same way', () => {
		// 5 blanks then a reading: a 5-day window (the record's start ends the run).
		const short = detect([...rep(5, B), 60, 5], [10, 10, 10, 10, 0, 0, 0]);
		expect(short).toEqual([{ from: day(0), to: day(5), readingMm: 60, runDays: 5, nearChirpsMm: 0, runChirpsMm: 40 }]);
		// 10 blanks then 4 zeros: the window is the zeros.
		const after = detect([...rep(10, B), 0, 0, 0, 0, 60, 5], [...rep(13, 10), 0, 0, 0]);
		expect(after).toMatchObject([{ from: day(10), to: day(14), runDays: 4 }]);
		// 10 blanks then the reading: an outage reading.
		expect(detect([...rep(10, B), 60, 5], [...rep(9, 10), 0, 0, 0])).toMatchObject([{ from: day(10), to: day(10), outageDays: 10 }]);
	});
});

describe('an outage reading must pass the same tests as a window (§2.4d table)', () => {
	const base = () => rec(rep(30, B), 60, 4); // CHIRPS over the outage, day before left out: 29 × 4 = 116 mm
	it('found with the outage-length figures', () => {
		const { c, h, r } = base();
		expect(detect(c, h)).toEqual([{ from: day(r), to: day(r), readingMm: 60, runDays: 30, nearChirpsMm: 0, runChirpsMm: 116, outageDays: 30 }]);
	});

	it(`not below ${ACC_MIN_MM} mm, not when CHIRPS rained on the day (±1), not when CHIRPS was dry over the outage, not without CHIRPS on the day`, () => {
		const small = rec(rep(30, B), 19.99, 4);
		expect(detect(small.c, small.h)).toEqual([]);
		for (const k of [-1, 0, 1]) {
			const { c, h, r } = base();
			h[r + k] = ACC_READING_DAY_SHARE * 60; // exactly a quarter: not "under" it
			expect(detect(c, h)).toEqual([]);
		}
		const dry = rec(rep(30, B), 60, 0);
		dry.h[5] = ACC_RUN_SHARE * 60 - 0.01;
		expect(detect(dry.c, dry.h)).toEqual([]);
		dry.h[5] = ACC_RUN_SHARE * 60;
		expect(detect(dry.c, dry.h)).toHaveLength(1);
		const { c, h, r } = base();
		h[r] = null;
		expect(detect(c, h)).toEqual([]);
	});

	it(`reads CHIRPS over the outage's last ${ACC_MAX_RUN_DAYS} days only (rain early in a 200-day outage doesn't count)`, () => {
		const { c, h, r } = rec(rep(200, B), 60, 0);
		for (let i = 1; i <= 20; i++) h[i] = 5; // 100 mm, more than 92 days before the reading
		expect(detect(c, h)).toEqual([]);
		h[r - 50] = 30; // 30 mm inside the last 92 days: half of 60
		expect(detect(c, h)).toMatchObject([{ outageDays: 200, runChirpsMm: 30 }]);
	});

	it('judges CHIRPS × the factor, as a window does', () => {
		const { c, h } = rec(rep(30, B), 60, 1); // 29 mm raw < 30
		expect(detect(c, h)).toEqual([]);
		expect(detect(c, h, () => 2)).toMatchObject([{ runChirpsMm: 58 }]);
	});
});

describe('what a run does with an outage reading (rainAccumulations, spread, apply)', () => {
	const outage = () => {
		const { c, h, r } = rec(rep(30, B), 60, 4);
		return { series: { rain_catchment_mm: ds(c), rain_chirps_mm: ds(h) } as Partial<Record<SeriesKind, DailySeries>>, c, h, r };
	};

	it("mode 'spread': set aside on its own day, out of the fit, not spread, and blanked in the run", () => {
		const { series, r } = outage();
		const acc = rainAccumulations(series, zr(), 'monthly')!;
		expect(acc.windows).toEqual([
			{
				start: iso(r),
				end: iso(r),
				from: day(r),
				to: day(r),
				source: 'detected',
				reason: null,
				status: 'setAside',
				keptReason: null,
				totalMm: 60,
				readingMm: 60,
				runDays: 30,
				nearChirpsMm: 0,
				runChirpsMm: 116,
				chirpsMm: null,
				outageDays: 30
			}
		]);
		expect(fitExcludedWindows(acc)).toEqual([acc.windows[0]]);
		spreadAccumulations(acc, series.rain_chirps_mm, null);
		expect(acc.values.size).toBe(0);
		expect(acc.windows[0]!.status).toBe('setAside');
		const catchment = series.rain_catchment_mm!.values.slice();
		const run = applyAccumulations(acc, catchment, s0);
		expect(catchment[r]).toBeNull();
		// Only the reading day changed.
		catchment[r] = 60;
		expect(catchment).toEqual(series.rain_catchment_mm!.values);
		expect(Array.from(run.mask).every((m) => m === 0)).toBe(true);
		expect(run.info).toMatchObject({ spreadWindows: 0, spreadDays: 0, spreadMm: 0 });
		expect(run.info.windows[0]).toMatchObject({ status: 'setAside', daysInRun: 1, usedMm: 0, outageDays: 30 });
		finishSetAside(run, s0, (t) => (t === r ? 1.25 : null));
		expect(run.info.windows[0]!.usedMm).toBe(1.25);
		finishSetAside(run, s0, () => null);
		expect(run.info.windows[0]!.usedMm).toBe(0);
		const warn = accumulationWarnings(run.info);
		expect(warn).toHaveLength(1);
		expect(warn[0]).toMatch(/^1 catchment reading after an outage set aside as missing: /);
		expect(warn[0]).toContain(`${iso(r)} (60 mm read after a 30-day outage; 0 mm used instead)`);
		expect(warn[0]).toContain('keeps a reading as recorded');
	});

	it("a window outside the run is ignored by apply; one inside a run that starts on it is blanked", () => {
		const { series, r } = outage();
		const acc = rainAccumulations(series, zr(), 'monthly')!;
		const tail = series.rain_catchment_mm!.values.slice(r);
		const run = applyAccumulations(acc, tail, day(r));
		expect(tail[0]).toBeNull();
		expect(run.info.windows).toHaveLength(1);
		const before = series.rain_catchment_mm!.values.slice(0, r);
		expect(applyAccumulations(acc, before, s0).info.windows).toEqual([]);
		expect(before).toEqual(series.rain_catchment_mm!.values.slice(0, r));
	});

	it("mode 'asRecorded' leaves it on its day (still out of the fit); keepReadings keeps it in the fit", () => {
		const { series, r } = outage();
		const rec2 = rainAccumulations(series, zr({ accumulationMode: 'asRecorded' }), 'monthly')!;
		expect(rec2.windows.map((w) => [w.status, w.outageDays])).toEqual([['asRecorded', 30]]);
		expect(fitExcludedWindows(rec2)).toHaveLength(1);
		const c = series.rain_catchment_mm!.values.slice();
		applyAccumulations(rec2, c, s0);
		expect(c[r]).toBe(60);
		const kept = rainAccumulations(series, zr({ keepReadings: [{ start: iso(r), end: iso(r), reason: 'logger back, storm seen' }] }), 'monthly')!;
		expect(kept.windows.map((w) => [w.status, w.keptReason])).toEqual([['kept', 'logger back, storm seen']]);
		expect(fitExcludedWindows(kept)).toEqual([]);
	});

	it('a listed window over the outage and the reading wins: the 60 mm is spread over the listed days by CHIRPS and adds up to 60', () => {
		const { series, h, r } = outage();
		const listed = { start: iso(r - 14), end: iso(r), reason: 'observer away two weeks, station log' };
		const acc = rainAccumulations(series, zr({ addAccumulations: [listed] }), 'monthly')!;
		expect(acc.windows.map((w) => [w.source, w.status])).toEqual([['listed', 'spread']]);
		spreadAccumulations(acc, series.rain_chirps_mm, null);
		let sum = 0;
		for (let i = r - 14; i <= r; i++) sum += acc.values.get(day(i))!;
		expect(sum).toBeCloseTo(60, 12);
		// 13 CHIRPS days of 4 mm (52 mm), the day before and the reading day 0: 60 × 4 / 52 each.
		for (let i = r - 14; i < r - 1; i++) expect(acc.values.get(day(i))).toBeCloseTo((60 * 4) / 52, 12);
		expect(h[r - 1]).toBe(0);
		expect(acc.values.get(day(r))).toBeCloseTo(0, 12);
	});

	it('a missing period on the reading day drops it (§2.4c sets the day aside anyway); one on the outage only does not', () => {
		const { series, r } = outage();
		const onDay = { start: iso(r), end: iso(r), reason: 'gauge fault' };
		expect(rainAccumulations(series, zr({ missing: [onDay] }), 'monthly')!.windows).toEqual([]);
		const onOutage = { start: iso(1), end: iso(r - 1), reason: 'logger outage' };
		expect(rainAccumulations(series, zr({ missing: [onOutage] }), 'monthly')!.windows.map((w) => w.status)).toEqual(['setAside']);
		// A keep-dry period on the reading day drops it too (zero-run mode 'missing' only), as for any detection.
		expect(rainAccumulations(series, zr({ keepDry: [onDay] }), 'monthly')!.windows).toEqual([]);
		// A rain-source period over the reading day counts as missing.
		expect(rainAccumulations(series, zr(), 'monthly', { replaced: [{ from: day(r), to: day(r) }] })!.windows).toEqual([]);
	});

	it('a window after an outage still drops when a listed missing period touches it', () => {
		const { c, h, r } = rec([...rep(20, B), 0, 0, 0, 0], 60, 20);
		const series = { rain_catchment_mm: ds(c), rain_chirps_mm: ds(h) };
		expect(rainAccumulations(series, zr(), 'monthly')!.windows.map((w) => [w.start, w.status])).toEqual([[iso(r - 4), 'spread']]);
		const touch = { start: iso(r - 2), end: iso(r - 2), reason: 'bad day' };
		expect(rainAccumulations(series, zr({ missing: [touch] }), 'monthly')!.windows).toEqual([]);
		// A listed day next to the outage joins it (listed days read as blank): the outage is 21 days and the
		// window the 3 zeros after it, which no longer touch the listed day.
		const next = { start: iso(r - 4), end: iso(r - 4), reason: 'bad day' };
		expect(rainAccumulations(series, zr({ missing: [next] }), 'monthly')!.windows.map((w) => [w.start, w.runDays])).toEqual([[iso(r - 3), 3]]);
		// A missing period that ends on the outage's last day doesn't touch the window.
		const before = { start: iso(1), end: iso(r - 5), reason: 'logger outage' };
		expect(rainAccumulations(series, zr({ missing: [before] }), 'monthly')!.windows).toHaveLength(1);
	});

	it("as recorded, the warning says the outage's rain may be counted twice when the run passes it in", () => {
		const w = {
			start: '2001-07-01',
			end: '2001-07-01',
			source: 'detected' as const,
			reason: null,
			status: 'asRecorded' as const,
			keptReason: null,
			totalMm: 60,
			readingMm: 60,
			runDays: 30,
			nearChirpsMm: 0,
			runChirpsMm: 116,
			chirpsMm: null,
			outageDays: 30,
			daysInRun: 1,
			usedMm: 0
		};
		const info = { mode: 'asRecorded' as const, criteria: ACCUMULATION_CRITERIA, windows: [w], skipped: [], spreadWindows: 0, spreadDays: 0, spreadMm: 0 };
		const [text] = accumulationWarnings(info, [w]);
		expect(text).toContain('2001-07-01 (60 mm read after a 30-day outage)');
		expect(text).toContain('a flagged zero run or a blank outage that CHIRPS fills, so that rain may be counted twice (2001-07-01)');
	});
});

describe('days listed as missing count as blank for outages (engine ≥ 1.70.0)', () => {
	// The record: 5 mm, 30 zeros, the reading of 60 mm, 5 mm. CHIRPS 4 mm a day over the zeros, 0 the day
	// before the reading, the reading day and the day after. Listed periods end the day before the reading.
	const base = () => {
		const { c, h, r } = rec(rep(30, 0), 60, 4);
		return { series: { rain_catchment_mm: ds(c), rain_chirps_mm: ds(h) } as Partial<Record<SeriesKind, DailySeries>>, c, h, r };
	};
	const miss = (from: number, to: number) => ({ start: iso(from), end: iso(to), reason: 'invented: logger fault' });

	it('positive control: unlisted, the 30 zeros are an ordinary 31-day window', () => {
		const { series, r } = base();
		expect(rainAccumulations(series, zr(), 'monthly')!.windows.map((w) => [w.start, w.status])).toEqual([[iso(r - 30), 'spread']]);
	});

	it('8 listed days straight before the reading: an outage, and the reading is judged over it (CHIRPS 7 × 4 = 28 mm)', () => {
		const { series, r } = base();
		// 28 mm < half of 60: the reading fails the run test, so nothing at all (and the zeros' window is gone too).
		expect(rainAccumulations(series, zr({ missing: [miss(r - 8, r - 1)] }), 'monthly')!.windows).toEqual([]);
		// With 50 mm read, 28 ≥ 25: set aside.
		const c = series.rain_catchment_mm!.values.slice();
		c[r] = 50;
		const acc = rainAccumulations({ ...series, rain_catchment_mm: ds(c) }, zr({ missing: [miss(r - 8, r - 1)] }), 'monthly')!;
		expect(acc.windows).toEqual([
			expect.objectContaining({ start: iso(r), end: iso(r), status: 'setAside', outageDays: 8, runDays: 8, runChirpsMm: 28, readingMm: 50, totalMm: 50 })
		]);
	});

	it('a 20-day listed stretch: set aside with outage 20 (CHIRPS 19 × 4 = 76 ≥ 30)', () => {
		const { series, r } = base();
		const acc = rainAccumulations(series, zr({ missing: [miss(r - 20, r - 1)] }), 'monthly')!;
		expect(acc.windows.map((w) => [w.end, w.status, w.outageDays, w.runChirpsMm])).toEqual([[iso(r), 'setAside', 20, 76]]);
		expect(fitExcludedWindows(acc)).toHaveLength(1);
	});

	it('7 listed days or fewer behave as before: the window reaches across them and is dropped because it touches them', () => {
		const { series, r } = base();
		for (const n of [1, 3, 7]) expect(rainAccumulations(series, zr({ missing: [miss(r - n, r - 1)] }), 'monthly')!.windows, `${n} days`).toEqual([]);
	});

	it('4 blank days and 4 listed days side by side make an 8-day outage', () => {
		const { series, r } = base();
		const c = series.rain_catchment_mm!.values.slice();
		for (let i = r - 8; i < r - 4; i++) c[i] = null;
		const s2 = { ...series, rain_catchment_mm: ds(c) };
		c[r] = 50; // CHIRPS over the 8 days, the day before left out: 28 ≥ 25
		expect(rainAccumulations(s2, zr({ missing: [miss(r - 4, r - 1)] }), 'monthly')!.windows.map((w) => [w.status, w.outageDays])).toEqual([['setAside', 8]]);
		// Blank first, listed after, or the other way round: the same.
		const c2 = series.rain_catchment_mm!.values.slice();
		for (let i = r - 4; i < r; i++) c2[i] = null;
		c2[r] = 50;
		expect(rainAccumulations({ ...series, rain_catchment_mm: ds(c2) }, zr({ missing: [miss(r - 8, r - 5)] }), 'monthly')!.windows.map((w) => [w.status, w.outageDays])).toEqual([['setAside', 8]]);
		// Only 4 + 3: a 7-day stretch, so the window reaches across and touches the listed days: dropped.
		expect(rainAccumulations(s2, zr({ missing: [miss(r - 3, r - 1)] }), 'monthly')!.windows).toEqual([]);
	});

	it('a listed stretch of more than 7 days ends a run: zeros after it form their own window, which doesn\'t touch it', () => {
		const { series, r } = base();
		// Listed: r-30 … r-11 (20 days). The run is the 10 zeros after it: CHIRPS 9 × 4 = 36 ≥ 30.
		const acc = rainAccumulations(series, zr({ missing: [miss(r - 30, r - 11)] }), 'monthly')!;
		expect(acc.windows.map((w) => [w.start, w.end, w.status, w.runDays])).toEqual([[iso(r - 10), iso(r), 'spread', 10]]);
	});

	it('readings inside the listed period count as unknown too, and a reading day inside it is never judged', () => {
		const { series, r } = base();
		const c = series.rain_catchment_mm!.values.slice();
		c[r - 15] = 12; // a bad reading inside the listed stretch
		expect(rainAccumulations({ ...series, rain_catchment_mm: ds(c) }, zr({ missing: [miss(r - 20, r - 1)] }), 'monthly')!.windows.map((w) => [w.status, w.outageDays])).toEqual([['setAside', 20]]);
		expect(rainAccumulations(series, zr({ missing: [miss(r - 20, r)] }), 'monthly')!.windows).toEqual([]);
	});

	it('keepReadings keeps it; a listed accumulation that touches the missing days is skipped, so remove the listing to spread it', () => {
		const { series, r } = base();
		const m = [miss(r - 20, r - 1)];
		expect(rainAccumulations(series, zr({ missing: m, keepReadings: [{ start: iso(r), end: iso(r), reason: 'storm' }] }), 'monthly')!.windows.map((w) => w.status)).toEqual(['kept']);
		const over = { start: iso(r - 20), end: iso(r), reason: 'observer away' };
		const skipped = rainAccumulations(series, zr({ missing: m, addAccumulations: [over] }), 'monthly')!;
		expect(skipped.windows.map((w) => [w.source, w.status])).toEqual([['detected', 'setAside']]);
		expect(skipped.skipped[0]).toContain('overlaps a period listed as missing');
		const spread = rainAccumulations(series, zr({ addAccumulations: [over] }), 'monthly')!;
		expect(spread.windows.map((w) => [w.source, w.status])).toEqual([['listed', 'spread']]);
	});

	it('a rain-source period is not unknown: its days have rain, and a detection touching it is dropped as before', () => {
		const { series, r } = base();
		expect(rainAccumulations(series, zr(), 'monthly', { replaced: [{ from: day(r - 20), to: day(r - 1) }] })!.windows).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Property tests over random records (seeded)
// ---------------------------------------------------------------------------

/** A random record: readings, zero runs and blank stretches of 1–20 days; CHIRPS wet or dry at random. */
function randomRecord(seed: number, n = 400) {
	const g = new Rng(seed);
	const c: V[] = [];
	const h: V[] = [];
	while (c.length < n) {
		const k = g.next();
		const len = k < 0.35 ? 1 : k < 0.6 ? g.int(1, 12) : k < 0.8 ? g.int(1, 20) : g.int(1, 4);
		const v: () => V = k < 0.35 ? () => (g.next() < 0.5 ? g.float(20, 150) : g.float(0.1, 19)) : k < 0.6 ? () => 0 : k < 0.8 ? () => (g.next() < 0.05 ? Number.NaN : null) : () => (g.next() < 0.5 ? 0 : null);
		for (let i = 0; i < len && c.length < n; i++) c.push(v());
	}
	for (let i = 0; i < n; i++) h.push(g.next() < 0.03 ? null : g.next() < 0.4 ? 0 : g.float(0, 15));
	return { c, h };
}

/**
 * The rule written independently, scanning back from each reading: the run is
 * the 0 or blank days before it back to a reading, the record's start, or a
 * blank stretch longer than ACC_MAX_BLANK_DAYS (measured whole).
 */
function reference(c: V[], h: V[]): AccumulationCandidate[] {
	const blank = (v: V) => v == null || !Number.isFinite(v);
	const ch = (i: number) => {
		const v = h[i];
		return v != null && Number.isFinite(v) && v >= 0 ? v : 0;
	};
	const out: AccumulationCandidate[] = [];
	for (let i = 0; i < c.length; i++) {
		const v = c[i]!;
		if (blank(v) || v === 0 || !(v >= ACC_MIN_MM)) continue;
		let j = i - 1;
		let run = 0;
		let outage = 0;
		while (j >= 0 && (blank(c[j]!) || c[j] === 0)) {
			if (c[j] === 0) {
				run++;
				j--;
				continue;
			}
			let k = j;
			while (k >= 0 && blank(c[k]!)) k--;
			const len = j - k;
			if (len > ACC_MAX_BLANK_DAYS) {
				if (run === 0) outage = len;
				break;
			}
			run += len;
			j = k;
		}
		if (run < ACC_MIN_RUN_DAYS && !outage) continue;
		const hv = h[i];
		if (hv == null || !Number.isFinite(hv) || hv < 0) continue;
		const near = ch(i - 1) + ch(i) + ch(i + 1);
		if (!(near < ACC_READING_DAY_SHARE * v)) continue;
		const w = Math.min(outage || run, ACC_MAX_RUN_DAYS);
		let runMm = 0;
		for (let d = i - w; d <= i - 2; d++) runMm += ch(d);
		if (!(runMm >= ACC_RUN_SHARE * v)) continue;
		out.push(
			outage
				? { from: day(i), to: day(i), readingMm: v, runDays: outage, nearChirpsMm: near, runChirpsMm: runMm, outageDays: outage }
				: { from: day(i - w), to: day(i), readingMm: v, runDays: run, nearChirpsMm: near, runChirpsMm: runMm }
		);
	}
	return out;
}

describe('property: random records (200 seeds)', () => {
	const SEEDS = Array.from({ length: 200 }, (_, k) => 9001 + k);

	it('detection agrees with an independent backward-scan statement of the rule', () => {
		let windows = 0;
		let outages = 0;
		for (const seed of SEEDS) {
			const { c, h } = randomRecord(seed);
			const got = detect(c, h);
			const want = reference(c, h);
			expect(got.length, `seed ${seed}`).toBe(want.length);
			got.forEach((x, k) => {
				const y = want[k]!;
				expect({ ...x, nearChirpsMm: 0, runChirpsMm: 0 }, `seed ${seed}`).toEqual({ ...y, nearChirpsMm: 0, runChirpsMm: 0 });
				expect(x.nearChirpsMm).toBeCloseTo(y.nearChirpsMm, 9);
				expect(x.runChirpsMm).toBeCloseTo(y.runChirpsMm, 9);
			});
			windows += got.filter((x) => !x.outageDays).length;
			outages += got.filter((x) => x.outageDays).length;
		}
		// The generator reaches both kinds often enough for the comparison to mean something.
		expect(windows).toBeGreaterThan(100);
		expect(outages).toBeGreaterThan(20);
	});

	it('windows never overlap, never hold a blank stretch over 7 days, and outage readings follow one', () => {
		for (const seed of SEEDS) {
			const { c, h } = randomRecord(seed);
			const found = detect(c, h);
			for (let k = 1; k < found.length; k++) expect(found[k]!.from, `seed ${seed}`).toBeGreaterThan(found[k - 1]!.to);
			for (const w of found) {
				const a = w.from - s0;
				const r = w.to - s0;
				if (w.outageDays) {
					expect(a).toBe(r);
					for (let i = r - w.outageDays; i < r; i++) expect(c[i] == null || !Number.isFinite(c[i]!)).toBe(true);
					expect(w.outageDays).toBeGreaterThan(ACC_MAX_BLANK_DAYS);
					continue;
				}
				expect(r - a).toBeGreaterThanOrEqual(ACC_MIN_RUN_DAYS);
				expect(r - a).toBeLessThanOrEqual(ACC_MAX_RUN_DAYS);
				let stretch = 0;
				for (let i = a; i < r; i++) {
					const blank = c[i] == null || !Number.isFinite(c[i]!);
					expect(blank || c[i] === 0).toBe(true);
					stretch = blank ? stretch + 1 : 0;
					expect(stretch).toBeLessThanOrEqual(ACC_MAX_BLANK_DAYS);
				}
			}
		}
	});

	it('with random listed missing periods: no window touches one, and every set-aside reading follows > 7 days blank or listed', () => {
		let asides = 0;
		for (const seed of SEEDS) {
			const { c, h } = randomRecord(seed);
			const g = new Rng(seed + 77);
			const spans: [number, number][] = [];
			for (let k = 0; k < 4; k++) {
				const a = g.int(0, c.length - 30);
				spans.push([a, a + g.int(0, 20)]);
			}
			const missing = spans.map(([a, b]) => ({ start: iso(a), end: iso(b), reason: 'random' }));
			const acc = rainAccumulations({ rain_catchment_mm: ds(c), rain_chirps_mm: ds(h) }, zr({ mode: 'asRecorded', missing }), 'none')!;
			const listed = (i: number) => spans.some(([a, b]) => i >= a && i <= b);
			const unknown = (i: number) => listed(i) || c[i] == null || !Number.isFinite(c[i]!);
			for (const w of acc.windows) {
				for (let d = w.from; d <= w.to; d++) expect(listed(d - s0), `seed ${seed}`).toBe(false);
				if (w.status !== 'setAside') continue;
				asides++;
				const r = w.to - s0;
				for (let i = r - w.outageDays!; i < r; i++) expect(unknown(i)).toBe(true);
				expect(r - w.outageDays! - 1 < 0 || !unknown(r - w.outageDays! - 1)).toBe(true);
				expect(w.outageDays).toBeGreaterThan(ACC_MAX_BLANK_DAYS);
			}
		}
		expect(asides).toBeGreaterThan(20);
	});

	it("spreading: each window adds up to its total, no day holds more than it or less than 0, and outage readings aren't spread", () => {
		for (const seed of SEEDS) {
			const { c, h } = randomRecord(seed);
			const series = { rain_catchment_mm: ds(c), rain_chirps_mm: ds(h) };
			const before = structuredClone(series);
			const acc = rainAccumulations(series, zr({ mode: 'asRecorded' }), 'none')!;
			spreadAccumulations(acc, series.rain_chirps_mm, null);
			expect(series, `seed ${seed}`).toEqual(before);
			for (const w of acc.windows) {
				if (w.status === 'setAside') {
					expect(w.from).toBe(w.to);
					for (let d = w.from; d <= w.to; d++) expect(acc.values.has(d)).toBe(false);
					continue;
				}
				expect(w.status === 'spread' || w.status === 'noChirps').toBe(true);
				let sum = 0;
				for (let d = w.from; d <= w.to; d++) {
					const v = acc.values.get(d)!;
					expect(v).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(w.totalMm + 1e-9);
					sum += v;
				}
				expect(sum, `seed ${seed} ${w.start}`).toBeCloseTo(w.totalMm, 9);
			}
			// Applied to the whole record: only window days change, set-aside days go blank, the rest is untouched.
			const run = c.slice();
			const applied = applyAccumulations(acc, run, s0);
			for (let i = 0; i < c.length; i++) {
				const w = acc.windows.find((x) => day(i) >= x.from && day(i) <= x.to);
				if (!w) expect(run[i]).toBe(c[i]);
				else if (w.status === 'setAside') expect(run[i]).toBeNull();
				else expect(applied.mask[i]).toBe(1);
			}
		}
	});
});
