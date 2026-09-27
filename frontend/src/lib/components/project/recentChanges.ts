// The Project page's "Recent changes" (issue #42): the newest saved changes to
// the model and settings, each in one line, from the History tab's wording
// (history/timeline.ts). Pure, no DOM.
import type { HistoryRevision } from '$lib/api/types';
import { revisionLines, revisionTitle } from '$lib/components/history/timeline';

/** How many revisions the Project page lists. */
export const RECENT_CHANGES = 3;

/** One revision in a line: its heading, its first change line, and how many more it has. */
export function recentChange(r: HistoryRevision): { title: string; first: string; more: number } {
	const lines = revisionLines(r);
	return { title: revisionTitle(r), first: lines[0] ?? '', more: Math.max(0, lines.length - 1) };
}
