# Design: the phone-first farmer view (`/farm/:projectId`)

Design spec for [issue #14](https://github.com/Absence0760/project-water-management/issues/14).
It feeds the build of [WP-2.1](../roadmap/step-2-shared-catchment.md#wp-21-farmer-role-and-farm-scoped-rls)
(farm-scoped RLS) and [WP-2.6](../roadmap/step-2-shared-catchment.md#wp-26-phone-first-farmer-view)
(the view). WP-2.1 and WP-2.3 (with the WP-2.6 API routes) are built; the
view itself is not yet (§12). Where this spec and the roadmap
disagree, this spec is the newer decision; §12 lists every change it asks of
the roadmap.

- **Prototype:** [Farmer view prototype](https://claude.ai/artifact/CtCfnC9duX1ku8FwiDoGG9)
  (a claude.ai design canvas, 9 phone screens at 360 px). The canvas is
  private to the operator until it is shared from its Share menu. The same
  screens are committed as source in [`farmer-view-prototype/`](./farmer-view-prototype/),
  so the design survives outside claude.ai.
- **Figures:** every number in the prototype comes from a real engine run
  (0.27.0) of the synthetic **Sandspruit** example catchment
  (`backend/scripts/examples`), for its farm "Vaalbank", 1 Oct 2023 to
  10 Jan 2024. [`figures.ts`](./farmer-view-prototype/figures.ts) prints
  them. Forecast values stay `[placeholders]` until forecast mode exists.
  No client data: the repo is public.
- **Persona:** [`persona-farmer`](../../.claude/agents/persona-farmer.md).
  §11 has the test results and what changed because of them.

## 1. The job

An irrigation farmer opens a link on their phone, often in the bakkie and
often in Afrikaans. In **under 30 seconds** they can answer:

| # | Question | Answered by (§6) |
| --- | --- | --- |
| Q1 | How much water will I get? | The notice, "Water you received", the dam's days-left line, "Next 14 days" |
| Q2 | Will I be curtailed? | The notice (official). "Looking back" and the "Why?" screen (modelled) |
| Q3 | How is my dam doing? | The dam card and the dam screen |
| Q4 | Am I treated fairly next to my neighbours, without seeing their data? | "Why?" step 1 (the even share), "Your farm on the river", the privacy line |

Three rules shape everything else:

1. **Official beats modelled, and they never look alike.** Only the WUA's
   published notice is a restriction. It alone uses the warning and danger
   fills. The model's figures sit in neutral, dashed-border cards labelled
   "Model", and every one says it's an estimate.
2. **No number the engine doesn't produce.** Every figure traces to an
   engine output, a published field or a stated, one-step sum on them (§3).
   Whatever a farmer wants that the engine can't give is an ask (§4), not an
   invented number.
3. **Never tell a farmer to take water they can't get.** Nothing on the page
   counts the even share as water the farm has or could have (§5.3).

## 2. Where the figures come from

A farmer never reads a run. They read the **current publication** (WP-2.3):
the run the modeller or WUA published, projected per farm into
`publication_farm.view`, and for the catchment into
`run_publication.catchment_view`. The charts' series come from the published
run's `run_series`, limited to the farm allowlist of WP-2.1 as this spec
narrows it (§10.3). So everything on the page is:

- as of one **publication date** (who published it, and when), and
- as of one **data date** (`dataUntil`, the last day with input data).

Both dates are on every screen, directly under the title.

**The season.** Every farmer figure is over the **season**, 1 Oct (the
water year's start) to `dataUntil`, or over `last30` (the 30 days to
`dataUntil`). That includes the curtailment figures: the projection runs
`computeCurtailment` over the season itself (ask E5), not over the
modeller's `settings.reportStart … reportEnd`. The modeller can set that
window to any period, even last year, and a farmer would read it as this
season (§11 F2).

## 3. Content model

Per question: the line on screen, where it comes from, and its unit and
rounding. `CF` is the farm's `CurtailmentFarm` row over the season (E5,
model.md §2.11). Vaalbank's values are in brackets.

### Q1 How much water will I get?

The engine can't say what a farm *will* get over the rest of the season. It
models what the farm *could take* each day given rain, flows and its dam, and
a 14-day forecast once WP-2.12 lands. So the view answers Q1 in honest parts:
what the WUA says (the notice), what the farm received so far, how long its
usable dam water lasts at today's use, and the next 14 days. A seasonal
outlook is ask **E3**.

| Line on screen | Source | Unit, rounding |
| --- | --- | --- |
| "86 % of what you needed" | `season.fraction` = Σ `supplied` ÷ Σ `demand` (`windowSummary`) | whole %, with the tiny-number rules (§8) |
| "324.2 ML of 376.5 ML since 1 Oct" | `season.suppliedM3`, `season.demandM3` | the user's volume unit (§8) |
| "Short on 16 days in Nov and Dec, all when your dam was down to its stop level" | days with `deficit` > 0 in the season, and the months they fall in | a count. For a dam farm the engine is only ever short when the dam is at its stop level (model.md §2.7, G), so "all when…" is always true for a dam farm; a farm with no dam reads "…when the river was too low to take from" |
| "Last 30 days: >99 % · 113.3 ML of 113.8 ML" | `last30` (the same shape) | as above |
| "Worked out by the model, not read from your meter. It assumes 75 % of the water you pump reaches the crop (sprinklers). Wrong? Tell your WUA." | the node's `irrigationEfficiency`, named by the nearest system (drip 0.90, micro/pivot 0.85, sprinkler 0.75, flood 0.65) | Always on the supply card (§11 F4, F22) |
| 12-month bars, needed and received | `run_series` `demand`, `supplied`, summed by calendar month on the client | ML per month; "Show the numbers" lists all 12 months with years |
| "Next 14 days: lowest dam level [x] around [date]; days you may be short [n] of 14" | `forecast.damPctMin`, `forecast.damPctMinDate`, `forecast.deficitDays` (E2, WP-2.12) | Hidden until forecast mode exists |
| "Compared with last season" | `lastSeason`: the same figures for the same dates a year earlier, from the **same published run** (E4) | "Not available: the model's data starts on …" when the run doesn't reach back |

"Needed" is what the farm would have to **take** (abstraction demand D = crop
requirement ÷ efficiency), not the crop's net need. It's the quantity a
farmer meters and the one curtailment works in. The help entry says so.

### Q2 Will I be curtailed?

| Line on screen | Source | Notes |
| --- | --- | --- |
| Notice card: level, title, text, who and when | `run_publication.restriction_level` (`none`, `advisory`, `restricted`), `restriction_pct`, `notice` (by language, 081), `published_at` | Shown **first** whenever the level isn't `none`. The WUA writes the text; the app never writes restriction wording itself. With no text, the percentage alone reads as a cut, "Set by the WUA: a 20 % cut in registered water use.", the same words as the alert email (issue #51), never "20 % of registered use", which reads as an allowance |
| "No restriction from the WUA" (success tokens, check icon) | level `none` | The official answer stays first and loud even when there's nothing to say (§11 F8) |
| Model card "Looking back: 1 Oct to 10 Jan", chip "Model: watch", "If you had pumped less on the days the river needed it, you would have had about 83 % of the water you needed." | **E7**: (`CF.suppliedM3Day` − \|`CF.ewrSupplyCutM3Day`\|) ÷ `CF.demandM3Day` [(3 179 − 121) ÷ 3 691 = 83 %] | whole %. Band §6.2. Past tense. Under a `restricted` notice the card collapses to one link line, so only the WUA's percentage competes for attention |
| "The model's estimate, not an official restriction" | fixed text (D10) | Always on the model card |
| "Why?" step 1: even share 89 %, you 86 %, "about 118 m³ a day less" | `CF.equitableFraction` (K_tot), `CF.fractionSupplied`, `CF.reduceGainM3Day` (N) | Only at ≥ `k` other holders (§10.3). "It isn't part of the 83 %." Never worded as water to gain |
| "Why?" step 2: "below its reserve at Sandspruit Outlet on 52 days and at Melkhout Gauge on 44", "water taken upstream was part of the reason on every one of those days" | `ewrSites[].daysNotMet` over the season for the sites the farm is upstream of; the charged/natural split per day (E5) | "Part of the reason" only on days with a charged part; otherwise "on N of them only because of low rain" |
| "You were asked to help on 56 of the 102 days" | days with `ewr_charge` < 0 in the season (E5) | A different count from the sites' days (§11 F10) |
| "Pump about 220 m³ a day less (2.6 l/s). Averaged over all 102 days that is 121 m³ a day." | season total of −ΔG ÷ charged days [121.2 × 102 ÷ 56]; `CF.ewrSupplyCutM3Day` | The per-day figure applies on the days the river needs it (§11 F9) |
| "Your dam also held back about 120 m³ a day the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn't, the WUA may talk to you about it." | season total of R_store ÷ charged days [65.4 × 102 ÷ 56]; `CF.ewrChargeStorageM3Day` | Information, not an instruction, until the node records release works (E9, §11 F11). Shown only above the floor (§6.2) |
| "Why?" step 3: received 3 179 − pump less 121 = 3 058 ≈ 83 % of 3 691 | `CF.suppliedM3Day`, −ΔG, `CF.demandM3Day` | Lets a farmer check the headline by hand. Each row is rounded to whole m³ and "Leaves" is worked out from the rounded rows, so the sum adds up as shown (issue #51) |
| "The river's share of your water is more than an even share of the catchment's supply. The WUA may need to look at this." | `CF.ewrCutBeyondShareM3Day` > 0 | Only when it applies |

### Q3 How is my dam doing?

| Line on screen | Source | Unit, rounding |
| --- | --- | --- |
| "24 % full" | last `dam_storage` ÷ `damCapacityM3` | whole % |
| The bar's mark "irrigation stops at 15 %" | the node's `damMinPct` (a farmer reads their own node, WP-2.1) | 13 px label |
| "83.6 ML of 350 ML" | last `dam_storage`, `damCapacityM3` | volume unit |
| "You can still use 32.4 ML" | `dam_storage − damCapacityM3 × damMinPct`, floored at 0 | Exactly what the engine lets irrigation draw (model.md §2.7, G). Not shown when `damMinPct = 0` (below) |
| "Up 9 points in 30 days (was 15 %)"; "up 32.4 ML" | `dam_storage` 30 days before `dataUntil` | whole percentage points |
| "At your use over the last 14 days (about 5.1 ML a day), the water above the stop level lasts about 6 days if nothing flows in. A rough guide." | usable ÷ mean `supplied` over the last 14 days [32 412 ÷ 5 074 = 6.4] | whole days under 14, then weeks. Not shown when the 14-day use is 0 (§11 F12) |
| "Last full and spilling 27 Jul 2023" | the last day with `spill` > 0 | a date, or "not in the last 12 months" |
| "Same day last season 17 %" | `lastSeason.damPct` (E4) | whole % |
| 12-month dam line, stop level dashed | `run_series` `dam_storage` ÷ capacity | – |
| "Worked out by the model, not measured at your dam." / "If your gauge plate reads very differently, or your pump stops at another level, tell your WUA." | fixed text | Always. Farmer-entered gauge readings stay out of Step 2 (roadmap §3, "leave room for `time_series.node_id`") |

**No stop level set.** Every imported dam has `damMinPct = 0` (migration
006). Then the mark, "You can still use" and the days-left line are replaced
by: "The model assumes your pump can empty the dam. Tell your WUA the level
your pump stops at." The publish dialog warns the modeller, "N farm dams
have no stop level" (WP-2.3) (§11 F13).

A farm with no dam (`damCapacityM3 = 0`) gets no dam card and no dam screen.

### Q4 Am I treated fairly, without seeing my neighbours?

| Line on screen | Source | Notes |
| --- | --- | --- |
| "Across the catchment, farms received 89 % of what they needed" | `CF.equitableFraction` | ≥ `k` other holders only (§10.3) |
| "1 farm is upstream of you and 2 are downstream, of 8 farms in the catchment" | counts from the network topology (E6) | D1 option (b): counts only, no names, no positions |
| "The same rules apply to every farm" | fixed text. True by construction: the curtailment and attribution rules are symmetric and order-free (model.md §2.7b, "Order-free") | – |
| "River at Sandspruit Outlet: below its reserve on all of the last 30 days" | `catchment_view`: days not met over the last 30 days at the outlet | A count, never a flow volume (§10.3) |
| "Your farm's figures are seen by you, anyone else linked to this farm, and the WUA's staff and modeller. Other farmers can't see them, and you can't see theirs." + "Who can see my farm" | fixed text, true by WP-2.1's RLS and FV-D5; the link lists the people with access (name and role) | One wording everywhere (§11 F5). Built: `GET …/farm/:nodeId/access` (names and roles, no emails) |

## 4. Gaps: asks of the engine, the data model and the API

Nothing here changes `runModel` except E2, which is WP-2.12's.

| # | Ask | Why | Where it lands |
| --- | --- | --- | --- |
| E1 | `farmProjection` and `windowSummary` (pure helpers, `packages/engine/src/views.ts`) | Every card | WP-2.3, as planned |
| E2 | Forecast mode with per-day forecast flags; the projection adds `forecast: { from, to, damPctMin, damPctMinDate, deficitDays }` | "Next 14 days" | WP-2.12 (adds `damPctMinDate`) |
| E3 | **Seasonal outlook**: the rest of the season from today's dam level, run with each historical year's rain and flows (an analogue ensemble), giving the likely range of "% of what you need" and the dam at season end | The real answer to "how much will I get *this season*" | [planned-work.md § Data](../planned-work.md#data). Trigger: before farmers' second season on the view |
| E4 | `lastSeason` in the projection: the season and dam figures for the same dates a year earlier, from the same run | "Compared with last season", like for like. Comparing publications instead would mix model changes with weather | WP-2.3 |
| E5 | The projection's curtailment over the **season** (`computeCurtailment` with the season as its window), the days charged, and the sites' days not met with their charged/natural split, all over the season | Q2's lines; §2 "The season" | WP-2.3 |
| E6 | Farms upstream and downstream of a node, and the catchment's farm count, as a `SECURITY DEFINER` count function (no ids) | "1 farm upstream, 2 downstream" (D1 b) | WP-2.1 |
| E7 | The headline fraction (supplied − supply cut) ÷ demand, in the projection | The model card and its band, at any `k` (§5.4) | WP-2.3 |
| E8 | A per-farm registered or scheduled volume (licence, WARMS or the WUA's quota), readable by the farmer | Turning "a 20 % cut" into the farm's m³ (§11 F4) | Step 3 (model.md §2.11 names authorised volume as the base of a future allocation). Until then the notice speaks in % of registered use and the view does no sum on it |
| E9 | A node flag for release works (an outlet or bypass on the dam) | Whether "let water pass your dam" is something the farmer can do (§11 F11) | WP-2.6 follow-up (a Network-tab field, default unknown) |
| E10 | `next_expected_on date NULL` on `run_publication` | "Next update expected around …" (§11 F21) | WP-2.3 |

Not an ask, but worth recording: the farm allowlist has no `dam_evaporation`.
Farmers do ask where their dam water goes, and their own node's evaporation
is harmless to show. It could come later with a "where your dam water went"
breakdown; not in the first release.

## 5. Explaining curtailment without jargon

### 5.1 Words

| Engine / modeller term | Farmer view says | Afrikaans (draft, for the named reviewer) | Never says |
| --- | --- | --- | --- |
| Equitable share, K_tot, target volume | "even share" ("everyone gets the same share of what they need") | "gelyke deel" | gain, entitlement, allocation, target |
| Above (−) / below (+) equitable share, N | "a little more / less than an even share (about 118 m³ a day)" under 10 points between the farm's % and the even share, "more / less than …" from 10, "much more / less than …" from 25 (`SHARE_GAP_POINTS`, issue #51) | "'n bietjie meer / minder as 'n gelyke deel" | reduce/gain, "you may take" |
| EWR, Ecological Reserve | "the river's reserve" ("water the law keeps in the river so it stays healthy for everyone downstream"), with a help link | "die rivier se reserwe" | EWR, shortfall, charge |
| EWR charge, supply cut ΔG | "pump less" | "pomp minder" | charge, attribution, consumptive |
| R_store | "your dam held back … the river needed" | "jou dam het … teruggehou wat die rivier nodig gehad het" | storage part, release condition |
| Net impact | "the water each one used up or stored; water that flows back to the river doesn't count against you" | – | "how much each one took" |
| Binding site | "at Sandspruit Outlet" / "at [gauge name]" | – | binding |
| Natural shortfall | "only because of low rain" | "net weens min reën" | natural |
| Modelled | "worked out by the model" / "the model's estimate" | "deur die model bereken" | simulated |
| WUA | "the WUA" | "die WGV" (Watergebruikersvereniging) | – |

Jargon appears only behind "What do these words mean?" (WP-2.6 acceptance),
and the Afrikaans help carries the same entries. The Afrikaans column was
the word list for the app's Afrikaans (written and checked by the
`af-translator` / `af-checker` agents, 2026-09-26, issue #49); a native
speaker's review is still open (docs/followups.md § Afrikaans).

### 5.2 Q13: the two parts of the river's share

The engine splits a farm's reserve charge by channel (model.md §2.7b, Q13).
The "Why?" screen turns the parts into two lines, each with its own icon:

1. **Pump less**: the supply cut −ΔG (`ewrSupplyCutM3Day`), not A_irr,
   because the farmer controls the pump; the cut is larger than A_irr by the
   return-flow share (§2.7b, "Supply cut"). Shown **per day the river
   needed it** (season total ÷ days charged), with the season average after
   it. An average over every day would have the farmer cut a little every
   day, which does little on the days that matter.
2. **Your dam held back … the river needed**: R_store
   (`ewrChargeStorageM3Day`), per charged day. Worded as information with a
   conditional ("if your dam has an outlet or a bypass…"), because many farm
   dams are in-stream with only a spillway and can't pass water on demand.
   Once E9 records release works, a dam that has them gets the instruction
   form: "Let about 120 m³ a day pass your dam on those days."

Step 3 does the sum for the headline and says outright that the dam part
isn't in it: "Holding back less in the dam doesn't come off today's pumping,
so it isn't in this sum. But it leaves less in your dam for later in the
season." A farm with no irrigation in the season sees only line 2 (the
engine gives it A_irr = 0).

### 5.3 Q11: the even share is a fairness check, not water

The even share is a marker on the farm's own "received" bar, never a bar of
its own (a bar reads as an amount you're owed), and it is **not part of the
headline**. Beside it, always:

> **This is a fairness check, not extra water for you.** Whether more water
> can reach your farm depends on where you are on the river and what is in
> your dam. It isn't part of the 83 %.

That is `EQUITABLE_SHARE_FOOTNOTE` in plain words. A farm *above* the even
share reads "a little more than an even share (about N m³ a day)" (or "more",
"much more" as the gap grows), which
isn't a cut instruction either: only the notice is.

### 5.4 Why the headline isn't `fractionOfDemandLeft`

The roadmap put `CF.fractionOfDemandLeft` (V = MAX(M − ΔG, 0) ÷ H) on the
card. V starts from the even share M = H × K_tot, which assumes water moves
freely between farms. So a farm well below the share is shown more water than
it received: in the synthetic Sandspruit run, the farm "Klipdrift" received
55 % of its need, yet V says 87 % (M counts 1 324 m³ a day it never got), and
the band would say OK. A farm above the share is shown a hidden cut to the
even share. Both break rule 3. The headline is E7 instead: what the farm
received, less its pump cut for the river. Klipdrift reads 52 %, and Vaalbank
83 %. The even share stays where it belongs, as the fairness marker of step 1
(§11 F1). V stays in the workspace's curtailment table, with its own
footnote, for the modeller and the WUA.

## 6. Screens

The prototype has one board per screen, numbered as below.

### 6.1 Main view (boards 1 and 2)

One column, 16 px gutters, max width 560 px centred on larger screens (the
roadmap's "desktop is the same column"). Cards, top to bottom:

1. **Header:** "My farm", the Afrikaans / English switch, Menu.
2. **Title block:** the farm's name (h1), the catchment, then "Published by
   the WUA on 12 Jan 2024. Data up to 10 Jan 2024." Amber, with a clock icon
   and "N days ago", when `stale` (`series/freshness.ts` `STALE_DAYS`).
3. **The WUA's answer**: the notice card (advisory: warning tokens;
   restricted: danger tokens; each with an icon and the level in words), or
   "No restriction from the WUA" (success tokens, check icon).
4. **Water you received this season**, with the volume-unit switch.
5. **Your dam** (none without a dam), with the days-left line and a link to
   the dam screen.
6. **Looking back** (the model card: dashed border, neutral "Model: watch"
   chip), linking to "Why?". A single link line under a `restricted` notice.
7. **Next 14 days** (hidden until WP-2.12).
8. **Last 12 months** chart, with "Show the numbers".
9. **Compared with last season.**
10. **Your farm on the river**, with the privacy line and "Who can see my
    farm".
11. Links: download my figures (CSV); what do these words mean; email me
    when the WUA posts a notice or my dam gets low (WP-2.13).
12. The disclaimer (D10).

The official answer and the supply card are above the fold on a 360 × 740
screen with no notice; with a notice, the supply card starts at the fold and
the dam card is one scroll down. The model card sits below the farm's own
figures on purpose: it's the least certain thing on the page.

### 6.2 The model band

Applied to the E7 headline:

| Band | When | Chip (neutral: outlined, `--text-2`, a chart icon) |
| --- | --- | --- |
| OK | ≥ 90 % and no storage part above the floor | "Model: OK" |
| Watch | 70 % ≤ headline < 90 %, or a storage part ≥ the floor | "Model: watch" |
| Short | < 70 % | "Model: short" |
| none | demand under `DEMAND_PCT_FLOOR_M3_DAY` (1 m³/day) in the season | no chip and no %: "Your farm needed very little water this season." A storage part still shows its line on "Why?" |

The floor for the storage part is the same 1 m³/day, so crumbs don't flip a
farm to Watch. The band never uses the warning or danger fills: those belong
to the WUA (§11 F8). The thresholds are a proposal (FV-D1); they live in one
constant that unit tests pin.

### 6.3 Dam detail (board 3)

Big %, the bar with the stop mark, a definition list (in the dam, full, can
still use, last 30 days, same day last season, last spilled), the days-left
line, a 12-month line with the stop level dashed and the short days
explained against it, the next 14 days with the date of the lowest level, and
"Where these figures come from".

### 6.4 "Why about 83 %?" (board 4)

The dates line, then three numbered steps (was water shared fairly, did the
river keep flowing, where 83 % comes from), "What the WUA decided" linking
back to the notice, and "What this is not" (not an allocation or licence,
not a forecast, not measured). Each step is a `section` with an `h2`, so a
screen-reader user can jump by heading.

### 6.5 States (boards 5 to 9)

| State | Design |
| --- | --- |
| Loading (5) | Skeleton cards the height of the real ones (no layout shift), `aria-busy` on `main`, one visually hidden `role="status"` "Loading your farm…", and after 3 s "Slow signal? This can take a moment." |
| No publication (6) | The farm's name, a dashed empty card "Your WUA hasn't published figures yet", "Email me when it's ready" (the publication alert, WP-2.13), "Questions? Contact [WUA]" |
| Error (7) | `role="alert"`, "We couldn't load your farm", "Your figures are safe; nothing was changed", Try again (the `LoadState` retry), and a contact line after a second failure. No raw error text (CLAUDE.md rule 6) |
| Offline or out of date (8) | A dark status strip "No signal. These are the figures saved on this phone at 07:42 on 19 Jan 2024." over a reduced view (the notice, received %, dam %). Charts, "Why?" and downloads say they need a connection. Stale data gets the amber dates line, online or not |
| Several farms (9) | `/farm`: a card per linked farm across projects: name, catchment, the notice level, received % and dam % (or "no dam", or "not published yet"). A farmer with one farm goes straight to its view |
| Preview as farmer (viewer+) | The same page under a banner "You're previewing Vaalbank as its farmer sees it". A farmer never sees it |
| Access removed | The next request answers 403 or 404: "You no longer have access to this farm. Contact [WUA]." The saved copy is cleared (§9) |
| No last season | "Not available: the model's data starts on [date]." |

## 7. Visual design and accessibility

- **Tokens:** only the existing ones in `frontend/src/app.css`, light and
  dark, plus the brand's Outfit 600 for the farm name and the big numbers,
  and the system sans for everything else. No new colours. The prototype
  hard-codes the token values; the build uses the variables.
- **Size:** a 16 px base in the farmer view (the workspace is 14 px, a
  data-dense desktop tool), headings 17 to 19 px, big numbers 40 to 48 px,
  and **nothing under 13 px**, chart labels included, for reading in
  sunlight. Charts are drawn at their rendered size, so their text isn't
  scaled down.
- **Targets:** every link and button is at least 44 × 44 px (`--tap`),
  including the unit switch and "Show the numbers".
- **Colour never alone:** every notice level and band has an icon and a
  word. Official and modelled differ in fill, border style (solid vs dashed)
  and label, not only colour. The chart's "needed" is an outline and
  "received" a fill.
- **Contrast:** the token pairs are already AA in the workspace (the
  `app.css` comments). The pairs new to this view (warning on warning-soft,
  danger on danger-soft, success on success-soft, the dark offline strip)
  go through the build's axe run in every state, both themes and both
  languages (WP-2.6).
- **Reading order** is the visual order (§6.1). One `h1` (the farm's name),
  an `h2` per card, each card a `section` labelled by its `h2`. Charts are
  `aria-hidden` with a visually hidden summary sentence and a real table
  behind "Show the numbers". The dam summary's latest level is "on 10 January
  2024" when the data stops mid-month and "at the end of December 2023" when
  the last month is complete (issue #51). Bars and gauges are decorative; the number
  beside them is the content.
- **Reflow:** no horizontal scroll at 320 px (the existing reflow pattern).
  Chips and buttons wrap; nothing has a fixed width.
- **Afrikaans:** strings run 20 to 30 % longer, which the wrapping layout
  absorbs. The notice comes in the viewer's language (`notice`, one text
  per language code), falling back to English, then any other written,
  with a "not translated" note.
  Afrikaans boards of the main and "Why?" screens get drawn once the
  translator is named, before WP-2.6 is built (§12).
- **Dark mode** follows the system, as the workspace does (board 2).

## 8. Numbers, units and dates

- **Volumes** in the user's unit (`app_user.volume_unit`, default `m3`,
  WP-2.5). m³ are whole numbers with a thousands separator; ML have one
  decimal with a trailing ".0" trimmed ("350 ML", "83.6 ML"), as the
  workspace trims its signed volumes. The switch on the supply card writes
  the preference. The prototype starts on ML to show the switch.
- **Rates** in "m³ a day", with l/s in brackets to one decimal when the
  unrounded value is at least 1 l/s. Under that, the l/s is left out: a
  fraction of a litre a second means nothing on a farm pump (§11 F9, F17).
- **Percentages** are whole, of a stated volume. A percentage never appears
  without its volume in the same card. The dam's change is in "points".
  "<1 %" and ">99 %" instead of rounding to 0 or 100; no % below 1 m³/day of
  demand (the existing `fmtDemandLeft` rules).
- **Separators** follow D8 (locale-driven `Intl`). The prototype shows a
  space as the thousands separator; af-ZA also uses a decimal comma.
- **Dates** as "12 Jan 2024" (`Intl.DateTimeFormat`, `dateStyle: 'medium'`,
  en-ZA / af-ZA), never ISO, always with the year in the dates line. The
  workspace keeps ISO dates.

## 9. Offline and slow networks

- **One request** for the page: `GET /projects/:id/farm/:nodeId` returns the
  whole `FarmView` (a few KB). The cards render from it; the chart series
  load after it, lazily, and the chart card shows its own skeleton
  meanwhile. The WP-2.6 target stays: first card in under 3 s on Fast 3G.
- **The saved copy:** the last good `FarmView` per farm is kept on the phone
  (localStorage, keyed by user and node) and shown at once on the next visit,
  with the offline strip, or a quiet "Updating…" until the network answers.
  It holds only what the farmer may see anyway. It is cleared on sign-out,
  on a 403 or 404 for that farm, when the user changes, and after 30 days
  unused. Menu has "Don't keep a copy on this phone", for a phone shared with
  a foreman or family, and the help says what's kept (§11 F23).
- **No service worker** in the first release. The SPA has to load, which
  needs a connection; the saved copy covers a dropped signal after load and a
  slow one on the next visit. A service worker for a full offline start is a
  follow-up if farmers ask for it.
- **No polling.** The page fetches on open and when it becomes visible
  again, nothing else.

## 10. Privacy: what a farmer sees about other farms

The input to WP-2.1's RLS and to plan.md Q15, D1, D2 and D4. This is an
access-control design for personal and commercially sensitive data under
POPIA: **loop in the CISO or Security Analyst before WP-2.1 is built**,
in particular on FV-D5.

### 10.1 What a farmer sees

| Seen | Not seen |
| --- | --- |
| Their own linked farms: every figure above; their node's parameters (capacity, stop level, efficiency, crops) | Any other farm's name, figures, position, crops or parameters |
| Catchment level: days the reserve was not met at the outlet and gauges; the WUA's notice | Any flow **volume**: natural flow, simulated or observed outflow, gauge flows, inflow from upstream |
| Gauge names (public infrastructure) | Other members, their emails, who else is linked to a farm |
| Counts: farms upstream and downstream, the catchment's farm count (D1 b) | Any list, ranking, distribution or percentile of farms |
| The even share (a catchment ratio), at ≥ `k` other holders | Totals of farm quantities, and the even share, below `k` other holders |

### 10.2 Who the "WUA" is (FV-D5)

"Only you and the WUA" is only a safe promise if the WUA side of it isn't a
neighbour. WUA and irrigation-board committees are usually elected
irrigators. So the design proposes:

- **viewer** and above on a project with farmers is for the WUA's staff and
  the modeller only;
- a board member who farms gets the **farmer** role on their own farm, like
  any other farmer; a catchment-only board view (aggregates at ≥ `k`, no
  per-farm rows) is a candidate for WP-2.14 if boards ask for one;
- "Who can see my farm" lists everyone with access to the farm, by name and
  role, so the promise can be checked;
- the wording is one sentence everywhere (§3 Q4).

### 10.3 Decisions this design takes (for the client to confirm)

- **D1:** option (b): anonymised counts only. RLS stays at (a); the counts
  come from a definer function (E6).
- **D2:** `k = 5`, counted as **holders**, not farm nodes: the farms not
  linked to the viewer, with farms linked to the same user counted once and
  an unlinked farm counted on its own. The rule needs at least `k − 1 = 4`
  other holders. One owner with three of five farms would otherwise learn the
  other two farms' combined figures from the even share (§11 F7). It covers
  the even share as well as totals.
- **Flow series leave the farmer allowlist.** WP-2.1's farm allowlist drops
  `inflow_upstream`: with one farm upstream it *is* that neighbour's daily
  outflow (model.md §2.7, H), and no card needs it. The catchment allowlist
  (`natural_flow`, `simulated_outflow`, `observed_flow`, `ewr`,
  `ewr_shortfall`) is not granted to farmers at all: in a small catchment,
  natural flow minus outflow minus your own use is your neighbours' use, and
  a gauge just below one farm shows its outflow. The view needs only the
  days-not-met counts, which come in `catchment_view`. The farm allowlist
  becomes `demand`, `supplied`, `deficit`, `dam_storage`, `spill`,
  `transfer` (a transfer's volume is the farmer's own) (§11 F6).
- **The E7 headline** leaks less than V: it doesn't carry K_tot, so it can
  show at any `k`. It does carry the farm's pro-rata share of a site's
  charged shortfall, one equation in the other farms' combined impact,
  which isn't enough to solve for any one neighbour.
- **D4:** no parameter history for farmers in the first release
  (unchanged).

Below `k` other holders, step 1 of "Why?" reads: "Not shown: with so few
farms in the catchment, it could reveal a neighbour's figures."

## 11. Testing

Five task-based tests with the `persona-farmer` agent standing in for
farmers, on 2026-09-25, against the first draft of this spec and prototype.
Real farmers come next, with the build (WP-2.6 acceptance). The agent's
working notes are in its git-ignored `reviews/persona-farmer.md`.

**Verdict: Adopt if…** It would open the view when the WUA publishes, not
weekly. It tells a farmer well what happened since 1 October, and too little
about what's coming. Three things would change the verdict: a forward answer
(days left in the dam now, the seasonal outlook later, and alerts), the
farm's quota and meter next to the model, and a privacy promise that holds
when the WUA board is the neighbours.

| Task | First draft | Result |
| --- | --- | --- |
| 1. How much water will I get? | ~25 s for "what I got". Nothing for the rest of the season; "What the model expects … you would have" read as a forecast | Past-tense "Looking back" card; days-left line on the dam; E3 tracked |
| 2. Will I be cut? (each notice level) | ~5 to 8 s. An amber "Watch" chip under an amber notice, and under "no restriction", confused official with modelled | Neutral dashed model card; a loud "No restriction from the WUA"; the model card collapses under a restriction |
| 3. How is my dam doing, when do I stop? | ~12 s for "how". No "when"; the stop label was 11 px | Days-left line; 13 px minimum; the zero-stop-level case |
| 4. Am I treated fairly? Can neighbours see mine? | ~30 s (bottom of the page). The screens leaked nothing, but the series behind them could, and the "WUA" in the privacy line may be neighbours | Flow series out of the allowlist; `k` by holders; FV-D5; one privacy sentence and "Who can see my farm" |
| 5. Explain "Why?" back | Arithmetic checked out against the engine, but the headline counted the even share as water | E7 headline; per-charged-day figures; the two counts split |

**Findings and what changed.** Every finding is either designed in (✅) or
tracked with a trigger (⏭).

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| F1 | The headline (V) counts the even share as water a farm may not be able to get | high, defect | ✅ E7 headline at any `k` (§5.4) |
| F2 | "What the model expects" reads as a forecast; the modeller's window may not be this season | high, defect | ✅ "Looking back", past tense; curtailment over the season (§2, E5) |
| F3 | The prototype showed a farm short with its dam half full, which the engine can't produce | high, defect | ✅ Prototype rebuilt from an engine run (`figures.ts`); the "short … at its stop level" line (§3 Q1) |
| F4 | No quota, so a % cut can't become m³; "received" not labelled modelled | high, gap | ✅ Modelled label on the supply card. ⏭ E8 in Step 3 |
| F5 | "Only you and the WUA" isn't safe when the board is neighbours; two wordings | high, defect | ✅ One wording, "Who can see my farm", FV-D5 for the client and the CISO / Security Analyst |
| F6 | `inflow_upstream`, gauge and outlet flows reveal neighbours in small catchments | medium, defect | ✅ Out of the farmer allowlists (§10.3) |
| F7 | `k` counts farm nodes, not owners | medium, defect | ✅ `k` by holders (§10.3) |
| F8 | The model band used the notice colours | medium, defect | ✅ Neutral band (§6.2), loud official "no restriction" |
| F9 | The pump cut averaged over 102 days applies on 56; tiny l/s | medium, defect | ✅ Per-charged-day figure first; l/s only from 1 l/s (§5.2, §8) |
| F10 | Days charged and days the outlet was short were one number | medium, defect | ✅ Two lines, and "only low rain" split out (§3 Q2) |
| F11 | "Let water pass your dam" assumes an outlet; "doesn't come off irrigation" hides the later cost | medium, defect | ✅ Information wording and the later-cost line. ⏭ E9 release-works flag |
| F12 | No forward answer at launch | medium, gap | ✅ Days-left line. ⏭ E3, with a trigger |
| F13 | The stop level is 0 for every imported dam | medium, gap | ✅ Zero-stop wording and the publish warning (§3 Q3) |
| F14 | "Email me before a restriction" promises foresight; email-only | medium, gap | ✅ Renamed "when the WUA posts a notice or my dam gets low". ⏭ WhatsApp stays the roadmap's post-Step 2 option; trigger: under half of farmers open the notice email in the first season |
| F15 | Afrikaans untested | medium, gap | ✅ Draft glossary column (§5.1). ⏭ Afrikaans boards once the translator is named, before the WP-2.6 build |
| F16 | Dates missing on the "Why?" and dam screens | low, defect | ✅ The dates line on every screen |
| F17 | l/s under 0.1 was rounded up; "60 ML" broke the ML rule | low, defect | ✅ Rules on unrounded values; ML trimming (§8) |
| F18 | The number table covered 4 of 12 months; 11 px labels | low, defect | ✅ All 12 months with years; 13 px minimum |
| F19 | A crumb of storage part flips the band; precedence unclear | low, defect | ✅ Floor and precedence (§6.2) |
| F20 | "In proportion to how much each one took" isn't net impact | low, defect | ✅ Reworded (§5.1) |
| F21 | No wording for a missing last season, nor for the next update | low, gap | ✅ Fallback text; E10 `next_expected_on` |
| F22 | "Needed" silently assumes an efficiency | low, gap | ✅ The efficiency line on the supply card |
| F23 | The saved copy on a shared phone | low, gap | ✅ Opt-out, 30-day expiry, help text (§9) |

The persona hasn't re-run against the revised design. That second run, and
the first real-farmer sessions, belong to the WP-2.6 build (its acceptance
criterion "Need verdict at least Adopt if… with no privacy finding").

## 12. Changes to the roadmap and the build issues

**WP-2.1** (farm-scoped RLS):
- D1 (b); D2 `k = 5` by holders, covering the even share (§10.3).
- The farm allowlist without `inflow_upstream`; no catchment series for
  farmers (§10.3).
- The E6 count function.
- FV-D5: who holds viewer on a project with farmers.
- Tests: the response-scan test also asserts no catchment ratio below `k`
  holders and no flow-volume series; a two-farms-in-series fixture where the
  downstream farmer's responses hold no series equal to the upstream farm's
  outflow; a fixture where one user links three of five farms, so the even
  share is hidden.

**WP-2.3** (publication and projection):
- `farmProjection` gains the season curtailment (E5), `lastSeason` (E4) and
  the headline fraction (E7).
- `run_publication.next_expected_on` (E10).
- The publish dialog warns about farm dams with no stop level.

*Status (2026-09-25): built, with the WP-2.6 API routes (index, view, CSV;
`packages/engine/src/views/farmProjection.ts`, `022_publication.sql`,
`backend/src/publish/`, `backend/src/farms/view.ts`). Where the build
settled something this spec left open:*
- *`dataUntil` is the last day of observed rain (catchment gauge or CHIRPS)
  in the run's input snapshot: a run that goes on on forecast rain is
  projected only to there, so forecast days never count as water received.*
- *`catchment_view` holds counts and dates only, per §10.3: the roadmap's
  mean natural and simulated flow and its farm totals at ≥ k are left out,
  since every member, farmers included, reads it.*
- *The binding site (`river.bindingSite`) is recomputed from the run's
  stored flows with the engine's attribution, since a run doesn't store it
  (exact unless the transfer rules form a loop; followups.md).*
- *`FarmView.publication.restriction` carried both notices (`noticeEn`,
  `noticeAf`), and the page picks the reader's language, showing "not
  translated" when it falls back to the other (§7). (First built as one
  `notice` picked by `?lang` with a `noticeLang`; changed in WP-2.5 so a
  language switch and the saved copy need no second request. Since issue
  #58 it is one `notice` map by language code, `{ en, af, … }`, falling
  back to English, then any other the WUA wrote, so a new language needs
  no schema or API change.)*
- *A legacy-runoff-model run can't be published (audit H1). Since engine
  1.0.0 removed that model, only a stored run from before it can be one.*
- *`shortDaysAtStopLevel` is 0 for a farm with no dam (it has no stop
  level); "all when your dam was down to its stop level" reads for dam farms
  only, as §3 Q1 says.*
- *Share links are WP-2.3 phase 2, not built (followups.md).*

**WP-2.6** (the view):
- Card order, band, wording and states as in §5 and §6; the model card's
  headline is E7, not `fractionOfDemandLeft`.
- "Compared with last season" from `lastSeason`, not `/history`.
- The saved copy and its rules (§9).
- Routes: also `routes/farm/[projectId]/why/+page.svelte`,
  `routes/farm/[projectId]/dam/+page.svelte` and a "Who can see my farm"
  panel. Components: the roadmap's list plus `NoticeCard` and `LookingBack`.
- Afrikaans boards reviewed by the translator before the build starts.
- E9 (release works) as a follow-up.

**WP-2.12:** `damPctMinDate` in the forecast block.

**New:** E3, the seasonal outlook, in
[planned-work.md § Data](../planned-work.md#data).

## 13. Open decisions

| # | Decision | Proposal | Who decides |
| --- | --- | --- | --- |
| FV-D1 | Model band thresholds (§6.2) | OK ≥ 90 %, Watch 70 to 90 % or a storage part, Short < 70 % | WUA + hydrologist |
| FV-D2 | `k` by holders, covering the even share (§10.3) | Yes, `k = 5` | Client (Q15) + operator |
| FV-D3 | Default volume unit for farmers | m³ (the roadmap's default), with the switch on the supply card | Client (ask farmers) |
| FV-D4 | Seasonal outlook (E3) before or after first release | After: ship without it, before the second season | Client + hydrologist |
| FV-D5 | Who may hold viewer on a project with farmers (§10.2) | WUA staff and the modeller only; board members who farm are farmers | Client (Q15) + CISO / Security Analyst |
| D10 | The disclaimer and "not an official restriction" wording, both languages | Draft text on boards 1 and 4, marked `[D10]` | Client (legal) |
