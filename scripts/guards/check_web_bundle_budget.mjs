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
//                   (lib/calibration/autocal.worker.ts). Since issue #9 it is
//                   an entry of the page build (frontend/vite.config.ts,
//                   autocalWorkerChunk), not a bundle of its own: its file
//                   holds the code only it runs (the run, the fit, the
//                   ensemble) and imports the engine code it shares with pages
//                   from chunks/, which count as page chunks. It loads only
//                   when a fit or an uncertainty ensemble starts, never on
//                   navigation, so it has its own ceiling instead of the page
//                   chunks'. It still counts in totalCodeKb. The guard also
//                   fails if it stops importing from chunks/ (a worker built
//                   with `new Worker(new URL(…))` would carry a second engine
//                   copy again).
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
//   landingKb       the public landing page's own code (issue #57): every
//                   chunk holding a module of frontend/src/lib/components/landing/,
//                   with its CSS, summed. It is the first thing a new visitor
//                   downloads, so it has a ceiling of its own; the guard fails
//                   if it finds no landing chunk, or finds the landing in the
//                   root layout's or the projects page's chunk (it must stay a
//                   chunk of its own, loaded only for a signed-out visitor).
//                   Still counted in totalCodeKb.
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
//             long multi-node run about 2.5× smaller): the export worker
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
// 2026-09-25  total 712 → 637 KB, spreadsheet worker 107 → 95 KB (both
//             down); the other ceilings unchanged. The b023 import worker no
//             longer carries SheetJS: it reads the workbook with its own
//             streaming OOXML reader (frontend/src/lib/spreadsheet/import/
//             xml.ts, sheet.ts, sharedStrings.ts, workbookParts.ts; the
//             followups.md WP-1.31 peak-memory item). workers/import.
//             worker-*.js 101 → 25 KB; the total measures 631 KB on this
//             change over main @ 97c9e29 (706 KB in the entry above: the
//             ~76 KB is the import worker's SheetJS). The largest spreadsheet worker is
//             now the .xlsx export's (88 KB, SheetJS's mini build), so the
//             ceiling goes back to the 95 KB it had before the import
//             landed, ~7 KB over it. Page code unchanged (largest chunk
//             39 KB). Headroom ~6 KB on the total.
// 2026-09-25  total 720 → 644 KB (down); other ceilings unchanged. Merge of
//             the two entries above: the all-farms preview (714 KB on its
//             own) and the SheetJS-free import worker (631 KB on its own over
//             an older main). Together they measure 638 KB; the ratchet takes
//             the ceiling down with them rather than keeping the preview's 720.
//             Largest page chunk 40 KB, export worker 88 KB. Headroom ~6 KB.
// 2026-09-25  total 644 → 652 KB; other ceilings unchanged. Issue #10 part 2
//             (data feeds, WP-2.10): Settings → Data feeds is its own lazy
//             chunk (DataFeedsPanel + feeds.ts, ~5 KB gzip JS + <1 KB CSS),
//             loaded only on the Settings tab; SettingsTab grows by the
//             loader. No dependency. Measures 646 KB merged with the entries above;
//             headroom ~6 KB.
// 2026-09-25  total 652 → 665 KB; largest chunk down 39 → 35 KB (ceiling
//             unchanged). The printable catchment report (WP-2.15 Phase A,
//             issue #19): a new lazy route, routes/projects/[id]/report,
//             loaded only when someone opens a report. Measured on the base
//             acb09ad → this change: 645.3 → 658.7 KB (+13.4). The route's
//             own chunk is 6.8 KB (the page, its data-driven section list and
//             the Inputs tables, lib/components/report/) plus ~1.8 KB of CSS
//             (its print styles, and the component CSS that now sits in
//             shared files). The rest, ~4 KB, is chunking, not new code: the
//             report reuses the Runs tab's panels (summary, calibration,
//             curtailment, EWR grid, self-checks, Reserve compliance) and the
//             Network tab's schematic rather than copying them, so Rollup
//             moves them out of those tabs' chunks into chunks shared with
//             the report, and separate chunks compress worse. It is also why
//             the Runs tab's own chunk shrank, 39 → 16 KB (the largest chunk
//             is now another, 35 KB).
//             LineChart's print mode (fixed box at 2 device px per CSS px,
//             plain legend, synchronous light redraw on beforeprint) and the
//             panels' print props are ~0.5 KB. No new dependency; no page's
//             first load grows. Headroom ~6 KB.
// 2026-09-25  total 665 → 673 KB; other ceilings unchanged. Server-side PDF
//             reports (WP-2.15 Phase B, issue #26). Measured on the base
//             3eb0bb8 (658.7 KB, as the entry above left it) → this change:
//             667.4 KB (+8.7). All of it is lazy: the report page's "Generate
//             PDF / Email me the PDF" control and its status polling
//             (report/ServerPdf.svelte, 1.0 KB, loaded with the report's
//             bar), the shared report-API helpers (report/serverPdf.ts,
//             1.2 KB), Settings → Scheduled reports
//             (report/ReportSchedulesPanel.svelte, 3.3 KB, loaded with the
//             Settings tab like the data feeds panel), and the emailed
//             link's download page, routes/projects/[id]/reports/[jobId]
//             (1.4 KB). The rest, ~1.8 KB, is the Lazy wrappers in the report
//             page and the Settings tab, and the route manifest. No new
//             dependency; no page's first load grows except the report's by
//             ~0.3 KB. Headroom ~6 KB.
//
// 2026-09-25  total 665 → 707 KB; other ceilings unchanged. Two changes
//             merged together: the phone-first farmer view below (+35 KB,
//             measured on its own base) and WP-2.3's Publication panel on the
//             Runs tab (publish, notice editor, the Published badge, ~6 KB in
//             the Runs chunks). Measured merged over main e097008: 701 KB.
//             Headroom ~6 KB. Issue #9 (bring the bundle down) still stands:
//             the farm view's ~35 KB loads only for farmers, but the total
//             guard counts every lazy chunk. The farmer view's share,
//             measured on its own base (647 → 682 KB): the phone-first
//             farmer view (WP-2.6, issue #25, docs/design/farmer-view.md):
//             /farm, /farm/[projectId] and its "Why?" and dam pages, the
//             farmer glossary page. Measured on the base eaafecd → this
//             change: 647 → 682 KB. The farm routes are their own chunks,
//             loaded by nobody but a farmer (or WUA staff previewing): ~24 KB
//             reachable only from them (the main farm page 6 KB, "Why?" 4.5,
//             dam 3.6, the shared wording/format/chart modules 5.8, the
//             cards' shared chunk 1.8, the rest small), the farm frame
//             (FarmShell, Menu, saved copy) ~4 KB, their CSS ~3 KB, and the
//             farmer help entries ~2 KB in the help chunk. A farmer's cold
//             load of their farm is ~73 KB of JS, lighter than the project
//             list; no workspace page gets heavier (the largest chunk is
//             still 39 KB). Charts are inline SVG, not uPlot. No new
//             dependency. Headroom ~6 KB.
// 2026-09-25  total 707 → 719 KB; other ceilings unchanged. Merge of the
//             server-side PDF reports (the 665 → 673 entry above, +8.7 KB,
//             all lazy) with the farmer view and Publication panel (707).
//             Measured merged: 713 KB. Headroom ~6 KB.
// 2026-09-25  total 719 → 726 KB; other ceilings unchanged. Read-only share
//             links (WP-2.3 phase 2). Measured on origin/main 93dcd56 → this
//             change: 711 → 720 KB (+9.2 KB). The public /share page is its
//             own route chunk (5.3 KB JS + 0.9 KB CSS: the page, its wording,
//             chart and loading modules and the flow chart; it reuses the
//             farm view's NoticeCard, whose CSS is now a 0.4 KB chunk of its
//             own) and is fetched only by someone opening a link; the
//             Overview's owner-only Share links panel adds ~1.9 KB to the
//             workspace page chunk and the API client ~0.3 KB. Inline SVG, no
//             new dependency; the largest chunk is unchanged (37 KB).
//             Headroom ~6 KB.
// 2026-09-26  total 726 → 740 KB; other ceilings unchanged. Change history
//             and audit log (WP-2.4, issue #28): the History tab
//             (lib/components/history/, its own lazy chunk, loaded only on
//             ?tab=history), the Runs tab's "Changes since this run" /
//             "Restore these inputs" panel, the save bar's reason field and
//             the history API client. Measured over main 6b3bf18: 722 → 734
//             KB (+12). No page's first load grows; the largest chunk is
//             still 37 KB. No new dependency. Headroom ~6 KB. Issue #9 still
//             stands.
// 2026-09-26  total 740 → 754 KB; other ceilings unchanged. The CHIRPS fit
//             period (issue #40 (a), engine 0.29.0). Measured on its base
//             af9dac3 → the branch: 716 → 725 KB (+8.7 KB); merged over main
//             8712d0e: 748 KB. Chunks +6.3 KB:
//             the engine's per-range fit, proposal, reference windows and
//             their warning/CSV/compare wording (rain.ts, doublemass.ts,
//             compare.ts, in the shared engine chunks), the Settings control
//             (ChirpsFitPeriodSection, the proposal loader), fit provenance
//             and compare-note lines, and the CHIRPS fit period help entry.
//             The autocal worker +2.1 KB: it bundles its own copy of the
//             engine's rain code, so the same additions count twice. CSS
//             +0.2 KB. Nothing is a new dependency; the Settings tab and the
//             worker are lazy, so no page's first load grows by more than the
//             shared engine share. Headroom ~6 KB. Issue #9 (bring the bundle
//             down) still stands.
// 2026-09-26  total 754 → 760 KB; other ceilings unchanged. CHIRPS product
//             and version (issue #40 (c)): the b023 import review's CHIRPS
//             column choice, the Upload CSV and series-row version selects,
//             the Data feeds panel's product / start-date fields, version
//             question and staged-replacement progress (its own lazy chunk),
//             the Data / Runs tab rebuilding notes, and the fit record's
//             CHIRPS source row and comparison. Measured merged over main
//             f072a83: 748 → 753 KB (+5). No new dependency; the largest
//             chunk is unchanged (38 KB). Headroom ~7 KB. Issue #9 still
//             stands.
// 2026-09-26  total 760 → 774 KB, calibration worker 55 → 57 KB; other
//             ceilings unchanged. Rain-source periods (issue #40 (b), engine
//             0.30.0). Measured over main 59225ac (753 KB) → the branch:
//             768 KB (+15). The engine's rainSourcePeriods.ts (the resolver
//             and its messages, the fit, the fallbacks, the run warning, the
//             CSV/compare wording) sits in the shared engine chunks and,
//             since a fit must run the forcing it records, again in the
//             autocal worker (+~2 KB there: it bundles its own engine copy,
//             so the same code counts twice). The rest: Settings → Rain
//             source periods (RainSourceSection + settings/rainSource.ts,
//             in the lazy Settings chunk), the Upload form's sub-daily day
//             boundary and free product fields with the CSV aggregation,
//             three help entries, the fit provenance row, the compare note
//             and the report's inputs row. No new dependency; the largest
//             page chunk is unchanged (39 KB). Headroom ~6 KB on the total.
//             Issue #9 still stands.
// 2026-09-26  total 774 → 782 KB; other ceilings unchanged. A separate GR4J
//             PE input and the FAO-56 Table 5 helper (issue #39, engine
//             0.31.0). The branch measured 776 KB. The engine's PE resolver,
//             provenance, compare and ensemble wording sit in the shared
//             engine chunks; the Table 5 lookup (96 cells) and its Settings
//             panel (PanCoefficientHelper) load only when Settings shows
//             the pan coefficient, as a code-split chunk; the rest is the
//             PE control in the lazy Settings chunk (settings/peInput.ts),
//             help entries, and the fit provenance and report rows. No new
//             dependency; the largest page chunk is 40 KB. Headroom ~6 KB.
// 2026-09-26  total 782 → 809 KB; other ceilings unchanged. The Scenarios
//             tab (issue #18 stage D): the list, the override editor and its
//             "Add a change" form for every ScenarioOp, the op list with the
//             baseline callout, and the scenario-vs-base compare section.
//             Measured on the branch (off main 0b3f51c) at 795 KB, over a 774 KB base, of which
//             the two new lazy chunks are ~24 KB gzip (the tab, editor, form
//             and compare section ~13 KB; the op list with the field specs,
//             op descriptions and op builder, scenarios/fields.ts + ops.ts,
//             ~10 KB) plus ~1 KB of CSS. Both load only on ?tab=scenarios
//             (the op list also on a compare page with a scenario side); the
//             engine code they call is already in the shared engine chunk.
//             No new dependency; the largest page chunk is unchanged
//             (39 KB). Headroom ~6 KB on the total. Issue #9 still stands.
// 2026-09-26  total 809 → 821 KB; other ceilings unchanged. The batch merge
//             of #5 (the /account page), #6 (tabs by role, lib/workspace/
//             tabs.ts), #22 (the import's openpyxl decoding), #27 (the Invite
//             farmers dialog with its CSV preview and pending invites) and
//             #18 with its GR4J PE field, on main with #39's pan-coefficient
//             source note. Each branch alone fit its own base's ceiling; the
//             merge measured 815 KB (783 before #18 went in). The account page
//             and the invite dialog are their own lazy chunks; tabs.ts is
//             ~1 KB in the project page. No new dependency; the largest page
//             chunk stays under 41 KB. Headroom ~6 KB. #9 (engine shipped
//             twice, help text loaded eagerly: ~50 KB) is now the next job.
// 2026-09-26  ceilings unchanged (issue #9, second pass). main @ 61ef104
//             measures 815 KB. Help text: already off the critical path
//             since the first pass (HelpTip imports it lazily; help.spec.ts
//             pins open, Escape and focus return), and it is counted once, so
//             nothing is left to win on the total. Landed: the engine is
//             side-effect free to Rollup (frontend/vite.config.ts
//             treeshake.moduleSideEffects, guarded by
//             src/lib/engineSideEffects.test.ts). The total doesn't move (815),
//             but engine code no longer follows phantom barrel imports into
//             pages that never call it. First loads, gzip: farm pages 76–86 →
//             64–74 KB (−13), share 77 → 65, home 89 → 81, a catchment 126 →
//             118; that engine code now loads with the tabs that call it
//             (Data 61 → 67, Settings 76 → 81, Runs 114 → 120, Scenarios +3),
//             so a catchment opened on Runs is 240 → 238. Compare 114 → 111,
//             report 181 → 178. Measured and not landed:
//             - Worker as a chunk of the page build (a plugin emitting
//               autocal.worker.ts as a Rollup entry, the page taking its URL
//               from a virtual module), so it shares the page's engine chunks:
//               total 815 → 794 (−21), but a chunk holds whole modules, and
//               the page's small imports from run.ts (prepareRun, ENGINE_VERSION,
//               mergeSettings), calibrate.ts (CALIBRATION_PARAMS…), gr4j.ts and
//               legacy.ts (their param tables) then drag the worker's whole
//               run/network/calibration code in: Runs 120 → 147, Settings
//               81 → 110, compare 111 → 144, report 178 → 210. With those
//               exports moved to modules of their own (tried throwaway:
//               prepare.ts, version.ts, calibrate/params.ts) the total is 798
//               (−17) and, against the landed config, compare 111 → 102 and
//               Runs 120 → 118 but a catchment +4, Data +6, Settings +3.5,
//               report +3.5, farm +1 (the rest: gr4j.ts and legacy.ts param
//               tables share a module with the runoff code, wr2012.ts and
//               objective.ts mix page and fit code). A fuller engine split is
//               the real fix; it waits for a quiet engine (docs/followups.md,
//               "Stop shipping the engine twice").
//             - experimentalMinChunkSize 5000: total −6 KB, every first load
//               +3.5 to +8 KB. At 1500: −2 KB total, +2 KB on every page.
//             - Svelte css: 'injected' (80 CSS files, 65 of them under 1 KB,
//               cost ~23 KB of gzip overhead): total +6 KB, largest chunk 42.
// 2026-09-26  total 821 → 837 KB for WP-3.1's reproduce panel and WP-3.13's
//             validation statement, sign-off dialog and disclaimer (report
//             sections), merged together on main. The reproduce panel and
//             the sign-off dialog are lazy chunks; the report grows by its
//             three closing sections. No new dependency; the largest page
//             chunk stays under 41 KB. The engine split (#9) is still the
//             way to win the total back.
// 2026-09-26  total 837 → 844 KB; other ceilings unchanged. Notes and
//             comments (WP-2.7): the notes drawer and its count badges on
//             network rows, the run Record group and the settings groups,
//             Recent notes on the Overview, and the farmer's notes card.
//             Merged after #44's reporting-window picker and WP-3.1/3.13
//             above; the merge measured 838 KB (the notes branch alone was
//             +8 KB). The drawer is mounted from several tabs, so most of it
//             sits in shared chunks. No new dependency; the largest page
//             chunk stays 40 KB. Headroom ~6 KB. #9's engine split (~20 KB,
//             docs/followups.md) is the way back down.
// 2026-09-26  total 844 → 874 KB (measured 872 merged with the notes
//             above; 866 before them), calibration worker 57 → 61 KB
//             (measured 59); other ceilings unchanged. One batch
//             merge: WP-3.10's Allocations tab (import, compare, table),
//             WP-3.4's Assurance of supply and Water account panels plus the
//             engine's reliability module (network/reliability.ts, part of
//             every run summary, so it lands in the calibration worker too),
//             and WP-3.7's low-flow / high-flow Reserve code in the engine
//             (reserve/) with its settings editors and heat map. No new
//             dependency; the largest page chunk stays at 41 KB. The engine
//             split (#9) is the way back for both the total and the worker.
// 2026-09-26  total 874 → 885 KB (measured 883 merged with main's WP-2.9
//             API keys panel, which raised no ceiling of its own; 878
//             before it); other ceilings unchanged.
//             WP-3.6's firm yield: the Yield panel on a farm and under a
//             scenario (its own lazy chunk), its helpers and the jobs/yield
//             API client. The search itself runs in the job worker on the
//             backend, so the engine's network/yield.ts adds little here. No
//             new dependency; the largest page chunk stays 41 KB. The engine
//             split (#9) is still the way back.
// 2026-09-26  total 885 → 892 KB; other ceilings unchanged. The WUA
//             portfolio dashboard (WP-2.14): /teams/:id/portfolio, its own
//             lazy route chunk (~6 KB gzip: the table, the phone cards, the
//             traffic-light wording and sorting), plus links from the team
//             page and the project list. Merged on main after WP-3.6's yield
//             panel (885); the merge measured 886 KB. No page's first load
//             grew; no new dependency; the largest page chunk stays 40 KB.
//             Headroom ~6 KB. #9's engine split is still the way back down.
// 2026-09-26  total 892 → 900 KB (measured 898), largest chunk 41 → 43 KB
//             (measured 42); calibration worker stays 61 (measured 60).
//             WP-3.5's dam storage: the survey-curve paste and chart, the
//             release rule, seepage share and monthly lake factors in the
//             Network editor, the engine's network/dam.ts (in every run, so
//             in the calibration worker too), and the water account's two
//             new lines. The largest chunk is lib/help/content.ts, the whole
//             help text in one module, grown by the dam entries; the way back
//             is one module per help category (docs/followups.md §
//             Housekeeping), and #9's engine split for the total. No new
//             dependency.
// 2026-09-26  total 900 → 909 KB (measured 905; 907 merged with main's
//             WP-2.11 automatic re-runs, which raised no ceiling), calibration worker
//             61 → 64 KB (measured 62); largest chunk stays 43 KB (measured
//             42.2, the help content: no headroom left, so the split in
//             docs/followups.md § Housekeeping is next). WP-3.9's individual
//             boreholes: the borehole form on a node, the borehole scenario
//             ops and the groundwater-by-water-year table, and the engine's
//             network/boreholes.ts supply order and annual use (in every run,
//             so in the calibration worker too). No new dependency. #9's
//             engine split is the way back for the total and the worker.
// 2026-09-26  total 909 → 921 KB (measured 914; 919 merged with main's
//             WP-2.12 forecast mode, which raised no ceiling); other ceilings unchanged
//             (largest chunk still the help content at 43, worker 62 of 64).
//             WP-3.3's applicants: the Applicant view, the Application panel
//             and the assessors' Applications tab, each a lazy chunk, and the
//             applicant mode of the Scenarios tab. No new dependency. #9's
//             engine split is the way back for the total.
// 2026-09-26  total 921 → 929 KB; other ceilings unchanged. Scenario
//             override mode (#18 follow-up): the Network, Crops and Transfers
//             tables on a scenario's model, its own lazy chunk (~5.7 KB gzip,
//             loaded only on "Edit in the model tables"), and the scheduled
//             forecast run's labels. Merged on main after WP-2.16 and WP-3.3
//             (915); the merge measured 923 KB. No page's first load grew;
//             no new dependency. Headroom ~6 KB. #9's engine split is still
//             the way back down.
// 2026-09-26  total 921 → 905 KB (measured 899, down from 919), calibration
//             worker 64 → 35 KB (measured 33; it is now only the worker's own
//             code); largest chunk stays 43 KB (the help content). Issue #9:
//             the engine no longer ships twice. The calibration worker is an
//             entry of the page build (frontend/vite.config.ts,
//             autocalWorkerChunk: the page takes its URL from
//             'virtual:autocal-worker-url'), so it imports the engine code it
//             shares with pages from chunks/ instead of bundling a copy. That
//             only pays once the small things pages read live apart from the
//             run, fit and ensemble code, so those moved to modules of their
//             own: version.ts (ENGINE_VERSION), prepare.ts (prepareRun),
//             calibrate/params.ts, calibrate/objectives.ts, runoff/params.ts,
//             runoff/pet.ts, reference/wr2012Settings.ts (+ wr2012Resolve.ts),
//             uncertainty/options.ts, network/damCurve.ts, and waterYearOf /
//             waterYearLabel into calendar.ts; frontend/src/lib/
//             engineSplit.test.ts keeps them apart. First loads, gzip, against
//             main @ e9c88b2: compare 114 → 92 (−22), a catchment on Runs
//             256 → 249 (−7), Settings 212 → 211, report 192 → 187; home,
//             farm, share and a catchment's other tabs within ±0.6; the Data
//             tab 195 → 197 (+2.7) and its series preview +4.3, where engine
//             code the worker also runs now sits in shared chunks (more,
//             smaller files compress worse). Starting a fit from Settings
//             fetches 45 KB of worker code (was 62); a cold worker with
//             nothing cached is 74 KB over 23 files. The guard now also fails
//             if the calibration worker stops importing from chunks/.
// 2026-09-26  total 929 → 913 KB (measured 907). Merging #9's engine split
//             (899 on e9c88b2) with main's scenario override mode and the
//             applicant share picker (+8). Headroom ~6 KB.
// 2026-09-26  total 929 → 941 KB; other ceilings unchanged. The i18n
//             foundation (WP-2.5): the farmer-facing message catalogue
//             (English, ~8 KB gzip; Afrikaans loads lazily and is empty until
//             translated), the language switchers and locale-aware farm
//             formatting. The catalogue loads only on the sign-in, farm and
//             account routes (a dynamic import from the root layout, guarded
//             by lib/i18n/boundary.test.ts), so the workspace's and /share's
//             first loads didn't grow; the total counts lazy chunks, so it
//             rose by the catalogue plus ~2 KB of split overhead. The merge
//             measured 935 KB. Ways back down, both in docs/followups.md:
//             English-as-key (drop the English catalogue, ~5–7 KB) and #9's
//             engine split (~20 KB). No new dependency; the largest page
//             chunk is at its 43 KB ceiling. Headroom ~6 KB.
// 2026-09-26  total 941 → 925 KB (measured 919). #9's engine split (−20)
//             merged with WP-2.5's i18n foundation (+12). Headroom ~6 KB.
// 2026-09-26  total 925 → 935 KB. origin/main measured 928 (over its own
//             ceiling) after the alert pages (WP-2.13) and the commits
//             merged since the 925 entry; the grouped workspace navigation
//             (issue #17, option A step 1: sections, sidebar CSS) adds ~1 KB
//             to the page chunk, measuring 929. Headroom ~6 KB.
// 2026-09-26  largest chunk 43 → 42 KB (down); total 935 → 940 KB (up).
//             The help text split (issue #9's last item, docs/followups.md):
//             lib/help/content.ts, one 42.2 KB chunk and the largest page
//             chunk, is now tips.ts (term, short, units, field keys; 10.4 KB,
//             all a HelpTip fetches), articles.ts (the long text, joined by
//             content.ts for the /help pages; 32.3 KB with it) and farmer.ts
//             (2.2 KB, all /farm/words loads). A tooltip fetches 10 KB
//             instead of 42, a farmer's words page 2 instead of 42. The
//             split costs ~3 KB of total (measured on main @ 3ada6d9: 928 →
//             931): smaller chunks compress worse, and this guard counts
//             every chunk. Merged over main @ 3af5d05: 934 KB. Measured
//             and rejected: one module per category behind an id → category
//             index, +9 KB of total for about the same tip download. The
//             largest page chunk is now the Settings tab's, 41.4 KB. No new
//             dependency. Headroom ~6 KB on the total. The ways down are
//             unchanged: English-as-key i18n (~5–7 KB, docs/followups.md).
// 2026-09-26  total 940 → 945 KB. Issue #17, option A steps 2–3: the
//             Summary's Flow vs reserve chart (its own lazy chunk) and the
//             Compare runs tab, where the /compare page's body became
//             CompareView, a chunk shared by the page and the workspace tab
//             (split overhead), plus the tab's wiring and links. Measured
//             937 → 940 over main @ d443df7. Headroom ~5 KB.
// 2026-09-26  total 945 → 953 KB. main had reached the 945 ceiling with the
//             merges since the entry above; issue #17 step 4 adds the farm
//             drawer (its own chunk), the Dialog side variant and the entry
//             links on the Summary and the Network: 945 → 948. Headroom ~5 KB.
// 2026-09-26  total 945 → 948 KB. Issue #45, series import formats: the
//             per-file delimiter and decimal-separator reader (semicolon and
//             tab files with decimal commas, quoted fields, thousands
//             separators) and the DWS export reader, on the engine's DWS row
//             parser shared with the feed, plus the upload summary's DWS
//             lines. Measured 945 → 948 (+3.0 KB, 966 406 → 969 461 bytes)
//             over main @ 7f49dd4, all in the lazy upload-form chunk (+2.9 KB)
//             and the help guide; largest chunk unchanged. No headroom left.
// 2026-09-26  total 953 → 957 KB (measured 952). Merging #17 step 4's farm
//             drawer (948) with #45's import formats (+3, lazy upload chunk)
//             and main since. Headroom ~5 KB.
// 2026-09-26  total 945 → 947 KB. Issue #45's display and export items:
//             fmtQty (small flows to two significant figures), the FDC
//             percentile table moved into the engine (views/fdc.ts, now
//             shared by the Runs tab chart and the report page's new
//             table), the workbook's per-cell small-value format, and the
//             project time-zone field in Project details. Measured 945 →
//             946 over main @ 7f49dd4 (main itself was at its ceiling). No
//             new dependency; the export code stays in its worker. Headroom
//             ~1 KB; the ways down are unchanged (English-as-key i18n).
// 2026-09-26  total 957 → 963 KB (measured 958). #45's display and export
//             fixes (fmtQty for small values, the FDC percentile table from
//             the engine, the project time-zone field: ~1 KB) merged with the
//             #45 import, A-pan and label work. Headroom ~5 KB.
// 2026-09-26  total 957 → 958 KB. Issue #45, fit provenance of the daily
//             A-pan series: the fit record's fingerprint (SHA-256 of the
//             series' values via crypto.subtle), its row and caveat in the
//             fit record view, Settings' fetch-and-hash of the live series,
//             and the run comparison's "another daily A-pan series". main
//             measured 957 at its own ceiling; this measured 958 (+<1 KB,
//             rounding up). Largest chunk unchanged. No headroom left.
// 2026-09-26  total stays 963 KB (measured 959): the daily A-pan fit
//             fingerprint (+1 KB) merged over the entry above. Headroom ~4 KB.
// 2026-09-26  total 957 → 963 KB. main measured 955 (merges since the 957
//             entry); the Summary's Dam levels panel (issue #17 follow-on,
//             its own lazy chunk: the panel and the damLevels reduction)
//             adds 3: 958. Headroom ~5 KB. The way down is still
//             English-as-key i18n (~5–7 KB, docs/followups.md).
// 2026-09-26  total 963 → 967 KB (measured 962). main's own 957 → 963 entry
//             and this branch's #45 display/export and A-pan fingerprint
//             entries each assumed the other's growth absent; merged they
//             measure 962. Headroom ~5 KB.
// 2026-09-26  total 967 → 973 KB. main measured 963; issue #17's grid modal
//             and the Network's Map layout add 5 (968): the modal and its
//             save row (their own lazy chunk; the grids inside are the Crops
//             and Transfers tabs' existing chunks, not copies), the node card
//             and node list, and lib/workspace/overlays.ts. Headroom ~5 KB.
//             Four raises today: the English-as-key i18n trim (~5–7 KB,
//             docs/followups.md) is due before the next.
// 2026-09-26  total stays 973 KB (measured 969: 969.8 → 968.4 exact). The
//             English-as-key i18n trim (issue #9): messages are their
//             English at the call, af.ts keyed by a hash, no English
//             catalogue. It saved 1.4 KB, not the 5–7 estimated: the keys are
//             gone, but the English compresses worse spread over the pages'
//             chunks than in one 11 KB catalogue chunk. The win is in first
//             loads, 6–9 KB each on the translated routes (farm 97.9 → 91.8,
//             sign-in 71.5 → 63.0, /share 74.3 → 65.7). New measurement + 5
//             would be 974, over the current ceiling, so it stays; headroom
//             ~4 KB. Build-time key shortening is moot: no keys are left.
// 2026-09-26  total 973 → 892 KB, spreadsheet worker 95 → 32 KB (both
//             down). Issue #9: origin/main @ ed1d29a measured 977 KB (over
//             973, with the i18n trim above and the WP-3.8 / #53 work);
//             merged with this work it measures 887 KB (908 107 bytes).
//             Found with a per-module attribution of a sourcemapped build;
//             each step measured alone on main @ 1ded742 (970 KB): the
//             spreadsheet workers get the engine treeshake rule (worker.
//             rollupOptions; import worker −0.7), the run export writes its
//             own OOXML instead of shipping SheetJS (spreadsheet/export/
//             writer.ts, byte for byte the files SheetJS wrote; export worker
//             88.4 → 10.5 KB, total 970 → 892) and Svelte's runtime ships as
//             one chunk (vite.config.ts svelteRuntimeChunk; 892 → 880, and
//             every first load 3–6 KB lighter: on the merged tree home 84.4
//             → 81.3, a catchment 137.2 → 132.8, Runs 273.6 → 267.9, farm
//             91.8 → 88.1, /share 65.7 → 63.2, sign-in 63.0 → 59.5). The
//             largest spreadsheet worker is now the import's, 27 KB.
//             Measured and rejected: experimentalMinChunkSize 2000 (−4 KB
//             total, +1.5–4 KB on every first load) and grouping the small
//             page-side engine modules (−2 KB total, farm +6, home +2).
//             Headroom ~5 KB.
// 2026-09-26  total 973 → 978 KB (measured 975). Issue #54 adds ~6 KB: the
//             upload's overwrite confirm, History's "Restore the earlier
//             values", the scenario and compare support and help entries for
//             the supply rules (engine 0.42.0) and the crop demand options
//             (0.43.0). The i18n trim above has landed; headroom ~3 KB.
// 2026-09-26  total 978 → 985 KB. main measured 979 (over the ceiling after
//             the English-as-key trim, 969, and the merges since: #53's
//             year classes and demand.scale op, WP-3.8's supply rules);
//             issue #17's Network map filling the screen adds 1 (980).
//             Headroom ~5 KB.
// 2026-09-26  total 978 → 893 KB, calibration worker 35 → 32 KB (both down).
//             Issue #9's reductions (the run export's own xlsx writer, one
//             Svelte runtime chunk, worker treeshaking; the English-as-key
//             messages) merged with issue #54's +6 KB: measured 888 KB, the
//             calibration worker 27 KB. Headroom ~5 KB on each.
// 2026-09-26  total 985 → 895 KB (measured 890). The two entries above
//             were written in parallel; merged, #9's reductions and #17's
//             Network map measure 890. Headroom ~5 KB.
// 2026-09-26  ceilings unchanged (issue #53 follow-up, measured @ 73311b3,
//             before #9's cuts). A Lazy share-the-pain board raises the total
//             ~1.3 KB (its own chunk compresses worse than it saves) and the
//             Runs tab always renders it, so it stays eager. The Scale demand
//             form is ~40 template lines in the already-lazy Scenarios chunk:
//             not worth a chunk.
// 2026-09-26  total stays 895 KB (measured 891). Issue #9: `.small` (53
//             scoped copies), `.u` (22) and the `.seg` segmented control (5)
//             live once in app.css (docs/architecture.md § Shared CSS).
//             −1.0 KB total, not the 2–3 KB estimated: gzip had already
//             folded the copies that shared a chunk. On main @ f784a24
//             910 738 → 909 682 bytes; merged over origin/main @ 1a8d058
//             (the home import dialog made lazy) 913 069 → 912 108. First
//             loads: Runs and the report −0.2 KB, Network, Data and Settings
//             −0.1; home, sign-in, /farm, /share and teams +0.06 (global CSS
//             is on every page). Measured and not moved: the spinner (−0.3
//             total, +0.1 on /farm, /share and sign-in) and `.stat dd.sub`
//             (−0.07). Measurement + 5 would be 896, over the current
//             ceiling, so it stays; headroom ~4 KB.
// 2026-09-26  total 895 → 907 KB (measured 903, from 891 on main @
//             db6f91a). Issue #53 R4's outcome matrix: the Runs tab's panel
//             (outcomes/OutcomeMatrixPanel.svelte with its view model, 5.5
//             KB), the engine's year classes and outcome matrix (0.9 + 2.0
//             KB, first shipped now: nothing on the page side read them
//             before), Settings → Outcome matrix (2.0 KB) and the sweeps API
//             client. All three are lazy chunks: the panel loads when a run
//             is shown, the section when Settings is; inline, the section
//             took the Settings chunk over its 42 KB ceiling (it is 41.5 KB
//             with the lazy hook). No new dependency. Headroom ~4 KB.
// 2026-09-26  total 907 → 912 KB (measured 908). The two entries above and
//             the failed-chunk reload (common/ChunkFailed, b3c01b0) were
//             measured apart; merged, #53 R4's outcome matrix and the reload
//             prompt measure 908. R5's seasonal outlook (engine 0.44.0) is
//             not in any page chunk. No new dependency. Headroom ~4 KB.
// 2026-09-26  total 912 → 917 KB (measured 913). The plain failed-chunk
//             message for the workbook download, the data download and the
//             verify-email banner (+~0.5 KB) merged with #17's app shell,
//             which left ~0 KB of headroom. Headroom ~4 KB.
// 2026-09-26  total 917 → 918 KB. Issue #17's app shell (AppShell, AccountMenu,
//             the sidebar slot; AppHeader removed) landed at exactly 912; pages
//             starting at the sidebar, Help's "On this page" rail and the phone
//             Menu's outside-click close add 1: 913. Headroom ~5 KB.
// 2026-09-26  total 918 → 924 KB (measured 921). Issue #54 item 1: the Load
//             crop factors dialog (~9 KB, its own chunk, fetched on first
//             open: the reference crop library, per-crop diff and demand
//             comparison). Lazy, so no page's first load grows. Headroom ~3 KB.
// 2026-09-26  total 924 → 939 KB (measured 934: 955 896 bytes, from 923 on
//             main @ 6380d36, R6's engine half merged). Issue #53 R5's seasonal outlook screen: the
//             Runs tab's panel (outlook/OutlookPanel.svelte with its view
//             model: the demand levels and the monthly plan, the table of
//             medians and 10–90 % ranges, every analogue year, the planning
//             figure, 7.0 KB), Settings → Seasonal outlook (1.8 KB), the
//             engine's outlook defaults and describePlanningFigure (0.5 KB, a
//             chunk the two share) and the draft disclaimer (0.5 KB, now a
//             chunk the report and the panel share), the lazy hooks, menu
//             entries and outlooks API client. All lazy: the panel loads when
//             a run is shown, the section when Settings is. The outlook runner
//             (runSeasonalOutlook, outlookMemberInput) is in no chunk: the
//             backend's job runs it. The Settings chunk is 42 741 bytes, 267
//             under its 42 KB ceiling, so the next Settings group must
//             lazy-load its blocker check too. No new dependency. Headroom
//             ~5 KB.
// 2026-09-26  total 924 → 935 KB (measured 931). origin/main already measured
//             926 before this merge (work landed after the entry above without
//             a raise); issue #17's Summary (board A1: KPI row with Dams today,
//             the chart's range switch and shaded reserve days, Needs attention
//             cards, Supply by farm in its own lazy chunk) adds 5. The largest
//             chunk stays under 42 KB because Supply by farm was split out.
//             Headroom ~4 KB; the next page needs a trim (the i18n catalogue).
// 2026-09-26  total 935 → 941 KB (measured 937). Issue #17's Teams pages
//             (7 KB in their branch, measured from 913): the teams list's cards
//             (numbers and traffic lights from each team's portfolio), the team
//             page's projects-first layout with its settings sheet
//             (teams/TeamSettings), the window-fitting portfolio with its
//             summary tiles, and the shared StatusPill / StatusBar and
//             portfolio totals. Route chunks only; no new dependency.
//             Headroom ~4 KB.
// 2026-09-26  total 941 → 949 KB (measured 945; the Crops branch measured
//             938 from 931 on main @ a2013049, +7). Issue #17 A3: Crops &
//             demand becomes a page of crop cards (factor sparklines), the demand chart and per-farm
//             stacked bars, with a crop sheet (crops/CropsTab, CropSheet,
//             cards.ts); the old tab body moved unchanged to CropGrids (the
//             grid modal and override mode, now with #54's Load crop factors
//             trigger), the demand table to DemandTable. All in the lazy
//             Crops chunk; the largest chunk is unchanged (41.7 KB, the
//             workspace page). No new dependency. Headroom ~4 KB; the i18n
//             catalogue trim is still the next saving.
// 2026-09-26  total 949 → 957 KB (measured 953). A merge: the 924 → 939
//             entry (#53 R5's seasonal outlook) and the 935 → 949 entries
//             (#17's Summary, Teams and Crops pages) were each measured without
//             the other's growth; together with #54 2a's Unit labels (+0.3 KB)
//             they measure 953. Headroom ~4 KB; the i18n catalogue trim is due.
// 2026-09-26  total 949 → 959 KB (measured 955; the branch measured 924
//             from 914 on main @ 3f0f056, +10). Issue #17 board A4, Compare runs: a baseline and up
//             to two what-ifs. The CompareView chunk (already lazy, the
//             workspace tab's and /compare's) grows 5.3 KB with the run
//             cards, the outcomes table, the takeaways and compare/summary.ts;
//             the "days below the reserve, each year" chart is a new lazy
//             chunk (ReserveYearsChart, 3.2 KB with the engine's
//             reserveDaysByWaterYear). No page chunk or largest chunk moves;
//             no new dependency. Headroom ~4 KB; the bundle-weight trim
//             under way should bring this back down.
// 2026-09-26  total 959 → 967 KB (measured 963). A merge: the 949 → 957
//             entry above and #17's 949 → 959 Compare runs entry were each
//             measured without the other's growth; together they measure 963.
//             Headroom ~4 KB; the bundle-weight trim under way is due.
// 2026-09-26  total 959 → 968 KB (measured 964, with main's pulled work (the legacy
//             runoff model removal, #16) included; the branch measured 947.3
//             from 944.2 on main @ da785083, +3). Issue #17 shell: one section header per
//             workspace section (workspace/SectionHeader, the header slot
//             tabs fill, context.ts), the notices as one slim line, the
//             role badge in the sidebar and the Data "series behind" badge,
//             and the help guide's new paragraph. The workspace chunk went
//             41.6 → 41.2 KB: the Overview's Share links panel became its
//             own lazy chunk (owners only, far below the first screen) to
//             pay for the header; splitting the Farmers panel too added ~3 KB
//             to the total and wasn't needed, so it stays in the page. Largest
//             chunk is still 41.7 KB (unchanged). No new dependency.
// 2026-09-26  total 968 → 955 KB (down; measured 951, from 964, after merging onto
//             main with the section header; the branch alone measured 931
//             against 945 on its base); other ceilings unchanged. Issue #9, a weight cut for #17's pages. From a
//             per-chunk and per-module attribution of a sourcemapped build on
//             main @ da78508: 966 722 bytes (945 KB by this guard's rounding)
//             over 309 files, of which ~63 KB is split overhead in the JS
//             (the chunks gzip to 812 KB concatenated, 876 apart) and ~30 KB
//             in the CSS (109 files: 75 KB apart, 44 together). Removed, each
//             measured alone in order (bytes gzip):
//             - preload lists without chunks the importer already has
//               (vite.config.ts preloadDedupe): 966 722 → 964 390 (−2.3)
//             - the Runs tab's six always-rendered panels back in its chunk
//               (supply assurance, water account, evidence, reproduce,
//               changes since, publication): → 957 463 (−6.8, 13 files)
//             - the report's server-PDF controls in its chunk: → 957 105 (−0.4)
//             - Svelte's scoping class s<hash>, not svelte-<hash>
//               (svelte.config.js cssHash): → 954 446 (−2.6)
//             - 7-character file hashes, CSS named by hash alone
//               (vite.config.ts shortFileNames): → 951 731 (−2.7)
//             Moved, not removed: the Invite farmers dialog is its own chunk
//             (→ 953 006, +1.2), taking the workspace page chunk 40.7 →
//             38.5 KB for the redesign's section header. Net −13.7 KB. The
//             largest chunk is the Settings tab's, 41.2 KB (the ceiling
//             stays 42). Measured and not landed: the Settings tab's four
//             always-rendered lazy panels inline (−6.0 total, but a 59 KB
//             chunk), and the Runs tab's uncertainty and outcome panels
//             inline (−2.8 total, a 48 KB chunk; the outcome panel alone
//             −1.6 with Runs at 41.2): both wait on the per-chunk ceiling
//             (docs/followups.md). Rollup generatedCode es2015: +0.05.
//             Headroom ~4 KB.
// 2026-09-26  total 955 → 962 KB (measured 958, +7); largest chunk unchanged.
//             The Dams page (issue #17,
//             option A · Outcomes): dam cards with sparklines, the picked
//             dam's storage chart and the Dam levels table, moved from the
//             Summary (dams/DamsTab, DamLevels, dams.ts). A lazy chunk of
//             7.4 KB gzipped, including the table, which left the Summary's
//             own lazy chunk; LineChart and uPlot are shared chunks already.
//             No new dependency. Headroom ~4 KB.
// 2026-09-26  total 962 → 978 KB (measured 974, +12 on main's 962 with River &
//             reserve); largest chunk unchanged (39 KB). The Units & supply
//             page (issue #17, option A · Outcomes): unit cards, four tiles,
//             the picked unit's supply chart (supply/SupplyTab, UnitDetail,
//             UnitResultsTable, supply.ts), a lazy chunk of 16.6 KB gzipped
//             that carries the panels moved from Runs & results (the
//             curtailment panel with its reporting window, assurance of
//             supply, the unit table, the unit detail). The Runs chunk went
//             31.8 → 23.0 KB, so the page's own code is ~7.8 KB; the rest is
//             split overhead: the Runs + report shared chunk (run summary,
//             curtailment table, share-the-pain board, 23.3 KB) is now two
//             (13.9 + 10.2), one per importer set, and the report chunk
//             +0.4 for the unit table it now imports itself. No new
//             dependency. Headroom ~4 KB.
// 2026-09-26  total 978 → 991 KB (measured 987, +13 on main's 974); largest chunk unchanged.
//             The Afrikaans (issue #49, WP-2.5): every farmer-facing string
//             translated. The site catalogue (messages/af.ts) is a lazy
//             chunk of 11.4 KB gzipped that only someone who picks
//             Afrikaans downloads; the farmer glossary's Afrikaans
//             (help/content.af.ts) adds ~3 KB to the /farm/words page. Words,
//             not code: nothing to trim without dropping a translation.
//             No new dependency. Headroom ~4 KB.
// 2026-09-26  new largestTabChunkKb 60 KB; total 991 → 1004 KB (measured
//             979, down 8); the page ceiling stays 42 KB (issue #17's bundle
//             item, docs/followups.md). Workspace tab chunks are measured
//             against a ceiling of their own (above), so the panels a tab
//             renders on every visit fold back into its chunk instead of
//             paying split overhead to fit the 42 KB page ceiling. Measured
//             on main @ b2cacb7 → this change: 1 010 466 → 1 002 148 bytes
//             gzip (987 → 979 KB by this guard's rounding, 312 → 296 JS/CSS
//             files). The Settings tab takes in data feeds, scheduled
//             reports, API keys, outcome and outlook settings and the
//             pan-coefficient helper: 37.7 + 2.3 CSS → 56.3 + 3.3 CSS KB, the
//             six chunks it replaces were 26.0 KB, ~−6.5 KB. The Runs tab
//             takes in the plausibility checks (every run since engine
//             0.25.0 has them): 23.0 → 27.2 KB, the chunk was 5.6, ~−1.3 KB
//             (the uncertainty and outcome panels the follow-up counted had
//             already moved to River & reserve, whose tab chunk has them).
//             The rest is shorter preload lists. Still lazy: the WR2012 panel
//             and the forecast (only runs with one), the rule-table editor,
//             the download preview. Largest tab chunk: Settings, 57 KB, so
//             the next Settings feature must lazy-load something only some
//             visits render; the largest page chunk is still the workspace
//             page, 39 KB. The total gets ~25 KB of headroom, not the usual
//             ~4, for four new #17 pages being built in parallel: each one
//             measured against this ceiling, not against the others. No new
//             dependency.
// 2026-09-27  total 1004 → 1008 KB (measured 1 028 180 bytes, 1004.08 KB, so
//             1005 by this guard's rounding); largest page and tab chunks
//             unchanged (34 and 57 KB). Compare runs extras (issue #17 A4):
//             the report's impact section (report/ImpactSection.svelte) is a
//             chunk of its own, 1.33 KB, loaded only for `report?against=`;
//             the outcomes and takeaways (compare/summary.ts, 2.07 KB) and
//             ChangesList (0.81 KB) it shares with Compare runs left that
//             tab's chunk for shared chunks, which adds their split
//             overhead; the Export impact report menu and the dam storage
//             row are a few hundred bytes. Trimming CSS moved nothing (hash
//             and class-name noise is ±50 bytes). No new dependency.
//             Headroom ~4 KB.
// 2026-09-27  total 1008 → 1018 KB (measured 1015 on merged main: History 1004 on
//             its own, plus Compare runs extras below, plus the sign-in,
//             account alerts / share, help subpage and farmer-page passes
//             landing the same day); other ceilings
//             unchanged. Issue #17's History page, the last of the four:
//             main @ 14117da1 measured 1000 KB by this guard, this change
//             1004 KB (+3.4 KB of JS/CSS gzip bytes). The History tab chunk
//             is 7.1 KB JS + 1.2 KB CSS: rows beside the picked change with
//             Newer/Older, its differences from now (ChangesList, already
//             shared with Compare), the filters in the URL, the window fit,
//             and the phone's whole entries kept beside them (one layout or
//             the other is rendered, never both). Nothing to trim that the
//             page doesn't show. The earlier raise's parallel-page headroom
//             is spent; this leaves ~3 KB. No new dependency.
// 2026-09-27  total 1018 → 1029 KB (measured 1026 on merged main): the
//             Projects list below (+6), the farm frame on /account for
//             farmer-only users (+0.9), the On this page menu on three more
//             tabs with its More overflow, the phone section header, and
//             main's multi-language i18n work landing the same day.
// 2026-09-27  total 1004 → 1009 KB (measured 1006, +6 on main's 1000 @ 14117da1);
//             largest chunk (34 KB) and largest tab chunk (57 KB) unchanged.
//             The Projects list (issue #17): outcome columns from the
//             portfolio (EWR pill, units short, lowest dam, last run and its
//             age), a Needs attention strip, owner chips, the ⋯ row menu,
//             outcome sorts and the window fit. The home page is the first
//             screen after sign-in, so these stay in its chunk rather than
//             paying split overhead; it now shares portfolio.ts and
//             StatusPill with the teams pages. No new dependency. Headroom
//             ~3 KB.
// 2026-09-27  total 1004 → 1006 KB (measured 1005). main @ a72132d5 was
//             already over: 1 028 283 bytes gzip against the 1 028 096 a
//             1004 KB ceiling allows (the i18n and #17 pages since the last
//             entry). Issue #17's leftovers (the Add data dialog on the
//             shared Dialog, the notes as a side sheet with the form on top,
//             the download preview's row fixes) add 598 bytes → 1 028 881:
//             Dialog's `beforeclose` and Esc handling, UploadForm's external
//             buttons, NotesList's form-first layout, and help text for notes
//             and the download preview (~300 bytes of words). Largest chunk
//             and tab chunk unchanged. No new dependency. Headroom ~1 KB:
//             History (the last #17 section) must trim or bring its own entry.
// 2026-09-27  total 1029 → 988 KB (down; measured 976). Issue #17's bundle
//             trim, on main @ 16272357 (1 051 240 bytes gzip, 1027 KB by this
//             guard). Two changes:
//             (1) Compare runs imports the three panels every comparison
//             renders (paired uncertainty band, daily series overlay, days
//             below the reserve) instead of lazy-loading them: the band joins
//             the tab's chunk (16.0 → 18.9 KB with CSS), the other two stay
//             chunks the Scenarios and River & reserve tabs share, preloaded
//             now. 1 049 897 bytes (−1.3 KB, 319 → 315 files); /compare cold
//             with everything it renders 154.2 → 153.0 KB, one request round.
//             (2) Terser replaces esbuild as the minifier (frontend/vite.config.ts,
//             build.minify; terser 5.51.2, a dev dependency, Vite's other
//             supported minifier): 998 674 bytes, −50 KB, the same 315 files.
//             Measured first by re-minifying the built chunks: the mangler
//             alone is −50 KB of −56 (Terser reuses the same short names in
//             every scope, which gzip matches across the file; esbuild's names
//             differ per scope), compress the rest. Default options, nothing
//             unsafe; the frontend build takes ~70 s. Largest tab chunk 58 →
//             53 KB (Settings), largest chunk 34 KB (help text: words),
//             workers 28 → 27 and 27 → 26 KB; /compare cold 153.0 → 147.0 KB.
//             Looked for and not found: duplicated code across chunks (a
//             normalised 160-character scan of every chunk finds only import
//             lists and one viewport-fit helper), dead imports (Rollup drops
//             them), repeated CSS (a few 40–100 byte rule bodies in 4–5
//             files). Headroom ~12 KB, not the usual ~4, for the #17 pages
//             being built in parallel against 1029: each must fit under 988
//             once merged.
// 2026-09-27  total 988 → 994 KB (measured 991 on main @ e3ac41ac, +15 on
//             the trim's 976). The #17 headroom was spent as planned, by the
//             ~20 feature commits since 19f02741: the section dialog, gauge
//             flow records and the plausibility-check panels on Runs and
//             Compare, the EWR-charge and low-flow settings, the report's
//             schematic bands, the phone node cards. No one commit stands
//             out and no chunk budget moved. Went unnoticed while Actions
//             was down (billing), and the batch merge of #20, #60 and #61
//             adds nothing to the total. Headroom back to the usual ~3 KB.
// 2026-09-27  total 994 → 1020 KB (measured 1017, with the email-first sign-up); new landingKb 25 KB. The
//             public landing page (issue #57) adds ~24 KB: its own chunk
//             (lib/components/landing/, 15.7 KB JS + 4.4 KB CSS = 20 KB, under
//             the issue's 25 KB landing budget, now its own ceiling above), the
//             Afrikaans words for its 94 messages in the lazy af catalogue
//             (~3.5 KB, loaded only by someone who picks Afrikaans), the
//             prerendered /welcome route's node (0.2 KB) and a few lines in the
//             root layout. No new dependency: the charts are plain SVG and the
//             figures a small generated module, so the landing loads no uPlot,
//             no engine and no workspace code. Headroom ~3 KB.
// 2026-09-27  total 994 → 998 KB (measured 995 on e9380f9b + the ewrRule.set
//             scenario op, WP-3.7): "Set an EWR site's rule table" in the
//             scenario form reuses Settings' rule-table helpers (siteOptions,
//             now reached from the scenarios chunk too) and lazy-loads the
//             Settings tab's table editor as it is, so no editor code is
//             duplicated; the op's description and draft in scenarios/ops.ts.
//             No chunk budget moved. Headroom ~3 KB.
// 2026-09-27  total 1020 → 1024 KB (measured 1020 on main with both of the
//             above: the landing page and the ewrRule.set op landed in
//             parallel, each measured without the other). Headroom ~4 KB.
// 2026-09-27  total 1024 → 1035 KB (measured 1032). The legal pages
//             (/privacy, /terms, docs/legal-status.md): prerendered with
//             csr = false, so a visitor downloads only their HTML and CSS and
//             no script at all, but SvelteKit still emits their page nodes
//             (4.4 + 4.9 KB, their text) and the frame (0.8 KB), which this
//             guard counts like any file. The rest is the Legal nav under the
//             sign-in forms, the sign-up form's acceptance sentence and their
//             Afrikaans words (~2 KB). No new dependency. Headroom ~3 KB.
// 2026-09-27  total 1035 → 1042 KB (measured 1039). Demand objects (issue #54
//             item 2b, engine 1.7.0): the Network node form's Demand objects
//             section (DemandObjectFields, in the node form's chunk like the
//             borehole fields), the run's demand-objects table (in the lazy
//             human-impact tables), the engine's demand-object module (shared
//             by the run worker and the pages), the help entry and the client
//             validation (~7 KB). No new dependency. Headroom ~3 KB.
// 2026-09-27  total 1042 → 1045 KB (measured 1042 on main with both of the
//             landing review fixes (+1 KB) and the demand objects (above),
//             each measured without the other). Headroom ~3 KB.
// 2026-09-27  total 1045 → 1049 KB (measured 1046, +4 on 1042). The areal
//             rainfall correction (engine 1.13.0): its Settings group and
//             form helpers, the help entry, the fit-provenance and report
//             lines, and the engine's areal-rain code shared by the run and
//             fit workers. No new dependency. Headroom ~3 KB.
// 2026-09-27  total 1049 → 1055 KB (measured 1052 on main merging the areal
//             rainfall correction (above) with the work that landed beside it,
//             each measured without the other). Headroom ~3 KB.
// 2026-09-27  total 1055 → 1057 KB (measured 1054). Distinct diagram labels
//             add ~2 KB: the schematic's transfer router (a grid path round
//             every name when no arc is clear) and its distinct short names
//             (NetworkSchematic's chunk), and the help diagrams' minimum
//             drawn text size (Diagram). No new dependency. Headroom ~3 KB.
// 2026-09-27  total 1057 → 1060 KB (measured 1057 on main with the diagram labels). Labelled charts (+3 KB): the shared
//             Sparkline component and its helper (a 2 KB chunk the Crops and
//             Dams tabs share: caption, end labels, marked peak or low,
//             pointer read-out), line charts' accessible names with unit and
//             span, the reserve-years axis unit, captions on three bar charts.
//             No new dependency. Headroom ~3 KB.
// 2026-09-27  total 1060 → 1066 KB (measured MEASURED on main). Monthly
//             transfer rates and river off-takes (engine 1.14.0), +6 KB on
//             the 1052 they were built on: the Transfers tab's twelve
//             month-rate fields and Takes from fields (the Transfers chunk),
//             the engine's transfer-rates and off-take modules and checks
//             (shared by the run worker and the pages), the water-account
//             and balance lines, the help, report and scenario lines. No new
//             dependency. Headroom ~3 KB.
// 2026-09-28  ceilings unchanged. Vite 5 → 8 (Rolldown + Oxc; the Dependabot
//             roll-up): 1064 KB measured on the Vite 5 build, 1070 KB on Vite 8
//             with Terser (the IIFE spreadsheet workers came out unminified,
//             import worker 26.4 → 29.3 KB, and the chunk split moved ~2 KB),
//             1061 KB on Vite 8 with Oxc, Vite 8's own minifier, which
//             replaces Terser (frontend/vite.config.ts, build.minify). Largest
//             tab chunk 54 → 53 KB, workers 28 / 27 KB. Headroom ~5 KB.
// 2026-09-28  total 1066 → 1073 KB (measured 1068 on Vite 8 + Oxc, after the
//             Vite roll-up above; 1070 on Vite 5). The methods page
//             (/methods, the engine audit's public summary, issue #57):
//             prerendered with csr = false like the legal pages, so a visitor
//             downloads no script, but SvelteKit still emits its page node
//             (5.2 KB, its text, the departures and the generated known
//             limitations), plus the trust strip's link and its Afrikaans
//             word. No new dependency. Headroom ~5 KB.
// 2026-09-28  total 1073 → 1083 KB (measured 1080, on Vite 8 with the
//             methods page). Issue #47's liability work: the farm view's
//             estimate callout and one-time acknowledgement, the Terms
//             re-acceptance notice (its own chunk, loaded only for an account
//             on old terms) and sign-up summary, the signer's registration
//             selects (signoff-3), the report's "Read this first" box and
//             footer text, the share-page line, the workbook's disclaimer
//             sheet, and their Afrikaans words. No new dependency. Headroom
//             ~3 KB.
// 2026-09-28  total 1083 → 1089 KB (measured 1086 with main merged in).
//             Issue #51's forecast-leak fixes: a forecast run's history-only
//             day counts, windows and flow-duration ranking (flowSeries,
//             reportWindow, views/fdc), fitting on the record only and the
//             CHIRPS-factor drift flag (calibrate/provenance), negative flows
//             read as missing, the Reserve requirement line on the flow vs
//             reserve chart, and the CHIRPS feed note. No new dependency.
//             Headroom ~3 KB.
// 2026-09-28  total 1089 → 1094 KB (measured 1090 with main, after #127,
//             merged in; +4 KB on main). Demand-object on/off schedules (issue #90
//             Q4, engine 1.17.0): the node form's schedule editor
//             (DemandScheduleFields.svelte and its list helpers), the
//             engine's window rules and Easter computus shared by the form's
//             validation and the run, the Days off column and the help
//             entry. Lazy-loading the editor would not lower this figure:
//             the total sums every chunk, so a split only moves the bytes and
//             adds a chunk's overhead. No new dependency. Headroom ~4 KB.
// 2026-09-28  total 1094 → 1101 KB (measured 1098 with #115's schedules
//             merged, 1093 before). Issue #72's allocations second slice:
//             the engine's allocation mode (allocations/mode.ts), its
//             self-check and the run comparison's allocation lines (verify
//             and compare ship in the run worker and the pages both), the
//             Settings tab's Registered volumes fields, the Allocations tab's
//             licence conditions and mode note, and two help entries. No new
//             dependency. Headroom ~3 KB.
// 2026-09-28  total 1101 → 1127 KB (measured 1124 with main merged), largestWorkerKb 32 → 34
//             (calibration worker measured 33). Issue #65, the calibration
//             workflow batch (engine 1.19.0), one change: CR-21 sensitivity
//             runs (River & reserve's Sensitivity panel and tornado, ~4 KB;
//             the verdict module kept apart from the run by engineSplit.test.ts;
//             sensitivityRuns in the calibration worker), CR-28 WR2012
//             five-statistic table (Wr2012FitTable), CR-29 daily compliance,
//             %nMAR and the monthly FDC overlay (EwrDailyCompliance,
//             EwrFdcOverlay, reused on the compare page), CR-3/CR-5 score
//             intervals and benchmarks, CR-34 record representativeness, the
//             hydrograph's exclusion shading and CR-13 recession diagnostics
//             (RecessionDiagnostics in the plausibility panel). The worker
//             grows by the bootstrap, WR2012 statistics, representativeness
//             and sensitivity code it runs; all of it is scoring or run code
//             the worker needs, so none can move to the page. No new
//             dependency. Headroom ~3 KB total, ~1 KB worker.
// 2026-09-29  total 1127 → 1137 KB (measured 1134 with #65's calibration
//             batch merged in; the branch added 11 KB over main before it).
//             Issue #53's remaining planning outputs: the impact report's
//             licence-impact board by year class (R7: the engine's
//             licenceImpact view, the board and its view model, in the
//             impact section's lazy chunk), the seasonal outlook's review
//             trigger table and publish-to-farmers controls (R6, R5; the
//             outlook panel's lazy chunk), the review-date setting, and the
//             farm page's "This season" card with its Afrikaans (E3). Every
//             piece already sits in a lazy chunk, so a further split would
//             only move bytes. No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1137 → 1143 KB (measured 1140 with main @ 347ca24
//             merged in, which measures 1134; before the merge the branch
//             measured 1130 against main @ 09c4ed7's 1124). Issue #66,
//             data-quality limits as settings (engine 1.20.0): the Settings
//             tab's Data quality section grows from 3 to 17 fields
//             (DataQualitySection, its validation and option lists; tab chunk
//             55.9 → 57.9 KB), the zero-run CHIRPS check, 'usualRain' rule,
//             moving low-vs-CHIRPS baseline and scaled minimum in quality.ts
//             (shared engine chunk 40.5 → 41.1 KB, import worker +0.5 KB),
//             their run-comparison labels, the fit provenance line and one
//             help entry. No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1143 → 1149 KB (measured 1146 with #157 merged in).
//             Issue #66, rain-source periods' daily intensity: the heavy-day
//             check and the opt-in quantile-map fields in Settings → Rain
//             source periods and their run-comparison and fit-provenance
//             lines. No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1149 → 1156 KB (measured 1153 with #157 and #155 merged
//             in; that main measures 1146), largestWorkerKb 34 → 36 (calibration
//             worker measured 36, was 34). Issue #66, per-day quality flags
//             (engine 1.22.0, CR-18/19/22): the calibration worker now flags
//             each day (calibrate/dayFlags.ts, with the Data checks'
//             flat-stretch and outlier rules from quality.ts under the
//             project's dataQuality limits), censors or leaves out flagged
//             days and writes the data-quality summary and its notes; that
//             code has to run where the fit runs. On the main thread: the
//             data-quality panel (DataQualityPanel), the gauged-range fields
//             (QualityFlagsFields, in the Settings tab chunk, now at its
//             60 KB ceiling), the fit record's quality-flag row and the help
//             article. The settings resolver and run-comparison lines sit in
//             calibrate/qualityFlagSettings.ts, which imports none of the
//             checks, so provenance and comparison chunks don't carry them.
//             No new dependency. Headroom ~3 KB; #155's quantile map adds its
//             own growth on top when it lands.
// 2026-09-29  total 1156 → 1166 KB (measured 1163 with main @ ca9d933 merged
//             in, which measures 1153). Issue #66's gap filling, series source
//             and the infilled wiring (engine 1.23.0): the engine's
//             flowGapFill module in the pages' engine chunk; the fit record
//             and run comparison's source and fill lines; the Data tab's fill
//             shading and source editor; Settings' Flow gaps fields (their own
//             1.9 KB chunk); two help entries. Two ceilings that were full on
//             main are fixed at the source, not raised: the Settings tab chunk
//             (main 59.6 KB of 60) now loads the quality-flag fields as their
//             own 2.2 KB chunk beside the Flow gaps fields: 58.5 KB;
//             and the help glossary's long text (articles.ts, main 41.1 KB of
//             42 as the largest chunk) is two modules, the "Input data"
//             topic in articles-data.ts as its own 8.9 KB chunk
//             (vite.config.ts helpArticlesChunk), so the largest chunk is
//             34.1 KB. The split and the two lazy chunks cost ~2 KB of total
//             (smaller files compress less well). Calibration worker 36 KB,
//             unchanged. No new dependency. Headroom ~3 KB.
// 2026-09-29  total stays 1166 KB (measured 1165 with issue #126 round 4
//             merged onto main @ the #66 gap-filling raise, which measures
//             1163). The sign-in CAPTCHA's WAF-answer detection in the shared
//             api chunk and its puzzle section in the sign-in route chunk take
//             ~2 KB of that headroom; AWS's script is loaded on demand, never
//             bundled. Headroom ~1 KB.
// 2026-09-29  total 1166 → 1170 KB (measured 1167 on main @ 58192db8 plus
//             issue #162 items 11, 12, 13, 21). The app's own confirmation
//             dialog replacing the browser's confirm() in 24 files (the
//             ConfirmHost in the root layout, each call's title, detail and
//             button words), the leave guard (lib/nav: the registry, the
//             destination names, the one beforeNavigate) and the project
//             details moved onto the page's save bar. No new dependency.
//             Headroom ~3 KB.
// 2026-09-29  total 1170 → 1176 KB (measured 1173 with all of issue #162
//             merged: items 1–27 as one PR. The glossary as one page per
//             topic with redirects for old term links, the Summary's
//             days-below-the-reserve strip and the shared EWR-not-met
//             wording, the one data-age formatter and stale-date wording,
//             visible chip group names, one role-name map, and the
//             register page's scrolling terms box, on main @ 12cde4ae, with
//             #126's sign-in CAPTCHA). No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1176 → 1199 KB, calibration worker 36 → 44 KB (issue
//             #153, automated calibration with pre-declared rules; measured
//             1185 / 43 against main @ 12cde4a's 1162 / 36, and 1196 / 43 once
//             merged with #162's 1173). The worker runs
//             the engine's autoCalibrate: its orchestration, the filters and
//             selection and the rule-set resolver are ~5 KB gzipped on their
//             own (auto.ts 2.1, rulesSettings.ts 2.0, rules.ts 1.0); the rest
//             of the worker's growth is chunk boundaries. Outside the worker:
//             the Automated calibration panel (4.4 KB) and the Calibration
//             rules fields (2.8 KB), each its own lazy chunk that loads only
//             with Settings → Fit automatically; the glossary article; and the
//             rule helpers run comparison and the fit record read. Headroom
//             ~3 KB total, ~1 KB worker.
// 2026-09-29  total 1199 → 1186 KB (down), calibration worker 44 → 36 KB
//             (down; issue #153's follow-ups: measured 1183 / 36 on main @
//             89482bf0). The server now runs the calibration rules, one
//             background job per fit, so the worker no longer carries
//             autoCalibrate, the filters or the rule resolver; the panel
//             follows the server's run instead. Headroom ~3 KB.
// 2026-09-29  total 1186 → 1190 KB (issue #137: measured 1187 with main @
//             3c68382c merged, against main's 1183). The Water balance
//             section in Model quality (runs/WaterBalanceTable.svelte, now
//             drawn on the Runs page and not only inside Self-checks), the
//             Other uses section on Units & supply with the Summary's link to
//             it, and the project's-date helper the data-age badges count to.
//             No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1190 → 1194 KB (issue #136: measured 1191 with main @
//             0a9cc278 merged, #137 included). Every add by email is an
//             invite that an existing account accepts: the invitations page
//             (routes/account/invitations, its own chunk), the banner that
//             counts waiting invitations (auth-extras/InvitesBanner, lazy,
//             with its store) and their Afrikaans words in the af
//             catalogue. The members, farmers and team panels lost their
//             added-at-once branches. No new dependency. Headroom ~3 KB.
// 2026-09-29  calibration worker 36 → 38 KB (issue #67: measured 37 with
//             main @ 0a9cc278 merged; total unchanged). The
//             worker bundles the engine, and the engine now runs causally
//             across a forecast tail (engine 1.28.0), so the run it fits
//             with grew ~1 KB. No new dependency. Headroom ~1 KB worker.
// 2026-09-29  total 1194 → 1201 KB (issue #68: measured 1198 with main @
//             84980243 merged, #136 and #198 included). A farm's Excel audit workbook, built
//             in the existing export worker (10.5 → 19 KB, inside the 32 KB
//             spreadsheet-worker budget): the engine's audit plan and
//             formula tree (verify/audit.ts), the dam and evaporation
//             helpers it shares with the self-checks (verify/workings.ts)
//             and what it reads a run's model through (upgradeLegacyModel,
//             the demand factor, the survey-curve and demand-object readers),
//             plus the sheet layout. Trimmed first: the FarmTemplate letters
//             are inlined rather than loading FARM_COLUMNS' formula texts,
//             and the evaporation defaults are two constants rather than
//             defaultProjectSettings. No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1201 → 1205 KB (issue #71: measured 1202 with main @
//             e8cd5bc9 merged, against main's 1200). The errata section of
//             the validation statement (liability/ValidationStatement: the
//             errata table, keyed on the run's engine and its fit's) and the
//             generated errata list it reads (engine liability/errata). No new
//             dependency. Headroom ~3 KB.
// 2026-09-29  no ceiling changed (issue #69, CHIRPS bounding box: the Data
//             feeds panel's box fields took the Settings tab chunk to 61 KB,
//             over its 60 KB ceiling). API keys render for owners only, so
//             ApiKeysPanel is now a lazy chunk of its own: the Settings tab
//             measures 58 KB.
// 2026-09-29  total 1201 → 1205 KB (issue #69: measured 1202 with main @
//             7b0d2a73 merged, against main's 1200). The CHIRPS feed's
//             bounding-box fields in the Data feeds panel (south, west,
//             north, east, the cell count they cover) and their checks in
//             feeds/feeds.ts; the lazy API keys chunk above adds its
//             loader. No new dependency. Headroom ~3 KB.
// 2026-09-29  no ceiling changed (issue #69, bounding box: measured with
//             main @ 675277da and the branch's API-keys split merged). The box
//             fields and "Leave out sea cells" grew the Data feeds panel
//             again, so it is a lazy chunk of its own too (DataFeedsPanel
//             via Lazy in SettingsTab, 9.6 KB), and the Settings tab
//             measures 50,314 bytes (50 KB of 60, from 58). The total stays
//             1202 KB of 1205. No new dependency. Headroom ~10 KB tab chunk.
// 2026-09-29  total 1205 → 1208 KB (issue #69: measured 1205 with main @
//             b681786e merged, at the ceiling; main grew since the entry
//             above). Nothing of the bounding box changed; the usual
//             headroom back. Headroom ~3 KB.
// 2026-09-29  total 1208 → 1210 KB (issue #69: measured 1207 with main @
//             327afa6e merged, #211's errata entry above included). Nothing
//             of the bounding box changed. Headroom ~3 KB.
// 2026-09-29  total 1201 → 1226 KB (issue #71, the licensing evidence
//             report: measured 1226 against 1201 on its base 84fb2a6b). The
//             report is a lazy chunk of its own (report/evidence/
//             EvidenceReport.svelte with its summary, grids and SVG plots,
//             15.6 KB + 1.8 KB CSS), loaded only in the report page's
//             `&evidence` mode; its shell (EvidencePage) adds ~3 KB to the
//             report page, where Disclaimer / SignoffSection / inputs.ts now
//             sit in a chunk the two share; Settings' Evidence rule fields
//             are another lazy chunk (2.8 KB); the declared-rule text and
//             check (engine uncertainty/options.ts, which the settings diff
//             in compare.ts reads) ~1.3 KB in the shared engine chunk; help
//             text ~0.5 KB. Trimmed first: EvidenceReport imported the
//             engine's monthName from uncertainty/ensemble.ts, so the
//             calibration worker's whole engine (37 → 3 KB worker, a 34 KB
//             chunk) became a shared chunk the report page loaded
//             statically; it now uses $lib/format/months' identical helper.
//             No new dependency. Headroom 0 KB: the next change is measured.
// 2026-09-29  total 1226 → 1231 KB (issue #71: measured 1228 with main @
//             b681786e merged; main grew ~2 KB since the entry above, #206's
//             CHIRPS final-day marker and #212's Summary readiness signal).
//             Nothing of the evidence report changed. Headroom ~3 KB.
// 2026-09-30  total 1231 → 1235 KB (issue #71: measured 1232 with main @
//             3f9b4c17 merged, #205's bounding box included). Nothing of the
//             evidence report changed. Headroom ~3 KB.
// 2026-09-30  total 1231 → 1234 KB (issue #71: measured 1231 with main @
//             327afa6e and #216's branch merged, against #216's 1228). The
//             evidence report's registered water use section (§ 5: the
//             over/under-use chart, its page-1 row and flag). No new
//             dependency. Headroom ~3 KB.
// 2026-09-30  total 1235 → 1238 KB (issue #71: measured 1235 with #216's
//             branch and main @ 3f9b4c17 merged, against #216's 1232): the
//             registered water use section above. Headroom ~3 KB.
// 2026-09-30  total 1238 → 1241 KB (issue #71: measured 1238 with #217's
//             branch merged, against its 1235). The Allocations tab's
//             over/under-use chart. No new dependency. Headroom ~3 KB.
// 2026-09-29  total 1238 → 1241 KB (issue #71 follow-ups: measured 1238 against
//             1235 on its base 0ba47067). The evidence report's chunk
//             18.6 → 20.2 KB: § 4's other applications on the baseline, § 1's
//             second FDC (the driest month), the ledger's note on starts not
//             completed, the print-only diagonal draft stamp, and page 1's
//             licence impact by year class. That board (LicenceImpactBoard,
//             licenceImpact.ts, 4.8 KB) left the impact report's chunk
//             (5.7 → 1.5 KB) for a chunk the two reports share, lazy in both:
//             +0.6 KB of split overhead, but no second copy. The evidence
//             page +0.1 KB (it fetches the board's three series). No new
//             dependency. Headroom ~3 KB.
// 2026-09-30  total 1241 → 1246 KB (issue #71: measured 1243 with main @
// 2026-09-30  total 1201 → 1206 KB (issue #70: main @ 7b0d2a7 measured
//             1200, the branch 1204). The report's publication cover,
//             "Changes since the previous publication" (ChangesList and the
//             attribution line in the report's chunk), its Assurance of
//             supply section (the Runs tab's panel in print mode) and the
//             @page footer; the compare and scenario views' assurance table
//             (compare/assurance.ts, AssuranceDeltaTable.svelte); the farm
//             view's share-received column and its Afrikaans. All in lazy
//             route or tab chunks; the largest tab chunk stays within 60 KB.
//             No new dependency. Headroom ~2 KB.
// 2026-09-30  total 1206 → 1210 KB (issue #70: measured 1207 with main @
//             327afa6e merged, #211's errata entry above included). Nothing
//             of the report changed. Headroom ~3 KB.
// 2026-09-30  total 1210 → 1214 KB (issue #70: measured 1211 with main @
//             3f9b4c17 merged, #205's bounding box included). Nothing of the
//             report changed. Headroom ~3 KB.
// 2026-09-30  total 1238 → 1244 KB (issue #70: measured 1241 with main @
//             848000ac merged). The report's publication, assurance and build
//             record on top of main's evidence report. Headroom ~3 KB.
// 2026-09-30  total 1241 → 1246 KB (issue #70: measured 1243 with main @
//             e8ebaf18 merged). #222's allocations chart now in main.
//             Headroom ~3 KB.
// 2026-09-30  total 1246 → 1250 KB (issue #70: measured 1247 with main @
// 2026-09-29  total 1210 → 1214 KB (issue #204: measured 1211 with main @
//             3f9b4c17 merged, the entries above included). A farm's
//             hands-off flow and River to dam by month: the engine's operating rules
//             (network/supply.ts operatingOf, the operatingRules self-check,
//             the scenario and comparison fields) in the workspace and the
//             workers that bundle the engine, and in the one-node form the
//             Supply section's hands-off months and EWR tick, the new
//             RiverToDamFields, their plain-words lines and save rules
//             (network/supply.ts, model/validate.ts operatingIssues). The
//             review's fixes kept the growth to ~4 KB: every twelve-month row of the
//             one-node form is now one MonthFields component (network/
//             MonthFields.svelte + monthFields.ts; five callers' tables and
//             setMonth/fillAll folded into it), and the engine's dam-less
//             hands-off cut. No new dependency. Headroom ~3 KB.
// 2026-09-30  total 1238 → 1244 KB (issue #204: measured 1241 with main @
//             848000ac merged). The hands-off flow and River to dam by month
//             fields on top of main's evidence report. Headroom ~3 KB.
// 2026-09-30  total 1241 → 1247 KB (issue #204: measured 1244 with main @
//             e8ebaf18 merged). #222's allocations chart now in main.
//             Headroom ~3 KB.
// 2026-09-30  total 1246 → 1250 KB (issue #204: measured 1247 with main @
//             5502d0a6 merged). #225's evidence-report follow-ups now in
//             main. Headroom ~3 KB.
// 2026-09-30  total 1250 → 1254 KB (issue #204: measured 1251 with main @
//             5be749ca merged). #215's report publication and assurance now
//             in main. Headroom ~3 KB.
// 2026-09-30  total 1238 → 1249 KB (PR #229: measured 1246 with main @
//             848000ac merged). Against main's 1237: share links and comments
//             for a submitted application (WP-3.15): the shared application's
//             view on /share (share/ScenarioView, share/scenario.ts), scenario
//             comments in the notes list and the application panel, and the
//             share-link panel's application links. No new dependency.
//             Headroom ~3 KB.
// 2026-09-30  total 1241 → 1254 KB (PR #229: measured 1251 with main @
//             e8ebaf18 merged). #222's allocations chart now in main; nothing
//             of the share links changed. Headroom ~3 KB.
// 2026-09-30  total 1246 → 1257 KB (PR #229: measured 1254 with main @
//             5502d0a6 merged). #225's evidence-report follow-ups now in
//             main. Headroom ~3 KB.
// 2026-09-30  total 1250 → 1261 KB (PR #229: measured 1258 with main @
//             5be749ca merged). #215's report publication and assurance now
//             in main; nothing of the share links changed. Headroom ~3 KB.
// 2026-09-30  total 1254 → 1265 KB (PR #229: measured 1262 with main @
//             da8c6959 merged). #220's hands-off flow now in main; nothing of
//             the share links changed. Headroom ~3 KB.
// 2026-09-29  total 1231 → 1233 KB (issue #71, the evidence measures,
//             engine 1.33.0: measured 1233 against 1231 on its base
//             e1d60130, +1.97 KB gzipped). The evidence report's lazy chunk
//             +1.31 KB (§ 4's "served in full while a site fails" tables and
//             banded Change column, § 2's two new rows, the FDC chart's
//             bands) and its CSS +0.1 KB; the calibration worker +0.55 KB
//             (reserve/riverMeasures.ts in every member run, the new member
//             measures and their bands). Trimmed first: the report named the
//             engine version that added them by importing it from
//             uncertainty/ensemble.ts, which (as in the entry above) moved the
//             worker's engine into a chunk the report page loaded; the
//             constant now lives in version.ts. No new dependency. Headroom 0.
// 2026-09-30  total 1238 → 1240 KB (issue #71: measured 1237 with #217's
//             branch merged, the evidence measures above included). Headroom
//             ~3 KB.
// 2026-09-30  total 1241 → 1245 KB (issue #71: measured 1242 with main @
//             e8ebaf18 merged). #222's allocations chart now in main.
//             Headroom ~3 KB.
// 2026-09-30  total 1265 → 1267 KB (issue #71: measured 1264 with main @
//             b72ba4eb merged). #229's share links and #204's hands-off flow
//             now in main; nothing of the evidence measures changed, engine
//             renumbered 1.32.0 → 1.33.0 (#204 took 1.32.0). Headroom ~3 KB.
// 2026-09-30  total 1267 → 1272 KB (issue #73, the later scenario ops:
//             measured 1269 on 6045472a + the change). Eight new ops in the
//             engine's scenario code (node.move, node.insert, crop.set,
//             crop.remove, landCover.set, ewrRule.remove, allocation.set,
//             allocation.remove: their validator, apply and classification),
//             their "Add a change" forms and descriptions, override mode
//             recording moves, inserts and crop edits, and eight share-page
//             lines in both catalogues. Headroom ~3 KB.
// Run:  pnpm build:frontend && pnpm check:bundle
// CI:    ci.yml, job `test`, after `pnpm build`.
// Tests: node --test scripts/guards/check_web_bundle_budget.test.mjs

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = Object.freeze({
	totalCodeKb: 1272,
	largestChunkKb: 42,
	largestTabChunkKb: 60,
	largestWorkerKb: 38,
	largestSpreadsheetWorkerKb: 32,
	largestAssetKb: 100,
	landingKb: 25,
});

