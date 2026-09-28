# Plan-only tests against mocked providers — no AWS credentials, no state, no
# sops key. They pin the production guardrails that `terraform validate` can't
# see: runtime/sizing of the Lambdas, the DB's durability + privacy settings,
# the DATABASE_URL shape, the single-origin CloudFront wiring, WAF + security
# headers + CSP, private S3, SES identity / DNS / least-privilege send, the
# background-job queues / worker / SQS endpoint policy, the data-feed queues and the fetcher outside the VPC,
# the report bucket / renderer image and Lambda / render queues, the SES bounce/complaint chain to the worker, the alarms, the deploy role's trust pin, and the plan-time rejection of
# malformed secrets.
#
#   pnpm check:infra          (bin/check-infra.sh: fmt + validate + test)
#
# CI runs the same thing (.github/workflows/ci.yml, job `terraform`).

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
      # The bootstrap's trust policy as IAM returns it (single values
      # collapsed to strings) — templates infra/modules/project-baseline.
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:environment:production\"}}}]}"
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

# Easy DKIM returns three tokens only after create; the DKIM records index them.
override_resource {
  target          = aws_sesv2_email_identity.domain
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:identity/water-management.jaredhoward.com"
    dkim_signing_attributes = {
      next_signing_key_length = "RSA_2048_BIT"
      tokens                  = ["tok1", "tok2", "tok3"]
    }
  }
}

override_resource {
  target          = aws_sesv2_configuration_set.main
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:configuration-set/water-management"
  }
}

# Known ARNs / IDs so wiring (WAF → distribution, header policy → behaviour,
# alarm → topic) can be asserted by equality at plan time.
override_resource {
  target          = aws_wafv2_web_acl.frontend
  override_during = plan
  values = {
    arn = "arn:aws:wafv2:us-east-1:000000000000:global/webacl/water-management-frontend-acl/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.site
  override_during = plan
  values = {
    id = "site-headers-policy-id"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.api
  override_during = plan
  values = {
    id = "api-headers-policy-id"
  }
}

override_resource {
  target          = aws_iam_role.lambda
  override_during = plan
  values = {
    id  = "water-management-backend-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-backend-lambda"
  }
}

override_resource {
  target          = aws_s3_bucket.frontend
  override_during = plan
  values = {
    arn = "arn:aws:s3:::water-management-frontend-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.frontend
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:distribution/E0000000000000"
  }
}

override_resource {
  target          = aws_lambda_function.backend
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-backend"
  }
}

override_resource {
  target          = aws_lambda_function.migrate
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-migrate"
  }
}

override_resource {
  target          = aws_lambda_function.worker
  override_during = plan
  values = {
    arn           = "arn:aws:lambda:af-south-1:000000000000:function:water-management-worker"
    function_name = "water-management-worker"
  }
}

override_resource {
  target          = aws_iam_role.worker_lambda
  override_during = plan
  values = {
    id  = "water-management-worker-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-worker-lambda"
  }
}

override_resource {
  target          = aws_sqs_queue.jobs
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-jobs"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-jobs"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.worker_tick
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-worker-tick"
  }
}

override_resource {
  target          = aws_security_group.worker_lambda
  override_during = plan
  values = {
    id = "sg-0000000000worker"
  }
}

override_resource {
  target          = aws_sqs_queue.jobs_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-jobs-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-jobs-dlq"
  }
}

# Data feeds (feeds.tf, WP-2.10)
override_resource {
  target          = aws_sqs_queue.fetch_requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests"
  }
}

override_resource {
  target          = aws_sqs_queue.fetch_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests-dlq"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_results
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-ingest-results"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-ingest-results"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_results_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-ingest-results-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-ingest-results-dlq"
  }
}

override_resource {
  target          = aws_lambda_function.fetcher
  override_during = plan
  values = {
    arn           = "arn:aws:lambda:af-south-1:000000000000:function:water-management-fetcher"
    function_name = "water-management-fetcher"
  }
}

override_resource {
  target          = aws_iam_role.fetcher_lambda
  override_during = plan
  values = {
    id  = "water-management-fetcher-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-fetcher-lambda"
  }
}

# Server-side reports (reports.tf, WP-2.15 Phase B)
override_resource {
  target          = aws_sqs_queue.render_requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-requests"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-requests"
  }
}

override_resource {
  target          = aws_sqs_queue.render_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-requests-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-requests-dlq"
  }
}

override_resource {
  target          = aws_sqs_queue.render_results
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-results"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-results"
  }
}

override_resource {
  target          = aws_sqs_queue.render_results_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-results-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-results-dlq"
  }
}

override_resource {
  target          = aws_s3_bucket.reports
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-reports-000000000000"
    bucket = "water-management-reports-000000000000"
  }
}

override_resource {
  target          = aws_ecr_repository.renderer
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:af-south-1:000000000000:repository/water-management-renderer"
    repository_url = "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-renderer"
  }
}

override_resource {
  target          = aws_iam_role.renderer_lambda
  override_during = plan
  values = {
    id  = "water-management-renderer-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-renderer-lambda"
  }
}

override_resource {
  target          = aws_security_group.vpce_ses
  override_during = plan
  values = {
    id = "sg-00000000000vpceses"
  }
}

override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts"
  }
}

