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
# Politeness to CHC (issue #604; docs/architecture.md § Data feeds →
# Throttling). CHC's limits are per public address: their bot protection
# blocks one for hours above about 2 requests a second, and they answer 429
# past 20 open connections. They asked (2026-10-27) for one file at a time and
# about 1 request a second in total across all our Lambdas. Within one
# fetcher instance the live client keeps to that (backend/src/feeds/http.ts
# PACE_*). Across instances, fetch-requests is a FIFO queue whose message
# group is the source's host (`chc`, `dws`; jobs/handlers/feed-fetch.ts
# fetchGroup): SQS hands Lambda one message of a group at a time, so at most
# one fetch per host runs at once, whatever the concurrency.
#
# Why not reserved concurrency 1: an SQS trigger's maximum_concurrency is at
# least 2, and a reservation below it throttles the trigger, and each
# throttled receive counts towards the DLQ's 5 (AWS: "Don't set maximum
# concurrency higher than the function's reserved concurrency"). The message
# groups cap it without throttling: concurrency is the lower of the groups
# and maximum_concurrency.
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
#
# The cutover (issue #604 R3-C; docs/deployment.md § The cutover): once
# chirps_source = "mirror" and dws_source = "store", every feed fetch reads
# our copy or store inside the worker's own job, and nothing uses the two
# queues above. local.per_feed_fetching is then false, and the queues, their
# DLQs and alarms, both event source mappings, the roles' queue grants, the
# S3-free SQS endpoint statement (jobs.tf) and the worker's FEED_FETCHER /
# FETCH_REQUESTS_QUEUE_URL are not created. The fetcher itself stays, for its
# scheduled modes. Flipping either flag back and applying brings them back.
# ----------------------------------------------------------------------------

locals {
  # Whether any feed still fetches through the fetcher (the queues below):
  # until both CHIRPS and DWS read our copy and store (issue #604 R3-C).
  per_feed_fetching = !(var.chirps_source == "mirror" && var.dws_source == "store")
  per_feed_count    = local.per_feed_fetching ? 1 : 0

  # At about a request a second a CHIRPS day is 3–10 requests for one cell,
  # plus one per extra grid row of a box: a 120-day window of one cell's
  # finals is ~10 minutes, and a box's doesn't fit. A fetch short of time
  # answers with the days it finished and the backfill goes on
  # (backend/src/feeds/sources/chirps.ts fetchChirpsCells). A forecast is used whole: 16 files of 2 requests plus
  # one per grid row of its cells, so a box of 25 rows is ~430 requests, ~9
  # minutes. 900 s, Lambda's longest, fits it; the rare fetch that reads two
  # issues of such a box (a partly published one, then yesterday's) answers
  # "did not answer in time" and retries in 15 minutes. A long fetch holds
  # its host's message group, but the throughput is the request rate either way.
  fetcher_timeout_seconds = 900
  # FIFO: an in-flight message holds its whole group until it is deleted or
  # comes back, so this is how long a crashed fetch holds up the next. The
  # 6x the timeout the other queues keep is for throttled receives, which the
  # message groups rule out (concurrency 2 <= reserved 2): twice the timeout,
  # which Lambda requires to be at least the function's.
  fetch_requests_visibility_seconds    = 2 * local.fetcher_timeout_seconds
  ingest_results_visibility_seconds    = 6 * local.worker_timeout_seconds
  feed_queue_message_retention_seconds = 345600 # 4 days: a fetch older than that is stale anyway
}

# --- Queues ------------------------------------------------------------------

resource "aws_sqs_queue" "fetch_requests_dlq" {
  count = local.per_feed_count

  # A FIFO queue's DLQ must be FIFO too.
  name                      = "${local.project}-fetch-requests-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "fetch_requests" {
  count = local.per_feed_count

  # FIFO, one message group per source host: see the header (politeness to CHC).
  name       = "${local.project}-fetch-requests.fifo"
  fifo_queue = true
  # The worker sends a deduplication id (the fetch job's id), so the content needn't be hashed.
  content_based_deduplication = false
  visibility_timeout_seconds  = local.fetch_requests_visibility_seconds
  message_retention_seconds   = local.feed_queue_message_retention_seconds
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.fetch_requests_dlq[0].arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "fetch_requests_dlq" {
  count = local.per_feed_count

  queue_url = aws_sqs_queue.fetch_requests_dlq[0].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.fetch_requests[0].arn]
  })
}

