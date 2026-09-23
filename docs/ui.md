# The catchment workspace (UI)

A project opens on `/projects/:id`. The page loads the project, its model,
the input-series list and the runs list behind one loading gate, so no tab
renders empty and then fills in. Tabs follow the modelling workflow:

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
their kind by name) are marked. The chart opens on the last 3 years and has
a log scale for flows. When both a gauge and a logger flow exist, a table
compares them per water year (engine `observedAgreement`) and flags years
where they disagree. "What the model uses" explains every kind. Each series
can be downloaded as CSV.

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

## Runs & results

- The run button is disabled, with links, until the project has a network
  and a rainfall (or Pitman) series. While a run is going it shows progress.
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

## Viewers

Viewers see a "View only" note. Inputs render as plain values instead of
greyed-out fields. There are no move handles, drag targets, Add data button
or Run button.
