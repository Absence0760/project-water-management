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
  blocks cross-site POSTs from carrying the session. The API accepts JSON bodies
  only.
- **Revocation:** every request re-reads `app_user.sessions_revoked_at`;
  a session issued before it (JWT `iat_ms`, falling back to `iat`) is rejected,
  as is a session for an account that no longer exists. A password reset sets
  the watermark, so it signs out every device, including a thief's. Logout
  clears the cookie only (that one token stays valid until expiry if it was
  copied). Rotating `AUTH_JWT_SECRET` logs everyone out.
- Login returns the same error for an unknown email and a wrong password.

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
- **Known gap — adding an existing but unverified account.** `POST
  …/members` with an address that already has an account adds it directly
  (unchanged V1 behaviour), even if that account never verified the address.
  Someone who pre-registers a colleague's address could therefore be added in
  their place. Durable fix: only add verified accounts directly, and send an
  invite otherwise (needs the e2e sharing specs to verify their users first).
- **Email content:** every user-controlled value (project/team names, display
  names) is HTML-escaped; subjects are stripped of CR/LF. Links use `SITE_URL`
  from config, never the request's Host header. The reset and verify pages
  strip the token from the address bar and send `Referrer-Policy: no-referrer`.
- **Transport:** SES via the Lambda's IAM role in production (no SMTP password
  to hold). The `log` transport refuses to print message bodies inside Lambda,
  so a misconfigured deploy can't write live links into CloudWatch.

## Authorization: per-project roles enforced by Postgres RLS

Full detail is in [data-model.md § Access control](./data-model.md#access-control).
In short:

- Roles are **viewer < editor < owner**, per project.
- The backend connects as **`water_app`**: no superuser, no `BYPASSRLS`, owns
  no tables. Each request that touches project data runs in a transaction that
  sets `app.current_user_id` (transaction-local), and RLS policies on every
  project table check membership and role. A bug that forgets a `WHERE
  project_id = …` therefore returns nothing rather than someone else's data.
- A project you are not a member of returns **404**, never 403, so project
  existence doesn't leak.
- **Same-project triggers** reject references to another project's nodes or
  crops, even when the UUID is known.
- A **last-owner guard** means a project can't be orphaned.
- The schema owner (`water`) is used only for migrations, never by the running
  API.
- The DB test suite (`pnpm test:backend:db`) checks these rules as `water_app`.
  Treat a failing RLS test like a failing auth check: never skip it.

## Input handling

- Every request body is validated with **zod** before it reaches SQL. Queries
  are parameterised (`pg`), and there is no string-built SQL.
- Model documents are validated as a whole: references resolve inside the
  document, the network is a tree with one outflow, and names are unique.
- Series are capped at 60 000 values. The Lambda's 6 MB payload limit bounds
  request size in production.
- Uploaded workbooks are parsed **offline** by the Python importer in V1, so the
  server never parses `.xlsm` files and no macro content is ever executed.
  The later in-browser importer parses in the user's browser with SheetJS from
  its official CDN tarball. Do not use the stale npm `xlsx` 0.18.5, which has
  known advisories.
- Svelte escapes output by default. Don't use `{@html}` with user-supplied names
  (farms, crops, projects).

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
- **No client data.** Workbooks (`Original/`, `AI/`, `*.xlsm`, `*.xlsx`) and
  everything extracted from them (`data/`) are gitignored. Committed test
  fixtures are **synthetic**: made-up farm names, made-up numbers. Never paste
  real farm names, owners, dam sizes or series into fixtures, test names, code
  comments, commit messages or docs examples.
- **Local defaults only.** The committed `.env.development` files hold throwaway
  docker credentials and a dev-only JWT secret. That is safe because they grant
  nothing outside a local container.
- **gitleaks** runs as a pre-commit hook (`pre-commit install`, never
  `--no-verify`) and in CI. Before pushing a branch, check the diff for client
  names as well as for keys.
- If something slips in: **don't push**. Rewrite the history locally, then tell
  the operator (see the incident playbook below).

## Secrets management

- **Production secrets live outside this repo**, in
  `infra-secrets/water-management/prod.sops.yaml`, SOPS-encrypted under
  `alias/water-management-sops`. Decryption is gated by IAM (`kms:Decrypt`) and
  logged in CloudTrail. The key rotates yearly. Terraform's `carlpett/sops`
  provider decrypts in memory, so nothing is written to disk.
  See `../infra-secrets/README.md`.
- This app's production secrets: `AUTH_JWT_SECRET`, the `water_app` DB
  password, and the owner/migration DB password (or an RDS-managed secret). The
  CloudFront shared secret is generated by Terraform.
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
- **WAF:** a per-IP rate limit on CloudFront, covering both the site and
  `/api/*`.
- **Database (Phase 6):** private subnets or the Data API only, no public
  endpoint, encryption at rest, TLS in transit, automated backups + PITR,
  deletion protection.
- **Blast radius:** Lambda reserved concurrency is capped. There is a budget
  alarm, plus alarms on Lambda errors, throttles and CloudFront 5xx.

## Known gaps (tracked in [plan.md](./plan.md))

- No rate limiting specifically on `/auth/register` beyond the WAF's per-IP
  rule. (Phase 7)
- No self-service "sign out everywhere" or password change while signed in;
  the `sessions_revoked_at` watermark is only set by a password reset. (Phase 7)
- Adding an existing but unverified account to a project or team (see
  "Password reset, email verification and invites" above).
- No per-account login lockout yet. (Phase 7)
- **CSP `'unsafe-inline'` (accepted risk).** The planned Content-Security-Policy
  allows inline scripts, because SvelteKit's static build emits an inline
  bootstrap script. Svelte's default escaping and the ban on `{@html}` with
  user data are the main XSS defence. Move to hash-based CSP when practical.
  (Phase 7)
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
