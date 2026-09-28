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

/** The language everything falls back to (messages without a translation, a NULL locale). */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * The lookups over a language table (English first). The app uses the one
 * built from LANGUAGES below. Tests build one over a table with a stand-in
 * language added (`languageTable([...LANGUAGES, xx])`) and mock this module
 * with it, to prove a new language needs no other code change.
 */
export function languageTable<L extends Language>(languages: readonly L[]) {
	const locales: readonly L['code'][] = languages.map((l) => l.code);
	const isLocale = (v: unknown): v is L['code'] => (locales as readonly unknown[]).includes(v);
	return {
		LANGUAGES: languages,
		LOCALES: locales,
		isLocale,
		language: (code: string | null | undefined): L => languages.find((l) => l.code === code) ?? languages[0]!,
		matchLocale(tags: readonly string[]): L['code'] {
			for (const tag of tags) {
				const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
				if (isLocale(primary)) return primary;
			}
			return languages[0]!.code;
		}
	};
}

const table = languageTable<(typeof LANGUAGES)[number]>(LANGUAGES);

/** Every language code, English first. */
export const LOCALES: readonly Locale[] = table.LOCALES;

export const isLocale: (v: unknown) => v is Locale = table.isLocale;

/** A language's row. An unknown code gets English's. */
export const language: (code: string | null | undefined) => Language = table.language;

/**
 * The supported language a browser's language list asks for first: the
 * first entry whose primary tag is a supported language, else English.
 * ("af-ZA" → af; ["de", "af"] → af; ["en-ZA", "af"] → en.)
 */
export const matchLocale: (languages: readonly string[]) => Locale = table.matchLocale;
