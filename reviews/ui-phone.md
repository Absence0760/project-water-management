# Phone audit: workspace, farmer pages in Afrikaans, Upload GeoJSON, Account (issue #521, round 4, agent C)

Audited against `fix/ui-polish` at 902870f5c, read-only. Data: `seed:examples` with
the Showcase on (SEED_SHOWCASE unset), signed in as demo@ (owner), a fresh viewer
added to the Showcase, and farmer2@ (Kransdal + Rivieroewer). The numbers come from a
throwaway Playwright spec against the e2e production build: bounding boxes,
computed font sizes, scroll widths and keyboard focus. The spec has been deleted.

Screenshots are in
`/tmp/claude-1000/-home-jared-github-project-water-management/fa8023e6-89fe-4b9e-be62-146f48a10460/scratchpad/r4-phone/`
(written `r4-phone/` below). Every page has a full-page PNG named
`owner-{390,360}-<tab>.png`, `viewer-390-<tab>.png` or `farm-af-320-*.png`, and
its numbers are in `measure-*.json` beside it.

Note on the 15 px: desktop Chromium draws a classic scrollbar, so the page's
`clientWidth` is 375 at 390 and 345 at 360. On a real phone the content is
15 px wider than shown, so every width below errs on the safe side.

Ranked by severity × how often the screen is used on a phone. Farmers mostly
use phones, and hydrologists mostly use desktops.

---

## 1. Farmer main page: the supply card starts below the fold at 360×740 (spec: at the fold), and well below it at 320 in Afrikaans. **High**

- **Where:** `/farm/:id`, farm with a restricted notice (the usual case when the page matters).
- **Files:** `frontend/src/lib/components/farm/FarmPage.svelte` (card order),
  `farm/EstimateNote.svelte:15-27` (padding 12/14 px, 16 px type, 1.45 line height),
  `farm/NoticeCard.svelte:54,96` (16 px padding, byline row).
