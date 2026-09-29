# ----------------------------------------------------------------------------
# Production secrets — sops-encrypted in the PRIVATE estate repo
#
# This repo is PUBLIC, so nothing secret lives here, encrypted or not. The
# values come from Absence0760/infra-secrets → water-management/prod.sops.yaml,
# encrypted under alias/water-management-sops (created by the estate
# bootstrap). infra/scripts/tf.sh runs Terraform under `sops exec-env`, which
# decrypts in memory through the operator's AWS credentials (kms:Decrypt on
# that key) and hands the values over as TF_VAR_* — no plaintext file is ever
# written. Key list: infra/prod.sops.yaml.example.
#
# Out of state (issue #126): the sops variables are ephemeral
# (variables.tf), and they reach only the runtime secrets' write-only
# `secret_string_wo` below. Terraform stores neither an ephemeral value nor a
# write-only one, in state or in a saved plan. (The RDS master password never
# reaches Terraform at all: RDS manages it in Secrets Manager, rds.tf.)
#
# What stays in state: random_password.cloudfront_shared_secret
# (s3_cloudfront.tf). The CloudFront origin's custom_header takes it, and that
# argument is not write-only, so the value sits in state twice (the
# random_password and the distribution) whatever its source. It is the edge
# check's secret, not a user credential: a reader of state could call the
# Function URL directly, past the WAF, but could not forge a session.
#
# Why variables, not an `ephemeral "sops_file"`: the carlpett/sops provider has
# one, but Terraform's test mocks cannot open an ephemeral resource before
# 1.17 (hashicorp/terraform#38928), so the whole guardrails suite would fail.
# Once .terraform-version is 1.17+, an ephemeral sops_file here (mocked with
# mock_ephemeral in the tftest) could replace tf.sh; the variables' validations
# would move to preconditions.
# ----------------------------------------------------------------------------

locals {
  auth_jwt_secret        = var.auth_jwt_secret
  db_app_password        = var.db_app_password
  alerts_token_secret    = var.alerts_token_secret
  cloudfront_private_key = var.cloudfront_private_key
}

# Shape checks live as validations on the variables (variables.tf), so a
# malformed secret fails the plan rather than the first login.

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
# Each value is written write-only (secret_string_wo): Terraform sends it to
# Secrets Manager and keeps no copy, so it cannot tell when a sops value
# changes. var.runtime_secret_version (secret_string_wo_version) is the
# signal, and it is automatic: scripts/tf.sh sets it from prod.sops.yaml's
# plaintext sops.lastmodified (YYYYMMDDhhmmss), which sops rewrites on every
# edit, and refuses a var file that would pin it. Rotation:
#   - a sops value: edit prod.sops.yaml, apply through tf.sh;
#   - the CloudFront header: `-replace=random_password.cloudfront_shared_secret`
#     (replace_triggered_by below rewrites the secrets in the same apply);
#   - unchanged values, forced: `-var runtime_secret_version=<any other number>`.
# Each replaces every secret version (the AWS provider forces a new version
# when secret_string_wo_version changes), so each version_id changes, and with
# it RUNTIME_SECRET_VERSION: the function configuration updates and every
# instance cold-starts onto the new values (docs/deployment.md § Rotating a
# secret).
#
# Encrypted with the AWS-managed aws/secretsmanager key, like the RDS
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
      # Signs report download links (reports.tf); from sops, like the session key.
      CLOUDFRONT_PRIVATE_KEY = local.cloudfront_private_key
    }
    worker = {
      # A re-run job stores a run, stamped under a key derived from the
      # session secret (backend/src/runs/stamp.ts, docs/security.md § Run
      # stamps); the worker never signs or reads a session.
      AUTH_JWT_SECRET = local.auth_jwt_secret
      DATABASE_URL    = local.worker_database_url
      # Only the worker signs unsubscribe links (jobs.tf).
      ALERTS_TOKEN_SECRET = local.alerts_token_secret
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
  # The role map's keys, not local.runtime_secrets': that map holds ephemeral
  # values, and for_each must not depend on one.
  for_each = toset(keys(local.runtime_secret_roles))

  name        = "${local.project}/runtime/${each.key}"
  description = "Runtime secrets of the ${each.key} Lambda (JSON), read once per cold start by backend/src/config/runtimeSecrets.ts."
}

resource "aws_secretsmanager_secret_version" "runtime" {
  for_each = aws_secretsmanager_secret.runtime

  secret_id = each.value.id
  # Write-only: never in state or a plan. Never secret_string (the tftest
  # refuses it).
  secret_string_wo         = jsonencode(local.runtime_secrets[each.key])
  secret_string_wo_version = var.runtime_secret_version

  lifecycle {
    # A new CloudFront header must reach the API's secret in the same apply,
    # or every API request gets 403 until the next sops edit. All three are
    # rewritten (for_each can't narrow it); the other two just cold-start.
    replace_triggered_by = [random_password.cloudfront_shared_secret]
  }
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
