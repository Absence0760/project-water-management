# The catchment workspace (UI)

## App header and account menu

Every signed-in page (`lib/components/layout/AppHeader.svelte`) shows a sticky
header with the brand, the Projects / Teams / Help nav, and an account control
on the right: an avatar, display name and email that open a menu (same
disclosure pattern as the Data/Runs tabs' download menu — a button plus a
hidden list, not an ARIA `menu`/`menuitem` widget) with two actions:

- **Sign out** — ends this device's session only, same as before.
- **Sign out everywhere** — asks for confirmation, then calls
  `POST /auth/logout-everywhere` ([api.md § Auth](./api.md#auth)), which
  revokes every session on the account (this device included) by moving its
  revocation watermark forward. Both actions clear the local session and
  return to `/login`.

The menu is keyboard-operable: Escape closes it and returns focus to the
account button, as does a click outside; a tab or click that leaves the
header closes it too.

A project opens on `/projects/:id`. The page loads the project, its model,
the input-series list and the runs list behind one loading gate, so no tab
renders empty and then fills in. The Overview, Data and Runs tabs take those
lists as props and report changes back, so an upload or a run made on one tab
shows in the others (the Overview's counts and checklist included) without a
refetch. Only the Overview ships with the page; every other tab's code is
fetched the first time that tab opens (started alongside the data load when
the URL names the tab, and warmed when its link is hovered or focused), with
the standard "Loading…" state in the meantime
([architecture.md § Code splitting](./architecture.md#code-splitting-frontend)).
Tabs follow the modelling workflow:

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
account menu, the "Rain up to" dropdown, the download menu and the dialogs.
Help tips, the account menu and the "Rain up to" dropdown also close on a
click outside. The one exception guards
unsaved input: while **Add data** holds a file that is read but not uploaded
(or is uploading), Escape and ✕ ask before discarding it. Help-tip bubbles
render in the browser's top layer (a manual popover placed against the
button), so a scrolling table or a sticky header can't clip or cover them.
Every `Dialog.svelte` dialog also has a **✕** in its top-right corner
(`aria-label="Close dialog"`, tooltip "Close (Esc)") for people who don't know
Escape closes it. It is last in the DOM, so opening a dialog still focuses its
first field (New project, New team).

**Long tables.** A `.table-wrap` table (app.css) scrolls inside its own box,
capped at 70 % of the window, and its whole `<thead>` is sticky, so the header
stays in view while you read down a long table (the network table with many
nodes, the curtailment table). The whole header sticks, not each cell, so a
two-row header (group labels over the column names) stays stacked. A table
shorter than the cap looks as before.

## Header: data freshness and "Add data"

- **Rain up to 14 Jun 2026 · 12 days ago**: the latest end of the
  **recorded rain** (catchment or CHIRPS, `isRecordedRain`), which is what a
  run is driven by. A forecast runs into the future and observed flow only
  scores a run, so neither counts: either would read "up to date" while the
  rain lags. With no recorded rain it reads "No recorded rain yet". Click it
  for every series' end date. It turns amber when the recorded rain is more
  than 7 days old (`STALE_DAYS` in
  `series/freshness.ts`; a candidate for a project setting). Ages count
  calendar days up to the viewer's **local** date (`localIsoDate`); the
  project list's badge (`projects/freshness.ts`) counts the same way from its
  own `daysSince`, so the two never differ by a day around midnight. Series
  dates are calendar days, so the UTC date would be wrong for anyone east or
  west of UTC.
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

The setup checklist (`overview/checklist.ts`), the latest run's results,
a "Needs attention" list, eight headline facts, project details, the import
record (an imported project only), team and members.

- **Latest run** (`overview/LatestRun.svelte`, rules in
  `overview/latestRun.ts`), shown once the project has a run. It is the
  **newest run by `createdAt`**, even when an older run is the nominated
  evidence: the Overview answers "what does the model say now?", and only
  the newest run reflects the latest data and edits. When the evidence run is
  a different run, a line under the context names and links it, so the two
  can't be confused. A context line gives the label, the run period
  (`fmtDay`, e.g. "1 Oct 2021 – 28 Jan 2022"), the engine version and "ran …
  ago" (`describeAge`, by the viewer's calendar), with badges for a legacy run
  (*Workbook comparison*, plus a note that its figures are for workbook
  comparison only, not evidence) and the evidence run. **Open in Runs** links
  to `?tab=runs&run=<id>`. Four cards, the same figures and labels as the Runs
  tab's headline (`RunSummaryView.svelte`): *Reserve rules met* (the rule-table
  site from `headlineSite`) or, without a rule table, *EWR not met* (days below
  the pragmatic EWR); *Irrigation supplied* (% of all farms' demand, with "N of
  M farms below" `SUPPLY_TARGET`); *Calibration NSE* (in-sample; "–" without
  observed flow); *Mean simulated outflow* (m³/s, % of natural). Dam storage
  is only in a run's daily series, not its summary, so it has no card. Each
  card shows its change from the previous run (the one before it by
  `createdAt`) with the compare page's `Delta` (sign, ▲/▼ and a spoken
  better/worse, so colour is never the only cue), only when both runs have the
  figure: the Reserve only at the same site, the pragmatic EWR only when
  neither run headlines a rule table. The full records come through the Runs
  tab's `detailCache`, so only this section shows a loading or error state
  (`LoadState`, with a retry) and the Runs tab then opens the run at once. Four
  cards in a row, 2 × 2 below 760 px.
- **Needs attention** (`overview/NeedsAttention.svelte`, rules in
  `overview/attention.ts`): one sentence and one link per item, hidden when
  there is nothing. Items: farms below `SUPPLY_TARGET` in the latest run (the
  worst named, links to the run), the latest run's warnings, rainfall the
  latest run hasn't used (`newDataSinceRun`, links to Runs to re-run), input
  data older than `STALE_DAYS` (`freshness`, links to Data), and farms with no
  planted area once anything is planted (links to Crops; before that the
  checklist's crops step covers it). Run items wait for the run's summary.

- **Headline facts** each link to the tab where they are edited or looked at
  (farms, area, dams and the outflow gauge to Network, irrigated area to
  Crops, transfers to Transfers, time series to Data, runs to Runs). The
  whole tile is the click target (the label's link is stretched over it), and
  a focused tile gets an outline.
- **Import record** (`overview/ImportReportPanel.svelte`, 017_project_import),
  under Project details, only for a project imported through the import dialog
  (it fetches `GET /projects/:id/import-report`; a `404 no import report`
  shows nothing). "Imported from the b023 workbook *file* on *date time* by
  *name*.", the importer and web build, then the review's two lists, shared
  with it (`import/ImportReportLists.svelte`): **Importer notes** and the
  **Unmapped report** (a workbook's only), each with its count sentence and
  the list behind a *Show the N notes* / *Show the N items* disclosure, closed
  at first. Items the client trimmed past the caps show as "And N more …, not
  kept." Every member sees it, viewers included, so a reviewer or assessor
  can check what the importer interpreted long after the import. All the text
  came from the file and renders as text only.
- **Layout**: Project details (and the import record) on the left; on the
  right, "who has access": Team above Members (or "Shared directly with" for a
  team project), so the two panels that refer to each other sit together, then
  **Farmers**. Below 900 px it is one column in the order details, import
  record, team, members, farmers.
- **Farmers** (WP-2.1, `overview/FarmersPanel.svelte`): each farmer with the
  farms linked to them, by name. Owners add an existing, verified account by
  email with a tick box per farm, change a farmer's farms, and remove one.
  Farmers aren't in the Members list (it hides the `farmer` role), and a
  farmer never sees this tab: their own view is WP-2.6. A link to a farm
  deleted but not yet saved reads "a removed farm".
- On the **Network** tab, a farm with linked farmers says how many in its
  detail panel, and removing it asks first, naming the farmers who lose
  access when the model is saved.
- The **description** box grows with its text (up to about 24rem) instead of
  hiding it behind an inner scrollbar (`field-sizing: content`; browsers
  without it keep four rows).

Email addresses (member rows here and on team pages,
pending invitations, the confirm-email banner) render through
`common/EmailText.svelte`, which lets them wrap before the `@` and after `.`,
`-`, `_` or `+` rather than mid-word on a phone.

## Project list

`/` lists your projects, grouped by owner (personal, each team, shared with
you), with a search box, an owner filter and a sort, all kept in the URL. Its
header has **Import b023 workbook**, **Import project file (.json)** and
**New project**. Both import buttons open the same dialog; the button only
sets its wording and what the file picker offers, and the picked file's type
decides how it's read, so a workbook picked from the JSON button still works.
Two buttons rather than one "Import…": the client looks for a named workbook
import, and the two sources explain themselves differently (a workbook's
review has options and reports a `.json` file doesn't).

### Import a project file

The import dialog (`lib/components/import/ImportProjectDialog.svelte`, WP-1.8)
turns a project document into a new project through `POST /projects/import`:

1. **Pick** a `.json` file: a project's *Download project (JSON)* or the
   workbook importer's `project.json`. It's read in the browser
   (`import/projectFile.ts`); a file that isn't JSON, isn't a project document
   or is over the 5 MB cap is refused here, before anything is sent.
2. **Preview** (`ImportPreview.svelte`): the importer's notes first (for
   example, a file with no time series), then the name (editable, prefilled
   from the file), *Belongs to* (only when you're a member or admin of a team;
   preselected when the list is filtered to one), what's in the file
   (farms, gauges and other water users, crops and planted areas, transfers,
   and a table of the time series with their days and dates) and *Run the
   model after importing*.
3. **Importing:** a status line; the controls are disabled.
4. **Done:** "Imported *name*", plus "Its first run is ready on the Runs tab"
   after a run, or a warning with the reason when the run failed (the project
   is still imported). *Open project* goes to it; the list behind has already
   reloaded.
5. **Failed:** the server's message (zod or model problems are listed) and
   "Nothing was created." When the server couldn't be reached, it says the
   import may or may not have gone through and to check the list first. *Back
   to the preview* keeps the file and choices.

The dialog is the wide variant: full width less the page gutter on a phone.
Its preview and submit steps take an already-parsed document
(`ParsedImport = { file, notes }`), so a second source only has to produce
one; `ImportPreview`'s `extra` snippet takes whatever else that source shows.

### Import a b023 workbook

**Import b023 workbook** (WP-1.31) turns a Water Balance Tool b023 `.xlsm` or
`.xlsx` into a project with no Python. The workbook never leaves the browser:
it's read in a Web Worker (`lib/spreadsheet/import/import.worker.ts`, loaded
only now; [architecture.md § Code splitting](./architecture.md#code-splitting-frontend)),
and only the extracted project is sent to `POST /projects/import`, like a
`.json` file. The view logic is `import/workbookFile.ts`; the review's
workbook part is `WorkbookReview.svelte`.

1. **Pick** the workbook (up to 150 MB).
2. **Reading:** a progress bar and "Reading sheet *Flow data* (7 of 9)…" per
   sheet the importer parses (then "Building the project: …"), and
   **Cancel**, which stops the worker at once and returns to the picker.
   Failures come back here, each with its own headline and the importer's
   message:
   - *not a b023 workbook*: the named ranges it lacks (the first eight, then
     "and N more");
   - *unsupported build* (AppSettings `zAppVer` isn't b02x);
   - *too large* (the file, the sheet count, or the parts it reads unpacking
     past their caps, which a real workbook never does);
   - *couldn't be opened* (not a zip, an old `.xls` or a password-protected
     file, `.xlsb`, a damaged or encrypted archive);
   - *a problem the importer can't get past* (a table header it can't find,
     dates that jump …), with the sheet and cell.
3. **Review:** the preview as for a `.json` file (name prefilled from the file
   name up to `_WBT`, team, "In this workbook" counts and series table, *Run
   the model after importing*), plus:
   - **Gauge column** (only when the workbook has one): *It's a gauge on
     another river: import it as a reference gauge*, and then an optional
     *Scaling starts on* date and *Scale factor* to undo a known scaling. A
     change re-extracts from the workbook the worker still holds (no second
     read) and updates the counts, notes and report in place; a date without
     a factor (or the other way round) or a non-positive factor is flagged
     and blocks Import.
   - **Importer notes**, each marked *Note* or *Warning*, with its sheet and
     cell: the Python importer's `note:` / `WARNING:` lines, same text.
   - **Unmapped report**, its own section and table (*Where*, *Element*,
     *What*, *In the workbook*): what couldn't be carried across as the
     workbook meant, such as a hand-written [Transfers] InOut formula (shown
     verbatim), a draw rule with no destination, a blank Specific share, M1
     month lists, number cells holding text. The importer never changes a
     value on its own; "Nothing: everything in the workbook was mapped" when
     empty.
4. **Importing, Done, Failed:** as for a `.json` file (the server's 400 and
   413 messages included). *Open project* goes to it, and a first run's
   result is on the Runs tab.

The notes and unmapped report go with the import (`importReport`,
`import/importReport.ts`, trimmed to the server's caps) and are kept with the
project: its Overview's **Import record** shows them afterwards
([Overview](#overview)). A `.json` import sends its own record
(`source: 'project-file'`, with the notes the preview showed, if any).

Everything from the file (farm and sheet names, notes, formula text, error
messages) is rendered as text, never `{@html}`
([security.md § Input handling](./security.md#input-handling)). Closing the
dialog, Cancel and a finished import terminate the worker. An import still in
flight when the dialog closes finishes (the list reloads) but never takes over
a reopened dialog.

## Teams

`/teams` lists your teams with your role; `/teams/:id` shows members, pending
invites and the team's projects. Admins pick each member's role from
**viewer / member / admin** (the sole admin's viewer and member options are
disabled), and the page explains each role in a short list under the table:
viewers read every team project, members edit them, admins own them and
manage the team. A team viewer doesn't get "New project in this team"; the
New project dialog and the Overview's *Move to* list offer only teams where
you're a member or admin, and copying a team project you only view makes a
personal copy (the Copy dialog says so).

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
- **Colour farms by** (above the schematic, offered once the project has a
  run and a farm): **Nothing** (the default, the plain drawing) or **Supply,
  latest run**. The choice is component state, not kept in the URL. On, it
  fetches the newest run's summary (`api.runs.get`, sharing the Runs tab's
  `detailCache`; a quiet status line covers loading, and a failure offers
  Retry without touching editing) and fills each farm by `fractionSupplied`
  (`network/supplyColour.ts`): **≥ 95 %** (`SUPPLY_TARGET`, the farm table's
  flag), **70–95 %** and **under 70 %** (`LOW_SUPPLY`, this view's own lower break, so "short" separates from "badly short"), in success / warning / danger
  mixes that step in lightness as well as hue in both themes. A boundary
  value falls in the higher band. A farm with no irrigation demand in the
  run (the engine reports it as 100 %) is "no demand", dashed and unfilled;
  a farm in the model but not in the run (added since, or a gauge then) is
  "not in this run", hatched with a dashed outline. The share is also on the
  node's label line, its tooltip and the drainage-tree text, so nothing is
  colour-only. A second legend row lists the bands present and names the
  run ("… in run “label”, ran 2 days ago", by the viewer's calendar); with
  unsaved model edits it adds that the colours show the run, not the edits.
  Gauges and other water users are not coloured. Selection, hover and drop
  states are unchanged (they live on the halo and opacity).
- **Table** (the default from 900px wide) or **One node** (the default
  below it), switched by the Layout buttons: every field has
  a unit, a help tip and an entry in the field guide. Percentages are stored
  0–1 and shown 0–100. Fields that only apply to farms show "–" on gauge rows.
  The flow share in use (with the Settings method) and its total are shown.
  The one-node form and the view-only table show thousands separators
  (300,000, the app's usual `fmtNum` style) on the non-% fields; a field
  switches to the plain number while it is being edited, and typed or pasted
  separators (`300 000`, `300,000`) are accepted (`NumberInput grouped`). The
  editable table keeps plain numbers.
- **Table layout**: the whole table, through the **In use** share and the ✕
  column, fits a 1440px screen without sideways scrolling (the dam physics
  fields live in the one-node form only, see above). Field headers wrap
  (e.g. "Upstream inflow to dam" over three lines) instead of setting the
  column width, cells are tighter, the short area and 0–100 % columns are
  narrow, and the volume columns (m³, m³/day; `isVolume`) keep room for a
  seven-digit value such as 1500000, so a dam capacity is never clipped.
  Every cell of a column carries its width class, not-used and footer cells
  included. Every field header is the label (hyphens don't break,
  so "High-MAP" stays whole) over one line with the unit and its ⓘ, all
  bottom- and right-aligned, so the icons form one row. Numbers are
  right-aligned in even-width digits with no spin buttons, and each total
  lines up with the digits above it. Narrower screens scroll the table sideways inside its own
  box, with the **Name** column pinned on the left and the **✕** remove
  column pinned on the right, so every row stays named and removable.
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
- **Other water users** (engine ≥ 0.22.0, WP-1.33, [model.md §2.7c](./model.md)):
  **+ Add other user** (next to + Add node, in both layouts) adds a node of
  kind *Other user* draining into the outlet, with no demand yet; any node's
  Kind can also be switched to it. In the table a user's row shows "–" in
  every farm column ("not used for an other water user"), and below the
  network panel an **Other water users** panel lists each user (name, a
  one-line summary: priority, mean demand, share returned, what it drains
  into) with its **Priority** (senior: farms upstream pass its demand first;
  junior: takes what reaches it), **Share returned** (%) and **demand per
  month** (m³/day, Oct–Sep) with *Use October's demand for every month*
  (`UserFields.svelte`, `users.ts`). The one-node form shows the same fields
  under "Other water user" instead of the farm groups. The schematic draws a
  user as an open diamond (legend "Other water user"). The client check
  mirrors the API: no crop areas or transfers on a user, 12 demands ≥ 0, a
  return share in 0–100 %.
- **Groundwater (boreholes)** group (engine ≥ 0.23.0, WP-1.34, [model.md §2.7d](./model.md)),
  one-node form only (`detailOnly`), on farms and other users: borehole
  capacity (m³/day, empty = none), **Borehole rule** (supplemental / primary /
  drought), drought trigger (%), stream depletion (%) and depletion lag
  (days). The client check refuses boreholes on a gauge and the drought rule
  without a farm dam.
- **Land cover** (engine ≥ 0.24.0, WP-1.35, [model.md §2.5a](./model.md)),
  one-node form, farms only (`LandCoverFields.svelte`, `landcover.ts`):
  **+ Add land cover** adds a patch (invasive trees, full cover, no area yet);
  each patch has a **Cover class**, **Area** (km²), **Condensed cover** (%)
  and **Own reductions**, which replaces the class's indicative reductions
  (shown otherwise) with two editable %s. Below the patches: the condensed
  share of the farm, flagged when above 100 % (the run scales it down). The
  field guide points table users to the one-node layout. Removing a farm
  removes its patches (the confirm says how many).
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
reduction (and the soil-water store that carries rain over, engine ≥ 0.14.0).
The crop-factor intro says the factors are **× A-pan, not an FAO Kc** (FAO-56 Kc
multiplies ET₀, about 0.7–0.85 × pan), and a warning under the table names
every crop and month with a factor above 1.0: a hint to check for an FAO Kc
entered as it is, never a block on saving (`highCropFactors` in
`components/crops/demand.ts`).

Under Planted areas, a muted note names every farm whose planted area adds up
to zero ("Farm 5, Farm 6 and Farm 8 have no planted area, so their irrigation
demand counts as zero."), at most five names then "and N more"
(`noPlantedAreaNote`). Like the rest of the tab it follows unsaved edits.

Above the demand table, a compact stacked bar chart shows the catchment's
gross demand per water-year month (Oct → Sep, m³/day), one part per crop
(`MonthlyBars` in stacked mode). The parts come from the same per-farm
computation as the table: `farmDemands` splits each farm's engine demand by
crop, `catchmentDemand` gives the footer totals and `cropStacks` the chart's
parts, which sum to them. Colours are theme tokens (`--series-1…3`,
`--brand-node`, `--warning`, `--accent`), so they follow light and dark mode;
with more than six crops the five largest by annual demand keep a colour and
the rest are grouped as "Other" in grey. The chart is an image whose label
names the crops and the peak month; the table stays the accessible data
source. It is hidden while there is no demand (no A-pan, crops or areas).

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
which it stops, a **Priority** and an enabled switch. Priority is a whole
number, lower moves first; equal priorities share a source dam pro rata to
their limits ([engine-audit Q18](./engine-audit.md)). A new rule starts after
the existing ones (the highest priority + 1). The help explains the
destination's room cap (N4). The empty state says what a transfer
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
that series in the chart below. Editors can **Delete** a series (after a
confirm; runs already stored are not affected). Below 640px wide each row becomes a card
(series and role on top, then labelled Period / Data up to / Missing (% of
days) / Typical (mean), the coverage strip, and the buttons wrapping underneath), so a phone
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
It also tints the multi-day accumulation windows a run will spread by CHIRPS
(engine `rainAccumulations`, judged against the first CHIRPS series by name
and the CHIRPS bias setting, as a run does), and the caption counts them and
their days ([model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations)).
`LineChart`'s `shade` prop draws the bands.
When both catchment rain and CHIRPS are loaded, a **Double mass: catchment
rain vs CHIRPS** panel (`series/DoubleMassPanel.svelte`, data from
`series/doubleMass.ts` over the engine's `doubleMass`, with the project's
zero-rain settings deciding which days are suspect; engine ≥ 0.18.0, CR-20)
says in a sentence whether the ratio breaks, then draws cumulative catchment
rain against cumulative CHIRPS (water-year points, the whole-record line
dashed, the segments between breaks solid, each slope in the caption), a
small chart of the departure from the whole-record line by water year, and a
collapsible table of the water-year totals (the charts' text equivalent).
It needs 10 judged water years; without them the panel is absent. A break
also shows in Data checks with a **Double mass vs CHIRPS** badge
([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)).
"What the model uses" explains every kind. A **reference gauge (other
catchment)** series (`flow_reference_m3s`, e.g. imported with
`--gauge-as-reference`) is badged *Reference only*: it can be charted here as a
regional wet/dry index, but runs never read it, it is not in the gauge-vs-logger
table and it can't be picked as the calibration record. Each series can be
downloaded as CSV.

**Preview** (`series/SeriesPreviewDialog.svelte`, in a modal `Dialog.svelte`)
opens a searchable table of every loaded series' daily values side by
side, in a near full-screen dialog (`Dialog`'s `full` size: up to 1600px wide
and the window's height, with the table filling what's left and only the rows
in view rendered), one row per day across the union of their periods, plus columns for how
the model actually used that day's data — not only what checkSeries flags.
The card header's **Preview all data** button opens it with every column shown; a
row's own **Preview** button opens the same dialog with that series' column
un-hidden, scrolled into view and highlighted. Number columns have right-aligned headers, so each value sits under its own header; the date and the Excluded column stay left-aligned. Alongside each series' own
column (same label, unit and order as the table above, with its
`checkSeries`/`seriesRowFlags` quality flags on the value) is a **column
picker** grouped into *Series* and *How the model used it*: a m³/day column
for every flow series; **Rain used (model)** and its source (catchment / CHIRPS /
forecast / none) after gap-fill; the **CHIRPS bias factor** for that calendar
month and the **CHIRPS (corrected)** value (respecting Settings → *CHIRPS bias
correction*); and **Excluded from calibration**, with its reason, for any day
inside a Settings → *Calibration exclusions* period. Every column header,
Date included, carries an ⓘ `HelpTip` saying where that number comes from, how
it is derived and what it tells you: a raw series column reuses its kind's
`series.<SeriesKind>` entry, and each derived column has its own
`preview.<column>` entry (`preview.date`, `preview.flowM3Day`,
`preview.rainUsed`, `preview.chirpsFactor`, `preview.chirpsCorrected`,
`preview.excluded`), the key set per column in `series/preview.ts`. The bubble
is a top-layer popover, so the sideways scroll and sticky header don't clip
it, and Escape closes the tip without closing the dialog. A header shows its
unit once: the m³/day columns name it in their label, so no second `(m³/day)`
follows. The derived columns are
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
balance check `[V]` next to outflow. **Fragmented flow — all farms** and
**Fragmented EWR — all farms** (only when the run has farms) put one series
of every farm side by side, a date column then a column per farm, like
the workbook's `[Fragmented flow]` (I) and `[Fragmented EWR]` (Y) sheets. Each
of the two has a **Preview** button beside it in the menu, which opens the
table in a near full-screen dialog (`export/DailyTableDialog.svelte`, its own
chunk): the dialog fetches the export and parses it (`lib/export/dailyTable.ts`),
so it shows exactly the file, then **Download CSV** saves that same response.
The header row and the date column stay in view, numbers are right-aligned
under right-aligned headers (to the precision the charts use, `fmtReading`), a
date prefix (2015, 2015-03) narrows the rows, and closing it returns focus to
the Download button. Only the rows in view are rendered, as in the Data tab's
preview. The **summary CSV** adds the self-checks,
the water balance per water year and a column guide giving each letter's
formula ([api.md § Export](./api.md)).

**Workbook (.xlsx)**, first in the run's Download menu, puts the whole run in
one file: the summary, a daily sheet for the catchment and for every node in
network order, curtailment, the EWR grid, Reserve compliance, annual volumes,
the data checks, the inputs and the warnings, every number at full precision
with a display format per column ([api.md § Export](./api.md#export)). It is
built in the browser: picking it closes the menu and shows, under the button,
a progress bar and "Fetching Upper farm (3 of 9)…" per node, then "Building
the workbook…", with **Cancel**, which stops at once and saves nothing. A
failed fetch shows "Workbook failed: …" with the server's reason (a `413`
included) in the menu's status line. The phone layout keeps the same menu and
progress, wrapped under the button. Leaving the tab stops an export still
running. SheetJS loads only then, in a worker, never with the page.

## Settings & calibration

- **On this page.** Under the intro, a **Settings sections** menu links to
  each group (`#set-demand`, `#set-flow`, `#set-rain`, `#set-record`,
  `#set-fit`, `#set-wr2012`, `#set-share`, `#set-ewr`, `#set-reserve`, `#set-period`,
  `#set-quality`, then `#set-feeds` after the form; listed by
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
  shows), with "Unsaved settings", **Discard** and **Save settings** (editors
  only). When something blocks Save it says how many groups have a problem
  and links to each one (`saveBlockers`; the link's accessible name carries
  the message), and that group's menu link gets a red dot ("has a problem").
  Each problem is also shown next to its field.

The settings are grouped by what they drive. Every 12-month row (A-pan, pan
coefficient, EWR, the WR2012 monthly flows) fits a 1280px screen without
sideways scrolling: each month cell is at least 78px, room for a six-digit
value such as 250000.


- **Demand**: A-pan (Oct–Sep), effective rainfall %, the **soil-water store**
  (mm, `settings.effectiveRainStoreMm`, default 25; 0 carries no rain over, as
  the workbook does; [model.md §2.3](./model.md#23-irrigation-demand) step 4),
  the **dam evaporation factor** (× A-pan, `settings.lakeEvapFactor`, default
  0.75, 0 off; the hint warns that WR90 lake factors are S-pan based;
  [model.md §2.7a](./model.md#27a-dam-evaporation-rain-on-the-dam-and-seepage-engine--0150-audit-n2)),
  and days in February.
- **Calibration is four panels**, each its own menu entry, rather than one
  long one: Flow calibration, Rain gaps and CHIRPS, Calibration record and
  Fit automatically, in that order.
- **Flow calibration (rain → natural flow)** (`#set-flow`): the **runoff
  model** picker ("GR4J (Perrin et al. 2003)", the default, or "Legacy (b023
  workbook, comparison only)", `settings.runoffModel`). Legacy doesn't
  conserve water at the event scale (audit H1), so it's kept for workbook
  comparison only, never evidence: a legacy run carries an amber "Workbook
  comparison" badge on the Runs list and the run header, a matching label on
  its CSV exports and on legacy fit records in FitProvenance, and run
  comparison notes it when either side is legacy. Then the catchment area
  (blank = the sum of the farm areas, which is shown). The rest depends on
  the model:
  - **Legacy**: a, b, rain threshold, summer and winter factors, initial base
    flow, and summer months as toggles. **Advanced** ("Advanced: winter
    switch, recession and base flow", collapsed) holds the base-flow reset
    ratio, the winter switch, the recession parameters, the 80-value
    recession tables and any other stored calibration keys.
  - **GR4J**: X1, X3 and X4, each with its typical and allowed range
    (`settings/calibration.ts` `GR4J_FIELDS`, bounds from the engine). The
    input refuses values outside those bounds. The GR4J view also has the
    warm-up in days and the rain threshold, which under GR4J only affects
    demand. X2 is behind a "Let the catchment gain or lose groundwater" checkbox;
    unticking it sets X2 back to 0. Above the monthly **pan coefficient**
    row, a **preset** picker (Generic (flat 0.70), Winter rainfall (e.g.
    Western Cape), Summer rainfall — indicative, from FAO-56 Table 5 climate
    classes, Allen et al. 1998; model.md §2.4a) fills the row with a starting
    point; the row stays editable after, and nothing is stored about which
    preset (or whether one) was picked. A warning appears under the row when
    a month sits outside FAO-56's usual 0.6–0.85 range for a Class A pan — a
    plausibility check, not a hard limit, so a value further out still saves.
    A separate notice appears when A-pan × pan coefficient is 0 in every
    month: the engine then refuses GR4J runs and fits.
- **Rain gaps and CHIRPS** (`#set-rain`): the **CHIRPS bias correction**
  picker (`settings.chirpsBiasCorrection`, `settings/rain.ts`: bias-corrected
  per month, the default, or raw CHIRPS; it applies to both models and to
  demand, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
  A run that corrected CHIRPS lists the monthly factors and the number of
  days in its warnings. Below it, **Zero-rain runs in the catchment rain**
  (`settings/ZeroRainSection.svelte`, `settings.zeroRainRuns`,
  [model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing)): a
  **Flagged zero runs** picker ("Treat as missing (default)" or "Run as
  recorded (dry)"), then **Keep dry** (only in the default mode) and **Also
  treat as missing** period lists. These share the calibration exclusions'
  editor (`common/PeriodList.svelte`), with the same required reason and the
  same checks that block Save. The Keep dry hint says that kept-dry days
  count in the CHIRPS factor fit, filled runs are left out of it, and a run
  warns and leaves the year out when CHIRPS reads a lot of rain over a
  kept-dry run (engine ≥ 0.18.0, model.md §2.4b). Then **Multi-day
  accumulations** (engine ≥ 0.20.0, same component,
  [model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations)): an
  **Accumulated readings** picker ("Spread over the days they cover", the
  default, or "Run as recorded (one day)"), then **Keep as recorded** (only
  when spreading: readings confirmed as one day's rain) and **Also spread**
  (windows listed by hand, ending on the reading day), on the same period
  editor. The help entry *Multi-day rain accumulations* explains the
  detection rule.
- **Calibration record** (`#set-record`): the calibration window and flow
  series (`calibration/CalibrationWindowFields.svelte`), and the
  **calibration exclusions** (`calibration/CalibrationExclusions.svelte`):
  "Exclude a water year" and "Exclude a date range" add a row, each with a
  required **Reason**. A water year shows the dates it covers ("WY 2015/16:
  2015-10-01 – 2016-09-30"). A blank reason, a reversed range or a period
  listed twice shows an alert and blocks Save (the save bar links here).
  Excluded days are left out of Fit automatically and the run's calibration
  statistics (model.md §2.10).
- **Fit automatically** (`#set-fit`, `calibration/FitPanel.svelte`) fits the
  selected model's parameters in a Web Worker (`lib/calibration/`). It takes
  the objective, **Bounds** (a select: "Wide (default)" — each parameter's
  full calibration range — or "Typical (Perrin et al. 80 %)" — a tighter,
  published range, with a hint under it; model.md §2.10b), the model runs per
  fit (default 1 500), the **seed** (default 1; the same seed, data and
  engine version give the same fit, and the seed is recorded), the
  **starts** (default 5, 1–10: separate searches of the whole record from
  their own seeds, the best kept; model.md §2.10b), which parameters to fit
  (GR4J X2 only when exchange is on), and whether to validate. Validation
  runs the split-sample and dry → wet tests: two more fits. The run count is
  budget × (starts + 2 with validation + 1 with the WR2012 penalty), and the
  progress line names the start. The fit always leaves out the stored
  exclusions; the result line gives the bounds, the seed, the starts and the
  number of excluded periods. With more than one start a **Starts** table
  lists each start's seed, score and fitted parameters, the kept one marked,
  and a note says when near-equal scores come with scattered parameters.
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
    years interleave and are listed (for example "WY 2001/02, 2003/04"). Its rows are KGE′, year-balanced KGE′, non-parametric KGE, the NSE
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
- **Reserve rule tables** (`#set-reserve`, `settings/EwrRulesSection.svelte`,
  helpers in `settings/ewrRules.ts`; engine ≥ 0.21.0, [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)).
  Optional; with none, runs report days below the pragmatic EWR only. **Add a
  rule table** starts one at the first EWR site without one (the outlet, then
  each gauge in network order; a farm can't be a site); it is disabled once
  every site has one, with a hint to add a gauge on the Network tab. Each
  table (a group headed "Rule table at …") has the **EWR site**, the
  required **Source**, what **the table covers** (total flow, or low flows
  only), the **Unit** (Mm³ per month, or m³/s, the month's mean), where the
  **natural-flow percentile** comes from (the run's natural flow at the site,
  the default, or the table's natural flows), a **scale** (1 unless the table
  is for a different catchment size) and the **% points** (default 10, 20 …
  90, 99; changing them keeps each value under its point and leaves a new
  point blank). Then the **EWR** grid (Oct … Sep rows × one input per point,
  each labelled "EWR, Oct, 10 %, Mm³"), and the **Natural flow** grid when the
  table is the natural source. **Paste from a spreadsheet** takes the 12 month
  rows copied from a spreadsheet (tabs), a CSV or a PDF (spaces), with or
  without the heading row of % points (a range heading such as 0–10 is read as
  its upper bound, and a note says so) and with or without month names in the
  first column (any order; without them the rows are Oct … Sep); a comma
  between digits in a tab- or semicolon-separated paste is a decimal comma.
  **Fill the EWR values** / **Fill the natural flows** put it in the grid, and
  a status line says what was read (or what is wrong: not 12 rows, a value
  that isn't a number, a heading that doesn't match the rows). Plausibility
  notes ("Check: the EWR rises with the % point in Jan …", an EWR above the
  natural flow) show under the table without blocking Save; a missing source,
  a bad point list or a blank cell, and two tables for one site, block Save
  and the save bar links here. **Remove the rule table at …** deletes one.
- **Simulation period**.
- **Data quality**: the gauge-vs-logger thresholds (lowest and highest ratio
  in %, shown to one decimal; minimum shared days; defaults 66.7 % (two
  thirds), 150 %, 90 days). Out-of-range
  values block Save with a message. They only change which water years are
  flagged, never the results.

### Data feeds

Below the settings form (it saves on its own, never through the save bar) is
**Data feeds** (`#set-feeds`; `lib/components/feeds/DataFeedsPanel.svelte`,
its own chunk loaded with the tab; WP-2.10,
[architecture.md § Data feeds](./architecture.md#data-feeds)).

- **The list**, one card per feed: a state chip in words (**OK**, **Stale**,
  **Failing**, **Waiting**, **Off**; colour is never the only signal, and the
  card carries `data-state`), the source, the series it writes ("→ Rainfall —
  forecast"), where it reads ("cell -20.12, 25.17" or "station X0H000"), the
  schedule and who it runs as, the server's health sentence ("The last fetch
  failed: the source is unreachable: HTTP 503. Newest data 2026-09-01."), and
  "Last data 21 Sep 2026 · checked 2026-09-24 06:00" (the data day is a
  calendar day, never shifted by the time zone). CHIRPS says how many of the
  days are preliminary.
- **A warning** above the list counts the feeds that are stale or failing
  ("1 feed needs attention: …", `role="alert"`).
- **Run now** (editors) queues a fetch at once and says so; the status
  updates once the background worker has run it (**Refresh status**).
  **Switch off / on** and **Remove** (with a confirm; the series keeps its
  days) are for owners.
- **Attach a feed** (owners): source, **Into series** (the kinds that source
  may write), an optional series name, the schedule, and either **Grid cells**
  (one "latitude, longitude[, weight]" per line, up to 25; the rainfall is
  their weighted mean) or a **DWS station** code (checked as `A2H012`). The
  form explains a bad cell or code before anything is sent, and a second feed
  for the same series is refused.
- When the server reads the synthetic fixtures (`FEED_SOURCE=fixtures`, the
  default in dev and CI), a **Sample data** badge says so, and the cells hint
  names the sample grid's extent.
- Viewers see the list and the health, with no buttons. Tested by
  `e2e/tests/data-feeds.spec.ts` (including axe on the panel with a failing
  feed and the form open).

### Scheduled reports

Below Data feeds, **Scheduled reports** (`#set-report-schedules`;
`lib/components/report/ReportSchedulesPanel.svelte`, its own chunk loaded with
the tab; WP-2.15 Phase B, [§ Report](#report)) emails a PDF of the latest
run's report to chosen members every week or month.

- **The list**, one card per schedule: "Every Monday at 07:00
  (Africa/Johannesburg)" or "On the 1st of every month at 06:00 (UTC)", who it
  goes to and who it sends as, and "Next: …" with, when the last due time sent
  nothing, why ("the project had no runs to report on"); a paused one says
  **Paused.**
- **Add a schedule** (editors and owners): every week (on a weekday) or month
  (on day 1–28), the hour, the time zone (an IANA name, the browser's own by
  default), and **Send to**: checkboxes of the project's members who can read
  the report (farmers are not offered; you are ticked if you are one).
  **Pause / Resume** and **Remove** (with a confirm) on each card.
- Viewers see the list, with no buttons.
- Tested by `e2e/tests/server-report.spec.ts`.

## Runs & results

- **The rail.** On wide screens (over 900px) a left rail holds the runs
  list and, below it, an **On this page** menu (the "Result sections"
  navigation) linking to each panel (`#res-summary` … `#res-explore`, listed
  by `runs/sections.ts` in groups, each a list labelled by the group's name
  under a small heading). The rail is sticky, so the menu stays in view down
  the long results page, and it marks the section being read with
  `aria-current="location"` (scroll spy: `activeSectionId`, the last section
  whose top has passed under the sticky header, or the last one at the
  bottom of the page). A long runs list scrolls inside its panel so the menu
  stays in reach: the rail is a column in which only the list shrinks (at
  most 24rem, at least 7.5rem), so with 20 runs and every menu entry the rail
  still fits a 768px-tall window without clipping, and a longer menu takes
  its height from the list (once the list is at its minimum the rail scrolls
  on its own). Narrower, the rail stacks above the results and the menu
  becomes wrapping chips, a line of them per group. Farm detail appears only
  when the run has farms, Reserve compliance only with a rule table, Runoff
  model only for a GR4J run, WR2012 check only with a reference, and
  Plausibility checks only on a run made by engine 0.25.0 or later. The
  page's `scroll-padding-top`
  keeps a jumped-to section, or a focused control, clear of the sticky
  header.
- **Page order.** The results are grouped by the question they answer
  (`resultGroups` in `runs/sections.ts`; the page repeats each group's name
  as a quiet heading, `RunCharts.svelte`), so the panels that are read
  together sit together:
  1. **Summary**, then **Notes & evidence** (`#res-notes`) and
     **Publication** (`#res-publication`).
  2. **River & Reserve**: Reserve compliance by month (with a rule table),
     EWR vs outflow beside the flow-duration curve (one menu entry, **EWR &
     flow duration**, since they share a row), EWR by month.
  3. **Farms & users**: curtailment (with the other water users and the EWR
     sites tables), farm detail.
  4. **Model quality**: hydrograph, calibration & uncertainty (with where the
     parameters came from), runoff model, WR2012 check, EWR vs observed,
     plausibility checks.
  5. **Dig deeper**: self-checks (with Trace a day), Explore outputs.

  Failed self-checks, plausibility findings and a WR2012 query or "not
  usable" flag are also run warnings (engine), so they show at the top of the
  summary however far down their panel is. The bullets below describe each
  panel; the order above is the page's.
- **Run model** takes an optional **Run label** (e.g. "Baseline"). The
  button is disabled, with links, until the project has a network and a
  rainfall series, and while the farms' flow shares add up to more than 100 %
  (the engine refuses those runs, [model.md §2.5](./model.md); the note gives
  the total and links to Network and Settings). While a run is going it shows progress. A note says when
  inputs changed since the latest run.
- **The runs list** (newest first, the newest marked "latest") selects the
  run shown; editors delete one with its ✕. Rows are compact so several fit
  the narrow rail: the label (two lines at most; the full label is the row's
  tooltip and the results heading), when it ran and the years it covers
  ("2026-09-23 15:06 · 1981–2025", `runs/runList.ts`), then small tags
  (latest, Published, Evidence / Former evidence, Pinned, Workbook comparison). Pin and
  ✕ stack in a narrow column beside it. The full period, days, author and
  engine version are in the results header. From 7 runs up
  (`RUN_FILTER_FROM`) a **Filter runs** box above the list keeps the runs
  whose label contains every word typed (any case), with "N of M runs". Its header links to **Compare
  runs** (`/compare?project=<id>`, [run-comparison.md](./run-comparison.md)).
  Viewing an older run, the header offers "go to latest".
  The server keeps at most `RUNS_KEPT_PER_PROJECT` runs (default 20); the
  oldest runs it trims (`removedRunIds`) leave the list at once.
- **Pinned runs** (015_run_pinned). Each row has a pin toggle for editors
  (`aria-pressed`, labelled "Pin run <label>"): a pinned run is badged
  **Pinned**, is never pushed out by newer runs, and loses its ✕ until it is
  unpinned. A project holds at most 10 pinned runs; pinning an 11th shows the
  server's `409` reason in the tab's error. Viewers see the badge but no
  toggle. The compare page's run pickers add "· pinned" to a pinned run's
  option (read only).
- **Publishing a run** (WP-2.3, 022_publication; `runs/PublicationPanel.svelte`,
  its own lazy chunk, helpers in `runs/publication.ts`; `#res-publication`,
  menu entry **Publication**). Says whether the shown run is the project's
  published baseline ("This run is the published baseline … Published … by
  …"), another run is, or nothing is published yet, and shows the current
  notice: the level with its percentage ("Advisory · 10 %"), the English and
  Afrikaans text, the next update date and who last changed it. Editors get
  **Publish this run** on any other run: a confirm dialog says what changes
  for stakeholders (each farmer sees this run's figures for their own farm
  from 1 October, and the notice; it replaces the current baseline, which
  stays in the history), warns when farm dams have no stop level ("N farm
  dams have no stop level (0 %)…", from the run's model snapshot, design
  §3 Q3), and holds the notice fields (level, cut %, next update date,
  notice in English and Afrikaans) and an optional note for the staff
  ("farmers don't see it"). **Publish** answers "Published. N farm views
  updated." **Edit notice** changes the current notice in place (`PATCH`,
  no re-publishing): "Notice saved." A legacy-model run says why it can't be
  published. In the runs list the current published run carries a
  **Published** tag, and no run a publication holds has a delete button (the
  server refuses with `409`); the run header repeats the badge as a link to
  the section. Viewers see the status and the notice, no actions. The farm
  page farmers read it on is WP-2.6's (`routes/farm/`).
- **Summary** (the "Run summary" region): it opens with one to three plain
  sentences (`runs/runSentence.ts`, built only from the stored summary so they
  always agree with the cards): the river measure the cards lead with (Reserve
  rules met in X % of months at the headline site when there is a rule table,
  else the % of days below the pragmatic EWR at the outflow gauge), then the
  farms (how many got less than 95 % of their demand and the lowest one, or
  "Every farm got at least 95 %"; left out when the run has no farms), then,
  only when the run was scored against observed flow, the in-sample NSE and
  PBIAS with PBIAS in `rating.ts`'s plain words (NSE unrated). Then the headline cards give mean natural
  flow and simulated outflow in m³/s and Mm³/a, EWR days not met (when the
  project has a Reserve rule table, a **Reserve rules met** card comes first:
  the share of months met at the outlet, else the first site, with "X of Y
  months", the longest run not met and a link to the panel; the days card is
  then labelled "Days below the pragmatic EWR", the secondary measure), irrigation
  supplied, and NSE and PBIAS (no rating words: model.md §2.10; PBIAS read
  in plain words by `runs/rating.ts`), labelled **calibration period (in-sample)**: they are
  scored on the days the parameters were tuned on. When the parameters came
  from Fit automatically, the fit's validation scores sit beside the in-sample
  one under **Where the parameters came from** (below). Below them is the per-farm table: sortable, in network
  order by default, with farms under 95 % supplied flagged in text (a "below 95 %"
  badge and a tinted row). The **Supplied % of demand** column has a small bar
  beside the number (`aria-hidden`, width = the fraction clamped to 0–100 %,
  green at or above 95 %, amber below; themed tokens, so it follows dark mode, and
  solid `CanvasText` under forced colours); the number stays the content.
- <a id="self-checks"></a>**Self-checks** (`#res-checks`,
  `runs/SelfChecksPanel.svelte`, helpers in `runs/checks.ts`; engine ≥ 0.12.0,
  [model.md § Verification](./model.md#verification)). It has three
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
  the run's input snapshot, not today's model. The picker's first option,
  **Catchment (rain to natural flow)**, traces the runoff model's day instead
  (`GET …/runs/:runId/day` without a `nodeId`): for GR4J, rain used P, PET E,
  AET, each store (production S, unit-hydrograph water in transit UH, routing
  R) the day before and at the end of the day, the groundwater exchange F
  (shown as 0 when X2 = 0 stored none), natural flow Q in m³/day and as mm
  over the catchment, each with its formula from `GR4J_COLUMNS`; then the
  store balance, stores before + P + F − AET − Q − stores after, with its
  residual in mm. On a run's first day each store's starting value is shown
  as – (only their total after the warm-up is recorded) and the balance uses
  the total. A legacy run lists its [Flow data] columns (`LEGACY_RUNOFF_COLUMNS`)
  and says it keeps no stores, so there is no store balance to close.
  A run saved before 0.12.0 says
  it has no checks, balance or working columns, and to run it again.
  Not yet: an Excel audit workbook, and
  model columns in the Data tab downloads ([followups.md § Verification](./followups.md#verification)).
- **Land cover** (engine ≥ 0.24.0, only with land cover): the mean natural
  flow invasive plants and forestry took, its share of natural flow, the
  low-flow threshold, and per class the condensed area, reduction and mm/yr
  over that area (`RunSummaryView.svelte`).
- **Groundwater** (engine ≥ 0.23.0, only when a farm or user has boreholes):
  a table of each one's mean pumping, its share of what was supplied, and the
  stream depletion it causes (`RunSummaryView.svelte`).
- **Other water users** (engine ≥ 0.22.0, only when the run has any): a table
  under the farms with each user's priority, demand, taken, deficit, % of
  demand supplied (flagged below 95 %), returned and EWR charge, whole-run
  means (`RunSummaryView.svelte`).
- **Curtailment targets** (`curtailment/CurtailmentTable.svelte`,
  view model `curtailment/curtailment.ts`; [model.md §2.11](./model.md)): per farm
  demand, supply, the *equitable share volume* and *above (−) / below (+)
  equitable share* under "Equitable share (fairness benchmark, ex EWR)", then
  the EWR columns. No label or badge says "gain" (audit Q11): a farm below its
  share reads "below its equitable share by X m³/day", and the table ends with
  the fixed footnote "Fairness benchmark only: … Not an allocation or licence
  condition." From engine 0.17.0 (audit Q17, [model.md §2.7b](./model.md)) the EWR
  column is the farm's **EWR charge**, followed by *Irrigate less*, *Store less /
  pass inflow*, the *Supply cut* (m³/day and l/s) and the *EWR site* setting
  the charge, with a note on the rule; older runs show the single "EWR
  shortfall" column (AB). *Total change* and *volume left* count only the
  supply cut (Q13): a farm with no demand shows no cut, and a farm with only a
  storage charge gets a "store less / pass inflow X m³/day" badge; a farm
  whose EWR cut exceeds its equitable share gets a warning badge. *Demand left*
  is a whole % in 0–100: "no demand", "—" with a tooltip below 1 m³/day of
  demand, "<1%" / ">99%" at the ends. When the run has other water users, an
  **Other water users** table follows (engine ≥ 0.22.0, §2.7c): demand, taken,
  returned, EWR charge, the supply cut, and the charge left standing, with
  "junior (curtailed)" or "senior (not curtailed)"; they are not in the
  equitable share or its totals. Below it, the **EWR sites** table (outlet first, then
  gauges): farms upstream, days not met, and the mean shortfall, the part
  charged to farms and the natural part over the reporting window; with the
  outlet as the only site it says *EWR assessed at 1 site (outlet). Add gauges
  at the Reserve determination's EWR sites to protect upstream reaches.* The
  hydrograph (observed flow as a line
  under simulated outflow, broken on every day without a reading and never
  bridged, a lone reading between gaps shown as a dot; natural flow starts
  hidden and its legend entry shows it, and a legend toggle survives the log
  scale and unit switches; a switched-off entry is struck through in the
  muted text colour, not faded, so it keeps AA contrast; m³/s or m³/day, log
  scale, last 3 years or the full period). A plain drag draws a box to zoom
  into, as on every chart; **Shift+drag** moves the view back and forth
  through the record at the same width, and **◀ Earlier / Later ▶** move it
  by half a window (the non-drag route, and the only one on touch). Neither
  goes past the ends of the record, and the window survives the log scale
  and unit switches. The figure carries the visible range as
  `data-view-start` / `data-view-end`. Every daily chart has the same moves
  (`LineChart`'s `pannable` prop is on by default; Earlier / Later appear once
  there is somewhere to move to): EWR vs outflow, farm storage and supply vs
  demand, Explore outputs, the model stores, the Data tab's series chart and
  the run comparison's daily series overlay. The m³/s ↔ m³/day switch sits on every flow chart
  (hydrograph, flow-duration curve, EWR vs outflow, and Explore outputs while a
  flow series is picked), and one click sets all of them; the run comparison's
  overlay has its own while a flow series is picked. The calibration panel (it opens with the same
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
  not today's. The **runoff model** panel for GR4J runs (`RunoffPanel`:
  the parameters, a table of where the rain went (rain, evaporation, flow,
  exchange, change in storage, in mm and as a share of rain;
  `runs/runoff.ts`), and the production and routing stores through time),
  the **WR2012 check** when the project has a reference (`Wr2012Panel`,
  `#res-wr2012`, helpers in `runs/wr2012.ts`): the scaling rule and factor,
  the deviation flag in words (not colour alone), the MAR table (overlapping
  years and whole run: simulated, scaled WR2012, ratio), the 12-month table
  (simulated, WR2012 scaled, ratio) with dry-season months marked "dry", the
  dry-season ratio and the monthly pattern correlation,
  and (placed in the calibration panel, under the fit record) the **Uncertainty bands** on every run (engine ≥ 0.26.0, issue #4 phase 9,
  [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9);
  `uncertainty/UncertaintyPanel.svelte`, its own chunk loaded when a run is
  shown, `#res-uncertainty`, inside the calibration panel below the fit
  record, whose menu entry is **Calibration & uncertainty** so the rail still
  fits a laptop screen; helpers in `uncertainty/bands.ts`). It shows the run's newest stored ensemble: the
  **decision rule** in a box above every band (thresholds, split date,
  percentiles, the 30-set gate, coverage test, sample), a line with the
  options (sets, seed, bounds, pan shift, rain sources, records, model, who
  stored it), **Parameter sets kept** (with the rejections by reason) and
  whether the run's own parameters pass, the **held-out coverage** per record
  (a warning, in words, below 70 %), then the tables: 5 %, median, 95 % and
  this run's own value for EWR days not met, the shortfall, natural and
  outflow MAR and the Reserve compliance rate per site with a rule table; EWR
  days not met by month (Oct … Sep); curtailment per farm (m³/day, negative =
  cut); annual natural and outflow volumes per water year (collapsed); and
  the **monthly flow-duration curve** of simulated outflow as a shaded 5–95 %
  band with its median against the dashed EWR line, one month at a time from
  a select (`uncertainty/BandFdcChart.svelte`, log flow axis; the chart's
  title says at how many exceedance points the median falls below the EWR).
  With fewer than 30 sets kept no percentiles are shown, only the note why.
  An ensemble run on a newer engine than the run says so. **Reproduce in
  this browser** re-runs the stored ensemble from its seed and options and
  reports "Reproduced: the same … members, verdicts, outputs and coverage" or
  the first differences. Below, **Every ensemble of this run** lists each one
  ever started, newest first (who, when, stored or "started, never stored",
  seed, sets, kept), each with how its rule differs from the shown one, and a
  line counts the starts never stored. Editors get **Run an ensemble**: sets
  (30–1 000, default 300), bounds (the fit's, typical or wide), lowest skill
  kept, worst WR2012 flag kept, the low-flow bias limit (or off) and the pan
  coefficient shift; **Run ensemble** asks the server to fix the rule and
  draw the seed, runs every member in the calibration worker with a live
  count ("Running: 120 of 301 members, 41 kept so far", Cancel), then the
  server checks and stores it. A cancelled one stays in the list as never
  stored. **Run notes** on every run (`runs/RunNotes.svelte`,
  `#res-notes`, helpers in `runs/notes.ts`): the modeller's written
  explanation of the run, the one thing about a run that can change after it
  is made. Editors get a textarea with a character count (4 000 at most) and
  **Save notes** (`PATCH …/runs/:runId`); viewers see the text, or "No notes on
  this run". When the WR2012 flag is *query* or *not usable* and there is no
  note, a prompt asks for the reason. "Last changed … by …" shows under a
  note. Saving updates the shown run, its cached detail and its row in the
  runs list; the note also appears on the compare page and in the summary CSV.
  The same panel then holds the **Evidence** section
  (`runs/EvidencePanel.svelte`, `#res-evidence`, helpers in
  `runs/evidence.ts`; the menu entry is **Notes & evidence**, one entry so the
  rail still fits a laptop screen beside a full runs list): whether the shown
  run is the project's nominated evidence run ("Nominated as evidence on … by
  …", or "…; replaced by “B” on …" for a past one) and, when another run is,
  which. Editors get a required **Why this run is the evidence** textarea (2 000
  characters at most) and **Nominate as evidence** (or **Nominate this run
  instead** when another run is current; `POST …/evidence`). A legacy-model
  run and the current evidence run say why they can't be nominated instead.
  Under it the **Nomination history**, newest first: "Nominated “A” on … by
  …", then each "Replaced by “B” on … by …", each with the run's runoff model
  and engine version and the reason, the current one badged. Nothing in the
  history can be edited or removed. In the runs list the current evidence run
  carries an **Evidence** badge and a replaced one **Former evidence**; neither
  has a delete button (the server refuses with `409`). The run header repeats
  the badge and the evidence line (a link to the section). Above the results,
  a warning appears when a run made **after** the nominated run uses a
  **different runoff model** ("1 run made after the nominated evidence run “A”
  uses a different runoff model (legacy (b023 workbook), not GR4J). The
  nomination still stands: …"), so neither an applicant nor an assessor can
  miss a later model switch. The
  flow-duration curve with Q10–Q95 (`charts/fdc.ts`),
  EWR against outflow, **Reserve compliance by month** when the run has a rule
  table (`#res-reserve`, `runs/EwrAssurancePanel.svelte`, helpers in
  `runs/ewrAssurance.ts`; engine ≥ 0.21.0, model.md §2.9c): a site picker
  when there are several, the method in one sentence and the table's source,
  a verdict line ("Met in 18 of 24 months (75.0%); not met in 6.", with a
  coloured edge and the words, never colour alone), a caution when a calendar
  month has fewer than 10 years, four figures (months met, longest run not
  met, deficit in Mm³ with the mean shortfall, the FDC check), a bar chart of
  the share of months met per month of the year on a fixed 0–100 % axis with
  each bar's value written above it, the same by month of the year as a table
  (years, met, %, mean required and simulated flow in the table's unit, deficit,
  FDC points met), and, collapsed, **Month by month**: every complete month's
  natural flow, its condition (% exceedance, or wetter / drier than the table),
  the requirement, the simulated flow, the share of the requirement and met or
  not met (rows not met shaded). The daily requirement is the series
  `ewr_rule` in the explorer and the daily CSV. Then the monthly EWR compliance grid (per farm, from engine
  0.17.0, the days it was charged and the volume charged, "(EWR charge)" in the
  site picker), the **EWR test
  against observed flow** (`ewr/EwrAgreementTable.svelte`, `ewr/agreement.ts`;
  [model.md §2.9b](./model.md)): a one-line verdict on the frequency bias, the
  hit rate, false-alarm ratio and frequency bias, the 2×2 table of observed
  days (model below / at or above the EWR × observed below / at or above, with
  totals), a per-month table (Oct … Sep, every month listed, months without
  observed days shown as dashes) and, collapsed, a per-water-year table. A run
  without a gauge or logger record, or saved before engine 0.5.3, says why
  there is no table. The **Plausibility checks** (`#res-plausibility`,
  `runs/PlausibilityPanel.svelte`, its own chunk, helpers in
  `runs/plausibility.ts`; engine ≥ 0.25.0, [model.md §2.10d](./model.md);
  only on runs that have them): the dry season in one sentence, a line per
  check (*no finding*, *see below* or *not checked*, with a coloured edge and
  the words), then (1) **Natural flow ≥ observed + net abstraction**: a row per
  water year with natural, observed, the abstraction split into use, dams and
  land cover, observed + abstraction, the gap as % of natural and passes /
  fails / not judged (failing rows shaded); (2) **EWR days by rain source**:
  the share of days not met in good-rain and fallback-rain years, the Reserve
  months met split the same way per rule-table site, and, collapsed, each
  water year's station days, rain, fallback shares and days not met; (3)
  **Observed flow against rain (double mass)**: the whole-record runoff ratio
  and a row per break with the observed and simulated ratios, the change
  beyond the model overall and by season, and what it points to; (4) the
  **dry-season low-flow duration curves** (log axis by default): gauge and
  logger dashed, simulated outflow and natural flow, and the latest run of each
  other runoff model's simulated outflow (fetched on demand, left out with a
  note when it used another dry season); *Simulated outflow over* switches this
  run's curve to one record's days; a verdict on the Q90 comparison and a
  Q70 / Q90 / Q95 table. Farm detail (dam
  storage as % of capacity, supply against demand), and an explorer for any
  stored series, grouped by node. The catchment's series include the final
  catchment rainfall, CHIRPS as uploaded and bias-corrected CHIRPS
  (`rain_final`, `rain_chirps`, `rain_chirps_corrected`, engine ≥ 0.10.1)
  and the day's CHIRPS factor (`chirps_factor`), which the catchment daily CSV
  puts in adjacent columns after rain used. The summary CSV lists the 12
  monthly factors.
- Series are fetched one at a time when a chart needs them, and cached
  (`runs/cache.ts`). A run stores well over a hundred series of one value per day of the run
  on a multi-farm catchment (more since engine 0.12.0: each farm adds 11 working columns).
  Large arrays live in `$state.raw` and are replaced, never mutated.
- **Report**, beside the Download menu in the run header, opens the shown
  run's printable report (§ Report below).

## Report

`/projects/:id/report?run=<runId>` (`routes/projects/[id]/report/+page.svelte`,
WP-2.15 Phase A, issue #19): a meeting-ready catchment report of one run, for
anyone who can view the project. Without `?run=` it reports the latest run. It
uses only existing API routes (the project, the run with its settings and model
snapshot, the series list, four catchment series) and is its own lazy route
chunk. A non-member gets the workspace's "This project doesn't exist or you
don't have access to it"; a project with no runs, or a run that no longer
exists, says so with a link to Runs & results.

- **Sections**, in order, from `report/sections.ts` (data-driven, so the
  licensing evidence pack, #15, can add its own): the cover (project, run,
  period, when and by whom it was made, engine version, evidence badge, a
  legacy-model warning, the run's summary sentence, contents), then numbered
  sections: **Network** (the schematic of the run's own model, farms
  coloured by supply), **Inputs** (the run's settings, monthly A-pan, pan
  coefficient and pragmatic EWR, nodes, crops and planted areas, transfers, and
  each input series' dates and days inside the run; `report/inputs.ts`),
  **Calibration** (the calibration panel with the annual water balance, where
  the parameters came from, the hydrograph over the whole run),
  **Shortfalls and curtailment**, **EWR compliance** (EWR vs outflow, Reserve
  compliance for every rule-table site with Month by month open, the EWR grid
  for the outlet and every farm), **Farms, warnings and checks** (the run
  summary: warnings, headline cards, the farm table; the self-checks and the
  water balance by water year, without Trace a day) and **Notes** (the run's
  notes, when it has any). A section appears only when the run has its data;
  nothing is printed as a placeholder. Not yet: the published-by line and
  restriction notice (WP-2.3), changes since the previous publication (WP-2.4),
  the disclaimer (D10).
- **Components reused, in print modes.** `LineChart`'s `print` prop draws a
  fixed `printWidth` × `height` box at 2 device pixels per CSS pixel
  (`printScale`: uPlot has no pixel-ratio option, so on a 1× screen the plot
  is laid out twice as large and scaled back into the box), with no cursor,
  zoom or controls, the whole period and a plain legend. `EwrHeatmap`'s `site`
  and `print` show one site, named in the heading, without the pickers or the
  keyboard read-out; `EwrAssurancePanel`'s `print` opens Month by month (the
  report renders one panel per site); `SelfChecksPanel`'s `trace={false}`
  leaves Trace a day out.
- **Ready.** Each chart sets `data-ready="true"` on its figure once it has
  drawn (or has nothing to draw), and the page's `<main>` gets
  `data-report-ready` once every fetch is in (including the summary's lazy
  human-impact tables) and every chart has drawn (`isReportReady`). Until then
  the bar says "Preparing the report…" and **Download PDF** is disabled. The
  signal is what e2e waits on, and what the server-side render waits on.
- **Download PDF** calls `window.print()`; the hint says to choose **Save as
  PDF**. Print CSS: A4 (`@page`, added while the page is open), a page break
  before each section, headings kept with what follows, rows and figures not
  split, tables printed whole with their header row repeated, wide tables
  tightened to fit the page width, background colours kept (the heat map,
  flagged rows), and no app header, banner or on-screen bar.
- **Themes.** On screen the report follows the light or dark theme. A print
  is always light: on `beforeprint` the page and each print-mode chart set
  `data-theme="light"` on `<html>` (`report/printTheme.ts`, idempotent) and
  the charts redraw synchronously, so the canvas is light before the page is
  laid out; `afterprint` puts the previous theme back.
- **Generate PDF / Email me the PDF** (WP-2.15 Phase B, issue #26;
  `lib/components/report/ServerPdf.svelte`, a lazy chunk loaded with the bar)
  sit beside Download PDF for any viewer. They queue a server-side render of
  the shown run: the background worker opens this same page in headless
  Chromium and prints it to A4 with `page.pdf()`, so the PDF is the same
  pages this page prints ([architecture.md § Server-side reports](./architecture.md#server-side-reports)).
  The bar then follows the job's status (`role="status"`: "PDF queued: waiting
  for the background worker…", "Making the PDF…", "The first try failed (…);
  trying again shortly…", "PDF ready (9 pages). The link is on its way by
  email.", or "The PDF could not be made: …"), polling the API every 1.5 s
  until it settles, and offers **Download the generated PDF** (a link valid
  for an hour). The wrapper carries `data-state` (`idle`, `starting`,
  `queued`, `rendering`, `retrying`, `done`, `failed`). Locally the worker
  must be running (`pnpm dev:full`, or `pnpm dev:jobs:tick` once).
- **The emailed link** opens `/projects/:id/reports/:jobId`
  (`routes/projects/[id]/reports/[jobId]/+page.svelte`, its own lazy route):
  signed out, the reader signs in first and comes back; a member sees the
  status and, once ready, **Download the PDF** (a fresh one-hour link each
  visit) and **Open the report in the app**. Anyone else, or a PDF past its 7
  days, gets "This report doesn't exist any more, or you don't have access to
  its project." Tested by `e2e/tests/server-report.spec.ts`.

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
  and a reach of river, plus help-tip close-ups of the dam's stored water, the
  stream and slopes flowing into it, the wall and the stream below it, the
  irrigation line, the orchard and the gauging hut. `pnpm gen:help-art` (`bin/gen-help-art.sh`, scene in
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
- **Help tips** (ⓘ) for terms that map to a part of the scene (`TIP_PICTURES`
  in `lib/help/pictures.ts`: a shot and the spot of the term's own feature)
  show that close-up above the text with a white ring on the feature, so
  neighbouring tips (capacity, inflow, spill, irrigation…) don't repeat one
  picture. No two tips share a shot *and* ring, and no shot serves more than
  eight tips (`tour.test.ts`). The picture is decorative
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

## Farmer view (`/farm`)

The phone-first view for a farmer (WP-2.6); the design is
[design/farmer-view.md](./design/farmer-view.md) and its prototype boards.
It renders a `FarmView` (`packages/engine/src/views/farmView.ts`) from
`GET /projects/:id/farm/:nodeId`, the current publication projected for one
farm; `GET /projects/:id/farm` lists the farms and says whether anything is
published.

- **Routes.** `/farm` lists every farm linked to the user across projects
  (notice level, received %, dam %, or "Not published yet"), and goes
  straight to the only one. `/farm/[projectId]` is one farm (`?node=` and a
  switcher when the farmer has several there), with `/why` ("Why about
  83 %?", three numbered steps) and `/dam`. `/farm/words` shows the help
  entries in the `farmer` category ("What do these words mean?"). The root
  page sends a user whose every membership is `farmer` to `/farm`; the
  workspace (`/projects/[id]`) answers a farmer 403 and redirects them to
  `/farm/[id]`.
- **Frame.** The farm pages have their own header ("My farm", Menu: your
  farms, the words, "Don't keep a copy on this phone", sign out); the app
  header isn't shown. One 560 px column, a 16 px base, 44 px targets,
  nothing under 13 px, existing tokens only, light and dark.
- **Main page, top to bottom:** the name and the dates line ("Published by
  the WUA on …. Data up to …", amber with its age when stale); the WUA's
  notice first (warning or danger fill, icon and level in words), or "No
  restriction from the WUA"; water received this season with the ML/m³
  switch (kept on the phone until the account preference exists); the dam
  (hidden without one) with the days-left line, or the no-stop-level
  wording; "Looking back", the model's card (dashed, neutral "Model: …"
  chip, never the notice's fills), a single link line under a `restricted`
  notice; the last 12 months (inline SVG bars at the rendered width, a
  summary sentence and a full table behind "Show the numbers"); last
  season; the farm on the river (counts, the outlet's last 30 days, the
  privacy sentence and "Who can see my farm", which loads the people by name
  and role when first opened, `GET …/access`, and falls back to the roles
  alone if that fails); the CSV download and the
  disclaimer. "Next 14 days" is left out until forecast mode (WP-2.12).
- **Wording.** Every visible string and number rule lives in pure modules
  under `lib/components/farm/` (`format.ts`, `cards.ts`, `why.ts`,
  `dam.ts`, `chart.ts`), pinned to the prototype with a Vaalbank fixture
  (`fixture.ts`); a test keeps the design's "never says" words out.
- **States.** Skeleton cards with a hidden status and "Slow signal?" after
  3 s; no publication; an error with Try again (a contact line after the
  second failure, never raw error text); access removed (403/404), which
  also clears the saved copy.
- **Saved copy** (`savedCopy.ts`, design §9): the last good `FarmView` per
  user and farm in `localStorage`, shown at once with "Updating…". Without a
  signal it stays under a dark strip ("No signal. These are the figures
  saved on this phone at …") over a reduced view. Cleared on sign-out, on a
  403/404, when another user signs in, after 30 days unused, and by the
  Menu's opt-out. No service worker, no polling: the page refetches when it
  becomes visible again.
- **Preview.** Viewer+ can open a farm's page ("Preview as farmer" in the
  Network tab's node detail); it shows under a "You're previewing … as its
  farmer sees it" banner and keeps no copy.

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