# SES bounces and complaints → the worker (ses.tf, WP-2.13 follow-up)
override_resource {
  target          = aws_sns_topic.ses_events
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-ses-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mail-events"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mail-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mail-events-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mail-events-dlq"
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
  # A major upgrade replaces the parameter group (new family), so it must be
  # create-before-destroy under a generated name: a fixed `name` collides with
  # the group the instance is still using (rds.tf § locals).
  # Lifecycle settings aren't plan attributes, so that half reads the source
  # (the resource block, up to its closing brace at column 0).
  assert {
    condition = (
      aws_db_parameter_group.main.name_prefix == "water-management-pg17-"
      && aws_db_parameter_group.main.family == "postgres17"
      && can(regex("create_before_destroy\\s*=\\s*true", regex("(?s)resource \"aws_db_parameter_group\" \"main\" \\{.*?\\n\\}", file("rds.tf"))))
    )
    error_message = "The DB parameter group must use name_prefix (never a fixed name), the postgres17 family, and lifecycle { create_before_destroy = true }."
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
    condition     = strcontains(aws_cloudfront_function.spa_rewrite.code, "uri === '/welcome' || uri === '/privacy' || uri === '/terms' || uri === '/methods'") && strcontains(aws_cloudfront_function.spa_rewrite.code, "request.uri = uri + '.html'")
    error_message = "The prerendered pages (/welcome, /privacy, /terms, /methods) must be served from their .html, not the SPA fallback."
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

run "rejects_dev_placeholder_jwt_secret" {
  command = plan

  # Long enough, so only the placeholder check can refuse it.
  override_data {
    target = data.sops_file.prod
    values = {
      data = {
        auth_jwt_secret = "dev-only-jwt-secret-change-me-0000000000"
        db_app_password = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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

# ---------------------------------------------------------------------------
# Edge: WAF, private S3, TLS, security headers + CSP
# ---------------------------------------------------------------------------

run "edge_security" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.frontend.web_acl_id == aws_wafv2_web_acl.frontend.arn
    error_message = "The WAF web ACL must be attached to the distribution (it is the API's rate limit too)."
  }
  assert {
    condition     = aws_wafv2_web_acl.frontend.scope == "CLOUDFRONT" && length(aws_wafv2_web_acl.frontend.rule) == 2
    error_message = "WAF must be a CLOUDFRONT-scope ACL with the auth + site-wide rate rules."
  }
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.frontend.block_public_acls,
      aws_s3_bucket_public_access_block.frontend.block_public_policy,
      aws_s3_bucket_public_access_block.frontend.ignore_public_acls,
      aws_s3_bucket_public_access_block.frontend.restrict_public_buckets,
    ])
    error_message = "The frontend bucket must block every form of public access."
  }
  assert {
    condition     = aws_s3_bucket_ownership_controls.frontend.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled on the frontend bucket (BucketOwnerEnforced)."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.frontend.signing_behavior == "always" &&
      one(data.aws_iam_policy_document.frontend_bucket_policy.statement[0].principals).identifiers == toset(["cloudfront.amazonaws.com"]) &&
      data.aws_iam_policy_document.frontend_bucket_policy.statement[0].actions == toset(["s3:GetObject"])
    )
    error_message = "S3 must be readable only by CloudFront through OAC (signed, s3:GetObject only)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "Viewer TLS must be TLSv1.2_2021 or newer."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].viewer_protocol_policy == "https-only"
    error_message = "HTTP must redirect (site) or be refused (API)."
  }
  assert {
    condition     = strcontains(aws_cloudfront_function.api_strip_prefix.code, "request.headers['x-viewer-address'] = { value: event.viewer.ip }")
    error_message = "The /api viewer-request function must overwrite X-Viewer-Address with the viewer's IP (the sign-up throttle's client address, backend/src/http/clientAddress.ts)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.price_class == "PriceClass_All"
    error_message = "Default price class must include the South African edges (only PriceClass_All does)."
  }

  # Header policies attached to the right behaviours.
  assert {
    condition     = aws_cloudfront_distribution.frontend.default_cache_behavior[0].response_headers_policy_id == "site-headers-policy-id"
    error_message = "The SPA behaviour must use the site security-headers policy."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].response_headers_policy_id == "api-headers-policy-id"
    error_message = "The /api/* behaviour must use the API security-headers policy."
  }

  # Site CSP: the directives the header owns.
  assert {
    condition = alltrue([for d in [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ] : strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, d)])
    error_message = "Site CSP is missing a required directive."
  }
  assert {
    condition     = !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval") && !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "*")
    error_message = "Site CSP must never allow unsafe-eval or a wildcard source."
  }
  assert {
    condition     = !can(regex("https?:", aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy))
    error_message = "Site CSP must not allow any third-party origin (everything is self-hosted)."
  }
  assert {
    condition     = startswith(aws_cloudfront_response_headers_policy.api.security_headers_config[0].content_security_policy[0].content_security_policy, "default-src 'none'")
    error_message = "API responses must carry default-src 'none'."
  }

  # The rest of the header set, on both policies.
  assert {
    condition = alltrue([for p in [aws_cloudfront_response_headers_policy.site, aws_cloudfront_response_headers_policy.api] :
      p.security_headers_config[0].strict_transport_security[0].access_control_max_age_sec >= 31536000 &&
      p.security_headers_config[0].strict_transport_security[0].include_subdomains &&
      p.security_headers_config[0].strict_transport_security[0].override &&
      p.security_headers_config[0].content_security_policy[0].override &&
      p.security_headers_config[0].content_type_options[0].override &&
      p.security_headers_config[0].frame_options[0].frame_option == "DENY"
    ])
    error_message = "Both header policies need HSTS >= 1 year (subdomains, override), an overriding CSP, nosniff and X-Frame-Options DENY."
  }
  assert {
    condition     = aws_cloudfront_response_headers_policy.site.security_headers_config[0].referrer_policy[0].referrer_policy == "strict-origin-when-cross-origin"
    error_message = "Site Referrer-Policy must be strict-origin-when-cross-origin."
  }
}

# ---------------------------------------------------------------------------
# Email: SES identity, DNS, least-privilege send, private network path
# ---------------------------------------------------------------------------

run "email_ses" {
  command = plan

  assert {
    condition     = aws_sesv2_email_identity.domain.email_identity == "water-management.jaredhoward.com" && aws_sesv2_email_identity.domain.dkim_signing_attributes[0].next_signing_key_length == "RSA_2048_BIT"
    error_message = "The domain identity must use Easy DKIM with 2048-bit keys."
  }
  assert {
    condition     = length(aws_route53_record.ses_dkim) == 3 && aws_route53_record.ses_dkim[0].name == "tok1._domainkey.water-management.jaredhoward.com"
    error_message = "Three DKIM CNAMEs, one per token, under _domainkey."
  }
  assert {
    # af-south-1 is one of the regions with a regional DKIM domain.
    condition     = tolist(aws_route53_record.ses_dkim[0].records)[0] == "tok1.dkim.af-south-1.amazonses.com"
    error_message = "DKIM CNAMEs in af-south-1 must point at dkim.af-south-1.amazonses.com."
  }
  assert {
    condition     = aws_sesv2_email_identity_mail_from_attributes.domain.mail_from_domain == "mail.water-management.jaredhoward.com" && tolist(aws_route53_record.ses_mail_from_mx.records)[0] == "10 feedback-smtp.af-south-1.amazonses.com"
    error_message = "Custom MAIL FROM must be mail.<domain> with the regional feedback MX."
  }
  assert {
    condition     = tolist(aws_route53_record.ses_mail_from_spf.records)[0] == "v=spf1 include:amazonses.com -all"
    error_message = "MAIL FROM SPF must authorise only SES."
  }
  assert {
    condition     = aws_route53_record.dmarc.name == "_dmarc.water-management.jaredhoward.com" && startswith(tolist(aws_route53_record.dmarc.records)[0], "v=DMARC1; p=none")
    error_message = "DMARC must start at p=none."
  }
  assert {
    condition     = aws_sesv2_configuration_set.main.delivery_options[0].tls_policy == "REQUIRE" && toset(aws_sesv2_configuration_set.main.suppression_options[0].suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "Configuration set must require TLS and suppress bounces + complaints."
  }

  # IAM: one action, this account's identities (the sandbox authorises the
  # recipient's too) + the configuration set, pinned From address.
  assert {
    condition     = data.aws_iam_policy_document.lambda_ses.statement[0].actions == toset(["ses:SendEmail"])
    error_message = "The API Lambda may only call ses:SendEmail."
  }
  assert {
    condition     = data.aws_iam_policy_document.lambda_ses.statement[0].resources == toset(["arn:aws:ses:af-south-1:000000000000:identity/*", aws_sesv2_configuration_set.main.arn])
    error_message = "ses:SendEmail must be scoped to this account's SES identities in its own region (sandbox sends authorise the recipient's identity too) and the configuration set: no other account, region or resource type."
  }
  assert {
    condition     = length(data.aws_iam_policy_document.lambda_ses.statement) == 1 && length(data.aws_iam_policy_document.lambda_ses.statement[0].condition) == 1
    error_message = "The identity/* grant is safe only with the ses:FromAddress condition on the same, single statement."
  }
  assert {
    condition     = one(data.aws_iam_policy_document.lambda_ses.statement[0].condition).variable == "ses:FromAddress" && one(data.aws_iam_policy_document.lambda_ses.statement[0].condition).values == tolist(["no-reply@water-management.jaredhoward.com"])
    error_message = "ses:SendEmail must be conditioned on From = no-reply@<domain>."
  }
  assert {
    condition     = aws_iam_role_policy.lambda_ses.role == aws_iam_role.lambda.id
    error_message = "The SES send policy belongs to the API Lambda role (not the migrate role)."
  }

  # Network path + app config.
  assert {
    condition     = aws_vpc_endpoint.ses.service_name == "com.amazonaws.af-south-1.email" && aws_vpc_endpoint.ses.vpc_endpoint_type == "Interface" && aws_vpc_endpoint.ses.private_dns_enabled
    error_message = "The Lambda reaches the SES API through an interface endpoint with private DNS."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.vpce_ses_from_api.from_port == 443 && aws_vpc_security_group_ingress_rule.vpce_ses_from_api.to_port == 443
    error_message = "The SES endpoint accepts HTTPS only."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["MAIL_TRANSPORT"] == "ses" &&
      aws_lambda_function.backend.environment[0].variables["MAIL_FROM"] == "Water Management <no-reply@water-management.jaredhoward.com>" &&
      aws_lambda_function.backend.environment[0].variables["SITE_URL"] == "https://water-management.jaredhoward.com" &&
      aws_lambda_function.backend.environment[0].variables["SES_CONFIGURATION_SET"] == "water-management"
    )
    error_message = "The API Lambda must be configured to send through SES as no-reply@ with SITE_URL = the site origin."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.migrate.environment[0].variables), "MAIL_TRANSPORT")
    error_message = "The migrate Lambda sends no email."
  }
}

