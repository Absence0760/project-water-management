// Per-day quality flags on the observed flow and the rain (calibration
// research CR-18, issue #66), and what automatic calibration does with them
// (CR-19). docs/model.md §2.10h.
//
// Flow: each day of a calibration record gets one class, the strongest that
// applies, in FLOW_FLAG_PRECEDENCE order (missing wins):
// - missing: no reading (blank, NaN or negative, as alignFlow reads it);
// - infilled: a gap-filled value, not a reading (observedInfillMask, from
//   settings.flowGapFill's fill, engine ≥ 1.23.0, docs/model.md §2.10i);
// - periodHigh: inside one of the record's low-flow periods
//   (settings.qualityFlags.lowFlowPeriods, engine ≥ 1.90.0, issue #557), a
//   reading above its threshold: only the low flows are valid there, so the
//   day is always left out, never censored. It outranks suspect: a wrong
//   high reading is what trips the outlier check, and 'include' for suspect
//   days must not score it;
// - suspect: an outlier or a non-zero flat stretch by the Data checks
//   (quality.ts seriesRowFlags, under the project's settings.dataQuality
//   limits, the same the run warnings use), or a zero-flow stretch the
//   river-stops rule doesn't trust (engine ≥ 1.81.0, issue #507 item 2,
//   audit C3, zeroFlowSuspect). With the months the river is known to stop
//   listed (settings.qualityFlags.zeroFlowMonths), a stretch wholly outside
//   them is suspect at any length, and one that overlaps them is trusted as
//   the river stopping and scored as long as it runs no more than
//   ZERO_FLOW_TRUST_MAX_DAYS beyond them on each side (engine 1.84.0, issue
//   #523 A1; 1.81.0 – 1.83.x trusted only a stretch wholly inside them).
//   With none listed, a stretch longer than ZERO_FLOW_TRUST_MAX_DAYS is
//   suspect. Trusting a zero stretch follows GSIM Part 2, which flags only
//   runs of one value above zero (Gudmundsson et al. 2018, ESSD 10, 787); a
//   logger that fails also
//   reads zero, which is why the rest are "check with the client". Engine
//   1.62.0 – 1.80.0 trusted every zero stretch (QF-3). An exclusion period
//   stays the manual override;
// - aboveRating: above the highest field gauging (settings.qualityFlags
//   .ratings), so the flow comes from an extrapolated rating curve;
// - belowRating: above zero but below the lowest gauging;
// - humanUse: human use dominates the flow. Defined, never set: deriving it
//   needs the modelled abstraction, which depends on the parameters being
//   fitted (a flag that moves during the fit), or a user-entered period list.
//   CR-25 is that later item.
// - inRange: none of the above (with no rating recorded: not flagged).
//
// Rain: each day's rain as calibration reads it is 'observed' (the catchment
// gauge's own reading), 'infilled' (CHIRPS, forecast or a rain-source
// period's series stands in, including a zero run set aside as missing,
// CR-20) or 'missing'.
//
// The flags never change a stored series. They decide which days the fit's
// objective scores (scoringDays) and what the data-quality panel (CR-22)
// shows.
import { monthOfEpochDay, toEpochDay, waterYearLabel, waterYearOf } from '../calendar';
import type { CalibrationFlowKind, DailySeries, DataQualitySettings } from '../project';
import { seriesRowFlags } from '../quality';
import { RAIN_SOURCE_CODE } from '../rainSourcePeriods';
import type { CalibrationExclusion } from './provenance';
import { lowFlowThresholds, ratingOf, ZERO_FLOW_TRUST_MAX_DAYS, zeroFlowMonthsText, type AboveRatingUse, type GaugeRating, type LowFlowPeriod, type QualityFlagSettings } from './qualityFlagSettings';

export * from './qualityFlagSettings';

/**
 * Flow classes. The index is the day's code, stored in a run's
 * `observed_flow_quality` column, so a class is only ever appended: periodHigh
 * (engine ≥ 1.90.0) is code 7 although it ranks below infilled. The first seven
 * are weakest first; FLOW_FLAG_PRECEDENCE is the order a day's class is chosen in.
 */
