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
| POST | `/auth/register` | `{ email, password, displayName, acceptTerms, inviteToken?, locale? }` | `acceptTerms` is the version of the terms of use and privacy notice the form showed (the engine's `LEGAL_VERSION`, `packages/engine/src/legal.ts`); missing or any other version is `400 terms_not_accepted` (`params.version`: the current one) before anything else, and the accepted one is stored with the account (`app_user.terms_version` / `terms_accepted_at`, 087). `202 { confirm: true, email }`, **no** cookie: sends a confirmation email, and the account can sign in once it is confirmed (issue #57). The **same** `202` for an address that already has an account, which gets an email instead (a fresh confirmation link if never confirmed, else "you already have an account" with a password-reset link). Through a live invite for exactly this address: `201 { user }` + cookie, confirmed and joined; `409 account_exists` if that address already has an account. `429 signup_throttled` past the sign-up throttle. While sign-up is closed (`SIGNUP_OPEN`, production's default; security.md § Sign-up by invitation), anything but a live invite for exactly this address is `403 signup_closed`, after the throttle and before the address is looked at |
| POST | `/auth/login` | `{ email, password }` | `200 { user }` + cookie; for an account with two-step sign-in, `200 { mfaRequired: true, methods }` (`methods`: `"totp"` and/or `"email"`, the factors the account has, the app first) and **no** session, only the 5-minute `wm_mfa` challenge cookie (send a code to `POST /auth/mfa/verify`, § Two-step sign-in); `401` wrong email or password; `403 email_unconfirmed` right password, address never confirmed (no cookie); `429` + `Retry-After` while the address is locked. In production, past 20 sign-ins per IP in 5 minutes, AWS WAF (not the API) may answer `405` with `x-amzn-waf-action: captcha`; send it again with a solved CAPTCHA token in `x-aws-waf-token` (docs/security.md § Sign-in CAPTCHA) |
| POST | `/auth/logout` | – | `204`, clears cookie and revokes this session on the server (its `jti`, 102), so a copy of the cookie is refused too; the account's other sessions stay signed in. `204` without a session as well |
| POST | `/auth/logout-everywhere` | – | `204`, clears cookie and revokes **every** session of the account, on every device (signed in) |
| GET | `/auth/me` | – | `200 { user }` or `401` |
| POST | `/auth/me/accept-terms` | `{ version }` | The re-acceptance step ([legal-status.md](./legal-status.md)): `version` is the terms version the notice showed (`LEGAL_VERSION`). `200 { user }` with `termsCurrent: true`, recording it (`app_user.terms_version`; the database stamps the time, and accepting the version already recorded changes nothing). Any other version is `400 terms_not_accepted` (`params.version`: the current one) |
| GET | `/auth/me/export` | – | `200` a JSON file (`Content-Disposition: attachment; filename="my-data_<date>.json"`, `Cache-Control: no-store`): the signed-in person's data-subject export; `429` + `Retry-After` within a minute of the last one (signed in) |
| POST | `/auth/me/farm-notice` | `{ version }` | "I understand" on the farm view's "Before you look at your farm" notice: `version` is the one the page showed (the engine's `FARMER_NOTICE_VERSION`, `packages/engine/src/legal.ts`); any other is `409 farm_notice_changed` (`params.version`: the current one). Stored on the account with the database's time (`app_user.farm_notice_version` / `farm_notice_accepted_at`, 093). `200 { user }` (signed in) |
| DELETE | `/auth/me` | `{ password }` | "Delete my account" (issue #112): `204`, the account deleted and this browser's session and trusted-device cookies cleared, then an email to its address saying what was done; `403 wrong_current_password`; `429 signin_locked` + `Retry-After` while the address is locked; `409 account_sole_holder` with `details: { projects: [{ id, name }], teams: [{ id, name }] }`, the projects the person is the only owner of and the teams they are the only admin of (signed in) |
| PATCH | `/auth/me` | `{ displayName?, locale?, volumeUnit?, preferences? }` | `200 { user }`; `400` a blank (or only invisible characters) or over-100-character name, an unknown `locale` or `volumeUnit`, malformed `preferences`, or nothing to change (signed in) |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | `200 { user }` + a fresh cookie for this device; revokes **every other** session; `403` wrong current password; `429` + `Retry-After` while the address is locked; `400` new password not 8–200 characters (signed in) |
| POST | `/auth/forgot-password` | `{ email }` | **always** `202 { ok: true }` (public) |
| POST | `/auth/reset-password` | `{ token, password }` | `204`, clears cookie; `400` bad/expired/used link (public) |
| POST | `/auth/verify-email` | `{ token }` | `200 { verified: true, email }` (the address the link confirmed) + a trusted-device cookie for the address; `400` bad/expired/used link (public) |
| POST | `/auth/resend-confirmation` | `{ email }` | **always** `202 { ok: true }`, after the same time as `forgot-password`; mails a new confirmation link only to an unconfirmed account, under the cooldown and daily cap (public: the sign-in page's "Send the link again") |
| POST | `/auth/resend-verification` | – | `202 { sent: true }`; `409` already verified; `429` sent < 1 min ago, or the day's cap reached (signed in) |
| POST | `/auth/invite-info` | `{ token }` | `200 { invite: { email, projectName, teamName, invitedBy } }`; `404` bad/expired, or its sender no longer owns the project (administers the team, 155) (public) |
| POST | `/auth/render-session` | `{ token }` | `200 { ok: true }` + a **render session** cookie; `400` bad/expired/used token; `403` the requester can no longer see the project or the run (or, for a pack's token, the issued pack); both carry `code: "render_token_refused"` (§ Errors, machine-only codes) (public: the headless report renderer's sign-in, [§ Reports](#reports)) |

`user = { id, email, displayName, emailVerified }`. Passwords: 8–200 chars, all of it counted (Argon2id; a pre-2026-10 bcrypt hash is upgraded on the next sign-in, security.md § Authentication).

### Two-step sign-in

TOTP (RFC 6238) from an authenticator app, a code by email (206), or both,
with ten recovery codes (issue #282, [security.md § Two-step
sign-in](./security.md#two-step-sign-in)). A `code` is six digits from the
app or the newest emailed code (spaces and a dash forgiven) or, where it
says so, a recovery code (`ABCDE-FGH23`, case and the dash forgiven). An
emailed code works once, for 10 minutes, and a new send replaces it; a send
within a minute of the last, or past five in an hour, answers `429
mfa_email_wait` (`params.seconds`, `Retry-After`) and sends nothing, and one
the mail transport refused `503 mfa_email_failed`. A send answers `202 {
resendInSeconds: 60, expiresInSeconds: 600 }`. Every code check
counts on the account's code throttle first: the 5th wrong code in a row
answers `429 mfa_locked` (`params.seconds`, `Retry-After`) for a minute,
doubling to 15, right codes included. The session JWT carries `amr`:
`["pwd"]`, or `["pwd", "otp"]` once signed in with a code, and `otp_at`,
when the session last gave a code: a sign-off of a pack, issuing and
withdrawing a pack (and a run's sign-off where the project requires two-step
sign-in) answer `401 mfa_fresh_code` when it is more than 10 minutes old;
send a code to `POST /auth/mfa/step-up`, then the action again.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/auth/mfa` | – | `200 { enrolled, enrolledAt, methods, emailPending, recoveryCodesLeft, required, sessionVerified, pendingReset }`: `enrolled`, a factor is on (`methods`: `"totp"` and/or `"email"`, `enrolledAt` the first's); `emailPending`, codes by email wait for their first code; `required`, the person's roles need it: an owner of a project that requires it (its own setting or its team's), an admin of a team that does, a member acting for a responsible authority, or an assessor (false while `MFA_REQUIRED=false`); `sessionVerified`, this session signed in with a code; `pendingReset`, `{ effectiveAt }` while a confirmed reset of the factors waits (below), else `null` (signed in) |
| POST | `/auth/mfa/totp/enrol` | `{ password }` | `200 { secret, uri }` (`Cache-Control: no-store`): a new base32 secret and its `otpauth://totp/…` URI, unconfirmed until …/confirm; starting again replaces an unconfirmed one. `403 wrong_current_password` (through the sign-in lockout, `429 signin_locked`); `409 mfa_already_enrolled` (signed in) |
| POST | `/auth/mfa/totp/confirm` | `{ code }` | `200 { recoveryCodes }` (ten, shown only now; `null` when codes by email were already on, whose set stays) + this browser's session reissued with `amr: ["pwd", "otp"]`; `400 mfa_code_wrong`; `409 mfa_not_started` (signed in) |
| DELETE | `/auth/mfa/totp` | `{ code }` (app, emailed or recovery code) | `204`, the authenticator gone (and, if it was the last factor, the recovery codes and a waiting reset), **every other session signed out**, this browser's session (and trusted-device cookie) reissued, as `["pwd", "otp"]` while codes by email stay on, else `["pwd"]`. The right code ends a waiting reset, as any right code does. `400 mfa_code_wrong`; `409 mfa_not_enrolled` (signed in) |
| POST | `/auth/mfa/email/enrol` | `{ password }` | `202 { resendInSeconds, expiresInSeconds }`: codes by email pending, and a code to the account's address; again before confirming, a new code. `403 wrong_current_password` (through the sign-in lockout, `429 signin_locked`); `409 mfa_already_enrolled`; `429 mfa_email_wait` (the pending factor stays: send again later) (signed in) |
| POST | `/auth/mfa/email/confirm` | `{ code }` (the emailed one) | `200 { recoveryCodes }` (ten, or `null` when the app was already on) + this browser's session reissued with `amr: ["pwd", "otp"]`; `400 mfa_code_wrong`; `409 mfa_not_started` (signed in) |
| DELETE | `/auth/mfa/email` | `{ code }` (emailed, app or recovery code) | `204`, as `DELETE /auth/mfa/totp` for codes by email; `409 mfa_not_enrolled` (signed in) |
| POST | `/auth/mfa/email/send` | – | `202 { resendInSeconds, expiresInSeconds }`: a code by email, for confirming a pending factor or, once on, for step-up, turning a factor off and new recovery codes. `409 mfa_not_enrolled`; `429 mfa_email_wait`; `503 mfa_email_failed`; `403` on a render session (signed in) |
| POST | `/auth/mfa/challenge/email` | – + the `wm_mfa` cookie | `202 { resendInSeconds, expiresInSeconds }`: a code by email for `…/verify`; the challenge isn't used up. `401 mfa_challenge_expired`; `409 mfa_not_enrolled` (no codes by email on the account); `429 mfa_email_wait`; `503 mfa_email_failed` (public: the challenge is the credential) |
| POST | `/auth/mfa/recovery-codes` | `{ code }` (the app's or an emailed one) | `200 { recoveryCodes }`, a new set; the old ones stop working; a waiting reset of the factors ends; `400 mfa_code_wrong`; `409 mfa_not_enrolled` (signed in) |
| POST | `/auth/mfa/verify` | `{ code }` (app, emailed or recovery code) + the `wm_mfa` cookie | `200 { user, usedRecoveryCode? }` + the session (`amr: ["pwd", "otp"]`) and the trusted-device cookie; the challenge is used up. A waiting reset of the factors ends. `400 mfa_code_wrong`; `401 mfa_challenge_expired` no challenge, an expired or used one, or one from before a password reset (public: the challenge is the credential) |
| POST | `/auth/mfa/step-up` | `{ code }` (app, emailed or recovery code) | `200 { ok, usedRecoveryCode? }` + this browser's session reissued with `amr: ["pwd", "otp"]` and `otp_at` now: what a sign-off, issuing or withdrawing an evidence pack need within 10 minutes (their `401 mfa_fresh_code`; [security.md § Two-step sign-in](./security.md#two-step-sign-in) → A fresh code). `400 mfa_code_wrong`; `403 mfa_required` no factor. A waiting reset of the factors ends (signed in) |
| POST | `/auth/mfa/reset` | – + the `wm_mfa` cookie | Can't get a code **and** lost the recovery codes (205): `202 { sent: true }`, a confirmation link emailed to the account's address (1 h, single use); nothing changes until it is followed, and the challenge isn't used up. `200 { pending: true, effectiveAt }` when a confirmed reset already waits (nothing sent). `429 mfa_reset_limit` past 3 requests in 24 hours; `401 mfa_challenge_expired` without a live challenge (public: the challenge is the credential) |
| POST | `/auth/mfa/reset/confirm` | `{ token }` | `200 { effectiveAt }`: the **3-day wait** starts (now + 72 h); an email says when, with a cancel link. `400 link_invalid` for an unknown, used or expired link (public) |
| POST | `/auth/mfa/reset/cancel` | `{ token }` | `200 { cancelled: true }`: the waiting reset ends, nothing removed, and every cancel link of it stops working. `400 link_invalid` once it has ended (cancelled or completed) or for an unknown token (public) |

**Recovering a lost factor** (205_mfa_recovery, [security.md § Two-step
sign-in](./security.md#two-step-sign-in) → Recovery). During the wait the
factor keeps working; the start, a reminder every 24 hours and the end are
emailed, each with its own cancel link, valid until the reset ends. A
sign-in (`…/verify`), a step-up, new recovery codes or turning a factor off
cancels it: any right code, from the app, by email, or a recovery code.
When the wait is over, the job worker's tick removes every second factor of
the account (the authenticator, codes by email and the recovery codes),
moves the session watermark (every session signed out) and emails the
person. One reset waits at a time per account. A team admin can remove a
member's factors at once instead, for a member below admin: `POST
/teams/:id/members/:userId/mfa-reset` (§ Teams).

**Actions that need it** (opt-in since 2026-10-08; [security.md § Two-step
sign-in](./security.md#two-step-sign-in)). Where a project requires it
(`project.requireMfa`, or its team's `team.requireMfa`; `project.mfaRequired`
says which applies), its owners sign in with a code before any route that
needs the owner role (members, invites, API keys, data feeds, share links,
renaming a team project, deleting a project; removing someone else from the
project; an owner making or revoking any share link), and its editors before
signing a run (`POST …/runs/:runId/signoffs`). Where a team requires it, its
admins do before any route that needs team admin (and removing someone else
from the team), and on every team project as its owners. With both off (the
default) those need nothing more than the password. **Always**, whatever the
settings: publishing to farmers (`POST` / `PATCH …/publication`, `POST
…/outlooks/:outlookId/publish`, `DELETE …/outlook-publication`), recording
the authority's decision on an application (`POST …/scenarios/:sid/decide`),
endorsing a published baseline (`POST …/publication/:pubId/endorse`),
recording a signer's registration check (`POST
…/members/:userId/registration-checks`), and signing, issuing or withdrawing
an evidence pack (`POST …/packs/:packId/signoffs`, `…/issue`, `…/withdraw`).
Checked after the role, so an outsider still gets `404` and a viewer `403`
without a code: `403 mfa_required` (no authenticator yet: set one up) or
`403 mfa_step_up` (one is set up, but this session signed in with the
password only: sign in again).

**Email links.** Tokens are 32 random bytes (43 base64url chars), single-use,
stored only as SHA-256 hashes. Links point at `SITE_URL`:

| Email | Link | Lifetime |
| --- | --- | --- |
| Confirm your email | `/verify-email?token=…` | 48 h |
| Reset your password | `/reset-password?token=…` | 1 h |
| Remove two-step sign-in: confirm | `/mfa-reset?token=…` | 1 h |
| Remove two-step sign-in: cancel (in the start, each reminder) | `/mfa-reset/cancel?token=…` | until the reset ends |
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
  against the account's address before the password check, a wrong current
  password (`403`) is a failed attempt, and while the address is locked it
  answers `429` without checking. On success it sets the new password, moves
  `app_user.sessions_revoked_at` to now (every existing session, this
  device's old cookie included, gets `401` on its next request), deletes any
  outstanding reset link, clears the lockout count, and sets a fresh cookie
  so this device stays signed in. A body that fails validation (`400`) is
  refused before anything is counted.
- **`user`** is `{ id, email, displayName, emailVerified, locale, volumeUnit, mailSuppressed, preferences, termsCurrent, termsVersion, farmNoticeCurrent, renderSession? }`.
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
  sections: History and Applications), `[]` once they chose to show
  every one. Only ever their own.
  `termsVersion` is the version it accepted (`null`: none), from which the
  re-acceptance notice lists what changed since.
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
- **`DELETE /auth/me`** ("Delete my account", POPIA s24; issue #112;
  `backend/src/auth/deleteAccount.ts`, 143_delete_my_account.sql) checks
  the password through the **same lockout as `change-password`** (a wrong
  one is a failed attempt, `403`; a locked address `429`, logged as
  `login_failed` with `route: "/auth/me"`). Then, as the person under RLS:
  the projects they are the only owner of (`project_member`) and the teams
  they are the only admin of give `409 account_sole_holder`, naming them in
  `details`, and nothing changes; hand them over first. The owner and admin
  rows of those projects and teams are locked (`FOR UPDATE`) before the
  check, so a co-owner deleting their account or leaving at the same moment
  waits for this request rather than both passing. Otherwise it records
  one audit event in each project and team they belonged to
  (`member.removed` / `team_member.removed` with `self: true,
  accountDeleted: true`, and a farmer's `farmer.unlinked` with cause
  `member_removed`), deletes the account through
  `app_delete_my_account()` (the same foreign keys and triggers as the
  operator's deletion: keep the evidence, remove the name; [security.md §
  Personal information](./security.md#personal-information-popia)), and
  fires the deferred owner and admin checks inside the request (`SET
  CONSTRAINTS ALL IMMEDIATE`), so a co-owner who left just before still
  gets the `409`, not a deletion. The response clears both cookies;
  the old session cookie is void anyway (its account is gone). The email
  (`account_deleted`, in the account's language) lists the projects and
  teams the person left, what was deleted, what stays without the name and
  what keeps it (POPIA s24(4)); a failed send is logged and doesn't undo
  the deletion. The log line `{"event":"account_deleted","via":"self"}`
  names nobody.
- **`GET /auth/me/export`** ("download my data", POPIA access;
  `backend/src/auth/export.ts`, 054_subject_export.sql) returns one JSON
  document, `{ format: 'water-management.subject-export', version: 1,
  exportedAt, account, projectMemberships, teamMemberships, farms, notes,
  signoffs, invites, alertSubscriptions, alertDeliveries, alertFeedback, packNotices, erratumNotices, preferences,
  reportSubscriptions, auditEvents, auditEventsTruncated }`. `alertFeedback`
  is their "Was this useful?" rows on alert emails, answered or not,
  `[{ projectId, kind, sentAt, useful, comment, answeredAt }]` (151; never
  the token's hash or nonce). `preferences`
  is the person's saved display preferences, `[{ preferences, updatedAt }]`,
  or `[]` if they never saved any. `packNotices` is the evidence pack emails
  sent to them (each kept 30 days after it was sent, skipped or failed), `[{ projectId, packId, event, status,
  createdAt, sentAt }]` (133). `erratumNotices` is the known engine bug
  emails sent to them as an owner (kept 30 days likewise), `[{ projectId,
  erratumId, status, createdAt, sentAt }]` (153). `account` is
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
  left. A `publication.published` event comes without its `perFarm` figures
  (other people's farms, issue #119; `publish/decision.ts`
  `withoutFarmFigures`); the project's history keeps them. Never a secret: no password or token hash, unsubscribe nonce, key or
  link material. One export a minute per account
  (`app_user.data_exported_at`); a render session is refused (403).
- **`PATCH /auth/me`** changes only the fields sent: `displayName` (whitespace runs made one
  space, control and bidi embedding/override/isolate characters dropped, then
  trimmed; 1–100 characters with at least one visible one, as at sign-up,
  `http/visibleName.ts`), `locale` (a code in the language table, e.g. `'en'` or
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
for `POST /projects/import`), a series over 60 000 days, or an export over its cap (50 MB for a CSV, 5 MB for `export.json`); `429` = an email was sent to this
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

**Machine-only codes.** A code that a translated page never meets (a
machine client reads it, or the English workspace, which shows the server's
message as it is) is in `MACHINE_ERROR_CODES` instead, so it has no words in
the frontend catalogue (same contract: add, never rename):

- `render_token_refused` (`400`/`403` from `POST /auth/render-session`: the
  render token is used, expired or unknown, or the requester lost access). The
  report renderer treats only that code as a final refusal; a `403` without it
  is a WAF or CloudFront block, and is retried with the other passing failures
  (`backend/src/reports/render.ts` `sessionRefusal`).
- `pack_errata_since_draft` (`409` from `POST …/packs/:packId/issue`): an
  erratum found since the draft was made applies to its runs' engines (or
  their fits') and its manifest doesn't record it; the message names the
  errata and says to draft the pack again ([§ Evidence packs](#evidence-packs)).
- `mfa_fresh_code` (`401` from a sign-off, `POST …/packs/:packId/issue` and
  `…/withdraw`): the session's last code from the authenticator is more than
  10 minutes old. The workspace asks for one, sends it to
  `POST /auth/mfa/step-up` and repeats the action (§ Two-step sign-in).
- `registration_not_checked` (`409` from `POST …/packs/:packId/issue`,
  167): the project requires a registration check and a specialist signer
  of the current statement has no current one; `details.signers` names
  them ([§ Evidence packs](#evidence-packs)).
- `role_conflict` (`409` from a member's role or party change, a team
  member's role change, moving a project into a team, sharing an
  application): the change would make someone who edits the project (an
  editor or owner, directly or through its team) also part of an applying
  party there: in a party, owning an application, or shared one
  (`163_licensing_authority`'s conflict guard; provisional position,
  pre-counsel research, 2026-10-01). Take them out of the party, or keep
  them below editor.
- `job_collision` (`409` from a request that queues a job): the job met a
  pending one with the same dedupe key that the caller can't see under RLS,
  so there is none to return (`backend/src/jobs/queue.ts`
  `JobCollisionError`, issue #386). Only a contributor (an applicant) can
  meet it, and only if a kind they can queue isn't keyed per user; every
  kind they can queue is (`backend/src/jobs/contributorKinds.ts`, which a
  catalogue test holds to the job table's insert policies). Try again once
  the pending job has run.

| Code | Status | When |
| --- | --- | --- |
| `not_signed_in` | 401 | no valid session |
| `wrong_credentials` | 401 | sign-in with a wrong email or password |
| `email_unconfirmed` | 403 | sign-in with the right password to an account whose address was never confirmed |
| `signin_locked` | 429 | sign-in, a password change or deleting the account while the address is locked; `params.seconds` (also `Retry-After`) |
| `account_exists` | 409 | sign-up **through an invite link** with an address that has an account (an ordinary sign-up answers the same `202` either way) |
| `signup_throttled` | 429 | `POST /auth/register` past the sign-up throttle (10 an hour per client address, 500 an hour in all), before the address is looked at; `params.seconds` (also `Retry-After`) |
| `signup_closed` | 403 | `POST /auth/register` while sign-up is closed (`SIGNUP_OPEN`; closed in production by default) without a live invite for exactly the address it signs up with: the same for a taken and a free address |
| `terms_not_accepted` | 400 | `POST /auth/register` without `acceptTerms`, or `POST /auth/me/accept-terms` without `version`, or with a version that isn't the current one (a page loaded before the terms changed); `params.version` is the current one. On sign-up, checked before the sign-up throttle counts |
| `farm_notice_changed` | 409 | `POST /auth/me/farm-notice` with a version that isn't the current one (a farm page loaded before the notice changed); `params.version` is the current one |
| `wrong_current_password` | 403 | `POST /auth/change-password`, `DELETE /auth/me` |
| `password_changed_elsewhere` | 409 | a concurrent password change won |
| `link_invalid` | 400 | a reset or confirmation link that is used, expired or malformed, or a two-step sign-in reset link (confirm, cancel) that no longer works |
| `already_verified` | 409 | `POST /auth/resend-verification` for a confirmed address |
| `verification_sent_recently` | 429 | the same, within the resend cooldown |
| `verification_limit` | 429 | the same, once the address's daily cap on reset and verification emails is reached (078) |
| `invite_invalid` | 404 | `POST /auth/invite-info` for a dead invitation |
| `note_farmer_own_farm` | 403 | a farmer's note anywhere but their own farm, shown to the farm |
| `note_farm_visibility` | 400 | a farm-visible note on something that isn't a farm |
| `note_author_only` | 403 | editing someone else's note |
| `note_delete_denied` | 403 | deleting someone else's note without the editor role |
| `note_comment_closed` | 403 | a public comment on a scenario that isn't open for comment (WP-3.15) |
| `note_audience_denied` | 403 | a scenario note with an audience the caller may not post to, or a farmer commenting on a scenario (WP-3.15) |
| `comment_throttled` | 429 | `POST /share/comment` past 10 comments an hour per account (166); `params.seconds` (also `Retry-After`) |
| `unsubscribe_link_gone` | 404 | an alert email's unsubscribe link that no longer works |
| `feedback_link_gone` | 404 | an alert email's "Was this useful?" link that no longer works (unknown, more than 30 days old, or its person left the catchment) |
| `export_throttled` | 429 | `GET /auth/me/export` within a minute of the last; `params.seconds` (also `Retry-After`) |
| `alerts_resume_throttled` | 429 | `POST /me/alerts/resume` a second time within a day, after the address was refused again |
| `body_refused` | 400 | any route: a JSON body with a NUL character, a number that overflows (`1e400`), or nesting past 64 levels (security.md § Input handling) |
| `mfa_code_wrong` | 400 | a wrong two-step sign-in code (§ Two-step sign-in) |
| `mfa_email_wait` | 429 | another emailed code too soon: `params.seconds` until the next may go (§ Two-step sign-in) |
| `mfa_email_failed` | 503 | the emailed code couldn't be sent; try again in a minute |
| `mfa_locked` | 429 | five wrong codes in a row; `params.seconds` (also `Retry-After`) |
| `mfa_challenge_expired` | 401 | `POST /auth/mfa/verify` or `/auth/mfa/reset` without a live sign-in challenge: sign in again |
| `mfa_already_enrolled` | 409 | `POST /auth/mfa/totp/enrol` with an authenticator already on |
| `mfa_not_started` | 409 | `POST /auth/mfa/totp/confirm` with nothing started |
| `mfa_not_enrolled` | 409 | turning off, or new recovery codes, with two-step sign-in off |
| `mfa_required` | 403 | an action that needs two-step sign-in (an owner's or team admin's where the project or team requires it, or one that always does), or turning a project's or team's requirement on, without a second factor set up (an authenticator or codes by email) |
| `mfa_step_up` | 403 | the same with one set up, from a session signed in with the password only |
| `mfa_reset_limit` | 429 | `POST /auth/mfa/reset` past 3 requests for the account in 24 hours (205) |
| `mfa_reset_admin` | 403 | `POST /teams/:id/members/:userId/mfa-reset` naming another admin of the team: only a member below admin (205, operator decision 2026-10-08) |
| `run_unverified` | 409 | `POST …/runs/:runId/signoffs` for, or `POST …/scenarios/:sid/decide` with, a run whose server stamp is missing or no longer matches its rows (security.md § Run stamps) |
| `account_sole_holder` | 409 | `DELETE /auth/me` from the only owner of a project or the only admin of a team; `details: { projects, teams }` names them (`[{ id, name }]` each) |

**Farmers** (role `farmer`, WP-2.1) get `403` from every `/projects/:id`
route except leaving (`DELETE /projects/:id/members/:self`); `GET /projects`
lists their projects with `role: "farmer"`, `dataUntil: null` and
`lastRunAt: null`, and the current publication's `publishedAt` (which every
member reads). Their own farm routes come with WP-2.6.

## Projects

Roles: `viewer` (read) < `editor` (change model data, run the model) < `owner`
(members, delete, move between teams).

A project's `name` (create, rename, copy, and a project document's on
import) is cleaned as a display name is (`http/visibleName.ts`): whitespace
runs made one space, control and bidi embedding/override/isolate characters
dropped, then trimmed; it must be 1–200 characters with at least one
visible one, else `400`. A team's `name` follows the same rule.

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
| PATCH | `/projects/:id` | `{ name?, description?, timeZone?, wuaName?, settings?, teamId?, requireMfa? }` | `{ project }`; `400` for a `timeZone` that isn't an IANA zone the server knows; `403 mfa_required` / `mfa_step_up` turning `requireMfa` on without being signed in with a second factor (below) | editor (owner when `teamId` or `requireMfa` is sent) |
| DELETE | `/projects/:id` | – | `204`; `409 { error, details: { packs } }` for a project with an evidence pack past draft (issued, superseded or withdrawn: its verify link must keep answering; 112, [Evidence packs](#evidence-packs)), checked first; `409 { error, details: { evidenceRun: { id, label } \| null, nominations } }` for a project that has nominated an evidence run, current or since replaced: the project is kept with its evidence run and nomination history for good (issue #43, [data-model.md](./data-model.md) § Evidence nomination). The error names the current evidence run and says the history is kept even once a nomination is withdrawn; `evidenceRun` is `null` when the newest row is a withdrawal (098), or when a nomination landed during the request (the database trigger refused it) | owner |
| POST | `/projects/import` | a project document (`ProjectFile`); query `teamId?`, `run=1?` | `201 { project, runId?, runError? }` (below) | – |
| POST | `/projects/:id/copy` | `{ name }` | `201 { project }` (settings, model + series copied, the model with fresh ids in the same id order (so the copy runs exactly as the original) and each EWR rule table's `siteNodeId` moved to its node's new id, and each series' site (a gauge's record, a unit's own rain) to its node's; a unit's rain whose unit has left the model is left out; runs and notes not ([why](./data-model.md#notes-037_notessql)); stays in the team only if you're a member or admin of it, otherwise it's personal) | viewer |

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
- **The responsible authority** (163_licensing_authority; provisional
  position, pre-counsel research, 2026-10-01): `settings.responsibleAuthority
  = { name: 1–200, kind: 'dws' | 'cma', office?: ≤ 200 } | null` names who
  decides the project's licence applications (DWS, or a CMA with the power),
  set through `PATCH /projects/:id` like any setting (editor; `400` for a
  blank name or another kind). No model input: runs don't record it and
  saving it alone leaves `updatedAt` alone. `project.actsForAuthority`
  (boolean) says whether the caller acts for it: an editor or owner whom an
  owner marked (`PATCH …/members/:userId { actsForAuthority }`); only they
  record the authority's decision on an application and endorse a published
  baseline.
- `project` (`GET`/`PATCH /projects/:id`, create, import, copy) is a
  `ProjectSummary` plus `settings`, `rerunQueuedFor`, `actsForAuthority` and `timeZone`: an
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
- **Two-step sign-in** (204_mfa_opt_in; [§ Two-step sign-in](#two-step-sign-in)):
  `project.requireMfa` (boolean, default `false`) is the project's own
  setting; `project.mfaRequired` (on `GET`/`PATCH /projects/:id`, create,
  import, copy; not in the list) is whether its owner actions need two-step
  sign-in, by that setting or its team's (read through a definer, so an
  owner shared the project directly, who can't read the team, sees it too).
  `PATCH { requireMfa }` is owner only. Turning it on answers `403
  mfa_required` / `mfa_step_up` unless the caller is signed in with a second
  factor, so a project can't lock everyone out; turning it off is an owner
  action under the setting, so it is stepped up while it is on. A change
  records `project.mfa_requirement` (`{ on }`); one that changes nothing
  records nothing, and neither moves `updatedAt` (no model input). A copy
  and the project document don't carry it.
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
  `settings.ewrHeadline` (issue #444, `projects/ewrHeadlineSettings.ts`,
  [ui.md § Settings & calibration](./ui.md#settings--calibration), *Judge
  results by*) is which EWR test the results are judged by: always present,
  default `{ source: 'auto' }` (the outlet's Reserve rule table, else the
  first site's, else the pragmatic EWR, as before it existed); `{ source:
  'pragmatic' }` (the pragmatic EWR at the outflow gauge); or `{ source:
  'ruleTable', siteNodeId }` (one site's table, null = the outlet). `PATCH`
  takes one whole choice, replaced whole (no other shape or key; `400`). A
  new rule-table site is checked against the network and the rule tables as
  they'd be saved: a gauge as for `outcomes.siteNodeId` (`400
  ewrHeadline.siteNodeId: …`, the same three reasons), the outlet when a
  table is keyed null or by the outlet node (`400 ewrHeadline.siteNodeId:
  the outlet has no Reserve rule table`); only when the choice changes, so a
  stored choice whose table has gone doesn't block other saves (the screens
  fall back to `auto` and say so). A copy or an imported project document
  moves the site to the copy's gauge. It never sets `ewrChargeSource`. Like
  `outcomes` it is no model input: runs don't record it, saving only it
  leaves `updatedAt` alone, and every run is read by the current choice.
  `settings.droughtRestriction` (engine ≥ 1.54.0, WP-3.8,
  [model.md §2.7i](./model.md), [ui.md § Drought restrictions](./ui.md#drought-restrictions))
  is the model's drought restriction rule: `{ reviewDates: ['MM-DD', …]
  (1–12), liftDates?: ['MM-DD', …] (0–12, none a review date), levels: [{
  label?, belowPct (0 < x ≤ 1), cuts: { crops?, domestic?, municipal?,
  industrial?, livestock?, irrigation?, external?, other? } (each 0–1) }]
  (1–6, mildest first), source? (≤ 500 characters), basis?: 'total' |
  'dams' | 'own', damNodeIds? (with 'dams' only, 1–500 farm dam ids),
  nodeIds? (1–500 farm ids, the units cut), ewrTrigger?: { siteNodeId: a
  gauge id (an EWR site) or null for the outlet (the catchment's EWR), level: 1…levels } }`, or `null` / absent
  for off (the default). Replaced whole, never merged; the engine's
  `droughtRestrictionIssues` checks it (`400 drought restriction rule: …`:
  real month-days, not 29 February, no date twice, thresholds strictly
  falling, a deeper level cutting each part at least as much and every part
  a milder one cuts, the trigger's level one of the rule's, no other
  field). Ids that aren't in the model are saved and left out by the run
  with a warning (the Settings form refuses them). A project copy moves its
  ids to the copy's nodes. A model input: runs record it, and changing it
  moves `updatedAt`.
  `settings.ewrDailySource` (engine ≥ 1.77.0, issue #455,
  [model.md §2.9f](./model.md), [ui.md § The daily EWR at the outlet](./ui.md))
  is where the outlet's daily EWR comes from: `{ method: 'pragmatic' | 'tab' |
  'percentile', scaling: 'mar' | 'area', tableMarMm3: number > 0 | null,
  tableAreaKm2: number > 0 | null, tabM3s: number[12] | null,
  naturalPctM3s: number[12][10] | null, reservePctM3s: number[12][10] | null }`
  (m³/s, water-year months Oct … Sep, the ten DRM points 0.1 … 0.99; every
  value 0 … 10⁶), or `null` (the default) for the pragmatic EWR. Every key is
  required (`null` when not entered) and no other is accepted. `tab` needs
  `tabM3s`, `percentile` both grids, and the scaling its divisor (`mar`:
  `tableMarMm3`; `area`: `tableAreaKm2`); `pragmatic` needs nothing, so tables
  half entered can be saved under it. Replaced whole, never merged; the
  engine's `ewrDailySourceIssues` checks it (`400 daily EWR source: <field>:
  …`). A model input: runs record it, and changing it moves `updatedAt`.
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
  (`flow_pitman_m3s` was removed in engine 0.10.0).
  `calibrationSiteNodeId` (engine ≥ 1.41.0, [model.md §2.10k](./model.md#210k-calibrating-at-a-gauge-inside-the-network-engine--1410))
  is where calibration scores: `null` (the default) = the outlet, else a
  UUID. A new site must be a gauge of the project's network above the outlet
  with an observed flow record attached to it (`time_series.site_node_id`)
  (`400 calibrationSiteNodeId: no such node in this project` / `the site is
  the outlet (null) or a gauge above it` / `that gauge has no observed flow
  record attached`); the check runs only when the site changes, so a stored
  site whose gauge or record has gone doesn't block other saves (a fit then
  refuses it, saying why). A copy or an imported project document moves it to
  the copy's gauge. A run reads it too: its calibration statistics are
  scored at the site (`RunSummary.calibration.siteNodeId`, below), and a
  stored site the run can't use (its gauge gone, or no record attached any
  more) warns (`Calibration site: …`) while the run scores the outlet. `dataQuality` (the data-check limits) takes
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
  outlet, else a gauge's node id; checked by the run, not here, except that a
  table for `null` beside one keyed by the outlet node's own id is `400`, since
  the run treats both as the outlet's and would use neither, engine ≥ 1.69.0), `source`
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
  `chirpsQuantileMap` (engine ≥ 1.53.0, CR-23) is `null` (the default: the
  CHIRPS that fills a gap takes the monthly factor alone) or `{ wetDayMm }`
  (0.1–10 mm; no other key), replaced whole by a `PATCH`. It only acts with
  `chirpsBiasCorrection: monthly` (a run under `none` ignores it and warns).
  Anything else is a `400` (the engine's `chirpsQuantileMapError`, which a
  table test holds to the schema); settings stored before it read back as
  `null`. [model.md §2.4b *Quantile map*](./model.md#quantile-map-engine--1530-cr-23).
  `unitRain` (issue #482) is `null` or absent (the default: every unit runs
  on the catchment's rain) or `{ mode: "catchment" | "perUnit", gaugeMapMm?,
  gaugeMapSource?, mapPeriod? }`, replaced whole by a `PATCH`. `perUnit` runs
  each land unit on its own rain (its rain series, below; [model.md
  §2.4h](./model.md)). `gaugeMapMm` (1–12 000 mm or `null`) is the catchment
  rain gauge's own MAP and needs `gaugeMapSource` (1–600 characters);
  `mapPeriod` (`{ start, end }`, calendar dates at least a year apart, or
  `null` = 1991-01-01 … 2020-12-31) is the period a unit's CHIRPS MAP factor
  is computed over. No other key. Anything else is a `400` (the engine's
  `unitRainError`, which the save also applies).
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
  today's date on the project's calendar (its `timeZone`, as `today`) whatever is sent, and it (and a withdrawal) is recorded
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
  `siteNodeId` (engine ≥ 1.41.0: the gauge the fit was scored at, a node
  id of at most 100 characters, or `null` for the outlet; absent on older
  records = the outlet; a copy moves it with `calibrationSiteNodeId`),
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
  the setting, absent = `{ kind: 'pan' }`; from engine 1.53.0 optional
  `chirpsQuantileMap`, validated like the setting, present only when the fit
  ran with the CHIRPS gap map on, absent = off) is the
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
`importedBy` (the importer's display name, `null` once their account is
deleted, 138). `200 { report: null }` when the
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
| GET | `/projects/:id/members` | – | `{ members: { userId, email, displayName, role, party, actsForAuthority }[] }` | viewer |
| POST | `/projects/:id/members` | `{ email, role }` | `201 { invited: true, invite }`, the same whether or not the address has an account (issue #136, see Invites); `409` if a verified account with that address is already a direct member; `429` with `Retry-After` past the daily cap on adding by email (below) | owner |
| PATCH | `/projects/:id/members/:userId` | `{ role?, party?, specialist?, actsForAuthority? }` (at least one) | `{ member }` (with `specialist` and `actsForAuthority`). `specialist` (167_signers): the applying party's appointed specialist, who signs the draft evidence packs of the party's applications; `409` without a party; a party change ends it unless the same request sets it; logged as `member.specialist`. `actsForAuthority` (163_licensing_authority) marks the member as acting for the project's responsible authority: as an editor or owner they then record its decisions on applications and endorse a published baseline. Only an owner sets it (the database refuses anyone else, `project_member_authority`); a new membership never has it; logged as `member.authority`. **Conflict guard** (D1 (c)): a role or party change that would make an editor or owner (directly or through the project's team) also a member of an applying party, the owner of an application or someone it is shared with is `409 role_conflict`; change both in one request to move someone out of a party and up to editor. `party` (≤ 80 characters, trimmed; `''` or `null` clears it) is the member's **applying party** (049): an applicant shares applications only with the other members of their own party, compared ignoring case. A change of party or role ends the application shares it no longer allows. Logged as `member.role` / `member.party` | owner |
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
  'expired', inviteId, email, role, nodeIds, invitedBy, expiresAt, locale,
  senderLapsed }` (`senderLapsed` as on an `Invite`, [§ Invites](#invites))
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

- `Invite = { id, email, role, invitedBy, createdAt, expiresAt, expired,
  senderLapsed }` — `invitedBy` is the display name of whoever last sent
  it. `senderLapsed`: they no longer own the project (administer the team),
  so nobody can accept it, nor sign up through its link, until an owner
  re-sends it, which makes them its sender (155_invite_sender_role.sql).
- Farmer invites ([§ Farmers](#farmers)) are listed here too, with `role:
  "farmer"`; `GET /projects/:id/farmers` lists them with their farms. The
  Members panel leaves them to the Farmers panel.

### Your invitations

The signed-in account's own pending invitations (issue #136,
`109_invite_accept.sql`), for an address it has **verified**: projects and
teams alike. Any signed-in account; each call sees only its own.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/me/invites` | – | `{ invites: MyInvite[] }`, live ones only (unexpired, and their sender still owns the project or administers the team, 155), newest first; empty for an unverified address |
| POST | `/me/invites/:inviteId/accept` | – | `200 { joined: { kind: 'project' \| 'team', id } }`: the membership, a farmer or applicant invite's farm links, and the `member.added` / `farmer.linked` / `team_member.added` events, as the account; `404` when it isn't yours, has expired, its sender lost the right to send it (155) or doesn't exist |
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
| POST | `/teams` | `{ name }` | `201 { team }` (you become its admin); `400` a name that shows as nothing or is over 200 characters once cleaned ([§ Projects](#projects)) | – |
| GET | `/teams/:id` | – | `{ team, members: TeamMember[] }` (admins first, then members, then viewers) | viewer |
| PATCH | `/teams/:id` | `{ name?, settings?: { portfolio: { thresholds: { green, amber } \| null } }, privacyContact?: { name, email, postal? } \| null, requireMfa?: boolean }` (at least one) | `{ team }`. `thresholds` sets the portfolio's traffic lights (below); `null` goes back to the defaults. A change records `team_thresholds.changed` on each of the team's projects; one that changes nothing records nothing. `privacyContact` sets or (`null`) removes the privacy contact (below). `requireMfa` turns the team's two-step sign-in requirement on or off (below) | admin |
| DELETE | `/teams/:id` | – | `204` — its projects stay, owned by their direct members (`team` → `null`) | admin |
| POST | `/teams/:id/members` | `{ email, role }` | `201 { invited: true, invite }`, the same whether or not the address has an account (issue #136, see Projects § Invites); `409` if already a member; `429` past the daily cap on adding by email (Projects § Invites) | admin |
| PATCH | `/teams/:id/members/:userId` | `{ role }` | `{ member }` | admin |
| DELETE | `/teams/:id/members/:userId` | – | `204` (admins remove anyone; anyone may remove themselves = leave) | viewer |
| POST | `/teams/:id/members/:userId/mfa-reset` | – | `204`: the member can't get a code and lost their recovery codes; every second factor of theirs (the authenticator and codes by email) is removed at once, every session of theirs signed out, they are emailed, and `team_member.mfa_reset` is recorded on the team's projects (205). Always needs a code from the last 10 minutes, whatever the team's setting (`403 mfa_required` / `mfa_step_up`, `401 mfa_fresh_code`, § Two-step sign-in). Only for a member below admin: `403 mfa_reset_admin` for another admin (operator decision, 2026-10-08; they use the self-service reset or the operator). `404` for someone not in the team (or no such team for the caller); `409` naming yourself (use the sign-in page's reset) or a member without two-step sign-in | admin |
| GET | `/teams/:id/invites` | – | `{ invites: Invite[] }` | admin |
| DELETE | `/teams/:id/invites/:inviteId` | – | `204` | admin |
| GET | `/teams/:id/portfolio` | – | `Portfolio` (see [Portfolio](#portfolio) below) | viewer |

- **History.** A team role is a role on every project of the team, so adding,
  re-roling and removing a member (or their leaving, or accepting a team
  invite), and deleting the team, record `team_member.added/role/removed` /
  `team.deleted` on each of the team's projects (072).
- **Two-step sign-in** (204_mfa_opt_in): `team.requireMfa` (boolean,
  default `false`): the team's admin actions, and an owner's on every team
  project, need a session signed in with a code ([§ Two-step
  sign-in](#two-step-sign-in)). Turning it on answers `403 mfa_required` /
  `mfa_step_up` unless the admin is signed in with a second factor; turning
  it off is an admin action under the setting, so it is stepped up while it
  is on. A change records `team.mfa_requirement` (`{ teamId, team, on }`) on
  each of the team's projects; one that changes nothing records nothing.
- `Team = { id, name, role, createdAt, memberCount, projectCount, settings, portfolioThresholds, privacyContact, requireMfa }` — `role` is
  **your** role in the team. `settings` is the stored document
  (055_team_settings): `{ portfolio?: { thresholds?: { green, amber } } }`.
  `portfolioThresholds = { green, amber, source: 'team' | 'default' }` is what
  the portfolio judges by: the team's own, or the defaults (5, 20).
- **Thresholds** (decision D11): percent of the last 30 days with the outlet
  EWR not met, `green` and `amber` each 0–100 with `green < amber` (decimals
  allowed); anything else, or an unknown key anywhere in `settings`, is a
  `400` (`backend/src/teams/settings.ts`; the 055 CHECK holds the same shape
  in the database). Every member reads them; only an admin changes them.
- **Privacy contact** (168_team_privacy_contact, POPIA s18(1)(b)):
  `privacyContact = { name, email, postal } | null`, whom people ask about
  the personal information in the team's projects (the team, as the client
  organisation, is the responsible party for it). `name` 1–200 characters
  and a valid `email` (≤ 254) are required, `postal` (≤ 500) is optional
  (blank = `null`); both trimmed; an unknown key is a `400`
  (`backend/src/teams/privacyContact.ts`; CHECKs hold the same in the
  database). Every member reads it; only an admin changes it. Farmers read
  it through `GET /projects/:id/privacy-contact` ([Farm](#farm)), and
  invitation emails to the team or its projects name it.
- `TeamMember = { userId, email, displayName, role }`
- `409 a team must keep at least one owner` when removing or demoting the last
  admin (including the last admin leaving). A team you aren't in is `404`.

### Portfolio

`GET /teams/:id/portfolio` (roadmap WP-2.14, `backend/src/portfolio/`): every
catchment of the team you can see, with its latest figures, for the teams
list's cards and the team page (the portfolio page that first read it became
the project list's team filter, issue #176, which reads the same figures from
`GET /projects/outcomes`). Any team member; a team you aren't in is `404`, and so is every
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
    record). Always the pragmatic EWR's days, whatever the project's
    `settings.ewrHeadline` (issue #444): a Reserve rule table is judged by
    whole months over a run, so it has no 30-day window to light.
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
| GET | `/projects/:id/alert-rules` | – | `{ rules: AlertRule[] }`: every project-wide kind, a `dam_below` per farm in network order, a `data_stale` per data feed (057), and a `data_stale` per series an API key writes (141; by kind and name); one not saved yet is `{ id: null, enabled: false }` at its default threshold (a feed's: its source's; a series': 2). An unsaved feed's or series' rule is `enabled: true` while any `data_stale` rule is on (the next evaluation switches it on) | editor |
| PUT | `/projects/:id/alert-rules` | `{ rules: { kind, nodeId?, feedId?, seriesId?, threshold, enabled }[] }` (1–500) | `{ rules: AlertRule[] }`. Upserts each, records `alert_rules.changed`, and queues an `alert_eval` (a kind switched on over a figure already past it fires at once) | editor |
| GET | `/projects/:id/alert-events?state=firing\|all` | – | `{ events: AlertEvent[] }`, newest first, at most 100: the firing ones (default), or firing and cleared. As RLS lets the caller see them: a farmer gets their own farms' dam alerts and the restriction-notice events, never another farm's; an applicant gets `[]` | farmer |
| POST | `/alerts/unsubscribe` *(public)* | JSON `{ token }`, or a form post with `?token=` | JSON: `200 { kind, project: { name }, farm }`; form: `204` | – |
| GET | `/projects/:id/alert-feedback` | – | `{ since, kinds: { kind, yes, no }[], comments: { kind, useful, comment, answeredAt }[] }`: the answers to "Was this useful?" given in the last 365 days (`since`), counted per kind (`kind` an alert kind or `digest`), and the newest 50 comments; never who gave them (issue #74, 151) | editor |
| POST | `/alerts/feedback` *(public)* | `{ token, useful: boolean, comment?: string \| null }` (comment ≤ 500 characters) | `200 { kind, project: { name } }` | – |

- Kinds, what fires them, and who gets them by default:

  | `kind` | Fires when (hysteresis: re-arms only after recovery) | `threshold` | Default: right away | May opt in |
  | --- | --- | --- | --- | --- |
  | `dam_below` (per farm) | the published projection's dam level on its last day of data, or the published forecast's lowest, is below the threshold; re-arms at threshold + 5 points | 0 < t < 1 (0.3) | that farm's farmers, editors, owners | viewers |
  | `ewr_forecast_fail` | the newest forecast run (while its days haven't passed) has `outletEwrDaysAtRisk ≥ t`; re-arms at ≤ t − 2. A forecast run behind the recorded rain (its `lastObserved` before the last day with a catchment or CHIRPS value) is ignored: it neither opens nor clears an event until the re-made one | whole days 1–60 (3) | editors, owners | viewers |
  | `data_stale` (per feed) | that feed, enabled, is more than t days past its own usual delay (`feeds/config.ts` `feedStaleAfterDays`: the feed's config, else 62 days for CHIRPS `rnl`, else the source's); re-arms under t | whole days 1–60 (by source: CHIRPS 3, CHIRPS-GEFS 2, DWS 30) | editors, owners | – |
  | `data_stale` (per series, 141) | a series an API key writes (a logger) has had no value for more than t days past yesterday (its last non-blank day, `series/lastDay.ts`, not its last stored day; today's reading isn't whole yet); re-arms under t. A hand-uploaded series gets no rule: it is stale by nature (issue #120) | whole days 1–60 (2) | editors, owners | – |
  | `farms_short` (141) | the current publication was made by an auto run (`run_publication.auto`, `settings.autoRun.publish`) and t or more farms went short on a day of its last 7 days of data (`catchmentView.recent.farmsShort7`); re-arms at 0. A person's publication has no value (the WUA made it and saw its figures), so it clears a firing alert, unmailed | whole farms 1–1000 (1) | editors, owners | viewers |
  | `restriction_published` | the current publication's restriction level, percentage or notice changes (a lift too) | 0 | farmers, viewers and up | – |
  | `feed_failing` | an enabled feed failed t times in a row; re-arms at 0 | 1–20 (3) | owners | editors |
  | `job_dead` | t jobs died in the last 24 hours; re-arms at 0 | 1–100 (1) | owners | editors |

  Applicants (contributors) never get alerts. A `threshold` outside its
  range, a `dam_below` rule without a farm (or another kind with one), or a
  `data_stale` rule without exactly one of a feed and a series (or another
  kind with either) is `400`; a farm, feed or series of another project, or
  a series no API key writes (and with no rule yet), `404`. Once
  `data_stale` is on for any feed or series, a feed added later gets its own
  rule, on, at its source's default, and so does a series an API key starts
  writing, at 2 days. A series keeps its rule after a person writes over the
  key's days.
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
- `AlertRule = { id, kind, nodeId, nodeName, feedId, feedName, feedEnabled, seriesId, seriesName, seriesKeyFed, threshold, enabled, firing }`
  (`feedName` as the feeds page names the feed, e.g. "CHIRPS daily rainfall (Upper)";
  `seriesName` the series as the Data page names it, its name else its kind's label, e.g. "Weir" or
  "Flow — logger"; `seriesKeyFed` whether an API key still writes it, false once a person wrote over the
  key's days).
- `AlertEvent = { id, kind, state, value, threshold, nodeId, nodeName, feedId, seriesId, openedAt, clearedAt, detail, forecastOutOfDate }`.
  `detail` holds the figures the alert was raised on: `dam_below`
  `{ source: 'latest'|'forecast', pct, date, madeOn?, publishedAt }` (that
  farm's own projection only); `ewr_forecast_fail` `{ days, of, from, to,
  madeOn }`; `data_stale` `{ feedId, feeds: [{ label, newest, overdue }] }` (its one feed;
  `overdue` counts to today in the project's time zone), or for a series'
  rule `{ seriesId, series: true, feeds: [{ label, newest, overdue }] }`;
  `farms_short` `{ publicationId, farmsShort7, farmsShort30, of, from, to,
  publishedAt }` (counts only, never a farm's name; `of` the publication's
  farms);
  `feed_failing` `{ feeds: { label, failures }[] }`; `job_dead` `{ count }`;
  `restriction_published` `{ publicationId, level, pct, lifted, publishedAt }`.
  While an event fires, its `value` and `detail` follow the figure. A
  forecast's `madeOn` is the day the run was made, and "still current" (its
  `to` not yet past) is judged against today, both in the project's time
  zone.
- `forecastOutOfDate` is `{ madeOn, observedTo, rainUntil }` on a **firing**
  `ewr_forecast_fail` event while the project's newest forecast run is
  behind the recorded rain (its `lastObserved`, `observedTo` here, before
  `rainUntil`, the last day with a catchment or CHIRPS rain value; read at
  request time, `alerts/evaluate.ts` `newestForecast`), and `null`
  otherwise (a current forecast, a cleared event, every other kind). Such a
  forecast neither opens nor clears the event, so without a newer forecast
  (the forecast feed failing, which `feed_failing` reports) the event keeps
  the figures of the last current one; this says so. A mail of the event
  sent meanwhile (a digest line the next morning) adds the same in a
  sentence (`mail.alert.ewr.outOfDate`).
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
- **"Was this useful?"** (issue #74, `151_alert_feedback`). Every alert
  email and digest asks it, after the button, with two plain links, **Yes**
  and **No**, to the site's `/alerts/feedback#t=<token>&a=yes|no` (token
  and answer in the fragment, so neither reaches a server log). There is no
  open or click tracking and no image or pixel in any alert email: opening
  the mail or following a link records nothing. The page preselects the
  link's answer and asks first; only **Send** posts `POST /alerts/feedback`,
  so a mail scanner that opens links answers nothing. The token is
  single-purpose (its own HMAC label beside the unsubscribe token's,
  `alerts/tokens.ts`; neither works at the other's route) and answers only
  its own email, without signing in; answering again replaces the answer.
  `404 feedback_link_gone` for a malformed, tampered or unknown token, a
  link more than 30 days old, or a person who is no longer a member of the
  catchment; `400` for a missing answer or a comment over 500 characters.
  Same-origin from the page, so the CSRF check applies (unlike the
  unsubscribe). Editors see the answers in the rule editor
  (`GET …/alert-feedback`).

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

Names are one line (issue #385, migration 189): a node or crop name (1–100
characters after trimming), a borehole or demand object name (1–200) and a
demand schedule window's `label` (0–200) may not hold a line break, a tab or
any other control character (C0, DEL, C1, U+2028, U+2029; the engine's
`NAME_CONTROL_CHARS`). `PUT` refuses one with `cannot contain line breaks or
control characters`, as do the scenario ops that set a name or label and
the map's Start and Divide apply. A scenario saved before the rule keeps its
ops byte for byte (`ops_sha256` and evidence packs pin them), so a `PATCH`
of its `ops` may keep any such name that is byte-identical to one in the
stored ops (the engine's `validateScenarioOps(raw, { stored })`); a new one
is refused. A demand object's `note` may still run
over lines. The bulk paths make a name one line instead (every run of
whitespace and control characters one space, the engine's `oneLineName`): a
project document's import (`POST /projects/import`, `pnpm import:project`),
a restore of a version saved before the rule, and the workbook importers.

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
transfer. Canal seepage back to the river (engine ≥ 1.42.0, migration 126):
`lossReturnPct` (0–1, default 0: the losses all leave the catchment) and
`lossReturnNodeId` (a uuid or `null`, the default: the source), the unit whose
outflow the returned seepage joins. `PUT` refuses a river off-take that isn't
unit to unit or whose destination drains into its source (along the river or
through other off-takes), and a return unit that isn't the source or a farm
downstream of it along the river. A run with off-takes stores `offtake_out` on each source,
`offtake_in`, `offtake_used` and `offtake_to_dam` on each destination, and
each rule's `transfer_rule@<id>` (what it took, before losses), and
`offtake_loss_return` on each unit seepage rejoins below (engine ≥ 1.42.0);
`summary.waterBalance` and the water account gain `conveyanceLossM3` (what
was lost, net of the seepage returned);
nodes carry `irrigationEfficiency`, `returnFlowFraction` (engine ≥ 1.71.0: the share of the water supplied returning, at most 1 − the unit's blended efficiency, accepted above it and capped by the run, which warns; a document with 0.16.0–1.70.0's `lossReturnFraction` β, a share of the losses, is read as β(1 − e)), `damAreaFullM2`
(nullable), `damAreaExponent` (0 < b ≤ 1 from engine 1.63.0; a stored node
with a larger value from before loads and runs, with a warning, and must be
brought to 1 or below to save) and `damSeepagePerDay`. A body without them
(an older document or tab) is read as migration 006 stored the database.

Other water users (engine ≥ 0.22.0, migration 011, [model.md §2.7c](./model.md#27c-other-water-users-engine--0220-roadmap-wp-133)):
`kind` may be `"user"`, and every node carries `userDemandM3Day` (12 numbers
≥ 0, water-year months, m³/day, or `null`), `userReturnPct` (0–1) and
`userPriority` (`"senior"` | `"junior"`). A body without them gets `null`, 0
and `"senior"`; the engine ignores them on farms and gauges. `PUT` refuses a
crop area or a transfer on a user node. A user's `pumpCapacityM3Day` (engine
≥ 1.58.0, the supply fields' column below) is its river pump: ≥ 0, or `null`
= no limit (the default); a supply rule other than `"damFirst"` on it is
refused.

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
Engine ≥ 1.49.0: `lakeEvapFactorSource`, a trimmed string of at most 600
characters, '' for none (settings stored before it read back as ''): where
the dam evaporation factors came from, e.g. a lake-factor preset's note
(the engine's `LAKE_FACTOR_PRESETS` / `lakeFactorPresetFill`, which the
Settings form uses; there is no preset endpoint). Provenance only, recorded
with each run.
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

Irrigation systems (engine ≥ 1.72.0, migration 198,
[model.md §2.3](./model.md#23-irrigation-demand) step 6): the model carries
`irrigationSystems`, the project's table (`{ id, name, efficiency, preset,
sortOrder }`, efficiency 0 < e ≤ 1; a new project starts with the six SABI
rows); a crop carries `irrigationSystemId`, its default (or `null` / absent:
none), and a crop area `irrigationSystemId`, that unit's own (absent: the
crop's default). A reference is a row's id, or a SABI preset's key (`drip`,
`micro`, `pivot`, `sprinkler`, `movable`, `surface`) for the project's row
for it; a document may also carry rows with ids of its own (`workbook-1`),
which the save gives new ids. `PUT` without `irrigationSystems` keeps the
project's table; with one, it replaces it (a row gone leaves its crops and
plantings on none). A reference to a row the table lacks is a 400. `GET`
leaves the keys out where there is none. A document from engine
0.43.0–1.71.0 with a crop's own `irrigationEfficiency` reads as the system
with that efficiency (a SABI row, else an added "Imported, NN %" row); one
outside (0, 1] is refused, as before. The unit's own `irrigationEfficiency`
is only the fallback for a planting with no system. A `returnFlowFraction`
above the unit's losses at its blended efficiency is accepted (a run caps it
and says so).
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
priority ('first' | 'shared' | 'last'), rank (a whole number 1–99, or
null; engine ≥ 1.64.0, issue #343: its place within 'first' or 'last', 1
before 2, equal ranks pro rata; null = 1; ignored on 'shared'),
destination ('internal' | 'external'), enabled, schedule (below, or null),
population (≥ 0 or null), source ('meter' | 'aadd' | 'perCapita' | 'other',
or null), waterSource ('dam' | 'river', or null = the dam), riverPumpM3Day
(≥ 0 or null = no limit), riverPoolM3 (≥ 0 or null = none), monthlyUnit
('ls' | 'm3s', or null = m³/day; engine ≥ 1.72.0, migration 199: the unit a
monthly demand is entered and shown in, display only, `monthlyM3Day` stays
m³/day), note (≤ 1000 chars) }[]`,
at most 5 000. Defaults: other, monthly, null, null, null, 0, null, 0, shared,
null, internal, true, null, null, null, null, null, null, ''. `PUT` refuses an object on a gauge, an other water
user or an unknown node, a monthly one without 12 values, a per-unit one
without a count and litres, an external one with a return share above 0, a
negative population, a rank outside 1–99 or not whole, an unknown source, and a source whose sizing it doesn't
have.

A demand object's `source` (engine ≥ 1.56.0, migration 139, issue #54 Q11,
[model.md §2.7f](./model.md)) is where its number comes from, by the rule
agreed with the client: `meter` (meter records) and `aadd` (a reconciliation
strategy's AADD) are volumes, so the object must be `monthly`; `perCapita`
(population × litres a day) must be `perUnit`; `other` (a licence, an
estimate, a workbook's typed-over demand) may be either. Null = not recorded
(every object saved before it). It changes no number in the run; `note` keeps
the detail (which meter, which strategy, which norm).

A demand object's `waterSource` (engine ≥ 1.65.0, migration 170, issue #344,
[model.md §2.7j](./model.md)) is where its water comes from: null or `'dam'`,
the unit's dam side under its supply rule (every object saved before it);
`'river'`, a river abstraction of its own beside the dam, with the pump
`riverPumpM3Day` and the pool `riverPoolM3` (capacity only: it starts full,
its area is estimated). A pump or pool on a dam-sourced object is kept but
unused. `PUT` refuses an unknown source and a negative or infinite pump or
pool. Runs of a unit with a river abstraction store, per abstraction (key the
object's id or `crops`), `river_take@<key>` (m³/day, part of `supplied`) and,
with a pool, `river_pool@<key>` (m³, end of the day) and
`river_pool_evaporation@<key>` (m³/day); its `FarmSummary.riverTakes` lists
each one's mean take, pump and pool, and the water balance gains
`poolEvaporationM3`.

A demand object's `population` (engine ≥ 1.44.0, migration 127, issue #123,
[model.md §2.7f](./model.md)) is the people it serves, for the basic-needs
floor of a domestic or municipal object (population × 25 l a day; read for
those two categories only). Null = a per-unit object's `count`; a monthly one
without a population has no floor.

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
`"damFirst"` on a gauge or other user, a pump capacity on a gauge (an other
user's is its own river pump from engine 1.58.0, [model.md §2.7c](./model.md)), `"trigger"` on a
farm without a dam, `"runOfRiver"` on a farm with a dam capacity above 0, and
a stop level below the trigger. Runs of a farm with a rule other than
`"damFirst"` store the series `river_abstraction` (m³/day, part of
`supplied`) and its summary gains `avgRiverAbstractionM3Day`.

The crops' water source (engine ≥ 1.65.0, migration 170, issue #344,
[model.md §2.7j](./model.md)): every node carries `cropWaterSource`
(`"dam"` | `"river"`), `cropRiverPumpM3Day` (≥ 0 or `null` = no limit) and
`cropRiverPoolM3` (≥ 0 or `null` = none). A body without them gets `"dam"`,
`null` and `null` (no change to any run). `PUT` refuses `"river"`, a pump or
a pool on a node that isn't a farm, an unknown source and a negative pump or
pool. Under `"river"` the unit's crops take from a river abstraction of their
own beside the dam (series `river_take@crops`, and with a pool
`river_pool@crops` and `river_pool_evaporation@crops`); the supply rule then
serves the unit's dam-sourced demand objects only.

Bed losses (engine ≥ 1.75.0, migration 203, issue #444,
[model.md §2.6b](./model.md)): every node carries `reachLossFrac` (0–1, the
share of the flow it passes downstream lost in the reach to the next node)
and `reachLossMaxM3Day` (≥ 0 or `null` = no cap). A body without them gets 0
and `null` (no loss, no change to any run). `PUT` refuses a share outside
0–1, a negative cap, and a share on the outlet, which has no reach below it
(more than half the flow without a cap saves, and its runs warn).
A run with bed losses stores `reach_loss` (m³/day) on each node that has them,
and `summary.waterBalance` and the water account gain `reachLossM3`; the
run warns that the EWR is still read from the natural flow before the losses.

A unit's MAP (issue #482, migration 209, [model.md §2.4h](./model.md)): every
node carries `mapMm` (1–12 000 mm, or `null` = none) and `mapSource` (where
it came from, at most 600 characters, or `null`). A MAP needs its source
(`400 … a MAP needs its source`, the engine's `mapMmError`); a source sent
with no MAP is not kept (`null`). A body without them gets `null` (no MAP, no
change to any run). Only land units read it, under `settings.unitRain`
`perUnit`; the project document, a copy and an import carry it with the node.
`POST /projects/:id/map/unit-map` also writes it, from a MAP grid, with a
source line of the form `<grid> <version>, area-weighted mean over the
unit’s parcel, <n> cells`, which that route reads back to keep one grid per
project ([§ Catchment map](#catchment-map)).

The crop supply table (engine ≥ 1.73.0, migration 202, issue #408,
[model.md §2.7k](./model.md)): every node carries `cropShareDam`,
`cropShareRiver`, `cropShareRemote` (0–1 or `null`), `cropRemoteNodeId` (a
node id or `null`) and `cropRemoteCapM3Day` (≥ 0 or `null` = no limit). A
body without them gets `null` for all five (no table, no change to any run).
`PUT` refuses a share outside 0–1, a negative pipe, a table on a node that
isn't a farm, shares that don't add up to 100 %, and a remote share without
another unit with a dam or with a unit this one drains into. With a table the
crops' demand is asked of each source by its share; runs store
`remote_dam_in` on a unit with a remote share (part of `supplied`) and
`remote_dam_out` on a unit whose dam gives one.

Hands-off flow and River to dam by month (engine ≥ 1.32.0, migration 114,
issue #204, [model.md §2.7h](./model.md)): every node carries
`handsOffM3Day` (12 finite m³/day values ≥ 0 by water-year month, Oct–Sep, or
`null` = none), `handsOffEwr` (boolean) and `divertMonthlyM3Day` (12 finite
m³/day values ≥ 0, or `null` = the one `divertCapacityM3Day` all year). A
body without them gets `null`, `false` and `null` (no change to any run).
`PUT` refuses any of them on a gauge or other user and an array that isn't
12 values ≥ 0.

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
| PATCH | `/projects/:id/series/:seriesId` | `{ product, productVersion }` (both strings, or both `null` to clear), and/or `{ siteNodeId }`, and/or `{ source }` (a string, or `null` to clear; 107) | `SeriesMeta`: says what an existing series holds, where its values came from (`source`), or which node it belongs to (`siteNodeId`): where a flow record was measured (a gauge node above the outlet, or `null` for the outlet; 084, engine ≥ 1.4.0, [data-model.md](./data-model.md#gauge-records-084_gauge_recordssql)), or the land unit whose own rain a `rain_catchment_mm` / `rain_chirps_mm` series is (a farm with an area above 0, or `null` for the catchment's rain; 209, issue #482, [data-model.md](./data-model.md#unit-rain-series-209_unit_rain_seriessql)); the values and `updatedAt` are untouched. `400` for a site on an evaporation or forecast series, a node that isn't in the project (save the model first), a flow record at a farm, a user or the outlet gauge, or rain at a gauge, a user or a farm with no area. Logged as `series.labelled` / `series.site_changed` when it changes (`site.from` / `to`: the node's name, `the outlet` or `the catchment`) | editor |
| DELETE | `/projects/:id/series/:seriesId` | – | `204` | editor |

`SeriesMeta = { id, kind, name, unit, startDate, length, updatedAt, lastValueDate, product, productVersion, dayBoundary, siteNodeId, source, sourceUnit, sourceUnitFactor, rebuilding, feed }` —
`source` is where the values came from (a station id, agency, file or data feed; `null` = not recorded) and `sourceUnit` /
`sourceUnitFactor` the unit the upload gave and the factor that converted it to `unit` (both `null` = not recorded; 107,
[data-model.md § Series source and unit](./data-model.md#series-source-and-unit-107_series_sourcesql)). A PUT records exactly what it
was (a `source` it doesn't give is cleared); a merge records them only on a new or empty series. `source` is 1–200 characters on one line
(`400` otherwise); the given unit is never a body field, and a PATCH naming `sourceUnit` is a `400`;
`lastValueDate` is the last day with a value (`null` when every day is blank): how far the data reaches, where `startDate + length − 1`
counts the blank days a merge stores (the Data page's freshness, "Data now runs to", the report's data coverage);
`siteNodeId` is the gauge a flow record was measured at (`null` = the outlet; only the plausibility checks read a gauge's record), or the land unit a rain series is the own rain of (`null` = the catchment's; a run reads it under `<kind>@<unit id>`, and only `settings.unitRain` `perUnit` uses it);
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
| GET | `/projects/:id/runs/:runId/day?nodeId=…&date=YYYY-MM-DD` | – | One node's every column on one day, for the day trace: `{ date, nodeId, name, kind, previousStorageM3, previousSoilWaterMm, params, columns: { key, label, unit, value }[] }`. `name`, `kind` and `params` (`pctUpstreamToDam`, `pctRunoffToDam`, `divertCapacityM3Day` (the day's month's value for a farm with River to dam by month, engine ≥ 1.32.0), `damCapacityM3`, `damInitialPct`, `damMinPct`, `irrigationEfficiency`, `returnFlowFraction`, `damAreaFullM2`, `damAreaExponent`, `damSeepagePerDay`) come from the run's input snapshot (a run from before engine 0.16.0 has its `returnFlowPct` mapped as migration 006 does: e = 1 − r with all the losses returning, or 1 and 0 when r = 0; `returnFlowFraction` is the share of the water supplied the run returned: its r capped at 1 − e, or, for a run saved by engine 0.16.0–1.70.0, β × (1 − e) of its share of the losses β; `irrigationEfficiency` is the one the run used, so a farm whose crops carry their own, engine ≥ 0.43.0, gets them combined as [model.md §2.3](./model.md#23-irrigation-demand) step 6 does, and `demand` = `crop_requirement` ÷ it); `previousStorageM3` is the dam storage at the end of the day before (the initial storage on the run's first day: initial % × that day's capacity, engine ≥ 1.30.0; `null` for a gauge); `previousSoilWaterMm` is the farm's soil-water store at the end of the day before, in mm (0 on the run's first day; `null` for a gauge or a run from before engine 0.14.0, which has no `soil_water` column). `400` for a date that isn't one or is outside the run, `404` for a node the run doesn't have | viewer |
| GET | `/projects/:id/runs/:runId/day?date=YYYY-MM-DD` | – | The same without `nodeId`: the catchment's day, for the runoff-model trace (how rain became natural flow): `{ date, nodeId: null, name: "Catchment", kind: "catchment", runoffModel, areaKm2, params, previousStorageMm, previousStores, columns }`. `columns` are every catchment series (`node_id` NULL) that day; for GR4J they include `rain_used`, `pet`, `aet`, `production_store`, `routing_store`, `uh_store`, `exchange` (only when X2 ≠ 0) and `natural_flow` (m³/day), all depths in mm over the catchment. `runoffModel`, `areaKm2` and `params` (`x1` … `x4`, `warmupDays`) come from the run's `summary.runoff`; `previousStores` is each store at the end of the day before (on the run's first day, each store after the warm-up from `summary.runoff.storesStartMm`, engine ≥ 1.20.0; each `null` there on a run from before, which recorded only their total) and `previousStorageMm` their total (the storage after the warm-up on the first day), so before + rain + exchange − AET − Q = after closes the day. A run without a runoff balance ran the legacy model (a stored run from before engine 1.0.0): `runoffModel: "legacy"`, `areaKm2`, `params`, `previousStorageMm` and `previousStores` `null`, and the columns are the [Flow data] ones (`rain_used`, `is_summer`, `rain_flow`, `base_flow`, `response_flow`, `resultant_flow`, `natural_flow`). `400` for a bad or out-of-run date | viewer |
| PATCH | `/projects/:id/runs/:runId` | `{ notes?, pinned? }` (at least one) | `200 { run: RunMeta }` with the new note and its stamp, and the pin. `notes` is a string, trimmed, at most 4 000 characters, no NUL; `''` clears it. `pinned` is a boolean: `true` keeps the run past the run cap (below) and blocks its deletion, `false` releases it; pinning leaves the note's stamp alone. `409 { error: "this project already has 10 pinned runs, the most it can keep; unpin one first" }` when pinning an 11th (re-pinning a pinned run is fine); a **cited** run's pin doesn't count against the 10 (it is kept anyway), and unpinning a cited run is `409 { error: "this run is cited by scenario "…", so it stays kept" }`. No other field is accepted (`400`), and nothing else about a run can change: the database grants the app `UPDATE` on `model_run.notes` and `model_run.pinned` only ([data-model.md § Run notes, Pinned runs](./data-model.md)) | editor |
| DELETE | `/projects/:id/runs/:runId` | – | `204` (the run's stored input series go too, unless another run uses them); `409 { error: "run is published: it is, or was, the published baseline, so it is kept" }` for a run a publication in the history holds ([Publication](#publication)); `409 { error: "this run is cited by scenario "Dam raise", so it is kept" }` for a run something else cites (a [scenario](#scenarios)'s base, a sign-off, or an [evidence pack](#evidence-packs): `this run is cited by the evidence pack version 2, so it is kept`), naming up to three citations you can see (`"this run is cited, so it is kept"` when you can see none; [data-model.md § Cited runs](./data-model.md#stored-run-inputs-021_series_blobsql)); `409 { error: "this run is or was nominated as evidence, so it is kept" }` for a run the evidence history names; `409 { error: "this run is pinned; unpin it before deleting it" }` for a pinned run; `409 { error: "this run can't be deleted" }` when row-level security refuses the delete of a run you can read (never a `404`); `404` only for a run that isn't there (already deleted or trimmed). The check and the delete see one locked row | editor |
| GET | `/projects/:id/evidence` | – | `{ nominations: Nomination[] }`, **oldest first**; the last is the current nomination, unless it is a withdrawal (then no run is the evidence); `[]` when none. `Nomination = { id, withdrawn, runId, runLabel, runCreatedAt, runoffModel, engineVersion, reason, nominatedAt, nominatedBy }`; a withdrawal has `withdrawn: true` and every run field `null` | viewer |
| POST | `/projects/:id/evidence` | `{ runId, reason }` | `201 { nomination, nominations }`: the new row and the whole history. `reason` is required: trimmed, 1–2 000 characters, no NUL. No other field is accepted (`400`): who, when, the runoff model and the engine version are stamped by the database. `404 run not found` for a run not in this project; `409` for a legacy-model run (a stored run from before engine 1.0.0; workbook comparison only), a run whose stored inputs have flow shares over 100 % (made before engine 0.27.1 refused them), the run that is already current, a forecast run (WP-2.12: evidence is judged on the record, and a forecast run's last days are modelled on forecast rain), a scenario run (its scenario's changes on a base run, also once the scenario is deleted; an application is assessed against the nominated run instead), or a project at its limit of 50 nominations | editor |
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
- `RunMeta = { id, label, engineVersion, startDate, endDate, createdAt, createdBy, legacy, runoffModel, notes, notesUpdatedAt, notesUpdatedBy, evidence, pinned, published, scenarioId, scenarioName, fromScenario, citedBy, reproducible, trigger, forecastFrom, fitEngineVersion, errata }` —
  `createdBy` is the maker's display name, `null` once their account is
  deleted (138: the run stays, the name goes; the workspace says "a former
  member"). `trigger` is what made the run (042_auto_rerun): `manual`, `auto` (WP-2.11)
  or `forecast`; `forecastFrom` a forecast run's first forecast day
  (`summary.forecast.from`), else `null`. `fitEngineVersion` is the engine
  of the automatic fit the run's parameters came from
  (`settings.fitRecord.engineVersion`), else `null`; `errata` the ids of the
  known engine bugs that may affect the run (issue #103,
  [engine-errata.md](./engine-errata.md)): the errata whose range holds its
  engine, or its fit's for a `fit` erratum, `[]` for none. The list and
  `GET …/runs/:runId` carry it; other routes answering with a run may not.
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
  a run of the model). `fromScenario` is whether a scenario made the run,
  `true` also once that scenario is deleted (`model_run.from_scenario`, 188):
  tell a run of the model by it, never by `scenarioId`. `citedBy` is what keeps the run for good
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
  name (`null` once that account is deleted, 138). The history is append-only: nominating another run adds a row and
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
  run predates it). Engine ≥ 1.41.0: scored at `settings.calibrationSiteNodeId`
  when it names a usable gauge inside the network, and then carrying
  `siteNodeId` and `siteName` (absent at the outlet): the gauge's record
  against its simulated outflow, with that record stored as the node series
  `observed_flow` (and `observed_flow_other`) beside the node's `outflow`.
  `summary.catchment.ewrAgreementSites` (engine ≥ 1.41.0, absent when none)
  is the EWR test against observed flow at each gauge EWR site with a record
  of its own, `{ nodeId, name, flowKind, agreement }[]` with `agreement`
  shaped like `catchment.ewrAgreement` ([model.md §2.10k](./model.md#210k-calibrating-at-a-gauge-inside-the-network-engine--1410)).
  When the project has both a gauge and a logger record,
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
  Engine ≥ 1.48.0: the scored record's per-day quality flags are the series
  `observed_flow_quality`, each day's class code (0 in the gauged range,
  1 human use, 2 below the lowest gauging, 3 above the highest gauging,
  4 suspect, 5 infilled, 6 missing; the label spells them out), stored
  beside the scored `observed_flow`: the catchment series at the outlet,
  the node series at a calibration site. Only when some day is flagged (a
  class other than 0 or 6), like `rain_catchment_missing`
  ([model.md §2.10h](./model.md)); it follows `summary.calibration`'s
  `siteNodeId` (absent there = the catchment).
  `RunSummary.ewrCompliance` is the water-year × month EWR grid for the outlet
  and each farm (tens of KB even for a multi-decade, multi-farm run). Both are defined in
  `packages/engine/src/project.ts`; runs saved before engine 0.3.0 lack the
  newer fields, so clients treat them as optional.

- `summary.users` (engine ≥ 0.22.0; only when the network has other water
  users) is `UserSummary[]`: per user its priority and whole-run means of
  demand, taken, deficit, fraction supplied, returned and EWR charge, and the
  days it was charged; a user with a pump capacity (engine ≥ 1.58.0) also
  has `avgRiverAbstractionM3Day`, `avgPumpLimitedM3Day` (the demand its pump
  left unmet although the river had it) and `daysPumpLimited`, beside its run
  series `pump_limited` (its river take is `supplied` − `groundwater_used`;
  `river_abstraction` stays a farm's). `summary.curtailment.otherUsers` has the same users over
  the reporting window with `curtailed` (junior), `supplyCutM3Day` (≤ 0) and
  `uncurtailedChargeM3Day` (the charge a cut doesn't remove; all of it for a
  senior user). User nodes have the run series `demand`, `supplied`,
  `deficit`, `inflow_upstream`, `outflow`, `return_flow`, `ewr_cumulative`,
  `ewr_shortfall` and `ewr_charge`; with a senior user every node also has
  `senior_requirement`, and farms `passed_for_senior`. The day trace's `kind`
  may be `"user"` (`previousStorageM3` null).
- `summary.catchment.outletEwr` (engine ≥ 1.77.0, issue #455; only when the
  daily outlet EWR came from a DRM table, `settings.ewrDailySource`):
  `{ method: 'tab' | 'percentile', scaling: 'mar' | 'area', scale,
  modelMarMm3?, tableMarMm3? (with 'mar'), modelAreaKm2?, tableAreaKm2?
  (with 'area'), pinned?: true (a resumed run's, from its snapshot) }`; the
  outlet's `ewr` series is then labelled `EWR from the DRM TAB file (scaled)` /
  `EWR from the DRM percentile tables (scaled)`. Absent = the pragmatic EWR.
- `summary.droughtRestriction` (engine ≥ 1.54.0, WP-3.8; only with
  `settings.droughtRestriction`): `{ rule (as applied), years: [{
  waterYear, days, daysByLevel: [none, level 1, …] }], daysByLevel (the
  whole run), reviews (days the level was decided), units: [{ nodeId, name,
  avgDemandM3Day, avgRestrictedDemandM3Day, avgSuppliedM3Day,
  avgCutOnRestrictedDaysM3Day (the mean cut over the days a level was in
  force, null when none was), daysByLevel }] (the units the rule cuts, id
  order), ewrReviews? (with an EWR trigger: reviews after a day its site
  failed), start? (a resumed run: { levelsBefore: { nodeId: level } | null,
  ewrFailedBefore, damStorageBeforeM3: { nodeId: m³ } }) }`. Under the
  'own' basis the catchment `restriction_level` is the deepest any unit is
  at, each cut unit has its own `restriction_level`, and there is no
  `restriction_cut@<part>`. The run has the catchment series `restriction_level` (0 =
  none) and `restriction_cut@<part>` (the day's cut, 0–1, for each part a
  level cuts), and every farm `restricted_demand` (m³/day, what its sources
  are asked for; `demand` and `deficit` stay the unrestricted demand's).
  The summary CSV has a *Drought restrictions* block. `verification.checks`
  has `droughtRestriction`.
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
  minQM3s, maxQM3s }` or null. From engine 1.55.0 also `signatures`
  (absent on older runs; null without an observed record;
  [model.md §2.10d](./model.md), *Validation signatures*, CR-16), of the
  scored record (the calibration site's when `calibrationSiteNodeId` is
  set): `{ flowKind, siteNodeId?, siteName?, baseflow, lowFlowFdc,
  recessionHoldout }`; `baseflow` `{ hughesFilter, eckhardtFilter, days,
  runs, hughes, eckhardt, withinLimit }` with each index `{ observed,
  simulated, difference }` or null (null with fewer than 365 days in
  stretches of 30); `lowFlowFdc` `{ days, range, observedQ70M3s,
  observedQ95M3s, simulatedQ70M3s, simulatedQ95M3s, observedSlope,
  simulatedSlope, slopeBiasPct, lowVolumeBiasPct, withinLimit }` (null with
  fewer than 365 days; `slopeBiasPct` null when the observed slope is 0 or
  either curve's Q95 is at or below 0.001 m³/s); `recessionHoldout` `{ every, segments, heldOut, law,
  days, modelSegments, modelDays, modelSkill, lawSkill, modelLogRmse,
  lawLogRmse, agrees }` (null without rain), `heldOut` as `[first, last]`
  run-day indices. The checks only report and
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
  name, category, source?, priority, rank?, destination, avgDemandM3Day, avgSuppliedM3Day,
  avgDeficitM3Day, fractionSupplied, avgReturnedM3Day, daysShort, daysOff? }[]`,
  in id order; `daysOff`, engine ≥ 1.17.0, only on an object with a schedule:
  the days it switched the object off, never counted in `daysShort`;
  `source`, engine ≥ 1.56.0, only on an object that records one: the model's
  `source`, as a report grades the demand by; `rank`, engine ≥ 1.64.0, only
  on a `first` or `last` object with a rank set: its place within its class). Its `demand`, `supplied`, `deficit` and `return_flow` are the crops'
  and the objects' together. The basic-needs floor (engine ≥ 1.44.0, issue
  #123): a domestic or municipal object with people adds `basicNeedsPopulation`,
  `basicNeedsM3Day` (the floor, m³/day abstracted), `daysBelowBasicNeeds` and
  `avgBelowBasicNeedsM3Day` (days and mean volume supplied below the day's
  floor, apart from `daysShort` and the deficit) and
  `avgSuppliedLitresPerPersonDay` (what it got per person at the tap, the
  municipal restriction level, for display); its unit has the run series
  `basic_needs` (Σ each floored object's MIN(floor, demand), m³/day).
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
  cut exceeds the equitable share. From 1.44.0 (issue #123) a unit with a
  basic-needs floor adds `basicNeedsM3Day` (the window mean of its
  `basic_needs`) and `basicNeedsHeldM3Day` (≥ 0, what the floor held back of
  the cut), both also in `totals` when a farm has them; its
  `volumeLeftM3Day` is then `MAX(MAX(target + ewrSupplyCutM3Day, 0), floor)`
  and its `totalChangeM3Day` `MAX(reduce/gain + ewrSupplyCutM3Day, floor −
  supplied)`. `DEMAND_PCT_FLOOR_M3_DAY` (1 m³/day) and
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
- `summary.unitRain` (engine ≥ 1.78.0, only under `settings.unitRain`
  `{ mode: 'perUnit' }`, [model.md §2.4h](./model.md)) is each land unit's
  forcing and GR4J balance: `{ mode, gaugeMapMm, gaugeMapSource, mapPeriod,
  units }`, one entry per land unit in node-id order with its `rule`
  (`unitGauge` | `gaugeMap` | `unitChirps` | `catchment`), `rainKey`,
  `factor` and `factorSource`, the MAP ratio and CHIRPS level, the run days
  by where their rain came from (`days`), and `rainMm`, `aetMm`, `flowMm`,
  `runoffM3`, `runoffCoefficient`. Such a run also carries, per land unit,
  the series `rain_unit` (mm) and `runoff_natural` (m³/day, before land
  cover), and `summary.runoff` is over the land units' areas.
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
  `ewrAttribution` (engine ≥ 0.17.0), `groundwater`, `landCover`, `allocations`, `operatingRules` (engine ≥ 1.32.0), `droughtRestriction` (engine ≥ 1.54.0, only with `settings.droughtRestriction`) and `assurance` (engine ≥ 1.34.0:
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
  Engine ≥ 1.70.0 adds `criteria.maxBlankDays` (7), the status `'setAside'`
  (a reading straight after an outage, more than 7 days blank or listed as
  missing, treated as missing: its window is its own day, and `usedMm` is the CHIRPS or forecast
  rain the run used there instead) and `outageDays` on each window (the
  outage's length for a set-aside or as-recorded outage reading, else
  `null`; absent on older runs).
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
| POST | `/projects/:id/runs/:runId/uncertainty/:uid/result` | `{ members: MemberResult[], coverage: RecordCoverage[] }`, or for a paired row `{ members: { index, metrics }[] }`. From engine 1.33.0 a member's `metrics` must carry `noFlowDays`, `ewrSiteDaysNotMet`, `unitDemandM3Day`, `unitSuppliedM3Day` and `reserveFdc` (`400` without them: a result is stored only on the engine it was started on, which always computes them) | `200 { ensemble }`, status `complete`, with the `summary` the server built. `422 { error: "the posted ensemble does not reproduce", details }` when the sample isn't the one the seed and options generate, or member 0 or one of the members the server re-runs (three, picked at random) differs; `403` for anyone but whoever started it; `409` when already stored (a row completes once) or started on another engine version | editor |

- `Ensemble = { id, runId, baselineId, baselineRunId, runoffModel, engineVersion, method, seed, members, options, status, accepted, summary, createdAt, createdBy, createdById, completedAt }`.
  `createdBy` and `createdById` are `null` once the starter's account is
  deleted (138; a started ensemble goes with the account).
  `summary` is `EnsembleSummary` (`total`, `accepted`, `gated`,
  `referenceAccepted`, `rejected` by reason, `bands`, `coverage`,
  `coverageWarning`, `decisionRule`, `notes`) or, for a paired row,
  `PairedSummary` (difference bands, `ewrDaysNotMetWorse`, `shortfallWorse`,
  `unpaired`, `decisionRule`; from engine 1.33.0 also `noFlowDays` with
  `noFlowDaysWorse`, `ewrSites[]` and `supply[]` each with `worse`,
  `reserveFdc[]` and `carriesMeasures`, and `reserveFdcChange[]`: per site,
  12 water-year months × the table's points of `{ band, worse }`, the paired
  change in the Reserve FDC check curve, model.md §2.10e); `null` until
  complete. From engine 1.33.0 an `EnsembleSummary`'s `bands` also has
  `noFlowDays`, `ewrSites`, `supply` and `reserveFdc`; one stored before
  lacks them. A band is
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
| POST | `/projects/:id/scenarios` | `{ name, baseRunId, description?, purposeAndNeed?, mitigation?, monitoring?, ops?, ownedNodeIds? }` | `201 { scenario, check, checkError }` (below). The base must be a run of this project that stored its inputs: `404 base run not found` otherwise; `409` with `loadRunInput`'s reason for a run saved before stored inputs (`this run is not reproducible from stored inputs: …`), and `409 that run is a scenario run; base a scenario on a run of the model itself`, and `409` for a forecast run (WP-2.12: a scenario is judged on history). `409 this project already has a scenario with that name` (a team scenario's name is unique among the project's team scenarios, ignoring case; an application's among its owner's applications: `409 you already have an application with that name`, 049) | editor |
| GET | `/projects/:id/scenarios/:sid` | – | `{ scenario, check, checkError }` | viewer |
| PATCH | `/projects/:id/scenarios/:sid` | `{ name?, description?, purposeAndNeed?, mitigation?, monitoring?, ops?, ownedNodeIds?, status? }` (at least one) | `200 { scenario, check, checkError }`. `ops` replaces the whole list. The three answers to the evidence report's Appendix C prompts change on the description's terms, in any status (a submission doesn't freeze them; an issued pack keeps what it printed). `ops` and `ownedNodeIds` change only while the scenario is a `draft`: `409 this scenario is submitted, so its ops, owned nodes and base run can't change`. `status` moves `draft → submitted → withdrawn \| decided`, `withdrawn → draft`; any other move is `409` | editor |
| DELETE | `/projects/:id/scenarios/:sid` | – | `204`; its runs stay, with `scenarioId: null` but `fromScenario: true` (their snapshot keeps the ops: still scenario runs, never a base, the evidence or a publication; 188), and its base run stops being cited. `409` for a `submitted` or `decided` scenario, and for one with a signed-off run (the signed run keeps its scenario; 072) | editor |
| POST | `/projects/:id/scenarios/:sid/runs` | `{ label? }` (default: the scenario's name) | `201 { run, removedRunIds, applied, classified }`, as `POST …/runs`: `run` is `RunMeta & { summary }` with `scenarioId`. `422 { error: "an op of this scenario doesn't apply to its base run", details: { problems: string[] } }` when any op doesn't apply (a result with an op silently skipped would not be the scenario); `409` when the base can't be rebuilt; `409 this scenario changed while it ran (its ops or base run); run it again` when its ops, base run or owned nodes changed while the engine ran, and `404` when it was deleted (nothing is stored in either case; a rename doesn't count); `400 model run failed: …` as for any run | editor |
| POST | `/projects/:id/scenarios/:sid/rebase` | `{ baseRunId, dryRun? }` | `200 { scenario, applied, problems, classified }`: the ops re-applied to the other base; `problems` lists each op that no longer applies (`op 2 (node.set): node … not found`), or once for an edit group of `node.set` ops on one node that breaks a rule (`ops 2–4 (node.set, "Upper farm"): …`, [scenarios.md § Engine](./scenarios.md#engine-applyscenario)). Saves the new base (the ops are kept as they are, so a run is refused until they apply) unless `dryRun: true`. Same base checks as `POST`; `409` when the scenario isn't a draft (not for a dry run) | editor |

- `Scenario = { id, name, description, purposeAndNeed, mitigation, monitoring,
  baseRunId, baseRun: { id, label, createdAt }, ops: ScenarioOp[], opsSha256,
  ownedNodeIds, opNames, ownerUserId, owner, status, createdAt, updatedAt,
  runCount, lastRun: { id, label, createdAt } | null }`. `ownerUserId` and
  `owner` are `null` once the owner's account is deleted (138: a team scenario
  and a submitted, withdrawn or decided application stay; a draft application
  goes with the account). `purposeAndNeed`,
  `mitigation` and `monitoring` (129_scenario_statement) are the answers to the
  evidence report's fixed Appendix C prompts (engine `APPLICANT_PROMPTS`), `''`
  until answered; the API trims each (whitespace alone is `''`) and holds it to
  4 000 characters (`400`) without NUL. Whoever may change the scenario writes
  them; whoever reads it reads them. `opsSha256` is the SHA-256 hex of the ops as RFC 8785
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
  scenario. `reIds: { kind: 'crop' | 'transfer' | 'landCover' | 'borehole' | 'allocation' | 'demandObject',
  id, as }[]` (the same readers) lists the items an application added under
  the id of one its applicant can't see, and the fresh id each has in its
  runs; always `[]` for a team scenario.
  An application's check also carries `maskedRules: { problem, ops, rules }[]`
  (164, every reader): each problem line a rule hidden from its applicant
  broke, its index in `problems`, the ops it names (0-based) and the rules'
  kinds (`shares`, `area`, `supplyTrigger`, `bhEmergency`…; never an id, a
  name or a value), and, to editors and up only, `assessorProblems:
  string[]`: `problems` line for line with every rule in its real words and
  hidden names restored. A contributor never receives `assessorProblems`.
  Neither field is on a team scenario's check. A submit refused for problems
  (`422`) carries `details.maskedRules` beside `details.problems`.
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
  'licence_issued' | 'licence_refused' | 'application_rejected' |
  'not_considered' | null` (since 163; a decision recorded before it was
  mapped, `approved` and `approved_with_conditions` to `licence_issued`,
  `refused` to `licence_refused`), `decisionNote`, the authority's record
  `decisionAuthority` (its name, `null` until decided; `"Not recorded
  (before 163)"` on an older decision), `decisionDate` (`YYYY-MM-DD`, the
  date on its decision letter, `null` before 163), `decisionReference` (its
  licence or file reference, `''` = none) and `reasonsReceived` (`boolean`,
  `null` before 163), and `members: { userId, displayName }[]`; `baseRun.label` is
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
| POST | `/projects/:id/scenarios` | `{ name, baseRunId, description?, purposeAndNeed?, mitigation?, monitoring?, ops? }` | as above. A contributor's `baseRunId` must be a published run (current or in the history): `404 published run not found` otherwise, as if it didn't exist; `409` when that published run is a forecast run (as for a team scenario). `ownedNodeIds` are their farm links (sending any is `403`) | contributor (a viewer: `403`) |
| PATCH | `/projects/:id/scenarios/:sid` | `{ name?, description?, purposeAndNeed?, mitigation?, monitoring?, objectionAddress?, objectionClosingDate?, ops? }` | as above; only the owner (`403` for anyone else, the assessors included). `objectionAddress` (≤ 500, trimmed, `''`/`null` clears) and `objectionClosingDate` (`YYYY-MM-DD` or `null`): where and by when written objections go, as the application's notice gives them (166_public_participation; GN R267 reg 17(4)(b)(vi)–(vii)); only while a draft (`409` once submitted); every share page prints them beside the warning that a comment is not an objection. `status` is `409` on an application (use the routes below), `ownedNodeIds` `403` | owner of the application |
| DELETE | `/projects/:id/scenarios/:sid` | – | `204`, a draft or withdrawn one; its runs that nothing keeps go with it | owner of the application |
| POST | `/projects/:id/scenarios/:sid/runs` | `{ label? }` | as above; for a contributor `run` is metadata only (`id, label, engineVersion, startDate, endDate, createdAt, scenarioId`: the summary names every farm) and the application keeps its newest 5 runs | its owner or a shared member, or an editor; not a viewer |
| POST | `/projects/:id/scenarios/:sid/rebase` | as above | as above; a contributor's new base must be published | owner of the application |
| POST | `/projects/:id/scenarios/:sid/submit` | – | `200 { scenario, check, checkError }`: `draft → submitted`, the ops (and their hash), base and own nodes frozen. `422` with `details.problems` when any op doesn't apply; `409` unless a draft | its owner (a team scenario: an editor) |
| POST | `/projects/:id/scenarios/:sid/withdraw` | – | `submitted → withdrawn`; `409` otherwise | its owner (team: an editor) |
| POST | `/projects/:id/scenarios/:sid/reopen` | – | `withdrawn → draft`; `409` otherwise | its owner (team: an editor) |
| POST | `/projects/:id/scenarios/:sid/decide` | **Record the authority's decision** (163_licensing_authority; provisional position, pre-counsel research, 2026-10-01): `{ outcome: 'licence_issued' \| 'licence_refused' \| 'application_rejected' \| 'not_considered', authority?: ≤ 200, decisionDate: 'YYYY-MM-DD', reference?: ≤ 200, reasonsReceived: boolean, note?: ≤ 4000 }` (`authority` omitted: the project's `settings.responsibleAuthority.name`, `400` when it names none; `decisionDate` a real date, not after tomorrow) | `submitted → decided`, with `decidedAt` (the app's stamp), `decidedBy` and the record above; final. `403` unless the caller acts for the responsible authority (an editor or owner the owner marked, `actsForAuthority`), and for the application's own owner; `409` unless submitted; `409` `run_unverified` while any of its runs doesn't verify (security.md § Run stamps). Every single-scenario answer (`GET`, `PATCH`, the status moves) carries `unverifiedRunIds`: an application's runs that don't verify, to an editor or owner (`null` for a team scenario or a lower role) | editor acting for the authority |
| GET | `/projects/:id/scenarios/:sid/share-candidates` | – | `{ candidates: { userId, displayName }[] }` (049): whom the owner may share it with. For a contributor, the other contributor-or-above members of their own applying party (`project_member.party`, set by the project owner); nobody without a party. For a viewer and up, every contributor-or-above member. Names only. `409` for a team scenario | owner of the application |
| POST | `/projects/:id/scenarios/:sid/members` | `{ userId }`, or `{ email }` for a viewer and up | `201 { members }` (`200` if already shared). `{ userId }`: `404 not someone you can share this application with` for every id not among the candidates, a member or not. `{ email }` from a contributor: `403`, whatever the address (an applicant never probes an address); from a viewer and up, `404 no contributor or above on this project has that address` for an unknown address, a non-member or a farmer alike. `409` for a team scenario or yourself | owner of the application |
| DELETE | `/projects/:id/scenarios/:sid/members/:userId` | – | `204`; the owner removes anyone, a member removes themselves | owner, or that member |
| GET | `/projects/:id/scenarios/:sid/results?runId=` | – | `{ run, results }`: one run of the application (the newest by default; `{ run: null, results: null }` before any) as its applicant sees it against its base (below). `run`: `id, label, engineVersion, startDate, endDate, createdAt, baseRunId, current` (`current`: made from the ops and base the application has now). `404` for a run that isn't one of its runs or an application the caller doesn't read; `409` for a team scenario (the compare page compares those), or when the run's base is no longer a published run | any reader of the application (contributor and up) |
| GET | `/projects/:id/applications` | – | `{ applications: Scenario[] }`: every application not a draft, newest submission first | editor |
| POST | `/projects/:id/scenarios/:sid/questions` | `{ problem: int, line: string }` (strict) | `201 { question }`, the parties' view below: "Ask the assessors why" (164) about problem line `problem` of the application's check, quoting it as the caller read it. `409` when the check's line is no longer `line` (read it again), or for a team scenario; `422` when no hidden rule broke that line; `409` past 50 questions on one application; `403` for a reader who isn't one of its parties (its owner or someone it is shared with); `404` for an application the caller can't read | a party of the application |
| GET | `/projects/:id/scenarios/:sid/questions` | – | `{ questions }`, newest first. A party: `{ id, askedAt, problem, opIndexes, rules, answer, answeredAt }` (`app_application_questions`: never the real words or the ops). An editor: also `scenarioId, scenarioName, ops, assessorText`. `404` for anyone else | a party, or an editor |
| GET | `/projects/:id/application-questions` | – | `{ questions }` (the editors' shape above), unanswered first, then newest, at most 200: every application's questions, drafts' included (the draft itself stays its applicant's) | editor |
| POST | `/projects/:id/application-questions/:qid/answer` | `{ answer: 1–4000 }` (strict) | `200 { question }`; once (`409` when answered). `404` for no such question | editor |

- **"Ask the assessors why"** (164, [scenarios.md § Applications](./scenarios.md#applications-wp-33)):
  an application with a problem a hidden rule broke can't be submitted, and
  the assessors never read a draft, so its parties ask through
  `…/questions` instead of a note. The question holds the line as they read
  it, the ops it names as they stood, the rules' kinds, the application's
  name and the line in its real words (written by the server; only editors
  read it). The audit trail records `application.question_asked` and
  `application.question_answered` (ids, op indexes and the rules' kinds;
  never the words).
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
- **What a contributor sees of a run** (`…/results`, 118; D2's default,
  pending the client; [scenarios.md § Applications](./scenarios.md#applications-wp-33)):
  `results = { allProposals, ewrSites, catchment, units, downstream,
  unitsWithheld, model }`. `ewrSites[]`: each EWR site (`name` null for the
  outlet, a gauge's name, else the anonymous one) with `base` and
  `application` `{ months, met, rate, longestNotMetRun, deficitM3 }`.
  `catchment`: `ewrDaysNotMet` and `ewrFractionDaysNotMet` `{ base,
  application }` always; `figures` (mean natural flow and outlet flow, base
  and application) and `series` (`{ outflow, ewr }`, the outlet's daily
  series, base and application) only when every op was a proposal, else
  null with `withheld: 'baseline_assumptions'`. Within them the k rule is
  split (164): natural flow and the `ewr` series at any holder count; the
  outlet flow (`meanSimulatedOutflowM3Day`), the `outflow` series and every
  `deficitM3` only at five or more farm holders, else null with
  `withheld: 'few_farm_holders'`. `units[]`: their own units
  (their farm links as they read them now) and the ones the ops add
  (`added`), `{ nodeId, name, kind, base, application }` with demand,
  supply, share met, EWR charge and dam figures. `downstream[]`: every other
  farm or water user below those units, `{ nodeId, name, kind,
  supplyChangePct }`: the anonymous name `…/base` gives it and the change in
  its mean supply as a whole percentage (null when it had none in the
  base). `units` and `downstream` are `[]` with `unitsWithheld:
  'baseline_assumptions'` when an op was a baseline assumption. `model`:
  what ran on their units (nodes, crops, crop areas, transfers, land cover,
  boreholes, demand objects), an item an op added under a hidden item's id
  shown by that id (the run holds it under a fresh one, `check.reIds`).
- A contributor linked to a farm also reads its farm view
  (`GET /projects/:id/farm…`) as a farmer would.

## Evidence report

The licensing evidence report of a run (issue #71, WP-2.15 Phase C "evidence
mode"; design [design/evidence-report.md](./design/evidence-report.md), layout
[ui.md § Evidence report](./ui.md#evidence-report)).

| Method | Path | Body | Returns | Role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/evidence-report` | – | `{ report: EvidenceReport }` (engine `packages/engine/src/evidence/types.ts`, version `evidence-15`: § 5 lists only the applicant's own units one by one and every other unit in one total per water source, `allocations.units[]` with `nodeId: 'others:<source>'`, `name` "Other registered users (n units)" and `aggregate: n`, left out (counted in `allocations.othersLeftOut`) below 5 units; `allocations.unitYears` `{ overA, judgedA, overB, judgedB }` the page-1 row's per-unit counts; absent from a pack's report drafted before `evidence-15` (`evidence-15`); page 1's headline board against full authorised use, `licenceImpactAuthorised` `{ status: 'ok' \| 'notBuilt' \| 'noAllocations' \| 'stale', detail, board, mix: { rows: [{ authorisation, volumeM3PerYear, entitlement }], entitlementM3PerYear, totalM3PerYear } \| null, builtAt, engineVersion }` (the board an editor's `POST …/authorised-impact` kept for this application run, when it was run on the baseline's engine with the project's outcome settings as they are now; otherwise why not; null for baseline evidence; absent from a pack's report drafted before `evidence-14`; [evidence-pack.md § Both impact bases](./evidence-pack.md#both-impact-bases)) (`evidence-14`); the identity block's `identity.authority` `{ name, kind: 'dws' \| 'cma', office } \| null` (the project's `settings.responsibleAuthority`) and `identity.baseline.endorsement` `{ endorsedAt, endorsedBy, note } \| null` (the newest endorsement of a publication of the baseline run), with the page-1 caution `flags[id=notEndorsed]` without one; both absent from a pack's report drafted before `evidence-13` (163_licensing_authority, [evidence-pack.md § The responsible authority](./evidence-pack.md#the-responsible-authority)) (`evidence-13`); § 1's locality map, `localityMap` `{ version: 'locality-1', applicant, features: [{ layer, label, geometry }], asOf, sources: [{ fileName, sha256, importedAt }], drawnInApp, svgSha256 }` (the project's map features as the reader reads them now, `layer` one of `boundary`, `parcel`, `dam`, `applicantParcel`, `applicantDam`, `river`, `gauge`, `ewrSite`; another unit's parcel or dam has `label: null` and no node; geometries at 6 decimals, simplified to the figure; `svgSha256` the SHA-256 of the engine's `localityMapSvg` of it; null with no map features; absent from a pack's report drafted before `evidence-12`; [evidence-pack.md § The locality map](./evidence-pack.md#the-locality-map)) (`evidence-12`); page 1's row over the other applications reads one combined run from a cumulative assessment, `cumulative.combined` (below; absent from a pack's report drafted before `evidence-11`, whose row is the sum) (`evidence-11`); the checks `pumpCapacity` (every river pump, other water user and off-take in either run has a capacity) and, for an application, `protectsEwr` (its own new or changed river abstraction leaves the EWR or a hands-off flow in the river in every month it takes), both `blocksIssue`, read from the runs' stored models ([evidence-pack.md § What stops issue on the river](./evidence-pack.md#what-stops-issue-on-the-river); absent from a pack's report drafted before `evidence-10`) (`evidence-10`); § 6 the applicant's demand objects, `demandObjects` `{ notAssessed, objects, bySource, demandM3Day }` (each object on the applicant's units, or that the application adds, changes or removes: `{ id, name, nodeId, unit, category, change: 'added' \| 'changed' \| 'removed' \| 'unchanged', enabled, sizing, monthlyM3Day, count, litresPerUnitDay, lossPct, priority, destination, source, note, demandA, demandB, suppliedB }`, the model's fields as the application ran it, the baseline's for one it removes, each run's mean demand from its summary; `bySource` the application's demand by source, `{ source, demandM3Day, share, objects }`, the engine's `demandSourceShares`, not recorded as `source: null`; null for baseline evidence; absent from a pack's report drafted before `evidence-9`), with the page-1 caution `flags[id=demandSource]` when less than half of it is from meter records (`evidence-9`); Appendix C's fixed prompts, `applicantStatement.prompts` `{ purposeAndNeed, mitigation, monitoring }` (the scenario's answers as it holds them, `''` for *Not given*; absent from a pack's report drafted before `evidence-8`) (`evidence-8`); § 1's paired change in each Reserve site's FDC check curve, `river[].fdcChange` (per calendar month, one `{ run, band, bandNote, worse }` per table point; null for baseline evidence or without a paired band on the curve; `evidence-7`); § 5's cap per unit and source, `allocations.units[].sources[].capA` / `capB` (`{ capReached, limitBound }` from each cap run's `RunSummary.allocations`, null when that run doesn't cap the source; `evidence-6`); page 1's licence impact by year class, `licenceImpact` (null for baseline evidence), built from the runs' stored `natural_flow` and `ewr_shortfall` and the project's `settings.outcomes` (`evidence-5`); § 5 registered water use, `allocations` (`evidence-2`); each Reserve site's driest month, `river[].fdcDriestMonth`, and the other applications on the baseline, `cumulative` with its page-1 row `otherApplications` (`evidence-3`); the page-1 rows `noFlowDays` and `ewrBelowWorks`, supply bands (`users[].change`), `servedWhileFailing` and `river[].fdcBands` (`evidence-4`, engine 1.33.0)) | viewer |
| POST | `/projects/:id/runs/:runId/authorised-impact` | none, or `{}` (strict) | `200 { authorised }` (the `licenceImpactAuthorised` above, `status: 'ok'`): runs the application run's baseline and its recorded ops with every holder at their registered volume (`settings.allocationMode: 'fullAllocation'`), builds page 1's board over the pair and the authorised volumes' mix by `authorisation`, and keeps it (`authorised_impact`, replacing the run's older one); the two runs aren't stored. Synchronous, as a scenario run is. `409` for a run that isn't an application run, a baseline that ran with no registered volumes, a baseline on another engine than the server's (run it again first), or ops that don't apply at full allocation (`details.problems`, in their real words); `404` for a run the caller can't read. Licensing build item 8 | editor |

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
  members, with the scenario's own units for the applicant's supply band
  (`ownSupply`), so `reserve[].worse` is there for bands stored before it
  existed),
  the input diff (`diffInputs` with stored values, as compare), the revisions
  since the previous publication, up to 50 other scenario runs on the same
  baseline, the other applications on the baseline (below), and the engine's
  methodology, limitations and errata.
- **Other applications on the baseline** (`cumulative`, § 4): every other scenario that is
  submitted, or decided `licence_issued` (`approved` / `approved_with_conditions` in a pack drafted before `evidence-13`), with its
  newest run of its current ops (`inputs.scenario.opsSha256` equal to the
  scenario's) on this baseline, the newest 50 (with more, `cumulative.truncated` and nothing is summed). Read under the reader's RLS, so a
  viewer's report lists no submitted application (editors read those) and
  nobody's lists a draft. Only `summary.catchment.ewrDaysNotMet` and the
  outlet's Reserve `overall` leave the database, not the runs. The engine
  lists each one's own change against the baseline and sums those of the same
  engine, period and runoff model (any other difference is the application's own ops): a sum of separate runs, not one combined
  run. A document since `evidence-11` doesn't print that sum.
- **All of them together** (`cumulative.combined`, `evidence-11`, page 1's
  *This and the other applications on this baseline, together*, row id
  `otherApplications`): `{ applications: { scenarioId, scenarioName, status,
  outcome, isThis, ewrDays, reserveMonths }[], assessment: { id, name,
  createdAt, createdBy, engineVersion } | null, conflicts, problems, ewrDays,
  reserveMonths, warnings, notAssessed }`, each measure `{ baseline,
  combined, change, sumOfSingles, interaction }` at the outlet. The
  applications are this one and every other the reader sees that is
  submitted or decided with approval and based on this baseline (no run
  needed); the figures come from the newest complete assessment (editors
  only, RLS) of exactly those scenarios with their current ops
  (`assessment_member.ops_sha256`; this application's by the ops its run
  recorded) on this baseline. Without one the backend checks the
  combination (`checkCombination`, no model run): conflicts and ops that
  don't apply together make it *Not assessed*, naming each; else it says an
  assessment is under way, or that none exists. More than 8, or this
  application not submitted, is *Not assessed* too
  ([evidence-pack.md § The other applications together](./evidence-pack.md#the-other-applications-together)).
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
(roadmap WP-3.14, issue #71, migrations 112 and 122; [evidence-pack.md](./evidence-pack.md)
covers the manifest, the hash, the short code, the lifecycle and the
reproduction bundle).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/packs` | `{ runId, supersedesId? }` (strict) | `201 { pack: Pack }`, a draft. `runId` names the report as for [Evidence report](#evidence-report): a scenario run (an application pack) or the nominated run (baseline evidence). `409` with `details.checks` (`{ id, label, detail, fix }[]`) when the report is refused or a check that blocks issue fails (among them, since `evidence-10`, `pumpCapacity` and `protectsEwr`); `404` for a run or a `supersedesId` the caller can't see in this project; `409` when `supersedesId` isn't an issued pack, or is of another application (or of an application, for a baseline pack) | editor |
| GET | `/projects/:id/packs` | – | `{ packs: Pack[] }`, newest first, at most 200. No manifest | viewer |
| GET | `/projects/:id/packs/:packId` | – | `{ pack: Pack, manifest: PackManifest, manifestMatches, signoffs: Signoff[], pdf: PackPdfState, reproduction: PackReproductionState, issue, errataFoundSince }`. `manifestMatches`: the stored manifest still hashes to `manifestSha256`. `errataFoundSince` (`{ id, summary }[]`, 132): as on verify (below), the errata that apply now to either run's engine or its fit's and that the manifest didn't record (on a draft, found since it was drafted). `pdf`: where its PDF is (below). `reproduction`: what the server's re-run of its runs from the stored bundle found (below; not on verify). `issue` (a draft, to an editor; else `null`): `{ issuable, signed, runsVerified, errataRecorded }` (`errataRecorded`: `errataFoundSince` is empty), what stands between it and its issue as stored (the issue route checks the live report too) | viewer |
| DELETE | `/projects/:id/packs/:packId` | – | `204`. `409` for a pack past draft (withdraw it) and for a signed draft (withdraw it: a sign-off is kept) | editor |
| GET | `/projects/:id/packs/:packId/signoffs` | – | As the run's (below), with the pack statement: `{ statement: PackSignoffStatement, statementSha256, disclaimer, cannotSign, kinds, signoffs }`. `cannotSign` adds `only a draft pack is signed; this one is <status>`. `kinds` (167): what the caller may sign as, `['specialist', 'review']` for an editor, `['specialist']` for the application's appointed specialist, `[]` otherwise. Each sign-off carries `kind` and `registrationCheck` (`{ checkedAt, checkedByOrg, bound }` or `null`: self-declared). Below viewer, only the application's appointed specialist (`403` for anyone else) | viewer; contributor (the specialist) |
| POST | `/projects/:id/packs/:packId/signoffs` | as a run's sign-off, plus `kind?: 'specialist' \| 'review'` (default `specialist`) | `201 { signoff }` (`runId: null`, `packId`). The same `400`s, `403`s and `409`s as a run's, and `409` for a pack that isn't a draft. `review` is an editor's (`403` for the specialist). Needs a code from the last 10 minutes (`401 mfa_fresh_code`) | editor; contributor (the application's appointed specialist) |
| GET | `/projects/:id/registration-checks` | – | `{ checks: RegistrationCheck[], required }` (167): the host's checks of members' registrations against the public SACNASP / ECSA register, newest first (`{ id, userId, registrationBody, registrationCategory, registrationNo, registerName, outcome: 'registered' \| 'not_registered', checkedByOrg, checkedAt, note, recordedBy, recordedAt }`); `required`, the owner's setting that issue waits for them | editor |
| POST | `/projects/:id/members/:userId/registration-checks` | `{ registrationBody, registrationCategory, registrationNo, registerName, outcome, checkedByOrg, checkedAt (date or date-time, not in the future), note? }` | `201 { check }`. Insert-only; a later check supersedes. `404` for someone who isn't a member. Audited as `registration.checked` | owner, or an editor acting for the responsible authority (163); either with two-step sign-in (403 `mfa_required` / `mfa_step_up`) |
| PUT | `/projects/:id/registration-check-required` | `{ required: boolean }` | `{ required }`: whether issuing a pack waits until each specialist signer has a current check (on by default). Audited as `registration.requirement` | owner |
| POST | `/projects/:id/packs/:packId/issue` | none, or `{}` (strict) | `200 { pack, pdf: { status: 'rendering', error: null } }`, issued; a new version's predecessor becomes `superseded` in the same transaction, and its PDF's render (a `pack_render` job, as the issuer) is queued in it too ([evidence-pack.md § The PDF](./evidence-pack.md#the-pdf)), as is the server's re-run of its runs from the bundle (a `pack_reproduce` job, [evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)), and so are the "pack issued" emails to the other editors and the application's owner ([evidence-pack.md § Notices](./evidence-pack.md#notices)). The pack's reproduction bundle is built, checked, stored and recorded in the same transaction (`pack.bundleSha256`; [evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)): if the bundle can't be stored the request fails (`500`) and nothing is issued. `409` when: it isn't a draft; another pack of the same application (or baseline evidence) is issued and this one doesn't supersede it (one issued at a time: draft a new version instead); the stored manifest no longer hashes to its hash; the frozen or the live report can't be issued (with `details.checks`); there is no sign-off of the current pack statement; the predecessor is no longer issued; a run's stored inputs can't rebuild it (a run from before stored inputs, or one that fails its hash check). `409` `run_unverified` when either run's server stamp no longer matches. `409` `pack_errata_since_draft` when an erratum found since the draft was made applies to either run's engine or its fit's and the manifest doesn't record it (the pack's `errataFoundSince`; draft it again, which records it) | editor |
| POST | `/projects/:id/packs/:packId/reproduce` | none, or `{}` (strict) | `202 { jobId, reproduction: PackReproductionState }`: re-runs an issued pack on the server again from its stored bundle, as the caller (a `pack_reproduce` job, [evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)): after the last re-run gave up, or on a newer engine than the recorded outcome's, which is kept and the new engine's recorded beside it. Idempotent while one is pending: the pending job's id comes back and nothing more is queued. `409` for a pack never issued, and once an outcome is recorded on the server's engine (one per pack and engine stands). Contributors and farmers `403`, a stranger `404` | editor |
| POST | `/projects/:id/packs/:packId/send` | `{ userIds?: uuid[] (1–20), note?: ≤ 1000 }` (strict) | `200 { recipients: { userId, displayName }[], sent, failed }`: emails the members acting for the responsible authority (163's `actsForAuthority`, editors and owners; all of them but the caller, or `userIds`) a link to the pack's page and its verify page, never a file or a download link ([evidence-pack.md § Sending it to the authority](./evidence-pack.md#sending-it-to-the-authority)); records `pack.sent`. `409` unless the pack is issued, or when no other member acts for the authority; `422` when a `userIds` entry isn't one of them; `404` for a pack of another project | editor |
| GET | `/projects/:id/packs/:packId/bundle` | – | `302` to a one-minute signed GET of the pack's reproduction bundle (a pre-signed MinIO URL locally; a CloudFront signed URL on the site's `/packs/*` in production), downloaded as `pack-<shortCode>.zip`; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. Its bytes hash to `pack.bundleSha256`. `409` for a draft (built at issue) or a pack issued without one. Check it with `pnpm reproduce:pack` | viewer |
| GET | `/projects/:id/packs/:packId/pdf` | – | `302` to a signed URL of the pack's PDF, valid 60 s (a pre-signed MinIO GET locally, a CloudFront signed URL on `/packs/*` in production), named `<catchment>-evidence-pack-v<N>-<short code>.pdf`; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. `409` while none is recorded (a pack never issued, or its render not done). Contributors and farmers `403`, a stranger `404` | viewer |
| POST | `/projects/:id/packs/:packId/pdf` | none, or `{}` (strict) | `202 { jobId, pdf: { status: 'rendering', error: null } }`: asks again for the PDF of a pack that was issued and has none recorded (its last render failed, or its answer never came). One pending per pack. `409` for a pack never issued, and once a PDF is recorded (a pack is printed once) | editor |
| POST | `/projects/:id/packs/:packId/withdraw` | `{ reason }` (1–1 000) | `200 { pack }`, withdrawn, from draft, issued or superseded; for a pack that was issued, the "pack withdrawn" emails (with the reason) are queued in the same transaction ([evidence-pack.md § Notices](./evidence-pack.md#notices)). `409` when already withdrawn | editor |
| GET | `/verify/:code` | – | **Public.** `{ pack: PackVerification }` for the short code (`xxxx-xxxx-xxxx`, any case, dashes optional) or full manifest hash of a pack that was issued. `404` alike for a malformed or unknown code, a draft, and a pack withdrawn before it was issued. `Cache-Control: no-store` | none |

- `Pack = { id, title, mode: 'application' | 'baseline', scenarioId,
  baselineRunId, scenarioRunId, version, supersedesId, supersededById,
  status: 'draft' | 'issued' | 'superseded' | 'withdrawn', manifestSha256,
  shortCode, verifyPath, reportVersion, engineVersion, pdfSha256, pdfPages,
  bundleSha256, createdAt, createdBy, issuedAt, issuedBy, statusReason,
  signoffs }`. `title` is the report's (the scenario's name, or the
  project's); `createdBy` and `issuedBy` are display names (null once the
  account is deleted); `verifyPath` is the web page's `/verify/<shortCode>`;
  `signoffs` is a count. `pdfSha256` and `pdfPages` are set once, when the
  PDF is recorded (119_pack_render); `bundleSha256` when the pack is issued
  (122_pack_bundle; null on a draft).
- `PackPdfState = { status: 'ready' | 'rendering' | 'failed' | 'none',
  error }`: `ready` once the PDF is recorded; `rendering` while its render
  job is queued, running, retrying or waiting for the renderer's answer;
  `failed` when the last render gave up (`error` says why; an editor asks
  again with `POST …/pdf`); `none` for a pack never issued.
- `PackReproductionState = { status, engineVersion, runEngines, checkedAt,
  checks: { id, ok, detail }[], error, serverEngine, canRerun }`
  (154_pack_reproduce): a recorded outcome, `reproduced`, `not_reproduced`,
  `other_engine` (only the re-runs differ, on another engine than the runs')
  or `no_bundle`, with the engine that re-ran the runs, theirs, when, and
  every check; else `checking` while a job is queued, running or retrying,
  `failed` when the newest job gave up after the newest outcome (`error`
  says why), or `none` (a draft, or a pack issued before re-runs). The
  newest outcome stands. `serverEngine` is the engine this server re-runs
  with; `canRerun`, whether an editor may ask again (`POST …/reproduce`):
  issued, none pending, and no outcome on `serverEngine` yet.
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
  engineVersion, reportVersion, manifestSha256, shortCode, pdfSha256 (null
  until the PDF is recorded), bundleSha256,
  successorSha256, withdrawnReason, methodology: { version, sha256 },
  errata: { id, summary }[], errataFoundSince: { id, summary }[], signers: { fullName, registrationBody,
  registrationCategory, registrationField, registrationNo, signedAt, kind,
  registrationCheck }[] }`, and nothing else (`kind` 167: `specialist` or
  `review`; `registrationCheck`: `{ checkedAt, checkedByOrg }` bound at
  issue, or `null`: self-declared) (`app_verify_pack`, mapped field by field; security.md § Evidence packs).
  `errata` is what the manifest recorded when the pack was drafted, never
  changed; `errataFoundSince` (132) lists the errata of the current list
  (engine-errata.md) that apply to either run's engine, or to the engine of
  the automatic fit its parameters came from, and aren't among `errata`:
  found since issue ([evidence-pack.md § Verification](./evidence-pack.md#verification)).
### An applicant's packs

An application's parties (its owner, and whoever they shared it with) read
its packs that were issued, as the database projects them for them
(131_applicant_packs, D2's default; [evidence-pack.md § Applicants](./evidence-pack.md#applicants)).
They read no pack row, so the routes above answer them `403`.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/scenarios/:sid/participation-export` | `?format=json` (default) or `csv` | The application's public participation record for its reg 19 report (166): `{ application: { id, name, status, submittedAt, decidedAt, outcome, objectionAddress, objectionClosingDate }, links: [{ target, packVersion, createdAt, expiresAt, revokedAt }], comments: [{ id, target: 'application' \| 'pack', packVersion, author, email, registerConsent, viaLink, createdAt, editedAt, state: 'shown' \| 'withdrawn' \| 'removed', deletedAt, body, revisions }], register: [{ name, email }] }`, `Cache-Control: no-store`; the CSV is one row per text (`comment_id,on,text_version,text_written_at,posted_at,author,email,register_consent,posted_through,state,text`). `email` only where the commenter ticked the reg 18 box; a withdrawn or removed comment's `body` and `revisions` to the editors only. For the application's owner and the editors who read it; anyone else `404`. Audited as `scenario.participation_exported` | contributor (owner of the application) |
| GET | `/projects/:id/scenarios/:sid/packs` | – | `{ packs: ApplicantPackMeta[], toSign: SpecialistDraft[] }` (`toSign`, 167: the drafts the caller may sign as the application's appointed specialist, `{ id, title, version, manifestSha256, createdAt, signoffs }`, empty for anyone else), newest version first: its issued, superseded and withdrawn-after-issue packs, never a draft. `404` for a scenario the caller can't read; `[]` to anyone who reads it but isn't a party (an editor reads the packs through `GET …/packs`) | contributor |
| GET | `/projects/:id/scenarios/:sid/packs/:packId` | – | `ApplicantPack` (below); `Cache-Control: no-store`. `404` alike for a pack that isn't theirs, isn't of this application, is a draft or was never issued | contributor |
| POST | `/projects/:id/scenarios/:sid/packs/:packId/pdf` | none, or `{}` (strict) | Their printable copy (165_applicant_copy, [evidence-pack.md § Applicants](./evidence-pack.md#applicants)): `202 { copy }` with `copy.status: 'rendering'` after queuing an `applicant_pack_render` job as the caller (one pending per pack and party), or while one is; `200 { copy }` once recorded (it stands: asking again changes nothing). `404` alike as above | a party of the application |
| GET | `/projects/:id/scenarios/:sid/packs/:packId/pdf` | – | `302` to a one-minute signed GET of the copy, downloaded as `evidence-pack-v<n>-<code>-applicant-copy.pdf`; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. `409` until it is recorded; `404` alike as above | a party of the application |

- `ApplicantPackMeta = { id, scenarioId, title, mode, version, status:
  'issued' | 'superseded' | 'withdrawn', issuedAt, manifestSha256,
  shortCode, verifyPath, supersedesId, supersededById, withdrawnReason,
  isOwner, canShare }`. `isOwner`: the caller owns the application (they
  list and revoke the links they made); `canShare`: they may make a link to
  it now (the owner, while it is issued).
- `ApplicantPack = { pack: ApplicantPackMeta, verify: PackVerification,
  figures, units }`. `figures` is exactly a pack link's
  ([Share](#share), `POST /share/pack`), for every standing. `units` is
  `{ own: { name, kind, onlyIn: 'application' | null, suppliedA, suppliedB,
  timeReliabilityA, timeReliabilityB, annualReliabilityA,
  annualReliabilityB, change: { run, band, worse } | null }[], others: {
  kind: 'farm' | 'user', name, changePts }[] | null }`, or `null` when the
  report changed a baseline assumption. `own`: the units the pack froze as
  the applicant's (the report's own units within the application's stored
  own nodes, whatever the owner links now; 164) and the nodes it adds;
  `others`: the other
  farms and water users downstream of those in the application run, as the
  results view lists them (`GET …/results` `downstream`), under the same
  anonymous `name` ("Farm 3", as on `…/base`), in its order, with
  `changePts` their change in share of demand supplied in whole percentage
  points; `null` when the run's base is no longer a published run, so those
  names can't be given. Never another unit's real name or id. `copy:
  { status: 'ready' | 'rendering' | 'failed' | 'none', sha256, pages,
  renderedAt, error }`: their printable copy (165), with its own SHA-256
  once ready; `failed` gives why their last request gave up.
- No PDF, manifest or bundle of the pack: each carries the whole report.
  Their printable copy instead (above): the same view, printed as them, not
  the pack.

- A pack cites both its runs (`citedBy` kind `pack`, name `version N`): they
  can't be deleted or trimmed, and the scenario can't be deleted. A project
  with a pack past draft can't be deleted (`409`, [Projects](#projects)).
- Each step is in the history: `pack.drafted`, `pack.deleted`,
  `pack.issued` (with `bundleSha256`), `pack.superseded`, `pack.withdrawn`,
  and `signoff.created` with `packId`.

## Sign-offs

A registered professional signs a run (roadmap WP-3.13, migration 036;
[data-model.md § Sign-offs](./data-model.md#sign-offs-036_signoffsql)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/runs/:runId/signoffs` | – | `{ statement, statementSha256, disclaimer: { version, status }, cannotSign, signoffs: Signoff[] }` (oldest first). `cannotSign` is why the caller can't sign (`requires editor role`, or the legacy-run reason, or the forecast-run one, WP-2.12, or the unverified-run one, security.md § Run stamps), `null` when they can | viewer |
| POST | `/projects/:id/runs/:runId/signoffs` | `{ fullName, registrationBody: 'sacnasp' \| 'ecsa', registrationCategory, registrationField, registrationNo, scope, confirmed: string[], statementSha256 }` | `201 { signoff }`. `400` for a category or field that isn't one of the body's, and for a candidate, certificated or specified category, with the reason (a candidate works under a professional's supervision, so the supervising professional signs); `409` when `statementSha256` isn't the current statement's (it changed since it was shown: read it again); `400` when a confirmation id is missing from `confirmed`; `409` for a legacy run (a stored run from before engine 1.0.0, which removed that model; workbook comparison only, audit H1), or a forecast run (`409`, WP-2.12: a sign-off is judged on the record, and a forecast run's last days are modelled on forecast rain); `409` `run_unverified` for a run whose server stamp is missing or no longer matches its rows (a run written past the model run, or changed since; security.md § Run stamps); `403 mfa_required` / `mfa_step_up` without two-step sign-in where the project requires it (`project.mfaRequired`; § Two-step sign-in), and then also `401 mfa_fresh_code` for a code more than 10 minutes old | editor |

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

## Licence record

How long a project's licence record (its issued packs, nominated runs and
the names they keep) is kept (161_licence_record; [evidence-pack.md §
Retention](./evidence-pack.md#retention)). Provisional position (pre-counsel
research, 2026-10-01).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/licence-record` | – | `{ licenceRecord: LicenceRecord }` | editor |
| PUT | `/projects/:id/licence-record` | `{ outcome: 'granted', outcomeOn, expiresOn, reason }`, `{ outcome: 'refused' \| 'withdrawn', outcomeOn, reason }` or `{ outcome: null, reason }` (strict; dates `YYYY-MM-DD`, `reason` 1–2 000) | `200 { licenceRecord }`; records `licence.outcome`. `400` for a grant without an expiry or one expiring before it was granted | owner |
| POST | `/projects/:id/licence-record/confirm` | none, or `{}` (strict) | `200 { licenceRecord }`, the next review five years from today; records `licence.confirmed`. `409` once an outcome is recorded | owner |

- `LicenceRecord = { outcome: 'granted' | 'refused' | 'withdrawn' | null,
  outcomeOn, expiresOn, reason, closesOn, reviewDueOn }`: `closesOn` is the
  expiry (granted) or the decision date, + 3 years; `reviewDueOn` the next
  5-yearly review while no outcome is recorded (null before the first issued
  pack or nomination).
- `DELETE /projects/:id` and `DELETE /teams/:id` answer `409`
  (`details.publicRecords: true`) for a project of, or a team that keeps,
  public records until the client has confirmed their disposal, and
  `PATCH /projects/:id` the same for moving such a project out of its team.

## Allocations

Registered and licensed water-use volumes per farm or water user, and a run's
modelled use against them (roadmap WP-3.10, migrations 038, 103 and 162,
[allocations.md](./allocations.md)). The app compares; it never decides
whether a use is lawful. A viewer reads each volume only when an owner has
let viewers do so (`viewerUnits`, 162, decision D3); until then a viewer
gets totals per water source held by 5 or more registered users, and no
route hands them a copy of the volumes ([allocations.md § Who sees
what](./allocations.md#who-sees-what)).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/allocations` | – | `{ allocations: Allocation[], sources: AllocationSource[], nodes: { id, name }[], canSeeHolders, viewerUnits, unitsHidden, totals }`: `nodes` are the farms and water users a row can be matched to; `canSeeHolders` is true for editors and owners; `viewerUnits` whether the owners let viewers read each volume (162); `unitsHidden` true for a viewer while it is off, and then `allocations` is `[]` (RLS) and `totals` is `[{ waterSource, holders, registeredM3PerYear, storageM3 }]`, the volumes (21(a) takes) and storage in force today summed per water source, only for a source held by 5 or more registered users (counted by name, else a name on another row of the same unit, else the unit, else the row; `app_allocation_volumes`); `totals` is `null` otherwise | viewer |
| PUT | `/projects/:id/allocations/viewer-units` | `{ on: boolean }` | `200 { viewerUnits }`: whether viewers read each registered volume (162, D3; on only if every viewer works for, or was appointed by, the organisation). History `allocation.viewer_units` `{ on }` when it changes | owner |
| POST | `/projects/:id/allocations` | `AllocationInput` | `201 { allocation }`. `400` for a node that isn't a farm or water user of this project, dates out of order, a volume < 0; `409` past 5 000 allocations per project (counted under a per-project lock, so concurrent adds and imports can't pass it together; `costCaps.security.db.test.ts`) | editor |
| PATCH | `/projects/:id/allocations/:aid` | any `AllocationInput` fields (at least one) | `200 { allocation }`; only the fields sent change (issue #72: before, every field not sent went back to its default, the name and registration number included); `holder: ''` removes the name | editor |
| DELETE | `/projects/:id/allocations/:aid` | – | `204` | editor |
| POST | `/projects/:id/allocations/import` | `{ kind: 'warms_extract' \| 'csv', fileName, text, reference? }` (`text` ≤ 2 MB; `reference` required, not blank, for a `warms_extract`: how it was obtained, the DWS or CMA letter or terms, else `400`; 162, operator agreement 3A.1(d)) | `200 { fileName, kind, sha256, columns, ignoredColumns, rows: PreviewRow[], nodes, summary: { rows, valid, invalid, matched, unmatched } }`. **Writes nothing.** `422` for a file it can't take (with why: personal-information columns, no volume column, empty, too many rows, an unterminated quote); `409 this file was already imported (…)` for the same SHA-256 | editor |
| POST | `/projects/:id/allocations/import/commit` | the import body + `matches: { "<line>": nodeId \| null }` | `201 { source, imported, skipped, unmatched }`: the file is parsed again (no state is kept between preview and commit) and its valid rows stored with the file's name and hash; rows with problems are skipped. `400` for a match to a node that isn't a farm or water user; `422` when no row can be imported | editor |
| DELETE | `/projects/:id/allocations/sources/:sourceId` | – | `204`: the import and every allocation it brought | editor |
| GET | `/projects/:id/allocations/export.csv` | – | CSV in the template's columns (`months` as numbers separated by spaces, `conditions` separated by ` \| `, `water_use` `21a` / `21b`) plus `source_file`, `source_sha256`; the `holder` column only for editors and owners; formula-looking cells prefixed with `'`. `403` for a viewer while `viewerUnits` is off | viewer |
| GET | `/projects/:id/runs/:runId/allocations` | `?tolerance=` (0 ≤ τ < 1; default the project's `settings.allocationTolerance`, 0.1 unless set) | `{ run: { id, label, startDate, endDate, forecastFrom, allocationMode }, comparison: AllocationComparison \| null, capYears, totals }`; for a viewer while `viewerUnits` is off, `comparison` is `null`, `capYears` `[]` and `totals` is `{ tolerance, sources: [{ waterSource, holders, units, years: [{ waterYear, partial, registeredM3, modelledM3, status }] }] }`, the comparison summed per water source over the units with a volume on it, only for a source 5 or more registered users hold (`totals` is `null` for everyone else); `allocationMode` the mode the run ran with (`'none'` for a run before engine 1.18.0) (engine `compareAllocations`, [model.md §2.12](./model.md#212-allocations-modelled-use-vs-registered-volume-roadmap-wp-310)). A forecast run (`forecastFrom` set, WP-2.12) is compared on the days before `forecastFrom` only, like its other historical figures (issue #51) | viewer |

- `Allocation = { id, nodeId, nodeName, sourceId, registrationNo,
  propertyRef, holder, authorisation, purpose, waterSource, volumeM3PerYear,
  storageM3, validFrom, validTo, reference, months, maxRateM3s, conditions,
  waterUse, createdAt, updatedAt }`. `waterUse` (142, issue #72) is the NWA
  s21 water use: `'21a'` a take of `volumeM3PerYear` a year, `'21b'` a dam's
  storage only (`volumeM3PerYear` 0, `storageM3` stated, surface water),
  never counted as a take. `months` (calendar months 1–12, ascending, or
  `null` for none stated), `maxRateM3s` (m³/s or `null`) and `conditions`
  (strings) are licence conditions (103, issue #72), recorded and shown; a
  cap run (engine ≥ 1.37.0) applies `months` and `maxRateM3s`, never
  `conditions`. `holder`
  is `null` for a viewer (RLS hides `allocation_holder`), and when there is
  none. `sourceId` is `null` for a row typed into the app.
- `AllocationInput = { nodeId: uuid | null, registrationNo?, propertyRef?,
  holder?, authorisation: 'registration' | 'licence' | 'general_authorisation'
  | 'schedule_1' | 'existing_lawful_use_claimed' | 'existing_lawful_use'
  (claimed = not verified; only `existing_lawful_use` is verified under s35;
  issue #281), purpose?: 'irrigation' | 'domestic' | 'livestock'
  | 'industry' | 'mining' | 'municipal' | 'other', waterSource: 'surface' |
  'groundwater', volumeM3PerYear, storageM3?, validFrom?, validTo?,
  reference?, months?: 1–12 each, 1–12 of them, no repeats (stored ascending)
  | null, maxRateM3s?: 0 ≤ r < 10⁶ | null, conditions?: up to 20 strings of
  1–500 characters, waterUse?: '21a' (default) | '21b' }` (dates
  `YYYY-MM-DD`). A `'21b'` row, created or as a PATCH leaves it, must have
  `volumeM3PerYear` 0, a `storageM3` and `waterSource` `'surface'`, else
  `400` (137's `allocation_storage_only_check` refuses it in the table too).
- Import: the template and a WARMS extract may carry `months` (numbers or
  names, ranges over the new year: `Oct-Mar`), `max_rate_m3s` and
  `conditions` (separated by `|`); a cell that doesn't read is a row problem.
  A WARMS extract must carry a water-use (s21) column, or the file is `422`;
  each row's code, unit and frequency are read and an ambiguous row is a
  row problem ([allocations.md § Importing](./allocations.md#importing)).
  `PreviewRow` carries `waterUse`.
- Every run's input carries the project's allocations (engine ≥ 1.18.0:
  `GET /projects/:id/model-input` and the stored run's `inputs.model.allocations`,
  without names, registration numbers or properties), and a write that changes
  what a run reads makes the latest run out of date (`project.updated_at`).
  `settings.allocationMode` (`'none'` | `'cap'` | `'fullAllocation'`) and
  `settings.allocationTolerance` (0 ≤ τ < 1) are project settings
  ([Projects](#projects)); `RunSummary.allocations` is the run's own
  comparison ([model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
  In a cap run each of its sources carries `capReached: [{ waterYear,
  budgetM3, usedM3 }]` (the years the volume was used up) and, engine ≥
  1.40.0, `limitBound: [{ waterYear, days, volumeDays, rateDays, monthsDays
  }]` (the days per year the licence limit held use back, by limit; only
  years with one). A capped source whose licence states months or a rate has
  the run series `allocation_left_surface` / `allocation_left_groundwater`
  (what is left of the year's volume, m³, start of the day) beside
  `allocation_room_*`. Both are `null` on a day none of the unit's
  allocations of the source is in force, which isn't capped and whose use
  doesn't count (engine ≥ 1.70.0; a year with no capped day is in neither
  `capReached` nor `limitBound`). In a full-allocation run `scaled` leaves
  out a water year with no allocation in force (its factor is 1, the
  modelled demand; engine ≥ 1.70.0).
  The summary CSV adds an "Allocation cap by water year" block in a cap run.
- `capYears` (the run comparison, `GET …/runs/:runId/allocations`): in a cap
  run, one `{ nodeId, waterSource, capReached, limitBound }` per unit and
  capped source of `RunSummary.allocations` (`limitBound` `null` on a run
  before engine 1.40.0); `[]` for a run of another mode. Read from the run's
  summary, not recomputed, so for a forecast run it covers the forecast days
  too, unlike `comparison` (the page says so).
- `AllocationSource = { id, kind, fileName, sha256, reference, importedAt,
  importedBy, rows }`.
- `PreviewRow` is a parsed row (`line`, the fields, `errors: string[]`) with
  `nodeId`, `matchedBy` (`registration` | `property` | `name` | `manual` |
  `null`) and `alreadyInProject` (the registration number is already there).
- `AllocationComparison = { tolerance, startDate, endDate, nodes: [{ nodeId,
  name, kind, surface, groundwater, storage: { registeredM3,
  modelledCapacityM3, differenceM3, status } }], unmatchedAllocationIds,
  notInRunAllocationIds }` (`storage.differenceM3` = capacity − registered,
  `null` unless both are known; `storage.status` bands the capacity against
  the registered storage as a year's use is banded, issue #72);
  `surface` / `groundwater` = `{ waterSource, allocationIds, years: [{
  waterYear, days, yearDays, partial, modelledM3, registeredM3, ratio, status
  }], yearsOver, wholeYears, meanModelledM3PerYear, meanRegisteredM3PerYear }`,
  `status` ∈ `over` | `within` | `under` | `unregistered` | `none`.
- **Farmers** get `403` on every route, like every viewer route; RLS limits
  them to their own farms' allocations, which the farm view sums
  (`FarmView.registered`, [§ Farm](#farm)).
- **A viewer while `viewerUnits` is off** (162, D3) reads no copy of the
  volumes: `GET /projects/:id/model-input` has no `allocations` (RLS);
  `GET …/runs/:runId`, `GET /compare/runs` and the run's `summary.csv` give
  the run with `model.allocations` (`inputs.model.allocations`) `[]` and
  `summary.allocations.nodes` `[]` (mode, band and counts kept);
  `GET …/runs/:runId/model-input` leaves the allocations out of a
  compare-only run and answers `403` for a cap or full-allocation run, whose
  numbers rest on them; the farm view's `registered` is `null`. A capped
  run's per-unit daily series (`supplied`, `allocation_left_*`) still reach
  them ([followups.md § Allocations](./followups.md#allocations-wp-310)).
- History: `allocation.created/changed/deleted/imported/import_deleted/viewer_units`; the
  preview is exempt (it writes nothing). `GET …/history` gives a viewer
  `allocation.created/changed/deleted` without `registrationNo` and
  `volumeM3PerYear` until an owner switches **What viewers see** on
  (`app_audit_subject`, 190), and `GET …/runs/:runId/changes-since` lists
  no registered-volume line to that viewer. The data-subject export carries
  neither field in any allocation event.

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
| POST | `/projects/:id/publication` | `{ runId, note?, restriction?, nextExpectedOn? }` | `201 { publication, farms }`: supersedes the current publication; `farms` is how many farm projections were stored (every farm of the run that is still a farm of the project). `400` for a run not in this project; `409` for a legacy-runoff-model run (a stored run from before engine 1.0.0; a workbook comparison, not evidence) a run too old to project (from before engine 0.17.0, which has no EWR charge series), or a scenario run (its scenario's changes on a base run, also once the scenario is deleted: farmers are shown the catchment as it is). Records `publication.published` in the season decision log (the notice, window, run identity and per-farm figures, issue #119; [data-model.md § Change history](./data-model.md)) | editor |
| PATCH | `/projects/:id/publication/:pubId` | `{ note?, restriction?, nextExpectedOn? }` (at least one) | `{ publication }`: the notice, the note or the next date change without re-publishing; stamps `updatedAt` / `updatedBy`, and records `publication.notice_changed` with the whole notice as it then stands (issue #119). `409` for a superseded publication | editor |
| POST | `/projects/:id/publication/:pubId/endorse` | `{ note?: ≤ 2000 }` | `{ publication: PublicationMeta }` with its `endorsement`: the responsible authority endorses this published baseline (163_licensing_authority; s41(2): the authority decides what evidence it accepts). Once per publication, current or superseded (an application may rest on either); the database stamps `endorsedAt` and `endorsedBy` and never lets them change. Needs two-step sign-in; records `publication.endorsed`. `403` unless the caller acts for the authority; `404` for another project's publication; `409` once endorsed | editor acting for the authority |
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
- `PublicationMeta = { id, runId, publishedAt, publishedBy, restriction: { level }, supersededAt, endorsement? }`;
  `publishedBy` is a display name (`null` once that account is gone).
  `endorsement = { endorsedAt, endorsedBy, note } | null` (163): the
  responsible authority's endorsement, `null` = not endorsed; to viewers and
  above only (a farmer's answer has no `endorsement`). The same field is on
  `Publication`.
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
| GET | `/projects/:id/share-links` | `?scenarioId=`, `?packId=` or `?scope=all` (optional, at most one: `400`) | `{ links: ShareLink[] }`, newest first, revoked and expired ones included. With none: the baseline links (owner). `scope=all`: the owner's inventory of every link in the project, the baseline's and every scenario and pack link whoever made it (the Project page's Share links list; below owner `403`). With `scenarioId`: the links to that scenario the caller manages, every one to an assessor (an editor who reads it) or the owner, the ones they made to an applicant; a scenario they can't read is `404`. With `packId` (128): every link to that evidence pack, to an editor or the owner (a pack of another project or none `404`); to an applicant (131) the ones they made to a pack of an application of theirs; anyone else below editor `403`, found or not | owner; contributor with `scenarioId` or `packId` |
| POST | `/projects/:id/share-links` | `{ label: 1–100 chars, expiresInDays: 1–365 (whole), targetKind?: 'scenario' \| 'pack', targetId?: uuid }` (both target fields or neither, `400`) | `201 { link: ShareLink & { url } }`. `url` is `${SITE_URL}/share#t=<token>` (a scenario link adds `&k=scenario`, a pack link `&k=pack`): the **only** time the token is sent; it isn't stored, so it can't be shown again. A baseline link: owner. A scenario link (WP-3.15): an editor on a scenario they read, or the applicant on their own; `404` for a scenario the caller can't read, `403` for one they read but may not share (someone the applicant shared it with, a viewer), `409` unless it is an application (not a team scenario) that is submitted or decided. A pack link (WP-3.15, 128): an editor or the owner, `404` for a pack not in the project, `409` unless the pack is `issued` (a draft is still changing; a superseded or withdrawn pack no longer stands); below editor, the application's owner on their own application's pack (131; `409` unless it is issued), anyone else `403` (someone the applicant shared it with included), found or not | owner; contributor for a scenario or pack link |
| DELETE | `/projects/:id/share-links/:linkId` | – | `204`: sets `revokedAt` / `revokedBy` (already revoked is `204` too). The owner revokes any link (another project's is `404`); an assessor a link to a scenario they read, an applicant a link they made (to their application or its pack), an editor any pack link; anyone else `403`. A link is never deleted | contributor (RLS decides) |
| POST | `/share/view` *(public)* | `{ token }` | `ShareView` (below), `Cache-Control: no-store` | – |
| POST | `/share/series` *(public)* | `{ token, key }` | `ShareSeries` (below), `Cache-Control: no-store` | – |
| POST | `/share/scenario` *(public)* | `{ token }` | `ShareScenario` (below), `Cache-Control: no-store` | – |
| POST | `/share/pack` *(public)* | `{ token }` | `SharePack` (below), `Cache-Control: no-store` | – |
| POST | `/share/comment` | `{ token, body: 1–4000 chars (trimmed), registerConsent?: boolean }` | `201 { comment: { body, author, createdAt, editedAt } }` (166_public_participation): a `public_participation` comment through a live link to a submitted or decided application or an issued pack, by **any** signed-in account, with no project role (a link participant). `registerConsent`: give my name and email to the applicant for the register (GN R267 reg 18). `401` signed out; `404` for a dead, revoked, baseline or closed link; `429 comment_throttled` (`params.seconds`, `Retry-After`) past 10 an hour per account | signed in |

- `ShareLink = { id, label, createdAt, createdBy, expiresAt, revokedAt, revokedBy, lastUsedAt, targetKind, targetId, mine }`
  (`createdBy` / `revokedBy` are display names, `null` once that account is
  gone; `targetKind` `null` = the baseline, `'scenario'` with `targetId` its
  scenario, `'pack'` with `targetId` its evidence pack; `target` = `{ name, status }` of that scenario as the caller
  reads it under RLS (a pack's: `{ name: its report's title, status, version }`), `null` for the baseline and for a target they can't
  read now (an application reopened as a draft, or deleted), whose link
  opens nothing; `mine` = the caller made it). `lastUsedAt` moves at most once an
  hour, on a `/share/view`, `/share/scenario` or `/share/pack`.
- A link opens **only its own target**: a scenario or pack link answers
  `404` on `/share/view` and `/share/series`, a baseline or pack link `404`
  on `/share/scenario`, and a baseline or scenario link `404` on
  `/share/pack`.
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
  `observed_flow`, `ewr`, `ewr_shortfall`. `natural_flow` and `ewr` (the
  river) answer at any holder count; the other three (the use) only when the
  catchment has at least `FARMER_K` = 5 farm **holders** (farms linked to one
  user count once, an unlinked farm on its own; design
  [farmer-view.md §10.3](./design/farmer-view.md#103-decisions-this-design-takes-for-the-client-to-confirm)):
  in a smaller catchment natural flow minus outflow would reveal the farms'
  use (164).
- Every dead link answers the same `404 { error: "not found" }`: unknown,
  malformed, revoked or expired token, or nothing published. `/share/series`
  answers the same `404` for a key off the allowlist (every farm key), a key
  the run doesn't have (`observed_flow` without observed data), and a use
  key below `k` holders. A body without `token` (or `key`) is `400`.
  When the published run is a forecast run, the series stops the day before
  its first forecast day (190): the monthly means and the last 365 days are
  the record's, never forecast rain read as the river's flow.
- `ShareScenario` (WP-3.15, `app_share_scenario`, a redacted projection):
  `{ project: { id, name }, scenario: { id, name, description, origin, status, submittedAt, decidedAt, outcome, decisionNote, ops, opsSha256, ownedNodeIds, opNames, classified }, results, base, run, comments }`.
  It answers only while the scenario is `submitted` or `decided` (withdrawn
  or back to draft: `404`, until it is submitted again). `opNames` names the
  scenario's own nodes only; `classified` is each op's class (`proposal` |
  `baseline`) as the shown run applied it (`null` without one). `base` and
  `run` are the base run and the scenario's newest run of its current ops
  whose stamp verifies (of its newest five),
  each `{ engineVersion, startDate, endDate, createdAt, ewrDaysNotMet, ewrFractionDaysNotMet, volumes, ewrSites }`:
  `ewrSites` is each EWR site's Reserve compliance (`{ name, isOutlet, months, met, rate, longestNotMetRun, deficitM3, byMonth: { month, years, met, rate }[] }`,
  the outlet's `name` `null`), and `volumes`
  (`{ meanNaturalFlowM3Day, meanSimulatedOutflowM3Day, farms: { count, demandM3Day, suppliedM3Day, belowTarget } }`)
  and every `deficitM3` are `null` below 5 farm holders (the `k` rule
  above), and on both runs when any change is a baseline assumption (on
  another unit, it would make baseline minus application that unit's
  figures). `results`: `ready` (both runs' stamps verify, [security.md § Run
  stamps](./security.md#run-stamps)), `none` (no run of its current ops:
  `base` and `run` `null`) or `unverified` (no candidate run's stamp verifies, or the base's fails: `base`, `run` and
  `classified` `null`). `comments` are the notes on it with `public_participation`
  visibility (the newest 500), oldest first, `{ body, author, createdAt, editedAt }` (the
  author's display name: posting a public comment says so). `objection`
  (166): `{ address, closingDate }` from the application's notice, or
  `null`. No other farm's name, id or figures, no member list, no e-mail,
  no allocation holder.
- `SharePack` (WP-3.15, 128, `app_share_pack`, a redacted projection of
  the pack's own frozen report,
  [evidence-pack.md § Sharing and comments](./evidence-pack.md#sharing-and-comments)):
  `{ project: { id }, pack: { id, title, mode, version, shortCode }, verify, figures, comments, objection }`
  (`objection` as a scenario link's, for an application's pack; else `null`).
  `verify` is exactly [`GET /verify/:code`](#evidence-packs)'s `pack` for
  it. `figures`, only while the pack is `issued` (`null` once superseded or
  withdrawn: `verify.status`, `withdrawnReason` and `successorSha256` say
  why):
  `{ identity: { title, mode, baseline: { startDate, endDate, engineVersion, runoffModel }, application: { engineVersion, proposals, assumptions } | null }, volumes, rows, river, byMonth, disclaimerVersion }`,
  where `rows` are page 1's river rows (`reserve` per site, `ewrDays`,
  `noFlowDays`; `shortfall` and `outflowMar` only when `volumes`, i.e. 5 or
  more farm holders and no changed baseline assumption), each
  `{ id, subject, unit, higherIsWorse, baseline, application, change: { run, band: { n, p5, p50, p95 }, bandNote, worse: { k, n } }, notAssessed, note }`
  (`subject` a gauge's name on a reserve row, else `null`; no label or
  basis: a client words the row by its `id`, and a reserve row's basis
  quotes the rule table's free-text source); `river` each EWR
  site `{ name, isOutlet, category, monthsA, rateA, rateB, longestA, longestB, lost, gained }`
  (the outlet's `name` `null`); `byMonth` `{ month, run, band }[]` or
  `null`. It answers for a pack that was issued (issued, superseded or
  withdrawn); a draft, or a pack withdrawn before it was issued, is `404`.
  `comments` as a scenario link's (its `public_participation` notes). No
  user, farm or allocation row, no other application, no settings, model or
  input diff, no applicant statement, no person but the signers verify
  names.
- No session and no rate limit of its own: the WAF's per-IP limit on `/api/*`
  covers the reads, and a 256-bit token can't be guessed.
- Creating and revoking are recorded on the row (`createdBy`, `revokedAt`,
  `revokedBy`), not yet as audit events (WP-2.4,
  [followups.md](./followups.md)).

## Catchment map

The map's features, GeoJSON imports, areas accepted from polygons and the
quaternary lookup (issue #288, roadmap WP-3.12, `152_catchment_map.sql`,
[maps.md](./maps.md)). Geometry is GeoJSON in WGS84 longitude/latitude, 2D;
every geometry is checked and every area computed on the server
(`backend/src/geo`). Nothing here changes the model except `area-from-map`,
`dam-capacity-from-register` and `dam-area-from-map` (one value each, an
editor's explicit action), and the quaternary lookup and the dam proposals
only propose.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/map/features` | – | `{ features: MapFeature[], sources: { id, fileName, sha256, crs, importedAt, importedBy, features }[], nodes: { id, name, kind, areaKm2, areaSource: 'typed' \| 'map', areaBasis: 'gross' \| 'effective' \| null, areaFeatureId }[], quaternaryDatasets: { dataset, count }[] }`; the catchment boundary first | viewer |
| GET | `/projects/:id/map/linked-nodes` | – | `{ nodeIds: string[] }`: each node at least one feature is linked to, once, and no geometry. The "Show on map" links on Network, Hydrological units and Dams (issue #326) read this rather than the feature list. A farmer gets `403`, as from `/map/features` | viewer |
| POST | `/projects/:id/map/features` | `{ kind, name?, nodeId?, lon, lat }` (a point) or `{ kind, name?, nodeId?, geometry, traced? }` | `201 { feature }`. `400` for a geometry that fails the checks (the message says which: projected, 3D, a ring that crosses itself …), a type the kind doesn't take, a node of another project or of a kind the feature can't stand for. A `catchment_boundary` replaces the current one. `traced: { lon, lat, minOccurrence: 10 \| 25 \| 50 \| 75, edited }` (#326 C2, a `dam` or `other` polygon only): the outline was traced from the water occurrence data at that point; the server traces it again, refuses (`400`) an outline sent with `edited: false` that isn't that trace, writes the method in `properties.description` and audits `map.feature_created` with `from: 'dam_trace'`, the dataset, the share and `edited`; `409` when tracing is off, `422` with `details.reason` when the point no longer traces, `429` past the trace cap (as `POST …/map/dam-trace`; a `traced` save counts as a trace) | editor |
| PATCH | `/projects/:id/map/features/:fid` | any of `kind`, `name`, `nodeId` (`null` unlinks), `damPosition` (`'on_channel'` \| `'off_channel'` \| `null`, a dam polygon only, 194), `lon` + `lat` or `geometry` | `200 { feature }`; the area is recomputed when the geometry changes. `damPosition` on anything but a dam polygon is a `400`; it is kept through other edits while the feature stays a dam polygon and cleared when it stops being one. A change to it is in the `map.feature_changed` event (`damPosition: { from, to }`) | editor |
| POST | `/projects/:id/map/features/:fid/split` | `{ parts: [Polygon, Polygon], names?: [string, string], as?: 'farm_parcel' \| 'other' }` | `201 { features: [MapFeature, MapFeature] }` (#326 C2; the cut is made in the browser, `draw/split.ts`). Each part passes the geometry checks; together their areas must be the shape's within 0.1 % (+1 m²) and they must lie within its bounds (else `400`). A parcel, dam or other area keeps its id, name and link on the first part (renamed by `names[0]`) and the second is a new feature of its kind (`names[1]`, default "<name> (part 2)", no node, `properties.description` "Split from “<name>” along a drawn line."). The catchment boundary stays whole and both parts are new `as` features (default `other`, named "<boundary> part 1/2"); `as` on anything else is a `400`. `400` for a point, a line, or a polygon with holes or several parts. One `map.feature_split` event: the shape's id, kind and name, `into`, both parts' ids and areas | editor |
| GET | `/projects/:id/map/dam-trace` | – | `200 { available, dataset: { label, attribution, fingerprint, maxZoom, bounds } \| null }`: whether tracing a dam is on (`WATER_URL` configured and readable) | viewer |
| POST | `/projects/:id/map/dam-trace` | `{ lon, lat, minOccurrence?: 10 \| 25 \| 50 \| 75 }` (default 25) | `200 { trace: { click, seed, snapDistanceM, geometry: Polygon, areaM2, cells, cellSizeM, zoom, minOccurrence, dataset, attribution, datasetFingerprint, method, methodVersion } }`: the outline of the water round the point (#326 C2, [maps.md § Assisted drawing](./maps.md#assisted-drawing)); nothing is saved or audited. `409` when tracing is off; `422 { details: { reason } }` refused: `outside` the data, `no_data` there or at the water's edge, `no_water` (none at that share within about 60 m), `too_large` (past about 16 km), `too_small`, `outline`; `429` past 300 traces a project or 600 a user an hour (every attempt counted before the work, refused ones too; saving a traced outline counts one), with `Retry-After`; `503` when the data can't be read | editor |
| DELETE | `/projects/:id/map/features/:fid` | – | `204`; its import goes with its last feature. A node whose area came from it keeps the area and loses the link | editor |
| POST | `/projects/:id/map/import/preview` | `{ fileName, text }`: the file, under the import's own body limit | `200 { fileName, sha256, duplicate, currentBoundary: { name } \| null, features: { index, geometryType, name, areaM2, kind, kindFrom: 'property' \| 'geometry', note?, nodeId }[], problems: { feature: n \| null, message }[], nodes: { id, name, kind }[] }`. Saves nothing. Each feature's proposed kind (from a `kind`/`type`/`layer` property, else its shape; [maps.md § Uploads](./maps.md#uploads)) and the node of the same name it can stand for; a refused feature is a row with `geometryType`, `kind` null and its problem in `problems`; `duplicate` when the same file (SHA-256) is in already; `currentBoundary` the project's boundary now (a row imported as the boundary replaces it, so the review warns and asks for `replaceBoundary`). Issue #326 D2 | editor |
| POST | `/projects/:id/map/import` | `{ fileName, text }` and either `features: { index, kind, name?, nodeId? }[]` (every feature of the file once, as reviewed; `name` omitted keeps the file's, `nodeId` omitted links by name, `null` none) or `kind` (every feature that kind), and `replaceBoundary?: boolean` (with `features`). The file ≤ 5 MB; this route has its own body limit, 7 MB of JSON | `201 { source: { id, fileName, sha256 }, features }`. With `kind`: a `catchment_boundary` file's polygons become one boundary; other kinds one feature each, linked to a node of the same name (case-insensitive) and a fitting kind. A boundary replaces the project's current one: with `features`, only with `replaceBoundary: true` (else `409` naming the current boundary, and nothing is imported); the one-kind `kind: 'catchment_boundary'` import names the whole file the boundary and replaces it without the flag, as before. A file holds at most one. `422 { error, details: { feature: n \| null, message }[] }` with every problem, per feature (a kind that doesn't fit the geometry, a node of a kind the feature can't stand for, two boundaries, a refused geometry; nothing is imported); `400` for both or neither of `kind`/`features`, a feature listed twice or missing, or another project's node; `409` for the same file twice (SHA-256; the same answer when two identical imports race past the check and the unique index stops the second) or a reviewed boundary that would replace the current one without `replaceBoundary: true`; `413` over the limit | editor |
| POST | `/projects/:id/nodes/:nodeId/area-from-map` | `{ featureId, basis? }` | `200 { nodeId, areaKm2, areaSource: 'map', areaBasis, areaFeatureId, revisionId }`: the farm's `areaKm2` set to the polygon's area, recorded as a model revision whose reason names the feature and, for a delineated feature with a pans figure, which area (History, the run comparison's diff). `basis` (195): `gross` (the default, the whole area) or `effective` (the area less the feature's `nonContributingM2`, what drains into pans; [maps.md § Pans and the effective area](./maps.md#pans-and-the-effective-area)). `400` for a node that isn't a farm, a feature without an area, a dam or the catchment boundary (only a `farm_parcel` or an `other` polygon is a unit's catchment area; `AREA_KINDS`), or `effective` on a feature with no pans figure or all of it in pans; `404` for another project's feature | editor |
| GET | `/projects/:id/map/stations` | `?lon=&lat=` (both or neither), `?within=` km (default 50, at most 200) | `{ point: [lon, lat] \| null, pointFrom: 'query' \| 'outlet_gauge' \| 'boundary_centre' \| null, pointName, withinKm, stations: GaugeStationProposal[], datasets: { dataset, count }[] }`: the river gauges (H codes) in `gauge_station_reference` within `within` km of the point, nearest first (ties by code), at most 10; each `{ code, name, river, lon, lat, catchmentKm2, recordStart, recordEnd, recordYears, distanceKm, dataset, synthetic, source }`. Without a point, the catchment's outlet: the map gauge linked to the outflow gauge node, else the boundary's centre, else `point: null` and no stations ([maps.md § Gauging stations](./maps.md#gauging-stations)). Writes nothing (issue #326 B-gauge) | viewer |
| GET | `/projects/:id/map/quaternary` | `?lon=&lat=` | `{ point: [lon, lat], quaternary: QuaternaryProposal \| null, datasets: { dataset, count }[] }`: the quaternary in the loaded dataset that contains the point (null: none does, or none is loaded). Writes nothing | viewer |
| GET | `/projects/:id/map/rivers` | `?bbox=minLon,minLat,maxLon,maxLat` (WGS84, west < east, south < north, at most 2° a side) | `{ bbox, reaches: RiverReach[], truncated, datasets: { dataset, count }[] }`: the reaches of `river_reference` whose bounding box meets the bbox, the highest Strahler order first (then the largest area upstream, then id), at most 1000 (`truncated` when there are more); each `{ dataset, reachId, name, strahler, upstreamKm2, lengthKm, dischargeM3s, synthetic, source, geometry, featureId }`, `featureId` the project's river feature added from it, or null. The Map tab's **River network** layer (issue #345, `geo/rivers.ts`, [maps.md § River network](./maps.md#river-network)). `400` for a missing, malformed, inverted or oversized bbox; a farmer `403` | viewer |
| POST | `/projects/:id/map/rivers/add` | `{ dataset, reachId }` | `201 { feature: MapFeature }`: that one reach added as the project's `river` feature, named after it ("Reach <id>" when unnamed), its source in `properties.description` and `river-network:<dataset>:<reachId>` in `properties.ref`; audited as `map.feature_created` with `from: 'river_network'`. `404` for a reach not in the loaded network, `409` when it is on the map already (an advisory lock serialises two adds), `400` for a bad body | editor |
| GET | `/projects/:id/map/quaternaries` | `?bbox=minLon,minLat,maxLon,maxLat` (WGS84, west < east, south < north, at most 5° a side) | `{ bbox, quaternaries: { code, dataset, synthetic, geometry }[], truncated, datasets: { dataset, count }[] }`: the quaternaries whose bounding box meets the bbox, by code, at most 100 (`truncated` when there are more); codes and outlines only, no reference values (those stay with `/map/quaternary`). The Map tab's **Quaternary catchments** layer (issue #326 A6, `geo/quaternaryLayer.ts`). `400` for a missing, malformed, inverted or oversized bbox; a farmer `403` | viewer |
| GET | `/projects/:id/map/map-grid` | `?bbox=minLon,minLat,maxLon,maxLat` (WGS84, west < east, south < north, at most 2° a side), `&dataset=` (optional) | `{ bbox, dataset: MapGridDataset \| null, datasets: MapGridDataset[], cells: [lon, lat, mapMm][], tooDense, max }`: one loaded mean annual precipitation grid's points whose centres lie in the bbox, south to north, each its centre and its MAP in whole mm; `dataset` is the one asked for, else the default (a real grid before `synthetic`, the finest first), null with none loaded; each `MapGridDataset` is `{ dataset, source, version, attribution, cellDeg, cells, synthetic }`. `tooDense` (with no cells) when the bbox holds more than `max` (5 000) of the grid's cells, counted from the grid before any read. The Map tab's **MAP grid** layer (`geo/rainMapRoutes.ts`, [maps.md § MAP grid](./maps.md#map-grid)). `400` for a missing, malformed, inverted or oversized bbox; `404` for a dataset that isn't loaded; a farmer `403` | viewer |
| GET | `/projects/:id/map/unit-map` | `?dataset=` (optional, a grid's label) | `{ dataset, coversAll, units, uncovered, withoutPolygon, refused, otherGrid, candidates }`: each land unit's MAP from one MAP grid ([maps.md § MAP for each unit](./maps.md#map-for-each-unit)). `dataset: { label, version, source, attribution, cellDeg, synthetic } \| null`: the grid asked for, else the finest real grid covering every unit with a parcel, else the real grid covering the most (the finest of those), the synthetic grid only when no real grid covers any unit; null when none covers any. `units: { nodeId, name, featureId, mapMm, cells, coveredShare, current: { mapMm, mapSource }, same }[]`: each unit it covers, its area-weighted MAP over its parcel in whole mm, the cells with a value it touches, the share of the parcel with values, what its form holds, and whether that is this MAP from this grid already. `uncovered: { nodeId, name, coveredShare, reason }[]`: units with a parcel the grid doesn't cover (values over less than 90 % of the parcel, or more than 100 000 cells in its box), never filled from another grid. `withoutPolygon: { nodeId, name }[]`; `refused: { nodeId, name, reason }[]` (several parcels and none its area). `otherGrid: { nodeId, name, mapSource }[]`: units outside the proposal whose MAP came from another grid (a POST is then `grid_mixed`). `candidates: { label, version, cellDeg, synthetic, covered, missing: { nodeId, name }[] }[]`: every loaded grid in the order the choice reads them. `400 { details: { code: "dataset_unknown" } }` for a grid that isn't loaded; a viewer `403`; a project you can't see `404` (`geo/unitMapRoutes.ts`) | editor |
| POST | `/projects/:id/map/unit-map` | `{ dataset, nodeIds?: uuid[] }`, strict | `200 { dataset, units: { nodeId, mapMm, mapSource }[], changed, revisionId }`: re-derived on the server from the grid and the parcels as they are, each chosen unit's (every unit `dataset` covers, or the `nodeIds`) `mapMm` and `mapSource` (`<label> <version>, area-weighted mean over the unit’s parcel, <n> cells`) written as one model revision (`model_put`, its reason citing the grid; `revisionId` null when nothing changed). `400` codes in `details.code`: `dataset_unknown`, `unit_unknown` (a node that isn't a land unit), `nothing_covered`; `409`: `unit_uncovered` (a named unit the grid doesn't cover, has no parcel or is refused; `details.units` says why), `grid_mixed` (a unit would keep a MAP from another grid; `details.units`) | editor |
| GET | `/projects/:id/nodes/:nodeId/dam-proposals` | – | `200 { nodeId, nodeName, current: { damCapacityM3, damAreaFullM2 }, dam: { id, name, geometryType, point: [lon, lat], areaM2 } \| null, radiusM: 1000, register: RegisterDamProposal[], area: { featureId, featureName, areaM2, method } \| null, datasets: { dataset, count }[] }` (issue #326 B-dams, `geo/damRoutes.ts`, [maps.md § Dams from the register and the map](./maps.md#dams-from-the-register-and-the-map)): the hydrological unit's dam on the map (a linked `dam` feature, a polygon first, then the earliest), the registered dams within 1 km of its centroid or point, nearest first, at most 5, and the polygon's area as the full-supply area (`null` for a point). `dam: null` when no dam feature is linked. `current` is the saved model's. Writes nothing. `400` for a node that isn't a farm; `404` for another project's node | viewer |
| POST | `/projects/:id/nodes/:nodeId/dam-capacity-from-register` | `{ registerNo }` | `200 { nodeId, damCapacityM3, registerNo, revisionId }`: the unit's `damCapacityM3` set to the registered dam's capacity, recorded as a model revision whose reason names the dam, its number, capacity, distance and source line. The server re-derives the proposals: `400` for a node that isn't a farm, a unit with no dam on the map, a register number not within 1 km of it (or not loaded), or an entry without a capacity; `404` for another project's node. The number is matched case-insensitively | editor |
| POST | `/projects/:id/nodes/:nodeId/dam-area-from-map` | `{ featureId }` | `200 { nodeId, damAreaFullM2, areaFeatureId, revisionId }`: the unit's `damAreaFullM2` set to the dam polygon's geodesic area, recorded as a model revision whose reason names the feature. `400` for a node that isn't a farm, a feature that isn't a `dam`, a dam point (no area), a dam linked to another unit, or a unit with no dam capacity; `404` for another project's feature or node | editor |
| GET | `/projects/:id/nodes/:nodeId/cropland-proposals` | `?dataset=` (optional; default a real dataset before the synthetic one, then the newest load) | `200 { nodeId, nodeName, dataset: CroplandDataset \| null, datasets: { dataset, version, synthetic }[], parcels: { featureId, name, areaM2, cultivatedM2 }[], unit: { areaM2, cultivatedM2 } \| null, catchment: { featureId, name, areaM2, cultivatedM2 } \| null, crops: { cropId, name, areaM2, accepted: CropAreaFromLandCover \| null }[] }` (issue #326 B-landcover, `geo/croplandRoutes.ts`, [maps.md § Cultivated area from land cover](./maps.md#cultivated-area-from-land-cover)): each `farm_parcel` linked to the unit (oldest first) with its area and the area the land cover maps as cropland in it (m², rounded), their sum (`unit`, null without parcels), the catchment boundary's for reference, and the project's crops with the unit's planted area now (0 = none) and where an accepted area came from. A polygon that can't be summarised (too big) has `problem` in place of the figures. No dataset loaded: `dataset: null` and no figures. Writes nothing. `400` for a node that isn't a farm or an unknown dataset; `404` for another project's node | viewer |
| POST | `/projects/:id/nodes/:nodeId/crop-area-from-land-cover` | `{ cropId, dataset, featureId? }` | `200 { nodeId, cropId, areaM2, dataset, revisionId }`: the crop's planted area on the unit set to the cultivated area of the unit's parcels (or the one parcel `featureId`), re-derived on the server, recorded as a model revision whose reason cites the dataset, its version and the method, and as a `crop_area_land_cover` row (174). The client names the crop; the land cover never does. `400` for a node that isn't a farm, an unknown dataset, a unit with no parcel, a feature that isn't a parcel linked to it, parcels the land cover can't summarise or with no cropland; `404` for another project's node, crop or feature | editor |
| GET | `/projects/:id/evaporation-proposals` | `?dataset=` (optional; default a real dataset before the synthetic one, then the newest load) | `200 { dataset: EvaporationDataset \| null, datasets: { dataset, kind, version, synthetic }[], boundary: { featureId, name } \| null, target: 'pe' \| 'apan' \| null, proposal: { monthlyMm, annualMm, coverage, cells } \| { problem } \| null, settings: { apanMm, peKind, peMm, dailyApan }, accepted: EvaporationAccepted[] }` (issue #326 B-evap, `geo/evaporationRoutes.ts`, [maps.md § Evaporation from the map](./maps.md#evaporation-from-the-map)): the catchment boundary's 12 monthly means (Oct … Sep, mm, to 0.1) from the grid, area-weighted over the cells it covers, with the share of the boundary that has values; `target` is where the dataset's kind goes (`et0` → `pe`, GR4J's monthly PE; `apan` → `apan`, the A-pan row), never converted. `settings` is the saved settings' A-pan row, PE kind and monthly PE row (null under `pan`), and `dailyApan`, the days a daily A-pan record (`evap_apan_mm`) covers, `{ from, to }` to its last value, or null without one: it replaces the monthly A-pan row on those days, and the panel's confirmation says so. `proposal: null` without a dataset or a boundary; `{ problem }` when the grid can't stand for it (no value inside, under 50 % covered, too big). Writes nothing. `400` for an unknown dataset | viewer |
| POST | `/projects/:id/evaporation-from-map` | `{ dataset }` | `200 { target, monthlyMm, dataset, revisionId }`: the 12 values, re-derived on the server from the boundary as it is, written into `settings.pe` (`{ kind: 'monthly', mm, source }`, the source naming the dataset; for a reference-ET grid) or `settings.apanMm` (for an A-pan grid), recorded as one settings revision whose reason cites the dataset, its version, period and method, and as an `evaporation_accepted` row (181). `400` for an unknown dataset, no catchment boundary, a boundary the grid can't summarise, or no evaporation in it | editor |

- A feature's `name` (0–100 characters after trimming) is one line, as a
  model name is (§ Model data; migration 192): the Map draws it as a label.
  `POST`/`PATCH …/map/features`, the split's `names`, a reviewed import
  row's `name` and the delineation accept's `name` refuse a line break, tab
  or other control character with `400` (`cannot contain line breaks or
  control characters`); the names read from a GeoJSON file and from the
  river network are made one line instead (the engine's `oneLineName`), so a
  file is never refused for them.
- `MapFeature = { id, kind: 'catchment_boundary' | 'farm_parcel' | 'dam' |
  'gauge' | 'river' | 'other', name, nodeId, nodeName, geometry, properties,
  areaM2, nonContributingM2, damPosition, center: [lon, lat], sourceId, createdBy, createdAt, updatedAt }`.
  `damPosition` (194) is a dam polygon's position against its river as an
  editor said: `on_channel` (on the watercourse), `off_channel` (an
  off-channel storage dam, filled by a pump or a furrow) or `null` (not
  said: its outline decides); always `null` for anything else. Start and
  Divide place the dam by it (§ Start from the map, Placing the points).
  `nonContributingM2` (195): of `areaM2`, what drains into pans, for a
  feature made from a delineation (an accepted proposal, a saved
  sub-catchment, a Start or Divide parcel); `null` when unknown, and again
  after a new outline or a split.
  `areaM2` is the geodesic area of a polygon (WGS84 ellipsoid), `null` for
  points and lines (a parcel saved from a delineated piece: the piece's
  area from the DEM's cells, its outline simplified); `center` is a point itself, a polygon's centroid (its
  largest part's), a line's middle vertex; `properties` holds only
  `description` and `ref` from a file. A boundary or parcel is a Polygon or
  MultiPolygon, a gauge a Point, a river a LineString or MultiLineString, a
  dam a Point or polygon, `other` any of these. A parcel or dam stands for a
  farm or water user, a gauge for a gauge; a boundary or river for nothing.
- `QuaternaryProposal = { code, dataset, synthetic, areaKm2, mapMm, marMm3,
  monthlyMm3 (12, Oct … Sep, Mm³) | null, periodStart, periodEnd, source,
  loadedAt }`. `synthetic` is true for the repo's invented dataset. The
  client fills the WR2012 check's form from it value by value; saving goes
  through `PATCH /projects/:id` like any typed value.
- `RegisterDamProposal = { registerNo, name, river, farm, lon, lat,
  distanceM, capacityM3, wallHeightM, surfaceAreaM2, completionYear,
  dataset, synthetic, source, loadedAt }`, from `dam_register_reference`
  (154). `synthetic` is true for the repo's invented register. The wall
  height and completion year are for reference: the model has no field for
  them. A capacity or area accepted from a proposal is an ordinary model
  value afterwards: a later typed change replaces it (History keeps both).
- `CroplandDataset = { dataset, source, version, method, attribution,
  cellDeg, classes, loadedAt, synthetic }`, from `cropland_dataset` (173);
  `method` is the counting in words, cited with every accepted value.
  `CropAreaFromLandCover = { areaM2, dataset, source, version, method,
  basis: 'unit' | 'parcel', featureName, acceptedAt, current }`: `current`
  while the unit's planted area for that crop still equals `areaM2` (a typed
  change replaces it; History keeps both).
- `EvaporationDataset = { dataset, kind: 'et0' | 'apan', source, version,
  method, attribution, firstYear, lastYear, cellDeg, originLon, originLat,
  loadedAt, synthetic }`, from `evaporation_dataset` (180). `EvaporationAccepted
  = { target: 'pe' | 'apan', monthlyMm, dataset, kind, source, version,
  method, coverage, acceptedAt, current }`: `current` while the saved
  settings still hold `monthlyMm` (to 0.05 mm; a typed change replaces it,
  History keeps both).
- Each write is in the audit log (`map.imported`, `map.feature_created`,
  `map.feature_changed`, `map.feature_deleted`, `map.feature_split`: ids, kind, name, never the
  geometry; delineation's `map.delineation_*` in [§ Delineation](#delineation)). Farmers and applicants get `403` on every route here (RLS lets
  them read the boundary, gauges, rivers and their own farm's features, for a
  later farm view).

## Delineation

A catchment proposed from the DEM upstream of a clicked point, then accepted
or rejected (issue #326 B-delineate, `175_delineation.sql`,
`backend/src/delineation/`, [maps.md § Delineation](./maps.md#delineation),
[design/delineation.md](./design/delineation.md)). Off while the server's
`DEM_URL` is empty. Nothing here changes the model: an accepted polygon is a
map feature like any other.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/map/delineation` | – | `{ available, dataset: { label, attribution, fingerprint, tileType, maxZoom, bounds: [w, s, e, n] } \| null, proposals: DelineationProposal[], request: DelineationRequest \| null }`: the newest 10 proposals, any status, and the project's newest delineation still with the background worker (queued or running), else null. `available` is false (and `dataset` null) when `DEM_URL` is empty or the DEM can't be read | viewer |
| POST | `/projects/:id/map/delineation` | `{ lon, lat, from: 'outlet' \| 'dam_wall', keepPoint?: boolean, background?: boolean }` (strict: another field, such as the `reach` older clients sent, is `400`) | `202 { request: DelineationRequest }` when the catchment runs past the request's largest window (3 072 cells, about 100 km, placed over the catchment), or past its 20 s, or with `background: true` (straight to the worker, skipping the request's own attempt): the worker's `delineate` job goes on from the next window, up to 6 144 cells (about 200 km), and the outcome lands on the request (below). Otherwise `201 { proposal }`, the project's one open proposal (the previous open one becomes `superseded`). `422 { error, details: { reason } }` when the DEM refuses, `reason` one of `outside` (the point is outside the DEM), `no_data` (the catchment reaches where the DEM has no data), `off_channel` (no terrain channel, a cell with at least 1 km² draining through it, within 150 m of the point: "No terrain channel runs within 150 m of that point. Zoom in until the terrain channels (the red lines) show, and click on one …"), `too_large` (it runs past the largest window and the worker has no larger one; the worker's own refusal at its cap is on the request instead), `too_small` (almost nothing drains there), `outline` (no valid polygon), `larger_channel` (a terrain channel with 100× the placed cell's upstream area runs within 1 km: `details.larger = { at: [lon, lat], distanceM, km2, pointKm2 }`, its nearest cell; send that point, or the same one with `keepPoint: true`); nothing is saved. The outlet goes on the terrain channel nearest the point within 150 m (`place.ts`, issue #472); the mapped river network never places it, and is read only to word a `too_large` or `larger_channel` sentence with the nearby reach's own area. Before `delineate-13` the outlet was matched to a nearby river reach's area, a `confluence` refusal asked which river (the body's `reach` answered it), and the 201 carried a `check` sentence; all three are gone. `409` when delineation is off, or a second delineation finished at the same moment; `429` past 30 a project an hour, or past the account's elevation-model cap (2 running at once, 60 an hour across projects, shared with start and divide, refused attempts included, a request for the background as well; security.md § Map uploads), or for a delineation that would go to the worker while the account has one running, or waiting in another project (one per account; a new one in the same project supersedes the waiting one); `503` when the DEM can't be read | editor |
| POST | `/projects/:id/map/delineation/:pid/accept` | `{ as: 'catchment_boundary' \| 'other', replaceBoundary?: boolean, name?: string }` | `200 { proposal, feature: MapFeature, summary }`: a new map feature of that kind with the proposal's polygon and area, named `name` or "Catchment above the outlet (delineated)" / "… the dam wall …", its description naming the dataset and method version. As the boundary when the project has one: `409` naming it unless `replaceBoundary: true` (then it replaces it). `409` for a proposal that isn't open | editor |
| POST | `/projects/:id/map/delineation/:pid/reject` | – | `200 { proposal }`; `409` for one that isn't open | editor |
| GET | `/projects/:id/map/delineation/requests/:rid` | – | `200 { request: DelineationRequest }`: a delineation the worker has, as it is now; `404` for one of another project | viewer |

- `DelineationProposal = { id, status: 'proposed' | 'accepted' | 'rejected' |
  'superseded', from, click: [lon, lat], outlet: [lon, lat], snapDistanceM,
  geometry (a Polygon), areaM2, cells, cellSizeM, zoom, windowCells,
  dataset, datasetFingerprint, method, methodVersion, pans, featureId, createdBy,
  createdAt, decidedBy, decidedAt }`. `outlet` is where the click snapped to;
  `featureId` the accepted feature (`null` again once it is deleted).
  `pans` (193, delineate-9; null on older proposals) = `PanReport = {
  nonContributingM2, count, largest: { at: [lon, lat], floorM2, depthM,
  drainsM2, storageMm }[] (at most 5, the largest catchment first), onRiver?,
  method }`: what of the catchment drains into pans (closed depressions at
  least 1 m deep, 0.1 km² in floor, holding at least 100 mm of their
  catchment's runoff), reported beside `areaM2` and never taken out of it or
  the polygon ([design/delineation.md § Pans](./design/delineation.md#pans)).
  `onRiver` (delineate-12, start-14; absent before) = `{ count, largest: {
  …the same, by: 'river' | 'dam' }[] (at most 5) }`: the depressions that
  pass the pan tests but are storage on a river (a mapped river flows out
  over a wall, or a dam holds it), not counted in `nonContributingM2`.
- `DelineationRequest = { id, status: 'queued' | 'running' | 'failed' |
  'proposed' | 'refused' | 'superseded', from, click, progress, error,
  proposal, refusal, createdAt, finishedAt }` (191_delineation_request):
  `queued` / `running` while its job waits or runs (`progress` 0–100 while it
  runs, a step a window); `proposed` with `proposal` (the project's open
  proposal it made, decided by the routes above; `null` once pruned);
  `refused` with `refusal = { reason, message, larger? }`, the
  reasons and sentences of the request's own 422 (and `off` when the DEM went
  away first); `failed` when the job died (its `error`); `superseded` when the
  same editor clicked again before it ran. The Map asks every 2 s while it
  waits.
- Each write is in the audit log (`map.delineation_proposed`,
  `map.delineation_accepted`, `map.delineation_rejected`: ids, the click's
  kind, the area, the dataset; never the polygon; `background: true` on one
  the worker made, as the editor who queued it). A stranger gets `404`.

### The elevation model's channels

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/map/channels?tile=i,j` | – | `200 { tile: [i, j], bounds: [w, s, e, n], minKm2, lines: { coordinates: [lon, lat][], km2 }[], cellSizeM, dataset: { label, fingerprint }, cached }`: one 0.2° tile (i = floor(lon / 0.2), j = floor(lat / 0.2)) of the DEM's channels, each line from a stream head or confluence to the next, `km2` the window-local upstream area at its lower end (maps.md § The elevation model's channels). `400` for a missing or malformed tile, `409` when there is no DEM, `422 { error }` outside it, `429` past the account's elevation-model cap (a computed tile counts; a cached one doesn't), `503` when the DEM can't be read | editor |

### Sub-catchments from clicks

Each click on a river is an outlet, and its piece is its incremental
catchment: the land whose water reaches it before any other click
(`backend/src/delineation/clicks.ts`, [maps.md § Sub-catchments from
clicks](./maps.md#sub-catchments-from-clicks)). The lowest click (the one
most water drains through) owns everything else above it. Nothing is stored
until **save**, which routes the same clicks again and never takes a
geometry from the request. Off while `DEM_URL` is empty (`GET
…/map/delineation`'s `available` says so).

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/map/subcatchments` | `{ clicks: { lon, lat }[] }` (1 to 50) | `200 ClickPieces`; nothing is stored. `422 { error }` with a sentence when the DEM refuses (the clicks outside it, a click with no terrain channel within 150 m, naming it, the lowest click's catchment past the largest window, about 100 km, almost nothing draining to it, no valid outline); `409` when it is off; `429` past the account's elevation-model cap (shared with delineate, start and divide, counted as delineation); `503` when the DEM can't be read | editor |
| POST | `/projects/:id/map/subcatchments/save` | the same | `201 { features: MapFeature[], dropped, summary }`: one `other` polygon per whole piece with an outline (inflow points are not saved; the summary names them), named "Sub-catchment *n*" (*n* its click's number), its area from the polygon and its description the outlet, where it drains, the area upstream, the dataset and the method version. The same refusals; `422` when no piece could be outlined | editor |

- `ClickPieces = { pieces: ClickPiece[], dropped: { click, reason }[],
  lowest, cellSizeM, dataset: { label, fingerprint }, method, methodVersion }`;
  `ClickPiece = { click, point: [lon, lat], snapDistanceM, drainsInto,
  geometry (a Polygon, or null when its cells couldn't be outlined), areaM2,
  totalAreaM2, nonContributingM2, open, larger }` (`nonContributingM2`: of its own area,
  what drains into pans, start-11, null when open; a saved piece's description says it).
  A click is `{ lon, lat }` and nothing else (strict: the `reach` older
  clients sent is `400`); since `start-15` (issue #472) there is no
  `confluence` question, and a piece has no `placedBy`, `reach` or
  `unmatched`. `click` and `drainsInto` are indexes into the request's
  clicks (`drainsInto` null for the lowest); `point` is where the click
  went, on the terrain channel nearest it within 150 m; `totalAreaM2`
  everything upstream of it. `open`:
  an inflow point, its catchment past the routed window (about 100 km) or
  the DEM's data, with `geometry`, `areaM2` and `totalAreaM2` null; the
  totals of every piece below an inflow point are null too. Only when every
  click is open is the request refused (422). A click
  that doesn't drain to the lowest one (another river) or snaps onto the
  same cell as another is in `dropped` with why. The method is Start from
  the map's (`start-11`; every `areaM2` and `totalAreaM2` is summed from
  the DEM's cells, each at its own area on the ellipsoid, so the pieces add
  up to the catchment exactly; `geometry` is simplified for the map and its
  own area may differ a little). `larger` is a much larger terrain channel
  beside a click (`{ at, distanceM, km2, pointKm2 }`, as Delineate's
  refusal), else null. The click stays where it snapped; the client offers
  the channel.
- Save is in the audit log (`map.subcatchments_saved`: the features' ids,
  how many, the inflow points left out, their area, the dataset; never a
  polygon). The preview is not
  (it changes nothing). A stranger gets `404`.

## Start from the map

An empty model started from the map (issue #326 C3, `178_start_proposal.sql`,
`backend/src/delineation/start.ts` and `subcatchments.ts`, [maps.md § Start
from the map](./maps.md#start-from-the-map),
[design/start-from-map.md](./design/start-from-map.md)): the server proposes
units at the map's dams and abstraction points, each unit's own
sub-catchment (area and outline), who drains into whom, and the rest of the
catchment; the editor applies the values they tick. With `DEM_URL` empty the
proposal has the units only (no areas, everything draining into the outflow
gauge), and the rest of the catchment is the boundary. A model that has
nodes is **divided** instead (`182_divide_proposal.sql`,
`backend/src/delineation/divide.ts`): each point stands for a node, and its
own area, drains-into and runoff to its dam are proposed beside the node's
values now, taken only when ticked.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/map/start` | – | `{ elevation, dataset \| null, modelEmpty, startedFromMap, proposals: (StartProposal \| DivideProposal)[] }`: the newest 5 of either mode, any status. `elevation` is false when `DEM_URL` is empty or the DEM can't be read; `modelEmpty` whether the model has no nodes; `startedFromMap` whether a start proposal was ever applied | viewer |
| POST | `/projects/:id/map/start` | `{ outletFeatureId?: uuid \| null, outletUseLarger?: boolean, points: { featureId, role: 'dam' \| 'abstraction' \| 'user' \| 'gauge', useLarger?: boolean }[] }` (at most 50, each once; `useLarger` below the table; strict, so the `outletReach` and `reach` older clients sent are `400`) | `201 { proposal }`, the project's one open proposal (the previous open one, of either mode, becomes `superseded`). The outlet is the gauge point named, else the boundary's (its delineation's outlet when it came from Delineate, else the most-drained cell inside it). A point is a dam (a point or a polygon), or a gauge or other point; `gauge` (a gauge node in the order, owning no land) is a gauge point's only. Without a DEM a point outside the boundary is dropped. `400` for no boundary and no outlet, an outlet that isn't a gauge point, a `gauge` role on anything but a gauge point, or a feature not on this map; `409` once the model has nodes, or a second proposal finished at the same moment; `422 { error, details: { reason } }` when the DEM refuses (`outside`, `no_data`, `too_large`, `too_small`, `outline`, as delineation's, and `off_channel` for an outlet gauge with no terrain channel within 150 m: "No terrain channel runs within 150 m of the outlet. …"; any other point with none is dropped, not refused); `429` past 30 a project an hour, or the account's elevation-model cap (as delineation's); `503` when the DEM can't be read | editor |
| POST | `/projects/:id/map/start/:spid/apply` | `{ outletName, units: { key, name, area, areaBasis?, drainsInto, runoffToDam, upstreamToDam? }[], rest: { include, name, area, areaBasis? } }`, every proposed unit once | `200 { proposal, model }`: the outflow gauge, one node per unit (a user point a `user` node, a gauge point a `gauge` node), and the rest of the catchment if included, in one model revision ("Started from the map: …", saying which areas were gross and which effective). Only what is ticked is taken: a ticked area is saved as the unit's `farm_parcel` (linked, its description naming the dataset and method, with the piece's `nonContributingM2`) and becomes its area with `area_source = 'map'`: the piece's gross area, or with `areaBasis: 'effective'` (195) the piece less what drains into pans (`400` without the area ticked or a pans figure); an unticked one stays 0; an unticked drains-into is the outflow gauge; `runoffToDam` sets `pctRunoffToDam` to 1, or to a marked dam's `damShares.pctRunoffToDam` (dam units only); `upstreamToDam` sets `pctUpstreamToDam` to `damShares.pctUpstreamToDam` (a unit with `damShares` only, else `400`). Each point is linked to its node. `400` for ticks that don't match the plan, a value ticked that wasn't proposed, or two nodes of one name; `409` for a proposal that isn't open, a division, or a model that has nodes | editor |
| POST | `/projects/:id/map/start/:spid/discard` | – | `200 { proposal }` (a start or a division; audited as `map.start_discarded` or `map.divide_discarded`); `409` for one that isn't open | editor |
| POST | `/projects/:id/map/divide` | `{ outletFeatureId?: uuid \| null, outletUseLarger?, points: { featureId, nodeId: uuid \| null, useLarger? }[] }` (1 to 50, each feature once, each node once; `nodeId` null = a new gauge node, a gauge point only) | `201 { proposal }` (`mode: 'divide'`), superseding the open one. The outlet is a gauge linked to the model's outflow (or unlinked), else the boundary's, as starting; the outflow is the model's one node that drains nowhere. Each point's role comes from its node (a `user`, a `gauge`, a `farm` with a dam or at a dam point, else an abstraction point). `400` for a point standing for the outflow, for a node its kind can't stand for (map_feature's `KIND_NODES`), or for another node than the one it is linked to, a feature not on this map, a model without exactly one outflow; `409` for an empty model; `422 { error, details: { reason } }` with `reason: 'no_dem'` when `DEM_URL` is empty, or the DEM's refusals as starting's (`off_channel` included); `429` (shared with starting, and the account's elevation-model cap); `503` | editor |
| POST | `/projects/:id/map/divide/:spid/apply` | `{ units: { key, area, areaBasis?, drainsInto, runoffToDam, upstreamToDam?, add, name? }[], rest: { to: 'none' } \| { to: 'node', nodeId, areaBasis? } \| { to: 'new', name, areaBasis? } }`, every proposed point once (`add` and `name` a new gauge's only) | `200 { proposal, model }`, one model revision ("Divided from the map: …", saying which areas were gross and which effective). Only what is ticked changes: a ticked area becomes the node's (`area_source = 'map'`, saved as its `farm_parcel`, "<name>: own sub-catchment", with the piece's `nonContributingM2`; a parcel an earlier start or division made for it is redrawn in place, even when the area taken changes): the piece's gross area, or with `areaBasis: 'effective'` (195) the piece less what drains into pans (`400` without the area ticked or a pans figure); a ticked drains-into is the proposed point's node (a new gauge's when added) or the outflow; `runoffToDam` sets `pctRunoffToDam` to 1, or to a marked dam's `damShares.pctRunoffToDam` (dam units); `upstreamToDam` sets `pctUpstreamToDam` to `damShares.pctUpstreamToDam` (a unit with `damShares` only; `current.pctUpstreamToDam` is checked like the others); `add` makes the new gauge a `gauge` node (draining into the outflow unless its order is ticked); the rest's area goes to one of the plan's `untouched` units, or a new unit draining into the outflow. Unlinked points are linked to their nodes. `409` for a ticked value whose current one changed since the proposal (the plan keeps each node's `current` values, and the rest's candidates' areas), a node gone, an outflow that moved, a proposal not open, or a start proposal; `400` for ticks that don't match the plan, a value not proposed, an order into a new gauge not added, a loop, a clashing name, or a rest node that is one of the points | editor |

- `StartProposal = { id, status: 'proposed' | 'applied' | 'discarded' |
  'superseded', plan, fromDem, dataset, datasetFingerprint, method,
  methodVersion, decision, createdBy, createdAt, decidedBy, decidedAt }`.
  `plan = { fromDem, outlet: { featureId, name, point, snapDistanceM,
  foundIn, placement }, catchment: { areaM2, boundaryAreaM2 }, units: StartUnit[]
  (upstream first), rest: { name, areaM2, geometry, nonContributingM2? }, pans?: PanReport, dropped: { featureId,
  name, reason, placement? }[], warnings: string[], cellSizeM, zoom, windowCells }`;
  `StartUnit = { key (the feature's id), featureName, role, name, point,
  snapDistanceM, areaM2, totalAreaM2, geometry, drainsInto (a key, or null
  for the outflow gauge), drainsIntoProposed, placement, nonContributingM2?,
  totalNonContributingM2? }`. The pans' figures (start-11; absent without a
  DEM and on older plans): what of the catchment, the rest, each unit's own
  piece and its whole catchment drains into pans, reported beside the areas
  and never taken out of them; a warning says it in words. `decision` (once applied):
  the ticks, the node and parcel ids made, the revision id. Every proposal
  carries `mode: 'start' | 'divide'`.
- `DivideProposal` = the same with `mode: 'divide'` and `plan = { mode,
  outlet: { featureId, nodeId, name, point, snapDistanceM, foundIn, placement },
  catchment, units: DivideUnit[] (upstream first), rest: { areaM2, geometry,
  nonContributingM2? }, pans?: PanReport, untouched: { nodeId, name, areaKm2 }[] (farm nodes no point stands for, the ones the rest may go to, with their area when proposed),
  dropped, warnings, cellSizeM, zoom, windowCells }`; `DivideUnit = { key,
  featureName, nodeId (null: a new gauge), name, role, point,
  snapDistanceM, areaM2, totalAreaM2, geometry, drainsInto, current: {
  areaKm2, areaSource, downstreamNodeId, downstreamName, pctRunoffToDam } \|
  null, placement, nonContributingM2?, totalNonContributingM2? }`. A gauge's or user's `areaM2` and `geometry` are null (they own no
  land); a gauge's `totalAreaM2` is what it measures.
- **Placing the points** (`start-15`, issue #472; `delineation/pointPlacement.ts`,
  `place.ts`): with a DEM, the outlet gauge and every map point are put on
  the terrain channel nearest them within 150 m (a cell with at least 1 km²
  draining through it), as Delineate puts a click; the mapped river network
  never places them. An outlet gauge with none within 150 m is refused
  (422 `off_channel`); any other point with none is in `dropped` with the
  reason "has no terrain channel within 150 m: move it onto one of the
  elevation model’s channels". `placement = { placedBy: 'snapped' \|
  'larger' \| 'exact' \| 'polygon' \| 'boundary', larger: { at, distanceM,
  km2, pointKm2 } \| null, damPosition? }` (`snapped`: on the nearest terrain channel; `exact`: a delineated outlet kept
  on its own cell; `polygon`: a dam polygon's outflow, its most-drained
  cell, or, when the outline only clips a much larger channel, its own
  footprint's, that channel in `larger` with `outline: true` (`start-10`);
  a dam whose feature has a `damPosition` is placed by it instead, with
  `damPosition` in its placement and nothing in `larger`: `on_channel`, the
  outline's most-drained cell; `off_channel`, on the river where the dam's
  own outflow (the most-drained outline cell carrying under 100× the
  outline's cells) joins it within 1 km (one whose whole outline lies on
  the river is dropped, saying so). Such a unit carries `damShares: {
  pctUpstreamToDam: 0 | 1, pctRunoffToDam, damCatchmentM2,
  pctRunoffToDamEffective?, damNonContributingM2? }` (on the river
  1, 1, null, 1; off-channel 0, what drains to the dam's outflow ÷ the unit's
  area, that area, and with the area taken effective (195) both less their
  pans, the dam catchment's pans), the values `upstreamToDam` and `runoffToDam` take on
  apply; a Divide unit's `current` has `pctUpstreamToDam` (194);
  `boundary`: the boundary's; null without a DEM; absent on proposals
  before `start-7`; plans from `start-7` to `start-14` can also hold
  `placedBy` `matched` or `junction`, with `reach` and `unmatched`, from the
  mapped river's rules `start-15` retired). A point beside a channel with 100× its
  upstream area carries it in `larger` and a sentence in `warnings` (the
  outlet's first); proposing again with that point's `useLarger: true`
  (`outletUseLarger` for the outlet gauge; for a dam polygon, the channel
  its outline clips) puts it on that channel, which
  the server finds again (`placedBy: 'larger'`); a dropped point carries
  its `placement` too, so one placed on a small stream beside its river can
  be moved onto it the same way. The proposal's `method` names only the
  rules that ran.
- Each write is in the audit log (`map.start_proposed`, `map.start_applied`,
  `map.start_discarded`, `map.divide_proposed`, `map.divide_applied`,
  `map.divide_discarded`: ids and counts; never a polygon). A stranger gets
  `404`.

## Notes

Plain-text notes and comments on a node, a run, a settings group, a
scenario, an evidence pack or the project (WP-2.7, WP-3.15;
[data-model.md § Notes](./data-model.md#notes-037_notessql)). The min role is
**farmer** on every route, and RLS does the scoping: a farmer reads and
writes only `farm` notes on their linked farms, and never sees a `team`
note. A scenario's notes have three more audiences, `assessors`, `parties`
and `public_participation`; who reads and writes each is the matrix in
data-model.md. A pack's notes (128) are `team` (whoever reads the pack) or
`public_participation` (any member contributor and up while the pack is
issued with a live pack link).

| Method | Path | Body / query | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/notes` | `?nodeId=&runId=&settingKey=&scenarioId=&packId=&target=project\|node\|run\|setting\|scenario\|pack&limit=1..500` (default 100) | `{ notes: Note[] }`, newest first; deleted notes are never listed. `settingKey` matches the key and its sub-keys by whole segment (`flow` → `flow`, `flow.a`, not `flowshare`) | farmer |
| GET | `/projects/:id/notes/counts` | – | `{ project, nodes: { [nodeId]: n }, runs: { [runId]: n }, settings: { [key]: n }, scenarios: { [scenarioId]: n }, packs: { [packId]: n } }`: the notes the caller can see, per target (the count badges) | farmer |
| POST | `/projects/:id/notes` | `{ body: 1–4000 chars (trimmed), nodeId? \| runId? \| settingKey? \| scenarioId? \| packId?, visibility?: 'team' \| 'farm' \| 'assessors' \| 'parties' \| 'public_participation' }` | `201 { note }`. At most one target (`400`). `visibility` defaults to `team`, or `farm` for a farmer; `farm` needs a farm node, `assessors` and `parties` a scenario, `public_participation` a scenario or a pack (`400`). A farmer may add only a `farm` note on their own farm (`403`); an unknown or invisible node or run is `404`. On a scenario (contributor and above): its default is the caller's natural audience (an assessor: `assessors`; one of its parties: `parties`; anyone else: `public_participation`); a scenario the caller can neither read nor comment on is `404`, an audience they may not post to `403` (`public_participation` needs the scenario open for comment, for everyone: a live scenario link, or decided after it was ever shared; codes `note_comment_closed` and `note_audience_denied`). On a pack (128; contributor and above): `team` (the default for a reader of the pack) or `public_participation` (the default for anyone else); a pack the caller can neither read nor comment on is `404` (a member who could once comment on a withdrawn or superseded one gets the `403 note_comment_closed`), `public_participation` while no pack link is live `403 note_comment_closed`, a scenario audience `400` | farmer |
| PATCH | `/projects/:id/notes/:noteId` | `{ body }` | `{ note }` with `editedAt` set. Author only (`403`) | farmer |
| DELETE | `/projects/:id/notes/:noteId` | – | `204`: a soft delete, recorded as `note.deleted`. The author or an editor (`403`); a deleted or unknown note is `404` | farmer |
| GET | `/projects/:id/notes/:noteId/revisions` | – | `{ note, revisions: { body, writtenAt, editedAt }[] }`: each earlier text of a scenario or pack note, oldest first (what it said from `writtenAt` until an edit replaced it at `editedAt`); read as the note is, so a note the caller can't read (or a deleted one) is `404`. Other notes keep no history (`[]`) | farmer |

- `Note = { id, body, author, createdAt, editedAt, target: 'project' | 'node' | 'run' | 'setting' | 'scenario' | 'pack', nodeId, nodeName, runId, settingKey, scenarioId, packId, visibility, mine, canDelete }`.
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
| POST | `/ingest/v1/series/merge` | the body of [`POST /projects/:id/series/merge`](#time-series) (`kind`, `name`, `unit`, `startDate`, `values`, optional `product` / `productVersion` / `dayBoundary`), plus an optional `source` (≤ 100 chars, a free label kept in the audit subject) | `200 { series: SeriesMeta, daysChanged, rerunQueuedFor: iso \| null, rerunHeld: HeldDays \| null, autoPublishHeld: boolean }`, `Cache-Control: no-store` |

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
- `autoPublishHeld`: `true` when the push changed days, wasn't held, and
  no outlier limit could be taken (`limitFrom` would be `null`: the series
  is too short to judge by, so only negatives were checked). The automatic
  re-run is queued as usual, but it isn't **published** by itself (even with
  `publish: 'if_no_new_warnings'`) until a person runs the model; the merge
  records `series.unchecked` as the key ([security.md § API
  keys](./security.md#api-keys)).
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
| GET | `/projects/:id/farm/:nodeId` | `FarmView = { project: { id, name, wuaName, timeZone }, today, farm: FarmProjection, context, publication, outlet30, stale, outlook, registered }` (below) | farmer |
| GET | `/projects/:id/farm/:nodeId/export.csv?from=&to=` | The farm's own daily CSV from the published run: `date` + the farm allowlist (`demand`, `supplied`, `deficit`, `dam_storage`, `spill`, `transfer`), the export CSV's rules ([Export](#export)), shaped for a farmer (issue #124): the header is those keys (the farm view's download words them in the reader's language and, for a decimal-comma language such as Afrikaans, writes `;` between cells, [ui.md § Farmer view](./ui.md#farmer-view-farm)), every figure is rounded to whole m³, and the window is the last 365 days to `dataUntil` by default; `from` reaches further back (to the run's first day) and `to` ends it earlier (`400` outside the run, `413` past 50 MB; streamed like every CSV, [Export](#export)) | farmer |
| GET | `/projects/:id/farm/:nodeId/series?key=&from=&to=` | `FarmSeries = { key, label, unit, startDate, values }`: one of the farm's own daily series from the published run, `key` one of the farm allowlist (`demand`, `supplied`, `deficit`, `dam_storage`, `spill`, `transfer`; any other `400`). The year to `dataUntil` by default (`from` = `to` − 364 days); `from` / `to` narrow it, clamped to the run's first day and to `dataUntil` (never into forecast days); `400` for a window outside the figures or over 3 653 days. `Cache-Control: no-store` | farmer |
| GET | `/projects/:id/farm/:nodeId/history` | `{ publications: FarmHistoryEntry[] }`: the farm in the WUA's last 12 publications (the current one and the ones it superseded), newest first. `FarmHistoryEntry = { publishedAt, current, dataUntil, season: { from, to, demandM3, suppliedM3, fraction, shortDays }, damPct, model: { headline, band }, restriction: { level, pct } }`: the farm's own figures from each stored projection, never the even share (a catchment ratio) or the notice text | farmer |
| GET | `/projects/:id/farm/:nodeId/map` | `FarmMap = { features: { id, kind, name, geometry, areaM2, center, credit? }[] }`: the farm's map (issue #326 A3): the parcels and dams linked to **this** farm, then the gauges, rivers and catchment boundary for orientation, never another farm's feature or an `other` one, and no node id, properties or author; `credit: 'hydrorivers'` (2026-10-02) on a river added from a HydroRIVERS reach, so the map shows that licence's credit (maps.md § Sources), absent otherwise. The query names the farm, so a viewer previewing it gets what its farmer gets. `{ features: [] }` when the farm has no parcel or dam on the map (the page shows no map). No status: the page colours the land from the farm view's own band. `404` for a farm the caller can't open. `Cache-Control: no-store` | farmer |
| GET | `/projects/:id/privacy-contact` | `{ wuaName, contact: { organisation, name, email, postal } \| null }`: "Who decides about your farm's information" (POPIA s18(1)(b), 168): the project's team's name and its privacy contact ([Teams](#teams)), for every member, farmers included, through `app_project_privacy_contact` (a farmer can't read the team row); nothing else about the team. `contact` is `null` for a project without a team or a team without a contact; `wuaName` as in `FarmIndex`. `404` for a non-member | farmer |
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
- `registered = { asOf, surfaceM3PerYear, groundwaterM3PerYear, storageM3 }`
  (issue #72): the farm's **own** registered water in force on `asOf`
  (today in the project's zone), read under the caller's RLS from the
  allocations on this farm, current rather than the publication's: the 21(a)
  takes summed per source (m³ a year, `null` when none; Schedule 1
  permissible use left out, since it isn't registered) and the registered
  storage (21(b) rows and storage on a take, m³, `null` when none stated).
  Never a holder's name, a registration number or a property. `null` when
  nothing is in force ([allocations.md § Who sees what](./allocations.md#who-sees-what)).
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
| GET | `/projects/:id/jobs?status=&limit=` | – | `{ jobs: JobMeta[] }`, newest first. `status` ∈ `queued`, `running`, `done`, `failed`, `dead` (`400` otherwise); `limit` 1–200, default 50. A contributor lists only their own yield jobs (RLS, 096), which is how the Yield panel follows one on the Applicant view | viewer (a contributor: their own yield jobs) |
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
| POST | `/projects/:id/yield` | `{ nodeId, runId \| scenarioId, kind, params? }` | `202 { jobId, job: JobMeta, created: true }`. The same request while one is pending (queued, or failed and waiting to retry) is `200 { jobId, job, created: false }` with that job: an editor's matches any editor's, a contributor's only their own (they can't see anyone else's job, so an assessor's pending one never stands for theirs). A contributor (an applicant) only with `scenarioId` of an application they own and `nodeId` their own farm or a dam its `node.add` or `node.insert` ops add (`403` for a run or an application that isn't theirs; a dam hidden from them is the `400` an unknown node gets). `409` for a forecast run (issue #51: a yield is judged on history; the Network tab offers only ordinary runs), and for a scenario whose base is one | editor, or a contributor on their own application |
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
  user**, across all their projects (`429`). Its `error` says where the
  running one is: "…in this project" when it's this project's, else "…in the
  project “*name*”, and only one at a time is allowed" (`pendingCalibrationMessage`,
  `calibration/store.ts`), so a run elsewhere doesn't read as running here. A project keeps its newest **20** runs of the rules (an
  applied one is never deleted). Each case job gets 2 attempts.
- `AutoCalibration = { id, trigger ('manual' | 'new_data'), status
  ('running' | 'complete' | 'failed'), rulesRevision, rules, plan: {
  flowKind, siteNodeId, validationRecord, years, ruleExclusions, notes, cases }
  (`siteNodeId` the calibration site the rules ran at, engine ≥ 1.41.0, `null`
  = the outlet, absent on older runs), cases:
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

## Assessments

Cumulative impact (roadmap WP-3.11, [scenarios.md § Cumulative
impact](./scenarios.md#cumulative-impact-wp-311)): several scenarios on one
base run, each alone and all together, run by one background `assessment`
job on the base run's stored input. **Editors only**: an assessment names
submitted applications, which neither contributors nor viewers read.

| Method | Path | Body | Response | Min role |
| --- | --- | --- | --- | --- |
| POST | `/projects/:id/assessments` | `{ name, scenarioIds, dryRun? }` | `202 { assessment: Assessment, jobId, job: JobMeta }`; with `dryRun: true`, `200 { check: { ok: true, conflicts: [], problems: [] } }` and nothing written | editor |
| GET | `/projects/:id/assessments` | – | `{ assessments: Assessment[] }`, newest first, **without** `report` | editor |
| GET | `/projects/:id/assessments/:aid` | – | `{ assessment: Assessment }` with its `report`; `404` for one that isn't this project's | editor |

- Body (strict): `name` 1–200 characters (trimmed); `scenarioIds` **2–8**
  distinct UUIDs (`ASSESSMENT_SCENARIOS_MIN`/`MAX`).
- Each scenario must be one the caller reads in this project (`404`: an
  application still a draft is its applicant's alone), a team scenario or a
  submitted or decided application (`409` for a withdrawn one), and all on
  one base run (`422 these scenarios are based on different runs …`). The
  base run is rebuilt from its stored input as for a scenario (`409` when it
  can't be).
- **Refused, never merged:** `422` when the scenarios don't combine, with
  `details: { conflicts, problems }`. A conflict is
  `{ reason: 'same_target' | 'removed_in_use', target, a, b, message }`,
  `a`/`b` = `{ scenario, scenarioId, opIndex, op }`; `problems` are lines
  naming the scenario (`"App B" alone: op 2 …`, or `"App B": op 1 …` for an
  op that applies alone but not on top of the others). The message says how
  many conflicts. Nothing is written.
- **At most 2 assessment jobs queued or running per user** (`429`; a dry run
  doesn't count). A job gets 2 attempts. A project keeps its newest **20**
  assessments; one goes with its base run.
- `Assessment = { id, name, baseRunId, baseRun: { id, label, createdAt },
  status, problems, report?, engineVersion, job, createdBy, createdAt,
  completedAt, members: AssessmentMember[] }`. `status`: `pending`, then
  `complete` (`report` is the engine's `CumulativeReport`), `refused` (the
  job found the scenarios no longer combine, or one doesn't apply alone;
  `problems` says why) or `failed` (the engine refused an input). `job` as
  for a sweep.
- `AssessmentMember = { id, position, scenarioId, name, origin, opsSha256,
  opCount, status, problems, startDate, endDate }`: the scenario's ops are
  **copied** when the assessment is written (by the database, never from the
  request), so a team scenario edited or deleted later (`scenarioId` then
  `null`) doesn't change it. `status`: `pending`, `done` (its run alone is
  stored), `problems` or `failed`.
- `CumulativeReport = { scenarios: [{ id, name }], rows: CumulativeRow[],
  warnings }`; a row is one measure at one EWR site (`siteNodeId` null = the
  outlet) or of the catchment (`site` null): `{ metric, siteNodeId, site,
  isOutlet, unit, higherIsWorse, baseline, singles[], combined,
  singleChanges[], sumOfSingles, combinedChange, interaction }`, a missing
  value `null` ([scenarios.md § Cumulative impact](./scenarios.md#cumulative-impact-wp-311)
  lists the measures).

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
| POST | `/projects/:id/feeds` | `FeedInput` | `201 { feed: FeedMeta }`. `409` if another feed already writes that series, or the project has 60 feeds (`MAX_FEEDS`: 20 before the shared CHIRPS cell cache, 208, made a feed per hydrological unit cheap), or the series holds another CHIRPS product or version (below) | owner |
| PATCH | `/projects/:id/feeds/:feedId` | any of `FeedInput`'s fields | `200 { feed }`. The fields sent replace the saved ones, and the whole is validated again (a new `source` needs its `config`). Saving makes you the feed's acting user; a new source, place or series clears its health. The version check below runs when the save changes the source, the product or the target; `replaceSeries: true` alone confirms replacing the current target | owner |
| DELETE | `/projects/:id/feeds/:feedId` | – | `204`. The series keeps its days | owner |
| GET | `/projects/:id/feeds/chirps/from-boundary` | – | The rain feed from the map's catchment boundary (issue #326 B-rain, [maps.md § Rain from the boundary](./maps.md#rain-from-the-boundary)): `{ boundary: { featureId, name, updatedAt, areaKm2 }, cells: { lat, lon, weight, share }[], rows, cellsKm2, insideKm2, method, apply, canApply }`. `apply` is what Apply would do: `{ action: "none", feedId }` (a CHIRPS feed reads this version already), `{ action: "update", feedId, targetKind, targetName }` (a CHIRPS feed whose series holds no days) or `{ action: "create", targetKind: "rain_chirps_mm", targetName }` (`""`, or `"CHIRPS boundary"` when that series holds a record). `409 { error, details: { code } }`: `no_boundary`, or `boundary_cells` (too big: over 100 cells or 25 rows; not a polygon; beyond 60°) | editor |
| POST | `/projects/:id/feeds/chirps/from-boundary` | `{ featureId, updatedAt, feedId?, targetName? }`, strict | Apply it: with `feedId`, `200 { feed }` gives that CHIRPS feed the cells (its product, start date and threshold kept); without, `201 { feed }` attaches a CHIRPS feed into `rain_chirps_mm` / `targetName` (default: the proposal's). The feed's `config` is `{ cells, boundary }` (`boundary` as in the proposal; only this route writes it, and the plain routes refuse it with `400`). Records `feed.configured` with `boundary: { featureId, name }` and `cells` (the count). `409`: `boundary_changed` (the boundary's id or `updatedAt` isn't the current one: another project's feature never matches), `no_boundary`, `boundary_cells`, `series_area` (the target series already holds a record: a feed never splices two areas), `feed_fetching` (with `feedId`: a fetch for that feed is still out, asked for with its old cells; the feed's row is held while it checks, so a late answer can't land under the new cells), a non-CHIRPS feed, the 60-feed cap; `404` for a feed not in the project | owner |
| GET | `/projects/:id/feeds/chirps/from-units[?product=sat\|rnl]` | – | Rain for each unit (issue #482, [maps.md § Rain for each unit](./maps.md#rain-for-each-unit)): `{ product, units, withoutPolygon, refused, canApply, maxFeeds }` (`maxFeeds`: the project's feed cap, `MAX_FEEDS`, so the UI keeps no copy). `product` is the one asked for, else the one every unit feed already reads, else `rnl`. `units: { nodeId, name, featureId, areaKm2, cells: { lat, lon, share, weight }[], feedId, seriesDays, action }[]`: each land unit (a farm with an area above 0) whose polygon (its farm parcel: the one its area came from, else its only one) gives cells; `feedId` its feed (`null` = none yet), `seriesDays` the days its own CHIRPS series holds, `action` what POST would do (`create`; `update`: its feed's series is still empty and the cells or the product differ; `none`: the feed reads the same product over the same cells, even from a redrawn parcel). `withoutPolygon: { nodeId, name }[]`: land units with no parcel. `refused: { nodeId, name, reason }[]`: several parcels and none its area; the cells can't be read (over 100 cells or 25 rows, beyond 60°); its feed's series already holds days of other cells or another product; it has a CHIRPS series of its own no feed writes; a series of the feed's name holds another record. Gauges and water users are never listed. `400` for another product | editor |
| POST | `/projects/:id/feeds/chirps/from-units` | `{ product?: "sat" \| "rnl", startDate?: "YYYY-MM-DD", nodeIds?: uuid[] }`, strict | `200 { created, updated, feeds: { nodeId, feedId }[], skipped: { nodeId, name, reason }[] }` (`created` and `updated` count the feeds changed; `feeds` lists every chosen unit's feed, those already up to date included): one CHIRPS feed per unit (every unit the proposal lists, or the `nodeIds`), each into `rain_chirps_mm` named `CHIRPS v3 (<product>) <unit name>` (a project's series are unique by kind and name), a series this route creates empty and sited at the unit before the first fetch. `product` defaults as in the GET; `startDate` to the product's first day (1981-01-01 `rnl`, 1998-01-01 `sat`; earlier is a `400 { details: { code: "start_date" } }`). The feed's `config` is `{ cells, unit: { nodeId, featureId, updatedAt, areaKm2 }, product, startDate }` (only this route writes `unit`; the plain routes refuse it with `400`). An `update` gives the feed the new cells or product (a product change renames its empty series). `skipped`: without `nodeIds`, the units refused or without a polygon. Records one `feed.configured` `{ action: "units", source, targetKind, product, startDate, created, updated, units: { nodeId, name, feedId, action, cells }[] }` when anything changed. `409 { error, details: { code } }`: `unit_refused` (a named unit is refused or has no polygon; `details.units` says why), `feed_limit` (past the 60-feed cap), `feed_fetching` (a fetch for a unit's feed is still out), `feed_changed` (a unit's feed was saved after the proposal was worked out); `400 unit_unknown` for a named node that isn't a land unit of the project | owner |
| POST | `/projects/:id/feeds/:feedId/run-now` | – | `202 { job: JobMeta, created: true }`: a `feed_fetch` is queued, due now, as you. One pending fetch per feed: while one waits, `200 { job, created: false }`, and a pending one waiting for later (a backfill's next window, a retry) is made due now. Rate-limited per feed (`RUN_NOW_RATE`, feeds/routes.ts): 6 presses that queue a fetch or pull a waiting one forward, then one more every 10 minutes; a press onto a fetch already due takes none. Past that, `429 { error, details: { retryAfter } }` with `Retry-After` (seconds), and nothing is queued or moved. `409` for a switched-off feed | editor |

- `FeedInput = { source, config, targetKind?, targetName?, schedule?, enabled?, replaceSeries? }`,
  strict (unknown fields are `400`):
  - `source` ∈ `chirps`, `chirps_gefs`, `dws`;
  - `config` for `chirps` / `chirps_gefs`: exactly one of `{ cells: { lat, lon, weight? }[] }`,
    1–100 cells in at most 25 grid rows (issue #326 B-rain raised it from 25, the box's limit), lat −60…60, lon −180…180, weight > 0 (default 1), or
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
  ([security.md § Render tokens](./security.md#render-tokens)). A pack's
  render session (an issued evidence pack's PDF, 119_pack_render) may `GET`
  only `/auth/me`, `/projects/:id/packs/:packId` and its `/signoffs`, with
  no query: not the project, its runs, the pack list or the pack's PDF.

## History

Change history and the audit log (WP-2.4, [data-model.md § Change history and audit log](./data-model.md#change-history-and-audit-log-030_historysql)).
Farmers get `403`.

| Method | Path | Body / query | Response | Min role |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/history` | `?before=<next>&limit=1..100&nodeId=&kind=&q=` | `{ items, next, historySince }`, newest first: model revisions (`type: 'revision'`, with their change lines, not the snapshot) and audit events (`type: 'event'`). `kind` is `revision`, an event kind (`series.replaced`) or its noun (`series`); `q` is the parameter filter's words (≤ 200 characters, the first 10 words, any order, any case): only revisions with a change line holding every word, on every page; events aren't filtered by it (the client writes their sentences and filters them); `next` is an opaque cursor (`<ts>\|<type>\|<id>`). `kind=publication` is the season decision log (issue #119): a `publication.*` event's `subject` holds the whole notice, the window, the run identity and `perFarm`, every unit's figures (viewers and above only, like every event). An event's `subject` is read as the caller may see it (`app_audit_subject`, 190): an `allocation.created/changed/deleted` without `registrationNo` and `volumeM3PerYear` for a viewer until an owner lets viewers read each volume ([Allocations](#allocations)) | viewer |
| GET | `/projects/:id/history/fields` | – | `{ fields: Record<key, { count, lastAt, lastBy, change, filter }> }`: per model input, how many saved changes changed it and the last one ([Field history](#field-history)) | viewer |
| GET | `/projects/:id/history/revisions/:revId` | – | `{ revision, preview }`: the revision with its `snapshot`, and what restoring it would change | viewer |
| POST | `/projects/:id/history/revisions/:revId/restore` | `{ reason? }` | `201 { revision, relink }`: the new revision, and the farmers to re-link to restored farms. `409` when nothing would change or the old model fails today's validation | editor |
| GET | `/projects/:id/runs/:runId/changes-since` | – | `{ changes, revisions }`: the net change of the inputs since the run (`diffInputs`, series by hash) and the model revisions made since it, newest first (≤ 100). To a viewer who can't read each registered volume, neither side has the allocations (no registered-volume line) | viewer |
| POST | `/projects/:id/runs/:runId/restore-inputs` | `{ reason? }` | `201 { revision, relink }`; `409` for a scenario run, or when nothing would change | editor |
| GET | `/projects/:id/series/:seriesId/revisions` | – | `{ revisions: { id, createdAt, createdBy, reason, startDate, length, …, siteNodeId }[] }` (kept: the newest 5, ≤ 180 days; `siteNodeId` = the flow record's gauge, or the rain's land unit (209), when the revision was kept, null = the outlet / the catchment, 085) | viewer |
| POST | `/projects/:id/series/:seriesId/revisions/:revId/restore` | – | the series' `SeriesMeta` (works for a deleted series by its old id; a flow record comes back at the site it had, `409` when that gauge is no longer in the model; a unit's own rain comes back at its unit, `409 { details: { code: "site_gone" } }` while that node is no longer a land unit, 209) | editor |

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
  `nodeChangeFields`; the longest matching label wins). The supply fields
  (`supplyRule`, `pumpCapacityM3Day`, `supplyTriggerPct`, `supplyStopPct`)
  and the operating rules (engine ≥ 1.32.0: `handsOffEwr`, and the monthly
  `handsOffM3Day` and `divertMonthlyM3Day`, whose `change` is the engine's
  full row, "none → 0, 0, …, 800 m³/day (Oct–Sep)") are keyed too.
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
  a: { project: { id, name, ewrHeadline }, run: RunMeta & { summary: RunSummary, inputs: RunInputsSnapshot }, scenario: CompareScenario | null },
                                // ewrHeadline: the project's current Settings → Judge results by (issue #444), as GET /projects/:id gives it
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
| `/projects/:id/runs/:runId/export/daily.csv` | `nodeId?`, `from?`, `to?` | `date` + every daily series of that node (catchment when `nodeId` is omitted), one row per day. Catchment columns follow `CATCHMENT_ORDER` in `backend/src/export/run-tables.ts`: … rain used, final catchment rainfall, CHIRPS as uploaded, bias-corrected CHIRPS, the day's CHIRPS factor, … A farm's columns follow the FarmTemplate letters (`FARM_COLUMNS` in `packages/engine/src/verify/columns.ts`): gross demand, effective rain used, the soil-water store (mm, engine ≥ 0.14.0), F (crop requirement), D (abstraction demand, engine ≥ 0.16.0), G, H, I, the runoff removed by land cover (only a farm with land cover; I + it = natural flow × share), J, K … O, the dam's area, rain on it, evaporation and seepage (engine ≥ 0.16.0), P, Q, R, S, T, U, the balance check V, W, Y … AB (AB is the reach shortfall, a diagnostic from engine 0.17.0), then `ewr_charge` and `ewr_charge_irrigation` (engine ≥ 0.17.0), the letter in brackets in each header (`Irrigation supplied [G] (m³/day)`); a gauge's use the GaugeTemplate letters. Runs before engine 0.12.0 have no working columns (K–P, S, T, V, gross demand, effective rain). A **forecast run** (WP-2.12) leads with `forecast (F = modelled on forecast rain)` after `date`: `F` on each day from `summary.forecast.from`, empty before; the observed flow quality flags (`observed_flow_quality`, engine ≥ 1.48.0, only when a day is flagged) follow the observed records and their gap fill, as class codes the header spells out (`Observed flow quality flag (0 = in the gauged range, …, 6 = missing)`), in the catchment file or, at a calibration site, the gauge's; and every run with rain has the `Rain source` column in its catchment file (`rain_source`: with rain-source periods from engine 0.30.0, in every run with rain from 1.27.0). So does `farms.csv`, and the `.xlsx` workbook's daily sheets lead with `forecast (1 = modelled on forecast rain)`, 1 or 0 |
| `/projects/:id/runs/:runId/export/farms.csv` | `key`, `from?`, `to?` | `date` + one column per farm of the run, in the run's farm order (upstream first, the order of `RunSummary.farms`), for one farm series `key` (any key of `FARM_COLUMNS`, the optional ones included, e.g. `landcover_reduction`; `400` otherwise). `key=runoff` is the workbook's `[Fragmented flow]` sheet (column I), `key=ewr` its `[Fragmented EWR]` sheet (column Y). Each header is the farm's current name, then the letter and unit (`Farm A [I] (m³/day)`); a farm deleted from the model since the run keeps its column under the name the run knew (a run keeps all its series, migration 024), and a farm without that series (a dam column on a farm with no dam) is left out. `404` when no farm has the series |
| `/projects/:id/runs/:runId/export/summary.csv` | – | Run details (the engine version, then `Runoff model` as the run's settings had it; ending with `Run notes`, the run's written explanation, empty when there is none, `Notes last changed` with the time and name when there is one, and the evidence nomination: `Evidence nomination` = `the nominated evidence run` / `nominated before, since replaced` / `not nominated`, then `Nominated,<time>,<name>,<reason>` and, for a replaced run, `Replaced by,<run label>,<time>,<name>,<reason>`), the self-checks (each check passed/FAILED with its first problem, and the largest daily balance check), per-farm summary table (first `Flow share (%)`, the farm's share of the natural flow and of the EWR as the run applied it, engine ≥ 0.27.0, empty on older runs; then the averages, `Dam capacity (m³)` from the run's own model so storage can be checked against it (and, only when some dam's capacity changes over the run, engine ≥ 1.30.0, issue #67, `Dam capacity on the last day (m³)`, what its end storage is within), and, engine ≥ 1.2.0, the dam's storage figures under labelled headers), catchment figures (the runoff coefficient labelled, and with an observed record the outlet EWR test on the observed record vs the simulated outflow, the whole record then each water year: counts, hit rate, false-alarm ratio, frequency bias), the water balance per water year and for the whole run (its equation row names only the terms the run has, each of them a column, storage set by a storage reset included), the curtailment table over the reporting window (every column unrounded, with a row naming the EWR attribution rule, engine ≥ 0.17.0: the EWR charge, its irrigation and storage parts, the supply cut and the EWR site setting it, then `demand_pct_note` — `no_demand`, `below_floor` for demand under 1 m³/day, or empty — and the EWR cut beyond the equitable share; the equitable share is labelled a fairness benchmark, `Above (−) / below (+) equitable share` instead of reduce/gain, and the table ends with the fixed footnote `EQUITABLE_SHARE_FOOTNOTE`, "… Not an allocation or licence condition.", audit Q11), the land-cover reductions (engine ≥ 0.24.0, only with land cover: the low-flow threshold, the mean and its share of natural flow, per class the condensed area, reduction and mm/yr), the other water users (engine ≥ 0.22.0, only when the run has any: whole-run means, then the reporting window's EWR charge, whether each is curtailed and its supply cut), the EWR sites (days not met, shortfall, charged to farms, natural; from issue #45 every EWR charge, charge part, other user's charge and site shortfall is written as the positive volume charged, the column headers saying "m³/day charged" or "positive", the curtailment R header "workbook R × −1"), Reserve compliance by month (engine ≥ 0.21.0; `Not assessed: …` without a rule table; otherwise per site the table's source, coverage, unit, natural-percentile source, scale and % points, months met, deficit, longest run not met, mean shortfall, the FDC check, from engine 1.19.0 (CR-29) the days below the day's requirement with the % of time and of volume not met and the EWR as % of natural MAR (with the low flows' share when the table has a low-flow grid), a row per month of the year, from engine 1.19.0 a row per month of the year from daily data (days assessed, days not met, time not met %, required and shortfall m³, volume not met %) and a row per month × % point of the EWR, natural and simulated flow-duration curves, and a row per complete month with its natural flow, condition, requirement, simulated flow and deficit), the assurance of supply (engine ≥ 0.32.0; `Not computed: run made before engine 0.32.0 …` in each block on older runs: `Assurance of supply (reporting window)` with the window, the annual threshold and a row per farm and user, then the time-based and volumetric reliability by month; `Stress classes by month (supplied ÷ demand)` with the thresholds and, for all farms and users then each one, a row per water year of class and % per month; `Water account by water year (Oct–Sep)` with the in, out, storage, residual and memo columns per water year and the whole run, then the EWR required vs met per site), the 12 CHIRPS bias factors (month, factor, source, shared days) and what the fit left out, the catchment rain treated as missing, the rain-source periods (engine ≥ 0.30.0: one row per period with its reason, run days by source, the rain from the series, its factors' origin and fallback, then the factors Oct … Sep, then from engine 1.21.0 a `Daily intensity` row per period: the heavy-day threshold, the reference, the reference's, the series × factor's and (with a quantile map) the mapped heavy-day share as percentages, the band in points, whether they differ by more than it, and the quantile map in words or `none: the monthly factor alone`; `None: the catchment series throughout` without periods), the double-mass check against CHIRPS (engine ≥ 0.17.0: slope, segments, breaks, one row per water year), the plausibility checks (engine ≥ 0.25.0, `Run made before engine 0.25.0: …` on older runs: the dry season; natural vs observed + net abstraction per water year with the dams / land cover / use split, gap, tolerance and pass; EWR days not met for good-rain and fallback-rain years, the Reserve months met by the same split, one row per water year with its station days and fallback rain; the double-mass check of observed flow against rain with segments, breaks, the simulated slopes, the change beyond the model overall and by season and what it points to; the dry-season low-flow duration curves in m³/s at Q1 … Q99 with the Q90 comparison; the recession diagnostics (engine ≥ 1.19.0, `Run made before engine 1.19.0: …` on older runs: the record, segment count and settings, a, b, −dQ/dt ÷ Q at the reference flow, points and segments for the record and the simulated outflow, the rate ratio and b difference, and whether they agree, indicatively); the validation signatures (engine ≥ 1.55.0, `Run made before engine 1.55.0: …` on older runs, `Not computed: …` without an observed record: the scored record and site; the base-flow index by the Hughes et al. (2003) and Eckhardt (2005) filters with their parameters, days, stretches, observed, simulated, difference and whether within ±0.15; the low-flow FDC's days, observed and simulated Q70 and Q95, the slopes ln(Q70/Q95)/0.25, the slope bias %, %BiasFLV and whether within ±50 %; the held-out recessions' segments, every nth, held out, days scored, the law's a and b, the skill and log RMSE of the simulated flow and of the law, and whether the simulated skill is at least 0); then, engine ≥ 1.4.0, for each gauge with its own record an `At gauge <name>` line with its share of the natural flow and the naturalised and low-flow blocks again at that gauge; each part says `Not checked: …` when the run lacks what it needs), calibration (from engine 0.39.0 with `Parameters fitted on these days (fitted = in-sample scores)` = the `fitStatus`; every score under a label with its unit, never its raw key: the window, KGE with r, α and β, r², log-NSE and its ε in m³/s, volume error %, the record scored; then the calibration exclusions it applied, `From,To,Reason`, and the annual volumes on the observed days, water year, days, observed and simulated Mm³ and the difference %; from engine 1.19.0 the WR2012 statistics on monthly flows, CR-28: the complete water years, whether the bands are indicative, then MAR, mean of log10 annual flows, SD, log SD and seasonal index with observed, simulated, the difference %, the band and `yes`/`no`, or `Not computed: …` when no water year has all 12 months observed; never under the raw key `wr2012Fit`), the flow-duration percentiles (issue #45: the Runs tab's FDC table, from the same engine function, `views/fdc.ts` `fdcPercentileTable`: `Days ranked,Flow record,Q10 (m³/s),Q50 (m³/s),Q90 (m³/s),Q95 (m³/s),Days`, a `Whole run` row for natural flow, simulated outflow and the observed record, then, when the observed record misses some of the run's days, `Observed days only (n of N)` rows with natural and simulated ranked on only its days, the chart's default; unrounded; on a forecast run every row ranks only the days before the forecast, after a `The n forecast days are left out: every row ranks the N days before them` line, the first rows labelled `Whole run before the forecast`, issue #51; `No catchment flow series stored for this run` otherwise), a forecast run's forecast days (WP-2.12, only on a forecast run: first and last forecast day, days, last observed rain, forecast rain, outlet EWR days at risk, then per farm the lowest dam level expected (%), days short, demand, supplied and supplied % of demand; every other block covers the days before them), runoff from each unit's own rain (engine ≥ 1.78.0, only under `settings.unitRain` `perUnit`, [model.md §2.4h](./model.md): the gauge MAP and MAP period, then one row per land unit with its area, MAP and source, the rule its rain came from, the record, the factor and where it came from, whether it was clamped, the CHIRPS mean annual and its years, the run days by source, rain, actual evaporation, runoff in mm and m³ and the runoff coefficient), the WR2012 check (`Not checked: …` when the run's settings had no reference; otherwise the quaternary, source, reference period, scaling rule and factors, WR2012 MAR and scaled MAR, the simulated natural MAR and ratio over the overlapping years and the whole run, the 12 monthly means in water-year order with ratio and dry-season mark, the dry-season ratio, the pattern correlation, the flag with its basis, deviation and thresholds, and for a *query* or *not usable* flag whether the run has a written explanation), a column guide (each farm daily column's letter, series key and formula), warnings — blocks separated by a blank record. A run before engine 0.12.0 says it has no self-checks or water balance. Shares are **percentages** (0–100): `Flow share (%)` and `Demand supplied (%)` per farm and `Days EWR not met at the outflow gauge (%)`, where the JSON `RunSummary` has fractions (`flowShare`, `fractionSupplied`, `ewrFractionDaysNotMet`, 0–1) |
| `/projects/:id/series/:seriesId/export.csv` | `from?`, `to?` | `date` + the input series' values as stored (the file's first two columns, unchanged since before issue #66, so it uploads again as it is), then `Flags` (`missing`, `negative`, `outlier`, `flat-line`, `; `-separated, by the project's current data-quality limits: engine `seriesRowFlags`). A flow series adds its value in m³/day, and the outlet's gauge or logger record `Excluded from calibration (reason)` (the project's current `calibrationExclusions`). When a run read this series (`run_input_series.series_id`: the latest one the caller can see; never a scenario run, nor a run from before migration 056), the file leads with that run's `#` lines (the legacy warning, the disclaimer, the provenance line, `withRunComments`) and adds that run's columns, each header ending `[run <label, else its date>]`: for catchment rain, `Rain used` (`rain_final`), `Rain source` (catchment / alternative gauge / CHIRPS / reanalysis / forecast; `rain_source`, stored by every run with rain from engine 1.27.0, left out for older runs), `Rain above the <n> mm threshold` (the run's `calibration.rainThresholdMm`, engine `aboveRainThreshold`, what irrigation demand reads) and, when the run has them, the set-aside and accumulation columns; for CHIRPS, the day's bias factor and the corrected rain; for the outlet's gauge or logger record, the simulated outflow; for a gauge node's record, the flow simulated at that gauge; for a land unit's own rain (issue #482), `Rain used at <unit>` (the run's `rain_unit` on that unit, made only under `settings.unitRain` `perUnit`; none from a run on the catchment's rain). A series changed since that run adds `# series_changed_since_run=true; …` under the provenance: the run columns are what the run read. No run read it: no `#` lines and no run columns (`backend/src/export/series-columns.ts`) |
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
  // a flow record at a gauge inside the network carries "siteNodeId": a gauge of this file's model (084; absent = the outlet);
  // so does a land unit's own rain: a farm with an area in this file's model (209; absent = the catchment's rain).
  // The export leaves out a unit's rain whose unit has left the model.
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

**Size caps — 413, and streaming.** Every CSV download is **streamed**
(WP-1.29a, issue #283): production's Function URL is in `RESPONSE_STREAM`
mode, so a response is no longer stopped at Lambda's 6 MB buffered limit, and
the local Node server streams the same body the same way
(`backend/src/export/download.ts`, `backend/src/http/lambdaStream.ts`,
[deployment.md § Response streaming](./deployment.md#response-streaming)). The
route measures the file first and answers
`413 { error: "export larger than 50 MB — …" }` before sending a byte when it
passes **50 MB**, with a hint to narrow the window (`from`/`to`); otherwise the
file is written from memory as the client reads it, with no `Content-Length`
(chunked). For scale: a farm's daily CSV has ~32 full-precision columns,
≈ 400 KB a year, so a 60-year record is ≈ 24 MB and a century fits; a
60 000-day series is ≈ 1 MB. Past Lambda's first 6 MB a stream runs at about
2 MB/s, so a 50 MB file takes ~25 s (inside the API's 30 s timeout, which is
why the cap isn't higher). A download that fails partway is cut off, never
ended short: the client sees a failed download, not a complete-looking file.

`export.json` is the exception: it is built in memory and keeps a **5 MB**
cap (`413 { error: "export larger than 5 MB — …" }`), because a project file
must import back and `POST /projects/import` can't take more (a Lambda
request can't be streamed or pass 6 MB). The [bulk series](#bulk-run-series)
pages stay under the same 5 MB, since the browser holds a page whole. Gzip is
not used: CloudFront's `CachingDisabled` policy on `/api/*` doesn't compress.

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
