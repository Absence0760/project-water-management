# Data model

Postgres 17 (locally in docker on `:5434`; in production RDS PostgreSQL 17, see
[deployment.md](./deployment.md)). The schema lives in plain SQL
migrations under `backend/migrations/` and is applied by a small runner
(`pnpm dev:db:migrate`). Once deployed, migrations only move forward: never edit
one that has shipped, add a new numbered file instead. Until the first
production deploy, `001_init.sql` may still be edited in place.

The TypeScript shapes that mirror these tables are in
`packages/engine/src/project.ts`. The backend (storage and validation) and the
frontend (forms) share them. The HTTP contract is in [api.md](./api.md).

## Entity overview

```mermaid
erDiagram
  app_user ||--o{ project_member : "is member"
  project  ||--o{ project_member : has
  project  ||--o{ node : has
  project  ||--o{ crop : has
  node     ||--o{ crop_area : plants
  crop     ||--o{ crop_area : "planted as"
  project  ||--o{ transfer : has
  node     ||--o{ transfer : "from / to"
  node     |o--o{ node : "drains into"
  project  ||--o{ time_series : has
  project  ||--o{ model_run : has
  model_run ||--o{ run_series : outputs
  node     |o--o{ run_series : "per node (null = catchment)"
```

## Tables and their workbook origin

