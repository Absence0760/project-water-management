#!/usr/bin/env node
// The assistant's help index (issue #610): backend/src/assistant/helpIndex.json,
// the help guides (frontend/src/lib/help/guides.ts, one entry per section) and
// the glossary (content.ts HELP: tips.ts joined with articles*.ts, then the
// farmer words, with their glossaryLinks.ts page), as plain text, for the search_help tool
// (backend/src/assistant/tools/searchHelp.ts). The backend imports nothing from
// the frontend workspace, so the text is copied here and committed;
// scripts/guards/assistant_help_index.test.mjs fails until this is rerun after
// a help text changes.
//
//   node scripts/gen-assistant-help.mjs           rewrite the index
//   node scripts/gen-assistant-help.mjs --check   exit 1 when it is stale
//
// The help modules are TypeScript, loaded with Node's type stripping. A
// resolve hook gives their extensionless and `#lib/…js` imports the `.ts` file,
// and a load hook serves pictures.json as a module (the frontend's bundler
// needs no import attribute; Node does).
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = `${root}frontend/src/lib/`;
export const INDEX_PATH = `${root}backend/src/assistant/helpIndex.json`;

const hooks = `
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const lib = ${JSON.stringify(pathToFileURL(lib).href)};
export async function resolve(specifier, context, next) {
	let url = null;
	if (specifier.startsWith('#lib/')) url = new URL(specifier.slice(5), lib);
	else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith(lib)) url = new URL(specifier, context.parentURL);
	if (url) {
		const path = fileURLToPath(url);
		for (const p of [path, path + '.ts', path.replace(/\\.js$/, '.ts')]) if (p.endsWith('.ts') || p.endsWith('.json')) if (existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true };
	}
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url.startsWith(lib) && url.endsWith('.json'))
		return { format: 'module', source: 'export default ' + (await readFile(fileURLToPath(url), 'utf8')), shortCircuit: true };
	return next(url, context);
}`;

/** Guide markup as plain text: [[id]] and [[guide:id|Label]] links, **bold**. */
export function plain(text, terms) {
	return text
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, (_, id) => terms.get(id) ?? id.replace(/^guide:/, '').replace(/-/g, ' '))
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

function blockText(b, terms) {
	switch (b.type) {
		case 'p':
		case 'note':
		case 'formula':
			return [plain(b.text, terms)];
		case 'steps':
		case 'list':
			return b.items.map((t) => plain(t, terms));
		case 'diagram':
			return [plain(b.caption, terms)];
		case 'picture':
			return [plain(b.caption, terms), ...b.stops.map((s) => `${plain(s.title, terms)}: ${plain(s.text, terms)}`)];
		default:
			return [];
	}
}

/** The index: one entry per guide section and one per glossary entry, in the help's own order. */
export async function buildIndex() {
	register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);
	const { GUIDES } = await import(pathToFileURL(`${lib}help/guides.ts`).href);
	const { HELP } = await import(pathToFileURL(`${lib}help/content.ts`).href);
	const { glossaryPath } = await import(pathToFileURL(`${lib}help/glossaryLinks.ts`).href);
	const terms = new Map(HELP.map((e) => [e.id, e.term]));
	const guides = GUIDES.flatMap((g) =>
		g.sections.map((s, i) => ({
			kind: 'guide',
			id: `${g.id}#${i + 1}`,
			title: `${g.title}: ${plain(s.heading, terms)}`,
			url: `/help/guides/${g.id}`,
			// The guide's summary once, on its first section.
			...(i === 0 ? { summary: plain(g.summary, terms) } : {}),
			text: s.blocks.flatMap((b) => blockText(b, terms)).join(' ')
		}))
	);
	const glossary = HELP.map((e) => ({
		kind: 'glossary',
		id: e.id,
		title: e.term,
		...(e.aliases?.length ? { aliases: e.aliases } : {}),
		url: glossaryPath(e),
		summary: e.short + (e.units ? ` (${e.units})` : ''),
		text: plain(e.long, terms)
	}));
	return { entries: [...guides, ...glossary] };
}

export const serialize = (index) => `${JSON.stringify(index, null, '\t')}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const next = serialize(await buildIndex());
	if (process.argv.includes('--check')) {
		let now = '';
		try {
			now = readFileSync(INDEX_PATH, 'utf8');
		} catch {}
		if (now !== next) {
			console.error('backend/src/assistant/helpIndex.json is stale: run pnpm gen:assistant:help');
			process.exit(1);
		}
		console.log('Assistant help index is current.');
	} else {
		writeFileSync(INDEX_PATH, next);
		const n = JSON.parse(next).entries.length;
		console.log(`Wrote backend/src/assistant/helpIndex.json (${n} entries, ${Math.round(next.length / 1024)} KB).`);
	}
}
