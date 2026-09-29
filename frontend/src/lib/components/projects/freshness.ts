// How current a project's input data is, for the project list's badge.
// `dataUntil` is a calendar date (the last day of recorded rain, catchment or
// CHIRPS: a forecast or a flow series doesn't count); "today" is the
// project's calendar date (its time zone, the API's `today`), the day the
// portfolio and the list's outcome columns count their ages to, so one row
// never reads two ages a day apart (issue #137). Worded by the one age
// formatter ($lib/format/age), as everywhere else.
import { dateAge, daysBetween, isStale } from '$lib/format/age';
import { fmtDay, localIsoDate, zonedIsoDate } from '$lib/format/number';

/**
 * A project's calendar date now (YYYY-MM-DD, in its time zone, 058): the day
 * the workspace header counts its data age to, as the list (the API's
 * `today`) and the portfolio do. Without a zone yet (the project still
 * loading), or one the browser doesn't know, the viewer's own date.
 */
export function projectToday(timeZone: string | null | undefined, now: Date = new Date()): string {
	if (timeZone) {
		try {
			return zonedIsoDate(now, timeZone);
		} catch {
			// An unknown zone: the viewer's date below.
		}
	}
	return localIsoDate(now);
}

/** Whole calendar days from `isoDate` (YYYY-MM-DD) to today's local date; negative if it's in the future. */
export function daysSince(isoDate: string, now: Date = new Date()): number {
	const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
	const then = Date.UTC(y, m - 1, d);
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((today - then) / 86_400_000);
}

export interface Freshness {
	/** Short badge text, e.g. "Rain to 11 Sep 2026 (12 days ago)". */
	label: string;
	/** Tooltip / accessible detail, e.g. "Recorded rain (catchment or CHIRPS) runs to 11 Sep 2026". */
	detail: string;
	stale: boolean;
}

/** `today`: the project's calendar date (YYYY-MM-DD, ProjectSummary.today). */
export function dataFreshness(dataUntil: string | null, today: string): Freshness {
	if (!dataUntil) return { label: 'No rain yet', detail: 'No recorded rainfall (catchment or CHIRPS) uploaded yet', stale: true };
	const days = daysBetween(dataUntil, today);
	// A day ahead of the project's calendar (a source dated in another zone) is still today.
	return {
		label: `Rain to ${dateAge(dataUntil, Math.max(0, days))}`,
		detail: `Recorded rain (catchment or CHIRPS) runs to ${fmtDay(dataUntil)}`,
		stale: isStale(days)
	};
}
