# Design: planning outputs (share the pain, outcome matrix, seasonal outlook, licence impact)

Research and recommendations for four decision-support outputs the client
sketched with a chat assistant (received 2026-09-26). The sketches used
hypothetical figures for the client catchment; they are **not committed**
(the repo is public and they name the catchment and its users). This doc
describes them generically. The build is tracked in
[issue #53](https://github.com/Absence0760/project-water-management/issues/53).
Built: R1 (`demand.scale`, engine 0.41.0,
[scenarios.md](../scenarios.md)), R2's sweeps (§3.2), R3's equal-share board
([ui.md § Share the pain](../ui.md#share-the-pain); one equal % for every
category is what the client wants, O4), R4 in full (§3.4: the engine, the
settings and the matrix screen), R5 in full (§3.5: the engine core, engine
0.44.0; the `outlook` job, its settings and the WUA screen; the farmer view
E3, engine 1.19.0, migration 104), R6 but WP-3.8's rule (§3.6: the engine,
engine 0.46.0; the job, the review-date setting and the screen) and R7
(§3.7: the impact report's board, with existing use from the background
run until a full-allocation run exists).

As in [calibration-research.md](../calibration-research.md), a claim backed
by a source is marked **(evidence)** with a key from
[§ References](#references); a design choice with no published rule behind
it is marked **(judgement)**.

## 1. The four sketches, and what the app already has

| # | Sketch | What it shows | Already built | Gap |
| --- | --- | --- | --- | --- |
| S1 | **Share the pain** | Per user group: today's supply % of demand → an equal share for every group → further cuts so the EWR is met, with totals per stage | ✅ The numbers: `CurtailmentTable` (equitable share, above/below it, the EWR charge, bounded *Demand left %*; model.md §2.11, §2.7b, §2.7c) | ✅ The three-stage board, equal share ([ui.md § Share the pain](../ui.md#share-the-pain)); the client confirmed one equal % for every category (O4, issue #90, §3.3) |
| S2 | **Outcome matrix** | Rows: irrigation demand at 100 / 85 / 70 % of today; columns: classes of annual natural water availability (very dry … very wet); each cell a risk label for the EWR | 🚧 Scenarios (WP-3.2), Reserve compliance (engine 0.21.0, 0.33.0) | A demand-scaling op, a batch of runs, year classes, the matrix view |
| S3 | **Seasonal irrigation outlook** | From storage and wet-season inflow at the start of the irrigation season: a recommended demand level, the season at 100 / 85 / 70 %, a monthly operating plan, storage-triggered review rules for a mid-season date, and the projected water balance | ✅ The outlook (R5), the computed review triggers (R6) and the published level on each farm's page (E3); 🚧 WP-3.8's drought restriction rule to apply the triggers in a run | The rule (WP-3.8) |
| S4 | **Licence impact at dry / typical / wet** | For each of three year types: natural flow − existing authorised use − the proposed abstraction = flow left, against the EWR, with a met / not met verdict | ✅ The impact report's board by year class (R7, §3.7), the verdict from the months; 🚧 existing *authorised* use needs the full-allocation run (WP-3.10) | Year classes, the full-allocation run, the summary board |

Two things in the sketches the app should **not** copy:

- **S1 charged the EWR to a group with no demand, giving it a negative
  "final demand".** The engine already bounds *Demand left %* to 0–100 and
  shows a no-demand node's charge as *store less / pass inflow* (engine
  0.17.0, plan.md Q13). The board shows that, not a negative number.
- **S3's seasonal irrigation total exceeded the natural water available.**
  Hypothetical figures, but the build must close: every board's totals come
  from the water account (model.md §2.11b), which closes to float noise.

## 2. Research findings

1. **SA allocates by priority, not equally.** The Reserve comes first; then
   domestic supply at a high assurance (98 %, about 1 year in 50 short); then
   economic uses, irrigation among the lowest, which are curtailed first
   (evidence: [Priority 2023], [WEM Vol 3]). DWS gazettes drought
   restrictions **per user category**: in the 2017 Western Cape drought, 20 %
   for domestic and industrial against 30 % for agriculture, rising to 40 %
   and 50 % (evidence: [PMG 2017], [Ziervogel 2019]). A single percentage for
   every group, as in S1's middle stage, is a fairness benchmark, not how a
   restriction is set; model.md §2.11 already says so and names the
   per-category cut of the authorised volume as the durable form.
2. **Restrictions are decided once a year at a decision date, from storage,
   and reviewed.** The Western Cape system's annual consultation balances
   allocations against storage in its dams at the end of the wet season
   (evidence: [DWS WCWSS 2022]). S3's "start of summer, review on a set
   date" matches that practice.
3. **A historical-analogue ensemble (ESP) is the right first seasonal
   method.** ESP runs the model from today's state with each historical
   year's weather. Its skill comes from the initial state (storage, soil
   moisture), which is exactly what a catchment with a distinct wet season
   has at the start of the dry season (evidence: [Kaune 2020]; the Pitman-WR2012 study found
   streamflow forecasts more skilful than the rainfall forecasts driving
   them, for the same reason, [Fikileni 2022]). Conditioning on a seasonal
   climate forecast (SAWS terciles, CFSv2) adds skill later but needs a
   feed and a downscaling step (evidence: [Fikileni 2022]).
