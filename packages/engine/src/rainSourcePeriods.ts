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
//
// Daily intensity (engine ≥ 1.21.0, issue #66): a monthly factor keeps the
// series' own wet-day distribution, and a single automatic gauge has more
// intense days than a mean of several gauges. Every period reports the share
// of its rain on heavy days (≥ HEAVY_DAY_MM) against the primary record's in
// a reference era, and warns when they differ by more than HEAVY_SHARE_BAND.
// An opt-in `quantileMap` then maps the scaled series' wet days (≥ wetDayMm)
// onto the primary record's wet-day distribution over its era (./quantileMap),
// calendar month by month; a month with fewer than QM_MIN_WET_DAYS wet days
// on either side pools its 3-month season, and a season too thin keeps the
// monthly factor alone. Each calendar month of the period (a year-month)
// then has its wet days rescaled to the scaled wet total, so every month's
// rain is exactly what the factor alone gives: the mapping moves rain
// between days, never in or out of a month.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearLabel, waterYearOf } from './calendar';
import { EXCLUSION_REASON_MAX, EXCLUSIONS_MAX } from './calibrate/provenance';
import {
	RAIN_SOURCE_FALLBACKS,
	RAIN_SOURCE_REFERENCES,
	RAIN_SOURCE_SERIES,
	type DailySeries,
	type RainSourceFactorProvenance,
	type RainSourcePeriod,
	type RainSourceQuantileMap,
	type RainSourceReferenceEra,
	type SeriesKind,
	type ZeroRainSettings
} from './project';
import { rainVsChirps } from './quality';
import { heavyDayShare, mapWetDay, quantileTable, rescaleToTotal } from './quantileMap';
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

/** A heavy day, mm: the daily-intensity check's threshold (calibration-research.md §4). */
export const HEAVY_DAY_MM = 20;
/** Warn when a period's heavy-day share differs from the reference era's by more than this (share points, 0.05 = 5 %). */
export const HEAVY_SHARE_BAND = 0.05;
/** The quantile map's wet-day threshold a new period starts with, and its allowed range, mm. */
export const QM_WET_DAY_MM_DEFAULT = 1;
export const QM_WET_DAY_MM_MIN = 0.1;
export const QM_WET_DAY_MM_MAX = 10;
/** Wet days a month (else its season) needs on each side, reference era and period, before it is mapped. */
export const QM_MIN_WET_DAYS = 30;

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

