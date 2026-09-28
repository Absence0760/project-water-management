import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DAYS } from '$lib/components/farm/format';
import { ORDINAL } from '$lib/components/farm/chart';
import { markedCatalogue } from './fixtureCatalogue';
import { messageId, pluralId } from './msg';
import { plainText } from './rich';
import {
	catalogueLanguages,
	fill,
	i18n,
	isComplete,
	joinAnd,
	LOCALES,
	msg,
	readStoredLocale,
	resolveLocale,
	setLocale,
	storeLocale,
	t,
	tn,
	tRich,
	wordsLang,
	type Catalogue
} from './locale.svelte';

/** Every message, in a made-up "language" that shows which catalogue a word came from. Test data only, never shipped wording. */
let marked: Catalogue;
beforeAll(async () => {
	marked = await markedCatalogue();
});

afterEach(() => setLocale('en'));

describe('t', () => {
	it('fills {name} placeholders and leaves an unknown one showing', () => {
		expect(t('You’re previewing {farm} as its farmer sees it', { farm: 'Vaalbank' })).toBe('You’re previewing Vaalbank as its farmer sees it');
		expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
	});

	// Issue #51: af-ZA abbreviates months with a dot ("Des."), so a sentence ending on one read "…31 Des..".
	it('drops the full stop after a value that already ends in one, and only then', () => {
		expect(fill('It looks back over {span}.', { span: '1 Okt. tot 31 Des.' })).toBe('It looks back over 1 Okt. tot 31 Des.');
		expect(fill('Up to {date}. Ask.', { date: '31 Des.' })).toBe('Up to 31 Des. Ask.');
		expect(fill('Up to {date}.', { date: '31 Dec' })).toBe('Up to 31 Dec.');
		expect(fill('{x}, then {y}.', { x: 'Okt.', y: 'Nov.' })).toBe('Okt., then Nov.');
		expect(fill('{missing}.', {})).toBe('{missing}.');
		// tRich the same, for a plain value and a bold one.
		expect(plainText(tRich('River at {name}: kept its reserve on every one of the last {days}.', { name: 'Weir', days: '3 Des.' }))).toBe('River at Weir: kept its reserve on every one of the last 3 Des.');
		expect(plainText(tRich('River at {name}: kept its reserve on every one of the last {days}.', { name: 'Weir', days: { b: '3 Des.' } }))).toBe('River at Weir: kept its reserve on every one of the last 3 Des.');
		expect(plainText(tRich('River at {name}: kept its reserve on every one of the last {days}.', { name: 'Weir', days: '30 days' }))).toBe('River at Weir: kept its reserve on every one of the last 30 days.');
	});

	it('throws (under test) on English the translation sheet doesn’t list, rather than never translating it', () => {
		expect(() => t('No such message')).toThrow(/"No such message" isn't on the translation sheet/);
		// A table without msg() would reach t() the same way.
		const table = { a: 'Not marked' } as const;
		expect(() => t(table.a)).toThrow(/isn't on the translation sheet/);
	});

	it('takes a literal or a msg(), never an arbitrary string', () => {
		const loose: string = 'Your dam';
		// @ts-expect-error: a plain string could be anything; the sheet can only list what it can read.
		expect(t(loose)).toBe('Your dam');
		expect(t(msg('Your dam'))).toBe('Your dam');
	});

	it('uses the chosen language’s words, by the message’s id, falling back to English message by message', async () => {
		await setLocale('af', { [messageId('Your dam')]: '[af] dam' });
		expect(t('Your dam')).toBe('[af] dam');
		expect(t('Menu')).toBe('Menu');
	});

	it('gives English with a context its own translation', async () => {
		await setLocale('af', { [messageId('Create account')]: '[af] button', [messageId('Create account', 'page title')]: '[af] title' });
		expect(t('Create account')).toBe('[af] button');
		expect(t('Create account', {}, 'page title')).toBe('[af] title');
		expect(messageId('Create account', 'page title')).not.toBe(messageId('Create account'));
	});

	it('never shows a translation made from other English: an edited message has a new id', async () => {
		await setLocale('af', { [messageId('Your old dam')]: '[af] old dam' });
		expect(t('Your dam')).toBe('Your dam');
	});

	it('goes back to English', async () => {
		await setLocale('af', marked);
		expect(t('Menu')).toBe('[af] Menu');
		await setLocale('en');
		expect(t('Menu')).toBe('Menu');
		expect(i18n.locale).toBe('en');
	});

	it('lets the latest switch win over a slower earlier one', async () => {
		const slow = setLocale('af', marked);
		await setLocale('en');
		await slow;
		expect(i18n.locale).toBe('en');
		expect(t('Menu')).toBe('Menu');
	});

	it('loads the real Afrikaans catalogue lazily', async () => {
		await setLocale('af');
		expect(i18n.locale).toBe('af');
		// Whatever is translated so far, every message still says something.
		expect(t('Your dam')).toBeTruthy();
	});
});

describe('wordsLang: the language the words are in', () => {
	it('stays English while the chosen catalogue is incomplete, so a mostly-English page never claims to be Afrikaans', async () => {
		await setLocale('af', { [messageId('Your dam')]: '[af] dam' });
		expect(i18n.locale).toBe('af');
		expect(wordsLang()).toBe('en');
	});

	it('is the chosen language once every message is translated', async () => {
		expect(isComplete(marked)).toBe(true);
		const [first, ...rest] = Object.keys(marked);
		expect(isComplete(Object.fromEntries(rest.map((k) => [k, marked[k]!]))), `without ${first}`).toBe(false);
		await setLocale('af', marked);
		expect(wordsLang()).toBe('af');
	});
});

describe('tn: plural forms through Intl.PluralRules', () => {
	it('picks .one and .other', () => {
		expect(tn(DAYS, 1)).toBe('day');
		expect(tn(DAYS, 0)).toBe('days');
		expect(tn(DAYS, 2)).toBe('days');
	});

	it('picks ordinal forms, with {n} filled in', () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map((n) => tn(ORDINAL, n, {}, true))).toEqual([
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
		await setLocale('af', marked);
		expect(tn(ORDINAL, 1, {}, true)).toBe('[af] 1th');
		expect(tn(DAYS, 1)).toBe('[af] day');
	});

	it('takes a counted word’s translated forms by its id, falling back to its "other" form', async () => {
		await setLocale('af', { [pluralId(DAYS)]: { one: '[af] day', other: '[af] days' }, [pluralId(ORDINAL)]: { other: '[af] {n}th' } });
		expect([tn(DAYS, 1), tn(DAYS, 2)]).toEqual(['[af] day', '[af] days']);
		expect(tn(ORDINAL, 2, {}, true)).toBe('[af] 2th');
	});
});

describe('tRich', () => {
	it('makes **…** and { b } values bold, merging the plain text between', () => {
		expect(tRich('If you had pumped less on the days the river needed it, you would have had about **{pct}** of the water you needed.', { pct: '86 %' })).toEqual([
			'If you had pumped less on the days the river needed it, you would have had about ',
			{ b: '86 %' },
			' of the water you needed.'
		]);
		expect(tRich('River at {name}: below its reserve on **{n} of the last {days}**.', { name: 'Outlet', n: 12, days: '30 days' })).toEqual([
			'River at Outlet: below its reserve on ',
			{ b: '12 of the last 30 days' },
			'.'
		]);
	});

	it('splices a Rich value in as it is', () => {
		const r = tRich('The river was below its reserve {sites}.', { sites: ['at A on ', { b: '3 days' }] });
		expect(r).toEqual(['The river was below its reserve at A on ', { b: '3 days' }, '.']);
		expect(plainText(r)).toBe('The river was below its reserve at A on 3 days.');
	});

	it('bolds the translation’s own markers', async () => {
		const english = 'River at {name}: below its reserve on **{n} of the last {days}**.';
		await setLocale('af', { [messageId(english)]: '[af] {name}: **{n} / {days}** [af]' });
		expect(tRich(english, { name: 'A', n: 3, days: '30' })).toEqual(['[af] A: ', { b: '3 / 30' }, ' [af]']);
	});
});

describe('joinAnd', () => {
	it('joins with the words’ "and"', () => {
		expect(joinAnd([])).toBe('');
		expect(joinAnd(['Nov', 'Dec'])).toBe('Nov and Dec');
		expect(joinAnd(['Oct', 'Nov', 'Dec'])).toBe('Oct, Nov and Dec');
	});
});

describe('the catalogue files', () => {
	it('exist for every language in the table but English (messages/<code>.ts), and for nothing else', () => {
		expect(catalogueLanguages().sort()).toEqual(LOCALES.filter((l) => l !== 'en').sort());
	});
});

describe('which language to start in', () => {
	it('prefers the account, then this device, then the browser’s first language the site has, else English', () => {
		expect(resolveLocale('af', 'en', ['en-ZA'])).toBe('af');
		expect(resolveLocale(null, 'af', ['en-ZA'])).toBe('af');
		expect(resolveLocale(undefined, null, ['af-ZA', 'en'])).toBe('af');
		expect(resolveLocale(null, null, ['af'])).toBe('af');
		expect(resolveLocale(null, null, ['en-ZA', 'af'])).toBe('en');
		expect(resolveLocale(null, null, ['afr'])).toBe('en');
		// Not only the first entry: a German browser that also reads Afrikaans gets Afrikaans (issue #58).
		expect(resolveLocale(null, null, ['de-DE', 'af'])).toBe('af');
		expect(resolveLocale(null, null, ['de', 'fr'])).toBe('en');
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
