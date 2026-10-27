# ----------------------------------------------------------------------------
# IMERG Late for the recent days (issue #604 R4-D, D16; ingest/imerg.py,
# docs/deployment.md § IMERG Late)
#
#   EventBridge (4 times a day) --async--> mirror-ingest Lambda
#       {"product": "imerg_late", "mode": "recent"}
#   mirror-ingest --GetSecretValue--> <project>/ingest/earthdata-token
#   mirror-ingest --GET--> cmr.earthdata.nasa.gov (granule search, no sign-in)
#   mirror-ingest --GET, Bearer token--> opendap.earthdata.nasa.gov (region D1 subsets)
#   mirror-ingest --Put/Get/Delete--> the mirror bucket, imerg_late/
#   mirror-ingest --PutMetricData--> MirrorLagDays{Product=imerg_late}
#
# Same Lambda, image and DLQ as the CHIRPS finals (ingest.tf); this file adds
# only what IMERG needs:
#
# - The Earthdata token's SECRET, with no value: Terraform never holds the
#   token. The operator creates it at NASA and puts it in with one CLI call
#   (docs/deployment.md § IMERG Late). The job reads it at run time, in live
#   mode only, by the ARN in EARTHDATA_TOKEN_SECRET_ARN (ingest.tf's env).
#   The AWS-managed aws/secretsmanager key, like the runtime secrets
#   (secrets.tf), so GetSecretValue on this ARN is the whole grant.
# - The ingest role's GetSecretValue on that one secret.
# - The schedule, 4 times a day: IMERG Late lands about 14 h after a day ends,
#   at no fixed hour, and a run with nothing new costs one CMR search. Spread
#   away from rnl (02:00) and sat (02:20), so the two reserved slots are never
#   both taken by the finals when IMERG runs.
# - The lag alarm: MirrorLagDays{Product=imerg_late} = today minus the newest
#   contiguous day held. A healthy copy reads 1 (2 before the day's file
#   lands); past imerg_lag_alarm_days for two days, or no datapoint for two
#   days (treat_missing_data = breaching), it alarms.
#
# All of it but the secret and the role grant is gated on imerg_enabled
# (default false) AND the ingest function existing (ingest_image_tag): turn
# it on only once the secret holds a token, or every run fails and alarms.
# ----------------------------------------------------------------------------

variable "imerg_enabled" {
  description = "Turn on the IMERG Late copy (imerg.tf, issue #604 R4-D): the 4-times-a-day EventBridge rule sending {\"product\":\"imerg_late\",\"mode\":\"recent\"} to the mirror-ingest Lambda and its freshness alarm (breaching on missing data). Off (the default) until the Earthdata token secret holds a value: docs/deployment.md § IMERG Late. Needs ingest_image_tag too (the function must exist)."
  type        = bool
  default     = false
}

variable "imerg_lag_alarm_days" {
  description = "Alarm when the IMERG Late copy's newest contiguous day is more than this many days old (MirrorLagDays{Product=imerg_late}). A healthy copy reads 1, or 2 before the day's file lands (~14 h after the day ends)."
  type        = number
  default     = 3
  validation {
    condition     = var.imerg_lag_alarm_days >= 2 && floor(var.imerg_lag_alarm_days) == var.imerg_lag_alarm_days
    error_message = "A whole number of days, at least 2, or the alarm fires on a healthy copy before the day's file lands."
  }
}

locals {
  imerg_on       = var.imerg_enabled && local.ingest_enabled
  imerg_schedule = "cron(40 4,10,16,22 * * ? *)"
}

# --- The Earthdata token (no value here, ever) ----------------------------------------

resource "aws_secretsmanager_secret" "earthdata_token" {
  name        = "${local.project}/ingest/earthdata-token"
  description = "NASA Earthdata Login user token (plain text) for the mirror-ingest job's IMERG Late copy (ingest/imerg.py), read at run time. Terraform creates the secret only; the operator puts the token in: docs/deployment.md § IMERG Late."
}

data "aws_iam_policy_document" "ingest_earthdata_token" {
  statement {
    sid       = "ReadEarthdataToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.earthdata_token.arn]
  }
}

resource "aws_iam_role_policy" "ingest_earthdata_token" {
  name   = "earthdata-token-read"
  role   = aws_iam_role.ingest_lambda.id
  policy = data.aws_iam_policy_document.ingest_earthdata_token.json
}

# --- The schedule -----------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "imerg" {
  count = local.imerg_on ? 1 : 0

  name                = "${local.project}-mirror-ingest-imerg-late"
  description         = "IMERG Late's recent days into the data mirror, 4 times a day (ingest/imerg.py). A run with nothing new is one CMR search."
  schedule_expression = local.imerg_schedule
}

# Never retried, like the finals' targets (ingest.tf): a refused run must stop,
# and the next run, hours later, does the same work.
resource "aws_cloudwatch_event_target" "imerg" {
  count = local.imerg_on ? 1 : 0

  rule  = aws_cloudwatch_event_rule.imerg[0].name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = "imerg_late", mode = "recent" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "imerg" {
  count = local.imerg_on ? 1 : 0

  statement_id  = "AllowEventBridge-imerg-late"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.imerg[0].arn
}

# --- Freshness ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "mirror_lag_imerg" {
  count = local.imerg_on && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-imerg-late"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Minimum"
  threshold           = var.imerg_lag_alarm_days
  alarm_description   = "The data mirror's IMERG Late copy's newest contiguous day is more than ${var.imerg_lag_alarm_days} days old, or the mirror-ingest job published no imerg_late lag for two days. Check the mirror-ingest log group and its DLQ. A run that met HTTP 403 or 401 stopped on purpose and wrote ingest-state/imerg_late/refused.json (no more requests that UTC day); a 401 usually means the Earthdata token expired (60 days): docs/deployment.md § IMERG Late. Feeds keep CHIRPS meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "imerg_late"
  }
}