export const FLOW_DAY_FLAGS = ['inRange', 'humanUse', 'belowRating', 'aboveRating', 'suspect', 'infilled', 'missing', 'periodHigh'] as const;
export type FlowDayFlag = (typeof FLOW_DAY_FLAGS)[number];
export const FLOW_FLAG_CODE = Object.fromEntries(FLOW_DAY_FLAGS.map((f, i) => [f, i])) as Record<FlowDayFlag, number>;
/** Flow classes, weakest first: a day that qualifies for several takes the last (flowDayFlags). */
export const FLOW_FLAG_PRECEDENCE: readonly FlowDayFlag[] = ['inRange', 'humanUse', 'belowRating', 'aboveRating', 'suspect', 'periodHigh', 'infilled', 'missing'];

export const FLOW_FLAG_LABEL: Record<FlowDayFlag, string> = {
	inRange: 'In the gauged range',
	humanUse: 'Human use dominant',
	belowRating: 'Below the lowest gauging',
	aboveRating: 'Above the highest gauging',
	suspect: 'Suspect (outlier, flat stretch or doubtful zero flow)',
	infilled: 'Infilled',
	missing: 'Missing',
	periodHigh: 'Above a low-flow period’s threshold'
};

/** Rain classes: the index is the day's code. */
export const RAIN_DAY_FLAGS = ['observed', 'infilled', 'missing'] as const;
export type RainDayFlag = (typeof RAIN_DAY_FLAGS)[number];

/**
 * The per-day fill mask of a gap-filled observed flow record, aligned to the
 * run (1 = infilled), or null when nothing was filled: from the run's own
 * fill (PreparedRun.flowFill[kind], settings.flowGapFill, ../flowGapFill.ts,
 * engine ≥ 1.23.0), whose per-day code is 1 (interpolated) or 2 (from a donor
 * record) on a filled day. Every fit, report and panel picks the `infilled`
 * class up from here.
 */
export function observedInfillMask(fill: { code: ArrayLike<number> } | null | undefined): Uint8Array | null {
	if (!fill) return null;
	const out = new Uint8Array(fill.code.length);
	let any = false;
	for (let t = 0; t < out.length; t++) if (fill.code[t]) out[t] = 1, (any = true);
	return any ? out : null;
}

export interface FlowFlagInput {
	kind: CalibrationFlowKind;
	/** The stored record (null values, NaN and negatives are missing). */
	series: DailySeries | undefined;
	/** The run's first epoch day and length. */
	start: number;
	days: number;
	rating?: GaugeRating | null;
	/** 1 on run days whose value was gap-filled (observedInfillMask). */
	infilled?: ArrayLike<number> | null;
	/** The project's data-check limits (settings.dataQuality): which days are outliers or flat stretches. Absent = the defaults. */
	dataQuality?: DataQualitySettings;
	/**
	 * false: leave the suspect class out (no day is suspect). A resumed run whose input lacks the record's history
	 * (../run.ts) can't judge it: outliers, flat stretches and zero stretches are read over the whole stored record. Default true.
	 */
	suspect?: boolean;
	/** settings.qualityFlags.zeroFlowMonths: the months the river is known to stop (engine ≥ 1.81.0). Absent = none. */
	zeroFlowMonths?: readonly number[];
	/** settings.qualityFlags.lowFlowPeriods (engine ≥ 1.90.0, issue #557): only this record's periods apply. Absent = none. */
	lowFlowPeriods?: readonly LowFlowPeriod[];
}

/**
 * 1 on each stored value of `s` that is in a zero-flow stretch the
 * river-stops rule doesn't trust (engine ≥ 1.81.0, issue #507 item 2;
 * revised engine 1.84.0, issue #523 A1; docs/model.md §2.10h). A stretch is
 * a maximal run of consecutive readings of exactly 0 (a blank, NaN or
 * negative day ends it), judged whole: all its days are suspect or none.
 * - With `months` listed, a stretch with no day in them is suspect at any
 *   length. One that overlaps them is trusted as the river stopping as long
 *   as it runs no more than ZERO_FLOW_TRUST_MAX_DAYS beyond them on each
 *   side: at most that many days before its first day in the months, and at
 *   most that many after its last (counted per side, not in total, so
 *   mid-January to mid-May is trusted with Feb–Apr). Inside the stretch,
 *   every day outside the months must lie within ZERO_FLOW_TRUST_MAX_DAYS of
 *   one of its days inside them, so a gap between two listed months (or a
 *   whole year at zero) is judged the same way. Month membership is read day
 *   by day, so months that wrap the year end (Dec–Feb) need nothing special.
 * - With no months, a stretch longer than ZERO_FLOW_TRUST_MAX_DAYS is suspect.
 * Read over the whole stored record, so a stretch's length doesn't depend on
 * the run window. Engine 1.81.0 – 1.83.x trusted only a stretch wholly inside
 * the months.
 */
