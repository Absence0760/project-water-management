# ----------------------------------------------------------------------------
# Daily reference evaporation into the data mirror (issue #604 R5-E;
# ingest/agera5.py and ingest/nasapower.py, docs/deployment.md § AgERA5
# reference evaporation and § NASA POWER reference evaporation (fallback),
# docs/data-sources.md § agera5)
#
#   EventBridge (daily) --async {"product":"agera5_et0","mode":"monthly"}--> mirror-ingest Lambda (ingest.tf)
#   mirror-ingest --GetSecretValue--> <project>/ingest/cds-key (era5land.tf: the same CDS account)
#   mirror-ingest --submit / status / results (politely)--> Copernicus CDS
#                    (sis-agrometeorological-indicators, reference_evapotranspiration)
#   mirror-ingest --Put/Get--> the mirror bucket: agera5_et0/ (Zarr, finals, 0.1 deg)
#                             and ingest-state/agera5_et0/requests.json
#
#   EventBridge (daily) --async {"product":"power_et0","mode":"recent","days":30}--> mirror-ingest Lambda
#   mirror-ingest --GET, 1 a second, one parameter a request--> power.larc.nasa.gov
#   mirror-ingest --Put/Get--> the mirror bucket: power_et0/ (Zarr, daily, 0.1 deg)
#
#   both --PutMetricData--> MirrorLagDays{Product=agera5_et0 | power_et0}
#
# The same function as CHIRPS's finals and ERA5-Land: two more products its
# handler takes. AgERA5's runs work as ERA5-Land's do (submit on one run,
# collect on a later one, never waiting inside the Lambda); NASA POWER's
# recent run reads the last days of the region in a few regional requests.
#
# No new secret. AgERA5 is on the same Copernicus CDS account as ERA5-Land,
# so its runs read the key from era5land.tf's secret
# (aws_secretsmanager_secret.cds_key, created with no value; the operator
# puts it in). That secret's read policy (ingest_cds_key) and the Lambda's
# CDS_KEY_SECRET_ARN (ingest.tf) are unconditional, so they are there
# whichever of era5l_enabled and agera5_enabled is on. NASA POWER needs no
# key (its API takes none).
#
# agera5_enabled and power_et0_enabled (both default false) each turn on one
# daily rule and its lag alarm; each needs ingest_image_tag (the function)
# set first.
# ----------------------------------------------------------------------------

variable "agera5_enabled" {
  description = "Turn on the AgERA5 reference-evaporation ingest (agera5.tf, issue #604 R5-E): the daily EventBridge rule that sends the mirror-ingest Lambda {\"product\":\"agera5_et0\",\"mode\":\"monthly\"} and the agera5_et0 freshness alarm (breaching on missing data). Needs ingest_image_tag set, the CDS key in the <project>/ingest/cds-key secret (ERA5-Land's) and the AgERA5 dataset's licence accepted on the CDS account: docs/deployment.md § AgERA5 reference evaporation. Off by default."
  type        = bool
  default     = false
}

variable "agera5_lag_alarm_days" {
  description = "MirrorLagDays{Product=agera5_et0} past this alarms (agera5.tf). A healthy copy runs up to about 43 days behind: month M's request goes in about 10 days after M ends and is collected a day or two later, so just before that the newest held day is the end of M-1, about 31 + 12 days back (ingest/agera5.py)."
  type        = number
  default     = 50

  validation {
    condition     = var.agera5_lag_alarm_days >= 45 && floor(var.agera5_lag_alarm_days) == var.agera5_lag_alarm_days
    error_message = "agera5_lag_alarm_days must be a whole number of days, at least 45: a healthy AgERA5 copy runs up to ~43 days behind."
  }
}

variable "power_et0_enabled" {
  description = "Turn on the NASA POWER reference-evaporation ingest, the fallback for the days AgERA5 doesn't hold yet (agera5.tf, issue #604 R5-E): the daily EventBridge rule that sends the mirror-ingest Lambda {\"product\":\"power_et0\",\"mode\":\"recent\",\"days\":30} and the power_et0 freshness alarm (breaching on missing data). Needs ingest_image_tag set; no key. docs/deployment.md § NASA POWER reference evaporation (fallback). Off by default."
  type        = bool
  default     = false
}

variable "power_et0_lag_alarm_days" {
  description = "MirrorLagDays{Product=power_et0} past this alarms (agera5.tf). POWER publishes 2-7 days behind and the job asks for days up to today - 3, so a healthy copy is 3-8 days behind (ingest/nasapower.py)."
  type        = number
  default     = 10

  validation {
    condition     = var.power_et0_lag_alarm_days >= 8 && floor(var.power_et0_lag_alarm_days) == var.power_et0_lag_alarm_days
    error_message = "power_et0_lag_alarm_days must be a whole number of days, at least 8: a healthy NASA POWER copy runs up to ~8 days behind."
  }
}

