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
- **Logout** clears the cookie. There is no server-side session list yet, so a
  stolen token stays valid until it expires. Rotating `AUTH_JWT_SECRET` logs
  everyone out. Adding a server-side session version or revocation is a
  Phase 7 item.
- Login returns the same error for an unknown email and a wrong password.

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

- No rate limiting specifically on `/auth/login` and `/auth/register` beyond
  the WAF's per-IP rule. There is no account lockout. (Phase 7)
- No password reset or email verification: both need SES. (Phase 7)
- No server-side session revocation. (Phase 7)
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
