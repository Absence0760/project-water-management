// settings.qualityFlags (engine ≥ 1.22.0, calibration research CR-18/19):
// each record's gauged range and how automatic calibration treats flagged
// days, with their resolver, validation and run-comparison lines. Kept apart
// from ./dayFlags.ts (the per-day flags themselves) with no import of the
// data checks, so settings, provenance and run comparison load only this.
import { isIsoDate, toEpochDay } from '../calendar';
import type { CalibrationFlowKind } from '../project';

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
 * settings.qualityFlags (engine ≥ 1.22.0): the gauged range per record and
 * how the fit's objective treats each flagged class. Missing days are never
 * scored; human-use days (never set yet) are scored.
 */
export interface QualityFlagSettings {
	ratings: Partial<Record<CalibrationFlowKind, GaugeRating>>;
	aboveRating: AboveRatingUse;
	belowRating: FlagUse;
	suspect: FlagUse;
	infilled: FlagUse;
	/**
	 * Calendar months (1–12, ascending, no repeats) in which the river is known
	 * to stop flowing (engine ≥ 1.81.0, issue #507 item 2, audit C3, QF-3). A
	 * zero-flow stretch that overlaps them is trusted as the river stopping and
	 * scored as long as it runs no more than ZERO_FLOW_TRUST_MAX_DAYS beyond
	 * them on each side (engine 1.84.0, issue #523 A1; wholly inside them in
	 * 1.81.0 – 1.83.x); with months listed, a zero stretch wholly outside them
	 * is suspect at any length, and with none (the default) only a stretch
	 * longer than ZERO_FLOW_TRUST_MAX_DAYS is (./dayFlags.ts zeroFlowSuspect). Absent on
	 * settings saved before 1.81.0: none.
	 */
	zeroFlowMonths?: number[];
	/**
	 * Periods in which only a record's low flows are valid (engine ≥ 1.90.0,
	 * issue #557, docs/model.md §2.10h): inside one, a reading of that record
	 * above the threshold is flagged `periodHigh` and left out of every score,
	 * never censored (a wrong high reading says nothing about the flow being
	 * at least that much). Like the gauged ranges they are the outlet records'
	 * (siteQualityFlags clears them at an inner gauge). Absent (the default,
	 * and on settings saved before 1.90.0): none.
	 */
	lowFlowPeriods?: LowFlowPeriod[];
}

/** A date range in which only one record's flows at or below a threshold are valid (issue #557). */
export interface LowFlowPeriod {
	/** The record whose high readings are wrong in the period. */
	kind: CalibrationFlowKind;
	/** First and last day, inclusive (YYYY-MM-DD). */
	start: string;
	end: string;
	/** m³/s, > 0: a reading above it, inside the period, is left out. */
	maxM3s: number;
	/** Why the high flows aren't valid. */
	reason: string;
	/** Who or what says so (the client's note, a site visit). */
	source: string;
}

/** Most low-flow periods a project may store. */
export const LOW_FLOW_PERIODS_MAX = 50;
export const LOW_FLOW_TEXT_MAX = 500;

/**
 * With no settings.qualityFlags.zeroFlowMonths, a zero-flow stretch longer
 * than this many days is suspect (engine ≥ 1.81.0, issue #507 item 2): the
 * hydrologist's "check with the client" length. With months listed, the most
 * days a stretch over them may run beyond them on each side and stay trusted
 * (engine 1.84.0, issue #523 A1).
 */
export const ZERO_FLOW_TRUST_MAX_DAYS = 30;

