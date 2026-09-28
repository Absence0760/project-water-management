import { describe, expect, it } from 'vitest';
import { LOCALES } from '@water-management/engine/languages';
import { HELP_AF } from './content.af';
import { helpLanguages, helpTranslations } from './translations';

describe('the glossary per language', () => {
	it('finds each language’s file by name and reads its HELP_<CODE> export', async () => {
		expect(await helpTranslations('af')).toBe(HELP_AF);
	});

	it('gives English, and a language with no glossary file yet, nothing (the English shows)', async () => {
		expect(await helpTranslations('en')).toEqual({});
		expect(await helpTranslations('xx')).toEqual({});
	});

	it('has a glossary only for languages in the table (never a test stand-in)', () => {
		expect(helpLanguages().sort()).toEqual(LOCALES.filter((l) => l !== 'en').sort());
	});
});
