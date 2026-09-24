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
   *"Rainfall (catchment) series extended to 2025-04-12 (was 2024-09-30)"*.
3. **Headline results.** Total irrigation supplied and deficit, share of demand
   supplied, farms below 95 % supplied, EWR days not met, mean outflow and
   natural flow, the runoff coefficient (natural flow ÷ rain), and the
   calibration statistics (KGE, NSE, percent bias, RMSE) for A and B side by
   side, with the change. To judge the runoff models against each other, copy
   the project, set the copy to GR4J (Settings → Flow calibration), run both
   and compare them. The input diff then reads *"Runoff model: legacy (b023
   recession) → GR4J"*, followed by any GR4J parameter or pan-coefficient
   changes.
4. **Farms.** One row per farm with run B's value and the change from A for
   demand, supplied, deficit, % supplied, EWR shortfall and days EWR not met.
   Click a column heading to sort by that change. Farms that exist in only one
   run are listed underneath.
5. **Hydrograph.** One catchment series (simulated outflow by default) from
   both runs on the same chart.

Every change is **B − A**. A change is shown with a sign and ▲/▼. Green means
better and red means worse (for example, less deficit or fewer EWR days not
met). Grey means the change is neither: demand and flow are "just different".
The better/worse judgement is also in the text read out by screen readers and
in the tooltip, so colour is never the only cue. For percent bias, closer to 0
is better. A change that rounds to zero is shown as plain "0".

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
one-day range. Settings keys the engine doesn't know yet still appear as
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
