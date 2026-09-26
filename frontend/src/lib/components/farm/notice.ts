// The WUA's notice as the farm view and the /share page show it: its shape
// and how its text splits into a title and a body. No words of our own, so
// /share uses it without loading the message catalogue (./cards.ts
// re-exports it).
import type { RestrictionLevel } from '@water-management/engine';

export interface NoticeVm {
	level: RestrictionLevel;
	/** "Notice from the WUA · Advisory", above the heading; null when it is the heading. */
	label: string | null;
	heading: string;
	body: string | null;
	/** The published percentage, only when the WUA gave no text to carry it. */
	pctLine: string | null;
	/** "Example WUA, 12 Jan 2024". */
	byline: string;
	/** The notice's first line (its title), for the "Why?" page and the offline view. */
	title: string | null;
}

/**
 * The WUA writes the notice; the app never writes restriction wording of its
 * own. A notice's first line is its title when more follows (or when it's
 * short enough to be one), the rest its text.
 */
export function splitNotice(notice: string | null): { title: string | null; body: string | null } {
	const lines = (notice ?? '')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return { title: null, body: null };
	if (lines.length === 1) return lines[0]!.length <= 80 ? { title: lines[0]!, body: null } : { title: null, body: lines[0]! };
	return { title: lines[0]!, body: lines.slice(1).join('\n') };
}
