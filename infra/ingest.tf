# ----------------------------------------------------------------------------
# The data mirror and its bulk ingest job (issue #604, Round 1 piece D;
# docs/deployment.md § The data mirror, docs/data-sources.md)
#
# The app no longer fetches from someone else's server because a feed asked:
# one scheduled job of ours copies what our projects need into our own store,
# and everything in the app reads that copy.
#
#   EventBridge (daily, per product) --async invoke--> mirror-ingest Lambda
#   mirror-ingest --GET (politely)--> CHC (data.chc.ucsb.edu)
#   mirror-ingest --Put/Get/List/Delete--> S3 `<project>-mirror-<account>`
#                                          (Zarr v3 arrays + manifest.json)
#   mirror-ingest --PutMetricData--> <project>/Mirror MirrorLagDays{Product}
#   worker --GetObject/ListBucket (S3 interface endpoint)--> the mirror
#
# The job is a Python 3.14 CONTAINER IMAGE (ingest/Dockerfile, arm64: NetCDF
# needs h5py/xarray, which Node has no reader for), in its own ECR
# repository, like the report renderer (reports.tf): immutable tags, created
# only once its first image is in ECR (ingest_image_tag), and moved to each
# release's image by deploy-backend.yml (ignore_changes = [image_uri]).
#
# It runs OUTSIDE the VPC, like the fetcher (feeds.tf): it needs the internet,
# and has no database. Its role may write the mirror bucket and nothing else
# (plus its own log group, its image, its DLQ, its one metric namespace and
# the one secret it reads, IMERG's Earthdata token, imerg.tf). 3 GB memory and 2 GB of /tmp hold one ~330 MiB monthly NetCDF
# while it is decoded and subset; 900 s is Lambda's maximum. Reserved
# concurrency 2: one run per product at most, which is also the "1-2
# requests at a time" the polite client promises upstream.
#
# Schedules: one EventBridge rule per product, daily, invoking the job with
# {"product": "<rnl|sat>", "mode": "monthly"}. The monthly mode is idempotent:
# CHC publishes the new month's finals somewhere between the 20th and the end
# of the next month, and a daily run picks the file up the day it appears,
# at the cost of one conditional request (a 304) on the other days. It also
# gives the freshness alarms below a datapoint every day, which a run only
# on the 25th could not: a CloudWatch alarm can't look back a month. The
# rules exist from the first apply but stay DISABLED until ingest_image_tag
# is set.
#
# Async failures (an uncaught error, a timeout) are not retried: a run that
# hit an HTTP 403 must stop, never retry (issue #604, "a polite client"), and
# the next day's run tries again. The failed event lands in the
# mirror-ingest DLQ, which alarms.
#
# Freshness (issue #604 rule 4): each run publishes, per product,
#   namespace  <project>/Mirror   (water-management/Mirror)
#   metric     MirrorLagDays      (Unit: None; days, a number)
#   dimension  Product = rnl | sat   (prelim and gefs: the fetcher's daily ingest
#                                     and GEFS pass, feeds.tf, as embedded
#                                     metrics; their alarms below)
#   value      today (UTC) minus the product's manifest finalThrough, in days
# with cloudwatch:PutMetricData (its role may publish to that namespace only).
# A lag past ingest_lag_alarm_days alarms, and so does NO datapoint for two
# days (treat_missing_data = "breaching"): a job that stopped running, or
# never started, is as stale as one that runs and fetches nothing.
#
# Cost: under $1/month in steady state (docs/deployment.md § The data mirror):
# ~6 GB of Zarr in S3 Standard (~$0.20), a few seconds of Lambda a day plus
# ~2 minutes once a month, ECR storage of a few images, and the alarms.
# ----------------------------------------------------------------------------

locals {
  ingest_function_name = "${local.project}-mirror-ingest"
  ingest_function_arn  = "${local.lambda_arn_prefix}${local.ingest_function_name}"
  ingest_enabled       = var.ingest_image_tag != ""
  ingest_timeout_s     = 900
  ingest_memory_mb     = 3072
  ingest_tmp_mb        = 2048

  # The products the job copies in Round 1 (the brief's D2 finals) and the
  # time of day (UTC) each runs, 20 minutes apart so two runs never overlap
  # upstream (a run stops at 900 s).
  ingest_products = {
    rnl = { schedule = "cron(0 2 * * ? *)" }
    sat = { schedule = "cron(20 2 * * ? *)" }
  }

  # The custom metric the job publishes (see the header).
  mirror_metric_namespace = "${local.project}/Mirror"
  mirror_lag_metric       = "MirrorLagDays"
  # MirrorLagDays{Product=gefs} at or past this alarms (mirror_lag_gefs): neither today's nor yesterday's issue held.
  gefs_lag_alarm_days = 2

  # Old object versions (a revision CHC rewrote, a chunk the job replaced)
  # stay recoverable this long.
  mirror_noncurrent_days = 30
}