/** A Web Worker bundle (Vite emits them under `workers/`; so does autocalWorkerChunk for the calibration worker). */
const WORKER = /(^|\/)workers\//;
/** The calibration worker's entry. */
const CALIBRATION_WORKER = /(^|\/)workers\/autocal\.worker-[^/]*\.js$/;
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

/**
 * @param {{ path: string, gzipBytes: number }[]} files
 * @param {Set<string>} [tabFiles] tabChunks().files: measured against the tab ceiling instead of the page one
 * @param {Set<string>} [landingFiles] landingChunks().files: also summed against the landing ceiling
 */
export function measure(files, tabFiles = new Set(), landingFiles = new Set()) {
	let landingBytes = 0;
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
	if (m.largestAsset.kb > budget.largestAssetKb) {
		out.push(
			`Asset ${m.largestAsset.path} is ${m.largestAsset.kb} KB gzipped, over the ${budget.largestAssetKb} KB per-asset budget. Subset the font or compress the image rather than raising the ceiling.`,
		);
	}
	return out;
}

/**
 * The calibration worker must be an entry of the page build (issue #9), so
 * it shares the engine with the pages instead of carrying its own copy: its
 * file imports from ../chunks/. A worker built on its own (Vite's
 * `new Worker(new URL(…))`) imports nothing.
 * @param {{ path: string, text: string }[]} workers the files under workers/
 * @returns {string[]}
 */
