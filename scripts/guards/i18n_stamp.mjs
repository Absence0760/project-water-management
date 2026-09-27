#!/usr/bin/env node
// Re-stamp a farmer glossary translation (WP-2.5; docs/ui.md § Language; issue #58).
//
//   node scripts/guards/i18n_stamp.mjs <lang> <id>     (pnpm gen:i18n:stamp <lang> <id>)
//
// `<lang>` is a code from packages/engine/src/languages.ts (LANGUAGES).
// frontend/src/lib/help/content.<lang>.ts keeps, with each translated entry,
// the SHA-256 of the English it was translated from (`sourceHash`). When the
// English changes, the translation is stale: the catalogue tests and `pnpm
// check:i18n` fail, and the entry is back on that language's translation
// sheet. Once the translator has checked the words against the new English
// (and any fix is in content.<lang>.ts), this writes the current English's
// hash into the entry and rewrites the sheet, so the entry leaves it.
//
// It never writes a translation: an id with no entry for that language is refused.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogueFiles, helpHash, resolveLanguage, sheetOf, sheetPath, sources } from './i18n_sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `source` (a language's content.<lang>.ts) with entry `id`'s sourceHash set
 * to `hash`. Throws when the entry or its sourceHash isn't found. The entry
 * is the one whose key is `id` (bare or quoted); its sourceHash is the first
 * one after that key and before the next entry's key.
 */
export function restamp(source, id, hash) {
	if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a SHA-256 hex digest: ${hash}`);
	const key = new RegExp(`(^|[\\s{,])(['"]?)${escapeRe(id)}\\2\\s*:\\s*\\{`, 'm');
	const start = key.exec(source);
	if (!start) throw new Error(`no entry "${id}"`);
	const from = start.index + start[0].length;
	const stamp = /sourceHash\s*:\s*(['"])([^'"\n]*)\1/g;
	stamp.lastIndex = from;
	const m = stamp.exec(source);
	// The next entry starts with a key followed by `: {`; its stamp isn't this one's.
	const next = /(^|[\s,])(['"]?)[\w-]+\2\s*:\s*\{/gm;
	next.lastIndex = from;
	const n = next.exec(source);
	if (!m || (n && n.index < m.index)) throw new Error(`entry "${id}" has no sourceHash`);
	const quote = m[1];
	return `${source.slice(0, m.index)}sourceHash: ${quote}${hash}${quote}${source.slice(m.index + m[0].length)}`;
}

const load = (rel) => import(`${pathToFileURL(path.join(ROOT, rel)).href}?t=${Date.now()}`);

/** A catalogue module's named export, or `fallback` when the file doesn't exist yet. */
async function loadOr(rel, key, fallback) {
	try {
		const mod = await load(rel);
		return mod[key] ?? fallback;
	} catch (e) {
		if (e?.code === 'ERR_MODULE_NOT_FOUND') return fallback;
		throw e;
	}
}

async function main() {
	const langArg = process.argv[2];
	const id = process.argv[3];
	if (!langArg || !id || id.startsWith('-')) {
		console.error('usage: pnpm gen:i18n:stamp <lang> <id>   (after the translator has checked the entry against the current English)');
		process.exit(2);
	}
	const lang = await resolveLanguage(langArg);
	const files = catalogueFiles(lang.code);
	const [{ FARMER_HELP }, HELP_AF] = await Promise.all([load('frontend/src/lib/help/farmer.ts'), loadOr(files.help, `HELP_${lang.code.toUpperCase()}`, {})]);
	const entry = FARMER_HELP.find((e) => e.id === id);
	if (!entry) {
		console.error(`no farmer glossary entry "${id}" in frontend/src/lib/help/farmer.ts`);
		process.exit(1);
	}
	if (entry.category !== 'farmer') {
		console.error(`"${id}" isn't a farmer entry (category '${entry.category}'); only farmer entries are translated`);
		process.exit(1);
	}
	if (!HELP_AF[id]) {
		console.error(`"${id}" has no ${lang.name} in ${files.help}: add the translator's text first (term, short, long, sourceHash), then stamp it`);
		process.exit(1);
	}
	const hash = helpHash(entry);
	if (HELP_AF[id].sourceHash === hash) {
		console.log(`"${id}" is already stamped from the current English.`);
		return;
	}
	const file = path.join(ROOT, files.help);
	writeFileSync(file, restamp(readFileSync(file, 'utf8'), id, hash));
	const src = await sources(lang.code);
	writeFileSync(path.join(ROOT, sheetPath(lang.code)), sheetOf(lang, src));
	console.log(`stamped "${id}" (${hash.slice(0, 12)}…) and rewrote ${sheetPath(lang.code)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