const PERIOD_KEYS = new Set(['start', 'end', 'series', 'factors', 'provenance', 'fitReference', 'fallback', 'gaugeInChirps', 'quantileMap', 'reason']);

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
	if (o.quantileMap !== undefined) {
		const q = plainObject(o.quantileMap);
		if (!q) return 'quantileMap must be { fromWaterYear, toWaterYear, wetDayMm }';
		const bad = Object.keys(q).filter((k) => k !== 'fromWaterYear' && k !== 'toWaterYear' && k !== 'wetDayMm');
		if (bad.length) return `quantileMap has unknown field${bad.length === 1 ? '' : 's'} ${bad.join(', ')}`;
		if (!isYear(q.fromWaterYear) || !isYear(q.toWaterYear) || q.fromWaterYear > q.toWaterYear) return 'quantileMap needs a reference era of water years (first ≤ last)';
		if (typeof q.wetDayMm !== 'number' || !Number.isFinite(q.wetDayMm) || q.wetDayMm < QM_WET_DAY_MM_MIN || q.wetDayMm > QM_WET_DAY_MM_MAX) {
			return `quantileMap's wet-day threshold must be ${QM_WET_DAY_MM_MIN}–${QM_WET_DAY_MM_MAX} mm`;
		}
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
	if (o.quantileMap !== undefined) {
		const q = o.quantileMap as RainSourceQuantileMap;
		p.quantileMap = { fromWaterYear: q.fromWaterYear, toWaterYear: q.toWaterYear, wetDayMm: q.wetDayMm };
	}
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

/** Heavy-day rain over a sample: total, the share on days ≥ HEAVY_DAY_MM, and how many such days; and how often it is wet. */
export interface HeavyDayShare {
	/** Share of the rain that fell on heavy days (0 … 1); null with no rain. */
	share: number | null;
	totalMm: number;
	heavyDays: number;
	/** Days with a reading, and those at or above the wet-day threshold. */
	days: number;
	wetDays: number;
}

/** The daily-intensity check of a period (engine ≥ 1.21.0): heavy-day shares, reference vs period. */
export interface RainSourceIntensity {
	heavyDayMm: number;
	band: number;
	/** The wet-day threshold `wetDays` counts at: the quantile map's, else QM_WET_DAY_MM_DEFAULT. */
	wetDayMm: number;
	reference: HeavyDayShare & {
		/**
		 * The water years read: the quantile map's era, else a 'fit' period's
		 * reference era; null = the whole trusted primary record (outside
		 * every period, off suspect days).
		 */
		era: { fromWaterYear: number; toWaterYear: number } | null;
		/** Water years that actually gave readings. */
		window: ChirpsFitWindow | null;
	};
	/** The series × its monthly factor over the whole period (every day it has a reading and the month a factor). */
	scaled: HeavyDayShare;
	/** The same days after the quantile map; null without one. */
	mapped: HeavyDayShare | null;
	/** |scaled − reference| > band; null when either share is. */
	differs: boolean | null;
}

/** One calendar month of a period's quantile map. */
export interface RainSourceQuantileMonth {
	/** Calendar month 1–12. */
	month: number;
	/** What the month is mapped with: its own wet days, its 3-month season's, or nothing (the monthly factor alone). */
	basis: 'month' | 'season' | null;
	/** Wet days behind the basis (the month's own when it isn't mapped): primary record over the era, and the scaled series over the period. */
	referenceWetDays: number;
	periodWetDays: number;
}

/** A period's quantile map as a run applied it (the tables stay with the fit, RainSourcePeriodFactors). */
export interface RainSourceQuantileMapInfo {
	era: { fromWaterYear: number; toWaterYear: number };
	/** Water years of the primary record that gave readings. */
	window: ChirpsFitWindow | null;
	wetDayMm: number;
	minWetDays: number;
	/** Calendar months Jan … Dec. */
	months: RainSourceQuantileMonth[];
	/** Run days whose rain the map changed (wet days of a mapped month). */
	mappedDays: number;
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
	/** The daily-intensity check (engine ≥ 1.21.0; absent before). */
	intensity?: RainSourceIntensity;
	/** The opt-in quantile map (engine ≥ 1.21.0): null = monthly factor alone; absent before 1.21.0. */
	quantileMap?: RainSourceQuantileMapInfo | null;
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

/** The calendar months of a month's 3-month season (DJF, MAM, JJA, SON). */
export const seasonOf = (m: number): number[] => {
	if (m === 12 || m <= 2) return [12, 1, 2];
	const first = m - (m % 3);
	return [first, first + 1, first + 2];
};

/** A period's quantile map as fitted: the run info's fields plus one pair of tables per calendar month (null = not mapped). */
export type RainSourceQuantileMapFit = Omit<RainSourceQuantileMapInfo, 'mappedDays'> & {
	tables: ({ source: number[]; target: number[] } | null)[];
};

/** A period's fits from the whole stored record (what a warm-start snapshot pins). */
export type RainSourcePeriodFactors = Pick<RainSourcePeriodInfo, 'factors' | 'fit' | 'fallback' | 'factorMode' | 'provenance'> & {
	/** The daily-intensity check's reference side (engine ≥ 1.21.0; absent on a fit pinned before). */
	intensityReference?: RainSourceIntensity['reference'];
	quantileMap?: RainSourceQuantileMapFit | null;
};

/** Each day of the period the series has a reading and its month a factor: epoch day, calendar month, series × factor. */
function scaledDays(alt: DailySeries | undefined, p: RainSourcePeriod, factors: readonly (number | null)[]): { day: number; month: number; mm: number }[] {
	if (!alt) return [];
	const s0 = toEpochDay(alt.startDate);
	const a = Math.max(toEpochDay(p.start), s0);
	const b = Math.min(toEpochDay(p.end), s0 + alt.values.length - 1);
	const out: { day: number; month: number; mm: number }[] = [];
	for (let day = a; day <= b; day++) {
		const v = alt.values[day - s0];
		const month = monthOfEpochDay(day);
		const f = factors[month - 1];
		if (isReading(v) && f != null) out.push({ day, month, mm: v * f });
	}
	return out;
}

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
): RainSourcePeriodFactors[] {
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
		// The daily-intensity reference: the primary record's trusted readings over an era.
		const refEra = p.quantileMap ?? (p.factors === 'fit' ? p.fitReference! : null);
		const refSpan = refEra ? eraSpan({ series: 'rain_chirps_mm', ...refEra }) : ([-Infinity, Infinity] as const);
		const byMonth: number[][] = Array.from({ length: 13 }, () => []);
		const refValues: number[] = [];
		let lo = Infinity;
		let hi = -Infinity;
		if (primary) {
			const p0 = toEpochDay(primary.startDate);
			const a = Math.max(refSpan[0], p0);
			const b = Math.min(refSpan[1], p0 + primary.values.length - 1);
			for (let day = a; day <= b; day++) {
				const v = primary.values[day - p0];
				if (!isReading(v) || !trusted(day)) continue;
				refValues.push(v);
				if (p.quantileMap && v >= p.quantileMap.wetDayMm) byMonth[monthOfEpochDay(day)]!.push(v);
				const wy = waterYearOf(day);
				if (wy < lo) lo = wy;
				if (wy > hi) hi = wy;
			}
		}
		const window = Number.isFinite(lo) ? { fromWaterYear: lo, toWaterYear: hi } : null;
		const intensityReference: RainSourceIntensity['reference'] = {
			...shareOf(refValues, p.quantileMap?.wetDayMm ?? QM_WET_DAY_MM_DEFAULT),
			era: refEra ? { fromWaterYear: refEra.fromWaterYear, toWaterYear: refEra.toWaterYear } : null,
			window
		};
		let quantileMap: RainSourceQuantileMapFit | null = null;
		if (p.quantileMap) {
			const q = p.quantileMap;
			const periodByMonth: number[][] = Array.from({ length: 13 }, () => []);
			for (const d of scaledDays(series[p.series], p, factors)) if (d.mm >= q.wetDayMm) periodByMonth[d.month]!.push(d.mm);
			const pool = (ms: number[], src: number[][]) => ms.flatMap((k) => src[k]!);
			const months: RainSourceQuantileMonth[] = [];
			const tables: RainSourceQuantileMapFit['tables'] = [];
			for (let m = 1; m <= 12; m++) {
				let basis: RainSourceQuantileMonth['basis'] = null;
				let ref = byMonth[m]!;
				let per = periodByMonth[m]!;
				if (ref.length >= QM_MIN_WET_DAYS && per.length >= QM_MIN_WET_DAYS) basis = 'month';
				else {
					const sr = pool(seasonOf(m), byMonth);
					const sp = pool(seasonOf(m), periodByMonth);
					if (sr.length >= QM_MIN_WET_DAYS && sp.length >= QM_MIN_WET_DAYS) {
						basis = 'season';
						ref = sr;
						per = sp;
					}
				}
				months.push({ month: m, basis, referenceWetDays: ref.length, periodWetDays: per.length });
				tables.push(basis ? { source: quantileTable(per)!, target: quantileTable(ref)! } : null);
			}
			quantileMap = { era: { fromWaterYear: q.fromWaterYear, toWaterYear: q.toWaterYear }, window, wetDayMm: q.wetDayMm, minWetDays: QM_MIN_WET_DAYS, months, tables };
		}
		return { factors, fit, fallback, factorMode: p.factors === 'fit' ? 'fit' : 'fixed', provenance: p.provenance ? { ...p.provenance } : null, intensityReference, quantileMap };
	});
}

