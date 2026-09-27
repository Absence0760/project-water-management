import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, isLocale, language, languageTable, LANGUAGES, LOCALES, matchLocale } from './languages';

describe('the language table', () => {
	it('lists English first, each code once, as a lower-case primary tag with a working Intl locale', () => {
		expect(LOCALES[0]).toBe(DEFAULT_LOCALE);
		expect(new Set(LOCALES).size).toBe(LOCALES.length);
		for (const l of LANGUAGES) {
			expect(l.code).toMatch(/^[a-z]{2,3}$/);
			expect(Intl.DateTimeFormat.supportedLocalesOf([l.intl])).toEqual([l.intl]);
			expect(new Intl.Locale(l.intl).language).toBe(l.code);
		}
	});

	it('knows its codes and falls back to English for anything else', () => {
		expect(isLocale('af')).toBe(true);
		expect(isLocale('xx')).toBe(false);
		expect(isLocale(null)).toBe(false);
		expect(language('af').decimalMark).toBe(',');
		expect(language('zz')).toBe(LANGUAGES[0]);
		expect(language(null).code).toBe('en');
	});

	it('matches a browser list on the first supported primary tag', () => {
		expect(matchLocale(['af-ZA', 'en'])).toBe('af');
		expect(matchLocale(['af'])).toBe('af');
		expect(matchLocale(['de-DE', 'AF_za'])).toBe('af');
		expect(matchLocale(['en-ZA', 'af'])).toBe('en');
		expect(matchLocale(['de', 'fr'])).toBe('en');
		expect(matchLocale([])).toBe('en');
	});
});

describe('languageTable (what the stand-in-language tests build on)', () => {
	const XX = { code: 'xx', name: 'Xx-test', intl: 'en-ZA', decimalMark: ',' } as const;
	const t = languageTable([...LANGUAGES, XX]);

	it('adds a language to every lookup', () => {
		expect(t.LOCALES).toEqual([...LOCALES, 'xx']);
		expect(t.isLocale('xx')).toBe(true);
		expect(t.language('xx')).toBe(XX);
		expect(t.matchLocale(['de', 'xx-ZA', 'af'])).toBe('xx');
		expect(t.language('zz').code).toBe('en');
		expect(t.matchLocale(['de'])).toBe('en');
	});
});
