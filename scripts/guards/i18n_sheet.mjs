#!/usr/bin/env node
// One translation sheet per language (WP-2.5; docs/ui.md § Language; issue
// #58): docs/i18n/<code>-translation-sheet.md lists every string a farmer
// can see that has no reviewed translation yet in that language, with its
// English and where it appears, and an empty column for the client's
// translator.
//
//   node scripts/guards/i18n_sheet.mjs [lang...]          write the sheet(s)  (pnpm gen:i18n:sheet)
//   node scripts/guards/i18n_sheet.mjs --check [lang...]  list what the translator has left, and exit 1 if a
//                                                          sheet is out of date or a glossary translation is stale
//                                                          (pnpm check:i18n)
//
// With no language given: every non-English language in
// packages/engine/src/languages.ts (LANGUAGES) — the one table, so adding a
// language needs no change here. A language whose site, email or glossary
// catalogue file doesn't exist yet is treated as an empty one: its sheet
// lists everything.
//
// A glossary translation is stale when the English changed after it was made
// (its sourceHash no longer matches): once the translator has re-checked it,
// `pnpm gen:i18n:stamp <lang> <id>` (i18n_stamp.mjs) stamps it from the new
// English.
//
// A site translation is stale when its id is no longer a message's: the
// English it was made from changed (the id is a hash of the English,
// frontend/src/lib/i18n/msg.ts) or the message is gone. The changed English
// is back on the sheet under its new id; --check fails until the old entry
// leaves the catalogue (translated again under the new id, or removed).
//
// Sources (TypeScript loaded through Node's type stripping, so they keep to
// erasable syntax and type-only imports):
//   packages/engine/src/languages.ts             the one language table (LANGUAGES, DEFAULT_LOCALE)
//   frontend/src/**                              the farmer pages: every message, read from the
//                                                t() / tRich() / msg() / plural() calls (i18n_extract.mjs),
//                                                with frontend/src/lib/i18n/sheet.ts (sections, notes)
//   frontend/src/lib/i18n/messages/<code>.ts     a language's site words, by message id
//   backend/src/mail/i18n/{en,<code>}.ts         the farmer emails (a keyed catalogue: the server
//                                                ships no bundle, so its keys cost nothing)
//   frontend/src/lib/help/farmer.ts, content.<code>.ts  the farmer glossary (/farm/words)
//
// Written with the sheets: frontend/src/lib/i18n/messages/ids.generated.ts,
// every message's id (the tests use it to throw on a message the sheet
// doesn't list; the build keeps only the count, for "is a catalogue
// complete"). It doesn't depend on which language, so it's written once
// however many languages are given.
//
// A string leaves a language's sheet once its words land in that language's
// site/mail catalogue (or content.<code>.ts, with a matching sourceHash).
// This script's --check (and i18n_sheet.test.mjs) check every requested
// sheet and the id list are exactly current.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extract, PLURAL_CATEGORIES } from './i18n_extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LANGUAGES_FILE = 'packages/engine/src/languages.ts';
export const IDS = 'frontend/src/lib/i18n/messages/ids.generated.ts';

/** Where docs/i18n/<code>-translation-sheet.md lives for a language code. */
export const sheetPath = (code) => `docs/i18n/${code}-translation-sheet.md`;

/** Where a language's catalogues live, by the convention shared with the app code (issue #58). */
export const catalogueFiles = (code) => ({
	site: `frontend/src/lib/i18n/messages/${code}.ts`,
	mail: `backend/src/mail/i18n/${code}.ts`,
	help: `frontend/src/lib/help/content.${code}.ts`
});

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

/** SHA-256 hex of a glossary entry's English, the stamp content.<code>.ts keeps (sourceHash). */
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

/** A site message has its words: a string, or a counted word's forms with at least `other`. */
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

/** A language's catalogue ids that aren't a current message's: made from English that has since changed, or for a message that is gone. */
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

