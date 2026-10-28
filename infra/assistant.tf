# ----------------------------------------------------------------------------
# The AI assistant (issue #610; docs/deployment.md § The assistant)
#
# `water-management-assistant` runs the chat: the API's bundle and app
# (backend/src/lambda-assistant.ts), serving only the assistant's paths (every
# other path is a 404), in the private subnets beside the API. It exists
# because a turn (several model calls with tool reads between them) can run
# past the API's 30 s timeout, which must stay under CloudFront's 35 s origin
# read timeout. So it gets:
#
#   - var.assistant_timeout_seconds (120 s), with ASSISTANT_TURN_SECONDS 15 s
#     below it, so a long turn ends with an error event and is charged rather
#     than being cut off by the runtime;
#   - reserved concurrency var.assistant_reserved_concurrency (2): how many
#     turns run at once, which bounds the model spend per minute and the
#     database connections (x a pool of 1; lambda.tf sums every Lambda's);
#   - its own Function URL in RESPONSE_STREAM mode, reached only through
#     CloudFront's /api/projects/*/assistant/* behaviour (s3_cloudfront.tf),
#     which stamps the same shared-secret header as the API's origin; the app
#     refuses a request without it, so a direct call to the URL gets 403;
#   - the only IAM permission in this account to call a model: Invoke on the
#     one model or inference profile var.assistant_model_id names;
#   - the bedrock-runtime interface endpoint below, so it reaches Bedrock
#     without a NAT, an internet gateway or an API key. Its endpoint policy
#     lets the assistant's role call that one model and nothing else.
#
# Where the model runs. Anthropic's models are reachable from af-south-1 only
# through Bedrock's global cross-Region inference profile
# (global.anthropic.…): the request enters Bedrock here, through this
# endpoint, and Bedrock may process it in any commercial AWS region, over
# AWS's network. That is a cross-border transfer under POPIA s72, recorded in
# docs/security.md § Personal information (POPIA); AWS is already the
# sub-processor. CloudTrail logs each call in af-south-1, with the region that
# ran it (additionalEventData.inferenceRegion).
#
# The API Lambda answers the status (GET /projects/:id/assistant: whether the
# chat is on, the tokens left) and never calls a model, but it reads the same
# settings, so lambda.tf sets the same values on it.
#
# Off by default (var.assistant_enabled): then none of this exists, the API
# says ASSISTANT_PROVIDER=off and the page shows no chat.
# ----------------------------------------------------------------------------

locals {
  assistant_enabled       = var.assistant_enabled
  assistant_count         = var.assistant_enabled ? 1 : 0
  assistant_function_name = "${local.project}-assistant"
  # By name, as the renderer's and the ingest job's: the deploy role may update
  # it whether it exists yet or not (oidc.tf).
  assistant_function_arn = "${local.lambda_arn_prefix}${local.assistant_function_name}"

  # Its own connection string, so pg_stat_activity tells its connections from
  # the API's. One message per container, and each request path holds at most
  # one connection at a time (docs/architecture.md § Connections per request),
  # so a pool of 1: the database sum in lambda.tf counts 1 per container.
  assistant_database_url = "${local.database_url}&application_name=assistant"
  assistant_db_pool_max  = "1"

  # The model's ARNs for IAM. A system inference profile id is
  # <geo>.anthropic.<model> (global, us, eu, …), a model id anthropic.<model>.
  assistant_model_parts = split(".", var.assistant_model_id)
  assistant_via_profile = local.assistant_model_parts[0] != "anthropic"
  assistant_global      = local.assistant_model_parts[0] == "global"
  assistant_base_model  = local.assistant_via_profile ? join(".", slice(local.assistant_model_parts, 1, length(local.assistant_model_parts))) : var.assistant_model_id

  assistant_profile_arn = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.assistant_model_id}"
  # The model itself, in this region, in any region (a geographic profile's
  # destinations), and region-less (what a global profile's routing is
  # authorized against: AWS's global cross-Region inference IAM example).
  assistant_model_arn_here   = "arn:aws:bedrock:${var.aws_region}::foundation-model/${local.assistant_base_model}"
  assistant_model_arn_any    = "arn:aws:bedrock:*::foundation-model/${local.assistant_base_model}"
  assistant_model_arn_global = "arn:aws:bedrock:::foundation-model/${local.assistant_base_model}"
  assistant_model_arns = (
    !local.assistant_via_profile ? [local.assistant_model_arn_here] :
    local.assistant_global ? [local.assistant_model_arn_here, local.assistant_model_arn_global] :
    [local.assistant_model_arn_any]
  )

  # The deployment-wide monthly cap in weighted tokens (input + 5 x output):
  # the assistant's budget at the input price, unless set
  # (var.assistant_tokens_per_month_total, whose validation bounds both).
  assistant_tokens_per_month_total = (
    var.assistant_tokens_per_month_total != null
    ? var.assistant_tokens_per_month_total
    : floor(var.assistant_budget_monthly_usd / var.assistant_input_usd_per_million * 1000000)
  )

  # InvokeModel and its streaming form: ConverseStream and InvokeModelWithResponseStream
  # are authorized as the latter, Converse as the former.
  assistant_bedrock_actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
}

