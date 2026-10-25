// The Runs rail's compact rows: a short period and the filter over labels.
// The full dates, author and engine live in the results header, so a row
// only needs enough to tell runs apart.
import { ApiError } from '#lib/api/client.js';
import { hasRole, type Role } from '#lib/api/types.js';
import { distinctShortNames } from '#lib/components/network/schematic.js';

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

/** True for the API's answer about a run it no longer has (404: deleted, or trimmed by the storage cap). */
export const isRunGone = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/** What the Runs tab says about a run that is no longer stored. */
export const RUN_GONE = 'This run no longer exists: it was deleted, or the storage cap removed it.';

/**
 * A failed run request in words: a run that's gone as RUN_GONE, never the
 * API's bare "not found" (issue #77); any other refusal (a kept run's 409)
 * is the server's own sentence, which says why.
 */
export function runErrorText(err: unknown): string {
	if (isRunGone(err)) return RUN_GONE;
	return err instanceof Error ? err.message : String(err);
}

/** About two lines of a row's label in the 250 px rail (it clamps at two lines; #586 D7). */
export const ROW_LABEL_CHARS = 44;

/**
 * Each row's label as the rail shows it: null where the label shows whole (two lines at most, clamped), or a
 * shortened form where clamping would make it read like another row's ("Dam raise on the upper tributary with the
 * 20…" six times): those keep the ending that tells them apart ("Dam raise on the upper tributary… 7"), as the
 * schematic's distinctShortNames does for unit names (ui-playbook § 3, distinct names). The same label twice stays
 * the same.
 */
export function rowLabels(labels: readonly string[], max = ROW_LABEL_CHARS): (string | null)[] {
	const plain = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
	return distinctShortNames(labels, max).map((short, i) => (short === plain(labels[i]!) ? null : short));
}
