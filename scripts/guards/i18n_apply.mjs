#!/usr/bin/env node
// Move a translation sheet's strings out for translation, and returned words
// back into a language's catalogues (WP-2.5; docs/ui.md § Language; issue #58).
//
//   node scripts/guards/i18n_apply.mjs --export <lang> <dir> [--batches N]   (pnpm gen:i18n:export)
//   node scripts/guards/i18n_apply.mjs <lang> <translations.json> …          (pnpm gen:i18n:apply)
//
// `<lang>` is a code from packages/engine/src/languages.ts (LANGUAGES); the
// script refuses one that isn't there.
//
// --export writes every row still on that language's sheet
// (docs/i18n/<lang>-translation-sheet.md) as N JSON batches (`batch-1.json`
// …, default 5), each an array of { id, english, context, section,
// sectionNote }, split at section boundaries: the input the i18n-translator
// agent (.claude/agents/i18n/) or a human translator's tooling works from. A
// newline in the English is "\n".
//
// Apply takes one or more JSON objects of sheet Id → words (later files win,
// so a checker's corrections go last) and writes each into its catalogue:
//
//   <8-hex id>, <id>.<form>          frontend/src/lib/i18n/messages/<lang>.ts
//   mail.…                          backend/src/mail/i18n/<lang>.ts
//   help.<entry>.term|short|long    frontend/src/lib/help/content.<lang>.ts, stamped
//                                   with the current English's sourceHash
//
// then rewrites that language's sheet and the (language-independent) id
// list (the entries leave the sheet). It refuses the whole set, writing
// nothing, when an id isn't on the sheet, a translation drops or adds a
// {placeholder} or changes the number of ** bold marks, a counted word lacks
// one of its forms, or a glossary entry lacks its term, short or long.
// Existing translations are kept unless the input replaces them.
//
// A language with no catalogue file yet gets one, from a small boilerplate
// header (newSiteSource / newMailSource / newHelpSource below). The site and
// glossary catalogues are found by file name (import.meta.glob), so they
// need no other wiring; a brand new email catalogue also gets its line
// added to backend/src/mail/i18n/catalogues.ts (a Lambda bundle can't glob),
// or, if that file doesn't exist in the current worktree, this prints the
// instruction instead.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogueFiles, helpGroup, helpHash, resolveLanguage, sheetPath, sources } from './i18n_sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
const bolds = (s) => (s.match(/\*\*/g) ?? []).length;

/** Every row still on the sheet, in sheet order: [{ id, english, context, section, sectionNote }]. */
export function sheetRows(src) {
	const groups = [...src.site, ...src.mail, helpGroup(src.help, src.helpAf)];
	return groups.flatMap((g) => g.rows.map((r) => ({ id: r.key, english: r.english, context: r.context, section: g.section, sectionNote: g.description })));
}

/** `rows` in `n` batches of about equal size, never splitting a section. */
export function batches(rows, n) {
	const target = Math.ceil(rows.length / n);
	const out = [[]];
	for (let i = 0; i < rows.length; i++) {
		const cur = out[out.length - 1];
		if (cur.length >= target && rows[i].section !== rows[i - 1].section && out.length < n) out.push([]);
		out[out.length - 1].push(rows[i]);
	}
	return out.filter((b) => b.length);
}

/** A JS string literal: single quotes, or double when the text has an apostrophe (e.g. Afrikaans 'n) and no double quote. */
export function literal(s) {
	const esc = (q) => s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n');
	return s.includes("'") && !s.includes('"') ? `"${esc('"')}"` : `'${esc("'")}'`;
}
const comment = (english) => `// ${english.replace(/\n/g, ' ⏎ ')}`;

/**
 * The checked translations, split by catalogue: { site, mail, help, problems }.
 * `site` is id → string | forms, `mail` key → string, `help` entry id → { term, short, long }.
 */
