# ----------------------------------------------------------------------------
# Production secrets — sops-encrypted in the PRIVATE estate repo
#
# This repo is PUBLIC, so nothing secret lives here, encrypted or not. The
# values come from Absence0760/infra-secrets → water-management/prod.sops.yaml,
# encrypted under alias/water-management-sops (created by the estate
# bootstrap). The carlpett/sops data source decrypts in memory at plan/apply
# through the operator's AWS credentials (kms:Decrypt on that key) — no
# plaintext file is ever written. Key list: infra/prod.sops.yaml.example.
#
# Honest scope (same as the rest of the estate): sops protects the secrets in
# git, NOT in Terraform state. The values below end up in state (as the data
# source result and in the runtime secrets below), exactly like
# random_password.cloudfront_shared_secret and the report-download signing
# key (tls_private_key.report_downloads, reports.tf). The state bucket is SSE-encrypted
# and private to this account. The one credential that never touches state is
# the RDS master password — RDS manages it in Secrets Manager (rds.tf).
# ----------------------------------------------------------------------------

locals {
  # ~/github/<this repo>/infra → ~/github/infra-secrets
  secrets_path = var.secrets_file != "" ? var.secrets_file : "${path.module}/../../infra-secrets/water-management/prod.sops.yaml"
}

data "sops_file" "prod" {
  source_file = local.secrets_path
}

locals {
  # Flat top-level keys (see prod.sops.yaml.example).
  auth_jwt_secret = data.sops_file.prod.data["auth_jwt_secret"]
  db_app_password = data.sops_file.prod.data["db_app_password"]
}

# Shape checks live as lifecycle preconditions on aws_lambda_function.backend
# (lambda.tf) so a malformed secret fails the plan rather than the first login.

# ----------------------------------------------------------------------------
# Runtime secrets — in Secrets Manager, never in a Lambda's environment
# (issue #126; docs/security.md § Runtime secrets)
#
# A Lambda's environment variables are returned in plain text to anyone with
# lambda:GetFunctionConfiguration: the deploy role, and any read-only role
# (AWS's ReadOnlyAccess grants it). A session key there lets any reader forge
# any user's session. So each Lambda that needs secrets gets its own secret
# here, a JSON object with exactly the keys it uses, and its environment only
# names it (RUNTIME_SECRET_ARN) and the version to read (RUNTIME_SECRET_VERSION).
# backend/src/config/runtimeSecrets.ts reads it once per cold start, refuses a
# missing or extra key, and puts the values in process.env; its RUNTIME_SECRETS
# lists the same keys, and backend/src/config/production.security.test.ts and
# the guardrails tftest keep the two in step.
#
# One secret per Lambda rather than one shared: each role can read only its
# own, so the worker never holds the CloudFront header secret, the API never
# holds the unsubscribe-link key, and the migrate Lambda holds only the
# password it sets. Three secrets are $1.20/month (+ $0.05 per 10,000 reads,
# one per cold start), against $0.40 for one.
#
# Rotation: change the source (sops, or -replace a random_password) and apply.
# The new secret version changes RUNTIME_SECRET_VERSION, which updates the
# function configuration, so every instance cold-starts onto the new values
# (docs/deployment.md § Rotating a secret).
#
# The values still sit in Terraform state, as before (see the header above);
# what this removes is the copy every GetFunctionConfiguration caller could
# read. Encrypted with the AWS-managed aws/secretsmanager key, like the RDS
# master secret, so a role needs only secretsmanager:GetSecretValue on its ARN.
# The API and worker reach Secrets Manager through the VPC endpoint in
# network.tf, like migrate; the fetcher and renderer (outside the VPC) hold
# no secret at all.
# ----------------------------------------------------------------------------

locals {
  # The keys must match RUNTIME_SECRETS in backend/src/config/runtimeSecrets.ts
  # (production.security.test.ts parses this block: one role per line at
  # 4 spaces, one KEY = value per line at 6).
  runtime_secrets = {
    api = {
      AUTH_JWT_SECRET          = local.auth_jwt_secret
      DATABASE_URL             = local.database_url
      CLOUDFRONT_SHARED_SECRET = random_password.cloudfront_shared_secret.result
      # Signs report download links (reports.tf); generated, like the above.
      CLOUDFRONT_PRIVATE_KEY = tls_private_key.report_downloads.private_key_pem
    }
    worker = {
      # A re-run job stores a run, stamped under a key derived from the
      # session secret (backend/src/runs/stamp.ts, docs/security.md § Run
      # stamps); the worker never signs or reads a session.
      AUTH_JWT_SECRET = local.auth_jwt_secret
      DATABASE_URL    = local.worker_database_url
      # Only the worker signs unsubscribe links (jobs.tf).
      ALERTS_TOKEN_SECRET = random_password.alerts_token_secret.result
    }
    migrate = {
      WATER_APP_PASSWORD = local.db_app_password
    }
  }

  # The role that may read each secret.
  runtime_secret_roles = {
    api     = aws_iam_role.lambda
    worker  = aws_iam_role.worker_lambda
    migrate = aws_iam_role.migrate_lambda
  }
}

resource "aws_secretsmanager_secret" "runtime" {
  for_each = toset(keys(local.runtime_secrets))

  name        = "${local.project}/runtime/${each.key}"
  description = "Runtime secrets of the ${each.key} Lambda (JSON), read once per cold start by backend/src/config/runtimeSecrets.ts."
}

resource "aws_secretsmanager_secret_version" "runtime" {
  for_each = aws_secretsmanager_secret.runtime

  secret_id     = each.value.id
  secret_string = jsonencode(local.runtime_secrets[each.key])
}

# Each Lambda role may read its own runtime secret, and nothing else.
data "aws_iam_policy_document" "runtime_secret" {
  for_each = aws_secretsmanager_secret.runtime

  statement {
    sid       = "ReadOwnRuntimeSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [each.value.arn]
  }
}

resource "aws_iam_role_policy" "runtime_secret" {
  for_each = aws_secretsmanager_secret.runtime

  name   = "read-runtime-secret"
  role   = local.runtime_secret_roles[each.key].id
  policy = data.aws_iam_policy_document.runtime_secret[each.key].json
}
