// Multi-day accumulations (engine ≥ 0.20.0, audit B4, docs/model.md §2.4d). Synthetic fixtures only.
import { describe, expect, it } from 'vitest';
import {
	ACC_MAX_RUN_DAYS,
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
 * A short record: a day of rain, `run` days of 0, a reading of `reading` mm,
 * then a day of 0. CHIRPS reads `chirpsRun` mm on each run day but the last,
 * and `near` = [day before, reading day, day after].
 */
function shortCase(run: number, reading: number, chirpsRun: number, near: [number, number, number] = [0, 0, 0]) {
	const c: (number | null)[] = [5, ...new Array<number>(run).fill(0), reading, 0];
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
	it('finds a large reading after a zero run that CHIRPS rained on, on a day CHIRPS was dry', () => {
		const { c, h, r } = shortCase(10, 60, 4);
		expect(detect(c, h)).toEqual([{ from: day(1), to: day(r), readingMm: 60, runDays: 10, nearChirpsMm: 0, runChirpsMm: 36 }]);
	});

	it('counts blank days in the run like zeros', () => {
		const { c, h, r } = shortCase(10, 60, 4);
		for (const i of [2, 3, 7]) c[i] = null;
		expect(detect(c, h)).toMatchObject([{ from: day(1), to: day(r), runDays: 10 }]);
	});

	it('does not flag a reading below the threshold, or after a run shorter than three days', () => {
		expect(detect(...pick(shortCase(10, 19, 4)))).toEqual([]);
		const { c, h } = shortCase(2, 60, 40);
		expect(detect(c, h)).toEqual([]);
	});

	it('does not flag a reading CHIRPS saw on its day or, allowing a day of timing slop, the day after', () => {
		expect(detect(...pick(shortCase(10, 60, 4, [0, 20, 0])))).toEqual([]);
		expect(detect(...pick(shortCase(10, 60, 4, [0, 0, 20])))).toEqual([]);
		// Under a quarter of the reading around it is still "dry".
		expect(detect(...pick(shortCase(10, 60, 4, [0, 14, 0])))).toHaveLength(1);
	});

	it('does not count CHIRPS rain on the day before the reading towards the run: that is the same storm a day early', () => {
		// 12 mm the day before is under a quarter of 60, but nothing else fell in the run.
		expect(detect(...pick(shortCase(10, 60, 0, [12, 0, 0])))).toEqual([]);
	});

	it('does not flag a storm after a real dry spell (CHIRPS dry or drizzling over the run): a convective storm CHIRPS missed', () => {
		expect(detect(...pick(shortCase(10, 60, 0)))).toEqual([]);
		expect(detect(...pick(shortCase(10, 60, 1)))).toEqual([]); // 9 mm < half of 60
	});

	it('needs a CHIRPS value on the reading day', () => {
		const { c, h, r } = shortCase(10, 60, 4);
		h[r] = null;
		expect(detect(c, h)).toEqual([]);
	});

	it(`caps the window at the last ${ACC_MAX_RUN_DAYS} days of a long run`, () => {
		const { c, h, r } = shortCase(150, 60, 1);
		const [w] = detect(c, h);
		expect(w).toMatchObject({ to: day(r), runDays: 150 });
		expect(w!.to - w!.from).toBe(ACC_MAX_RUN_DAYS);
	});

	it('judges CHIRPS × the bias factor: raw CHIRPS that reads half the gauge is doubled first', () => {
		const { c, h } = shortCase(10, 60, 2); // 18 mm raw over the run
		expect(detect(c, h)).toEqual([]);
		expect(detect(c, h, () => 2)).toMatchObject([{ runChirpsMm: 36 }]);
	});

	it('finds several windows in one record, never overlapping', () => {
		const a = shortCase(10, 60, 4);
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
		const { c, h, r } = shortCase(10, 60, 4);
		h[3] = 10; // uneven CHIRPS, so the spread is visibly proportional
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
// In a run: a flagged wet-season zero run that ends in an accumulation
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
 * Six water years; in 2003 the gauge was not read from `runLen` days before
 * the reading day (a 2003-08 day CHIRPS is dry on, and the days either side):
 * those days read 0 and the reading holds what the catchment got over them.
 */
function accumulationInput(runLen: number, over: ModelInput['settings'] = {}) {
	const h: number[] = Array.from({ length: RDAYS }, (_, i) => (i % 3 === 0 ? BASE[monthAt(i)]! : 0));
	const r = toEpochDay('2003-08-20') - r0;
	h[r - 1] = 0;
	h[r] = 0;
	h[r + 1] = 0;
	const c: (number | null)[] = h.map((v, i) => v * K[monthAt(i)]!);
	let total = 0;
	for (let i = r - runLen; i < r; i++) {
		total += c[i]!;
		c[i] = 0;
	}
	c[r] = total;
	// The fixture's own dry days touching the run join it; the gauge read 0 then too.
	let a = r - runLen;
	while (c[a - 1] === 0) a--;
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
	return { input, r, total, runFrom: a };
}
const find = (out: ReturnType<typeof runModel>, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;
const get = (out: ReturnType<typeof runModel>, key: string) => find(out, key)!;
const sumOver = (xs: ArrayLike<number>, from: number, to: number) => {
	let s = 0;
	for (let i = from; i <= to; i++) s += xs[i]!;
	return s;
};

describe('a run with an accumulation that ends a flagged zero run', () => {
	it('fixture: the zero run is flagged, and the reading is detected', () => {
		const { input, r } = accumulationInput(70);
		const runs = zeroRainRuns(input.series.rain_catchment_mm!).runs;
		expect(runs.some((x) => toEpochDay(x.endDate) === r0 + r - 1)).toBe(true);
		const acc = rainAccumulations(input.series, zr(), 'monthly')!;
		expect(acc.windows.map((w) => [w.end, w.status])).toEqual([[fromEpochDay(r0 + r), 'spread']]);
	});

	it('counts the rain once: the window adds up to the recorded total, and the zero-run fill leaves its days alone (the 0.19 double count)', () => {
		const { input, r, total } = accumulationInput(70);
		const out = runModel(input);
		expect(checkInvariants(input, out)).toBeNull();
		const a = out.summary.rainAccumulation!;
		expect(a).toMatchObject({ mode: 'spread', spreadWindows: 1 });
		const w = a.windows[0]!;
		const from = toEpochDay(w.start) - r0;
		expect(sumOver(get(out, 'rain_final'), from, r)).toBeCloseTo(total, 9);
		expect(a.spreadMm).toBeCloseTo(total, 9);
		// Precedence: none of the window's days is also filled as a zero run.
		// The whole run is inside the window, so no day is filled as a zero run and the column isn't output.
		expect(find(out, 'rain_catchment_missing')).toBeUndefined();
		expect(out.summary.zeroRainInfill!.days).toBe(0);
		const spread = get(out, ACCUMULATION_COLUMN.key);
		for (let i = from; i <= r; i++) {
			expect(spread[i]).toBe(1);
		}
		expect(spread.reduce((x, v) => x + v, 0)).toBe(a.spreadDays);
		expect(out.summary.warnings.find((x) => x.startsWith('Catchment rain accumulations spread'))).toContain(`${w.start} to ${w.end}`);
		// The window is left out of the CHIRPS factor fit, day by day.
		expect(out.summary.chirpsCorrection!.accumulationDaysLeftOut).toBe(r - from + 1);

		// As recorded, the run is filled from CHIRPS and the reading kept too: the rain counts twice, and the run says so.
		const rec = runModel({ ...input, settings: { ...input.settings, zeroRainRuns: zr({ accumulationMode: 'asRecorded' }) } });
		expect(sumOver(get(rec, 'rain_final'), from, r)).toBeGreaterThan(total * 1.5);
		expect(rec.summary.rainAccumulation!.windows[0]!.status).toBe('asRecorded');
		expect(rec.summary.warnings.find((x) => x.includes('multi-day accumulation run as recorded'))).toContain('counted twice');
		expect(rec.series.some((s) => s.key === ACCUMULATION_COLUMN.key)).toBe(false);
	});

	it('a run longer than the window cap: the window takes its last days and the zero-run fill the rest', () => {
		const { input, r, runFrom } = accumulationInput(120);
		const run = prepareRun(input);
		const w = run.accumulation!.info.windows[0]!;
		const from = toEpochDay(w.start) - r0;
		expect(r - from).toBe(ACC_MAX_RUN_DAYS);
		for (let i = runFrom; i < from; i++) expect(run.zeroRain!.mask[i]).toBe(1);
		for (let i = from; i <= r; i++) expect(run.zeroRain!.mask[i]).toBe(0);
		expect(run.zeroRain!.infill.days).toBe(from - runFrom);
	});

	it('the stored series is never changed', () => {
		const { input } = accumulationInput(70);
		const before = structuredClone(input.series);
		runModel(input);
		expect(input.series).toEqual(before);
	});
});