export function zeroFlowSuspect(s: DailySeries, months: readonly number[] = []): Uint8Array {
	const out = new Uint8Array(s.values.length);
	const d0 = toEpochDay(s.startDate);
	const v = s.values;
	const max = ZERO_FLOW_TRUST_MAX_DAYS;
	for (let i = 0; i < v.length; ) {
		if (v[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < v.length && v[j] === 0) j++;
		if (months.length === 0 ? j - i > max : !zeroStretchTrusted(d0 + i, d0 + j, months, max)) out.fill(1, i, j);
		i = j;
	}
	return out;
}

/**
 * Whether the zero stretch over epoch days [from, to) overlaps `months` and
 * every day of it outside them lies within `max` days of one of its days
 * inside them: at most `max` days before the first, at most `max` after the
 * last, and a gap between two of its in-month days of at most 2 × `max`.
 */
function zeroStretchTrusted(from: number, to: number, months: readonly number[], max: number): boolean {
	// The last in-month day seen, null = none yet. Not a -1 sentinel: an epoch day before 1970-01-01 is negative.
	let lastIn: number | null = null;
	for (let d = from; d < to; d++) {
		if (!months.includes(monthOfEpochDay(d))) continue;
		const gap = lastIn === null ? d - from : d - lastIn - 1;
		if (gap > (lastIn === null ? max : 2 * max)) return false;
		lastIn = d;
	}
	return lastIn !== null && to - 1 - lastIn <= max;
}

/** Each run day's flow class code (FLOW_FLAG_CODE). */
export function flowDayFlags(x: FlowFlagInput): Uint8Array {
	const out = new Uint8Array(x.days).fill(FLOW_FLAG_CODE.missing);
	const s = x.series;
	if (!s) return out;
	const offset = toEpochDay(s.startDate) - x.start;
	const rows = x.suspect === false ? null : x.dataQuality ? seriesRowFlags(x.kind, s, x.dataQuality) : seriesRowFlags(x.kind, s);
	const zeroSuspect = x.suspect === false ? null : zeroFlowSuspect(s, x.zeroFlowMonths);
	const hi = x.rating?.gaugedMaxM3s ?? null;
	const lo = x.rating?.gaugedMinM3s ?? null;
	const thr = lowFlowThresholds(x.lowFlowPeriods, x.kind, x.start, x.days);
	const from = Math.max(0, -offset);
	const to = Math.min(s.values.length, x.days - offset);
	for (let i = from; i < to; i++) {
		const t = i + offset;
		const v = s.values[i];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
		// A reading above a low-flow period's threshold is wrong whatever the data checks say of it, so periodHigh
		// outranks suspect (a wrong high reading is just what trips the outlier check): it is always left out.
		out[t] = x.infilled?.[t]
			? FLOW_FLAG_CODE.infilled
			: thr && v > thr[t]!
				? FLOW_FLAG_CODE.periodHigh
				: (rows && (rows.outlier[i] || (rows.flatline[i] && v !== 0))) || zeroSuspect?.[i]
					? FLOW_FLAG_CODE.suspect
					: hi !== null && v > hi
					? FLOW_FLAG_CODE.aboveRating
					: lo !== null && v > 0 && v < lo
						? FLOW_FLAG_CODE.belowRating
						: FLOW_FLAG_CODE.inRange;
	}
	// A gap-filled day has no stored reading (the fill never touches the stored record), so it is
	// marked from the mask whatever the loop above left it as.
	if (x.infilled) for (let t = 0; t < x.days; t++) if (x.infilled[t]) out[t] = FLOW_FLAG_CODE.infilled;
	return out;
}

/**
 * The gauged ranges that apply at a calibration site (engine ≥ 1.41.0):
 * settings.qualityFlags.ratings are the outlet records' ratings, so a
 * gauge's record inside the network has none and no day of it can be
 * flagged as extrapolated. The treatments stay the project's.
 */
export const siteQualityFlags = (q: QualityFlagSettings, siteNodeId: string | null): QualityFlagSettings => {
	if (siteNodeId === null) return q;
	// The low-flow periods (engine ≥ 1.90.0) are the outlet records' too.
	const { lowFlowPeriods: _p, ...rest } = q;
	return { ...rest, ratings: {} };
};

export interface RecordFlowFlagInput {
	kind: CalibrationFlowKind;
	/** The record as stored at the site (the outlet's `kind` series, or the gauge's GaugeSeriesKey series). */
	series: DailySeries | undefined;
	start: number;
	days: number;
	settings: { qualityFlags: QualityFlagSettings; dataQuality?: DataQualitySettings };
	/** settings.calibrationSiteNodeId: null = the outlet. */
	siteNodeId: string | null;
	/** The run's gap-filled records (PreparedRun.flowFill): only the outlet's records are filled. */
	flowFill?: Partial<Record<string, { code: ArrayLike<number> }>> | null;
	/** false: leave the suspect class out (FlowFlagInput.suspect). */
	suspect?: boolean;
}

/**
 * The per-day classes of the record calibration scores, as both the fit
 * (./calibrate.ts) and the run's `observed_flow_quality` column (../run.ts)
 * read them, so the two can't drift: at the outlet with its gauged range
 * and gap filling, at an inner gauge with neither (siteQualityFlags).
 */
export function recordFlowFlags(x: RecordFlowFlagInput): Uint8Array {
	const q = siteQualityFlags(x.settings.qualityFlags, x.siteNodeId);
	return flowDayFlags({
		kind: x.kind,
		series: x.series,
		start: x.start,
		days: x.days,
		rating: ratingOf(q, x.kind),
		infilled: x.siteNodeId === null ? observedInfillMask(x.flowFill?.[x.kind]) : null,
		zeroFlowMonths: q.zeroFlowMonths ?? [],
		...(q.lowFlowPeriods?.length ? { lowFlowPeriods: q.lowFlowPeriods } : {}),
		...(x.settings.dataQuality ? { dataQuality: x.settings.dataQuality } : {}),
		...(x.suspect === false ? { suspect: false } : {})
	});
}

/** A day whose class is neither in the gauged range nor missing: what the run's quality column is stored for. */
export function hasFlaggedDay(flags: ArrayLike<number>): boolean {
	for (let t = 0; t < flags.length; t++) if (flags[t] !== FLOW_FLAG_CODE.inRange && flags[t] !== FLOW_FLAG_CODE.missing) return true;
	return false;
}

/**
 * The run column of the scored record's per-day classes (engine ≥ 1.48.0,
 * docs/model.md §2.10h): each day's FLOW_FLAG_CODE, stored beside the
 * scored `observed_flow` (the catchment's, or the calibration site's node),
 * only when some day is flagged (hasFlaggedDay). The label spells the codes
 * out, so the daily CSV reads without the docs.
 */
export const FLOW_QUALITY_COLUMN = {
	key: 'observed_flow_quality',
	label: `Observed flow quality flag (${FLOW_DAY_FLAGS.map((f, i) => `${i} = ${FLOW_FLAG_LABEL[f].replace(/^./, (c) => c.toLowerCase())}`).join(', ')})`,
	unit: ''
} as const;

/**
 * Each run day's rain class code (RAIN_DAY_FLAGS): observed where the
 * catchment gauge's own reading drives the day, infilled where another source
 * stands in, missing where nothing does. `catchment` is the catchment rain as
 * the run aligns it (a zero run set aside is blank), `used` the rain the run
 * uses, `rainSource` the per-day rain_source column when there are
 * rain-source periods.
 */
export function rainDayFlags(catchment: ArrayLike<number | null>, used: ArrayLike<number | null>, rainSource: ArrayLike<number> | null = null): Uint8Array {
	const out = new Uint8Array(used.length);
	for (let t = 0; t < used.length; t++) {
		const own = catchment[t] != null && (!rainSource || rainSource[t] === RAIN_SOURCE_CODE.catchment);
		out[t] = own ? 0 : used[t] != null ? 1 : 2;
	}
	return out;
}

/** Days the fit scores, and the censoring bound on each (m³/day; NaN = not censored). */
export interface ScoringDays {
	idx: Int32Array;
	censor: Float64Array | null;
}

const SEC_PER_DAY = 86_400;

/**
 * Which of the candidate days (observed, in the window, outside the
 * exclusion periods) the fit scores under the settings, and the censoring
 * bound on each above-rating day when they are censored.
 */
export function scoringDays(candidates: ArrayLike<number>, flags: Uint8Array, q: QualityFlagSettings, rating: GaugeRating | null, days: number): ScoringDays {
	const idx: number[] = [];
	let censor: Float64Array | null = null;
	const hi = rating?.gaugedMaxM3s ?? null;
	for (let i = 0; i < candidates.length; i++) {
		const t = candidates[i]!;
		const f = FLOW_DAY_FLAGS[flags[t]!]!;
		// periodHigh (engine ≥ 1.90.0): a wrong high reading, always left out.
		if (f === 'missing' || f === 'periodHigh') continue;
		if (f === 'infilled' && q.infilled === 'exclude') continue;
		if (f === 'suspect' && q.suspect === 'exclude') continue;
		if (f === 'belowRating' && q.belowRating === 'exclude') continue;
		if (f === 'aboveRating' && q.aboveRating === 'exclude') continue;
		if (f === 'aboveRating' && q.aboveRating === 'censor' && hi !== null) {
			if (!censor) censor = new Float64Array(days).fill(NaN);
			censor[t] = hi * SEC_PER_DAY;
		}
		idx.push(t);
	}
	return { idx: Int32Array.from(idx), censor };
}

/**
 * The observed values a score reads on censored days: the simulated flow
 * where it reaches the highest gauging (no error), else the highest gauging
 * (the least the observation says). Only positions in `idx` change; returns
 * `obs` itself when nothing is censored.
 */
export function censoredObserved(obs: Float64Array, sim: ArrayLike<number>, idx: ArrayLike<number>, censor: Float64Array | null): Float64Array {
	if (!censor) return obs;
	const out = obs.slice();
	for (let i = 0; i < idx.length; i++) {
		const t = idx[i]!;
		const c = censor[t]!;
		if (!Number.isNaN(c)) out[t] = sim[t]! >= c ? sim[t]! : c;
	}
	return out;
}

// ---------------------------------------------------------------------------
// The data-quality summary (CR-22)
// ---------------------------------------------------------------------------

/** Rain infilled on more than this share of the scored days is called out. */
export const RAIN_INFILL_NOTE_SHARE = 0.2;
/** Flags leaving out more than this share of the candidate days is called out. */
export const LEFT_OUT_NOTE_SHARE = 0.25;

export interface DayQuality {
	/** The record fitted to. */
	flowKind: CalibrationFlowKind;
	/** Its gauged range, when one is recorded. */
	rating: GaugeRating | null;
	/** How each class was treated. */
	use: Omit<QualityFlagSettings, 'ratings' | 'zeroFlowMonths' | 'lowFlowPeriods'>;
	/** The months the river is known to stop, as the flags read them (settings.qualityFlags.zeroFlowMonths, engine ≥ 1.81.0). Absent on an older report. */
	zeroFlowMonths?: number[];
	/** Days in the calibration window outside the exclusion periods. */
	windowDays: number;
	/** Those days by flow class (periodHigh absent on a report from before engine 1.90.0). */
	flow: Record<Exclude<FlowDayFlag, 'periodHigh'>, number> & { periodHigh?: number };
	/** Days the objective scored (censored ones included). */
	scoredDays: number;
	/** Scored days censored at the highest gauging. */
	censoredDays: number;
	/** Days with a reading that the flags left out. */
	leftOutDays: number;
	/**
	 * Suspect days whose flow is zero: from engine 1.81.0 the zero-flow stretches the river-stops rule doesn't trust
	 * (zeroFlowSuspect); 0 in engine 1.62.0 – 1.80.0, which never called a zero stretch suspect (QF-3).
	 */
	suspectZeroDays: number;
	/**
	 * Days in the window that are zero flow in a stretch longer than ZERO_FLOW_TRUST_MAX_DAYS that is trusted, and
	 * so scored as a river that stopped (engine ≥ 1.81.0: only a stretch over settings.qualityFlags.zeroFlowMonths,
	 * wholly inside them up to 1.83.x, overlapping them and at most ZERO_FLOW_TRUST_MAX_DAYS beyond on each side from 1.84.0; engine
	 * 1.62.0 – 1.80.0: any zero stretch of the flow flat-line cap or longer). Absent on an older report.
	 */
	longZeroDays?: number;
	/** The scored days' rain by class, and how many fall in a zero-rain run set aside as missing (CR-20); null without rain. */
	rain: { observed: number; infilled: number; missing: number; zeroRunDays: number } | null;
	/** What the record can't support, in plain words. */
	notes: string[];
}

const RECORD: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'gauge record', flow_logger_m3s: 'logger record' };
const n = (v: number) => v.toLocaleString('en-US').replace(/,/g, ' ');
const m3s = (v: number) => `${+v.toPrecision(3)} m³/s`;
const days = (v: number) => `${n(v)} day${v === 1 ? '' : 's'}`;
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;

