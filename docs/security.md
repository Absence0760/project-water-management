# Security

The security model for the water-management app. The data it holds is
catchment configuration and farm-level water use for named farms. It is not
financial data, but it is commercially sensitive to the client and may be
personal information under POPIA (see [plan.md questions](./plan.md#questions-for-the-client)).

## Authentication

- **Accounts:** email + password. Passwords are hashed with **bcrypt**
  (`bcryptjs`, cost 12; 4 under vitest only, `auth/password.ts`) and are 8–200 characters. Emails are `citext`, so
  lookups ignore case. The hash never leaves the backend.
- **Session:** an HS256 JWT signed with `AUTH_JWT_SECRET` (`jose`). It carries
  the user id and has a 7-day expiry. It sits in the **`wm_session` cookie**,
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
  in (`POST /auth/change-password`, the Account page) sets it too, then
  re-issues this device's cookie, so only the device that changed it stays
  signed in. Plain logout clears the cookie only
  (that one token stays valid until expiry if it was copied). Rotating
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
  a row lock, so parallel guesses can't slip past. Accepted trade-off: anyone
  can lock someone else's address for up to 15 minutes at a time (sessions
  already signed in are unaffected, and a password reset lifts it). The
  WAF's per-IP rate limits (below) are still the first line against spraying
  many addresses. Changing the password while signed in checks the current
  password through the same lockout (keyed by the account's address), so a
  stolen session can't guess it faster than the sign-in form; the flip side
  is that a locked address can't change its password until the lock ends
  (a reset still works).

## Password reset, email verification and invites

- **Tokens** are 32 bytes from `crypto.randomBytes`, mailed as base64url. The
  database stores **only the SHA-256 hash** (`email_token.token_hash`,
  `invite.token_hash`), so a DB dump, replica or query log never yields a
  working link. Tokens are **single-use** (consuming deletes the row), scoped to
  a purpose (a verify token can't reset a password), and expire: reset **1 h**,
  verify **48 h**, invite **7 days**. Issuing a new one replaces the old one.
  Malformed tokens are rejected before any DB work.
- **No account enumeration:** `POST /auth/forgot-password` answers `202` with
  the same body for known and unknown addresses. Accepted residual risk:
  response *timing* differs slightly (a known address does a DB write and an
  SES call), and `POST /auth/register` already answers `409` for a taken
  address, so enumeration is not fully closed — the WAF's per-IP rate limit is
  the backstop. Don't "fix" this by making register lie without also making
  sign-up email-first.
- **Mail-bombing throttle:** at most one reset, verification or invite email
  per address per minute, enforced in Postgres (`app_issue_email_token` with an
  advisory lock; `invite.last_sent_at`) so it holds across Lambda instances.
- **Mail failures never change the response** (`trySendMail` logs the error
  without the body, which contains a live token). Mail is sent after the
  transaction commits, so a mailed link always refers to a stored token.
- **Email verification** is not required to sign in (V1). It *is* required to
  claim invitations: `app_accept_invites()` only converts invites for a
  **verified** address, so someone who registers an invitee's address first
  gets nothing. Signing up through the invite link counts as verified only when
  the link's invite is for the exact address being registered.
- **Invites** are visible and revocable only by project owners / team admins
  (RLS on `invite`); invitees have no access until they have an account.
  Accepting goes through a `SECURITY DEFINER` function that re-checks
  verification.
- **Adding an existing but unverified account** doesn't make it a member:
  `POST …/members` adds only **verified** accounts directly. An unverified one
  gets a pending invite (the same response as an address with no account, so
  the owner learns nothing about whether it's registered) and an email to the
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
  names) is HTML-escaped; subjects are stripped of CR/LF. Links use `SITE_URL`
  from config, never the request's Host header. The reset and verify pages
  strip the token from the address bar and set a `no-referrer` policy
  (`<meta name="referrer">`; the invite sign-up page does the same).
- **Transport:** SES via the Lambda's IAM role in production (no SMTP password
  to hold). The `log` transport refuses to print message bodies inside Lambda,
  so a misconfigured deploy can't write live links into CloudWatch.

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
  and the trigger); a farmer can't. It is issued by the `report_render` job,
  which runs as the requester under RLS, and never leaves the server side:
  it goes to the local Chromium in memory, or in production over the
  SSE-encrypted `render-requests` queue to the renderer Lambda. It is never
  logged, never put in a URL, and never stored raw.
- **The exchange** (`POST /auth/render-session`, public: the token is the
  credential) consumes the token, re-checks that the requester can still see
  the project and that the run is still one of its runs (`403` otherwise),
  and sets a `wm_session` cookie whose JWT carries `scope: { p, r }` and
  lives **10 minutes**. A used, expired, unknown or malformed token gets one
  answer, `400`. The renderer calls it through its browser context's own
  request client, so the cookie lives only in that throwaway context, which
  is closed with the browser after the render.
- **The scope** (`reports/scope.ts`, enforced in `requireUser`): a render
  session may make **only `GET`** requests, and only to `/auth/me`,
  `/projects/<p>`, `/projects/<p>/series` and `/projects/<p>/runs/<r>[/…]`:
  exactly the reads the report route makes. Any other method, project, run
  or route (the run list, members, exports, jobs, reports, teams, compare,
  every write) answers `403`. A path with encoded characters or dot segments
  is refused outright. A `scope` claim that isn't a well-formed pair of UUIDs
  makes the whole token invalid, so a render session can never widen into a
  full one. RLS still applies underneath: the session is the requester's, so
  it sees at most what they see. It is also revoked with every other session
  of the account (the `sessions_revoked_at` watermark).
- **Tests:** `reports/reports.db.test.ts` checks single use, expiry, the
  scope on another project, another run and every other kind of route, with a
  positive control (the report's own reads answer `200`), a requester who
  lost access between issue and use, and that farmers and strangers can't
  issue one; `reports/scope.test.ts` pins the path rules; and
  `reports/render.db.test.ts` has a real Chromium check that the session is
  refused the project list mid-render.
- **What the renderer can reach.** Locally, the dev site and API. In
  production the renderer Lambda is outside the VPC with no database access
  and no secrets; it opens the public site through CloudFront and the WAF
  like any browser. Its role can receive `render-requests`, send
  `render-results` and put objects under `reports/` in the reports bucket:
  it can't read, list or delete a PDF. It opens only its configured
  `RENDER_SITE_URL`: a render request carries ids and the token, never a URL.
- **The PDFs** are in a private bucket (public access blocked, TLS only,
  SSE-S3), under keys derived from the project and report ids (never stored
  or taken from a message), deleted after 7 days. A download is a pre-signed
  GET that lasts an hour, handed out only by `GET /projects/:id/reports/:jobId`
  to a viewer of the project. **Emails carry no PDF and no download link**:
  they link to the app's `/projects/:id/reports/:jobId` page, which needs the
  reader signed in and still a member, so a forwarded email opens nothing.
  Recipients must be direct project members with viewer or above, checked
  when asked for and again when the mail is sent; a viewer may email only
  themselves; on-demand PDFs are capped at 10 an hour per user and project.
- **Accepted residual risks.** A pre-signed link works for its hour for
  whoever holds it (as any download link would); keep it short and don't log
  it. A render request dead-lettered in production still holds its token
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
  and the k boundary at 4 and 5 holders) and `routes.test.ts` (the two reads
  on the public allowlist, answering `400` rather than `401`).

## Authorization: per-project roles enforced by Postgres RLS

Full detail is in [data-model.md § Access control](./data-model.md#access-control).
In short:

- Roles are **viewer < editor < owner**, per project. A team grants one of
  them on every team project: team **viewer → viewer**, **member → editor**,
  **admin → owner** (`app_project_role()`, 008_team_viewer). The mapping is
  explicit and an unrecognised team role grants nothing, in SQL
  (`app_project_role`), the API (`hasTeamRole`) and the UI, so a role added
  later can't silently become an editor. The role functions every policy
  calls (`app_current_user_id`, `app_team_role`, `app_project_role`,
  `app_has_role`) are PL/pgSQL since 026_rls_role_plpgsql: a SQL function with
  `SECURITY DEFINER` or a pinned `search_path` can't be inlined and is planned
  again on every call, and a policy calls them once per row (writing a run's
  ~200 series spent 0.8 ms a row on them). Keep new role helpers in PL/pgSQL
  for the same reason.
- The backend connects as **`water_app`**: no superuser, no `BYPASSRLS`, owns
  no tables. Each request that touches project data runs in a transaction that
  sets `app.current_user_id` (transaction-local), and RLS policies on every
  project table check membership and role. A bug that forgets a `WHERE
  project_id = …` therefore returns nothing rather than someone else's data.
- A project you are not a member of returns **404**, never 403, so project
  existence doesn't leak.
- **Change history and audit log (WP-2.4, 030).** `model_revision`,
  `series_revision` and `audit_event` are append-only for `water_app`
  (`SELECT` and `INSERT` grants, no `UPDATE` or `DELETE` policy); only the
  `series_revision` retention trigger deletes, and only that series' old
  rows. An audit row must name the caller as its actor. Viewers and above
  read history; farmers and strangers see nothing. Invite emails in events
  are masked. Details: [data-model.md § Change history and audit log](./data-model.md#change-history-and-audit-log-030_historysql).
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
  closed; `farms.db.test.ts` calls every `/projects/:id` route as a farmer and
  expects `400`/`403`). Extra `SELECT` policies let them read their linked
  farms, the gauges and their own membership row, and nothing else: no other
  farm's name or figures, no member list, no series, runs or run series. A
  farmer-facing aggregate of farm quantities needs at least `k − 1` other
  holders (`app_other_farm_holders`, `k = 5`), counted by holder, not farm
  node, so a multi-farm owner can't back out a neighbour's figures; flow
  volumes are never shown to farmers because in a small catchment they reveal
  a neighbour's use (design [farmer-view.md §10](./design/farmer-view.md)).
  Open with the client and the security lead: who may hold viewer on a
  project with farmers (FV-D5), since viewers see every farm.
- **Publications and the farm view (WP-2.3, WP-2.6 API, 022).** A farmer reads
  run results only through the project's current publication: its counts-only
  `catchment_view`, their own farms' stored projections (`publication_farm`)
  and their own farms' farm-allowlist series of the published run
  (`run_series_select_farmer`: `demand`, `supplied`, `deficit`,
  `dam_storage`, `spill`, `transfer`; no flow series, no catchment series,
  nothing of an earlier publication). The farm routes
  (`/projects/:id/farm…`) admit the farmer role, answer `404` alike for a
  node the farmer isn't linked to, a gauge or a node that doesn't exist, and
  null the even share below `k − 1` other holders per viewer. Tests:
  `publish/publication.db.test.ts` scans a farmer's farm view and
  publication list for every other farm's id and name, with positive
  controls; `farms.db.test.ts` keeps every other `/projects/:id` route
  refusing a farmer. The modeller's publication `note` is withheld from
  farmers by the API but not by RLS (a column can't be hidden from one role
  there): the publish dialog tells the modeller farmers don't see it, and it
  must not be relied on as a secret. Publishing records `published_by`, and a
  notice change `updated_by` / `updated_at`; the full audit log is WP-2.4.
  Share links (a public, token-bearing catchment page) are not built yet
  (WP-2.3 phase 2).
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
- **Tamper evidence for the nominated evidence run** (010_run_nomination).
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
    raises a warning.
  - Limits: the project owner can still delete the **whole project**, history
    included; an issued, hashed evidence pack that survives that is roadmap
    WP-3.14. The schema owner (`water`, migrations only) is not bound by the
    grants. A nomination proves what the project said and when, not that the
    run is right: that is the assessor's review.
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
    run visibility ever does (applicants, WP-3.3). Knowing a hash gives
    nothing: another project's member reads no row, by hash or at all
    (`reproducible.db.test.ts`, with the owner and a viewer as positive
    controls), and can't point a run of theirs at it (the composite foreign
    key finds no such blob in their project).
  - **Immutable by privilege.** `water_app` has `SELECT` and `INSERT` only on
    both tables (the catalogue test's `APPEND_ONLY`). Blobs are inserted by
    editors; a reference only by an editor, to a run of the same project
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
  Postgres error codes to fixed messages; anything else is a logged, generic
  `500`.

## Input handling

- Every request body is validated with **zod** before it reaches SQL. Queries
  are parameterised (`pg`), and there is no string-built SQL.
- Model documents are validated as a whole: references resolve inside the
  document, the network is a tree with one outflow, and names are unique.
- Series are capped at 60 000 values. The backend itself caps every request
  body at 4 MB (Hono `bodyLimit`, `backend/src/app.ts`, `413` past it),
  tighter than and ahead of Lambda's 6 MB payload limit in production. The
  one exception is `POST /projects/import` (a whole project document), capped
  at 5 MB on the route, after the session check, so an anonymous caller never
  gets a large body read.
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
- The `.xlsx` export uses SheetJS CE 0.20.3 (the in-browser importer no
  longer does; the tests still read workbooks with it, to compare the two
  readers cell by cell), pinned in `frontend/package.json` to its official CDN tarball with the
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
    streamed, range reads for the grids. A GeoTIFF is parsed by our own
    bounds-checked reader (dimensions, strip sizes and LZW codes checked;
    anything outside the known layout refused), and a DWS page by a strict
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
- Svelte escapes output by default. Don't use `{@html}` with user-supplied names
  (farms, crops, projects).
- **CSV exports defuse spreadsheet formulas.** Farm, run and series names are
  user-controlled and the files are opened in Excel by other project members,
  so any text cell starting with `= + - @`, tab or CR gets a leading `'`
  (`backend/src/export/csv.ts`, OWASP "CSV injection"). Numbers are written as
  numbers. Export file names are ASCII slugs, so `Content-Disposition` can't be
  injected.
- **The `.xlsx` workbook treats names the same way.** It is built in the
  browser from the same API data (`frontend/src/lib/spreadsheet/export/`):
  the summary sheets are the summary CSV's cells, already defused; names the
  workbook writes itself (the EWR grid's sites, the Inputs sheet's nodes,
  crops and references) go through `defuse` in `names.ts`, the same rule as
  `textCell`. Every name is a **string cell** and the workbook never writes a
  formula, so Excel shows `=cmd|…` as text; the apostrophe keeps it inert if
  someone edits the cell or copies it into a CSV. Unit and e2e tests check
  both (no cell in the file has a formula). Sheet names are cleaned to
  Excel's rules (none of `[ ] : * ? / \`, at most 31 characters, unique), and
  the file name is the summary CSV's server-made ASCII slug. The worker loads
  from `'self'` only (`worker-src 'self'`), and SheetJS only writes here; it
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

## Public repo hygiene

**This repository is public.** Anything committed, including history, is
readable by anyone. The rules:

- **No secrets, not even encrypted ones.** Production values (DB credentials,
  `AUTH_JWT_SECRET`, anything that grants access) live only in the private
  `Absence0760/infra-secrets` repo under `water-management/`, SOPS-encrypted
  under `alias/water-management-sops`. Bootstrap:
  `infra-secrets/bin/sops-init.sh --project water-management --region <region>`.
  Terraform consumes them with the `carlpett/sops` provider or a
  decrypt-to-tfvars step into a gitignored `terraform.tfvars`.
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
  fake test tokens); add one only after checking the match isn't real. Before pushing a branch, check the diff
  for client names as well as for keys.
- If something slips in: **don't push**. Rewrite the history locally, then tell
  the operator (see the incident playbook below).

## Secrets management

- **Production secrets live outside this repo**, in
  `infra-secrets/water-management/prod.sops.yaml`, SOPS-encrypted under
  `alias/water-management-sops`. Decryption is gated by IAM (`kms:Decrypt`) and
  logged in CloudTrail. The key rotates yearly. Terraform's `carlpett/sops`
  provider decrypts in memory, so nothing is written to disk.
  See `../infra-secrets/README.md`.
- This app's production secrets: `AUTH_JWT_SECRET` and the `water_app` DB
  password. The owner (`water`) password is managed and rotated by RDS in
  Secrets Manager (`manage_master_user_password`), read only by the migrate
  Lambda at run time. The CloudFront shared secret is generated by Terraform
  (`random_password`).
- **Committed local defaults are non-sensitive by design.**
  `backend/.env.development` holds the docker-compose throwaway passwords
  (`water`/`water`, `water_app`/`water_app`) and a dev-only JWT secret. They
  grant access to nothing outside a local container. Never reuse them anywhere
  real. Machine-local real values go in a gitignored `.env.development.local`.

## Infrastructure

- **CI/CD uses GitHub OIDC.** There are no long-lived AWS keys. The deploy
  role's trust policy is pinned to `repo:<owner>/<repo>:environment:production`,
  and that environment has a required reviewer. A workflow can only assume the
  role after a human approves the run.
- **S3** blocks all public access. Only CloudFront (OAC) reads it.
- **Lambda Function URL**: the backend rejects any request without the
  CloudFront shared-secret header, so the WAF and CloudFront can't be bypassed
  by calling the Function URL directly.
- **WAF:** two per-IP rate limits on CloudFront: a tight 100-requests-per-5-minutes
  limit scoped to `/api/auth/*`, and a general limit (`waf_rate_limit_per_ip`,
  default 1000 per 5 minutes) covering the whole site and `/api/*`.
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
  public endpoint, encryption at rest, TLS enforced (`rds.force_ssl`),
  automated backups + PITR (7–35 days), deletion protection. Only the API and
  migrate Lambdas' security groups can reach it (and the job worker's).
