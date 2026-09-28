import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	addMailCatalogueEntry,
	batches,
	literal,
	newHelpSource,
	newMailSource,
	newSiteSource,
	plan,
	renderHelp,
	renderMail,
	renderSite,
	sheetRows
} from './i18n_apply.mjs';
import { commonSources, helpHash, sources } from './i18n_sheet.mjs';
import { makeFixture } from './i18n_fixture.mjs';

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

test('literal quotes apostrophes and escapes newlines', () => {
	assert.equal(literal("'n Dam"), `"'n Dam"`);
	assert.equal(literal(`He said "hi" and 'n`), `'He said "hi" and \\'n'`);
	assert.equal(literal('a\nb'), `'a\\nb'`);
	assert.equal(eval(literal("'n \"x\"\n")), "'n \"x\"\n");
});

test('renderSite keeps the header and writes entries in message order, English above each, for the given language’s export name', () => {
	const out = renderSite('// header\nimport type { Catalogue } from "../locale.svelte";\n\nexport const af: Catalogue = {};\n', 'af', src.messages, { [text.id]: 'Ou' }, { [plural.id]: { one: '{n} dag', other: '{n} dae' } });
	assert.equal(
		out,
		`// header\nimport type { Catalogue } from "../locale.svelte";\n\nexport const af: Catalogue = {\n\t// {n} day / {n} days\n\t'${plural.id}': { one: '{n} dag', other: '{n} dae' },\n\t// About **{pct}** of it\n\t'${text.id}': 'Ou',\n};\n`
	);
});

test('renderMail writes in en order; renderHelp stamps from the current English', () => {
	const mail = renderMail('// h\nexport const af = {};\n', 'af', { 'mail.a': 'A', 'mail.b': 'B' }, { 'mail.b': 'Bee' }, { 'mail.a': "'n A" });
	assert.equal(mail, `// h\nexport const af: Partial<Record<MailKey, string>> = {\n\t// A\n\t'mail.a': "'n A",\n\t// B\n\t'mail.b': 'Bee',\n};\n`);
	const out = renderHelp('// h\nexport const HELP_AF = {};\n', 'af', help, {}, { 'farm-dam': { term: 'Dam', short: 'Kort.', long: 'Lank.' } });
	assert.match(out, new RegExp(`sourceHash: '${helpHash(help[0])}'`));
	assert.match(out, /'farm-dam': \{\n\t\tterm: 'Dam',/);
});

test('addMailCatalogueEntry adds an import and a CATALOGUES entry once, and is a no-op if the language is already there', () => {
	const source = "import { af } from './af.js';\nimport type { MailKey } from './en.js';\n\nexport type MailCatalogue = Partial<Record<MailKey, string>>;\n\nexport const CATALOGUES: Readonly<Record<string, MailCatalogue>> = { af };\n";
	const out = addMailCatalogueEntry(source, 'xx');
	assert.match(out, /import \{ xx \} from '\.\/xx\.js';/);
	assert.match(out, /CATALOGUES: Readonly<Record<string, MailCatalogue>> = \{ af, xx \};/);
	assert.equal(addMailCatalogueEntry(source, 'af'), source);
	assert.equal(addMailCatalogueEntry(out, 'xx'), out);
});

// ---- A stand-in language, end to end, against a throwaway repo (never committed as a real catalogue) ----

test('a brand-new language’s catalogues, once written, are read back as translated', async () => {
	const XX = { code: 'xx', name: 'Xx (stand-in, never shipped)' };
	const before = makeFixture();
	try {
		const common = await commonSources(before.root);
		const src1 = await sources('xx', common);
		const [msg] = src1.site[0].rows;
		const translations = { [msg.key]: 'XX: stand-in message', 'mail.hello': 'XX: hello {name}', 'help.stand-in-word.term': 'XX term', 'help.stand-in-word.short': 'XX short.', 'help.stand-in-word.long': 'XX long.' };
		const { site, mail, help: helpPlan, problems } = plan(src1, translations);
		assert.deepEqual(problems, []);

		const siteSrc = renderSite(newSiteSource(XX), XX.code, src1.messages, {}, site);
		const mailSrc = renderMail(newMailSource(XX), XX.code, common.mailEn.en, {}, mail);
		const helpSrc = renderHelp(newHelpSource(XX), XX.code, src1.help, {}, helpPlan);
		assert.match(siteSrc, /export const xx: Catalogue = \{/);
		assert.match(mailSrc, /export const xx: Partial<Record<MailKey, string>> = \{/);
		assert.match(helpSrc, /export const HELP_XX: Record<string, HelpTranslation> = \{/);
		assert.match(helpSrc, /import type \{ HelpTranslation \} from '\.\/types';/);

		// A *different* fixture root, so this is the first time these exact paths are
		// imported in this process (no risk of reading the pre-write module from cache).
		const after = makeFixture({
			'frontend/src/lib/i18n/messages/xx.ts': siteSrc,
			'backend/src/mail/i18n/xx.ts': mailSrc,
			'frontend/src/lib/help/content.xx.ts': helpSrc
		});
		try {
			const common2 = await commonSources(after.root);
			const src2 = await sources('xx', common2);
			assert.equal(src2.site.length, 0);
			assert.equal(src2.mail.length, 0);
			assert.equal(src2.helpAf['stand-in-word']?.term, 'XX term');
		} finally {
			after.cleanup();
		}
	} finally {
		before.cleanup();
	}
});
