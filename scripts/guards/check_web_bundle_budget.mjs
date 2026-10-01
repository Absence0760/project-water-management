#!/usr/bin/env node
// Hard ceilings on the shipped frontend bundle (estate standard: feohledger's
// web-bundle-budget.yml, threkir's check_web_bundle_budget.mjs).
//
// The frontend is a static SPA on S3 + CloudFront, so every kilobyte here is
// downloaded by every user on a cold visit, and nothing else in CI notices
// weight. A change that pushes a metric over its ceiling fails CI, so the
// increase is acknowledged instead of landing unremarked.
//
// It is a ratchet, not a wall. Raising a ceiling is a legitimate outcome when
// the answer is "ship the feature", but the raise is deliberate: a dated entry
// says what was measured and why the growth is warranted (below, "Raising a
// ceiling").
//
// The populations, gzip-measured with node:zlib:
//   totalCodeKb     every emitted JS + CSS file, summed in bytes and rounded
//                   once. Lazy chunks count too: code-splitting a dependency
//                   must not lower this number, only removing weight does.
//   largestChunkKb  the largest single JS/CSS file a page loads, other than a
//                   workspace tab's (below): the pages and routes, their shared
//                   chunks, the lazy panels. Catches one heavyweight dependency
//                   landing in one chunk (a second chart library, a spreadsheet
//                   parser, a date library), and a tab's code sliding back into
//                   the workspace page chunk.
//   largestTabChunkKb
//                   the largest chunk of a workspace tab: the modules the
//                   catchment page's LOAD map imports lazily
//                   (frontend/src/routes/projects/[id]/+page.svelte), each
//                   chunk holding one plus its own CSS file(s). A tab loads on
//                   top of the page when it is opened, never on a cold visit,
//                   and a panel it always renders is cheaper in its chunk than
//                   as a chunk of its own (split overhead, a second request):
//                   so tabs get a higher ceiling of their own rather than
//                   splitting panels to fit the page ceiling. Which file holds
//                   which tab comes from frontend/vite.config.ts's
//                   chunkModuleMap (.svelte-kit/output/client/.vite/
//                   chunk-modules.json; file names are bare hashes). The guard
//                   fails if it finds no tabs, if a tab module isn't in exactly
//                   one chunk, or if a tab shares the workspace page's chunk
//                   (that would take it out of the page ceiling). Tab chunks
//                   still count in totalCodeKb.
//   largestWorkerKb the largest Web Worker entry under `/workers/` other than
//                   the spreadsheet workers: the calibration worker
//                   (lib/calibration/autocal.worker.ts) and, since WP-1.17,
//                   the preview worker (lib/preview/engine.worker.ts). Since
//                   issue #9 each is an entry of the page build
//                   (frontend/vite.config.ts, workerChunks), not a bundle of
//                   its own: the calibration worker's file holds the code
//                   only it runs (the fit, the ensemble), the preview
//                   worker's the yield search, and both import the engine
//                   code they share with pages or with each other (the run)
//                   from chunks/, which count as page chunks. They load only
//                   when a fit, an ensemble or a preview starts, never on
//                   navigation, so they have their own ceiling instead of the
//                   page chunks'. They still count in totalCodeKb. The guard
//                   also fails if either stops importing from chunks/ (a
//                   worker built with `new Worker(new URL(…))` would carry a
//                   second engine copy again).
//   largestSpreadsheetWorkerKb
//                   the largest spreadsheet worker: `export.worker.ts` (the
//                   .xlsx run export, WP-1.28) and `import.worker.ts` (the
//                   in-browser workbook import, WP-1.31) in
//                   frontend/src/lib/spreadsheet/. Neither carries a
//                   spreadsheet library any more: the import reads workbooks
//                   with its own streaming reader (since 2026-09-25) and the
//                   export writes them with its own OOXML writer (since
//                   2026-09-26; with SheetJS it was 88 KB). Both load only
//                   when someone asks for a workbook, so they keep a ceiling
//                   of their own rather than lifting the calibration worker's.
//                   Still counted in totalCodeKb; not in largestWorkerKb.
//   largestAssetKb  the largest single non-JS/CSS file (fonts, images, HTML,
//                   the manifest). Per file and never summed: a visitor loads
//                   one favicon, one font weight at a time.
//   mapKb           MapLibre and the PMTiles reader (the catchment map, issue
//                   #288, roadmap WP-3.12 decision D8 (b)): every chunk holding
//                   code of the maplibre-gl or pmtiles packages, with its CSS,
//                   summed. ~290 KB of a third-party renderer that loads only
//                   when someone opens the Map tab and the map is
//                   drawn (lib/components/map/maplibre.ts, a dynamic import of
//                   a dynamic import), never on a workspace visit. It has a
//                   ceiling of its own and is left out of totalCodeKb and
//                   largestChunkKb: counted there it would be a design-sized
//                   raise of the total that says nothing about the app's own
//                   code (the ratchet the total keeps), and a vendor chunk
//                   far over the per-chunk ceiling that no split can bring
//                   under it. The guard fails if it finds no map chunk, or
//                   finds MapLibre in the workspace page's chunk or a tab's
//                   (it must stay lazy). MapLibre's worker entry
//                   (workers/maplibre.worker-*.js) is a worker like the
//                   others: it counts in totalCodeKb and largestWorkerKb, and
//                   must import MapLibre's shared code from chunks/.
//   landingKb       the public landing page's own code (issue #57): every
//                   chunk holding a module of frontend/src/lib/components/landing/,
//                   with its CSS, summed. It is the first thing a new visitor
//                   downloads, so it has a ceiling of its own; the guard fails
//                   if it finds no landing chunk, or finds the landing in the
//                   root layout's or the projects page's chunk (it must stay a
//                   chunk of its own, loaded only for a signed-out visitor).
//                   Still counted in totalCodeKb.
//
// ── Raising a ceiling ─────────────────────────────────────────────────────
// totalCodeKb, the one that grows with every feature, is BUDGET.totalCodeKb
// (a frozen base) plus the addKb of every entry file in bundle-budget/ beside
// this script: one file per raise, named YYYY-MM-DD-<slug>.json and written by
//   pnpm gen:bundle-budget <slug> <kb> "<what grew, what was measured>"
// so two PRs that both raise it never touch the same line. Never edit the base
// to raise the total. The other ceilings change rarely: edit BUDGET and log
// the change in bundle-budget/README.md, which also holds the change log from
// before entry files, the entry rules, and how to convert an old-style raise.
//
// Run:  pnpm build:frontend && pnpm check:bundle
// Add:  pnpm gen:bundle-budget <slug> <kb> "<why>"
// CI:    ci.yml, job `test`, after `pnpm build`.
// Tests: node --test scripts/guards/check_web_bundle_budget.test.mjs

