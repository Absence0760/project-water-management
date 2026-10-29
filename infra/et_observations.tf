# Observed actual ET (issue #623 step 4; docs/architecture.md § Observed
# actual ET, docs/deployment.md § Observed actual ET): FAO WaPOR v3's dekadal
# actual evapotranspiration averaged over each unit's farm parcels, into our
# own store (et_observation, migration 276), the independent check on a
# unit's modelled irrigation use.
#
# The dam observations' out-of-VPC handover (dam_observations.tf): the worker
# tick writes et/wanted.json to the mirror bucket (each unit's parcels and
# their cropland, ids and geometry only); the fetcher Lambda (outside the
# VPC, with internet) runs the WaPOR pass on the schedule below, reading the
# list and writing et/wapor/*.json, et/wapor-state.json and
# et/wapor-status.json; the next tick loads them. The worker never reaches
# FAO's bucket.
#
# Everything here is gated on et_observations_enabled (default false): the
# rule stays disabled, no IAM is granted and no alarm fires for a pass that
# isn't running. WaPOR stays off in production until FAO's reply on the
# licence is recorded on issue #618 (step 8a; docs/data-sources.md
# wapor-aeti). Turning it on needs the worker side too: the plan fails
# unless the worker Lambda's environment has ET_OBSERVATIONS = "on" (jobs.tf
# sets it from the same flag; the gate below).

locals {
  et_enabled = var.et_observations_enabled
  # backend/src/water-use/observed/handover.ts ET_METRIC_NAMESPACE, ET_PASS_METRIC, ET_RECENCY_METRIC, ET_METRIC_DIMENSION.
  et_metric_namespace = "water-management/EtObservations"
  et_pass_metric      = "EtPassCompleted"
  et_recency_metric   = "EtObservationAgeDays"
}

# --- IAM: the et/ prefix only -------------------------------------------------------

