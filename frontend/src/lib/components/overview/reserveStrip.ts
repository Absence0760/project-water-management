// Summary → the reserve strip (issue #162, item 10): the days below the
// pragmatic EWR at the outlet in each of the run's last twelve months, from
// the run summary's monthly grid (RunSummary.ewrCompliance), so it needs no
// daily series. The full flow chart is River & reserve's; the strip links there.
import type { EwrCompliance } from '@water-management/engine';
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
			const notMet = c.outlet.daysNotMet[r]?.[m] ?? 0;
			out.push({ year, month, label: monthName(month), days, notMet, fraction: notMet / days });
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

/** One month in words, for screen readers and the tooltip: "Jan 2024: below the EWR on 12 of 31 days". */
export function monthText(x: StripMonth): string {
	return x.notMet === 0 ? `${x.label} ${x.year}: EWR met every day (${x.days} days)` : `${x.label} ${x.year}: below the EWR on ${x.notMet} of ${x.days} days`;
}
