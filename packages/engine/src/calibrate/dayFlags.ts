// Per-day quality flags on the observed flow and the rain (calibration
// research CR-18, issue #66), and what automatic calibration does with them
// (CR-19). docs/model.md §2.10h.
//
// Flow: each day of a calibration record gets one class, the strongest that
// applies, in FLOW_DAY_FLAGS order from the end (missing wins):
// - missing: no reading (blank, NaN or negative, as alignFlow reads it);
// - infilled: a gap-filled value, not a reading (observedInfillMask: the hook
//   for gap filling of observed flow, issue #66; nothing fills flow yet);
// - suspect: an outlier or a flat stretch by the Data checks (quality.ts
//   seriesRowFlags, the same rules and limits the run warnings use);
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
import { toEpochDay } from '../calendar';
import type { CalibrationFlowKind, DailySeries } from '../project';
import { seriesRowFlags } from '../quality';
import { RAIN_SOURCE_CODE } from '../rainSourcePeriods';

/** Flow classes, weakest first: a day that qualifies for several takes the last. The index is the day's code. */
export const FLOW_DAY_FLAGS = ['inRange', 'humanUse', 'belowRating', 'aboveRating', 'suspect', 'infilled', 'missing'] as const;
export type FlowDayFlag = (typeof FLOW_DAY_FLAGS)[number];
export const FLOW_FLAG_CODE = Object.fromEntries(FLOW_DAY_FLAGS.map((f, i) => [f, i])) as Record<FlowDayFlag, number>;

export const FLOW_FLAG_LABEL: Record<FlowDayFlag, string> = {
	inRange: 'In the gauged range',
	humanUse: 'Human use dominant',
	belowRating: 'Below the lowest gauging',
	aboveRating: 'Above the highest gauging',
	suspect: 'Suspect (outlier or flat stretch)',
	infilled: 'Infilled',
	missing: 'Missing'
};

/** Rain classes: the index is the day's code. */
export const RAIN_DAY_FLAGS = ['observed', 'infilled', 'missing'] as const;
export type RainDayFlag = (typeof RAIN_DAY_FLAGS)[number];

/** The rating curve's gauged range at one flow record: the extrapolated flags come from it. */
export interface GaugeRating {
	/** Highest field gauging, m³/s; null = not known. */
	gaugedMaxM3s: number | null;
	/** Lowest field gauging, m³/s; null = not known. */
	gaugedMinM3s: number | null;
	/** Where the numbers come from (the rating table, a DWS gauging list); required once either is set. */
	source: string;
}

/** What the fit does with an above-rating day: only ask the model to reach the highest gauging (censor), leave it out, or score it as recorded. */
export const ABOVE_RATING_USES = ['censor', 'exclude', 'include'] as const;
export type AboveRatingUse = (typeof ABOVE_RATING_USES)[number];
export const FLAG_USES = ['exclude', 'include'] as const;
export type FlagUse = (typeof FLAG_USES)[number];

/**
 * settings.qualityFlags (engine ≥ 1.20.0): the gauged range per record and
 * how the fit's objective treats each flagged class. Missing days are never
 * scored; human-use days (never set yet) are scored.
 */
export interface QualityFlagSettings {
	ratings: Partial<Record<CalibrationFlowKind, GaugeRating>>;
	aboveRating: AboveRatingUse;
	belowRating: FlagUse;
	suspect: FlagUse;
	infilled: FlagUse;
}

