# Scenarios

A **scenario** is a named, ordered list of **overrides on a base run**: "raise
farm X's dam by 20 %", "replace a crop", "remove a farm", "add a transfer",
"scale rainfall −10 %". It runs and compares against its base without copying
the project, and because it keeps the base's ids every change lines up by id
in [run comparison](./run-comparison.md). Build plan:
[roadmap WP-3.2](./roadmap/step-3-licensing.md#wp-32-scenarios-within-a-project),
issue #18.

Status: built end to end: the **engine part** (`packages/engine/src/scenario/`),
the **backend and data model** (`backend/src/scenarios/`, migration 024), the
frontend's API client, and the **UI** (the Scenarios tab, its override
editor and scenario-vs-base comparison, and the compare page's Scenario
overrides section; § UI below).

## Engine: `applyScenario`

```ts
applyScenario(base: ModelInput, ops: ScenarioOp[], options?: { mask?: ScenarioMask }):
  { input: ModelInput; applied: AppliedOp[]; problems: string[]; renamed: MaskedRename[]; reIds: MaskedReId[] }
```

`mask` (the hidden nodes, id → the anonymous name the ops meet them by, and
the ids of the hidden crops, transfers, land-cover patches and boreholes) is
how an application is judged in its applicant's namespace
([§ Applications](#applications-wp-33)); without it `renamed` and `reIds`
are empty and nothing below changes.

- **Pure.** It never mutates `base`: settings and the model document are
  deep-copied, and a series is copied only when an op scales it (the other
  series arrays are shared with `base`, so treat the result as read-only).
  `runModel` is unchanged, and so is `ENGINE_VERSION`: a scenario is new
  input, not new model behaviour. The one exception is `demand.scale`
  (engine 0.41.0), whose node field `demandFactor` the engine had to learn
  to read (§ Demand scaling below); applying ops still never runs the model.
- **In order.** Each op sees the input the earlier ops left. An op on an
  element an earlier op removed is a problem.
- **Problems, not exceptions.** An op is skipped, and one line added to
  `problems`, when:
  - its target is missing (`op 3 (node.remove): node … not found`);
  - its value is out of range, or its field or path isn't whitelisted;
  - it would leave the model invalid: a second outflow node, a loop, a
    duplicate node or crop name (compare matches copies by name), a crop
    area on a non-farm, a transfer to itself or touching an other water
    user, land cover on a non-farm, a drought borehole rule without a dam,
    a supply rule or river pump that doesn't fit the node (on a gauge or
    user, `trigger` without a dam, `runOfRiver` with one, a stop level
    below the trigger; WP-3.8),
    a catchment with no land left (`runModel` refuses 0 km²), or a
    simulation, reporting or calibration window that ends before it starts.
    These are the model's save rules (`modelRuleIssues`,
    `packages/engine/src/modelRules.ts`, the one home the backend's
    `modelProblems` also calls) plus the windows and the area, in
    `scenario/structure.ts`. So a scenario can only produce a model the
    backend would accept as a save. Only issues the op *introduces* count, so an
    old base that already has one can still take unrelated ops.

  A skipped op changes nothing, and the ops after it still apply. `applied`
  lists the ops that did apply (`index` into the list) with `notes` on their
  side effects (upstream nodes re-linked, references dropped, days scaled).
  A rebase onto a newer base run is `applyScenario(newBase, ops)`: its
  `problems` are the ops that no longer apply.
- **Edit groups.** Consecutive `node.set` ops on the same node are one
  edit: the network rules above (the last item) are checked once, after the
  group's last op, not after each op. So fields the save rules tie together
  change together, in any order: a `trigger` farm goes straight to run of
  river with `supplyRule` → `runOfRiver` and `damCapacityM3` → 0 (either
  first), and both trigger levels rise without minding which comes first.
  Any other op, or a `node.set` on another node, ends the group (so two
  groups on one node with an op between them are checked apart). A group
  that still breaks a rule is skipped **whole**, so a scenario never keeps
  half an edit, and reported once, naming its ops and the node as it stood
  before them: `ops 3–5 (node.set, "Upper farm"): …` (a group of one reads
  `op 3 (node.set): …` as any op does). An op that fails its own check (the
  first two items: a missing node, a value out of range, a field its kind
  lacks) is still refused on its own with its own line, and the rest of its
  group counts without it: the group line then names only the ops that
  applied (`ops 3, 5 (…)`). The editor shows a group's line as the
  problem of every op it names (`ops.ts` `statusByOp`). With `mask`, a group's
  rule that turns on hidden data reads `doesn't apply to the catchment as
  modelled` like a single op's, and a hidden node is named by its mask name.
  `scenarioSteps(base, ops)` gives the input each op meets under these rules
  (an op in a group meets the group's earlier ops, not yet checked) and what
  a next op would meet (a last `node.set` group that still breaks a rule
  included, so a form adding one op at a time builds on it);
  `classifyScenario` classifies each op against the same inputs.

### Op catalogue

Every op targets by id; `ScenarioOp` is a closed union discriminated by `op`.

| Op | Fields | What it does |
| --- | --- | --- |
| `node.set` | `nodeId, field, value` | Sets one whitelisted field (below). Typed per field. |
| `node.add` | `node` | Adds a **leaf** node that drains into an existing node (never a new outflow). Fields it leaves out take the engine's defaults (`upgradeLegacyModel`: no boreholes, senior user, dam area estimated, dam-first supply with no river pump). It may carry a supply rule and river pump (`supplyRule`, `pumpCapacityM3Day`, `supplyTriggerPct`, `supplyStopPct`, engine ≥ 0.42.0, [model.md §2.7e](./model.md)), checked like the rest; `node.set` changes them on an existing farm. It may also carry the GN 538 property area and Table 2 rate (`gaPropertyAreaHa`, `gaRateM3HaYear`, engine ≥ 1.12.0, [model.md §2.7d](./model.md)), context for its groundwater; there is no `node.set` for them. |
| `node.remove` | `nodeId` | Removes a node. Nodes that drained into it now drain into its downstream node, so the network stays one tree. Drops its crop areas, transfers from or to it, its land-cover patches and any EWR rule table sited at it. The outflow node can't be removed. |
| `cropArea.set` | `nodeId, cropId, areaM2` | Sets a farm's area of one crop (m²); `0` removes the row. Replaces duplicate rows with one. |
| `crop.add` | `crop` | Adds a crop definition (12 crop factors, and optionally its own `irrigationEfficiency`, engine ≥ 0.43.0). |
| `transfer.add` | `transfer` | Adds a transfer rule. Months are stored as a sorted set. |
| `transfer.set` | `transferId, field, value` | `fromNodeId`, `toNodeId`, `months`, `maxRateM3s`, `dailyCapM3`, `minStoragePct`, `enabled`, `priority`, `monthlyRateM3s` (engine ≥ 1.14.0: twelve m³/s rates, Oct–Sep, or null; setting it also sets `months` and `maxRateM3s` to match, and a `months` or `maxRateM3s` edit on a rule with monthly rates is skipped, since the save rules refuse the disagreement, [model.md §2.6](./model.md)), and a river off-take's `source`, `handsOffM3Day`, `handsOffEwr`, `lossPct`, `sizing`, `topUpDam` (engine ≥ 1.14.0, [model.md §2.6a](./model.md); an edit that makes an off-take's destination drain into its source is skipped with that rule as its problem). `transfer.add` takes the same fields, each optional. |
| `transfer.remove` | `transferId` | Removes a transfer rule. |
| `landCover.add` | `patch` | Adds a land-cover patch on a farm (WP-1.35). |
| `landCover.remove` | `patchId` | Removes a patch, e.g. clearing invasive aliens. |
| `borehole.add` | `borehole` | Adds an individual borehole on a farm or other user (WP-3.9), e.g. an applicant's new borehole with its tested yield and annual volume. |
| `borehole.remove` | `boreholeId` | Removes a borehole. `node.remove` drops the node's boreholes too. |
| `settings.set` | `path, value` | Sets one whitelisted setting (below). Nested paths write over what is there. |
| `series.scale` | `kind, factor, from?, to?` | Multiplies a rain series or the daily A-pan series by `factor` (0–10) on the days `from`–`to` (ISO dates, inclusive; each end open when absent). Missing days stay missing. |
| `ewrRule.set` | `table` | Sets or replaces the Reserve rule table of one EWR site (engine ≥ 1.6.0, WP-3.7): `table.siteNodeId` is the site. Always a baseline assumption. § Reserve rule tables. |
| `demand.scale` | `factor, nodeIds?, months?, category?` | Multiplies demand by `factor` (0–2): the farms' irrigation demand (`category: 'farm'`, the default) or the other water users' (`'user'`). `nodeIds` limits it to those nodes (default: every node of the category), `months` to those calendar months (default: every month). It multiplies each target's `demandFactor`, so ops stack (0.9 twice is 0.81). Engine ≥ 0.41.0, issue #53 R1; § Demand scaling. |

