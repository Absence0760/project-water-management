// A link that opens the Data tab's chart on one record and one period, hatched (a flagged period's View on
// Warnings): `?tab=series&series=<id>&view=<start>~<end>#data-chart`. The builder and its reader live together so
// the two can't drift.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Data tab's chart on a record, opened on a period (both days ISO, inclusive). */
export const viewPeriodHref = (seriesId: string, start: string, end: string): string =>
	`?tab=series&series=${encodeURIComponent(seriesId)}&view=${encodeURIComponent(`${start}~${end}`)}#data-chart`;

/** The period a `view` parameter names, or null when it names none (missing, malformed or backwards). */
export function viewPeriod(param: string | null): { start: string; end: string } | null {
	const [start, end, extra] = (param ?? '').split('~');
	if (extra !== undefined || !start || !end || !DAY.test(start) || !DAY.test(end) || end < start) return null;
	return Number.isFinite(Date.parse(`${start}T00:00:00Z`)) && Number.isFinite(Date.parse(`${end}T00:00:00Z`)) ? { start, end } : null;
}
