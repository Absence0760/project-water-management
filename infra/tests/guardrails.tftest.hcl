# Plan-only tests against mocked providers — no AWS credentials, no state, no
# sops key. They pin the production guardrails that `terraform validate` can't
# see: runtime/sizing of the Lambdas, the DB's durability + privacy settings,
# the DATABASE_URL shape, the single-origin CloudFront wiring, and the plan-time
# rejection of malformed secrets.
#
#   cd infra && terraform init -backend=false && terraform test
#
# (Terraform 1.15 also needs the gitignored backend_override.tf described in
# infra/README.md § Validating locally.)

mock_provider "aws" {
  # A mocked policy document renders a random string, which IAM/SNS/S3 policy
  # arguments then reject as invalid JSON. Any well-formed document does.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["af-south-1a", "af-south-1b", "af-south-1c"]
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::000000000000:role/water-management-deploy"
      name = "water-management-deploy"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "sops" {
  mock_data "sops_file" {
    defaults = {
      data = {
        auth_jwt_secret = "0123456789abcdef0123456789abcdef0123456789abcdef"
        db_app_password = "abcdef0123456789abcdef0123456789abcdef01234567"
      }
    }
  }
}

mock_provider "archive" {}
mock_provider "random" {}

# Mocked RDS has no provider logic, so the computed master secret and
# endpoint would stay unknown/empty. Supply what RDS really returns.
override_resource {
  target          = aws_db_instance.main
  override_during = plan
  values = {
    address = "water-management.abc123.af-south-1.rds.amazonaws.com"
    port    = 5432
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:af-south-1:000000000000:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
      kms_key_id    = "arn:aws:kms:af-south-1:000000000000:key/00000000-0000-0000-0000-000000000000"
      secret_status = "active"
    }]
  }
}

override_resource {
  target          = aws_acm_certificate.frontend
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    domain_validation_options = [{
      domain_name           = "water-management.jaredhoward.com"
      resource_record_name  = "_0123abcd.water-management.jaredhoward.com."
      resource_record_type  = "CNAME"
      resource_record_value = "_4567efab.acm-validations.aws."
    }]
  }
}

variables {
  aws_region      = "af-south-1"
  route53_zone_id = "Z0000000000000000000"
  github_repo     = "Absence0760/project-water-management"
  secrets_file    = "/dev/null"
}

run "production_guardrails" {
  command = plan

  # --- API Lambda --------------------------------------------------------
  assert {
    condition     = aws_lambda_function.backend.runtime == "nodejs24.x" && aws_lambda_function.migrate.runtime == "nodejs24.x"
    error_message = "Both Lambdas must run nodejs24.x."
  }
  assert {
    condition     = aws_lambda_function.backend.memory_size == 1024 && aws_lambda_function.backend.timeout == 30
    error_message = "API Lambda must default to 1024 MB / 30 s for model runs."
  }
  assert {
    condition     = aws_lambda_function.backend.reserved_concurrent_executions == 10
    error_message = "API Lambda concurrency must be capped by default (spend + DB connections)."
  }
  assert {
    condition     = startswith(aws_lambda_function.backend.environment[0].variables["DATABASE_URL"], "postgresql://water_app:") && endswith(aws_lambda_function.backend.environment[0].variables["DATABASE_URL"], "@water-management.abc123.af-south-1.rds.amazonaws.com:5432/water?sslmode=verify-full")
    error_message = "DATABASE_URL must connect as water_app to the RDS endpoint with sslmode=verify-full."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["ALLOWED_ORIGINS"] == "https://water-management.jaredhoward.com"
    error_message = "ALLOWED_ORIGINS must be exactly the site origin."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["COOKIE_SECURE"] == "true"
    error_message = "COOKIE_SECURE must be on in production."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["NODE_EXTRA_CA_CERTS"] == "/var/task/rds-global-bundle.pem"
    error_message = "The API must trust the RDS CA bundle shipped in its zip."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "MASTER_SECRET_ARN")
    error_message = "The API Lambda must never be given the owner credentials."
  }
  assert {
    condition     = length(aws_subnet.private) == 2 && length(aws_lambda_function.backend.vpc_config) == 1
    error_message = "API Lambda must run in the VPC, which has two private subnets."
  }
  assert {
    condition     = length(aws_lambda_function_url.backend.cors) == 0
    error_message = "The Function URL must not carry a CORS block — the browser never calls it."
  }

  # --- Migrate Lambda ----------------------------------------------------
  assert {
    condition     = aws_lambda_function.migrate.handler == "dist/lambda-migrate.handler"
    error_message = "Migrate handler must match the package layout (dist/ next to migrations/)."
  }
  assert {
    condition     = aws_lambda_function.migrate.environment[0].variables["MASTER_SECRET_ARN"] == aws_db_instance.main.master_user_secret[0].secret_arn
    error_message = "Migrate Lambda must read the RDS-managed master secret."
  }

  # --- RDS -----------------------------------------------------------------
  assert {
    condition     = aws_db_instance.main.engine == "postgres" && aws_db_instance.main.engine_version == "17"
    error_message = "Database must be PostgreSQL 17 (same major as local dev)."
  }
  assert {
    condition     = aws_db_instance.main.instance_class == "db.t4g.micro" && aws_db_instance.main.multi_az == false
    error_message = "Default DB must be single-AZ db.t4g.micro."
  }
  assert {
    condition     = aws_db_instance.main.storage_encrypted && aws_db_instance.main.deletion_protection && !aws_db_instance.main.publicly_accessible
    error_message = "DB must be encrypted, deletion-protected and private."
  }
  assert {
    condition     = aws_db_instance.main.backup_retention_period >= 7 && aws_db_instance.main.skip_final_snapshot == false
    error_message = "DB needs >= 7 days of backups and a final snapshot."
  }
  assert {
    condition     = aws_db_instance.main.manage_master_user_password == true && aws_db_instance.main.password == null
    error_message = "The master password must be RDS-managed (never in Terraform state)."
  }
  assert {
    condition     = aws_db_instance.main.performance_insights_enabled == false
    error_message = "Performance Insights stays off (cost)."
  }

  # --- Edge ----------------------------------------------------------------
  assert {
    condition     = aws_cloudfront_distribution.frontend.aliases == toset(["water-management.jaredhoward.com"])
    error_message = "CloudFront must serve exactly the child-zone hostname."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.frontend.custom_error_response) == 0
    error_message = "No distribution-wide custom error responses — they would rewrite API 403/404 JSON into index.html. The SPA fallback is the spa_rewrite function."
  }
  assert {
    condition     = aws_acm_certificate.frontend.domain_name == "water-management.jaredhoward.com"
    error_message = "Certificate must cover the child-zone hostname."
  }
}

run "rejects_short_jwt_secret" {
  command = plan

  override_data {
    target = data.sops_file.prod
    values = {
      data = {
        auth_jwt_secret = "too-short"
        db_app_password = "abcdef0123456789abcdef0123456789abcdef01234567"
      }
    }
  }

  expect_failures = [aws_lambda_function.backend]
}

run "rejects_non_alphanumeric_db_password" {
  command = plan

  override_data {
    target = data.sops_file.prod
    values = {
      data = {
        auth_jwt_secret = "0123456789abcdef0123456789abcdef0123456789abcdef"
        db_app_password = "has@special/chars-and-is-long-enough"
      }
    }
  }

  expect_failures = [aws_lambda_function.backend]
}
