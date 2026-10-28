# ----------------------------------------------------------------------------
# C3S seasonal forecasts and hindcasts into the data mirror (issue #620 step 5;
# ingest/c3s_seasonal.py, docs/deployment.md § C3S seasonal forecasts,
# docs/data-sources.md § c3s-seasonal)
#
#   EventBridge (daily, 14:20 UTC) --async {"product":"c3s","mode":"monthly"}--> mirror-ingest Lambda (ingest.tf)
#   mirror-ingest --GetSecretValue--> <project>/ingest/cds-key (era5land.tf: the same CDS account)
#   mirror-ingest --submit / status / results (politely)--> Copernicus CDS
#                    (seasonal-original-single-levels, total_precipitation)
#   mirror-ingest --Put/Get--> the mirror bucket: c3s/<YYYY-MM>/ and c3s-hc/<system>/<MM>/
#                             (Zarr, 1 deg), c3s/index.json and ingest-state/c3s/requests.json
#   mirror-ingest --PutMetricData--> MirrorLagDays{Product=c3s}
#
# The same function as ERA5-Land and AgERA5: one more product its handler
# takes, on the same submit-then-collect machinery (a run never waits: it
# submits, records the request's id, and a later day's run collects it).
#
# The schedule: C3S releases ECMWF's forecast from init month M on the 6th of
# M at 12 UTC and the other centres' on the 10th at 12 UTC. A daily run at
# 14:20 UTC is the first after each release (the job asks for a system's
# init only 30 minutes after its release, c3srequest.release_at), and the
# other days' runs collect what is ready and drain the hindcast backfill.
# 14:20 is clear of ECMWF ENS's runs (10:00-13:40, ecmwf.tf) and IMERG's
# (10:40, 16:40, imerg.tf), so the function's two reserved slots stay free.
#
# No new secret: the runs read era5land.tf's CDS key secret (created with no
# value; the operator puts it in), whose read policy and the Lambda's
# CDS_KEY_SECRET_ARN are unconditional. The operator also accepts the
# seasonal dataset's licence and its Additional licence to use non European
# contributions on that CDS account; until then the CDS answers 403 and the
# run stops for the day (polite.StopRun).
#
# The hindcasts (1993-2016) are backfilled by hand, one invocation per init
# month: docs/deployment.md § C3S seasonal forecasts.
#
# c3s_enabled (default false, variables.tf) turns on the daily rule and the
# lag alarm; it needs ingest_image_tag (the function) set first.
#
# Cost: the mirror bucket grows by roughly 150 MB a month of forecasts (~390
# members over the 9 systems, ~0.4 MB each gzipped) and, once, roughly 20-25
# GB of hindcasts (~200 members x 24 years x 12 months), about $0.70 a month
# in S3 Standard; a few minutes of Lambda a month; one alarm metric. A
# hindcast's download is a few hundred MB, inside the function's 2 GB /tmp
# and 3008 MB (ingest.tf); the decode keeps one array of it in memory.
# ----------------------------------------------------------------------------

locals {
  c3s_schedule = "cron(20 14 * * ? *)"
  c3s_on       = var.c3s_enabled && local.ingest_enabled
}

resource "aws_cloudwatch_event_rule" "c3s" {
  count = var.c3s_enabled ? 1 : 0

  name                = "${local.project}-mirror-ingest-c3s"
  description         = "Daily C3S seasonal run of the mirror ingest (monthly mode): collect the CDS requests that are ready, submit each system's newest released init (ECMWF from the 6th, the others from the 10th, 12 UTC) and the wanted hindcasts (ingest/c3s_seasonal.py)."
  schedule_expression = local.c3s_schedule
  state               = "ENABLED"

  lifecycle {
    precondition {
      condition     = local.ingest_enabled
      error_message = "c3s_enabled needs ingest_image_tag set: the rule invokes the mirror-ingest function (docs/deployment.md § C3S seasonal forecasts)."
    }
  }
}

# Never retried, like the other ingest rules: a refused run must stop, and
# the next day's run does the same work.
resource "aws_cloudwatch_event_target" "c3s" {
  count = local.c3s_on ? 1 : 0

  rule  = aws_cloudwatch_event_rule.c3s[0].name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = "c3s", mode = "monthly" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "c3s" {
  count = local.c3s_on ? 1 : 0

  statement_id  = "AllowEventBridge-c3s"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.c3s[0].arn
}

# --- Freshness ----------------------------------------------------------------------------
#
# Every c3s run publishes MirrorLagDays{Product=c3s} (today minus the 1st of
# the newest init month every system is held for), a failed one too. With no
# complete init held there is no value to give; breaching on missing data
# makes that, and a job that stopped running, alarm like a stale copy.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_c3s" {
  count = local.c3s_on && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-c3s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.c3s_lag_alarm_days
  alarm_description   = "The data mirror's C3S seasonal copy has no complete init month newer than ${var.c3s_lag_alarm_days} days, or the mirror-ingest job published no c3s lag for two days. Check the mirror-ingest log group (\"c3s:\" lines), c3s/index.json (which systems each init holds) and ingest-state/c3s/requests.json in the mirror bucket: a request that failed 5 times stops resubmitting (RequestsFailed: often a system C3S retired, ingest/c3srequest.py SYSTEMS), and a 401/403 from the CDS stops the run on purpose (a wrong or expired key, or the seasonal dataset's licences not accepted; docs/deployment.md § C3S seasonal forecasts)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "c3s"
  }
}
