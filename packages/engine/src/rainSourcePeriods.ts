// Per-period forcing source (settings.rainSource, engine ≥ 0.30.0, issue #40
// (b) and its amendments, docs/model.md §2.4e).
//
// Over a listed period the primary catchment rain stops representing the
// catchment (a network change, a gauge that moved). Up to 0.29 such a period
// could only be set aside as `missing` (§2.4c) and filled from bias-corrected
// CHIRPS. A rain-source period instead takes the day's rain from another
// catchment gauge (`rain_catchment_alt_mm`, e.g. an in-catchment automatic
// station) × its month's factor:
//
// - fixed factors: 12 values with their provenance (who fitted them, over
//   which dates, by what method), the normal case;
// - 'fit': measured against a reference series that doesn't contain the
//   replacement gauge, over a reference era the hydrologist names:
//     factor(m) = (Σ catchment ÷ Σ reference, month m, reference era)
//               ÷ (Σ series ÷ Σ reference, month m, over the period)
//   so the series lands at the primary record's level in the reference era.
//   CHIRPS may be the reference only while the gauge is not in it
//   (`gaugeInChirps` refuses it): once CHIRPS ingests the gauge the second
//   ratio is circular.
//
// A day the series lacks falls through to a named fallback: by default CHIRPS
// × the §2.4b factors (the fit period's, as for any blank day), or a
// reanalysis × factors fitted on the primary record over the fallback's own
// era; then forecast rain; then nothing (0 mm, with the run's usual warning).
//
// The primary catchment reading inside a period is never used: it stays out
// of every fit (the CHIRPS factors, a 'fit' here, the accumulation detection)
// and out of the zero-run handling (§2.4c). The stored series are never
// changed.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearLabel, waterYearOf } from './calendar';
import { EXCLUSION_REASON_MAX, EXCLUSIONS_MAX } from './calibrate/provenance';
import {
	RAIN_SOURCE_FALLBACKS,
	RAIN_SOURCE_REFERENCES,
	RAIN_SOURCE_SERIES,
	type DailySeries,
	type RainSourceFactorProvenance,
	type RainSourcePeriod,
	type RainSourceReferenceEra,
	type SeriesKind,
	type ZeroRainSettings
} from './project';
import { rainVsChirps } from './quality';
import { provenanceLabel, type SeriesProvenance } from './seriesProvenance';
import {
	CHIRPS_FACTOR_MAX,
	CHIRPS_FACTOR_MIN,
	factorsFrom,
	suspectRainDays,
	withoutReplaced,
	type AccumulationSpans,
	type ChirpsFitWindow,
	type MonthSums
} from './rain';

/** Length limit of the provenance texts (source, method). */
export const RAIN_SOURCE_TEXT_MAX = 200;

/** Where a day's rain came from: the values of the per-day `rain_source` column. */
export const RAIN_SOURCE_CODE = { catchment: 0, series: 1, chirps: 2, reanalysis: 3, forecast: 4 } as const;
export type RainSourceCode = (typeof RAIN_SOURCE_CODE)[keyof typeof RAIN_SOURCE_CODE];

export const RAIN_SOURCE_COLUMN = {
	key: 'rain_source',
	label: 'Rain source (0 catchment, 1 alternative gauge, 2 CHIRPS, 3 reanalysis, 4 forecast; blank = none)',
	unit: ''
} as const;

const KIND_NAME: Record<string, string> = {
	rain_catchment_alt_mm: 'alternative catchment gauge',
	rain_reanalysis_mm: 'reanalysis',
	rain_chirps_mm: 'CHIRPS'
};
/** A rain-source series or reference in words. */
export const rainSourceKindName = (k: string): string => KIND_NAME[k] ?? k;

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;
const clamp = (f: number) => Math.min(CHIRPS_FACTOR_MAX, Math.max(CHIRPS_FACTOR_MIN, f));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && fromEpochDay(toEpochDay(v)) === v;
const isYear = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1800 && v <= 2200;
const plainObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);

const PERIOD_KEYS = new Set(['start', 'end', 'series', 'factors', 'provenance', 'fitReference', 'fallback', 'gaugeInChirps', 'reason']);

/**
 * Why a rain-source period is invalid, or null. Exactly what the API's schema
 * accepts (backend/src/projects/settings.ts; a table test holds the two
 * together).
 */
