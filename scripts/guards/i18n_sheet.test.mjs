import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	allLanguages,
	catalogueGroups,
	cell,
	commonSources,
	helpGroup,
	helpHash,
	IDS,
	placeholders,
	renderIds,
	renderSheet,
	report,
	resolveLanguage,
	sectionOf,
	sheetOf,
	sheetPath,
	siteGroups,
	sources,
	staleSite,
	translatedLanguages
} from './i18n_sheet.mjs';
import { messageId, pluralId } from './i18n_extract.mjs';
import { makeFixture } from './i18n_fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('cells escape pipes and keep paragraphs on one table row', () => {
	assert.equal(cell('a | b'), 'a \\| b');
	assert.equal(cell('one\n\ntwo'), 'one<br><br>two');
});

test('placeholders are unique and sorted', () => {
	assert.deepEqual(placeholders('{b} of {a}, {b}'), ['a', 'b']);
	assert.deepEqual(placeholders('none'), []);
});

test('a key falls in its longest matching section, never a mere string prefix', () => {
	const sections = { farm: 'x', 'farm.dam': 'y', 'farm.damPage': 'z' };
	assert.equal(sectionOf('farm.dam.title', sections), 'farm.dam');
	assert.equal(sectionOf('farm.damPage.up', sections), 'farm.damPage');
	assert.equal(sectionOf('farm.other', sections), 'farm');
	assert.equal(sectionOf('login.x', sections), null);
});

test('only untranslated keys are listed, with placeholders and notes as context', () => {
	const groups = catalogueGroups({
		en: { 'a.one': 'One {n}', 'a.two': 'Two', 'b.x': 'Bee' },
		af: { 'a.two': 'Twee' },
		sections: { a: 'Section A', b: 'Section B' },
		notes: { 'a.one': 'A note.' }
	});
	assert.deepEqual(
		groups.map((g) => [g.section, g.rows.map((r) => [r.key, r.context])]),
		[
			['a', [['a.one', 'A note. Keep: {n}']]],
			['b', [['b.x', '']]]
		]
	);
});

test('a glossary entry leaves the sheet only with a translation stamped from the current English', () => {
	const entry = { id: 'x', term: 'T', short: 'S', long: 'L', category: 'farmer' };
	const other = { id: 'y', term: 'T', short: 'S', long: 'L', category: 'basics' };
	assert.equal(helpGroup([entry, other], {}).rows.length, 3);
	assert.equal(helpGroup([entry], { x: { term: 'a', short: 'b', long: 'c', sourceHash: helpHash(entry) } }).rows.length, 0);
	const stale = helpGroup([entry], { x: { term: 'a', short: 'b', long: 'c', sourceHash: 'old' } });
	assert.equal(stale.rows.length, 3);
	assert.match(stale.rows[0].context, /English changed/);
});

const XX = { code: 'xx', name: 'Xx' };

