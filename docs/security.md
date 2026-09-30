# Security

The security model for the water-management app. The data it holds is
catchment configuration and farm-level water use for named farms. It is not
financial data, but it is commercially sensitive to the client and may be
personal information under POPIA (see [plan.md questions](./plan.md#questions-for-the-client)).

## Authentication

- **Accounts:** email + password. Passwords are hashed with **bcrypt**
  (`bcryptjs`, cost 12; 4 under vitest and on the e2e API server, which sets `PASSWORD_HASH_COST=4`, an override Lambda refuses at startup; `auth/password.ts`) and are 8–200 characters. Emails are `citext`, so
  lookups ignore case. The hash never leaves the backend.
- **Session:** an HS256 JWT signed with `AUTH_JWT_SECRET` (`jose`). It carries
  the user id and a random session id (`jti`, required: a token without one
  is refused, since it could never be signed out) and has a 7-day expiry. It sits in the **`wm_session` cookie**,
  which is `HttpOnly`, `SameSite=Lax` and `Secure` (Secure can be turned off
  only for plain-http local dev). JavaScript never sees the token.
- **Same-origin in production.** CloudFront serves the site and proxies
  `/api/*`, so the cookie is first-party. Together with `SameSite=Lax`, this
  blocks cross-site POSTs from carrying the session. CORS allows only the
  `ALLOWED_ORIGINS` list (with credentials; `Content-Type` is the only allowed
  request header). The API accepts JSON bodies only.
- **CSRF middleware.** Hono's `csrf()` (`backend/src/app.ts`) additionally
  rejects cross-origin, non-safe requests whose `Origin` isn't in
  `ALLOWED_ORIGINS` (`403`) — a second layer alongside `SameSite=Lax` against the
  cross-site form posts a browser can still make without triggering CORS.
- **Revocation:** every signed-in request re-reads `app_user.sessions_revoked_at`;
  a session issued before it (JWT `iat_ms`, falling back to `iat`) is rejected,
  as is a session for an account that no longer exists. A password reset sets
  the watermark, so it signs out every device, including a thief's, and so
  does `POST /auth/logout-everywhere` ("sign out everywhere", for a lost
  laptop or a suspected copied cookie). Changing the password while signed
  in (`POST /auth/change-password`, the Account page) sets it too. The
  watermark only moves forward (`app_user_sessions_watermark`, 067): an
  update to an earlier time or to NULL keeps the later one, so no update can
  revive a signed-out session. It then
  re-issues this device's cookie, so only the device that changed it stays
  signed in. **Plain logout** (`POST /auth/logout`) signs that one session
  out on the server as well as clearing its cookie (issue #51): its `jti`
  goes into `revoked_session` (102, through `app_revoke_session`, under the
  signed-in account only) until the token would have expired, and the same
  one-statement check reads it (`app_session_state`), so a copied cookie
  stops working at sign-out, not 7 days later. The account's other sessions
  stay signed in. Tests: `auth/session.db.test.ts` "signing out". Rotating
  `AUTH_JWT_SECRET` logs everyone out.
- Login returns the same error for an unknown email and a wrong password.
- **Sign-in lockout** (`login_throttle`, `backend/src/auth/routes.ts`
  `LOGIN_THROTTLE`): the 5th sign-in attempt in a row without the right
  password locks that **address** for 1 minute; each attempt after a lock ends
  doubles it (2, 4, 8 … minutes), capped at 15. While locked, login answers
  `429` with `Retry-After` and doesn't check the password. A correct password
  or a password reset clears the count; a day without attempts forgets it.
  It is keyed by the typed address, not the account, so an address with no
  account locks exactly the same way and the lockout reveals nothing about
  which accounts exist. Attempts are counted *before* the bcrypt check under
  a row lock, so parallel guesses can't slip past. Attempts made during a
  lock never extend it.
- **Trusted devices keep the lockout bounded** (070, `auth/device.ts`).
  Anyone can lock an address, and one wrong guess each time a lock ends
  locks it again, so a script could otherwise keep its owner out
  indefinitely (a reset cleared the count, and five guesses re-locked it).
  A browser that proved it knows the address's password (a correct
  sign-in, a password reset, sign-up, a password change) gets an
  `HttpOnly` `wm_device` cookie (180 days): a random device id and an HMAC
  (a key derived from `AUTH_JWT_SECRET`) over the address, the account's
  session watermark and the id. With a valid one, that browser's attempts
  count on its own `(address, device)` record in `login_device_throttle`
  (same 5 free attempts, same doubling to 15 minutes, a day to forget), so a
  stranger filling the shared record can't lock it, and its own sign-in
  clears only its own record. A cookie for another address, from before the
  watermark moved (reset, password change, "sign out everywhere"), or with a
  bad MAC counts on the shared record like any stranger; an unknown address
  can never have a valid one, so the no-enumeration property holds. A
  stolen device cookie buys its thief one more bucket at the same pace, no
  more. Plain logout keeps the cookie (it is what lets you back in during
  an attack); "sign out everywhere" retires it. The WAF's per-IP rate
  limits (below) are still the first line against spraying many addresses.
  Changing the password while signed in checks the current password through
  the same lockout (the device's record on a trusted device, else the
  address's), so a stolen session can't guess it faster than the sign-in
  form. Tests: `auth/login-throttle.security.db.test.ts` (the owner's
  device, a reset's browser and a new account's signing in through a
  stranger's lock with a no-cookie positive control; the device's own
  lock, doubling and cap; binding to address, watermark and MAC; hammering
  never extends a lock; the day boundary at 23 and 25 hours; the reset-mail
  cooldown at 50 and 70 seconds; time moved in the database, never slept).
- **Credentials never stand in for each other.** Most of the app's
  credentials share one shape (43 base64url characters, stored as SHA-256:
  verify, reset, invite, share, render and unsubscribe tokens), so each is
  looked up only in its own table and, for email tokens, for its own purpose.
  The backend reads a credential in exactly three places: the `wm_session`
  cookie (`auth/session.ts`), `Authorization: Bearer` on `/ingest/*` only
  (`ingest/auth.ts`), and `?token=` on the one-click unsubscribe; every other
  token travels in its public route's JSON body. No route takes a token from a
  path parameter. An unsubscribe token turns off only its own subscription,
  whose person, project, kind and farm can never change (trigger
  `alert_subscription_stamp`). `auth/token-confusion.security.db.test.ts`
  presents every credential in every other kind's slot and sweeps the live
  route inventory, with each credential's own slot as the positive control;
  its source sweep fails when a new place starts reading a credential.

## Password reset, email verification and invites

- **Tokens** are 32 bytes from `crypto.randomBytes`, mailed as base64url. The
  database stores **only the SHA-256 hash** (`email_token.token_hash`,
  `invite.token_hash`), so a DB dump, replica or query log never yields a
  working link. Tokens are **single-use** (consuming deletes the row), scoped to
  a purpose (a verify token can't reset a password), and expire: reset **1 h**,
  verify **48 h**, invite **7 days**. Issuing a new one replaces the old one.
  Malformed tokens are rejected before any DB work.
- **No account enumeration:** `POST /auth/forgot-password`,
  `POST /auth/resend-confirmation` and `POST /auth/register` each answer the
  same `202` body for known and unknown addresses. Sign-up is **email-first**
  (issue #57): it signs nobody in, and the account can sign in only once the
  emailed link confirms the address (`403 email_unconfirmed` otherwise, said
  only after a correct password). A taken address gets an email instead of an
  answer: a fresh confirmation link if it was never confirmed, else "you
  already have an account" with a password-reset link, both under the
  address's cooldown and daily cap, so sign-up can't be used to flood an
  inbox. The one exception is sign-up through an invite link, which names its
  address already: `409 account_exists` there tells the holder nothing new.
  **Timing too** (issue #51): `forgot-password` and `resend-confirmation`
  never wait for the send (it is started and left to finish), and answer
  after one fixed floor of 200 ms from the start of the request, known
  address or not, which also covers a known address's token write
  (`auth/accountMail.ts` `answerAlike`; `auth/accountMail.test.ts` drives
  it with promises, no clock). In Lambda a send still in flight when the
  answer goes finishes at the environment's next invocation, or is lost if
  the environment is retired; the floor gives it that long first, and a
  lost link is asked for again. `register` sends a mail on both of its
  paths (a link, or "you already have an account"), so only its database
  work differs, slightly: accepted residual risk.
- **Confirmation before sign-in** leaves one legacy state: an unconfirmed
  account signed in before this rule (its session stays valid until it
  expires) still sees the confirm-your-email banner and can resend the link
  (`POST /auth/resend-verification`). Opening a confirmation link trusts that
  browser for the address's sign-in lockout (`auth/device.ts`), as a password
  reset does.
- **Adding people by email is capped** (issue #51, `101_invite_throttle.sql`,
  `invites/invites.ts` `INVITE_CAP`): 300 addresses a day per inviting
  person and per project or team, across the member, farmer, bulk-farmer
  and team-member routes, each address counted before it is looked up and
  a bulk dry run counted too. Any registered user can own a project, and
  every add mails the project's name to an address the adder chose; the
  cap bounds it. `app_invite_attempt` (SECURITY DEFINER) counts only for
  the project's owner or the team's admin, so nobody can use up another
  project's allowance; the table is deny-all. Tests:
  `invites/invites.db.test.ts` "the daily cap on adding by email".
- **Adding someone never tells the adder whether the address has an
  account, and never makes anyone a member unasked** (issue #136,
  `109_invite_accept.sql`). Every add by email is an invite with the same
  answer (`{ invited: true, invite }`, bulk `'invited'`) and the same row
  in the owner's invite list, for no account, an unconfirmed one and a
  verified one alike; only the email differs (a sign-up link, a
  confirm-your-address link, or a link to the invitations page), and the
  adder never sees it. A verified account joins only when its holder
  accepts (`app_accept_invite`, SECURITY DEFINER, which checks the invite
  is for the caller's own verified address). `app_my_invites` shows the
  caller their own live invites and nothing about anyone else's. A decline
  (`app_decline_invite`) logs `invite.declined` with the masked address
  and no actor, so the owner learns an invite was declined, never by whom.
  Tests: `auth/account-tokens.security.db.test.ts` "adding someone by
  email doesn't reveal whether the address has an account",
  `invites/invites.db.test.ts`.
- **Sign-up throttle** (`079_signup_throttle.sql`, `auth/signupThrottle.ts`):
  at most **10 sign-ups per client address an hour** and **500 in all an
  hour**, in Postgres so it holds across Lambda instances; past either,
  `429 signup_throttled` with `Retry-After`. Each attempt is counted before
  the address is looked at, so once throttled a taken and a free address get
  the same answer, and a refused attempt isn't counted, so hammering never
  extends the wait. The WAF's per-IP `/api/auth/*` rule (100 per 5 minutes)
  stays in front of it; it matches the path after `URL_DECODE` and
  `NORMALIZE_PATH`, so a percent-encoded spelling the API would route to the
  auth handlers (`/api/%61uth/login`), or one with `//` or dot segments,
  can't slip past it. The API refuses those spellings itself as well
  (`400`, [§ Infrastructure](#infrastructure), ambiguous paths), and the
  per-account limits don't depend on the WAF at all
  ([§ Throttles that don't depend on the WAF](#throttles-that-dont-depend-on-the-waf)).
  - *The client address* (`http/clientAddress.ts`) is the `X-Viewer-Address`
    header, which the `/api` CloudFront Function (`api_strip_prefix`,
    `infra/s3_cloudfront.tf`) sets from the connection's IP, overwriting any
    value the viewer sent, and it is read only on a request that passed the
    shared-secret check (`edgeVerified`, `app.ts`). X-Forwarded-For is never
    read. An edge-verified request without a usable address shares one key
    (fails closed). IPv6 is keyed by its /64. Locally (no shared secret) the
    header is ignored and the key is the socket peer, or one fixed key under
    `app.request`. Only a SHA-256 of the key is stored, deleted when its
    window ends.
  - *Tests:* `SIGNUP_THROTTLE=off` turns it off for the backend test setup and
    the e2e API server, which sign up hundreds of accounts from one address.
    It is test-only: the API Lambda refuses to start with it
    (`config/production.ts`), and the code ignores it in Lambda anyway.
    `signupThrottle.security.db.test.ts` tests the throttle with it on. A
    developer who trips it locally can set it in `backend/.env.development.local`.
  - *Accepted residual risk:* a `409` still reveals a taken address, at 10
    guesses per address an hour (more for someone with many addresses, up to
    the global 500). The global ceiling also means a distributed sign-up flood
    can hold up real sign-ups for up to an hour; invites still work for
    existing accounts, and the ceiling is far above real use.
- **Mail-bombing throttle:** at most one reset, verification or invite email
  per address per minute, enforced in Postgres (`app_issue_email_token` with an
  advisory lock; `invite.last_sent_at`) so it holds across Lambda instances.
  On top, a **daily cap** (078, `account_mail_quota`): at most 10 reset and
  verification emails per address in a rolling 24 hours, so a distributed
  sender can't have one inbox mailed ~1440 times a day. A request from a
  browser holding a valid `wm_device` cookie for the address (auth/device.ts,
  the same trust as the sign-in lockout) counts on that device's own 10
  instead, so a stranger who uses up the shared count can't block the owner's
  own browser. Forgot-password answers the same `202` whether the cap held the
  email back or not (known address or not); resend-verification, which only
  mails the signed-in account's own address, says `verification_limit`.
  `mail-cap.security.db.test.ts` pins the boundary, the window's edge, the
  device allowance and the identical answers. **Accepted residual:** someone
  with no device cookie for the address (a new browser, cleared cookies, a
  reset or "sign out everywhere" since, which retires older devices) can be
  denied a reset link, or a verification email, for up to a day after such an
  attack. They can still sign in with their password, and a trusted device
  keeps its own sign-in lockout (070) and its own reset allowance.
- **Mail failures never change the response** (`trySendMail` logs the error
  without the body, which contains a live token). Mail is sent after the
  transaction commits, so a mailed link always refers to a stored token. The
  log line is `{"event":"mail_send_failed","kind",…}`: the template's kind and
  the error's name/code only (`logging/safeError.ts`), never the recipient,
  the subject (a farmer invite's names a person and their farms) or the
  error's text (SES's `MessageRejected` names the recipient). A CloudWatch
  alarm counts it (`infra/alarms.tf`, `mail_send_failed`), so a broken send is
  paged rather than silent.
- **No personal data in server logs.** Mail, alert and job failures and the
  API's unhandled errors log through `safeError`
  (`backend/src/logging/safeError.ts`): the error's name, machine code
  (SQLSTATE, SES/SMTP code) and HTTP status, plus stack frames for an
  unexpected job failure or an unhandled API error (`unhandled_error`, which
  also names the route's pattern, never the concrete path, since a path can
  carry a token). A failed sign-in or bad account link logs `login_failed`
  with the route's pattern and a reason code only, never the address tried
  (§ Throttles that don't depend on the WAF). The fetcher and renderer
  Lambdas log a failed answer as `feed_fetch_failed` (the feed's id, its
  source and a reason code: never the stored message, which can name a grid
  cell or a station) and `report_render_failed` (the report and project ids,
  `render`/`store` and `retry`: never the error text or the render token), and
  a failed queue send or PDF store by `safeError` too. Never an error's message or a pg `detail`, which
  can carry an address or row values. Postgres logs no bind values either
  (`log_parameter_max_length = 0`, and `_on_error`, in `infra/rds.tf`), so a
  slow statement is logged without its parameters.
- **Email verification** is not required to sign in (V1). It *is* required to
  claim invitations: `app_accept_invites()` only converts invites for a
  **verified** address, so someone who registers an invitee's address first
  gets nothing. Signing up through the invite link counts as verified only when
  the link's invite is for the exact address being registered.
- **Invites** are visible and revocable only by project owners / team admins
  (RLS on `invite`); invitees have no access until they have an account and
  accept (a verified account, on `/account/invitations`), or confirm the
  address the invite was sent to (no account yet, or an unconfirmed one).
  Accepting goes through a `SECURITY DEFINER` function that re-checks
  verification.
- **Adding an existing but unverified account** doesn't make it a member:
  `POST …/members` adds only **verified** accounts directly. An unverified one
  gets a pending invite (the same response as an address with no account, so
  the owner learns nothing about whether it's registered; the `invite.sent`
  audit row, and so History and the data export, are the same too, with no
  "was mailed" flag, since an unverified account inside its verification
  cooldown gets no new email; `account-tokens.security.db.test.ts` compares
  all of them, and a failed send is logged server-side only) and an email to the
  address asking to confirm it; confirming accepts the invite. This stops
  someone who pre-registers a colleague's address from being added in their
  place. Residual risk: if the real inbox owner clicks "confirm" on an account
  someone else created, that account (whose password the squatter knows) is
  verified and joins. The email tells them to use "Forgot password" instead if
  they never created the account — a reset proves the inbox, sets their own
  password, revokes the squatter's sessions and accepts the invite.
  Closing this fully means sign-up that is email-first (confirm before the
  account exists), which is an operator decision (see Known gaps).
- **Email content:** every user-controlled value (project/team names, display
  names) is HTML-escaped; subjects and extra header values are stripped of
  CR/LF; `sendMail` refuses a recipient that isn't one bare address (a
  one-lined "a@x Bcc: b@y" is a group to b@y for nodemailer).
  `mail/outbound.security.test.ts` feeds hostile text to every exported
  `…Mail` builder (the list comes from the modules' exports) and sends each
  through the SMTP and SES transports. Links use `SITE_URL`
  from config, never the request's Host header. The reset and verify pages
  strip the token from the address bar and set a `no-referrer` policy
  (`<meta name="referrer">`; the invite sign-up page does the same).
- **Transport:** SES via the Lambda's IAM role in production (no SMTP password
  to hold). The `log` transport refuses to print message bodies inside Lambda,
  so a misconfigured deploy can't write live links into CloudWatch.
- **Guard:** `backend/src/auth/account-tokens.security.db.test.ts` sweeps the
  catalogue (every credential-like column must be a CHECK-constrained 32-byte
  `bytea` digest, allowlist with reasons) and every text/json/bytea column for
  the raw tokens just mailed; pins the 1 h / 48 h / 7 day lifetimes (a re-sent
  invite included); races `app_consume_email_token` across two open
  transactions; refuses forged session JWTs (unsigned, other key, HS512, other
  issuer, expired, non-uuid subject, tampered, no or a malformed session id)
  and pins the 7-day cookie; and
  checks that adding a member, team member or farmer (single and bulk) and
  signing in answer the same for an unknown address and an unverified or
  wrong-password one.

### Throttles that don't depend on the WAF

The WAF's `/api/auth/*` limit is per IP and matches the path, so it can be
spread over many client addresses
or, before the path check below, dodged with an encoded path. Every
credential-guessing or mail-sending auth route therefore has its own limit
in Postgres, keyed by the **account address** (the typed, trimmed,
lower-cased email), never by the client address or the path, so it holds
across Lambda instances and whatever the request came through (issue #126):

| Route | Limit | Where |
|---|---|---|
| `POST /auth/login` (and `change-password`'s current-password check) | 5 free attempts, then a lock of 1 minute doubling to 15 minutes; a trusted device counts on its own record | `005_login_throttle.sql`, `070_login_device_trust.sql`, `auth/routes.ts` `LOGIN_THROTTLE` ([§ Authentication](#authentication)) |
| `POST /auth/forgot-password` | 1 reset email a minute, 10 a day (plus 10 per trusted device) | `app_issue_email_token`, `078_account_mail_cap.sql` (Mail-bombing throttle above) |
| `POST /auth/resend-confirmation`, `POST /auth/resend-verification`, a sign-up with a taken address | the same cooldown and daily cap, on verification emails | the same |
| `POST /auth/reset-password`, `POST /auth/verify-email` | none per account, by design: the account isn't known until a token matches, and a token is 256 random bits, single-use and short-lived, so guessing one is not a feasible attack at any rate; malformed tokens are refused before any database work | `auth/tokens.ts`, `auth/email-routes.ts` |

`POST /auth/register` is the one auth limit keyed by client address (sign-up
has no account yet; above), with a global ceiling that doesn't depend on it.
`auth/per-account-throttles.security.db.test.ts` sends every request from a
different viewer address through an edge-verified app, so a limit keyed on the
client would never engage, and checks that the sign-in lock, the reset
cooldown and the verification cooldown each still do (with positive
controls), and that `/%61uth/login` is refused before it is counted.

**One password sprayed across many accounts.** Each account is limited on
its own, so trying one password against many accounts from many addresses
passes every limit above. Two controls see it: the WAF's **sign-in CAPTCHA**
(below) makes every IP past 20 sign-ins in 5 minutes solve a puzzle, and the
failures are **counted across all accounts**: every failed credential check logs one line,
`{"event":"login_failed","route":"/auth/login","reason":"bad_password"}`
(`auth/loginFailed.ts`), which the `login-failed` alarm counts across all
accounts (more than 30 in 15 minutes by default, `infra/alarms.tf`;
[deployment.md § Runbooks](./deployment.md#runbooks), Credential stuffing).

- *Reasons:* `unknown_account` and `bad_password` (sign-in; change-password's
  current password is `bad_password` on `/auth/change-password`), `locked`
  (refused by the lockout before the password is checked), and `invalid_link`
  (a malformed, used, expired or unknown reset or verification token).
- *No personal data:* the line holds the route's pattern and the reason only,
  never the typed address, an account id, the client address or a token; the
  logger's signature takes two closed unions, so a caller can't pass one.
- *The client can't tell the reasons apart:* an unknown address and a wrong
  password answer the same `401 wrong_credentials` after the same bcrypt work
  (`DUMMY_HASH`), and neither sets a cookie. `login-throttle.security.db.test.ts`
  compares the two answers and checks the lines (with a no-line positive
  control for a correct password and a good link).
- *Why an alarm and no global circuit breaker:* a breaker that slows every
  sign-in once failures across all accounts pass a threshold would be counted
  in Postgres (Lambda has many instances), and its input is free to produce:
  anyone can fail a sign-in with a made-up address. So an attacker could
  switch it on at will, turning an attack on the few into a slowdown for
  everyone, and each held request keeps an API Lambda busy (duration billed,
  reserved concurrency used), so the delay spends this account's money and
  crowds out real users rather than the attacker's. It also wouldn't stop a
  spray, only stretch it. The alarm costs nothing on the request path; the
  response is the operator's (a tighter or blocking WAF rule, the runbook).
  The puzzle is per IP at the edge instead: it costs a real user nothing
  unless their own network is over the threshold.

### Sign-in CAPTCHA

`infra/waf.tf` `SignInCaptchaPerIP` (issue #126): past
`waf_signin_captcha_per_5min` (default 20) `POST /api/auth/login` requests from
one IP in 5 minutes, AWS WAF answers a sign-in that carries no valid CAPTCHA
token itself, with **HTTP 405 and `x-amzn-waf-action: captcha`** (an API
request gets no interstitial page). A request with a valid token is counted
and goes on. Below the threshold nobody sees a puzzle.

- *Scope:* `POST` and exactly `/api/auth/login`, after URL-decoding,
  normalising and lower-casing the path (as the auth block rule does), so
  `/api/%61uth/login` counts too. Not forgot-password or the confirmation
  resends: they answer the same `202` for every address, so they reveal and
  guess nothing, and each address is capped at 10 emails a day (above);
  spraying them costs mail, not accounts.
- *Order:* after `RateLimitAuthPerIP` (100 per 5 minutes on `/api/auth/*`,
  blocks), so an IP past 100 is blocked outright rather than offered a puzzle
  (solves are billed, $0.40 per 1,000), and before the site-wide limit.
- *Immunity:* a solved puzzle lasts 300 seconds (`captcha_config`, pinned
  rather than inherited): enough to sign in; someone paying people to solve
  puzzles buys 5 minutes, still under the 100-per-5-minute block, with every
  failure still counted by the `login-failed` alarm.
- *The page:* the API client turns that 405 into an `ApiError` with code
  `captcha_required` (`frontend/src/lib/api/client.ts`, `isWafCaptcha`: the
  header, not the status alone). The sign-in page then loads AWS's CAPTCHA
  JavaScript API (`jsapi.js`) **only then**, renders the puzzle in the form
  (`auth-extras/SignInCaptcha.svelte`, focus to its heading; the puzzle's
  audio button plays a spoken version), and sends the sign-in again with the
  token in the `x-aws-waf-token` header. A retry that gets the 405 again, or
  a script that fails to load, says "Too many sign-in attempts from your
  network. Wait a few minutes, then try again." (never a loop).
  `lib/auth/wafCaptcha.test.ts` and `e2e/tests/captcha.spec.ts` (a faked 405
  and a stub SDK) test it.
- *Off locally:* the script URL and key are build-time config
  (`PUBLIC_WAF_CAPTCHA_SCRIPT_URL`, `PUBLIC_WAF_CAPTCHA_API_KEY`), empty in the
  committed env files; there is no WAF locally, so nothing asks for a puzzle.
  A production build without them shows the "wait" message instead.
- *The API key* (`aws_wafv2_api_key.captcha`, CloudFront scope, token domain
  the site's domain only) lets pages on that domain render this account's
  puzzles. It ships in the page, like any CAPTCHA site key; it goes to a
  GitHub secret only because the provider marks it sensitive.
- *CSP:* the one third-party origin the site allows. Once
  `waf_captcha_integration_url` is set, the header's `script-src` and
  `connect-src` add exactly the CAPTCHA SDK's origin
  (`<id>.edge.captcha-sdk.awswaf.com`) and its challenge script's
  (`<id>.edge.sdk.awswaf.com`, which `jsapi.js` loads; without it no token is
  issued), and `media-src` allows `data:` for the audio. SvelteKit's meta CSP
  adds the same two to `script-src` from the build's script URL
  (`frontend/svelte.config.js` refuses any other shape). No `'unsafe-eval'`,
  no `blob:`, no wildcard: loading AWS's SDK (2026-09) under exactly this
  policy in Chromium drew no violation beyond its web-font stylesheet on
  `static.captcha.awswaf.com`, left blocked (the puzzle uses the system font).
  Guardrail runs `signin_captcha*` pin the rule, the key and the CSP.
- *Switch-off:* `waf_signin_captcha_action = "COUNT"` keeps the rule counting
  and stops the puzzle ([deployment.md § Runbooks](./deployment.md#runbooks),
  The sign-in CAPTCHA misfires).
- *Limits:*
  - Per IP: a botnet with each address under 20 sign-ins per 5 minutes never
    meets it; the `login-failed` alarm is what sees that.
  - The puzzle's words are AWS's, in English (it has no Afrikaans); the
    heading and explanation around it are translated.
  - Anyone can load the public SDK with the public key and submit solves,
    which AWS bills. Budgets and Cost Anomaly Detection
    ([deployment.md § Budget alerts](./deployment.md#budget-alerts)) are the
    backstop; AWS offers no cap on it.
  - The challenge script's host is derived from the integration URL (same id
    on `sdk.awswaf.com`), as AWS's SDK does today. If AWS changes that, the
    puzzle fails to load under the CSP and the page says to wait: it fails
    closed, and the runbook's step "the puzzle doesn't render" covers it.

## Render tokens

Server-side PDF reports (WP-2.15 Phase B; [architecture.md § Server-side reports](./architecture.md#server-side-reports))
add a new way in: a headless Chromium, run by the job worker or the renderer
Lambda, must read a project as the member who asked for its report, without
that member's password or session. It gets a **render token**, and the token
buys a **render session** that can read one report and nothing else.

- **The token** (`render_token`, `023_reports.sql`) is the `email_token`
  pattern with purpose `report`: 32 random bytes, stored **only as their
  SHA-256**, **single use** (consuming deletes the row), **5 minutes** (the
  insert trigger sets the expiry whatever the caller sent), and tied to one
  user, one project and one run. Only the requester can issue it, as
  themselves, for a project they can view and a run of that project (RLS
  and the trigger); a farmer can't. An impact report's token (082) also names
  its baseline run (`against_run_id`), which may be in another project but
  must be one the issuer can read (the trigger, under their RLS). It is issued by the `report_render` job,
  which runs as the requester under RLS, and never leaves the server side:
  it goes to the local Chromium in memory, or in production over the
  SSE-encrypted `render-requests` queue to the renderer Lambda. It is never
  logged, never put in a URL, and never stored raw.
- **The exchange** (`POST /auth/render-session`, public: the token is the
  credential) consumes the token, re-checks that the requester can still see
  the project and that the run is still one of its runs, and an impact
  report's baseline too (`403` otherwise),
  and sets a `wm_session` cookie whose JWT carries `scope: { p, r }` (with
  `a: { p, r }` for an impact report's baseline) and
  lives **10 minutes**. A used, expired, unknown or malformed token gets one
  answer, `400`. Both refusals carry the machine-only code
  `render_token_refused`: the renderer fails a report for good only on that
  code, so a WAF or CloudFront `403` in front of the API (no code) is
  retried with backoff, not mistaken for a refused token
  (`reports/render.ts` `sessionRefusal`, `reports.test.ts`). The renderer calls it through its browser context's own
  request client, so the cookie lives only in that throwaway context, which
  is closed with the browser after the render.
- **The scope** (`reports/scope.ts`, enforced in `requireUser`): a render
  session may make **only `GET`** requests, and only to `/auth/me`,
  `/projects/<p>`, `/projects/<p>/series`, `/projects/<p>/runs/<r>` and its
  `/series`, `/day` and `/signoffs`: exactly the reads the report route
  makes. An impact report's session may also `GET /compare/runs` with
  exactly `a=<baseline project>:<baseline run>&b=<p>:<r>` (those two
  parameters, once each: the impact section's one read), and the
  baseline run's `/series` with exactly `key=natural_flow` or
  `key=ewr_shortfall` (the licence-impact board's, issue #53 R7; no other
  key, no `nodeId`), and never the baseline's project, the run itself or
  its other series. Any other method, project, run or route (the run list, members,
  jobs, reports, teams, compare, every write, and the run's own reads the
  report doesn't make: its CSV exports, the workbook's bulk series,
  reproduction, allocation comparison, model input, ensembles) answers
  `403`. A path with encoded characters or dot segments
  is refused outright. A `scope` claim that isn't a well-formed pair of UUIDs
  makes the whole token invalid, so a render session can never widen into a
  full one. RLS still applies underneath: the session is the requester's, so
  it sees at most what they see. It is also revoked with every other session
  of the account (the `sessions_revoked_at` watermark).
  `/auth/me` answers `renderSession: true` for it, and the app skips the
  terms re-acceptance step for it (`termsGateApplies`): the step is a
  person's, and a session that can accept nothing would otherwise render
  the step instead of the report and time out. Refusing at queue time
  instead would stop every scheduled report after a terms change until its
  editor signed in; the report's readers are members under their own
  acceptance.
- **Tests:** `reports/reports.db.test.ts` checks single use, expiry, the
  scope on another project, another run and every other kind of route, with a
  positive control (the report's own reads answer `200`), a requester who
  lost access between issue and use, and that farmers and strangers can't
  issue one; its "impact reports" block checks the baseline: a requester who
  reads both runs queues one and gets the one comparison (positive control),
  one who can't read the baseline is refused by the route, the database and
  the token, a baseline that becomes unreadable between issue and use is
  refused at the exchange, and a baseline deleted or unshared after the
  request fails the render without a retry (never a plain report instead);
  `reports/render-session.security.db.test.ts` sweeps every
  route in the live inventory (`app.routes`) with a render session: it
  reaches exactly its allowlist of the report's reads (each `200`, and `403`
  for another run or project the requester fully owns) and gets the scope's
  `403` everywhere else; it also checks the session's 10-minute life, its
  revocation by "sign out everywhere", that a malformed `scope` claim opens
  nothing, and that eight simultaneous exchanges of one token give exactly
  one session; `reports/scope.test.ts` pins the path rules; and
  `reports/render.db.test.ts` has a real Chromium check that the session is
  refused the project list mid-render, and that an impact report's session
  makes its comparison. `db/cross-project-refs.security.db.test.ts`
  classifies the two baseline references as cross-project by design, fixed
  at insert.
- **What the renderer can reach.** Locally, the dev site and API. In
  production the renderer Lambda is outside the VPC with no database access
  and no secrets; it opens the public site through CloudFront and the WAF
  like any browser. Its role can receive `render-requests`, send
  `render-results` and put objects under `reports/` in the reports bucket:
  it can't read, list or delete a PDF. It opens only its configured
  `RENDER_SITE_URL`: a render request carries ids and the token, never a URL.
  Its browser is confined to that site and `RENDER_API_URL` whatever the
  page asks for (`reports/render.ts` `confineToOrigins`): any request to
  another origin (an image, a fetch, a frame, a script navigation) is aborted
  before it leaves, a navigation's redirect chain is walked hop by hop first
  and refused if any hop leaves, a render whose page tries to leave fails at
  once without retry, and only a page of the site is ever printed. What
  Playwright can't route (the redirect hops of a subresource, WebSockets,
  preconnects, WebRTC, service workers) is refused by Chromium itself, from
  its launch flags (`confinementArgs`): no host but the site's and the API's
  resolves (IP literals included, so no DNS-prefetch channel either), every
  other origin goes to a proxy that can't exist (`*.invalid`, with the
  implicit loopback bypass removed, so the site's own host on another port is
  refused too), WebRTC may use only proxied UDP (none), and service workers
  are blocked. The site's CSP is a third layer in production only.
  `reports/render.origin.db.test.ts` checks each case with real Chromium
  against a counting "elsewhere" server that also counts raw TCP
  connections, WebSocket upgrades and STUN packets, with a positive control
  (the report prints, and a same-site subresource redirect still loads;
  skipped locally where Playwright's Chromium isn't installed; under CI a
  missing browser fails it, docs/testing.md § Tests that need a service or a
  browser);
  `reports/reports.test.ts` pins the flags. Residual: this is the browser
  policing itself, so a Chromium bug that ignored its own flags, or code in
  the renderer's Node process, could still reach the internet (the Lambda
  has open egress). The infra-level fix is an egress allowlist, a tradeoff
  not taken ([infra/README.md](../infra/README.md), the renderer).
- **The PDFs** are in a private bucket (public access blocked, TLS only,
  SSE-S3), under keys derived from the project and report ids (never stored
  or taken from a message), deleted after 7 days. A download is a
  **CloudFront signed URL** that lasts **60 seconds**, minted per request by
  `GET /projects/:id/reports/:jobId/pdf` for a viewer of the project and
  handed over as a `302` (`no-store`, `no-referrer`); the status route
  carries no link (issue #126). The URL is on the site's own origin,
  `/reports/<project>/<report>.pdf`: a CloudFront behaviour that serves the
  bucket through its own origin access control and **only** to a request
  signed by a key in the distribution's trusted key group (a canned policy,
  RSA-SHA256, covering the exact URL, the download file name included, and
  the expiry; `reports/cloudfrontSign.ts`). The bucket policy lets that one
  distribution (`AWS:SourceArn`) `GetObject` under `reports/`, and nothing
  else reads it: the API holds no S3 grant at all, only the private key
  (from its runtime secret, § Runtime secrets), and the renderer may only
  put. So the transfer itself, not just the redirect, passes CloudFront and
  the WAF's per-IP rate rule, and the only lasting handle on a PDF is the
  API route, behind the session, the WAF and the project's membership;
  every download re-checks membership. The behaviour caches nothing and
  forwards only `response-content-disposition` to S3. It takes precedence
  over the SPA, so the frontend must never serve anything under `/reports`:
  `scripts/guards/check_reports_path.mjs` (run by `pnpm test:guards` and
  CI's guard step) fails on a top-level `reports` route, a top-level dynamic
  route, or a static file there. Locally
  (`REPORT_DOWNLOADS=presigned`, the default) the link is a pre-signed MinIO
  GET instead, so no cloud account is needed; production's config check
  refuses anything but `cloudfront` (§ Production configuration). The
  alternative, streaming the PDF through the API, was not taken: the API's
  Function URL is in buffered mode (a 6 MB response cap, less after base64,
  that a long report could pass), and streaming would hold a VPC Lambda open
  and billed for every transfer. **Emails carry no PDF and no download link**:
  they link to the app's `/projects/:id/reports/:jobId` page, which needs the
  reader signed in and still a member, so a forwarded email opens nothing.
  Recipients must be direct project members with viewer or above, checked
  when asked for and again when the mail is sent; a viewer may email only
  themselves; on-demand PDFs are capped at 10 an hour per user and project.
  A PDF or schedule emails at most 20 people, and a project has at most 10
  schedules. The hourly and schedule caps are counted under an advisory lock
  (per user and project, per project), so a burst of concurrent requests
  can't pass them together (`jobs/costCaps.security.db.test.ts`).
- **Accepted residual risks.** A signed link works for its minute for
  whoever holds it, from any address (a canned policy binds no IP), and may
  be fetched more than once in that minute. But every fetch, like every
  redirect, now counts against the WAF's per-IP rate rule and shows in the
  distribution's request and blocked-request alarms, so a member scripting
  downloads is throttled on the transfer itself, not only on minting. Don't
  log the `Location` header. The signing key is operator-generated and
  kept like the session key: in sops (`cloudfront_private_key`), handed to
  Terraform as an ephemeral variable and written only into the API's
  write-only runtime secret, so it is **never in Terraform state** (§ Runtime
  secrets). Only the public keys are, which is harmless. Terraform can't
  check at plan time that the sops key and the configured public key are a
  pair, so the API checks at cold start (`reports/cloudfrontSign.ts`
  `assertKeyPair`: the same public key, and a probe it signs verifies) and
  refuses to start on a mismatch, rather than signing every link with a key
  CloudFront rejects. Rotation overlaps two trusted keys, so no valid link
  fails (docs/deployment.md § The report-download signing key). A render request dead-lettered in production still holds its token
  until it expires (5 minutes): the DLQ is encrypted and readable only by the
  account. The worker's inline render (local and CI only) holds the job's
  database transaction open for the few seconds it takes.

## Share links

Read-only links to a project's published baseline for people outside it
(WP-2.3 phase 2; `025_share_links.sql`, [api.md § Share](./api.md#share)).
The link is the credential: whoever holds it reads the catchment-level
result without signing in, until it expires or its owner revokes it.

- **The token.** 32 random bytes, base64url (43 characters), the emailed
  tokens' format (`auth/tokens.ts`). `share_link.token_hash` holds **only its
  SHA-256** (`CHECK` 32 bytes, `UNIQUE`); the raw token is in the `201` that
  creates the link and nowhere else: not in the list, not in the database,
  not in a log. A lost link can't be shown again, only replaced.
- **In the fragment.** The URL is `/share#t=<token>`. A browser never sends
  the fragment to a server, so the token doesn't reach CloudFront, WAF or
  Lambda access logs, or a `Referer`. The `/share` page reads it, strips it
  from the address bar with `history.replaceState` (as the reset pages strip
  `?token=`), and POSTs it in a JSON body. The page sets `noindex` and
  `no-referrer`. A link pasted into a chat app is still readable by whoever
  sees the message: that is what a link is.
- **Owner-only.** `share_link` RLS: SELECT, INSERT (as yourself) and UPDATE
  for `app_has_role(project_id, 'owner')`; nobody else sees a row. `water_app`
  may update only `revoked_at` / `revoked_by` and may not `DELETE` (the
  catalogue test pins both): a revoked link stays as the record of who made
  and withdrew it. An insert trigger stamps `created_by` and `created_at`.
  Revocation is final in the schema, not just in the API: the
  `share_link_revoke_final` trigger (065) refuses an update that clears or
  moves `revoked_at` or names someone else in `revoked_by`, so not even an
  owner's own transaction can bring a withdrawn link back (only the
  foreign key's `SET NULL` on the revoker's account deletion passes; 067
  refuses clearing `revoked_by` while that account exists).
  Lifetime 1–365 days (API and `CHECK`).
- **What it reveals.** Only through `SECURITY DEFINER app_share_view` (search
  path pinned): for a live, unrevoked, unexpired token of a project with a
  **current** publication, the project name, who published it and when, the
  WUA's notice (both languages, the percentage, the next date), and
  `catchment_view` rebuilt from an allowlist of keys (dates, the farm count,
  EWR days not met per site). Never the modeller's note, never a farm's row,
  name or id, and the outlet's name is dropped because the outflow node may
  be a farm. A key added to `catchment_view` later doesn't reach the public
  until it is added to the allowlist. Anything else answers no row, and the
  API turns every dead link into the same `404` (unknown, malformed,
  revoked, expired, unpublished), so the answer never says which.
- **The k rule on series.** `app_share_series` returns only the catchment
  allowlist (`natural_flow`, `simulated_outflow`, `observed_flow`, `ewr`,
  `ewr_shortfall`) of the current published run, monthly means plus the last
  365 days, and **only when the catchment has at least `FARMER_K` = 5 farm
  holders** (counted from nobody's point of view: one user's farms once, an
  unlinked farm on its own). In a smaller catchment natural flow minus
  outflow is the farms' use, and with one farm it is that farm's
  (design [farmer-view.md §10.3](./design/farmer-view.md#103-decisions-this-design-takes-for-the-client-to-confirm)).
  Farm keys are refused in the API and again in the function. The literal 5
  in the SQL is pinned to the engine's `FARMER_K` by `share.db.test.ts`.
- **Rate limiting.** Nothing app-level: the WAF's per-IP rule on `/api/*`
  (`waf_rate_limit_per_ip`, `infra/waf.tf`) covers `/api/share/*`, and a
  256-bit token can't be enumerated. `last_used_at` moves at most once an
  hour, so a busy link doesn't write on every view.
- **Audit.** Created by and revoked by are on the row; audit events for both
  wait for the audit log (WP-2.4, issue #28; [followups.md](./followups.md)).
- **Tests:** `share/share.db.test.ts` (owner-only CRUD with a positive
  control, the dead-link cases against a live one, the response scan for the
  note and every farm name and id, the `last_used_at` throttle, farm keys,
  and the k boundary at 4 and 5 holders), `share/share.security.db.test.ts`
  (a link made under one publication reads only the current one, view and
  series; a sweep over every key the published run stores, catchment and
  node level, answers exactly the allowlisted catchment series, one row
  each, with no farm name, id or note; the TypeScript and SQL allowlists
  pinned to one list; revocation final even in SQL, with the account-deletion
  control) and `routes.test.ts` (the two reads on the public allowlist,
  answering `400` rather than `401`).

## API keys

Per-project keys for the ingest endpoint (WP-2.9; `039_api_keys.sql`,
[api.md § Ingest](./api.md#ingest)). A new trust boundary: a request with no
session, whose credential is a long-lived secret held by a machine (a
logger gateway, a script). The key can merge days into one project's series
and nothing else.

- **The key.** `wm_<prefix>_<secret>`: `prefix` is the first 8 characters of
  the row's id (a generated, `UNIQUE` column; it finds the row and tells keys
  apart in lists), `secret` is 32 random bytes as base64url (43 characters).
  `api_key.key_hash` holds **only the SHA-256 of the whole key** (`CHECK` 32
  bytes, `UNIQUE`). With 256 bits of entropy a slow hash adds nothing (the
  emailed tokens' reasoning). The raw key is in the `201` that creates it
  (`Cache-Control: no-store`) and nowhere else: not in the list, the
  database, the audit subject or a log. A lost key can't be shown again, only
  replaced. The Settings panel's `curl` example uses a `$WM_INGEST_KEY`
  placeholder, never the key.
- **Checking a key** (`ingest/auth.ts`), on every request:
  1. the `Authorization: Bearer …` value must match our exact format, or the
     request is refused before any database work;
  2. `app_api_key_lookup(prefix)` (`SECURITY DEFINER`: there is no user)
     returns the row, and the presented key's SHA-256 is compared with the
     stored one with **`crypto.timingSafeEqual`**. An unknown prefix is
     compared against a dummy hash, so it costs the same;
  3. a missing, malformed, unknown, wrong, revoked or expired key all get
     the same `401 { error: "invalid or missing API key" }`;
  4. `app_api_key_take` takes one request from the key's token bucket (60,
     refilled at 60 a minute, under a row lock so concurrent requests count
     one by one) in its own committed transaction: a failing request still
     counts. An empty bucket is a `429` with `Retry-After`.
- **Key context and RLS.** The work runs in `withApiKey` (`db/tx.ts`), which
  sets `app.current_api_key_id` (transaction-local, like the user id) and
  **no** user id. `app_api_key_project(scope)` re-checks the key on every
  statement (exists, not revoked, not expired, holds the scope) and is NULL
  when a user id is also set, so the two contexts never mix. Permissive
  policies let the key SELECT, INSERT and UPDATE `time_series` of its project
  (and only the series in its `allowed_series`, `app_api_key_allows`), and
  INSERT `audit_event` rows with `actor_user_id` NULL and itself as
  `actor_api_key_id`. No delete. Every other policy calls `app_has_role`,
  which is false without a user: a key reads no model, run, member, project,
  key, history or feed (`ingest.db.test.ts` checks each, with its own series
  as the positive control). It can't write a series revision either, so a
  key's merge keeps none (like a data feed's).
- **Automatic re-runs from a key** (042_auto_rerun). A key's ingest that
  changes days queues the project's automatic re-run (when it has them on)
  as the key's **creator** (`api_key.created_by`), through `SECURITY DEFINER
  app_enqueue_rerun`; the key itself gets no job policy. The re-run runs as
  that person under RLS and fails closed if they are no longer an editor, so
  a key never makes a run its creator couldn't. If the creator's account was
  deleted (`created_by` NULL), the re-run is **skipped** (no job,
  `rerunQueuedFor: null`) and the ingest still commits: never a run as
  nobody, never lost data.
- **A push that looks wrong holds the automatic runs** (WP-2.16, the
  "leaked or mis-configured gateway key" abuse case; `series/hold.ts`). A
  key's days that the engine's data-quality rules flag (a negative rain or
  flow, or a value above its series' outlier limit) are merged, so nothing
  is lost, but the merge records `series.held` as the key, queues no re-run
  and answers `rerunHeld`; the re-run handler then does nothing while a
  `series.held` event is newer than the project's latest run a person made,
  so neither an already-queued re-run nor a later clean push can carry the
  bad days into an automatic run, or an automatic publication. The hold
  ends when a person runs the model. A person's own merge is never held; a
  data feed's values are checked by its parser. The outlier limit is the
  engine's (5× the 99th percentile of the series' non-zero days for rain,
  10× for flow), taken from the series **without** the push (its days before
  the merge, less the days the push overwrites) and without every day that
  key wrote before and nobody has written since (`series_key_days`, 053),
  so a key can't lift the limit over itself, in one push or slowly, batch by
  batch under it. A person's write over a key's days (or a feed's) makes
  them count again: they are that person's values now. **Limits** (a
  partial mitigation):
  - a plausible wrong value, inside the series' usual range, isn't caught;
  - the outlier rule needs 100 non-zero days in the series, so a short
    series is checked for negatives only (a new one a key creates is held
    whatever its days, below);
  - when the days left without the key's own are too few for the rule (a
    series the key alone fills, like a logger's), the limit comes from what
    a person last **accepted**: the values the project's latest manual run
    read from that series (`run_input_series.series_id`, read by the key
    through `app_api_key_accepted_series`, 056), which a key can't write,
    since it can't make a run. Running the model is already what ends a
    hold, so it is the same act of review. Those values fill the key's
    days; days a person or a feed wrote since count as they are now. A
    poisoned day a person ran the model over becomes part of the
    reference: the reference is as good as that review;
  - **until a manual run has read the series** (or read fewer than 100
    non-zero days of it), there is no accepted reference, and the limit is
    deliberately the series without the push only, which that key's
    earlier pushes shape (`limitFrom: 'own'` in the held event and the
    response; the History line says the range was the key's own). The
    alternative, no outlier limit until a person runs the model, would let
    even one absurd value through; this still catches that, and a key
    poisoning slowly can lift it only until the first manual run. A run
    saved before 056 records no series, so it is no reference either.

- **A key can't swap the model's input** (issue #51). A run reads the
  first outlet series of each kind by name (`runs/execute.ts`
  `loadLiveInput`), so a key free to create series could add one named to
  sort ahead of the person's and the model would read the key's days, with
  nothing held (a new series has no history for the outlier limit). Two
  rules close it, for every key, whatever its `allowedSeries`:
  - a key may **create** a series only of a kind the project has no outlet
    series of; otherwise the merge is `409` and a person adds the series
    first, with its record so far: the message says so, since a series with
    fewer than 100 non-zero days is checked for negatives only (Limits
    above). The key may then merge
    into it (`series/merge.ts` `assertKeyMayCreate`, through
    `app_project_has_outlet_series`, SECURITY DEFINER because a key limited
    to some series can't see the others, `100_key_series_kind.sql`; called
    under the series cap's per-project advisory lock, so two keys can't add
    the second series of a kind at once);
  - a push that **creates** a series always holds the automatic runs
    (`newSeries: true` in `series.held` and `rerunHeld`, `series/hold.ts`
    `heldFor`): the series becomes the model's input for its kind, so a
    person looks before a run reads it.

  Tests: `ingest/ingest.db.test.ts` "a key can’t add a series the model
  would read in place of a person’s" (a second rain series refused for an
  open and an allow-listed key, the model input unchanged, a merge into the
  existing series as the positive control, a new kind held, the kind check
  answering only writers).

  Recovery is the runbook in
  [deployment.md § Runbooks](./deployment.md#runbooks) (revoke, find the
  days from the key's events, re-push; a key's merge keeps no series
  revision). Tests: `ingest/ingest.db.test.ts` (held, not queued, the
  handler waiting, a person's run ending it, a person's merge not held; a
  key pushing in batches held by the limit without its own days, another
  key's and a person's days counting, the guard's directions; a key that
  alone fills a series held by the accepted values, a genuine value passing,
  the `own` bootstrap before a manual run), `series/hold.test.ts`.
- **Scopes.** `series:write` only (a `CHECK` allows nothing else). The route
  checks it (`403`), and so does the database.
- **Allowed series.** Optional, 1–50 `{ kind, name }`. Checked in the route
  for a clear `403`, and again by the policies, so a series outside the list
  doesn't exist for the key.
- **Owner-only management.** `api_key` RLS: SELECT, INSERT (as yourself) and
  UPDATE for owners. `water_app` may update only `revoked_at` / `revoked_by`
  and may not `DELETE` (the catalogue test pins both), so a key's hash,
  scopes and series can't change after it is made. Revocation applies to
  the next request, and is final in the schema, as a share link's is: the
  `api_key_revoke_final` trigger (067) refuses an update that clears or
  moves `revoked_at` or changes `revoked_by`, except the foreign key's `SET
  NULL` when the revoker's account is deleted. `db/final-columns.security.db.test.ts`
  sweeps every column `water_app` may update whose name records a one-way
  event (`revoked`, `superseded`, `consumed`, `used`, `deleted`, `decided`,
  …) and fails on one no probe there covers. A key belongs to the project, not to the owner who made
  it: it keeps working if that owner leaves, and any owner can revoke it
  (the list says who made each one). Audit events `api_key.created` / `api_key.revoked`, and
  every ingest merge is `series.created` / `series.merged` by `API key
  “<name>”`, with the key's id on the row.
- **Transport.** No cookie is read or set, so CSRF doesn't apply; the
  existing `csrf()` middleware still refuses a cross-origin form post, and
  the routes take JSON only. CORS isn't opened: gateways aren't browsers.
  The general 4 MB body cap and the 60 000-day series cap apply. In
  production the WAF's per-IP limit covers `/api/ingest/*` too, before the
  per-key bucket.
- **Tests:** `ingest/ingest.db.test.ts` (owner-only CRUD with a positive
  control, only the hash stored, every bad key the same `401`, revoked and
  expired keys, another project's key in the API and in SQL, allowed series,
  scopes, what a key can't read, the audit actor, idempotency, `429` and the
  bucket under 12 concurrent takes), `ingest/keys.test.ts` (format, parsing
  before any database work, and the comparison going through
  `timingSafeEqual` whichever byte differs), `routes.test.ts` (the ingest
  routes key-gated, the owner routes session-gated) and
  `e2e/tests/api-keys.spec.ts`. `ingest/ingest.security.db.test.ts` sweeps
  the live inventories: every policy a key context can pass (`pg_policies`)
  is on an allowlist with its reason and calls `app_api_key_project`, so
  revocation and expiry reach every one; a key of the **same** project reads,
  updates and deletes nothing in any RLS table or view but its own allowed
  series and `series_key_days` rows (`isolation.db.test.ts` does another
  project's key; `app_user` is in the sweep, under RLS since 068); no GET route returns the secret or its hash after the `201`
  (`no-store`); an expired key's context sees nothing; a key can't rename
  or move its series out of bounds; and a wrong secret under a real prefix
  (which the History shows) takes nothing from the key's bucket.

## Alerts

Email alerts (roadmap WP-2.13; `051_alerts.sql`, [api.md § Alerts](./api.md#alerts),
[data-model.md § Alerts](./data-model.md#alerts-051_alertssql)). The risks
are mail-bombing (a loop, a flapping figure or a hostile editor mailing
people over and over), an unsubscribe link that can be forged or turned
against its owner, and a farmer's mail naming a neighbour's farm.

- **Opt-in per catchment.** Nothing is evaluated or sent until an editor
  switches a kind on (`PUT /projects/:id/alert-rules`, recorded as
  `alert_rules.changed`). The WUA decides when its members start getting
  mail, as it decides when a run is published.
- **Rate limits, in layers.**
  - *Once per crossing.* A rule has at most one firing event (a partial
    unique index), and it re-arms only after the value recovers past the
    threshold **plus a margin** (dam level + 5 points; other kinds in
    [api.md § Alerts](./api.md#alerts)), so a figure hovering at the line
    sends one mail, not one a day (`alerts/rules.ts`, `rules.test.ts`).
    A cleared event never fires again (`alert_event_guard`).
  - *Once per event per person, ever.* `alert_delivery`'s primary key is
    `(event_id, user_id)`, and `app_alert_fan_out` refuses an event older
    than an hour, so an old event can't be mailed out again.
  - *At most 5 immediate alert emails per person per day*
    (`ALERTS_DAILY_CAP`), the day running from 06:00 to 06:00 in the
    project's time zone (059_local_day; South Africa's by default); the rest
    wait for that person's next 06:00 digest, one email per
    catchment. A digest is bounded too: at most 20 alerts written out
    (`DIGEST_MAX_LINES`, the newest), then "…and N more" with a link to the
    app, all marked sent with it; and at most 200 lines a person are claimed
    for one digest (`app_alert_claim_digest`), older ones skipped as over the
    limit, so a flapping rule can't build a huge email or a backlog. The cap is applied when a delivery is claimed, one person at
    a time under an advisory lock, so two workers can't both send the sixth.
    This bounds what any source can send a person, a hostile editor
    flapping thresholds included (their edits are in the audit log).
  - *Never twice after a crash.* A delivery is marked `sending` before the
    mail goes and `sent` after; one left `sending` past its lease is marked
    `failed`, never re-sent. A transport error is retried at most 3 times.
  - *The kill switch.* `ALERTS_ENABLED=false` on the worker stops every send
    and drops what was waiting (`app_alert_skip_all`), so turning it back on
    doesn't release the storm; events still open and clear, so the app
    stays right ([deployment.md § Runbooks](./deployment.md#runbooks), alert
    storm; the `alert_storm` CloudWatch alarm).
- **Recipients, and access at send time.** `app_alert_recipients` (SECURITY
  DEFINER, search path pinned) lists who gets a kind from each member's
  **current** role (direct or through the team), their choice and the
  kind's default; applicants never, farmers only their own farms' dam
  alerts and the restriction notices, unverified addresses never. It
  answers an editor of the project (the job's acting user) or the worker's
  own context, and nobody else. When the mail is built, the worker opens a
  transaction **as the recipient** (`withUser`) and asks
  `app_alert_my_mode` again: a member removed after the event, or who
  turned the alert off, gets nothing (the delivery is `skipped` with why).
- **A farmer's mail names only their own farm.** The mail is built as the
  recipient under RLS: the event (`alert_event` RLS: a farmer sees their own
  farms' events and the notice events), the farm's name (`node` RLS) and the
  notice (`run_publication`) are read with the farmer's rights, so the mail
  can't contain a row they may not read. A dam event's `detail` comes from
  that farm's own publication projection. Tests scan the rendered farmer
  mail for every other farm's name (`alerts.db.test.ts`, `mail/alerts.test.ts`).
  The dam figure is the **published** projection's, never an unpublished
  run's: a farmer is told only what the WUA stands behind.
- **The unsubscribe token.**
  - Each subscription has a random 32-byte nonce; its token is
    HMAC-SHA256(`ALERTS_TOKEN_SECRET`, nonce), base64url (43 characters),
    and the row stores only the token's SHA-256 (`unsubscribe_hash`,
    unique). Only the worker holds the secret (it builds the mails, and
    derives the same token for every mail, so a link in an old mail keeps
    working); the API checks a token by its hash alone and has no secret to
    leak. Neither a database leak (nonce and hash) nor the secret alone
    makes a valid token.
  - It **only ever turns its own subscription off**
    (`app_alert_unsubscribe`), without signing in: a leaked link can at
    worst stop one person's alerts of one kind (a digest's, all of one
    catchment's), and "Manage your alerts" turns them back on.
  - *Tampered*: hashes to nothing, `404`. *Replayed after a re-enable*:
    turning a choice back on draws a new nonce and clears the hash, so the
    old link is dead. *Expired*: there is no time limit (old mails must keep
    working), but a token whose person is no longer a member (or, a farmer,
    no longer linked to the farm) is refused. A repeat of a valid token is
    harmless (a mail client may post twice).
  - *Where it travels.* The mail's link is `/alerts/unsubscribe#t=<token>`:
    in the fragment, like share links, so it never reaches a server log;
    the page strips it from the address bar and POSTs it as JSON. The RFC
    8058 `List-Unsubscribe` header must carry it in the URL
    (`/api/alerts/unsubscribe?token=…`: a mail client's one-click post has a
    fixed body), so that one address can appear in CloudFront, WAF and API
    access logs; its worst use is the one above.
  - *The page asks first.* The landing page shows "Stop these emails" and
    acts on the click, not on arrival, so a mail scanner that opens (and
    even renders) links can't silently switch a farmer's dam alerts off.
    The one-click header is the one-click path.
  - *CSRF.* `POST /alerts/unsubscribe` is the only route exempt from the
    `csrf()` check (`app.ts`, exact method and path): a mail client
    form-posts it from its own servers with no Origin. It reads no session
    cookie, so a forged cross-site post can do only what the token's holder
    could do anyway. `routes.test.ts` checks the exemption stays that
    narrow (the same form post to any other route is refused).
  - *Rate limiting.* The WAF's per-IP rule on `/api/*`; a 256-bit token
    can't be guessed.
- **Headers.** `List-Unsubscribe`, `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` and `Auto-Submitted: auto-generated` go out on
  every alert mail (SESv2 `Simple` content's `Headers`; nodemailer's
  `headers`). `sendMail` makes every header value one line and refuses a
  header name that isn't a token, so no user text can inject a header.
- **Liability.** A dam alert says it is the model's estimate from the WUA's
  published figures, not a measurement of the dam or an instruction, to
  check the dam and ask the WUA, and that only a notice from the WUA or DWS
  is a restriction (to the WUA's staff, the same in the third person); the staff-only EWR forecast alert says it comes from the
  newest forecast run, which may not be published, and is an estimate, not
  a restriction; a forecast says forecasts change; a restriction notice
  says it is the WUA's own words and questions go to the WUA. The
  operational alerts (feeds, jobs) carry no liability line
  ([ui.md § Alerts](./ui.md#alerts)).
- **A bounced or complaining address pauses its alerts.** SES drops mail
  to an address on its suppression list; the app learns of it through the
  configuration set's `BOUNCE` / `COMPLAINT` event destination → SNS
  `ses-events` → SQS `mail-events` → the worker (`mail/suppression.ts`,
  057). The person's `app_user.mail_suppressed_at` is set, they drop out of
  `app_alert_recipients`, the deliveries waiting for them are skipped, and a
  delivery already made is skipped when it's built (the worker checks the
  flag as the recipient). Their choices are kept, so turning mail back on
  restores them.
  - *Trust.* Only SES, for this configuration set in this account, may
    publish to the topic (`aws:SourceArn`, `aws:SourceAccount`); only the
    topic may send to the queue; the worker reads a record as an SES event
    only when it came from that queue (`MAIL_EVENTS_QUEUE_ARN`), and a
    message on the mail queue is never read as a job message or the other
    way round (`lambda-worker.test.ts`). The body is parsed strictly
    (size, at most 50 recipients, only a permanent bounce or a complaint
    suppresses), and `app_mail_suppress` runs only in the worker's own
    context. The log line carries counts, never an address.
  - *Stale events.* An event about a mail sent before the person last
    turned mail back on (`mail_resumed_at`) suppresses nothing.
  - *Turning it back on* (`POST /me/alerts/resume`) clears only the caller's
    own flag and takes their address off SES's account-level suppression
    list (`ses:DeleteSuppressedDestination`, the API role only; `*` is the
    only resource IAM allows for it). At most once a day per person (`429`
    otherwise; checked and stamped in one conditional `UPDATE`, so two calls
    at once can't both pass), so an address that keeps bouncing costs the account one
    bounce a day, not a loop.
  - *The SES endpoint.* The SES API endpoint's policy repeats the IAM
    split (`ses_endpoint`, `ses.tf`): the API and worker roles may send, as
    no-reply@ only, and only the API role may release an address; no other
    principal can use the endpoint. That the endpoint carries
    `DeleteSuppressedDestination` at all is to be confirmed on the first
    deploy (infra/README.md step 10b, #126).

## Authorization: per-project roles enforced by Postgres RLS

Full detail is in [data-model.md § Access control](./data-model.md#access-control).
In short:

- **Cross-project isolation is swept, not sampled**
  (`backend/src/isolation.db.test.ts`). Every API route that names a
  project or team is called by a signed-in outsider and by another
  project's owner with the victim's ids: every read must fail without
  leaking the victim's data, every write must fail, and the victim's data
  must be unchanged afterwards. Every table with a `project_id` is then
  read, updated and deleted through RLS as those users and as another
  project's API key: nothing visible, nothing changed. Both sweeps come
  from the live route list and the catalogue, so a new route or table is
  covered automatically; the owner's positive controls prove they aren't
  vacuous. The two layers are tested apart: `requireRole` answers 404 at
  the route, and RLS alone must hold if a route forgets it.
- **Accounts under RLS** (`068_app_user_rls.sql`). `app_user` had no RLS
  (sign-in reads it before anyone is signed in), so any `water_app`
  transaction, an API key's or the job tick's included, could read every
  account's address and password hash and update any account. Now a
  signed-in person sees their own row and the people they work with
  (`app_user_visible`: anyone who is, or was, part of a project they can
  open, or in a team with them; "was" keeps a removed member's name on the
  runs, scenarios and jobs they made, which the routes inner-join), and
  updates only their own row. A farmer (073) sees, in a project they are
  only a farmer in, just the accounts their pages name (the publication's
  publisher and last editor, a farm note's author on their farm, whoever
  linked them), never another farmer's or a member's address. An applicant
  (a `contributor`, 076) sees the same, plus the owner, the other shared
  members and the deciding assessor of the applications they read, never
  another applicant's or a member's address. No user (an API key, pre-sign-in, the tick)
  sees no account. Nobody inserts or deletes one directly: sign-up is
  `app_register`, deletion the operator's. The pre-sign-in paths use narrow
  `SECURITY DEFINER` lookups that answer one account (`app_auth_account` for
  sign-in and forgot-password, `app_session_revoked_at` for the session
  check), adding a member by address uses `app_user_by_email` (signed-in
  callers only), and the token-proven flows (verify, reset) act as the
  account the token proved (`actAsUser`, `db/tx.ts`).
  `backend/src/auth/app-user.security.db.test.ts` proves each, with positive
  controls, and lists every inner join to `app_user` in the backend
  (`JOIN … ON`, an `UPDATE`'s or a comma join's `FROM app_user`) so a new
  one needs a decision. Every view must be `security_invoker` (an
  owner-rights view skips RLS): `db/catalogue.db.test.ts` fails on one that
  isn't, or on a materialized view, unless it is allowlisted with a reason.
- **RLS refusing a write is never a silent success** (issue #56). A write
  on a row the route has already authorised goes through `mustChange`
  (`backend/src/http/errors.ts`): zero rows changed means RLS refused it,
  and the route answers 404, what a non-member gets, instead of 2xx.
  `backend/src/rlsSecondLayer.db.test.ts` switches the role check off and
  proves a viewer's project, series and team writes each get that 404 and
  change nothing.
- **Same-project references are swept from `pg_constraint`**
  (`backend/src/db/cross-project-refs.security.db.test.ts`). RLS can't stop
  an editor of *both* A and B pointing a row of A at a row of B, and a
  foreign key is checked without RLS (so an id, even another project's, is
  enough). Every foreign key onto a table with a `project_id` is therefore
  either composite on `(project_id, …)` or held by a same-project trigger
  (`assert_same_project` or the table's own guard), except three with a
  checked reason (`api_key_throttle` and `report_schedule_recipient` have
  no `project_id`; `alert_delivery` has no write policy). The test tries each
  as `water_app`, INSERT and (where `water_app` may) UPDATE, with A's row
  (accepted) and B's (refused), then every write route whose body names a
  row (inventoried from the zod schemas' uuid fields), and finally checks no
  row of A or B references the other. A new foreign key or request field
  fails until it is classified. 069_cross_project_refs closed the two it
  found: `model_revision.restored_from` (sequential ids, so any editor could
  plant a "restore" of another project's revision and, the key being NO
  ACTION, block that project's deletion; `restored_from_run` is held the
  same way) and `alert_event.run_id`. A reference that is deliberately not
  a foreign key is held the same way on write: `time_series.site_node_id`
  (084, a gauge record's site) by `time_series_site_same_project`, and the
  PATCH route finds the node in the project first
  (`series/site.db.test.ts`).

- Roles are **viewer < editor < owner**, per project (with `farmer` and
  `contributor` below viewer, WP-2.1 and WP-3.3: see below). A team grants one of
  them on every team project: team **viewer → viewer**, **member → editor**,
  **admin → owner** (`app_project_role()`, 008_team_viewer). The mapping is
  explicit and an unrecognised team role grants nothing, in SQL
  (`app_project_role`), the API (`hasTeamRole`) and the UI, so a role added
  later can't silently become an editor. `backend/src/teams/teams.security.db.test.ts`
  guards it from the live `team_role` and `project_role` enums: a new team
  role fails until its mapping is pinned there, every team role × direct role
  pair resolves to the higher of the two, and a team role the mapping doesn't
  name (a renamed enum value, rolled back) grants nothing. It also proves that
  losing the team (removed, left, the team deleted, the project moved out)
  leaves the user no row of the project in any `project_id` table, not even
  the runs, notes and scenarios they wrote, no RLS update or delete, and no
  route under `/projects/:id` that answers; and that no one below team admin
  can promote, add or remove members through RLS.
  **The ladder is swept, not sampled** (`backend/src/projects/role-ladder.db.test.ts`):
  every `/projects/:id` route is called with a request its validation
  accepts (so a route that parses before it checks the role can't hide
  behind a `400`), and a wrapper on `requireRole` records the role each one
  asks for. A write needs editor unless it is in `LOWER_ROLE_WRITES` (leave
  the project, copy it, a report to yourself, your own alert preferences,
  notes, scenario routes whose own rules decide), with the reason and the
  status a viewer gets; the owner-only routes are exactly `OWNER_ONLY` and
  the editor-only reads exactly `EDITOR_READS`, and the routes below viewer
  (the farmer's and the contributor's) exactly `BELOW_VIEWER`, each with the
  lowest role it admits and why. Viewer, contributor and farmer get `403`
  from everything above them and nothing changes; a farmer gets `403` from
  every contributor route; a farmer or contributor asking an allowed route
  for an id that isn't there gets `404`; an editor gets `403` from every
  owner-only route; the farmer, the contributor, the editor and the owner
  pass their own checks (positive controls). This replaced the older
  per-role sweeps in `farms.db.test.ts` and `applications.db.test.ts`,
  which sent empty bodies and accepted `400`, so a route that validates
  before its role check never reached it.
  The role functions every policy
  calls (`app_current_user_id`, `app_team_role`, `app_project_role`,
  `app_has_role`) are PL/pgSQL since 026_rls_role_plpgsql: a SQL function with
  `SECURITY DEFINER` or a pinned `search_path` can't be inlined and is planned
  again on every call, and a policy calls them once per row (writing a run's
  hundreds of series spent 0.8 ms a row on them). Keep new role helpers in PL/pgSQL
  for the same reason. And return before the query when there is no user
  (`app_current_user_id()` NULL: an API key's session, the job queue's), as
  `app_project_role` does since 094_role_check_no_user and `app_user_visible`
  always has: with the user NULL every custom plan of the query folds to
  "false" and looks cheaper than the generic plan, so PL/pgSQL's plan cache
  plans it again on every call (~150 µs a row; the ingest key sweep over
  every table timed out in CI). `role-check.db.perf.test.ts` guards it.
- The backend connects as **`water_app`**: no superuser, no `BYPASSRLS`, owns
  no tables. Each request that touches project data runs in a transaction that
  sets `app.current_user_id` (transaction-local), and RLS policies on every
  project table check membership and role. A bug that forgets a `WHERE
  project_id = …` therefore returns nothing rather than someone else's data.
  The one other request context is an ingest request's `withApiKey`
  (`app.current_api_key_id` and no user), which the key policies limit to
  its own project's series ([§ API keys](#api-keys)).
- A project you are not a member of returns **404**, never 403, so project
  existence doesn't leak.
- **Change history and audit log (WP-2.4, 030).** `model_revision`,
  `series_revision` and `audit_event` are append-only for `water_app`
  (`SELECT` and `INSERT` grants, no `UPDATE` or `DELETE` policy); only the
  `series_revision` retention trigger deletes, and only that series' old
  rows. An audit row must name the caller as its actor. Viewers and above
  read history; farmers and strangers see nothing. Invite emails in events
  are masked. A team role is a project role on every team project, so a
  team member added (directly or by an accepted invite), re-roled, removed
  or leaving, and a team deleted, is an event on each of the team's projects
  (`team_member.*`, `team.deleted`; 072). Guards:
  `history/write-routes.db.test.ts` sweeps every write route in `app.routes`
  (under `/projects/:id` and outside it) for the row it must write, with a
  reason for each exemption; `history/audit-trail.security.db.test.ts` tries
  `UPDATE`, `DELETE` and `TRUNCATE` on the audit trail (the three tables,
  `signoff`, `run_nomination`) as every actor (each project role, a team
  admin, a stranger, an API key, no user) and lists the only functions whose
  body rewrites a trail row (two triggers: the series retention trim and
  account-deletion pseudonymisation). Details: [data-model.md § Change history and audit log](./data-model.md#change-history-and-audit-log-030_historysql).
- **`SECURITY DEFINER` functions are executable by `water_app` only**
  (028_definer_grants, issue #37). They run as the owner, so Postgres's default
  `EXECUTE` grant to `PUBLIC` would hand the owner's rights to any role that can
  connect. Every one has `PUBLIC` revoked; the non-trigger ones are granted to
  `water_app` (routes and RLS policy expressions call them as it); trigger
  functions get no grant (Postgres checks `EXECUTE` only at `CREATE TRIGGER`).
  The owner's default privileges close future functions the same way, and a
  catalogue guard (`catalogue.db.test.ts`) fails if any `SECURITY DEFINER`
  function is executable by a role other than the owner and `water_app`.
- **Farm scope (WP-2.1, 019/020).** A `farmer` ranks below viewer, so every
  existing policy and every `requireRole(…, 'viewer')` refuses them (fail
  closed; `projects/role-ladder.db.test.ts` calls every `/projects/:id` route
  as a farmer with a request its validation accepts and expects `403` at the
  role check, except the reasoned `BELOW_VIEWER` routes). Extra `SELECT` policies let them read their linked
  farms, the gauges and their own membership row, and nothing else: no other
  farm's name or figures, no member list, no series, runs or run series. A
  farmer-facing aggregate of farm quantities needs at least `k − 1` other
  holders (`app_other_farm_holders`, `k = 5`), counted by holder, not farm
  node, so a multi-farm owner can't back out a neighbour's figures; flow
  volumes are never shown to farmers because in a small catchment they reveal
  a neighbour's use (design [farmer-view.md §10](./design/farmer-view.md)).
  Open with the client and the security lead: who may hold viewer on a
  project with farmers (FV-D5), since viewers see every farm.
- **Seasonal outlooks to farmers (issue #53 R5, 106).** A farmer never
  reads a seasonal outlook (`seasonal_outlook` stays viewer-only): an
  editor publishes one level, and the farmer reads that publication's row
  for their own linked farms only (`outlook_publication_farm_select`:
  viewers, or `node_id IN app_farm_nodes(project_id)`), holding the engine's
  `FarmOutlookProjection`, that farm's own share of demand met and its own
  dam's end-of-season fill, no other farm's id, name or figure
  (`views/farmOutlook.test.ts`, `outlooks/publication.db.test.ts` with a
  positive control, beside an unlinked contributor and a user with no role
  here, who read no farm's row). The publication row itself (level, season,
  who published) is every member's; no route gives a farmer more than their
  farm's projection, the season and the level (`GET /outlook-publication`
  is viewer+). What was published is append-only; a publication is ended,
  never edited or deleted by `water_app`. Issue #122's privacy review found
  no catchment-wide outlook figure reaching farmers, so the `k ≥ 5` rule
  isn't engaged; one reaching them later must apply it. The level label is
  the WUA's own free text (up to 100 characters) and reaches every farmer
  as typed, so it is the WUA's to keep free of figures
  ([farmer-view.md §12](./design/farmer-view.md)).
- **Publications and the farm view (WP-2.3, WP-2.6 API, 022).** A farmer reads
  run results only through the project's current publication: its counts-only
  `catchment_view`, their own farms' stored projections (`publication_farm`)
  and their own farms' farm-allowlist series of the published run
  (`run_series_select_farmer`: `demand`, `supplied`, `deficit`,
  `dam_storage`, `spill`, `transfer`; no flow series, no catchment series,
  nothing of an earlier publication). A superseded publication is history
  and frozen in the schema (`run_publication_final`, 067): no column of it
  changes, so an editor can't rewrite an old notice or bring an old
  publication back as current. The farm routes
  (`/projects/:id/farm…`) admit the farmer role, answer `404` alike for a
  node the farmer isn't linked to, a gauge or a node that doesn't exist, and
  null the even share below `k − 1` other holders per viewer. Tests:
  `publish/publication.db.test.ts` scans a farmer's farm view and
  publication list for every other farm's id and name, with positive
  controls; `role-ladder.db.test.ts` keeps every other `/projects/:id` route
  refusing a farmer. `farms/farmer-privacy.security.db.test.ts` sweeps the
  inventories so a new table or route is covered the day it lands: every
  `project_id` table read as each farmer (and a co-farmer on the same farm)
  may show only rows naming their own farms, their own `user_id` rows, and
  the reasoned `FARMER_MAY_READ` extras; every farmer GET answer is scanned
  for the neighbour's farm, crop, note, allocation holder and name; every
  farmer write aimed at the neighbour's farm is refused and changes none of
  its rows (positive controls: each farmer's own farm, and a viewer). The modeller's publication `note` is withheld from
  farmers by the API but not by RLS (a column can't be hidden from one role
  there): the publish dialog tells the modeller farmers don't see it, and it
  must not be relied on as a secret. Publishing records `published_by`, and a
  notice change `updated_by` / `updated_at`; the full audit log is WP-2.4.
  Share links (a public, token-bearing catchment page) are not built yet
  (WP-2.3 phase 2).
- **Notes (WP-2.7, 037).** The note routes admit the farmer role and leave
  the scoping to RLS: a farmer reads and writes only `farm`-visible notes on
  their linked farms (`note_select_farmer`, `note_insert`), never a `team`
  note or a run, settings, project or other farm's note. Only the author
  edits a body (`note_guard`); a delete is soft, the body kept for editors'
  audit trail and hidden from everyone else. Bodies are plain text, rendered
  with Svelte's escaping (no `{@html}`, no markdown; the `rawHtml.test.ts`
  guard, [§ Input handling](#input-handling)). The project export
  (`export.json`, viewers and above) carries the undeleted notes the
  exporter can read and never a deleted body, even to an editor; the import
  ignores them and a copy takes none, so a note is never re-authored under
  someone else's name ([data-model.md § Notes](./data-model.md#notes-037_notessql)). Tests:
  `notes/notes.db.test.ts`, with positive controls; `role-ladder.db.test.ts`
  lists the note routes among the farmer-allowed ones (`BELOW_VIEWER`).
- **Same-project triggers** reject references to another project's nodes or
  crops, even when the UUID is known. `land_cover` (013, WP-1.35) has the
  model tables' viewer/editor policies and a same-project trigger on its
  `node_id`; `human-impacts.db.test.ts` checks a member sees its patches, a
  non-member none, and a patch can't be attached to another project's farm.
- A **last-owner guard** means a project can't be orphaned (and a
  last-admin guard, a team).
- **Runs are immutable by privilege.** `water_app` may `UPDATE` only
  `model_run.notes` (a column-level grant, 007_run_notes), so no API bug can
  rewrite a run's inputs, outputs or label after the fact; who last changed
  the note is stamped by a trigger. The catalogue test pins that column list.
- <a id="tamper-evidence"></a>**Tamper evidence for the nominated evidence run** (010_run_nomination).
  Which run, and so which runoff model, a project stands behind is kept as an
  append-only history, so an applicant can't quietly switch to whichever model
  is kindest and pretend it was the choice all along:
  - `water_app` has `SELECT` and `INSERT` on `run_nomination` and nothing
    else, with no update or delete policy: changing the nomination adds a
    row, and no API bug or direct SQL as the app can rewrite or remove an
    earlier one (the catalogue test's `APPEND_ONLY` guard pins it).
  - Who, when, the runoff model and the engine version are stamped by a
    `SECURITY DEFINER` trigger from the session and the run itself, so they
    can't be forged; the reason is required.
  - The runs the history names are kept: the foreign key refuses their
    deletion, the run cap skips them, and the delete route answers `409`.
  - The history shows everywhere a reader weighs results: the Runs tab, the
    run header, compare, the summary CSV; a later run of another runoff model
    raises a warning (since engine 1.0.0 only a stored legacy run can be
    one).
  - The **project is kept too** (issue #43, 035_project_evidence_guard): a
    project with any nomination, current or since replaced, can't be deleted.
    The `project_evidence_guard` BEFORE DELETE trigger (`SECURITY DEFINER`,
    `search_path` pinned) refuses it for every role, the schema owner
    included, and on every path: the route (which answers `409` first,
    naming the run), a direct `DELETE` as `water_app`, and any cascade into
    `project` (there is none today: deleting a team sets `project.team_id` to
    `NULL`, and there is no account deletion; an `app_user` row that created a
    project or a nomination can't be deleted anyway). The history can't be
    withdrawn, so once a project nominates it is kept for good; a copy starts
    afresh without its runs.
  - The operator can still remove such a project out of band (a court order,
    a test project that nominated by mistake), deliberately and visibly: as
    the schema owner, in one transaction, `ALTER TABLE project DISABLE
    TRIGGER project_evidence_guard; DELETE FROM project WHERE id = '…';
    ALTER TABLE project ENABLE TRIGGER project_evidence_guard;`. Record why
    in the operator log; the app has no path to it.
  - A project with an evidence pack past draft is kept too
    (112_evidence_pack, `project_pack_guard`, [§ Evidence packs](#evidence-packs)).
  - Limits: an issued pack's PDF and reproduction bundle, which survive
    outside the database, are not built yet (WP-3.14, [evidence-pack.md](./evidence-pack.md)). The schema owner (`water`, migrations only)
    is not bound by the grants. A nomination proves what the project said and
    when, not that the run is right: that is the assessor's review.
- **Uncertainty bands can't be cherry-picked or forged** (014_run_uncertainty,
  [model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9)).
  An applicant could otherwise run an ensemble again and again, with other
  seeds or looser thresholds, and keep only the kindest band, or post a band
  the model never produced:
  - the **database draws the seed** when the ensemble is started, before
    anything runs, and stores the resolved options and thresholds with it;
    neither is in the app's column grant, so neither can change later;
  - every start is **kept** (no `DELETE` grant or policy): the Runs tab shows
    how many ensembles a run had, abandoned ones included, and what differs
    between their rules;
  - a result is stored **once**, by whoever started it, and only after the
    server has regenerated the whole Latin-hypercube sample from the seed and
    re-run member 0 and **three members picked with `crypto.randomInt`**,
    finding the same scores, verdicts and outputs (`verifyEnsemble`,
    `verifyPaired`, tolerance 1e-6 relative); the bands are then summarised
    on the server from the members, and the header (farms, sites, EWR line)
    comes from the server's own run of member 0;
  - limits: an unchecked member's outputs are taken on trust, so a forger
    must alter members the server may not pick (each check has a chance of
    catching it; forging many members is caught almost surely); the coverage
    count needs every kept member's daily flow, so the server checks only
    its consistency, and "Reproduce" in the Runs tab re-runs the whole
    ensemble in any viewer's browser. The engine version must match: an
    ensemble started on another version can't be completed.
- **Background jobs run as a person, never as the system** (016_jobs,
  [architecture.md § Background work](./architecture.md#background-work)).
  A job is queued by an editor, as themselves (RLS; the insert trigger stamps
  the acting user and resets every lifecycle field, so a forged `done` or
  another user's id doesn't stick), and the worker runs it inside
  `withUser(acting user)`: normal RLS, and a role check first that fails the
  job closed (dead, nothing written) if the user was demoted or removed
  since. There is no RLS-bypassing principal. The only cross-project steps
  (claim, finish, purge, queue stats) are `SECURITY DEFINER` functions with a
  pinned `search_path`, executable by `water_app` only, that return routing
  columns and never a payload; the worker reads the payload as the acting
  user and validates it as untrusted input. `water_app` has no `UPDATE` or
  `DELETE` on `job`. A job's stored error is written by the server, never
  database text, and wake messages carry a job id only.
  Both halves are swept over the live handler registry
  (`jobs/trust.security.db.test.ts`): every kind is dead once its user drops
  below the handler's role (only `report_render` runs for a viewer, on an
  allowlist with its reason), and a job queued in one project whose payload
  names another project's feed, report, sweep, outlook or run changes nothing
  there, even for someone who edits both (the handler scopes every read by
  the job's project; `app_begin_feed_fetch` and the `yield_result` guard
  check it again in the database). The per-user caps on queued
  sweeps, outlooks and yield calculations (2 each) are counted under a
  per-user advisory lock, so a concurrent burst can't pass them, and the
  database refuses a sweep member or outlook level past the API's cap
  (`jobs/costCaps.security.db.test.ts`).
  **Automatic re-runs** (042_auto_rerun, [architecture.md § Automatic
  runs](./architecture.md#automatic-runs)) are queued and pushed back by
  `SECURITY DEFINER app_enqueue_rerun`, which touches only that project's
  pending re-run, and only for someone `app_rerun_acting_user` answers for:
  the signed-in editor, or a live API key of the project, whose re-run runs
  as the key's creator and fails closed if they are no longer an editor
  ([§ API keys](#api-keys)). `job_enqueue` still stamps any signed-in enqueuer
  and refuses a plain insert with no user; only a definer function
  (`current_user` ≠ `session_user`) may name the acting user. A client can't
  queue an auto re-run (`POST /jobs` takes a label only), and an auto run
  never publishes itself unless the project opted in to "if no new
  warnings", never for the first publication.
- **The evidence report is a viewer read, and adds nothing a viewer can't
  already see** (issue #71, `GET /projects/:id/runs/:runId/evidence-report`,
  `backend/src/evidence/report.ts`). `requireRole(…, 'viewer')`, so a
  contributor or farmer gets `403` (the role ladder lists it with the other
  viewer reads). It runs in one `withUser` transaction opened read-only, so
  building the report can't write, and RLS decides every row it reads: the
  named run, the base run it recorded (`404` if the reader can't see it),
  the scenario, nominations, publications, history and ensembles. What it
  returns is what `/compare/runs` and the Runs tab already show a viewer
  (the two runs' summaries and inputs, the input diff with stored values,
  every farm by name), assembled by the pure engine builder; Step 3 D2's
  anonymising is for what an applicant holds (ER10), and a contributor gets
  none of it.
- **An import report can't be forged or rewritten** (017_project_import). What
  the importer flagged is the audit trail of a workbook's mistakes, so only the
  import that created the project may write it (the insert trigger checks the
  project was created by that user in the same transaction and stamps who and
  when), and `water_app` has no `UPDATE` or `DELETE` on it. Viewers read it.
  See [§ Import reports](#import-reports).
- **Stored run inputs are readable only through a run you can see, and are
  never shared across projects** (021_series_blob, roadmap WP-3.1,
  [data-model.md § Stored run inputs](./data-model.md#stored-run-inputs-021_series_blobsql)).
  A run's input series are kept content-addressed (`series_blob`, keyed by
  the SHA-256 of the values) so the run can be recomputed years later:
  - **Dedup is per project, by design.** The key is `(project_id, sha256)`,
    not the hash alone. A global store would dedup a little more (two
    projects with the same public rainfall record), but it would need a read
    path from one project into content another project wrote, and an
    `INSERT … ON CONFLICT` would tell anyone who can write a blob whether
    *some other* project holds exactly those values: an existence oracle for
    guessable data. Per project, neither exists; the cost is one extra copy
    of a series two projects share (tens of KB).
  - **Read = through a visible run.** `series_blob`'s `SELECT` policy needs a
    `run_input_series` row the user can see, and that table's needs a
    `model_run` the user can see; both subqueries are themselves under RLS. So
    blobs follow `model_run`'s policy (viewer today), and narrow with it if
    run visibility does (045: an application's runs follow the application). Knowing a hash gives
    nothing: another project's member reads no row, by hash or at all
    (`reproducible.db.test.ts`, with the owner and a viewer as positive
    controls), and can't point a run of theirs at it (the composite foreign
    key finds no such blob in their project).
  - **Immutable by privilege.** `water_app` has `SELECT` and `INSERT` only on
    `run_input_series`, and `SELECT` only on `series_blob` (the catalogue
    test's `APPEND_ONLY` and `NO_INSERT`). A blob is written only through
    `app_store_series_blob` (074_series_blob_digest, `SECURITY DEFINER`, for
    an editor or a contributor), which takes the values as their JSON text
    and keys the blob by that text's SHA-256 itself, so no caller, even past
    the API, can put other values under the hash of content a later run will
    store (that run would otherwise reference the planted blob and fail
    `loadRunInput`'s check). A reference only by an editor, to a run of the same project
    saved **in the same transaction** (the insert policy checks
    `model_run.created_at = now()`), so an older run can't be given inputs
    after the fact. Removal is only the `series_blob_gc` trigger
    (`SECURITY DEFINER`, pinned `search_path`), which deletes a blob of the
    affected project once no run references it; the foreign key refuses
    removing one that is still referenced.
  - **Integrity on the way out.** `loadRunInput` re-hashes every blob and
    checks it against the run's own snapshot hash, start date and length, and
    refuses (`inconsistent`) rather than present altered values as the run.
    The schema owner (`water`, migrations only) could still alter a blob; the
    check catches that too.
  - **Cited runs** (`model_run_cited`, `SECURITY DEFINER`): it answers only
    "is this run cited" for a run id the caller already holds, and sees every
    citation even when a narrower policy hides the citing row from the caller,
    so a trim never tries to delete a run someone else's scenario rests on.
- **Scenarios are the project's, and a submitted one can't be changed**
  (024_scenarios, [data-model.md § Scenarios](./data-model.md#scenarios-024_scenariossql)).
  Viewers read, editors write; farmers read nothing, because a scenario's ops
  and its base run name every farm (fail closed, as for `model_run`). The
  `scenario_guard` trigger (`SECURITY DEFINER`, pinned `search_path`; it
  reads `model_run` past RLS only to compare two project ids) stamps the owner
  from the session, refuses a base run of another project even to an editor of
  both, and freezes a scenario's ops, base and owned nodes once it isn't a
  draft, whatever the API does; a scenario run records the ops it applied, and
  their SHA-256, in its own immutable snapshot. Ops are untrusted input: the
  engine's validator rebuilds each from its known fields (unknown keys never
  reach the database), ids must be UUIDs, and at most 500 ops and 1 MiB are
  stored. A run series can name only a node of its own run's snapshot
  (`run_series_nodes_in_run`), so no run can be given series for another
  project's node.
- **Applicants: the contributor role** (WP-3.3, 044/045,
  [data-model.md § Applicants](./data-model.md#applicants-044045),
  [scenarios.md § Applications](./scenarios.md#applications-wp-33)). A new
  trust boundary *inside* a project: an applicant works on the assessor's
  published baseline without seeing other applicants' drafts, other farms'
  inputs or anything unpublished.
  - **Fail closed.** `contributor` ranks below `viewer`, so every existing
    policy and every `requireRole(…, 'viewer')` route refuses it untouched;
    `projects/role-ladder.db.test.ts` calls every `/projects/:id` route as
    a contributor with a request its validation accepts and requires `403`
    at the role check except the `BELOW_VIEWER` ones (the farmer's, and the
    scenario routes, where RLS and the route's own rules decide), and the route inventory (`routes.test.ts`) lists every new
    route as auth-gated.
  - **The published run stays on the server.** A contributor can't read any
    run's row (its `inputs` and `summary` hold every farm), `/runs/*` and
    `/compare/runs` refuse them, and a scenario run answers them with its
    metadata only. The base reaches the server through
    `SECURITY DEFINER` `app_published_run_input` / `app_published_run_series`
    (only a run a publication names, only to a contributor or above); what
    leaves is the applicant projection (`scenarios/applicant.ts`: their own
    farms and the gauges in full, every other node anonymised and blanked).
    An application is checked in its applicant's namespace (049: the engine
    meets every hidden node under its anonymous name, and every hidden crop,
    transfer, land-cover patch and borehole under an opaque id and name,
    `applyScenario`'s `mask`), so its messages quote no hidden name or id
    without any text redaction, count nothing hidden, and a rule broken
    because of hidden data reads only "doesn't apply to the catchment as
    modelled" (wording pending the client, issue #90). The DB test scans everything the applicant
    received for another farm's name. RLS gives a contributor no run row
    at all, their own application's included (046_contributor_runs), since
    its `inputs` snapshot is the whole base with the ops applied: the run
    count, last run and a new run's metadata come through the `SECURITY
    DEFINER` `app_scenario_run_meta` (never `inputs` or `summary`), and the
    owner's run cap through `app_trim_application_runs`. Of an application
    run's series they read its own nodes' and the catchment allowlist
    (under the share links' k), never another farm's. The one deliberate
    path to a full input in a contributor's transaction is
    `app_published_run_input` / `app_published_run_series`, which the
    server needs to run the application and projects before anything
    leaves.
  - **Drafts are private, even from the assessors.** Who reads an
    application is one function (`app_scenario_visible`), and its runs and
    their series follow it; editors see it once submitted, viewers once
    decided. The project's log names an application only once it is decided.
    Notes on its runs, sign-offs of them and yields of it or its runs follow
    it too (045 rewrote `note_select`, `signoff_select` and
    `yield_result_select`, which had checked the project role only).
  - **Tables added alongside it** (sign-offs, notes, allocations, API keys,
    yields and jobs, dam curves, boreholes) were audited at the merge: a
    contributor reads only their own linked farm's farm-scoped rows (as a
    farmer does) and none of the viewer or owner tables
    (`scenarios/contributor-tables.db.test.ts`, each with a positive
    control). The one later exception is their own yields
    (`096_contributor_yield`): a yield job and its result on a dam of an
    application they own, and nothing of anyone else's
    (`yield/contributor.db.test.ts`). The worker admits a role below a job
    kind's own only through `JobHandler.alsoRole`, exactly that role, and the
    handler checks the target again as them; `jobs/trust.security.db.test.ts`
    allowlists each such kind with its reason. The notes route treats a contributor as a farmer (a farm note
    on their own farm only), and the team portfolio query now requires
    `role >= 'viewer'` rather than `role <> 'farmer'`, which a contributor
    passed.
  - **No one decides their own application**: the trigger refuses a decision
    by the owner, whatever their role by then.
  - **An application's own farms are its owner's farm links, now**
    (071_application_own_nodes). The `scenario_owned_nodes` trigger refuses
    an application whose `owned_node_ids` name a farm its owner isn't linked
    to (`42501`), so a write past the route can't claim a neighbour's farm;
    and what a contributor sees in full (the base projection, the check, a
    new run, their runs' series through `app_contributor_run_nodes`) is the
    stored list cut to the owner's *current* links
    (`app_application_own_nodes`): once the owner unlinks a farm (it changed
    hands), an application made while linked shows it anonymised like any
    other. The stored list stays the assessors' record.
  - **The "nothing else" sweep** (`scenarios/applicant.security.db.test.ts`)
    runs as applicant A beside applicant B over every table with a
    `project_id` (from `pg_catalog`): what A reads is a subset of its `READ`
    map, what A updates or deletes of `CHANGE`, and no copy of a row A can't
    read inserts; then every contributor route that takes an id, with B's
    application, farm, note and consultant, answers `403`/`404`, names none
    of them and leaves B's rows unchanged. No insert is a known gap
    (`KNOWN_INSERTS` is empty): 045's `series_blob_insert_contributor`
    admitted any blob, its hash unchecked, until 074_series_blob_digest
    moved blob writes into `app_store_series_blob`, which computes the key
    itself. `model_run_insert_contributor` (045) still lets an applicant
    insert their own application's run rows (the database can't tell that
    insert from the backend's: same role, same user), but such a row can't
    be judged: every run the backend stores carries a server stamp
    ([§ Run stamps](#run-stamps)), and a sign-off and an
    application's decision refuse a run without a matching one, so a
    summary the engine never produced is never signed or decided on.
  - **No existence oracles** (049_applicant_oracles,
    `scenarios/oracles.db.test.ts`: each probe answered identically for the
    hidden and the free case, each with a positive control).
    *Sharing*: an applicant can't name an address; they pick from
    `…/share-candidates`, the other members of their own applying party as
    the project owner set it, and every other id (a member or not) gets one
    `404`, every address one `403`; the insert trigger enforces the same rule
    (`app_share_allowed`), and moving someone out of a party ends the shares
    it allowed. *Names*: renaming their own farm to a hidden neighbour's
    name, or naming a crop like a hidden one, applies exactly as a free name
    does; the hidden one is renamed with a suffix in that application's runs,
    and only the assessors are told (`check.renamed`). An application's name
    is unique among its owner's applications only, so naming a draft after
    someone else's says nothing either. *Ids*: an op that targets the id of
    a hidden crop, transfer, land-cover patch or borehole answers `… not
    found`, and one that reuses it applies, exactly as for a free id (the
    hidden items are under opaque ids no op holds while the ops apply); the
    new item moves to a fresh id in that application's runs, and only the
    assessors are told (`check.reIds`). *Counts and rules*: removing a hidden
    farm reports nothing it carried, and a rule the op breaks only because
    of hidden data (a hidden item, a hidden farm's borehole rule, flow
    shares over 100 %, no catchment area left) says only that the op
    doesn't apply to the catchment as modelled. Whether it applies can't be
    hidden (a model that breaks a save rule can't run); the words are the
    client's call (issue #90).
  - **D1**: a team member who is also a contributor is an editor (the
    effective role is the max), so a consultancy mustn't host the baseline in
    its own team while its staff act for applicants.
- **Data feeds run as the owner who configured them** (018_feeds,
  [architecture.md § Data feeds](./architecture.md#data-feeds)). Owners
  attach and change feeds (RLS); saving stamps the saver as the feed's acting
  user, and every fetch is a job queued as that user, so the merge into the
  series is an ordinary RLS write that fails closed once they lose the editor
  role. The scheduler's claim, the health update and the production
  ingest-results routing are `SECURITY DEFINER` functions for `water_app`
  only; the health update re-checks that the caller is an editor of the
  feed's project, and a direct write can never set the health columns (the
  `data_feed_stamp` trigger), so an owner can't make a dead feed look fresh.
- <a id="run-stamps"></a>**Run stamps** (077_run_stamp,
  `backend/src/runs/stamp.ts`). RLS decides who may write a run's rows, not
  whether the engine produced them: an applicant may insert their own
  application's runs (045) and an editor any run of the project (001, and
  `UPDATE` on `run_series`), so someone with SQL as `water_app` could store
  results the engine never computed. So the backend signs every run it
  stores (`storeRun`, the one save path: `POST …/runs`, a scenario or
  application run, an import's run, the re-run job): `model_run.stamp` is an
  HMAC-SHA256 under a key derived by HKDF (its own label) from
  `AUTH_JWT_SECRET`, which the database never holds, over
  `app_run_digest(run)`, a SHA-256 of the run's evidence in a canonical,
  session-independent encoding (id, project, engine version, dates, trigger,
  the inputs snapshot, the summary, the stored input series' kinds, starts
  and blob hashes, every output series' node, key, meta and values). The
  stamp binds the run's id, so one copied onto another row doesn't verify.
  `app_set_run_stamp` is the only writer (the run's maker, in the storing
  transaction, once; `water_app` has no `UPDATE` on the column), and
  `app_run_digest` answers only for a run the caller reads or has just
  stored. Where a run is judged, it must verify: a sign-off refuses one that
  doesn't (`409`, code `run_unverified`), and so does an application's
  decision while any of its runs doesn't. `GET …/runs/:runId` says
  `verified`, and the assessors see an application's unverified runs
  (`unverifiedRunIds`, a warning in its panel). Editor-made runs are stamped
  too (the same path, and an editor can write run rows directly just as
  well), so every sign-off needs one. Runs stored before 077 have no stamp
  and read as unverified: re-run them to sign one (there was no production
  deployment then). Verifying re-hashes the run's rows (a fraction of a second for a
  400-series, multi-decade run), which is why the run list doesn't carry it.
  *Rotation:* a new `AUTH_JWT_SECRET` leaves every stored run unverified
  (existing sign-offs and decisions stand; new ones need a fresh run), which
  after a leak is what you want, since the old key could have signed
  anything. The worker Lambda holds the secret too (its re-run job stores
  runs); it never signs or reads a session.
- The schema owner (`water`) is used only for migrations, never by the running
  API or the job worker.
- The DB test suite (`pnpm test:backend:db`) checks these rules as `water_app`,
  and its catalogue test (`backend/src/db/catalogue.db.test.ts`) checks that
  every table has RLS and policies, `water_app` owns nothing and can't bypass
  RLS, every function pins `search_path` and every foreign key is indexed.
  Treat a failing RLS test like a failing auth check: never skip it.
- **Every route needs a session unless it is on the public allowlist**
  (`/health`, register, login, logout, forgot/reset password, verify email,
  invite info). `backend/src/routes.test.ts` (a unit test, no DB) walks every
  registered route and fails if a non-public one answers an anonymous request
  with anything but `401`.
- **Errors never echo the database.** `backend/src/http/errors.ts` maps
  Postgres error codes to fixed messages; anything else is a generic `500`,
  logged as one structured `{"event":"unhandled_error","method","route",…}`
  line through `safeError` (no message, no path). The Lambda invocation
  succeeds, so the `Errors` metric never sees these; a log metric filter +
  alarm on that line (`infra/alarms.tf`, `unhandled_error`) pages them.

## Input handling

- Every request body is validated with **zod** before it reaches SQL. Queries
  are parameterised (`pg`), and there is no string-built SQL.
- **No mass assignment.** A body sets only the fields its schema names:
  unknown keys are refused (`.strict()`, most project routes) or dropped
  (zod's default strip), never stored, and server-owned columns (ids,
  `project_id`, `created_by`/`author_id`/`user_id`, `role`, `created_at`,
  `revoked_at`, hashes, statuses) come from the session and the route, not the
  body. `http/mass-assignment.security.db.test.ts` sweeps every POST/PUT/PATCH
  in `app.routes` with the role ladder's sample bodies plus hostile extras
  (top level and nested) and searches every row the request wrote (by `xmin`)
  for them; a new route or table is covered without a list. It found the
  settings patch passing unknown keys through into `project.settings`, every
  revision, copy and run input (including engine-only inputs such as
  `damStorageReset`); they are now dropped.
- Model documents are validated as a whole: references resolve inside the
  document, the network is a tree with one outflow, and names are unique.
- Series are capped at 60 000 values. The backend itself caps every request
  body at 4 MB (Hono `bodyLimit`, `backend/src/app.ts`, `413` past it),
  tighter than and ahead of Lambda's 6 MB payload limit in production. The
  one exception is `POST /projects/import` (a whole project document), capped
  at 5 MB on the route, after the session check, so an anonymous caller never
  gets a large body read.
- **Hostile JSON bodies** are refused once, for every route, by `readJson`
  (`backend/src/http/body.ts`) with `400` and the code `body_refused`: a NUL
  (`\u0000`) in any string or key (Postgres refuses NUL in text and jsonb,
  which was a `500` on `PATCH /projects/:id`, `POST /projects`, `/copy` and
  `/teams`), a number that overflows to ±Infinity (`1e400`), and nesting past
  64 levels (a deep `settings` value overflowed the stack). The walk is
  iterative. A route whose fields are all optional (start a run, a scenario
  run, restore a revision) calls `readJson(c, { optional: true })`, which
  takes an empty body as `{}` but still checks one that is there: these had
  read the body with `c.req.json().catch(() => ({}))`, so a NUL in a run
  `label` reached Postgres as a `500`. `http/body.guard.test.ts` fails on any
  source file under `backend/src` that reads a body itself (`req.json()`,
  `req.text()`, `parseBody()`, `req.raw…`) outside `http/body.ts`.
  `http/body.security.db.test.ts` sweeps every POST/PUT/PATCH in the live
  route inventory with each, and then puts a NUL into every string and
  `1e400` into every number of each route's own sample body
  (`__tests__/routeSamples.ts` `SAMPLE`).
- **Series values** must stay finite and below 10¹² in the canonical unit
  *after* conversion (1e308 in inches was Infinity in mm), and a project holds
  at most **1 000 series** (`series/limits.ts`): a new series past it is `409`
  on PUT and merge, and a project file with more is `400`, where one 5 MB file
  had created 50 000 in a 12-second transaction. The cap is hard
  (`075_series_cap.sql`): `app_project_series_count` (SECURITY DEFINER,
  answering only an editor or a live `series:write` key of the project)
  counts every series, not just the ones an API key limited to some series
  can see, under a per-project advisory lock, so a concurrent burst at the
  limit gets exactly the room left. `series/limits.security.db.test.ts`.
- **Allocation files** (`allocations/parse.ts`): 2 MB, 5 000 rows and
  **200 columns** a row, the last checked while splitting so a million-column
  header is refused before it is built (`allocations/parse.security.test.ts`).
- The server never parses a workbook. A b023 `.xlsm` / `.xlsx` is parsed
  either offline by the Python importer or **in the browser**, and only the
  resulting project document reaches the API (`POST /projects/import`, the
  same zod validation and 5 MB cap as a `.json` upload).
- **Untrusted workbook parsing (in-browser import, WP-1.31).** The file is
  hostile until proven otherwise (`frontend/src/lib/spreadsheet/import/`):
  - it is refused over 150 MB or 250 sheets before anything is unpacked;
  - `zip.ts` reads the zip itself and bounds-checks every offset and length
    against the file. Each part is capped at 128 MB unpacked and all the
    parts read at 256 MB together, checked against the declared size before
    anything is allocated, and inflation (the platform's
    `DecompressionStream`) stops the moment a part produces more than it
    declared, so a zip bomb is a clear "too large" error, not a crashed tab.
    Encrypted entries, ZIP64, split archives and compression methods other
    than stored and deflate are refused, and every part's CRC-32 is checked;
  - the picked file is read from disk a slice at a time (`Blob.slice`), never
    loaded whole, and every slice's offsets are checked against the file's
    size first;
  - only the parts the import reads are ever unpacked (content types,
    relationships, the workbook, shared strings, styles, the b023 config
    sheets). The VBA project, the per-farm result sheets, drawings and
    embedded objects are never inflated;
  - those parts are parsed by the import's own streaming reader, not a
    general XML or spreadsheet library (`xml.ts`, `sheet.ts`,
    `sharedStrings.ts`, `workbookParts.ts`): each part is tokenized as it
    inflates, so no sheet is ever held whole. There is no DTD support at
    all: a `<!DOCTYPE>` or any other declaration is refused, so no entity
    can be defined, and entity references are never expanded beyond the five
    XML built-ins and numeric references (the rest stay literal text).
    Every tag, comment and CDATA section is capped at 1 MB, nesting at 128
    levels, and a cell value or shared string at 1 M characters (Excel's own
    limit is 32 767). Unclosed or mismatched tags, text outside the root,
    UTF-16 parts, markup inside a value and a cell pointing at a shared
    string that isn't there are all typed `UnreadableWorkbookError`s
    (`corrupt`), with a test for each (`xml.test.ts`, `workbook.test.ts`).
    Cells are kept as typed-array slots, so the memory a sheet can take is
    bounded by its unpacked size, which the zip caps already bound;
  - nothing is evaluated: the reader keeps cached cell values only (formula
    text is never read, the VBA project never unpacked), and the one place
    formula text matters (hand-written [Transfers] rules) reads the
    plain-text copy b023 keeps, matched against a fixed rule shape, never
    executed;
  - error messages, notes and the unmapped report quote sheet and farm names
    and formula text from the file, so the import dialog renders all of it as
    text (plain Svelte interpolation, never `{@html}`); an e2e test imports a
    workbook whose farm is named `<img src=x onerror=…>` and checks it shows
    literally and runs nothing;
  - it all runs in a module worker from `'self'` (`worker-src 'self'`), and
    only the extracted project reaches the server, through the same
    validation as any `.json` import.
- No shipped code uses SheetJS any more: the `.xlsx` export writes its own
  OOXML (since 2026-09-26) and the in-browser importer reads with its own
  reader. The tests still use SheetJS CE 0.20.3 (a dev dependency), to
  compare the two readers cell by cell and the export with what SheetJS
  wrote byte for byte, pinned in `frontend/package.json` to its official CDN tarball with the
  integrity hash in `pnpm-lock.yaml`. Do not use the stale npm `xlsx` 0.18.5,
  which has known advisories. Dependabot and `pnpm audit` don't track a URL
  dependency, so check the SheetJS release notes and bump it by hand.
- **Outbound fetches and their answers are untrusted (data feeds, WP-2.10).**
  A new trust boundary: the app now downloads from third parties
  (data.chc.ucsb.edu for CHIRPS / CHIRPS-GEFS, www.dws.gov.za for DWS).
  No personal data goes to either: a request carries a public file path or a
  station code and dates, never a user, project or catchment name, so neither
  host is a sub-processor. (Cell coordinates aren't sent as such: a grid is
  read by byte range, which shows only which grid rows, i.e. latitude bands,
  a feed reads.)
  - Only fixed hosts are fetched: the URL is built from the source and a
    validated config (cells as numbers in range, a station matching
    `^[A-Z]\d[A-Z]\d{3}$`), never from user text, so a feed can't be pointed
    at an arbitrary URL (no SSRF). The live client enforces it too: it asks
    only those two hosts over HTTPS (`FEED_HOSTS`, `feeds/http.ts`) and
    follows redirects itself, at most 3, each re-checked, so a redirect
    can't send the fetcher (open egress) to another host or plain HTTP.
    `FEED_SOURCE=fixtures` is the default
    everywhere but the production fetcher, so dev and CI never fetch.
  - Every response is bounded: 20 s timeout (all hops and the body), 4 MB cap whether declared or
    streamed, range reads for the grids (`feeds/http.test.ts`). A GeoTIFF is parsed by our own
    bounds-checked reader (dimensions up to 100 000 pixels, strips up to 8 MB
    read and 2 MB decoded, GDAL metadata up to 1 MB, GeoKeys up to 4096, and
    LZW codes checked, each before the read or allocation it bounds;
    anything outside the known layout refused; `feeds/sources/tiff.test.ts`), and a DWS page by a strict
    parser that refuses a changed header, impossible or duplicate dates and
    the site's HTTP-200 error page. Values must be finite and non-negative
    (a DWS gap is null, never a zero); rainfall over 2 000 mm/day is refused.
  - Errors stored on the feed and shown in the panel are ours
    (`feeds/errors.ts`), never an upstream body.
  - In production the fetch happens in the **fetcher Lambda, outside the VPC
    and with no database access**: its role may only receive fetch requests and
    send results, and it refuses a request for a longer window than one fetch
    reads (120 CHIRPS days, 20 DWS years). The worker validates each result
    again (`FetchResult`: size, dates, values, a flat `meta` within `last_meta`'s
    byte budget, no U+0000, so nothing it accepts can fail the database after
    the merge), checks it answers a real `feed_fetch` job of
    that feed, and drops one for a feed changed since, before anything merges
    as the feed's acting user. It applies only the answer to the feed's newest
    fetch, once, and refuses one with a day outside the window that fetch
    recorded on the feed (`029_feed_fetch`; the window comes from the worker,
    never the answer). A compromised fetcher could at worst send wrong
    numbers for the days feeds asked it for, into the series those feeds
    already target.
- Svelte escapes output by default, and nothing in the frontend renders a
  string as markup: no `{@html …}` block, no `innerHTML` / `outerHTML` /
  `insertAdjacentHTML` / `document.write` / `createContextualFragment`, no
  `bind:innerHTML` / `bind:outerHTML` on a contenteditable element.
  `frontend/src/lib/rawHtml.test.ts` fails on any of them anywhere under
  `src/` (WP-2.16: notes, the WUA's notice, the share page and every name a
  person types are text). Help text has its own parser (`lib/help`), not
  HTML. A real need for markup would need a sanitiser and a reasoned entry in
  that guard. The same guard checks the chart library: the uPlot build the
  app bundles writes series labels (typed names) and its legend read-out
  through `textContent`, never markup. Also banned there: `setHTMLUnsafe`,
  `parseHTMLUnsafe`, `DOMParser.parseFromString`. Mail templates escape
  every interpolated value (`mail/templates.ts` `escapeHtml`,
  `templates.test.ts`).
- **No script URLs.** Svelte escapes attribute text, not what it means:
  `href={x}` runs script when x is `javascript:…`.
  `frontend/src/lib/urlAttributes.security.test.ts` scans every component's
  URL attributes (`href`, `src`, `srcset`, `action`, `formaction`, …, and
  `{href}` shorthand). A value that starts with literal text (`/…`, `?tab=…`,
  `#…`, `{base}/…`) sets its own scheme, and that scheme must be http(s),
  mailto or tel, never protocol-relative. A value that starts with an
  expression must be a *reviewed* head, listed with where its value comes
  from and the components it was reviewed in (the same name in another
  component is a new one). A new one fails until someone reviews it, and a
  listed head a listed component no longer uses also fails. The app's URL builders (`runHref`,
  `withParam`, `farmHref`, …) are called with hostile ids and must stay on
  the app's origin. The same test bans `srcdoc`, frame, object and embed
  elements, and URL writes from TypeScript (`location =`, `window.open`,
  `.href =`, except the blob download link in `lib/export/download.ts`),
  read from the whole file, since an inline handler in markup is code too. It
  also requires `rel="noopener"` on every `target="_blank"` link. The
  report PDF's download link is built in the client from `PUBLIC_API_URL`
  and the ids (`api.reports.pdfUrl`), never taken from a response
  (`serverPdf.ts` `reportsApi.get`), so no URL the API returns reaches an
  `href`. `?next=`
  after sign-in (`lib/auth/redirect.ts` `safeNext`) follows only a path
  that resolves to the app's own origin, so `/\t/host` (a browser strips the
  tab) is refused as well as `//host`.
- **CSV exports defuse spreadsheet formulas.** Farm, run and series names are
  user-controlled and the files are opened in Excel by other project members,
  so any text cell starting with `= + - @`, tab or CR gets a leading `'`
  (`backend/src/export/csv.ts`, OWASP "CSV injection"), and a cell holding a
  comma, quote or line break is RFC 4180-quoted. Numbers are written as
  numbers. Export file names are ASCII slugs, so `Content-Disposition` can't be
  injected. `export/export.security.db.test.ts` sweeps every `GET … .csv`
  route in the live route table over a project seeded with formula-looking
  names, run label, notes, notes author, series name and allocation fields: no
  text cell may start with a trigger, the quoting must parse strictly, and an
  ordinary name must round-trip unchanged.
- **The `.xlsx` workbook treats names the same way.** It is built in the
  browser from the same API data (`frontend/src/lib/spreadsheet/export/`):
  the summary sheets are the summary CSV's cells, already defused; names the
  workbook writes itself (the EWR grid's sites, the Inputs sheet's nodes,
  crops and references) go through `defuse` in `names.ts`, the same rule as
  `textCell`. Every name is a **string cell** and the workbook never writes a
  formula, so Excel shows `=cmd|…` as text; the apostrophe keeps it inert if
  someone edits the cell or copies it into a CSV. The daily sheets' column
  headers are defused too. Cell text is XML-escaped with control characters
  as `_xHHHH_`, and an underscore that would start such an escape in the
  text itself is written `_x005F_` (`writer.ts` `escapeCellText`): Excel
  decodes `_xHHHH_`, so a name typed as `_x003D_cmd` would otherwise open as
  `=cmd`, past the defuse. Unit and e2e tests check both (no cell in the file
  has a formula; `writer.security.test.ts` reads every cell as Excel does). Sheet names are cleaned to
  Excel's rules (none of `[ ] : * ? / \`, at most 31 characters, unique), and
  the file name is the summary CSV's server-made ASCII slug. The worker loads
  from `'self'` only (`worker-src 'self'`), and it only writes (`writer.ts`); it
  never parses anything uploaded.

### Import reports

The import dialog sends the review's notes and unmapped report with the
project (`importReport` on `POST /projects/import`,
[api.md § Import report](./api.md#import-report)), and the database keeps them
for every member to read later. Every string in them came from the workbook
(farm and sheet names, a hand-written formula verbatim) through the client, so
the whole report is **untrusted text stored server-side**:

- **Capped by zod before anything is written** (`backend/src/projects/importReport.ts`):
  at most 500 notes and 500 unmapped items, each string bounded (a message
  2000 characters, formula text 8192, a name 200, a sheet 100, a cell 20),
  codes restricted to `[a-z0-9-]`, no NUL, unknown keys dropped, and the two
  lists at most 512 KB of JSON together. A hostile client can store about
  half a megabyte per project it imports, never megabytes; the rest of the
  body stays under the route's 5 MB cap. Over a cap the whole import is a
  `400` and nothing is created. The table's CHECKs (array lengths, 1 MiB of
  jsonb text) back the API up.
- **Rendered as text only**: the Overview's Import record and the review share
  `ImportReportLists.svelte`, plain Svelte interpolation, never `{@html}`. The
  e2e suite imports a workbook whose farm name is an `<img onerror>` payload
  and checks it shows literally.
- **Never evaluated**: formula text is displayed in a `<code>` element, never
  run or parsed.
- Not in `export.json`, so an export can't carry one project's report into
  another's import.

### Calibration rules sign-off

Automated calibration's rules (`settings.calibrationRules`, issue #153,
[model.md §2.10j](./model.md)) are an evidence-integrity control:

- **The server computes and writes every automated fit.** It fits the saved
  rules in its own jobs (`backend/src/calibration/`), stores every score, and
  builds the fit record itself when a fit is applied. A settings save can only
  carry a stored automated record back unchanged (`autoFitRecordError`, a
  `409`), so a client can't claim a fit, a score or a set of rules it didn't
  run. Applying refuses a run whose rules or inputs have changed since
  (a `409`). The seed and search are rules too, so re-running with other
  seeds is a rule change with its own revision, never a way to shop for a
  score. A project file import checks a file's automated record against the
  file's own rules (`importedAutoFitError`); the file itself is the importer's.
- **The sign-off is bound to the account that gave it.** The hydrologist
  types their name as a signature (as on a run's sign-off); the server dates
  it and records the signed-in account as the actor of a
  `calibration_rules.signed_off` audit event (a withdrawal:
  `calibration_rules.sign_off_withdrawn`). No account id is copied into the
  settings. Changing a rule clears the sign-off server-side, and run
  comparison lists every sign-off change.
- **Still open:** any editor may sign off; whether only a named role (the
  hydrologist's) should is the client's call (#90, "Automated calibration
  rules").
- **Account deletion.** The typed signature stays with the rules it signed
  (the settings, their history, run snapshots and the calibration rows), as a
  run's typed signature does; the account is cleared from the audit event
  (`auth/personal-data.security.db.test.ts` RETAINED_AFTER_DELETION).

### Allocations: POPIA minimisation (038_allocations.sql)

A WARMS extract can carry the registered user's identity number, phone
number and address. The app has no use for them, so they never reach the
database:

- The importer (`backend/src/allocations/parse.ts`) **refuses the whole
  file** when a heading looks like an ID number, identity, passport, phone,
  cell, telephone, fax or email column, before anything is stored, and says
  which columns to delete. A 13-digit number in the holder, reference,
  property or farm column is a row problem, so a mislabelled ID column can't
  slip in as a name.
- The registered user's **name** is the only personal field kept, in
  `allocation_holder`, readable by editors and owners and by the linked farmer
  for their own farm; **viewers never read it** (RLS, decision D3 (b) pending
  legal advice). The history records registration numbers, file names and
  counts, never names. The export's `holder` column is only in an editor's
  file.
- Cells are stored as they came; the CSV export neutralises formula-looking
  cells (`'` prefix), as every export does. A licence condition in words
  (103) is checked like the holder: a 13-digit number there is a row problem.
- **Run inputs** (engine ≥ 1.18.0, issue #72): every run's stored input
  carries the project's allocations so the run replays, but only what the
  engine reads (id, unit, source, volume, storage, validity, months, maximum
  rate), never the holder's name, the registration number or the property
  (`runs/execute.ts allocationsForRun`; `conditions.db.test.ts` fails if one
  appears). A viewer reads a run's input and could read the volumes anyway;
  an applicant's projection of a published base keeps only the allocations on
  their own units (`scenarios/applicant.ts`), and a contributor never reads a
  run's summary, whose comparison names every unit.
- In the data-subject export ([§ Personal information](#personal-information-popia)),
  a farmer gets the allocations matched to *their* linked farms, holder name
  included (what RLS already lets them read). A holder is never matched to
  an account by name: names aren't unique, so matching would hand one
  person another's registration. A registered user without a linked farm
  has no account to export to; their name is the WUA's record, answered by
  the WUA.

## Personal information (POPIA)

What the app keeps about people, why, for how long, and what happens on a
data-subject request, as built at the end of Step 2 (roadmap WP-2.16). This
is a record of the system, not legal advice: the lawful bases below are how
the roadmap reads them, and every one marked *(confirm)* is an open item for
the client's information officer ([followups.md § POPIA and the Step 2
release](./followups.md#popia-and-the-step-2-release-wp-216)). Loop in the
CISO or security analyst before go-live.

**Roles.** The client (the WUA, or the consultancy for a hydrologist-only
project) is the **responsible party**: it decides whom to invite and why.
The operator (whoever runs this deployment) is its **operator** under POPIA
s20–21 and needs a written agreement with it: the template is
[legal/operator-agreement.md](./legal/operator-agreement.md) (for counsel
review), and a breach follows [legal/incident-procedure.md](./legal/incident-procedure.md). Farmers are invited
by the WUA; nobody is added to a project without an owner acting.

**Lawful basis and consent, today.**
- Accounts, memberships and farm links: to provide the service the member
  signed up for, and for farmers the WUA's function of managing its members'
  water use (legitimate interest or a legal duty under its constitution)
  *(confirm)*. The **privacy notice** is at `/privacy` and the terms at
  `/terms` (research-based, not counsel-reviewed, [legal-status.md](./legal-status.md));
  the sign-up form, invitations included, shows the Terms' main points and
  a required checkbox accepting both, and sends the version it showed: the
  account records it and when
  (`app_user.terms_version` / `terms_accepted_at`, 087; a missing or stale
  version is refused, `terms_not_accepted`). The time is the database's,
  and an account can't backdate or clear its own record
  (`app_user_terms_stamp`). After a change, an account on an older version
  sees a notice before any app page until it accepts
  (`POST /auth/me/accept-terms`, which refuses a stale version the same
  way).
- Notes, the audit log, publications and sign-offs: the project's record,
  kept for the regulator's audit trail (roadmap §7).
- Alerts (WP-2.13): service messages the WUA switches on per catchment,
  each person choosing right away, daily or off, with a one-click
  unsubscribe in every mail ([§ Alerts](#alerts)) *(confirm the basis)*.
- Cookies: the session cookie (`wm_session`) and the sign-in lockout's
  trusted-device cookie (`wm_device`, [§ Authentication](#authentication)),
  both strictly necessary. No
  analytics, no third-party scripts or fonts (the CSP allows none), so no
  cookie banner.
- Sub-processors: AWS only (hosting, RDS, S3, SES mail, CloudWatch logs),
  in the region chosen at deploy (`af-south-1` recommended; any other region
  is a cross-border transfer under s72 *(confirm)*). The data-feed hosts
  (CHIRPS, DWS) receive no personal data ([§ Input handling](#input-handling)).

**What is kept, and what deletion does.** Every foreign key to `app_user` is
classified (cascade, set null, or restrict) in `catalogue.db.test.ts`
`APP_USER_ON_DELETE`, and every foreign key to `project` cascades (the same
file), so a new column can't ship without a decision.
`auth/account-deletion.db.test.ts` checks the outcome end to end, and
`auth/personal-data.security.db.test.ts` sweeps it: an account with a row
behind every cascade and set-null key is deleted, then every text, json,
uuid and array column of every table is scanned for its email, name and
id, which may survive only where this table keeps them (the audit log's
random id, the typed sign-off name, the sign-in lockout's address). It
found three guards that fought the deletion, fixed in 066: a sweep's or
outlook's guard refused the key's SET NULL (so the account couldn't be
deleted), `alert_rule_check` put the creator back (a dangling id), and a
PDF someone else asked for kept the person as a recipient
(`report.email_to`, now emptied of them by `app_user_pseudonymise`).

| Data | Tables | Retention | Account deleted | Project deleted |
| --- | --- | --- | --- | --- |
| Account: email, display name, password hash, session watermark, when they last downloaded their data (052), whether SES suppressed the address (057), which terms and privacy notice they accepted and when (087) | `app_user`, `email_token` | Until the account is deleted; tokens a week past expiry | Deleted | – |
| Sign-in attempts, keyed by the typed address (and a trusted device's id, 070) | `login_throttle`, `login_device_throttle` | A day without attempts | Not linked to the account | – |
| Reset and verification emails sent, for the daily cap (and a trusted device's id, 078) | `account_mail_quota` | 24 hours | Deleted | – |
| Ids of sessions the person signed out (102) | `revoked_session` | Until the token would have expired, 7 days at most | Deleted | – |
| Adds by email, counted for the daily cap: the adder's id and the project's or team's (101) | `invite_throttle` | 24 hours from the window's first add | Lapses with its window | Lapses with its window |
| Display preferences: the workspace sections a person hid from their sidebar (083); own row only under RLS | `user_preferences` | Until the account is deleted | Deleted | – |
| Memberships and roles | `project_member`, `team_member` | Until removed or left | Deleted | Deleted |
| Farmer ↔ farm link (a person tied to a farm's water use) | `farm_link` (`added_by`) | Until unlinked, removed or left | Deleted (with the membership) | Deleted |
| Pending invites: an address, its language, a farmer invite's farms | `invite`, `invite_node` | 7 days live, then 90 days as expired, then purged by the job tick (048) | Deleted if they sent it; an invite *to* their address lapses and is purged | Deleted |
| A farm's figures, personal once linked to a named farmer | `publication_farm`, `run_series` (farm keys), `model_run` | The newest 12 publications and 20 manual runs; published runs kept while published | Stay (the farm's, not the person's; the link goes) | Deleted |
| Notes: body, author | `note` | For the life of the project; a deleted note's body stays for editors *(confirm)* | Author cleared; body stays | Deleted |
| Audit log: actor name, names and masked addresses in subjects | `audit_event` | For the life of the project (the regulator's audit trail) | Pseudonymised: "Deleted user" as actor and subject (D12, 048) | Deleted |
| Model and series revisions: who saved | `model_revision`, `series_revision` | Model revisions for the life of the project; series revisions 180 days / 5 versions | Who cleared | Deleted |
| API keys, share links, publications: who made, revoked, published | `api_key`, `share_link`, `run_publication` | Kept after revocation (the audit record) | Who cleared; a key keeps working, its automatic re-runs are skipped | Deleted |
| Jobs, reports, render tokens: who asked | `job`, `report`, `report_schedule_recipient`, `render_token` | Jobs 30 days after finishing; report rows 8 days, PDFs 7; tokens single use, 5 minutes | Deleted | Deleted |
| Alerts: a person's choices and the mails sent to them; the rules and events | `alert_subscription`, `alert_delivery`; `alert_rule`, `alert_event` | Choices while a member; deliveries 180 days; events 180 days after clearing | Choices and deliveries deleted; a rule's creator cleared | Deleted |
| Feeds and report schedules: acting user | `data_feed`, `report_schedule` | While configured | Cleared; the feed or schedule is skipped until someone saves it again | Deleted |
| Registered water users' names (WARMS) | `allocation_holder` | For the life of the project ([§ Allocations](#allocations-popia-minimisation-038_allocationssql)) | Not linked to an account | Deleted |
| An application's decision: the assessor who made it | `scenario.decided_by` | Kept (the decision on the application) | Who cleared; the outcome and note stay (052) | Deleted |
| Sign-offs: typed name and registration | `signoff` | Kept (the signature on a run or an evidence pack) | Account cleared; name stays ([§ Liability](#liability)) | Refused while a nomination or an issued pack holds the project |
| Evidence packs: who drafted and issued them; the signers' names and registrations, printed and returned by the public verify lookup | `evidence_pack` (`created_by`, `issued_by`), `signoff` | Kept for good once issued (the licence record) | Who drafted and issued cleared (SET NULL, allowed past the pack's guard only when the account is gone); a signer's typed name stays, as on any sign-off | Refused while a pack is past draft (`project_pack_guard`, 112) |
| Evidence that names its maker: a project or team created, a run, a nomination, an ensemble, a scenario, an import | `project`, `team`, `model_run`, `run_nomination`, `run_uncertainty`, `scenario`, `project_import` | Kept | **Blocks the deletion** (restrict): the operator decides first *(confirm)* | Deleted, unless nominated (`project_evidence_guard`) |
| Logs: request logs, database logs | CloudWatch | 30 days (`lambda_log_retention_days`, `db_log_retention_days`) | Not searchable by person | – |
| Backups | RDS automated backups | 7–35 days (`db_backup_retention_days`) | A deleted account stays in backups until they age out *(confirm)* | Same |
| Teardown snapshot | The final RDS snapshot `terraform destroy` takes (`water-management-final-<suffix>`, infra/README.md § Tearing down) | Only when the whole service is shut down; a manual snapshot, kept until the operator deletes it (the privacy notice says so and promises the period with the shutdown notice) | Stays in it | Stays in it |

**Data-subject requests.**
- **Access / export: self-service.** Account → Your data → **Download my
  data** (`GET /auth/me/export`, [api.md § Auth](./api.md)) saves one JSON
  file: the account (never the password hash), memberships, farm links with
  those farms' current published figures (as the farm page shows them) and
  the registered volumes and holder names matched to them, notes written,
  sign-offs, invites to their verified address, alert and report choices,
  alert mails sent, their display preferences (the sections they hid), and every audit event they made or that names them.
  The rows RLS hides from the person (the audit log for a farmer, invites,
  anything in a project they've left) come through `app_subject_export()`
  (052), a `SECURITY DEFINER` reader with no user argument that reads only
  the caller's own rows. Nothing about another farm or person beyond what
  those records name (the actor who linked them, the people named in events
  they made). One export a minute per account. Every foreign key to
  `app_user` is classified as exported or left out, with why, in
  `auth/export.ts` `USER_FK_COVERAGE` (guarded by `export.db.test.ts`; `personal-data.security.db.test.ts` checks each exported key's section holds exactly the person's rows, and every exported `app_user` column its stored value): the
  project's own records that name the person only as their maker (runs,
  revisions, keys, publications…) are left out, because the act is in the
  audit events. The project exports (`export.json`, CSV, the farm CSV)
  remain project data, not a data-subject export
  ([deployment.md § Runbooks](./deployment.md#runbooks), item 8).
- **Deletion: an operator act.** There is no self-service deletion. On a
  request the operator deletes the `app_user` row as the schema owner
  ([deployment.md § Runbooks](./deployment.md#runbooks), item 7): the table
  above is what happens. An account that made evidence (the last row but
  two) can't be deleted until the operator and the client decide what
  happens to it.
- **Correction:** a person edits their own name (Account); an owner fixes
  anything else in the project.

## Public repo hygiene

**This repository is public.** Anything committed, including history, is
readable by anyone. The rules:

- **No secrets, not even encrypted ones.** Production values (DB credentials,
  `AUTH_JWT_SECRET`, anything that grants access) live only in the private
  `Absence0760/infra-secrets` repo under `water-management/`, SOPS-encrypted
  under `alias/water-management-sops`. Bootstrap:
  `infra-secrets/bin/sops-init.sh --project water-management --region <region>`.
  Terraform gets them as ephemeral variables through `infra/scripts/tf.sh`
  (`sops exec-env`), never from a tfvars file.
- **No client data.** Workbooks (kept outside the repo in `../project-water-management-source/`; `*.xlsm`, `*.xlsx` are gitignored) and
  everything extracted from them (`data/`) are gitignored. Committed test
  fixtures are **synthetic**: made-up farm names, made-up numbers. Never paste
  real farm names, owners, dam sizes or series into fixtures, test names, code
  comments, commit messages or docs examples. The one tracked workbook,
  `scripts/wbt-import/fixtures/synthetic_b023.xlsx` (a narrow `.gitignore`
  exception), is synthetic too: `make_synthetic_workbook.py` builds it from an
  invented catchment (NATO-alphabet farm names, seeded random series), and only
  its layout follows b023. Regenerate it; never edit it by hand or paste client
  values into it ([scripts/wbt-import/README.md](../scripts/wbt-import/README.md#the-synthetic-workbook)).
- **Client terms guard.** The client's catchment, farm and workbook names
  (and the gauge and quaternary codes that pinpoint it) are listed in
  `../infra-secrets/water-management/client-terms.txt`, outside this repo,
  because the list itself names the client. In the repo the client's model is
  "the client catchment", its farms "Farm A", "Farm B" and so on, and the extracted fixtures
  live in `data/client-catchment/`. `scripts/guards/check_client_terms.mjs`
  checks against the list: pre-commit (staged changes) and commit-msg hooks
  via `pre-commit install`, `pnpm check:terms` for every tracked file and
  path, and `--history` for every ref. It is a no-op without the list (CI,
  outside contributors) and never prints a term, only the file, line and
  term number. Add a term to the list the moment a new client name turns up.
  The history was rewritten once (2026-09, `git filter-repo --replace-text`)
  to take the names out of every past commit, and the GitHub repo recreated
  from it, because GitHub keeps a PR's commits under `refs/pull/*` forever.
  If a name slips in again, rewrite *before* anyone opens a PR on it.
- **Local defaults only.** The committed `.env.development` files hold throwaway
  docker credentials and a dev-only JWT secret. That is safe because they grant
  nothing outside a local container. `pnpm check:env` (CI job
  `env-isolation`) enforces it: only `*.env.development`, `*.env.example` and
  `frontend/.env.production` may be tracked, no sops file may be, every host a
  dev default names must be local, and the dev-only placeholders must stay
  placeholders.
- **gitleaks** runs as a pre-commit hook (`pre-commit install`, never
  `--no-verify`), in CI on every push and PR (part of the `CI gate`), and
  weekly over the whole history (`gitleaks-sweep.yml`, which opens a
  `secret-scan` issue when it fails). Reviewed false positives are pinned by
  exact fingerprint in `.gitleaksignore` (m³/day field names,
  fake test tokens), or, for a placeholder repeated across files (the
  mocked-provider Terraform tests' synthetic secrets), allowlisted by its
  exact value in `.gitleaks.toml`, never by path; add one only after checking
  the match isn't real. Before pushing a branch, check the diff
  for client names as well as for keys.
- If something slips in: **don't push**. Rewrite the history locally, then tell
  the operator (see the incident playbook below).

## Secrets management

- **Production secrets live outside this repo**, in
  `infra-secrets/water-management/prod.sops.yaml`, SOPS-encrypted under
  `alias/water-management-sops`. Decryption is gated by IAM (`kms:Decrypt`) and
  logged in CloudTrail. The key rotates yearly. `infra/scripts/tf.sh` runs
  Terraform under `sops exec-env`, which decrypts in memory, so nothing is
  written to disk, and hands the values over as ephemeral variables, so
  nothing is written to Terraform state either ([§ Runtime
  secrets](#runtime-secrets)). See `../infra-secrets/README.md`.
- This app's production secrets: `AUTH_JWT_SECRET`, the `water_app` DB
  password and the alert unsubscribe-token secret, all in sops. The owner
  (`water`) password is managed and rotated by RDS in Secrets Manager
  (`manage_master_user_password`), read only by the migrate Lambda at run
  time. The CloudFront shared secret is generated by Terraform
  (`random_password`).

### Runtime secrets

No secret sits in a Lambda's environment variables (issue #126). Those are
returned in plain text by `lambda:GetFunctionConfiguration`, which the deploy
role holds (to deploy code) and AWS's `ReadOnlyAccess` grants, so a session
key there would let any read-only principal forge any user's session.

- **Where they are.** `infra/secrets.tf` writes one Secrets Manager secret per
  Lambda that needs any (`water-management/runtime/<role>`), a JSON object
  with exactly that Lambda's keys:

  | Lambda | Keys |
  | --- | --- |
  | API | `AUTH_JWT_SECRET`, `DATABASE_URL` (the `water_app` password), `CLOUDFRONT_SHARED_SECRET`, `CLOUDFRONT_PRIVATE_KEY` (signs report downloads, § Reports) |
  | worker | `AUTH_JWT_SECRET` (run stamps), `DATABASE_URL`, `ALERTS_TOKEN_SECRET` |
  | migrate | `WATER_APP_PASSWORD` |
  | fetcher, renderer | none: no database, no session |

  One secret per Lambda rather than one shared, so each role reads only what
  it uses: the worker can't read the CloudFront secret, the API can't read
  the unsubscribe-link key. The environment holds only `RUNTIME_SECRET_ARN`
  and `RUNTIME_SECRET_VERSION`.
- **Who can read them.** Each Lambda role has `secretsmanager:GetSecretValue`
  on its own secret's ARN and nothing else. The VPC Lambdas reach Secrets
  Manager through its interface endpoint, whose policy names each secret with
  its one role, and whose security group admits only the API, worker and
  migrate Lambdas. The deploy role has no Secrets Manager permission.
  Encryption is the AWS-managed `aws/secretsmanager` key.
- **How they are loaded.** `backend/src/config/runtimeSecrets.ts`, called
  first by `lambda.ts`, `lambda-worker.ts` and `lambda-migrate.ts` (a
  top-level `await`, before the production config check): one
  `GetSecretValue` per cold start, never per request, pinned to
  `RUNTIME_SECRET_VERSION`, and the values go into `process.env`, where the
  code has always read them (lazily, inside functions, so they are there by
  the time anything runs). It fails closed: the Lambda refuses to start if the
  secret can't be read, isn't a JSON object, lacks a key, holds a key its role
  shouldn't have, or if a secret key is also set in the environment (a
  regression). Its errors name keys, never values, and it logs nothing. Off
  Lambda it does nothing, so local dev reads `.env.development` as before and
  needs no AWS.
- **Guards.** `config/runtimeSecrets.test.ts` (the loader);
  `config/production.security.test.ts` (Terraform's secret keys match
  `RUNTIME_SECRETS`, every required setting is in the environment or the
  secret, a denylist keeps secret names out of every environment block, and
  each entry point loads its secret before its checks); the `runtime_secrets`
  tftest (the keys, each role's grant scoped to its ARN, the endpoint policy
  and security groups, no Secrets Manager access for the deploy role, every
  version write-only, the values ephemeral).
- **Out of Terraform state.** The sops values reach Terraform only as
  ephemeral variables (`infra/scripts/tf.sh`, `sops exec-env` → `TF_VAR_*`),
  and flow only into `secret_string_wo`, the write-only argument of each
  secret's version. Terraform stores neither an ephemeral value nor a
  write-only one, in state or in a saved plan, so reading the state bucket no
  longer yields the session key, the `water_app` password or the unsubscribe
  key. The `runtime_secrets` tftest checks that no version uses
  `secret_string` and that the values are ephemeral (`ephemeralasnull`, with
  the CloudFront secret as the positive control). The price: Terraform can't
  see a changed sops value by itself; `infra/scripts/tf.sh` sets
  `runtime_secret_version` from the sops file's plaintext `sops.lastmodified`,
  so every sops edit rewrites the secrets
  ([deployment.md § Rotating a secret](./deployment.md#rotating-a-secret)).
- **What remains.** The CloudFront shared secret is still in Terraform state
  (the `random_password` and the distribution), because CloudFront's origin
  `custom_header` isn't a write-only argument, and in the distribution's
  configuration, which `cloudfront:GetDistributionConfig` returns. Either
  lets a caller past the WAF to the Function URL, where the app's own
  authentication still applies; neither lets anyone forge a session. The state
  bucket is private, SSE-encrypted and versioned.
- **Committed local defaults are non-sensitive by design.**
  `backend/.env.development` holds the docker-compose throwaway passwords
  (`water`/`water`, `water_app`/`water_app`) and a dev-only JWT secret. They
  grant access to nothing outside a local container. Never reuse them anywhere
  real. Machine-local real values go in a gitignored `.env.development.local`.

## Infrastructure

- **CI/CD uses GitHub OIDC.** There are no long-lived AWS keys. The deploy
  role's trust policy is pinned to `repo:<owner>/<repo>:environment:production`,
  and that environment has a required reviewer. A workflow can only assume the
  role after a human approves the run. The environment deploys only from
  `main` and the `backend@*`/`web@*` tags, and a tag ruleset stops those tags
  being created, moved or deleted by anyone but an admin, so an approved run
  can only ship a commit the preflight checked (the release preflight refuses
  to deploy until both are set; [deployment.md § The production environment's
  branch and tag policy](./deployment.md#the-production-environments-branch-and-tag-policy)).
  The workflow guard refuses any job that grants `id-token: write` outside
  `environment: production` (one allowlisted exception, Scorecard's signing
  job) and any `pull_request_target` workflow that checks out the PR's head.
- **CI's dependency cache is not trusted by release builds.** Every job in
  `ci.yml` (and `dependabot-lockfile.yml`'s credential-free job) restores
  pnpm's store through `actions/setup-node`'s `cache: pnpm`; both deploy
  workflows restore no cache at all (`check_workflows.mjs` rule
  `no-cache`, [deployment.md § What each deploy does](./deployment.md#what-each-deploy-does)).
  That split is the control, because **pnpm's store-integrity check would
  not reject a doctored store** (checked 2026-09-29 against pnpm 10.33.2,
  issue #126):
  - `verify-store-integrity` (default `true`) checks a stored file "before
    linking it … if a file in the store has been modified"
    ([pnpm.io/settings/store](https://pnpm.io/settings/store#verifystoreintegrity)).
    "Modified" means an mtime more than 100 ms after the `checkedAt` the
    package's index file records; only then is the file re-hashed, and only
    against the hash that same index file holds (`verifyFile` /
    `checkFile` in `@pnpm/store.cafs`'s `checkPkgFilesIntegrity`, in
    pnpm's bundled `dist/pnpm.cjs`). The lockfile's tarball `integrity`
    only locates the index file; a package already in the store is not
    re-downloaded or re-derived from its tarball.
  - A cache is a tar archive its writer controls end to end: the content
    files (named by their own hash, so a doctored file simply gets a new
    name), the index files that map a package to them, and every mtime.
    A poisoned entry can therefore point an index at doctored files with
    a `checkedAt` that says "unmodified", and pnpm links them without
    re-hashing; even a re-hash would pass, against the forged index.
    pnpm's own docs say the store "is intended to be shared only between
    mutually trusted users, jobs, and processes".
  - So the check guards against a corrupted store, not a hostile one, and
    no pnpm setting fixes that. **Release builds are sufficient as they
    are**: they install cold from the registry against the lockfile's
    tarball hashes, and they are the only builds that ship or hold deploy
    credentials. A poisoned cache could still change what a CI job on
    `main` or a PR runs (a false green or red, or code run with that job's
    read-only token), which is why no CI job that restores the cache holds
    a secret, and why the release preflight's trust in `CI gate` is a gate
    on the commit, not on the bytes CI built. Nothing to set in non-release
    CI: setting `verify-store-integrity` explicitly would change nothing
    (it is already the default and the forged index satisfies it). If a
    cache-restoring job ever needs a secret, drop the cache from it
    instead.
- **Each Lambda role writes to its own log group only** (`infra/iam.tf`,
  issue #126): `logs:CreateLogStream` and `logs:PutLogEvents` on
  `/aws/lambda/<its function>`, no `logs:CreateLogGroup` (Terraform makes
  every group), and no AWS-managed policy, whose logs grants are on `*`. So
  a compromised fetcher or renderer (the two with internet access) can't
  forge the lines the API's and worker's log alarms count. The VPC Lambdas'
  EC2 ENI actions are denied to their own code (`lambda:SourceFunctionArn`),
  leaving them to the Lambda service. The SQS endpoint admits `SendMessage`
  only; the deploy role reads nothing from the frontend bucket and can't
  change the renderer's repository policy (`tests/iam.tftest.hcl`).
- **S3** blocks all public access. Only CloudFront (OAC) reads it. The
  frontend bucket also lets that distribution `s3:ListBucket`, so a missing
  key is `404` rather than `403`; no listing can be requested through
  CloudFront (every path ending in `/` becomes `/index.html`, dot segments
  get a 404, no query string reaches S3; infra/README.md, "Missing files are 404").
  The reports bucket keeps `GetObject` only.
- **The public landing page** (`/`, signed out, and the prerendered
  `/welcome`, issue #57), the legal pages (`/privacy`, `/terms`,
  [legal-status.md](./legal-status.md)) and the methods page (`/methods`) are static: it calls no API but `/auth/me` (the
  layout's session check, which it doesn't wait for), shows only invented
  example data built into the bundle, loads nothing from a third party (no
  fonts, scripts, analytics or embeds), sets no cookie and stores nothing but
  the language choice already kept by the sign-in pages. Its prerendered HTML
  carries the same hashed meta CSP as every page (`check-csp.mjs` scans every
  `.html` in the build). The route guard's allowlist test covers it
  (`lib/auth/redirect.test.ts`).
- **Lambda Function URL**: the backend rejects any request without the
  CloudFront shared-secret header, so the WAF and CloudFront can't be bypassed
  by calling the Function URL directly. The check is skipped when the secret is unset (local
  dev), so the Lambda entry point (`lambda.ts`, `assertEdgeSecret`) refuses to
  start without a secret of at least 32 characters: a deploy missing it fails
  loudly instead of opening the Function URL (`app.security.test.ts`).
  A refused request still reached the Lambda past the WAF and held API
  concurrency for a moment, so each refusal logs
  `{"event":"origin_secret_rejected","reason":"missing"|"mismatch"}` (no path,
  address or header value) and the `origin-secret-rejected` alarm fires above
  20 in an hour (`infra/alarms.tf`). **Decision (issue #126): keep the shared
  secret.** CloudFront OAC for Lambda would make the Function URL refuse
  unsigned callers at AWS's edge instead, but it needs `AWS_IAM` auth on the
  URL, the viewer to send a SHA-256 of every PUT/POST body
  (`x-amz-content-sha256`), and the one-click unsubscribe (a mail client's
  POST without that header) moved to a GET. **Revisit trigger:** the alarm
  firing outside a secret rotation, or API throttles/concurrency the WAF's
  metrics don't account for; then move to OAC (tracked in
  [followups.md](./followups.md), § Infrastructure edge). The
  CloudFront→Function URL hop is `https-only` (TLSv1.2), and the header's
  value is the one the API's runtime secret carries
  (`infra/tests/edge.tftest.hcl`).
- **Production configuration fails closed** (`backend/src/config/production.ts`).
  Every setting falls back to the local stack when unset (`STORAGE=local`,
  `REPORT_DOWNLOADS=presigned`, `FEED_SOURCE=fixtures`, `MAIL_TRANSPORT=log`, `JOB_TRANSPORT=inprocess`,
  localhost links), so a Lambda missing one would quietly serve synthetic data
  or email localhost links rather than fail. All five entry points (`lambda.ts`,
  `lambda-worker.ts`, `lambda-fetcher.ts`, `lambda-renderer.ts`,
  `lambda-migrate.ts`) call `assertLambdaEnv(role)` at init: in Lambda (the
  runtime always sets the reserved `AWS_LAMBDA_FUNCTION_NAME`) they refuse to
  start on a missing or local-default setting, a `dev-only-`/`test-only-`
  placeholder anywhere (the committed dev JWT secret), a non-https or localhost
  URL, a `DATABASE_URL` without `sslmode=verify-full` or with a short (dev)
  password, `VITEST`, or no explicit `ALERTS_ENABLED` on the worker. The error
  names settings, never values. `config/production.security.test.ts` bundles
  each entry point and fails on any `process.env` read that `SETTINGS` doesn't
  classify, checks each Lambda's Terraform environment block (or, for a secret,
  its runtime secret, [§ Runtime secrets](#runtime-secrets)) sets every
  required setting, sweeps every `backend/.env.development` value, and starts
  each entry point with a production-shaped env (the positive control).
  Terraform also refuses a placeholder `auth_jwt_secret` at plan time
  (`infra/lambda.tf` precondition, `rejects_dev_placeholder_jwt_secret`).
- **WAF:** three per-IP rate limits on CloudFront: a tight 100-requests-per-5-minutes
  limit scoped to `/api/auth/*`, the API's limit (`waf_rate_limit_per_ip`,
  default 1000 per 5 minutes) scoped to `/api/*`, and a site-wide backstop
  on every path (`waf_site_rate_limit_per_ip`, default 5000). The API's
  limit doesn't count the SPA's cached files, so a cold visit (~150 of
  them) or the report renderer, which loads the SPA in a fresh Chromium for
  every PDF from a few shared Lambda addresses, doesn't eat it; the
  backstop still caps one IP pulling the static site (a request the WAF
  blocks isn't billed by CloudFront, one it allows is), at the
  `cloudfront-requests` alarm's own default. Both API-path rules match the
  decoded, normalised, lowercased path (`infra/waf.tf`,
  `waf_rate_rules_scope`). A renderer the WAF blocks gets a plain `403`
  without the API's `render_token_refused` code, so the render is retried
  with backoff rather than failed (§ Render tokens).
- **Ambiguous paths are refused by the API** (`backend/src/http/rawPath.ts`,
  issue #126). The WAF matches rules on the raw path and Hono routes on a
  decoded one (`decodeURI`), so `/api/%61uth/login` is `/auth/login` to the
  router; building a `Request` also resolves dot segments, `%2e%2e`
  included. Before anything reads the path (the router, the CSRF and
  body-limit exemptions, a render session's scope), the app answers
  `400 { error: "bad request path" }` for an escaped unreserved character
  (`A–Z a–z 0–9 - . _ ~`, which no client needs to encode), an escaped `/`,
  `\` or `%` (double encoding), an escaped control character, a malformed
  escape, or a raw `.`/`..` segment or `\`. It checks the path as the runtime
  received it (the Function URL event's `rawPath`, the Node server's request
  target) as well as the `Request` URL, since only the former still shows a
  dot segment. Other escapes pass: a space (`%20`), non-ASCII (`%C3%A9`) and
  reserved characters such as `%3A` stay usable in a path parameter (every
  current one is a UUID). Tests: `http/rawPath.test.ts` (the rule),
  `http/rawPath.security.test.ts` (through the app, a real Node server and
  the Lambda adapter, with positive controls). **Operator check after the
  first deploy:** send one `GET /api/%61uth/me` through CloudFront and confirm
  CloudFront and the Function URL pass the escape through (the API answers
  `400 bad request path`, not `401`) and the WAF's auth rule counts it (its
  sampled requests).
- **Response headers** (CloudFront, both behaviours): CSP (`default-src
  'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no third-party
  origins; `default-src 'none'` on `/api/*`), HSTS 2 years, nosniff,
  `X-Frame-Options: DENY`, Referrer-Policy (`no-referrer` on `/api/*`),
  `X-XSS-Protection: 0`, Permissions-Policy, COOP (`infra/security_headers.tf`).
- **Email (SES):** the API role may only `ses:SendEmail` as
  `no-reply@<domain>` through one identity and configuration set, over a VPC
  endpoint. DKIM + SPF-aligned MAIL FROM + DMARC; TLS required to the
  receiving server; bounces and complaints suppressed.
- **Deploy role trust:** the plan fails if the bootstrap role's trust policy
  is not pinned to this repo's `environment:production` subject
  (`infra/oidc.tf` postcondition, tested).
- **Database** (`infra/rds.tf`, not yet applied): RDS in private subnets, no
  public endpoint, encryption at rest (a customer-managed KMS key by default,
  `rds_customer_managed_key`, usable only through RDS; deployment.md § Decide
  before the first apply; disabling it, scheduling its deletion, changing
  its policy or revoking a grant pages the alerts topic through CloudTrail
  and EventBridge, `kms.tf`), TLS enforced (`rds.force_ssl`),
  automated backups + PITR (7–35 days; single-AZ recovery point about
  5 minutes), deletion protection and `prevent_destroy`, a final snapshot on
  teardown (kept until deleted), and an RDS event subscription to the alerts
  topic. Only the API and
  migrate Lambdas' security groups can reach it (and the job worker's).
- **The fetcher Lambda** (data feeds, `infra/feeds.tf`) is the only Lambda
  with internet access and the only one outside the VPC. It has no database
  URL or secret; its role can receive from `fetch-requests` and send to
  `ingest-results`, nothing else (guardrail tests pin both). The SQS endpoint
  policy lets the worker, and only the worker, reach those two queues. What
  it is asked to fetch is bounded upstream: feeds run daily only, and "Run
  now" is a token bucket per feed (6, then one every 10 minutes;
  111_feed_daily_only, `app_feed_take_run_now`), so an editor can't turn a
  feed into a request loop.
- **Blast radius:** Lambda reserved concurrency is capped. There are monthly
  and daily budgets and Cost Anomaly Detection (off until the operator turns
  it on after the first apply; deployment.md § Budget alerts), and alarms on Lambda errors, throttles, the API's unhandled 500s
  (`unhandled_error`) and CloudFront 5xx. Both alert topics admit only this
  account's services (`aws:SourceAccount`, and `aws:SourceArn` for CloudWatch
  and Budgets), so another account can't publish fake alerts through them.
- **Model integrity:** `executeRun` (backend/src/runs/execute.ts) logs a
  structured `{ event: "self_check_failed", projectId, runId, checks }` line
  — failed check ids only, never a farm name, date or value — when a saved
  run fails one of the engine's self-checks (docs/model.md § Verification).
  A CloudWatch log metric filter + alarm on that line (`infra/alarms.tf`,
  `self_check_failed`), on both the API's log group and the worker's (whose
  automatic re-runs and forecast runs save runs too), notifies the same
  alerts SNS topic as every other alarm, so a model bug in production is
  paged, not just shown as a warning on the one run.


### Accepted IaC findings

CI's Trivy config scan (`terraform.yml`, Terraform and
`backend/renderer.Dockerfile`, HIGH/CRITICAL to the Security tab) flags these
on purpose-built resources. Each carries a `#trivy:ignore:<ID>` with its reason
beside the resource; a new ignore needs a line here too.

| Finding | Resources | Why it stays |
| --- | --- | --- |
| AWS-0095 SNS topic not encrypted with a customer-managed key | `aws_sns_topic.alerts`, `.alerts_us_east_1` (alarms.tf), `.ses_events` (ses.tf) | Budgets, Cost Anomaly Detection, CloudWatch alarms and SES publish to an encrypted topic only through a CMK whose key policy grants each service (the AWS-managed `alias/aws/sns` refuses them). The messages are threshold notices and bounce events, with no client data. |
| AWS-0132 S3 bucket not encrypted with a customer-managed key | `aws_s3_bucket_server_side_encryption_configuration.reports` (reports.tf), `.frontend` (s3_cloudfront.tf) | Both are SSE-S3 encrypted. `frontend` is the public static site. `reports` is private (public access blocked, written only by the renderer role, read only by CloudFront's origin access control for short signed URLs): a CMK would need a key policy for CloudFront and a grant for the renderer without changing who can read a PDF. |

Revisit AWS-0132 for `reports` if a client contract asks for customer-held
keys or key-level audit of report reads.

## Liability

Roadmap WP-3.13. How far a report can be trusted, and who stands behind it.

- **Disclaimer.** Every report ends with the disclaimer (engine
  `DISCLAIMER`, versioned). Version `2026-09-28` is agreed: the operator
  accepted it after a pre-counsel review, not an external legal adviser
  (decision D10). A wording marked `draft` shows a bold draft line beside
  it on every surface.
- **Known limitations can't be left out quietly.** The report's validation
  statement lists every open engine-audit.md item, generated from the doc;
  a test fails when the committed list and the doc differ. The same holds for
  the **errata** (known bugs per engine version, `docs/engine-errata.md`):
  the statement lists those of the run's engine version.
- **Methodology statement.** `docs/methodology/v<N>.md`, cited by version and
  the SHA-256 of its bytes. A published version is never edited: a test pins
  every published hash, so an edit fails and has to become a new version,
  and a hash cited by an old sign-off or pack stays checkable.
- **Sign-off.** A registered professional signs a run
  ([data-model.md § Sign-offs](./data-model.md#sign-offs-036_signoffsql)).
  - *Who:* editors and owners, as themselves only (RLS `user_id =
    app_current_user_id()`); viewers read; farmers see nothing.
  - *What:* the server rebuilds the statement (the ten confirmations of
    `signoff-4`, the
    limitations, the errata of the run's engine version, the methodology
    statement's version and hash, the notes, the disclaimer version, the run's id and engine
    version) and refuses a sign-off whose SHA-256 isn't that statement's, so
    a signature is bound to the words shown. Every confirmation must be
    ticked. The registration is fixed choices (engine
    `liability/registration.ts`, 092): SACNASP or ECSA, a category and a
    field or discipline. A candidate, certificated or specified category is
    refused (400): they work under a professional's supervision (NSP Act
    s 22(2); Engineering Profession Act s 18(4)), so the supervising
    professional signs. An unusual category or field only warns. A legacy run (a stored run from before engine 1.0.0, which
    removed that model) can't be signed (audit H1), nor can a run whose
    server stamp is missing or no longer matches its rows
    ([§ Run stamps](#run-stamps)).
  - *Immutable:* `water_app` has no `UPDATE` or `DELETE` on `signoff` and no
    policy allows either (catalogue guard); the signed run is cited, so it
    can't be deleted or trimmed, and `water_app` may change only its notes
    and pin. A scenario with a signed-off run can't be deleted either (409;
    the `scenario_signed_run_guard` trigger, 072, refuses it in SQL too,
    which is what stops an applicant, who can't read the assessor's
    sign-off of their withdrawn application's run),
    since the run's `scenario_id` would go NULL and the signed scenario run
    would pass for a run of the project's own inputs. Deleting the whole
    project still takes its sign-offs with it (cascade), unless it has an
    evidence nomination (035). Each sign-off is in the audit log.
  - *A pack sign-off* (112) signs an evidence pack rather than a run: the
    same checks, with the pack statement (`pack-signoff-1`, the run
    statement's confirmations plus one naming the pack's manifest hash), on a
    draft only ([§ Evidence packs](#evidence-packs)).
  - *Limits, stated on the report and in the dialog:* the registration
    details are the **signer's own declaration** (not checked against the
    ECSA or SACNASP register, and printed "self-declared"; the report prints
    the chosen register's address beside each signature); dam
    safety (NWA Chapter 12, DW793) isn't covered; the sign-off makes no
    finding on lawfulness and doesn't verify the app's software; there is no MFA on
    signing yet (Step 4), so a sign-off is as strong as the signer's
    password. The typed name and registration are personal data: the
    data-subject export lists them (`signoffs`), and deletion keeps the row
    with the account cleared ([§ Personal information](#personal-information-popia)).

## Evidence packs

Roadmap WP-3.14, 112_evidence_pack ([evidence-pack.md](./evidence-pack.md),
[data-model.md § Evidence packs](./data-model.md#evidence-packs-112_evidence_packsql)).
An issued pack is what an applicant attaches to a licence application, so it
must not change, disappear or be forged, and its public check must give away
nothing else.

- **Immutable once drafted, whoever writes.** `evidence_pack_guard` (BEFORE
  INSERT OR UPDATE, `SECURITY DEFINER`) freezes the manifest, its SHA-256,
  both runs, the scenario, the version and its predecessor from the insert,
  for the schema owner too. The status moves only forward (draft → issued →
  superseded or withdrawn; a draft may be withdrawn); the issue stamp is set
  by the trigger from the session, never by the caller; the reason and the
  successor are set once, with their move; the PDF and the bundle hashes once.
  The manifest must name the row's own id, version, project and versions, and
  a new version must be of the same application as its predecessor.
  `water_app` has no grant on the PDF and bundle columns at all: those hashes
  are printed by verify, so only the renderer's future `SECURITY DEFINER`
  setter may write them.
  `water_app` can't even name a frozen column in an `UPDATE` (column grants;
  catalogue `COLUMN_ONLY_UPDATE`).
- **Never deleted once issued.** RLS lets an editor delete a draft only, and
  a signed draft is held by its sign-off's foreign key (it is withdrawn
  instead). No trigger refuses the delete, so the project's own cascade
  still works; instead the **project is kept**: `project_pack_guard` (BEFORE
  DELETE on `project`) refuses deleting a project with a pack past draft, for
  every role and path, and the project `DELETE` route answers `409` first
  (operator decision, 2026-09-29). A project with a pack has nominated a run,
  so 035's guard holds it too. The operator's out-of-band removal is as for
  035 ([§ Tamper evidence](#tamper-evidence)), disabling both triggers.
- **Its runs and scenario are kept.** Both runs are cited
  (`model_run_cited`), so the storage cap, the unpin and the run `DELETE`
  keep them; the scenario can't be deleted (`scenario_signed_run_guard`, now
  with the pack clause; the route answers `409`).
- **Bound to its signers, and they to it.** A pack is issued only with a
  sign-off whose statement (`pack-signoff-1`) names the pack's manifest hash;
  the route requires a sign-off of the *current* statement, and the trigger
  refuses an issue with no sign-off at all. A sign-off of a pack is made only
  on a draft (`signoff_pack_draft`). The statement kinds can't be mixed: a
  `pack-` version signs a pack and any other a run (`signoff_statement_target`).
- **The hash survives storage.** The server hashes the manifest's RFC 8785
  text when it drafts, re-reads it from `jsonb` and hashes it again (a
  mismatch aborts the draft), and does so again before issuing; `GET …/packs/:packId`
  says `manifestMatches`.
- **One issued pack per application** (or per project's baseline evidence):
  the issue route refuses a second (`409`), and the deferred exclusion
  constraint `evidence_pack_one_issued` holds it at commit, so the version
  chain can't fork into two current packs.
- **Issue re-checks the evidence.** The frozen report must be issuable, the
  live one still (the nomination, the declared rule, the cited ensemble), and
  both runs' server stamps must still match their rows ([§ Run stamps](#run-stamps)).
  A full reproduction of both runs isn't run in the request; the reproduction
  bundle will carry it ([followups.md § Evidence report](./followups.md#evidence-report-issue-71)).
- **Who.** Editors and owners draft, sign, issue, supersede, withdraw and
  delete drafts; viewers read a baseline pack, and an application pack when
  they read its scenario (`app_scenario_readable`, 045); editors read every
  pack. Contributors (applicants) and farmers read none and act on none
  (operator decision, 2026-09-29: issuing stays with the project's editors).
  The pack routes' bodies are strict where they create or issue.
- **The public verify lookup** (`GET /verify/:code`, one of the few
  `withoutUser` callers besides pre-sign-in auth, the share links and the
  job queue: it reads nothing but through `app_verify_pack`; in the route
  inventory's public allowlist) takes a short code or a full manifest hash,
  which are printed on the pack and not secrets (unlike a share link's
  token). `app_verify_pack` (`SECURITY DEFINER`, `search_path` pinned,
  `EXECUTE` for `water_app` only) returns only the printed fields: status,
  version, issue date, catchment name, engine and report versions, the
  manifest and PDF hashes, the successor's hash, a withdrawal reason, the
  methodology cited, the errata recorded, and the signers' names and
  registrations. The withdrawal reason is the editor's own words and is
  public too: the withdraw action must say so (it is printed where the pack
  was). No ids, inputs, results, accounts or emails. A draft, a
  pack never issued, an unknown code and a malformed one are the same `404`.
  `Cache-Control: no-store`, so a withdrawal shows at once. It is
  rate-limited only by the WAF's rule on the whole API; enumerating 12-hex
  codes (2⁴⁸) through it is not practical.
- **Personal data.** The signers' typed names and registrations are public
  on verify, as they are printed on the pack (a professional signature is
  made to be read by others; the pack sign-off dialog, with the pack view,
  must say so: [followups.md § Evidence report](./followups.md#evidence-report-issue-71)). Who drafted and issued a
  pack is the project's record; an account deletion clears it (the guard
  allows only that change, only once the account is gone). The signer's
  data export lists their pack sign-offs (`packId`); the drafting and issue
  are exported as their audit events.

## Known gaps (tracked in [plan.md](./plan.md))

- **CSP `style-src 'unsafe-inline'` (accepted risk).** The CloudFront CSP
  (`infra/security_headers.tf`) is strict on scripts: the header's
  `script-src 'self' 'unsafe-inline'` is narrowed by SvelteKit's per-build
  `<meta>` CSP to `'self'` plus the hash of its one inline bootstrap script
  (and the sign-in CAPTCHA SDK's two origins once configured, § Sign-in CAPTCHA),
  and the frontend deploy refuses a build without that meta policy
  (`infra/scripts/check-csp.mjs`). This needs `kit.csp.mode = 'hash'` in
  `frontend/svelte.config.js`. Styles keep `'unsafe-inline'`, because Svelte
  templates and uPlot set inline `style` attributes. CSS injection can't run
  script; Svelte's escaping and the ban on `{@html}` with user data remain the
  first XSS defence.
- Registration is open to anyone who can reach the site. Registering grants no
  access to existing projects, but decide with the client whether sign-up
  should be invite-only (plan question 11).
- Any editor may sign off the calibration rules; restricting it to a role
  waits on the client (#90; [§ Calibration rules sign-off](#calibration-rules-sign-off)).
- POPIA: no privacy notice and no self-service account deletion yet
  (Phase 7); what exists today and the open items are in
  [§ Personal information](#personal-information-popia).

## Incident playbook

Where personal information may have been seen or taken, the technical steps
below run alongside [legal/incident-procedure.md](./legal/incident-procedure.md)
(who decides, the 48-hour notice to clients, the Regulator's report and the
notice to data subjects).

1. **Suspected secret leak:** rotate the secret at its source.
   `AUTH_JWT_SECRET` rotation logs every user out and leaves every stored
   run unverified until re-run ([§ Run stamps](#run-stamps)). DB passwords: `ALTER ROLE`
   and update the secret. Then update `infra-secrets/water-management/prod.sops.yaml`
   and apply through `infra/scripts/tf.sh` (the edit moves
   `sops.lastmodified`, which rotates the runtime secrets). The operator runs
   these steps by hand.
2. **Suspected cross-project data exposure:** check the RLS policies and the
   `water_app` role flags (`\du`, `pg_policies`). Add a failing DB test that
   reproduces it before fixing.
3. **IAM credential leaked:** deactivate it immediately, check CloudTrail
   (especially `kms:Decrypt`), and rotate every secret if decryption was
   possible.
4. **Client workbook committed by mistake:** don't just delete it in a new
   commit. Rewrite the history before any push, and tell the operator. If it was
   already pushed, it's a data incident for the client.
5. **AWS account compromised:** recover the account through the org
   management account, rotate everything, and re-provision.
