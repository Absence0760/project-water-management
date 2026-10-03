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
   moves, redirect its old URL (the Runs tab redirects moved `#res-…`
   anchors to River & reserve and Hydrological units; the Summary sends its
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
  (`workspace/headerSlot.svelte.ts`), and a status pill of its own beside
  the rain pill as `status` (the Summary's **Setup complete**); it never
  draws its own title (Dams
  briefly had two). A view that is also a standalone page draws its title
  only there: Compare runs showed "Compare runs" twice in the workspace
  (the header's `h1` and its own `h2`, 65 px) until it filled the header
  with its context and actions when inside a tab and kept its own `h1`
  only on `/compare`. A section whose main action replaces Run model passes
  it as `main`, rendered last after a plain Add data: Runs & results' run
  form (label, Run forecast, Run model) went there from a full-width panel
  that pushed the results 110 px down, its status one slim line under the
  header. Notices (viewer, new data, upload result) are one slim
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
- **Pick a default rather than show an empty half.** With nothing in the
  URL, open the first item and write it with `replaceState`, so Back leaves
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
  On a phone a wide edit grid becomes one card per row (the crop grids, the
  node table): restyle the same markup, so the inputs, names and tests stay
  one set, and give each field a visible label that names its group, since
  the group header row is gone ("Dam capacity", not "Capacity"). Let the
  cards scroll with the modal: `.table-wrap`'s 70vh cap made the node cards
  a scroll box inside a scroll box, with Add node out of reach below it.
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
  row to spare with all 17. Below that height the slot scrolls on its own
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
  that every name lands whole on exactly one page.
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
- **Wording:** the modeller workspace says **unit** for a farm node (#54);
  the farmer view, API and CSV say farm. Farmer-facing pages (farm view,
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
| Asking before an action (delete, revoke, submit, discard) | `await confirmDialog({ title, message, confirmLabel, danger })` (`common/confirm.svelte.ts`, shown by the root layout's `ConfirmHost`): never the browser's `confirm()`, which `lib/noBrowserConfirm.test.ts` refuses. Title the question, name the button after the action; e2e answers it with `answerConfirm` (`e2e/support/confirm.ts`) |
| Unsaved input a navigation would drop | `guardUnsaved({ dirty, what, leaves })` (`lib/nav/unsaved.ts`) during component init: the root layout's leave guard asks once, naming it and the destination. A form's state that must outlive a tab change belongs to the page (`project/detailsDraft.svelte.ts`) and its save bar |
| Saving from a modal | `model/ModelSaveRow.svelte` (a modal hides the save bar) |
| Reading a picked or dropped file | `latestFileText()` (`lib/files/latest.ts`), one reader per file box: the picker stays live while a file is read, so a large file's read could land after a smaller one picked next, under its name (issue #384). A read followed by a request (a preview) checks the pick is still current after each await (`allocations/AllocationImport.svelte`'s `generation`, `map/UploadSheet.svelte`) |
| Grids inside a modal | the existing component unchanged (`CropsTab sections` → `CropGrids`, `NetworkTab only="table"`), never a fork |
| A small chart in a row or card (sparkline) | `charts/Sparkline.svelte` (the compact pattern, § 3 "Label every chart"; `caption` required) |
| Time-series charts | `charts/LineChart.svelte` (`windows` for 30 days / 1 year / All; Earlier/Later; units switch where the old chart had one) |
| Flow vs reserve with shaded days | `overview/FlowVsReserve.svelte`, `overview/summaryChart.ts` |
| Supply colour bands | `network/farmColour.ts`, `overview/supplyBars.ts` |
| One colour per item (categorical) | `crops/cards.ts` `rankCrops` + `cropColouring` + `CROP_PALETTE` (§ 3) |
| Dam levels | `overview/damLevels.ts` (level, bands, capacity-weighted total, which dams are in a run) |
| Status pills and bars | `portfolio/StatusPill.svelte`, `portfolio/StatusBar.svelte` |
| Lazy panels | `common/Lazy.svelte`, `common/lazy.ts` |
| A panel of values proposed from the map (the modeller decides) | `proposals/ProposalPanel.svelte` (heading, intro, controls, the live notice focused after a Use via `focusNotice()`, the busy/`data-ready` body, failure with Try again; `variant` page, drawer or inline) with `ProposalNoDataset`, `ProposalSynthetic` and `ProposalSource`; the panel keeps its own rows and Use (land cover, dams, evaporation) |
| "On this page" menu for a page of several stacked panels past one screen | `common/SectionNav.svelte` with the page's groups (`runs/sections.ts`, `settings/sections.ts`, `river/river.ts` `riverNavGroups`, `supply/supply.ts` `SUPPLY_NAV`, `series/sections.ts`); at most two rows, the rest in More (ui.md § On this page menu) |

Finished pages to copy from: `dams/DamsTab.svelte` (cards + chart, window
fit), `supply/SupplyTab.svelte` and `river/RiverTab.svelte` (tiles, run
picker in the header, moved panels, anchor redirects),
`compare/CompareView.svelte` (several runs side by side),
`network/NetworkTab.svelte` (map page, Tables menu, node sheet),
`series/SeriesTab.svelte` (a table over a chart in
the window's one scroll, the long table folded under "Show all N series"
with the picked row kept, the pick in the URL), `scenarios/ApplicationsTab.svelte` (a
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
- **Closing an overlay drops its param with `replaceState`**, so Back
  closes the overlay rather than leaving the page. A create dialog
  (Scenarios' `new=1`) that navigates on success lets the URL close it: drop
  the param in the same `goto` that picks the new item (with
  `replaceState`), rather than setting its `open` to false first, which
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
  the space as `{' '}` inside the span.
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
- **A fragment into a lazy tab needs the tab to land it.** Workspace tabs
  are lazy chunks, so the browser's own jump to `#set-ewr` runs before the
  element exists and the page opens at the top. Settings' note links
  (`?tab=settings#set-…`) had silently done that until its page spec
  followed one; the tab now finds the element on mount and holds it with
  `holdAnchor` (`help/anchor.ts`), focusing its heading, as River & reserve,
  Hydrological units, Runs, Data and Project do. Test a fragment link by *loading* it,
  not only by clicking the in-page menu. And a `page.goto` that changes only
  the fragment is a same-page jump, not a load: the River menu's first
  "loaded link" test passed on such a jump without loading anything, and the
  Data one failed on it (no mount, so no focus). Go to another tab first.
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
  no count to show; Settings & calibration's context line says where the
  runoff parameters came from (the fit's day and score, "changed since the
  fit", or no fit record) and its action jumps to the fit. Find the one fact
  a user opens the page to check, and put it there. It describes the
  section, not the filter: History's "Latest change today 14:05 by Ann:
  Model changed" stays the latest of all while the list is filtered to one
  unit (a small unfiltered read beside the filtered one), so a filter never
  makes the header claim something false.
- **Width rules for a field's inputs catch its checkbox.** Settings'
  `.field input { width: 100% }` stretched "Vary it by month"'s box across
  the field, with the words half a field away. Scope such rules with
  `input:not([type='checkbox'])`.
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
- **An add form above a long list, not under it.** The notes dialog put
  "Add a note" under the notes: with thirty it was 2,300 px down, and Close
  with it. It is now a side sheet with the form on top, the notes scrolling
  under it and Close pinned (`notes/NotesDrawer.svelte`).
- **Don't disable a control while its own change saves.** The alert emails
  page disabled each catchment's fieldset during a save, so an arrow key on
  a radio moved the choice and then threw the keyboard's focus to the page.
  Keep the controls live, mark the card `aria-busy`, and send one item's
  saves in order, taking the server's answer once the last is back.
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

## 5. Testing

- Every new page gets its own spec with a11y scans at desktop and phone
  (`e2e/support/a11y.ts`), and a helper module in `e2e/support/<section>.ts`
  (see `network.ts`, `crops.ts`, `river.ts`, `supply.ts`, `teams.ts`, `data.ts`,
  `scenarios.ts`, `allocations.ts`).
- **A closed `<details>` still lays out its content in Chromium.** Its
  children keep a `scrollHeight` (the panel is hidden with
  `content-visibility`), so a check for "nothing scrolls inside itself"
  counted River & reserve's closed *Show as a table* and *Values for* boxes.
  Filter on `el.checkVisibility()` first (`river-page.spec.ts`
  `innerScrollers`).
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
- Every ceiling change gets a dated entry with the measured numbers and
  what grew. A raise of the total is a new entry file,
  `pnpm gen:bundle-budget <slug> <kb> "<why>"`, never an edit of
  `BUDGET.totalCodeKb`, so parallel PRs don't conflict on it
  (`scripts/guards/bundle-budget/README.md`). Never raise the page ceiling
  to fit a page; move code out of the workspace page chunk instead.