/** The farmer glossary entries with no current translation (missing, or made from older English). */
export function helpGroup(help, helpAf) {
	const rows = [];
	for (const e of help.filter((h) => h.category === 'farmer')) {
		const af = helpAf[e.id];
		if (af && af.sourceHash === helpHash(e)) continue;
		const stale = af ? ' The English changed after the last translation; please check it again.' : '';
		// The stamp goes into content.<code>.ts with the translation (sourceHash).
		rows.push({ key: `help.${e.id}.term`, english: e.term, context: `The entry’s title.${stale} (For the developer: sourceHash ${helpHash(e)}.)` });
		rows.push({ key: `help.${e.id}.short`, english: e.short, context: 'One sentence, shown first (at most 140 characters).' });
		rows.push({ key: `help.${e.id}.long`, english: e.long, context: 'The fuller explanation; <br><br> is a new paragraph.' });
	}
	return { section: 'help', description: 'The glossary, “What do these words mean?”, linked from every farm page. Plain words for farmers.', rows };
}

/** Farmer glossary ids whose translation was made from older English (sourceHash no longer matches). */
export function staleHelp(help, helpAf) {
	return help.filter((e) => e.category === 'farmer' && helpAf[e.id] && helpAf[e.id].sourceHash !== helpHash(e)).map((e) => e.id);
}

/** Farmer glossary ids with no translation at all. */
export function missingHelp(help, helpAf) {
	return help.filter((e) => e.category === 'farmer' && !helpAf[e.id]).map((e) => e.id);
}

/** What `check:i18n` prints for the translator and the developer, for one language: untranslated counts, then stale glossary entries. */
export function report({ site, mail, help, helpAf, staleSiteIds = [], problems = [] }) {
	const count = (groups) => groups.reduce((n, g) => n + g.rows.length, 0);
	const stale = staleHelp(help, helpAf);
	const lines = [`No words yet: ${count(site)} site strings, ${count(mail)} email strings, ${missingHelp(help, helpAf).length} glossary entries.`];
	if (problems.length) lines.push("Messages the sheet can't list:", ...problems.map((p) => `  ${p}`));
	if (staleSiteIds.length) {
		lines.push(`Stale site translations (no message has these ids any more: the English changed, and is on the sheet again under a new id, or the message is gone): ${staleSiteIds.join(', ')}.`);
		lines.push("Move each translation to its message's new id once the translator has checked it against the new English, or delete it.");
	}
	if (stale.length) {
		lines.push(`Stale glossary translations (the English changed after they were made; on the sheet again): ${stale.join(', ')}.`);
		lines.push('Once the translator has re-checked each one, run pnpm gen:i18n:stamp <lang> <id>.');
	}
	return { text: lines.join('\n'), stale: [...stale, ...staleSiteIds], problems };
}

/** The sheet's three parts (site, emails, glossary), for one language's sources. */
export function sheetParts(src) {
	return [
		{ name: 'on the site', title: 'The site (farm pages, sign-in pages, account)', groups: src.site },
		{ name: 'in emails', title: 'Emails', groups: src.mail },
		{ name: 'in the glossary', title: 'Glossary', groups: [helpGroup(src.help, src.helpAf)] }
	];
}