export function rainSourcePeriodError(raw: unknown): string | null {
	const o = plainObject(raw);
	if (!o) return 'is not a period';
	const extra = Object.keys(o).filter((k) => !PERIOD_KEYS.has(k));
	if (extra.length) return `has unknown field${extra.length === 1 ? '' : 's'} ${extra.join(', ')}`;
	if (!isIsoDate(o.start) || !isIsoDate(o.end)) return 'dates must be YYYY-MM-DD';
	if (o.start > o.end) return 'ends before it starts';
	if (!(RAIN_SOURCE_SERIES as readonly unknown[]).includes(o.series)) return `series must be one of ${RAIN_SOURCE_SERIES.join(', ')}`;
	if (!text(o.reason, EXCLUSION_REASON_MAX)) return `needs a reason of 1–${EXCLUSION_REASON_MAX} characters`;
	if (o.gaugeInChirps !== undefined && typeof o.gaugeInChirps !== 'boolean') return 'gaugeInChirps must be true or false';
	const era = (v: unknown, allowed: readonly string[], what: string): string | null => {
		const e = plainObject(v);
		if (!e) return `${what} must be { series, fromWaterYear, toWaterYear }`;
		const bad = Object.keys(e).filter((k) => k !== 'series' && k !== 'fromWaterYear' && k !== 'toWaterYear');
		if (bad.length) return `${what} has unknown field${bad.length === 1 ? '' : 's'} ${bad.join(', ')}`;
		if (!allowed.includes(e.series as string)) return `${what} series must be one of ${allowed.join(', ')}`;
		if (!isYear(e.fromWaterYear) || !isYear(e.toWaterYear) || e.fromWaterYear > e.toWaterYear) return `${what} needs a water-year range (first ≤ last)`;
		return null;
	};
	if (o.factors === 'fit') {
		if (o.provenance !== undefined) return 'provenance is for fixed factors; a fit records its own';
		if (o.fitReference === undefined) return "'fit' needs a fitReference: a reference series and its reference era";
		const e = era(o.fitReference, RAIN_SOURCE_REFERENCES, 'fitReference');
		if (e) return e;
		if (o.gaugeInChirps === true && (o.fitReference as Record<string, unknown>).series === 'rain_chirps_mm') {
			return "can't fit against CHIRPS: the period says CHIRPS ingests its gauge, so the fit would be circular; use a gauge-free reference (reanalysis)";
		}
	} else {
		if (!Array.isArray(o.factors) || o.factors.length !== 12) return "factors must be 12 monthly values (Oct … Sep) or 'fit'";
		if (!o.factors.every((f) => typeof f === 'number' && Number.isFinite(f) && f >= CHIRPS_FACTOR_MIN && f <= CHIRPS_FACTOR_MAX)) {
			return `each factor must be a number from ${CHIRPS_FACTOR_MIN} to ${CHIRPS_FACTOR_MAX}`;
		}
		if (o.fitReference !== undefined) return "fitReference is only for factors: 'fit'";
		const p = plainObject(o.provenance);
		if (!p) return 'fixed factors need their provenance: { source, fittedFrom, fittedTo, method }';
		const bad = Object.keys(p).filter((k) => !['source', 'fittedFrom', 'fittedTo', 'method'].includes(k));
		if (bad.length) return `provenance has unknown field${bad.length === 1 ? '' : 's'} ${bad.join(', ')}`;
		if (!text(p.source, RAIN_SOURCE_TEXT_MAX) || !text(p.method, RAIN_SOURCE_TEXT_MAX)) return `provenance needs a source and a method of 1–${RAIN_SOURCE_TEXT_MAX} characters`;
		if (!isIsoDate(p.fittedFrom) || !isIsoDate(p.fittedTo) || p.fittedFrom > p.fittedTo) return 'provenance needs the dates the factors were fitted on (YYYY-MM-DD, first ≤ last)';
	}
	if (o.fallback !== undefined) {
		const e = era(o.fallback, RAIN_SOURCE_FALLBACKS, 'fallback');
		if (e) return e;
	} else if (o.gaugeInChirps === true) {
		return 'the period says CHIRPS ingests its gauge, so its gaps need a fallback that isn’t CHIRPS (reanalysis)';
	}
	return null;
}

