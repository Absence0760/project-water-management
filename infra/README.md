# Infrastructure

Terraform for the production stack at **https://water-management.jaredhoward.com**.
One root module, flat files, state in the estate bootstrap's S3 bucket. Nothing
here has been applied yet; see [Operator steps](#operator-steps) for the order.

## Architecture

```
browser ──HTTPS──► CloudFront + WAF (us-east-1 ACL)      water-management.jaredhoward.com
                    ├─ /*      → CF Function spa_rewrite → S3 (private, OAC)        SPA build
                    └─ /api/*  → CF Function strips /api → Lambda Function URL      Hono API
                                  + X-CloudFront-Shared-Secret                     (nodejs24.x, arm64)
                                                                                      │ VPC, private subnets
                                                          SES API (VPC endpoint) ◄────┤ SendEmail as no-reply@
                                                                                      │ water_app, TLS verify-full
                                   deploy-backend.yml ──invoke──► migrate Lambda ─────┤
                                                                   │ owner creds       ▼
                                                   Secrets Manager ◄┘ (VPC endpoint)  RDS PostgreSQL 17
                                                   (RDS-managed master secret)        db.t4g.micro, single-AZ
                                                                                      ▲
   API ──SendMessage (SQS VPC endpoint)──► SQS jobs ──► worker Lambda ────────────────┤ water_app, RLS as
   EventBridge rate(5 minutes) ─────────────────────────► (jobs.tf)                      the job's acting user
                                            └─► jobs-dlq (after 5 receives; alarms)
   worker ──SendMessage (endpoint)──► SQS fetch-requests ──► fetcher Lambda (NO VPC, no DB; feeds.tf)
   worker ◄── SQS ingest-results ◄──SendMessage (public)──────┘   └──HTTPS──► data.chc.ucsb.edu, www.dws.gov.za
   worker ──SendMessage (endpoint)──► SQS render-requests ──► renderer Lambda (container image, Chromium;
   worker ◄── SQS render-results ◄──SendMessage (public)──────┘   NO VPC, no DB; reports.tf)
                                                                  ├──HTTPS──► the site via CloudFront (render session)
                                                                  └──PutObject──► S3 reports (private, SSE, 7 days) ◄── API pre-signs GETs
                     (each queue: a DLQ after 5 receives; alarms)
```

- **Single origin.** The browser only calls the site's own domain. `/api/*` is
  proxied by CloudFront to the Lambda Function URL, so the session cookie is
  first-party and CORS never comes into play (the Function URL has no CORS
  block). CloudFront stamps a shared secret header that the app checks, so a
  direct hit on the Function URL gets 403, and the WAF covers the API as well
  as the static site.
- **`/api` prefix.** The `api_strip_prefix` CloudFront Function turns
  `/api/auth/login` into `/auth/login` before it reaches Lambda. The Hono app
  routes are unprefixed, the same as in local dev on `:3001`. **Do not also
  add `basePath('/api')` in the app.** It also sets `X-Viewer-Address` to the
  viewer's IP (overwriting any value sent), the one client address the API
  trusts, and only with the shared secret (the sign-up throttle,
  `backend/src/http/clientAddress.ts`).
- **SPA deep links.** The `spa_rewrite` function serves `/index.html` with a
  200 for any path whose last segment has no file extension
  (`/projects/<id>`). There is deliberately **no** distribution-wide
  `custom_error_response`, because that would also turn the API's own 403/404
  JSON into `index.html`.
- **Private-only VPC.** Two private subnets with no internet gateway, no NAT
  and no public subnet. Nothing needs the internet, and Lambda log delivery
  doesn't go through the function's ENI. The VPC reaches exactly three AWS
  APIs, each through its own interface endpoint and security group: **SES**
  (the API Lambda's `SendEmail`; `ses.tf`), **Secrets Manager** (the migrate
  Lambda only; its endpoint policy allows reading the RDS master secret and
  nothing else) and **SQS** (the API sends job wake-ups, the worker uses the
  `jobs` queue and the data feeds' `fetch-requests` / `ingest-results`; its
  endpoint policy names only those two roles and those three queues, the API
  on `jobs` alone; `jobs.tf`; the render queues joined them, reports.tf).
  The worker also sends report emails through the SES endpoint. If a future
  feature needs egress, add the
  matching VPC endpoint for an AWS service. Genuinely external hosts are
  reached by a Lambda **outside** the VPC with no database access, as the
  data feeds' fetcher does (`feeds.tf`), rather than a NAT (~$33/month).
- **Email (SES).** Domain identity for the site hostname with Easy DKIM
  (2048-bit), custom MAIL FROM `mail.<domain>` (MX + SPF), DMARC at `p=none`,
  and a configuration set that requires TLS to the receiving server, puts
  bounces and complaints on the suppression list, and publishes per-event
  counts to CloudWatch. The API role may call `ses:SendEmail` on that identity
  and configuration set only, and only with `From = no-reply@<domain>`.
  Leaving the SES sandbox is a manual step ([Operator steps](#operator-steps)).
- **Four Lambdas.** `water-management-backend` is the API. It connects as the
  RLS-bound `water_app` role, with memory 1024 MB, a 30 s timeout and reserved
  concurrency 10. `water-management-migrate` (`backend/src/lambda-migrate.ts`)
  reads the owner credentials at run time, creates or re-passwords
  `water_app`, and applies `backend/migrations/*.sql`. It has 512 MB, a 300 s
  timeout, reserved concurrency 1 and no URL. `water-management-worker`
  (`backend/src/lambda-worker.ts`, `jobs.tf`) runs the background job queue
  as `water_app`: 1024 MB, 300 s, reserved concurrency
  `worker_reserved_concurrency` (8: the sum of its four SQS triggers'
  `maximum_concurrency`, 4 × 2, or throttled messages burn receive counts into
  the DLQs), triggered by the SQS `jobs`, `ingest-results`, `render-results`
  and `mail-events` queues (partial batch failures reported, so one bad record
  is retried alone) and an EventBridge tick every 5 minutes
  ([docs/deployment.md § Background jobs](../docs/deployment.md#background-jobs)).
  `water-management-fetcher` (`backend/src/lambda-fetcher.ts`, `feeds.tf`)
  downloads the data feeds' sources: no VPC, no database URL or secret, 512
  MB, 120 s, reserved concurrency `fetcher_reserved_concurrency` (2), its role
  limited to receiving `fetch-requests` and sending `ingest-results`
  ([docs/deployment.md § Data feeds](../docs/deployment.md#data-feeds)).
  `water-management-renderer` (`backend/src/lambda-renderer.ts`,
  `reports.tf`) prints report PDFs: a **container image**
  (`backend/renderer.Dockerfile`, Playwright's Chromium) in its own ECR
  repository, no VPC, no database or secret, 2048 MB, 120 s, reserved
  concurrency `renderer_reserved_concurrency` (2), its role limited to
  receiving `render-requests`, sending `render-results` and putting objects
  under `reports/` in the reports bucket. It is created only once its first
  image is pushed (`renderer_image_tag`;
  [docs/deployment.md § Reports](../docs/deployment.md#reports)).
  Its egress is open: its Chromium is confined to the site's origin by the
  app (Playwright routing plus Chromium's own resolver, proxy and WebRTC
  flags; [docs/security.md § Render tokens](../docs/security.md#render-tokens)),
  not by the network. An egress allowlist would make that hold even against
  a browser bug, at a price, so it is a tradeoff, not a change: put the
  renderer in the VPC (SQS already has an endpoint; an S3 gateway endpoint
  is free) and send its traffic through either AWS Network Firewall with a
  domain allowlist (about $0.40/hour per AZ endpoint, ~$290/month for one
  AZ at us-east-1 list price and more in af-south-1, plus a NAT at
  ~$33/month and per-GB processing), or a Squid allowlist proxy on a
  t4g.nano with an Elastic IP (~$7–10/month, but a public subnet, an
  internet gateway and an instance to patch, which the VPC deliberately
  has none of).
- **TLS to RDS** is `sslmode=verify-full` (chain + hostname). Both zips carry
  `infra/certs/rds-global-bundle.pem` (the public AWS RDS CA bundle from
  `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`), and
  `NODE_EXTRA_CA_CERTS` points Node at it (the worker's zip too). `rds.force_ssl = 1` in the
  parameter group.

## Files

| File | What |
| --- | --- |
| `main.tf` | Versions, S3 backend (partial), providers (`aws`, `aws.us_east_1`), tags |
| `variables.tf` | Inputs. Only `aws_region`, `route53_zone_id` and `github_repo` are required |
| `secrets.tf` | `data "sops_file"` → `../../infra-secrets/water-management/prod.sops.yaml` (override with `secrets_file`) |
| `network.tf` | VPC, 2 private subnets, security groups, Secrets Manager endpoint |
| `rds.tf` | Subnet group, pg17 parameter group, log group, the DB instance |
| `lambda.tf` | IAM roles, log groups, API Lambda + Function URL + permissions, migrate Lambda |
| `jobs.tf` | Background jobs: SQS `jobs` queue + DLQ, worker Lambda + role + security group, its SQS event source and 5-minute EventBridge tick, the SQS interface endpoint (policy: two roles, one queue), the API's send-only policy, and the DLQ / worker-errors / worker-throttles / backlog / dead-job alarms |
| `feeds.tf` | Data feeds: SQS `fetch-requests` / `ingest-results` + DLQs, the fetcher Lambda outside the VPC (role: those two queues only), its event source, the worker's feed-queue policy and `ingest-results` event source, and the two DLQ-depth and fetcher-errors alarms |
| `reports.tf` | Server-side reports: the private reports bucket (SSE, TLS only, 7-day lifecycle), the renderer's ECR repository (immutable, scanned) and Lambda (container image, outside the VPC, created once `renderer_image_tag` is set), SQS `render-requests` / `render-results` + DLQs, the worker's render-queue and SES policies, the API's read-only PDF policy (for pre-signed downloads), and the DLQ / renderer-errors / renderer-duration alarms |
| `ses.tf` | SES configuration set, domain identity + DKIM/MAIL FROM/DMARC records, the API role's `ses:SendEmail` policy, SES API VPC endpoint; the bounce/complaint chain to the app (event destination → SNS `ses-events` → SQS `mail-events` + DLQ + alarm → the worker; the API role's `ses:DeleteSuppressedDestination` for turning mail back on) |
| `s3_cloudfront.tf` | Frontend bucket, ACM cert (us-east-1), CF Functions, distribution, A/AAAA records |
| `security_headers.tf` | Response-headers policies (site + API): CSP, HSTS, nosniff, framing, Referrer-, Permissions- and Cross-Origin-Opener-Policy |
| `waf.tf` | Web ACL with 2 per-IP rate rules (`/api/auth/*`: 100/5 min; site-wide: `waf_rate_limit_per_ip`) |
| `alarms.tf` | SNS topics (regional + us-east-1), budget, Lambda/RDS/SES/CloudFront alarms, backend `self_check_failed` log metric filter + alarm |
| `oidc.tf` | Looks up the bootstrap deploy role (and fails the plan if its trust policy isn't pinned to `environment:production`), attaches the per-resource deploy policy |
| `outputs.tf` | Values pushed to GitHub by `export-tf-vars.sh` |
| `scripts/package-lambdas.sh` | Builds + zips the API, migrate, worker and fetcher Lambdas and bundles the renderer's code for its image, all minified with names kept, source maps to `backend/dist/sourcemaps/` and not shipped (and, from esbuild's metafile, refuses a bundle that carries dotenv, an API/worker/fetcher bundle that carries playwright-core or imports it other than by a lazy `import()`, or a fetcher/renderer bundle that carries `pg`) (used by `deploy-backend.yml`; CI's `test` job runs it on every commit; [deployment.md § Lambda bundles](../docs/deployment.md#lambda-bundles)) |
| `scripts/check-csp.mjs` | Refuses a frontend build whose inline scripts aren't all hashed in SvelteKit's meta CSP (used by `deploy-frontend.yml`) |
| `certs/rds-global-bundle.pem` | RDS CA bundle shipped in every zip |
| `prod.sops.yaml.example` | The key list for the private secrets file |
| `tests/guardrails.tftest.hcl` | Plan-only `terraform test` against mocked providers (30 runs; see [Validating locally](#validating-locally)) |

## Decisions

### Database: RDS PostgreSQL 17, not Aurora Serverless v2

`db.t4g.micro` (2 burstable vCPU, 1 GiB) runs single-AZ with 20 GiB gp3
(autoscaling to 50). It is encrypted with the AWS-managed key, and has 7-day
automated backups with PITR, deletion protection and a final snapshot.
Performance Insights and Enhanced Monitoring are off, and the PostgreSQL log
goes to CloudWatch (30 days) with slow statements over 1 s. Minor versions
auto-upgrade in the Sunday window.

| | RDS t4g.micro (chosen) | Aurora Serverless v2, min 0 ACU |
| --- | --- | --- |
| Idle cost | ~$14/mo (instance + storage) | ~$2/mo storage while paused |
| Busy cost | same | $0.12/ACU-h: 0.5 ACU for 8 h × 22 d ≈ $11; always-on 0.5 ACU ≈ $44 |
| First request after idle | instant | ~15 s resume from auto-pause, so the login page times out or hangs |
| Driver / behaviour | same `pg` + PG 17 as local | same, but I/O is billed per request and storage per GB-month |

For a client tool that people open a few times a week, the ~15 s cold resume
on the first request is the deciding factor. A t4g.micro is also cheaper than
Aurora unless it would sit paused for most of the month. Revisit if the DB
sits idle for weeks at a time and a slow first request becomes acceptable.
Multi-AZ (`db_multi_az`) doubles the instance cost. Single-AZ recovery after
an AZ failure means a restore (minutes to about an hour), which is acceptable
here.

**Connections.** max_connections on t4g.micro is ~80. The API is capped at
10 concurrent containers × a `pg` pool of 5 = 50, the worker at 8 × a pool of
2 = 16, plus the migrator: 67 at the very worst, under the limit with room for
RDS's own. Raising a reserved concurrency means redoing this sum. RDS
Proxy isn't used: its minimum bill (~$22/month) is more than the DB at this
scale. An alarm fires at 60 connections.

### Secrets: estate pattern (private `infra-secrets` + sops), RDS-managed master

| Secret | Source | In Terraform state? |
| --- | --- | --- |
| RDS master (`water`, schema owner) | `manage_master_user_password`: RDS generates it, stores it in Secrets Manager and rotates it (every 7 days by default) | **No.** Only the migrate Lambda reads it, at run time |
| `water_app` password | sops `db_app_password` → API `DATABASE_URL` + migrate `WATER_APP_PASSWORD` | Yes |
| `AUTH_JWT_SECRET` | sops `auth_jwt_secret` → API and worker env (the worker's re-run job stamps the runs it stores) | Yes |
| CloudFront shared secret | `random_password` | Yes |

This follows the estate. project-flakey uses the same RDS-managed master plus
app secrets from sops. The state bucket is SSE-encrypted, private to this
account, and versioned. As `project-mgmt/docs/secrets-management.md` says,
sops protects secrets in git, not in state. The master is kept out of state
because it is the one credential that bypasses RLS. The cost of that choice is
the Secrets Manager VPC endpoint (~$7.30/month). The alternative, a
sops-supplied master password in the migrate Lambda's env, would save that but
put the owner credential in state and in the Lambda config. If you ever want
to go further, the API could read its two secrets from Secrets Manager at cold
start (populated write-only from `ephemeral "sops_file"`), which would take
them out of state too. That needs an app change and endpoint access from the
API security group.

The migrate Lambda sets `water_app`'s password as a **SCRAM-SHA-256
verifier** computed in the Lambda, so the plaintext never reaches Postgres or
its logs. It then verifies that the role is not SUPERUSER, BYPASSRLS,
REPLICATION or CREATEROLE, and fails the deploy if it is. (On RDS the owner
is `rds_superuser`, and PostgreSQL 16+ won't let a non-superuser even mention
`NOSUPERUSER`/`NOBYPASSRLS` in `ALTER ROLE`, so the attributes are checked
rather than set.)

Deploy trust boundary: the deploy role can update the migrate Lambda's code,
and that code runs with owner credentials. That is the same boundary as
deploying the API. It is gated by the `production` environment's required
reviewer.

### Region

`aws_region` has no default, on purpose: it is set in tfvars. Any region but
af-south-1 fails the plan unless `data_outside_south_africa = true`, because
the privacy notice tells users their data is stored in South Africa: rewrite
its §6 (and get the client's agreement, POPIA s72) before setting it
(`refuses_a_region_outside_south_africa_by_default` in the guardrail tests). The decision
(**af-south-1**, with SES in the same region, 2026-09-26) and its
reasoning, with sources, are in
[docs/deployment.md § Region](../docs/deployment.md#region-recommendation).
In short: SES, its DKIM/MAIL FROM feedback endpoints and the SES API VPC
endpoint all exist in af-south-1, so nothing forces a second region; it is an
opt-in region and costs more (see [Cost](#cost)). SES and its DNS follow
`aws_region` automatically, including af-south-1's regional DKIM domain
(`dkim.af-south-1.amazonses.com`, tested). The ACM certificate, WAF, the
CloudFront alarm and its SNS topic are always in us-east-1, and so is the
tfstate bucket. The two SNS topics exist because a CloudWatch alarm can only
notify a topic in its own region.

### Smaller calls

- **arm64 Lambdas**, ~20% cheaper per GB-s. The bundle is pure JS (`bcryptjs`,
  not native bcrypt).
- **No www alias.** `www.water-management.jaredhoward.com` isn't worth a SAN,
  records and a redirect.
- **Own response-headers policies** (`security_headers.tf`) instead of the
  managed SecurityHeadersPolicy: HSTS 2 years with subdomains (no preload —
  only a registrable domain can be preloaded), nosniff, `X-Frame-Options:
  DENY`, `X-XSS-Protection: 0`, Referrer-Policy, Permissions-Policy and COOP,
  all with `override`. The API behaviour gets `default-src 'none'`.
- **CSP in two layers.** SvelteKit's static build has one inline bootstrap
  script whose hash changes every build, so it can't be pinned in Terraform.
  The CloudFront header carries everything build-independent (`default-src
  'self'`, `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors
  'none'`, `connect-src 'self'`) plus `script-src 'self' 'unsafe-inline'`;
  SvelteKit's `<meta>` CSP (`kit.csp.mode = 'hash'`) adds `script-src 'self'
  'sha256-…'`. Browsers enforce both, so only the hashed bootstrap and
  same-origin files run. `scripts/check-csp.mjs` fails the frontend deploy if
  the meta policy is missing, so the header's `'unsafe-inline'` can never be
  the effective policy. `style-src` keeps `'unsafe-inline'`: Svelte templates
  and uPlot set inline `style` attributes, which nothing narrower allows (an
  accepted risk; CSS can't run script). No third-party origin is allowed
  anywhere.
- **PriceClass_All**: AWS's price-class table ([CloudFront pay-as-you-go pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)) puts South Africa, Kenya, Nigeria, Egypt and the Middle East only in PriceClass_All, so
  100 or 200 would serve SA users from Europe or Asia. At this traffic the
  difference in price is cents.
- **WAF has no AWS managed rule groups.** The common rule set blocks bodies
  over 8 KB, and series uploads are ~1 MB.
- **Frontend bucket name** carries the account ID (S3 names are global).
- **Migrations before code.** The deploy runs migrations first, so every
  migration must work with the API version still serving (expand/contract).

## Cost

Idle to light use, on-demand, us-east-1:

| Item | $/month |
| --- | --- |
| RDS db.t4g.micro single-AZ (730 h × $0.016) | 11.70 |
| RDS gp3 20 GiB | 2.30 |
| RDS backups (free up to the provisioned size) | 0 |
| Secrets Manager interface endpoint, 1 AZ | 7.30 |
| SES API interface endpoint, 1 AZ | 7.30 |
| SQS interface endpoint, 1 AZ (job wake-ups, `jobs.tf`) | 7.30 |
| SQS + EventBridge (the 5-minute tick: ~8,600 invocations) | ~0 |
| SQS polling by the six event sources (`jobs`, `fetch-requests`, `ingest-results`, `render-requests`, `render-results`, `mail-events`: ~0.65 M receives a month each, ~2.9 M past the free tier) | ~1.16 |
| ECR: the renderer image (~0.7 GB compressed; up to 10 releases kept, mostly shared layers) | ~0.10–0.30 |
| S3 reports bucket (PDFs of ~1 MB, 7 days) | ~0 |
| SES sending ($0.10 / 1,000 emails) | ~0 |
| Secrets Manager (RDS master secret) | 0.40 |
| WAF: ACL + 2 rules (+ $0.60 / 1M requests) | 7.00 |
| Route 53 child zone (bootstrap-owned, billed here) | 0.50 |
| KMS `alias/water-management-sops` (bootstrap-owned) | 1.00 |
| CloudWatch: 28 alarms (incl. the self-check-failed and job-dead log metric filters, the jobs backlog, alert-storm and alert-mail-failure embedded metrics, worker throttles, the two feed DLQs and fetcher errors, the two render DLQs, renderer errors and duration, the mail-events DLQ), logs, RDS log export | ~3.00 |
| CloudFront (PriceClass_All), CF Functions, S3, Lambda (incl. the fetcher: a daily CHIRPS feed is ~5 s at 512 MB; the renderer: ~5 s at 2 GB ≈ $0.0002 a PDF) | ~0 (free tiers; Lambda at 1 GB × 10k s ≈ $0.13) |
| **Total** | **≈ $50** (the data feeds added ≈ $0.70, server-side reports ≈ $1.00–1.20) |

**af-south-1** has higher RDS, endpoint and storage rates (roughly +25–35%),
which comes to **≈ $58–63/month**. Check the AWS pricing calculator before
you commit to it. At that level the default `budget_monthly_usd = 60` sits
right on the baseline and the forecast alert would fire every month, so
**raise it to ~80 for af-south-1**. Main levers: the three endpoint AZ counts
(`secretsmanager_endpoint_az_count`, `ses_endpoint_az_count`,
`sqs_endpoint_az_count`, all 1 by default), and dropping WAF, which is not
recommended because it is the spend and brute-force guard for the API. A NAT
instead of the endpoints would cost more (~$33 + data), and the fetcher
Lambda outside the VPC (WP-2.10) is what keeps step 2's internet fetches from
needing one.

These are the minimal (default) figures. The full, highly available
configuration (Multi-AZ `db.t4g.small`, endpoints in 2 AZs, ≈ $110–115 in
us-east-1) is costed in
[docs/deployment-tiers.md](../docs/deployment-tiers.md).

## Operator steps

Claude does not run any of these, and none of them print a secret. Replace
`<region>` with the chosen region (e.g. `af-south-1`).

1. **Account.** Create the bootstrap config (`create_subdomain = true`) per
   Runbook A in `~/github/project-mgmt/docs/runbooks.md`, then run it:
   - `cd ~/github/templates && ./scripts/new-project-account.sh water-management --plan`
   - `cd ~/github/templates && ./scripts/new-project-account.sh water-management`

   Wait until the child zone's delegation resolves:
   `dig +short NS water-management.jaredhoward.com`. ACM validation hangs
   until it does.
2. **Region (af-south-1 only).**
   `aws account enable-region --region-name af-south-1 --profile water-management`,
   then poll `aws account get-region-opt-status --region-name af-south-1 --profile water-management`
   until it shows `ENABLED`.
3. **Lambda concurrency quota, before the first apply.** A new account's
   concurrent-executions quota is 10 and AWS keeps 10 unreserved, so any
   reservation fails until it is raised. The quota must cover the sum of the
   reservations plus 10: at the defaults 10 (API) + 1 (migrate) + 8 (worker)
   + 2 (fetcher) + 2 (renderer) + 10 = **33**. Ask for 1000 (the usual
   default) and wait for it to be granted before planning the first apply.
   `-1` (unreserved) is refused by the variables' validation: it would lift
   the spend and DB-connection caps.
   `aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000 --region <region> --profile water-management`
   Check it with
   `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 --region <region> --profile water-management --query Quota.Value`.
4. **Billing access for budgets.** As the account root: Account → "IAM user
   and role access to Billing information" → Activate. Until then, set
   `budget_monthly_usd = 0`.
4a. **SES endpoint service check** (read-only, before the first plan): confirm
   the SES API endpoint service exists in the region (it launched Dec 2025):
   `aws ec2 describe-vpc-endpoint-services --service-names com.amazonaws.<region>.email --region <region> --profile water-management --query 'ServiceDetails[].ServiceName'`.
   An empty result means the apply would fail on `aws_vpc_endpoint.ses`.
5. **Secrets** in the private repo. The key list is in
   [`prod.sops.yaml.example`](./prod.sops.yaml.example). Generate the values
   with `openssl rand -hex 32` (JWT) and `openssl rand -hex 24` (db password)
   inside the editor.
   - `cd ~/github/infra-secrets && ./bin/sops-init.sh --project water-management --region us-east-1`
     (the KMS key lives in the bootstrap region)
   - `cd ~/github/infra-secrets && AWS_PROFILE=water-management sops water-management/prod.sops.yaml`
   - Commit and push `infra-secrets`.
6. **Non-secret config.** Following the estate pattern (feohledger,
   threkir), keep it in the private repo as
   `~/github/infra-secrets/water-management/prod.tfvars`, based on
   [`terraform.tfvars.example`](./terraform.tfvars.example).
7. **Backend config:**
   `cd ~/github/project-water-management/infra && printf 'bucket = "water-management-tfstate-%s"\n' "$(aws sts get-caller-identity --profile water-management --query Account --output text)" > backend.config`
8. **Plan, review, apply:**
   - `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform init -backend-config=backend.config`
   - `mkdir -p -m 700 ~/.cache/water-management && cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform plan -var-file=../../infra-secrets/water-management/prod.tfvars -out="$HOME/.cache/water-management/prod.tfplan"`
   - `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform apply "$HOME/.cache/water-management/prod.tfplan" && rm -f "$HOME/.cache/water-management/prod.tfplan"`

   A saved plan holds every variable and secret it read (the decrypted sops
   values, the database passwords) in plain form, so it is written outside
   the repo and deleted once applied. If you don't apply it, delete it
   yourself: `rm -f ~/.cache/water-management/prod.tfplan`. `.gitignore`
   also ignores `*.tfplan` as a backstop.

   The first apply takes ~20 minutes (RDS plus CloudFront). Confirm **both**
   SNS email subscriptions afterwards: the regional topic and the us-east-1
   topic.
8a. **SES: verify, then leave the sandbox.** The DKIM, MAIL FROM and DMARC
   records are created by the apply; the identity turns `SUCCESS` once DNS
   propagates (minutes to an hour):
   `aws sesv2 get-email-identity --email-identity water-management.jaredhoward.com --region <region> --profile water-management --query '{dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus,verified:VerifiedForSendingStatus}'`.
   A new account is in the **SES sandbox** (200 emails/day, 1/s, and only to
   *verified* addresses), which Terraform can't change. Request production
   access — it is a human review by AWS, usually within a day:
   `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://water-management.jaredhoward.com --use-case-description "Transactional account email only (email verification, password reset, project invitations) for a low-volume B2B water-modelling tool; no marketing. Bounces and complaints go to the SES suppression list and CloudWatch alarms." --contact-language EN --region <region> --profile water-management`.
   Until it is granted, verify your own address to test
   (`aws sesv2 create-email-identity --email-identity you@example.com --region <region> --profile water-management`),
   and check with `aws sesv2 get-account --region <region> --profile water-management --query ProductionAccessEnabled`.
8b. **DMARC.** After 2–4 weeks of clean aggregate reports at
   `dmarc_report_email`, set `dmarc_policy = "quarantine"` and apply.
9. **Wire CI:** `cd ~/github/project-water-management && ~/github/templates/scripts/export-tf-vars.sh infra/`.
   This sets `AWS_REGION`, `FRONTEND_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`,
   `LAMBDA_FUNCTION_NAME`, **`MIGRATE_FUNCTION_NAME`**, **`WORKER_FUNCTION_NAME`**, **`FETCHER_FUNCTION_NAME`**, **`RENDERER_FUNCTION_NAME`**, **`RENDERER_ECR_REPOSITORY`**, `REPORTS_BUCKET` (unused by the workflows), `PUBLIC_SITE_URL` and
   `CLOUDFRONT_DOMAIN_NAME` (unused by the workflows) as variables, and
   `AWS_DEPLOY_ROLE_ARN` and `LAMBDA_FUNCTION_URL` (debugging only) as
   secrets. The release preflight (`scripts/release/preflight.mjs`) refuses
   to deploy while any value that deploy reads is empty (`REQUIRED_CONFIG` in
   each deploy workflow).
9a. **Approval gate.** Confirm the `production` environment exists with you
   as a required reviewer:
   `gh api repos/Absence0760/project-water-management/environments/production --jq '.protection_rules'`.
   If not: `cd ~/github/templates && ./scripts/backfill-prod-environment.sh --apply`.
   Required reviewers need a **public** repo (or GitHub Pro/Team for a
   private one); the release preflight refuses to deploy without them.
10. **First deploy:** backend first (it applies every migration in
    `backend/migrations` and creates `water_app`), then frontend, each by publishing a release
    ([docs/deployment.md § Releasing](../docs/deployment.md#releasing)):
    - `gh release create backend@0.1.0 --target main --title "Backend 0.1.0" --generate-notes`
    - once that deploy has finished: `gh release create web@0.1.0 --target main --title "Web 0.1.0" --generate-notes`

    Approve each in the `production` environment. The backend deploy ends
    with a `/api/health` check through CloudFront; check the site by hand
    too: `curl -s https://water-management.jaredhoward.com/api/health`.
10a. **The report renderer** (after the first backend deploy). That deploy
    pushed the renderer image to ECR, tagged with the release version, and
    left a notice that the function doesn't exist yet. Set
    `renderer_image_tag = "0.1.0"` (that version) in `prod.tfvars`, then plan
    and apply (step 8). Every later backend release moves the function to
    its own image; the tag in `prod.tfvars` only ever creates it. Until then
    report requests wait in `render-requests` (4 days) and show as
    "rendering".

### Rotating secrets

- **`db_app_password`:** edit it with sops, apply, and invoke the migrate
  Lambda straight away. The API fails DB logins until you do:
  `aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{}' --cli-read-timeout 320 --region <region> --profile water-management /dev/stdout`
- **`auth_jwt_secret`:** edit it with sops and apply. Everyone is signed out.
- **CloudFront shared secret:**
  `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform apply -var-file=../../infra-secrets/water-management/prod.tfvars -replace=random_password.cloudfront_shared_secret`
  (a few seconds of 403s while CloudFront and Lambda converge).
- **Alert unsubscribe-token secret** (WP-2.13, the worker only): only if it
  leaked, since every unsubscribe link in alert emails already sent stops
  working ("Manage your alerts" still does):
  `terraform apply -var-file=… -replace=random_password.alerts_token_secret`.
  The alert kill switch is `alerts_enabled = false` (docs/deployment.md §
  Runbooks, alert storm).
- **RDS master:** RDS rotates it automatically. Nothing reads it except the
  migrate Lambda, which fetches it on every run.

### Database access and recovery

- There is **no interactive access path** by design: no bastion, no public
  endpoint. Schema changes go through migrations. For a one-off
  investigation, the least-effort option is a temporary SSM-managed EC2
  instance in a private subnet. That needs the `ssm`, `ssmmessages` and `ec2messages`
  endpoints (~$22/month while they exist), so remove them afterwards.
- **Point-in-time restore** creates a *new* instance. Restore it with
  `aws rds restore-db-instance-to-point-in-time`, then either `terraform import`
  it in place of `aws_db_instance.main` (after `terraform state rm`) or swap
  identifiers. Rehearse this once before go-live.

## Validating locally

No AWS credentials are needed:

`cd ~/github/project-water-management && pnpm check:infra`

That is `bin/check-infra.sh`: `terraform fmt -check -recursive`,
`init -backend=false`, `validate`, and `terraform test`. CI runs the same
script (`ci.yml` job `terraform`, which calls `terraform.yml`; part of the
`CI gate`), plus an advisory Trivy IaC scan. CI never plans against the real account;
[docs/deployment.md § 4](../docs/deployment.md#4-cicd) says why. Terraform 1.15's
`validate` checks the S3 backend's required `bucket`, so the script writes a
gitignored `backend_override.tf` (local backend) for the run and deletes it
afterwards. If you create one by hand, delete it before any real
`terraform init -backend-config=backend.config`, or the override silently
wins and state goes to a local file.

The test suite (`tests/guardrails.tftest.hcl`) plans against mocked providers
and pins: Lambda runtime/memory/timeout/concurrency and env; RDS durability
and privacy; the single-origin CloudFront wiring; WAF attached; S3 private
(public-access block, OAC-only policy, ACLs off); TLS minimums; both
security-headers policies and the CSP directives; SES identity, DKIM (global
and regional DKIM domains), MAIL FROM, DMARC, TLS-required configuration set,
the least-privilege `ses:SendEmail` policy and the VPC endpoint; the
background-job stack (queue SSE, the DLQ after 5 receives, visibility ≥ 6×
the worker timeout, the worker's runtime / size / concurrency / VPC / env and
no owner credentials, the 5-minute tick and its invoke permission, the SQS
event source, the SQS endpoint's policy naming only the two roles and the
jobs queue, and the deploy role's right to update the worker); the data-feed
stack (both queues' SSE, DLQs and visibility; the fetcher outside the VPC, its
size and concurrency, an environment with no database URL, a role on the two
feed queues only; the worker's `FEED_FETCHER=sqs` and its event source; the
API kept to the jobs queue through the endpoint; the deploy role's right to
update the fetcher); every alarm
wired to SNS, including the `self_check_failed` log metric filter (pattern
and metric name) and its alarm; the budget; the deploy policy having no
wildcards; and the
deploy role's trust postcondition, with negative runs for a branch subject, a
`StringLike` wildcard and another repo (and a positive run for GitHub's
immutable-claims subject). Three more negative runs check that a short
`auth_jwt_secret`, a non-alphanumeric `db_app_password` and an invalid
`dmarc_policy` fail the plan, and one that a `jobs_backlog_alarm_seconds`
below two ticks does. Six more refuse an unreserved (`-1`) concurrency on each
Lambda and a worker cap below the sum of its SQS triggers'
`maximum_concurrency`; `worker_sqs_triggers` pins that sum against the planned
mappings, `ReportBatchItemFailures` on every worker trigger and the worker
throttles alarm; and `waf_auth_rule_matches_decoded_path` pins the auth rate
limit's `URL_DECODE` → `NORMALIZE_PATH` → `LOWERCASE` transformations (so
`/api/%61uth/login` can't slip past it).
Terraform is pinned in `.terraform-version` (tfenv) and providers are pinned in
the committed `.terraform.lock.hcl` (linux_amd64, linux_arm64, darwin_arm64).

## Tearing down

`deletion_protection` must be turned off first (set it to `false`, then
apply). `terraform destroy` then leaves a final snapshot
`water-management-final`. The tfstate bucket, the KMS key, the child zone and
the deploy role belong to the bootstrap and survive.
