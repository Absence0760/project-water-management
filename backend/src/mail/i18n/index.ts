// The email catalogue's one entry point (WP-2.5; docs/ui.md § Language).
// Usage:
//
//   const tr = mailT(user.locale);          // a language code, or null (→ en)
//   tr.t('mail.verify.heading');            // a string, English if the language has none
//   tr.t('mail.verify.body', { email });    // {email} filled in
//   tr.lang;                                // what to put in <html lang>
//
// `lang` is the locale the words actually came out in: it stays 'en' when
// any key this email used fell back to English, so a mixed email never
// claims to be in another language. Values are filled in raw; the template
// escapes the finished string for the HTML part. The languages are the
// engine's one table; each one's catalogue is a line in ./catalogues.ts.
import { DEFAULT_LOCALE, isLocale, language, type Locale } from '@water-management/engine/languages';
import { CATALOGUES } from './catalogues.js';
import { en, type MailKey, type MailPluralBase } from './en.js';

export type { MailKey, MailPluralBase } from './en.js';

/** Languages a person or an invite can have (app_user.locale, invite.locale: the `language` table, synced from this list). */
export { LOCALES, type Locale } from '@water-management/engine/languages';

/** A stored locale (possibly NULL or unknown) as one we can send. */
export function mailLocale(value: string | null | undefined): Locale {
	return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** `{name}` → vars.name. An unknown placeholder is left as written, so a typo shows rather than vanishing. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

const rules = new Map<Locale, Intl.PluralRules>();
const pluralRules = (lang: Locale) => {
	let r = rules.get(lang);
	if (!r) rules.set(lang, (r = new Intl.PluralRules(language(lang).intl)));
	return r;
};

export interface MailTranslator {
	t(key: MailKey, vars?: Record<string, string | number>): string;
	/**
	 * A counted message: the form `<base>.<category>` for `n` by the
	 * language's plural rules (Intl.PluralRules in the language table's
	 * locale), `{n}` and `vars` filled in. A language missing that form
	 * falls back to English, with English's rules, like any missing key.
	 */
	tn(base: MailPluralBase, n: number, vars?: Record<string, string | number>): string;
	/** The language the words used so far are in: the requested locale, or 'en' once anything fell back. */
	readonly lang: Locale;
}

export function mailT(locale: string | null | undefined): MailTranslator {
	const want = mailLocale(locale);
	let fellBack = false;
	const form = (base: MailPluralBase, lang: Locale, n: number) => {
		const cat = pluralRules(lang).select(n);
		const words = lang === DEFAULT_LOCALE ? en : (CATALOGUES[lang] ?? {});
		const exact = words[`${base}.${cat}` as MailKey];
		// English lacks the category (a language with `few`, say): its `other`.
		return exact ?? (`${base}.${cat}` in en ? undefined : words[`${base}.other` as MailKey]);
	};
	return {
		t(key, vars) {
			const own = want === DEFAULT_LOCALE ? en[key] : CATALOGUES[want]?.[key];
			if (own == null) fellBack ||= want !== DEFAULT_LOCALE;
			return fill(own ?? en[key], vars);
		},
		tn(base, n, vars = {}) {
			const own = form(base, want, n);
			if (own == null) fellBack ||= want !== DEFAULT_LOCALE;
			return fill(own ?? form(base, DEFAULT_LOCALE, n) ?? en[`${base}.other` as MailKey], { n, ...vars });
		},
		get lang() {
			return fellBack ? DEFAULT_LOCALE : want;
		}
	};
}