import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = Object.freeze({
	// The frozen base of the total: raise it with an entry file in bundle-budget/ (pnpm gen:bundle-budget), never here.
	totalCodeKb: 1370,
	largestChunkKb: 42,
	largestTabChunkKb: 60,
	largestWorkerKb: 21,
	largestSpreadsheetWorkerKb: 32,
	largestAssetKb: 100,
	landingKb: 25,
	// MapLibre + PMTiles (issue #288, roadmap D8 (b); measured 2026-10-01: 301 KB, its two chunks, the PMTiles reader and its CSS, maplibre-gl 6.10.0 + pmtiles 4.5.0).
	mapKb: 305,
});

/** The entry files that raise (or lower) BUDGET.totalCodeKb, one per change. */
export const ENTRIES_DIR = fileURLToPath(new URL('./bundle-budget/', import.meta.url));
/** Where the guard prints an entry's path from (the repo root, where pnpm runs it). */
const ENTRIES_DIR_SHOWN = 'scripts/guards/bundle-budget';
/** The one file in ENTRIES_DIR that isn't an entry: the rules and the history. */
const ENTRIES_README = 'README.md';
/** YYYY-MM-DD-<slug>.json, the slug lowercase letters, digits and single hyphens. */
const ENTRY_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The most one entry may move the total, either way; a bigger raise is a design change. */
export const MAX_ENTRY_KB = 100;
const ADD_USAGE = 'pnpm gen:bundle-budget <slug> <kb> "<what grew, what was measured>"';

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** @param {string} ymd */
const isRealDate = (ymd) => {
	const d = new Date(`${ymd}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
};

/**
 * Check one entry file.
 * @param {string} name the file name, without a directory
 * @param {string} text its contents
 * @returns {{ entry?: { name: string, addKb: number, why: string }, errors: string[] }}
 */
export function parseEntry(name, text) {
	const where = `${ENTRIES_DIR_SHOWN}/${name}`;
	const named = ENTRY_NAME.exec(name);
	if (!named) return { errors: [`${where}: an entry is named YYYY-MM-DD-<slug>.json (slug: lowercase letters, digits, single hyphens). Rename it; the README is the only other file allowed there.`] };
	if (!isRealDate(named[1])) return { errors: [`${where}: ${named[1]} is not a real date.`] };
	let data;
	try {
		data = JSON.parse(text);
	} catch (e) {
		return { errors: [`${where}: not valid JSON (${e.message}).`] };
	}
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return { errors: [`${where}: must be a JSON object { "addKb": <int>, "why": "<text>" }.`] };
	const errors = [];
	const extra = Object.keys(data).filter((k) => k !== 'addKb' && k !== 'why');
	if (extra.length) errors.push(`${where}: unknown key(s) ${extra.join(', ')}; an entry holds only addKb and why.`);
	const { addKb, why } = data;
	if (!Number.isInteger(addKb) || addKb === 0) errors.push(`${where}: addKb must be a non-zero whole number of KB (negative lowers the ceiling), got ${JSON.stringify(addKb)}.`);
	else if (Math.abs(addKb) > MAX_ENTRY_KB) errors.push(`${where}: addKb ${addKb} moves the total by more than ${MAX_ENTRY_KB} KB. That is a design change, not a raise: discuss it, and change BUDGET.totalCodeKb itself if it is the answer.`);
	if (typeof why !== 'string' || why.trim() === '') errors.push(`${where}: why must be a non-empty string saying what grew and what was measured.`);
	return errors.length ? { errors } : { entry: { name, addKb, why }, errors };
}

/**
 * Check a set of entry files and sum them.
 * @param {{ name: string, text: string }[]} files every file in ENTRIES_DIR
 * @returns {{ entries: { name: string, addKb: number, why: string }[], addKb: number, errors: string[] }}
 */
export function budgetEntries(files) {
	const entries = [];
	const errors = [];
	for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
		if (f.name === ENTRIES_README) continue;
		const r = parseEntry(f.name, f.text);
		if (r.entry) entries.push(r.entry);
		errors.push(...r.errors);
	}
	return { entries, addKb: entries.reduce((sum, e) => sum + e.addKb, 0), errors };
}

/**
 * The entry files on disk.
 * @param {string} dir
 */
export function readBudgetEntries(dir = ENTRIES_DIR) {
	let names;
	try {
		names = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { entries: [], addKb: 0, errors: [`No budget entry directory at ${dir}. It holds the raises of the total (and its README); restore it from main.`] };
	}
	const dirs = names.filter((d) => !d.isFile()).map((d) => `${ENTRIES_DIR_SHOWN}/${d.name}: not a file; entries are files directly in the directory.`);
	const r = budgetEntries(names.filter((d) => d.isFile()).map((d) => ({ name: d.name, text: readFileSync(join(dir, d.name), 'utf8') })));
	return { ...r, errors: [...dirs, ...r.errors] };
}

/**
 * The ceilings in force: the base with every entry added to the total.
 * @param {number} addKb the entries' sum
 * @param {typeof BUDGET} base
 * @returns {typeof BUDGET}
 */
export function effectiveBudget(addKb, base = BUDGET) {
	return Object.freeze({ ...base, totalCodeKb: base.totalCodeKb + addKb });
}

/**
 * A new entry file, checked by the same rules as a committed one.
 * @param {string} slug
 * @param {string} kb
 * @param {string} why
 * @param {string} date YYYY-MM-DD (default today, local time)
 * @returns {{ name: string, text: string, errors: string[] }}
 */
export function newEntry(slug, kb, why, date = localDate()) {
	if (!SLUG.test(slug ?? '')) return { name: '', text: '', errors: [`The slug "${slug ?? ''}" must be lowercase letters, digits and single hyphens (e.g. issue-71-pack-share). Usage: ${ADD_USAGE}`] };
	if (!/^-?\d+$/.test(kb ?? '')) return { name: '', text: '', errors: [`The size "${kb ?? ''}" must be a whole number of KB. Usage: ${ADD_USAGE}`] };
	const name = `${date}-${slug}.json`;
	const text = JSON.stringify({ addKb: Number(kb), why: (why ?? '').trim() }, null, '\t') + '\n';
	return { name, text, errors: parseEntry(name, text).errors };
}

function addEntry(args) {
	const [slug, kb, ...why] = args;
	const e = newEntry(slug, kb, why.join(' '));
	if (e.errors.length) {
		for (const err of e.errors) console.error(err);
		process.exit(1);
	}
	try {
		writeFileSync(join(ENTRIES_DIR, e.name), e.text, { flag: 'wx' });
	} catch (err) {
		console.error(err.code === 'EEXIST' ? `${ENTRIES_DIR_SHOWN}/${e.name} already exists: pick another slug, or edit that file.` : String(err));
		process.exit(1);
	}
	const { addKb, errors } = readBudgetEntries();
	console.log(`Wrote ${ENTRIES_DIR_SHOWN}/${e.name} (${Number(kb) > 0 ? '+' : ''}${Number(kb)} KB).`);
	if (!errors.length) console.log(`Total ceiling is now ${BUDGET.totalCodeKb + addKb} KB (base ${BUDGET.totalCodeKb} + entries ${addKb}). Commit the file with the change that needs it.`);
}

/** A Web Worker bundle (Vite emits them under `workers/`; so does workerChunks for the calibration and preview workers). */
const WORKER = /(^|\/)workers\//;
/** The workers built as entries of the page build (frontend/vite.config.ts, workerChunks): each must import the engine from chunks/. */
const PAGE_BUILD_WORKERS = [
	{ label: 'calibration worker', file: 'workers/autocal.worker-*.js', url: 'virtual:autocal-worker-url', re: /(^|\/)workers\/autocal\.worker-[^/]*\.js$/ },
	{ label: 'preview worker', file: 'workers/preview.worker-*.js', url: 'virtual:preview-worker-url', re: /(^|\/)workers\/preview\.worker-[^/]*\.js$/ },
	// MapLibre's worker (issue #288): built on its own it would carry a second copy of MapLibre's shared code (~145 KB).
	{ label: 'map worker', file: 'workers/maplibre.worker-*.js', url: 'virtual:maplibre-worker-url', re: /(^|\/)workers\/maplibre\.worker-[^/]*\.js$/ },
];
/** A static import from the page build's shared chunks, as Rollup writes it next to workers/. */
const SHARED_CHUNK_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\.\/chunks\//;
/** A spreadsheet worker: lib/spreadsheet's export.worker.ts / import.worker.ts (Vite names the bundle after the source). */
const SPREADSHEET_WORKER = /(^|\/)workers\/(export|import)\.worker-[^/]*$/;

const CODE = /\.(m?js|css)$/;

/** The catchment workspace page, whose LOAD map lists the lazy tabs. */
export const WORKSPACE_PAGE = 'src/routes/projects/[id]/+page.svelte';
/** frontend/vite.config.ts's chunkModuleMap output (CHUNK_MODULES_FILE), under the client build. */
const CHUNK_MODULES = 'frontend/.svelte-kit/output/client/.vite/chunk-modules.json';

/** @param {number} bytes */
export const kb = (bytes) => Math.ceil(bytes / 1024);

/**
 * The workspace tab modules: the `import('…')` specifiers in the page's
 * `const LOAD = { … };` map, as paths relative to frontend/.
 * @param {string} pageSource the workspace page's source
 * @returns {string[]}
 */
export function tabModules(pageSource) {
	const block = /\bconst LOAD\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(pageSource);
	if (!block) return [];
	return [...block[1].matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1].replace(/^\$lib\//, 'src/lib/'));
}

/**
 * The output files of the workspace tabs: each tab module's chunk plus that
 * chunk's own CSS, from chunkModuleMap's `{ file: { modules, css } }`.
 * Paths are relative to the client output, as in the build directory.
 * @param {string[]} modules tabModules()
 * @param {Record<string, { modules: string[], css?: string[] }>} chunks
 * @returns {{ files: Set<string>, errors: string[] }}
 */
export function tabChunks(modules, chunks) {
	const errors = [];
	const files = new Set();
	if (modules.length === 0) {
		errors.push(
			`Found no lazy-loaded workspace tabs: no import('…') in the LOAD map of frontend/${WORKSPACE_PAGE}. The tab chunk ceiling measured nothing; if the tabs moved, point WORKSPACE_PAGE / tabModules() in scripts/guards/check_web_bundle_budget.mjs at them.`,
		);
		return { files, errors };
	}
	for (const mod of modules) {
		const holders = Object.entries(chunks).filter(([, c]) => c.modules.includes(mod));
		if (holders.length !== 1) {
			errors.push(
				`Workspace tab ${mod} is in ${holders.length} chunks of the build, expected exactly one. Check frontend/vite.config.ts's chunkModuleMap still writes .vite/chunk-modules.json, and that the tab is still imported lazily.`,
			);
			continue;
		}
		const [file, chunk] = holders[0];
		if (chunk.modules.includes(WORKSPACE_PAGE)) {
			errors.push(
				`Workspace tab ${mod} is in the workspace page's own chunk (${file}): something imports it statically, so every catchment's cold load carries it. Load it only through the page's LOAD map.`,
			);
			continue;
		}
		files.add(file);
		for (const css of chunk.css ?? []) files.add(css);
	}
	return { files, errors };
}