/** The translation sheet's markdown, for `lang` ({ code, name }) and its three parts. */
export function renderSheet(lang, parts) {
	const all = parts.flatMap((p) => p.groups.flatMap((g) => g.rows));
	const lines = [
		`# ${lang.name} translation sheet`,
		'',
		`<!-- Generated by \`pnpm gen:i18n:sheet ${lang.code}\` (scripts/guards/i18n_sheet.mjs). Don’t edit by hand: \`pnpm check:i18n\` and the catalogue tests fail when it drifts. -->`,
		'',
		`Every string a farmer can see in the app that has no ${lang.name} yet (roadmap WP-2.5; issue #58). Until a`,
		`string is translated, the app shows it in English. The **${lang.name}** column is filled in by a translator,`,
		'or by the i18n-translator agent from `pnpm gen:i18n:export ' + lang.code + ' <dir>` and checked by the',
		'i18n-checker agent (.claude/agents/i18n/); `pnpm gen:i18n:apply ' + lang.code + ' <translations.json>` then',
		'writes each line into its catalogue by its **Id**, and the line leaves this sheet.',
		"A site string's id is made from its English: if the English changes, the string comes back with a new id.",
		'',
		`How to write the ${lang.name}:`,
		'',
		'- Keep every `{name}` placeholder as it is (the app fills it in: a number, a date, a farm name). You may move it.',
		'- Keep `**` round the words that should stay bold.',
		'- Ids ending in `.one` / `.other` are the singular and plural of one word; `.two` / `.few` are ordinal forms.',
		'- A row whose context starts **Meaning:** has English that means something else elsewhere; each has its own row, so they can be worded differently.',
		'- The farm pages use plain words, not a modeller’s; `docs/design/farmer-view.md` §5.1 lists the words to use and the ones to avoid.',
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
			lines.push(`### ${g.section}`, '', g.description, '', '| Id | English | Context | ' + lang.name + ' |', '| --- | --- | --- | --- |');
			for (const r of g.rows) lines.push(`| \`${r.key}\` | ${cell(r.english)} | ${cell(r.context)} |  |`);
			lines.push('');
		}
	}
	return lines.join('\n');
}

const load = (root) => (rel) => import(pathToFileURL(path.join(root, rel)).href);

/** A module's named export, or `fallback` when the file doesn't exist yet (a language with no catalogue there yet). */
async function loadCatalogue(loadFrom, rel, key, fallback) {
	try {
		const mod = await loadFrom(rel);
		return mod[key] ?? fallback;
	} catch (e) {
		if (e?.code === 'ERR_MODULE_NOT_FOUND') return fallback;
		throw e;
	}
}

/** packages/engine/src/languages.ts's LANGUAGES table and its DEFAULT_LOCALE (never translated, so it needs no sheet). */
export async function allLanguages(root = ROOT) {
	const { LANGUAGES, DEFAULT_LOCALE } = await load(root)(LANGUAGES_FILE);
	return { LANGUAGES, DEFAULT_LOCALE };
}

/** Every language that needs a translation sheet: every language but the fallback, in table order. */
export async function translatedLanguages(root = ROOT) {
	const { LANGUAGES, DEFAULT_LOCALE } = await allLanguages(root);
	return LANGUAGES.filter((l) => l.code !== DEFAULT_LOCALE);
}

/** `code`'s row in the language table (throws when it isn't there — not a language the app supports). */
export async function resolveLanguage(code, root = ROOT) {
	const { LANGUAGES } = await allLanguages(root);
	const lang = LANGUAGES.find((l) => l.code === code);
	if (!lang) throw new Error(`"${code}" isn't in ${LANGUAGES_FILE}`);
	return lang;
}

/**
 * Everything that doesn't depend on which language: the frontend's messages
 * (and any problems reading them), the sheet's sections/notes, the emails'
 * English, and the glossary source. Share one of these across every language
 * in a run instead of re-reading and re-extracting per language.
 */
export async function commonSources(root = ROOT) {
	const l = load(root);
	const [sheet, mailEn, help] = await Promise.all([l('frontend/src/lib/i18n/sheet.ts'), l('backend/src/mail/i18n/en.ts'), l('frontend/src/lib/help/farmer.ts')]);
	const { messages, problems } = extract({ root, sections: Object.keys(sheet.SECTIONS) });
	return { root, sheet, mailEn, help, messages, problems };
}

/**
 * One language's untranslated strings: { code, messages, problems,
 * staleSiteIds, site, mail, help, helpAf }. `common` is commonSources()'s
 * result (shared across languages in one run; computed here when omitted). A
 * language whose site, mail or glossary catalogue file doesn't exist yet is
 * treated as an empty one: its sheet lists everything.
 */