- **The fetcher Lambda** (data feeds, `infra/feeds.tf`) is the only Lambda
  with internet access and the only one outside the VPC. It has no database
  URL or secret; its role can receive from `fetch-requests` and send to
  `ingest-results`, nothing else (guardrail tests pin both). The SQS endpoint
  policy lets the worker, and only the worker, reach those two queues.
- **Blast radius:** Lambda reserved concurrency is capped. There is a budget
  alarm, plus alarms on Lambda errors, throttles and CloudFront 5xx.
- **Model integrity:** `executeRun` (backend/src/runs/execute.ts) logs a
  structured `{ event: "self_check_failed", projectId, runId, checks }` line
  — failed check ids only, never a farm name, date or value — when a saved
  run fails one of the engine's self-checks (docs/model.md § Verification).
  A CloudWatch log metric filter + alarm on that line (`infra/alarms.tf`,
  `self_check_failed`) notifies the same alerts SNS topic as every other
  alarm, so a model bug in production is paged, not just shown as a warning
  on the one run.

## Liability

Roadmap WP-3.13. How far a report can be trusted, and who stands behind it.

- **Disclaimer.** Every report ends with the disclaimer (engine
  `DISCLAIMER`, versioned). It is **draft** wording until the client's legal
  adviser agrees it (decision D10; an operator item in followups.md §
  Blocking releases), and the report says so in bold beside it.
