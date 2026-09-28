// Proof that a language is one table entry (issue #58; docs/ui.md § Adding a
// language). The engine's language table is mocked with a stand-in language
// added, `xx` ("Xx-test", a decimal comma, en-US dates), and with no other
// code change the site detects it, switches to it, formats in it and offers
// it in the switch. The stand-in and its words exist only in this file: no
// `xx` catalogue ships.
import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDay, fmtNumber, fmtVolume } from '$lib/components/farm/format';
import { dateLocale, decimalMark } from '$lib/components/farm/numbers';
import LanguageSwitch from './LanguageSwitch.svelte';
import { markedCatalogue } from './fixtureCatalogue';
import { i18n, isLocale, LANGUAGES, resolveLocale, setLocale, t, wordsLang } from './locale.svelte';
import { messageId } from './msg';

vi.mock('@water-management/engine/languages', async (importOriginal) => {
	const real = await importOriginal<typeof import('@water-management/engine/languages')>();
	return { ...real, ...real.languageTable([...real.LANGUAGES, { code: 'xx', name: 'Xx-test', intl: 'en-US', decimalMark: ',' }]) };
});
vi.mock('$lib/api', () => ({ api: {} }));
vi.mock('$lib/auth/session.svelte', () => ({ session: { user: null } }));

// The stand-in's code, typed as a Locale the way a real third entry would be.
const XX = 'xx' as (typeof LANGUAGES)[number]['code'];

afterEach(() => setLocale('en'));

describe('a stand-in language added to the table only', () => {
	it('is a known locale, and the browser’s list picks it', () => {
		expect(isLocale('xx')).toBe(true);
		expect(resolveLocale(null, null, ['de-DE', 'xx-ZA', 'af'])).toBe('xx');
		expect(resolveLocale('xx', null, [])).toBe('xx');
	});

	it('switches to a supplied catalogue, and shows English words when it has no catalogue file', async () => {
		await setLocale(XX, { [messageId('Your dam')]: '[xx] dam' });
		expect(i18n.locale).toBe('xx');
		expect(t('Your dam')).toBe('[xx] dam');
		await setLocale(XX);
		expect(t('Your dam')).toBe('Your dam');
		expect(wordsLang()).toBe('en');
	});

	it('formats numbers with its decimal mark, and dates in its Intl locale once its words are complete', async () => {
		await setLocale(XX, {});
		expect(decimalMark()).toBe(',');
		expect(fmtNumber(1234.5, 1)).toBe('1\u202f234,5');
		expect(fmtVolume(83_640.4, 'ML').replace(/ /g, ' ')).toBe('83,6 ML');
		expect(dateLocale()).toBe('en-ZA'); // words still English
		await setLocale(XX, await markedCatalogue());
		expect(wordsLang()).toBe('xx');
		expect(dateLocale()).toBe('en-US');
		expect(fmtDay('2024-01-10')).toBe('Jan 10, 2024');
	});

	it('turns the switch into a <select> with each language, marked with its own lang', () => {
		const { body } = render(LanguageSwitch);
		expect(body).not.toContain('<button');
		const options = [...body.matchAll(/<option[^>]*value="(\w+)"[^>]*lang="(\w+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2], m[3]]);
		expect(options).toEqual([
			['en', 'en', 'English'],
			['af', 'af', 'Afrikaans'],
			['xx', 'xx', 'Xx-test']
		]);
		expect(body).toMatch(/<select[^>]*aria-label="Language"/);
	});
});