/** A valid period, trimmed, with only the fields it may have. */
function cleanPeriod(o: Record<string, unknown>): RainSourcePeriod {
	const eraOf = (v: unknown) => {
		const e = v as RainSourceReferenceEra;
		return { series: e.series, fromWaterYear: e.fromWaterYear, toWaterYear: e.toWaterYear } as RainSourceReferenceEra;
	};
	const p: RainSourcePeriod = {
		start: o.start as string,
		end: o.end as string,
		series: o.series as RainSourcePeriod['series'],
		factors: o.factors === 'fit' ? 'fit' : [...(o.factors as number[])],
		reason: (o.reason as string).trim()
	};
	if (o.factors !== 'fit') {
		const pr = o.provenance as RainSourceFactorProvenance;
		p.provenance = { source: pr.source.trim(), fittedFrom: pr.fittedFrom, fittedTo: pr.fittedTo, method: pr.method.trim() };
	} else p.fitReference = eraOf(o.fitReference);
	if (o.fallback !== undefined) p.fallback = eraOf(o.fallback) as RainSourcePeriod['fallback'];
	if (o.gaugeInChirps !== undefined) p.gaugeInChirps = o.gaugeInChirps as boolean;
	return p;
}

/**
 * settings.rainSource as the engine uses it: not a list = none, with a
 * warning; an invalid or overlapping period is dropped with one; at most
 * EXCLUSIONS_MAX periods. Sorted by start date.
 */
export function resolveRainSource(raw: unknown, warnings: string[]): RainSourcePeriod[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		warnings.push('rain-source periods are not a list; ignored');
		return [];
	}
	if (raw.length > EXCLUSIONS_MAX) warnings.push(`rain source lists ${raw.length} periods; only the first ${EXCLUSIONS_MAX} are used`);
	const out: RainSourcePeriod[] = [];
	for (const r of (raw as unknown[]).slice(0, EXCLUSIONS_MAX)) {
		const err = rainSourcePeriodError(r);
		const label = plainObject(r) ? `${String((r as Record<string, unknown>).start)} to ${String((r as Record<string, unknown>).end)}` : JSON.stringify(r)?.slice(0, 40);
		if (err) {
			warnings.push(`rain-source period ${label} ${err}; ignored`);
			continue;
		}
		const p = cleanPeriod(r as Record<string, unknown>);
		const clash = out.find((x) => p.start <= x.end && p.end >= x.start);
		if (clash) {
			warnings.push(`rain-source period ${label} overlaps ${clash.start} to ${clash.end}; ignored`);
			continue;
		}
		out.push(p);
	}
	return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** The first problem with a list of periods ("Rain-source period 2: …"), or null: for forms and the API. */
export function rainSourceError(list: readonly unknown[]): string | null {
	if (list.length > EXCLUSIONS_MAX) return `at most ${EXCLUSIONS_MAX} rain-source periods`;
	for (const [i, r] of list.entries()) {
		const err = rainSourcePeriodError(r);
		if (err) return `Rain-source period ${i + 1} ${err}`;
		const p = r as RainSourcePeriod;
		const j = list.findIndex((x, k) => k < i && p.start <= (x as RainSourcePeriod).end && p.end >= (x as RainSourcePeriod).start);
		if (j >= 0) return `Rain-source period ${i + 1} overlaps period ${j + 1}`;
	}
	return null;
}

/** Epoch-day spans of the periods: the days whose primary catchment reading is replaced. */
export const rainSourceSpans = (periods: readonly RainSourcePeriod[]): AccumulationSpans =>
	periods.map((p) => ({ from: toEpochDay(p.start), to: toEpochDay(p.end) }));

// ---------------------------------------------------------------------------
// Factors
// ---------------------------------------------------------------------------

/** One month of a 'fit': the two ratios it divides. Calendar month 1–12. */
export interface RainSourceFitMonth {
	month: number;
	/** Σ catchment ÷ Σ reference over the reference era (own month, else pooled); null when neither sample is big enough. */
	catchmentRatio: number | null;
	/** Σ series ÷ Σ reference over the period (own month, else pooled); null likewise. */
	seriesRatio: number | null;
	/** catchmentRatio ÷ seriesRatio, clamped; null when either is. */
	factor: number | null;
	clamped: boolean;
}

export interface RainSourceFit {
	reference: RainSourceReferenceEra;
	/** Water years that actually gave the catchment ÷ reference ratio shared days (the reference window). */
	referenceWindow: ChirpsFitWindow | null;
	/** Water years that gave the series ÷ reference ratio shared days (inside the period). */
	periodWindow: ChirpsFitWindow | null;
	/** Shared days behind each ratio, all months. */
	referenceDays: number;
	periodDays: number;
	/** Calendar months Jan … Dec. */
	months: RainSourceFitMonth[];
}