locals {
  # After the CHIRPS finals (02:00, 02:20), ERA5-Land (02:40) and IMERG's 04:40 run.
  agera5_schedule    = "cron(0 5 * * ? *)"
  power_et0_schedule = "cron(20 5 * * ? *)"

  agera5_on    = var.agera5_enabled && local.ingest_enabled
  power_et0_on = var.power_et0_enabled && local.ingest_enabled
}

# --- AgERA5: the daily rule --------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "agera5" {
  count = var.agera5_enabled ? 1 : 0

  name                = "${local.project}-mirror-ingest-agera5-et0"
  description         = "Daily AgERA5 run of the mirror ingest (monthly mode): collect the CDS requests that are ready, submit the newest complete month of FAO-56 reference evapotranspiration and any due re-check (ingest/agera5.py)."
  schedule_expression = local.agera5_schedule
  state               = "ENABLED"

  lifecycle {
    precondition {
      condition     = local.ingest_enabled
      error_message = "agera5_enabled needs ingest_image_tag set: the rule invokes the mirror-ingest function (docs/deployment.md § AgERA5 reference evaporation)."
    }
  }
}

# Never retried, like the other ingest rules: a refused run must stop, and
# the next day's run does the same work.
resource "aws_cloudwatch_event_target" "agera5" {
  count = local.agera5_on ? 1 : 0

  rule  = aws_cloudwatch_event_rule.agera5[0].name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = "agera5_et0", mode = "monthly" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "agera5" {
  count = local.agera5_on ? 1 : 0

  statement_id  = "AllowEventBridge-agera5-et0"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.agera5[0].arn
}

# --- NASA POWER: the daily rule ----------------------------------------------------------

resource "aws_cloudwatch_event_rule" "power_et0" {
  count = var.power_et0_enabled ? 1 : 0

  name                = "${local.project}-mirror-ingest-power-et0"
  description         = "Daily NASA POWER run of the mirror ingest (recent mode): the last 30 days of the region's daily weather, FAO-56 reference evapotranspiration computed from it (ingest/nasapower.py)."
  schedule_expression = local.power_et0_schedule
  state               = "ENABLED"

  lifecycle {
    precondition {
      condition     = local.ingest_enabled
      error_message = "power_et0_enabled needs ingest_image_tag set: the rule invokes the mirror-ingest function (docs/deployment.md § NASA POWER reference evaporation (fallback))."
    }
  }
}

resource "aws_cloudwatch_event_target" "power_et0" {
  count = local.power_et0_on ? 1 : 0

  rule  = aws_cloudwatch_event_rule.power_et0[0].name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = "power_et0", mode = "recent", days = 30 })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "power_et0" {
  count = local.power_et0_on ? 1 : 0

  statement_id  = "AllowEventBridge-power-et0"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.power_et0[0].arn
}

# --- Freshness ----------------------------------------------------------------------------
#
# Every run of either product publishes MirrorLagDays{Product=…} (today minus
# the newest held day: agera5_et0's finalThrough, power_et0's
# prelimThrough), a failed one too. Breaching on missing data: a job that
# stopped running is as stale as one that runs and copies nothing.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_agera5" {
  count = local.agera5_on && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-agera5-et0"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.agera5_lag_alarm_days
  alarm_description   = "The data mirror's AgERA5 reference evaporation is more than ${var.agera5_lag_alarm_days} days behind, or the mirror-ingest job published no agera5_et0 lag for two days. Check the mirror-ingest log group (\"agera5_et0:\" lines) and ingest-state/agera5_et0/requests.json in the mirror bucket: a request that failed 5 times stops resubmitting, and a 401/403 from the CDS stops the run on purpose (a wrong or expired key, or the AgERA5 licence not accepted on the account; docs/deployment.md § AgERA5 reference evaporation). Feeds keep reading NASA POWER for the newest days meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "agera5_et0"
  }
}

resource "aws_cloudwatch_metric_alarm" "mirror_lag_power_et0" {
  count = local.power_et0_on && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-power-et0"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.power_et0_lag_alarm_days
  alarm_description   = "The data mirror's NASA POWER reference evaporation (the fallback for AgERA5's newest days) is more than ${var.power_et0_lag_alarm_days} days behind, or the mirror-ingest job published no power_et0 lag for two days. Check the mirror-ingest log group (\"power_et0:\" lines): a 403 from power.larc.nasa.gov stops the run on purpose and is not retried (docs/deployment.md § NASA POWER reference evaporation (fallback))."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "power_et0"
  }
}