/** Defaults (pending the hydrologist, issue #66): censor floods above the rating, leave out the rest. */
export const defaultQualityFlags = (): QualityFlagSettings => ({ ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' });

export const RATING_SOURCE_MAX = 200;
/** Records a rating can be given for. */
const RATED_KINDS: readonly CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bound = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** Why a rating is invalid, or null. */
export function ratingError(r: unknown): string | null {
	if (!isObj(r)) return 'not a rating';
	const { gaugedMaxM3s: hi, gaugedMinM3s: lo, source } = r;
	if (!bound(hi) || !bound(lo)) return 'gauged flows must be numbers ≥ 0, or empty';
	if (hi === 0) return 'the highest gauging must be above 0';
	if (hi !== null && lo !== null && lo >= hi) return 'the lowest gauging must be below the highest';
	if (typeof source !== 'string' || source.length > RATING_SOURCE_MAX) return `the source must be text of at most ${RATING_SOURCE_MAX} characters`;
	if ((hi !== null || lo !== null) && !source.trim()) return 'a gauged range needs its source';
	return null;
}

/**
 * settings.qualityFlags merged over the defaults: an invalid field falls
 * back to its default with a warning (the API rejects it on save; this guards
 * older or hand-edited settings). A rating for a record kind that can't be
 * calibrated against is dropped.
 */
export function resolveQualityFlags(raw: unknown, warnings: string[] = []): QualityFlagSettings {
	const d = defaultQualityFlags();
	if (raw == null) return d;
	if (!isObj(raw)) {
		warnings.push('quality-flag settings are not an object; using the defaults');
		return d;
	}
	const pick = <T extends string>(key: 'aboveRating' | 'belowRating' | 'suspect' | 'infilled', allowed: readonly T[], def: T): T => {
		const v = raw[key];
		if (v === undefined) return def;
		if ((allowed as readonly unknown[]).includes(v)) return v as T;
		warnings.push(`quality-flag setting ${key} = ${JSON.stringify(v)} is not one of ${allowed.join(', ')}; using ${def}`);
		return def;
	};
	const ratings: QualityFlagSettings['ratings'] = {};
	if (isObj(raw.ratings)) {
		for (const k of RATED_KINDS) {
			const r = raw.ratings[k];
			if (r == null) continue;
			const err = ratingError(r);
			if (err) {
				warnings.push(`the ${k} rating ${err}; ignored`);
				continue;
			}
			const o = r as unknown as GaugeRating;
			ratings[k] = { gaugedMaxM3s: o.gaugedMaxM3s, gaugedMinM3s: o.gaugedMinM3s, source: o.source.trim() };
		}
	}
	return {
		ratings,
		aboveRating: pick('aboveRating', ABOVE_RATING_USES, d.aboveRating),
		belowRating: pick('belowRating', FLAG_USES, d.belowRating),
		suspect: pick('suspect', FLAG_USES, d.suspect),
		infilled: pick('infilled', FLAG_USES, d.infilled)
	};
}

/** A rating that says something (a bound set), or null. */
export const ratingOf = (q: QualityFlagSettings, kind: CalibrationFlowKind): GaugeRating | null => {
	const r = q.ratings[kind];
	return r && (r.gaugedMaxM3s !== null || r.gaugedMinM3s !== null) ? r : null;
};

/**
 * The per-day fill mask of a gap-filled observed flow record, aligned to the
 * run (1 = infilled), or null when nothing was filled. The hook for gap
 * filling of observed flow (issue #66): nothing fills a flow record yet, so
 * this is null; once a filled record carries its mask, return it here and
 * every fit, report and panel picks the `infilled` class up.
 */
export function observedInfillMask(_series: DailySeries | undefined, _start: number, _days: number): Uint8Array | null {
	return null;
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
}

/** Each run day's flow class code (FLOW_FLAG_CODE). */
export function flowDayFlags(x: FlowFlagInput): Uint8Array {
	const out = new Uint8Array(x.days).fill(FLOW_FLAG_CODE.missing);
	const s = x.series;
	if (!s) return out;
	const offset = toEpochDay(s.startDate) - x.start;
	const rows = seriesRowFlags(x.kind, s);
	const hi = x.rating?.gaugedMaxM3s ?? null;
	const lo = x.rating?.gaugedMinM3s ?? null;
	const from = Math.max(0, -offset);
	const to = Math.min(s.values.length, x.days - offset);
	for (let i = from; i < to; i++) {
		const t = i + offset;
		const v = s.values[i];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
		out[t] = x.infilled?.[t]
			? FLOW_FLAG_CODE.infilled
			: rows.outlier[i] || rows.flatline[i]
				? FLOW_FLAG_CODE.suspect
				: hi !== null && v > hi
					? FLOW_FLAG_CODE.aboveRating
					: lo !== null && v > 0 && v < lo
						? FLOW_FLAG_CODE.belowRating
						: FLOW_FLAG_CODE.inRange;
	}
	return out;
}

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
		if (f === 'missing') continue;
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
	use: Omit<QualityFlagSettings, 'ratings'>;
	/** Days in the calibration window outside the exclusion periods. */
	windowDays: number;
	/** Those days by flow class. */
	flow: Record<FlowDayFlag, number>;
	/** Days the objective scored (censored ones included). */
	scoredDays: number;
	/** Scored days censored at the highest gauging. */
	censoredDays: number;
	/** Days with a reading that the flags left out. */
	leftOutDays: number;
	/** Suspect days whose flow is zero (a river that stops trips the flat-stretch check after 90 days). */
	suspectZeroDays: number;
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
	const { ratings: _r, ...use } = x.settings;
	const notes: string[] = [];
	const rec = RECORD[x.flowKind];
	if (!rating?.gaugedMaxM3s) {
		notes.push(
			`No highest gauging is recorded for the ${rec} (Settings → Calibration record → Rating), so no day can be flagged as extrapolated: flood days count as readings, however far the rating curve was extended beyond its gaugings.`
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
		if (suspectZeroDays && use.suspect === 'exclude') {
			notes.push(
				`${n(suspectZeroDays)} of the suspect days ${suspectZeroDays === 1 ? 'is' : 'are'} zero flow held for a long stretch. If the river really stops, set suspect days to "Score as recorded" (Settings → Calibration record), or the fit never sees it dry.`
			);
		}
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
		notes.push(`Of the scored days, ${days(rain.zeroRunDays)} ${rain.zeroRunDays === 1 ? 'falls' : 'fall'} in zero-rain runs set aside as missing (Settings → Zero-rain runs); their rain is filled.`);
	}
	return { flowKind: x.flowKind, rating, use, windowDays: x.windowIdx.length, flow, scoredDays, censoredDays, leftOutDays, suspectZeroDays, rain, notes };
}


/**
 * 1 on days flagged extrapolated, suspect or infilled (not on missing days,
 * which have no value, nor on human-use days): the days a diagnostic on the
 * record's own shape, such as the recession segments (../recession), leaves
 * out whatever the fit's settings say.
 */
export function flaggedDayMask(flags: Uint8Array): Uint8Array {
	const out = new Uint8Array(flags.length);
	for (let t = 0; t < flags.length; t++) {
		const f = FLOW_DAY_FLAGS[flags[t]!];
		out[t] = f === 'aboveRating' || f === 'belowRating' || f === 'suspect' || f === 'infilled' ? 1 : 0;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Run comparison
// ---------------------------------------------------------------------------

export const QUALITY_FLAG_USE_LABEL: Record<'aboveRating' | 'belowRating' | 'suspect' | 'infilled', string> = {
	aboveRating: 'Above-rating days in the fit',
	belowRating: 'Below-rating days in the fit',
	suspect: 'Suspect days in the fit',
	infilled: 'Infilled days in the fit'
};
export const FLAG_USE_TEXT: Record<AboveRatingUse, string> = {
	censor: 'censored at the highest gauging',
	exclude: 'left out',
	include: 'scored as recorded'
};
const RATING_LABEL: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'Gauged range (gauge record)', flow_logger_m3s: 'Gauged range (logger record)' };

/** "0.05–12 m³/s", "up to 12 m³/s", "from 0.05 m³/s" or "none". */
export function ratingText(r: GaugeRating | null | undefined): string {
	const hi = r?.gaugedMaxM3s ?? null;
	const lo = r?.gaugedMinM3s ?? null;
	if (hi === null && lo === null) return 'none';
	const v = (x: number) => String(+x.toPrecision(4));
	return hi !== null && lo !== null ? `${v(lo)}–${v(hi)} m³/s` : hi !== null ? `up to ${v(hi)} m³/s` : `from ${v(lo!)} m³/s`;
}

/** The changes between two runs' quality-flag settings (both resolved), as run-comparison lines. */
export function qualityFlagChanges(a: QualityFlagSettings, b: QualityFlagSettings): { subject: string; text: string }[] {
	const out: { subject: string; text: string }[] = [];
	for (const k of RATED_KINDS) {
		const ra = a.ratings[k] ?? null;
		const rb = b.ratings[k] ?? null;
		const ta = ratingText(ra);
		const tb = ratingText(rb);
		if (ta !== tb) out.push({ subject: RATING_LABEL[k], text: `${RATING_LABEL[k]}: ${ta} → ${tb}` });
		else if ((ra?.source ?? '') !== (rb?.source ?? '') && ta !== 'none') out.push({ subject: RATING_LABEL[k], text: `${RATING_LABEL[k]}: source "${ra?.source ?? ''}" → "${rb?.source ?? ''}"` });
	}
	for (const k of ['aboveRating', 'belowRating', 'suspect', 'infilled'] as const) {
		if (a[k] !== b[k]) out.push({ subject: QUALITY_FLAG_USE_LABEL[k], text: `${QUALITY_FLAG_USE_LABEL[k]}: ${FLAG_USE_TEXT[a[k]]} → ${FLAG_USE_TEXT[b[k]]}` });
	}
	return out;
}
