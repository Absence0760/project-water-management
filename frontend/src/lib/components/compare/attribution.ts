// Who changed the compared runs' inputs (issue #42, GET /compare/runs
// `attribution`): the revision behind each "Inputs that differ" line, and a line
// naming who changed things between the runs. Pure, no DOM.
import type { InputChange } from '@water-management/engine';
import type { CompareAttribution, HistoryRevision } from '$lib/api/types';
import { FORMER_MEMBER } from '$lib/format/maker';
import { fmtDate } from '$lib/format/number';

/** The project's History tab, from the compare page (standalone or in the workspace). */
export const historyHref = (projectId: string) => `/projects/${encodeURIComponent(projectId)}?tab=history`;

/** For each change, the revision that set it; null when none recorded did, or there is no attribution. */
export function lineAuthors(changes: readonly InputChange[], attribution: CompareAttribution | null | undefined): (HistoryRevision | null)[] {
	if (!attribution) return changes.map(() => null);
	const byId = new Map(attribution.revisions.map((r) => [r.id, r]));
	return changes.map((_, i) => {
		const id = attribution.changedBy[i];
		return id ? (byId.get(id) ?? null) : null;
	});
}

/** "Changed by Ann on 2026-09-26 14:02" (the viewer's clock), for one line. */
export function byline(r: HistoryRevision): string {
	return `Changed by ${r.actor ?? FORMER_MEMBER} on ${fmtDate(r.createdAt, true)}`;
}

/** "Ann, Bob and Cat": each person once, in the order given. */
function names(list: string[]): string {
	return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/**
 * The line over the list: "2 saved changes to the model or settings between
 * the runs, by Ann and Bob", newest author first; "No saved model or settings changes between
 * the runs" when there were none (so any line is a series change, or from
 * before history was recorded).
 */
export function attributionSummary(a: CompareAttribution): string {
	const n = a.revisions.length;
	if (!n) return 'No saved model or settings changes between the runs.';
	const who = names([...new Set(a.revisions.map((r) => r.actor ?? FORMER_MEMBER))]);
	return `${a.truncated ? 'More than ' : ''}${n} saved change${n === 1 && !a.truncated ? '' : 's'} to the model or settings between the runs, by ${who}.`;
}
