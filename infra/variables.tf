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
  description = "Site hostname, the delegated child zone route53_zone_id names (icwbt.jaredhoward.com since issue #551; it was water-management.jaredhoward.com, now in redirect_domains). The site, the API, the sender address (no-reply@) and every emailed link use it. No www alias is created."
  type        = string
  default     = "icwbt.jaredhoward.com"
}

variable "route53_zone_id" {
  description = <<-EOT
    ID of the Route 53 child zone for var.domain_name, created outside
    Terraform and delegated from the jaredhoward.com parent zone (the estate
    bootstrap made the first one; docs/deployment.md § Moving the site to a new
    domain makes a later one). Terraform adds records to it but never creates
    or destroys it. Look it up with:
    aws route53 list-hosted-zones-by-name --dns-name icwbt.jaredhoward.com --profile water-management
  EOT
  type        = string
}

variable "redirect_domains" {
  description = <<-EOT
    Former site hostnames that answer with a 301 to the same path on
    var.domain_name, so old links and emails keep working: hostname → the ID
    of the Route 53 zone that holds it (the zone stays outside Terraform, as
    route53_zone_id does). Each is a CloudFront alias, on the certificate, with
    an A/AAAA alias record in its zone; pages redirect (spa_rewrite), while
    /api/*, /reports/*, /packs/* and /tiles/* keep answering there, so a mail
    client's one-click unsubscribe, a data logger pushing to /api/ingest and
    a signed download link minted before the move still work. Since issue
    #551: { "water-management.jaredhoward.com" = "<its zone ID>" }. Set {} to
    retire every old hostname (docs/deployment.md § Moving the site to a new
    domain). Required, so leaving an old hostname out is a decision.
  EOT
  type        = map(string)

  validation {
    condition     = !contains(keys(var.redirect_domains), var.domain_name)
    error_message = "redirect_domains must not include domain_name: the site can't redirect to itself."
  }
  validation {
    condition = alltrue([for host, zone in var.redirect_domains :
      can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", host)) && can(regex("^Z[A-Z0-9]{5,31}$", zone))
    ])
    error_message = "Each redirect_domains entry is a lowercase hostname (no scheme, path or trailing dot) mapped to a Route 53 hosted zone ID (Z…)."
  }
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

variable "app_encryption_key" {
  description = "Seals two-step sign-in's TOTP secrets at rest (AES-256-GCM under a key derived from it; backend/src/auth/secretBox.ts). The API only. sops key app_encryption_key; generate with openssl rand -hex 32. Rotating it voids every enrolled authenticator (docs/security.md § Two-step sign-in)."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = can(regex("^[A-Za-z0-9]{32,}$", var.app_encryption_key))
    error_message = "app_encryption_key in prod.sops.yaml must be 32+ alphanumeric characters (the API refuses shorter). Generate with: openssl rand -hex 32"
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
  description = "Automated backup + point-in-time-recovery window in days. Must stay below the erasure log's 40 days (backend/src/jobs/runner.ts ERASURE_LOG_RETENTION_DAYS, migration 159), so a restore can always re-apply the erasures made after its restore point; raising the 35-day cap means raising that too."
  type        = number
  default     = 7
  validation {
    condition     = var.db_backup_retention_days >= 7 && var.db_backup_retention_days <= 35
    error_message = "Keep at least 7 days of backups (max 35, below the erasure log's 40 days)."
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
  description = "How many AZs get an ENI for the Secrets Manager interface endpoint (the migrate Lambda's RDS master secret, and the API, worker and migrate Lambdas' runtime secrets at cold start, secrets.tf). 1 halves the cost; the endpoint is reachable from both subnets either way, but if its AZ is down a cold-starting API, worker or migrate Lambda can't read its secret (warm ones carry on)."
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

variable "waf_tiles_rate_limit_per_ip" {
  description = "WAF rate limit on /tiles/* (the map's PMTiles archives, glyphs): requests per IP per 5-minute rolling window. Each may move up to 2 MiB (tiles_range), so this bounds one address's CloudFront egress: 1000 is ~2 GB per 5 minutes at worst, which the cloudfront-bytes alarm sees in its first period. Real map use is a few hundred range reads in a busy 5 minutes. Between 100 (AWS's minimum) and waf_site_rate_limit_per_ip."
  type        = number
  default     = 1000
  validation {
    condition     = var.waf_tiles_rate_limit_per_ip >= 100 && var.waf_tiles_rate_limit_per_ip <= var.waf_site_rate_limit_per_ip
    error_message = "Between 100 (AWS WAF's minimum) and waf_site_rate_limit_per_ip (above it the site-wide rule is the limit and this one bounds nothing)."
  }
}

# The egress alarm (alarms.tf cloudfront_bytes). Requests are cheap; bytes are
# what the tiles cost ($0.110/GB at Africa's edges, $0.085 at US/EU's). A pull
# just under the threshold from many addresses goes unseen: at 0.5 GB per
# 5 minutes that is 144 GB a day, ~$12–16 a day, until the daily budget
# (8–24 h late) says so.
variable "cloudfront_bytes_alarm_gb_per_5min" {
  description = "Alarm when CloudFront sends viewers more than this many GB in 5 minutes (BytesDownloaded, us-east-1): the egress alarm for the map's tiles, which the request alarm can't see (one /tiles/ request may be 2 MiB). Default 0.5: a busy 5 minutes for a handful of users is tens of MB; a pull just under it costs ~$12–16/day unseen. Runbook: docs/deployment.md § Runbooks, Request flood."
  type        = number
  default     = 0.5
  validation {
    condition     = var.cloudfront_bytes_alarm_gb_per_5min >= 0.1 && var.cloudfront_bytes_alarm_gb_per_5min <= 2
    error_message = "Between 0.1 GB and 2 GB per 5 minutes (at 2 an unseen pull costs ~$50–63 a day, most of the monthly budget in two days)."
  }
}

# The request-flood alarm (alarms.tf cloudfront_requests). A flood that stays
# just under it goes unseen, so the ceiling is set by what that costs: every
# allowed request is billed by WAF ($0.60/M) and CloudFront ($1.00/M at
# US/EU edges, ~$2.20/M at Africa's), $1.60–2.80/M in all. At the 20,000
# ceiling that is 66.7 req/s = 5.76M/day = $9.22–16.13 a day unseen, 10–18%
# of the $90 budget a day; above it the alarm stops being a cost control.
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
  description = "Monthly AWS spend ceiling in USD. Notifications (to the us-east-1 alerts topic): ACTUAL 80%, ACTUAL 100% and FORECASTED 100%. The default 110 sits above af-south-1's ~$77 idle (infra/README.md § Cost), so ACTUAL 80% ($88) doesn't fire at idle; ~85 fits us-east-1 (~$63 idle), ~220 the full tier in af-south-1 and ~180 in us-east-1 (docs/deployment-tiers.md). With assistant_enabled, add assistant_budget_monthly_usd to it (~$160 on the defaults): the account total includes the model spend and the assistant's ~$11 of fixed cost, which would otherwise put af-south-1's idle (~$88) on the ACTUAL 80% line every month. Set to 0 to skip both budgets until billing access is enabled (NOT for prod)."
  type        = number
  default     = 110

  validation {
    condition     = var.budget_monthly_usd >= 0
    error_message = "budget_monthly_usd must be 0 (no budgets) or a positive USD amount."
  }
}

# The daily budget is the first-month guard: the monthly FORECASTED alert needs
# ~5 weeks of history, and daily budgets support ACTUAL notifications only.
variable "budget_daily_usd" {
  description = "Daily AWS spend ceiling in USD (ACTUAL 100% → the us-east-1 alerts topic, at most one mail a day). null (default) derives it from the monthly: ceil(budget_monthly_usd × 2.25 / 30), i.e. $9 on $110, ~3.5× af-south-1's ~$2.55/day idle. 0 skips only the daily budget. Must be below budget_monthly_usd."
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

variable "delineation_dem" {
  description = "Catchment delineation in production (docs/design/delineation.md, docs/deployment.md § Map tiles): true sets the API's and the worker's DEM_URL to s3://<tiles bucket>/tiles/terrain.pmtiles and lets both roles read that one key (the worker delineates a catchment too large for the request, with at least 2048 MB). Turn it on only once terrain.pmtiles is uploaded and the Copernicus liability sentence (Art. 6(c)) is in the app's legal notice. false (the default): no Delineate."
  type        = bool
  default     = false
}

variable "signup_open" {
  description = "Whether anyone may sign up (SIGNUP_OPEN on the API; backend/src/auth/signupOpen.ts). false (the default): sign-up only through a live invite for that address, so people join when a project member invites them. Set true only once docs/legal-status.md Gates A (the information officer's registration) and C (a published business address) are done, since both come before the first open sign-up."
  type        = bool
  default     = false
}

variable "dam_trace_water" {
  description = "Tracing a dam in production (docs/maps.md § Assisted drawing, docs/deployment.md § Map tiles): true sets the API's WATER_URL to s3://<tiles bucket>/tiles/water.pmtiles and lets its role read that one key. Turn it on once water.pmtiles (JRC Global Surface Water, `pnpm dev:tiles:water`) is uploaded. false (the default): no Trace a dam."
  type        = bool
  default     = false
}

variable "lambda_reserved_concurrency" {
  description = <<-EOT
    Max concurrent API Lambda executions. Bounds worst-case spend during an
    attack AND the number of DB connections: each container serves one
    request at a time and holds a pg pool of DB_POOL_MAX = 2 (lambda.tf), so
    25 x 2 = 50 connections at most. Sized against the database: with the
    worker's 8 x 2 = 16 and the migrate Lambda's 2 that is 68 at the very
    worst, under db.t4g.micro's ~80 max_connections (the default class) and
    well under db.t4g.small's ~180 (production's, prod.tfvars), with room
    left for the operator and RDS's own (infra/README.md § Connections).
    Raising it, or the pool, means redoing that sum. The Project tab loads
    about 10 panels at once, so the old cap of 10 throttled a single cold
    load (issue #541). AWS keeps >= 10 executions unreserved, so the
    account's Lambda concurrent-executions quota must cover the sum of every
    reservation + 10 (52 at the defaults, the assistant's 2 included) before the apply: infra/README.md
    § Operator steps. Never -1 (unreserved): that removes the cap on spend
    and on DB connections.
  EOT
  type        = number
  default     = 25
  validation {
    condition     = var.lambda_reserved_concurrency >= 1
    error_message = "Must be at least 1: -1 (unreserved) removes the spend and DB-connection cap. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

variable "migrate_memory_mb" {
  description = "Migrate Lambda memory. A migration needs little; a reference-dataset load (load-reference.yml) parses a country's river reaches, land-cover cells or evaporation cells in memory before writing them, which needs a few GB. Billed only while it runs (one invocation per deploy or load). 3008 MB is the most a new account may allow before AWS raises its quota."
  type        = number
  default     = 3008
  validation {
    condition     = var.migrate_memory_mb >= 3008 && var.migrate_memory_mb <= 10240
    error_message = "Between 3008 MB (a reference load's 200 MB file peaks near 1.8 GB, geo/referenceLoad.ts MAX_TEXT_BYTES) and 10240 MB (Lambda's maximum)."
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
  description = "Worker Lambda memory. A queued re-run is the same engine run the API does, so the same 1024 MB. With delineation_dem on, the worker gets at least 2048 MB whatever this says: a `delineate` job (a catchment too large for the request) peaks at about 1.1 GB (jobs.tf local.worker_memory_mb)."
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

variable "s3_endpoint_az_count" {
  description = "How many AZs get an ENI for the S3 interface endpoint (packs.tf: the worker's check of a pack PDF, the API's put of a pack bundle, the delineation DEM and dam-trace reads, the migrate Lambda's reference loads). 1 halves the cost; both subnets still reach it, and an outage of its AZ fails only those calls. 2 on the full tier (docs/deployment-tiers.md)."
  type        = number
  default     = 1
  validation {
    condition     = var.s3_endpoint_az_count >= 1 && var.s3_endpoint_az_count <= 2
    error_message = "Must be 1 or 2."
  }
}

variable "fetcher_reserved_concurrency" {
  description = "Max concurrent fetcher Lambda executions (data feeds, feeds.tf): bounds spend. At least 2, its SQS trigger's maximum_concurrency. How hard a source is hit is set elsewhere: fetch-requests is FIFO with one message group per source host, so each host sees one fetch at a time whatever this is (issue #604). Never -1: raise the account quota instead (lambda_reserved_concurrency)."
  type        = number
  default     = 2
  validation {
    condition     = var.fetcher_reserved_concurrency >= 2
    error_message = "Must be at least 2, its SQS trigger's maximum_concurrency; -1 (unreserved) is refused too. Raise the account's Lambda concurrency quota instead (infra/README.md § Operator steps)."
  }
}

variable "feeds_contact" {
  description = "The contact email the data feeds' fetcher puts in its user agent (feeds.tf, backend/src/feeds/http.ts): CHC asked for one (2026-10-27, issue #604), to write to before blocking our addresses. Required, no default: the repo is public, so the address lives only in the operator's tfvars. The fetcher refuses to start without a good one (backend/src/config/production.ts)."
  type        = string

  validation {
    condition = (
      can(regex("^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$", var.feeds_contact)) &&
      !can(regex("(?i)(@([^@]+\\.)?example\\.(com|org|net)|\\.(example|test|invalid|localhost|local))$", var.feeds_contact)) &&
      # A template's address left unedited (the same list backend/src/config/production.ts refuses).
      !can(regex("(?i)^(you|your|yourname|your[._-]?(e-?mail|name|address)|e-?mail|name|user|someone|somebody|changeme|change[._-]me|replace[._-]?me|todo|xxx+|foo|test)@", var.feeds_contact))
    )
    error_message = "feeds_contact must be an email address (name@domain.tld) someone reads: not empty, not at a reserved domain (example.com/.org/.net, .example, .test, .invalid, .localhost, .local), and not a template's (you@, your-email@, changeme@)."
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

variable "pack_retention_days" {
  description = "Object Lock default retention (GOVERNANCE mode) of each issued evidence pack's PDF in the packs bucket (packs.tf), from its upload. Default 3650 (10 years): a licence decision can be reviewed or appealed long after it is made, and the verify link answers with the PDF's hash for as long as the pack exists. An operator decision (docs/deployment.md § Evidence packs); raising it later applies to new objects only."
  type        = number
  default     = 3650
  validation {
    condition     = var.pack_retention_days >= 365 && var.pack_retention_days <= 36500 && floor(var.pack_retention_days) == var.pack_retention_days
    error_message = "A whole number of days, at least 365 (a pack is evidence) and at most 36500 (S3's limit is 100 years)."
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

# --- The data mirror (ingest.tf, issue #604) ------------------------------------

variable "chirps_source" {
  description = "Which CHIRPS the worker's feed fetches read (CHIRPS_SOURCE, issue #604): chc sends each fetch to the fetcher Lambda, which reads CHC's files; mirror reads our copy in the mirror bucket (ingest.tf) inside the worker's own fetch job, with no request to CHC. The API gets the same value, so the Data feeds panel reports the copy exactly when the feeds read it (it reads the copy's days from the database, never the bucket). chc until the cutover: switch only once the copy holds the region's finals and preliminary days (docs/deployment.md § The cutover). With dws_source = \"store\" as well, per-feed fetching is off and Terraform removes the fetch-requests and ingest-results queues, their DLQs and alarms, both SQS triggers and the worker's FEED_FETCHER (feeds.tf local.per_feed_fetching); setting either back brings them back."
  type        = string
  default     = "chc"
  validation {
    condition     = contains(["chc", "mirror"], var.chirps_source)
    error_message = "chirps_source must be chc or mirror."
  }
}

variable "ingest_image_tag" {
  description = "Tag of the mirror ingest image (ingest/Dockerfile) in its ECR repository that the mirror-ingest Lambda is created from: <release version>-<first 12 hex of its commit>, e.g. 0.7.0-0123456789ab, as deploy-backend.yml pushes it and prints it. Empty (the default) creates the mirror bucket, the repository, the DLQ and the (disabled) schedules but not the function or its freshness alarms: push an image with a backend release first (docs/deployment.md § The data mirror). Setting it enables the daily schedules and the alarms; the ECR lifecycle policy never expires this image (ingest.tf)."
  type        = string
  default     = ""
  validation {
    condition     = var.ingest_image_tag == "" || can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+-[0-9a-f]{12}$", var.ingest_image_tag))
    error_message = "ingest_image_tag must be empty or the tag deploy-backend.yml pushed, <version>-<12 hex of the commit>, like 0.7.0-0123456789ab."
  }
}

variable "ingest_reserved_concurrency" {
  description = "Max concurrent mirror ingest runs (ingest.tf): one per product, and never more than two requests at once against an upstream (issue #604's polite client). Counted in the account's Lambda concurrency quota (infra/README.md § Operator steps, step 3)."
  type        = number
  default     = 2
  validation {
    condition     = var.ingest_reserved_concurrency >= 1 && var.ingest_reserved_concurrency <= 2 && floor(var.ingest_reserved_concurrency) == var.ingest_reserved_concurrency
    error_message = "1 or 2: more would hit CHC with more than two runs at once (and -1, unreserved, is refused too)."
  }
}

variable "ingest_lag_alarm_days" {
  description = "Alarm when a mirrored product's finals end more than this many days ago (MirrorLagDays). CHC publishes month M's finals during month M+1, usually by the 25th, so a healthy copy runs up to ~56 days behind just before a release; the default 75 fires once a monthly release is about three weeks late."
  type        = number
  default     = 75
  validation {
    condition     = var.ingest_lag_alarm_days >= 60 && floor(var.ingest_lag_alarm_days) == var.ingest_lag_alarm_days
    error_message = "A whole number of days, at least 60, or the alarm fires on a healthy copy just before CHC's monthly release."
  }
}

variable "daily_ingest_enabled" {
  description = "Turn on the fetcher's daily ingest (feeds.tf, issue #604 R2-B): the daily EventBridge rule that copies CHIRPS preliminary days into the data mirror and the GEFS rule that copies the day's forecast issue (R3-A, 08:38–11:38 UTC), the fetcher role's write to the mirror bucket, and the preliminary and GEFS copies' freshness alarms (ingest.tf, breaching on missing data). Off (the default) until a backend release with the daily mode is deployed, or the alarm would fire for a job that doesn't exist yet. Runbook: docs/deployment.md § The data mirror."
  type        = bool
  default     = false
}

variable "daily_ingest_lag_alarm_days" {
  description = "Alarm when the mirror's newest CHIRPS sat day (preliminary, else final) is more than this many days old (MirrorLagDays{Product=prelim}). CHC publishes a pentad's preliminary days two days after it ends, so a healthy copy runs up to ~8 days behind; the default 12 fires once a pentad is about a week late."
  type        = number
  default     = 12
  validation {
    condition     = var.daily_ingest_lag_alarm_days >= 9 && floor(var.daily_ingest_lag_alarm_days) == var.daily_ingest_lag_alarm_days
    error_message = "A whole number of days, at least 9, or the alarm fires on a healthy copy just before a pentad is published."
  }
}

variable "dws_source" {
  description = "Where the worker's DWS feed fetches read (DWS_SOURCE, issue #604 R3-B): live sends each fetch to the fetcher Lambda, which reads DWS's HyData.aspx page; store reads our gauge_record table (migration 247) inside the worker's own fetch job, with no request to DWS. live until the operator has loaded each station's record (load-reference.yml kind dws) and the dws-coverage read-only check reads every station covered (docs/deployment.md § DWS gauge records). With chirps_source = \"mirror\" as well, per-feed fetching is off and Terraform removes the fetch queues (feeds.tf local.per_feed_fetching; docs/deployment.md § The cutover)."
  type        = string
  default     = "live"
  validation {
    condition     = contains(["live", "store"], var.dws_source)
    error_message = "dws_source must be live or store."
  }
}

variable "dws_weekly_enabled" {
  description = "Turn on the weekly DWS pass (feeds.tf, issue #604 R3-B): the daily EventBridge rule that invokes the fetcher with {\"mode\":\"dws-weekly\"} (each station re-read once a week), the fetcher's write to dws/ in the mirror bucket, the worker's station list (DWS_WEEKLY=on, its write to dws/stations.json) and the pass's freshness alarm. Off (the default) until a backend release with the mode is deployed, or the alarm would fire for a job that doesn't exist yet. Runbook: docs/deployment.md § DWS gauge records."
  type        = bool
  default     = false
}

variable "dws_weekly_lag_alarm_days" {
  description = "Alarm when a station the DWS feeds read was last fetched more than this many days ago (MirrorLagDays{Product=dws}): each is re-read every 6 days, so a healthy pass runs up to ~7 days behind; the default 10 fires when a station misses its week by three days (a 403 or the ScriptServer page stops the whole pass)."
  type        = number
  default     = 10
  validation {
    condition     = var.dws_weekly_lag_alarm_days >= 8 && floor(var.dws_weekly_lag_alarm_days) == var.dws_weekly_lag_alarm_days
    error_message = "A whole number of days, at least 8, or the alarm fires on a healthy pass just before a station's weekly re-read."
  }
}

variable "ingest_backfill_wait_seconds" {
  description = "Seconds the backfill state machine (ingest_backfill.tf) waits after each month before invoking the next: D4's 1 file a minute against CHC."
  type        = number
  default     = 60
  validation {
    condition     = var.ingest_backfill_wait_seconds >= 60 && var.ingest_backfill_wait_seconds <= 3600 && floor(var.ingest_backfill_wait_seconds) == var.ingest_backfill_wait_seconds
    error_message = "60 to 3600 whole seconds: CHC is asked for at most one bulk file a minute (issue #604 D4), and the ingest's hold on CHC's slot accepts a pause of at most an hour (ingest/lambda_handler.py MAX_PAUSE_S)."
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

variable "alarm_tier" {
  description = "Which CloudWatch alarms to create. \"full\": every alarm (~50 alarm metrics). \"essential\": 13 alarm metrics: SES bounce + complaint rate, the jobs / mail-events / fetch-requests / ingest-results DLQ arrivals, worker heartbeat, RDS free storage, CloudFront 5xx, API Lambda errors and throttles, unhandled API errors and failed mail sends; two fewer after the cutover (chirps_source = \"mirror\" and dws_source = \"store\" remove the fetch-requests and ingest-results queues and their DLQ alarms, feeds.tf), 15 once ingest_image_tag is set (the data mirror's two freshness alarms, ingest.tf), two more with daily_ingest_enabled (the preliminary and GEFS copies'), one more with era5l_enabled (ERA5-Land's lag, era5land.tf), one more with imerg_enabled (IMERG Late's lag, imerg.tf) and one more with climate_indices_enabled (the ONI and AAO copy's lag, climate_indices.tf) and one more with c3s_enabled (the C3S seasonal copy's lag, c3s.tf). \"none\": no alarms. Each alarm metric past the AWS Organization's shared 10 free costs ~$0.10/month (more in af-south-1). Budgets and cost anomaly detection are not alarms and are unaffected."
  type        = string
  default     = "full"

  validation {
    condition     = contains(["full", "essential", "none"], var.alarm_tier)
    error_message = "alarm_tier must be one of \"full\", \"essential\", \"none\"."
  }
}

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
  description = "Display name in the From header (MAIL_FROM): the app's short name, IC-WBT (issue #551), since an inbox's sender column is narrow."
  type        = string
  default     = "IC-WBT"
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

# --- The assistant (assistant.tf, issue #610) --------------------------------

variable "assistant_enabled" {
  description = "The AI assistant in production (assistant.tf, docs/deployment.md § The assistant): true creates its Lambda, Function URL, CloudFront behaviour, the bedrock-runtime VPC endpoint, its alarms and its budget, and sets ASSISTANT_PROVIDER=bedrock on it and on the API (whose status turns the chat on). false (the default): none of it exists and the API answers { available: false }. Turn it on only once the privacy notice names the model provider (LEGAL_VERSION) and the operator has enabled the model in the Bedrock console and run its first invocation (docs/followups.md § Blocking releases)."
  type        = bool
  default     = false
}

variable "dam_observations_enabled" {
  description = "Turn on the dam observations (dam_observations.tf, issue #604 R5): the hourly EventBridge rule that invokes the fetcher with {\"mode\":\"dams-weekly\"} (DE Africa Waterbodies, each matched uid's recent series re-read once a week and its whole series every 91 days, after a one-off WFS lookup of its wb_id, and WOfS, each dam's newest scenes once a day and its history with the rest of the time), the fetcher's reads and writes under dams/ in the mirror bucket, the worker's write of dams/wanted.json, and the passes' heartbeat and WOfS and Waterbodies recency alarms. It also sets the worker's DAM_OBSERVATIONS (jobs.tf), which turns its dams tick on; the plan refuses the flag if the worker's environment ever loses it (dam_observations.tf terraform_data.dam_observations_gate). Off (the default) until a backend release with the mode is deployed and a dam is traced, or the alarms fire for passes that don't exist yet. Runbook: docs/deployment.md § Dam observations."
  type        = bool
  default     = false
}

variable "future_yield_enabled" {
  description = "Turn on the future climate (issue #621): the evidence report's § 8 Future yield (a future_yield job re-runs an application and its baseline under each NEX-GDDP-CMIP6 model's change factors) and the Scenarios tab's change factors (a climate_factors job). Sets FUTURE_YIELD on the API (which queues the jobs and puts § 8 in a report), the worker (which runs them, reading cmip6/ in the mirror bucket through MIRROR_URL) and the assistant (which builds the same reports), so all three agree. Off (the default) until the copy holds every model's whole windows and NASA's caveat is quoted (docs/deployment.md § NEX-GDDP-CMIP6); with it on and no cmip6 in the copy, each job dies saying the operator loads it."
  type        = bool
  default     = false
}

variable "et_observations_enabled" {
  description = "Turn on the observed actual ET (et_observations.tf, issue #623): the hourly EventBridge rule that invokes the fetcher with {\"mode\":\"et-dekadal\"} (FAO WaPOR v3's dekadal actual ET averaged over each unit's farm parcels, newest dekads first, then the history to 2018), the fetcher's reads and writes under et/ in the mirror bucket, the worker's write of et/wanted.json, and the pass's heartbeat and recency alarms. It also sets the worker's ET_OBSERVATIONS (jobs.tf), which turns its ET tick on; the plan refuses the flag if the worker's environment ever loses it (et_observations.tf terraform_data.et_observations_gate). Off (the default) until FAO's reply on WaPOR's licence is recorded on issue #618 (step 8a), a backend release with the mode is deployed and a unit has farm parcels, or the alarms fire for a pass that has nothing to read. Runbook: docs/deployment.md § Observed actual ET."
  type        = bool
  default     = false
}

variable "et_recency_alarm_days" {
  description = "Alarm when the newest WaPOR dekad any unit holds began more than this many days ago (EtObservationAgeDays{Source=wapor}). A dekad lasts up to 11 days and FAO publishes it about 3 days after it ends, so a healthy copy runs up to ~14 days behind; 30 is two dekads missed."
  type        = number
  default     = 30
  validation {
    condition     = var.et_recency_alarm_days >= 20 && floor(var.et_recency_alarm_days) == var.et_recency_alarm_days
    error_message = "A whole number of days, at least 20: a healthy WaPOR copy runs up to ~14 days behind (the dekad's length plus FAO's ~3-day lag)."
  }
}

variable "climate_indices_enabled" {
  description = "Turn on the climate indices copy (climate_indices.tf, issue #620): the daily EventBridge rule that invokes the fetcher with {\"mode\":\"daily-ingest\",\"pass\":\"indices\"} (NOAA CPC's ONI and AAO, two requests a day), the fetcher's reads and writes under indices/ in the mirror bucket, and the copy's freshness alarm (MirrorLagDays{Product=indices}, breaching on missing data). Until it is on, an outlook asking for the climate-state analogues says the indices aren't held and shows the ESP alone. Off (the default) until a backend release with the pass is deployed, or the alarm fires for a pass that doesn't exist yet. Runbook: docs/deployment.md § Climate indices."
  type        = bool
  default     = false
}

variable "c3s_enabled" {
  description = "Turn on the C3S seasonal forecast copy (c3s.tf, issue #620 step 5): the daily EventBridge rule (14:20 UTC, after the 6th's and 10th's 12 UTC releases) that sends the mirror-ingest Lambda {\"product\":\"c3s\",\"mode\":\"monthly\"} (collect the CDS requests that are ready, submit each system's newest released init and the wanted hindcasts) and the copy's freshness alarm (MirrorLagDays{Product=c3s}, breaching on missing data). Needs ingest_image_tag set, the CDS key in the <project>/ingest/cds-key secret (ERA5-Land's) and, on that CDS account, both the seasonal dataset's licence and its Additional licence to use non European contributions accepted: docs/deployment.md § C3S seasonal forecasts. Off by default; nothing in the app reads the copy until #620 step 6-7."
  type        = bool
  default     = false
}

variable "c3s_lag_alarm_days" {
  description = "MirrorLagDays{Product=c3s} past this alarms (c3s.tf): days since the 1st of the newest init month every system is held for. A healthy copy runs up to about 42 days behind: month M's last systems are released on the 10th of M and collected a day or two later, so just before that the newest complete init is M-1's, about 31 + 11 days back (ingest/c3s_seasonal.py)."
  type        = number
  default     = 45

  validation {
    condition     = var.c3s_lag_alarm_days >= 43 && floor(var.c3s_lag_alarm_days) == var.c3s_lag_alarm_days
    error_message = "c3s_lag_alarm_days must be a whole number of days, at least 43: a healthy C3S copy runs up to ~42 days behind."
  }
}

variable "assistant_model_id" {
  description = "The one Bedrock model the assistant may call: a model id (anthropic.…, in-region) or a system inference profile id (global.anthropic.…, eu.anthropic.…). Its IAM policy and the endpoint policy allow this model alone. From af-south-1, Anthropic's models are reachable only through the global profile, which may run the request in any commercial AWS region (docs/deployment.md § The assistant)."
  type        = string
  default     = "global.anthropic.claude-sonnet-5-5"
  validation {
    condition     = can(regex("^((global|us|eu|apac|au|jp|ca)\\.)?anthropic\\.[A-Za-z0-9.:_-]+$", var.assistant_model_id))
    error_message = "assistant_model_id must be an Anthropic model on Bedrock: anthropic.<model> or <profile>.anthropic.<model> (global, us, eu, apac, au, jp, ca), as backend/src/config/production.ts accepts."
  }
}

variable "assistant_memory_mb" {
  description = "Assistant Lambda memory. Its tools read a run's series and compute a gauge's fit (monthly means, calibrationStats), the same work the API does for a page, so the API's 1024 MB."
  type        = number
  default     = 1024
}

variable "assistant_timeout_seconds" {
  description = "Assistant Lambda timeout. A turn is up to assistant_max_hops model calls with tool reads between them. CloudFront's origin read timeout on its behaviour (60 s) limits the gap between two packets, not the response, and the stream sends a keepalive every 15 s. ASSISTANT_TURN_SECONDS is set 15 s below it, so a long turn ends with an error event (and is charged) before the runtime cuts it off."
  type        = number
  default     = 120
  validation {
    condition     = var.assistant_timeout_seconds >= 60 && var.assistant_timeout_seconds <= 300
    error_message = "Between 60 s (a turn of several model calls) and 300 s (each running container is a database connection and a reserved slot)."
  }
}

variable "assistant_reserved_concurrency" {
  description = "Max concurrent assistant Lambda executions: how many turns run at once across every user. Bounds the model spend per minute and the database connections (x a pool of 1: infra/README.md § Connections, which the precondition in lambda.tf sums). A turn holds its container for tens of seconds, so a third user sending at once gets a 429 they can resend. Never -1: raise the account quota instead (lambda_reserved_concurrency)."
  type        = number
  default     = 2
  validation {
    condition     = var.assistant_reserved_concurrency >= 1 && var.assistant_reserved_concurrency <= 10
    error_message = "Between 1 and 10: -1 (unreserved) removes the spend and connection cap, and more than 10 needs infra/README.md § Connections redone."
  }
}

# The caps below count weighted tokens: input + 5 x output, because Claude's
# output costs five times its input on Bedrock (OUTPUT_TOKEN_WEIGHT in
# backend/src/assistant/config.ts, and 262_assistant_usage.sql weighs the
# same), so a cap in weighted tokens is a cap in dollars at the input price.
# The bounds are the ones backend/src/config/production.ts checks: change
# both together.

variable "assistant_tokens_per_month" {
  description = "Weighted tokens (input + 5 x output) one project may use in a calendar month (UTC), counted in Postgres and checked before each turn (ASSISTANT_TOKENS_PER_MONTH, set on the assistant and the API alike so the status shows what is enforced). 2 M is issue #610's starting point: about $4 at the input price (assistant_input_usd_per_million)."
  type        = number
  default     = 2000000
  validation {
    condition     = var.assistant_tokens_per_month >= 1 && var.assistant_tokens_per_month <= 20000000 && floor(var.assistant_tokens_per_month) == var.assistant_tokens_per_month
    error_message = "A whole number of weighted tokens from 1 to 20,000,000 (production.ts checks the same bounds)."
  }
}

variable "assistant_tokens_per_user_month" {
  description = "Weighted tokens (input + 5 x output) one person may use in a calendar month (UTC), across every project (ASSISTANT_TOKENS_PER_USER_MONTH, on the assistant and the API): the cap a person can't get past by creating projects. 1 M is about $2 at the input price."
  type        = number
  default     = 1000000
  validation {
    condition     = var.assistant_tokens_per_user_month >= 1 && var.assistant_tokens_per_user_month <= 20000000 && floor(var.assistant_tokens_per_user_month) == var.assistant_tokens_per_user_month
    error_message = "A whole number of weighted tokens from 1 to 20,000,000 (production.ts checks the same bounds)."
  }
}

variable "assistant_input_usd_per_million" {
  description = "The model's price in USD per million input tokens, from which the deployment-wide cap is derived (assistant_tokens_per_month_total). Output is 5x input, which the weighted count already carries, so weighted tokens x this price is dollars. Claude Sonnet 5.5 through the global profile from af-south-1: $2.00 input, $10.00 output per million (AWS Price List API, AmazonBedrockFoundationModels af-south-1, usage types AFS1-MP:AFS1_input_tokens_global_standard and _output_tokens_global_standard, publication 2026-10-12, read 2026-10-27; billed as AWS Marketplace software usage). The app counts cache reads ($0.10/M) and writes ($2.50/M, 1.25x) as input tokens (providers/bedrock.ts), so the cap overstates cached reads and understates writes by a quarter. Re-check it when assistant_model_id changes."
  type        = number
  default     = 2
  validation {
    condition     = var.assistant_input_usd_per_million > 0
    error_message = "A positive USD price per million input tokens."
  }
}

variable "assistant_tokens_per_month_total" {
  description = "Weighted tokens (input + 5 x output) the whole deployment may use in a calendar month (UTC), every project and person together (ASSISTANT_TOKENS_PER_MONTH_TOTAL, on the assistant and the API): the cap no number of projects or accounts gets past. null (the default) derives it from the assistant's budget: floor(assistant_budget_monthly_usd / assistant_input_usd_per_million x 1e6), 25 M at $50 and $2/M, so the app stops at about the budget plus the turns in flight, days before the budget's billing data would say so. Set it when assistant_budget_monthly_usd is 0 (nothing to derive from)."
  type        = number
  default     = null
  validation {
    condition = (
      var.assistant_tokens_per_month_total == null
      ? var.assistant_budget_monthly_usd > 0 && floor(var.assistant_budget_monthly_usd / var.assistant_input_usd_per_million * 1000000) >= 1 && floor(var.assistant_budget_monthly_usd / var.assistant_input_usd_per_million * 1000000) <= 200000000
      : var.assistant_tokens_per_month_total >= 1 && var.assistant_tokens_per_month_total <= 200000000 && floor(var.assistant_tokens_per_month_total) == var.assistant_tokens_per_month_total
    )
    error_message = "A whole number of weighted tokens from 1 to 200,000,000 (production.ts checks the same bounds). Left null, it is derived from assistant_budget_monthly_usd / assistant_input_usd_per_million, which must then be a positive budget that comes to at most 200 M (at $2/M, a budget up to $400): set it explicitly otherwise."
  }
}

variable "assistant_messages_per_hour" {
  description = "Messages one user may send in an hour across projects (ASSISTANT_MESSAGES_PER_HOUR; a 429 with Retry-After past it)."
  type        = number
  default     = 30
  validation {
    condition     = var.assistant_messages_per_hour >= 1 && var.assistant_messages_per_hour <= 120 && floor(var.assistant_messages_per_hour) == var.assistant_messages_per_hour
    error_message = "A whole number of messages from 1 to 120 (production.ts checks the same bounds)."
  }
}

variable "assistant_max_hops" {
  description = "Model calls in one turn (ASSISTANT_MAX_HOPS); the turn ends with an error event past it."
  type        = number
  default     = 6
  validation {
    condition     = var.assistant_max_hops >= 1 && var.assistant_max_hops <= 12 && floor(var.assistant_max_hops) == var.assistant_max_hops
    error_message = "A whole number from 1 to 12."
  }
}

variable "assistant_max_turn_tokens" {
  description = "Weighted tokens (input + 5 x output) one turn may use, every hop together (ASSISTANT_MAX_TURN_TOKENS); the turn ends with an assistant_turn_limit error event before a hop that would pass it. Each hop resends the whole transcript, so without it one message could reach ~1.2 M input tokens (~$2.50). 150,000 is about $0.30."
  type        = number
  default     = 150000
  validation {
    condition     = var.assistant_max_turn_tokens >= 10000 && var.assistant_max_turn_tokens <= 1000000 && floor(var.assistant_max_turn_tokens) == var.assistant_max_turn_tokens
    error_message = "A whole number of weighted tokens from 10,000 to 1,000,000 (production.ts checks the same bounds)."
  }
}

variable "assistant_max_tool_calls_per_hop" {
  description = "Tool calls run from one model call (ASSISTANT_MAX_TOOL_CALLS_PER_HOP); the calls past it get an error result that says so."
  type        = number
  default     = 4
  validation {
    condition     = var.assistant_max_tool_calls_per_hop >= 1 && var.assistant_max_tool_calls_per_hop <= 10 && floor(var.assistant_max_tool_calls_per_hop) == var.assistant_max_tool_calls_per_hop
    error_message = "A whole number from 1 to 10 (production.ts checks the same bounds)."
  }
}

variable "assistant_max_output_tokens" {
  description = "Output tokens one model call may use (ASSISTANT_MAX_OUTPUT_TOKENS; Bedrock's maxTokens). Each counts 5x against the weighted caps."
  type        = number
  default     = 1024
  validation {
    condition     = var.assistant_max_output_tokens >= 256 && var.assistant_max_output_tokens <= 8192 && floor(var.assistant_max_output_tokens) == var.assistant_max_output_tokens
    error_message = "A whole number of tokens from 256 to 8192 (production.ts checks the same bounds)."
  }
}

variable "assistant_max_tool_result_chars" {
  description = "Characters of one tool result the model sees (ASSISTANT_MAX_TOOL_RESULT_CHARS); longer results are cut with a note."
  type        = number
  default     = 12000
  validation {
    condition     = var.assistant_max_tool_result_chars >= 1000 && var.assistant_max_tool_result_chars <= 50000 && floor(var.assistant_max_tool_result_chars) == var.assistant_max_tool_result_chars
    error_message = "A whole number of characters from 1000 to 50000 (production.ts checks the same bounds)."
  }
}

variable "assistant_max_input_chars" {
  description = "Characters of conversation the page may send (ASSISTANT_MAX_INPUT_CHARS); older turns are dropped first, a newest message past it is refused."
  type        = number
  default     = 40000
  validation {
    condition     = var.assistant_max_input_chars >= 1000 && var.assistant_max_input_chars <= 200000 && floor(var.assistant_max_input_chars) == var.assistant_max_input_chars
    error_message = "A whole number of characters from 1000 to 200000 (production.ts checks the same bounds)."
  }
}

variable "assistant_tokens_alarm_per_hour" {
  description = "The assistant's real-time spend alarm (alarms.tf assistant_tokens_hourly, essential tier): weighted tokens (input + 5 x output) summed from its assistant_turn log lines over one hour. The budgets read billing data a day or two late; this pages within the hour. 2 M (~$4 an hour at $2/M) is about 10x the expected use."
  type        = number
  default     = 2000000
  validation {
    condition     = var.assistant_tokens_alarm_per_hour >= 10000 && var.assistant_tokens_alarm_per_hour <= 200000000 && floor(var.assistant_tokens_alarm_per_hour) == var.assistant_tokens_alarm_per_hour
    error_message = "A whole number of weighted tokens from 10,000 to 200,000,000."
  }
}

variable "assistant_budget_monthly_usd" {
  description = "The assistant's own AWS budget in USD a month (alarms.tf aws_budgets_budget.assistant), on the account's AWS Marketplace charges: Anthropic's models on Bedrock are billed through AWS Marketplace, and nothing else in this account is. 0 skips it; with budget_monthly_usd = 0 there are no budgets at all. It is a third budget, so it costs about $0.62 a month (AWS gives two free). It also sets the deployment-wide token cap unless assistant_tokens_per_month_total does (budget / assistant_input_usd_per_million). With the assistant on, raise budget_monthly_usd by this amount (the account total includes the model spend): ~$160 on the defaults."
  type        = number
  default     = 50
  validation {
    condition     = var.assistant_budget_monthly_usd >= 0
    error_message = "assistant_budget_monthly_usd must be 0 (no assistant budget) or a positive USD amount."
  }
}

variable "bedrock_endpoint_az_count" {
  description = "How many AZs get an ENI for the bedrock-runtime interface endpoint (assistant.tf). 1 halves the cost (~$9.56 a month per AZ in af-south-1, ~$7.30 in us-east-1); if its AZ is down the assistant answers with an error and the rest of the app carries on."
  type        = number
  default     = 1
  validation {
    condition     = var.bedrock_endpoint_az_count >= 1 && var.bedrock_endpoint_az_count <= 2
    error_message = "Must be 1 or 2."
  }
}

variable "dam_s2_enabled" {
  description = "Run the Sentinel-2 pass of the dam observations (issue #624; dam_observations.tf, backend/src/dams/observed/sentinel/pass.ts): DE Africa's Sentinel-2 L2A Collection 1 scenes classified by us (MNDWI, SCL cloud masking) inside every traced dam's outline, after the WOfS pass in each hourly dams-weekly run. Only with dam_observations_enabled: it sets the fetcher's DAM_OBSERVATIONS_S2 and adds the s2 heartbeat and recency alarms. Off (the default) until a backend release with the pass is deployed. Runbook: docs/deployment.md § Dam observations."
  type        = bool
  default     = false
}

variable "dam_s2_recency_alarm_days" {
  description = "Alarm when the newest Sentinel-2 observation any traced dam holds is more than this many days old (DamObservationAgeDays{Source=s2}). Three Sentinel-2 satellites pass every few days and a clouded view still writes a row, so 21 days with nothing means the collection or our pass has stopped."
  type        = number
  default     = 21
  validation {
    condition     = var.dam_s2_recency_alarm_days >= 10 && floor(var.dam_s2_recency_alarm_days) == var.dam_s2_recency_alarm_days
    error_message = "A whole number of days, at least 10: DE Africa publishes a scene days after it is taken."
  }
}

variable "dam_s1_mode" {
  description = "Sentinel-1 radar's stage in the dam observations (issue #624 step 5 and open question 3; dam_observations.tf, backend/src/dams/observed/handover.ts damS1Mode), set as the fetcher's and the worker's DAM_OBSERVATIONS_S1. \"off\" (the default): no radar. \"measure\": each hourly dams-weekly run adds the radar pass after Sentinel-2's (DE Africa's Sentinel-1 RTC classified by us: VV under a fixed -18 dB, the RTC mask's shadow and layover left out, inside every traced dam's outline) and the S1/S2 agreement report (the fetcher's dams_s1_agreement log line), with the s1 heartbeat and recency alarms, but the worker loads no radar row, so nobody sees it. \"on\": the same, and the worker loads radar for the dams whose own agreement passes issue #624's bar (at least 10 paired days with a clear Sentinel-2 view, 85 % of them within 0.1 of the full area), withholding the rest. Only with dam_observations_enabled. Measure first; go to on once the pooled agreement passes the bar on real dams. Runbook: docs/deployment.md § Dam observations."
  type        = string
  default     = "off"
  validation {
    condition     = contains(["off", "measure", "on"], var.dam_s1_mode)
    error_message = "dam_s1_mode is off, measure or on."
  }
}

variable "dam_s1_recency_alarm_days" {
  description = "Alarm when the newest Sentinel-1 radar observation any traced dam holds is more than this many days old (DamObservationAgeDays{Source=s1}). Sentinel-1 revisits every 6-12 days and sees through cloud, so 30 days with nothing means the collection or our pass has stopped."
  type        = number
  default     = 30
  validation {
    condition     = var.dam_s1_recency_alarm_days >= 14 && floor(var.dam_s1_recency_alarm_days) == var.dam_s1_recency_alarm_days
    error_message = "A whole number of days, at least 14: a 12-day revisit plus DE Africa's processing lag."
  }
}

variable "dam_waterbodies_recency_alarm_days" {
  description = "Alarm when the newest DE Africa Waterbodies observation any matched dam holds is more than this many days old (DamObservationAgeDays{Source=waterbodies}). DE Africa's Waterbodies API keeps the series current within about a week and each uid is re-read weekly, but a date enters a series only when 90 % of the waterbody was seen clearly: 60 days is two months with no clear Landsat pass over any matched dam, which means the service or our pass has stopped."
  type        = number
  default     = 60
  validation {
    condition     = var.dam_waterbodies_recency_alarm_days >= 21 && floor(var.dam_waterbodies_recency_alarm_days) == var.dam_waterbodies_recency_alarm_days
    error_message = "A whole number of days, at least 21: a cloudy month over the region, plus the service's week of lag, shouldn't page anyone."
  }
}

variable "dam_wofs_recency_alarm_days" {
  description = "Alarm when the newest WOfS observation any traced dam holds is more than this many days old (DamObservationAgeDays{Source=wofs}). Landsat 8 and 9 pass every 8 days together, cloud hides some passes, DE Africa publishes a scene within days, and each dam is re-read weekly: 60 days is two months with no clear pass anywhere, which means WOfS or our pass has stopped."
  type        = number
  default     = 60
  validation {
    condition     = var.dam_wofs_recency_alarm_days >= 21 && floor(var.dam_wofs_recency_alarm_days) == var.dam_wofs_recency_alarm_days
    error_message = "A whole number of days, at least 21: a cloudy month over the region shouldn't page anyone."
  }
}
