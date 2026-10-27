# ----------------------------------------------------------------------------
# Data feeds (roadmap WP-2.10; docs/architecture.md § Data feeds,
# docs/deployment.md § Data feeds)
#
# The worker (jobs.tf) is in the private VPC with no internet, and the sources
# (CHIRPS and CHIRPS-GEFS on data.chc.ucsb.edu, DWS on www.dws.gov.za) are on
# the internet. Rather than a NAT (~$33/month + data), a small fetcher Lambda
# OUTSIDE the VPC does the downloading, and the two talk through two queues:
#
#   worker --SendMessage--> SQS `fetch-requests` --event source--> fetcher
#   fetcher --SendMessage--> SQS `ingest-results` --event source--> worker
#
# The fetcher has no database access and no credentials to one: its role can
# receive from `fetch-requests` and send to `ingest-results`, nothing else.
# What it sends is untrusted input; the worker validates it and merges it as
# the feed's acting user under RLS (backend/src/feeds/ingest.ts).
#
# Each queue dead-letters after 5 receives into its own DLQ, which alarms.
#
# The daily ingest (issue #604 R2-B, backend/src/ingest/daily.ts): once
# daily_ingest_enabled is set, an EventBridge rule invokes the same fetcher
# once a day with {"mode":"daily-ingest"}, and it copies the new CHIRPS
# preliminary days into the mirror bucket (ingest.tf), publishing
# MirrorLagDays{Product=prelim} as an embedded metric in its own log (no
# PutMetricData grant needed). Only then may its role read, write, list and
# delete in the mirror bucket. A run is never retried (a 403 must stop it;
# the next day's run tries again).
#
# The weekly DWS pass (issue #604 R3-B, backend/src/ingest/dws.ts): once
# dws_weekly_enabled is set, a daily rule invokes the fetcher with
# {"mode":"dws-weekly"}, and it re-reads each station some DWS feed names
# once a week (the newest two years, 1 request a second) into dws/ in the
# mirror bucket, publishing MirrorLagDays{Product=dws}. The worker hands it
# the station list (dws/stations.json, its one write to the bucket) and loads
# what it fetched into gauge_record (feeds/gaugeRecordLoad.ts): the fetcher
# has no database and the worker no internet, so the bucket carries the
# handover. A 403 or DWS's ScriptServer page stops the run, never retried.
# ----------------------------------------------------------------------------

locals {
  # A fetch reads up to 120 CHIRPS days (~4 range requests each, 6 at a time).
  fetcher_timeout_seconds              = 120
  fetch_requests_visibility_seconds    = 6 * local.fetcher_timeout_seconds
  ingest_results_visibility_seconds    = 6 * local.worker_timeout_seconds
  feed_queue_message_retention_seconds = 345600 # 4 days: a fetch older than that is stale anyway
}

# --- Queues ------------------------------------------------------------------

resource "aws_sqs_queue" "fetch_requests_dlq" {
  name                      = "${local.project}-fetch-requests-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "fetch_requests" {
  name                       = "${local.project}-fetch-requests"
  visibility_timeout_seconds = local.fetch_requests_visibility_seconds
  message_retention_seconds  = local.feed_queue_message_retention_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.fetch_requests_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "fetch_requests_dlq" {
  queue_url = aws_sqs_queue.fetch_requests_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.fetch_requests.arn]
  })
}

resource "aws_sqs_queue" "ingest_results_dlq" {
  name                      = "${local.project}-ingest-results-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "ingest_results" {
  name                       = "${local.project}-ingest-results"
  visibility_timeout_seconds = local.ingest_results_visibility_seconds
  message_retention_seconds  = local.feed_queue_message_retention_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_results_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "ingest_results_dlq" {
  queue_url = aws_sqs_queue.ingest_results_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ingest_results.arn]
  })
}

# --- Fetcher Lambda (no VPC) -----------------------------------------------------

resource "aws_iam_role" "fetcher_lambda" {
  name               = "${local.project}-fetcher-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs (its own log group only) are in iam.tf; no VPC access, no managed policy.

data "aws_iam_policy_document" "fetcher_lambda" {
  statement {
    sid       = "ConsumeFetchRequests"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.fetch_requests.arn]
  }
  statement {
    sid       = "SendIngestResults"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ingest_results.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_lambda" {
  name   = "feed-queues"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_lambda.json
}

resource "aws_cloudwatch_log_group" "fetcher" {
  name              = "/aws/lambda/${local.project}-fetcher"
  retention_in_days = var.lambda_log_retention_days
}

data "archive_file" "fetcher_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/fetcher_stub.zip"

  source {
    filename = "lambda-fetcher.mjs"
    content  = <<-EOT
      export const handler = async () => {
        throw new Error("Fetcher Lambda not yet deployed. Run the GitHub Actions deploy-backend workflow.");
      };
    EOT
  }
}

