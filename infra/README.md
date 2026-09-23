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
                                                                                      │ water_app, TLS verify-full
                                   deploy-backend.yml ──invoke──► migrate Lambda ─────┤
                                                                   │ owner creds       ▼
                                                   Secrets Manager ◄┘ (VPC endpoint)  RDS PostgreSQL 17
                                                   (RDS-managed master secret)        db.t4g.micro, single-AZ
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
  add `basePath('/api')` in the app.**
- **SPA deep links.** The `spa_rewrite` function serves `/index.html` with a
  200 for any path whose last segment has no file extension
  (`/projects/<id>`). There is deliberately **no** distribution-wide
  `custom_error_response`, because that would also turn the API's own 403/404
  JSON into `index.html`.
- **Private-only VPC.** Two private subnets with no internet gateway, no NAT
  and no public subnet. Nothing needs the internet. The API makes no outbound
  calls, and Lambda log delivery doesn't go through the function's ENI. The
  only AWS API the VPC needs is Secrets Manager, and only the migrate Lambda
  uses it, through one interface endpoint whose policy allows reading the RDS
  master secret and nothing else. If a future feature needs egress, add the
  matching VPC endpoint for an AWS service. Reach for a NAT (~$33/month) only
  for genuinely external hosts.
- **Two Lambdas.** `water-management-backend` is the API. It connects as the
  RLS-bound `water_app` role, with memory 1024 MB, a 30 s timeout and reserved
  concurrency 10. `water-management-migrate` (`backend/src/lambda-migrate.ts`)
  reads the owner credentials at run time, creates or re-passwords
  `water_app`, and applies `backend/migrations/*.sql`. It has 512 MB, a 300 s
  timeout, reserved concurrency 1 and no URL.
- **TLS to RDS** is `sslmode=verify-full` (chain + hostname). Both zips carry
  `infra/certs/rds-global-bundle.pem` (the public AWS RDS CA bundle from
  `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`), and
  `NODE_EXTRA_CA_CERTS` points Node at it. `rds.force_ssl = 1` in the
  parameter group.

## Files

| File | What |
| --- | --- |
| `main.tf` | Versions, S3 backend (partial), providers (`aws`, `aws.us_east_1`), tags |
| `variables.tf` | Inputs. Only `aws_region`, `route53_zone_id` and `github_repo` are required |
| `secrets.tf` | `data "sops_file"` → `../../infra-secrets/water-management/prod.sops.yaml` |
| `network.tf` | VPC, 2 private subnets, security groups, Secrets Manager endpoint |
| `rds.tf` | Subnet group, pg17 parameter group, log group, the DB instance |
| `lambda.tf` | IAM roles, log groups, API Lambda + Function URL + permissions, migrate Lambda |
| `s3_cloudfront.tf` | Frontend bucket, ACM cert (us-east-1), CF Functions, distribution, A/AAAA records |
| `waf.tf` | Web ACL with 2 per-IP rate rules (`/api/auth/*`: 100/5 min; site-wide: `waf_rate_limit_per_ip`) |
| `alarms.tf` | SNS topics (regional + us-east-1), budget, Lambda/RDS/CloudFront alarms |
| `oidc.tf` | Looks up the bootstrap deploy role and attaches the per-resource deploy policy |
| `outputs.tf` | Values pushed to GitHub by `export-tf-vars.sh` |
| `scripts/package-lambdas.sh` | Builds + zips both Lambdas (used by `deploy-backend.yml`) |
| `certs/rds-global-bundle.pem` | RDS CA bundle shipped in both zips |
| `prod.sops.yaml.example` | The key list for the private secrets file |
| `tests/guardrails.tftest.hcl` | Plan-only `terraform test` against mocked providers |

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
10 concurrent containers × a `pg` pool of 5 = 50, plus the migrator. RDS
Proxy isn't used: its minimum bill (~$22/month) is more than the DB at this
scale. An alarm fires at 60 connections.

### Secrets: estate pattern (private `infra-secrets` + sops), RDS-managed master

| Secret | Source | In Terraform state? |
| --- | --- | --- |
| RDS master (`water`, schema owner) | `manage_master_user_password`: RDS generates it, stores it in Secrets Manager and rotates it (every 7 days by default) | **No.** Only the migrate Lambda reads it, at run time |
| `water_app` password | sops `db_app_password` → API `DATABASE_URL` + migrate `WATER_APP_PASSWORD` | Yes |
| `AUTH_JWT_SECRET` | sops `auth_jwt_secret` → API env | Yes |
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

