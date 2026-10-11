# Dark-mode audit of the workspace (issue #521, round 4, agent B)

Verified against `fix/ui-polish` at 902870f5c, 2026-10-11. Read-only: no app code changed.

## How it was checked

- **Data:** the full Showcase seed (`seed-examples.ts` with `SEED_SHOWCASE` on: 9 runs, 6 scenarios,
  map, allocations, evidence draft, notes, feeds) in the e2e database, signed in as
  `demo@example.com` (owner), as a fresh **viewer** added to the Showcase, as `farmer2@example.com`
  (two farms, English and Afrikaans), and signed out.
- **Theme:** `colorScheme: 'dark'` (Playwright `emulateMedia`). The app has **no theme toggle**:
  `data-theme` is only set to `light` while printing (`report/printTheme.ts`), so the OS preference is
  the only switch.
- **Sizes:** 1440×900 and 390×844, every screen.
- **Screens (246 captures):** all 17 workspace tabs, each first as loaded and then with every
  `<details>` fold open and Settings' "Explain each setting under its field" on; the node sheet,
  the six grids (`grid=nodes|crop-factors|planted-areas|demands|systems|transfers`), the paste dialog,
  Add data, New project, the scenario editor, the series preview, the run record, Things to check,
  Add a registered volume, the Map with every layer on; project list, account, teams, a team,
  alerts, compare, help (index, glossary, formats and **all 34 guides**), data sources, methods,
  privacy, the report page; login, register, `/welcome`, `/welcome/af`; the farmer's picker, farm view,
  dam, why, who decides, words and account in both languages; 8 tabs as a viewer.
