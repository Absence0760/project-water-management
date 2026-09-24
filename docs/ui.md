# The catchment workspace (UI)

A project opens on `/projects/:id`. The page loads the project, its model,
the input-series list and the runs list behind one loading gate, so no tab
renders empty and then fills in. The Overview, Data and Runs tabs take those
lists as props and report changes back, so an upload or a run made on one tab
shows in the others (the Overview's counts and checklist included) without a
refetch. Tabs follow the modelling workflow:

| Tab | `?tab=` | Aliases | Code |
| --- | --- | --- | --- |
| Overview | (none) | | `lib/components/overview/` |
| Network | `network` | | `lib/components/network/` |
| Crops & demand | `crops` | `demand` | `lib/components/crops/` |
| Transfers | `transfers` | | `lib/components/transfers/` |
| Data | `series` | `data`, `timeseries` | `lib/components/series/` |
| Settings & calibration | `settings` | `calibration` | `lib/components/settings/` |
| Runs & results | `runs` (`&run=<id>`) | `results` | `lib/components/runs/` |

The model tabs (Network, Crops, Transfers) edit one in-memory model
(`lib/model/editor.svelte.ts`) and share the fixed save bar at the bottom.
Settings has its own save button, which sits above that bar.

**Popups and Escape.** Every popup closes on Escape: help tips (ⓘ), the
"Data up to" dropdown, the download menu and the dialogs. Help tips and the
"Data up to" dropdown also close on a click outside. The one exception guards
unsaved input: while **Add data** holds a file that is read but not uploaded
(or is uploading), Escape and ✕ ask before discarding it. Help-tip bubbles
render in the browser's top layer (a manual popover placed against the
button), so a scrolling table or a sticky header can't clip or cover them.

## Header: data freshness and "Add data"

- **Data up to 31 Mar 2025 · 12 days ago**: the latest end date across the
  input series. Click it for each series' end date. It turns amber when the
  newest data is more than 7 days old (`STALE_DAYS` in
  `series/freshness.ts`; a candidate for a project setting). Ages count
  calendar days up to the viewer's **local** date (`localIsoDate`), the same
  as the project list's badge, so the two never differ by a day around
  midnight. Series dates are calendar days, so the UTC date would be wrong
  for anyone east or west of UTC.
- **Add data** (editors) opens the upload form in a dialog on any tab.
  Dropping a CSV anywhere on the page opens it with that file.
- The upload form (`series/UploadForm.svelte`) guesses the series a file
  updates from its name and header (`guessSeries`). An existing series
  defaults to **append / update** (`POST /projects/:id/series/merge`): new
  days are added and overlapping days corrected. Days the file leaves blank
  keep their stored value. The preview counts new, changed and unchanged
  days before anything is sent. **Replace** overwrites the whole series.
- After an upload a banner offers **Re-run model**. Every tab notes new data
  since the last run: a rainfall series that reaches past the
  latest run's end, or was updated after it (`newDataSinceRun`).

## Overview

The setup checklist (`overview/checklist.ts`), eight headline facts, project
details, team and members. Email addresses (member rows here and on team pages,
pending invitations, the confirm-email banner) render through
`common/EmailText.svelte`, which lets them wrap before the `@` and after `.`,
`-`, `_` or `+` rather than mid-word on a phone.

## Network

- **Schematic** (`NetworkSchematic.svelte`, layout in `schematic.ts`): the
  drains-into tree with the outflow gauge at the bottom. Farms are circles,
  farms with a dam (≥ 1 m³) are filled squares, gauges are open triangles
  and the outflow gauge is a filled triangle. River lines thicken with the
  upstream area, and transfers are dashed arrows. Each transfer arc takes
  the smallest bend that keeps it off every node label and symbol and inside
  the drawing (`transferArc`), left of the nodes first since labels sit to
  their right. Editors can drag a node onto
  another to change what it drains into. Drops that would make a loop, or
  that move the outlet, are refused and the reason is shown. The "Drains
  into" select is the keyboard route. A visually hidden list ("Drainage
  tree") is the text equivalent of the drawing.
