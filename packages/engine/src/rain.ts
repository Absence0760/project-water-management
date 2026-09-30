// Rain used: bias correction of the CHIRPS fallback (engine ≥ 0.7.0, audit B1).
//
// Rain used (model.md §2.4, column R) is the first non-blank of catchment,
// CHIRPS and forecast rain. CHIRPS is a 0.05° satellite-and-gauge product; at
// catchment scale it can read a fraction of the catchment's own gauges
// (strongly so in mountain catchments and in the dry season). Used raw, a year
// whose catchment rain is blank then runs far too dry, and a model that
// conserves water (GR4J) makes almost no flow in it.
//
// So, per calendar month, CHIRPS used as fallback is scaled by
//   factor(m) = Σ catchment rain / Σ CHIRPS
// over the days of month m where both have a reading, leaving out suspect
// catchment data: low-vs-CHIRPS water years whole, and the days of flagged
// zero runs not kept dry and of listed missing periods one by one (engine ≥
// 0.18.0; before, every year a flagged run touched). Kept-dry days stay in,
// unless CHIRPS contradicts them (the keep-dry guard, chirpsBiasFactors).
// A month with too small a sample takes the factor pooled over all
// months; without even that, CHIRPS stays raw and the run warns. Factors are
// clamped to CHIRPS_FACTOR_MIN … CHIRPS_FACTOR_MAX.
//
// Quantile map (engine ≥ 1.47.0, CR-23, opt-in settings.chirpsQuantileMap):
// a monthly factor fixes CHIRPS' level but keeps its own wet-day frequency
// and intensity, and a 0.05° cell is wet on more days, with fewer heavy
// days, than a gauge. With the map on, CHIRPS × factor is fitted against the
// catchment rain per calendar month on the same shared days the factors are
// (the fit period, all listed ranges together), with the rain-source
// periods' rule (./quantileMap fitMonthlyTables): a month with fewer than
// QM_MIN_WET_DAYS wet days on either side pools its 3-month season, and a
// season too thin keeps the monthly factor alone (and the run warns). Where
// CHIRPS is wet (≥ wetDayMm) more often than the catchment, its wet-day
// threshold rises until the rates agree (local intensity scaling), and its
// wet days are quantile-mapped onto the catchment's. Each calendar month of
// the CHIRPS record is then mapped as a block: days below the threshold go
// dry, the wet days take their mapped values, and all are rescaled to the
// month's factor-corrected total, so the map moves rain between a month's
// days, never in or out of the month. A gap day reads that month's mapped
// value, whatever the run's window.
//
// Catchment rain is never changed, and neither is forecast rain (the third
// source): there is no overlap to fit a forecast factor from, and a forecast
// product's bias isn't CHIRPS's.
//
// Zero-rain runs treated as missing (engine ≥ 0.15.0, CR-20, issue #3): a zero
// is a reading, so on its own it blocks the fallback. A run therefore blanks
// the catchment rain on the days of every zero run the issue #2 check flags
// (unless settings.zeroRainRuns says 'asRecorded', or lists the run as
// keep-dry) and on every period the settings list as missing, before rain used
// is picked. Those days then take corrected CHIRPS, then forecast rain, like
// any blank day. The stored series is never changed.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearLabel, waterYearOf } from './calendar';
import { EXCLUSION_REASON_MAX, EXCLUSIONS_MAX, exclusionRanges, sanitizeExclusions, type ExclusionRange } from './calibrate/provenance';
import {
	ACCUMULATION_MODES,
	CHIRPS_FIT_PERIOD_MODES,
	defaultZeroRainSettings,
	ZERO_RAIN_MODES,
	type AccumulationMode,
	type ChirpsBiasMode,
	type ChirpsFitPeriod,
	type ChirpsFitRange,
	type ChirpsQuantileMap,
	type DailySeries,
	type DataQualitySettings,
	type SeriesKind,
	type ZeroRainMode,
	type ZeroRainSettings
} from './project';
import { rainVsChirps, usualAnnualRainMm, zeroRainRuns, type ZeroRunOptions } from './quality';
import { fitMonthlyTables, mapBlockDryBelow, QM_MIN_WET_DAYS, quantileMapBasisText, type QuantileMapBasis } from './quantileMap';

/** A calendar month's own factor needs this many days where both series have a reading … */
export const CHIRPS_FACTOR_MIN_DAYS = 90;
/** … and at least this much CHIRPS rain on them, mm. The pooled factor needs the same. */
export const CHIRPS_FACTOR_MIN_MM = 50;
/** Factors are clamped to this range (docs/model.md §2.4b says why). */
export const CHIRPS_FACTOR_MIN = 0.25;
export const CHIRPS_FACTOR_MAX = 4;

export interface ChirpsMonthFactor {
	/** Calendar month, 1–12. */
	month: number;
	/** Days of this month, outside the excluded water years, where both series have a reading. */
	days: number;
	catchmentMm: number;
	chirpsMm: number;
	/** catchmentMm / chirpsMm when the sample is big enough, unclamped; else null. */
	ownFactor: number | null;
	/** The factor for this month (own or pooled, clamped; in a fit range, else all the ranges'); null when none is available. */
	factor: number | null;
	/** 'record' (engine ≥ 0.29.0, fit ranges only): neither the range's month nor its pooled sample was big enough, so the month's factor over all the ranges together. */
	source: 'month' | 'pooled' | 'record' | null;
	/** The factor was clamped to CHIRPS_FACTOR_MIN … CHIRPS_FACTOR_MAX. */
	clamped: boolean;
	/** Run days in this month where CHIRPS stood in for catchment rain. */
	fallbackDays: number;
}

/** A kept-dry stretch the fit doubts: bias-corrected CHIRPS reads too much rain over it (engine ≥ 0.18.0). */
export interface ChirpsKeepDryDoubt {
	/** The flagged zero run (as flagged, not clipped to the keep-dry period). */
	start: string;
	end: string;
	/** Its days kept dry that have a CHIRPS reading. */
	days: number;
	/** Bias-corrected CHIRPS over those days, mm (raw when the mode is 'none' or a month has no factor). */
	chirpsMm: number;
	/** The limit it went over: max(KEEP_DRY_DOUBT_MIN_MM, KEEP_DRY_DOUBT_ANNUAL_SHARE × the catchment's usual annual rain), mm. */
	limitMm: number;
	/** Water years its kept days fall in: left out of the fit whole. */
	waterYears: number[];
}

/** Water years that gave a fit its shared days, first and last (engine ≥ 0.29.0): the reference window of the factors. */
export interface ChirpsFitWindow {
	fromWaterYear: number;
	toWaterYear: number;
}

/**
 * One set of CHIRPS factors fitted on a listed water-year range (engine ≥
 * 0.29.0, settings.chirpsFitPeriod).
 */
export interface ChirpsFitSegment {
	/** The listed range, inclusive, and its reason. The factors are fitted on these years only. */
	fromWaterYear: number;
	toWaterYear: number;
	reason: string;
	/** Water years whose gaps these factors fill, inclusive; null = open-ended (the record's start or end). The ranges' fill spans tile every year. */
	fillFrom: number | null;
	fillTo: number | null;
	/** The water years that actually gave the fit shared days; null when none did. */
	fitWindow: ChirpsFitWindow | null;
	/** As ChirpsCorrection.pooled, over this range's shared days. */
	pooled: ChirpsCorrection['pooled'];
	/** Calendar months 1–12: own, else the range's pooled, else all the ranges' factor ('record'). */
	months: ChirpsMonthFactor[];
	/** Run counts, as ChirpsCorrection's, for the days this range's factors filled. */
	fallbackDays: number;
	correctedDays: number;
	fallbackRawMm: number;
	fallbackCorrectedMm: number;
}

/** The fit period a correction used (engine ≥ 0.29.0). */
export interface ChirpsFitPeriodInfo {
	/** 'ranges' for listed water-year ranges. */
	period: 'all' | 'ranges';
	/** The listed ranges, as resolved (empty for 'all'). */
	ranges: ChirpsFitRange[];
	/** One fit per listed range, in water-year order; empty for 'all'. */
	segments: ChirpsFitSegment[];
}