/** The landing page's modules (issue #57). */
const LANDING_MODULES = 'src/lib/components/landing/';
/** Chunks the landing must never share: the root layout and the signed-in projects page. */
const NOT_WITH_LANDING = ['src/routes/+layout.svelte', 'src/routes/+page.svelte'];

/**
 * The landing page's chunk files (JS and CSS), from the chunk map.
 * @param {Record<string, { modules: string[], css?: string[] }>} chunks
 * @returns {{ files: Set<string>, errors: string[] }}
 */
export function landingChunks(chunks) {
	const errors = [];
	const files = new Set();
	for (const [file, chunk] of Object.entries(chunks)) {
		if (!chunk.modules.some((m) => m.startsWith(LANDING_MODULES))) continue;
		const shared = NOT_WITH_LANDING.filter((m) => chunk.modules.includes(m));
		if (shared.length) {
			errors.push(
				`The landing page's code is in the chunk of ${shared.join(' and ')} (${file}): something imports it statically, so every signed-in visit carries it. Load it only through the root layout's import() (issue #57).`,
			);
		}
		files.add(file);
		for (const css of chunk.css ?? []) files.add(css);
	}
	if (files.size === 0) {
		errors.push(`Found no chunk holding frontend/${LANDING_MODULES}: the landing ceiling measured nothing. If the landing moved, point LANDING_MODULES in scripts/guards/check_web_bundle_budget.mjs at it.`);
	}
	return { files, errors };
}

