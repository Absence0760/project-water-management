# Dam observations (issue #604 Round 5; docs/architecture.md § Dam
# observations, docs/deployment.md § Dam observations): what satellites saw of
# each traced dam, from Digital Earth Africa's Waterbodies time series and
# WOfS, into our own store (dam_observation, migration 249).
#
# The out-of-VPC handover the weekly DWS pass uses (feeds.tf): the worker tick
# writes dams/wanted.json to the mirror bucket; the fetcher Lambda (outside the
# VPC, with internet) runs the passes on the schedule below, reading the list
# and writing dams/<source>/*.json and dams/<source>-status.json; the next
# tick loads them. The worker never reaches DE Africa, so the S3 interface
# endpoint carries only the worker's own bucket traffic.
#
# Everything here is gated on dam_observations_enabled (default false): the
# rule stays disabled, no IAM is granted and no alarm fires for passes that
# don't exist yet.

locals {
  dams_enabled = var.dam_observations_enabled
  # backend/src/dams/observed/handover.ts DAM_METRIC_NAMESPACE, DAM_PASS_METRIC, DAM_RECENCY_METRIC, DAM_METRIC_DIMENSION.
  dam_metric_namespace = "water-management/DamObservations"
  dam_pass_metric      = "DamPassCompleted"
  dam_recency_metric   = "DamObservationAgeDays"
  dam_sources          = toset(["waterbodies", "wofs"])
}

# --- IAM: the dams/ prefix only ---------------------------------------------------

# The fetcher reads the wanted list and its files (for the ETag kept), and
# writes each source's files and status. ListBucket, so a missing file (no list
# yet) answers 404, not 403. No delete.
data "aws_iam_policy_document" "fetcher_dams" {
  statement {
    sid       = "ReadWriteDamsHandover"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/dams/*"]
  }
  statement {
    sid       = "ListMirror"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mirror.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_dams" {
  count = local.dams_enabled ? 1 : 0

  name   = "dams-handover"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_dams.json
}

# The worker's one write: the wanted list. Its reads (the status files and the
# observation files) are worker_mirror's (ingest.tf, the whole bucket). The S3
# interface endpoint's policy carries the same write (packs.tf
# WorkerWritesDamWantedList), as it does dws/stations.json.
data "aws_iam_policy_document" "worker_dams" {
  statement {
    sid       = "WriteDamsWantedList"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/dams/wanted.json"]
  }
}

resource "aws_iam_role_policy" "worker_dams" {
  count = local.dams_enabled ? 1 : 0

  name   = "dams-wanted-list"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_dams.json
}

# --- The schedule -------------------------------------------------------------------

# Daily at 05:00 UTC (07:00 in South Africa, after the DWS pass's 04:00),
# though each key is asked again only once a week (REFRESH_DAYS in
# dams/observed/waterbodies.ts, and the WOfS pass's own): a daily run spreads
# the work over the fetcher's time limit, and publishes each source's
# heartbeat every day, so the alarms below can treat a missing day as
# breaching (CloudWatch can't evaluate two weekly periods: an alarm's periods
# may span at most 7 days). A day with nothing due asks DE Africa nothing.
resource "aws_cloudwatch_event_rule" "dams_weekly" {
  name                = "${local.project}-dams-weekly"
  description         = "The fetcher's dam observation passes: DE Africa Waterbodies and WOfS for every traced dam, each re-read once a week into the mirror bucket ({\"mode\":\"dams-weekly\"}). Disabled until dam_observations_enabled is set."
  schedule_expression = "cron(0 5 * * ? *)"
  state               = local.dams_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "dams_weekly" {
  count = local.dams_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.dams_weekly.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "dams-weekly" })

  # A run stopped by an HTTP 403 must not ask again within minutes: the next day's run tries.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "fetcher_dams_weekly" {
  count = local.dams_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeDamsWeekly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dams_weekly.arn
}

# --- Alarms ---------------------------------------------------------------------------

# (a) Heartbeat, one per source: every completed pass publishes
# DamPassCompleted{Source} = 1 (an embedded metric in the fetcher's log,
# dams/observed/handover.ts damPassMetricLine), whatever it fetched. No
# datapoint for two days, the pass stopped running (or fails before it ends):
# missing data is breaching. Essential tier, like the mirror's freshness.
resource "aws_cloudwatch_metric_alarm" "dam_pass_heartbeat" {
  for_each = local.dams_enabled && local.alarms_essential ? local.dam_sources : toset([])

  alarm_name          = "${local.project}-dam-pass-${each.key}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.dam_pass_metric
  namespace           = local.dam_metric_namespace
  period              = 86400
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The fetcher's ${each.key} pass of the dam observations published no heartbeat for two days: the daily dams-weekly run stopped, or fails before the pass completes. Logs Insights on the fetcher log group: filter message.event = \"dams_pass\" and message.source = \"${each.key}\" | fields message.stopped, message.reason, message.detail, message.fetched, message.failed. stopped refused / throttled = DE Africa answered HTTP 403 or 429/503 (the run stopped on purpose, docs/deployment.md § Dam observations). The app keeps showing the observations it holds."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = each.key
  }
}

# (b) Data recency, WOfS only: DamObservationAgeDays{Source=wofs}, the days
# from the run back to the newest WOfS observation any dam holds. Landsat
# passes every 8 days with two satellites; past dam_wofs_recency_alarm_days
# WOfS (or our pass over it) has stopped producing. Missing is breaching, as
# for the heartbeat.
#
# No recency alarm for waterbodies, on purpose: DE Africa's public
# per-waterbody CSVs (waterbodies/v0.0.2/surface_area_change/) were last
# written 2024-02-26 and end 2023-09-17 (checked 2026-10-27, docs/data-sources.md),
# so it would fire from the first day. The pass still publishes the metric,
# and the heartbeat above still alarms if the pass stops.
resource "aws_cloudwatch_metric_alarm" "dam_recency_wofs" {
  count = local.dams_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-dam-recency-wofs"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.dam_recency_metric
  namespace           = local.dam_metric_namespace
  period              = 86400
  statistic           = "Minimum"
  threshold           = var.dam_wofs_recency_alarm_days
  alarm_description   = "The newest WOfS observation any traced dam holds is more than ${var.dam_wofs_recency_alarm_days} days old, or the WOfS pass published no recency for two days. Check DE Africa's STAC search for new wofs_ls scenes over the region before suspecting our pass; logs: filter message.event = \"dams_pass\" and message.source = \"wofs\" on the fetcher log group (docs/deployment.md § Dam observations)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = "wofs"
  }
}
