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
#     (and by the operator after a password rotation), and by
#     load-reference.yml to load an allowed reference dataset from the
#     reference bucket (map_data.tf).
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

# Every Lambda logs in Lambda's JSON format (issue #126). The platform's own
# START / END / REPORT lines, three per invocation and so three per API
# request, are system logs at INFO; WARN keeps only the platform's warnings
# and errors (an init failure, a timeout, an out-of-memory). The code's own
# lines are application logs, kept from INFO up: the alarm lines are WARN or
# ERROR (logging/logEvent.ts callers), but the worker's embedded metrics
# (jobs_backlog, alert-mail burst) are bare stdout lines Lambda records as
# INFO, and a higher level would silently drop them.
#
# JSON changes the shape the metric filters read: each console call becomes
# `{ timestamp, level, requestId, message }`, with a single-object argument
# nested under `message`. The backend logs its events that way
# (backend/src/logging/logEvent.ts), so every filter matches
# `$.message.event` (alarms.tf, jobs.tf; pinned in tests/logging.tftest.hcl).
locals {
  # The pg pool per container (backend/src/db/pool.ts): one request or job at
  # a time, so 2. The connection precondition below sums cap x pool.
  api_db_pool_max    = "2"
  worker_db_pool_max = "2"

  lambda_logging = {
    log_format            = "JSON"
    system_log_level      = "WARN"
    application_log_level = "INFO"
  }
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

  # Bounds spend and DB connections (25 x a pool of 2, DB_POOL_MAX below).
  reserved_concurrent_executions = var.lambda_reserved_concurrency

  # JSON logs, with the per-invocation platform lines dropped (lambda.tf,
  # local.lambda_logging).
  logging_config {
    log_format            = local.lambda_logging.log_format
    system_log_level      = local.lambda_logging.system_log_level
    application_log_level = local.lambda_logging.application_log_level
    # The group this file creates, with its retention (and filters).
    log_group = aws_cloudwatch_log_group.lambda.name
  }

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
      # One request per container at a time, so a pool of 2 (db/pool.ts):
      # x lambda_reserved_concurrency (25) = 50 connections at most
      # (variables.tf, infra/README.md § Connections).
      DB_POOL_MAX = local.api_db_pool_max

      # Sign-up by invitation (auth/signupOpen.ts): closed unless signup_open.
      # The backend treats an unset value on Lambda as closed too.
      SIGNUP_OPEN = var.signup_open ? "true" : "false"

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

      # Data feeds (feeds.tf): the API never fetches, but this picks which
      # CHIRPS cell cache it reads (backend/src/feeds/cellCacheStore.ts
      # cacheOrigin): a run started here must read the `chc` rows the worker
      # merges from the live fetcher, and the Data feeds panel must not call
      # them sample data. Unset is the local fixtures, which the backend's
      # production check refuses (config/production.ts).
      FEED_SOURCE = "live"
      # Whether CHIRPS feeds read our copy (issue #604): the same as the
      # worker's (jobs.tf), so the Data feeds panel reports the copy exactly
      # when the feeds read it. The API reads the copy's days from the
      # mirror_copy rows the worker records; it never reaches the copy itself.
      CHIRPS_SOURCE = var.chirps_source
      # Whether the observed ET pass runs (issue #623, et_observations.tf): the
      # same as the worker's (jobs.tf). The API runs no tick; it reads this
      # only so a unit's ET panel can say the check is off on this site rather
      # than that the unit has no observations yet (GET …/et-observed enabled).
      ET_OBSERVATIONS = var.et_observations_enabled ? "on" : "off"
      # The future climate (issue #621): § 8 Future yield and the change
      # factors. The API queues the jobs and puts § 8 in a report; the same
      # value as the worker's (jobs.tf), which runs them, and the
      # assistant's (assistant.tf), which builds the same reports.
      FUTURE_YIELD = var.future_yield_enabled ? "on" : "off"

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

      # Evidence packs (pack_bundles.tf): issuing a pack stores its
      # reproduction bundle here, through the S3 endpoint (packs.tf).
      PACKS_BUCKET = aws_s3_bucket.packs.bucket

      # Catchment delineation (map_data.tf, docs/design/delineation.md): the
      # DEM in the tiles bucket, read by ranged GetObject; empty turns
      # delineation off (the default, until delineation_dem is set).
      DEM_URL = var.delineation_dem ? "s3://${aws_s3_bucket.tiles.bucket}/${local.dem_key}" : ""

      # Tracing a dam (map_data.tf, docs/maps.md § Assisted drawing): the
      # water occurrence in the tiles bucket; empty turns it off (the
      # default, until dam_trace_water is set).
      WATER_URL = var.dam_trace_water ? "s3://${aws_s3_bucket.tiles.bucket}/${local.water_key}" : ""

      # The assistant (assistant.tf, issue #610): the API answers its status
      # (GET /projects/:id/assistant: whether the chat is on, the tokens left
      # under the project's, the person's and the deployment's monthly caps)
      # and never calls a model, which only the assistant's own Lambda can
      # (its role, the Bedrock endpoint). The same values as that Lambda's,
      # so the status shows what it enforces. off while assistant_enabled is
      # false: the page shows no chat.
      ASSISTANT_PROVIDER               = local.assistant_enabled ? "bedrock" : "off"
      ASSISTANT_MODEL                  = var.assistant_model_id
      ASSISTANT_TOKENS_PER_MONTH       = tostring(var.assistant_tokens_per_month)
      ASSISTANT_TOKENS_PER_USER_MONTH  = tostring(var.assistant_tokens_per_user_month)
      ASSISTANT_TOKENS_PER_MONTH_TOTAL = tostring(local.assistant_tokens_per_month_total)
      ASSISTANT_MESSAGES_PER_HOUR      = tostring(var.assistant_messages_per_hour)
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
    aws_vpc_endpoint.s3,
    aws_iam_role_policy.api_pack_bundles,
    aws_iam_role_policy.api_dem,
    aws_iam_role_policy.api_water,
    # A rotation switches the API only once the key group trusts the new key.
    aws_cloudfront_key_group.report_downloads,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
    # The secrets' shape checks are validations on their variables (variables.tf).

    # Delineation keeps a 20 s budget (delineation/delineate.ts TIME_BUDGET_MS)
    # and peaks near 460 MB at its window cap (docs/design/delineation.md §
    # Where it runs): a smaller or shorter API Lambda would cut it off
    # mid-request instead of letting it refuse.
    # The database's connections (infra/README.md § Connections): every
    # DB-connected Lambda's cap x its pool, plus the migrator's 2, leaves
    # db.t4g.micro (~80 max_connections, the default class) room for the
    # operator and RDS's own. Checked on every tfvars, so raising a cap or a
    # pool past it fails the plan instead of the database (issue #541).
    # The assistant (assistant.tf) counts only while it exists: its cap x a
    # pool of 1.
    precondition {
      condition = (
        var.lambda_reserved_concurrency * tonumber(local.api_db_pool_max) +
        var.worker_reserved_concurrency * tonumber(local.worker_db_pool_max) +
        var.migrate_reserved_concurrency * 2 +
        local.assistant_count * var.assistant_reserved_concurrency * tonumber(local.assistant_db_pool_max)
      ) <= 70
      error_message = "lambda_reserved_concurrency x DB_POOL_MAX + worker_reserved_concurrency x its DB_POOL_MAX + the migrator's 2 (+ assistant_reserved_concurrency x 1 when assistant_enabled) must stay <= 70 database connections (db.t4g.micro's ~80 less headroom). Redo infra/README.md § Connections (or move to RDS Proxy) before raising a cap or a pool."
    }
    precondition {
      condition     = !var.delineation_dem || (var.lambda_memory_mb >= 1024 && var.lambda_timeout_seconds >= 25)
      error_message = "delineation_dem needs the API Lambda at lambda_memory_mb >= 1024 (a delineation peaks near 460 MB) and lambda_timeout_seconds >= 25 (it keeps a 20 s budget)."
    }
  }
}

