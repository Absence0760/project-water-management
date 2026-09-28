# ----------------------------------------------------------------------------
# Background jobs (roadmap WP-2.8; docs/architecture.md § Background work,
# docs/deployment.md § Background jobs)
#
# The Postgres `job` table (backend/migrations/016_jobs.sql) is the queue's
# source of truth. AWS only carries wake-ups and a schedule:
#
#   API Lambda --SendMessage--> SQS `jobs` --event source--> worker Lambda
#   EventBridge rate(5 minutes) ---------------------------> worker Lambda
#
# Either way the worker runs one tick (backend/src/lambda-worker.ts): purge
# old jobs, claim due jobs, run each as its acting user under RLS. A lost wake
# message costs at most one schedule interval, never a job. A message the
# worker fails on 5 times lands in the DLQ, which alarms.
#
# The worker is in the private VPC (it talks to Postgres) and reaches SQS
# through ONE interface endpoint whose policy admits only these two roles and
# this one queue: no NAT. The API reaches it through the same endpoint to
# send wake-ups.
#
# The data feeds' queues and the fetcher Lambda outside the VPC are in
# feeds.tf (WP-2.10), and the report renderer's in reports.tf (WP-2.15); the
# worker reaches their queues through the same endpoint. reports.tf also gives
# the worker SES (the report emails), through ses.tf's endpoint.
# ----------------------------------------------------------------------------

locals {
  # Visibility must outlast the function (AWS: at least 6x the timeout for an
  # event source), or a message is redelivered while its tick still runs.
  worker_timeout_seconds  = 300
  jobs_visibility_seconds = 6 * local.worker_timeout_seconds

  # The worker runs jobs one at a time: a pool of 2 is plenty, and keeps
  # reserved concurrency x pool small against db.t4g.micro's ~80 connections.
  worker_database_url = "${local.database_url}&application_name=worker"
}

# --- Queues ------------------------------------------------------------------

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${local.project}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum: time to look
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.project}-jobs"
  visibility_timeout_seconds = local.jobs_visibility_seconds
  message_retention_seconds  = 345600 # 4 days; the table keeps the job regardless
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

