# HTTP API

Backend: Hono (`backend/src/app.ts`), dev on `http://localhost:3001`, prod behind
CloudFront at `/api`. All bodies are JSON, except the CSV exports. Shared TypeScript shapes live in
`packages/engine/src/project.ts` — both the backend and the frontend import them.

## Auth

Session = an HS256 JWT in an **httpOnly cookie** `wm_session` (`SameSite=Lax`,
`Secure` in prod, 7-day expiry). The browser sends it with `credentials: 'include'`;
CORS allows the frontend origin with credentials. There is no token in JS-readable
storage.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ email, password, displayName, inviteToken? }` | `201 { user }` + cookie; sends a verification email; `409` address already has an account |
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
- **`logout-everywhere`** is reachable from the frontend header's account menu
  ("Sign out everywhere", next to plain "Sign out"), which asks for
  confirmation before calling it (docs/ui.md § Header).
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

Non-2xx responses are `{ error: string, details?: unknown }`
(`backend/src/http/errors.ts`). `401` = not signed
in; `404` = not found **or** not a member (RLS hides the project — the API never
reveals that a project exists); `403` = member without the needed role (also a
cross-origin form post rejected by the CSRF check, a write RLS refused, or, in
production, a request that didn't come through CloudFront); `400` =
validation (`details` = zod issues), or `{ error: "invalid JSON" }` for a
body that isn't JSON (`backend/src/http/body.ts`); `409` = conflict (duplicate name or email,
already a member, last owner/admin); `413` = request body over 4 MB, a series
over 60 000 days, or an export over 5 MB; `429` = an email was sent to this
address moments ago, or sign-in is locked for this address (with
`Retry-After`). Database errors are mapped to fixed messages and anything
unexpected is `500 { error: "Internal server error" }`; raw database error
text never reaches the client.

## Projects

Roles: `viewer` (read) < `editor` (change model data, run the model) < `owner`
(members, delete, move between teams).

Your effective role is the highest of your direct membership and your team
membership: on a team's projects, a team **admin** is an `owner`, a team
**member** is an `editor` and a team **viewer** is a `viewer`. Direct sharing (`/projects/:id/members`) still works
alongside teams, e.g. to give an outside client `viewer` access.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects` | – | `{ projects: ProjectSummary[] }` (most recently updated first) | – |
| POST | `/projects` | `{ name, description?, teamId? }` | `201 { project }` (`teamId` must be a team where you're a member or admin: `404 team not found` if you're not in it, `403` if you're a team viewer; omit/`null` = personal) | – |
| GET | `/projects/:id` | – | `{ project }` | viewer |
| PATCH | `/projects/:id` | `{ name?, description?, settings?, teamId? }` | `{ project }` | editor (owner when `teamId` is sent) |
| DELETE | `/projects/:id` | – | `204` | owner |
| POST | `/projects/:id/copy` | `{ name }` | `201 { project }` (settings, model + series copied, the model with fresh ids and each EWR rule table's `siteNodeId` moved to its node's new id; runs not; stays in the team only if you're a member or admin of it, otherwise it's personal) | viewer |

- `ProjectSummary = { id, name, description, role, team, createdAt, updatedAt, dataUntil, lastRunAt }`
- `dataUntil` — the last day covered by any of the project's time series
  (`YYYY-MM-DD`: the latest `startDate + length − 1`), or `null` with no data.
  `lastRunAt` — ISO timestamp of the newest run, or `null`. Both come from the
  same query as the list (no per-project calls), for the list's freshness badge.
- `team = { id, name } | null` — `null` for a personal project. `name` is
  `null` when you reach a team's project through direct sharing but aren't in
  the team (team names are visible to members only).
- `PATCH { teamId }` moves the project into a team where you're a member or
  admin (`404 team not found` if you're not in it, `403 requires team member`
  if you're a team viewer) or, with `null`, back to personal. Owner only.
- `project = ProjectSummary & { settings: ProjectSettings }` — settings are
  returned merged over the defaults, so the client always sees every field.
  `PATCH` validates the known fields: e.g. `simulationStart/End` and
  `calibrationStart/End` are `YYYY-MM-DD` or `null`, and
  `calibrationFlowKind` is `flow_observed_m3s | flow_logger_m3s | null`
  (`flow_pitman_m3s` was removed in engine 0.10.0). `dataQuality` (gauge-vs-logger thresholds) takes
  `agreementMinRatio` (0 < r ≤ 1), `agreementMaxRatio` (1–100) and
  `agreementMinDays` (whole days, 1–366); any subset may be sent.
  `runoffModel` picks the rain → natural-flow model: `gr4j` (engine ≥ 0.5.0,
  the default since 0.11.0; model.md §2.4a) or `legacy` (the b023 recession
  model).
  `gr4j` takes `x1` (10–3000 mm), `x2` (−5–3 mm/day), `x3` (1–1000 mm), `x4`
  (0.5–10 days) and `warmupDays` (whole days, 0–3650); any subset may be sent.
  `panCoefficient` is 12 monthly values, each 0–2, in water-year order. That
  0–2 bound is validation only; the engine separately warns (and Settings
  hints, with a preset picker: `PAN_COEFFICIENT_PRESETS`) when a month sits
  outside FAO-56's usual 0.6–0.85 range for a Class A pan (model.md §2.4a).
  `wr2012` (engine ≥ 0.6.0; model.md §2.10c) is the optional WR2012 check:
  `reference` (`null`, the default, or the whole object `{ quaternary` 1–16
  chars, `areaKm2` > 0, `marMm3` ≥ 0 (Mm³ a year), `monthlyMm3` 12 values ≥ 0
  (Mm³ **per month**, Oct … Sep), `periodStart`, `periodEnd` (whole water
  years, start ≤ end), `mapMm` (> 0 or `null`), `source` 1–500 chars `}`),
  `scaling` (`area` | `areaRain`), `lowFlowMonths` (calendar months 1–12, at
  least one, or `null` = from each run), `flags` (the whole `{ notePct,
  queryPct, queryWetterPct, unusablePct }`, each above 0 and at most 1 000 %, note ≤ query ≤
  unusable and wetter ≤ query) and `calibrationPenalty` (`{ enabled, weight,
  marLowMm3, marHighMm3 }`, weight 0–10, `marLowMm3` / `marHighMm3` each
  `null` or a number ≥ 0, already at the modelled catchment's scale — both
  bounds or neither, low ≤ high); any subset of these groups may be sent. The
  reference is also checked for plausibility: with a MAP, the MAR can't
  exceed MAP × area ÷ 1 000 Mm³, and the monthly means must add up to the MAR
  within 5 %; otherwise `400` naming the field.
  `ewrRules` (engine ≥ 0.21.0; model.md §2.9c) is a list, default `[]`, of at
  most 20 Reserve rule tables, one per EWR site: `{ siteNodeId` (`null` = the
  outlet, else a gauge's node id; checked by the run, not here), `source`
  1–500 chars, `component` (`total` | `lowFlow`), `unit` (`mcm` Mm³ per month
  | `m3s` the month's mean flow), `points` (2–20 exceedance %, rising, in
  (0, 100]), `ewr` (12 rows, Oct … Sep, × one value per point, each 0–1e6),
  `naturalSource` (`run` | `table`), `natural` (the same shape, required when
  `naturalSource` is `table`, else `null`), `scale` (above 0, at most 1 000)
  `}`. The engine's own checks run too (`ewrRuleTableIssues`), and two tables
  for one site are a `400`. The list is replaced whole by a `PATCH`.
  A settings `PATCH` merges nested groups (`gr4j`, `dataQuality`, `zeroRainRuns`, `wr2012`,
  `calibration`, `hiLoSplit`) one level deep over what is stored, so sending
  one field of a group keeps the group's other stored fields; top-level
  values, each `wr2012` group and `fitRecord` are replaced whole. Unknown
  keys pass through, and the settings patch is capped at 64 000 characters
  of JSON.
  `chirpsBiasCorrection` is `monthly` (the default: CHIRPS rain that fills in
  for blank catchment rain is scaled by a per-month catchment / CHIRPS factor,
  engine ≥ 0.7.0) or `none` (raw CHIRPS); [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction).
  `zeroRainRuns` (engine ≥ 0.15.0) is `{ mode, keepDry, missing }`:
  `mode` is `missing` (the default: flagged zero-rain runs in the catchment
  rain are treated as blank, so corrected CHIRPS fills them) or `asRecorded`
  (they run dry). `keepDry` and `missing` are period lists shaped and
  validated like `calibrationExclusions` (below): flagged runs kept dry, and
  extra periods treated as missing in either mode. A `PATCH` merges the group
  one level deep, so sending `{ mode }` keeps the stored lists; each list is
  replaced whole. [model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing).
  Engine ≥ 0.20.0 adds three fields for multi-day accumulations:
  `accumulationMode` is `spread` (the default: a detected or listed
  accumulation's recorded total is spread over the days it covers in
  proportion to bias-corrected CHIRPS) or `asRecorded` (each reading stays on
  its day); `keepReadings` (detections confirmed as one day's rain) and
  `addAccumulations` (windows listed by hand, ending on the reading day) are
  period lists validated like the others. An unknown mode or a bad period is
  a `400`. Settings stored before 0.20.0 read back with the defaults merged
  in. [model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations).
  `calibrationExclusions` (at most 100) lists periods left out of every
  calibration score: `{ waterYear, reason }` (a whole water year, Oct–Sep,
  by the year it starts in) or `{ start, end, reason }` (inclusive
  `YYYY-MM-DD`, start ≤ end). `reason` is required (1–500 characters,
  trimmed); an entry without one is a `400`, and so is the same period
  listed twice (overlapping periods are fine). They apply to the run's
  calibration statistics and EWR test on the observed record, and to Fit
  automatically.
  `fitRecord` is the record of the automatic fit whose parameters Apply wrote
  (`FitRecord` in `packages/engine/src/calibrate/provenance.ts`), or `null`:
  `{ fittedAt (ISO timestamp), engineVersion, model, objective, bounds, seed,
  budget, evaluations, cancelled, free, params, startParams, flowKind,
  simulatedKey, calibrationStart, calibrationEnd, exclusions, validate,
  validationRecord, fit, before, splitSample, differential, independentRecord,
  marPenalty, notes, editedParams, forcing, starts, startResults }`, each key
  required except
  `marPenalty` (the WR2012 MAR penalty result — `weight, targetMarMm3,
  marLowMm3, marHighMm3, basis, marRatio, unpenalised`, `null` when it was
  off, the default), `editedParams`, `forcing`, and `starts` (1–10) with
  `startResults` (`{ seed, params, score, best }[]`, one per start) for a
  multi-start fit (absent on a record made before those, i.e. one start), and
  no others. `bounds` is
  `wide` (the default: each parameter's calibration range) or `typical`
  (Perrin et al.'s 80 % range). `forcing` (`{ panCoefficient, apanMm,
  chirpsBiasCorrection, zeroRainRuns }`, `panCoefficient`/`apanMm` each 12
  monthly numbers with the same bounds as the settings fields,
  `chirpsBiasCorrection` optional — `monthly | none`, `zeroRainRuns` optional
  and whole — `{ mode, keepDry, missing }` validated like the setting, plus
  optional `accumulationMode`, `keepReadings`, `addAccumulations` from engine
  0.20.0) is the
  pan coefficient, A-pan evaporation, CHIRPS bias correction mode and
  zero-rain run handling the fit ran under. GR4J's parameters trade off against
  evaporation, so the pan coefficient is never calibrated. The two CHIRPS
  settings change the rain fed to the model on the days CHIRPS fills a gap.
  So a fit is only valid for the forcing it recorded. `forcing` is absent on a
  record made before it was tracked, and `chirpsBiasCorrection` or
  `zeroRainRuns` is absent on a `forcing` made before it was added (and the
  accumulation fields on a `zeroRainRuns` recorded before 0.20.0; they are
  then not compared).
  `fitRecordStatus`'s `forcingChanged` compares it against the current
  settings, tolerant of float noise, and is `false` when there is nothing
  recorded to compare.
  The fit runs in the browser, so the record is what the client reports; the
  seed and engine version let anyone reproduce it. **The server recomputes
  `editedParams` on every `PATCH`** (fitted parameters whose value in the
  saved settings differs from the fit), whatever the client sends, so a hand
  edit after Apply always marks the record.

### Members

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { member }` for a **verified** account; `201 { invited: true, invite }` when no account has the address *or* its account hasn't verified it (see Invites); `409` if already a direct member | owner |
| PATCH | `/projects/:id/members/:userId` | `{ role }` | `{ member }` | owner |
| DELETE | `/projects/:id/members/:userId` | – | `204` (owners remove anyone; anyone may remove themselves) | viewer |

`409 a project must keep at least one owner` when demoting or removing the
last direct owner (including the last owner leaving).

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

A team owns many projects (catchments) together. Team roles: `viewer` <
`member` < `admin`. Admins rename/delete the team and manage its members; on the
team's projects admins are owners, members are editors and viewers are viewers
(see Projects above). A team viewer can't add projects to the team (create,
move or copy into it). `role` in the member and invite bodies is one of
`viewer`, `member`, `admin`; anything else is a `400`.

| Method | Path | Body | Response | Min team role |
| --- | --- | --- | --- | --- |
| GET | `/teams` | – | `{ teams: Team[] }` (teams you're in, by name) | – |
| POST | `/teams` | `{ name }` | `201 { team }` (you become its admin) | – |
| GET | `/teams/:id` | – | `{ team, members: TeamMember[] }` (admins first, then members, then viewers) | viewer |
| PATCH | `/teams/:id` | `{ name }` | `{ team }` | admin |
| DELETE | `/teams/:id` | – | `204` — its projects stay, owned by their direct members (`team` → `null`) | admin |
| POST | `/teams/:id/members` | `{ email, role }` | `201 { member }` for a verified account, or `201 { invited: true, invite }` when no verified account has that email (see Projects § Invites); `409` if already a member | admin |
| PATCH | `/teams/:id/members/:userId` | `{ role }` | `{ member }` | admin |
| DELETE | `/teams/:id/members/:userId` | – | `204` (admins remove anyone; anyone may remove themselves = leave) | viewer |
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

Transfers carry `priority` (integer, lower moves first, engine ≥ 0.16.0);
nodes carry `irrigationEfficiency`, `lossReturnFraction`, `damAreaFullM2`
(nullable), `damAreaExponent` and `damSeepagePerDay`. A body without them
(an older document or tab) is read as migration 006 stored the database.

Other water users (engine ≥ 0.22.0, migration 011, [model.md §2.7c](./model.md#27c-other-water-users-engine--0220-roadmap-wp-133)):
`kind` may be `"user"`, and every node carries `userDemandM3Day` (12 numbers
≥ 0, water-year months, m³/day, or `null`), `userReturnPct` (0–1) and
`userPriority` (`"senior"` | `"junior"`). A body without them gets `null`, 0
and `"senior"`; the engine ignores them on farms and gauges. `PUT` refuses a
crop area or a transfer on a user node.

Land cover (engine ≥ 0.24.0, migration 013, [model.md §2.5a](./model.md)):
`ProjectModel.landCover` is `{ id, nodeId, coverClass, areaKm2, densityPct,
factors: { mar, lowFlow } | null }[]` (classes `eucalyptus`, `pine`,
`invasive`, `invasiveRiparian`, `other`; fractions 0–1). It is part of the
model document (no routes of its own, so the route-auth inventory is
unchanged); a body without it has none; `PUT` refuses a patch on a node that
isn't a farm or doesn't exist. `POST /projects/:id/copy` copies it with fresh
ids.

Boreholes (engine ≥ 0.23.0, migration 012, [model.md §2.7d](./model.md)):
every node carries `boreholeCapacityM3Day` (≥ 0 or `null` = none),
`boreholeRule` (`"supplemental"` | `"primary"` | `"drought"`),
`boreholeTriggerPct` (0–1), `streamDepletionFrac` (0–1) and
`streamDepletionLagDays` (0–36 500). A body without them gets `null`,
`"supplemental"`, 0.3, 0 and 0. `PUT` refuses boreholes on a gauge and the
drought rule on a node without a farm dam.

Validation on `PUT`: ids unique, node and crop names unique (ignoring case),
one crop area per node + crop; every `downstreamNodeId`, crop-area and
transfer reference points at a node/crop in the same document; the network is a
tree (no cycles) with exactly one node whose `downstreamNodeId` is `null`
(the outflow gauge) — unless the model is empty. A failure is
`400 { error: "invalid model", details: string[] }`, one message per problem.

## Time series

Daily series, `values[i]` = value on `startDate + i` days, `null` = missing.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/series` | – | `{ series: SeriesMeta[] }` | viewer |
| GET | `/projects/:id/series/:seriesId` | – | `SeriesMeta & { values }` | viewer |
| PUT | `/projects/:id/series` | `{ kind, name?, unit, startDate, values }` | `SeriesMeta` (upsert on kind+name) | editor |
| POST | `/projects/:id/series/merge` | `{ kind, name?, unit, startDate, values }` | `SeriesMeta` (merge by date; creates the series if missing) | editor |
| DELETE | `/projects/:id/series/:seriesId` | – | `204` | editor |

`SeriesMeta = { id, kind, name, unit, startDate, length, updatedAt }` —
`updatedAt` is when the values last changed (upload or merge), so the UI can
tell there is new data since the last run.

`merge` is for daily or batch appends (loggers, CHIRPS, forecasts): the days
sent are merged into the existing series by date. Incoming values win on
overlapping days, the series extends in either direction, and any gap days
between the old and new ranges become `null`. `413` if the merged series would
exceed 60 000 days.

`kind` ∈ `SERIES_KINDS` (`packages/engine/src/project.ts`): `rain_catchment_mm`,
`rain_chirps_mm`, `rain_forecast_mm`, `flow_observed_m3s`, `flow_logger_m3s`
and `flow_reference_m3s` (`flow_pitman_m3s` was removed in engine 0.10.0). The last is a gauge on a different
river (a regional wet/dry index): runs store it in their input snapshot but
never read it, and it can't be a `calibrationFlowKind`
([model.md §2.10](./model.md#210-calibration-statistics-flow-calibration-cfg)).
The same list applies to the `series` of a project file imported with
`pnpm import:project`. Max 60 000 values (~164 years).

## Runs

Running the model is synchronous: the backend loads the project, calls the
engine's `runModelChecked` (`runModel` plus its self-checks, [model.md § Verification](./model.md#verification)), stores the outputs, and returns the summary.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/runs` | `{ label? }` | `201 { run, removedRunIds }` — `removedRunIds`: older runs deleted by the per-project cap | editor |
| GET | `/projects/:id/model-input` | – | `{ input: ModelInput }`: exactly what a run would use (settings merged over the defaults, the model, the first series of each kind by name), for the in-browser engine (automatic calibration) | viewer |
| GET | `/projects/:id/runs` | – | `{ runs: RunMeta[] }` (newest first) | viewer |
| GET | `/projects/:id/runs/:runId` | – | `{ run: run & { settings }, series: { nodeId, key, label, unit }[] }`; `settings` is the run's own settings snapshot (below) | viewer |
| GET | `/projects/:id/runs/:runId/series?key=…&nodeId=…` | – | `{ startDate, values }` (omit `nodeId` for catchment series) | viewer |
| GET | `/projects/:id/runs/:runId/day?nodeId=…&date=YYYY-MM-DD` | – | One node's every column on one day, for the day trace: `{ date, nodeId, name, kind, previousStorageM3, previousSoilWaterMm, params, columns: { key, label, unit, value }[] }`. `name`, `kind` and `params` (`pctUpstreamToDam`, `pctRunoffToDam`, `divertCapacityM3Day`, `damCapacityM3`, `damInitialPct`, `damMinPct`, `irrigationEfficiency`, `lossReturnFraction`, `damAreaFullM2`, `damAreaExponent`, `damSeepagePerDay`) come from the run's input snapshot (a run from before engine 0.16.0 has its `returnFlowPct` mapped as migration 006 does: e = 1 − r, β = 1, or 1 and 0 when r = 0); `previousStorageM3` is the dam storage at the end of the day before (the initial storage on the run's first day; `null` for a gauge); `previousSoilWaterMm` is the farm's soil-water store at the end of the day before, in mm (0 on the run's first day; `null` for a gauge or a run from before engine 0.14.0, which has no `soil_water` column). `400` for a date that isn't one or is outside the run, `404` for a node the run doesn't have | viewer |
| GET | `/projects/:id/runs/:runId/day?date=YYYY-MM-DD` | – | The same without `nodeId`: the catchment's day, for the runoff-model trace (how rain became natural flow): `{ date, nodeId: null, name: "Catchment", kind: "catchment", runoffModel, areaKm2, params, previousStorageMm, previousStores, columns }`. `columns` are every catchment series (`node_id` NULL) that day; for GR4J they include `rain_used`, `pet`, `aet`, `production_store`, `routing_store`, `uh_store`, `exchange` (only when X2 ≠ 0) and `natural_flow` (m³/day), all depths in mm over the catchment. `runoffModel`, `areaKm2` and `params` (`x1` … `x4`, `warmupDays`) come from the run's `summary.runoff`; `previousStores` is each store at the end of the day before (each `null` on the run's first day, when only their total is recorded) and `previousStorageMm` their total (the storage after the warm-up on the first day), so before + rain + exchange − AET − Q = after closes the day. A run without a runoff balance ran the legacy model: `runoffModel: "legacy"`, `areaKm2`, `params`, `previousStorageMm` and `previousStores` `null`, and the columns are the [Flow data] ones (`rain_used`, `is_summer`, `rain_flow`, `base_flow`, `response_flow`, `resultant_flow`, `natural_flow`). `400` for a bad or out-of-run date | viewer |
| PATCH | `/projects/:id/runs/:runId` | `{ notes }` | `200 { run: RunMeta }` with the new note and its stamp. `notes` is a string, trimmed, at most 4 000 characters, no NUL; `''` clears it. No other field is accepted (`400`), and nothing else about a run can change: the database grants the app `UPDATE` on `model_run.notes` only ([data-model.md § Run notes](./data-model.md)) | editor |
| DELETE | `/projects/:id/runs/:runId` | – | `204`; `409 { error: "this run is or was nominated as evidence, so it is kept" }` for a run the evidence history names | editor |
| GET | `/projects/:id/evidence` | – | `{ nominations: Nomination[] }`, **oldest first**; the last is the current nomination, `[]` when none | viewer |
| POST | `/projects/:id/evidence` | `{ runId, reason }` | `201 { nomination, nominations }`: the new row and the whole history. `reason` is required: trimmed, 1–2 000 characters, no NUL. No other field is accepted (`400`): who, when, the runoff model and the engine version are stamped by the database. `404 run not found` for a run not in this project; `409` for a legacy-model run (workbook comparison only), the run that is already current, or a project at its limit of 50 nominations | editor |

- A run the engine can't make is a `400 { error: "model run failed: …" }`
  with the engine's reason, and nothing is stored: no rainfall series, a
  simulation end before its start, or (engine ≥ 0.11.1) a GR4J run with no
  potential evaporation (A-pan × pan coefficient 0 in every month).
- A project keeps its newest **20** runs (env `RUNS_KEPT_PER_PROJECT`,
  default 20); each new run deletes the oldest beyond that, with their
  outputs. Runs the evidence history names are exempt and don't count
  against the 20.
- `RunMeta = { id, label, engineVersion, startDate, endDate, createdAt, createdBy, legacy, runoffModel, notes, notesUpdatedAt, notesUpdatedBy, evidence }` —
  `legacy` is `settings.runoffModel === 'legacy'` (absent → legacy, for runs
  saved before the setting existed), so the app can badge it without a second
  fetch (audit H1, workbook comparison only — not evidence). `notes` is the
  modeller's written explanation of the run (`''` = none; e.g. why a WR2012
  *query* or *not usable* flag stands), `notesUpdatedAt` / `notesUpdatedBy`
  (display name) when and by whom it last changed (`null` until first
  written). `runoffModel` is the run's `settings.runoffModel` (`gr4j`,
  `legacy`, …; absent → `legacy`). `evidence` is the run's place in the
  evidence history: `'current'` (the project's nominated evidence run),
  `'past'` (nominated before, since replaced) or `null`.
- **Evidence nomination** (010_run_nomination, [data-model.md](./data-model.md)):
  `Nomination = { id, runId, runLabel, runCreatedAt, runoffModel,
  engineVersion, reason, nominatedAt, nominatedBy }`, `nominatedBy` a display
  name. The history is append-only: nominating another run adds a row and
  keeps the earlier ones, and nothing can edit or remove a row. A nominated
  run (current or past) is never trimmed by the run cap and can't be deleted.
- `run = RunMeta & { summary: RunSummary }`
- `GET …/runs/:runId` also returns the run's **settings snapshot** (the
  settings it ran with, from `model_run.inputs`), so the Runs page shows the
  run's own provenance rather than today's settings: `settings.fitRecord` is
  the fit record in effect when it ran, with `editedParams` recomputed at run
  time, and `settings.calibrationExclusions` the exclusions it applied. Runs
  saved before these existed have neither (treat as `null` / `[]`).
- `RunSummary.calibration` (`CalibrationStats`) is scored over
  `settings.calibrationStart`…`calibrationEnd` against
  `settings.calibrationFlowKind`, and carries NSE, PBIAS, RMSE, KGE (r, α, β),
  R², log-NSE, volume error and the per-water-year `annualVolumes` table.
  From engine 0.8.0 it skips `settings.calibrationExclusions` and, when any
  are set, carries `exclusions` (`{ start, end, reason }[]`) and
  `excludedDays` (observed days in the window they removed).
  `RunSummary.ewrCompliance` is the water-year × month EWR grid for the outlet
  and each farm (tens of KB even for a multi-decade, multi-farm run). Both are defined in
  `packages/engine/src/project.ts`; runs saved before engine 0.3.0 lack the
  newer fields, so clients treat them as optional.

- `summary.users` (engine ≥ 0.22.0; only when the network has other water
  users) is `UserSummary[]`: per user its priority and whole-run means of
  demand, taken, deficit, fraction supplied, returned and EWR charge, and the
  days it was charged. `summary.curtailment.otherUsers` has the same users over
  the reporting window with `curtailed` (junior), `supplyCutM3Day` (≤ 0) and
  `uncurtailedChargeM3Day` (the charge a cut doesn't remove; all of it for a
  senior user). User nodes have the run series `demand`, `supplied`,
  `deficit`, `inflow_upstream`, `outflow`, `return_flow`, `ewr_cumulative`,
  `ewr_shortfall` and `ewr_charge`; with a senior user every node also has
  `senior_requirement`, and farms `passed_for_senior`. The day trace's `kind`
  may be `"user"` (`previousStorageM3` null).
- `summary.landCover` (engine ≥ 0.24.0; only with land cover) is
  `{ lowFlowThresholdM3Day, reductionM3Day, fractionOfNatural, byClass:
  { coverClass, condensedKm2, reductionM3Day, mmPerYear }[] }`; farms with
  land cover and the catchment have the run series `landcover_reduction`,
  and water-balance rows gain `landCoverReductionM3`.
  `summary.verification.checks` has a `landCover` check on every run.
- `summary.plausibility` (engine ≥ 0.25.0, [model.md §2.10d](./model.md))
  is `{ drySeason, naturalised, rainSource, flowDoubleMass, lowFlow }`, each
  null when the run lacks what it needs: `drySeason` `{ months, source }`;
  `naturalised` (the calibration record) per water year N, O, A = N − S split
  into dams / land cover / use, O + A, the gap and tolerance and `passed`,
  plus `failedYears`; `rainSource` per water year the station days, rain and
  fallback rain, `fallback`, days not met, the `good` / `fallback` totals and
  a `reserve` split per rule-table site; `flowDoubleMass` the judged years,
  segments and breaks with the simulated slopes, `unexplained` (overall, dry,
  wet) and `hint` (`rain`, `newUse`, `gauge`, `unclear`); `lowFlow` the
  season, `runoffModel`, `points` and `curves` (`source`, `pairedWith`,
  `days`, `flowsM3s`) and the Q90 `comparison`. The checks only report and
  warn; their warnings are in `summary.warnings`.
- Boreholes (engine ≥ 0.23.0): a farm or user with boreholes has
  `avgGroundwaterM3Day` and `avgBaseflowDepletionM3Day` on its summary, the
  run series `groundwater_used`, `baseflow_depletion`, `depletion_unmet` and
  `depletion_store` (m³), and `summary.waterBalance` rows gain
  `groundwaterM3` and `streamDepletionM3`. `summary.verification.checks` has
  a `groundwater` check on every run (it passes trivially without boreholes).
- `summary.curtailment` (engine ≥ 0.3.0) is the b023 [Shortfalls] report:
  per-farm target volume, reduce (−) / gain (+) and total change in m³/day and
  l/s over `settings.reportStart … reportEnd` (ISO dates, `null` = the run's
  own start/end; clipped to the run with a warning). Runs stored by older
  engines have no `curtailment` key. Formulas: [model.md §2.11](./model.md#211-curtailment-targets-shortfalls).
  From engine 0.17.0 (audit Q17) its EWR column `ewrShortfallM3Day` is the
  farm's **EWR charge**: its share of the shortfall at the EWR sites below it
  (the outlet and every gauge), pro rata to its net impact
  ([model.md §2.7b](./model.md#27b-ewr-attribution-who-is-charged-for-a-shortfall-engine--0170-audit-q17)).
  Each farm row adds `ewrChargeIrrigationM3Day` and `ewrChargeStorageM3Day`
  (the charge met by irrigating less, and by storing less / passing inflow;
  they sum to the charge), `ewrSupplyCutM3Day` / `ewrSupplyCutLs` (−ΔG, the
  supply cut that meets the irrigation part) and `ewrBindingSiteId` (the EWR
  site that set most of the charge, `null` when not charged); `totals` adds
  the first three. From 0.17.0 (audit Q13) `totalChangeM3Day` is reduce/gain +
  `ewrSupplyCutM3Day` (the change in supply), `volumeLeftM3Day` is
  `MAX(target + ewrSupplyCutM3Day, 0)`, `fractionOfDemandLeft` is in 0–1, and
  `ewrCutBeyondShareM3Day` (≥ 0, also in `totals`) is how far the EWR supply
  cut exceeds the equitable share. `DEMAND_PCT_FLOOR_M3_DAY` (1 m³/day) and
  `demandPctNote()` are exported by the engine for clients that show demand
  left %. The summary adds `ewrAttribution: 'netImpactProRata'` and
  `ewrSites` (outlet first, then gauges by node id): `{ nodeId, name,
  isOutlet, farmCount, daysNotMet, shortfallM3Day, chargedM3Day,
  naturalM3Day }`, window means ≤ 0 with charged + natural = shortfall.
  `FarmSummary.avgEwrShortfallM3Day` / `daysEwrNotMet` and the farm grids of
  `ewrCompliance` also come from the charge (positive mean; days charged).
  Before 0.17.0 all of these came from the Element sheet's incremental
  shortfall AB, which stays as the diagnostic series
  `ewr_shortfall_incremental` ("reach shortfall"). New run series: per farm
  `ewr_charge` and `ewr_charge_irrigation`; per site `ewr_charged` and
  `ewr_natural` (catchment scope for the outlet, the gauge's node for a
  gauge), all ≤ 0.

- `summary.runoff` (engine ≥ 0.5.0, GR4J runs only) is the runoff model's water
  balance in mm over the catchment: `{ model, params, warmupDays, areaKm2,
  rainMm, petMm, aetMm, flowMm, exchangeMm, storageStartMm, storageEndMm }`,
  with rain − aet − flow + exchange = storageEnd − storageStart. GR4J runs also
  carry the catchment series `pet`, `aet`, `production_store`, `routing_store`,
  `uh_store` (mm), and `exchange` when X2 ≠ 0.
- `summary.wr2012` (engine ≥ 0.6.0; only when the project has a WR2012
  reference) compares simulated **natural** flow with the reference scaled to
  the modelled catchment (`Wr2012Report` in
  `packages/engine/src/reference/wr2012.ts`): `scaling { rule, requested,
  factor, areaFactor, rainFactor, modelAreaKm2, referenceAreaKm2, modelMapMm,
  referenceMapMm }`, `referenceMarMm3`, `scaledMarMm3`, `overlap { years,
  simulatedMarMm3, ratio } | null`, `whole { days, simulatedMarMm3, ratio }`,
  `monthlyBasis`, `months` (12, water-year order: `{ month, simulatedMm3,
  referenceMm3, ratio, lowFlow }`), `lowFlowMonths`, `lowFlowSource`
  (`setting` | `simulated`), `lowFlowRatio`, `patternCorrelation` and `flag {
  level: ok | note | query | unusable, basis, deviationPct, thresholds, text }`.
  A flag's `text` is also in `warnings`. Rules: [model.md §2.10c](./model.md#210c-wr2012-check-engine--060-issue-4-phase-8).
- `summary.ewrAssurance` (engine ≥ 0.21.0; only when the project has a rule
  table) is monthly compliance with the Reserve's assurance rules, one entry
  per EWR site with a table, outlet first then gauges by node id
  (`EwrAssuranceSite` in `packages/engine/src/reserve/assurance.ts`):
  `nodeId` (`null` = outlet), `name`, `isOutlet`, the table's `source`,
  `component`, `unit`, `naturalSource`, `scale` and `points`; `months` (each
  complete calendar month: `{ year, month, waterYear, days, natural,
  percentile, beyond: 'wetter' | 'drier' | null, required, actual, met,
  deficitM3 }`, flows in the table's unit); `byMonth` (12, water-year order:
  `{ month, years, met, rate, deficitM3, meanRequired, meanActual,
  naturalCurve, fdc: [{ point, required, impacted, met }] }`); `overall {
  months, met, rate, deficitM3, longestNotMetRun, meanShortfallPct }`; `fdc {
  cells, met, rate }` and `minYears`. Each site also has the daily series
  `ewr_rule` (m³/day; NaN outside complete months). Rules:
  [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6).
- `summary.dataQuality` (engine ≥ 0.3.1) holds the input checks:
  `observedAgreement` (gauge vs logger per water year, with the thresholds
  used), `seriesChecks` (`{ seriesKind, check: 'negative' | 'outlier' |
  'flatline' | 'zerorun' | 'lowvschirps' | 'doublemass', days, examples: [{ date, value,
  runDays?, endDate? }], text }[]`; `zerorun` and `lowvschirps`, engine ≥ 0.5.2, are the
  catchment-rain checks of issue #2; `doublemass`, engine ≥ 0.18.0, lists
  double-mass breaks against CHIRPS, one example per break: the next
  segment's first and last day, its slope ÷ the one before, its shared days),
  `areaMismatches` (`{ nodeId, name, areaKm2, hiLoKm2, difference }[]`, farms
  whose area is more than 1 % off high + low MAP area) and `doubleMass`
  (engine ≥ 0.18.0; `null` without both rain series or with fewer than 10
  judged water years): `{ years: [{ waterYear, days, catchmentMm, chirpsMm,
  ratio, cumChirpsMm, cumCatchmentMm, residualPct }], skippedYears,
  wholeSlope, segments: [{ fromWaterYear, toWaterYear, years, days, slope }],
  breaks: [{ afterWaterYear, slopeBefore, slopeAfter, change, pettittP,
  bicGain }] }`. The last three are absent on older runs. Each check also appears in `warnings`. Rules:
  [model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree).
- `summary.verification` (engine ≥ 0.12.0) is the engine's self-checks on the
  run ([model.md § Verification](./model.md#verification)):
  `{ passed, checks: { id, label, passed, detail }[], maxResidual: { valueM3Day, nodeId, name, date } | null }`,
  with `id` one of `balance`, `workings`, `soilWater` (engine ≥ 0.14.0), `runoff`, `transfers`, `reports`, and
  `detail` the first broken property (farm names and dates) or `null`.
- `summary.waterBalance` (engine ≥ 0.12.0) is `{ areaKm2, years: WaterBalanceRow[], total: WaterBalanceRow }`,
  one row per water year (Oct–Sep, `waterYear` = its start year) and one for
  the run (`waterYear: null`): `rainMm`, `naturalFlowMm`, `runoffCoefficient`,
  `runoff` (GR4J store balance: `aetMm`, `exchangeMm`, `storageChangeMm`,
  `residualMm`; `null` for legacy), and in m³ `naturalFlowM3`, `farmRunoffM3`,
  `openingStorageM3`, `demandM3`, `suppliedM3`, `returnFlowM3`,
  `consumptiveUseM3`, `transfersM3`, `spillM3`, `outflowM3`,
  `closingStorageM3`, `residualM3` (opening + runoff + transfers − consumptive
  use − outflow − closing; float noise).
- `summary.chirpsCorrection` (engine ≥ 0.7.0) is the CHIRPS fallback bias
  correction, `null` when the project has no CHIRPS series: `{ mode, minDays,
  minMm, clampMin, clampMax, pooled: { days, catchmentMm, chirpsMm, ownFactor,
  factor, clamped }, excludedWaterYears, months: [{ month, days, catchmentMm,
  chirpsMm, ownFactor, factor, source: 'month' | 'pooled' | null, clamped,
  fallbackDays }] (calendar months 1–12), fallbackDays, correctedDays,
  fallbackRawMm, fallbackCorrectedMm }`. Engine ≥ 0.18.0 adds why years and
  days were left out of the fit: `lowVsChirpsYears`, `doubtfulKeepDry: [{
  start, end, days, chirpsMm, limitMm, waterYears }]` (kept-dry runs CHIRPS
  contradicts; their years are in `excludedWaterYears`), `flaggedDaysLeftOut`,
  `missingDaysLeftOut` and `keptDryDaysInFit`; all absent on older runs.
  Engine ≥ 0.20.0 adds `accumulationDaysLeftOut` (multi-day accumulation
  window days left out one by one). A
  run that corrected any day also lists the factors in `warnings`, and a
  doubted keep-dry adds its own warning. Rules: [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction).
- `summary.zeroRainInfill` (engine ≥ 0.15.0) is the catchment rain the run
  treated as missing, `null` when the project has no catchment rain series:
  `{ mode, periods: [{ start, end, source: 'flagged' | 'listed', reason,
  days, recordedMm, filledMm, unfilledDays }], keptDry: [{ start, end,
  reason, days }], asRecordedDays, days, recordedMm, filledMm, unfilledDays }`.
  The catchment series `rain_catchment_missing` is 1 on each day set aside.
  Rules: [model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing).
- `summary.rainAccumulation` (engine ≥ 0.20.0) is what the run did with
  multi-day accumulations in the catchment rain, `null` when the project has
  no catchment rain series, absent on older runs: `{ mode, criteria: { minMm,
  minRunDays, maxRunDays, readingDayShare, runShare }, windows: [{ start, end,
  source: 'detected' | 'listed', reason, status: 'spread' | 'noChirps' |
  'asRecorded' | 'kept' | 'noReading', keptReason, totalMm, readingMm,
  runDays, nearChirpsMm, runChirpsMm, chirpsMm, daysInRun, usedMm }], skipped:
  string[], spreadWindows, spreadDays, spreadMm }`. The detection figures
  (`runDays`, `nearChirpsMm`, `runChirpsMm`) are `null` for a listed window,
  and `chirpsMm` for a window not spread. The catchment series
  `rain_catchment_spread` is 1 on each day whose rain came from a window.
  Rules: [model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations).

### Uncertainty bands

Engine ≥ 0.26.0, migration 014, [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9).
The ensemble runs in the browser (hundreds of model runs, the calibration
worker); the server resolves its options, the database draws the seed, and
the result is stored only after the server has checked it.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/model-input` | – | `{ input: ModelInput }`: the run's own input (its settings and model snapshot, with the project's series). `409` when a series changed since the run (only hashes of the values are stored with a run), with the kinds | viewer |
| GET | `/projects/:id/runs/:runId/uncertainty` | – | `{ ensembles: Ensemble[] }`, newest first, **every** ensemble started for the run (abandoned starts included), without `result` | viewer |
| GET | `/projects/:id/runs/:runId/uncertainty/:uid` | – | `{ ensemble: Ensemble & { result } }`: `result` = `{ engineVersion, header, members, coverage }` (an ensemble) or `{ engineVersion, header, members: { index, metrics }[] }` (paired) | viewer |
| POST | `/projects/:id/runs/:runId/uncertainty` | `{ request: { members?, bounds?, free?, panOffset?, rainSources?, records?, thresholds?: { objective?, minSkill?, wr2012MaxLevel?, maxLowFlowBiasPct? } } }` or `{ baselineId }` | `201 { ensemble, notes }`, status `started`: the resolved options (`ResolvedEnsembleOptions`, the model is the run's own) with the seed the database drew. `baselineId` (a complete ensemble of **another** run of this project, same runoff model and period) starts a paired band: its options and seed are the baseline's. `400` with the engine's reason for options the run can't use (fewer than 30 members, a rain source it lacks, no observed record, two models, two periods); `409` from `model-input`, or at 50 ensembles for the run | editor |
| POST | `/projects/:id/runs/:runId/uncertainty/:uid/result` | `{ members: MemberResult[], coverage: RecordCoverage[] }`, or for a paired row `{ members: { index, metrics }[] }` | `200 { ensemble }`, status `complete`, with the `summary` the server built. `422 { error: "the posted ensemble does not reproduce", details }` when the sample isn't the one the seed and options generate, or member 0 or one of the members the server re-runs (three, picked at random) differs; `403` for anyone but whoever started it; `409` when already stored (a row completes once) or started on another engine version | editor |

- `Ensemble = { id, runId, baselineId, baselineRunId, runoffModel, engineVersion, method, seed, members, options, status, accepted, summary, createdAt, createdBy, createdById, completedAt }`.
  `summary` is `EnsembleSummary` (`total`, `accepted`, `gated`,
  `referenceAccepted`, `rejected` by reason, `bands`, `coverage`,
  `coverageWarning`, `decisionRule`, `notes`) or, for a paired row,
  `PairedSummary` (difference bands, `ewrDaysNotMetWorse`, `shortfallWorse`,
  `unpaired`, `decisionRule`); `null` until complete. A band is
  `{ n, p5, p50, p95, min, max }`, the percentiles `null` below 30 members.
- Nothing about a stored ensemble can change and none can be deleted
  ([data-model.md](./data-model.md), "Uncertainty bands").

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
  only endpoint that returns it. The snapshot's settings include `wr2012`, so
  every WR2012 input appears in `changes`, and `comparison.wr2012` (`null` when
  neither run has the check) holds the deltas of `marRatioOverlap`,
  `marRatioWhole`, `lowFlowRatio` and `patternCorrelation`.
  `comparison.chirpsFit` (`null` when neither run fitted CHIRPS factors) is
  `{ pooledFactor: MetricDelta, excludedWaterYearsA, excludedWaterYearsB,
  changed }`: `changed` when any month's applied factor or the water years
  left out of the fit differ ([model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
- Each side's `run` carries its `notes` (and `notesUpdatedAt` / `notesUpdatedBy`),
  so the modeller's explanation of each run is shown next to the comparison.
- Each side's `run.evidence` is its place in its own project's evidence
  history, `null` when never nominated: `{ status: 'current' | 'past',
  nominatedAt, nominatedBy, reason, replacedBy: { runId, runLabel,
  nominatedAt, nominatedBy, reason } | null }`. The fields are this run's
  latest nomination; `replacedBy` is the nomination that came after it.
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
`fetch`. `daily.csv` and `summary.csv` for a **legacy-runoff-model run** (audit
H1) start with a leading comment line,
`# runoff_model=legacy; workbook comparison only; not evidence (audit H1)`,
ahead of the usual header row.

| Path | Query | Body |
| --- | --- | --- |
| `/projects/:id/runs/:runId/export/daily.csv` | `nodeId?`, `from?`, `to?` | `date` + every daily series of that node (catchment when `nodeId` is omitted), one row per day. Catchment columns follow `CATCHMENT_ORDER` in `backend/src/export/run-tables.ts`: … rain used, final catchment rainfall, CHIRPS as uploaded, bias-corrected CHIRPS, the day's CHIRPS factor, … A farm's columns follow the FarmTemplate letters (`FARM_COLUMNS` in `packages/engine/src/verify/columns.ts`): gross demand, effective rain used, the soil-water store (mm, engine ≥ 0.14.0), F (crop requirement), D (abstraction demand, engine ≥ 0.16.0), G, H, I, J, K … O, the dam's area, rain on it, evaporation and seepage (engine ≥ 0.16.0), P, Q, R, S, T, U, the balance check V, W, Y … AB (AB is the reach shortfall, a diagnostic from engine 0.17.0), then `ewr_charge` and `ewr_charge_irrigation` (engine ≥ 0.17.0), the letter in brackets in each header (`Irrigation supplied [G] (m³/day)`); a gauge's use the GaugeTemplate letters. Runs before engine 0.12.0 have no working columns (K–P, S, T, V, gross demand, effective rain) |
| `/projects/:id/runs/:runId/export/summary.csv` | – | Run details (ending with `Run notes`, the run's written explanation, empty when there is none, `Notes last changed` with the time and name when there is one, and the evidence nomination: `Evidence nomination` = `the nominated evidence run` / `nominated before, since replaced` / `not nominated`, then `Nominated,<time>,<name>,<reason>` and, for a replaced run, `Replaced by,<run label>,<time>,<name>,<reason>`), the self-checks (each check passed/FAILED with its first problem, and the largest daily balance check), per-farm summary table, catchment figures, the water balance per water year and for the whole run, the curtailment table over the reporting window (every column unrounded, with a row naming the EWR attribution rule, engine ≥ 0.17.0: the EWR charge, its irrigation and storage parts, the supply cut and the EWR site setting it, then `demand_pct_note` — `no_demand`, `below_floor` for demand under 1 m³/day, or empty — and the EWR cut beyond the equitable share; the equitable share is labelled a fairness benchmark, `Above (−) / below (+) equitable share` instead of reduce/gain, and the table ends with the fixed footnote `EQUITABLE_SHARE_FOOTNOTE`, "… Not an allocation or licence condition.", audit Q11), the land-cover reductions (engine ≥ 0.24.0, only with land cover: the low-flow threshold, the mean and its share of natural flow, per class the condensed area, reduction and mm/yr), the other water users (engine ≥ 0.22.0, only when the run has any: whole-run means, then the reporting window's EWR charge, whether each is curtailed and its supply cut), the EWR sites (days not met, shortfall, charged to farms, natural), Reserve compliance by month (engine ≥ 0.21.0; `Not assessed: …` without a rule table; otherwise per site the table's source, coverage, unit, natural-percentile source, scale and % points, months met, deficit, longest run not met, mean shortfall, the FDC check, a row per month of the year and a row per complete month with its natural flow, condition, requirement, simulated flow and deficit), the 12 CHIRPS bias factors (month, factor, source, shared days) and what the fit left out, the catchment rain treated as missing, the double-mass check against CHIRPS (engine ≥ 0.17.0: slope, segments, breaks, one row per water year), the plausibility checks (engine ≥ 0.25.0, `Run made before engine 0.25.0: …` on older runs: the dry season; natural vs observed + net abstraction per water year with the dams / land cover / use split, gap, tolerance and pass; EWR days not met for good-rain and fallback-rain years, the Reserve months met by the same split, one row per water year with its station days and fallback rain; the double-mass check of observed flow against rain with segments, breaks, the simulated slopes, the change beyond the model overall and by season and what it points to; the dry-season low-flow duration curves in m³/s at Q1 … Q99 with the Q90 comparison; each part says `Not checked: …` when the run lacks what it needs), calibration, the WR2012 check (`Not checked: …` when the run's settings had no reference; otherwise the quaternary, source, reference period, scaling rule and factors, WR2012 MAR and scaled MAR, the simulated natural MAR and ratio over the overlapping years and the whole run, the 12 monthly means in water-year order with ratio and dry-season mark, the dry-season ratio, the pattern correlation, the flag with its basis, deviation and thresholds, and for a *query* or *not usable* flag whether the run has a written explanation), a column guide (each farm daily column's letter, series key and formula), warnings — blocks separated by a blank record. A run before engine 0.12.0 says it has no self-checks or water balance. Shares are **percentages** (0–100): `Demand supplied (%)` per farm and `Days EWR not met at the outflow gauge (%)`, where the JSON `RunSummary` has fractions (`fractionSupplied`, `ewrFractionDaysNotMet`, 0–1) |
| `/projects/:id/series/:seriesId/export.csv` | `from?`, `to?` | `date` + the input series' values |
| `/projects/:id/export.json` | – | The project document (below) |

CSV format: RFC 4180 (CRLF, fields with `,` `"` or line breaks quoted, `"`
doubled), a **UTF-8 BOM** so Excel reads `m³` correctly, ISO `YYYY-MM-DD`
dates, full-precision numbers, and **empty cells for missing days**. Column
headers are `label (unit)` (a node's: `label [letter] (unit)`), in the engine's output order. Text cells that start
with `= + - @`, a tab or a CR get a leading `'` so a spreadsheet never runs them as formulas.
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
  "series": [{ "kind": "rain_catchment_mm", "name": "", "unit": "mm", "startDate": "2001-10-01", "values": [0.4, null] }]
}
```

Runs are not included (re-run after importing, or pass `--run`). The importer
gives every row a fresh id.

**Size cap — 413.** Production serves the API through Lambda's *buffered*
response mode, which fails any response over **6 MB**. Every export body is
built in memory and refused with `413 { error: "export larger than 5 MB — …" }`
once it passes 5 MB, with a hint to narrow the window (`from`/`to`). For scale:
a full node over a multi-decade record is well under the cap, and so is the
catchment table, so real catchments fit; a 60 000-day
series is ≈ 1 MB. The durable fix if exports grow (many long series, multi-node
workbooks) is Lambda response streaming (`streamHandle`, 20 MB soft limit) or
writing the file to S3 and returning a pre-signed URL. Gzip is not a clean win
here: a gzipped body is binary, so the Lambda adapter base64-encodes it (+33 %),
and CloudFront's `CachingDisabled` policy on `/api/*` doesn't compress either.

## Health

`GET /health` → `{ ok: true }`.
