# Dam observations (issue #604 Round 5; docs/architecture.md § Dam
# observations, docs/deployment.md § Dam observations): what satellites saw of
# each traced dam, from Digital Earth Africa's Waterbodies time series and
# WOfS, into our own store (dam_observation, migration 261).
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
# don't exist yet. Turning it on needs the worker side too: the plan fails
# unless the worker Lambda's environment has DAM_OBSERVATIONS = "on" (set in
# jobs.tf; the gate below), since without it the worker never writes the
# wanted list nor loads what the passes fetch.

locals {
  dams_enabled = var.dam_observations_enabled
  # backend/src/dams/observed/handover.ts DAM_METRIC_NAMESPACE, DAM_PASS_METRIC, DAM_RECENCY_METRIC, DAM_METRIC_DIMENSION.
  dam_metric_namespace = "water-management/DamObservations"
  dam_pass_metric      = "DamPassCompleted"
  dam_recency_metric   = "DamObservationAgeDays"
  # The Sentinel-2 pass (issue #624, dams/observed/sentinel/pass.ts) needs its own flag as well: the fetcher's
  # DAM_OBSERVATIONS_S2 (feeds.tf), and its heartbeat and recency alarms below, follow it.
  dam_s2_on = local.dams_enabled && var.dam_s2_enabled
  # Sentinel-1 radar's stage (issue #624 step 5 and open question 3; backend/src/dams/observed/handover.ts damS1Mode),
  # the fetcher's and the worker's DAM_OBSERVATIONS_S1: "measure" runs the pass (sentinel/pass.ts S1_PASS) and the
  # S1/S2 agreement report (dams_s1_agreement in the fetcher's log) while the worker loads no radar row; "on" also
  # loads radar for the dams whose own agreement passes. Off unless the dam observations are on.
  dam_s1_mode = local.dams_enabled ? var.dam_s1_mode : "off"
  # The pass runs (its heartbeat and recency alarms) in measure and on alike.
  dam_s1_on   = local.dam_s1_mode != "off"
  dam_sources = toset(concat(["waterbodies", "wofs"], local.dam_s2_on ? ["s2"] : [], local.dam_s1_on ? ["s1"] : []))
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

# --- The gate: the worker side must be on -------------------------------------------

# The worker's DAM_OBSERVATIONS (jobs.tf, #605's file) is what writes
# dams/wanted.json and loads what the passes fetched. With the flag on and that
# variable unset, the passes would run against no list, the heartbeats would
# stay green, and no dam would ever get an observation: so the plan fails
# instead. A resource of its own (nothing depends on it), so the tests can
# expect this failure and still check the rest of the plan; it holds nothing
# and costs nothing.
resource "terraform_data" "dam_observations_gate" {
  count = local.dams_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = try(aws_lambda_function.worker.environment[0].variables["DAM_OBSERVATIONS"], "") == "on"
      error_message = "dam_observations_enabled needs the worker Lambda's DAM_OBSERVATIONS = \"on\" (infra/jobs.tf, beside DWS_WEEKLY: DAM_OBSERVATIONS = var.dam_observations_enabled ? \"on\" : \"off\"). Without it the worker never writes dams/wanted.json nor loads what the passes fetch. docs/deployment.md § Dam observations."
    }
  }
}

# --- The schedule -------------------------------------------------------------------

# Hourly at :20 (clear of the daily ingest at 03:00, the DWS pass at 04:00
# and the GEFS pass at :38), because the WOfS history is long: the fetcher's
# 120 s limit, less Waterbodies' share (up to 30%), reads a year or two of one
# dam's scenes a run, so daily runs would take about a week per dam to reach
# 2013 (about a year for 50 dams); hourly, about seven hours per dam (about two
# weeks for 50). Politeness doesn't change with it: each
# Waterbodies uid is still asked again only once a week (REFRESH_DAYS in
# dams/observed/waterbodies.ts), each dam's newest WOfS scenes once a UTC day
# (REFRESH_DAYS in dams/observed/wofs/pass.ts), every other run's time goes to
# the WOfS backfill, and the pacing stays (STAC once a second, the bucket five
# times). A run with nothing due asks DE Africa nothing, and still publishes
# each source's heartbeat and recency, so the alarms below (6-hour periods
# for the heartbeat, daily for the recency: CloudWatch can't evaluate two
# weekly ones) see every day.
resource "aws_cloudwatch_event_rule" "dams_weekly" {
  name                = "${local.project}-dams-weekly"
  description         = "The fetcher's dam observation passes, hourly: DE Africa Waterbodies (each uid re-read once a week) and WOfS (each dam's newest scenes once a day, the rest of the time its history) for every traced dam, into the mirror bucket ({\"mode\":\"dams-weekly\"}). Disabled until dam_observations_enabled is set."
  schedule_expression = "cron(20 * * * ? *)"
  state               = local.dams_enabled ? "ENABLED" : "DISABLED"

}