- **Measured** (top of "Water you received this season"):

  | viewport | language | notice top | estimate line top | supply card top | fold |
  | --- | --- | --- | --- | --- | --- |
  | 390×844 | en | 280 | — | 731 | 844 ✓ |
  | 360×740 | en | 299 | 533 | **796** | 740 ✗ +56 |
  | 360×740 | af | 299 | 579 | **866** | 740 ✗ +126 |
  | 320×640 | en | 324 | — | **867** | 640 ✗ +227 |
  | 320×640 | af | 324 | 604 | **890** | 640 ✗ +250 |

  `docs/design/farmer-view.md` § 6.1 promises: "with a notice, the supply card
  starts at the fold" on 360×740. The estimate line went in before the first
  figure later (issue #47, legal), adding 250–290 px, and the promise no longer holds.
- **Screenshots:** `r4-phone/c-farmP-first.png` (320 af, first screen),
  `r4-phone/farm-en-360-P.png`, `r4-phone/farm-af-360-P.png`, `r4-phone/sm-farmP12.png` (whole page).
- **Fix:** keep the words and the order, which is a legal requirement. Win back the height on phones:
  1. `EstimateNote`: under 400 px, padding 8px 12px, icon 16 px inline with the first line,
     line-height 1.35. That saves about 40 px in English and 50 px in Afrikaans, and the text stays 16 px.
  2. `NoticeCard`: padding 16 → 12 px, and the byline ("Demo Hydrologist, 11 Okt. 2026")
     at the end of the last paragraph rather than on its own row (about 30 px).
  3. Title block: the amber published line in Afrikaans is 4 lines at 320. Put
     "(21 maande gelede)" on the same line as the date, with no forced break. Its
     sentence "Vra jou WGV of nuwer syfers op pad is." can follow the date.
  4. Change the spec sentence to what is measurable, and pin it: `farm-view.spec.ts` at
     360×740 in en and af, supply card heading top ≤ 740 + 40 (the heading in the window).
  If that still misses in Afrikaans, ask legal for a phone-length estimate line (the
  shorter line goes through the i18n agents). That is not a layout decision.

## 2. The workspace header takes 48–78 % of the first phone screen on every tab. **High**

- **Where:** every workspace tab, owner and viewer, at 390 and 360.
- **Files:** `frontend/src/routes/projects/[id]/+page.svelte:910-921` (project-name
  line + section toggle), `:849-881` (`headerNotices`: View only, new-data line),
  `frontend/src/lib/components/workspace/SectionHeader.svelte:31-37` (title line + guide link)
  and `:138-208` (narrow container: status own row, each control a full row).
- **Measured:** the bottom of the section header, including its notices, in page px. At
  scroll 0 the first screen is 844 or 740 px.

  | tab | owner 390 | owner 360 | viewer 390 |
  | --- | --- | --- | --- |
  | Network | 506 (60 %) | **579 (78 %)** | — |
  | Allocations | 506 | **579 (78 %)** | 487 |
  | Crops, Dams, Supply, Applications | 506 | 528 (71 %) | 487 |
  | River & reserve | 509 | 531 (72 %) | 490 |
  | Transfers | 488 | 510 (69 %) | — |
  | Settings, History | 437 / 441 | 481 (65 %) | — |
  | Summary | 407 | 429 (58 %) | 388 |

  The stack at 360 on Network, top to bottom: phone bar 52, project name + Owner
  (2 lines, 40), Sections toggle 44, `h1` "Network" (the same word as the toggle) +
  "How this page works", 2-line context, rain pill 44, [Map][Tables ▾] 44, + Add
  hydrological unit 44, + Add other user 44, [Add data][Run model] 44, new-data line
  with its own **Re-run model** button (70). The first card starts at 593.
- **Screenshots:** `r4-phone/first-360-a.png` (Network, Summary, Settings),
  `r4-phone/first-360-b.png` (Runs, Hydrological units),
  `r4-phone/crop-owner-390-allocations-first.png`.
- **Fix** (playbook § 2 "A head of named actions folds into one control on a phone,
  keeping the names"; nothing dropped):
  1. **Fold the tab's own buttons into one ⋯ menu under 640 px** that names each one
     (Network: Map, Tables, Add other user; Allocations: Download CSV, Import; Dams:
     Hydrological unit table, Open in Runs & results). Keep one primary "+ Add …" as a
     named button beside it, so the own group is one row. This saves 50–100 px.
  2. **The new-data line on a phone:** its Re-run model sits 8 px under the header's Run
     model and does the same thing. Under 640 px, draw the line as one line of text (a
     `.note` with no button) and label the header's button **Re-run model** while
     `behind` is true. That saves about 50 px. On desktop, keep both.
  3. **"How this page works"** wraps to its own line under long titles (Settings at
     360) and is 18 px tall, below the 24 px floor (see #10). On a phone, put it in the
     Sections menu panel as its first link, or make it a 44 px "?" icon button after
     the `h1` with that name. That saves 20 px where it wraps.
  4. **Project name:** move it into the phone bar in place of the "Water Management"
     word mark (the logo stays), with the role badge. The toggle row then starts at 60,
     not 98, saving about 38 px.
  Together these save 150–250 px: content at about 330–400 instead of 430–593 at 360.
  Pin with `workspace-phone.spec.ts`: the section header's bottom ≤ 50 % of 740 at
  360 on every tab in its SECTIONS list.

## 3. Every model-edit sheet has a 3-row, 140 px save footer on a phone, even with nothing to save. **High**

- **Where:** node sheet (`?edit=`), Hydrological unit table (`?grid=nodes`), crops
  planted-areas drawer (`?farm=`), every other sheet that renders `ModelSaveRow`.
- **File:** `frontend/src/lib/components/model/ModelSaveRow.svelte:82-115` (status `p`, reason,
  `.buttons` with "Discard model changes", "Done", "Save changes"), styles `:117-140`
  (`flex-wrap: wrap; justify-content: flex-end`).
- **Measured** at 390×844: the status line at 708, [Discard model changes][Done] at 732–776,
  [Save changes] alone at 783–827. The footer takes 844 − 700 = **144 px (17 %)**. The node
  sheet's body is **545 px** tall for a 2,394 px form. When dirty, the reason field
  adds a fourth row (about 190 px).
- **Screenshots:** `r4-phone/ov-trio.png` (node sheet, drawer, grid, all clean).
- **Fix:** under 640 px, make it one row of three equal buttons: **Done**, **Discard** (its
  accessible name stays "Discard model changes"), **Save**. Show the reason field only once
  dirty (it already is), and hide the "No unsaved changes" line while clean (the
  disabled Save says it, and the live region can stay `visually-hidden`). Result: 60 px clean,
  110 px dirty. Do the same to the Settings save bar (`r4-phone/focus-settings-dirty-390.png`:
  **143 px**, status + reason + [Preview][Discard][Save changes]): put the status as a dot
  and a short label in the button row.
  Pin it in `workspace-phone.spec.ts`'s overlay test: footer height ≤ 64 px when clean at 390.

## 4. Project → Shared directly with: the members table clips Leave/Remove at 390, its role selects are 25 px tall, and it has no scroll cue. **Medium**

- **Where:** Project tab, Members panel (owner).
- **File:** `frontend/src/lib/components/project/MembersPanel.svelte:191-285` (a 4-column `table.data`),
  `:388-395` (the only phone rule hides the email column); `frontend/src/app.css:576-580`
  (`table.data td select` padding 0.2rem → 25 px).
- **Measured** at 390: the table scrolls 308 → 440 px with no shadow and no sticky
  column. "Leave" shows as "Lea" and "Remove" as "Remo" at the right edge. The role
  `select` is 123×**25**, the applying-party input 96×**25**, and "demo@example.com"
  breaks as "demo@example. / com".
- **Screenshot:** `r4-phone/crop-project-members-390.png`.
- **Fix** (playbook § 2 "On a phone a wide edit grid becomes one card per row"): under
  560 px, make each member a card: name, then email (one line, `overflow-wrap: anywhere`
  only as a fallback), then [Role select 44 px, full width], then the authority checkbox /
  party field, then **Leave/Remove** right-aligned at 44 px. Same markup, a container query.
  The add-member row is fine already.

## 5. Edit grids and forms keep 21–30 px controls on a phone. **Medium**

- **Measured** at 390 (h = height of the control, or of its label for a checkbox):

  | where | control | size | file |
  | --- | --- | --- | --- |
  | Allocations → Add a registered volume, months | 12 checkbox labels | 50–54 × **21** | `allocations/AllocationForm.svelte:208` |
  | Crops → planted-areas drawer | ha input, irrigation select | 111 × **25** | `crops/FarmCropsDrawer.svelte` |
  | Network → Hydrological unit table | kind/drains selects, area inputs | 137 × **25**; name 284 × 30; ↑ ↓ 24 × 24 | `network/` grid modal |
  | Settings → Demand, A-pan by month | 12 month inputs | 64 × **25** (the table scrolls 308 → 930 px) | `settings/` monthly table |
  | Transfers → "Rates in" unit | select | 64 × **24** | `network/FlowUnitSelect.svelte:18` |
  | Network → Colour hydrological units by | select | 197 × 29 | Network tab |
  | Runs → Filter runs | input | 310 × 32 | `runs/RunsTab.svelte` |

  The allocation months are the only control under WCAG 2.5.8's 24 px. They pass only on
  the spacing exception, with rows 28 px apart. The form forks the shared month picker:
  `common/MonthPicker.svelte` is 24 px at minimum and `var(--tap)` (44 px) on a phone
  (`:130-140`).
- **Screenshots:** `r4-phone/alloc-form-months-390.png`, `r4-phone/overlay-390-farm-drawer.png`,
  `r4-phone/overlay-390-grid-nodes.png`, `r4-phone/focus-settings-dirty-390.png` (A-pan row).
- **Fix:**
  1. AllocationForm: use `MonthPicker` (playbook § 4 table, "Picking months"). Same values
     and same water-year order, and All months / No months come with it.
  2. `app.css:576` `table.data td input/select`: add `@media (pointer: coarse) { min-height: 44px }`,
     and in the drawer and the unit table make the phone layout one card per row (as the
     crop grids already do, playbook § 2).
  3. FlowUnitSelect: `min-height: var(--tap)` under 640 px.

## 6. Account and Alert emails in Afrikaans at 320: a button sticks out of its card, the frequency switch wraps to three lines, and the text is under the farm frame's 13 px floor. **Medium**

- **Where:** `/account` and `/account/alerts`, which farmers reach from the farm Menu. Both
  render in the farm frame (EN | AF, Kieslys).
- **Measured:**
  - `/account`, the Alert emails panel: **"Kies jou waarskuwings-e-posse"** is 250 px wide
    with `white-space: nowrap` (`app.css:261`). Its right edge is at 285 against the card's
    inner edge at 274, so it sticks out **11 px** past the padding (the page doesn't scroll
    sideways, so `expectNoSidewaysScroll` passes). `frontend/src/routes/account/+page.svelte:357`.
  - `/account/alerts`: each `label.seg` is **81 px** wide. "Een keer ’n dag (06:00)" wraps
    to **3 lines** at **12.6 px** (`0.9rem`, `routes/account/alerts/+page.svelte:327`).
    The intro and the cap notice are 12.6 / **11.9 px** (`:301`).
  - `/account` at 320 af: field labels **11.9 px**, hints **11.2 px**, the "Bevestig" / "Af"
    badges **10.5 px**, the password inputs 30 px tall, and the Wys toggles 50×34.
  The playbook (§ 2 "A frame with its own base size checks what it borrows") sets a 13 px
  floor inside the farm frame. `farm-view.spec.ts` checks it on `/farm/*` only, and these
  two pages borrow the app's 14 px-root `rem`.
- **Screenshots:** `r4-phone/c-acc-x.png` (Two-step and the overflowing button),
  `r4-phone/c-af1.png` (right: alert emails), `r4-phone/farm-af-320-_account.png`.
- **Fix:** a `.link-row .btn { white-space: normal; text-align: center; max-width: 100% }`
  on the account panels (or full-width buttons under 400 px). On `/account/alerts` under
  400 px, stack the three choices as full-width rows (a radio list, 44 px each) instead of a
  3-cell segmented bar, and size text in px (≥ 13) as `farm/FarmNotes.svelte` does. Extend the
  13 px text-walk in `farm-view.spec.ts` / `lang-layout.spec.ts` to `/account` and
  `/account/alerts`, and add a check that no `.btn` extends past its `.panel`'s padding box.

## 7. Map → Upload GeoJSON (1440 and 390). **Medium**

File: `frontend/src/lib/components/map/UploadSheet.svelte`.

| # | What | Measured | Line | Fix |
| --- | --- | --- | --- | --- |
| a | **Phone review is 15 screens for 30 features.** Each feature card is a 2-column grid with a label above every value, "Feature / 1" taking two lines, and "Problems / None" on every row. | Card **352 px**. Sheet body scrolls **11,102 px** for 30 rows (725 visible). | `:354-403` | Card head: one line "1 · Polygon, 0.35 ha"; Name full width; Kind and Stands for side by side (`1fr 1fr`) above 400 px of sheet width; omit the Problems line when there is none (the row's flag colour and the summary count carry it). Target: ≤ 200 px a card. |
| b | **Desktop: the Name column is cut off while Problems wastes width.** | Name inputs 208 px show "Parcel 1 with a fairly long field nar…"; Problems column ~145 px of "None". | `:337-343` | Draw the Problems column only when some row has a problem (`blocking.length || problemsOf` any); let Name take the space (`min-width: 14rem`). |
| c | Desktop: the header row scrolls away. | 30 rows, sheet body scrolls 1,833 px; the column names leave after row 13. | `:223-235` | `thead th { position: sticky; top: 0 }` inside the sheet body (the body is the one scroller, `:330-333`). |
| d | "from the file" under every Kind select, 30 times. | **10.5 px** (`0.75rem`) | `:253`, `:309-313` | Show provenance only when it differs from the file ("from its shape", or a note). Say "Kinds come from the file's properties" once in the summary line. Nothing is lost: the per-row `aria-describedby` keeps its text. |
| e | Row cells misaligned. | `#` is vertically centred (y 221) while the other cells are top-aligned (209–213). | `:334-336` | `.review-table th { vertical-align: top }` too. |
| f | **The error state repeats itself and contradicts itself.** A projected file shows the alert with the problem, then a card of "–" values repeating the same sentence, then a disabled "Import 0 features". The summary still says "Check each kind before you import". | `r4-phone/upload-390-trio.png` (right) | `:188-206`, `:285` | When `importable === 0`, hide the table, change the summary to "Nothing in this file can be imported.", and leave **Choose another file** as the only action (primary). |
| g | Empty state: the file hint is a 4–5 line explanation under the field (playbook: one short line under a field). | 4 lines at 1440, 5 at 390, 11.9 px | `:176-179` | Visible: "WGS84 longitude and latitude; a file in a Lo zone or UTM is refused." Move the QGIS reprojection recipe and "a file may mix…" into the label's existing ⓘ (`map-geojson-upload`) or `.explain`. Both stay in `aria-describedby`. |
| h | Phone label text. | Card labels and `[data-label]::before` **10.5 px**; hints 11.9 px | `:396-402` | 0.85rem minimum for labels on a phone. |

The sheet otherwise works: it is full screen on a phone, the footer actions are 44 px and
always reachable, there is no sideways scroll, and focus starts on the file field.
Screenshots: `r4-phone/upload-1440-empty.png`, `r4-phone/upload-1440-review.png`,
`r4-phone/upload-390-trio.png`, `r4-phone/upload-390-review-scrolled.png`.

## 8. Tables that scroll sideways: no scroll cue, and the first column is fixed in only 1 of ~10 per page. **Medium**

- **File:** `frontend/src/app.css:518-525` (`.table-wrap`: `overflow: auto`, no cue).
- **Measured** at 390, scrolling `.table-wrap`s and how many have a sticky first column:
  Hydrological units 11 (1), Runs & results 10 (1), Compare runs 7 (0), River & reserve 3 (1),
  Project 3 (0), Scenarios 2 (0), Data 1 (0), Dams 1 (0), Settings 5 (4). The widest are
  River 308 → **4,024 px**, Supply 308 → 1,915, Compare/Scenarios 308 → 954, and Runs 308 → 997.
  All are `tabindex=0` (keyboard reachable), which is good. None of them has a visual cue.
  On a 308 px box a table cut at a column edge looks finished.
- **Screenshots:** `r4-phone/owner-390-supply.png`, `r4-phone/owner-390-runs.png`, `r4-phone/owner-390-river.png`.
- **Fix:** an app-wide scroll shadow on `.table-wrap`, pure CSS with no JS
  (`background: linear-gradient(to right, var(--surface) 30%, transparent) left / 2rem 100% no-repeat local,
  … right local, radial shadows … scroll`). On a phone, make the row header sticky
  (`table.data tbody th, table.data thead th:first-child { position: sticky; left: 0; background: var(--surface) }`)
  for tables whose first column is a `th scope=row` (the Settings tables already do it).
  Pin with a `reflow.ts` helper that walks the scrolling wraps and checks for a sticky first
  cell where `tbody th` exists.

## 9. Settings → Fit the parameters on a phone: the fit record sits between the two cards, and the rules' main action is 2,200 px into the panel. **Low–Medium**

- **File:** `frontend/src/lib/components/settings/SettingsTab.svelte:1258-1270` (`FitProvenance`
  rendered open after `FitPanel`).
- **Measured** at 390, folds closed: the panel is **4,229 px**. Fit automatically is 620 px in
  (fine). The fit record's `dl` takes ~1,300 px. **Run the calibration rules** is **2,199 px**
  into the panel and Sign off at 2,359. The whole page is 14,776 px (17.5 screens) closed and
  20,905 px with every fold open.
- **Screenshot:** `r4-phone/fit-panel-2col.png` (the panel at half scale, two columns).
- **Fix** (playbook § 2 "Rarely changed settings fold into their values"): put
  `FitProvenance` in a `.fold` whose summary is its first line ("Fit record: GR4J, 15 Jan 2025 ·
  KGE′ 0.94 · Show"), open by default from 1024 px and closed below. Nothing is lost, and Find a
  setting still opens it.

## 10. Small targets repeated on every page. **Low** (each passes 2.5.8 or its spacing exception, but stays under 44 px on a phone)

| control | size at 390 | pages | file | fix |
| --- | --- | --- | --- | --- |
| "How this page works" | 125 × **18** | all 17 tabs | `workspace/SectionHeader.svelte:35` | see #2.3, or `min-height: 24px; display: inline-flex; align-items: center` as the minimum |
| ⓘ help tips | 24 × 24 | 291 across the tabs | `help/HelpTip.svelte:179-191` | `@media (pointer: coarse) { .tip-btn { position: relative } .tip-btn::after { content: ''; position: absolute; inset: -10px } }` gives a 44 px hit area with no layout change |
| "On this page" pills | h **36**, text **11.2 px** | Settings, Runs, River, Supply, Data, Compare, node sheet | `common/SectionNav.svelte:906-908`, `:672` | 44 px and 0.875rem under 640 px. The strip scrolls with a hidden scrollbar and nothing shows there is more: add the same edge fade as #8 |
| Account avatar | 43 × 40 | everywhere | `layout/AccountMenu.svelte` | 44 |
| Map: Layers / Show everything / Key | h 32; zoom 29; markers 28 | Map | `map/MapTab.svelte` | 44 on coarse pointers |
| Project facts links | h **14** | Project | `project/` facts grid | `display: inline-block; padding-block: 5px` |
| Summary "Open in Runs", card links | h 15–20 | Summary | `overview/` | same |
| Sort buttons in tables | h 32 | Compare, Supply | | 44 on coarse pointers |

## 11. Runs & results: the run form's last row is ragged. **Low**

- **File:** `frontend/src/lib/components/runs/RunsTab.svelte:933-960`.
- **Measured:** at 390, **Run model** sits alone on its row at 98 px of 343 (the label, input
  and Run forecast take the row above). At 360, Run forecast + Run model end at 236 of 329,
  leaving 93 px empty. That breaks the playbook rule (§ 2 "Lay a row of actions out on
  purpose on a phone") that every row fills. `workspace-phone.spec.ts` checks the form only
  for being under Add data.
- **Screenshots:** `r4-phone/trio4.png` (left), `r4-phone/first-360-b.png` (left).
- **Fix:** under 640 px: `[Run label input]` on its own full row, then `[Run forecast][Run model]`
  as one box with `flex: 1 1 0` each. Extend the spec's row-fill check to `form.run-form`'s
  children.

## 12. Viewer: two standing notes before the content on every tab. **Low**

- **File:** `frontend/src/routes/projects/[id]/+page.svelte:852-864` (View only), `:876-879`.
- **Measured** at 390: "View only. You have view-only access…" is a **4-line, 85 px** note on
  every tab, above "Inputs changed since the latest run … an editor can run the model again"
  (4 lines on Runs). The viewer's Runs results start at ~935.
- **Screenshot:** `r4-phone/trio2.png` (left).
- **Fix:** under 640 px, make "View only" one line ("View only · ask the owner to edit") with the
  rest in an ⓘ. The "Viewer" badge beside the project name already says it.

## 13. Workspace text under 13 px on a phone. **Low** (a dense tool; listed for a decision, not a defect)

Text nodes under 13 px per page at 390: Runs 1,333, Hydrological units 836, Compare 757,
River 644, Settings 401. Sizes: 10.5 px (364 nodes), 11.2 (555), 11.9 (528), 12.3–12.6 (384),
and 9.5–10.1 for run tags ("latest" 9.5), sparkline month letters (9.8) and dam class letters
(10.1). Decorative ▲▼ glyphs at 7.9–8.4 are `aria-hidden` text next to words, which is acceptable.
**Proposal:** a phone floor of 12 px for workspace meta text: raise `0.75rem` to `0.8125rem` under
640 px for `.badge`, `.tag`, `.meta`, `.small` and table `th`. Leave chart ticks alone; chart.ts
has its own rules.

---

## 14. Account → Two-step sign-in: the regrouping (decided)

**Today** (`frontend/src/lib/components/account/TwoStepSignIn.svelte:286-375`): an intro paragraph
(2 lines at 1440, 5 lines in Afrikaans at 320), then two method cards, each with
name + On/Off badge + Stronger/Easier tag, then 2–3 lines of explanation (3 at 1440, 4–8 at
320 af), and the button on its own row under the text. The section is 412 px at 1440 and about
640 px at 320 af. It breaks the playbook's two rules: "status/actions in the top row" and "at
most one short line under a field". Screenshots: `r4-phone/account-1440-twostep.png`,
`r4-phone/account-390-twostep.png`, `r4-phone/c-acc-x.png`.

**Decision:**

```
Two-step sign-in                                   [Off]   ← status in the head row
A 6-digit code after your password. Turn on one or both.  ← one line (intro)

┌ Authenticator app  · Stronger                [Set up the app] ┐ ← head row: name, tag, badge, action
│ Codes from an app on your phone.                              │ ← one short line
└───────────────────────────────────────────────────────────────┘
┌ Code by email  · Easier                             [Turn on] ┐
│ Codes sent to demo@example.com: only as safe as your inbox.   │
└───────────────────────────────────────────────────────────────┘
▸ How the two ways differ                                         ← <details class="fold">, closed
    (today's full sentences, unchanged: "Someone who learns your password still can’t get in.",
     "…such as Google Authenticator, Microsoft Authenticator or Aegis. Only your phone can make the codes.",
     "…whoever can read your email can also reset your password, so with codes by email your inbox
     guards your account. Keep your email account secure.")
```

- **Head rows:** each method's `.method-head` gets its action at the right end
  (`margin-left: auto`), on the same row as the name, badge and tag. Under 400 px the action
  wraps to a full-width row under the head (one row, not after the paragraph). The panel's
  `h2` row shows the overall state: **On (app)** / **On (email)** / **On (both)** / **Off**, as the
  same badge styles.
- **One line each:** "Codes from an app on your phone." / "Codes sent to {email}: only as safe as
  your inbox." The second keeps the warning visible, because it is a warning and not an
  explanation (brief: lines that warn stay visible).
- **Nothing lost:** the current sentences move whole into one closed `<details class="fold">`
  ("How the two ways differ"). The account page has no explain switch and is farmer-facing,
  so a fold, not `.explain`. The setup forms, the recovery-codes block, the pending-reset alert
  and the "This browser signed in before…" line are unchanged and stay where they are.
- **Words:** three new English strings through `t()` (the intro line and two method lines) and the
  fold's summary. The parent runs the i18n-translator and i18n-checker. The old strings stay in
  use inside the fold, so no existing translation is thrown away.
- **Expected size:** about 230 px at 1440 (from 412) and about 330 px at 320 af (from about 640). Pin it in
  the account spec: each method's action button's top lies within its `.method-head` row at 1440,
  and the fold is closed by default with the full sentences in the DOM.

---

## Checked and found fine

- **Sideways scroll:** none on any tab at 390 or 360 for owner or viewer, on the farm pages in
  Afrikaans at 320, on the account pages, or in the sheets (`sidewaysOverflow`: 0 culprits).
- **WCAG 2.4.11 (focus not obscured):** Shift+Tab upward through Settings, Hydrological units and
  Runs at 390 never left a focused control under the sticky phone bar (52 px) or the
  "On this page" strip (52–102). The dirty Settings save bar (143 px) is cleared by
  `scroll-padding-bottom: 155px`, and a field focused below the fold lands at 388–414 px.
  Sticky table heads stay inside their own wraps.
- **Dialogs taller than the screen:** every sheet checked (node sheet, unit table, planted areas,
  Upload, Import volumes, Add a volume) is full screen with its actions in a fixed footer at
  44 px. New scenario (308 px) and Add data (809 of 844) fit. No action was out of reach.
- **One `h1` per tab:** every tab, owner and viewer.
- **Farm pages at 320 af:** no text clipped in its box (the hidden back/title labels are
  deliberate at 320), the EN | AF pair stays one row, the comparison table and the dam page fit,
  and no text is under 13 px on `/farm/*`.

## Found along the way (outside phone layout, for agent D or a follow-up)

1. **History shows a raw event key:** "alert_rules.changed" appears as a History line
   (`r4-phone/trio3.png`, middle). `frontend/src/lib/components/history/timeline.ts:460-461`:
   `eventLine`'s `default` returns `e.kind`, and there is no `case 'alert_rules.changed'`
   (recorded by `backend/src/alerts/routes.ts:440`). Fix: add the case ("Changed the alert
   rules"), and make the default a generic sentence so an unknown kind never shows a key. Add a
   unit test that every kind in `backend/src/history/record.ts`'s union has a case.
2. **`.badge { text-transform: capitalize }`** (`frontend/src/app.css:623`) turns multi-word
   badges into Title Case: "Dam Settings Changed Since The Run" on the Dams cards
   (`r4-phone/trio2.png`, middle). It breaks the sentence-case wording rule. Fix: drop it from
   `.badge`, and capitalise the role words at their source (`MembersPanel.svelte:334` and
   `ProjectTable.svelte:416` already do it locally).
3. **Add a registered volume:** the "Licence conditions" legend wraps to two lines and the
   fieldset border runs through it (`r4-phone/alloc-form-months-390.png`). Put the "(optional; a cap
   run keeps…)" part in a hint under the legend.