test('the sheet renders a table row per string and counts them, headed by the language name', () => {
	const md = renderSheet(XX, [{ name: 'on the site', title: 'Site', groups: [{ section: 's', description: 'D', rows: [{ key: 'k', english: 'E | F', context: '' }] }] }]);
	assert.match(md, /^# Xx translation sheet$/m);
	assert.match(md, /^1 strings: 1 on the site\.$/m);
	assert.match(md, /^\| `k` \| E \\\| F \|  \|  \|$/m);
	assert.match(md, /pnpm gen:i18n:export xx/);
	assert.match(md, /pnpm gen:i18n:apply xx/);
});

const site = (list) => new Map(list.map((m) => [m.id, m]));
const text = (english, section, context) => ({ id: messageId(english, context), kind: 'text', english, context, section });
const days = { id: pluralId({ one: 'day', other: 'days' }), kind: 'plural', forms: { one: 'day', other: 'days' }, section: 'b' };

test('site messages are listed by id in section order, a counted word a row per form, with context, notes and placeholders', () => {
	const messages = site([text('B first', 'b'), text('Hello {name}', 'a'), text('Create account', 'a', 'page title'), days]);
	const groups = siteGroups({ messages, af: {}, sections: { a: 'Section A', b: 'Section B', c: 'Unused' }, notes: { 'Hello {name}': 'A greeting.', days: 'A count.' } });
	assert.deepEqual(
		groups.map((g) => [g.section, g.rows.map((r) => [r.key, r.english, r.context])]),
		[
			[
				'a',
				[
					[messageId('Hello {name}'), 'Hello {name}', 'A greeting. Keep: {name}'],
					[messageId('Create account', 'page title'), 'Create account', 'Meaning: page title. The same English elsewhere has its own row.']
				]
			],
			[
				'b',
				[
					[messageId('B first'), 'B first', ''],
					[`${days.id}.one`, 'day', 'A count.'],
					[`${days.id}.other`, 'days', '']
				]
			]
		]
	);
});

test('a translated site message leaves the sheet; a translation whose id no message has is stale and fails the check', () => {
	const messages = site([text('Kept', 'a'), text('Edited English', 'a'), days]);
	const af = { [messageId('Kept')]: 'x', [messageId('Old English')]: 'y', [days.id]: { one: 'x', other: 'y' } };
	const groups = siteGroups({ messages, af, sections: { a: 'A', b: 'B' } });
	assert.deepEqual(groups.flatMap((g) => g.rows.map((r) => r.english)), ['Edited English']);
	const stale = staleSite(messages, af);
	assert.deepEqual(stale, [messageId('Old English')]);
	const r = report({ site: groups, mail: [], help: [], helpAf: {}, staleSiteIds: stale });
	assert.deepEqual(r.stale, stale);
	assert.match(r.text, /Stale site translations/);
});

test('the id list is sorted and counted', () => {
	const ids = renderIds(site([text('b', 'a'), text('a', 'a')]));
	assert.match(ids, /^export const MESSAGE_COUNT = 2;$/m);
	assert.ok(ids.indexOf(`'${messageId('a')}'`) < ids.indexOf(`'${messageId('b')}'`) === messageId('a') < messageId('b'));
});

test('resolveLanguage finds a code in the table and refuses one that isn’t there', async () => {
	const en = await resolveLanguage('en');
	assert.equal(en.code, 'en');
	await assert.rejects(resolveLanguage('zz'), /"zz" isn't in/);
});

test('translatedLanguages is every language but the fallback', async () => {
	const langs = await translatedLanguages();
	assert.ok(langs.every((l) => l.code !== 'en'));
	const { DEFAULT_LOCALE } = await allLanguages();
	assert.equal(DEFAULT_LOCALE, 'en');
});

test('the committed sheets and the id list are current for every language (pnpm gen:i18n:sheet)', async () => {
	const common = await commonSources();
	assert.deepEqual(common.problems, []);
	assert.equal(readFileSync(path.join(ROOT, IDS), 'utf8'), renderIds(common.messages));
	for (const lang of await translatedLanguages()) {
		const src = await sources(lang.code, common);
		assert.equal(readFileSync(path.join(ROOT, sheetPath(lang.code)), 'utf8'), sheetOf(lang, src), `${sheetPath(lang.code)} is out of date`);
	}
});

// ---- A stand-in language, end to end, against a throwaway repo (never committed as a real catalogue) ----

test('a language with no catalogue files yet lists everything untranslated (a fixture root, not the real repo)', async () => {
	const { root, cleanup } = makeFixture();
	try {
		const common = await commonSources(root);
		assert.deepEqual(common.problems, []);
		const langs = await translatedLanguages(root);
		assert.deepEqual(
			langs.map((l) => l.code),
			['xx']
		);
		const src = await sources('xx', common);
		assert.equal(src.site.length, 1);
		assert.deepEqual(src.site[0].rows.map((r) => r.english), ['Stand-in message']);
		assert.equal(src.mail.length, 1);
		assert.deepEqual(src.mail[0].rows.map((r) => r.english), ['Hello {name}']);
		assert.equal(helpGroup(src.help, src.helpAf).rows.length, 3);
	} finally {
		cleanup();
	}
});