/** One calendar month of the CHIRPS gap map (engine ≥ 1.47.0). */
export interface ChirpsQuantileMonth {
	/** Calendar month 1–12. */
	month: number;
	/** What the month is mapped with: its own wet days, its 3-month season's, or nothing (the monthly factor alone). */
	basis: QuantileMapBasis;
	/** Wet days behind the basis (the month's own when it isn't mapped): catchment rain, and CHIRPS × factor, on the fit's shared days. */
	catchmentWetDays: number;
	chirpsWetDays: number;
	/**
	 * CHIRPS × factor's wet-day threshold, mm: the wet-day threshold, raised
	 * where CHIRPS is wet more often than the catchment until the two wet-day
	 * rates agree (quantileMap.ts fitMonthlyTables). Below it a gap day is dry.
	 */
	chirpsWetMm: number;
}

/** The CHIRPS gap fill's quantile map as fitted and applied (engine ≥ 1.47.0, CR-23, settings.chirpsQuantileMap). */
export interface ChirpsQuantileMapInfo {
	wetDayMm: number;
	minWetDays: number;
	/** Calendar months Jan … Dec. */
	months: ChirpsQuantileMonth[];
	/**
	 * One table pair per calendar month (null = not mapped): the fit, pinned
	 * with the factors in a model-state snapshot. Left out of a run summary
	 * (run.ts), as a rain-source period's tables are.
	 */
	tables?: ({ source: number[]; target: number[] } | null)[];
	/**
	 * A model-state snapshot taken mid-month (run.ts): the stored CHIRPS of
	 * that month before the snapshot day, so a run resumed from it with the
	 * history left out maps the month as the capture run did. Absent
	 * otherwise.
	 */
	lead?: { startDate: string; values: (number | null)[] };
	/**
	 * Run counts over the corrected gap days (applyChirpsCorrection): days
	 * whose rain the map changed (wet days mapped, drizzle days dried); days
	 * left to the factor alone, in a month the fit doesn't map
	 * (`unmappedDays`) or one the stored CHIRPS doesn't yet cover whole
	 * (`partialMonthDays`); and the gap rain by the factor alone and after
	 * the map on the same days, mm.
	 */
	mappedDays: number;
	unmappedDays: number;
	partialMonthDays: number;
	factorOnlyMm: number;
	mappedMm: number;
}

export interface ChirpsCorrection {
	mode: ChirpsBiasMode;
	/** The fit period (engine ≥ 0.29.0; absent before, when the whole record was always used). */
	fitPeriod?: ChirpsFitPeriodInfo;
	/** The water years that gave `months` / `pooled` their shared days (engine ≥ 0.29.0): the reference window; null when none did. */
	fitWindow?: ChirpsFitWindow | null;
	minDays: number;
	minMm: number;
	clampMin: number;
	clampMax: number;
	/** All months together: the factor a thin month falls back to. */
	pooled: { days: number; catchmentMm: number; chirpsMm: number; ownFactor: number | null; factor: number | null; clamped: boolean };
	/**
	 * Water years left out of the fit whole. From engine 0.18.0: the
	 * low-vs-CHIRPS years and the years of a doubted keep-dry. Before 0.18.0
	 * also every year a flagged zero run touched, kept dry or not.
	 */
	excludedWaterYears: number[];
	/** Of those, the years the low-vs-CHIRPS check flags (engine ≥ 0.18.0; absent before). */
	lowVsChirpsYears?: number[];
	/** Kept-dry stretches CHIRPS contradicts; their years are in excludedWaterYears (engine ≥ 0.18.0). */
	doubtfulKeepDry?: ChirpsKeepDryDoubt[];
	/**
	 * Days left out of the fit one by one, outside the excluded years, where
	 * both series have a reading (engine ≥ 0.18.0): days of flagged zero runs
	 * not kept dry, and days of periods listed as missing.
	 */
	flaggedDaysLeftOut?: number;
	missingDaysLeftOut?: number;
	/** Days of flagged zero runs kept dry that stay in the fit as confirmed readings (engine ≥ 0.18.0). */
	keptDryDaysInFit?: number;
	/** Days of multi-day accumulation windows left out of the fit one by one (engine ≥ 0.20.0, ./accumulation.ts). */
	accumulationDaysLeftOut?: number;
	/** Listed fit ranges only (engine ≥ 0.29.0): usable shared days in water years outside every range, left out of every fit. */
	outsideRangeDaysLeftOut?: number;
	/** With settings.rainSource periods (engine ≥ 0.30.0): shared days inside them, whose catchment reading the run replaces, left out one by one. */
	replacedDaysLeftOut?: number;
	/**
	 * Calendar months 1–12, in order: the factors over every fitted year (the
	 * whole record; with listed fit ranges, the ranges together). With fit
	 * ranges they are a thin range month's last fallback, and each month's
	 * fallbackDays still counts every day CHIRPS filled in that calendar
	 * month, whichever range's factor it took.
	 */
	months: ChirpsMonthFactor[];
	/** Run days where CHIRPS stood in for blank catchment rain. */
	fallbackDays: number;
	/** Of those, the days a factor was applied to (0 when mode is 'none'). */
	correctedDays: number;
	/** CHIRPS rain on the fallback days, before and after correction, mm (negatives count as 0). */
	fallbackRawMm: number;
	fallbackCorrectedMm: number;
	/** The quantile map (engine ≥ 1.47.0, settings.chirpsQuantileMap); absent when it is off, so a run without it is unchanged. */
	quantileMap?: ChirpsQuantileMapInfo;
}

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;
const clamp = (f: number) => Math.min(CHIRPS_FACTOR_MAX, Math.max(CHIRPS_FACTOR_MIN, f));
const enough = (days: number, chirpsMm: number) => days >= CHIRPS_FACTOR_MIN_DAYS && chirpsMm >= CHIRPS_FACTOR_MIN_MM && chirpsMm > 0;

/**
 * Keep-dry guard (engine ≥ 0.18.0). A kept-dry stretch of a flagged zero run
 * is doubted, and its water years stay out of the fit, when bias-corrected
 * CHIRPS over its kept days is above the larger of KEEP_DRY_DOUBT_MIN_MM and
 * KEEP_DRY_DOUBT_ANNUAL_SHARE × the catchment's usual annual rain
 * (docs/model.md §2.4b says why).
 */
export const KEEP_DRY_DOUBT_MIN_MM = 50;
export const KEEP_DRY_DOUBT_ANNUAL_SHARE = 0.25;

/**
 * How a catchment-rain day counts as suspect: in a settings.rainSource period
 * (engine ≥ 0.30.0: its reading is replaced), listed missing, in a multi-day
 * accumulation window (engine ≥ 0.20.0), a flagged zero run, or a flagged run
 * kept dry.
 */
export type SuspectRainDay = 'replaced' | 'missing' | 'accumulation' | 'flagged' | 'keptDry';

/** Epoch-day spans (inclusive) of accumulation windows, as the fit leaves them out (./accumulation.ts fitExcludedWindows). */
export type AccumulationSpans = readonly { from: number; to: number }[];

export interface SuspectRainDays {
	/** The status of an epoch day, or null for an ordinary day. */
	status: (day: number) => SuspectRainDay | null;
	/** Flagged zero runs with their epoch-day spans, in date order. */
	runs: { start: string; end: string; from: number; to: number }[];
}

/**
 * Which catchment-rain days are suspect, over the whole stored record, as a
 * run treats them (§2.4c): a day in a period listed as missing is 'missing'
 * (in either mode, whatever it reads). Otherwise a day of a zero run the
 * issue #2 check flags is 'keptDry' when the mode is 'missing' and a keep-dry
 * period holds it, and 'flagged' when not. In 'asRecorded' mode every flagged
 * day is 'flagged': that mode runs them dry as a blanket choice, not as a
 * confirmed reading. A day of an accumulation window in `accumulations` is
 * 'accumulation', unless it is listed missing. A day of a rain-source period
 * (`replaced`, engine ≥ 0.30.0) is 'replaced' before anything else.
 * `checks` (engine ≥ 1.20.0): settings.dataQuality and the CHIRPS series,
 * which decide which zero runs are flagged.
 */
