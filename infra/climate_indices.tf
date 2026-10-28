# The climate indices (issue #620; docs/data-sources.md § climate-indices,
# docs/deployment.md § Climate indices): NOAA CPC's ONI and AAO, copied into
# the data mirror's indices/ by the fetcher Lambda (outside the VPC, with
# internet; backend/src/ingest/indices.ts) and read by the worker when an
# outlook asks for the climate-state analogues (backend/src/outlooks/store.ts,
# through worker_mirror in ingest.tf, which reads the whole bucket).
#
# Gated on climate_indices_enabled (default false): the rule stays disabled,
# no IAM is granted and no alarm fires for a pass that doesn't exist yet.
# Until it is on, an outlook run with "Also compare past seasons like this one"
# says the indices aren't held, and its ESP figures are unchanged.

locals {
  climate_indices_enabled = var.climate_indices_enabled
  # MirrorLagDays{Product=indices} at or past this alarms (mirror_lag_indices).
  # The lag is today minus the end of the older of the two newest months held.
  # CPC publishes a 3-month ONI season early in the month after it ends, so the
  # ONI's centre month runs up to ~66 days behind on a healthy copy (JAS,
  # centred on August, lands in early October and is the newest until early
  # November); 75 fires once a release is about a week late.
  indices_lag_alarm_days = 75
}

# --- IAM: the indices/ prefix only ---------------------------------------------------

# The pass reads the manifest (to keep a revision when nothing changed) and
# writes the two files and the manifest. ListBucket, so a missing manifest (the
# first run) answers 404, not 403. No delete.
data "aws_iam_policy_document" "fetcher_indices" {
  statement {
    sid       = "ReadWriteIndices"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/indices/*"]
  }
  statement {
    sid       = "ListMirror"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mirror.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_indices" {
  count = local.climate_indices_enabled ? 1 : 0

  name   = "climate-indices"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_indices.json
}

# --- The schedule -------------------------------------------------------------------

# Once a day at 05:50 UTC, clear of the daily ingest (03:00), the DWS pass
# (04:00), the dam passes (:20) and the GEFS pass (:38). Two requests a run to a
# host whose files change about once a month; a daily run notices a new month
# within a day. A 403 or throttle ends the run with no retry.
resource "aws_cloudwatch_event_rule" "indices_ingest" {
  name                = "${local.project}-indices-ingest"
  description         = "The fetcher's indices pass: NOAA CPC's ONI and AAO into the data mirror's indices/ ({\"mode\":\"daily-ingest\",\"pass\":\"indices\"}). Disabled until climate_indices_enabled is set."
  schedule_expression = "cron(50 5 * * ? *)"
  state               = local.climate_indices_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "indices_ingest" {
  count = local.climate_indices_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.indices_ingest.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "daily-ingest", pass = "indices" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "fetcher_indices_ingest" {
  count = local.climate_indices_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeIndicesIngest"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.indices_ingest.arn
}

# --- The alarm ----------------------------------------------------------------------

# Freshness: the pass publishes MirrorLagDays{Product=indices} on every run that
# holds both indices (backend/src/ingest/indices.ts indicesLagMetricLine). Past
# the threshold CPC is late or the pass has failed for weeks; no datapoint for
# two days, the pass stopped running (or fails before it measures): missing
# data is breaching. Essential tier, like the other copies' freshness.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_indices" {
  count = local.climate_indices_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-indices"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = local.indices_lag_alarm_days
  alarm_description   = "The data mirror's ONI or AAO is ${local.indices_lag_alarm_days} or more days behind, or the fetcher's indices pass published no lag for two days (it stopped running, or fails before it measures). Logs Insights on the fetcher log group: filter message.event = \"mirror_daily_ingest\" and message.product = \"indices\" | fields message.stopped, message.reason, message.detail, message.through. reason refused = CPC answered HTTP 403 (the run stopped on purpose; docs/deployment.md § Climate indices). Outlooks keep the indices the copy holds meanwhile, read a month or two earlier."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "indices"
  }
}
