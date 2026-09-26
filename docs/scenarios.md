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
  input, not new model behaviour.
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

### Op catalogue

Every op targets by id; `ScenarioOp` is a closed union discriminated by `op`.

| Op | Fields | What it does |
| --- | --- | --- |
| `node.set` | `nodeId, field, value` | Sets one whitelisted field (below). Typed per field. |
| `node.add` | `node` | Adds a **leaf** node that drains into an existing node (never a new outflow). Fields it leaves out take the engine's defaults (`upgradeLegacyModel`: no boreholes, senior user, dam area estimated). |
| `node.remove` | `nodeId` | Removes a node. Nodes that drained into it now drain into its downstream node, so the network stays one tree. Drops its crop areas, transfers from or to it, its land-cover patches and any EWR rule table sited at it. The outflow node can't be removed. |
| `cropArea.set` | `nodeId, cropId, areaM2` | Sets a farm's area of one crop (m²); `0` removes the row. Replaces duplicate rows with one. |
| `crop.add` | `crop` | Adds a crop definition (12 crop factors, and optionally its own `irrigationEfficiency`, engine ≥ 0.41.0). |
| `transfer.add` | `transfer` | Adds a transfer rule. Months are stored as a sorted set. |
| `transfer.set` | `transferId, field, value` | `fromNodeId`, `toNodeId`, `months`, `maxRateM3s`, `dailyCapM3`, `minStoragePct`, `enabled`, `priority`. |
| `transfer.remove` | `transferId` | Removes a transfer rule. |
| `landCover.add` | `patch` | Adds a land-cover patch on a farm (WP-1.35). |
| `landCover.remove` | `patchId` | Removes a patch, e.g. clearing invasive aliens. |
| `borehole.add` | `borehole` | Adds an individual borehole on a farm or other user (WP-3.9), e.g. an applicant's new borehole with its tested yield and annual volume. |
| `borehole.remove` | `boreholeId` | Removes a borehole. `node.remove` drops the node's boreholes too. |
| `settings.set` | `path, value` | Sets one whitelisted setting (below). Nested paths write over what is there. |
| `series.scale` | `kind, factor, from?, to?` | Multiplies a rain series or the daily A-pan series by `factor` (0–10) on the days `from`–`to` (ISO dates, inclusive; each end open when absent). Missing days stay missing. |

