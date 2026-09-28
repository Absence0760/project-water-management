// The Runs rail's compact rows: a short period and the filter over labels.
// The full dates, author and engine live in the results header, so a row
// only needs enough to tell runs apart.
import { hasRole, type Role } from '$lib/api/types';

/** A run's period as years: "1979–2024", or "2021" when it starts and ends in one year. */
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

/**
 * The run the Runs tab opens on when the URL names none (docs/ui.md § Runs).
 * A viewer lands on the published baseline, the run stakeholders are meant
 * to read, when the list holds it; an editor (and a viewer with nothing
 * published) on the newest run, the one they are working on. Runs arrive
 * newest first. null with no runs.
 */
export function defaultRunId(runs: readonly { id: string; published?: boolean }[], role: Role | null | undefined): string | null {
	if (!hasRole(role, 'editor')) {
		const published = runs.find((r) => r.published);
		if (published) return published.id;
	}
	return runs[0]?.id ?? null;
}
