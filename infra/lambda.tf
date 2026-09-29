# ----------------------------------------------------------------------------
# Two Lambdas, both in the private subnets, both nodejs24.x on arm64 (the
# third, the background-job worker, lives in jobs.tf):
#
#   - `water-management-backend` — the Hono API (backend/src/lambda.ts).
#     Connects as the RLS-bound `water_app` role. Its secrets (the session
#     key, DATABASE_URL, the CloudFront header) come from its runtime secret
#     in Secrets Manager at cold start, never its environment (secrets.tf). Exposed only through the
#     Function URL, which only CloudFront reaches in practice (shared secret).
#   - `water-management-migrate` — applies backend/migrations as the schema
#     owner and creates / re-passwords `water_app`
#     (backend/src/lambda-migrate.ts). No URL; invoked by the deploy workflow
#     (and by the operator after a password rotation).
#
# Terraform creates both with a stub package; real code is uploaded by
# .github/workflows/deploy-backend.yml (built by infra/scripts/package-lambdas.sh).
# `ignore_changes` on the code attributes keeps `apply` from fighting CI.
#
# TLS to RDS: both packages carry infra/certs/rds-global-bundle.pem at the
# zip root, NODE_EXTRA_CA_CERTS points Node at it, and the connection uses
# sslmode=verify-full (certificate chain + hostname checked).
# ----------------------------------------------------------------------------

locals {
  rds_ca_path = "/var/task/rds-global-bundle.pem"

  # water_app password is alphanumeric (var.db_app_password's validation) but
  # urlencode anyway. Ephemeral, like the password: it only reaches the runtime
  # secrets' write-only values (secrets.tf).
  database_url = format(
    "postgresql://water_app:%s@%s:%d/%s?sslmode=verify-full",
    urlencode(local.db_app_password),
    aws_db_instance.main.address,
    aws_db_instance.main.port,
    aws_db_instance.main.db_name,
  )
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "archive_file" "lambda_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/lambda_stub.zip"

  source {
    filename = "lambda.mjs"
    content  = <<-EOT
      export const handler = async () => ({
        statusCode: 503,
        body: JSON.stringify({ error: "Backend not yet deployed. Run the GitHub Actions deploy-backend workflow." })
      });
    EOT
  }
}

data "archive_file" "migrate_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/migrate_stub.zip"

  source {
    filename = "dist/lambda-migrate.mjs"
    content  = <<-EOT
      export const handler = async () => {
        throw new Error("Migrate Lambda not yet deployed. Run the GitHub Actions deploy-backend workflow.");
      };
    EOT
  }
}

# ============================================================================
# API Lambda
# ============================================================================

resource "aws_iam_role" "lambda" {
  name               = "${local.project}-backend-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs (its own log group) + the EC2 ENI permissions a VPC Lambda needs are
# in iam.tf. The API reads its config from environment variables and its
# secrets from its own runtime secret (GetSecretValue on that one ARN,
# secrets.tf, through the endpoint in network.tf); its other AWS calls are SES
# SendEmail, granted separately and scoped to one identity + From address
# (ses.tf), and SQS SendMessage to the jobs queue (jobs.tf).

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.project}-backend"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "backend" {
  function_name = "${local.project}-backend"
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

  handler       = "lambda.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"] # ~20% cheaper per GB-s than x86; the bundle is pure JS
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.api_lambda.id]
  }

  environment {
    variables = {
      # DATABASE_URL, AUTH_JWT_SECRET and CLOUDFRONT_SHARED_SECRET are in the
      # runtime secret, never here: this block is readable by any
      # GetFunctionConfiguration caller (secrets.tf).
      RUNTIME_SECRET_ARN     = aws_secretsmanager_secret.runtime["api"].arn
      RUNTIME_SECRET_VERSION = aws_secretsmanager_secret_version.runtime["api"].version_id
      ALLOWED_ORIGINS        = local.site_origin
      COOKIE_SECURE          = "true"
      NODE_EXTRA_CA_CERTS    = local.rds_ca_path

      # Email (ses.tf, docs/deployment.md § Email). MAIL_TRANSPORT must be set:
      # the default `log` sends nothing.
      MAIL_TRANSPORT        = "ses"
      MAIL_FROM             = "${var.mail_from_display_name} <${local.mail_from_address}>"
      SITE_URL              = local.site_origin
      SES_CONFIGURATION_SET = aws_sesv2_configuration_set.main.configuration_set_name

      # Background jobs (jobs.tf): after queueing a job the API sends a wake-up
      # to the jobs queue; the EventBridge tick catches any that are lost.
      JOB_TRANSPORT  = "sqs"
      JOBS_QUEUE_URL = aws_sqs_queue.jobs.url

      # Server-side reports (reports.tf): the API signs PDF downloads as
      # CloudFront signed URLs on the site's /reports/* path. The private key
      # is in the runtime secret; these name its public half: the key id
      # CloudFront checks, and the PEM the API matches its private key against
      # at cold start (a mismatch refuses to start).
      STORAGE                = "s3"
      REPORTS_BUCKET         = aws_s3_bucket.reports.bucket
      REPORT_DOWNLOADS       = "cloudfront"
      CLOUDFRONT_KEY_PAIR_ID = aws_cloudfront_public_key.report_downloads[var.report_download_signing_key].id
      CLOUDFRONT_PUBLIC_KEY  = var.report_download_public_keys[var.report_download_signing_key]
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda_logs["api"],
    aws_iam_role_policy.lambda_vpc_eni["api"],
    aws_iam_role_policy.lambda_ses,
    aws_iam_role_policy.lambda_jobs_send,
    aws_iam_role_policy.runtime_secret,
    aws_vpc_endpoint.ses,
    aws_vpc_endpoint.sqs,
    aws_vpc_endpoint.secretsmanager,
    # A rotation switches the API only once the key group trusts the new key.
    aws_cloudfront_key_group.report_downloads,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
    # The secrets' shape checks are validations on their variables (variables.tf).
  }
}