resource "aws_lambda_function_url" "backend" {
  function_name      = aws_lambda_function.backend.function_name
  authorization_type = "NONE"
  # Response streaming (WP-1.29a, issue #283): a response may pass the 6 MB a
  # BUFFERED URL stops at (up to 200 MB), so the CSV exports stream instead of
  # answering 413 (backend/src/export/download.ts, capped at 50 MB). It covers
  # every route, and must match the handler: backend/src/lambda.ts exports a
  # streaming one (http/lambdaStream.ts), so this and that change together,
  # never one alone (docs/deployment.md § Response streaming). Nothing at the
  # edge changes: CloudFront passes a streamed (chunked) origin response
  # through on /api/* (CachingDisabled, so nothing is stored or compressed),
  # the WAF inspects requests only, and the shared-secret check is the app's
  # first middleware whichever way the response travels. Past the first 6 MB a
  # stream runs at about 2 MB/s, which the 50 MB cap keeps inside the 30 s
  # timeout.
  invoke_mode = "RESPONSE_STREAM"
  # No `cors` block: the browser never calls the Function URL. It calls the
  # site's own origin (/api/*) and CloudFront proxies here, so every request
  # is same-origin and Hono's cors()/csrf() middleware is the only CORS layer.
}

# A NONE-auth Function URL still needs a resource policy that lets the public
# invoke it; since Oct 2025 AWS requires both InvokeFunctionUrl and
# InvokeFunction (the latter restricted to invocations via the URL, so this
# does NOT make the function directly invokable by other accounts). The
# provider adds both itself when it creates a NONE URL (aws_lambda_function_url,
# since 6.28: statements FunctionURLAllowPublicAccess and
# FunctionURLAllowInvokeAction), so they are deliberately not declared here: an
# aws_lambda_permission with the same statement id fails the apply with a 409
# (the first apply, 2026-10-04), and one with another id is a duplicate. The
# provider adds them only on create; if a statement is ever removed by hand,
# `terraform apply -replace=aws_lambda_function_url.backend` puts both back. The
# shared-secret check in the app is what rejects callers that skip CloudFront.

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
  # 900 s (Lambda's maximum) for a reference-dataset load, which parses and
  # writes a country's reaches or cells in one transaction (geo/referenceLoad.ts);
  # a migration keeps migrate.ts DEFAULT_TIMEOUTS.statement_timeout (240 s).
  timeout     = 900
  memory_size = var.migrate_memory_mb

  reserved_concurrent_executions = var.migrate_reserved_concurrency

  # JSON logs, with the per-invocation platform lines dropped (lambda.tf,
  # local.lambda_logging).
  logging_config {
    log_format            = local.lambda_logging.log_format
    system_log_level      = local.lambda_logging.system_log_level
    application_log_level = local.lambda_logging.application_log_level
    # The group this file creates, with its retention (and filters).
    log_group = aws_cloudwatch_log_group.migrate.name
  }

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
      # Reference-dataset loads read their file here (map_data.tf).
      REFERENCE_BUCKET = aws_s3_bucket.reference.bucket
      # V8's heap at 85% of the function's memory, set here rather than left
      # to the runtime's default, so a load's parse (geo/referenceLoad.ts
      # MAX_TEXT_BYTES) has the room the caps were measured against.
      NODE_OPTIONS = "--max-old-space-size=${floor(var.migrate_memory_mb * 0.85)}"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.migrate,
    aws_iam_role_policy.lambda_logs["migrate"],
    aws_iam_role_policy.lambda_vpc_eni["migrate"],
    aws_iam_role_policy.runtime_secret,
    aws_iam_role_policy.migrate_reference,
    aws_vpc_endpoint.secretsmanager,
    aws_vpc_endpoint.s3,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}
