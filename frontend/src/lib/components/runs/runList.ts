// The Runs rail's compact rows: a short period and the filter over labels.
// The full dates, author and engine live in the results header, so a row
// only needs enough to tell runs apart.

/** A run's period as years: "1981–2025", or "2021" when it starts and ends in one year. */
export function runYears(startDate: string, endDate: string): string {
	const a = startDate.slice(0, 4);
	const b = endDate.slice(0, 4);
	return a === b ? a : `${a}–${b}`;
}

/** The list shows a filter box from this many runs up. */
export const RUN_FILTER_FROM = 7;

/**
 * Runs whose label (or "Untitled run") contains every word of the query, any
 * case; a blank query keeps them all. Order is kept.
 */
export function filterRuns<R extends { label: string | null }>(runs: readonly R[], query: string): R[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...runs];
	return runs.filter((r) => {
		const label = (r.label || 'Untitled run').toLowerCase();
		return words.every((w) => label.includes(w));
	});
}
