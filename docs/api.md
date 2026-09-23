# HTTP API

Backend: Hono (`backend/src/app.ts`), dev on `http://localhost:3001`, prod behind
CloudFront at `/api`. All bodies are JSON. Shared TypeScript shapes live in
`packages/engine/src/project.ts` — both the backend and the frontend import them.

## Auth

Session = an HS256 JWT in an **httpOnly cookie** `wm_session` (`SameSite=Lax`,
`Secure` in prod, 7-day expiry). The browser sends it with `credentials: 'include'`;
CORS allows the frontend origin with credentials. There is no token in JS-readable
storage.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ email, password, displayName }` | `201 { user }` + cookie |
| POST | `/auth/login` | `{ email, password }` | `200 { user }` + cookie |
| POST | `/auth/logout` | – | `204`, clears cookie |
| GET | `/auth/me` | – | `200 { user }` or `401` |

`user = { id, email, displayName }`. Passwords: 8–200 chars.

## Errors

Non-2xx responses are `{ error: string, details?: unknown }`. `401` = not signed
in; `404` = not found **or** not a member (RLS hides the project — the API never
reveals that a project exists); `403` = member without the needed role; `400` =
validation (`details` = zod issues); `409` = conflict (duplicate name, last owner).

## Projects

Roles: `viewer` (read) < `editor` (change model data, run the model) < `owner`
(members, delete, move between teams).

Your effective role is the highest of your direct membership and your team
membership: on a team's projects, a team **admin** is an `owner` and a team
**member** is an `editor`. Direct sharing (`/projects/:id/members`) still works
alongside teams, e.g. to give an outside client `viewer` access.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects` | – | `{ projects: ProjectSummary[] }` | – |
| POST | `/projects` | `{ name, description?, teamId? }` | `201 { project }` (`teamId` must be a team you're in; omit/`null` = personal) | – |
| GET | `/projects/:id` | – | `{ project }` | viewer |
| PATCH | `/projects/:id` | `{ name?, description?, settings?, teamId? }` | `{ project }` | editor (owner when `teamId` is sent) |
| DELETE | `/projects/:id` | – | `204` | owner |
| POST | `/projects/:id/copy` | `{ name }` | `201 { project }` (model + series copied; runs not; stays in the team only if you're in it) | viewer |

- `ProjectSummary = { id, name, description, role, team, createdAt, updatedAt }`
- `team = { id, name } | null` — `null` for a personal project. `name` is
  `null` when you reach a team's project through direct sharing but aren't in
  the team (team names are visible to members only).
- `PATCH { teamId }` moves the project into a team you belong to (`404 team not
  found` otherwise) or, with `null`, back to personal. Owner only.
- `project = ProjectSummary & { settings: ProjectSettings }` — settings are
  returned merged over the defaults, so the client always sees every field.

### Members

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { member }` — user must already have an account | owner |
| PATCH | `/projects/:id/members/:userId` | `{ role }` | `{ member }` | owner |
| DELETE | `/projects/:id/members/:userId` | – | `204` (owners remove anyone; anyone may remove themselves) | – |

These are **direct** members only. People who reach a team project through the
team are listed by `GET /teams/:id`, not here.

## Teams

A team owns many projects (catchments) together. Team roles: `member` <
`admin`. Admins rename/delete the team and manage its members; on the team's
projects admins are owners and members are editors (see Projects above).

| Method | Path | Body | Response | Min team role |
| --- | --- | --- | --- | --- |
| GET | `/teams` | – | `{ teams: Team[] }` (teams you're in, by name) | – |
| POST | `/teams` | `{ name }` | `201 { team }` (you become its admin) | – |
| GET | `/teams/:id` | – | `{ team, members: TeamMember[] }` (admins first) | member |
| PATCH | `/teams/:id` | `{ name }` | `{ team }` | admin |
| DELETE | `/teams/:id` | – | `204` — its projects stay, owned by their direct members (`team` → `null`) | admin |
| POST | `/teams/:id/members` | `{ email, role }` | `201 { member }` — `404` if no account has that email, `409` if already a member | admin |
| PATCH | `/teams/:id/members/:userId` | `{ role }` | `{ member }` | admin |
| DELETE | `/teams/:id/members/:userId` | – | `204` (admins remove anyone; anyone may remove themselves = leave) | member |

- `Team = { id, name, role, createdAt, memberCount, projectCount }` — `role` is
  **your** role in the team.
- `TeamMember = { userId, email, displayName, role }`
- `409 a team must keep at least one admin` when removing or demoting the last
  admin (including the last admin leaving). A team you aren't in is `404`.

## Model data

The editable model (network, crops, crop areas, transfers) is read and saved as
one document — the editor holds it in memory and saves it in one transaction.
Ids are client-generated UUIDs; rows missing from a `PUT` are deleted.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/model` | – | `ProjectModel` | viewer |
| PUT | `/projects/:id/model` | `ProjectModel` | `ProjectModel` | editor |

Validation on `PUT`: node names unique; every `downstreamNodeId`, crop-area and
transfer reference points at a node/crop in the same document; the network is a
tree (no cycles) with exactly one node whose `downstreamNodeId` is `null`
(the outflow gauge) — unless the model is empty.

## Time series

Daily series, `values[i]` = value on `startDate + i` days, `null` = missing.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/series` | – | `{ series: SeriesMeta[] }` | viewer |
| GET | `/projects/:id/series/:seriesId` | – | `SeriesMeta & { values }` | viewer |
| PUT | `/projects/:id/series` | `{ kind, name?, unit, startDate, values }` | `SeriesMeta` (upsert on kind+name) | editor |
| POST | `/projects/:id/series/merge` | `{ kind, name?, unit, startDate, values }` | `SeriesMeta` (merge by date; creates the series if missing) | editor |
| DELETE | `/projects/:id/series/:seriesId` | – | `204` | editor |

`merge` is for daily or batch appends (loggers, CHIRPS, forecasts): the days
sent are merged into the existing series by date. Incoming values win on
overlapping days, the series extends in either direction, and any gap days
between the old and new ranges become `null`. `413` if the merged series would
exceed 60 000 days.

`kind` ∈ `SERIES_KINDS` (`packages/engine/src/project.ts`). Max 60 000 values
(~164 years).

## Runs

Running the model is synchronous: the backend loads the project, calls the
engine's `runModel`, stores the outputs, and returns the summary.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/runs` | `{ label? }` | `201 { run }` | editor |
| GET | `/projects/:id/runs` | – | `{ runs: RunMeta[] }` (newest first) | viewer |
| GET | `/projects/:id/runs/:runId` | – | `{ run, series: { nodeId, key, label, unit }[] }` | viewer |
| GET | `/projects/:id/runs/:runId/series?key=…&nodeId=…` | – | `{ startDate, values }` (omit `nodeId` for catchment series) | viewer |
| DELETE | `/projects/:id/runs/:runId` | – | `204` | editor |

- `RunMeta = { id, label, engineVersion, startDate, endDate, createdAt, createdBy }`
- `run = RunMeta & { summary: RunSummary }`
- `summary.curtailment` (engine ≥ 0.3.0) is the b023 [Shortfalls] report:
  per-farm target volume, reduce (−) / gain (+) and total change in m³/day and
  l/s over `settings.reportStart … reportEnd` (ISO dates, `null` = the run's
  own start/end; clipped to the run with a warning). Runs stored by older
  engines have no `curtailment` key. Formulas: [model.md §2.9](./model.md#29-curtailment-targets-shortfalls).

## Compare runs

Compare two runs, from the same project or from two projects you can see (for
example project D copied from C and then modified). See
[run-comparison.md](./run-comparison.md) for how farms and model elements are
matched.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/compare/runs?a=<projectId>:<runId>&b=<projectId>:<runId>` | – | see below | viewer on **both** projects |

```ts
{
  a: { project: { id, name }, run: RunMeta & { summary: RunSummary, inputs: RunInputsSnapshot } },
  b: { … same shape … },
  comparison: RunComparison,    // compareRuns(a.run, b.run) — every delta is b − a
  changes: InputChange[],       // diffInputs(a.run.inputs, b.run.inputs)
  catchmentSeries: { key, label, unit }[]  // catchment series present in both runs, same unit
}
```

- `RunInputsSnapshot`, `RunComparison` and `InputChange` are in
  `packages/engine/src/compare.ts`. `inputs` is the snapshot stored with the run
  (`{ settings, model, series: { [kind]: { startDate, length } } }`). This is the
  only endpoint that returns it.
- `404` when either project isn't visible to you, or the run isn't in the named
  project. It never says which side failed. `400` when `a` or `b` is missing or
  isn't `<projectId>:<runId>`.
- Fetch the daily values to overlay with the per-project
  `GET /projects/:id/runs/:runId/series?key=…` for each side.

## Export

File downloads for checking numbers in Excel and for moving a project between
installations. All are `GET`, **viewer** role, and behave like the other project
routes (`401` signed out, `404` not a member). Responses carry
`Content-Disposition: attachment; filename="<project-slug>_<parts>_<YYYY-MM-DD>.<ext>"`
(ASCII slug, UTC date) and `Cache-Control: no-store`; CORS exposes
`Content-Disposition` so the SPA can read the name when it downloads with
`fetch`.

| Path | Query | Body |
| --- | --- | --- |
| `/projects/:id/runs/:runId/export/daily.csv` | `nodeId?`, `from?`, `to?` | `date` + every daily series of that node (catchment when `nodeId` is omitted), one row per day |
| `/projects/:id/runs/:runId/export/summary.csv` | – | Run details, per-farm summary table, catchment figures, calibration, warnings — blocks separated by a blank record |
| `/projects/:id/series/:seriesId/export.csv` | `from?`, `to?` | `date` + the input series' values |
| `/projects/:id/export.json` | – | The project document (below) |

CSV format: RFC 4180 (CRLF, fields with `,` `"` or line breaks quoted, `"`
doubled), a **UTF-8 BOM** so Excel reads `m³` correctly, ISO `YYYY-MM-DD`
dates, full-precision numbers, and **empty cells for missing days**. Column
headers are `label (unit)`, in the engine's output order. Text cells that start
with `= + - @` get a leading `'` so a spreadsheet never runs them as formulas.
`from`/`to` are inclusive ISO dates, clamped to the series; `400` if they are
not real dates, `from > to`, or the window misses the series entirely.

**Project document** (`export.json`) is the shape `pnpm import:project`
accepts (`ProjectFile` in `backend/src/projects/document.ts`), so a project
round-trips export → import:

```jsonc
{
  "format": "water-management/project", "version": 1,
  "exportedAt": "…", "engineVersion": "0.2.0",   // informational; ignored on import
  "name": "…", "description": "…",
  "settings": { /* stored settings merged over the defaults */ },
  "model": { "nodes": [], "crops": [], "cropAreas": [], "transfers": [] },
  "series": [{ "kind": "rain_catchment_mm", "name": "", "unit": "mm", "startDate": "1981-01-01", "values": [0.4, null] }]
}
```

Runs are not included (re-run after importing, or pass `--run`). The importer
gives every row a fresh id.

**Size cap — 413.** Production serves the API through Lambda's *buffered*
response mode, which fails any response over **6 MB**. Every export body is
built in memory and refused with `413 { error: "export larger than 5 MB — …" }`
once it passes 5 MB, with a hint to narrow the window (`from`/`to`). For scale:
a full Client Catchment node (16 161 days × 13 series) is ≈ 1.5–2 MB and the
catchment table (11 series) is similar, so real catchments fit; a 60 000-day
series is ≈ 1 MB. The durable fix if exports grow (many long series, multi-node
workbooks) is Lambda response streaming (`streamHandle`, 20 MB soft limit) or
writing the file to S3 and returning a pre-signed URL. Gzip is not a clean win
here: a gzipped body is binary, so the Lambda adapter base64-encodes it (+33 %),
and CloudFront's `CachingDisabled` policy on `/api/*` doesn't compress either.

## Health

`GET /health` → `{ ok: true }`.