export function calibrationWorkerViolations(workers) {
	const entry = workers.filter((f) => CALIBRATION_WORKER.test(f.path));
	if (entry.length !== 1) {
		return [
			`Expected one calibration worker (workers/autocal.worker-*.js) in the build, found ${entry.length}. frontend/vite.config.ts (autocalWorkerChunk) emits it; check the plugin still runs and names it.`,
		];
	}
	if (!SHARED_CHUNK_IMPORT.test(entry[0].text)) {
		return [
			`The calibration worker ${entry[0].path} imports nothing from the page build's chunks/: it carries its own copy of the engine again. Start it with the URL from 'virtual:autocal-worker-url' (frontend/vite.config.ts, autocalWorkerChunk), not new Worker(new URL(…)).`,
		];
	}
	return [];
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
	const files = paths.map((p) => ({ path: relative(buildDir, p), gzipBytes: gzipSync(readFileSync(p)).length }));
	const m = measure(files, tabs.files, landing.files);
	const rows = [
		['Total gzipped JS+CSS', `${m.totalCodeKb} KB`, `${BUDGET.totalCodeKb} KB`],
		[`Largest chunk (${m.largestChunk.path})`, `${m.largestChunk.kb} KB`, `${BUDGET.largestChunkKb} KB`],
		[`Largest tab chunk (${m.largestTabChunk.path || 'none'}; ${m.tabCount} tab files)`, `${m.largestTabChunk.kb} KB`, `${BUDGET.largestTabChunkKb} KB`],
		[`Largest worker (${m.largestWorker.path || 'none'})`, `${m.largestWorker.kb} KB`, `${BUDGET.largestWorkerKb} KB`],
		[`Largest spreadsheet worker (${m.largestSpreadsheetWorker.path || 'none'})`, `${m.largestSpreadsheetWorker.kb} KB`, `${BUDGET.largestSpreadsheetWorkerKb} KB`],
		[`Largest other asset (${m.largestAsset.path || 'none'})`, `${m.largestAsset.kb} KB`, `${BUDGET.largestAssetKb} KB`],
		[`Landing page (${landing.files.size} files)`, `${m.landingKb} KB`, `${BUDGET.landingKb} KB`],
	];
	for (const [what, size, budget] of rows) console.log(`${what}: ${size} (budget ${budget})`);
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
	const bad = [...tabs.errors, ...landing.errors, ...stale, ...violations(m), ...calibrationWorkerViolations(workers)];
	for (const v of bad) console.error(`::error::${v}`);
	process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