# Only the jobs queue may dead-letter here.
resource "aws_sqs_queue_redrive_allow_policy" "jobs_dlq" {
  queue_url = aws_sqs_queue.jobs_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# --- Worker Lambda -------------------------------------------------------------

resource "aws_iam_role" "worker_lambda" {
  name               = "${local.project}-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "worker_lambda_vpc" {
  role       = aws_iam_role.worker_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Consume the jobs queue (the event source mapping polls as this role) and
# send to it (a handler that queues follow-up work wakes the worker too).
data "aws_iam_policy_document" "worker_lambda" {
  statement {
    sid       = "ConsumeJobsQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.jobs.arn]
  }
  statement {
    sid       = "WakeJobsQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "worker_lambda" {
  name   = "jobs-queue"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_lambda.json
}

# The API may only send wake-ups to the jobs queue.
data "aws_iam_policy_document" "lambda_jobs_send" {
  statement {
    sid       = "WakeJobsQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "lambda_jobs_send" {
  name   = "jobs-queue-send"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_jobs_send.json
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.project}-worker"
  retention_in_days = var.lambda_log_retention_days
}

data "archive_file" "worker_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/worker_stub.zip"

  source {
    filename = "lambda-worker.mjs"
    content  = <<-EOT
      export const handler = async () => {
        throw new Error("Worker Lambda not yet deployed. Run the GitHub Actions deploy-backend workflow.");
      };
    EOT
  }
}

resource "aws_lambda_function" "worker" {
  function_name = "${local.project}-worker"
  description   = "Background jobs: claims due rows of the job table and runs each as its acting user (backend/src/lambda-worker.ts)."
  role          = aws_iam_role.worker_lambda.arn

  filename         = data.archive_file.worker_stub.output_path
  source_code_hash = data.archive_file.worker_stub.output_base64sha256

  handler       = "lambda-worker.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = local.worker_timeout_seconds
  memory_size   = var.worker_memory_mb

  # Bounds spend and DB connections (8 x a pool of 2), and how many jobs run at
  # once. At least the sum of the four SQS triggers' maximum_concurrency (jobs,
  # ingest-results, render-results, mail-events: 4 x 2), or throttled pollers
  # burn receive counts into the DLQs (variables.tf, guarded by a tftest).
  reserved_concurrent_executions = var.worker_reserved_concurrency

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.worker_lambda.id]
  }

  environment {
    variables = {
      DATABASE_URL        = local.worker_database_url
      DB_POOL_MAX         = "2"
      NODE_EXTRA_CA_CERTS = local.rds_ca_path
      # A re-run job stores a run, which the backend stamps under a key derived
      # from the session secret (backend/src/runs/stamp.ts, docs/security.md
      # § Run stamps). The worker never signs or reads a session.
      AUTH_JWT_SECRET = local.auth_jwt_secret
      JOB_TRANSPORT   = "sqs"
      JOBS_QUEUE_URL  = aws_sqs_queue.jobs.url
      # Data feeds (feeds.tf): no internet here, so fetches go to the fetcher.
      FEED_FETCHER             = "sqs"
      FETCH_REQUESTS_QUEUE_URL = aws_sqs_queue.fetch_requests.url
      # Server-side reports (reports.tf): no Chromium here, so renders go to
      # the renderer; the worker records them and emails the link (SES).
      REPORT_RENDERER           = "sqs"
      RENDER_REQUESTS_QUEUE_URL = aws_sqs_queue.render_requests.url
      STORAGE                   = "s3"
      REPORTS_BUCKET            = aws_s3_bucket.reports.bucket
      MAIL_TRANSPORT            = "ses"
      MAIL_FROM                 = "${var.mail_from_display_name} <${local.mail_from_address}>"
      SITE_URL                  = local.site_origin
      SES_CONFIGURATION_SET     = aws_sesv2_configuration_set.main.configuration_set_name
      # Alert emails (WP-2.13, docs/deployment.md § Alerts). Only the worker
      # signs unsubscribe links; the API checks a link by its hash alone.
      # Rotating the secret (taint the resource) breaks every link in mails
      # already sent. ALERTS_ENABLED is the kill switch (runbook: alert storm).
      ALERTS_TOKEN_SECRET = random_password.alerts_token_secret.result
      ALERTS_ENABLED      = var.alerts_enabled ? "true" : "false"
      ALERTS_DAILY_CAP    = "5"
      # SES bounces and complaints (ses.tf): a record is read as one only
      # when it came from this queue (lambda-worker.ts fromMailEventsQueue).
      MAIL_EVENTS_QUEUE_ARN = aws_sqs_queue.mail_events.arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.worker,
    aws_iam_role_policy_attachment.worker_lambda_vpc,
    aws_iam_role_policy.worker_lambda,
    aws_vpc_endpoint.sqs,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

resource "aws_lambda_event_source_mapping" "worker_jobs" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
  # Coalesce a burst of wake-ups into one tick.
  maximum_batching_window_in_seconds = 5
  # The worker reports the records it failed (lambda-worker.ts), so one bad
  # record is retried alone instead of taking its whole batch to the DLQ.
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    # SQS event sources can't go lower. The worker's reserved concurrency must
    # cover the sum over its four triggers (worker_reserved_concurrency).
    maximum_concurrency = 2
  }
}

# --- Schedule ----------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "worker_tick" {
  name                = "${local.project}-worker-tick"
  description         = "Runs a job-queue tick every 5 minutes: due jobs, retries, and anything whose wake message was lost."
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "worker_tick" {
  rule = aws_cloudwatch_event_rule.worker_tick.name
  arn  = aws_lambda_function.worker.arn
}

resource "aws_lambda_permission" "worker_tick" {
  statement_id  = "AllowEventBridgeTick"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.worker_tick.arn
}

# --- Network: the worker's security group and the SQS interface endpoint -------

resource "aws_security_group" "worker_lambda" {
  name        = "${local.project}-worker-lambda"
  description = "Worker Lambda ENIs: egress to Postgres and the SQS endpoint only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-worker-lambda" }
}