`aws_region` has no default. **af-south-1 (Cape Town)** is the natural choice
for a South African client (POPIA data residency, ~20 ms rather than ~230 ms
RTT), but it is an opt-in region and costs more (see [Cost](#cost)).
**us-east-1** is the cheapest. The ACM certificate, WAF, the CloudFront alarm
and its SNS topic are always in us-east-1, and so is the tfstate bucket. The
two SNS topics exist because a CloudWatch alarm can only notify a topic in its
own region.

### Smaller calls

- **arm64 Lambdas**, ~20% cheaper per GB-s. The bundle is pure JS (`bcryptjs`,
  not native bcrypt).
- **No www alias.** `www.water-management.jaredhoward.com` isn't worth a SAN,
  records and a redirect.
- **Managed SecurityHeadersPolicy** on both behaviours: HSTS, nosniff,
  frame-options, referrer-policy. There is no CSP yet, because SvelteKit's
  inline bootstrap script would need a hash.
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
| Secrets Manager (RDS master secret) | 0.40 |
| WAF: ACL + 2 rules (+ $0.60 / 1M requests) | 7.00 |
| Route 53 child zone (bootstrap-owned, billed here) | 0.50 |
| KMS `alias/water-management-sops` (bootstrap-owned) | 1.00 |
| CloudWatch: 10 alarms, logs, RDS log export | ~1.50 |
| CloudFront, CF Functions, S3, Lambda | ~0 (free tiers; Lambda at 1 GB × 10k s ≈ $0.13) |
| **Total** | **≈ $32** |

**af-south-1** has higher RDS, endpoint and storage rates (roughly +25–35%),
which comes to **≈ $38–42/month**. Check the AWS pricing calculator before
you commit to it. Main levers: `secretsmanager_endpoint_az_count = 1`
(the default), and dropping WAF, which is not recommended because it is the
spend and brute-force guard for the API. `budget_monthly_usd` defaults to
**50**.

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
3. **Lambda concurrency quota** (a new account has 10, and any reservation
   fails until it is raised; otherwise set both `*_reserved_concurrency = -1`):
   `aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000 --region <region> --profile water-management`
4. **Billing access for budgets.** As the account root: Account → "IAM user
   and role access to Billing information" → Activate. Until then, set
   `budget_monthly_usd = 0`.
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
   - `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform plan -var-file=../../infra-secrets/water-management/prod.tfvars -out=prod.tfplan`
   - `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform apply prod.tfplan`

   The first apply takes ~20 minutes (RDS plus CloudFront). Confirm **both**
   SNS email subscriptions afterwards: the regional topic and the us-east-1
   topic.
9. **Wire CI:** `cd ~/github/project-water-management && ~/github/templates/scripts/export-tf-vars.sh infra/`.
   This sets `AWS_REGION`, `FRONTEND_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`,
   `LAMBDA_FUNCTION_NAME`, **`MIGRATE_FUNCTION_NAME`** and `PUBLIC_SITE_URL`
   as variables, and `AWS_DEPLOY_ROLE_ARN` and `LAMBDA_FUNCTION_URL` as
   secrets.
10. **First deploy:** backend first (it runs `001_init` and creates
    `water_app`), then frontend:
    - `gh workflow run deploy-backend.yml`
    - `gh workflow run deploy-frontend.yml`

    Approve each in the `production` environment, then check with
    `curl -s https://water-management.jaredhoward.com/api/health`.

### Rotating secrets

- **`db_app_password`:** edit it with sops, apply, and invoke the migrate
  Lambda straight away. The API fails DB logins until you do:
  `aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{}' --cli-read-timeout 320 --region <region> --profile water-management /dev/stdout`
- **`auth_jwt_secret`:** edit it with sops and apply. Everyone is signed out.
- **CloudFront shared secret:**
  `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management terraform apply -var-file=../../infra-secrets/water-management/prod.tfvars -replace=random_password.cloudfront_shared_secret`
  (a few seconds of 403s while CloudFront and Lambda converge).
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

No AWS credentials are needed. Terraform 1.15's `validate` checks the S3
backend's required `bucket`, so point it at a local backend through a
gitignored override file first:
`cd ~/github/project-water-management/infra && printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf`

Then:
`cd ~/github/project-water-management/infra && terraform fmt -check -recursive && terraform init -backend=false && terraform validate && terraform test`

Delete `backend_override.tf` before any real `terraform init -backend-config=backend.config`.
Otherwise the override silently wins and state goes to a local file.
Terraform is pinned in `.terraform-version` (tfenv) and providers are pinned in
the committed `.terraform.lock.hcl` (linux_amd64, linux_arm64, darwin_arm64).

## Tearing down

`deletion_protection` must be turned off first (set it to `false`, then
apply). `terraform destroy` then leaves a final snapshot
`water-management-final`. The tfstate bucket, the KMS key, the child zone and
the deploy role belong to the bootstrap and survive.