run "dkim_uses_global_domain_outside_opt_in_regions" {
  command = plan

  variables {
    aws_region                = "eu-west-1"
    data_outside_south_africa = true
  }

  assert {
    condition     = tolist(aws_route53_record.ses_dkim[0].records)[0] == "tok1.dkim.amazonses.com"
    error_message = "DKIM CNAMEs outside the regional-DKIM regions point at dkim.amazonses.com."
  }
  assert {
    condition     = aws_vpc_endpoint.ses.service_name == "com.amazonaws.eu-west-1.email"
    error_message = "The SES endpoint follows var.aws_region."
  }
}

# The privacy notice promises storage in South Africa: another region is refused unless deliberately allowed.
run "refuses_a_region_outside_south_africa_by_default" {
  command = plan

  variables {
    aws_region = "eu-west-1"
  }

  expect_failures = [var.aws_region]
}

run "rejects_invalid_dmarc_policy" {
  command = plan
  variables {
    dmarc_policy = "strict"
  }
  expect_failures = [var.dmarc_policy]
}

# ---------------------------------------------------------------------------
# Alarms + budget
# ---------------------------------------------------------------------------

run "alarms" {
  command = plan

  variables {
    budget_alert_email = "ops@example.com"
  }

  assert {
    condition = alltrue([for a in [
      aws_cloudwatch_metric_alarm.lambda_errors,
      aws_cloudwatch_metric_alarm.lambda_throttles,
      aws_cloudwatch_metric_alarm.lambda_duration,
      aws_cloudwatch_metric_alarm.migrate_errors,
      aws_cloudwatch_metric_alarm.rds_cpu,
      aws_cloudwatch_metric_alarm.rds_cpu_credits,
      aws_cloudwatch_metric_alarm.rds_free_storage,
      aws_cloudwatch_metric_alarm.rds_connections,
      aws_cloudwatch_metric_alarm.rds_freeable_memory,
      aws_cloudwatch_metric_alarm.ses_bounce_rate,
      aws_cloudwatch_metric_alarm.ses_complaint_rate,
      aws_cloudwatch_metric_alarm.jobs_dlq_depth,
      aws_cloudwatch_metric_alarm.worker_errors,
      aws_cloudwatch_metric_alarm.worker_throttles,
      aws_cloudwatch_metric_alarm.worker_heartbeat,
      aws_cloudwatch_metric_alarm.worker_tick_failed,
      aws_cloudwatch_metric_alarm.jobs_backlog,
      aws_cloudwatch_metric_alarm.job_dead,
      aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth,
      aws_cloudwatch_metric_alarm.ingest_results_dlq_depth,
      aws_cloudwatch_metric_alarm.fetcher_errors,
    ] : a.alarm_actions == toset([aws_sns_topic.alerts.arn])])
    error_message = "Every regional alarm must notify the alerts SNS topic."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.lambda_duration.threshold == 24000
    error_message = "Duration alarm fires at 80% of the 30 s timeout."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.rds_connections.threshold < 80
    error_message = "Connection alarm must fire below db.t4g.micro's ~80 max_connections."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_bounce_rate.threshold < 0.05 && aws_cloudwatch_metric_alarm.ses_complaint_rate.threshold < 0.001
    error_message = "SES alarms must fire before AWS's review thresholds (5% bounce, 0.1% complaint)."
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "60"
    error_message = "A $60 monthly budget exists by default."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email[0].endpoint == "ops@example.com" && aws_sns_topic_subscription.alerts_us_east_1_email[0].endpoint == "ops@example.com"
    error_message = "Both SNS topics (regional + us-east-1) must email budget_alert_email."
  }

  # --- Self-check-failed metric filter + alarm ----------------------------
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.self_check_failed.log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.self_check_failed_worker.log_group_name == aws_cloudwatch_log_group.worker.name
    )
    error_message = "Self-check failures must be counted from both log groups: the API's (user runs) and the worker's (automatic re-runs, forecast runs)."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.self_check_failed.pattern == "{ $.event = \"self_check_failed\" }"
    error_message = "The filter must match executeRun's structured event name exactly."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.self_check_failed.metric_name == aws_cloudwatch_log_metric_filter.self_check_failed.metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.self_check_failed.namespace == aws_cloudwatch_log_metric_filter.self_check_failed.metric_transformation[0].namespace
    )
    error_message = "The alarm must watch the metric the filter emits."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.self_check_failed.threshold == 0 && aws_cloudwatch_metric_alarm.self_check_failed.comparison_operator == "GreaterThanThreshold"
    error_message = "The alarm must fire on any self-check failure (> 0 in the period)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.self_check_failed.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "The self-check alarm must notify the same alerts SNS topic as every other alarm."
  }
}

# ---------------------------------------------------------------------------
# Background jobs (jobs.tf, WP-2.8)
# ---------------------------------------------------------------------------

