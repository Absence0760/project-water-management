# Security

The security model for the water-management app. The data it holds is
catchment configuration and farm-level water use for named farms. It is not
financial data, but it is commercially sensitive to the client and may be
personal information under POPIA (see [plan.md questions](./plan.md#questions-for-the-client)).

## Authentication

- **Accounts:** email + password. Passwords are hashed with **bcrypt**
  (`bcryptjs`, cost 12) and are 8–200 characters. Emails are `citext`, so
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
  laptop or a suspected copied cookie). Plain logout clears the cookie only
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
  many addresses.

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

## Authorization: per-project roles enforced by Postgres RLS

Full detail is in [data-model.md § Access control](./data-model.md#access-control).
In short:

- Roles are **viewer < editor < owner**, per project. A team grants one of
  them on every team project: team **viewer → viewer**, **member → editor**,
  **admin → owner** (`app_project_role()`, 008_team_viewer). The mapping is
  explicit and an unrecognised team role grants nothing, in SQL
  (`app_project_role`), the API (`hasTeamRole`) and the UI, so a role added
  later can't silently become an editor.
- The backend connects as **`water_app`**: no superuser, no `BYPASSRLS`, owns
  no tables. Each request that touches project data runs in a transaction that
  sets `app.current_user_id` (transaction-local), and RLS policies on every
  project table check membership and role. A bug that forgets a `WHERE
  project_id = …` therefore returns nothing rather than someone else's data.
- A project you are not a member of returns **404**, never 403, so project
  existence doesn't leak.
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
- The schema owner (`water`) is used only for migrations, never by the running
  API.
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
  tighter than and ahead of Lambda's 6 MB payload limit in production.
- Uploaded workbooks are parsed **offline** by the Python importer in V1, so the
  server never parses `.xlsm` files and no macro content is ever executed.
  The in-browser importer and the `.xlsx` export use SheetJS CE 0.20.3,
  pinned in `frontend/package.json` to its official CDN tarball with the
  integrity hash in `pnpm-lock.yaml`. Do not use the stale npm `xlsx` 0.18.5,
  which has known advisories. Dependabot and `pnpm audit` don't track a URL
  dependency, so check the SheetJS release notes and bump it by hand.
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
  comments, commit messages or docs examples.
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
  migrate Lambdas' security groups can reach it.
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

## Known gaps (tracked in [plan.md](./plan.md))

- No app-level rate limit on `/auth/register` beyond the WAF's per-IP
  `/api/auth/*` rule. (Phase 7)
- No password change while signed in (use "Forgot password"). (Phase 7)
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
- No audit log of model changes yet. (Phase 3)
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
