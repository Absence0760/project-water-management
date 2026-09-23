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
  since the last run: a rainfall or Pitman series that reaches past the
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
that series in the chart below. The chart opens on the last 3 years and has
a log scale for flows. When both a gauge and a logger flow exist, a table
compares them per water year (engine `observedAgreement`) and flags years
where they disagree, using the project's thresholds from Settings → *Data
quality*. A **Data checks** panel lists negative values, outliers and flat
stretches found in each loaded series (engine `checkSeries`; the same checks a
run reports as warnings, rules in [model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)).
"What the model uses" explains every kind. Each series can be downloaded as
CSV.

## Settings & calibration

The settings are grouped by what they drive:

- **Demand**: A-pan (Oct–Sep), effective rainfall %, and days in February.
- **Flow calibration**: a, b, rain threshold, summer and winter factors,
  summer months as toggles, catchment area (blank = the sum of the farm
  areas, which is shown), and the calibration window and flow series.
  **Advanced** holds the winter switch, the recession parameters and the
  80-value recession tables.
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
  (`#res-summary` … `#res-explore`, listed by `runs/sections.ts`; Farm
  detail only when the run has farms). The page's `scroll-padding-top` keeps
  a jumped-to section, or a focused control, clear of the sticky header.
- The run button is disabled, with links, until the project has a network
  and a rainfall (or Pitman) series. While a run is going it shows progress.
  The server keeps at most `RUNS_KEPT_PER_PROJECT` runs (default 20); the
  oldest runs it trims (`removedRunIds`) leave the list at once.
- **Summary** (the "Run summary" region): headline cards give mean natural
  flow and simulated outflow in m³/s and Mm³/a, EWR days not met, irrigation
  supplied, and NSE and PBIAS with Moriasi (2007) ratings
  (`runs/rating.ts`). Below them is the per-farm table: sortable, in network
  order by default, with farms under 95 % supplied flagged in text.
- Then come, in order: curtailment targets, the hydrograph (observed flow as
  dots under natural and simulated, m³/s or m³/day, log scale, last 3 years or
  the full period), the calibration panel (plus the gauge vs logger table when
  years disagree), the flow-duration curve with Q10–Q95 (`charts/fdc.ts`),
  EWR against outflow, the monthly EWR compliance grid, farm detail (dam
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
