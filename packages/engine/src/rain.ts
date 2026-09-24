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
// 0.17.0; before, every year a flagged run touched). Kept-dry days stay in,
// unless CHIRPS contradicts them (the keep-dry guard, chirpsBiasFactors).
// A month with too small a sample takes the factor pooled over all
// months; without even that, CHIRPS stays raw and the run warns. Factors are
// clamped to CHIRPS_FACTOR_MIN … CHIRPS_FACTOR_MAX.
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
import { monthOfEpochDay, toEpochDay } from './calendar';
import { exclusionRanges, sanitizeExclusions, type ExclusionRange } from './calibrate/provenance';
import { waterYearOf } from './network/stats';
import { defaultZeroRainSettings, ZERO_RAIN_MODES, type ChirpsBiasMode, type DailySeries, type SeriesKind, type ZeroRainMode, type ZeroRainSettings } from './project';
import { rainVsChirps, usualAnnualRainMm, waterYearLabel, zeroRainRuns } from './quality';

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
	/** The factor for this month (own or pooled, clamped); null when neither is available. */
	factor: number | null;
	source: 'month' | 'pooled' | null;
	/** The factor was clamped to CHIRPS_FACTOR_MIN … CHIRPS_FACTOR_MAX. */
	clamped: boolean;
	/** Run days in this month where CHIRPS stood in for catchment rain. */
	fallbackDays: number;
}

/** A kept-dry stretch the fit doubts: bias-corrected CHIRPS reads too much rain over it (engine ≥ 0.17.0). */
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

export interface ChirpsCorrection {
	mode: ChirpsBiasMode;
	minDays: number;
	minMm: number;
	clampMin: number;
	clampMax: number;
	/** All months together: the factor a thin month falls back to. */
	pooled: { days: number; catchmentMm: number; chirpsMm: number; ownFactor: number | null; factor: number | null; clamped: boolean };
	/**
	 * Water years left out of the fit whole. From engine 0.17.0: the
	 * low-vs-CHIRPS years and the years of a doubted keep-dry. Before 0.17.0
	 * also every year a flagged zero run touched, kept dry or not.
	 */
	excludedWaterYears: number[];
	/** Of those, the years the low-vs-CHIRPS check flags (engine ≥ 0.17.0; absent before). */
	lowVsChirpsYears?: number[];
	/** Kept-dry stretches CHIRPS contradicts; their years are in excludedWaterYears (engine ≥ 0.17.0). */
	doubtfulKeepDry?: ChirpsKeepDryDoubt[];
	/**
	 * Days left out of the fit one by one, outside the excluded years, where
	 * both series have a reading (engine ≥ 0.17.0): days of flagged zero runs
	 * not kept dry, and days of periods listed as missing.
	 */
	flaggedDaysLeftOut?: number;
	missingDaysLeftOut?: number;
	/** Days of flagged zero runs kept dry that stay in the fit as confirmed readings (engine ≥ 0.17.0). */
	keptDryDaysInFit?: number;
	/** Calendar months 1–12, in order. */
	months: ChirpsMonthFactor[];
	/** Run days where CHIRPS stood in for blank catchment rain. */
	fallbackDays: number;
	/** Of those, the days a factor was applied to (0 when mode is 'none'). */
	correctedDays: number;
	/** CHIRPS rain on the fallback days, before and after correction, mm (negatives count as 0). */
	fallbackRawMm: number;
	fallbackCorrectedMm: number;
}

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;
const clamp = (f: number) => Math.min(CHIRPS_FACTOR_MAX, Math.max(CHIRPS_FACTOR_MIN, f));
const enough = (days: number, chirpsMm: number) => days >= CHIRPS_FACTOR_MIN_DAYS && chirpsMm >= CHIRPS_FACTOR_MIN_MM && chirpsMm > 0;

/**
 * Keep-dry guard (engine ≥ 0.17.0). A kept-dry stretch of a flagged zero run
 * is doubted, and its water years stay out of the fit, when bias-corrected
 * CHIRPS over its kept days is above the larger of KEEP_DRY_DOUBT_MIN_MM and
 * KEEP_DRY_DOUBT_ANNUAL_SHARE × the catchment's usual annual rain
 * (docs/model.md §2.4b says why).
 */