export function suspectRainDays(
	catchment: DailySeries | undefined,
	zr: ZeroRainSettings,
	accumulations: AccumulationSpans = [],
	replaced: AccumulationSpans = [],
	checks: ZeroRunOptions = {}
): SuspectRainDays {
	const runs = catchment
		? zeroRainRuns(catchment, checks).runs.map((r) => ({ start: r.startDate, end: r.endDate, from: toEpochDay(r.startDate), to: toEpochDay(r.endDate) }))
		: [];
	const span = (r: ExclusionRange) => [toEpochDay(r.start), toEpochDay(r.end)] as const;
	const missing = exclusionRanges(zr.missing).map(span);
	const keep = zr.mode === 'missing' ? exclusionRanges(zr.keepDry).map(span) : [];
	const within = (xs: (readonly [number, number])[], day: number) => xs.some(([a, b]) => day >= a && day <= b);
	return {
		runs,
		status: (day) => {
			if (replaced.some((w) => day >= w.from && day <= w.to)) return 'replaced';
			if (within(missing, day)) return 'missing';
			if (accumulations.some((w) => day >= w.from && day <= w.to)) return 'accumulation';
			if (!runs.some((r) => day >= r.from && day <= r.to)) return null;
			return within(keep, day) ? 'keptDry' : 'flagged';
		}
	};
}

export type MonthSums = { days: number[]; cMm: number[]; hMm: number[] };

/**
 * Per-month factors from the month sums: own where the sample is big enough,
 * else pooled; clamped. With `record` (a fit range's, engine ≥ 0.29.0), a
 * month with neither takes the whole record's factor for it.
 */
export function factorsFrom(t: MonthSums, record?: readonly ChirpsMonthFactor[]): { pooled: ChirpsCorrection['pooled']; months: ChirpsMonthFactor[] } {
	const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
	const pd = sum(t.days);
	const pc = sum(t.cMm);
	const ph = sum(t.hMm);
	const pooledOwn = enough(pd, ph) ? pc / ph : null;
	const pooled = {
		days: pd,
		catchmentMm: pc,
		chirpsMm: ph,
		ownFactor: pooledOwn,
		factor: pooledOwn === null ? null : clamp(pooledOwn),
		clamped: pooledOwn !== null && clamp(pooledOwn) !== pooledOwn
	};
	const months: ChirpsMonthFactor[] = [];
	for (let m = 1; m <= 12; m++) {
		const own = enough(t.days[m]!, t.hMm[m]!) ? t.cMm[m]! / t.hMm[m]! : null;
		const raw = own ?? pooled.ownFactor;
		const rec = raw === null ? record?.[m - 1] : undefined;
		months.push({
			month: m,
			days: t.days[m]!,
			catchmentMm: t.cMm[m]!,
			chirpsMm: t.hMm[m]!,
			ownFactor: own,
			factor: raw !== null ? clamp(raw) : (rec?.factor ?? null),
			source: own !== null ? 'month' : raw !== null ? 'pooled' : rec?.factor != null ? 'record' : null,
			clamped: raw !== null ? clamp(raw) !== raw : !!rec?.clamped && rec.factor !== null,
			fallbackDays: 0
		});
	}
	return { pooled, months };
}

/**
 * The series with the catchment rain blanked on the days of `replaced`
 * (settings.rainSource periods, engine ≥ 0.30.0), for the fits' own
 * low-vs-CHIRPS judgement; the same object when there are none. The data
 * checks keep judging the series as recorded.
 */
export function withoutReplaced(series: Partial<Record<SeriesKind, DailySeries>>, replaced: AccumulationSpans | undefined): Partial<Record<SeriesKind, DailySeries>> {
	const sa = series.rain_catchment_mm;
	if (!sa || !replaced?.length) return series;
	const a0 = toEpochDay(sa.startDate);
	const values = sa.values.map((v, i) => (replaced.some((w) => a0 + i >= w.from && a0 + i <= w.to) ? null : v));
	return { ...series, rain_catchment_mm: { ...sa, values } };
}

/** Where the factors are fitted (engine ≥ 0.29.0): settings.chirpsFitPeriod. */
export interface ChirpsFitOptions {
	fitPeriod?: ChirpsFitPeriod;
	/**
	 * Epoch-day spans of the settings.rainSource periods (engine ≥ 0.30.0,
	 * ./rainSourcePeriods.ts): their catchment reading is replaced, so it stays out of
	 * every fit, like a missing period's.
	 */
	replaced?: AccumulationSpans;
	/**
	 * settings.dataQuality (engine ≥ 1.20.0): the zero-run and low-vs-CHIRPS
	 * limits decide which days and years the fit leaves out. The defaults
	 * without it.
	 */
	dq?: DataQualitySettings;
	/** settings.chirpsQuantileMap (engine ≥ 1.47.0): fit the gap map too; only in mode 'monthly'. */
	quantileMap?: ChirpsQuantileMap | null;
}

type SegmentPlan = Pick<ChirpsFitSegment, 'fromWaterYear' | 'toWaterYear' | 'reason' | 'fillFrom' | 'fillTo'>;

/**
 * One fit per listed range, fitted on its own years only. A year between two
 * ranges fills from the nearer (the later on a tie, as the one closer to
 * today's network); a year before the first or after the last from that one.
 */
function fitSegmentPlan(period: ChirpsFitPeriod): { period: ChirpsFitPeriodInfo['period']; ranges: ChirpsFitRange[]; segments: SegmentPlan[] } {
	if (!Array.isArray(period)) return { period: 'all', ranges: [], segments: [] };
	const ranges = [...period].sort((a, b) => a.fromWaterYear - b.fromWaterYear);
	const segments = ranges.map((r, k): SegmentPlan => {
		const prev = ranges[k - 1];
		const next = ranges[k + 1];
		// Gap years between two ranges: the first half (rounded down) to the earlier one.
		const fillFrom = prev ? prev.toWaterYear + Math.floor((r.fromWaterYear - prev.toWaterYear - 1) / 2) + 1 : null;
		const fillTo = next ? r.toWaterYear + Math.floor((next.fromWaterYear - r.toWaterYear - 1) / 2) : null;
		return { fromWaterYear: r.fromWaterYear, toWaterYear: r.toWaterYear, reason: r.reason, fillFrom, fillTo };
	});
	return { period: 'ranges', ranges: ranges.map((r) => ({ ...r })), segments };
}

/** The fit range whose factors fill a gap in water year `wy`, or null when the whole-record factors do. */
export function chirpsFitSegmentFor(corr: ChirpsCorrection | null, wy: number): ChirpsFitSegment | null {
	const segs = corr?.fitPeriod?.segments;
	if (!segs?.length) return null;
	return segs.find((s) => (s.fillFrom === null || wy >= s.fillFrom) && (s.fillTo === null || wy <= s.fillTo)) ?? null;
}

/** The factor CHIRPS on epoch day `day` is multiplied by where it fills a gap: its fit range's month factor, else the whole record's; null for none. Ignores the mode. */
export function chirpsFactorOn(corr: ChirpsCorrection | null, day: number): number | null {
	if (!corr) return null;
	const seg = chirpsFitSegmentFor(corr, waterYearOf(day));
	return (seg ?? corr).months[monthOfEpochDay(day) - 1]!.factor;
}

/**
 * The per-month factors from the whole stored record (not only the run
 * window, so a shorter simulation period doesn't change them). null when the
 * project has no CHIRPS series. The run counts (fallbackDays, …) are 0 here;
 * applyChirpsCorrection fills them.
 *
 * What is left out (engine ≥ 0.18.0, docs/model.md §2.4b): low-vs-CHIRPS
 * water years, whole; the days of periods listed as missing and of flagged
 * zero runs not kept dry, one by one (suspectRainDays); and the water years
 * of a kept-dry stretch that bias-corrected CHIRPS contradicts (the keep-dry
 * guard). Other kept-dry days stay in: they are confirmed readings. The guard
 * judges a stretch with factors fitted without any flagged-run day, so the
 * verdict doesn't lean on the keep-dry it is judging. The days of
 * `accumulations` (engine ≥ 0.20.0) are left out one by one too: their
 * recorded days are wrong, and their spread days are CHIRPS-shaped.
 */