/** A reanalysis fallback's factors: catchment ÷ reanalysis per month over its era. */
export interface RainSourceFallbackFit {
	era: RainSourceReferenceEra;
	fitWindow: ChirpsFitWindow | null;
	days: number;
	/** Applied factor per calendar month (Jan … Dec); null for none. */
	factors: (number | null)[];
}

/** One period as a run applied it (RunSummary.rainSource.periods). */
export interface RainSourcePeriodInfo {
	start: string;
	end: string;
	series: RainSourcePeriod['series'];
	reason: string;
	factorMode: 'fixed' | 'fit';
	/** The factor applied per calendar month (Jan … Dec); null = none, so that month's days fall through. */
	factors: (number | null)[];
	/** Fixed factors: where they came from. */
	provenance: RainSourceFactorProvenance | null;
	/** 'fit': the ratios and reference windows. */
	fit: RainSourceFit | null;
	/** 'chirps' = CHIRPS × the §2.4b factors; else the reanalysis fit. */
	fallback: 'chirps' | RainSourceFallbackFit;
	gaugeInChirps: boolean;
	/** The project has the named series (false = every day falls through). */
	seriesPresent: boolean;
	/** The product and version the series holds (032_series_provenance; null = not recorded, absent when the caller didn't say). */
	seriesProvenance?: SeriesProvenance | null;
	/** Run days in the period, and where their rain came from. */
	runDays: number;
	seriesDays: number;
	seriesRawMm: number;
	seriesMm: number;
	chirpsDays: number;
	reanalysisDays: number;
	forecastDays: number;
	noneDays: number;
}

export interface RainSourceInfo {
	periods: RainSourcePeriodInfo[];
}

/** Shared-day sums per calendar month of `num` over `den`, over the days `include` keeps. */
function monthSums(
	num: DailySeries,
	den: DailySeries,
	from: number,
	to: number,
	include: (day: number) => boolean
): { sums: MonthSums; window: ChirpsFitWindow | null; days: number } {
	const t: MonthSums = { days: new Array<number>(13).fill(0), cMm: new Array<number>(13).fill(0), hMm: new Array<number>(13).fill(0) };
	const n0 = toEpochDay(num.startDate);
	const d0 = toEpochDay(den.startDate);
	const a = Math.max(from, n0, d0);
	const b = Math.min(to, n0 + num.values.length - 1, d0 + den.values.length - 1);
	let lo = Infinity;
	let hi = -Infinity;
	let days = 0;
	for (let day = a; day <= b; day++) {
		const x = num.values[day - n0];
		const y = den.values[day - d0];
		if (!isReading(x) || !isReading(y) || !include(day)) continue;
		const m = monthOfEpochDay(day);
		t.days[m]!++;
		t.cMm[m] = t.cMm[m]! + x;
		t.hMm[m] = t.hMm[m]! + y;
		days++;
		const wy = waterYearOf(day);
		if (wy < lo) lo = wy;
		if (wy > hi) hi = wy;
	}
	return { sums: t, window: Number.isFinite(lo) ? { fromWaterYear: lo, toWaterYear: hi } : null, days };
}

/** A month's ratio, own else pooled, unclamped; null when neither sample is big enough (the §2.4b minimums). */
const ratios = (t: MonthSums) => {
	const f = factorsFrom(t);
	return f.months.map((m) => m.ownFactor ?? f.pooled.ownFactor);
};

/** Water-year-ordered settings factors → calendar months (Jan … Dec). */
const toCalendar = (wy: readonly number[]) => Array.from({ length: 12 }, (_, i) => wy[waterYearIndex(i + 1)]!);

/**
 * The factors of every period, from the whole stored record (like the §2.4b
 * factors, so a shorter run doesn't change them). The primary catchment
 * record is used only where it is trusted: outside every rain-source period,
 * off suspect days (§2.4c, §2.4d), and outside the low-vs-CHIRPS years.
 */
