import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSheet, catalogueGroups, cell, helpGroup, helpHash, placeholders, renderSheet, sectionOf, SHEET } from './i18n_sheet.mjs';

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

test(`the committed ${SHEET} is current (pnpm gen:i18n:sheet)`, async () => {
	assert.equal(readFileSync(path.join(ROOT, SHEET), 'utf8'), await buildSheet());
});
