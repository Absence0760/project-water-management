// Untagged multi-day rainfall accumulations (engine ≥ 0.20.0, audit B4,
// issue #2, docs/model.md §2.4d).
//
// An observer who doesn't read the gauge for some days records 0 (or
// nothing) for the unread days and then the whole accumulated total on the
// day of the reading. Viney & Bates (2004, "It never rains on Sunday", Int.
// J. Climatol. 24) found these untagged accumulations throughout the
// Australian high-quality daily record. They leave the total right and the
// days wrong: a run of dry days, then one day far wetter than it was.
//
// Detection (detectAccumulations): a reading of at least ACC_MIN_MM, after
// at least ACC_MIN_RUN_DAYS days of 0 or blank catchment rain, on a day
// CHIRPS (±1 day, bias-corrected) reads under ACC_READING_DAY_SHARE of it,
// when CHIRPS over the run before (the day before the reading left out, for
// timing) reads at least ACC_RUN_SHARE of it. The window is the run, at most
// its last ACC_MAX_RUN_DAYS days, plus the reading day.
//
// Treatment (settings.zeroRainRuns.accumulationMode 'spread', the default):
// the window's recorded total is kept and spread over its days in proportion
// to bias-corrected CHIRPS there (the Viney & Bates remedy, with CHIRPS as
// the reference series). The stored series is never changed. Window days
// are not also set aside as a flagged zero run (that double counted the
// rain up to 0.19), and are left out of the CHIRPS factor fit (§2.4b): their
// recorded days are wrong and their spread days are CHIRPS-shaped, so
// fitting on either would be circular.
import { fromEpochDay, toEpochDay } from './calendar';
import { exclusionRanges, type ExclusionRange } from './calibrate/provenance';
import type { AccumulationMode, ChirpsBiasMode, DailySeries, SeriesKind, ZeroRainSettings } from './project';
import { chirpsBiasFactors, chirpsFactorOn, type ChirpsCorrection, type ChirpsFitOptions } from './rain';

/** A reading must be at least this, mm, to be judged. */
export const ACC_MIN_MM = 20;
/** … after at least this many days of 0 or blank catchment rain. */
export const ACC_MIN_RUN_DAYS = 3;
/** A window covers at most this many days of the run before the reading (about a season). */
export const ACC_MAX_RUN_DAYS = 92;
/** CHIRPS on the reading day and the days either side must read less than this share of the reading … */
export const ACC_READING_DAY_SHARE = 0.25;
/** … and CHIRPS over the run (the day before the reading left out) at least this share. */
export const ACC_RUN_SHARE = 0.5;

/** The detection thresholds, as a run reports them. */
export const ACCUMULATION_CRITERIA = {
	minMm: ACC_MIN_MM,
	minRunDays: ACC_MIN_RUN_DAYS,
	maxRunDays: ACC_MAX_RUN_DAYS,
	readingDayShare: ACC_READING_DAY_SHARE,
	runShare: ACC_RUN_SHARE
} as const;

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;
const isZeroOrBlank = (v: number | null | undefined) => v == null || !Number.isFinite(v) || v === 0;

/** A reading that looks like a multi-day accumulation. */
export interface AccumulationCandidate {
	/** First day of the window (epoch day) and the reading day, its last. */
	from: number;
	to: number;
	/** The reading, mm. */
	readingMm: number;
	/** Days of 0 or blank rain before the reading (the whole run, not capped). */
	runDays: number;
	/** CHIRPS on the reading day and the days either side, × factor, mm. */
	nearChirpsMm: number;
	/** CHIRPS over the window's run days except the day before the reading, × factor, mm. */
	runChirpsMm: number;
}

/**
 * Accumulation candidates in the catchment rain, over its whole record.
 * `factor(day)` scales CHIRPS on an epoch day (the fitted month factor; 1 for
 * raw). A day with no CHIRPS value counts as 0 CHIRPS, except that the
 * reading day itself must have one. Windows never overlap: each run ends at
 * the reading before the next. Pure.
 */