/** Defaults (pending the hydrologist, issue #66): censor floods above the rating, leave out the rest; no river-stops months. */
export const defaultQualityFlags = (): QualityFlagSettings => ({ ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude', zeroFlowMonths: [] });

/** Why a river-stops month list is invalid, or null: whole calendar months 1–12, each once. */
export function zeroFlowMonthsError(v: unknown): string | null {
	if (!Array.isArray(v)) return 'the river-stops months must be a list';
	if (!v.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) return 'each river-stops month must be a calendar month, 1 to 12';
	if (new Set(v).size !== v.length) return 'a river-stops month is listed twice';
	return null;
}

export const RATING_SOURCE_MAX = 200;
/** Records a rating can be given for. */
export const RATED_KINDS: readonly CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];

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

/** Why a low-flow period is invalid, or null. */
export function lowFlowPeriodError(p: unknown): string | null {
	if (!isObj(p)) return 'not a low-flow period';
	if (!(RATED_KINDS as readonly unknown[]).includes(p.kind)) return 'the record must be the gauge or the logger record';
	if (!isIsoDate(p.start) || !isIsoDate(p.end)) return 'dates must be YYYY-MM-DD';
	if (p.start > p.end) return 'ends before it starts';
	if (typeof p.maxM3s !== 'number' || !Number.isFinite(p.maxM3s) || p.maxM3s <= 0) return 'the threshold must be a flow above 0 m³/s';
	if (typeof p.reason !== 'string' || !p.reason.trim()) return 'needs a reason';
	if (p.reason.length > LOW_FLOW_TEXT_MAX) return `reason longer than ${LOW_FLOW_TEXT_MAX} characters`;
	if (typeof p.source !== 'string' || !p.source.trim()) return 'needs a source';
	if (p.source.length > RATING_SOURCE_MAX) return `source longer than ${RATING_SOURCE_MAX} characters`;
	return null;
}

/** The first problem with a list of low-flow periods ("Low-flow period 2: needs a source"), or null. */
export function lowFlowPeriodsError(v: unknown): string | null {
	if (!Array.isArray(v)) return 'the low-flow periods must be a list';
	if (v.length > LOW_FLOW_PERIODS_MAX) return `at most ${LOW_FLOW_PERIODS_MAX} low-flow periods`;
	const seen = new Set<string>();
	for (let i = 0; i < v.length; i++) {
		const err = lowFlowPeriodError(v[i]);
		if (err) return `Low-flow period ${i + 1}: ${err}`;
		const p = v[i] as LowFlowPeriod;
		const key = `${p.kind}/${p.start}/${p.end}`;
		if (seen.has(key)) return `Low-flow period ${i + 1}: ${p.start} – ${p.end} is listed twice for the ${p.kind === 'flow_logger_m3s' ? 'logger' : 'gauge'} record`;
		seen.add(key);
	}
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
	let zeroFlowMonths = d.zeroFlowMonths;
	if (raw.zeroFlowMonths !== undefined) {
		const err = zeroFlowMonthsError(raw.zeroFlowMonths);
		if (err) warnings.push(`quality-flag setting zeroFlowMonths: ${err}; using none`);
		else zeroFlowMonths = [...(raw.zeroFlowMonths as number[])].sort((a, b) => a - b);
	}
	// Engine ≥ 1.90.0 (issue #557): set only when there are some, so settings without them resolve as before.
	const lowFlowPeriods: LowFlowPeriod[] = [];
	if (raw.lowFlowPeriods != null) {
		if (!Array.isArray(raw.lowFlowPeriods)) warnings.push('quality-flag setting lowFlowPeriods is not a list; using none');
		else
			for (const p of raw.lowFlowPeriods) {
				const err = lowFlowPeriodError(p);
				if (err) {
					warnings.push(`low-flow period ${JSON.stringify(p).slice(0, 80)}: ${err}; ignored`);
					continue;
				}
				const o = p as LowFlowPeriod;
				lowFlowPeriods.push({ kind: o.kind, start: o.start, end: o.end, maxM3s: o.maxM3s, reason: o.reason.trim(), source: o.source.trim() });
			}
	}
	return {
		ratings,
		aboveRating: pick('aboveRating', ABOVE_RATING_USES, d.aboveRating),
		belowRating: pick('belowRating', FLAG_USES, d.belowRating),
		suspect: pick('suspect', FLAG_USES, d.suspect),
		infilled: pick('infilled', FLAG_USES, d.infilled),
		zeroFlowMonths,
		...(lowFlowPeriods.length ? { lowFlowPeriods } : {})
	};
}

/** A rating that says something (a bound set), or null. */
export const ratingOf = (q: QualityFlagSettings, kind: CalibrationFlowKind): GaugeRating | null => {
	const r = q.ratings[kind];
	return r && (r.gaugedMaxM3s !== null || r.gaugedMinM3s !== null) ? r : null;
};

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
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const ZERO_FLOW_MONTHS_LABEL = 'Months the river stops';
export const LOW_FLOW_PERIODS_LABEL = 'Low flows only';

/** "logger record 2019-01-01 – 2019-06-30 below 0.8 m³/s". */
export const lowFlowPeriodText = (p: LowFlowPeriod): string =>
	`${p.kind === 'flow_logger_m3s' ? 'logger' : 'gauge'} record ${p.start} – ${p.end} at or below ${+p.maxM3s.toPrecision(4)} m³/s`;

/**
 * Each run day's threshold for one record (m³/s; NaN = no period that day),
 * the lowest where periods overlap, or null when no period of `kind` reaches
 * the run's days. `start` is the run's first epoch day.
 */
export function lowFlowThresholds(periods: readonly LowFlowPeriod[] | undefined, kind: CalibrationFlowKind, start: number, days: number): Float64Array | null {
	let out: Float64Array | null = null;
	for (const p of periods ?? []) {
		if (p.kind !== kind) continue;
		const a = Math.max(0, toEpochDay(p.start) - start);
		const b = Math.min(days - 1, toEpochDay(p.end) - start);
		if (a > b) continue;
		out ??= new Float64Array(days).fill(NaN);
		for (let t = a; t <= b; t++) if (!(out[t]! <= p.maxM3s)) out[t] = p.maxM3s;
	}
	return out;
}

/**
 * The aligned record (m³/s, null = missing) with its readings above a
 * low-flow period's threshold blanked, as the run's statistics, its EWR test
 * on the observed record and the plausibility checks read it (issue #557).
 * Returns `values` itself when no day is blanked.
 */
export function withoutPeriodHighs<T extends number | null>(values: readonly T[], periods: readonly LowFlowPeriod[] | undefined, kind: CalibrationFlowKind, start: number): (T | null)[] {
	const thr = lowFlowThresholds(periods, kind, start, values.length);
	if (!thr) return values as (T | null)[];
	let out: (T | null)[] | null = null;
	for (let t = 0; t < values.length; t++) {
		const v = values[t];
		if (typeof v === 'number' && v > thr[t]!) (out ??= values.slice())[t] = null;
	}
	return out ?? (values as (T | null)[]);
}

/** "Feb, Mar, Apr", or "none". */
export const zeroFlowMonthsText = (months: readonly number[] | undefined): string => (months?.length ? months.map((m) => MONTH_ABBR[m - 1] ?? String(m)).join(', ') : 'none');

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
	// Engine ≥ 1.81.0; an older resolved setting without it had none.
	const ma = zeroFlowMonthsText(a.zeroFlowMonths);
	const mb = zeroFlowMonthsText(b.zeroFlowMonths);
	if (ma !== mb) out.push({ subject: ZERO_FLOW_MONTHS_LABEL, text: `${ZERO_FLOW_MONTHS_LABEL}: ${ma} → ${mb}` });
	// Engine ≥ 1.90.0 (issue #557); absent = none.
	const pa = (a.lowFlowPeriods ?? []).map(lowFlowPeriodText);
	const pb = (b.lowFlowPeriods ?? []).map(lowFlowPeriodText);
	for (const t of pa) if (!pb.includes(t)) out.push({ subject: LOW_FLOW_PERIODS_LABEL, text: `${LOW_FLOW_PERIODS_LABEL}: removed ${t}` });
	for (const t of pb) if (!pa.includes(t)) out.push({ subject: LOW_FLOW_PERIODS_LABEL, text: `${LOW_FLOW_PERIODS_LABEL}: added ${t}` });
	return out;
}