export function plan(src, translations) {
	const rows = new Map(sheetRows(src).map((r) => [r.id, r]));
	const problems = [];
	const site = {};
	const mail = {};
	const help = {};
	for (const [id, af] of Object.entries(translations)) {
		const row = rows.get(id);
		if (!row) {
			problems.push(`${id}: not on the sheet (already translated, or no such string)`);
			continue;
		}
		if (typeof af !== 'string' || !af.trim()) {
			problems.push(`${id}: empty translation`);
			continue;
		}
		if (placeholders(af) !== placeholders(row.english)) problems.push(`${id}: placeholders {${placeholders(af)}} but the English has {${placeholders(row.english)}}`);
		if (bolds(af) !== bolds(row.english)) problems.push(`${id}: ${bolds(af) / 2} bold pairs but the English has ${bolds(row.english) / 2}`);
		const help_ = /^help\.(.+)\.(term|short|long)$/.exec(id);
		if (help_) (help[help_[1]] ??= {})[help_[2]] = af;
		else if (id.startsWith('mail.')) mail[id] = af;
		else {
			const [msgId, form] = id.split('.');
			if (form) (site[msgId] ??= {})[form] = af;
			else site[msgId] = af;
		}
	}
	for (const [id, parts] of Object.entries(help)) {
		const missing = ['term', 'short', 'long'].filter((p) => parts[p] == null);
		if (missing.length) problems.push(`help.${id}: no ${missing.join(', ')} (a glossary entry is translated whole)`);
	}
	for (const [id, v] of Object.entries(site)) {
		if (typeof v !== 'object') continue;
		const m = src.messages.get(id);
		const missing = Object.keys(m.forms).filter((c) => m.forms[c] != null && v[c] == null);
		if (missing.length) problems.push(`${id}: no ${missing.join(', ')} form (a counted word is translated whole)`);
	}
	return { site, mail, help, problems };
}

const headerOf = (source, marker) => {
	const i = source.indexOf(marker);
	if (i < 0) throw new Error(`no "${marker}" to write after`);
	return source.slice(0, i);
};

/** A language's site catalogue: the existing entries plus `add`, in the extractor's message order, each with its English above it. */
export function renderSite(source, code, messages, existing, add) {
	const all = { ...existing, ...add };
	const lines = [];
	for (const m of messages.values()) {
		const v = all[m.id];
		if (v == null) continue;
		if (m.kind === 'plural') {
			const forms = Object.keys(m.forms).filter((c) => m.forms[c] != null);
			lines.push(`\t${comment(forms.map((c) => m.forms[c]).join(' / '))}`);
			lines.push(`\t'${m.id}': { ${forms.map((c) => `${c}: ${literal(v[c])}`).join(', ')} },`);
		} else {
			lines.push(`\t${comment(m.english)}${m.context ? ` (${m.context})` : ''}`);
			lines.push(`\t'${m.id}': ${literal(v)},`);
		}
	}
	const marker = `export const ${code}`;
	return `${headerOf(source, marker)}${marker}: Catalogue = {\n${lines.join('\n')}\n};\n`;
}

/** A language's backend email catalogue: the existing entries plus `add`, in en.ts's order. */
export function renderMail(source, code, en, existing, add) {
	const all = { ...existing, ...add };
	const lines = Object.keys(en)
		.filter((k) => all[k] != null)
		.flatMap((k) => [`\t${comment(en[k])}`, `\t'${k}': ${literal(all[k])},`]);
	const marker = `export const ${code}`;
	return `${headerOf(source, marker)}${marker}: Partial<Record<MailKey, string>> = {\n${lines.join('\n')}\n};\n`;
}

/** A language's glossary catalogue: the existing entries plus `add` (stamped from the current English), in farmer.ts's order. */
export function renderHelp(source, code, farmerHelp, existing, add) {
	const all = { ...existing };
	for (const [id, parts] of Object.entries(add)) all[id] = { ...parts, sourceHash: helpHash(farmerHelp.find((e) => e.id === id)) };
	const entries = farmerHelp
		.filter((e) => all[e.id])
		.map((e) => {
			const a = all[e.id];
			return [`\t${literal(e.id)}: {`, `\t\tterm: ${literal(a.term)},`, `\t\tshort: ${literal(a.short)},`, `\t\tlong: ${literal(a.long)},`, `\t\tsourceHash: '${a.sourceHash}'`, '\t},'].join('\n');
		});
	const marker = `export const HELP_${code.toUpperCase()}`;
	return `${headerOf(source, marker)}${marker}: Record<string, HelpTranslation> = {\n${entries.join('\n')}\n};\n`;
}