resource "aws_lambda_function" "fetcher" {
  function_name = "${local.project}-fetcher"
  description   = "Data feeds: downloads CHIRPS / CHIRPS-GEFS / DWS for a fetch request and sends the parsed days back. No VPC, no database (backend/src/lambda-fetcher.ts)."
  role          = aws_iam_role.fetcher_lambda.arn

  filename         = data.archive_file.fetcher_stub.output_path
  source_code_hash = data.archive_file.fetcher_stub.output_base64sha256

  handler       = "lambda-fetcher.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = local.fetcher_timeout_seconds
  memory_size   = 512

  # Bounds spend and how hard the public sources are hit at once.
  reserved_concurrent_executions = var.fetcher_reserved_concurrency

  # JSON logs, with the per-invocation platform lines dropped (lambda.tf,
  # local.lambda_logging).
  logging_config {
    log_format            = local.lambda_logging.log_format
    system_log_level      = local.lambda_logging.system_log_level
    application_log_level = local.lambda_logging.application_log_level
    # The group this file creates, with its retention (and filters).
    log_group = aws_cloudwatch_log_group.fetcher.name
  }

  # Deliberately no vpc_config: this is the one Lambda with internet access.

  environment {
    variables = {
      FEED_SOURCE              = "live"
      INGEST_RESULTS_QUEUE_URL = aws_sqs_queue.ingest_results.url
      # The copy the daily ingest writes (its role may only once daily_ingest_enabled is set).
      MIRROR_URL = "s3://${aws_s3_bucket.mirror.bucket}"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.fetcher,
    aws_iam_role_policy.lambda_logs["fetcher"],
    aws_iam_role_policy.fetcher_lambda,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

resource "aws_lambda_event_source_mapping" "fetcher_requests" {
  event_source_arn = aws_sqs_queue.fetch_requests.arn
  function_name    = aws_lambda_function.fetcher.arn
  # One fetch per invocation: each can take most of the timeout.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}

# --- The daily ingest (issue #604 R2-B) ----------------------------------------------

# The mirror bucket, only once the daily ingest is on: the per-feed mode never
# touches it. Delete, because a preliminary day the finals now hold has its
# chunks deleted; ListBucket, so an unwritten (all-NaN) chunk answers 404, not
# 403.
data "aws_iam_policy_document" "fetcher_mirror" {
  statement {
    sid       = "ReadWriteMirrorObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/*"]
  }
  statement {
    sid       = "ListMirror"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mirror.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_mirror" {
  count = var.daily_ingest_enabled ? 1 : 0

  name   = "write-mirror"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_mirror.json
}

# 03:00 UTC: after the Python job's rnl (02:00) and sat (02:20) runs, so a
# day whose final landed overnight is dropped, not copied, the same morning.
# CHC publishes a pentad's preliminary days two days after it ends; a daily
# run copies them the day they appear.
resource "aws_cloudwatch_event_rule" "daily_ingest" {
  name                = "${local.project}-daily-ingest"
  description         = "The fetcher's daily ingest: CHIRPS preliminary sat days into the data mirror ({\"mode\":\"daily-ingest\"}). Disabled until daily_ingest_enabled is set."
  schedule_expression = "cron(0 3 * * ? *)"
  state               = var.daily_ingest_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "daily_ingest" {
  count = var.daily_ingest_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.daily_ingest.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "daily-ingest" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "fetcher_daily_ingest" {
  count = var.daily_ingest_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeDailyIngest"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily_ingest.arn
}

# --- The weekly DWS pass (issue #604 R3-B) ----------------------------------------------

# dws/ only: the station list (read), each station's file and the status
# (written). ListBucket, so a missing file (no list yet) answers 404, not 403.
data "aws_iam_policy_document" "fetcher_dws" {
  statement {
    sid       = "ReadWriteDwsHandover"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/dws/*"]
  }
  statement {
    sid       = "ListMirror"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mirror.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_dws" {
  count = var.dws_weekly_enabled ? 1 : 0

  name   = "dws-handover"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_dws.json
}

# The worker's one write to the bucket: the station list. Its reads (the
# status and the stations' files) are worker_mirror's (ingest.tf); the S3
# endpoint's policy carries the same write (packs.tf).
data "aws_iam_policy_document" "worker_dws" {
  statement {
    sid       = "WriteDwsStationList"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/dws/stations.json"]
  }
}

resource "aws_iam_role_policy" "worker_dws" {
  count = var.dws_weekly_enabled ? 1 : 0

  name   = "dws-station-list"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_dws.json
}

# Daily at 04:00 UTC (06:00 in South Africa, after the daily ingest's 03:00),
# though each station is re-read only once a week (REFRESH_DAYS): a daily run
# spreads the stations over the fetcher's 120 s, and publishes the lag every
# day so the freshness alarm below can treat a missing day as breaching. A
# day with no station due sends DWS nothing.
resource "aws_cloudwatch_event_rule" "dws_weekly" {
  name                = "${local.project}-dws-weekly"
  description         = "The fetcher's weekly DWS pass: each DWS feed's station re-read once a week into the mirror bucket ({\"mode\":\"dws-weekly\"}). Disabled until dws_weekly_enabled is set."
  schedule_expression = "cron(0 4 * * ? *)"
  state               = var.dws_weekly_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "dws_weekly" {
  count = var.dws_weekly_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.dws_weekly.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "dws-weekly" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "fetcher_dws_weekly" {
  count = var.dws_weekly_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeDwsWeekly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dws_weekly.arn
}

# The pass's freshness: the oldest last good fetch of a listed station
# (MirrorLagDays{Product=dws}, an embedded metric in the fetcher's log).
# Breaching on missing data: a pass that stopped running alarms too. Gated
# on dws_weekly_enabled, or it would fire from the first apply.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_dws" {
  count = var.dws_weekly_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-dws"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.dws_weekly_lag_alarm_days
  alarm_description   = "A station the DWS feeds read was last fetched from DWS more than ${var.dws_weekly_lag_alarm_days} days ago, or the fetcher's weekly DWS pass published no lag for two days. Logs Insights on the fetcher log group: filter message.event = \"dws_weekly\" | fields message.stopped, message.reason, message.detail, message.fetched, message.failed. stopped refused / throttled / server_error = DWS answered HTTP 403, 429/503 or its ScriptServer page (the run stopped on purpose, docs/deployment.md § DWS gauge records). Feeds reading the store keep the days it holds meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "dws"
  }
}

# The schedule invokes asynchronously, and Lambda would retry a failed run
# twice by default: a run that met HTTP 403 must stop, not ask again within
# minutes. The SQS mode is a synchronous poll, so this doesn't touch it.
resource "aws_lambda_function_event_invoke_config" "fetcher" {
  function_name                = aws_lambda_function.fetcher.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

# --- The worker's side: send requests, consume results -------------------------------

data "aws_iam_policy_document" "worker_feeds" {
  statement {
    sid       = "SendFetchRequests"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.fetch_requests.arn]
  }
  statement {
    sid       = "ConsumeIngestResults"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.ingest_results.arn]
  }
}

resource "aws_iam_role_policy" "worker_feeds" {
  name   = "feed-queues"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_feeds.json
}

resource "aws_lambda_event_source_mapping" "worker_ingest_results" {
  event_source_arn                   = aws_sqs_queue.ingest_results.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  # Only the failed records are retried (lambda-worker.ts reports them).
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2 # counted in worker_reserved_concurrency (4 triggers x 2)
  }

  depends_on = [aws_iam_role_policy.worker_feeds]
}

# --- Alarms --------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "fetch_requests_dlq_depth" {
  count = local.alarms_essential ? 1 : 0
  # Fires on each new arrival, not on depth: see local.dlq_arrivals_expression (alarms.tf).
  alarm_name          = "${local.project}-fetch-requests-dlq-arrivals"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.dlq_arrivals_evaluation_periods
  datapoints_to_alarm = 1
  threshold           = 0
  alarm_description   = "A fetch request was dead-lettered: the fetcher Lambda failed to send its result 5 times. The feed shows stale until the next scheduled fetch; check the fetcher's logs. ${local.dlq_arrivals_note}"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "arrivals"
    expression  = local.dlq_arrivals_expression
    label       = "Messages newly dead-lettered"
    return_data = true
  }
  metric_query {
    id = "visible"
    metric {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      period      = 300
      stat        = "Maximum"
      dimensions = {
        QueueName = aws_sqs_queue.fetch_requests_dlq.name
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "ingest_results_dlq_depth" {
  count = local.alarms_essential ? 1 : 0
  # Fires on each new arrival, not on depth: see local.dlq_arrivals_expression (alarms.tf).
  alarm_name          = "${local.project}-ingest-results-dlq-arrivals"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.dlq_arrivals_evaluation_periods
  datapoints_to_alarm = 1
  threshold           = 0
  alarm_description   = "A fetch result was dead-lettered: the worker failed 5 times to queue it (usually the database was unreachable). Redrive it once the worker is healthy. ${local.dlq_arrivals_note}"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "arrivals"
    expression  = local.dlq_arrivals_expression
    label       = "Messages newly dead-lettered"
    return_data = true
  }
  metric_query {
    id = "visible"
    metric {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      period      = 300
      stat        = "Maximum"
      dimensions = {
        QueueName = aws_sqs_queue.ingest_results_dlq.name
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "fetcher_errors" {
  count               = local.alarms_full ? 1 : 0
  alarm_name          = "${local.project}-fetcher-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The fetcher Lambda crashed or timed out (a source that fails or answers garbage is not an error here: that is recorded on the feed and shown in the app)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.fetcher.function_name
  }
}

# The fetcher hit its reserved concurrency: a throttled SQS poll still counts
# a receive, so a sustained run dead-letters fetch requests.
resource "aws_cloudwatch_metric_alarm" "fetcher_throttles" {
  count               = local.alarms_full ? 1 : 0
  alarm_name          = "${local.project}-fetcher-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The fetcher Lambda hit reserved_concurrent_executions (fetcher_reserved_concurrency): throttled SQS messages burn receive counts toward the fetch-requests DLQ. Find what is flooding fetch-requests (a feed schedule, a manual refresh loop) before raising the limit."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.fetcher.function_name
  }
}

# A fetch request nobody is consuming: the fetcher is still the stub (no
# backend release yet), its event source is disabled, or it is throttled to
# nothing. Each request is otherwise retried at most 5 times x the 12-minute
# visibility timeout (~1 hour) before the DLQ, so an hour-old message is one
# that isn't being worked; without this it would expire unseen after 4 days.
resource "aws_cloudwatch_metric_alarm" "fetch_requests_age" {
  count               = local.alarms_full ? 1 : 0
  alarm_name          = "${local.project}-fetch-requests-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 3600
  alarm_description   = "A fetch request has waited over an hour in fetch-requests: the fetcher isn't consuming it (not deployed yet, its event source disabled, or throttled). Feeds go stale meanwhile, and the request expires after 4 days. Check the fetcher's function, its SQS trigger and the fetcher-throttles alarm."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.fetch_requests.name
  }
}

# A fetch the fetcher answered as failed: the Lambda succeeded, so
# fetcher_errors never sees it. lambda-fetcher.ts logs one line per failed
# answer:
#   {"event":"feed_fetch_failed","feedId":"…","fetchJobId":"…","source":"dws","reason":"unavailable","detail":"HTTP 403"}
# the ids, its source, a reason code (timeout, throttled, refused,
# invalid_request, unavailable, format, internal, other) and the failure's safe detail (an HTTP
# status, one of the live client's fixed texts, or our fixed label for a server
# error page or a DWS format check), never the stored message,
# which can name a grid cell or a station. One failure alarms: feeds fetch a few times a
# day, and SNS only notifies on the change to ALARM, so a source that stays
# down alarms once, not on every fetch.
resource "aws_cloudwatch_log_metric_filter" "feed_fetch_failed" {
  count          = local.alarms_full ? 1 : 0
  name           = "${local.project}-feed-fetch-failed"
  log_group_name = aws_cloudwatch_log_group.fetcher.name
  pattern        = "{ $.message.event = \"feed_fetch_failed\" }"

  metric_transformation {
    name          = "FeedFetchFailed"
    namespace     = "${local.project}/Application"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "feed_fetch_failed" {
  count               = local.alarms_full ? 1 : 0
  alarm_name          = "${local.project}-feed-fetch-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.feed_fetch_failed[0].metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.feed_fetch_failed[0].metric_transformation[0].namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A data-feed fetch failed (the fetcher answered it as failed; the feed shows failing in the app, then stale). Logs Insights on the fetcher log group: filter message.event = \"feed_fetch_failed\" | stats count() by message.source, message.reason, message.detail. unavailable/timeout = the source is down or slow (wait for the next fetch); throttled = HTTP 429/503, the source is limiting us (the fetcher pauses the host; lower fetcher_reserved_concurrency if it persists); refused = HTTP 403, the source banned this server's address (CHC bans an address for volume: the fetcher pauses the host an hour and the feed backs off hours; if it persists, lower fetcher_reserved_concurrency and contact chc-help@geog.ucsb.edu); format = the source changed its format (a code fix); invalid_request/internal = a bug. Runbook: docs/deployment.md § Data feeds."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}
