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
# source result and in the API Lambda's environment), exactly like
# random_password.cloudfront_shared_secret. The state bucket is SSE-encrypted
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
