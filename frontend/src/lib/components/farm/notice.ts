// The WUA's notice as the farm view and the /share page show it: its shape
// and how its text splits into a title and a body, and the levels' names.
// It loads no message code (only $lib/i18n/msg, which marks the names for the
// translation sheet), so /share uses it without the workspace's code
// (./cards.ts re-exports it).
import { language, pickNotice, type Locale, type RestrictionLevel } from '@water-management/engine';
import { msg, type Msg } from '$lib/i18n/msg';
import { wordsLang } from '$lib/i18n/state.svelte';

export { pickNotice };

// i18n-section: farm.level
/** The restriction level's name, worded with t(): "No restriction", "Advisory", "Restriction". */
export const LEVEL_WORDS: Record<RestrictionLevel, Msg> = { none: msg('No restriction'), advisory: msg('Advisory'), restricted: msg('Restriction') };

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
	lang: Locale | null;
	/** "The WUA wrote this notice in English only.": when the words aren't in the reader's language (design §7). */
	langNote: string | null;
}

// i18n-section: farm.notice
/** Under the notice when it isn't in the reader's language: t(WRITTEN_ONLY_IN, { language: languageName(lang) }). */
export const WRITTEN_ONLY_IN = msg('The WUA wrote this notice in {language} only.');

/**
 * A language's name in the language the page's words are in ("Engels" on an
 * Afrikaans page), from the browser's own list (Intl.DisplayNames), so a new
 * language needs no message of its own; the table's own name when the
 * browser has none.
 */
export function languageName(code: Locale): string {
	return new Intl.DisplayNames([language(wordsLang()).intl], { type: 'language', fallback: 'none' }).of(code) ?? language(code).name;
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
