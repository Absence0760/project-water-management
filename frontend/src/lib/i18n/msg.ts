// Messages are their English (WP-2.5; docs/ui.md § Language). The English
// sits where it is used, `t('Your dam')`, and is the message itself: there is
// no separate English catalogue to ship. A translation is looked up by the
// message's id, a short hash of its English (and its context, when the same
// English means two different things), so an edited English string gets a new
// id and shows as untranslated until the translator has seen it: an old
// translation is never kept for new words.
//
// This module has no catalogue and no runes, so modules the workspace shares
// (emailAuth.ts) can mark their messages without loading the translated
// pages' code. Only erasable TypeScript: scripts/guards/i18n_sheet.mjs loads
// it directly to give each string on the translation sheet the same id.

declare const MSG: unique symbol;
/** An English message held in a variable or a table (made by msg()); t() takes these or a literal. */
export type Msg = string & { readonly [MSG]: true };

/**
 * Marks an English message that is kept in a variable or a table and worded
 * later with t() / tRich(). The translation sheet's extractor finds messages
 * by their t() / tRich() / msg() calls, so a message that reaches t() any
 * other way would never be translated (the tests throw on one).
 */
export const msg = <S extends string>(english: S): Msg => english as string as Msg;

/** Intl.PluralRules' categories, in the order an id is made from. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];
/** The English forms of a counted word: `.one` and `.other` for a noun, `.one/.two/.few/.other` for an ordinal. */
export type Plural = Partial<Record<PluralCategory, string>> & { other: string };

/** A counted word's forms, marked for the translation sheet (made once, used with tn()). */
export const plural = <P extends Plural>(forms: P): P => forms;

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits. */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** A message's id: its English, with the context (gettext's msgctxt) in front when it has one. */
export const messageId = (english: string, context?: string): string => fnv1a(context ? `${context}\u0004${english}` : english);

/** A counted word's id: its forms in PLURAL_CATEGORIES order. */
export const pluralId = (forms: Plural, context?: string): string =>
	messageId(
		PLURAL_CATEGORIES.filter((c) => forms[c] != null)
			.map((c) => `${c}\u0001${forms[c]}`)
			.join('\u0002'),
		context
	);
