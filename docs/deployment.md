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
                                    CachingDisabled, all methods, cookies forwarded;
                                    invoke mode RESPONSE_STREAM)
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
  encrypted and has automated backups + PITR, deletion protection and
  Terraform's `prevent_destroy`. **Recovery point:** single-AZ (the minimal
  tier) can lose about the last **5 minutes** of writes, since a
  point-in-time restore reaches only as far as the transaction logs RDS
  uploads every five minutes (§ Restoring the database); Multi-AZ (the full
  tier) survives a lost host or AZ with no loss. **Changes wait for the
  maintenance window:** `apply_immediately = false`, so an instance or engine
  change in a Terraform apply (class, storage, a static parameter, an engine
  version) is only scheduled, and lands in the Sunday 01:30–02:30 UTC window
  (`aws rds describe-db-instances` shows it under `PendingModifiedValues`
  until then). Set it to `true` for one apply when a change can't wait. The API
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
| Idle cost (infra/README.md § Cost) | ≈ $59–64/month | ≈ $52–54/month | ≈ $51/month |
| SES sending reputation | Separate per region; a new account starts in the sandbox anywhere | same | same |

Tradeoffs of af-south-1 to accept: ~25–35% higher prices on RDS, endpoints
and storage (the default `budget_monthly_usd = 90` allows for them), the opt-in step, and a
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
from `example.tfvars` (`create_subdomain = true`) and keep
**`region = "us-east-1"`** in it, even though the workloads run in
af-south-1. The bootstrap creates the tfstate bucket and the sops KMS key in
that `region`, and this repo's Terraform backend reads state from us-east-1
only (`infra/main.tf`, `backend "s3"`; `sops-init.sh --region us-east-1`,
infra/README.md step 5). The example's comment offers opt-in regions such as
af-south-1: don't take it here, or `terraform init` looks for the bucket in
the wrong region. The workload region is `aws_region` in `prod.tfvars`
(§ 3). Then, from the templates repo:

```bash
cd ~/github/templates && ./scripts/new-project-account.sh water-management --plan
cd ~/github/templates && ./scripts/new-project-account.sh water-management
```

This creates, inside the org:

- the sub-account (`water-management-prod`, or the tfvars `account_name`)
- the tfstate bucket `water-management-tfstate-<account-id>` (us-east-1), locked with S3
  conditional writes (`use_lockfile = true`; **no DynamoDB lock table**)
- the KMS key `alias/water-management-sops` (us-east-1)
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
encrypted or not, and never in Terraform state or a saved plan either.
Terraform gets them through `infra/scripts/tf.sh`, which runs it under
`sops exec-env` (decrypted in memory; no plaintext file is written) and hands
each key over as an **ephemeral** variable (`TF_VAR_<key>`), never from tfvars.
Every `plan`, `apply` and `import` goes through `tf.sh`; `init`, `output` and
`state` commands don't need it. The operator runs the `sops` commands by hand.

```bash
cd ~/github/infra-secrets && ./bin/sops-init.sh --project water-management --region us-east-1
cd ~/github/infra-secrets && sops water-management/prod.sops.yaml
```

Keys this app needs:

