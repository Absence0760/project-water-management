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
//                   frontend/src/lib/spreadsheet/. The export worker carries
//                   SheetJS, which dwarfs the engine (the import worker has
//                   read workbooks with its own streaming reader since
//                   2026-09-25 and is far smaller); both load only when
//                   someone asks for a workbook, so they get a ceiling of
//                   their own rather than lifting the calibration worker's.
//                   Still counted in totalCodeKb; not in largestWorkerKb.
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
// Run:   pnpm build:frontend && pnpm check:bundle
// CI:    ci.yml, job `test`, after `pnpm build`.
// Tests: node --test scripts/guards/check_web_bundle_budget.test.mjs

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = Object.freeze({
	totalCodeKb: 963,
	largestChunkKb: 42,
	largestWorkerKb: 35,
	largestSpreadsheetWorkerKb: 95,
	largestAssetKb: 100,
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
			`Spreadsheet worker ${m.largestSpreadsheetWorker.path} is ${m.largestSpreadsheetWorker.kb} KB, over the ${budget.largestSpreadsheetWorkerKb} KB spreadsheet-worker budget. The export worker carries SheetJS (the import worker must not: it has its own reader); check a new import (or the full SheetJS build) is needed before raising the ceiling.`,
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
	const workers = paths.filter((p) => WORKER.test(relative(buildDir, p))).map((p) => ({ path: relative(buildDir, p), text: readFileSync(p, 'utf8') }));
	const bad = [...violations(m), ...calibrationWorkerViolations(workers)];
	for (const v of bad) console.error(`::error::${v}`);
	process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
