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
  (`workspace/headerSlot.svelte.ts`); it never draws its own title (Dams
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
- **Dashboards fit the window; reading pages scroll.** A dashboard (Summary,
  Network, Crops, Dams, River & reserve, Hydrological units, the portfolio) is
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
- **Cards or list on one side, the picked item's detail on the other.** Dams
  and Hydrological units: a scrolling column of items (worst first), the picked
  item's chart filling the rest, the pick in the URL so Back works. When
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
  Hydrological units show a default without writing it).
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
  the Project entry then took one row, leaving room for one more). Below that height the slot scrolls on its own
  (`flex: 0 1 auto` with an 8rem floor, `overflow-y: auto`) so the account block
  never leaves the screen; `app-sidebar.spec.ts` pins both. A new sidebar
  entry re-runs that spec.
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
    floor: the system sans varies, and DejaVu Sans (Linux, CI) draws ~15 %
    wider than the estimate, which ran names into the next node and put a
    transfer through "Melkhout Gauge".
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
    drew its notes at 7 px at 1440.
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
    the page gives elsewhere: the dam card's low is the Dam levels table's
    *Lowest in its last year* to the day, so its line is each step's lowest
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
| Overlays in the URL | `lib/workspace/overlays.ts`: `withParam`, `withoutParam`, `overlayHref`, `GRIDS` / `GRID_TAB` (a new grid is one entry plus a branch in `model/GridModal.svelte`) |
| Modals and sheets | `common/Dialog.svelte`: `full` (+ `keepInputs`), `side` (+ `wide`, body scrolls, actions pinned), `subhead` slot for what must not scroll, `beforeclose` to ask before Esc or the close button throws input away |
| Saving from a modal | `model/ModelSaveRow.svelte` (a modal hides the save bar) |
| Grids inside a modal | the existing component unchanged (`CropsTab sections` → `CropGrids`, `NetworkTab only="table"`), never a fork |
| A small chart in a row or card (sparkline) | `charts/Sparkline.svelte` (the compact pattern, § 3 "Label every chart"; `caption` required) |
| Time-series charts | `charts/LineChart.svelte` (`windows` for 30 days / 1 year / All; Earlier/Later; units switch where the old chart had one) |
| Flow vs reserve with shaded days | `overview/FlowVsReserve.svelte`, `overview/summaryChart.ts` |
| Supply colour bands | `network/farmColour.ts`, `overview/supplyBars.ts` |
| One colour per item (categorical) | `crops/cards.ts` `rankCrops` + `cropColouring` + `CROP_PALETTE` (§ 3) |
| Dam levels | `overview/damLevels.ts` (level, bands, capacity-weighted total, which dams are in a run) |
| Status pills and bars | `portfolio/StatusPill.svelte`, `portfolio/StatusBar.svelte` |
| Lazy panels | `common/Lazy.svelte`, `common/lazy.ts` |
| "On this page" menu for a page of several stacked panels past one screen | `common/SectionNav.svelte` with the page's groups (`runs/sections.ts`, `settings/sections.ts`, `river/river.ts` `riverNavGroups`, `supply/supply.ts` `SUPPLY_NAV`, `series/sections.ts`); at most two rows, the rest in More (ui.md § On this page menu) |

Finished pages to copy from: `dams/DamsTab.svelte` (cards + chart, window
fit), `supply/SupplyTab.svelte` and `river/RiverTab.svelte` (tiles, run
picker in the header, moved panels, anchor redirects),
`compare/CompareView.svelte` (several runs side by side),
`network/NetworkTab.svelte` (map page, Grids menu, node sheet),
`routes/teams/[id]/portfolio/+page.svelte` (a table that fills the window
with a sticky header), `series/SeriesTab.svelte` (a table over a chart,
window fit, the pick in the URL), `scenarios/ApplicationsTab.svelte` (a
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
- **Nested wrapping groups wrap as whole blocks.** The in-page menu was a
  flex row of groups, each a wrapping flex row of links: a long group took
  full rows of its own, so Runs & results' menu was three rows at 1280 px
  with Summary alone on the first. Flow the links like words (inline blocks)
  so a group breaks where it must, and move what doesn't fit into More
  rather than growing a third row (`common/SectionNav.svelte`).
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
- **Bring a linked item into view inside its list, after the fit is measured.**
  Allocations' `unit=` link names a row far down a list that scrolls in its
  card. `scrollIntoView({ block: 'nearest' })` on mount did nothing: the
  block's height still used top 0 (the whole window), so the row was already
  "in view" and the list shrank under it once the top was measured; with
  `block: 'center'` it scrolled the page as well. Wait until the block fits
  at its measured top, then set the list's own `scrollTop` from the two
  bounding boxes; the spec asserts the row is in the viewport and
  `window.scrollY` is 0.
- **A dialog's buttons go in its action row, even a form's.** Add data was
  its own `<dialog>` with a font ✕ (a plain "X" in some fonts) and Upload at
  the bottom left of the form, unlike every other dialog. On the shared
  Dialog, the form draws no buttons (`UploadForm`'s `external`), reports its
  submit label and state through a bound prop, and the row's button submits
  it with `form="<form id>"`, so Enter still submits. When a state swaps a
  row button (Cancel → Back while an overwrite is asked), keep one element and
  change its label, so the focus stays on it.
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
- **Pin screen use in e2e:** no page scroll, the layout reaches the window's
  bottom within a few px, the key content is inside the viewport at
  1440×960, lists scroll inside their card; a new tab or page joins the
  list in `no-pointless-scroll.spec.ts` (see `network-map.spec.ts`,
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
  box gets the same kind of signal.
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
- **Size text for the widest common sans, not this laptop's.** `system-ui`
  is Noto Sans on the Fedora workstation but DejaVu Sans on CI's Ubuntu
  runner (and most Debian/Ubuntu desktops), about 12 % wider. The crop
  list's phone sparkline column was 6rem, which held "Oct max 1.10 Sep" in
  Noto with 0.1 px to spare and cut it to "max …" in DejaVu, so the spec
  passed here and failed on CI. Give a fixed column that holds text the
  DejaVu width, and check a layout spec under it locally by running
  Playwright with `FONTCONFIG_FILE` pointing at a fontconfig file whose
  `system-ui` and `sans-serif` aliases prefer DejaVu Sans.
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
