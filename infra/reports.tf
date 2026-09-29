# ----------------------------------------------------------------------------
# Server-side PDF reports (roadmap WP-2.15 Phase B, issue #26;
# docs/architecture.md § Server-side reports, docs/deployment.md § Reports)
#
# A report_render job prints the site's own report route in headless
# Chromium. The worker (jobs.tf) is a zip Lambda in the private VPC with no
# internet: it can host neither Chromium nor a route to the site. So, like the
# data feeds' fetcher (feeds.tf), a renderer Lambda OUTSIDE the VPC does it,
# and the two talk through two queues:
#
#   worker --SendMessage--> SQS `render-requests` --event source--> renderer
#   renderer --PutObject--> S3 reports bucket (reports/<project>/<report>.pdf)
#   renderer --SendMessage--> SQS `render-results` --event source--> worker
#
# The renderer is a CONTAINER IMAGE (backend/renderer.Dockerfile: Playwright's
# image, the same Chromium build e2e uses) in its own ECR repository, 2 GB,
# 120 s. It opens https://<domain>/projects/:id/report through CloudFront and
# the WAF like any browser, signing in with the single-use render token from
# the request (docs/security.md § Render tokens). Its role can receive
# render-requests, send render-results and put objects under reports/ in the
# bucket: no database, no secrets, no read of any PDF.
#
# The API hands out downloads as pre-signed GETs (60 s, one per click, behind
# a 302 from GET /projects/:id/reports/:jobId/pdf), so it alone may
# read reports/. The bucket is private (public access blocked, bucket-owner
# objects, TLS only), SSE-S3 encrypted, and deletes every PDF after 7 days.
#
# The function is created only once its first image is in ECR
# (renderer_image_tag, docs/deployment.md § Reports): Lambda can't be created
# from an image that doesn't exist yet. The queues, bucket and repository come
# first; deploy-backend.yml pushes the image; the operator then sets the tag
# and applies. Until then render requests wait in their queue (4 days).
# ----------------------------------------------------------------------------

locals {
  renderer_function_name   = "${local.project}-renderer"
  renderer_function_arn    = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.renderer_function_name}"
  renderer_timeout_s       = 120
  renderer_enabled         = var.renderer_image_tag != ""
  report_retention_days    = 7
  render_queue_retention_s = 345600 # 4 days
}

# --- The bucket -------------------------------------------------------------------

resource "aws_s3_bucket" "reports" {
  bucket = "${local.project}-reports-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket                  = aws_s3_bucket.reports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, not a customer-managed key: the bucket is private (public access
# blocked, reached only by the API and renderer roles and short presigned
# URLs), and a CMK would add a key and kms grants to both roles for no change
# in who can read a PDF. docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Every PDF goes after 7 days; the job tick deletes its row a day later
# (backend/src/reports/schedule.ts purgeReports).
resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    id     = "expire-reports"
    status = "Enabled"

    filter {
      prefix = "reports/"
    }

    expiration {
      days = local.report_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "reports_bucket_policy" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.reports.arn,
      "${aws_s3_bucket.reports.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "reports" {
  bucket = aws_s3_bucket.reports.id
  policy = data.aws_iam_policy_document.reports_bucket_policy.json

  depends_on = [aws_s3_bucket_public_access_block.reports]
}

# --- Queues ------------------------------------------------------------------------

resource "aws_sqs_queue" "render_requests_dlq" {
  name                      = "${local.project}-render-requests-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "render_requests" {
  name                       = "${local.project}-render-requests"
  visibility_timeout_seconds = 6 * local.renderer_timeout_s
  message_retention_seconds  = local.render_queue_retention_s
  # Carries a single-use render token: encrypted at rest.
  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.render_requests_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "render_requests_dlq" {
  queue_url = aws_sqs_queue.render_requests_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.render_requests.arn]
  })
}

resource "aws_sqs_queue" "render_results_dlq" {
  name                      = "${local.project}-render-results-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "render_results" {
  name                       = "${local.project}-render-results"
  visibility_timeout_seconds = 6 * local.worker_timeout_seconds
  message_retention_seconds  = local.render_queue_retention_s
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.render_results_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "render_results_dlq" {
  queue_url = aws_sqs_queue.render_results_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.render_results.arn]
  })
}

# --- The image repository -------------------------------------------------------------

resource "aws_ecr_repository" "renderer" {
  name = "${local.project}-renderer"
  # A deployed tag is the release version; it never moves.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep the last 10 images (a rollback reaches back ten releases); an untagged
# layer left by a failed push goes after a day.
resource "aws_ecr_lifecycle_policy" "renderer" {
  repository = aws_ecr_repository.renderer.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after a day"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 10 release images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
        action       = { type = "expire" }
      },
    ]
  })
}

# Lambda pulls the image as the service, for this one function only.
data "aws_iam_policy_document" "renderer_ecr" {
  statement {
    sid     = "LambdaPullsRendererImage"
    actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "aws:sourceArn"
      values   = [local.renderer_function_arn]
    }
  }
}

resource "aws_ecr_repository_policy" "renderer" {
  repository = aws_ecr_repository.renderer.name
  policy     = data.aws_iam_policy_document.renderer_ecr.json
}

# --- The renderer Lambda (no VPC) ----------------------------------------------------------