export function detectAccumulations(catchment: DailySeries, chirps: DailySeries, factor: (day: number) => number): AccumulationCandidate[] {
	const c0 = toEpochDay(catchment.startDate);
	const h0 = toEpochDay(chirps.startDate);
	const h = (day: number) => {
		const v = chirps.values[day - h0];
		return isReading(v) ? v * factor(day) : 0;
	};
	const out: AccumulationCandidate[] = [];
	const vals = catchment.values;
	let run = 0; // 0 or blank days immediately before index i
	for (let i = 0; i < vals.length; i++) {
		const v = vals[i];
		if (isZeroOrBlank(v)) {
			run++;
			continue;
		}
		const runBefore = run;
		run = 0;
		if (!isReading(v) || v < ACC_MIN_MM || runBefore < ACC_MIN_RUN_DAYS) continue;
		const day = c0 + i;
		if (!isReading(chirps.values[day - h0])) continue;
		const near = h(day - 1) + h(day) + h(day + 1);
		if (!(near < ACC_READING_DAY_SHARE * v)) continue;
		const w = Math.min(runBefore, ACC_MAX_RUN_DAYS);
		let runMm = 0;
		for (let d = day - w; d <= day - 2; d++) runMm += h(d);
		if (!(runMm >= ACC_RUN_SHARE * v)) continue;
		out.push({ from: day - w, to: day, readingMm: v, runDays: runBefore, nearChirpsMm: near, runChirpsMm: runMm });
	}
	return out;
}

/**
 * What a run does with a window. 'spread': its total is spread by CHIRPS.
 * 'noChirps': CHIRPS reads no rain over it, so the total stays on the
 * reading day (its other days run as 0). 'asRecorded': the mode leaves
 * detections as recorded. 'kept': a keep-reading period confirms it as one
 * day's rain. 'noReading': a listed window with no reading to spread.
 */
export type AccumulationStatus = 'spread' | 'noChirps' | 'asRecorded' | 'kept' | 'noReading';

export interface AccumulationWindow {
	/** First day and last (the reading day), ISO. */
	start: string;
	end: string;
	from: number;
	to: number;
	source: 'detected' | 'listed';
	/** The listed reason; null for a detection. */
	reason: string | null;
	status: AccumulationStatus;
	/** The keep-reading period's reason when status is 'kept'. */
	keptReason: string | null;
	/** Catchment rain recorded in the window (the reading plus any other readings), mm: what is spread. */
	totalMm: number;
	/** Catchment rain recorded on the last day, mm. */
	readingMm: number;
	/** Detection figures (null for a listed window): the run length and the CHIRPS the tests read. */
	runDays: number | null;
	nearChirpsMm: number | null;
	runChirpsMm: number | null;
	/** CHIRPS over the window, as the spreading weighs it (× factor in mode 'monthly'), mm; null until spread. */
	chirpsMm: number | null;
}

export interface RainAccumulations {
	mode: AccumulationMode;
	/** Every window over the whole record, in date order. */
	windows: AccumulationWindow[];
	/** Listed windows not used, with why (one sentence each). */
	skipped: string[];
	/** Spread rain per epoch day on the days of 'spread' and 'noChirps' windows (after spreadAccumulations). */
	values: Map<number, number>;
}

/** The days a window with this status takes over from the zero-run handling: those whose rain the window sets. */
export const claimsDays = (s: AccumulationStatus) => s === 'spread' || s === 'noChirps';

/** Windows the CHIRPS factor fit leaves out, day by day: every one but a reading kept as recorded. */
export function fitExcludedWindows(acc: RainAccumulations | null): { from: number; to: number }[] {
	return (acc?.windows ?? []).filter((w) => w.status !== 'kept');
}

type Span = readonly [number, number];
const spanOf = (r: ExclusionRange): Span => [toEpochDay(r.start), toEpochDay(r.end)];
const overlaps = (xs: readonly Span[], a: number, b: number) => xs.some(([x, y]) => x <= b && a <= y);