- **Known limitations can't be left out quietly.** The report's validation
  statement lists every open engine-audit.md item, generated from the doc;
  a test fails when the committed list and the doc differ.
- **Sign-off.** A registered professional signs a run
  ([data-model.md § Sign-offs](./data-model.md#sign-offs-035_signoffsql)).
  - *Who:* editors and owners, as themselves only (RLS `user_id =
    app_current_user_id()`); viewers read; farmers see nothing.
  - *What:* the server rebuilds the statement (the five confirmations, the
    limitations, the notes, the disclaimer version, the run's id and engine
    version) and refuses a sign-off whose SHA-256 isn't that statement's, so
    a signature is bound to the words shown. Every confirmation must be
    ticked; a legacy run can't be signed (audit H1).
  - *Immutable:* `water_app` has no `UPDATE` or `DELETE` on `signoff` and no
    policy allows either (catalogue guard); the signed run is cited, so it
    can't be deleted or trimmed. Each sign-off is in the audit log.
  - *Limits, stated on the report and in the dialog:* the registration
    number is **self-declared** (not checked against the SACNASP register);
    dam safety classification (DW793) is for others; there is no MFA on
    signing yet (Step 4), so a sign-off is as strong as the signer's
    password. The typed name and registration are personal data: the POPIA
    export and deletion must cover them (followups.md § Liability and
    sign-off).

## Known gaps (tracked in [plan.md](./plan.md))

- No app-level rate limit on `/auth/register` beyond the WAF's per-IP
  `/api/auth/*` rule. (Phase 7)
- **CSP `style-src 'unsafe-inline'` (accepted risk).** The CloudFront CSP
  (`infra/security_headers.tf`) is strict on scripts: the header's
  `script-src 'self' 'unsafe-inline'` is narrowed by SvelteKit's per-build
  `<meta>` CSP to `'self'` plus the hash of its one inline bootstrap script,
  and the frontend deploy refuses a build without that meta policy
  (`infra/scripts/check-csp.mjs`). This needs `kit.csp.mode = 'hash'` in
  `frontend/svelte.config.js`. Styles keep `'unsafe-inline'`, because Svelte
  templates and uPlot set inline `style` attributes. CSS injection can't run
  script; Svelte's escaping and the ban on `{@html}` with user data remain the
  first XSS defence.
- Registration is open to anyone who can reach the site. Registering grants no
  access to existing projects, but decide with the client whether sign-up
  should be invite-only (plan question 11).
- POPIA: privacy notice, data export and account deletion. (Phase 7)

## Incident playbook

1. **Suspected secret leak:** rotate the secret at its source.
   `AUTH_JWT_SECRET` rotation logs every user out. DB passwords: `ALTER ROLE`
   and update the secret. Then update `infra-secrets/water-management/prod.sops.yaml` and
   `terraform apply`. The operator runs these steps by hand.
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
