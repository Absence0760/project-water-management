// The languages the farmer-facing pages, emails and the WUA's notices can be
// in (WP-2.5, issue #58; docs/ui.md § Language). The one list: the frontend
// (switch, formatting, browser detection), the backend (emails, API
// validation) and the database (the `language` table, synced from here by
// backend/scripts/migrate.ts) all read it.
//
// Adding a language is one entry here plus its catalogues (site, email,
// glossary) and a translation run: docs/ui.md § Adding a language.

export interface Language {
	/** BCP 47 primary tag, as stored (app_user.locale, invite.locale) and put in <html lang>. */
	readonly code: string;
	/** The language's name in that language (fixed, never translated). */
	readonly name: string;
	/** The Intl locale for dates and plural rules, as South Africa writes the language. */
	readonly intl: string;
	/** The decimal mark the farm view writes (digits are always grouped with no-break spaces). */
	readonly decimalMark: '.' | ',';
}

export const LANGUAGES = [
	{ code: 'en', name: 'English', intl: 'en-ZA', decimalMark: '.' },
	{ code: 'af', name: 'Afrikaans', intl: 'af-ZA', decimalMark: ',' }
] as const satisfies readonly Language[];

export type Locale = (typeof LANGUAGES)[number]['code'];

/** Every language code, English first. */
export const LOCALES: readonly Locale[] = LANGUAGES.map((l) => l.code);

/** The language everything falls back to (messages without a translation, a NULL locale). */
export const DEFAULT_LOCALE: Locale = 'en';

export const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

/** A language's row. An unknown code gets English's. */
export function language(code: string | null | undefined): Language {
	return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/**
 * The supported language a browser's language list asks for first: the
 * first entry whose primary tag is a supported language, else English.
 * ("af-ZA" → af; ["de", "af"] → af; ["en-ZA", "af"] → en.)
 */
export function matchLocale(languages: readonly string[]): Locale {
	for (const tag of languages) {
		const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
		if (isLocale(primary)) return primary;
	}
	return DEFAULT_LOCALE;
}
