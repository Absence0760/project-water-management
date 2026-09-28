// View helpers for the Project page (ProjectTab.svelte, issue #17).
import { fmtDate, fmtDay } from '$lib/format/number';

/** The zone a project dates its downloads by when the API sends none (issue #45). */
export const DEFAULT_TIME_ZONE = 'Africa/Johannesburg';

/**
 * The section header's context line: who owns the project, when it was
 * created and the time zone its downloads are dated by, e.g.
 * "Team “North WUA” · created 3 Sep 2026 · time zone Africa/Johannesburg".
 */
export function projectContext(p: { team: { name: string | null } | null; createdAt: string; timeZone?: string }): string {
	const owner = p.team ? (p.team.name ? `Team “${p.team.name}”` : 'A team project') : 'Personal project';
	const created = fmtDate(p.createdAt);
	return [owner, created === '–' ? null : `created ${fmtDay(created)}`, `time zone ${p.timeZone ?? DEFAULT_TIME_ZONE}`]
		.filter(Boolean)
		.join(' · ');
}
