# ----------------------------------------------------------------------------
# ERA5-Land daily rain into the data mirror (issue #604 R4-A, D15;
# ingest/era5land.py, docs/deployment.md § ERA5-Land, docs/data-sources.md)
#
#   EventBridge (daily) --async {"product":"era5l","mode":"monthly"}--> mirror-ingest Lambda (ingest.tf)
#   mirror-ingest --GetSecretValue--> <project>/ingest/cds-key (the CDS API key)
#   mirror-ingest --submit / status / results (politely)--> Copernicus CDS
#   mirror-ingest --Put/Get--> the mirror bucket: era5l/ (Zarr, 0.1 deg) and
#                             ingest-state/era5l/requests.json (the queued requests)
#   mirror-ingest --PutMetricData--> MirrorLagDays{Product=era5l}
#
# The same function as CHIRPS's finals (ingest.tf): era5l is one more product
# its handler takes. The CDS queues a request for minutes to hours, so a run
# never waits: it submits, records the request's id, and a later day's run
# collects the result (era5land.py says how a month is submitted at most once
# and a failed one backs off).
#
# The CDS API key: Terraform creates the secret with NO value (no
# aws_secretsmanager_secret_version), so no key ever passes through Terraform,
# its state or this repo. The operator puts the key in from a file they hold
# (docs/deployment.md § ERA5-Land); the job reads it at run time, live mode
# only. On aws/secretsmanager, like the runtime secrets (kms.tf says why): the
# role needs no kms:Decrypt grant. The secret exists from the first apply
# (cents a month) so the operator can fill it before turning the job on.
#
# era5l_enabled (default false) turns on the daily rule and the lag alarm;
# it needs ingest_image_tag (the function) set first. The ingest role's read
# of the secret is there either way, so the operator can run a backfill by
# hand (docs/deployment.md § ERA5-Land) before the daily rule is on.
# ----------------------------------------------------------------------------

variable "era5l_enabled" {
  description = "Turn on the ERA5-Land ingest (era5land.tf, issue #604 R4-A): the daily EventBridge rule that sends the mirror-ingest Lambda {\"product\":\"era5l\",\"mode\":\"monthly\"} and the era5l freshness alarm (breaching on missing data). Needs ingest_image_tag set and the CDS key in the <project>/ingest/cds-key secret first: docs/deployment.md § ERA5-Land. Off by default."
  type        = bool
  default     = false
}

variable "era5l_lag_alarm_days" {
  description = "MirrorLagDays{Product=era5l} past this alarms (era5land.tf). A healthy copy runs about 32-45 days behind: a month's request goes in ~6 days after the month ends (ERA5-Land-T is ~5 days behind), is collected a day or two later, and its last day only comes with the next month's request (ingest/era5land.py)."
  type        = number
  default     = 50

  validation {
    condition     = var.era5l_lag_alarm_days >= 45 && floor(var.era5l_lag_alarm_days) == var.era5l_lag_alarm_days
    error_message = "era5l_lag_alarm_days must be a whole number of days, at least 45: a healthy ERA5-Land copy runs up to ~45 days behind."
  }
}

locals {
  era5l_schedule = "cron(40 2 * * ? *)" # after rnl (02:00) and sat (02:20), ingest.tf
}

# --- The CDS API key (no value: the operator puts it in) --------------------------------

resource "aws_secretsmanager_secret" "cds_key" {
  name        = "${local.project}/ingest/cds-key"
  description = "The Copernicus CDS API key the mirror-ingest job's ERA5-Land runs use (ingest/era5land.py), the key alone as the secret string. Terraform never sets a value: the operator puts it in (docs/deployment.md § ERA5-Land)."
}

data "aws_iam_policy_document" "ingest_cds_key" {
  statement {
    sid       = "ReadCdsKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.cds_key.arn]
  }
}

resource "aws_iam_role_policy" "ingest_cds_key" {
  name   = "read-cds-key"
  role   = aws_iam_role.ingest_lambda.id
  policy = data.aws_iam_policy_document.ingest_cds_key.json
}

# --- The daily rule ------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "era5l" {
  count = var.era5l_enabled ? 1 : 0

  name                = "${local.project}-mirror-ingest-era5l"
  description         = "Daily ERA5-Land run of the mirror ingest (monthly mode): collect the CDS requests that are ready, submit the newest complete month and any due re-check (ingest/era5land.py)."
  schedule_expression = local.era5l_schedule
  state               = "ENABLED"

  lifecycle {
    precondition {
      condition     = local.ingest_enabled
      error_message = "era5l_enabled needs ingest_image_tag set: the rule invokes the mirror-ingest function (docs/deployment.md § ERA5-Land)."
    }
  }
}

# Never retried, like the CHIRPS rules (ingest.tf): a refused run must stop,
# and the next day's run does the same work.
resource "aws_cloudwatch_event_target" "era5l" {
  count = var.era5l_enabled && local.ingest_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.era5l[0].name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = "era5l", mode = "monthly" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "era5l" {
  count = var.era5l_enabled && local.ingest_enabled ? 1 : 0

  statement_id  = "AllowEventBridge-era5l"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.era5l[0].arn
}

# --- Freshness ----------------------------------------------------------------------------
#
# Every era5l run publishes MirrorLagDays{Product=era5l} (today minus the
# manifest's finalThrough), a failed one too. Breaching on missing data: a
# job that stopped running is as stale as one that runs and copies nothing.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_era5l" {
  count = var.era5l_enabled && local.ingest_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-era5l"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.era5l_lag_alarm_days
  alarm_description   = "The data mirror's ERA5-Land copy is more than ${var.era5l_lag_alarm_days} days behind, or the mirror-ingest job published no era5l lag for two days. Check the mirror-ingest log group (\"era5l:\" lines) and ingest-state/era5l/requests.json in the mirror bucket: a request that failed 5 times stops resubmitting (RequestsFailed), and a 401/403 from the CDS stops the run on purpose (a wrong or expired key, or the dataset's licence not accepted; docs/deployment.md § ERA5-Land)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "era5l"
  }
}