/** The npm packages whose chunks are the map's (mapKb). */
export const MAP_PACKAGES = ['maplibre-gl', 'pmtiles'];

/**
 * The map library's chunk files (JS and CSS), from the chunk map's
 * `packages`: every chunk holding code of MAP_PACKAGES, outside workers/.
 * @param {Record<string, { modules: string[], css?: string[], packages?: string[] }>} chunks
 * @param {string[]} tabMods tabModules(): MapLibre must share no chunk with a tab
 * @returns {{ files: Set<string>, errors: string[] }}
 */
export function mapChunks(chunks, tabMods = []) {
	const errors = [];
	const files = new Set();
	for (const [file, chunk] of Object.entries(chunks)) {
		if (WORKER.test(file) || !(chunk.packages ?? []).some((p) => MAP_PACKAGES.includes(p))) continue;
		const eager = [WORKSPACE_PAGE, ...tabMods].filter((m) => chunk.modules.includes(m));
		if (eager.length) {
			errors.push(
				`MapLibre is in the chunk of ${eager.join(' and ')} (${file}): something imports it statically, so it loads with the workspace or a tab. Load it only through lib/components/map/maplibre.ts's dynamic import (issue #288).`,
			);
		}
		files.add(file);
		for (const css of chunk.css ?? []) files.add(css);
	}
	if (files.size === 0) {
		errors.push(`Found no chunk holding ${MAP_PACKAGES.join(' or ')}: the map ceiling measured nothing. Check frontend/vite.config.ts's chunkModuleMap still records each chunk's packages, and the catchment map still loads MapLibre.`);
	}
	return { files, errors };
}