resource "aws_iam_role" "assistant_lambda" {
  count              = local.assistant_count
  name               = "${local.project}-assistant-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs (its own group) and VPC ENIs: iam.tf. Its runtime secret: secrets.tf.

# The one model, through the profile when there is one. Each statement is
# AWS's documented shape for that route: the profile in this region, then
# the model it routes to, only when invoked through that profile
# (bedrock:InferenceProfileArn), so the role can't call the model directly or
# through any other profile.
data "aws_iam_policy_document" "assistant_bedrock" {
  count = local.assistant_count

  dynamic "statement" {
    for_each = local.assistant_via_profile ? [1] : []
    content {
      sid       = "InvokeTheInferenceProfile"
      actions   = local.assistant_bedrock_actions
      resources = [local.assistant_profile_arn]
      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.aws_region]
      }
    }
  }

  # A global profile: AWS's three-part example ("Global cross-Region
  # inference", IAM policy requirements). Bedrock authorizes the model here
  # with aws:RequestedRegion = this region, and the region-less model ARN that
  # the global routing is checked against with aws:RequestedRegion =
  # "unspecified"; each is pinned to its own value.
  dynamic "statement" {
    for_each = local.assistant_global ? [1] : []
    content {
      sid       = "InvokeTheModelInRegionThroughTheProfile"
      actions   = local.assistant_bedrock_actions
      resources = [local.assistant_model_arn_here]
      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.aws_region]
      }
      condition {
        test     = "StringEquals"
        variable = "bedrock:InferenceProfileArn"
        values   = [local.assistant_profile_arn]
      }
    }
  }

  dynamic "statement" {
    for_each = local.assistant_global ? [1] : []
    content {
      sid       = "InvokeTheGlobalModelThroughTheProfile"
      actions   = local.assistant_bedrock_actions
      resources = [local.assistant_model_arn_global]
      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = ["unspecified"]
      }
      condition {
        test     = "StringEquals"
        variable = "bedrock:InferenceProfileArn"
        values   = [local.assistant_profile_arn]
      }
    }
  }

  # A geographic profile routes to its geography's regions, which differ by
  # source region (GetInferenceProfile lists them), so the model in any region,
  # still only through that profile.
  dynamic "statement" {
    for_each = local.assistant_via_profile && !local.assistant_global ? [1] : []
    content {
      sid       = "InvokeTheModelThroughTheProfile"
      actions   = local.assistant_bedrock_actions
      resources = local.assistant_model_arns
      condition {
        test     = "StringEquals"
        variable = "bedrock:InferenceProfileArn"
        values   = [local.assistant_profile_arn]
      }
    }
  }

  dynamic "statement" {
    for_each = local.assistant_via_profile ? [] : [1]
    content {
      sid       = "InvokeTheModelInRegion"
      actions   = local.assistant_bedrock_actions
      resources = local.assistant_model_arns
    }
  }
}

resource "aws_iam_role_policy" "assistant_bedrock" {
  count  = local.assistant_count
  name   = "invoke-one-model"
  role   = aws_iam_role.assistant_lambda[0].id
  policy = data.aws_iam_policy_document.assistant_bedrock[0].json
}

resource "aws_cloudwatch_log_group" "assistant" {
  count             = local.assistant_count
  name              = "/aws/lambda/${local.assistant_function_name}"
  retention_in_days = var.lambda_log_retention_days
}

# ----------------------------------------------------------------------------
# Network: its own security group (Postgres, the Secrets Manager endpoint and
# the bedrock-runtime endpoint, nothing else), and the endpoint.
# ----------------------------------------------------------------------------