/**
 * The accumulation windows of the whole stored record, as a run treats them
 * (spreading not yet done: see spreadAccumulations). null without a catchment
 * rain series.
 *
 * - Listed windows (`addAccumulations`) come first, in date order. One that
 *   overlaps a missing period or an earlier listed window is skipped.
 * - Detections are judged against CHIRPS × the §2.4b factors fitted without
 *   any accumulation left out, with the run's fit period (the factors in every mode, since the test
 *   compares amounts; raw CHIRPS when no month has a factor). A detection is
 *   dropped when its window overlaps a listed window or a missing period (the
 *   hydrologist has said what those days are) or, in zero-run mode
 *   'missing', a keep-dry period (its zeros are confirmed readings).
 * - A detection whose reading day is in a keep-reading period is 'kept'; in
 *   mode 'asRecorded' the rest are 'asRecorded'.
 */
export function rainAccumulations(
	series: Partial<Record<SeriesKind, DailySeries>>,
	zr: ZeroRainSettings,
	chirpsMode: ChirpsBiasMode,
	fit: ChirpsFitOptions = {}
): RainAccumulations | null {
	const sa = series.rain_catchment_mm;
	if (!sa) return null;
	const sb = series.rain_chirps_mm;
	const c0 = toEpochDay(sa.startDate);
	const reading = (day: number) => {
		const v = sa.values[day - c0];
		return isReading(v) ? v : null;
	};
	// Rain-source periods (engine ≥ 0.30.0) replace the catchment reading, so they count as missing here.
	const missing = [...exclusionRanges(zr.missing).map(spanOf), ...(fit.replaced ?? []).map((w): Span => [w.from, w.to])];
	const keepDry = zr.mode === 'missing' ? exclusionRanges(zr.keepDry).map(spanOf) : [];
	const keep = exclusionRanges(zr.keepReadings);
	const windows: AccumulationWindow[] = [];
	const skipped: string[] = [];

	const listed: Span[] = [];
	const added = exclusionRanges(zr.addAccumulations).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
	for (const r of added) {
		const [from, to] = spanOf(r);
		const label = `${r.start} to ${r.end}`;
		if (overlaps(missing, from, to)) {
			skipped.push(`Listed accumulation ${label} overlaps a period listed as missing or a rain-source period, so it is not spread: that period wins.`);
			continue;
		}
		if (overlaps(listed, from, to)) {
			skipped.push(`Listed accumulation ${label} overlaps another listed accumulation, so it is not spread.`);
			continue;
		}
		listed.push([from, to]);
		let total = 0;
		let any = false;
		for (let d = from; d <= to; d++) {
			const v = reading(d);
			if (v === null) continue;
			any = true;
			total += v;
		}
		windows.push({
			start: r.start,
			end: r.end,
			from,
			to,
			source: 'listed',
			reason: r.reason,
			status: !any ? 'noReading' : zr.accumulationMode === 'spread' ? 'spread' : 'asRecorded',
			keptReason: null,
			totalMm: total,
			readingMm: reading(to) ?? 0,
			runDays: null,
			nearChirpsMm: null,
			runChirpsMm: null,
			chirpsMm: null
		});
	}

	if (sb) {
		// The run's fit period too (engine ≥ 0.29.0): a window is judged with its own range's factors.
		const pre = chirpsBiasFactors(series, chirpsMode, zr, [], fit);
		const factor = (day: number) => chirpsFactorOn(pre, day) ?? 1;
		for (const c of detectAccumulations(sa, sb, factor)) {
			if (overlaps(listed, c.from, c.to) || overlaps(missing, c.from, c.to) || overlaps(keepDry, c.from, c.to)) continue;
			const k = keep.find((r) => c.to >= toEpochDay(r.start) && c.to <= toEpochDay(r.end));
			let total = 0;
			for (let d = c.from; d <= c.to; d++) total += reading(d) ?? 0;
			windows.push({
				start: fromEpochDay(c.from),
				end: fromEpochDay(c.to),
				from: c.from,
				to: c.to,
				source: 'detected',
				reason: null,
				status: k ? 'kept' : zr.accumulationMode === 'spread' ? 'spread' : 'asRecorded',
				keptReason: k?.reason ?? null,
				totalMm: total,
				readingMm: c.readingMm,
				runDays: c.runDays,
				nearChirpsMm: c.nearChirpsMm,
				runChirpsMm: c.runChirpsMm,
				chirpsMm: null
			});
		}
	}
	windows.sort((a, b) => a.from - b.from);
	return { mode: zr.accumulationMode, windows, skipped, values: new Map() };
}

