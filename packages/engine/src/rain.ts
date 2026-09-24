// Rain used: bias correction of the CHIRPS fallback (engine ≥ 0.6.0, audit B1).
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
// over the days of month m where both have a reading, leaving out water years
// the issue #2 checks flag as suspect catchment data (zero runs, low vs
// CHIRPS). A month with too small a sample takes the factor pooled over all
// months; without even that, CHIRPS stays raw and the run warns. Factors are
// clamped to CHIRPS_FACTOR_MIN … CHIRPS_FACTOR_MAX.
//
// Catchment rain is never changed, and neither is forecast rain (the third
// source): there is no overlap to fit a forecast factor from, and a forecast
// product's bias isn't CHIRPS's.
import { monthOfEpochDay, toEpochDay } from './calendar';
import { waterYearOf } from './network/stats';
import type { ChirpsBiasMode, DailySeries, SeriesKind } from './project';
import { rainVsChirps, waterYearLabel, zeroRainRuns } from './quality';

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

export interface ChirpsCorrection {
	mode: ChirpsBiasMode;
	minDays: number;
	minMm: number;
	clampMin: number;
	clampMax: number;
	/** All months together: the factor a thin month falls back to. */
	pooled: { days: number; catchmentMm: number; chirpsMm: number; ownFactor: number | null; factor: number | null; clamped: boolean };
	/** Water years left out of the fit: flagged by the issue #2 zero-run or low-vs-CHIRPS check. */
	excludedWaterYears: number[];
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

/** Water years the issue #2 checks flag: every year a flagged zero run touches, and every low-vs-CHIRPS year. */
export function suspectRainYears(series: Partial<Record<SeriesKind, DailySeries>>): number[] {
	const out = new Set<number>();
	const c = series.rain_catchment_mm;
	if (c) {
		for (const r of zeroRainRuns(c).runs) {
			const a = waterYearOf(toEpochDay(r.startDate));
			const b = waterYearOf(toEpochDay(r.endDate));
			for (let y = a; y <= b; y++) out.add(y);
		}
	}
	for (const y of rainVsChirps(series)?.flaggedYears ?? []) out.add(y);
	return [...out].sort((a, b) => a - b);
}

/**
 * The per-month factors from the whole stored record (not only the run
 * window, so a shorter simulation period doesn't change them). null when the
 * project has no CHIRPS series. The run counts (fallbackDays, …) are 0 here;
 * applyChirpsCorrection fills them.
 */
export function chirpsBiasFactors(series: Partial<Record<SeriesKind, DailySeries>>, mode: ChirpsBiasMode): ChirpsCorrection | null {
	const sb = series.rain_chirps_mm;
	if (!sb) return null;
	const sa = series.rain_catchment_mm;
	const excluded = sa ? suspectRainYears(series) : [];
	const skip = new Set(excluded);
	const days = new Array<number>(13).fill(0);
	const cMm = new Array<number>(13).fill(0);
	const hMm = new Array<number>(13).fill(0);
	if (sa) {
		const a0 = toEpochDay(sa.startDate);
		const b0 = toEpochDay(sb.startDate);
		const from = Math.max(a0, b0);
		const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
		for (let day = from; day < to; day++) {
			const va = sa.values[day - a0];
			const vb = sb.values[day - b0];
			if (!isReading(va) || !isReading(vb) || skip.has(waterYearOf(day))) continue;
			const m = monthOfEpochDay(day);
			days[m]!++;
			cMm[m] = cMm[m]! + va;
			hMm[m] = hMm[m]! + vb;
		}
	}
	const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
	const pd = sum(days);
	const pc = sum(cMm);
	const ph = sum(hMm);
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
		const own = enough(days[m]!, hMm[m]!) ? cMm[m]! / hMm[m]! : null;
		const raw = own ?? pooled.ownFactor;
		months.push({
			month: m,
			days: days[m]!,
			catchmentMm: cMm[m]!,
			chirpsMm: hMm[m]!,
			ownFactor: own,
			factor: raw === null ? null : clamp(raw),
			source: own !== null ? 'month' : raw !== null ? 'pooled' : null,
			clamped: raw !== null && clamp(raw) !== raw,
			fallbackDays: 0
		});
	}
	return {
		mode,
		minDays: CHIRPS_FACTOR_MIN_DAYS,
		minMm: CHIRPS_FACTOR_MIN_MM,
		clampMin: CHIRPS_FACTOR_MIN,
		clampMax: CHIRPS_FACTOR_MAX,
		pooled,
		excludedWaterYears: excluded,
		months,
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

/** The run warning for the correction, or null when CHIRPS was never the fallback (or the mode is 'none'). */
export function chirpsCorrectionWarning(c: ChirpsCorrection | null): string | null {
	if (!c || c.fallbackDays === 0 || c.mode === 'none') return null;
	const excluded = c.excludedWaterYears.length
		? ` Water years left out of the fit as suspect catchment rain (the zero-run and low-vs-CHIRPS checks): ${c.excludedWaterYears.map(waterYearLabel).join(', ')}.`
		: '';
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
