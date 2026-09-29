variable "aws_region" {
  description = <<-EOT
    Primary AWS region for the VPC, RDS, the Lambdas and the frontend bucket.
    No default on purpose: af-south-1 (Cape Town) is the likely choice for a
    South African client (POPIA, latency) but it is an opt-in region that must
    be enabled on the account first; us-east-1 is the cheaper fallback. See
    infra/README.md § Region. The CloudFront certificate, WAF and CloudFront
    alarm are always in us-east-1 regardless.

    The privacy notice (frontend/src/routes/privacy, §6) tells users their
    data is stored in South Africa, so any other region is refused unless
    data_outside_south_africa is set, which must only happen together with
    rewriting that section (and the client's agreement: POPIA s72).
  EOT
  type        = string

  validation {
    condition     = var.aws_region == "af-south-1" || var.data_outside_south_africa
    error_message = "The privacy notice says data is stored in South Africa (af-south-1). To deploy elsewhere, change the notice's §6 first, then set data_outside_south_africa = true."
  }
}

variable "data_outside_south_africa" {
  description = "Deliberately host outside af-south-1 (Cape Town). Only with the privacy notice's §6 rewritten to say where data is stored, and the client's agreement (POPIA s72). docs/legal-status.md."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Site hostname — the delegated child zone the bootstrap created, e.g. water-management.jaredhoward.com. No www alias is created."
  type        = string
  default     = "water-management.jaredhoward.com"
}

variable "route53_zone_id" {
  description = <<-EOT
    ID of the Route 53 child zone for var.domain_name, created by the estate
    bootstrap (create_subdomain = true). Terraform adds records to it but never
    creates or destroys it. Look it up with:
    aws route53 list-hosted-zones-by-name --dns-name water-management.jaredhoward.com --profile water-management
  EOT
  type        = string
}

variable "github_repo" {
  description = "GitHub repository in 'owner/name' form. Used as a tag."
  type        = string
}

variable "bootstrap_slug" {
  description = <<-EOT
    Project slug used by the cross-project bootstrap when creating the OIDC
    deploy role. The lookup in oidc.tf reads `$${var.bootstrap_slug}-deploy`,
    so this MUST match the slug new-project-account.sh was run with. Mismatch
    surfaces as a plan-time "role not found" error.
  EOT
  type        = string
  default     = "water-management"
}

# --- Runtime secrets (secrets.tf) --------------------------------------------
#
# Ephemeral: Terraform keeps them out of state and out of a saved plan. They
# come from infra-secrets/water-management/prod.sops.yaml through
# infra/scripts/tf.sh (sops exec-env → TF_VAR_*), never from a tfvars file,
# and reach only the runtime secrets' write-only values. Each validation
# names the sops key, never the value.

variable "auth_jwt_secret" {
  description = "Signs the wm_session JWT (HS256). sops key auth_jwt_secret; generate with openssl rand -hex 32."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = length(var.auth_jwt_secret) >= 32
    error_message = "auth_jwt_secret in prod.sops.yaml must be at least 32 characters (the backend refuses shorter). Generate with: openssl rand -hex 32"
  }
  validation {
    # The committed dev/test values (backend/.env.development, src/__tests__/setup.ts)
    # are public; the API Lambda refuses them at init too (config/production.ts).
    condition     = !can(regex("^(dev|test)-only-", var.auth_jwt_secret))
    error_message = "auth_jwt_secret in prod.sops.yaml is a committed dev/test placeholder. Generate a real one with: openssl rand -hex 32"
  }
}

variable "db_app_password" {
  description = "Password of the RLS-bound runtime role water_app. sops key db_app_password; generate with openssl rand -hex 24."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = can(regex("^[A-Za-z0-9]{24,}$", var.db_app_password))
    error_message = "db_app_password in prod.sops.yaml must be 24+ alphanumeric characters (it is embedded in DATABASE_URL and role DDL). Generate with: openssl rand -hex 24"
  }
}

variable "alerts_token_secret" {
  description = "Signs the one-click unsubscribe links in alert emails (the worker only). sops key alerts_token_secret; generate with openssl rand -hex 32."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = can(regex("^[A-Za-z0-9]{32,}$", var.alerts_token_secret))
    error_message = "alerts_token_secret in prod.sops.yaml must be 32+ alphanumeric characters (the worker refuses shorter). Generate with: openssl rand -hex 32"
  }
}

