# The catchment workspace (UI)

## App header and account menu

Every signed-in page (`lib/components/layout/AppHeader.svelte`) shows a sticky
header with the brand, the Projects / Teams / Help nav, and an account control
on the right: an avatar, display name and email that open a menu (same
disclosure pattern as the Data/Runs tabs' download menu — a button plus a
hidden list, not an ARIA `menu`/`menuitem` widget) with three entries:

- **Account** — a link to `/account` (marked `aria-current` while there).
- **Sign out** — ends this device's session only, same as before.
- **Sign out everywhere** — asks for confirmation, then calls
  `POST /auth/logout-everywhere` ([api.md § Auth](./api.md#auth)), which
  revokes every session on the account (this device included) by moving its
  revocation watermark forward. Both actions clear the local session and
  return to `/login`.

The menu is keyboard-operable: Escape closes it and returns focus to the
account button, as does a click outside; a tab or click that leaves the
header closes it too.

**The account page** (`routes/account/+page.svelte`, WP-1.9) shows the email
address and whether it is confirmed, a **Display name** form
(`PATCH /auth/me`; the header follows at once), **Language and units** (the
language switch and the farm view's m³ / ML, [§ Language](#language)), a
**Your data** panel whose **Download my data** button saves the
data-subject export (`GET /auth/me/export`, a JSON file; the download
helpers load on click, and a second click within the minute shows the
server's `429` message in an alert) and a
**Password** form
(current, new, repeat; `POST /auth/change-password`). Changing the password
signs out every other device while this browser stays signed in. Errors show
in an alert above the form, with the field it's about marked
`aria-invalid`: *Your current password is wrong.* (the server's `403`, which
also counts towards the sign-in lockout, whose `429` message is shown as
is), and the new-password rules checked before any request (*Use at least 8
characters.*, the two not matching).

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
The tabs are grouped into three sections (issue #17, option A · Results
first): **Outcomes** (Overview, Runs & results, Scenarios, Allocations),
**Build the model** (Network, Crops & demand, Transfers, Data, Settings &
calibration) and **Review** (Applications, History). The sections are
`NAV_SECTIONS` in `lib/workspace/tabs.ts`, and `navSections(shown)` splits
whatever tabs a role sees into them (empty sections are dropped; a tab no
section lists joins *Build the model*). It is layout only: the URLs stay
`?tab=<id>` and which tabs a role sees is unchanged (below).

- **1680 px and wider:** a sidebar beside the tab's content, with the section
  labels shown, sticky under the app header. The page grows by the sidebar's
  width, so the content column keeps its usual 1480 px maximum. Narrower
  screens don't get the sidebar because the network's node table only just fits
  1440 px on its own (`model.spec.ts`).
- **900–1679 px:** one strip across the top, sections side by side with a
  divider and a small label over each.
- **Below 900 px (phones):** the same strip scrolling sideways; the section labels are read
  out (each section is a named group) but not shown.

The arrow keys move through the tabs in the order shown, across sections,
wrapping at the ends (Right/Down next, Left/Up previous).

| Tab | `?tab=` | Aliases | Code |
| --- | --- | --- | --- |
| Overview | (none) | | `lib/components/overview/` |
| Runs & results | `runs` (`&run=<id>`) | `results` | `lib/components/runs/` |
| Scenarios | `scenarios` (`&scenario=<id>`) | | `lib/components/scenarios/` |
| Allocations | `allocations` | | `lib/components/allocations/` |
| Network | `network` | | `lib/components/network/` |
| Crops & demand | `crops` | `demand` | `lib/components/crops/` |
| Transfers | `transfers` | | `lib/components/transfers/` |
| Data | `series` | `data`, `timeseries` | `lib/components/series/` |
| Settings & calibration | `settings` | `calibration` | `lib/components/settings/` |
| Applications | `applications` | | `lib/components/scenarios/ApplicationsTab.svelte` |
| History | `history` | `changes` | `lib/components/history/` |

**Tabs by role** (`lib/workspace/tabs.ts`, issue #6). One pure function,
`visibleTabs(role, prefs, rendered)`, decides which tabs the strip shows and
which setup-checklist steps are links:

| Role | Tabs shown |
| --- | --- |
| owner, editor | every tab |
| viewer | Overview, Data, Runs & results, Scenarios; Network, Crops, Transfers, Settings & calibration and History behind a **Show model inputs** checkbox at the end of the strip. Never Applications |
| contributor, farmer, none | Overview only (a farmer is redirected to `/farm/:id`, an applicant gets the Applicant view, [§ Applications](#applications-wp-33)) |

Each tab is one entry in `TAB_GROUP` (`core`: everyone; `inputs`: the model
inputs; `assess`: the assessors' Applications list, owners and editors
only), so adding a tab is one line; a tab the table doesn't know counts as
an input, and a tab the page doesn't render is dropped. Overview can never be
hidden. Whether a viewer starts with the inputs shown is one constant,
`VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT` (`false`; a client question). The
checkbox isn't saved: it resets when the project is opened again.

This is **presentation, not access control**: RLS still lets a viewer read
every input. A deep link to a hidden tab (`?tab=settings`, or an alias) still
opens it, and the strip then shows that tab in its place while it is open
(`stripTabs`), so you can see where you are. The Overview checklist keeps a
hidden tab's step and its status, but as plain text rather than a link; its
headline facts still link to their tabs (a deep link, as above). The
per-member "choose your own tabs" preference is not built yet
([followups.md](./followups.md#roles-and-what-each-member-sees)); it will
arrive through `prefs`.

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
  **Unit** is a list of the units the kind accepts (`unitOptions`: m³/s, l/s,
  m³/day, m³/h, ML/day for flow; mm, cm, in for rain), the kind's own first;
  any other says "Values in l/s are converted to m³/s when saved", and the
  server stores the converted values (api.md § Units).
- After an upload a banner offers **Re-run model**. Every tab notes new data
  since the last run: a rainfall series that reaches past the
  latest run's end, or was updated after it (`newDataSinceRun`).
- **Automatic runs** (WP-2.11): when the project has them on and a re-run is
  queued (`project.rerunQueuedFor`, and the upload's own answer), both
  banners say "An automatic re-run is queued for 14:05." (the viewer's local
  time; "… for 27 Sep 00:05" on another day; "… is due now." once its time
  has passed) instead of offering **Re-run model**
  (`autorun/autoRun.ts` `rerunQueuedText`). The page doesn't poll: the run
  shows in the Runs list on the next load.

## Overview

The setup checklist (`overview/checklist.ts`), the latest run's results,
the published baseline, a "Needs attention" list, the active alerts ([§ Alerts](#alerts)), eight headline facts, project details, the import
record (an imported project only), recent notes ([§ Notes](#notes)), team and members.

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
- **Published baseline** (WP-2.3, `overview/PublishedBaseline.svelte`),
  under Latest run (shown with or without runs): what stakeholders and farmers see. It fetches
  `GET /projects/:id/publication` and names the published run (a link to it
  in Runs, with its period from the page's runs list), when and by whom it
  was published, the notice level with its percentage ("Advisory · 15 %"),
  the English and Afrikaans notice, and the next expected update (a calendar
  day, `fmtDay`). It is read-only for everyone: editors get **Change the
  notice or publish another run**, a link to the Runs tab on the published
  run at its Publication panel (`?tab=runs&run=<id>#res-publication`), so
  the notice has one editor, not two. With nothing published: "No run is
  published yet. Stakeholders and farmers see nothing until you publish one
  (Runs tab)." Its own `LoadState` (loading, an error with a retry).
  **New auto run: publish?** (WP-2.11, editors): when the newest automatic
  run is newer than the published run (`autorun/autoRun.ts`
  `autoRunToPublish`), the card names it with **Compare with the published
  run** (the compare page, published run as A) and **Review and publish**
  (the Runs tab on the auto run, at its Publication panel). Publication stays
  a person's act unless the project chose "Publish if there are no new
  warnings" in Settings; nothing here publishes.
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
  record, team, members, farmers, share links.
- **Members**: each applicant row has an **Applying party** box for owners
  (saved on change; blank for none): an applicant shares applications only
  with the members of their own party, so put an applicant and their
  consultant or client in the same one. Others see the party as text.
- **Farmers** (WP-2.1, `overview/FarmersPanel.svelte`): each farmer with the
  farms linked to them, by name. Owners change a farmer's farms and remove
  one, and **Invite farmers** (WP-2.2, `overview/InviteFarmersDialog.svelte`)
  opens a dialog with two modes: *One farmer* (email, a tick box per farm,
  the email's language) and *Several, from a CSV* (`email,farm,language`,
  one farm per row, pasted or uploaded, header optional; parsing in
  `overview/farmers.ts`). A CSV is previewed first: a table of every row's
  line, email, farm and what will happen (added, invited, or the row's
  error), from a server dry run that sends nothing; **Send** then does it and
  the table shows the results. A verified account is added at once; anyone
  else is invited and listed under **Pending farmer invitations** (owners
  only) with their farms, who sent it and when it expires, with Resend and
  Revoke. Empty state: "No farmers yet: invite them to see their own farm."
  Farmer invites stay out of the Members panel's pending list.
  Farmers aren't in the Members list (it hides the `farmer` role), and a
  farmer never sees this tab: their own view is WP-2.6. A link to a farm
  deleted but not yet saved reads "a removed farm".
- **Share links** (WP-2.3 phase 2, `overview/ShareLinksPanel.svelte`, rules
  in `overview/shareLinks.ts`), owners only, under Farmers: read-only links
  to the published baseline for people outside the project. *Make link*
  takes who it's for (up to 100 characters) and how long it works (1 week,
  30 days, 90 days or 1 year); the new URL shows **once**, in a read-only
  field with **Copy** (it falls back to selecting the field when the
  clipboard is refused), because the token isn't kept. The list shows each
  link's label and state (Live, Expired, Withdrawn), who made it and when,
  when it ends or who withdrew it, and when it was last opened (to the
  hour), live links first. **Withdraw** asks first, then the link shows the
  dead-link state to whoever holds it. With nothing published, a note says
  a link opens only once a run is published.
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

**A click anywhere on a project's row opens it.** The name link stretches
over the row (`ProjectTable.svelte`, `.name::after`), so it's a real link:
Ctrl/Cmd-click or a middle click opens a new tab, and the keyboard and screen
readers still meet one named link per row. The row's Team link, its Add data,
Copy and Delete buttons, and the freshness and last-run badges (whose tooltips
explain them) sit above the stretch and keep doing their own thing.

**Delete** asks for confirmation, then deletes. A project that has nominated
an evidence run is kept for good (issue #43, [data-model.md](./data-model.md)
§ Evidence nomination), so the server answers `409`; instead of the raw error
the page opens a **This project can't be deleted** dialog
(`lib/components/projects/deleteRefusal.ts` reads the answer). It names the
evidence run, says the nomination history is kept so the evidence can still
be read and reproduced, and that a nomination can be replaced but not
withdrawn; it links to the run (**Open the evidence run**, the Runs tab) and
offers **Copy project**, which opens the copy dialog for a fresh start
without the runs and their nominations.

### Import a project file

The import dialog (`lib/components/import/ImportProjectDialog.svelte`, WP-1.8)
turns a project document into a new project through `POST /projects/import`:

1. **Pick** a `.json` file: a project's *Download project (JSON)* or the
   workbook importer's `project.json`. It's read in the browser
   (`import/projectFile.ts`); a file that isn't JSON, isn't a project document
   or is over the 5 MB cap is refused here, before anything is sent.
2. **Preview** (`ImportPreview.svelte`): the importer's notes first (for
   example, a file with no time series, or an export's notes, which aren't
   imported and aren't sent), then the name (editable, prefilled
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
   - **CHIRPS column** (only when the workbook has one; issue #40 part c):
     which CHIRPS product and version it holds, **CHIRPS v2.0 (usual for
     b023)** preselected, or CHIRPS sat / rnl v3.0, or *Not known*. The
     series goes in labelled with the answer
     ([data-model.md § Series provenance](./data-model.md#series-provenance-032_series_provenancesql)),
     which is what later stops the CHIRPS feed (v3.0) splicing onto it. The
     Python importer (`pnpm import:project`, `seed:demo`) leaves it
     unrecorded; say it on the Data tab.
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

### Portfolio (`/teams/:id/portfolio`)

The WUA's one screen for all of a team's catchments (roadmap WP-2.14,
`routes/teams/[id]/portfolio/`, wording and sorting in
`lib/components/portfolio/portfolio.ts`). Linked from the team page and
from each team group's heading on the project list. One row per catchment
the user can see, from `GET /teams/:id/portfolio` ([api.md §
Portfolio](./api.md#portfolio)):

- **Catchment**: the name (opens the project's Overview) and where the
  figures come from: *Published run*, *Published run (a newer run is not
  published)*, *Latest run, not published* or *Not run yet*, with a hint
  for editors to run or publish.
- **EWR, last 30 days**: the status as words **and** colour, never colour
  alone: "Red: EWR not met 9 of 30 days", "Green: EWR met all 30 days", or
  "Unknown: no run yet / no EWR set in the run / the run has no EWR record;
  run it again" (dashed outline). Under it, how old the figures are
  ("Figures to 29 Dec 2023, 1,002 days ago") and a *Stale* flag past 7 days.
- **Farms short**: "2 of 12 farms short this week" (a link to the Runs tab's
  Curtailment section of that run) and the count over 30 days; "Unknown
  until a run is published" without a publication.
- **Lowest dam**, **Restriction** (the WUA's level and %), and **Data**:
  recorded rain to …, a *Newer data not in the figures* flag, and the feeds'
  health.
- **Alerts**: the alerts firing now, "None" or "2 firing" (a warning badge),
  from `alertsFiring` ([§ Alerts](#alerts)).

Wide screens get a sortable table (column-heading buttons with `aria-sort`);
under 760 px the same rows become stacked cards with a *Sort by* select.
Sorts: EWR status worst first (red, amber, unknown, green; more days not met
first within a colour; the default), name, figures age, farms short, lowest
dam; unknown values sort last either way. The sort lives in the URL
(`?sort=`, `?dir=desc`). States: loading, error with retry, an empty team
("No catchments in this team yet", with *New project in this team* for
members and admins), and not-found for a team you aren't in. A farmer who
opens the address is sent to their farm view (`/farm`), as the project list
does. The intro states the thresholds the API returns.

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
- **Dam survey and releases** (engine ≥ 0.35.0, WP-3.5, [model.md §2.7a](./model.md)),
  one-node form, farms with a dam (`DamStorageFields.svelte`, `damCurve.ts`):
  without a curve it says the power-law area is in use; **Paste survey rows**
  opens a box for level, area and volume rows (commas, semicolons, tabs or
  spaces; a header line skipped) with **Use these rows** / **Cancel**, and a
  line it can't read is named in an alert. With a curve: its rows as a table,
  a small area–volume chart (dashed line at the capacity; the chart's
  accessible name gives the first and last rows), the save rule's message if
  it breaks one, a note when the top row is more than 1 % from the capacity,
  **Edit the survey rows** and **Remove the curve**. Below: **Release rule**
  (none / pass inflow / fixed) with its monthly amounts (m³/day, Oct–Sep,
  *Use October's amount for every month*); under pass inflow a checkbox
  keeps the EWR required at the node as the target. The Farm dam group gains
  **Seepage returning** (%) and **Outlet capacity** (m³/day, empty = no
  limit), one-node form only. Viewers see the values read-only (no paste
  controls). The dam hint about a missing area is dropped when a curve gives
  it. Settings: **Vary it by month** under the dam evaporation factor opens a
  monthly row of factors (started from the single one).
- **Individual boreholes** (engine ≥ 0.36.0, WP-3.9, `BoreholeFields.svelte`),
  one-node form, farms and other users: always the note **Low confidence:
  Depletion is a fixed fraction, not an aquifer model. Attach the geohydrology
  report.** **+ Add borehole** adds one (supplemental, straight to the crop, no
  capacity or cap yet); each has a **Name**, **Capacity** (m³/day), **Annual
  cap** (m³/a, empty = none), **Mode** (supplemental / primary / emergency /
  none; emergency only with a dam), **Runs below** (% of dam, emergency only),
  **Pumps into** (the crop or the farm dam; farms only, the dam only with one)
  and **Stream depletion** (% of pumping). Below them: the caps' total and the
  GN 538 context (up to 40 000 m³/a per property, depending on its size; the
  app never decides legality). Read-only for viewers; fields stack on a phone.
  Removing the node asks about its boreholes too.
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

### Yield (WP-3.6)

`lib/components/yield/YieldPanel.svelte`, its own chunk (with its chart),
loaded only when a farm is focused. It sits under the farm's form in the
**One node** layout, and under a scenario (**Yield under this scenario**,
with a dam picker over the scenario's own farms). The numbers come from a
background `yield` job ([api.md § Yield](./api.md#yield), [model.md §2.13](./model.md#213-firm-yield-and-storageyield-engine--0340-roadmap-wp-36)).

- A note says every number is **historical**: it replays the one record, and
  a stochastic yield can be materially lower (not computed here).
- On the Network tab a **Run** select picks the saved run of the model it
  works on (the newest by default; scenario runs aren't offered). With no
  run, it says to run the model first.
- Editors pick a **Draft pattern** (constant, or this farm's irrigation
  demand by month) and an **Assurance** (firm, 98, 95, 90 or 80 %), then
  **Work out the yield** or **Storage–yield curve** (disabled, with a title
  saying why, for a farm with no dam). Viewers see the results with no
  controls.
- The status line (a polite live region) follows the job on
  `GET /jobs` every 1.5 s: Queued, Running with its % (and a progress bar),
  then the results; Failed with the server's reason (never database text);
  Cancelled. **Cancel** stops a waiting job at once and a running curve at
  its next point.
- **Results**: the newest firm yield as a definition list (the yield in
  m³/day and a year, the dam's capacity, the pattern, failure days and
  years at that draft, who worked it out and the engine version); the
  newest curve as a uPlot line (yield against capacity in thousand m³) and a
  table (capacity, yield per day and year, failed water years; the dam's own
  capacity marked "this dam"). A curve whose yield falls somewhere as the dam
  grows carries a warning saying why that can be real.
- Not yet: the instant in-browser preview through the preview worker, and
  finding a job started in another tab (the panel follows only the jobs it
  started) ([followups.md](./followups.md)).

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
confirm; runs already stored are not affected). A CHIRPS series shows which
product and version it holds (issue #40 part c): editors get a select
(*Version not recorded*, CHIRPS v2.0, CHIRPS sat v3.0, CHIRPS rnl v3.0) that
relabels it without touching its values (`PATCH …/series/:id`), viewers the
words. The **Upload CSV** form asks the same for a CHIRPS file (*Not known*
by default, or the existing series' own label when appending to it); a
merge of another version into a filled series is refused by the server with
its reason. The alternative catchment gauge and the reanalysis (engine ≥
0.30.0, issue #40 (b)) take an optional free **Product** and **Version**
instead (e.g. SASSCAL AWS / 1), shown on their row; both kinds are marked
*Not used: no rain-source period names it* until Settings → *Rain source
periods* names them. A CSV with several timed readings a day (an automatic
station's hourly log) is not refused: the form asks how to add it up into
days, **08:00 to 08:00, booked to the day it starts** (the default, the
manual-gauge day) or **midnight to midnight**, and its summary says how many
readings, how many a day and how many days are short of that. Each
timestamp closes its interval. The series records the choice
(`dayBoundary`), shown as an *08:00 day* tag on its row, and a merge of the
other window into it is refused ([model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)).
Below 640px wide each row becomes a card
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
  `settings/sections.ts`). It is the shared in-page menu
  (`common/SectionNav.svelte`, also on Runs & results): a bar of pill links
  that sticks under the app header down the long form and marks the group
  being read with `aria-current="location"` (scroll spy: `activeSectionId`
  in `common/sectionNav.ts`, the last section whose top has passed under the
  menu, or the last one at the bottom of the page). A group with a Save
  blocker gets a red dot ("has a problem" to screen readers). It is a bar
  rather than a side rail because the monthly input rows need the full
  width. On phones it is one strip that scrolls sideways inside itself (the
  marked link kept in view), never the page. While shown, the menu raises
  the page's `scroll-padding-top` by its height, and this tab sets
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
At 320 px the whole tab reflows with no sideways page scroll (WCAG 1.4.10):
selects and period lists shrink to the screen, and only the section menu and
the monthly tables scroll, inside their own boxes (`e2e/tests/reflow.spec.ts`,
which checks every catchment tab).


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
    unticking it sets X2 back to 0.
    After the GR4J parameters and the groundwater exchange (X2) block comes
    the **GR4J potential evaporation** group (`settings.pe`, engine ≥
    0.31.0, issue #39, `settings/peInput.ts`;
    [model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4)).
    Two radios choose where GR4J's PE comes from: **Pan coefficient ×
    A-pan** (the default) and **Monthly PE, entered directly**. Under them a
    line gives the annual total GR4J runs on: "Annual GR4J PE: N mm (pan
    coefficient × A-pan; A-pan M mm a year)", or "… (the monthly PE row
    below)". The note under it depends on the choice. Under pan: the A-pan
    row (Demand) also drives irrigation demand and dam evaporation, so
    changing it moves all three. Under monthly: demand and dam evaporation
    still use the A-pan row, and GR4J doesn't use the pan coefficient.
    - **Under pan coefficient × A-pan**: a **preset** picker (Generic (flat
      0.70), Winter rainfall (e.g. Western Cape), Summer rainfall —
      indicative, from FAO-56 Table 5 climate classes, Allen et al. 1998;
      model.md §2.4a) fills the pan-coefficient row with a starting point;
      the row stays editable after, and the preset's name goes into the
      **Pan coefficient source** note below the row. Below it, a collapsed **Suggest from
      FAO-56 Table 5 (humidity, wind, siting)** helper
      (`settings/PanCoefficientHelper.svelte`, loaded as its own chunk and
      hidden on a read-only view): the pan siting (Case A, green crop, or
      Case B, dry fallow) as radios, the windward fetch as a select (1, 10,
      100 or 1000 m), an optional reduction for bare surroundings (0–20 %),
      the mean RH (%) and wind at 2 m (m/s) for each of the 12 months, and a
      required "Where the RH and wind came from" note. **Fill the
      pan-coefficient row** replaces the 12 values in the form only, and
      writes the table cells used plus the RH and wind note into the **Pan
      coefficient source** note: nothing is saved until Save, and the values
      and note stay editable. The button stays
      disabled, with the reason beside it, until every month has a valid RH
      and wind and the note is written. Then the monthly **pan coefficient**
      row. A warning appears under the row when a month sits outside
      FAO-56's usual 0.6–0.85 range for a Class A pan — a plausibility
      check, not a hard limit, so a value further out still saves. Under
      the row, an optional **Pan coefficient source** text field (up to 600
      characters, engine ≥ 0.31.1): where the row came from. Fit provenance
      shows it as a "Pan coefficient source" row when a fit recorded one,
      and the report's inputs add it to the GR4J potential evaporation line
      under pan coefficient × A-pan.
    - **Under monthly PE**: the preset, the helper, the pan-coefficient row
      and its warning are hidden. A 12-month **Monthly PE (mm)** row, with a
      Year total, and a required **Source** field take their place.
      Switching to monthly starts the row from the current pan coefficient ×
      A-pan, rounded to 0.1 mm, so the annual total doesn't jump, with the
      source blank. Switching back to pan and then to monthly again restores
      the row switched away from, until the settings are saved. Save is
      blocked while the source is blank or over 600 characters, or a month
      is outside 0–10 000 mm. A row of zeros saves.
    A separate notice appears when GR4J's PE is 0 in every month (A-pan ×
    pan coefficient, or the monthly PE row): the engine then refuses GR4J
    runs and fits.
- **Rain gaps and CHIRPS** (`#set-rain`): the **CHIRPS bias correction**
  picker (`settings.chirpsBiasCorrection`, `settings/rain.ts`: bias-corrected
  per month, the default, or raw CHIRPS; it applies to both models and to
  demand, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
  A run that corrected CHIRPS lists the monthly factors and the number of
  days in its warnings. Below it, **CHIRPS fit period** (always shown; with raw CHIRPS it says it is unused but kept, and an invalid list still blocks Save where it can be fixed)
  (`settings/ChirpsFitPeriodSection.svelte`, `settings.chirpsFitPeriod`,
  engine ≥ 0.29.0): "Whole record (default)" or "Listed water years", the
  latter with rows of from / to water year and a required reason
  (overlapping or reasonless ranges block Save). **Propose from the
  double-mass breaks** (`settings/proposeFitRanges.ts`, pure part
  `fitRangeProposal.ts`) loads the catchment rain and CHIRPS and fills the
  list with one range per double-mass segment, each reason saying it is a
  proposal; nothing is saved until Save, and the hint says to check each
  range against the station history, since a detected break can be a year
  or two off ([model.md §2.4b *Fit period*](./model.md#fit-period-and-per-range-factors-engine--0290-issue-40)).
  Fit provenance shows the fit period and the factors per range, with the
  years each was fitted on, that the fit ran under. Below it, **Zero-rain runs in the catchment rain**
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
  detection rule. Last, **Rain source periods**
  (`settings/RainSourceSection.svelte`, pure part `settings/rainSource.ts`,
  `settings.rainSource`, engine ≥ 0.30.0,
  [model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)):
  *None* until **Add a rain-source period**, which starts one over the last
  five complete water years from the alternative catchment gauge, fitted
  against the reanalysis over the ten years before, with a blank reason
  that blocks Save until written. Each period has From / To dates, a
  Reason, **Factors** (*Fixed monthly factors, with where they came from*:
  twelve factors Oct … Sep, 0.25–4, and *Fitted by*, *Fitted on, from* /
  *to*, *Method*, all required; or *Fit against a reference series*: the
  reference, reanalysis or CHIRPS, and the reference era's water years),
  **Gaps from** (CHIRPS × the CHIRPS fit-period factors, or the reanalysis
  with the water years its factors are fitted on) and **CHIRPS ingests this
  gauge in this period**, which refuses CHIRPS as the reference and needs a
  reanalysis fallback. The form blocks Save on the engine's own check
  (`rainSourceError`, which the API uses too), with the first problem
  shown under the list. It doesn't reuse the period editors above: its rows
  have different fields, and it is the second list with water-year fields
  (the CHIRPS fit period is the first), short of the third caller that
  would justify a shared editor.
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
    is called out too, and a change to the pan coefficient, A-pan, PE input, CHIRPS
    bias correction or zero-rain runs since the fit shows a **Forcing changed since fit** badge
    and a caveat explaining why (evaporation trades off against X1/X3, and
    CHIRPS bias correction changes the rain GR4J sees on fallback days, so the
    fit needs redoing). So does a CHIRPS series that now holds another product
    or version than the fit ran on (issue #40 part c; the fit records it, and
    Settings compares the series a run would use), with its own caveat. The
    record's **CHIRPS series** row names the product and version the fit ran
    on, and the series' current one when it differs. Its **Rain source
    periods** row lists the periods the fit ran under (engine ≥ 0.30.0; a
    fit made before them ran with none), and a change of periods also shows
    **Forcing changed since fit**. Its **GR4J potential evaporation** row
    (engine ≥ 0.31.0) gives the PE input the fit ran under: "pan coefficient
    × A-pan", or the monthly total and source with the 12 values (a fit made
    before it ran on pan coefficient × A-pan). Under a monthly PE the pan
    coefficient row adds "(not used by GR4J under a monthly PE)". A change
    of kind or of the monthly row shows **Forcing changed since fit**; a
    reworded source doesn't, and under a monthly PE neither does a change to
    the pan coefficient or A-pan alone.
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
  months get the full width) a bar chart and the annual volume, the
  curtailment reporting window (also the assurance of supply's window), and
  the **annual assurance threshold** (%, `settings.assuranceAnnualThreshold`,
  default 90 %: a water year counts as met at that supply ratio; engine ≥
  0.32.0).
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
  From engine 0.33.0 ([model.md §2.9d](./model.md)): a *total* table has
  **Also enter the low flows (maintenance and drought)**, which adds a blank
  **Low flows (maintenance to drought)** grid (blank cells block Save; switching
  the table to *Low flows only* drops it) and a **Fill the low flows** button;
  **Load a CSV file** reads a file into the paste box, and two links download
  synthetic example layouts (a total-flow and a low-flow table, DRM style).
  Under each table, **High flows: freshets and floods**
  (`settings/EwrHighFlowsEditor.svelte`) lists the components (name, the
  months it may start in typed as "Nov-Jan" or "Nov Dec Jan", peak m³/s, days
  at peak, events per year) with **Add a high flow** and Remove, a **Paste high
  flows** box with **Fill the high flows**, **Load a CSV file**, and a synthetic
  example CSV. The two status lines are named *Paste result* and *High-flow
  paste result*.
- **Simulation period**.
- **Data quality**: the gauge-vs-logger thresholds (lowest and highest ratio
  in %, shown to one decimal; minimum shared days; defaults 66.7 % (two
  thirds), 150 %, 90 days). Out-of-range
  values block Save with a message. They only change which water years are
  flagged, never the results.
- **Automatic runs** (WP-2.11, `settings.autoRun`): **Re-run the model after
  new data** (off by default); **Wait after the latest new data** (minutes,
  0–120, default 15; more data within the wait pushes the run back, never
  more than 2 hours after the first of it); **Publishing**: *Never: a person
  publishes* (the default) or *Publish if there are no new warnings*. The
  wait and publishing are disabled while it is off; a wait outside 0–120
  whole minutes blocks Save. Saving only this group doesn't mark the runs as
  out of date (it changes no input).

### Data feeds

Below the settings form (it saves on its own, never through the save bar) is
**Data feeds** (`#set-feeds`; `lib/components/feeds/DataFeedsPanel.svelte`,
its own chunk loaded with the tab; WP-2.10,
[architecture.md § Data feeds](./architecture.md#data-feeds)).

- **The list**, one card per feed: a state chip in words (**OK**, **Stale**,
  **Failing**, **Waiting**, **Off**; colour is never the only signal, and the
  card carries `data-state`), the source, the series it writes ("→ Rainfall —
  forecast"), where it reads ("cell -20.12, 25.17" or "station X0H000"), the
  what a CHIRPS feed writes ("· CHIRPS sat v3.0"), the schedule and who it
  runs as, the health sentence ("The last fetch
  failed: the source is unreachable: HTTP 503. Newest data 1 Sep 2026.",
  written by the panel from the server's reason code and days, `healthMessage`
  in `feeds.ts`, its days like the rest of the app's calendar days), and
  "Last data 21 Sep 2026 · checked 2026-09-24 06:00" (the data day is a
  calendar day, never shifted by the time zone). CHIRPS says how many of the
  days are preliminary.
- **A version conflict** (issue #40 part c): when the feed's series holds
  another CHIRPS product or version, or an unrecorded one, the card says
  every fetch is refused and why ("The series holds CHIRPS v2.0 and this feed
  writes CHIRPS sat v3.0 …"), and owners get **Replace the series** (after a
  confirm naming the full backfill, the History tab keeping the old values,
  and the refit). Once confirmed the card says the feed backfills the new
  record and then replaces the series whole, with **Withdraw the
  replacement** (discards what was backfilled). While it backfills, the
  health sentence says how far it has got ("Replacing the series: the new
  record runs 1 Jan 2001 to 30 Apr 2001 so far …"), or that it stalled; the
  Data tab marks the series **Being replaced** and both the Data and Runs
  tabs note that runs use the current series until it completes.
- **A warning** above the list counts the feeds that are stale or failing
  ("1 feed needs attention: …", `role="alert"`).
- **Run now** (editors) queues a fetch at once and says so; the status
  updates once the background worker has run it (**Refresh status**).
  **Switch off / on** and **Remove** (with a confirm; the series keeps its
  days) are for owners.
- **Attach a feed** (owners): source, **Into series** (the kinds that source
  may write), an optional series name, the schedule, and either **Grid cells**
  (one "latitude, longitude[, weight]" per line, up to 25; the rainfall is
  their weighted mean) or a **DWS station** code (checked as `A2H012`; only river gauges, H codes).
  CHIRPS also has **Daily product** (*sat: from 1998, with preliminary
  days*, the default, or *rnl: from 1981, final days only*: one product end
  to end, never one spliced onto the other) and an optional **Start date**,
  checked against the product's first day (a sat date before 1998 says to
  choose rnl). The
  form explains a bad cell or code before anything is sent, and a second feed
  for the same series is refused.
- **Attaching to a series that has data.** A feed keeps the values already
  in its series, uploaded or imported ones included, and fills only the days
  without one ([architecture.md § Data feeds](./architecture.md#data-feeds),
  #30), so the series would mix two records. So when the chosen series already
  holds data (read from the project's series list), **Attach feed** first
  asks, inline (`role="alertdialog"`, named and described by its text):
  "“Rainfall — catchment” already has data (1,200 days)", that the values
  already there stay and the records would mix, and a suggested separate
  series name no series or feed of that kind uses ("CHIRPS", "CHIRPS 2",
  "DWS A2H012"). Focus lands on **Use a separate series: CHIRPS**, which
  fills the name and focuses the name field; **Fill its empty days**
  attaches into the existing series; Escape backs out to the name field.
  Changing the series drops the question. Once it runs, the card says how
  many days the last fetch left alone ("· 12 days kept your own values",
  `keptNote` from `last_meta.kept`). When the series holds another CHIRPS
  product or version (or an unrecorded one), filling it would splice two
  records, so the question says so instead ("It holds CHIRPS v2.0, and this
  feed writes CHIRPS sat v3.0 … never splices one onto the other"), and the
  second button is **Replace the series with CHIRPS sat v3.0**: the feed is
  attached with the replacement confirmed (`replaceSeries`), backfills the
  new record from the series' first day in a stage, and swaps it in whole
  when caught up.
- **Keyboard and screen readers**: opening the form focuses **Source**, and
  closing it (Cancel or a successful attach) returns focus to **Attach a
  feed**; a bad cell or code marks its field `aria-invalid`, describes it by
  the message and focuses it; busy buttons are `aria-disabled` so they keep
  focus; after **Remove**, focus goes to the section heading. Messages land
  in a live region that is always in the page. A failed action re-reads the
  list (it was usually changed elsewhere), and a failed refresh keeps the
  list shown.
- When the server reads the synthetic fixtures (`FEED_SOURCE=fixtures`, the
  default in dev and CI), a **Sample data** badge says so, and the cells hint
  names the sample grid's extent.
- Viewers see the list and the health, with no buttons. Tested by
  `e2e/tests/data-feeds.spec.ts` (including axe on the panel with a failing
  feed and the form open).

### API keys

Below Data feeds, for **owners only**, **API keys** (`#set-api-keys`;
`lib/components/apiKeys/ApiKeysPanel.svelte`, its own chunk loaded with the
tab; WP-2.9, [api.md § Ingest](./api.md#ingest)) makes keys a logger gateway
or a script uses to push daily readings into the project's series.

- **Make an API key**: a name, how long it works (until revoked, 90 days, 1
  or 2 years) and what it may write: any series of the project, or only the
  ticked ones (the project's current series).
- **The new key** is shown once, in a highlighted box with **Copy** and the
  warning that it won't be shown again, above a copyable `curl` example that
  pushes one day with a `$WM_INGEST_KEY` placeholder (never the key itself).
- **The list**: each key's name, its `wm_<prefix>_…` (never the secret), its
  state (**Live**, **Expired**, **Revoked**), what it writes, who made it
  and when, when it ends (or "Revoked … by …"), and when it was last used.
  **Revoke** asks first; the key is refused from its next request, and the
  row stays.
- Editors and viewers don't see the panel (the API answers them `403`).
  What a key writes shows in History by `API key “<name>”`.
- Tested by `e2e/tests/api-keys.spec.ts` (make a key, push the fixture with
  `scripts/ingest/push-fixture.mjs`, the series on the Data tab and the key
  in History, a revoked key refused, axe on the panel, no panel for an
  editor) and `apiKeys/apiKeys.test.ts`.

### Scheduled reports

Below Data feeds (and API keys, for an owner), **Scheduled reports** (`#set-report-schedules`;
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
  list. It is sticky, and a long list scrolls inside its panel (at least
  7.5rem tall) so the rail fits the window without clipping. Narrower, the
  rail stacks above the results.
- **Forecast runs** (roadmap WP-2.12, [model.md §2.4f](./model.md#24f-forecast-mode-engine--0370-roadmap-wp-212)).
  When the project has a forecast series (`rain_forecast_mm`, uploaded or
  fed by CHIRPS-GEFS), the run bar has **Run forecast** beside Run model: the
  record as an ordinary run, then the days after the last recorded rain on
  forecast rain, shown apart. The project keeps one forecast run (a new one
  replaces the last unless it is pinned, published or cited). **Run model**
  itself now stops at the last recorded rain, so an ordinary run never
  contains forecast days. A forecast run carries a **Forecast** tag in the
  list and a "Forecast from …" badge in its header linking to its own panel
  (`forecast/ForecastPanel.svelte`, its own chunk, `#res-forecast`, the menu
  entry **Forecast** right after Summary): which days, from how much forecast
  rain after which recorded day; per farm the lowest dam level expected, the
  days short expected and the share of demand supplied, farms short on a
  forecast day first; and the outlet's EWR days at risk, counts only. No
  misleading certainty (the persona rules): every figure is "expected" or
  "about", in whole percent (`forecast/forecast.ts`, which a test holds to
  never saying "will"), under a "Modelled on forecast rain, not measured"
  tag, with a line saying every other figure of the run covers the days
  before the forecast only. Every daily chart of a forecast run (EWR vs
  outflow, the hydrograph, dam storage, supply vs demand, the explorer)
  shades the forecast days with a hatched band and a dashed edge, labelled
  "Forecast" on the plot and in a text key under it (`LineChart`'s `band`
  option), so the band never rests on colour alone; the figure carries
  `data-band-from`. The flow-duration curve has no time axis, so no band.
  The daily CSVs lead with an `F` column and the `.xlsx` sheets with a 1/0
  flag ([api.md § Export](./api.md#export)).
- **On this page.** Above the results, the same menu as Settings &
  calibration (`common/SectionNav.svelte`; the "Result sections"
  navigation) links to each panel (`#res-summary` … `#res-explore`, listed by
  `runs/sections.ts` in groups). Each group's name leads its pills, and each
  group is a list labelled by that name. It sticks under the app header down
  the long results page, marks the section being read, wraps to about two
  rows on a laptop, and on phones is one sideways strip. Farm detail appears
  only when the run has farms, Reserve compliance only with a rule table,
  Runoff model only for a GR4J run, WR2012 check only with a reference, and
  Plausibility checks only on a run made by engine 0.25.0 or later. The
  page's `scroll-padding-top` includes the menu's height, so a jumped-to
  section, or a focused control, clears both the header and the menu.
- **Page order.** The results are grouped by the question they answer
  (`resultGroups` in `runs/sections.ts`; the page repeats each group's name
  as a quiet heading, `RunCharts.svelte`), so the panels that are read
  together sit together:
  1. **Summary**. The run header carries the evidence line and a one-line
     preview of the run's notes (`notesPreview`), each a link to the Record
     group. The summary opens with the run's warnings in two parts
     (`runs/credibility.ts` `warningGroups`): **things to check before relying
     on this run** (a warning box; any warning not known to be a data note
     lands here, so a new engine warning is never hidden), then, collapsed,
     **notes on how the input data were handled** (CHIRPS bias correction,
     rain treated as missing, accumulations spread, zero-rain runs, flat
     stretches). Then one line of **model checks** (`credibility`): the
     self-checks, the plausibility findings, the WR2012 flag and the in-sample
     fit, each in words with a coloured edge and a link to its panel.
  2. **River & Reserve**: Reserve compliance by month (with a rule table),
     EWR vs outflow, EWR by month, and the **Uncertainty bands** (their own
     panel and menu entry, beside the findings they qualify).
  3. **Farms & users**: curtailment (with the other water users and the EWR
     sites tables), farm detail.
  4. **Model quality**: the hydrograph with the flow-duration curve under it
     (compared together on every calibration iteration), calibration (with
     where the parameters came from), runoff model, WR2012 check, EWR vs
     observed, plausibility checks.
  5. **Record**: notes & evidence (with the run's inputs), publication:
     sign-off, after the results.
  6. **Dig deeper**: self-checks (with Trace a day), Explore outputs.

  The menu names the same groups. The bullets below describe each panel; the
  order above is the page's.
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
  (latest, Auto for an automatic run made after new data, Published, Evidence / Former evidence, Pinned, Scenario / Scenario
  base, **Inputs not stored** for a run from before stored inputs, which
  can't be re-run from them, Workbook comparison). Pin and
  ✕ stack in a narrow column beside it. The full period, days, author and
  engine version are in the results header. From 7 runs up
  (`RUN_FILTER_FROM`) a **Filter runs** box above the list keeps the runs
  whose label contains every word typed (any case), with "N of M runs". Its header links to **Compare
  runs** (`/compare?project=<id>`, [run-comparison.md](./run-comparison.md)).
  Viewing an older run, the header offers "go to latest".
  **Which run opens** when the URL names none (`defaultRunId` in
  `runs/runList.ts`): for an editor or owner the newest run, the one they are
  working on; for a viewer the published baseline when there is one (the run
  stakeholders are meant to read), else the newest. An explicit `?run=`
  always wins. Viewing any run other than the published one, the results
  header offers **Compare with published** (`/compare?a=<published>&b=<this
  run>`, [run-comparison.md](./run-comparison.md)).
  The server keeps at most `RUNS_KEPT_PER_PROJECT` runs (default 20); the
  oldest runs it trims (`removedRunIds`) leave the list at once.
- **Pinned runs** (015_run_pinned). Each row has a pin toggle for editors
  (`aria-pressed`, labelled "Pin run <label>"): a pinned run is badged
  **Pinned**, is never pushed out by newer runs, and loses its ✕ until it is
  unpinned. A project holds at most 10 pinned runs; pinning an 11th shows the
  server's `409` reason in the tab's error. Viewers see the badge but no
  toggle. The compare page's run pickers add "· pinned" to a pinned run's
  option (read only), and "· published" to the published one.
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
  The farm table and the **Irrigation supplied** card are means over the
  **whole record**, and say so ("Daily averages over the whole record,
  <first day> to <last day> (N days); the curtailment targets cover the
  reporting window", "over the whole record"), so they can't be mistaken for
  the curtailment table's figures, which cover the reporting window.
- <a id="report-window"></a>**Reporting window** (issue #44;
  `runs/ReportWindowPanel.svelte`, pure helpers in `runs/reportWindow.ts` and
  `runs/windowedCurtailment.ts`). A picker at the top of the curtailment panel
  (`#res-curtailment`) chooses the days the curtailment, other water users and
  EWR sites tables average over: **Project window** (the window the run
  reported over, from the project setting, with its dates in the option; the
  default), **Last 7 / 14 / 30 days** (ending on the run's last day), **Whole
  record**, or **Custom range** (From / To date fields, starting from the days
  shown, cut to the run with a note; a backwards range or one outside the run
  says so and shows the project window). Any window other than the run's own is
  worked out **in the browser** from the run's stored daily series by the
  engine's `prepareCurtailment` / `curtailmentOverWindow` (the recompute the
  farmer projection's season uses, [model.md §2.11](./model.md#211-curtailment-targets-shortfalls)):
  per node its inflow from upstream and outflow; per farm demand, supplied,
  runoff, dam storage, EWR charge and its irrigation part (and the net
  transfer when a transfer rule joins it to another farm); per other user
  demand, supplied, return flow and EWR charge; per EWR site shortfall,
  charged and natural (`curtailmentSeriesKeys` lists them). They are fetched
  once per run the first time another window is picked, and the run is read
  once, so switching between windows is instant. Every column is recomputed,
  the **EWR site setting each farm's charge** included (the engine recomputes
  each day's binding site from the stored flows); only when the transfer rules
  form a loop is that column approximate, and the status line says so. Nothing is re-run and nothing is saved: the project
  setting, the stored run, the downloads and the printable report keep the
  project window, and the status line under the picker says so. A viewer can use
  it (it only reads the run). The choice is `?window=` in the URL (`last7`,
  `last14`, `last30`, `all`, or `YYYY-MM-DD..YYYY-MM-DD`; absent = the project
  window), a history entry of its own, so back / forward step through the
  windows looked at and a reload or a shared link keeps it; it stays as you move
  between runs. Every period is labelled: the curtailment table leads with the
  window's name and dates ("Last 7 days: daily averages over 2022-01-22 –
  2022-01-28 (7 days)", also in its caption), and the other water users and
  EWR sites tables repeat the dates. The status line adds how many of the days
  fall in the forecast period (`RunSummary.forecastRain`). A run saved before
  engine 0.17.0 (no EWR charge series), or missing any series the recompute
  reads, disables the picker and asks for a new run. The engine's
  `views/curtailmentOverWindow.test.ts` checks the table, binding sites
  included, against `runModel` run with the same window as the project
  setting on seeded synthetic runs (and against the stored table over the
  run's own window); `windowedCurtailment.test.ts` checks the panel's wiring
  (the series it fetches, each preset); `e2e/tests/report-window.spec.ts`
  checks whole rows, the binding site included, against a second run in the
  app, the URL, back / forward, and axe in both themes and on a phone.
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
  stream depletion it causes (`RunSummaryView.svelte`). From engine 0.36.0
  (WP-3.9, `HumanImpactTables.svelte`, `runs/groundwater.ts`), **Groundwater
  by water year**: the GN 538 context note (up to 40 000 m³/a per property;
  modelled use only, the app never decides legality), the low-confidence note,
  then per farm or user the mean pumped per year (partial years weighted by
  their days), the most in one year, the annual caps, how many years pumped
  above the GN 538 ceiling (flagged) and how many reached a cap; and per node
  a collapsed table of every water year: days, pumped, into the dam, stream
  depletion and each borehole's volume (of its cap, marked when reached).
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
  charged to farms and the natural part over the reporting window (all three
  tables follow the [reporting window picker](#report-window)); with the
  outlet as the only site it says *EWR assessed at 1 site (outlet). Add gauges
  at the Reserve determination's EWR sites to protect upstream reaches.* The hydrograph (observed flow as a line
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
  PE input, CHIRPS bias correction or zero-rain runs differ from what the fit was made under, or its
  CHIRPS series held another product or version, from the run's `inputSeries`), or "No fit
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
  and (its own panel in the River & Reserve group, beside the findings it qualifies) the **Uncertainty bands** on every run (engine ≥ 0.26.0, issue #4 phase 9,
  [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9);
  `uncertainty/UncertaintyPanel.svelte`, its own chunk loaded when a run is
  shown, `#res-uncertainty`, menu entry **Uncertainty bands**; helpers in
  `uncertainty/bands.ts`). It shows the run's newest stored ensemble: the
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
  coefficient shift (on a GR4J run with a monthly PE row, engine ≥ 0.31.0,
  the shift is 0 and the ensemble's notes say the pan coefficient is not
  varied); **Run ensemble** asks the server to fix the rule and
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
  `runs/evidence.ts`; the menu entry is **Notes & evidence**, one entry for
  the panel): whether the shown
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
  miss a later model switch.
  Below the evidence, **Reproduction** (`runs/ReproducePanel.svelte`, its own
  chunk, helpers in `runs/reproduce.ts`; WP-3.1): for a run with stored
  inputs, **Check reproduction** (viewers too) re-runs it on the server from
  them (`GET …/runs/:runId/reproduce`) and says **Identical** (with the engine
  version), **Differs in N places** (each listed: a summary value, or a
  node's series with its differing days, first date and largest difference;
  an error when the engine is the same version, a warning when it changed),
  **Not reproducible**, or why a stored input can't be used. A run from
  before stored inputs says so instead of offering the check. The
  flow-duration curve with Q10–Q95 (`charts/fdc.ts`; when the observed
  record misses some of the run's days, every curve and the Q table rank only
  the days with a reading by default, `onDaysOf`, so they compare like with
  like, and **Observed days / Whole run** switches; the caption says which
  days each curve ranks),
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
  not met (rows not met shaded). From engine 0.33.0 ([model.md §2.9d](./model.md)),
  a **heat map** of the chosen site: water-year rows × Oct … Sep, each month
  blank when met, light blue with ◐ when only the high flows were short (the
  low flows met; only with a low-flow grid), dark blue with ● when the low
  flows (or, without a low-flow grid, the month) were short, the number the
  simulated flow as % of the requirement, each cell's full reading in its
  title and for screen readers, and a key; with a low-flow grid, a **Low flows
  met** figure, a column in the by-month table and two in Month by month; and
  with high-flow components, a **High flows** table (each component, its
  months, peak, days, per year and "Met in 3 of the 4 water years whose
  natural flow had it") and, collapsed, **High flows year by year** (natural,
  simulated and required events). The daily requirement is the series
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
  storage as % of the capacity the run had, from its model snapshot, not
  today's model, `runDamCapacity`; supply against demand), and an explorer for any
  stored series, grouped by node. The catchment's series include the final
  catchment rainfall, CHIRPS as uploaded and bias-corrected CHIRPS
  (`rain_final`, `rain_chirps`, `rain_chirps_corrected`, engine ≥ 0.10.1)
  and the day's CHIRPS factor (`chirps_factor`), which the catchment daily CSV
  puts in adjacent columns after rain used. The summary CSV lists the 12
  monthly factors.
- **Assurance of supply** (`#res-assurance`, under *Farms & users* after the
  curtailment table; `reliability/AssurancePanel.svelte`, helpers in
  `reliability/reliability.ts`, loaded lazily; engine ≥ 0.32.0, WP-3.4,
  [model.md §2.11a](./model.md)): per farm and other water user over the
  reporting window, the % of demand days fully met, the % of demand
  supplied, water years met against the annual threshold (Settings), the
  failures and their mean and longest length, and the mean and largest
  deficit per failure. Below it the **stress classes by month**: a heat map
  in the EWR grid's pattern (water-year rows × Oct … Sep, arrow keys move
  between cells), for all farms and users together or one of them (a *Show*
  picker), each cell carrying the class name (Low, Mod, High, Sev, Crit) so
  colour is never the only cue, with a legend of the ranges and a count of
  months per class.
- **Water account** (`#res-water-account`, last under *River & Reserve*;
  `reliability/WaterAccountPanel.svelte`, lazy; [model.md §2.11b](./model.md)):
  two bars for the chosen period (*Period*: the whole run or a water year),
  what came in and where it went or was stored, each with a labelled key;
  then a table of every term per water year and the whole run (terms a
  network doesn't have are left out), the change in dam storage and the
  residual (to two significant figures, float noise), and the EWR required
  vs met at each site. Runs before engine 0.32.0 show *Not computed by
  engine x.y* in both panels.
- Series are fetched one at a time when a chart needs them, and cached
  (`runs/cache.ts`). A run stores well over a hundred series of one value per day of the run
  on a multi-farm catchment (more since engine 0.12.0: each farm adds 11 working columns).
  Large arrays live in `$state.raw` and are replaced, never mutated.
- **Report**, beside the Download menu in the run header, opens the shown
  run's printable report (§ Report below).

## Scenarios (`?tab=scenarios`)

Issue #18 stage D, WP-3.2 ([scenarios.md](./scenarios.md)):
`lib/components/scenarios/`, a lazy tab after Runs & results. A scenario is a
named list of changes (ops) on a base run, run and compared without copying
the project. Viewers read every scenario and its comparison; farmers never
see the tab (the workspace sends them to the farm page, and the API refuses
them scenarios).

- **The list** (left on wide screens, above the scenario under 900px): each
  scenario's name, status, number of changes, base run and last run. Empty:
  "No scenarios yet. A scenario changes the published baseline without
  copying it." **New scenario** (editors): a name and a base run, the
  published run by default, else the latest; scenario runs aren't offered (a
  scenario run can't be a base). With no runs it says to run the model
  first. The chosen scenario is `&scenario=<id>` in the URL.
- **The banner**: "Based on run *X* (run date, published)", and that the base
  is kept while the scenario exists.
- **Changes** (`OpList.svelte`): the ops in order, each in words against the
  input it meets, so a second change to one value shows the first one's
  value as "was" (`ops.ts` `describeOp`, `stepInputs` over the base run's
  model and settings snapshot from `GET …/runs/:runId`). Each carries its
  class, **Proposal** or **Baseline assumption**, from the server's check,
  and when it doesn't apply to the base, "Doesn't apply: …" with the
  engine's reason (ids named). Any baseline op puts the red **Baseline
  assumptions changed** callout above the list. When any op doesn't apply,
  a warning says so and **Run scenario** is disabled (the server refuses the
  run with `422` too).
- **Add a change** (`OpForm.svelte`, editors, drafts only): one form for every
  op of the engine's `ScenarioOp` union: change a node's value, add a node
  (a leaf farm or other water user), remove a node, set a farm's crop area,
  add a crop (optionally starting from another crop's factors), add, change
  or remove a transfer, add or remove land cover, change a setting, scale
  rainfall by a % change over a date range. A setting's value is typed as
  the Settings tab takes it; GR4J's PE input (`pe`, issue #39) has its own
  control, the source (pan coefficient × A-pan, or a monthly row in mm with
  a required source note), checked with the Settings tab's own rules
  (`settings/peInput.ts`), and a new monthly row starts from the PE GR4J
  runs on now. Targets come from the model as
  the listed ops leave it, so a node the scenario adds can be changed next.
  A field starts at its current value with "Now: …" under it; percentages
  are typed as %, areas in ha. The op is built and checked with the engine's
  own validator (`ops.ts` `buildOp`, `validateScenarioOps`), so a bad value is
  refused in the form in the units typed ("Must be at most 100 %"); whether
  it applies to the base is the server's check, shown once it is saved.
  Every edit is a `PATCH` of the whole op list, answered with the check.
  **Undo** steps back through this visit's edits; each op also has a ✕.
- **Edit in the model tables** (override mode, drafts only, for whoever may
  change the scenario: an editor on a team scenario, only its owner on an
  application; an applicant edits the applicant projection, with a note that
  other farms' values are blank;
  `OverrideEditor.svelte`, loaded when opened): the Network, Crops and
  Transfers tables, switched with a **Network / Crops / Transfers** control,
  on the scenario's model (its base run with its changes applied), under a
  banner in the warning colour: "Editing the scenario *X*, not the
  catchment", saying the catchment's own model isn't touched, with **Close
  override mode**. Notes, farmer links, the yield panel and "Colour farms
  by" are left out (they belong to the live model). **Edits to record**
  (sticky at the foot on wide screens) lists each edit as the change it will
  be, in the same words as the Changes list; **Record N changes** appends
  them (one Undo takes them back), **Discard edits** reverts. An edit no
  change can express (a crop's factors, a node's kind or what it drains
  into…) is listed there and disables Record until it is undone; the
  tables' own problems ("Fix before saving") block it too. While there are
  unrecorded edits the Changes list's ✕, Undo, Run, the status moves and
  Delete wait, and leaving the page asks first. The status moves (an
  application's Submit, Withdraw, Reopen and decision included) also wait
  while a run is in flight: the run re-reads the scenario when it ends, and
  that read could otherwise land after a submit and show the old status. The "Add a change" form and rebase are hidden while
  override mode is open.
- **The proposer's nodes**: a checkbox per node of the base. Changes to them
  (and to nodes the scenario adds) are proposals; the rest are baseline
  assumptions ([scenarios.md § Classification](./scenarios.md#classification-proposal-or-baseline-assumption)).
- **Actions** (editors): **Run scenario** (labelled with the scenario's name;
  the run joins the runs list and counts toward the 20-run cap), the status
  moves (**Submit** behind a confirm, **Withdraw**, **Mark decided**, **Back
  to draft**; only a draft's changes, nodes and base change), **Delete
  scenario** (draft or withdrawn; its runs stay as ordinary runs), and
  **Rename** (name and description).
- **Rebase onto another run** (drafts): pick a newer run of the model,
  **Check** (a dry run listing any change that no longer applies, for
  example a node removed since), then **Rebase onto this run**. A change on
  a node the new base lacks is still named, after a reload too: the server
  keeps the names each change needed with the scenario (`opNames`, 047).
  Only a node no base ever named reads "a node the base run doesn't have".
- **Scenario against its base** (`ScenarioCompare.svelte`): the latest run of
  the scenario against the base run *that run* was made on (so an older run
  of a rebased scenario is still compared with its own base), through
  `GET /compare/runs`: headline results, the farms table and the per-node
  daily overlay (the compare page's `CompareOverlay` and `overlay.ts`, issue
  #8), with **Open the full comparison**. A note says when the changes were
  edited since that run.
- **Runs tab.** A scenario's run is tagged **Scenario**; a run a scenario is
  based on is tagged **Scenario base** and has no ✕ (it is cited: kept, no
  delete or unpin, `RunMeta.citedBy`). The runs list reloads after a
  scenario is created, rebased or deleted, so the tag follows.
- **Compare page.** When either side is a scenario run, a **Scenario
  overrides** section above "What changed" lists that run's ops as it
  recorded them, with their classes and the callout (`ScenarioOverrides.svelte`,
  its own chunk).

## Allocations (`?tab=allocations`)

WP-3.10 first slice (`lib/components/allocations/`, a lazy tab;
[allocations.md](./allocations.md)). A core tab: owners, editors and viewers
see it; farmers never reach the workspace.

- **Modelled use vs registered volume** (`AllocationCompare.svelte`), on top:
  a run picker (the published run by default, else the latest), a sentence
  saying modelled use is *modelled, not metered* and a difference is
  something to look into, not a finding; a warning listing the farms and
  sources whose modelled use was above the registered volume, with how many
  whole water years; notes for allocations not matched to a farm, or matched
  to a farm the run doesn't have. The table has one row per farm, source and
  water year: registered m³, modelled use m³ ("modelled, not metered" under
  the heading), modelled ÷ registered, and a status badge (*Above
  registered*, *Within band*, *Below registered*, *No registered volume*, *No
  use, none registered*; the full sentence in its title). A part year is
  marked "part (N d)". A source with neither use nor a volume is left out.
  On a phone each row is a card of label–value lines.
- **Registered volumes**: the list (farm, registration, the registered user
  for editors only, authorisation, purpose, source, volume, storage, validity,
  and where it came from: the file name and the first 12 hex digits of its
  SHA-256, or "Entered by hand"). Unmatched rows are highlighted. **Download
  CSV** (the export, names for editors only). Editors: **Add a volume**, and
  **Change** / **Delete** per row (the form's farm picker is how a row is
  matched by hand). Viewers see "Names of registered users are shown to
  editors only." Below the list, **Imported files**: each with its full hash,
  reference, row count, who and when, and **Remove this import**.
- **Import registered volumes** (`AllocationImport.svelte`, editors): what
  the file is (WARMS extract or CSV template), a reference, the file, and a
  **Download the CSV template** link. The preview says how many rows matched,
  didn't, or have problems; the table lists rows with problems first (the
  problem in red), then unmatched rows, each with a farm picker ("by farm
  name", "chosen by you"). **Import N rows** stores the valid ones; the
  message says how many were imported, left out and still unmatched. Errors
  (a refused file, a file already imported) show in an alert.
- e2e: `e2e/tests/allocations.spec.ts` (import, manual match, comparison, a
  viewer without names, phone cards, axe).

## Applications (WP-3.3)

A **contributor** (a licence applicant or their consultant; the Members
panel calls the role "Applicant") never sees the workspace's tabs, which the
API refuses them. `/projects/:id` shows them the **Applicant view**
(`lib/components/scenarios/ApplicantView.svelte`, a lazy chunk; the page
detects the role from the project list after the `403`, as it does for a
farmer): an "Applicant view" badge, the published baseline (its date, and
that other farms show only by an anonymous name), links to their own farms'
farm view if they have links, and the Scenarios tab in applicant mode
("Your applications"; `?scenario=<id>` selects one):

- **New application**: a name only; it starts on the current publication's
  run. With nothing published, a note says so and there is no form.
- **The editor** is the Scenarios editor, with the base from
  `GET …/scenarios/:sid/base` (other farms as "Farm 1", "Farm 2", their
  values blank, so an op on one isn't described "from" a value). Their own
  farms are the proposer's nodes, set by the server (no checkbox list); no
  rebase. **Run scenario** runs it; instead of the comparison, a note says
  the assessors compare each run with the baseline (an applicant view of
  results is a follow-up).
- **The Application panel** (`ApplicationPanel.svelte`) under the changes:
  where it stands ("Draft: only you and the people you share it with can see
  it", "Submitted: the assessors can see it, and its changes are frozen", …),
  the owner's **Submit to the assessors** (confirmed; disabled while a change
  doesn't apply), **Withdraw** and **Reopen as a draft**, the decision once
  made (outcome, by whom, when, the reasons), and **Shared with**: the
  people who read it, Remove / Leave, and for the owner a **Share with**
  picker of the people they may share it with (`…/share-candidates`: an
  applicant's own applying party; no address box, so it says nothing about
  who else is a member). With nobody to pick it says why ("Nobody to share
  it with yet: the project owner lists who is in your party", or "Everyone
  you can share it with already reads it"). An assessor opening an
  application whose names displaced a hidden farm's or crop's sees which
  ("… in this application's runs Kliphuis is called “Kliphuis (2)”",
  `check.renamed`), and likewise a new item given the id of one the
  applicant can't see (`check.reIds`, "their transfer … is …-2"); the
  applicant never does.

The assessors (owners and editors) get an **Applications** tab
(`?tab=applications`): every submitted, withdrawn or decided application
(drafts stay with the applicant), as a table of name (a link to it in the
Scenarios tab), applicant (and how many they shared it with), status
("Awaiting a decision", or the outcome), submitted date, changes and runs,
sortable newest first or by status (awaiting a decision first, the
longest-waiting on top; `applications.ts`), with loading, error ("Retry")
and empty ("No applications submitted.") states. In the Scenarios tab an
application shows an "Application" tag and "… application by <name>" in the
list; only its owner edits it, and an editor who isn't its owner gets the
**Decide** form (outcome radios, reasons and conditions, **Record the
decision**; final). Evidence packs (WP-3.14) will be linked from the list.

e2e: `e2e/tests/applications.spec.ts` (the applicant's flow to submission,
the assessor's decision, the empty list, axe in light and dark).

## History (`?tab=history`)

WP-2.4 (`lib/components/history/`, a lazy tab). A timeline of model and
settings revisions and audit events, grouped by the viewer's day, with a
request's change set folded into one entry; filters by farm, event kind and
parameter. Each revision shows its change lines, and for editors a
**Restore this version** button behind a confirm that previews the diff;
restore buttons are disabled while there are unsaved model edits, and a
restored farm lists the farmers to re-link. Viewers read it; farmers never
see the tab. Empty: "No changes recorded yet. History starts from {date}."

- The **save bar** and the Settings save row have an optional "Reason for
  this change", kept with the revision.
- **Runs**: a collapsible "Changes since this run" and **Restore these
  inputs** (not for a scenario run).
- A small "history" affordance on individual fields is not built
  (followups.md).

## Notes

WP-2.7 (`lib/components/notes/`; [api.md § Notes](./api.md#notes)). Knowledge
that lives in people's heads ("dam raised in 2019 per owner", "logger moved in
March") is kept against what it is about.

- **Where.** A notes button with a count badge opens a dialog of the notes on
  one target (`NotesDrawer.svelte` around `NotesList.svelte`):
  - on each **Network** node row, beside its name (icon and number; only on a
    node the server has, not one added since the last save:
    `ModelEditor.savedNodeIds`);
  - in a run's **Record** group, under the run's own written explanation
    (the run notes stay the modeller's one explanation; these are comments
    from anyone on the team);
  - in the head of each **Settings** group (Demand, Flow calibration, Rain
    gaps, Calibration record, Flow share, EWR, Simulation period, Data
    quality), keyed by group (`SETTING_NOTE_GROUPS` in `notes.ts`);
  - on the **Overview**: *Recent notes*, the newest 8 across the project,
    each naming and linking to its target, and the project-level notes
    button.
  One `GET /notes/counts` per project feeds every badge
  (`counts.svelte.ts`), refreshed after any change. Only the open project's
  counts are kept: opening another project drops them (coming back loads
  them again), and signing out forgets them.
- **Writing.** Every member can add a note; the author edits theirs (marked
  *edited*); the author or an editor deletes (a confirm, then a soft delete:
  hidden from everyone, kept for the audit trail). On a farm, *Also show to
  this farm's farmers* makes a note farm-visible, marked *Shown to the farm*;
  everything else is read by the project team only.
- **Farmer view.** *Notes about your farm* (`farm/FarmNotes.svelte`) lists
  the farmer's own notes and the WUA's farm-visible ones on that farm, and
  adds a note, always shown to the farm. The WUA previewing the page sees the
  same farm-visible notes, read only.
- **Plain text only.** The body is rendered with Svelte's escaping, never
  `{@html}` or markdown; line breaks are kept with `white-space: pre-line`
  (the e2e test pins markup showing as typed).

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
  each input series' dates and days inside the run; `report/inputs.ts`.
  A GR4J run adds a **GR4J potential evaporation** row, "pan coefficient ×
  A-pan" or the monthly total and source, engine ≥ 0.31.0; under a monthly
  PE the monthly table shows **GR4J monthly PE (mm)** in place of the pan
  coefficient),
  **Calibration** (the calibration panel with the annual water balance, where
  the parameters came from, the hydrograph over the whole run),
  **Shortfalls and curtailment**, **EWR compliance** (EWR vs outflow, Reserve
  compliance for every rule-table site with Month by month open, the EWR grid
  for the outlet and every farm), **Farms, warnings and checks** (the run
  summary: warnings, headline cards, the farm table; the self-checks and the
  water balance by water year, without Trace a day) and **Notes** (the run's
  notes, when it has any). A section appears only when the run has its data;
  nothing is printed as a placeholder. Every report then closes with three
  sections (WP-3.13, `components/liability/`):
  - **Validation statement** (`ValidationStatement.svelte`, the engine's
    `validationStatement`, [model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313)):
    engine version, the build's invariant and soak results (*Not recorded
    for this build* until CI injects them), the run's self-checks, the
    runoff coefficient (flagged above 1, audit W1), a legacy-model warning,
    NSE / PBIAS / KGE / log-NSE with Moriasi ratings and the monthly-flows
    caveat, the flagged data-quality years and checks, and the **known
    limitations** table (ID, limitation, where it stands) generated from
    engine-audit.md.
  - **Professional sign-off** (`SignoffSection.svelte`): each sign-off
    (signer, self-declared registration, date, scope, the statement version
    and a 12-digit prefix of its SHA-256 with the full hash as the title,
    the disclaimer version), or **Not signed off.** in bold; then the five
    statements a signer confirms. An editor or owner gets **Sign off this
    run…** (screen only); a legacy run says why it can't be signed; a viewer
    sees neither. Loaded with the report (`GET …/signoffs`), so
    `data-report-ready` waits for it and the server-side PDF prints it.
  - **Disclaimer** (`Disclaimer.svelte`, engine `DISCLAIMER`): the draft
    wording with a bold *Draft wording, pending the client's legal review
    (decision D10)* line and its version, until the wording is agreed.

  Not yet: the published-by line and restriction notice (WP-2.3), changes
  since the previous publication (WP-2.4).
- **Sign-off dialog** (`SignoffDialog.svelte`, its own chunk, loaded when
  opened): the five statements, each ticked on its own; the known
  limitations in a focusable scroll box (keyboard-scrollable, a labelled
  region) that must be scrolled to its end (a list too short to scroll counts
  as read), with a polite live line saying whether the end was reached; the
  notes (registration self-declared, dam safety classification by others,
  this run only); full name, registration body (SACNASP by default),
  registration number and what the sign-off covers. **Sign off** stays
  disabled, described by the list of what's missing, until everything is
  done (`signoffForm.ts` `signoffBlockers`). It sends back the statement's
  hash; a `409` (the statement changed) shows the error and reloads the
  statement, which clears the ticks and the read state. The Runs tab tags a
  signed run **Signed off**, and the History tab reads "Signed off a run as
  … (SACNASP …)".
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
- **Frame.** The farm pages have their own header ("My farm", the EN | AF
  language switch, Menu: your farms, the words, "Don't keep a copy on this
  phone", sign out); the app header isn't shown ([§ Language](#language)). One 560 px column, a 16 px base, 44 px targets,
  nothing under 13 px, existing tokens only, light and dark.
- **Main page, top to bottom:** the name and the dates line ("Published by
  the WUA on …. Data up to …", amber with its age when stale); the WUA's
  notice first (warning or danger fill, icon and level in words), or "No
  restriction from the WUA"; water received this season with the ML/m³
  switch (saved to the account, `app_user.volume_unit`, and kept on the
  phone for the saved copy); the dam
  (hidden without one) with the days-left line, or the no-stop-level
  wording; "Looking back", the model's card (dashed, neutral "Model: …"
  chip, never the notice's fills), a single link line under a `restricted`
  notice; the last 12 months (inline SVG bars at the rendered width, a
  summary sentence and a full table behind "Show the numbers"); last
  season; the farm on the river (counts, the outlet's last 30 days, the
  privacy sentence and "Who can see my farm", which loads the people by name
  and role when first opened, `GET …/access`, and falls back to the roles
  alone if that fails); "Notes about your farm" ([§ Notes](#notes)); the
  CSV download and the disclaimer. **Next 14 days** (WP-2.12, `farm/ForecastCard.svelte`,
  wording in `farm/forecastCard.ts`) comes after "Looking back" only when
  the WUA published a forecast run: a "Forecast" kicker and a dashed edge
  set it apart from the cards about what happened; "Lowest dam level
  expected: about 38 % around 20 Jan" (no dam, no line), "You may be short
  on 3 of the 14 days" (or that the model doesn't expect a short day), and
  the forecast's own dates with "Forecasts change, and this is worked out
  by the model, not a promise. Only a notice from your WUA is a
  restriction." A forecast made more than 3 days ago says how old it is
  first. The dam page shows the same card under its chart.
- **Wording.** Every visible string comes from the message catalogue
  ([§ Language](#language)); the number rules and the sentences built from
  them live in pure modules under `lib/components/farm/` (`format.ts`,
  `cards.ts`, `why.ts`, `dam.ts`, `chart.ts`, `forecastCard.ts`), pinned to
  the prototype with a Vaalbank fixture (`fixture.ts`); a test keeps the
  design's "never says" words out.
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

## Language

English and Afrikaans for everything a farmer touches (WP-2.5): the farm
view (`/farm/**`), the sign-in pages (`/login`, `/register`,
`/forgot-password`, `/reset-password`, `/verify-email`), the "confirm your
email" banner, the account page and its alert emails page
(`/account/alerts`), the unsubscribe page (`/alerts/unsubscribe`), and the
emails a farmer receives (confirm address, reset password, the farmer
invite, the alert emails and their digest). The modeller workspace and the
`/share` page stay English.

- **Switch.** `lib/i18n/LanguageSwitch.svelte`, "English | Afrikaans" (each
  name in its own language, the button marked with that `lang`, `aria-pressed`
  on the current one; "EN | AF" in the phone headers, the full name as the
  accessible name). It sits above the sign-in forms (`AuthCard`), in the farm
  pages' header, and under **Language and units** on the account page, which
  also sets the farm view's volume unit (m³ or ML).
- **Which language.** The account's `locale` when signed in and chosen, else
  this device's choice (`localStorage` `wm.locale`, try/catch), else
  Afrikaans when it is the browser's first language, else English
  (`resolveLocale`, run by the root layout whenever the session changes).
  Choosing applies at once, is kept on the device and, signed in, saved with
  `PATCH /auth/me { locale }` ([api.md § Auth](./api.md#auth)). Signing up
  sends the page's language as the account's; an account created from an
  invite takes the invite's (`invite.locale`, 050).
- **Catalogue.** `lib/i18n/messages/en.ts` is every string, flat keys
  (`farm.supply.title`), with a section note per key group and per-key notes
  for the translator. `messages/af.ts` holds only **reviewed** Afrikaans,
  typed `Partial<Record<MessageKey, string>>` (an unknown key fails
  `pnpm check`); it is loaded lazily, the first time someone picks
  Afrikaans. A key without Afrikaans shows in English.
- **Loading.** Only the translated routes load the catalogue: they import
  it themselves, and the root layout imports `lib/i18n/locale.svelte` with a
  dynamic `import()` on the first translated route, then renders the route
  once the language is set (a readiness flag, with Try again if the chunk
  fails), so no route shows one language and then another. The workspace
  and `/share` never download it: the number, date, notice and chart-size
  rules they share with the farm view live in catalogue-free modules
  (`lib/i18n/state.svelte.ts`, `farm/numbers.ts`, `farm/notice.ts`,
  `farm/chartGeometry.ts`), `passwordProblem` returns a key, and the
  "confirm your email" banner is imported only for an unconfirmed address.
  `lib/i18n/boundary.test.ts` guards it.
- **API** (`lib/i18n/locale.svelte.ts`): `t(key, vars)` fills `{name}`;
  `tn(stem, n, vars, ordinal?)` picks the `.one` / `.other` (or ordinal
  `.two` / `.few`) form through `Intl.PluralRules`; `tRich(key, vars)`
  returns a `Rich` sentence where `**…**` and `{ b }` values are bold
  (`lib/i18n/Rich.svelte` renders it); `joinAnd(items)`; `setLocale(l)`;
  `i18n.locale` (the choice); `wordsLang()` (the language the words are in).
  They read runes, so a template that calls them re-renders on a switch.
  The backend's emails have their own catalogue, `backend/src/mail/i18n/`
  (`mailT(locale)` → `{ t, lang }`), same pattern; the alert emails'
  words are there too (`mail.alert.*`, WP-2.13), and so are the dates in
  them, in the language the words came out in.
- **`lang`.** `<html lang>` is `wordsLang()` on the translated routes and
  `en` elsewhere: it stays `en` until the Afrikaans catalogue is complete, so
  a page of mostly English words never claims to be Afrikaans. An email is
  `lang="af"` only when every word in it came from the Afrikaans catalogue.
  A glossary entry on `/farm/words` shown in the other language carries its
  own `lang`.
- **Numbers and dates** (D8). The farm view writes a decimal comma in
  Afrikaans at once ("84,9 ML"), with no-break spaces between thousands in
  both languages. Dates follow the words' language (`en-ZA`, and `af-ZA` once
  the Afrikaans words are in), so an English sentence never carries Afrikaans
  month names.
- **Translation.** Nothing is invented: the wording goes to real farmers.
  `docs/i18n/af-translation-sheet.md` (generated by `pnpm gen:i18n:sheet`)
  lists every untranslated string with its English, context and placeholders,
  and an empty Afrikaans column for the client's translator; the farmer
  glossary entries are on it too (`lib/help/content.af.ts`, stamped with a
  `sourceHash` of the English so a later English edit makes the translation
  stale). `catalogue.test.ts` (frontend and backend) and
  `content.af.test.ts` fail when an untranslated key is missing from the
  sheet; `pnpm check:i18n` fails when the sheet is out of date.

## Alerts

Email alerts (WP-2.13; [api.md § Alerts](./api.md#alerts), [security.md §
Alerts](./security.md#alerts)). The workspace's words are in
`lib/components/alerts/alerts.ts` (English, no message catalogue: the
workspace never loads it), the translated pages' in `alerts/words.ts` (from
the catalogue, [§ Language](#language)); both unit-tested.

- **Overview → Active alerts** (`alerts/AlertsPanel.svelte`, under Needs
  attention): the alerts firing now, each as a sentence ("Farm One: dam
  about 8 % on 20 Sep 2026 (alert below 30 %)", "EWR at the outlet at risk
  on 5 of 14 forecast days (alert at 3)", the late or failing feeds), or "No
  alert is firing". An editor gets **Set up alert emails**, which loads the
  rule editor (`alerts/AlertRulesEditor.svelte`, its own chunk, fetched on
  the click): a checkbox per catchment kind (EWR at risk in the forecast,
  data feed behind, restriction notice, background jobs failed, data feed
  failing) and per farm dam, each with its level (dam % of capacity, days,
  failures or jobs; range-checked in the form and by the API), a *Firing*
  mark, and Save. It says that nothing is sent until a kind is switched on,
  and that each alert is sent once per crossing.
- **`/account/alerts`** (linked from the account page's **Alert emails**
  panel and from every alert email; translated): per catchment you can open,
  a group per alert you can get, with *Right away* / *Once a day (06:00)* /
  *Off* radios (44 px rows). A farmer sees a *Dam running low: <farm>* group
  per own farm and *Restriction notices from the WUA*, nothing else; a viewer
  also the opt-in kinds (dam alerts for every farm, the EWR forecast);
  editors and owners the operational kinds. A choice saves when made
  ("Saved."), and the page says when the catchment hasn't switched that
  alert on yet. A catchment muted by a digest's unsubscribe says so, with
  *Turn alert emails back on*. It notes the daily cap (5 right away, the rest
  in the next morning's summary).
- **`/alerts/unsubscribe`** (an alert email's *Stop these emails* link;
  signed in or out, on the sign-in pages' `AuthCard`; translated): reads the
  token from the fragment (`#t=…`) once, strips it from the address bar,
  and **asks first**: *Stop getting these alert emails? …* with *Stop these
  emails*. Only the click posts the token (so a mail scanner that opens the
  link can't switch a farmer's alerts off). Then "You won't get dam level
  emails for Rietvlei any more." (or "any alert emails", for a digest's link)
  with *Manage alerts*. A dead link ("This link doesn't work any more: a
  newer email may have replaced it, or you may no longer be a member") and a
  link without its token have their own states. The page sets
  `no-referrer`, like the reset pages.
- **Farm view**: while the farm's own dam alert fires, an **Alerts** card
  under the WUA's notice (`farm/FarmAlerts.svelte`): "Your dam is below the
  alert level of 30 %: about 8 % on 20 Sep 2026" (or, on the forecast, "may
  fall below … around …"), with *Choose your alert emails*. Nothing shows
  otherwise, or when the alerts can't be loaded.
- **Portfolio**: an **Alerts** column (and card row): "None" or "2 firing"
  (a warning badge), from `alertsFiring`.

## Share page (`/share`)

What a read-only share link opens (WP-2.3 phase 2; [api.md §
Share](./api.md#share), [security.md § Share links](./security.md#share-links)),
signed in or out, for someone outside the project, on a phone first.

- **The token** is in the fragment (`/share#t=…`). The page reads it once,
  strips it from the address bar (`replaceState`, as the reset pages strip
  `?token=`), and POSTs it to `/share/view`; a link pasted into the same tab
  (only the fragment changes) is picked up the same way. The page sets
  `noindex, nofollow` and `no-referrer`, and has its own header ("Water
  Management · Shared view"), not the app's; it is a route chunk of its own,
  loaded only when opened.
- **Top to bottom:** the catchment's name; "Published by *name* on *date*.
  Data up to *date*." (and the next expected update); the WUA's notice
  (the farmer view's `NoticeCard`: warning or danger fill, or "No
  restriction from the WUA"), in English, or in Afrikaans when the browser
  prefers it and the WUA wrote one (marked `lang="af"`); **The river's
  ecological reserve**: the outlet (unnamed, it may be a farm) and each
  gauge, with a check or warning icon, the last 30 days and the season in
  words; the **monthly flow chart** (mean flow at the outlet, solid, against
  the reserve, dashed, over the last 24 months; inline SVG at the rendered
  width, a summary sentence and a table behind "Show the numbers"), only
  when the series come back, otherwise a line saying that with so few farms
  the flows could reveal a farm's use; and **About this page** with the
  farm count and the model disclaimer.
- **States:** loading; a dead link ("This link has expired or was
  withdrawn. Ask whoever sent it for a new one.") for every `404`; a link
  without its token ("This page needs the whole link…"); and an error with
  Try again. Every string is in `lib/components/share/share.ts`, the chart
  in `share/chart.ts`, the loading rules in `share/load.ts`, all
  unit-tested.

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
  width. No rule is disabled: a violation is fixed in the app. Each test
  scans one page state, through the shared `e2e/support/a11y.ts` scan (see
  e2e/README.md for why it runs axe in legacy mode).
- Every workspace tab (desktop and phone) and a GR4J run are also held to two
  of axe's best-practice rules the WCAG tags leave out: `empty-table-header`
  (a corner header above a column of row headers carries a visually hidden
  name, such as "Curve" or "Flow record"; `lib/a11y/tableHeaders.test.ts`
  refuses an empty `<th>` in any component) and `landmark-unique` (a tab's
  top panel is not a second region with the tab's own name).
- **Sideways-scrolling boxes** (every `.table-wrap`, and anything marked
  `data-scroll-region`, such as the schematic) become a focusable, named
  group while their content overflows, so Tab reaches them and the arrow keys
  scroll them (WCAG 2.1.1). One watcher does this app-wide
  (`lib/a11y/scrollRegions.ts`, started by the root layout); a box names
  itself with `data-scroll-label`, or takes its table caption or section name.
- Row move buttons are 24 × 24 px (WCAG 2.2 target size, 2.5.8).
- `html { scroll-padding-top }` keeps focused controls and in-page link targets
  clear of the sticky header (WCAG 2.4.11).