run "background_jobs" {
  command = plan

  # --- Queues: SSE everywhere, a DLQ after 5 receives -------------------------
  assert {
    condition     = aws_sqs_queue.jobs.sqs_managed_sse_enabled && aws_sqs_queue.jobs_dlq.sqs_managed_sse_enabled
    error_message = "Both job queues must be encrypted at rest (SQS-managed SSE)."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.jobs.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.jobs.redrive_policy).deadLetterTargetArn == aws_sqs_queue.jobs_dlq.arn
    )
    error_message = "The jobs queue must dead-letter to its DLQ after 5 receives."
  }
  assert {
    condition     = aws_sqs_queue.jobs.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    error_message = "Visibility timeout must be at least 6x the worker timeout, or messages redeliver mid-tick."
  }

  # --- Worker Lambda ------------------------------------------------------------
  assert {
    condition = (
      aws_lambda_function.worker.runtime == "nodejs24.x" &&
      aws_lambda_function.worker.handler == "lambda-worker.handler" &&
      aws_lambda_function.worker.memory_size == 1024 &&
      aws_lambda_function.worker.timeout == 300
    )
    error_message = "Worker Lambda: nodejs24.x, lambda-worker.handler, 1024 MB, 300 s."
  }
  assert {
    condition     = aws_lambda_function.worker.reserved_concurrent_executions == 8
    error_message = "Worker concurrency must be capped at 8 by default: its four SQS triggers x 2, and no more (spend + DB connections)."
  }
  assert {
    condition     = length(aws_lambda_function.worker.vpc_config) == 1 && aws_lambda_function.worker.vpc_config[0].security_group_ids == toset([aws_security_group.worker_lambda.id])
    error_message = "The worker runs in the VPC with its own security group."
  }
  assert {
    condition = (
      startswith(aws_lambda_function.worker.environment[0].variables["DATABASE_URL"], "postgresql://water_app:") &&
      strcontains(aws_lambda_function.worker.environment[0].variables["DATABASE_URL"], "sslmode=verify-full") &&
      aws_lambda_function.worker.environment[0].variables["JOB_TRANSPORT"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["JOBS_QUEUE_URL"] == aws_sqs_queue.jobs.url
    )
    error_message = "The worker connects as the RLS-bound water_app over verified TLS, with the sqs transport."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.worker.environment[0].variables), "MASTER_SECRET_ARN")
    error_message = "The worker must never be given the owner credentials: jobs run under RLS."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["JOB_TRANSPORT"] == "sqs" &&
      aws_lambda_function.backend.environment[0].variables["JOBS_QUEUE_URL"] == aws_sqs_queue.jobs.url
    )
    error_message = "The API must wake the worker through the jobs queue."
  }

  # --- Triggers -------------------------------------------------------------------
  assert {
    condition     = aws_cloudwatch_event_rule.worker_tick.schedule_expression == "rate(5 minutes)" && aws_cloudwatch_event_target.worker_tick.arn == aws_lambda_function.worker.arn
    error_message = "EventBridge must tick the worker every 5 minutes."
  }
  assert {
    condition     = aws_lambda_permission.worker_tick.principal == "events.amazonaws.com" && aws_lambda_permission.worker_tick.source_arn == aws_cloudwatch_event_rule.worker_tick.arn
    error_message = "Only the tick rule may invoke the worker through EventBridge."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.worker_jobs.event_source_arn == aws_sqs_queue.jobs.arn && aws_lambda_event_source_mapping.worker_jobs.function_name == aws_lambda_function.worker.arn
    error_message = "The jobs queue must trigger the worker."
  }

  # --- SQS endpoint: private DNS, and a policy naming only our roles and queue ---
  assert {
    condition     = aws_vpc_endpoint.sqs.vpc_endpoint_type == "Interface" && aws_vpc_endpoint.sqs.private_dns_enabled && aws_vpc_endpoint.sqs.service_name == "com.amazonaws.af-south-1.sqs"
    error_message = "SQS must be reached through a private-DNS interface endpoint (no NAT)."
  }
  assert {
    condition     = length(aws_vpc_endpoint.sqs.subnet_ids) == 1
    error_message = "The SQS endpoint defaults to one AZ (sqs_endpoint_az_count, cost)."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.sqs_endpoint.statement :
      length(s.resources) == 1 && contains([aws_sqs_queue.jobs.arn, aws_sqs_queue.fetch_requests.arn, aws_sqs_queue.ingest_results.arn, aws_sqs_queue.render_requests.arn, aws_sqs_queue.render_results.arn, aws_sqs_queue.mail_events.arn], one(s.resources)) &&
      alltrue([for a in s.actions : !strcontains(a, "*")])
    ])
    error_message = "The SQS endpoint policy must name only the jobs, data-feed, render and mail-events queues, one per statement, with no wildcard actions."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.sqs_endpoint.statement : [for p in s.principals : p.identifiers]])) == toset([
      aws_iam_role.lambda.arn, aws_iam_role.worker_lambda.arn,
    ])
    error_message = "Only the API and worker roles may use the SQS endpoint."
  }
  assert {
    condition = alltrue(flatten([for d in [data.aws_iam_policy_document.worker_lambda, data.aws_iam_policy_document.lambda_jobs_send] : [
      for s in d.statement : toset(s.resources) == toset([aws_sqs_queue.jobs.arn])
    ]]))
    error_message = "The API and worker IAM policies reach the jobs queue only."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), aws_lambda_function.worker.arn)
    error_message = "The deploy role must be able to update the worker's code."
  }

  # --- Alarms -----------------------------------------------------------------------
  assert {
    condition     = aws_cloudwatch_metric_alarm.jobs_dlq_depth.threshold == 0 && aws_cloudwatch_metric_alarm.jobs_dlq_depth.dimensions["QueueName"] == aws_sqs_queue.jobs_dlq.name
    error_message = "DLQ depth > 0 must alarm."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.jobs_backlog.namespace == "water-management/Jobs" && aws_cloudwatch_metric_alarm.jobs_backlog.metric_name == "OldestDueJobAgeSeconds"
    error_message = "The backlog alarm must read the metric lambda-worker.ts emits (METRIC_NAMESPACE, OldestDueJobAgeSeconds)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_heartbeat.namespace == "AWS/Lambda" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.metric_name == "Invocations" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.dimensions["FunctionName"] == aws_lambda_function.worker.function_name &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.threshold == 1 &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.period * aws_cloudwatch_metric_alarm.worker_heartbeat.evaluation_periods == 900 &&
      aws_cloudwatch_metric_alarm.worker_heartbeat.treat_missing_data == "breaching"
    )
    error_message = "The worker heartbeat must alarm on < 1 invocation in 15 minutes (three ticks), with missing data breaching: a stopped worker emits no data."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_tick_failed.namespace == "AWS/Events" &&
      aws_cloudwatch_metric_alarm.worker_tick_failed.metric_name == "FailedInvocations" &&
      aws_cloudwatch_metric_alarm.worker_tick_failed.dimensions["RuleName"] == aws_cloudwatch_event_rule.worker_tick.name &&
      aws_cloudwatch_metric_alarm.worker_tick_failed.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.worker_tick_failed.threshold == 0
    )
    error_message = "EventBridge failing to deliver the worker tick must alarm (FailedInvocations > 0 on the worker-tick rule)."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.job_dead.log_group_name == aws_cloudwatch_log_group.worker.name && aws_cloudwatch_log_metric_filter.job_dead.pattern == "{ $.event = \"job_dead\" }"
    error_message = "The dead-job filter must match runner.ts's structured event in the worker's log group."
  }

  # --- Alert emails (WP-2.13) -------------------------------------------------------
  assert {
    condition = (
      contains(keys(aws_lambda_function.worker.environment[0].variables), "ALERTS_TOKEN_SECRET") &&
      random_password.alerts_token_secret.length >= 32 && !random_password.alerts_token_secret.special &&
      aws_lambda_function.worker.environment[0].variables["ALERTS_ENABLED"] == "true"
    )
    error_message = "The worker signs unsubscribe links (ALERTS_TOKEN_SECRET, ≥ 32 characters) and sends alerts unless the kill switch is off."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "ALERTS_TOKEN_SECRET")
    error_message = "Only the worker holds the unsubscribe-token secret: the API checks a token by its hash alone."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.alert_storm.namespace == "water-management/Jobs" && aws_cloudwatch_metric_alarm.alert_storm.metric_name == "AlertMailsSent" &&
      aws_cloudwatch_metric_alarm.alert_storm.alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The alert-storm alarm must read the metric lambda-worker.ts emits (AlertMailsSent) and notify the alerts topic."
  }
}

