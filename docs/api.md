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
| POST | `/auth/register` | `{ email, password, displayName, inviteToken? }` | `201 { user }` + cookie; sends a verification email |
| POST | `/auth/login` | `{ email, password }` | `200 { user }` + cookie; `401` wrong email or password; `429` + `Retry-After` while the address is locked |
| POST | `/auth/logout` | – | `204`, clears cookie |
| POST | `/auth/logout-everywhere` | – | `204`, clears cookie and revokes **every** session of the account, on every device (signed in) |
| GET | `/auth/me` | – | `200 { user }` or `401` |
| POST | `/auth/forgot-password` | `{ email }` | **always** `202 { ok: true }` (public) |
| POST | `/auth/reset-password` | `{ token, password }` | `204`, clears cookie; `400` bad/expired/used link (public) |
| POST | `/auth/verify-email` | `{ token }` | `200 { verified: true }`; `400` bad/expired/used link (public) |
| POST | `/auth/resend-verification` | – | `202 { sent: true }`; `409` already verified; `429` sent < 1 min ago (signed in) |
| POST | `/auth/invite-info` | `{ token }` | `200 { invite: { email, projectName, teamName, invitedBy } }`; `404` bad/expired (public) |

`user = { id, email, displayName, emailVerified }`. Passwords: 8–200 chars.

**Email links.** Tokens are 32 random bytes (43 base64url chars), single-use,
stored only as SHA-256 hashes. Links point at `SITE_URL`:

| Email | Link | Lifetime |
| --- | --- | --- |
| Confirm your email | `/verify-email?token=…` | 48 h |
| Reset your password | `/reset-password?token=…` | 1 h |
| Invitation | `/register?invite=…` (no account yet) or `/verify-email?token=…` (unverified account) | 7 days (invite) / 48 h (verify link) |