- **Table** (desktop default) or **One node** (phone default): every field has
  a unit, a help tip and an entry in the field guide. Percentages are stored
  0–1 and shown 0–100. Fields that only apply to farms show "–" on gauge rows.
  The flow share in use (with the Settings method) and its total are shown.
  The one-node form and the view-only table show thousands separators
  (300,000, the app's usual `fmtNum` style) on the non-% fields; a field
  switches to the plain number while it is being edited, and typed or pasted
  separators (`300 000`, `300,000`) are accepted (`NumberInput grouped`). The
  editable table keeps plain numbers.
- **Order**: rows reorder by drag handle or ↑/↓ buttons (focus stays on the
  moved row, and the new position is announced). **Sort by flow path** lists
  each tributary from its headwater down, with the outflow gauge last. The
  order is `node.sortOrder`, which is display only: runs always use the
  topological order. Every list of nodes uses it (`lib/model/order.ts`).

## Crops & demand

Crop factors run October to September and are reorderable. Planted areas
are entered in **ha** (stored as m²), with farm rows in network order and
reorderable. A **demand preview** uses the engine's
`grossFarmDemandM3PerDay`: m³/day per month, the mean, and Mm³/a per farm and
for the catchment. It is gross demand, before the daily effective-rain
reduction.

## Data

Each series shows its role in the model, its period, its last date and age,
% missing, a typical value (mean annual rainfall in mm/a, or mean flow), and
a strip showing coverage per year. Series a run won't read (not the first of
their kind by name) are marked. Clicking a row (or its View button) shows
that series in the chart below. Uploads read year-last dates (DD/MM/YYYY or
MM/DD/YYYY) in one order for the whole file, from any part above 12 (a file
mixing both is rejected; one with no part above 12 assumes day/month and the
summary says so). In number fields, a comma is a thousands separator only in a
valid grouping (1,500); otherwise a single comma is a decimal comma (1,5 = 1.5). The chart opens on the last 3 years and has
a log scale for flows. When both a gauge and a logger flow exist, a table
compares them per water year (engine `observedAgreement`) and flags years
where they disagree, using the project's thresholds from Settings → *Data
quality*. A **Data checks** panel lists negative values, outliers and flat
stretches found in each loaded series (engine `checkSeries`), plus the
catchment-rain checks for missing data recorded as 0 (issue #2): a **Zero rain
run** badge for long zero stretches in the wet season, and a **Low vs CHIRPS**
badge for water years far below the usual catchment / CHIRPS share (engine
`rainVsChirps`, on the first catchment and first CHIRPS series by name, as a
run reads them). These are the same checks a run reports as warnings; rules in
[model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree).
"What the model uses" explains every kind. A **reference gauge (other
catchment)** series (`flow_reference_m3s`, e.g. imported with
`--gauge-as-reference`) is badged *Reference only*: it can be charted here as a
regional wet/dry index, but runs never read it, it is not in the gauge-vs-logger
table and it can't be picked as the calibration record. Each series can be
downloaded as CSV.

## Settings & calibration

The settings are grouped by what they drive:

- **Demand**: A-pan (Oct–Sep), effective rainfall %, and days in February.
- **Flow calibration**: the **runoff model** picker (Legacy or GR4J,
  `settings.runoffModel`), the **CHIRPS bias correction** picker
  (`settings.chirpsBiasCorrection`, `settings/rain.ts`: bias-corrected per
  month, the default, or raw CHIRPS; it applies to both models and to
  demand, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)), the
  catchment area (blank = the sum of the farm areas, which is shown), the
  calibration window and flow series, and the **calibration exclusions**
  (`calibration/CalibrationExclusions.svelte`): "Exclude a water year" and
  "Exclude a date range" add a row, each with a required **Reason**. A water
  year shows the dates it covers ("WY 2015/16: 2015-10-01 – 2016-09-30"). A
  blank reason, a reversed range or a period listed twice shows an alert and
  blocks Save. Excluded days are left out of Fit automatically and the run's
  calibration statistics (model.md §2.10). A run that corrected CHIRPS lists
  the monthly factors and the number of days in its warnings. The rest
  depends on the model:
  - **Legacy**: a, b, rain threshold, summer and winter factors, and summer
    months as toggles. **Advanced** holds the winter switch, the recession
    parameters and the 80-value recession tables.
  - **GR4J**: X1, X3 and X4, each with its typical and allowed range
    (`settings/calibration.ts` `GR4J_FIELDS`, bounds from the engine). The
    input refuses values outside those bounds. The GR4J view also has the
    warm-up in days and the rain threshold, which under GR4J only affects
    demand. X2 is behind a "Let the catchment gain or lose groundwater" checkbox;
    unticking it sets X2 back to 0. Then comes the monthly **pan
    coefficient** row. A notice appears when A-pan is 0 in every month.
  - **Fit automatically** (`calibration/FitPanel.svelte`, below the calibration
    window) fits the selected model's parameters in a Web Worker
    (`lib/calibration/`). It takes the objective, **Bounds** (a select: "Wide
    (default)" — each parameter's full calibration range — or "Typical
    (Perrin et al. 80 %)" — a tighter, published range, with a hint under it;
    model.md §2.10b), the model runs per fit
    (default 1 500), the **seed** (default 1; the same seed, data and engine
    version give the same fit, and the seed is recorded), which parameters to
    fit (GR4J X2 only when exchange is on), and whether to validate.
    Validation runs the split-sample and dry → wet tests, which means three
    fits. The fit always leaves out the stored exclusions; the result line
    gives the bounds, the seed and the number of excluded periods.
  - **Also validate against** appears only when the project has both a gauge
    and a logger record. It offers the record the fit doesn't use (the
    calibration flow series above, else the default gauge) and defaults to
    "No other record". Choosing one adds an independent-record column: the
    fitted parameters scored against that record over its own days (model.md
    §2.10b). It costs no extra fit.
  - While it runs there is a progress bar (`role="progressbar"`) with the
    stage and the best score so far. **Cancel** stops the worker at once and
    discards it.
  - The result shows the engine's plain-language notes (for example "wet-year
    behaviour is weakly constrained"), current against fitted parameters, and
    a scores table. Its columns are current parameters, fitted, then each
    test's fitted part and validation part, then the independent record if
    one was chosen; the validation columns are shaded. Each column header
    gives its period: a date range, except for the dry → wet test, whose
    years interleave and are listed ("WY 2014/15, 2016/17"). Its rows are KGE′, year-balanced KGE′, non-parametric KGE, the NSE
    variants, volume error and the FDC signatures.
  - **Apply to form** (editors only) writes the fitted parameters into the
    form, with a **fit record** (`settings.fitRecord`, model.md §2.10b), and
    the form then shows "Unsaved settings". Nothing is stored until Save.
    Below the panel, **Fit record of these parameters**
    (`calibration/FitProvenance.svelte`) shows the record: model and time,
    objective, seed, model runs, engine version, the record and window fitted
    to, the exclusions, the fitted values, and a table with the in-sample
    score ("Calibration period (in-sample)") next to each validation score,
    plus the notes. Editing a fitted parameter by hand shows a **Parameters
    edited since fit** badge and names the parameters at once; the server
    records the same on save. A change of runoff model, window, exclusions or
    flow series since the fit is called out too.
    Viewers can fit but not apply. With no observed record the panel says to
    upload one. The fit uses the form as it stands, and the network with
    unsaved edits if there are any.
  - When the WR2012 MAR penalty is on (below) the panel says so, the fit runs
    once more without it (stage "Fitting again without the WR2012 penalty"),
    and the result adds a table (`calibration/MarPenaltyResult.svelte`) with
    the weight: the objective score, simulated natural MAR ÷ the target (the
    scaled WR2012 MAR, or the MAR band when one is set) and the fitted
    parameters, with and without the penalty. With a band, the row instead
    reads "Simulated natural MAR ÷ band (low–high Mm³/a)" and the caption
    below says the penalty is zero inside it.