# ---------------------------------------------------------------------------
# SES bounces and complaints → the app (ses.tf, WP-2.13 follow-up)
# ---------------------------------------------------------------------------

run "mail_suppression" {
  command = plan

  # --- The event destination: bounces and complaints, to the ses-events topic ------
  assert {
    condition = (
      aws_sesv2_configuration_set_event_destination.suppression.configuration_set_name == aws_sesv2_configuration_set.main.configuration_set_name &&
      aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].enabled &&
      toset(aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].matching_event_types) == toset(["BOUNCE", "COMPLAINT"]) &&
      aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].sns_destination[0].topic_arn == aws_sns_topic.ses_events.arn
    )
    error_message = "The configuration set publishes bounces and complaints (and nothing else) to the ses-events topic."
  }

  # --- Trust down the chain: SES (this set, this account) → topic → queue ------------
  assert {
    condition = (
      length(data.aws_iam_policy_document.ses_events_topic.statement) == 1 &&
      data.aws_iam_policy_document.ses_events_topic.statement[0].actions == toset(["sns:Publish"]) &&
      data.aws_iam_policy_document.ses_events_topic.statement[0].resources == toset([aws_sns_topic.ses_events.arn]) &&
      toset(flatten([for p in data.aws_iam_policy_document.ses_events_topic.statement[0].principals : p.identifiers])) == toset(["ses.amazonaws.com"]) &&
      anytrue([for c in data.aws_iam_policy_document.ses_events_topic.statement[0].condition : c.variable == "aws:SourceArn" && c.values == tolist([aws_sesv2_configuration_set.main.arn])]) &&
      anytrue([for c in data.aws_iam_policy_document.ses_events_topic.statement[0].condition : c.variable == "aws:SourceAccount" && c.values == tolist(["000000000000"])])
    )
    error_message = "Only SES, for this configuration set in this account, may publish to the ses-events topic."
  }
  assert {
    condition     = aws_sns_topic_policy.ses_events.arn == aws_sns_topic.ses_events.arn
    error_message = "The ses-events topic carries its publish policy."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.mail_events_queue.statement) == 1 &&
      data.aws_iam_policy_document.mail_events_queue.statement[0].actions == toset(["sqs:SendMessage"]) &&
      data.aws_iam_policy_document.mail_events_queue.statement[0].resources == toset([aws_sqs_queue.mail_events.arn]) &&
      toset(flatten([for p in data.aws_iam_policy_document.mail_events_queue.statement[0].principals : p.identifiers])) == toset(["sns.amazonaws.com"]) &&
      one(data.aws_iam_policy_document.mail_events_queue.statement[0].condition).variable == "aws:SourceArn" &&
      one(data.aws_iam_policy_document.mail_events_queue.statement[0].condition).values == tolist([aws_sns_topic.ses_events.arn])
    )
    error_message = "Only the ses-events topic may send to the mail-events queue."
  }
  assert {
    condition = (
      aws_sns_topic_subscription.mail_events.topic_arn == aws_sns_topic.ses_events.arn &&
      aws_sns_topic_subscription.mail_events.protocol == "sqs" &&
      aws_sns_topic_subscription.mail_events.endpoint == aws_sqs_queue.mail_events.arn &&
      aws_sns_topic_subscription.mail_events.raw_message_delivery
    )
    error_message = "The topic delivers raw SES events (no SNS envelope, mail/suppression.ts) to the mail-events queue."
  }

  # --- The queue: encrypted, a DLQ after 5 receives, visibility past the worker's timeout ---
  assert {
    condition     = aws_sqs_queue.mail_events.sqs_managed_sse_enabled && aws_sqs_queue.mail_events_dlq.sqs_managed_sse_enabled
    error_message = "Both mail-events queues must be encrypted (SSE-SQS): they hold addresses."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.mail_events.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.mail_events.redrive_policy).deadLetterTargetArn == aws_sqs_queue.mail_events_dlq.arn &&
      aws_sqs_queue.mail_events.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    )
    error_message = "mail-events dead-letters after 5 receives, with visibility at least 6x the worker's timeout."
  }

  # --- The worker consumes it, and knows which queue is which ---------------------------
  assert {
    condition = (
      aws_lambda_event_source_mapping.worker_mail_events.event_source_arn == aws_sqs_queue.mail_events.arn &&
      aws_lambda_event_source_mapping.worker_mail_events.function_name == aws_lambda_function.worker.arn &&
      aws_lambda_function.worker.environment[0].variables["MAIL_EVENTS_QUEUE_ARN"] == aws_sqs_queue.mail_events.arn
    )
    error_message = "mail-events triggers the worker, which reads a record as an SES event only from that queue (MAIL_EVENTS_QUEUE_ARN)."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.worker_mail_events.statement : s.resources])) == toset([aws_sqs_queue.mail_events.arn]) &&
      alltrue([for s in data.aws_iam_policy_document.worker_mail_events.statement : alltrue([for a in s.actions : startswith(a, "sqs:") && !strcontains(a, "*") && a != "sqs:SendMessage"])]) &&
      aws_iam_role_policy.worker_mail_events.role == aws_iam_role.worker_lambda.id
    )
    error_message = "The worker may only receive from the mail-events queue (never send to it)."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "MAIL_EVENTS_QUEUE_ARN")
    error_message = "The API reads no SES events."
  }

  # --- Turning mail back on: the API may take an address off the suppression list ------
  assert {
    condition = (
      length(data.aws_iam_policy_document.lambda_ses_release.statement) == 1 &&
      data.aws_iam_policy_document.lambda_ses_release.statement[0].actions == toset(["ses:DeleteSuppressedDestination"]) &&
      aws_iam_role_policy.lambda_ses_release.role == aws_iam_role.lambda.id
    )
    error_message = "Only the API role may release a suppressed address, and only that action."
  }
  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.lambda_ses.statement : tolist(s.actions)]), "ses:DeleteSuppressedDestination")
    error_message = "The shared send policy (the worker has it too) must not release suppressed addresses."
  }

  # --- Alarm ------------------------------------------------------------------------
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth.dimensions["QueueName"] == aws_sqs_queue.mail_events_dlq.name &&
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth.threshold == 0 &&
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth.alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The mail-events DLQ must alarm on depth > 0."
  }
}

# ---------------------------------------------------------------------------
# Data feeds (feeds.tf, WP-2.10)
# ---------------------------------------------------------------------------

