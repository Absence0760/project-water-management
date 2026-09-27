#!/usr/bin/env node
// Move the translation sheet's strings out for translation, and returned
// Afrikaans back into the catalogues (WP-2.5; docs/ui.md § Language).
//
//   node scripts/guards/i18n_apply.mjs --export <dir> [--batches N]   (pnpm gen:i18n:export)
//   node scripts/guards/i18n_apply.mjs <translations.json> …          (pnpm gen:i18n:apply)
//
// --export writes every row still on docs/i18n/af-translation-sheet.md as N
// JSON batches (`batch-1.json` …, default 5), each an array of
// { id, english, context, section, sectionNote }, split at section
// boundaries: the input the af-translator agent (.claude/agents/i18n/) or a
// human translator's tooling works from. A newline in the English is "\n".
//
// Apply takes one or more JSON objects of sheet Id → Afrikaans (later files
// win, so a checker's corrections go last) and writes each into its
// catalogue:
//
//   <8-hex id>, <id>.<form>          frontend/src/lib/i18n/messages/af.ts
//   mail.…                          backend/src/mail/i18n/af.ts
//   help.<entry>.term|short|long    frontend/src/lib/help/content.af.ts, stamped
//                                   with the current English's sourceHash
//
// then rewrites the sheet and the id list (the entries leave the sheet). It
// refuses the whole set, writing nothing, when an id isn't on the sheet, a
// translation drops or adds a {placeholder} or changes the number of **
// bold marks, a counted word lacks one of its forms, or a glossary entry
// lacks its term, short or long. Existing translations are kept unless the
// input replaces them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { helpGroup, helpHash, SHEET, sources } from './i18n_sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FILES = {
	site: 'frontend/src/lib/i18n/messages/af.ts',
	mail: 'backend/src/mail/i18n/af.ts',
	help: 'frontend/src/lib/help/content.af.ts'
};

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

/** A JS string literal: single quotes, or double when the text has an apostrophe (Afrikaans 'n) and no double quote. */
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

/** af.ts: the existing entries plus `add`, in the extractor's message order, each with its English above it. */
export function renderSite(source, messages, existing, add) {
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
	return `${headerOf(source, 'export const af')}export const af: Catalogue = {\n${lines.join('\n')}\n};\n`;
}

/** backend af.ts: the existing entries plus `add`, in en.ts's order. */
export function renderMail(source, en, existing, add) {
	const all = { ...existing, ...add };
	const lines = Object.keys(en)
		.filter((k) => all[k] != null)
		.flatMap((k) => [`\t${comment(en[k])}`, `\t'${k}': ${literal(all[k])},`]);
	return `${headerOf(source, 'export const af')}export const af: Partial<Record<MailKey, string>> = {\n${lines.join('\n')}\n};\n`;
}

/** content.af.ts: the existing entries plus `add` (stamped from the current English), in farmer.ts's order. */
export function renderHelp(source, farmerHelp, existing, add) {
	const all = { ...existing };
	for (const [id, parts] of Object.entries(add)) all[id] = { ...parts, sourceHash: helpHash(farmerHelp.find((e) => e.id === id)) };
	const entries = farmerHelp
		.filter((e) => all[e.id])
		.map((e) => {
			const a = all[e.id];
			return [`\t${literal(e.id)}: {`, `\t\tterm: ${literal(a.term)},`, `\t\tshort: ${literal(a.short)},`, `\t\tlong: ${literal(a.long)},`, `\t\tsourceHash: '${a.sourceHash}'`, '\t},'].join('\n');
		});
	return `${headerOf(source, 'export const HELP_AF')}export const HELP_AF: Record<string, HelpTranslation> = {\n${entries.join('\n')}\n};\n`;
}

const load = (rel) => import(`${pathToFileURL(path.join(ROOT, rel)).href}?t=${Date.now()}`);
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

async function main() {
	const args = process.argv.slice(2);
	const src = await sources();
	if (args[0] === '--export') {
		const dir = args[1];
		if (!dir) throw new Error('usage: --export <dir> [--batches N]');
		const n = Number(args[args.indexOf('--batches') + 1]) || 5;
		mkdirSync(dir, { recursive: true });
		const bs = batches(sheetRows(src), args.includes('--batches') ? n : 5);
		bs.forEach((b, i) => writeFileSync(path.join(dir, `batch-${i + 1}.json`), `${JSON.stringify(b, null, '\t')}\n`));
		console.log(`wrote ${bs.length} batches (${bs.map((b) => b.length).join(' + ')} rows) to ${dir}`);
		return;
	}
	if (!args.length) {
		console.error('usage: pnpm gen:i18n:apply <translations.json> …   (sheet Id → Afrikaans; later files win)');
		process.exit(2);
	}
	const translations = Object.assign({}, ...args.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
	const { site, mail, help, problems } = plan(src, translations);
	if (problems.length) {
		console.error(`Nothing written:\n${problems.map((p) => `  ${p}`).join('\n')}`);
		process.exit(1);
	}
	const [siteAf, mailEn, mailAf, farmer, helpAf] = await Promise.all([load(FILES.site), load('backend/src/mail/i18n/en.ts'), load(FILES.mail), load('frontend/src/lib/help/farmer.ts'), load(FILES.help)]);
	writeFileSync(path.join(ROOT, FILES.site), renderSite(read(FILES.site), src.messages, siteAf.af, site));
	writeFileSync(path.join(ROOT, FILES.mail), renderMail(read(FILES.mail), mailEn.en, mailAf.af, mail));
	writeFileSync(path.join(ROOT, FILES.help), renderHelp(read(FILES.help), farmer.FARMER_HELP, helpAf.HELP_AF, help));
	// A fresh process: this one has the old catalogues cached.
	execFileSync(process.execPath, [path.join(ROOT, 'scripts/guards/i18n_sheet.mjs')], { stdio: 'inherit' });
	console.log(`applied ${Object.keys(site).length} site, ${Object.keys(mail).length} email and ${Object.keys(help).length} glossary translations; rewrote ${SHEET}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