/** A brand new site catalogue file for a language with none yet. */
export function newSiteSource(lang) {
	return `// ${lang.name} wording of the farmer surfaces (WP-2.5; issue #58). Only
// checked text goes here: the words go to real farmers. A message with no
// entry shows in English, and it is on ${sheetPath(lang.code)}, the sheet
// the translator fills in.
//
// Each entry is keyed by the message's id, the Id column of the sheet (a
// hash of the English, $lib/i18n/msg.ts), with the English in a comment
// above it. New wording goes in with \`pnpm gen:i18n:apply ${lang.code}
// <id → words .json>\` (checked, then written here in message order), or by
// hand followed by \`pnpm gen:i18n:sheet ${lang.code}\` to take it off the
// sheet. If the English later changes, its id changes: the old entry is
// stale until it is translated again under the new id.
//
// Loaded lazily, only for someone who picks ${lang.name}. Only type
// imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { Catalogue } from '../locale.svelte';

export const ${lang.code}: Catalogue = {};
`;
}

/** A brand new backend email catalogue file for a language with none yet. */
export function newMailSource(lang) {
	return `// ${lang.name} wording of the farmer emails (WP-2.5; issue #58). Only
// checked text goes here. A key with no entry is sent in English, and it
// must be on ${sheetPath(lang.code)}, which is what the translator fills
// in. Add returned wording with \`pnpm gen:i18n:apply ${lang.code}\`, or by
// hand and then \`pnpm gen:i18n:sheet ${lang.code}\`.
//
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { MailKey } from './en.js';

export const ${lang.code}: Partial<Record<MailKey, string>> = {};
`;
}

/** A brand new farmer-glossary catalogue file for a language with none yet. */
export function newHelpSource(lang) {
	return `// ${lang.name} versions of the farmer glossary entries (farmer.ts,
// category 'farmer'; shown on /farm/words), WP-2.5; issue #58. Only checked
// text goes here.
//
// \`sourceHash\` is the SHA-256 (hex) of the English \`term + "\\n" + short +
// "\\n" + long\` the translation was made from: a stale entry (the English
// changed since) goes back on ${sheetPath(lang.code)}. \`pnpm gen:i18n:stamp
// ${lang.code} <id>\` re-stamps it once a translation has been re-checked.
//
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { HelpTranslation } from './types';

export const HELP_${lang.code.toUpperCase()}: Record<string, HelpTranslation> = {};
`;
}

/** The backend's per-language email index (a Lambda bundle can't find catalogue files by name, so this needs a line per language, unlike the site and glossary catalogues). */
export const MAIL_CATALOGUES_INDEX = 'backend/src/mail/i18n/catalogues.ts';

/**
 * `source` (catalogues.ts) with an `import { <code> } from './<code>.js'`
 * line grouped with the others, and `<code>` added to `CATALOGUES`, if it
 * isn't already there.
 */
export function addMailCatalogueEntry(source, code) {
	if (new RegExp(`\\{ ${code} \\} from '\\./${code}\\.js'`).test(source)) return source;
	const importLine = `import { ${code} } from './${code}.js';\n`;
	const withImport = /^import \{ \w+ \} from '\.\/\w+\.js';\n/m.test(source) ? source.replace(/^(import \{ \w+ \} from '\.\/\w+\.js';\n)+/m, (block) => `${block}${importLine}`) : importLine + source;
	return withImport.replace(/(export const CATALOGUES: Readonly<Record<string, MailCatalogue>> = \{)([^}]*)(\};)/, (_m, pre, body, post) => {
		const names = body
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!names.includes(code)) names.push(code);
		return `${pre} ${names.join(', ')} ${post}`;
	});
}

