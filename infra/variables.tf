variable "aws_region" {
  description = <<-EOT
    Primary AWS region for the VPC, RDS, the Lambdas and the frontend bucket.
    No default on purpose: af-south-1 (Cape Town) is the likely choice for a
    South African client (POPIA, latency) but it is an opt-in region that must
    be enabled on the account first; us-east-1 is the cheaper fallback. See
    infra/README.md § Region. The CloudFront certificate, WAF and CloudFront
    alarm are always in us-east-1 regardless.
  EOT
  type        = string
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

variable "secrets_file" {
  description = "Path to the sops-encrypted prod secrets. Defaults to the private estate repo cloned as a sibling of this one (~/github/infra-secrets). Override with TF_VAR_secrets_file if your clone lives elsewhere."
  type        = string
  default     = ""
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
  description = "WAF rate-limit threshold: requests per IP per 5-minute rolling window. AWS minimum is 100."
  type        = number
  default     = 1000
  validation {
    condition     = var.waf_rate_limit_per_ip >= 100
    error_message = "AWS WAF rate-based rule minimum is 100 per 5-minute window."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly AWS spend ceiling in USD. Forecasted + actual notifications fire SNS at 50% / 100% / forecasted 100%. The idle baseline is ~$49 in us-east-1 and ~$58–63 in af-south-1 (infra/README.md § Cost): 60 fits us-east-1; raise it to ~80 for af-south-1 or the forecast alert fires every month. Set to 0 to skip budget creation (NOT recommended for prod)."
  type        = number
  default     = 60
}

variable "budget_alert_email" {
  description = "Email address that receives SNS budget + alarm notifications. Leave empty to skip the SNS subscription (alarms still fire visibly in the console but nobody is paged)."
  type        = string
  default     = ""
}

# --- Lambda ------------------------------------------------------------------

variable "lambda_log_retention_days" {
  description = "CloudWatch log retention for both Lambdas."
  type        = number
  default     = 30
}

variable "lambda_memory_mb" {
  description = "API Lambda memory. Model runs over ~16k days are CPU-bound, and Lambda CPU scales with memory; 1024 MB is the sweet spot for cost vs run latency."
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
    AWS requires >= 10 unreserved executions to remain, so on a new account
    whose concurrency quota is still 10 any reservation is rejected — set -1
    until Service Quotas → Lambda → Concurrent executions is raised.
  EOT
  type        = number
  default     = 10
}

variable "migrate_reserved_concurrency" {
  description = "Reserved concurrency for the migrate Lambda. 1 serialises migrators (on top of the advisory lock in migrate.ts). Set -1 under the same new-account quota constraint as lambda_reserved_concurrency."
  type        = number
  default     = 1
}

# --- Background jobs (jobs.tf) -------------------------------------------------

variable "worker_memory_mb" {
  description = "Worker Lambda memory. A queued re-run is the same engine run the API does, so the same 1024 MB."
  type        = number
  default     = 1024
}

variable "worker_reserved_concurrency" {
  description = "Max concurrent worker Lambda executions: bounds spend, DB connections (x a pool of 2) and parallel jobs. 2 is the SQS event source's minimum. Set -1 under the same new-account quota constraint as lambda_reserved_concurrency."
  type        = number
  default     = 2
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
  description = "Max concurrent fetcher Lambda executions (data feeds, feeds.tf): bounds spend and how hard the public sources are hit at once. Set -1 under the same new-account quota constraint as lambda_reserved_concurrency."
  type        = number
  default     = 2
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
  description = "Mailbox for DMARC aggregate reports (rua=). Empty omits rua, which leaves the policy with no feedback — set it before tightening dmarc_policy."
  type        = string
  default     = ""
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