export function rainSourceFactors(
	series: Partial<Record<SeriesKind, DailySeries>>,
	periods: readonly RainSourcePeriod[],
	zr: ZeroRainSettings,
	accumulations: AccumulationSpans
): Pick<RainSourcePeriodInfo, 'factors' | 'fit' | 'fallback' | 'factorMode' | 'provenance'>[] {
	const primary = series.rain_catchment_mm;
	const replaced = rainSourceSpans(periods);
	const suspect = suspectRainDays(primary, zr, accumulations, replaced);
	const low = new Set(rainVsChirps(withoutReplaced(series, replaced))?.flaggedYears ?? []);
	const trusted = (day: number) => suspect.status(day) === null || suspect.status(day) === 'keptDry' ? !low.has(waterYearOf(day)) : false;
	const eraSpan = (e: RainSourceReferenceEra) => [toEpochDay(`${e.fromWaterYear}-10-01`), toEpochDay(`${e.toWaterYear + 1}-09-30`)] as const;
	const catchmentRatio = (e: RainSourceReferenceEra) => {
		const ref = series[e.series];
		if (!primary || !ref) return { ratio: new Array<number | null>(12).fill(null), window: null, days: 0 };
		const [a, b] = eraSpan(e);
		const r = monthSums(primary, ref, a, b, trusted);
		return { ratio: ratios(r.sums), window: r.window, days: r.days };
	};
	return periods.map((p) => {
		let factors: (number | null)[];
		let fit: RainSourceFit | null = null;
		if (p.factors === 'fit') {
			const e = p.fitReference!;
			const c = catchmentRatio(e);
			const alt = series[p.series];
			const ref = series[e.series];
			const s = alt && ref ? monthSums(alt, ref, toEpochDay(p.start), toEpochDay(p.end), () => true) : null;
			const sr = s ? ratios(s.sums) : new Array<number | null>(12).fill(null);
			const months: RainSourceFitMonth[] = sr.map((q, i) => {
				const cr = c.ratio[i]!;
				const raw = cr !== null && q !== null && q > 0 ? cr / q : null;
				return { month: i + 1, catchmentRatio: cr, seriesRatio: q, factor: raw === null ? null : clamp(raw), clamped: raw !== null && clamp(raw) !== raw };
			});
			fit = { reference: { ...e }, referenceWindow: c.window, periodWindow: s?.window ?? null, referenceDays: c.days, periodDays: s?.days ?? 0, months };
			factors = months.map((m) => m.factor);
		} else {
			factors = toCalendar(p.factors);
		}
		let fallback: RainSourcePeriodInfo['fallback'] = 'chirps';
		if (p.fallback) {
			const c = catchmentRatio(p.fallback);
			fallback = { era: { ...p.fallback }, fitWindow: c.window, days: c.days, factors: c.ratio.map((r) => (r === null ? null : clamp(r))) };
		}
		return { factors, fit, fallback, factorMode: p.factors === 'fit' ? 'fit' : 'fixed', provenance: p.provenance ? { ...p.provenance } : null };
	});
}

// ---------------------------------------------------------------------------
// Applying the periods to a run
// ---------------------------------------------------------------------------

export interface RainSourceRun {
	info: RainSourceInfo;
	/** Run days (1) where CHIRPS must not stand in: a period whose fallback is not CHIRPS. */
	blockChirps: Uint8Array;
	/** Per run day: RAIN_SOURCE_CODE.series / .reanalysis where a period set the rain, -1 elsewhere. */
	code: Int8Array;
}

/**
 * Write each period's rain into `catchment` (the run-aligned primary rain,
 * already masked): the series × its month's factor where it has a reading
 * and the month a factor; else the reanalysis fallback × its factor; else
 * blank, for CHIRPS (unless blocked) and then forecast rain. The primary
 * reading is never kept inside a period. Counts are finished by
 * finishRainSource once the run knows what filled the blank days.
 */