/** The heavy-day share of `values` and how many are wet (≥ wetMm). */
function shareOf(values: readonly number[], wetMm: number): HeavyDayShare {
	const h = heavyDayShare(values, HEAVY_DAY_MM);
	return { share: h.share, totalMm: h.totalMm, heavyDays: h.heavyDays, days: values.length, wetDays: values.filter((v) => v >= wetMm).length };
}

/**
 * A period's rain from the series over the whole period (not only the run's
 * days, so a shorter run doesn't change a day's value): series × factor, and
 * with a quantile map each year-month's wet days mapped and rescaled to that
 * year-month's scaled wet total. Keyed by epoch day; `mapped` holds the days
 * the map changed.
 */
export function periodRain(
	alt: DailySeries | undefined,
	p: RainSourcePeriod,
	f: RainSourcePeriodFactors
): { rain: Map<number, number>; mapped: Set<number>; scaled: HeavyDayShare; after: HeavyDayShare | null } {
	const days = scaledDays(alt, p, f.factors);
	const rain = new Map<number, number>();
	for (const d of days) rain.set(d.day, d.mm);
	const mapped = new Set<number>();
	const wetMm = f.quantileMap?.wetDayMm ?? QM_WET_DAY_MM_DEFAULT;
	const scaled = shareOf(days.map((d) => d.mm), wetMm);
	const qm = f.quantileMap;
	if (!qm) return { rain, mapped, scaled, after: null };
	// Year-month blocks of the wet days in mapped months.
	const blocks = new Map<string, { day: number; mm: number; month: number }[]>();
	for (const d of days) {
		if (d.mm < qm.wetDayMm || !qm.tables[d.month - 1]) continue;
		const key = fromEpochDay(d.day).slice(0, 7);
		let b = blocks.get(key);
		if (!b) blocks.set(key, (b = []));
		b.push(d);
	}
	for (const b of blocks.values()) {
		const t = qm.tables[b[0]!.month - 1]!;
		const raw = b.map((d) => d.mm);
		const total = raw.reduce((s, x) => s + x, 0);
		const r = rescaleToTotal(
			raw.map((x) => mapWetDay(t.source, t.target, x, qm.wetDayMm)),
			raw,
			total
		);
		b.forEach((d, i) => {
			rain.set(d.day, r.values[i]!);
			if (!r.kept) mapped.add(d.day);
		});
	}
	const after = shareOf(days.map((d) => rain.get(d.day)!), wetMm);
	return { rain, mapped, scaled, after };
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
	factors: readonly RainSourcePeriodFactors[],
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
			const pr = periodRain(alt, p, f);
			const ref = f.intensityReference;
			const intensity: RainSourceIntensity | undefined = ref
				? {
						heavyDayMm: HEAVY_DAY_MM,
						band: HEAVY_SHARE_BAND,
						wetDayMm: f.quantileMap?.wetDayMm ?? QM_WET_DAY_MM_DEFAULT,
						reference: ref,
						scaled: pr.scaled,
						mapped: pr.after,
						differs: ref.share === null || pr.scaled.share === null ? null : Math.abs(pr.scaled.share - ref.share) > HEAVY_SHARE_BAND
					}
				: undefined;
			const qm = f.quantileMap;
			const out: RainSourcePeriodInfo = {
				start: p.start,
				end: p.end,
				series: p.series,
				reason: p.reason,
				factors: f.factors,
				fit: f.fit,
				fallback: f.fallback,
				factorMode: f.factorMode,
				provenance: f.provenance,
				gaugeInChirps: p.gaugeInChirps === true,
				seriesPresent: !!alt,
				...(alt?.provenance !== undefined ? { seriesProvenance: alt.provenance ? { ...alt.provenance } : null } : {}),
				...(intensity ? { intensity } : {}),
				...(qm !== undefined ? { quantileMap: qm ? { era: qm.era, window: qm.window, wetDayMm: qm.wetDayMm, minWetDays: qm.minWetDays, months: qm.months, mappedDays: 0 } : null } : {}),
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
					const mm = pr.rain.get(day) ?? v * fm;
					catchment[t] = mm;
					code[t] = RAIN_SOURCE_CODE.series;
					out.seriesDays++;
					out.seriesRawMm += v;
					out.seriesMm += mm;
					if (out.quantileMap && pr.mapped.has(day)) out.quantileMap.mappedDays++;
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
			const qm = p.quantileMap ? `, wet days (≥ ${p.quantileMap.wetDayMm} mm) quantile-mapped onto the catchment series ${yearSpan(p.quantileMap.fromWaterYear, p.quantileMap.toWaterYear)}` : '';
			return `${p.start} to ${p.end}: ${rainSourceKindName(p.series)}, ${f}${fb}${qm} (${p.reason})`;
		})
		.join('; ');
}

