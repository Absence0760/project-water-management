// A stand-in language for tests only (issue #58's proof that a language is
// one entry in the table, packages/engine/src/languages.ts). Never shipped,
// never in LANGUAGES. A test adds it by mocking the table module:
//
//   vi.mock('<path to>/packages/engine/src/languages', async (orig) =>
//     (await import('@water-management/engine/testing/language')).withTestLanguage(await orig()));
//
// This file imports nothing at run time, so the mock factory can load it
// while the table module itself is being mocked.
import type * as Languages from '../languages';

export const TEST_LANGUAGE = { code: 'xx', name: 'Xx-test', intl: 'en-ZA', decimalMark: ',' } as const;

/**
 * The table module with TEST_LANGUAGE appended, and LOCALES, isLocale and
 * language() rebuilt over it. Another function of the module keeps reading
 * the real table: rebuild it here when a test needs it to see the stand-in.
 */
export function withTestLanguage(real: typeof Languages): typeof Languages {
	const LANGUAGES = [...real.LANGUAGES, TEST_LANGUAGE] as unknown as typeof real.LANGUAGES;
	const LOCALES = LANGUAGES.map((l) => l.code) as readonly Languages.Locale[];
	const isLocale = (v: unknown): v is Languages.Locale => (LOCALES as readonly unknown[]).includes(v);
	return {
		...real,
		LANGUAGES,
		LOCALES,
		isLocale,
		language: (code) => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]
	};
}
