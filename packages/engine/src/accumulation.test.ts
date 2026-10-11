// Multi-day accumulations (engine ≥ 0.20.0, audit B4, docs/model.md §2.4d). Synthetic fixtures only.
import { describe, expect, it } from 'vitest';
import {
	ACC_MAX_BLANK_DAYS,
	ACCUMULATION_COLUMN,
	detectAccumulations,
	fitExcludedWindows,
	rainAccumulations,
	spreadAccumulations
} from './accumulation';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { defaultZeroRainSettings, type DailySeries, type ModelInput, type NetworkNode, type SeriesKind, type ZeroRainSettings } from './project';
import { zeroRainRuns } from './quality';
import { runModel } from './run';
import { checkInvariants } from './testing/invariants';
import { prepareRun } from './prepare';

type Series = Partial<Record<SeriesKind, DailySeries>>;
const S = '2001-06-01';
const ds = (values: (number | null)[], startDate = S): DailySeries => ({ startDate, values });
const one = () => 1;
const zr = (over: Partial<ZeroRainSettings> = {}): ZeroRainSettings => ({ ...defaultZeroRainSettings(), ...over });

/**
 * A short record: a day of rain, `run` blank (unread) days, a reading of
 * `reading` mm, then a day of 0. CHIRPS reads `chirpsRun` mm on each run day
 * but the last, and `near` = [day before, reading day, day after].
 */
function shortCase(run: number, reading: number, chirpsRun: number, near: [number, number, number] = [0, 0, 0], fill: 0 | null = null) {
	const c: (number | null)[] = [5, ...new Array<number | null>(run).fill(fill), reading, 0];
	const h: (number | null)[] = [5, ...new Array<number>(run).fill(chirpsRun), 0, 0];
	const r = run + 1; // reading index
	h[r - 1] = near[0];
	h[r] = near[1];
	h[r + 1] = near[2];
	return { c, h, r };
}
const detect = (c: (number | null)[], h: (number | null)[], factor = one) => detectAccumulations(ds(c), ds(h), factor);
const day = (i: number) => toEpochDay(S) + i;

