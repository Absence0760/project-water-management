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
#   {"event":"feed_fetch_failed","feedId":"…","source":"dws","reason":"unavailable"}
# the feed's id, its source and a reason code (timeout, invalid_request,
# unavailable, format, internal, other), never the stored message, which can
# name a grid cell or a station. One failure alarms: feeds fetch a few times a
# day, and SNS only notifies on the change to ALARM, so a source that stays
# down alarms once, not on every fetch.
resource "aws_cloudwatch_log_metric_filter" "feed_fetch_failed" {
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
  alarm_name          = "${local.project}-feed-fetch-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.feed_fetch_failed.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.feed_fetch_failed.metric_transformation[0].namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A data-feed fetch failed (the fetcher answered it as failed; the feed shows failing in the app, then stale). Logs Insights on the fetcher log group: filter message.event = \"feed_fetch_failed\" | stats count() by message.source, message.reason. unavailable/timeout = the source is down or slow (wait for the next fetch); format = the source changed its format (a code fix); invalid_request/internal = a bug. Runbook: docs/deployment.md § Data feeds."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}