variable "cloudfront_private_key" {
  description = "Signs report download links (CloudFront signed URLs, reports.tf): an RSA 2048 private key, PEM. sops key cloudfront_private_key; generate with openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 (infra/prod.sops.yaml.example). Its public half is report_download_public_keys[report_download_signing_key]; the API refuses to start if they aren't a pair."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    # The shape only: whether it pairs with the signing public key is checked
    # by the API at cold start (reports.tf).
    condition     = can(regex("^-----BEGIN (RSA )?PRIVATE KEY-----\\n[A-Za-z0-9+/=\\n]+\\n-----END (RSA )?PRIVATE KEY-----$", trimspace(var.cloudfront_private_key)))
    error_message = "cloudfront_private_key in prod.sops.yaml must be a PEM private key. Generate with: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048"
  }
}

variable "runtime_secret_version" {
  description = "Version of the runtime secrets' write-only values (secrets.tf). Terraform never reads a write-only value back, so it cannot see that a sops value changed; any change to this number writes every runtime secret again and cold-starts the API, worker and migrate Lambdas. Don't set it in a tfvars file: scripts/tf.sh derives it from prod.sops.yaml's sops.lastmodified (YYYYMMDDhhmmss), so every sops edit rotates, and refuses a var file that pins it. Pass -var runtime_secret_version=… only to force a rewrite of unchanged values (docs/deployment.md § Rotating a secret)."
  type        = number
  default     = 1
  validation {
    # Up to 16 digits: YYYYMMDDhhmmss is 14, and the AWS provider holds
    # secret_string_wo_version as a 64-bit int (its 64-bit builds are the only
    # platforms in .terraform.lock.hcl).
    condition     = var.runtime_secret_version >= 1 && var.runtime_secret_version < 1e16 && floor(var.runtime_secret_version) == var.runtime_secret_version
    error_message = "runtime_secret_version is a whole number from 1 to 16 digits (scripts/tf.sh sets it from sops.lastmodified as YYYYMMDDhhmmss)."
  }
}

# --- Network -----------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the private-only VPC. Two /24 private subnets are carved from it."
  type        = string
  default     = "10.60.0.0/16"
}

# --- Database ----------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro (2 vCPU burstable, 1 GiB) is ample for a handful of concurrent users."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  description = "Initial gp3 storage in GiB (20 is the gp3 minimum)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling in GiB. Bounds the worst-case storage bill."
  type        = number
  default     = 50
}

variable "db_backup_retention_days" {
  description = "Automated backup + point-in-time-recovery window in days."
  type        = number
  default     = 7
  validation {
    condition     = var.db_backup_retention_days >= 7 && var.db_backup_retention_days <= 35
    error_message = "Keep at least 7 days of backups (max 35)."
  }
}

variable "db_multi_az" {
  description = "Multi-AZ standby. Off by default: it doubles the instance cost, and a low-traffic client tool can tolerate the ~10-minute single-AZ recovery."
  type        = bool
  default     = false
}

variable "rds_customer_managed_key" {
  description = "Encrypt the database, its backups and snapshots with a customer-managed KMS key (kms.tf) instead of the AWS-managed aws/rds key. Decide before the first apply: flipping it on a live stack forces a new DB instance, which prevent_destroy refuses. On by default: ~$1-3/month, and only a CMK allows cross-account snapshot sharing and AWS Backup cross-account copies (docs/deployment.md § Decide before the first apply)."
  type        = bool
  default     = true
}

variable "db_log_retention_days" {
  description = "CloudWatch retention for the exported PostgreSQL logs."
  type        = number
  default     = 30
}

variable "secretsmanager_endpoint_az_count" {
  description = "How many AZs get an ENI for the Secrets Manager interface endpoint (used only by the migrate Lambda). 1 halves the cost; the endpoint is reachable from both subnets either way, it just loses AZ redundancy for deploys."
  type        = number
  default     = 1
  validation {
    condition     = var.secretsmanager_endpoint_az_count >= 1 && var.secretsmanager_endpoint_az_count <= 2
    error_message = "Must be 1 or 2."
  }
}