describe('detectAccumulations', () => {
	it('finds a large reading after blank days that CHIRPS rained on, on a day CHIRPS was dry', () => {
		const { c, h, r } = shortCase(6, 60, 10);
		// CHIRPS over the run, the day before the reading left out: 5 × 10 = 50 mm ≥ 30.
		expect(detect(c, h)).toEqual([{ from: day(1), to: day(r), readingMm: 60, runDays: 6, nearChirpsMm: 0, runChirpsMm: 50 }]);
	});

	it('engine 1.84.0: days of 0 before a large reading are no run: it is real rain and stays on its day', () => {
		// The same record with the unread days entered as 0 (and a 70-day zero run): nothing.
		expect(detect(...pick(shortCase(6, 60, 10, [0, 0, 0], 0)))).toEqual([]);
		expect(detect(...pick(shortCase(70, 60, 10, [0, 0, 0], 0)))).toEqual([]);
		// Positive control: the same days blank are a window.
		expect(detect(...pick(shortCase(6, 60, 10)))).toHaveLength(1);
	});

	it('zeros and blanks mixed: only the blanks after the last recorded 0 count', () => {
		const { c, h, r } = shortCase(10, 60, 10);
		// 0 at index 5, then blanks on 6 … 10 (5 days): the window is those 5 days and the reading.
		for (const i of [1, 3, 5]) c[i] = 0;
		expect(detect(c, h)).toEqual([{ from: day(6), to: day(r), readingMm: 60, runDays: 5, nearChirpsMm: 0, runChirpsMm: 40 }]);
		// A 0 two days before the reading leaves 2 blanks after it: fewer than 3, so no window.
		c[r - 3] = 0;
		expect(detect(c, h)).toEqual([]);
		// A 0 the day before the reading: no run at all.
		const z = shortCase(6, 60, 10);
		z.c[z.r - 1] = 0;
		expect(detect(z.c, z.h)).toEqual([]);
	});

	it('does not flag a reading below the threshold, or after fewer than three blank days', () => {
		expect(detect(...pick(shortCase(6, 19, 10)))).toEqual([]);
		expect(detect(...pick(shortCase(2, 60, 40)))).toEqual([]);
		// Exactly 3 blanks: CHIRPS over the 2 days that count, 2 × 20 = 40 ≥ 30.
		expect(detect(...pick(shortCase(3, 60, 20)))).toMatchObject([{ from: day(1), runDays: 3 }]);
	});

	it(`more than ${ACC_MAX_BLANK_DAYS} blank days is an outage (Q31), as before: the reading is a candidate on its own day`, () => {
		const { c, h, r } = shortCase(8, 60, 10);
		// CHIRPS over the outage, the day before left out: 7 × 10 = 70 ≥ 30.
		expect(detect(c, h)).toEqual([{ from: day(r), to: day(r), readingMm: 60, runDays: 8, nearChirpsMm: 0, runChirpsMm: 70, outageDays: 8 }]);
	});

	it('does not flag a reading CHIRPS saw on its day or, allowing a day of timing slop, the day after', () => {
		expect(detect(...pick(shortCase(6, 60, 10, [0, 20, 0])))).toEqual([]);
		expect(detect(...pick(shortCase(6, 60, 10, [0, 0, 20])))).toEqual([]);
		// Under a quarter of the reading around it is still "dry".
		expect(detect(...pick(shortCase(6, 60, 10, [0, 14, 0])))).toHaveLength(1);
	});

	it('does not count CHIRPS rain on the day before the reading towards the run: that is the same storm a day early', () => {
		// 12 mm the day before is under a quarter of 60, but nothing else fell in the run.
		expect(detect(...pick(shortCase(6, 60, 0, [12, 0, 0])))).toEqual([]);
	});

	it('does not flag a storm after unread days CHIRPS was dry or drizzling over: a convective storm CHIRPS missed', () => {
		expect(detect(...pick(shortCase(6, 60, 0)))).toEqual([]);
		expect(detect(...pick(shortCase(6, 60, 1)))).toEqual([]); // 5 mm < half of 60
	});

	it('needs a CHIRPS value on the reading day', () => {
		const { c, h, r } = shortCase(6, 60, 10);
		h[r] = null;
		expect(detect(c, h)).toEqual([]);
	});

	it('judges CHIRPS × the bias factor: raw CHIRPS that reads half the gauge is doubled first', () => {
		const { c, h } = shortCase(6, 60, 5); // 25 mm raw over the run
		expect(detect(c, h)).toEqual([]);
		expect(detect(c, h, () => 2)).toMatchObject([{ runChirpsMm: 50 }]);
	});

	it('finds several windows in one record, never overlapping', () => {
		const a = shortCase(6, 60, 10);
		const b = shortCase(5, 40, 6);
		const found = detect([...a.c, ...b.c], [...a.h, ...b.h]);
		expect(found).toHaveLength(2);
		expect(found[0]!.to).toBeLessThan(found[1]!.from);
	});
});

function pick(x: { c: (number | null)[]; h: (number | null)[] }): [(number | null)[], (number | null)[]] {
	return [x.c, x.h];
}

