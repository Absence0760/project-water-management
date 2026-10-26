// View helpers for the Project page (ProjectTab.svelte, issue #17).
import { fmtDate } from '#lib/format/number.js';

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
	return [owner, created === '–' ? null : `created ${created}`, `time zone ${p.timeZone ?? DEFAULT_TIME_ZONE}`]
		.filter(Boolean)
		.join(' · ');
}

/**
 * How many people Members and Farmers list before "Show all N" (issue #586
 * R4-F): with 30 members and 30 farmers, the one-column page put Recent notes
 * 5,000 px down at 1440 and 14,000 px down on a phone. As the Summary's
 * Supply by unit, a long list shows its first few and opens the rest in
 * place, rather than scrolling inside its card (ui-playbook § 2).
 */
export const PEOPLE_SHOWN = 8;

/**
 * The rows shown while a list is folded: the first `cap`, plus any later row
 * `keep` asks for (the reader's own, so Leave is never behind the fold). A
 * list of `cap + 1` shows whole: a button to reveal one row is worse than
 * the row. `hidden` is how many the fold keeps back (0: no button).
 */
export function foldRows<T>(rows: readonly T[], all: boolean, cap: number, keep: (row: T) => boolean = () => false): { shown: T[]; hidden: number } {
	if (all || rows.length <= cap + 1) return { shown: [...rows], hidden: 0 };
	const shown = rows.filter((r, i) => i < cap || keep(r));
	return { shown, hidden: rows.length - shown.length };
}

const naturalName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * People by name as a reader counts ("Farmer 2" before "Farmer 10"), within
 * the groups the server already sorts them into (Members: by role, owners
 * first), whose order stays. The server sorts names as text, which put
 * "Hydrologist 10" … "Hydrologist 19" before "Hydrologist 2".
 */
export function byName<T extends { displayName: string }>(rows: readonly T[], groupOf: (row: T) => string = () => ''): T[] {
	const rank = new Map<string, number>();
	for (const r of rows) if (!rank.has(groupOf(r))) rank.set(groupOf(r), rank.size);
	return [...rows].sort((a, b) => rank.get(groupOf(a))! - rank.get(groupOf(b))! || naturalName.compare(a.displayName, b.displayName));
}
