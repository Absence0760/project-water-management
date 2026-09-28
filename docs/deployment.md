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
                                        ├─► SES API via VPC endpoint (verification / reset / invite email)
                                        └─► SQS `jobs` via VPC endpoint (job wake-ups)
                                                 │
EventBridge rate(5 minutes) ──────────────► worker Lambda ──► RDS (as water_app, RLS)
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
- **Background jobs:** the worker Lambda runs the job queue (§ Background
  jobs below).
- **Region:** the operator's choice (`aws_region` has no default). The
  recommendation is `af-south-1` for everything regional, SES included; see
  [Region recommendation](#region-recommendation). The CloudFront certificate
  and WAF always live in `us-east-1`.
- **Response headers:** CloudFront adds a strict CSP, HSTS, nosniff,
  `frame-ancestors 'none'` / `X-Frame-Options: DENY` and a Referrer-Policy to
  every response ([infra/README.md § Smaller calls](../infra/README.md#smaller-calls)).

## Region recommendation

**Decided (2026-09-26): `af-south-1` (Cape Town) for the VPC, RDS, the
Lambdas, the frontend bucket and SES, on the minimal tier, while the users
are South African.** `aws_region` still has no default in Terraform; set it
in tfvars. The decision holds whatever the client answers to plan question
15, and a future country gets its own stack in its own region
([deployment-tiers.md § Where the data lives](./deployment-tiers.md#where-the-data-lives)).
The reasoning below is why.

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
| Idle cost (infra/README.md § Cost) | ≈ $59–64/month | ≈ $51–53/month | ≈ $50/month |
| SES sending reputation | Separate per region; a new account starts in the sandbox anywhere | same | same |

Tradeoffs of af-south-1 to accept: ~25–35% higher prices on RDS, endpoints
and storage (raise `budget_monthly_usd` to ~80), the opt-in step, and a
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
| `auth_jwt_secret` | Lambda env `AUTH_JWT_SECRET` (API and worker): signs session cookies, and keys the run stamps (security.md § Run stamps; rotating it leaves stored runs unverified) (≥ 32 random bytes) |
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
- **IAM:** the API and worker Lambda roles may call `ses:SendEmail` on this
  account's SES identities in its own region (`identity/*`) and the
  configuration set only, with the condition
  `ses:FromAddress = no-reply@water-management.jaredhoward.com`. Nothing else.
  The wildcard is for the sandbox, which also authorises each send against the
  **recipient's** verified identity (`identity/<address>`): naming only the
  domain identity denies every sandbox send, the operator's own test
  included. The From condition still pins the sender, and out of the sandbox
  no recipient identity is checked. The migrate Lambda gets nothing.
- **Network:** the API Lambda has no route out of the VPC, so it reaches SES
  through the **SES API interface endpoint** (`com.amazonaws.<region>.email`,
  private DNS on, 443 from the API Lambda's security group only). The SDK's
  default endpoint resolves to it, so `SES_REGION` stays unset.

**Leaving the SES sandbox is manual.** A new account can send only to
verified addresses (200/day, 1/second). Request production access once the
identity shows `SUCCESS`; the exact commands are in
[infra/README.md § Operator steps](../infra/README.md#operator-steps) (step
8a). AWS reviews the request by hand, usually within a day. Until then,
verify the operator's own address to test: a send to a verified address goes
through (the IAM policy above allows the recipient's identity). While in the
sandbox, a send to an unverified address fails with `MessageRejected`; the
backend still answers the request (`trySendMail`: a mail error never changes
the response, so it can't reveal whether an account exists), so the site works
but the email doesn't arrive. It is not silent: `trySendMail` logs one line,
`{"event":"mail_send_failed","kind":"reset","error":"MessageRejected","status":400}`
(the template's kind and the SES error code, never the address, the subject or
SES's error text, which names the recipient), and the `mail-send-failed` alarm
emails the alerts topic on the first one. Expect it to fire while you test in
the sandbox; after production access it means real mail is failing. To find
which: CloudWatch Logs Insights on the API and worker log groups,
`filter event = "mail_send_failed" | stats count() by kind, error`.
`AccessDeniedException` means the IAM policy, `MessageRejected` an unverified
recipient (sandbox) or a suppressed one, `TooManyRequestsException` the
sending rate.

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
and `@aws-sdk/client-sesv2` into the API's `lambda.mjs` (~670 KB zipped,
~2.1 MB unzipped, minified: [§ Lambda bundles](#lambda-bundles)), so production sends mail with the lockfile's pinned SDK, not
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
said go. Then push the outputs to the repository's GitHub Actions variables
and secrets:

```bash
~/github/templates/scripts/export-tf-vars.sh infra/
```

They are **repository-level** values (`gh variable set` / `gh secret set`
with no `--env`), not `production` environment values. The release
preflight job runs without an environment, before the approval, and only
sees repository-level values, so a value set only on the `production`
environment leaves every release failing with "not configured". The
environment's job is the required reviewer (§ 1), not storage.

| GitHub variable | From |
| --- | --- |
| `AWS_REGION` | `aws_region` output |
| `FRONTEND_BUCKET` | `frontend_bucket` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id` |
| `LAMBDA_FUNCTION_NAME` | `lambda_function_name` |
| `MIGRATE_FUNCTION_NAME` | `migrate_function_name` |
| `WORKER_FUNCTION_NAME` | `worker_function_name` (the release preflight requires it) |
| `FETCHER_FUNCTION_NAME` | `fetcher_function_name` (data feeds; the release preflight requires it) |
| `RENDERER_FUNCTION_NAME` | `renderer_function_name` (report renderer; always an output, even before the function exists, so the preflight requires it) |
| `RENDERER_ECR_REPOSITORY` | `renderer_ecr_repository` (the renderer image's ECR repository; the release preflight requires it) |
| `PUBLIC_SITE_URL` | `public_site_url` |
| `CLOUDFRONT_DOMAIN_NAME` | `cloudfront_domain_name` (not read by the workflows) |
| secret `AWS_DEPLOY_ROLE_ARN` | `aws_deploy_role_arn` |
| secret `LAMBDA_FUNCTION_URL` | `lambda_function_url` (debugging only) |

`PUBLIC_API_URL` is not a GitHub variable: the build reads `/api` from the
committed `frontend/.env.production`.

`PUBLIC_SITE_URL` also reaches the frontend build as `SITE_ORIGIN`
(`deploy-frontend.yml`): the prerendered landing page (`/welcome`, issue #57)
writes its canonical link, `og:url` and `og:image` as absolute URLs from it
(`kit.prerender.origin`, `frontend/svelte.config.js`). CloudFront serves
`/welcome` from `welcome.html` (`spa_rewrite`).

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
- Background jobs (`jobs.tf`, § Background jobs below): the SQS `jobs`
  queue + DLQ, the worker Lambda, its 5-minute EventBridge tick and the SQS
  interface endpoint.
- Budget and alarms: Lambda errors / throttles / p95 duration, migrate errors,
  RDS CPU / CPU credits / free storage / connections / freeable memory, SES
  bounce and complaint rates, CloudFront 5xx, a log metric filter + alarm
  on the backend's `self_check_failed` structured log line in both the API's
  and the worker's log group (a saved run failing one of the engine's own
  invariant checks — docs/security.md § Infrastructure), one on
  `mail_send_failed` in the same two log groups (an account, invitation or
  report email that failed to send, § Email), one on `unhandled_error` in
  the API's log group (a request answered with an unhandled 500, which the
  Lambda `Errors` metric can't see, § Runbooks), and the job queue's five (DLQ depth, worker errors and
  throttles, backlog, dead jobs); all to the SNS topics that email `budget_alert_email`. That variable is
  required: plan refuses an empty, malformed or reserved address
  (example.com/.org/.net, `.example`, `.test`, `.invalid`, `.localhost`, any
  case), so a copied example tfvars can't leave the alarms paging nobody
  (`dmarc_report_email`, when set, gets the same check).

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

Every change reaches `main` through a pull request (`main` is protected: PRs
only, admins included), so each PR gets the full run before it merges, and the
push run on `main` checks the merged result. Dependabot's PRs get the same run.

| Workflow / job | What it checks |
| --- | --- |
| `ci.yml` `test` | `pnpm test:scripts`, `pnpm check`, `pnpm test`, `pnpm build`, the CSP meta policy, the **bundle budget** (`pnpm check:bundle`) and `infra/scripts/package-lambdas.sh` (the packaging the backend release runs) |
| `ci.yml` `db-test` | `pnpm test:backend:db` against a Postgres 17 service container |
| `ci.yml` `e2e-build`, `e2e`, `e2e-report` | Playwright (Chromium) in 14 shards: the site is built once and shared, each shard runs `--shard=N/14` against its own Postgres, and the shards' blob reports merge into one HTML `playwright-report` ([e2e/README.md § CI](../e2e/README.md#ci-14-shards)) |
| `ci.yml` `workflow-lint` | actionlint v1.7.12, the workflow guard, and the unit tests of every guard (`pnpm test:guards`) |
| `ci.yml` `renderer-image` | `bin/check-renderer-image.sh`: the release's own `docker buildx build` of the renderer image (one `linux/amd64` manifest, no attestations, which Lambda requires), then the Lambda smoke test, so a broken Dockerfile fails here and not at release |
| `ci.yml` `env-isolation` | committed env files point only at the local stack (`pnpm check:env`) |
| `ci.yml` `terraform` → `terraform.yml` | `bin/check-infra.sh` (fmt, validate, plan-only `terraform test` with mocked providers; no AWS credentials) + a Trivy config scan of Terraform and the renderer Dockerfile (advisory: HIGH/CRITICAL findings go to the Security tab, never fail the job; accepted ones in [security.md § Accepted IaC findings](./security.md#accepted-iac-findings)) |
| `ci.yml` `gitleaks` → `gitleaks.yml` | secret scan; runs on docs-only diffs too |
| `ci.yml` `ci-gate` | **the one required check**: fails if any job above failed |
| `compliance-drift.yml` | only when migrations, `backend/src`, `frontend/src`, a `package.json` or the two docs change; advisory: personal-data columns, outside hosts or telemetry SDKs added without the matching `docs/data-model.md` / `docs/security.md` change (`pnpm check:compliance`) |
| `security.yml` | CodeQL (JS/TS + Actions) |
| `scorecard.yml`, `pr-mergeable.yml`, `pr-title-lint.yml`, `labeler.yml` | OpenSSF Scorecard (push to `main` only); "CI never ran on this conflicted PR"; PR title and labels (PRs only) |

Docs-only **pull requests** (only `docs/`, `.claude/` or `*.md` files,
decided by the `changes` job) skip the heavy jobs, but `CI gate` still
reports. A **push to `main`** always runs every job, whatever it changed: a
release needs `CI gate` green on the exact commit it ships, and a docs-only
commit on top of a failing code commit must not turn that gate green without
the code having passed (the workflow guard's `push-full` rule holds the
`changes` job to this). On `main` every commit keeps its own CI run and a
later push does not cancel it. After
the account exists, re-run `new-project-account.sh` so that `CI gate`
becomes a required check on `main`.

Scheduled: `audit.yml` (weekly `pnpm audit` against the lockfile, with no
install and no cache; opens an issue),
`gitleaks-sweep.yml` (weekly full-history secret scan, opens a `secret-scan`
issue when it fails), and weekly runs of `security.yml` and `scorecard.yml`.
Also present: `claude.yml` (Claude Code on issue and PR comments, for the
operator only; the model may edit files and read git and GitHub, but runs no
`pnpm` command, so it can't execute code it wrote, and its checkout keeps no
token) and the Dependabot helpers (`dependabot-auto-merge.yml`,
`dependabot-lockfile.yml` to re-sync the pnpm lockfile).

**Dependency updates wait a week and actions wait for a human.**
`.github/dependabot.yml` gives every ecosystem a 7-day `cooldown`
(security updates are exempt), and `pnpm-workspace.yaml` sets
`minimumReleaseAge: 10080` (7 days, pnpm >= 10.16), so pnpm refuses to
resolve a registry version younger than that. `dependabot-auto-merge.yml`
approves and queues minor and patch bumps for npm, pip, docker-compose and
Terraform only, gated on the PR's author being Dependabot. GitHub Actions
bumps are never auto-merged: an action runs inside the deploy job while it
holds the AWS session, so a person reads what the new SHA pin points at. A
security fix that can't wait the week goes under
`minimumReleaseAgeExclude` with a comment, removed once the week is up.

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
  release. The worker Lambda's code is updated right after the API's, and
  the fetcher's after the worker's. Then the renderer's image (built in the
  `build` job, no AWS credentials) is pushed to ECR and the renderer Lambda
  moved to it; until the operator has created the function (§ Reports) the
  step pushes the image and says what to do, and any other `get-function`
  error fails the deploy. Then the job calls `/api/health` through
  CloudFront and fails unless it answers `{"ok":true}`.
- **Release builds install cold**: no dependency cache is restored in either
  deploy workflow (the workflow guard's `no-cache` rule), since a cache is
  written by other runs and the build ships with deploy credentials.

### A failed migration

The deploy log is public (the repo is), so the *Run migrations* step prints
only names and codes, never the error: the code (`integrity`,
`migration_failed`, `lock_timeout`, `statement_timeout`, or `setup_failed`
for anything around the migrations, such as reading the master secret,
connecting or syncing `water_app`), the file it stopped on, what that run had
applied and what is still pending, and the CloudWatch log group
(`/aws/lambda/<migrate function>`), stream and request id. The error itself,
Postgres's text included, is in that CloudWatch stream, logged as
`migrate failed:`; read it there (the AWS console, or
`aws logs tail /aws/lambda/<migrate function> --since 1h --profile <project profile>`).
A timeout or crash prints `unknown` for everything but the log group. The
step never invokes with `--log-type Tail`, and the workflow guard
(`pnpm check:workflows`, rule `no-tail`) refuses any workflow that does or
reads `LogResult`. The payload itself carries the summary alone
(`MigrateFailure` in `backend/src/lambda-migrate.ts`), and the step prints a
field only if it has the shape it should (a `NNN_name.sql`, a lowercase code,
a log stream name).

### Migration integrity

The migrate Lambda refuses to apply anything, and the deploy stops before
the new code ships, when `schema_migrations` disagrees with the migrations in
the release ([data-model.md § Migrations](./data-model.md#migrations)). The
deploy log shows code `integrity` and the files; its error, in CloudWatch
(§ A failed migration), names each file:

- **"… was applied but its contents have changed"**: someone edited a
  migration production already ran. The database is fine; the release is
  wrong. Put the file back as it was on the tag that applied it
  (`git show backend@X.Y.Z:backend/migrations/<file>`), move the change into
  a new `NNN_*.sql`, and cut a new release. Never update the checksum in the
  database to make the error go away: the change would never reach the
  schema, and every environment would differ from the files.
- **"… was applied but its file is missing"**: a migration was deleted or
  renamed. Restore it under its original name.
- **"… is pending but sorts before …"**: two branches took migration
  numbers out of order, and the one merged later has the lower number.
  Renumber it after the latest applied file and release again.

Each migration also runs with `lock_timeout = 5s` and
`statement_timeout = 240s`. A deploy failing with *lock timeout* means live
traffic held a lock the migration needed: nothing was applied (the file's
transaction rolled back), so re-run the deploy at a quieter time. A
*statement timeout* means the migration is too slow for a deploy: split it,
or give it a `-- migrate: statement_timeout = …` line and raise the migrate
Lambda's `timeout` (`infra/lambda.tf`) to match.

### Lambda bundles

`infra/scripts/package-lambdas.sh` builds every Lambda bundle with esbuild's
`--minify --keep-names --sourcemap` (and `pnpm build:backend` builds the API's
the same way). Minifying roughly halves each bundle (most of it is zod 4 and
the AWS SDK), so a cold start parses less JavaScript; `--keep-names` keeps
function and class names, so a production stack trace still says *which*
function threw, though its line and column point into one long minified line.

| Bundle | Raw before → after | Zip before → after |
|---|---|---|
| API `lambda.mjs` | 4.14 MB → 2.13 MB | 866 KB → 681 KB |
| worker `lambda-worker.mjs` | 3.64 MB → 1.83 MB | 736 KB → 579 KB |
| fetcher `lambda-fetcher.mjs` | 2.03 MB → 0.99 MB | 343 KB → 256 KB |
| renderer `lambda-renderer.mjs` (image; gzip) | 2.33 MB → 1.16 MB | 390 KB → 296 KB |
| migrate `lambda-migrate.mjs` | 202 KB → 99 KB | 191 KB → 180 KB (mostly SQL) |

**Source maps are not shipped.** The `.map` files land in
`backend/dist/sourcemaps/`, and `deploy-backend.yml` uploads them as the
`backend-sourcemaps` artifact (30 days). They stay out of the zips and the
renderer image, and the Lambdas don't set `NODE_OPTIONS=--enable-source-maps`,
because a map with its sources is 3–4× the minified bundle (the API zip would
grow from ~0.7 MB to ~2.3 MB) and, measured locally, `--enable-source-maps`
added 30–55 ms to the bundle's import, paid on every cold start. To read a
production trace, download the artifact for that release, put the map beside
the bundle from the same release's zip, and run or import it under
`node --enable-source-maps` (each bundle ends in a `sourceMappingURL` comment
that finds the map beside it), or feed the minified line:column to any source-map tool.

The dependency guards at the end of the script (no dotenv, no playwright-core
in the API/worker/fetcher, no `pg` in the fetcher/renderer) read esbuild's
`--metafile`, not the bundle text: minifying drops the `// node_modules/…`
comments the old greps matched, which would have made the `pg` check pass
silently. The rules live in `scripts/guards/check_lambda_bundle.mjs` (tests:
`pnpm test:guards`). A bundled package shows as an *input*; an
`--external` one never does, only as an import left in the *output*
(`outputs[…].imports`, with its `kind`). playwright-core is external in
every bundle, so the guard reads the output imports and refuses any import
of it but a `dynamic-import`: the lazy `await import('playwright-core')` in
`src/reports/render.ts`, which the API and worker bundles reach and which runs
only where the package is installed. A static import would crash the Lambda
at load (issue #126: the first version checked only the inputs, so it could
never fire). Each guard first checks the metafile names the bundle's entry
point and an output, so a missing or reshaped metafile fails the build.

### Releasing

Each deployable has its own release line, named `<component>@<semver>`
(the threkir convention):

| Tag | Workflow | Deploys |
| --- | --- | --- |
| `backend@X.Y.Z` | `deploy-backend.yml` | migrate Lambda (runs the migrations), then the API, worker and fetcher Lambdas, then the renderer's image (pushed to ECR; the renderer moved to it once it exists), then the health check |
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
   - every AWS variable and secret the deploy reads is set (the backend's
     include `RENDERER_FUNCTION_NAME` and `RENDERER_ECR_REPOSITORY`, from
     `export-tf-vars.sh`). Until the account
     is bootstrapped and `export-tf-vars.sh` has run, **every release stops
     here** with a pointer to the runbook, before anything is built.
6. **build** installs dependencies and builds the artifact. It has no
   environment and no AWS credentials, so third-party npm code never runs
   next to them.
7. **deploy** waits in `environment: production` until the operator opens
   the run and clicks **Review deployments → Approve and deploy**. Only then
   can the job get an OIDC token with the `environment:production` subject
   the deploy role trusts.
8. **attach** adds what shipped to the Release (`backend-X.Y.Z-lambda.zip`,
   `-migrate.zip`, `-worker.zip` and `-fetcher.zip`, or
   `web-X.Y.Z-build.zip`). The renderer image is not attached: it stays in
   ECR, tagged with the version.

## Getting a catchment into production

Production has no database access path: `pnpm import:project` and
`pnpm seed:examples` write to a database directly, so they only work locally.
A catchment reaches production through the app instead
([api.md § Import a project file](./api.md#import-a-project-file)):

1. Either import the b023 workbook itself: sign in to production, choose
   **Import b023 workbook** on the project list and pick the `.xlsm`. It is
   read in the browser (only the project is sent), and the review shows the
   importer's notes and the unmapped report ([ui.md](./ui.md#import-a-b023-workbook)).
2. Or, locally, extract the workbook (`scripts/wbt-import/extract_project.py`,
   [run-locally.md](./run-locally.md)) or build and check the project in the
   local app and download it (**Download project (JSON)** on its Overview),
   then choose **Import project file (.json)** in production. Pick the file,
   check the preview (name, team, node and series counts) and import it,
   optionally with a first run.

The import runs as the signed-in user under RLS, in one transaction, so a
failed import leaves nothing behind. The file is at most 5 MB (a multi-decade
catchment is well under 1 MB). Client files stay out of the repo: take them from
`data/` (gitignored) or the private source repo, never from a commit.

## Background jobs

The job queue ([architecture.md § Background work](./architecture.md#background-work))
runs in production as `JOB_TRANSPORT=sqs` (infra/jobs.tf, Terraform
plan-only until the first deploy):

- **The `job` table stays the source of truth.** SQS carries only wake-ups
  (`{ v: 1, type: "wake", jobId }`, never a payload): after queueing a job the
  API sends one to the `jobs` queue, whose event source triggers the worker
  Lambda. An **EventBridge rule ticks the worker every 5 minutes** as well,
  which runs retries whose backoff has passed and anything whose wake-up was
  lost, so a failed `SendMessage` (logged, never an error to the user) delays
  a job by at most one tick. A tick is never retried: the EventBridge target
  and the worker's async invoke config both allow 0 retries and a maximum
  event age of 300 s, so a tick that can't be delivered or is throttled is
  dropped (counted by `worker-tick-failed` or `worker-throttles`) instead of
  queueing for up to 24 hours (EventBridge's default) or 6 hours (Lambda's)
  and piling stale ticks onto a struggling worker; the next tick recovers.
- **Worker Lambda** (`backend/src/lambda-worker.ts`, handler
  `lambda-worker.handler`): in the private VPC, 1024 MB, 300 s, reserved
  concurrency 8 (`worker_reserved_concurrency`: at least the sum of its four
  SQS triggers' `maximum_concurrency`, 4 × 2, or throttled pollers burn
  receive counts into the DLQs), connecting as `water_app` (pool of 2) with
  verified TLS.
  Each invocation runs one tick within its remaining time (less a minute);
  jobs lease for 6 minutes, longer than the function can run.
- **Network:** one SQS interface endpoint (private DNS, `sqs_endpoint_az_count`
  default 1) whose policy lets only the API role send to, and the worker role
  use, the `jobs` queue. No NAT.
- **Retries and the DLQ:** a job's own failure is recorded in the table (with
  backoff, then `dead`), not thrown, so it never redelivers a message. The
  worker's SQS triggers report partial batch failures
  (`ReportBatchItemFailures`): a record that throws while being queued (a
  database error) is retried alone, and the rest of its batch is done with; a
  record that can never succeed (an unknown message, a result for an unknown
  fetch or report) is logged and dropped. When every record in a batch
  throws, or the tick itself fails (the database unreachable), the whole
  batch fails; SQS retries it, and after 5 receives it lands in the
  `jobs-dlq` (14 days' retention).
  The jobs are still in the table and run on the next good tick; inspect the
  worker's logs, then redrive or purge the DLQ.
- **Alarms** (to the alerts SNS topic): DLQ depth > 0; worker errors > 0;
  worker throttles > 0 (it hit its reserved concurrency);
  `worker-heartbeat`, fewer than 1 worker invocation in 15 minutes (three
  ticks), with missing data treated as breaching, so a worker that has
  stopped altogether (the tick rule disabled, reserved concurrency set to 0)
  alarms even though it emits no backlog metric; `worker-tick-failed`,
  EventBridge `FailedInvocations` > 0 on the tick rule (the invoke
  permission or target broken; with no retries each failed tick counts once); the oldest due job waiting longer than `jobs_backlog_alarm_seconds`
  (default 15 minutes; each tick logs `OldestDueJobAgeSeconds` as a
  CloudWatch embedded metric in `water-management/Jobs`); and any dead job
  (a metric filter on the worker's `job_dead` log line). A project with the
  `job_dead` alert on also emails its owners ([§ Alert emails](#alert-emails)).
  On a first deploy the worker is Terraform's stub, which throws on every
  tick until the first backend release: `worker-errors` fires then, but
  the heartbeat stays OK (a failed invocation still counts).
- **Cost:** a few cents of Lambda and SQS at this volume (the tick is ~8 600
  short invocations a month), plus the SQS endpoint's ~$7.30/month per AZ.

## Data feeds

The feeds ([architecture.md § Data feeds](./architecture.md#data-feeds)) run
on the job queue, with the fetching done outside the VPC (infra/feeds.tf,
plan-only until the first deploy):

- **The worker** (`FEED_FETCHER=sqs`) never fetches: a `feed_fetch` job sends
  a versioned request to the `fetch-requests` queue
  (`FETCH_REQUESTS_QUEUE_URL`) and is done.
- **Fetcher Lambda** (`backend/src/lambda-fetcher.ts`, handler
  `lambda-fetcher.handler`): **no VPC** (it is the only Lambda with internet
  access, which is what keeps the feeds from needing a NAT), 512 MB, 120 s,
  reserved concurrency `fetcher_reserved_concurrency` (2). `FEED_SOURCE=live`.
  It has no database access and no credentials to one: its role may receive
  from `fetch-requests` and send to `ingest-results`, nothing else. One
  request per invocation; a failed send is a batch-item failure, retried.
  Every request that names a fetch job is answered: a fetch still running
  15 s before the timeout, or one it can route but not run (e.g. a source
  this build doesn't know), is sent back as a failure, so the feed shows
  failing instead of the message timing out into the DLQ unrecorded.
- **`ingest-results`** triggers the worker, which checks each result answers a
  real `feed_fetch` job of that feed and queues a `feed_ingest` job as that
  job's user; the job validates the result before merging.
- **Network:** the worker reaches both queues through the existing SQS
  interface endpoint, whose policy now also admits it to `fetch-requests`
  (send) and `ingest-results` (receive), and nothing else. The API still
  reaches only `jobs`. The fetcher talks to SQS and the sources over the
  public internet.
- **Retries and DLQs:** each queue dead-letters after 5 receives into its own
  DLQ (14 days). A source that is down or answers garbage is *not* a
  retry: the fetcher sends the failure back, the feed records it and shows as
  failing, and the schedule tries again (15 minutes after one failure,
  doubling up to a day).
- **Alarms:** `fetch-requests-dlq-depth`, `ingest-results-dlq-depth` and
  `fetcher-errors` (a crash or timeout), all > 0, to the alerts topic. A
  stale or failing feed shows in the app, and emails the owners and editors
  of a project with the `data_stale` or `feed_failing` alert on.
- **Sources' terms.** CHIRPS is public domain (the Climate Hazards Center
  waived copyright; cite it). CHIRPS-GEFS comes from the same server without a
  separate licence notice: confirm before relying on it commercially (the
  roadmap's D7). DWS's terms of use for automated retrieval must be checked
  before a DWS feed is used in production, and the DWS site answers our
  (non-South-African) network with HTTP 403: confirm the fetcher's region can
  reach it ([followups.md](./followups.md)).
- **Cost (idle delta ≈ +$0.70/month):** two more queues and two DLQs cost
  nothing at rest, but each SQS event source polls continuously (~0.65 M
  receives a month each); with the `jobs` queue's that is ~1.9 M, ~0.9 M past
  the free tier, ≈ $0.40. Three alarms ≈ $0.30. The fetcher's own compute is
  cents: a daily CHIRPS feed is ~200 range requests (~5 MB) in ~5 s at 512 MB.
  No NAT, no new endpoint.

## Alert emails

The worker sends the alert emails ([architecture.md § Alert emails](./architecture.md#alert-emails),
[security.md § Alerts](./security.md#alerts)) through the same SES identity
and configuration set as every other email ([§ Email](#email-amazon-ses)).

- **Worker environment** (`infra/jobs.tf`):

  | Variable | Value |
  | --- | --- |
  | `ALERTS_TOKEN_SECRET` | `random_password.alerts_token_secret` (48 characters). Signs the one-click unsubscribe links. Only the worker has it; the API Lambda checks a link by its hash. Replacing it (`terraform apply -replace=random_password.alerts_token_secret`) breaks the unsubscribe link in every alert already sent ("Manage your alerts" still works), so rotate only if it leaked |
  | `ALERTS_ENABLED` | `var.alerts_enabled` (default `true`): **the kill switch**. `false` stops every alert email and drops those waiting; alerts are still evaluated and shown in the app |
  | `ALERTS_DAILY_CAP` | `5`: immediate alert emails per person per day (06:00 to 06:00 in the project's time zone, South Africa's by default) before the rest wait for the 06:00 digest |
  | `SITE_URL` | also the base of the RFC 8058 one-click address, `SITE_URL/api/alerts/unsubscribe` (CloudFront's `/api/*`; `API_PUBLIC_URL` overrides it, which only local dev needs) |

- **Headers.** Every alert email carries `List-Unsubscribe`,
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058: Gmail and
  Yahoo show their own unsubscribe button and post to it) and
  `Auto-Submitted: auto-generated`, sent as SESv2 `Simple` content's
  `Headers` (supported by the pinned `@aws-sdk/client-sesv2` 3.11xx; no raw
  MIME needed).
- **Alarms** (to the alerts topic): `alert-storm`, more than
  `alert_storm_mails_per_5min` (default 200) alert emails in 5 minutes; and
  `alert-mail-failures`, alert sends failing for 15 minutes. Both read the
  worker's embedded metrics (`AlertMailsSent`, `AlertMailsFailed` in
  `water-management/Jobs`).
- **SES suppression → the app** (`infra/ses.tf`, plan-only until the first
  deploy). Bounced and complaining addresses are on the configuration set's
  suppression list, so SES drops mail to them. The same set also publishes
  `BOUNCE` and `COMPLAINT` events to the SNS topic `ses-events`, which
  delivers them raw to the SQS queue `mail-events` (SSE, a DLQ after 5
  receives, the `mail-events-dlq-depth` alarm), which triggers the worker.
  The worker (`mail/suppression.ts`) flags the person with that address
  (`app_user.mail_suppressed_at`, 057) and pauses their alert emails; the
  account and alert pages show a banner, and **Turn alert emails back on**
  (`POST /me/alerts/resume`) takes the address off the suppression list
  (`ses:DeleteSuppressedDestination`, the API role only; once a day per
  person). A transient bounce (a full mailbox) changes nothing.
  - *Trust.* The topic's policy admits only SES, for this configuration set
    in this account; the queue's admits only the topic; and the worker reads
    a record as an SES event only when its event source is `mail-events`
    (`MAIL_EVENTS_QUEUE_ARN` in its environment), never from its other
    queues, and parses it strictly.
  - *Runbook: the DLQ alarms.* The worker couldn't record a bounce 5 times
    (usually the database was down); that person's alerts are still on.
    Redrive `mail-events-dlq` once the worker is healthy. To suppress by
    hand, as the schema owner: `UPDATE app_user SET mail_suppressed_at =
    now(), mail_suppressed_reason = 'bounce' WHERE email = '…'`.
  - Locally: `pnpm dev:mail:bounce <email>` ([run-locally.md § Alerts](./run-locally.md#alerts)).

## Reports

Server-side PDFs ([architecture.md § Server-side reports](./architecture.md#server-side-reports))
run on the job queue, with the rendering done outside the VPC (infra/reports.tf,
plan-only until the first deploy):

- **The worker** (`REPORT_RENDERER=sqs`) never renders: a `report_render` job
  issues the render token, sends a versioned request (ids and the token) to
  `render-requests` and marks the report `rendering`. When the answer comes
  back on `render-results` it records the PDF and emails the link through SES
  (`MAIL_TRANSPORT=ses`, the same no-reply-only policy and endpoint as the
  API).
- **Renderer Lambda** (`backend/src/lambda-renderer.ts`, handler
  `lambda-renderer.handler`): a **container image** built from
  `backend/renderer.Dockerfile` (Playwright's image `v1.63.0-noble`, the
  Chromium e2e uses, pinned by digest, plus the Lambda runtime interface
  client and playwright-core, installed with `npm ci` from the lockfile in
  `backend/renderer-deps/`; moving Playwright means the tag and digest there,
  that package.json and backend's, and a refreshed lock, and `pnpm
  check:pins` fails until all of them agree with e2e's `@playwright/test`), x86_64,
  **no VPC**, 2048 MB, 120 s (the render's own cap is 100 s), 1 GB of `/tmp`,
  reserved concurrency `renderer_reserved_concurrency` (2). It opens
  `https://<domain>/projects/:id/report?run=…` through CloudFront and the WAF,
  signs in with the render token (`POST /api/auth/render-session`), prints
  the PDF and puts it in the reports bucket. Its role can do nothing else.
- **The image**: `deploy-backend.yml`'s build job (no AWS credentials) builds
  it, smoke-tests it as Lambda runs it (`infra/scripts/smoke-renderer-image.sh`:
  a uid with no passwd entry and a read-only filesystem; Chromium prints a PDF
  with the Lambda launch flags, the handler answers under the Lambda runtime
  interface emulator, and the init check refuses a missing setting) and hands
  it over as an artifact; CI's `renderer-image` job builds and smoke-tests it
  on every PR, and `pnpm check:renderer-image` does the same locally (needs
  docker only). A full render through the handler needs the deployed site,
  bucket and queues, so it is checked after the first deploy (#92); the approved deploy job pushes it to
  the `water-management-renderer` ECR repository (tags are immutable: the
  release version) and moves the function to it. **Lambda can't be created
  from an image that doesn't exist yet**, so the function is created by
  Terraform only once `renderer_image_tag` names a pushed version: after the
  first backend deploy, set it and apply ([infra/README.md § Operator steps](../infra/README.md#operator-steps), step 10a).
  Until then the deploy logs a notice and render requests wait in their
  queue.
- **The bucket**: `water-management-reports-<account>`, private (public
  access blocked, bucket-owner objects), SSE-S3, TLS only, and a lifecycle
  that deletes `reports/` objects after **7 days** (the tick deletes the
  rows a day later). The API role may only `GetObject` there, to pre-sign
  the 60-second download links `GET /projects/:id/reports/:jobId/pdf`
  redirects to (one per click, so nothing long-lived leaves the API; the
  browser fetches the object from S3 directly, not through CloudFront);
  signing is local, so the API needs no S3 endpoint. A pre-signed URL is
  only valid while the Lambda role's temporary credentials are, which
  always outlast the minute.
- **Retries and DLQs:** each render queue dead-letters after 5 receives. A
  failed render is an answer (the report shows it), not a retry: its token
  is spent. A render request in the DLQ can't be redriven usefully (the
  token expired after 5 minutes): purge it; a render result in the DLQ can.
- **Alarms:** `render-requests-dlq-depth`, `render-results-dlq-depth`,
  `renderer-errors` (a crash or timeout) and `renderer-duration` (p90 over a
  minute).
- **SES**: report emails go to members, so they count against the same SES
  sending limits as account email; production access (Operator step 8a) is
  needed before a schedule can mail anyone but verified addresses.
- **Cost (idle delta ≈ +$1.00–1.20/month):** two more event sources polling
  (~$0.50), four alarms ($0.40), the image in ECR (~$0.10–0.30); a render is
  ~5 s at 2 GB, ≈ $0.0002, and a PDF is ~1 MB for 7 days. No NAT, no new
  endpoint.

## Runbooks

Step 2 operations (roadmap [step-2 § 8](./roadmap/step-2-shared-catchment.md#8-cost-and-operations)).
Every step is an ordinary app action by an owner unless it says "operator".

1. **Bad data pushed by a gateway (an API key).**
   1. Revoke the key (Settings → API keys → Revoke). It stops working on the
      next request.
   2. In History, filter by `series` and find the key's `series.merged` /
      `series.created` events (the actor is `API key “<name>”`; each gives
      the day range and days changed). A `series.held` event means the
      data-quality rules already caught it and automatic runs are waiting.
   3. Re-push the right days (a new key, or the Add data dialog). A key's
      merges keep no series revision, so there is nothing to restore from;
      a person's earlier merges can still be restored from the series'
      revisions (180 days / 5 versions).
   4. Run the model (this also ends a hold). If the bad days reached a
      publication, publish the corrected run and say so in the notice.
2. **A feed failing.** Settings → Data feeds shows the error and the
   consecutive failures; `feed.failed` is in History. Check the source's
   status (CHIRPS / DWS sites) and the parser error. Switch the feed off
   while it's broken (its days so far stay), tell the modeller, and switch
   it back on once the source recovers: its next fetch catches up.
3. **Alert storm** (the `alert-storm` alarm, or people reporting a flood of
   alert emails). Each person gets at most 5 immediate alert emails a day
   and one digest, so a storm means many people or a loop.
   1. **Stop it:** set `alerts_enabled = false` in the Terraform variables and
      apply (only the worker's `ALERTS_ENABLED` changes; locally, set
      `ALERTS_ENABLED=false` in `backend/.env.development.local` and restart
      the worker). The next tick sends nothing and drops every delivery
      waiting to go out (`skipped`, reason "alerts switched off"), so
      nothing floods out later. Alerts are still evaluated and shown in the
      app.
   2. **Find the cause:** as the schema owner,
      `SELECT project_id, kind, count(*) FROM alert_event WHERE opened_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 3 DESC;`
      and `SELECT status, reason, count(*) FROM alert_delivery WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;`.
      A rule opening event after event is a threshold at the value's edge
      (the margin should prevent it: check `alerts/rules.ts`), a data problem
      moving the figure (History: a key's pushes, `series.held`), or an
      editor changing thresholds back and forth (History:
      `alert_rules.changed`, with who). A job loop shows as many
      `alert_eval` jobs in the project's jobs list.
   3. **Fix it:** switch the rule off or change its level (Overview → Set up
      alert emails), fix the data, or remove the editor. To silence one
      catchment only while the switch is back on, switch its rules off.
   4. **Turn it back on** (`alerts_enabled = true`). What was dropped isn't
      re-sent; firing alerts stay firing (no new mail until they clear and
      cross again). If people were flooded, tell the WUA; each person can
      turn alerts off in one click from any alert email.
4. **A farmer sees the wrong farm** (a possible personal-information
   incident). Unlink them at once (Overview → Farmers: change their farms,
   or remove them): access ends on their next request. Check History for the
   `farmer.linked` events (who linked what, when, and whether from an
   invite). Tell the WUA, which as the responsible party decides whether to
   notify the Information Regulator and the farmer whose figures were seen
   (POPIA s22). Record what was visible and for how long. Who decides,
   the timelines and what to tell whom:
   [legal/incident-procedure.md](./legal/incident-procedure.md).
5. **A share link leaked.** Overview → Share links → Revoke: the next view
   answers 404. Make a new link for the people who should have it. A link
   shows catchment-level figures only, never a farm.
6. **The worker is stuck.** See [§ Background jobs](#background-jobs): check
   the worker's logs and the `jobs-dlq`, redrive or purge it; leases expire
   after 6 minutes and the next tick claims the jobs again.
7. **A POPIA request to delete a person's account** (operator; there is no
   self-service deletion yet, [security.md § Personal information](./security.md#personal-information-popia)).
   Confirm the request with the WUA (the responsible party for its farmers).
   As the schema owner, in one transaction: `DELETE FROM app_user WHERE id =
   '…';`. Memberships, farm links, tokens, their pending jobs and the invites
   they sent go with it; notes, publications, keys and links stay with no
   author; the audit log is pseudonymised ("Deleted user"). A foreign-key
   error (`23503`) means they made a project, team, run, scenario, ensemble,
   import or nomination: that is evidence naming them, and what happens to it
   is for the operator and the client's information officer to decide first
   (followups.md § POPIA). Record the request and the outcome in the operator
   log.
8. **A POPIA request for a copy of a person's data** (access, s23). The
   person downloads it themselves: Account → Your data → **Download my
   data** (`GET /auth/me/export`, [security.md § Personal information](./security.md#personal-information-popia)).
   If they can't sign in, confirm who is asking with the WUA, have them
   reset their password, and point them there; no operator query is needed.
   If `auditEventsTruncated` is `true` (more than 50 000 events), the
   operator adds the older events by query as the schema owner. Record the
   request in the operator log.
9. **An unhandled 500** (the `unhandled-error` alarm, operator). The API
   answered a request with a generic `500` (`handleError`,
   `backend/src/http/errors.ts`): an exception no route expected, which the
   Lambda `Errors` alarm never counts because the invocation succeeded. Each
   one logs `{"event":"unhandled_error","method":"GET","route":"/projects/:id","error":"error","code":"42P01","at":["at …"]}`:
   the route's pattern (never the concrete path), the error's name and code
   (a Postgres SQLSTATE for a database error) and its stack frames, never its
   message. In CloudWatch Logs Insights on the API's log group,
   `filter event = "unhandled_error" | stats count() by route, error, code`
   says which endpoint and what kind of failure; `at` points at the throwing
   line. One route with a SQLSTATE after a deploy is usually a migration the
   code got ahead of (§ A failed migration); every route at once with
   `ECONNREFUSED` or `57P01` is the database (RDS alarms). Reproduce it
   locally, fix the cause and add a test; the message was deliberately not
   logged (it can hold row values), so the stack and code are the lead.

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
the main cost: RDS t4g.micro at ~$14/month. The VPC Lambdas' three interface
endpoints (Secrets Manager, SES API, SQS) cost ~$7.30/month each per AZ, which is
still cheaper than a NAT (~$33/month plus data); the data feeds' fetcher and
the report renderer run outside the VPC for the same reason. Total ≈ $50/month in
us-east-1, ≈ $58–63 in af-south-1; the breakdown is in
[infra/README.md § Cost](../infra/README.md#cost). The Terraform budget alarm
is set from `budget_monthly_usd` (default 60; raise it to ~80 for
af-south-1). The minimal (defaults) and full (Multi-AZ, highly available)
configurations, their tfvars and monthly cost are compared in
[deployment-tiers.md](./deployment-tiers.md).