run "data_feeds" {
  command = plan

  # --- Queues: SSE, a DLQ after 5 receives, visibility past the consumer's timeout ---
  assert {
    condition     = alltrue([for q in [aws_sqs_queue.fetch_requests, aws_sqs_queue.fetch_requests_dlq, aws_sqs_queue.ingest_results, aws_sqs_queue.ingest_results_dlq] : q.sqs_managed_sse_enabled])
    error_message = "Every data-feed queue must be encrypted (SSE-SQS)."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.fetch_requests.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.fetch_requests.redrive_policy).deadLetterTargetArn == aws_sqs_queue.fetch_requests_dlq.arn &&
      jsondecode(aws_sqs_queue.ingest_results.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.ingest_results.redrive_policy).deadLetterTargetArn == aws_sqs_queue.ingest_results_dlq.arn
    )
    error_message = "Both data-feed queues must dead-letter to their own DLQ after 5 receives."
  }
  assert {
    condition = (
      aws_sqs_queue.fetch_requests.visibility_timeout_seconds >= 6 * aws_lambda_function.fetcher.timeout &&
      aws_sqs_queue.ingest_results.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    )
    error_message = "Visibility must be at least 6x the consuming Lambda's timeout."
  }

  # --- The fetcher: outside the VPC, small, capped, live sources only --------------
  assert {
    condition = (
      aws_lambda_function.fetcher.runtime == "nodejs24.x" &&
      aws_lambda_function.fetcher.handler == "lambda-fetcher.handler" &&
      aws_lambda_function.fetcher.memory_size == 512 &&
      aws_lambda_function.fetcher.timeout == 120 &&
      aws_lambda_function.fetcher.reserved_concurrent_executions == 2
    )
    error_message = "Fetcher Lambda: nodejs24.x, lambda-fetcher.handler, 512 MB, 120 s, reserved concurrency 2."
  }
  assert {
    condition     = length(aws_lambda_function.fetcher.vpc_config) == 0
    error_message = "The fetcher runs outside the VPC: it is what keeps the feeds from needing a NAT."
  }
  assert {
    condition = (
      aws_lambda_function.fetcher.environment[0].variables["FEED_SOURCE"] == "live" &&
      aws_lambda_function.fetcher.environment[0].variables["INGEST_RESULTS_QUEUE_URL"] == aws_sqs_queue.ingest_results.url &&
      length(aws_lambda_function.fetcher.environment[0].variables) == 2
    )
    error_message = "The fetcher gets the live sources and the ingest-results queue, and nothing else (no DATABASE_URL, no secrets)."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_lambda.statement : s.resources])) == toset([aws_sqs_queue.fetch_requests.arn, aws_sqs_queue.ingest_results.arn]) &&
      alltrue([for s in data.aws_iam_policy_document.fetcher_lambda.statement : s.sid != "SendIngestResults" || toset(s.actions) == toset(["sqs:SendMessage"])]) &&
      alltrue([for s in data.aws_iam_policy_document.fetcher_lambda.statement : alltrue([for a in s.actions : startswith(a, "sqs:") && !strcontains(a, "*")])])
    )
    error_message = "The fetcher's role reaches the two feed queues only: receive fetch-requests, send ingest-results."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.fetcher_lambda_logs.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    error_message = "The fetcher gets basic logging only (no VPC or other managed policy)."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.fetcher_requests.event_source_arn == aws_sqs_queue.fetch_requests.arn &&
      aws_lambda_event_source_mapping.fetcher_requests.function_name == aws_lambda_function.fetcher.arn &&
      aws_lambda_event_source_mapping.fetcher_requests.batch_size == 1 &&
      contains(aws_lambda_event_source_mapping.fetcher_requests.function_response_types, "ReportBatchItemFailures")
    )
    error_message = "fetch-requests triggers the fetcher, one request at a time, retrying only failed sends."
  }

  # --- The worker's side ------------------------------------------------------------
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["FEED_FETCHER"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["FETCH_REQUESTS_QUEUE_URL"] == aws_sqs_queue.fetch_requests.url &&
      !contains(keys(aws_lambda_function.worker.environment[0].variables), "FEED_SOURCE")
    )
    error_message = "The worker hands fetches to the fetcher (it has no internet) and never fetches itself."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.worker_ingest_results.event_source_arn == aws_sqs_queue.ingest_results.arn &&
      aws_lambda_event_source_mapping.worker_ingest_results.function_name == aws_lambda_function.worker.arn
    )
    error_message = "ingest-results triggers the worker."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.worker_feeds.statement : s.resources])) == toset([aws_sqs_queue.fetch_requests.arn, aws_sqs_queue.ingest_results.arn])
    error_message = "The worker's feed policy reaches the two feed queues only."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.sqs_endpoint.statement : s.resources if contains(flatten([for p in s.principals : p.identifiers]), aws_iam_role.lambda.arn)])) == toset([aws_sqs_queue.jobs.arn])
    error_message = "Through the endpoint, the API reaches the jobs queue only, never the feed queues."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), aws_lambda_function.fetcher.arn)
    error_message = "The deploy role must be able to update the fetcher's code."
  }

  # --- Alarms -----------------------------------------------------------------------
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth.dimensions["QueueName"] == aws_sqs_queue.fetch_requests_dlq.name &&
      aws_cloudwatch_metric_alarm.ingest_results_dlq_depth.dimensions["QueueName"] == aws_sqs_queue.ingest_results_dlq.name &&
      aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth.threshold == 0 &&
      aws_cloudwatch_metric_alarm.ingest_results_dlq_depth.threshold == 0
    )
    error_message = "Each feed DLQ must alarm on depth > 0."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.fetcher_errors.dimensions["FunctionName"] == aws_lambda_function.fetcher.function_name
    error_message = "Fetcher errors must alarm."
  }
}

run "rejects_short_jobs_backlog_alarm" {
  command = plan

  variables {
    jobs_backlog_alarm_seconds = 300
  }

  expect_failures = [var.jobs_backlog_alarm_seconds]
}

# ---------------------------------------------------------------------------
# Deploy role trust pin (bootstrap-owned; checked by the postcondition in
# oidc.tf so a drifted trust policy fails the plan)
# ---------------------------------------------------------------------------

run "deploy_trust_accepts_immutable_subject_claims" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760@1234/project-water-management@5678:environment:production\"}}}]}"
    }
  }

  assert {
    condition     = aws_iam_role_policy_attachment.github_deploy.role == "water-management-deploy"
    error_message = "The deploy policy attaches to the bootstrap role."
  }
}

run "deploy_trust_rejects_branch_subject" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:ref:refs/heads/main\"}}}]}"
    }
  }

  expect_failures = [data.aws_iam_role.github_deploy]
}

run "deploy_trust_rejects_wildcard_subject" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\"},\"StringLike\":{\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:*\"}}}]}"
    }
  }

  expect_failures = [data.aws_iam_role.github_deploy]
}

run "deploy_trust_rejects_other_repo" {
  command = plan

  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      arn                = "arn:aws:iam::000000000000:role/water-management-deploy"
      name               = "water-management-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:someone-else/project-water-management:environment:production\"}}}]}"
    }
  }

  expect_failures = [data.aws_iam_role.github_deploy]
}

run "deploy_policy_has_no_wildcards" {
  command = plan

  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for a in s.actions : !strcontains(a, "*")
    ]]))
    error_message = "Deploy policy actions must be named, never wildcards."
  }
  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for r in s.resources : r != "*" if s.sid != "EcrLogin"
    ]]))
    error_message = "Deploy policy resources must be specific ARNs."
  }
  # The one exception: ECR's docker login has no resource-level permissions
  # (AWS), so that statement is "*", with that one action and nothing else.
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid != "EcrLogin" || (toset(s.actions) == toset(["ecr:GetAuthorizationToken"]) && toset(s.resources) == toset(["*"]))
    ])
    error_message = "EcrLogin may hold ecr:GetAuthorizationToken only."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid != "RendererImagePush" || toset(s.resources) == toset([aws_ecr_repository.renderer.arn])
    ])
    error_message = "The deploy role pushes to the renderer's repository only."
  }
}

# ---------------------------------------------------------------------------
# Server-side reports (reports.tf, WP-2.15 Phase B)
# ---------------------------------------------------------------------------