/**
 * Spread each 'spread' window's recorded total over its days in proportion
 * to CHIRPS there, × the month's factor in mode 'monthly' (`corr`, the final
 * §2.4b fit, which left these windows out). The reading day takes what is
 * left after the other days, so the window adds up to its total. A window
 * with no CHIRPS rain at all becomes 'noChirps': its total stays on the
 * reading day and its other days run as 0. Fills `acc.values`.
 */
export function spreadAccumulations(acc: RainAccumulations, chirps: DailySeries | undefined, corr: ChirpsCorrection | null): void {
	const h0 = chirps ? toEpochDay(chirps.startDate) : 0;
	const weight = (day: number) => {
		const v = chirps?.values[day - h0];
		if (!isReading(v)) return 0;
		const f = corr && corr.mode === 'monthly' ? (chirpsFactorOn(corr, day) ?? 1) : 1;
		return v * f;
	};
	for (const w of acc.windows) {
		if (w.status !== 'spread') continue;
		let sum = 0;
		for (let d = w.from; d <= w.to; d++) sum += weight(d);
		w.chirpsMm = sum;
		if (!(sum > 0)) {
			w.status = 'noChirps';
			for (let d = w.from; d < w.to; d++) acc.values.set(d, 0);
			acc.values.set(w.to, w.totalMm);
			continue;
		}
		let given = 0;
		for (let d = w.from; d < w.to; d++) {
			const v = (w.totalMm * weight(d)) / sum;
			acc.values.set(d, v);
			given += v;
		}
		acc.values.set(w.to, Math.max(0, w.totalMm - given));
	}
}

/** One window of RunSummary.rainAccumulation: a window that touches the run. */
export interface AccumulationWindowInfo extends Omit<AccumulationWindow, 'from' | 'to'> {
	/** Days of the window inside the run, and the rain the run used on them from the window, mm. */
	daysInRun: number;
	usedMm: number;
}

/** What the run did with multi-day accumulations (RunSummary.rainAccumulation, engine ≥ 0.20.0). */
export interface RainAccumulationInfo {
	mode: AccumulationMode;
	criteria: typeof ACCUMULATION_CRITERIA;
	/** Windows touching the run, in date order. */
	windows: AccumulationWindowInfo[];
	/** Listed windows not used, and why. */
	skipped: string[];
	/** Windows spread (status 'spread'), and the run days whose rain came from a spread or 'noChirps' window. */
	spreadWindows: number;
	spreadDays: number;
	/** Rain on those days, mm. */
	spreadMm: number;
}

export interface AccumulationRun {
	/** 1 on run days whose catchment rain came from a window. */
	mask: Uint8Array;
	info: RainAccumulationInfo;
}

/**
 * Put the windows' rain on the run's aligned catchment rain (in place) and
 * summarise the windows that touch the run.
 */
export function applyAccumulations(acc: RainAccumulations, catchment: (number | null)[], start: number): AccumulationRun {
	const days = catchment.length;
	const mask = new Uint8Array(days);
	const end = start + days - 1;
	let spreadDays = 0;
	let spreadMm = 0;
	const windows: AccumulationWindowInfo[] = [];
	for (const w of acc.windows) {
		if (w.to < start || w.from > end) continue;
		const { from, to, ...rest } = w;
		const info: AccumulationWindowInfo = { ...rest, daysInRun: Math.min(to, end) - Math.max(from, start) + 1, usedMm: 0 };
		if (claimsDays(w.status)) {
			for (let d = Math.max(from, start); d <= Math.min(to, end); d++) {
				const v = acc.values.get(d);
				if (v === undefined) continue;
				catchment[d - start] = v;
				mask[d - start] = 1;
				info.usedMm += v;
				spreadDays++;
				spreadMm += v;
			}
		}
		windows.push(info);
	}
	return {
		mask,
		info: {
			mode: acc.mode,
			criteria: ACCUMULATION_CRITERIA,
			windows,
			skipped: [...acc.skipped],
			spreadWindows: windows.filter((w) => w.status === 'spread').length,
			spreadDays,
			spreadMm
		}
	};
}