export function applyRainSource(
	series: Partial<Record<SeriesKind, DailySeries>>,
	periods: readonly RainSourcePeriod[],
	factors: ReturnType<typeof rainSourceFactors>,
	catchment: (number | null)[],
	start: number
): RainSourceRun {
	const days = catchment.length;
	const blockChirps = new Uint8Array(days);
	const code = new Int8Array(days).fill(-1);
	const valueOn = (s: DailySeries | undefined, day: number) => {
		if (!s) return null;
		const v = s.values[day - toEpochDay(s.startDate)];
		return isReading(v) ? v : null;
	};
	const info: RainSourceInfo = {
		periods: periods.map((p, k) => {
			const f = factors[k]!;
			const alt = series[p.series];
			const out: RainSourcePeriodInfo = {
				start: p.start,
				end: p.end,
				series: p.series,
				reason: p.reason,
				...f,
				gaugeInChirps: p.gaugeInChirps === true,
				seriesPresent: !!alt,
				...(alt?.provenance !== undefined ? { seriesProvenance: alt.provenance ? { ...alt.provenance } : null } : {}),
				runDays: 0,
				seriesDays: 0,
				seriesRawMm: 0,
				seriesMm: 0,
				chirpsDays: 0,
				reanalysisDays: 0,
				forecastDays: 0,
				noneDays: 0
			};
			const rean = f.fallback === 'chirps' ? undefined : series[f.fallback.era.series];
			const from = Math.max(toEpochDay(p.start), start);
			const to = Math.min(toEpochDay(p.end), start + days - 1);
			for (let day = from; day <= to; day++) {
				const t = day - start;
				const m = monthOfEpochDay(day) - 1;
				out.runDays++;
				const v = valueOn(alt, day);
				const fm = f.factors[m];
				if (v !== null && fm != null) {
					catchment[t] = v * fm;
					code[t] = RAIN_SOURCE_CODE.series;
					out.seriesDays++;
					out.seriesRawMm += v;
					out.seriesMm += v * fm;
					continue;
				}
				catchment[t] = null;
				if (f.fallback === 'chirps') continue;
				blockChirps[t] = 1;
				const r = valueOn(rean, day);
				const g = f.fallback.factors[m];
				if (r !== null && g != null) {
					catchment[t] = r * g;
					code[t] = RAIN_SOURCE_CODE.reanalysis;
					out.reanalysisDays++;
				}
			}
			return out;
		})
	};
	return { info, blockChirps, code };
}

/**
 * The per-day source of the rain used, and the fall-through counts: `chirps`
 * and `forecast` are the run-aligned values that stand in on a blank day
 * (CHIRPS already corrected and blocked where it may not fill).
 */
export function finishRainSource(
	rs: RainSourceRun,
	catchment: readonly (number | null)[],
	chirps: readonly (number | null)[],
	forecast: readonly (number | null)[],
	start: number
): Float64Array {
	const col = new Float64Array(catchment.length);
	for (let t = 0; t < col.length; t++) {
		if (rs.code[t]! >= 0) col[t] = rs.code[t]!;
		else if (catchment[t] != null) col[t] = RAIN_SOURCE_CODE.catchment;
		else if (chirps[t] != null) col[t] = RAIN_SOURCE_CODE.chirps;
		else if (forecast[t] != null) col[t] = RAIN_SOURCE_CODE.forecast;
		else col[t] = NaN;
	}
	for (const p of rs.info.periods) {
		const from = Math.max(toEpochDay(p.start), start);
		const to = Math.min(toEpochDay(p.end), start + col.length - 1);
		for (let day = from; day <= to; day++) {
			const c = col[day - start]!;
			if (c === RAIN_SOURCE_CODE.chirps) p.chirpsDays++;
			else if (c === RAIN_SOURCE_CODE.forecast) p.forecastDays++;
			else if (Number.isNaN(c)) p.noneDays++;
		}
	}
	return col;
}

// ---------------------------------------------------------------------------
// Words: warnings, the summary CSV, run comparison, fit provenance
// ---------------------------------------------------------------------------

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const yearSpan = (a: number, b: number) => (a === b ? waterYearLabel(a) : `${waterYearLabel(a)}–${waterYearLabel(b)}`);
const windowText = (w: ChirpsFitWindow | null) => (w ? yearSpan(w.fromWaterYear, w.toWaterYear) : 'no shared days');

/** Calendar-month factors in water-year order, "Oct 1.10, Nov 1.05, …" (a month without one: "Oct none"). */
export const rainSourceFactorText = (factors: readonly (number | null)[]): string =>
	WY_MONTHS.map((m) => `${MONTH_ABBR[m - 1]} ${factors[m - 1] == null ? 'none' : factors[m - 1]!.toFixed(2)}`).join(', ');

/** Where a period's factors came from, in words. */
export function rainSourceFactorOrigin(p: Pick<RainSourcePeriodInfo, 'factorMode' | 'provenance' | 'fit'>): string {
	if (p.factorMode === 'fixed') {
		const v = p.provenance;
		return v ? `fixed, from ${v.source}, fitted on ${v.fittedFrom} to ${v.fittedTo} by ${v.method}` : 'fixed';
	}
	const f = p.fit!;
	return (
		`fitted against ${rainSourceKindName(f.reference.series)}: catchment ÷ reference over the reference era ` +
		`${yearSpan(f.reference.fromWaterYear, f.reference.toWaterYear)} (shared days in ${windowText(f.referenceWindow)}), ` +
		`÷ series ÷ reference over the period (${windowText(f.periodWindow)})`
	);
}

