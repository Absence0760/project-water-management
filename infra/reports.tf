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
# Downloads go through the site's own CloudFront distribution, behind the WAF
# (issue #126): GET /projects/:id/reports/:jobId/pdf checks membership and
# 302s to a CloudFront signed URL (60 s, one per click) on /reports/<project>/
# <report>.pdf, which CloudFront serves from this bucket through its origin
# access control. Only the distribution may read reports/ (the bucket policy
# pins its ARN); the API signs with a key pair Terraform generates and never
# touches the bucket. The bucket is private (public access blocked,
# bucket-owner objects, TLS only), SSE-S3 encrypted, and deletes every PDF
# after 7 days.
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
# blocked, written only by the renderer role and read only by CloudFront's
# origin access control for short signed URLs), and a CMK would need a key
# policy for CloudFront and a grant for the renderer for no change in who can
# read a PDF. docs/security.md § Accepted IaC findings.
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
  # Only this distribution (through the report-download behaviour's OAC) reads
  # PDFs; CloudFront itself refuses any request without a valid signature.
  statement {
    sid       = "AllowCloudFrontReadReportPdfs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }

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

# How Lambda gets the image (same account, AWS: "only one side needs to allow
# access", https://docs.aws.amazon.com/lambda/latest/dg/images-create.html#configuration-images-permissions):
#
# - The renderer's execution role may pull from this repository
#   (renderer_ecr_pull, below). That grant alone is enough to pull.
# - The repository policy carries the statement Lambda itself looks for, in
#   the shape and under the Sid AWS documents, narrowed to this one function.
#   When a CreateFunction or UpdateFunctionCode finds no such statement,
#   Lambda tries to add one, which needs ecr:SetRepositoryPolicy on the
#   caller. Neither the deploy role nor anything else here holds that, and
#   none should: with the statement in place, Lambda has nothing to add.
#   The deploy role may read the policy (oidc.tf, RendererImageLambdaCheck)
#   so Lambda can see the statement when it updates the function.
#
# After the first apply, confirm nothing added a statement of its own:
# `aws ecr get-repository-policy` shows exactly this one (docs/deployment.md).
data "aws_iam_policy_document" "renderer_ecr" {
  statement {
    sid     = "LambdaECRImageRetrievalPolicy"
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

# Logs (its own log group only) are in iam.tf; no VPC access, no managed policy.

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

# Pull its own image: this repository only, the two actions a pull uses.
data "aws_iam_policy_document" "renderer_ecr_pull" {
  statement {
    sid       = "PullRendererImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.renderer.arn]
  }
}

resource "aws_iam_role_policy" "renderer_ecr_pull" {
  name   = "renderer-image-pull"
  role   = aws_iam_role.renderer_lambda.id
  policy = data.aws_iam_policy_document.renderer_ecr_pull.json
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
    aws_iam_role_policy.lambda_logs["renderer"],
    aws_iam_role_policy.renderer_ecr_pull,
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

# --- Downloads: CloudFront signed URLs ------------------------------------------------------
#
# The distribution's /reports/* behaviour (s3_cloudfront.tf) reads this bucket
# through its own OAC and serves a request only when it carries a CloudFront
# signed URL from a key in this key group: the WAF and its per-IP rate limit
# see every transfer, and the API never reads the bucket (no s3: grant at
# all). The API signs with the private half, from its runtime secret
# (secrets.tf); CLOUDFRONT_KEY_PAIR_ID in its environment names the public
# key (lambda.tf).
#
# The operator generates the key pair (infra/prod.sops.yaml.example), so
# Terraform never creates or holds the private key:
#   - the PRIVATE key is the sops key cloudfront_private_key, an ephemeral
#     variable like auth_jwt_secret (variables.tf, scripts/tf.sh) that reaches
#     only the API's write-only runtime secret (secrets.tf): never state;
#   - the PUBLIC keys are plain inputs, var.report_download_public_keys in
#     prod.tfvars (name -> PEM). Not secret; encoded_key is in state by
#     necessity. Every entry is trusted, so a rotation can overlap two keys;
#     var.report_download_signing_key names the one whose private half is in
#     sops, and the API gets its id and its PEM (lambda.tf).
# Terraform can't check at plan time that the two halves are a pair (that
# needs the private key, and an ephemeral value can't be compared with a
# public key without a provider holding it), so the API checks at cold start
# and refuses to start on a mismatch (reports/cloudfrontSign.ts
# assertKeyPair). Rotation: docs/deployment.md § Rotating a secret.

resource "aws_cloudfront_public_key" "report_downloads" {
  for_each = var.report_download_public_keys

  name        = "${local.project}-report-downloads-${each.key}"
  comment     = "Verifies report download links the API signs (backend/src/reports/cloudfrontSign.ts)"
  encoded_key = each.value
}

resource "aws_cloudfront_key_group" "report_downloads" {
  name    = "${local.project}-report-downloads"
  comment = "Trusted signers for /reports/* (report PDF downloads)"
  items   = [for k in sort(keys(aws_cloudfront_public_key.report_downloads)) : aws_cloudfront_public_key.report_downloads[k].id]
}

resource "aws_cloudfront_origin_access_control" "reports" {
  name                              = "${local.project}-reports-oac"
  description                       = "OAC for the ${local.project} report PDFs bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 names the download from response-content-disposition (the signed URL
# covers it, so it can't be changed); nothing else reaches the bucket: no
# cookies, no viewer headers, not CloudFront's own signing parameters.
resource "aws_cloudfront_origin_request_policy" "report_downloads" {
  name    = "${local.project}-report-downloads"
  comment = "Report PDFs: forward only the download file name"

  cookies_config {
    cookie_behavior = "none"
  }
  headers_config {
    header_behavior = "none"
  }
  query_strings_config {
    query_string_behavior = "whitelist"
    query_strings {
      items = ["response-content-disposition"]
    }
  }
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
