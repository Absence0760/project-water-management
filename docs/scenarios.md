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
overrides section; § UI below). Several scenarios assessed together
(cumulative impact, WP-3.11) are § Cumulative impact.

## Engine: `applyScenario`

```ts
applyScenario(base: ModelInput, ops: ScenarioOp[], options?: { mask?: ScenarioMask }):
  { input: ModelInput; applied: AppliedOp[]; problems: string[]; renamed: MaskedRename[]; reIds: MaskedReId[] }
```

`mask` (the hidden nodes, id → the anonymous name the ops meet them by, and
the ids of the hidden crops, transfers, land-cover patches, boreholes and,
from engine 1.35.0, registered volumes, and from engine 1.45.0 demand
objects) is
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
  Likewise (engine ≥ 1.45.0) consecutive `demandObject.set` ops on the same
  demand object: a monthly object becomes one sized per unit with `sizing`,
  `count` and `litresPerUnitDay` together, in any order, and one piped out
  with `destination` → `external` and `returnPct` → 0.
  Any other op, or a `node.set` on another node, ends the group (so two
  groups on one node with an op between them are checked apart). A group
  that still breaks a rule is skipped **whole**, so a scenario never keeps
  half an edit, and reported once, naming its ops and the node (or demand
  object) as it stood before them: `ops 3–5 (node.set, "Upper farm"): …` (a group of one reads
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
  a next op would meet (a last `node.set` or `demandObject.set` group that
  still breaks a rule included, so a form adding one op at a time builds on it);
  `classifyScenario` classifies each op against the same inputs.

### Op catalogue

Every op targets by id; `ScenarioOp` is a closed union discriminated by `op`.

| Op | Fields | What it does |
| --- | --- | --- |
| `node.set` | `nodeId, field, value` | Sets one whitelisted field (below). Typed per field. |
| `node.add` | `node` | Adds a **leaf** node that drains into an existing node (never a new outflow). Fields it leaves out take the engine's defaults (`upgradeLegacyModel`: no boreholes, senior user, dam area estimated, dam-first supply with no river pump). It may carry a supply rule and river pump (`supplyRule`, `pumpCapacityM3Day`, `supplyTriggerPct`, `supplyStopPct`, engine ≥ 0.42.0, [model.md §2.7e](./model.md)), checked like the rest; `node.set` changes them on an existing farm. It may also carry the GN 538 property area and Table 2 rate (`gaPropertyAreaHa`, `gaRateM3HaYear`, engine ≥ 1.12.0, [model.md §2.7d](./model.md)), context for its groundwater; there is no `node.set` for them. |
| `node.remove` | `nodeId` | Removes a node. Nodes that drained into it now drain into its downstream node, so the network stays one tree. Drops its crop areas, transfers from or to it, its land-cover patches and any EWR rule table sited at it. Its registered volumes stay (the run lists them as on no unit) and the op's notes say how many, counting only those the caller sees (engine ≥ 1.35.0). The outflow node can't be removed. |
| `node.move` | `nodeId, downstreamNodeId` | Makes a node drain into another (engine ≥ 1.35.0). What drains into it moves with it. The outflow node can't be moved, and a node can't drain into itself; a move that makes a loop (the new downstream node drains into this one), or makes a river off-take's destination drain into its source, is refused by the model rules, so the network stays one tree with one outlet. § Moving and inserting nodes. |
| `node.insert` | `node, upstreamNodeIds` | A new node placed on a reach (engine ≥ 1.35.0): `node` as `node.add` takes it, and each node in `upstreamNodeIds`, which must drain into `node.downstreamNodeId` now, drains into the new node instead. So an on-channel dam or a weir goes in between existing nodes without moving anything else. § Moving and inserting nodes. |
| `cropArea.set` | `nodeId, cropId, areaM2, irrigationSystemId?` | Sets a farm's area of one crop (m²); `0` removes the row. Replaces duplicate rows with one. `irrigationSystemId` (engine ≥ 1.72.0) puts the crop on that system on this unit (`null`: the crop's default); absent keeps the planting's own. A proposal on the applicant's own unit, such as converting to drip. |
| `crop.add` | `crop` | Adds a crop definition (12 crop factors, and optionally its default `irrigationSystemId`, engine ≥ 1.72.0). |
| `crop.set` | `cropId, field, value` | Changes one field of a crop definition (engine ≥ 1.35.0): `name` (1–100 characters on one line, unique ignoring case), `cropFactor` (12 values ≥ 0, Oct–Sep) or `irrigationSystemId` (a row of the model's table, or null for none; engine ≥ 1.72.0). It changes the crop on every farm that grows it, except where a unit has put it on a system of its own. A stored op from engine 0.43.0–1.71.0 setting `irrigationEfficiency` still applies: the crop takes the table's row with that efficiency (a row "Scenario, NN %" is added when there is none) and every unit's own choice for it is dropped, which is what that op meant. The systems' table itself is the project's, not a scenario's (the override editor says so). |
| `crop.remove` | `cropId` | Removes a crop and every farm's area of it (engine ≥ 1.35.0); the note counts the areas dropped. To stop growing it on one farm, `cropArea.set` it to 0 instead. |
| `transfer.add` | `transfer` | Adds a transfer rule. Months are stored as a sorted set. |
| `transfer.set` | `transferId, field, value` | `fromNodeId`, `toNodeId`, `months`, `maxRateM3s`, `dailyCapM3`, `minStoragePct`, `enabled`, `priority`, `monthlyRateM3s` (engine ≥ 1.14.0: twelve m³/s rates, Oct–Sep, or null; setting it also sets `months` and `maxRateM3s` to match, and a `months` or `maxRateM3s` edit on a rule with monthly rates is skipped, since the save rules refuse the disagreement, [model.md §2.6](./model.md)), and a river off-take's `source`, `handsOffM3Day`, `handsOffEwr`, `lossPct`, `sizing`, `topUpDam` (engine ≥ 1.14.0, [model.md §2.6a](./model.md); an edit that makes an off-take's destination drain into its source is skipped with that rule as its problem), `lossReturnPct` (0–1) and `lossReturnNodeId` (a node id, or null for the source; engine ≥ 1.42.0: canal seepage back to the river, an edit to a unit that isn't the source or a farm below it on the river is skipped with that rule as its problem; in an application the unit must be the applicant's own, as the ends must). `node.remove` of a unit an off-take's seepage rejoins below leaves that off-take returning none (share 0, the source), with a note. `transfer.add` takes the same fields, each optional. |
| `transfer.remove` | `transferId` | Removes a transfer rule. |
| `landCover.add` | `patch` | Adds a land-cover patch on a farm (WP-1.35). |
| `landCover.remove` | `patchId` | Removes a patch, e.g. clearing invasive aliens. |
| `landCover.set` | `patchId, field, value` | Changes one field of a patch in place (engine ≥ 1.35.0): `coverClass`, `areaKm2` (≥ 0), `densityPct` (0–1) or `factors` (`{ mar, lowFlow }`, each 0–1, or null for the class's). Not `nodeId`: a patch on another farm is `landCover.remove` and `landCover.add`. "Clear half the wattle" is `densityPct` → half. |
| `borehole.add` | `borehole` | Adds an individual borehole on a farm or other user (WP-3.9), e.g. an applicant's new borehole with its tested yield and annual volume. Its fields are checked as `PUT /model` checks a borehole's: the name 1–200 characters on one line. |
| `borehole.remove` | `boreholeId` | Removes a borehole. `node.remove` drops the node's boreholes too. |
| `demandObject.add` | `demandObject` | Adds a demand object on a unit (engine ≥ 1.45.0, [model.md §2.7f](./model.md)): a town, households, livestock or water piped out, supplied from the unit's own dam, river pump and boreholes with its crops. Every field as the model document has it (`schedule` and `note` may be left out: none, empty); only a farm node (a unit) takes one. The save rules apply as the op is applied: a monthly object needs 12 values, a per-unit one a count and litres, nothing returns from one piped out, and each schedule window must be one the run can read. |
| `demandObject.set` | `demandObjectId, field, value` | Changes one field of a demand object in place (engine ≥ 1.45.0): `name` (1–200 characters), `category`, `sizing`, `monthlyM3Day` (12 values ≥ 0 or null), `count`, `litresPerUnitDay` (≥ 0 or null), `lossPct` (0 to below 1), `monthlyFactor` (12 values ≥ 0 or null), `returnPct` (0–1), `priority`, `rank` (its place within `first` or `last`, engine ≥ 1.64.0: a whole number 1–99, or null = 1), `destination`, `enabled`, `schedule` (up to 24 windows, each with all eight fields, or null), `population` (the people it serves for the basic-needs floor, engine ≥ 1.44.0; ≥ 0, or null for a per-person object's count), `source` (where its number comes from, engine ≥ 1.56.0: `meter`, `aadd`, `perCapita`, `other`, or null = not recorded; its sizing must fit, so switch both in one edit group), `waterSource` (engine ≥ 1.65.0, [model.md §2.7j](./model.md): `dam`, `river`, or null = the dam), `riverPumpM3Day` (≥ 0, or null = no limit), `riverPoolM3` (≥ 0, or null = none) or `note` (at most 1000 characters). A name, a note and a window's label are trimmed as a save trims them. Not `nodeId`: an object on another unit is `demandObject.remove` and `demandObject.add`. Consecutive ones on one object are one edit group (§ Edit groups above). Clearing a schedule an object hasn't got, or a population, source or rank it hasn't got, changes nothing. |
| `demandObject.remove` | `demandObjectId` | Removes a demand object (engine ≥ 1.45.0). `node.remove` drops the node's objects too. |
| `settings.set` | `path, value` | Sets one whitelisted setting (below). Nested paths write over what is there. |
| `series.scale` | `kind, factor, from?, to?` | Multiplies a rain series or the daily A-pan series by `factor` (0–10) on the days `from`–`to` (ISO dates, inclusive; each end open when absent). Missing days stay missing. |
| `ewrRule.set` | `table` | Sets or replaces the Reserve rule table of one EWR site (engine ≥ 1.6.0, WP-3.7): `table.siteNodeId` is the site. Always a baseline assumption. § Reserve rule tables. |
| `ewrRule.remove` | `siteNodeId` | Removes the Reserve rule table of one EWR site (engine ≥ 1.35.0): null (or the outlet node's id) is the outlet. Always a baseline assumption. § Reserve rule tables. |
| `allocation.set` | `allocation` | Sets or replaces one registered volume by id (engine ≥ 1.35.0, [allocations.md](./allocations.md)): a new id adds one. § Registered volumes. |
| `allocation.remove` | `allocationId` | Removes one registered volume (engine ≥ 1.35.0). |
| `demand.scale` | `factor, nodeIds?, months?, category?, part?` | Multiplies demand by `factor` (0–2): the farms' irrigation demand (`category: 'farm'`, the default) or the other water users' (`'user'`). `nodeIds` limits it to those nodes (default: every node of the category), `months` to those calendar months (default: every month). It multiplies each target's `demandFactor`, so ops stack (0.9 twice is 0.81). `part` (engine ≥ 1.45.0, farms only) scales one part of a unit's demand: `crops` or the demand objects of one category, on top of the whole. Engine ≥ 0.41.0, issue #53 R1; § Demand scaling. |

**`node.set` fields, per node kind.** Never `id`, `kind`,
`downstreamNodeId` (the network's shape: use `node.add`, `node.insert`,
`node.move` or `node.remove`) or `sortOrder` (display only).

- farm: `name`; land `areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`;
  dam and irrigation `pctUpstreamToDam`, `pctRunoffToDam`, `damCapacityM3`,
  `damInitialPct`, `damMinPct`, `damAreaFullM2`, `damAreaExponent` (0 < b ≤ 1
  from engine 1.63.0),
  `damSeepagePerDay`, `divertCapacityM3Day`, `irrigationEfficiency` (the unit's own, the fallback for a planting with no system, engine ≥ 1.72.0; so that a stored op from engine ≤ 1.71.0 still means what it did, setting it also puts every planting on the unit onto the table's row with that efficiency, adding one when none matches, with a note; the override editor records a unit's efficiency typed in its form as this op, with that meaning, and a planting's own system edited beside it is its `cropArea.set`, after the node's ops, so it stays),
  `returnFlowFraction` (engine ≥ 1.71.0; a stored op setting 0.16.0–1.70.0's
  `lossReturnFraction` β still applies, as r = β(1 − e) of the node it meets);
  dam storage (WP-3.5) `damReleaseRule`,
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
  `riverFirst` and `pumpCapacityM3Day` → 1200. The farm's other operating
  rules (engine ≥ 1.32.0, [model.md §2.7h](./model.md)): `handsOffM3Day`
  (12 values ≥ 0 m³/day, Oct–Sep, or null = none), `handsOffEwr` (true /
  false) and `divertMonthlyM3Day` (River to dam by month, 12 values ≥ 0 or
  null = the one `divertCapacityM3Day`); farms only (a save rule), each the
  applicant's proposal on their own farm. "Pump only above 300 m³/day" is
  `handsOffM3Day` → twelve 300s.
  Where the farm's crops take their water (engine ≥ 1.65.0, [model.md
  §2.7j](./model.md)): `cropWaterSource` (`dam` | `river`),
  `cropRiverPumpM3Day` (≥ 0, null = no limit) and `cropRiverPoolM3` (≥ 0,
  null = none); farms only (a save rule). "What if the crops pumped from the
  river beside the dam at 1,500 m³/day" is two ops: `cropWaterSource` →
  `river` and `cropRiverPumpM3Day` → 1500.
  The crop supply table (engine ≥ 1.73.0, [model.md §2.7k](./model.md)):
  `cropShareDam`, `cropShareRiver`, `cropShareRemote` (0–1, null = no
  table) and `cropRemoteCapM3Day` (≥ 0, null = no limit); farms only, and
  the shares add up to 100 % (save rules, checked once after a run of
  `node.set` ops on the farm, so set the shares next to each other). Which
  unit's dam gives the remote share, `cropRemoteNodeId`, is the model's and
  can't be set by a scenario (it names another node, which an applicant's
  view may hide; a `node.add` carries none). "What if a fifth of the crops
  came from the river" is two ops: `cropShareDam` → 0.8 and `cropShareRiver`
  → 0.2 (with `cropShareRemote` → 0 when the farm had no table).
  Bed losses in the reach below (engine ≥ 1.75.0, [model.md
  §2.6b](./model.md)): `reachLossFrac` (0–1) and `reachLossMaxM3Day` (≥ 0,
  null = no cap), on any kind of node, never the outlet (a save rule); always
  a baseline assumption, since the river's losses are no party's proposal.

  **Dam capacity** (engine ≥ 1.10.0, [model.md §2.13](./model.md);
  provisional decision 2026-10-01, to be confirmed by the client's
  hydrologist, issue #90). A `damCapacityM3` op that resizes an existing dam (from
  and to a capacity above 0) resizes its geometry along the dam's own
  area–volume relation, as the storage–yield curve does: a power-law dam's
  `damAreaFullM2` (as entered, or the 7.2 × capacity^0.77 estimate, engine
  ≥ 1.63.0; capacity ÷ 3 m before) becomes
  A_full × (new ÷ old)^b with its own `damAreaExponent`; a survey curve is
  cut at its top × the ratio, or extrapolated beyond the survey to it
  (a power law through its top two rows). The op's note says what changed
  (`dam area when full 50972 → 82804 m² …` for an unknown-area
  100 000 m³ dam doubled, or that the curve was
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
  `userPriority`, `pumpCapacityM3Day` (engine ≥ 1.58.0: its river pump, `null`
  = no limit, [model.md §2.7c](./model.md); the supply rule and trigger levels
  stay a farm's), `abstractionFrom` (engine ≥ 1.30.0), and the borehole fields.
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
`fullAllocation`: a full-allocation scenario on a base run is the "if every
registered or licensed volume were taken in full" background (a registration
is not an entitlement), [model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)),
and from engine 1.54.0 (WP-3.8) `droughtRestriction`: the drought
restriction rule, whole (review and lift dates, levels with a threshold and
a % cut per part of demand), or `null` for off, checked by the engine's
`droughtRestrictionIssues` as a settings save is ([model.md §2.7i](./model.md));
a `null` over no rule changes nothing. So a WUA compares restriction
policies: the same base run with the rule off, with the outlook's triggers,
and with a harsher table.
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
  the return flow stay as they are: 85 % means "85 % of what they'd take".
  A unit's demand objects (engine ≥ 1.7.0, model.md §2.7f) scale with it,
  month by month. A cut (a factor below 1) never takes a domestic or
  municipal object with people below its basic-needs floor, MIN(people ×
  25 l a day, its demand) (engine ≥ 1.44.0, issue #123), also under a full
  allocation. One object is changed with `demandObject.set`.
- **Under a full allocation it scales the registered use** (engine ≥
  1.70.0, issue #90 Q29, [model.md §2.12a](./model.md)). The allocation's
  factor is fitted on the demand before the op, and the op then multiplies
  the scaled demand: "everyone takes 85 %" asks for 85 % of every registered
  volume, a months-only op takes those months' share of it down, and a cut
  keeps a floored object at MIN(floor, its registered use). Before 1.70.0
  the factor was refitted after the op and a uniform op changed nothing on a
  registered unit. Outside a full allocation nothing changed.
  For an other water user it multiplies the monthly demand (and so the
  senior requirement passed to the farms above it). Model.md §2.3 step 4a.
- **Months** are calendar month numbers 1–12 (Oct = 10), the convention of
  every month *list* in the engine (`transfer.months`); the 12-value *rows* (`demandFactor`,
  `userDemandM3Day`) run Oct–Sep. Left out, every month.
- **Categories:** `farm` (default) and `user`. One op scales one category;
  both is two ops. A gauge has no demand.
- **Parts** (engine ≥ 1.45.0, issue #123: DWS's % restrictions per
  category). With `part` a farm op scales one part of the unit's demand:
  `crops` (the crop water requirement F) or its demand objects of one
  category (`domestic`, `municipal`, `industrial`, `livestock`,
  `irrigation`, `external`, `other`). It sets the node's
  `partDemandFactor[part]` (12 multipliers, stacking like `demandFactor`),
  which multiplies the unit's own `demandFactor` for that part, so
  "domestic −10 %, irrigation −30 %" is two ops (`part: 'domestic'` × 0.9,
  `part: 'crops'` × 0.7), and a part's cut adds to a cut of the whole. An
  object's factor is the unit's × its category's, and it goes through the
  same basic-needs floor as the unit's own (`planObjects`, engine ≥ 1.44.0,
  [model.md §2.7f](./model.md)): a domestic or municipal cut never takes it
  below MIN(floor, its unrestricted demand). A part on an other water user
  (`category: 'user'`) is refused: its demand is scaled whole.
  Classified as any `demand.scale` (the author's own nodes, named). The
  input diff reports it (`domestic demand factor none → …`); the self-check
  replays F and each object's demand with it. The seasonal outlook refuses a
  base that carries one, as it does a `demandFactor`.
- **Problems** (the op is skipped): a factor outside 0–2; an empty or
  repeating `nodeIds` or `months` (leave the field out for all of them); a
  month outside 1–12; a category other than the two; a node id the input
  doesn't have (`node … not found`); a node of another kind (`"Town" is an
  other water user, not a farm`); no node of the category at all when
  `nodeIds` is left out (`the model has no other water user to scale`). The
  first four are the validator's too. Without `nodeIds` the note says how
  many nodes were scaled.
- `demandFactor` and `partDemandFactor` are set only by this op: the model editor, the model save and
  `node.set` don't carry them, and override mode keeps a scaled node's factor
  as it is. The input diff reports it (`demand factor none → 0.85, … (Oct–Sep)`).

**Reserve rule tables (`ewrRule.set`, engine ≥ 1.6.0, WP-3.7).** "What if
the Reserve at this site were the desktop estimate, not the gazetted table?"
The op carries a whole `EwrRuleTable` ([model.md §2.9c](./model.md)), its
`siteNodeId` the site.

- **Set or replace.** A site with a table has it replaced whole; one without
  gets it. The outlet is one site whether a table names it `null` (as
  Settings saves it) or by the outlet node's id (as the run also reads it),
  and a replaced table keeps the key its site had, so run comparison sees
  that site's table changed rather than one removed and one added.
  `ewrRule.remove` (engine ≥ 1.35.0) takes a site's table away, keyed the
  same way ("what if the site had no determination yet": its EWR then
  falls back to the pragmatic EWR where the charge follows the tables); a
  site with no table is a problem (`there is no EWR rule table at the
  outlet`, or `at node <id>`: named by id, as a site is always one every
  caller sees).
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
- **Always a baseline assumption**, whoever owns the site's gauge, and so
  is `ewrRule.remove`: the Reserve is the authority's, never part of a
  proposal. An application may
  make one (§ Applications): like every baseline op it is shown to the
  assessor in red, not refused.
- The input diff reports it per field (source, kind of source, EWR values
  per month …, `run-comparison.md`), and the editor describes it with its
  confidence line: "Reserve rule table at the outlet (Outflow gauge): “GN …”
  (Gazetted Reserve) → “…” (Desktop estimate, low confidence), total flow,
  10 % points".

**Moving and inserting nodes (`node.move`, `node.insert`, engine ≥
1.35.0).** "What if this farm drained into the dam below it" and "an
on-channel dam on the main stem above the weir".

- **One tree, one outlet.** The outflow node never moves and no op makes a
  second one. A move is refused when it would make a loop, which the model
  rules (`modelRuleIssues`) already refuse for a save; a river off-take
  whose destination would then drain into its source is refused too, as a
  save refuses it. An insert can't make a loop at all (every node it
  re-points drained into the new node's downstream node already), and its
  own checks refuse an `upstreamNodeIds` entry that doesn't drain there
  (`"Lower farm" doesn't drain into the node the new one drains into, so the
  new node can't sit between them`), an empty or repeating list, and
  whatever `node.add` refuses. Both are covered by the scenario fuzz below.
- **What moves.** `node.move` moves the node with everything upstream of it;
  its crop areas, transfers, land cover, boreholes and EWR table stay with
  it. `node.insert` re-points only the nodes it names: a sibling left out
  keeps draining where it did. A gauge with no land inserted mid-river
  changes no other node's water (an invariant test, below); only the reach
  shortfall diagnostic (workbook AB, measured against the elements directly
  upstream) moves with the shape.
- **Run comparison** lists a move as the node's "drains into" change, and
  an insert as the new node plus each re-pointed node's change.
- **In an application** a hidden node moves, and is named, like any node
  (by its anonymous name): the network's shape is the applicant's to see,
  so a loop through a hidden node keeps its words.

**Registered volumes (`allocation.set`, `allocation.remove`, engine ≥
1.35.0).** An allocation is a volume a year, per water source, held under an
authorisation for a farm or other water user ([allocations.md](./allocations.md));
a run's input carries them (no names) and `settings.allocationMode` decides
whether they only compare with the run's use, cap it, or scale it (a full
allocation). So a volume is a scenario input like a dam: "what if this
licence were for 200 000 m³ a year" under `cap`, or the applicant's
requested volume in a full-allocation background, is one op.

- **The op carries the whole entry** the engine reads: `id`, `nodeId` (a
  farm or other water user, never null: an unmatched volume compares with
  nothing), `waterSource` (`surface` | `groundwater`), `volumeM3PerYear`
  (0 to below 10¹² m³, the API's limit), and optionally `storageM3`,
  `validFrom` / `validTo` (ISO dates, from ≤ to), `months` (1–12, no
  repeats; stored as a sorted set), `maxRateM3s` (0 to below 10⁶) and
  `waterUse` (`'21a'`, the default, or `'21b'`: a dam's storage only,
  volume 0, never a take; engine ≥ 1.59.0, issue #72). The scenario form
  offers only takes to change; a storage-only row can be removed.
  Under `cap` (engine ≥ 1.37.0) the months of use and the maximum rate
  bind the scenario run as they bind a stored licence ([model.md
  §2.12a](./model.md)), so "what if this licence were winter-only" is one
  op too. Its `validFrom` / `validTo` bind as well: under `cap` a day on
  which none of the unit's licences of that source is in force isn't capped
  for it, and its use doesn't count against the year's volume (engine ≥
  1.70.0, #90 Q24), so a proposed licence that starts partway through the
  run leaves the days before it as the unit's modelled demand (the run
  warns, naming them); under a full allocation a water year with none in
  force keeps the modelled demand. A demand-sized off-take into a capped
  unit takes only the demand its cap still allows (§2.6a).
  Unknown keys are dropped, so a holder's name or a registration number never
  enters an op. An id the input has replaces that volume in place; a new id
  adds one.
- **Problems**: a node that doesn't exist, a gauge (`a registered volume is
  held for a farm or other water user; "Weir" is a gauge`), an entry the
  validator refuses, and for `allocation.remove` a volume that doesn't exist.
- **Run comparison** lists a volume added, removed or changed, and from
  engine 1.35.0 a change to its storage, months or maximum rate too
  ([run-comparison.md](./run-comparison.md)).
- The volumes aren't in the model editor's tables, so override mode never
  records one; the form's **Set a registered volume** does.

**Which series scale.** The rain drivers, `rain_catchment_mm`,
`rain_chirps_mm`, `rain_forecast_mm`, a rain-source period's
`rain_catchment_alt_mm` and the reanalysis `rain_reanalysis_mm` (engine ≥
1.69.0, [model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)), and the daily A-pan evaporation
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

`classifyOp(op, ownedNodeIds, input?, addedCropIds?)` returns `'proposal'` or `'baseline'`;
`classifyScenario(base, ops, ownedNodeIds)` classifies a whole list against
the input each op meets, counting nodes the scenario added or inserted as
owned and passing the crops it added. The UI's
red **Baseline assumptions changed** callout shows whenever any op is
`baseline`. The rules are conservative: what can't be placed is `baseline`.

| Op | Proposal when | Otherwise |
| --- | --- | --- |
| `settings.set`, `series.scale`, `ewrRule.set`, `ewrRule.remove` | never | baseline (settings, calibration, EWR and the Reserve's rule tables, flow-share method, climate) |
| `node.set` | the node is owned and the field is not land or flow share (`areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`), a gauge's `ewrSite`, a dam's `damSurveyDate` / `damSedimentPctPerYear` (engine ≥ 1.30.0), or the bed losses below it, `reachLossFrac` / `reachLossMaxM3Day` (engine ≥ 1.75.0, the river's own); so the own farm's supply rule and river pump, and a dam or an abstraction from a date, are the proposal (how the farm takes water is what a licence to abstract asks for, like a new pump) | baseline: other parties' nodes, the catchment's partition of runoff, where the EWR is assessed, a dam's survey and sediment (the dam as it is), and the river's bed losses |
| `node.add` | not a gauge, and no land or manual flow share of its own (a new dam, pump or user) | baseline: a gauge moves an EWR site; land or a manual flow share re-partitions the catchment |
| `node.remove` | owned, not a gauge, no land or manual flow share, and no EWR rule table sited at it (needs `input`) | baseline |
| `node.insert` | as `node.add`: not a gauge, and no land or manual flow share of its own; and not a senior other water user (the default priority) | baseline. A senior user inserted above other farms curtails them (they must pass its demand, [model.md §2.7c](./model.md)), and whether a new use ranks above existing lawful use is the authority's call, pending the hydrologist ([engine-audit.md](./engine-audit.md) L1), so it is a changed assumption, not the proposal. A new structure on the reach is the proposal (an on-channel dam is what a licence to build one asks for); the nodes it re-points keep their values and their order along the river, so their water reaching it is the proposal's effect, not a changed assumption |
| `node.move` | owned, no land or manual flow share, not a gauge or a senior other water user, no node drains into it, and no EWR table sited at it (needs `input`) | baseline: moving the applicant's own abstraction point (a pump or dam they added or own, a leaf) is where they propose to take water; moving anything else, or a node others drain into, redraws the river as modelled. A node the scenario added or inserted counts as owned |
| `cropArea.set`, `landCover.add` | on an owned node | baseline |
| `crop.add` | always | |
| `crop.set`, `crop.remove` | the crop is one the scenario itself added (`classifyScenario` passes them; `classifyOp`'s fourth argument) | baseline: a crop's factors and efficiency are agronomic data that apply on every farm growing it, farms the applicant may not see among them, so a change to one isn't theirs to propose (and classing by who grows it would tell an applicant whether a hidden farm does). Stopping a crop on their own farm is `cropArea.set` to 0, a proposal |
| `transfer.add` | both ends owned | baseline |
| `transfer.set`, `transfer.remove` | both ends owned, and a new end owned too (needs `input`) | baseline |
| `landCover.remove`, `landCover.set` | the patch is on an owned node (needs `input`) | baseline |
| `borehole.add` | on an owned node | baseline |
| `borehole.remove` | the borehole is on an owned node (needs `input`) | baseline |
| `demandObject.add` | on an owned node | baseline: an object is supplied from its unit's own dam, river pump and boreholes ([model.md §2.7f](./model.md)), so one on the applicant's unit is theirs to propose, like a borehole; one on another's unit changes the baseline. An object piped out of the catchment on their own unit is still the proposal: its effect downstream (less water, none returned) is the same kind as more crops there |
| `demandObject.set`, `demandObject.remove` | the object is on an owned node (needs `input`) | baseline |
| `allocation.set` | the volume is on an owned node and, when it replaces one, that one was on an owned node too (needs `input`) | baseline: the volume the applicant asks for on their own unit is the proposal, like their own dam; one on another's unit, or taking over another's volume, changes the baseline |
| `allocation.remove` | the volume was on an owned node (needs `input`) | baseline |
| `demand.scale` | `nodeIds` given, and every one owned | baseline: without `nodeIds` it scales every farm (or user) in the catchment, and a named node that isn't the author's is another party's |

## Validation: `validateScenarioOps`

`validateScenarioOps(raw: unknown) → { ops, errors }`, zod-free, so the
backend can call it or mirror it. It rebuilds each op from its known fields
only (unknown keys are dropped) and names every error by path
(`ops[3].value: must be at most 1`). At most 500 ops. The backend rejects the
body when `errors` is non-empty. Whether a target id exists depends on the
base run, so that is `applyScenario`'s job, not the validator's. Ids are any
non-empty string here; the backend tightens them to UUIDs (`backend/src/scenarios/schema.ts` `checkOps`).

Field names, settings paths and series kinds are untrusted text (a request
body, a stored scenario, the preview worker's message), so both the
validator and `applyScenario` first resolve them to the allowlist's own
name (`allowed()`), then look that name up in a `Map` of checks and write
through it, never through the op's text. A name every object inherits (`__proto__`, `constructor`,
`toString`, `hasOwnProperty`…) is refused like any unknown one, as an error
or a problem, never a throw and never a prototype write (`overrides.test.ts` ›
hostile op names and fields; CodeQL js/remote-property-injection and
js/unvalidated-dynamic-method-call, PR #234). The later ops' `crop.set` and
`landCover.set` fields go through the same path (`CROP_SET_FIELDS`,
`LAND_COVER_SET_FIELDS`), and so do `demandObject.set`'s
(`DEMAND_OBJECT_SET_FIELDS`, engine ≥ 1.45.0); their other ops name ids
only, matched by equality. A demand object's schedule is rebuilt from each
window's eight known fields.

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
  property covers them. The later ops (engine ≥ 1.35.0: `node.move`,
  `node.insert`, `crop.set`, `crop.remove`, `landCover.set`,
  `ewrRule.remove`, `allocation.set`, `allocation.remove`) come from a
  stream of their own too, so `checkAll`, no silent change and "a scenario
  applied to a valid model leaves a model the backend would save"
  (`modelRules.test.ts`) all cover them. `scenario.invariants.test.ts` adds:
  random moves and inserts on 250 networks keep one tree with one outlet and
  add no broken save rule, each insert leaving the nodes it names draining
  into the new node and the new node where they drained (both paths run:
  moves and inserts that apply and ones refused); and a land-free gauge
  inserted mid-river on 50 networks leaves every other node's series as they
  were (1e-9 relative), the reach shortfall aside, with every invariant
  holding (the outflow and the outlet's EWR included); and random scenarios
  over bases under a cap or a full allocation keep every invariant, so a
  scenario's volumes reach the allocation self-check. `overrides.test.ts` has each later op's cases: what it does, its
  problems, the base untouched, its run-comparison lines, its class
  (masked too), a cap run under a scenario's volume, and hidden volumes
  answering exactly as free ids. The demand-object ops (engine ≥ 1.45.0)
  come from a stream of their own as well (objects added on units, now and
  then on a user, a gauge or a missing node; one to three fields set on one
  object, which may break a save rule; removals), so `checkAll` and no
  silent change cover them too (a change to an object's note is an
  `InputChange`); `overrides.test.ts` has their own cases: each op, the
  save rules, edit groups (monthly to per unit in either order, a broken
  group skipped whole), a new object reaching the run, the classification,
  the validator, and hidden objects answering exactly as free ids (masked
  targeting and reuse).

  Soak: `SCENARIO_FUZZ_CASES=5000 pnpm -C packages/engine exec vitest run src/scenario/scenario.invariants.test.ts`.

## Not yet supported

Each of these is a follow-up, not a gap in what's listed above. The later
ops (roadmap WP-3.2: `allocation.set`, removing a site's EWR rule table,
moving a node or inserting one mid-river, `crop.set` and removing a crop,
`landCover.set`) are built, engine ≥ 1.35.0 (issue #73).
- **Scaling demand objects by category** ([followups.md](./followups.md)):
  `demand.scale` on a unit scales its crops and objects together;
  `demandObject.set` changes one object's own numbers (engine ≥ 1.45.0).
- **Changing a node's kind**: remove it and add a new node.
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
  `purpose_need`, `mitigation`, `monitoring` (129) are the answers to the
  evidence report's fixed Appendix C prompts, written with the description
  by whoever may change the scenario and printed in Appendix C, each answered
  or *Not given* ([design/evidence-report.md § 4.3](./design/evidence-report.md)).
- `model_run.scenario_id → scenario` (`ON DELETE SET NULL`), set on insert
  only. Deleting a scenario leaves its runs scenario runs: `from_scenario`
  (188) stays true from the snapshot's `inputs.scenario`, so a run of a
  deleted scenario is never a base, the evidence run or a publication
  ([data-model.md § Scenarios](./data-model.md#scenarios-024_scenariossql)).
- Triggers: the base is a run of the same project and not a scenario run (live or orphaned); a
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
`nodeIds[i]`, and a `node.insert`'s `upstreamNodeIds[i]`, so each must be a
UUID and each node's name goes into `op_names`. `allocation.set`'s are the
volume's id and its node, `ewrRule.remove`'s its site (none for the outlet).

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

## Cumulative impact (WP-3.11)

Several scenarios (in practice the submitted applications) on one base run,
**each on its own and all together**, so an assessor sees what they do
together that one application at a time hides (NWA s27(1): the cumulative
effect on the resource and the Reserve). Build plan:
[roadmap WP-3.11](./roadmap/step-3-licensing.md#wp-311-cumulative-impact-assessment),
issue #287.

### Engine: `combineScenarios` and `cumulativeImpact`

`packages/engine/src/scenario/combine.ts`, `cumulative.ts`. Pure; neither
runs the model, and `runModel` is unchanged, so `ENGINE_VERSION` is too (a
combination is new input, as a scenario is).

```ts
combineScenarios(base, [{ id, name?, ops, mask? }]): { input | null, conflicts, problems, renamed, reIds }
scenarioConflicts(base, scenarios): ScenarioConflict[]
cumulativeImpact(baseline, singles, combined): CumulativeReport
```

- **Conflicts are refused, never merged.** Each op says what it *writes*
  (an element's field, or the whole element for an add), *removes* and
  *uses* (a node a new farm drains into, a crop a crop area plants, a
  transfer's ends). Two scenarios conflict when they write the same field of
  the same element (`same_target`, also both removing one thing) or one
  removes what the other writes or uses (`removed_in_use`). Read against the
  base: a `node.remove` re-links the nodes draining into it, so it writes
  their downstream link too; an op on a transfer, patch, borehole, demand
  object or registered volume uses its node(s); a `demand.scale` without
  `nodeIds` writes every farm's (or user's) demand; a `series.scale` writes
  the series (two scalings stack, and whose climate assumption it is isn't
  for either to settle); a unit's `irrigationEfficiency` writes every
  planting on the unit, and a crop's `irrigationEfficiency` or
  `irrigationSystemId` every planting of the crop (engine ≥ 1.72.0 puts
  those plantings on a system; a planting another scenario adds would get it
  in one order and not the other, combine fuzz seed 35). Conservative by design: what can't be told apart is
  a conflict the assessor sees. One conflict per pair of scenarios and
  target, with a readable message naming both ops (`"App A" op 1 (node.set)
  and "App B" op 1 (node.set) both change hydrological unit "Upper farm":
  damCapacityM3`). Ops within one scenario never conflict: they apply in
  their own order, as alone.
- **Then in order.** Without conflicts each scenario's ops apply to the
  result of the ones before (`applyScenario`, an application under its
  applicant's mask, as its own runs are). An op that applies alone but not
  on top of the others (two new dams given one name, flow shares past 100 %
  together) is a `problem` naming its scenario, and also refuses the
  combination: a result with an op skipped would not be the scenarios it
  names.
- **Invariants** (`combine.invariants.test.ts`, random networks): disjoint
  scenarios combined in either order give the same run (every daily series
  to the bit, the summary within float noise, `orderFreeDifference`, the
  order-invariance check's comparison); one scenario combined is that
  scenario alone, to the bit; a scenario with a copy of itself always
  conflicts; the conflicts found don't depend on the order the scenarios
  are given. `combine.test.ts` has the crafted pairs (each conflict kind,
  two fields of one node not a conflict, apply-alone-not-together, the base
  never mutated). Soak: `SCENARIO_FUZZ_CASES=1500` (passes).
- **The report.** Per EWR site (the outlet first, then gauges by id): days
  the EWR is not met and the mean EWR shortfall over the reporting window
  (`curtailment.ewrSites`); per Reserve rule-table site: months met and the
  deficit (`ewrAssurance.overall`); for the catchment: mean flow at the
  outlet, supplied to existing users (the baseline's farms and other
  users, summed in id order; a unit a scenario adds is its own proposal and
  left out of every column) and their share of demand met. Each row holds
  the baseline, each scenario alone, all together, each change from the
  baseline, their sum, the combined change and the **interaction** =
  combined change − Σ single changes (0 when the effects simply add).
  `warnings` names a run over another window than the baseline's.
  `cumulative.test.ts` checks the arithmetic on real runs, an empty scenario
  changing nothing, existing users excluding an added farm, and the
  Reserve rows.

### Backend

`backend/src/assessments/` and the `assessment` job
(`jobs/handlers/assessment.ts`); migration `145_assessment.sql`
([data-model.md § Assessments](./data-model.md#assessments-145_assessmentsql),
[api.md § Assessments](./api.md#assessments)).

- `POST /projects/:id/assessments { name, scenarioIds }` loads each
  scenario as the caller reads it (a draft application is invisible),
  requires one base run, rebuilds it (`loadBaseInput`), checks each alone
  and all together (`checkCombination`) and **refuses with `422 { conflicts,
  problems }`** before anything is written. `dryRun` stops there. Otherwise
  it writes the assessment, one member per scenario (the database copies
  each scenario's ops; the request never supplies them) and the job.
- The job (as the editor who asked, under RLS) runs the baseline, each
  member alone and all together on **the current engine**, so every column
  is one engine's (the published run's stored summary may be an older
  engine's), then stores `cumulativeImpact`'s report. It checks the
  combination again and marks the assessment `refused` if it no longer
  holds. No `model_run` rows: like a sweep, an assessment never counts
  against the 20-run cap. Editors only (RLS and the routes).
- Tests: `assessments.db.test.ts` (two applications end to end, the single
  equal to the application's own run and the baseline to the published
  run, the interaction, a conflicting pair refused with nothing written,
  the dry run, drafts and other bases refused, RLS with a positive control,
  copied ops, write-once, a deleted team scenario).

### The evidence report reads it

Page 1's row over the other applications (C26, report format
`evidence-11`) reads a completed assessment of exactly the report's
application and every other submitted or approved one on its baseline, with
their current ops, made on the baseline run's engine (so its baseline
figure is the report's own; one on another engine is named with why it
isn't read): the combined change and the interaction at the outlet.
Without one the report checks the combination itself (`checkCombination`,
no model run) and names any conflict, or says the applications haven't been
assessed together ([evidence-pack.md § The other applications
together](./evidence-pack.md#the-other-applications-together)). Tests:
`evidence/report-combined.db.test.ts`.

### Not yet

- **Yield and reliability per dam** together (WP-3.6's yield on the combined
  input), and a **full-allocation background** (WP-3.10) as the baseline
  column, are not in the report yet ([followups.md](./followups.md)).

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
- **The drought restriction rule** (`settings.set droughtRestriction`,
  engine ≥ 1.54.0) is edited whole in the Settings tab's own editor
  (`settings/DroughtRestrictionFields.svelte`, loaded when picked),
  starting from the rule the scenario meets (or off); its first problem
  blocks Add, in the same words as Settings. Described as "Drought
  restriction rule: off → reviewed 5 Oct; Level 1 (below 70 %): crops 50 %".
  A baseline assumption, like every `settings.set`.
- **Scale demand** (`demand.scale`): whose demand (farms' irrigation or
  other water users'), the new demand as a % of what they'd take (0–200 %),
  a checkbox per node of that category and per month, Oct first (none ticked
  is all of them, and the op then leaves `nodeIds` / `months` out; every
  month ticked is the same as none). It reads "Irrigation demand of Upper
  farm: 85 % of what they'd take (× 0.85), in Jan, Feb, Dec". For
  hydrological units, **Part of their demand** (engine ≥ 1.45.0): all of it,
  the crops, or the demand objects of one category; "Domestic demand objects
  demand of Upper farm: 90 % of what they'd take (× 0.9)".
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
- **The later ops in the form** (engine ≥ 1.35.0). **Move what a
  hydrological unit drains into**: the hydrological unit (not the outlet) and the one it will drain
  into, with "Now: drains into …"; it reads "Move “Lower farm”: drains into
  Outflow gauge → Upper farm". **Insert a hydrological unit on a reach**: as **Add a
  hydrological unit** (kind, name, dam or demand), the hydrological unit it drains into (only
  ones something drains into), and a checkbox per hydrological unit draining there now, at
  least one ticked; "Insert the hydrological unit “Weir dam” above Outflow
  gauge, taking what Upper farm drains, dam 50 000 m³". **Change a crop**:
  the crop, the field (name, crop factors, irrigation efficiency), the value
  with "Now: …", and a note that a crop the scenario didn't add is a
  baseline assumption. **Remove a crop** (its areas on every unit go too).
  **Change land cover**: the patch, the field (class, area, condensed cover,
  reductions typed as "MAR %; low-flow %", empty for the class's).
  **Remove an EWR site's rule table**: the sites that have one, with its
  table as "Now: …", always a baseline assumption. **Set a registered
  volume**: a new one or an existing one (its fields then filled in), the
  unit, water source, volume, storage, validity, months of use and maximum
  rate; "Upper farm: add a registered volume, surface 100 000 m³/a".
  **Remove a registered volume**. Each form refuses what the engine's
  validator refuses, in its own words.
- **Demand objects in the form** (engine ≥ 1.45.0). **Add a demand
  object**: the unit, name, category and how the demand is given (m³/day
  by month, one value for every month or 12, or a count × litres a day);
  its return share, priority and destination start at the category's
  defaults, as the Network tab's Add demand gives them
  (`newDemandObjectDefaults`), and a note says to change them with the next
  op or add the object in the model tables. It reads “Upper farm: add the
  demand object “Village”, Municipal (town), 300 m³/day on average”.
  **Change a demand object**: the object (by unit and name), the field
  (every one, labels as on the Network tab's form) and the value with "Now:
  …"; its **On/off schedule** is the Network tab's own schedule editor
  (`DemandScheduleFields`) on a copy of the object, recorded whole as one
  `demandObject.set` (no windows is none; a window the run can't read is
  refused in the form in the editor's words), reading “…: On/off schedule
  none → 1 window (Weekends off)”; and, for the sizing or the
  destination, a note that the fields that go with it are the next changes
  on the same object (one edit group). **Remove a demand object**, with the
  object as "Now: …".
- **Classification in the UI**: each op shows **Proposal** or **Baseline
  assumption**; any baseline op shows the red **Baseline assumptions
  changed** callout, in the tab and on the compare page. On a team scenario
  the proposer's hydrological units and users (`ownedNodeIds`) are a checkbox
  list in the tab (gauges only while one is still ticked); on an
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
  that applies: `crop.remove`, `crop.set` per changed field of a crop and
  `crop.add` (engine ≥ 1.35.0; a removal first, so a new crop may take its
  name), `node.remove` (re-linking as the editor does),
  `node.set` per changed field the engine lets a scenario set (one node's
  fields next to each other, in the node's own key order: they are one
  edit group, so a `trigger` farm moved straight to run of river with its
  dam emptied records as it is; a node's edit that still breaks a save rule,
  such as `trigger` with the dam emptied, is reported), `node.add`
  (each after the node it drains into), or `node.insert` when existing
  nodes that drained where the new node drains now drain into it (engine ≥
  1.35.0), then `node.move` for every other node that drains somewhere else
  now, nearest the outlet first, so each lands on a reach already where it
  ends up and no move makes a loop on the way (two farms swapped round is
  two moves that apply), `cropArea.set` with the farm's new
  total of a crop, `transfer.remove` / `.add` / `.set` per field,
  `landCover.remove` / `.add` / `.set` (a patch edited in place is
  `landCover.set` per field, engine ≥ 1.35.0; one moved to another farm is
  removed and added again), `borehole.remove` / `.add` (a borehole edited
  in place is removed and added again) and `demandObject.remove` / `.add` /
  `.set` (engine ≥ 1.45.0: an object edited in place is `demandObject.set`
  per changed field, its ops next to each other as one edit group, so a
  sizing switched with its count and litres records as it is; one moved to
  another unit is removed and added again; no schedule, null and an empty
  one are the same, and a schedule's windows are compared field by field).
  Each op goes
  through the form's own check (`ops.ts` `checkOp`, which `buildOp` also
  ends with: the engine's `validateScenarioOps`, worded in the form's
  units), and the whole list is applied to the loaded model
  (`applyScenario`): it must apply cleanly and give back the edited model
  (ignoring display order), or nothing is recorded. The ops are appended
  with one `PATCH`, so one **Undo** takes them all back.
- **What override mode can't record**, named in its record panel and
  holding the rest back until undone (the engine has no op for them;
  [§ Not yet supported](#not-yet-supported)): changing a node's kind, the
  outflow node moved (or another node made to drain nowhere), a new node
  that drains nowhere, the capacity of a dam with a
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
showing it; the catchment's settings untouched; axe) and
`e2e/tests/scenario-later-ops.spec.ts` (engine ≥ 1.35.0: Lower farm moved
to drain into Upper farm, a weir dam inserted above the gauge taking Upper
farm, a crop's irrigation efficiency, and a new registered volume on Upper
farm, each through the form with its wording and class, one refused in the
form's words, kept over a reload and run; the run's model has the new
shape and the volume, and the catchment's own model is untouched; axe).
`e2e/tests/scenario-demand-objects.spec.ts` (engine ≥ 1.45.0: a village
added on Upper farm as people × litres a day, a missing count refused, its
share returned changed with "Now: …" and an out-of-range value refused, both
classed by the farm, run with the village in the run's model and none in the
catchment's; axe).
`scenarios/ops.test.ts` builds and describes each later op and the
demand-object ops, and `overrideDiff.test.ts` records crop edits and
removals, moves (two farms swapped round), inserts, land cover edited in
place and demand objects added, edited per field (a sizing switch as one
group), moved and removed, the fuzz round trip covering the later ops and
the demand-object ops too.

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
  its values blanked but for the bed losses in the reach below it (engine ≥
  1.75.0: the river's, not the farm's use, so the applicant's runs lose water
  where the base's do); crops, crop areas, transfers, land cover and
  boreholes on their own farms only. Of a hidden node's text fields only
  those an explicit list keeps survive (`TEXT_KEPT`: its place, kind and
  the categorical rules: dam release, dates in service, user priority,
  borehole and supply rules); how a neighbour waters its crops
  (`cropWaterSource`, river or dam) is dropped with its pump and pool, and
  a new text field on a node fails the build until the list decides it.
  This is D2's recommended default
  ([step-3 § 11](./roadmap/step-3-licensing.md#11-open-decisions)),
  **pending the client**.
- **The applicant's namespace** (049, `applicationMask` in `applicant.ts`,
  the engine's `applyScenario(…, { mask })`). An application's ops meet
  every node the projection anonymises under its anonymous name, and every
  crop, transfer, land-cover patch, borehole, registered volume (engine ≥
  1.35.0) and demand object (engine ≥ 1.45.0) it leaves out under an
  opaque id (and, for a crop, borehole or demand object, name) that none of the ops holds,
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
    (removing a hidden farm reports no crop areas, transfers, patches,
    boreholes or demand objects; the EWR tables sited there are settings,
    which they see);
  - `crop.remove` (engine ≥ 1.35.0) likewise counts only the areas on nodes
    they see, and a change to a crop is classed a baseline assumption
    whoever grows it, so neither says whether a hidden farm grows it;
  - a rule the op breaks because of hidden data (a rule about a hidden
    item, a hidden farm's drought borehole rule or supply rule (both read
    its hidden dam or levels), and, while any farm is
    hidden, flow shares over 100 % or no catchment area left, which an op's
    own range-checked value can't break alone) reads only `op N (…):
    doesn't apply to the catchment as modelled` (`MASKED_RULE`). For the
    catchment-wide rules (flow shares, area) the applicant reads the
    catchment's value and the hidden units' aggregate instead
    (`MASKED_RULE_AGGREGATE`: "flow shares would total 120.0 %, more than
    100 %; the units you can't see hold 90.0 % of them between them") when
    the hidden farms have `FARMER_K` = 5 or more holders, the applicant
    left out (`app_application_hidden_holders`, counted as the k rule counts
    them, 164): an aggregate over that many holders relates to no one of
    them. Below that the generic words stay, since the aggregate would be a
    holder's own figure. Provisional position (pre-counsel research,
    2026-10-01); rules about the network's shape and names keep their
    words.
  - the check says which lines a hidden rule broke (`maskedRules`: the
    line, its ops and the rules' kinds, never an id, a name or a value),
    and gives editors and up every line in its real words
    (`assessorProblems`), which no contributor receives. The assessors'
    cumulative assessment records the real words too (they alone read it).
  - **Ask the assessors why** (164). Such an application can't be
    submitted, and the assessors never read a draft, so a note on it would
    reach no one. Its parties ask instead (`POST …/questions`): the
    question carries the line as they read it, the ops it names, the rules'
    kinds and the application's name, plus the line in its real words,
    which the server computed and only the editors read
    (`application_question`). The editors answer once, on the Applications
    tab; the authority decides what an answer discloses of other users'
    figures. The draft stays the applicant's.

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
  assessors keep the stored list. An issued evidence pack is the exception:
  its applicant's copy keeps the units it was issued about
  ([evidence-pack.md § Applicants](./evidence-pack.md#applicants), 164).
- **Workflow.** The owner submits (`POST …/submit`: only when every op
  applies; the ops, their hash, the base and the own nodes freeze), may
  withdraw a submitted one (`…/withdraw`) and reopen a withdrawn one as a
  draft (`…/reopen`). An **assessor** is an editor who isn't the owner: they
  read a submitted application, comment on it and share it by link. The
  app **records the responsible authority's decision; it never makes one**
  (163_licensing_authority; provisional position, pre-counsel research,
  2026-10-01, D14 in [step-3-licensing.md § 11](./roadmap/step-3-licensing.md)):
  only an assessor the project's owner marks as acting for the authority
  (below) records it, with **Record the authority's decision** (`…/decide
  { outcome, authority?, decisionDate, reference?, reasonsReceived, note }`).
  The outcome is in the National Water Act's and GN R267's words:
  `licence_issued` (*Licence issued (see its conditions)*: every licence
  carries conditions, s28(1)(d)), `licence_refused` (s42),
  `application_rejected` (formal requirements, R267 regs 9(1)(b), 11(2),
  12(2)(b)) or `not_considered` (the use is already authorised, s40(4)).
  The record holds the authority's name (the project's
  `settings.responsibleAuthority` when the form leaves it empty), the date on
  its decision letter (separate from `decided_at`, the app's stamp), its
  licence or file reference and whether written reasons were received
  (s42(b)). A decision is final: the trigger sets it once and never changes
  it. Decisions recorded before 163 were mapped (`approved` and
  `approved_with_conditions` → `licence_issued`, `refused` →
  `licence_refused`), with the authority "Not recorded (before 163)" and no
  date. A team scenario an editor only marks decided (no outcome) is the
  team's own what-if and records none of this. The panel says any appeal runs from the authority's decision letter
  (s148, s41(6)) and works out no deadline. `submitted_at`, `decided_at` and
  `decided_by` are stamped by the trigger. The roadmap's "under review" is
  not a status of its own: a submitted application is the assessors' queue.
- **Who decides: the responsible authority** (163, D1 in step-3 § 11). The
  project names it in `settings.responsibleAuthority { name, kind: 'dws' |
  'cma', office }` (the Project page's *Responsible authority* card; no model
  input). The owner ticks *Acts for the responsible authority* on the
  members who act for it (`project_member.acts_for_authority`); as editors or
  owners they record its decisions and endorse a published baseline for it
  (`POST …/publication/:pubId/endorse`, once per publication, audit event
  `publication.endorsed`), and an evidence report on a baseline nobody
  endorsed says so on page 1. This makes the host matter less: a CMA host, a
  WUA host with CMA or DWS staff as marked editors (the pilot default), or a
  consultancy host all work, because the decision and the endorsement are
  the authority's whoever hosts.
- **The conflict guard** (163, D1 (c)). Nobody who edits the project
  (editor or owner, directly or through its team) may be in an applying
  party, own an application or be shared one there: the database refuses
  the change (`409 role_conflict`), whichever side of it comes second (a
  role, a party, a team role, a project moving team, a new application, a
  share). An applicant's consultant stays a contributor; to make a party
  member an editor, take them out of the party in the same change.
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
  they read the application's own nodes and the catchment allowlist only,
  and nothing of a run whose ops weren't all proposals
  (046, 118, [data-model.md § Applicants](./data-model.md#applicants-044045)).
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
- **Results for the applicant** (118, `GET …/scenarios/:sid/results`,
  `scenarios/results.ts` and the pure `applicantResults.ts`; D2's
  recommended default, **pending the client**). The assessors compare a run
  with its base on the compare page (`/compare/runs` refuses a contributor,
  since it returns `inputs`); the applicant gets a projection of the same
  run against the same base, built on the server as the base's is. The
  server reads the run's recorded scenario, model and summary and its
  base's summary past RLS (`app_application_run_results`, for whoever reads
  the application), rebuilds the check that made the run's input (the same
  base, recorded ops and recorded own units give the same input, and so its
  `reIds`), and returns:
  - every **EWR site**'s months met, rate and longest run not met, base
    beside application (the outlet unnamed, a gauge by name), and the
    outlet's EWR days not met;
  - the **catchment**, base beside application: its mean natural flow and
    the outlet's daily EWR requirement (the river) at any holder count; its
    mean outlet flow and daily outflow series, and the EWR deficit volumes
    (the use: natural minus outflow is the farms' take), only at five or
    more farm holders (the k rule of the share links and the contributor's
    series, split in 164; provisional position, pre-counsel research,
    2026-10-01); read under the caller's own RLS;
  - their **own units** (their farm links as they read them now) and the
    units their `node.add` ops add, in full: demand, supply, share met, EWR
    charge, the dam;
  - every other farm or water user **downstream** of those units (along
    `downstreamNodeId` in the run's network) under the anonymous name the
    base projection gives it, with only the change in its mean supply as a
    whole percentage ("Farm 3 downstream: supply −4 %");
  - **what ran on their units**: their nodes, crops, crop areas, transfers,
    land cover, boreholes and demand objects as the base projection shows
    them, where an item an op added under a hidden item's id (the run holds
    it under a fresh one) shows under the id the applicant gave it.

  **Only when every op was a proposal** (`app_run_all_proposals`, the share
  link's rule). A baseline assumption can change another unit's inputs (its
  demand halved, its dam emptied), and every figure that moves with it (the
  catchment's flow, their own supply, a neighbour's change) could read that
  unit's values out, so such a run shows the EWR sites' months and the EWR
  days only, and RLS hands a contributor none of its series (118). The
  percentage is rounded to a whole number and never comes with a volume. The
  Applicant view shows it all under the changes (ui.md § Applications).
- **The log.** `scenario.created / changed / submitted / withdrawn /
  reopened / decided / shared / unshared / deleted` and `run.created` carry
  `application: true` and no name until the application is decided (every
  viewer reads the project's history).

### Sharing and comments (WP-3.15)

`115_scenario_share_notes.sql`; [api.md § Share](./api.md#share),
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
  `public_participation`, which any member contributor or above may post
  while the application is **open for comment**: a live link, or decided
  after it was ever shared. Anyone else signed in comments **through the
  link itself**, with no role in the project (a *link participant*, an NGO
  say; `166_public_participation`, `POST /share/comment`): they read only
  what the link shows, 10 comments an hour per account. An NGO is never
  made a `viewer` to comment: a viewer reads every farm's figures (POPIA
  s10; licensing positions item 7, provisional position, pre-counsel
  research, 2026-10-01). Public comments show on
  the link with their authors' names; editors moderate by soft delete. Every
  edit of a scenario note keeps the text it replaced (`note_revision`,
  `GET …/notes/:noteId/revisions`): a participation record must be complete,
  and an application that drew public comments can't be deleted (`409`).
  The full read/write matrix is in [data-model.md § Notes](./data-model.md#notes-037_notessql).
- **A comment is not an objection.** Every public-participation comment
  box (the share pages, the workspace's notes with that audience) says that
  a comment in the app is not a written objection: only a written objection
  sent to the address in the application's notice before its closing date
  keeps a right to appeal (NWA s148(1)(f)). The applicant enters that
  address and date on the Application panel while it is a draft
  (`scenario.objection_address`, `objection_closing_date`, GN R267 reg
  17(4)(b)(vi)–(vii); frozen once submitted, `scenario_objection_frozen`),
  and the share pages print them.
- **The register and the reg 19 record.** A commenter may tick "Give my
  name and email to the applicant for the register of interested and
  affected parties (GN R267 reg 18)" (`note.register_consent`, fixed at
  insert). The application's owner and the editors download its public
  participation record (`GET …/scenarios/:sid/participation-export`, JSON or
  CSV; the print page `/projects/:id/scenarios/:sid/participation`): every
  public comment on it and its packs, with the author's display name,
  dates, earlier texts and moderation state (a removed comment's words go
  to the editors only), the email only where the commenter agreed, the
  links it was shared by, laid out under the GN R267 Annexure D item 8
  headings the app holds material for. Each download is audited
  (`scenario.participation_exported`, with how many emails it carried).
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
`share/participation.db.test.ts` (166: link participants with their
controls, the objection details, the throttle, the reg 19 export's
audience and emails), e2e
`e2e/tests/scenario-share.spec.ts` (an NGO with no role opens a link,
signs in, reads the objection warning and the notice's address, comments
and joins the register; the assessor sees it; the applicant's record lists
it with the email; axe),
the applicant's `ewrRule.set` in `applications.db.test.ts` (accepted,
applied, classed baseline beside their own farm's proposal), e2e
`e2e/tests/applications.spec.ts` (the applicant's flow and their view of
the results, their Yield panel, the assessor's
decision, the owner's party and the applicant's share picker, axe in both
themes). The results: `applicantResults.test.ts` (the projection: names as
the base projection gives them, the rounded percentage, what's left out
after a baseline assumption and below five farm holders, the `reIds` mapped
back, each with its positive control) and `results.db.test.ts` (118 end to
end: the string scan, who may ask, the definer function's readers, RLS on a
baseline-assumption run's series).
