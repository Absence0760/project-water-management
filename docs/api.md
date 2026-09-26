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
| POST | `/auth/register` | `{ email, password, displayName, inviteToken?, locale? }` | `201 { user }` + cookie; sends a verification email; `409` address already has an account |
| POST | `/auth/login` | `{ email, password }` | `200 { user }` + cookie; `401` wrong email or password; `429` + `Retry-After` while the address is locked |
| POST | `/auth/logout` | – | `204`, clears cookie |
| POST | `/auth/logout-everywhere` | – | `204`, clears cookie and revokes **every** session of the account, on every device (signed in) |
| GET | `/auth/me` | – | `200 { user }` or `401` |
| PATCH | `/auth/me` | `{ displayName?, locale?, volumeUnit? }` | `200 { user }`; `400` a blank or over-100-character name, an unknown `locale` or `volumeUnit`, or nothing to change (signed in) |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | `200 { user }` + a fresh cookie for this device; revokes **every other** session; `403` wrong current password; `429` + `Retry-After` while the address is locked; `400` new password not 8–200 characters (signed in) |
| POST | `/auth/forgot-password` | `{ email }` | **always** `202 { ok: true }` (public) |
| POST | `/auth/reset-password` | `{ token, password }` | `204`, clears cookie; `400` bad/expired/used link (public) |
| POST | `/auth/verify-email` | `{ token }` | `200 { verified: true }`; `400` bad/expired/used link (public) |
| POST | `/auth/resend-verification` | – | `202 { sent: true }`; `409` already verified; `429` sent < 1 min ago (signed in) |
| POST | `/auth/invite-info` | `{ token }` | `200 { invite: { email, projectName, teamName, invitedBy } }`; `404` bad/expired (public) |
| POST | `/auth/render-session` | `{ token }` | `200 { ok: true }` + a **render session** cookie; `400` bad/expired/used token; `403` the requester can no longer see the project or the run (public: the headless report renderer's sign-in, [§ Reports](#reports)) |

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
- **`change-password`** (the Account page, WP-1.9) checks the current
  password through the **same lockout as `login`**: each attempt counts
  against the account's address before the bcrypt check, a wrong current
  password (`403`) is a failed attempt, and while the address is locked it
  answers `429` without checking. On success it sets the new password, moves
  `app_user.sessions_revoked_at` to now (every existing session, this
  device's old cookie included, gets `401` on its next request), deletes any
  outstanding reset link, clears the lockout count, and sets a fresh cookie
  so this device stays signed in. A body that fails validation (`400`) is
  refused before anything is counted.
- **`user`** is `{ id, email, displayName, emailVerified, locale, volumeUnit }`.
  `locale` is `'en' | 'af' | null` (`app_user.locale`, 050_user_locale.sql,
  WP-2.5): the language of the farmer-facing pages and of the emails the
  account receives; `null` means not chosen (the site follows the browser,
  emails are English). `volumeUnit` is `'m3' | 'ML'` (default `'m3'`), how
  the farm view shows volumes.
- **`PATCH /auth/me`** changes only the fields sent: `displayName` (trimmed,
  1–100 characters), `locale` (`'en'`, `'af'`, or `null` to go back to
  following the browser) and `volumeUnit` (`'m3'` or `'ML'`). At least one
  is required. The email address isn't editable; other keys are ignored.
- **`register`** takes an optional `locale` (the language the sign-up page
  was in). Without one, an account that accepts an invite takes the invite's
  `locale` (`app_accept_invites`, 050); a chosen locale is never overwritten.
  The verification, reset and farmer-invite emails go out in the account's
  (or the invite's) language, English where the Afrikaans isn't reviewed yet
  ([ui.md § Language](./ui.md#language)).
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
already a member, last owner/admin); `413` = request body over 4 MB (5 MB
for `POST /projects/import`), a series over 60 000 days, or an export over 5 MB; `429` = an email was sent to this
address moments ago, or sign-in is locked for this address (with
`Retry-After`). Database errors are mapped to fixed messages and anything
unexpected is `500 { error: "Internal server error" }`; raw database error
text never reaches the client.

**Farmers** (role `farmer`, WP-2.1) get `403` from every `/projects/:id`
route except leaving (`DELETE /projects/:id/members/:self`); `GET /projects`
lists their projects with `role: "farmer"`, `dataUntil: null` and
`lastRunAt: null`, and the current publication's `publishedAt` (which every
member reads). Their own farm routes come with WP-2.6.

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
| DELETE | `/projects/:id` | – | `204`; `409 { error, details: { evidenceRun: { id, label } \| null, nominations } }` for a project that has nominated an evidence run, current or since replaced: the project is kept with its evidence run and nomination history for good (issue #43, [data-model.md](./data-model.md) § Evidence nomination). The error names the current evidence run and says a nomination can be replaced but not withdrawn; `evidenceRun` is `null` only when a nomination landed during the request (the database trigger refused it) | owner |
| POST | `/projects/import` | a project document (`ProjectFile`); query `teamId?`, `run=1?` | `201 { project, runId?, runError? }` (below) | – |
| POST | `/projects/:id/copy` | `{ name }` | `201 { project }` (settings, model + series copied, the model with fresh ids in the same id order (so the copy runs exactly as the original) and each EWR rule table's `siteNodeId` moved to its node's new id; runs and notes not ([why](./data-model.md#notes-037_notessql)); stays in the team only if you're a member or admin of it, otherwise it's personal) | viewer |

- `ProjectSummary = { id, name, description, role, team, createdAt, updatedAt, dataUntil, lastRunAt, publishedAt }`
- `dataUntil` — the last day of the project's **recorded rain**
  (`rain_catchment_mm` or `rain_chirps_mm`; `YYYY-MM-DD`: the latest
  `startDate + length − 1`), or `null` with none. A forecast or a flow series
  doesn't count: a forecast runs into the future and flow only scores a run.
  `lastRunAt` — ISO timestamp of the newest run, or `null`. `publishedAt` —
  ISO timestamp of the current publication ([§ Publication](#publication)), or
  `null` before any; every member sees it, farmers included. All three come
  from the same query as the list (no per-project calls), for the list's
  freshness badge and its "published" hint.
- `team = { id, name } | null` — `null` for a personal project. `name` is
  `null` when you reach a team's project through direct sharing but aren't in
  the team (team names are visible to members only).
- `PATCH { teamId }` moves the project into a team where you're a member or
  admin (`404 team not found` if you're not in it, `403 requires team member`
  if you're a team viewer) or, with `null`, back to personal. Owner only.
- `project = ProjectSummary & { settings: ProjectSettings, rerunQueuedFor }` — settings are
  returned merged over the defaults, so the client always sees every field.
  `settings.autoRun = { enabled, debounceMinutes, publish }` (WP-2.11,
  [architecture.md § Automatic runs](./architecture.md#automatic-runs)) is
  always present, defaults `{ enabled: false, debounceMinutes: 15, publish:
  'never' }`; `PATCH` takes any subset: `enabled` boolean,
  `debounceMinutes` a whole number 0–120, `publish` `never` |
  `if_no_new_warnings` (no other value, no other key; `400`). It is not a
  model input: runs don't record it, and a `PATCH` that changes nothing but
  `autoRun` leaves `updatedAt` alone. `rerunQueuedFor` is when the project's
  pending re-run (automatic or queued through `POST /jobs`) is due, ISO, or
  `null`; on `GET /projects/:id` and the other routes that answer
  `{ project }`, not on the list.
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
  `pe` (engine ≥ 0.31.0, issue #39) is where GR4J's potential evaporation
  comes from: `{ kind: 'pan' }` (the default, pan coefficient × A-pan), or
  `{ kind: 'monthly', mm, source }` with `mm` 12 finite numbers, each
  0–10 000 mm, in water-year order, and `source` trimmed, 1–600 characters.
  Both shapes are strict: any other key is a `400`. `pe` is replaced whole by
  a `PATCH`, so `{ kind: 'pan' }` over a stored monthly row drops its `mm`
  and `source`. An invalid `pe` is a `400` with no database text. A monthly
  row of zeros saves, but a GR4J run on it is refused (`400`, "GR4J needs
  potential evaporation…", the engine's `GR4J_NO_PET`, below), as an A-pan
  row of zeros is. `panCoefficientSource` (engine ≥ 0.31.1) is a trimmed
  string of at most 600 characters, '' for none: where the pan-coefficient
  row came from, provenance only (a fit record's `forcing` may carry it
  too). Settings stored before it
  read back as `{ kind: 'pan' }`
  ([model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4)).
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
  `}`, and from engine 0.33.0 (model.md §2.9d) two optional fields:
  `lowFlow` (the low-flow grid of a `total` table, same shape as `ewr`, or
  `null`; refused on a `lowFlow` table) and `highFlows` (at most 12 `{ label`
  1–100 chars, `months` (calendar 1–12, each once), `peakM3s` (above 0),
  `durationDays` (whole, 1–90), `perYear` (whole, 1–12) `}`, strict; events ×
  days must fit in a year). A table stored without them stays valid. The
  engine's own checks run too (`ewrRuleTableIssues`), and two tables
  for one site are a `400`. The list is replaced whole by a `PATCH`.
  A settings `PATCH` merges nested groups (`gr4j`, `dataQuality`, `zeroRainRuns`, `wr2012`,
  `calibration`, `hiLoSplit`) one level deep over what is stored, so sending
  one field of a group keeps the group's other stored fields; top-level
  values, each `wr2012` group, `fitRecord` and `pe` are replaced whole. Unknown
  keys pass through, and the settings patch is capped at 64 000 characters
  of JSON.
  `chirpsBiasCorrection` is `monthly` (the default: CHIRPS rain that fills in
  for blank catchment rain is scaled by a per-month catchment / CHIRPS factor,
  engine ≥ 0.7.0) or `none` (raw CHIRPS); [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction).
  `chirpsFitPeriod` (engine ≥ 0.29.0) is `all` (the default: one set of
  factors over the whole record) or a list (1–100) of `{ fromWaterYear, toWaterYear, reason }`
  (integers 1800–2200, from ≤ to, a reason of 1–500 characters, trimmed; no
  two ranges overlapping), replaced whole by a `PATCH`. Anything else is a
  `400`; settings stored before it read back as `all`.
  [model.md §2.4b *Fit period*](./model.md#fit-period-and-per-range-factors-engine--0290-issue-40).
  `rainSource` (engine ≥ 0.30.0, issue #40 (b)) is a list (0–100, default
  `[]`) of periods whose catchment rain comes from another series, replaced
  whole by a `PATCH`: `{ start, end, series, factors, provenance?,
  fitReference?, fallback?, gaugeInChirps?, reason }`. `start` ≤ `end` are
  `YYYY-MM-DD`; `series` is `rain_catchment_alt_mm`; `reason` 1–500
  characters, trimmed. `factors` is either 12 numbers (Oct … Sep, each
  0.25–4) with `provenance: { source, fittedFrom, fittedTo, method }`
  (source and method 1–200 characters, the dates `YYYY-MM-DD`, from ≤ to),
  or `'fit'` with `fitReference: { series, fromWaterYear, toWaterYear }`
  (`rain_reanalysis_mm` or `rain_chirps_mm`, water years 1800–2200, from ≤
  to). `fallback` is absent (CHIRPS × the fit-period factors) or `{ series:
  'rain_reanalysis_mm', fromWaterYear, toWaterYear }`. With `gaugeInChirps:
  true`, `fitReference.series` may not be `rain_chirps_mm` and `fallback`
  is required. No other keys, and no two periods overlapping. The check is
  the engine's own (`rainSourceError`), so a stored value never runs
  differently from what was validated; anything else is a `400`. Settings
  stored before it read back as `[]`.
  [model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b).
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
  chirpsBiasCorrection, zeroRainRuns, chirpsFitPeriod, chirpsFactors }`,
  `panCoefficient`/`apanMm` each 12
  monthly numbers with the same bounds as the settings fields,
  `chirpsBiasCorrection` optional — `monthly | none`, `zeroRainRuns` optional
  and whole — `{ mode, keepDry, missing }` validated like the setting, plus
  optional `accumulationMode`, `keepReadings`, `addAccumulations` from engine
  0.20.0; from engine 0.29.0 optional `chirpsFitPeriod`, validated like the
  setting, and `chirpsFactors`, `null` or a list of `{ label, fittedOn?,
  factors }` with 12 factors each, Jan … Dec, `null` for a month without one,
  and `fittedOn` the reference window in words: the factors per fit range the
  fit's rain used; from engine 0.30.0 optional `rainSource`, validated like
  the setting, absent = none; from engine 0.31.0 optional `pe`, validated like
  the setting, absent = `{ kind: 'pan' }`) is the
  pan coefficient, A-pan evaporation, PE input, CHIRPS bias correction mode and
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

### Import a project file

`POST /projects/import` creates a project from a project document: the file
`GET /projects/:id/export.json` writes ([Export](#export)) or the workbook
importer's `project.json` (`scripts/wbt-import`). It's how a catchment gets
into an environment with no database access, such as production (WP-1.8).
`pnpm import:project` and `pnpm seed:examples` share its code
(`backend/src/projects/import.ts`).

- **Body:** the document as JSON (`ProjectFile` in
  `backend/src/projects/document.ts`): `{ name, description?, settings?,
  model, series? }`, plus an optional `importReport` ([Import
  report](#import-report)). An export posts as-is: unknown top-level keys
  (`format`, `version`, `exportedAt`, `engineVersion`) are ignored. To import
  under another name, change `name` in the body. Series take the same bounds
  as `PUT /projects/:id/series` (a real `YYYY-MM-DD` start date, a unit of
  1–20 characters, a name of at most 100, finite numbers or `null`, at most
  60 000 values).
- **Query:** `teamId` (uuid) puts the project in a team, with the same rule as
  `POST /projects`: `404 team not found` if you're not in it, `403 requires
  team member` for a team viewer, omitted = personal. `run=1` (or `true`)
  runs the model once after the import.
- **Atomic:** validation, the project row, the model, every series and the
  import report go in one `withUser` transaction as you (RLS applies, and the existing trigger
  makes you owner). Any failure rolls it all back, so nothing partial is left.
  Every row gets a fresh id, so one file can be imported any number of times.
  The fresh ids are random but sort in the same order as the file's (the
  engine sums and breaks ties in id order, model.md §6), so every import of
  one file, and a copy of a project, runs to the same last bit; settings that name a node (each EWR rule table's `siteNodeId`) follow the
  new ids. Settings are stored as the file has them (a workbook import's
  partial settings keep tracking the defaults); a `fitRecord`'s
  `editedParams` is recomputed as on `PATCH`.
- **Response:** `201 { project }`, where `project` has the same shape
  `POST /projects` returns. With `run=1` it also carries `runId`, or, when
  the run fails, `runError` (for example `"model run failed: …"` when GR4J has
  no A-pan evaporation yet). The run happens **after** the import commits, in
  its own transaction, so a model that can't run yet is still imported: fix
  the input and run it from the Runs tab.
- **Errors:** `400 { error: "invalid request", details }` for the zod shape
  (`details` = zod issues); `400 { error: "invalid project file", details:
  [{ message }] }` for the structural model rules (`modelProblems`: one
  outflow node, no cycles, references that resolve, …) and two series with
  the same kind and name; `400 { error: "invalid request", details }` with
  paths under `importReport` for a report over its caps (nothing is created);
  `400 invalid JSON`; `404 team not found`; `401`
  signed out; `413 { error: "project file larger than 5 MB — remove series
  the model doesn't need from the file, import it, then upload those series
  as CSV" }`.

**Body size.** The import has its own **5 MB** cap (`IMPORT_MAX_BYTES`), the
same as the export cap, so any file the app exports imports back; every other
route keeps the general 4 MB cap. It can't go much higher: Lambda refuses a
request payload over **6 MB** (the event JSON wraps the body as one escaped
string, plus headers), and a request can't be streamed. For scale, the client
catchment's `project.json` (4 series of about 16 000 days, 13 nodes) is about
**0.4 MB** compact; a 60 000-day series is about 0.8–1 MB. So a real
catchment has roughly 12× headroom, and gzip request bodies were not added.
If projects outgrow the cap, add `Content-Encoding: gzip` (a
`CompressionStream` in the browser) with a decompressed cap; note that a
binary body reaches Lambda base64-encoded (+33 %), so the compressed cap has
to stay near 4.4 MB. `import.test.ts` fails if the export cap is raised past
the import cap, which is the trigger to do this.

### Import report

What the importer flagged when a project was imported: the notes and the
unmapped report the browser's import review showed, kept with the project
(`project_import`, [data-model.md § Import reports](./data-model.md#import-reports-017_project_importsql))
so the hydrologist, and later a licensing assessor, can see what it
interpreted or couldn't map long after the import. Code:
`backend/src/projects/importReport.ts`.

**Sent with the import.** `POST /projects/import` takes it as an optional
top-level `importReport` key beside the document, so a body that is exactly a
`ProjectFile` (every existing caller, `pnpm import:project`, an export) works
as before and stores no report:

```jsonc
{
  "name": "…", "model": { … }, "series": [ … ],     // the ProjectFile, unchanged
  "importReport": {
    "source": "b023-workbook",                      // or "project-file"
    "fileName": "catchment_WBT_b023.xlsm",          // 1–255 characters
    "importerVersion": "b023 browser importer (web build …)",  // 1–100
    "notes": [{ "code": "dam-area-unknown", "severity": "info", "message": "…", "sheet": "Farm spec", "cell": "B4", "element": "Echo Farm" }],
    "unmapped": [{ "code": "transfer-inout-formula", "message": "…", "sheet": "Transfers", "cell": "T7", "element": "Echo Farm", "text": "=S7*0.9-V7" }],
    "notesOmitted": 0, "unmappedOmitted": 0         // items beyond what was kept (default 0)
  }
}
```

- **Caps** (zod; the frontend trims to the same before sending,
  `components/import/importReport.ts`): at most **500** notes and 500 unmapped
  items; `code` lower-case letters, digits and hyphens, ≤ 64; `message`
  1–2000; `sheet` ≤ 100; `cell` ≤ 20; `element` ≤ 200; `text` ≤ 8192 (Excel's
  formula limit); no NUL characters; and the two lists together at most
  **512 KB** of JSON, well inside the route's 5 MB body cap. Over any cap:
  `400 invalid request` and nothing is created. Unknown keys are dropped, not
  stored.
- **Stored in the import's transaction**, stamped with you and the time. The
  database refuses a report for any project that transaction didn't create, so
  there is no other way to write one.

**`GET /projects/:id/import-report`** (viewer or above) → `200 { report }`,
the newest import's report: the fields above plus `importedAt` (ISO time) and
`importedBy` (the importer's display name). `404 { error: "no import report" }`
when the project wasn't imported through the dialog (made by hand, copied, or
imported with no report); `404 not found` for a project you can't see.

**Not in `export.json`.** The export is the project's inputs, the document
that imports back into a project. An import report describes one import of a
*different* file; inside an export it would ride into the next import and be
stored as though the export had come from the workbook. So the export leaves it
out, and a re-import of an export records itself as a `project-file` import.

### Members

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role, party }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { member }` for a **verified** account; `201 { invited: true, invite }` when no account has the address *or* its account hasn't verified it (see Invites); `409` if already a direct member | owner |
| PATCH | `/projects/:id/members/:userId` | `{ role?, party? }` (at least one) | `{ member }`. `party` (≤ 80 characters, trimmed; `''` or `null` clears it) is the member's **applying party** (049): an applicant shares applications only with the other members of their own party, compared ignoring case. A change of party or role ends the application shares it no longer allows. Logged as `member.role` / `member.party` | owner |
| DELETE | `/projects/:id/members/:userId` | – | `204` (owners remove anyone; anyone may remove themselves, a farmer included) | farmer |

`409 a project must keep at least one owner` when demoting or removing the
last direct owner (including the last owner leaving).

These are **direct** members only. People who reach a team project through the
team are listed by `GET /teams/:id`, not here. The list includes farmers
(`role: "farmer"`); `role` in `POST`/`PATCH` is `contributor`, `viewer`,
`editor` or `owner`, farmers are added below. A **contributor** is a licence
applicant or their consultant (WP-3.3; the UI says "Applicant"): below viewer,
they reach only the farm view, the publication and their own applications
([Applications](#applications)); every other project route answers them
`403`. The invite flow is the same for every role.

### Farmers

Members with the role `farmer`, linked to the farm nodes they may read
([data-model.md § Farmers](./data-model.md#farmers-019_farmer_rolesql-020_farm_scopesql)).
Remove one (or a farmer leaves) with `DELETE /projects/:id/members/:userId`;
their links go with the membership. An address without a **verified**
account is invited instead (WP-2.2, [§ Invites](#invites)), with the farms
the invite will link; revoke a pending one with
`DELETE /projects/:id/invites/:inviteId`.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/farmers` | – | `{ farmers: FarmerEntry[] }`: the farmers, then (owners only, by RLS) the pending farmer invites | viewer |
| POST | `/projects/:id/farmers` | `{ email, nodeIds: uuid[1..50], locale?: 'en' \| 'af' }` | `201 { farmer }` for a verified account, or `201 { invited: true, invite }` (an `InvitedFarmer`) for any other address, the same answer whether or not an unverified account exists. Re-inviting sets the invite's farms to `nodeIds`. `409` when the account is already a member; `400` when a node isn't a farm of this project | owner |
| POST | `/projects/:id/farmers/bulk` | `{ rows: { email, farm, locale? }[1..200], dryRun?: boolean }` | `200 { results: { row, email, farm, status: 'added' \| 'invited' \| 'error', error? }[], dryRun }` | owner |
| PUT | `/projects/:id/farmers/:userId` | `{ nodeIds: uuid[1..50] }` | `{ farmer }`: replaces their farms; `404` if they aren't a farmer (or a contributor) here | owner |

- `FarmerEntry` is an `ActiveFarmer = { status: 'active', userId, email,
  displayName, role: 'farmer' | 'contributor', nodeIds }` (a contributor, an
  applicant, keeps farm links too: WP-3.3; bulk rows may add farms to one) or an `InvitedFarmer = { status: 'invited' |
  'expired', inviteId, email, nodeIds, invitedBy, expiresAt, locale }`. An
  invite's `nodeIds` shrink when one of its farms is deleted or stops being a
  farm; it never gains one.
- `locale` is the invite email's language, `en` by default. `af` is stored
  and sent in English until the Afrikaans wording lands (WP-2.5).
- **Bulk** takes one farm per row (a CSV of `email,farm,language`). Each row
  is checked on its own, and a bad row never stops the others: an invalid
  address, a farm name that doesn't match a farm of this project **exactly
  and case-insensitively** (never a guess at a near name), or a language
  other than `en`/`af` (`English`/`Afrikaans` also accepted) is that row's
  `error`. Rows are then grouped by address: a verified account is added (or,
  already a farmer, gains the farms; the rows never take one away), anyone
  else is invited with the farms of all their rows (added to any the invite
  already names), and a member with another role is an `error`, as is an
  address given more than 50 farms in one request (the single-add cap). One email
  per address at most, after commit, with the usual re-send cooldown; the
  first row's language wins. `row` is the index into `rows`.
- `dryRun: true` works out every row's outcome and rolls the lot back:
  nothing is written, no email goes out. The Invite farmers dialog shows it
  as the preview before sending.

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
- Farmer invites ([§ Farmers](#farmers)) are listed here too, with `role:
  "farmer"`; `GET /projects/:id/farmers` lists them with their farms. The
  Members panel leaves them to the Farmers panel.

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
| GET | `/teams/:id/portfolio` | – | `Portfolio` (see [Portfolio](#portfolio) below) | viewer |

- `Team = { id, name, role, createdAt, memberCount, projectCount }` — `role` is
  **your** role in the team.
- `TeamMember = { userId, email, displayName, role }`
- `409 a team must keep at least one admin` when removing or demoting the last
  admin (including the last admin leaving). A team you aren't in is `404`.

### Portfolio

`GET /teams/:id/portfolio` (roadmap WP-2.14, `backend/src/portfolio/`): every
catchment of the team you can see, with its latest figures, for the WUA's
dashboard. Any team member; a team you aren't in is `404`, and so is every
farmer (a farmer has no team membership). The rows come from **one query**
run as you under RLS, whatever the number of projects (guarded by a query
count in `portfolio.db.test.ts`); a project where your role is `farmer` is
left out, so nobody gets a catchment roll-up of their neighbours.

- `Portfolio = { team: { id, name, role }, today, thresholds: { amber, red }, projects: PortfolioProject[] }`;
  `today` is the server's UTC date the ages count to; `thresholds` are the
  traffic-light fractions (below).
- `PortfolioProject = { id, name, role, dataUntil, lastRunAt, publishedAt, source, sourceRunId, figuresUntil, figuresAgeDays, stale, behindData, newerRun, ewr, farmsShort7, farmsShort30, farmCount, lowestDamPct, damsKnown, feeds, alertsFiring, restriction }`, by name:
  - `source`: where the figures come from. `published`: the current
    publication. `run`: nothing is published, so the newest baseline run
    (not a scenario run). `null`: no run. `sourceRunId` is that run.
  - `figuresUntil` / `figuresAgeDays`: the last day the figures cover (the
    source run's last day of observed rain) and its age; `stale` when older
    than 7 days (the farm page's rule). `behindData`: the project holds
    recorded rain after `figuresUntil`. `dataUntil` is that newest day of
    recorded rain (the project list's rule). `newerRun`: a baseline run
    newer than the published one exists.
  - `ewr = { status: 'green' | 'amber' | 'red' | 'unknown', daysNotMet30, days30, fraction30, reason? }`:
    the outlet EWR over the 30 days to `figuresUntil` (the publication's
    `catchmentView`, or, for `source: 'run'`, counted in SQL from that run's
    one outlet series; the DB test checks the two agree). Thresholds (D11):
    **green** below 5 % of the days not met, **amber** below 20 %, **red**
    otherwise; they are defaults for the hydrologist to confirm, not yet a
    team setting (followups.md). `unknown` carries `reason`: `no-figures` (no
    run), `no-ewr` (the source run had no EWR set, every month 0, so "never
    short" would be a false green) or `no-series` (the run has no outlet EWR
    record).
  - `farmsShort7` / `farmsShort30`: farms short at least one day in the 7 /
    30 days to `figuresUntil`, stored with the publication
    (`catchmentView.recent`); `null` without a publication, or for one made
    before the counts existed. `farmCount`: the publication's, or the live
    network's without one.
  - `lowestDamPct = { nodeName, pct }`: the farm dam lowest on
    `figuresUntil` (0–1), from the farm projections; `null` with no dams.
    `damsKnown` is false without a publication (then `null` means unknown).
  - `feeds = { total, ok, failing }`: `failing` counts failing **and** stale
    feeds (`feeds/health.ts`); pending and disabled ones count in neither.
  - `alertsFiring`: the alerts firing now (`alert_event` rows in state
    `firing`, [§ Alerts](#alerts)); `0` when none, and for a catchment with
    no alert switched on.
  - `restriction = { level, pct } | null`: the current publication's; `null`
    when nothing is published.

## Alerts

Email alerts (roadmap WP-2.13; `051_alerts.sql`, [security.md § Alerts](./security.md#alerts),
[data-model.md § Alerts](./data-model.md#alerts-051_alertssql)). A catchment's
**rules** say which kinds it alerts on and at what level; alerts are
**opt-in per catchment**: until an editor switches a kind on, nothing is
evaluated or sent. Each person's **choices** say how they get the kinds
their role receives. The `alert_eval` job opens and clears **events**
([architecture.md § Background work](./architecture.md#background-work));
the worker mails each recipient ([§ below](#how-alert-mail-is-sent)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/me/alerts` | – | `{ projects: ProjectAlerts[] }`: every catchment you can open (never an applicant's), by name | signed in |
| PUT | `/me/alerts/:projectId` | `{ items: { kind, nodeId?, mode }[] }` (1–100) | `{ project: ProjectAlerts }` | farmer (not contributor) |
| GET | `/projects/:id/alert-rules` | – | `{ rules: AlertRule[] }`: every project-wide kind, then a `dam_below` per farm in network order; one not saved yet is `{ id: null, enabled: false }` at its default threshold | editor |
| PUT | `/projects/:id/alert-rules` | `{ rules: { kind, nodeId?, threshold, enabled }[] }` (1–500) | `{ rules: AlertRule[] }`. Upserts each, records `alert_rules.changed`, and queues an `alert_eval` (a kind switched on over a figure already past it fires at once) | editor |
| GET | `/projects/:id/alert-events?state=firing\|all` | – | `{ events: AlertEvent[] }`, newest first, at most 100: the firing ones (default), or firing and cleared. As RLS lets the caller see them: a farmer gets their own farms' dam alerts and the restriction-notice events, never another farm's; an applicant gets `[]` | farmer |
| POST | `/alerts/unsubscribe` *(public)* | JSON `{ token }`, or a form post with `?token=` | JSON: `200 { kind, project: { name }, farm }`; form: `204` | – |

- Kinds, what fires them, and who gets them by default:

  | `kind` | Fires when (hysteresis: re-arms only after recovery) | `threshold` | Default: right away | May opt in |
  | --- | --- | --- | --- | --- |
  | `dam_below` (per farm) | the published projection's dam level on its last day of data, or the published forecast's lowest, is below the threshold; re-arms at threshold + 5 points | 0 < t < 1 (0.3) | that farm's farmers, editors, owners | viewers |
  | `ewr_forecast_fail` | the newest forecast run (while its days haven't passed) has `outletEwrDaysAtRisk ≥ t`; re-arms at ≤ t − 2 | whole days 1–60 (3) | editors, owners | viewers |
  | `data_stale` | an enabled feed is more than t days past its usual delay (`feeds/health.ts` `staleAfterDays`); re-arms under t | whole days 1–60 (3) | editors, owners | – |
  | `restriction_published` | the current publication's restriction level, percentage or notice changes (a lift too) | 0 | farmers, viewers and up | – |
  | `feed_failing` | an enabled feed failed t times in a row; re-arms at 0 | 1–20 (3) | owners | editors |
  | `job_dead` | t jobs died in the last 24 hours; re-arms at 0 | 1–100 (1) | owners | editors |

  Applicants (contributors) never get alerts. A `threshold` outside its
  range, or a `dam_below` rule without a farm (or another kind with one),
  is `400`; a farm of another project `404`.
- `ProjectAlerts = { id, name, role, muted, choices: AlertChoice[] }`.
  `AlertChoice = { kind, nodeId, nodeName, mode, defaultMode, chosen, ruleOn }`:
  `mode` is what you get now (the database's own rule,
  `app_alert_my_mode`), `defaultMode` your role's default, `chosen` whether
  you set it, `ruleOn` whether the catchment has it switched on (off, you
  get nothing whatever you choose). A farmer has one `dam_below` choice per
  own farm; everyone else one for every farm. `muted`: every alert email
  for the catchment is off (a digest's one-click unsubscribe).
- `mode` ∈ `immediate` (right away, at most 5 a day; the rest wait for the
  digest), `daily_digest` (in the 06:00 South African time summary), `off`.
  `kind: 'all'` with `immediate` or `off` is the catchment-wide switch.
  PUT refuses (`400`) a kind your role never gets, a `nodeId` on anything but
  a farmer's dam alert, and `daily_digest` for `all`; a farmer naming a farm
  that isn't theirs gets `404`. Turning a choice back on (from `off`) draws a
  new unsubscribe token, so a link in an older email no longer works.
- `AlertRule = { id, kind, nodeId, nodeName, threshold, enabled, firing }`.
- `AlertEvent = { id, kind, state, value, threshold, nodeId, nodeName, openedAt, clearedAt, detail }`.
  `detail` holds the figures the alert was raised on: `dam_below`
  `{ source: 'latest'|'forecast', pct, date, madeOn?, publishedAt }` (that
  farm's own projection only); `ewr_forecast_fail` `{ days, of, from, to,
  madeOn }`; `data_stale` `{ feeds: { label, newest, overdue }[] }`;
  `feed_failing` `{ feeds: { label, failures }[] }`; `job_dead` `{ count }`;
  `restriction_published` `{ publicationId, level, pct, lifted, publishedAt }`.
  While an event fires, its `value` and `detail` follow the figure.
- **Unsubscribe.** Every alert email links to the site's
  `/alerts/unsubscribe#t=<token>` (the token in the fragment, so it reaches
  no server log), and carries `List-Unsubscribe: <API/alerts/unsubscribe?token=…>`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058): a mail
  client's one-click button form-posts `List-Unsubscribe=One-Click` to that
  address, which is why only this route takes a form body and a query
  token, and why it alone is exempt from the CSRF check (it reads no
  session). A token turns off only its own subscription (a digest's, the
  catchment-wide `all`), without signing in; a repeat is harmless. `404`
  for a malformed or tampered token, one a later re-enable replaced, or one
  whose person is no longer a member; `400` without a token.

### How alert mail is sent

- One email per event per person, ever (`alert_delivery` primary key), and
  one per crossing: a firing rule sends nothing more until it clears.
- At most **5 immediate alert emails per person per day**, the day running
  from 06:00 to 06:00 South African time (`ALERTS_DAILY_CAP`). The rest, and
  everything a person chose to get daily, go out in one **digest** per
  catchment after 06:00. A digest lists at most 20 alerts (the newest), then
  "…and N more" pointing at the app; those are marked sent with it. At most
  200 lines a person are taken per digest; older ones are dropped as over
  the limit, never sent later.
- The mail is built **as its recipient**, under RLS, when it is sent: their
  access and choice are checked again then (a member removed since the
  event, or who turned the alert off, gets nothing), and it can only name
  what they may read.
- `ALERTS_ENABLED=false` (the kill switch) stops all sending: events still
  open and clear in the app, and deliveries waiting to go out are dropped,
  not sent later ([deployment.md § Runbooks](./deployment.md#runbooks)).

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

Dam storage (engine ≥ 0.35.0, migration 041, WP-3.5, [model.md §2.7a](./model.md)):
every node carries `damCurve` (`null`, or up to 200 rows of `{ levelM,
areaM2, volumeM3 }`, finite, area and volume ≥ 0), `damReleaseRule`
(`"none"` | `"passInflow"` | `"fixed"`), `damReleaseM3Day` (12 numbers ≥ 0,
water-year months, or `null`), `damOutletCapacityM3Day` (≥ 0 or `null` = no
limit) and `damSeepageReturnPct` (0–1). A body without them gets `null`,
`"none"`, `null`, `null` and 1 (no change to any run). `PUT` refuses a curve
on a node that isn't a farm, and one whose volumes don't strictly rise or
whose level or area falls as the volume rises (the engine's
`modelRuleProblems`). Settings gain `lakeEvapFactorMonthly` (12 numbers 0–2,
or `null` = `lakeEvapFactor` every month; `PATCH` refuses anything else).
Runs of a dam with a release rule store `dam_release`; with a seepage share
below 1, `dam_seepage_lost`; `summary.waterBalance` rows gain
`damReleaseM3` and `damSeepageLostM3` when present (the residual subtracts
the lost seepage), and `summary.csv` the same two columns.

`ProjectModel.boreholes` (engine ≥ 0.36.0, WP-3.9; optional, and absent from
`GET` when the project has none) is `{ id, nodeId, name, capacityM3Day,
annualCapM3 (null = no cap), mode ('none' | 'supplemental' | 'primary' |
'emergency'), emergencyBelowPct (0–1), target ('direct' | 'dam'),
depletionFactor (0–1) }[]`, at most 5 000. `PUT` refuses a borehole on a gauge
or an unknown node, and an emergency or dam-target borehole on a node without a
farm dam; `mode`, `emergencyBelowPct`, `target` and `depletionFactor` default
to supplemental, 0.3, direct and 0.

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
`startDate` is a real calendar date, `YYYY-MM-DD` (`2021-02-30` is a `400`
naming `startDate`, not a server error).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/series` | – | `{ series: SeriesMeta[] }` | viewer |
| GET | `/projects/:id/series/:seriesId` | – | `SeriesMeta & { values }` | viewer |
| PUT | `/projects/:id/series` | `{ kind, name?, unit, startDate, values, product?, productVersion?, dayBoundary? }` | `SeriesMeta & { rerunQueuedFor }` (upsert on kind+name) | editor |
| POST | `/projects/:id/series/merge` | `{ kind, name?, unit, startDate, values, product?, productVersion?, dayBoundary? }` | `SeriesMeta & { rerunQueuedFor }` (merge by date; creates the series if missing) | editor |
| PATCH | `/projects/:id/series/:seriesId` | `{ product, productVersion }` (both strings, or both `null` to clear) | `SeriesMeta`: says what an existing series holds; the values and `updatedAt` are untouched. Logged as `series.labelled` when it changes | editor |
| DELETE | `/projects/:id/series/:seriesId` | – | `204` | editor |

`SeriesMeta = { id, kind, name, unit, startDate, length, updatedAt, product, productVersion, dayBoundary, rebuilding }` —
`rebuilding` is true while a data feed backfills a confirmed replacement of the
series (its values stay as they are until the swap);
`updatedAt` is when the values last changed (upload or merge), so the UI can
tell there is new data since the last run.

`rerunQueuedFor` (`PUT` and merge only; WP-2.11): when the write changed days
and the project has automatic runs on, it queued the project's debounced
re-run (or pushed the pending one back), and this is when it is due, ISO.
`null` when automatic runs are off or no day changed (re-sending the same
values queues nothing). A data feed's merges and an API key's ingest queue it
the same way ([architecture.md § Automatic runs](./architecture.md#automatic-runs)).

**Product and version** (issue #40 part c, [data-model.md § Series
provenance](./data-model.md#series-provenance-032_series_provenancesql)):
what the values are, e.g. `CHIRPS` `2.0`, `CHIRPS sat` `3.0`, `CHIRPS rnl`
`3.0`; `null` = not recorded. Sent together or not at all (`400` otherwise);
the product is 1–40 letters, digits, spaces, dots, dashes or underscores, the
version 1–20 without spaces. A PUT without them stores the new values as not
recorded. A merge without them keeps the series' label; a merge with them
labels a new or empty series, and is `409 { error: "the series holds CHIRPS
v2.0 and these days are CHIRPS sat v3.0: merging them would splice two
versions into one record. …" }` into a series holding values of another.

**Day boundary** (issue #40 (b), [data-model.md § Series day
boundary](./data-model.md#series-day-boundary-033_series_day_boundarysql)):
`dayBoundary` is `'08:00'` (the days were added up from sub-daily readings
in 08:00–08:00 windows, booked to the day each starts), `'00:00'`
(midnight to midnight) or `null` (daily values as uploaded). The browser
does the adding up; the API stores the label. A PUT says it or clears it
(absent = `null`). A merge without it keeps the series' label; a merge with
it labels a new or empty series, and is `409 { error: "the series holds
08:00–08:00 days and these days are 00:00–00:00 days: merging them would put
two day boundaries in one record. …" }` into a filled series holding the
other (`null` counts as its own). Copies, the exported project document,
imports and series revisions keep it (a restore puts it back; the
revisions list returns it as `dayBoundary`).

**Units.** A series is stored in its kind's canonical unit, the one the model
reads: m³/s for `flow_*`, mm for `rain_*`. `unit` on PUT, merge, the data
feeds and a project import may be any the engine's table knows (`units.ts`:
m³/s, l/s, m³/day, m³/h, ML/day; mm, cm, in; common spellings such as `m3/s`,
`cumecs`, `L/s`), and the values are scaled on the way in; the stored and
returned `unit` is the canonical one. Any other unit is a `400` naming the
accepted ones (a flow in l/s used to be stored as given and run 1 000 × too
large).

`merge` is for daily or batch appends (loggers, CHIRPS, forecasts): the days
sent are merged into the existing series by date. Incoming values win on
overlapping days, the series extends in either direction, and any gap days
between the old and new ranges become `null`. `413` if the merged series would
exceed 60 000 days. A merge that changes nothing (a re-sent batch) leaves the
row alone, so `updatedAt` doesn't move. A merge or `PUT` by a user also takes the days it writes back from the
series' data feed, which then keeps them rather than replacing them
([data-model.md § Feed days](./data-model.md#feed-days-031_feed_dayssql)).

`kind` ∈ `SERIES_KINDS` (`packages/engine/src/project.ts`): `rain_catchment_mm`,
`rain_catchment_alt_mm`, `rain_chirps_mm`, `rain_reanalysis_mm`,
`rain_forecast_mm`, `flow_observed_m3s`, `flow_logger_m3s`
and `flow_reference_m3s` (`flow_pitman_m3s` was removed in engine 0.10.0).
`rain_catchment_alt_mm` (an alternative catchment gauge) and
`rain_reanalysis_mm` (a gauge-free reanalysis such as ERA5), engine ≥ 0.30.0,
are read only by a `settings.rainSource` period
([model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)). The last is a gauge on a different
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
| POST | `/projects/:id/runs` | `{ label?, forecast? }` | `201 { run, removedRunIds }` — `removedRunIds`: older runs deleted by the per-project cap (for a forecast run: the project's older forecast run). `forecast: true` makes a **forecast run** (below); `409` when there is no forecast rain after the last observed rain day | editor |
| GET | `/projects/:id/model-input` | – | `{ input: ModelInput }`: exactly what a run would use (settings merged over the defaults, the model, the first series of each kind by name), for the in-browser engine (automatic calibration) | viewer |
| GET | `/projects/:id/runs` | – | `{ runs: RunMeta[] }` (newest first) | viewer |
| GET | `/projects/:id/runs/:runId` | – | `{ run: run & { settings, model }, series: { nodeId, key, label, unit }[] }`; `settings` is the run's own settings snapshot (below) and `model` its model snapshot (`{ nodes, crops, cropAreas, transfers, … }` as they were when it ran; the `.xlsx` workbook names its node sheets and fills its Inputs sheet from it) | viewer |
| GET | `/projects/:id/runs/:runId/series?key=…&nodeId=…` | – | `{ startDate, values }` (omit `nodeId` for catchment series) | viewer |
| GET | `/projects/:id/runs/:runId/series/bulk?nodeId=…&offset=…` | – | Every series of one node (the catchment's without `nodeId`) in one response, for the `.xlsx` workbook: see [Export § Bulk run series](#bulk-run-series) | viewer |
| GET | `/projects/:id/runs/:runId/day?nodeId=…&date=YYYY-MM-DD` | – | One node's every column on one day, for the day trace: `{ date, nodeId, name, kind, previousStorageM3, previousSoilWaterMm, params, columns: { key, label, unit, value }[] }`. `name`, `kind` and `params` (`pctUpstreamToDam`, `pctRunoffToDam`, `divertCapacityM3Day`, `damCapacityM3`, `damInitialPct`, `damMinPct`, `irrigationEfficiency`, `lossReturnFraction`, `damAreaFullM2`, `damAreaExponent`, `damSeepagePerDay`) come from the run's input snapshot (a run from before engine 0.16.0 has its `returnFlowPct` mapped as migration 006 does: e = 1 − r, β = 1, or 1 and 0 when r = 0); `previousStorageM3` is the dam storage at the end of the day before (the initial storage on the run's first day; `null` for a gauge); `previousSoilWaterMm` is the farm's soil-water store at the end of the day before, in mm (0 on the run's first day; `null` for a gauge or a run from before engine 0.14.0, which has no `soil_water` column). `400` for a date that isn't one or is outside the run, `404` for a node the run doesn't have | viewer |
| GET | `/projects/:id/runs/:runId/day?date=YYYY-MM-DD` | – | The same without `nodeId`: the catchment's day, for the runoff-model trace (how rain became natural flow): `{ date, nodeId: null, name: "Catchment", kind: "catchment", runoffModel, areaKm2, params, previousStorageMm, previousStores, columns }`. `columns` are every catchment series (`node_id` NULL) that day; for GR4J they include `rain_used`, `pet`, `aet`, `production_store`, `routing_store`, `uh_store`, `exchange` (only when X2 ≠ 0) and `natural_flow` (m³/day), all depths in mm over the catchment. `runoffModel`, `areaKm2` and `params` (`x1` … `x4`, `warmupDays`) come from the run's `summary.runoff`; `previousStores` is each store at the end of the day before (each `null` on the run's first day, when only their total is recorded) and `previousStorageMm` their total (the storage after the warm-up on the first day), so before + rain + exchange − AET − Q = after closes the day. A run without a runoff balance ran the legacy model: `runoffModel: "legacy"`, `areaKm2`, `params`, `previousStorageMm` and `previousStores` `null`, and the columns are the [Flow data] ones (`rain_used`, `is_summer`, `rain_flow`, `base_flow`, `response_flow`, `resultant_flow`, `natural_flow`). `400` for a bad or out-of-run date | viewer |
| PATCH | `/projects/:id/runs/:runId` | `{ notes?, pinned? }` (at least one) | `200 { run: RunMeta }` with the new note and its stamp, and the pin. `notes` is a string, trimmed, at most 4 000 characters, no NUL; `''` clears it. `pinned` is a boolean: `true` keeps the run past the run cap (below) and blocks its deletion, `false` releases it; pinning leaves the note's stamp alone. `409 { error: "this project already has 10 pinned runs, the most it can keep; unpin one first" }` when pinning an 11th (re-pinning a pinned run is fine); a **cited** run's pin doesn't count against the 10 (it is kept anyway), and unpinning a cited run is `409 { error: "this run is cited by scenario "…", so it stays kept" }`. No other field is accepted (`400`), and nothing else about a run can change: the database grants the app `UPDATE` on `model_run.notes` and `model_run.pinned` only ([data-model.md § Run notes, Pinned runs](./data-model.md)) | editor |
| DELETE | `/projects/:id/runs/:runId` | – | `204` (the run's stored input series go too, unless another run uses them); `409 { error: "run is published: it is, or was, the published baseline, so it is kept" }` for a run a publication in the history holds ([Publication](#publication)); `409 { error: "this run is cited by scenario "Dam raise", so it is kept" }` for a run something else cites (a [scenario](#scenarios)'s base; later an evidence pack), naming up to three citations you can see (`"this run is cited, so it is kept"` when you can see none; [data-model.md § Cited runs](./data-model.md#stored-run-inputs-021_series_blobsql)); `409 { error: "this run is or was nominated as evidence, so it is kept" }` for a run the evidence history names; `409 { error: "this run is pinned; unpin it before deleting it" }` for a pinned run | editor |
| GET | `/projects/:id/evidence` | – | `{ nominations: Nomination[] }`, **oldest first**; the last is the current nomination, `[]` when none | viewer |
| POST | `/projects/:id/evidence` | `{ runId, reason }` | `201 { nomination, nominations }`: the new row and the whole history. `reason` is required: trimmed, 1–2 000 characters, no NUL. No other field is accepted (`400`): who, when, the runoff model and the engine version are stamped by the database. `404 run not found` for a run not in this project; `409` for a legacy-model run (workbook comparison only), a run whose stored inputs have flow shares over 100 % (made before engine 0.27.1 refused them), the run that is already current, a forecast run (WP-2.12: evidence is judged on the record, and a forecast run's last days are modelled on forecast rain), or a project at its limit of 50 nominations | editor |
| GET | `/projects/:id/runs/:runId/reproduce` | – | `200 Reproduction`: the run re-run on the server from its stored inputs (`loadRunInput`) with the current engine, its summary and every daily output compared with what was stored (WP-3.1). `{ status, identical, engineVersionThen, engineVersionNow, differences, truncated, message? }`: `status` is `identical`, `differs` (`differences` lists up to 50: `{ kind: 'summary', path }`, `{ kind: 'series', key, nodeId, label, days, firstDate, maxAbsDiff }`, `{ kind: 'series_missing' \| 'series_extra', key, nodeId, label }`; `truncated` counts the rest), `not_reproducible` (a run from before stored inputs, `message` says so), `inconsistent` (a stored input fails its check against the run's record: never presented as the run) or `failed` (today's engine refuses the stored input, `message` has its reason). `404` for a run not in this project | viewer |

- A run the engine can't make is a `400 { error: "model run failed: …" }`
  with the engine's reason, and nothing is stored: no rainfall series, a
  simulation end before its start, (engine ≥ 0.11.1) a GR4J run with no
  potential evaporation (A-pan × pan coefficient, or from engine 0.31.0 the
  monthly PE row of `settings.pe`, 0 in every month), or
  (engine ≥ 0.27.1) farm flow shares that add up to more than 100 %.
- A project keeps its newest **20** runs (env `RUNS_KEPT_PER_PROJECT`,
  default 20); each new run deletes the oldest beyond that, with their
  outputs. Pinned runs (at most 10 per project), runs the evidence
  history names, runs a publication holds (at most 12, [Publication](#publication))
  and cited runs (a scenario's base) are exempt and don't count against the
  20. A scenario's runs count like any other. **Automatic runs**
  (`trigger: 'auto'`, WP-2.11, and `'forecast'`, WP-2.12) are capped apart,
  per trigger: only the newest unkept auto run and the newest unkept forecast
  run are kept, and neither counts against, or pushes out, the 20.
- **Forecast runs** (roadmap WP-2.12, [model.md §2.4f](./model.md#24f-forecast-mode-engine--0370-roadmap-wp-212)).
  An ordinary run (`forecast` absent or `false`) leaves out any forecast rain
  after the last observed rain day: it ends the day before the forecast
  tail, and stores that input, so forecast rain never reaches its figures.
  `forecast: true` runs the engine's forecast mode: `trigger: 'forecast'`,
  the run's end is the forecast's last day, every summary figure and every
  series before `summary.forecast.from` is exactly what the ordinary run
  would give, and `summary.forecast = { from, to, days, lastObserved,
  rainMm, perFarm: { nodeId, name, minDamPct, minDamDate, deficitDays,
  demandM3, suppliedM3, suppliedFraction }[], outletEwrDaysAtRisk }` covers
  the days from `from` (fractions 0–1; `minDamPct`/`minDamDate` null
  without a dam, `suppliedFraction` null without demand). It also stores the
  catchment series `rain_source` (0 catchment, 1 alternative gauge, 2 CHIRPS,
  3 reanalysis, 4 forecast, `null` none) when the run has no rain-source
  periods. A forecast run is reproduced by `runForecastChecked(loadRunInput(run))`;
  it can't be a scenario's base, nominated as evidence or signed off (each
  `409`: all three are judged on the record), and its uncertainty bands run on
  its input without the tail. Made on request, and, when the project has
  automatic runs on (`settings.autoRun.enabled`), after each forecast feed
  (CHIRPS-GEFS) ingest that changes days: a `rerun` job with `trigger:
  'forecast'` (dedupe key `forecast`, the re-run's debounce), labelled
  `Forecast · from <day>`, never published automatically
  ([architecture.md § Background work](./architecture.md)).
- `RunMeta = { id, label, engineVersion, startDate, endDate, createdAt, createdBy, legacy, runoffModel, notes, notesUpdatedAt, notesUpdatedBy, evidence, pinned, published, scenarioId, scenarioName, citedBy, reproducible, trigger, forecastFrom }` —
  `trigger` is what made the run (042_auto_rerun): `manual`, `auto` (WP-2.11)
  or `forecast`; `forecastFrom` a forecast run's first forecast day
  (`summary.forecast.from`), else `null`.
  `legacy` is `settings.runoffModel === 'legacy'` (absent → legacy, for runs
  saved before the setting existed), so the app can badge it without a second
  fetch (audit H1, workbook comparison only — not evidence). `notes` is the
  modeller's written explanation of the run (`''` = none; e.g. why a WR2012
  *query* or *not usable* flag stands), `notesUpdatedAt` / `notesUpdatedBy`
  (display name) when and by whom it last changed (`null` until first
  written). `runoffModel` is the run's `settings.runoffModel` (`gr4j`,
  `legacy`, …; absent → `legacy`). `evidence` is the run's place in the
  evidence history: `'current'` (the project's nominated evidence run),
  `'past'` (nominated before, since replaced) or `null`. `pinned` is whether
  an editor pinned the run (015_run_pinned), so it survives the run cap.
  `published` is whether the project's current publication holds the run
  (022_publication).
  `scenarioId` is the [scenario](#scenarios) that made the run (`null` for a
  run of the live model, and once that scenario is deleted); `scenarioName`
  its name (the name the run recorded, once the scenario is gone; `null` for
  a run of the model). `citedBy` is what keeps the run for good
  (`{ kind: 'publication' | 'scenario' | 'signoff', id, name }[]`, oldest
  first, the citations you can see; a publication's `name` is the day it was
  published, `YYYY-MM-DD` UTC, a sign-off's the signer's name; `[]` when
  none). `reproducible` is whether the run's input series are stored
  (021_series_blob), so `…/reproduce` can re-run it; `false` for a run from
  before stored inputs. `trigger` is what made the run:
  `'manual'` (a person: Run, a queued re-run, an import, a scenario) or
  `'auto'` (the re-run after new data, labelled `Auto · data to <day>`, made
  as the person whose data queued it) or `'forecast'` (a forecast run, WP-2.12, below).
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
- `summary.groundwaterAnnualUse` (engine ≥ 0.36.0, WP-3.9; only with
  boreholes) is one row per farm or user with boreholes (node-id order) per
  water year the run touches: `{ nodeId, name, kind, waterYear (start year),
  label ('2003/04'), days, abstractionM3 (pumped to the crop + into the dam),
  toDamM3, streamDepletionM3, annualCapM3 (Σ caps, null if any borehole can
  pump uncapped), gaLimitM3 (40 000, the GN 538 ceiling per property, context
  only), boreholes: [{ id (null = the combined capacity), name, abstractionM3,
  annualCapM3, capReached }] }`. It is the modelled groundwater abstraction per
  farm per water year that licensing comparisons (WARMS, WP-3.10) read. A node
  with a dam-target borehole has the run series `groundwater_to_dam`, and its
  farm summary `avgGroundwaterToDamM3Day`. The summary CSV adds a
  "Groundwater abstraction by water year" block.
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
  cells, met, rate }` and `minYears`. From engine 0.33.0, only when the table
  has them (model.md §2.9d): with a low-flow grid, each month adds
  `requiredLowFlow`, `lowFlowMet`, `requiredHighFlow`, each month of the year
  `lowFlowRate`, and the site `lowFlow { months, met, rate, deficitM3,
  longestNotMetRun }`; with high-flow components, `highFlows` (each the
  component plus `peakAppliedM3s`, `years: [{ waterYear, natural, actual,
  required, met }]` over the complete water years, and `overall { years,
  required, met, rate }`). Each site also has the daily series
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
- `summary.supplyAssurance` (engine ≥ 0.32.0, WP-3.4, [model.md §2.11a–b](./model.md#211a-assurance-of-supply-and-stress-classes-engine--0320-roadmap-wp-34);
  absent on older runs and on `runModelWithoutChecks` ensemble members) is
  `{ reportStart, reportEnd, days, annualThreshold, reliability, stress, waterAccount }`:
  - `reliability[]`, farms then other water users over the reporting window:
    `{ nodeId, name, kind: 'farm'|'user', demandM3, suppliedM3, demandDays, metDays,
    timeReliability, volumetricReliability, waterYears, waterYearsMet, annualReliability,
    failureRuns, meanFailureDays, longestFailureDays, meanFailureDeficitM3,
    maxFailureDeficitM3, months[12] }` (ratios 0–1 or `null` without demand;
    `months` in water-year order, each `{ demandDays, metDays, demandM3, suppliedM3,
    timeReliability, volumetricReliability }`);
  - `stress`: `{ waterYears, days[][], thresholds, system, nodes[] }`, each grid
    `{ nodeId (null = system), name, kind, ratio[][], stressClass[][] }` over the
    whole run, class one of `low`, `moderate`, `high`, `severe`, `critical` or
    `null` (no demand);
  - `waterAccount`: `{ areaKm2, years[], total }`, each row `{ waterYear, days,
    rainM3, catchmentLossM3, naturalFlowM3, rainOnDamsM3, groundwaterM3, transfersM3,
    inM3, landCoverM3, unallocatedM3, consumptiveIrrigationM3, otherUseM3,
    damEvaporationM3, streamDepletionM3, outflowM3, outM3, damSeepageM3,
    irrigationSuppliedM3, openingStorageM3, closingStorageM3, storageChangeM3,
    residualM3, scaleM3, ewr: { nodeId, name, requiredM3, metM3, daysNotMet }[] }`.
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
- `summary.rainSource` (engine ≥ 0.30.0) is what `settings.rainSource` did,
  `null` without periods, absent on older runs: `{ periods: [{ start, end,
  series, reason, factorMode: 'fixed' | 'fit', factors (12, Jan … Dec, null
  = none), provenance, fit: { reference, referenceWindow, periodWindow,
  referenceDays, periodDays, months: [{ month, catchmentRatio, seriesRatio,
  factor, clamped }] } | null, fallback: 'chirps' | { era, fitWindow, days,
  factors }, gaugeInChirps, seriesPresent, seriesProvenance?, runDays,
  seriesDays, seriesRawMm, seriesMm, chirpsDays, reanalysisDays,
  forecastDays, noneDays }] }`. The catchment series `rain_source` (only
  with periods) is each day's source: 0 catchment, 1 alternative gauge, 2
  CHIRPS, 3 reanalysis, 4 forecast, `null` for none. With periods,
  `summary.chirpsCorrection.replacedDaysLeftOut` counts the shared days the
  CHIRPS fit left out because a period replaces them.
  Rules: [model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b).

### Uncertainty bands

Engine ≥ 0.26.0, migration 014, [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9).
The ensemble runs in the browser (hundreds of model runs, the calibration
worker); the server resolves its options, the database draws the seed, and
the result is stored only after the server has checked it.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/model-input` | – | `{ input: ModelInput }`: the run's own input. A run saved since migration 021 stored its input series, so this is exactly what it ran on whatever the project's data is now (`loadRunInput`). An older run kept only hashes of them: its settings and model snapshot with the project's series, and `409` when a series changed since the run, with the kinds | viewer |
| GET | `/projects/:id/runs/:runId/uncertainty` | – | `{ ensembles: Ensemble[] }`, newest first, **every** ensemble started for the run (abandoned starts included), without `result` | viewer |
| GET | `/projects/:id/runs/:runId/uncertainty/:uid` | – | `{ ensemble: Ensemble & { result } }`: `result` = `{ engineVersion, header, members, coverage }` (an ensemble) or `{ engineVersion, header, members: { index, metrics }[] }` (paired) | viewer |
| POST | `/projects/:id/runs/:runId/uncertainty` | `{ request: { members?, bounds?, free?, panOffset?, rainSources?, records?, thresholds?: { objective?, minSkill?, wr2012MaxLevel?, maxLowFlowBiasPct? } } }` or `{ baselineId }` | `201 { ensemble, notes }`, status `started`: the resolved options (`ResolvedEnsembleOptions`, the model is the run's own) with the seed the database drew. `baselineId` (a complete ensemble of **another** run of this project, same runoff model and period) starts a paired band: its options and seed are the baseline's. `400` with the engine's reason for options the run can't use (fewer than 30 members, a rain source it lacks, no observed record, two models, two periods, or from engine 0.31.0 a baseline that varied the pan coefficient paired with a GR4J run on a monthly PE row, which doesn't use it). On a GR4J run with a monthly PE row the pan coefficient isn't varied (`panOffset` 0) and `notes` says so; `409` from `model-input`, or at 50 ensembles for the run | editor |
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

## Scenarios

A scenario is a named, ordered list of overrides (engine `ScenarioOp`,
[scenarios.md](./scenarios.md)) on a **base run**, run and compared without
copying the project (roadmap WP-3.2, migration 024). It applies to the base
run's stored input (`loadRunInput`), never the live model, so editing the
model afterwards changes nothing about it. Its runs are ordinary runs with
`scenarioId` set: listed, exported, compared and trimmed like any other.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/scenarios` | – | `{ scenarios: Scenario[] }`, newest first | viewer |
| POST | `/projects/:id/scenarios` | `{ name, baseRunId, description?, ops?, ownedNodeIds? }` | `201 { scenario, check, checkError }` (below). The base must be a run of this project that stored its inputs: `404 base run not found` otherwise; `409` with `loadRunInput`'s reason for a run saved before stored inputs (`this run is not reproducible from stored inputs: …`), and `409 that run is a scenario run; base a scenario on a run of the model itself`, and `409` for a forecast run (WP-2.12: a scenario is judged on history). `409 this project already has a scenario with that name` (a team scenario's name is unique among the project's team scenarios, ignoring case; an application's among its owner's applications: `409 you already have an application with that name`, 049) | editor |
| GET | `/projects/:id/scenarios/:sid` | – | `{ scenario, check, checkError }` | viewer |
| PATCH | `/projects/:id/scenarios/:sid` | `{ name?, description?, ops?, ownedNodeIds?, status? }` (at least one) | `200 { scenario, check, checkError }`. `ops` replaces the whole list. `ops` and `ownedNodeIds` change only while the scenario is a `draft`: `409 this scenario is submitted, so its ops, owned nodes and base run can't change`. `status` moves `draft → submitted → withdrawn \| decided`, `withdrawn → draft`; any other move is `409` | editor |
| DELETE | `/projects/:id/scenarios/:sid` | – | `204`; its runs stay, with `scenarioId: null` (their snapshot keeps the ops), and its base run stops being cited. `409` for a `submitted` or `decided` scenario | editor |
| POST | `/projects/:id/scenarios/:sid/runs` | `{ label? }` (default: the scenario's name) | `201 { run, removedRunIds, applied, classified }`, as `POST …/runs`: `run` is `RunMeta & { summary }` with `scenarioId`. `422 { error: "an op of this scenario doesn't apply to its base run", details: { problems: string[] } }` when any op doesn't apply (a result with an op silently skipped would not be the scenario); `409` when the base can't be rebuilt; `400 model run failed: …` as for any run | editor |
| POST | `/projects/:id/scenarios/:sid/rebase` | `{ baseRunId, dryRun? }` | `200 { scenario, applied, problems, classified }`: the ops re-applied to the other base; `problems` lists each op that no longer applies (`op 2 (node.set): node … not found`). Saves the new base (the ops are kept as they are, so a run is refused until they apply) unless `dryRun: true`. Same base checks as `POST`; `409` when the scenario isn't a draft (not for a dry run) | editor |

- `Scenario = { id, name, description, baseRunId, baseRun: { id, label,
  createdAt }, ops: ScenarioOp[], opsSha256, ownedNodeIds, opNames, ownerUserId,
  owner, status, createdAt, updatedAt, runCount, lastRun: { id, label,
  createdAt } | null }`. `opsSha256` is the SHA-256 hex of the ops as RFC 8785
  canonical JSON (engine `canonicalJson`); a run of the scenario records the
  same hash. `owner` is a display name. `ownedNodeIds` are the proposer's own
  nodes: ops on them are proposals, everything else a baseline assumption.
  `opNames: { id, name }[]` (sorted by id; 044) names every node and crop the
  ops name, as the base run's snapshot named it when the ops (or the base)
  were written: the server keeps a name a later base no longer has while an
  op still names that id, and the current base's name wins. Display only;
  it isn't part of `opsSha256`, and clients don't send it.
- `check = { applied: AppliedOp[], problems: string[], classified: ('proposal'
  | 'baseline')[], renamed?, reIds? }`: the ops applied to the base (engine `applyScenario`,
  `classifyScenario`); `classified[i]` is `ops[i]`'s class. `check` is `null`
  and `checkError` says why only if the base can't be rebuilt. `renamed:
  { kind: 'node' | 'crop', id, name, as }[]` (viewer and up only, never a
  contributor; also on a scenario run's response) lists an application's
  hidden farms and crops given a suffixed name in its runs because the
  applicant gave one of theirs that name (049, [scenarios.md §
  Applications](./scenarios.md#applications-wp-33)); always `[]` for a team
  scenario. `reIds: { kind: 'crop' | 'transfer' | 'landCover' | 'borehole',
  id, as }[]` (the same readers) lists the items an application added under
  the id of one its applicant can't see, and the fresh id each has in its
  runs; always `[]` for a team scenario.
- **Ops** are validated by the engine's `validateScenarioOps` (every error by
  path: `400 { error: "invalid request", details: [{ message: "ops[3].value: must be at most 1" }] }`),
  with every id a UUID (`ops[0].nodeId: must be a UUID`), at most 500. Whether
  an op's target exists depends on the base, so that is a `problem`, not a
  `400`: a draft may hold ops that don't apply (after a rebase), and only a
  run refuses them.
- **Farmers** get `403` on every route, like every viewer route: a scenario's
  ops and base name every farm. A scenario's base run is **cited**: it can't
  be deleted, trimmed or unpinned while the scenario exists
  ([Runs](#runs)).
- The **Min role** column above is for a team scenario. A contributor may call
  the scenario routes too, for applications ([Applications](#applications)).
- Since 045 `Scenario` also has `origin: 'team' | 'applicant'`,
  `submittedAt`, `decidedAt`, `decidedBy` (a display name), `outcome:
  'approved' | 'approved_with_conditions' | 'refused' | null`,
  `decisionNote` and `members: { userId, displayName }[]`; `baseRun.label` is
  `''` and `baseRun.createdAt` `null` for a caller who can't read the run.
- `GET /projects/:id/scenarios/:sid/base` → `{ baseRunId, settings, model,
  anonymisedNodeIds }`: the base run's settings and model as the caller may
  see them, for the op editor. For a viewer and above, as stored
  (`anonymisedNodeIds: []`); for a contributor, the applicant projection
  below. Min role: contributor (any reader of the scenario).

### Applications

An **application** is a scenario made by a **contributor** (WP-3.3,
migrations 044/045, [scenarios.md § Applications](./scenarios.md#applications-wp-33)):
`origin: 'applicant'`, on a **published** run, read by its owner and the
people they share it with, by editors once submitted and by viewers once
decided. A team scenario (an editor's) is unchanged, and the workflow routes
below work on it too, for an editor.

| Method | Path | Body | Response | Who |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/scenarios` | – | as above; a contributor gets their own applications and those shared with them | contributor |
| POST | `/projects/:id/scenarios` | `{ name, baseRunId, description?, ops? }` | as above. A contributor's `baseRunId` must be a published run (current or in the history): `404 published run not found` otherwise, as if it didn't exist; `409` when that published run is a forecast run (as for a team scenario). `ownedNodeIds` are their farm links (sending any is `403`) | contributor (a viewer: `403`) |
| PATCH | `/projects/:id/scenarios/:sid` | `{ name?, description?, ops? }` | as above; only the owner (`403` for anyone else, the assessors included). `status` is `409` on an application (use the routes below), `ownedNodeIds` `403` | owner of the application |
| DELETE | `/projects/:id/scenarios/:sid` | – | `204`, a draft or withdrawn one; its runs that nothing keeps go with it | owner of the application |
| POST | `/projects/:id/scenarios/:sid/runs` | `{ label? }` | as above; for a contributor `run` is metadata only (`id, label, engineVersion, startDate, endDate, createdAt, scenarioId`: the summary names every farm) and the application keeps its newest 5 runs | its owner or a shared member, or an editor; not a viewer |
| POST | `/projects/:id/scenarios/:sid/rebase` | as above | as above; a contributor's new base must be published | owner of the application |
| POST | `/projects/:id/scenarios/:sid/submit` | – | `200 { scenario, check, checkError }`: `draft → submitted`, the ops (and their hash), base and own nodes frozen. `422` with `details.problems` when any op doesn't apply; `409` unless a draft | its owner (a team scenario: an editor) |
| POST | `/projects/:id/scenarios/:sid/withdraw` | – | `submitted → withdrawn`; `409` otherwise | its owner (team: an editor) |
| POST | `/projects/:id/scenarios/:sid/reopen` | – | `withdrawn → draft`; `409` otherwise | its owner (team: an editor) |
| POST | `/projects/:id/scenarios/:sid/decide` | `{ outcome: 'approved' \| 'approved_with_conditions' \| 'refused', note?: ≤ 4000 }` | `submitted → decided`, with `decidedAt`, `decidedBy`; final. `403` for the application's own owner; `409` unless submitted | editor |
| GET | `/projects/:id/scenarios/:sid/share-candidates` | – | `{ candidates: { userId, displayName }[] }` (049): whom the owner may share it with. For a contributor, the other contributor-or-above members of their own applying party (`project_member.party`, set by the project owner); nobody without a party. For a viewer and up, every contributor-or-above member. Names only. `409` for a team scenario | owner of the application |
| POST | `/projects/:id/scenarios/:sid/members` | `{ userId }`, or `{ email }` for a viewer and up | `201 { members }` (`200` if already shared). `{ userId }`: `404 not someone you can share this application with` for every id not among the candidates, a member or not. `{ email }` from a contributor: `403`, whatever the address (an applicant never probes an address); from a viewer and up, `404 no contributor or above on this project has that address` for an unknown address, a non-member or a farmer alike. `409` for a team scenario or yourself | owner of the application |
| DELETE | `/projects/:id/scenarios/:sid/members/:userId` | – | `204`; the owner removes anyone, a member removes themselves | owner, or that member |
| GET | `/projects/:id/applications` | – | `{ applications: Scenario[] }`: every application not a draft, newest submission first | editor |

- **What a contributor sees of the base** (`…/base`): the settings, their own farms and the gauges in full, every
  other node by kind and place under an anonymous name ("Farm 3") with its
  values blanked, and only their own farms' crops, crop areas, transfers and
  land cover (D2's recommended default, pending the client). The check's
  messages quote only those names, and a name taken only by something hidden
  collides with nothing (049: the application is checked in its applicant's
  namespace, [scenarios.md § Applications](./scenarios.md#applications-wp-33)).
  They never
  receive a run's inputs or summary: `GET …/runs…` and `GET /compare/runs`
  answer them `403`.
- A contributor linked to a farm also reads its farm view
  (`GET /projects/:id/farm…`) as a farmer would.

## Sign-offs

A registered professional signs a run (roadmap WP-3.13, migration 036;
[data-model.md § Sign-offs](./data-model.md#sign-offs-036_signoffsql)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/signoffs` | – | `{ statement, statementSha256, disclaimer: { version, status }, cannotSign, signoffs: Signoff[] }` (oldest first). `cannotSign` is why the caller can't sign (`requires editor role`, or the legacy-run reason, or the forecast-run one, WP-2.12), `null` when they can | viewer |
| POST | `/projects/:id/runs/:runId/signoffs` | `{ fullName, registrationBody, registrationNo, scope, confirmed: string[], statementSha256 }` | `201 { signoff }`. `409` when `statementSha256` isn't the current statement's (it changed since it was shown: read it again); `400` when a confirmation id is missing from `confirmed`; `409` for a legacy run (workbook comparison only, audit H1), or a forecast run (`409`, WP-2.12: a sign-off is judged on the record, and a forecast run's last days are modelled on forecast rain) | editor |

- `statement` is the engine's `signoffStatement(run)`: `{ version, runId,
  engineVersion, scenario, confirmations: { id, text }[], limitations:
  Limitation[], notes: string[], disclaimerVersion }`. `statementSha256` is
  the SHA-256 hex of its RFC 8785 text (`signoffStatementText`); a sign-off
  sends it back and the server recomputes it.
- `Signoff = { id, runId, fullName, registrationBody, registrationNo, scope,
  statementVersion, statementSha256, disclaimerVersion, signedAt, mine }`.
- There is no route to change or remove a sign-off, and RLS allows neither. A
  signed run is **cited** ([Runs](#runs)): it can't be deleted or trimmed.
  Each sign-off is in the project's history (`signoff.created`).

## Allocations

Registered and licensed water-use volumes per farm or water user, and a run's
modelled use against them (roadmap WP-3.10, migration 038,
[allocations.md](./allocations.md)). The app compares; it never decides
whether a use is lawful.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/allocations` | – | `{ allocations: Allocation[], sources: AllocationSource[], nodes: { id, name }[], canSeeHolders }`: `nodes` are the farms and water users a row can be matched to; `canSeeHolders` is true for editors and owners | viewer |
| POST | `/projects/:id/allocations` | `AllocationInput` | `201 { allocation }`. `400` for a node that isn't a farm or water user of this project, dates out of order, a volume < 0; `409` past 5 000 allocations per project | editor |
| PATCH | `/projects/:id/allocations/:aid` | any `AllocationInput` fields (at least one) | `200 { allocation }`; `holder: ''` removes the name | editor |
| DELETE | `/projects/:id/allocations/:aid` | – | `204` | editor |
| POST | `/projects/:id/allocations/import` | `{ kind: 'warms_extract' \| 'csv', fileName, text, reference? }` (`text` ≤ 2 MB) | `200 { fileName, kind, sha256, columns, ignoredColumns, rows: PreviewRow[], nodes, summary: { rows, valid, invalid, matched, unmatched } }`. **Writes nothing.** `422` for a file it can't take (with why: personal-information columns, no volume column, empty, too many rows, an unterminated quote); `409 this file was already imported (…)` for the same SHA-256 | editor |
| POST | `/projects/:id/allocations/import/commit` | the import body + `matches: { "<line>": nodeId \| null }` | `201 { source, imported, skipped, unmatched }`: the file is parsed again (no state is kept between preview and commit) and its valid rows stored with the file's name and hash; rows with problems are skipped. `400` for a match to a node that isn't a farm or water user; `422` when no row can be imported | editor |
| DELETE | `/projects/:id/allocations/sources/:sourceId` | – | `204`: the import and every allocation it brought | editor |
| GET | `/projects/:id/allocations/export.csv` | – | CSV in the template's columns plus `source_file`, `source_sha256`; the `holder` column only for editors and owners; formula-looking cells prefixed with `'` | viewer |
| GET | `/projects/:id/runs/:runId/allocations` | `?tolerance=` (0 ≤ τ < 1, default 0.1) | `{ run: { id, label, startDate, endDate }, comparison: AllocationComparison }` (engine `compareAllocations`, [model.md §2.12](./model.md#212-allocations-modelled-use-vs-registered-volume-roadmap-wp-310)) | viewer |

- `Allocation = { id, nodeId, nodeName, sourceId, registrationNo,
  propertyRef, holder, authorisation, purpose, waterSource, volumeM3PerYear,
  storageM3, validFrom, validTo, reference, createdAt, updatedAt }`. `holder`
  is `null` for a viewer (RLS hides `allocation_holder`), and when there is
  none. `sourceId` is `null` for a row typed into the app.
- `AllocationInput = { nodeId: uuid | null, registrationNo?, propertyRef?,
  holder?, authorisation: 'registration' | 'licence' | 'general_authorisation'
  | 'existing_lawful_use', purpose?: 'irrigation' | 'domestic' | 'livestock'
  | 'industry' | 'mining' | 'municipal' | 'other', waterSource: 'surface' |
  'groundwater', volumeM3PerYear, storageM3?, validFrom?, validTo?,
  reference? }` (dates `YYYY-MM-DD`).
- `AllocationSource = { id, kind, fileName, sha256, reference, importedAt,
  importedBy, rows }`.
- `PreviewRow` is a parsed row (`line`, the fields, `errors: string[]`) with
  `nodeId`, `matchedBy` (`registration` | `property` | `name` | `manual` |
  `null`) and `alreadyInProject` (the registration number is already there).
- `AllocationComparison = { tolerance, startDate, endDate, nodes: [{ nodeId,
  name, kind, surface, groundwater, storage: { registeredM3,
  modelledCapacityM3 } }], unmatchedAllocationIds, notInRunAllocationIds }`;
  `surface` / `groundwater` = `{ waterSource, allocationIds, years: [{
  waterYear, days, yearDays, partial, modelledM3, registeredM3, ratio, status
  }], yearsOver, wholeYears, meanModelledM3PerYear, meanRegisteredM3PerYear }`,
  `status` ∈ `over` | `within` | `under` | `unregistered` | `none`.
- **Farmers** get `403` on every route, like every viewer route; RLS already
  limits them to their own farms' allocations for the farm view to come.
- History: `allocation.created/changed/deleted/imported/import_deleted`; the
  preview is exempt (it writes nothing).

## Publication

The run the project's stakeholders see, with the WUA's restriction notice
(roadmap WP-2.3, [data-model.md § Publications](./data-model.md#publications-022_publicationsql)).
Publishing projects the run once, per farm and for the catchment, with the
engine's `farmProjection` / `catchmentView`
(`packages/engine/src/views/farmProjection.ts`), over the **season**: 1
October (the water year's start) to the run's last day, never over the
modeller's report window (design [farmer-view.md §2](./design/farmer-view.md#2-where-the-figures-come-from)).
`dataUntil` is the last day of observed rain in the run's input snapshot
(the catchment gauge or CHIRPS): a run that goes on past it on forecast
rain is projected only to there, so forecast days never count as water
received. For a **forecast run** (WP-2.12) it is the day before
`summary.forecast.from`, and each farm's projection gains `forecast` (below).
(An ordinary run no longer goes past the record at all: [Runs](#runs).)

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/publication` | – | `{ current: Publication \| null, history: PublicationMeta[] }`, newest first, the current one included (at most 12) | farmer |
| POST | `/projects/:id/publication` | `{ runId, note?, restriction?, nextExpectedOn? }` | `201 { publication, farms }`: supersedes the current publication; `farms` is how many farm projections were stored (every farm of the run that is still a farm of the project). `400` for a run not in this project; `409` for a legacy-runoff-model run (a workbook comparison, not evidence) or a run too old to project (from before engine 0.17.0, which has no EWR charge series) | editor |
| PATCH | `/projects/:id/publication/:pubId` | `{ note?, restriction?, nextExpectedOn? }` (at least one) | `{ publication }`: the notice, the note or the next date change without re-publishing; stamps `updatedAt` / `updatedBy`. `409` for a superseded publication | editor |

- `restriction = { level: 'none' | 'advisory' | 'restricted', pct?: 0–100 | null, noticeEn?: string | null, noticeAf?: string | null }`.
  A change replaces the whole notice. `pct` is stored to two decimals and is
  refused with `none`. Notices and the note are trimmed, at most 2 000
  characters, no NUL; an empty notice is none. `nextExpectedOn` is a date
  (`YYYY-MM-DD`) or `null` (design E10). Without `restriction` a
  publication has none.
- `PublicationMeta = { id, runId, publishedAt, publishedBy, restriction: { level }, supersededAt }`;
  `publishedBy` is a display name (`null` once that account is gone).
- `Publication = PublicationMeta & { note?, restriction: { level, pct, noticeEn, noticeAf }, nextExpectedOn, catchmentView, updatedAt, updatedBy }`.
  `note` is the modeller's note to the project's staff: returned to viewers
  and above only, never to a farmer.
- `catchmentView = { runStart, dataUntil, runDays, season: { from, to, days }, last30: { from, to, days }, farmCount, sites: { name, isOutlet, daysNotMet: { run, season, last30 } }[], engineVersion, runoffModel, calibration: { nse, pbias, kge } | null }`:
  what every member, farmers included, reads about the catchment. Counts
  and dates only: no flow volume and no total of farm quantities (design
  §10.3; the roadmap's "mean natural and simulated flow" and "totals at ≥ k"
  are left out on purpose, since `run_publication` is readable by farmers).
  `sites` are the EWR sites, the outlet first, then the gauges.
  Viewers and above also get `recent = { to, from7, from30, farmsShort7, farmsShort30 }`
  (publications made since WP-2.14): farms short at least one day in the 7
  and 30 days to `dataUntil`, for the [portfolio](#portfolio). A farmer's
  response leaves it out, since with few farms a count says which neighbour
  went short, and the share link's allowlist never copies it.
- A project keeps its newest **12** publications; an older one is deleted
  with its farm projections, and its run becomes trimmable again.
- Nothing here is audited yet beyond the `updatedAt` / `updatedBy` stamp:
  the audit log is WP-2.4.

## Share

Read-only links to a project's **current** publication for people outside
the project (roadmap WP-2.3 phase 2; `025_share_links.sql`,
[security.md § Share links](./security.md#share-links)). An owner makes a
link; whoever holds it opens `/share#t=<token>` signed out and sees the
catchment-level result: the project name, who published it and when, the
WUA's notice and the EWR days-not-met counts. Never the modeller's note, and
never a farm's row, name or id.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/share-links` | – | `{ links: ShareLink[] }`, newest first, revoked and expired ones included | owner |
| POST | `/projects/:id/share-links` | `{ label: 1–100 chars, expiresInDays: 1–365 (whole) }` | `201 { link: ShareLink & { url } }`. `url` is `${SITE_URL}/share#t=<token>`: the **only** time the token is sent; it isn't stored, so it can't be shown again | owner |
| DELETE | `/projects/:id/share-links/:linkId` | – | `204`: sets `revokedAt` / `revokedBy` (already revoked is `204` too; another project's link `404`). A link is never deleted | owner |
| POST | `/share/view` *(public)* | `{ token }` | `ShareView` (below), `Cache-Control: no-store` | – |
| POST | `/share/series` *(public)* | `{ token, key }` | `ShareSeries` (below), `Cache-Control: no-store` | – |

- `ShareLink = { id, label, createdAt, createdBy, expiresAt, revokedAt, revokedBy, lastUsedAt }`
  (`createdBy` / `revokedBy` are display names, `null` once that account is
  gone). `lastUsedAt` moves at most once an hour, on a `/share/view`.
- `ShareView = { project: { name }, publication: { publishedAt, publishedBy, catchmentView, restriction: { level, pct, noticeEn, noticeAf }, nextExpectedOn } }`.
  `catchmentView = { runStart, dataUntil, runDays, season, last30, farmCount, sites }`,
  the publication's [`catchmentView`](#publication) cut to an allowlist
  (no `engineVersion`, `runoffModel` or `calibration`), and the outlet's
  `name` is `null`: the outflow node may be a farm. Gauge names stay
  (public infrastructure).
- `ShareSeries = { key, label, unit, monthly: { startMonth: 'YYYY-MM', values }, recent: { startDate, values } }`:
  one catchment series of the published run as monthly means (m³/day; a
  month without a value is `null`) from the run's first month, and the last
  365 days daily. `key` must be one of `natural_flow`, `simulated_outflow`,
  `observed_flow`, `ewr`, `ewr_shortfall`. It answers only when the
  catchment has at least `FARMER_K` = 5 farm **holders** (farms linked to one
  user count once, an unlinked farm on its own; design
  [farmer-view.md §10.3](./design/farmer-view.md#103-decisions-this-design-takes-for-the-client-to-confirm)):
  in a smaller catchment the flows would reveal the farms' use.
- Every dead link answers the same `404 { error: "not found" }`: unknown,
  malformed, revoked or expired token, or nothing published. `/share/series`
  answers the same `404` for a key off the allowlist (every farm key), a key
  the run doesn't have (`observed_flow` without observed data), and below
  `k` holders. A body without `token` (or `key`) is `400`.
- No session and no rate limit of its own: the WAF's per-IP limit on `/api/*`
  covers both reads, and a 256-bit token can't be guessed.
- Creating and revoking are recorded on the row (`createdBy`, `revokedAt`,
  `revokedBy`), not yet as audit events (WP-2.4,
  [followups.md](./followups.md)).

## Notes

Plain-text notes and comments on a node, a run, a settings group or the
project (WP-2.7; [data-model.md § Notes](./data-model.md#notes-037_notessql)).
The min role is **farmer** on every route, and RLS does the scoping: a farmer
reads and writes only `farm` notes on their linked farms, and never sees a
`team` note.

| Method | Path | Body / query | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/notes` | `?nodeId=&runId=&settingKey=&target=project\|node\|run\|setting&limit=1..500` (default 100) | `{ notes: Note[] }`, newest first; deleted notes are never listed. `settingKey` matches the key and its sub-keys by whole segment (`flow` → `flow`, `flow.a`, not `flowshare`) | farmer |
| GET | `/projects/:id/notes/counts` | – | `{ project, nodes: { [nodeId]: n }, runs: { [runId]: n }, settings: { [key]: n } }`: the notes the caller can see, per target (the count badges) | farmer |
| POST | `/projects/:id/notes` | `{ body: 1–4000 chars (trimmed), nodeId? \| runId? \| settingKey?, visibility?: 'team' \| 'farm' }` | `201 { note }`. At most one target (`400`). `visibility` defaults to `team`, or `farm` for a farmer; `farm` needs a farm node (`400`). A farmer may add only a `farm` note on their own farm (`403`); an unknown or invisible node or run is `404` | farmer |
| PATCH | `/projects/:id/notes/:noteId` | `{ body }` | `{ note }` with `editedAt` set. Author only (`403`) | farmer |
| DELETE | `/projects/:id/notes/:noteId` | – | `204`: a soft delete, recorded as `note.deleted`. The author or an editor (`403`); a deleted or unknown note is `404` | farmer |

- `Note = { id, body, author, createdAt, editedAt, target: 'project' | 'node' | 'run' | 'setting', nodeId, nodeName, runId, settingKey, visibility, mine, canDelete }`.
  `author` is a display name (`null` once that account is gone); `nodeName`
  is the node's name when the caller can see it; `mine` = the caller wrote
  it (and may edit it); `canDelete` = the author or an editor.
- `body` is plain text. Clients render it escaped, never as HTML or markdown.

## Ingest

Per-project API keys, and the endpoint a logger gateway or a script pushes
daily readings to without a session (roadmap WP-2.9; `039_api_keys.sql`,
[security.md § API keys](./security.md#api-keys),
[data-model.md § API keys](./data-model.md#api-keys-039_api_keyssql)). A key
belongs to one project and can merge days into that project's series
(optionally only some of them), and nothing else.

### Managing keys (owner, session)

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/api-keys` | – | `{ keys: ApiKey[] }`, newest first, revoked and expired ones included | owner |
| POST | `/projects/:id/api-keys` | `{ name: 1–100 chars, scopes?: ["series:write"], allowedSeries?: { kind, name }[] (1–50) \| null, expiresInDays?: 1–3650 (whole) \| null }` | `201 { key: ApiKey, secret: "wm_…" }`, `Cache-Control: no-store`. `secret` is the key: the **only** time it is sent; only its SHA-256 is stored, so it can't be shown again | owner |
| DELETE | `/projects/:id/api-keys/:keyId` | – | `204`: sets `revokedAt` / `revokedBy` (already revoked is `204` too; another project's key `404`). A key is never deleted (audit events name it) | owner |

- `ApiKey = { id, name, prefix, scopes, allowedSeries, createdAt, createdBy, lastUsedAt, expiresAt, revokedAt, revokedBy }`.
  `prefix` is the first 8 characters of `id`, the `wm_<prefix>_…` part of
  the key. `allowedSeries` `null` = any series of the project; `expiresAt`
  `null` = until revoked. `createdBy` / `revokedBy` are display names.
  `lastUsedAt` moves at most once a minute. Never the key or its hash.
- A repeated `{ kind, name }` in `allowedSeries` counts once. Unknown fields
  are `400`.
- Recorded as `api_key.created` / `api_key.revoked` in the History (id,
  name, prefix, scopes, allowed series, lifetime).

### The ingest endpoint (API key)

Send the key as `Authorization: Bearer wm_<prefix>_<secret>`. No cookie, no
CORS (gateways aren't browsers), JSON bodies only.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/ingest/v1/whoami` | – | `{ project: { id, name }, key: { id, name, scopes, allowedSeries } }` |
| POST | `/ingest/v1/series/merge` | the body of [`POST /projects/:id/series/merge`](#time-series) (`kind`, `name`, `unit`, `startDate`, `values`, optional `product` / `productVersion` / `dayBoundary`), plus an optional `source` (≤ 100 chars, a free label kept in the audit subject) | `200 { series: SeriesMeta, daysChanged, rerunQueuedFor: iso \| null, rerunHeld: HeldDays \| null }`, `Cache-Control: no-store` |

- **The merge** is the same sequence as the UI's (`series/merge.ts`
  `mergeInto`): the series is created if it doesn't exist, only the days sent
  are touched (a `null` clears a day), units are converted to the kind's
  canonical unit, and the version and day-boundary guards answer `409` as
  they do there. It is recorded as `series.created` / `series.merged` by the
  key (`actor_label` `API key “<name>”`); unlike a person's merge it keeps no
  series revision (a logger's merges are append-mostly, like a data feed's).
- **Idempotent.** Re-sending the same days and values changes nothing,
  answers `daysChanged: 0` and records nothing.
- `rerunQueuedFor`: when the project's automatic re-run is due (ISO), when the
  merge changed days and the project has automatic runs on (WP-2.11,
  [architecture.md § Automatic runs](./architecture.md#automatic-runs)); it
  runs as the key's creator. `null` otherwise, and when the key's creator's
  account was deleted: the re-run is skipped, the days are still merged.
- `rerunHeld` (WP-2.16): `{ negative, outlier, examples: { date, value }[] }`
  when days this push carried look wrong by the engine's data-quality rules
  (a negative rain or flow; a value above the outlier limit of the series
  it lands in, taken without this push's days, once that series has 100
  or more non-zero days), else
  `null`. The days are merged all the same, `series.held` is recorded as
  the key (with the counts, up to 5 examples and the `source` label), no
  re-run is queued (`rerunQueuedFor: null`), and every automatic re-run
  waits, doing nothing, until a person runs the model
  ([security.md § API keys](./security.md#api-keys)).
- **Errors.** `401 { error: "invalid or missing API key" }` (with
  `WWW-Authenticate: Bearer`) for a missing, malformed, unknown, wrong,
  revoked or expired key, one message for all; `403` for a series not in
  `allowedSeries`, or a scope the key lacks; `429` with `Retry-After`
  (seconds) past the rate limit; `400` for a body that isn't valid; `413`
  when the series would pass 60 000 days.
- **Rate limit.** A token bucket per key: 60 requests, refilled at 60 a
  minute. Every authenticated request counts, failed ones included.
- **Revocation** applies to the next request: the key is checked on every
  request, and again by RLS on every statement.

Push one day with `curl` (the Settings panel shows the same example):

```bash
curl -X POST https://<host>/api/ingest/v1/series/merge \
  -H "Authorization: Bearer $WM_INGEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"flow_logger_m3s","name":"Weir","unit":"m3/s","startDate":"2026-09-25","values":[0.42]}'
```

## Farm

The farmer's farm view (roadmap WP-2.6 API; design
[farmer-view.md](./design/farmer-view.md)), from the project's **current**
publication. Every route admits the `farmer` role and viewer and above too
(the WUA previews a farm as its farmer sees it). A farmer reaches only the
farms linked to them: any other node, a gauge, or a node that doesn't exist
answers `404 { error: "not found" }` alike. A farm with nothing published for
it (no current publication, or a farm added since) answers `404 { error: "not published yet" }`.
No response names another node, by id or name, beyond the gauges (public
infrastructure). The contract types are `FarmIndex` and `FarmView` in
`packages/engine/src/views/farmView.ts`.

| Method | Path | Response | Min role |
| --- | --- | --- | --- |
| GET | `/projects/:id/farm` | `FarmIndex = { project: { id, name }, farms: { nodeId, name }[], publication: { publishedAt, restriction: { level } } \| null }`: a farmer's linked farms, every farm for viewer and above | farmer |
| GET | `/projects/:id/farm/:nodeId?lang=en\|af` | `FarmView = { project, farm: FarmProjection, context, publication, outlet30, stale }` (below) | farmer |
| GET | `/projects/:id/farm/:nodeId/export.csv?from=&to=` | The farm's own daily CSV from the published run: `date` + the farm allowlist (`demand`, `supplied`, `deficit`, `dam_storage`, `spill`, `transfer`), the export CSV's rules ([Export](#export)); the whole run by default, `from` / `to` narrow it (`400` outside the run, `413` past 5 MB) | farmer |
| GET | `/projects/:id/farm/:nodeId/access` | `{ people: { displayName, role, you }[] }`: "Who can see my farm", everyone who can read this farm's figures (its linked farmers, and every viewer-and-above member, direct or through the team, at their effective role), by name, **never an email** (`app_farm_access`, 022). `404` for anyone who can't open the farm | farmer |

- `farm` is the stored `FarmProjection` (season and last-30 totals, the dam,
  last season from the same run, the 12 months to `dataUntil`, the river's
  share with the E7 headline and its band). `farm.river.equitableFraction`
  and `aboveBelowShareM3Day` are `null` when the viewer has fewer than
  `FARMER_K − 1` = 4 other holders (`app_other_farm_holders`, design §10.3
  D2), and `cutBeyondShare` is `false` (it is measured against the even
  share, so it would bound it); the stored projection keeps them.
  `farm.forecast = { from, to, days, madeOn, minDamPct, minDamDate,
  deficitDays, suppliedFraction }` only when the published run is a forecast
  run (WP-2.12): that farm's forecast days from the run's `summary.forecast`,
  `madeOn` the day the run was made (UTC); nothing about any other farm.
- `context = { farmsUpstream, farmsDownstream, farmCount }` from
  `app_farm_context`: counts only.
- `publication = { publishedAt, publishedBy, engineVersion, restriction: { level, pct, notice, noticeLang? }, nextExpectedOn }`.
  `notice` is in the `lang` asked for (default `en`), or in the other
  language when that one is empty; `noticeLang` says which (absent without
  a notice).
- `outlet30 = { name, daysNotMet, days }`: the outlet over the 30 days to
  `dataUntil`, counts only.
- `stale` is `dataUntil` older than 7 days (the workspace's `STALE_DAYS`)
  when the response was built.
- The chart series route (`…/farm/:nodeId/series`) and the publication
  history per farm (`…/history`) are not built yet (WP-2.6).

## Jobs

Background work (the job queue, [architecture.md § Background work](./architecture.md#background-work)).
A job runs later, in the worker, as the editor who queued it.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/jobs?status=&limit=` | – | `{ jobs: JobMeta[] }`, newest first. `status` ∈ `queued`, `running`, `done`, `failed`, `dead` (`400` otherwise); `limit` 1–200, default 50 | viewer |
| POST | `/projects/:id/jobs` | `{ kind: "rerun", label? }` | `202 { job: JobMeta, created: true }`: a model run is queued, due now. If one is already pending (queued, or failed and waiting to retry; an automatic re-run included, which may be due later) the answer is `200 { job, created: false }` with that job, and nothing new is queued. `label` as for `POST /runs` (trimmed, ≤ 200). Only `rerun` is accepted (`400`), and no other field (a client can't queue an automatic re-run) | editor |

- `JobMeta = { id, kind, status, attempts, maxAttempts, runAfter, createdAt, startedAt, finishedAt, error, createdBy, progress }`.
  Never the payload, and nothing about the worker's lease. `progress`
  (040_yield) is 0–100 while a job that reports it runs (a `yield` job),
  null otherwise; it resets when the job is claimed again, and a finished
  job keeps its last value.
- `status`: `queued` (due at `runAfter`) → `running` → `done`; or `failed`
  (an attempt failed; the next is due at `runAfter`, `2^attempts` minutes on)
  → … → `dead` (out of attempts, or a failure no retry can fix).
  `finishedAt` is set for `done` and `dead`. Finished jobs are deleted after
  30 days.
- `error` is written by the server, never raw database text: an engine
  refusal as `model run failed: …` (the same reason `POST /runs` gives),
  `the user who queued this job no longer has the editor role on the project`
  when the queuer lost the role before it ran (the job fails closed and
  writes nothing), or a generic `an internal error` /
  `a database error (SQLSTATE …)`.
- A queued re-run is `POST /runs` off the request path: the same engine run,
  the same 20-run cap, as the editor who queued it. It appears in
  `GET /runs` once the job is `done`.
- `GET /jobs` also lists the automatic re-runs new data queues (`kind:
  'rerun'`, `runAfter` the debounced due time; WP-2.11). One pending re-run
  per project, automatic or not.
- `GET /jobs` also lists the data feeds' `feed_fetch` / `feed_ingest` jobs
  ([§ Data feeds](#data-feeds)); they are queued by the server, never through
  `POST /jobs`. It lists `yield` jobs too, queued through `POST /yield`
  ([§ Yield](#yield)).

## Yield

A dam's historical firm yield, its yield at an assurance level, or its
storage–yield curve (roadmap WP-3.6, [model.md §2.13](./model.md#213-firm-yield-and-storageyield-engine--0340-roadmap-wp-36)),
worked out by a background `yield` job on a saved run's stored inputs or on a
scenario (its ops on its base run's inputs), never the live model.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/yield` | `{ nodeId, runId \| scenarioId, kind, params? }` | `202 { jobId, job: JobMeta, created: true }`. The same request while one is pending (queued, or failed and waiting to retry) is `200 { jobId, job, created: false }` with that job | editor |
| GET | `/projects/:id/yield?runId=\|scenarioId=&nodeId=&jobId=` | – | `{ results: YieldResult[] }`, newest first, at most 50: one of `runId` / `scenarioId` (or `jobId` alone), optionally one node | viewer |
| POST | `/projects/:id/yield/:jobId/cancel` | – | `200 { status, cancelled }`: a queued or retrying job is `dead` at once (its `error` is `cancelled`); a running one stays `running` until its next progress report, then goes `dead` with nothing stored. `404` for a job that isn't a yield job of this project, or isn't yours to cancel | the user who queued it, or an editor |

- `kind`: `firm` (one yield at the dam's own capacity) or `curve` (the yield
  at `points` capacities evenly from 0 to 2 × the dam's).
- `params` (strict; every field optional): `pattern` `constant` (default),
  `demand` (the farm's own irrigation demand by month) or 12 non-negative
  factors Oct–Sep; `assurance` 0.5–1 (default 1, the firm yield: no failure
  day in the record; below 1, the share of water years allowed a failure is
  1 − assurance); `tolerance` 0.00001–0.05 (default 0.001, relative);
  `points` 8–12 (default 11).
- Checked before anything is queued: exactly one of `runId` and
  `scenarioId` (`400`), a run or scenario of this project (`404`), a run
  rebuilt from stored inputs (`409`, as for a scenario's base), a scenario
  whose ops all apply (`422 { details: { problems } }`), a node of that run
  or scenario (`400 that node is not in this run or scenario`), a farm or dam,
  not a gauge or other user (`400`), and a dam with a capacity above 0 for a
  curve (`400`).
- **At most 2 yield jobs queued or running per user** (`429`); a repeat of a
  pending request is never refused. A job gets 2 attempts.
- `YieldResult = { id, runId, scenarioId, nodeId, jobId, kind, params,
  points, engineVersion, createdBy, createdAt }`. `params` is the request's,
  with its defaults. `points` is `{ point: YieldPoint }` for `firm`, or
  `{ baseCapacityM3, assurance, points: YieldPoint[], monotone }` for
  `curve`. `YieldPoint = { capacityM3, yieldM3Day, yieldM3Year, failsAtM3Day,
  failureDays, failedYears, boundM3Day, probes }` (model.md §2.13).
  `monotone: false` says the yield falls somewhere as the dam grows, which
  can be real (evaporation, a dam starting below its minimum level).
- The job's `error` when it fails: `the model can't run this input: …`,
  `the yield search failed: …` (the engine's words, e.g. `this node has no
  irrigation demand to shape the draft; use a constant pattern`),
  `cancelled`, or the queue's own messages ([§ Jobs](#jobs)). It keeps the
  newest 5 results per run or scenario and dam.
- Every number is **historical** (it replays the one record); the UI says so.

## Data feeds

Scheduled fetches of CHIRPS rainfall, the CHIRPS-GEFS forecast or a DWS
gauge, merged into one series each ([architecture.md § Data feeds](./architecture.md#data-feeds)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/feeds` | – | `{ feeds: FeedMeta[], sources, chirpsProducts, schedules, mode, canEdit, canRun }`. `sources`: `{ source, label, kinds, unit }[]` (what the form offers); `chirpsProducts`: `["sat", "rnl"]`; `mode`: `fixtures` or `live` (whether this server reads synthetic files); `canEdit` (owner), `canRun` (editor) | viewer |
| POST | `/projects/:id/feeds` | `FeedInput` | `201 { feed: FeedMeta }`. `409` if another feed already writes that series, or the project has 20 feeds, or the series holds another CHIRPS product or version (below) | owner |
| PATCH | `/projects/:id/feeds/:feedId` | any of `FeedInput`'s fields | `200 { feed }`. The fields sent replace the saved ones, and the whole is validated again (a new `source` needs its `config`). Saving makes you the feed's acting user; a new source, place or series clears its health. The version check below runs when the save changes the source, the product or the target; `replaceSeries: true` alone confirms replacing the current target | owner |
| DELETE | `/projects/:id/feeds/:feedId` | – | `204`. The series keeps its days | owner |
| POST | `/projects/:id/feeds/:feedId/run-now` | – | `202 { job: JobMeta, created: true }`: a `feed_fetch` is queued, due now, as you. One pending fetch per feed: while one waits, `200 { job, created: false }`, and a pending one waiting for later (a backfill's next window, a retry) is made due now. `409` for a switched-off feed | editor |

- `FeedInput = { source, config, targetKind?, targetName?, schedule?, enabled?, replaceSeries? }`,
  strict (unknown fields are `400`):
  - `source` ∈ `chirps`, `chirps_gefs`, `dws`;
  - `config` for `chirps` / `chirps_gefs`: `{ cells: { lat, lon, weight? }[] }`,
    1–25 cells, lat −60…60, lon −180…180, weight > 0 (default 1); for `dws`:
    `{ station }`, a river gauge's code like `A2H012` (letter, digit, `H`,
    three digits; upper-cased; a reservoir `R`, weather `E` or other station
    is refused, see architecture.md § Data feeds). Both take optional `startDate` (the first fetch's first day,
    and a floor no later fetch reads before; for `chirps`, not before the
    product's first day: `1998-01-01` for `sat`, `1981-01-01` for `rnl`) and `staleAfterDays` (overrides the source's staleness threshold).
    `chirps` also takes `product`: `sat` (the default) or `rnl`, CHIRPS v3's
    two daily products, read end to end, never one spliced onto the other;
  - `targetKind`: one of the source's kinds (`chirps`: `rain_chirps_mm`,
    `rain_catchment_mm`; `chirps_gefs`: `rain_forecast_mm`; `dws`:
    `flow_observed_m3s`, `flow_reference_m3s`, `flow_logger_m3s`), default the
    first; `targetName` ≤ 100 (default `""`); `schedule` `daily` (default) or
    `hourly`; `enabled` (default true);
  - `replaceSeries` (default false): the owner confirms the feed may replace
    its target series, which holds values of another product or version, or
    an unrecorded one. Without it, attaching (or re-targeting, or switching
    the product) onto such a series is `409 { error, details: { code:
    "series_version", holds, writes } }` (`holds` null = unrecorded). With it,
    the feed backfills the new record in a stage (the live series unchanged
    meanwhile) and swaps it in whole once caught up, keeping the old values
    as a restorable series revision. On PATCH, `replaceSeries: false`
    withdraws a pending replacement and discards its stage. A replacement is a
    full backfill: without a `startDate` the feed gets the series' first day
    with a value; a later one, or the `sat` product for a series reaching
    before 1998, is `409 { error, details: { code: "series_backfill", firstDay } }`
    ([architecture.md § Data feeds](./architecture.md#data-feeds)).
- `FeedMeta = { id, source, config, targetKind, targetName, enabled, schedule,
  createdAt, updatedAt, actingUser, lastAttemptAt, lastSuccessAt,
  lastDataDate, lastValue, consecutiveFailures, lastError, lastMeta, health,
  writes, series, versionConflict, replaceFrom, rebuilding }`. `rebuilding`:
  a confirmed replacement being backfilled, `{ startDate, through, updatedAt }`
  (the new record so far and when it last grew), or null. `writes`: the product and
  version the feed writes (`{ product: "CHIRPS sat", version: "3.0" }`; null
  for the forecast and DWS); `series`: the target now, `{ filled, provenance }`
  or null when it doesn't exist; `versionConflict`: the target holds values
  of another product or version, so every fetch is refused until an owner
  confirms (or the replacement is confirmed and waiting: `replaceFrom`, what
  it will replace, `CHIRPS/2.0` or `''` for unrecorded).
  `actingUser` is the display name fetches run as (null once that account is
  deleted: save the feed again). `lastDataDate` is a calendar day
  (`YYYY-MM-DD`, UTC). `lastMeta` is what the source said about the last
  fetch (`days`, `prelimDays`, `issued`, DWS quality-code counts, CHIRPS's
  `product`), plus ours: `merged` (the days it wrote), `kept` (the days it
  left alone because the series held a value the feed didn't write: an
  upload or import, #30), `staged` / `replaced` (a confirmed replacement's
  days staged so far, or the label of what it replaced once swapped in) and
  `through` (the last day the fetch asked for).
- `health = { state, stale, staleAfterDays, reason }`, `state` ∈ `ok`,
  `stale`, `failing`, `pending`, `disabled`. `reason` says why, as a `code`
  and its facts; the client writes the sentence and formats the days (all
  `YYYY-MM-DD`, UTC), so no date is baked into server text:
  - `{ code: "off", newest }` (switched off; `newest` is the newest day or null),
  - `{ code: "failing", failures, error, newest }` (`failures` fetches in a row failed, the last with `error`, which is `lastError`),
  - `{ code: "old-forecast", newest }` (the forecast reaches fewer than `-staleAfterDays` days ahead),
  - `{ code: "old-data", newest }` (the newest day is more than `staleAfterDays` old),
  - `{ code: "no-data" }` (fetches succeed but have found nothing yet),
  - `{ code: "not-fetched", since, after }` (not fetched since it was `attached` / `changed` on `since`: is the worker running?),
  - `{ code: "waiting" }` (waiting for its first fetch),
  - `{ code: "ok", newest, checked }` (`checked` is the last successful fetch's day),
  - `{ code: "rebuilding", from, through }` (state `pending`: a confirmed replacement is backfilling; the live series is unchanged until it completes),
  - `{ code: "rebuild-stalled", from, through, since }` (state `stale`: the same, but it hasn't grown since `since`).

  A client should fall back to the `state` for a code it doesn't know.
  `lastError` is written by the server, never an upstream body or database
  text, e.g. `the source is unreachable: HTTP 503` or `the source’s data could
  not be read: the grid has no data at …`.
- Strangers get `404`; a viewer's writes and an editor's attach / change /
  remove get `403`.

## Reports

Server-side PDFs of the printable report ([ui.md § Report](./ui.md#report);
WP-2.15 Phase B, [architecture.md § Server-side reports](./architecture.md#server-side-reports)).
A `report_render` job prints the report route in headless Chromium, as the
member who asked (or, for a schedule, the editor who saved it), under RLS.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/reports` | `{ runId?, email? }` | `202 { jobId }`: a render of `runId` (the latest run without one) is queued. `email`: `true` emails the link to you; a list of user ids emails it to those members (editors and owners only; `403` for a viewer naming anyone else). `404` a `runId` not in the project; `409` the project has no runs; `429` over 10 on-demand PDFs an hour per user and project | viewer |
| GET | `/projects/:id/reports/:jobId` | – | `{ report: ReportView, url? }`. `url` is a pre-signed download link (an hour) once `status` is `done`. `404` unknown job, or not a report's | viewer |
| GET | `/projects/:id/report-schedules` | – | `{ schedules: ScheduleView[] }` | viewer |
| POST | `/projects/:id/report-schedules` | `ScheduleInput` | `201 { schedule: ScheduleView }`. `409` past 10 schedules per project | editor |
| PATCH | `/projects/:id/report-schedules/:scheduleId` | any of `ScheduleInput`'s fields | `200 { schedule }`. Saving makes you its acting user; changing its timing (or pausing / resuming it) starts it afresh from now | editor |
| DELETE | `/projects/:id/report-schedules/:scheduleId` | – | `204`. PDFs already sent stay until they expire | editor |

- `ReportView = { jobId, status, runId, scheduled, pages, createdAt, finishedAt, error, emailed }`.
  `status` ∈ `queued` → `rendering` → `done`; `retrying` (the render failed
  and will be tried again; up to 3 attempts); `failed` (out of attempts, a
  failure no retry can fix, or, in production, no answer from the renderer
  within an hour). `error` is the server's own text, never raw database or
  browser output: e.g. `the render took longer than 90 s`, `the report page
  did not load: …` (the page's own message), `the run was deleted before its
  report was made`, `the PDF could not be stored`; after a good render, `the
  email to 1 of 2 recipients could not be sent`. `emailed` is how many people
  it was sent to (asked for; each must still be a member when it's sent).
- Recipients (on demand and scheduled) must be **direct members of the
  project with viewer or above**, the Sharing panel's list: never a farmer,
  never an arbitrary address (`400 every recipient must be a member of the
  project who can read its report (a viewer or above)`). The email carries a
  link to `/projects/:id/reports/:jobId` in the app, not the PDF: the reader
  signs in, and the page asks this API for a fresh download link.
- `ScheduleInput = { frequency, weekday?, monthDay?, hour, timezone, enabled?, recipients }`,
  strict: `frequency` `weekly` (needs `weekday` 1 = Monday … 7 = Sunday) or
  `monthly` (needs `monthDay` 1–28); `hour` 0–23 in `timezone` (an IANA zone,
  e.g. `Africa/Johannesburg`, checked with `Intl`); `enabled` default true;
  `recipients` 1–20 user ids.
- `ScheduleView = { id, frequency, weekday, monthDay, hour, timezone, enabled, recipients: { userId, displayName, email }[], actingUser, nextAt, lastSentFor, lastError, updatedAt }`.
  `nextAt` is the next time it will send (never before it was saved; `null`
  when paused). `lastError` says why the last due time sent nothing: `the
  project had no runs to report on`, or `the editor who saved this schedule
  can no longer edit the project: an editor must save it again`.
- A schedule's report is of the project's **latest run** at the time it
  fires, emailed to its recipients. The worker's tick checks schedules every
  pass (every 5 minutes in production) and queues each due time once.
- PDFs are kept for 7 days (the bucket's lifecycle; locally the tick deletes
  them with their rows a day later). Farmers get `403` on every route here.
- `GET /jobs` lists the `report_render` jobs too.
- **The render session** (`POST /auth/render-session`) is for the renderer,
  not people: it exchanges a single-use, 5-minute render token (issued by the
  worker as the requester) for a 10-minute session that may only `GET`
  `/auth/me`, `/projects/:id`, `/projects/:id/series` and
  `/projects/:id/runs/:runId[/…]` of the one project and run; everything else
  answers `403 this session can only read one report`
  ([security.md § Render tokens](./security.md#render-tokens)).

## History

Change history and the audit log (WP-2.4, [data-model.md § Change history and audit log](./data-model.md#change-history-and-audit-log-030_historysql)).
Farmers get `403`.

| Method | Path | Body / query | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/history` | `?before=<next>&limit=1..100&nodeId=&kind=` | `{ items, next, historySince }`, newest first: model revisions (`type: 'revision'`, with their change lines, not the snapshot) and audit events (`type: 'event'`). `kind` is `revision`, an event kind (`series.replaced`) or its noun (`series`); `next` is an opaque cursor (`<ts>\|<type>\|<id>`) | viewer |
| GET | `/projects/:id/history/revisions/:revId` | – | `{ revision, preview }`: the revision with its `snapshot`, and what restoring it would change | viewer |
| POST | `/projects/:id/history/revisions/:revId/restore` | `{ reason? }` | `201 { revision, relink }`: the new revision, and the farmers to re-link to restored farms. `409` when nothing would change or the old model fails today's validation | editor |
| GET | `/projects/:id/runs/:runId/changes-since` | – | `{ changes, revisions }`: the net change of the inputs since the run (`diffInputs`, series by hash) and the model revisions made since it, newest first (≤ 100) | viewer |
| POST | `/projects/:id/runs/:runId/restore-inputs` | `{ reason? }` | `201 { revision, relink }`; `409` for a scenario run, or when nothing would change | editor |
| GET | `/projects/:id/series/:seriesId/revisions` | – | `{ revisions: { id, createdAt, createdBy, reason, startDate, length }[] }` (kept: the newest 5, ≤ 180 days) | viewer |
| POST | `/projects/:id/series/:seriesId/revisions/:revId/restore` | – | the series' `SeriesMeta` (works for a deleted series by its old id) | editor |

`PUT /projects/:id/model` and `PATCH /projects/:id` (with `settings`) take an
optional `reason` (≤ 500 characters), kept with the revision.

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
  a: { project: { id, name }, run: RunMeta & { summary: RunSummary, inputs: RunInputsSnapshot }, scenario: CompareScenario | null },
  b: { … same shape … },
  comparison: RunComparison,    // compareRuns(a.run, b.run) — every delta is b − a
  changes: InputChange[],       // diffInputs(a.run.inputs, b.run.inputs, both runs' stored values of each differing series)
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
  fitPeriodA, fitPeriodB, segmentsA, segmentsB, fitWindowsA, fitWindowsB,
  changed }`: `changed` when any month's applied factor or the water years
  left out of the fit differ, or (engine ≥ 0.29.0) the fit period (in words,
  `null` for a side without factors), the fit ranges (by name), any range's
  factors or any fit's reference window (`fitWindows*`: the water years that
  gave each fit its shared days; empty for a run before 0.29.0, not
  compared then) differ ([model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
- Each side's `run` carries its `notes` (and `notesUpdatedAt` / `notesUpdatedBy`),
  so the modeller's explanation of each run is shown next to the comparison.
- Each side's `run.evidence` is its place in its own project's evidence
  history, `null` when never nominated: `{ status: 'current' | 'past',
  nominatedAt, nominatedBy, reason, replacedBy: { runId, runLabel,
  nominatedAt, nominatedBy, reason } | null }`. The fields are this run's
  latest nomination; `replacedBy` is the nomination that came after it.
- Each side's `scenario` is the [scenario](#scenarios) its run came from,
  `null` for a run of the model: `{ id, name, baseRunId, ops, opsSha256,
  ownedNodeIds, classified }`, read from the run's own snapshot
  (`inputs.scenario`), so it is the ops exactly as that run applied them even
  after the scenario is edited, rebased or deleted. `name` is the scenario's
  current name, or the recorded one once deleted. `classified[i]` is
  `ops[i]`'s class (`proposal` | `baseline`). A scenario run keeps its base's
  ids, so `changes` and the farm matching line up by id.
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
| `/projects/:id/runs/:runId/export/daily.csv` | `nodeId?`, `from?`, `to?` | `date` + every daily series of that node (catchment when `nodeId` is omitted), one row per day. Catchment columns follow `CATCHMENT_ORDER` in `backend/src/export/run-tables.ts`: … rain used, final catchment rainfall, CHIRPS as uploaded, bias-corrected CHIRPS, the day's CHIRPS factor, … A farm's columns follow the FarmTemplate letters (`FARM_COLUMNS` in `packages/engine/src/verify/columns.ts`): gross demand, effective rain used, the soil-water store (mm, engine ≥ 0.14.0), F (crop requirement), D (abstraction demand, engine ≥ 0.16.0), G, H, I, the runoff removed by land cover (only a farm with land cover; I + it = natural flow × share), J, K … O, the dam's area, rain on it, evaporation and seepage (engine ≥ 0.16.0), P, Q, R, S, T, U, the balance check V, W, Y … AB (AB is the reach shortfall, a diagnostic from engine 0.17.0), then `ewr_charge` and `ewr_charge_irrigation` (engine ≥ 0.17.0), the letter in brackets in each header (`Irrigation supplied [G] (m³/day)`); a gauge's use the GaugeTemplate letters. Runs before engine 0.12.0 have no working columns (K–P, S, T, V, gross demand, effective rain). A **forecast run** (WP-2.12) leads with `forecast (F = modelled on forecast rain)` after `date`: `F` on each day from `summary.forecast.from`, empty before; its catchment file also has the `Rain source` column. So does `farms.csv`, and the `.xlsx` workbook's daily sheets lead with `forecast (1 = modelled on forecast rain)`, 1 or 0 |
| `/projects/:id/runs/:runId/export/farms.csv` | `key`, `from?`, `to?` | `date` + one column per farm of the run, in the run's farm order (upstream first, the order of `RunSummary.farms`), for one farm series `key` (any key of `FARM_COLUMNS`, the optional ones included, e.g. `landcover_reduction`; `400` otherwise). `key=runoff` is the workbook's `[Fragmented flow]` sheet (column I), `key=ewr` its `[Fragmented EWR]` sheet (column Y). Each header is the farm's current name, then the letter and unit (`Farm A [I] (m³/day)`); a farm deleted from the model since the run keeps its column under the name the run knew (a run keeps all its series, migration 024), and a farm without that series (a dam column on a farm with no dam) is left out. `404` when no farm has the series |
| `/projects/:id/runs/:runId/export/summary.csv` | – | Run details (ending with `Run notes`, the run's written explanation, empty when there is none, `Notes last changed` with the time and name when there is one, and the evidence nomination: `Evidence nomination` = `the nominated evidence run` / `nominated before, since replaced` / `not nominated`, then `Nominated,<time>,<name>,<reason>` and, for a replaced run, `Replaced by,<run label>,<time>,<name>,<reason>`), the self-checks (each check passed/FAILED with its first problem, and the largest daily balance check), per-farm summary table (first `Flow share (%)`, the farm's share of the natural flow and of the EWR as the run applied it, engine ≥ 0.27.0, empty on older runs; then the averages), catchment figures, the water balance per water year and for the whole run, the curtailment table over the reporting window (every column unrounded, with a row naming the EWR attribution rule, engine ≥ 0.17.0: the EWR charge, its irrigation and storage parts, the supply cut and the EWR site setting it, then `demand_pct_note` — `no_demand`, `below_floor` for demand under 1 m³/day, or empty — and the EWR cut beyond the equitable share; the equitable share is labelled a fairness benchmark, `Above (−) / below (+) equitable share` instead of reduce/gain, and the table ends with the fixed footnote `EQUITABLE_SHARE_FOOTNOTE`, "… Not an allocation or licence condition.", audit Q11), the land-cover reductions (engine ≥ 0.24.0, only with land cover: the low-flow threshold, the mean and its share of natural flow, per class the condensed area, reduction and mm/yr), the other water users (engine ≥ 0.22.0, only when the run has any: whole-run means, then the reporting window's EWR charge, whether each is curtailed and its supply cut), the EWR sites (days not met, shortfall, charged to farms, natural), Reserve compliance by month (engine ≥ 0.21.0; `Not assessed: …` without a rule table; otherwise per site the table's source, coverage, unit, natural-percentile source, scale and % points, months met, deficit, longest run not met, mean shortfall, the FDC check, a row per month of the year and a row per complete month with its natural flow, condition, requirement, simulated flow and deficit), the assurance of supply (engine ≥ 0.32.0; `Not computed: run made before engine 0.32.0 …` in each block on older runs: `Assurance of supply (reporting window)` with the window, the annual threshold and a row per farm and user, then the time-based and volumetric reliability by month; `Stress classes by month (supplied ÷ demand)` with the thresholds and, for all farms and users then each one, a row per water year of class and % per month; `Water account by water year (Oct–Sep)` with the in, out, storage, residual and memo columns per water year and the whole run, then the EWR required vs met per site), the 12 CHIRPS bias factors (month, factor, source, shared days) and what the fit left out, the catchment rain treated as missing, the rain-source periods (engine ≥ 0.30.0: one row per period with its reason, run days by source, the rain from the series, its factors' origin and fallback, then the factors Oct … Sep; `None: the catchment series throughout` without periods), the double-mass check against CHIRPS (engine ≥ 0.17.0: slope, segments, breaks, one row per water year), the plausibility checks (engine ≥ 0.25.0, `Run made before engine 0.25.0: …` on older runs: the dry season; natural vs observed + net abstraction per water year with the dams / land cover / use split, gap, tolerance and pass; EWR days not met for good-rain and fallback-rain years, the Reserve months met by the same split, one row per water year with its station days and fallback rain; the double-mass check of observed flow against rain with segments, breaks, the simulated slopes, the change beyond the model overall and by season and what it points to; the dry-season low-flow duration curves in m³/s at Q1 … Q99 with the Q90 comparison; each part says `Not checked: …` when the run lacks what it needs), calibration, a forecast run's forecast days (WP-2.12, only on a forecast run: first and last forecast day, days, last observed rain, forecast rain, outlet EWR days at risk, then per farm the lowest dam level expected (%), days short, demand, supplied and supplied % of demand; every other block covers the days before them), the WR2012 check (`Not checked: …` when the run's settings had no reference; otherwise the quaternary, source, reference period, scaling rule and factors, WR2012 MAR and scaled MAR, the simulated natural MAR and ratio over the overlapping years and the whole run, the 12 monthly means in water-year order with ratio and dry-season mark, the dry-season ratio, the pattern correlation, the flag with its basis, deviation and thresholds, and for a *query* or *not usable* flag whether the run has a written explanation), a column guide (each farm daily column's letter, series key and formula), warnings — blocks separated by a blank record. A run before engine 0.12.0 says it has no self-checks or water balance. Shares are **percentages** (0–100): `Flow share (%)` and `Demand supplied (%)` per farm and `Days EWR not met at the outflow gauge (%)`, where the JSON `RunSummary` has fractions (`flowShare`, `fractionSupplied`, `ewrFractionDaysNotMet`, 0–1) |
| `/projects/:id/series/:seriesId/export.csv` | `from?`, `to?` | `date` + the input series' values |
| `/projects/:id/export.json` | – | The project document (below) |

CSV format: RFC 4180 (CRLF, fields with `,` `"` or line breaks quoted, `"`
doubled), a **UTF-8 BOM** so Excel reads `m³` correctly, ISO `YYYY-MM-DD`
dates, full-precision numbers, and **empty cells for missing days**. Column
headers are `label (unit)` (a node's: `label [letter] (unit)`), in the engine's output order. Text cells that start
with `= + - @`, a tab or a CR get a leading `'` so a spreadsheet never runs them as formulas.
`from`/`to` are inclusive ISO dates, clamped to the series; `400` if they are
not real dates, `from > to`, or the window misses the series entirely.

**Run workbook (`.xlsx`).** Not a server route: the Runs tab's Download menu
builds it in the browser (`frontend/src/lib/spreadsheet/export/`, WP-1.28), in
a Web Worker, from `GET …/runs/:runId` (summary, settings and model snapshot,
series list), `…/export/summary.csv` and one [bulk request](#bulk-run-series)
per node, so no workbook ever passes through Lambda's 6 MB limit. Sheets, in
order:

| Sheet | From | Content |
| --- | --- | --- |
| Summary | summary CSV | Run details and notes, evidence, self-checks, farm summary, catchment, calibration, WR2012, the column guide (a legacy run's `# runoff_model=legacy …` line first) |
| Catchment, then one per node | bulk route | `date` + the daily CSV's columns and headers for the catchment, then each node with series in the run's network order (b023's element sheets) |
| Curtailment | summary CSV | Curtailment targets, land cover, other users, EWR sites |
| EWR grid | `summary.ewrCompliance` | Days simulated, then per site (the outlet, each farm) days not met and volume short (m³), water year × month (Oct … Sep) with a year total |
| Reserve compliance | summary CSV | Reserve compliance by month (EWR rule tables) |
| Annual volumes | summary CSV + `summary.calibration.annualVolumes` | The water balance per water year, then observed vs simulated volume per water year over the calibration window |
| Data checks | summary CSV | CHIRPS factors, rain treated as missing, rain-source periods, accumulations, double-mass, plausibility checks |
| Inputs | `run.settings`, `run.model` | Every setting the run used (arrays across the row), then each part of the model snapshot as a table, references shown by name |
| Warnings | summary CSV | Only when the run has warnings |

The summary CSV's blocks are placed by their title
(`lib/spreadsheet/export/summary.ts`); a block the CSV adds later stays on the
sheet of the block before it, so every CSV row appears exactly once. Values
equal the CSV exports: numbers are numeric cells holding the stored value at
full precision (the unit tests and `e2e/tests/xlsx-export.spec.ts` compare
every cell with the CSVs as text), missing days are empty cells, daily dates
are real Excel dates shown `yyyy-mm-dd`, and user-controlled text (farm, crop,
run names, notes) is a string cell, defused with a leading `'` exactly as in
the CSV. Sheet names are made Excel-safe (at most 31 characters, none of
`[ ] : * ? / \`, unique ignoring case: a farm called "Summary" becomes
"Summary (2)").

**Number formats (decision D11).** Each numeric cell carries a display format
chosen from its column's unit (`lib/spreadsheet/export/formats.ts`): volumes
and flows in m³ or m³/day `#,##0.00`, Mm³ and m³/s `#,##0.000`, mm `#,##0.0`,
shares in % `0.0` (the exports write shares as 0–100, so not the `0.0%` code,
which multiplies by 100), ratios `0.000`, other columns General. The rounding
is visual only: the cell (and any formula over it) has the unrounded value.
The codes use Excel's `,` and `.` placeholders, which Excel and LibreOffice
draw with the **viewer's** locale separators ("1 234,56" in a South African
or French locale, "1,234.56" in a US one), so the workbook doesn't prejudge
D10, the app's own thousands separator, which is still open. The CSVs stay
unformatted and ungrouped (machine-readable).

The parts are SheetJS output (CE 0.20.3, its mini build): SheetJS writes the
workbook uncompressed, and a daily sheet's rows are streamed into the sheet
XML SheetJS wrote for a stub of it, in SheetJS's own cell markup (a whole
client-size run as SheetJS cell objects needs ~4 GB, past a browser tab). A
unit test pins that a streamed sheet is byte-for-byte the sheet SheetJS
writes from the same cells. The zip container is written by
`lib/spreadsheet/export/zip.ts`: every part deflated with the platform's
`CompressionStream('deflate-raw')` (real zlib deflate), plain PKZIP headers
and central directory, no zip64. SheetJS's own browser deflate is
fixed-Huffman and made files ~2.5 times larger. For scale, a ~45-year,
13-node run builds in ~4.6 s and is a ~41 MB file (100.8 MB with SheetJS's
zip); a unit test holds a synthetic 10-year, 3-farm run under 4.6 MB (it
measures 4.0).

**Project document** (`export.json`) is the shape
[`POST /projects/import`](#import-a-project-file) and `pnpm import:project`
accept (`ProjectFile` in `backend/src/projects/document.ts`), so a project
round-trips export → import:

```jsonc
{
  "format": "water-management/project", "version": 1,
  "exportedAt": "…", "engineVersion": "0.2.0",   // informational; ignored on import
  "name": "…", "description": "…",
  "settings": { /* stored settings merged over the defaults */ },
  "model": { "nodes": [], "crops": [], "cropAreas": [], "transfers": [] },
  "series": [{ "kind": "rain_catchment_mm", "name": "", "unit": "mm", "startDate": "2001-10-01", "values": [0.4, null] }],
  "notes": [{ "body": "…", "author": "…", "createdAt": "…", "editedAt": null, "target": "node", "nodeId": "…", "nodeName": "…",
              "runId": null, "runLabel": null, "settingKey": null, "visibility": "farm" }]   // informational; ignored on import
}
```

`notes` are the project's notes the exporter can read, oldest first, never a
deleted one ([data-model.md § Notes](./data-model.md#notes-037_notessql)):
a record, not imported, since a note can only be written as its author.

Runs are not included (re-run after importing, or pass `run=1` / `--run`),
nor is the import report ([why](#import-report)). The importer gives every row
a fresh id.

**Size cap — 413.** Production serves the API through Lambda's *buffered*
response mode, which fails any response over **6 MB**. Every export body is
built in memory and refused with `413 { error: "export larger than 5 MB — …" }`
once it passes 5 MB, with a hint to narrow the window (`from`/`to`). For scale:
a 60 000-day series is ≈ 1 MB, and the catchment table fits, but a **farm's
daily CSV over a multi-decade record does not**: a farm has ~32 columns at
full precision (≈ 12–13 bytes a value on average), so a ~45-year record
(≈ 16 400 days) is ≈ 6.5 MB and gets the 413; download it in windows of about
30 years or less, or take the `.xlsx` workbook, whose bulk fetch pages under the
cap ([below](#bulk-run-series)). WP-1.29 (Lambda response streaming) removes
the limit for the CSVs ([followups.md](./followups.md)). The durable fix if exports grow (many long series, multi-node
workbooks) is Lambda response streaming (`streamHandle`, 20 MB soft limit) or
writing the file to S3 and returning a pre-signed URL. Gzip is not a clean win
here: a gzipped body is binary, so the Lambda adapter base64-encodes it (+33 %),
and CloudFront's `CachingDisabled` policy on `/api/*` doesn't compress either.

### Bulk run series

`GET /projects/:id/runs/:runId/series/bulk?nodeId=<uuid>&offset=<day>` (viewer;
`401` signed out, `404` for a non-member, another project's run, or a node the
run has no series for) returns every stored series of one node, or the
catchment's when `nodeId` is omitted, so the browser builds the `.xlsx`
workbook with one request per node instead of one per series:

```jsonc
{
  "nodeId": "…" /* null for the catchment */, "name": "Upper farm" /* "catchment" */,
  "kind": "farm",            // "catchment" | "farm" | "gauge" | "user"
  "startDate": "2021-10-01", "days": 16437,   // the run's first day and length
  "offset": 0, "count": 6225, "next": 6225,   // this page; next = null on the last
  "series": [{ "key": "demand_gross", "label": "…", "unit": "m³/day",
               "header": "… (m³/day)", "values": [0.25, null /* … count values */] }]
}
```

- `series` is in the daily CSV's column order and `header` is the daily CSV's
  header (`loadDailyScope` in `backend/src/export/daily-columns.ts` serves
  both), and the values are the stored full-precision numbers, so a workbook
  built from it equals the CSV export. `name` follows the CSV too: the node's
  current name, or the run's for a node deleted since.
- **Paging.** A page carries at most ⌊(5 MB − 256 KB) ÷ 25⌋ ≈ 199 000 values
  (25 bytes is the longest JSON a double or `null` takes with its comma), so
  `count` = that ÷ the number of series and no page can pass the 5 MB cap
  whatever the values. A farm (~32 series) gets ~6 200 days a page: one
  request up to ~17 years, three for ~45 years. Follow `next` until it is
  `null`. `offset` defaults to 0; `400` when it is negative, not an integer,
  or past the run's end, or when `nodeId` isn't a UUID.

## Health

`GET /health` → `{ ok: true }`.
