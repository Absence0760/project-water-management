# Scenarios

A **scenario** is a named, ordered list of **overrides on a base run**: "raise
farm X's dam by 20 %", "replace a crop", "remove a farm", "add a transfer",
"scale rainfall −10 %". It runs and compares against its base without copying
the project, and because it keeps the base's ids every change lines up by id
in [run comparison](./run-comparison.md). Build plan:
[roadmap WP-3.2](./roadmap/step-3-licensing.md#wp-32-scenarios-within-a-project),
issue #18.

Status: the **engine part** (`packages/engine/src/scenario/`), the **backend
and data model** (`backend/src/scenarios/`, migration 023) and the frontend's
API client are built. The UI (the Scenarios tab, the override-mode editor and
the compare page's Scenario overrides section) is not.

## Engine: `applyScenario`

```ts
applyScenario(base: ModelInput, ops: ScenarioOp[]): { input: ModelInput; applied: AppliedOp[]; problems: string[] }
```

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
| `crop.add` | `crop` | Adds a crop definition (12 crop factors). |
| `transfer.add` | `transfer` | Adds a transfer rule. Months are stored as a sorted set. |
| `transfer.set` | `transferId, field, value` | `fromNodeId`, `toNodeId`, `months`, `maxRateM3s`, `dailyCapM3`, `minStoragePct`, `enabled`, `priority`. |
| `transfer.remove` | `transferId` | Removes a transfer rule. |
| `landCover.add` | `patch` | Adds a land-cover patch on a farm (WP-1.35). |
| `landCover.remove` | `patchId` | Removes a patch, e.g. clearing invasive aliens. |
| `settings.set` | `path, value` | Sets one whitelisted setting (below). Nested paths write over what is there. |
| `series.scale` | `kind, factor, from?, to?` | Multiplies a rain series by `factor` (0–10) on the days `from`–`to` (ISO dates, inclusive; each end open when absent). Missing days stay missing. |

**`node.set` fields, per node kind.** Never `id`, `kind`,
`downstreamNodeId` (the network's shape: use `node.add` / `node.remove`) or
`sortOrder` (display only).

- farm: `name`; land `areaKm2`, `areaHiKm2`, `areaLoKm2`, `flowShareManual`;
  dam and irrigation `pctUpstreamToDam`, `pctRunoffToDam`, `damCapacityM3`,
  `damInitialPct`, `damMinPct`, `damAreaFullM2`, `damAreaExponent`,
  `damSeepagePerDay`, `divertCapacityM3Day`, `irrigationEfficiency`,
  `lossReturnFraction`; boreholes `boreholeCapacityM3Day`, `boreholeRule`,
  `boreholeTriggerPct`, `streamDepletionFrac`, `streamDepletionLagDays`.
- user (other water user): `name`, `userDemandM3Day`, `userReturnPct`,
  `userPriority`, and the borehole fields.
- gauge: `name` only (a gauge only measures).

Ranges are the backend's (`backend/src/model/validate.ts`).

**`settings.set` paths:** `februaryDays`, `effectiveRainFraction`,
`effectiveRainStoreMm`, `lakeEvapFactor`, `apanMm`, `panCoefficient`,
`ewrPragmaticM3PerDay`, `flowShareMethod`, `hiLoSplit.hi`, `hiLoSplit.lo`,
`runoffModel`, `gr4j.x1`–`gr4j.x4`, `gr4j.warmupDays`,
`chirpsBiasCorrection`, `zeroRainRuns.mode`, `zeroRainRuns.accumulationMode`,
`calibration.a`, `calibration.b`, `calibration.rainThresholdMm`,
`calibration.summerFactor`, `calibration.winterFactor`,
`calibration.baseFlowInitial`, `calibration.catchmentAreaKm2`,
`calibration.summerMonths`, `simulationStart`, `simulationEnd`,
`reportStart`, `reportEnd`, `calibrationStart`, `calibrationEnd`,
`calibrationFlowKind`. Ranges follow `backend/src/projects/settings.ts`.
Every path is one the input diff reports, so no setting changes silently.

**Which series scale.** Only the rain drivers: `rain_catchment_mm`,
`rain_chirps_mm`, `rain_forecast_mm`.
- Evaporation is not a series. It is the monthly A-pan setting `apanMm`
  (and `panCoefficient` for GR4J), changed with `settings.set`.
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
- **The run.** `executeScenarioRun` = `loadRunInput(base)` → `applyScenario` →
  `runAndStore`, the one save path `executeRun` also uses (the engine's
  checked run, the outputs, the stored inputs), with `model_run.scenario_id`
  set and `inputs.scenario = { id, name, baseRunId, ops, opsSha256,
  ownedNodeIds, classified }` in the run's snapshot. It refuses (`422`, the
  problems listed) when any op doesn't apply: a result with an op silently
  skipped would not be the scenario its name says. The run then counts toward
  the project's 20-run cap like any other (`trimRuns`).
- **Why the result can't drift.** The base is a stored snapshot and the ops
  are stored, so running a scenario again gives the same result whatever has
  happened to the live model since, even a node deleted from it
  (`scenarios.db.test.ts` checks it is identical, and equal to
  `runModel(applyScenario(loadRunInput(base), ops))`).
- **Rebase** is `applyScenario(newBase, ops)`: `problems` are the ops that no
  longer apply to the newer base (for example a node removed since). It saves
  the new base with the ops unchanged, or with `dryRun` only reports; the
  scenario won't run until its ops apply again (edit them with `PATCH`).
- **Status.** `draft → submitted → withdrawn | decided`, and `withdrawn →
  draft`. Only a draft's ops, owned nodes and base change; a submitted or
  decided scenario can't be deleted. Who may submit and decide is WP-3.3's
  (the applicant role); today any editor may.
- **The base is cited** (`model_run_cited`), so it can't be deleted,
  trimmed or unpinned while the scenario exists, and its pin doesn't count
  against the 10-pin ceiling. `RunMeta.citedBy` lists the scenarios based on
  a run. Deleting the scenario releases it; the scenario's own runs stay, as
  ordinary runs that remember their scenario's name.

## Data model

Migration `023_scenarios.sql`
([data-model.md § Scenarios](./data-model.md#scenarios-023_scenariossql)):

- `scenario (id, project_id, name, description, base_run_id → model_run,
  ops jsonb, ops_sha256, owned_node_ids uuid[], owner_user_id, status,
  created_at, updated_at)`: names unique per project (ignoring case), at most
  500 ops.
- `model_run.scenario_id → scenario` (`ON DELETE SET NULL`), set on insert
  only.
- Triggers: the base is a run of the same project and not a scenario run; a
  run's scenario is its own project's; the owner is stamped from the session;
  a non-draft is frozen; status moves as above.
- RLS: viewer read, editor write; **farmers read nothing** (a scenario's ops
  and base name every farm; the catchment report makes the same call).
  WP-3.3 adds the applicant's own policies.
- `model_run_cited` gets its first clause (a scenario's base), and the pin
  ceiling stops counting cited runs.
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
end, RLS with positive controls, cited bases, status) and `schema.test.ts`.

## UI (not built yet)