resource "aws_vpc_security_group_egress_rule" "worker_to_rds" {
  security_group_id            = aws_security_group.worker_lambda.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_worker" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.worker_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the worker Lambda"
}

resource "aws_security_group" "vpce_sqs" {
  name        = "${local.project}-vpce-sqs"
  description = "SQS interface endpoint: 443 from the API and worker Lambdas only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-vpce-sqs" }
}

resource "aws_vpc_security_group_ingress_rule" "vpce_sqs_from_api" {
  security_group_id            = aws_security_group.vpce_sqs.id
  referenced_security_group_id = aws_security_group.api_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the API Lambda"
}

resource "aws_vpc_security_group_ingress_rule" "vpce_sqs_from_worker" {
  security_group_id            = aws_security_group.vpce_sqs.id
  referenced_security_group_id = aws_security_group.worker_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the worker Lambda"
}

resource "aws_vpc_security_group_egress_rule" "api_to_vpce_sqs" {
  security_group_id            = aws_security_group.api_lambda.id
  referenced_security_group_id = aws_security_group.vpce_sqs.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "SQS endpoint"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_vpce_sqs" {
  security_group_id            = aws_security_group.worker_lambda.id
  referenced_security_group_id = aws_security_group.vpce_sqs.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "SQS endpoint"
}

# With private DNS, the SDK's default sqs.<region>.amazonaws.com resolves to
# the endpoint's ENIs: no app change, no endpoint override.
resource "aws_vpc_endpoint" "sqs" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.sqs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = slice(aws_subnet.private[*].id, 0, var.sqs_endpoint_az_count)
  security_group_ids  = [aws_security_group.vpce_sqs.id]
  private_dns_enabled = true

  # Only these roles, only these queues, only the actions they use.
  policy = data.aws_iam_policy_document.sqs_endpoint.json

  tags = { Name = "${local.project}-sqs" }
}

data "aws_iam_policy_document" "sqs_endpoint" {
  statement {
    sid       = "ApiSendsWakeUps"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.lambda.arn]
    }
  }
  statement {
    sid       = "WorkerUsesJobsQueue"
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.jobs.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
  # Reports (reports.tf): the worker asks the renderer and reads its answers.
  statement {
    sid       = "WorkerSendsRenderRequests"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.render_requests.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
  statement {
    sid       = "WorkerConsumesRenderResults"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.render_results.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
  # SES bounces and complaints (ses.tf): the worker reads them.
  statement {
    sid       = "WorkerConsumesMailEvents"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.mail_events.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
  # Data feeds (feeds.tf): the worker asks the fetcher and reads its answers.
  statement {
    sid       = "WorkerSendsFetchRequests"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.fetch_requests.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
  statement {
    sid       = "WorkerConsumesIngestResults"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.ingest_results.arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
}

# --- Alarms --------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "jobs_dlq_depth" {
  alarm_name          = "${local.project}-jobs-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "A jobs-queue message was dead-lettered: the worker failed its tick 5 times (usually the database was unreachable). Jobs are safe in the job table; check the worker's logs, then redrive or purge the DLQ."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.jobs_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.project}-worker-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The worker Lambda failed a tick (a job's own failure is recorded in the job table and does not count here)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }
}

# The worker hit its reserved concurrency: its SQS pollers are being throttled,
# and a throttled message still counts a receive, so a sustained run of these
# ends with messages in the DLQs. Raise worker_reserved_concurrency (and check
# the RDS connection budget) or find what is flooding the queues.
resource "aws_cloudwatch_metric_alarm" "worker_throttles" {
  alarm_name          = "${local.project}-worker-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The worker Lambda hit reserved_concurrent_executions: throttled SQS messages burn receive counts toward the DLQs — investigate."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }
}

# Heartbeat. The backlog metric below only exists once a tick succeeds, and
# its alarm treats missing data as OK, so a worker that has stopped running
# (the schedule disabled or deleted, reserved concurrency set to 0) never trips
# it. The 5-minute tick alone invokes the worker ~3 times per 15 minutes, and a
# throttled invocation isn't counted, so zero means nothing is reaching it.
# Missing data is breaching: no datapoints *is* the failure. A tick that fails
# still counts as an invocation (worker-errors covers it), and so does the stub
# before the first backend release, which throws on every tick: the heartbeat
# stays OK on a first deploy while worker-errors fires until the release.
resource "aws_cloudwatch_metric_alarm" "worker_heartbeat" {
  alarm_name          = "${local.project}-worker-heartbeat"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The worker Lambda was not invoked for 15 minutes, though its tick runs every 5: background jobs, feeds, alert emails and reports have stopped. Check that the worker-tick EventBridge rule is enabled and targets the worker, that the worker's reserved concurrency is not 0, and the worker-tick-failed alarm."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }
}

# EventBridge could not deliver the tick (the worker's invoke permission
# removed, the target's function gone, or the invoke refused past
# EventBridge's retries).
resource "aws_cloudwatch_metric_alarm" "worker_tick_failed" {
  alarm_name          = "${local.project}-worker-tick-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedInvocations"
  namespace           = "AWS/Events"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "EventBridge failed to invoke the worker for its 5-minute tick. Check the worker-tick rule's target and the worker's lambda:InvokeFunction permission for events.amazonaws.com (terraform plan shows the drift), then the worker's reserved concurrency."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    RuleName = aws_cloudwatch_event_rule.worker_tick.name
  }
}

