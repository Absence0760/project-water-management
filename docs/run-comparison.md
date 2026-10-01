# Comparing runs

A hydrologist runs a baseline, changes something (raises a dam, changes crops,
adds a transfer), runs again, and wants to know what changed, both in the
inputs and in the results. The compare page answers that for a **baseline and
up to two what-ifs** you can see (issue #17, board A4). They can come from the
same project or from other projects, such as project D copied from C and then
modified.

## Using it

Inside a project, open the **Compare runs** tab (under *Outcomes* in the
workspace, `?tab=compare`; also the **Compare runs** link on the Runs tab's
runs list). Its runs live in the workspace URL
(`?tab=compare&a=<projectId>:<runId>&b=<projectId>:<runId>[&c=…]`,
`compareTabHref` in `compare/picker.ts`): `a` is the **baseline** (run A),
`b` **what-if 1** (run B) and the optional `c` **what-if 2**. Any of them can
be a run of another project. A two-run link (no `c`) opens exactly as it
always did.
The same view is the standalone page `/compare?project=<id>`, which links
**Back to runs**; its URL keeps working for bookmarks and cross-project links,
and an applicant (no workspace tabs) gets it from their application. Either
way the view starts on that
project's **latest run (what-if 1)** against its **published run
(baseline)**, the run stakeholders see (WP-2.3), when there is one and
it isn't the latest; otherwise against the **previous run**
(`defaultPair` in `compare/picker.ts`).

**A second what-if.** **+ Add a second what-if** puts the newest run of the
baseline's project that is neither the baseline nor what-if 1 in `c`
(`defaultWhatIf`); when every run is taken, its card waits for a pick.
**Remove** drops `c`. The backend compares two runs, so the page calls
`GET /compare/runs?a=<baseline>&b=<what-if>` once per what-if, in parallel;
there is no three-way endpoint.

**Compare with published.** Whenever the pair is chosen and B's project has
a published run that is neither B nor already A, a **Compare with
published** button under the run cards sets the baseline (A) to it and keeps the what-ifs
(`publishedBaseline`), so "what does this change do against what
stakeholders were shown?" is one click. The Runs tab's results header has
the same link for any run other than the published one
(`/compare?a=<published>&b=<that run>`). An explicit `?a=`/`?b=` is never
replaced: the published run is only pre-selected when the page opens with
`?project=` alone, and otherwise offered.
Each run card has its own project and run picker, so any run can point at
another project. Each run option reads like a Runs list row, as text
(`runOptionLabel` in `compare/picker.ts`): label · when it ran · the years it
covers, then the tags that apply (latest, published, evidence or former
evidence, pinned, workbook comparison), e.g. "Baseline · 2026-09-23 15:06 · 1979–2024 ·
latest · pinned". Switching a side to another project picks that project's
newest run that isn't already the other side. The URL holds the choice
(`/compare?a=<projectId>:<runId>&b=<projectId>:<runId>`), so a comparison can be
bookmarked or shared with anyone who can see both projects.

If a project has fewer than two runs, the page explains what to do: run the
model, change something, and run it again, or pick a run from another project
as what-if 1.

### Export impact report

One action sits in the section header (beside **Back to runs** on the
standalone page). **Export impact report** opens a what-if's printable
report with its impact against the baseline as the first section
(`/projects/<id>/report?run=<what-if>&against=<baseline ref>`, [ui.md §
Report](./ui.md#report)): the same outcomes, takeaways and input changes as
this page, for printing or saving as a PDF. With two what-ifs it is a menu,
one entry per what-if. There is no create button here: a what-if is any
run, so a new one comes from running the model again or from the Scenarios
tab, and is then picked here like any other run. With no pair chosen yet,
the empty state says so and links the project's Scenarios tab.

### The summary (board A4)

Above the detail, for the baseline and every what-if at once
(`compare/summary.ts`, pure and unit-tested):

- **Run cards.** Each run's label; for the baseline its years, when it ran
  and its tags (published, evidence); for a what-if the one change that best
  says what it is (`leadChange`: the first change of the network, else crops,
  transfers, settings, then series, since a data extension says less about
  a what-if than an edit to the model) and a link to **all N changes**,
  which switches the full comparison to that what-if and scrolls to *What
  changed*. A what-if with no input changes says so (or names its scenario).
- **What changes** (`outcomeRows`): EWR not met (the share of days the
  EWR wasn't met, so runs of different lengths compare), irrigation supplied (share
  of demand), the irrigation deficit (m³/day), farms below 95 % supplied, a row for each of the (at most two)
  farms whose supply moves by at least 1 point in some what-if (matched on
  the baseline's node, so a farm missing from one what-if's comparison is
  "–" there, not 0), **dam storage at the end of the run** (when a run has
  a farm dam: all its dams' storage on the last day over their total
  capacity, weighted by capacity like the Summary's "Dams today", from the
  run summary's dam figures, engine ≥ 1.2.0, issue #55, and each run's own
  model's capacities, so a raised dam is a share of its new size; "–" for a
  run saved before those figures; no better/worse verdict and no takeaway,
  since a bigger dam can end emptier as a share yet hold more;
  `damStorageShare`, `compareDamStorage`), mean outflow, mean natural flow
  and the runoff coefficient (flow ÷ rain). The last three rows and the
  deficit came from the full comparison's Headline results *Water balance*
  table, which issue #175 merged in here (2026-09-29): four of its nine rows
  were this table's, its supplied m³/day restated the share and the deficit,
  and its days EWR not met restated the share of days. No days-a-year
  row (it was the EWR share × 365.25, the same number again) and no
  calibration NSE (a what-if's fit to the real gauge is not an outcome;
  Headline results → Calibration has it for calibration comparisons). Each what-if cell has its value and its change from the baseline
  through the same `Delta` / `formatDelta` as the detail tables (sign, ▲/▼,
  and "better"/"worse" in words).
- **Takeaways** (`takeaways`), what-if by what-if, only for material
  changes (`MATERIAL`: a whole day a year below the EWR, from the EWR
  not met share × 365.25, a point of the
  demand supplied, a farm crossing 95 %, 5 points of one farm's supply, 5 %
  of the mean outflow): "What-if 1 puts the river below the EWR on 13 more
  days a year", "What-if 2 puts the river below the EWR on 2 fewer days a
  year" (the pragmatic EWR's days, not the Reserve's rule months, so never
  "reserve"), "What-if 1 leaves 1 more
  farm below 95% supplied", "Under What-if 1, Farm 4 gets −12 pp of its
  demand", "What-if 1 lowers the mean outflow by 10%". A what-if with none
  "makes no material change to these outcomes". When both what-ifs add days
  below the EWR, one line says which costs less and by how much. A what-if over
  other dates, or on another engine version, gets a line saying part of its
  change comes from that.
- **Days below the reserve, each year** (`ReserveYearsChart.svelte`, a chunk
  shared with River & reserve): grouped bars per water year (Oct–Sep) for every run, from each
  run's stored `ewr_shortfall` series (through the Runs tab's series cache)
  by the engine's `reserveDaysByWaterYear` (`views/reserveYears.ts`). That
  is the test behind `summary.catchment.ewrDaysNotMet` (a day whose
  shortfall is below zero), so the years add up to it; counting outflow <
  EWR from the two flow series would miss the engine's noise tolerance. Part
  years at either end are drawn faded and marked in the table; a run that
  stored no shortfall series is named under the chart.

### The full comparison

Below the summary, **Full comparison** is today's two-run page for the
baseline (run A) against one what-if (run B): what-if 1, or what-if 2 when
it's picked in the **Baseline vs What-if 1 / 2** switch. Every panel and
note is as it was, and every change is B − A. It has these sections, top to
bottom:

1. **Runs compared.** Label, project, period and time of each run, and
   under each its **run notes** when it has any: the modeller's written
   explanation (e.g. why a WR2012 query stands), so a reviewer comparing
   two runs reads each one's reason with it. When either side is, or was,
   its project's **nominated evidence run** (`run.evidence`,
   [data-model.md](./data-model.md)), a note says so with the nomination's
   date, who and reason ("Run B is the nominated evidence run, nominated on
   … by … (“…”)"), and for a replaced one what replaced it and why ("Run A
   was the evidence run, …, then replaced by “B” on … because “…”";
   `runs/evidence.ts` `compareEvidenceNote`). A note says when both sides
   are the same run. There is a
   warning when the two runs cover **different periods**, because every result
   is a daily average over the run's own period, so some of the change comes
   from the dates. There is a note when the **engine version** differs, a
   note when the **CHIRPS bias factors** differ (`RunComparison.chirpsFit`:
   any month's applied factor, or the water years left out of the fit, with
   the pooled factor and left-out years of each side; from engine 0.29.0 also
   the CHIRPS fit period, its listed ranges, each range's factors and every
   fit's reference window (the water years that gave it shared days), with
   each side's period, ranges and windows named; `chirpsFit.ts`). A change of
   the `chirpsFitPeriod` setting itself is also a settings line ("CHIRPS fit
   period: whole record → listed water years: …"); a run saved before 0.29.0
   compares as the whole record, with no windows to compare. From engine
   1.53.0 the CHIRPS gap map (CR-23) is part of it too: `chirpsFit`
   carries each side's map in words (`quantileMapA/B`, null = off, only
   when either run had one) and a different map counts as a change; the
   note says "quantile map: off → …", and the `chirpsQuantileMap` setting
   is a settings line ("CHIRPS quantile map: off (the monthly factor
   alone) → on (wet days ≥ 1 mm)"); a run saved before it compares as off. The
   factors can move with no settings line at all: new rain data, a keep-dry
   or missing period (which since engine 0.18.0 also decides which days the
   fit uses, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)),
   a multi-day accumulation newly detected, kept or listed (engine ≥ 0.20.0,
   its window days are left out of the fit, [§2.4d](./model.md#24d-multi-day-rainfall-accumulations)),
   a rain-source period (engine ≥ 0.30.0, its primary days are left out of
   the fit), or the engine version. There is a note when the **rain-source
   periods** differ (`RunComparison.rainSource`, engine ≥ 0.30.0,
   [model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)):
   one line per period and run, with its dates, reason, series and its
   product label, the factors (Oct … Sep), where they came from (fixed with
   provenance, or a fit's reference, reference era and the water years that
   gave each ratio shared days: the reference windows) and its fallback, so
   two runs that used different reference eras, or a different alternative
   gauge product, say so (`compare/rainSource.ts`). A change of the
   `rainSource` setting itself is also a settings line ("Rain-source periods:
   none (the catchment series throughout) → 2012-10-01 to 2019-09-30: …"); a
   run saved before 0.30.0 compares as none. And there is a
   warning when **either run used the legacy runoff model** (a stored run
   from before engine 1.0.0, which removed it; audit H1): it doesn't conserve
   water at the event scale, so the comparison is a workbook comparison
   only, not evidence.
2. **What changed.** Every difference in the inputs, grouped by network, crops,
   transfers, settings and time series. **Who changed it and when** (issue
   #42): for two runs of one project, the earlier as the baseline, and
   neither a scenario run, a line over the list counts the saved model and
   settings changes between the runs and names who made them ("2 saved
   changes to the model or settings between the runs, by Ann and Bob", with
   a link to the project's History tab), and each model or settings line
   says which save set its final value: "Changed by Ann on 2026-09-26
   14:02 · “Licence application”" (the save's reason, when it has one).
   The saves are the project's `model_revision` rows made after the
   baseline ran and up to when the what-if ran; the matching rule is in
   [api.md § Compare runs](./api.md#compare-runs) (`attribution`). A
   series line carries no name (a series change is in the History tab), nor
   does a line no recorded save describes (a change made before history was
   recorded, say). Runs of two projects, a what-if older than its baseline
   and a scenario run (its inputs are its scenario on a base run, not a state
   the project was in) show no attribution. Examples:
   *"Rooikloof: dam capacity 600,000 m³ → 750,000 m³"*,
   *"Crop "Apples" added to Bergwater (40 ha)"*,
   *"Calibration rain threshold: 2 mm → 3 mm"*,
   *"Rainfall (catchment) series extended to 2025-04-12 (was 2024-09-30)"*,
   *"Calibration exclusion WY 2015/16 added: “rain gauge moved”"*,
   *"Multi-day rain accumulations: spread over the days they cover (CHIRPS pattern) → run as recorded (one day)"*,
   *"Fit record: parameters edited since the fit (x1)"*.
   A demand object's line names its category, size, return, priority,
   schedule and, from engine 1.44.0, the people it serves for its
   basic-needs floor (*"…, serves 2 000 people"*), so a change of people
   is listed like any other field.
   **The EWR sites** (engine ≥ 1.5.0, audit Q17 follow-on): when the list
   of EWR sites differs (a gauge added or removed, turned into a unit, or
   ticked or unticked as an EWR site), one network line names both runs'
   sites and why each came or went: *"EWR sites: Outlet (outlet), Weir →
   Outlet (outlet) (removed Weir (taken off the EWR sites))"*. A flag change
   is also its node's own line (*"Weir: EWR site yes → no"*), which the
   field history counts. A run saved before the flag reads as every gauge a
   site, so it compares equal to a model with every flag ticked.
   A change of GR4J's PE input (`settings.pe`, engine ≥ 0.31.0,
   [model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4))
   is a settings line labelled **Potential evaporation (GR4J)**. Each side
   reads "pan coefficient × A-pan" or "monthly PE, 1,105 mm/yr (source: …)",
   and a change of kind is "A → B". Between two monthly rows the line names
   the months that changed and the annual totals ("monthly PE Oct 110 →
   120 mm (1,105 → 1,115 mm/yr)"), or "changed in N months" when more than
   three did. A reworded source is listed too ("source "…" → "…""), since it
   is part of the run's record. A run saved before 0.31.0 has no `pe` and
   compares as pan coefficient × A-pan. A changed pan-coefficient source
   note (`panCoefficientSource`, engine ≥ 0.31.1) is its own line, **Pan
   coefficient source**, reading "none" where a run has none; likewise the
   dam evaporation factors' note (`lakeEvapFactorSource`, engine ≥ 1.49.0,
   a lake-factor preset's name and citation), **Dam evaporation factor
   source**.
   A change of the areal rainfall correction (`settings.arealRain`, engine
   ≥ 1.13.0, [model.md §2.4g](./model.md#24g-areal-rainfall-correction-engine--1130))
   is a settings line labelled **Areal rainfall correction (GR4J)**: "none →
   × 1.85 (map: …)" when one side has none (a run saved before 1.13.0 had
   none), else the months whose factor changed ("factors Oct 1.85 → 1.9"),
   a changed method and a reworded source.
   A change of the drought restriction rule (`settings.droughtRestriction`,
   engine ≥ 1.54.0, [model.md §2.7i](./model.md)) is one settings line per
   change, labelled **Drought restriction rule**: "off → reviewed 5 Oct;
   Level 1 (below 70 %): crops 50 %" when one side has none (a run saved
   before 1.54.0 had none, and one the run couldn't use counts as off),
   else the review and lift dates, each level's threshold ("level 1 starts
   below 70 % → 60 %"), name and cut per part ("level 1 cut on municipal
   (town) demand objects 0 % → 10 %"), levels added or removed, and a
   reworded source, and (engine ≥ 1.54.0) the storage read ("storage read
   every farm dam → the storage of Upper farm"), the units cut and the EWR
   trigger, nodes by name (engine `droughtRestrictionChanges`). A scenario that
   sets another rule shows here, so comparing two restriction policies
   lists what differs.
3. **Headline results.** A **Calibration against observed
   flow** table (KGE, NSE, percent bias, RMSE and the overlapping days) for A
   and B side by side, with the change. Its **Water balance** table
   (`HeadlineDeltas`, supply, deficit, EWR days, outflow, natural flow,
   runoff coefficient) is left out here (`water={false}`) since What changes
   carries those rows (issue #175); the scenario comparison, which has no
   What changes table, still shows it. The calibration table says whether
   the scores are in-sample (issue #45, `comparison.calibration.fitStatus`):
   **calibration period (in-sample)** when both runs' parameters were fitted
   on the days scored, the shared reason when neither was ("parameters not
   fitted", "parameters edited since the fit", "not the period fitted"), and
   "run A …, run B …" when they differ. Under it, **Fit and validation** sets each run's fit record side
   by side: the fit (model, time, objective, seed), the bounds it searched
   (wide or typical, model.md §2.10b), its in-sample score, its split-sample,
   wet-year and independent-record scores ("not run" when that test wasn't),
   whether (and what) the WR2012 MAR penalty pulled towards, whether the
   parameters were edited since the fit, and whether that run's own forcing
   (pan coefficient, A-pan evaporation, PE input, CHIRPS bias correction,
   zero-rain runs and multi-day accumulations) has changed since its fit ("no" when the fit predates recorded
   forcing — nothing to compare). A run whose parameters
   didn't come from Fit automatically reads "none". A stored legacy run
   compared with a GR4J run (every run since engine 1.0.0) reads *"Runoff
   model: legacy (b023 recession) → GR4J"* in the input diff, followed by any
   GR4J parameter or pan-coefficient changes. The legacy model's own
   calibration settings (`a`, `b`, the season factors, summer months, the
   initial base flow, the recession tables) changed a run only if it ran
   that model, so they are compared only between two legacy runs.

   When either run has a **WR2012 check** (model.md §2.10c), another table,
   *WR2012 check · simulated natural ÷ scaled WR2012*, gives the MAR ratio over
   the overlapping years and over the whole run, the dry-season ratio and the
   monthly pattern correlation for A and B. For the ratios, closer to 1 is
   better; for the correlation, higher is. A run without the check shows "–".
   Every WR2012 input is in *What changed*: the reference being added or
   removed (*"WR2012 reference added (A21B, MAR 12 Mm³/a over 100 km²,
   1990/91 – 2009/10)"*), each of its fields (quaternary, area, MAR, MAP,
   period, source), the monthly means by month, the scaling rule, the
   dry-season months, each deviation threshold, and the calibration penalty,
   its weight and its MAR band (model.md §2.10c).

   When either run has an **EWR rule table** (engine ≥ 0.21.0, model.md §2.9c),
   *Reserve compliance by month* gives, per EWR site (the outlet first, then
   gauges matched by id, then by name across a copy), the share of months
   met, the months not met, the deficit (m³), the longest run of months not
   met and the FDC check for A and B (`RunComparison.ewrAssurance`), and,
   under it, the share of months met per month of the year. More months met
   is better. From engine 1.19.0 (CR-29, model.md §2.9c), when either run has
   them, *Days not met (daily)* and *Volume not met (daily)* (lower is
   better) and *EWR as % of natural MAR* (neutral: it moves only with the
   natural flow or the table) join the table, and under it **Flow-duration
   curves on the EWR** (`compare/EwrFdcCompare.svelte`, reusing the Reserve
   panel's `runs/EwrFdcOverlay.svelte`): per site of run A matched in run B,
   a month select with run A's natural and present-day curves, run B's
   curve (named "Run B: scenario “…”" when B is a scenario run) and the EWR
   curve. Run B's curve is left out, with a note, when its table has other %
   points. A site with a table in one run only says so, and when the two
   runs' tables differ (values, points, unit, scale or natural source) a note
   says the rates measure against different rules. *What changed* lists each
   table added or removed (*"EWR rule table at the outlet added ("Reserve
   determination, table 4", 10 % points, natural percentile from the run)"*),
   each field changed (source, the kind of source, engine ≥ 1.5.0: *"kind
   of source not stated → Desktop estimate, low confidence"*, what it covers,
   unit, natural source, scale, % points) and the months whose EWR values or
   natural flows changed. From
   engine 0.33.0 (model.md §2.9d), when either run has them, *Low flows:
   months met* and *High flows: years met* (years met ÷ years the natural
   flow had the event, over every component) join the table, a changed
   low-flow grid or component makes the tables "different", and *What
   changed* says "low-flow values added / removed / changed in Feb" and
   "high-flow components Freshet → Freshet (values changed)".
4. **EWR test against observed flow** (issue #4). Two runoff models (a
   stored legacy run against a GR4J one) can disagree strongly on how many days the EWR is not met; the observed record
   settles it, because a gauge or logger measures the same outflow the EWR
   test uses ([model.md §2.9b](./model.md)). A table gives both runs' overall
   frequency bias (closer to 1 is better), hit rate (higher is better),
   false-alarm ratio (lower is better), the model's and the observed share of
   days below the EWR, and the number of observed days compared, with the
   change (`RunComparison.ewrAgreement`). Below it, each run's full table (the
   2×2 table of observed days, per month and per water year) sits side by
   side, stacked on narrow screens. Compare runs over the same observed days:
   if the day counts differ, part of the difference comes from the record.
5. **Plausibility checks** (engine ≥ 1.4.0 compares them, issue #64;
   `plausibility/compare.ts` `comparePlausibility`,
   `compare/PlausibilityCompare.svelte`), under its own heading; see
   [Plausibility checks](#plausibility-checks) below.
6. **Farms.** One row per farm with run B's value and the change from A for
   demand, supplied, deficit, % supplied, EWR charge and days charged for the
   EWR (engine ≥ 0.17.0, audit Q17; a run from an older engine holds its reach
   shortfall AB there, so compare runs of the same engine).
   Click a column heading to sort by that change. Farms that exist in only one
   run are listed underneath. When either run holds a **feature metric** for
   any farm in both runs, its column joins: *Pumped from the river*
   (`avgRiverAbstractionM3Day`, WP-3.8), *Groundwater*, *Groundwater to dam*
   and *Stream depletion* (WP-1.34, WP-3.9). A farm without the feature in a
   run reads **0** there, marked "(none)" under B's value or "A: none (0)"
   under the change, and a note under the table says why ("a run with no
   river pump at a farm reads as 0 there"), under the rule in
   [Series and metrics only one run has](#series-and-metrics-only-one-run-has)
   (`delta.ts` `farmFeatureMetrics`). These columns don't sort.
7. **Assurance of supply** (WP-3.4, issue #70; `compare/assurance.ts`
   `compareAssurance`, `compare/AssuranceDeltaTable.svelte`, shown when
   either run has `summary.supplyAssurance`, engine ≥ 0.32.0). One row per
   farm and other water user, matched by name (namesakes pair off in
   order), with run B's value and the change from A for the share of
   demand days fully met, the volume supplied, the water years met (B's
   "3 of 4" beside it, A's under the change) and the longest run of days
   not fully met. Notes say when the runs used different annual thresholds
   or reporting windows, and units in one run only are listed underneath.
   A run from an older engine has none: a note says to rerun it. The
   Scenarios tab's comparison shows the same table.
8. **Daily series** (issue #8; `compare/CompareOverlay.svelte`, a chunk
   shared with the Scenarios tab). Pick a **node** and one of its **series** (outflow, dam storage,
   supplied, EWR charge, …), and run A and run B are drawn on one chart, with
   **B − A** on a second chart underneath. It opens on the catchment's
   simulated outflow; switching node keeps the same kind of series when the
   new node has it, else its outflow. Nodes are matched the way the rest of
   the page matches them (below): by id, then by name across a copy, listed
   in network order with a renamed node shown as "Rooikloof (was Farm 1)".
   Series both runs stored with the same unit are offered, and after them a
   **feature series only one run stored** (a scenario's river pump:
   *Pumped from the river … · run B only*), the other run drawn as zeros over
   its own period, its legend entry ending "none (0)", and a note under the
   chart: "Not in run A: shown as 0. Run A has no such feature at Upper farm
   …" (the rule: [Series and metrics only one run has](#series-and-metrics-only-one-run-has)).
   A node only
   one run has can't be overlaid, and a note under the chart names it ("Only
   in run B, so nothing to overlay: New farm."), as it does a node whose
   series share nothing. Under the overlay a sentence reads the pair out over
   the days both runs have a value: mean A, mean B, mean B − A, the days B is
   higher and lower, and the day of the largest change (three significant
   figures, so a small daily change doesn't round to 0). The charts behave
   like every daily chart: Earlier / Later and Shift+drag pan through the
   record, the last three years or the full period, and on a flow series the
   log scale and the m³/s ↔ m³/day switch (the read-out follows the unit). A
   day either run has no value for is a gap in B − A, never zero. Series come
   from the existing `GET /projects/:id/runs/:runId` (which series a run
   stored) and `…/series?key&nodeId` (the values, one pair at a time); no
   compare-specific route.

**Uncertainty** (engine ≥ 0.26.0, issue #4 phase 9, [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9);
`uncertainty/PairedUncertaintyPanel.svelte`, in Compare runs' chunk), after the
headline results, for two runs of **one project**:

- Each run's own newest band side by side (EWR days not met, shortfall,
  outflow MAR, 5–95 %), and what differs between their **rules**: the stored
  thresholds and options, diffed (`diffEnsembleOptions`), or "Both bands use
  the same rule". Two bands with different thresholds are not comparable
  as they stand, and the page says so.
- The **paired band on B − A**: every parameter set A's newest ensemble kept
  is run again, unchanged, on B's inputs, and the difference is taken set by
  set (`runPairedEnsemble`, `summarisePaired`). Pairing cancels the
  catchment-response uncertainty both runs share, so this is the change's
  own impact: for a licence application, its extra impact with its
  uncertainty. The table gives 5 %, median and 95 % of B − A for EWR days not
  met (with the share of sets in which B fails the EWR on more days),
  shortfall (with the same share), outflow MAR, Reserve compliance (in
  percentage points) and curtailment per farm in both runs, then EWR days not
  met by month; farms in only one run are named. The decision rule is printed
  above it. Same inputs give exactly zero.
- It needs A to have a stored ensemble, one runoff model (bands of two models
  are never pooled: "The runs use different runoff models … no paired band")
  and one period. An editor of B's project computes it (**Compute the paired
  band**): the server copies A's seed and rule, the browser runs the pairs,
  the server re-runs the first pair and three at random before storing it
  under run B ([api.md](./api.md#uncertainty-bands)). Cross-project pairs
  get a note instead: the parameter sets describe one catchment.

Every change is **B − A**. A change is shown with a sign and ▲/▼. Green means
better and red means worse (for example, less deficit or fewer EWR days not
met). Grey means the change is neither: demand and flow are "just different".
The better/worse judgement is also in the text read out by screen readers and
in the tooltip, so colour is never the only cue. For percent bias, closer to 0
is better; for the EWR frequency bias and a ratio to WR2012, closer to 1; for Reserve compliance, more months met. A change that rounds to zero is shown as plain "0".

### Plausibility checks

`RunComparison.plausibility` sets each run's own hydrologist plausibility
checks ([model.md §2.10d](./model.md#210d-hydrologist-plausibility-checks-engine--0250-issue-4-phase-6))
side by side, as each run computed them: nothing is recomputed, so a run
keeps the tolerances of the engine that made it. One table, a row per check
and site, with run A, run B and the change:

- **Per site**: the outlet, then each gauge node with its own observed record
  (engine ≥ 1.4.0, `plausibility.gauges`), matched by node id, then by name
  across a copy (a renamed gauge shows "(was …)"; a gauge only one run
  checked gets a note). Two rows each:
  - *Natural ≥ observed + abstraction*: the water years that fail and how many
    were judged ("fails 2001/02, 2002/03: 2 of 3 (gauge)", "passes all 3"),
    and the change: the years **newly failing** and **now passing**, among the
    years both runs judged;
  - *Dry-season Q90, simulated ÷ observed*: the ratio and whether it is within
    the factor of 2, and the change in the ratio.
- **Catchment-wide**: *EWR days by rain source* (the share of days not met in
  fallback-rain and good-rain years, "(warns)" when the run warned) and
  *Observed flow vs rain* (the double-mass breaks the model doesn't share,
  each with its change and hint), with the change in fallback-rain years or
  in the whole-record runoff ratio.

Each result is marked pass (green) or fail (red) in words and colour; "not
checked" when that run couldn't make the check (no record, too few years, or
a run before engine 0.25.0, whose side is empty). A site neither run could
check is left out; the panel is absent when neither run has checks. The
typical use is before and after a refit or new data: which years stopped
failing, and whether the low flows moved inside the factor of 2. A gauge's
own record also shows in *What changed* by its gauge ("Observed flow at gauge
Middle weir series added …").

## How runs are matched

Copying a project gives every node, crop and transfer a new id, so ids alone
can't line up two projects. Everything is matched **by id first, then by
name**:

- **Same project:** ids match, so a farm you renamed between runs is still the
  same farm (shown as "Rooikloof (was Farm 1)").
- **Across a copy:** names match (trimmed, case-insensitive). A farm renamed
  *and* copied can't be matched, so it appears under "Only in run A / B".
- **Reserve compliance** sites: the outlet with the outlet, a gauge by id,
  then by name.
- **Crop areas** are matched by (farm name, crop name). **Transfers** are
  matched by id, then by their "from → to" route. **Individual boreholes**
  (engine ≥ 0.36.0, WP-3.9) are matched by id, then by (node name, borehole
  name): added, removed, or changed with the old and new capacity, mode,
  target, annual cap and depletion. **Demand objects** (engine ≥ 1.7.0) are
  matched by id, then by (unit name, object name): added, removed, or
  changed with the old and new category, size, return, priority and
  schedule, and (from engine 1.45.0, since a scenario's `demandObject.set`
  may change it) the note saying where its number comes from, spaces aside.

### Series and metrics only one run has

A run stores some columns only when a feature is on (issue #54): a river
pump (`river_abstraction`), boreholes (`groundwater_used`,
`groundwater_to_dam`, `baseflow_depletion`, …), a release rule
(`dam_release`), land cover (`landcover_reduction`), senior users
(`senior_requirement`, `passed_for_senior`), a seepage return share
(`dam_seepage_lost`). A run without the feature there moved none of that
water, so comparing a river-first scenario with its dam-first base is its
pumping against 0. Anything else one run lacks is **unknown**, and is never
drawn as 0. A missing series or farm metric reads as 0 only when all of
these hold:

- **The node is in both runs**, matched as above. A node only one run has
  stays under "Only in run A / B": it wasn't modelled there at all.
- **Both model snapshots know it as the same kind** (farm, gauge, other
  user). A node missing from a snapshot, or a farm in one run and a user in
  the other, is not filled.
- **The column is a feature column for that kind**: marked `optional` in the
  engine's column registry (`packages/engine/src/verify/columns.ts`,
  `FARM_COLUMNS`, `USER_COLUMNS`, `GAUGE_COLUMNS`). For the catchment
  (no node) only `landcover_reduction`, which the engine stores only when a
  node has land cover. So observed flow, calibration series, CHIRPS or any
  core column (a `dam_storage` an older run didn't store) are never filled.
- **The other run has no series under that key.** Both stored, but in
  different units, still isn't offered.

The daily overlay's zeros cover the lacking run's own period (its start to
end date, `overlay.ts` `zeroSeries`), so B − A and the read-out count the
days that run modelled. The farm table's feature columns follow the same
rule on the farm summary's optional fields (`FarmSummary` in the engine's
`project.ts`: present only for a farm with the feature). The helpers are
`overlay.ts` `zeroFillable` / `commonOptions` and `delta.ts`
`farmFeatureMetrics`, unit-tested beside them.

## Scenario runs

A [scenario](./scenarios.md) run is an ordinary run with `scenarioId` set, so
comparing it with its base (`?a=<p>:<baseRun>&b=<p>:<scenarioRun>`) needs
nothing new. A scenario keeps its base's ids, so every change lines up **by
id**: a 20 % dam raise on Rooikloof is one "What changed" line, *Rooikloof:
dam capacity 100,000 m³ → 120,000 m³*, and Rooikloof's farm row pairs with
itself. A node the scenario added shows under "Only in run B", one it removed
under "Only in run A".

`GET /compare/runs` adds each side's **scenario**
([api.md § Compare runs](./api.md#compare-runs)): its name, the ops exactly as
that run applied them and how each op was classed (`proposal` or `baseline`,
[scenarios.md § Classification](./scenarios.md#classification-proposal-or-baseline-assumption)).
They come from the run's own snapshot (`inputs.scenario`), not from the
scenario as it is now, so a scenario edited, rebased or deleted since still
shows the ops that produced the run. The compare page's **Scenario overrides**
section (`scenarios/ScenarioOverrides.svelte`, its own chunk, shown only when
a side is a scenario run) lists them above "What changed", each in words and
with its class, and the red "Baseline assumptions changed" callout when any
op is `baseline`. When the other side is the scenario's own base, each op is
described against it (the value it replaced). The Scenarios tab's own
comparison ([ui.md § Scenarios](./ui.md#scenarios-tabscenarios)) reuses the
headline, farm and daily-overlay components.

## What the input diff can and can't see

Each run stores a snapshot of its inputs in `model_run.inputs`: the settings
(merged over the defaults), the whole model document, and each driving series'
**start date, length and a SHA-256 hash of its values** (`valuesSha256`).
Since migration 021 each run also stores the series' **values**
(`run_input_series` + `series_blob`), and the compare route hands both runs'
values to `diffInputs` for every series whose dates or hash differ. So "What
changed" reports a series that was added, removed, extended or trimmed, and
then compares **the days both runs cover, value by value**
(`sharedDaysChange`): *Rainfall (catchment) values changed on 53 of the 366
days both runs cover (… to …); their total fell 15% (1,060 → 901)*. An edit
can't hide behind a date change: rain cut by 15 % with one day added used to
read only "series extended". A gap opened or filled counts as a changed day
and stays out of the totals (the total is left out when it didn't move).
Runs from before stored values fall back to the hash: identical dates with a
different hash read *values changed (same dates, … to …)*, and different
dates add *the days both runs cover were not checked for edits*, so the limit
is said rather than implied. Runs stored before the hash existed show
nothing for an in-place edit. If the results changed and the list shows
nothing, that is the likely reason.
Each series' **product and version** is in the snapshot too
(`provenance`, 032_series_provenance; null = not recorded). When both runs
recorded it and it differs, the diff says so on its own line, whatever the
dates and values do: *Rainfall (CHIRPS) is now CHIRPS sat v3.0 (was CHIRPS
v2.0): the monthly CHIRPS factors are fitted on the new values, and a
calibration made on the old ones no longer holds* (issue #40 part c). A run
saved before it was recorded has nothing to compare, so it shows no line.
The fit record's "Forcing changed since fit" row reads the same label
(model.md §2.10b).
A model from a run saved before engine 0.16.0 is read as migration 006 stored
it (`upgradeLegacyModel`: return flow % r becomes irrigation efficiency
1 − r with every loss returning), so a project that only went through the
migration shows no network line; the engine version line flags the change.
Settings are compared after merging over the defaults, so an old snapshot that
stored only some fields doesn't show false differences. Every setting the
Settings tab edits has a readable line, including the curtailment reporting
window, the calibration window and flow series, and the gauge-vs-logger
thresholds (*"Data quality gauge/logger lowest ratio: 66.67% → 80%"*) and the
other data-check limits (engine ≥ 1.20.0: *"Data quality zero-rain run CHIRPS
check: off → on"*; a snapshot from before them compares as their defaults,
which it ran), and the
soil-water store (*"Soil-water store (effective rain carry-over): 25 mm → 0
mm"*). Runs store their settings merged over the defaults, so a snapshot
without a store size predates it (engine < 0.14.0) and compares as 0 mm, which
is what that run used; the same rule reads a snapshot without a runoff model
as legacy (a run from before the setting, so it did run the legacy model), and one without a dam evaporation factor (engine < 0.16.0) as 0,
no dam evaporation. A dam's area when full, area exponent and seepage have
their own network lines (*"Rooikloof: dam area when full 0 m² → estimated
(capacity ÷ 3 m)"*). Month
lists (transfer months, summer months) compare as sets, so re-ordering them is
not a change. A series that became empty says so rather than showing a
one-day range. A registered volume's line (engine ≥ 1.35.0, issue #73)
covers its storage, months of use and maximum rate as well as its source,
volume and validity, so a licence condition changed on its own is listed
(*"Rooikloof: registered volume surface 120 000 m³/a → surface 120 000
m³/a, at most 0.02 m³/s"*); before, only the volume, source and validity
were compared. From engine 1.59.0 (issue #72) its water use is compared too,
and a storage-only (s21b) row reads *"surface storage only (s21b), storage
80 000 m³"* in place of a volume a year. Land cover is compared per farm and class on its condensed
area, and from engine 1.35.0 on its area and each patch's cover too, so a
patch at no cover that grows, or one whose cover changes on no area, is
listed (*"… 0 km² → 0 km² condensed (area 1 km² → 2 km²)"*, *"…, its
patches’ cover changed"*).

**Calibration provenance.** Calibration exclusions are matched by their
period (a water year, or a start–end range): one added or removed is listed
with its reason, and a new reason for the same period reads *"reason “…” →
“…”"*. The fit record each run carries (model.md §2.10b) is compared as a
whole: *"Parameters now from a GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed
7)"* when one run has none, *"Fit record: … → …"* for a different fit (time,
model or seed), and *"Fit record: parameters edited since the fit (x1)"* when
the same fit's parameters were edited by hand in between (or *"back to the
fitted values"*). A parameter edit itself still has its own line. The
project's declared uncertainty rule for evidence (issue #71,
`settings.evidenceUncertaintyRule`) is one line, **Declared uncertainty rule
(evidence)**, the whole rule in words either side (`declaredRuleText`, "not
declared" when absent). It changes no result, so the line only says the two
runs were made under different declared rules. Settings keys the engine doesn't know yet still appear as
*Setting "x" changed*.

## Where the code lives

| Piece | File |
| --- | --- |
| `compareRuns`, `diffInputs`, types | `packages/engine/src/compare.ts` (pure, unit-tested in `compare.test.ts`) |
| `GET /compare/runs` | `backend/src/compare/routes.ts`, contract in [api.md § Compare runs](./api.md#compare-runs) |
| Page | `frontend/src/routes/compare/+page.svelte` (heading, back link, URL) and the workspace's `compare` tab, both showing `lib/components/compare/CompareView.svelte` (the pickers and the comparison; the host passes the pair and builds URLs through `hrefFor`) |
| Components + pure helpers | `frontend/src/lib/components/compare/` (`delta.ts` formatting, sorting and the farm feature columns, `picker.ts` URL state and defaults, `chirpsFit.ts` the CHIRPS factors note, `overlay.ts` the daily series overlay's node matching, zero-filled feature series, B − A and read-out, exported for reuse by scenario comparison, issue #18) |
| Uncertainty and paired bands | `packages/engine/src/uncertainty/paired.ts`; `frontend/src/lib/components/uncertainty/PairedUncertaintyPanel.svelte` |

Access follows the usual rules. You need at least **viewer** on both projects.
The endpoint returns `404` without saying which side you can't see.