# --- Edge + cost controls ----------------------------------------------------

variable "waf_rate_limit_per_ip" {
  description = "WAF rate limit on /api/*: requests per IP per 5-minute rolling window. AWS minimum is 100."
  type        = number
  default     = 1000
  validation {
    condition     = var.waf_rate_limit_per_ip >= 100
    error_message = "AWS WAF rate-based rule minimum is 100 per 5-minute window."
  }
}

# The static site's backstop (waf.tf): every path, so the SPA's cached files
# (a cold visit is ~150 requests; the report renderer loads them for every
# PDF) don't count against the API's limit, yet one IP can't pull them
# unthrottled. The default blocks one IP at the cloudfront-requests alarm's
# default threshold.
variable "waf_site_rate_limit_per_ip" {
  description = "WAF rate limit on every path (the static site's backstop): requests per IP per 5-minute rolling window. At least waf_rate_limit_per_ip, since /api/* requests count here too."
  type        = number
  default     = 5000
  validation {
    condition     = var.waf_site_rate_limit_per_ip >= var.waf_rate_limit_per_ip
    error_message = "waf_site_rate_limit_per_ip counts /api/* requests too, so below waf_rate_limit_per_ip it would become the API's limit."
  }
}

# The request-flood alarm (alarms.tf cloudfront_requests). A flood that stays
# just under it goes unseen, so the ceiling is set by what that costs: every
# allowed request is billed by WAF ($0.60/M) and CloudFront ($1.00/M at
# US/EU edges, ~$2.20/M at Africa's), $1.60–2.80/M in all. At the 20,000
# ceiling that is 66.7 req/s = 5.76M/day = $9.22–16.13 a day unseen, 12–20%
# of the $80 budget a day; above it the alarm stops being a cost control.
# The 1,000 floor is one person at the WAF's per-IP limit, which must not
# page. The default's arithmetic is at the alarm in alarms.tf.
variable "cloudfront_requests_alarm_per_5min" {
  description = "Alarm when CloudFront serves more than this many requests in 5 minutes (the request-flood alarm, us-east-1). Default 5000: ~20x a busy 5 minutes for a handful of users, and a flood just under it costs $2.30-4.03/day unseen. Runbook: docs/deployment.md § Runbooks, Request flood."
  type        = number
  default     = 5000
  validation {
    condition     = var.cloudfront_requests_alarm_per_5min >= 1000 && var.cloudfront_requests_alarm_per_5min <= 20000
    error_message = "Between 1000 (one person at the WAF's per-IP limit would page) and 20000 (a flood just under it would cost ~$9-16/day unseen)."
  }
}

# --- Sign-in CAPTCHA (waf.tf SignInCaptchaPerIP) ------------------------------

variable "waf_signin_captcha_per_5min" {
  description = "Sign-in POSTs (POST /api/auth/login) from one IP in 5 minutes above which the WAF answers with a CAPTCHA instead of passing the request on. Default 20: a person signing in makes 1-5, an office behind one NAT a handful more; a guesser past it must solve a puzzle every captcha immunity period. Must stay below the auth block rule's 100, or the CAPTCHA never shows before the block."
  type        = number
  default     = 20
  validation {
    condition     = var.waf_signin_captcha_per_5min >= 10 && var.waf_signin_captcha_per_5min <= 99
    error_message = "Between 10 (AWS's minimum for a rate-based rule) and 99 (below RateLimitAuthPerIP's 100, which blocks outright)."
  }
}

variable "waf_signin_captcha_action" {
  description = "What the sign-in CAPTCHA rule does past its threshold: CAPTCHA (the puzzle), or COUNT (only counts, in the WAF metrics and sampled requests: the switch-off if the puzzle misfires; docs/deployment.md § Runbooks)."
  type        = string
  default     = "CAPTCHA"
  validation {
    condition     = contains(["CAPTCHA", "COUNT"], var.waf_signin_captcha_action)
    error_message = "CAPTCHA or COUNT."
  }
}