# --- The mirror bucket -----------------------------------------------------------

resource "aws_s3_bucket" "mirror" {
  bucket = "${local.project}-mirror-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "mirror" {
  bucket                  = aws_s3_bucket.mirror.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3: the copy is of public, openly licensed data, written by one role and
# read by one other, both in this account; a CMK would add a key policy for no
# secrecy gained. docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "mirror" {
  bucket = aws_s3_bucket.mirror.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "mirror" {
  bucket = aws_s3_bucket.mirror.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioned: a revision the job wrote in error (CHC served a broken file, a
# bug in the subset) can be rolled back object by object for 30 days, and
# the manifest a run replaced is still there to compare against.
resource "aws_s3_bucket_versioning" "mirror" {
  bucket = aws_s3_bucket.mirror.id

  versioning_configuration {
    status = "Enabled"
  }
}

# A monthly refresh rewrites ~870 year chunks (~130 MB): 30 days of
# noncurrent versions is about a month's rewrite, cents.
resource "aws_s3_bucket_lifecycle_configuration" "mirror" {
  bucket = aws_s3_bucket.mirror.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = local.mirror_noncurrent_days
    }
    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.mirror]
}

# The policy names no reader or writer: each role's own policy is the grant
# (below), as the reference bucket's is (map_data.tf).
data "aws_iam_policy_document" "mirror_bucket_policy" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.mirror.arn,
      "${aws_s3_bucket.mirror.arn}/*",
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

resource "aws_s3_bucket_policy" "mirror" {
  bucket = aws_s3_bucket.mirror.id
  policy = data.aws_iam_policy_document.mirror_bucket_policy.json

  depends_on = [aws_s3_bucket_public_access_block.mirror]
}

# --- The image repository --------------------------------------------------------
#
# The same shape as the renderer's (reports.tf, where the lifecycle and the
# repository policy are explained): immutable tags, scan on push, the last 10
# releases kept, and never the image ingest_image_tag pins.

resource "aws_ecr_repository" "ingest" {
  name                 = "${local.project}-mirror-ingest"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "ingest" {
  repository = aws_ecr_repository.ingest.name
  policy = jsonencode({
    rules = concat(
      [{
        rulePriority = 1
        description  = "Expire untagged images after a day"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      }],
      local.ingest_enabled ? [{
        rulePriority = 2
        description  = "Keep the image ingest_image_tag pins (the function is created from it)"
        selection    = { tagStatus = "tagged", tagPatternList = [var.ingest_image_tag], countType = "imageCountMoreThan", countNumber = 1 }
        action       = { type = "expire" }
      }] : [],
      [{
        rulePriority = 3
        description  = "Keep the last 10 release images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
        action       = { type = "expire" }
      }],
    )
  })
}

data "aws_iam_policy_document" "ingest_ecr" {
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
      values   = [local.ingest_function_arn]
    }
  }
}

resource "aws_ecr_repository_policy" "ingest" {
  repository = aws_ecr_repository.ingest.name
  policy     = data.aws_iam_policy_document.ingest_ecr.json
}

# --- The async-invoke DLQ ----------------------------------------------------------

resource "aws_sqs_queue" "ingest_dlq" {
  name                      = "${local.project}-mirror-ingest-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true
}

# --- The ingest Lambda (no VPC) ------------------------------------------------------

resource "aws_iam_role" "ingest_lambda" {
  name               = "${local.project}-mirror-ingest-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs (its own log group only) are in iam.tf; no VPC access, no managed policy.

data "aws_iam_policy_document" "ingest_lambda" {
  # Read, write, list and delete the copy: a revision rewrites chunks and the
  # manifest, a dropped preliminary day deletes its chunks, and a reader
  # without ListBucket gets AccessDenied instead of 404 for an unwritten
  # (all-NaN) chunk. This bucket only.
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
  # Lambda's on-failure destination sends as the function's role.
  statement {
    sid       = "SendFailedRunsToDlq"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ingest_dlq.arn]
  }
  # The freshness metric. PutMetricData has no resource-level permissions
  # (AWS); the namespace condition is the scope.
  statement {
    sid       = "PublishMirrorLag"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.mirror_metric_namespace]
    }
  }
}

resource "aws_iam_role_policy" "ingest_lambda" {
  name   = "mirror-bucket-dlq-metric"
  role   = aws_iam_role.ingest_lambda.id
  policy = data.aws_iam_policy_document.ingest_lambda.json
}

data "aws_iam_policy_document" "ingest_ecr_pull" {
  statement {
    sid       = "PullIngestImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.ingest.arn]
  }
}

