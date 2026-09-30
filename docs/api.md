# HTTP API

Backend: Hono (`backend/src/app.ts`), dev on `http://localhost:3001`, prod behind
CloudFront at `/api`. All bodies are JSON, except the CSV exports. Shared TypeScript shapes live in
`packages/engine/src/project.ts` — both the backend and the frontend import them.

## Auth

Session = an HS256 JWT in an **httpOnly cookie** `wm_session` (`SameSite=Lax`,
`Secure` in prod, 7-day expiry). The browser sends it with `credentials: 'include'`;
CORS allows the frontend origin with credentials. There is no token in JS-readable
storage. Register, login, reset-password and change-password also set a
`wm_device` cookie (httpOnly, 180 days): with it, that browser's sign-in
attempts count on their own lockout record, so someone else locking the
address doesn't lock it out ([security.md § Authentication](./security.md#authentication)).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ email, password, displayName, acceptTerms, inviteToken?, locale? }` | `acceptTerms` is the version of the terms of use and privacy notice the form showed (the engine's `LEGAL_VERSION`, `packages/engine/src/legal.ts`); missing or any other version is `400 terms_not_accepted` (`params.version`: the current one) before anything else, and the accepted one is stored with the account (`app_user.terms_version` / `terms_accepted_at`, 087). `202 { confirm: true, email }`, **no** cookie: sends a confirmation email, and the account can sign in once it is confirmed (issue #57). The **same** `202` for an address that already has an account, which gets an email instead (a fresh confirmation link if never confirmed, else "you already have an account" with a password-reset link). Through a live invite for exactly this address: `201 { user }` + cookie, confirmed and joined; `409 account_exists` if that address already has an account. `429 signup_throttled` past the sign-up throttle |
| POST | `/auth/login` | `{ email, password }` | `200 { user }` + cookie; `401` wrong email or password; `403 email_unconfirmed` right password, address never confirmed (no cookie); `429` + `Retry-After` while the address is locked. In production, past 20 sign-ins per IP in 5 minutes, AWS WAF (not the API) may answer `405` with `x-amzn-waf-action: captcha`; send it again with a solved CAPTCHA token in `x-aws-waf-token` (docs/security.md § Sign-in CAPTCHA) |
| POST | `/auth/logout` | – | `204`, clears cookie and revokes this session on the server (its `jti`, 102), so a copy of the cookie is refused too; the account's other sessions stay signed in. `204` without a session as well |
| POST | `/auth/logout-everywhere` | – | `204`, clears cookie and revokes **every** session of the account, on every device (signed in) |
| GET | `/auth/me` | – | `200 { user }` or `401` |
| POST | `/auth/me/accept-terms` | `{ version }` | The re-acceptance step ([legal-status.md](./legal-status.md)): `version` is the terms version the notice showed (`LEGAL_VERSION`). `200 { user }` with `termsCurrent: true`, recording it (`app_user.terms_version`; the database stamps the time, and accepting the version already recorded changes nothing). Any other version is `400 terms_not_accepted` (`params.version`: the current one) |
| GET | `/auth/me/export` | – | `200` a JSON file (`Content-Disposition: attachment; filename="my-data_<date>.json"`, `Cache-Control: no-store`): the signed-in person's data-subject export; `429` + `Retry-After` within a minute of the last one (signed in) |
| POST | `/auth/me/farm-notice` | `{ version }` | "I understand" on the farm view's "Before you look at your farm" notice: `version` is the one the page showed (the engine's `FARMER_NOTICE_VERSION`, `packages/engine/src/legal.ts`); any other is `409 farm_notice_changed` (`params.version`: the current one). Stored on the account with the database's time (`app_user.farm_notice_version` / `farm_notice_accepted_at`, 093). `200 { user }` (signed in) |
| PATCH | `/auth/me` | `{ displayName?, locale?, volumeUnit?, preferences? }` | `200 { user }`; `400` a blank or over-100-character name, an unknown `locale` or `volumeUnit`, malformed `preferences`, or nothing to change (signed in) |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | `200 { user }` + a fresh cookie for this device; revokes **every other** session; `403` wrong current password; `429` + `Retry-After` while the address is locked; `400` new password not 8–200 characters (signed in) |
| POST | `/auth/forgot-password` | `{ email }` | **always** `202 { ok: true }` (public) |
| POST | `/auth/reset-password` | `{ token, password }` | `204`, clears cookie; `400` bad/expired/used link (public) |
| POST | `/auth/verify-email` | `{ token }` | `200 { verified: true }` + a trusted-device cookie for the address; `400` bad/expired/used link (public) |
| POST | `/auth/resend-confirmation` | `{ email }` | **always** `202 { ok: true }`, after the same time as `forgot-password`; mails a new confirmation link only to an unconfirmed account, under the cooldown and daily cap (public: the sign-in page's "Send the link again") |
| POST | `/auth/resend-verification` | – | `202 { sent: true }`; `409` already verified; `429` sent < 1 min ago, or the day's cap reached (signed in) |
| POST | `/auth/invite-info` | `{ token }` | `200 { invite: { email, projectName, teamName, invitedBy } }`; `404` bad/expired (public) |
| POST | `/auth/render-session` | `{ token }` | `200 { ok: true }` + a **render session** cookie; `400` bad/expired/used token; `403` the requester can no longer see the project or the run; both carry `code: "render_token_refused"` (§ Errors, machine-only codes) (public: the headless report renderer's sign-in, [§ Reports](#reports)) |

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
- **`forgot-password`** answers the same `202`, after the same time (at
  least 200 ms; the email is sent without being waited for, issue #51),
  whether or not the address has an account, and sends at most one email per address per minute and ten
  reset or verification emails per address in 24 hours (a browser trusted for
  the address has its own ten; later requests get `202` and no email).
  Requesting again replaces the previous link.
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
- **`user`** is `{ id, email, displayName, emailVerified, locale, volumeUnit, mailSuppressed, preferences, termsCurrent, farmNoticeCurrent, renderSession? }`.
  `locale` is a language code from the engine's language table
  (`packages/engine/src/languages.ts`, today `'en' | 'af'`) or `null`
  (`app_user.locale`, 050_user_locale.sql, 080_language.sql, WP-2.5): the language of the farmer-facing pages and of the emails the
  account receives; `null` means not chosen (the site follows the browser,
  emails are English). `volumeUnit` is `'m3' | 'ML'` (default `'m3'`), how
  the farm view shows volumes. `mailSuppressed` is `null`, or
  `{ reason: 'bounce' | 'complaint', at }` once SES reported a permanent
  bounce or a spam complaint for the address (057): alert emails are paused
  until the person turns them back on (`POST /me/alerts/resume`,
  [§ Alerts](#alerts)). `preferences` is the person's own display choices
  (`user_preferences`, 083), today `{ hiddenTabs: string[] | null }`: the
  workspace sections (`?tab=` ids) they hid from their sidebar ([ui.md § Tabs
  by role](./ui.md)); `null` until they choose (the app then hides its default
  sections: History, Allocations, Applications), `[]` once they chose to show
  every one. Only ever their own.
  `termsCurrent` is whether the account accepted the terms and privacy
  notice now in force (`app_user.terms_version` = `LEGAL_VERSION`, 087):
  `false` after the version changes, and for an account `import:project`
  made (it accepts nothing; `seed:examples` accepts the version in force for
  its demo accounts on every seed). The app then
  shows its re-acceptance notice before any page, and `POST
  /auth/me/accept-terms` records the new version
  ([legal-status.md](./legal-status.md)). Only the app is gated: other
  calls still answer. A **render session** (the report renderer's,
  [security.md § Render tokens](./security.md#render-tokens)) also answers
  `renderSession: true`, and the app never gates it: it can read one report
  and accept nothing, so the notice would stand where the report should be
  and every PDF of an account behind on the terms (a scheduled report's
  editor after any terms change) would time out.
  `farmNoticeCurrent` is whether the account acknowledged the farm view's
  notice now in force (`app_user.farm_notice_version` =
  `FARMER_NOTICE_VERSION`, 093): `false` until the farmer presses "I
  understand" (`POST /auth/me/farm-notice`), and again after the version
  changes; the farm pages show the notice instead of the figures until then
  ([ui.md § Farmer view](./ui.md)).
- **`GET /auth/me/export`** ("download my data", POPIA access;
  `backend/src/auth/export.ts`, 054_subject_export.sql) returns one JSON
  document, `{ format: 'water-management.subject-export', version: 1,
  exportedAt, account, projectMemberships, teamMemberships, farms, notes,
  signoffs, invites, alertSubscriptions, alertDeliveries, preferences,
  reportSubscriptions, auditEvents, auditEventsTruncated }`. `preferences`
  is the person's saved display preferences, `[{ preferences, updatedAt }]`,
  or `[]` if they never saved any. `account` is
  the `app_user` row without the password hash (so it includes
  `termsVersion` and `termsAcceptedAt`, the terms accepted at sign-up,
  087, and `farmNoticeVersion` and `farmNoticeAcceptedAt`, the farm view
  notice acknowledged, 093). `farms` is one entry per farm
  linked to the person (`projectId`, `farmName`, `linkedAt`, `linkedBy`),
  with the registered volumes matched to that farm (`allocations`, holder
  name included) and the current publication's figures for it as the farm
  page shows them (`publication.figures`, the same D2 masking; `null` when
  nothing is published). Nothing about any other farm. `notes`, `signoffs`,
  `invites` (to the account's address, only once it is verified; pending or
  lapsed, with the farms a farmer invite names), `alertSubscriptions`,
  `reportSubscriptions` and `auditEvents` (every event the person made,
  `byYou: true`, or that names them as its subject; newest first, at most
  50 000, `auditEventsTruncated` past that) come from `app_subject_export()`,
  which reads only the caller's own rows, including in projects they have
  left. Never a secret: no password or token hash, unsubscribe nonce, key or
  link material. One export a minute per account
  (`app_user.data_exported_at`); a render session is refused (403).
- **`PATCH /auth/me`** changes only the fields sent: `displayName` (trimmed,
  1–100 characters), `locale` (a code in the language table, e.g. `'en'` or
  `'af'`, or `null` to go back to following the browser; any other value,
  including a different case, is a `400`) and `volumeUnit` (`'m3'` or `'ML'`),
  and `preferences`, whose keys sent replace the account's (the others stay):
  `hiddenTabs`, at most 32 section ids (`^[a-z][a-z-]{0,31}$`, each kept
  once; `[]` shows every section, `null` forgets the choice, which is "Reset
  to default"). Any other key inside `preferences`, or a
  value of another shape, is a `400` (`backend/src/auth/preferences.ts`). At least one
  field is required. The email address isn't editable; other top-level keys are ignored.
- **`register`** takes an optional `locale` (the language the sign-up page
  was in). Without one, an account that accepts an invite takes the invite's
  `locale` (`app_accept_invites`, 050); a chosen locale is never overwritten.
  The verification, reset and farmer-invite emails go out in the account's
  (or the invite's) language, English for any key with no Afrikaans (none
  today; [ui.md § Language](./ui.md#language)).
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
validation (`details` = zod issues), `{ error: "invalid JSON" }` for a
body that isn't JSON (`backend/src/http/body.ts`), or `{ error: "bad request
path" }` on any route for a path with an escaped unreserved character
(`%61`), an escaped `/`, `\` or `%`, a malformed escape or a dot segment
(`backend/src/http/rawPath.ts`; `%20` and non-ASCII escapes are fine); `409` = conflict (duplicate name or email,
already a member, last owner/admin); `413` = request body over 4 MB (5 MB
for `POST /projects/import`), a series over 60 000 days, or an export over 5 MB; `429` = an email was sent to this
address moments ago, or sign-in is locked for this address (with
`Retry-After`). Database errors are mapped to fixed messages and anything
unexpected is `500 { error: "Internal server error" }`; raw database error
text never reaches the client.

**Error codes (WP-2.5).** An error a farmer can meet on a translated page
also carries a stable `code` (and, for some, `params`):
`{ error, code, params? }`. `error` stays English, for developers,
integrators and logs; the translated pages (sign-in, account, alert and farm
pages) never show it, and word the error from `code`, or from the status
when there is no code (`frontend/src/lib/i18n/apiError.ts`). The server
doesn't localise messages: codes keep every word a farmer reads in the
frontend catalogue and on the translation sheet, and the API in one
language. A code is a contract: add new ones, never rename one
(`ERROR_CODES` in `backend/src/http/errors.ts`; a frontend test fails when a
code has no message in `apiError.ts` `CODES`). A guard (`backend/src/http/errorCodes.test.ts`)
fails on any uncoded `ApiError` in the routes the translated pages call,
unless it is listed there with why its status says enough.

**Machine-only codes.** A code that only a machine client reads, never a
translated page, is in `MACHINE_ERROR_CODES` instead, so it has no words in
the frontend catalogue (same contract: add, never rename). One so far:
`render_token_refused` (`400`/`403` from `POST /auth/render-session`: the
render token is used, expired or unknown, or the requester lost access). The
report renderer treats only that code as a final refusal; a `403` without it
is a WAF or CloudFront block, and is retried with the other passing failures
(`backend/src/reports/render.ts` `sessionRefusal`).

| Code | Status | When |
| --- | --- | --- |
| `not_signed_in` | 401 | no valid session |
| `wrong_credentials` | 401 | sign-in with a wrong email or password |
| `email_unconfirmed` | 403 | sign-in with the right password to an account whose address was never confirmed |
| `signin_locked` | 429 | sign-in or a password change while the address is locked; `params.seconds` (also `Retry-After`) |
| `account_exists` | 409 | sign-up **through an invite link** with an address that has an account (an ordinary sign-up answers the same `202` either way) |
| `signup_throttled` | 429 | `POST /auth/register` past the sign-up throttle (10 an hour per client address, 500 an hour in all), before the address is looked at; `params.seconds` (also `Retry-After`) |
| `terms_not_accepted` | 400 | `POST /auth/register` without `acceptTerms`, or `POST /auth/me/accept-terms` without `version`, or with a version that isn't the current one (a page loaded before the terms changed); `params.version` is the current one. On sign-up, checked before the sign-up throttle counts |
| `farm_notice_changed` | 409 | `POST /auth/me/farm-notice` with a version that isn't the current one (a farm page loaded before the notice changed); `params.version` is the current one |
| `wrong_current_password` | 403 | `POST /auth/change-password` |
| `password_changed_elsewhere` | 409 | a concurrent password change won |
| `link_invalid` | 400 | a reset or confirmation link that is used, expired or malformed |
| `already_verified` | 409 | `POST /auth/resend-verification` for a confirmed address |
| `verification_sent_recently` | 429 | the same, within the resend cooldown |
| `verification_limit` | 429 | the same, once the address's daily cap on reset and verification emails is reached (078) |
| `invite_invalid` | 404 | `POST /auth/invite-info` for a dead invitation |
| `note_farmer_own_farm` | 403 | a farmer's note anywhere but their own farm, shown to the farm |
| `note_farm_visibility` | 400 | a farm-visible note on something that isn't a farm |
| `note_author_only` | 403 | editing someone else's note |
| `note_delete_denied` | 403 | deleting someone else's note without the editor role |
| `unsubscribe_link_gone` | 404 | an alert email's unsubscribe link that no longer works |
| `export_throttled` | 429 | `GET /auth/me/export` within a minute of the last; `params.seconds` (also `Retry-After`) |
| `alerts_resume_throttled` | 429 | `POST /me/alerts/resume` a second time within a day, after the address was refused again |
| `body_refused` | 400 | any route: a JSON body with a NUL character, a number that overflows (`1e400`), or nesting past 64 levels (security.md § Input handling) |
| `run_unverified` | 409 | `POST …/runs/:runId/signoffs` for, or `POST …/scenarios/:sid/decide` with, a run whose server stamp is missing or no longer matches its rows (security.md § Run stamps) |

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
| GET | `/projects/outcomes` | – | `{ projects: PortfolioProject[] }`: the [portfolio](#portfolio)'s figures for every project you can see (below) | – |
| POST | `/projects` | `{ name, description?, teamId? }` | `201 { project }` (`teamId` must be a team where you're a member or admin: `404 team not found` if you're not in it, `403` if you're a team viewer; omit/`null` = personal) | – |
| GET | `/projects/:id` | – | `{ project }` | viewer |
| PATCH | `/projects/:id` | `{ name?, description?, timeZone?, wuaName?, settings?, teamId? }` | `{ project }`; `400` for a `timeZone` that isn't an IANA zone the server knows | editor (owner when `teamId` is sent) |
| DELETE | `/projects/:id` | – | `204`; `409 { error, details: { packs } }` for a project with an evidence pack past draft (issued, superseded or withdrawn: its verify link must keep answering; 112, [Evidence packs](#evidence-packs)), checked first; `409 { error, details: { evidenceRun: { id, label } \| null, nominations } }` for a project that has nominated an evidence run, current or since replaced: the project is kept with its evidence run and nomination history for good (issue #43, [data-model.md](./data-model.md) § Evidence nomination). The error names the current evidence run and says the history is kept even once a nomination is withdrawn; `evidenceRun` is `null` when the newest row is a withdrawal (098), or when a nomination landed during the request (the database trigger refused it) | owner |
| POST | `/projects/import` | a project document (`ProjectFile`); query `teamId?`, `run=1?` | `201 { project, runId?, runError? }` (below) | – |
| POST | `/projects/:id/copy` | `{ name }` | `201 { project }` (settings, model + series copied, the model with fresh ids in the same id order (so the copy runs exactly as the original) and each EWR rule table's `siteNodeId` moved to its node's new id; runs and notes not ([why](./data-model.md#notes-037_notessql)); stays in the team only if you're a member or admin of it, otherwise it's personal) | viewer |

- `ProjectSummary = { id, name, description, role, team, createdAt, updatedAt, dataUntil, today, lastRunAt, publishedAt }`
- `GET /projects/outcomes` (issue #17) feeds the project list's outcome
  columns and its *Needs attention* strip: one `PortfolioProject` (the
  [portfolio](#portfolio)'s row, same fields and rules) per project you can
  see, personal, team and shared alike, read in **one query** under RLS
  (`loadMyOutcomes`, `portfolio/portfolio.ts`, sharing the portfolio's SQL).
  Each `ewr.status` is judged by its team's thresholds when you're in that
  team, so a team project's row equals its portfolio row; a personal project,
  and one shared with you directly from a team you aren't in (you can't read
  that team's settings), is judged by the defaults (5 %, 20 %). A project
  where your role is `farmer` or `contributor` is left out, as on the
  portfolio. Sorted by name.
- `project` (`GET`/`PATCH /projects/:id`, create, import, copy) is a
  `ProjectSummary` plus `settings`, `rerunQueuedFor` and `timeZone`: an
  IANA zone name (058_project_time_zone, `Africa/Johannesburg` by default)
  that dates the project's downloads (§ Export) and every other day a
  person reads from the server: the portfolio's ages, a feed's health, the
  farm page's freshness and a forecast's `madeOn`, the alerts' "today" and
  their 06:00 digest (059_local_day), and the dates in server-written text
  (a publication's `citedBy` name, an auto-publish note, a restore's
  reason, an unlabelled run's name in the report email). A source's own
  days (CHIRPS, DWS) are never shifted. A change is audited
  (`project.changed` with `fields: ['time_zone']` and `timeZone: { from, to }`);
  a copy keeps it, and the project document (`export.json`, `POST
  /projects/import`) carries it as `timeZone` (absent = the default).
  `wuaName` (095_wua_name): the WUA the farm pages' contact lines name
  ("Questions? Contact Vaalbank WUA."), trimmed, ≤ 200 characters; `""` or
  `null` clears it (then the pages say "your WUA"). A change is audited
  (`project.changed` with `fields: ['wua_name']` and `wuaName: { from, to }`).
  A copy and the project document don't carry it: neither has farmers to
  contact anyone.
- `dataUntil` — the last day of the project's **recorded rain**
  (`rain_catchment_mm` or `rain_chirps_mm`; `YYYY-MM-DD`: the latest
  last day **with a value**, `lastValueDate`), or `null` with none. Blank
  days stored after it (a logger's "no reading" for a dead sensor) are no
  data, so they never make a project look fresh (`series/lastDay.ts`). A forecast or a flow series
  doesn't count: a forecast runs into the future and flow only scores a run.
  `lastRunAt` — ISO timestamp of the newest run, or `null`. `publishedAt` —
  ISO timestamp of the current publication ([§ Publication](#publication)), or
  `null` before any; every member sees it, farmers included. All three come
  from the same query as the list (no per-project calls), for the list's
  freshness badge and its "published" hint. `today` — the project's
  calendar date now (`YYYY-MM-DD`, in its `timeZone`, `projects/timeZone.ts`
  `localDate`): the day the list counts `dataUntil`'s age to, the same day
  the portfolio row's `today` is (issue #137).
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
  `autoRun` leaves `updatedAt` alone. `settings.outcomes = { yearClassMethod,
  riskCutoffs: { reserveMonthsMet, daysBelowEwr } }` (issue #53 R4,
  `projects/outcomeSettings.ts`, [ui.md § Outcome matrix](./ui.md#outcome-matrix))
  is always present too, defaults `{ yearClassMethod: 'auto', riskCutoffs:
  { reserveMonthsMet: null, daysBelowEwr: null }, siteNodeId: null }` (null
  cut-offs = the engine's `DEFAULT_OUTCOME_RISK_CUTOFFS`, placeholders
  pending the hydrologist, plan.md O1, which the client agreed to, issue
  #90). `PATCH` takes any field:
  `yearClassMethod` `auto` | `terciles` | `quintiles`; `riskCutoffs` whole,
  both metrics, each null or `{ lower, increasing }` shares 0–1 in the
  metric's own order (months met: `lower ≥ increasing`; days below the EWR:
  `lower ≤ increasing`), checked by the engine's `validateOutcomeCutoffs`
  (`400` with its message); `siteNodeId`, the matrix's Reserve site, null
  (the outlet) or a UUID. A new site must be a gauge of the project's
  network above the outlet with a Reserve rule table in the settings as
  they'd be saved (`400 outcomes.siteNodeId: no such node in this project`
  / `the site is the outlet (null) or a gauge above it` / `that gauge has no
  Reserve rule table`); the check runs only when the site changes, so a
  stored site whose table or gauge has gone doesn't block other saves (the
  Runs tab falls back to the outlet and says so). A copy or an imported
  project document moves the site to the copy's gauge. Like
  `autoRun` it is no model input: runs don't record it, and a `PATCH` that
  changes nothing but `autoRun` and `outcomes` leaves `updatedAt` alone.
  `settings.outlook = { season, planningShare, review }` (issue #53 R5, R6,
  `projects/outlookSettings.ts`, [ui.md § Seasonal outlook](./ui.md#seasonal-outlook))
  is always present too, defaults `{ season: null, planningShare: null, review: null }`:
  null = the engine's `DEFAULT_OUTLOOK_SEASON` (1 October – 30 April, O3),
  `DEFAULT_PLANNING_SHARE` (0.8, O6) and `defaultReviewDate` (1 January for
  that season, O3), all confirmed by the client (issue #90).
  `PATCH` takes either field: `season` null or `{ startMonth, startDay,
  endMonth, endDay }` (the decision date and the season end as a month and
  day; whole, each a real day of a common year, so not 29 February, and
  not the same day; `400`), `planningShare` null or a number in (0, 1],
  `review` null or `{ month, day }` (a real day of a common year; whether it
  falls inside the season is checked when an outlook is asked for, `422`). It
  says how a [seasonal outlook](#seasonal-outlooks) is set up; like
  `outcomes` it is no model input (runs don't record it, and saving only it
  leaves `updatedAt` alone).
  `settings.evidenceUncertaintyRule` (issue #71, [design/evidence-report.md](./design/evidence-report.md)
  ER3 and G4; [ui.md § Settings & calibration](./ui.md#settings--calibration)) is the uncertainty rule an
  evidence report's cited ensemble must follow: `{ members, bounds:
  'wide' | 'typical', panOffset, thresholds: { objective, minSkill,
  wr2012MaxLevel: 'ok' | 'note' | 'query' | 'unusable', maxLowFlowBiasPct:
  number | null } }`, or `null` / absent for none declared (then a report
  cites no ensemble). It is replaced whole, never merged, and `null`
  withdraws it; the engine's `declaredRuleError` checks it (`400 evidence
  uncertainty rule: …`: members a whole number 30–1000, `panOffset` 0–0.3,
  `minSkill` −10 to 1, the bias above 0 and at most 1000 %, no other field).
  Runs record it with their settings, and the History tab shows who
  declared or changed it and when. It changes no result, but unlike
  `autoRun` it is part of the run's recorded settings (a report reads the
  rule from the baseline run itself), so saving it moves `updatedAt`: the
  latest run shows as stale and, with automatic runs on, a re-run is queued.
  `rerunQueuedFor` is when the project's
  pending re-run (automatic or queued through `POST /jobs`) is due, ISO, or
  `null`; on `GET /projects/:id` and the other routes that answer
  `{ project }`, not on the list.
  `PATCH` validates the known fields: e.g. `simulationStart/End` and
  `calibrationStart/End` are `YYYY-MM-DD` or `null` (a `null` simulation end follows the rain record, [model.md § 2.1](./model.md#21-pipeline)), and
  `calibrationFlowKind` is `flow_observed_m3s | flow_logger_m3s | null`
  (`flow_pitman_m3s` was removed in engine 0.10.0). `dataQuality` (the data-check limits) takes
  `agreementMinRatio` (0 < r ≤ 1), `agreementMaxRatio` (1–100) and
  `agreementMinDays` (whole days, 1–366), and (engine ≥ 1.20.0, issue #66)
  `outlierFactorRain` / `outlierFactorFlow` (above 1, at most 1000),
  `flatlineRainDays`, `flatlineEvapDays`, `flatlineFlowMinDays`,
  `flatlineFlowMaxDays` (whole days 2–366), `zeroRunRule` (`wetDays` |
  `usualRain`), `zeroRunMinWetDays` and `zeroRunMinDays` (whole days 1–366),
  `zeroRunUsualShare` (0 < s ≤ 1), `zeroRunChirpsCheck` (boolean),
  `lowVsChirpsRatio` (0 < r < 1), `lowVsChirpsBaseline` (`record` |
  `moving`) and `lowVsChirpsMinimum` (`fixed` | `scaled`); any subset may be
  sent. A patch that leaves `flatlineFlowMaxDays` below
  `flatlineFlowMinDays` (after merging over the stored values) is a `400`.
  `GET` fills a field the stored settings lack with its default
  ([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)).
  A fit record's `forcing.rainChecks` (optional) holds the zero-run and
  low-vs-CHIRPS fields it ran under.
  `runoffModel` records the rain → natural-flow model: `gr4j` (model.md
  §2.4a) is the only value, since engine 1.0.0 removed the legacy b023
  recession model (issue #16). `legacy` is a `400`, "the legacy runoff model
  was removed in engine 1.0.0: GR4J is the only runoff model". Reading
  settings maps a stored `legacy` to `gr4j` (migration 064 did the same to
  every stored project), and drops a stored fit record of the legacy model.
  `calibration` takes `rainThresholdMm` (0–1000 mm) and `catchmentAreaKm2`
  (0–1 000 000 km², or `null` = the sum of the farm areas); any subset may be
  sent, and any other key is a `400`, except the legacy model's own keys
  (`a`, `b`, the season factors, `summerMonths`, `baseFlowInitial`, the
  recession tables and the rest of the engine's `RETIRED_CALIBRATION_KEYS`),
  which are dropped, so an older export still imports.
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
  1–500 chars, optional `sourceKind` (engine ≥ 1.5.0: `gazetted` | `desktop`
  | `other` | `null`, absent = not stated), optional `category` (ER9, issue
  #71: the REC, `A` … `F` or a band of two neighbouring classes like `B/C`,
  `null`/absent = not given; a label, no result depends on it), `component` (`total` | `lowFlow`), `unit` (`mcm` Mm³ per month
  | `m3s` the month's mean flow), `points` (2–20 exceedance %, rising, in
  (0, 100]), `ewr` (12 rows, Oct … Sep, × one value per point, each 0–1e6),
  `naturalSource` (`run` | `table`), `natural` (the same shape, required when
  `naturalSource` is `table`, else `null`), `scale` (above 0, at most 1 000),
  optional `naturalMarMcm` (engine ≥ 1.11.0: the determination's natural MAR
  at the site, Mm³ a year, above 0 up to 1e6, or `null`; absent = not
  recorded) `}`, and from engine 0.33.0 (model.md §2.9d) two optional fields:
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
  values, each `wr2012` group, `fitRecord` and `pe` are replaced whole. An
  unknown top-level key is dropped (never stored; a new setting must be added to
  `SettingsPatch`), and the settings patch is capped at 64 000 characters
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
  fitReference?, fallback?, gaugeInChirps?, quantileMap?, reason }`. `start` ≤ `end` are
  `YYYY-MM-DD`; `series` is `rain_catchment_alt_mm`; `reason` 1–500
  characters, trimmed. `factors` is either 12 numbers (Oct … Sep, each
  0.25–4) with `provenance: { source, fittedFrom, fittedTo, method }`
  (source and method 1–200 characters, the dates `YYYY-MM-DD`, from ≤ to),
  or `'fit'` with `fitReference: { series, fromWaterYear, toWaterYear }`
  (`rain_reanalysis_mm` or `rain_chirps_mm`, water years 1800–2200, from ≤
  to). `fallback` is absent (CHIRPS × the fit-period factors) or `{ series:
  'rain_reanalysis_mm', fromWaterYear, toWaterYear }`. With `gaugeInChirps:
  true`, `fitReference.series` may not be `rain_chirps_mm` and `fallback`
  is required. `quantileMap` (engine ≥ 1.21.0, issue #66) is absent (the
  monthly factor alone, the default) or `{ fromWaterYear, toWaterYear,
  wetDayMm }`: water years 1800–2200, from ≤ to, and a wet-day threshold of
  0.1–10 mm (no other keys). No other keys, and no two periods overlapping. The check is
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
  `qualityFlags` (engine ≥ 1.22.0, CR-18/19, [model.md
  §2.10h](./model.md#210h-per-day-quality-flags-and-the-flag-aware-objective-engine--1220-calibration-research-cr-181922))
  is `{ ratings, aboveRating, belowRating, suspect, infilled }`, any subset
  patched, `ratings` replaced whole: `ratings` maps `flow_observed_m3s` and
  `flow_logger_m3s` (no other kind) to `{ gaugedMaxM3s, gaugedMinM3s, source
  }`, the highest (> 0) and lowest (≥ 0, below the highest) field gauging in
  m³/s or `null`, and a source of at most 200 characters, required once a
  bound is set; `aboveRating` is `censor` (default) | `exclude` | `include`,
  the other three `exclude` (default) | `include`. Anything else is a `400`.
  It changes only automatic calibration and the recession diagnostics, never
  a run's calibration statistics, with one exception from engine 1.23.0:
  `infilled` also decides whether days that `flowGapFill` filled count in the
  run's calibration statistics, the EWR test on the observed record and the
  plausibility checks (they are not readings, so they aren't scored unless
  `include`). Settings stored before it read back with
  the defaults.
  `flowGapFill` (engine ≥ 1.23.0, issue #66) is `{ flow_observed_m3s,
  flow_logger_m3s }`: per observed record `null` (not filled,
  the default) or `{ interpolateMaxDays (whole, 0–30), donor
  ('flow_observed_m3s' | 'flow_logger_m3s' | 'flow_reference_m3s' | null, never
  the record itself), donorMaxDays (whole, 1–366), donorMinOverlapDays (whole,
  30–36 600) }`, strict, replaced whole. Whether filled days are scored is
  `qualityFlags.infilled` (above). The retired `useFilledDays` (never
  deployed) is a `400` in a patch, and ignored with a run warning in stored
  settings. A `PATCH` merges the group one level
  deep. Anything else is a `400`; settings stored before it read back as off.
  [model.md §2.10i](./model.md).
  `calibrationRules` (engine ≥ 1.25.0, issue #153, [model.md §2.10j](./model.md))
  is automated calibration's rule set, replaced whole: `{ revision?,
  exclusions: { maxFlaggedShare (0 < x < 1, or null) }, forcing: { pan
  ('project' or a pan preset id, 1–8) }, cases: { bounds (wide | typical),
  objectives (the objective ids) }, selection: { test (dryWet | split |
  independent), score (an objective id) }, run: { seed (whole, 0 – 2³¹ − 1),
  starts (1–10), budget (whole, 50–10 000) }, after: { onNewData ('off' |
  'report' | 'apply'), ensemble (boolean) }, filters: { wr2012Mar,
  typicalParams (booleans) }, signedOff ({ by (1–200 characters, the
  signer's typed name), on (YYYY-MM-DD) } or null) }`, strict, with at most 8 fits (forcing × bounds × objectives) and no
  entry listed twice; anything else is a `400`. The server sets `revision`:
  a save that changes a rule adds 1 and clears `signedOff` unless the same
  save records a new one; a sign-off alone keeps it. A new sign-off's `on` is
  the server's date whatever is sent, and it (and a withdrawal) is recorded
  in the history as `calibration_rules.signed_off` /
  `calibration_rules.sign_off_withdrawn` with the signed-in account. Settings stored before
  it read back with the defaults (revision 1, not signed off).
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
  multi-start fit (absent on a record made before those, i.e. one start),
  `observedOrigin` (`{ source, unit, factor }` of the fitted record, 107, or
  `null`) and `flowGapFill` (`{ spec }`, engine ≥ 1.23.0; both
  absent on older records), and from engine 1.22.0 the optional `qualityFlags` (validated like the
  setting), `dayQuality` (the fit's `DayQuality` summary: `flowKind, rating,
  use, windowDays, flow, scoredDays, censoredDays, leftOutDays,
  suspectZeroDays, rain, notes`, or `null`) and `fitAllDays` (a scored
  period, or `null`), from engine 1.25.0 the optional `auto` (issue #153:
  `{ rules, ruleExclusions, chosen, cases }`, how automated calibration chose
  the fit), and no others. `auto` is the server's to write
  ([§ Automated calibration](#automated-calibration) `…/apply`): a save whose
  `fitRecord` carries a new or changed `auto` is a `409`; one carrying the
  stored record back unchanged is fine. `POST /projects/import` checks a
  file's automated fit against the file's own `calibrationRules` (a `400`,
  "invalid project file").
  Each scored period (`fit`, `before`, a test's `calibration`
  and `validation`, `marPenalty.unpenalised.fit`) is `{ start, end,
  waterYears, scores, intervals?, benchmarks? }`, `scores` at most 30
  numbers-or-null by name. From engine 1.19.0 (CR-5) `intervals` is `{ level,
  resamples, seed, years, kgePrime, nse, kgeLowHigh }`, each score `{ lo, hi
  }` or `null`, and `null` itself with fewer than 3 water years; `benchmarks`
  is `{ meanFlow, climatology, halfWindowDays }`, two score sets like
  `scores`. Both are optional (absent on a record made before them), and a
  period with any other key is a `400` ([model.md
  §2.10b](./model.md#210b-automatic-calibration-engine--050-issue-4-phase-4)).
  `bounds` is
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
string, plus headers), and a request can't be streamed. For scale, a catchment's
`project.json` with a few daily series over several decades and a multi-farm
network is **well under 1 MB** compact; a 60 000-day series is about 0.8–1 MB. So a real
catchment has ample headroom, and gzip request bodies were not added.
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
`importedBy` (the importer's display name). `200 { report: null }` when the
project wasn't imported through the dialog (made by hand, copied, or imported
with no report): the Project page asks on every visit, so "none" is an answer,
not an error. `404 not found` for a project you can't see.

**Not in `export.json`.** The export is the project's inputs, the document
that imports back into a project. An import report describes one import of a
*different* file; inside an export it would ride into the next import and be
stored as though the export had come from the workbook. So the export leaves it
out, and a re-import of an export records itself as a `project-file` import.

### Members

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role, party }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { invited: true, invite }`, the same whether or not the address has an account (issue #136, see Invites); `409` if a verified account with that address is already a direct member; `429` with `Retry-After` past the daily cap on adding by email (below) | owner |
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
their links go with the membership. Adding a farmer by email is always an
invite (WP-2.2, issue #136, [§ Invites](#invites)), with the farms the invite
will link, whether or not the address has an account; a `409` if a verified
account with that address is already a member (change a farmer's farms with
`PUT …/farmers/:userId`). Revoke a pending one with
`DELETE /projects/:id/invites/:inviteId`.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/farmers` | – | `{ farmers: FarmerEntry[] }`: the farmers, then (owners only, by RLS) the pending farmer invites | viewer |
| POST | `/projects/:id/farmers` | `{ email, nodeIds: uuid[1..50], locale?: <language code>, role?: 'farmer' \| 'contributor' }` | `role` (default `farmer`): `contributor` adds or invites a licence applicant with the farms they hold (WP-3.3, 097), with the ordinary invite email for that role. `201 { farmer }` for a verified account, or `201 { invited: true, invite }` (an `InvitedFarmer`) for any other address, the same answer whether or not an unverified account exists. Re-inviting sets the invite's farms to `nodeIds`. `409` when the account is already a member; `400` when a node isn't a farm of this project; `429` past the daily cap on adding by email | owner |
| POST | `/projects/:id/farmers/bulk` | `{ rows: { email, farm, locale? }[1..200], dryRun?: boolean }` | `200 { results: { row, email, farm, status: 'added' \| 'invited' \| 'error', error? }[], dryRun }`; `429` when its distinct valid addresses (a dry run's too) would pass the daily cap on adding by email | owner |
| PUT | `/projects/:id/farmers/:userId` | `{ nodeIds: uuid[1..50] }` | `{ farmer }`: replaces their farms; `404` if they aren't a farmer (or a contributor) here | owner |

- `FarmerEntry` is an `ActiveFarmer = { status: 'active', userId, email,
  displayName, role: 'farmer' | 'contributor', nodeIds }` (a contributor, an
  applicant, keeps farm links too: WP-3.3; bulk rows may add farms to one) or an `InvitedFarmer = { status: 'invited' |
  'expired', inviteId, email, role, nodeIds, invitedBy, expiresAt, locale }`
  (farmer invites, and applicant invites that carry farms; an applicant
  invite without farms is only in `GET /invites`). An
  invite's `nodeIds` shrink when one of its farms is deleted or stops being a
  farm; it never gains one.
- `locale` is the invite email's language, `en` by default: any code in the
  language table (another is a `400`). A key the language's email catalogue
  lacks is sent in English.
- **Bulk** takes one farm per row (a CSV of `email,farm,language`). Each row
  is checked on its own, and a bad row never stops the others: an invalid
  address, a farm name that doesn't match a farm of this project **exactly
  and case-insensitively** (never a guess at a near name), or a language
  that is neither a code in the language table nor a language's own name
  (`en`, `English`, `af`, `Afrikaans`, any case) is that row's `error`
  (`unknown language “fr” (use en, af, or the language’s name)`). Rows are then grouped by address: a farmer already
  here gains the farms (`'added'`; the rows never take one away), anyone
  else, account or not, is invited with the farms of all their rows (added
  to any the invite already names; `'invited'`, issue #136), and a member
  with another role is an `error`, as is an
  address given more than 50 farms in one request (the single-add cap). One email
  per address at most, after commit, with the usual re-send cooldown; the
  first row's language wins. `row` is the index into `rows`.
- `dryRun: true` works out every row's outcome and rolls the lot back:
  nothing is written, no email goes out. The Invite farmers dialog shows it
  as the preview before sending.

### Invites

Adding any address creates a **pending invite** (issue #136): the response,
and the row in the owner's invite list, are the same whether the address has
no account, an unconfirmed one or a verified one. Only the email differs:

- **No account:** a sign-up link (`/register?invite=…`, valid 7 days).
- **An account that never verified the address** (it can't sign up again): a
  confirm-your-email link for that account (`/verify-email?token=…`, 48 h),
  with a note to use "Forgot password" instead if they never created the
  account (someone else registered their address). No email if a
  verification link went out in the last minute — that link accepts the
  invite too.
- **A verified account:** a link to the invitations page
  (`/account/invitations`), where its holder accepts or declines it
  ([§ Your invitations](#your-invitations)).

For no account or an unconfirmed one, the invite becomes a membership with
the invited role once that address is **verified** — by signing up through
the link, by the verification email, or by a password reset. An unverified
account alone never claims invites, so pre-registering a colleague's address
doesn't get you added in their place. A verified account joins only when its
holder **accepts** the invite, so nobody is made a member unasked and the
adder never learns whether the address has an account.
Re-adding the same address updates the role; the email is re-sent (with a
fresh link, the old one stops working) unless one went out in the last minute.

**The daily cap on adding by email** (issue #51, `101_invite_throttle.sql`,
`invites/invites.ts` `INVITE_CAP`): a person adds at most **300** addresses a
day, and a project or team is added to at most 300 times a day, across
`POST /projects/:id/members`, `/farmers`, `/farmers/bulk` (each distinct
valid address counts, a dry run's too) and `POST /teams/:id/members`. Every
address counts before it is looked up, whether it is then added or invited;
past the cap the answer is `429 { error }` with `Retry-After` (seconds),
the same for any address, and nothing is counted, added, invited or mailed.
A window is 24 hours from its first add.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/invites` | – | `{ invites: Invite[] }` (newest first, expired ones included) | owner |
| DELETE | `/projects/:id/invites/:inviteId` | – | `204` (revoke; the link stops working) | owner |

- `Invite = { id, email, role, invitedBy, createdAt, expiresAt, expired }` —
  `invitedBy` is the display name of whoever last sent it.
- Farmer invites ([§ Farmers](#farmers)) are listed here too, with `role:
  "farmer"`; `GET /projects/:id/farmers` lists them with their farms. The
  Members panel leaves them to the Farmers panel.

### Your invitations

The signed-in account's own pending invitations (issue #136,
`109_invite_accept.sql`), for an address it has **verified**: projects and
teams alike. Any signed-in account; each call sees only its own.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/me/invites` | – | `{ invites: MyInvite[] }`, live ones only, newest first; empty for an unverified address |
| POST | `/me/invites/:inviteId/accept` | – | `200 { joined: { kind: 'project' \| 'team', id } }`: the membership, a farmer or applicant invite's farm links, and the `member.added` / `farmer.linked` / `team_member.added` events, as the account; `404` when it isn't yours, has expired or doesn't exist |
| DELETE | `/me/invites/:inviteId` | – | `204` (decline: the invite is deleted; a project's History records `invite.declined` with the masked address and no actor); `404` as above |

- `MyInvite = { id, kind: 'project' | 'team', targetId, name, role,
  invitedBy, farms: string[], createdAt, expiresAt }`: `name` is the
  project's or team's, `role` the project role (or team role) it gives,
  `farms` a farmer or applicant invite's farm names.

## Teams

A team owns many projects (catchments) together. Team roles: `viewer` <
`member` < `admin`. Admins rename/delete the team and manage its members; on the
team's projects admins are owners, members are editors and viewers are viewers
(see Projects above). A team viewer can't add projects to the team (create,
move or copy into it). `role` in the member and invite bodies is one of
`viewer`, `member`, `admin`; anything else is a `400`. The UI and the invite
email show them by the project role they give, viewer / editor / owner
([ui.md § Teams](./ui.md#teams)); the values here don't change.

| Method | Path | Body | Response | Min team role |
| --- | --- | --- | --- | --- |
| GET | `/teams` | – | `{ teams: Team[] }` (teams you're in, by name) | – |
| POST | `/teams` | `{ name }` | `201 { team }` (you become its admin) | – |
| GET | `/teams/:id` | – | `{ team, members: TeamMember[] }` (admins first, then members, then viewers) | viewer |
| PATCH | `/teams/:id` | `{ name?, settings?: { portfolio: { thresholds: { green, amber } \| null } } }` (at least one) | `{ team }`. `thresholds` sets the portfolio's traffic lights (below); `null` goes back to the defaults. A change records `team_thresholds.changed` on each of the team's projects; one that changes nothing records nothing | admin |
| DELETE | `/teams/:id` | – | `204` — its projects stay, owned by their direct members (`team` → `null`) | admin |
| POST | `/teams/:id/members` | `{ email, role }` | `201 { invited: true, invite }`, the same whether or not the address has an account (issue #136, see Projects § Invites); `409` if already a member; `429` past the daily cap on adding by email (Projects § Invites) | admin |
| PATCH | `/teams/:id/members/:userId` | `{ role }` | `{ member }` | admin |
| DELETE | `/teams/:id/members/:userId` | – | `204` (admins remove anyone; anyone may remove themselves = leave) | viewer |
| GET | `/teams/:id/invites` | – | `{ invites: Invite[] }` | admin |
| DELETE | `/teams/:id/invites/:inviteId` | – | `204` | admin |
| GET | `/teams/:id/portfolio` | – | `Portfolio` (see [Portfolio](#portfolio) below) | viewer |

- **History.** A team role is a role on every project of the team, so adding,
  re-roling and removing a member (or their leaving, or accepting a team
  invite), and deleting the team, record `team_member.added/role/removed` /
  `team.deleted` on each of the team's projects (072).
- `Team = { id, name, role, createdAt, memberCount, projectCount, settings, portfolioThresholds }` — `role` is
  **your** role in the team. `settings` is the stored document
  (055_team_settings): `{ portfolio?: { thresholds?: { green, amber } } }`.
  `portfolioThresholds = { green, amber, source: 'team' | 'default' }` is what
  the portfolio judges by: the team's own, or the defaults (5, 20).
- **Thresholds** (decision D11): percent of the last 30 days with the outlet
  EWR not met, `green` and `amber` each 0–100 with `green < amber` (decimals
  allowed); anything else, or an unknown key anywhere in `settings`, is a
  `400` (`backend/src/teams/settings.ts`; the 055 CHECK holds the same shape
  in the database). Every member reads them; only an admin changes them.
- `TeamMember = { userId, email, displayName, role }`
- `409 a team must keep at least one owner` when removing or demoting the last
  admin (including the last admin leaving). A team you aren't in is `404`.

### Portfolio

`GET /teams/:id/portfolio` (roadmap WP-2.14, `backend/src/portfolio/`): every
catchment of the team you can see, with its latest figures, for the WUA's
dashboard. Any team member; a team you aren't in is `404`, and so is every
farmer (a farmer has no team membership). The rows come from **one query**
run as you under RLS, whatever the number of projects (guarded by a query
count in `portfolio.db.test.ts`); a project where your role is `farmer` is
left out, so nobody gets a catchment roll-up of their neighbours.

- `Portfolio = { team: { id, name, role }, thresholds: { green, amber, source }, projects: PortfolioProject[] }`;
  there is no team-wide "today": each row counts to its own project's
  (below). `thresholds` are the
  traffic-light cut-offs every `ewr.status` below was judged by, in percent,
  and `source` says whether they are the team's (`team`) or the defaults
  (`default`), so the page can say which apply.
- `PortfolioProject = { id, name, role, timeZone, today, dataUntil, lastRunAt, publishedAt, source, sourceRunId, figuresUntil, figuresAgeDays, stale, behindData, newerRun, ewr, farmsShort7, farmsShort30, farmCount, lowestDamPct, damsKnown, feeds, alertsFiring, restriction }`, by name:
  - `timeZone` / `today`: the project's time zone and the calendar day
    there when the server answered. `figuresAgeDays`, `stale` and the feeds'
    health count to that day, so a team with catchments in several zones
    gets each row right, and a South African row isn't a day behind from
    22:00 to 24:00 UTC.
  - `source`: where the figures come from. `published`: the current
    publication. `run`: nothing is published, so the newest baseline run
    (not a scenario run). `null`: no run. `sourceRunId` is that run.
  - `figuresUntil` / `figuresAgeDays`: the last day the figures cover (the
    source run's last day of observed rain) and its age; `stale` when older
    than 7 days (the farm page's rule). `behindData`: the project holds
    recorded rain after `figuresUntil`. `dataUntil` is that newest day of
    recorded rain (the project list's rule, to the last day with a value).
    `newerRun`: a baseline run newer than the published one exists. A
    forecast run never counts as one (with a CHIRPS-GEFS feed one is made
    every day), nor as the source run or `lastRunAt`: it is guidance beside
    the runs.
  - `ewr = { status: 'green' | 'amber' | 'red' | 'unknown', daysNotMet30, days30, fraction30, reason? }`:
    the outlet EWR over the 30 days to `figuresUntil` (the publication's
    `catchmentView`, or, for `source: 'run'`, counted in SQL from that run's
    one outlet series; the DB test checks the two agree). Thresholds (D11):
    **green** below `thresholds.green` % of the days not met, **amber**
    below `thresholds.amber` %, **red** otherwise: the team's own
    ([Teams](#teams)), or by default 5 % and 20 %, which the hydrologist
    still has to confirm (plan.md D11). A boundary is exclusive: exactly
    5 % is amber. `unknown` carries `reason`: `no-figures` (no
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
| POST | `/me/alerts/resume` | – | `{ mailSuppressed: null }`. Turns alert emails back on after SES suppressed your address: takes it off SES's suppression list (production), then clears the flag; your choices apply again as they were. Harmless when nothing is paused. `429` within a day of the last resume (the address bounced again) | signed in |
| GET | `/projects/:id/alert-rules` | – | `{ rules: AlertRule[] }`: every project-wide kind, a `dam_below` per farm in network order, and a `data_stale` per data feed (057); one not saved yet is `{ id: null, enabled: false }` at its default threshold (a feed's: its source's) | editor |
| PUT | `/projects/:id/alert-rules` | `{ rules: { kind, nodeId?, feedId?, threshold, enabled }[] }` (1–500) | `{ rules: AlertRule[] }`. Upserts each, records `alert_rules.changed`, and queues an `alert_eval` (a kind switched on over a figure already past it fires at once) | editor |
| GET | `/projects/:id/alert-events?state=firing\|all` | – | `{ events: AlertEvent[] }`, newest first, at most 100: the firing ones (default), or firing and cleared. As RLS lets the caller see them: a farmer gets their own farms' dam alerts and the restriction-notice events, never another farm's; an applicant gets `[]` | farmer |
| POST | `/alerts/unsubscribe` *(public)* | JSON `{ token }`, or a form post with `?token=` | JSON: `200 { kind, project: { name }, farm }`; form: `204` | – |

- Kinds, what fires them, and who gets them by default:

  | `kind` | Fires when (hysteresis: re-arms only after recovery) | `threshold` | Default: right away | May opt in |
  | --- | --- | --- | --- | --- |
  | `dam_below` (per farm) | the published projection's dam level on its last day of data, or the published forecast's lowest, is below the threshold; re-arms at threshold + 5 points | 0 < t < 1 (0.3) | that farm's farmers, editors, owners | viewers |
  | `ewr_forecast_fail` | the newest forecast run (while its days haven't passed) has `outletEwrDaysAtRisk ≥ t`; re-arms at ≤ t − 2. A forecast run behind the recorded rain (its `lastObserved` before the last day with a catchment or CHIRPS value) is ignored: it neither opens nor clears an event until the re-made one | whole days 1–60 (3) | editors, owners | viewers |
  | `data_stale` (per feed) | that feed, enabled, is more than t days past its own usual delay (`feeds/health.ts` `staleAfterDays`, or the feed's config); re-arms under t | whole days 1–60 (by source: CHIRPS 3, CHIRPS-GEFS 2, DWS 30) | editors, owners | – |
  | `restriction_published` | the current publication's restriction level, percentage or notice changes (a lift too) | 0 | farmers, viewers and up | – |
  | `feed_failing` | an enabled feed failed t times in a row; re-arms at 0 | 1–20 (3) | owners | editors |
  | `job_dead` | t jobs died in the last 24 hours; re-arms at 0 | 1–100 (1) | owners | editors |

  Applicants (contributors) never get alerts. A `threshold` outside its
  range, a `dam_below` rule without a farm (or another kind with one), or a
  `data_stale` rule without a feed (or another kind with one) is `400`; a
  farm or feed of another project `404`. Once `data_stale` is on for any
  feed, a feed added later gets its own rule, on, at its source's default.
- `ProjectAlerts = { id, name, role, muted, choices: AlertChoice[] }`.
  `AlertChoice = { kind, nodeId, nodeName, mode, defaultMode, chosen, ruleOn, threshold }`:
  `mode` is what you get now (the database's own rule,
  `app_alert_my_mode`), `defaultMode` your role's default, `chosen` whether
  you set it, `ruleOn` whether the catchment has it switched on (off, you
  get nothing whatever you choose). A farmer has one `dam_below` choice per
  own farm; everyone else one for every farm. `threshold` is a farm's dam
  alert level, the WUA's rule for that farm as a fraction (0.3 = 30 %),
  `null` for any other choice or a farm with no rule (issue #51). `muted`: every alert email
  for the catchment is off (a digest's one-click unsubscribe).
- `mode` ∈ `immediate` (right away, at most 5 a day; the rest wait for the
  digest), `daily_digest` (in the 06:00 summary, 06:00 in the project's time zone), `off`.
  `kind: 'all'` with `immediate` or `off` is the catchment-wide switch.
  PUT refuses (`400`) a kind your role never gets, a `nodeId` on anything but
  a farmer's dam alert, and `daily_digest` for `all`; a farmer naming a farm
  that isn't theirs gets `404`. Turning a choice back on (from `off`) draws a
  new unsubscribe token, so a link in an older email no longer works.
- `AlertRule = { id, kind, nodeId, nodeName, feedId, feedName, feedEnabled, threshold, enabled, firing }`
  (`feedName` as the feeds page names the feed, e.g. "CHIRPS daily rainfall (Upper)").
- `AlertEvent = { id, kind, state, value, threshold, nodeId, nodeName, feedId, openedAt, clearedAt, detail }`.
  `detail` holds the figures the alert was raised on: `dam_below`
  `{ source: 'latest'|'forecast', pct, date, madeOn?, publishedAt }` (that
  farm's own projection only); `ewr_forecast_fail` `{ days, of, from, to,
  madeOn }`; `data_stale` `{ feedId, feeds: [{ label, newest, overdue }] }` (its one feed;
  `overdue` counts to today in the project's time zone);
  `feed_failing` `{ feeds: { label, failures }[] }`; `job_dead` `{ count }`;
  `restriction_published` `{ publicationId, level, pct, lifted, publishedAt }`.
  While an event fires, its `value` and `detail` follow the figure. A
  forecast's `madeOn` is the day the run was made, and "still current" (its
  `to` not yet past) is judged against today, both in the project's time
  zone.
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
  from 06:00 to 06:00 in the time zone of the project whose alert is being
  sent (`project.time_zone`, 059_local_day; South Africa's by default;
  `ALERTS_DAILY_CAP`). The rest, and everything a person chose to get daily,
  go out in one **digest** per catchment after 06:00 there. A digest lists at most 20 alerts (the newest), then
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
- **A bounced or complaining address** (SES's bounce and complaint events,
  [deployment.md § Alert emails](./deployment.md#alert-emails)) pauses that
  person's alert emails: no deliveries are made for them, waiting ones are
  skipped, and `/auth/me`'s `mailSuppressed` says why, for the banner. A
  transient bounce (a full mailbox) changes nothing.

## Model data

The editable model (network, crops, crop areas, transfers) is read and saved as
one document — the editor holds it in memory and saves it in one transaction.
Ids are client-generated UUIDs; rows missing from a `PUT` are deleted.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/model` | – | `ProjectModel` | viewer |
| PUT | `/projects/:id/model` | `ProjectModel` | `ProjectModel` | editor |

Transfers carry `priority` (integer, lower moves first, engine ≥ 0.16.0) and
`monthlyRateM3s` (engine ≥ 1.14.0, migration 090: twelve numbers ≥ 0, the max
rate in m³/s per water-year month Oct–Sep, 0 = off that month, or `null`, the
default: `maxRateM3s` in the listed `months`). With monthly rates set,
`months` must be the months with a rate above 0 and `maxRateM3s` the largest
rate, or `PUT` refuses the model ([model.md §2.6](./model.md)). A transfer
may be a river off-take (engine ≥ 1.14.0, migration 091, [model.md
§2.6a](./model.md)): `source` (`"dam"`, the default, or `"river"`),
`handsOffM3Day` (≥ 0 or `null`, the default: none), `handsOffEwr` (default
false), `lossPct` (0 ≤ l < 1, default 0), `sizing` (`"demand"`, the default,
or `"capacity"`) and `topUpDam` (default false); a body without them is a dam
transfer. `PUT` refuses a river off-take that isn't unit to unit or whose
destination drains into its source (along the river or through other
off-takes). A run with off-takes stores `offtake_out` on each source,
`offtake_in`, `offtake_used` and `offtake_to_dam` on each destination, and
each rule's `transfer_rule@<id>` (what it took, before losses);
`summary.waterBalance` and the water account gain `conveyanceLossM3`;
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

Development over the run (engine ≥ 1.30.0, migration 110, issue #67,
[model.md §2.7g](./model.md)): every node carries `damSurveyDate`,
`damSedimentPctPerYear`, `damInServiceFrom` and `abstractionFrom`, each
`null` (the default: a body without them runs as before) or set. The dates
are `"YYYY-MM-DD"` strings and must be real days; the sediment rate is a
share of the surveyed capacity lost a year, 0–0.2. `PUT` refuses a positive
rate without a survey date, any of the three dam fields on a node that isn't
a farm, an `abstractionFrom` on a gauge, and a date that doesn't exist (the
engine's `developmentProblem`, through `modelRuleProblems`); `GET` returns
them as stored. A scenario's `node.set` may change them (the dam fields on a
farm, `abstractionFrom` on a farm or user; [scenarios.md](./scenarios.md)).

Crop demand options (engine ≥ 0.43.0, migration 061, issue #54,
[model.md §2.3](./model.md#23-irrigation-demand) steps 6–7): a crop may carry
`irrigationEfficiency` (0 < e ≤ 1, or `null` / absent = the farm's own). `GET`
leaves the key out for a crop without one, so an older document reads back
unchanged; `PUT` with `null` clears it and refuses anything outside (0, 1].
Settings gain `effectiveRainFractionMonthly` (12 numbers 0–1, water-year
months, or `null` = `effectiveRainFraction` every month; `PATCH` refuses
anything else). A row of zeros is accepted (the run warns that rain then never
reduces irrigation demand). Unset, both leave every run unchanged.

`ProjectModel.boreholes` (engine ≥ 0.36.0, WP-3.9; optional, and absent from
`GET` when the project has none) is `{ id, nodeId, name, capacityM3Day,
annualCapM3 (null = no cap), mode ('none' | 'supplemental' | 'primary' |
'emergency'), emergencyBelowPct (0–1), target ('direct' | 'dam'),
depletionFactor (0–1) }[]`, at most 5 000. `PUT` refuses a borehole on a gauge
or an unknown node, and an emergency or dam-target borehole on a node without a
farm dam; `mode`, `emergencyBelowPct`, `target` and `depletionFactor` default
to supplemental, 0.3, direct and 0.

`ProjectModel.demandObjects` (engine ≥ 1.7.0, issue #54 item 2b, migration
088, [model.md §2.7f](./model.md); optional, and absent from `GET` when the
project has none) is `{ id, nodeId, name (1–200), category ('domestic' |
'municipal' | 'industrial' | 'livestock' | 'irrigation' | 'external' |
'other'), sizing ('monthly' | 'perUnit'), monthlyM3Day (12 values ≥ 0, Oct–Sep,
or null), count (≥ 0 or null), litresPerUnitDay (≥ 0 or null), lossPct
(0 ≤ l < 1), monthlyFactor (12 values ≥ 0, or null = 1), returnPct (0–1),
priority ('first' | 'shared' | 'last'), destination ('internal' |
'external'), enabled, schedule (below, or null), note (≤ 1000 chars) }[]`,
at most 5 000. Defaults: other, monthly, null, null, null, 0, null, 0, shared,
internal, true, null, ''. `PUT` refuses an object on a gauge, an other water
user or an unknown node, a monthly one without 12 values, a per-unit one
without a count and litres, and an external one with a return share above 0.

A demand object's `schedule` (engine ≥ 1.17.0, migration 105, issue #90 Q4,
[model.md §2.7f](./model.md)) is null or at most 24 windows `{ label (≤ 200,
default ''), span ('always' | 'yearly' | 'range' | 'easter'), from, to
('yearly': 'MM-DD'; 'range': 'YYYY-MM-DD'; else null), easterFrom, easterTo
('easter': whole days from Easter Sunday, −60 to 60; else null), weekdays (ISO
1 = Monday … 7 = Sunday, at least one, or null = every day), factor (0–10, 0 =
off) }`; the later of two windows covering a day wins. `PUT` refuses a date
that doesn't exist, a span that ends before it starts and a factor out of
range; an empty list is stored, and read back, as null.

Boreholes (engine ≥ 0.23.0, migration 012, [model.md §2.7d](./model.md)):
every node carries `boreholeCapacityM3Day` (≥ 0 or `null` = none),
`boreholeRule` (`"supplemental"` | `"primary"` | `"drought"`),
`boreholeTriggerPct` (0–1), `streamDepletionFrac` (0–1) and
`streamDepletionLagDays` (0–36 500). A body without them gets `null`,
`"supplemental"`, 0.3, 0 and 0. `PUT` refuses boreholes on a gauge and the
drought rule on a node without a farm dam.

Supply rules and the river pump (engine ≥ 0.42.0, migration 060, WP-3.8,
[model.md §2.7e](./model.md)): every node carries `supplyRule`
(`"damFirst"` | `"riverFirst"` | `"trigger"` | `"runOfRiver"`),
`pumpCapacityM3Day` (≥ 0 or `null` = no limit), `supplyTriggerPct` (0–1) and
`supplyStopPct` (0–1). A body without them gets `"damFirst"`, `null`, 0.4
and 0.6 (no change to any run). `PUT` refuses a rule other than
`"damFirst"` or a pump capacity on a gauge or other user, `"trigger"` on a
farm without a dam, `"runOfRiver"` on a farm with a dam capacity above 0, and
a stop level below the trigger. Runs of a farm with a rule other than
`"damFirst"` store the series `river_abstraction` (m³/day, part of
`supplied`) and its summary gains `avgRiverAbstractionM3Day`.

EWR sites (engine ≥ 1.5.0, migration 086, [model.md §2.7b](./model.md)):
every node carries `ewrSite` (boolean; a body without it gets `true`, no
change to any run). `false` takes a gauge off the EWR sites: its shortfall
charges nobody, its `ewr_charged` / `ewr_natural` series and its row in
`summary.curtailment.ewrSites` go, and a Reserve rule table there is skipped
with a warning. `PUT` refuses `false` on the outlet or on a farm or other
user.

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
| PUT | `/projects/:id/series` | `{ kind, name?, unit, startDate, values, product?, productVersion?, dayBoundary?, source? }` | `SeriesMeta & { rerunQueuedFor }` (upsert on kind+name) | editor |
| POST | `/projects/:id/series/merge` | `{ kind, name?, unit, startDate, values, product?, productVersion?, dayBoundary?, source? }` | `SeriesMeta & { rerunQueuedFor }` (merge by date; creates the series if missing; a `null` day keeps its stored value, so a file never erases: clear days with a PUT) | editor |
| PATCH | `/projects/:id/series/:seriesId` | `{ product, productVersion }` (both strings, or both `null` to clear), and/or `{ siteNodeId }`, and/or `{ source }` (a string, or `null` to clear; 107) | `SeriesMeta`: says what an existing series holds, where its values came from (`source`), or where a flow record was measured (`siteNodeId`: a gauge node above the outlet, or `null` for the outlet; 084, engine ≥ 1.4.0, [data-model.md](./data-model.md#gauge-records-084_gauge_recordssql)); the values and `updatedAt` are untouched. `400` for a site on a rain or evaporation series, a node that isn't in the project (save the model first), a farm or user, or the outlet gauge. Logged as `series.labelled` / `series.site_changed` when it changes | editor |
| DELETE | `/projects/:id/series/:seriesId` | – | `204` | editor |

`SeriesMeta = { id, kind, name, unit, startDate, length, updatedAt, lastValueDate, product, productVersion, dayBoundary, siteNodeId, source, sourceUnit, sourceUnitFactor, rebuilding, feed }` —
`source` is where the values came from (a station id, agency, file or data feed; `null` = not recorded) and `sourceUnit` /
`sourceUnitFactor` the unit the upload gave and the factor that converted it to `unit` (both `null` = not recorded; 107,
[data-model.md § Series source and unit](./data-model.md#series-source-and-unit-107_series_sourcesql)). A PUT records exactly what it
was (a `source` it doesn't give is cleared); a merge records them only on a new or empty series. `source` is 1–200 characters on one line
(`400` otherwise); the given unit is never a body field, and a PATCH naming `sourceUnit` is a `400`;
`lastValueDate` is the last day with a value (`null` when every day is blank): how far the data reaches, where `startDate + length − 1`
counts the blank days a merge stores (the Data page's freshness, "Data now runs to", the report's data coverage);
`siteNodeId` is the gauge a flow record was measured at (`null` = the outlet; only the plausibility checks read a gauge's record);
`rebuilding` is true while a data feed backfills a confirmed replacement of the
series (its values stay as they are until the swap);
`feed` is the data feed that wrote days of the series, `{ source, days }` (`source` the feed's `chirps`, `chirps_gefs` or `dws`;
`days` how many of the series' days are still the feed's, `time_series.feed_days`, 031, [data-model.md § Feed days](./data-model.md#feed-days-031_feed_dayssql)),
or `null` when no day is a feed's, and always `null` to an API key (below viewer, it can't read `data_feed`; the Data tab's mark);
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

**Source and given unit** (issue #66, [data-model.md § Series source and
unit](./data-model.md#series-source-and-unit-107_series_sourcesql)): `source`
says where the values came from, e.g. `DWS X1H001`; the unit the body gives
(`l/s`, `ML/day` …) and the factor that converted it are recorded by the
route itself as `sourceUnit` / `sourceUnitFactor`. A PUT records exactly
what it was (no `source` clears it); a merge records them on a new or empty
series and otherwise keeps the series' own. A data feed records itself
(`"CHIRPS daily rainfall data feed"`, `"DWS gauge flow data feed, station
A2H012"`) on a series it creates or replaces. The project document carries
them per series (`source`, `sourceUnit`, `sourceUnitFactor`), each only when
recorded; an import records exactly what the file carries, so a series
without them exports back without them (an exact round trip).

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
`rain_forecast_mm`, `flow_observed_m3s`, `flow_logger_m3s`,
`flow_reference_m3s` and `evap_apan_mm` (`flow_pitman_m3s` was removed in engine 0.10.0).
`evap_apan_mm` (engine ≥ 0.38.0) is a daily A-pan evaporation record in mm
(given in mm, cm or in): on the days it has a value it replaces the monthly
A-pan means, and a run reports the days that fell back to them in
`summary.apanDaily` ([model.md §2.3a](./model.md#23a-daily-a-pan-evaporation-engine--0380-issue-45)).
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
| POST | `/projects/:id/runs` | `{ label?, forecast? }` | `201 { run, removedRunIds }` — `removedRunIds`: older runs deleted by the per-project cap (for a forecast run: the project's older forecast run). `forecast: true` makes a **forecast run** (below); `409` when there is no forecast rain after the last observed rain day. The engine runs with no database connection held; your role is checked again before the run is stored, so if you lose editor access meanwhile the answer is `403`/`404` and nothing is stored. The run records the inputs it was computed from, even if the project changes while it runs ([architecture.md § A model run](./architecture.md#a-model-run)) | editor |
| GET | `/projects/:id/model-input` | – | `{ input: ModelInput }`: exactly what a run would use (settings merged over the defaults, the model, the first series of each kind by name), for the in-browser engine (automatic calibration). A forecast series comes whole: the fit cuts the forecast tail itself (`fitInput`, engine `withoutForecastTail`, issue #51), as a saved ordinary run does | viewer |
| GET | `/projects/:id/runs` | – | `{ runs: RunMeta[] }` (newest first) | viewer |
| GET | `/projects/:id/runs/:runId` | – | `{ run: run & { settings, model, verified }, series: { nodeId, key, label, unit }[] }`; `settings` is the run's own settings snapshot (below) and `model` its model snapshot (`{ nodes, crops, cropAreas, transfers, … }` as they were when it ran; the `.xlsx` workbook names its node sheets and fills its Inputs sheet from it); `verified`: its server stamp still matches its rows (security.md § Run stamps), false for a run written past the model run or changed since, which can't be signed off; `forecastRainSource`: a forecast run's rain source, `chirps_gefs` when a CHIRPS-GEFS feed wrote every forecast day (from the first to the forecast series' end), `other` otherwise (an uploaded forecast, or a day a person wrote), `null` for any other run and a forecast run stored before it was recorded; the report credits CHIRPS-GEFS only on `chirps_gefs` | viewer |
| GET | `/projects/:id/runs/:runId/series?key=…&nodeId=…` | – | `{ startDate, values }` (omit `nodeId` for catchment series) | viewer |
| GET | `/projects/:id/runs/:runId/series/bulk?nodeId=…&offset=…` | – | Every series of one node (the catchment's without `nodeId`) in one response, for the `.xlsx` workbook: see [Export § Bulk run series](#bulk-run-series) | viewer |
| GET | `/projects/:id/runs/:runId/day?nodeId=…&date=YYYY-MM-DD` | – | One node's every column on one day, for the day trace: `{ date, nodeId, name, kind, previousStorageM3, previousSoilWaterMm, params, columns: { key, label, unit, value }[] }`. `name`, `kind` and `params` (`pctUpstreamToDam`, `pctRunoffToDam`, `divertCapacityM3Day`, `damCapacityM3`, `damInitialPct`, `damMinPct`, `irrigationEfficiency`, `lossReturnFraction`, `damAreaFullM2`, `damAreaExponent`, `damSeepagePerDay`) come from the run's input snapshot (a run from before engine 0.16.0 has its `returnFlowPct` mapped as migration 006 does: e = 1 − r, β = 1, or 1 and 0 when r = 0; `irrigationEfficiency` is the one the run used, so a farm whose crops carry their own, engine ≥ 0.43.0, gets them combined as [model.md §2.3](./model.md#23-irrigation-demand) step 6 does, and `demand` = `crop_requirement` ÷ it); `previousStorageM3` is the dam storage at the end of the day before (the initial storage on the run's first day: initial % × that day's capacity, engine ≥ 1.30.0; `null` for a gauge); `previousSoilWaterMm` is the farm's soil-water store at the end of the day before, in mm (0 on the run's first day; `null` for a gauge or a run from before engine 0.14.0, which has no `soil_water` column). `400` for a date that isn't one or is outside the run, `404` for a node the run doesn't have | viewer |
| GET | `/projects/:id/runs/:runId/day?date=YYYY-MM-DD` | – | The same without `nodeId`: the catchment's day, for the runoff-model trace (how rain became natural flow): `{ date, nodeId: null, name: "Catchment", kind: "catchment", runoffModel, areaKm2, params, previousStorageMm, previousStores, columns }`. `columns` are every catchment series (`node_id` NULL) that day; for GR4J they include `rain_used`, `pet`, `aet`, `production_store`, `routing_store`, `uh_store`, `exchange` (only when X2 ≠ 0) and `natural_flow` (m³/day), all depths in mm over the catchment. `runoffModel`, `areaKm2` and `params` (`x1` … `x4`, `warmupDays`) come from the run's `summary.runoff`; `previousStores` is each store at the end of the day before (on the run's first day, each store after the warm-up from `summary.runoff.storesStartMm`, engine ≥ 1.20.0; each `null` there on a run from before, which recorded only their total) and `previousStorageMm` their total (the storage after the warm-up on the first day), so before + rain + exchange − AET − Q = after closes the day. A run without a runoff balance ran the legacy model (a stored run from before engine 1.0.0): `runoffModel: "legacy"`, `areaKm2`, `params`, `previousStorageMm` and `previousStores` `null`, and the columns are the [Flow data] ones (`rain_used`, `is_summer`, `rain_flow`, `base_flow`, `response_flow`, `resultant_flow`, `natural_flow`). `400` for a bad or out-of-run date | viewer |
| PATCH | `/projects/:id/runs/:runId` | `{ notes?, pinned? }` (at least one) | `200 { run: RunMeta }` with the new note and its stamp, and the pin. `notes` is a string, trimmed, at most 4 000 characters, no NUL; `''` clears it. `pinned` is a boolean: `true` keeps the run past the run cap (below) and blocks its deletion, `false` releases it; pinning leaves the note's stamp alone. `409 { error: "this project already has 10 pinned runs, the most it can keep; unpin one first" }` when pinning an 11th (re-pinning a pinned run is fine); a **cited** run's pin doesn't count against the 10 (it is kept anyway), and unpinning a cited run is `409 { error: "this run is cited by scenario "…", so it stays kept" }`. No other field is accepted (`400`), and nothing else about a run can change: the database grants the app `UPDATE` on `model_run.notes` and `model_run.pinned` only ([data-model.md § Run notes, Pinned runs](./data-model.md)) | editor |
| DELETE | `/projects/:id/runs/:runId` | – | `204` (the run's stored input series go too, unless another run uses them); `409 { error: "run is published: it is, or was, the published baseline, so it is kept" }` for a run a publication in the history holds ([Publication](#publication)); `409 { error: "this run is cited by scenario "Dam raise", so it is kept" }` for a run something else cites (a [scenario](#scenarios)'s base, a sign-off, or an [evidence pack](#evidence-packs): `this run is cited by the evidence pack version 2, so it is kept`), naming up to three citations you can see (`"this run is cited, so it is kept"` when you can see none; [data-model.md § Cited runs](./data-model.md#stored-run-inputs-021_series_blobsql)); `409 { error: "this run is or was nominated as evidence, so it is kept" }` for a run the evidence history names; `409 { error: "this run is pinned; unpin it before deleting it" }` for a pinned run; `409 { error: "this run can't be deleted" }` when row-level security refuses the delete of a run you can read (never a `404`); `404` only for a run that isn't there (already deleted or trimmed). The check and the delete see one locked row | editor |
| GET | `/projects/:id/evidence` | – | `{ nominations: Nomination[] }`, **oldest first**; the last is the current nomination, unless it is a withdrawal (then no run is the evidence); `[]` when none. `Nomination = { id, withdrawn, runId, runLabel, runCreatedAt, runoffModel, engineVersion, reason, nominatedAt, nominatedBy }`; a withdrawal has `withdrawn: true` and every run field `null` | viewer |
| POST | `/projects/:id/evidence` | `{ runId, reason }` | `201 { nomination, nominations }`: the new row and the whole history. `reason` is required: trimmed, 1–2 000 characters, no NUL. No other field is accepted (`400`): who, when, the runoff model and the engine version are stamped by the database. `404 run not found` for a run not in this project; `409` for a legacy-model run (a stored run from before engine 1.0.0; workbook comparison only), a run whose stored inputs have flow shares over 100 % (made before engine 0.27.1 refused them), the run that is already current, a forecast run (WP-2.12: evidence is judged on the record, and a forecast run's last days are modelled on forecast rain), or a project at its limit of 50 nominations | editor |
| POST | `/projects/:id/evidence/withdraw` | `{ reason }` | `201 { nomination, nominations }`: withdraws the current nomination (098): a history row with no run, stamped like a nomination, the reason required (as above). Nothing is the evidence until a run is nominated again; the withdrawn run shows as past evidence and stays kept, and the project stays undeletable. `409` when no run is nominated (nothing yet, or the last row is already a withdrawal) or at the limit of 50 rows (withdrawals count) | editor |
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
  (CHIRPS-GEFS) ingest that changes days, and after an auto re-run when the
  recorded rain changed since the newest forecast run: a `rerun` job with `trigger:
  'forecast'` (dedupe key `forecast`, the re-run's debounce), labelled
  `Forecast · from <day>`, never published automatically
  ([architecture.md § Background work](./architecture.md)).
- `RunMeta = { id, label, engineVersion, startDate, endDate, createdAt, createdBy, legacy, runoffModel, notes, notesUpdatedAt, notesUpdatedBy, evidence, pinned, published, scenarioId, scenarioName, citedBy, reproducible, trigger, forecastFrom }` —
  `trigger` is what made the run (042_auto_rerun): `manual`, `auto` (WP-2.11)
  or `forecast`; `forecastFrom` a forecast run's first forecast day
  (`summary.forecast.from`), else `null`.
  `legacy` is `settings.runoffModel === 'legacy'` (absent → legacy, for runs
  saved before the setting existed): a run of the legacy runoff model, which
  engine 1.0.0 removed, so only a stored run from before it can be one. The
  app badges it without a second fetch (audit H1, workbook comparison only —
  not evidence). `notes` is the
  modeller's written explanation of the run (`''` = none; e.g. why a WR2012
  *query* or *not usable* flag stands), `notesUpdatedAt` / `notesUpdatedBy`
  (display name) when and by whom it last changed (`null` until first
  written). `runoffModel` is the run's `settings.runoffModel` (`gr4j`, or
  `legacy` for a stored run from before engine 1.0.0; absent → `legacy`). `evidence` is the run's place in the
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
  published, `YYYY-MM-DD` in the project's time zone, a sign-off's the signer's name; `[]` when
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
  `excludedDays` (observed days in the window they removed). From engine
  0.39.0 it carries `fitStatus` (`fitted` | `notFitted` | `edited` |
  `otherPeriod`): whether the run's parameters were fitted on the days scored,
  i.e. whether the scores are in-sample ([model.md §2.10](./model.md)); the
  run comparison's `calibration.fitStatus` is `{ a, b }` of it (`null` when a
  run predates it). When the project has both a gauge and a logger record,
  the run also stores the one not scored as the catchment series
  `observed_flow_other` (labelled "Observed flow" for the gauge, "Observed
  flow (logger)" for the logger, like `observed_flow`).
  Engine ≥ 1.23.0: when `settings.flowGapFill` fills a record (issue #66,
  [model.md §2.10i](./model.md)), the run also stores, beside it,
  `observed_flow_fill` / `observed_flow_other_fill` (per day 0 = measured or
  still missing, 1 = interpolated, 2 = from a donor record) and
  `observed_flow_filled` / `observed_flow_other_filled` (m³/day on the filled
  days, missing elsewhere), and `summary.flowGapFill` lists per filled record
  `{ kind, spec, interpolatedDays, interpolatedGaps, donorDays, donorGaps,
  clampedDays, clampM3s, donor: { kind, ratio, overlapDays, correlation } |
  null, donorRefused, openGaps, openDays }` (days counted over the run, gaps
  and the donor's fit over the whole record); absent when no record is
  filled. `observed_flow` itself stays the measured record.
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
  pump uncapped), gaLimitM3 (the GN 538 volume for the property, context
  only: min(gaPropertyAreaHa × gaRateM3HaYear, 40 000) from engine 1.12.0,
  else, and on older runs, the 40 000 ceiling), gaBasis ('property' |
  'ceiling', engine ≥ 1.12.0), rolling12MaxM3 (the most pumped in any 12
  consecutive months ending in the year, null without 12 months of run behind
  it; engine ≥ 1.12.0), boreholes: [{ id (null = the combined capacity), name,
  abstractionM3, annualCapM3, capReached }] }`. The model document's nodes
  carry `gaPropertyAreaHa` (ha, ≥ 0, null = unknown) and `gaRateM3HaYear`
  (one of 0, 45, 75, 150, 275, 400, or null); anything else is a 400. It is the modelled groundwater abstraction per
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
  `days`, `flowsM3s`) and the Q90 `comparison`. From engine 1.19.0 also
  `recession` (absent on older runs; null without an observed record or
  rain; [model.md §2.10d](./model.md), *Recession diagnostics*):
  `{ flowKind, options, segments, observed, simulated, referenceFlowM3s,
  observedRate, simulatedRate, rateRatio, bDiff, agrees }`, `segments` as
  `[first, last]` run-day indices, each fit `{ a, b, points, segments,
  minQM3s, maxQM3s }` or null. The checks only report and
  warn; their warnings are in `summary.warnings`.
- Boreholes (engine ≥ 0.23.0): a farm or user with boreholes has
  `avgGroundwaterM3Day` and `avgBaseflowDepletionM3Day` on its summary, the
  run series `groundwater_used`, `baseflow_depletion`, `depletion_deficit`
  (engine ≥ 1.10.0, the depletion still owed to the river; `depletion_unmet`
  before it) and `depletion_store` (m³), and `summary.waterBalance` rows gain
  `groundwaterM3` and `streamDepletionM3`. `summary.verification.checks` has
  a `groundwater` check on every run (it passes trivially without boreholes).
- Demand objects (engine ≥ 1.7.0, [model.md §2.7f](./model.md)): a unit with
  an enabled object has, per object, the run series `object_demand@<id>` and
  `object_supplied@<id>` (m³/day) and `FarmSummary.demandObjects` (`{ id,
  name, category, priority, destination, avgDemandM3Day, avgSuppliedM3Day,
  avgDeficitM3Day, fractionSupplied, avgReturnedM3Day, daysShort, daysOff? }[]`,
  in id order; `daysOff`, engine ≥ 1.17.0, only on an object with a schedule:
  the days it switched the object off, never counted in `daysShort`). Its `demand`, `supplied`, `deficit` and `return_flow` are the crops'
  and the objects' together.
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
  These stay ≤ 0 in the API; the UI and the CSV exports show them (and the
  farm row's charge and its two parts, and other users' charges) as positive
  volumes charged (issue #45, [model.md §2.11](./model.md)).
  `FarmSummary.avgEwrShortfallM3Day` / `daysEwrNotMet` and the farm grids of
  `ewrCompliance` also come from the charge (positive mean; days charged).
  Before 0.17.0 all of these came from the Element sheet's incremental
  shortfall AB, which stays as the diagnostic series
  `ewr_shortfall_incremental` ("reach shortfall"). New run series: per farm
  `ewr_charge` and `ewr_charge_irrigation`; per site `ewr_charged` and
  `ewr_natural` (catchment scope for the outlet, the gauge's node for a
  gauge), all ≤ 0. Engine ≥ 1.5.0 adds, per farm upstream of two or more EWR
  sites, `ewr_binding_site`: the site that set the day's charge, as its index
  in `summary.curtailment.ewrSites` order (0 = the outlet, then gauges by node
  id), `null` on a day without a charge. Engine ≥ 1.6.0 adds, per transfer
  rule that can move water (enabled, between two farms, some month ticked,
  a daily limit above 0), `transfer_rule@<rule id>` on the rule's source
  farm: what that rule moved each day (m³/day, ≥ 0; the farms' `transfer`
  series are their nets of these). The per-run attribution self-check and
  the reporting-window recompute read it ([model.md §2.7b](./model.md)).

- `summary.runoff` (engine ≥ 0.5.0, GR4J runs only) is the runoff model's water
  balance in mm over the catchment: `{ model, params, warmupDays, areaKm2,
  rainMm, petMm, aetMm, flowMm, exchangeMm, storageStartMm, storesStartMm,
  storageEndMm }`, with rain − aet − flow + exchange = storageEnd − storageStart.
  `storesStartMm` (engine ≥ 1.20.0; absent before) is each store after the
  warm-up, `{ production_store, routing_store, uh_store }`, summing to
  `storageStartMm`. GR4J runs also
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
  its `sourceKind` (engine ≥ 1.5.0, only when the table states one),
  `naturalMar` (engine ≥ 1.11.0, only when the table records a natural MAR
  and the run has every calendar month: `{ runMcm, tableMcm,
  differencePct }`),
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
  required, met, rate }`). From engine 1.3.0 (issue #64), with
  `settings.lowFlowMeasure: 'baseflow'` and a low-flow requirement, each
  month adds `baseflow` (the month's base flow, table unit; from engine
  1.6.0 filtered over the month and the 730 days before it only, so later
  days never change it) and the site
  `lowFlowMeasure: 'baseflow'`. Each site also has the daily series
  `ewr_rule` (m³/day; NaN outside complete months); with
  `settings.ewrChargeSource: 'ruleTable'` a site the charge followed its table
  at has `ewr_charge_shortfall` too (m³/day, ≤ 0), and its
  `curtailment.ewrSites` entry and water-account `ewr` rows carry
  `ewrSource: 'ruleTable'`. Rules:
  [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6).
- `summary.dataQuality` (engine ≥ 0.3.1) holds the input checks:
  `observedAgreement` (gauge vs logger per water year, with the thresholds
  used), `seriesChecks` (`{ seriesKind, check: 'negative' | 'outlier' |
  'flatline' | 'zerorun' | 'lowvschirps' | 'doublemass', days, examples: [{ date, value,
  runDays?, endDate? }], text }[]`; `zerorun` and `lowvschirps`, engine ≥ 0.5.2, are the
  catchment-rain checks of issue #2, under the project's `settings.dataQuality`
  limits (engine ≥ 1.20.0; with `zeroRunChirpsCheck` a `zerorun` check can
  have `days: 0` and no examples when CHIRPS reads every long zero run as
  dry, so it only lists them); `doublemass`, engine ≥ 0.18.0, lists
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
  with `id` one of `balance`, `workings`, `soilWater` (engine ≥ 0.14.0), `runoff`, `transfers`, `reports`,
  `ewrAttribution` (engine ≥ 0.17.0), `groundwater`, `landCover`, `allocations` and `assurance` (engine ≥ 1.32.0:
  the assurance of supply and stress grids against each farm's and user's own daily demand and supply, issue #192), and
  `detail` the first broken property (farm names and dates) or `null`.
- `summary.waterBalance` (engine ≥ 0.12.0) is `{ areaKm2, years: WaterBalanceRow[], total: WaterBalanceRow }`,
  one row per water year (Oct–Sep, `waterYear` = its start year) and one for
  the run (`waterYear: null`): `rainMm`, `naturalFlowMm`, `runoffCoefficient`,
  `runoff` (GR4J store balance: `aetMm`, `exchangeMm`, `storageChangeMm`,
  `residualMm`; `null` on a stored legacy run), and in m³ `naturalFlowM3`, `farmRunoffM3`,
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
  forecastDays, noneDays, intensity?, quantileMap? }] }`. From engine
  1.21.0 (issue #66) `intensity` is the daily-intensity check: `{
  heavyDayMm (20), band (0.05), wetDayMm, reference: { share, totalMm,
  heavyDays, days, wetDays, era: { fromWaterYear, toWaterYear } | null (null
  = the whole trusted primary record), window }, scaled: { share, totalMm,
  heavyDays, days, wetDays }, mapped: { … } | null, differs: boolean | null }`
  (`share` 0–1 of the rain on days ≥ `heavyDayMm`, over the whole period);
  `quantileMap` is `null` without one, else `{ era, window, wetDayMm,
  minWetDays (30), months: [{ month, basis: 'month' | 'season' | null,
  referenceWetDays, periodWetDays }] (Jan … Dec), mappedDays }`. Both absent
  on older runs. The catchment series `rain_source` (only
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
| DELETE | `/projects/:id/scenarios/:sid` | – | `204`; its runs stay, with `scenarioId: null` (their snapshot keeps the ops), and its base run stops being cited. `409` for a `submitted` or `decided` scenario, and for one with a signed-off run (the signed run keeps its scenario; 072) | editor |
| POST | `/projects/:id/scenarios/:sid/runs` | `{ label? }` (default: the scenario's name) | `201 { run, removedRunIds, applied, classified }`, as `POST …/runs`: `run` is `RunMeta & { summary }` with `scenarioId`. `422 { error: "an op of this scenario doesn't apply to its base run", details: { problems: string[] } }` when any op doesn't apply (a result with an op silently skipped would not be the scenario); `409` when the base can't be rebuilt; `409 this scenario changed while it ran (its ops or base run); run it again` when its ops, base run or owned nodes changed while the engine ran, and `404` when it was deleted (nothing is stored in either case; a rename doesn't count); `400 model run failed: …` as for any run | editor |
| POST | `/projects/:id/scenarios/:sid/rebase` | `{ baseRunId, dryRun? }` | `200 { scenario, applied, problems, classified }`: the ops re-applied to the other base; `problems` lists each op that no longer applies (`op 2 (node.set): node … not found`), or once for an edit group of `node.set` ops on one node that breaks a rule (`ops 2–4 (node.set, "Upper farm"): …`, [scenarios.md § Engine](./scenarios.md#engine-applyscenario)). Saves the new base (the ops are kept as they are, so a run is refused until they apply) unless `dryRun: true`. Same base checks as `POST`; `409` when the scenario isn't a draft (not for a dry run) | editor |

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
| POST | `/projects/:id/scenarios/:sid/decide` | `{ outcome: 'approved' \| 'approved_with_conditions' \| 'refused', note?: ≤ 4000 }` | `submitted → decided`, with `decidedAt`, `decidedBy`; final. `403` for the application's own owner; `409` unless submitted; `409` `run_unverified` while any of its runs doesn't verify (security.md § Run stamps). Every single-scenario answer (`GET`, `PATCH`, the status moves) carries `unverifiedRunIds`: an application's runs that don't verify, to an editor or owner (`null` for a team scenario or a lower role) | editor |
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

## Evidence report

The licensing evidence report of a run (issue #71, WP-2.15 Phase C "evidence
mode"; design [design/evidence-report.md](./design/evidence-report.md), layout
[ui.md § Evidence report](./ui.md#evidence-report)).

| Method | Path | Body | Returns | Role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/evidence-report` | – | `{ report: EvidenceReport }` (engine `packages/engine/src/evidence/types.ts`, version `evidence-3`: § 5 registered water use, `allocations` (evidence-2); each Reserve site's driest month, `river[].fdcDriestMonth`, and the other applications on the baseline, `cumulative` with its page-1 row `otherApplications` (evidence-3)) | viewer |

- **Which report.** An application run (a scenario run) is reported against
  the base run its snapshot recorded (`inputs.scenario.baseRunId`); any other
  run is reported alone (baseline evidence, `mode: 'baseline'`). `404` when
  the reader can't see the run or its base; contributors and farmers get `403`
  (the report names every farm; an applicant's view is Step 3 D2's).
- **Built by the engine** (`evidenceReport`), from what the backend reads in
  one read-only `withUser` transaction: both runs (summary, settings, model,
  series hashes, notes), the nomination history, the current and previous
  publications, every ensemble started on the baseline and every paired one on
  the application (a paired band's summary recomputed from both rows' stored
  members, so `reserve[].worse` is there for bands stored before it existed),
  the input diff (`diffInputs` with stored values, as compare), the revisions
  since the previous publication, up to 50 other scenario runs on the same
  baseline, the other applications on the baseline (below), and the engine's
  methodology, limitations and errata.
- **Other applications on the baseline** (`cumulative`, § 4 and page 1's
  *Other applications on this baseline, summed*): every other scenario that is
  submitted, or decided `approved` / `approved_with_conditions`, with its
  newest run of its current ops (`inputs.scenario.opsSha256` equal to the
  scenario's) on this baseline, the newest 50 (with more, `cumulative.truncated` and nothing is summed). Read under the reader's RLS, so a
  viewer's report lists no submitted application (editors read those) and
  nobody's lists a draft. Only `summary.catchment.ewrDaysNotMet` and the
  outlet's Reserve `overall` leave the database, not the runs. The engine
  lists each one's own change against the baseline and sums those of the same
  engine, period and runoff model (any other difference is the application's own ops): a sum of separate runs, not one combined
  run (WP-3.11).
- **Always answers.** A run that isn't evidence still gets `200` with
  `refused: true` and the failed checks (`checks[]`: nominated, legacy,
  forecast, base, engine, period, runoff model refuse; baseline assumptions,
  declared rule, cited ensemble and paired band block issue only; coverage is
  printed and blocks nothing). `issuable` is true when no issue-blocking check
  failed.
- **The cited ensemble** is the first complete unpaired ensemble on the
  baseline whose options match `settings.evidenceUncertaintyRule` (members,
  bounds, pan shift, thresholds); the paired band is the first complete paired
  row on the application against it. Every other start is in
  `uncertainty.ledger` with how it departs from the declared rule.

## Evidence packs

A licensing evidence report frozen as a hashed, versioned, signed pack
(roadmap WP-3.14, issue #71, migration 112; [evidence-pack.md](./evidence-pack.md)
covers the manifest, the hash, the short code and the lifecycle).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/packs` | `{ runId, supersedesId? }` (strict) | `201 { pack: Pack }`, a draft. `runId` names the report as for [Evidence report](#evidence-report): a scenario run (an application pack) or the nominated run (baseline evidence). `409` with `details.checks` (`{ id, label, detail, fix }[]`) when the report is refused or a check that blocks issue fails; `404` for a run or a `supersedesId` the caller can't see in this project; `409` when `supersedesId` isn't an issued pack, or is of another application (or of an application, for a baseline pack) | editor |
| GET | `/projects/:id/packs` | – | `{ packs: Pack[] }`, newest first, at most 200. No manifest | viewer |
| GET | `/projects/:id/packs/:packId` | – | `{ pack: Pack, manifest: PackManifest, manifestMatches, signoffs: Signoff[], issue }`. `manifestMatches`: the stored manifest still hashes to `manifestSha256`. `issue` (a draft, to an editor; else `null`): `{ issuable, signed, runsVerified }`, what stands between it and its issue as stored (the issue route checks the live report too) | viewer |
| DELETE | `/projects/:id/packs/:packId` | – | `204`. `409` for a pack past draft (withdraw it) and for a signed draft (withdraw it: a sign-off is kept) | editor |
| GET | `/projects/:id/packs/:packId/signoffs` | – | As the run's (below), with the pack statement: `{ statement: PackSignoffStatement, statementSha256, disclaimer, cannotSign, signoffs }`. `cannotSign` adds `only a draft pack is signed; this one is <status>` | viewer |
| POST | `/projects/:id/packs/:packId/signoffs` | as a run's sign-off | `201 { signoff }` (`runId: null`, `packId`). The same `400`s and `409`s as a run's, and `409` for a pack that isn't a draft | editor |
| POST | `/projects/:id/packs/:packId/issue` | none, or `{}` (strict) | `200 { pack }`, issued; a new version's predecessor becomes `superseded` in the same transaction. `409` when: it isn't a draft; another pack of the same application (or baseline evidence) is issued and this one doesn't supersede it (one issued at a time: draft a new version instead); the stored manifest no longer hashes to its hash; the frozen or the live report can't be issued (with `details.checks`); there is no sign-off of the current pack statement; the predecessor is no longer issued. `409` `run_unverified` when either run's server stamp no longer matches | editor |
| POST | `/projects/:id/packs/:packId/withdraw` | `{ reason }` (1–1 000) | `200 { pack }`, withdrawn, from draft, issued or superseded. `409` when already withdrawn | editor |
| GET | `/verify/:code` | – | **Public.** `{ pack: PackVerification }` for the short code (`xxxx-xxxx-xxxx`, any case, dashes optional) or full manifest hash of a pack that was issued. `404` alike for a malformed or unknown code, a draft, and a pack withdrawn before it was issued. `Cache-Control: no-store` | none |

- `Pack = { id, title, mode: 'application' | 'baseline', scenarioId,
  baselineRunId, scenarioRunId, version, supersedesId, supersededById,
  status: 'draft' | 'issued' | 'superseded' | 'withdrawn', manifestSha256,
  shortCode, verifyPath, reportVersion, engineVersion, pdfSha256, pdfPages,
  bundleSha256, createdAt, createdBy, issuedAt, issuedBy, statusReason,
  signoffs }`. `title` is the report's (the scenario's name, or the
  project's); `createdBy` and `issuedBy` are display names (null once the
  account is deleted); `verifyPath` is the web page's `/verify/<shortCode>`;
  `signoffs` is a count. The PDF and bundle fields stay `null` until they
  are built.
- `PackManifest` is the engine's `buildPackManifest` (`pack-1`): `{ version,
  pack: { id, version, supersedes: { id, manifestSha256 } | null }, project:
  { id, name }, engine: { version, build }, report: EvidenceReport }`.
  `manifestSha256` is the SHA-256 of `packManifestText(manifest)` (RFC 8785).
- `PackSignoffStatement` (`pack-signoff-1`, `packSignoffStatement`): the run
  statement's fields less `runId` and `engineVersion`, plus `packId`,
  `packVersion`, `manifestSha256`, `baseline: { runId, engineVersion }` and
  `application: { runId, engineVersion } | null`; eleven confirmations, the
  run statement's ten and `pack`; `errata` of either run's engine.
- `PackVerification = { status, version, issuedAt, catchment,
  engineVersion, reportVersion, manifestSha256, shortCode, pdfSha256,
  successorSha256, withdrawnReason, methodology: { version, sha256 },
  errata: { id, summary }[], signers: { fullName, registrationBody,
  registrationCategory, registrationField, registrationNo, signedAt }[] }`,
  and nothing else (`app_verify_pack`, security.md § Evidence packs).
- A pack cites both its runs (`citedBy` kind `pack`, name `version N`): they
  can't be deleted or trimmed, and the scenario can't be deleted. A project
  with a pack past draft can't be deleted (`409`, [Projects](#projects)).
- Each step is in the history: `pack.drafted`, `pack.deleted`,
  `pack.issued`, `pack.superseded`, `pack.withdrawn`, and `signoff.created`
  with `packId`.

## Sign-offs

A registered professional signs a run (roadmap WP-3.13, migration 036;
[data-model.md § Sign-offs](./data-model.md#sign-offs-036_signoffsql)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/signoffs` | – | `{ statement, statementSha256, disclaimer: { version, status }, cannotSign, signoffs: Signoff[] }` (oldest first). `cannotSign` is why the caller can't sign (`requires editor role`, or the legacy-run reason, or the forecast-run one, WP-2.12, or the unverified-run one, security.md § Run stamps), `null` when they can | viewer |
| POST | `/projects/:id/runs/:runId/signoffs` | `{ fullName, registrationBody: 'sacnasp' \| 'ecsa', registrationCategory, registrationField, registrationNo, scope, confirmed: string[], statementSha256 }` | `201 { signoff }`. `400` for a category or field that isn't one of the body's, and for a candidate, certificated or specified category, with the reason (a candidate works under a professional's supervision, so the supervising professional signs); `409` when `statementSha256` isn't the current statement's (it changed since it was shown: read it again); `400` when a confirmation id is missing from `confirmed`; `409` for a legacy run (a stored run from before engine 1.0.0, which removed that model; workbook comparison only, audit H1), or a forecast run (`409`, WP-2.12: a sign-off is judged on the record, and a forecast run's last days are modelled on forecast rain); `409` `run_unverified` for a run whose server stamp is missing or no longer matches its rows (a run written past the model run, or changed since; security.md § Run stamps) | editor |

- `statement` is the engine's `signoffStatement(run)`: `{ version, runId,
  engineVersion, scenario, confirmations: { id, text }[], limitations:
  Limitation[], errata: Erratum[], methodology: { version, sha256 }, notes:
  string[], disclaimerVersion }` (`errata`: the known bugs of the run's
  engine version, `docs/engine-errata.md`; `methodology`: the current
  methodology statement, `docs/methodology/`). `statementSha256` is
  the SHA-256 hex of its RFC 8785 text (`signoffStatementText`); a sign-off
  sends it back and the server recomputes it. The current version is
  `signoff-4` (issue #71: `signoff-3`, issue #47, plus the errata and the
  methodology citation), with ten confirmation ids, in order: `identity`,
  `competence`, `conflict`, `inputs`, `calibration`, `ewr`, `works`,
  `assurance`, `plausibility`, `limitations`; `confirmed` must hold every
  one. The signer's details are `fullName`, the registration as codes of
  the engine's lists (`liability/registration.ts`: `registrationBody`
  `sacnasp` or `ecsa`; `registrationCategory`, e.g. `pr_sci_nat`, `pr_eng`;
  `registrationField`, a SACNASP field of practice such as
  `water_resources` or an ECSA discipline such as `civil`),
  `registrationNo` (free text, 1–50) and `scope`. A warn-level choice (Pr
  Techni Eng, Pr Cert Eng, an unusual field) is the dialog's warning, not an
  error.
- New sign-offs are always made against the current statement. A stored
  sign-off keeps the `statementVersion` and `statementSha256` it recorded
  (earlier ones say `signoff-1` or `signoff-2`), and is listed beside newer
  ones unchanged.
- A sign-off of an evidence pack goes through [Evidence packs](#evidence-packs)
  (`…/packs/:packId/signoffs`), with the pack statement (`pack-signoff-1`).
- `Signoff = { id, runId, packId, fullName, registrationBody, registrationCategory,
  registrationField, registrationNo, scope, statementVersion,
  statementSha256, disclaimerVersion, signedAt, mine }`. On a `signoff-1` or
  `-2` sign-off `registrationBody` is the signer's free text and category
  and field are `null` (not recorded).
- There is no route to change or remove a sign-off, and RLS allows neither. A
  signed run is **cited** ([Runs](#runs)): it can't be deleted or trimmed.
  Each sign-off is in the project's history (`signoff.created`).

## Allocations

Registered and licensed water-use volumes per farm or water user, and a run's
modelled use against them (roadmap WP-3.10, migrations 038 and 103,
[allocations.md](./allocations.md)). The app compares; it never decides
whether a use is lawful.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/allocations` | – | `{ allocations: Allocation[], sources: AllocationSource[], nodes: { id, name }[], canSeeHolders }`: `nodes` are the farms and water users a row can be matched to; `canSeeHolders` is true for editors and owners | viewer |
| POST | `/projects/:id/allocations` | `AllocationInput` | `201 { allocation }`. `400` for a node that isn't a farm or water user of this project, dates out of order, a volume < 0; `409` past 5 000 allocations per project | editor |
| PATCH | `/projects/:id/allocations/:aid` | any `AllocationInput` fields (at least one) | `200 { allocation }`; only the fields sent change (issue #72: before, every field not sent went back to its default, the name and registration number included); `holder: ''` removes the name | editor |
| DELETE | `/projects/:id/allocations/:aid` | – | `204` | editor |
| POST | `/projects/:id/allocations/import` | `{ kind: 'warms_extract' \| 'csv', fileName, text, reference? }` (`text` ≤ 2 MB) | `200 { fileName, kind, sha256, columns, ignoredColumns, rows: PreviewRow[], nodes, summary: { rows, valid, invalid, matched, unmatched } }`. **Writes nothing.** `422` for a file it can't take (with why: personal-information columns, no volume column, empty, too many rows, an unterminated quote); `409 this file was already imported (…)` for the same SHA-256 | editor |
| POST | `/projects/:id/allocations/import/commit` | the import body + `matches: { "<line>": nodeId \| null }` | `201 { source, imported, skipped, unmatched }`: the file is parsed again (no state is kept between preview and commit) and its valid rows stored with the file's name and hash; rows with problems are skipped. `400` for a match to a node that isn't a farm or water user; `422` when no row can be imported | editor |
| DELETE | `/projects/:id/allocations/sources/:sourceId` | – | `204`: the import and every allocation it brought | editor |
| GET | `/projects/:id/allocations/export.csv` | – | CSV in the template's columns (`months` as numbers separated by spaces, `conditions` separated by ` \| `) plus `source_file`, `source_sha256`; the `holder` column only for editors and owners; formula-looking cells prefixed with `'` | viewer |
| GET | `/projects/:id/runs/:runId/allocations` | `?tolerance=` (0 ≤ τ < 1; default the project's `settings.allocationTolerance`, 0.1 unless set) | `{ run: { id, label, startDate, endDate, forecastFrom, allocationMode }, comparison: AllocationComparison }`, `allocationMode` the mode the run ran with (`'none'` for a run before engine 1.18.0) (engine `compareAllocations`, [model.md §2.12](./model.md#212-allocations-modelled-use-vs-registered-volume-roadmap-wp-310)). A forecast run (`forecastFrom` set, WP-2.12) is compared on the days before `forecastFrom` only, like its other historical figures (issue #51) | viewer |

- `Allocation = { id, nodeId, nodeName, sourceId, registrationNo,
  propertyRef, holder, authorisation, purpose, waterSource, volumeM3PerYear,
  storageM3, validFrom, validTo, reference, months, maxRateM3s, conditions,
  createdAt, updatedAt }`. `months` (calendar months 1–12, ascending, or
  `null` for none stated), `maxRateM3s` (m³/s or `null`) and `conditions`
  (strings) are licence conditions (103, issue #72), recorded and shown, not
  yet applied by the engine. `holder`
  is `null` for a viewer (RLS hides `allocation_holder`), and when there is
  none. `sourceId` is `null` for a row typed into the app.
- `AllocationInput = { nodeId: uuid | null, registrationNo?, propertyRef?,
  holder?, authorisation: 'registration' | 'licence' | 'general_authorisation'
  | 'existing_lawful_use', purpose?: 'irrigation' | 'domestic' | 'livestock'
  | 'industry' | 'mining' | 'municipal' | 'other', waterSource: 'surface' |
  'groundwater', volumeM3PerYear, storageM3?, validFrom?, validTo?,
  reference?, months?: 1–12 each, 1–12 of them, no repeats (stored ascending)
  | null, maxRateM3s?: 0 ≤ r < 10⁶ | null, conditions?: up to 20 strings of
  1–500 characters }` (dates `YYYY-MM-DD`).
- Import: the template and a WARMS extract may carry `months` (numbers or
  names, ranges over the new year: `Oct-Mar`), `max_rate_m3s` and
  `conditions` (separated by `|`); a cell that doesn't read is a row problem.
- Every run's input carries the project's allocations (engine ≥ 1.18.0:
  `GET /projects/:id/model-input` and the stored run's `inputs.model.allocations`,
  without names, registration numbers or properties), and a write that changes
  what a run reads makes the latest run out of date (`project.updated_at`).
  `settings.allocationMode` (`'none'` | `'cap'` | `'fullAllocation'`) and
  `settings.allocationTolerance` (0 ≤ τ < 1) are project settings
  ([Projects](#projects)); `RunSummary.allocations` is the run's own
  comparison ([model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
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
| POST | `/projects/:id/publication` | `{ runId, note?, restriction?, nextExpectedOn? }` | `201 { publication, farms }`: supersedes the current publication; `farms` is how many farm projections were stored (every farm of the run that is still a farm of the project). `400` for a run not in this project; `409` for a legacy-runoff-model run (a stored run from before engine 1.0.0; a workbook comparison, not evidence) or a run too old to project (from before engine 0.17.0, which has no EWR charge series) | editor |
| PATCH | `/projects/:id/publication/:pubId` | `{ note?, restriction?, nextExpectedOn? }` (at least one) | `{ publication }`: the notice, the note or the next date change without re-publishing; stamps `updatedAt` / `updatedBy`. `409` for a superseded publication | editor |
| GET | `/projects/:id/runs/:runId/publication` | – | `RunPublication` (below): one run's place in the publications, for the printable report (issue #70). `404` for a run not in this project (or not a UUID) | viewer |

- `restriction = { level: 'none' | 'advisory' | 'restricted', pct?: 0–100 | null, notice?: { [code]: string } | null }`.
  A change replaces the whole notice. `pct` is stored to two decimals and is
  refused with `none`. `notice` is the WUA's words by language code
  (`{ "en": "…", "af": "…" }`): every key must be a language of the one
  language table (`packages/engine/src/languages.ts`; `400` naming an
  unknown code), each text is trimmed, at most 2 000 characters, no NUL,
  and a blank one is no notice in that language; `null`, `{}` or no
  `notice` is none (issue #58; 081_notice_languages.sql). The note is
  trimmed the same way. `nextExpectedOn` is a date
  (`YYYY-MM-DD`) or `null` (design E10). Without `restriction` a
  publication has none.
- `PublicationMeta = { id, runId, publishedAt, publishedBy, restriction: { level }, supersededAt }`;
  `publishedBy` is a display name (`null` once that account is gone).
- `Publication = PublicationMeta & { note?, restriction: { level, pct, notice }, nextExpectedOn, catchmentView, updatedAt, updatedBy }`,
  `notice` as above (`{}` for none), only the languages the WUA wrote.
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
- `RunPublication = { publication, previous }` (`publish/runPublication.ts`).
  `publication` is the run's newest publication, `{ id, publishedAt,
  publishedBy, supersededAt, restriction: { level, pct, notice } }`, or `null`
  when it was never published (or its publication aged out of the kept 12).
  `previous` is the publication to compare with: for a published run, the
  newest earlier publication of another run; for a run never published, the
  current one; `null` when there is none. It carries `{ id, runId,
  runLabel, publishedAt, publishedBy, changes, attribution }`, where
  `changes` and `attribution` are the input changes from that run to this
  one and who made them, as `GET /compare/runs` gives them. A farmer gets
  `403`, as for the run itself.
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
- `ShareView = { project: { name }, publication: { publishedAt, publishedBy, catchmentView, restriction: { level, pct, notice }, nextExpectedOn } }`.
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
  `mergeInto`): the series is created if it doesn't exist (only when the
  project has no outlet series of that kind: otherwise `409`, and a person
  adds the series first, since a run reads the first of each kind by name
  and a key must not be able to replace it; issue #51), only the days sent
  are touched (a `null` clears a day here, where the UI's merge keeps the
  stored value), units are converted to the kind's
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
- `rerunHeld` (WP-2.16): `{ negative, outlier, examples: { date, value }[], limitFrom, newSeries }`
  when days this push carried look wrong by the engine's data-quality rules
  (a negative rain or flow, or a value above the outlier limit), or when the
  push created the series (`newSeries: true`, held whatever its days: it is
  now what runs read for its kind), else `null`. The limit needs 100 non-zero days and comes from the first of
  these that has them; `limitFrom` says which (`null`: none had, so only
  negatives were checked): `others`, the series without this push's days
  and without the days this key wrote before that nobody has written
  since; `accepted`, for a series this key fills, the values the project's
  latest run a person made read from it (beside the days `others` keeps);
  `own`, while no such run has read enough of it, the series without this
  push's days alone, which this key's earlier pushes shaped
  ([security.md § API keys](./security.md#api-keys)). The days are merged all the same, `series.held` is recorded as
  the key (with the counts, up to 5 examples and the `source` label), no
  re-run is queued (`rerunQueuedFor: null`), and every automatic re-run
  waits, doing nothing, until a person runs the model
  ([security.md § API keys](./security.md#api-keys)).
- **Errors.** `401 { error: "invalid or missing API key" }` (with
  `WWW-Authenticate: Bearer`) for a missing, malformed, unknown, wrong,
  revoked or expired key, one message for all; `403` for a series not in
  `allowedSeries`, or a scope the key lacks; `409` for a new series of a
  kind the project already has (and the version and day-boundary guards); `429` with `Retry-After`
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
| GET | `/projects/:id/farm` | `FarmIndex = { project: { id, name, wuaName }, farms: { nodeId, name }[], publication: { publishedAt, restriction: { level } } \| null }`: a farmer's linked farms, every farm for viewer and above; `wuaName` is the project's (`null` = unnamed) | farmer |
| GET | `/projects/:id/farm/:nodeId` | `FarmView = { project: { id, name, wuaName, timeZone }, today, farm: FarmProjection, context, publication, outlet30, stale, outlook }` (below) | farmer |
| GET | `/projects/:id/farm/:nodeId/export.csv?from=&to=` | The farm's own daily CSV from the published run: `date` + the farm allowlist (`demand`, `supplied`, `deficit`, `dam_storage`, `spill`, `transfer`), the export CSV's rules ([Export](#export)), shaped for a farmer (issue #124): the header is those keys (the farm view's download words them in the reader's language and, for a decimal-comma language such as Afrikaans, writes `;` between cells, [ui.md § Farmer view](./ui.md#farmer-view-farm)), every figure is rounded to whole m³, and the window is the last 365 days to `dataUntil` by default; `from` reaches further back (to the run's first day) and `to` ends it earlier (`400` outside the run, `413` past 5 MB) | farmer |
| GET | `/projects/:id/farm/:nodeId/series?key=&from=&to=` | `FarmSeries = { key, label, unit, startDate, values }`: one of the farm's own daily series from the published run, `key` one of the farm allowlist (`demand`, `supplied`, `deficit`, `dam_storage`, `spill`, `transfer`; any other `400`). The year to `dataUntil` by default (`from` = `to` − 364 days); `from` / `to` narrow it, clamped to the run's first day and to `dataUntil` (never into forecast days); `400` for a window outside the figures or over 3 653 days. `Cache-Control: no-store` | farmer |
| GET | `/projects/:id/farm/:nodeId/history` | `{ publications: FarmHistoryEntry[] }`: the farm in the WUA's last 12 publications (the current one and the ones it superseded), newest first. `FarmHistoryEntry = { publishedAt, current, dataUntil, season: { from, to, demandM3, suppliedM3, fraction, shortDays }, damPct, model: { headline, band }, restriction: { level, pct } }`: the farm's own figures from each stored projection, never the even share (a catchment ratio) or the notice text | farmer |
| GET | `/projects/:id/farm/:nodeId/access` | `{ people: { displayName, role, you }[] }`: "Who can see my hydrological unit", everyone who can read this farm's figures (its linked farmers, and every viewer-and-above member, direct or through the team, at their effective role), by name, **never an email** (`app_farm_access`, 022). `404` for anyone who can't open the farm | farmer |

- `farm` is the stored `FarmProjection` (season and last-30 totals, the dam,
  last season from the same run, the 12 months to `dataUntil`, the river's
  share with the E7 headline and its band). `farm.river.equitableFraction`
  and `aboveBelowShareM3Day` are `null` when the viewer has fewer than
  `FARMER_K − 1` = 4 other holders (`app_other_farm_holders`, design §10.3
  D2; for a viewer previewing the farm, counted as that farm's own farmer
  would count them, 104), and `cutBeyondShare` is `false` (it is measured against the even
  share, so it would bound it); the stored projection keeps them.
  `farm.forecast = { from, to, days, madeOn, minDamPct, minDamDate,
  deficitDays, suppliedFraction }` only when the published run is a forecast
  run (WP-2.12): that farm's forecast days from the run's `summary.forecast`,
  `madeOn` the day the run was made, in the project's time zone when it
  was published (publications before 059_local_day keep the UTC day they
  stored); nothing about any other farm. `stale` counts the farm's
  `dataUntil` to today in the project's time zone.
- `context = { farmsUpstream, farmsDownstream, farmCount }` from
  `app_farm_context`: counts only.
- `publication = { publishedAt, publishedBy, engineVersion, restriction: { level, pct, notice }, nextExpectedOn }`.
  `publishedBy` is the publisher's display name, `null` once that account
  is gone (the page words it, "A former member", in the reader's language).
  The WUA's notice in every language it wrote it in, by code (`{}` for
  none); the page shows the reader's language, else English, else another,
  with a "not translated" line (`pickNotice`, design §7), so a language
  switch needs no request.
- `outlet30 = { name, daysNotMet, days }`: the outlet over the 30 days to
  `dataUntil`, counts only.
- `stale` is `dataUntil` older than 7 days (the workspace's `STALE_DAYS`)
  when the response was built.
- `today` is the date in the project's time zone (`project.timeZone`, 058)
  when the response was built. The page counts ages (the dates line, a
  forecast's age) to today in `project.timeZone` from the device's clock
  (`farmToday`, `farm/numbers.ts`), so a saved copy or a tab left open moves
  on with the day and a phone set to another zone counts the server's days;
  `today` is its fallback when the browser doesn't know the zone.
- `outlook`: the seasonal outlook the WUA published, this farm's own
  figures only (issue #53 R5, E3; [§ Seasonal outlooks](#seasonal-outlooks)):
  `{ decisionDate, seasonEnd, reviewDate, level: { id, label }, nYears,
  demandYears, demandMet, dam: { capacityM3, seasonEndShare } | null,
  publishedAt }`, the shares as `{ p10, p50, p90 }` fractions or null.
  `null` with none published, once withdrawn, or once its season has ended
  where the catchment is.
- `project.wuaName` is the WUA's name for the contact lines (`null` =
  "your WUA"); `farm.dataFrom` is the published run's first day, which
  "compared with last season" names when `lastSeason` is `null` (a
  projection stored before it existed gets it from the publication's
  `catchment_view.runStart`).
- `series` and `history` check the farm before the query, so any other
  node answers `404` whatever the query. The farm page itself renders from
  the projection (the 12 months, last season); these two are for a longer
  or custom chart and for comparing publications (roadmap WP-2.6).

## Jobs

Background work (the job queue, [architecture.md § Background work](./architecture.md#background-work)).
A job runs later, in the worker, as the editor who queued it.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/jobs?status=&limit=` | – | `{ jobs: JobMeta[] }`, newest first. `status` ∈ `queued`, `running`, `done`, `failed`, `dead` (`400` otherwise); `limit` 1–200, default 50 | viewer |
| POST | `/projects/:id/jobs` | `{ kind: "rerun", label? }` | `202 { job: JobMeta, created: true }`: a model run is queued, due now. If one is already pending (queued, or failed and waiting to retry; an automatic re-run included, which may be due later) the answer is `200 { job, created: false }` with that job, and nothing new is queued. `label` as for `POST /runs` (trimmed, ≤ 200). Only `rerun` is accepted (`400`), and no other field (a client can't queue an automatic re-run) | editor |

- `JobMeta = { id, kind, status, attempts, maxAttempts, runAfter, createdAt, startedAt, finishedAt, error, createdBy, progress }`.
  Never the payload, and nothing about the worker's lease. `progress`
  (040_yield) is 0–100 while a job that reports it runs (a `yield` or `sweep` job),
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
  ([§ Yield](#yield)), and `sweep` jobs, queued through `POST /sweeps`
  ([§ Sweeps](#sweeps)).

## Yield

A dam's historical firm yield, its yield at an assurance level, or its
storage–yield curve (roadmap WP-3.6, [model.md §2.13](./model.md#213-firm-yield-and-storageyield-engine--0340-roadmap-wp-36)),
worked out by a background `yield` job on a saved run's stored inputs or on a
scenario (its ops on its base run's inputs), never the live model.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/yield` | `{ nodeId, runId \| scenarioId, kind, params? }` | `202 { jobId, job: JobMeta, created: true }`. The same request while one is pending (queued, or failed and waiting to retry) is `200 { jobId, job, created: false }` with that job. A contributor (an applicant) only with `scenarioId` of an application they own and `nodeId` their own farm or a dam its `node.add` ops add (`403` for a run or an application that isn't theirs; a dam hidden from them is the `400` an unknown node gets). `409` for a forecast run (issue #51: a yield is judged on history; the Network tab offers only ordinary runs), and for a scenario whose base is one | editor, or a contributor on their own application |
| GET | `/projects/:id/yield?runId=\|scenarioId=&nodeId=&jobId=` | – | `{ results: YieldResult[] }`, newest first, at most 50: one of `runId` / `scenarioId` (or `jobId` alone), optionally one node. A contributor reads only the results they computed | contributor (RLS: their own) |
| GET | `/projects/:id/yield/jobs?nodeId=&runId=\|scenarioId=` | – | `{ jobs: YieldJob[] }`: this dam's pending yield jobs (queued, running, or failed and waiting to retry), whoever queued them, newest first, at most 20; `nodeId` required, at most one of `runId` / `scenarioId` (`400` for both). A done or dead job drops off: read its result with `GET /yield?jobId=`. A contributor sees only their own jobs | contributor (RLS: their own) |
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
- `YieldJob = JobMeta & { target: { nodeId, runId, scenarioId, kind, params } }`:
  what the job is for, read from its payload under RLS (a job of a project
  the caller can view; no column mirrors it, and `GET /jobs` stays
  payload-free). The Yield panel uses it to follow a job it didn't queue
  (another tab, a reload, a colleague). Follow the job's status on
  `GET /jobs`.
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

## Sweeps

A scenario sweep (issue #53 R2, [scenarios.md § Sweeps](./scenarios.md#sweeps)):
one saved base run × a list of named members, each an op set (typically
`demand.scale` at 1.0, 0.85 and 0.7), run by one background `sweep` job on
the base run's stored inputs, never the live model. Each member stores its
run summary (the `RunSummary` a run stores) and its catchment-level
outcome series, or the problems that kept it from running.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/sweeps` | `{ name, baseRunId, members: [{ name, ops }] }` | `202 { sweep: Sweep, jobId, job: JobMeta }`: the sweep is written `pending` with its members and its job queued | editor |
| GET | `/projects/:id/sweeps?baseRunId=` | – | `{ sweeps: Sweep[] }`, newest first, optionally of one base run; members **without** `summary` | viewer |
| GET | `/projects/:id/sweeps/:sweepId?series=true` | – | `{ sweep: Sweep }`, each member with its `summary`, and with `series=true` its `series` too (`400` for another value). `404` for a sweep that isn't this project's | viewer |

- Body (strict): `name` 1–200 characters (trimmed); `baseRunId` a saved run
  of this project; `members` **1–12** (`SWEEP_MEMBERS_MAX`), each `{ name,
  ops }` with a `name` of 1–100 characters, unique within the sweep
  whatever the case, and `ops` checked as a scenario's are
  ([§ Scenarios](#scenarios): the engine's op validation, ids as UUIDs,
  at most 500 ops). `ops: []` is the base run as it is.
- Checked before anything is queued: the base run is this project's and
  visible (`404 base run not found`), not a scenario run or a forecast run,
  and rebuildable from its stored inputs (`409`, as for a scenario's base).
  Whether each member's ops *apply* to the base is the job's to find out,
  member by member.
- **At most 2 sweep jobs queued or running per user** (`429`). A job gets 2
  attempts. A project keeps its newest **20** sweeps: creating one deletes
  older ones. A sweep goes with its base run (deleting the run, or the
  20-run cap trimming it, deletes its sweeps).
- `Sweep = { id, name, baseRunId, baseRun: { id, label, createdAt }, status,
  engineVersion, job, createdBy, createdAt, completedAt, members:
  SweepMember[] }`. `status` is `pending` until the job has given every
  member an outcome, then `complete` (with `engineVersion` and
  `completedAt`). `job` is `{ id, status, error, progress }` of the job
  computing it (`JobMeta`'s fields, [§ Jobs](#jobs)), or `null` once the
  30-day purge removed it: a sweep that stays `pending` behind a `dead` job
  says why in `job.error` (e.g. the base run can no longer be rebuilt, or
  the user who asked lost the editor role).
- `SweepMember = { id, position, name, ops, opsSha256, status, problems,
  startDate, endDate, finishedAt, summary?, series? }`. `status`: `pending`, `done`
  (`summary` is its `RunSummary`, `startDate`/`endDate` the run's), `problems`
  (its ops don't apply to the base run: `problems` lists one line per op,
  `op 1 (demand.scale): node … not found`, as a scenario's check does) or
  `failed` (the engine refused the input: `problems` is
  `["model run failed: …"]`). A member that can't run never fails the sweep.
- `series` (a `done` member, `?series=true`): the catchment-level daily
  `RunSeries` (`{ nodeId: null, key, label, unit, values }`) for the keys
  `natural_flow`, `simulated_outflow`, `ewr` and `ewr_shortfall`
  (`SWEEP_SERIES_KEYS`, what R4's outcome matrix and R5's outlook read), a
  missing value as `null`. Not every node's series: a sweep is not a run.
- Progress: the job reports 0–100 after each member (`job.progress`, and
  `GET /jobs`). A sweep can't be cancelled; it is at most 12 runs.

## Automated calibration

A server run of the project's saved calibration rules (issue #153,
[model.md §2.10j](./model.md)): the water years they leave out, every fit
they ask for (one background `auto_calibration` job each) and the fit kept by
its held-out score among those that pass the filters, or none. Applying the
kept fit is the server's too.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/auto-calibrations` | `{}` | `202 { calibration: AutoCalibration, jobId, job: JobMeta }`: planned from the saved settings, its first case's job queued | editor |
| GET | `/projects/:id/auto-calibrations` | – | `{ calibrations: AutoCalibration[] }`, newest first | viewer |
| GET | `/projects/:id/auto-calibrations/:cid` | – | `{ calibration: AutoCalibration }`; `404` for one that isn't this project's | viewer |
| POST | `/projects/:id/auto-calibrations/:cid/apply` | `{}` | `{ calibration, runId, uncertaintyId, runError }`: the kept fit saved, then a run with it and (`after.ensemble`) its ensemble queued | editor |

- Both bodies are strictly empty (anything else is a `400`): the saved rules
  decide everything, the search included.
- `POST …/auto-calibrations`: `400` when the rules can't run on the project
  (no observed record, a pan preset under a monthly PE row, selecting by
  the other record with only one, or a fit estimated past 4 minutes: "lower
  the model runs per fit or the starts"). **At most 1 queued or running per
  user** (`429`). A project keeps its newest **20** runs of the rules (an
  applied one is never deleted). Each case job gets 2 attempts.
- `AutoCalibration = { id, trigger ('manual' | 'new_data'), status
  ('running' | 'complete' | 'failed'), rulesRevision, rules, plan: {
  flowKind, validationRecord, years, ruleExclusions, notes, cases }, cases:
  AutoCalibrationCase[], report: { chosen, notes, eligible, reasons } |
  null, chosen, error, engineVersion, job, createdBy, createdAt, completedAt,
  appliedBy, appliedAt, appliedRunId, uncertaintyId }`. `cases` grows by one
  per job; `job` is the job fitting the next (`{ id, status, error, progress
  }`, or `null` once purged); a `failed` run says why in `error` (the
  project's data or settings changed between its cases).
  `AutoCalibrationCase = { label, pan, bounds, objective, score,
  naturalMarMm3, eligible, reasons, filters, error, params }`.
- `…/apply`: `409` when the run is still running or failed, nothing was
  kept, it was applied already, the rules have changed since (revision,
  content or sign-off), or the project's inputs no longer hash as they did
  when it ran. It writes the kept case's parameters (and a preset's pan
  coefficient) with a fit record the server builds (`fitRecord.auto`), as a
  settings revision, then runs the model (`runId`). A run that fails leaves
  the fit applied and says why in `runError`. With `after.ensemble` the
  ensemble around the fit is started on that run and computed by an
  `uncertainty` job (`uncertaintyId`, [§ Uncertainty bands](#uncertainty-bands)),
  or refused by that job when it would take more than 4 minutes.
- New data: with `settings.calibrationRules.after.onNewData` `report` or
  `apply`, new days of any series but the forecast queue a run of the rules
  (`trigger: 'new_data'`, one pending per project, debounced like the
  automatic re-run); with `apply` and signed-off rules, its job applies the
  kept fit and makes an `auto` run.

## Seasonal outlooks

The seasonal outlook (issue #53 R5, [model.md §2.15](./model.md#215-seasonal-outlook-an-esp-ensemble-from-a-decision-date-issue-53-r5-engine-core),
[ui.md § Seasonal outlook](./ui.md#seasonal-outlook)): an ESP ensemble from
a saved run's state on a decision date. One background `outlook` job runs
every demand level × every analogue water year of the record as one member
(the engine's `outlookMemberInput` → `runModelWithoutChecks` →
`outlookMember`), stores each member, then the engine's `summariseOutlook`
as the result. Not a [sweep](#sweeps): a sweep member is a whole-record
run; an outlook member is one level in one year, measured over the season.
The same job then draws the **review triggers** for the season's review
date (issue #53 R6, [model.md §2.15a](./model.md#215a-review-triggers-from-the-outlook-issue-53-r6)),
and an editor can **publish** one level to the project's farmers (R5, the
farmer view E3, migration 106).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/outlooks` | `{ name, baseRunId, levels: [{ label, ops }], decisionDate?, seasonEnd?, reviewDate?, planningShare?, analogueYears? }` | `202 { outlook: Outlook, jobId, job: JobMeta }`: written `pending`, its job queued | editor |
| GET | `/projects/:id/outlooks?baseRunId=` | – | `{ outlooks: Outlook[] }`, newest first, optionally of one base run, **without** `result` or `triggers` | viewer |
| GET | `/projects/:id/outlooks/:outlookId` | – | `{ outlook: Outlook }` with its `result` and `triggers` (null while pending). `404` for one that isn't this project's | viewer |
| POST | `/projects/:id/outlooks/:outlookId/publish` | `{ levelId }` | `201 { publication: OutlookPublication }`: that level published to farmers, ending the current publication. Audit `outlook.published` | editor |
| GET | `/projects/:id/outlook-publication` | – | `{ publication: OutlookPublication \| null }`: the current one | viewer |
| DELETE | `/projects/:id/outlook-publication` | – | `200 { publication }`, now ended (withdrawn); `404` when none is current. Audit `outlook.unpublished` | editor |

- Body (strict): `name` 1–200 characters; `baseRunId` a saved run of this
  project; `levels` **1–6** (`OUTLOOK_LEVELS_MAX`), each `{ label, ops }`
  with a `label` of 1–100 characters, unique whatever the case, and `ops`
  checked as a scenario's are ([§ Scenarios](#scenarios)) and **all
  `demand.scale`** (`400`: any other op would change the history the
  season starts from). `ops: []` is today's demand; R1's `months` form
  makes a monthly plan (one op per group of months). `decisionDate` and
  `seasonEnd` (ISO, both or neither, at most 366 days, the engine's
  `resolveSeason`, `400` with its message): absent, the project's
  `settings.outlook.season` from the base run's **newest state**: the latest
  decision date (that month and day) whose day before the run holds, and
  the season end the first of its month and day after it. `planningShare`
  (0, 1]: absent, the project's setting, else null (the engine's default,
  `shareIsDefault` in the result). `reviewDate` (ISO, after the decision
  date, on or before the season end; `400` when the body's own season
  shows it isn't, else `422`): absent, the project's
  `settings.outlook.review` (month and day, the first after the decision
  date; when a season given in the request doesn't hold it, that season's
  default; `422` when the project's own season doesn't), else the engine's
  `defaultReviewDate` (1 January for the default season, O3); `null`: no
  trigger table. A catchment with no farm dam gets none (the bands are dam
  storage): an explicit review date is then `422`, an absent one is null.
  `analogueYears` (1–200 distinct water
  years): absent, every one the record holds but the season's own.
- Checked before anything is queued: the base run as for a sweep (`404`,
  `409` for a scenario or forecast run), and the season: the decision date
  must fall after the run's first day and at most the day after its last
  (`422`, the state on the day before must be in the run), or the run must
  hold a decision date of the project's season (`422`). Whether each
  level's ops *apply* (the node ids exist) is the job's to find out.
- **Limits**: at most **2 outlook jobs queued or running per user**
  (`429`); a job gets 2 attempts; a project keeps its newest **20**
  outlooks; an outlook goes with its base run. At most **40 analogue years**
  (`OUTLOOK_YEARS_MAX`, the record's newest; older ones are listed in
  `excluded` as `overLimit`), so at most 240 members, each a full run (the
  history, then the season), in the job's one transaction: that has to fit
  the worker Lambda's 300 s. No cancel.
- `Outlook = { id, name, baseRunId, baseRun: { id, label, createdAt },
  decisionDate, seasonEnd, reviewDate, planningShare, levels: [{ id, label, ops }],
  analogueYears, status, engineVersion, job, createdBy, createdAt,
  completedAt, result?, triggers? }`. `levels[].id` is its place, `"0"` …; `status`
  `pending` until the job stores the result, then `complete`; `job` as a
  sweep's (a `pending` outlook behind a `dead` job says why in `job.error`).
- `result`: the engine's `SeasonalOutlook` (model.md §2.15): `decisionDate`,
  `seasonEnd`, `days`, `metric` (`reserveMonthsMet` or `daysBelowEwr`),
  `siteNodeId` (the outlet), `startStorageM3`, `capacityM3`, `analogues`,
  `nYears`, `enoughYears` (≥ `OUTLOOK_MIN_YEARS` = 10), `levels` (per level:
  `problems`, `nYears`, `meanDemandM3`, `seasonEndStorageM3`, `demandMet`,
  `userDemandMet`, `ewr` as `{ p10, p50, p90 }` or null, `yearsEwrMet`,
  `storageByDam`, `demandMetByFarm` (engine ≥ 1.19.0: each farm's own share
  of demand met, `{ nodeId, name, nYears, stat }`), and every year's values,
  each with its `farms` (node id → season demand and supply)), `planning` (`share`,
  `shareIsDefault`, `reason` `met` / `noLevelMeets` / `notEnoughYears` /
  `noLevels`, the level, `yearsMet`, `ranked`) and `warnings`; plus
  `excluded` (each `{ waterYear, reason }`: the engine's `outsideRecord`,
  `missingRain`, `theSeason`, `duplicate`, `notAYear`, or `overLimit`, or
  `memberFailed`) and `failures` (`{ levelId, label, waterYear, message }`
  for each member the engine refused). A level whose ops don't apply has
  `problems` and no years; a level refused in every year likewise; a year
  a running level was refused in is left out of every level (`memberFailed`)
  so the levels compare the same years. One member never fails the outlook.
- `triggers` (null without a review date): `{ reviewDate, table, problem,
  excluded, failures }`. `reviewDate` is the season's: the day the WUA reads
  its dams. The outlook's season usually starts after the base run ends
  (from its newest state), so the base run has no state on that day; the
  **table** is drawn on the latest day with the review date's month and
  day that the run's record holds (its `reviewDate`), to the season end's
  month and day after it, as a rule by storage band for that day of the
  year: the engine's `ReviewTriggers` (bands, per band the level picked or
  none, years met, every level's count and percentiles, `monotone`,
  `notes`, `warnings`) without each band's whole outlook. Every level that
  ran in the outlook runs in every band; a level refused in one year of a
  band isn't judged in that band (`failures`, with the band's lower edge).
  `table` is null, with `problem` in words, when the record holds no such
  day or the catchment has no farm dam. At most 3 bands (the terciles)
  × 6 levels × 40 years more members, in the same job.
- Progress: 0–100 after each member (`job.progress`), the table's members
  counted after the outlook's.
- **Publishing to farmers** (the client confirmed farmers see the outlook,
  O5, issue #90). `OutlookPublication = { id, outlookId, level: { id,
  label }, decisionDate, seasonEnd, reviewDate, engineVersion, publishedBy,
  publishedAt, endedAt, farms }`. Publishing stores, for every farm of the
  project, that farm's own figures at the level (the engine's
  `farmOutlookProjection`: the level, the season and review date, `nYears`,
  `demandYears`, `demandMet` and the dam's season-end share of capacity as
  `{ p10, p50, p90 }` or null), and the farm page reads them back
  ([§ Farm](#farm), `FarmView.outlook`) until the season ends
  where the catchment is (project time zone). One current per project; the
  newest 12 are kept. Refused: an outlook still running (`409`), a level it
  doesn't have (`422`) or that didn't run (`409`), one computed before
  per-farm figures (engine < 1.19.0: run it again, `409`), and a season
  already over (`409`). The app never picks the level: the editor publishes
  the one the WUA decided.

## Data feeds

Scheduled fetches of CHIRPS rainfall, the CHIRPS-GEFS forecast or a DWS
gauge, merged into one series each ([architecture.md § Data feeds](./architecture.md#data-feeds)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/feeds` | – | `{ feeds: FeedMeta[], sources, chirpsProducts, schedules, mode, canEdit, canRun }`. `sources`: `{ source, label, kinds, unit }[]` (what the form offers); `chirpsProducts`: `["sat", "rnl"]`; `mode`: `fixtures` or `live` (whether this server reads synthetic files); `canEdit` (owner), `canRun` (editor) | viewer |
| POST | `/projects/:id/feeds` | `FeedInput` | `201 { feed: FeedMeta }`. `409` if another feed already writes that series, or the project has 20 feeds, or the series holds another CHIRPS product or version (below) | owner |
| PATCH | `/projects/:id/feeds/:feedId` | any of `FeedInput`'s fields | `200 { feed }`. The fields sent replace the saved ones, and the whole is validated again (a new `source` needs its `config`). Saving makes you the feed's acting user; a new source, place or series clears its health. The version check below runs when the save changes the source, the product or the target; `replaceSeries: true` alone confirms replacing the current target | owner |
| DELETE | `/projects/:id/feeds/:feedId` | – | `204`. The series keeps its days | owner |
| POST | `/projects/:id/feeds/:feedId/run-now` | – | `202 { job: JobMeta, created: true }`: a `feed_fetch` is queued, due now, as you. One pending fetch per feed: while one waits, `200 { job, created: false }`, and a pending one waiting for later (a backfill's next window, a retry) is made due now. Rate-limited per feed (`RUN_NOW_RATE`, feeds/routes.ts): 6 presses that queue a fetch or pull a waiting one forward, then one more every 10 minutes; a press onto a fetch already due takes none. Past that, `429 { error, details: { retryAfter } }` with `Retry-After` (seconds), and nothing is queued or moved. `409` for a switched-off feed | editor |

- `FeedInput = { source, config, targetKind?, targetName?, schedule?, enabled?, replaceSeries? }`,
  strict (unknown fields are `400`):
  - `source` ∈ `chirps`, `chirps_gefs`, `dws`;
  - `config` for `chirps` / `chirps_gefs`: exactly one of `{ cells: { lat, lon, weight? }[] }`,
    1–25 cells, lat −60…60, lon −180…180, weight > 0 (default 1), or
    `{ bbox: { south, west, north, east } }` in degrees (south < north, west <
    east, no crossing of 180°, the same ranges), read as the area-weighted mean
    of every 0.05° cell the box overlaps and at most 100 cells in 25 rows
    (about 0.5° × 0.5°; a bigger box is `400`, the issue at `config.bbox`,
    architecture.md § Data feeds). A box may add `skipNoData: true`: its
    no-data (sea) cells are left out and the rest renormalised, and each fetch's
    `lastMeta` carries `cellsUsed`; a fetch with another count than the last
    one's is refused as failed until the box is saved again (with `cells` it
    is a `400`); for `dws`:
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
    first; `targetName` ≤ 100 (default `""`); `schedule` `daily` (the default and
    the only value: no source publishes more often, 111_feed_daily_only;
    `hourly` is a `400`); `enabled` (default true);
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
  deleted: save the feed again). `lastDataDate` is a calendar day of the
  source (`YYYY-MM-DD`: CHIRPS's are UTC days, DWS's South African ones),
  never shifted. `lastMeta` is what the source said about the last
  fetch (`days`, `prelimDays`, `issued`, DWS quality-code counts, CHIRPS's
  `product`), plus ours: `merged` (the days it wrote), `kept` (the days it
  left alone because the series held a value the feed didn't write: an
  upload or import, #30), `staged` / `replaced` (a confirmed replacement's
  days staged so far, or the label of what it replaced once swapped in),
  `through` (the last day the fetch asked for) and, for CHIRPS,
  `finalThrough` (the last day through which the series is final, not read
  again, #69). A CHIRPS `prelimDays` counts the preliminary days in the
  window, the ones the feed already held and didn't read again included.
- `health = { state, stale, staleAfterDays, reason }`, `state` ∈ `ok`,
  `stale`, `failing`, `pending`, `disabled`. `reason` says why, as a `code`
  and its facts; the client writes the sentence and formats the days (all
  `YYYY-MM-DD`), so no date is baked into server text. `newest`, `from` and
  `through` are the source's own days; `checked` and `since` are the days
  those instants fell on in the project's time zone, and "stale" counts to
  today there:
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
| POST | `/projects/:id/reports` | `{ runId?, against?, email? }` | `202 { jobId }`: a render of `runId` (the latest run without one) is queued. `against` (`"<projectId>:<runId>"`, the report route's and Compare runs' ref; needs `runId`) makes it the **impact report** of `runId` against that baseline, which may be another project's run but must be one **you can read** (`404 no such baseline run, or its project isn't shared with you` otherwise, as Compare runs; `400` malformed, or the run itself). `email`: `true` emails the link to you; a list of user ids emails it to those members (editors and owners only; `403` for a viewer naming anyone else). `404` a `runId` not in the project; `409` the project has no runs; `429` over 10 on-demand PDFs an hour per user and project | viewer |
| GET | `/projects/:id/reports/:jobId` | – | `{ report: ReportView }`. No download link: the PDF is fetched from the route below once `status` is `done`. `404` unknown job, or not a report's | viewer |
| GET | `/projects/:id/reports/:jobId/pdf` | – | `302` to a signed GET of the PDF that expires after **60 s**, minted on every request (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`), with `Content-Disposition: attachment` and the file name `<project>-report-<date>.pdf`. In production it is a CloudFront signed URL on the site's own origin (`/reports/<project>/<report>.pdf?response-content-disposition=…&Expires=…&Signature=…&Key-Pair-Id=…&Hash-Algorithm=SHA256`), so the download passes CloudFront and the WAF; locally (`REPORT_DOWNLOADS=presigned`) a pre-signed MinIO GET. CloudFront answers `403` to a link that is unsigned, altered or expired. A plain link works (the session cookie goes with it), so the app links here and this route is the only lasting handle on a PDF. `409` not rendered yet (or failed); `404` unknown job, not a report's, or finished more than 7 days ago (`the PDF has expired…`, the bucket's lifecycle has deleted it) | viewer |
| GET | `/projects/:id/report-schedules` | – | `{ schedules: ScheduleView[] }` | viewer |
| POST | `/projects/:id/report-schedules` | `ScheduleInput` | `201 { schedule: ScheduleView }`. `409` past 10 schedules per project | editor |
| PATCH | `/projects/:id/report-schedules/:scheduleId` | any of `ScheduleInput`'s fields | `200 { schedule }`. Saving makes you its acting user; changing its timing (or pausing / resuming it) starts it afresh from now | editor |
| DELETE | `/projects/:id/report-schedules/:scheduleId` | – | `204`. PDFs already sent stay until they expire | editor |

- `ReportView = { jobId, status, runId, impact, scheduled, pages, createdAt, finishedAt, error, emailed }`.
  `impact` says it is an impact report; the baseline itself isn't shown (other
  viewers of the project may not be able to see its project).
  `status` ∈ `queued` → `rendering` → `done`; `retrying` (the render failed
  and will be tried again; up to 3 attempts); `failed` (out of attempts, a
  failure no retry can fix, or, in production, no answer from the renderer
  within an hour). In production a retryable failure the renderer Lambda
  reports (a WAF block, a timeout) is asked for again after 2, then 4
  minutes, up to 3 renders, and the report shows `rendering` meanwhile. `error` is the server's own text, never raw database or
  browser output: e.g. `the render took longer than 90 s`, `the report page
  did not load: …` (the page's own message), `the run was deleted before its
  report was made`, `the baseline run was deleted, or its project isn't
  shared with you any more, before the impact report was made`, `the PDF
  could not be stored`; after a good render, `the
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
  `/auth/me`, `/projects/:id`, `/projects/:id/series`,
  `/projects/:id/runs/:runId` and its `/series`, `/day`, `/signoffs` and
  `/publication` (the report page's reads) of the one project and run, and for an impact report
  `GET /compare/runs?a=<baseline>&b=<project>:<run>` with exactly that pair
  (never the baseline's own project or run); everything else, the
  run's CSV exports, reproduction and allocation comparison included,
  answers `403 this session can only read one report`
  ([security.md § Render tokens](./security.md#render-tokens)).

## History

Change history and the audit log (WP-2.4, [data-model.md § Change history and audit log](./data-model.md#change-history-and-audit-log-030_historysql)).
Farmers get `403`.

| Method | Path | Body / query | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/history` | `?before=<next>&limit=1..100&nodeId=&kind=&q=` | `{ items, next, historySince }`, newest first: model revisions (`type: 'revision'`, with their change lines, not the snapshot) and audit events (`type: 'event'`). `kind` is `revision`, an event kind (`series.replaced`) or its noun (`series`); `q` is the parameter filter's words (≤ 200 characters, the first 10 words, any order, any case): only revisions with a change line holding every word, on every page; events aren't filtered by it (the client writes their sentences and filters them); `next` is an opaque cursor (`<ts>\|<type>\|<id>`) | viewer |
| GET | `/projects/:id/history/fields` | – | `{ fields: Record<key, { count, lastAt, lastBy, change, filter }> }`: per model input, how many saved changes changed it and the last one ([Field history](#field-history)) | viewer |
| GET | `/projects/:id/history/revisions/:revId` | – | `{ revision, preview }`: the revision with its `snapshot`, and what restoring it would change | viewer |
| POST | `/projects/:id/history/revisions/:revId/restore` | `{ reason? }` | `201 { revision, relink }`: the new revision, and the farmers to re-link to restored farms. `409` when nothing would change or the old model fails today's validation | editor |
| GET | `/projects/:id/runs/:runId/changes-since` | – | `{ changes, revisions }`: the net change of the inputs since the run (`diffInputs`, series by hash) and the model revisions made since it, newest first (≤ 100) | viewer |
| POST | `/projects/:id/runs/:runId/restore-inputs` | `{ reason? }` | `201 { revision, relink }`; `409` for a scenario run, or when nothing would change | editor |
| GET | `/projects/:id/series/:seriesId/revisions` | – | `{ revisions: { id, createdAt, createdBy, reason, startDate, length, …, siteNodeId }[] }` (kept: the newest 5, ≤ 180 days; `siteNodeId` = the flow record's gauge when the revision was kept, null = the outlet, 085) | viewer |
| POST | `/projects/:id/series/:seriesId/revisions/:revId/restore` | – | the series' `SeriesMeta` (works for a deleted series by its old id; a flow record comes back at the site it had, `409` when that gauge is no longer in the model) | editor |

`PUT /projects/:id/model` and `PATCH /projects/:id` (with `settings`) take an
optional `reason` (≤ 500 characters), kept with the revision.

### Field history

`GET /projects/:id/history/fields` (WP-2.4 UI) feeds the "Changed 3× · last by
Ann, 12 Aug 2026: 40% → 60%" line under a model input ([ui.md § Field
history](./ui.md#field-history)). One query over the project's revisions under
RLS (`backend/src/history/fields.ts`), no request per field. Keys:

- `settings:<path>`: a setting (`settings:lakeEvapFactor`, `settings:gr4j.x1`,
  `settings:calibration.rainThresholdMm`, `settings:dataQuality.agreementMinRatio`),
  from a settings line's subject (engine `settingsChangePaths`).
- `node:<nodeId>:<field>`: a node's field (`damCapacityM3`, `downstreamNodeId`,
  …), from the label after "Name: " on a changed node's line (engine
  `nodeChangeFields`).
- `crop:<nodeId>:<cropId>`: a unit's planted area of a crop, changed, added
  or removed (an area added with its new unit isn't counted).

Nodes and crops are found by name in each revision's own snapshot and keyed by
id, so a rename doesn't split a field's count. `count` is the saved changes
(restores included; the baseline, imports and copies not) that changed it;
`lastAt`, `lastBy` (null for a deleted account) and `change` ("150,000 m³ →
200,000 m³"; a planted area added or removed reads "0 ha → 5 ha" / "5 ha → 0
ha") describe the newest. `filter` is words for `GET /history?q=` that find
the field's lines ("Upper farm: dam capacity"). A field never changed since it
was set isn't listed.

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
  attribution: {                // who changed the inputs between the runs (issue #42); null unless both runs are of one
                                // project, A ran before B, and neither is a scenario run
    revisions: RevisionItem[],  // the model_revision rows after A ran, up to when B ran, newest first, no baseline (as GET /history's)
    truncated: boolean,         // more than 100: the oldest are left out
    changedBy: (string | null)[] // changedBy[i]: the id in `revisions` of the save that set changes[i]; null when none did
  } | null,
  catchmentSeries: { key, label, unit }[]  // catchment series present in both runs, same unit
}
```

- `attribution.changedBy` (`backend/src/history/attribute.ts`): a line is
  credited to the newest revision between the runs whose own change lines
  either are the same text, or describe the same subject and field and end
  on the same new value (A → B "600,000 → 750,000 m³" is set by the
  revision "650,000 → 750,000 m³"). Series lines are never credited: series
  changes are audit events, not model revisions. A line no revision's wording
  matches stays `null` rather than credited to a guess. The endpoint needs
  viewer on both projects (a farmer or contributor gets 403 for the whole
  request), the same floor as `GET /history`.

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
(ASCII slug; the date is the calendar day in the **project's time zone**,
`project.timeZone`, `Africa/Johannesburg` unless changed, so an export made
at 00:30 in South Africa carries that day and not UTC's day before, issue
#45; the .xlsx workbook takes its name from the summary CSV's, and the
server report PDF, `GET …/reports/:jobId`'s `url`, is dated the same way;
the account's `my-data_<date>.json`, which belongs to no project, is dated in
`Africa/Johannesburg`) and `Cache-Control: no-store`; CORS exposes
`Content-Disposition` so the SPA can read the name when it downloads with
`fetch`. `daily.csv` and `summary.csv` for a **legacy-runoff-model run** (a
stored run from before engine 1.0.0, audit H1) start with a leading comment line,
`# runoff_model=legacy; workbook comparison only; not evidence (audit H1)`,
ahead of the usual header row.

**Disclaimer line.** Every CSV of a run's results (`daily.csv`, `farms.csv`,
`summary.csv`; not the input series' `export.csv`, the allocations export or
the farm view's `…/farm/:nodeId/export.csv`, whose download on the farm view
gets the farm view's own translated disclaimer line added by the page) carries the report disclaimer's key point on a `#`
line (engine `CSV_DISCLAIMER_COMMENT`, quoted in
[legal/disclaimer-review.md § 1](./legal/disclaimer-review.md)), after a
legacy run's warning and before the provenance line:
`# model estimates that can be wrong; not an authorisation to use water; as far as the law allows the operator of this software accepts no responsibility to anyone who relies on this file; see the report disclaimer (version <disclaimer version>)`.
It holds no comma, quote or `=`, so a reader that doesn't skip comments sees
one text cell.

**Provenance line.** Every `daily.csv` and `farms.csv` (not the input
series' `export.csv`) starts with a `#` line saying which run made it, so the
file still says so once it is renamed or pasted into a workbook (operator
go-ahead 2026-09-27):
`# run=<label>; engine=<version>; runoff_model=<model>; created=<ISO time>; period=<start>..<end>`,
plus `; dam_capacity_m3=<m³>` on a farm's own `daily.csv` (the capacity in
the run's stored model, `0` for a farm without a dam, empty when the run
stored none). `period` is the run's, not a `from`/`to` window's. For a legacy
run both lines are there, the legacy warning first. Values are
percent-encoded (`%XX`, UTF-8; `decodeURIComponent` or Python's
`urllib.parse.unquote` reads them back): `%`, `;`, `=`, `,`, `"` and every
control character (tab, CR, LF, the Unicode line separators), so a run label
can never end the line, add a key or a CSV cell, and the whole line is one
cell starting with `#`, which no spreadsheet runs as a formula (split on `;`,
each part starts with a space and a key). The header row is therefore row 3,
after the disclaimer and provenance lines (row 4 on a legacy run): read the file with
`pandas.read_csv(path, comment='#')` (or `skiprows` the `#` lines); a plain
`pandas.read_csv(path)` takes the `#` line as the header.

| Path | Query | Body |
| --- | --- | --- |
| `/projects/:id/runs/:runId/export/daily.csv` | `nodeId?`, `from?`, `to?` | `date` + every daily series of that node (catchment when `nodeId` is omitted), one row per day. Catchment columns follow `CATCHMENT_ORDER` in `backend/src/export/run-tables.ts`: … rain used, final catchment rainfall, CHIRPS as uploaded, bias-corrected CHIRPS, the day's CHIRPS factor, … A farm's columns follow the FarmTemplate letters (`FARM_COLUMNS` in `packages/engine/src/verify/columns.ts`): gross demand, effective rain used, the soil-water store (mm, engine ≥ 0.14.0), F (crop requirement), D (abstraction demand, engine ≥ 0.16.0), G, H, I, the runoff removed by land cover (only a farm with land cover; I + it = natural flow × share), J, K … O, the dam's area, rain on it, evaporation and seepage (engine ≥ 0.16.0), P, Q, R, S, T, U, the balance check V, W, Y … AB (AB is the reach shortfall, a diagnostic from engine 0.17.0), then `ewr_charge` and `ewr_charge_irrigation` (engine ≥ 0.17.0), the letter in brackets in each header (`Irrigation supplied [G] (m³/day)`); a gauge's use the GaugeTemplate letters. Runs before engine 0.12.0 have no working columns (K–P, S, T, V, gross demand, effective rain). A **forecast run** (WP-2.12) leads with `forecast (F = modelled on forecast rain)` after `date`: `F` on each day from `summary.forecast.from`, empty before; and every run with rain has the `Rain source` column in its catchment file (`rain_source`: with rain-source periods from engine 0.30.0, in every run with rain from 1.27.0). So does `farms.csv`, and the `.xlsx` workbook's daily sheets lead with `forecast (1 = modelled on forecast rain)`, 1 or 0 |
| `/projects/:id/runs/:runId/export/farms.csv` | `key`, `from?`, `to?` | `date` + one column per farm of the run, in the run's farm order (upstream first, the order of `RunSummary.farms`), for one farm series `key` (any key of `FARM_COLUMNS`, the optional ones included, e.g. `landcover_reduction`; `400` otherwise). `key=runoff` is the workbook's `[Fragmented flow]` sheet (column I), `key=ewr` its `[Fragmented EWR]` sheet (column Y). Each header is the farm's current name, then the letter and unit (`Farm A [I] (m³/day)`); a farm deleted from the model since the run keeps its column under the name the run knew (a run keeps all its series, migration 024), and a farm without that series (a dam column on a farm with no dam) is left out. `404` when no farm has the series |
| `/projects/:id/runs/:runId/export/summary.csv` | – | Run details (the engine version, then `Runoff model` as the run's settings had it; ending with `Run notes`, the run's written explanation, empty when there is none, `Notes last changed` with the time and name when there is one, and the evidence nomination: `Evidence nomination` = `the nominated evidence run` / `nominated before, since replaced` / `not nominated`, then `Nominated,<time>,<name>,<reason>` and, for a replaced run, `Replaced by,<run label>,<time>,<name>,<reason>`), the self-checks (each check passed/FAILED with its first problem, and the largest daily balance check), per-farm summary table (first `Flow share (%)`, the farm's share of the natural flow and of the EWR as the run applied it, engine ≥ 0.27.0, empty on older runs; then the averages, `Dam capacity (m³)` from the run's own model so storage can be checked against it (and, only when some dam's capacity changes over the run, engine ≥ 1.30.0, issue #67, `Dam capacity on the last day (m³)`, what its end storage is within), and, engine ≥ 1.2.0, the dam's storage figures under labelled headers), catchment figures (the runoff coefficient labelled, and with an observed record the outlet EWR test on the observed record vs the simulated outflow, the whole record then each water year: counts, hit rate, false-alarm ratio, frequency bias), the water balance per water year and for the whole run (its equation row names only the terms the run has, each of them a column, storage set by a storage reset included), the curtailment table over the reporting window (every column unrounded, with a row naming the EWR attribution rule, engine ≥ 0.17.0: the EWR charge, its irrigation and storage parts, the supply cut and the EWR site setting it, then `demand_pct_note` — `no_demand`, `below_floor` for demand under 1 m³/day, or empty — and the EWR cut beyond the equitable share; the equitable share is labelled a fairness benchmark, `Above (−) / below (+) equitable share` instead of reduce/gain, and the table ends with the fixed footnote `EQUITABLE_SHARE_FOOTNOTE`, "… Not an allocation or licence condition.", audit Q11), the land-cover reductions (engine ≥ 0.24.0, only with land cover: the low-flow threshold, the mean and its share of natural flow, per class the condensed area, reduction and mm/yr), the other water users (engine ≥ 0.22.0, only when the run has any: whole-run means, then the reporting window's EWR charge, whether each is curtailed and its supply cut), the EWR sites (days not met, shortfall, charged to farms, natural; from issue #45 every EWR charge, charge part, other user's charge and site shortfall is written as the positive volume charged, the column headers saying "m³/day charged" or "positive", the curtailment R header "workbook R × −1"), Reserve compliance by month (engine ≥ 0.21.0; `Not assessed: …` without a rule table; otherwise per site the table's source, coverage, unit, natural-percentile source, scale and % points, months met, deficit, longest run not met, mean shortfall, the FDC check, from engine 1.19.0 (CR-29) the days below the day's requirement with the % of time and of volume not met and the EWR as % of natural MAR (with the low flows' share when the table has a low-flow grid), a row per month of the year, from engine 1.19.0 a row per month of the year from daily data (days assessed, days not met, time not met %, required and shortfall m³, volume not met %) and a row per month × % point of the EWR, natural and simulated flow-duration curves, and a row per complete month with its natural flow, condition, requirement, simulated flow and deficit), the assurance of supply (engine ≥ 0.32.0; `Not computed: run made before engine 0.32.0 …` in each block on older runs: `Assurance of supply (reporting window)` with the window, the annual threshold and a row per farm and user, then the time-based and volumetric reliability by month; `Stress classes by month (supplied ÷ demand)` with the thresholds and, for all farms and users then each one, a row per water year of class and % per month; `Water account by water year (Oct–Sep)` with the in, out, storage, residual and memo columns per water year and the whole run, then the EWR required vs met per site), the 12 CHIRPS bias factors (month, factor, source, shared days) and what the fit left out, the catchment rain treated as missing, the rain-source periods (engine ≥ 0.30.0: one row per period with its reason, run days by source, the rain from the series, its factors' origin and fallback, then the factors Oct … Sep, then from engine 1.21.0 a `Daily intensity` row per period: the heavy-day threshold, the reference, the reference's, the series × factor's and (with a quantile map) the mapped heavy-day share as percentages, the band in points, whether they differ by more than it, and the quantile map in words or `none: the monthly factor alone`; `None: the catchment series throughout` without periods), the double-mass check against CHIRPS (engine ≥ 0.17.0: slope, segments, breaks, one row per water year), the plausibility checks (engine ≥ 0.25.0, `Run made before engine 0.25.0: …` on older runs: the dry season; natural vs observed + net abstraction per water year with the dams / land cover / use split, gap, tolerance and pass; EWR days not met for good-rain and fallback-rain years, the Reserve months met by the same split, one row per water year with its station days and fallback rain; the double-mass check of observed flow against rain with segments, breaks, the simulated slopes, the change beyond the model overall and by season and what it points to; the dry-season low-flow duration curves in m³/s at Q1 … Q99 with the Q90 comparison; the recession diagnostics (engine ≥ 1.19.0, `Run made before engine 1.19.0: …` on older runs: the record, segment count and settings, a, b, −dQ/dt ÷ Q at the reference flow, points and segments for the record and the simulated outflow, the rate ratio and b difference, and whether they agree, indicatively); then, engine ≥ 1.4.0, for each gauge with its own record an `At gauge <name>` line with its share of the natural flow and the naturalised and low-flow blocks again at that gauge; each part says `Not checked: …` when the run lacks what it needs), calibration (from engine 0.39.0 with `Parameters fitted on these days (fitted = in-sample scores)` = the `fitStatus`; every score under a label with its unit, never its raw key: the window, KGE with r, α and β, r², log-NSE and its ε in m³/s, volume error %, the record scored; then the calibration exclusions it applied, `From,To,Reason`, and the annual volumes on the observed days, water year, days, observed and simulated Mm³ and the difference %; from engine 1.19.0 the WR2012 statistics on monthly flows, CR-28: the complete water years, whether the bands are indicative, then MAR, mean of log10 annual flows, SD, log SD and seasonal index with observed, simulated, the difference %, the band and `yes`/`no`, or `Not computed: …` when no water year has all 12 months observed; never under the raw key `wr2012Fit`), the flow-duration percentiles (issue #45: the Runs tab's FDC table, from the same engine function, `views/fdc.ts` `fdcPercentileTable`: `Days ranked,Flow record,Q10 (m³/s),Q50 (m³/s),Q90 (m³/s),Q95 (m³/s),Days`, a `Whole run` row for natural flow, simulated outflow and the observed record, then, when the observed record misses some of the run's days, `Observed days only (n of N)` rows with natural and simulated ranked on only its days, the chart's default; unrounded; on a forecast run every row ranks only the days before the forecast, after a `The n forecast days are left out: every row ranks the N days before them` line, the first rows labelled `Whole run before the forecast`, issue #51; `No catchment flow series stored for this run` otherwise), a forecast run's forecast days (WP-2.12, only on a forecast run: first and last forecast day, days, last observed rain, forecast rain, outlet EWR days at risk, then per farm the lowest dam level expected (%), days short, demand, supplied and supplied % of demand; every other block covers the days before them), the WR2012 check (`Not checked: …` when the run's settings had no reference; otherwise the quaternary, source, reference period, scaling rule and factors, WR2012 MAR and scaled MAR, the simulated natural MAR and ratio over the overlapping years and the whole run, the 12 monthly means in water-year order with ratio and dry-season mark, the dry-season ratio, the pattern correlation, the flag with its basis, deviation and thresholds, and for a *query* or *not usable* flag whether the run has a written explanation), a column guide (each farm daily column's letter, series key and formula), warnings — blocks separated by a blank record. A run before engine 0.12.0 says it has no self-checks or water balance. Shares are **percentages** (0–100): `Flow share (%)` and `Demand supplied (%)` per farm and `Days EWR not met at the outflow gauge (%)`, where the JSON `RunSummary` has fractions (`flowShare`, `fractionSupplied`, `ewrFractionDaysNotMet`, 0–1) |
| `/projects/:id/series/:seriesId/export.csv` | `from?`, `to?` | `date` + the input series' values as stored (the file's first two columns, unchanged since before issue #66, so it uploads again as it is), then `Flags` (`missing`, `negative`, `outlier`, `flat-line`, `; `-separated, by the project's current data-quality limits: engine `seriesRowFlags`). A flow series adds its value in m³/day, and the outlet's gauge or logger record `Excluded from calibration (reason)` (the project's current `calibrationExclusions`). When a run read this series (`run_input_series.series_id`: the latest one the caller can see; never a scenario run, nor a run from before migration 056), the file leads with that run's `#` lines (the legacy warning, the disclaimer, the provenance line, `withRunComments`) and adds that run's columns, each header ending `[run <label, else its date>]`: for catchment rain, `Rain used` (`rain_final`), `Rain source` (catchment / alternative gauge / CHIRPS / reanalysis / forecast; `rain_source`, stored by every run with rain from engine 1.27.0, left out for older runs), `Rain above the <n> mm threshold` (the run's `calibration.rainThresholdMm`, engine `aboveRainThreshold`, what irrigation demand reads) and, when the run has them, the set-aside and accumulation columns; for CHIRPS, the day's bias factor and the corrected rain; for the outlet's gauge or logger record, the simulated outflow; for a gauge node's record, the flow simulated at that gauge. A series changed since that run adds `# series_changed_since_run=true; …` under the provenance: the run columns are what the run read. No run read it: no `#` lines and no run columns (`backend/src/export/series-columns.ts`) |
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
| Read this first | engine `DISCLAIMER` | The report disclaimer's five paragraphs (the Terms URL on the site's own address) and its version |
| Summary | summary CSV | Run details and notes, evidence, self-checks, farm summary, catchment, calibration, the flow-duration percentiles (Q10–Q95; a small flow in m³/s, l/s or Mm³ that three decimals would show as 0.000 gets the decimals for two significant figures, issue #45), WR2012, the column guide (the CSV's `#` lines first: a legacy run's `# runoff_model=legacy …`, then the disclaimer line) |
| Catchment, then one per node | bulk route | `date` + the daily CSV's columns and headers for the catchment, then each node with series in the run's network order (b023's element sheets); the daily CSV's `#` provenance line isn't repeated here, the Summary sheet names the run |
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

**Audit workbook (`.xlsx`, issue #68).** Also built in the browser, in the
same worker, for one farm of a run: `GET …/runs/:runId`, then the catchment's
and the farm's [bulk series](#bulk-run-series). The engine lays out the
columns and their formulas (`packages/engine/src/verify/audit.ts`
`farmAuditPlan`); `frontend/src/lib/spreadsheet/audit/` writes them. Sheets:

| Sheet | Content |
| --- | --- |
| Read this first | The disclaimer, as in the run workbook |
| About | The unit, run, engine and period; the largest difference over the run as a formula (`=MAX(Audit!…)`); how to read the file |
| Parameters | The farm's fixed inputs, one cell each: dam capacity, starting storage, dead storage, A_full, b, seepage (and the share returning, when not all), the two % to the dam, the diversion capacity, e, β |
| Audit | `date`; the inputs taken from the run as given, not recomputed (`From the run: …` headers): the catchment's rain (`rain_final`, blank on a gap), the open-water evaporation depth, gross demand, effective rain used, the demand factor, H, I, J and Z; then the formula columns F, D, K … O, the dam's area, rain on it, evaporation, seepage (and seepage lost), G, P, Q, R, S, T, U, V, W, AA, each on day one reading the storage parameter and after that the row above; last, each day's largest \|Audit − Model\| over the formula columns |
| Model | The same columns with the run's stored numbers |

Each formula keeps the engine's order of operations (it is parenthesised
from the same expression tree the engine evaluates), so a spreadsheet's result
equals the model's to float noise; the unit tests evaluate the formulas on
random networks against `runModel`. The file asks Excel to recompute on
open (`fullCalcOnLoad`); its cells also carry the values as computed when it
was written. The demand side (gross demand, the soil-water store's effective
rain) and what arrives from the rest of the network are inputs, not formulas.
A farm with a feature the formulas don't carry is refused, naming it (docs/ui.md).

**Number formats (decision D11).** Each numeric cell carries a display format
chosen from its column's unit (`lib/spreadsheet/export/formats.ts`): volumes
and flows in m³ or m³/day `#,##0.00`, Mm³ and m³/s `#,##0.000`, mm `#,##0.0`,
shares in % `0.0` (the exports write shares as 0–100, so not the `0.0%` code,
which multiplies by 100), ratios `0.000`, other columns General. The rounding
is visual only: the cell (and any formula over it) has the unrounded value.
The codes use Excel's `,` and `.` placeholders, which Excel and LibreOffice
draw with the **viewer's** locale separators ("1 234,56" in a South African
or French locale, "1,234.56" in a US one), so the workbook follows the
reader's locale rather than D10, the app's own thousands separator (a narrow
no-break space, issue #76). The CSVs stay unformatted and ungrouped
(machine-readable).

The parts are what SheetJS CE 0.20.3 wrote for this workbook, byte for
byte, written by the app's own `lib/spreadsheet/export/writer.ts` since
2026-09-26 (issue #9: SheetJS was 78 KB of the worker's 88 KB gzip). Each
daily sheet's rows are streamed into bytes (a whole multi-decade run as
cell objects needs several GB, past a browser tab). A unit test builds each test
workbook both ways, with the writer and with the SheetJS path it replaced,
and compares the files byte for byte. The zip container is written by
`lib/spreadsheet/export/zip.ts`: every part deflated with the platform's
`CompressionStream('deflate-raw')` (real zlib deflate), plain PKZIP headers
and central directory, no zip64. SheetJS's own browser deflate is
fixed-Huffman and made files ~2.5 times larger. For scale, a multi-decade,
multi-farm run builds in a few seconds (its file about 2.5 times larger with
SheetJS's zip); a unit test holds a synthetic 10-year, 3-farm run under 4.6 MB (it
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
  // a flow record at a gauge inside the network carries "siteNodeId": a gauge of this file's model (084; absent = the outlet)
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
full precision (≈ 12–13 bytes a value on average), so a 40-year record
(≈ 14 600 days) is ≈ 5.8 MB and gets the 413; download it in windows of about
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
  request up to ~17 years, three for ~40 years. Follow `next` until it is
  `null`. `offset` defaults to 0; `400` when it is negative, not an integer,
  or past the run's end, or when `nodeId` isn't a UUID.

## Health

`GET /health` → `{ ok: true }`.