resource "aws_iam_role" "renderer_lambda" {
  name               = "${local.project}-renderer-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs only: no VPC access, nothing else managed.
resource "aws_iam_role_policy_attachment" "renderer_lambda_logs" {
  role       = aws_iam_role.renderer_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "renderer_lambda" {
  statement {
    sid       = "ConsumeRenderRequests"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.render_requests.arn]
  }
  statement {
    sid       = "SendRenderResults"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.render_results.arn]
  }
  # Write PDFs; never read, list or delete them.
  statement {
    sid       = "PutReportPdfs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "renderer_lambda" {
  name   = "render-queues-and-pdfs"
  role   = aws_iam_role.renderer_lambda.id
  policy = data.aws_iam_policy_document.renderer_lambda.json
}

resource "aws_cloudwatch_log_group" "renderer" {
  name              = "/aws/lambda/${local.renderer_function_name}"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "renderer" {
  count = local.renderer_enabled ? 1 : 0

  function_name = local.renderer_function_name
  description   = "Server-side PDF reports: prints the site's report route in headless Chromium and stores the PDF. No VPC, no database (backend/src/lambda-renderer.ts)."
  role          = aws_iam_role.renderer_lambda.arn

  package_type = "Image"
  image_uri    = "${aws_ecr_repository.renderer.repository_url}:${var.renderer_image_tag}"
  # The image is built on the x86_64 CI runner (deploy-backend.yml).
  architectures = ["x86_64"]
  timeout       = local.renderer_timeout_s
  memory_size   = var.renderer_memory_mb
  # Chromium's profile and cache live in /tmp.
  ephemeral_storage {
    size = 1024
  }

  # Bounds spend and how many Chromiums run at once.
  reserved_concurrent_executions = var.renderer_reserved_concurrency

  # Deliberately no vpc_config: it reaches the site through CloudFront.

  environment {
    variables = {
      RENDER_SITE_URL          = local.site_origin
      RENDER_API_URL           = "${local.site_origin}/api"
      REPORT_RENDER_TIMEOUT_MS = tostring((local.renderer_timeout_s - 20) * 1000)
      STORAGE                  = "s3"
      REPORTS_BUCKET           = aws_s3_bucket.reports.bucket
      RENDER_RESULTS_QUEUE_URL = aws_sqs_queue.render_results.url
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.renderer,
    aws_iam_role_policy_attachment.renderer_lambda_logs,
    aws_iam_role_policy.renderer_lambda,
    aws_ecr_repository_policy.renderer,
  ]

  lifecycle {
    # deploy-backend.yml moves the function to each release's image.
    ignore_changes = [image_uri]
  }
}

resource "aws_lambda_event_source_mapping" "renderer_requests" {
  count = local.renderer_enabled ? 1 : 0

  event_source_arn = aws_sqs_queue.render_requests.arn
  function_name    = aws_lambda_function.renderer[0].arn
  # One render per invocation: each can take most of the timeout.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}

# --- The worker's side: send requests, consume results, email the link -------------------

data "aws_iam_policy_document" "worker_reports" {
  statement {
    sid       = "SendRenderRequests"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.render_requests.arn]
  }
  statement {
    sid       = "ConsumeRenderResults"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.render_results.arn]
  }
}

resource "aws_iam_role_policy" "worker_reports" {
  name   = "render-queues"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_reports.json
}

# The worker emails report links through SES, as no-reply@, the same way and
# through the same endpoint as the API (ses.tf).
resource "aws_iam_role_policy" "worker_ses" {
  name   = "ses-send-no-reply"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.lambda_ses.json
}

resource "aws_vpc_security_group_ingress_rule" "vpce_ses_from_worker" {
  security_group_id            = aws_security_group.vpce_ses.id
  referenced_security_group_id = aws_security_group.worker_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the worker Lambda"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_vpce_ses" {
  security_group_id            = aws_security_group.worker_lambda.id
  referenced_security_group_id = aws_security_group.vpce_ses.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "SES API endpoint"
}

resource "aws_lambda_event_source_mapping" "worker_render_results" {
  event_source_arn                   = aws_sqs_queue.render_results.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  # Only the failed records are retried (lambda-worker.ts reports them).
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2 # counted in worker_reserved_concurrency (4 triggers x 2)
  }

  depends_on = [aws_iam_role_policy.worker_reports]
}

# --- The API's side: pre-signed downloads ---------------------------------------------------

# A pre-signed GET carries the signer's rights, so the API may read PDFs, and
# nothing else in the bucket. Signing is local: no network path is needed.
data "aws_iam_policy_document" "lambda_reports" {
  statement {
    sid       = "ReadReportPdfs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "lambda_reports" {
  name   = "reports-read"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_reports.json
}

# --- Alarms -----------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "render_requests_dlq_depth" {
  alarm_name          = "${local.project}-render-requests-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "A render request was dead-lettered: the renderer Lambda failed to answer it 5 times. The report shows as failed after an hour; check the renderer's logs. Its render token has expired, so a redrive can't render it: purge the DLQ."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.render_requests_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "render_results_dlq_depth" {
  alarm_name          = "${local.project}-render-results-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "A render result was dead-lettered: the worker failed 5 times to queue it (usually the database was unreachable). Redrive it once the worker is healthy; the PDF is already stored."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.render_results_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "renderer_errors" {
  count = local.renderer_enabled ? 1 : 0

  alarm_name          = "${local.project}-renderer-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The renderer Lambda crashed or timed out (a report page that refuses or a slow render is an answer, recorded on the report, not an error here)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.renderer[0].function_name
  }
}

# A render creeping towards the 120 s limit (the app's own cap is 100 s).
resource "aws_cloudwatch_metric_alarm" "renderer_duration" {
  count = local.renderer_enabled ? 1 : 0

  alarm_name          = "${local.project}-renderer-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  extended_statistic  = "p90"
  threshold           = 60000
  alarm_description   = "Report renders are taking over a minute (p90). A local render of the largest example takes ~3 s; check the site's and the API's latency, and the renderer's memory."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.renderer[0].function_name
  }
}