resource "aws_sqs_queue" "ingest_results_dlq" {
  count = local.per_feed_count

  name                      = "${local.project}-ingest-results-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "ingest_results" {
  count = local.per_feed_count

  name                       = "${local.project}-ingest-results"
  visibility_timeout_seconds = local.ingest_results_visibility_seconds
  message_retention_seconds  = local.feed_queue_message_retention_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_results_dlq[0].arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "ingest_results_dlq" {
  count = local.per_feed_count

  queue_url = aws_sqs_queue.ingest_results_dlq[0].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ingest_results[0].arn]
  })
}

# --- Fetcher Lambda (no VPC) -----------------------------------------------------

resource "aws_iam_role" "fetcher_lambda" {
  name               = "${local.project}-fetcher-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs (its own log group only) are in iam.tf; no VPC access, no managed policy.
# The queue grants only while per-feed fetching is on.

data "aws_iam_policy_document" "fetcher_lambda" {
  count = local.per_feed_count

  statement {
    sid       = "ConsumeFetchRequests"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.fetch_requests[0].arn]
  }
  statement {
    sid       = "SendIngestResults"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ingest_results[0].arn]
  }
}

resource "aws_iam_role_policy" "fetcher_lambda" {
  count = local.per_feed_count

  name   = "feed-queues"
  role   = aws_iam_role.fetcher_lambda.id
  policy = data.aws_iam_policy_document.fetcher_lambda[0].json
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
  description   = "Data feeds: downloads CHIRPS / CHIRPS-GEFS / DWS for a fetch request and sends the parsed days back, and runs the mirror's daily and weekly passes. No VPC, no database (backend/src/lambda-fetcher.ts)."
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
    variables = merge(
      {
        FEED_SOURCE = "live"
        # The copy the daily ingest writes (its role may only once daily_ingest_enabled is set).
        MIRROR_URL = "s3://${aws_s3_bucket.mirror.bucket}"
        # The contact in the user agent CHC asked for (backend/src/feeds/http.ts userAgent).
        FEEDS_CONTACT = var.feeds_contact
      },
      # Where it answers a fetch request, only while there are any (local.per_feed_fetching).
      local.per_feed_fetching ? {
        INGEST_RESULTS_QUEUE_URL = one(aws_sqs_queue.ingest_results[*].url)
      } : {}
    )
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
  count = local.per_feed_count

  event_source_arn = aws_sqs_queue.fetch_requests[0].arn
  function_name    = aws_lambda_function.fetcher.arn
  # One fetch per invocation: each can take most of the timeout.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # The least AWS allows. A FIFO queue caps concurrency at its active message
  # groups too (two: chc, dws), so CHC sees one fetch at a time (header).
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

# The GEFS pass (issue #604 R3-A, backend/src/ingest/gefs.ts): the newest
# complete CHIRPS-GEFS issue into the mirror, on its own rule with
# {"mode":"daily-ingest","pass":"gefs"}. Not after the preliminary pass at
# 03:00: CHC issues each forecast around 08:26-08:30 UTC, so a 03:00 run would
# always copy yesterday's, and the two passes' requests at one a second (up to
# ~80 + ~64) don't fit the fetcher's 120 s. 08:38, before the CHIRPS-GEFS
# feeds fall due at 08:45 (111_feed_daily_only), then hourly to 11:38 for a
# late issue; a run that finds the day's issue held asks CHC nothing, and
# after a 403 the run leaves gefs/refused.json, so the later runs that UTC day
# ask nothing either (each run is a fresh invocation; a pause in a warm
# container wouldn't hold).
resource "aws_cloudwatch_event_rule" "gefs_ingest" {
  name                = "${local.project}-gefs-ingest"
  description         = "The fetcher's GEFS pass: the newest complete CHIRPS-GEFS issue into the data mirror ({\"mode\":\"daily-ingest\",\"pass\":\"gefs\"}). Disabled until daily_ingest_enabled is set."
  schedule_expression = "cron(38 8-11 * * ? *)"
  state               = var.daily_ingest_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "gefs_ingest" {
  count = var.daily_ingest_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.gefs_ingest.name
  arn   = aws_lambda_function.fetcher.arn
  input = jsonencode({ mode = "daily-ingest", pass = "gefs" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "fetcher_gefs_ingest" {
  count = var.daily_ingest_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeGefsIngest"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.gefs_ingest.arn
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
  count = local.per_feed_count

  statement {
    sid       = "SendFetchRequests"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.fetch_requests[0].arn]
  }
  statement {
    sid       = "ConsumeIngestResults"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.ingest_results[0].arn]
  }
}

resource "aws_iam_role_policy" "worker_feeds" {
  count = local.per_feed_count

  name   = "feed-queues"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_feeds[0].json
}

resource "aws_lambda_event_source_mapping" "worker_ingest_results" {
  count = local.per_feed_count

  event_source_arn                   = aws_sqs_queue.ingest_results[0].arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  # Only the failed records are retried (lambda-worker.ts reports them).
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2 # counted in worker_reserved_concurrency (4 triggers x 2; 3 after the cutover)
  }

  depends_on = [aws_iam_role_policy.worker_feeds]
}

# --- Alarms --------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "fetch_requests_dlq_depth" {
  count = local.alarms_essential && local.per_feed_fetching ? 1 : 0
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
        QueueName = aws_sqs_queue.fetch_requests_dlq[0].name
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "ingest_results_dlq_depth" {
  count = local.alarms_essential && local.per_feed_fetching ? 1 : 0
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
        QueueName = aws_sqs_queue.ingest_results_dlq[0].name
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
# a receive, so a sustained run dead-letters fetch requests; after the cutover
# a throttled scheduled run (daily ingest, GEFS, DWS weekly) is simply lost.
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
  alarm_description   = "The fetcher Lambda hit reserved_concurrent_executions (fetcher_reserved_concurrency): throttled SQS messages burn receive counts toward the fetch-requests DLQ (while per-feed fetching is on), and a throttled scheduled run (daily ingest, GEFS or DWS weekly pass) is dropped, not retried. Find what is flooding the fetcher (a feed schedule, a manual refresh loop, overlapping schedules) before raising the limit."
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
  count               = local.alarms_full && local.per_feed_fetching ? 1 : 0
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
    QueueName = aws_sqs_queue.fetch_requests[0].name
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
  # Only the per-feed mode logs it.
  count          = local.alarms_full && local.per_feed_fetching ? 1 : 0
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
  count               = local.alarms_full && local.per_feed_fetching ? 1 : 0
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

# --- The cutover's state moves (issue #604 R3-C) ------------------------------------

# Each of these gained count = local.per_feed_count: the existing object is
# instance [0], so an apply with per-feed fetching still on changes nothing.
moved {
  from = aws_sqs_queue.fetch_requests_dlq
  to   = aws_sqs_queue.fetch_requests_dlq[0]
}
moved {
  from = aws_sqs_queue.fetch_requests
  to   = aws_sqs_queue.fetch_requests[0]
}
moved {
  from = aws_sqs_queue_redrive_allow_policy.fetch_requests_dlq
  to   = aws_sqs_queue_redrive_allow_policy.fetch_requests_dlq[0]
}
moved {
  from = aws_sqs_queue.ingest_results_dlq
  to   = aws_sqs_queue.ingest_results_dlq[0]
}
moved {
  from = aws_sqs_queue.ingest_results
  to   = aws_sqs_queue.ingest_results[0]
}
moved {
  from = aws_sqs_queue_redrive_allow_policy.ingest_results_dlq
  to   = aws_sqs_queue_redrive_allow_policy.ingest_results_dlq[0]
}
moved {
  from = aws_iam_role_policy.fetcher_lambda
  to   = aws_iam_role_policy.fetcher_lambda[0]
}
moved {
  from = aws_lambda_event_source_mapping.fetcher_requests
  to   = aws_lambda_event_source_mapping.fetcher_requests[0]
}
moved {
  from = aws_iam_role_policy.worker_feeds
  to   = aws_iam_role_policy.worker_feeds[0]
}
moved {
  from = aws_lambda_event_source_mapping.worker_ingest_results
  to   = aws_lambda_event_source_mapping.worker_ingest_results[0]
}