resource "aws_lambda_function_url" "backend" {
  function_name      = aws_lambda_function.backend.function_name
  authorization_type = "NONE"
  # No `cors` block: the browser never calls the Function URL. It calls the
  # site's own origin (/api/*) and CloudFront proxies here, so every request
  # is same-origin and Hono's cors()/csrf() middleware is the only CORS layer.
}

# A NONE-auth Function URL still needs a resource policy that lets the public
# invoke it; since Oct 2025 AWS requires both InvokeFunctionUrl and
# InvokeFunction (the latter restricted to invocations via the URL, so this
# does NOT make the function directly invokable by other accounts). The
# shared-secret check in the app is what rejects callers that skip CloudFront.
resource "aws_lambda_permission" "function_url_public" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.backend.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "function_url_invoke" {
  statement_id             = "FunctionURLInvokeAllowPublicAccess"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.backend.function_name
  principal                = "*"
  invoked_via_function_url = true
}

# ============================================================================
# Migrate Lambda
# ============================================================================

resource "aws_iam_role" "migrate_lambda" {
  name               = "${local.project}-migrate-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs and VPC ENIs: iam.tf.

# Read the RDS-managed master secret. The secret is encrypted with the
# AWS-managed aws/secretsmanager key, which needs no explicit kms:Decrypt
# grant. Its only other read is its own runtime secret (secrets.tf).
data "aws_iam_policy_document" "migrate_lambda" {
  statement {
    sid       = "ReadRdsMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "migrate_lambda" {
  name   = "read-rds-master-secret"
  role   = aws_iam_role.migrate_lambda.id
  policy = data.aws_iam_policy_document.migrate_lambda.json
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/aws/lambda/${local.project}-migrate"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "migrate" {
  function_name = "${local.project}-migrate"
  description   = "Applies backend/migrations as the schema owner and syncs the water_app role. Invoked by deploy-backend.yml."
  role          = aws_iam_role.migrate_lambda.arn

  filename         = data.archive_file.migrate_stub.output_path
  source_code_hash = data.archive_file.migrate_stub.output_base64sha256

  # The package keeps backend/'s layout (dist/lambda-migrate.mjs next to
  # migrations/) because migrate.ts resolves `<dirname>/../migrations`.
  handler       = "dist/lambda-migrate.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = 300 # migrate.ts DEFAULT_TIMEOUTS.statement_timeout (240s) stays under this
  memory_size   = 512

  reserved_concurrent_executions = var.migrate_reserved_concurrency

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.migrate_lambda.id]
  }

  environment {
    variables = {
      DB_HOST           = aws_db_instance.main.address
      DB_PORT           = tostring(aws_db_instance.main.port)
      DB_NAME           = aws_db_instance.main.db_name
      MASTER_SECRET_ARN = aws_db_instance.main.master_user_secret[0].secret_arn
      # WATER_APP_PASSWORD is in the runtime secret (secrets.tf), never here.
      RUNTIME_SECRET_ARN     = aws_secretsmanager_secret.runtime["migrate"].arn
      RUNTIME_SECRET_VERSION = aws_secretsmanager_secret_version.runtime["migrate"].version_id
      NODE_EXTRA_CA_CERTS    = local.rds_ca_path
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.migrate,
    aws_iam_role_policy.lambda_logs["migrate"],
    aws_iam_role_policy.lambda_vpc_eni["migrate"],
    aws_iam_role_policy.runtime_secret,
    aws_vpc_endpoint.secretsmanager,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}