const mm = (x: number) => `${Math.round(x)} mm`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_LISTED = 12;
const listed = (parts: string[]) =>
	parts.length > MAX_LISTED ? `${parts.slice(0, MAX_LISTED).join('; ')}; and ${parts.length - MAX_LISTED} more` : parts.join('; ');
const windowLabel = (w: AccumulationWindowInfo) =>
	`${w.start} to ${w.end} (${plural(w.daysInRun, 'day')}, ${mm(w.totalMm)} ` +
	(w.source === 'detected' ? `read on ${w.end}, detected` : `listed: ${w.reason}`) +
	')';

/**
 * The run warnings for the accumulations: what was spread, what stayed on
 * its reading day, what the settings kept or left as recorded, and listed
 * windows skipped. `doubleCounted` = windows left as recorded that end a
 * flagged zero run the run filled from CHIRPS.
 */
export function accumulationWarnings(a: RainAccumulationInfo | null, doubleCounted: readonly AccumulationWindowInfo[] = []): string[] {
	if (!a) return [];
	const out: string[] = [];
	const by = (s: AccumulationStatus) => a.windows.filter((w) => w.status === s);
	const spread = by('spread');
	if (spread.length) {
		out.push(
			`Catchment rain accumulations spread over the days they cover: ${plural(spread.length, 'window')}, ${plural(a.spreadDays, 'run day')}: ` +
				`${listed(spread.map(windowLabel))}. Each looks like several days' rain read on one day after days recorded as 0 or blank ` +
				'(CHIRPS reads rain over the run and little on the reading day). Its recorded total is kept and spread in proportion to bias-corrected CHIRPS; ' +
				'those days are not also filled as a zero run, and they are left out of the CHIRPS factor fit. The stored series is unchanged. ' +
				'Settings → Rain gaps and CHIRPS keeps a reading as recorded.'
		);
	}
	const flat = by('noChirps');
	if (flat.length) {
		out.push(
			`CHIRPS reads no rain over ${plural(flat.length, 'accumulation window')}, so each total stays on its reading day and the other days run as 0 mm: ` +
				`${listed(flat.map(windowLabel))}.`
		);
	}
	const kept = by('kept');
	if (kept.length) {
		out.push(
			`Detected accumulations kept as recorded, as Settings → Rain gaps and CHIRPS says: ` +
				`${listed(kept.map((w) => `${w.end} (${mm(w.readingMm)}: ${w.keptReason})`))}.`
		);
	}
	const asRec = by('asRecorded');
	if (asRec.length) {
		out.push(
			`${plural(asRec.length, 'multi-day accumulation')} run as recorded, because Settings → Rain gaps and CHIRPS says "as recorded": ` +
				`${listed(asRec.map(windowLabel))}.` +
				(doubleCounted.length
					? ` ${plural(doubleCounted.length, 'of them ends', 'of them end')} a flagged zero run that CHIRPS fills, so that rain is counted twice (${doubleCounted.map((w) => w.end).join(', ')}).`
					: '')
		);
	}
	const none = by('noReading');
	if (none.length) out.push(`Listed accumulation ${none.map((w) => `${w.start} to ${w.end}`).join(', ')} has no catchment reading to spread; ignored.`);
	out.push(...a.skipped);
	return out;
}

/** The per-day column: 1 where the catchment rain came from an accumulation window. */
export const ACCUMULATION_COLUMN = {
	key: 'rain_catchment_spread',
	label: 'Catchment rain from a multi-day accumulation (1 = the recorded total spread by CHIRPS)',
	unit: ''
} as const;
