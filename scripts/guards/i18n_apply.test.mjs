import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batches, literal, plan, renderHelp, renderMail, renderSite, sheetRows } from './i18n_apply.mjs';
import { helpHash } from './i18n_sheet.mjs';

const plural = { id: 'aaaa0001', kind: 'plural', forms: { one: '{n} day', other: '{n} days' }, section: 'farm.n' };
const text = { id: 'aaaa0002', kind: 'text', english: 'About **{pct}** of it', section: 'farm' };
const help = [{ id: 'farm-dam', term: 'Dam', short: 'Short.', long: 'Long.\n\nMore.', category: 'farmer' }];
const src = {
	messages: new Map([
		[plural.id, plural],
		[text.id, text]
	]),
	site: [
		{ section: 'farm', description: 'Farm page.', rows: [{ key: text.id, english: text.english, context: 'Keep: {pct}' }] },
		{
			section: 'farm.n',
			description: 'Counts.',
			rows: [
				{ key: `${plural.id}.one`, english: '{n} day', context: '' },
				{ key: `${plural.id}.other`, english: '{n} days', context: '' }
			]
		}
	],
	mail: [{ section: 'mail.x', description: 'An email.', rows: [{ key: 'mail.x.subject', english: 'Hello {name}', context: 'Keep: {name}' }] }],
	help,
	helpAf: {}
};

test('sheetRows lists site, email and glossary rows with their section', () => {
	const rows = sheetRows(src);
	assert.deepEqual(
		rows.map((r) => [r.id, r.section]),
		[
			[text.id, 'farm'],
			[`${plural.id}.one`, 'farm.n'],
			[`${plural.id}.other`, 'farm.n'],
			['mail.x.subject', 'mail.x'],
			['help.farm-dam.term', 'help'],
			['help.farm-dam.short', 'help'],
			['help.farm-dam.long', 'help']
		]
	);
	assert.equal(rows[0].sectionNote, 'Farm page.');
});

test('batches are about even and never split a section', () => {
	const rows = ['a', 'a', 'a', 'b', 'b', 'c', 'c', 'c'].map((section, i) => ({ id: String(i), section }));
	const bs = batches(rows, 3);
	assert.deepEqual(
		bs.map((b) => b.map((r) => r.section).join('')),
		['aaa', 'bbccc']
	);
	assert.equal(bs.flat().length, rows.length);
});

test('plan splits a good set by catalogue', () => {
	const p = plan(src, {
		[text.id]: 'Omtrent **{pct}** daarvan',
		[`${plural.id}.one`]: '{n} dag',
		[`${plural.id}.other`]: '{n} dae',
		'mail.x.subject': 'Hallo {name}',
		'help.farm-dam.term': 'Dam',
		'help.farm-dam.short': 'Kort.',
		'help.farm-dam.long': 'Lank.\n\nMeer.'
	});
	assert.deepEqual(p.problems, []);
	assert.deepEqual(p.site, { [text.id]: 'Omtrent **{pct}** daarvan', [plural.id]: { one: '{n} dag', other: '{n} dae' } });
	assert.deepEqual(p.mail, { 'mail.x.subject': 'Hallo {name}' });
	assert.deepEqual(p.help, { 'farm-dam': { term: 'Dam', short: 'Kort.', long: 'Lank.\n\nMeer.' } });
});

test('plan refuses unknown ids, broken placeholders or bold, half a counted word and half a glossary entry', () => {
	const { problems } = plan(src, {
		nope: 'x',
		[text.id]: 'Omtrent {persent} daarvan',
		[`${plural.id}.one`]: '{n} dag',
		'mail.x.subject': '',
		'help.farm-dam.term': 'Dam'
	});
	assert.equal(problems.length, 6, problems.join('\n'));
	assert.match(problems.join('\n'), /nope: not on the sheet/);
	assert.match(problems.join('\n'), /placeholders \{persent\}/);
	assert.match(problems.join('\n'), /0 bold pairs/);
	assert.match(problems.join('\n'), /mail.x.subject: empty/);
	assert.match(problems.join('\n'), /no other form/);
	assert.match(problems.join('\n'), /help.farm-dam: no short, long/);
});

test('literal quotes Afrikaans apostrophes and escapes newlines', () => {
	assert.equal(literal("'n Dam"), `"'n Dam"`);
	assert.equal(literal(`He said "hi" and 'n`), `'He said "hi" and \\'n'`);
	assert.equal(literal('a\nb'), `'a\\nb'`);
	assert.equal(eval(literal("'n \"x\"\n")), "'n \"x\"\n");
});

test('renderSite keeps the header and writes entries in message order, English above each', () => {
	const out = renderSite('// header\nimport type { Catalogue } from "../locale.svelte";\n\nexport const af: Catalogue = {};\n', src.messages, { [text.id]: 'Ou' }, { [plural.id]: { one: '{n} dag', other: '{n} dae' } });
	assert.equal(
		out,
		`// header\nimport type { Catalogue } from "../locale.svelte";\n\nexport const af: Catalogue = {\n\t// {n} day / {n} days\n\t'${plural.id}': { one: '{n} dag', other: '{n} dae' },\n\t// About **{pct}** of it\n\t'${text.id}': 'Ou',\n};\n`
	);
});

test('renderMail writes in en order; renderHelp stamps from the current English', () => {
	const mail = renderMail('// h\nexport const af = {};\n', { 'mail.a': 'A', 'mail.b': 'B' }, { 'mail.b': 'Bee' }, { 'mail.a': "'n A" });
	assert.equal(mail, `// h\nexport const af: Partial<Record<MailKey, string>> = {\n\t// A\n\t'mail.a': "'n A",\n\t// B\n\t'mail.b': 'Bee',\n};\n`);
	const out = renderHelp('// h\nexport const HELP_AF = {};\n', help, {}, { 'farm-dam': { term: 'Dam', short: 'Kort.', long: 'Lank.' } });
	assert.match(out, new RegExp(`sourceHash: '${helpHash(help[0])}'`));
	assert.match(out, /'farm-dam': \{\n\t\tterm: 'Dam',/);
});
