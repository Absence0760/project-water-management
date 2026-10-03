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
// at least ACC_MIN_RUN_DAYS days of 0 or blank catchment rain (engine ≥
// 1.70.0: a blank stretch counts only up to ACC_MAX_BLANK_DAYS; a longer one
// is an outage, which ends the run), on a day
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
//
// A reading that ends a blank outage (engine ≥ 1.70.0, Q31, issue #393): a
// reading of at least ACC_MIN_MM on the first day after more than
// ACC_MAX_BLANK_DAYS blank days, that passes the same CHIRPS tests over the
// outage, may hold the outage's rain (a gauge nobody read) or be one day's
// (a logger back from a fault). The record can't tell which, so in mode
// 'spread' the run sets the reading aside ('setAside'): CHIRPS fills its day
// like the outage's, and it stays out of the CHIRPS fit. Spreading it would
// put a season's CHIRPS fill under one reading's total; keeping it would
// count an unread gauge's rain twice (CHIRPS on the outage, and the reading).
import { fromEpochDay, toEpochDay } from './calendar';
import { exclusionRanges, type ExclusionRange } from './calibrate/provenance';
import type { AccumulationMode, ChirpsBiasMode, DailySeries, SeriesKind, ZeroRainSettings } from './project';
import { chirpsBiasFactors, chirpsFactorOn, type ChirpsCorrection, type ChirpsFitOptions } from './rain';

/** A reading must be at least this, mm, to be judged. */
export const ACC_MIN_MM = 20;
/** … after at least this many days of 0 or blank catchment rain. */
export const ACC_MIN_RUN_DAYS = 3;
/**
 * A stretch of blank days counts towards that run only up to this many days
 * (engine ≥ 1.70.0): a long weekend or a public holiday plus a weekend. A
 * longer one is an outage, which ends the run (docs/model.md §2.4d says why 7).
 */
export const ACC_MAX_BLANK_DAYS = 7;
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
	maxBlankDays: ACC_MAX_BLANK_DAYS,
	readingDayShare: ACC_READING_DAY_SHARE,
	runShare: ACC_RUN_SHARE
} as const;

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;
const isBlank = (v: number | null | undefined) => v == null || !Number.isFinite(v);

/** A reading that looks like a multi-day accumulation. */
export interface AccumulationCandidate {
	/** First day of the window (epoch day) and the reading day, its last. */
	from: number;
	to: number;
	/** The reading, mm. */
	readingMm: number;
	/**
	 * Days of 0 or blank rain before the reading (the whole run, not capped):
	 * back to the reading before, a blank outage or the record's start. For an
	 * outage reading, the outage's blank days.
	 */
	runDays: number;
	/** CHIRPS on the reading day and the days either side, × factor, mm. */
	nearChirpsMm: number;
	/** CHIRPS over the window's run days (an outage reading: the outage's last 92 days) except the day before the reading, × factor, mm. */
	runChirpsMm: number;
	/** Engine ≥ 1.70.0: present on a reading that ends a blank outage (more than ACC_MAX_BLANK_DAYS blank days; rainAccumulations reads days listed as missing as blank), its length; the window is then the reading day alone. */
	outageDays?: number;
}

/**
 * Accumulation candidates in the catchment rain, over its whole record.
 * `factor(day)` scales CHIRPS on an epoch day (the fitted month factor; 1 for
 * raw). A day with no CHIRPS value counts as 0 CHIRPS, except that the
 * reading day itself must have one. Windows never overlap: each run ends at
 * the reading before the next.
 *
 * Engine ≥ 1.70.0: the run is the 0 or blank days before the reading back to
 * the reading before, the record's start, or a stretch of more than
 * ACC_MAX_BLANK_DAYS consecutive blank days (an outage), whichever is
 * nearest; the outage's days and everything before it are not in the run.
 * A blank stretch of up to ACC_MAX_BLANK_DAYS counts like zeros. A reading
 * straight after an outage (no run) that passes the same tests over the
 * outage's last ACC_MAX_RUN_DAYS days is a candidate whose window is its own
 * day, with `outageDays` set. Pure.
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
	let run = 0; // 0 or blank days immediately before index i, back to a reading, an outage or the record's start
	let blank = 0; // blank days immediately before index i (the whole stretch)
	for (let i = 0; i < vals.length; i++) {
		const v = vals[i];
		if (isBlank(v)) {
			blank++;
			// The stretch has become an outage: neither it nor anything before it is in the run.
			if (blank > ACC_MAX_BLANK_DAYS) run = 0;
			else run++;
			continue;
		}
		if (v === 0) {
			blank = 0;
			run++;
			continue;
		}
		const runBefore = run;
		const outage = blank > ACC_MAX_BLANK_DAYS ? blank : 0; // runBefore is 0 whenever outage > 0
		run = 0;
		blank = 0;
		if (!isReading(v) || v < ACC_MIN_MM) continue;
		if (runBefore < ACC_MIN_RUN_DAYS && outage === 0) continue;
		const day = c0 + i;
		if (!isReading(chirps.values[day - h0])) continue;
		const near = h(day - 1) + h(day) + h(day + 1);
		if (!(near < ACC_READING_DAY_SHARE * v)) continue;
		const w = Math.min(outage || runBefore, ACC_MAX_RUN_DAYS);
		let runMm = 0;
		for (let d = day - w; d <= day - 2; d++) runMm += h(d);
		if (!(runMm >= ACC_RUN_SHARE * v)) continue;
		if (outage) out.push({ from: day, to: day, readingMm: v, runDays: outage, nearChirpsMm: near, runChirpsMm: runMm, outageDays: outage });
		else out.push({ from: day - w, to: day, readingMm: v, runDays: runBefore, nearChirpsMm: near, runChirpsMm: runMm });
	}
	return out;
}

/**
 * What a run does with a window. 'spread': its total is spread by CHIRPS.
 * 'noChirps': CHIRPS reads no rain over it, so the total stays on the
 * reading day (its other days run as 0). 'asRecorded': the mode leaves
 * detections as recorded. 'kept': a keep-reading period confirms it as one
 * day's rain. 'noReading': a listed window with no reading to spread.
 * 'setAside' (engine ≥ 1.70.0): a reading that ends a blank outage, treated
 * as missing: CHIRPS (then forecast) fills its day.
 */
