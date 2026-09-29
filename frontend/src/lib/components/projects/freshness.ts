// How current a project's input data is, for the project list's badge.
// `dataUntil` is a calendar date (the last day of recorded rain, catchment or
// CHIRPS: a forecast or a flow series doesn't count); "today" is
// the viewer's local calendar date, so the age doesn't jump at UTC midnight.
// Worded by the one age formatter ($lib/format/age), as everywhere else.
import { dateAge, isStale } from '$lib/format/age';
import { fmtDay } from '$lib/format/number';

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

export function dataFreshness(dataUntil: string | null, now: Date = new Date()): Freshness {
	if (!dataUntil) return { label: 'No rain yet', detail: 'No recorded rainfall (catchment or CHIRPS) uploaded yet', stale: true };
	const days = daysSince(dataUntil, now);
	// A day ahead of the viewer's calendar (another zone's today) is still today.
	return {
		label: `Rain to ${dateAge(dataUntil, Math.max(0, days))}`,
		detail: `Recorded rain (catchment or CHIRPS) runs to ${fmtDay(dataUntil)}`,
		stale: isStale(days)
	};
}