variable "waf_captcha_integration_url" {
  description = "This account's AWS WAF CAPTCHA integration URL for CloudFront scope (https://<id>.edge.captcha-sdk.awswaf.com/<id>/). Not a secret: read it once with `aws wafv2 list-api-keys --scope CLOUDFRONT --region us-east-1 --query ApplicationIntegrationURL --output text`. The site's CSP allows exactly its origin and its challenge script's (<id>.edge.sdk.awswaf.com), and the frontend loads jsapi.js from it. Empty (the default): the CSP allows no WAF origin and the sign-in page says to wait instead of showing the puzzle."
  type        = string
  default     = ""
  validation {
    condition     = var.waf_captcha_integration_url == "" || can(regex("^https://[a-z0-9]+\\.[a-z0-9-]+\\.captcha-sdk\\.awswaf\\.com/[a-z0-9]+/$", var.waf_captcha_integration_url))
    error_message = "Empty, or https://<id>.<edge|region>.captcha-sdk.awswaf.com/<id>/ exactly as list-api-keys prints it (with the trailing slash)."
  }
}

variable "login_failed_alarm_per_15min" {
  description = "Alarm when more than this many credential checks fail in 15 minutes across all accounts (the login-failed alarm: one password sprayed over many accounts, which each address's own lockout can't see). Default 30: a person locking themselves out logs 5-10, so 30 is several at once for a handful of users. Runbook: docs/deployment.md § Runbooks, Credential stuffing."
  type        = number
  default     = 30
  validation {
    condition     = var.login_failed_alarm_per_15min >= 10 && var.login_failed_alarm_per_15min <= 300
    error_message = "Between 10 (one person locking themselves out would page) and 300 (one IP at the WAF's auth limit, 100 per 5 minutes, would stay unseen)."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly AWS spend ceiling in USD. Notifications (to the us-east-1 alerts topic): ACTUAL 80%, ACTUAL 100% and FORECASTED 100%. The default 80 sits above af-south-1's ~$58–63 idle (infra/README.md § Cost), so ACTUAL 80% ($64) doesn't fire at idle; ~60 fits us-east-1 (~$49 idle), ~170 the full tier (docs/deployment-tiers.md). Set to 0 to skip both budgets until billing access is enabled (NOT for prod)."
  type        = number
  default     = 80

  validation {
    condition     = var.budget_monthly_usd >= 0
    error_message = "budget_monthly_usd must be 0 (no budgets) or a positive USD amount."
  }
}

# The daily budget is the first-month guard: the monthly FORECASTED alert needs
# ~5 weeks of history, and daily budgets support ACTUAL notifications only.
variable "budget_daily_usd" {
  description = "Daily AWS spend ceiling in USD (ACTUAL 100% → the us-east-1 alerts topic, at most one mail a day). null (default) derives it from the monthly: ceil(budget_monthly_usd × 2.25 / 30), i.e. $6 on $80, ~3× af-south-1's ~$2/day idle. 0 skips only the daily budget. Must be below budget_monthly_usd."
  type        = number
  default     = null

  validation {
    condition = var.budget_daily_usd == null ? true : (
      var.budget_daily_usd == 0 || (var.budget_daily_usd > 0 && var.budget_daily_usd < var.budget_monthly_usd)
    )
    error_message = "budget_daily_usd must be null (derived from the monthly), 0 (no daily budget), or a positive amount below budget_monthly_usd (a daily ceiling at or above the month's can never be the first to fire; with budget_monthly_usd = 0 there are no budgets at all)."
  }
}

variable "cost_anomaly_threshold_usd" {
  description = "Cost Anomaly Detection (free): an AWS-services monitor whose anomalies with a total cost impact of at least this many USD page the us-east-1 alerts topic. Default 0 (off): an account may hold only one services monitor and AWS may have created one, which would fail the first apply, and the monitor needs ~10 days of history anyway. Turn it on after the first apply (10 is a sensible value; infra/README.md § Operator steps, step 11)."
  type        = number
  default     = 0

  validation {
    condition     = var.cost_anomaly_threshold_usd >= 0
    error_message = "cost_anomaly_threshold_usd must be 0 (no anomaly monitor) or a positive USD amount."
  }
}

# The alert and report mailboxes are checked the same way: a plausible address
# shape, and not at a name RFC 2606 / RFC 6761 reserve (example.com/.org/.net
# and their subdomains, and the .example, .test, .invalid and .localhost
# TLDs), matched case-insensitively. None of those can receive mail, so a
# tfvars copied from terraform.tfvars.example unedited would page nobody.
variable "budget_alert_email" {
  description = "Email address that receives SNS budget + alarm notifications (both SNS topics). Required: without it an alarm or budget breach pages nobody. Must be a real mailbox, not a reserved example address."
  type        = string

  validation {
    condition = (
      can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s.]+$", var.budget_alert_email)) &&
      !can(regex("(?i)(@([^@]+\\.)?example\\.(com|org|net)|\\.(example|test|invalid|localhost))$", var.budget_alert_email))
    )
    error_message = "budget_alert_email must be a real mailbox (name@domain.tld), not empty and not at a reserved domain (example.com/.org/.net, .example, .test, .invalid, .localhost)."
  }
}