export interface DayQualityInput {
	flowKind: CalibrationFlowKind;
	settings: QualityFlagSettings;
	/** Candidate days (observed or not: every day in the window outside the exclusion periods). */
	windowIdx: ArrayLike<number>;
	flags: Uint8Array;
	scoring: ScoringDays;
	/** The observed record, m³/day (NaN = missing). */
	observed: Float64Array;
	/** Rain class codes per run day, null without rain. */
	rainFlags: Uint8Array | null;
	/** 1 on run days in a zero-rain run set aside as missing, null without one. */
	zeroRunMask: ArrayLike<number> | null;
}

/** Counts and notes for the data-quality panel. */
export function dayQuality(x: DayQualityInput): DayQuality {
	const rating = ratingOf(x.settings, x.flowKind);
	const flow = Object.fromEntries(FLOW_DAY_FLAGS.map((f) => [f, 0])) as Record<FlowDayFlag, number>;
	let suspectZeroDays = 0;
	for (let i = 0; i < x.windowIdx.length; i++) {
		const t = x.windowIdx[i]!;
		const f = FLOW_DAY_FLAGS[x.flags[t]!]!;
		flow[f]++;
		if (f === 'suspect' && x.observed[t] === 0) suspectZeroDays++;
	}
	// Zero flow held for a long stretch and trusted (engine ≥ 1.81.0: over the river-stops months; from 1.84.0, up to
	// ZERO_FLOW_TRUST_MAX_DAYS beyond them on each side): run days in a
	// run of consecutive zero readings longer than ZERO_FLOW_TRUST_MAX_DAYS whose class is a reading's.
	const inLongZero = new Uint8Array(x.observed.length);
	for (let t = 0; t < x.observed.length; ) {
		let j = t;
		while (j < x.observed.length && x.observed[j] === 0) j++;
		if (j - t > ZERO_FLOW_TRUST_MAX_DAYS) inLongZero.fill(1, t, j);
		t = j > t ? j : t + 1;
	}
	let longZeroDays = 0;
	for (let i = 0; i < x.windowIdx.length; i++) {
		const t = x.windowIdx[i]!;
		const f = FLOW_DAY_FLAGS[x.flags[t]!];
		if (inLongZero[t] && f !== 'suspect' && f !== 'missing' && f !== 'infilled') longZeroDays++;
	}
	const scoredDays = x.scoring.idx.length;
	let censoredDays = 0;
	if (x.scoring.censor) for (const t of x.scoring.idx) if (!Number.isNaN(x.scoring.censor[t]!)) censoredDays++;
	const withReading = x.windowIdx.length - flow.missing;
	const leftOutDays = withReading - scoredDays;
	let rain: DayQuality['rain'] = null;
	if (x.rainFlags) {
		rain = { observed: 0, infilled: 0, missing: 0, zeroRunDays: 0 };
		for (const t of x.scoring.idx) {
			rain[RAIN_DAY_FLAGS[x.rainFlags[t]!]!]++;
			if (x.zeroRunMask?.[t]) rain.zeroRunDays++;
		}
	}
	const { ratings: _r, zeroFlowMonths: _z, lowFlowPeriods: _p, ...use } = x.settings;
	const notes: string[] = [];
	const rec = RECORD[x.flowKind];
	if (!rating?.gaugedMaxM3s) {
		notes.push(
			`No highest gauging is recorded for the ${rec} (Settings → Calibration record → Quality flags for Fit automatically, the Highest gauging column), so no day can be flagged as extrapolated: flood days count as readings, however far the rating curve was extended beyond its gaugings.`
		);
	}
	if (flow.aboveRating && rating?.gaugedMaxM3s) {
		const hi = m3s(rating.gaugedMaxM3s);
		notes.push(
			use.aboveRating === 'censor'
				? `${days(flow.aboveRating)} read above the highest gauging (${hi}). The fit only asks the model to reach ${hi} on them, so it doesn't constrain flood peaks or flood volumes.`
				: use.aboveRating === 'exclude'
					? `${days(flow.aboveRating)} above the highest gauging (${hi}) are left out: the fit says nothing about flows above ${hi}.`
					: `${days(flow.aboveRating)} above the highest gauging (${hi}) are scored as recorded, although they come from the rating's extrapolation.`
		);
	}
	if (flow.belowRating && rating?.gaugedMinM3s) {
		const lo = m3s(rating.gaugedMinM3s);
		notes.push(
			use.belowRating === 'exclude'
				? `${days(flow.belowRating)} below the lowest gauging (${lo}) are left out, so the fit doesn't test low flows under ${lo}: check EWR low flows against the record itself.`
				: `${days(flow.belowRating)} below the lowest gauging (${lo}) are scored as recorded, although the rating is extrapolated there.`
		);
	}
	if (flow.suspect) {
		notes.push(
			use.suspect === 'exclude'
				? `${days(flow.suspect)} flagged suspect by the Data checks (outliers or flat stretches) are left out.`
				: `${days(flow.suspect)} flagged suspect by the Data checks (outliers or flat stretches) are scored as recorded.`
		);
		// Zero-flow stretches the river-stops rule doesn't trust (engine ≥ 1.81.0): check with the client.
		if (suspectZeroDays && use.suspect === 'exclude') {
			const months = x.settings.zeroFlowMonths ?? [];
			const why = months.length
				? `in stretches wholly outside the months the river is known to stop (${zeroFlowMonthsText(months)}), or running more than ${ZERO_FLOW_TRUST_MAX_DAYS} days beyond them`
				: `held for more than ${ZERO_FLOW_TRUST_MAX_DAYS} days, with no months listed in which the river is known to stop`;
			notes.push(
				`${n(suspectZeroDays)} of the suspect days ${suspectZeroDays === 1 ? 'is' : 'are'} zero flow ${why}, so the fit leaves them out: check with the client whether the river stopped or the logger failed. ` +
					`If the river stops in those months, list them under Settings → Calibration record → Months the river stops; if the logger failed, an exclusion period records it.`
			);
		}
	}
	if (longZeroDays) {
		notes.push(
			`${days(longZeroDays)} ${longZeroDays === 1 ? 'is' : 'are'} zero flow held for more than ${ZERO_FLOW_TRUST_MAX_DAYS} days in stretches over the months the river is known to stop (${zeroFlowMonthsText(x.settings.zeroFlowMonths)}), running at most ${ZERO_FLOW_TRUST_MAX_DAYS} days beyond them. They are scored as a river that stopped flowing. If the logger or gauge failed instead, leave those dates out with an exclusion period.`
		);
	}
	if (flow.periodHigh) {
		const periods = (x.settings.lowFlowPeriods ?? []).filter((p) => p.kind === x.flowKind);
		notes.push(
			`${days(flow.periodHigh)} read above the threshold of a period in which only the ${rec}’s low flows are valid (${periods.map((p) => `${p.start} – ${p.end}, ${m3s(p.maxM3s)}`).join('; ')}), so they are left out: the fit says nothing about high flows in ${periods.length === 1 ? 'that period' : 'those periods'}.`
		);
	}
	if (flow.infilled) {
		notes.push(
			use.infilled === 'exclude'
				? `${days(flow.infilled)} of gap-filled flow are left out: only readings are scored.`
				: `${days(flow.infilled)} of gap-filled flow are scored as if they were readings.`
		);
	}
	if (withReading > 0 && leftOutDays / withReading > LEFT_OUT_NOTE_SHARE) {
		notes.push(`The flags leave out ${pct(leftOutDays, withReading)} of the observed days in the window: the fit rests on the other ${n(scoredDays)}.`);
	}
	if (rain && scoredDays > 0 && rain.infilled / scoredDays > RAIN_INFILL_NOTE_SHARE) {
		notes.push(
			`On ${pct(rain.infilled, scoredDays)} of the scored days the rain is filled (bias-corrected CHIRPS, forecast or another gauge), not the catchment gauge's reading: the fit partly tests the fill, and fitted parameters absorb its bias.`
		);
	}
	if (rain?.zeroRunDays) {
		notes.push(`Of the scored days, ${days(rain.zeroRunDays)} ${rain.zeroRunDays === 1 ? 'falls' : 'fall'} in zero-rain runs set aside as missing (Settings → Rain gaps → Flagged rain); their rain is filled.`);
	}
	return {
		flowKind: x.flowKind,
		rating,
		use,
		zeroFlowMonths: [...(x.settings.zeroFlowMonths ?? [])],
		windowDays: x.windowIdx.length,
		flow,
		scoredDays,
		censoredDays,
		leftOutDays,
		suspectZeroDays,
		longZeroDays,
		rain,
		notes
	};
}