/** A period's fallback in words. */
export const rainSourceFallbackText = (fb: RainSourcePeriodInfo['fallback']): string =>
	fb === 'chirps'
		? 'CHIRPS × the CHIRPS fit-period factors'
		: `${rainSourceKindName(fb.era.series)} × catchment ÷ ${rainSourceKindName(fb.era.series)} factors over ${yearSpan(fb.era.fromWaterYear, fb.era.toWaterYear)} (shared days in ${windowText(fb.fitWindow)})`;

/** The periods as settings, in words: for run comparison and fit provenance. */
export function rainSourceText(periods: unknown): string {
	if (!Array.isArray(periods) || periods.length === 0) return 'none (the catchment series throughout)';
	return (periods as RainSourcePeriod[])
		.map((p) => {
			const f = p.factors === 'fit' ? `fitted against ${rainSourceKindName(p.fitReference?.series ?? '')} ${p.fitReference ? yearSpan(p.fitReference.fromWaterYear, p.fitReference.toWaterYear) : ''}`.trim() : `fixed factors ${Array.isArray(p.factors) ? p.factors.join('/') : ''}`;
			const fb = p.fallback ? `, gaps from ${rainSourceKindName(p.fallback.series)} ${yearSpan(p.fallback.fromWaterYear, p.fallback.toWaterYear)}` : '';
			return `${p.start} to ${p.end}: ${rainSourceKindName(p.series)}, ${f}${fb} (${p.reason})`;
		})
		.join('; ');
}

/** One run warning per period: where its days' rain came from and the factors. */
export function rainSourcePeriodWarnings(info: RainSourceInfo | null): string[] {
	if (!info) return [];
	return info.periods.map((p) => {
		const head = `Catchment rain from the ${rainSourceKindName(p.series)} over ${p.start} to ${p.end} (${p.reason})`;
		if (!p.seriesPresent) {
			return `${head}: the project has no ${p.series} series, so all ${plural(p.runDays, 'run day')} fall through to ${rainSourceFallbackText(p.fallback)}, then forecast rain.`;
		}
		const through: string[] = [];
		if (p.chirpsDays) through.push(`${p.chirpsDays} from CHIRPS (bias-corrected)`);
		if (p.reanalysisDays) through.push(`${p.reanalysisDays} from the reanalysis`);
		if (p.forecastDays) through.push(`${p.forecastDays} from forecast rain`);
		if (p.noneDays) through.push(`${p.noneDays} with no value (run as 0 mm)`);
		const missingMonths = WY_MONTHS.filter((m) => p.factors[m - 1] == null).map((m) => MONTH_ABBR[m - 1]);
		return (
			`${head}: ${p.seriesDays} of ${plural(p.runDays, 'run day')} from the series ` +
			`(${Math.round(p.seriesRawMm)} mm → ${Math.round(p.seriesMm)} mm × monthly factor)` +
			(through.length ? `; its gaps: ${through.join(', ')}` : '') +
			`. Factors (${rainSourceFactorOrigin(p)}): ${rainSourceFactorText(p.factors)}.` +
			(missingMonths.length ? ` ${missingMonths.join(', ')} ha${missingMonths.length === 1 ? 's' : 've'} no factor, so their days fall through to ${rainSourceFallbackText(p.fallback)}.` : '') +
			' The primary catchment series is not used in the period and stays out of every factor fit. Settings → Rain source.'
		);
	});
}

/**
 * One line per period a run applied, with its factors, their origin
 * (provenance, or the fit's reference and windows) and its fallback: what run
 * comparison sets side by side. Empty without periods (or before 0.30.0).
 */
export function rainSourceLines(info: RainSourceInfo | null | undefined): string[] {
	return (info?.periods ?? []).map(
		(p) =>
			`${p.start} to ${p.end} (${p.reason}): ${rainSourceKindName(p.series)}` +
			`${p.seriesProvenance !== undefined ? ` (${provenanceLabel(p.seriesProvenance)})` : ''} × ${rainSourceFactorText(p.factors)}; ` +
			`${rainSourceFactorOrigin(p)}; gaps from ${rainSourceFallbackText(p.fallback)}`
	);
}
