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
   anchors to River & reserve and Units & supply) and grep the app, the
   help guides, `docs/` and `backend/src/alerts` for links to repoint.
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
  briefly had two). Notices (viewer, new data, upload result) are one slim
  line under it. The same frame shows with no data.
- **Dashboards fit the window; reading pages scroll.** A dashboard (Summary,
  Network, Crops, Dams, River & reserve, Units & supply, the portfolio) is
  exactly the height left below its top edge: measure the top and whatever
  sits below with a `ResizeObserver` on `body`, then
  `height: max(<floor>px, calc(100vh - top - below))`, only above a size
  where it makes sense (~1100×620). The page doesn't scroll; long lists
  scroll *inside their card*. Help, guides and account pages scroll normally
  with a readable text column (~75ch).
- **Cards or list on one side, the picked item's detail on the other.** Dams
  and Units & supply: a scrolling column of items (worst first), the picked
  item's chart filling the rest, the pick in the URL so Back works.
- **Design for N.** Assume 30 crops, 40 units, 10 dams, 20 runs and names
  three times longer than the seed's. A card per item works for a handful;
  past that use a compact row list that scrolls inside its column, so the
  results stay on the first screen. Don't give a 0.2 ha crop the same space
  as a 363 ha one: sort by what matters (area, shortfall, % full).
- **Container queries, not viewport media queries**, for anything inside
  the app frame: the sidebar takes 240 px, so the viewport lies about the
  space. Name the container (`container: dams-page / inline-size`).
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
  the sidebar short enough to fit a 960 px-high window.

## 3. Colour, wording, content

- **Colours are tokens** in `frontend/src/app.css` with dark-theme values
  (`--series-*`, `--accent`, `--warning`…); no raw hex in components.
- **No two named things share a colour.** A palette runs out: give colours
  to the items that matter most (largest area, most demand) and group the
  tail as one labelled "Other" that names its members. The Crops page's
  6-colour palette gave five crops the same grey.
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
  `ewr_shortfall`), so two pages never disagree.

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
with a sticky header).

Interaction details that bit:

- **Close a `<details>` menu through the element** (`el.open = false`), not
  bound state: `toggle` is async, and Escape right after opening was ignored
  in 4 of 6 runs.
- **A sticky element inside a scroll container covers controls** as they
  scroll, and axe fails the covered ones (target size). Put a picker in the
  Dialog `subhead` instead.
- **Closing an overlay drops its param with `replaceState`**, so Back
  closes the overlay rather than leaving the page.

## 5. Testing

- Every new page gets its own spec with a11y scans at desktop and phone
  (`e2e/support/a11y.ts`), and a helper module in `e2e/support/<section>.ts`
  (see `network.ts`, `crops.ts`, `river.ts`, `supply.ts`, `teams.ts`).
- **Pin screen use in e2e:** no page scroll, the layout reaches the window's
  bottom within a few px, the key content is inside the viewport at
  1440×960, lists scroll inside their card (see `network-map.spec.ts`,
  `portfolio.spec.ts`, `dams-page.spec.ts`).
- **Modals make the page inert, but Playwright still sees it.** Scope
  locators to the dialog and close it before touching the page; duplicate
  names across page and modal cause strict-mode errors.
- **Find things by their exact name.** "Runs" also matched "Compare runs";
  a card repeating a change's text caused duplicate matches in Compare.
- **Run the neighbours**, not only the spec for the screen: `a11y`,
  `golden-path`, `section-header`, `tabs-by-role`, `overview` and whatever
  links into the screen. `--repeat-each 5 --retries 0` on every new
  interaction catches races.
- Never pipe e2e output into `grep`/`head`; redirect to a file.

## 6. Bundle

- Make each new view a lazy chunk. The guard
  (`scripts/guards/check_web_bundle_budget.mjs`) counts lazy chunks in the
  total, so splitting code moves weight but also adds overhead; folding
  always-rendered lazy panels back into their tab saves it.
- Every ceiling change gets a dated change-log entry with the measured
  numbers and what grew. Never raise the largest-chunk ceiling to fit a
  page; move code out of the workspace page chunk instead.
