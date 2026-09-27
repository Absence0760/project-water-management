#!/usr/bin/env node
// The Afrikaans translation sheet (WP-2.5; docs/ui.md § Language):
// docs/i18n/af-translation-sheet.md lists every string a farmer can see that
// has no reviewed Afrikaans yet, with its English and where it appears, and
// an empty Afrikaans column for the client's translator.
//
//   node scripts/guards/i18n_sheet.mjs          write the sheet  (pnpm gen:i18n:sheet)
//   node scripts/guards/i18n_sheet.mjs --check  list what the translator has left, and exit 1 if the
//                                               sheet is out of date or a glossary translation is stale
//                                               (pnpm check:i18n)
//
// A glossary translation is stale when the English changed after it was made
// (its sourceHash no longer matches): once the translator has re-checked it,
// `pnpm gen:i18n:stamp <id>` (i18n_stamp.mjs) stamps it from the new English.
//
// A site translation is stale when its id is no longer a message's: the
// English it was made from changed (the id is a hash of the English,
// frontend/src/lib/i18n/msg.ts) or the message is gone. The changed English
// is back on the sheet under its new id; --check fails until the old entry
// leaves af.ts (translated again under the new id, or removed).
//
// Sources (TypeScript loaded through Node's type stripping, so they keep to
// erasable syntax and type-only imports):
//   frontend/src/**                             the farmer pages: every message, read from the
//                                               t() / tRich() / msg() / plural() calls (i18n_extract.mjs),
//                                               with frontend/src/lib/i18n/sheet.ts (sections, notes)
//   frontend/src/lib/i18n/messages/af.ts        their Afrikaans, by message id
//   backend/src/mail/i18n/{en,af}.ts            the farmer emails (a keyed catalogue: the server
//                                               ships no bundle, so its keys cost nothing)
//   frontend/src/lib/help/farmer.ts, content.af.ts  the farmer glossary (/farm/words)
//
// Written with the sheet: frontend/src/lib/i18n/messages/ids.generated.ts,
// every message's id (the tests use it to throw on a message the sheet
// doesn't list; the build keeps only the count, for "is Afrikaans complete").
//
// A string leaves the sheet when its Afrikaans lands in af.ts (or
// content.af.ts with a matching sourceHash). This script's --check (and
// i18n_sheet.test.mjs) check the sheet and the id list are exactly current.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extract, PLURAL_CATEGORIES } from './i18n_extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SHEET = 'docs/i18n/af-translation-sheet.md';
export const IDS = 'frontend/src/lib/i18n/messages/ids.generated.ts';