- **`login` lockout:** the 5th attempt in a row without the right password
  locks that address for 1 minute, doubling with each further attempt up to 15
  minutes; a correct password or a password reset clears it. Addresses without
  an account lock the same way, so a `429` says nothing about whether the
  account exists ([security.md § Authentication](./security.md#authentication)).
- **Sign-up** sends a verification email. Signing in doesn't require a
  verified address; the UI shows a banner until it is.
- **`forgot-password`** answers the same `202` whether or not the address has
  an account, and sends at most one email per address per minute (later
  requests inside the window get `202` and no email). Requesting again replaces
  the previous link.
- **`reset-password`** sets the new password, also marks the address verified
  (the link proved the inbox), and **signs out every existing session**
  (`app_user.sessions_revoked_at`; any session issued before it gets `401`).
  Sign in again afterwards.
- **`verify-email`** marks the address verified and turns every pending invite
  for it into a membership. It needs no session: the token is the credential,
  so a link opened on another device works signed out.
- **`register` with `inviteToken`** (from `/register?invite=…`): if the token is
  a live invite for *the same address*, the account starts verified and joins
  the invited projects/teams immediately, with no verification email.
  Otherwise the token is ignored and sign-up proceeds normally.
- **Opening `/register?invite=…` while signed in** (frontend only; the other
  sign-in pages send a signed-in user on to the app): the page looks the invite
  up and explains it. An invite for another address offers *Sign out and
  accept as …* (the sign-up form then takes over with the address locked) or
  staying signed in. An invite for the signed-in address says the user joins
  once the address is confirmed (with a resend button), or should already have
  access if it is. A dead link says so. There is no "accept while signed in"
  endpoint: invites are claimed by `verify-email` or by `register`.

## Errors

Non-2xx responses are `{ error: string, details?: unknown }`. `401` = not signed
in; `404` = not found **or** not a member (RLS hides the project — the API never
reveals that a project exists); `403` = member without the needed role; `400` =
validation (`details` = zod issues); `409` = conflict (duplicate name, last owner);
`429` = an email was sent to this address moments ago, or sign-in is locked
for this address (with `Retry-After`).

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

- `ProjectSummary = { id, name, description, role, team, createdAt, updatedAt, dataUntil, lastRunAt }`
- `dataUntil` — the last day covered by any of the project's time series
  (`YYYY-MM-DD`: the latest `startDate + length − 1`), or `null` with no data.
  `lastRunAt` — ISO timestamp of the newest run, or `null`. Both come from the
  same query as the list (no per-project calls), for the list's freshness badge.
- `team = { id, name } | null` — `null` for a personal project. `name` is
  `null` when you reach a team's project through direct sharing but aren't in
  the team (team names are visible to members only).
- `PATCH { teamId }` moves the project into a team you belong to (`404 team not
  found` otherwise) or, with `null`, back to personal. Owner only.
- `project = ProjectSummary & { settings: ProjectSettings }` — settings are
  returned merged over the defaults, so the client always sees every field.
  `PATCH` validates the known fields: e.g. `simulationStart/End` and
  `calibrationStart/End` are `YYYY-MM-DD` or `null`, and
  `calibrationFlowKind` is `flow_observed_m3s | flow_logger_m3s |
  flow_pitman_m3s | null`. `dataQuality` (gauge-vs-logger thresholds) takes
  `agreementMinRatio` (0 < r ≤ 1), `agreementMaxRatio` (1–100) and
  `agreementMinDays` (whole days, 1–366); any subset may be sent.

### Members

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { member }` for a **verified** account; `201 { invited: true, invite }` when no account has the address *or* its account hasn't verified it (see Invites) | owner |
| PATCH | `/projects/:id/members/:userId` | `{ role }` | `{ member }` | owner |
| DELETE | `/projects/:id/members/:userId` | – | `204` (owners remove anyone; anyone may remove themselves) | – |

These are **direct** members only. People who reach a team project through the
team are listed by `GET /teams/:id`, not here.

### Invites

Adding an address that has no **verified** account creates a **pending
invite**; the response is the same whether or not an account exists. The
email depends on the case:

- **No account:** a sign-up link (`/register?invite=…`, valid 7 days).
- **An account that never verified the address** (it can't sign up again): a
  confirm-your-email link for that account (`/verify-email?token=…`, 48 h),
  with a note to use "Forgot password" instead if they never created the
  account (someone else registered their address). No email if a
  verification link went out in the last minute — that link accepts the
  invite too.

The invite becomes a membership with the invited role once that address is
**verified** — by signing up through the link, by the verification email, or
by a password reset. An unverified account alone never claims invites, so
pre-registering a colleague's address doesn't get you added in their place.
Re-adding the same address updates the role; the email is re-sent (with a
fresh link, the old one stops working) unless one went out in the last minute.
Adding an address whose account *is* verified makes it a member directly and
clears its invite.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/invites` | – | `{ invites: Invite[] }` (newest first, expired ones included) | owner |
| DELETE | `/projects/:id/invites/:inviteId` | – | `204` (revoke; the link stops working) | owner |

- `Invite = { id, email, role, invitedBy, createdAt, expiresAt, expired }` —
  `invitedBy` is the display name of whoever last sent it.

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
| POST | `/teams/:id/members` | `{ email, role }` | `201 { member }` for a verified account, or `201 { invited: true, invite }` when no verified account has that email (see Projects § Invites); `409` if already a member | admin |
| PATCH | `/teams/:id/members/:userId` | `{ role }` | `{ member }` | admin |
| DELETE | `/teams/:id/members/:userId` | – | `204` (admins remove anyone; anyone may remove themselves = leave) | member |
| GET | `/teams/:id/invites` | – | `{ invites: Invite[] }` | admin |
| DELETE | `/teams/:id/invites/:inviteId` | – | `204` | admin |

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
| POST | `/projects/:id/runs` | `{ label? }` | `201 { run, removedRunIds }` — `removedRunIds`: older runs deleted by the per-project cap | editor |
| GET | `/projects/:id/runs` | – | `{ runs: RunMeta[] }` (newest first) | viewer |
| GET | `/projects/:id/runs/:runId` | – | `{ run, series: { nodeId, key, label, unit }[] }` | viewer |
| GET | `/projects/:id/runs/:runId/series?key=…&nodeId=…` | – | `{ startDate, values }` (omit `nodeId` for catchment series) | viewer |
| DELETE | `/projects/:id/runs/:runId` | – | `204` | editor |

- A project keeps its newest **20** runs (`RUNS_KEPT_PER_PROJECT`); each new
  run deletes the oldest beyond that, with their outputs.
- `RunMeta = { id, label, engineVersion, startDate, endDate, createdAt, createdBy }`
- `run = RunMeta & { summary: RunSummary }`
- `RunSummary.calibration` (`CalibrationStats`) is scored over
  `settings.calibrationStart`…`calibrationEnd` against
  `settings.calibrationFlowKind`, and carries NSE, PBIAS, RMSE, KGE (r, α, β),
  R², log-NSE, volume error and the per-water-year `annualVolumes` table.
  `RunSummary.ewrCompliance` is the water-year × month EWR grid for the outlet
  and each farm (~40 KB for 44 years × 12 farms). Both are defined in
  `packages/engine/src/project.ts`; runs saved before engine 0.3.0 lack the
  newer fields, so clients treat them as optional.

- `summary.curtailment` (engine ≥ 0.3.0) is the b023 [Shortfalls] report:
  per-farm target volume, reduce (−) / gain (+) and total change in m³/day and
  l/s over `settings.reportStart … reportEnd` (ISO dates, `null` = the run's
  own start/end; clipped to the run with a warning). Runs stored by older
  engines have no `curtailment` key. Formulas: [model.md §2.11](./model.md#211-curtailment-targets-shortfalls).

- `summary.dataQuality` (engine ≥ 0.3.1) holds the input checks:
  `observedAgreement` (gauge vs logger per water year, with the thresholds
  used), `seriesChecks` (`{ seriesKind, check: 'negative' | 'outlier' |
  'flatline', days, examples: [{ date, value, runDays? }], text }[]`) and
  `areaMismatches` (`{ nodeId, name, areaKm2, hiLoKm2, difference }[]`, farms
  whose area is more than 1 % off high + low MAP area). The last two are absent
  on older runs. Each check also appears in `warnings`. Rules:
  [model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree).

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
  (`{ settings, model, series: { [kind]: { startDate, length, valuesSha256? } } }`;
  `valuesSha256` = SHA-256 hex of the values' JSON, absent on older runs). This is the
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
| `/projects/:id/runs/:runId/export/summary.csv` | – | Run details, per-farm summary table, catchment figures, calibration, warnings — blocks separated by a blank record. Shares are **percentages** (0–100): `Demand supplied (%)` per farm and `Days EWR not met at the outflow gauge (%)`, where the JSON `RunSummary` has fractions (`fractionSupplied`, `ewrFractionDaysNotMet`, 0–1) |
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
a full client catchment node (16 161 days × 13 series) is ≈ 1.5–2 MB and the
catchment table (11 series) is similar, so real catchments fit; a 60 000-day
series is ≈ 1 MB. The durable fix if exports grow (many long series, multi-node
workbooks) is Lambda response streaming (`streamHandle`, 20 MB soft limit) or
writing the file to S3 and returning a pre-signed URL. Gzip is not a clean win
here: a gzipped body is binary, so the Lambda adapter base64-encodes it (+33 %),
and CloudFront's `CachingDisabled` policy on `/api/*` doesn't compress either.

## Health

`GET /health` → `{ ok: true }`.