export type AccumulationStatus = 'spread' | 'noChirps' | 'asRecorded' | 'kept' | 'noReading' | 'setAside';

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
	/** Engine ≥ 1.70.0: the blank outage a detected reading ends, in days; null for any other window (absent before 1.70.0). */
	outageDays: number | null;
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
 *   'missing', a keep-dry period (its zeros are confirmed readings). The
 *   detection reads days listed as missing as blank (engine ≥ 1.70.0), so a
 *   listed stretch longer than ACC_MAX_BLANK_DAYS is an outage: it ends a run,
 *   and a reading straight after it can be set aside.
 * - A detection whose reading day is in a keep-reading period is 'kept'; in
 *   mode 'asRecorded' the rest are 'asRecorded'. In mode 'spread', a reading
 *   that ends a blank outage (its window is its own day) is 'setAside'.
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
			chirpsMm: null,
			outageDays: null
		});
	}

	if (sb) {
		// The run's fit period too (engine ≥ 0.29.0): a window is judged with its own range's factors.
		const pre = chirpsBiasFactors(series, chirpsMode, zr, [], fit);
		const factor = (day: number) => chirpsFactorOn(pre, day) ?? 1;
		// Days listed as missing (engine ≥ 1.70.0) are unknown, as blank days are: the detection reads them as blank,
		// so a listed stretch of more than ACC_MAX_BLANK_DAYS (alone or with blank days next to it) is an outage too.
		// A rain-source period is not: its days have rain, from the period's series.
		const listedMissing = exclusionRanges(zr.missing).map(spanOf);
		let view = sa;
		if (listedMissing.length) {
			const values = sa.values.slice();
			for (const [a, b] of listedMissing) for (let d = Math.max(a, c0); d <= Math.min(b, c0 + values.length - 1); d++) values[d - c0] = null;
			view = { startDate: sa.startDate, values };
		}
		for (const c of detectAccumulations(view, sb, factor)) {
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
				status: k ? 'kept' : zr.accumulationMode !== 'spread' ? 'asRecorded' : c.outageDays ? 'setAside' : 'spread',
				keptReason: k?.reason ?? null,
				totalMm: total,
				readingMm: c.readingMm,
				runDays: c.runDays,
				nearChirpsMm: c.nearChirpsMm,
				runChirpsMm: c.runChirpsMm,
				chirpsMm: null,
				outageDays: c.outageDays ?? null
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
	/**
	 * Days of the window inside the run, and the rain the run used on them from
	 * the window, mm. For a 'setAside' reading, the rain the run used on its
	 * day instead (CHIRPS × factor, else forecast; 0 when neither has a value).
	 */
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
		// A reading set aside is blank from here on, so the rain-used pick falls back to CHIRPS, then forecast.
		if (w.status === 'setAside') for (let d = Math.max(from, start); d <= Math.min(to, end); d++) catchment[d - start] = null;
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

/**
 * Record what stood in for each 'setAside' reading in the run: `fallback(t)`
 * is the rain used on run day t (corrected CHIRPS ?? forecast), null for none.
 */
export function finishSetAside(a: AccumulationRun, start: number, fallback: (t: number) => number | null): void {
	for (const w of a.info.windows) {
		if (w.status !== 'setAside') continue;
		w.usedMm = fallback(toEpochDay(w.end) - start) ?? 0;
	}
}

const mm = (x: number) => `${Math.round(x)} mm`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_LISTED = 12;
const listed = (parts: string[]) =>
	parts.length > MAX_LISTED ? `${parts.slice(0, MAX_LISTED).join('; ')}; and ${parts.length - MAX_LISTED} more` : parts.join('; ');
const windowLabel = (w: AccumulationWindowInfo) =>
	w.outageDays
		? `${w.end} (${mm(w.totalMm)} read after a ${w.outageDays}-day outage)`
		: `${w.start} to ${w.end} (${plural(w.daysInRun, 'day')}, ${mm(w.totalMm)} ` +
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
	const aside = by('setAside');
	if (aside.length) {
		out.push(
			`${plural(aside.length, 'catchment reading')} after an outage set aside as missing: ` +
				`${listed(aside.map((w) => `${w.end} (${mm(w.readingMm)} read after a ${w.outageDays ?? 0}-day outage; ${mm(w.usedMm)} used instead)`))}. ` +
				`Each is ${ACC_MIN_MM} mm or more on the first day after more than ${ACC_MAX_BLANK_DAYS} days blank or listed as missing, on a day CHIRPS was nearly dry after CHIRPS rained over the outage, ` +
				"so it may hold the outage's rain (a gauge nobody read) rather than one day's. " +
				'The run fills its day like the outage, from bias-corrected CHIRPS (then forecast rain), and leaves it out of the CHIRPS factor fit. The stored series is unchanged. ' +
				'Settings → Rain gaps and CHIRPS keeps a reading as recorded (keep readings) or spreads it over days you list (add accumulations).'
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
					? ` ${plural(doubleCounted.length, 'of them ends', 'of them end')} a flagged zero run or a blank outage that CHIRPS fills, so that rain may be counted twice (${doubleCounted.map((w) => w.end).join(', ')}).`
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
