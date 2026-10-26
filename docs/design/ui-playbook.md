# UI playbook

How screens are designed and built in this app: the process, the layout
rules, the pieces to reuse, and the testing traps. It collects what the
option A redesign (issue #17) learned the hard way. Each rule here cost at
least one round of "that doesn't look right". Read it before building or
reviewing any screen; the `ui-designer` agent (`.claude/agents/design/ui-designer.md`,
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
   catchments have many crops, many units, several dams, long names and
   multi-year runs. A demo with many units exposed clipping and label
   collisions the seed hid; a catchment with many crops showed the crop cards
   pushing every result off the first screen (§ 3). Seed a big case (≈30 items) in the
   spec for anything that lists things.
4. **Nothing lost.** A redesign moves things; it never drops them. List
   every control, figure, link and note on the old screen and find each a
   home on the new one. River & reserve first shipped without the EWR
   chart's m³/day switch and Earlier/Later buttons because it reused a
   simpler chart; that is a bug, not a simplification.
5. **Old links keep working.** `?tab=` values, overlay params and `#res-…`
   fragments are in emails, bookmarks, help and other pages. When a view
   moves, redirect its old URL (a moved `#anchor` is one row of
   `ANCHOR_MOVES`, `lib/nav/anchorMoves.ts`: the Runs tab's `#res-…` to EWR
   and Hydrological units, Settings' `#set-feeds` and the rest to Data and
   Project, each keeping the parameters the row names, and the page lands
   through `lib/nav/anchorLanding.ts` `followAnchors`, on load and on a hash
   change; the Summary sends its panels' heading ids, `#members-h` and the
   rest, to the Project page) and
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
  section's own actions, **Add data** and **Run model** (editors; the
  primary action). A tab adds its
  context and actions with `$effect(() => fillHeader({ context, actions }))`
  (`workspace/headerSlot.svelte.ts`), and a status pill of its own beside
  the rain pill as `status` (the Summary's **Setup complete**); it never
  draws its own title (Dams
  briefly had two). A view that is also a standalone page draws its title
  only there: Compare runs showed "Compare runs" twice in the workspace
  (the header's `h1` and its own `h2`, 65 px) until it filled the header
  with its context and actions when inside a tab and kept its own `h1`
  only on `/compare`. A section with a main action of its own passes
  it as `main`, rendered last after a plain Add data in place of the page's
  Run model button: Runs & results' run form (label, Run forecast, Run model) went there from a full-width panel
  that pushed the results 110 px down, its status one slim line under the
  header. Elsewhere Run model (`workspace/RunButton.svelte`, issue #444)
  opens a small form so the run can still be named. A popover in the header
  must close on navigation as well as on Escape and a click outside: the
  header stays mounted across sections, so a form whose status line links
  to the Network sat over the Network once followed (`afterNavigate`).
  RunButton copies the Setup complete pill's `fit()` nudge; a third
  popover should extract it rather than copy it again. Notices (viewer, new data, upload result) are one slim
  line under it. The same frame shows with no data.
- **Dashboards fit the window; reading pages scroll.** A dashboard (Network,
  Crops, the Projects list) is
  exactly the height left below its top edge: measure the top and whatever
  sits below with a `ResizeObserver` on `body`, then
  `height: max(<floor>px, calc(100vh - top - below))`, only above a size
  where it makes sense (~1100×620). The page doesn't scroll; long lists
  scroll *inside their card*. Size to the page's 1rem gutter
  (`calc(100vh - top - var(--dock-h, 0px) - 1rem)`). Help, guides and
  account pages scroll normally with a readable text column (~75ch).
  **Measure the top, not what is below.** The Network map and Crops & demand
  took "below" as `scrollHeight − bottom`, but the page's scroll height is
  never less than the window, so any height that left the page short measured
  itself as right: shrunk on a phone, the map kept that height at 1440
  (`diagram-labels.spec.ts` resizes 390 → 1440 and checks it refills).
  Subtract the gutter and `--dock-h`, which are known.
- **Don't chart what restates the inputs.** The Transfers page's "When water
  moves" strip summed each enabled rule's month rate × 86 400 across unrelated
  routes: the same numbers as the rate fields one card up, added into a total
  that describes nothing physical, and an upper bound that looked like a
  result. It was removed (2026-09-29). Before drawing a chart, name the user
  and the decision it serves, and check it shows something the inputs beside
  it don't.
- **A page's first row is its own answer, not a digest of other tabs.**
  The Project page opened with eight "The model" tiles, each repeating the
  context line of the tab it links to, above the details and the team the
  page is for. They moved to a panel at the foot of the left column
  (2026-09-29, issue #176), still in the page's flow rather than behind a
  disclosure: a fixed set of eight facts isn't a long list to fold, and the
  Summary's old `#model-h` link still lands on them without opening
  anything.
- **Don't fit a first screen that has more below it.** The Summary was a
  fitted first screen (KPIs, reserve strip, Needs attention beside Supply by
  unit) with the alerts, published baseline, links and setup checklist
  underneath. At 1440×960 the fitted block ended at the window's foot, the
  two cards scrolled inside themselves, and it looked like the whole page:
  users missed everything below it, with no cue it existed (2026-09-29).
  A fitted block whose cards scroll inside themselves reads as the end of
  the page, so a page whose main content continues below should not fit:
  let it flow with the window's one scroll, bound a long list by showing the worst few with a
  **Show all N** button (`aria-expanded`) that opens the rest in place (the
  Summary's Supply by unit shows eight), and
  let the next card's top edge show inside the window
  (`overview.spec.ts` checks no Summary card scrolls and the alerts' heading is
  inside 1440×960 with thirty units). The Dams page had copied the same fit
  (cards scrolling in their column, Dam levels under the fold) and flows now
  too: every dam's card beside a fixed 420 px chart, the chart panel
  `position: sticky` so it stays beside the list as the window scrolls
  (`dams-page.spec.ts` checks no element on the page scrolls vertically
  inside itself, wide and phone). The Dams page first folded to three cards under **Show all
  N dams**, which at 1440×960 left the lower third of the window empty
  beside the chart; the sticky chart already keeps a long list readable, so
  every card shows (2026-09-29). Two disclosures on one page need different names: while the Dams
  page had a Dam levels table under its cards (until issue #175 merged it
  into them), the table's button was **Show all N rows**.
- **Finished work leaves the page; its detail opens over it.** The Summary's
  setup checklist, once every step was done, was a one-line `<details>` at
  the page's foot that grew the page by 125 px when opened, on a page that
  otherwise fitted 1440 × 960. It is now a **Setup complete** pill in the
  section header whose popover lists the steps (`overview/SetupPill.svelte`,
  the rain pill's pattern: a button with `aria-expanded`, Escape returns
  focus, a click outside closes, nudged to stay inside the window), so
  opening it never changes the page's height; while a step still needs
  work, the checklist stays on the page, where it has to be seen.
- **No reserved room below a page; no pointless scroll.** `.page` keeps a
  1rem gutter under its content, and the workspace adds the model save
  bar's height (`--dock-h`) only while the bar shows. Don't pad a page
  "for breathing room": the old 5rem (4rem in the workspace) made every page
  within 56–70 px of the window's foot scroll for nothing (an empty
  project's Data tab by 3 px, a small one's History by 52 px at 1280×800),
  and each fitted page had to be listed in a `.page:has(…)` override to
  escape it (Applications scrolled 42 px until it was). Something fixed
  at the foot is the owner's to make room for, and only while it shows.
  `no-pointless-scroll.spec.ts` checks every tab and app page scrolls no
  further than its content plus the gutter, and that the save bar clears
  the last row on a fitted page and a long one.
- **A reading page that fits the window doesn't scroll.** Help's sticky
  contents column was as tall as the window minus 2rem, and the page's (then 5rem)
  bottom padding sat under it, so search with nothing typed and an unknown
  guide scrolled 60 px at 1280×800. A sticky column starts and sticks at the
  page's top gutter and ends as far from the bottom
  (`max-height: calc(100vh - 2 × gutter)`); the end-of-page reading space goes
  on the text column (`help-pages.spec.ts` checks the page and the column).
- **A reading page spans its column; the measure is on the text.** Help's
  guides and glossary sat in a 42rem article with the "On this page" rail
  beside it, leaving 200–350 px empty at 1440 (issue #162). A 44rem measure
  on the text then left half the column empty beside full-width figures
  (operator, 2026-09-30), so the text takes the column too, bounded by the
  Help layout's 1480 px; pin a side rail to the column's right edge.
- **Navigation groups are headings, not items; a menu doesn't change as you
  scroll.** A group name styled like its links reads as one of them; make
  it a heading with its links indented under a rule. A contents list that
  grew a nested list of the terms on screen (three levels, moving while you
  read) was replaced by one page per topic and search (issue #162).
- **A sticky side menu fits the window by showing less, not by scrolling.**
  Help's contents listed all four groups' 30 pages, ~1180 px, in a sticky
  column capped at the window's height, so it scrolled inside itself at
  1440×960 and 1280×800: a second scrollbar beside the page's, with the
  lower groups out of sight. Show one group's pages at a time (the heading a
  disclosure button, the current page's group open by itself, opening one
  closes the rest) so the column's tallest state fits the smallest supported
  window; keep `overflow-y: auto` only as the fallback for a window shorter
  than that, never a scrollbar that hides links (`help.spec.ts`).
- **Position the box that scrolls.** A list that scrolls inside its card
  must be `position: relative` (or otherwise positioned) when anything
  inside it is absolutely positioned. The Projects list fitted its card to
  the window yet the page still scrolled 1,200 px with fifty projects: each
  group's visually hidden `<caption>` (`position: absolute`) had no
  positioned ancestor inside the scroller, so it sat at its static place far
  down the list, outside the clip, and the measured "space below" fed the
  overflow back into the fit. Test the fit with the big case, not the seed.
  The same in a dialog: Load crop factors' two columns scroll inside a full
  dialog that clips, and each crop card's visually hidden "to <crop>" (in its
  Apply tick) sat at its static place under thirty cards, so the `<dialog>`
  measured 1,116 px of hidden overflow; positioning the columns fixed it
  (`crop-library.spec.ts` checks the dialog's `scrollHeight`).
- **A dialog that changes many things shows the effect beside the choices.**
  Load crop factors stacked source, Kp, a match table, a diff table per
  crop and the demand difference in one 720 px column, with Apply at the
  foot: with thirty crops a crop's match was 1,500 px from its diff and the
  demand 3,000 px down. It is now a full dialog in numbered steps: the
  choices in a scrolling left column, one card per item holding its choice
  and its change together, the effect (headline tiles, then the detail) in
  its own column beside them, and a one-line summary in the action row, so
  a phone, where the columns stack, still sees the answer beside Apply.
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
- **Cards or list on one side, the picked item's detail on the other.**
  Dams and Hydrological units: a sticky chart beside the cards, the pick in
  the URL so Back works. Dams shows every card, worst first; Hydrological
  units shows the worst few (three), **Show all N** opening the rest in
  place, and its folded list keeps the picked item's card in view
  (`common/fold.ts` `foldList`, which Data, Hydrological units and
  Allocations share), so a shared `unit=` link shows its card. Both were fitted to the window with
  the cards scrolling in their column until 2026-09-29; with 40 units the
  column scrolled 8,000 px inside a 690 px box. **Under an "On this page"
  menu, stick below it:** the menu is itself sticky, so a chart at
  `top: 0.75rem` slid under it and lost its heading. Hydrological units
  measures the menu (`--nav-h`, a `ResizeObserver` on `nav.sections`, rerun
  once the menu renders) and sticks at `--header-h + --nav-h`. **A sticky
  table header needs a box that doesn't scroll:** `.table-wrap` is
  `overflow: auto` in both axes, so once uncapped its `thead` sticks to
  nothing; where the table fits the column (Hydrological unit results from
  64rem) set the wrap `overflow: visible` and the head's `top` under the menu,
  and leave the sideways scroll below that (`supply-page.spec.ts`). When
  the items are genuinely tabular (Data: last date, period, % missing,
  coverage, per-row actions), keep the table and stack it over the chart
  instead: the table capped at a share of the fitted height (55 %) with its
  rows scrolling in `.table-wrap`, the chart filling the rest. Ten specs
  leaned on the Data table's rows; cards would have lost the columns and
  broken them for nothing.
- **A picked item's own panel goes in its detail, not under the list.** The
  Dams page's "Proposed from the register and the map" is about one dam, yet
  it was a full-width panel under every card: with nine dams the cards ran
  to 2,446 px beside a chart that ended at 715, so the box opened under
  1,700 px of empty column, away from the dam it was about, and with no
  `dam=` it even showed another unit than the chart (operator, 2026-10-13).
  It is now part of the picked dam's chart panel, under the assurance, and
  its picker follows the page's pick and moves it (`dam=`), keeping in the
  picker only what the pick can't name (a unit with no dam yet). A sticky
  detail has a height budget, so what joins it folds to one line of its
  values (`common/Fold.svelte`; the plot gives up that line's height), and a
  sticky panel that can grow past the window (the fold opened) sticks by its
  foot, `top: min(<stuck top>, 100vh − <its height> − 1rem)` from its
  measured height, so every row can be read with nothing scrolling inside it
  (`dams-page.spec.ts` "nine dams"). Moving a table into a narrower column,
  recheck its wrapping: `overflow-wrap: anywhere` let "synthetic" break as
  "synthet|ic" in a 680 px column; use `break-word` with column minimums.
- **Design for N.** Assume 30 crops, 40 units, 10 dams, 20 runs and names
  three times longer than the seed's. A farmer linked to 30 farms in one
  catchment (or WUA staff previewing, who see them all) got 30 switcher
  chips above the farm's name, pushing the notice 1,600 px down on a phone;
  past 4 they now fold into a `<details>`. A card per item works for a handful;
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
- **When the narrow layout shows different content, pick the layout in
  script.** History's rows beside a detail become whole entries on a phone
  (each with its own restore buttons, since a detail stacked under fifty rows
  is out of reach). Rendering both and hiding one with a container query
  would put every restore button in the DOM twice: duplicate names for
  strict locators and axe. Measure the column (`bind:clientWidth`) and
  render one or the other; keep container queries for restyling the same
  markup.
- **One empty state per page, not one per region.** Runs & results with no
  runs showed the rail's "No runs yet" card and, beside it (under it on a
  phone), a large centred "Results appear here after a run…" card: two boxes
  saying one thing, the second a screen of dead space on a phone. The Runs
  card is now the page's one empty state, across its width with no results
  column, its first line the old message (specs and help quote it) and a
  second line saying what a run's results hold.
- **A picker rail with one item is a row, not a rail.** With one run, Runs &
  results' 250 px sticky rail held one row beside an empty column down the
  whole page, and nothing to pick (#586 D21). One run now makes the Runs card
  one slim row across the top (heading, the run's row with its tags, pin and
  delete, the tags' key), restyled with the same markup (`.single`), and the
  results take the whole width; the second run brings the rail back. A grid
  that auto-fills then gains columns: the Summary's six cards went 4 + 2
  beside an empty half row until their minimum became a third of the row
  (`runs-page.spec.ts` checks 3 + 3).
- **Pick a default rather than show an empty half.** With nothing in the
  URL, open the first item and write it with goto's `replace`, so Back leaves
  the section instead of stopping on the bare list (Scenarios; Dams and
  Hydrological units show a default without writing it). Don't start that
  write while a navigation is in flight (`navigating.to`) or while the URL
  already asks for something else (an overlay's param): the newest
  navigation wins, so a default pick that fires as its list lands can
  cancel the click the user made a few ms earlier (a `+ New scenario` click
  lost its dialog this way in CI, #171).
- **A short form starts on a fixed line; don't centre it in the height.**
  The sign-in pages centred their form, so the title sat anywhere from 230
  to 433 px down at 1440×960 depending on the page, and a wrong password's
  message moved the whole form (and the button under the cursor) by half its
  height. Starting the form on the brand copy's top line put the title in
  one place on every page and state (`auth-pages.spec.ts` checks it).
- **Fit a wide table by stacking, not by scrolling sideways.** Transfers at
  1280 hid Priority, On and Remove off the right edge. Stacking From over To
  in one cell, letting the number headers wrap, and a short "On" header made
  every column fit; side by side only where the container is wide enough.
  Wrapping headings is not always enough: the run's water balance (thirteen
  columns of figures beside two rails at 1440) went from 1,230 px to 861 px
  in a 695 px column once its headings wrapped, because the longest words
  ("Consumptive", "evaporation") and its float-noise residuals ("1.75e-10")
  set the widths. Two natural pairs then shared a column, one over the other
  (each year's rain over its runoff coefficient, the balance's residual over
  the runoff model's), the cells took a dense table's padding and the unit
  column the wording rule's short "Unit runoff": it fits at 1440 and 1280. A
  variant that can never fit (twenty-one columns with every optional term)
  scrolls inside its box with the row header `position: sticky; left: 0`, so
  every row stays named (`runs-page.spec.ts`).
  On a phone a wide edit grid becomes one card per row (the crop grids, the
  node table): restyle the same markup, so the inputs, names and tests stay
  one set, and give each field a visible label that names its group, since
  the group header row is gone ("Dam capacity", not "Capacity"). Let the
  cards scroll with the modal: `.table-wrap`'s 70vh cap made the node cards
  a scroll box inside a scroll box, with Add node out of reach below it.
  A read-only table does the same: the Dams page's "Proposed from the
  register and the map" (Value, Saved now, Proposed, Source, Use) needs
  549 px as columns, so at 390 it scrolled sideways inside its 323 px box
  while the page passed `expectNoSidewaysScroll` (which skips a box that
  holds its own overflow; check the box's `scrollWidth` too). Below its
  width (a container query on a wrapper, `40rem`) each row is a block: the
  row header on top, Saved now and Proposed side by side, then Source and
  Use across, each value under its `data-label` (YearTable's pattern), the
  Use a 44 px target. Reset the cells with `table.data td`, not a bare
  `td`: app.css's `table.data td` padding and rule outrank a scoped `td`
  (`dam-proposals.spec.ts`). Land cover's tables fit as columns; the
  evaporation table's twelve months keep their sideways scroll with the
  sticky row label (a variant that can never fit).
- **In a narrow column, a row's actions get their own line.** The team
  page's Members panel (a 20–24rem side column) had Name · Role · actions,
  and the third column clipped "Reset two-step" to "Reset two-" and
  "Remove" to "Rem" at 1440, with the email breaking at "example." / "com"
  (issue #520). Each row is now a grid of two lines (the name and email
  beside a fixed-width role column, then the actions spanning both), the
  table roles kept explicitly since the rows aren't `display: table-row`, the
  actions' header visually hidden without a grid cell, and no actions line on
  a row without actions. Widening the column only moves the clip to 1280 and
  the phone. Pin it with the buttons' boxes inside the panel's
  (`teams.spec.ts`). A long email in such a cell goes through `EmailText`
  with `breakAfter`, whose name and domain are inline blocks: the browser
  breaks after any hyphen on its own, and only inline blocks (or `nowrap`)
  stop it, while an inline block still wraps inside itself when it alone is
  wider than the line.
- **A row that holds a form of its own is a card, not a table row.**
  Transfers stayed a table after that fix, and its Takes from cell grew a
  river off-take's six fields in one column: that row stood ~330 px tall with
  every other cell floating in its middle, Daily cap and Priority were wide
  columns holding one short field each, and the six-to-a-row month fields
  clipped 0.0129 to "0.012". Each rule became a card (2026-09-29): a head
  line (number, From → To, an On/Off switch with its state in words, a
  labelled Remove) over top-aligned groups (rates, limits, source), the
  conditional fields two to a row, the groups side by side by the card's
  width (`@container rule`). Size number fields for real values (0.0129,
  12.345) and check them with `scrollWidth <= clientWidth` in e2e.
- **A card per row costs height; measure a long list against the table it
  replaced.** The first Transfers cards were 225 px a rule against the
  table's 120, so thirty rules scrolled twice as far: a head line across the
  top, a title line per group and a summary line under the months, each
  repeated thirty times, where the table said them once in its header.
  Where the card is wide the head became a column on the card's left, level
  with the rates, the summary moved onto the rates' title line, and the
  Limits and Source titles went (dividers mark the groups and each field
  names itself): 147 px at 1440. `transfers-page.spec.ts` caps the height
  of a rule with thirty on the page.
- **Two pages showing the same rows are one page with a filter.** The team
  portfolio listed a team's catchments with the same figures, from the same
  helpers, as the project list's rows; it added two columns and three tiles.
  It became the list's team chip (issue #176): the two columns joined the
  list, the tiles' counts its header line (the stacked bar only repeated
  them), the page's one note (the thresholds) a line under the chips while a
  team is picked, and the old address a redirect that keeps its sort. Before
  adding a column, work out the name column's width at 1440 with the sidebar:
  seven fixed columns left it 227 px only after every other column gave
  10 px, and the restriction went under the dam rather than into a column of
  its own (it is a published-run fact beside the dam, and "Not published" in
  both said the same thing twice).
- **Table headings wrap in a fixed-width column.** `app.css` keeps
  `table.data thead th` on one line, so in a `table-layout: fixed` table a
  long heading runs into the next ("Hydrological units short" over Lowest
  dam on the project list). Let such a table's headings wrap
  (`white-space: normal`, bottom-aligned), and check in e2e that each
  heading's content ends inside its cell (`portfolio.spec.ts`).
- **Put a panel's columns side by side by the panel's width, not the
  window's.** Runs & results' runoff panel set its table beside the stores
  chart above a 900 px *viewport*; at 1024 px the sidebar and the runs rail
  left the panel 465 px, the chart got 91 px and its Earlier / Later buttons
  poked 20 px past the window. A container query on the panel
  (`container: runoff / inline-size`) fixed it; `reflow.spec.ts` sweeps every
  tab at 1024 px with a five-year run (a record past three years is what
  gives a chart its full toolbar).
- **A header picker's label is for screen readers.** River & reserve's
  visible "Run" label sat on a line of its own above the select on a phone;
  the other pickers (Hydrological units, Allocations) wrap the select in a
  `<label>` with a visually hidden word, and River's select now carries
  `aria-label="Run"` (a wrapping label would fold the chosen option into
  its name), so the select fills its row (`workspace-phone.spec.ts` checks
  no picker drops below its control's top).
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
  the Project entry then took one row, leaving room for one more). The Map's
  row (#326 D3) took that one: the last link sat 14 % below the window and a
  viewer with the inputs shown overflowed 20 px, so the rows went to 32 px
  (still past the 24 px target) and the gaps to 0.5rem, which keeps a 32 px
  row to spare with all 17. Calibration (issue #586) took that row, and a
  viewer with the inputs shown then overflowed 13 px: the owner's spare row
  had hidden that the viewer's **Show model inputs** row (40 px and a 0.5rem
  gap) was 16 px taller than the Applications row it stands in for. In the
  sidebar it is a 32 px row now, so both roles fit with the same few pixels
  and no row to spare; the spec fails on a row too many and on a row free
  again. Count every role's rows, not just the owner's, when you budget.
  Below that height the slot scrolls on its own
  (`flex: 0 1 auto` with an 8rem floor, `overflow-y: auto`) so the account block
  never leaves the screen; `app-sidebar.spec.ts` pins both. The slot also
  sets `overflow-x: hidden`, since `overflow-y: auto` alone makes x auto too:
  the hidden-sections count badge, 6 px past its button, once gave it a
  2 px sideways scrollbar (the spec checks there is none, with sections
  hidden). Anything fixed to the window's bottom edge starts at
  `left: var(--sidebar-w, 0px)` (the shell's sidebar width, 0 on a phone),
  so it never covers the sidebar's foot and the account menu, as the save
  bar did. A new sidebar entry re-runs that spec.
- **A frame outside the app shell owns `--header-h`.** The farmer view
  (`farm/FarmShell.svelte`) has its own sticky 56 px header at every width,
  but the app shell set `--header-h` to 0 from 900 px, so `html`'s
  `scroll-padding-top` stopped clearing it and `/farm/words#farm-reserve`
  landed 11 px from the top, under the header (it had matched only because
  the old app bar was also 56 px). A frame with its own sticky bar sets
  the token while it's on the page (`:root:has(.farm-header)`); an element
  doesn't add its own `scroll-margin-top` on top (the notice's 72 px then
  doubled it). `farm-view.spec.ts` checks a link lands below the header at
  both widths.
- **A frame with its own base size checks what it borrows.** The farm pages
  set 16 px on their frame, but `rem` still means the app's 14 px root, so the
  workspace's notes list inside them drew its help line, meta line and Add
  note button at 0.85rem (11.9 px, the button 24 px tall on a desktop), and
  the forecast and outlook kickers, written as 0.8125rem for "13 px", came
  out at 11.4 px. Size in `px` inside such a frame, lift a borrowed piece in
  the frame's own copy (`farm/FarmNotes.svelte`), and pin the floor by
  walking the page's text (`farm-view.spec.ts` fails on any visible text
  under 13 px; `smallText` in `e2e/support/reflow.ts`). The account pages a
  farmer opens from the farm Menu sit in the same frame and are walked too:
  their labels, hints and badges were 10.5–12.6 px from the 14 px root until
  round 5 lifted them in px (`routes/account/+page.svelte`), and a long
  Afrikaans button label poked 11 px out of its card while the page still
  fit, so the same specs check that no control leaves its card's padding box
  (`outOfPanel`).
- **A legal line before the figures still leaves the first figure on the
  first screen.** The farm page's estimate line (issue #47) went in before
  the supply card and pushed its heading to 796 px on a 360 × 740 phone with
  a notice, 866 px in Afrikaans. Its words are legal wording, so the space
  came from around it, under 400 px only: the estimate box's icon sits in its
  first line (`float`) so the text takes the box's width, its padding and
  line height tighten (still 16 px type), the notice's byline ends its last
  line, the dates line's clock sits in its first line, the cards sit 10 px
  apart and the header's title gives way below 380 px as it did below 360.
  The heading now starts at 646 px (669 in Afrikaans). `farm-view.spec.ts`
  pins it at 360 × 740 in both languages, and at 320 × 640 the notice whole
  and the estimate line begun on the first screen.
- **A frame's header lines up with its column.** The farm pages' header
  spanned the window at 1440 (the title at the left edge, Menu at the right)
  over a centred 560 px column, so the eye jumped 440 px between the title
  and the farm's name, and Menu's list opened far from the cards. Pad the
  bar's ends to the column's content edge (`max(16px, calc((100% - 560px) /
  2 + 16px))`, less a control's own padding at the right) and keep its
  background full width; a page in the same frame with a wider column (the
  account pages) keeps the full-width bar (`farm-view.spec.ts` checks the
  title and Menu against the heading and the cards at 1440, 1280 and 360).
- **A back link goes where the reader came from, by a checked address.**
  `/farm/words` always went back to `/farm`, so a farmer with several farms
  landed on the list. Links into a shared page carry the page they're on as
  `?from=`, and the shared page takes it only when it matches the one shape
  it may be (a farm page's own path, `farm/load.ts` `farmReturn`), so it is
  never an open redirect; the label follows the target ("Your hydrological
  units" for the fallback). Pass `from` on from the page itself, or its own
  Menu link drops it.
- **Print is a layout too.** The report route feeds the server PDF, so the
  frame must never reach paper: the shell's `.app-header` was renamed when
  the sidebar came in, the report's print rule kept hiding the old name, and
  the phone bar printed on every report's cover (A4 is under 900 px). Worse,
  whichever frame was drawn when printing began changed the whole PDF: the
  sidebar's grid column made 37 pages of 22, and the PDF with the phone bar
  on its cover printed every word at ~80 % of the stylesheet's size. The frame now hides itself in print (`AppShell.svelte`). Check a
  print change by comparing the PDF (`page.pdf()`, `pdftotext -bbox` for type
  size, `pdfinfo` for pages), and keep screen-only fixes in `@media screen`.
  A drawing that scrolls on screen can't just be scaled to the page: the
  30-unit schematic printed its names at ~1.4 pt. Give paper its own layout
  (the report draws `NetworkSchematic paper`, wrapped to five columns, and
  hides the screen copy in print) and measure the type in the PDF
  (`report-schematic-print.spec.ts`). Bound the height too: one SVG taller
  than a page is sliced wherever the break falls, through a row of names if
  that's where it is. Split it into page-high SVGs at clean boundaries, each
  `break-inside: avoid` (the schematic's `paperBands`), and check in the PDF
  that every name lands whole on exactly one page. One element wider than the
  page shrinks the whole PDF to fit: a curtailment table's `min-width: 11rem`
  name column (issue #521) took every printed word down ~3 %, and the
  schematic's names fell under 7 pt. A fixed minimum width on anything the
  report prints belongs in `@media screen`.
- **An absolutely positioned bit inside a scrolling table escapes it**
  unless the box is its containing block: the visually-hidden words in
  `/compare`'s delta cells and the report's EWR grid gave both pages 185 px of
  sideways scroll on a phone while the workspace, which had its own
  `position: relative` rule, didn't. `.table-wrap` is `position: relative`
  app-wide now; `expectNoSidewaysScroll` (`support/reflow.ts`) on a phone
  catches the next one.
- **Lay a row of actions out on purpose on a phone; don't let it wrap.**
  One flat `flex-wrap` row of header controls left ragged rows and split
  Add data from Run model (Settings put Run model alone on a third row;
  Allocations, Add data). Group the controls (status, the section's own,
  the page's pair), make the groups `display: contents` where they fit on
  one row, and in a narrow container give the status its own line, pickers
  a full row, every control `flex: 1 1 auto` so rows fill, and the pair one
  box that never splits (`workspace/SectionHeader.svelte`,
  `workspace-phone.spec.ts`). A popover anchored to the right edge (the
  rain pill's list) must open from the left once its trigger starts the
  row, or it runs off the screen.
- **A form's buttons go in one action row under it, the same on every
  panel of a page.** River & reserve's analysis panels each placed their
  run differently (the ensemble's under six fields, Sensitivity's a small
  secondary, the demand sweep's and the outlook's beside their levels box),
  so the buttons zig-zagged down the page. Fields, hints, checkboxes (and
  an expanding sub-form such as the outlook's monthly plan) come first,
  then `<div class="action-row">` (`app.css`): at the content edge, the
  same 0.75rem above it whatever precedes it, the main run first, default
  size (not `btn-sm`), primary for the panel's main run and secondary for a
  lesser one, Cancel after it. Focus order stays fields then button. Pin it
  with each button's left edge equal to its first field's (or the other
  panels' buttons') and below the fields (`uncertainty.spec.ts`,
  `outcome-matrix.spec.ts`, `seasonal-outlook.spec.ts`). A one-field lookup
  inside a table toolbar (Self-checks' Trace) is not this shape.
- **Findings first; a tool nobody has run is one row.** River & reserve
  split its findings with three run-it-yourself tools, each a paragraph and
  a form, so the water account ended up last (issue #465). Put what the
  page found first, group the tools after it under their own heading, and
  show an unrun tool as one row (`common/ToolRow.svelte`: name, ⓘ, one
  line of purpose, **Run…** at the end, which opens the form with focus on
  its first field). A panel that only exists with some setting gets a
  one-line stub saying what it needs and where to set it, rather than
  vanishing.
- **A map's tools go on the map; the header keeps the page's actions.**
  The Map's header carried Measure, Draw a shape, Place a point, Delineate,
  Trace a dam, Upload GeoJSON and Add data as seven identical buttons that
  wrapped to two rows at 1280, with up to four full-width notices stacked
  between them and the map, and a side column stacking the picked card, the
  list, the layers and the checks so each got a sliver (2026-10-02). Now the
  tools are a column on the map's left edge (an icon over a short word,
  pressed while on, a strip over the map naming the tool that's on), Layers
  and Key are panels over the map's corners, a one-off result is a toast
  over the page's foot, the setup nags one header pill (the Summary's Setup
  pill), and the side column one panel at a time under tabs
  (`map/MapTab.svelte`, `map-layout.spec.ts`). The map starts right under
  the header and keeps the window. **A panel open by default over a map
  covers what's under it**: the Key, open on every wide map, sat on a gauge
  a spec had to click; it opens by default only while its colours need
  reading (a run's results), and the corners' boxes pass clicks through
  between their controls (`pointer-events: none` on the box).
- **Over a map, only buttons; a panel goes in the side column when there is
  one.** Even folded by default, the Layers and Key boxes over the map's
  corners read as clutter to the operator ("i just dont really like the
  bottom left box", 2026-10-03). Beside the map they are now tabs of the side
  column (Layers, Key after Details, Features, Checks), the map keeping only
  its zoom buttons, the tool strip, small toggles that pick those tabs and
  one search box along its top edge (below)
  (`aria-controls` the tab panel, `aria-expanded` while picked, pressed
  again or Escape gives the tab back). Where there is no column (a phone,
  an empty map, the Sub-catchments panel taking it over) they stay panels
  over the map, so nothing is lost; a picked one falls back to Features when
  the column goes. Render a panel's body from one snippet in both places
  (`MapTab.svelte` `layersBody`, `keyBody`), and only in one at a time, so
  ids and test ids stay unique. Measure a bar of controls before promising
  "one line": the Drawing bar's kind select, Snap and Follow, and its four
  buttons are ~840 px with no hint at all, so at 1440 (a 790 px bar) it is
  two lines and one line only from about 1100 px.
- **A box over the map's top edge, never a row above it.** The Map's
  search (issue #523 C5) first went in a row heading the card, which pushed
  the map down the window (`map-layout.spec.ts` "thirty units" caught
  it). It is one line over the map's top edge, right of the tools and clear
  of the zoom buttons, the Google Maps place; what reads under it (its live
  line, the credit) are chips that push the picked name and the tool strip
  down through a CSS variable (`--map-inset-top`, set from the box's
  measured height less the open list's), and the open list covers what's
  under it. On a narrow map, check the right column too: Layers sits under
  the zoom buttons, so it moves under the search's lines and the picked
  name stops short of it (`MapTab.svelte`, a `map-body` container query).
- **The map's credits never run under its own buttons.** MapLibre's
  attribution sits bottom right and grows leftward; the Map's Show
  everything and Key sit bottom left. A 150-character credit (the MAP grid's
  authors' line, issue #560) wrapped along the whole foot and the buttons
  hid its start, at 1280 px as on a phone. The tab measures its bottom-left
  corner (`.foot-at`: the buttons, and the Key's panel while it is open over
  the map) and keeps the attribution beside it on a wide map, above it under
  30rem, where beside would leave a column of one or two words a line
  (`MapTab.svelte`, `--foot-w`/`--foot-h`; `map-layers.spec.ts` checks the
  boxes never meet at 1280 and 390 px, Key open too). And keep each credit
  short, linking to its full statement on `/data-sources` (HydroRIVERS',
  the MAP grid's): the whole line stays on that page and with the layer.
- **A popover's controls aren't in the DOM while it's closed.** The Map's
  Getting started pill kept its steps' buttons in a `hidden` box, and a check
  that the header's controls share one row (`locator('button, a.btn')`) read
  them at top 0. Render the content only while open (`MapSetupPill.svelte`).
- **A long form gets an index beside it, its values in its heads and its
  explanations behind a switch.** Settings & calibration was 12,300 px at
  1440 (22,000 on a phone) of panels in model order under a two-row pill bar,
  every field carrying a two-to-five-line explanation, and the operator lost
  a file box under a 12-row grid ("my god is it difficult to navigate",
  2026-10-08, issue #468). It became: the panels regrouped by task with the
  menu as a sticky side column from 80rem of content (`SectionNav`'s rail,
  a layout option of the shared menu rather than a fork, the bar kept below
  it), a find box that jumps to a setting by name and opens what folds it,
  one line under each heading saying what the panel is set to now, and the
  static explanations hidden until a remembered switch is ticked (each
  field's ⓘ stays, and the hidden text is still its `aria-describedby`):
  10,000 px, and every panel reachable in one click. Two rules from it: an
  explanation and a state line look alike, so mark only what explains
  (`.explain`) and leave warnings, "now" figures and required notes alone
  ("With no rule declared…" was inside an explanation and had to move out;
  a hint that is half format, half reasoning splits into two elements, both
  in the field's `aria-describedby`, since a hidden child of a referenced
  element drops out of the description: "The gauge code, e.g. A2H012." stays,
  "Verified DWS data lags by months…" is `.explain`. The switch hides
  `.explain` inside an `explain-scope` wrapper (`.settings-form`, so a
  panel outside it needs a wrapper; Data and Project have no switch, so the
  field help there is always shown);
  and measure the widest content beside a rail before choosing where it
  starts (the A-pan row with its year total overflowed by 23 px beside a
  13.5rem rail until the month cells' padding went to 0.1rem and the rail
  to 13rem; at 1280 it would scroll, so the bar stays there).
- **Two forms in one panel are two cards; each card's action is where its
  choices end.** Settings' Fit the parameters held Fit automatically (a
  one-off fit) and the calibration rules (revisioned, signed off) as one run
  of ~35 controls in a 4-column grid: bounds, model runs, starts and seed
  appeared in both with nothing saying which action they fed, Fit
  automatically sat mid-card and the rules' sign-off under ~25 fields, below
  the fold at 1440 (operator, 2026-10-10). Now each form is a bordered card
  (`SettingsTab.svelte` `.sub-card`), and inside each: the choices that decide
  the result first, top-aligned in one row; the rarely changed ones folded
  into one line of their values (below); the button straight under them in
  an `.action-row`. `fit-panel-layout.spec.ts` checks the button is in the
  window after the header's jump at 1440×900 and 1280×800, at the content
  edge, within 24 px of the fold. Don't merge two controls that look alike
  across the cards to tidy up: Fit automatically's search is a session
  choice, the rules' is a revisioned rule, and they save differently.
- **Rarely changed settings fold into their values.** A setting most people
  never change (bounds, model runs, starts, seed) doesn't get the weight of
  one that decides the result. Fold it into a `<details class="fold">`
  (`app.css`): the summary is one line naming the group and its current
  values ("Search: Wide bounds · 1 500 runs × 5 starts · seed 1", from a pure
  helper such as `calibration/fit.ts` `searchSummary`, unit-tested), with
  **Change** at its end (`aria-hidden`, since the summary already announces
  expanded/collapsed; **Hide** while open; **Show** for a viewer, who can
  change nothing inside: pass `readonly`), and the fields open in place. The
  values shrink and wrap in their own box (`.fold-line`), so a long line
  keeps its name and action on its row instead of dropping under the name
  and orphaning the action (issue #586; `expectFoldOnOneRow`). The
  line shows **needs fixing** while any field inside is `aria-invalid`
  (`.fold:has([aria-invalid='true'])`), so a closed fold never hides a
  problem. A native `<details>` keeps its fields in the page, so Find a
  setting still finds them and opens the fold (`SectionNav` `jump`), and
  nothing is lost. Every fold is one component, `common/Fold.svelte` (`name`,
  `line`, `change`, `open` or `bind:open`, `atDefaults`, `problem`, `body`:
  'grid' for the field grid, 'stack' for headed groups, 'none' for a body the
  caller lays out), on the one CSS in `app.css`: Fit automatically, the
  rules' search budget, the pan row's fill tools, the node sheet's "More …
  settings" and "Not used …" lines, the Reserve tables' Table settings, the
  drought rule in words, the scenario editor's Application details and the
  defaults groups (below). Rounds 1–3 wrote the markup out six times and the
  copies had drifted (a marker in one card, "needs fixing" in some); round 4
  folded them into the component (issue #521). `problem={false}` only where
  nothing inside is checked (a statement, a rule in words, the proposer's
  ticks). **One marker rule:** every fold's line starts with the same
  chevron, pointing right while closed and down while open, and ends with
  its named action; a node sheet's section card, a headed band rather than a
  line, keeps its own triangle. `lib/uiPatterns.test.ts` refuses a
  hand-written `<details class="fold">`, and `expectFoldsNamed`
  (`e2e/support/settings.ts`) checks every fold on a screen has its line of
  values, the chevron and its action (`settings-patterns.spec.ts` over every
  Settings panel, `node-sheet-layout`, `scenario-editor-layout`).
- **Settings at their defaults are one line.** Rain gaps, Data quality and
  the WR2012 check's judging drew every field at full weight though nearly
  every project leaves them at their defaults (Data quality: 609 px of 14
  limits under a summary that already said "The default limits"; Rain gaps:
  five sub-topics and 11 buttons, every choice "(default)"; issue #521).
  Now each is `common/Fold.svelte` with `atDefaults` (it was
  `DefaultsFold.svelte` until round 4): the `.fold` above, starting
  closed only while everything inside is its default (`atDefaults`, from a
  pure helper beside the form, `rainGapsAtDefaults`, `dataQualityAtDefaults`,
  `wr2012JudgingAtDefaults`), its line naming the values ("Default limits:
  gauge/logger 66.7–150 % · outliers × 5 / × 10 · …", unit-tested) and
  ending in a named action (`change`: "Change the limits"; **Hide** while
  open). A group with something set starts open, and `atDefaults` is read
  once when it mounts, so a value put back to its default while the fold is
  open never snaps it shut under the cursor. `body="stack"` lays out headed
  groups or cards instead of the fold's field grid, and `spaced` gives a
  fold that stands as its own group a little room. e2e opens one with `openFold`
  (`e2e/support/settings.ts`), and `settings-defaults-layout.spec.ts`
  checks the closed line, that it opens, and its actions on screen at
  1440×900.
- **A list's add actions sit in its own head row, each named for the
  list.** Rain gaps had "Add a water year / Add a date range" twice, under
  "Also treat as missing" and "Also spread", with nothing in the names to
  tell them apart, and each pair sat under its list, away from the name
  (issue #521). `common/PeriodList.svelte` now puts the list's name, its ⓘ
  and its two buttons in one row (a `role="group"` named by that row's
  name, since a `<legend>` can't share a row with buttons), and every
  caller gives the buttons the list's words: "Add a missing water year",
  "Spread a date range", "Exclude a water year". Pin it in e2e: no two
  visible buttons in a panel share an accessible name
  (`sharedButtonNames`, `e2e/support/settings.ts`;
  `settings-patterns.spec.ts` checks every Settings panel with every fold
  open, on the Showcase and on a new project).
- **A panel that adds to a list puts its add action in its head, opening a
  card above the list.** Settings' Data feeds had **Attach a feed** under the
  list and two unlabelled buttons under it ("Use the catchment boundary",
  "Rain for each unit") that belonged to no form; its attach form opened
  mid-panel with its button ~880 px down; API keys' make form was always
  open above "No API keys yet" (issue #521). Now each panel after the form
  (`feeds/DataFeedsPanel`, `apiKeys/ApiKeysPanel`,
  `report/ReportSchedulesPanel`) has one add action at the right of its
  `.panel-head`, named for the list ("Attach a feed", "Make a key", "Add a
  schedule"), which opens a bordered card above the list with its own
  `.action-row` (submit and Cancel), focus going into the card and back to
  the head's button. A shortcut that is another way to fill one of the
  form's choices becomes an option of that choice, not a button beside it:
  the two map proposals are choices of the attach card's **Area**, each
  drawing its proposal and its own action row in place of the typed area
  (and a role that may only read them, an editor, gets a head action of its
  own, "Rain from the map", with only those choices). Picking a choice
  never moves the focus (an arrow key through a closed select fires
  `change`); a link that opens it (`?rain=boundary`) focuses the proposal's
  heading. The intro paragraph under such a heading goes behind its ⓘ when
  the glossary entry already says it. `settings-after-form-layout.spec.ts`
  pins the actions in the window at 1440×900 and the open cards at 390 and
  320 px.
- **A panel that saves on its own says so itself, not its host page.**
  Settings had one line after its form ("Data feeds, API keys and scheduled
  reports save as you change them…") for three panels; moving Data feeds to
  the Data page (issue #586, E13) would have left the line behind and the
  panel silent beside a page whose save bar still shows. The line is the
  panel's (`feeds/DataFeedsPanel.svelte`, `data-testid="feeds-saves"`, for
  the role that can change it), so it travels with every mount.
- **A long form of sections folds each section to a card of its values.**
  The node sheet held 72 fields, 13 checkboxes and 48 always-on help
  paragraphs in 13 sections: 5,768 px for one unit, 9 screens, with Save
  pinned but the dam on screen four (issue #521). Each section is now a
  `<details>` card whose header band is its title and one line of what it is
  set to (`network/nodeSummary.ts`, unit-tested), so a closed card still
  answers "what is this unit's dam?"; only the first (or the one the section
  menu points at) opens, and the menu's jump folds the others. Inside, the
  rarely changed fields fold (`.fold`, above), the fields the current method
  doesn't use hide behind one "Not used with the area flow share: High-MAP,
  Low-MAP." line instead of greyed-out cells (they open read-only, nothing
  lost), and the help goes behind the explain switch. Three things keep it
  honest: the header shows **needs fixing** while anything inside is
  invalid or a problem shows; a link into the sheet can name its section
  (`section=dam`), and with none a sheet whose node has a problem opens on
  that section; and **Show every field** opens it all for a full review
  (remembered on the device). Keep the open sections per tab, not per item,
  so ‹ › through the units keeps the same section in view. Result: 1,142 px
  folded, Save and the menu always in the window
  (`node-sheet-layout.spec.ts`). The old specs that work on fields call
  `openNodeForm`, which presses Show every field; the layout spec opens it
  folded.
- **A form's state and actions in its head, not a sticky bar.** The rules'
  card opens with its badge, revision and fit count on the left and the
  sign-off on the right (`settings/CalibrationRulesFields.svelte` `.head`),
  and its fields in four named groups (What to try, Which fit to keep, When
  data arrives, Search budget) so the whole editor fits a 1440×900 or
  1280×800 window under its head. A sticky bar was the alternative and was
  rejected: on a page it covers fields that scroll under it, so a field
  tabbed to lands behind it (WCAG 2.4.11, focus not obscured) and axe fails
  the covered targets (§ 4 "A sticky element inside a scroll container
  covers controls"). Make the card short enough instead, and pin it in e2e
  (the head's sign-off, the fit count and the last group's line all in the
  window with the head at its top). Save stays the page's save bar.
- **An action that saves at once, among fields that wait for the save bar,
  sits in its card's heading row and says so.** Flow calibration's
  Evaporation from the map had its **Use as GR4J's monthly PE** at the foot
  of a 2,000 px panel whose every other field waited for the save bar, with
  nothing marking the difference (issue #521). Now it is a card of its own,
  the button in the heading's row (`proposals/ProposalPanel.svelte`
  `actions`) beside a **Saves now** tag that is also the button's
  description. The same for the rules' **Run the calibration rules**: the
  card's main action goes in its head (`CalibrationRulesFields` `headAction`),
  beside the count it acts on, not under the result list.
- **An action that can't apply to this kind of item isn't offered; its
  reason is.** On a scenario run the Evidence panel said "This run is not
  nominated…" yet offered **Withdraw the nomination…** and showed the
  project's nomination history, and Publication said the run "can't be
  published" yet offered **Edit notice** (issue #521). Decide by the item's
  kind from a pure helper (`runs/evidence.ts` `evidenceKindBlocker`,
  `runs/publication.ts` `publishBlocker`), and for a kind that can never
  take the action draw only the one-line reason, with a link to where the
  action does apply (**Open the evidence run**). Nothing is lost: the
  action and the history are on the items they are about. Pin it in e2e:
  the panel has no buttons and no history on that kind
  (`runs-record-layout.spec.ts`). The same pass split one card of four
  actions (Run notes, Evidence, Reproduction, Changes since this run) into
  a panel each, each one-click action in its panel's head, and kept the bar
  to one link for the three with `covers`, so it still fits two rows.
- **A long warning list on a first screen shows its first three.** The
  run's "things to check" wall (8–9 items on a real catchment) pushed the
  results below the fold. Show three and **Show all N things to check**
  (one button whose name changes to "Show only the first 3 …", with
  `aria-expanded`, so the focus stays on it); the printed report lists them
  all (`RunSummaryView` `foldChecks`).
- **One short line under a field; the rest behind ⓘ or the explain switch.**
  Fit automatically's starts and seed hints were four-line paragraphs that
  made every row of the grid a different height. A hint that states a value
  or a problem ("Default 1 500.", "Enter a seed.") stays visible; one that
  explains goes under the page's explain switch (`.explain`, as `class:explain`
  when the same element turns into an error) or is already the ⓘ tip's text.
  The switch is one piece and one remembered value (`common/ExplainSwitch.svelte`
  + `common/explain.svelte.ts`, extracted at its third caller: Settings, the
  node sheet, the scenario editor); a form marks its wrapper
  `class="explain-scope" class:explained={explainSwitch.on}`, and app.css's
  one rule hides `.explain` under it (each form had its own copy of that rule
  until round 4; `lib/uiPatterns.test.ts` now refuses one, and a second
  switch). Don't use the `explain` class for text that must stay visible on
  a page with no switch (Applications' "Interaction" key is `interaction-note`). A hint
  with an ⓘ inside it splits: the words go in a `.explain` span, the ⓘ stays
  (the scenario editor's rebase line).
  Give a field's label the height of a label with a tip (`min-height: 24px`),
  or the inputs of a row without tips sit 6 px higher than their neighbours.
- **A field's error line grows its own field and moves nothing beside it.**
  Rows align their fields to the bottom (`.form-row`, and many a screen's own
  grid with `align-items: end`), so a label that wraps keeps the inputs in
  line; a day or number field's error line then made its field the tallest
  and pushed every neighbour down by the error's height (issue #521, round
  6). app.css's rule after `.form-row` handles every row at once: while a
  field in a row shows its `.num-err` (NumberInput's and DayInput's line),
  the row's fields stretch to the row's height with label and input at the
  top, and a `.form-row`'s buttons hold the inputs' line. It is `align-self:
  stretch`, not `flex-start`, so a column of fields (where align-self is
  horizontal) keeps its width. A field that draws its own error line under
  its input names it `.num-err` to get the same. `day-input.spec.ts` and
  `node-sheet-layout.spec.ts` pin a neighbour's input in place.
- **An index names each panel as the page does, and a page beside a rail
  reads its width from its own column.** Runs & results, River & reserve,
  Hydrological units and Data kept the two-row bar after Settings got its
  index, so their group names were dropped to fit, about 14 links sat in a
  flat row, menu names drifted from the headings ("Days below, by year" for
  *Days below the pragmatic EWR, each water year*), and the panels that had
  moved to other pages had no entry at all (issue #462). The fix was the
  same rail on each from a 1440 px window, every link its panel's heading,
  and on Runs the moved panels under their pages' names. The bar names the
  headings word for word too (issue #586, D4): a shorter `bar` name ("Flow
  duration", "Notes & evidence" standing for three panels) makes the bar and
  the page read differently, so when a bar can't fit two rows, the page has
  too many panels for one menu, and the fix is moving panels (as #586 moved
  Model quality to Calibration), not shortening names. EWR and Compare runs
  still carry `bar` names from before the rule. Two traps on the way: River's
  chart-beside-bars switch was a window media query (1100 px), which beside
  a 13rem rail sees a column 13rem wider than it is, so it became a
  container query on the page's own column; and a page that only had a
  menu once its results loaded would have drawn its whole content again on
  that load if the wrapper were added conditionally, so SectionNav with no
  sections draws only its content. Compare runs and the Network's node
  sheet followed: Compare's rail wraps only the comparison, so the run
  cards above keep the whole width, and its summary's side-by-side switch
  moved to a container query for the same reason as River's; the node
  sheet's hand-made jump row became the same menu in a box of its own
  (`onjump`), which also gave it the mark for the section being read and
  names matching the legends.
- **A page with a side index is one column, in the index's order.** The
  Project page kept its two columns (details, notes and facts on the left;
  who can open it on the right) when it got its index, grouped by column. A
  link to a panel in the taller right column (Farmers onward) then put that
  panel at the window's top beside an empty left column, and the index's
  order (left, then right) wasn't the order the eye met the panels (issue
  #586 R4-B). It is one column now, each index group a column of its own
  (`data-nav-group`), the page's second question (who can open it) straight
  after the first so the first screen still answers both, and the facts
  that repeat other tabs last. A wide column needs its insides sized on
  purpose: fields two a row in a container query, a 75ch measure on the
  explanations, a short form (a picker and its button) kept a form's width.
  Pin it with every panel's left edge and width equal, the headings in the
  index's order, and a link to a far panel showing the next one under it
  (`project-page.spec.ts`).
- **A panel's heading goes in `.panel-head`, even with nothing beside it.**
  The settings panels' line of values (`.settings-form .summary`) pulls up
  0.35rem into the head's 0.75rem margin; Model settings' first panel drew
  its `h2` bare, so its line ran into the heading at 1440 (issue #586 R4-B).
  The same frame on every panel gives every line the same gap
  (`settings-model-layout.spec.ts` compares it with Simulation period's).
- **A page of parts: the parts are the h2s, and what moves in goes a level
  down without changing its look.** Calibration (issue #586) put Model
  settings' panels (h2) under a "Set up the fit" h2, so the outline read
  part, panel, panel… as siblings, and Model quality's sub-headings ("Where
  the parameters came from") were h3s beside their own panel's h3. Every
  heading in the moved components went down one level (panel h3, card h4,
  a card's group h5; FitProvenance, AgreementTable and ProposalPanel take a
  level), each keeping the size it had one level up by a scoped rule, so the
  panels look the same on both pages; the part headings went a size up
  (1.3rem) so the two halves read as halves. Check the neighbours' pins:
  specs that waited for `{ level: 2, name: 'Fit the parameters' }`, and
  helpers that read a panel's first `h2, h3`, had to follow. A sub-heading
  with an index line of its own is a NavSection `sub`: the rail indents it
  under its panel, so it doesn't read as one. An index whose second group
  is a run's panels shows, before a run is shown, one line to the part
  itself, so the index still reaches the part's empty state.
- **A title column sized by a fixed basis squeezes its text.** The section
  header's title took `flex: 1 1 16rem`, so whenever the controls fitted
  beside it a long context line wrapped to 3–4 short lines (River & reserve
  for a viewer at 1440, Compare runs at 1024). Size a text column that
  shares a wrapping row with controls by its content (`flex: 1 1 auto`, its
  max-content), so the controls wrap under it once its text would wrap, and
  pin the line count in e2e. No `min-width` floor over the content: kept as
  a 16rem floor, it made a short title claim room it never drew in, and in
  DejaVu Sans Data's controls wrapped under "2 input series · 1 behind" at
  1024 with ~40 px to spare.

## 3. Colour, wording, content

- **Colours are tokens** in `frontend/src/app.css` with dark-theme values
  (`--series-*`, `--accent`, `--warning`…); no raw hex in components.
- **Type scale: small text is a token, and a phone's floor is 12 px.**
  Small text takes `--font-xs` (0.75rem: badges, units, tags, a table's
  card labels, counts, kickers) or `--font-sm` (0.8rem: hints, captions,
  `.small` lines, table heads, tile labels); under 640 px on screen both are
  `max(<rem>, 12px)`, so a phone never draws text under 12 px and a larger
  root still scales them. Anything bigger is a literal rem (0.85rem and up,
  11.9 px counts as the floor). Never write a literal size under 0.85rem:
  about 400 component sizes from 0.6rem to 0.83rem (8.4–11.6 px on a phone,
  the unit table's card labels 10.5 px) each wrote their own until issue
  #521 round 6 moved them onto the two tokens. `uiPatterns.test.ts` refuses
  a new one; `text-floor.spec.ts` measures every tab at 390 px (12 px) and
  1440 px (10.5 px), the app frame included. The decided exceptions, listed
  by file and rule in `uiPatterns.test.ts`:
  - print styles (`@media print`): paper has its own sizes;
  - text in an svg (chart axes and labels, diagrams, a step icon's digit):
    sized in the drawing's units, so its drawn size follows the drawing's
    scale, and `checkDiagramLabels` measures that;
  - a glyph a screen reader skips (`aria-hidden`): a menu's ▾, a delta's
    ▲▼, a sorted column's arrow;
  - a count bubble on an icon button whose name carries the count (the
    sidebar's hidden sections, the compact notes button, the account
    menu's "i"), in a fixed 14 px dot.
  Text that grows can stop fitting where it used to: a sparkline's "max
  0.80" between "Oct" and "Sep" fit a 100 px crop column at 9.8 px and was
  cut off at 12 px, so on a phone the mark takes its own line under the two
  ends there. Run `clippedText` and `expectNoSidewaysScroll` at 320 and 390
  px after raising a size.
- **No two named things share a colour.** A palette runs out: give colours
  to the items that matter most (largest area, most demand) and group the
  tail as one labelled "Other" that names its members. The Crops page's
  6-colour palette gave five crops the same grey.
  **The exception: numbered map pieces.** A start or divide proposal's
  pieces (`map/pieces.ts`) can outnumber any palette, so the **number** on
  each piece and on its card is what names it, and the six tints
  (`mapStyle.ts` `pieceTints`, away from the map's meaningful hues) only
  help the eye: `pieceTintsFor` gives touching pieces different tints, and
  the map and the cards read number and tint from the one list, so they
  never disagree.
- **Name every line on a map by what it is for, where the eye is, and in
  the key.** While delineating, the Map drew the elevation model's channels
  over the River network's dashed rivers; the key listed only "river
  network", the bar called the channels "a red line" (orange-red in the dark
  theme), and the operator asked why there were orange and blue lines and
  which one the catchment followed (2026-10-03). The bar now names both with
  their swatches ("Terrain channels: where your click goes; the outline
  follows these", "River network: mapped rivers, for reference only; …")
  and the key's Lines lead with the same words from one helper
  (`map/mapList.ts` `delineationLines`). Don't name a thing by its colour
  in text: colours change with the theme ("Darker cells are months of higher
  demand" read backwards in dark, where a higher demand is a brighter teal;
  now "The stronger a cell's shade…"). `frontend/src/lib/darkTheme.test.ts`
  refuses "the red lines", "darker cells", "green = better" and the like in
  any copy. And keep what a decision is
  checked against on screen while it is decided: the channels went with the
  click step, so the proposal couldn't be checked against them; they stay,
  dimmed, until it is accepted or rejected.
- **After accepting a proposal, say what it became and offer the next
  step.** Accepting a delineated boundary saved a map feature only, and
  nothing said so: the operator asked how it reached the network. The toast
  says "It isn’t in the model yet." with the next step as a button (Divide
  the model, or Start from the map), and the boundary's card keeps it while
  it applies (`mapList.ts` `boundaryNextStep`).
- **Overlays take their edge from tokens.** A dialog, sheet or popover's
  backdrop, border and shadow are `--overlay-backdrop`, `--overlay-border`,
  `--overlay-shadow` and `--popover-shadow` (`app.css`), which deepen in dark:
  the literal 20 % black shadow and `--border` edge left a dark sheet at
  1.1:1 against the page it covered, so on a phone the two read as one
  (issue #521). `::backdrop` only inherits custom properties in recent
  browsers, so give it the light value as the `var()` fallback.
  A bar docked at the window's foot (the save bar) casts `--bar-shadow`
  upward. `darkTheme.test.ts` refuses any black shadow literal in a
  workspace component (the help pictures' fixed-colour markers aside): its
  first pattern named two popover sizes and missed a third and the save bar.
- **Hold non-text parts to 3:1.** A control's outline (or its fill, where it
  stands off the ground) and a chart's marks need 3:1 against the ground
  (WCAG 1.4.11), and axe checks neither: the flow unit picker's `--border`
  outline (1.3–1.5:1) and the reserve chart's faded part years (1.9:1) passed
  every scan in both themes. A control's outline is `--border-input`; a mark
  drawn "lighter" keeps a full-strength outline and fades only its fill
  (`fill-opacity`, never `opacity`), and its note says "outlined", not
  "faded". `e2e/support/contrast.ts` checks both (§ 5).
  **Canvas charts too.** A uPlot line is a mark: the light theme's
  `--series-3` (#1baf7a, 2.8:1) failed as the calibration check's upstream
  demand and the comparison's B − A, so it is #15996b (3.6:1; no palette
  neighbour moved closer for colour-blind readers), and the hydrograph's
  quality-flag strips were drawn at 75 %, which put even the red under 3:1;
  they are drawn at full strength, as keyed. A strip or line that is drawn
  must not be fainter than its key. Axis labels drawn on the canvas are text
  (4.5:1; axe can't read a canvas).
  **Faint on purpose, and why that's allowed:** gridlines and ticks
  (decoration, as in SVG); `LineChart`'s `shade` tint (`--warning` at 16 %)
  and a `band`'s tint and hatching, each keyed in words under the plot with a
  full-strength edge (the band's dashed `--series-4` start line is a mark and
  passes). The quality strips no longer use the light theme's yellow and
  pink (2.1–2.7:1, once an explicit `except` in the spec): every lane is
  ≥ 3:1 on the card, `non-text-contrast.spec.ts` draws a solid and a
  double-line strip and checks both, and anything faint fails.
  **Compute colour-blind separation; when the palette can't give it, add a
  shape.** The flow-quality strips (issue #557) needed six colours that stay
  apart for colour-blind readers, and no choice of six palette tokens does
  (CIEDE2000 after Machado 2009 protanopia, deuteranopia and tritanopia, every
  choice computed): the low-flow period's green sat 7.9 from the suspect
  amber for a dark-theme protanope, the light theme's aqua 4.8 from the human
  use pink, and so on. So the strips have two looks, by what the class says:
  solid for a reading outside the flow it can be trusted at, a **double
  line** (a 1 px ground line along the middle, the swatch the same, the
  key's heading saying what the two looks mean) for a doubtful one; within
  each look every pair is ≥ 10 for every reader in both themes. One cue,
  grouped by meaning, not a pattern per lane. And a strip isn't a line: the
  double-line classes have their own tokens (`--lane-*`), because the
  palette's light violet was the line charts' `--series-4` exactly and
  borrowing `--series-2`/`-3` put an orange strip under the orange simulated
  line (the review caught both); the test also holds every strip ΔE00 ≥ 13
  from each line the flow charts draw. Not hatching: a strip's ranges are often one day, under
  a pixel on a decade's view, where hatching can't show and the strip would
  no longer match its key. `calibration/flowFlagColours.test.ts` computes
  every lane pair and each lane's contrast from `app.css`, so a token change
  that brings two together fails.
- **A disabled main button is plainly off.** `.btn:disabled`'s fade turned
  the dark theme's accent into a mid teal that read as a live secondary
  button; `.btn-primary:disabled` is the plain surface, the strong border and
  muted text in both themes (`app.css`).
- **A picture gets a dark-mode render, not a filter.** The help pictures
  were bright daylight renders that glared on the dark page, and dimming them
  (`filter: brightness`) only greyed them. Render the scene again at dusk
  from the same camera (so markers placed on it fit both) and serve it as a
  `<picture>` whose `<source media="(prefers-color-scheme: dark)">` holds the
  dusk set (`DUSK_MEDIA` in `lib/help/pictures.ts`; the landing hero does the
  same). Keep what a picture labels true at dusk: the help scene's sun stays
  a sun, since a stop calls it evaporation. A dark render that fills its
  frame takes a 1 px `--border` outline; a cut-out on transparency takes none
  (`help.spec.ts`; ui.md § Help).
- **A badge is sentence case and a rounded box.** `text-transform:
  capitalize` gave "Dam Settings Changed Since The Run"; a badge capitalises
  its first letter only (`::first-letter`). Its corners are half a one-line
  badge's height (0.7rem), so a long badge that wraps in a narrow cell is a
  rounded box, not the tall blob `999px` made; give the cell room
  (Curtailment targets' names are at least 11rem).
- **Don't fade a row to mean "off".** Transfers dimmed a disabled rule
  with `opacity: 0.6` and axe failed its text on contrast (no scan had a
  disabled rule until the page got one). Tint the row and say **off** in
  words beside its number. A switch says its state too ("On" / "Off" beside the
  track, part of its target), so the state never rests on the knob's side.
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
- **Name each bar of a pair beside it; don't key them with a split swatch.**
  The landing's what-if drew Today and This plan as two unlabelled bars under
  each figure with one key below, whose "This plan" swatch was half green,
  half amber for the two figures' plan colours, and Today's grey
  (`--border-strong`) was 1.9:1 on the card. Each bar now has its label in
  front of it, Today is `--text-muted` (≥ 3:1, WCAG 1.4.11), and the plan's
  supply takes the supply bands, not a categorical `--series-*`.
- **Labels on diagrams** (the Network schematic, the report's schematic, the
  help diagrams; `diagram-labels.spec.ts` holds every one of them to these):
  - **Nothing runs through a label.** No label overlaps another, no line or
    symbol crosses it, no label straddles a box's edge. Where a line must go
    somewhere, route it round: the schematic's transfers take the smallest
    clear arc, and when none is clear (Sandspruit drew one through
    "Vaalbank"; a 22-node report through six names on paper) a grid route
    round every label and symbol (`network/schematic.ts` `routeAround`),
    crossing rivers but never running along one. In a hand-drawn help
    diagram, move the label ("× upstream share" sat on its wire; GR4J's
    footnote ran into the Flow Q box).
  - **A halo behind every free label**, in the ground's colour
    (`paint-order: stroke fill`, a 4 px stroke of `--surface-sunken` on the
    schematic, `--surface` on help diagrams' `.lbl`), so anything that must
    pass (the drag preview) breaks behind the words. On screen only: Chromium
    prints stroked text as a second copy of every word (a Type 3 font), so
    the PDF's text held each name twice (poppler before 25 lists both). The
    schematic drops its halo in `@media print`, where nothing is dragged and
    the routed transfers clear every label. Not on text inside a filled box:
    the halo would ring it in the wrong colour.
  - **Reserve the text as drawn, not as estimated.** Room for a label comes
    from its width in the font it is drawn in (the schematic measures on a
    canvas, `measuredWidths`), with the per-character estimate only as the
    floor: DejaVu Sans (the old body font on Linux and CI) drew ~15 %
    wider than the estimate, which ran names into the next node and put a
    transfer through "Melkhout Gauge". A canvas measures in whatever face has
    loaded, so the schematic measures again when the page's fonts finish
    loading (`document.fonts`), or a drawing made before Inter arrived keeps
    the fallback's widths.
  - **Three steps of hierarchy:** the name (12.5 px, 600, `--text`), its
    figure (11 px, 400, `--text-muted`), and the line's own key (the legend,
    not a label on every line). Both text colours are ≥ 4.5:1 on the ground
    in both themes (light: 15.0 and 4.6 on `--surface-sunken`; dark: 15.4
    and 6.6); compute it when a token or a ground changes.
  - **Distinct names.** A name cut to fit must not read like another's:
    "North Sandvlakte 2" and "… 7" both became "North Sandvlakte…". Cut the
    end, but where that collides keep the fewest whole words of the ending
    that tell them apart ("North Sandvlak… 2"; `distinctShortNames`). The full
    name stays in the tooltip, the list and the text equivalent.
  - **Never cut off, never too small.** A drawing centred in a scrolling box
    uses `align-items: safe center`, or its top row sits above the box's edge
    where nothing scrolls to it (Sandspruit's first row at 1440 × 960). A
    drawing scaled to its column is never drawn with its smallest text under
    9.5 px (help `Diagram` sets its `min-width` from the viewBox); past that
    it scrolls sideways, as on a phone. The model pipeline, 920 units wide,
    drew its notes at 7 px at 1440. **Then draw it to fit, rather than
    letting the floor make it scroll:** with the floor, five help diagrams
    720–920 wide scrolled 40–213 px sideways in the 582 px guide column at
    1280. Work out the widest drawing the column holds (column px × smallest
    text px ÷ 9.5: 673 for 11 px text at 1280) and redraw to it: a long
    chain runs top to bottom (the pipeline), a row of seven steps becomes
    two rows (the workflow). `help/diagrams/width.test.ts` holds help
    diagrams to 660.
- **Label every chart.** Every chart, sparkline, bar, band or mini-plot says
  what it shows without the reader guessing. The Crops list's factor
  sparklines had no title, axis, units or months, and the operator's
  question was "how are we supposed to know what this is". A chart has:
  - **a title or caption naming the quantity** ("Crop factor by month",
    "Days below the reserve"), from its panel heading directly above it or its
    own caption, never only from the page around it;
  - **units**, on the value axis, in the caption or in each value's words;
  - **the time axis** where there is one: month or date ticks, or at least
    its first and last month or day, and the span in the caption ("Oct–Sep",
    "the run's last year");
  - **a legend or direct labels** when there is more than one series, and a
    word for anything drawn to a different rule (dashed = capacity, hatched =
    forecast, a tick = the registered volume);
  - **a text equivalent**: an accessible name that carries the numbers (every
    value for a dozen or fewer), a visually hidden summary with a "Show the
    numbers" table, or the table beside it.
  - **The compact pattern, for sparklines** where full axes don't fit
    (`charts/Sparkline.svelte`, `charts/sparkline.ts`): a caption with the
    quantity and span; the first and last x label under the ends; the peak
    (or, for storage, the low) marked by a dot with its value between them
    ("max 0.80", "low 15% · 19 Dec 2023"); pointing reads out the point
    under the pointer ("Jul 0.40"), and so does the keyboard: a slider over
    the line takes focus (Tab), starts at the mark and steps the read-out
    and the dot with the arrows, Page Up/Down (a tenth) and Home/End, its
    point in words as `aria-valuetext` (a sighted keyboard user otherwise
    sees only the ends and the mark); a mouse press doesn't focus it. The
    accessible name is the item, the caption and the numbers. A list of rows shows the caption once, as a
    column header over the sparklines (the Crops list), not in every row; a
    card shows its own (the Dams cards). The marked value is the same figure
    the page gives elsewhere: the dam card's low is the chart's facts line's
    *lowest in its last year* to the day, so its line is each step's lowest
    real day, not a mean that smooths the low away. In a narrow card the
    mark takes its own line rather than being cut off.
  - **The guard** (`frontend/src/lib/chartLabels.test.ts`): every `<svg>` is
    hidden (`aria-hidden`, on it or around it) or a named image; every chart
    component is listed in its `CHARTS` with the required prop, heading or
    fixed name that says what it shows (make the naming prop required, not
    optional, so a caller can't drop it); a chart drawn inline in a bigger
    component is listed in `INLINE` with its on-screen labels. A new chart
    fails there until it is listed, which is the moment to label it.
- **Say what a colour means in words too** (a band label, "below 70%"), and
  name a segment on hover and focus: colour alone fails colour-blind users
  and axe.
- **Wording:** a node of the network is a **hydrological unit** (or
  **unit**) in everything users read, whatever its kind (2026-10-04;
  model.md § 7 Glossary): name the kind where it matters ("a unit with
  land", "a gauge", "an other water user"), never "node". The code, API
  fields, URL parameters and CSV say node and farm. Farmer-facing pages (farm view,
  sign-in, account, alerts, `/share`) go through `t()` (ui.md § Language):
  changing their English invalidates the Afrikaans.
- **Honest numbers:** a figure on an outcome page comes from the same helper
  as the same figure elsewhere (Hydrological units's irrigation supplied comes
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
| Overlays in the URL | `lib/workspace/overlays.ts`: `withParam`, `withoutParam`, `overlayHref`, `GRIDS` / `GRID_TAB` (a new grid is one entry plus a branch in `model/GridModal.svelte`). A grid that isn't the model's (no save row; the Map's features save one at a time) is a `TAB_GRIDS` entry its tab draws itself, same `grid=` parameter (`map/MapTab.svelte`) |
| Modals and sheets | `common/Dialog.svelte`: `full` (+ `keepInputs`), `side` (+ `wide` 640 px, or `extraWide` 920 px for a long sectioned form such as the node sheet; body scrolls, actions pinned), `subhead` slot for what must not scroll, `beforeclose` to ask before Esc or the close button throws input away |
| Hiding a form's explanations until asked | `common/ExplainSwitch.svelte` (the remembered "Explain each setting under its field", `common/explain.svelte.ts` `explainSwitch`, one value for every form) and `.explain` on each hint that only explains, hidden by app.css under a wrapper marked `explain-scope` with `class:explained` (§ 2 "One short line under a field") |
| Asking before an action (delete, revoke, submit, discard) | `await confirmDialog({ title, message, confirmLabel, danger })` (`common/confirm.svelte.ts`, shown by the root layout's `ConfirmHost`): never the browser's `confirm()`, which `lib/noBrowserConfirm.test.ts` refuses. Title the question, name the button after the action; e2e answers it with `answerConfirm` (`e2e/support/confirm.ts`) |
| Unsaved input a navigation would drop | `guardUnsaved({ dirty, what, leaves })` (`lib/nav/unsaved.ts`) during component init: the root layout's leave guard asks once, naming it and the destination. A form's state that must outlive a tab change belongs to the page (`project/detailsDraft.svelte.ts`) and its save bar |
| A tool that hasn't run, as one row | `common/ToolRow.svelte` (§ 2 "Findings first") |
| A form's buttons under its fields | `.action-row` (`app.css`; § 2 "A form's buttons go in one action row") |
| Rarely changed settings, folded to one line of their values | `common/Fold.svelte` (`name`, `line`, `change`, `readonly`, `open`/`bind:open`, `problem`, `body`; the CSS in `app.css`; § 2 "Rarely changed settings fold into their values"), the line from a pure helper (`calibration/fit.ts` `searchSummary`); e2e opens it with `openFold` and checks a screen's folds with `expectFoldsNamed` (`e2e/support/settings.ts`) |
| A group that usually stays at its defaults, as one line that opens | `common/Fold.svelte` with `atDefaults` (and `body="stack"`, `spaced`; § 2 "Settings at their defaults are one line"); the line and the at-defaults test from pure helpers beside the form; e2e `openFold` |
| A paste dialog | `model/GridPasteDialog.svelte` for a grid of numbers (Now/Pasted preview); a list of rows uses its frame, `model/PasteDialogFrame.svelte`, with its own preview table (§ 4 "A paste box that replaces a whole table is the shared paste dialog") |
| A typed date | `common/DayInput.svelte`: a text field read by `parseDay`, shown back day first, with `min`/`max`, its message at the field and its place in the save bar's invalid list (§ 2 "A typed date is day first too"), never `<input type="date">` |
| Two forms in one panel | a bordered card each (`settings/SettingsTab.svelte` `.sub-card`), the state and actions in the card's head (§ 2) |
| Saving from a modal | `model/ModelSaveRow.svelte` (a modal hides the save bar) |
| Reading a picked or dropped file | `latestFileText()` (`lib/files/latest.ts`), one reader per file box: the picker stays live while a file is read, so a large file's read could land after a smaller one picked next, under its name (issue #384). A read followed by a request (a preview) checks the pick is still current after each await (`allocations/AllocationImport.svelte`'s `generation`, `map/UploadSheet.svelte`) |
| Saying what a file or paste box takes | `common/FormatHelp.svelte` (`accepts`, the structure as its children, `example`, `exampleFile` or several `exampleFiles` to download, `context` to tell two on a page apart for a screen reader): one per box, beside its file picker, which comes before the fields a file fills, its words checked against the box's parser, its example fed back through it in a test (ui.md § Expected format) |
| A number field | `common/NumberInput.svelte` (`min`/`max` in displayed units, `scale`, `nullable`, `grouped`, `invalidMessage`): reads a decimal comma everywhere, keeps invalid text with its message and counts it in `common/invalidFields.svelte.ts` (ui.md § Number fields); prefer it to a bare `<input type="number">`, which leaves a decimal comma to the browser |
| Picking months | `common/MonthPicker.svelte` (twelve toggles in water-year order, 24 px or more, rows of six at 44 px in a narrow column or on a touch screen; *All months* / *No months*; Allocations' licence months since issue #521 round 5, which had forked it with 21 px boxes) |
| Grids inside a modal | the existing component unchanged (`CropsTab sections` → `CropGrids`, `NetworkTab only="table"`), never a fork |
| A small chart in a row or card (sparkline) | `charts/Sparkline.svelte` (the compact pattern, § 3 "Label every chart"; `caption` required) |
| Time-series charts | `charts/LineChart.svelte` (`windows` for 30 days / 1 year / All; Earlier/Later; units switch where the old chart had one) |
| Flow vs reserve with shaded days | `overview/FlowVsReserve.svelte`, `overview/summaryChart.ts` |
| Supply colour bands | `network/farmColour.ts`, `overview/supplyBars.ts` |
| One colour per item (categorical) | `crops/cards.ts` `rankCrops` + `cropColouring` + `CROP_PALETTE` (§ 3) |
| Dam levels | `overview/damLevels.ts` (level, bands, capacity-weighted total, which dams are in a run) |
| Status pills and bars | `portfolio/StatusPill.svelte`, `portfolio/StatusBar.svelte` |
| Lazy panels | `common/Lazy.svelte`, `common/lazy.ts` |
| A panel of values proposed from the map (the modeller decides) | `proposals/ProposalPanel.svelte` (heading, intro, controls, the live notice focused after a Use via `focusNotice()`, which callers call only while the panel still shows the Use's unit (it doesn't check), `noticeFailed` for a Use that failed for a unit the panel has left (an error in the notice, naming the unit, not on a row), `saving` (`data-saving`) while a Use is out, the busy/`data-ready` body, failure with Try again; `variant` page, drawer or inline) with `ProposalNoDataset`, `ProposalSynthetic` and `ProposalSource`; the panel keeps its own rows and Use (land cover, dams, evaporation) |
| "On this page" menu for a page of several stacked panels past one screen | `common/SectionNav.svelte` with the page's groups (`runs/sections.ts`, `settings/sections.ts`, `river/river.ts` `riverNavGroups`, `supply/supply.ts` `supplyNav`, `series/sections.ts`, `compare/sections.ts`, `project/sections.ts`), each link named as its panel's heading (`label`), on the bar too (no shorter `bar` name, issue #586 D4); at most two rows, the rest in More; with the page's content as `children` and `railFrom`, a sticky side column from that width (`railSide="right"` beside a page's own left column), `href` + `page` for a link to another page, `barHeight` for a sticky panel under the bar, and `find` for a find-a-setting box (Settings, issue #468; where the panels a reader sees depend on their role, read the links from the page as drawn, as `project/sections.ts` does from `PROJECT_ANCHORS`, so a hidden panel gets no link, issue #586; every long page from 1440 px, issue #462; ui.md § On this page menu) |
| Section links in a box that scrolls on its own (a side sheet's long form) | The same `common/SectionNav.svelte` with `onjump` (each link scrolls the box to the section and focuses it, no fragment in the URL; the scroll spy follows the box) and `heading={null}`, in the dialog's fixed `subhead` (the Network's node sheet, `network/nodeSections.ts` `nodeNavGroups`; issue #462). Not a row of buttons of its own: that one drifted from the pages' (no mark for the section being read, no More, names unlike the legends) |

Finished pages to copy from: `dams/DamsTab.svelte` (cards + chart, window
fit), `supply/SupplyTab.svelte` and `river/RiverTab.svelte` (tiles, run
picker in the header, moved panels, anchor redirects),
`compare/CompareView.svelte` (several runs side by side),
`network/NetworkTab.svelte` (map page, Tables menu, node sheet),
`series/SeriesTab.svelte` (a table over a chart in
the window's one scroll, the table split into named `<tbody>` groups each
folded under its own "Show all N …" with the picked row kept, a derived row
that opens in place to its own chart, the pick in the URL), `scenarios/ApplicationsTab.svelte` (a
queue: counts in the header, a status filter in the URL, rows that turn into
cards in a narrow column), `history/HistoryTab.svelte` (a timeline: rows
beside the picked entry with Newer/Older, filters in the URL, whole entries
on a phone), and `routes/+page.svelte` with
`projects/ProjectTable.svelte` (the Projects list: a Needs attention strip,
owner chips, outcome columns that fold under the name as the table narrows,
a fixed-position ⋯ row menu that a scrolling list can't clip).

Interaction details that bit:

- **Close a `<details>` menu through the element** (`el.open = false`), not
  bound state: `toggle` is async, and Escape right after opening was ignored
  in 4 of 6 runs.
- **A sticky element inside a scroll container covers controls** as they
  scroll, and axe fails the covered ones (target size). Put a picker in the
  Dialog `subhead` instead.
- **Closing an overlay drops its param with goto's `replace`**, so Back
  closes the overlay rather than leaving the page. A create dialog
  (Scenarios' `new=1`) that navigates on success lets the URL close it: drop
  the param in the same `goto` that picks the new item (with
  `replace`), rather than setting its `open` to false first, which
  starts a second `goto` that races the first.
- **When a state replaces the focused control, move focus to the title.**
  Forgot password's *Send reset link* button disappears into *Check your
  email*, and focus fell back to the start of the page. The sign-in pages'
  `h1` takes `tabindex="-1"` and `focusAuthTitle()` (`layout/AuthCard.svelte`)
  focuses it after the swap; test it with `toBeFocused()`.
  Outside the sign-in card, a control that removes itself (the farm notice's
  *I understand*, *Accept the new terms*, the banner's *Dismiss*) calls
  `focusPageStart()` (`lib/a11y/focusPage.ts`): the new page's `h1`, or
  `#main` while it loads.
- **A link that moves to another part of the page or app puts the focus there,
  never on `<body>`.** One pattern each (issue #586): a workspace sidebar
  link focuses the new page's `h1` (`focusPageStart()` after the navigation;
  the arrow keys between the links keep it on the link); an in-page menu
  link (`SectionNav`) and a loaded `#anchor` focus the section's heading
  (`tabindex="-1"`, no scroll; `anchorHeading`/`focusHeading`,
  `help/anchor.ts`). Not `data-sveltekit-keepfocus` on a link that changes
  the page: Tab would start again from the sidebar. Test it with
  `toBeFocused()`.
- **Motion that runs longer than 5 s needs a way to stop it** (WCAG 2.2.2);
  reduced motion doesn't count. The landing hero has a pause toggle; the
  sign-in panel's decoration simply stops after 4.8 s. Never animate text a
  reader is meant to read: the hero's reserve tag faded in for 3 s of every
  14, so it was hidden 76 % of the time.
- **Don't reserve a fixed space for a control laid over a field.** The
  password field's *Show* sat over the input's end with a 4.25rem reserve;
  Afrikaans *Versteek* is 70 px and covered the revealed password. Let the
  wrapper draw the field and put the control beside the input
  (`PasswordInput.svelte`), so its space follows its words.
- **A bar that swaps the page's colours needs its own focus ring.** The farm
  view's offline strip is `--text` on `--bg` reversed, so the global
  `--focus` ring was 1.67:1 on it in dark mode; its controls use the strip's
  text colour (16:1). Compute a ring's contrast against what it sits on, in
  both themes.
- **Two pills on a phone share a row; the last one's words give.** The
  Summary's Setup complete (~130 px) and the rain pill (~250 px) needed
  ~385 px of a 358 px row, so the status row wrapped and each pill sat
  alone on a half-empty line. The status row is `nowrap` now, the pills keep
  their width and the last one shrinks, its words in one span wrapping
  inside it (its date and its age each `nowrap`). A popover inside a pill
  that no longer starts the row can't open from the pill's own left edge
  without running off the screen: position it from the row (the row
  `position: relative`, the pill `static`), as the rain pill's list does
  (`overview.spec.ts`).
- **A compact control in a header doesn't wrap.** The EN | AF pair wrapped
  at 320 px and doubled the sticky farm header to 93 px; the compact switch
  is `nowrap` now. Let a title or back link give instead.
- **An animation's first frame is its still frame.** The landing's hero is
  prerendered on its loop's last frame (dams full, the tag shown), and the
  loop started at 0 %, so the moment the script turned motion on the dams
  emptied and the tag vanished. Start a looping animation in its rest with a
  negative `animation-delay` (the hero's `--rest: -11.2s`, 80 % of 14 s), and
  test it by pausing every animation at `currentTime = 0` and comparing the
  computed styles with the reduced-motion page (`landing.spec.ts`).
- **Arm a hide-then-reveal on mount, not in the markup.** The landing's icons
  drew on from `stroke-dashoffset: 1` when their card came into view, so the
  HTML showed them drawn, the draw blanked them, then drew them again. Hide
  only under an `armed` class set in `onMount` (as `Screens.svelte` does for
  its rise), inside `prefers-reduced-motion: no-preference`: without script
  and under reduced motion the thing is simply there. Put the classes on the
  elements the rule styles: with `armed` and `draw` on the icon's `<svg>` and
  the rule `.armed.draw path[pathLength]`, Chromium never restyled the paths
  when `draw` arrived (a fresh copy of a path matched; the originals kept
  their stale style), so the icons stayed blank. `path.armed.draw[pathLength]`
  with the classes on each path works; `landing.spec.ts` checks the stroke
  ends drawn.
- **Svelte drops the space at the edge of an element.** A narrow-layout
  label `<span class="cell-label"> change</span>` after a number read "1change"
  (and so did its accessible text) on the Applications phone cards. Write
  the space as `{' '}` inside the span. The same at the start of a block:
  `Mm³/a{#if …} · {pct} of natural{/if}` read "0.83 Mm³/a· 63% of natural"
  on the run summary, so start the block with `{' '}`. And a flex item's
  edge spaces collapse too: the run header's `inline-flex` links read
  "River & reserve→" until a `gap` put the space back. `runs-page.spec.ts`
  checks the gaps with `innerText`-style regexes and a text range's box.
- **Dates on a chart's axis are day-first.** uPlot labels daily ticks
  "12/30" and "1/9", which a South African reader takes as 1 September.
  `LineChart` passes `TIME_TICKS` (`charts/series.ts`: "30 Dec", the year
  under each year's first tick); a new time chart uses `LineChart` or that
  table, never uPlot's default.
  The hover read-out under the chart ("Date: 1 Oct 2021") goes through
  `fmtDay` too; it read "2021-10-01" under day-first ticks until issue #521.
  `river-page.spec.ts` hovers the flow chart and pins the Date row day first.
- **A table shown day first finds days as it shows them.** The Data page's
  preview and Download → Preview searched by ISO prefix ("2015-03"), which
  stopped matching what the rows said once they read "14 Mar 2015". Read the
  box through `dayPrefix` (`format/number.ts`): a day, a month ("Mar 2015",
  "03/2015") or a year, day first or year first, and anything else as typed
  so a half-typed "2021-1" still narrows (never January). The file itself
  keeps ISO dates; only the screen changes.
- **A typed date is day first too, so not `<input type="date">`.** A native
  date field shows the browser's own order: Trace a day read "12/30/2021"
  in a US-locale browser (issue #521). Where a person types one day, use a
  text field read by `parseDay` (`format/number.ts`: "15 Nov 2021",
  "15/11/2021", "2021-11-15", never month first), show it back through
  `fmtDay` once read, and say a day it can't read or that is out of range at
  the field (`runs/SelfChecksPanel.svelte`, `self-checks.spec.ts`; the Data
  page's Edit a day, `series/EditDay.svelte`, `series-hand-edit.spec.ts`).
  The scenario editor's Add a change reads its dates the same way since
  round 4 (**From (day first)**, a registered volume's **Valid from**, a date
  setting; `tidyDay` shows "15 Nov 2021" once the field is left, and the
  form refuses "From: type a day, day first: …"; `scenario-demand-scale.spec.ts`).
  Every other form uses the shared field, `common/DayInput.svelte` (issue
  #521 round 5; its rules in `common/dayField.svelte.ts`): bind it to the
  YYYY-MM-DD value ('' for blank, `|| null` at a nullable setting), give it
  `min`/`max` (YYYY-MM-DD), and it keeps text it can't read with its message
  at the field, joins the owner's `invalidFields` (the save bar's list and
  the leave guard, as `NumberInput` does), and sets the input's custom
  validity, so a form without `novalidate` refuses to submit it. Its
  blank hint is an example, "e.g. 15 Nov 2021", never a bare day: a bare
  "15 Nov 2021" in Settings' blank Simulation start and end read as a stored
  period. Where blank means something, say that instead (Simulation start's
  "First day with rain", end's "Last day with rain"; `DayInput.test.ts`,
  `day-input.spec.ts`). A form
  with `novalidate` that checks its own dates looks for
  `validity.customError` on the field before it submits
  (`feeds/DataFeedsPanel.svelte`, `feeds/UnitRain.svelte`), and leaves the
  bound to its own validator when that says more ("the sat product begins
  on 1998-01-01; choose rnl"). A field whose change does work (a refetch, a
  URL) passes `commit="change"`, so it stores once typing ends (Enter or
  leaving the field) rather than on each keystroke (`runs/ReportWindowPanel.svelte`).
  The value stored and sent never changes form; specs type day first or
  ISO and read the field back as "15 Nov 2021" (`day-input.spec.ts`).
  `lib/uiPatterns.test.ts` refuses any native date field.
- **"Today" is the viewer's day, and a day that must have passed goes as a
  moment.** `new Date().toISOString().slice(0, 10)` is the UTC day, a day
  behind in South Africa until 02:00: Registration checks' latest allowed
  day, the licence record's status, the API keys' example and two water-year
  defaults used it until round 6 of issue #521. Use `localIsoDate()`
  (`lib/format/number.ts`). A bare day reaches the server as UTC midnight,
  still in the future just after local midnight, so a field the server holds
  to "a date that has passed" sends today through `pastDayMoment(day)`, the
  current moment (`registration-checks.spec.ts` runs in a zone on another
  day than UTC).
- **The printed evidence report keeps ISO dates, on purpose.** It is a
  signed document whose lines match the manifest's hashed text (evidence
  pack manifests, `docs/evidence-pack.md`), so its dates, the fit line
  included ("GR4J fit of 2026-09-24 14:05 UTC"), stay YYYY-MM-DD:
  unambiguous in any locale and reproducible byte for byte from the bundle.
  Don't run them through `fmtDay`; the screens around it read day first
  (issue #521 round 3, decided by the operator).
- **A small chart's month letters keep their room at 320 px.** The farm
  charts' "J F M A M …" nearly touched beside a "100 %" axis column on a
  320 px phone (issue #521). Below 20 px a month (`chartGeometry.ts`
  `MIN_MONTH_PX`), the axis labels move into the plot, each just above its
  grid line, drawn after the bars or line with a halo in the card's colour
  (`chart.ts` `axisPlacement`). Pin it by measuring the letters' gaps in the
  rendered SVG (`farm-view.spec.ts`).
- **Measure a one-line meta with the font's real figures.** Inter's
  tabular figures set each hyphen a digit wide, so the runs rail's
  "2026-10-11 01:01 · 2021–2022" missed its line by a few px and broke
  after the dash, a third line on all twenty rows. Keep each part
  `nowrap` and use proportional figures where nothing lines up in a column.
- **A minus is U+2212, and only a column gets tabular figures.** The same
  `tnum` widening (Inter's hyphen goes from 942 to 1,328 units, a digit's
  width, with the dash centred) made the KPI tiles read "- 2.26", "2021 - 10 -
  01" and, in a tile's prose line, "under - estimates": `.stat dd` set tabular
  figures on every line of a tile. The tiles now use proportional figures, and
  `fmtNum` writes negatives with U+2212, which Inter draws to fill that width
  (the farm pages already did; a dozen workspace call sites had been patching
  it by hand). A display-format change reaches everything that reads its
  output: grep for `startsWith('-')` and `replace('-'` on formatted strings
  (the curtailment table's red and green classes keyed on it), make the
  parser read both signs (`parseNum`, `readNumber`: a grouped field shows
  `fmtNum`'s text and reads it back), and keep text that is saved or exported
  in plain decimals (the quaternary lookup's source note, coordinates a GIS
  reads). Dates a person reads are day first through `fmtDay`, `fmtStamp`
  and `fmtWhen`; Runs & results showed "2026-10-11 01:13" beside the
  Summary's "1 Oct 2021". When the date sits in prose another layer writes (the engine's
  "GR4J fit of 2026-09-24 14:05 UTC"), take the timestamp as data and format
  it on the screen (`describeFitRecord(r, fittedAtText)`); don't change the
  stored prose, which history revisions keep and evidence pack manifests
  hash.
- **Move a page's main actions to where they're seen.** Scenarios' Run sat
  under the changes, the form and a checkbox per node, off the first screen
  on a big network; it now sits in the scenario's head row. A section's
  "new" action goes in the section header (the Applicant view's New
  application too, once it got one), never under the list, where thirty
  items pushed it 2,700 px down.
- **A view shared by a page and a tab draws its title only on the page.**
  Compare runs (`CompareView`) drew its own "Compare runs" heading and
  context under the workspace's section header, so the tab had the title
  twice, and its spec pinned the second one. Inside the workspace it now
  puts its context in the header (`fillHeader`) and draws no heading; the
  standalone `/compare` keeps its `h1`. Count *all* headings with the
  title's name, not just `h1`s, when checking "one page title".
- **One heading per modal.** A grid opened from a Tables menu showed the
  modal's title ("Hydrological unit table", "Crop factors") and then its panel's own
  heading ("Network nodes", "Crop factors" with an ⓘ) right under it. The
  modal's title stays (it names the dialog and holds the ✕); the panel takes
  an `inModal` prop and drops its heading there, moving its subtitle and ⓘ
  onto its intro line and keeping its actions; outside a modal it keeps its
  heading. Pin it with `dialog.getByRole('heading')` →
  `toHaveText([title])` (`network-map.spec.ts`, `model.spec.ts`).
- **A fragment into a lazy tab needs the tab to land it.** Workspace tabs
  are lazy chunks, so the browser's own jump to `#set-ewr` runs before the
  element exists and the page opens at the top. Settings' note links
  (`?tab=settings#set-…`) had silently done that until its page spec
  followed one; the tab now finds the element on mount and holds it with
  `holdAnchor` (`help/anchor.ts`), focusing its heading, as River & reserve,
  Hydrological units, Runs, Data and Project do. A panel that is a lazy chunk
  of its own is drawn after the tab mounts, so one look at mount finds nothing
  (Project's API keys, Settings' Evaporation from the map, Runs' Forecast) or a box
  without its heading yet: wait with `landOnAnchor(id)`, which holds the
  panel once drawn and focuses its heading once that is (an h2–h4), giving up
  when the reader takes over or after `LAND_WAIT_MS` (a panel or heading that
  never comes must not take the focus late). A link to a panel the page doesn't draw for this
  item says so in a focused line, not silently at the top (Runs'
  `missingPanel.ts`). Test a fragment link by *loading* it,
  not only by clicking the in-page menu. And a `page.goto` that changes only
  the fragment is a same-page jump, not a load: the River menu's first
  "loaded link" test passed on such a jump without loading anything, and the
  Data one failed on it (no mount, so no focus). Go to another tab first.
- **A card with a stretched link beside a sticky panel isolates itself,
  and a sticky column paints after the page.** The Dams and Hydrological
  units cards stretch the name's link over the card (`a.name::after`,
  `inset: 0`) and lift their links and sparkline above it with
  `position: relative; z-index: 1`. A positive z-index paints after every
  `z-index: auto` box, the sticky chart beside the cards included, and
  Chromium can't know a sticky box won't overlap them, so each card's
  lifted part got a compositing layer of its own: thirty dams, thirty
  layers, each rasterised apart, and a card scrolling into view showed its
  text with the sparkline and links blank for a moment. Give the card
  `isolation: isolate`: the z-index then orders only inside the card. That
  was enough on macOS but not on Linux, where the cards still painted after
  two sticky columns that come first in the tree, the app sidebar and a
  page's "On this page" rail, and Chromium layered every sparkline, fact
  list and link row again. So both sticky columns carry `z-index: 1`
  (`AppShell.svelte`, `SectionNav.svelte`): they paint after the page's own
  content, nothing in the page paints after them, and no layer is made.
  Menus and bars that should cover them sit at 20 and up.
  `e2e/support/layers.ts` `layersInside` lists the layers inside a list
  (the DevTools protocol's layer tree), and `dams-page.spec.ts` and
  `supply-page.spec.ts` hold it empty. Layering differs by platform, so
  check a change to it in CI's Linux Chromium, not only on a Mac (e2e
  against the `mcr.microsoft.com/playwright` image's `run-server`, through
  `PW_TEST_CONNECT_WS_ENDPOINT` and `PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>'`).
- **A sticky element sticks only inside its parent.** Settings' "On this
  page" menu sat inside the form, so it scrolled away at Data feeds, the
  first panel after the form; the Data page's `.data-page` wrapper ends
  under the chart. Put a page's sticky menu at the tab's top level and check
  it is still in view on the last section.
- **"Last section at the end of the page" overrides a link.** A scroll-spy
  that marks the last section once the page can't scroll further also does
  so after a jump to one of the last few sections of a short page: shortening
  one glossary entry made Goodness of fit mark the wrong term. Keep a
  just-linked section marked while its heading is on screen
  (`lib/help/spy.ts` `currentSection`'s `linked`).
  And on a page short enough that the first section still starts on the
  screen at the bottom, every section is in view and nothing has been
  scrolled past: mark the first, not the last (`common/sectionNav.ts`
  `activeSectionId`; the Calibration page's two parts, issue #586).
- **Nested wrapping groups wrap as whole blocks.** The in-page menu was a
  flex row of groups, each a wrapping flex row of links: a long group took
  full rows of its own, so Runs & results' menu was three rows at 1280 px
  with Summary alone on the first. Flow the links like words (inline blocks)
  so a group breaks where it must, and move what doesn't fit into More
  rather than growing a third row (`common/SectionNav.svelte`).
- **A fit measures every state it can draw, and every margin the line
  holds.** SectionNav's fit measured each link only in its "widest" state,
  bold, and gave More no trailing gap; with Inter under Linux Chromium,
  which rounds each glyph's advance to whole pixels, regular weight set up
  to 4 px wider than semibold, and a line's last margin still takes room, so
  CI's bar kept a link too many and More wrapped to a third row while a Mac
  fit (#264). Measure each variant the element can take and use the widest;
  count trailing margins; and when a layout check fails only in CI, run it
  in CI's browser before guessing (`e2e/README.md` § Fonts).
- **A reading page's header says what the page decides.** A long form has
  no count to show; Calibration's context line says where the
  runoff parameters came from (the fit's day and score, "changed since the
  fit", or no fit record) and its action jumps to the fit (Settings &
  calibration's, until issue #586 split it into Model settings and Calibration). Find the one fact
  a user opens the page to check, and put it there. It describes the
  section, not the filter: History's "Latest change today 14:05 by Ann:
  Model changed" stays the latest of all while the list is filtered to one
  unit (a small unfiltered read beside the filtered one), so a filter never
  makes the header claim something false.
- **A checkbox in a flex label keeps its size.** `app.css` gives every
  `input` `min-width: 0` (so a select never pushes a phone page sideways),
  and a checkbox is `1rem` wide; as a flex item in a `display: flex` label it
  then had `flex-shrink: 1` and nothing to stop it, so once the words wrapped
  the box shrank to a dot ("Validate: split-sample…" 10.5 px, Settings'
  CHIRPS quantile map 5.6 px; eight boxes on Settings alone, 2026-10-10).
  `input[type='checkbox'], input[type='radio']` are `flex-shrink: 0` app-wide
  now. `squashedChecks` (`e2e/support/reflow.ts`) lists any visible box drawn
  under 12 px; `reflow.spec.ts` runs it on every tab at 320 px and 1024 px.
  To line a box up with a wrapped label's first line, use `align-items:
  flex-start` and `margin-top: calc((1lh - 1rem) / 2)` on the box, rather
  than centring it on the whole label.
- **A box with its words is `<label class="check">`, styled once.**
  `app.css`'s `label.check` is the flex row (`gap: 0.4rem`, `align-items:
  flex-start`) and gives the box block margins that fill one line
  (`max(3px, calc((1lh - 1rem) / 2))`: never under the browser's own 3 px,
  or two stacked small labels' boxes came closer than 24 px and axe's
  target-size failed on the Members panel), so the box sits on the first line's middle when
  the words wrap and still centres when a component keeps `align-items:
  center` for a taller row (a `min-height` of 28 px or more). A component's
  own `.check` rule keeps only what differs: `display: inline-flex`, a
  min-height, a font size, margins. About forty components each wrote the
  same three declarations (issue #521); don't add a fourth spelling (`.tick`,
  `.toggle`, `.choice` were folded into it). A switch drawn over a hidden box
  (`.switch`) and the month toggles are not this pattern.
- **Width rules for a field's inputs catch its checkbox.** Settings'
  `.field input { width: 100% }` stretched "Vary it by month"'s box across
  the field, with the words half a field away. Scope such rules with
  `input:not([type='checkbox'])`. `app.css`'s `table.data td input` did the
  same in every table cell: the Members panel's "Acts for the responsible
  authority" box took the cell's width and its words ran under the row's
  Remove button (issue #521); it skips checkboxes and radios now.
- **Keep a picked row in view when the list's box changes, not only when the
  pick does.** The Map's `node=` link picks a parcel far down a list that
  scrolls in its fitted card; on the first render the fit wasn't measured, the
  list didn't scroll yet, so "keep it in view" did nothing, and the list then
  shrank under the row. `FeatureList` runs the same check from a
  `ResizeObserver` on the list's box too (`catchment-map.spec.ts`, thirty
  units).
- **Bring a linked item into view inside its list, after the fit is measured.**
  Allocations' `unit=` link named a row far down a list that scrolled in its
  card. `scrollIntoView({ block: 'nearest' })` on mount did nothing: the
  block's height still used top 0 (the whole window), so the row was already
  "in view" and the list shrank under it once the top was measured; with
  `block: 'center'` it scrolled the page as well. Wait until the block fits
  at its measured top, then set the list's own `scrollTop` from the two
  bounding boxes. Better still, don't fit: Allocations flows now (2026-09-29)
  and its folded list keeps the linked unit's rows after the first five
  (`foldList`), so the row is on the first screen with no scrolling at all
  (`allocations-page.spec.ts` asserts it is in the viewport and
  `window.scrollY` is 0).
- **Fold every long list on a flowing page, each with its own button name.**
  Allocations had four things that grew without limit: the unit list, the
  picked unit's water years (a 30-year run is 60 rows with groundwater),
  the registered volumes and every unit's years (108 rows with thirty
  units). The two tables had scrolled inside the global `.table-wrap` 70vh
  cap all along, even with the fit. Each now shows its first few, ordered so
  the rows that matter come first (the full table follows the list's order,
  `rowsInListOrder`), with **Show all N …** and a fold-back button whose
  names differ on the page ("… hydrological units and sources", "… water
  years", "… registered volumes", "… rows"), and `.table-wrap` is uncapped
  (`max-height: none`). Picking an item far down an opened list scrolls the
  page back to the detail beside it.
- **A dialog's buttons go in its action row, even a form's.** Add data was
  its own `<dialog>` with a font ✕ (a plain "X" in some fonts) and Upload at
  the bottom left of the form, unlike every other dialog. On the shared
  Dialog, the form draws no buttons (`UploadForm`'s `external`), reports its
  submit label and state through a bound prop, and the row's button submits
  it with `form="<form id>"`, so Enter still submits. When a state swaps a
  row button (Cancel → Back while an overwrite is asked), keep one element and
  change its label, so the focus stays on it.
- **A dialog removed while open hands the focus back itself.** The sign-off
  dialog sits in `{#if open}` (its own chunk), so closing it took it out of
  the page still open, and a removed `<dialog>` restores nothing: the focus
  fell to `<body>`. `Dialog.svelte` now refocuses what opened it when it is
  unmounted open (`signoff.spec.ts` checks `toBeFocused()`).
- **A sheet a link opens through the URL hands the focus back to the link.**
  A plain link to `?settings=1`, `?grid=…` or `?new=1` navigates, and
  SvelteKit puts the focus on `<body>` before the sheet opens, so closing it
  left the focus at the top of the page (and inside the closed dialog for a
  moment). `Dialog.svelte` remembers the last element that had the focus and
  takes it as the opener when the focus is on `<body>` at opening; nothing
  to add at the link (`focus-after-actions.spec.ts`).
- **A delete puts the focus on what took the row's place.** The delete
  button goes with its row, and the confirm dialog hands the focus back to
  nothing. `focusAfterRemove(index, selector, fallback)`
  (`lib/a11y/focusAfterRemove.ts`) focuses the same control on the row now
  at that index (else the last row), or the fallback (the list's heading,
  its add field) once it is empty. Runs, Data, the project list, the team's
  and the project's members, the pending invitations and the farmers use it;
  Crops' `removed()` and the Network's `remove()` did the same by hand, and
  Scenarios focuses its list's heading (`focus-after-actions.spec.ts`).
  A row that stays but loses its control does the same: revoking an API key
  or withdrawing a share link keeps the row (marked revoked) but its button
  goes, so the index counts only the rows that still have one, and the next
  live key's Revoke or link's Withdraw takes the focus (else Make a key, the
  share form's first field, or the heading); removing a scheduled report
  focuses the next schedule's Remove, else Add a schedule (issue #586).
  A row with no control every row has (a note: only some have Delete) takes
  the focus itself: the notes list's items carry `tabindex="-1"` and the
  selector is the item (`notes/NotesList.svelte`, `history-steps.spec.ts`).
- **A pick is a step in history; typing is one step; a default is none.**
  Runs replaced the history entry on a run pick while River, Units, Dams and
  Allocations added one, so Back did different things on neighbouring pages
  (issue #521). The rule: a run, unit, dam or feature the user picks, and a
  filter or sort chosen from a control, pushes (`goto` without
  `replace`), so Back returns to the pick before. A search typed into a
  box is one step: its first change after the box takes the focus pushes,
  the rest replace (the project list, Runs' label filter, History's
  Parameter filter, one `SearchStep` each from `lib/nav/searchStep.ts`:
  `onfocus={step.focus}`, each write through `step.write(href, (replace) => goto(href, { replace }))`, which pushes until a push has landed: SvelteKit drops a navigation a newer one overtakes). A default pick, a redirect from an old link and closing an
  overlay replace. Every sort and filter is in the URL, so a reload keeps it
  (the Applications sort `sort=status`, Runs' `q=`). Back also returns the
  window to where it was on that entry, even when a pick scrolled its detail
  into view: SvelteKit 3 skips that for `reset: false` steps, so the root
  layout's `lib/nav/backScroll.ts` restores the place it saved, held while
  the section is still building (`back-scroll.spec.ts`: Dams, Hydrological
  units, Allocations, the section strip's arrow keys).
- **A failed load says what failed and offers Try again.** A panel that reads
  on its own (Recent notes, Registration checks, the Outcome matrix's sweep,
  the Seasonal outlook, Automated calibration's fits) shows "Couldn’t look
  up …: <reason>" with **Try again** calling its load again, never the bare
  server text with only a reload to retry. An action's failure (a start, an
  apply) keeps its own message: the action's button is its retry
  (`AutoCalibrationFollower.loadFailed`). Try again takes itself out of
  the page, so it hands the focus on: `common/LoadState.svelte` puts it on
  the loading line while the retry loads, on the new Try again if it failed
  again, and on the panel's heading once it has loaded
  (`common/loadState.ts` `retryTarget`; `586-a11y-load-state.spec.ts`).
  A panel with its own Try again does the same.
- **An add form above a long list, not under it.** The notes dialog put
  "Add a note" under the notes: with thirty it was 2,300 px down, and Close
  with it. It is now a side sheet with the form on top, the notes scrolling
  under it and Close pinned (`notes/NotesDrawer.svelte`).
- **A grid's actions go above it, in one row.** The node table, the crop
  grids and the Demands grid put add, sort, paste, load and download after
  the rows, the totals and a field guide, so the operator didn't find a file
  load under a 12-row grid (issue #463, after #461 moved the EWR settings'
  file load first). Each grid now has one `toolbar grid-actions` row between
  its one-line intro and its first row; pin it with `expectAbove`
  (`e2e/support/reflow.ts`: above on screen and first in the focus order).
  Notes about what's in the table (totals, a CSV's unit) stay under it.
- **A paste box that replaces a whole table is the shared paste dialog.**
  The EWR's TAB flows and percentile tables and each Reserve rule table had
  an always-open textarea under the grids with one "Fill …" button per grid
  (issue #521). They open `model/GridPasteDialog.svelte` now, from a
  **Paste…** beside the file load: `wholeTable` drops the start-cell and
  blank-cell rules (the block replaces every cell, so the caller's layout
  line says how it is read), a `target` snippet holds the choice of grid
  (radios) when there is more than one, and the plan is the old parser's
  result diffed against the grid (`settings/ewrPaste.ts`), so the values are
  the same. The preview (Now and Pasted) is the check before values are
  replaced: drop the confirm the Fill button asked, don't stack a second one.
  A paste that fills a **list of rows** rather than a grid of numbers (the
  Reserve tables' high flows: name, months, peak…) has no Now/Pasted cells to
  diff, so it previews the rows the parser read, with a button that says
  what it does ("Fill 2 high flows", "Replace with 2 high flows" over typed
  rows): the same parser and result, opened from **Paste or load a CSV…**
  above the list (`settings/EwrHighFlowsEditor.svelte`). Both dialogs share
  one frame, `model/PasteDialogFrame.svelte`: the layout notes (`intro`), the
  box and its label, **Load a CSV file** and a download, the **Preview**
  status line (muted while empty, red on an error), `notes`, the `table`
  while `showTable`, and Cancel and the apply action, which empties the box
  and closes. A third paste dialog takes the frame; `lib/uiPatterns.test.ts`
  refuses a box labelled "… copied from a spreadsheet" outside it.
- **A setting that moves to another page stays findable.** Round 1 of issue
  #521 moved the registered-volumes comparison band to Allocations, and Find
  a setting, which reads the page, stopped finding it. SectionNav takes an
  `elsewhere` list (`FindElsewhere`: the name, other words it may be searched
  by, the link and the page; `settings/sections.ts` `SETTINGS_ELSEWHERE`),
  listed after the matches as "Comparison band, on Allocations", and the
  page it lands on scrolls to and focuses the card once drawn
  (`AllocationsTab` on `#alloc-band`). Add an entry whenever a setting leaves
  Settings.
- **A head of named actions folds into one control on a phone, keeping the
  names.** The project list's head was three full-width buttons (New
  project, Import workbook, Import project file) before any project on
  a phone. The two imports stay named buttons where there is room (the
  client looks for a named workbook import), and at 560 px they become one
  **Import ▾** beside New project whose list names both; the one picked
  opens the dialog with the focus on Import, so the dialog's Escape returns
  there. A row's two buttons (Add data, ⋯) sit side by side at tap height,
  not stacked two targets tall.
  The workspace's section header does the same for every tab (issue #521
  round 5: it took 48–78 % of a phone's first screen, Network's Map, Tables,
  + Add hydrological unit and + Add other user a full row each): under a
  640 px header the tab's own controls sit in one **⋯ More actions** list at
  the end of the pills' row, the same elements rendered once (pickers named
  over their selects there, menus opening in place), and the main box's
  Add data and Run model share the last row. A pick closes the list and
  leaves the focus on ⋯, so a dialog it opens returns there; a control
  inside one of the list's own menus leaves it open. The header measures
  its own width (`bind:clientWidth`, matching its container query) to
  decide, and counts what the tab drew so an empty list draws no ⋯. Pin it
  as a budget: the header's foot within the first half of a 360 × 740 screen
  on every tab (`workspace-phone.spec.ts`). A spec that clicks a tab's own
  control at any width goes through `headerControl` (`e2e/support/sectionHeader.ts`),
  which opens the list first on a phone.
- **On a phone a footer of actions is one row, with nothing above it until
  it has something to say.** The model-edit sheets' save row was three rows
  (144 px of an 844 px screen) with nothing to save: "No unsaved changes",
  then Discard model changes and Done, then Save changes alone. It is now
  Discard, Done and Save in three equal columns (the long words hidden but
  still the names), the clean status for screen readers only, and the
  reason only once there are changes; the page's save bar puts its status
  in the buttons' row as the dot and a word ("Unsaved"), the reason under it.
  Leave a failed save's message whole, on a row of its own.
- **A table that scrolls sideways says so, and keeps its rows named.** On a
  308 px box a table cut at a column edge looks finished. `.table-wrap`
  draws edge shadows with CSS alone (two `local` covers over two `scroll`
  shadows), and `lib/a11y/scrollRegions.ts` marks a box that scrolls
  sideways `data-scrolls-x`, so on a phone its `th scope="row"` first column
  is sticky. Gate the sticky column on the attribute, not on the table: a
  table restyled as cards on a phone (Upload GeoJSON, the node table) would
  otherwise give its card head a background and a border.
- **The shared small text has a phone floor of 12 px**, through the two
  type-scale tokens (§ 3 "Type scale"): badges, `.small`, `.field .hint`,
  table column heads and tile labels were 10.5–11.2 px at the 14 px root.
  A component's scoped rule for those classes wins over app.css (its hash),
  so a redundant scoped copy (`.small { font-size: 0.8rem }`, the global
  value) is deleted rather than kept, and a deliberate size of its own uses
  a token or a size of 0.85rem and up.
- **Line up a table of fieldsets with fixed row heights, not subgrid.** The
  drought levels became one table (a column per level, a row per part of
  demand) while each level stays a `<fieldset>` named by its legend, so the
  errors and tests that name a level keep working. `grid-template-rows:
  subgrid` on a fieldset is unreliable (its grid is on an anonymous box), so
  each column is a stack of cells of one fixed height (`2.6rem`, room for two
  lines of a row name) beside one column of row names, switched on by a
  container query; on a phone the same markup is a card per level with its
  own row labels. A flex cell trims the leading space of a child's text, so
  wrap a name and its " (floor kept)" in one inline span.
- **Don't disable a control while its own change saves.** The alert emails
  page disabled each catchment's fieldset during a save, so an arrow key on
  a radio moved the choice and then threw the keyboard's focus to the page.
  Keep the controls live, mark the card `aria-busy`, and send one item's
  saves in order, taking the server's answer once the last is back.
  A button is the same: `disabled={saving}` on the focused Check
  reproduction, Trace or Publish threw the focus to the page mid-action,
  and Save notes, disabled once nothing was left to save, did it the moment
  a save succeeded. Mark it `aria-disabled` instead (still focusable,
  `.btn[aria-disabled='true']` in `app.css` dims it as `:disabled` does) and
  have its handler ignore the press; keep `disabled` for a reason that holds
  before the press (an empty required field). Test it with `toBeFocused()`
  after the action (`runs-record-actions.spec.ts`, issue #586).
- **A joined switch of radios: cover the border box.** A radio laid over
  its segment with `inset: 0` sits inside the border, so a 32 px segment
  gave a 30 px target; use `inset: -1px` and `calc(100% + 2px)`. And
  `2rem` is 28 px at the 14 px root: the account page's "32 px" radio rows
  were 28 px until `alerts.spec.ts` measured one.
- **On a translated page, reuse messages before adding one.** A new
  message has no Afrikaans until the translator agents run, so the page's
  `<html lang>` stays `en` and `af-layout.spec.ts` fails. The alert emails
  redesign marked not-yet-on alerts with a star and reused the existing
  sentence as the card's footnote instead of adding a "Not on yet" badge.
- **A tab that copies a list from the page must take the page's updates.**
  Data kept its own copy of the series (`untrack(() => initial)`), so a file
  added through the header's Add data didn't show until a reload. Sync from
  the prop when it changes to an array that isn't the tab's own.
- **Keep the previous record on screen while the next loads; snapshot what
  labels it, and make its actions inert.** A page that unmounts its panels
  while another record loads gets shorter, and a reader scrolled down loses
  their place. The EWR page keeps the run before on screen, its body
  `aria-busy="true"` (`data-run` names the run drawn), until the picked
  run's record is in. Two traps came with it. Words drawn from the new
  props next to data still the old run's: the flow chart headed and
  captioned the old run's lines from the new run's props, so keep the props
  that label a drawing (heading, shading, caption) in the same state as its
  data, set together when the data arrive (`FlowVsReserve`'s `drawn`,
  `ReserveYearsChart`'s `drawnRuns`/`drawnKey`). And actions keyed on the
  record drawn: the tools' Run buttons would start a job on a run the
  header no longer names, so their section is `inert` (and dimmed) while
  busy, not removed, so the page keeps its height. A record that fails to
  load clears the page to its error, so nothing stale stays.

## 5. Testing

- Every new page gets its own spec with a11y scans at desktop and phone
  (`e2e/support/a11y.ts`), and a helper module in `e2e/support/<section>.ts`
  (see `network.ts`, `crops.ts`, `river.ts`, `supply.ts`, `teams.ts`, `data.ts`,
  `scenarios.ts`, `allocations.ts`).
- **A full-screen modal sheet defeats axe's modal check.** axe scans only an
  open modal dialog by probing just outside it; a sheet filling a phone's
  viewport leaves nothing outside, so axe scanned the inert map behind it and
  failed a marker under the sheet's buttons as an obscured target.
  `expectNoViolations` (`e2e/support/a11y.ts`) therefore scans the open
  `dialog:modal` itself when the browser reports one (issue #523). Pass
  `include` to scan something else.
- **Playwright counts a visually hidden box as visible.** `.visually-hidden`
  leaves a 1 × 1 px box, which `toBeVisible()` passes and `toBeHidden()`
  fails ("from the file" kept as a row's description in Upload GeoJSON):
  check its box's width instead. The other way round, `getByRole` skips
  `display: none` (a closed More actions list), so a control there needs
  `includeHidden: true` to be found at all; `getByText` finds it anyway.
- **A layout that measures itself settles after its first paint.** The
  section header renders wide, measures its width, then folds the tab's
  controls into ⋯; a check that reads boxes right after the title shows can
  see the wide layout, and a control a tab adds late (Compare's export)
  brings the ⋯ after it. Wait for the ⋯ itself before measuring.
- **A closed `<details>` still lays out its content in Chromium.** Its
  children keep a `scrollHeight` (the panel is hidden with
  `content-visibility`), so a check for "nothing scrolls inside itself"
  counted River & reserve's closed *Show as a table* and *Values for* boxes.
  Filter on `el.checkVisibility()` first (`river-page.spec.ts`
  `innerScrollers`).
- **A success notice comes last.** A spec waits on "Saved …" and then acts,
  so the notice is the save's done signal: set it after the reload and the
  pick it leads to, never before. The Map's save handlers set it first, and a
  spec that clicked the Features tab on the notice lost its click when the
  pick landed and showed Details (`map-delineate.spec.ts`, #570;
  `MapTab.svelte` now sets every save's notice after its `pickInPlace`).
- **Reading a control's state doesn't wait for a modal to close.**
  `getAttribute` acts on the inert page behind an open sheet, where a click
  would wait. Placing a map's first point loads the list (the side tabs
  appear on Features) and only then picks the point (Details), closing the
  sheet in that same URL change; `showTab` read Features as already chosen
  in between, skipped its click, and lost to the pick under CI load
  (`map-draw.spec.ts`, phone). After a save from a sheet, wait for the sheet
  to be hidden before choosing a side tab.
- **A control that applies at once and saves behind it must order its
  saves.** The language switch changes the page on the click and sends the
  account save after it, so a spec (or a person) can choose again before the
  first save has answered. Sent side by side, the two saves reached the
  server in either order, and the account came back Afrikaans after a
  switch back to English and a reload (`alerts.spec.ts`'s farm frame test,
  #577's CI); the first save's late answer would also have set
  `session.user` back, turning the page with it. Chain such saves and keep
  only the latest choice's answer (`LanguageSwitch.svelte`, the farm view's
  unit switch in `SupplyCard.svelte`, as the account page's unit radios and
  `SectionsMenu.svelte` already did); pin it by holding the first save at
  the network with `page.route` until the second choice is made, and
  checking the order the saves were sent in (`language.spec.ts`).
- **Pin screen use in e2e:** no page scroll, the layout reaches the window's
  bottom within a few px, the key content is inside the viewport at
  1440×960, lists scroll inside their card; a new tab or page joins the
  list in `no-pointless-scroll.spec.ts` (see `network-map.spec.ts`,
  `portfolio.spec.ts`, `dams-page.spec.ts`, `data-page.spec.ts`).
- **Measure layout only after the page's own data-ready.** A card that is
  visible while its data loads (its Loading… state) is not at its final size,
  and the sections around it fill in after it, so the page keeps growing. A
  spec that read `scrollHeight` or a `boundingBox` right after one region
  became visible flaked on CI (the Summary: 1792 px against 1035 px measured
  before the run record, Supply by farm, alerts and baseline landed). Wait on
  a readiness attribute backed by the real load states: the Summary body's
  `data-ready` (`summaryReady` in `overview.spec.ts`), a section's
  `data-notes-ready`, a chart's `data-ready`, the projects list's
  `data-outcomes-ready`. A page with something that loads after the
  measured element and no such attribute gets one in the component (a
  bindable `ready` on each child that loads, as `AlertsPanel` and
  `PublishedBaseline` have), never a sleep or a looser bound. Checks that
  can only fail for a real reason when the page grows (`scrollWidth <=
  width`) or that poll (`expect.poll`) don't need it.
- **Modals make the page inert, but Playwright still sees it.** Scope
  locators to the dialog and close it before touching the page; duplicate
  names across page and modal cause strict-mode errors.
- **Find things by their exact name.** "Runs" also matched "Compare runs";
  a card repeating a change's text caused duplicate matches in Compare.
  But a badge is part of a link's name: once Data's sidebar link read "Data
  (1 series behind)", two specs waiting for `{ name: 'Data', exact: true }`
  timed out. Match the badge (`/^Data \(\d+ series behind\)$/`) or use
  `/^Data/`.
- **`getByLabel` matches substrings, `aria-label`s included.** Naming the
  password field's toggle with `aria-label="Show password"` would have
  made every `getByLabel('Password')` match two elements. Name a control
  inside a field from its content (a visually hidden phrase, the visible
  word `aria-hidden`), so the field keeps the only matching label.
- **Settle on the page's own message, not any alert.** The root layout's
  "Could not reach the API" is a `role="alert"` too, so a scan that waited
  for any alert could run on the boot error, which had no `<title>` (axe
  `document-title`). Wait for the text (`toHaveText(/This link is invalid/)`);
  `app.html` now carries a default title for the states before a page mounts.
- **The section title is not the tab.** The section header (its `h1` and
  count) renders once the model loads; the tab's body is a lazy chunk that
  lands after it. A page helper waits for the tab's own content (the
  Transfers page's `openTransfers` waits for its rules card) before a spec
  reads anything with a non-retrying call (`allTextContents`,
  `boundingBox`, `evaluate`).
- **Reload after a save only once the page has taken it in.** The PUT's
  response reaching the network (`saveModelChanges`) is not the editor
  holding it: the save bar goes when it does. Wait for the bar to go
  (`toBeHidden`), as every save-then-reload spec does, so the reload leaves
  a saved page rather than one mid-save behind its unsaved-changes guard
  (issue #138, `transfers-page.spec.ts`).
- **An axe scan of a big page gets a test of its own, on the smallest
  fixture that reaches the state.** axe's time grows with the page
  (color-contrast most of it): thirty transfer rules are a 4,400-element
  page that scanned in 1.75 s idle and 6 s at a 4× CPU throttle, and
  with two page loads in the same test it ran out of the 30 s budget at
  twelve workers. The layout checks keep their thirty rules, one viewport
  a test; the scan runs on twelve, which still scroll inside the card and
  hold every kind of row (issue #138, `transfers-page.spec.ts`). Don't
  scan thirty copies of a row the one-state scans already cover.
- **A click on a row lands in its middle**, which may be a control that
  rightly ignores row picking (the CHIRPS row header holds its version
  select). Click the row's text instead.
- **Reference data a spec loads is global to the e2e database.** A river
  network a spec loads (`loadRiverNetwork`) is read by every project, so a
  reach planted near the synthetic DEM's valley moved other specs' clicks
  onto its channel: four delineation and sub-catchment specs in other files
  failed in the same run. Load a dataset only where the spec needs it, away
  from every other spec's points (`support/dem.ts` names the points in use),
  and prefer what needs no data (the River network layer's key entry shows
  while the layer is on, with no reach loaded).
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
- **Check diagram labels with `support/diagrams.ts`** (`checkDiagramLabels`):
  on screen, after layout, it reports every label that overlaps another, is
  crossed by a line (sampled every 2 px) or covers a symbol, straddles a box's
  edge, and the smallest text as drawn (font size × the drawing's scale). Pass
  the diagram's own selectors (the schematic's `g.node` groups a name with its
  figure). Run it on the example catchments and a big invented network, at
  1440, 1280 and 390, and on paper (`emulateMedia({ media: 'print' })`).
  Two lines of one label are one `<text>` with a `<tspan>`, or the checker
  (and a reader) sees two labels touching.
- **A layout that follows its box settles after the resize, not at it.**
  `setViewportSize` returns before the page's ResizeObservers and media-query
  change events have run, so a drawing sized from them (the Network map's
  `fill`) is still the old width's for a frame or more; a check straight after
  it measured the old drawing, or read the box and the labels on either side
  of the re-layout (`diagram-labels.spec.ts` at 390, issue #138). Have the
  component say what it was laid out for (the schematic's `data-fit`) and wait
  until that matches the box now (`waitForMapFit`), after every resize and
  every change that re-lays it out, never a sleep. A new layout sized from its
  box gets the same kind of signal. Plain CSS is caught too: the browser
  re-evaluates media queries in its next rendering update, so a box read once
  straight after the resize can still come from the old width's layout (the
  help picture's markers at 390 measured inside the 900 px sidebar grid, 143 px
  wide). A check that reads boxes once, not a retrying `expect`, resizes with
  `resizeTo` (`e2e/support/reflow.ts`), which waits two animation frames for
  that update.
- **A scroll box with nothing focusable inside fails axe**
  (`scrollable-region-focusable`): the Download → Preview table has only
  text, so a keyboard user couldn't scroll it. Give the box `tabindex="0"`,
  `role="region"` and a name, and a `:focus-visible` outline.
  A box that is short enough to read whole needn't scroll at all: API keys'
  example request fitted Settings' full width but scrolled sideways once the
  panel moved into the Project page's narrower column (issue #586), so it
  wraps instead (`white-space: pre-wrap; overflow-wrap: anywhere`). A panel
  that moves to a narrower home gets its axe scan re-run there.
- **Virtualised rows must be exactly the height the spacers assume.** The
  preview table's rows were ~29 px (the table's padding) against a
  `ROW_H` of 28, and its empty top spacer still had padding, so an 11 px gap
  sat under the header. Pin the row height (`padding-block: 0`, a fixed
  line height), render a spacer only when it has height, and test the row
  pitch, the first row under the header and the last day at the foot with
  a big case (30 units × 730 days, `download-preview.spec.ts`). The Data
  tab's Preview all data (`series/SeriesPreviewDialog.svelte`) had the same
  drift and gap until it got the same rules (`series-preview.spec.ts`,
  fifteen years); a new virtualised table copies them.
- **Screens taken for pictures pin the day they are taken on.** The landing's
  app screens were taken on the seed's day, 20 months after the examples'
  data ends, so every one warned that the rain was stale. The art spec pins
  the browser's clock (`page.clock.setFixedTime`) a few days after the data,
  and answers the one request the server dates by its own clock (the farm
  view's publication and `stale`) as the server would on that day
  (`e2e/art/landing-screens.spec.ts`). A generated picture that runs off its
  frame fails its generator rather than a reviewer: `scripts/landing-art/modules.mjs`
  refuses a hero with anything on its edge.
- **Body text is one font everywhere: the self-hosted Inter.** It used to be
  `system-ui`, which is SF Pro on a Mac, Noto Sans on the Fedora workstation
  and DejaVu Sans on CI's Ubuntu runner (about 12 % wider than Noto), so a
  layout that fit one machine wrapped on another: the crop list's phone
  sparkline column cut "Oct max 1.10 Sep" to "max …" only in CI, and #258's
  Settings bar put two links in More only in CI. `--font-sans` is now
  `'Inter'` (`frontend/static/fonts/inter-variable.woff2`, built by
  `brand/build.py body-font`), with an Arial fallback scaled to Inter's
  metrics for the moment before it loads, so a layout spec that passes on a
  laptop passes in CI and on every reader's device. Still size a fixed
  column for the text it holds with room to spare, not to the pixel: a
  reader's browser can refuse web fonts. Monospace is still the platform's
  (pinned to DejaVu Sans Mono in e2e on Linux; macOS Chromium ignores that
  pin).
- **`toContainText` reads hidden text.** It matches `textContent`, so a
  `display: none` span counts: the fold's hidden "needs fixing" made
  `not.toContainText('needs fixing')` fail and `toContainText` pass whatever
  the state. Assert a shown-or-hidden word with `getByText(…)` and
  `toBeVisible()` / `toBeHidden()`.
- **A `:has()` in a component's style doesn't see a child component's
  elements.** Svelte scopes every selector inside `:has(…)` to the
  component's own markup, so the node sheet's "needs fixing" never showed
  for a `NumberInput`'s `aria-invalid` (the input is the child's). Wrap the
  inner selector in `:global(…)`: `.sec:has(:global([aria-invalid='true'])) > summary .sec-problem`,
  and pin it in e2e with a real invalid field.
- **A closed `<details>` keeps its content out of the accessibility tree.**
  `getByRole('group', { name })` on a fieldset inside it finds nothing until
  it opens; `getByLabel` on its fields still resolves (and `fill` waits for
  them to be visible, so open the fold first: `openFold`).
- **A `grouped` `NumberInput` swaps its text on focus, so it must keep the
  selection.** It shows "1 500" at rest and "1500" to edit. The swap used to
  land on the next render, after Tab's (or Playwright's `fill`'s) select-all,
  so typing appended: `fill('60')` gave "150060", which is over the field's
  maximum, and every spec that set Fit automatically's model runs failed once
  the field was grouped. It now swaps in place in its focus handler and
  selects the text unless a press (pointer) gave the focus.
- **A fold can hold another `<details>`.** The pan row's fill tools hold the
  FAO-56 helper, so `fold.locator('summary')` matched two; `openFold` takes
  the fold's own (`:scope > summary`).
- **A `$bindable(false)` fallback throws when a caller binds an undefined
  entry.** The Reserve rule tables bind each table's fold to `foldOpen[i]`,
  which starts undefined; with `open = $bindable(false)` in `Fold.svelte`
  Svelte refused the binding and the whole tables editor failed to mount
  (`ewr-rules.spec.ts` caught it). A shared component's bindable flag takes
  no fallback and reads undefined as false.
- **Moving markup into a component moves it out of the caller's styles.**
  Svelte scopes a caller's `.words .rule` to elements the caller writes, so
  once the `<details class="words">` was `Fold`'s, the rule stopped matching.
  Reach the child's element with `:global(.words) .rule` (and a class prop
  on the component), and look at a screenshot after any extraction.
- **A `NumberInput` that isn't `nullable` never reaches `null`.** Cleared or
  given text it can't read, it keeps the last number and marks itself
  `aria-invalid` with its own message, so a check written against `null`
  (Fit automatically's "Enter a seed.") can't be reached from the page. Test
  the state the field really shows (`aria-invalid`), and key any summary of
  it on that.
- **Check non-text contrast with `support/contrast.ts`.** axe reads text
  only. `expectNonTextContrast(page, { within, marks, except })` checks every
  visible, enabled text field, select and textarea (its weakest drawn border,
  or its own fill, against the composited background of its ancestors) and
  every SVG chart mark (fill and outline, each with its opacity and its
  groups', against the chart's ground; `<line>`s are gridlines and skipped),
  at 3:1. Call it in both themes (`test.use({ colorScheme })`) on a screen
  that has loaded; `nonTextContrast` returns the failures with their
  colours. `non-text-contrast.spec.ts` runs it on Transfers, the node sheet
  and the reserve chart, with a positive control. It checks uPlot's canvas
  charts too (`canvas: false` turns that off): a series by the colour uPlot
  was configured with, read from its legend swatch (uPlot paints the swatch
  from the series' resolved stroke), and what the chart draws itself (lane
  strips, the axis labels' `--chart-axis`) from the canvas pixels, at the
  most opaque it is drawn. Pixels alone can't judge a series: one line over
  another hides it (Supplied over an equal demand read 5 %), and a thin line
  has no full-strength pixel at 1×. Run canvas checks at
  `deviceScaleFactor: 2`, and wait for each `figure.chart`'s `data-ready`
  (scroll it into view first: lower groups draw as they near the window).
  The spec covers Runs & results, Data, River & reserve, Compare and
  Hydrological units in both themes, with a real-chart control (a faint
  token) and a drawn-canvas control (a strip at 40 %, an empty swatch).
- **To test a loading state, hold the chunk by what it holds.** Production
  chunk names are bare hashes, so a route can't pick the Map's lazy chunk by
  name: fetch every `_app/immutable/**/*.js`, and hold the one whose body has
  the component's `data-testid` until the check is done
  (`small-layout-fixes.spec.ts`; Svelte may drop the attribute's quotes).
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
- Lazy panels that load together share one chunk: a module that re-exports
  them, each loader picking its export
  (`() => import('./lazySections').then((m) => ({ default: m.X }))`). Settings'
  sections that draw on every visit (`settings/lazySections.ts`) and the Map
  tab's tool sheets (`map/sheets.ts`) do this; seven chunks of their own had
  cost ~6 KB of gzip overhead in the total (issue #521). Leave out a panel
  another tab also loads lazily, or the chunk follows it there. A tool sheet
  that opens a click after its tool starts is warmed (`prefetch`) when the
  tool starts, so it never shows the loading state.
- Every ceiling change gets a dated entry with the measured numbers and
  what grew. A raise of the total is a new entry file,
  `pnpm gen:bundle-budget <slug> <kb> "<why>"`, never an edit of
  `BUDGET.totalCodeKb`, so parallel PRs don't conflict on it
  (`scripts/guards/bundle-budget/README.md`). Never raise the page ceiling
  to fit a page; move code out of the workspace page chunk instead.