# --- Lambda ------------------------------------------------------------------

variable "lambda_log_retention_days" {
  description = "CloudWatch log retention for both Lambdas."
  type        = number
  default     = 30
}

variable "lambda_memory_mb" {
  description = "API Lambda memory. Model runs over a multi-decade daily record are CPU-bound, and Lambda CPU scales with memory; 1024 MB is the sweet spot for cost vs run latency."
  type        = number
  default     = 1024
}

variable "lambda_timeout_seconds" {
  description = "API Lambda timeout. Must stay below the CloudFront origin read timeout (35 s, s3_cloudfront.tf)."
  type        = number
  default     = 30
  validation {
    condition     = var.lambda_timeout_seconds <= 34
    error_message = "Keep the Lambda timeout below the 35 s CloudFront origin read timeout."
  }
}

variable "lambda_reserved_concurrency" {
  description = <<-EOT
    Max concurrent API Lambda executions. Bounds worst-case spend during an
    attack AND the number of DB connections (each container holds a pg pool of
    up to 5; 10 x 5 = 50 stays under db.t4g.micro's ~80 max_connections).
    AWS keeps >= 10 executions unreserved, so the account's Lambda
    concurrent-executions quota must cover the sum of every reservation + 10
    before the first apply (a new account's quota is 10, which rejects any
    reservation): infra/README.md § Operator steps. Never -1 (unreserved):
    that removes the cap on spend and on DB connections.
  EOT
  type        = number
  default     = 10
  validation {
    condition     = var.lambda_reserved_concurrency >= 1
    error_message = "Must be at least 1: -1 (unreserved) removes the spend and DB-connection cap. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

variable "migrate_reserved_concurrency" {
  description = "Reserved concurrency for the migrate Lambda. 1 serialises migrators (on top of the advisory lock in migrate.ts). Never -1: raise the account quota instead (lambda_reserved_concurrency)."
  type        = number
  default     = 1
  validation {
    condition     = var.migrate_reserved_concurrency >= 1
    error_message = "Must be at least 1: -1 (unreserved) lets migrators run in parallel. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

# --- Background jobs (jobs.tf) -------------------------------------------------

variable "worker_memory_mb" {
  description = "Worker Lambda memory. A queued re-run is the same engine run the API does, so the same 1024 MB."
  type        = number
  default     = 1024
}

variable "worker_reserved_concurrency" {
  description = <<-EOT
    Max concurrent worker Lambda executions: bounds spend, DB connections
    (x a pool of 2) and parallel jobs. Four SQS queues trigger the worker (jobs,
    ingest-results, render-results, mail-events), each at maximum_concurrency 2,
    the least an SQS event source allows. AWS needs reserved concurrency >= the
    sum of those (8), or the pollers are throttled and throttled messages burn
    receive counts into the DLQs. 8 x a pool of 2 = 16 connections (infra/README.md
    § Connections). Never -1: raise the account quota instead.
  EOT
  type        = number
  default     = 8
  validation {
    condition     = var.worker_reserved_concurrency >= 8
    error_message = "Must be at least 8, the sum of the worker's four SQS triggers' maximum_concurrency (4 x 2); -1 (unreserved) is refused too. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

variable "sqs_endpoint_az_count" {
  description = "How many AZs get an ENI for the SQS interface endpoint (job wake-ups from the API, the worker's queue). 1 halves the cost; both subnets still reach it."
  type        = number
  default     = 1
  validation {
    condition     = var.sqs_endpoint_az_count >= 1 && var.sqs_endpoint_az_count <= 2
    error_message = "Must be 1 or 2."
  }
}

variable "fetcher_reserved_concurrency" {
  description = "Max concurrent fetcher Lambda executions (data feeds, feeds.tf): bounds spend and how hard the public sources are hit at once. At least 2, its SQS trigger's maximum_concurrency. Never -1: raise the account quota instead (lambda_reserved_concurrency)."
  type        = number
  default     = 2
  validation {
    condition     = var.fetcher_reserved_concurrency >= 2
    error_message = "Must be at least 2, its SQS trigger's maximum_concurrency; -1 (unreserved) is refused too. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

# --- Server-side reports (reports.tf) --------------------------------------------

variable "renderer_image_tag" {
  description = "Tag of the renderer image in its ECR repository that the renderer Lambda is created from: <release version>-<first 12 hex of its commit>, e.g. 0.4.0-0123456789ab, as deploy-backend.yml pushes it and prints it. Empty (the default) creates the bucket, queues and repository but not the function, because Lambda can't be created before its image exists: push one with deploy-backend.yml first (docs/deployment.md § Reports). Later releases move the function's image themselves; this is the image a (re-)created function starts from, and the ECR lifecycle policy never expires it (reports.tf)."
  type        = string
  default     = ""
  validation {
    condition     = var.renderer_image_tag == "" || can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+-[0-9a-f]{12}$", var.renderer_image_tag))
    error_message = "renderer_image_tag must be empty or the tag deploy-backend.yml pushed, <version>-<12 hex of the commit>, like 0.4.0-0123456789ab."
  }
}

variable "report_download_public_keys" {
  description = "The CloudFront public keys trusted to sign report downloads, name -> PEM (openssl pkey -in <key> -pubout). Not secret. Usually one; two while a rotation overlaps (docs/deployment.md § Rotating a secret)."
  type        = map(string)
  validation {
    condition     = length(var.report_download_public_keys) >= 1 && length(var.report_download_public_keys) <= 5
    error_message = "report_download_public_keys needs 1 to 5 keys (a CloudFront key group holds at most 5)."
  }
  validation {
    condition     = alltrue([for k in keys(var.report_download_public_keys) : can(regex("^[a-z0-9][a-z0-9-]{0,40}$", k))])
    error_message = "report_download_public_keys names must be lowercase letters, digits and dashes (e.g. 2026-09)."
  }
  validation {
    condition     = alltrue([for v in values(var.report_download_public_keys) : can(regex("^-----BEGIN PUBLIC KEY-----\\n[A-Za-z0-9+/=\\n]+\\n-----END PUBLIC KEY-----$", trimspace(v)))])
    error_message = "Each report_download_public_keys value must be a PEM public key (-----BEGIN PUBLIC KEY-----), never a private key."
  }
}

variable "report_download_signing_key" {
  description = "Which report_download_public_keys entry the API signs with: the public half of cloudfront_private_key in prod.sops.yaml."
  type        = string
  validation {
    condition     = contains(keys(var.report_download_public_keys), var.report_download_signing_key)
    error_message = "report_download_signing_key must name an entry of report_download_public_keys."
  }
}

variable "renderer_memory_mb" {
  description = "Renderer Lambda memory. Headless Chromium printing the report needs ~1 GB; 2048 MB also buys the CPU that keeps a render to seconds."
  type        = number
  default     = 2048
  validation {
    condition     = var.renderer_memory_mb >= 1536 && var.renderer_memory_mb <= 10240
    error_message = "At least 1536 MB (Chromium), at most Lambda's 10240."
  }
}

variable "renderer_reserved_concurrency" {
  description = "Max concurrent renderer Lambda executions: bounds spend and how many Chromiums load the site at once. At least 2, its SQS trigger's maximum_concurrency. Never -1: raise the account quota instead (lambda_reserved_concurrency)."
  type        = number
  default     = 2
  validation {
    condition     = var.renderer_reserved_concurrency >= 2
    error_message = "Must be at least 2, its SQS trigger's maximum_concurrency; -1 (unreserved) is refused too. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

variable "jobs_backlog_alarm_seconds" {
  description = "Alarm when the oldest due job has waited this long. The schedule ticks every 5 minutes, so anything under ~10 minutes would fire on a normal wait."
  type        = number
  default     = 900
  validation {
    condition     = var.jobs_backlog_alarm_seconds >= 600
    error_message = "At least 600 s (two 5-minute ticks), or the alarm fires on normal operation."
  }
}

# --- Alert emails (jobs.tf, WP-2.13) -------------------------------------------

variable "alerts_enabled" {
  description = "The alert-email kill switch (ALERTS_ENABLED on the worker). false: alerts are still evaluated and shown in the app, but no alert email is sent and waiting ones are dropped. Runbook: docs/deployment.md § Runbooks, Alert storm."
  type        = bool
  default     = true
}

variable "alert_storm_mails_per_5min" {
  description = "Alarm when the worker sends more alert emails than this in 5 minutes (the alert-storm alarm)."
  type        = number
  default     = 200
  validation {
    condition     = var.alert_storm_mails_per_5min >= 10
    error_message = "At least 10, or a single publication to a large catchment fires it."
  }
}

# --- Email (SES, ses.tf) -----------------------------------------------------

variable "mail_from_local_part" {
  description = "Local part of the sender address. Mail goes out as <this>@var.domain_name, and the Lambda's IAM policy only allows that exact From address."
  type        = string
  default     = "no-reply"
}

variable "mail_from_display_name" {
  description = "Display name in the From header (MAIL_FROM)."
  type        = string
  default     = "Water Management"
}

variable "mail_from_subdomain" {
  description = "Custom MAIL FROM subdomain (<this>.var.domain_name). Carries the MX + SPF records so SPF aligns for DMARC."
  type        = string
  default     = "mail"
}

variable "dmarc_policy" {
  description = "DMARC p= policy for var.domain_name. Start at none, read the aggregate reports, then tighten to quarantine (docs/deployment.md § Email)."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_report_email" {
  description = "Mailbox for DMARC aggregate reports (rua=). Empty omits rua, which leaves the policy with no feedback — set it before tightening dmarc_policy. When set, the same rule as budget_alert_email applies."
  type        = string
  default     = ""

  validation {
    condition = var.dmarc_report_email == "" || (
      can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s.]+$", var.dmarc_report_email)) &&
      !can(regex("(?i)(@([^@]+\\.)?example\\.(com|org|net)|\\.(example|test|invalid|localhost))$", var.dmarc_report_email))
    )
    error_message = "dmarc_report_email must be empty (no rua) or a real mailbox (name@domain.tld), not at a reserved domain (example.com/.org/.net, .example, .test, .invalid, .localhost)."
  }
}

variable "ses_tls_policy" {
  description = "SES delivery TLS policy. REQUIRE (default) refuses to deliver to a receiving server without STARTTLS, because every email carries a live token; OPTIONAL delivers in the clear if it must."
  type        = string
  default     = "REQUIRE"
  validation {
    condition     = contains(["REQUIRE", "OPTIONAL"], var.ses_tls_policy)
    error_message = "ses_tls_policy must be REQUIRE or OPTIONAL."
  }
}

variable "ses_endpoint_az_count" {
  description = "How many AZs get an ENI for the SES API interface endpoint. 1 halves the cost; if that AZ is down, sends fail but the API keeps answering (a mail failure never fails a request)."
  type        = number
  default     = 1
  validation {
    condition     = var.ses_endpoint_az_count >= 1 && var.ses_endpoint_az_count <= 2
    error_message = "Must be 1 or 2."
  }
}

# --- CloudFront --------------------------------------------------------------

variable "cloudfront_price_class" {
  description = "CloudFront price class. PriceClass_All is the only class with South African (and Kenyan, Nigerian, Egyptian, Middle East) edge locations: AWS's pay-as-you-go price-class table excludes them from 100 and 200, which would serve South African users from Europe or Asia."
  type        = string
  default     = "PriceClass_All"
  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "Must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}
