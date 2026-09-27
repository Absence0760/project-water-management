# UI playbook

How screens are designed and built in this app: the process, the layout
rules, the pieces to reuse, and the testing traps. It collects what the
option A redesign (issue #17) learned the hard way. Each rule here cost at
least one round of "that doesn't look right". Read it before building or
reviewing any screen; the `ui-designer` agent (`.claude/agents/ui-designer.md`,
`/polish-ui`) works from it.

[ui.md](../ui.md) describes what each screen *is*; this file is about *how*
to make and change them. When you learn something new, add it here, in the
section it belongs to, with the example that taught it.

## 1. Process

1. **Start from a picture, not a description.** Work from the design board
   when there is one, otherwise from the nearest finished page (§ 4). Read
   the board's markup, not a summary of it. Building from issue text took
   the Network four passes.
   Boards for option A (a private canvas; ask the operator for access):
   `Main` = A1 Summary, `ANetwork` = A2, `ACrops` = A3, `AScenarios` = A4.
2. **Screenshot the result before calling it done**, at **1440×960**,
   **1280×800** and **390×844**, in light *and* dark, and compare it with
   the board or the sibling page. Measure, don't eyeball: where content
   starts, blank space at the bottom, whether the page scrolls, how much of
   each card its content fills, whether there is exactly one page title.
   How: a throwaway `e2e/tests/zz-shot.spec.ts` that seeds data through
   `e2e/support/api.ts` and calls `page.screenshot({ path })`; run it with
   `pnpm -C e2e e2e tests/zz-shot.spec.ts > shot.log 2>&1`, look at the PNGs,
   delete the spec with `command rm -f` (plain `rm` prompts). Never commit
   it. This is the sanctioned exception to CLAUDE.md's "don't spin up the
   dev server": it runs against the e2e build.
3. **Check with realistic and large data**, not the 3-node seed. Real
   catchments have 9+ crops, 10–40 units, several dams, long names and
   multi-year runs. The 12-unit demo exposed clipping and label collisions
   the seed hid; a 9-crop catchment showed the crop cards pushing every
   result off the first screen (§ 3). Seed a big case (≈30 items) in the
   spec for anything that lists things.
4. **Nothing lost.** A redesign moves things; it never drops them. List
   every control, figure, link and note on the old screen and find each a
   home on the new one. River & reserve first shipped without the EWR
   chart's m³/day switch and Earlier/Later buttons because it reused a
   simpler chart; that is a bug, not a simplification.
5. **Old links keep working.** `?tab=` values, overlay params and `#res-…`
   fragments are in emails, bookmarks, help and other pages. When a view
   moves, redirect its old URL (the Runs tab redirects moved `#res-…`
   anchors to River & reserve and Units & supply; the Summary sends its
   panels' heading ids, `#members-h` and the rest, to the Project page) and
   grep the app, the help guides, `docs/` and `backend/src/alerts` for links
   to repoint. Grep the prose too: "on the Summary tab" in History's
   restore notes and the team pages' empty states pointed at panels that
   had moved.
6. **One piece, one push**, with its tests and docs, and say exactly which
   tests ran (CI is off while Actions billing is paused).

## 2. Layout rules

- **One page per section, no layout switches.** Map / Table / One node made
  the Network jump between three designs. Details open *from* the page:
  a whole grid → the grid modal (`grid=<id>`); one item's full form → a side
  sheet (`edit=<id>`, `crop=<id>`, `settings=1`); a quick in-context edit →
  a drawer (`farm=<id>`); a picked item on the page → a param (`dam=`,
  `unit=`, `node=`).
- **The section header is the only page title.** Every workspace section
  gets `workspace/SectionHeader` from the page: the title (`TAB_LABELS`) as
  the `h1`, a one-line context, and on the right the rain pill, the
  section's own actions, **Add data** and **Run model**. A tab adds its
  context and actions with `$effect(() => fillHeader({ context, actions }))`
  (`workspace/headerSlot.svelte.ts`); it never draws its own title (Dams
  briefly had two). A section whose main action replaces Run model passes
  it as `main`, rendered last after a plain Add data: Runs & results' run
  form (label, Run forecast, Run model) went there from a full-width panel
  that pushed the results 110 px down, its status one slim line under the
  header. Notices (viewer, new data, upload result) are one slim
  line under it. The same frame shows with no data.
- **Dashboards fit the window; reading pages scroll.** A dashboard (Summary,
  Network, Crops, Dams, River & reserve, Units & supply, the portfolio) is
  exactly the height left below its top edge: measure the top and whatever
  sits below with a `ResizeObserver` on `body`, then
  `height: max(<floor>px, calc(100vh - top - below))`, only above a size
  where it makes sense (~1100×620). The page doesn't scroll; long lists
  scroll *inside their card*. Add the fitted class to the page's
  `.page:has(…)` rule in `routes/projects/[id]/+page.svelte`, which swaps
  its 4rem bottom padding for a 1rem gutter: Applications fitted its card to
  the window yet the page still scrolled 42 px until it was listed there. Help, guides and account pages scroll normally
  with a readable text column (~75ch).
- **A sticky rail on a reading page fits from where it starts.** Runs &
  results scrolls (its results are long), with the runs list in a sticky
  rail beside them. `max-height: calc(100vh - top-offset)` only fits once
  the rail is stuck: at the top of the page it started 110 px down and ran
  88 px off the bottom of a 1440×960 window. Measure the grid's own top
  (not the sticky element's, which reads its stuck offset) and use
  `max(stickyTop, gridTop - scrollY)` as the offset (`runs-page.spec.ts`
  checks both). At the very end of the page a sticky rail rises with its
  grid's bottom edge; test the fit mid-page. Stacked on a phone, cap the
  list (20rem, scrolling inside) so twenty runs don't push the results
  a screen down.
- **Cards or list on one side, the picked item's detail on the other.** Dams
  and Units & supply: a scrolling column of items (worst first), the picked
  item's chart filling the rest, the pick in the URL so Back works. When
  the items are genuinely tabular (Data: last date, period, % missing,
  coverage, per-row actions), keep the table and stack it over the chart
  instead: the table capped at a share of the fitted height (55 %) with its
  rows scrolling in `.table-wrap`, the chart filling the rest. Ten specs
  leaned on the Data table's rows; cards would have lost the columns and
  broken them for nothing.
- **Design for N.** Assume 30 crops, 40 units, 10 dams, 20 runs and names
  three times longer than the seed's. A card per item works for a handful;
  past that use a compact row list that scrolls inside its column, so the
  results stay on the first screen. Don't give a 0.2 ha crop the same space
  as a 363 ha one: sort by what matters (area, shortfall, % full).
- **Container queries, not viewport media queries**, for anything inside
  the app frame: the sidebar takes 240 px, so the viewport lies about the
  space. Name the container (`container: dams-page / inline-size`).
  The root font size is **14 px** (`app.css`), so `1rem` in a query is
  14 px: Transfers' first `70rem` breakpoint matched a 1016 px column it was
  meant to miss. Work the pixels out at 14 px. **A container query never
  styles the container itself**: Scenarios first named its grid the
  container and set that grid's columns in the query, and the page stayed
  one column at 1440. Put the container on a wrapper.
- **A sticky rail beside a reading page.** When the picked item is a page
  to read or edit (Scenarios), not a chart to fit, the list is a sticky
  rail as tall as the window from where it starts, its rows scrolling
  inside it, while the detail scrolls with the page. Measure the top on a
  non-sticky ancestor: a stuck element's `getBoundingClientRect()` is where
  it is stuck, so measuring the rail itself grew its top with the scroll
  and shrank it to a sliver.
- **Pick a default rather than show an empty half.** With nothing in the
  URL, open the first item and write it with `replaceState`, so Back leaves
  the section instead of stopping on the bare list (Scenarios; Dams and
  Units & supply show a default without writing it).
- **Fit a wide table by stacking, not by scrolling sideways.** Transfers at
  1280 hid Priority, On and Remove off the right edge. Stacking From over To
  in one cell, letting the number headers wrap, and a short "On" header made
  every column fit; side by side only where the container is wide enough.
- **Lay drawings out to their box; don't zoom text.** Scaling the Network
  drawing made labels huge; spacing columns and rows to the box, with a cap,
  looked right.
- **One legend line.** Tips go into a help tip (`help/HelpTip.svelte`) or
  live status text, not a paragraph under the chart.
- **Defaults that answer the question:** the map colours by supply as soon
  as there is a run; outcome pages default to the latest run; the range
  switch starts at 1 year.
- **Sidebar and phone.** The app sidebar is full height from 900 px
  (`layout/AppShell.svelte`); pages put their own navigation in its slot
  (`layout/sidebar.svelte.ts`, `fillSidebar`) and only one copy of a nav is
  rendered at a time. Below 900 px a slim bar with a Menu; every layout
  stacks to one column with no sideways scroll, sheets go full screen. Keep
  the sidebar short enough to fit a 960 px-high window: with the 15 sections
  an owner saw it measured 1033 px until the rows went to 34 px, the section
  gaps to 0.75rem and the role badge onto the "Catchment" line (73 px spare;
  the Project entry then took one row, leaving room for one more). Below that height the slot scrolls on its own
  (`flex: 0 1 auto` with an 8rem floor, `overflow-y: auto`) so the account block
  never leaves the screen; `app-sidebar.spec.ts` pins both. A new sidebar
  entry re-runs that spec.

## 3. Colour, wording, content

- **Colours are tokens** in `frontend/src/app.css` with dark-theme values
  (`--series-*`, `--accent`, `--warning`…); no raw hex in components.
- **No two named things share a colour.** A palette runs out: give colours
  to the items that matter most (largest area, most demand) and group the
  tail as one labelled "Other" that names its members. The Crops page's
  6-colour palette gave five crops the same grey.
- **Don't fade a row to mean "off".** Transfers dimmed a disabled rule
  with `opacity: 0.6` and axe failed its text on contrast (no scan had a
  disabled rule until the page got one). Tint the row and say **off** in
  words beside its number.
- **Categorical colour: the Crops & demand pattern.** Use it for anything
  shown as one colour per item (crops, units, runs, scenarios, sources):
  - **The palette** is the ordered token set `--series-1`, `-2`, `-3`, `-5`,
    `-6`, `-7`, `-8`, `-9`, `-10` in `app.css` (9 colours, each with a dark
    value; `--series-4` is skipped because it's `LineChart`'s own violet).
    Neighbouring pairs were checked for colour-blind separation in both
    themes (weakest ΔE ≈ 9 colour-blind, ≈ 19 normal) and every colour is
    ≥ 3:1 on the dark surface. Take them **in this order**; don't pick
    favourites or add hex.
  - **Rank first, then colour.** Sort the items by the measure that matters
    and is known early (crops: planted area, not demand, which is zero
    until A-pan is set), stably, and give the first nine their own colour.
    Everything after that is **Other**, in `--text-muted`, which no named
    item uses.
  - **One colouring everywhere.** Compute it once and use the same map for
    the list, the stacked chart, the bars and the grid in the modal, so an
    item is the same colour on every view.
  - **Stack in palette order**, so neighbouring segments are the validated
    neighbouring pairs.
  - **Other is a labelled row** naming its members ("Other: Crop 10, Crop
    11…", clamped to two lines, "21 smaller crops share one colour"); each
    member's own row gets a hatched swatch and "in Other", not a grey that
    looks like a colour.
  - **The colour is never the only cue:** names sit beside swatches, the key
    is pinned under the bars, segments name themselves on hover ("Crop:
    12 ha") and each bar has an accessible name listing its parts. Three
    light-theme colours (aqua, yellow, pink) are under 3:1 on white, which
    is acceptable only because the name, key and table carry the same
    information.
  - **Reference implementation:** `crops/cards.ts` (`rankCrops`,
    `cropColouring`, `CROP_PALETTE`, `otherLabel`) and `crops/demand.ts`
    (`cropStacks` taking the named list). Reuse it; on the third caller,
    lift it into a shared helper (CLAUDE.md), e.g. `lib/format/palette.ts`.
  - **Test it:** a unit test that the top N get distinct colours, the tail
    is Other and the ranking is stable, and an e2e case with ≈30 items
    that reads the swatches' computed colours and asserts no two named
    items match (`e2e/tests/crops-page.spec.ts`).
- **Ordered and banded colour is different.** Good-to-bad values (supply,
  % full, the reserve) use the band colours (`network/farmColour.ts`,
  `overview/supplyBars.ts`), never the categorical palette; one-directional
  amounts (irrigated area) use one hue in steps.
- **Say what a colour means in words too** (a band label, "below 70%"), and
  name a segment on hover and focus: colour alone fails colour-blind users
  and axe.
- **Wording:** the modeller workspace says **unit** for a farm node (#54);
  the farmer view, API and CSV say farm. Farmer-facing pages (farm view,
  sign-in, account, alerts, `/share`) go through `t()` (ui.md § Language):
  changing their English invalidates the Afrikaans.
- **Honest numbers:** a figure on an outcome page comes from the same helper
  as the same figure elsewhere (Units & supply's irrigation supplied comes
  from `overview/latestRun.ts`, the per-year reserve days from the engine's
  `ewr_shortfall`), so two pages never disagree. The same holds for a
  status: Data's rows turned amber past 31 days on any series while the
  sidebar badge counted driver series past 7, so "1 behind" sat beside five
  amber rows. Now the rows, the panel head and the badge all read
  `freshness().behind`.

## 4. Pieces to reuse

| Need | Use |
|---|---|
| Page title, context, actions | `workspace/SectionHeader.svelte` via `fillHeader` |
| Sidebar content for a page | `layout/sidebar.svelte.ts` `fillSidebar` |
| Overlays in the URL | `lib/workspace/overlays.ts`: `withParam`, `withoutParam`, `overlayHref`, `GRIDS` / `GRID_TAB` (a new grid is one entry plus a branch in `model/GridModal.svelte`) |
| Modals and sheets | `common/Dialog.svelte`: `full` (+ `keepInputs`), `side` (+ `wide`, body scrolls, actions pinned), `subhead` slot for what must not scroll |
| Saving from a modal | `model/ModelSaveRow.svelte` (a modal hides the save bar) |
| Grids inside a modal | the existing component unchanged (`CropsTab sections` → `CropGrids`, `NetworkTab only="table"`), never a fork |
| Time-series charts | `charts/LineChart.svelte` (`windows` for 30 days / 1 year / All; Earlier/Later; units switch where the old chart had one) |
| Flow vs reserve with shaded days | `overview/FlowVsReserve.svelte`, `overview/summaryChart.ts` |
| Supply colour bands | `network/farmColour.ts`, `overview/supplyBars.ts` |
| One colour per item (categorical) | `crops/cards.ts` `rankCrops` + `cropColouring` + `CROP_PALETTE` (§ 3) |
| Dam levels | `overview/damLevels.ts` (level, bands, capacity-weighted total, which dams are in a run) |
| Status pills and bars | `portfolio/StatusPill.svelte`, `portfolio/StatusBar.svelte` |
| Lazy panels | `common/Lazy.svelte`, `common/lazy.ts` |

Finished pages to copy from: `dams/DamsTab.svelte` (cards + chart, window
fit), `supply/SupplyTab.svelte` and `river/RiverTab.svelte` (tiles, run
picker in the header, moved panels, anchor redirects),
`compare/CompareView.svelte` (several runs side by side),
`network/NetworkTab.svelte` (map page, Grids menu, node sheet),
`routes/teams/[id]/portfolio/+page.svelte` (a table that fills the window
with a sticky header), `series/SeriesTab.svelte` (a table over a chart,
window fit, the pick in the URL), `scenarios/ApplicationsTab.svelte` (a
queue: counts in the header, a status filter in the URL, rows that turn into
cards in a narrow column).

Interaction details that bit:

- **Close a `<details>` menu through the element** (`el.open = false`), not
  bound state: `toggle` is async, and Escape right after opening was ignored
  in 4 of 6 runs.
- **A sticky element inside a scroll container covers controls** as they
  scroll, and axe fails the covered ones (target size). Put a picker in the
  Dialog `subhead` instead.
- **Closing an overlay drops its param with `replaceState`**, so Back
  closes the overlay rather than leaving the page. A create dialog
  (Scenarios' `new=1`) that navigates on success lets the URL close it: drop
  the param in the same `goto` that picks the new item (with
  `replaceState`), rather than setting its `open` to false first, which
  starts a second `goto` that races the first.
- **Svelte drops the space at the edge of an element.** A narrow-layout
  label `<span class="cell-label"> change</span>` after a number read "1change"
  (and so did its accessible text) on the Applications phone cards. Write
  the space as `{' '}` inside the span.
- **Move a page's main actions to where they're seen.** Scenarios' Run sat
  under the changes, the form and a checkbox per node, off the first screen
  on a big network; it now sits in the scenario's head row. A section's
  "new" action goes in the section header (or at the top of the list where
  there is no header, as in the Applicant view), never under the list,
  where thirty items pushed it 2,700 px down.
- **A fragment into a lazy tab needs the tab to land it.** Workspace tabs
  are lazy chunks, so the browser's own jump to `#set-ewr` runs before the
  element exists and the page opens at the top. Settings' note links
  (`?tab=settings#set-…`) had silently done that until its page spec
  followed one; the tab now finds the element on mount and holds it with
  `holdAnchor` (`help/anchor.ts`), focusing its heading, as River & reserve,
  Units & supply, Runs and Project do. Test a fragment link by *loading* it,
  not only by clicking the in-page menu.
- **A reading page's header says what the page decides.** A long form has
  no count to show; Settings & calibration's context line says where the
  runoff parameters came from (the fit's day and score, "changed since the
  fit", or no fit record) and its action jumps to the fit. Find the one fact
  a user opens the page to check, and put it there.
- **Width rules for a field's inputs catch its checkbox.** Settings'
  `.field input { width: 100% }` stretched "Vary it by month"'s box across
  the field, with the words half a field away. Scope such rules with
  `input:not([type='checkbox'])`.
- **Bring a linked item into view inside its list, after the fit is measured.**
  Allocations' `unit=` link names a row far down a list that scrolls in its
  card. `scrollIntoView({ block: 'nearest' })` on mount did nothing: the
  block's height still used top 0 (the whole window), so the row was already
  "in view" and the list shrank under it once the top was measured; with
  `block: 'center'` it scrolled the page as well. Wait until the block fits
  at its measured top, then set the list's own `scrollTop` from the two
  bounding boxes; the spec asserts the row is in the viewport and
  `window.scrollY` is 0.
- **A tab that copies a list from the page must take the page's updates.**
  Data kept its own copy of the series (`untrack(() => initial)`), so a file
  added through the header's Add data didn't show until a reload. Sync from
  the prop when it changes to an array that isn't the tab's own.

## 5. Testing

- Every new page gets its own spec with a11y scans at desktop and phone
  (`e2e/support/a11y.ts`), and a helper module in `e2e/support/<section>.ts`
  (see `network.ts`, `crops.ts`, `river.ts`, `supply.ts`, `teams.ts`, `data.ts`,
  `scenarios.ts`, `allocations.ts`).
- **Pin screen use in e2e:** no page scroll, the layout reaches the window's
  bottom within a few px, the key content is inside the viewport at
  1440×960, lists scroll inside their card (see `network-map.spec.ts`,
  `portfolio.spec.ts`, `dams-page.spec.ts`, `data-page.spec.ts`).
- **Modals make the page inert, but Playwright still sees it.** Scope
  locators to the dialog and close it before touching the page; duplicate
  names across page and modal cause strict-mode errors.
- **Find things by their exact name.** "Runs" also matched "Compare runs";
  a card repeating a change's text caused duplicate matches in Compare.
  But a badge is part of a link's name: once Data's sidebar link read "Data
  (1 series behind)", two specs waiting for `{ name: 'Data', exact: true }`
  timed out. Match the badge (`/^Data \(\d+ series behind\)$/`) or use
  `/^Data/`.
- **A click on a row lands in its middle**, which may be a control that
  rightly ignores row picking (the CHIRPS row header holds its version
  select). Click the row's text instead.
- **Times the database stamps can't be set through the API.** "Waiting 30
  days" needs an application submitted 30 days ago, but the scenario trigger
  stamps `submitted_at` with `now()` and refuses to change it. Plant it in
  `e2e/support/db.ts` (`backdateApplication` turns triggers off for its one
  transaction), as `plantLegacyRun` does for old runs; never loosen the
  assertion to "waiting".
- **Run the neighbours**, not only the spec for the screen: `a11y`,
  `golden-path`, `section-header`, `tabs-by-role`, `overview` and whatever
  links into the screen. `--repeat-each 5 --retries 0` on every new
  interaction catches races.
- Never pipe e2e output into `grep`/`head`; redirect to a file.

## 6. Bundle

- Make each new view a lazy chunk. The guard
  (`scripts/guards/check_web_bundle_budget.mjs`) counts lazy chunks in the
  total, so splitting code moves weight but also adds overhead.
- Inside a tab, split only what some visits never render (a panel behind a
  condition, a dialog, a chart shared with another tab). A panel the tab
  always renders belongs in the tab's chunk: workspace tabs (the page's
  `LOAD` map) have their own ceiling, 60 KB, apart from the 42 KB one for
  pages, routes and shared chunks.
- Every ceiling change gets a dated change-log entry with the measured
  numbers and what grew. Never raise the page ceiling to fit a page; move
  code out of the workspace page chunk instead.
