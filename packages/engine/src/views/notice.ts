// The WUA's restriction notice in each language it wrote it in (issue #58;
// run_publication.notice, 081_notice_languages.sql), and which one a reader
// gets. The farm view, /share and the alert emails all pick through
// pickNotice, so the rule is written once.
import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from '../languages';

/** The WUA's words by language code, `{ en: '…', af: '…' }`. A language it didn't write is absent; `{}` is no notice. */
export type NoticeText = Partial<Record<Locale, string>>;

/**
 * The WUA's notice in the reader's language, else in English, else in the
 * first other language of the table that has one (design §7); null when it
 * wrote none. Blank counts as not written, and a code the language table
 * doesn't list is never shown.
 */
export function pickNotice(
	notice: Readonly<Record<string, string | null | undefined>> | null | undefined,
	reader: string | null | undefined
): { text: string; lang: Locale } | null {
	if (!notice) return null;
	for (const code of [reader, DEFAULT_LOCALE, ...LOCALES]) {
		if (!isLocale(code) || !Object.hasOwn(notice, code)) continue;
		const text = notice[code];
		if (typeof text === 'string' && text.trim()) return { text, lang: code };
	}
	return null;
}