export function chirpsBiasFactors(
	series: Partial<Record<SeriesKind, DailySeries>>,
	mode: ChirpsBiasMode,
	zeroRain: ZeroRainSettings = defaultZeroRainSettings(),
	accumulations: AccumulationSpans = [],
	opts: ChirpsFitOptions = {}
): ChirpsCorrection | null {
	const sb = series.rain_chirps_mm;
	if (!sb) return null;
	const sa = series.rain_catchment_mm;
	// The low-vs-CHIRPS years are judged without the replaced days (engine ≥ 0.30.0): a replaced era far below CHIRPS mustn't take the rest of its water years out too.
	const lowYears = sa ? (rainVsChirps(withoutReplaced(series, opts.replaced), opts.dq)?.flaggedYears ?? []) : [];
	const suspect = suspectRainDays(sa, zeroRain, accumulations, opts.replaced, { dq: opts.dq, chirps: sb });
	const b0 = toEpochDay(sb.startDate);

	// Shared days (both a reading) outside the low-vs-CHIRPS years, with their
	// status, water year and calendar month (read by every fit below, so each is worked out once).
	const shared: { day: number; wy: number; m: number; c: number; h: number; status: SuspectRainDay | null }[] = [];
	if (sa) {
		const low = new Set(lowYears);
		const a0 = toEpochDay(sa.startDate);
		const from = Math.max(a0, b0);
		const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
		for (let day = from; day < to; day++) {
			const va = sa.values[day - a0];
			const vb = sb.values[day - b0];
			if (!isReading(va) || !isReading(vb)) continue;
			const wy = waterYearOf(day);
			if (low.has(wy)) continue;
			shared.push({ day, wy, m: monthOfEpochDay(day), c: va, h: vb, status: suspect.status(day) });
		}
	}
	const sums = (include: (d: (typeof shared)[number]) => boolean): MonthSums => {
		const t: MonthSums = { days: new Array<number>(13).fill(0), cMm: new Array<number>(13).fill(0), hMm: new Array<number>(13).fill(0) };
		for (const d of shared) {
			if (!include(d)) continue;
			const m = d.m;
			t.days[m]!++;
			t.cMm[m] = t.cMm[m]! + d.c;
			t.hMm[m] = t.hMm[m]! + d.h;
		}
		return t;
	};

	// The keep-dry guard, judged with factors that trust no flagged-run day.
	const doubtful: ChirpsKeepDryDoubt[] = [];
	if (sa && suspect.runs.length && zeroRain.mode === 'missing' && zeroRain.keepDry.length) {
		const strict = factorsFrom(sums((d) => d.status === null)).months;
		const usual = usualAnnualRainMm(sa);
		const limitMm = Math.max(KEEP_DRY_DOUBT_MIN_MM, usual === null ? 0 : KEEP_DRY_DOUBT_ANNUAL_SHARE * usual);
		for (const r of suspect.runs) {
			let days = 0;
			let mm = 0;
			const years = new Set<number>();
			for (let day = r.from; day <= r.to; day++) {
				if (suspect.status(day) !== 'keptDry') continue;
				const h = sb.values[day - b0];
				if (!isReading(h)) continue;
				const f = mode === 'monthly' ? (strict[monthOfEpochDay(day) - 1]!.factor ?? 1) : 1;
				days++;
				mm += h * f;
				years.add(waterYearOf(day));
			}
			if (days > 0 && mm > limitMm) {
				doubtful.push({ start: r.start, end: r.end, days, chirpsMm: mm, limitMm, waterYears: [...years].sort((a, b) => a - b) });
			}
		}
	}
	const doubtYears = new Set(doubtful.flatMap((d) => d.waterYears));
	// Engine ≥ 0.29.0: the fit period. Listed ranges leave every year outside them out of every fit, the all-ranges fallback included.
	const plan = fitSegmentPlan(opts.fitPeriod ?? 'all');
	const listed = plan.period === 'ranges' ? plan.segments : null;
	const inListed = (wy: number) => !listed || listed.some((p) => wy >= p.fromWaterYear && wy <= p.toWaterYear);
	let flaggedDaysLeftOut = 0;
	let missingDaysLeftOut = 0;
	let keptDryDaysInFit = 0;
	let accumulationDaysLeftOut = 0;
	let outsideRangeDaysLeftOut = 0;
	let replacedDaysLeftOut = 0;
	for (const d of shared) {
		const wy = d.wy;
		if (doubtYears.has(wy)) continue;
		if (!inListed(wy)) {
			if (d.status === null || d.status === 'keptDry') outsideRangeDaysLeftOut++;
			continue;
		}
		if (d.status === 'replaced') replacedDaysLeftOut++;
		else if (d.status === 'missing') missingDaysLeftOut++;
		else if (d.status === 'flagged') flaggedDaysLeftOut++;
		else if (d.status === 'keptDry') keptDryDaysInFit++;
		else if (d.status === 'accumulation') accumulationDaysLeftOut++;
	}
	const inFit = (d: (typeof shared)[number]) => {
		const wy = d.wy;
		return !doubtYears.has(wy) && inListed(wy) && (d.status === null || d.status === 'keptDry');
	};
	/** The first and last water year among the days `include` keeps: a fit's reference window. */
	const windowOf = (include: (d: (typeof shared)[number]) => boolean): ChirpsFitWindow | null => {
		let lo = Infinity;
		let hi = -Infinity;
		for (const d of shared) {
			if (!include(d)) continue;
			const wy = d.wy;
			if (wy < lo) lo = wy;
			if (wy > hi) hi = wy;
		}
		return Number.isFinite(lo) ? { fromWaterYear: lo, toWaterYear: hi } : null;
	};
	const fit = factorsFrom(sums(inFit));
	// One set per listed range, from the same days, split by water year.
	const segments: ChirpsFitSegment[] = plan.segments.map((p) => {
		const include = (d: (typeof shared)[number]) => {
			const wy = d.wy;
			return inFit(d) && wy >= p.fromWaterYear && wy <= p.toWaterYear;
		};
		const f = factorsFrom(sums(include), fit.months);
		return {
			...p,
			fitWindow: windowOf(include),
			pooled: f.pooled,
			months: f.months,
			fallbackDays: 0,
			correctedDays: 0,
			fallbackRawMm: 0,
			fallbackCorrectedMm: 0
		};
	});
	const corr: ChirpsCorrection = {
		mode,
		fitPeriod: { period: plan.period, ranges: plan.ranges, segments },
		fitWindow: windowOf(inFit),
		minDays: CHIRPS_FACTOR_MIN_DAYS,
		minMm: CHIRPS_FACTOR_MIN_MM,
		clampMin: CHIRPS_FACTOR_MIN,
		clampMax: CHIRPS_FACTOR_MAX,
		pooled: fit.pooled,
		excludedWaterYears: [...new Set([...lowYears, ...doubtYears])].sort((a, b) => a - b),
		lowVsChirpsYears: lowYears,
		doubtfulKeepDry: doubtful,
		flaggedDaysLeftOut,
		missingDaysLeftOut,
		keptDryDaysInFit,
		accumulationDaysLeftOut,
		...(listed ? { outsideRangeDaysLeftOut } : {}),
		...(opts.replaced?.length ? { replacedDaysLeftOut } : {}),
		months: fit.months,
		fallbackDays: 0,
		correctedDays: 0,
		fallbackRawMm: 0,
		fallbackCorrectedMm: 0
	};
	if (opts.quantileMap && mode === 'monthly') corr.quantileMap = fitChirpsQuantileMap(corr, shared.filter(inFit), opts.quantileMap.wetDayMm);
	return corr;
}

/**
 * The gap map's tables (engine ≥ 1.47.0): per calendar month, CHIRPS × the
 * factor a gap that day would take against catchment rain, wet days only, on
 * the fit's shared days (`days`, every listed range together).
 */
function fitChirpsQuantileMap(corr: ChirpsCorrection, days: readonly { day: number; m: number; c: number; h: number }[], wetDayMm: number): ChirpsQuantileMapInfo {
	const catchment: number[][] = Array.from({ length: 13 }, () => []);
	const chirps: number[][] = Array.from({ length: 13 }, () => []);
	for (const d of days) {
		const f = chirpsFactorOn(corr, d.day);
		if (f === null) continue;
		catchment[d.m]!.push(d.c);
		chirps[d.m]!.push(d.h * f);
	}
	const fitted = fitMonthlyTables(catchment, chirps, QM_MIN_WET_DAYS, { wetDayMm, matchFrequency: true });
	return {
		wetDayMm,
		minWetDays: QM_MIN_WET_DAYS,
		months: fitted.months.map((x) => ({ month: x.month, basis: x.basis, catchmentWetDays: x.targetN, chirpsWetDays: x.sourceN, chirpsWetMm: x.sourceWetMm! })),
		tables: fitted.tables,
		mappedDays: 0,
		unmappedDays: 0,
		partialMonthDays: 0,
		factorOnlyMm: 0,
		mappedMm: 0
	};
}

/**
 * CHIRPS on a day as the gap map gives it (engine ≥ 1.47.0): the day's value
 * once its calendar month (the whole stored month, not only the run's days,
 * so the window never changes a day) is × the factor, mapped with its
 * month's threshold (below it dry, at or above it quantile-mapped) and
 * rescaled to the month's factor-corrected total (mapBlockDryBelow). null
 * where the map says nothing: no map or tables, a month it doesn't map, no
 * factor, or no reading; and a month the stored CHIRPS (with a snapshot's
 * `lead`) doesn't cover from its 1st to its last day, so a feed appending
 * the rest of the month never moves a day already filled: that month is
 * mapped once it is whole. Blocks are worked out once per month.
 */