resource "aws_security_group" "assistant_lambda" {
  count       = local.assistant_count
  name        = "${local.project}-assistant-lambda"
  description = "Assistant Lambda ENIs: egress to Postgres and the Secrets Manager and Bedrock runtime endpoints only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-assistant-lambda" }
}

resource "aws_security_group" "bedrock_vpce" {
  count       = local.assistant_count
  name        = "${local.project}-bedrock-vpce"
  description = "Bedrock runtime interface endpoint: 443 from the assistant Lambda only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-bedrock-vpce" }
}

resource "aws_vpc_security_group_egress_rule" "assistant_to_rds" {
  count                        = local.assistant_count
  security_group_id            = aws_security_group.assistant_lambda[0].id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_vpc_security_group_egress_rule" "assistant_to_vpce" {
  count                        = local.assistant_count
  security_group_id            = aws_security_group.assistant_lambda[0].id
  referenced_security_group_id = aws_security_group.vpce.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Secrets Manager endpoint (runtime secret)"
}

resource "aws_vpc_security_group_egress_rule" "assistant_to_bedrock" {
  count                        = local.assistant_count
  security_group_id            = aws_security_group.assistant_lambda[0].id
  referenced_security_group_id = aws_security_group.bedrock_vpce[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Bedrock runtime endpoint"
}

# The RDS and Secrets Manager groups' descriptions (network.tf) predate the
# assistant and name the Lambdas they were written for; a description can't
# be edited in place (the group would be replaced under live ENIs), so the
# rules' own descriptions say who they admit.
resource "aws_vpc_security_group_ingress_rule" "rds_from_assistant" {
  count                        = local.assistant_count
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.assistant_lambda[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the assistant Lambda"
}

resource "aws_vpc_security_group_ingress_rule" "vpce_from_assistant" {
  count                        = local.assistant_count
  security_group_id            = aws_security_group.vpce.id
  referenced_security_group_id = aws_security_group.assistant_lambda[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the assistant Lambda (runtime secret)"
}

resource "aws_vpc_security_group_ingress_rule" "bedrock_vpce_from_assistant" {
  count                        = local.assistant_count
  security_group_id            = aws_security_group.bedrock_vpce[0].id
  referenced_security_group_id = aws_security_group.assistant_lambda[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the assistant Lambda"
}

# Private DNS: the SDK's default bedrock-runtime.<region>.amazonaws.com
# resolves to this endpoint inside the VPC, so the client needs no endpoint
# URL. ~$9.56 a month per AZ in af-south-1 ($0.01309 an hour; ~$7.30 in
# us-east-1), var.bedrock_endpoint_az_count.
resource "aws_vpc_endpoint" "bedrock_runtime" {
  count               = local.assistant_count
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = slice(aws_subnet.private[*].id, 0, var.bedrock_endpoint_az_count)
  security_group_ids  = [aws_security_group.bedrock_vpce[0].id]
  private_dns_enabled = true

  policy = data.aws_iam_policy_document.bedrock_endpoint[0].json

  tags = { Name = "${local.project}-bedrock-runtime" }
}

# Through this endpoint: the assistant's role, the two invoke actions, the
# one model (and its profile). Its IAM policy already narrows the role; this
# keeps any other principal in the VPC (a role given Bedrock access by
# mistake, or someone else's credentials) from using the endpoint at all.
data "aws_iam_policy_document" "bedrock_endpoint" {
  count = local.assistant_count

  statement {
    sid       = "AssistantInvokesOneModel"
    actions   = local.assistant_bedrock_actions
    resources = concat(local.assistant_via_profile ? [local.assistant_profile_arn] : [], local.assistant_model_arns)
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.assistant_lambda[0].arn]
    }
  }
}

# ----------------------------------------------------------------------------
# The function and its URL
# ----------------------------------------------------------------------------

data "archive_file" "assistant_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/assistant_stub.zip"

  source {
    filename = "lambda-assistant.mjs"
    content  = <<-EOT
      export const handler = async () => ({
        statusCode: 503,
        body: JSON.stringify({ error: "Assistant not yet deployed. Run the GitHub Actions deploy-backend workflow." })
      });
    EOT
  }
}

resource "aws_lambda_function" "assistant" {
  count         = local.assistant_count
  function_name = local.assistant_function_name
  description   = "The AI assistant's chat (issue #610): the API's app, assistant routes only, calling one Bedrock model. backend/src/lambda-assistant.ts."
  role          = aws_iam_role.assistant_lambda[0].arn

  filename         = data.archive_file.assistant_stub.output_path
  source_code_hash = data.archive_file.assistant_stub.output_base64sha256

  handler       = "lambda-assistant.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = var.assistant_timeout_seconds
  memory_size   = var.assistant_memory_mb

  # How many turns run at once: spend per minute and DB connections.
  reserved_concurrent_executions = var.assistant_reserved_concurrency

  # JSON logs, with the per-invocation platform lines dropped (lambda.tf,
  # local.lambda_logging). Prompts and answers are never logged: one
  # assistant_turn line per turn carries its token counts and how it ended
  # (alarms.tf sums them for the hourly spend alarm), the rest are error codes.
  logging_config {
    log_format            = local.lambda_logging.log_format
    system_log_level      = local.lambda_logging.system_log_level
    application_log_level = local.lambda_logging.application_log_level
    log_group             = aws_cloudwatch_log_group.assistant[0].name
  }

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.assistant_lambda[0].id]
  }

  environment {
    variables = {
      # DATABASE_URL, AUTH_JWT_SECRET and CLOUDFRONT_SHARED_SECRET are in its
      # runtime secret, never here (secrets.tf). No model key anywhere: it
      # calls Bedrock with its role.
      RUNTIME_SECRET_ARN     = aws_secretsmanager_secret.runtime["assistant"].arn
      RUNTIME_SECRET_VERSION = aws_secretsmanager_secret_version.runtime["assistant"].version_id
      ALLOWED_ORIGINS        = local.site_origin
      COOKIE_SECURE          = "true"
      NODE_EXTRA_CA_CERTS    = local.rds_ca_path
      DB_POOL_MAX            = local.assistant_db_pool_max
      # Its tools read the same runs and feeds the API does (lambda.tf).
      FEED_SOURCE = "live"

      ASSISTANT_PROVIDER       = "bedrock"
      ASSISTANT_MODEL          = var.assistant_model_id
      ASSISTANT_BEDROCK_REGION = var.aws_region
      # The same limits as the API's (lambda.tf), so its status shows what
      # is enforced here. Token caps are weighted: input + 5 x output.
      ASSISTANT_TOKENS_PER_MONTH       = tostring(var.assistant_tokens_per_month)
      ASSISTANT_TOKENS_PER_USER_MONTH  = tostring(var.assistant_tokens_per_user_month)
      ASSISTANT_TOKENS_PER_MONTH_TOTAL = tostring(local.assistant_tokens_per_month_total)
      ASSISTANT_MESSAGES_PER_HOUR      = tostring(var.assistant_messages_per_hour)
      # A turn's own bounds, pinned here rather than left to the code's
      # defaults, so the plan shows them.
      ASSISTANT_MAX_HOPS               = tostring(var.assistant_max_hops)
      ASSISTANT_MAX_TURN_TOKENS        = tostring(var.assistant_max_turn_tokens)
      ASSISTANT_MAX_TOOL_CALLS_PER_HOP = tostring(var.assistant_max_tool_calls_per_hop)
      ASSISTANT_MAX_OUTPUT_TOKENS      = tostring(var.assistant_max_output_tokens)
      ASSISTANT_MAX_TOOL_RESULT_CHARS  = tostring(var.assistant_max_tool_result_chars)
      ASSISTANT_MAX_INPUT_CHARS        = tostring(var.assistant_max_input_chars)
      # Under the 60 s origin read timeout of its CloudFront origin (s3_cloudfront.tf).
      ASSISTANT_KEEPALIVE_SECONDS = "15"
      ASSISTANT_TURN_SECONDS      = tostring(var.assistant_timeout_seconds - 15)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.assistant,
    aws_iam_role_policy.lambda_logs,
    aws_iam_role_policy.lambda_vpc_eni,
    aws_iam_role_policy.runtime_secret,
    aws_iam_role_policy.assistant_bedrock,
    aws_vpc_endpoint.secretsmanager,
    aws_vpc_endpoint.bedrock_runtime,
  ]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

# As the API's URL (lambda.tf): NONE, because CloudFront's custom origin can't
# sign for a Function URL here; the app's shared-secret check is what refuses
# a caller who skips CloudFront (and the WAF). The provider adds the public
# invoke statements itself on create. Streaming must match the handler:
# lambda-assistant.ts exports a streaming one (lambda-assistant.test.ts).
resource "aws_lambda_function_url" "assistant" {
  count              = local.assistant_count
  function_name      = aws_lambda_function.assistant[0].function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"
}