- **WR2012 check** (`settings/Wr2012Section.svelte`, helpers in
  `settings/wr2012.ts`; model.md §2.10c). Off until "Compare runs with WR2012
  naturalised flow" is ticked. Then: quaternary code, area (km²), MAP (mm,
  optional), naturalised MAR (Mm³/a), the reference period (first and last
  water year), the source, and a 12-month row of mean naturalised flow in
  **Mm³ per month** with its sum and an m³/s equivalent row, so a unit slip
  shows. Then the scaling (area, or area and rainfall; the current area ratio
  is shown), the dry-season months (from each run, or chosen), the four
  deviation thresholds (%), and the calibration penalty (off; weight 0.5).
  Ticking it shows the weight, then **Use a MAR band instead of one target**:
  unticked (default), the penalty pulls towards the scaled WR2012 MAR above;
  ticked, two fields (**Band low** / **Band high**, Mm³/a, already at the
  modelled catchment's scale — not the quaternary's) replace it, for when two
  published natural-MAR estimates for the catchment disagree.
  Blank fields and the engine's plausibility checks (MAR above the rain on
  the quaternary, monthly means more than 5 % off the MAR, a one-sided or
  inverted band) show next to the field and block Save, with a count beside
  the Save button.
- **Flow share between farms**.
- **EWR**: m³/day per month, with l/s, a bar chart, the annual volume, and the
  curtailment reporting window.
- **Simulation period**.
- **Data quality**: the gauge-vs-logger thresholds (lowest and highest ratio
  in %, minimum shared days; defaults 67 %, 150 %, 90 days). Out-of-range
  values block Save with a message. They only change which water years are
  flagged, never the results.

## Runs & results

- A **Result sections** menu under the run's title links to each panel
  (`#res-summary` … `#res-explore`, listed by `runs/sections.ts`). Farm
  detail appears only when the run has farms, and Runoff model only for a
  GR4J run. The page's `scroll-padding-top` keeps
  a jumped-to section, or a focused control, clear of the sticky header.
- The run button is disabled, with links, until the project has a network
  and a rainfall series. While a run is going it shows progress.
  The server keeps at most `RUNS_KEPT_PER_PROJECT` runs (default 20); the
  oldest runs it trims (`removedRunIds`) leave the list at once.