run "reports" {
  command = plan

  # --- The bucket: private, encrypted, TLS only, 7 days -------------------------------
  assert {
    condition = (
      aws_s3_bucket_public_access_block.reports.block_public_acls &&
      aws_s3_bucket_public_access_block.reports.block_public_policy &&
      aws_s3_bucket_public_access_block.reports.ignore_public_acls &&
      aws_s3_bucket_public_access_block.reports.restrict_public_buckets
    )
    error_message = "The reports bucket must block every kind of public access."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.reports.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"
    error_message = "Report PDFs must be encrypted at rest (SSE-S3)."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_ownership_controls.reports.rule : r.object_ownership]) == "BucketOwnerEnforced"
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition = alltrue([for r in aws_s3_bucket_lifecycle_configuration.reports.rule :
      r.status == "Enabled" && one(r.expiration).days == 7 && one(r.filter).prefix == "reports/"
    ])
    error_message = "Every report PDF must expire after 7 days."
  }
  assert {
    condition     = contains([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s.sid if s.effect == "Deny"], "DenyInsecureTransport")
    error_message = "The reports bucket must refuse plain-HTTP access."
  }

  # --- The render queues ---------------------------------------------------------------
  assert {
    condition     = alltrue([for q in [aws_sqs_queue.render_requests, aws_sqs_queue.render_requests_dlq, aws_sqs_queue.render_results, aws_sqs_queue.render_results_dlq] : q.sqs_managed_sse_enabled])
    error_message = "Every render queue must be encrypted: requests carry a render token."
  }
  assert {
    condition = (
      jsondecode(aws_sqs_queue.render_requests.redrive_policy).deadLetterTargetArn == aws_sqs_queue.render_requests_dlq.arn &&
      jsondecode(aws_sqs_queue.render_results.redrive_policy).deadLetterTargetArn == aws_sqs_queue.render_results_dlq.arn &&
      jsondecode(aws_sqs_queue.render_requests.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.render_results.redrive_policy).maxReceiveCount == 5 &&
      aws_sqs_queue.render_requests.visibility_timeout_seconds >= 6 * 120 &&
      aws_sqs_queue.render_results.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    )
    error_message = "Each render queue dead-letters after 5 receives, with visibility past its consumer's timeout."
  }

  # --- Nothing renders until the first image exists ------------------------------------------
  assert {
    condition     = length(aws_lambda_function.renderer) == 0 && length(aws_lambda_event_source_mapping.renderer_requests) == 0
    error_message = "Without renderer_image_tag the renderer function isn't created (Lambda can't be created before its image exists)."
  }
  assert {
    condition = (
      aws_ecr_repository.renderer.image_tag_mutability == "IMMUTABLE" &&
      one(aws_ecr_repository.renderer.image_scanning_configuration).scan_on_push
    )
    error_message = "The renderer repository: immutable release tags, scanned on push."
  }

  # --- Least privilege -----------------------------------------------------------------------
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.renderer_lambda.statement : s.resources])) == toset([
        aws_sqs_queue.render_requests.arn, aws_sqs_queue.render_results.arn, "${aws_s3_bucket.reports.arn}/reports/*",
      ]) &&
      alltrue([for s in data.aws_iam_policy_document.renderer_lambda.statement : s.sid != "PutReportPdfs" || toset(s.actions) == toset(["s3:PutObject"])]) &&
      alltrue([for s in data.aws_iam_policy_document.renderer_lambda.statement : alltrue([for a in s.actions : !strcontains(a, "*")])])
    )
    error_message = "The renderer may receive render-requests, send render-results and put PDFs: never read, list or delete them, nor anything else."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.renderer_lambda_logs.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    error_message = "The renderer gets basic logging only (no VPC, no other managed policy)."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.lambda_reports.statement : s.actions])) == toset(["s3:GetObject"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.lambda_reports.statement : s.resources])) == toset(["${aws_s3_bucket.reports.arn}/reports/*"])
    )
    error_message = "The API may only read PDFs (it pre-signs downloads)."
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.worker_reports.statement : s.resources])) == toset([aws_sqs_queue.render_requests.arn, aws_sqs_queue.render_results.arn])
    error_message = "The worker's report policy reaches the two render queues only (no bucket access)."
  }
  assert {
    condition     = aws_iam_role_policy.worker_ses.role == aws_iam_role.worker_lambda.id && aws_iam_role_policy.worker_ses.name == "ses-send-no-reply"
    error_message = "The worker sends report emails under the same no-reply-only SES policy as the API (lambda_ses, pinned in run email_ses)."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), "arn:aws:lambda:af-south-1:000000000000:function:water-management-renderer")
    error_message = "The deploy role must be able to move the renderer to a release's image."
  }

  # --- Wiring --------------------------------------------------------------------------------
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["REPORT_RENDERER"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["RENDER_REQUESTS_QUEUE_URL"] == aws_sqs_queue.render_requests.url &&
      aws_lambda_function.worker.environment[0].variables["MAIL_TRANSPORT"] == "ses" &&
      aws_lambda_function.backend.environment[0].variables["STORAGE"] == "s3" &&
      aws_lambda_function.backend.environment[0].variables["REPORTS_BUCKET"] == aws_s3_bucket.reports.bucket
    )
    error_message = "The worker hands renders to the renderer and mails through SES; the API signs downloads from the reports bucket."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.worker_render_results.event_source_arn == aws_sqs_queue.render_results.arn && aws_lambda_event_source_mapping.worker_render_results.function_name == aws_lambda_function.worker.arn
    error_message = "render-results triggers the worker."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.render_requests_dlq_depth.dimensions["QueueName"] == aws_sqs_queue.render_requests_dlq.name &&
      aws_cloudwatch_metric_alarm.render_results_dlq_depth.dimensions["QueueName"] == aws_sqs_queue.render_results_dlq.name &&
      aws_cloudwatch_metric_alarm.render_requests_dlq_depth.threshold == 0 &&
      aws_cloudwatch_metric_alarm.render_results_dlq_depth.threshold == 0
    )
    error_message = "Each render DLQ must alarm on depth > 0."
  }
}

run "reports_renderer_created_from_its_image" {
  command = plan

  variables {
    renderer_image_tag = "0.4.0"
  }

  assert {
    condition = (
      aws_lambda_function.renderer[0].package_type == "Image" &&
      aws_lambda_function.renderer[0].image_uri == "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-renderer:0.4.0" &&
      aws_lambda_function.renderer[0].memory_size == 2048 &&
      aws_lambda_function.renderer[0].timeout == 120 &&
      aws_lambda_function.renderer[0].reserved_concurrent_executions == 2
    )
    error_message = "Renderer Lambda: the release image, 2048 MB, 120 s, reserved concurrency 2."
  }
  assert {
    condition     = length(aws_lambda_function.renderer[0].vpc_config) == 0
    error_message = "The renderer runs outside the VPC: it reaches the site through CloudFront, and never the database."
  }
  assert {
    condition = (
      aws_lambda_function.renderer[0].environment[0].variables["RENDER_SITE_URL"] == local.site_origin &&
      aws_lambda_function.renderer[0].environment[0].variables["RENDER_API_URL"] == "${local.site_origin}/api" &&
      aws_lambda_function.renderer[0].environment[0].variables["STORAGE"] == "s3" &&
      tonumber(aws_lambda_function.renderer[0].environment[0].variables["REPORT_RENDER_TIMEOUT_MS"]) < 120000 &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "DATABASE_URL") &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "AUTH_JWT_SECRET")
    )
    error_message = "The renderer opens the public site, stores to S3, stops before Lambda's timeout, and holds no database URL or secret."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.renderer_requests[0].event_source_arn == aws_sqs_queue.render_requests.arn &&
      aws_lambda_event_source_mapping.renderer_requests[0].batch_size == 1 &&
      contains(aws_lambda_event_source_mapping.renderer_requests[0].function_response_types, "ReportBatchItemFailures")
    )
    error_message = "render-requests triggers the renderer, one at a time, retrying only failed answers."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.renderer_errors) == 1 && length(aws_cloudwatch_metric_alarm.renderer_duration) == 1
    error_message = "Renderer errors and slow renders must alarm."
  }
}