export const KEEP_DRY_DOUBT_MIN_MM = 50;
export const KEEP_DRY_DOUBT_ANNUAL_SHARE = 0.25;

/** How a catchment-rain day counts as suspect: listed missing, a flagged zero run, or a flagged run kept dry. */
export type SuspectRainDay = 'missing' | 'flagged' | 'keptDry';

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
 * confirmed reading.
 */
export function suspectRainDays(catchment: DailySeries | undefined, zr: ZeroRainSettings): SuspectRainDays {
	const runs = catchment
		? zeroRainRuns(catchment).runs.map((r) => ({ start: r.startDate, end: r.endDate, from: toEpochDay(r.startDate), to: toEpochDay(r.endDate) }))
		: [];
	const span = (r: ExclusionRange) => [toEpochDay(r.start), toEpochDay(r.end)] as const;
	const missing = exclusionRanges(zr.missing).map(span);
	const keep = zr.mode === 'missing' ? exclusionRanges(zr.keepDry).map(span) : [];
	const within = (xs: (readonly [number, number])[], day: number) => xs.some(([a, b]) => day >= a && day <= b);
	return {
		runs,
		status: (day) => {
			if (within(missing, day)) return 'missing';
			if (!runs.some((r) => day >= r.from && day <= r.to)) return null;
			return within(keep, day) ? 'keptDry' : 'flagged';
		}
	};
}

type MonthSums = { days: number[]; cMm: number[]; hMm: number[] };

/** Per-month factors from the month sums: own where the sample is big enough, else pooled; clamped. */
function factorsFrom(t: MonthSums): { pooled: ChirpsCorrection['pooled']; months: ChirpsMonthFactor[] } {
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
		months.push({
			month: m,
			days: t.days[m]!,
			catchmentMm: t.cMm[m]!,
			chirpsMm: t.hMm[m]!,
			ownFactor: own,
			factor: raw === null ? null : clamp(raw),
			source: own !== null ? 'month' : raw !== null ? 'pooled' : null,
			clamped: raw !== null && clamp(raw) !== raw,
			fallbackDays: 0
		});
	}
	return { pooled, months };
}

/**
 * The per-month factors from the whole stored record (not only the run
 * window, so a shorter simulation period doesn't change them). null when the
 * project has no CHIRPS series. The run counts (fallbackDays, …) are 0 here;
 * applyChirpsCorrection fills them.
 *
 * What is left out (engine ≥ 0.17.0, docs/model.md §2.4b): low-vs-CHIRPS
 * water years, whole; the days of periods listed as missing and of flagged
 * zero runs not kept dry, one by one (suspectRainDays); and the water years
 * of a kept-dry stretch that bias-corrected CHIRPS contradicts (the keep-dry
 * guard). Other kept-dry days stay in: they are confirmed readings. The guard
 * judges a stretch with factors fitted without any flagged-run day, so the
 * verdict doesn't lean on the keep-dry it is judging.
 */
