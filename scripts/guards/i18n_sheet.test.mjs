import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAll, catalogueGroups, cell, helpGroup, helpHash, IDS, placeholders, renderIds, renderSheet, report, sectionOf, SHEET, siteGroups, staleSite } from './i18n_sheet.mjs';
import { messageId, pluralId } from './i18n_extract.mjs';

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

test('the sheet renders a table row per string and counts them', () => {
	const md = renderSheet([{ name: 'on the site', title: 'Site', groups: [{ section: 's', description: 'D', rows: [{ key: 'k', english: 'E | F', context: '' }] }] }]);
	assert.match(md, /^1 strings: 1 on the site\.$/m);
	assert.match(md, /^\| `k` \| E \\\| F \|  \|  \|$/m);
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

test(`the committed ${SHEET} and ${IDS} are current (pnpm gen:i18n:sheet)`, async () => {
	const { sheet, ids, src } = await buildAll();
	assert.deepEqual(src.problems, []);
	assert.equal(readFileSync(path.join(ROOT, SHEET), 'utf8'), sheet);
	assert.equal(readFileSync(path.join(ROOT, IDS), 'utf8'), ids);
});