- **Summary** (the "Run summary" region): headline cards give mean natural
  flow and simulated outflow in m³/s and Mm³/a, EWR days not met, irrigation
  supplied, and NSE and PBIAS with Moriasi (2007) ratings
  (`runs/rating.ts`), labelled **calibration period (in-sample)**: they are
  scored on the days the parameters were tuned on. When the parameters came
  from Fit automatically, the fit's validation scores sit beside the in-sample
  one under **Where the parameters came from** (below). Below them is the per-farm table: sortable, in network
  order by default, with farms under 95 % supplied flagged in text.
- Then come, in order: curtailment targets, the hydrograph (observed flow as
  dots under natural and simulated, m³/s or m³/day, log scale, last 3 years or
  the full period), the calibration panel (it opens with the same
  in-sample note, and adds the gauge vs logger table when years disagree),
  then **Where the parameters came from**: the fit record the
  run was made with, from the run's own settings snapshot (same layout as in
  Settings, with the in-sample score beside its validation scores and the
  "Parameters edited since fit" badge when they were edited), or "No fit
  record" when the parameters were set by hand or imported. It also lists the
  calibration exclusions the run's statistics left out, which the calibration
  panel shows as "Excluded" with the observed days removed (or explains that
  every observed day was excluded). The calibration window shown is the run's,
  not today's. Then the **runoff model** panel for GR4J runs (`RunoffPanel`:
  the parameters, a table of where the rain went (rain, evaporation, flow,
  exchange, change in storage, in mm and as a share of rain;
  `runs/runoff.ts`), and the production and routing stores through time),
  the **WR2012 check** when the project has a reference (`Wr2012Panel`,
  `#res-wr2012`, helpers in `runs/wr2012.ts`): the scaling rule and factor,
  the deviation flag in words (not colour alone), the MAR table (overlapping
  years and whole run: simulated, scaled WR2012, ratio), the 12-month table
  (simulated, WR2012 scaled, ratio) with dry-season months marked "dry", the
  dry-season ratio and the monthly pattern correlation,
  the flow-duration curve with Q10–Q95 (`charts/fdc.ts`),
  EWR against outflow, the monthly EWR compliance grid, the **EWR test
  against observed flow** (`ewr/EwrAgreementTable.svelte`, `ewr/agreement.ts`;
  [model.md §2.9b](./model.md)): a one-line verdict on the frequency bias, the
  hit rate, false-alarm ratio and frequency bias, the 2×2 table of observed
  days (model below / at or above the EWR × observed below / at or above, with
  totals), a per-month table (Oct … Sep, every month listed, months without
  observed days shown as dashes) and, collapsed, a per-water-year table. A run
  without a gauge or logger record, or saved before engine 0.5.3, says why
  there is no table. Then farm detail (dam
  storage as % of capacity, supply against demand), and an explorer for any
  stored series, grouped by node.
- Series are fetched one at a time when a chart needs them, and cached
  (`runs/cache.ts`). A run stores about 170 series of about 16 000 values.
  Large arrays live in `$state.raw` and are replaced, never mutated.

## Help and glossary (`/help`)

Every entry in `lib/help/content.ts`, grouped by topic, searchable, with a
stable anchor per term (`/help#<id>`) that the ⓘ help tips link to. On wide
screens (≥ 64rem) the table of contents is a sidebar that stays on screen as
you scroll: it marks the topic and term you're reading (`aria-current`) and
lists that topic's terms. On phones the topics wrap above the text.

## Viewers

Viewers see a "View only" note. Inputs render as plain values instead of
greyed-out fields. There are no move handles, drag targets, Add data button
or Run button.

## Accessibility

- `e2e/tests/a11y.spec.ts` runs axe (`@axe-core/playwright`, tags WCAG 2.0,
  2.1 and 2.2 A/AA) on every page, every workspace tab, the dialogs, the
  save bar, the one-node form, the view-only workspace, run comparison, teams,
  help, the dead-link states of the emailed-link pages and an invitation
  opened while signed in, in light and dark, and every tab again at phone
  width. No rule is disabled: a violation is fixed in the app.
- **Sideways-scrolling boxes** (every `.table-wrap`, and anything marked
  `data-scroll-region`, such as the schematic) become a focusable, named
  group while their content overflows, so Tab reaches them and the arrow keys
  scroll them (WCAG 2.1.1). One watcher does this app-wide
  (`lib/a11y/scrollRegions.ts`, started by the root layout); a box names
  itself with `data-scroll-label`, or takes its table caption or section name.
- Row move buttons are 24 × 24 px (WCAG 2.2 target size, 2.5.8).
- `html { scroll-padding-top }` keeps focused controls and in-page link targets
  clear of the sticky header (WCAG 2.4.11).