const load = (rel) => import(`${pathToFileURL(path.join(ROOT, rel)).href}?t=${Date.now()}`);
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** A catalogue module's named export, or `fallback` when the file doesn't exist yet. */
async function loadCatalogue(rel, key, fallback) {
	if (!existsSync(path.join(ROOT, rel))) return fallback;
	const mod = await load(rel);
	return mod[key] ?? fallback;
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === '--export') {
		const lang = await resolveLanguage(args[1]);
		const dir = args[2];
		if (!dir) throw new Error('usage: --export <lang> <dir> [--batches N]');
		const src = await sources(lang.code);
		const n = Number(args[args.indexOf('--batches') + 1]) || 5;
		mkdirSync(dir, { recursive: true });
		const bs = batches(sheetRows(src), args.includes('--batches') ? n : 5);
		bs.forEach((b, i) => writeFileSync(path.join(dir, `batch-${i + 1}.json`), `${JSON.stringify(b, null, '\t')}\n`));
		console.log(`wrote ${bs.length} batches (${bs.map((b) => b.length).join(' + ')} rows) to ${dir}`);
		return;
	}
	if (!args[0] || args[0].startsWith('-') || args.length < 2) {
		console.error('usage: pnpm gen:i18n:apply <lang> <translations.json> …   (sheet Id → words; later files win)');
		process.exit(2);
	}
	const lang = await resolveLanguage(args[0]);
	const files = args.slice(1);
	const src = await sources(lang.code);
	const translations = Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
	const { site, mail, help, problems } = plan(src, translations);
	if (problems.length) {
		console.error(`Nothing written:\n${problems.map((p) => `  ${p}`).join('\n')}`);
		process.exit(1);
	}
	const cat = catalogueFiles(lang.code);
	const isNew = { site: !existsSync(path.join(ROOT, cat.site)), mail: !existsSync(path.join(ROOT, cat.mail)), help: !existsSync(path.join(ROOT, cat.help)) };
	const [siteAf, mailEn, mailAf, farmer, helpAf] = await Promise.all([
		loadCatalogue(cat.site, lang.code, {}),
		load('backend/src/mail/i18n/en.ts'),
		loadCatalogue(cat.mail, lang.code, {}),
		load('frontend/src/lib/help/farmer.ts'),
		loadCatalogue(cat.help, `HELP_${lang.code.toUpperCase()}`, {})
	]);
	writeFileSync(path.join(ROOT, cat.site), renderSite(isNew.site ? newSiteSource(lang) : read(cat.site), lang.code, src.messages, siteAf, site));
	writeFileSync(path.join(ROOT, cat.mail), renderMail(isNew.mail ? newMailSource(lang) : read(cat.mail), lang.code, mailEn.en, mailAf, mail));
	writeFileSync(path.join(ROOT, cat.help), renderHelp(isNew.help ? newHelpSource(lang) : read(cat.help), lang.code, farmer.FARMER_HELP, helpAf, help));
	// The site and glossary catalogues are found by file name (import.meta.glob); only the
	// backend's email index needs a line per language, since a Lambda bundle can't glob.
	const mailIndex = path.join(ROOT, MAIL_CATALOGUES_INDEX);
	if (existsSync(mailIndex)) writeFileSync(mailIndex, addMailCatalogueEntry(readFileSync(mailIndex, 'utf8'), lang.code));
	else if (isNew.mail) console.log(`Created ${cat.mail}, but ${MAIL_CATALOGUES_INDEX} doesn't exist in this worktree: add '${lang.code}' to its locale → catalogue map by hand.`);
	// A fresh process: this one has the old catalogues cached.
	execFileSync(process.execPath, [path.join(ROOT, 'scripts/guards/i18n_sheet.mjs'), lang.code], { stdio: 'inherit' });
	console.log(`applied ${Object.keys(site).length} site, ${Object.keys(mail).length} email and ${Object.keys(help).length} glossary translations; rewrote ${sheetPath(lang.code)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
