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
// the answer is "ship the feature", but the raise is deliberate: edit BUDGET
// below and append a dated entry to the change log saying what was measured
// and why the growth is warranted.
//
// Three populations, gzip-measured with node:zlib:
//   totalCodeKb     every emitted JS + CSS file, summed in bytes and rounded
//                   once. Lazy chunks count too: code-splitting a dependency
//                   must not lower this number, only removing weight does.
//   largestChunkKb  the largest single JS/CSS file a page loads. Catches one
//                   heavyweight dependency landing in one chunk (a second
//                   chart library, a spreadsheet parser, a date library).
//   largestWorkerKb the largest Web Worker bundle (`/workers/`, Vite's
//                   output for `new Worker(new URL(…))`). A worker carries its
//                   own copy of the engine and is fetched only when a fit or
//                   an uncertainty ensemble starts, never on navigation, so it
//                   has its own ceiling instead of the page chunks'. It still
//                   counts in totalCodeKb.
//   largestSpreadsheetWorkerKb
//                   the largest spreadsheet worker: `export.worker.ts` (the
//                   .xlsx run export, WP-1.28) and `import.worker.ts` (the
//                   in-browser workbook import, WP-1.31) in
//                   frontend/src/lib/spreadsheet/. They carry SheetJS, which
//                   dwarfs the engine, and load only when someone asks for a
//                   workbook, so they get a ceiling of their own rather than
//                   lifting the calibration worker's. Still counted in
//                   totalCodeKb; not in largestWorkerKb.
//   largestAssetKb  the largest single non-JS/CSS file (fonts, images, HTML,
//                   the manifest). Per file and never summed: a visitor loads
//                   one favicon, one font weight at a time.
//
// ── Ceiling change log (append; newest last) ──────────────────────────────
// 2026-09-23  initial. Measured on main @ 02552f4 (production build):
//             code 225 KB across 58 JS/CSS files, largest chunk 81 KB
//             (nodes/7: the catchment workspace page, which carries the
//             engine and uPlot), largest other asset 22 KB (icon-512.png).
//             Ceilings: ~25% headroom on the total and the largest chunk
//             (the engine and the workspace page are still growing), and a
//             100 KB per-asset ceiling that no single font or image should
//             ever need.
// 2026-09-24  total 280 → 295 KB, largest chunk 100 → 105 KB. main @ 1a8ff06
//             already measured 281 KB total and a 99 KB nodes/7 after the
//             WR2012 check and CHIRPS correction landed; fit provenance and
//             calibration exclusions (issue #4: the fit record panel, the
//             exclusions editor, run comparison's fit-and-validation table,
//             the engine's provenance and diff code) bring it to 289 KB total
//             and 101 KB for nodes/7, the catchment workspace page. No new
//             dependency: the growth is feature code in the page that needs
//             it. ~6 KB of headroom on the total and ~4 KB on the chunk, so
//             the next feature is measured again rather than waved through.
// 2026-09-24  largest chunk 105 → 41 KB (down), total 295 → 411 KB (up).
//             main @ c23545b was already over both: 383 KB total and a 130 KB
//             catchment workspace page chunk (nodes/11). A copy of 940060b,
//             the commit that set 295, re-measures 288 KB, so ~95 KB is the
//             day's feature code, not a new dependency: the help centre
//             (guides, tour, pictures, more content) ~38 KB; the Data and Runs
//             tabs (series preview, double mass, self-checks and runoff trace,
//             run notes) ~16 KB; engine rain / double-mass / verify code in
//             both the page and the calibration worker ~20 KB; the rest
//             spread thin. This change splits the workspace page: only the
//             Overview tab stays in the page chunk; the six other tabs and
//             the Add data / series preview dialogs are dynamic imports
//             (lib/components/common/Lazy.svelte, docs/architecture.md § Code
//             splitting). Largest chunk now 37 KB (the Runs tab); a cold open
//             of a catchment downloads ~89 KB instead of ~298 KB (Runs tab,
//             the heaviest, ~232 KB). The split costs ~22 KB of total (405 KB
//             across 117 files): separate chunks compress worse than one, and
//             the guard deliberately counts every lazy chunk. Headroom ~6 KB
//             on the total and ~4 KB on the chunk, so a tab's code sliding
//             back into the page chunk, or the next feature, fails here.
// 2026-09-25  total 411 → 429 KB; largest chunk stays 41 KB. main @ 0d5712f
//             re-measures 406 KB total and a 37 KB largest chunk (the Runs
//             tab). EWR compliance by the Reserve's assurance rules (engine
//             0.21.0, model.md §2.9c) brings it to 424 KB: the engine's
//             reserve/ code in the page and the calibration worker (~2 KB),
//             the Settings rule-table section ~3 KB and its lazy editor 4 KB,
//             the Runs headline card ~1.5 KB and its lazy Reserve compliance
//             panel 3.4 KB, run comparison ~2 KB, help ~1 KB. The two panels
//             are dynamic imports loaded only when a project or run has a rule
//             table, so a cold open without one costs ~1.5 KB on the Runs tab
//             and ~3 KB on Settings (without the split the Runs chunk hit the
//             41 KB ceiling). No new dependency. Headroom ~5 KB on the total;
//             the largest chunk is 38 KB (the Runs tab), ~3 KB under.
// 2026-09-25  total 411 → 419 KB (issue #9). main @ 657e39e measured 407 KB;
//             by merge time main @ 354bea0 measured 419 KB, already over 411:
//             the multi-day rain accumulations (B4: engine, Settings, Data tab)
//             and the day's help text had landed without a ceiling change. The
//             work below takes 6 KB off (419 → 413 KB), and the ceiling is
//             413 + the usual ~6 KB. Measured on 657e39e (407 → 401 KB):
//             Vite's build.target is now es2022 (frontend/vite.config.ts); the
//             default target down-levelled Svelte 5's class fields into
//             defineProperty/WeakMap helpers. Every page's cold load ~3 KB lighter (a catchment 88 → 85 KB,
//             sign-in 56 → 53). HelpTip now fetches the help text (a 26 KB
//             chunk) off the critical path instead of importing it, which
//             doesn't move the total (the chunk is still shipped and counted)
//             but takes it out of every page and tab with a tooltip: the
//             Network tab 51 → 25 KB on top of the page, Crops 40 → 14,
//             Transfers 36 → 11, Data and Settings −26 each, compare 144 →
//             116 KB cold. Measured and rejected: sharing the engine between
//             the page and the calibration worker (the worker importing the
//             page's calibrate chunk by URL). With Rollup's own grouping the
//             worker drags in app chunks (Svelte runtime, help text) and the
//             fit fails ("window is not defined"); with the engine forced into
//             chunks of its own (the only safe way) the total drops 13 KB but a
//             catchment's cold load grows 88 → 111 KB and compare's 144 → 159,
//             since a shared chunk carries what every importer needs.
//             experimentalMinChunkSize: 1–4 KB off the total for 1–2 KB more
//             on cold loads, not worth it.
// 2026-09-25  total 419 → 435 KB; largest chunk stays 41 KB. Merging #9
//             with the features built in parallel the same day (the Reserve
//             compliance entry above, measured alone on an older main; the
//             nominated evidence run: Runs-tab Evidence panel, badges, compare
//             notes) measures 429 KB with #9's savings in. No new dependency.
//             The largest chunk is 40 KB (the Runs tab), ~1 KB under, so the
//             next Runs-tab feature must lazy-load. Headroom ~6 KB.
// 2026-09-25  total 435 → 449 KB; largest chunk stays 41 KB. The human-impact
//             work packages (WP-1.33 other water users, WP-1.34 groundwater,
//             WP-1.35 land cover; engine 0.22–0.24) add 14 KB: the Network tab's
//             user, borehole and land-cover editors, the schematic's user
//             marker, model validation, the curtailment rows for users and
//             help entries. Their Runs-tab tables are code-split
//             (runs/HumanImpactTables.svelte, loaded only for a run that has
//             any of them): inline, they took the Runs chunk to 42 KB, over
//             its ceiling. Measured 443 KB; the largest chunk is 40 KB (the
//             Runs tab). No new dependency. Headroom ~6 KB.
// 2026-09-25  total 449 → 458 KB; largest chunk stays 41 KB. The hydrologist
//             plausibility checks (engine 0.25.0, model.md §2.10d) measure
//             452 KB: the Runs tab's Plausibility checks panel is its own
//             chunk (runs/PlausibilityPanel.svelte, 6.2 KB: four tables and
//             the dry-season low-flow chart, loaded only for a run that has
//             the checks, on the shared uPlot LineChart), five help entries
//             ~1.5 KB in the help chunk, and the Runs chunk's lazy hook and
//             menu entry ~0.4 KB. The Runs chunk is 40.8 KB, just under its
//             41 KB ceiling, so the next Runs-tab feature must lazy-load or
//             move something out. The engine checks run on the server only
//             and add nothing here. No new dependency. Headroom ~6 KB.
// 2026-09-25  total 449 → 484 KB; largest page chunk stays 41 KB; new
//             largestWorkerKb 55 KB. Uncertainty bands (issue #4 phase 9,
//             engine 0.26.0, model.md §2.10e). Measured on the base
//             48c2fe7 → this change: 443 → 479 KB. The calibration worker
//             30.6 → 49.6 KB: the ensemble runs in the same worker (one engine
//             copy, not two) and every member is a full runModel, so the
//             worker now carries the run's whole output side (curtailment,
//             the EWR grid, Reserve compliance, the WR2012 report, quality
//             checks) that calibrate() never needed, plus the ensemble code.
//             A second worker would have shipped the engine twice (~+30 KB).
//             The rest (~16 KB) is page code, all lazy: the Runs-tab
//             uncertainty panel 8 KB (loaded when a run is shown, not in the
//             Runs chunk, which stays 40.9 KB), the compare page's paired
//             panel, the engine's summary / diff code they share, help text.
//             The worker now dwarfs every page chunk, so it moves to its own
//             ceiling (above) rather than lifting the page ceiling for it.
//             No new dependency. Headroom ~5 KB total, ~5 KB on the worker.
// 2026-09-25  total 458/484 → 503 KB. Merging the plausibility checks (458)
//             and the uncertainty bands (484, measured apart) measures 497 KB.
//             Together they took the Runs chunk to 42 KB, so the WR2012 panel
//             and the evidence panel became lazy chunks too (RunsTab.svelte):
//             the Runs chunk is 39 KB. The calibration worker is 55 KB, at its
//             ceiling: the next thing the ensemble or the fit needs must come
//             out of it first. No new dependency. Headroom ~6 KB.
// 2026-09-25  total 500 → 496 KB; calibration worker 54.5 → 50 KB (the
//             check shows 51, rounding up), ceilings unchanged. The ensemble's
//             members now run runModelWithoutChecks (engine run.ts): runModel
//             less the hydrologist plausibility checks, which no member result
//             reads. Nothing on the worker's import path references
//             ./plausibility any more, so Rollup drops it (~12 KB minified);
//             each member run is also 6–21 % faster on the example catchments.
//             Ensemble results are byte-identical (same seed, same output
//             hash). The ceiling stays at 55 KB so the next ensemble or fit
//             feature has ~4 KB of room. Headroom ~7 KB total.
// 2026-09-25  total 503 → 511 KB; other ceilings unchanged. Four small UI
//             additions taken from the redesign mockups (issue #17, current
//             layout kept) plus the same day's pinned runs (#7) measure 505 KB
//             on main @ c5f6c57: the Overview's Latest run strip and Needs
//             attention panel (overview/LatestRun, NeedsAttention, ~3 KB, in
//             the page chunk since the Overview is the first paint), the run
//             summary sentence and supply bars (runs/runSentence), the
//             schematic's colour-by-supply (network/supplyColour) and the
//             Crops tab's stacked demand chart (MonthlyBars' stacked mode).
//             Each alone fitted under 503; merged they don't. No new
//             dependency; the largest chunk is 39 KB. Headroom ~6 KB.
// 2026-09-25  total 503 → 591 KB; new largestSpreadsheetWorkerKb 95 KB; the
//             page ceiling (41 KB) and the calibration worker's (55 KB) are
//             unchanged. The .xlsx run export (WP-1.28, issue #11): SheetJS
//             CE 0.20.3 in its own module worker (workers/export.worker-*.js),
//             loaded only when someone picks "Workbook (.xlsx)". Measured on
//             the base fe150cb → this change: total 498 → 585 KB. The worker
//             is 87 KB (112 KB with `import from 'xlsx'`; the export imports
//             SheetJS's mini build, xlsx/dist/xlsx.mini.min, which reads and
//             writes .xlsx without the legacy formats and codepages). Page
//             code grows 1.0 KB: the Download menu's workbook item, progress
//             and Cancel (+0.6 KB in its chunk) and the 0.5 KB lazy runner
//             that starts the worker; no page chunk imports SheetJS (the
//             largest chunk is still the Runs tab, 39 KB). The in-browser
//             workbook import (WP-1.31) will share the 95 KB ceiling; it
//             reads .xlsm, so it may need the full build: measure it then.
//             Headroom ~6 KB total, ~8 KB on the spreadsheet worker.
// 2026-09-25  total 591 → 597 KB; spreadsheet worker 87 → 88 KB (ceiling
//             95 unchanged). main @ 6c4af4f already measures 590 KB: the
//             project import dialog (WP-1.8) merged alongside the .xlsx
//             export. This change zips the workbook with the platform's
//             CompressionStream('deflate-raw') instead of SheetJS's
//             fixed-Huffman deflate (lib/spreadsheet/export/zip.ts: a
//             ~45-year, 13-node run 100.8 → 41.2 MB): the export worker
//             +0.8 KB, page code unchanged (+0.1 KB, hash noise). Measured
//             591 KB, at the old ceiling; raised by the usual ~6 KB so the
//             next change is measured rather than failing on the merge.
// 2026-09-25  total 597 → 702 KB; spreadsheet worker 95 → 107 KB; the page
//             ceiling (41 KB) and the calibration worker's (55 KB) are
//             unchanged. The in-browser b023 workbook import (WP-1.31, issue
//             #11). Measured on the base 02b6f1e → this change: total 591 →
//             696 KB. New: workers/import.worker-*.js, 101 KB, loaded only
//             when someone picks a workbook in "Import b023 workbook". It is
//             SheetJS's mini build (the same ~80 KB the export worker
//             carries; mini reads .xlsm as well as .xlsx, measured on both by
//             the parity tests) plus the parser (the TypeScript port of
//             extract_project.py and calibration.py) and the capped zip
//             reader, ~20 KB between them. Two workers can't share SheetJS
//             (each worker bundle carries its own copy), and no page chunk
//             imports it. Page code grows ~4 KB: the dialog's workbook
//             branch (progress, Cancel, errors), the review's gauge option,
//             notes and unmapped report, and the lazy runner that starts the
//             worker; the largest page chunk is unchanged (39 KB). Headroom
//             ~6 KB on both. The durable way down is the streaming sheet
//             reader in followups.md (WP-1.31 peak memory): it would drop
//             SheetJS from this worker altogether.
// 2026-09-25  total 702 → 712 KB; other ceilings unchanged. Merge of issue
//             #11 (spreadsheets: the .xlsx export and b023 import workers,
//             692 KB on its own after the fragmentation exports merged) with
//             the same day's parallel work on origin (the entry above, 503 →
//             511, and the compare per-node daily overlay, #8). Each fitted
//             its own ceiling; together they measure 706 KB. No new
//             dependency; the largest page chunk is 39 KB, both workers are
//             unchanged. Headroom ~6 KB.
// 2026-09-25  total 712 → 720 KB; other ceilings unchanged. The preview of
//             the run's all-farms downloads (Download menu → Preview beside
//             Fragmented flow / EWR): main @ 4bd52a2 measures 710 KB, with it
//             714. Its dialog (export/DailyTableDialog.svelte plus the CSV
//             parser lib/export/dailyTable.ts) is a 2.9 KB chunk of its own,
//             fetched only when a Preview is clicked, so no page's first load
//             grows; the menu's Preview button and the RunsTab hook add
//             ~0.3 KB. No new dependency; the largest page chunk is 40 KB.
//             Headroom ~6 KB.
// 2026-09-25  total 720 → 722 KB; other ceilings unchanged. Issue #10 part 2
//             (data feeds, WP-2.10): Settings → Data feeds is its own lazy
//             chunk (DataFeedsPanel + feeds.ts, ~5 KB gzip JS + <1 KB CSS),
//             loaded only on the Settings tab; SettingsTab grows by the
//             loader. No dependency. Merged with the all-farms preview above it
//             measures 722 KB: no headroom left, so the next growth must
//             trim (issue #9) rather than raise this again.
//
// Run:   pnpm build:frontend && pnpm check:bundle
// CI:    ci.yml, job `test`, after `pnpm build`.
// Tests: node --test scripts/guards/check_web_bundle_budget.test.mjs

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = Object.freeze({
	totalCodeKb: 722,
	largestChunkKb: 41,
	largestWorkerKb: 55,
	largestSpreadsheetWorkerKb: 107,
	largestAssetKb: 100,
});

