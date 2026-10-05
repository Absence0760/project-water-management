# Deployment tiers and monthly cost

> **Status:** production runs the **minimal** tier (deployed 2026-10-05). This page compares two ways to run the
> Terraform in `infra/`: a **minimal** production deployment and a **full**
> (highly available) one. Both use the same code and the same Terraform; only
> `terraform.tfvars` changes. The step-by-step procedure is in
> [deployment.md](./deployment.md), the line-item breakdown in
> [infra/README.md § Cost](../infra/README.md#cost).

Prices are AWS on-demand list prices from the AWS Price List API, checked
on 2026-10-04, before tax, for idle to light use (a handful of catchments,
tens of users). The fixed lines (RDS instance and storage, interface
endpoints, WAF, alarms, KMS, Secrets Manager, Route 53) are list price times
730 hours; the usage lines (SQS polling, logs, ECR, S3, Lambda) are
estimates, marked ~. Check them in the
[AWS Pricing Calculator](https://calculator.aws/) before you commit.

The rates that set the bill, per month:

| | us-east-1 | af-south-1 |
| --- | --- | --- |
| RDS `db.t4g.micro`, single-AZ / Multi-AZ | $11.68 / $23.36 | $15.33 / $29.93 |
| RDS `db.t4g.small`, single-AZ / Multi-AZ | $23.36 / $47.45 | $29.93 / $59.86 |
| RDS gp3, per GiB, single-AZ / Multi-AZ | $0.115 / $0.23 | $0.151 / $0.302 |
| Interface endpoint, per AZ | $7.30 | $9.56 |
| CloudWatch alarm (standard) | $0.10 | $0.10 |

## Summary

| | Minimal | Full |
| --- | --- | --- |
| **af-south-1** (the decided region) | **≈ $77 / month** | **≈ $166 / month** |
| **us-east-1** (only with `data_outside_south_africa`) | **≈ $63 / month** | **≈ $133 / month** |
| Features | All of them | All of them |
| Database | 1 instance, 1 AZ, `db.t4g.micro` | Multi-AZ standby, `db.t4g.small` |
| VPC interface endpoints (Secrets Manager, SES, SQS, S3) | 1 AZ each | 2 AZs each |
| Backups / PITR | 7 days | 14 days |
| Database failure | ~10 min recovery, by AWS, on a new host | ~1–2 min automatic failover |
| AZ outage | API down until the AZ recovers | API keeps serving |
| Suggested `budget_monthly_usd` (its ACTUAL 80% alert above the idle; daily budget derived: `ceil(× 2.25 / 30)`) | 110 (af-south-1, the default) / 85 (us-east-1): $9 / $7 a day | 220 (af-south-1) / 180 (us-east-1): $17 / $14 a day |

**Recommendation:** start on **minimal** in af-south-1. It is a complete,
secure production deployment, not a demo: every feature, WAF, private
database, encryption, backups and alarms. Move to full when the client
depends on the tool day to day (WUA operations, alert emails farmers act on)
and a ~10-minute outage is no longer acceptable. Moving is a tfvars change
and an apply; the Multi-AZ switch causes no downtime, the instance-class
change a few minutes' reboot (do it in a quiet window).

Why the tiers don't differ in features: the optional parts are cheap. The
data feeds add ≈ $1.00 a month ([deployment.md § Data
feeds](./deployment.md#data-feeds)) and server-side PDF reports ≈ $1.30–1.50
([deployment.md § Reports](./deployment.md#reports)), us-east-1. Almost the whole bill
is the database and the four VPC endpoints, which is where the tiers
differ.

## Minimal deployment

What you get: the whole target setup in
[deployment.md § Target setup](./deployment.md#target-setup), on the
Terraform defaults.

- CloudFront + WAF + S3 frontend, the API Lambda behind CloudFront, and the
  migrate Lambda the deploys and reference loads invoke.
- The private S3 buckets: report PDFs (7 days), issued evidence packs
  (Object Lock, 10 years), the map's tiles and the reference datasets.
- RDS PostgreSQL 17 `db.t4g.micro`, single-AZ, private subnets, encrypted,
  7-day backups with point-in-time recovery, deletion protection.
- Worker, fetcher and report-renderer Lambdas (the renderer once
  `renderer_image_tag` is set), the six SQS queues and their DLQs, the
  5-minute EventBridge tick.
- SES for account, alert and report email.
- One ENI each for the Secrets Manager, SES, SQS and S3 interface endpoints
  (`*_endpoint_az_count = 1`).
- Monthly and daily budgets, Cost Anomaly Detection (off until turned on
  after the first apply) and the CloudWatch alarms, mailed to `budget_alert_email` ([deployment.md § Budget
  alerts](./deployment.md#budget-alerts)).

`terraform.tfvars` (on top of the required values in
`infra/terraform.tfvars.example`):

```hcl
aws_region         = "af-south-1"
budget_monthly_usd = 110  # the default; 85 in us-east-1
# Everything else on defaults. Set renderer_image_tag after the first
# backend deploy (deployment.md § Reports).
```

Cost:

| Item | af-south-1 | us-east-1 |
| --- | --- | --- |
| RDS `db.t4g.micro` single-AZ | 15.33 | 11.70 |
| RDS gp3 storage, 20 GiB | 3.02 | 2.30 |
| 4 interface endpoints × 1 AZ (Secrets Manager, SES, SQS, S3; S3's also $0.01/GB processed for the DEM, water and reference reads) | 38.23 | 29.20 |
| WAF (ACL + 5 rules; billed globally) | 10.00 | 10.00 |
| CloudWatch: 44 alarms (41 until the renderer exists), logs, RDS log export | ~4.80 | ~4.30 |
| 2 KMS keys (sops; the database's, `rds_customer_managed_key`), Route 53 zone, 4 Secrets Manager secrets (the RDS master + 3 runtime secrets) | 4.10 | 4.10 |
| SQS polling by the six event sources (~2.9 M receives past the free tier), ECR image, S3 (incl. the tiles and reference buckets, ~$0.10), SES, Lambda (the migrate Lambda's 3008 MB is billed only while it migrates or loads), CloudFront | ~1.90 | ~1.60 |
| **Total** | **≈ $77** | **≈ $63** |

The line-by-line us-east-1 breakdown is
[infra/README.md § Cost](../infra/README.md#cost).

What you accept:

- **A database failure is an outage.** RDS replaces a failed single-AZ
  instance itself, typically in about 10 minutes; the site and API are down
  meanwhile. Data is safe (backups + point-in-time recovery).
- **An AZ outage takes the API down.** The database lives in one AZ. The
  endpoints each have one ENI: if that AZ fails, email sends and job
  wake-ups fail (the 5-minute tick still runs queued jobs), and a new API or
  worker instance can't start, since it reads its runtime secret through the
  Secrets Manager endpoint at cold start (warm instances carry on). The S3
  endpoint's calls fail too: issuing an evidence pack, delineation, tracing
  a dam and reference loads.
- **A `db.t4g.micro` has 1 GiB of RAM.** Ample for a few catchments and a
  handful of concurrent users; the `rds-cpu`, `rds-cpu-credits` and
  `rds-freeable-memory` alarms say when it isn't.

## Full deployment

Same stack, with the single points of failure removed and more headroom.

```hcl
aws_region         = "af-south-1"
budget_monthly_usd = 220  # 180 in us-east-1

db_instance_class        = "db.t4g.small"  # 2 GiB RAM
db_multi_az              = true            # synchronous standby in the 2nd AZ
db_backup_retention_days = 14

secretsmanager_endpoint_az_count = 2
ses_endpoint_az_count            = 2
sqs_endpoint_az_count            = 2
s3_endpoint_az_count             = 2
```

(`infra/tests/guardrails.tftest.hcl` run `full_tier` plans exactly this.)

Cost:

| Item | af-south-1 | us-east-1 |
| --- | --- | --- |
| RDS `db.t4g.small` Multi-AZ (730 h × $0.082 / $0.065) | 59.86 | 47.45 |
| RDS gp3 storage, 20 GiB, Multi-AZ | 6.04 | 4.60 |
| Backups beyond the free allowance (14 days) | ~1.20 | ~1.00 |
| 4 interface endpoints × 2 AZs | 76.45 | 58.40 |
| WAF (ACL + 5 rules + requests) | ~10.60 | ~10.60 |
| CloudWatch alarms, logs, RDS log export | ~5.00 | ~4.50 |
| 2 KMS keys (sops; the database's, `rds_customer_managed_key`), Route 53 zone, 4 Secrets Manager secrets (the RDS master + 3 runtime secrets) | 4.10 | 4.10 |
| SQS polling, ECR image, S3 (incl. the map tiles and reference buckets, ~$0.10), SES, Lambda, CloudFront | ~3.00 | ~2.50 |
| **Total** | **≈ $166** | **≈ $133** |

What it buys:

- Automatic database failover in 1–2 minutes, and patching with a short
  failover instead of a longer restart.
- The API, email and job wake-ups survive the loss of one AZ.
- Twice the database memory, for more catchments and concurrent model runs.
- Two weeks to notice and recover from bad data (PITR).

### Mixing and matching

Each upgrade is independent. Monthly deltas over minimal, us-east-1
(af-south-1 about +25–30%):

| Change | Delta | Buys |
| --- | --- | --- |
| `db_multi_az = true` (on micro) | +$14 | DB failover, AZ resilience for the data |
| `db_instance_class = "db.t4g.small"` (single-AZ) | +$11.70 | 2 GiB RAM |
| Both of the above | +$38 | |
| Each endpoint to 2 AZs (`secretsmanager_`, `ses_`, `sqs_`, `s3_endpoint_az_count`) | +$7.30 each (+$29.20 for all four) | Cold starts, email, job wake-ups, pack bundles, delineation and reference loads survive an AZ loss |
| `db_backup_retention_days = 14` | ~+$1 | Longer PITR window |
| `db_max_allocated_storage_gb` | Only billed when used ($0.115/GiB, ×2 Multi-AZ) | Headroom |

If you do only one: **`db_multi_az`**. The database is the only component
whose failure loses the whole app for minutes; everything else is either
serverless (multi-AZ already) or degrades gracefully.

Once the full tier has run stably for a few months, a 1-year RDS reserved
instance cuts the database line by roughly a third.

## What grows with use

The fixed baseline above dominates for a long time. Usage-driven costs at
current prices (us-east-1; free tiers apply first):

| Driver | Price | Example |
| --- | --- | --- |
| Model runs (API/worker Lambda, 1 GB arm64) | ~$0.000013 per GB-s | 10 000 runs × 2 s ≈ $0.27 (inside the always-free 400 000 GB-s) |
| Server-side PDF reports | ≈ $0.0002 each | 1 000 reports ≈ $0.20 |
| Email (SES) | $0.10 per 1 000 | 10 000 alert emails ≈ $1 |
| WAF requests | $0.60 per million | |
| CloudFront | Free up to 1 TB and 10 M requests a month | |
| Database storage past 20 GiB | $0.115 per GiB (×2 Multi-AZ), capped by `db_max_allocated_storage_gb` (50) | |

The first thing to outgrow is the database instance class, not Lambda or
bandwidth: watch the RDS CPU, memory and burst-credit alarms. The Lambda
reserved-concurrency caps (`lambda_reserved_concurrency` 10, worker 8,
migrate 1, fetcher 2, renderer 2; never `-1`, which the variables refuse) bound the worst case of an attack or a runaway job,
and the budgets page on a day over the daily amount, at 80% and 100% of the
month and on a forecast over 100% (after ~5 weeks of history), plus Cost
Anomaly Detection once it is turned on after the first apply
([deployment.md § Budget alerts](./deployment.md#budget-alerts)).

## Cheaper options, and why they aren't used

| Option | Saves | Why not |
| --- | --- | --- |
| Drop WAF | ~$10 | It is the API's rate limit and the brute-force guard on sign-in. |
| API Lambda outside the VPC, public RDS | ~$29–38 (no endpoints) | Puts the database on the internet behind only a password. Conflicts with [security.md](./security.md). |
| NAT gateway instead of endpoints | Costs *more* (~$33 + data) | The fetcher and renderer run outside the VPC so no NAT is needed. |
| Stop RDS when idle | Up to ~$12 | AWS restarts a stopped instance after 7 days; not a production pattern. |
| Region us-east-1 instead of af-south-1 | ~$14–33 depending on tier | Adds a POPIA cross-border transfer and ~200 ms to every API call ([deployment.md § Region](./deployment.md#region-recommendation)). |

### Alternatives if cost becomes a real objection

Neither is built; both are recorded so the decision isn't re-derived.

| Alternative | ≈ $/month (minimal) | Keeps data in SA | Tradeoff | Switch when |
| --- | --- | --- | --- | --- |
| **NAT instance** (e.g. a `t4g.nano`, plus its Elastic IP) instead of the 4 interface endpoints | ~$45–50 (af-south-1, estimated) | Yes | One more server to patch; email and job wake-ups stop if it dies until it's replaced | The client pushes back on the hosting fee |
| **Hosted Postgres** (Supabase / Neon paid plan, with backups) instead of RDS, no VPC | ~$40–45 (estimated: ~$20 of AWS plus the plan) | Only if the provider has a South African region | A new sub-processor holding client data (privacy notice, vendor review); the free tiers pause idle projects and have no backups, so never those | Data may leave SA *and* the client wants no servers at all |

This is why threkir's AWS bill is ~$3: its database is Supabase, outside
AWS, so it needs no VPC and no endpoints.

## Where the data lives

**Decision: host in af-south-1 (Cape Town) while the users are South
African.** This is not legal advice; confirm with counsel and the CISO
before go-live.

- **POPIA doesn't strictly require data to stay in South Africa.** Section
  72 allows a transfer abroad with adequate protection (for AWS, its DPA),
  consent or a contract ([deployment.md § Region](./deployment.md#region-recommendation)).
- **Government data can.** The National Data and Cloud Policy (Government
  Gazette 50741, 31 May 2024) requires government data that bears on
  national security and sovereignty to be stored only in South Africa; the
  draft's broader localisation of all critical-information-infrastructure
  data was dropped from the final policy
  ([ENS](https://www.ensafrica.com/news/detail/8715/south-africas-new-national-cloud-and-data-pol),
  [Bowmans](https://bowmanslaw.com/insights/south-africa-the-national-policy-on-data-and-cloud-some-highlights/)).
  Water-use licence evidence, or a DWS / CMA client, could bring data into
  that scope; ask when a government body becomes a user.
- Keeping everything in af-south-1 removes both questions, costs ~$14 a
  month more than us-east-1 on the minimal tier and cuts ~150 ms off every
  API call. Terraform holds the stack to af-south-1 unless
  `data_outside_south_africa = true`, which is only for a rewritten privacy
  notice (`variables.tf`, `aws_region`).

**Other countries later: one deployment per jurisdiction, not one global
database.** The Terraform already takes `aws_region`, and every project's
data is isolated by RLS, so a second country is a second stack in its own
region (its own database, domain or subdomain, SES identity and budget),
applied from the same code. That keeps each country's data under its own
law, with no cross-border replication to justify. Don't build multi-region
support before a second country is signed: each new jurisdiction needs its
own legal review (residency, privacy notice, sub-processors) anyway, and
the per-stack cost is the minimal tier's ~$63–77 a month, depending on the
region.

## Before choosing

- Plan question 15 (may the data leave South Africa?) is still open; the
  recommendation above assumes af-south-1 regardless, which puts both
  tiers about 22–25% above us-east-1.
- Loop in the CISO or Security Analyst on the tier choice if this deployment
  falls under the company's SOC 2 scope: availability commitments and backup
  retention are the Availability criteria's territory.
- Non-AWS costs: none today. The domain is already owned, and GitHub Actions
  is free for a public repository.