/**
 * @param {{ path: string, gzipBytes: number }[]} files
 * @param {Set<string>} [tabFiles] tabChunks().files: measured against the tab ceiling instead of the page one
 * @param {Set<string>} [landingFiles] landingChunks().files: also summed against the landing ceiling
 * @param {Set<string>} [mapFiles] mapChunks().files: summed against the map ceiling only (not the total or the per-chunk ceiling)
 */
export function measure(files, tabFiles = new Set(), landingFiles = new Set(), mapFiles = new Set()) {
	let landingBytes = 0;
	let mapBytes = 0;
	let codeBytes = 0;
	let codeCount = 0;
	let largestChunk = { path: '', gzipBytes: 0 };
	let largestTabChunk = { path: '', gzipBytes: 0 };
	let tabCount = 0;
	let largestWorker = { path: '', gzipBytes: 0 };
	let largestSpreadsheetWorker = { path: '', gzipBytes: 0 };
	let largestAsset = { path: '', gzipBytes: 0 };
	for (const f of files) {
		if (landingFiles.has(f.path)) landingBytes += f.gzipBytes;
		if (mapFiles.has(f.path)) {
			mapBytes += f.gzipBytes;
			continue;
		}
		if (CODE.test(f.path)) {
			codeBytes += f.gzipBytes;
			codeCount += 1;
			if (SPREADSHEET_WORKER.test(f.path)) {
				if (f.gzipBytes > largestSpreadsheetWorker.gzipBytes) largestSpreadsheetWorker = f;
			} else if (WORKER.test(f.path)) {
				if (f.gzipBytes > largestWorker.gzipBytes) largestWorker = f;
			} else if (tabFiles.has(f.path)) {
				tabCount += 1;
				if (f.gzipBytes > largestTabChunk.gzipBytes) largestTabChunk = f;
			} else if (f.gzipBytes > largestChunk.gzipBytes) largestChunk = f;
		} else if (f.gzipBytes > largestAsset.gzipBytes) {
			largestAsset = f;
		}
	}
	return {
		fileCount: files.length,
		codeCount,
		totalCodeKb: kb(codeBytes),
		largestChunk: { path: largestChunk.path, kb: kb(largestChunk.gzipBytes) },
		tabCount,
		largestTabChunk: { path: largestTabChunk.path, kb: kb(largestTabChunk.gzipBytes) },
		largestWorker: { path: largestWorker.path, kb: kb(largestWorker.gzipBytes) },
		largestSpreadsheetWorker: { path: largestSpreadsheetWorker.path, kb: kb(largestSpreadsheetWorker.gzipBytes) },
		largestAsset: { path: largestAsset.path, kb: kb(largestAsset.gzipBytes) },
		landingKb: kb(landingBytes),
		mapKb: kb(mapBytes),
	};
}