/**
 * 1 on days flagged extrapolated, suspect, infilled or above a low-flow
 * period's threshold (not on missing days,
 * which have no value, nor on human-use days): the days a diagnostic on the
 * record's own shape, such as the recession segments (../recession), leaves
 * out whatever the fit's settings say.
 */
export function flaggedDayMask(flags: Uint8Array): Uint8Array {
	const out = new Uint8Array(flags.length);
	for (let t = 0; t < flags.length; t++) {
		const f = FLOW_DAY_FLAGS[flags[t]!];
		out[t] = f === 'aboveRating' || f === 'belowRating' || f === 'suspect' || f === 'infilled' || f === 'periodHigh' ? 1 : 0;
	}
	return out;
}

// Automated calibration's exclusion rule (issue #153, ./rulesSettings.ts
// exclusions.maxFlaggedShare): the days flaggedDayMask marks, counted per water year.

const sharePct = (v: number) => `${Math.round(v * 1000) / 10} %`;

export interface FlaggedYearShare {
	waterYear: number;
	/** Observed days (any class but missing) in the calibration window, outside the stored exclusions. */
	observedDays: number;
	/** Of those, days flagged extrapolated, suspect or infilled. */
	flaggedDays: number;
	share: number;
	excluded: boolean;
}

/** The reason an excluded year carries: it names the rule, so no one can mistake it for a person's choice. */
export const flaggedYearReason = (y: Pick<FlaggedYearShare, 'flaggedDays' | 'observedDays' | 'share'>, maxShare: number) =>
	`Rule (calibration rules, exclusions): ${y.flaggedDays} of ${y.observedDays} observed days flagged (${sharePct(y.share)}), more than ${sharePct(maxShare)}`;

