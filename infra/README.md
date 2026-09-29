# Infrastructure

Terraform for the production stack at **https://water-management.jaredhoward.com**.
One root module, flat files, state in the estate bootstrap's S3 bucket. Nothing
here has been applied yet; see [Operator steps](#operator-steps) for the order.

## Architecture

```
browser ──HTTPS──► CloudFront + WAF (us-east-1 ACL)      water-management.jaredhoward.com
                    ├─ /*         → CF Function spa_rewrite → S3 (private, OAC)     SPA build
                    ├─ /reports/* → signed URLs only (key group) → S3 reports (OAC) report PDFs
                    └─ /api/*     → CF Function strips /api → Lambda Function URL   Hono API
                                  + X-CloudFront-Shared-Secret                     (nodejs24.x, arm64)
                                                                                      │ VPC, private subnets
                                                          SES API (VPC endpoint) ◄────┤ SendEmail as no-reply@
                                                                                      │ water_app, TLS verify-full
                                   deploy-backend.yml ──invoke──► migrate Lambda ─────┤
                                                                   │ owner creds       ▼
                                                   Secrets Manager ◄┘ (VPC endpoint)  RDS PostgreSQL 17
                                                   (RDS master; runtime secrets)      db.t4g.micro, single-AZ
                                                                                      ▲
   API ──SendMessage (SQS VPC endpoint)──► SQS jobs ──► worker Lambda ────────────────┤ water_app, RLS as
   EventBridge rate(5 minutes) ─────────────────────────► (jobs.tf)                      the job's acting user
                                            └─► jobs-dlq (after 5 receives; alarms)
   worker ──SendMessage (endpoint)──► SQS fetch-requests ──► fetcher Lambda (NO VPC, no DB; feeds.tf)
   worker ◄── SQS ingest-results ◄──SendMessage (public)──────┘   └──HTTPS──► data.chc.ucsb.edu, www.dws.gov.za
   worker ──SendMessage (endpoint)──► SQS render-requests ──► renderer Lambda (container image, Chromium;
   worker ◄── SQS render-results ◄──SendMessage (public)──────┘   NO VPC, no DB; reports.tf)
                                                                  ├──HTTPS──► the site via CloudFront (render session)
                                                                  └──PutObject──► S3 reports (private, SSE, 7 days) ◄── CloudFront /reports/* (OAC, signed URLs the API mints)
                     (each queue: a DLQ after 5 receives; alarms)
```

- **Runtime secrets.** The API, worker and migrate Lambdas each read their own
  Secrets Manager secret once per cold start (through the same endpoint);
  no secret is in any Lambda's environment ([§ Secrets](#secrets-estate-pattern-private-infra-secrets--sops-rds-managed-master)).
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
- **Missing files are 404, not S3 XML.** A path *with* an extension reaches
  S3 only where the build keeps files (`_app/`, the directories and files in
  `frontend/static`, the HTML the build writes: `STATIC_DIRS` /
  `STATIC_FILES` in `spa_rewrite`). Anything else (`/report.pdf`,
  `/wp-login.php`, a dot segment) gets a small `404` page from the function
  itself, without touching S3. A missing file inside those locations reaches
  S3, and the bucket policy's `s3:ListBucket` for this distribution makes S3
  answer `404` (NoSuchKey) rather than `403` (AccessDenied). That grant can't
  list the bucket through CloudFront: a listing is a GET on the bucket root,
  every path ending in `/` goes to `/index.html`, dot segments are refused,
  and the default behaviour forwards no query string. The private reports
  bucket keeps `GetObject` only, so a missing report stays `403`. A new
  top-level file or directory in `frontend/static`, or a new prerendered
  page, must be added to those lists:
  `infra/scripts/cloudfront-functions.test.mjs` (`pnpm test:guards`) runs the
  function and fails until it is. `tests/edge.tftest.hcl` pins the policy and
  the behaviours' cache and origin-request policies.
- **Private-only VPC.** Two private subnets with no internet gateway, no NAT
  and no public subnet. They go in the two lowest available **zone IDs**
  (`afs1-az1`, `afs1-az2` in af-south-1), not the first two zone names: names
  are shuffled per account and the list's order isn't a contract, while a
  zone ID is the same physical zone everywhere. Opt-in zones (Local,
  Wavelength) are excluded (`network.tf`, `tests/edge.tftest.hcl`). Nothing needs the internet, and Lambda log delivery
  doesn't go through the function's ENI. The VPC reaches exactly three AWS
  APIs, each through its own interface endpoint and security group: **SES**
  (`SendEmail` from the API and the worker, which sends report and alert
  emails, and `DeleteSuppressedDestination` from the API only; its endpoint
  policy names only those two roles, those actions and a send as
  no-reply@; `ses.tf`, the worker's rules in `reports.tf`), **Secrets Manager**
  (the migrate Lambda's RDS master secret, and the API, worker and migrate
  Lambdas' runtime secrets; its endpoint policy lets each role read only its
  own secrets; `network.tf`, `secrets.tf`) and **SQS** (from the API and the worker; its
  endpoint policy, `jobs.tf`, names only those two roles and six queues: the
  API may only send to `jobs`; the worker uses `jobs`, sends
  `fetch-requests` and `render-requests`, and consumes `ingest-results`,
  `render-results` and `mail-events`). Security groups only ever reference
  other security groups, never a CIDR: RDS takes 5432 from the API, migrate
  and worker Lambda groups and nothing else, each endpoint takes 443 from
  the Lambdas that use it, and none of RDS or the endpoints has egress. A
  security group's description can't change in place (AWS replaces the
  group, which can stall an apply for 20+ minutes while Lambda ENIs let go),
  so the network test pins each one verbatim. If a future feature needs
  egress, add the matching VPC endpoint for an AWS service. Genuinely
  external hosts are reached by a Lambda **outside** the VPC with no
  database access, as the data feeds' fetcher (`feeds.tf`) and the report
  renderer (`reports.tf`) do, rather than a NAT (~$33/month).
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
  is retried alone) and an EventBridge tick every 5 minutes (never retried,
  by EventBridge or Lambda's async queue, and dropped after 300 s: the next
  tick recovers)
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
  The image is pinned by content: its Playwright base by tag *and* digest
  (`mcr.microsoft.com/playwright:v<version>-noble@sha256:…`, both `FROM`
  lines), its npm packages (playwright-core, aws-lambda-ric) by
  `backend/renderer-deps/package-lock.json`, installed with `npm ci`, and
  its build stage's apt packages by exact version from one Ubuntu archive
  snapshot (`APT_SNAPSHOT`). Nothing moves that snapshot by itself, so
  `pnpm gen:renderer-apt` moves it and the versions together (each read
  from the digest-pinned base with `apt-cache --snapshot`), on every
  Dependabot `docker` PR and whenever the weekly
  `renderer-apt-snapshot.yml` check opens its issue (snapshot over 90 days
  old; `pnpm check:apt-snapshot` locally).
  Dependabot's `docker` entry for `/backend` opens the tag-and-digest PR;
  neither it nor the `/backend/renderer-deps` npm entry is ever
  auto-merged (`pnpm check:workflows` keeps both out of auto-merge). Moving
  Playwright moves every pin at once: the Dockerfile tag and digest
  (`docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble`),
  playwright-core in `backend/renderer-deps/package.json` (then
  `npm install --package-lock-only` there) and `backend/package.json`, and
  e2e's `@playwright/test`. `pnpm check:pins` fails until they agree, and
  `pnpm check:renderer-image` builds and smoke-tests the result.
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
| `secrets.tf` | The API, worker and migrate Lambdas' runtime secrets in Secrets Manager, written write-only from the sops-fed ephemeral variables (`variables.tf`), each role's read of its own |
| `scripts/tf.sh` | Runs Terraform under `sops exec-env` with `../../infra-secrets/water-management/prod.sops.yaml` (override with `WM_SECRETS_FILE`), each key as `TF_VAR_<key>`; every plan, apply and import goes through it. Tested against a fake `sops` + `terraform` (`tf.test.mjs`, `tf-stubs/`; `pnpm test:guards`) |
| `network.tf` | VPC, 2 private subnets, the API, migrate and RDS security groups, the Secrets Manager endpoint and its security group (migrate's RDS master secret, and each Lambda's runtime secret) |
| `rds.tf` | Subnet group, parameter group (`name_prefix` + `create_before_destroy`, so a major upgrade can replace it; the steps are in the file), log group, the DB instance |
| `lambda.tf` | IAM roles, log groups, API Lambda + Function URL + permissions, migrate Lambda |
| `jobs.tf` | Background jobs: SQS `jobs` queue + DLQ, worker Lambda + role + security group, its SQS event source and 5-minute EventBridge tick, the SQS interface endpoint and its security group (policy: two roles, six queues), the API's send-only policy, and the DLQ / worker-errors / worker-throttles / worker-heartbeat / tick-failed / backlog / dead-job alarms |
| `feeds.tf` | Data feeds: SQS `fetch-requests` / `ingest-results` + DLQs, the fetcher Lambda outside the VPC (role: those two queues only), its event source, the worker's feed-queue policy and `ingest-results` event source, and the two DLQ-depth and fetcher-errors alarms |
| `reports.tf` | Server-side reports: the private reports bucket (SSE, TLS only, 7-day lifecycle), the renderer's ECR repository (immutable, scanned) and Lambda (container image, outside the VPC, created once `renderer_image_tag` is set), SQS `render-requests` / `render-results` + DLQs, the worker's render-queue and SES policies, downloads through CloudFront (the trusted public keys from `report_download_public_keys` and their key group, the reports OAC, the origin request policy that forwards only the file name, and the bucket policy that lets only this distribution read `reports/`; the `/reports/*` behaviour itself is in `s3_cloudfront.tf`), and the DLQ / renderer-errors / renderer-duration alarms |
| `ses.tf` | SES configuration set, domain identity + DKIM/MAIL FROM/DMARC records, the API role's `ses:SendEmail` policy, SES API VPC endpoint and its endpoint policy; the bounce/complaint chain to the app (event destination → SNS `ses-events` → SQS `mail-events` + DLQ + alarm → the worker; the API role's `ses:DeleteSuppressedDestination` for turning mail back on) |
| `s3_cloudfront.tf` | Frontend bucket, ACM cert (us-east-1), CF Functions, distribution, A/AAAA records |
| `security_headers.tf` | Response-headers policies (site + API): CSP, HSTS, nosniff, framing, Referrer-, Permissions- and Cross-Origin-Opener-Policy |
| `waf.tf` | Web ACL with 3 per-IP rate rules (`/api/auth/*`: 100/5 min; `/api/*`: `waf_rate_limit_per_ip`; every path, the static site's backstop: `waf_site_rate_limit_per_ip`) and the sign-in CAPTCHA rule (`POST /api/auth/login`: a puzzle past `waf_signin_captcha_per_5min`), plus its CAPTCHA API key |
| `alarms.tf` | SNS topics (regional + us-east-1, each publish-only for this account's services), monthly + daily budgets and Cost Anomaly Detection (to the us-east-1 topic), Lambda/RDS/SES alarms, the us-east-1 CloudFront 5xx, CloudFront request-flood and WAF blocked-requests alarms, the backend's `self_check_failed` and `mail_send_failed` log metric filters (API and worker log groups) and `unhandled_error` and `login_failed` filters (API log group) + their alarms |
| `oidc.tf` | Looks up the bootstrap deploy role (and fails the plan if its trust policy isn't pinned to `environment:production`), attaches the per-resource deploy policy |
| `outputs.tf` | Values pushed to GitHub by `export-tf-vars.sh`, and the `db_*` names `restore-db.sh` reads |
| `scripts/package-lambdas.sh` | Builds + zips the API, migrate, worker and fetcher Lambdas and bundles the renderer's code for its image, all minified with names kept, source maps to `backend/dist/sourcemaps/` and not shipped (and, from esbuild's metafile, refuses a bundle that carries dotenv, an API/worker/fetcher bundle that carries playwright-core or imports it other than by a lazy `import()`, or a fetcher/renderer bundle that carries `pg`) (used by `deploy-backend.yml`; CI's `test` job runs it on every commit; [deployment.md § Lambda bundles](../docs/deployment.md#lambda-bundles)) |
| `scripts/check-csp.mjs` | Refuses a frontend build whose inline scripts aren't all hashed in SvelteKit's meta CSP (used by `deploy-frontend.yml`) |
| `scripts/restore-db.sh` | Point-in-time or snapshot restore into this stack's network and parameter group, identifier swap and Terraform state move; dry run by default ([deployment.md § Restoring the database](../docs/deployment.md#restoring-the-database)). Tested against a fake `aws` + `terraform` + `sops` (`restore-db.test.mjs`, `restore-db-stubs/`; `pnpm test:guards`) |
| `certs/rds-global-bundle.pem` | RDS CA bundle shipped in every zip |
| `prod.sops.yaml.example` | The key list for the private secrets file |
| `tests/guardrails.tftest.hcl` | Plan-only `terraform test` against mocked providers (51 runs; see [Validating locally](#validating-locally)) |

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
| `water_app` password | sops `db_app_password` → the API's and worker's runtime secrets (`DATABASE_URL`) + the migrate Lambda's (`WATER_APP_PASSWORD`) | **No.** Ephemeral variable → write-only value |
| `AUTH_JWT_SECRET` | sops `auth_jwt_secret` → the API's and worker's runtime secrets (the worker's re-run job stamps the runs it stores) | **No.** Ephemeral variable → write-only value |
| Alert unsubscribe-token secret | sops `alerts_token_secret` → the worker's runtime secret | **No.** Ephemeral variable → write-only value |
| CloudFront shared secret | `random_password` → the API's runtime secret (write-only), and CloudFront's origin header | **Yes**, in `random_password.cloudfront_shared_secret` and the distribution: `custom_header` isn't a write-only argument |

**No secret sits in a Lambda's environment** (issue #126). Environment
variables come back in plain text from `lambda:GetFunctionConfiguration`,
which the deploy role holds and AWS's `ReadOnlyAccess` grants, so any reader
could have forged a session. Instead `secrets.tf` gives each of the API,
worker and migrate Lambdas its own Secrets Manager secret
(`water-management/runtime/<role>`), a JSON object with exactly the keys that
Lambda uses, and its environment holds only `RUNTIME_SECRET_ARN` and
`RUNTIME_SECRET_VERSION`. `backend/src/config/runtimeSecrets.ts` reads it once
per cold start, before the config checks, and refuses to start on a missing
or extra key. One secret per Lambda rather than one shared, so each role reads
only what it uses: the worker never holds the CloudFront secret, the API never
holds the unsubscribe key, migrate holds only the password it sets. The fetcher
and renderer hold no secret. The residual copy outside Secrets Manager is the
CloudFront secret in the distribution's origin header, readable with
`cloudfront:GetDistributionConfig`; it only lets a caller past the WAF to the
Function URL, where the app's own auth still applies.

**No sops value sits in Terraform state or a saved plan** (issue #126).
`scripts/tf.sh` runs Terraform under `sops exec-env`, which hands each key
over as an ephemeral variable (`TF_VAR_<key>`; Terraform never persists an
ephemeral value), and those variables reach only `secret_string_wo`, the
write-only argument of each runtime secret's version (Terraform sends it to
AWS and keeps no copy; the tftest checks the plan holds no `secret_string`
and that the values are ephemeral). Because nothing is stored,
Terraform can't see a changed sops value: `runtime_secret_version`
(`secret_string_wo_version`) is the signal to write again, and `tf.sh` derives
it from the sops file's plaintext `sops.lastmodified` (awk over the `sops:`
block, nothing decrypted for it), so every sops edit rotates by itself
([§ Rotating secrets](#rotating-secrets)). Needs Terraform 1.11+ and the AWS
provider's 6.x line, both pinned in `main.tf`.

Why variables rather than the carlpett/sops provider's `ephemeral
"sops_file"`: Terraform's test mocks can't open an ephemeral resource before
1.17 (hashicorp/terraform#38928), and the whole mocked suite runs through
`secrets.tf`. Once `.terraform-version` is 1.17+, an ephemeral `sops_file`
(mocked with `mock_ephemeral`) could replace `tf.sh`.

**What stays in state:** the CloudFront shared secret, twice (the
`random_password` and the distribution's origin header). The header argument
isn't write-only, so no ephemeral source could reach it. A reader of state
could call the Function URL directly, past the WAF, where the app's own auth
still applies; it can't forge a session. The state bucket is SSE-encrypted,
private to this account, and versioned, and **old state versions written
before this change still hold the earlier plaintext** (the sops values, the
old alert-token secret): the stack isn't deployed yet, so there are none;
if it had been, rotating each sops value once after this change would retire
them.

This follows the estate. project-flakey uses the same RDS-managed master plus
app secrets from sops. The master is kept out of state because it is the one
credential that bypasses RLS. The cost of that choice is the Secrets Manager
VPC endpoint (~$7.30/month). The alternative, a sops-supplied master password
in the migrate Lambda's env, would save that but put the owner credential in
the Lambda config. The runtime secrets now share that endpoint.

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
notify a topic in its own region; the budgets and Cost Anomaly Detection use
the us-east-1 one ([§ Budget alerts](#budget-alerts)).

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
  accepted risk; CSS can't run script). One third-party origin pair only:
  once `waf_captcha_integration_url` is set, `script-src` and `connect-src`
  (header and meta) add the account's CAPTCHA SDK origin and its challenge
  script's, and `media-src` allows `data:` for the puzzle's audio (the
  sign-in CAPTCHA below; docs/security.md § Sign-in CAPTCHA).
- **Sign-in CAPTCHA** (`waf.tf` `SignInCaptchaPerIP`, priority 1 between the
  auth block and the site-wide limit): a rate-based rule on `POST
  /api/auth/login` (decoded, normalised, lower-cased path) whose action is
  `CAPTCHA` past `waf_signin_captcha_per_5min` (default 20, 10–99) per IP in
  5 minutes, immunity 300 s; `waf_signin_captcha_action = "COUNT"` is the
  switch-off. `aws_wafv2_api_key.captcha` (us-east-1, CloudFront scope,
  token domain `var.domain_name`) is the CAPTCHA JavaScript API key; outputs
  `waf_captcha_script_url` and `waf_captcha_api_key` (sensitive) feed the
  frontend build. The integration URL isn't a Terraform attribute (the ACL's
  `application_integration_url` is only filled for the ATP/ACFP rule groups),
  so it is a variable, read once with `aws wafv2 list-api-keys`.
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
| Secrets Manager (the RDS master secret + the API, worker and migrate runtime secrets, `secrets.tf`; reads are one per cold start, $0.05 / 10,000) | 1.60 |
| WAF: ACL + 4 rules (+ $0.60 / 1M requests; CAPTCHA solves $0.40 / 1,000, only under pressure) | 9.00 |
| Route 53 child zone (bootstrap-owned, billed here) | 0.50 |
| KMS `alias/water-management-sops` (bootstrap-owned) | 1.00 |
| CloudWatch: 35 alarms (incl. the CloudFront request-flood and WAF blocked-requests alarms in us-east-1, the self-check-failed, mail-send-failed, unhandled-error, login-failed and job-dead log metric filters, the jobs backlog, alert-storm and alert-mail-failure embedded metrics, worker throttles, the worker heartbeat and tick-delivery failures, the two feed DLQs and fetcher errors, the two render DLQs, renderer errors and duration, the mail-events DLQ), logs, RDS log export | ~3.50 |
| Budgets (monthly + daily: an account's first two are free) and Cost Anomaly Detection (free) | 0 |
| CloudFront (PriceClass_All), CF Functions, S3, Lambda (incl. the fetcher: a daily CHIRPS feed is ~5 s at 512 MB; the renderer: ~5 s at 2 GB ≈ $0.0002 a PDF) | ~0 (free tiers; Lambda at 1 GB × 10k s ≈ $0.13) |
| **Total** | **≈ $53** (the data feeds added ≈ $0.70, server-side reports ≈ $1.00–1.20, the runtime secrets $1.20, the site-wide backstop and sign-in CAPTCHA rules $1.00 each) |

**Request charges have no ceiling.** Every request the WAF allows costs WAF
$0.60/M plus CloudFront $0.010 per 10k HTTPS ($1.00/M at US/EU edges, ~$2.20/M
at Africa's), $1.60–2.80 per million; one it blocks costs the WAF's $0.60/M
only (CloudFront doesn't bill WAF-blocked requests). The per-IP rate limits
(`waf.tf`: 100 on `/api/auth/*`, `waf_rate_limit_per_ip` on `/api/*`, and
`waf_site_rate_limit_per_ip`, default 5,000, on every path) stop one client,
not a botnet keeping each IP under them. The API's limit doesn't count the
SPA's files, so a cold visit (~150 of them) and the report renderer (which
loads the SPA for every PDF from a few shared Lambda addresses) don't eat
it; the site-wide backstop is there because an unlimited static site would
let one IP run up allowed-request charges until someone acts on the alarm
below, and its default blocks one IP at that alarm's own threshold. A
renderer blocked by any of them is retried with backoff (a WAF `403` has no
`render_token_refused` code, `backend/src/reports/render.ts`), not failed.
A botnet at 1,000 requests
a second costs ~$140–240 a day. Nothing can cap that without dropping the CSP (the
CloudFront flat-rate plans), so it is alarmed instead, in us-east-1:
`cloudfront-requests` fires on the first 5 minutes over
`cloudfront_requests_alarm_per_5min` (default 5,000, ~20× a busy 5 minutes
for a handful of users: ~250 requests). A flood just under it is 16.7 req/s =
1.44M a day = $2.30–4.03 a day unseen, 3–5% of the $80 budget; a 1,000 req/s
flood is 60× the threshold and fires in the first period. The variable is held
to 1,000–20,000 (at 20,000 an unseen flood costs $9–16 a day).
`waf-blocked-requests` fires on more than 100 blocks in each of three
5-minute periods: an attack persisting, or a real client (the renderer, an
office NAT) stuck behind a limit. What to do: [docs/deployment.md §
Runbooks](../docs/deployment.md#runbooks), Request flood.

**af-south-1** has higher RDS, endpoint and storage rates (roughly +25–35%),
which comes to **≈ $58–63/month**. Check the AWS pricing calculator before
you commit to it. The default `budget_monthly_usd = 80` is set for
af-south-1: its ACTUAL 80% alert ($64) sits just above that idle, so it
doesn't fire every month (in us-east-1, ~60 is enough). See
[§ Budget alerts](#budget-alerts). Main levers: the three endpoint AZ counts
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

### Budget alerts

All of these publish to the **us-east-1** alerts topic (`alarms.tf`), not the
regional one: af-south-1 is an opt-in region, and AWS documents Budgets → SNS
only as "same account". Billing data refreshes at least daily, so each one
lags spend by up to a day; the Lambda concurrency caps and the CloudWatch
alarms are what bound and report a runaway while it happens.

| Alert | Fires when | Notes |
| --- | --- | --- |
| Daily budget, ACTUAL 100% | a single day costs more than `budget_daily_usd` (default `ceil(budget_monthly_usd × 2.25 / 30)` = **$6** on $80, ~3× af-south-1's ~$2/day idle) | The first-month guard: works from day one. Daily budgets support ACTUAL only, no FORECASTED. At most one mail a day. |
| Monthly, ACTUAL 80% | the month's spend passes $64 (on $80) | Early warning, set above the idle so it doesn't fire every month. |
| Monthly, ACTUAL 100% | the month's spend passes the budget | |
| Monthly, FORECASTED 100% | AWS forecasts the month past the budget | Needs ~5 weeks of cost history, so it is silent through the first month. |
| Cost Anomaly Detection | one service's spend jumps, total impact ≥ `cost_anomaly_threshold_usd` (off by default; set $10 after the first apply, [§ Operator steps](#operator-steps) step 11) | AWS-services monitor, free, needs ~10 days of history. Off for the first apply because an account holds one services monitor and AWS may have made it already. |

Each topic's policy admits only this account (`aws:SourceAccount`, plus
`aws:SourceArn` on CloudWatch's `…:alarm:*` and Budgets' `arn:aws:budgets::<acct>:*`,
as AWS's docs show; Cost Anomaly Detection's documented example uses
`aws:SourceAccount` alone), so another account's alarm or budget can't
publish through it.

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
   `budget_monthly_usd = 0` (skips both budgets). Cost Anomaly Detection is
   off by default (`cost_anomaly_threshold_usd = 0`), so the first apply
   can't fail on an existing monitor; step 11 turns it on.
4a. **SES endpoint service check** (read-only, before the first plan): confirm
   the SES API endpoint service exists in the region (it launched Dec 2025):
   `aws ec2 describe-vpc-endpoint-services --service-names com.amazonaws.<region>.email --region <region> --profile water-management --query 'ServiceDetails[].ServiceName'`.
   An empty result means the apply would fail on `aws_vpc_endpoint.ses`.
5. **Secrets** in the private repo. The key list is in
   [`prod.sops.yaml.example`](./prod.sops.yaml.example). Generate the values
   with `openssl rand -hex 32` (JWT, alert-token secret) and
   `openssl rand -hex 24` (db password) inside the editor.
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
   - `mkdir -p -m 700 ~/.cache/water-management && cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh plan -var-file=../../infra-secrets/water-management/prod.tfvars -out="$HOME/.cache/water-management/prod.tfplan"`
   - `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh apply "$HOME/.cache/water-management/prod.tfplan" && rm -f "$HOME/.cache/water-management/prod.tfplan"`

   `tf.sh` decrypts `prod.sops.yaml` in memory and passes the runtime secrets
   as ephemeral variables; the apply needs them again (a saved plan doesn't
   keep them), which is why it goes through `tf.sh` too. A saved plan no
   longer holds the sops values, but it still holds a copy of state, and so
   the CloudFront shared secret, so it is still written outside the repo and
   deleted once applied. If you don't apply it, delete it
   yourself: `rm -f ~/.cache/water-management/prod.tfplan`. `.gitignore`
   also ignores `*.tfplan` as a backstop.

   The first apply takes ~20 minutes (RDS plus CloudFront). Confirm **both**
   SNS email subscriptions afterwards: the regional topic and the us-east-1
   topic (the us-east-1 one carries every budget and cost-anomaly alert).
   `budget_alert_email` is required and must be a real mailbox; plan
   refuses an empty, malformed or reserved (`example.com` etc.) address.
   Then check that the budgets accepted the topic (no "Invalid SNS topic"
   in the console, or `aws budgets describe-notifications-for-budget --account-id <acct> --budget-name water-management-daily --profile water-management`
   answering without an error).
8a. **SES: verify, then leave the sandbox.** The DKIM, MAIL FROM and DMARC
   records are created by the apply; the identity turns `SUCCESS` once DNS
   propagates (minutes to an hour):
   `aws sesv2 get-email-identity --email-identity water-management.jaredhoward.com --region <region> --profile water-management --query '{dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus,verified:VerifiedForSendingStatus}'`.
   A new account is in the **SES sandbox** (200 emails/day, 1/s, and only to
   *verified* addresses), which Terraform can't change. Request production
   access — it is a human review by AWS, usually within a day:
   `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://water-management.jaredhoward.com --use-case-description "Transactional account email only (email verification, password reset, project invitations) for a low-volume B2B water-modelling tool; no marketing. Bounces and complaints go to the SES suppression list and CloudWatch alarms." --contact-language EN --region <region> --profile water-management`.
   Until it is granted, verify your own address to test
   (`aws sesv2 create-email-identity --email-identity you@example.com --region <region> --profile water-management`):
   mail to it goes through (the send policy allows the recipient's identity,
   which the sandbox checks). Mail to any other address fails with
   `MessageRejected`, the request still answers normally, and the
   `mail-send-failed` alarm fires; expected until production access is
   granted (docs/deployment.md § Email). Check with `aws sesv2 get-account --region <region> --profile water-management --query ProductionAccessEnabled`.
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
10b. **SES suppression through the endpoint** (after the first backend
    deploy; issue #126). Step 4a only proves the SES API endpoint service
    exists; it doesn't prove the endpoint carries the SESv2
    `DeleteSuppressedDestination` call the API makes when someone turns
    alert emails back on (`POST /me/alerts/resume`,
    `backend/src/mail/suppression.ts`), or that it honours the endpoint
    policy's `ApiReleasesSuppressedAddress` statement (`ses.tf`). Put a test
    address you own on the suppression list
    (`aws sesv2 put-suppressed-destination --email-address <you> --reason BOUNCE --region <region> --profile water-management`),
    sign in as that account, turn alert emails back on, then check it's gone:
    `aws sesv2 get-suppressed-destination --email-address <you> --region <region> --profile water-management`
    should answer `NotFoundException`. If the resume request fails instead
    (a 500, and an `AccessDenied` or timeout for `DeleteSuppressedDestination`
    in the API's log), the endpoint doesn't carry the call: until that's
    fixed, take an address off the list by hand after someone turns mail
    back on (`aws sesv2 delete-suppressed-destination --email-address <address> --region <region> --profile water-management`),
    and record the finding in #126. The same applies if the first apply
    rejects the endpoint policy itself (the endpoint service not supporting
    custom policies): note it on #126 before removing the `policy` argument.

11. **Turn on Cost Anomaly Detection** (after the first apply; it needs ~10
    days of billing history before it flags anything, so nothing is lost by
    doing this in the first week or two). An account may hold only one
    AWS-services monitor, and AWS creates a default one for some new Cost
    Explorer users, so check first:
    `aws ce get-anomaly-monitors --region us-east-1 --profile water-management --query 'AnomalyMonitors[].[MonitorName,MonitorType,MonitorDimension,MonitorArn]'`.
    - **No `DIMENSIONAL` / `SERVICE` monitor listed:** set
      `cost_anomaly_threshold_usd = 10` in `prod.tfvars`, then plan and apply
      (step 8). The plan adds `aws_ce_anomaly_monitor.services[0]` and its
      subscription to the us-east-1 alerts topic.
    - **One is listed:** set `cost_anomaly_threshold_usd = 10`, adopt it
      before planning:
      `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh import -var-file=../../infra-secrets/water-management/prod.tfvars 'aws_ce_anomaly_monitor.services[0]' <MonitorArn>`,
      then plan. It should show the monitor renamed in place (to
      `water-management-services`) and the subscription added; if it shows
      the monitor replaced, stop and ask. AWS's default monitor may come with
      its own subscription (it emails the account's root address): list them
      with `aws ce get-anomaly-subscriptions --region us-east-1 --profile water-management --query 'AnomalySubscriptions[].[SubscriptionName,SubscriptionArn]'`,
      and delete the default one once ours is applied, if you don't want both
      (`aws ce delete-anomaly-subscription --subscription-arn <arn> --region us-east-1 --profile water-management`).
    - Either way, confirm afterwards: the first command lists one monitor,
      `water-management-services`.

### Rotating secrets

Every secret below reaches its Lambdas through their runtime secrets
(`secrets.tf`), written write-only: Terraform keeps no copy, so **it can't
tell that a sops value changed** by itself. `tf.sh` gives it the signal:
it sets `runtime_secret_version` from the sops file's `sops.lastmodified`
(`YYYYMMDDhhmmss`; plaintext metadata sops rewrites on every edit), so a sops
rotation is two steps: edit the value with sops, apply through `tf.sh`. The
new counter replaces every runtime secret's version, which changes
`RUNTIME_SECRET_VERSION` in each Lambda's configuration, so every running
instance is replaced by a cold start that reads the new value: there is no
separate restart step. A value changed by hand in the console is **not**
picked up (each Lambda reads the version Terraform pinned); change it at its
source and apply instead.

- **Forced rewrite of unchanged values:** add
  `-var runtime_secret_version=$(date -u +%Y%m%d%H%M%S)` to the apply (or
  export `TF_VAR_runtime_secret_version`, which `tf.sh` then leaves alone).
  The next plain run returns to `lastmodified` and rewrites once more.
- **Never set `runtime_secret_version` in `prod.tfvars`** (or any var file):
  Terraform ranks var files above `tf.sh`'s value, so it would pin the
  counter and silently stop rotation. `tf.sh` refuses to run if one does.

The apply, for any of the sops keys:
`cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh apply -var-file=../../infra-secrets/water-management/prod.tfvars`

- **`db_app_password`:** edit it with sops, apply, and invoke the migrate Lambda straight away. The API fails DB logins
  until you do:
  `aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{}' --cli-read-timeout 320 --region <region> --profile water-management /dev/stdout`
- **`auth_jwt_secret`:** edit it with sops, apply. Everyone is signed out.
- **`alerts_token_secret`** (WP-2.13, the worker only): only if it leaked,
  since every unsubscribe link in alert emails already sent stops working
  ("Manage your alerts" still does). Edit it with sops, apply. The alert kill switch is
  `alerts_enabled = false` (docs/deployment.md § Runbooks, alert storm).
- **CloudFront shared secret** (not in sops: replacing it rewrites the runtime
  secrets in the same apply, `replace_triggered_by` in `secrets.tf`):
  `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh apply -var-file=../../infra-secrets/water-management/prod.tfvars -replace=random_password.cloudfront_shared_secret`
  (a few seconds of 403s while CloudFront and Lambda converge).
- **`cloudfront_private_key`** (report download links, the API only): an
  RSA key pair the operator generates; the public half is
  `report_download_public_keys` in `prod.tfvars`. Rotate with two keys
  overlapping (add the new public key and apply; put the new private key in
  sops and point `report_download_signing_key` at it, apply; drop the old
  public key, apply), so no valid link fails. The API refuses to start if
  the sops key and the signing public key aren't a pair. Commands and
  details: docs/deployment.md § The report-download signing key.
- **RDS master:** RDS rotates it automatically. Nothing reads it except the
  migrate Lambda, which fetches it on every run.

### Database access and recovery

- There is **no interactive access path** by design: no bastion, no public
  endpoint. Schema changes go through migrations. For a one-off
  investigation, the least-effort option is a temporary SSM-managed EC2
  instance in a private subnet. That needs the `ssm`, `ssmmessages` and `ec2messages`
  endpoints (~$22/month while they exist), so remove them afterwards.
- **Point-in-time restore** creates a *new* instance, and by default puts it
  in the default subnet group, security group and parameter group with no
  deletion protection. Use `scripts/restore-db.sh` (dry run by default,
  `--execute` to run): it restores into this stack's groups (read from the
  `db_*` outputs), turns RDS-managed master credentials back on (a PostgreSQL
  restore drops them: new secret, new ARN), checks the copy, swaps
  identifiers (old → `water-management-old-<ts>`), and moves
  `aws_db_instance.main` in state with `state rm` + `import`, since the
  provider tracks the instance by `DbiResourceId` and a swap alone would
  leave state on the old one. It plans but never applies or deletes. RPO is
  ~5 minutes. The runbook, the sources and the rehearse-once checklist:
  [docs/deployment.md § Restoring the database](../docs/deployment.md#restoring-the-database).

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
no owner credentials, the 5-minute tick, its invoke permission and its
zero-retry, 300-second-maximum-age delivery (EventBridge target and Lambda
async config), the SQS
event source, the SQS endpoint's policy naming only the two roles and the
six queues (jobs, fetch-requests, ingest-results, render-requests,
render-results, mail-events), one per statement, and the deploy role's right to update the worker); the data-feed
stack (both queues' SSE, DLQs and visibility; the fetcher outside the VPC, its
size and concurrency, an environment with no database URL, a role on the two
feed queues only; the worker's `FEED_FETCHER=sqs` and its event source; the
API kept to the jobs queue through the endpoint; the deploy role's right to
update the fetcher); every alarm
wired to SNS, including the `self_check_failed` log metric filters (pattern
and metric name, on both the API and worker log groups) and its alarm, and
the `mail_send_failed` filters (both log groups) and alarm, and the
`unhandled_error` filter (the API's log group, the API's unhandled 500s the
Lambda `Errors` metric can't see) and alarm, and the `login_failed` filter
(the API's log group: failed credential checks across all accounts, which the
per-address lockout can't sum) and its alarm (more than 30 in one 15-minute
period by default); the us-east-1 alarms
(`cloudfront-5xx`, `cloudfront-requests`, `waf-blocked-requests`) wired to the
us-east-1 topic, with the request-flood alarm's metric, dimensions and 5,000
threshold and the WAF alarm's `BlockedRequests` on the ACL's metric name with
`Rule = ALL`, over 100 in 3 of 3 periods; the SES send
policy (`identity/*` in this account and region + the configuration set,
single statement, `ses:FromAddress` pinned); the RDS parameter group logging
no bind values (`log_parameter_max_length(_on_error) = 0`), TLS forced and
`log_statement = none`; the worker heartbeat (< 1 invocation in
15 minutes, missing data breaching) and the tick rule's `FailedInvocations`
alarm; the budgets (monthly $80 with FORECASTED 100% / ACTUAL 80% / ACTUAL
100%, the derived $6 daily ACTUAL 100%, all to the us-east-1 topic), the
Cost Anomaly Detection monitor and subscription (off by default,
`anomaly_detection_off_by_default`; on at a threshold, `anomaly_detection_on`), and both alert topics'
policies (one service per statement, each pinned by `aws:SourceAccount`,
CloudWatch and Budgets also by `aws:SourceArn`), with runs for the derived
and explicit daily amounts and for switching each off, and five negative runs
(a daily amount not below the monthly, a daily budget with no monthly, and a
negative daily, monthly or anomaly threshold); the deploy policy having no
wildcards; and the
deploy role's trust postcondition, with negative runs for a branch subject, a
`StringLike` wildcard and another repo (and a positive run for GitHub's
immutable-claims subject). Three more negative runs check that a short
`auth_jwt_secret`, a non-alphanumeric `db_app_password` and an invalid
`dmarc_policy` fail the plan, and one that a `jobs_backlog_alarm_seconds`
below two ticks does; two more refuse a `cloudfront_requests_alarm_per_5min`
outside 1,000–20,000, and two a `login_failed_alarm_per_15min` outside
10–300 (below 10 one person locking themselves out pages; above 300 one IP at
the WAF's auth limit stays unseen). Another six refuse an alert mailbox nobody reads:
`budget_alert_email` is required, and an empty, malformed or reserved
address fails the plan (example.com/.org/.net and their subdomains, and the
`.example`, `.test`, `.invalid` and `.localhost` TLDs of RFC 2606 / RFC 6761,
in any case); `dmarc_report_email` may be empty but is held to the same rule
when set. A positive control (`accepts_real_alert_mailboxes`) accepts a
domain that only contains "example". The suite's own address is at the
site's domain, since the rule refuses every reserved one. Six more refuse an unreserved (`-1`) concurrency on each
Lambda and a worker cap below the sum of its SQS triggers'
`maximum_concurrency`; `worker_sqs_triggers` pins that sum against the planned
mappings, `ReportBatchItemFailures` on every worker trigger and the worker
throttles alarm; and `waf_auth_rule_matches_decoded_path` pins the auth rate
limit's `URL_DECODE` → `NORMALIZE_PATH` → `LOWERCASE` transformations (so
`/api/%61uth/login` can't slip past it); `waf_rate_rules_scope` pins the API
rule to `/api/` (same transformations), the unscoped site-wide backstop, the
three limits and their order, and `rejects_site_rate_limit_below_the_api_limit`
the variables' ordering. `signin_captcha` pins the sign-in
CAPTCHA: the rule order (auth block, CAPTCHA, API, site-wide), its `CAPTCHA`
action, the 300 s immunity, the 20-per-5-minute per-IP limit below the
block's, the scope (`POST` and exactly `/api/auth/login`, same three
transformations), the API key's CloudFront scope and site-only token domain,
and a CSP with no WAF origin (but `media-src 'self' data:`) and an empty
script URL until the integration URL is set;
`signin_captcha_with_integration_url` checks that `script-src` and
`connect-src` then add exactly the two SDK origins (no wildcard,
`unsafe-eval` or `blob:`) and the script URL is its `jsapi.js`;
`signin_captcha_count_mode` checks the COUNT switch-off; and four more refuse
a limit of 100 or 9, an action other than CAPTCHA/COUNT and a wildcard
integration URL. The `network` run pins the
private-only VPC: no internet, egress-only or NAT gateway, Elastic IP,
`aws_route`, VPN, peering or transit attachment anywhere in the module, no
`0.0.0.0/0` or `::/0` string, no inline route on the private route table
(both subnets associated with it) and no public IPs on launch; security-group
rules that reference security groups only (no CIDR, prefix list, inline block
or `aws_security_group_rule`) and form exactly the expected graph, ingress and
egress, ports included (read from the source, since a test can't enumerate
resources); the DB in its own group, reachable on 5432 only from the API,
migrate and worker Lambda groups; each in-VPC Lambda in its own group and the
fetcher outside the VPC (the renderer's no-VPC pin is in its reports run);
the Function URL's `NONE` auth type with `InvokeFunction` allowed only via the
URL; and every security group's description, verbatim and within AWS's
character set, because changing one replaces the group.
Terraform is pinned in `.terraform-version` (tfenv) and providers are pinned in
the committed `.terraform.lock.hcl` (linux_amd64, linux_arm64, darwin_arm64).

## Tearing down

`deletion_protection` must be turned off first (set it to `false`, then
apply). `terraform destroy` then leaves a final snapshot
`water-management-final`. The tfstate bucket, the KMS key, the child zone and
the deploy role belong to the bootstrap and survive.