# The fetcher reads the wanted list, its own state and each unit's file, and
# writes those files and the status. ListBucket, so a missing file (no list
# yet) answers 404, not 403. No delete.
data "aws_iam_policy_document" "fetcher_et" {
  statement {
    sid       = "ReadWriteEtHandover"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/et/*"]
  }
  statement {
    sid       = "ListMirror"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mirror.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_et" {
  count = local.et_enabled ? 1 : 0

  name   = "et-handover"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_et.json
}

# The worker's one write: the wanted list. Its reads (the status and the
# units' files) are worker_mirror's (ingest.tf, the whole bucket). The S3
# interface endpoint's policy carries the same write (packs.tf
# WorkerWritesEtWantedList).
data "aws_iam_policy_document" "worker_et" {
  statement {
    sid       = "WriteEtWantedList"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/et/wanted.json"]
  }
}

resource "aws_iam_role_policy" "worker_et" {
  count = local.et_enabled ? 1 : 0

  name   = "et-wanted-list"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_et.json
}

# --- The gate: the worker side must be on -------------------------------------------

# The worker's ET_OBSERVATIONS (jobs.tf) is what writes et/wanted.json and
# loads what the pass fetched. With the flag on and that variable lost, the
# pass would run against no list, its heartbeat would stay green, and no unit
# would ever get an observation: so the plan fails instead. A resource of its
# own (nothing depends on it), so the tests can expect this failure; it holds
# nothing and costs nothing.
resource "terraform_data" "et_observations_gate" {
  count = local.et_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = try(aws_lambda_function.worker.environment[0].variables["ET_OBSERVATIONS"], "") == "on"
      error_message = "et_observations_enabled needs the worker Lambda's ET_OBSERVATIONS = \"on\" (infra/jobs.tf, beside DAM_OBSERVATIONS: ET_OBSERVATIONS = var.et_observations_enabled ? \"on\" : \"off\"). Without it the worker never writes et/wanted.json nor loads what the pass fetches. docs/deployment.md § Observed actual ET."
    }
  }
}

# --- The schedule -------------------------------------------------------------------

# Hourly at :50 (clear of the dams passes at :20, the GEFS pass at :38, the
# daily ingest at 03:00 and the DWS pass at 04:00), for the first backfill's
# sake: the pass reads at most one request a second, about four requests a
# unit a dekad (the header once a dekad, then each unit's table slices and
# tiles), so one 900 s run reads a couple of hundred unit-dekads, and a unit's
# history from 2018 (about 300 dekads) takes a few hours of runs. Once caught
# up, a run asks FAO nothing unless a dekad has ended (one new file every ten
# days, asked each run until it is published, about three days later) or a
# file's ETag is due its re-check (each file once in RECHECK_DAYS, 30, in
# water-use/observed/pass.ts), and still publishes its heartbeat and recency.
resource "aws_cloudwatch_event_rule" "et_dekadal" {
  name                = "${local.project}-et-dekadal"
  description         = "The fetcher's WaPOR pass, hourly: FAO WaPOR v3 dekadal actual ET averaged over each unit's farm parcels (the newest dekads first, then the history to 2018, each file's ETag re-checked monthly), into the mirror bucket ({\"mode\":\"et-dekadal\"}). Disabled until et_observations_enabled is set."
  schedule_expression = "cron(50 * * * ? *)"
  state               = local.et_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "et_dekadal" {
  count = local.et_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.et_dekadal.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "et-dekadal" })

  # A run stopped by an HTTP 403 or throttling must not ask again within
  # minutes: no retry here, and the pass itself leaves FAO alone for 24 hours
  # (or a longer Retry-After) after the stop (dams/observed/handover.ts pausedUntil).
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "fetcher_et_dekadal" {
  count = local.et_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeEtDekadal"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.et_dekadal.arn
}

# --- Alarms ---------------------------------------------------------------------------

# (a) Heartbeat: every completed pass publishes EtPassCompleted{Source=wapor}
# = 1 (an embedded metric in the fetcher's log, handover.ts etPassMetricLine),
# whatever it read. No datapoint for 18 hours (three 6-hour periods): the
# pass stopped running, fails before it ends, or is paused after FAO refused
# or throttled it (24 h, or a longer Retry-After). Missing data is breaching.
resource "aws_cloudwatch_metric_alarm" "et_pass_heartbeat" {
  count = local.et_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-et-pass-wapor"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = local.et_pass_metric
  namespace           = local.et_metric_namespace
  period              = 21600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The fetcher's WaPOR pass published no heartbeat for 18 hours: the hourly et-dekadal runs stopped, fail before the pass completes, or the source is paused after FAO's bucket refused or throttled it (24 h, or a longer Retry-After). Logs Insights on the fetcher log group: filter message.event = \"et_pass\" | fields message.stopped, message.reason, message.detail, message.written, message.failed, message.failedCodes. stopped refused / throttled, then paused = FAO answered HTTP 403 or 429/503 (the run stopped on purpose and waits out the pause; docs/deployment.md § Observed actual ET). The app keeps showing the observations it holds."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = "wapor"
  }
}

# (b) Data recency: EtObservationAgeDays{Source=wapor}, the days from the run
# back to the first day of the newest dekad any unit holds. A dekad is up to
# 11 days long and FAO publishes it about three days after it ends, so a
# healthy copy runs 3 to about 14 days behind; past et_recency_alarm_days
# WaPOR (or our pass over it) has stopped producing. Missing is breaching, as
# for the heartbeat (so turn the flag on once a unit has farm parcels).
resource "aws_cloudwatch_metric_alarm" "et_recency" {
  count = local.et_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-et-recency-wapor"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.et_recency_metric
  namespace           = local.et_metric_namespace
  period              = 86400
  statistic           = "Minimum"
  threshold           = var.et_recency_alarm_days
  alarm_description   = "The newest WaPOR dekad any unit holds began more than ${var.et_recency_alarm_days} days ago, or the WaPOR pass published no recency for two days. Check FAO's bucket (storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L2-AETI-D/) for the newest dekad's file before suspecting our pass; logs: filter message.event = \"et_pass\" on the fetcher log group (docs/deployment.md § Observed actual ET)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Source = "wapor"
  }
}