/**
 * Each water year's flagged share over `windowDays` (run day indices inside
 * the window and outside the stored exclusions), and the water years the
 * rule leaves out. `flags` are the fitted record's per-day classes
 * (flowDayFlags). maxShare null: every year kept.
 */
export function flaggedYearExclusions(
	flags: Uint8Array,
	windowDays: ArrayLike<number>,
	startDate: string,
	maxShare: number | null
): { years: FlaggedYearShare[]; exclusions: CalibrationExclusion[] } {
	const d0 = toEpochDay(startDate);
	const byYear = new Map<number, { observed: number; flagged: number }>();
	for (let i = 0; i < windowDays.length; i++) {
		const t = windowDays[i]!;
		const f = FLOW_DAY_FLAGS[flags[t]!];
		// A periodHigh day is a person's choice, like a stored exclusion (outside windowDays): the rule doesn't count it.
		if (f === 'missing' || f === 'periodHigh') continue;
		const wy = waterYearOf(d0 + t);
		const y = byYear.get(wy) ?? { observed: 0, flagged: 0 };
		y.observed++;
		if (f === 'aboveRating' || f === 'belowRating' || f === 'suspect' || f === 'infilled') y.flagged++; // flaggedDayMask's days but periodHigh
		byYear.set(wy, y);
	}
	const years = [...byYear.entries()]
		.sort(([a], [b]) => a - b)
		.map(([waterYear, y]) => {
			const share = y.flagged / y.observed;
			return { waterYear, observedDays: y.observed, flaggedDays: y.flagged, share, excluded: maxShare !== null && share > maxShare };
		});
	return {
		years,
		exclusions: years.filter((y) => y.excluded).map((y) => ({ waterYear: y.waterYear, reason: flaggedYearReason(y, maxShare!) }))
	};
}

/** "WY 2015/16 (34 %)" for the years a rule left out. */
export const flaggedYearsText = (years: readonly FlaggedYearShare[]) =>
	years
		.filter((y) => y.excluded)
		.map((y) => `WY ${waterYearLabel(y.waterYear)} (${sharePct(y.share)})`)
		.join(', ');
