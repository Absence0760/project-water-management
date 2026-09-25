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
# NOT here yet: WP-2.10 adds the `fetch-requests` / `ingest-results` queues
# and the fetcher Lambda outside the VPC; WP-2.13 gives the worker SES.
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

  # Bounds spend and DB connections (2 x a pool of 2), and how many jobs run at once.
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
      JOB_TRANSPORT       = "sqs"
      JOBS_QUEUE_URL      = aws_sqs_queue.jobs.url
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

  scaling_config {
    maximum_concurrency = 2 # SQS event sources can't go lower; reserved concurrency caps it anyway
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

  # Only these roles, only this queue, only the actions they use.
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
  alarm_description   = "A background job is dead. Its project's GET /projects/:id/jobs shows the kind and the (sanitised) reason. Until WP-2.13 emails the project's owners, this alarm is how anyone hears."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}
