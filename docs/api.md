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
(members, delete).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects` | – | `{ projects: ProjectSummary[] }` | – |
| POST | `/projects` | `{ name, description? }` | `201 { project }` | – |
| GET | `/projects/:id` | – | `{ project }` | viewer |
| PATCH | `/projects/:id` | `{ name?, description?, settings? }` | `{ project }` | editor |
| DELETE | `/projects/:id` | – | `204` | owner |
| POST | `/projects/:id/copy` | `{ name }` | `201 { project }` (model + series copied; runs not) | viewer |

- `ProjectSummary = { id, name, description, role, createdAt, updatedAt }`
- `project = ProjectSummary & { settings: ProjectSettings }` — settings are
  returned merged over the defaults, so the client always sees every field.

### Members

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { member }` — user must already have an account | owner |
| PATCH | `/projects/:id/members/:userId` | `{ role }` | `{ member }` | owner |
| DELETE | `/projects/:id/members/:userId` | – | `204` (owners remove anyone; anyone may remove themselves) | – |

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
| DELETE | `/projects/:id/series/:seriesId` | – | `204` | editor |

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

## Health

`GET /health` → `{ ok: true }`.
