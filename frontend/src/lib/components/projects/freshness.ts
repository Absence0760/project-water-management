// How current a project's input data is, for the project list's badge.
// `dataUntil` is a calendar date (the last day any series covers); "today" is
// the viewer's local calendar date, so the age doesn't jump at UTC midnight.

/** Older than this many days counts as stale (warning style). */
export const STALE_AFTER_DAYS = 7;

/** Whole calendar days from `isoDate` (YYYY-MM-DD) to today's local date; negative if it's in the future. */
export function daysSince(isoDate: string, now: Date = new Date()): number {
	const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
	const then = Date.UTC(y, m - 1, d);
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((today - then) / 86_400_000);
}

export interface Freshness {
	/** Short badge text, e.g. "data 12 days old". */
	label: string;
	/** Tooltip / accessible detail, e.g. "Input data runs to 2026-09-11". */
	detail: string;
	stale: boolean;
}

export function dataFreshness(dataUntil: string | null, now: Date = new Date()): Freshness {
	if (!dataUntil) return { label: 'no data yet', detail: 'No rainfall or flow series uploaded yet', stale: true };
	const days = daysSince(dataUntil, now);
	const detail = `Input data runs to ${dataUntil}`;
	if (days <= 0) return { label: 'data up to date', detail, stale: false };
	return { label: `data ${age(days)} old`, detail, stale: days > STALE_AFTER_DAYS };
}

function age(days: number): string {
	if (days < 60) return days === 1 ? '1 day' : `${days} days`;
	const months = Math.floor(days / 30.44);
	if (months < 24) return `${months} months`;
	return `${Math.floor(days / 365.25)} years`;
}