/** A markdown table cell: pipes escaped, line breaks as <br>. */
export function cell(s) {
	return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** The `{name}` placeholders in a message, sorted and unique. */
export function placeholders(s) {
	return [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** A key's section: its longest prefix in `sections` (the whole key, or up to a dot). */
export function sectionOf(key, sections) {
	let best = null;
	for (const p of Object.keys(sections)) {
		if ((key === p || key.startsWith(`${p}.`)) && (best == null || p.length > best.length)) best = p;
	}
	return best;
}

/** SHA-256 hex of a glossary entry's English, the stamp content.af.ts keeps (sourceHash). */
export function helpHash(e) {
	return createHash('sha256').update(`${e.term}\n${e.short}\n${e.long}`).digest('hex');
}

/**
 * The untranslated strings of one catalogue, grouped by section, in the
 * catalogue's own order: [{ section, description, rows: [{ key, english, context }] }].
 */
export function catalogueGroups({ en, af, sections, notes = {} }) {
	const groups = new Map();
	for (const [key, english] of Object.entries(en)) {
		if (af[key] != null) continue;
		const section = sectionOf(key, sections);
		if (!groups.has(section)) groups.set(section, { section, description: sections[section] ?? '', rows: [] });
		const ph = placeholders(english);
		const context = [notes[key], ph.length ? `Keep: ${ph.map((p) => `{${p}}`).join(', ')}` : null].filter(Boolean).join(' ');
		groups.get(section).rows.push({ key, english, context });
	}
	return [...groups.values()];
}

const keep = (texts) => {
	const ph = [...new Set(texts.flatMap(placeholders))].sort();
	return ph.length ? `Keep: ${ph.map((p) => `{${p}}`).join(', ')}` : null;
};

/** A site message has its Afrikaans: a string, or a counted word's forms with at least `other`. */
const translated = (m, af) => (m.kind === 'plural' ? af[m.id] != null && typeof af[m.id] === 'object' && af[m.id].other != null : typeof af[m.id] === 'string');

/**
 * The untranslated site messages (i18n_extract.mjs), grouped by section in
 * `sections` order, each in source order. A message's row is its id; a
 * counted word has a row per form (`<id>.one`, `<id>.other`).
 */
export function siteGroups({ messages, af, sections, notes = {} }) {
	const groups = new Map(Object.keys(sections).map((s) => [s, { section: s, description: sections[s], rows: [] }]));
	for (const m of messages.values()) {
		if (translated(m, af)) continue;
		const g = groups.get(m.section);
		const meaning = m.context ? `Meaning: ${m.context}. The same English elsewhere has its own row.` : null;
		if (m.kind === 'plural') {
			const forms = PLURAL_CATEGORIES.filter((c) => m.forms[c] != null);
			forms.forEach((c, i) => {
				const context = [i === 0 ? meaning : null, i === 0 ? notes[m.forms.other] : null, keep([m.forms[c]])].filter(Boolean).join(' ');
				g.rows.push({ key: `${m.id}.${c}`, english: m.forms[c], context });
			});
			continue;
		}
		g.rows.push({ key: m.id, english: m.english, context: [meaning, notes[m.english], keep([m.english])].filter(Boolean).join(' ') });
	}
	return [...groups.values()].filter((g) => g.rows.length);
}

/** af.ts ids that aren't a current message's: made from English that has since changed, or for a message that is gone. */
export function staleSite(messages, af) {
	return Object.keys(af).filter((id) => !messages.has(id));
}

/** The generated id list (IDS). */
export function renderIds(messages) {
	const ids = [...messages.keys()].sort();
	return [
		'// Generated by `pnpm gen:i18n:sheet` (scripts/guards/i18n_sheet.mjs); `pnpm check:i18n` fails when it drifts.',
		"// Every message's id (frontend/src/lib/i18n/msg.ts). The build keeps only the count (is a catalogue complete?);",
		"// dev and the tests use the list to throw on a message the translation sheet doesn't list.",
		`export const MESSAGE_COUNT = ${ids.length};`,
		'export const MESSAGE_IDS: readonly string[] = [',
		...ids.map((id, i) => `\t'${id}'${i < ids.length - 1 ? ',' : ''}`),
		'];',
		''
	].join('\n');
}

/** The farmer glossary entries with no current Afrikaans (missing, or made from older English). */
export function helpGroup(help, helpAf) {
	const rows = [];
	for (const e of help.filter((h) => h.category === 'farmer')) {
		const af = helpAf[e.id];
		if (af && af.sourceHash === helpHash(e)) continue;
		const stale = af ? ' The English changed after the last translation; please check it again.' : '';
		// The stamp goes into content.af.ts with the translation (sourceHash).
		rows.push({ key: `help.${e.id}.term`, english: e.term, context: `The entry’s title.${stale} (For the developer: sourceHash ${helpHash(e)}.)` });
		rows.push({ key: `help.${e.id}.short`, english: e.short, context: 'One sentence, shown first (at most 140 characters).' });
		rows.push({ key: `help.${e.id}.long`, english: e.long, context: 'The fuller explanation; <br><br> is a new paragraph.' });
	}
	return { section: 'help', description: 'The glossary, “What do these words mean?”, linked from every farm page. Plain words for farmers.', rows };
}

/** Farmer glossary ids whose Afrikaans was made from older English (sourceHash no longer matches). */
export function staleHelp(help, helpAf) {
	return help.filter((e) => e.category === 'farmer' && helpAf[e.id] && helpAf[e.id].sourceHash !== helpHash(e)).map((e) => e.id);
}

/** Farmer glossary ids with no Afrikaans at all. */
export function missingHelp(help, helpAf) {
	return help.filter((e) => e.category === 'farmer' && !helpAf[e.id]).map((e) => e.id);
}

/** What `check:i18n` prints for the translator and the developer: untranslated counts, then stale glossary entries. */
export function report({ site, mail, help, helpAf, staleSiteIds = [], problems = [] }) {
	const count = (groups) => groups.reduce((n, g) => n + g.rows.length, 0);
	const stale = staleHelp(help, helpAf);
	const lines = [
		`No Afrikaans yet: ${count(site)} site strings, ${count(mail)} email strings, ${missingHelp(help, helpAf).length} glossary entries (all on ${SHEET}).`
	];
	if (problems.length) lines.push("Messages the sheet can't list:", ...problems.map((p) => `  ${p}`));
	if (staleSiteIds.length) {
		lines.push(`Stale site translations in frontend/src/lib/i18n/messages/af.ts (no message has these ids any more: the English changed, and is on the sheet again under a new id, or the message is gone): ${staleSiteIds.join(', ')}.`);
		lines.push("Move each translation to its message's new id once the translator has checked it against the new English, or delete it.");
	}
	if (stale.length) {
		lines.push(`Stale glossary translations (the English changed after they were made; on the sheet again): ${stale.join(', ')}.`);
		lines.push('Once the translator has re-checked each one (and any fix is in content.af.ts), run pnpm gen:i18n:stamp <id>.');
	}
	return { text: lines.join('\n'), stale: [...stale, ...staleSiteIds], problems };
}

export function renderSheet(parts) {
	const all = parts.flatMap((p) => p.groups.flatMap((g) => g.rows));
	const lines = [
		'# Afrikaans translation sheet',
		'',
		'<!-- Generated by `pnpm gen:i18n:sheet` (scripts/guards/i18n_sheet.mjs). Don’t edit by hand: `pnpm check:i18n` and the catalogue tests fail when it drifts. -->',
		'',
		'Every string a farmer can see in the app that has no Afrikaans yet (roadmap WP-2.5). Until a string',
		'is translated, the app shows it in English. The **Afrikaans** column is filled in by a translator, or by the',
		'af-translator agent from `pnpm gen:i18n:export` and checked by the af-checker agent (.claude/agents/i18n/);',
		'`pnpm gen:i18n:apply` then writes each line into its catalogue by its **Id**, and the line leaves this sheet.',
		"A site string's id is made from its English: if the English changes, the string comes back with a new id.",
		'',
		'How to write the Afrikaans:',
		'',
		'- Keep every `{name}` placeholder as it is (the app fills it in: a number, a date, a farm name). You may move it.',
		'- Keep `**` round the words that should stay bold.',
		'- Ids ending in `.one` / `.other` are the singular and plural of one word; `.two` / `.few` are ordinal forms.',
		'- A row whose context starts **Meaning:** has English that means something else elsewhere; each has its own row, so they can be worded differently.',
		'- The farm pages use plain words, not a modeller’s; `docs/design/farmer-view.md` §5.1 lists the words to use and the ones to avoid, with a first draft in Afrikaans for the reviewer.',
		'- Numbers, dates and units are formatted by the app; don’t translate them.',
		'',
		`${all.length} strings: ${parts.map((p) => `${p.groups.reduce((n, g) => n + g.rows.length, 0)} ${p.name}`).join(', ')}.`,
		''
	];
	for (const part of parts) {
		if (!part.groups.some((g) => g.rows.length)) continue;
		lines.push(`## ${part.title}`, '');
		for (const g of part.groups) {
			if (!g.rows.length) continue;
			lines.push(`### ${g.section}`, '', g.description, '', '| Id | English | Context | Afrikaans |', '| --- | --- | --- | --- |');
			for (const r of g.rows) lines.push(`| \`${r.key}\` | ${cell(r.english)} | ${cell(r.context)} |  |`);
			lines.push('');
		}
	}
	return lines.join('\n');
}

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

export async function sources() {
	const [sheet, siteAf, mailEn, mailAf, help, helpAf] = await Promise.all([
		load('frontend/src/lib/i18n/sheet.ts'),
		load('frontend/src/lib/i18n/messages/af.ts'),
		load('backend/src/mail/i18n/en.ts'),
		load('backend/src/mail/i18n/af.ts'),
		load('frontend/src/lib/help/farmer.ts'),
		load('frontend/src/lib/help/content.af.ts')
	]);
	const { messages, problems } = extract({ sections: Object.keys(sheet.SECTIONS) });
	return {
		messages,
		problems,
		staleSiteIds: staleSite(messages, siteAf.af),
		site: siteGroups({ messages, af: siteAf.af, sections: sheet.SECTIONS, notes: sheet.NOTES }),
		mail: catalogueGroups({ en: mailEn.en, af: mailAf.af, sections: mailEn.sections, notes: mailEn.notes }),
		help: help.FARMER_HELP,
		helpAf: helpAf.HELP_AF
	};
}

const sheetOf = (s) =>
	renderSheet([
		{ name: 'on the site', title: 'The site (farm pages, sign-in pages, account)', groups: s.site },
		{ name: 'in emails', title: 'Emails', groups: s.mail },
		{ name: 'in the glossary', title: 'Glossary', groups: [helpGroup(s.help, s.helpAf)] }
	]);

export async function buildSheet() {
	return sheetOf(await sources());
}

/** The id list and the sheet, as the committed files should read. */
export async function buildAll() {
	const src = await sources();
	return { src, sheet: sheetOf(src), ids: renderIds(src.messages) };
}

const read = (rel) => {
	try {
		return readFileSync(path.join(ROOT, rel), 'utf8');
	} catch {
		return ''; // missing: out of date
	}
};

async function main() {
	const { src, sheet, ids } = await buildAll();
	if (process.argv.includes('--check')) {
		const { text, stale, problems } = report(src);
		console.log(text);
		let failed = stale.length > 0 || problems.length > 0;
		for (const [file, want] of [
			[SHEET, sheet],
			[IDS, ids]
		]) {
			if (read(file) !== want) {
				console.error(`${file} is out of date: run pnpm gen:i18n:sheet and commit it.`);
				failed = true;
			} else console.log(`${file} is current.`);
		}
		if (failed) process.exit(1);
		return;
	}
	if (src.problems.length) {
		console.error(`Messages the sheet can't list:\n${src.problems.map((p) => `  ${p}`).join('\n')}`);
		process.exit(1);
	}
	writeFileSync(path.join(ROOT, SHEET), sheet);
	writeFileSync(path.join(ROOT, IDS), ids);
	console.log(`wrote ${SHEET} and ${IDS}`);
	if (src.staleSiteIds.length) console.warn(report(src).text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
