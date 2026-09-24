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
details, team and members.

- **Headline facts** each link to the tab where they are edited or looked at
  (farms, area, dams and the outflow gauge to Network, irrigated area to
  Crops, transfers to Transfers, time series to Data, runs to Runs). The
  whole tile is the click target (the label's link is stretched over it), and
  a focused tile gets an outline.
- **Layout**: Project details on the left; on the right, "who has access":
  Team above Members (or "Shared directly with" for a team project), so the
  two panels that refer to each other sit together. Below 900 px it is one
  column in the order details, team, members.
- The **description** box grows with its text (up to about 24rem) instead of
  hiding it behind an inner scrollbar (`field-sizing: content`; browsers
  without it keep four rows).

Email addresses (member rows here and on team pages,
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
- **Table layout**: the whole table, through the **In use** share and the ✕
  column, fits a 1440px screen without sideways scrolling. Field headers wrap
  (e.g. "Upstream inflow to dam" over three lines) instead of setting the
  column width, cells are tighter, and the 0–100 % columns are narrower than
  the area and volume columns. Narrower screens still scroll the table
  sideways with the Name column pinned.
- **One node layout**: the node picker (‹ select ›) is sticky under the app
  header, so the node being edited stays named and ‹ › stay in reach while
  scrolling a long farm form; **+ Add node** sits just below it and scrolls
  away. Controls reached by Tab stop below the picker, not under it. Tapping
  a node on the schematic selects it and, when the form is below the lower
  part of the screen (as on a phone, where the form sits under the drawing),
  scrolls the picker to the top so the form is in view (`scroll.ts`).
- **Irrigation** group (engine ≥ 0.16.0, [engine-audit N1](./engine-audit.md)):
  efficiency and the share of losses returning. The one-node form adds an
  **Irrigation system** select that sets an indicative efficiency (drip 90 %,
  micro-sprinkler 85 %, centre pivot 85 %, sprinkler 75 %, flood 65 %,
  `IRRIGATION_SYSTEMS` in the engine), labelled indicative; "Other" keeps the
  value as typed. New farms start at 80 % and 50 %.
- **Dam** fields also hold the area when full (m², empty = unknown), the area
  exponent (default 0.7) and seepage (% of storage per day) for dam
  evaporation and seepage ([engine-audit N2](./engine-audit.md)). These three
  are in the one-node form and the field guide only, not the table
  (`detailOnly` in `fields.ts`), so the table still fits a 1440px screen.
- **Hints** (not errors, `damHints` in `fields.ts`): the one-node form notes
  under a dam's fields when irrigation may empty it (minimum operating level
  0 %, [engine-audit Q5](./engine-audit.md)), and when its area is unknown, with
  the capacity ÷ 3 m estimate the run will use (N2, warning W6).
- **Order**: rows reorder by drag handle or ↑/↓ buttons (focus stays on the
  moved row, and the new position is announced). **Sort by flow path** lists
  each tributary from its headwater down, with the outflow gauge last. The
  order is `node.sortOrder`, which is display only: runs always use the
  topological order. Every list of nodes uses it (`lib/model/order.ts`).

## Transfers

Each rule has a **Priority** column (whole number, lower moves first; equal
priorities share a source dam pro rata to their limits, [engine-audit
Q18](./engine-audit.md)). A new rule starts after the existing ones (the
highest priority + 1). The help explains the destination's room cap (N4).

## Crops & demand

Crop factors run October to September and are reorderable. Planted areas
are entered in **ha** (stored as m²), with farm rows in network order and
reorderable. A **demand preview** uses the engine's
`grossFarmDemandM3PerDay`: m³/day per month, the mean, and Mm³/a per farm and
for the catchment. It is gross demand, before the daily effective-rain
reduction (and the soil-water store that carries rain over, engine ≥ 0.14.0).
The crop-factor intro says the factors are **× A-pan, not FAO Kc** (FAO-56 Kc
multiplies ET₀, about 0.7–0.85 × pan), and a warning under the table names
every crop and month with a factor above 1.0: a hint to check for an FAO Kc
entered as it is, never a block on saving (`highCropFactors` in
`components/crops/demand.ts`).

On a phone (≤ 640 px) the crop-factor and planted-area tables turn each row
into a card with visible labels: the crop name (with reorder and remove) on
top, the twelve factors four to a row and the mean below; each farm's crops two
to a row with its total, and a totals card last. Every field is on screen
without scrolling the table sideways. The read-only demand preview stays a
table that scrolls. With no farm or crop yet, the Planted areas note links to
the Network tab.

## Transfers

One row per transfer rule: source and destination node, the months it runs
(twelve toggles, water-year order, with **All**/**None**), a maximum rate
(m³/s), an optional daily cap (m³), the minimum source-dam storage (%) below
which it stops, and an enabled switch. The empty state says what a transfer
is (most catchments have none); with fewer than two nodes it links to the
Network tab. On a phone (≤ 640 px) each rule becomes a card: "Transfer N" with
its remove button on top, From and To side by side, the month toggles six to a
row at tap size, then the numbers and an **Enabled** switch whose label is
part of the tap target. The table's column headers and their ⓘ tips move into
each card's field labels.

## Data

Each series shows its role in the model, its period, its last date and age,
% missing, a typical value (mean annual rainfall in mm/a, or mean flow), and
a strip showing coverage per year. Series a run won't read (not the first of
their kind by name) are marked. Clicking a row (or its View button) shows
that series in the chart below. Below 640px wide each row becomes a card
(series and role on top, then labelled Period / Data up to / Missing /
Typical, the coverage strip, and the buttons wrapping underneath), so a phone
never has to scroll the table sideways; explicit table roles keep it a table
to screen readers, and the card labels are silent to them. For editors the
**Upload CSV** form follows the series panels in reading order, so on a phone
it sits right below them rather than after the whole *What the model uses*
reference (wide screens still show it on the right); the empty state points at
it. Uploads read year-last dates (DD/MM/YYYY or
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
Charting that catchment rain series tints the days a run will treat as
missing (flagged zero runs and listed periods, per Settings → *Zero-rain
runs*; `series/zeroRain.ts` over the engine's `zeroRainMask`), with a caption
naming the periods and days ([model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing)).
`LineChart`'s `shade` prop draws the bands.
"What the model uses" explains every kind. A **reference gauge (other
catchment)** series (`flow_reference_m3s`, e.g. imported with
`--gauge-as-reference`) is badged *Reference only*: it can be charted here as a
regional wet/dry index, but runs never read it, it is not in the gauge-vs-logger
table and it can't be picked as the calibration record. Each series can be
downloaded as CSV.

**Preview** (`series/SeriesPreviewDialog.svelte`, in a modal `Dialog.svelte`)
opens a wide, searchable table of every loaded series' daily values side by
side, one row per day across the union of their periods, plus columns for how
the model actually used that day's data — not only what checkSeries flags.
The card header's **Preview data** button opens it with every column shown; a
row's own **Preview** button opens the same dialog with that series' column
un-hidden, scrolled into view and highlighted. Alongside each series' own
column (same label, unit and order as the table above, with its
`checkSeries`/`seriesRowFlags` quality flags on the value) is a **column
picker** grouped into *Series* and *How the model used it*: a m³/day column
for every flow series; **Rain used** and its source (catchment / CHIRPS /
forecast / none) after gap-fill; the **CHIRPS bias factor** for that calendar
month and the **corrected CHIRPS** value (respecting Settings → *CHIRPS bias
correction*); and **Excluded from calibration**, with its reason, for any day
inside a Settings → *Calibration exclusions* period. The derived columns are
computed with the engine's own `prepareRun`/`rain.ts`/`calibrate/provenance.ts`
(the same functions a run uses), not recomputed separately, so they are blank
for any day outside the model's own run window. The search box takes a date
prefix (`2015`, `2015-03-14`) or a value comparison (`> 20`, `= 0`); *Missing
only* and *Flagged only* look only at the currently visible series columns.
Rows are virtualised (fixed row height, only the rows near the scrollport are
real `<tr>`s) so a multi-year daily record doesn't put thousands of rows in
the DOM at once. This is a read-only view of what's already loaded; a CSV
export of the same model-used columns is tracked separately
([followups.md](./followups.md)).

The download menus (`export/DownloadMenu.svelte`) open fixed to the window,
below their button or above it when there's no room
(`lib/export/menuPosition.ts`), so a table's scroll box never clips them;
scrolling or resizing closes an open menu.

The run downloads (in the results' Download menu) are where the numbers can be
checked outside the app. A farm's **daily CSV** has every column in the
workbook's FarmTemplate order, the letter in each header
(`Irrigation supplied [G] (m³/day)`), the working columns between them and the
balance check `[V]` next to outflow. The **summary CSV** adds the self-checks,
the water balance per water year and a column guide giving each letter's
formula ([api.md § Export](./api.md)).

## Settings & calibration

- **On this page.** Under the intro, a **Settings sections** menu links to
  each group (`#set-demand`, `#set-flow`, `#set-fit`, `#set-wr2012`,
  `#set-share`, `#set-ewr`, `#set-period`, `#set-quality`; listed by
  `settings/sections.ts`). It sticks under the app header down the long form
  and marks the group being read with `aria-current="location"`, using the
  Runs rail's scroll spy (`activeSectionId` from `runs/sections.ts`). It is a
  bar rather than a side rail because the monthly input rows need the full
  width. On phones it is one strip that scrolls sideways inside itself (the
  marked link kept in view), never the page. While the tab is shown it raises
  the page's `scroll-padding-top` by the menu's height and sets
  `scroll-padding-bottom` to the save bar's, so a jumped-to group or a
  focused control is never hidden under either (WCAG 2.4.11).
- **Save bar.** Sticky at the bottom (above the model save bar when that
  shows). When something blocks Save it says how many groups have a problem
  and links to each one (`saveBlockers`; the link's accessible name carries
  the message), and that group's menu link gets a red dot ("has a problem").
  Each problem is also shown next to its field.

The settings are grouped by what they drive:

- **Demand**: A-pan (Oct–Sep), effective rainfall %, the **soil-water store**
  (mm, `settings.effectiveRainStoreMm`, default 25; 0 carries no rain over, as
  the workbook does; [model.md §2.3](./model.md#23-irrigation-demand) step 4),
  the **dam evaporation factor** (× A-pan, `settings.lakeEvapFactor`, default
  0.75, 0 off; the hint warns that WR90 lake factors are S-pan based;
  [model.md §2.7a](./model.md#27a-dam-evaporation-rain-on-the-dam-and-seepage-engine--0150-audit-n2)),
  and days in February.
- **Flow calibration**: the **runoff model** picker (GR4J, the default, or
  "Legacy (b023 workbook, comparison only)", `settings.runoffModel`). Legacy
  doesn't conserve water at the event scale (audit H1), so it's kept for
  workbook comparison only, never evidence: a legacy run carries an amber
  "Workbook comparison" badge on the Runs list and the run header, a matching
  label on its CSV exports and on legacy fit records in FitProvenance, and
  run comparison notes it when either side is legacy. Then the **CHIRPS bias correction** picker
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
  the monthly factors and the number of days in its warnings. Below that,
  **Zero-rain runs in the catchment rain** (`settings/ZeroRainSection.svelte`,
  `settings.zeroRainRuns`, [model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing)):
  a **Flagged zero runs** picker ("Treat as missing", the default, or "Run as
  recorded (dry)"), then **Keep dry** (only in the default mode) and **Also
  treat as missing** period lists. These share the calibration exclusions'
  editor (`common/PeriodList.svelte`), with the same required reason and the
  same checks that block Save. The rest
  depends on the model:
  - **Legacy**: a, b, rain threshold, summer and winter factors, and summer
    months as toggles. **Advanced** holds the winter switch, the recession
    parameters and the 80-value recession tables.
  - **GR4J**: X1, X3 and X4, each with its typical and allowed range
    (`settings/calibration.ts` `GR4J_FIELDS`, bounds from the engine). The
    input refuses values outside those bounds. The GR4J view also has the
    warm-up in days and the rain threshold, which under GR4J only affects
    demand. X2 is behind a "Let the catchment gain or lose groundwater" checkbox;
    unticking it sets X2 back to 0. Above the monthly **pan coefficient**
    row, a **preset** picker (Generic, Winter rainfall (e.g. Western Cape),
    Summer rainfall — indicative, from FAO-56 Table 5 climate classes, Allen
    et al. 1998; model.md §2.4a) fills the row with a starting point; the row
    stays editable after, and nothing is stored about which preset (or
    whether one) was picked. A warning appears under the row when a month
    sits outside FAO-56's usual 0.6–0.85 range for a Class A pan — a
    plausibility check, not a hard limit, so a value further out still saves.
    A separate notice appears when A-pan × pan coefficient is 0 in every
    month: the engine then refuses GR4J runs and fits.
  - **Fit automatically** (`calibration/FitPanel.svelte`, below the calibration
    window) fits the selected model's parameters in a Web Worker
    (`lib/calibration/`). It takes the objective, **Bounds** (a select: "Wide
    (default)" — each parameter's full calibration range — or "Typical
    (Perrin et al. 80 %)" — a tighter, published range, with a hint under it;
    model.md §2.10b), the model runs per fit
    (default 1 500), the **seed** (default 1; the same seed, data and engine
    version give the same fit, and the seed is recorded), the **starts**
    (default 5, 1–10: separate searches of the whole record from their own
    seeds, the best kept; model.md §2.10b), which parameters to fit (GR4J X2
    only when exchange is on), and whether to validate. Validation runs the
    split-sample and dry → wet tests: two more fits. The run count is budget ×
    (starts + 2 with validation + 1 with the WR2012 penalty), and the progress
    line names the start. The fit always leaves out the stored exclusions; the
    result line gives the bounds, the seed, the starts and the number of
    excluded periods. With more than one start a **Starts** table lists each
    start's seed, score and fitted parameters, the kept one marked, and a
    note says when near-equal scores come with scattered parameters.
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
    to, the pan coefficient and A-pan evaporation it ran under (month by
    month, or "not recorded" for a fit made before this was tracked) and the
    CHIRPS bias correction mode and zero-rain run handling it ran under (each
    "not recorded" for a `forcing` made before that field was added to it),
    the exclusions, the fitted
    values, and a table with the in-sample score ("Calibration period
    (in-sample)") next to each validation score, plus the notes. Editing a
    fitted parameter by hand shows a **Parameters edited since fit** badge and
    names the parameters at once; the server records the same on save. A
    change of runoff model, window, exclusions or flow series since the fit
    is called out too, and a change to the pan coefficient, A-pan, CHIRPS
    bias correction or zero-rain runs since the fit shows a **Forcing changed since fit** badge
    and a caveat explaining why (evaporation trades off against X1/X3, and
    CHIRPS bias correction changes the rain GR4J sees on fallback days, so the
    fit needs redoing).
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
  inverted band) show next to the field and block Save; the save bar links
  to the WR2012 group.
- **Flow share between farms**.
- **EWR**: m³/day per month, with l/s, then (under the row, so the twelve
  months get the full width) a bar chart and the annual volume, and the
  curtailment reporting window.
- **Simulation period**.
- **Data quality**: the gauge-vs-logger thresholds (lowest and highest ratio
  in %, minimum shared days; defaults 67 %, 150 %, 90 days). Out-of-range
  values block Save with a message. They only change which water years are
  flagged, never the results.

## Runs & results

- **The rail.** On wide screens (over 900px) a left rail holds the runs
  list and, below it, an **On this page** menu (the "Result sections"
  navigation) linking to each panel (`#res-summary` … `#res-explore`, listed
  by `runs/sections.ts`). The rail is sticky, so the menu stays in view down
  the long results page, and it marks the section being read with
  `aria-current="location"` (scroll spy: `activeSectionId`, the last section
  whose top has passed under the sticky header, or the last one at the
  bottom of the page). A long runs list scrolls inside its panel so the menu
  stays in reach: its height is capped at `min(16rem, 25vh)`, so with 20
  runs the rail still fits a 768px-tall window without clipping (below about
  720px the rail scrolls on its own). Narrower, the rail stacks above the results and the menu
  becomes wrapping chips. Farm detail appears only when the run has farms,
  and Runoff model only for a GR4J run. The page's `scroll-padding-top`
  keeps a jumped-to section, or a focused control, clear of the sticky
  header.
- The run button is disabled, with links, until the project has a network
  and a rainfall series. While a run is going it shows progress.
  The server keeps at most `RUNS_KEPT_PER_PROJECT` runs (default 20); the
  oldest runs it trims (`removedRunIds`) leave the list at once.
- **Summary** (the "Run summary" region): headline cards give mean natural
  flow and simulated outflow in m³/s and Mm³/a, EWR days not met, irrigation
  supplied, and NSE and PBIAS (no rating words: model.md §2.10; PBIAS read
  in plain words by `runs/rating.ts`), labelled **calibration period (in-sample)**: they are
  scored on the days the parameters were tuned on. When the parameters came
  from Fit automatically, the fit's validation scores sit beside the in-sample
  one under **Where the parameters came from** (below). Below them is the per-farm table: sortable, in network
  order by default, with farms under 95 % supplied flagged in text.
- **Where the water went** (`#res-water`, `runs/WaterStoryPanel.svelte`, figures
  from `runs/waterStory.ts`): the run's whole-period water balance
  (`summary.waterBalance.total`, engine ≥ 0.11.0) as yearly averages on the help
  illustration's eight stops: rain on the catchment, evaporation (GR4J runs;
  legacy says why not), natural flow with the share of rain, farm dams (spill,
  and storage at the start and end), irrigation supplied against demand with
  return flow, transfers (they net to nothing), the share of days below the EWR,
  and outflow with the share of natural flow that reached the outlet. The panel
  says the picture is a generic catchment, not a drawing of the project's
  network. A run saved before the water balance existed says to run again.
- <a id="self-checks"></a>**Self-checks** (`#res-checks`,
  `runs/SelfChecksPanel.svelte`, helpers in `runs/checks.ts`; engine ≥ 0.12.0,
  [model.md § Verification](./model.md#verification)) comes next. It has three
  parts. First, one line saying all checks passed, or how many failed (a failure
  is a model bug, so it asks to be reported). Then each check with ✓/✗ in text,
  the first problem (farm name and date) under a failed one, and the largest
  daily balance check (column V). Second, the **water balance by water year**: rain,
  runoff coefficient, start storage, farm runoff, transfers, rain on dams,
  consumptive use, dam evaporation (both engine ≥ 0.16.0, blank before),
  outflow and end storage in Mm³, and the residual in m³, with a red residual
  if it isn't float noise; a GR4J run adds the runoff model's residual in mm.
  The last row is the whole run. Third, **Trace a day**: pick a farm (or gauge)
  and a date (it opens on the farm-day with the largest residual) and it
  fetches `GET …/runs/:runId/day` and lists every column in FarmTemplate order,
  with its letter, value and formula, starting from the day before's storage
  (and, engine ≥ 0.14.0, the day before's soil-water store, from which the
  day's effective rain used and the store can be redone), then works the day's balance out from the numbers shown: in (H + I + J +
  rain on dam) − used (G − T) − evaporated − stored (Q − Q[t−1]) − out (U). Parameters and names come from
  the run's input snapshot, not today's model. A run saved before 0.12.0 says
  it has no checks, balance or working columns, and to run it again.
  Not yet: a trace of the runoff model's day, an Excel audit workbook, and
  model columns in the Data tab downloads ([followups.md § Verification](./followups.md#verification)).
- Then come, in order: **curtailment targets** (`curtailment/CurtailmentTable.svelte`,
  view model `curtailment/curtailment.ts`; [model.md §2.11](./model.md)): per farm
  demand, supply, the fair-share target and reduce / gain, then the EWR
  columns. From engine 0.17.0 (audit Q17, [model.md §2.7b](./model.md)) the EWR
  column is the farm's **EWR charge**, followed by *Irrigate less*, *Store less /
  pass inflow*, the *Supply cut* (m³/day and l/s) and the *EWR site* setting
  the charge, with a note on the rule; older runs show the single "EWR
  shortfall" column (AB). *Total change* and *volume left* count only the
  supply cut (Q13): a farm with no demand shows no cut, and a farm with only a
  storage charge gets a "store less / pass inflow X m³/day" badge; a farm
  whose EWR cut exceeds its equitable share gets a warning badge. *Demand left*
  is a whole % in 0–100: "no demand", "—" with a tooltip below 1 m³/day of
  demand, "<1%" / ">99%" at the ends. Below it, the **EWR sites** table (outlet first, then
  gauges): farms upstream, days not met, and the mean shortfall, the part
  charged to farms and the natural part over the reporting window; with the
  outlet as the only site it says *EWR assessed at 1 site (outlet). Add gauges
  at the Reserve determination's EWR sites to protect upstream reaches.* Then
  the hydrograph (observed flow as
  dots under natural and simulated, m³/s or m³/day, log scale, last 3 years or
  the full period), the calibration panel (it opens with the same
  in-sample note, and adds the gauge vs logger table when years disagree),
  then **Where the parameters came from**: the fit record the
  run was made with, from the run's own settings snapshot (same layout as in
  Settings, with the in-sample score beside its validation scores, the
  "Parameters edited since fit" badge when they were edited, and a
  "Forcing changed since fit" badge when this run's pan coefficient, A-pan,
  CHIRPS bias correction or zero-rain runs differ from what the fit was made under), or "No fit
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
  EWR against outflow, the monthly EWR compliance grid (per farm, from engine
  0.17.0, the days it was charged and the volume charged, "(EWR charge)" in the
  site picker), the **EWR test
  against observed flow** (`ewr/EwrAgreementTable.svelte`, `ewr/agreement.ts`;
  [model.md §2.9b](./model.md)): a one-line verdict on the frequency bias, the
  hit rate, false-alarm ratio and frequency bias, the 2×2 table of observed
  days (model below / at or above the EWR × observed below / at or above, with
  totals), a per-month table (Oct … Sep, every month listed, months without
  observed days shown as dashes) and, collapsed, a per-water-year table. A run
  without a gauge or logger record, or saved before engine 0.5.3, says why
  there is no table. Then farm detail (dam
  storage as % of capacity, supply against demand), and an explorer for any
  stored series, grouped by node. The catchment's series include the final
  catchment rainfall, CHIRPS as uploaded and bias-corrected CHIRPS
  (`rain_final`, `rain_chirps`, `rain_chirps_corrected`, engine ≥ 0.10.1)
  and the day's CHIRPS factor (`chirps_factor`), which the catchment daily CSV
  puts in adjacent columns after rain used. The summary CSV lists the 12
  monthly factors.
- Series are fetched one at a time when a chart needs them, and cached
  (`runs/cache.ts`). A run stores about 170 series of about 16 000 values
  (more since engine 0.12.0: each farm adds 11 working columns).
  Large arrays live in `$state.raw` and are replaced, never mutated.

## Help (`/help`)

Every help page shares one shell (`routes/help/+layout.svelte`): a sidebar
(`help/HelpNav.svelte`) with the search box, the overview, every guide by group
(*Start here*, *How it works*, *How to*) and the glossary, which marks the page
you're on (`aria-current`). On wide screens (≥ 64rem) it stays beside the text
as you scroll; on phones it folds behind a **Help contents** button above the
page, and closes again when you pick a page.

- **Pictures.** One Blender scene of an invented catchment, rendered as several
  shots (`lib/help/pictures.ts`): the whole catchment, one farm and its dam, the
  outlet weir, the soil layers on the block's cut face, the transfer pipeline
  and a reach of river. `pnpm gen:help-art` (`bin/gen-help-art.sh`, scene in
  `scripts/help-art/catchment.py`) renders every shot at its full and half
  width to `static/help/<shot>-<w>.webp`, and projects each labelled feature
  through that shot's camera into `lib/help/pictures.json`, so a marker always
  sits on its feature. The output is committed; re-run it (needs Blender 5,
  ImageMagick 7 and python3) only after changing the scene, or pass
  `HELP_ART_ONLY=farm,soil` to re-render some shots.
- **Picture tours** (`help/PictureTour.svelte`): a shot with numbered markers
  and, under it, the numbered list of stops, which is the full text. The
  markers are a pointer shortcut (out of the tab order and hidden from screen
  readers, since the list says the same); clicking one lights its stop, and
  hovering or focusing a stop lights its marker. A stop with more to say has
  **Show more** (`aria-expanded`), which opens it in place across the full
  width: key points beside a close-up shot, or a diagram.
- **Overview** (`/help`): the catchment tour (eight stops from rain to the
  outlet, `lib/help/tour.ts`, every stop opens), the setup path (one step per
  workspace tab, `SETUP_STEPS` in `lib/help/guides.ts`) and the model guides.
  An old `/help#<term>` link goes on to `/help/glossary#<term>`.
- **Guides** (`/help/guides/<id>`, content in `lib/help/guides.ts`): one task
  or one idea each, with an "On this page" list, numbered steps, tip and
  caution notes, formulas, diagrams, picture tours (a farm's day, GR4J's
  stores under the ground, the outlet gauge, the transfer, the EWR reach), the
  glossary terms it uses, related guides and previous / next. Guide text is
  plain strings with a small markup (`**UI label**`, `[[glossary-id]]`,
  `[[guide:id|label]]`) rendered by `help/RichText.svelte` via `inline()`, so
  nothing is rendered as HTML; a term link reads in lower case mid-sentence
  unless it is an acronym or name (`inSentence`), and `guides.test.ts` fails
  on a reference that doesn't resolve or a picture stop its shot doesn't have.
- **Diagrams** are inline SVG components in `lib/components/help/diagrams/`,
  wrapped by `help/Diagram.svelte`, which holds the only styles they use (the
  app's colour tokens, so they follow the light and dark themes). Each SVG is
  `role="img"` with a full text description, plus a visible caption. On a
  phone the drawing keeps a readable size and scrolls sideways (a
  `data-scroll-region`). A diagram carries no colours or `<style>` of its own,
  and marker ids are unique across diagrams (both guarded by
  `guides.test.ts`).
- **Help tips** (ⓘ) for terms that map to a part of the scene (a farm's dam and
  crops, the outlet, the soil, the pipeline, the river; `TIP_PICTURES` in
  `lib/help/pictures.ts`) show that close-up above the text. It is decorative
  (`alt=""`), since the bubble is a live region and its text says what the
  picture shows, and it has a fixed size so the bubble is placed correctly
  before it loads.
- **Glossary** (`/help/glossary`): every entry in `lib/help/content.ts`,
  grouped by topic, with a stable anchor per term (`/help/glossary#<id>`) that
  the ⓘ help tips link to. Its scroll spy (`lib/help/nav.svelte.ts`) tells the
  sidebar which topic and term are on screen; the sidebar lists the current
  topic's terms.
- **Search** (`/help/search?q=`): results update as you type in the sidebar's
  box, which keeps focus; guides first, then glossary terms.

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