const pct = (x: number | null) => (x === null ? 'no rain' : `${Math.round(x * 100)} %`);

/** The months (water-year order) grouped by the quantile map's basis: "by month: Oct, Nov; by season: Apr, May; not mapped …: Jun". */
function basisText(months: readonly RainSourceQuantileMonth[]): string {
	const groups: [string, RainSourceQuantileMonth['basis']][] = [
		['by month', 'month'],
		['by season', 'season'],
		[`not mapped (fewer than ${QM_MIN_WET_DAYS} wet days even over the season)`, null]
	];
	return groups
		.map(([label, basis]) => {
			const ms = WY_MONTHS.filter((m) => (months[m - 1]?.basis ?? null) === basis).map((m) => MONTH_ABBR[m - 1]);
			return ms.length ? `${label}: ${ms.join(', ')}` : '';
		})
		.filter(Boolean)
		.join('; ');
}

/** The quantile map as applied, in words (warnings, run comparison, the summary CSV); null without one. */
export function rainSourceQuantileMapText(q: RainSourceQuantileMapInfo | null | undefined): string | null {
	if (!q) return null;
	return (
		`wet days (≥ ${q.wetDayMm} mm) quantile-mapped onto the primary catchment series over ${yearSpan(q.era.fromWaterYear, q.era.toWaterYear)} ` +
		`(readings in ${windowText(q.window)}), each month's total kept; ${basisText(q.months)}`
	);
}