| Key | Used for |
| --- | --- |
| `auth_jwt_secret` | `AUTH_JWT_SECRET` in the API's and worker's runtime secrets: signs session cookies, and keys the run stamps (security.md § Run stamps; rotating it leaves stored runs unverified) (≥ 32 random bytes) |
| `db_app_password` | The `water_app` role's password (RLS-bound runtime role; 24+ alphanumeric characters): in the API's and worker's `DATABASE_URL` and the migrate Lambda's `WATER_APP_PASSWORD`, each in that Lambda's runtime secret |
| `alerts_token_secret` | `ALERTS_TOKEN_SECRET` in the worker's runtime secret: signs the one-click unsubscribe links and the "Was this useful?" links in alert emails (32+ alphanumeric characters, `openssl rand -hex 32`). Rotating it breaks the unsubscribe link in every alert already sent, and the feedback links of the last 30 days |
| `app_encryption_key` | `APP_ENCRYPTION_KEY` in the API's runtime secret: seals two-step sign-in's TOTP secrets at rest (32+ alphanumeric characters, `openssl rand -hex 32`). Rotating it voids every authenticator ([§ Runbooks](#runbooks) 15) |
| `cloudfront_private_key` | `CLOUDFRONT_PRIVATE_KEY` in the API's runtime secret: signs report download links (CloudFront signed URLs). An RSA 2048 private key, PEM, as a YAML block scalar; its public half goes in `prod.tfvars` (`report_download_public_keys`, `report_download_signing_key`). Generating and rotating it: [§ The report-download signing key](#the-report-download-signing-key) |

The key list is `infra/prod.sops.yaml.example`. There is no `db_owner_password`
key: the owner/migration role always uses RDS-managed master credentials in
Secrets Manager (`manage_master_user_password`, [infra/rds.tf](../infra/rds.tf)),
read only by the migrate Lambda at run time
([infra/README.md § Decisions](../infra/README.md#decisions)).
The CloudFront shared secret is generated by Terraform
(`random_password.cloudfront_shared_secret`) and needs no manual step. It is
the one runtime value that stays in Terraform state: the CloudFront origin's
`custom_header` takes it, and that argument isn't write-only. A state reader
could call the Function URL directly, past the WAF, but not forge a session
([security.md § Runtime secrets](./security.md#runtime-secrets)).

None of these reach a Lambda's environment variables, which anyone allowed
`lambda:GetFunctionConfiguration` (the deploy role included) can read.
Terraform writes them into one Secrets Manager secret per Lambda
(`water-management/runtime/api`, `…/worker`, `…/migrate`; `infra/secrets.tf`)
as a **write-only** value (`secret_string_wo`), which it sends to AWS and
never stores, and each Lambda reads its own once per cold start
([security.md § Runtime secrets](./security.md#runtime-secrets)).

### Rotating a secret

Because Terraform keeps no copy of a write-only value, it can't see that a
sops value changed. The counter `runtime_secret_version` is what tells it to
write again, and `tf.sh` sets it for you: it reads the sops file's plaintext
`sops.lastmodified` (which sops rewrites on every edit, without decrypting
anything) and passes it as `YYYYMMDDhhmmss`. So:

- **A sops key** (`auth_jwt_secret`, `db_app_password`, `alerts_token_secret`,
  `app_encryption_key` (which voids every authenticator: § Runbooks 15);
  `cloudfront_private_key` also needs its public key moved, below):
  edit it with sops, then plan and apply through `tf.sh`. The edit moved
  `lastmodified`, so the plan replaces every runtime secret version.
- **The CloudFront header:** apply with
  `-replace=random_password.cloudfront_shared_secret`; the replacement
  rewrites the runtime secrets in the same apply.
- **Unchanged values, forced** (e.g. after a hand edit in the console):
  `-var runtime_secret_version=$(date -u +%Y%m%d%H%M%S)`. The next plain run
  goes back to `lastmodified`, which rewrites once more (a harmless cold
  start).

Don't put `runtime_secret_version` in a tfvars file: Terraform ranks var
files above `tf.sh`'s value, so it would pin the counter and silently stop
rotation. `tf.sh` refuses to run if one does.

The commands are in [infra/README.md § Rotating secrets](../infra/README.md#rotating-secrets).
Every one of these applies replaces every runtime secret's version (all three,
whichever key changed), so each Lambda's `RUNTIME_SECRET_VERSION` changes
with it. Changing a function's configuration retires its running instances,
so the next request or tick cold-starts onto the new value; there is no
separate restart. After `db_app_password`, invoke the migrate Lambda at once
(it sets the new password on `water_app`; the API and worker fail DB logins
until it has).

#### The report-download signing key

The API signs report download links with `cloudfront_private_key` (sops);
CloudFront trusts the public keys in `report_download_public_keys`
(`prod.tfvars`, name → PEM) through one key group, and
`report_download_signing_key` names the entry the private key belongs to.
First setup, and every rotation, generate the pair outside any repo:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out report-downloads.key && openssl pkey -in report-downloads.key -pubout
```

The second command prints the public key for `prod.tfvars`; the private key
goes into sops as `cloudfront_private_key` (a YAML block scalar), then delete
`report-downloads.key`. To rotate without a single failed download, overlap
the two keys:

1. **Trust the new key alongside the old.** Add the new public key to
   `report_download_public_keys` under a new name (e.g. `"2027-03"`), keep the
   old entry and `report_download_signing_key` as they are, and apply through
   `tf.sh`. The key group now trusts both; the API still signs with the old.
   Give CloudFront a few minutes to carry the key group to its edges.
2. **Put the new private key in sops** (`cloudfront_private_key`) and set
   `report_download_signing_key` to the new name.
3. **Apply through `tf.sh`.** The sops edit moved `lastmodified`, so the
   API's runtime secret is rewritten, and its `CLOUDFRONT_KEY_PAIR_ID` /
   `CLOUDFRONT_PUBLIC_KEY` move to the new key in the same apply (the function
   update waits for the key group). The API cold-starts signing with the new
   key; links it signed with the old one in the last minute still verify,
   because the old key is still trusted. Steps 2 and 3 must change both
   together: the API **refuses to start** when its private key isn't the
   private half of `CLOUDFRONT_PUBLIC_KEY` (the error names both settings),
   so a sops key without the matching `report_download_signing_key`, or the
   reverse, takes the API down until they agree.
4. **Drop the old key.** A minute after step 3 no valid link uses it: remove
   its entry from `report_download_public_keys` and apply.

Rotate if the private key may have leaked (sops or the API's runtime secret
read by someone who shouldn't have), not on a schedule. The private key is
never in Terraform state: it is an ephemeral variable that reaches only the
write-only runtime secret. The public keys are in state (CloudFront's
`encoded_key`), which is fine: they're public.

Don't edit a runtime secret in the console: each Lambda reads the version
Terraform pinned, so a hand edit is ignored until the next apply overwrites it.
If an instance must be forced onto a new version without an apply (it
shouldn't need to be), any configuration change does it, e.g.
`aws lambda update-function-configuration --function-name water-management-backend --description "cold start $(date -u +%FT%TZ)" --region <region> --profile water-management`.

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
`filter message.event = "mail_send_failed" | stats count() by message.kind, message.error`
(the Lambdas log in JSON, so the line sits under `message`; infra/lambda.tf
`lambda_logging`).
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

Besides the email settings, `lambda.tf` sets `ALLOWED_ORIGINS` (the site
origin), `COOKIE_SECURE=true`, `NODE_EXTRA_CA_CERTS` (the RDS CA bundle) and
`RUNTIME_SECRET_ARN` / `RUNTIME_SECRET_VERSION`, which name the API's runtime
secret: `DATABASE_URL` (as `water_app`, `sslmode=verify-full`),
`AUTH_JWT_SECRET`, `CLOUDFRONT_SHARED_SECRET` and `CLOUDFRONT_PRIVATE_KEY`
(the report-download signing key) come from there at cold start
([§ Rotating a secret](#rotating-a-secret)). `REPORT_DOWNLOADS=cloudfront`,
`CLOUDFRONT_KEY_PAIR_ID` (the signing public key's id) and
`CLOUDFRONT_PUBLIC_KEY` (its PEM, which the API checks its private key
against at cold start) are plain settings ([§ Reports](#reports)).

The release package (`infra/scripts/package-lambdas.sh`) bundles `nodemailer`
and `@aws-sdk/client-sesv2` into the API's `lambda.mjs` (~670 KB zipped,
~2.1 MB unzipped, minified: [§ Lambda bundles](#lambda-bundles)), so production sends mail with the lockfile's pinned SDK, not
the one the `nodejs24.x` runtime happens to ship. Both mail transports are
loaded lazily, only for the transport in use. The Secrets Manager client is
the exception: `backend/src/config/secretsManager.ts` imports
`@aws-sdk/client-secrets-manager` from the runtime on purpose (it isn't a
backend dependency), for the migrate Lambda's master secret and the API's,
worker's and migrate Lambda's runtime secrets.

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

Before the first plan, run the read-only pre-apply check (the Lambda
concurrency quota against the reservations, the state bucket and sops key in
us-east-1, the SES endpoint service, the RDS instance class, and a logging
CloudTrail trail recording KMS write management events in the region, which
the database KMS key alarm needs; PASS/FAIL per check, exit 1 on any FAIL;
infra/README.md § Operator steps, step 7a):

```bash
cd infra && ./scripts/preapply-check.sh --profile water-management --var-file ../../infra-secrets/water-management/prod.tfvars
```

```bash
cd infra && terraform init -backend-config=backend.config && ./scripts/tf.sh plan
```

The plan fails early, by design, if the bootstrap's deploy role trust policy
is not pinned to this repo's `production` environment (a postcondition in
`oidc.tf`), or if a sops secret is malformed or missing (the variables'
validations in `variables.tf`, and `tf.sh`, which names a missing key).

### Decide before the first apply

**The database's KMS key: `rds_customer_managed_key` (default `true`).**
Confirm it, or set `false` in `terraform.tfvars`, before the first apply.
It can't be changed on a live instance.

- `true`: a customer-managed key (CMK) encrypts the database, its logs,
  automated backups and snapshots (`infra/kms.tf`, `alias/water-management-rds`).
- `false`: RDS's AWS-managed `aws/rds` key, as before.

Why it's decided up front: RDS fixes an instance's key at creation. Changing
it later means a manual snapshot, a copy of it under the new key, and a
restore to a new instance with a new endpoint, plus downtime and a cut-over
([Encrypting Amazon RDS resources](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html),
[re:Post: change the key](https://repost.aws/knowledge-center/update-encryption-key-rds)).
Flipping the variable on a live stack would force that replacement, and the
instance's `prevent_destroy` refuses it at plan time.

Recommendation: **keep `true`.** This account is a sub-account in an AWS
Organization and holds personal information (farm names, contacts, sign-in
data). A CMK keeps these options open for about $1–3 a month:

| | CMK (`true`, default) | `aws/rds` (`false`) |
| --- | --- | --- |
| Cost | $1/month, +$1 at each of the first two yearly rotations (so $3 from year 3); RDS's key requests stay inside KMS's 20,000/month free tier ([KMS pricing](https://aws.amazon.com/kms/pricing/)) | free |
| Share a snapshot with another account (a restore test in another account, or handing the stack to the client's own AWS account) | yes, after adding that account to the key policy | no: "You can't share a snapshot that has been encrypted using the AWS managed key" ([Encrypting Amazon RDS resources](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html)); you'd first copy the snapshot under a CMK |
| AWS Backup cross-account copy (a backup vault in another Organization account, the defence against this account being compromised or closed) | yes, once the key is shared with the destination account | no: RDS needs a CMK "because AWS managed key policies are immutable and cannot be shared cross-account" ([AWS Backup: cross-account copies](https://docs.aws.amazon.com/aws-backup/latest/devguide/create-cross-account-backup.html)) |
| Audit and control | key policy limits use to RDS in this region and account (`kms:ViaService`, [RDS key management](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.Keys.html)); every use in CloudTrail; can be revoked | AWS controls the policy |
| Rotation | automatic, yearly (`enable_key_rotation`) | automatic, managed by AWS |
| Performance Insights (off today) | would use the same key; the PI key can't be changed once PI is on ([PI key policy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.access-control.cmk-policy.html)) | `aws/rds` |

**The risk a CMK adds is the key itself.** If the key is disabled, RDS stops
the instance about 2 hours later (`inaccessible-encryption-credentials-recoverable`).
Re-enabling the key and starting the instance within 7 days recovers it.
After that the instance is terminal, and a restore needs the key enabled
again. If the key is deleted, the database, every automated backup and every
snapshot are unrecoverable
([Encrypting Amazon RDS resources](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html)).
Guards in `kms.tf`: `prevent_destroy` on the key, the maximum 30-day
deletion window (`aws kms cancel-key-deletion` undoes a scheduled deletion
in that window), and no principal but RDS can use the key. `DisableKey`,
`ScheduleKeyDeletion`, `PutKeyPolicy` and `RevokeGrant` on the key page the
alerts topic (an EventBridge rule on CloudTrail events, `kms.tf`; § Runbooks
says what to do). That rule hears nothing unless a CloudTrail trail logging
write management events covers the region: the stack relies on the
Organization's trail rather than creating a duplicate, and
`preapply-check.sh` FAILs until one exists (infra/README.md § Operator
steps, step 7a).

What the key covers and what it doesn't: only the RDS instance and what RDS
derives from it (storage, logs on the instance, backups, snapshots). The RDS
master secret and the runtime secrets stay on `aws/secretsmanager`, so the
Lambdas' roles need no `kms:Decrypt`, and a restore re-creates the master
secret anyway (§ Restoring the database). The report and frontend buckets
stay on SSE-S3 ([security.md § Accepted IaC findings](./security.md#accepted-iac-findings)).
One key with one job means a mistake with it affects only the database.

A cross-account backup copy isn't built. When it is, add a statement to
`data.aws_iam_policy_document.rds_kms` that grants the destination account
`kms:Decrypt`, `kms:DescribeKey` and `kms:CreateGrant`. Also add an AWS Backup
plan and vault, and turn on cross-account backup in the Organization's
management account.

Only apply (`./scripts/tf.sh apply`) after the plan has been reviewed and the operator has
said go. Then push the outputs to the repository's GitHub Actions variables
and secrets:

```bash
~/github/templates/scripts/export-tf-vars.sh infra/
```

After the apply (and again after the first frontend release, when the
site's edge checks can pass), run the read-only post-apply check: both alert
topics' email subscriptions confirmed, the RDS event subscription active,
SES production access (a warning while in the sandbox), the renderer's ECR
policy, the site's 404s and no S3 bucket listing, and the Function URL's 403
without the shared secret (infra/README.md § Operator steps, steps 8, 10a
and 10c; `--rds-event-test` proves RDS events reach the topic):

```bash
cd infra && ./scripts/postapply-check.sh --profile water-management --var-file ../../infra-secrets/water-management/prod.tfvars
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
| `WAF_CAPTCHA_SCRIPT_URL` | `waf_captcha_script_url` (the sign-in CAPTCHA's jsapi.js; empty until `waf_captcha_integration_url` is set) |
| secret `WAF_CAPTCHA_API_KEY` | `waf_captcha_api_key` (the CAPTCHA API key for the site's domain; it ships in the public bundle, but the provider marks it sensitive) |

`PUBLIC_API_URL` is not a GitHub variable: the build reads `/api` from the
committed `frontend/.env.production`.

**The sign-in CAPTCHA** ([security.md § Sign-in CAPTCHA](./security.md#sign-in-captcha))
needs one value Terraform can't read: the account's CAPTCHA integration URL.
It is not a secret. Before the first apply (or any time after), run
`aws wafv2 list-api-keys --scope CLOUDFRONT --region us-east-1 --query ApplicationIntegrationURL --output text --profile water-management`
and set the result as `waf_captcha_integration_url` in `terraform.tfvars`.
Apply, then run `export-tf-vars.sh` again: `deploy-frontend.yml` bakes
`WAF_CAPTCHA_SCRIPT_URL` and the `WAF_CAPTCHA_API_KEY` secret into the build as
`PUBLIC_WAF_CAPTCHA_SCRIPT_URL` / `PUBLIC_WAF_CAPTCHA_API_KEY`. Until then
the WAF rule still asks for a puzzle past its threshold, and the sign-in page
says "Too many sign-in attempts from your network. Wait a few minutes, then
try again." instead of showing it.

`PUBLIC_SITE_URL` also reaches the frontend build as `SITE_ORIGIN`
(`deploy-frontend.yml`): the prerendered landing page (`/welcome` and
`/welcome/af`, issues #57 and #137) writes its canonical link, `hreflang`
alternates, `og:url` and `og:image` as absolute URLs from it
(`kit.prerender.origin`, `frontend/svelte.config.js`). CloudFront serves
`/welcome` from `welcome.html` and `/welcome/af` from `welcome/af.html`
(`spa_rewrite`).

The same build bakes in `ENGINE_BUILD`, the engine's build record
(`scripts/release/engine-build.mjs`, run just before it: version, git SHA,
invariants passed, soak cases), which the report's validation statement
prints ([model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313)).
A local or e2e build has none and says *Not recorded for this build*.

### State of the Terraform before the first deploy

Written and tested (plan-only, mocked providers), **nothing applied**:

- RDS PostgreSQL 17 in private subnets, the API Lambda in the VPC (VPC
  endpoints, no NAT), and the **migrate Lambda** the deploy runs before
  publishing new code.
- Lambda runtime `nodejs24.x`, 30 s timeout, 1024 MB, reserved concurrency 10,
  with `DATABASE_URL` and `AUTH_JWT_SECRET` from sops (`scripts/tf.sh`,
  ephemeral variables, `secrets.tf`), in its runtime secret in Secrets
  Manager, written write-only: not in its environment, not in Terraform state.
- No CORS block on the Function URL (the browser never calls it).
- SES (above), CloudFront security headers and CSP, PriceClass_All.
- Background jobs (`jobs.tf`, § Background jobs below): the SQS `jobs`
  queue + DLQ, the worker Lambda, its 5-minute EventBridge tick and the SQS
  interface endpoint.
- Monthly and daily budgets and Cost Anomaly Detection (§ Budget alerts
  below). Alarms: Lambda errors / throttles / p95 duration, migrate errors,
  RDS CPU / CPU credits / surplus CPU credits charged (T4g runs Unlimited:
  an empty credit balance is billed, not throttled) / free storage /
  connections / freeable memory, an RDS event subscription (instance failure,
  low storage, availability, failover, recovery, restoration, deletion,
  maintenance and patching, RDS notices; not the routine daily-backup events,
  and RDS publishes no "backup failed" event, so the restore rehearsal in
  § Restoring the database is what proves the backups), the database KMS
  key being disabled, scheduled for deletion, re-policied or its grant
  revoked (an EventBridge rule on CloudTrail events, `kms.tf`, free; needs a
  CloudTrail trail, § Runbooks 13), SES
  bounce and complaint rates, CloudFront 5xx, a log metric filter + alarm
  on the backend's `self_check_failed` structured log line in both the API's
  and the worker's log group (a saved run failing one of the engine's own
  invariant checks — docs/security.md § Infrastructure), one on
  `mail_send_failed` in the same two log groups (an account, invitation or
  report email that failed to send, § Email), one on `unhandled_error` in
  the API's log group (a request answered with an unhandled 500, which the
  Lambda `Errors` metric can't see, § Runbooks), one on `login_failed` in
  the API's log group (failed sign-ins across all accounts, password spraying,
  § Runbooks), the job queue's five (a new DLQ message, worker errors and
  throttles, backlog, dead jobs), and the fetcher's and renderer's answered
  failures, stuck request queues and throttles (§ Data feeds, § Reports);
  every DLQ alarms on each new arrival, not on its depth (§ Background jobs);
  all to the SNS topics that email `budget_alert_email`. The
  log filters match `$.message.event`, the shape Lambda's JSON log format
  gives the backend's event lines (every Lambda logs JSON, platform lines at
  WARN, application lines from INFO; [infra/README.md
  § Logs](../infra/README.md#logs)). `budget_alert_email` is
  required: plan refuses an empty, malformed or reserved address
  (example.com/.org/.net, `.example`, `.test`, `.invalid`, `.localhost`, any
  case), so a copied example tfvars can't leave the alarms paging nobody
  (`dmarc_report_email`, when set, gets the same check).

Still manual (operator): everything in infra/README.md § Operator steps, in
particular the region choice and opt-in, the Lambda concurrency quota,
billing access for the budget, the SES sandbox exit, and the `production`
environment's required reviewer and its branch and tag policy (the release
preflight refuses to deploy without them; see [§ Releasing](#releasing)).

## 4. CI/CD

The pipelines follow the estate standard set by `threkir` and `feohledger`.
Every workflow pins its actions to a commit SHA, grants least-privilege
`permissions:` per job, and reaches AWS only through GitHub OIDC; there are
no static AWS keys anywhere. `pnpm check:workflows` enforces those rules
(`scripts/guards/check_workflows.mjs`, plus actionlint when it is installed).
Among them: a job that grants `id-token: write` (or `write-all`) must be gated
on `environment: production` (rule `oidc-gate`; the only exception,
`OIDC_ALLOWLIST`, is Scorecard's `analysis` job, which signs its result for
scorecard.dev and may run no `run:` step), and a workflow triggered by
`pull_request_target` may never check out or fetch the PR's head (rule
`prt-head`: `ref:`/`repository:` from `github.event.pull_request.head.*`,
`github.head_ref` or `refs/pull/*`, `gh pr checkout`, or the head passed
through an env var), since that trigger runs with this repo's token.

### What runs on every push to `main` and every pull request

Every change reaches `main` through a pull request (`main` is protected: PRs
only, admins included), so each PR gets the full run before it merges, and the
push run on `main` checks the merged result. Dependabot's PRs get the same run.

| Workflow / job | What it checks |
| --- | --- |
| `ci.yml` `test` | `pnpm test:scripts`, `pnpm check`, `pnpm test`, `pnpm build`, the CSP meta policy, the **bundle budget** (`pnpm check:bundle`) and `infra/scripts/package-lambdas.sh` (the packaging the backend release runs) |
| `ci.yml` `db-test` | `pnpm test:backend:db` against a Postgres 17 service container |
| `ci.yml` `e2e-build`, `e2e`, `e2e-report` | Playwright (Chromium) in 14 shards: the site is built once and shared, each shard runs its time-balanced `--test-list` (from `e2e/shard-timings.json`) against its own Postgres, and the shards' blob reports merge into one HTML `playwright-report`, where the report job also checks every test ran on exactly one shard and uploads the `e2e-timings` artifact ([e2e/README.md § CI](../e2e/README.md#ci-14-shards)) |
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
issue when it fails), `renderer-apt-snapshot.yml` (weekly age check of the
renderer image's apt snapshot; opens a `renderer-apt-snapshot` issue past 90
days, § Reports), and weekly runs of `security.yml` and `scorecard.yml`.
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
holds the AWS session, so a person reads what the new SHA pin points at.
Nor is anything that goes into the report renderer's image: its base image
(`docker`) and its npm packages (the `/backend/renderer-deps` npm entry,
aws-lambda-ric, a native module compiled in the image's build stage), which
the workflow excludes by fetch-metadata's `directory` and, as a backstop, by
the PR's branch name. `pnpm check:workflows` (auto-merge rule) fails if any
of these exclusions is dropped. A
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
  Lambda, and stops if it fails. Just before the invoke it prints
  `Restore point before these migrations (UTC): …`, the time to hand
  `restore-db.sh --restore-time` if a migration damages data (§ Restoring
  the database). There is no manual pre-migration snapshot, on purpose:
  point-in-time restore already reaches any second in the retention window,
  and a manual snapshot would outlive it, keeping personal information past
  the backup period the privacy notice states (issue #126). Migrations must stay backwards-compatible
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

### Response streaming

The API's Function URL is in **`RESPONSE_STREAM`** mode (`infra/lambda.tf`,
WP-1.29a, issue #283), and `backend/src/lambda.ts` exports the matching
streaming handler (`backend/src/http/lambdaStream.ts`). A buffered URL stops
every response at 6 MB, which a farm's daily CSV (≈ 400 KB a year) passes at
about 15 years; a streamed one goes to 200 MB. The CSV downloads stream,
capped at 50 MB ([api.md § Export](./api.md#export)); every other route
answers one JSON chunk as before. Locally the Node server streams the same
`Response` the same way, so there is no mode to switch in dev.

- **The handler and the URL change together.** A streaming handler behind a
  `BUFFERED` URL, or the old buffered one behind a streaming URL, breaks
  every API request (the prelude, or the result object, is read as the
  body). On the first deploy both arrive together. Anywhere already running
  the buffered pair, apply the Terraform change and run the backend deploy
  back to back, and expect the API to be down between them. The same holds
  in reverse: see § Rollback. `backend/src/http/lambdaStream.test.ts` fails
  if `lambda.ts` and `lambda.tf` disagree, and `infra/tests/edge.tftest.hcl`
  pins the mode.
- **What doesn't change.** The CloudFront shared-secret check is the app's
  first middleware, so a direct call to the URL still gets `403`
  (`postapply-check.sh` checks it). The WAF inspects requests, not
  responses. CloudFront passes a chunked origin response through on
  `/api/*` (`CachingDisabled`, so nothing is stored or compressed), and its
  35 s origin read timeout, also the longest wait between packets, stays
  above the Lambda's 30 s. Status, headers and each `Set-Cookie` travel in
  the stream's prelude, and a body-less response (sign-out's `204`) still
  writes once, since a streamed URL response with nothing written stays
  open until the function times out.
- **Pacing.** Past its first 6 MB a stream runs at about 2 MB/s, so a 50 MB
  CSV takes ~25 s, inside the 30 s timeout. That is why the cap isn't
  higher; raise the timeout with it. The CSV is measured and loaded inside
  the route's transaction and written after it ends, so a slow download
  holds no database connection, but it does hold one of the API's reserved
  concurrent executions (10 by default) while it runs. Lambda keeps
  streaming, and billing, even if the client goes away.
- **A failure partway** fails the invocation (the `Errors` alarm counts it)
  and cuts the response off, so the browser reports a failed download
  rather than saving a short file. Hono's own `streamHandle` writes
  "Internal Server Error" after the bytes sent and ends normally, which is
  why the adapter is the app's own.
- **Why the whole API, not a separate export function.** A second function
  with its own streaming URL, and CloudFront behaviours routing the export
  paths to it, would keep sign-in and every JSON route on the buffered path
  and give exports their own concurrency. It was not taken: it doubles the
  API's infrastructure (function, role, runtime secret, log group, alarms,
  deploy step, a second public URL behind the shared secret), its
  CloudFront path patterns become a second router that can drift from
  Hono's (a new export route would silently stay buffered), and it would
  still be a VPC function with the same database connections. The cost of
  one streamed API is the adapter, which `lambdaStream.test.ts` runs every
  route shape through (the shared secret, cookies, empty bodies, error JSON,
  a CSV past 6 MB). If exports ever need their own concurrency, or files
  past what 30 s carries, the next step is WP-1.29 option (b): write the
  file to S3 and hand out a signed URL, the reports' pattern (§ Reports).
- **Check it after the first deploy** (WP-1.29's acceptance criteria, open
  in [followups.md](./followups.md)): sign in and out through the site;
  download a farm's daily CSV of over 12 MB through CloudFront (a long run's
  farm, Runs tab, Download, with no window) and check its last row is the
  run's last day; then `curl -sS -o /dev/null -w '%{http_code}\n'` the
  Function URL directly and expect `403`. AWS's streaming page says
  function URLs "do not support response streaming within a VPC
  environment"; read with its example (a client inside a VPC), that is about
  the caller, not a VPC-attached function behind a public URL, but only this
  check settles it. If the download fails, put the URL back to `BUFFERED`
  and `lambda.ts` back to a buffered adapter in one release, and build
  option (b).

### Releasing

Each deployable has its own release line, named `<component>@<semver>`
(the threkir convention):

| Tag | Workflow | Deploys |
| --- | --- | --- |
| `backend@X.Y.Z` | `deploy-backend.yml` | migrate Lambda (runs the migrations), then the API, worker and fetcher Lambdas, then the renderer's image (pushed to ECR; the renderer moved to it once it exists), then the health check |
| `web@X.Y.Z` | `deploy-frontend.yml` | the engine suite and a 1 600-case soak (a failure stops the release; the result is the build record the report's validation statement prints, model.md §2.10f), then the static build to S3, then a CloudFront invalidation |

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
     30 minutes while CI is still running). Only a `CI gate` posted by the
     GitHub Actions app (`github-actions`, id 15368) from a run of
     `.github/workflows/ci.yml` on a push or manual run of that exact commit
     counts: any app with `checks: write` can post a check by that name, and a
     `pull_request` run executes the merge ref's `ci.yml`, which the PR can
     rewrite. Other runs by that name are listed as ignored in the error;
   - the `production` environment exists **and has a required reviewer**. A
     job that names a missing environment creates it unprotected, so the
     preflight fails instead;
   - that environment's deployment policy allows exactly branch `main` and
     tags `backend@*` and `web@*`, and an active tag ruleset applies
     `creation`, `update` and `deletion` to `refs/tags/backend@*` and
     `refs/tags/web@*` ([§ The production environment's branch and tag
     policy](#the-production-environments-branch-and-tag-policy));
   - every AWS variable and secret the deploy reads is set (the backend's
     include `RENDERER_FUNCTION_NAME` and `RENDERER_ECR_REPOSITORY`, from
     `export-tf-vars.sh`). Until the account
     is bootstrapped and `export-tf-vars.sh` has run, **every release stops
     here** with a pointer to the runbook, before anything is built.
6. **build** installs dependencies, runs the engine suite and soak for the
   [engine build record](#engine-build-record) (a failure stops the release
   here), and builds the artifact with that record in it. It has no
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

### Engine build record

Every report's validation statement names the engine build's own test results
(model.md §2.10f, roadmap WP-3.13), and the evidence pack manifests will too
(WP-3.14). The build job of both release workflows makes that record before it
builds, with `scripts/release/engine-build.mjs --soak-cases N` (1 600 cases for
the web, 2 000 for the backend): the engine's unit suite with its random-network
soak widened to N, on this commit. A failing suite fails the release. The
script puts the record (`{version, gitSha, invariantsPassed, soakCases}`) in
`$GITHUB_ENV` as `ENGINE_BUILD`:

- **web**: `frontend/vite.config.ts` injects it as `__ENGINE_BUILD__` for the
  validation statement (below).
- **backend**: `infra/scripts/package-lambdas.sh` passes it to every Lambda
  bundle as the esbuild define `__ENGINE_BUILD_JSON__`;
  `backend/src/release/engineBuild.ts` `engineBuild()` reads it, and is null
  without one or for a record made for another `ENGINE_VERSION`. It is not an
  environment variable of the Lambdas.

Unset, both inject an empty string: dev, the e2e build and any local build say
*Not recorded for this build*.

### The production environment's branch and tag policy

The required reviewer decides *whether* a run deploys; these two settings
decide *what* it can deploy. Without them, a reviewer approving a run from a
side branch, or a release tag moved after its checks passed, ships code the
preflight never looked at. The preflight refuses every release until both are
in place. Set them once, as the operator (repo admin), each command on one
line:

1. Restrict the environment to custom branch and tag policies. This `PUT`
   rewrites the environment, so it re-sends you as the required reviewer
   (self-review allowed: there is one operator):

   ```bash
   gh api -X PUT repos/Absence0760/project-water-management/environments/production -F "reviewers[][type]=User" -F "reviewers[][id]=$(gh api user --jq .id)" -F prevent_self_review=false -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
   ```

2. Allow exactly `main` and the two release tag patterns (a manual rollback
   run is dispatched from `main`; a release event runs on its tag):

   ```bash
   gh api -X POST repos/Absence0760/project-water-management/environments/production/deployment-branch-policies -f name=main -f type=branch
   gh api -X POST repos/Absence0760/project-water-management/environments/production/deployment-branch-policies -f name='backend@*' -f type=tag
   gh api -X POST repos/Absence0760/project-water-management/environments/production/deployment-branch-policies -f name='web@*' -f type=tag
   ```

3. Protect the release tags: only a repository admin (you, bypassing through
   `gh release create`) can create them, and nobody can move or delete one:

   ```bash
   gh api -X POST repos/Absence0760/project-water-management/rulesets --input - <<< '{"name":"Release tags","target":"tag","enforcement":"active","bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],"conditions":{"ref_name":{"include":["refs/tags/backend@*","refs/tags/web@*"],"exclude":[]}},"rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"}]}'
   ```

4. Check. The first should print `{"custom_branch_policies":true,"protected_branches":false}`
   and a reviewer, the second exactly the three policies, the third the
   ruleset as `active`:

   ```bash
   gh api repos/Absence0760/project-water-management/environments/production --jq '{p: .deployment_branch_policy, r: [.protection_rules[] | select(.type == "required_reviewers") | .reviewers[].reviewer.login]}'
   gh api repos/Absence0760/project-water-management/environments/production/deployment-branch-policies --jq '.branch_policies[] | "\(.type) \(.name)"'
   gh api repos/Absence0760/project-water-management/rulesets --jq '.[] | select(.target == "tag") | "\(.name) \(.enforcement)"'
   ```

The preflight reads these with the workflow's own token (`actions: read` for
the environment and its policies; rulesets need only repository metadata), so
a missing, broadened or disabled setting fails the release with the step to
fix. An extra deployment policy (say `*`) is refused too: the list must be
exactly those three. `templates/scripts/backfill-prod-environment.sh` sets
only the reviewer; the same steps belong in it for every estate repo.

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
- **Only the API wakes the worker.** The worker has no `sqs:SendMessage` on
  the `jobs` queue and no `JOB_TRANSPORT` / `JOBS_QUEUE_URL` (the production
  settings check asks them of the API alone): a job that queues follow-up
  work leaves it to the tick. `backend/src/lambda-worker.test.ts` fails if
  anything the worker bundles reaches `jobs/wake.ts` or a routes module, and
  `infra/tests/guardrails.tftest.hcl` if the worker's environment gets either
  setting back.
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
- **Every DLQ alarm fires on a new arrival, not on depth** (all six:
  `jobs`, `fetch-requests`, `ingest-results`, `render-requests`,
  `render-results`, `mail-events`; `infra/alarms.tf`
  `local.dlq_arrivals_expression`). A depth > 0 alarm would stay in ALARM
  while the message sits in the DLQ (up to 14 days), and SNS mails only on a
  change of state, so a second failure in that time would be silent. Each
  `<queue>-dlq-arrivals` alarm is `DIFF(FILL(ApproximateNumberOfMessagesVisible, 0)) > 0`
  on 5-minute maxima, 1 of 3 datapoints: it mails once per new
  dead-lettering and returns to OK about 15 minutes later on its own.
  (`NumberOfMessagesSent` would be simpler but doesn't count a message the
  redrive policy moves into a DLQ.) *Runbook:* an OK alarm doesn't mean an
  empty DLQ. After acting on one, check the DLQ's depth in the SQS console
  (Messages available) and redrive or purge it; after a redrive or purge,
  check again, because a message that arrived in the same 5 minutes as one
  left reads as no change and doesn't alarm.
- **Alarms** (to the alerts SNS topic): `jobs-dlq-arrivals`, a new message
  in `jobs-dlq`; worker errors > 0;
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
  tick until the first backend release: `worker-errors` goes to ALARM (and
  emails) within minutes of the apply, but the heartbeat stays OK (a failed
  invocation still counts). The fetcher's stub throws too, but nothing
  invokes it until a real worker queues a fetch. Expected, and harmless: no
  job exists before the first migration. It clears about 5 minutes after the
  first backend release moves the worker to real code. The stubs throw on
  purpose, so a worker ever recreated from its stub alarms the same way
  ([infra/README.md § Operator steps](../infra/README.md#operator-steps),
  step 10).
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
- **Alarms** (to the alerts topic): `fetch-requests-dlq-arrivals` and
  `ingest-results-dlq-arrivals` (a new DLQ message, § Background jobs);
  `fetcher-errors` (a crash or timeout) and `fetcher-throttles` (it hit
  `fetcher_reserved_concurrency`), both > 0; `fetch-requests-age`, a request
  waiting over an hour (nothing is consuming the queue: the fetcher still the
  stub, its trigger disabled, or throttled; the request would otherwise
  expire unseen after 4 days); and `feed-fetch-failed`, any fetch the fetcher
  answered as failed in an hour. That last one is invisible to
  `fetcher-errors`, because the Lambda succeeded: it counts the fetcher's
  `{"event":"feed_fetch_failed","feedId","source","reason"}` log line
  (ids, the source and a reason code, never the stored message, which can
  name a grid cell or a station). A stale or failing feed also shows in the
  app, and emails the owners and editors of a project with the `data_stale`
  or `feed_failing` alert on.
  - *Runbook: `feed-fetch-failed`.* Logs Insights on the fetcher's log group:
    `filter message.event = "feed_fetch_failed" | stats count() by message.source, message.reason`.
    `unavailable` or `timeout`: the source is down or slow; the feed retries
    on its own schedule (nothing to do unless it persists; DWS from outside
    South Africa answers 403, see Sources' terms below). `format`: the source
    changed what it serves, a code fix. `invalid_request` or `internal`: a
    bug; the feed's status panel has the stored message.
- **Sources' terms.** CHIRPS is public domain (the Climate Hazards Center
  waived copyright; cite it). CHIRPS-GEFS comes from the same server without a
  separate licence notice: confirm before relying on it commercially (the
  roadmap's D7). DWS's terms of use for automated retrieval must be checked
  before a DWS feed is used in production, and the DWS site answers our
  (non-South-African) network with HTTP 403: confirm the fetcher's region can
  reach it ([followups.md](./followups.md)).
- **Cost (idle delta ≈ +$1.00/month):** two more queues and two DLQs cost
  nothing at rest, but each SQS event source polls continuously (~0.65 M
  receives a month each); with the `jobs` queue's that is ~1.9 M, ~0.9 M past
  the free tier, ≈ $0.40. Six alarms ≈ $0.60. The fetcher's own compute is
  cents: a daily CHIRPS feed is ~200 range requests (~5 MB) in ~5 s at 512 MB.
  No NAT, no new endpoint.

## Alert emails

The worker sends the alert emails ([architecture.md § Alert emails](./architecture.md#alert-emails),
[security.md § Alerts](./security.md#alerts)) through the same SES identity
and configuration set as every other email ([§ Email](#email-amazon-ses)).

- **Worker environment and runtime secret** (`infra/jobs.tf`, `infra/secrets.tf`):

  | Variable | Value |
  | --- | --- |
  | `APP_ENCRYPTION_KEY` | The sops key `app_encryption_key` (32+ alphanumeric characters), in the API's runtime secret. Seals two-step sign-in's TOTP secrets (AES-256-GCM, `auth/secretBox.ts`); the API refuses a missing, short or `dev-only-` value at cold start. Rotate only if it leaked ([§ Runbooks](#runbooks) 15) |
  | `MFA_REQUIRED` | Unset (or `true`). The API and worker refuse `false` at cold start: owners, team admins and assessors always need two-step sign-in in production (`auth/stepUp.ts`) |
  | `ALERTS_TOKEN_SECRET` | The sops key `alerts_token_secret` (32+ alphanumeric characters), in the worker's runtime secret (not its environment, not Terraform state). Signs the one-click unsubscribe links and the "Was this useful?" links (151). Only the worker has it; the API Lambda checks a link by its hash. Rotating it (a new sops value, applied through `tf.sh`, [§ Rotating a secret](#rotating-a-secret)) breaks the unsubscribe link in every alert already sent ("Manage your alerts" still works), so rotate only if it leaked |
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
  receives, the `mail-events-dlq-arrivals` alarm), which triggers the worker.
  The worker (`mail/suppression.ts`) flags the person with that address
  (`app_user.mail_suppressed_at`, 057) and pauses their alert emails; the
  account and alert pages show a banner, and **Turn alert emails back on**
  (`POST /me/alerts/resume`) takes the address off the suppression list
  (`ses:DeleteSuppressedDestination`, the API role only; once a day per
  person). A transient bounce (a full mailbox) changes nothing.
  - *Through the SES endpoint.* The call leaves the VPC through the SES API
    interface endpoint, whose policy (`ses_endpoint`, `ses.tf`) admits
    `SendEmail` from the API and worker roles (as no-reply@ only) and
    `DeleteSuppressedDestination` from the API role only. **Still to be
    confirmed on the first deploy** (#126): that the endpoint carries
    `DeleteSuppressedDestination` at all. infra/README.md step 10b is the
    check and the by-hand fallback.
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
  check:pins` fails until all of them agree with e2e's `@playwright/test`;
  its build stage's apt packages are pinned to exact versions from one
  Ubuntu archive snapshot, `APT_SNAPSHOT`, which `check:pins` also
  enforces (the snapshot picks every version; the live archive, at apt
  priority 100, is only a second place to fetch the same files, because
  snapshot.ubuntu.com is slow and answers 500/503 now and then; the
  Dockerfile says how), and Dependabot's `docker` entry proposes new tags and digests
  but never auto-merges them; see **Moving the apt snapshot** below), x86_64,
  **no VPC**, 2048 MB, 120 s (the render's own cap is 100 s), 1 GB of `/tmp`,
  reserved concurrency `renderer_reserved_concurrency` (2). It opens
  `https://<domain>/projects/:id/report?run=…` through CloudFront and the WAF,
  signs in with the render token (`POST /api/auth/render-session`), prints
  the PDF and puts it in the reports bucket. Its role can do nothing else.
- **Moving the apt snapshot.** The build stage's packages (the compilers
  and libraries aws-lambda-ric compiles with) get no Ubuntu security update
  until `APT_SNAPSHOT` moves, and nothing moves it by itself: Dependabot
  moves the base image's tag and digest, never an apt pin. `pnpm
  gen:renderer-apt [<YYYYMMDDTHHMMSSZ>]` does (`scripts/guards/renderer_apt_snapshot.mjs`):
  it sets the snapshot (default today, 00:00 UTC) and rewrites each pinned
  package to its candidate in that snapshot, read with `apt-cache --snapshot
  <id> policy` inside the Dockerfile's digest-pinned base (docker run, no
  build; a bare `apt-cache policy` would read the live lists and report
  today's versions). Then `pnpm check:pins && pnpm check:renderer-image`.
  Run it **on every Dependabot `docker` PR** (digest-only bumps included, so
  the snapshot moves with the base), and when the weekly
  `.github/workflows/renderer-apt-snapshot.yml` opens its
  `renderer-apt-snapshot` issue: it reads the snapshot's age every Monday,
  opens one issue (updated, never duplicated) once it is over 90 days old,
  with this procedure in the body, and closes it once a newer snapshot lands
  on `main`. `pnpm check:apt-snapshot` prints the age locally.
- **The image**: `deploy-backend.yml`'s build job (no AWS credentials) builds
  it, smoke-tests it as Lambda runs it (`infra/scripts/smoke-renderer-image.sh`:
  a uid with no passwd entry and a read-only filesystem; Chromium prints a PDF
  with the Lambda launch flags, the handler answers under the Lambda runtime
  interface emulator, and the init check refuses a missing setting) and hands
  it over as an artifact; CI's `renderer-image` job builds and smoke-tests it
  on every PR, and `pnpm check:renderer-image` does the same locally (needs
  docker only). A full render through the handler needs the deployed site,
  bucket and queues, so it is checked after the first deploy (#92); the approved deploy job pushes it to
  the `water-management-renderer` ECR repository (tags are immutable:
  `<version>-<first 12 hex of the released commit>`, so a release recut at
  the same version on another commit pushes and deploys its own image
  rather than reusing the old one, and a redeploy of the same commit reuses
  its image) and moves the function to it. **Lambda can't be created
  from an image that doesn't exist yet**, so the function is created by
  Terraform only once `renderer_image_tag` names a pushed image: after the
  first backend deploy, set it to the tag the deploy's notice printed and
  apply ([infra/README.md § Operator steps](../infra/README.md#operator-steps), step 10a).
  The repository keeps the last 10 images and deletes untagged ones after a
  day, but never the image `renderer_image_tag` names: a higher-priority
  lifecycle rule selects exactly that tag, and ECR never lets a
  lower-priority rule expire an image a higher one matched
  (`infra/reports.tf`, `infra/tests/release.tftest.hcl`). So the tfvars
  stays valid however many releases follow, and a re-created function always
  finds its image; set a newer tag and apply to move the protection.
  Until then the deploy logs a notice and render requests wait in their
  queue.
  **After that apply, and again after the second backend release** (the
  first to move an existing renderer), confirm the repository policy still
  holds only Terraform's statement (`infra/scripts/postapply-check.sh`,
  its `ecr-policy` line, or by hand):
  `aws ecr get-repository-policy --repository-name water-management-renderer --region <region> --profile water-management --query policyText --output text`
  (step 10a says what to look for). The renderer's role pulls the image
  with its own grant, and the repository policy carries the statement
  Lambda looks for, so Lambda has nothing to add; nobody holds
  `ecr:SetRepositoryPolicy`, and the deploy role reads the policy only
  (`ecr:GetRepositoryPolicy`, for Lambda's check on `UpdateFunctionCode`).
- **The bucket**: `water-management-reports-<account>`, private (public
  access blocked, bucket-owner objects), SSE-S3, TLS only, and a lifecycle
  that deletes `reports/` objects after **7 days** (the tick deletes the
  rows a day later). Only the distribution reads it: the `/reports/*`
  behaviour serves it through its own origin access control (the bucket
  policy pins the distribution's ARN) to CloudFront signed URLs only.
  `GET /projects/:id/reports/:jobId/pdf` redirects to one, signed for 60
  seconds with the key pair Terraform generates (one per click, so nothing
  long-lived leaves the API), and the browser fetches the PDF through
  CloudFront and the WAF. The API has no S3 grant and needs no S3 endpoint:
  signing is local (`REPORT_DOWNLOADS=cloudfront`, `CLOUDFRONT_KEY_PAIR_ID`
  and `CLOUDFRONT_PUBLIC_KEY` in its environment, `CLOUDFRONT_PRIVATE_KEY`
  from sops in its runtime secret; it refuses to start if the two halves
  don't pair).
  Rotating the key: [§ Rotating a secret](#rotating-a-secret).
- **Retries and DLQs:** each render queue dead-letters after 5 receives. A
  failed render is an answer (the report shows it), not an SQS retry: its
  token may be spent. The answer says whether another attempt could succeed:
  only the API's coded refusal of the token (`render_token_refused`), the
  report page's own "can't show this" and a page that tried to leave the
  site are final. Anything else (a WAF block, which is a plain `403`, a
  `429`, a `5xx`, a timeout) makes the worker ask again with a fresh token
  after 2, then 4 minutes, up to 3 renders; the report shows "rendering"
  meanwhile. A render request in the DLQ can't be redriven usefully (the
  token expired after 5 minutes): purge it; a render result in the DLQ can.
- **Alarms:** `render-requests-dlq-arrivals`, `render-results-dlq-arrivals`
  (a new DLQ message, § Background jobs), `renderer-errors` (a crash or
  timeout), `renderer-throttles` (it hit `renderer_reserved_concurrency`),
  `renderer-duration` (p90 over a minute), `render-requests-age` (a request
  waiting over 30 minutes) and `report-render-failed` (any render the
  renderer answered as failed in an hour). The renderer's errors, throttles
  and duration alarms exist only with the function; `render-requests-age`
  and `report-render-failed` exist from the first apply, so with
  `renderer_image_tag` still empty a requested report alarms within 30
  minutes instead of its request expiring silently after 4 days.
  `report-render-failed` counts the renderer's
  `{"event":"report_render_failed","reportId","projectId","reason","retry"}`
  log line (ids, `render` or `store`, whether the worker asks again; never
  the error text or the token): the Lambda succeeded, so `renderer-errors`
  never sees these.
  - *Runbook: `render-requests-age`.* If `renderer_image_tag` is empty, the
    renderer doesn't exist: push an image and set the tag (above). Otherwise
    check the renderer's SQS trigger and `renderer-throttles`. The waiting
    requests' tokens have expired (5 minutes), so purge `render-requests`
    once the renderer runs; the reports show as failed and can be asked for
    again.
  - *Runbook: `report-render-failed`.* Logs Insights on the renderer's log
    group: `filter message.event = "report_render_failed" | stats count() by
    message.reason, message.retry`. `store`: the reports bucket refused the PDF (the renderer's
    role, `report_store_failed` has the error name). `render` with `retry`
    false: the token was refused or the page said it can't show the report
    (the report's own error, on the Reports tab, has the text). With `retry`
    true: a timeout, a WAF block or a browser crash, asked again with
    backoff; many at once usually means the WAF (`waf-blocked-requests`).
- **SES**: report emails go to members, so they count against the same SES
  sending limits as account email; production access (Operator step 8a) is
  needed before a schedule can mail anyone but verified addresses.
- **Cost (idle delta ≈ +$1.30–1.50/month):** two more event sources polling
  (~$0.50), seven alarms ($0.70), the image in ECR (~$0.10–0.30); a render is
  ~5 s at 2 GB, ≈ $0.0002, and a PDF is ~1 MB for 7 days. No NAT, no new
  endpoint.

## Evidence packs

An issued evidence pack's PDF ([evidence-pack.md § The PDF](./evidence-pack.md#the-pdf),
119_pack_render) is printed by the same renderer as a report, on the same two
queues, and kept in a bucket of its own (infra/packs.tf, plan-only until the
first deploy):

- **The flow.** Issuing a pack queues a `pack_render` job (as the issuer).
  The worker (`REPORT_RENDERER=sqs`) issues a render token for that pack and
  sends a `render_pack` request; the renderer prints
  `https://<domain>/projects/:id/packs/:packId`, hashes the PDF, puts it at
  `packs/<project>/<pack>/<sha256>.pdf` with that checksum and answers
  `rendered_pack` with the hash and page count; the worker's follow-up job
  records them on the pack once (`app_record_pack_pdf`). Retries are a
  report's: a retryable failure asks again after 2, then 4 minutes, up to 3
  renders; then the pack's PDF shows as failed and an editor asks again
  (`POST …/packs/:packId/pdf`). Failed answers count in `report-render-failed`
  (the log line carries `packId` instead of `reportId`; a store failure logs
  `pack_store_failed`). Before recording, the worker checks the answer
  against the bucket: it HEADs `packs/<project>/<pack>/<sha256>.pdf` with
  checksum mode on and records only when the object exists and its stored
  SHA-256 checksum is the answered hash; otherwise the answer is refused for
  good (`pack_pdf_answer_refused` in the worker's log, the pack's PDF shows
  failed with why, nothing recorded), so a buggy or compromised renderer
  can't fix a wrong hash on a pack. The worker reaches S3 through an **S3
  interface endpoint** (one AZ, ~$7.30/month; its policy allows only the
  worker's `s3:GetObject` on `packs/*`) and holds that one grant. The renderer
  and the worker both need `PACKS_BUCKET` (Terraform sets it; each refuses to
  start without it).
- **The re-run** (154_pack_reproduce). Issuing also queues a
  `pack_reproduce` job: the worker reads the pack's bundle
  (`packs/<project>/<pack>/<sha256>.zip`) back with that same
  `s3:GetObject` grant, re-runs both runs from it and records the outcome
  (`pack_reproduced` in the worker's log, `warn` unless it reproduced, with
  the failed checks' ids and how long it took). It runs the engine twice in
  the worker (each run as long as it took in the API), well inside the
  worker's 300 s; 3 attempts when the bucket can't be read, then the pack
  page says the re-run couldn't be done. No infrastructure of its own.
- **The bucket**: `water-management-packs-<account>`, private (public access
  blocked, bucket-owner objects), SSE-S3, TLS only, **versioned with Object
  Lock**: every object is retained from its upload for `pack_retention_days`
  (default **3650, 10 years**) in **GOVERNANCE** mode, and nothing expires
  it (no lifecycle). Operator decision, 2026-09-30: governance, so the
  account's administrator can still remove an object in an emergency (a
  court order, a data-subject request the retention can't override) with
  `s3:BypassGovernanceRetention`, which no role here holds; 10 years because
  a licence decision can be reviewed or appealed long after it is made.
  Raising `pack_retention_days` applies to new objects only. Switching to
  COMPLIANCE mode (no one, the root user included, can remove an object
  before its date) is a change to `infra/packs.tf` and can't be undone for
  the objects written under it.
- **Orphan objects.** A retry, a re-render after a failure, or a redelivered
  request prints the pack again, and a Chromium PDF differs per render (its
  creation date), so each is a new object under its own hash, and only the
  first recorded counts. Those orphans are held for the same retention
  period as the recorded PDF; only the governance bypass (below) removes
  them.
- **Downloads**: the `/packs/*` behaviour serves the bucket through its own
  OAC to CloudFront signed URLs from the report-download key group only,
  exactly as `/reports/*` (§ Reports); `GET …/packs/:packId/pdf` and
  `GET …/packs/:packId/bundle` redirect to one (60 s).
- **The reproduction bundle** ([evidence-pack.md § Reproduction](./evidence-pack.md#reproduction),
  122_pack_bundle, infra/pack_bundles.tf): the API builds it when it issues
  a pack, in the issue's transaction, and puts it at
  `packs/<project>/<pack>/<sha256>.zip` with that checksum and
  `If-None-Match: *` before recording its hash; if the put fails nothing is
  issued. The API role holds only `s3:PutObject` on `packs/*.zip` in the
  packs bucket (SSE-S3, so no KMS grant; the bucket policy names no writer),
  reaches S3 through the same S3 interface endpoint as the worker (the
  endpoint policy's second statement allows exactly that put; SG rules API →
  endpoint on 443), and needs `PACKS_BUCKET` (Terraform sets it; the API
  refuses to start without it). **No added cost**: no new endpoint. An
  issue that fails after its put leaves an unrecorded object, held for the
  retention period like a PDF orphan; issuing again writes no second
  version (the key is the bundle's hash, and the put is conditional).
- **Removing a pack's PDF** (the governance bypass; the operator's, never
  the app's): with the administrator's credentials,
  `aws s3api delete-object --bucket water-management-packs-<account> --key packs/<project>/<pack>/<sha256>.pdf --version-id <version> --bypass-governance-retention --profile water-management`.
  The pack keeps its recorded `pdfSha256`, and verify keeps answering it:
  say on the pack why its PDF is gone (withdraw it with that reason).
- **Cost:** a PDF is ~1 MB kept for 10 years, ≈ $0.0003/month each at S3
  Standard (orphans included); the S3 interface endpoint ~$7.30/month idle.

## The Map tab

The Map tab (issue #288, [maps.md](./maps.md)) needs nothing deployed to
work: features, uploads, areas and the lookup run on the API and RDS as
they are. Two pieces are not deployed yet, each in
[followups.md § Catchment map](./followups.md#catchment-map-issue-288):

- **Basemap**: `PUBLIC_TILES_URL` is empty in `frontend/.env.production`, so
  production draws the plain background. Serving one means the PMTiles file
  in S3 under `tiles/`, a same-origin CloudFront behaviour `/tiles/*` (Range
  and `ETag` forwarded, long cache) and the URL in the web release; the CSP
  needs no change (`connect-src 'self'`, `worker-src 'self'`).
  The labels' glyph ranges (#326 A6) ride the same behaviour: the
  `fonts/` tree `bin/tiles-dev.sh fonts` builds, in S3 under
  `tiles/fonts/`, and `PUBLIC_TILES_GLYPHS_URL=/tiles/fonts/{fontstack}/{range}.pbf`
  (empty until then: no names on the map).
- **Quaternary dataset**: `quaternary_reference` is empty in production
  until the operator loads one, so the lookup says no dataset is loaded.
  There is no production loading path yet, and WR2012's licence terms are a
  decision to check first. Never load the synthetic dataset into
  production: its values are invented (the app marks them, but they have no
  place there).

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
7. **A POPIA request to delete a person's account** (operator; [security.md § Personal information](./security.md#personal-information-popia)).
   A person who can sign in can do it themselves: Account → **Delete my
   account** (`DELETE /auth/me`, issue #112) runs the same deletion, refuses
   the only owner or admin with the list to hand over, and emails them what
   was done; point them there. It logs
   `{"event":"account_deleted","via":"self","accountId":"…"}`: the account's
   random id only, never an address or a name. Both paths, the self-service
   one and the SQL below, also write the id to the `erasure_log` table (157),
   which a restore reads to delete the account again
   ([§ Restoring the database](#restoring-the-database), step 6a). Otherwise
   (they can't sign in, or ask another way): a request may come by email or
   any other expedient way (POPIA s24,
   Regulation 3); act on it as soon as reasonably practicable. Confirm it
   comes from the account's address, and tell the WUA (the responsible
   party for its farmers). As the schema owner, in one transaction:
   `DELETE FROM app_user WHERE id = '…';`. Memberships, farm links, tokens,
   their pending jobs and the invites they sent go with it; notes,
   publications, keys and links stay with no author; projects, teams, runs,
   nominations, ensembles, imports and scenarios they made stay with the
   maker cleared (138: keep the evidence, remove the name), except an
   ensemble they never completed and their **draft** applications, which go;
   sign-offs keep the typed name and registration; the audit log is
   pseudonymised ("Deleted user"). A `23514` error at commit ("a project must
   keep at least one owner", "a team must keep at least one admin") means
   they are the only owner or admin of something: ask them, or the
   project's or team's other members, to hand it over (make someone else
   owner or admin), then delete again. Then email the person what was done
   (s24(4)): the account is gone, and what was kept without their name and
   with it (sign-offs, the names printed in issued evidence packs). Record
   the request, the date and the outcome in the operator log (the list of
   erased accounts, kept outside the database).
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
   `filter message.event = "unhandled_error" | stats count() by message.route, message.error, message.code`
   says which endpoint and what kind of failure; `at` points at the throwing
   line. One route with a SQLSTATE after a deploy is usually a migration the
   code got ahead of (§ A failed migration); every route at once with
   `ECONNREFUSED` or `57P01` is the database (RDS alarms); a failover or
   restart also leaves `{"event":"db_idle_client_error","code":"57P01"}`
   warnings, one per pooled connection it dropped (`backend/src/db/pool.ts`:
   the pool replaces the connection, the process keeps running). Reproduce it
   locally, fix the cause and add a test; the message was deliberately not
   logged (it can hold row values), so the stack and code are the lead.
10. **Request flood** (the `cloudfront-requests` or `waf-blocked-requests`
    alarm, operator; both live in us-east-1 and mail the same address).
    Nothing caps CloudFront and WAF request charges: every allowed request
    costs $1.60–2.80 per million (WAF + CloudFront), a blocked one WAF's
    $0.60 per million only. The arithmetic behind the thresholds is in
    [infra/README.md § Cost](../infra/README.md#cost).
    1. **Look:** WAF console, region Global (CloudFront) →
       `water-management-frontend-acl` → Traffic overview and Sampled
       requests (the last 3 hours): top client IPs, paths, countries, and
       which rule blocked. CloudFront console → Reports shows the top
       objects and viewers.
    2. **Real growth** (more users, a new catchment going live; normal
       paths, many ordinary IPs, no blocks): raise
       `cloudfront_requests_alarm_per_5min` (1,000–20,000) and apply.
    3. **A few IPs over the per-IP limit:** the WAF already blocks them,
       so each request costs $0.60 per million and nothing else. If they sit
       just under the limit instead, lower `waf_rate_limit_per_ip` (on
       `/api/*`; AWS minimum 100) or `waf_site_rate_limit_per_ip` (every
       path, at least the API limit) and apply.
    4. **A distributed flood** (many IPs, each under the limit): add a
       blocking rule to `infra/waf.tf` ahead of the rate rules (an IP set, a
       geo match, or a byte match on the path being hammered) and apply. In
       an emergency add it in the console first; the next apply removes a
       console-only rule, so write it into `waf.tf` before that. Last resort:
       disable the distribution (CloudFront console → the distribution →
       Disable). That stops the charges and takes the whole site and API down
       until it is enabled again.
    5. **Sustained blocks** (`waf-blocked-requests` alone): blocks on
       `/api/auth/` from many IPs are credential stuffing (the per-account
       sign-in lockout slows it further; expect locked-out users to ask);
       blocks from AWS Lambda addresses (on `/api/auth/render-session`, the
       report route and its `/_app/` files) are the report renderer being
       rate limited. Each blocked render is retried after 2, then 4 minutes
       (§ Reports), so a short burst of reports recovers by itself; if they
       keep failing ("the render session could not start (HTTP 403)" on the
       report), raise `waf_site_rate_limit_per_ip` (the SPA's files count only
       there) or, for `/api/` blocks, `waf_rate_limit_per_ip`, and apply. One
       office or farm address is people behind one NAT: raise the limit its
       blocks are on (the rule is in the sampled requests).
    6. **Afterwards:** check Cost Explorer (daily, services CloudFront and
       WAF) for what it cost, and record the incident in the operator log.
11. **Credential stuffing / password spraying** (the `login-failed` alarm,
    operator). More than `login_failed_alarm_per_15min` (default 30) credential
    checks failed in 15 minutes across all accounts. Each address's own lockout
    (5 tries, then 1–15 minutes) can't see one password tried against many
    accounts, so this alarm is the control that does
    ([security.md § Throttles that don't depend on the WAF](./security.md#throttles-that-dont-depend-on-the-waf)).
    Each failure logs `{"event":"login_failed","route":"/auth/login","reason":"bad_password"}`,
    with no address, id or IP.
    1. **Look:** CloudWatch Logs Insights on the API's log group,
       `filter message.event = "login_failed" | stats count() by message.reason, message.route, bin(5m)`.
       Mostly `unknown_account` is a list of addresses being tried (stuffing
       from a leaked list); mostly `bad_password` spread thinly is spraying
       against real accounts; mostly `locked` is one or a few accounts being
       hammered (the lockout is already holding); `invalid_link` on
       `/auth/reset-password` or `/auth/verify-email` is a token scanner
       (harmless: tokens are 256 random bits) or an old email being clicked.
       Then the WAF console, region Global → `water-management-frontend-acl`
       → Sampled requests for `RateLimitAuthPerIP` and the top IPs, countries
       and user agents on `/api/auth/login`.
    2. **A few people locking themselves out** (a handful of lines, one
       burst, `bad_password` then `locked`): nothing to do. If real use grows
       past the threshold, raise `login_failed_alarm_per_15min` (10–300) and
       apply.
    3. **A few IPs:** the WAF's auth rule already blocks each one over 100
       requests in 5 minutes. Add them to a blocking IP-set rule in
       `infra/waf.tf`, ahead of the rate rules, and apply.
    4. **Many IPs, each under the limit:** the sign-in CAPTCHA
       (`SignInCaptchaPerIP`, below) already asks each IP past
       `waf_signin_captcha_per_5min` (default 20) sign-ins in 5 minutes for a
       puzzle; its WAF metric (`water-management-frontend-SignInCaptchaPerIP`)
       and Sampled requests show how often. To tighten: lower
       `waf_signin_captcha_per_5min` (AWS minimum 10) and apply; add a geo
       match blocking countries the users aren't in, ahead of the rate rules
       in `infra/waf.tf`; or narrow `RateLimitAuthPerIP` (its limit is AWS's
       old minimum, 100; a scope-down on `/api/auth/login` alone with a
       1-minute `evaluation_window_sec` is stricter). In an emergency add the
       rule in the console first and write it into `waf.tf` before the next
       apply, which removes console-only rules.
    5. **Accounts at risk:** a `bad_password` wave may have found a password
       that works. As the schema owner, `SELECT email, failures, locked_until
       FROM login_throttle WHERE last_attempt_at > now() - interval '1 hour'
       ORDER BY failures DESC;` names the addresses being tried. A correct
       password deletes the address's row, so an address that drops off the
       list mid-attack may have been signed in to (its owner's own browser
       counts on `login_device_throttle` and never touches this row). For any
       that then
       signed in from an unexpected place, have the owner reset their password
       (it revokes every session) and follow
       [legal/incident-procedure.md](./legal/incident-procedure.md).
    6. **Afterwards:** record the incident in the operator log. CAPTCHA
       solves are billed ($0.40 per 1,000), so check Cost Explorer (WAF) too.
12. **The sign-in CAPTCHA misfires** (people report a puzzle they can't get
    past, or "Too many sign-in attempts from your network" when there is no
    attack, operator). The WAF's `SignInCaptchaPerIP` rule
    ([security.md § Sign-in CAPTCHA](./security.md#sign-in-captcha)) asks an
    IP past `waf_signin_captcha_per_5min` sign-ins in 5 minutes for a puzzle;
    the sign-in page shows it and signs in with the token.
    1. **Look:** WAF console, region Global → the ACL → Sampled requests for
       `SignInCaptchaPerIP`: one office or farm address (many people behind
       one NAT) means the threshold is too low for them; every IP means the
       puzzle itself is broken (the browser console on `/login` shows a CSP
       refusal or a script error; the `WAF_CAPTCHA_SCRIPT_URL` variable or
       the `WAF_CAPTCHA_API_KEY` secret is empty or stale, after
       `waf_captcha_integration_url` changed; or the key's domain isn't the
       site's).
    2. **Switch the puzzle off, keep the counts:** set
       `waf_signin_captcha_action = "COUNT"` and apply (a WAF-only change,
       seconds to take effect). The rule then only counts, and every sign-in
       goes through to the API again, where the per-address lockout and the
       `login-failed` alarm still hold. Nothing in the app changes.
    3. **Too low for a shared network:** raise `waf_signin_captcha_per_5min`
       (up to 99; the auth block is at 100) and apply.
    4. **The puzzle doesn't render:** check the integration URL
       (`aws wafv2 list-api-keys --scope CLOUDFRONT --region us-east-1 --query ApplicationIntegrationURL --output text`)
       against `waf_captcha_integration_url`, apply, re-export the Terraform
       outputs to GitHub (`WAF_CAPTCHA_SCRIPT_URL`, secret
       `WAF_CAPTCHA_API_KEY`), and deploy the web again: the script URL and
       key are baked into the build.
    5. Switch back to `CAPTCHA` once fixed, and record it in the operator log.
13. **The database's KMS key** (an email "`<event>` on the database's KMS
    key", operator; `kms.tf`, only with `rds_customer_managed_key`). Act the
    same hour: a disabled key stops the instance about 2 hours later.
    1. **Read the email:** the call (`DisableKey`, `ScheduleKeyDeletion`,
       `PutKeyPolicy`, `RevokeGrant`), who made it and whether it failed
       (an error code such as `AccessDenied` means an attempt, not a change:
       treat it as a possible compromise:
       [security.md § Incident playbook](./security.md#incident-playbook)).
       If it was your own reviewed apply that changed the key policy, record it and stop.
    2. **Check the key** (its state, deletion date and ARN; the commands
       below take the ARN, since `EnableKey`, `CancelKeyDeletion`,
       `GetKeyPolicy` and `ListGrants` don't accept an alias):
       `aws kms describe-key --key-id alias/water-management-rds --region <region> --profile water-management --query 'KeyMetadata.[KeyState,DeletionDate,Arn]'`.
    3. **`PendingDeletion`:** cancel it, then enable the key (cancelling
       leaves it `Disabled`):
       `aws kms cancel-key-deletion --key-id <key-arn> --region <region> --profile water-management && aws kms enable-key --key-id <key-arn> --region <region> --profile water-management`.
       Possible any time within the 30-day window; after it, the database
       and every backup are gone.
    4. **`Disabled`:** `aws kms enable-key --key-id <key-arn> --region <region> --profile water-management`.
       If RDS already stopped the instance (status
       `inaccessible-encryption-credentials-recoverable`), start it within 7
       days: `aws rds start-db-instance --db-instance-identifier water-management --region <region> --profile water-management`.
    5. **`PutKeyPolicy`:** compare the live policy
       (`aws kms get-key-policy --key-id <key-arn> --policy-name default --region <region> --profile water-management`)
       with `data.aws_iam_policy_document.rds_kms`; a plan shows the drift,
       and an apply of the reviewed code puts it back.
    6. **`RevokeGrant`:** if it revoked RDS's grant, the instance loses the
       key as if it were disabled, and only RDS can create its grant again
       (the key policy's `kms:GrantIsForAWSResource`). List the grants
       (`aws kms list-grants --key-id <key-arn> --region <region> --profile water-management`)
       and watch the instance status; if it goes
       `inaccessible-encryption-credentials-recoverable`, start it as in 4
       (not yet rehearsed: if it doesn't come back, restore to a new
       instance, § Restoring the database, and open an AWS Support case).
    7. Find out who and why in CloudTrail (the email names the caller), and
       record it in the operator log.

14. **Someone lost their authenticator app and their recovery codes**
    (operator; two-step sign-in, [security.md § Two-step sign-in](./security.md#two-step-sign-in)).
    There is no reset route by design: a reset link to the inbox would be a
    way round the second factor for anyone who holds the inbox. Confirm who
    is asking out of band (a call to a number the WUA or consultancy has on
    file, not one in the request), then, as the schema owner, in one
    transaction:
    `DELETE FROM user_recovery_code WHERE user_id = '…'; DELETE FROM user_totp WHERE user_id = '…'; UPDATE app_user SET sessions_revoked_at = now() WHERE id = '…';`
    (the last line signs out every session, a thief's included). They sign
    in with the password and set up a new authenticator on the Account
    page; if they are an owner, team admin or assessor, they need it before
    those actions again. If the password may be known to someone else too,
    have them reset it first. Record the request and how identity was
    checked in the operator log.
15. **`APP_ENCRYPTION_KEY` leaked, or must change** (operator). The key seals
    every TOTP secret; a new one can't open the old rows. Edit
    `app_encryption_key` with sops and apply (§ Rotating a secret), then, as
    the schema owner, `DELETE FROM user_recovery_code; DELETE FROM user_totp;`
    and tell every person who had two-step sign-in on to set it up again
    (owners, team admins and assessors can't do those actions until they
    have). Their security log keeps the history.

## Rollback

- **Code:** deploy the last good tag by hand. It goes through the same
  preflight (without the "newer than" rule) and the same approval:
  `gh workflow run deploy-backend.yml -f tag=backend@0.1.0`, or
  `gh workflow run deploy-frontend.yml -f tag=web@0.1.0`. The artifacts that
  shipped are also attached to each Release. A backend tag from before
  response streaming (WP-1.29a) exports a buffered handler, so rolling back
  past it also needs the Function URL put back to `BUFFERED` in Terraform,
  applied back to back with the deploy (§ Response streaming).
- **Database:** migrations are forward-only, so a backend rollback runs old
  API code against the current schema. That is safe only because migrations
  are expand/contract. To undo a migration, ship a new one. For data loss,
  restore the database to a point in time with
  `infra/scripts/restore-db.sh` (§ Restoring the database, next).

## Restoring the database

For lost or damaged data (a destructive migration, a bad bulk edit, anything
the app's own revision history can't undo) and for an instance RDS can't
bring back. The script restores into a **new** instance beside the old one,
checks it, then swaps identifiers so the endpoint address, `DATABASE_URL` and
Terraform's resource address all stay the same. The old instance is kept
until you delete it.

**What you lose (RPO).** A point-in-time restore can land on any second from
the earliest restorable time (the retention window,
`db_backup_retention_days`: 7 days by default, 14 in the full tier) up to
`LatestRestorableTime`, which trails the present by about **5 minutes**,
because RDS uploads the transaction logs to S3 every five minutes
([AWS: Restoring a DB instance to a specified time](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html)).
A snapshot restore loses everything since the snapshot. Whatever reaches the
old instance after the restore point stays on the old instance only.
Multi-AZ (the full tier) covers a lost host or AZ with no data loss; this
restore is for damage to the data itself.

**Why a script, not the console.** `RestoreDBInstanceToPointInTime` creates
the target "with the default security group, the default subnet group, and
the default DB parameter group", and deletion protection "isn't enabled" by
default ([API reference](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_RestoreDBInstanceToPointInTime.html);
the snapshot restore is the same,
[RestoreDBInstanceFromDBSnapshot](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_RestoreDBInstanceFromDBSnapshot.html)).
Restored with only the obvious flags, the copy lands in the account's default
VPC, where none of the Lambdas can reach it, without this project's TLS and
logging parameters, and deletable. The script passes the stack's subnet
group, security group and parameter group (from `terraform output`; the
parameter group's name has a generated suffix), deletion protection, no
public access, tag copying, and the live instance's class, Multi-AZ, CA,
backup retention and window, maintenance window, minor-upgrade setting,
storage-autoscaling ceiling and tags. Encryption and its KMS key come from
the backup (a restore can't change them); monitoring and Performance
Insights stay off, as `rds.tf` has them. It then checks all of that on the
restored instance and stops, before touching production, if anything is off.

**The master password is not kept.** A PostgreSQL restore can neither keep
nor request RDS-managed master credentials: `ManageMasterUserPassword` on
both restore APIs "Applies to RDS for Oracle only"
([API reference](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_RestoreDBInstanceToPointInTime.html)),
and the RDS guide lists "Restore a DB instance from a snapshot or to a point
in time (RDS for Oracle only)" among the operations that can turn it on
([AWS: Password management with Secrets Manager](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html)).
Broadcom's field note on the same case says the restored instance "does not
have the AWS Secrets Manager integration enabled"
([KB 388927](https://knowledge.broadcom.com/external/article/388927/general-guideline-about-restoring-rds-db.html)).
So the copy comes up with `water`'s password as it stood at the restore point
(the database's own catalogue) and no `MasterUserSecret`; the old instance's
secret still belongs to the old instance and is deleted with it. The script
therefore runs `modify-db-instance --manage-master-user-password` on the
copy, which gives it a **new** secret with a new ARN, and waits for it to be
`active`. The migrate Lambda's `MASTER_SECRET_ARN` and the Secrets Manager
endpoint's policy name that ARN, so the migrate Lambda can't log in until
the Terraform apply below. `water_app`'s password lives in the database, so
the API works as soon as the swap finishes (unless `db_app_password` was
rotated after the restore point; the migrate run below resets it). The
rehearsal confirms this on a real restore (checklist below).

**Why the script moves Terraform state.** The AWS provider keys
`aws_db_instance` by its `DbiResourceId`, not its identifier (it reads by
resource ID and only falls back to the identifier when that ID is gone;
[provider source, v6.66.0](https://github.com/hashicorp/terraform-provider-aws/blob/v6.66.0/internal/service/rds/instance.go),
`resourceInstanceRead` / `findDBInstanceByID`). After the swap, a plain
refresh would find the *old* instance under its new name and plan to rename
it back. So the script runs `terraform state rm aws_db_instance.main` and
`terraform import aws_db_instance.main water-management`, then a `plan`
(without `-out`: a plan file holds a copy of state, CloudFront header
included, infra/README.md). Import and plan run through `infra/scripts/tf.sh`
(the runtime secrets from sops); the script checks for sops and the secrets
file before it touches anything. The
plan should show only in-place changes: the migrate Lambda's
`MASTER_SECRET_ARN`, the Secrets Manager endpoint policy, and arguments that
exist only in Terraform (`final_snapshot_identifier`, `skip_final_snapshot`,
`delete_automated_backups`, `apply_immediately`). The script stops on a
replace or destroy; don't apply one.

**Doing it:**

1. Pick the restore point in UTC, just before the damage (CloudTrail, the
   deploy log, the app's audit log). If something is still writing bad data,
   stop the API and the worker first (the apply in step 5 puts their
   concurrency back):
   `aws lambda put-function-concurrency --function-name water-management-backend --reserved-concurrent-executions 0 --region <region> --profile water-management`
   and the same for `water-management-worker`. The fetcher and the renderer
   run outside the VPC and never reach the database.
2. `aws sso login --profile water-management`, and have `infra/` initialised
   (`terraform init -backend-config=backend.config`, § 3).
3. Dry run. It makes only read calls (the caller, `terraform output`, the
   instance, its restore window) and prints every command it would run:
   `infra/scripts/restore-db.sh --region <region> --profile water-management --var-file ../infra-secrets/water-management/prod.tfvars --restore-time 2026-09-28T08:15:00Z`
   (or `--latest`, or `--snapshot <id>`). It refuses a time outside the
   restore window, a region that isn't the stack's, and a missing profile or
   region.
4. The same with `--execute`. It asks you to type the identifier before the
   swap (`--yes` skips that). The API is down from the first rename to the
   end of the second, a few minutes; the restore before it takes roughly
   15 to 30 minutes for a small database. If it stops part-way, it prints
   where and the command that finishes or undoes that step.
5. Read the plan it printed, then apply it (the script never applies):
   `cd infra && AWS_PROFILE=water-management ./scripts/tf.sh apply -var-file=../../infra-secrets/water-management/prod.tfvars`.
6. Invoke the migrate Lambda (the script prints the command). It applies any
   migration newer than the restore point and resets `water_app`'s password.
6a. **Re-apply erasures and revocations** (POPIA s14(4), s24; provisional
   position, pre-counsel research, 2026-10-01). A restore takes the database
   back to before every deletion and revocation made since the restore
   point, so a deleted account, project or team, a removed member, an
   unlinked farmer, a revoked share link or API key would all be live again.
   Keep the API and the worker stopped until this is done: if traffic is
   back after step 5's apply, stop them again with step 1's commands. On the
   **old** instance (still running as `water-management-old-<ts>`), as the
   schema owner:
   - `SELECT kind, subject_id, erased_at FROM erasure_log WHERE erased_at > '<restore point>' ORDER BY erased_at;`
   - `SELECT kind, project_id, subject, created_at FROM audit_event WHERE created_at > '<restore point>' AND kind IN ('member.removed', 'team_member.removed', 'farmer.unlinked', 'share_link.revoked', 'api_key.revoked', 'invite.revoked') ORDER BY created_at;`

   Then on the restored instance, as the schema owner, in one transaction:
   delete each listed `app_user`, `project` and `team` row (`kind` account,
   project, team; the triggers pseudonymise and log as they did the first
   time), and re-apply each removal, unlink and revocation the events name
   (delete the `project_member`, `team_member` or `farm_link` row; set
   `revoked_at` on the share link or API key; delete the invite). Invoke the
   worker once (`aws lambda invoke --function-name water-management-worker …`,
   the production `pnpm dev:jobs:tick`) so the time-based purges catch up:
   lapsed invites, deleted notes' text, alert deliveries, pack notices. Only
   then let traffic back (run step 5's apply again; it restores the
   concurrency). Record each re-applied erasure in the operator log.

   **If the instance itself is gone** (below), there is no old instance to
   read: take the erasures since `LatestRestorableTime` from the operator
   log and from CloudWatch, where every self-service deletion logs
   `account_deleted` with its `accountId`
   (`filter message.event = "account_deleted"` in Logs Insights on the API's
   log group, 30 days).
7. Check the site and that the data is as of the restore point, with the
   erasures re-applied.
8. Only then delete the old instance (the script prints the commands: turn
   off its deletion protection, then `delete-db-instance`). Take a final
   snapshot (`--final-db-snapshot-identifier …`) only if you may need data
   written after the restore point, and **delete it within 30 days**: it
   holds everything erased since the restore point and, unlike automated
   backups, never expires on its own. Put its delete-by date in the
   operator log. Export first anything written to the old instance after the
   restore point that you want back.

**If the instance itself is gone** (deleted, or never coming back from
`failed`), the script refuses, since it swaps with the live instance. The
automated backups outlive the instance (`delete_automated_backups = false`),
so restore straight into the original identifier with the same flags the
script's dry run prints, from `--source-dbi-resource-id` (see
`aws rds describe-db-instance-automated-backups`), then turn on the managed
password and do the state move, plan, apply and migrate as above.

**Rehearse it once before go-live** (operator; it needs the deployed stack,
so it can't be tested here beyond `infra/scripts/restore-db.test.mjs`, which
runs it against a fake `aws` and `terraform`):

- [ ] After the first deploy, with only test data in, run steps 2 to 8 with
      `--latest`. Cost: about an hour of a second db.t4g.micro, cents.
- [ ] After step 4, confirm the master-password finding on a real restore:
      `aws rds describe-db-instances --db-instance-identifier water-management --query 'DBInstances[0].MasterUserSecret' --region <region> --profile water-management`
      shows a new, `active` secret (and note whether the copy had none before
      the modify, as the docs say).
- [ ] Confirm the plan was in-place only, and the migrate run and the site
      work after the apply.
- [ ] The re-apply step (6a) against a test erasure made after the restore
      point: delete a test account and revoke a test share link after it,
      then confirm both are gone again on the restored instance.
- [ ] Write down how long the restore, the swap and the whole run took (the
      real RTO), and the date, here.

Rehearsed: not yet.

## Costs (rough, idle to light use)

CloudFront, S3, Lambda and SES sending are cents. WAF is ~$8/month. The DB is
the main cost: RDS t4g.micro at ~$14/month. The VPC Lambdas' three interface
endpoints (Secrets Manager, SES API, SQS) cost ~$7.30/month each per AZ, which is
still cheaper than a NAT (~$33/month plus data); the data feeds' fetcher and
the report renderer run outside the VPC for the same reason. The database's
customer-managed KMS key (§ Decide before the first apply) adds $1–3. Total ≈ $52/month in
us-east-1, ≈ $59–64 in af-south-1; the breakdown is in
[infra/README.md § Cost](../infra/README.md#cost). CloudFront and WAF
request charges have no ceiling; the `cloudfront-requests` alarm (us-east-1)
fires within 5 minutes of a flood, long before the budgets' billing data
catches up (§ Runbooks, Request flood). The minimal (defaults)
and full (Multi-AZ, highly available) configurations, their tfvars and
monthly cost are compared in [deployment-tiers.md](./deployment-tiers.md).

### Budget alerts

Terraform creates two budgets and, once it is turned on, a Cost Anomaly
Detection monitor (`alarms.tf`, all free), mailed through the **us-east-1**
alerts topic to `budget_alert_email`:

- **Daily budget, ACTUAL 100%** (`budget_daily_usd`, default
  `ceil(budget_monthly_usd × 2.25 / 30)` = $7/day on $90, about 3.5× the
  ~$2/day af-south-1 idle): a single day cost more than that. This is the
  one that works in the **first month**, when the monthly forecast has no
  history. Daily budgets support ACTUAL notifications only.
- **Monthly, ACTUAL 80%** ($72 on the default $90, above the
  af-south-1 idle): spend is heading for the budget.
- **Monthly, ACTUAL 100%**: the budget is spent.
- **Monthly, FORECASTED 100%**: AWS expects the month to overrun. Silent
  until AWS has ~5 weeks of cost history.
- **Cost anomaly** (`cost_anomaly_threshold_usd`): one service's spend
  jumped against its own history (needs ~10 days of it). **Off by default**
  (0): an account may hold only one AWS-services monitor, and AWS creates a
  default one for some new accounts, so creating ours could fail the first
  apply. Nothing is lost by waiting, since it has no history to learn from
  yet. **After the first apply**, turn it on: check for an existing monitor,
  import it if there is one, set `cost_anomaly_threshold_usd = 10` and
  apply ([infra/README.md § Operator steps](../infra/README.md#operator-steps),
  step 11, has the commands).

Billing data refreshes at least daily, so every one of these lags the spend
by up to a day; the Lambda concurrency caps and the CloudWatch alarms are
what bound and report a runaway as it happens. On any of them: open Cost
Explorer, group by service and usage type for the last few days, and find
what grew. `budget_monthly_usd` defaults to 80 (af-south-1; ~60 is enough
in us-east-1, ~170 on the full tier). Before billing access is enabled, set
it to 0 ([infra/README.md § Operator
steps](../infra/README.md#operator-steps), step 4).