export async function sources(code, common) {
	common ??= await commonSources();
	const { root, sheet, mailEn, help, messages, problems } = common;
	const files = catalogueFiles(code);
	const l = load(root);
	const [siteCat, mailCat, helpCat] = await Promise.all([
		loadCatalogue(l, files.site, code, {}),
		loadCatalogue(l, files.mail, code, {}),
		loadCatalogue(l, files.help, `HELP_${code.toUpperCase()}`, {})
	]);
	return {
		code,
		messages,
		problems,
		staleSiteIds: staleSite(messages, siteCat),
		site: siteGroups({ messages, af: siteCat, sections: sheet.SECTIONS, notes: sheet.NOTES }),
		mail: catalogueGroups({ en: mailEn.en, af: mailCat, sections: mailEn.sections, notes: mailEn.notes }),
		help: help.FARMER_HELP,
		helpAf: helpCat
	};
}

/** `lang`'s sheet markdown, from its sources. */
export function sheetOf(lang, src) {
	return renderSheet(lang, sheetParts(src));
}

/** `lang`'s sources, sheet and (once, language-independent) the id list. */
export async function buildAll(lang, common) {
	common ??= await commonSources();
	const src = await sources(lang.code, common);
	return { src, sheet: sheetOf(lang, src), ids: renderIds(common.messages) };
}

const read = (rel, root = ROOT) => {
	try {
		return readFileSync(path.join(root, rel), 'utf8');
	} catch {
		return ''; // missing: out of date
	}
};

async function main() {
	const args = process.argv.slice(2);
	const check = args.includes('--check');
	const requested = args.filter((a) => !a.startsWith('--'));
	const { LANGUAGES, DEFAULT_LOCALE } = await allLanguages();
	for (const code of requested) if (!LANGUAGES.some((l) => l.code === code)) throw new Error(`"${code}" isn't in ${LANGUAGES_FILE}`);
	const langs = requested.length ? requested.map((code) => LANGUAGES.find((l) => l.code === code)) : LANGUAGES.filter((l) => l.code !== DEFAULT_LOCALE);

	const common = await commonSources();
	if (common.problems.length && !check) {
		console.error(`Messages the sheet can't list:\n${common.problems.map((p) => `  ${p}`).join('\n')}`);
		process.exit(1);
	}
	const ids = renderIds(common.messages);

	if (check) {
		let failed = common.problems.length > 0;
		if (common.problems.length) console.error(`Messages the sheet can't list:\n${common.problems.map((p) => `  ${p}`).join('\n')}`);
		for (const lang of langs) {
			const src = await sources(lang.code, common);
			console.log(`${lang.name} (${lang.code}): ${report(src).text}`);
			if (report(src).stale.length) failed = true;
			const sheet = sheetOf(lang, src);
			if (read(sheetPath(lang.code)) !== sheet) {
				console.error(`${sheetPath(lang.code)} is out of date: run pnpm gen:i18n:sheet ${lang.code} and commit it.`);
				failed = true;
			} else console.log(`${sheetPath(lang.code)} is current.`);
		}
		if (read(IDS) !== ids) {
			console.error(`${IDS} is out of date: run pnpm gen:i18n:sheet and commit it.`);
			failed = true;
		} else console.log(`${IDS} is current.`);
		if (failed) process.exit(1);
		return;
	}

	writeFileSync(path.join(ROOT, IDS), ids);
	for (const lang of langs) {
		const src = await sources(lang.code, common);
		writeFileSync(path.join(ROOT, sheetPath(lang.code)), sheetOf(lang, src));
		console.log(`wrote ${sheetPath(lang.code)}`);
		if (src.staleSiteIds.length) console.warn(report(src).text);
	}
	console.log(`wrote ${IDS}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
