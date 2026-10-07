// Summary → the reserve strip (issue #162, item 10): the days below the
// pragmatic EWR at the outlet in each of the run's last twelve months, from
// the run summary's monthly grid (RunSummary.ewrCompliance), so it needs no
// daily series. The full flow chart is River & reserve's; the strip links there.
//
// It always counts the pragmatic EWR, the one daily test every run has. With a
// Reserve rule table the headline card beside it judges the Reserve by the
// table instead (whole months at a site, latestRun.ts headlines), so there the
// strip is named for what it counts, not "the reserve" (issue #177): the rule
// table gives a verdict per month, not a count of days, so it can't be drawn
// as days below.
import { ewrBand, type EwrBand, type EwrCompliance } from '@water-management/engine';
import { EWR_NOT_MET, daysBelowTest } from '$lib/components/ewr/notMet';
import { WATER_YEAR_CALENDAR, monthName } from '$lib/format/months';

export interface StripMonth {
	/** Calendar year and month (1–12). */
	year: number;
	month: number;
	/** "Jan". */
	label: string;
	/** Days of the month in the run, and those below the EWR. */
	days: number;
	notMet: number;
	/** notMet / days, 0–1. */
	fraction: number;
	/** The EWR traffic light's band for the month (the portfolio's, engine reserve/trafficLight.ts), its bar's colour. */
	band: EwrBand;
}

/** The months the strip shows. */
export const STRIP_MONTHS = 12;

/**
 * The run's last `n` months with simulated days, oldest first. On a forecast
 * run only the months before the one its forecast starts in, since the
 * Summary's figures are the history's (latestRun.ts historyDays); a month
 * the forecast starts part way through is left out rather than mixed.
 */
export function recentMonths(c: EwrCompliance, forecastFrom: string | null = null, n = STRIP_MONTHS): StripMonth[] {
	const cut = forecastFrom ? Number(forecastFrom.slice(0, 4)) * 12 + Number(forecastFrom.slice(5, 7)) - 1 : Infinity;
	const out: StripMonth[] = [];
	c.waterYears.forEach((wy, r) => {
		WATER_YEAR_CALENDAR.forEach((month, m) => {
			const days = c.days[r]?.[m] ?? 0;
			if (days <= 0) return;
			// Oct–Dec belong to the calendar year the water year starts in.
			const year = month >= 10 ? wy : wy + 1;
			if (year * 12 + month - 1 >= cut) return;
			// days > 0 here, and the engine counts the days not met within the month's, so the band is never null.
			const notMet = c.outlet.daysNotMet[r]?.[m] ?? 0;
			out.push({ year, month, label: monthName(month), days, notMet, fraction: notMet / days, band: ewrBand(notMet, days)! });
		});
	});
	return out.slice(-n);
}

/** "Jan 2024 – Dec 2024", the span the strip covers; '' when it is empty. */
export function stripSpan(ms: readonly StripMonth[]): string {
	if (!ms.length) return '';
	const at = (x: StripMonth) => `${x.label} ${x.year}`;
	return ms.length === 1 ? at(ms[0]!) : `${at(ms[0]!)} – ${at(ms[ms.length - 1]!)}`;
}

/** The strip's heading, its list's name and its line under the heading. */
export interface StripWords {
	heading: string;
	/** The month list's accessible name, before its span. */
	list: string;
	/** What it counts, before "the run's last N months: span". */
	what: string;
	/** After the span: how it differs from the headline card's test ('' when it doesn't). */
	note: string;
	/** The test in a month's words: "the EWR", or "the pragmatic EWR" beside a rule table. */
	test: string;
}

/**
 * The strip's words. `ruleTable`: the headline card judges the Reserve by a
 * rule table (ewrAssurance.ts headlineSite), so "the reserve" would name a
 * different test from the one the strip counts.
 */
export function stripWords(ruleTable: boolean): StripWords {
	const what = `Days each month the outflow was below the pragmatic EWR (${EWR_NOT_MET})`;
	const heading = `Days below ${daysBelowTest(ruleTable)}`;
	const list = `${heading} by month`;
	return ruleTable
		? { heading, list, what, note: 'The Reserve rules card above judges whole months by the rule table instead.', test: 'the pragmatic EWR' }
		: { heading, list, what, note: '', test: 'the EWR' };
}

/** The line under the heading: what it counts and the span. */
export function stripWhat(ms: readonly StripMonth[], words: StripWords): string {
	const line = `${words.what}, the run’s last ${ms.length === 1 ? 'month' : `${ms.length} months`}: ${stripSpan(ms)}`;
	return words.note ? `${line}. ${words.note}` : line;
}

/** One month in words, for screen readers and the tooltip: "Jan 2024: below the EWR on 12 of 31 days (red)". */
export function monthText(x: StripMonth, test = 'the EWR'): string {
	const name = test.replace(/^the /, '');
	return x.notMet === 0 ? `${x.label} ${x.year}: ${name} met every day (${x.days} days)` : `${x.label} ${x.year}: below ${test} on ${x.notMet} of ${x.days} days (${x.band})`;
}
