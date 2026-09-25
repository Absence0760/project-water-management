# Deployment

> **Status:** not deployed yet. V1 runs locally ([run-locally.md](./run-locally.md)).
> This page describes the target setup and the steps to get there. The
> Terraform (VPC, RDS, both Lambdas, SES, CloudFront + WAF + security headers,
> alarms) is written and tested plan-only; nothing is applied. What is left is
> operator work (account, region, secrets, apply, SES sandbox exit, the
> `production` environment's reviewer), tracked in
> [plan.md Phase 6](./plan.md#phase-6-deploy-to-aws). The release pipelines
> are live: a release refuses to deploy, with a pointer to the missing step,
> until that work is done ([§ Releasing](#releasing)).

## Target setup

```
browser ──HTTPS──► CloudFront (+ WAF rate limit) ── water-management.jaredhoward.com
                     ├─ /*      → S3 (private, OAC)       static SvelteKit build
                     └─ /api/*  → Lambda Function URL      Hono backend
                                   (+ X-CloudFront-Shared-Secret header,
                                    CachingDisabled, all methods, cookies forwarded)
                                        │
                                        ├─► RDS PostgreSQL 17 (private subnets; migrate Lambda applies migrations)
                                        └─► SES API via VPC endpoint (verification / reset / invite email)
```

- **One origin.** The browser only ever talks to the site's domain. CloudFront
  forwards `/api/*` to the **Lambda Function URL** (there is no API Gateway),
  and the frontend's production `PUBLIC_API_URL` is `/api`. The session cookie
  is therefore first-party. The backend rejects requests that lack the
  CloudFront shared-secret header, so calling the Function URL directly does
  nothing.
- **Database:** RDS PostgreSQL 17 (`db.t4g.micro`) in private subnets. It is
  encrypted and has automated backups + PITR and deletion protection. The API
  Lambda runs in the VPC, and a migrate Lambda applies `backend/migrations`
  ([plan.md 6b](./plan.md#6b-terraform-additions-infra),
  [infra/README.md](../infra/README.md)). The backend connects as `water_app` (RLS-bound);
  migrations run as the owner role.
- **Region:** the operator's choice (`aws_region` has no default). The
  recommendation is `af-south-1` for everything regional, SES included; see
  [Region recommendation](#region-recommendation). The CloudFront certificate
  and WAF always live in `us-east-1`.
- **Response headers:** CloudFront adds a strict CSP, HSTS, nosniff,
  `frame-ancestors 'none'` / `X-Frame-Options: DENY` and a Referrer-Policy to
  every response ([infra/README.md § Smaller calls](../infra/README.md#smaller-calls)).

## Region recommendation

**Recommendation: `af-south-1` (Cape Town) for the VPC, RDS, both Lambdas,
the frontend bucket and SES.** This is advice; `aws_region` stays unset and
the operator decides, ideally after the client answers plan question 15
(may the data leave South Africa?).

What was checked (September 2026):

- **SES is available in af-south-1** for sending through the API
  (`email.af-south-1.amazonaws.com`), with Easy DKIM (regional DKIM domain
  `dkim.af-south-1.amazonses.com`), the custom MAIL FROM feedback endpoint
  (`feedback-smtp.af-south-1.amazonses.com`) and email receiving. The **SMTP
  interface is not** offered there, which doesn't matter: the backend uses the
  SES v2 API with the Lambda's IAM role, never SMTP.
  ([AWS General Reference: SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html))
- **The SES API can be reached from a VPC without a NAT.** Since December 2025
  SES offers interface VPC endpoints for its API (not only SMTP) in every
  region where SES exists
  ([What's New, Dec 2025](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-ses-vpc-api-endpoints);
  [SES Developer Guide: VPC endpoints](https://docs.aws.amazon.com/ses/latest/dg/send-email-set-up-vpc-endpoints.html)).
  So SES can sit in the same region as the Lambda, and `SES_REGION` stays
  unset. (Operator step 4a in infra/README.md confirms the endpoint service
  in the account before the first plan.)
- **POPIA does not strictly require data to stay in South Africa.** Section 72
  allows a transfer abroad when the recipient is bound by law, binding
  corporate rules or an agreement giving an "adequate level of protection"
  (for AWS, its DPA), or with the data subject's consent or for a contract;
  special personal information needs more
  ([POPIA s72](https://popia.co.za/section-72-transfers-of-personal-information-outside-republic/);
  [Michalsons on s72](https://www.michalsons.com/focus-areas/privacy-and-data-protection/transfers-of-personal-information-outside-south-africa)).
  So eu-west-1 is *legally possible*, but it adds a cross-border transfer to
  the privacy notice and sub-processor list and has to be justified; keeping
  the data in af-south-1 removes that question entirely, and the client may
  simply require it (plan question 15).
- **Latency.** Users are in South Africa. Cape Town is roughly 20–50 ms from
  most of the country versus ~150–200 ms to Ireland. Static files come from
  CloudFront edges either way (Terraform uses **PriceClass_All**, the only
  class with South African edge locations per AWS's pay-as-you-go price-class
  table),
  but every API call and model run goes to the region.

| | af-south-1 (recommended) | eu-west-1 (Ireland) | us-east-1 |
| --- | --- | --- | --- |
| POPIA | No cross-border transfer | s72 transfer: justify, disclose | s72 transfer: justify, disclose |
| API latency from SA | ~20–50 ms | ~150–200 ms | ~230+ ms |
| SES API + VPC endpoint | Yes (no SMTP; not needed) | Yes | Yes |
| Opt-in region | Yes: enable first (operator step 2) | No | No |
| Idle cost (infra/README.md § Cost) | ≈ $48–52/month | ≈ $41–43/month | ≈ $40/month |
| SES sending reputation | Separate per region; a new account starts in the sandbox anywhere | same | same |

Tradeoffs of af-south-1 to accept: ~25–35% higher prices on RDS, endpoints
and storage (raise `budget_monthly_usd` to ~70), the opt-in step, and a
somewhat smaller service catalogue (everything this stack uses is there).
Choose eu-west-1 only if the client explicitly accepts the transfer and the
~$8/month saving matters more than latency.

Whatever the region, SES follows `aws_region` in Terraform: the DKIM target
domain, the MAIL FROM MX and the VPC endpoint name are derived from it and
covered by the Terraform tests.

## Prerequisites

- The AWS org and SSO set up as for the other estate projects (`aws sso login`).
- Terraform (via tfenv), `gh` authenticated, `sops`, `jq`.
- The templates repo at `~/github/templates` and the private
  `~/github/infra-secrets`.

## 1. Provision the account (one-time)

Create `~/github/templates/infra/bootstrap/projects/water-management.tfvars`
from `example.tfvars` (`create_subdomain = true`), then from the templates repo:

```bash
cd ~/github/templates && ./scripts/new-project-account.sh water-management --plan
cd ~/github/templates && ./scripts/new-project-account.sh water-management
```

This creates, inside the org:

- the sub-account (`water-management-prod`, or the tfvars `account_name`)
- the tfstate bucket `water-management-tfstate-<account-id>`, locked with S3
  conditional writes (`use_lockfile = true`; **no DynamoDB lock table**)
- the KMS key `alias/water-management-sops`
- the GitHub OIDC provider and the deploy role `water-management-deploy`. The trust
  policy is pinned to `repo:<owner>/<repo>:environment:production`, so only a
  job in the `production` environment (which needs the operator's approval) can
  assume it.
- the GitHub `production` environment with a required reviewer, and branch
  protection on `main`
- **DNS:** the delegated child zone **`water-management.jaredhoward.com`**
  (bootstrap tfvars `create_subdomain = true`). Its delegation stage runs as the
  `dns-parent` profile and writes the NS records into the `jaredhoward.com`
  parent zone, which lives in the `jaredhoward` account. This is the same
  pattern as `disag.jaredhoward.com`. The ACM certificate, the CloudFront alias
  and the A/AAAA records inside the child zone belong to *this* repo's
  Terraform.

Estate runbook: `~/github/project-mgmt/docs/runbooks.md`.

## 2. Secrets (one-time, then as needed)

**This repo is public.** Production secrets live **only** in the private
`Absence0760/infra-secrets` repo, at `water-management/prod.sops.yaml`,
encrypted under `alias/water-management-sops`. They are never in this repo,
encrypted or not. Terraform reads them with the `carlpett/sops` provider
(`data "sops_file"` in `infra/secrets.tf`, decrypted in memory; no plaintext
file is written), never from tfvars. The operator runs the `sops` commands by
hand.

```bash
cd ~/github/infra-secrets && ./bin/sops-init.sh --project water-management --region us-east-1
cd ~/github/infra-secrets && sops water-management/prod.sops.yaml
```

Keys this app needs:

| Key | Used for |
| --- | --- |
| `auth_jwt_secret` | Lambda env `AUTH_JWT_SECRET`: signs session cookies (≥ 32 random bytes) |
| `db_app_password` | The `water_app` role's password (RLS-bound runtime role; 24+ alphanumeric characters) |

The key list is `infra/prod.sops.yaml.example`. There is no `db_owner_password`
key: the owner/migration role always uses RDS-managed master credentials in
Secrets Manager (`manage_master_user_password`, [infra/rds.tf](../infra/rds.tf)),
read only by the migrate Lambda at run time
([infra/README.md § Decisions](../infra/README.md#decisions)).
The CloudFront shared secret is generated by Terraform
(`random_password.cloudfront_shared_secret`) and needs no manual step.

Access to decrypt is IAM (`kms:Decrypt` on the key), not repo membership.

## Email (Amazon SES)

The backend sends verification, password-reset and invitation emails
(`backend/src/mail/transport.ts`). In production it uses the **SES v2 API**
(`@aws-sdk/client-sesv2`, `SendEmail`) with the API Lambda's IAM role, so there
is no SMTP password to store. Terraform provisions all of it in
[`infra/ses.tf`](../infra/ses.tf), in the primary region (`aws_region`):

- **Domain identity** for `water-management.jaredhoward.com` with **Easy
  DKIM** (RSA 2048). The three `<token>._domainkey` CNAMEs go into the child
  Route 53 zone. Their target is `<token>.dkim.amazonses.com`, or the regional
  `<token>.dkim.<region>.amazonses.com` in af-south-1 and the other newer
  regions; Terraform picks the right one.
- **Custom MAIL FROM** `mail.water-management.jaredhoward.com`, with its MX
  (`10 feedback-smtp.<region>.amazonses.com`) and SPF TXT
  (`v=spf1 include:amazonses.com -all`), so SPF aligns for DMARC. If the MX
  ever goes missing, SES falls back to its own MAIL FROM instead of bouncing
  (DKIM still aligns).
- **DMARC** TXT `_dmarc.water-management.jaredhoward.com`:
  `v=DMARC1; p=none; rua=mailto:<dmarc_report_email>; adkim=r; aspf=r`.
  Tighten `dmarc_policy` to `quarantine` once the reports are clean
  (infra/README.md operator step 8b).
- **Configuration set** `water-management`: TLS **required** to the receiving
  server (`ses_tls_policy`; every email carries a live token), reputation
  metrics on, bounces and complaints added to the **suppression list** (so a
  bad address is never mailed twice), and every send/delivery/bounce/
  complaint/reject event counted in CloudWatch.
- **Alarms** (`alarms.tf`) on the account's `Reputation.BounceRate` > 2.5 % and
  `Reputation.ComplaintRate` > 0.05 %, half of the levels at which AWS puts an
  account under review (5 % / 0.1 %), notifying the alerts SNS topic.
- **IAM:** the API Lambda role may call `ses:SendEmail` on the identity and the
  configuration set only, with the condition
  `ses:FromAddress = no-reply@water-management.jaredhoward.com`. Nothing else.
  The migrate Lambda gets nothing.
- **Network:** the API Lambda has no route out of the VPC, so it reaches SES
  through the **SES API interface endpoint** (`com.amazonaws.<region>.email`,
  private DNS on, 443 from the API Lambda's security group only). The SDK's
  default endpoint resolves to it, so `SES_REGION` stays unset.

**Leaving the SES sandbox is manual.** A new account can send only to
verified addresses (200/day, 1/second). Request production access once the
identity shows `SUCCESS`; the exact commands are in
[infra/README.md § Operator steps](../infra/README.md#operator-steps) (step
8a). AWS reviews the request by hand, usually within a day. Until then,
verify the operator's own address to test. While in the sandbox, a send to an
unverified address fails; the backend logs it and still answers the request
(`trySendMail`), so the site works but the email doesn't arrive.

Lambda environment (set by `infra/lambda.tf`):

| Variable | Value |
| --- | --- |
| `MAIL_TRANSPORT` | `ses` (must be set: the default `log` sends nothing, and in Lambda doesn't print bodies) |
| `MAIL_FROM` | `Water Management <no-reply@water-management.jaredhoward.com>` (`mail_from_display_name`, `mail_from_local_part`) |
| `SITE_URL` | `https://water-management.jaredhoward.com` (the base of every emailed link) |
| `SES_CONFIGURATION_SET` | `water-management` |
| `SES_REGION` | unset: SES is in the Lambda's own region |
| `RUNS_KEPT_PER_PROJECT` | not set by Terraform, so the backend default (20 runs per project) applies; see [data-model.md § Run output volume](./data-model.md#time-series-storage) |

Besides the email settings, `lambda.tf` sets `DATABASE_URL` (as `water_app`,
`sslmode=verify-full`), `AUTH_JWT_SECRET`, `CLOUDFRONT_SHARED_SECRET`,
`ALLOWED_ORIGINS` (the site origin), `COOKIE_SECURE=true` and
`NODE_EXTRA_CA_CERTS` (the RDS CA bundle).

The release package (`infra/scripts/package-lambdas.sh`) bundles `nodemailer`
and `@aws-sdk/client-sesv2` into the API's `lambda.mjs` (~660 KB zipped,
~3.2 MB unzipped), so production sends mail with the lockfile's pinned SDK, not
the one the `nodejs24.x` runtime happens to ship. Both mail transports are
loaded lazily, only for the transport in use. The migrate Lambda is the
exception: it imports `@aws-sdk/client-secrets-manager` from the runtime on
purpose (`backend/src/lambda-migrate.ts`).

## 3. Terraform

The full, ordered runbook (account, region opt-in, quotas, secrets, plan,
apply, SES, first deploy) is
[infra/README.md § Operator steps](../infra/README.md#operator-steps). In
outline:

```bash
cd infra && cp backend.config.example backend.config && cp terraform.tfvars.example terraform.tfvars
```

Fill in `backend.config` (the tfstate bucket) and `terraform.tfvars`:
`domain_name = "water-management.jaredhoward.com"`, `route53_zone_id` (the child zone the
bootstrap printed), `bootstrap_slug = "water-management"`, the region, the budget
email and the DMARC report mailbox. Both files are gitignored (the estate
keeps the canonical tfvars in `infra-secrets/water-management/prod.tfvars`).

```bash
cd infra && terraform init -backend-config=backend.config && terraform plan
```

The plan fails early, by design, if the bootstrap's deploy role trust policy
is not pinned to this repo's `production` environment (a postcondition in
`oidc.tf`), or if a sops secret is malformed.

Only `terraform apply` after the plan has been reviewed and the operator has
said go. Then push the outputs to the GitHub `production` environment
variables and secrets:

```bash
~/github/templates/scripts/export-tf-vars.sh infra/
```

| GitHub variable | From |
| --- | --- |
| `AWS_REGION` | `aws_region` output |
| `FRONTEND_BUCKET` | `frontend_bucket` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id` |
| `LAMBDA_FUNCTION_NAME` | `lambda_function_name` |
| `MIGRATE_FUNCTION_NAME` | `migrate_function_name` |
| `PUBLIC_SITE_URL` | `public_site_url` |
| `CLOUDFRONT_DOMAIN_NAME` | `cloudfront_domain_name` (not read by the workflows) |
| secret `AWS_DEPLOY_ROLE_ARN` | `aws_deploy_role_arn` |
| secret `LAMBDA_FUNCTION_URL` | `lambda_function_url` (debugging only) |

`PUBLIC_API_URL` is not a GitHub variable: the build reads `/api` from the
committed `frontend/.env.production`.

### State of the Terraform before the first deploy

Written and tested (plan-only, mocked providers), **nothing applied**:

- RDS PostgreSQL 17 in private subnets, the API Lambda in the VPC (VPC
  endpoints, no NAT), and the **migrate Lambda** the deploy runs before
  publishing new code.
- Lambda runtime `nodejs24.x`, 30 s timeout, 1024 MB, reserved concurrency 10,
  with `DATABASE_URL` and `AUTH_JWT_SECRET` from sops (`carlpett/sops`,
  `secrets.tf`).
- No CORS block on the Function URL (the browser never calls it).
- SES (above), CloudFront security headers and CSP, PriceClass_All.
- Budget and alarms: Lambda errors / throttles / p95 duration, migrate errors,
  RDS CPU / CPU credits / free storage / connections / freeable memory, SES
  bounce and complaint rates, CloudFront 5xx, and a log metric filter + alarm
  on the backend's `self_check_failed` structured log line (a saved run
  failing one of the engine's own invariant checks — docs/security.md §
  Infrastructure); all to the SNS topics that email `budget_alert_email`.

Still manual (operator): everything in infra/README.md § Operator steps, in
particular the region choice and opt-in, the Lambda concurrency quota,
billing access for the budget, the SES sandbox exit, and the `production`
environment's required reviewer (the release preflight refuses to deploy
without it; see [§ Releasing](#releasing)).

## 4. CI/CD

The pipelines follow the estate standard set by `threkir` and `feohledger`.
Every workflow pins its actions to a commit SHA, grants least-privilege
`permissions:` per job, and reaches AWS only through GitHub OIDC; there are
no static AWS keys anywhere. `pnpm check:workflows` enforces those rules
(`scripts/guards/check_workflows.mjs`, plus actionlint when it is installed).

### What runs on every push to `main` and every pull request

The operator currently pushes straight to `main`, so the push run is the
complete check. PRs (Dependabot's, or anyone's) get the same run.

| Workflow / job | What it checks |
| --- | --- |
| `ci.yml` `test` | `pnpm test:scripts`, `pnpm check`, `pnpm test`, `pnpm build`, the CSP meta policy, the **bundle budget** (`pnpm check:bundle`) and `infra/scripts/package-lambdas.sh` (the packaging the backend release runs) |
| `ci.yml` `db-test` | `pnpm test:backend:db` against a Postgres 17 service container |
| `ci.yml` `e2e-build`, `e2e`, `e2e-report` | Playwright (Chromium) in 14 shards: the site is built once and shared, each shard runs `--shard=N/14` against its own Postgres, and the shards' blob reports merge into one HTML `playwright-report` ([e2e/README.md § CI](../e2e/README.md#ci-14-shards)) |
| `ci.yml` `workflow-lint` | actionlint v1.7.12, the workflow guard, and the unit tests of every guard (`pnpm test:guards`) |
| `ci.yml` `env-isolation` | committed env files point only at the local stack (`pnpm check:env`) |
| `ci.yml` `terraform` → `terraform.yml` | `bin/check-infra.sh` (fmt, validate, plan-only `terraform test` with mocked providers; no AWS credentials) + a Trivy IaC scan (advisory: HIGH/CRITICAL findings go to the Security tab, never fail the job) |
| `ci.yml` `gitleaks` → `gitleaks.yml` | secret scan; runs on docs-only diffs too |
| `ci.yml` `ci-gate` | **the one required check**: fails if any job above failed |
| `compliance-drift.yml` | only when migrations, `backend/src`, `frontend/src`, a `package.json` or the two docs change; advisory: personal-data columns, outside hosts or telemetry SDKs added without the matching `docs/data-model.md` / `docs/security.md` change (`pnpm check:compliance`) |
| `security.yml` | CodeQL (JS/TS + Actions) |
| `scorecard.yml`, `pr-mergeable.yml`, `pr-title-lint.yml`, `labeler.yml` | OpenSSF Scorecard (push to `main` only); "CI never ran on this conflicted PR"; PR title and labels (PRs only) |

Docs-only diffs (only `docs/`, `.claude/` or `*.md` files, decided by the
`changes` job) skip the heavy jobs, but `CI gate` still reports. On `main`
every commit keeps its own CI run and a later push does not cancel it,
because a release needs `CI gate` green on the exact commit it ships. After
the account exists, re-run `new-project-account.sh` so that `CI gate`
becomes a required check on `main`.

Scheduled: `audit.yml` (weekly `pnpm audit`, opens an issue),
`gitleaks-sweep.yml` (weekly full-history secret scan, opens a `secret-scan`
issue when it fails), and weekly runs of `security.yml` and `scorecard.yml`.
Also present: `claude.yml` (Claude Code on issue and PR comments) and the
Dependabot helpers (`dependabot-auto-merge.yml` for minor/patch bumps,
`dependabot-lockfile.yml` to re-sync the pnpm lockfile).

There is **no credentialed `terraform plan` in CI**. The only role CI can
assume is the deploy role, which trusts `environment:production` only and
holds deploy permissions only (`infra/oidc.tf`). A real plan would need a
reviewer approval on every infra push, the sops key and the private
infra-secrets repo. The mocked plan (`terraform test`) runs on every change;
the real plan stays an operator step
([infra/README.md § Operator steps](../infra/README.md#operator-steps), step 8).

### What each deploy does

- **Frontend deploy** checks the build before uploading
  (`infra/scripts/check-csp.mjs`): every inline script must be hashed in
  SvelteKit's `<meta>` CSP, or the deploy stops. This needs
  `kit.csp = { mode: 'hash', directives: { 'script-src': ['self'] } }` in
  `frontend/svelte.config.js`. It then uploads `_app/immutable/` with a
  one-year immutable cache and everything else (HTML, favicons, manifest,
  fonts) with a 60 s cache, and invalidates CloudFront.
- **Migrations** run in the backend deploy *before* the new Lambda code is
  published: the workflow updates and synchronously invokes the migrate
  Lambda, and stops if it fails. Migrations must stay backwards-compatible
  with the running code for that short window: add first, remove in a later
  release. After the API update, the job calls `/api/health` through
  CloudFront and fails unless it answers `{"ok":true}`.

### Releasing

Each deployable has its own release line, named `<component>@<semver>`
(the threkir convention):

| Tag | Workflow | Deploys |
| --- | --- | --- |
| `backend@X.Y.Z` | `deploy-backend.yml` | migrate Lambda (runs the migrations), then the API Lambda, then the health check |
| `web@X.Y.Z` | `deploy-frontend.yml` | the static build to S3, then a CloudFront invalidation |

**Publishing a GitHub Release is the trigger.** Pushing a tag on its own does
nothing. Step by step:

1. Push the work to `main` and wait for `CI gate` to go green on that commit
   (`gh run watch`, or the Actions tab). `/release-readiness` runs the
   go/no-go checklist.
2. Pick the version: minor for features, patch for fixes (before 1.0 a
   breaking change bumps minor). It must be newer than the last release of
   the same component.
3. If the frontend needs new API behaviour, release the backend first and
   let that deploy finish. Migrations must work with the API version still
   serving (expand/contract, CLAUDE.md rule 2).
4. Publish the release. The notes are generated from the commits since the
   previous release; edit them in the web UI if they need a summary.

   ```bash
   gh release create backend@0.2.0 --target main --title "Backend 0.2.0" --generate-notes
   gh release create web@0.2.0 --target main --title "Web 0.2.0" --generate-notes
   ```

5. The **preflight** job (`scripts/release/preflight.mjs`, no environment and
   no AWS access) refuses the release unless all of these hold. It lists
   every failure at once:
   - the tag is `<component>@X.Y.Z` and newer than every published release
     of that component;
   - the release is published, not a draft. Prereleases (`-rc.1`, or the
     prerelease box) are skipped and never reach production;
   - the tagged commit is on `main` and its `CI gate` passed (it waits up to
     30 minutes while CI is still running);
   - the `production` environment exists **and has a required reviewer**. A
     job that names a missing environment creates it unprotected, so the
     preflight fails instead;
   - every AWS variable and secret the deploy reads is set. Until the account
     is bootstrapped and `export-tf-vars.sh` has run, **every release stops
     here** with a pointer to the runbook, before anything is built.
6. **build** installs dependencies and builds the artifact. It has no
   environment and no AWS credentials, so third-party npm code never runs
   next to them.
7. **deploy** waits in `environment: production` until the operator opens
   the run and clicks **Review deployments → Approve and deploy**. Only then
   can the job get an OIDC token with the `environment:production` subject
   the deploy role trusts.
8. **attach** adds what shipped to the Release (`backend-X.Y.Z-lambda.zip`
   and `-migrate.zip`, or `web-X.Y.Z-build.zip`).

## Rollback

- **Code:** deploy the last good tag by hand. It goes through the same
  preflight (without the "newer than" rule) and the same approval:
  `gh workflow run deploy-backend.yml -f tag=backend@0.1.0`, or
  `gh workflow run deploy-frontend.yml -f tag=web@0.1.0`. The artifacts that
  shipped are also attached to each Release.
- **Database:** migrations are forward-only, so a backend rollback runs old
  API code against the current schema. That is safe only because migrations
  are expand/contract. To undo a migration, ship a new one. For data loss,
  restore to a point in time from the automated backups into a new instance
  and repoint the Lambda. Rehearse this once before go-live.

## Costs (rough, idle to light use)

CloudFront, S3, Lambda and SES sending are cents. WAF is ~$7/month. The DB is
the main cost: RDS t4g.micro at ~$14/month. The VPC Lambdas' two interface
endpoints (Secrets Manager, SES API) cost ~$7.30/month each per AZ, which is
still cheaper than a NAT (~$33/month plus data). Total ≈ $40/month in
us-east-1, ≈ $48–52 in af-south-1; the breakdown is in
[infra/README.md § Cost](../infra/README.md#cost). The Terraform budget alarm
is set from `budget_monthly_usd` (default 50; raise it to ~70 for
af-south-1).
