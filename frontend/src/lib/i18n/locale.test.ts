import { afterEach, describe, expect, it } from 'vitest';
import { plainText } from './rich';
import {
	fill,
	i18n,
	isComplete,
	joinAnd,
	readStoredLocale,
	resolveLocale,
	setLocale,
	storeLocale,
	t,
	tn,
	tRich,
	wordsLang,
	type Catalogue,
	type MessageKey
} from './locale.svelte';
import { en } from './messages/en';

/** Every key, in a made-up "language" that shows which catalogue a word came from. Test data only, never shipped wording. */
const marked = (): Catalogue => Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `[af] ${v}`]));

afterEach(() => setLocale('en'));

describe('t', () => {
	it('fills {name} placeholders and leaves an unknown one showing', () => {
		expect(t('farm.preview', { farm: 'Vaalbank' })).toBe('You’re previewing Vaalbank as its farmer sees it');
		expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
	});

	it('throws on a key the catalogue lacks (dev), rather than showing nothing', () => {
		expect(() => t('no.such.key' as MessageKey)).toThrow(/no message "no\.such\.key"/);
	});

	it('uses the chosen language’s words, falling back to English key by key', async () => {
		await setLocale('af', { 'farm.dam.title': '[af] dam' });
		expect(t('farm.dam.title')).toBe('[af] dam');
		expect(t('farm.menu')).toBe('Menu');
	});

	it('goes back to English', async () => {
		await setLocale('af', marked());
		await setLocale('en');
		expect(t('farm.menu')).toBe('Menu');
		expect(i18n.locale).toBe('en');
	});

	it('lets the latest switch win over a slower earlier one', async () => {
		const slow = setLocale('af', marked());
		await setLocale('en');
		await slow;
		expect(i18n.locale).toBe('en');
		expect(t('farm.menu')).toBe('Menu');
	});

	it('loads the real Afrikaans catalogue lazily', async () => {
		await setLocale('af');
		expect(i18n.locale).toBe('af');
		// Whatever is translated so far, every key still says something.
		expect(t('farm.dam.title')).toBeTruthy();
	});
});

describe('wordsLang: the language the words are in', () => {
	it('stays English while the chosen catalogue is incomplete, so a mostly-English page never claims to be Afrikaans', async () => {
		await setLocale('af', { 'farm.dam.title': '[af] dam' });
		expect(i18n.locale).toBe('af');
		expect(wordsLang()).toBe('en');
	});

	it('is the chosen language once every key is translated', async () => {
		expect(isComplete(marked())).toBe(true);
		await setLocale('af', marked());
		expect(wordsLang()).toBe('af');
	});
});

describe('tn: plural forms through Intl.PluralRules', () => {
	it('picks .one and .other', () => {
		expect(tn('farm.n.day', 1)).toBe('day');
		expect(tn('farm.n.day', 0)).toBe('days');
		expect(tn('farm.n.day', 2)).toBe('days');
	});

	it('picks ordinal forms, with {n} filled in', () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map((n) => tn('farm.ordinal', n, {}, true))).toEqual([
			'1st',
			'2nd',
			'3rd',
			'4th',
			'11th',
			'12th',
			'13th',
			'21st',
			'22nd',
			'23rd'
		]);
	});

	it('uses Afrikaans rules once the words are Afrikaans (af has only "other" ordinals)', async () => {
		await setLocale('af', marked());
		expect(tn('farm.ordinal', 1, {}, true)).toBe('[af] 1th');
		expect(tn('farm.n.day', 1)).toBe('[af] day');
	});
});

describe('tRich', () => {
	it('makes **…** and { b } values bold, merging the plain text between', () => {
		expect(tRich('farm.back.pumpLess', { pct: '86 %' })).toEqual([
			'If you had pumped less on the days the river needed it, you would have had about ',
			{ b: '86 %' },
			' of the water you needed.'
		]);
		expect(tRich('farm.river.outletSome', { name: 'Outlet', n: 12, days: '30 days' })).toEqual([
			'River at Outlet: below its reserve on ',
			{ b: '12 of the last 30 days' },
			'.'
		]);
	});

	it('splices a Rich value in as it is', () => {
		const r = tRich('farm.why.belowReserve', { sites: ['at A on ', { b: '3 days' }] });
		expect(r).toEqual(['The river was below its reserve at A on ', { b: '3 days' }, '.']);
		expect(plainText(r)).toBe('The river was below its reserve at A on 3 days.');
	});
});

describe('joinAnd', () => {
	it('joins with the words’ "and"', () => {
		expect(joinAnd([])).toBe('');
		expect(joinAnd(['Nov', 'Dec'])).toBe('Nov and Dec');
		expect(joinAnd(['Oct', 'Nov', 'Dec'])).toBe('Oct, Nov and Dec');
	});
});

describe('which language to start in', () => {
	it('prefers the account, then this device, then an Afrikaans browser, else English', () => {
		expect(resolveLocale('af', 'en', ['en-ZA'])).toBe('af');
		expect(resolveLocale(null, 'af', ['en-ZA'])).toBe('af');
		expect(resolveLocale(undefined, null, ['af-ZA', 'en'])).toBe('af');
		expect(resolveLocale(null, null, ['af'])).toBe('af');
		expect(resolveLocale(null, null, ['en-ZA', 'af'])).toBe('en');
		expect(resolveLocale(null, null, ['afr'])).toBe('en');
		expect(resolveLocale('xx', null, [])).toBe('en');
	});

	it('keeps the device choice in storage, and survives storage that throws', () => {
		const map = new Map<string, string>();
		const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) } as unknown as Storage;
		expect(readStoredLocale(store)).toBeNull();
		storeLocale('af', store);
		expect(readStoredLocale(store)).toBe('af');
		map.set('wm.locale', 'klingon');
		expect(readStoredLocale(store)).toBeNull();
		const broken = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		} as unknown as Storage;
		expect(readStoredLocale(broken)).toBeNull();
		expect(() => storeLocale('af', broken)).not.toThrow();
	});
});
