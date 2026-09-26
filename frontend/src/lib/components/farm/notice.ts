// The WUA's notice as the farm view and the /share page show it: its shape
// and how its text splits into a title and a body, and the levels' names.
// It loads no message code (only $lib/i18n/msg, which marks the names for the
// translation sheet), so /share uses it without the workspace's code
// (./cards.ts re-exports it).
import type { RestrictionLevel } from '@water-management/engine';
import { msg, type Msg } from '$lib/i18n/msg';

// i18n-section: farm.level
/** The restriction level's name, worded with t(): "No restriction", "Advisory", "Restriction". */
export const LEVEL_WORDS: Record<RestrictionLevel, Msg> = { none: msg('No restriction'), advisory: msg('Advisory'), restricted: msg('Restriction') };

export type NoticeLang = 'en' | 'af';

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
	/** The language the WUA's words are in; null without words. */
	lang: NoticeLang | null;
	/** "The WUA wrote this notice in English only.": when the words aren't in the reader's language (design §7). */
	langNote: string | null;
}

/**
 * The WUA's notice in the reader's language, or in the other one when theirs
 * isn't written (design §7); null when it wrote neither. Blank counts as not
 * written.
 */
export function pickNotice(r: { noticeEn: string | null; noticeAf: string | null }, reader: NoticeLang): { text: string; lang: NoticeLang } | null {
	const en = r.noticeEn?.trim() ? r.noticeEn : null;
	const af = r.noticeAf?.trim() ? r.noticeAf : null;
	if (reader === 'af' && af) return { text: af, lang: 'af' };
	if (en) return { text: en, lang: 'en' };
	if (af) return { text: af, lang: 'af' };
	return null;
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