describe('rainAccumulations and spreadAccumulations', () => {
	const base = () => {
		const { c, h, r } = shortCase(6, 60, 10);
		h[3] = 20; // uneven CHIRPS, so the spread is visibly proportional
		return { series: { rain_catchment_mm: ds(c), rain_chirps_mm: ds(h) } as Series, c, h, r };
	};

	it('spreads the recorded total over the window in proportion to CHIRPS, and the window adds up to it', () => {
		const { series, h, r } = base();
		const acc = rainAccumulations(series, zr(), 'monthly')!;
		expect(acc.windows).toHaveLength(1);
		expect(acc.windows[0]).toMatchObject({ source: 'detected', status: 'spread', totalMm: 60, readingMm: 60, start: fromEpochDay(day(1)), end: fromEpochDay(day(r)) });
		spreadAccumulations(acc, series.rain_chirps_mm, null);
		const w = acc.windows[0]!;
		let sum = 0;
		for (let d = w.from; d <= w.to; d++) sum += acc.values.get(d)!;
		expect(sum).toBeCloseTo(60, 12);
		const W = h.slice(1, r + 1).reduce<number>((a, v) => a + (v ?? 0), 0);
		expect(w.chirpsMm).toBe(W);
		for (let i = 1; i < r; i++) expect(acc.values.get(day(i))).toBeCloseTo((60 * h[i]!) / W, 12);
		// CHIRPS was dry on the reading day, so almost nothing is left there.
		expect(acc.values.get(day(r))).toBeCloseTo(0, 9);
	});

	it('keeps a reading listed as real one-day rain as recorded, and the fit keeps its days', () => {
		const { series, r } = base();
		const d = fromEpochDay(day(r));
		const acc = rainAccumulations(series, zr({ keepReadings: [{ start: d, end: d, reason: 'thunderstorm, farm records agree' }] }), 'monthly')!;
		expect(acc.windows[0]).toMatchObject({ status: 'kept', keptReason: 'thunderstorm, farm records agree' });
		expect(fitExcludedWindows(acc)).toEqual([]);
		spreadAccumulations(acc, series.rain_chirps_mm, null);
		expect(acc.values.size).toBe(0);
	});

	it("leaves detections as recorded in mode 'asRecorded', but still out of the fit", () => {
		const { series } = base();
		const acc = rainAccumulations(series, zr({ accumulationMode: 'asRecorded' }), 'monthly')!;
		expect(acc.windows.map((w) => w.status)).toEqual(['asRecorded']);
		expect(fitExcludedWindows(acc)).toHaveLength(1);
		spreadAccumulations(acc, series.rain_chirps_mm, null);
		expect(acc.values.size).toBe(0);
	});

	it('a listed window takes precedence over a detection it overlaps; one with no CHIRPS rain keeps its total on the reading day', () => {
		const { series, r } = base();
		const h = series.rain_chirps_mm!.values.map(() => 0);
		const s2 = { ...series, rain_chirps_mm: ds(h) };
		const listed = { start: fromEpochDay(day(5)), end: fromEpochDay(day(r)), reason: 'observer away, per station log' };
		const acc = rainAccumulations(s2, zr({ addAccumulations: [listed] }), 'monthly')!;
		expect(acc.windows).toHaveLength(1);
		expect(acc.windows[0]).toMatchObject({ source: 'listed', reason: listed.reason, status: 'spread', totalMm: 60 });
		spreadAccumulations(acc, s2.rain_chirps_mm, null);
		expect(acc.windows[0]!.status).toBe('noChirps');
		expect(acc.values.get(day(r))).toBe(60);
		for (let i = 5; i < r; i++) expect(acc.values.get(day(i))).toBe(0);
		// Without a CHIRPS series a listed window can't be spread either.
		const bare = rainAccumulations({ rain_catchment_mm: series.rain_catchment_mm }, zr({ addAccumulations: [listed] }), 'monthly')!;
		spreadAccumulations(bare, undefined, null);
		expect(bare.windows[0]!.status).toBe('noChirps');
	});

	it('a listed missing period wins over a detection and over a listed window; a keep-dry period drops a detection', () => {
		const { series, r } = base();
		const period = { start: fromEpochDay(day(4)), end: fromEpochDay(day(6)), reason: 'logger fault' };
		expect(rainAccumulations(series, zr({ missing: [period] }), 'monthly')!.windows).toEqual([]);
		const listed = { start: fromEpochDay(day(1)), end: fromEpochDay(day(r)), reason: 'x' };
		const both = rainAccumulations(series, zr({ missing: [period], addAccumulations: [listed] }), 'monthly')!;
		expect(both.windows).toEqual([]);
		expect(both.skipped).toEqual([`Listed accumulation ${listed.start} to ${listed.end} overlaps a period listed as missing or a rain-source period, so it is not spread: that period wins.`]);
		expect(rainAccumulations(series, zr({ keepDry: [period] }), 'monthly')!.windows).toEqual([]);
		// Keep-dry only means something in zero-run mode 'missing', as elsewhere.
		expect(rainAccumulations(series, zr({ mode: 'asRecorded', keepDry: [period] }), 'monthly')!.windows).toHaveLength(1);
	});

	it('a listed window with no reading in it is reported, not spread; overlapping listed windows keep the first', () => {
		const { series } = base();
		const c = series.rain_catchment_mm!.values.slice();
		c[0] = null;
		const a = { start: fromEpochDay(day(0)), end: fromEpochDay(day(0)), reason: 'blank' };
		const b = { start: fromEpochDay(day(0)), end: fromEpochDay(day(2)), reason: 'overlaps' };
		const acc = rainAccumulations({ ...series, rain_catchment_mm: ds(c) }, zr({ addAccumulations: [a, b] }), 'monthly')!;
		expect(acc.windows.filter((w) => w.source === 'listed').map((w) => w.status)).toEqual(['noReading']);
		expect(acc.skipped).toHaveLength(1);
	});

	it('is null without a catchment rain series, and finds nothing without CHIRPS', () => {
		expect(rainAccumulations({}, zr(), 'monthly')).toBeNull();
		expect(rainAccumulations({ rain_catchment_mm: base().series.rain_catchment_mm }, zr(), 'monthly')!.windows).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// In a run: a gauge left unread for a few days, and one read as 0 for weeks
// ---------------------------------------------------------------------------

const RS = '2000-10-01';
const RDAYS = toEpochDay('2006-10-01') - toEpochDay(RS);
const r0 = toEpochDay(RS);
const monthAt = (i: number) => monthOfEpochDay(r0 + i);
/** CHIRPS rain on every third day by month (winter rainfall); the catchment reads K × CHIRPS. */
const BASE = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
const K = [0, 1.1, 0.9, 1.2, 1.5, 2.0, 2.5, 3.0, 2.8, 2.2, 1.6, 1.3, 1.0];
const flat = (v: number) => new Array<number>(12).fill(v) as unknown as Monthly;
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
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/**
 * Six water years; in 2003 the gauge was not read on the `runLen` days before
 * the reading day (a 2003-08 day CHIRPS is dry on, and the days either side):
 * those days read `fill` (blank, or 0) and the reading holds what the
 * catchment got over them.
 */
function accumulationInput(runLen: number, fill: 0 | null = null, over: ModelInput['settings'] = {}) {
	const h: number[] = Array.from({ length: RDAYS }, (_, i) => (i % 3 === 0 ? BASE[monthAt(i)]! : 0));
	const r = toEpochDay('2003-08-20') - r0;
	h[r - 1] = 0;
	h[r] = 0;
	h[r + 1] = 0;
	const c: (number | null)[] = h.map((v, i) => v * K[monthAt(i)]!);
	let total = 0;
	for (let i = r - runLen; i < r; i++) {
		total += c[i]!;
		c[i] = fill;
	}
	c[r] = total;
	const input: ModelInput = {
		settings: { apanMm: flat(150), ewrPragmaticM3PerDay: flat(0), runoffModel: 'gr4j', ...over },
		model: {
			nodes: [farm('A', { downstreamNodeId: 'G', damCapacityM3: 50_000 }), farm('G', { kind: 'gauge', areaKm2: 0 })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: [...flat(0.8)] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: ds(c, RS), rain_chirps_mm: ds(h, RS) }
	};
	return { input, r, total };
}
const find = (out: ReturnType<typeof runModel>, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;
const get = (out: ReturnType<typeof runModel>, key: string) => find(out, key)!;
const sumOver = (xs: ArrayLike<number>, from: number, to: number) => {
	let s = 0;
	for (let i = from; i <= to; i++) s += xs[i]!;
	return s;
};

describe('a run with an accumulation after blank days', () => {
	it('fixture: 6 blank days then the reading is detected, and its window is exactly those days', () => {
		const { input, r, total } = accumulationInput(6);
		expect(total).toBeGreaterThanOrEqual(20);
		const acc = rainAccumulations(input.series, zr(), 'monthly')!;
		expect(acc.windows.map((w) => [w.start, w.end, w.status, w.runDays])).toEqual([[fromEpochDay(r0 + r - 6), fromEpochDay(r0 + r), 'spread', 6]]);
	});

	it('counts the rain once: the window adds up to the recorded total, and its blank days are not also filled from CHIRPS', () => {
		const { input, r, total } = accumulationInput(6);
		const out = runModel(input);
		expect(checkInvariants(input, out)).toBeNull();
		const a = out.summary.rainAccumulation!;
		expect(a).toMatchObject({ mode: 'spread', spreadWindows: 1 });
		const from = r - 6;
		expect(sumOver(get(out, 'rain_final'), from, r)).toBeCloseTo(total, 9);
		expect(a.spreadMm).toBeCloseTo(total, 9);
		const spread = get(out, ACCUMULATION_COLUMN.key);
		for (let i = from; i <= r; i++) expect(spread[i]).toBe(1);
		expect(spread.reduce((x, v) => x + v, 0)).toBe(a.spreadDays);
		expect(out.summary.warnings.find((x) => x.startsWith('Catchment rain accumulations spread'))).toContain(`${a.windows[0]!.start} to ${a.windows[0]!.end}`);
		// The window is left out of the CHIRPS factor fit, day by day: its blank days never were in it, so only the reading day counts.
		expect(out.summary.chirpsCorrection!.accumulationDaysLeftOut).toBe(1);

		// As recorded, the blank days are filled from CHIRPS and the reading kept too: the rain counts twice, and the run says so.
		const rec = runModel({ ...input, settings: { ...input.settings, zeroRainRuns: zr({ accumulationMode: 'asRecorded' }) } });
		expect(sumOver(get(rec, 'rain_final'), from, r)).toBeGreaterThan(total * 1.5);
		expect(rec.summary.rainAccumulation!.windows[0]!.status).toBe('asRecorded');
		expect(rec.summary.warnings.find((x) => x.includes('multi-day accumulation run as recorded'))).toContain('counted twice');
		expect(rec.series.some((s) => s.key === ACCUMULATION_COLUMN.key)).toBe(false);
	});

	it('engine 1.84.0: the same days entered as 0 are real dry days, so the reading is real rain and stays on its day', () => {
		const { input, r, total } = accumulationInput(6, 0);
		const out = runModel(input);
		expect(out.summary.rainAccumulation!.windows).toEqual([]);
		expect(get(out, 'rain_final')[r]).toBe(total);
		for (let i = r - 6; i < r; i++) expect(get(out, 'rain_final')[i]).toBe(0);
		expect(out.summary.warnings.some((x) => x.includes('accumulation'))).toBe(false);
	});

	it('a long zero run ending in a large reading: no window; the reading stays on its day and §2.4c handles the zero run alone', () => {
		const { input, r, total } = accumulationInput(120, 0);
		const run = prepareRun(input);
		expect(run.accumulation!.info.windows).toEqual([]);
		expect(run.chirpsCorrection!.accumulationDaysLeftOut ?? 0).toBe(0);
		expect(run.aligned('rain_catchment_mm')[r]).toBe(total);
		// The zero run is flagged and set aside on the days CHIRPS reads more than 2 mm (engine ≥ 1.81.0), as without the reading.
		const runs = zeroRainRuns(input.series.rain_catchment_mm!).runs;
		expect(runs.some((x) => toEpochDay(x.endDate) === r0 + r - 1)).toBe(true);
		const h = input.series.rain_chirps_mm!.values;
		let want = 0;
		for (let i = r - 120; i < r; i++) {
			expect(run.zeroRain!.mask[i]).toBe(h[i]! > 2 ? 1 : 0);
			want += h[i]! > 2 ? 1 : 0;
		}
		expect(want).toBeGreaterThan(0);
	});

	it('the stored series is never changed', () => {
		const { input } = accumulationInput(6);
		const before = structuredClone(input.series);
		runModel(input);
		expect(input.series).toEqual(before);
	});
});