export function chirpsQuantileMapper(corr: ChirpsCorrection | null, chirps: DailySeries | undefined): ((day: number) => number | null) | null {
	const qm = corr?.quantileMap;
	if (!corr || corr.mode !== 'monthly' || !qm?.tables || !chirps) return null;
	const tables = qm.tables;
	const c0 = toEpochDay(chirps.startDate);
	const n = chirps.values.length;
	const blocks = new Map<number, Map<number, number> | null>();
	const l0 = qm.lead ? toEpochDay(qm.lead.startDate) : 0;
	const ln = qm.lead?.values.length ?? 0;
	const inLead = (day: number) => day >= l0 && day < l0 + ln;
	// Coverage runs from the first to the last reading, so nulls stored past either end never make a month whole.
	const [r0, r1] = readingSpan(chirps);
	const covered = (day: number) => inLead(day) || (day >= r0 && day <= r1);
	const valueOn = (day: number) => {
		const v = inLead(day) ? qm.lead!.values[day - l0] : day >= c0 && day < c0 + n ? chirps.values[day - c0] : null;
		return isReading(v) ? v : null;
	};
	// The month holding the last day asked for, so a run's consecutive days work out its 1st once.
	let span = { from: 1, to: 0 };
	return (day) => {
		const m = monthOfEpochDay(day);
		const t = tables[m - 1];
		if (!t) return null;
		const f = chirpsFactorOn(corr, day);
		if (f === null || valueOn(day) === null) return null;
		if (day < span.from || day > span.to) {
			const from = toEpochDay(`${fromEpochDay(day).slice(0, 8)}01`);
			let to = from;
			while (monthOfEpochDay(to + 1) === m) to++;
			span = { from, to };
		}
		const first = span.from;
		let b = blocks.get(first);
		if (b === undefined) {
			if (!covered(first) || !covered(span.to)) {
				blocks.set(first, null);
				return null;
			}
			// Every day of the month shares the water year, so the factor.
			const read: { day: number; mm: number }[] = [];
			for (let d = first; monthOfEpochDay(d) === m; d++) {
				const w = valueOn(d);
				if (w !== null) read.push({ day: d, mm: w * f });
			}
			const r = mapBlockDryBelow(
				read.map((w) => w.mm),
				t,
				qm.months[m - 1]!.chirpsWetMm
			);
			b = new Map(read.map((w, i) => [w.day, r.values[i]!]));
			blocks.set(first, b);
		}
		return b === null ? null : b.get(day)!;
	};
}

/**
 * The correction a model-state snapshot pins (run.ts, engine ≥ 1.47.0):
 * with the gap map on and the snapshot day not a 1st, a copy holding the
 * stored CHIRPS of that month before the day (`quantileMap.lead`), so a run
 * resumed from it maps the month from the same days even when its input
 * leaves the history out. Otherwise the correction itself.
 */
export function withChirpsGapMapLead(corr: ChirpsCorrection | null, chirps: DailySeries | undefined, day: number): ChirpsCorrection | null {
	if (!corr?.quantileMap?.tables || !chirps) return corr;
	const first = toEpochDay(`${fromEpochDay(day).slice(0, 8)}01`);
	if (first === day) return corr;
	const c0 = toEpochDay(chirps.startDate);
	// A correction pinned from an earlier snapshot keeps its own lead's days (a chain of resumes with the history left out).
	const old = corr.quantileMap.lead;
	const o0 = old ? toEpochDay(old.startDate) : 0;
	// The lead covers only what the capture run's coverage covered: from its first reading (or the old lead's start), never from the 1st regardless.
	const from = Math.max(first, Math.min(old ? o0 : Infinity, readingSpan(chirps)[0]));
	if (from >= day) return corr;
	const values: (number | null)[] = [];
	for (let d = from; d < day; d++) {
		const v = old && d >= o0 && d < o0 + old.values.length ? old.values[d - o0] : d >= c0 && d < c0 + chirps.values.length ? chirps.values[d - c0] : null;
		values.push(v ?? null);
	}
	return { ...corr, quantileMap: { ...corr.quantileMap, lead: { startDate: fromEpochDay(from), values } } };
}

/** The epoch days of a series' first and last reading; [1, 0] (empty) without one. */
function readingSpan(s: DailySeries): [number, number] {
	const c0 = toEpochDay(s.startDate);
	let a = 0;
	while (a < s.values.length && !isReading(s.values[a])) a++;
	if (a === s.values.length) return [1, 0];
	let b = s.values.length - 1;
	while (!isReading(s.values[b])) b--;
	return [c0 + a, c0 + b];
}

/**
 * CHIRPS aligned to the run, corrected where it is the fallback: on a day with
 * no catchment rain value, CHIRPS × the month's factor (mode 'monthly', factor
 * available); on every other day it is returned unchanged (it isn't used
 * there). Fills the run counts in `corr` and returns the new CHIRPS array.
 */
export function applyChirpsCorrection(
	corr: ChirpsCorrection,
	catchment: readonly (number | null)[],
	chirps: readonly (number | null)[],
	month: Uint8Array,
	start = 0,
	/** The stored CHIRPS series, for the gap map's month blocks (engine ≥ 1.47.0); without it the map isn't applied. */
	stored?: DailySeries
): (number | null)[] {
	const out = chirps.slice();
	const segmented = !!corr.fitPeriod?.segments.length;
	const qm = corr.quantileMap;
	const mapped = qm ? chirpsQuantileMapper(corr, stored) : null;
	for (let t = 0; t < chirps.length; t++) {
		const v = chirps[t];
		if (catchment[t] != null || v == null) continue;
		const mf = corr.months[month[t]! - 1]!;
		// With fit ranges (engine ≥ 0.29.0) the day's own range's factor; the whole-record month still counts the day.
		const seg = segmented ? chirpsFitSegmentFor(corr, waterYearOf(start + t)) : null;
		const sf = seg ? seg.months[month[t]! - 1]! : mf;
		mf.fallbackDays++;
		corr.fallbackDays++;
		corr.fallbackRawMm += Math.max(0, v);
		if (seg) {
			if (sf !== mf) sf.fallbackDays++;
			seg.fallbackDays++;
			seg.fallbackRawMm += Math.max(0, v);
		}
		if (corr.mode === 'monthly' && sf.factor !== null) {
			out[t] = v * sf.factor;
			if (qm && mapped) {
				// The gap map (engine ≥ 1.47.0): a mapped month's wet day takes its mapped value; any other day keeps the factor.
				qm.factorOnlyMm += Math.max(0, out[t]!);
				if (!qm.tables?.[month[t]! - 1]) qm.unmappedDays++;
				else {
					const y = mapped(start + t);
					if (y !== null) {
						if (y !== out[t]) qm.mappedDays++;
						out[t] = y;
					} else if (isReading(v)) qm.partialMonthDays++;
				}
				qm.mappedMm += Math.max(0, out[t]!);
			}
			corr.correctedDays++;
			if (seg) seg.correctedDays++;
		}
		corr.fallbackCorrectedMm += Math.max(0, out[t]!);
		if (seg) seg.fallbackCorrectedMm += Math.max(0, out[t]!);
	}
	return out;
}

/**
 * The CHIRPS factors a fit ran under, as fit provenance records them
 * (FitRecord.forcing.chirpsFactors, engine ≥ 0.29.0): one entry per fit
 * range, or one for the whole record; calendar months Jan … Dec. null
 * without CHIRPS or in mode 'none'.
 */
export interface ChirpsFactorSet {
	/** "whole record", or the fit range's name and the years it fills. */
	label: string;
	/** The water years the factors were fitted on, in words (the reference window); absent on a set recorded without it. */
	fittedOn?: string;
	/** Applied factor per calendar month (Jan … Dec); null for a month without one. */
	factors: (number | null)[];
}
export function chirpsFactorSets(corr: ChirpsCorrection | null): ChirpsFactorSet[] | null {
	if (!corr || corr.mode !== 'monthly') return null;
	const segs = corr.fitPeriod?.segments ?? [];
	if (!segs.length) return [{ label: 'whole record', fittedOn: fitWindowText(corr.fitWindow), factors: corr.months.map((m) => m.factor) }];
	return segs.map((s) => ({ label: `${fitSegmentName(s)}, filling ${fitSegmentFillText(s)}`, fittedOn: fitWindowText(s.fitWindow), factors: s.months.map((m) => m.factor) }));
}