| Table | Purpose | b023 workbook origin |
| --- | --- | --- |
| `app_user` | Account: email (citext, unique), display name, bcrypt hash | none (the workbook has no users) |
| `project` | One catchment/place. `settings jsonb` holds model-wide parameters (`ProjectSettings`) | One workbook. `settings` ← `[Crop demand]` A-pan and effective rain (plus `effectiveRainStoreMm`, the soil-water store, which the workbook doesn't have: default 25 mm, engine ≥ 0.14.0), `[Farm demand]` Feb days, `[Farm spec]` method and Hi/Lo split, `[Flow Calibration Cfg]`, `[EWR Cfg]` pragmatic EWR, `[Home]` date window, `[Flow Calibration Cfg]` calibration window (`calibrationStart/End`) and `[Flow data]` rUseFlow (`calibrationFlowKind`) |
| `project_member` | (project, user, role) | none |
| `node` | A network element: `farm` or `gauge`, `downstream_node_id` (tree to one outflow gauge), areas, flow-share override, dam and diversion parameters, irrigation efficiency and loss return | `[Network]` (name, type, upstream links reversed into one downstream link) + `[Farm spec]` (every numeric column) |
| `crop` | A crop with 12 monthly crop factors (water-year order, Oct … Sep) | `[Crop demand]` crop table |
| `crop_area` | Planted m² per (farm node, crop) | `[Farm demand]` crop-area grid |
| `transfer` | A structured transfer rule: from/to node, months, max rate m³/s, optional daily cap, min source storage %, enabled | `[Transfers]` "Draw From" parameters. The hand-written InOut formulas become the rule itself (see [model.md §2.6](./model.md#26-transfers-transfers)). |
| `time_series` | A daily input series, stored as one array per (project, kind, name). `kind` is free text in the table; the API and `pnpm import:project` accept only `SERIES_KINDS` | `[Flow data]` columns G–K: gauge flow, logger flow, catchment rain, CHIRPS rain, forecast rain. Column F (Pitman flow) is not a series kind from engine 0.10.0 ([audit P1](./engine-audit.md)); rows of that kind left in an older database are ignored by runs. With the importer's `--gauge-as-reference`, the gauge column becomes `flow_reference_m3s` (a gauge on another river, which runs never read; [model.md §2.10](./model.md#210-calibration-statistics-flow-calibration-cfg)) |
| `model_run` | One run: who and when, `engine_version`, date window, an **input snapshot** (`inputs jsonb`) and a small `summary jsonb` | A "Calc. Model" press plus the `[Log]` entry |
| `run_series` | One daily output array per (run, node, key). `node_id` null = catchment-level | Element-sheet columns (storage, spill, outflow, deficit, EWR shortfall…) and `[Flow data]` natural flow and simulated outflow |

### Field mapping details

| `node` column | Farm spec column | Notes |
| --- | --- | --- |
| `area_km2` | Total area farms (km²) | Used by the *Area* flow-share method and for `RainToM3` |
| `area_hi_km2` / `area_lo_km2` | Farm area high / low MAP | *Hi/Lo* method |
| `flow_share_manual` | External fragmentation (%) | *Specific* method (0–1) |
| `pct_upstream_to_dam` | "Upstream inflow above dam (%)" | The share of upstream inflow that enters the dam (engine ≥ 0.9.0). The workbook's formula applied it to the water passing below the dam; the client confirmed the label's meaning ([model.md Q1](./model.md#3-workbook-quirks-and-suspected-bugs)). Defaults to 1 (a dam on the river). |
| `pct_runoff_to_dam` | Farm runoff above (into) dam (%) | |
| `dam_capacity_m3` | Composite dam capacity (m³) | |
| `dam_initial_pct` | Initial dam volume (%) | |
| `dam_min_pct` | (not imported; the workbook's "Min dam volume" is the transfer minimum) | The dam's **minimum operating level** (dead storage, engine ≥ 0.15.0, Q5): irrigation draws only above `capacity × dam_min_pct`, and transfers keep `capacity × MAX(rule min, dam_min_pct)`. Migration 006 reset every stored value to 0; the importer writes 0 |
| `divert_capacity_m3_day` | Downstream diversion back to dam | The workbook enters m³/s and converts it. We store m³/day. |
| `irrigation_efficiency` | (from "Irrigation return flow (%)" r: e = 1 − r, or 1 when r = 0) | Application efficiency e, 0 < e ≤ 1 (CHECK), default 0.8 (engine ≥ 0.15.0, [audit N1](./engine-audit.md)): abstraction demand = crop requirement ÷ e |
| `loss_return_fraction` | (1 when r > 0, else 0) | Share β (0–1) of the application losses `(1 − e) × supplied` that returns to the river the same day; default 0.5. Migration 006 backfilled both from `return_flow_pct` and dropped that column |

Every percentage is stored as a **fraction 0–1** (CHECK constraints enforce the
range).

Ordering: `sort_order` is only for display. The engine works out the
calculation order from the tree (upstream first, with `sort_order` as the
tie-break). The workbook's row-order rule ("upstream elements must be listed
first") therefore disappears.

The backend checks these on every `PUT /model`: node names are unique, the
references stay inside the same document, the graph is a tree, and there is
exactly one node with no downstream (the outflow gauge). The engine
(`buildTopology`) enforces the last two again and throws, so a run never picks
one of several outlets by array order.

## Time-series storage

A daily series is stored as **one row with a `double precision[]` array** plus a
`start_date`. `values[i]` is the value on `start_date + i` days, and `NULL`
elements mean "no reading".

Why arrays and not one row per day:

- **Size and speed.** The client catchment has 16 161 days. One row per day would be
  16k rows per input series and, for outputs, 16k × (nodes × keys) rows per run
  (millions of rows per run, each with ~24 bytes of tuple overhead). An array is
  one TOASTed value (~128 KB raw, compressed on disk). It loads with one index
  lookup and goes straight into a `Float64Array` in the engine.
- **The access pattern is whole-series.** The engine always needs a full series,
  and a chart fetches one series at a time. Nothing queries "flow on 3 March
  across all projects".
- **Simplicity.** There is no extension to install (TimescaleDB is not
  available on Aurora or RDS) and nothing to partition.

Trade-offs we accept: updating one day rewrites the whole array (fine, since
inputs are uploaded in bulk), and SQL date-range aggregates need `unnest … WITH
ORDINALITY` (fine for occasional reports).

**Run output volume.** Each run stores tens to a couple of hundred output arrays
(nodes × keys, ~128 KB each before compression), so a client catchment run is a few
MB to ~25 MB. The engine is deterministic, so any run can be recomputed from
its `inputs` snapshot plus `engine_version`.

- **Cap per project.** Each new run deletes the project's oldest runs beyond
  `RUNS_KEPT_PER_PROJECT` (default **20**; unset or invalid → 20), with their
  `run_series` (cascade). It runs in the same transaction as the new run, as
  the signed-in editor, so RLS applies. `POST …/runs` returns the removed ids
  (`removedRunIds`). There is no pinning yet: a labelled baseline is trimmed
  like any other run once 20 newer ones exist.
- **Output keys: none trimmed, on measurement.** On the local examples,
  TOAST compression already shrinks the constant or mostly-zero series
  (`transfer`, `is_summer`, catchment `ewr`, `deficit` on well-supplied farms)
  to a few hundred bytes to a few KB per run, against 30–60 KB for the
  high-entropy ones (`outflow`, `runoff`, `spill`, `inflow_upstream`). Every
  high-entropy key is charted or exported, so dropping keys would save little
  and change the API. If space ever matters, `real` (float4) outputs or a
  lower cap are the levers.
- **Working columns (engine ≥ 0.12.0).** Each farm also stores its 11
  intermediate columns (gross demand, effective rain, K–P, S, T and the
  balance check V; engine ≥ 0.14.0 adds a 12th, `soil_water`; [model.md §2.7](./model.md#27-farm-balance-one-sheet-per-element)),
  so a day can be checked by hand from the export. On the two-farm e2e
  catchment (120 days) they added 52 % to the run's `run_series` bytes
  (21.6 KB on 41.3 KB); expect roughly that share on a long run, since most of
  them are high-entropy. The alternative, recomputing them at export time from
  the input snapshot, would need the input series the snapshot doesn't keep,
  and would be a second implementation to keep in step with the engine.

**Run input snapshots.** `model_run.inputs` holds the settings and model data
the run used. Input *series* are not copied into it (they are large): the run
refers to them as they were. If a series is re-uploaded, old runs can no longer
be recomputed exactly. For each series kind the snapshot keeps
`{ startDate, length, valuesSha256 }`, where `valuesSha256` is the SHA-256 hex
of `JSON.stringify(values)` (`backend/src/runs/execute.ts` `seriesHash`; it
lives in the `inputs` jsonb, so no column or migration). Runs stored before it
have no hash. `GET /compare/runs` returns the whole snapshot, and
`GET …/runs/:runId` its `settings`. The compare "what changed" list (engine `diffInputs`, see
[run-comparison.md](./run-comparison.md)) sees a series being extended or
trimmed, and values edited within the same dates when both runs carry a hash.
The same hash could later drive an "inputs changed since this run" flag.

**Calibration provenance lives in `project.settings`** (no table, column or
migration; issue #4). `settings.calibrationExclusions` is the list of periods
left out of every calibration score, each a whole water year or a date range
with a required reason. `settings.fitRecord` is the record of the automatic fit
whose parameters Apply wrote: objective, seed, budget, window, exclusions, the
in-sample and validation scores, notes, engine version and time, and the pan
coefficient / A-pan evaporation it ran under (`forcing`, since it is held
fixed and never calibrated — a fit is only valid for the forcing it was
fitted under) ([model.md §2.10b](./model.md)). The backend recomputes its `editedParams` on
every settings save (`patchSettings` in `backend/src/projects/settings.ts`) and
again when a run snapshots the settings (`executeRun`), so each
`model_run.inputs.settings` carries the fit record as it stood for that run's
parameters, marked when they were edited by hand after the fit. Both keys ride
the existing `project` and `model_run` RLS (viewer reads, editor writes), so
they add no policy. They are small: a fit record is a few KB.

## Access control

### Roles

| Role | Can |
| --- | --- |
| `viewer` | Read the project, its model, series, runs and members |
| `editor` | Everything a viewer can, plus change settings and model data, upload series, run the model, delete runs |
| `owner` | Everything an editor can, plus add/remove members, change roles, delete the project |

Whoever creates a project becomes its first `owner`. This happens in a trigger,
atomically with the insert. A deferred constraint trigger makes sure that a
project always keeps **at least one owner**. Any member may remove themselves.

### Teams (002_teams.sql)

Users and groups work across many catchments. A **team** (e.g. a consultancy
or a catchment management agency) has members with a team role, and projects
may belong to a team (`project.team_id`):

| Team role | Effective role on every team project |
| --- | --- |
| `member` | `editor` |
| `admin` | `owner` (and manages the team: rename, members, delete) |

Direct project membership still works on top — the **effective role is the
higher of the two** (`app_project_role()`). Every project policy goes through
`app_has_role()`, which uses the effective role, so team access applies to all
project-scoped tables at once. The team's creator becomes its first admin and a
team always keeps at least one admin (same trigger pattern as project owners).
Deleting a team keeps its projects with their direct members (`ON DELETE SET
NULL`); the creator of a project is always a direct owner. A project can only be
created in, or moved into, a team the user belongs to (moving needs owner).

### Two database roles

| DB role | Used by | Privileges |
| --- | --- | --- |
| `water` | The migration runner (and `pnpm dev:db:psql`) | Owns the schema; runs DDL |
| `water_app` | The backend at runtime | `SELECT/INSERT/UPDATE/DELETE` on the app tables only. **No `BYPASSRLS`, no superuser, owns nothing**, so every policy applies to it. |

Locally both roles have throwaway passwords (`dev/postgres/00-roles.sql`,
`backend/.env.development`). In production, `water_app`'s password is a real
secret kept in `infra-secrets` (see [security.md](./security.md)).

### Row-level security

- Each API request that touches project data runs in **one transaction**. At the
  start the backend sets `set_config('app.current_user_id', <uuid>, true)`
  (transaction-local, so a pooled connection can't leak it to the next request).
- `app_current_user_id()` reads that setting. `app_has_role(project, minRole)`
  is `SECURITY DEFINER` and compares the effective role from
  `app_project_role()` (direct `project_member` row or team membership).
- Policies on `project`, `project_member` and every model-data table (`node`,
  `crop`, `crop_area`, `transfer`, `time_series`, `model_run`, `run_series`):
  SELECT needs `viewer`; INSERT/UPDATE/DELETE on model data need `editor`;
  member management and project delete need `owner`.
- A project you are not a member of is simply **invisible**: the API returns
  `404`, never `403`, so it doesn't reveal that the project exists.
- **Cross-project references are blocked** by `assert_same_project()` triggers.
  An editor of project A cannot attach a crop area, transfer, downstream link or
  run series to a node or crop id that belongs to project B, even if they know
  the UUID.
- RLS is `ENABLE`d but not `FORCE`d. The table owner (`water`) and the
  `SECURITY DEFINER` helpers bypass it on purpose, and `water_app` is never the
  owner.
- `app_user` has no RLS: login has to look a user up by email before anyone is
  signed in. The backend never selects `password_hash` into a response.

### Email tokens and invites (004_email.sql)

| Table / column | Holds |
| --- | --- |
| `app_user.email_verified_at` | When the address was confirmed; `NULL` = unverified (pre-003 accounts were backfilled as verified) |
| `app_user.sessions_revoked_at` | Session watermark: sessions issued earlier are rejected (set by a password reset) |
| `email_token` | `user_id`, `purpose` (`verify` / `reset`), SHA-256 `token_hash`, `expires_at`, `created_at` |
| `invite` | Pending invitation: `email`, either `project_id` + `project_role` or `team_id` + `team_role`, `invited_by`, `token_hash`, `expires_at`, `last_sent_at`; unique per (project, email) / (team, email) |

- Tokens are only ever touched before sign-in, through `SECURITY DEFINER`
  functions: `app_issue_email_token()` (per-address cooldown, replaces older
  tokens of the purpose) and `app_consume_email_token()` (deletes = single
  use; `NULL` if unknown/expired). The RLS policies on `email_token` only allow
  a signed-in user their own rows.
- `invite` RLS: project owners (via `app_has_role(…, 'owner')`) or team admins
  (`app_team_role(…) = 'admin'`) read, create, refresh and delete; inserts must
  have `invited_by` = the current user. `app_invite_for_token()` answers the
  public "what is this link for?" lookup; `app_accept_invites(user)` converts
  every live invite for the user's **verified** address into
  `project_member` / `team_member` rows and deletes those invites. Invites
  cascade away with their project or team.

### Sign-in lockout (005_login_throttle.sql)

| Table | Holds |
| --- | --- |
| `login_throttle` | One row per **typed email address** (not per account, so unknown addresses behave the same): `failures` since the last correct password, `locked_until`, `last_attempt_at` |

- Only touched through `SECURITY DEFINER` functions, before sign-in:
  `app_login_attempt(email, free, base, max)` counts the attempt (row lock, so
  parallel guesses are counted one by one) and returns the seconds left on a
  lock, and `app_login_succeeded(email)` deletes the row (correct password or
  password reset). A deny-all policy (`USING (false)`) closes direct access.
  Rows untouched for a day are deleted on the next attempt. Numbers:
  [security.md § Authentication](./security.md#authentication).

The DB-backed test suite (`pnpm test:backend:db`, database `water_test`) checks
these rules as `water_app`: that non-members see nothing, that role
boundaries hold, that the last owner can't be removed, and that cross-project
ids are rejected.

## Migrations

- Files: `backend/migrations/NNN_description.sql`, applied in order. The runner
  records applied files in `schema_migrations` and runs each file in its own
  transaction.
- Run as `water` (`MIGRATION_DATABASE_URL`), never as `water_app`.
- Every new table that holds project data needs a `project_id`, RLS enabled,
  the viewer/editor policies, same-project triggers for any foreign keys to
  `node`/`crop`, and grants to `water_app`. The `/safe-migration` command walks
  through this.
- Prefer **expand/contract**: add the new column or table and backfill it, ship
  code that uses it, and drop the old one in a later migration. The running
  code and the schema must be compatible during a deploy.
- When changing a SQL function or policy, start from its **latest**
  definition (it may have been redefined in a later migration than the one
  that created it). `DROP POLICY` needs the exact policy name.
- Every SQL function pins `search_path`, and every foreign key has a covering
  index. Catalogue tests guard both.
- Production: a migrate Lambda applies migrations as the owner role before the
  new API code goes live (see [deployment.md](./deployment.md)).