# Emitted by every tick as an embedded metric (lambda-worker.ts metricLine).
resource "aws_cloudwatch_metric_alarm" "jobs_backlog" {
  alarm_name          = "${local.project}-jobs-backlog"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "OldestDueJobAgeSeconds"
  namespace           = "${local.project}/Jobs"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.jobs_backlog_alarm_seconds
  alarm_description   = "The oldest due job has waited longer than the threshold: the worker is not keeping up, or not running."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# A job that is dead (out of attempts, or a failure no retry can fix) logs a
# structured line (runner.ts). The filter matches the event name only; the
# line carries ids and the kind, never a payload or an error text.
resource "aws_cloudwatch_log_metric_filter" "job_dead" {
  name           = "${local.project}-job-dead"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"job_dead\" }"

  metric_transformation {
    name          = "JobDead"
    namespace     = "${local.project}/Jobs"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "job_dead" {
  alarm_name          = "${local.project}-job-dead"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.job_dead.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.job_dead.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A background job is dead. Its project's GET /projects/:id/jobs shows the kind and the (sanitised) reason. Projects with the job_dead alert on also email their owners (WP-2.13)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# --- Alert emails (WP-2.13, backend/src/alerts/) --------------------------------

# Signs the one-click unsubscribe links in alert emails (alerts/tokens.ts).
# Only the worker holds it. Replacing it
# (`terraform apply -replace=random_password.alerts_token_secret`) breaks the
# unsubscribe link in every alert already sent; "Manage your alerts" still works.
resource "random_password" "alerts_token_secret" {
  length  = 48
  special = false
}

# An alert storm: far more alert mail in 5 minutes than normal operation sends
# (each person gets at most ALERTS_DAILY_CAP immediate mails a day, so a burst
# means many people or a loop). Runbook: docs/deployment.md § Runbooks,
# "Alert storm" (the kill switch is var.alerts_enabled).
resource "aws_cloudwatch_metric_alarm" "alert_storm" {
  alarm_name          = "${local.project}-alert-storm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "AlertMailsSent"
  namespace           = "${local.project}/Jobs"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alert_storm_mails_per_5min
  alarm_description   = "More alert emails in 5 minutes than the storm threshold. Runbook: docs/deployment.md § Runbooks, Alert storm (kill switch: alerts_enabled = false)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# Alert mails the transport kept refusing (SES throttling, a rejected address).
resource "aws_cloudwatch_metric_alarm" "alert_mail_failures" {
  alarm_name          = "${local.project}-alert-mail-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "AlertMailsFailed"
  namespace           = "${local.project}/Jobs"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Alert emails failing to send for 15 minutes. Check the worker's alert_send_failed log lines (event ids, never addresses) and SES."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}