/**
 * settings.chirpsFitPeriod as the engine uses it: an unknown value, or a list
 * with no valid range, falls back to 'all' with a warning; invalid or
 * overlapping ranges are dropped with one. "Valid" is exactly what the API's
 * schema accepts (backend/src/projects/settings.ts; a table test holds the
 * two together): integer years 1800–2200, first ≤ last, a trimmed reason of
 * 1–EXCLUSION_REASON_MAX characters, no other keys, at most EXCLUSIONS_MAX
 * ranges.
 */
export function resolveChirpsFitPeriod(raw: unknown, warnings: string[]): ChirpsFitPeriod {
	if (raw == null) return 'all';
	if ((CHIRPS_FIT_PERIOD_MODES as readonly unknown[]).includes(raw)) return raw as ChirpsFitPeriod;
	if (!Array.isArray(raw)) {
		warnings.push(`unknown CHIRPS fit period "${String(raw)}"; using the whole record`);
		return 'all';
	}
	const year = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1800 && v <= 2200;
	const out: ChirpsFitRange[] = [];
	if (raw.length > EXCLUSIONS_MAX) warnings.push(`the CHIRPS fit period lists ${raw.length} ranges; only the first ${EXCLUSIONS_MAX} are used`);
	for (const r of (raw as unknown[]).slice(0, EXCLUSIONS_MAX)) {
		const o = (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
		const extra = Object.keys(o).filter((k) => k !== 'fromWaterYear' && k !== 'toWaterYear' && k !== 'reason');
		if (extra.length) {
			warnings.push(`CHIRPS fit range with unknown field${extra.length === 1 ? '' : 's'} ${extra.join(', ')}; ignored`);
			continue;
		}
		const from = o.fromWaterYear;
		const to = o.toWaterYear;
		const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
		if (!year(from) || !year(to) || from > to) {
			warnings.push(`CHIRPS fit range ${String(from)}–${String(to)} is not a water-year range (first ≤ last); ignored`);
			continue;
		}
		if (!reason) {
			warnings.push(`CHIRPS fit range ${yearSpan(from, to)} has no reason; ignored`);
			continue;
		}
		if (reason.length > EXCLUSION_REASON_MAX) {
			warnings.push(`CHIRPS fit range ${yearSpan(from, to)} has a reason longer than ${EXCLUSION_REASON_MAX} characters; ignored`);
			continue;
		}
		const clash = out.find((x) => from <= x.toWaterYear && to >= x.fromWaterYear);
		if (clash) {
			warnings.push(`CHIRPS fit range ${yearSpan(from, to)} overlaps ${yearSpan(clash.fromWaterYear, clash.toWaterYear)}; ignored`);
			continue;
		}
		out.push({ fromWaterYear: from, toWaterYear: to, reason });
	}
	if (!out.length) {
		warnings.push('the CHIRPS fit period lists no usable water-year range; using the whole record');
		return 'all';
	}
	return out.sort((a, b) => a.fromWaterYear - b.fromWaterYear);
}

/** "1990/91", or "1990/91–2004/05" for more than one year. */
const yearSpan = (a: number, b: number) => (a === b ? waterYearLabel(a) : `${waterYearLabel(a)}–${waterYearLabel(b)}`);

/** The water years a fit range fills, in words: "up to 2004/05", "2005/06–2011/12", "from 2012/13 on", "every year". */
export function fitSegmentFillText(s: Pick<ChirpsFitSegment, 'fillFrom' | 'fillTo'>): string {
	if (s.fillFrom === null && s.fillTo === null) return 'every year';
	if (s.fillFrom === null) return `up to ${waterYearLabel(s.fillTo!)}`;
	if (s.fillTo === null) return `from ${waterYearLabel(s.fillFrom)} on`;
	return yearSpan(s.fillFrom, s.fillTo);
}

/** A fit range's name: "range 2005/06–2019/20 (reason)". */
export function fitSegmentName(s: Pick<ChirpsFitSegment, 'fromWaterYear' | 'toWaterYear' | 'reason'>): string {
	return `range ${yearSpan(s.fromWaterYear, s.toWaterYear)} (${s.reason})`;
}

/** A fit's reference window in words: "1990/91–2009/10", or "no shared days". */
export function fitWindowText(w: ChirpsFitWindow | null | undefined): string {
	return w ? yearSpan(w.fromWaterYear, w.toWaterYear) : 'no shared days';
}

/** A fit period (the setting, or a correction's record of it) in words, for warnings, the summary CSV and run comparison. */
export function fitPeriodText(p: ChirpsFitPeriod | ChirpsFitPeriodInfo | undefined): string {
	const period = p === undefined ? 'all' : typeof p === 'string' || Array.isArray(p) ? p : p.period === 'ranges' ? p.ranges : 'all';
	if (!Array.isArray(period)) return 'whole record';
	return `listed water years: ${period.map((r) => `${yearSpan(r.fromWaterYear, r.toWaterYear)} (${r.reason})`).join('; ')}`;
}

/**
 * One reference window per fit, for run comparison and fit provenance: the
 * whole-record (or all-ranges) fit, then each range. Engine ≥ 0.29.0; empty
 * for a correction made before it.
 */
export function fitWindowLabels(c: ChirpsCorrection | null | undefined): string[] {
	if (!c || c.fitWindow === undefined) return [];
	const segs = c.fitPeriod?.segments ?? [];
	return [
		`${segs.length ? 'all ranges' : 'whole record'}: ${fitWindowText(c.fitWindow)}`,
		...segs.map((s) => `${fitSegmentName(s)}: ${fitWindowText(s.fitWindow)}`)
	];
}

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Water-year order, as the app's monthly settings. */
const WY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the fit left out, as one sentence for the run warning (leading space), or '' when nothing. */
export function fitExclusionText(c: ChirpsCorrection): string {
	const low = c.lowVsChirpsYears ?? c.excludedWaterYears;
	const doubt = [...new Set((c.doubtfulKeepDry ?? []).flatMap((d) => d.waterYears))].sort((a, b) => a - b);
	const parts: string[] = [];
	if (low.length) parts.push(`water years far below CHIRPS (${low.map(waterYearLabel).join(', ')})`);
	if (doubt.length) parts.push(`water years of kept-dry runs that CHIRPS contradicts (${doubt.map(waterYearLabel).join(', ')})`);
	if (c.flaggedDaysLeftOut) parts.push(`${plural(c.flaggedDaysLeftOut, 'day')} of flagged zero runs treated as missing`);
	if (c.replacedDaysLeftOut) parts.push(`${plural(c.replacedDaysLeftOut, 'day')} in rain-source periods (replaced from another series)`);
	if (c.missingDaysLeftOut) parts.push(`${plural(c.missingDaysLeftOut, 'day')} listed as missing`);
	if (c.accumulationDaysLeftOut) parts.push(`${plural(c.accumulationDaysLeftOut, 'day')} of multi-day accumulation windows`);
	const outside = c.outsideRangeDaysLeftOut ? ` ${plural(c.outsideRangeDaysLeftOut, 'shared day')} outside the listed fit ranges stay out of every fit.` : '';
	const kept = c.keptDryDaysInFit ? ` ${plural(c.keptDryDaysInFit, 'kept-dry day')} stay in the fit as confirmed readings.` : '';
	return (parts.length ? ` Left out of the fit as suspect catchment rain: ${parts.join('; ')}.` : '') + outside + kept;
}

/**
 * One warning per kept-dry stretch the keep-dry guard doubts: its kept days
 * run dry, as Settings says, but CHIRPS reads real rain over them, so its
 * water years stay out of the CHIRPS fit.
 */
export function keepDryDoubtWarnings(c: ChirpsCorrection | null): string[] {
	return (c?.doubtfulKeepDry ?? []).map(
		(d) =>
			`Kept-dry zero run ${d.start} to ${d.end} looks doubtful: ${c!.mode === 'monthly' ? 'bias-corrected ' : ''}CHIRPS reads ` +
			`${Math.round(d.chirpsMm)} mm over its ${plural(d.days, 'kept-dry day')}, above the ${Math.round(d.limitMm)} mm limit ` +
			`(the larger of ${KEEP_DRY_DOUBT_MIN_MM} mm and ${Math.round(KEEP_DRY_DOUBT_ANNUAL_SHARE * 100)} % of the catchment's usual annual rain). ` +
			`Those days still run dry, but water year${d.waterYears.length === 1 ? '' : 's'} ${d.waterYears.map(waterYearLabel).join(', ')} ` +
			'stay out of the CHIRPS factor fit. Check the keep-dry in Settings → Zero-rain runs.'
	);
}


/** The run warning for the correction, or null when CHIRPS was never the fallback (or the mode is 'none'). */
export function chirpsCorrectionWarning(c: ChirpsCorrection | null): string | null {
	if (!c || c.fallbackDays === 0 || c.mode === 'none') return null;
	const excluded = fitExclusionText(c);
	if (c.correctedDays === 0) {
		return (
			`CHIRPS rain stands in for blank catchment rain on ${c.fallbackDays} days and is not bias-corrected: ` +
			`there are fewer than ${c.minDays} days with ${c.minMm} mm of CHIRPS where both series have a reading to fit a factor from.${excluded} ` +
			'Raw CHIRPS can read well below catchment rain, so those days may run too dry.'
		);
	}
	const f = (x: number) => x.toFixed(2);
	const factors = (months: ChirpsMonthFactor[]) =>
		WY_MONTHS.map((m) => months[m - 1]!)
			.filter((mf) => mf.factor !== null)
			.map(
				(mf) =>
					`${MONTH_ABBR[mf.month]} ${f(mf.factor!)}${mf.source === 'pooled' ? ' (pooled)' : mf.source === 'record' ? ' (all ranges)' : ''}${mf.clamped ? ' (clamped)' : ''}`
			)
			.join(', ');
	const segs = c.fitPeriod?.segments ?? [];
	const head =
		`CHIRPS rain bias-corrected on ${c.correctedDays} days where catchment rain is blank ` +
		`(${Math.round(c.fallbackRawMm)} mm raw → ${Math.round(c.fallbackCorrectedMm)} mm): `;
	const rules =
		`A month with fewer than ${c.minDays} shared days, or less than ${c.minMm} mm of CHIRPS on them, uses the pooled factor` +
		(segs.length ? ' of its range, then the factor over all the listed ranges' : '') +
		`; factors are clamped to ${c.clampMin}–${c.clampMax}.`;
	const tail = `${excluded}${chirpsQuantileMapSentence(c)} Catchment and forecast rain are not changed. Settings → CHIRPS bias correction turns this off.`;
	if (segs.length) {
		// Engine ≥ 0.29.0: one set per listed range, each named with the years it was fitted on and the years it fills.
		const parts = segs.map(
			(s) => `${fitSegmentName(s)}, fitted on ${fitWindowText(s.fitWindow)}, filling ${fitSegmentFillText(s)} (${plural(s.correctedDays, 'day')}): ${factors(s.months)}`
		);
		return head + `factor = catchment / CHIRPS rain per month, fitted per listed water-year range (Settings → CHIRPS fit period): ${parts.join('; ')}. ` + rules + tail;
	}
	return head + `factor = catchment / CHIRPS rain per month, ${factors(c.months)}. ` + rules + tail;
}

/** The gap map as applied, in words (the correction warning, run comparison, the summary CSV); null without one. */
export function chirpsQuantileMapText(q: ChirpsQuantileMapInfo | null | undefined): string | null {
	if (!q) return null;
	const raised = WY_MONTHS.map((m) => q.months[m - 1]!).filter((x) => x.basis !== null && x.chirpsWetMm > q.wetDayMm);
	const freq = raised.length
		? `, CHIRPS' wet-day threshold raised to match the catchment's wet-day rate in ${raised.map((x) => `${MONTH_ABBR[x.month]} (${x.chirpsWetMm.toFixed(1)} mm)`).join(', ')}`
		: '';
	return `wet days (≥ ${q.wetDayMm} mm) quantile-mapped onto the catchment rain's wet days over the fit period${freq}, days below the threshold dry and each calendar month's corrected total kept; ${quantileMapBasisText(q.months, q.minWetDays)}`;
}

/** The warning's sentence on the gap map (leading space), or '' without one. */
function chirpsQuantileMapSentence(c: ChirpsCorrection): string {
	const q = c.quantileMap;
	if (!q) return '';
	return (
		` Quantile map (Settings → CHIRPS quantile map): ${chirpsQuantileMapText(q)}. ` +
		`${plural(q.mappedDays, 'gap day')} changed (${Math.round(q.factorOnlyMm)} mm by the factor alone → ${Math.round(q.mappedMm)} mm on the same days).`
	);
}

/**
 * The warning when the gap map falls back (engine ≥ 1.47.0): corrected gap
 * days in months it can't map take the monthly factor alone. null when the
 * map is off or maps every gap day's month.
 */
export function chirpsQuantileMapFallbackWarning(c: ChirpsCorrection | null): string | null {
	const q = c?.quantileMap;
	const partial = q?.partialMonthDays ?? 0;
	if (!c || !q || (q.unmappedDays === 0 && partial === 0)) return null;
	const months = WY_MONTHS.filter((m) => q.months[m - 1]?.basis == null && (c.months[m - 1]?.fallbackDays ?? 0) > 0).map((m) => MONTH_ABBR[m]);
	const thin = q.unmappedDays
		? `CHIRPS quantile map falls back to the monthly factor alone on ${plural(q.unmappedDays, 'gap day')}` +
			(months.length ? ` (${months.join(', ')})` : '') +
			`: those months have fewer than ${q.minWetDays} wet days (≥ ${q.wetDayMm} mm) on the catchment or the CHIRPS side over the fit period, even pooled over their 3-month season. ` +
			'Their gap days keep CHIRPS’ own wet-day distribution, at the catchment’s level.'
		: '';
	const part = partial
		? `${thin ? ' ' : 'CHIRPS quantile map: '}${plural(partial, 'gap day')} in a month the stored CHIRPS doesn't cover whole yet take the monthly factor alone; the month is mapped once CHIRPS covers it, so their rain changes then.`
		: '';
	return thin + part;
}

// ---------------------------------------------------------------------------
// Zero-rain runs treated as missing (engine ≥ 0.15.0, CR-20, issue #3)
// ---------------------------------------------------------------------------

/** Stored settings.zeroRainRuns as the engine uses them: unknown modes and invalid periods are dropped with a warning. */
export function resolveZeroRain(raw: unknown, warnings: string[]): ZeroRainSettings {
	const d = defaultZeroRainSettings();
	if (raw == null) return d;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		warnings.push('zero-rain run settings are not an object; using the defaults');
		return d;
	}
	const o = raw as Record<string, unknown>;
	let mode = d.mode;
	if (o.mode != null) {
		if ((ZERO_RAIN_MODES as readonly unknown[]).includes(o.mode)) mode = o.mode as ZeroRainMode;
		else warnings.push(`unknown zero-rain run mode "${String(o.mode)}"; using ${d.mode}`);
	}
	let accumulationMode: AccumulationMode = d.accumulationMode;
	if (o.accumulationMode != null) {
		if ((ACCUMULATION_MODES as readonly unknown[]).includes(o.accumulationMode)) accumulationMode = o.accumulationMode as AccumulationMode;
		else warnings.push(`unknown accumulation mode "${String(o.accumulationMode)}"; using ${d.accumulationMode}`);
	}
	return {
		mode,
		keepDry: sanitizeExclusions(o.keepDry, warnings, 'keep-dry period'),
		missing: sanitizeExclusions(o.missing, warnings, 'missing-rain period'),
		accumulationMode,
		keepReadings: sanitizeExclusions(o.keepReadings, warnings, 'keep-reading period'),
		addAccumulations: sanitizeExclusions(o.addAccumulations, warnings, 'listed accumulation')
	};
}