/** Where the daily-intensity check's reference came from, in words. */
export const rainSourceIntensityReferenceText = (r: RainSourceIntensity['reference']): string =>
	r.era
		? `the primary catchment series over ${yearSpan(r.era.fromWaterYear, r.era.toWaterYear)} (readings in ${windowText(r.window)})`
		: `the whole trusted primary catchment series (${windowText(r.window)})`;

/**
 * The daily-intensity check in words, or null when there is nothing to say:
 * a period with a quantile map (what it did), or one whose heavy-day share
 * differs from the reference by more than the band (consider mapping).
 */
export function rainSourceIntensityWarning(p: RainSourcePeriodInfo): string | null {
	const i = p.intensity;
	if (!i) return null;
	const wet = (h: HeavyDayShare) => (h.days ? `${Math.round((h.wetDays / h.days) * 100)} %` : 'no');
	const head =
		`Daily intensity of the ${rainSourceKindName(p.series)} over ${p.start} to ${p.end}: ${pct(i.scaled.share)} of its rain × factor fell on heavy days ` +
		`(≥ ${i.heavyDayMm} mm), against ${pct(i.reference.share)} in ${rainSourceIntensityReferenceText(i.reference)}; wet (≥ ${i.wetDayMm} mm) on ${wet(i.scaled)} of days against ${wet(i.reference)}`;
	if (p.quantileMap) {
		return `${head}. After the quantile map, ${pct(i.mapped?.share ?? null)} on heavy days: ${rainSourceQuantileMapText(p.quantileMap)}; ${plural(p.quantileMap.mappedDays, 'run day')} changed.`;
	}
	if (!i.differs) return null;
	return (
		`${head}. The heavy-day shares are more than ${Math.round(i.band * 100)} points apart: a monthly factor keeps the gauge's own wet-day distribution, and GR4J turns ` +
		'heavier days into more flow. Consider quantile-mapping its wet days onto the primary series (Settings → Rain source), or carry the runoff effect in the calibration band. ' +
		'The map keeps each month’s total and its wet days, so it corrects the spread of the falls, not how often it rains: a gap that comes from fewer wet days stays.'
	);
}

/** Run warnings per period: where its days' rain came from and the factors, then the daily-intensity check when it has something to say. */
export function rainSourcePeriodWarnings(info: RainSourceInfo | null): string[] {
	if (!info) return [];
	return info.periods.flatMap((p) => {
		const intensity = rainSourceIntensityWarning(p);
		return intensity ? [periodWarning(p), intensity] : [periodWarning(p)];
	});
}

function periodWarning(p: RainSourcePeriodInfo): string {
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
		`(${Math.round(p.seriesRawMm)} mm → ${Math.round(p.seriesMm)} mm × monthly factor${p.quantileMap ? ', wet days quantile-mapped' : ''})` +
		(through.length ? `; its gaps: ${through.join(', ')}` : '') +
		`. Factors (${rainSourceFactorOrigin(p)}): ${rainSourceFactorText(p.factors)}.` +
		(missingMonths.length ? ` ${missingMonths.join(', ')} ha${missingMonths.length === 1 ? 's' : 've'} no factor, so their days fall through to ${rainSourceFallbackText(p.fallback)}.` : '') +
		' The primary catchment series is not used in the period and stays out of every factor fit. Settings → Rain source.'
	);
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
			`${rainSourceFactorOrigin(p)}; gaps from ${rainSourceFallbackText(p.fallback)}` +
			(p.quantileMap ? `; ${rainSourceQuantileMapText(p.quantileMap)}` : '')
	);
}
