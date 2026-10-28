# Deployment

> **Status:** deployed (2026-10-05) at `https://water-management.jaredhoward.com`,
> minimal tier in `af-south-1`. Issue #551 renames the app Integrated
> Catchment - Water Balance Tool (IC-WBT) and moves it to
> `https://icwbt.jaredhoward.com`, the old hostname redirecting; the
> Terraform for it is in, and the operator's steps are
> [§ Moving the site to a new domain](#moving-the-site-to-a-new-domain). The Terraform (VPC, RDS, the five Lambdas, the
> SQS queues, the S3 buckets, SES, CloudFront + WAF + security headers, alarms
> and budgets) is applied, `backend@0.1.0` and `web@0.1.2` are released, the
> report renderer is created, and `infra/scripts/postapply-check.sh` passes. The map
> serves the basemap, its label fonts and the relief, and delineation is on
> (`delineation_dem`; [§ Map tiles](#map-tiles)). SES production access was
> granted 2026-10-06, so mail reaches any address, and sign-up has been open
> since that day (`signup_open = true`, [§ Who can sign up](#who-can-sign-up)). Still open: tracing a dam (`water.pmtiles`,
> `dam_trace_water`) and the first restore rehearsal; [plan.md Phase 6](./plan.md#phase-6-deploy-to-aws) tracks
> them. This page describes the setup and the steps that built it.

## Target setup

```
browser ──HTTPS──► CloudFront (+ WAF rate limit) ── icwbt.jaredhoward.com
                     │                                 (water-management.jaredhoward.com: pages 301 here)
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
- **Outside the VPC:** the data feeds' fetcher Lambda (§ Data feeds) and
  the report renderer, a container-image Lambda (§ Reports), reach the
  internet directly and hold no database access; they talk to the worker
  through SQS queues, each with a DLQ.
- **Storage:** private S3 buckets for the SPA, report PDFs (7 days),
  issued evidence packs (Object Lock, § Evidence packs), the map's tiles
  and the reference datasets (§ The Map tab). The VPC reaches S3, Secrets
  Manager, SES and SQS through one interface endpoint each (no NAT). The
  full diagram is [infra/README.md § Architecture](../infra/README.md#architecture).
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
- **The assistant is the one exception, even in af-south-1** (issue #610,
  [§ The assistant](#the-assistant)). Bedrock offers Anthropic's Claude
  models in af-south-1 only through *global* cross-Region inference: In-Region
  and geographic (Geo) inference are "not supported" there for Claude Haiku
  5.5, Sonnet 5.5 and Opus 5.5, Global is
  ([Bedrock, Regional availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html);
  [Claude Sonnet 5.5's model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html),
  read 2026-10-27). A global profile "routes your requests to supported
  commercial AWS Regions worldwide", on AWS's network, encrypted between
  regions, with CloudTrail logging each call in the source region
  ([Global cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html);
  [Cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)).
  So a turn's prompt and the project data its tools read leave South Africa
  while it is answered: an s72 transfer, recorded in
  [security.md § Personal information (POPIA)](./security.md#personal-information-popia)
  and disclosed in Privacy §6. No new sub-processor (Bedrock is AWS, and the
  model provider never sees prompts:
  [Bedrock data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)).
- **Latency.** Users are in South Africa. Cape Town is roughly 20–50 ms from
  most of the country versus ~150–200 ms to Ireland. Static files come from
  CloudFront edges either way (Terraform uses **PriceClass_All**, the only
  class with South African edge locations per AWS's pay-as-you-go price-class
  table),
  but every API call and model run goes to the region.

| | af-south-1 (recommended) | eu-west-1 (Ireland) | us-east-1 |
| --- | --- | --- | --- |
| POPIA | No cross-border transfer (but the assistant's model calls are one, below) | s72 transfer: justify, disclose | s72 transfer: justify, disclose |
| API latency from SA | ~20–50 ms | ~150–200 ms | ~230+ ms |
| SES API + VPC endpoint | Yes (no SMTP; not needed) | Yes | Yes |
| Opt-in region | Yes: enable first (operator step 2) | No | No |
| Idle cost, minimal tier ([deployment-tiers.md](./deployment-tiers.md); list prices 2026-10-04) | ≈ $77/month | ≈ $67/month | ≈ $63/month |
| SES sending reputation | Separate per region; a new account starts in the sandbox anywhere | same | same |

Tradeoffs of af-south-1 to accept: ~30% higher prices on RDS, endpoints
and storage (the default `budget_monthly_usd = 110` allows for them), the opt-in step, and a
somewhat smaller service catalogue (everything this stack uses is there).
Choose eu-west-1 only if the client explicitly accepts the transfer and the
~$10/month saving matters more than latency (and only with
`data_outside_south_africa = true` and the privacy notice's §6 rewritten:
Terraform refuses any other region without it).

Whatever the region, SES follows `aws_region` in Terraform: the DKIM target
domain, the MAIL FROM MX and the VPC endpoint name are derived from it and
covered by the Terraform tests.

## Prerequisites

- The AWS org and SSO set up as for the other estate projects (`aws sso login`).
- Terraform (via tfenv), `gh` authenticated, `sops`, `jq`.
- The templates repo at `~/github/templates` and the private
  `~/github/infra-secrets`.

## 1. Provision the account (one-time)

Create `~/github/infra-secrets/water-management/bootstrap.tfvars` (the
private estate repo, one file per project; copy it from the templates repo's
`infra/bootstrap/projects/example.tfvars`, with `create_subdomain = true`) and
commit and push it there: the script refuses an unsaved one, and it is the
only record of the account's root email, which AWS never lets you change or
reuse. Set `github_subject_prefix` to what
`gh api repos/Absence0760/project-water-management/actions/oidc/customization/sub --jq .sub_claim_prefix`
prints, never to `repo:<owner>/<repo>`: this repo is on GitHub's immutable
subject claims, so its OIDC subject carries numeric IDs, and a slug-form
prefix leaves every deploy failing to assume the role
(Runbook G in `~/github/project-mgmt/docs/runbooks.md`). Keep
**`region = "us-east-1"`** in it, even though the workloads run in
af-south-1. The bootstrap creates the tfstate bucket and the sops KMS key in
that `region`, and this repo's Terraform backend reads state from us-east-1
only (`infra/main.tf`, `backend "s3"`; `sops-init.sh --region us-east-1`,
infra/README.md step 5). The example's comment offers opt-in regions such as
af-south-1: don't take it here, or `terraform init` looks for the bucket in
the wrong region. The workload region is `aws_region` in `prod.tfvars`
(§ 3). Then, from the templates repo:

```bash
aws sso login --profile mgmt && aws sso login --profile dns-parent
cd ~/github/templates && ./scripts/new-project-account.sh water-management --plan
cd ~/github/templates && ./scripts/new-project-account.sh water-management
```

Both profiles must be signed in before either run: stage 1 (the account)
and stage 2 (the baseline, through `OrganizationAccountAccessRole`) run as
`mgmt`, stage 3 (the delegation) as `dns-parent`. `--plan` shows stage 1
only, since the later stages need the new account's ID. Stage 2 can fail
right after stage 1 with `NotSignedUp` (S3) or
`SubscriptionRequiredException` (KMS) while the new account's services
activate; wait a few minutes and re-run the same command (stage 1 is then a
no-op).

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
  Terraform. Since issue #551 the site is at **`icwbt.jaredhoward.com`**, a
  second child zone the operator made by hand
  ([§ Moving the site to a new domain](#moving-the-site-to-a-new-domain));
  the bootstrap's zone stays for the old hostname's redirect.

It also turns on **required linear history** on `main`, so GitHub accepts
only squash and rebase merges there.

The bootstrap does **not** give your SSO user access to the new account.
Assign it in Identity Center (Runbook D: user → the account →
`AdministratorAccess`, from the `mgmt` account), then add the workstation
profile every later step uses, with the same SSO start URL as `mgmt` and
default region us-east-1 (af-south-1 isn't enabled yet):

```bash
aws configure sso --profile water-management
aws sts get-caller-identity --profile water-management --query Account --output text
```

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

- **Domain identity** for `domain_name` (`icwbt.jaredhoward.com` since
  issue #551; it was `water-management.jaredhoward.com`) with **Easy
  DKIM** (RSA 2048). The three `<token>._domainkey` CNAMEs go into the child
  Route 53 zone. Their target is `<token>.dkim.amazonses.com`, or the regional
  `<token>.dkim.<region>.amazonses.com` in af-south-1 and the other newer
  regions; Terraform picks the right one.
- **Custom MAIL FROM** `mail.icwbt.jaredhoward.com`, with its MX
  (`10 feedback-smtp.<region>.amazonses.com`) and SPF TXT
  (`v=spf1 include:amazonses.com -all`), so SPF aligns for DMARC. If the MX
  ever goes missing, SES falls back to its own MAIL FROM instead of bouncing
  (DKIM still aligns).
- **DMARC** TXT `_dmarc.icwbt.jaredhoward.com`:
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
  `ses:FromAddress = no-reply@icwbt.jaredhoward.com`. Nothing else.
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
| `MAIL_FROM` | `IC-WBT <no-reply@icwbt.jaredhoward.com>` (`mail_from_display_name`, `mail_from_local_part`) |
| `SITE_URL` | `https://icwbt.jaredhoward.com` (the base of every emailed link) |
| `SES_CONFIGURATION_SET` | `water-management` |
| `SES_REGION` | unset: SES is in the Lambda's own region |
| `RUNS_KEPT_PER_PROJECT` | not set by Terraform, so the backend default (20 runs per project) applies; see [data-model.md § Run output volume](./data-model.md#time-series-storage) |

The worker (`infra/jobs.tf`) also gets `OPERATOR_EMAIL`, set to
`budget_alert_email`: the operator's copy of the licence-record notices
([evidence-pack.md § Retention](./evidence-pack.md#retention)).

Besides the email settings, `lambda.tf` sets `ALLOWED_ORIGINS` (the site
origin), `COOKIE_SECURE=true`, `NODE_EXTRA_CA_CERTS` (the RDS CA bundle),
`DB_POOL_MAX=2` (the `pg` pool per container; the config check refuses a
missing one or one that isn't a whole number of at least 1) and
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
`domain_name = "icwbt.jaredhoward.com"`, `route53_zone_id` (its child zone),
`redirect_domains` (each former hostname and its zone: the bootstrap's
`water-management.jaredhoward.com`; `{}` once retired),
`bootstrap_slug = "water-management"`, the region, the budget
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

While `redirect_domains` holds a former hostname, add `--redirect-from <host>`
for each (`--redirect-from water-management.jaredhoward.com` since issue
#551): its pages must 301 to the site and its `/api/health` must still answer
([§ Moving the site to a new domain](#moving-the-site-to-a-new-domain)).

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
| `INGEST_FUNCTION_NAME` | `ingest_function_name` (the data mirror's ingest job; always an output, even before the function exists, so the preflight requires it) |
| `INGEST_ECR_REPOSITORY` | `ingest_ecr_repository` (the ingest image's ECR repository; the release preflight requires it) |
| `PUBLIC_SITE_URL` | `public_site_url` |
| `CLOUDFRONT_DOMAIN_NAME` | `cloudfront_domain_name` (not read by the workflows) |
| `REPORTS_BUCKET`, `PACKS_BUCKET`, `TILES_BUCKET`, `REFERENCE_BUCKET`, `MIRROR_BUCKET`, `DB_INSTANCE_IDENTIFIER`, `DB_SUBNET_GROUP_NAME`, `DB_SECURITY_GROUP_ID`, `DB_PARAMETER_GROUP_NAME` | the outputs of the same names (not read by the workflows; the bucket names are for the operator's uploads, the `db_*` ones for `restore-db.sh`, which reads them from Terraform) |
| secret `AWS_DEPLOY_ROLE_ARN` | `aws_deploy_role_arn` |
| secret `LAMBDA_FUNCTION_URL` | `lambda_function_url` (debugging only) |
| `WAF_CAPTCHA_SCRIPT_URL` | `waf_captcha_script_url` (the sign-in CAPTCHA's jsapi.js; empty until `waf_captcha_integration_url` is set) |
| secret `WAF_CAPTCHA_API_KEY` | `waf_captcha_api_key` (the CAPTCHA API key for the site's domain; it ships in the public bundle, but the provider marks it sensitive) |
| `PUBLIC_TILES_URL`, `PUBLIC_TILES_GLYPHS_URL`, `PUBLIC_TERRAIN_URL` | not outputs: set by hand once the files are in the tiles bucket (§ Map tiles); unset, the map draws the plain background |

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
(`paths.origin` in `frontend/vite.config.ts`'s `sveltekit({…})`). CloudFront serves
`/welcome` from `welcome.html` and `/welcome/af` from `welcome/af.html`
(`spa_rewrite`).

The same build bakes in `ENGINE_BUILD`, the engine's build record
(`scripts/release/engine-build.mjs`, run just before it: version, git SHA,
invariants passed, soak cases), which the report's validation statement
prints ([model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313)).
A local or e2e build has none and says *Not recorded for this build*.

### What the Terraform builds

Applied 2026-10-04 (minimal tier), and tested plan-only with mocked providers in CI:

- RDS PostgreSQL 17 in private subnets; the API, worker and migrate
  Lambdas in the VPC (four interface endpoints: Secrets Manager, SES, SQS,
  S3; no NAT), the **migrate Lambda** being what the deploy runs before
  publishing new code and what `load-reference.yml` invokes.
- The API Lambda: runtime `nodejs24.x`, 30 s timeout, 1024 MB, reserved
  concurrency 25 (`lambda_reserved_concurrency`; with `DB_POOL_MAX=2`, at
  most 50 database connections, infra/README.md § Connections), with `DATABASE_URL`, `AUTH_JWT_SECRET` and its other
  secrets from sops (`scripts/tf.sh`, ephemeral variables, `secrets.tf`), in
  its runtime secret in Secrets Manager, written write-only: not in its
  environment, not in Terraform state. The worker and migrate Lambdas have
  one each the same way.
- The fetcher and renderer Lambdas outside the VPC (§ Data feeds,
  § Reports; the renderer only once `renderer_image_tag` is set), the
  renderer's ECR repository, and the reports, packs, tiles and reference
  buckets (§ Evidence packs, § The Map tab).
- The data mirror (`ingest.tf`, § The data mirror): its private, versioned
  bucket, the ingest job's ECR repository, its DLQ and its daily schedules
  (disabled), and the ingest Lambda outside the VPC once `ingest_image_tag`
  is set.
- No CORS block on the Function URL (the browser never calls it).
- SES (above), CloudFront security headers and CSP, PriceClass_All.
- Background jobs (`jobs.tf`, § Background jobs below): the SQS `jobs`
  queue + DLQ, the worker Lambda, its 5-minute EventBridge tick and the SQS
  interface endpoint; the `fetch-requests`, `ingest-results`,
  `render-requests`, `render-results` and `mail-events` queues, each with a
  DLQ.
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

  Which of those alarms exist is set by `alarm_tier` (`infra/alarms.tf`
  § Alarm tier). Production runs `"essential"`: SES bounce and complaint
  rates, the jobs / mail-events / fetch-requests / ingest-results DLQ
  arrivals, the worker heartbeat, RDS free storage, CloudFront 5xx, API
  Lambda errors and throttles (`lambda-throttles`: the API at its reserved
  concurrency, issue #541), `unhandled_error` and `mail_send_failed`, 13
  alarm metrics; 15 once `ingest_image_tag` is set, with the data mirror's
  two freshness alarms (§ The data mirror).
  Everything else listed above is declared but not created; its metrics and
  log lines are still there, just unpaged. Set `alarm_tier = "full"` in the
  prod tfvars to page on all of it (~$5/month in af-south-1). The RDS event
  subscription, the KMS key EventBridge rule, the budgets and Cost Anomaly
  Detection are not CloudWatch alarms and run on every tier.

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
Among them: every job gated on `environment: production` must need a job
that runs `scripts/release/preflight.mjs` (rule `preflight`; the deploy
workflows run it per component, `load-reference.yml` in `environment` mode),
since naming a missing environment would create it with no reviewer; and a
job that grants `id-token: write` (or `write-all`) must be gated
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

Docs-only and draft **pull requests** (a draft by `github.event.pull_request.draft`; docs-only means only `docs/`, `.claude/` or `*.md` files,
decided by the `changes` job) skip the heavy jobs, but `CI gate` still
reports. Marking a draft **Ready for review** fires `ready_for_review`, which
runs the full suite on the same commit; the workflow guard's `draft-ready`
rule refuses a draft skip without that trigger type, so a draft's skipped
gate can never be what a merge rests on. A **push to `main`** always runs every job, whatever it changed: a
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
the PR's branch name. It queues the merge only when the repository allows
auto-merge (Settings → General → Pull Requests → Allow auto-merge, read
from the API each run); with that off it leaves a notice and the PR waits
for a human. `pnpm check:workflows` (auto-merge rule) fails if any of these
exclusions, or the setting's read, is dropped. A
security fix that can't wait the week goes under
`minimumReleaseAgeExclude` with a comment, removed once the week is up.
An advisory with no fixed release is patched locally instead
(`pnpm patch`, listed under `patchedDependencies` in `pnpm-workspace.yaml`
with a guard test), and `osv-scanner.toml` records it with an expiry so
Scorecard's Vulnerabilities check reads it as handled: deepmerge 4.3.1
(GHSA-gcqx-w48m-w2h4) is the one today.

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
  `csp: { mode: 'hash', directives: { 'script-src': ['self', …] } }` in
  `frontend/vite.config.ts`'s `sveltekit({…})` (SvelteKit 3 reads its config
  there). It then uploads `_app/immutable/` with a
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
  the fetcher's after the worker's, then the assistant's (§ The assistant;
  skipped with a notice while `assistant_enabled` is false; with the
  `ASSISTANT_FUNCTION_NAME` variable unset the step tries the conventional
  `water-management-assistant`, so a forgotten variable can't leave the
  function on older code). Then the renderer's image (built in the
  `build` job, no AWS credentials) is pushed to ECR and the renderer Lambda
  moved to it; until the operator has created the function (§ Reports) the
  step pushes the image and says what to do, and any other `get-function`
  error fails the deploy. The data mirror's ingest image goes the same way
  (built in the `build-ingest` job on GitHub's arm64 runner, no AWS
  credentials; § The data mirror). Then the job calls `/api/health` through
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
| assistant `lambda-assistant.mjs` | the API's bundle plus the Bedrock client (issue #610; not yet measured) | – |

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
  concurrent executions (25 by default) while it runs. Lambda keeps
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
| `backend@X.Y.Z` | `deploy-backend.yml` | migrate Lambda (runs the migrations), then the API, worker and fetcher Lambdas, then the renderer's and the mirror ingest job's images (pushed to ECR; each function moved to its image once it exists), then the health check |
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
     30 minutes while CI is still running, so a release can be cut straight
     after a merge: `CI gate` is ci.yml's last job and has no check run until
     the others finish, so an unfinished ci.yml run of the commit counts as
     still running). Only a `CI gate` posted by the
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
soak widened to N, on this commit, each shard's timeout loosened to 2 s a case
(`FUZZ_MS_PER_CASE`, `RELEASE_MS_PER_CASE`; the plain suite's is 0.6 s): the
timeout is a hang guard, and a slow runner at ~0.4 s a case once timed out
`web@0.1.6`'s shards with every invariant holding. A failing suite fails the release. The
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
   **Import workbook** on the project list and pick the `.xlsm`. It is
   read in the browser (only the project is sent), and the review shows the
   importer's notes and the unmapped report ([ui.md](./ui.md#import-a-workbook)).
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
runs in production as `JOB_TRANSPORT=sqs` (infra/jobs.tf):

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
  `lambda-worker.handler`): in the private VPC, 1024 MB (2 048 with
  `delineation_dem`, § The Map tab), 300 s, reserved
  concurrency 8 (`worker_reserved_concurrency`: at least the sum of its four
  SQS triggers' `maximum_concurrency`, 4 × 2, or throttled pollers burn
  receive counts into the DLQs), connecting as `water_app` (pool of 2) with
  verified TLS.
  Each invocation runs one tick within its remaining time (less a minute);
  jobs lease for 6 minutes, longer than the function can run. A handler
  that bounds its own work gets the function's deadline (less 10 s;
  `JobContext.deadline`): a `delineate` job fits its budget inside it, and
  one claimed with under 20 s left, or cut short by it before its last
  window, goes back to the queue 120 s on without spending an attempt
  (`app_release_job`, `job_released` in the log).
- **Network:** one SQS interface endpoint (private DNS, `sqs_endpoint_az_count`
  default 1) whose policy allows `SendMessage` only: the API role to `jobs`,
  the worker role to `fetch-requests` and `render-requests`. The worker
  receives through its event source mappings, whose pollers run in the
  Lambda service, not through the endpoint. No NAT.
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
on the job queue, with the fetching done outside the VPC (infra/feeds.tf):

- **The worker** (`FEED_FETCHER=sqs`) never fetches: a `feed_fetch` job sends
  a versioned request to the `fetch-requests` queue
  (`FETCH_REQUESTS_QUEUE_URL`) and is done. The queue is FIFO
  (`…-fetch-requests.fifo`, since issue #604), each request in its source
  host's message group (`chc`, `dws`), so the fetcher runs one fetch per
  host at a time ([architecture.md § Data feeds → Throttling](./architecture.md#data-feeds)). This per-feed path, the two
  queues and everything below that serves them, lasts until the cutover
  ([§ The cutover](#the-cutover)): with `chirps_source = "mirror"` and
  `dws_source = "store"` every fetch is read in the worker's own job and
  Terraform removes them.
- **The API and the worker** both set `FEED_SOURCE=live`, though neither
  fetches: it is also which CHIRPS cell cache a process reads
  (`cacheOrigin`, `backend/src/feeds/cellCacheStore.ts`). The fetcher's
  answers are merged as `chc`; a process left on the default (`fixtures`)
  reads the fixtures' rows, which production never fills, so a run started
  on the API would get no CHIRPS for its reference cell or rainfall stations,
  and the Data feeds panel would call the live feeds sample data. Until
  2026-10-25 the API had it unset; the backend's production check now refuses
  an API or worker without it (`config/production.ts`), so apply the
  Terraform that sets it before releasing a backend that checks it.
- **Fetcher Lambda** (`backend/src/lambda-fetcher.ts`, handler
  `lambda-fetcher.handler`): **no VPC** (it is the only Lambda with internet
  access, which is what keeps the feeds from needing a NAT), 512 MB, 900 s,
  reserved concurrency `fetcher_reserved_concurrency` (2). `FEED_SOURCE=live`,
  and `FEEDS_CONTACT` from `feeds_contact` (required; the contact in its user
  agent, which CHC asked for). It reads CHC one file at a time, about one
  request a second, and answers a long backfill window with the days it
  finished in time.
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
  doubling up to a day; 2 hours, doubling, after an HTTP 403).
- **Alarms** (to the alerts topic): `fetch-requests-dlq-arrivals` and
  `ingest-results-dlq-arrivals` (a new DLQ message, § Background jobs);
  `fetcher-errors` (a crash or timeout) and `fetcher-throttles` (it hit
  `fetcher_reserved_concurrency`), both > 0; `fetch-requests-age`, a request
  waiting over an hour (nothing is consuming the queue: the fetcher still the
  stub, its trigger disabled, or throttled; the request would otherwise
  expire unseen after 4 days); and `feed-fetch-failed`, any fetch the fetcher
  answered as failed in an hour. That last one is invisible to
  `fetcher-errors`, because the Lambda succeeded: it counts the fetcher's
  `{"event":"feed_fetch_failed","feedId","fetchJobId","source","reason","detail"}`
  log line (ids, the source, a reason code and the safe part of the failure:
  `detail` is the HTTP status, `HTTP 429`, one of the live client's own
  texts, `the request timed out`, a server error page's label, `ScriptServer
  error page`, or which DWS check failed, `no data table`, else null; never
  the stored message, which can name a grid cell or a station). A stale or failing feed also shows in the
  app, and emails the owners and editors of a project with the `data_stale`
  or `feed_failing` alert on.
  - *Runbook: `feed-fetch-failed`.* Logs Insights on the fetcher's log group:
    `filter message.event = "feed_fetch_failed" | stats count() by message.source, message.reason, message.detail`.
    `unavailable` or `timeout`: the source is down or slow; the feed retries
    on its own schedule (nothing to do unless it persists). `unavailable`
    with `detail` `ScriptServer error page` is the DWS site's backend failing
    (it answers HTTP 200 with that page); if it persists for days on every
    station while DWS's site works in a browser, suspect the request (the
    feed already asks two years at a time) and raise it with #92. `refused`
    (`HTTP 403`): the source refuses this server's address. From CHC it is a
    per-IP ban for volume (each fetcher environment has its own address: a
    new one gets a fetch or two through, then 403s); the fetcher stops
    asking that host for an hour and the feed backs off 2 hours, doubling, up
    to a day (architecture.md § Data feeds → Throttling). Since issue #604
    the fetcher keeps to what CHC asked (one fetch at a time, about a request
    a second, the contact in the user agent), so a 403 from CHC now means
    something changed: switch the CHIRPS feeds off and write to CHC
    (chc-help@geog.ucsb.edu) with the user agent and the times of the
    refusals. Lowering `fetcher_reserved_concurrency` changes nothing for CHC
    (the message groups already allow one fetch per host).
    A `refused` from DWS outside South Africa is expected (Sources' terms
    below). Older lines, from before `refused` existed, log a 403 as
    `unavailable` with `detail` `HTTP 403`. `throttled`
    (`HTTP 429` or `HTTP 503`): the source is limiting us; the fetcher pauses
    that host for its `Retry-After` and the feeds back off on their own
    (architecture.md § Data feeds → Throttling); if it persists through a
    backfill, raise `PACE_MIN_SPACING_MS` (`feeds/http.ts`) rather than
    lowering concurrency, which is already one fetch per host. `format`: the source
    changed what it serves, a code fix; for DWS, `detail` names the check
    that failed (`sources/dws.ts` `DWS_FORMAT_FAILURES`). `invalid_request` or `internal`: a
    bug; the feed's status panel has the stored message.
  - *A feed that logs failures but shows none* ("not checked yet"): on the
    worker's log group,
    `filter message.event = "feed_answer_dropped" | stats count() by message.reason`.
    `feed_changed`: the feed was saved while its fetch was out (expected
    once). `not_awaited` for every answer: a newer fetch keeps superseding
    it (Run now pressed repeatedly) or the answers are redeliveries; match
    `fetchJobId` against the fetcher's `feed_fetch_failed` lines, and look for
    `job_failed` / `job_lease_lost` on `feed_fetch` jobs, which re-send the
    same job.
- **Sources' terms.** CHIRPS is public domain (the Climate Hazards Center
  waived copyright; cite it). CHIRPS-GEFS comes from the same server without a
  separate licence notice: confirm before relying on it commercially (the
  roadmap's D7). DWS's permission to store the verified daily flow and show derived
  results was obtained through the client's hydrologist (2026-10-28,
  [data-sources.md § dws-flow](./data-sources.md#dws-flow)). The DWS site
  answers non-South-African networks with HTTP 403; af-south-1 reaches it
  (first production fetches 2026-10-26).
- **Cost (idle delta ≈ +$1.00/month):** two more queues and two DLQs cost
  nothing at rest, but each SQS event source polls continuously (~0.65 M
  receives a month each); with the `jobs` queue's that is ~1.9 M, ~0.9 M past
  the free tier, ≈ $0.40. Six alarms ≈ $0.60. The fetcher's own compute is
  cents: a caught-up daily CHIRPS feed reads a handful of range requests
  (#69), and none for cell-days the shared cell cache already holds (208).
  No NAT, no new endpoint.
- **Re-checking finals (210).** Each caught-up CHIRPS fetch HEADs at most
  40 cached final files (no body) and reads at most 10 days again (a header
  read and one strip per grid row, ≤ 25), so a feed adds at most about
  40 + 10 × 27 ≈ 310 requests a day, ~9 300 a month, and only while there is
  re-check work. The files are shared, so the HEADs don't grow with feeds:
  each final file is HEADed at most once per 90 days (`RECHECK_INTERVAL_DAYS`),
  ≤ ~3 500 a month for a `sat` record from 1998 and ~5 600 for `rnl` from
  1981 however many feeds there are; a single daily feed covers ~1 200 a
  month, a full cycle in under a year. The reads happen only after a
  rewrite: a rewritten year re-reads ~365 days per cell set once, 10 a fetch
  a minute apart. Lambda time: one request at a time, about a second
  apart (issue #604), so 40 HEADs take under a minute; a fetch short of time
  leaves the rest for its claims to come due again. Cents a month; the answers stay under ~75% of SQS's
  256 KB (`fetch.test.ts`). The tables add ~100 bytes per cached final
  file (~3 MB for both products' whole archives) plus the stale rows of a
  rewrite until they are read.

### Re-enabling the CHIRPS feeds (issue #604)

The CHIRPS feeds were switched off on 2026-10-25 (#571) after CHC's bot
protection blocked the fetcher's addresses. CHC wrote back on 2026-10-27:
their limits are per public address (a block for hours above about 2
requests a second, HTTP 429 past 20 open connections), and they asked for
one file at a time, about one request a second in total across our Lambdas,
and a contact email in the user agent. The fetcher now does all three
([architecture.md § Data feeds → Throttling](./architecture.md#data-feeds)).
Before the feeds go back on:

1. **Set `feeds_contact`** in the production tfvars: an address you read,
   which CHC will write to before blocking us. Never commit it; the repo is
   public. Re-run `export-tf-vars.sh` if CI's Terraform reads the tfvars from
   GitHub.
2. **Check `fetch-requests` is empty**, since the apply replaces it with a
   FIFO queue (`…-fetch-requests.fifo`, and its DLQ) and a message left in
   the old one is lost (its feed fetches again on its next schedule):
   `aws sqs get-queue-attributes --queue-url <url> --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --profile water-management`.
3. **`terraform plan`, then apply** with the go-ahead: the queue and DLQ
   replaced, the fetcher's event source re-created on the new queue, its
   timeout 120 → 900 s and `FEEDS_CONTACT` set, the worker's
   `FETCH_REQUESTS_QUEUE_URL` and the IAM and alarm references moved.
4. **Release the backend at once** (`backend@X.Y.Z`): the worker on the old
   build sends without a message group, which a FIFO queue refuses, so
   until the release a feed's fetch job fails and retries (nothing is lost,
   and a CHIRPS feed is off anyway). The new fetcher refuses to start
   without `FEEDS_CONTACT`, which is why the apply goes first.
5. **Switch the CHIRPS feeds back on** one at a time (Settings → Data feeds),
   the reference cell's first.
6. **Watch the first day.** On the fetcher's log group:
   `filter message.event = "feed_fetch_failed" | stats count() by message.source, message.reason, message.detail`
   should show no `refused` or `throttled` from CHIRPS, and
   `filter message.event = "feed_fetched" and message.source = "chirps" | stats count(), avg(message.ms) by bin(1h)`
   about one fetch at a time (each up to ~15 minutes while a backfill runs).
   `fetch-requests-age` may fire while several feeds backfill, since their
   fetches now queue behind each other: that is the queue doing its job, not
   a stall, as long as `feed_fetched` lines keep coming.

**Backfill is slow now.** At about a request a second a CHIRPS day costs
3–10 requests for one cell (a final file; a preliminary one too when the
final isn't out), plus one per extra grid row for a box. A 120-day window of
one cell's finals takes about 10 minutes, and the next window follows a
minute later: a record from 1981 (`rnl`) takes about a day per cell set, from
1998 (`sat`) about 16 hours. A box over many grid rows doesn't fit a window in
the fetcher's 885 s, so its fetches are cut short and it takes several times
that. Feeds over different cells queue behind each other.
Cells another feed already read come from the cell cache at no cost. The
copy of our own ([§ The data mirror](#the-data-mirror)) replaces this for history.

## The data mirror

Issue #604's rule: the app never fetches from someone else's server because a
feed or a user asked. One scheduled job of ours copies what our projects need
into our own store, and the app reads only that copy (issue #604 R1-A's
source register, `docs/data-sources.md`, lists the upstreams). Round 1 built
the store and the job's infrastructure (`infra/ingest.tf`); Round 2 builds
the jobs that fill it and the worker's path that reads it, behind
`CHIRPS_SOURCE` (the flow end to end: [architecture.md § Our copy of the
rain data](./architecture.md#our-copy-of-the-rain-data)). Until the cutover
below, production keeps `CHIRPS_SOURCE=chc` and behaves as before.

- **The mirror bucket** `water-management-mirror-<account>` (output
  `mirror_bucket`): private (every public access block on, ACLs off), SSE-S3,
  TLS only, **versioned**, with noncurrent versions expiring after 30 days
  (a monthly refresh rewrites ~130 MB, so a month of old versions is cents)
  and incomplete multipart uploads aborted after a day. It holds one Zarr v3
  array per product (`rnl/`, `sat/`, `prelim/`, `gefs/<issue>/`,
  `ecmwf/<issue>/`, `era5l/` and `imerg_late/`), each with its
  `manifest.json`, and `gefs/index.json` and `ecmwf/index.json` listing the
  forecast issues held.
- **The ingest job** `water-management-mirror-ingest`: a Python 3.14
  container-image Lambda (`ingest/Dockerfile`, handler
  `lambda_handler.handler`), arm64, 3 GB memory, 2 GB of `/tmp`, 900 s,
  reserved concurrency 2, **outside the VPC** (it reaches CHC over the
  internet; no NAT). Environment: `MIRROR_URL=s3://<mirror bucket>`,
  `FEED_SOURCE=live`, and `INGEST_CONTACT` from `feeds_contact` (the
  same one contact the fetcher's user agent names, [§ Re-enabling the CHIRPS
  feeds](#re-enabling-the-chirps-feeds-issue-604); use a role address, every
  upstream sees it).
  Its role may get, put, list and delete in the mirror bucket only, send to
  its DLQ, write its own log group, pull its own image, and publish metrics
  in the `water-management/Mirror` namespace only. No database; its one
  secret is IMERG's Earthdata token (§ IMERG Late), read at run time by the
  ARN in `EARTHDATA_TOKEN_SECRET_ARN`.
  Its 2 reserved executions come out of the account's Lambda concurrency
  quota (infra/README.md § Operator steps).
- **Schedules:** one EventBridge rule per product, daily (`rnl` at 02:00
  UTC, `sat` at 02:20), invoking the job with `{"product":"rnl","mode":"monthly"}`
  and the same for `sat`. The monthly mode is idempotent: CHC publishes a
  month's finals during the next month, usually by the 25th, and a daily run
  picks the file up the day it appears with one conditional request (a 304)
  on the other days. A daily run also gives the freshness alarms a datapoint
  every day, which a run only on the 25th could not (a CloudWatch alarm
  can't look back a month). The rules exist from the first apply, disabled
  until `ingest_image_tag` is set. A failed run is not retried (a run that
  met an HTTP 403 must stop, not retry); its event goes to the
  `mirror-ingest-dlq` and the next day's run tries again.
- **What a daily run does** (`ingest/chirps_final.py`, ingest/README.md §
  The CHIRPS finals job): it takes the product's lease
  (`ingest-state/<product>/lease.json`, so a backfill and the daily run never
  write one year's chunks at once), makes one conditional GET of CHC's
  `byMonth` listing, and diffs it against the manifest by size and time.
  Each new or rewritten month is downloaded whole, oldest first, at most one
  file a minute, and only while 6 minutes of the run's 15 remain; the rest
  wait for the next day. A month's values are hashed, and the revision goes
  up only when they changed (a re-copy with the same values doesn't count).
  An HTTP 403 stops the run at once, with no retry. Every run, 304 and
  failure included, publishes `MirrorLagDays`. A `backfill` event
  (`{"product":…,"mode":"backfill","month":"YYYY-MM"}`) copies one named
  month the same way; one that finds the lease held fails with `MirrorBusy`.
- **The worker reads the copy** (from Round 2): its role may `GetObject` and
  `ListBucket` on the mirror bucket (`ListBucket` so a missing, all-NaN
  chunk answers 404, not 403), and the **S3 interface endpoint's policy**
  (`infra/packs.tf`, `WorkerReadsMirror`) allows the same. Without that
  endpoint statement every read from the VPC fails with AccessDenied, whatever
  the role says.
- **Alarms:**
  - `mirror-lag-rnl`, `mirror-lag-sat` (essential tier): the job publishes,
    per product and per run, **namespace `water-management/Mirror`, metric
    `MirrorLagDays`, dimension `Product` = `rnl` | `sat`**, the days between
    today (UTC) and the product's manifest `finalThrough`, with
    `cloudwatch:PutMetricData`. The alarm fires when the lag passes
    `ingest_lag_alarm_days` (75: a healthy copy runs up to ~56 days behind
    just before CHC's monthly release) on two days running, **and when no
    datapoint arrives for two days** (`treat_missing_data = "breaching"`): a
    job that stopped running, or fails before it measures, alarms too.
  - `mirror-ingest-errors` and `mirror-ingest-dlq-arrivals` (full tier): a
    run raised or timed out.
  - *Runbook.* Read the run in the `/aws/lambda/water-management-mirror-ingest`
    log group. A run that met HTTP 403 stopped on purpose: don't redrive;
    write to the upstream's contact (the source register) and wait. A DLQ
    message needs no redrive either: the next day's run does the same work.
    Meanwhile feeds keep serving the days already cached.
- **Turning it on** (after Round 2 makes the job publish `MirrorLagDays`;
  until then a breaching freshness alarm would fire every day):
  1. Apply once with `ingest_image_tag` empty: the bucket, repository, DLQ
     and disabled schedules appear. Run `export-tf-vars.sh infra/` so
     `INGEST_FUNCTION_NAME` and `INGEST_ECR_REPOSITORY` reach GitHub: the
     backend release preflight requires both, so no backend release passes
     its preflight between merging this and that apply.
  2. Cut a backend release: `deploy-backend.yml` pushes the ingest image as
     `<version>-<sha12>` and prints a notice with the tag.
  3. **Set `ingest_image_tag` after the first image push**, in the
     prod tfvars (`feeds_contact` is already set), and apply: the function, its
     schedules' targets and its freshness alarms appear. Later releases
     move the function to their own image; the ECR lifecycle policy never
     expires the image the tag pins.
  4. The one-off 1981 backfill ([§ Backfill](#backfill) below), then the
     switch to the copy: the cutover, below.
- **The cutover** (Round 3 carries it out; an outline, each step checked
  before the next, every apply with the operator's go-ahead):
  1. **The job runs.** `ingest_image_tag` is set (above) and a few daily
     runs have passed: `MirrorLagDays` has a datapoint per product per day
     in `water-management/Mirror`, and the `mirror-lag-*` alarms are OK, not
     INSUFFICIENT_DATA or ALARM. A product still empty reports no lag, so
     its alarm breaches until the backfill fills it: expect that, and don't
     cut over past it.
  2. **Backfill.** Start the backfill state machine (`infra/ingest_backfill.tf`;
     its month list from `ingest/backfill_plan.py`, one month at a time with
     at least a minute between them, [§ Backfill](#backfill)) for `rnl` from
     1981-01 and `sat` from 2000-06.
     It is resumable: a month already in the manifest with the same values
     isn't fetched again. Watch the runs' logs; a 403 stops a run on purpose
     (the alarm runbook above). About $3 in all.
  3. **Verify.** `ingest/verify_copy.py` ([§ Backfill](#backfill), steps
     4–5) checks each manifest's coverage and lag, compares random cell-days
     with CHC's own daily files (bit for bit) and the whole region with
     dynamical.org's copy. Only a report that ends **PASS** (exit 0) goes
     on. Check by hand that the preliminary days run to within a few days of
     today (`prelimThrough` in `prelim/manifest.json`).
  4. **Switch.** Set `chirps_source = "mirror"` (the worker's
     `CHIRPS_SOURCE`, with `MIRROR_URL=s3://<mirror bucket>`) in the prod
     tfvars, apply, and cut a backend release. CHIRPS feeds now read the
     copy in the worker; the fetcher no longer reads CHC for them. For Data
     → Data feeds, the same variable sets the **API** Lambda's
     `CHIRPS_SOURCE` (`infra/lambda.tf`), so the panel shows "Rain data
     copied to … (final) / … (preliminary)" and **Copy behind** from the
     next worker tick: the API reads the copy's days from the `mirror_copy`
     rows the worker records, and needs no `MIRROR_URL` and no access to the
     bucket. Until that tick the panel says the copy hasn't been checked
     yet. That first tick also runs the **baseline**, by itself: with no
     revision of the copy recorded yet, it marks every cached final in the
     region stale (CHC may have rewritten some before the copy existed,
     and the copy's `changes` don't go back that far), in parts over a few
     ticks, and the feeds read them again from the copy over the next
     fetches. Nothing to do but expect `mirror_revision_partial` then
     `mirror_revision_applied` in the worker's logs ([data-model.md §
     Mirror revisions](./data-model.md#mirror-revisions-245_mirror_revisionsql-246_mirror_revision_partssql)).
  5. **Re-enable** the CHIRPS feeds paused since the 403s (#571), and watch
     the first day: feeds catch up from the copy in minutes, and none shows
     **Copy behind** or Failing.

  Rolling back is the flag: `chirps_source = "chc"` and a release. The
  cache rows the copy filled stay valid (origin `chc`, the same values).
- **Copy behind, in the app.** Data → Data feeds reads how far the copy
  runs from `mirror_copy` (the worker's tick records each manifest there
  when it changes) and marks a CHIRPS feed
  **Copy behind** when its part of the copy is late: a final product more
  than 75 days old (the same threshold as `ingest_lag_alarm_days`'s
  default; the app's is `COPY_FINAL_LAG_DAYS` in `feeds/health.ts`, so
  change both together) or the preliminary days more than 7. The feed
  itself counts no failure and needs nothing; the operator's signal is the
  alarm. A manifest the tick can't read or record logs
  `mirror_revision_failed` with the error's class and leaves the last
  recorded days in place; before any tick has recorded the copy the panel
  says it hasn't been checked yet, and feeds keep their own health.
- **Cost:** under $1/month in steady state. ~6 GB of Zarr in S3 Standard
  (~$0.20) plus a month of old versions, a few seconds of Lambda a day and a
  couple of minutes once a month, a few images in ECR (cents), two custom
  metrics and the two essential alarms (about $0.30 each past the free
  tier, in af-south-1). The one-off backfill is about $3.

### The daily ingest (preliminary days)

The fetcher Lambda (`infra/feeds.tf`) has a second mode beside the per-feed
fetches: an EventBridge rule (`water-management-daily-ingest`, 03:00 UTC,
after the Python job's runs) invokes it with `{"mode":"daily-ingest"}`, and it
copies the new CHIRPS preliminary `sat` days into the copy's `prelim/` array
(`backend/src/ingest/daily.ts`). Per day it reads the file's header and strip
table and one range over the region's rows (about 3 requests, at most one a
second); a day with nothing new costs one request. It drops the preliminary
days the `sat` finals now hold, and `prelimThrough` never runs past a missing
day. A 403 stops the run, which is not retried (the fetcher's async invoke
config: 0 retries); the next day's run tries again.

Each run logs `mirror_daily_ingest` (copied, dropped, `prelimThrough`,
`stopped`, and for a failure a `reason`/`detail` such as `refused`/`HTTP 403`)
and publishes `MirrorLagDays{Product=prelim}`, today minus the newest `sat`
day the copy holds, as an embedded metric (no `PutMetricData` grant). The
alarm `mirror-lag-prelim` (essential tier) fires past
`daily_ingest_lag_alarm_days` (12) on two days running, or when no datapoint
arrives for two days.

**Turning it on:** after a backend release with the daily mode is deployed,
set `daily_ingest_enabled = true` and apply. That enables both rules (this
one and the GEFS pass's, below), gives the fetcher's role get/put/list/delete
on the mirror bucket, and creates both freshness alarms; off (the default), none of them exist, so production doesn't alarm for
a job that isn't running. The fetcher reads `MIRROR_URL` (set by Terraform
either way). Run the [backfill](#backfill) of `sat` first: without `sat`
finals the daily ingest starts 30 days back.

### The GEFS pass (the forecast)

A second rule (`water-management-gefs-ingest`, 08:38 UTC and hourly to
11:38) invokes the fetcher with `{"mode":"daily-ingest","pass":"gefs"}`, and
it copies the newest complete CHIRPS-GEFS issue into `gefs/<issue>/`
(`backend/src/ingest/gefs.ts`): today's, else yesterday's, the 16th day's
file read first so a partly published issue costs one request and is never
copied. Per file, the header and strip table and one range over the region's
rows (about 3 requests, at most one a second: about 48 an issue, under a
minute). The issue's manifest, then `gefs/index.json` (the issues held,
newest first), are written only once all 16 days are in; the newest 7 issues
are kept and older arrays deleted, with any array a cut-short run left. A
run that finds the day's issue held asks CHC nothing. It runs apart from the
03:00 preliminary pass because CHC issues at about 08:30 UTC, and the two
passes together could need more than the fetcher's 120 s. The first run is
at 08:38 so the forecast feeds, due at 08:45, read the day's issue. A 403
stops the run, not retried, and leaves `gefs/refused.json` in the mirror
(the time CHC refused): each hourly run is a fresh invocation, so without it
the next would ask CHC again within the hour. A later run that finds the
marker dated today asks nothing and logs `stopped: "refused_today"` (with
`refusedAt`, at warn); the next UTC day's 08:38 run tries again. A marker
that couldn't be written is logged as `markerFailed` beside the 403. The
03:00 preliminary pass needs no marker: its rule runs once a day and is
never retried.

Each run logs `mirror_daily_ingest` with `product: "gefs"` (`copied`,
`partial` for an issue found half published, `newest`, `stopped`, and for a
failure `reason`/`detail`, or `refused_today`) and publishes `MirrorLagDays{Product=gefs}`,
today minus the newest issue held, as an embedded metric. The alarm
`mirror-lag-gefs` (essential tier) fires at **2 days** (neither today's nor
yesterday's issue held, so the forecast feeds reading the copy wait, keeping
the forecast they have) on two days running, or when no datapoint arrives
for two days. Runbook: the run's log line; a `refused` stopped on purpose
(as above); `partial` on several runs means CHC is publishing late. It is
turned on with the daily ingest (`daily_ingest_enabled`): the rule, its
target and permission, and the alarm exist only then.

### ECMWF (the second forecast)

Issue #604 D17 (R4-C): the ECMWF ENS forecast, copied by the same
mirror-ingest Lambda (`ingest/ecmwf.py`) and read by `ecmwf_ens` feeds
(`backend/src/feeds/fromMirrorEcmwf.ts`). The source, its licence and the
limits we keep to are in [data-sources.md § ecmwf-ens](./data-sources.md#ecmwf-ens).

- **What a run does.** The rule `water-management-mirror-ingest-ecmwf`
  (`infra/ecmwf.tf`) invokes the job with `{"product":"ecmwf","mode":"daily"}`
  every 20 minutes from 10:00 to 13:40 UTC. ECMWF publishes the 00 UTC run's
  0.1° files about 09:40 UTC (two hours after the 0.25° ones). A run tries
  today's issue, else yesterday's: it reads each step's `.index` and then
  one range request per member for that member's `tp` field (765 requests
  an issue, one a second, ~1.1 GB), never a whole 4 GB step file. It saves
  each finished step under `ingest-state/ecmwf/work/<issue>/`, stops
  starting steps with under 2 minutes of the Lambda's time left, and the
  next run picks up from there; with all 15 steps in (and 5 minutes left)
  it writes `ecmwf/<issue>/` (the ensemble mean and p10/p50/p90, 0.1°), its
  manifest and `ecmwf/index.json`, keeps 7 issues whole and archives older
  ones as their mean. One run at a time (the `ecmwf` lease): a run that
  meets the lease ends at once. A run that finds the day's issue held asks
  ECMWF nothing.
- **Is the issue out?** A run first asks for the issue's last step's
  `.index` (ECMWF writes a run's steps in order). Checked 2026-10-27: a key
  not yet published on the `ecmwf-forecasts` bucket answers **404**
  (`NoSuchKey`), not 403, so the job reads a 404 there as "not published
  yet" (`stopped: "not_published"`) and a 404 on a later step as
  `partial`. S3 also answered **503** now and then to such probes:
  `polite.py` retries a 503 (or 429) up to **3 times**, honouring
  `Retry-After` and otherwise waiting 30, 60 and 120 s (one wait over 300 s
  gives up at once). A probe that still answers 503 after the third retry
  fails the run with `RetryLater`, having written nothing and no refusal
  marker; the target doesn't retry it (the failed event goes to the
  mirror-ingest DLQ), and the next scheduled run, 20 minutes on, asks again
  (`ingest/test_ecmwf.py` covers both).
- **A 403** stops the run at once, never retried, writes
  `ecmwf/refused.json` (the time), and the Lambda errors (the event goes to
  the mirror-ingest DLQ, which alarms). The day's later runs see the marker
  and ask nothing (`stopped: "refused_today"`); the next UTC day tries again.
- **Logs and the alarm.** Each run logs one JSON line, `event:
  "mirror_ingest"`, `product: "ecmwf"`, with `stopped` (`copied`,
  `up_to_date`, `deadline`: resumed next run, `partial`: ECMWF hasn't
  published every step yet, `not_published`, `busy`, `refused`,
  `refused_today`), `working`, `stepsDone`, `newest` and `lagDays`, and
  publishes `MirrorLagDays{Product=ecmwf}` (today minus the newest issue
  held; nothing while the copy holds none). The alarm `mirror-lag-ecmwf`
  (essential tier) fires at **2 days** on two days running, or when no
  datapoint arrives for two days. Feeds keep the forecast they have
  meanwhile.
- **Turning it on.** Build an ingest image whose `requirements.txt` includes
  eccodes (`ingest/requirements.c.in`: eccodes and eccodeslib, binary
  wheels for arm64, no system package), deploy it (`ingest_image_tag`),
  then set `ecmwf_enabled = true` and apply. Without both, the rule stays
  disabled with no target and there is no alarm. ECMWF's open data needs no
  key. The feeds fall due at 14:00 UTC (253_feed_source_ecmwf.sql).
- **Quantile mapping** (D17, "quantile-mapped to our corrected rain"). Once
  the copy has archived a few months of issues, the operator fits the
  mapping offline and writes `ecmwf/qm.json` into the mirror; feeds apply it
  from their next fetch, and until then they write the model's own values,
  labelled "not yet calibrated":

  ```bash
  aws s3 sync s3://<mirror bucket>/ecmwf ./copy/ecmwf --exclude "*/c/1/*" --exclude "*/c/2/*" --exclude "*/c/3/*" && aws s3 sync s3://<mirror bucket>/sat ./copy/sat && aws s3 sync s3://<mirror bucket>/prelim ./copy/prelim && ingest/.venv/bin/python ingest/ecmwf_qm_fit.py --copy ./copy --mirror s3://<mirror bucket> --dry-run
  ```

  `--dry-run` prints the file; run it again without to write
  `ecmwf/qm.json`. `--scale` applies a CHIRPS bias correction to the
  observed rain first, `--regions` fits per region (default the whole
  region D1), and each group (region × season) needs `--min-samples` pairs
  (default 2,000). Removing `ecmwf/qm.json` returns feeds to uncalibrated.

### Backfill

The one-off copy of CHC's `byMonth` finals since 1981 (D4) runs through the
`water-management-mirror-backfill` Step Functions state machine
(`infra/ingest_backfill.tf`, created once `ingest_image_tag` is set). It
invokes the ingest Lambda with `{"product","mode":"backfill","month"}` once
per month, **one month at a time** (a finals chunk holds a whole year, so two
months of one year written at once would lose one) and **waits 60 s after
each** (`ingest_backfill_wait_seconds`, D4's one file a minute). A month that
fails, an HTTP 403 above all, fails the execution; only Lambda's own service
errors (throttling, a transient API error) and the two waits are retried:
`MirrorBusy` (the daily run holds the product's lease) and `HostBusy` (the
fetcher Lambda holds CHC's one request slot, which the two share so CHC sees
one of our processes at a time; architecture.md § Data feeds, Throttling).
A month that meets `HostBusy` asked CHC nothing and is retried every 2
minutes for an hour; an execution that still fails on it means the fetcher
held CHC that long (a long per-feed backfill): let the feeds' fetches settle
and resume as in step 3. While a backfill runs, the fetcher's daily
preliminary and GEFS passes may log `stopped: "host_busy"` on a run whose
three-minute wait found the slot held; their next run catches up. Nothing
schedules it: the operator starts it.

**Rolling out the shared slot:** apply Terraform (the fetcher's
`fetcher_chc_slot` grant on that one key, the state machine's `HostBusy`
retrier) **before** the backend release that brings it, since without the
grant the fetcher fails its CHC fetches closed ("the request slot could not
be taken") and its daily passes error. The Python side takes the slot from
the first ingest image built after it (move `ingest_image_tag`); until then
only the fetcher does, so start a backfill only once both carry it.

1. Write the month list for a product with `ingest/backfill_plan.py`; with
   the product's manifest it leaves out the months already copied:
   `aws s3 cp s3://<mirror bucket>/rnl/manifest.json /tmp/rnl-manifest.json` (skip on a first run),
   then `python3 ingest/backfill_plan.py rnl --to <last complete month> --manifest /tmp/rnl-manifest.json > /tmp/rnl-plan.json`.
   `rnl` starts in 1981-01, `sat` in 2000-06 (its first byMonth file; its daily files start in 1998). Stop at the month before the
   current one: the daily `monthly` runs write the newest month, and a
   backfill of the same year at the same moment would race them on that
   year's chunks.
2. Start it: `aws stepfunctions start-execution --state-machine-arn <arn> --input file:///tmp/rnl-plan.json`.
   About 550 `rnl` months take ~1.5 days (a ~40 s download and the wait per
   month); `sat` about 1 day. One product at a time.
3. If an execution fails, read the failed month's error in the execution's
   history and the `mirror-ingest` log group. After a 403, wait (and write to
   CHC, the source register's contact) before resuming. To resume, repeat
   steps 1–2: the plan skips the months the manifest now holds.
4. **Verify the copy** once both products are done, from the workstation
   with read access to the mirror bucket (`aws sso login` for the prod
   profile first):
   `MIRROR_URL=s3://<mirror bucket> INGEST_CONTACT=<role address> ingest/dev.sh verify --out /tmp/verify-copy.md`.
   It makes `ingest/.venv-verify` from `ingest/requirements-verify.txt` on
   first use and runs three checks (ingest/README.md § Verify the copy):
   - **coverage**: each finals manifest holds every month from its first
     (`rnl` 1981-01, `sat` 2000-06) with no gap, `finalThrough` ends that
     run, and it is at most 75 days old (`--max-lag-days`);
   - **CHC**: 200 random cell-days (`--samples`, seeded with `--seed`,
     spread over both products and every year) read from CHC's own daily
     GeoTIFFs a pixel at a time, about 600 range requests at one a second
     (~10 minutes), with the job's User-Agent. Each must be **bit-equal**
     to the copy; a different one is listed with both values. An HTTP 403
     stops the run at once (not retried): wait and write to CHC, as for the
     backfill;
   - **dynamical.org**: the whole region of `rnl` for one month per decade
     (`--month YYYY-MM` to choose) against dynamical.org's public copy on
     AWS Open Data (anonymous, no load on CHC): the land/sea mask must match
     exactly and wet cell-days (≥ 1 mm) differ by at most 0.2%
     (`--tolerance`; Round 0 measured a median of 0.067% and a maximum of
     0.195%). The report gives the median, p99 and maximum per month.

   `--checks coverage,chc` (or any subset) runs fewer. The report is
   Markdown; the exit status is 0 only when every check run passed. Keep
   the report with the cutover's record (issue #604).
5. **Switch** only on a clean report: set `chirps_source = "mirror"` in the
   prod tfvars, apply with the operator's go-ahead, and cut a backend
   release (the cutover above, step 4). Then **re-enable the CHIRPS feeds
   paused since the 403s** (#571), and watch the first day: they catch up
   from the copy, and none shows Copy behind or Failing. **Roll back** by
   the flag: `chirps_source = "chc"`, apply and a release; the cache rows
   the copy filled stay valid. A failed report means no switch: a coverage
   gap is resumed with steps 1–2; a CHC mismatch or a dynamical.org
   difference beyond tolerance is a bug in the copy to find before
   anything reads it (re-copy the month with a `backfill` event once
   fixed, then verify again).

### IMERG Late

The near-real-time rain for the days CHIRPS has no preliminary value for
yet (issue #604 R4-D, D16): NASA's IMERG Late daily, `GPM_3IMERGDL` V07,
about 14 h behind, into `imerg_late/` (0.1°, the last 30 days, each day's
version in the manifest; `ingest/imerg.py`, ingest/README.md § IMERG Late,
the source register's [imerg](./data-sources.md#imerg)). It runs in the same
ingest Lambda, from `infra/imerg.tf`: a rule 4 times a day (04:40, 10:40,
16:40, 22:40 UTC) sending `{"product":"imerg_late","mode":"recent"}`. A run
asks CMR which granules exist (no sign-in), then GES DISC's OPeNDAP service
for region D1 of each day it doesn't hold, with an Earthdata Login token.
Off until `imerg_enabled`, which needs the token first.

**The token.** Terraform creates the secret `water-management/ingest/earthdata-token`
with no value and gives the ingest role `GetSecretValue` on it alone; the
token itself never passes through Terraform, the repo or a chat. Once,
by the operator:

1. **An Earthdata Login account** at https://urs.earthdata.nasa.gov, on the
   estate's owner identity (`~/github/project-mgmt/docs/vendor-accounts.md`
   and its Runbook H; add the registry row).
2. **Approve GES DISC's application**: Profile → Applications → Authorized
   Apps → Approve More Applications → "NASA GESDISC DATA ARCHIVE", and agree
   to its terms. Without it every request answers 401.
3. **Create a user token**: Profile → Generate Token. It is valid for 60
   days. Save it to a file only you can read, for example
   `~/earthdata-token` with mode 0600, and never print it.
4. **Put it in the secret**, from that file, with the prod profile
   (`aws sso login` first):
   `aws secretsmanager put-secret-value --secret-id water-management/ingest/earthdata-token --secret-string file://$HOME/earthdata-token && shred -u $HOME/earthdata-token`.
   Check without reading it back: `aws secretsmanager describe-secret --secret-id water-management/ingest/earthdata-token --query VersionIdsToStages`
   shows one `AWSCURRENT` version.
5. **Check one real CMR granule record first.** The job (`imerg.py`
   `parse_search`) requires each granule's `RelatedUrls` to hold **exactly
   one** URL starting `https://opendap.earthdata.nasa.gov/`, and refuses
   the run (`ImergFormatError`) on none or several. CMR's search needs no
   sign-in, so look at yesterday's granule:
   `curl -s "https://cmr.earthdata.nasa.gov/search/granules.umm_json?short_name=GPM_3IMERGDL&version=07&temporal=$(date -u -d yesterday +%Y-%m-%d)T00:00:00Z,$(date -u -d yesterday +%Y-%m-%d)T23:59:59Z" | jq '.items[0].umm | {GranuleUR, urls: [.RelatedUrls[].URL]}'`
   The `GranuleUR` should name the day (`3IMERG.YYYYMMDD-S000000-E235959.`)
   and a `V07` tag, and among the URLs exactly one should start
   `https://opendap.earthdata.nasa.gov/` (the others are the data archive's
   HTTPS link, the `.xml` and browse links, which the job ignores). Two
   OPeNDAP links (say a second one for a cloud copy), or one on another
   host, means `parse_search` needs changing before turning it on.
6. **Turn it on**: `imerg_enabled = true` in the prod tfvars (with an
   `ingest_image_tag` whose release has `ingest/imerg.py`), `terraform plan`,
   then apply with the operator's go-ahead. That creates the rule, its
   target and permission, and the `mirror-lag-imerg-late` alarm.
7. **First run** without waiting for the schedule:
   `aws lambda invoke --function-name water-management-mirror-ingest --cli-binary-format raw-in-base64-out --payload '{"product":"imerg_late","mode":"recent"}' /tmp/imerg.json && cat /tmp/imerg.json`
   should list 10 days `copied`, each with `"version": "V07"`. A 401 means
   step 2 or the token is wrong (below).

**Rotating the token** every 60 days (put a reminder in the calendar when
creating it): repeat steps 3 and 4; the next run reads the new value. A run
that met a 401 or 403 wrote `ingest-state/imerg_late/refused.json` and asks
nothing more that UTC day; after fixing the token the same day, remove it:
`aws s3 rm s3://<mirror bucket>/ingest-state/imerg_late/refused.json`.

**Watching it.** Each run publishes `MirrorLagDays{Product=imerg_late}`,
today minus the newest day held (`prelimThrough`): 1 on a healthy copy (2 before
the day's file lands). The `mirror-lag-imerg-late` alarm (essential tier)
fires above `imerg_lag_alarm_days` (default 3; the day's lowest reading) on
two days running, or when no datapoint arrives for two days. Runbook: the
`mirror-ingest` log group and its DLQ. `refused_today` in a run's result,
or an `HTTP 401` error, is almost always the token's 60 days running out;
a 403 means GES DISC refused us (stop and write to them, as for CHC). An
`ImergFormatError` means a file or CMR's answer changed shape (a new
version's layout, say): the run stopped before writing anything wrong.
When V08 arrives, CMR lists it beside V07 and the job takes the newer
version for each day, re-copying a held day once (its revision moves only
if its values changed). A day CMR never lists (or lists only after it has
left the 10-day search) stays a gap: the readers treat it as not held, and
the days after it are read as usual, so one missing day blocks nothing.

### ERA5-Land

A second rain source (issue #604 R4-A, D15): ERA5-Land daily total
precipitation from the Copernicus Climate Data Store, copied as product
`era5l` on the 0.1° grid by the same `mirror-ingest` function
(`ingest/era5land.py`; how it works: ingest/README.md § The ERA5-Land job).
The CDS needs an account and an API key. Terraform creates the secret
`water-management/ingest/cds-key` with **no value** (`infra/era5land.tf`),
gives the ingest role `GetSecretValue` on that secret only, and passes its
ARN (never the key) as `CDS_KEY_SECRET_ARN`. The daily rule (02:40 UTC,
`{"product":"era5l","mode":"monthly"}`) and the `mirror-lag-era5l` alarm
exist only with `era5l_enabled = true` (default false), which needs
`ingest_image_tag` set to a release that has `era5land.py`.

The operator, once:

1. **The CDS account.** Register at cds.climate.copernicus.eu (an ECMWF
   account) with the owner identity (the personal email, its password in
   Bitwarden, 2FA where offered), never a project-domain address: the CDS has
   no organisation or project level, so its key is account-wide and the
   account is used once for the estate (`project-mgmt`
   docs/vendor-accounts.md, rules 1 and 5). Record it in that registry.
2. **Accept the dataset's licence.** Signed in, open the dataset
   "ERA5-Land hourly data from 1950 to present" (`reanalysis-era5-land`),
   go to its Download tab, and accept the licence under "Terms of use"
   (CC-BY). Until it is accepted every request answers 403, which stops the
   run on purpose.
3. **Save the key to a file only you can read.** Copy the API key from your
   CDS profile page into a new file with a text editor (not `echo`, which
   would put it in the shell history), e.g. `~/cds-key.txt`, holding the key
   alone, then `chmod 600 ~/cds-key.txt`.
4. **Put it in the secret**, from that file (the job strips a trailing
   newline):
   `aws secretsmanager put-secret-value --secret-id water-management/ingest/cds-key --secret-string file://$HOME/cds-key.txt --region af-south-1 --profile water-management`
   Check it landed without reading it back:
   `aws secretsmanager describe-secret --secret-id water-management/ingest/cds-key --query '{changed:LastChangedDate,versions:VersionIdsToStages}' --region af-south-1 --profile water-management`
   shows a version staged `AWSCURRENT`. Then delete the file:
   `shred -u ~/cds-key.txt`. To rotate, repeat steps 3–4 with the new key;
   the next run reads it.
5. **Turn it on:** `era5l_enabled = true` in the prod tfvars, then `plan`
   and, with the operator's go-ahead, `apply`. The next 02:40 UTC run
   submits the newest complete month; the one after collects it.
6. **Confirm on the first live collection that the CDS file carries
   `expver`.** The collected month's result (the run's log line and the
   `collected` entry) has `"preliminary": true` or `false` when it does,
   and `null` when it doesn't; `ingest-state/era5l/requests.json` shows the
   same as the month's `preliminary`. The synthetic fixture writes `expver`,
   but the job has only been checked against it. With `null` the copy
   can't tell ERA5-Land-T from ERA5-Land, so it re-requests the month every
   30 days until 180 days after its end (`RECHECK_UNKNOWN_CAP_DAYS`,
   ingest/README.md § The ERA5-Land job) instead of stopping once a read
   says consolidated: harmless but more requests, so record what you saw
   in issue #604, and if it is `null`, find where the CDS now puts the
   phase.

**Backfill** (`nsf-ncar-era5` on AWS holds ERA5, not ERA5-Land, so it goes
through the CDS too). Each invocation marks one month wanted and submits it
while fewer than four requests are queued; every later run, the daily one
included, keeps submitting wanted months, newest first, as slots free. So
mark the months once, one synchronous invocation at a time (never async: a
run that finds another holding the lease fails), e.g. 1981 to 2025 to match
CHIRPS:
`for y in $(seq 1981 2025); do for m in 01 02 03 04 05 06 07 08 09 10 11 12; do aws lambda invoke --function-name water-management-mirror-ingest --cli-binary-format raw-in-base64-out --payload "{\"product\":\"era5l\",\"mode\":\"backfill\",\"month\":\"$y-$m\"}" --cli-read-timeout 900 --region af-south-1 --profile water-management /dev/null >/dev/null || echo "$y-$m failed"; done; done`
The daily run alone then drains about four months a day (~550 months in
four to five months); invoking any backfill month again during the day
collects and refills sooner. The array grows from 1950 whatever range you
pick (unwritten chunks cost nothing).

**When it alarms** (`mirror-lag-era5l`, past `era5l_lag_alarm_days`, default
50; a healthy copy runs 32–45 days behind, since a month's last day comes
with the next month's request): read the `mirror-ingest` log group's
`era5l:` lines and `ingest-state/era5l/requests.json` in the mirror bucket
(`aws s3 cp s3://<mirror bucket>/ingest-state/era5l/requests.json -`).
- **Refused** (`StopRun`, HTTP 401 or 403): 401 is a wrong or expired key
  (step 4 again); 403 is the licence not accepted (step 2) or the account
  blocked (write to ECMWF support). The run writes
  `ingest-state/era5l/refused.json`, and no run calls the CDS again that UTC
  day; the next day's run tries again, or delete that object once fixed.
- **`RequestsFailed`**: a month's request failed five times (backing off 1,
  2, 4 and 8 days). Its entry's `lastError` says how it ended; once the cause
  is fixed, delete that month's entry from `requests.json` (download, edit,
  upload) and the next run submits it again.

**Attribution:** ERA5-Land is CC BY 4.0, and Copernicus's attribution must
show wherever its values do (docs/data-sources.md § era5-land has the text).

**Cost:** cents a month: the secret (~$0.40), a few seconds of Lambda a day,
a month's download of a few MB, and the array's chunks (about 1–2 GB in S3 from 1981, under $0.05).

### AgERA5 reference evaporation

Daily FAO-56 reference evapotranspiration (issue #604 R5-E): AgERA5 v2.0's
Penman-Monteith ET₀ from the Copernicus Climate Data Store, copied as product
`agera5_et0` (finals layout, 0.1° grid, from 1979) by the same
`mirror-ingest` function (`ingest/agera5.py`; how it works:
ingest/README.md). It is the current-season evaporation option beside dPET's
climatology: projects read it through a data feed of source `agera5_et0`
(Settings → Data feeds), which writes the daily reference ET series GR4J uses
under a monthly PE (model.md §2.4a), with [NASA POWER](#nasa-power-reference-evaporation-fallback)
for the newest days AgERA5 doesn't hold yet. Like ERA5-Land, a month's request
is submitted on one run and collected on a later one.

**No new secret.** AgERA5 is on the same Copernicus account as ERA5-Land, so
its runs read the key from ERA5-Land's `water-management/ingest/cds-key`
(`infra/era5land.tf`; the read grant and `CDS_KEY_SECRET_ARN` are there
whether or not `era5l_enabled` is on). The daily rule (05:00 UTC,
`{"product":"agera5_et0","mode":"monthly"}`) and the `mirror-lag-agera5-et0`
alarm exist only with `agera5_enabled = true` (default false,
`infra/agera5.tf`), which needs `ingest_image_tag` set to a release that has
`agera5.py`.

The operator, once (issue #618 steps 7b–7d):

1. **The CDS account and key**: [§ ERA5-Land](#era5-land) steps 1, 3 and 4.
   Done once for both products; skip what is already done.
2. **Accept AgERA5's licence.** Signed in, open the dataset
   "Agrometeorological indicators from 1979 to present derived from
   reanalysis" (`sis-agrometeorological-indicators`), go to its Download tab,
   and accept the licence under "Terms of use". Each dataset has its own
   acceptance: ERA5-Land's doesn't cover it, and until this one is accepted
   every AgERA5 request answers 403, which stops the run on purpose.
3. **Turn it on:** `agera5_enabled = true` in the prod tfvars, then `plan`
   and, with the operator's go-ahead, `apply`. The next 05:00 UTC run
   submits the newest complete month; the one after collects it.
4. **Check the first live collection** against what the job expects (it has
   only met the synthetic fixture): the run's log line names the month, its
   days and the revision. A failure that names the file's variable, units or
   grid means the CDS's layout differs from the fixture's; record what the
   file holds in issue #604 before changing `agera5.py`.

**Backfill**, by month events, as ERA5-Land's: one synchronous invocation per
month marks it wanted, and the daily run drains about four months a day.
AgERA5 starts in 1979-01, but copy only as far back as projects need: a
current-season option needs the run's own years, so from 1991 (dPET's normal)
is plenty:
`for y in $(seq 1991 2025); do for m in 01 02 03 04 05 06 07 08 09 10 11 12; do aws lambda invoke --function-name water-management-mirror-ingest --cli-binary-format raw-in-base64-out --payload "{\"product\":\"agera5_et0\",\"mode\":\"backfill\",\"month\":\"$y-$m\"}" --cli-read-timeout 900 --region af-south-1 --profile water-management /dev/null >/dev/null || echo "$y-$m failed"; done; done`

**When it alarms** (`mirror-lag-agera5-et0`, past `agera5_lag_alarm_days`,
default 50; a healthy copy runs up to about 43 days behind, since a month is
requested about 10 days after it ends and collected a day or two later): read
the `mirror-ingest` log group's `agera5_et0:` lines and
`ingest-state/agera5_et0/requests.json` in the mirror bucket. A **401/403**
is refused on purpose: 401 a wrong or expired key (ERA5-Land's step 4 again,
which fixes both products), 403 the AgERA5 licence not accepted (step 2); the
run writes `ingest-state/agera5_et0/refused.json` and no run calls the CDS
again that UTC day. **`RequestsFailed`**: a month failed five times; fix the
cause, then delete that month's entry from `requests.json`, as for
ERA5-Land. Meanwhile feeds keep taking the newest days from NASA POWER, so a
late AgERA5 month shows as more POWER days on the feed, not as a gap.

**Attribution:** CC BY (Copernicus); its credit shows wherever its values do
(docs/data-sources.md § agera5).

**Cost:** cents a month: a few seconds of Lambda a day, a month's download of
a few MB, the array's chunks (under 1 GB in S3 from 1991), and no new secret.

### NASA POWER reference evaporation (fallback)

The fallback for the days AgERA5 doesn't hold yet (issue #604 R5-E): NASA
POWER's daily weather for the region (T2M_MAX, T2M_MIN, T2MDEW, WS2M,
ALLSKY_SFC_SW_DWN, PS, one regional request per parameter and tile), with
FAO-56 Penman-Monteith ET₀ computed from it in the job, copied as product
`power_et0` (daily layout, 0.1° grid, each cell its 0.5° POWER cell's value)
by `ingest/nasapower.py`. POWER publishes 2–7 days behind, so it covers the
recent weeks a monthly AgERA5 request can't; feeds read it only for days
AgERA5 doesn't have. **No key**: the POWER API takes none, so there is no
secret. The daily rule (05:20 UTC,
`{"product":"power_et0","mode":"recent","days":30}`) and the
`mirror-lag-power-et0` alarm exist only with `power_et0_enabled = true`
(default false, `infra/agera5.tf`), which needs `ingest_image_tag` set.

Turn it on with `power_et0_enabled = true`, `plan`, and with the operator's
go-ahead `apply`, together with `agera5_enabled` (on its own it gives feeds
only the last days). Each run re-reads the last 30 days (POWER revises its
newest days), a few dozen requests one second apart; a day whose values
didn't change moves no revision.

**When it alarms** (`mirror-lag-power-et0`, past `power_et0_lag_alarm_days`,
default 10; a healthy copy runs 3–8 days behind, since the job asks for days
up to today − 3): read the `mirror-ingest` log group's `power_et0:` lines. A
**403** (or 429) stops the run on purpose and is never retried: POWER says it
monitors usage and limits clients for equitable access, so don't invoke it
again by hand; check the job's request count against
docs/data-sources.md § agera5's limits and write to the POWER team
(power.larc.nasa.gov) before turning it back on. Days AgERA5 already holds are
unaffected; only the newest days of each feed wait.

**Attribution:** CC BY 4.0; cite the NASA POWER Project wherever its values
show (docs/data-sources.md § agera5).

**Cost:** cents a month: under a minute of Lambda a day and the array's
chunks (a few MB).

### C3S seasonal forecasts

C3S's multi-system seasonal forecasts and their hindcasts (issue #620 step
5): daily precipitation from every member of nine systems (ECMWF, the Met
Office, Météo-France, DWD, CMCC, NCEP, JMA and ECCC's two), leads to 215
days, on a 1° grid, copied by the same `mirror-ingest` function
(`ingest/c3s_seasonal.py`; how it works: ingest/README.md § The C3S
seasonal job) into `c3s/<YYYY-MM>/` and `c3s-hc/<system>/<MM>/`. Nothing in
the app reads the copy yet: the forecast-conditioned outlook is #620 steps
6–7, and until then outlooks stay ESP. Like ERA5-Land, each request is
submitted on one run and collected on a later one.

**No new secret.** The runs read ERA5-Land's `water-management/ingest/cds-key`
(`infra/era5land.tf`). The daily rule (14:20 UTC,
`{"product":"c3s","mode":"monthly"}`: the first run after ECMWF's release on
the 6th and the others' on the 10th, both at 12 UTC) and the
`mirror-lag-c3s` alarm exist only with `c3s_enabled = true` (default false,
`infra/variables.tf`, `infra/c3s.tf`), which needs `ingest_image_tag` set
to a release that has `c3s_seasonal.py`.

The operator, once:

1. **The CDS account and key**: [§ ERA5-Land](#era5-land) steps 1, 3 and 4,
   the same account. Skip what is already done.
2. **Accept both licences of the seasonal dataset, with that account.**
   Signed in, open "Seasonal forecast daily and subdaily data on single
   levels" (`seasonal-original-single-levels`), go to its Download tab, and
   under "Terms of use" accept **both** the CC-BY licence **and** the
   "Additional licence to use non European contributions" (it covers NCEP's,
   JMA's and ECCC's systems). Each dataset has its own acceptance: ERA5-Land's
   and AgERA5's don't cover it. Until both are accepted the CDS answers 403,
   which stops the run on purpose for the UTC day.
3. **Turn it on:** `c3s_enabled = true` in the prod tfvars, then `plan` and,
   with the operator's go-ahead, `apply`. The next 14:20 UTC run submits four
   systems' newest released init; the following runs collect them and submit
   the rest (four queued at most), so a month's nine systems are held within
   a few days of the 10th.
4. **Check the first live collection** against what the job expects (it has
   only met the synthetic fixture): the run's log line names the request,
   its members and years. A failure that names the file's fields, grid or
   leads means the CDS's GRIB differs from the fixture's; record what the
   file holds in issue #620 before changing `c3s_seasonal.py`. If the CDS
   refuses a hindcast as too large for one request, say so there too: the
   durable fix is a request per system, month and year (the key gains the
   year), not a bigger Lambda.

**The hindcast backfill**, once (and again only when SYSTEMS gains a system):
one synchronous invocation per init month marks that month's hindcast wanted
for every system; the daily runs drain them after the forecasts, four in the
queue at a time, so the twelve months take a few weeks. Start it outside the
6th–13th, so the month's forecasts aren't waiting behind hindcasts:
`for m in 01 02 03 04 05 06 07 08 09 10 11 12; do aws lambda invoke --function-name water-management-mirror-ingest --cli-binary-format raw-in-base64-out --payload "{\"product\":\"c3s\",\"mode\":\"backfill\",\"month\":\"$m\"}" --cli-read-timeout 900 --region af-south-1 --profile water-management /dev/null >/dev/null || echo "$m failed"; done`
(add `\"system\":\"ukmo-604\"` to the payload for one system). Each
hindcast is one request for 1993–2016; the years a system has are recorded
on the copy (`years`).

**When it alarms** (`mirror-lag-c3s`, past `c3s_lag_alarm_days`, default 45:
days since the 1st of the newest init month every system is held for; a
healthy copy runs up to about 42 days behind just before the 10th's
collection): read the `mirror-ingest` log group's `c3s:` lines,
`c3s/index.json` (the systems each init holds) and
`ingest-state/c3s/requests.json`. A **401/403**: 401 a wrong or expired key
(ERA5-Land's step 4), 403 a licence not accepted (step 2); the run writes
`ingest-state/c3s/refused.json` and no run calls the CDS again that UTC day.
**`RequestsFailed`**: a request failed five times; the usual cause is a system
C3S has replaced (the Met Office's changes about yearly). Update
`ingest/c3srequest.py` `SYSTEMS` from C3S's documentation, release, then
delete the failed entry from `requests.json`.

**Attribution:** CC BY 4.0 and the additional licence: Copernicus's notice,
the dataset's citation and the contributing centres wherever its values show
(docs/data-sources.md § c3s-seasonal); the arrays carry them.

**Cost:** about $0.70 a month in S3 once the hindcasts are held (roughly
150 MB of forecasts a month and 20–25 GB of hindcasts, once), a few minutes
of Lambda a month, one alarm metric.

## DWS gauge records

DWS feeds move onto a store of ours too (issue #604 R3-B, design D14; the
flow end to end: [architecture.md § DWS gauge records](./architecture.md#dws-gauge-records);
the table: [data-model.md § DWS gauge records](./data-model.md#dws-gauge-records-247_gauge_recordsql)).
Two Terraform variables, both off by default, so production behaves as
before until the operator turns them on:

- **`dws_source`** (`live` | `store`, default `live`) sets the worker's
  `DWS_SOURCE`: `live` sends each DWS feed fetch to the fetcher, which reads
  DWS's page; `store` reads `gauge_record` inside the worker's fetch job and
  never asks DWS.
- **`dws_weekly_enabled`** (default `false`) turns on the weekly pass: the
  `water-management-dws-weekly` EventBridge rule (daily at 04:00 UTC,
  `{"mode":"dws-weekly"}` to the fetcher, never retried; each station is
  re-read once a week), the fetcher's get and put on `dws/` in the mirror
  bucket, the worker's `DWS_WEEKLY=on` and its put of `dws/stations.json`
  (the S3 endpoint's policy carries the same statement), and the
  `water-management-mirror-lag-dws` alarm (`MirrorLagDays{Product=dws}`
  above `dws_weekly_lag_alarm_days`, default 10, or no datapoint for two
  days; essential tier).

Release and apply can come in either order. Unset, `CHIRPS_SOURCE`,
`DWS_SOURCE` and `DWS_WEEKLY` mean what production does today (`chc`,
`live`, off), so a backend release that reads them starts on the
environment the last apply left (`backend/src/config/production.ts`); a
value set is checked, and a wrong one still refuses to start. Unset also
counts as the old values for the cutover's checks (`FEED_FETCHER=sqs` and
its queue stay required).

### Turning it on

1. Get each station's verified daily flow: DWS's permission to store it
   and show derived results is held (obtained through the client's
   hydrologist, 2026-10-28, #618 step 6a), so this is the hydrologist's
   DWS exports, a written data request to DWS (GeoRequests@dws.gov.za), or
   the `HyData.aspx` pages saved from the website (up to 20 years a
   request).
2. Deploy a backend release with migration 247 and the `dws-weekly` mode,
   then apply `dws_weekly_enabled = true` (a `terraform plan` first, and the
   operator's go-ahead for the apply). The first worker tick writes
   `dws/stations.json`; the next 04:00 run fetches every listed station
   (about 2 s each at 1 a second, so ~50 a run inside the fetcher's 120 s;
   the rest the next day, by last turn, so a station that keeps failing goes
   behind the others) and the tick after loads them. A station whose page
   fails (a changed layout, a flow above 100 000 m³/s or a quality code the
   store refuses, a timeout) is skipped and logged on its own line,
   `filter message.event = "dws_station_failed"` (`station`, and `detail`
   naming the check); the others load, and the status is written however
   the run ends.
   Check: Logs Insights on the fetcher log group,
   `filter message.event = "dws_weekly"`, then
   `filter message.event = "dws_tick"` on the worker's.
3. Load each station's record (below: in production, `load-reference.yml`
   kind `dws`), then run the `dws-coverage` check until every station
   reads covered.
4. Apply `dws_source = "store"`. DWS feeds now read the store; their
   series don't change (the store's answer is the page's, test
   `gaugeRecord.db.test.ts`).

**Which stations need the reply first.** A feed reads the store only over
days some source was asked for (a span): the weekly pass asks for each
station's newest two years, so a day before that, or in a hole between
spans, is one nobody has asked DWS for yet. A feed whose window holds such a
day waits on it (`last_attempt_at` moves, no failure, nothing written, the
same window next time) rather than reading it as no data and stepping over
it for good, and fills it once a reply covers it. So before `dws_source =
"store"`, a station needs DWS's reply covering its feeds' history when any
of them:

- is still backfilling (its newest day, `last_data_date`, is empty or more
  than about two years old), or has a `startDate` more than two years back
  that it hasn't reached: a new feed with no `startDate` starts ten years
  back, so it too waits on a reply;
- reads a station that has stopped reporting (its newest day is older than
  the weekly pass's first window).

A feed that is caught up (its newest day inside the last two years) reads
the weekly pass's days and needs no reply. To see which stations are
covered, run the read-only check `dws-coverage` ([§ Read-only production
checks](#read-only-production-checks); production's database has no other
door): one row per river gauge an enabled DWS feed reads, with the first
day its feeds still need (`needed_from`: per feed the day after its newest
day or two years back, whichever is earlier, else its `startDate`, else ten
years back; the station's earliest), the days the store covers from there
(`covered_from`, `covered_to`, any source's spans with origin `dws`), the
days in between no span covers (`hole_days`, `first_hole`) and
`days_behind` (today less `covered_to`). A station is covered when
`hole_days` is 0 and `days_behind` is a week or less (the weekly pass's
cadence); `hole_days` null means nothing is loaded for it yet. Ask DWS (or
save the pages) for each station that isn't, from `first_hole` or
`needed_from`.

```bash
aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"dws-coverage"}' --cli-read-timeout 300 --region af-south-1 --profile water-management dws-coverage.json && jq . dws-coverage.json
```

The answer names stations: keep it on your laptop, and say "covered" or
not on the issue, never the codes (they point at the client's catchment,
and the repo is public).

A run that met HTTP 403, throttling or the ScriptServer page stopped on
purpose (`message.stopped` is `refused`, `throttled` or `server_error`,
and `dws/status.json` says `"stale": true`): it is never retried within the
run, and the next day's run asks again. Feeds reading the store keep the
days it holds meanwhile; if the 403s persist, the reply is the route
(D12's trigger to revisit a fixed address is written down there).

### Loading DWS's reply

`pnpm import:dws <file> --reference "<the reply's reference>"` (as the
schema owner) loads a DWS daily table with source `dws-request`, which a
feed prefers to the weekly pass for every day both hold. The file is read
by the feed's own DWS reader: the fixed-width `DATE … QUAL` table, as a
saved `HyData.aspx` page or plain text, gzipped or not. `--station` when
the file doesn't name one; `--from`/`--to` when the request asked for more
days than the reply lists (they then read as no data rather than not yet
loaded); `--source upload` for a table that isn't DWS's reply. A reply is
the client's: never commit one. Locally it loads into the dev database
under origin `fixtures` (what the local feeds read); try it on the invented
`backend/fixtures/dws/X0H001-reply.synthetic.txt`.

**Production** loads it through the reference load
([§ Reference datasets](#reference-datasets)), kind `dws`: the migrate
Lambda reads the file from the reference bucket, checks its SHA-256, reads
it with the same reader and writes it with the same `gauge_record_write`
calls as `pnpm import:dws` (`backend/src/feeds/gaugeRecordImport.ts`), as
source `dws-request` and origin `dws`, with the workflow's `source` as each
row's reference, and records the file in `reference_load` (migration 258),
all in one transaction: a file the reader or the store refuses writes
nothing. Allowed since the client's hydrologist obtained DWS's permission
to store the verified daily flow (2026-10-28, #618 step 6a;
[data-sources.md § dws-flow](./data-sources.md#dws-flow)).

- **Why `dws-request`, not `upload`.** Whether the file is DWS's text reply
  or a `HyData.aspx` page saved from the website, it is DWS's verified
  daily flow, held under DWS's permission, loaded by the operator with a
  reference and a hash. That is what `dws-request` means in the store (the
  authoritative copy we may keep, first in the precedence); `upload` is for
  a table of unknown provenance and ranks below the weekly pass. On a day
  both hold, the loaded record wins over the weekly pass: reload a window
  from a newer page to take up a revision DWS made since.
- **One file per station and window.** `HyData.aspx` gives at most 20
  years a request, so a long record is several files. Each loads on its
  own run; the windows of a station merge into one covered span when they
  overlap or touch, and a window reloaded writes the same rows again. The
  span recorded is the file's first to last listed day (DWS lists every
  day it was asked for, a gap as quality 170), so ask for windows that
  meet: a missing day between two files is a hole the coverage check
  shows, and a feed waits on it.
- **The station** comes from the file (the river gauge code the text
  before its table names, else its file name), or the workflow's `station`
  input when the file names none; a `station` that disagrees with the
  file's is refused.
- **Keep station codes out of the public log.** The run's inputs and
  output are public (the repo is): name the key and the dataset label
  neutrally (`reply-01.txt.gz`, `dws-2026-10-28-01`), and leave `station`
  empty unless the file names none (the `check` job refuses a key or label
  that carries a station code). The station goes to CloudWatch only.
- **The dataset label** names this file's load in `reference_load` (the
  `reference-provenance` check lists them): one label per file, so each
  window's file stays recorded. Reloading under the same label replaces
  that record and the log names the file it replaced.
- **The source** is the record's reference, stored on every row (1–200
  characters): DWS's reply reference, or for saved pages the permission
  they are held under, e.g. `"DWS permission via the hydrologist,
  2026-10-28; HyData.aspx saved <date>"`.

A worked example, from the folder holding one saved page (the page saved
as HTML from `HyData.aspx`, or DWS's text reply), after `aws sso login
--profile water-management`:

```bash
gzip -c HyData.aspx.html > reply-01.html.gz && sha256sum reply-01.html.gz
aws s3 cp reply-01.html.gz s3://<reference_bucket>/reference/dws/reply-01.html.gz --profile water-management
gh workflow run load-reference.yml -f kind=dws -f key=reference/dws/reply-01.html.gz -f sha256=<hex> -f dataset=dws-2026-10-28-01 -f source="DWS permission via the hydrologist, 2026-10-28"
```

Approve the run in `production`. It prints the rows written and the file
recorded; the station, its span and the gap count are in the migrate
Lambda's CloudWatch log (`dws: <station> <from> to <to>: …`). Then the next
window as `reply-02…` and `dws-2026-10-28-02`, and so on; after the last,
run the `dws-coverage` check (above). A refusal prints a code and a fixed
reason (`unreadable`: not a DWS daily table of flow in m³/s, or no
station named; `refused`: the station given disagrees with the file's;
`load_failed`: the store refused a row, e.g. a day after today) and writes
nothing. Locally the same load is `pnpm import:dws <file> --reference
"…"`, into the dev database.


## Dam observations

What satellites saw of each traced dam, into `dam_observation` (issue #604
R5; the flow: [architecture.md § Dam observations](./architecture.md#dam-observations);
the tables: [data-model.md § Dam observations](./data-model.md#dam-observations-261_dam_observationsql);
the source: [data-sources.md](./data-sources.md#deafrica-waterbodies-series)).
One Terraform variable, off by default:

- **`dam_observations_enabled`** (default `false`, `infra/dam_observations.tf`)
  turns on the `water-management-dams-weekly` EventBridge rule (hourly at
  :20, `{"mode":"dams-weekly"}` to the fetcher, never retried; each
  Waterbodies uid re-read once a week, a failed one once a day, each dam's
  newest WOfS scenes once a UTC day, and the rest of every run on the WOfS
  history, so a dam reaches 2013 in about seven hours of runs rather than a
  week of daily ones; a run with nothing due still publishes the heartbeats
  and recency; a source DE Africa refused or throttled is paused for a day,
  below), the fetcher's get and put on `dams/` in the
  mirror bucket (`dams-handover`), the worker's put of `dams/wanted.json`
  (`dams-wanted-list`), and the alarms (essential tier):
  - `water-management-dam-pass-waterbodies` and `…-dam-pass-wofs`:
    `DamPassCompleted{Source}` (namespace `water-management/DamObservations`)
    under 1 for 18 hours (three 6-hour periods), or missing (breaching):
    that source's pass stopped running, fails before it ends, or is paused
    after a refusal (below).
  - `water-management-dam-recency-wofs`: `DamObservationAgeDays{Source=wofs}`
    above `dam_wofs_recency_alarm_days` (default 60) for two days, or
    missing: no traced dam has a WOfS observation that recent.
  - **No recency alarm for Waterbodies**: its public series have been
    frozen upstream since 2024-02 (data-sources.md), so it would fire from
    the first day.
- **`dam_wofs_recency_alarm_days`** (default 60, at least 21).

The flag also turns on the worker's side (`DAM_OBSERVATIONS`, `infra/jobs.tf`).
The plan refuses the flag (a precondition on
`terraform_data.dam_observations_gate`) if the worker Lambda's environment
ever lacks `DAM_OBSERVATIONS = "on"`, since without it the worker never
writes the wanted list nor loads what the passes fetch, while the
heartbeats stay green.

### Turning it on

1. Nothing to change in the worker: `infra/jobs.tf` sets its
   `DAM_OBSERVATIONS` from the same flag, and the plan refuses the flag if
   that line is ever lost (`terraform_data.dam_observations_gate`). The S3
   interface endpoint's policy already lets the worker put
   `dams/wanted.json` (`infra/packs.tf`, `WorkerWritesDamWantedList`); its
   reads under `dams/` are `WorkerReadsMirror`'s, and the fetcher is outside
   the VPC.
2. Load the Waterbodies polygons (below).
3. Deploy a backend release with migration 261 and the `dams-weekly` mode,
   then apply `dam_observations_enabled = true` (a `terraform plan` first,
   and the operator's go-ahead for the apply), once at least one dam is
   traced on a project's map: with none, the WOfS pass has nothing to hold
   and its recency alarm fires. The first worker tick matches the traced
   dams and writes `dams/wanted.json`; the next hourly run (at :20) fetches
   the matched dams' series (a few, at 1 a second) and each dam's newest
   WOfS scenes, the runs after it the WOfS history, and each tick after
   loads what came in. Check: Logs Insights on the fetcher log group,
   `filter message.event = "dams_pass"`, then `filter message.event =
   "dams_tick"` on the worker's.

**When a dam-pass heartbeat alarm fires.** Logs Insights on the fetcher
log group: `filter message.event = "dams_pass" and message.source =
"<source>"`, newest first.

- `message.stopped` is `paused` (with `message.pausedUntil`): an earlier
  run of that source met HTTP 403 (`refused`) or throttling (`throttled`,
  429/503) and stopped on purpose; the run before the pauses shows which
  (`message.reason`, `message.detail`), and the source's status file
  (`dams/<source>-status.json` in the mirror bucket) says `"stopped": true`
  with its `ranAt`. Issue #604's rule is that a refusal stops and alerts,
  never a retry, so that source (only that one; the other goes on) asks
  nothing and publishes no heartbeat for 24 hours from the stop, or for a
  longer `Retry-After` it gave, then asks again by itself. Nothing to
  restart. Find out why before the pause ends: a 403 from DE Africa's
  bucket or STAC is a block on the fetcher's address or a policy change,
  so ask DE Africa (data-sources.md has the contact) and, until they
  answer, set `dam_observations_enabled = false` so the next run doesn't
  meet it again; throttling that recurs means our pace is too fast for
  them (`REQUEST_INTERVAL_MS`, `STAC_INTERVAL_MS`, `SCENE_INTERVAL_MS`).
  The alarm clears with the first heartbeat after the pause.
- No `dams_pass` line at all: the runs stopped (the EventBridge rule, the
  fetcher's Errors alarm) or fail before the pass completes
  (`message.event = "fetcher_event_unknown"`, a mirror error).

The app keeps the observations it holds throughout.

### Loading the Waterbodies polygons

Clip the v0.0.3 historical extent to the region with ogr2ogr
([maps.md § Waterbodies](./maps.md#waterbodies)), gzip it, and load it as a
reference dataset: upload it to the reference bucket under
`reference/waterbodies/`, then

```bash
gh workflow run load-reference.yml -f kind=waterbodies -f key=reference/waterbodies/waterbodies-v0.0.3-d1.geojson.gz \
  -f sha256=<sha256sum of the file> -f dataset=waterbodies-v0.0.3
```

(`source` is optional; it defaults to "Digital Earth Africa Waterbodies
v0.0.3, historical extent (CC BY 4.0)"). The file is capped at 64 MB
(128 MB unzipped): a province or D1's box, not the continent. A reload
replaces the dataset and makes the worker match every dam again on its
next ticks (200 a tick).

## Climate indices

NOAA CPC's ONI and AAO in the data mirror's `indices/`, which an outlook
run with *Also compare past seasons like this one* reads (issue #620; the
flow: [architecture.md § Data feeds](./architecture.md#data-feeds); the
source: [data-sources.md § climate-indices](./data-sources.md#climate-indices)).
One Terraform variable, off by default:

- **`climate_indices_enabled`** (default `false`, `infra/climate_indices.tf`)
  turns on the `water-management-indices-ingest` EventBridge rule (daily at
  05:50 UTC, `{"mode":"daily-ingest","pass":"indices"}` to the fetcher,
  never retried), the fetcher's reads and writes under `indices/` in the
  mirror bucket (no delete), and the `mirror-lag-indices` alarm
  (MirrorLagDays{Product=indices} ≥ 75 days, essential tier, breaching on
  missing data). The worker already reads the whole mirror bucket.

To turn it on, after a backend release with the pass is deployed:

1. Set `climate_indices_enabled = true` and apply.
2. Run the pass once by hand rather than wait for 05:50:
   `aws lambda invoke --function-name water-management-fetcher --cli-binary-format raw-in-base64-out --payload '{"mode":"daily-ingest","pass":"indices"}' --region af-south-1 --profile water-management /tmp/indices.json && cat /tmp/indices.json`.
   It answers `{ changed, through, lagDays, stopped }`: both indices
   changed on the first run, `through` the newest month of each, `stopped`
   `done`.
3. Run an outlook with the box ticked: *Past seasons like this one* lists
   the years chosen and the source line names the months held.

Until it is on, such an outlook says the indices aren't held and shows the
ESP alone. A 403 from CPC ends the run (log `reason refused`); the alarm
fires if the copy falls behind, and outlooks keep reading the last copy,
stepping back at most two months. Turning it off stops the copy; the files
stay in the bucket.

## The cutover

Issue #604 moves every feed off its upstream: CHIRPS and CHIRPS-GEFS onto
our copy ([§ The data mirror](#the-data-mirror)), DWS onto our store
([§ DWS gauge records](#dws-gauge-records)). Each has its own flag, flipped
on its own evidence, in either order:

1. **CHIRPS:** after the backfill and a **PASS** from `verify_copy.py`
   ([§ Backfill](#backfill), step 5), apply `chirps_source = "mirror"` and
   cut a backend release. CHIRPS and CHIRPS-GEFS feeds read the copy in the
   worker's job; DWS still goes to the fetcher.
2. **DWS:** once the stations' records are loaded (permission obtained 2026-10-28)
   ([§ Turning it on](#turning-it-on), step 4), apply `dws_source = "store"`.

While either flag is on its old value (`chc`, `live`), per-feed fetching
stays exactly as [§ Data feeds](#data-feeds) describes, and the worker
still refuses to send a source the copy or store serves (a CHIRPS or GEFS
fetch never reaches SQS with `chirps_source = "mirror"`, nor a DWS fetch
with `dws_source = "store"`; `backend/src/jobs/handlers/feed-fetch.ts`).

**What the second flag removes.** With both on the new values,
`local.per_feed_fetching` (`infra/feeds.tf`) is false, and the same apply
plans to destroy:

- the `fetch-requests` and `ingest-results` queues, their DLQs and redrive
  policies;
- the fetcher's SQS trigger and the worker's `ingest-results` trigger, and
  both roles' `feed-queues` policies;
- the SQS endpoint's `WorkerSendsFetchRequests` statement (`infra/jobs.tf`);
- the alarms on them: the two DLQ-arrival alarms (essential tier, so it
  drops from 13 alarm metrics to 11), `fetch-requests-age` and
  `feed-fetch-failed` with its log filter (only the per-feed mode logs it);
- the worker's `FEED_FETCHER` and `FETCH_REQUESTS_QUEUE_URL`, and the
  fetcher's `INGEST_RESULTS_QUEUE_URL`.

The fetcher Lambda stays, for its scheduled modes (the daily ingest, the
GEFS pass and the weekly DWS pass), with its errors and throttles alarms.
Read the plan before the apply: it should destroy only the list above and
change the two functions' environments. Check that both queues are empty
first (`ApproximateNumberOfMessages` 0 on `fetch-requests` and
`ingest-results`; an answer still in flight is lost with its queue, and the
feed simply fetches again from the copy or store). **The running backend
release must include issue #604 R3-C** before this apply: its production
check accepts a worker with no `FEED_FETCHER` once both flags are on the
new values, and a fetcher with no `INGEST_RESULTS_QUEUE_URL`
(`backend/src/config/production.ts`); an older release refuses to start
both Lambdas. With it deployed, apply with the operator's go-ahead; no
further release is needed. On Lambda a live request from the API
or worker is refused whatever the configuration
(`backend/src/feeds/http.ts`), so a mistake fails a fetch job loudly
("this worker may not fetch … from the source itself") rather than asking
CHC or DWS from an address they don't know.

**Rollback.** Flip either flag back (`chirps_source = "chc"` or
`dws_source = "live"`) and apply: the queues, triggers, grants, alarms and
the worker's `FEED_FETCHER=sqs` come back in that apply, and feeds of that
source fetch through the fetcher again from their next fetch. New queues
have new URLs, which the same apply hands both functions. The cell cache and
the store stay valid either way.

**Afterwards** (stage 2, not built): once both flags have run in production
for 30 days with no rollback, the per-feed code is deleted
([followups.md § The rain data copy](./followups.md#the-rain-data-copy)).

## Alert emails

The worker sends the alert emails ([architecture.md § Alert emails](./architecture.md#alert-emails),
[security.md § Alerts](./security.md#alerts)) through the same SES identity
and configuration set as every other email ([§ Email](#email-amazon-ses)).

- **Worker environment and runtime secret** (`infra/jobs.tf`, `infra/secrets.tf`):

  | Variable | Value |
  | --- | --- |
  | `APP_ENCRYPTION_KEY` | The sops key `app_encryption_key` (32+ alphanumeric characters), in the API's runtime secret. Seals two-step sign-in's TOTP secrets (AES-256-GCM, `auth/secretBox.ts`); the API refuses a missing, short or `dev-only-` value at cold start. Rotate only if it leaked ([§ Runbooks](#runbooks) 15) |
  | `MFA_REQUIRED` | Unset (or `true`). The API and worker refuse `false` at cold start: in production, publishing to farmers, licence decisions and evidence packs always need two-step sign-in, and owners' and team admins' actions do where a project or team requires it (`auth/stepUp.ts`, 204_mfa_opt_in) |
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
- **SES suppression → the app** (`infra/ses.tf`). Bounced and complaining addresses are on the configuration set's
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
run on the job queue, with the rendering done outside the VPC (infra/reports.tf):

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
queues, and kept in a bucket of its own (infra/packs.tf):

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
  interface endpoint** (`s3_endpoint_az_count`, one AZ by default,
  ~$7.30/month; for the worker its policy allows only `s3:GetObject` on
  `packs/*`, and otherwise only the API's put of a pack bundle, the DEM and
  water reads and the migrate Lambda's reference reads) and holds that one
  grant. The renderer
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
they are. Its basemap, labels, relief and delineation need the **map tiles**,
and its proposals need **reference datasets** in the database; both are
operator steps after the first apply. `infra/map_data.tf` holds the two
buckets they use, kept apart because one is public and the other is not.

### Map tiles

The tiles bucket (`tiles_bucket` output) holds what the browser reads, under
`tiles/`, served same-origin at the site's `/tiles/*` (an ordered CloudFront
behaviour with its own OAC, `infra/s3_cloudfront.tf`):

| Object | Built by | Frontend variable | Licence step first |
| --- | --- | --- | --- |
| `tiles/south-africa.pmtiles` (the basemap, ~1 GB at maxzoom 15) | `pnpm dev:tiles:fetch` | `PUBLIC_TILES_URL=/tiles/south-africa.pmtiles` | none (the OSM attribution is always on the map) |
| `tiles/fonts/<font stack>/<range>.pbf` and `tiles/fonts/OFL.txt` (the labels' glyphs) | `pnpm dev:tiles:fonts` | `PUBLIC_TILES_GLYPHS_URL=/tiles/fonts/{fontstack}/{range}.pbf` | none (the OFL notice goes up beside them) |
| `tiles/water.pmtiles` (tracing a dam's water occurrence, JRC Global Surface Water, tens of MB; read by the API, not the browser) | `pnpm dev:tiles:water` | none: `dam_trace_water` in the tfvars (below) | none (free of charge, without restriction of use; "Source: EC JRC/Google" goes into each traced feature's description) |
| `tiles/terrain.pmtiles` (the relief, and delineation's DEM, ~2.2 GB) | `pnpm dev:tiles:terrain` | `PUBLIC_TERRAIN_URL=/tiles/terrain.pmtiles` | the Copernicus licence's liability sentence, "The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30" (Art. 6(c)), in the app's legal text |

The local commands leave the files in `~/.cache/water-management-tiles/`.
Upload them with your own SSO session (no workflow or Lambda can write the
bucket), through `backend/scripts/tiles-upload.ts --production`: it puts
the archive in the tiles bucket, keeps the original download in the
reference bucket under `originals/<archive>/`, and writes the archive's
provenance file (its SHA-256, the upstream's version, ETag and
Last-Modified, the originals' hashes) to `reference/tiles/`, then prints
the `load-reference.yml` run that records it ([§ Reference
datasets](#reference-datasets), Which file is loaded). `--dry-run` first
shows what it would put and record, and uploads nothing. **An upload is
itself the release** of that file: the `/tiles/*` behaviour serves whatever
is in the bucket to anyone, by byte range, whether or not the frontend
variable is set. So upload `terrain.pmtiles` only once the Art. 6(c)
sentence is live in the app's legal text; the frontend gate and
`delineation_dem` come after that, not instead of it. Then invalidate the
cache, since CloudFront keeps byte ranges of the old file and the PMTiles
reader notices a replaced archive by its `ETag`. From `backend/`, with the
buckets from `terraform output`:

```bash
export AWS_PROFILE=water-management AWS_REGION=af-south-1
T="--production --tiles-bucket <tiles_bucket> --reference-bucket <reference_bucket>"
C=~/.cache/water-management-tiles
pnpm exec tsx scripts/tiles-upload.ts $T $C/south-africa.pmtiles --version <build YYYYMMDD> --original $C/south-africa.pmtiles --dry-run
pnpm exec tsx scripts/tiles-upload.ts $T $C/south-africa.pmtiles --version <build YYYYMMDD> --original $C/south-africa.pmtiles
pnpm exec tsx scripts/tiles-upload.ts $T --fonts $C/fonts --version <FONTS_REF> --original $C/basemaps-assets-<FONTS_REF>.tar.gz
pnpm exec tsx scripts/tiles-upload.ts $T --terrain $C/terrain.pmtiles --version <Mapterhorn version> --original $C/terrain.pmtiles
pnpm exec tsx scripts/tiles-upload.ts $T --water $C/water.pmtiles --version 1.5 --upstream <one GSW tile's URL> $(for f in $C/gsw/occurrence_*.tif; do printf -- '--original %s ' "$f"; done)
# each prints its own record run, e.g.:
gh workflow run load-reference.yml -f kind=tiles -f key=reference/tiles/terrain-<date>.json -f sha256=<hex> -f dataset=terrain
aws cloudfront create-invalidation --distribution-id <cloudfront_distribution_id> --paths '/tiles/*' --profile water-management
```

The basemap's and the relief's original download *is* the extract (`pmtiles
extract` reads the region's byte ranges of an archive of hundreds of GB, which
can't be kept), so the extract goes in as its own original: the upstream
deletes old daily builds, and the tiles bucket keeps a replaced archive only
14 days. One PutObject takes at most 5 GiB; past that (no archive is near it
today) the script refuses and says to use `aws s3 cp`. Each upload also
leaves `<file>.provenance.json` beside the file, so a later upload of the
same bytes records the same provenance without the flags.

Then set the repository variables in the table (`gh variable set
PUBLIC_TILES_URL --body /tiles/south-africa.pmtiles`, and so on) and
release the web (`deploy-frontend.yml` reads them). Its **Map tiles gate**
(`scripts/release/map-data-gates.mjs frontend`) refuses anything but those
same-origin paths, and refuses the relief until the Art. 6(c) sentence is in
the legal text under `frontend/src`. The CSP needs no change: the tiles
and glyphs are fetched same-origin (`connect-src 'self'`), and MapLibre's
worker is the app's own (`worker-src 'self'`).

**Delineation** reads the same `terrain.pmtiles` from the API Lambda, by
ranged S3 GetObject through the S3 interface endpoint. Set
`delineation_dem = true` in the tfvars and apply, once the file is uploaded
and the Art. 6(c) sentence is live: Terraform then sets
`DEM_URL=s3://<tiles_bucket>/tiles/terrain.pmtiles` on the API and lets its
role read that one key (`api_dem`), and the Map offers **Delineate**. It
refuses a plan where the API Lambda is under 1 024 MB or 25 s: a
delineation peaks near 460 MB at its window cap and keeps a 20 s budget
([design/delineation.md § Where it runs](./design/delineation.md#where-it-runs)),
which the defaults (1 024 MB, 30 s) hold with room to spare. The worker
gets the same `DEM_URL` and grant (`worker_dem`) for the `delineate` job (a
catchment too large for the request, up to 6 144 cells), and at least
2 048 MB whatever `worker_memory_mb` says, since that window peaks at
about 1.1 GB (`infra/jobs.tf` `local.worker_memory_mb`; more memory is also more
CPU, and a few cents a month at the 5-minute tick).

**Tracing a dam** (#326 C2, [maps.md § Assisted
drawing](./maps.md#assisted-drawing)) reads `water.pmtiles` from the API
Lambda the same way. Set `dam_trace_water = true` in the tfvars and apply
once the file is uploaded: Terraform sets
`WATER_URL=s3://<tiles_bucket>/tiles/water.pmtiles` on the API and lets its
role read that one key (`api_water`), and the Map offers **Trace a dam**. A
trace reads a handful of small tiles in milliseconds, so it asks nothing of
the Lambda's size. Unlike the DEM it waits for no legal sentence (GSW's
licence is settled), and it is independent of `delineation_dem`.

**The cost bound.** Every object under `/tiles/` is public (anyone can
fetch it, as the browser does), and the archives are gigabytes. The
`tiles_range` CloudFront Function lets through an archive only by one
closed byte range of at most 2 MiB (a PMTiles read is a 16 KiB header, then
directories and tiles far smaller), glyph ranges and the licence whole, and
answers 404 for anything else, before S3. So one request moves at most
2 MiB, and the WAF's tiles rule (`waf_tiles_rate_limit_per_ip`, 1 000 per
5 minutes) bounds one address at about 2 GB per 5 minutes in the worst
case, about $0.23 of CloudFront egress in South Africa (real map use is a
few hundred KB a pan). Requests understate this cost about a hundredfold,
so the `cloudfront-bytes` alarm watches bytes: past 0.5 GB in 5 minutes
(`cloudfront_bytes_alarm_gb_per_5min`) it fires, which one address at the
tiles limit does in the first period; a pull spread under it from many
addresses (~$12–16 a day) is the daily budget's to catch (§ Budget alerts).
Storage is ~3.5 GB (under $0.10/month), multipart uploads left unfinished
are aborted after 7 days, and the bucket is versioned: a replaced or
deleted archive can be restored for 14 days (S3 console → the object →
Versions, or `aws s3api copy-object` from its version id), then the old
version expires. Restore it before an invalidation, as for any
replacement.

### Reference datasets

The map's proposals read global reference tables that the operator loads
as the schema owner: locally `pnpm import:<kind>` against the dev database
([maps.md](./maps.md)). Production's database is in a private VPC, so a
production load runs in the **migrate Lambda**, which already holds the
owner's credentials: it reads one file from the private **reference
bucket** (`reference_bucket` output, `reference/<kind>/…`), checks it
hashes to the SHA-256 the operator gave, and replaces that dataset in one
transaction with the same parsers and writes the local scripts use
(`backend/src/geo/referenceLoad.ts`). The bucket grants nothing in its
policy; the migrate role's own policy reads `reference/*`, and nothing can
write it but the operator's SSO session. Loads run through
**`load-reference.yml`** (Actions → Load a reference dataset, or `gh
workflow run`): its `check` job validates the inputs and the licence gates
before anyone approves, and its `load` job runs in the `production`
environment (the required reviewer, then OIDC; no AWS key anywhere) and
prints counts only. A failure prints a code and a fixed reason; the detail
is in the migrate Lambda's CloudWatch log, and the dataset stays as it was.
A third job, `preflight` (no environment, no AWS), runs `preflight.mjs
environment` first: it refuses the run unless the `production` environment
exists with a required reviewer and its branch policy, since naming a
missing environment would create it unprotected. The load runs from `main`
only, and its AWS session is narrowed (an inline session policy) to
invoking the migrate function, so the deploy role's other grants never
reach it.

**Undoing a load.** A load replaces its dataset in one transaction, so a
failed one changes nothing. To undo one that succeeded but was wrong, load
the previous file again under the same dataset label: the bucket is
versioned and keeps an overwritten or deleted file for a year (S3 console →
the object → Versions, or `aws s3api list-object-versions --prefix
reference/<kind>/`), so restore that version (copy it back over the key),
`sha256sum` it, and run the workflow with its hash. Values a project
already accepted were copied into the project and don't change either way.

**Which file is loaded.** Each load records the object's key and SHA-256
with the dataset, in the same transaction (`reference_load`, migration 192;
`geo/referenceOrigin.ts`), so the record outlives the Actions log. The tile
archives are recorded there too (migration 248, kind `tiles`, one row per
archive): our SHA-256 of the archive, the upstream's URL, version, ETag and
Last-Modified, the licence it is used under, and the originals kept in the
bucket with their hashes. `tiles-upload.ts --production` writes the
provenance file, and the workflow's `tiles` kind records it (`-f
kind=tiles -f dataset=<basemap|fonts|terrain|water>`, no source; the
record names the archive and adds no data). Locally `tiles-upload.ts`
records it straight into the dev database. The Map shows the recorded
version and dates on the elevation model's and the water occurrence's
dataset lines (`app_reference_provenance()`, the app's only read). The
workflow's log prints the file it loaded and the one it replaced (key,
SHA-256 and when it was loaded): that replaced file is the one to restore
to undo the load. A local `pnpm import:*` of the same label names no
bucket file, so it deletes the record rather than leave it describing data
that is gone. The table is owner-only (the app reads only versions and
dates, through `app_reference_provenance()`); to read it outside a load,
run the `reference-provenance` check ([§ Read-only production
checks](#read-only-production-checks)), or locally `SELECT * FROM
reference_load` as the schema owner (`pnpm dev:db:psql`).

Only what [maps.md § Sources](./maps.md#sources) marks allowed loads. The
workflow offers those kinds alone, its gate refuses the rest, and the
Lambda refuses them again by name (`referenceLoad.test.ts` checks the
Lambda's list against the Sources table):

| Kind | Licence (maps.md § Sources) | The file | How to make it |
| --- | --- | --- | --- |
| `land-cover` | ESA WorldCover, CC BY 4.0: allowed | the pre-summarised grid (JSON, gzipped), never the GeoTIFF tiles | `pnpm import:land-cover tiles/*.tif --dataset WorldCover-2021-v200 --out worldcover.json.gz` |
| `evaporation` | dPET, CC BY 4.0: allowed (its attribution, with ERA5-Land's Copernicus line, is stored on the dataset row and shown under every proposal) | the grid of monthly means (JSON, gzipped), never the yearly NetCDF files; reference ET (`"kind": "et0"`) only, an A-pan grid is refused | `pnpm import:evaporation:fetch` or `pnpm import:evaporation --reduce` first (maps.md § Evaporation from the map), then `pnpm import:evaporation reduced/*.dpet-monthly.json --dataset dPET-1991-2020 --out dpet.json.gz` |
| `rivers` | HydroRIVERS: allowed, once HydroSHEDS' Exhibit B statement is in the app's legal text (the gate checks `frontend/src` for it) and the Terms carry the end-user protections (§9's clause on map data licensed to us: no stand-alone redistribution, no reverse engineering; done 2026-10-03, and the gate checks for it too) | a GeoJSON FeatureCollection of reaches (gzip it) | `pnpm dev:tiles:rivers` leaves `~/.cache/water-management-tiles/rivers.geojson`; `gzip -k` it |
| `gazetteer` | GeoNames, CC BY 4.0: allowed (its attribution, "GeoNames (geonames.org), CC BY 4.0", is stored on every place and shown under every Map search that lists one) | GeoNames' South Africa dump, `ZA.txt`, and its six neighbours' (`BW`, `LS`, `MZ`, `NA`, `SZ`, `ZW`) concatenated into a second file (gzip each); the kinds the search doesn't keep (roads, schools, …), a neighbour's places outside the basemap, and any other country's are left out at load | download the seven zips from download.geonames.org/export/dump/, unzip each in its own folder, `gzip -k ZA.txt`, and `cat` the six neighbours into one file, gzipped (steps below; maps.md § Gazetteer) |
| `map-grid` | allowed dataset by dataset: the Southwestern Cape surface (WAAS, 2007) only, by the operator's decision of 2026-10-23 (terms not stated; legal/map-data-licences.md § 3.3b), as dataset `WAAS-SWCape-2007`, stored with its recorded source, version and credit line whatever the file says; `Lynch-2004` and any other label refused (the gate and the Lambda), and so is a `source` | the grid cut to the client's area, in the JSON form `--out` writes (gzipped), never the ASCII grid itself | `pnpm import:map-grid waas.asc --dataset WAAS-SWCape-2007 --source "…" --bbox <w,s,e,n> --out waas-swcape.json.gz` (steps below) |
| `dws` | DWS verified daily flow: allowed, by DWS's permission obtained through the client's hydrologist (2026-10-28; data-sources.md § dws-flow). Not map data: one river gauge's flow, written into the gauge record store as `dws-request` rows (origin `dws`), merged with the station's other windows rather than replacing a dataset; `source` (the record's reference, 1–200 characters) is required, `station` optional | one station's DWS daily table: a `HyData.aspx` page saved as HTML (up to 20 years a request) or DWS's text reply, `.txt`, `.html`, `.htm` or `.aspx`, gzipped or not; at most 8 MiB (16 MiB unzipped) | save the page or keep the reply, `gzip -c` it to a neutral name ([§ DWS gauge records](#dws-gauge-records), Loading DWS's reply) |
| `soils` | SoilGrids 2.0 and iSDAsoil, CC BY 4.0: allowed (their attribution is stored on the dataset row) | the soil water capacity grid `ingest/soils.py` writes (JSON, gzipped), never the GeoTIFFs; at most 32 MiB (64 MiB unzipped) | the GDAL steps below, then `python3 ingest/soils.py … --out soils-d1.json.gz` |
| `gr4j-donors` | GRDC-Caravan and HydroATLAS, CC BY 4.0: allowed (only fitted parameters, scores and attributes are in the file, no flow; the recorded attribution `GR4J_DONORS` is stored whatever the file says) | the donor file `pnpm fit-donors` writes (JSON, gzipped); at most 4 MiB (8 MiB unzipped) | the donor fit below (offline, on our own forcing) |
| `quaternaries`, `dam-register`, `gauge-stations` | blocked: licence unconfirmed | – | refused until the decision in followups.md is made and the Sources row says allowed |
| `crop-types` | blocked: SANLC's terms not yet recorded (issue #604 R5-D, #618 step 8b) | the orchard and vine summary `pnpm import:crop-types … --out` writes, once allowed | refused until followups.md *Decision: SANLC's licence* is made; the live site shows no orchards or vines until then |

```bash
sha256sum worldcover.json.gz
aws s3 cp worldcover.json.gz s3://<reference_bucket>/reference/land-cover/worldcover-2021.json.gz --profile water-management
gh workflow run load-reference.yml -f kind=land-cover -f key=reference/land-cover/worldcover-2021.json.gz -f sha256=<hex> -f dataset=WorldCover-2021-v200
```

Evaporation is the same with `kind=evaporation` and a key under
`reference/evaporation/`; the file carries dPET's source, version and
attribution (`-f source=…` overrides the source). For rivers add `-f source="<the attribution line>"` (the one
`bin/tiles-dev.sh` uses, `RIVERS_SOURCE`) and, to keep only the larger
streams, `-f min_order=<n>`. The gazetteer is `kind=gazetteer` with a key under
`reference/gazetteer/` (e.g. `za-2026-10-12.txt.gz`) and a dataset such as
`GeoNames-ZA-2026-10`; `-f source=…` overrides GeoNames' attribution, which
is the default. Until it runs, the Map's search finds no town, farm or river
(it says no place names are loaded). South Africa's neighbours (the towns
the basemap labels over the border: Kanye, Lobatse, Gaborone, Maseru,
Mbabane, Maputo, …) are a second run and a second dataset, so neither load
replaces the other. Both need the first backend release that carries
migrations 236 (the `country` column) and 237 (alternate names and
population) deployed first: the loader that reads the neighbours, the
alternate names and the population runs in the migrate Lambda that release
ships. A dataset loaded by an earlier release has no alternate names and no
population (the search then misses "Tsabong" and ranks a hamlet beside a
capital), so after that release reload every gazetteer dataset already
loaded: the same two runs below, same keys and the same dataset labels (a
load replaces its own dataset in one transaction, so the search keeps
working throughout). The steps, from an empty folder outside the repo:

```bash
for c in ZA BW LS MZ NA SZ ZW; do mkdir -p $c && curl -fsSL -o $c/$c.zip https://download.geonames.org/export/dump/$c.zip && unzip -o -q $c/$c.zip -d $c; done
gzip -c ZA/ZA.txt > za-2026-10-13.txt.gz
cat BW/BW.txt LS/LS.txt MZ/MZ.txt NA/NA.txt SZ/SZ.txt ZW/ZW.txt | gzip > neighbours-2026-10-13.txt.gz
sha256sum za-2026-10-13.txt.gz neighbours-2026-10-13.txt.gz
aws s3 cp za-2026-10-13.txt.gz s3://<reference_bucket>/reference/gazetteer/za-2026-10-13.txt.gz --profile water-management
aws s3 cp neighbours-2026-10-13.txt.gz s3://<reference_bucket>/reference/gazetteer/neighbours-2026-10-13.txt.gz --profile water-management
gh workflow run load-reference.yml -f kind=gazetteer -f key=reference/gazetteer/za-2026-10-13.txt.gz -f sha256=<za hex> -f dataset=GeoNames-ZA-2026-10
# approve it in the production environment, wait for it to finish (one load at a time), then:
gh workflow run load-reference.yml -f kind=gazetteer -f key=reference/gazetteer/neighbours-2026-10-13.txt.gz -f sha256=<neighbours hex> -f dataset=GeoNames-neighbours-2026-10
```

The CloudWatch log of each load says what it kept by country, how many
alternate names it kept and left out, and what else it left out. On the
dumps of 2026-10-13 the first keeps 95 841 places and 18 190 alternate
names (1 561 left out: another script, a code or a link), the second 15 405
places (BW 2 542, LS 1 022, MZ 4 518, NA 5 560, SZ 1 662, ZW 101; 68 547 of
the neighbours' places lie outside the basemap and are left out) and 5 282
alternate names (1 528 left out). Check in the Map's search: "Lobatse" lists
"Lobatse, Botswana", "Tsabong" lists "Tshabong (also Tsabong), Botswana",
and "Windhoek" lists Namibia's capital first. A later
refresh reloads each file under its own label (or a new label, then
removes the old one). Never load a country in both datasets: its places
would be listed twice. A dump of any other country is refused (`empty`, no
place the load can take). Approve each run in the `production`
environment. Never load the synthetic fixtures into production (the label
`synthetic` is refused).

**The MAP grid** (issue #560; [maps.md § MAP grid](./maps.md#map-grid)).
Needs the first backend release that carries migration 238 deployed first
(it lets `reference_load` record a `map-grid` load; the loader runs in the
migrate Lambda that release ships). Then, from a folder outside the repo
with the surface as received (an ESRI grid or GeoTIFF; never commit it):

1. Check its coordinate system with `gdalinfo`. If it isn't WGS84 degrees
   (EPSG:4326), warp it to square cells of about 100 m:
   `gdalwarp -t_srs EPSG:4326 -tr 0.001 0.001 -r bilinear waas.tif waas-4326.tif`
   (add `-s_srs` when the file names none: `EPSG:4222` for the Cape datum).
2. Write the ASCII form: `gdal_translate -of AAIGrid waas-4326.tif waas.asc`.
3. Cut it to the client's area and write the load's file. The box is the
   client's catchments with a margin of about 0.05° (west, south, east,
   north in degrees): it keeps the load small and shows no more of the
   surface than the client's study needs.
   `pnpm import:map-grid ./waas.asc --dataset WAAS-SWCape-2007 --source "Mean annual rainfall surface for the Southwestern Cape" --bbox <w,s,e,n> --out ./waas-swcape.json.gz`
   (paths resolve from the folder the command is typed in; the `--source`
   is the file's own and the load replaces it with the recorded credit
   line). A 1° box at 0.001° is about a million cells, some 25 MB of JSON
   before gzip; a box past the 200 MiB caps is the wrong box.
4. Optionally load the same file locally first to look at it on the Map
   tab: `pnpm import:map-grid ./waas.asc --dataset WAAS-SWCape-2007 --source "…" --bbox <w,s,e,n>`.
5. Upload and load it:

```bash
sha256sum waas-swcape.json.gz
aws s3 cp waas-swcape.json.gz s3://<reference_bucket>/reference/map-grid/waas-swcape-2007.json.gz --profile water-management
gh workflow run load-reference.yml -f kind=map-grid -f key=reference/map-grid/waas-swcape-2007.json.gz -f sha256=<hex> -f dataset=WAAS-SWCape-2007
```

Approve it in the `production` environment. Check on the Map tab of the
client's project: **MAP grid** on lists "WAAS-SWCape-2007" with its source
line (the authors' credit line whole), and the map's credits show "MAP
grid: WAAS (2007), Beuster Clarke & Associates", linking to
`/data-sources#waas-map`. Then Settings → Model selection for flow generation, under Per
unit, **MAP from the grid** proposes each unit's MAP from it, beside the typed values,
to check them. A wider box later is a reload under the same label (a load
replaces its dataset).

**Soils and GR4J donors** (issue #622; [model.md §2.10m](./model.md),
[maps.md § Soil water capacity](./maps.md#soil-water-capacity),
[data-sources.md § GR4J priors](./data-sources.md#gr4j-priors-issue-622)).
Both are the regional prior's reference data. Both are operator-run and
offline, and the app never fetches either. Each needs the first backend
release that carries migrations 268 (soils) and 269 (donors) deployed
first. Until both are loaded, nothing uses a prior and GR4J keeps Perrin's
defaults. No screen reads them yet: wiring the prior in is #622 step 5.
Work in a folder outside the repo, and never commit a download or a file
made from one.

*The soil grid.* GDAL reads each source for region D1 only, averages it
onto one 0.05° WGS 84 grid, and writes the ASCII form `ingest/soils.py`
reads. SoilGrids' water retention sits in Google Cloud Storage (not on
`files.isric.org`), one 2.2 GB GeoTIFF per depth. iSDAsoil's bedrock depth
is one 23.6 GB cloud-optimised GeoTIFF; GDAL reads only the overview
blocks it needs.

```bash
for p in wv0033 wv1500; do mkdir -p $p; for d in 0-5 5-15 15-30 30-60 60-100 100-200; do gdalwarp -q -t_srs EPSG:4326 -te 10 -35.5 41 -8 -tr 0.05 0.05 -r average -ot Float32 /vsicurl/https://storage.googleapis.com/isric-share-soilgrids/pre-release/$p/${p}_${d}cm_mean.tif $p/${p}_${d}cm_mean.tif && gdal_translate -q -of AAIGrid $p/${p}_${d}cm_mean.tif $p/${p}_${d}cm_mean.asc; done; done
AWS_NO_SIGN_REQUEST=YES AWS_REGION=us-west-2 gdalwarp -q -b 1 -t_srs EPSG:4326 -te 10 -35.5 41 -8 -tr 0.05 0.05 -r average -ot Float32 /vsis3/isdasoil/soil_data/bedrock_depth/bedrock_depth.tif bedrock.tif && gdal_translate -q -of AAIGrid bedrock.tif bedrock.asc
python3 <repo>/ingest/soils.py --wv0033 wv0033 --wv1500 wv1500 --bedrock bedrock.asc --out soils-d1.json.gz
```

The last line prints how many cells it wrote and how many it left out. Check it locally first:
`pnpm import:soils <folder>/soils-d1.json.gz --dataset SoilGrids2-iSDA-D1`.
Region D1 at 0.05° is at most 341 000 cells, about 12 MB of JSON. Keep the
twelve SoilGrids GeoTIFFs and the bedrock GeoTIFF clip under
`originals/soils/` in the reference bucket. Then upload and load:

```bash
sha256sum soils-d1.json.gz
aws s3 cp soils-d1.json.gz s3://<reference_bucket>/reference/soils/soils-d1-2026.json.gz --profile water-management
gh workflow run load-reference.yml -f kind=soils -f key=reference/soils/soils-d1-2026.json.gz -f sha256=<hex> -f dataset=SoilGrids2-iSDA-D1
```

*The donors.* Load the soil grid first, locally and in production, so
each donor carries its PAWC for the soil x1 relation. The donor fit reads
this checkout's database for the evaporation and soil grids, so load the
real dPET grid (`pnpm import:evaporation …`) and the soil grid locally
first. It reads our rain data copy through `MIRROR_URL`, the production
copy's S3 URL with your SSO profile, or a local copy of it. The steps:

1. Download GRDC-Caravan's CSV archive, `GRDC_Caravan_extension_csv.zip`
   (8.8 GB, from the Zenodo record 10.5281/zenodo.15349031; no account),
   and unzip it. Read `licenses/grdc/LicensesCaravan.xlsx` again for a new
   version: a D1 country whose terms fail D-B is a decision before loading.
2. Turn the basin polygons into GeoJSON:
   `ogr2ogr -f GeoJSON basins.geojson GRDC_Caravan_extension_csv/shapefiles/grdc/<the .shp>`
   (each feature has `gauge_id`).
3. Fit: `pnpm fit-donors --caravan GRDC_Caravan_extension_csv --basins basins.geojson --out donors-d1.json.gz`
   (paths resolve from the folder the command is typed in). Optional:
   `--from` (default 1981-01-01, CHIRPS v3's start), `--to`, `--product
   sat|rnl`, `--evaporation <dataset>` and `--soils <dataset>` (default the
   newest real one of each), `--max-area` (default 10 000 km²), `--min-kge` (default 0.5), `--only
   <id,…>` to try a few, and `--budget`, `--starts` and `--seed`. A donor
   is a basin in region D1 with at least 8 years of flow in the window and
   under 5 % regulation, whose fit reaches KGE′ 0.5 (`--min-kge`). Each is calibrated with the engine's own
   `calibrate()` (KGE′, the typical bounds, x2 fixed, the split-sample
   test). Every basin it refuses is printed with its reason, and so is how
   many donors ended at a typical bound, per parameter. Expect a few
   hundred basins, each a few seconds to a minute.
4. Look at it locally: `pnpm import:gr4j-donors donors-d1.json.gz --dataset Caravan-D1-2026`.
5. Keep the zip under `originals/gr4j-donors/`, then upload and load:

```bash
sha256sum donors-d1.json.gz
aws s3 cp donors-d1.json.gz s3://<reference_bucket>/reference/gr4j-donors/caravan-d1-2026.json.gz --profile water-management
gh workflow run load-reference.yml -f kind=gr4j-donors -f key=reference/gr4j-donors/caravan-d1-2026.json.gz -f sha256=<hex> -f dataset=Caravan-D1-2026
```

Approve each in the `production` environment. The dataset row records the
set's SHA-256 (of the engine's `donorSetCanonical`) and the engine that
fitted it. Refit, under a new label, when the engine's GR4J or calibration
changes the parameters it would find, or when the copy gains years.

Limits: the file at most 200 MiB as uploaded and 200 MiB of text unzipped
(a gzip bomb is cut off, not unpacked), refused with a reason beyond that;
the migrate Lambda has `migrate_memory_mb` (3 008 MB, the least Terraform
accepts, with V8's heap at 85% of it) and 900 s. Parsing 200 MB of text
peaked at 1.8 GB resident for either kind (measured 2026-10-02 on synthetic
files of 475 000 reaches and 6.9 million cells). A country's WorldCover
grid at 0.0025° is a few million cells, tens of MB gzipped; South Africa's
HydroRIVERS reaches are tens of MB. Evaporation has its own, smaller caps,
32 MiB uploaded and 64 MiB unzipped (`REFERENCE_KINDS` `limits`): South
Africa at dPET's 0.1° is about 23 000 cells, 2–3 MB of JSON, and all of
Africa about 50 MB, so anything bigger is the wrong file. The MAP grid
takes the default caps: the file is the client's area only. So has the
gazetteer, 64 MiB uploaded and 128 MiB unzipped: South Africa's dump is
12 MB of text and its six neighbours' 10 MB together (2.7 MB and 2.4 MB
gzipped, 2026-10-13), all of GeoNames' about 1.6 GB. A load costs cents (3 GB × a few
minutes of Lambda) and runs one at a time (reserved concurrency 1, the
workflow's concurrency group). Migrations use the same memory and timeout,
billed only while they run. Don't run a load while a backend deploy is
migrating: the migrate Lambda's reserved concurrency of 1 turns the second
invocation away (the workflow fails with a throttle, nothing is loaded), and
a load writes only its own dataset's rows, so retrying afterwards is safe.

#### Refreshing a dataset

Reference data changes yearly at most, and most of it never. Check
politely before refreshing (one request, a conditional one where the
upstream supports it, with your own contact in the User-Agent; a 403 means
stop and find out why, never retry: [data-sources.md § The
rule](./data-sources.md#the-rule)). Each refresh keeps the original
download in the reference bucket under `originals/<dataset>/`, named by
version, so the dataset can be rebuilt without the upstream. A tile
archive's originals go up with `tiles-upload.ts`; a table dataset's with
`aws s3 cp <file> s3://<reference_bucket>/originals/<kind>/<version>-<file>
--profile water-management` before its load (their hashes are not yet
recorded in `reference_load`, only the loaded file's). The last recorded
ETag and Last-Modified: the `reference-provenance` check ([§ Read-only
production checks](#read-only-production-checks)), or the archive's
`<file>.provenance.json` beside your cached copy.

| Dataset | Where it comes from | Is there a new version? | Rebuild and upload | Verify |
| --- | --- | --- | --- | --- |
| `basemap` (tiles) | Protomaps daily builds of OpenStreetMap, `build.protomaps.com/<YYYYMMDD>.pmtiles` | any day: pick a recent build, `curl -sI -A "<you>" https://build.protomaps.com/<YYYYMMDD>.pmtiles` (one HEAD); refresh when the map is visibly out of date | `TILES_BUILD=<YYYYMMDD> pnpm dev:tiles:fetch`, then the `tiles-upload.ts --production` line above | the Map's basemap draws; the record's version is the build |
| `fonts` (tiles) | `protomaps/basemaps-assets` at a pinned commit (`FONTS_REF` in `bin/tiles-dev.sh`) | `gh api repos/protomaps/basemaps-assets/commits/main --jq .sha` (one request); refresh only for missing glyphs | `TILES_FONTS_REF=<sha> pnpm dev:tiles:fonts` (records the archive's SHA-256 in `bin/source-checksums.sha256`: commit it), then the fonts line | labels draw; `tiles/fonts/OFL.txt` is served |
| `terrain` (tiles) | Mapterhorn's planet build, `download.mapterhorn.com/planet.pmtiles` (Copernicus GLO-30) | `curl -sI -H 'If-None-Match: <recorded ETag>' https://download.mapterhorn.com/planet.pmtiles`: 304 is unchanged; the version is in `download_urls.json` | `pnpm dev:tiles:terrain`, then the terrain line; then the invalidation | Relief draws; a delineation's dataset line shows the new version |
| `water` (tiles) | JRC Global Surface Water occurrence tiles (`WATER_SOURCE`, versioned folder and file names) | the GSW download page names the latest version (v1.5, 1984–2024 today); a new one is a new folder | `WATER_SOURCE=<new folder> pnpm dev:tiles:water` (new tiles are recorded in `bin/source-checksums.sha256`: commit them), then the water line with the new `--version` | Trace a dam's sheet shows the new version |
| `rivers` | HydroRIVERS v1.0, `data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_af_shp.zip` (static) | `curl -sI -H 'If-None-Match: <recorded ETag>' <zip URL>`: 304 is unchanged; a v2 would be a new file name | `pnpm dev:tiles:rivers`, `gzip -k rivers.geojson`, keep the zip under `originals/rivers/`, load as in the table above | the load's counts; the River network layer |
| `land-cover` | ESA WorldCover 10 m 2021 v200 (final; no later version announced) | the WorldCover site's data-access page | the operator's tiles → `pnpm import:land-cover … --out`, keep the tiles under `originals/land-cover/`, load | the load's counts; a unit's cultivated-area proposal |
| `evaporation` | dPET on data.bris (DOI-versioned; new years appended) | the dataset page lists its years; refresh when the years you average over change | `pnpm import:evaporation:fetch <first> <last>` (the yearly files are 2.4 GB each and deleted once reduced: keep the reduced totals, not the NetCDF, under `originals/evaporation/`), then `--out` and load | Settings → Evaporation from the map shows the new dataset |
| `gazetteer` | GeoNames country dumps, `download.geonames.org/export/dump/<CC>.zip` | `curl -sI -z <last load's date> https://download.geonames.org/export/dump/ZA.zip`: 304 is unchanged; refresh a few times a year at most | the gazetteer steps above; keep the seven zips under `originals/gazetteer/` | the Map's search finds the places listed above |
| `map-grid` | a file from the client (WAAS, 2007): no upstream | never, unless the client sends a new surface | the MAP grid steps above; keep the surface as received under `originals/map-grid/` | the MAP grid layer and its credit line |
| `soils` | SoilGrids 2.0 water retention (`storage.googleapis.com/isric-share-soilgrids/pre-release/`) and iSDAsoil's bedrock depth (`s3://isdasoil`) | `curl -sI` one SoilGrids file and compare its ETag and Last-Modified (2021-10-27 today); iSDAsoil v1 is final | the soil grid steps above; keep the GeoTIFF clips under `originals/soils/` | the load's counts |
| `gr4j-donors` | GRDC-Caravan on Zenodo (versioned records) | the record's version list (0.6 today); and whenever the engine's fit or the copy's years change | the donor steps above, under a new label; keep the zip under `originals/gr4j-donors/` | the load's counts; the donor set's SHA-256 on its row |

A large load squeezes the database's memory. The first production loads
(2026-10-05: HydroRIVERS, 89 454 reaches, then WorldCover, 5.4 million cells,
back to back) took the 1 GiB `db.t4g.micro` from about 140 MB freeable to
51 MB, with swap from 4 MB to 38 MB and CPU to 51%. That tripped
`rds-freeable-memory` for 20 minutes, until 34 minutes after the load, while
autovacuum analysed the new rows. Nothing failed. Expect that alarm after a
land-cover or rivers load, and run loads one at a time with a quiet spell
between them. If freeable memory settles near the 64 MiB threshold
afterwards rather than climbing back, the instance is too small for the data:
move `db_instance_class` to `db.t4g.small` (2 GiB). On this single-AZ
instance the resize restarts it, a few minutes down.

## The assistant

The AI assistant (issue #610; [architecture.md](./architecture.md),
[security.md](./security.md)) answers a project's members about its model
and results, from a hosted model. Off until the operator turns it on
(`assistant_enabled`, `infra/assistant.tf`); off, the API answers its status
with `available: false` and the page shows no chat.

**Where it runs.** Its own Lambda, `water-management-assistant`
(`backend/src/lambda-assistant.ts`): the API's bundle and app, serving only
`/projects/:id/assistant` and below (every other path is a 404, so the
longer timeout and the model permission can't be used for any other
route), in the API's private subnets with its own security group (Postgres,
the Secrets Manager endpoint, the Bedrock endpoint). It exists because a
turn (up to 6 model calls with tool reads between) runs past the API's
30 s. It has:

- a 120 s timeout (`assistant_timeout_seconds`), with `ASSISTANT_TURN_SECONDS`
  15 s below it, so a long turn ends with an error event, charged, before
  the runtime cuts it off;
- reserved concurrency 2 (`assistant_reserved_concurrency`): two turns at
  once across all users, a third gets a 429 it can resend. It bounds the
  model spend per minute and the database connections (2 × a pool of 1;
  [infra/README.md § Connections](../infra/README.md#connections));
- a Function URL in `RESPONSE_STREAM` mode, reached only through CloudFront's
  `/api/projects/*/assistant/*` behaviour, ordered before `/api/*`, with the
  same shared-secret header as the API's origin (the app refuses a request
  without it: a direct call is a 403) and an origin read timeout of 60 s.
  That timeout is the longest gap between two packets, not the response;
  the stream sends a `: keepalive` comment every 15 s
  (`ASSISTANT_KEEPALIVE_SECONDS`, kept at 1–30 s by the production check).
  The status (`GET /api/projects/:id/assistant`) stays on the API, which
  carries the same `ASSISTANT_*` values so it shows what the assistant
  enforces;
- its own runtime secret: the session key, its `water_app` connection
  (`application_name=assistant`) and the CloudFront header. No model key.

**How it reaches the model.** Amazon Bedrock, through a `bedrock-runtime`
interface VPC endpoint with private DNS (~$9.56/month in af-south-1 per AZ,
`bedrock_endpoint_az_count`): no NAT, no internet gateway, no API key. The
assistant's role may call one model (`assistant_model_id`, default
`global.anthropic.claude-sonnet-5-5`) with `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream`, in AWS's documented three-part shape
for a global profile: the inference profile in af-south-1 (requested in
af-south-1), the model in af-south-1 (requested in af-south-1) and the
region-less model (`aws:RequestedRegion` = `unspecified`, which is how
Bedrock evaluates the global routing), the last two only through that
profile (`bedrock:InferenceProfileArn`). The id carries no date or version
suffix: [the model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html)
lists `global.anthropic.claude-sonnet-5-5` as the global inference id and
af-south-1 as a Global source region (read 2026-10-27). The endpoint
policy lets only that role make those calls on that model. The production
check allows only `off` or `bedrock` as the provider on the API and only
`bedrock` on the assistant, and refuses on both a model id that isn't
Anthropic's on Bedrock, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and
`OLLAMA_URL`, and on the assistant a region other than the Lambda's own
(where its endpoint is).

**The model is answered outside South Africa.** From af-south-1, Claude is
offered only through Bedrock's global cross-Region inference (§ Region
recommendation), so each call may run in any commercial AWS region. That is
recorded as an s72 transfer in
[security.md § Personal information (POPIA)](./security.md#personal-information-popia),
disclosed in Privacy §5–§6 (`LEGAL_VERSION` 2026-10-27), and named in the
operator agreement (§ 11, clause 6.1). CloudTrail's `additionalEventData.inferenceRegion`
shows where each call ran. If a model is ever served In-Region in
af-south-1, set `assistant_model_id` to its plain `anthropic.…` id: the IAM
policy follows (the in-region shape), and the transfer goes away.

**Cost controls.** Every token cap counts **weighted tokens**: input + 5 ×
output, because the model's output costs five times its input
(`OUTPUT_TOKEN_WEIGHT`), so a cap is dollars at the input price. Claude
Sonnet 5.5 through the global profile from af-south-1 costs $2.00 per
million input and $10.00 per million output tokens (AWS Price List API,
`AmazonBedrockFoundationModels`, af-south-1, read 2026-10-27;
`assistant_input_usd_per_million`). In the app, each reserved before a turn
(the turn's budget is what every cap has left, never more) and settled after
it: 2 M a project a month (`assistant_tokens_per_month`),
1 M a person a month across projects (`assistant_tokens_per_user_month`),
and a deployment-wide monthly cap (`assistant_tokens_per_month_total`,
derived by default from the assistant's budget at the input price: 25 M
for $50 at $2/M), so no number of projects, accounts or turns at once gets
past the budget (architecture.md § Assistant); then 30 messages a user an hour
(`assistant_messages_per_hour`), and per turn 6 model calls
(`assistant_max_hops`), 150 K weighted tokens (`assistant_max_turn_tokens`,
since each call resends the transcript), 4 tool calls a model call
(`assistant_max_tool_calls_per_hop`), 1,024 output tokens a call, 12,000
characters a tool result and 40,000 of conversation (all pinned in the
Lambda's environment, the bounds checked by Terraform and by the
production check alike). In AWS:
the reserved concurrency above, and a third budget,
`water-management-assistant`, USD 50 a month (`assistant_budget_monthly_usd`,
ACTUAL 80% and 100% to the us-east-1 alerts topic), on the account's **AWS
Marketplace** charges: Anthropic's models on Bedrock are billed through AWS
Marketplace, "under the model provider (not under Amazon Bedrock)", and
nothing else in the account is. A third budget costs about $0.62 a month;
Marketplace charges can lag a further 12–24 hours behind other billing
data, so the app's caps are what stop a runaway and the hourly token alarm
below is what reports one. With the assistant on, raise
`budget_monthly_usd` by `assistant_budget_monthly_usd` (~$160 on the
defaults): the account budget includes the model spend, and the
assistant's ~$11 of fixed cost would otherwise put af-south-1's idle on the
ACTUAL 80% line every month (infra/README.md § Cost).

**Alarms** (`alarms.tf`, only while it exists). On the essential tier:
`assistant-errors` (any failed invocation: an init failure such as a
production-check refusal, a timeout or a crash; a model or tool error
inside a turn is an error event to the page), `assistant-throttles` (any
429 at the reserved concurrency), `assistant-charge-failed` (any turn whose
tokens weren't charged, which would leave every cap counting nothing),
`assistant-provider-failed` (more than 3 failed model calls in 15 minutes:
a wrong model id, model access not enabled, a quota or IAM problem; the
invocation is still a 200) and `assistant-tokens-hourly` (the turns'
weighted tokens summed over an hour above `assistant_tokens_alarm_per_hour`,
2 M ≈ $4 an hour, about 10× the expected use: the spend signal that doesn't
wait for billing). Its unhandled 500s count toward `unhandled-error`. On
the full tier: `assistant-duration-p95` (above 80% of the timeout for 10
minutes), and its direct-traffic refusals count toward
`origin-secret-rejected`. Each turn logs one `assistant_turn` line (its
token counts and how it ended); prompts and answers are never logged.

**Bedrock invocation logging stays off.** "No transcript is kept anywhere"
([security.md](./security.md)) holds only while Bedrock's **model
invocation logging** is off in the account's region. It is an account-level
setting Terraform doesn't manage (its resource can only turn logging on),
so `infra/scripts/postapply-check.sh` asserts it: `assistant-logging` fails
if `aws bedrock get-model-invocation-logging-configuration --region
af-south-1` returns a `loggingConfig`. Never turn it on in this account;
if the check fails, `aws bedrock delete-model-invocation-logging-configuration
--region af-south-1` turns it off. The same script's `assistant-budget`
warns until the assistant's budget has seen a charge: re-run it a day or
two after the first model call, and if it stays at $0 after real use, the
`BillingEntity = AWS Marketplace` filter misses the model's charge (Cost
Explorer, group by Billing entity, shows where it went). Its
`assistant-quota` prints the account's Bedrock tokens-per-minute quota
for the model's global profile (Service Quotas): record it in the release
checkpoint, since it is the most the assistant can spend a minute (output
tokens count 5× against it too).

**Turning it on.** The operator steps are in
[followups.md § Blocking releases (operator)](./followups.md#blocking-releases-operator):
enable the model in the Bedrock console and run its first invocation there,
check the endpoint service exists in the account's region, then set
`assistant_enabled = true` (and `budget_monthly_usd` raised, above) and
apply, set the GitHub variable `ASSISTANT_FUNCTION_NAME` (the
`assistant_function_name` output; unset, the deploy uses the same
conventional name), release `backend@…` so the deploy uploads its code,
then run `infra/scripts/postapply-check.sh` (the three `assistant-*`
checks above). The account's Lambda
concurrency quota must cover the extra reservation (infra/README.md §
Operator steps).

## Read-only production checks

Some follow-ups need a question asked of production's data, and RDS is
private with no bastion. The migrate Lambda, which already reads the
owner's credentials, answers a fixed set of them: an event
`{ "check": "<name>" }` runs that one named query from the registry in
`backend/src/checks/readOnlyChecks.ts` and nothing else. The event never
carries SQL: one with any other field, or a name not in the registry, is
refused (`code: "refused"`) before anything connects. The query runs as
the owner inside a `READ ONLY` transaction (any write fails, SQLSTATE
25006) with a 120 s statement timeout, and is always rolled back. It runs
no migration and no role sync, and needs no new permission: the operator's
SSO session invokes the function, and the function reads only the secret
it already reads.

The answer is `{ check, count, truncated, rows }`: ids, engine versions,
allocation modes, dates and flags only, never a person's name, an email, a
volume or a note, so it can be pasted into an issue (`series-pick-moves`
also answers with series names, which are project data, not personal
data). The exception is `dws-coverage`, whose rows are DWS station codes:
public codes, but they point at the client's catchment, so keep that
answer off the (public) issues and say only whether the stations are
covered. At most 500 rows come back;
`count` is the total and `truncated` says whether more were held back. A
failure is a `CheckFailed` error whose message is `{ code, reason,
logStream, requestId }`; the detail is in the function's CloudWatch log
(`/aws/lambda/water-management-migrate`). The migrate function runs one at
a time (reserved concurrency 1), so don't run a check while a backend
deploy is migrating or a reference load is running: the second invocation
is throttled, and running it again afterwards is safe.

Run each from any directory after `aws sso login --profile
water-management`; the answer is written to the named file, then printed:

- **`unit-rain-reference-runs`** (issue #500,
  [followups.md § Blocking releases](./followups.md#blocking-releases-operator)):
  runs on engines 1.80.0–1.84.0 whose `settings.unitRain` is `perUnit` with
  a `reference` gauge object, the rejected reference-gauge formula. Each
  row is `run_id`, `project_id`, `engine_version`, `created_at`.

  ```bash
  aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"unit-rain-reference-runs"}' --cli-read-timeout 300 --region af-south-1 --profile water-management unit-rain-reference-runs.json && jq . unit-rain-reference-runs.json
  ```

  `count: 0`: no production run used the formula; tick the follow-up. Any
  rows: add the errata row the follow-up describes to
  [engine-errata.md](./engine-errata.md) and follow
  [legal/known-defect-procedure.md](./legal/known-defect-procedure.md) for
  those runs.

- **`pre-213-cap-runs`** (issue #523 finding I,
  [security.md § Allocations](./security.md#allocations-popia-minimisation-038_allocationssql)):
  every publication, outlook and outlook publication resting on a run that
  caps use at, or scales demand to, the registered volumes
  (`summary.allocations.mode` `cap` or `fullAllocation`). Since 213 the API
  refuses to make one, so only one from before 213 can show. Each row is
  `kind` (`run_publication`, `seasonal_outlook` or `outlook_publication`),
  its `id`, `project_id`, `run_id`, `mode`, `engine_version`,
  `run_created_at`, `at` (published or created) and `current` (farmers see
  it now: a publication not superseded, an outlook publication not ended,
  an outlook with a current publication).

  ```bash
  aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"pre-213-cap-runs"}' --cli-read-timeout 300 --region af-south-1 --profile water-management pre-213-cap-runs.json && jq . pre-213-cap-runs.json
  ```

  `count: 0`: nothing to do; tick the follow-up. For each `current` row:
  a `run_publication`: run the model on that project (it compares only
  now) and publish the new run, which supersedes it (`POST
  /projects/:id/publication`, **Publish this run** in the run's
  Publication panel); an
  `outlook_publication` (and its `seasonal_outlook`): withdraw it (`DELETE
  /projects/:id/outlook-publication`, **Withdraw** in the outlook's
  Farmers section) and, if
  farmers need an outlook, start a new one on a compare-only run and
  publish that. Rows with `current: false` need nothing: viewers kept from
  the volumes already get none of their figures (farm previews refused,
  farm history drops them). An outlook publication whose outlook was
  trimmed has lost its link to the run and can't be found by this check.

- **`series-pick-moves`** (issue #523, runbook step 19,
  [data-model.md § Which series a run reads](./data-model.md#which-series-a-run-reads)):
  projects whose series of one kind (at one site) pick a different first
  series when names sort by byte (`COLLATE "C"`) instead of
  linguistically. Each row is `project_id`, `kind`, `site_node_id`, `was`
  (the names in the old order) and `will` (in the new); the first of each
  is the series a run read and will read.

  ```bash
  aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"series-pick-moves"}' --cli-read-timeout 300 --region af-south-1 --profile water-management series-pick-moves.json && jq . series-pick-moves.json
  ```

  `count: 0`: no project's pick moves. Any rows: step 19.

- **`authority-grandfathered`** (issue #523 G5, runbook step 18): the
  delegates 229 carried over from an owner's "acts for the authority"
  flag (`authority.grandfathered` events). Each row is `project_id`,
  `user_id` and `created_at`; the person is an id, never a name or an
  email: find them in the project's members list in the app.

  ```bash
  aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"authority-grandfathered"}' --cli-read-timeout 300 --region af-south-1 --profile water-management authority-grandfathered.json && jq . authority-grandfathered.json
  ```

  `count: 0`: nobody was grandfathered. Any rows: step 18.

- **`reference-provenance`** (issue #604 R3-D, [§ Reference
  datasets](#reference-datasets), Refreshing a dataset): what each
  reference dataset and tile archive was last loaded from. Each row is
  `kind`, `dataset`, `source_sha256` (our hash of the file loaded or the
  archive served), `upstream_version`, `upstream_etag`,
  `upstream_last_modified`, `originals` (how many original downloads are
  kept for it) and `loaded_at`; never a bucket key.

  ```bash
  aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"reference-provenance"}' --cli-read-timeout 300 --region af-south-1 --profile water-management reference-provenance.json && jq . reference-provenance.json
  ```

  Use the ETag and Last-Modified in a refresh's conditional request; a
  `tiles` row with no version or no originals was uploaded without them,
  so the next refresh of it should pass `--version` and `--original`.

- **`dws-coverage`** (issue #618 step 6d, [§ DWS gauge
  records](#dws-gauge-records), Which stations need the reply first): each
  river gauge an enabled DWS feed reads, and the days the gauge record
  store covers for it. Each row is `station`, `needed_from`,
  `covered_from`, `covered_to`, `hole_days`, `first_hole` and
  `days_behind`; no project or person.

  ```bash
  aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"dws-coverage"}' --cli-read-timeout 300 --region af-south-1 --profile water-management dws-coverage.json && jq . dws-coverage.json
  ```

  Every row with `hole_days` 0 and `days_behind` a week or less: the
  stations are covered, and `dws_source = "store"` can go on. The rows
  name stations, so keep them off the public issue.

Adding a check is a code change: an entry in the registry (a `SELECT`
with no parameters, its columns from the allowlist its unit test holds), a
DB test that plants a row it must find and one it must not
(`checks/readOnlyChecks.db.test.ts`), and its command here, shipped by a
`backend@` release.

## Who can sign up

`signup_open = false` (the default) sets `SIGNUP_OPEN=false` on the API, and
the backend treats an unset value on Lambda as closed too ([security.md §
Sign-up by invitation](./security.md#sign-up-by-invitation)); people then
join only through an invite from a project or team member. Production ran
that way from 2026-10-05 and has been **open since 2026-10-06**
(`signup_open = true` in `prod.tfvars`, applied), before go-live Gates A and
C in [legal-status.md](./legal-status.md). To close it again, set it back to
`false`, plan and apply (no release needed).

## Moving the site to a new domain

Issue #551 renamed the app Integrated Catchment - Water Balance Tool (IC-WBT)
and moved it from `water-management.jaredhoward.com` to
`icwbt.jaredhoward.com`. The repo, package, database and AWS resource names
keep `water-management` (identifiers nobody sees).

**What the Terraform does.** `domain_name` is the new hostname in its own
delegated child zone (`route53_zone_id`). `redirect_domains` maps each former
hostname to its zone: each stays a CloudFront alias and a SAN on the
certificate, with A/AAAA records in its zone, and `spa_rewrite` answers its
pages with a **301** to the same path and query on the new host (the query
byte for byte as the viewer sent it, from `rawQueryString()`: CloudFront's
parsed `request.querystring` doesn't keep the order of distinct names, which
the first live `postapply-check.sh --redirect-from` caught; any host
but `domain_name` is redirected, the distribution's `*.cloudfront.net` name
included). `/api/*`, `/reports/*`, `/packs/*` and `/tiles/*` don't redirect
and keep answering on a former hostname, so a mail client's one-click
unsubscribe from an older alert email, a data logger still pushing to the old
`/api/ingest`, and a signed download link minted before the move all keep
working. `ALLOWED_ORIGINS` is the new origin only: a former hostname's pages
redirect, so none calls the API from there. The SES identity, its DKIM, MAIL
FROM and DMARC records, the sender address, every emailed link (`SITE_URL`),
the renderer's site, the IAM and SES-endpoint From pins and the sign-in
CAPTCHA's API key (`token_domains`) all follow `domain_name`.

**What the operator does, in this order** (the zone, then its delegation,
then the apply, because ACM can't validate a name whose zone isn't delegated
yet; the old hostname's delegation is live already). Write down the two zone
IDs as you go (`Z…`, without the `/hostedzone/` prefix):

1. Merge the issue #551 PR to `main` (nothing deploys until the releases in steps 14 and 15).
2. `aws sso login --profile water-management && aws sso login --profile dns-parent`
3. Create the new child zone in this account: `aws route53 create-hosted-zone --name icwbt.jaredhoward.com --caller-reference "icwbt-$(date +%s)" --hosted-zone-config Comment="IC-WBT site for issue 551" --profile water-management --query 'HostedZone.Id' --output text` (no comma in `Comment`: the CLI's shorthand splits on commas and refuses the list)
4. Print its four name servers: `aws route53 get-hosted-zone --id <NEW_ZONE_ID> --profile water-management --query 'DelegationSet.NameServers' --output text`
5. Find the parent zone in the jaredhoward account (the line must read `jaredhoward.com.`): `aws route53 list-hosted-zones-by-name --dns-name jaredhoward.com --max-items 1 --profile dns-parent --query 'HostedZones[0].[Name,Id]' --output text`
6. Delegate the new zone from the parent (the same NS record the bootstrap's stage 3 wrote for the old zone, here by hand): `aws route53 change-resource-record-sets --hosted-zone-id <PARENT_ZONE_ID> --profile dns-parent --change-batch '{"Changes":[{"Action":"CREATE","ResourceRecordSet":{"Name":"icwbt.jaredhoward.com","Type":"NS","TTL":3600,"ResourceRecords":[{"Value":"<NS1>"},{"Value":"<NS2>"},{"Value":"<NS3>"},{"Value":"<NS4>"}]}}]}'`
7. Wait until the delegation resolves (the four servers from step 4): `dig +short NS icwbt.jaredhoward.com`
8. Look up the old zone's ID: `aws route53 list-hosted-zones-by-name --dns-name water-management.jaredhoward.com --max-items 1 --profile water-management --query 'HostedZones[0].[Name,Id]' --output text`
9. In `infra-secrets/water-management/prod.tfvars` set `domain_name = "icwbt.jaredhoward.com"`, `route53_zone_id = "<NEW_ZONE_ID>"` and `redirect_domains = { "water-management.jaredhoward.com" = "<OLD_ZONE_ID>" }`, remove any `mail_from_display_name` line (the default is now `IC-WBT`), and commit it there.
10. Plan: `mkdir -p -m 700 ~/.cache/water-management && cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh plan -var-file=../../infra-secrets/water-management/prod.tfvars -out="$HOME/.cache/water-management/prod.tfplan"`
    The plan should show: the certificate replaced (create before destroy) for `icwbt.jaredhoward.com` with the old name as a SAN, and a validation record for the new name; the distribution updated in place (aliases, certificate) and `spa_rewrite` updated; `aws_route53_record.site_a` and `site_aaaa` **moved** to `["water-management.jaredhoward.com"]` with no change, plus new `["icwbt.jaredhoward.com"]` records; the SES identity replaced, with its DKIM, MAIL FROM and DMARC records recreated in the new zone and deleted from the old; the WAF CAPTCHA API key replaced; the Lambdas' `MAIL_FROM`, `SITE_URL`, `ALLOWED_ORIGINS` and `RENDER_SITE_URL`, and the From pins in the IAM and SES endpoint policies, updated. No database, bucket, queue or secret change: stop and ask if there is one.
11. Apply, in a quiet hour: `cd ~/github/project-water-management/infra && AWS_PROFILE=water-management ./scripts/tf.sh apply "$HOME/.cache/water-management/prod.tfplan" && rm -f "$HOME/.cache/water-management/prod.tfplan"`
    Until SES has verified the new domain (minutes, up to an hour), sends fail: the request still answers, the failure is logged, and `mail-send-failed` may fire. SES production access belongs to the account, so it carries over. Go on to steps 12–15 straight away: until the web release (step 15) the old build's sign-in CAPTCHA key no longer exists.
12. Check the new identity reads `SUCCESS`, `SUCCESS`, `true`: `aws sesv2 get-email-identity --email-identity icwbt.jaredhoward.com --region af-south-1 --profile water-management --query '{dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus,verified:VerifiedForSendingStatus}'`
13. Push the changed outputs (`PUBLIC_SITE_URL` and the new `WAF_CAPTCHA_API_KEY`) to GitHub: `cd ~/github/project-water-management && ~/github/templates/scripts/export-tf-vars.sh infra/`
14. Release the backend (the new name in emails and the authenticator label), and approve it in the `production` environment ([§ Releasing](#releasing)): `gh release create backend@<next version> --target main --generate-notes`
15. Once that deploy has finished, release the web app, which ships the new name and carries the new CAPTCHA key (the old build's key no longer exists, so until this release a sign-in that hits the CAPTCHA can't solve it): `gh release create web@<next version> --target main --generate-notes`
16. Run the post-apply check, with the redirect: `cd ~/github/project-water-management/infra && ./scripts/postapply-check.sh --profile water-management --var-file ../../infra-secrets/water-management/prod.tfvars --redirect-from water-management.jaredhoward.com`
17. Point the repository's website at the new address: `gh repo edit Absence0760/project-water-management --homepage https://icwbt.jaredhoward.com`

What people notice: the session cookie belongs to the host, so anyone signed
in on the old address signs in again on the new one; an authenticator app
entry added before the rename keeps its old label (its codes still work; a
new entry is labelled IC-WBT); links in emails sent before the move redirect.

**Retiring the old hostname** (a tracked follow-up, once the old address has
had no page requests for a few months): set `redirect_domains = {}`, plan and
apply (the alias, the SAN and its two records go), then delete the old zone's
NS record from the parent zone (the reverse of step 6, `"Action":"DELETE"`
with the record as it stands) and the old zone itself, once it holds only its
NS and SOA records: `aws route53 delete-hosted-zone --id <OLD_ZONE_ID> --profile water-management`.
A later move (to `icwbt.co.za` or `icwbt.com`, issue #551's "later") is the
same runbook with an apex zone, `icwbt.jaredhoward.com` joining
`redirect_domains`.

## Runbooks

Step 2 operations (roadmap [step-2 § 8](./roadmap/step-2-shared-catchment.md#8-cost-and-operations)).
Every step is an ordinary app action by an owner unless it says "operator".

1. **Bad data pushed by a gateway (an API key).**
   1. Revoke the key (Project → API keys → Revoke). It stops working on the
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
2. **A feed failing.** Data → Data feeds shows the error and the
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
   one and the SQL below, also write the id to the `erasure_log` table (159),
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
   pseudonymised ("Deleted user"), invitation entries' partly hidden
   address included (160), except in the projects of a team that keeps
   public records (161), where the name stays. A `23514` error at commit ("a project must
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
10. **Request flood** (the `cloudfront-requests`, `cloudfront-bytes` or
    `waf-blocked-requests` alarm, operator; all live in us-east-1 and mail
    the same address). `cloudfront-bytes` alone (requests normal, bytes
    high) is someone pulling the map's tiles: sampled requests on
    `/tiles/` show who; one IP is already capped by
    `waf_tiles_rate_limit_per_ip`, so many IPs mean step 4 (block the
    sources), and real growth means raising
    `cloudfront_bytes_alarm_gb_per_5min` (0.1–2).
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
    (operator, the last resort; two-step sign-in, [security.md § Two-step sign-in](./security.md#two-step-sign-in) → Recovery).
    There are two ways without the operator, and they come first: the
    person asks at the sign-in's code step (**Lost your phone and your
    recovery codes?**: an emailed link, then a 3-day wait with a cancel
    link in every email), or, in a team, a team admin removes it at once
    from the team's member list (for a member below admin only: an admin's
    factor is never reset by another admin). Use this only when neither
    can: the person can't reach the account's inbox and has no team admin
    (or is a team admin), or can't wait three days and has no team admin. A
    reset link alone would be a way round the second factor for anyone who
    holds the inbox, which is why the self-service path waits; this path
    has no wait, so identity is checked by hand. Confirm who is asking out
    of band (a call to a number the WUA or consultancy has on file, not one
    in the request), then, as the schema owner, in one transaction:
    `SELECT mfa_remove_factors('…', now()); INSERT INTO account_security_event (user_id, kind) VALUES ('…', 'mfa.reset_by_operator');`
    (`mfa_remove_factors`, 205 and 206, removes every second factor of the
    account, the authenticator and codes by email alike, with the recovery
    codes and any live emailed code, ends a waiting reset, and moves the
    session watermark, which signs out every session, a thief's included;
    the event is in the person's own security log and data export). They
    sign in with the password and set up a factor again on the Account
    page; where their roles need it, they need it before those actions
    again. If the password may be known to someone else too, have them
    reset it first. Record the request and how identity was checked in the
    operator log.
15. **`APP_ENCRYPTION_KEY` leaked, or must change** (operator). The key seals
    every TOTP secret; a new one can't open the old rows. Edit `app_encryption_key` with sops and apply
    (§ Rotating a secret), then, as the schema owner, take the
    authenticators off through the one removal, which keeps everyone's
    codes by email and their recovery codes while that factor stays on:
    `SELECT mfa_remove_factor(user_id, 'totp', now()) FROM user_totp;`
    (`mfa_remove_factor`, 205 and 206: with no other factor left it removes
    the recovery codes too, and either way it signs the account out) and
    tell every person who had an authenticator to set it up again
    (the actions that need it, always or where a project or team requires
    it, are refused until they have). Their security log keeps the history. Codes by email (206) need
    nothing: only a code sent in the last 10 minutes stops matching (the
    HMAC key comes from the same setting), and the next one is sent under the
    new key.
16. **A licence record past its closing date** (operator; the "This licence
    record can now be deleted" email, or a review that went unanswered;
    [evidence-pack.md § Retention](./evidence-pack.md#retention)). Nothing
    is deleted without the organisation's written confirmation: ask the
    project's owners whether it still needs the record (a renewed licence is
    a later outcome they record; an unanswered review stays as it is). On a
    written yes, as the schema owner: note the project's evidence pack
    objects (`SELECT pdf_key, bundle_key FROM evidence_pack WHERE project_id
    = '…'`), delete the project in one transaction with its two evidence
    guards disabled for it (`ALTER TABLE project DISABLE TRIGGER
    project_evidence_guard, DISABLE TRIGGER project_pack_guard; DELETE FROM
    project WHERE id = '…'; ALTER TABLE project ENABLE TRIGGER
    project_evidence_guard, ENABLE TRIGGER project_pack_guard;`), then delete
    every version of each pack object from the packs bucket with
    `s3:BypassGovernanceRetention` (`aws s3api delete-object --bucket …
    --key … --version-id … --bypass-governance-retention`, for each version
    `list-object-versions` shows). A project of a team that keeps public
    records (`team.public_records`) also needs the client's confirmation
    that it holds its records or has a disposal authority, recorded as
    `team.records_disposal_confirmed_on` (operator agreement 3A.2). Record
    the confirmation, the date and what was deleted in the operator log.
17. **The responsible authority confirms who acts for it** (operator;
    229_authority_delegates, issue #523 G5; [security.md § Authorization](./security.md#authorization-per-project-roles-enforced-by-postgres-rls)). Who acts for a project's responsible
    authority is the authority's call, not the host's: in the app an owner
    only proposes someone, and only a member already acting for the
    authority confirms them. A project with nobody confirmed yet (a new
    licensing project, or after the last delegate left) needs the operator
    for the first. Act only on the authority's **written** request (a letter
    or email from the CMA or the DWS regional office, on its letterhead or
    from its domain, naming the project and the person), never on the
    host's word; confirm it with the authority out of band (a number it
    publishes, not one in the request). The person must already be an
    editor or owner of the project, directly or through its team (the host
    adds them). Then, as the schema owner:
    `SELECT authority_confirm_by_operator('<project id>', (SELECT id FROM app_user WHERE email = '<address>'), '<the letter''s reference and date>');`
    It confirms their proposal or adds them confirmed, and refuses someone
    who isn't an editor (`23514`) or an empty reference; the project's
    History shows `authority.confirmed` by "Operator" with the reference.
    From then on the authority confirms (and removes) its own delegates in
    the app. To remove someone at the authority's request when none of its
    delegates can (as the schema owner): `DELETE FROM authority_delegate
    WHERE project_id = '…' AND user_id = '…';` (logged as
    `authority.removed`). Locally the same is `pnpm dev:authority:confirm
    <project-id> <email> --reference "<letter>"`. Record the request, how
    it was checked and the outcome in the operator log.
18. **Each authority reviews the delegates 229 grandfathered** (operator,
    once, after the deploy that runs 229; issue #523 G5). 229 carried every
    "acts for the authority" flag an owner had set (on someone still an
    editor or above) over as a **confirmed** delegate, so no decision in
    progress stopped, but the host chose those people, not the authority.
    List them per project with the read-only check
    `authority-grandfathered` ([§ Read-only production
    checks](#read-only-production-checks)):
    `aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"authority-grandfathered"}' --cli-read-timeout 300 --region af-south-1 --profile water-management authority-grandfathered.json && jq . authority-grandfathered.json`
    It answers with project and user ids only; find each person in that
    project's members list in the app (each project's History shows the
    same `authority.grandfathered` events, naming the owner who ticked the
    flag). Send each project's
    responsible authority its list in writing and ask it to confirm each
    person or remove them: a delegate removes anyone in the app
    (Responsible authority › Acts for the authority), or, at its written
    request, the operator does as in step 17 (`DELETE FROM
    authority_delegate …`, logged as `authority.removed`). Remove anyone
    the authority doesn't recognise; until it answers, the grandfathered
    delegates keep acting. Record what was sent, the answers and the
    removals in the operator log.
19. **List the projects whose series pick moves** (operator, straight
    after the backend release that orders series picks by byte, issue
    #523; data-model.md § Which series a run reads). Production sorted
    names linguistically until then, so a project whose series of one kind
    (at one site) differ in case or punctuation order runs on another
    series once it deploys. The answer depends only on series names, so
    the read-only check `series-pick-moves` ([§ Read-only production
    checks](#read-only-production-checks)), which ships in that release,
    can run straight after the deploy:
    `aws lambda invoke --function-name water-management-migrate --cli-binary-format raw-in-base64-out --payload '{"check":"series-pick-moves"}' --cli-read-timeout 300 --region af-south-1 --profile water-management series-pick-moves.json && jq . series-pick-moves.json`
    Then, for each row, tell the project's owner which series its runs now
    read (the first of `will`; before, the first of `was`); rename a
    series (so the one they mean sorts first) if they want the old pick.
    Record the list in the operator log.

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
   `revoked_at` on the share link or API key; delete the invite). Only then
   let traffic back (run step 5's apply again; it restores the concurrency),
   and at once invoke the worker once (`aws lambda invoke --function-name
   water-management-worker …`, the production `pnpm dev:jobs:tick`; at
   reserved concurrency 0 it would be throttled, hence after the apply) so
   the time-based purges catch up: lapsed invites, deleted notes' text,
   alert deliveries, pack notices. None of those is served by the API, so
   the minutes between are harmless. Record each re-applied erasure in the
   operator log.

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

CloudFront, S3, Lambda and SES sending are cents. WAF is $10/month (the ACL
and its five rules). The DB is the main cost: RDS t4g.micro and its 20 GiB
at ~$14/month in us-east-1, ~$18 in af-south-1. The VPC Lambdas' four
interface endpoints (Secrets Manager, SES API, SQS, S3) cost $7.30/month each
per AZ in us-east-1 ($9.56 in af-south-1), which is still cheaper than a NAT
(~$33/month plus data); the data feeds' fetcher and the report renderer run
outside the VPC for the same reason. The shared CHIRPS cell cache
(`chirps_cell_year`, 208) grows with the cells feeds use, about 1.5 KB per
cell-year: a 100-cell project over 1981–2026 is about 7 MB, and the 20 GiB
volume holds thousands of such projects; a project over cells another
already read adds nothing and downloads nothing. The database's customer-managed KMS key
(§ Decide before the first apply) adds $1–3. Total ≈ $77/month in
af-south-1, ≈ $63 in us-east-1; the breakdown is in
[deployment-tiers.md](./deployment-tiers.md) and
[infra/README.md § Cost](../infra/README.md#cost). CloudFront and WAF
request charges have no ceiling, and nor does egress (the map's tiles are
the large objects); the `cloudfront-requests` and `cloudfront-bytes` alarms
(us-east-1) fire within 5 minutes of a flood or a pull, long before the budgets' billing data
catches up (§ Runbooks, Request flood). The minimal (defaults)
and full (Multi-AZ, highly available) configurations, their tfvars and
monthly cost are compared in [deployment-tiers.md](./deployment-tiers.md).

### Budget alerts

Terraform creates two budgets and, once it is turned on, a Cost Anomaly
Detection monitor (`alarms.tf`, all free), mailed through the **us-east-1**
alerts topic to `budget_alert_email`:

- **Daily budget, ACTUAL 100%** (`budget_daily_usd`, default
  `ceil(budget_monthly_usd × 2.25 / 30)` = $9/day on $110, about 3.5× the
  ~$2.55/day af-south-1 idle): a single day cost more than that. This is the
  one that works in the **first month**, when the monthly forecast has no
  history. Daily budgets support ACTUAL notifications only.
- **Monthly, ACTUAL 80%** ($88 on the default $110, above the
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
what grew. `budget_monthly_usd` defaults to 110 (af-south-1; ~85 is enough
in us-east-1, ~220 on the full tier, ~180 for it in us-east-1). Before billing access is enabled, set
it to 0 ([infra/README.md § Operator
steps](../infra/README.md#operator-steps), step 4).
