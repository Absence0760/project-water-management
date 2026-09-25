// URL state and default choices for the compare page's two run pickers.
// A run reference is "<projectId>:<runId>" — the same form GET /compare/runs takes.
import type { RunMeta } from '$lib/api/types';
import { runYears } from '$lib/components/runs/runList';

export interface RunRef {
	projectId: string;
	runId: string;
}

export function parseRef(s: string | null | undefined): RunRef | null {
	if (!s) return null;
	const parts = s.split(':');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { projectId: parts[0], runId: parts[1] };
}

export function formatRef(r: RunRef): string {
	return `${r.projectId}:${r.runId}`;
}

/**
 * Default pair when the page opens with only ?project=: A = the previous run,
 * B = the latest (runs arrive newest first, as GET /projects/:id/runs returns
 * them). null when there are fewer than two runs to compare.
 */
export function defaultPair(projectId: string, runs: readonly RunMeta[]): { a: RunRef; b: RunRef } | null {
	if (runs.length < 2) return null;
	return { a: { projectId, runId: runs[1]!.id }, b: { projectId, runId: runs[0]!.id } };
}

/**
 * Run to select when the user switches one side to another project: the newest
 * run that isn't the one already chosen on the other side (comparing a run
 * with itself tells you nothing), else the newest. null when the project has
 * no runs.
 */
export function defaultRunFor(runs: readonly RunMeta[], other: RunRef | null, projectId: string): string | null {
	const avoid = other && other.projectId === projectId ? other.runId : null;
	return (runs.find((r) => r.id !== avoid) ?? runs[0])?.id ?? null;
}

/** Search string for the page with both sides chosen (keeps other params out). */
export function compareSearch(a: RunRef | null, b: RunRef | null, project?: string | null): string {
	const q = new URLSearchParams();
	if (a) q.set('a', formatRef(a));
	if (b) q.set('b', formatRef(b));
	if (!a && !b && project) q.set('project', project);
	const s = q.toString();
	return s ? `?${s}` : '';
}

/**
 * A run in a picker, with what the Runs list shows beside it: "Baseline ·
 * 2026-09-23 14:05 · 1981–2025 · latest · evidence · pinned · workbook
 * comparison" (each tag only when it applies). A native option holds text
 * only, so the tags are words, in the Runs list's order.
 */
export function runOptionLabel(
	r: Pick<RunMeta, 'label' | 'createdAt' | 'startDate' | 'endDate' | 'evidence' | 'pinned' | 'legacy'>,
	fmtDate: (iso: string) => string,
	latest = false
): string {
	const parts = [r.label || 'Untitled run', fmtDate(r.createdAt), runYears(r.startDate, r.endDate)];
	if (latest) parts.push('latest');
	if (r.evidence === 'current') parts.push('evidence');
	else if (r.evidence === 'past') parts.push('former evidence');
	if (r.pinned) parts.push('pinned');
	if (r.legacy) parts.push('workbook comparison');
	return parts.join(' · ');
}