/**
 * @param {ReturnType<typeof measure>} m
 * @param {typeof BUDGET} budget
 * @returns {string[]} one message per ceiling exceeded
 */
export function violations(m, budget = BUDGET) {
	const out = [];
	if (m.codeCount === 0) {
		out.push('No JS or CSS files found in the build. The build output moved or the build failed; this guard measured nothing.');
		return out;
	}
	if (m.totalCodeKb > budget.totalCodeKb) {
		out.push(
			`Total gzipped JS+CSS is ${m.totalCodeKb} KB, over the ${budget.totalCodeKb} KB budget by ${m.totalCodeKb - budget.totalCodeKb} KB. Trim weight, or raise the ceiling by your change's own growth with a new entry file: ${ADD_USAGE} (writes ${ENTRIES_DIR_SHOWN}/<date>-<slug>.json; rules in its README). Don't edit BUDGET.totalCodeKb: it is the frozen base, and editing it makes every open PR conflict.`,
		);
	}
	if (m.largestChunk.kb > budget.largestChunkKb) {
		out.push(
			`Largest chunk ${m.largestChunk.path} is ${m.largestChunk.kb} KB, over the ${budget.largestChunkKb} KB per-chunk budget. This usually means one heavyweight dependency landed in one chunk; check it is needed before raising the ceiling.`,
		);
	}
	if (m.largestTabChunk.kb > budget.largestTabChunkKb) {
		out.push(
			`Workspace tab chunk ${m.largestTabChunk.path} is ${m.largestTabChunk.kb} KB, over the ${budget.largestTabChunkKb} KB per-tab budget. Move a panel only some visits render (one behind a condition, a dialog) into a lazy chunk of its own, or check for a heavyweight dependency, before raising the ceiling.`,
		);
	}
	if (m.largestWorker.kb > budget.largestWorkerKb) {
		out.push(
			`Web Worker ${m.largestWorker.path} is ${m.largestWorker.kb} KB, over the ${budget.largestWorkerKb} KB per-worker budget. A worker ships its own copy of what it imports; check a new import is needed there before raising the ceiling.`,
		);
	}
	if (m.largestSpreadsheetWorker.kb > budget.largestSpreadsheetWorkerKb) {
		out.push(
			`Spreadsheet worker ${m.largestSpreadsheetWorker.path} is ${m.largestSpreadsheetWorker.kb} KB, over the ${budget.largestSpreadsheetWorkerKb} KB spreadsheet-worker budget. Neither spreadsheet worker carries a spreadsheet library (the import has its own reader, the export its own writer, frontend/src/lib/spreadsheet/); check a new import (above all SheetJS, ~85 KB) is needed before raising the ceiling.`,
		);
	}
	if (m.landingKb > budget.landingKb) {
		out.push(
			`The landing page's code is ${m.landingKb} KB, over the ${budget.landingKb} KB landing budget: it is the first download of every new visitor (issue #57). Check it still imports no workspace code, uPlot or engine, and trim before raising the ceiling.`,
		);
	}
	if (m.mapKb > budget.mapKb) {
		out.push(
			`The map library is ${m.mapKb} KB, over the ${budget.mapKb} KB map budget (MapLibre and PMTiles, issue #288). Check a MapLibre upgrade's size, or that nothing else landed in its chunks, before raising the ceiling.`,
		);
	}
	if (m.largestAsset.kb > budget.largestAssetKb) {
		out.push(
			`Asset ${m.largestAsset.path} is ${m.largestAsset.kb} KB gzipped, over the ${budget.largestAssetKb} KB per-asset budget. Subset the font or compress the image rather than raising the ceiling.`,
		);
	}
	return out;
}