/** A period whose catchment rain a run treated as missing. */
export interface ZeroRainPeriod {
	/** The period as flagged or listed (not clipped to the run). */
	start: string;
	end: string;
	/** 'flagged': a zero run the issue #2 check flags. 'listed': settings.zeroRainRuns.missing. */
	source: 'flagged' | 'listed';
	/** The listed reason; null for a flagged run. */
	reason: string | null;
	/** Run days in it whose catchment reading was set aside. A day in two periods counts in the first. */
	days: number;
	/** Catchment rain recorded on those days, mm (0 for a flagged run). */
	recordedMm: number;
	/** Rain used on those days instead (corrected CHIRPS, else forecast), mm. */
	filledMm: number;
	/** Of `days`, those with no CHIRPS or forecast value either: they run as 0 mm. */
	unfilledDays: number;
}

/** A flagged zero run a keep-dry period kept as recorded. */
export interface ZeroRainKeptDry {
	start: string;
	end: string;
	reason: string;
	/** Run days of flagged zero runs inside it. */
	days: number;
}

/** What the run did with suspect catchment rain (RunSummary.zeroRainInfill). */
export interface ZeroRainInfill {
	mode: ZeroRainMode;
	/** Periods that touch the run and set aside at least one reading, flagged first, then listed, each in date order. */
	periods: ZeroRainPeriod[];
	/** Keep-dry periods that kept at least one run day of a flagged zero run. */
	keptDry: ZeroRainKeptDry[];
	/** Run days of flagged zero runs left as recorded because the mode is 'asRecorded'. */
	asRecordedDays: number;
	/** Totals over `periods`. */
	days: number;
	recordedMm: number;
	filledMm: number;
	unfilledDays: number;
}