/** A Web Worker bundle (Vite emits them under `workers/`). */
const WORKER = /(^|\/)workers\//;
/** A spreadsheet worker: lib/spreadsheet's export.worker.ts / import.worker.ts (Vite names the bundle after the source). */
const SPREADSHEET_WORKER = /(^|\/)workers\/(export|import)\.worker-[^/]*$/;

const CODE = /\.(m?js|css)$/;

/** @param {number} bytes */
export const kb = (bytes) => Math.ceil(bytes / 1024);

/**
 * @param {{ path: string, gzipBytes: number }[]} files
 */
export function measure(files) {
	let codeBytes = 0;
	let codeCount = 0;
	let largestChunk = { path: '', gzipBytes: 0 };
	let largestWorker = { path: '', gzipBytes: 0 };
	let largestSpreadsheetWorker = { path: '', gzipBytes: 0 };
	let largestAsset = { path: '', gzipBytes: 0 };
	for (const f of files) {
		if (CODE.test(f.path)) {
			codeBytes += f.gzipBytes;
			codeCount += 1;
			if (SPREADSHEET_WORKER.test(f.path)) {
				if (f.gzipBytes > largestSpreadsheetWorker.gzipBytes) largestSpreadsheetWorker = f;
			} else if (WORKER.test(f.path)) {
				if (f.gzipBytes > largestWorker.gzipBytes) largestWorker = f;
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
		largestWorker: { path: largestWorker.path, kb: kb(largestWorker.gzipBytes) },
		largestSpreadsheetWorker: { path: largestSpreadsheetWorker.path, kb: kb(largestSpreadsheetWorker.gzipBytes) },
		largestAsset: { path: largestAsset.path, kb: kb(largestAsset.gzipBytes) },
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
			`Total gzipped JS+CSS is ${m.totalCodeKb} KB, over the ${budget.totalCodeKb} KB budget. Trim weight, or raise BUDGET.totalCodeKb in scripts/guards/check_web_bundle_budget.mjs with a dated change-log entry explaining the growth.`,
		);
	}
	if (m.largestChunk.kb > budget.largestChunkKb) {
		out.push(
			`Largest chunk ${m.largestChunk.path} is ${m.largestChunk.kb} KB, over the ${budget.largestChunkKb} KB per-chunk budget. This usually means one heavyweight dependency landed in one chunk; check it is needed before raising the ceiling.`,
		);
	}
	if (m.largestWorker.kb > budget.largestWorkerKb) {
		out.push(
			`Web Worker ${m.largestWorker.path} is ${m.largestWorker.kb} KB, over the ${budget.largestWorkerKb} KB per-worker budget. A worker ships its own copy of what it imports; check a new import is needed there before raising the ceiling.`,
		);
	}
	if (m.largestSpreadsheetWorker.kb > budget.largestSpreadsheetWorkerKb) {
		out.push(
			`Spreadsheet worker ${m.largestSpreadsheetWorker.path} is ${m.largestSpreadsheetWorker.kb} KB, over the ${budget.largestSpreadsheetWorkerKb} KB spreadsheet-worker budget. It carries SheetJS; check a new import (or the full SheetJS build) is needed before raising the ceiling.`,
		);
	}
	if (m.largestAsset.kb > budget.largestAssetKb) {
		out.push(
			`Asset ${m.largestAsset.path} is ${m.largestAsset.kb} KB gzipped, over the ${budget.largestAssetKb} KB per-asset budget. Subset the font or compress the image rather than raising the ceiling.`,
		);
	}
	return out;
}

/** @param {string} dir */
function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

function main() {
	const buildDir = process.argv[2] ?? 'frontend/build';
	let paths;
	try {
		paths = walk(buildDir);
	} catch {
		console.error(`::error::No build output at ${buildDir}. Run pnpm build:frontend first.`);
		process.exit(1);
	}
	const files = paths.map((p) => ({ path: relative(buildDir, p), gzipBytes: gzipSync(readFileSync(p)).length }));
	const m = measure(files);
	const rows = [
		['Total gzipped JS+CSS', `${m.totalCodeKb} KB`, `${BUDGET.totalCodeKb} KB`],
		[`Largest chunk (${m.largestChunk.path})`, `${m.largestChunk.kb} KB`, `${BUDGET.largestChunkKb} KB`],
		[`Largest worker (${m.largestWorker.path || 'none'})`, `${m.largestWorker.kb} KB`, `${BUDGET.largestWorkerKb} KB`],
		[`Largest spreadsheet worker (${m.largestSpreadsheetWorker.path || 'none'})`, `${m.largestSpreadsheetWorker.kb} KB`, `${BUDGET.largestSpreadsheetWorkerKb} KB`],
		[`Largest other asset (${m.largestAsset.path || 'none'})`, `${m.largestAsset.kb} KB`, `${BUDGET.largestAssetKb} KB`],
	];
	for (const [what, size, budget] of rows) console.log(`${what}: ${size} (budget ${budget})`);
	console.log(`Files measured: ${m.fileCount} (${m.codeCount} JS/CSS)`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const table = ['## Web bundle budget', '', '| Metric | Size | Budget |', '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n') + '\n');
	}
	const bad = violations(m);
	for (const v of bad) console.error(`::error::${v}`);
	process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