/**
 * The calibration and preview workers must be entries of the page build
 * (issue #9, WP-1.17), so they share the engine with the pages and with each
 * other instead of carrying their own copies: each file imports from
 * ../chunks/. A worker built on its own (Vite's `new Worker(new URL(…))`)
 * imports nothing.
 * @param {{ path: string, text: string }[]} workers the files under workers/
 * @returns {string[]}
 */
export function pageBuildWorkerViolations(workers) {
	return PAGE_BUILD_WORKERS.flatMap((w) => {
		const entry = workers.filter((f) => w.re.test(f.path));
		if (entry.length !== 1) {
			return [
				`Expected one ${w.label} (${w.file}) in the build, found ${entry.length}. frontend/vite.config.ts (workerChunks) emits it; check the plugin still runs and names it.`,
			];
		}
		if (!SHARED_CHUNK_IMPORT.test(entry[0].text)) {
			return [
				`The ${w.label} ${entry[0].path} imports nothing from the page build's chunks/: it carries its own copy of the engine again. Start it with the URL from '${w.url}' (frontend/vite.config.ts, workerChunks), not new Worker(new URL(…)).`,
			];
		}
		return [];
	});
}

/** @param {string} dir */
function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

function main() {
	const entries = readBudgetEntries();
	if (entries.errors.length) {
		for (const e of entries.errors) console.error(`::error::${e}`);
		process.exit(1);
	}
	const budget = effectiveBudget(entries.addKb);
	const buildDir = process.argv[2] ?? 'frontend/build';
	let paths;
	try {
		paths = walk(buildDir);
	} catch {
		console.error(`::error::No build output at ${buildDir}. Run pnpm build:frontend first.`);
		process.exit(1);
	}
	const chunkModulesPath = process.argv[3] ?? CHUNK_MODULES;
	let chunkModules;
	try {
		chunkModules = JSON.parse(readFileSync(chunkModulesPath, 'utf8'));
	} catch {
		console.error(`::error::No chunk map at ${chunkModulesPath}. frontend/vite.config.ts (chunkModuleMap) writes it during pnpm build:frontend; build again, or check the plugin still runs.`);
		process.exit(1);
	}
	const tabs = tabChunks(tabModules(readFileSync(join('frontend', WORKSPACE_PAGE), 'utf8')), chunkModules);
	const landing = landingChunks(chunkModules);
	const map = mapChunks(chunkModules, tabModules(readFileSync(join('frontend', WORKSPACE_PAGE), 'utf8')));
	const files = paths.map((p) => ({ path: relative(buildDir, p), gzipBytes: gzipSync(readFileSync(p)).length }));
	const m = measure(files, tabs.files, landing.files, map.files);
	const rows = [
		['Total gzipped JS+CSS', `${m.totalCodeKb} KB`, `${budget.totalCodeKb} KB: base ${BUDGET.totalCodeKb}, ${entries.addKb >= 0 ? '+' : ''}${entries.addKb} from ${entries.entries.length} entries in ${ENTRIES_DIR_SHOWN}/`],
		[`Largest chunk (${m.largestChunk.path})`, `${m.largestChunk.kb} KB`, `${budget.largestChunkKb} KB`],
		[`Largest tab chunk (${m.largestTabChunk.path || 'none'}; ${m.tabCount} tab files)`, `${m.largestTabChunk.kb} KB`, `${budget.largestTabChunkKb} KB`],
		[`Largest worker (${m.largestWorker.path || 'none'})`, `${m.largestWorker.kb} KB`, `${budget.largestWorkerKb} KB`],
		[`Largest spreadsheet worker (${m.largestSpreadsheetWorker.path || 'none'})`, `${m.largestSpreadsheetWorker.kb} KB`, `${budget.largestSpreadsheetWorkerKb} KB`],
		[`Largest other asset (${m.largestAsset.path || 'none'})`, `${m.largestAsset.kb} KB`, `${budget.largestAssetKb} KB`],
		[`Landing page (${landing.files.size} files)`, `${m.landingKb} KB`, `${budget.landingKb} KB`],
		[`Map library, lazy (${map.files.size} files; not in the total)`, `${m.mapKb} KB`, `${budget.mapKb} KB`],
	];
	for (const [what, size, ceiling] of rows) console.log(`${what}: ${size} (budget ${ceiling})`);
	console.log(`Raise the total with an entry file (${ADD_USAGE}), never by editing BUDGET.totalCodeKb.`);
	console.log(`Files measured: ${m.fileCount} (${m.codeCount} JS/CSS)`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const table = ['## Web bundle budget', '', '| Metric | Size | Budget |', '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n') + '\n');
	}
	const workers = paths.filter((p) => WORKER.test(relative(buildDir, p))).map((p) => ({ path: relative(buildDir, p), text: readFileSync(p, 'utf8') }));
	// A map from another build (a stale .svelte-kit beside a fresh build dir) names files this build doesn't have.
	const stale = tabs.errors.length === 0 && m.tabCount !== tabs.files.size
		? [`The chunk map names ${tabs.files.size} tab files, but ${m.tabCount} of them are in ${buildDir}: the map is from another build. Run pnpm build:frontend again.`]
		: [];
	const bad = [...tabs.errors, ...landing.errors, ...map.errors, ...stale, ...violations(m, budget), ...pageBuildWorkerViolations(workers)];
	for (const v of bad) console.error(`::error::${v}`);
	process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === 'add') addEntry(process.argv.slice(3));
	else main();
}