export interface ZeroRainMask {
	/** 1 on run days whose catchment reading is set aside. */
	mask: Uint8Array;
	/** Index into infill.periods of the period that set each day aside; -1 elsewhere. */
	owner: Int32Array;
	infill: ZeroRainInfill;
}

/**
 * Which run days' catchment rain to treat as missing. Flagged zero runs come
 * from the whole stored record, as the data checks see them. null without a
 * catchment rain series. filledMm / unfilledDays stay 0 until
 * finishZeroRainInfill has the rain used. A day `claimed(day)` says is an
 * accumulation window's (engine ≥ 0.20.0, ./accumulation.ts) is not set aside
 * as part of a flagged run: the window's own total covers it. A day
 * `replaced(day)` says is in a rain-source period (engine ≥ 0.30.0,
 * ./rainSourcePeriods.ts) is set aside by neither a flagged run nor a listed
 * missing period: the period's own series gives its rain. `checks` is
 * settings.dataQuality and the CHIRPS series (engine ≥ 1.20.0), which decide
 * which zero runs are flagged (quality.ts zeroRainRuns).
 */
export function zeroRainMask(
	catchment: DailySeries | undefined,
	zr: ZeroRainSettings,
	start: number,
	days: number,
	claimed: (day: number) => boolean = () => false,
	replaced: (day: number) => boolean = () => false,
	checks: ZeroRunOptions = {}
): ZeroRainMask | null {
	if (!catchment) return null;
	const c0 = toEpochDay(catchment.startDate);
	const reading = (day: number) => {
		const v = catchment.values[day - c0];
		return v != null && Number.isFinite(v);
	};
	const mask = new Uint8Array(days);
	const owner = new Int32Array(days).fill(-1);
	const periods: ZeroRainPeriod[] = [];
	const keepDry = exclusionRanges(zr.keepDry);
	const keptDry: ZeroRainKeptDry[] = keepDry.map((r) => ({ ...r, days: 0 }));
	let asRecordedDays = 0;
	const inRun = (a: number, b: number): [number, number] | null => {
		const from = Math.max(a, start);
		const to = Math.min(b, start + days - 1);
		return from <= to ? [from, to] : null;
	};
	const claim = (period: ZeroRainPeriod, from: number, to: number, skip: (day: number) => boolean) => {
		const i = periods.length;
		for (let day = from; day <= to; day++) {
			const t = day - start;
			if (mask[t] || !reading(day) || replaced(day) || skip(day)) continue;
			mask[t] = 1;
			owner[t] = i;
			period.days++;
			period.recordedMm += Math.max(0, catchment.values[day - c0]!);
		}
		if (period.days > 0) periods.push(period);
	};

	for (const run of zeroRainRuns(catchment, checks).runs) {
		const span = inRun(toEpochDay(run.startDate), toEpochDay(run.endDate));
		if (!span) continue;
		if (zr.mode === 'asRecorded') {
			for (let day = span[0]; day <= span[1]; day++) if (!claimed(day) && !replaced(day)) asRecordedDays++;
			continue;
		}
		const keptBy = (day: number) => {
			if (claimed(day)) return true;
			const k = keepDry.findIndex((r) => day >= toEpochDay(r.start) && day <= toEpochDay(r.end));
			if (k >= 0) keptDry[k]!.days++;
			return k >= 0;
		};
		const period: ZeroRainPeriod = { start: run.startDate, end: run.endDate, source: 'flagged', reason: null, days: 0, recordedMm: 0, filledMm: 0, unfilledDays: 0 };
		claim(period, span[0], span[1], keptBy);
	}
	for (const r of exclusionRanges(zr.missing).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
		const span = inRun(toEpochDay(r.start), toEpochDay(r.end));
		if (!span) continue;
		const period: ZeroRainPeriod = { start: r.start, end: r.end, source: 'listed', reason: r.reason, days: 0, recordedMm: 0, filledMm: 0, unfilledDays: 0 };
		claim(period, span[0], span[1], () => false);
	}
	const sum = (k: 'days' | 'recordedMm') => periods.reduce((a, p) => a + p[k], 0);
	return {
		mask,
		owner,
		infill: {
			mode: zr.mode,
			periods,
			keptDry: keptDry.filter((k) => k.days > 0),
			asRecordedDays,
			days: sum('days'),
			recordedMm: sum('recordedMm'),
			filledMm: 0,
			unfilledDays: 0
		}
	};
}

/** Fill in what stood in on the set-aside days: `fallback[t]` is the rain used there (corrected CHIRPS ?? forecast), null for none. */
export function finishZeroRainInfill(m: ZeroRainMask, fallback: (t: number) => number | null): void {
	for (let t = 0; t < m.mask.length; t++) {
		if (!m.mask[t]) continue;
		const p = m.infill.periods[m.owner[t]!]!;
		const v = fallback(t);
		if (v == null || !Number.isFinite(v)) {
			p.unfilledDays++;
			m.infill.unfilledDays++;
		} else {
			p.filledMm += Math.max(0, v);
			m.infill.filledMm += Math.max(0, v);
		}
	}
}

/** The catchment rain aligned to the run with the set-aside days blanked. */
export function blankMasked(catchment: readonly (number | null)[], m: ZeroRainMask | null): (number | null)[] {
	if (!m) return catchment.slice();
	return catchment.map((v, t) => (m.mask[t] ? null : v));
}

const mm = (x: number) => `${Math.round(x)} mm`;
const periodLabel = (p: ZeroRainPeriod) =>
	`${p.start} to ${p.end} (${p.days} days, ${p.source === 'flagged' ? 'flagged zero run' : `listed: ${p.reason}`})`;

/** The run warnings for zeroRainInfill: what was set aside and filled, and what was kept dry. */
export function zeroRainWarnings(z: ZeroRainInfill | null): string[] {
	if (!z) return [];
	const out: string[] = [];
	if (z.days > 0) {
		const listed = z.periods.map(periodLabel);
		const shown = listed.length > 12 ? `${listed.slice(0, 12).join('; ')}; and ${listed.length - 12} more` : listed.join('; ');
		out.push(
			`Catchment rain treated as missing on ${z.days} days: ${shown}. ` +
				`CHIRPS (bias-corrected) then forecast rain stand in, ${mm(z.filledMm)} in all` +
				(z.recordedMm > 0 ? ` in place of ${mm(z.recordedMm)} recorded` : '') +
				'.' +
				(z.unfilledDays > 0 ? ` ${z.unfilledDays} of those days have no CHIRPS or forecast value either and run as 0 mm.` : '') +
				' The stored series is unchanged. Settings → Zero-rain runs keeps a flagged run as recorded.'
		);
	}
	if (z.keptDry.length) {
		out.push(
			`Flagged zero runs kept as recorded (dry) on ${z.keptDry.reduce((a, k) => a + k.days, 0)} days, as Settings → Zero-rain runs says: ` +
				z.keptDry.map((k) => `${k.start} to ${k.end} (${k.days} days: ${k.reason})`).join('; ') +
				'.'
		);
	}
	if (z.asRecordedDays > 0) {
		out.push(
			`Flagged zero runs run as recorded (dry) on ${z.asRecordedDays} days: Settings → Zero-rain runs is "as recorded", so CHIRPS doesn't fill them.`
		);
	}
	return out;
}

/** The per-day column: 1 where the catchment reading was set aside, 0 elsewhere. */
export const ZERO_RAIN_COLUMN = { key: 'rain_catchment_missing', label: 'Catchment rain treated as missing (1 = filled from CHIRPS, then forecast)', unit: '' } as const;