resource "aws_iam_role_policy" "ingest_ecr_pull" {
  name   = "ingest-image-pull"
  role   = aws_iam_role.ingest_lambda.id
  policy = data.aws_iam_policy_document.ingest_ecr_pull.json
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${local.ingest_function_name}"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "ingest" {
  count = local.ingest_enabled ? 1 : 0

  function_name = local.ingest_function_name
  description   = "Data mirror: copies CHC's CHIRPS finals into the private mirror bucket (Zarr v3 + manifest), politely, on a schedule. No VPC, no database (ingest/lambda_handler.py)."
  role          = aws_iam_role.ingest_lambda.arn

  package_type = "Image"
  image_uri    = "${aws_ecr_repository.ingest.repository_url}:${var.ingest_image_tag}"
  # Built natively on GitHub's arm64 runner (deploy-backend.yml build-ingest).
  architectures = ["arm64"]
  timeout       = local.ingest_timeout_s
  memory_size   = local.ingest_memory_mb
  # One monthly NetCDF (~330 MiB) and its decoded subset.
  ephemeral_storage {
    size = local.ingest_tmp_mb
  }

  # One run per product at most, never more than two at once against CHC.
  reserved_concurrent_executions = var.ingest_reserved_concurrency

  logging_config {
    log_format            = local.lambda_logging.log_format
    system_log_level      = local.lambda_logging.system_log_level
    application_log_level = local.lambda_logging.application_log_level
    log_group             = aws_cloudwatch_log_group.ingest.name
  }

  # Deliberately no vpc_config: it reaches CHC over the internet.

  environment {
    variables = {
      MIRROR_URL     = "s3://${aws_s3_bucket.mirror.bucket}"
      FEED_SOURCE    = "live"
      INGEST_CONTACT = var.ingest_contact
      # IMERG Late's Earthdata token, read at run time in live mode (imerg.tf).
      EARTHDATA_TOKEN_SECRET_ARN = aws_secretsmanager_secret.earthdata_token.arn
      # The CDS key's secret, read by ERA5-Land runs (era5land.tf); an ARN, not the key.
      CDS_KEY_SECRET_ARN = aws_secretsmanager_secret.cds_key.arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ingest,
    aws_iam_role_policy.lambda_logs["ingest"],
    aws_iam_role_policy.ingest_ecr_pull,
    aws_iam_role_policy.ingest_lambda,
    aws_ecr_repository_policy.ingest,
  ]

  lifecycle {
    # deploy-backend.yml moves the function to each release's image.
    ignore_changes = [image_uri]
  }
}

# Lambda's own async queue: no retry (a 403 stops the run; the next day's
# run tries again), an event older than an hour dropped, and a failed run's
# event kept in the DLQ.
resource "aws_lambda_function_event_invoke_config" "ingest" {
  count = local.ingest_enabled ? 1 : 0

  function_name                = aws_lambda_function.ingest[0].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = aws_sqs_queue.ingest_dlq.arn
    }
  }

  depends_on = [aws_iam_role_policy.ingest_lambda]
}

# --- Schedules ---------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "ingest" {
  for_each = local.ingest_products

  name                = "${local.project}-mirror-ingest-${each.key}"
  description         = "Daily mirror ingest of CHIRPS ${each.key} finals (monthly mode: a no-op 304 until CHC publishes a new month). Disabled until ingest_image_tag is set."
  schedule_expression = each.value.schedule
  state               = local.ingest_enabled ? "ENABLED" : "DISABLED"
}

# Like the worker tick (jobs.tf): a delivery that fails is not retried, since
# the next day's run does the same work; the freshness alarm notices a run
# that keeps failing.
resource "aws_cloudwatch_event_target" "ingest" {
  for_each = local.ingest_enabled ? local.ingest_products : {}

  rule  = aws_cloudwatch_event_rule.ingest[each.key].name
  arn   = aws_lambda_function.ingest[0].arn
  input = jsonencode({ product = each.key, mode = "monthly" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "ingest" {
  for_each = local.ingest_enabled ? local.ingest_products : {}

  statement_id  = "AllowEventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ingest[each.key].arn
}

# --- The worker reads the copy -------------------------------------------------------
#
# Round 2's feed_fetch reads the copy in the worker, in the VPC, through the
# S3 interface endpoint: the endpoint's policy (packs.tf s3_endpoint) carries
# the same read, or every request fails with AccessDenied. ListBucket so a
# missing (all-NaN) chunk answers 404, not 403. Read only: the worker never
# writes the copy.

data "aws_iam_policy_document" "worker_mirror" {
  statement {
    sid       = "ReadMirrorObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.mirror.arn}/*"]
  }
  statement {
    sid       = "ListMirror"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mirror.arn]
  }
}

resource "aws_iam_role_policy" "worker_mirror" {
  name   = "read-mirror"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_mirror.json
}

# --- Alarms --------------------------------------------------------------------------

# Freshness, one per product: the copy is behind, or the job stopped
# publishing (no datapoint for two days is breaching). Essential tier: it is
# the one alarm that says the data every feed reads has stopped moving.
# Created only once the job exists, or it would fire from the first apply.
resource "aws_cloudwatch_metric_alarm" "mirror_lag" {
  for_each = local.ingest_enabled && local.alarms_essential ? local.ingest_products : {}

  alarm_name          = "${local.project}-mirror-lag-${each.key}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.ingest_lag_alarm_days
  alarm_description   = "The data mirror's ${each.key} copy is more than ${var.ingest_lag_alarm_days} days behind, or the mirror-ingest job published no lag for it for two days (it stopped running, or fails before it measures). Check the mirror-ingest log group and the mirror-ingest-dlq; a run that met HTTP 403 stopped on purpose (docs/deployment.md § The data mirror). The app keeps serving the cached days meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = each.key
  }
}

