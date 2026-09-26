// The email catalogue's one entry point (WP-2.5; docs/ui.md § Language).
// Usage:
//
//   const tr = mailT(user.locale);          // 'en' | 'af' | null (null → en)
//   tr.t('mail.verify.heading');            // a string, English if af has none
//   tr.t('mail.verify.body', { email });    // {email} filled in
//   tr.lang;                                // what to put in <html lang>
//
// `lang` is the locale the words actually came out in: it stays 'en' when
// any key this email used fell back to English, so a mixed email never
// claims to be Afrikaans. Values are filled in raw; the template escapes the
// finished string for the HTML part.
import { af } from './af.js';
import { en, type MailKey } from './en.js';

export type { MailKey } from './en.js';

/** Languages a person or an invite can have (app_user.locale 049, invite.locale 034). */
export const LOCALES = ['en', 'af'] as const;
export type Locale = (typeof LOCALES)[number];

const CATALOGUES: Record<Locale, Partial<Record<MailKey, string>>> = { en, af };

/** A stored locale (possibly NULL or unknown) as one we can send. */
export function mailLocale(value: string | null | undefined): Locale {
	return (LOCALES as readonly string[]).includes(value ?? '') ? (value as Locale) : 'en';
}

/** `{name}` → vars.name. An unknown placeholder is left as written, so a typo shows rather than vanishing. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export interface MailTranslator {
	t(key: MailKey, vars?: Record<string, string | number>): string;
	/** The language the words used so far are in: the requested locale, or 'en' once anything fell back. */
	readonly lang: Locale;
}

export function mailT(locale: string | null | undefined): MailTranslator {
	const want = mailLocale(locale);
	let fellBack = false;
	return {
		t(key, vars) {
			const own = CATALOGUES[want][key];
			if (own == null) fellBack ||= want !== 'en';
			return fill(own ?? en[key], vars);
		},
		get lang() {
			return fellBack ? 'en' : want;
		}
	};
}
