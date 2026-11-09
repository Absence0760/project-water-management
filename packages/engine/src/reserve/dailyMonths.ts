// The daily EWR at the outlet, judged month by month (engine ≥ 1.116.0;
// docs/model.md §2.9h). Pure: no I/O.
//
// The run's daily EWR at the outlet (`ewr`, settings.ewrDailySource: the
// pragmatic EWR, the DRM TAB file or the DRM percentile tables, §2.9f) is
// what every day is judged by. The Reserve's rule tables (§2.9c) judge whole
// months instead, and the EWR page's "months met" panel read only them; a
// client hydrologist asked for the same monthly reading of the daily EWR in
// use. Per complete calendar month of the run (the months §2.9c assesses:
// ./assurance.ts completeMonths, a month a forecast tail starts inside left
// out):
//   required R = Σ the month's daily EWR (m³),
//   simulated A = Σ the month's simulated outflow at the outlet (m³),
//   met when A ≥ R (relative tolerance 1e-9, as §2.9c).
// A month whose requirement is 0 is met (the river owed nothing, as a day
// with an EWR of 0 is never "not met" in the daily test, and a rule table's
// R = 0 month is met in §2.9c), and counted in `zeroRequirementMonths` so a
// screen can say how many of the months met asked for nothing.
//
// Invariant (tested): more flow on every day never loses a month, and a run
// whose outflow is the EWR itself meets every month.
import { waterYearIndex } from '../calendar';
import { completeMonths } from './assurance';

const SEC_PER_DAY = 86_400;
/** Relative float tolerance on "A ≥ R", as ./assurance.ts. */
const MET_TOLERANCE = 1e-9;

/** One complete month at the outlet (assessDailyEwrMonths' working row; not kept in the summary). */
interface EwrDailyMonth {
	/** Calendar year and month (1–12). */
	year: number;
	month: number;
	days: number;
	/** Σ the daily EWR, m³. */
	requiredM3: number;
	/** Σ the simulated outflow, m³. */
	simulatedM3: number;
	met: boolean;
}

/** One calendar month over the run (the list is in water-year order, Oct … Sep). */
export interface EwrDailyMonthOfYear {
	month: number;
	/** Complete months of this calendar month in the run. */
	years: number;
	met: number;
	/** met ÷ years; null when years = 0. */
	rate: number | null;
	/** Mean of the months' mean required flow, m³/s; null when years = 0. */
	meanRequiredM3s: number | null;
	/** Mean of the months' mean simulated flow, m³/s; null when years = 0. */
	meanSimulatedM3s: number | null;
	/** Σ MAX(R − A, 0) over the months, m³. */
	deficitM3: number;
}

/** The daily EWR at the outlet judged month by month (RunSummary.ewrDailyMonths). */
export interface EwrDailyMonths {
	/** Complete months assessed. */
	months: number;
	met: number;
	/** met ÷ months; null without a complete month. */
	rate: number | null;
	/** Of the months met, those whose requirement was 0. */
	zeroRequirementMonths: number;
	/** Most consecutive months not met. */
	longestNotMetRun: number;
	/** Σ MAX(R − A, 0) over every month, m³. */
	deficitM3: number;
	byMonth: EwrDailyMonthOfYear[];
}

const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : 0);
const isMet = (a: number, r: number) => a >= r - MET_TOLERANCE * Math.max(Math.abs(r), Math.abs(a));

/**
 * The run's daily EWR at the outlet (`ewr`, m³/day) against its simulated
 * outflow (m³/day), per complete calendar month. `historyDays`: the run's
 * historical days before a forecast tail (default every day); a month that
 * straddles the last of them isn't assessed, as in ./assurance.ts.
 */
export function assessDailyEwrMonths(
	startDate: string,
	days: number,
	ewr: ArrayLike<number>,
	simulated: ArrayLike<number>,
	historyDays: number = days
): EwrDailyMonths {
	const blocks = completeMonths(startDate, days).filter((b) => b.from + b.days <= historyDays || b.from >= historyDays);
	const list: EwrDailyMonth[] = blocks.map((b) => {
		let requiredM3 = 0;
		let simulatedM3 = 0;
		for (let t = b.from; t < b.from + b.days; t++) {
			requiredM3 += finite(ewr[t]);
			simulatedM3 += finite(simulated[t]);
		}
		return { year: b.year, month: b.month, days: b.days, requiredM3, simulatedM3, met: isMet(simulatedM3, requiredM3) };
	});
	const deficit = (m: EwrDailyMonth) => Math.max(0, m.requiredM3 - m.simulatedM3);
	const byW: EwrDailyMonth[][] = Array.from({ length: 12 }, () => []);
	for (const m of list) byW[waterYearIndex(m.month)]!.push(m);
	const byMonth = byW.map((ms, w): EwrDailyMonthOfYear => {
		const n = ms.length;
		const met = ms.filter((m) => m.met).length;
		const meanOf = (f: (m: EwrDailyMonth) => number) => (n ? ms.reduce((s, m) => s + f(m) / (m.days * SEC_PER_DAY), 0) / n : null);
		return {
			month: ((w + 9) % 12) + 1,
			years: n,
			met,
			rate: n ? met / n : null,
			meanRequiredM3s: meanOf((m) => m.requiredM3),
			meanSimulatedM3s: meanOf((m) => m.simulatedM3),
			deficitM3: ms.reduce((s, m) => s + deficit(m), 0)
		};
	});
	let longest = 0;
	let run = 0;
	for (const m of list) {
		run = m.met ? 0 : run + 1;
		longest = Math.max(longest, run);
	}
	const met = list.filter((m) => m.met).length;
	return {
		months: list.length,
		met,
		rate: list.length ? met / list.length : null,
		zeroRequirementMonths: list.filter((m) => m.met && m.requiredM3 === 0).length,
		longestNotMetRun: longest,
		deficitM3: list.reduce((s, m) => s + deficit(m), 0),
		byMonth
	};
}
