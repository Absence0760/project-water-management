// Daily A-pan evaporation (engine ≥ 0.38.0, issue #45, docs/model.md §2.3a).
//
// `settings.apanMm` holds 12 monthly means (WR90). A project may also hold a
// daily Class-A pan record from a nearby station, the `evap_apan_mm` series
// (mm/day). On every day that series has a usable value (a number ≥ 0) it
// replaces the monthly mean spread over the month, wherever the model reads
// A-pan: crop demand (§2.3), dam evaporation (§2.7a) and GR4J's potential
// evaporation under `pe.kind: 'pan'` (§2.4a). Every other day (no value, a
// negative value, or a day outside the record) falls back to the monthly
// mean exactly as a run without the series does, and the run says how many.
//
// Without the series nothing here runs: `apanDailyMm` returns null and each
// consumer keeps its original monthly expression, so a project without a
// daily record gets byte-identical results.
import { fromEpochDay } from '../calendar';
import type { DailySeries } from '../project';

/** The series kind of a daily A-pan record. */
export const APAN_DAILY_KIND = 'evap_apan_mm' as const;

/** How a run used the daily A-pan series (`RunSummary.apanDaily`). */
export interface ApanDailyInfo {
	/** Run days whose A-pan came from the daily series. */
	dailyDays: number;
	/** Run days that fell back to the monthly mean: no value, or a negative one. */
	fallbackDays: number;
	/** Of the fallback days, those with a value the run couldn't use (negative). */
	invalidDays: number;
	/** First and last run day the daily series supplied; null when it supplied none. */
	first: string | null;
	last: string | null;
}

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The daily A-pan (mm) on each run day, aligned to the run (`aligned('evap_apan_mm')`):
 * the value where it is a number ≥ 0, NaN where the day falls back to the
 * monthly mean. null when no day has a usable value, so callers keep their
 * monthly path untouched.
 */
export function apanDailyMm(aligned: readonly (number | null)[]): Float64Array | null {
	const out = new Float64Array(aligned.length);
	let any = false;
	for (let t = 0; t < aligned.length; t++) {
		const v = aligned[t];
		if (usable(v)) {
			out[t] = v;
			any = true;
		} else out[t] = NaN;
	}
	return any ? out : null;
}

/** Whether the aligned daily A-pan has a day above 0: enough, with a pan coefficient, for GR4J to have evaporation. */
export function hasDailyApanValue(aligned: readonly (number | null)[]): boolean {
	return aligned.some((v) => usable(v) && v > 0);
}

/**
 * Count what a run did with the daily A-pan series and say so: null (and no
 * warning) when the project has no such series. `monthlyAllZero`: the
 * monthly means the fallback days use are 0 in every month.
 */
export function apanDailyInfo(
	series: DailySeries | undefined,
	aligned: readonly (number | null)[],
	start: number,
	monthlyAllZero: boolean,
	warnings: string[]
): ApanDailyInfo | null {
	if (!series) return null;
	let dailyDays = 0;
	let invalidDays = 0;
	let first = -1;
	let last = -1;
	for (let t = 0; t < aligned.length; t++) {
		const v = aligned[t];
		if (usable(v)) {
			dailyDays++;
			if (first < 0) first = t;
			last = t;
		} else if (v !== null && v !== undefined) invalidDays++;
	}
	const days = aligned.length;
	const fallbackDays = days - dailyDays;
	const info: ApanDailyInfo = {
		dailyDays,
		fallbackDays,
		invalidDays,
		first: first < 0 ? null : fromEpochDay(start + first),
		last: last < 0 ? null : fromEpochDay(start + last)
	};
	const zero = monthlyAllZero
		? '. The monthly A-pan means are 0, so those days have no crop demand, no dam evaporation and (under pan-coefficient PE) no GR4J evaporation'
		: '';
	const negative = invalidDays ? `, ${invalidDays} of them with a negative value` : '';
	if (dailyDays === 0) {
		warnings.push(`the daily A-pan evaporation series has no value ≥ 0 inside the run, so every day uses the monthly A-pan means${negative}${zero}`);
	} else if (fallbackDays > 0) {
		warnings.push(
			`daily A-pan evaporation covers ${dailyDays} of ${days} run days (${info.first} to ${info.last}); the other ${fallbackDays} use the monthly A-pan mean spread over the month${negative}${zero}`
		);
	}
	return info;
}