- **Measured, not eyeballed** (an in-page script; all ratios WCAG 2.x relative luminance):
  - every visible text node (60 167): its computed colour, with ancestor opacity, over the composited
    background of its ancestors, against 4.5:1 (3:1 for large text); disabled controls reported apart;
  - every text field and select: its border (or its own fill) against the ground around it, 3:1;
  - every SVG shape and SVG text against the SVG's ground, 3:1 and 4.5:1;
  - every `<img>`: the luminance of its edge pixels;
  - every uPlot chart: the series and axis tokens in force on it, against its ground;
  - backgrounds lighter than L 0.35 in dark mode (hard-coded light patches);
  - focus: 30 Tab presses per main screen (413 stops), the outline or box-shadow colour against the
    ground around the control and the control's own fill;
  - axe-core `color-contrast` on 207 of the captures (not the map, whose canvas axe can't read).
- **Second pass:** a grep of `frontend/src` for raw colour literals outside `app.css` (hex, `white`,
  `rgb()`), ignoring `var(--x, fallback)`, and for colour names in UI copy; plus every dark token pair
  in `app.css` computed from the file.

Screenshots: `/tmp/claude-1000/-home-jared-github-project-water-management/fa8023e6-89fe-4b9e-be62-146f48a10460/scratchpad/r4-dark/`
(`<who>-<screen>-<width>.png`; `crops/` holds cut-up sheets of the tall pages). Raw measurements:
`…/r4-dark/data/*.json`, summary `…/r4-dark/agg-all2.txt`.

## Headline

Dark mode is in good shape where it matters most: **no text anywhere fails 4.5:1** (0 of 60 167
text nodes, 0 axe `color-contrast` violations), every status colour clears AA on every ground it
sits on (danger ≥ 5.1, warning ≥ 7.0, success ≥ 6.6, accent ≥ 7.2, text-muted ≥ 5.1, including
the soft tints and the flagged-row tint), the focus ring (`--focus` #5cc8e0) is 7.2–9.6:1 on
every workspace ground, and the chart tokens all clear 3:1 on the card (`--series-*` 3.2–5.9 on
`--surface-2` and up, `--chart-obs` 14.0, `--chart-ref` 6.4, axis 6.4). The landing page swaps to
its dusk hero and dark screenshots, and the help diagrams follow the tokens.

What's left is mostly in **non-text parts**: one shared control whose outline vanishes (in both themes),
MapLibre's light chrome on every map, dialogs that lose their edge on a dark page, a few faded
chart marks, and copy that names colours that change with the theme.

## Findings, ranked (severity × how often seen)

### 1. FlowUnitSelect's outline is 1.3–1.5:1: the unit picker beside every flow field barely reads as a control (High, both themes)

- **Where:** Transfers (each rule's "Rates in" unit), the node sheet (Routing, Supply, pump fields),
  the Hydrological unit table, anywhere a flow field has its m³/s · l/s · m³/day picker. Seen on 10 of
  the captured screens, at both widths.
- **File:** `frontend/src/lib/components/network/FlowUnitSelect.svelte:22`:
  `border: 1px solid var(--border)`, `background: transparent`, text `--text-muted`.
- **Measured:** border #333633 on `--bg` #121312 **1.52:1**, on `--surface` #1a1b1a **1.41:1**, on
  `--surface-2` #222422 **1.28:1** (dark); light `--border` #d9dcd9 on `--surface` 1.36:1. WCAG 1.4.11
  needs 3:1 for a control's boundary; the text inside passes, but nothing marks it as a select apart
  from the small arrow.
- **Screenshots:** `owner-tab-transfers-1440.png` (top right, "Rates in m³/s"),
  `owner-dlg-node-sheet-1440.png`, `owner-dlg-grid-nodes-1440.png`.
- **Fix:** `border: 1px solid var(--border-input)`, the token made for this (3.42 on `--surface`,
  3.09 on `--surface-2`, 3.68 on `--bg` dark; ≥ 3 in light). Keep the compact size. Add an e2e check
  like the a11y spec's boundary checks: the select's border colour vs its parent's background ≥ 3.

### 2. MapLibre's zoom buttons and attribution stay white on the dark map, with MapLibre's own focus ring (Medium, every map)

- **Where:** Map tab, the farm view's map (both languages, 390 and 1440), the Allocations map:
  every place `NavigationControl` / `AttributionControl` is added.
- **Files:** `frontend/src/lib/components/map/CatchmentMap.svelte:480-482`,
  `frontend/src/lib/components/allocations/AllocationMap.svelte:138-140`; the styles come unchanged
  from `maplibre-gl/dist/maplibre-gl.css` (imported in `map/maplibre.ts:8`). The only override
  is the farm view's target size (`farm/FarmMapCanvas.svelte:80`).
- **Measured:** `.maplibregl-ctrl-group` background **#ffffff** (L 1.0) on the dark basemap
  #161917: a bright 29 × 58 px patch, the only hard-coded light surface found in the workspace.
  Its focus ring is MapLibre's `box-shadow … #0096ff`, **3.09:1** on the white button, not the app's
  `--focus` (9.2:1), so the map's buttons are the one place the ring looks different.
- **Screenshots:** `owner-dlg-map-layers-1440.png` (top right of the map), `farmer-en-view-390.png`
  (map card), `crops/farmer-view-a.png`.
- **Fix:** one global block next to the import (e.g. a `:global` style in `CatchmentMap.svelte` and
  `AllocationMap.svelte`, or a small `maplibre-theme.css` imported by `map/maplibre.ts`):
  `.maplibregl-ctrl-group { background: var(--surface); border: 1px solid var(--border-input); box-shadow: var(--shadow); }`,
  `.maplibregl-ctrl-group button + button { border-top-color: var(--border); }`,
  `.maplibregl-ctrl button:focus-visible { box-shadow: none; outline: 2px solid var(--focus); outline-offset: 1px; }`,
  and under `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) .maplibregl-ctrl-icon { filter: invert(1); } }`
  (the icons are black SVG background images). Theme the attribution the same way
  (`.maplibregl-ctrl-attrib { background: color-mix(in srgb, var(--surface) 80%, transparent); color: var(--text-2); }`,
  links `--accent`). Put a dark-theme screenshot case in `catchment-map.spec.ts` that reads the control
  group's computed background.

### 3. Dialogs lose their edge on the dark page (Medium, every dialog and sheet)

- **Where:** every `Dialog` (Add data, New project, the node sheet, the grids, paste dialogs, Add a
  registered volume, confirmations), worst with a dialog over a dialog (Paste planted areas over the
  Planted areas grid).
- **File:** `frontend/src/lib/components/common/Dialog.svelte:196` (`border: 1px solid var(--border)`),
  `:212` (`box-shadow: 0 10px 30px rgb(0 0 0 / 0.2)`), `:320` (`::backdrop rgb(0 0 0 / 0.35)`).
- **Measured (dark):** the backdrop takes the page from #121312 to #0c0d0c and a card to #111211;
  the dialog's `--surface` #1a1b1a against that is **1.09–1.13:1**, its border #333633 **1.53:1**, and a
  20 % black shadow is invisible on a near-black page. In light the same dialog stands
  **2.45:1** off its dimmed page, so dark mode loses the separation light mode has.
  (Not a WCAG failure in itself; the dialog is announced and traps focus, but on a phone the sheet
  and the page behind read as one surface.)
- **Screenshots:** `owner-dlg-add-data-1440.png`, `owner-dlg-paste-1440.png`,
  `owner-dlg-new-project-1440.png`, sheet `crops/dlg1.png`.
- **Fix:** give overlays their own tokens in `app.css` instead of literals:
  `--overlay-backdrop: rgb(0 0 0 / 0.35)` (dark `rgb(0 0 0 / 0.6)`),
  `--overlay-border: var(--border)` (dark `var(--border-strong)`, 2.2:1 on the dimmed page),
  `--overlay-shadow: 0 10px 30px rgb(0 0 0 / 0.2)` (dark `0 10px 30px rgb(0 0 0 / 0.7)`), and use them in
  `Dialog.svelte`. The same literal shadows recur in the popovers
  (`common/SectionNav.svelte:719`, `help/HelpTip.svelte:211`, `overview/SetupPill.svelte:129`,
  `map/MapSetupPill.svelte:172`, `export/DownloadMenu.svelte:218`, `compare/CompareView.svelte:831`,
  `map/MapTab.svelte:1950`, `projects/ProjectTable.svelte:498`, `model/SaveBar.svelte:177`): switch them
  to the same `--overlay-shadow` (that's the third caller and more, so one token is warranted).

### 4. Copy that names colours the dark theme changes (Medium, playbook § 3 "Don't name a thing by its colour in text")

- **"Darker cells are months of higher demand."**
  `frontend/src/lib/components/network/DemandsTable.svelte:262` (Demands grid) and
  `frontend/src/lib/components/crops/DemandTable.svelte:79` (Crops page's table). The cells are
  `color-mix(… var(--brand-outlet) 45% …)` (`DemandsTable.svelte:363`); in dark `--brand-outlet` is
  #36c6e0, so a higher demand is a **brighter** teal, and the sentence is backwards.
  Screenshot: `owner-dlg-grid-demands-1440.png` (bottom note). Fix: "The stronger a cell's shade,
  the higher that month's demand."
- **"The point goes on the nearest terrain channel (the red lines)."**
  `frontend/src/lib/components/map/DelineateSheet.svelte:236`. `channelColour` is #ff6b57
  (orange-red) in dark (`map/mapStyle.ts:464`); the playbook records this exact confusion
  (2026-10-03) and the bar was fixed to name the channels with their swatch, but this line in the
  sheet still names them by colour. Fix: "the nearest terrain channel (Terrain channels in the
  key)", or reuse `delineationLines` from `map/mapList.ts` with its swatch.
- Lower: `compare/FarmDeltaTable.svelte:63` "green = better, red = worse, grey = no judgement" (the
  arrows carry it; the hues do hold across themes): "▲/▼ coloured as better or worse, plain = no
  judgement" would follow the rule.

### 5. Faded part-year bars fall under 3:1 (Low-Medium, River & reserve, Compare runs, the report)

- **File:** `frontend/src/lib/components/compare/ReserveYearsChart.svelte:135`
  (`opacity={v.complete ? 1 : 0.45}`).
- **Measured (dark, on `--surface`):** the run's orange `--series-2` at 45 % is #70371f, **1.85:1**;
  the baseline's grey at 45 % #545653, **2.33:1** (light is weaker still on white). The part-year bars
  are the first and last water years, so the edges of every chart fade out. The table under it and
  the note ("Faded bars are part years") carry the numbers, so this isn't data loss, but the bar is a
  graphical object needed to read the chart (1.4.11).
- **Screenshots:** `crops/owner-tab-river-open-1440-00.png` (right card, 2009/10 and 2024/25),
  `crops/owner-tab-compare-open-1440-00.png`.
- **Fix:** keep the bar's outline at full strength and fade only the fill: `fill-opacity={v.complete ? 1 : 0.35}`
  plus `stroke={r.colour} stroke-width="1.25"` on part years (the outline is then 4.45:1 in dark), or a
  hatch pattern in the run's colour. Change the note to "Outlined bars are part years".

### 6. A disabled primary button still looks enabled in dark (Low, frequent)

- **File:** `frontend/src/app.css:266-268` (`.btn:disabled { opacity: 0.55 }`).
- **Measured:** `--accent` #5cc8e0 at 55 % over `--surface` becomes a mid teal (≈ #3e7a87 on `--surface`), its text 3.06:1
  against the button: in light the same button turns pale and clearly off, in dark it reads as a secondary
  coloured button ("Save name", "Add note", "Add", "Make link", "Save" on the Allocations band,
  "Save notes" in the run record; 51 instances on 45 captures). Disabled controls are exempt from
  1.4.3, so this is about affordance, not a failure.
- **Screenshots:** `owner-page-account-1440.png` ("Save name"), `farmer-en-view-390.png` ("Add note").
- **Fix:** under the dark block, `.btn-primary:disabled { background: var(--surface-2); border-color: var(--border-strong); color: var(--text-muted); opacity: 1; }`
  (text-muted on surface-2 is 5.8:1, and it is plainly not the call to action), or one rule for both
  themes so they match.

### 7. Help pictures are bright daylight renders on the dark page (Low, help guides)

- **Where:** every guide with a picture tour (`static/help/*.webp`, e.g. "A day on one hydrological
  unit"): a ~440 × 270 px pale green and beige block, the brightest thing in the dark workspace.
- **File:** `frontend/src/lib/components/help/PictureTour.svelte:37-38`.
- **Measured:** the sky and ground edge rows average 0.60–0.72 grey (ImageMagick) and the farm render
  is mostly light; the numbered markers on it are fixed navy with a white ring and read on any scene
  (by design, `PictureTour.svelte:143-148`).
- **Screenshot:** `crops/guide-a.png` (left).
- **Fix (cheap):** in dark, `.picture img { filter: brightness(0.85) contrast(1.05); }` and a
  `--border` frame. **Fix (durable):** render a dusk variant with the existing Blender pipeline
  (`pnpm gen:help-art`) and serve it through `<picture media="(prefers-color-scheme: dark)">`, as
  the landing hero already does (`landing/Diorama.svelte`).

### 8. Off-palette and dead dark-mode CSS (Low, consistency)

- `frontend/src/lib/components/reliability/WaterAccountPanel.svelte:123-128` defines six raw hex
  segment colours (`--seg-0` … `--seg-5`) with **no dark values**. They clear 3:1 in dark
  (3.69–5.49 on `--surface`) but break the playbook rule "Colours are tokens … no raw hex in
  components" and the categorical palette order; `--seg-3` #8a5bd6 next to `--seg-0` #2a78d6 is the
  pair the palette deliberately avoids. Fix: `--series-1, -2, -3, -5, -8, -9` in palette order.
- `frontend/src/lib/components/charts/LineChart.svelte:595` and
  `frontend/src/lib/components/ewr/EwrHeatmap.svelte:270` each repeat their dark block under
  `:root[data-theme='dark']`, but `app.css` has no `data-theme='dark'` rule (only
  `:root:not([data-theme='light'])` inside the media query), and no code sets it. Either delete those
  two blocks, or, if a theme toggle is wanted later, add the `[data-theme='dark']` copy of the token block
  to `app.css` and keep them. Today they're dead code that suggests a toggle that doesn't exist.

## Checked and fine

Text contrast everywhere (0 failures; tightest real pairs `--text-muted` on `--accent-soft` 5.13 and
on the flagged row 5.19); the status colours and their soft tints; the focus ring on every
workspace ground (413 stops, min 7.17:1, on the accent-soft "new data" strip, apart from MapLibre's buttons; the stretched-link cards
— Needs attention, Latest run, Project facts, Dams, Units, Allocations — move the ring onto the card
by design); form inputs and selects other than #1 (`--border-input` ≥ 3.09); uPlot lines and grids
(the grid at 1.28:1 is a decoration, not data); the EWR heatmap (its own dark ramp, ink chosen per
step); the stress strip's dark ramp (lighter = worse on dark, the cell text says the class); the
Network schematic (dam boxes have a cyan outline, halos in `--surface-sunken`); the map overlay,
quaternary, river, channel, proposal and CHIRPS colours (all dark-aware in `mapStyle.ts`); the
landing (dusk hero, dark screenshots via `<picture media>`); the sign-in panel (a fixed navy panel by
design, fine in both themes); the farm view in English and Afrikaans; the report page on screen; the
2FA QR code (white quiet zone on purpose). The many SVG "fails" the script raised were checked by
eye and are fills of zero-area lines, the brand mark (logos are exempt), or fills drawn inside a
stroked shape.

## Found along the way (outside dark mode; not fixed)

- **Flow-duration curve, log scale:** the y axis draws a label for every decade down to `1e-19`, so the
  labels overlap into a solid block (`crops/owner-tab-runs-open-1440-01.png`). The Showcase's
  observed flow reaches zero, so the log axis runs down to the float floor. Both themes. For agent D
  (or a follow-up): clamp the log axis's minimum at the smallest positive value shown (or 1e-3 of the
  max) and thin the ticks.
- **Map tab at 390 while the map loads:** the tool column (Measure, Draw, Point, Delineate, Trace)
  runs out of the collapsed map card and over the Features list (`crops/phone-a.png`, bottom left).
  For agent C's phone audit.
- **Share the pain's "below its equitable share" pill** wraps into a tall rounded blob in a narrow
  cell (`crops/owner-tab-supply-open-1440-02.png`, Vleiplaas): `border-radius: 999px` on multi-line
  text. Use `--radius-sm` once it wraps, or `white-space: nowrap` with the figure on its own line.
- **e2e/a11y gap:** `a11y.spec.ts` scans dark mode with axe, but axe has no rule for 1.4.11
  (non-text contrast), which is how #1 and #5 got through in both themes. A small shared helper
  (control boundary vs parent background ≥ 3, for every `select`/`input` on a scanned screen) in
  `e2e/support/a11y.ts` would guard it.
