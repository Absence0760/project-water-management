# Comparing runs

A hydrologist runs a baseline, changes something (raises a dam, changes crops,
adds a transfer), runs again, and wants to know what changed, both in the
inputs and in the results. The compare page answers that for any two runs you
can see. They can come from the same project or from two projects, such as
project D copied from C and then modified.

## Using it

Open `/compare?project=<id>`. The page starts on that project's **previous
run (A)** and **latest run (B)**. Each side has its own project and run
picker, so either side can point at another project. The URL holds the choice
(`/compare?a=<projectId>:<runId>&b=<projectId>:<runId>`), so a comparison can be
bookmarked or shared with anyone who can see both projects.

If a project has fewer than two runs, the page explains what to do: run the
model, change something, and run it again, or pick a run from another project
as B.

The page has these sections, top to bottom:

1. **Runs compared.** Label, project, period and time of each run. There is a
   warning when the two runs cover **different periods**, because every result
   is a daily average over the run's own period, so some of the change comes
   from the dates. There is a note when the **engine version** differs.
2. **What changed.** Every difference in the inputs, grouped by network, crops,
   transfers, settings and time series. Examples:
   *"Rooikloof: dam capacity 600,000 m³ → 720,000 m³"*,
   *"Crop "Apples" added to Bergwater (40 ha)"*,
   *"Calibration peak flow coefficient a: 0.09 → 0.12"*,
   *"Rainfall (catchment) series extended to 2025-04-12 (was 2024-09-30)"*,
   *"Calibration exclusion WY 2015/16 added: “rain gauge moved”"*,
   *"Fit record: parameters edited since the fit (x1)"*.
3. **Headline results.** Total irrigation supplied and deficit, share of demand
   supplied, farms below 95 % supplied, EWR days not met, mean outflow and
   natural flow, the runoff coefficient (natural flow ÷ rain), and the
   calibration statistics (KGE, NSE, percent bias, RMSE) for A and B side by
   side, with the change. The calibration table is labelled **calibration
   period (in-sample)**: each run is scored on the days its parameters were
   tuned on. Under it, **Fit and validation** sets each run's fit record side
   by side: the fit (model, time, objective, seed), the bounds it searched
   (wide or typical, model.md §2.10b), its in-sample score, its split-sample,
   wet-year and independent-record scores ("not run" when that test wasn't),
   whether (and what) the WR2012 MAR penalty pulled towards, and whether the
   parameters were edited since the fit. A run whose parameters didn't come
   from Fit automatically reads "none". To judge the runoff models against each other, copy
   the project, set the copy to GR4J (Settings → Flow calibration), run both
   and compare them. The input diff then reads *"Runoff model: legacy (b023
   recession) → GR4J"*, followed by any GR4J parameter or pan-coefficient
   changes.

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
4. **EWR test against observed flow** (issue #4). The two runoff models can
   disagree strongly on how many days the EWR is not met; the observed record
   settles it, because a gauge or logger measures the same outflow the EWR
   test uses ([model.md §2.9b](./model.md)). A table gives both runs' overall
   frequency bias (closer to 1 is better), hit rate (higher is better),
   false-alarm ratio (lower is better), the model's and the observed share of
   days below the EWR, and the number of observed days compared, with the
   change (`RunComparison.ewrAgreement`). Below it, each run's full table (the
   2×2 table of observed days, per month and per water year) sits side by
   side, stacked on narrow screens. Compare runs over the same observed days:
   if the day counts differ, part of the difference comes from the record.
5. **Farms.** One row per farm with run B's value and the change from A for
   demand, supplied, deficit, % supplied, EWR shortfall and days EWR not met.
   Click a column heading to sort by that change. Farms that exist in only one
   run are listed underneath.
6. **Hydrograph.** One catchment series (simulated outflow by default) from
   both runs on the same chart.

Every change is **B − A**. A change is shown with a sign and ▲/▼. Green means
better and red means worse (for example, less deficit or fewer EWR days not
met). Grey means the change is neither: demand and flow are "just different".
The better/worse judgement is also in the text read out by screen readers and
in the tooltip, so colour is never the only cue. For percent bias, closer to 0
is better; for the EWR frequency bias and a ratio to WR2012, closer to 1. A change that rounds to zero is shown as plain "0".

## How runs are matched

Copying a project gives every node, crop and transfer a new id, so ids alone
can't line up two projects. Everything is matched **by id first, then by
name**:

- **Same project:** ids match, so a farm you renamed between runs is still the
  same farm (shown as "Rooikloof (was Farm 1)").
- **Across a copy:** names match (trimmed, case-insensitive). A farm renamed
  *and* copied can't be matched, so it appears under "Only in run A / B".
- **Crop areas** are matched by (farm name, crop name). **Transfers** are
  matched by id, then by their "from → to" route.

## What the input diff can and can't see

Each run stores a snapshot of its inputs in `model_run.inputs`: the settings
(merged over the defaults), the whole model document, and each driving series'
**start date, length and a SHA-256 hash of its values** (`valuesSha256`).
Series values themselves are not stored. So "What changed" reports a series
that was added, removed, extended or trimmed, and — from the hash — values
edited **inside the same dates** (for example a corrected logger reading:
*Observed flow values changed (same dates, … to …)*). Two limits: when the
dates changed too, only the date change is listed (one hash can't say whether
the shared days changed), and runs stored before the hash existed have none,
so an in-place edit between them isn't visible. If the results changed and
the list shows nothing, one of those is the likely reason.
Settings are compared after merging over the defaults, so an old snapshot that
stored only some fields doesn't show false differences. Every setting the
Settings tab edits has a readable line, including the curtailment reporting
window, the calibration window and flow series, and the gauge-vs-logger
thresholds (*"Data quality gauge/logger lowest ratio: 66.67% → 80%"*). Month
lists (transfer months, summer months) compare as sets, so re-ordering them is
not a change. A series that became empty says so rather than showing a
one-day range.

**Calibration provenance.** Calibration exclusions are matched by their
period (a water year, or a start–end range): one added or removed is listed
with its reason, and a new reason for the same period reads *"reason “…” →
“…”"*. The fit record each run carries (model.md §2.10b) is compared as a
whole: *"Parameters now from a GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed
7)"* when one run has none, *"Fit record: … → …"* for a different fit (time,
model or seed), and *"Fit record: parameters edited since the fit (x1)"* when
the same fit's parameters were edited by hand in between (or *"back to the
fitted values"*). A parameter edit itself still has its own line. Settings keys the engine doesn't know yet still appear as
*Setting "x" changed*.

## Where the code lives

| Piece | File |
| --- | --- |
| `compareRuns`, `diffInputs`, types | `packages/engine/src/compare.ts` (pure, unit-tested in `compare.test.ts`) |
| `GET /compare/runs` | `backend/src/compare/routes.ts`, contract in [api.md § Compare runs](./api.md#compare-runs) |
| Page | `frontend/src/routes/compare/+page.svelte` |
| Components + pure helpers | `frontend/src/lib/components/compare/` (`delta.ts` formatting and sorting, `picker.ts` URL state and defaults) |

Access follows the usual rules. You need at least **viewer** on both projects.
The endpoint returns `404` without saying which side you can't see.