resource "aws_cloudwatch_event_target" "dams_weekly" {
  count = local.dams_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.dams_weekly.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "dams-weekly" })

  # A run stopped by an HTTP 403 or throttling must not ask again within
  # minutes: no retry here, and the passes themselves leave that source alone
  # for 24 hours (or a longer Retry-After) after the stop (handover.ts pausedUntil).
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
# datapoint for 18 hours (three 6-hour periods), the pass stopped running (or
# fails before it ends): missing data is breaching. Essential tier, like the
# mirror's freshness. It is also the alert for a refusal: after a pass stops
# on an HTTP 403 or 429/503, that source is paused for 24 hours (or a longer
# Retry-After; handover.ts pausedUntil) and publishes no heartbeat, so this
# fires within the pause. Daily periods couldn't see a 24-hour pause: each UTC
# day it spans still has heartbeats before or after it.
resource "aws_cloudwatch_metric_alarm" "dam_pass_heartbeat" {
  for_each = local.dams_enabled && local.alarms_essential ? local.dam_sources : toset([])

  alarm_name          = "${local.project}-dam-pass-${each.key}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = local.dam_pass_metric
  namespace           = local.dam_metric_namespace
  period              = 21600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The fetcher's ${each.key} pass of the dam observations published no heartbeat for 18 hours: the hourly dams-weekly runs stopped, fail before the pass completes, or the source is paused after DE Africa refused or throttled it (24 h, or a longer Retry-After). Logs Insights on the fetcher log group: filter message.event = \"dams_pass\" and message.source = \"${each.key}\" | fields message.stopped, message.reason, message.detail, message.fetched, message.failed. stopped refused / throttled, then paused = DE Africa answered HTTP 403 or 429/503 (the run stopped on purpose and the source waits out the pause; docs/deployment.md § Dam observations). The app keeps showing the observations it holds."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = each.key
  }
}

# (b) Data recency, WOfS and (with dam_s2_enabled / dam_s1_mode) Sentinel-2 and Sentinel-1: DamObservationAgeDays{Source=wofs}, the days
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

# Sentinel-2's recency, with dam_s2_enabled (issue #624 step 4):
# DamObservationAgeDays{Source=s2}, the days from the run back to the newest
# Sentinel-2 observation any dam holds. Sentinel-2A, 2B and 2C pass every few
# days, and a view under cloud still writes a (0 % observed) row, so past
# dam_s2_recency_alarm_days the collection (or our pass over it) has stopped.
# Missing is breaching, as for WOfS's.
resource "aws_cloudwatch_metric_alarm" "dam_recency_s2" {
  count = local.dam_s2_on && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-dam-recency-s2"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.dam_recency_metric
  namespace           = local.dam_metric_namespace
  period              = 86400
  statistic           = "Minimum"
  threshold           = var.dam_s2_recency_alarm_days
  alarm_description   = "The newest Sentinel-2 observation any traced dam holds is more than ${var.dam_s2_recency_alarm_days} days old, or the Sentinel-2 pass published no recency for two days. Check DE Africa's STAC search for new s2_l2a_c1 items over the region before suspecting our pass; logs: filter message.event = \"dams_pass\" and message.source = \"s2\" on the fetcher log group (docs/deployment.md § Dam observations)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = "s2"
  }
}

# Sentinel-1's recency, with dam_s1_mode measure or on (issue #624 step 5):
# DamObservationAgeDays{Source=s1}, the days from the run back to the newest
# radar observation any dam holds. Sentinel-1A, 1C and 1D revisit every 6–12
# days and radar sees through cloud, so past dam_s1_recency_alarm_days the
# collection (or our pass over it) has stopped. Missing is breaching, as for
# the others.
resource "aws_cloudwatch_metric_alarm" "dam_recency_s1" {
  count = local.dam_s1_on && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-dam-recency-s1"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.dam_recency_metric
  namespace           = local.dam_metric_namespace
  period              = 86400
  statistic           = "Minimum"
  threshold           = var.dam_s1_recency_alarm_days
  alarm_description   = "The newest Sentinel-1 radar observation any traced dam holds is more than ${var.dam_s1_recency_alarm_days} days old, or the Sentinel-1 pass published no recency for two days. Check DE Africa's STAC search for new s1_rtc items over the region before suspecting our pass; logs: filter message.event = \"dams_pass\" and message.source = \"s1\" on the fetcher log group, and message.event = \"dams_s1_agreement\" for the S1/S2 agreement (docs/deployment.md § Dam observations)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = "s1"
  }
}