4. **Over-confident outlooks cost more than cautious ones.** Planning on a
   high percentile of the ensemble brings costly downward revisions in dry
   years; a conservative percentile with a scheduled review gives most of
   the benefit (evidence: [Kaune 2020]). This argues for S3's review date
   and against a single "expected" number.
5. **EWR outcomes depend on timing, not annual totals.** S2's own footnote
   says so. The Reserve is a monthly (or daily) requirement read at the
   month's natural-flow percentile (model.md §2.9c). An annual waterfall like
   S4 can show "met" in a year that failed every summer month. The app's
   Reserve heat map exists because of this.
6. **Reliability, not a single year, is the planning measure.** Hashimoto's
   reliability / resilience / vulnerability, already in the engine
   (model.md §2.11a), describe a demand level across all years; a "25th
   percentile year" is one draw from that distribution (evidence:
   [Hashimoto 1982]).

## 3. Recommendations

### 3.1 R1: a `demand.scale` scenario op (foundation, **S**)

`{ op: 'demand.scale', factor, nodeIds?, months?, category? }`: multiplies
irrigation demand (and, for `category: 'user'`, other water users' demand)
by `factor` (0–2), optionally for some nodes or water-year months only.
Classified **proposal** when it targets only the author's nodes, else
baseline (scenarios.md § Classification). S2, S3 and a WUA's "what if
everyone takes 85 %" all need it; today it takes a `cropArea.set` per farm
and crop. **(judgement)** Scale demand, not crop area, so efficiency and
return flows are unchanged and the meaning is "85 % of what they'd take".
**Built** (engine 0.41.0): months are calendar month numbers 1–12 (the
engine's convention for month lists), categories `farm` (default) and
`user`, and ops stack; [scenarios.md § Op catalogue](../scenarios.md#op-catalogue)
has the rules.

### 3.2 R2: scenario sweeps as a background job (**M**)

A sweep = a base run × a list of op sets (e.g. `demand.scale` at 1.0, 0.85,
0.7), run as one job (WP-2.8, job kind `sweep`), results stored per member
as run summaries. An example-catchment run takes about 40 ms, so a 3 × 1
sweep is well under a second in the worker; the job exists for the
seasonal ensemble (R5), which multiplies by the record's years. Reuses the
uncertainty ensemble's storage pattern (model.md §2.10e).
**Built** (backend and API; migration 062): `POST|GET /projects/:id/sweeps`
and `GET …/sweeps/:sweepId` ([api.md § Sweeps](../api.md#sweeps)), job kind
`sweep`, tables `scenario_sweep` / `scenario_sweep_member`. Each member
stores its `RunSummary` and the catchment-level series `outcomeMatrix`
reads (not a `model_run`, so sweeps never count against the run cap), or
its problems when its ops don't apply to the base run; one
member never fails the sweep. At most 12 members, 2 pending sweeps per user,
the newest 20 kept per project ([scenarios.md § Sweeps](../scenarios.md#sweeps)
has the rules). Sweeps have no screen of their own: R4's outcome matrix (Runs tab → River
& Reserve, [ui.md](../ui.md)) is the first that starts and reads one.

### 3.3 R3: the share-the-pain board (**S**, presentation only)

Three stages side by side from the existing `CurtailmentSummary`:
*today* (supply % of demand), *equitable share* (the fairness benchmark,
with its footnote), *EWR met* (after the EWR charge, bounded). Other water
users appear as their own rows, marked senior or junior. **(evidence →
judgement)** Because SA practice cuts per category (§2 finding 1), add a
**category restriction** option: a % cut per category (domestic,
irrigation, industry) instead of one equal share, labelled as a what-if
until the authorisation-based allocation (model.md §2.11) exists.

**Built (equal share):** `curtailment/ShareThePainBoard.svelte` leads
the Runs tab's curtailment panel
([ui.md § Share the pain](../ui.md#share-the-pain)). **Decided
2026-09-28 (plan.md O4, issue #90):** the client wants every category cut
by the same %, which is the built `ShareRule { kind: 'equal' }`, so the
per-category restriction above is not built. Still open to the client:
whether the town's uses count as domestic or irrigation (it decides which
row a town's demand object sits in, not how the share is cut). Should a
per-category what-if be wanted later, `ShareRule` is where it goes (a
second rule kind, labelled as a what-if).

### 3.4 R4: year classes and the outcome matrix (**M**)

**Status: built.** The engine half: `views/yearClasses.ts`,
`views/outcomeMatrix.ts` (method, tie and partial-year rules in
[model.md §2.14](../model.md#214-water-year-classes-and-the-outcome-matrix-issue-53-r4-engine-half)).
The settings: `settings.outcomes`, the year-class method and the risk
cut-offs per measure, editable in Settings → Outcome matrix, with the
cut-offs' defaults marked *pending the hydrologist* until the hydrologist
confirms them (O1: the client agreed, issue #90; the class method's
default, O2, is confirmed) ([ui.md § Settings](../ui.md#settings--calibration), [api.md
§ Projects](../api.md#projects)). The screen: the Runs tab's **Outcome
matrix** panel ([ui.md § Outcome matrix](../ui.md#outcome-matrix)), the
first screen that reads a sweep: an editor starts a demand sweep of the
shown run (100 / 85 / 70 % by default, one `demand.scale` per level), the
panel follows the sweep's status, then draws the matrix from the stored
member series in the browser, so a settings change re-reads it without a
new sweep.

- **Classify water years** by the run's own natural flow at the outlet
  (annual total): terciles by default (dry / normal / wet) or quintiles
  when the record has at least 25 years **(judgement)**. Class bounds are
  printed in m³, so the columns are the catchment's own, not fixed
  bands.
- **Cell metric:** with a Reserve rule table, the share of months met
  against it; else % of days below the pragmatic EWR. The cell also prints
  **n years**. Fewer than 3 years in a cell shows "not enough years", no
  colour **(judgement)**. A record of only a few years could not fill it honestly.
- **Risk labels** come from project settings with defaults flagged
  *pending the hydrologist* (like the portfolio traffic lights, plan.md
  Q19). Wording is the fraction of years, "met in 7 of 9 dry years", never
  "likely".

### 3.5 R5: the seasonal outlook (**M–L**)

**Status: built but the farmer view.** The engine core
(`packages/engine/src/outlook/`, engine 0.44.0 for
`settings.demandFactorFrom`; method, day mapping, state continuation,
metric and planning rule in
[model.md §2.15](../model.md#215-seasonal-outlook-an-esp-ensemble-from-a-decision-date-issue-53-r5-engine-core)):
`runSeasonalOutlook` and its member-at-a-time parts, per level
season-end storage, % of demand met and the EWR/Reserve share as median
and 10th–90th percentiles with every year's values, and the planning
figure as data (`describePlanningFigure`). Only `demand.scale` ops make a
level (anything else would change the history the season starts from).
- **The backend** (migration 064, [api.md § Seasonal outlooks](../api.md#seasonal-outlooks)):
  job kind `outlook`, its own tables `seasonal_outlook` /
  `seasonal_outlook_member` rather than a sweep mode (a member is one level
  in one year measured over the season, and there are years × levels of
  them). Each member is stored once and never updated; `summariseOutlook`
  is the result. Up to 6 levels and the newest 40 analogue years (240
  member runs), 2 pending per user, the newest 20 per project. A member
  the engine refuses is stored as failed and the outlook carries on. The
  job runs the history once and each member over the season only, from a
  snapshot of the decision date (engine 1.1.0, model.md §2.16,
  `runOutlookMember`).
- **The settings** (`settings.outlook`, Settings → Seasonal outlook): the
  season as a month and day each end (default 1 October – 30 April, O3)
  and the planning share (default 80 %, O6), both confirmed by the client
  (issue #90), so no longer marked pending. The
  decision date is the latest one of that month and day the base run's
  state reaches. The 10-year minimum for percentiles still waits on the
  hydrologist.
- **The WUA screen** (Runs tab → River & Reserve → Seasonal outlook,
  [ui.md § Seasonal outlook](../ui.md#seasonal-outlook)): the demand levels
  and an optional monthly plan (R1's `months` form), the levels side by
  side with medians, 10–90 % ranges and years met, every analogue year,
  the planning figure in the engine's words, the pending defaults marked,
  a plain note that lower demand can add days below the EWR where return
  flow reaches the river, and the disclaimer's first and third paragraphs (D10).
- **The farmer view E3** (built; the client confirmed farmers see the
  outlook, O5, issue #90): the WUA publishes the level it decided
  (**Publish to farmers** on the outlook panel); each farm's page then
  shows *This season*: the level, what it gave that farm in the analogue
  years (its own share of demand met, and its dam at the season's end, as
  the median and the 10–90 % range), the review date, and that it is worked
  out from past weather, not a forecast or a promise, in English and
  Afrikaans ([ui.md § Farmer view](../ui.md#farmer-view-farm)). Each
  outlook member carries every farm's own demand and supply for it (engine
  1.19.0); a farmer reads only their own farms' figures (migration 104,
  [security.md](../security.md)).

- **Method:** ESP from the run's state on a decision date (a project
  setting, default the start of the irrigation season). For each historical
  water year, append that year's rain and evaporation for the season and
  run to season end, at each demand level of R1 (a sweep, R2). Report per
  demand level: season-end storage, % of demand met, EWR/Reserve compliance,
  each as median and 10th–90th percentile across years.
- **Planning figure:** the highest demand level that meets the EWR in at
  least a set share of analogue years (default 80 %, a setting) **(judgement,
  per §2 finding 4)**. The app reports that trade-off. It never "recommends
  a planning level" in its own voice; the WUA decides and publishes it
  as the restriction notice (WP-2.3), and the disclaimer covers the rest
  (D10).
- **Monthly plan:** the per-month demand factors of R1's `months` form;
  the outlook can test a front-loaded or tapering plan the WUA types in.
- **Farmer view:** the same result per farm fills ask E3 once the WUA
  publishes it.
- **Later:** condition the analogue years on a seasonal forecast tercile
  (weight members), once a feed exists; local default stays unconditioned.

### 3.6 R6: review triggers from the outlook, not asserted (**M**, with WP-3.8)

S3's trigger table ("above x m³ at the review date → 100 %, between → 85 %,
below → 70 %") should be **computed**: re-run the outlook from each storage
band at the review date and pick, per band, the highest demand level that
meets R5's rule. Once WP-3.8's drought restriction rule exists, the table
becomes that rule's parameters, so a scenario can simulate following it.

**Status: engine half built** (`packages/engine/src/outlook/triggers.ts`,
engine 0.46.0 for `settings.damStorageReset`; method, bands, start storage,
monotonicity and wording in
[model.md §2.15a](../model.md#215a-review-triggers-from-the-outlook-issue-53-r6)).
`runReviewTriggers(input, { reviewDate, seasonEnd, levels, edgesM3?,
representative?, analogueYears?, planningShare?, … })` runs the outlook
from the review date to the season end once per storage band, with the
farm dams set to the band's storage on the review date, and returns the
table fullest band first: per band the level picked (or none), the years
met of the years run, every level's count and percentiles, and the band's
whole outlook, with monotonicity notes and warnings (too few years, a band
where no level meets the rule, a table that isn't monotone: reported, not
smoothed). `describeTriggerRow` words a row: "At or above 400 000 m³ on
1 January 2013: 70 % met the EWR on every day of the season in 10 of 12
analogue years." Choices, each marked in model.md:
- **the review date** defaults to the first of the month holding the
  season's middle day (1 January for the default season), confirmed by
  the client (O3, issue #90);
- **the bands** are given as edges in m³ of total farm dam storage, or
  default to the terciles of the base run's storage on the review date
  across the record, three bands as S3 has **(judgement**, the tercile
  convention of seasonal forecasts, finding 3; pending the hydrologist);
- **a band runs from its lower edge** (the lowest from the lowest storage on record for the date, engine ≥ 1.11.0; empty dams before), so
  "at or above X" is what was run for the band's least favourable start,
  the cautious reading of finding 4; a midpoint option exists
  **(judgement, pending the hydrologist)**; the total is shared over the
  dams pro rata to capacity (every dam at the same fill);
- **starting from a storage**: since engine 1.1.0 the base run's state at
  the review date is captured once (a model-state snapshot, model.md
  §2.16) and each band sets its storage in the snapshot's dams
  (`withDamStorage`); the older path, `damStorageReset` (engine 0.46.0),
  re-runs the history per member and sets the dams on the review date.
  Either way the rest of the state is the history's; runs without them
  are unchanged to the bit.

Cost: one run of the history, then bands × years × levels runs of the
season alone (3 × 12 × 4 in 53 ms on the test catchment, against 1.1 s
re-running the history per member, engine 1.1.0).
WP-3.8's drought restriction rule isn't in the engine yet, so the table's
mapping to its parameters is a typed shape only
(`DroughtRestrictionTriggerParameters`, model.md §2.15a).

**Backend and screen: built** (engine 1.19.0, migration 104). The
`outlook` job draws the table after the outlook, for the season's review
date (`settings.outlook.review`, default the engine's `defaultReviewDate`,
1 January, O3): the bands and start storages from `reviewTriggerBands`,
every band × level × analogue year run from the snapshot with the band's
storage, then `reviewTriggerTable`, stored with the outlook. Because the
outlook's season starts from the base run's newest state, the run has no
state on this season's review date, so the table runs on the latest one
its record holds: a rule by storage band for that day of the year
(model.md §2.15a, **judgement, pending the hydrologist**). The outlook
panel shows it with each row in `describeTriggerRow`'s words, the notes
and warnings, and every level's years met per band
([ui.md § Seasonal outlook](../ui.md#seasonal-outlook)). Band edges stay
the terciles; a WUA setting its own would be a new setting. Still to
build: **WP-3.8's drought restriction rule**, which takes the table's
steps (roadmap step 3).

### 3.7 R7: licence impact by year class (**M**, inside the evidence report)

S4's board is a page-1 summary for the evidence report (issue #15), one
column per year class (R4), with two rows per class: the annual waterfall
(natural → existing authorised → proposed → left) **and** months below the
Reserve, baseline vs application. The verdict comes from the months, not the
annual total (§2 finding 5). "Existing authorised" needs the full-allocation
run (allocations.md § Still to build).

**Status: built** for the impact report (engine view
`packages/engine/src/views/licenceImpact.ts`, the board on page 1 of the
impact report, `report/LicenceImpactBoard.svelte`; method, the waterfall's
terms and the wording in
[model.md §2.14a](../model.md#214a-licence-impact-by-year-class-issue-53-r7-engine-and-report),
the screen in [ui.md § Report](../ui.md#report)). The view compares any
*background* run with the application: today the report's baseline, so the
board labels its use "existing use in the baseline", not "existing
authorised". Choices, each marked in model.md:
- **use is consumptive** (supplied less return flows, from the water
  account), so the waterfall ends at the outflow; the rest of the account
  (dams, storage, groundwater, land cover) is its own "other" step, broken
  down, so the waterfall closes (**judgement**);
- **the years are the background's classes**, counted only where both runs
  cover them in full; fewer than 3 in a class → "not enough years", no
  numbers;
- **the verdict** is from the Reserve months (days below the pragmatic EWR
  without a rule table), as data: "more / fewer / no change in months
  below", never "acceptable".

Still to build: the full-allocation background (WP-3.10 `allocationMode:
'fullAllocation'`, PR #116): when it lands, the report's background becomes
the baseline's full-allocation run and the label "existing authorised use"
([followups.md § Allocations](../followups.md#allocations-wp-310)); the
evidence report's page 1 (issue #15, Phase C) takes the same board.

### Order

R1 → R3 → R2 → R4 → R7 → R5 → R6. R1 and R3 are small and useful on their
own; R5 and R6 are the biggest and depend on the rest.

## 4. Questions for the client

In [plan.md § Decision-support outputs](../plan.md#decision-support-outputs-2026-09-26).

## References

- [Priority 2023] Principles and legal tools for equitable water resource
  allocation: prioritization in South Africa. *Int. J. Water Resour. Dev.*
  https://doi.org/10.1080/07900627.2023.2290522
- [WEM Vol 3] DWS water resource management documents, volume 3 (domestic
  supply at 98 % assurance).
  https://www.dws.gov.za/wem/documents/vol03Complete.pdf
- [PMG 2017] Western Cape drought crisis briefing: DWS, City of Cape Town,
  COGTA, NDMC and DAFF, Parliamentary Monitoring Group.
  https://pmg.org.za/committee-meeting/25329/
- [Ziervogel 2019] Ziervogel, G. *Unpacking the Cape Town drought: lessons
  learned.* African Centre for Cities.
  https://www.africancentreforcities.net/wp-content/uploads/2019/02/Ziervogel-2019-Lessons-from-Cape-Town-Drought_A.pdf
- [DWS WCWSS 2022] DWS update on the use of water in the Western Cape Water
  Supply System, hydrological year 2022/23.
  https://www.gov.za/speeches/update-use-water-western-cape-water-supply-system-wcwss-hydrological-year-202223-14-nov
- [Kaune 2020] Kaune, A. et al. The benefit of using an ensemble of seasonal
  streamflow forecasts in water allocation decisions. *HESS* 24, 3851–3870.
  https://hess.copernicus.org/articles/24/3851/2020/
- [Fikileni 2022] Fikileni, S., Wolski, P. Framework for implementation of
  the Pitman-WR2012 model in seasonal hydrological forecasting. *Water SA*
  48(1).
  https://scielo.org.za/scielo.php?script=sci_arttext&pid=S1816-79502022000100007
- [Hashimoto 1982] Hashimoto, Stedinger, Loucks. Reliability, resiliency
  and vulnerability criteria for water resource system performance
  evaluation. *Water Resour. Res.* 18(1).