# The preliminary copy's freshness (issue #604 R2-B): the fetcher's daily
# ingest (feeds.tf, backend/src/ingest/daily.ts) publishes MirrorLagDays with
# Product = prelim, today minus the newest sat day the copy holds (final or
# preliminary), as an embedded metric in its own log. Gated on
# daily_ingest_enabled, not ingest_image_tag: it is the Node fetcher's job,
# and breaching on missing data, it would fire from the first apply before a
# release with the daily mode is out.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_prelim" {
  count = var.daily_ingest_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-prelim"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = var.daily_ingest_lag_alarm_days
  alarm_description   = "The data mirror's newest CHIRPS sat day (preliminary, else final) is more than ${var.daily_ingest_lag_alarm_days} days old, or the fetcher's daily ingest published no lag for two days (it stopped running, or fails before it measures). Logs Insights on the fetcher log group: filter message.event = \"mirror_daily_ingest\" | fields message.stopped, message.reason, message.detail, message.prelimThrough. reason refused = CHC answered HTTP 403 (the run stopped on purpose; docs/deployment.md § The data mirror). The app keeps serving the cached days meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "prelim"
  }
}

# The forecast copy's freshness (issue #604 R3-A): the fetcher's GEFS pass
# (feeds.tf gefs_ingest, backend/src/ingest/gefs.ts) publishes MirrorLagDays
# with Product = gefs, today minus the newest CHIRPS-GEFS issue the copy
# holds. A healthy copy reads 0 after the morning's run, 1 before it; at 2
# neither today's nor yesterday's issue is held, so every CHIRPS-GEFS feed
# reading the copy waits (backend/src/feeds/fromMirrorGefs.ts). Gated on
# daily_ingest_enabled like the prelim alarm, and breaching on missing data.
resource "aws_cloudwatch_metric_alarm" "mirror_lag_gefs" {
  count = var.daily_ingest_enabled && local.alarms_essential ? 1 : 0

  alarm_name          = "${local.project}-mirror-lag-gefs"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = local.mirror_lag_metric
  namespace           = local.mirror_metric_namespace
  period              = 86400
  statistic           = "Maximum"
  threshold           = local.gefs_lag_alarm_days
  alarm_description   = "The data mirror's newest CHIRPS-GEFS issue is ${local.gefs_lag_alarm_days} or more days old (forecast feeds reading the copy wait), or the fetcher's GEFS pass published no lag for two days (it stopped running, or fails before it measures). Logs Insights on the fetcher log group: filter message.event = \"mirror_daily_ingest\" and message.product = \"gefs\" | fields message.stopped, message.partial, message.reason, message.detail, message.newest. reason refused = CHC answered HTTP 403 (the run stopped on purpose; docs/deployment.md § The data mirror). Feeds keep the forecast they have meanwhile."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    Product = "gefs"
  }
}

resource "aws_cloudwatch_metric_alarm" "ingest_errors" {
  count = local.ingest_enabled && local.alarms_full ? 1 : 0

  alarm_name          = "${local.project}-mirror-ingest-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The mirror-ingest Lambda raised or timed out. Its event is in the mirror-ingest-dlq; the next day's run tries again. Check its log group."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.ingest[0].function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "ingest_dlq_depth" {
  count = local.alarms_full ? 1 : 0
  # Fires on each new arrival, not on depth: see local.dlq_arrivals_expression (alarms.tf).
  alarm_name          = "${local.project}-mirror-ingest-dlq-arrivals"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.dlq_arrivals_evaluation_periods
  datapoints_to_alarm = 1
  threshold           = 0
  alarm_description   = "A mirror-ingest run failed (error or timeout) and its event was dead-lettered. Nothing to redrive: the next day's run does the same work. Read the run's error in the mirror-ingest log group. ${local.dlq_arrivals_note}"
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
        QueueName = aws_sqs_queue.ingest_dlq.name
      }
    }
  }
}
