// Daily reference evapotranspiration for GR4J (engine ≥ 1.103.0, issue #604
// R5-E, docs/model.md §2.4a "Daily reference ET").
//
// Under `pe.kind: 'monthly'` GR4J's potential evaporation is the monthly PE
// row spread over the month's days (a climatology such as dPET's 1991–2020
// means, maps.md § Evaporation from the map). A project may also hold a daily
// FAO-56 reference ET record, the `evap_et0_mm` series (mm/day): an AgERA5
// data feed, NASA POWER's computed ET₀ on the days AgERA5 doesn't have yet,
// or a station's own record uploaded on the Data tab. On every day that
// series has a usable value (a number ≥ 0) GR4J's PE is that day's ET₀ **as
// it stands**, factor 1, the same convention as a reference-ET monthly row
// from the map; every other day (no value, a negative one, or a day outside
// the record) falls back to the monthly row exactly as a run without the
// series, and the run says how many.
//
// Only GR4J reads it, and only under `pe.kind: 'monthly'`: reference ET is
// never multiplied by a pan coefficient and never stands in for A-pan, so
// under `pe.kind: 'pan'` the series is not read (a run warning says so), and
// crop demand and dam evaporation never read it under either kind.
//
// Without the series nothing here runs: `et0DailyMm` returns null and the
// forcing keeps its monthly expression, so a project without a daily
// reference ET record gets byte-identical results.
import { dayText, fromEpochDay, toEpochDay } from '../calendar';
import type { DailySeries, PeInput } from '../project';

/** The series kind of a daily reference ET record. */
export const ET0_DAILY_KIND = 'evap_et0_mm' as const;

/**
 * The part of a daily reference ET series a fit's provenance fingerprints
 * (issue #604 R5-E): its days through `through`, the last day the fit
 * scored. A feed appends a day most days and re-reads its newest weeks, so a
 * fingerprint of the whole series would flag every fit as "forcing changed"
 * the day after it was made; days after the fit's end never reached it. null
 * when nothing of the series falls on or before `through`.
 */
export function et0FitWindow(series: Pick<DailySeries, 'startDate' | 'values'>, through: string): { startDate: string; values: (number | null)[] } | null {
	const n = Math.min(series.values.length, toEpochDay(through) - toEpochDay(series.startDate) + 1);
	return n > 0 ? { startDate: series.startDate, values: series.values.slice(0, n) } : null;
}

/** How a run used the daily reference ET series (`RunSummary.et0Daily`). */
export interface Et0DailyInfo {
	/** Whether GR4J read the series: only under `pe.kind: 'monthly'`. */
	used: boolean;
	/** Run days whose PE came from the daily series (0 when not used). */
	dailyDays: number;
	/** Run days that fell back to the monthly PE row: no value, or a negative one (all the days when not used). */
	fallbackDays: number;
	/** Of the fallback days, those with a value the run couldn't use (negative). */
	invalidDays: number;
	/** First and last run day the series supplied; null when it supplied none (or wasn't used). */
	first: string | null;
	last: string | null;
}

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Whether GR4J reads a daily reference ET series under these PE settings: only a monthly PE row takes it. */
export const readsEt0Daily = (pe: PeInput | null | undefined): boolean => pe?.kind === 'monthly';

/**
 * The daily ET₀ (mm) on each run day, aligned to the run (`aligned('evap_et0_mm')`):
 * the value where it is a number ≥ 0, NaN where the day falls back to the
 * monthly row. null when no day has a usable value, so callers keep their
 * monthly path untouched.
 */
export function et0DailyMm(aligned: readonly (number | null)[]): Float64Array | null {
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

/** Whether the aligned daily ET₀ has a day above 0: enough, under a monthly PE row, for GR4J to have evaporation. */
export function hasDailyEt0Value(aligned: readonly (number | null)[]): boolean {
	return aligned.some((v) => usable(v) && v > 0);
}

/**
 * Count what a run did with the daily reference ET series and say so: null
 * (and no warning) when the project has no such series. `pe`: the run's PE
 * input; `monthlyAllZero`: the monthly PE row is 0 in every month.
 */
export function et0DailyInfo(
	series: DailySeries | undefined,
	aligned: readonly (number | null)[],
	start: number,
	pe: PeInput | null | undefined,
	monthlyAllZero: boolean,
	warnings: string[]
): Et0DailyInfo | null {
	if (!series) return null;
	const days = aligned.length;
	if (!readsEt0Daily(pe)) {
		warnings.push(
			'the daily reference evapotranspiration series is not read: GR4J’s potential evaporation is pan coefficient × A-pan, and reference ET is never multiplied by a pan coefficient. Choose a monthly PE row (Calibration → Flow calibration) to run GR4J on it'
		);
		return { used: false, dailyDays: 0, fallbackDays: days, invalidDays: 0, first: null, last: null };
	}
	let dailyDays = 0;
	let invalidDays = 0;
	let first = -1;
	let last = -1;
	for (let t = 0; t < days; t++) {
		const v = aligned[t];
		if (usable(v)) {
			dailyDays++;
			if (first < 0) first = t;
			last = t;
		} else if (v !== null && v !== undefined) invalidDays++;
	}
	const fallbackDays = days - dailyDays;
	const info: Et0DailyInfo = {
		used: true,
		dailyDays,
		fallbackDays,
		invalidDays,
		first: first < 0 ? null : fromEpochDay(start + first),
		last: last < 0 ? null : fromEpochDay(start + last)
	};
	const zero = monthlyAllZero ? '. The monthly PE row is 0, so those days have no GR4J evaporation' : '';
	const negative = invalidDays ? `, ${invalidDays} of them with a negative value` : '';
	if (dailyDays === 0) {
		warnings.push(`the daily reference evapotranspiration series has no value ≥ 0 inside the run, so every day uses the monthly PE row${negative}${zero}`);
	} else if (fallbackDays > 0) {
		warnings.push(
			`daily reference evapotranspiration covers ${dailyDays} of ${days} run days (${dayText(info.first!)} to ${dayText(info.last!)}); the other ${fallbackDays} use the monthly PE row spread over the month${negative}${zero}`
		);
	}
	return info;
}