**`node.set` fields, per node kind.** Never `id`, `kind`,
`downstreamNodeId` (the network's shape: use `node.add` / `node.remove`) or
`sortOrder` (display only).

- farm: `name`; land `areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`;
  dam and irrigation `pctUpstreamToDam`, `pctRunoffToDam`, `damCapacityM3`,
  `damInitialPct`, `damMinPct`, `damAreaFullM2`, `damAreaExponent`,
  `damSeepagePerDay`, `divertCapacityM3Day`, `irrigationEfficiency`,
  `lossReturnFraction`; dam storage (WP-3.5) `damReleaseRule`,
  `damReleaseM3Day`, `damOutletCapacityM3Day`, `damSeepageReturnPct`, and
  the survey curve `damCurve` (engine ≥ 1.20.0: up to 200 rows of
  `{ levelM, areaM2 ≥ 0, volumeM3 ≥ 0 }`, or null for none, the power law;
  whether the rows make a usable curve, volume rising and some area, is a
  save rule checked when the op applies; a `node.add` could always carry
  one); development over the run (engine ≥ 1.30.0, [model.md
  §2.7g](./model.md)) `damSurveyDate`, `damSedimentPctPerYear` (0–0.2, a
  share of the surveyed capacity a year; needs the survey date, a save rule),
  `damInServiceFrom` and `abstractionFrom` (ISO dates or null), so a
  proposal can bring a dam or an abstraction in from a date; boreholes `boreholeCapacityM3Day`, `boreholeRule`,
  `boreholeTriggerPct`, `streamDepletionFrac`, `streamDepletionLagDays`;
  supply rule and river pump (WP-3.8, [model.md §2.7e](./model.md))
  `supplyRule` (`damFirst` | `riverFirst` | `trigger` | `runOfRiver`),
  `pumpCapacityM3Day` (≥ 0, null = no limit), `supplyTriggerPct`,
  `supplyStopPct` (0–1). How they fit together is a save rule, checked
  when the op applies: only a farm has them, `trigger` needs a dam,
  `runOfRiver` has none (`damCapacityM3` 0), and the stop level is at least
  the trigger level under `trigger`. The rules are checked once after a
  run of `node.set` ops on the same farm (§ Engine, Edit groups), so set
  the fields that go together next to each other, in any order: `trigger`
  to run of river is `supplyRule` → `runOfRiver` and `damCapacityM3` → 0;
  raised levels are `supplyStopPct` and `supplyTriggerPct`. "What if this
  farm pumps from the river at 1,200 m³/day" is two ops: `supplyRule` →
  `riverFirst` and `pumpCapacityM3Day` → 1200.

  **Dam capacity** (engine ≥ 1.10.0, [model.md §2.13](./model.md), pending
  the hydrologist). A `damCapacityM3` op that resizes an existing dam (from
  and to a capacity above 0) resizes its geometry along the dam's own
  area–volume relation, as the storage–yield curve does: a power-law dam's
  `damAreaFullM2` (as entered, or the capacity ÷ 3 m estimate) becomes
  A_full × (new ÷ old)^b with its own `damAreaExponent`; a survey curve is
  cut at its top × the ratio, or extrapolated beyond the survey to it
  (a power law through its top two rows). The op's note says what changed
  (`dam area when full 33333 → 54150 m² …`, or that the curve was
  extrapolated); it is left out for a node the caller can't see. A later
  `damAreaFullM2` op on the node sets the enlarged dam's own area; one before
  the capacity op describes the dam at its old size and is resized with it.
  A new dam (from 0) keeps an unknown area unknown. Before 1.10.0 the area
  stayed as entered, or followed capacity ÷ 3 m (constant mean depth).
  **The enlarged dam's own survey** (engine ≥ 1.20.0): a `damCurve` op
  after the capacity op replaces the resized curve with the one entered. A
  survey curve whose top row is already within 1 % of the new capacity (the
  tolerance a run allows between the two) is left as it is, and the capacity
  op's note says so: one a `damCurve` op before it set describes the new dam,
  so the two ops mean the same in either order, and the base's own curve is
  not stretched for a change that small (before 1.20.0 it was). One that fits the old capacity
  instead describes the dam at its old size and is resized with it, as an
  earlier area op is. "Raise this dam to 240 000 m³ with its surveyed curve"
  is two ops: `damCapacityM3` → 240000 and `damCurve` → the survey rows. The
  "Add a change" form takes the rows pasted as the Network tab's survey box
  reads them (level, area, volume, one row per line) and checks them the
  same way; empty is none.
- user (other water user): `name`, `userDemandM3Day`, `userReturnPct`,
  `userPriority`, `abstractionFrom` (engine ≥ 1.30.0), and the borehole fields.
- gauge: `name`, and `ewrSite` (engine ≥ 1.5.0, true or false): whether the
  EWR is assessed at the gauge ([model.md §2.7b](./model.md)). The outlet
  can't be taken off (a model rule), and the op is always a baseline
  assumption (§ Classification). A site's Reserve rule table is `ewrRule.set`
  (§ Reserve rule tables), not a `settings.set` path.

Ranges are the backend's (`backend/src/model/validate.ts`).

**`settings.set` paths:** `februaryDays`, `effectiveRainFraction`,
`effectiveRainFractionMonthly`, `effectiveRainStoreMm`, `lakeEvapFactor`, `lakeEvapFactorMonthly`, `apanMm`, `panCoefficient`,
`ewrPragmaticM3PerDay`, `flowShareMethod`, `hiLoSplit.hi`, `hiLoSplit.lo`,
`gr4j.x1`–`gr4j.x4`, `gr4j.warmupDays`,
`chirpsBiasCorrection`, `zeroRainRuns.mode`, `zeroRainRuns.accumulationMode`,
`calibration.rainThresholdMm`, `calibration.catchmentAreaKm2`,
`simulationStart`, `simulationEnd`,
`reportStart`, `reportEnd`, `calibrationStart`, `calibrationEnd`,
`calibrationFlowKind`, `pe`, and from engine 1.3.0 (issue #64) `ewrChargeSource`
(`pragmatic` | `ruleTable`) and `lowFlowMeasure` (`total` | `baseflow`), and
from engine 1.18.0 (issue #72) `allocationMode` (`none` | `cap` |
`fullAllocation`: a full-allocation scenario on a base run is the "every
registered user takes their entitlement" background, [model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
Ranges follow `backend/src/projects/settings.ts`.
`pe` (engine ≥ 0.31.0, issue #39) takes a whole PE input, GR4J's source
of potential evaporation: `{ kind: 'pan' }` with no other key, or
`{ kind: 'monthly', mm, source }` with 12 finite values of 0–10 000 mm and
a source that is not blank when trimmed, at most 600 characters. Like every
`settings.set`, it is classified baseline.
Every path is one the input diff reports, so no setting changes silently.

**Retired paths (engine 1.0.0, issue #16).** `runoffModel`,
`calibration.a`, `calibration.b`, `calibration.summerFactor`,
`calibration.winterFactor`, `calibration.baseFlowInitial` and
`calibration.summerMonths` belonged to the legacy runoff model, which engine
1.0.0 removed (`RETIRED_SETTINGS_PATHS` in `scenario/ops.ts`). An op on one
is refused with "… belonged to the legacy runoff model, removed in engine
1.0.0: delete this change": a new one when the ops are saved, a stored one
as a problem when the scenario is checked or run. Migration 063 leaves
stored ops alone (they are hashed), so the scenario shows the op by its path
and the editor deletes it.

**Demand scaling (`demand.scale`, engine ≥ 0.41.0, [planning-outputs.md
R1](./design/planning-outputs.md#31-r1-a-demandscale-scenario-op-foundation-s)).**
"What if everyone takes 85 %?" in one op, where it used to take a
`cropArea.set` per farm and crop.

- **It scales demand, not crop area.** Each target node gets a
  `demandFactor`: 12 multipliers in water-year order (Oct–Sep, like every
  monthly row), 1 where the op's months don't reach. For a farm the engine
  multiplies the crop water requirement F (after effective rain and the
  soil-water store), so the abstraction D = F ÷ e scales with it while the
  crop area, the gross demand, the rain used, the irrigation efficiency and
  the loss return stay as they are: 85 % means "85 % of what they'd take".
  A unit's demand objects (engine ≥ 1.7.0, model.md §2.7f) scale with it,
  month by month; there is no op for one object yet (followups.md).
  For an other water user it multiplies the monthly demand (and so the
  senior requirement passed to the farms above it). Model.md §2.3 step 4a.
- **Months** are calendar month numbers 1–12 (Oct = 10), the convention of
  every month *list* in the engine (`transfer.months`); the 12-value *rows* (`demandFactor`,
  `userDemandM3Day`) run Oct–Sep. Left out, every month.
- **Categories:** `farm` (default) and `user`. One op scales one category;
  both is two ops. A gauge has no demand.
- **Problems** (the op is skipped): a factor outside 0–2; an empty or
  repeating `nodeIds` or `months` (leave the field out for all of them); a
  month outside 1–12; a category other than the two; a node id the input
  doesn't have (`node … not found`); a node of another kind (`"Town" is an
  other water user, not a farm`); no node of the category at all when
  `nodeIds` is left out (`the model has no other water user to scale`). The
  first four are the validator's too. Without `nodeIds` the note says how
  many nodes were scaled.
- `demandFactor` is set only by this op: the model editor, the model save and
  `node.set` don't carry it, and override mode keeps a scaled node's factor
  as it is. The input diff reports it (`demand factor none → 0.85, … (Oct–Sep)`).

**Reserve rule tables (`ewrRule.set`, engine ≥ 1.6.0, WP-3.7).** "What if
the Reserve at this site were the desktop estimate, not the gazetted table?"
The op carries a whole `EwrRuleTable` ([model.md §2.9c](./model.md)), its
`siteNodeId` the site.

- **Set or replace.** A site with a table has it replaced whole; one without
  gets it. The outlet is one site whether a table names it `null` (as
  Settings saves it) or by the outlet node's id (as the run also reads it),
  and a replaced table keeps the key its site had, so run comparison sees
  that site's table changed rather than one removed and one added. There is
  no op to remove a table yet.
- **Checked as Settings checks it.** The validator rebuilds the table from
  its known fields (a high-flow component's too) and runs the engine's
  `ewrRuleTableIssues`, the checks the Settings form and the settings API
  use, so a table a scenario sets is one Settings would save; its errors are
  the Settings form's sentences (`ops[0].table.source: Say where the table
  comes from …`). Applied, the table is kept as the run reads it: the source
  trimmed, no natural grid unless it is the natural source, `sourceKind`,
  `category` (the REC, ER9) and `naturalMarMcm` (engine ≥ 1.11.0, the determination's natural MAR)
  only when stated.
- **Problems** (the op is skipped): a table that fails those checks; a site
  that isn't the outlet or a gauge (`an EWR site is the outlet or a gauge;
  "Upper farm" is a farm`); a missing node; a gauge taken off the EWR sites
  (`"Weir" is not marked as an EWR site: set its EWR site flag first`, so a
  scenario that flags a gauge and gives it a table puts `node.set ewrSite`
  first); a 21st table (`At most 20 rule tables.`).
- **Always a baseline assumption**, whoever owns the site's gauge: the
  Reserve is the authority's, never part of a proposal. An application may
  make one (§ Applications): like every baseline op it is shown to the
  assessor in red, not refused.
- The input diff reports it per field (source, kind of source, EWR values
  per month …, `run-comparison.md`), and the editor describes it with its
  confidence line: "Reserve rule table at the outlet (Outflow gauge): “GN …”
  (Gazetted Reserve) → “…” (Desktop estimate, low confidence), total flow,
  10 % points".

**Which series scale.** The rain drivers, `rain_catchment_mm`,
`rain_chirps_mm`, `rain_forecast_mm`, and the daily A-pan evaporation
`evap_apan_mm` (engine ≥ 0.38.0, [model.md §2.3a](./model.md#23a-daily-a-pan-evaporation-engine--0380-issue-45)).
- The monthly A-pan means are the setting `apanMm` (and, for GR4J,
  `panCoefficient` or a monthly `pe` row), changed with `settings.set`. On a
  project with a daily A-pan series they reach only the days the series
  doesn't cover, so an evaporation scenario there scales the series too.
- Observed and logger flow are measurements the run is *scored against*,
  not drivers: scaling them would change the calibration statistics and the
  EWR agreement, never the simulated water. Not scalable.
- The reference gauge is never read by the engine.

## Classification: proposal or baseline assumption

`classifyOp(op, ownedNodeIds, input?)` returns `'proposal'` or `'baseline'`;
`classifyScenario(base, ops, ownedNodeIds)` classifies a whole list against
the input each op meets, counting nodes the scenario added as owned. The UI's
red **Baseline assumptions changed** callout shows whenever any op is
`baseline`. The rules are conservative: what can't be placed is `baseline`.

| Op | Proposal when | Otherwise |
| --- | --- | --- |
| `settings.set`, `series.scale`, `ewrRule.set` | never | baseline (settings, calibration, EWR and the Reserve's rule tables, flow-share method, climate) |
| `node.set` | the node is owned and the field is not land or flow share (`areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`), a gauge's `ewrSite`, or a dam's `damSurveyDate` / `damSedimentPctPerYear` (engine ≥ 1.30.0); so the own farm's supply rule and river pump, and a dam or an abstraction from a date, are the proposal (how the farm takes water is what a licence to abstract asks for, like a new pump) | baseline: other parties' nodes, the catchment's partition of runoff, where the EWR is assessed, and a dam's survey and sediment (the dam as it is) |
| `node.add` | not a gauge, and no land or manual flow share of its own (a new dam, pump or user) | baseline: a gauge moves an EWR site; land or a manual flow share re-partitions the catchment |
| `node.remove` | owned, not a gauge, no land or manual flow share, and no EWR rule table sited at it (needs `input`) | baseline |
| `cropArea.set`, `landCover.add` | on an owned node | baseline |
| `crop.add` | always | |
| `transfer.add` | both ends owned | baseline |
| `transfer.set`, `transfer.remove` | both ends owned, and a new end owned too (needs `input`) | baseline |
| `landCover.remove` | the patch is on an owned node (needs `input`) | baseline |
| `borehole.add` | on an owned node | baseline |
| `borehole.remove` | the borehole is on an owned node (needs `input`) | baseline |
| `demand.scale` | `nodeIds` given, and every one owned | baseline: without `nodeIds` it scales every farm (or user) in the catchment, and a named node that isn't the author's is another party's |

## Validation: `validateScenarioOps`

`validateScenarioOps(raw: unknown) → { ops, errors }`, zod-free, so the
backend can call it or mirror it. It rebuilds each op from its known fields
only (unknown keys are dropped) and names every error by path
(`ops[3].value: must be at most 1`). At most 500 ops. The backend rejects the
body when `errors` is non-empty. Whether a target id exists depends on the
base run, so that is `applyScenario`'s job, not the validator's. Ids are any
non-empty string here; the backend tightens them to UUIDs (`backend/src/scenarios/schema.ts` `checkOps`).

## Tests

`packages/engine/src/scenario/`, all in `pnpm test`:
- `overrides.test.ts`: each op applies and rejects bad targets; `node.remove`
  keeps a valid tree (`buildTopology`); a deep-frozen base is never mutated;
  a 20 % dam raise changes that dam and never the farm upstream or beside it,
  and gives identical results in any node order; edit groups (a `trigger`
  farm to run of river in one group of 3 ops in either order, both trigger
  levels raised in either order, a group that still breaks a rule skipped
  whole with one problem naming its ops, an op failing its own check
  refused alone, an op between two splitting them, masked groups,
  `scenarioSteps`); the classifier; the validator.
- `scenario.invariants.test.ts`, over random op lists on `randomInput(seed)`
  (generator `testing/scenarioFuzz.ts`, `randomOps`):
  - `checkAll` (every engine invariant, order invariance included) holds on
    250 scenarios;
  - **no silent change**: on 1000 scenarios, every op that changes the
    resolved input produces at least one `InputChange` from
    `diffInputs`, an empty op list produces none, and a skipped op changes
    nothing;
  - applied ops keep a valid tree and never touch the base;
  - `demand.scale` on 50 networks each: factor 1 on every farm and user in
    every month gives the same output to the bit; factor 0 on a random set of
    nodes gives those nodes zero demand, supply and groundwater, and the rest
    their demand unchanged; a random factor and months give each node the
    base's demand × the month's factor, never supplied beyond it.

  `overrides.test.ts` has `demand.scale`'s own cases: what it sets (default
  every farm, some nodes and months, stacking), the run (crop requirement and
  demand scaled, gross demand, rain and store not), `category: 'user'`, the
  problems, the input diff, its classification and its validation; and
  `ewrRule.set`'s (engine ≥ 1.6.0): the outlet's table replaced however it
  is keyed, a gauge's added then replaced, the run assessing the scenario's
  table, the problems, always baseline (masked too), the input diff, and the
  validator's Settings-form errors. The fuzz generator (`randomOps`) adds
  `ewrRule.set` ops from a stream of their own, so the no-silent-change
  property covers them.

  Soak: `SCENARIO_FUZZ_CASES=5000 pnpm -C packages/engine exec vitest run src/scenario/scenario.invariants.test.ts`.

## Not yet supported

Each of these is a follow-up, not a gap in what's listed above:
- **Allocations**: `allocation.set` (roadmap WP-3.2's later ops). The EWR
  rule table op is built (`ewrRule.set`, engine ≥ 1.6.0, § Reserve rule
  tables); removing a site's table is not an op yet.
- **Moving a node** (`downstreamNodeId`) and **inserting a node mid-river**
  (re-pointing existing nodes into a new one): `node.add` adds leaves only.
- **Editing a crop** (`crop.set` on crop factors) and **removing a crop**;
  "replace a crop" is `cropArea.set` to 0 on the old one plus
  `cropArea.set` on the new one.
- **Editing a land-cover patch** in place (`landCover.set`): remove and add.
- **Scaling observed flow** (see above: deliberately not a scenario).
- **Climate and stochastic transforms** (WP-4.11) will sit beside
  `overrides.ts` in `scenario/`.

## Backend

`backend/src/scenarios/`: `routes.ts` (the API below), `schema.ts` (request
bodies), `execute.ts` (`executeScenarioRun`).

- **Ops in.** `schema.ts` wraps the engine's `validateScenarioOps` in zod, so
  the backend accepts exactly the ops the engine defines, with every error by
  path, and tightens every id to a UUID (the ids end up in `uuid` columns such
  as `run_series.node_id`). `opsSha256` is the SHA-256 of the ops as RFC 8785
  canonical JSON (engine `canonicalJson`).
- **Base in.** The base run's exact input is `loadRunInput(db, baseRunId)`
  (WP-3.1): its settings and model snapshot plus its stored series, never the
  live model. A run saved before stored inputs (migration 021) is refused with
  `409` and `loadRunInput`'s reason. A scenario run can't be a base: compare
  lists every op a scenario makes against its base, which a chain would hide.
- **The check.** `checkScenario(base, ops, ownedNodeIds)` is `applyScenario`
  plus `classifyScenario`: which ops applied, which don't (`problems`) and how
  each is classed. `GET`, `POST` and `PATCH` return it beside the scenario,
  so the editor shows it without running anything.
- **The run.** `runScenario` = `loadRunInput(base)` → `applyScenario` →
  `storeRun`, the one save path `executeRun` also uses (the engine's
  checked run, the outputs, the stored inputs), with `model_run.scenario_id`
  set and `inputs.scenario = { id, name, baseRunId, ops, opsSha256,
  ownedNodeIds, classified }` in the run's snapshot. It refuses (`422`, the
  problems listed) when any op doesn't apply: a result with an op silently
  skipped would not be the scenario its name says. The run then counts toward
  the project's 20-run cap like any other (`trimRuns`). The engine runs
  between two transactions, with no connection held; the storing one checks
  the caller's right to run it again and refuses (`409`) if the scenario's
  ops, base run, owned nodes or origin changed meanwhile, or `404` if it was
  deleted ([architecture.md § A model run](./architecture.md#a-model-run)).
- **Why the result can't drift.** The base is a stored snapshot and the ops
  are stored, so running a scenario again gives the same result whatever has
  happened to the live model since, even a node deleted from it
  (`scenarios.db.test.ts` checks it is identical, and equal to
  `runModel(applyScenario(loadRunInput(base), ops))`).
- **Rebase** is `applyScenario(newBase, ops)`: `problems` are the ops that no
  longer apply to the newer base (for example a node removed since). It saves
  the new base with the ops unchanged, or with `dryRun` only reports; the
  scenario won't run until its ops apply again (edit them with `PATCH`).
- **Names kept with the ops** (`names.ts` `opNames`, migration 047). An op
  names nodes and crops by id, and the editor reads their names from the base
  run's snapshot. After a rebase onto a run without a node, that snapshot
  can't name it, so the scenario keeps `op_names`: `{ id, name }` for every
  node and crop its ops name, taken from the base run's snapshot on `POST`,
  on a `PATCH` of the ops, and on a rebase. A name stays while an op still
  names that id; the current base's name wins when it has one. It is display
  only (not in `opsSha256` or a run's snapshot), and the server writes it:
  clients never send names.
- **Status.** `draft → submitted → withdrawn | decided`, and `withdrawn →
  draft`. Only a draft's ops, owned nodes and base change; a submitted or
  decided scenario can't be deleted. On a team scenario any editor moves it;
  on an application only its owner, and only an assessor decides it
  ([§ Applications](#applications-wp-33)).
- **The base is cited** (`model_run_cited`), so it can't be deleted,
  trimmed or unpinned while the scenario exists, and its pin doesn't count
  against the 10-pin ceiling. `RunMeta.citedBy` lists the publications holding it and the scenarios based on
  a run. Deleting the scenario releases it; the scenario's own runs stay, as
  ordinary runs that remember their scenario's name.

## Data model

Migration `024_scenarios.sql`
([data-model.md § Scenarios](./data-model.md#scenarios-024_scenariossql)):

- `scenario (id, project_id, name, description, base_run_id → model_run,
  ops jsonb, ops_sha256, owned_node_ids uuid[], owner_user_id, status,
  created_at, updated_at, op_names jsonb)`: a team scenario's name unique
  among the project's team scenarios, an application's among its owner's
  applications (ignoring case; 049, so naming a draft never says a hidden one
  exists), at most 500 ops. `op_names` (047) is the ops' display names above.
- `model_run.scenario_id → scenario` (`ON DELETE SET NULL`), set on insert
  only.
- Triggers: the base is a run of the same project and not a scenario run; a
  run's scenario is its own project's; the owner is stamped from the session;
  a non-draft is frozen; status moves as above.
- RLS: viewer read, editor write; **farmers read nothing** (a scenario's ops
  and base name every farm; the catchment report makes the same call).
  `045_contributor_scope.sql` rewrote them for applications
  ([§ Applications](#applications-wp-33)): a team scenario keeps exactly these.
- `model_run_cited` gains a clause (a scenario's base) beside 022's
  publication clause, and the pin ceiling stops counting cited runs.
- The publication-history cap (newest 12) spares a publication whose run a
  scenario is based on, so the base keeps its "published" record. Editors
  may base a scenario on any run of the model, published or not; an
  application's base must be a published run (current or in the history).
- `run_series.node_id` stops being a foreign key to the live `node` table: a
  scenario run has nodes the live model doesn't (`node.add`), and the old
  cascade deleted a node's series from every earlier run when the node was
  deleted from the model. A trigger now checks each series names a node of
  its own run's snapshot.

## API

[api.md § Scenarios](./api.md#scenarios):

- `GET|POST /projects/:id/scenarios`
- `GET|PATCH|DELETE /projects/:id/scenarios/:sid` (PATCH replaces `ops`;
  `409` once submitted)
- `POST /projects/:id/scenarios/:sid/runs`
- `POST /projects/:id/scenarios/:sid/rebase { baseRunId, dryRun? }`
- `GET /compare/runs` adds `scenario: { id, name, baseRunId, ops, opsSha256,
  ownedNodeIds, classified } | null` per side, from the run's own snapshot
  ([run-comparison.md § Scenario runs](./run-comparison.md#scenario-runs)).
- `RunMeta` gains `scenarioId`, `scenarioName` and `citedBy`.

The frontend's client has them as `api.scenarios.{list, get, create, update,
remove, run, rebase}` and `scenarioProblems(err)` (the `422`'s lines), with
the types in `frontend/src/lib/api/types.ts` (`Scenario`, `ScenarioCheck`,
`ScenarioWithCheck`, `CompareScenario`, `RunCitation`).

`schema.ts` `opIds` names each id an op holds; a `demand.scale`'s are
`nodeIds[i]`, so each must be a UUID and each node's name goes into
`op_names`.

Backend tests: `backend/src/scenarios/scenarios.db.test.ts` (the API end to
end, RLS with positive controls, cited bases, status, a dropped node's name
kept through a rebase and a re-read; a `demand.scale` on one farm in one
month classed baseline, then proposal once the farm is owned, stored with its
`demandFactor` and run, the stored daily demand the base's × the factor on
exactly those days and the other farm's untouched; one with no `nodeIds`
baseline even with every farm owned, the same scale naming them a
proposal), `schema.test.ts` and `names.test.ts`.

## Sweeps

A **sweep** (issue #53 R2, [planning-outputs.md §3.2](./design/planning-outputs.md#32-r2-scenario-sweeps-as-a-background-job-m))
is one saved base run × a list of named **members**, each an op set, run
as one background job. The main use is demand levels: `demand.scale` at
1.0, 0.85 and 0.7, three members of one op each, which R4's outcome matrix
reads. Built as backend and API only
(`backend/src/sweeps/`, the `sweep` job in `backend/src/jobs/handlers/sweep.ts`,
migration 062). The first screen that starts and reads one is R4's
outcome matrix on the Runs tab ([ui.md § Outcome matrix](./ui.md#outcome-matrix)):
demand levels only, one `demand.scale` op per member.

- **Not a scenario.** A member has no row in `scenario` and makes no
  `model_run`: it stores its **run summary** (the `RunSummary` a run
  stores in `model_run.summary`) and the catchment-level daily series R4's
  outcome matrix reads (`natural_flow`,
  `simulated_outflow`, `ewr`, `ewr_shortfall`; `SWEEP_SERIES_KEYS`), never
  every node's series, so a sweep never counts against the 20-run cap and
  never shows in the run list. A member's `{ startDate, series, summary }`
  is what `outcomeMatrix`'s `OutcomeLevelInput.run` takes (map `null`
  values back to `NaN`). The storage follows the
  uncertainty ensemble's pattern ([model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9)):
  the row with everything its result depends on is written first, the
  result is stored once by whoever asked, and never changed after
  ([data-model.md § Scenario sweeps](./data-model.md#scenario-sweeps-062_scenario_sweepssql)).
- **Validation.** Each member's ops are checked as a scenario's are
  (`scenarios/schema.ts` `checkOps`: the engine's `validateScenarioOps`,
  ids as UUIDs) when the sweep is asked for. Whether they *apply* to the
  base run is checked per member by the job, with `checkScenario` as a team
  scenario with no owned nodes: a member whose ops don't apply stores its
  problems (`status: problems`, the same lines a scenario's check gives), a
  member the engine refuses stores the engine's message (`failed`), and the
  other members still run. A sweep never fails for one member.
- **The job** (`sweep`, [architecture.md § Background work](./architecture.md#background-work))
  runs as the editor who asked, under RLS, and fails closed if they lost the
  role. It rebuilds the base run's stored input once (`loadBaseInput`),
  applies each member's ops and runs the engine inside the job's
  transaction, so every member's outcome commits with the job's `done`; it
  reports progress after each member. A base run that can't be rebuilt any
  more fails the job, and the sweep stays `pending` with the job's error.
  Works locally with `JOB_TRANSPORT=inprocess` (`pnpm dev:full`) or
  `pnpm dev:jobs:tick`.
- **Limits.** At most **12 members** (`SWEEP_MEMBERS_MAX`, a CHECK on
  `position`): R4 and R5 use 3–5 demand levels, 12 leaves room for a
  monthly plan while keeping every member of the largest catchment in one
  job transaction well inside the job's lease. At most 2 sweep jobs queued
  or running per user; the project keeps its newest 20 sweeps; a sweep goes
  with its base run.
- **Base run.** An ordinary run of the model only, as for a scenario: not a
  scenario run, not a forecast run (a sweep is judged on history).
- **Not the seasonal outlook.** R5's outlook runs from a run's state on a
  decision date, one member per demand level × analogue year, measured
  over the season only: its own `outlook` job and tables, not a sweep mode
  ([api.md § Seasonal outlooks](./api.md#seasonal-outlooks),
  [data-model.md § Seasonal outlooks](./data-model.md#seasonal-outlooks-063_seasonal_outlooksql)).

API: `POST|GET /projects/:id/sweeps`, `GET /projects/:id/sweeps/:sweepId`
([api.md § Sweeps](./api.md#sweeps)). Tests: `backend/src/sweeps/schema.test.ts`
(the body) and `sweeps.db.test.ts` (the job end to end, problems per member,
RLS with a positive control, write-once outcomes, limits, cascade).

## UI

The workspace's **Scenarios** tab (`?tab=scenarios&scenario=<id>`,
`frontend/src/lib/components/scenarios/`); what it shows, control by
control, is in [ui.md § Scenarios](./ui.md#scenarios-tabscenarios).

- **The editor records ops, never a model document.** "Add a change" is one
  form over the whole `ScenarioOp` union: it builds the op (`ops.ts`
  `buildOp`), checks it with the engine's `validateScenarioOps` (so the form
  refuses exactly what the backend would), and `PATCH`es the whole list; the
  answer's check (`applied`, `problems`, `classified`) drives the list. Undo
  re-sends the list as it was before the last edit.
- **What the editor computes itself**, from the base run's model and settings
  snapshot (`GET …/runs/:runId`) with no series: the input each op meets
  (`stepInputs`, the engine's `scenarioSteps`), for the targets the form
  offers and the value each op replaces in its description. Adding a
  change builds on the list as it stands, a last group included while it
  is still incomplete: after "Supply rule → run of river" on a `trigger`
  farm the list shows that op's problem (run of river has no dam) and the
  form offers the farm as run of river, so "Dam capacity → 0" next
  completes the group and both ops apply. A node or crop
  the base doesn't have is named from the scenario's `opNames` (kept by the
  server), so a change on a node a rebase dropped still reads by name after
  a reload. It never decides
  whether an op applies or how it is classed: those are the server's check,
  on the run's stored series (a `series.scale` can only be checked there).
- **Compound settings.** `settings.set pe` (GR4J's PE input) is edited as a
  whole: the kind, and for `monthly` the 12 values and the required source.
  The form reuses the Settings tab's PE helpers (`settings/peInput.ts`:
  `peFormError`, `withPeKind`, `peText`), so its rules and wording match, and
  describes the op as "GR4J potential evaporation: pan coefficient × A-pan →
  monthly, entered directly: 1,200 mm a year (source)". Like every
  `settings.set`, it is a baseline assumption.
- **Scale demand** (`demand.scale`): whose demand (farms' irrigation or
  other water users'), the new demand as a % of what they'd take (0–200 %),
  a checkbox per node of that category and per month, Oct first (none ticked
  is all of them, and the op then leaves `nodeIds` / `months` out; every
  month ticked is the same as none). It reads "Irrigation demand of Upper
  farm: 85 % of what they'd take (× 0.85), in Jan, Feb, Dec".
- **Set an EWR site's rule table** (`ewrRule.set`, engine ≥ 1.6.0): pick
  the site (the outlet, or a gauge still marked as an EWR site), with
  "Now: …" naming the table it has (source, confidence line, what it covers,
  % points) or "no rule table"; the form then shows the Settings tab's own
  table editor (`settings/EwrRuleTablesEditor.svelte`, lazy-loaded, limited
  to that site), starting from a copy of the site's table or a blank one, so
  source, kind of source, grids, paste, low and high flows work as there,
  and a table Settings wouldn't save is refused in the same words. A note
  says it is always a baseline assumption. The list reads it as "Reserve rule
  table at the outlet (…): “old” (Desktop estimate, low confidence) → “new”
  (Gazetted Reserve), total flow, 10 % points", so the compare page's
  Scenario overrides show the changed table, in red, with both confidence
  lines.
- **Classification in the UI**: each op shows **Proposal** or **Baseline
  assumption**; any baseline op shows the red **Baseline assumptions
  changed** callout, in the tab and on the compare page. On a team scenario
  the proposer's nodes (`ownedNodeIds`) are a checkbox list in the tab; on an
  application they are its owner's farm links, set by the server.
- **Comparison**: the tab compares the latest scenario run with the base run
  that run recorded (`inputs.scenario.baseRunId`), reusing the compare page's
  headline, farm, assurance-of-supply (issue #70) and daily-overlay
  components (issue #8), where a feature
  only one side has (a river pump, boreholes, a release rule, land cover)
  reads as 0 on the other ([run-comparison.md § Series and metrics only one run has](./run-comparison.md#series-and-metrics-only-one-run-has)); the compare page
  lists each scenario side's recorded ops in its Scenario overrides section.
  Its head links to the run's **Evidence report** (issue #71,
  [ui.md § Evidence report](./ui.md#evidence-report)) beside **Open the full
  comparison**.
- **Override mode** (`OverrideEditor.svelte`, `overrideDiff.ts`, its own
  chunk): the workspace's Network, Crops and Transfers tabs, unchanged, on
  their own `ModelEditor` loaded with the scenario's model (the base run's
  snapshot with the listed ops applied, `stepInputs(...).after`). The live
  model is never loaded or saved there. The Network shows its node table
  inline (`only="table"`), not the map: the map's Tables menu and a farm
  card's planted-areas link open the page's grid modal and farm drawer,
  which edit and save the catchment's own model (issue #17), so override
  mode must never offer them. The workspace page doesn't open those
  overlays over the Scenarios tab at all, even when the URL names one
  (`grid=`, `farm=`). **Record** diffs the edited model
  against the one it was loaded with (`diffModel`) into ops, in an order
  that applies: `crop.add`, `node.remove` (re-linking as the editor does),
  `node.set` per changed field the engine lets a scenario set (one node's
  fields next to each other, in the node's own key order: they are one
  edit group, so a `trigger` farm moved straight to run of river with its
  dam emptied records as it is; a node's edit that still breaks a save rule,
  such as `trigger` with the dam emptied, is reported), `node.add`
  (each after the node it drains into), `cropArea.set` with the farm's new
  total of a crop, `transfer.remove` / `.add` / `.set` per field,
  `landCover.remove` / `.add` and `borehole.remove` / `.add` (a patch or
  borehole edited in place is removed and added again). Each op goes
  through the form's own check (`ops.ts` `checkOp`, which `buildOp` also
  ends with: the engine's `validateScenarioOps`, worded in the form's
  units), and the whole list is applied to the loaded model
  (`applyScenario`): it must apply cleanly and give back the edited model
  (ignoring display order), or nothing is recorded. The ops are appended
  with one `PATCH`, so one **Undo** takes them all back.
- **What override mode can't record**, named in its record panel and
  holding the rest back until undone (the engine has no op for them yet;
  [§ Not yet supported](#not-yet-supported)): editing or removing an
  existing crop, changing a node's kind, moving a node (what it drains
  into), a new node that drains nowhere, the capacity of a dam with a
  survey curve when the curve is left as it was (the op would resize the
  curve, which the table can't show; paste the enlarged dam's survey with
  it, or add it as a change instead, engine ≥ 1.10.0), and a field the
  engine doesn't let a scenario set on that kind of node (a gauge's area).
  Row order is display only and isn't recorded.
- **A dam's survey curve in the table** (engine ≥ 1.20.0) is a `damCurve`
  op; with a capacity edit on the same dam it comes after the capacity op
  (and its `damAreaFullM2`), so the curve lands as entered.
- **A dam's capacity in the table** records the area the table shows: the
  capacity op (which resizes the area along the dam's own relation, § Dam
  capacity) is followed by a `damAreaFullM2` op with the table's value
  (blank = estimated). To enlarge a dam along its own relation, add the
  capacity as a change instead.

Tests: `scenarios/fields.test.ts` (every node field, transfer field and
settings path the engine allows has a spec; values round-trip through the
form's text and still pass the engine's checks), `scenarios/ops.test.ts`
(`stepInputs`, `describeOp`, problems lined up with their ops, an edit
group's problem on each of its ops, an incomplete group's status and the
same ops OK once the last op completes it, `buildOp` for
every op kind, each built op applying to a base), `scenarios/overrideDiff.test.ts`
(edits made with the model editor's own methods come back as ops that
apply and give back the edited model, per table; a node's supply edit
recorded as one edit group whatever the save rules tie together; every edit
no op can express is named; the engine's refusals in the form's words; a
fuzz over the engine's own random ops, `randomOps`, round-trips, and one
over any valid supply rule, pump, levels and dam from any valid start), and
`scenarios/summary.test.ts` (the header's counts), `e2e/tests/scenarios-page.spec.ts`
(the layout, issue #17: the header's counts and + New scenario, the create
dialog at `new=1` closed by Back and Esc, creating picking the new one, the
newest opened in place; thirty scenarios at 1440 × 960 and 1280 × 800 with
the rail reaching the window's bottom, scrolling inside and staying in view
as the scenario scrolls, Run in the head row; a phone; override mode's
banner clear of the record bar; a viewer; an applicant with thirty
applications; axe), `e2e/tests/scenarios.spec.ts` (the golden path: a 20 % dam raise created,
classed, undone, run and compared, with the compare page's overrides; a
rebase reporting a change that no longer applies and the `422`; a viewer
read only; a `trigger` farm taken to run of river one change at a time
through the form, both ops of the half-made edit saying why until the dam
change completes it; override mode recording one edit in each table as changes
(the node table inline, showing the scenario's model with the raise applied,
no Tables menu; a stray `grid=` / `farm=` on the tab opening nothing),
refusing a kind change, the catchment's model read back through the API
unchanged before and after recording, undone as one edit, with axe; submit,
withdraw, delete releasing the base; axe in light,
dark and on a phone) and `e2e/tests/scenario-demand-scale.spec.ts` (Scale
demand through the form: one farm at 50 % in December and January, the
200 % limit refused, classed baseline then proposal once the farm is the
proposer's, kept over a reload, run; the scenario run's daily demand is the
base's × 0.5 on exactly those days and the base's on the rest, and the
compare section's farm table shows that farm's demand down to the run's mean
and the other farm's unchanged) and `e2e/tests/scenario-ewr-rule.spec.ts`
(Set an EWR site's rule table through the form: the outlet, a table with
no source refused in the Settings form's words, a desktop estimate added,
described with its confidence line and a baseline assumption even with every
node the proposer's, run, and the compare page's overrides and What changed
showing it; the catchment's settings untouched; axe).

## Applications (WP-3.3)

An **application** is a scenario a **contributor** makes: a licence applicant
or their consultant, the project role ranked between `farmer` and `viewer`
(migrations `044_contributor_role.sql`, `045_contributor_scope.sql`,
`046_contributor_runs.sql`;
[data-model.md § Applicants](./data-model.md#applicants-044045),
[security.md § Applicants](./security.md#applicants-the-contributor-role)).
It is the same table, ops, check and run as any scenario, with
`scenario.origin = 'applicant'` (stamped from the creator's role; an editor's
scenario is `'team'`, and behaves exactly as above).

- **The base is the published baseline.** A contributor can't read a run's
  row, so the server rebuilds the published run's input past RLS
  (`loadPublishedRunInput`, through the `SECURITY DEFINER`
  `app_published_run_input` / `app_published_run_series`) and never returns
  it. An unpublished run answers `404`, as if it didn't exist.
- **What the applicant sees of it** (`GET …/scenarios/:sid/base`,
  `backend/src/scenarios/applicant.ts`): the settings, their own farms (their
  farm links) and every gauge in full; every other node by its kind and
  place in the network under an anonymous name ("Farm 3", "Water user 1"),
  its values blanked; crops, crop areas, transfers, land cover and
  boreholes on their own farms only. This is D2's recommended default
  ([step-3 § 11](./roadmap/step-3-licensing.md#11-open-decisions)),
  **pending the client**.
- **The applicant's namespace** (049, `applicationMask` in `applicant.ts`,
  the engine's `applyScenario(…, { mask })`). An application's ops meet
  every node the projection anonymises under its anonymous name, and every
  crop, transfer, land-cover patch and borehole it leaves out under an
  opaque id (and, for a crop or borehole, name) that none of the ops holds,
  whoever checks or runs it. So:
  - the engine's notes and problems quote only names and ids the applicant
    sees (no text redaction);
  - a rename of their own farm to a hidden neighbour's name (or a new crop
    named like a hidden one) applies exactly as a free name does; a name
    they can see ("Farm 1", the gauge, their own crops) still collides;
  - an op that targets a hidden item's id answers `… not found`, and one
    that gives a new item a hidden item's id applies, exactly as for a free
    id; an id they can see (a node's, their own items') still collides;
  - `node.remove` counts only what the applicant sees of what it drops
    (removing a hidden farm reports no crop areas, transfers, patches or
    boreholes; the EWR tables sited there are settings, which they see);
  - a rule the op breaks because of hidden data (a rule about a hidden
    item, a hidden farm's drought borehole rule or supply rule (both read
    its hidden dam or levels), and, while any farm is
    hidden, flow shares over 100 % or no catchment area left, which an op's
    own range-checked value can't break alone) reads only `op N (…):
    doesn't apply to the catchment as modelled` (`MASKED_RULE`). The
    wording is the recommended default, **pending the client**
    ([issue #90](https://github.com/Absence0760/project-water-management/issues/90));
    rules about the network's shape and names keep their words.

  Afterwards each hidden node and crop gets its real name back, suffixed
  where an op took it (`Kalkoenkrans` → `Kalkoenkrans (2)` in that application's
  runs), and each hidden item its real id; a new item an op gave a hidden
  item's id moves to a fresh one (`<id>-2`), so the hidden item keeps the id
  it lines up with the base by (run comparison matches by id). The check's
  `renamed` and `reIds` list those for the assessors; a contributor never
  receives either.
- **Own nodes** are the owner's farm links (`app_farm_nodes`), set at create
  and each time the ops change while a draft. A contributor can't claim
  others' (`403`; the `scenario_owned_nodes` trigger refuses it in the table
  too, 071), so a dam raise on their own farm is a proposal and the same
  raise on a neighbour's is a baseline assumption. To a contributor the own
  nodes are the stored ones still linked to the owner
  (`app_application_own_nodes`): a farm the owner unlinks is anonymised in
  the base and its series hidden, even in an application made before; the
  assessors keep the stored list.
- **Workflow.** The owner submits (`POST …/submit`: only when every op
  applies; the ops, their hash, the base and the own nodes freeze), may
  withdraw a submitted one (`…/withdraw`) and reopen a withdrawn one as a
  draft (`…/reopen`). An **assessor**, an editor who isn't the owner, decides
  a submitted one (`…/decide { outcome, note }`, outcome `approved`,
  `approved_with_conditions` or `refused`, the words pending the licensing
  authority); a decision is final. `submitted_at`, `decided_at` and
  `decided_by` are stamped by the trigger. The roadmap's "under review" is
  not a status of its own: a submitted application is the assessors' queue.
- **Who reads it.** Its owner and whoever they share it with
  (`POST|DELETE …/members`, `scenario_member`); the editors once it is submitted (drafts
  stay the applicant's alone, from the assessors too); viewers once it is
  decided. Its runs follow: an application's draft runs are hidden from the
  editors' run lists and series as well (`model_run_select`, and
  `run_series_select` excluding `app_hidden_scenario_runs()`).
- **Sharing** (049). The project owner puts each applicant and their
  consultant or client in an **applying party** (`project_member.party`,
  set in the Members panel, `PATCH /projects/:id/members/:userId { party }`).
  An applicant shares only with the other contributor-or-above members of
  their own party, picked from `GET …/share-candidates` (names only) and
  sent by id; every other id, and every address, gets one refusal, so no
  answer says who else is a member. A member without a party shares with no
  one. An owner who has since become a viewer or above (who reads the member
  list anyway) shares with any contributor-or-above member, by id or email.
  Moving someone out of a party (or changing a role) ends the shares the
  rule no longer allows (`project_member_prune_shares`); the rule lives in
  `app_share_allowed`, which the insert trigger checks too.
- **Runs.** The owner and the people it is shared with run it, and so may an
  assessor. A contributor's run answers with the run's metadata only (its
  summary names every farm); each application keeps its newest 5 runs
  (`APPLICATION_RUNS_KEPT`, trimmed as its owner: the project's 20-run cap
  counts only the runs the editor trimming can see). Deleting a draft or
  withdrawn application deletes its runs that nothing keeps. A contributor
  can't read any run row, their own application's included (its `inputs`
  are the whole base): its metadata, the run count and the cap go through
  `app_scenario_run_meta` and `app_trim_application_runs`, and of its series
  they read the application's own nodes and the catchment allowlist only
  (046, [data-model.md § Applicants](./data-model.md#applicants-044045)).
  RLS still lets an applicant insert their own application's run rows
  (045), so the backend stamps every run it stores (077,
  [security.md § Run stamps](./security.md#run-stamps)): an application
  isn't decided (`409 run_unverified`), nor its run signed off, while any
  of its runs lacks a matching stamp; the assessors get the ids
  (`unverifiedRunIds`) and a warning in the application panel, and delete
  those runs from the Runs tab.
- **Names kept with the ops** (`op_names`, above) are captured from the full
  published base, server-side, and a contributor is only ever shown those of
  the scenario's own nodes (`names.ts` `applicantOpNames`): a neighbour's
  real name, anonymised in the projection, never reaches them this way.
- **Override mode** (§ UI) is offered only to whoever may change the
  scenario (`canChange`: its owner on an application, an editor on a team
  scenario), and for an applicant it edits the applicant projection: the
  anonymised nodes' blanked values are what they see, and an edit to one is
  recorded like any `node.set` on it (a baseline assumption).
- **Results for the applicant** are not built: the assessors compare a run
  with its base (`/compare/runs` refuses a contributor, since it returns
  `inputs`); the applicant projection of results (catchment series, their own
  farm, anonymised downstream deltas) is a follow-up
  ([followups.md § Applicants](./followups.md#applicants-wp-33)).
- **The log.** `scenario.created / changed / submitted / withdrawn /
  reopened / decided / shared / unshared / deleted` and `run.created` carry
  `application: true` and no name until the application is decided (every
  viewer reads the project's history).

### Sharing and comments (WP-3.15)

`113_scenario_share_notes.sql`; [api.md § Share](./api.md#share),
[§ Notes](./api.md#notes); [security.md § Share
links](./security.md#share-links).

- **A read-only link to one application.** Once it is submitted or decided,
  an assessor (an editor who reads it) or its applicant makes a share link
  to it (`POST …/share-links` with `targetKind: 'scenario'`), from the
  Application panel's Share dialog. Whoever holds the link reads, signed
  out, a redacted projection (`app_share_scenario`): its name, description,
  status and decision, its changes with the applicant's own units named and
  every other anonymous, each change's class (only an application: a team
  scenario's ops name every farm, so it is refused), the EWR at each site on the
  baseline beside the application, and the catchment's totals only at five
  or more farm holders. Results show only when both runs' stamps verify.
  The link is dead while the application is withdrawn or back to draft.
- **Comments.** A scenario's notes have three audiences beside `team`:
  `assessors`, `parties` (the assessors and the applicant's party) and
  `public_participation`, which any member contributor or above (an NGO
  joins as a viewer) may post while the application is **open for
  comment**: a live link, or decided after it was ever shared. Public comments show on
  the link with their authors' names; editors moderate by soft delete. Every
  edit of a scenario note keeps the text it replaced (`note_revision`,
  `GET …/notes/:noteId/revisions`): a participation record must be complete,
  and an application that drew public comments can't be deleted (`409`).
  The full read/write matrix is in [data-model.md § Notes](./data-model.md#notes-037_notessql).
- **Not yet:** evidence packs as a second target (`target_kind 'pack'`, a
  `note.pack_id`) wait for `evidence_pack` (WP-3.14;
  [followups.md § Applicants](./followups.md#applicants-wp-33)).

Tests: `backend/src/scenarios/applications.db.test.ts` (RLS with positive
controls: drafts hidden from the other applicant, the editors and viewers;
the published run's row unreadable, its catchment series readable; submit,
freeze, decide; sharing; the per-application run cap; the contributor's
routes are `projects/role-ladder.db.test.ts`), `oracles.db.test.ts` (049: identical answers for member and
non-member ids and addresses, hidden and free farm, crop and application
names, hidden and free item ids, a hidden farm's removal counting nothing,
each with its positive control; the party prune), `applicant.test.ts`
(the projection and the mask), the engine's `overrides.test.ts` ("mask:
names" and "mask: ids, counts and value rules"),
`history/write-routes.db.test.ts` (each new route records its event),
`share/scenario-share.db.test.ts` (WP-3.15: scenario links, their RLS and
redaction, the note matrix and revisions), e2e
`e2e/tests/scenario-share.spec.ts` (an NGO opens a link, signs in and
comments; the assessor sees it; axe),
the applicant's `ewrRule.set` in `applications.db.test.ts` (accepted,
applied, classed baseline beside their own farm's proposal), e2e
`e2e/tests/applications.spec.ts` (the applicant's flow, the assessor's
decision, the owner's party and the applicant's share picker, axe in both
themes).