run "rejects_bad_renderer_image_tag" {
  command = plan

  variables {
    renderer_image_tag = "latest"
  }

  expect_failures = [var.renderer_image_tag]
}

# Email that fails to send is never silent (trySendMail logs mail_send_failed
# and the route still answers 200), the worker's self-check failures alarm
# like the API's, and slow-query logging never records bind values.
run "mail_failures_and_log_privacy" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.self_check_failed_worker.pattern == aws_cloudwatch_log_metric_filter.self_check_failed.pattern &&
      aws_cloudwatch_log_metric_filter.self_check_failed_worker.metric_transformation[0].name == aws_cloudwatch_metric_alarm.self_check_failed.metric_name &&
      aws_cloudwatch_log_metric_filter.self_check_failed_worker.metric_transformation[0].namespace == aws_cloudwatch_metric_alarm.self_check_failed.namespace
    )
    error_message = "The worker's self-check filter must match the same event and feed the metric the self-check alarm watches."
  }

  assert {
    condition = (
      toset([for f in aws_cloudwatch_log_metric_filter.mail_send_failed : f.log_group_name]) == toset([aws_cloudwatch_log_group.lambda.name, aws_cloudwatch_log_group.worker.name]) &&
      alltrue([for f in aws_cloudwatch_log_metric_filter.mail_send_failed : f.pattern == "{ $.event = \"mail_send_failed\" }"])
    )
    error_message = "mail_send_failed must be counted from both the API's and the worker's log group, by the exact event name trySendMail logs."
  }
  assert {
    condition = alltrue([for f in aws_cloudwatch_log_metric_filter.mail_send_failed :
      f.metric_transformation[0].name == aws_cloudwatch_metric_alarm.mail_send_failed.metric_name &&
      f.metric_transformation[0].namespace == aws_cloudwatch_metric_alarm.mail_send_failed.namespace
    ])
    error_message = "The mail-send alarm must watch the metric both filters emit."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mail_send_failed.threshold == 0 &&
      aws_cloudwatch_metric_alarm.mail_send_failed.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.mail_send_failed.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.mail_send_failed.treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.mail_send_failed.alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "One failed email must page the alerts topic."
  }

  assert {
    condition = (
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_parameter_max_length=0") &&
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_parameter_max_length_on_error=0")
    )
    error_message = "Slow-statement and error logging must never record bind values (addresses, farm names, series): log_parameter_max_length(_on_error) = 0."
  }
  assert {
    condition = (
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "rds.force_ssl=1") &&
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_statement=none")
    )
    error_message = "The parameter group must keep TLS forced and log_statement = none."
  }
}

# ---------------------------------------------------------------------------
# Lambda concurrency caps: never unreserved (-1), and the worker's cap covers
# every SQS trigger it has
# ---------------------------------------------------------------------------

run "rejects_unreserved_api_concurrency" {
  command = plan

  variables {
    lambda_reserved_concurrency = -1
  }

  expect_failures = [var.lambda_reserved_concurrency]
}

run "rejects_unreserved_migrate_concurrency" {
  command = plan

  variables {
    migrate_reserved_concurrency = -1
  }

  expect_failures = [var.migrate_reserved_concurrency]
}

run "rejects_unreserved_worker_concurrency" {
  command = plan

  variables {
    worker_reserved_concurrency = -1
  }

  expect_failures = [var.worker_reserved_concurrency]
}

run "rejects_unreserved_fetcher_concurrency" {
  command = plan

  variables {
    fetcher_reserved_concurrency = -1
  }

  expect_failures = [var.fetcher_reserved_concurrency]
}

run "rejects_unreserved_renderer_concurrency" {
  command = plan

  variables {
    renderer_reserved_concurrency = -1
  }

  expect_failures = [var.renderer_reserved_concurrency]
}

run "rejects_worker_concurrency_below_its_triggers" {
  command = plan

  variables {
    worker_reserved_concurrency = 2
  }

  expect_failures = [var.worker_reserved_concurrency]
}

run "worker_sqs_triggers" {
  command = plan

  # Enables the renderer too, so every SQS trigger in the stack is planned.
  variables {
    renderer_image_tag = "0.4.0"
  }

  assert {
    condition = aws_lambda_function.worker.reserved_concurrent_executions >= sum([
      for m in [
        aws_lambda_event_source_mapping.worker_jobs,
        aws_lambda_event_source_mapping.worker_ingest_results,
        aws_lambda_event_source_mapping.worker_render_results,
        aws_lambda_event_source_mapping.worker_mail_events,
      ] : m.scaling_config[0].maximum_concurrency
    ])
    error_message = "The worker's reserved concurrency must cover the sum of its SQS triggers' maximum_concurrency, or throttled messages burn receive counts into the DLQs."
  }
  assert {
    condition = (
      aws_lambda_function.fetcher.reserved_concurrent_executions >= aws_lambda_event_source_mapping.fetcher_requests.scaling_config[0].maximum_concurrency &&
      aws_lambda_function.renderer[0].reserved_concurrent_executions >= aws_lambda_event_source_mapping.renderer_requests[0].scaling_config[0].maximum_concurrency
    )
    error_message = "The fetcher's and renderer's reserved concurrency must cover their SQS trigger's maximum_concurrency."
  }
  assert {
    condition = alltrue([
      for m in [
        aws_lambda_event_source_mapping.worker_jobs,
        aws_lambda_event_source_mapping.worker_ingest_results,
        aws_lambda_event_source_mapping.worker_render_results,
        aws_lambda_event_source_mapping.worker_mail_events,
      ] : m.function_name == aws_lambda_function.worker.arn && try(contains(m.function_response_types, "ReportBatchItemFailures"), false)
    ])
    error_message = "Every worker SQS trigger must honour partial batch failures (ReportBatchItemFailures), so one bad record doesn't dead-letter its batch."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_throttles.metric_name == "Throttles" &&
      aws_cloudwatch_metric_alarm.worker_throttles.dimensions["FunctionName"] == aws_lambda_function.worker.function_name &&
      aws_cloudwatch_metric_alarm.worker_throttles.threshold == 0
    )
    error_message = "Any worker throttle must alarm."
  }
}

# ---------------------------------------------------------------------------
# WAF: the auth rate limit matches the decoded, normalised path
# ---------------------------------------------------------------------------

run "waf_auth_rule_matches_decoded_path" {
  command = plan

  assert {
    condition = [
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      t.type if t.priority == 0
    ] == ["URL_DECODE"]
    error_message = "The auth rate limit must URL-decode the path first, or /api/%61uth/login slips past it."
  }
  assert {
    condition = toset([
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    error_message = "The auth rate limit's path transformations must be URL_DECODE, then NORMALIZE_PATH, then LOWERCASE."
  }
}
