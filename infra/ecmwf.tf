# ----------------------------------------------------------------------------
# The ECMWF ENS forecast into the data mirror (issue #604 D17, R4-C;
# docs/deployment.md § The data mirror → ECMWF, docs/data-sources.md
# ecmwf-ens)
#
#   EventBridge (every 20 min, 10:00–13:40 UTC) --async--> mirror-ingest Lambda
#       {"product": "ecmwf", "mode": "daily"}            (ingest/ecmwf.py)
#   mirror-ingest --GET index + Range, 1/s--> ecmwf-forecasts (S3, eu-central-1)
#   mirror-ingest --Put/Get/List/Delete--> the mirror bucket's ecmwf/ and
#                                          ingest-state/ecmwf/
#   mirror-ingest --PutMetricData--> MirrorLagDays{Product=ecmwf}
#
# The same Lambda, image, role and DLQ as the CHIRPS finals (ingest.tf): its
# role already writes the whole mirror bucket and publishes to the mirror's
# metric namespace, and it runs outside the VPC with internet access. ECMWF's
# open data needs no key, so there is no secret.
#
# Why that schedule: ECMWF publishes the 00 UTC run's 0.1° files about two
# hours after the 0.25° ones (09:40 UTC on 2026-10-26), and reading one issue
# politely takes ~13 minutes (765 requests at one a second), about a
# Lambda's 900 s. So the job runs every 20 minutes from 10:00 to 13:40 UTC:
# each run picks up the steps the last one saved, a run that finds the issue
# held asks nothing (no request at all), and a run that finds the lease
# held (the previous one still going) ends at once. 12 invocations a day,
# never two at once (the lease; reserved concurrency 2 is shared with the
# CHIRPS finals runs at 02:00 and 02:20). The feeds read it from 14:00 UTC
# (253_feed_source_ecmwf.sql).
#
# Gated by ecmwf_enabled (default false) as well as the ingest function
# existing (ingest_image_tag): the rule stays DISABLED, with no target, and
# there is no freshness alarm, until both. Turn it on only with an image
# built from requirements.txt that includes eccodes (ingest/requirements.c.in).
#
# Freshness: MirrorLagDays{Product=ecmwf}, today minus the newest issue held,
# published by every run that knows the copy. A healthy copy reads 0 after the
# morning's runs, 1 before; at 2 neither today's nor yesterday's issue is held
# and every ECMWF feed waits. Two days at 2 or more, or no datapoint for two
# days (treat_missing_data = breaching: the job stopped running, or the copy
# holds no issue yet, when it publishes nothing), alarms.
#
# Cost: ~1.1 GB a day from ECMWF's bucket (AWS's open data programme pays its
# egress), ~1,500 PUTs and ~4 MB of new Zarr a day, plus ~1.4 GB a year of
# archived means for the quantile-mapping fit; a few cents a month. Lambda:
# ~15 minutes of 3 GB a day, ~$0.05/day in af-south-1.
# ----------------------------------------------------------------------------

variable "ecmwf_enabled" {
  description = "Turn on the ECMWF ENS forecast copy (ecmwf.tf, issue #604 R4-C): the mirror-ingest job's daily ECMWF runs (every 20 minutes, 10:00–13:40 UTC) and its freshness alarm (MirrorLagDays{Product=ecmwf}, breaching on missing data). Needs ingest_image_tag too, with an image whose requirements include eccodes. Off (the default) until then, or the alarm would fire for a job that doesn't run. Runbook: docs/deployment.md § The data mirror → ECMWF."
  type        = bool
  default     = false
}

locals {
  ecmwf_enabled = var.ecmwf_enabled && local.ingest_enabled
  # Every 20 minutes from 10:00 to 13:40 UTC (see the header).
  ecmwf_schedule = "cron(0/20 10-13 * * ? *)"
  # MirrorLagDays{Product=ecmwf} at or past this alarms: neither today's nor yesterday's issue held.
  ecmwf_lag_alarm_days = 2
}

resource "aws_cloudwatch_event_rule" "ecmwf_ingest" {
  name                = "${local.project}-mirror-ingest-ecmwf"
  description         = "ECMWF ENS forecast into the data mirror (ingest/ecmwf.py): every 20 minutes 10:00-13:40 UTC, each run resuming the last; a no-op once the day's issue is held. Disabled until ecmwf_enabled and ingest_image_tag are set."
  schedule_expression = local.ecmwf_schedule
  state               = local.ecmwf_enabled ? "ENABLED" : "DISABLED"
}

# A delivery that fails is not retried: the next run, 20 minutes later, does
# the same work (and a run that met a 403 must not be retried at all).
resource "aws_cloudwatch_event_target" "ecmwf_ingest" {
  count = local.ecmwf_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.ecmwf_ingest.name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = "ecmwf", mode = "daily" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 600
  }
}

resource "aws_lambda_permission" "ecmwf_ingest" {
  count = local.ecmwf_enabled ? 1 : 0

  statement_id  = "AllowEventBridge-ecmwf"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ecmwf_ingest.arn
}

resource "aws_cloudwatch_metric_alarm" "mirror_lag_ecmwf" {
  count = local.ecmwf_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-ecmwf"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = local.ecmwf_lag_alarm_days
  alarm_description   = "The data mirror's newest ECMWF ENS issue is ${local.ecmwf_lag_alarm_days} or more days old (ECMWF forecast feeds wait), or the mirror-ingest job published no ECMWF lag for two days (it stopped running, fails before it measures, or holds no issue yet). Logs Insights on the mirror-ingest log group: filter event = \"mirror_ingest\" and product = \"ecmwf\" | fields stopped, working, stepsDone, refusedAt, newest. stopped refused = ECMWF answered HTTP 403 (the run stopped on purpose; docs/deployment.md § The data mirror → ECMWF). Feeds keep the forecast they have meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "ecmwf"
  }
}
