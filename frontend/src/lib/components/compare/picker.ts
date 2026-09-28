// URL state and default choices for the compare page's run pickers: the
// baseline (`a`), what-if 1 (`b`) and the optional what-if 2 (`c`, issue #17 A4).
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
 * Default pair when the page opens with only ?project= (runs arrive newest
 * first, as GET /projects/:id/runs returns them): B = the latest run, and A =
 * the project's published baseline when there is one and it isn't the latest
 * ("compare with published", docs/run-comparison.md), else the previous run.
 * null when there are fewer than two runs to compare.
 */
export function defaultPair(projectId: string, runs: readonly Pick<RunMeta, 'id' | 'published'>[]): { a: RunRef; b: RunRef } | null {
	if (runs.length < 2) return null;
	const latest = runs[0]!;
	const published = runs.find((r) => r.published && r.id !== latest.id);
	return { a: { projectId, runId: (published ?? runs[1]!).id }, b: { projectId, runId: latest.id } };
}

/**
 * The "Compare with published" offer for a chosen pair: A set to B's
 * project's published baseline, when that project has one, it isn't B (a run
 * against itself tells nothing) and A isn't it already. null otherwise, so
 * the offer shows only when it would change something.
 */
export function publishedBaseline(runsOfB: readonly Pick<RunMeta, 'id' | 'published'>[] | undefined, a: RunRef | null, b: RunRef | null): RunRef | null {
	if (!b) return null;
	const published = runsOfB?.find((r) => r.published);
	if (!published || published.id === b.runId) return null;
	if (a && a.projectId === b.projectId && a.runId === published.id) return null;
	return { projectId: b.projectId, runId: published.id };
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

/**
 * The run to add as a second what-if: the newest run of the project that
 * isn't already the baseline or what-if 1 there. null when every run is
 * taken (the picker then waits for a choice).
 */
export function defaultWhatIf(runs: readonly Pick<RunMeta, 'id'>[], taken: readonly (RunRef | null)[], projectId: string): string | null {
	const avoid = new Set(taken.filter((r): r is RunRef => !!r && r.projectId === projectId).map((r) => r.runId));
	return runs.find((r) => !avoid.has(r.id))?.id ?? null;
}

/** Search string for the page with its runs chosen (keeps other params out). `c` is the second what-if. */
export function compareSearch(a: RunRef | null, b: RunRef | null, project?: string | null, c: RunRef | null = null): string {
	const q = new URLSearchParams();
	if (a) q.set('a', formatRef(a));
	if (b) q.set('b', formatRef(b));
	if (c) q.set('c', formatRef(c));
	if (!a && !b && !c && project) q.set('project', project);
	const s = q.toString();
	return s ? `?${s}` : '';
}

/**
 * The workspace's Compare runs tab for a pair (issue #17): `?tab=compare`
 * plus the pair and an optional second what-if `c`, never `project=` (the
 * tab's project is the page's).
 */
export function compareTabHref(a: RunRef | null, b: RunRef | null, c: RunRef | null = null): string {
	const q = new URLSearchParams({ tab: 'compare' });
	if (a) q.set('a', formatRef(a));
	if (b) q.set('b', formatRef(b));
	if (c) q.set('c', formatRef(c));
	return `?${q}`;
}

/**
 * A run in a picker, with what the Runs list shows beside it: "Baseline ·
 * 2026-09-23 14:05 · 1979–2024 · latest · published · evidence · pinned ·
 * workbook comparison" (each tag only when it applies). A native option holds text
 * only, so the tags are words, in the Runs list's order.
 */
export function runOptionLabel(
	r: Pick<RunMeta, 'label' | 'createdAt' | 'startDate' | 'endDate' | 'evidence' | 'pinned' | 'legacy' | 'published'>,
	fmtDate: (iso: string) => string,
	latest = false
): string {
	const parts = [r.label || 'Untitled run', fmtDate(r.createdAt), runYears(r.startDate, r.endDate)];
	if (latest) parts.push('latest');
	if (r.published) parts.push('published');
	if (r.evidence === 'current') parts.push('evidence');
	else if (r.evidence === 'past') parts.push('former evidence');
	if (r.pinned) parts.push('pinned');
	if (r.legacy) parts.push('workbook comparison');
	return parts.join(' · ');
}