export function chirpsBiasFactors(
	series: Partial<Record<SeriesKind, DailySeries>>,
	mode: ChirpsBiasMode,
	zeroRain: ZeroRainSettings = defaultZeroRainSettings()
): ChirpsCorrection | null {
	const sb = series.rain_chirps_mm;
	if (!sb) return null;
	const sa = series.rain_catchment_mm;
	const lowYears = sa ? (rainVsChirps(series)?.flaggedYears ?? []) : [];
	const suspect = suspectRainDays(sa, zeroRain);
	const b0 = toEpochDay(sb.startDate);

	// Shared days (both a reading) outside the low-vs-CHIRPS years, with their status.
	const shared: { day: number; c: number; h: number; status: SuspectRainDay | null }[] = [];
	if (sa) {
		const low = new Set(lowYears);
		const a0 = toEpochDay(sa.startDate);
		const from = Math.max(a0, b0);
		const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
		for (let day = from; day < to; day++) {
			const va = sa.values[day - a0];
			const vb = sb.values[day - b0];
			if (!isReading(va) || !isReading(vb) || low.has(waterYearOf(day))) continue;
			shared.push({ day, c: va, h: vb, status: suspect.status(day) });
		}
	}
	const sums = (include: (d: (typeof shared)[number]) => boolean): MonthSums => {
		const t: MonthSums = { days: new Array<number>(13).fill(0), cMm: new Array<number>(13).fill(0), hMm: new Array<number>(13).fill(0) };
		for (const d of shared) {
			if (!include(d)) continue;
			const m = monthOfEpochDay(d.day);
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
	let flaggedDaysLeftOut = 0;
	let missingDaysLeftOut = 0;
	let keptDryDaysInFit = 0;
	const fit = factorsFrom(
		sums((d) => {
			if (doubtYears.has(waterYearOf(d.day))) return false;
			if (d.status === 'missing') missingDaysLeftOut++;
			else if (d.status === 'flagged') flaggedDaysLeftOut++;
			else if (d.status === 'keptDry') keptDryDaysInFit++;
			return d.status === null || d.status === 'keptDry';
		})
	);
	return {
		mode,
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
		months: fit.months,
		fallbackDays: 0,
		correctedDays: 0,
		fallbackRawMm: 0,
		fallbackCorrectedMm: 0
	};
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
	month: Uint8Array
): (number | null)[] {
	const out = chirps.slice();
	for (let t = 0; t < chirps.length; t++) {
		const v = chirps[t];
		if (catchment[t] != null || v == null) continue;
		const mf = corr.months[month[t]! - 1]!;
		mf.fallbackDays++;
		corr.fallbackDays++;
		corr.fallbackRawMm += Math.max(0, v);
		if (corr.mode === 'monthly' && mf.factor !== null) {
			out[t] = v * mf.factor;
			corr.correctedDays++;
		}
		corr.fallbackCorrectedMm += Math.max(0, out[t]!);
	}
	return out;
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
	if (c.missingDaysLeftOut) parts.push(`${plural(c.missingDaysLeftOut, 'day')} listed as missing`);
	const kept = c.keptDryDaysInFit ? ` ${plural(c.keptDryDaysInFit, 'kept-dry day')} stay in the fit as confirmed readings.` : '';
	return (parts.length ? ` Left out of the fit as suspect catchment rain: ${parts.join('; ')}.` : '') + kept;
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
	const parts = WY_MONTHS.map((m) => c.months[m - 1]!)
		.filter((mf) => mf.factor !== null)
		.map((mf) => `${MONTH_ABBR[mf.month]} ${f(mf.factor!)}${mf.source === 'pooled' ? ' (pooled)' : ''}${mf.clamped ? ' (clamped)' : ''}`);
	return (
		`CHIRPS rain bias-corrected on ${c.correctedDays} days where catchment rain is blank ` +
		`(${Math.round(c.fallbackRawMm)} mm raw → ${Math.round(c.fallbackCorrectedMm)} mm): ` +
		`factor = catchment / CHIRPS rain per month, ${parts.join(', ')}. ` +
		`A month with fewer than ${c.minDays} shared days, or less than ${c.minMm} mm of CHIRPS on them, uses the pooled factor; factors are clamped to ${c.clampMin}–${c.clampMax}.` +
		`${excluded} Catchment and forecast rain are not changed. Settings → CHIRPS bias correction turns this off.`
	);
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
	return {
		mode,
		keepDry: sanitizeExclusions(o.keepDry, warnings, 'keep-dry period'),
		missing: sanitizeExclusions(o.missing, warnings, 'missing-rain period')
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
 * finishZeroRainInfill has the rain used.
 */
export function zeroRainMask(catchment: DailySeries | undefined, zr: ZeroRainSettings, start: number, days: number): ZeroRainMask | null {
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
			if (mask[t] || !reading(day) || skip(day)) continue;
			mask[t] = 1;
			owner[t] = i;
			period.days++;
			period.recordedMm += Math.max(0, catchment.values[day - c0]!);
		}
		if (period.days > 0) periods.push(period);
	};

	for (const run of zeroRainRuns(catchment).runs) {
		const span = inRun(toEpochDay(run.startDate), toEpochDay(run.endDate));
		if (!span) continue;
		if (zr.mode === 'asRecorded') {
			asRecordedDays += span[1] - span[0] + 1;
			continue;
		}
		const keptBy = (day: number) => {
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