**`node.set` fields, per node kind.** Never `id`, `kind`,
`downstreamNodeId` (the network's shape: use `node.add` / `node.remove`) or
`sortOrder` (display only).

- farm: `name`; land `areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`;
  dam and irrigation `pctUpstreamToDam`, `pctRunoffToDam`, `damCapacityM3`,
  `damInitialPct`, `damMinPct`, `damAreaFullM2`, `damAreaExponent`,
  `damSeepagePerDay`, `divertCapacityM3Day`, `irrigationEfficiency`,
  `lossReturnFraction`; dam storage (WP-3.5) `damReleaseRule`,
  `damReleaseM3Day`, `damOutletCapacityM3Day`, `damSeepageReturnPct` (a
  `node.add` may also carry a `damCurve`; there is no `node.set` for it
  yet); boreholes `boreholeCapacityM3Day`, `boreholeRule`,
  `boreholeTriggerPct`, `streamDepletionFrac`, `streamDepletionLagDays`.
- user (other water user): `name`, `userDemandM3Day`, `userReturnPct`,
  `userPriority`, and the borehole fields.
- gauge: `name` only (a gauge only measures).

Ranges are the backend's (`backend/src/model/validate.ts`).

**`settings.set` paths:** `februaryDays`, `effectiveRainFraction`,
`effectiveRainFractionMonthly`, `effectiveRainStoreMm`, `lakeEvapFactor`, `lakeEvapFactorMonthly`, `apanMm`, `panCoefficient`,
`ewrPragmaticM3PerDay`, `flowShareMethod`, `hiLoSplit.hi`, `hiLoSplit.lo`,
`runoffModel`, `gr4j.x1`–`gr4j.x4`, `gr4j.warmupDays`,
`chirpsBiasCorrection`, `zeroRainRuns.mode`, `zeroRainRuns.accumulationMode`,
`calibration.a`, `calibration.b`, `calibration.rainThresholdMm`,
`calibration.summerFactor`, `calibration.winterFactor`,
`calibration.baseFlowInitial`, `calibration.catchmentAreaKm2`,
`calibration.summerMonths`, `simulationStart`, `simulationEnd`,
`reportStart`, `reportEnd`, `calibrationStart`, `calibrationEnd`,
`calibrationFlowKind`, `pe`. Ranges follow `backend/src/projects/settings.ts`.
`pe` (engine ≥ 0.31.0, issue #39) takes a whole PE input, GR4J's source
of potential evaporation: `{ kind: 'pan' }` with no other key, or
`{ kind: 'monthly', mm, source }` with 12 finite values of 0–10 000 mm and
a source that is not blank when trimmed, at most 600 characters. Like every
`settings.set`, it is classified baseline.
Every path is one the input diff reports, so no setting changes silently.

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
| `settings.set`, `series.scale` | never | baseline (settings, calibration, EWR, flow-share method, climate) |
| `node.set` | the node is owned and the field is not land or flow share (`areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`) | baseline: other parties' nodes, and the catchment's partition of runoff |
| `node.add` | not a gauge, and no land or manual flow share of its own (a new dam, pump or user) | baseline: a gauge moves an EWR site; land or a manual flow share re-partitions the catchment |
| `node.remove` | owned, not a gauge, no land or manual flow share, and no EWR rule table sited at it (needs `input`) | baseline |
| `cropArea.set`, `landCover.add` | on an owned node | baseline |
| `crop.add` | always | |
| `transfer.add` | both ends owned | baseline |
| `transfer.set`, `transfer.remove` | both ends owned, and a new end owned too (needs `input`) | baseline |
| `landCover.remove` | the patch is on an owned node (needs `input`) | baseline |
| `borehole.add` | on an owned node | baseline |
| `borehole.remove` | the borehole is on an owned node (needs `input`) | baseline |

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
  and gives identical results in any node order; the classifier; the
  validator.
- `scenario.invariants.test.ts`, over random op lists on `randomInput(seed)`
  (generator `testing/scenarioFuzz.ts`, `randomOps`):
  - `checkAll` (every engine invariant, order invariance included) holds on
    250 scenarios;
  - **no silent change**: on 1000 scenarios, every op that changes the
    resolved input produces at least one `InputChange` from
    `diffInputs`, an empty op list produces none, and a skipped op changes
    nothing;
  - applied ops keep a valid tree and never touch the base.

  Soak: `SCENARIO_FUZZ_CASES=5000 pnpm -C packages/engine exec vitest run src/scenario/scenario.invariants.test.ts`.

## Not yet supported

Each of these is a follow-up, not a gap in what's listed above:
- **EWR and allocations**: `ewrSite.set` (an EWR rule table) and
  `allocation.set` (roadmap WP-3.2's later ops). EWR rule tables are
  baseline either way.
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

Backend tests: `backend/src/scenarios/scenarios.db.test.ts` (the API end to
end, RLS with positive controls, cited bases, status, a dropped node's name
kept through a rebase and a re-read), `schema.test.ts` and `names.test.ts`.

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
  (`stepInputs`, `applyScenario` one op at a time), for the targets the form
  offers and the value each op replaces in its description. A node or crop
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
- **Classification in the UI**: each op shows **Proposal** or **Baseline
  assumption**; any baseline op shows the red **Baseline assumptions
  changed** callout, in the tab and on the compare page. On a team scenario
  the proposer's nodes (`ownedNodeIds`) are a checkbox list in the tab; on an
  application they are its owner's farm links, set by the server.
- **Comparison**: the tab compares the latest scenario run with the base run
  that run recorded (`inputs.scenario.baseRunId`), reusing the compare page's
  headline, farm and daily-overlay components (issue #8); the compare page
  lists each scenario side's recorded ops in its Scenario overrides section.
- **Override mode** (`OverrideEditor.svelte`, `overrideDiff.ts`, its own
  chunk): the workspace's Network, Crops and Transfers tabs, unchanged, on
  their own `ModelEditor` loaded with the scenario's model (the base run's
  snapshot with the listed ops applied, `stepInputs(...).after`). The live
  model is never loaded or saved there. **Record** diffs the edited model
  against the one it was loaded with (`diffModel`) into ops, in an order
  that applies: `crop.add`, `node.remove` (re-linking as the editor does),
  `node.set` per changed field the engine lets a scenario set, `node.add`
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
  into), a new node that drains nowhere, a dam survey curve, and a field the
  engine doesn't let a scenario set on that kind of node (a gauge's area).
  Row order is display only and isn't recorded.

Tests: `scenarios/fields.test.ts` (every node field, transfer field and
settings path the engine allows has a spec; values round-trip through the
form's text and still pass the engine's checks), `scenarios/ops.test.ts`
(`stepInputs`, `describeOp`, problems lined up with their ops, `buildOp` for
every op kind, each built op applying to a base), `scenarios/overrideDiff.test.ts`
(edits made with the model editor's own methods come back as ops that
apply and give back the edited model, per table; every edit no op can
express is named; the engine's refusals in the form's words; a fuzz over
the engine's own random ops, `randomOps`, round-trips), and
`e2e/tests/scenarios.spec.ts` (the golden path: a 20 % dam raise created,
classed, undone, run and compared, with the compare page's overrides; a
rebase reporting a change that no longer applies and the `422`; a viewer
read only; override mode recording one edit in each table as changes,
refusing a kind change, leaving the live model untouched, undone as one
edit, with axe; submit, withdraw, delete releasing the base; axe in light,
dark and on a phone).

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
    item, a hidden farm's drought borehole rule, and, while any farm is
    hidden, flow shares over 100 % or no catchment area left, which an op's
    own range-checked value can't break alone) reads only `op N (…):
    doesn't apply to the catchment as modelled` (`MASKED_RULE`). The
    wording is the recommended default, **pending the client**
    ([issue #50](https://github.com/Absence0760/project-water-management/issues/50));
    rules about the network's shape and names keep their words.

  Afterwards each hidden node and crop gets its real name back, suffixed
  where an op took it (`Kliphuis` → `Kliphuis (2)` in that application's
  runs), and each hidden item its real id; a new item an op gave a hidden
  item's id moves to a fresh one (`<id>-2`), so the hidden item keeps the id
  it lines up with the base by (run comparison matches by id). The check's
  `renamed` and `reIds` list those for the assessors; a contributor never
  receives either.
- **Own nodes** are the owner's farm links (`app_farm_nodes`), set at create
  and each time the ops change while a draft. A contributor can't claim
  others' (`403`), so a dam raise on their own farm is a proposal and the
  same raise on a neighbour's is a baseline assumption.
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

Tests: `backend/src/scenarios/applications.db.test.ts` (RLS with positive
controls: drafts hidden from the other applicant, the editors and viewers;
the published run's row unreadable, its catchment series readable; submit,
freeze, decide; sharing; the per-application run cap; the contributor route
inventory), `oracles.db.test.ts` (049: identical answers for member and
non-member ids and addresses, hidden and free farm, crop and application
names, hidden and free item ids, a hidden farm's removal counting nothing,
each with its positive control; the party prune), `applicant.test.ts`
(the projection and the mask), the engine's `overrides.test.ts` ("mask:
names" and "mask: ids, counts and value rules"),
`history/write-routes.db.test.ts` (each new route records its event), e2e
`e2e/tests/applications.spec.ts` (the applicant's flow, the assessor's
decision, the owner's party and the applicant's share picker, axe in both
themes).
