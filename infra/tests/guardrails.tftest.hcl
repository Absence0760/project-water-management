# Plan-only tests against mocked providers — no AWS credentials, no state, no
# sops key. They pin the production guardrails that `terraform validate` can't
# see: runtime/sizing of the Lambdas, the DB's durability + privacy settings,
# the DATABASE_URL shape, the single-origin CloudFront wiring, WAF + security
# headers + CSP, private S3, SES identity / DNS / least-privilege send, the
# background-job queues / worker / SQS endpoint policy, the alarms, the deploy role's trust pin, and the plan-time rejection of
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

override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts"
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

  # IAM: one action, two named resources, pinned From address.
  assert {
    condition     = data.aws_iam_policy_document.lambda_ses.statement[0].actions == toset(["ses:SendEmail"])
    error_message = "The API Lambda may only call ses:SendEmail."
  }
  assert {
    condition     = data.aws_iam_policy_document.lambda_ses.statement[0].resources == toset([aws_sesv2_email_identity.domain.arn, aws_sesv2_configuration_set.main.arn])
    error_message = "ses:SendEmail must be scoped to the domain identity and the configuration set."
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
    aws_region = "eu-west-1"
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
      aws_cloudwatch_metric_alarm.jobs_backlog,
      aws_cloudwatch_metric_alarm.job_dead,
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
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "50"
    error_message = "A $50 monthly budget exists by default."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email[0].endpoint == "ops@example.com" && aws_sns_topic_subscription.alerts_us_east_1_email[0].endpoint == "ops@example.com"
    error_message = "Both SNS topics (regional + us-east-1) must email budget_alert_email."
  }

  # --- Self-check-failed metric filter + alarm ----------------------------
  assert {
    condition     = aws_cloudwatch_log_metric_filter.self_check_failed.log_group_name == aws_cloudwatch_log_group.lambda.name
    error_message = "The self-check filter must read the backend API Lambda's own log group."
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
    condition     = aws_lambda_function.worker.reserved_concurrent_executions == 2
    error_message = "Worker concurrency must be capped at 2 by default (spend + DB connections)."
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
      toset(s.resources) == toset([aws_sqs_queue.jobs.arn]) && alltrue([for a in s.actions : !strcontains(a, "*")])
    ])
    error_message = "The SQS endpoint policy must name only the jobs queue, with no wildcard actions."
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
    condition     = aws_cloudwatch_log_metric_filter.job_dead.log_group_name == aws_cloudwatch_log_group.worker.name && aws_cloudwatch_log_metric_filter.job_dead.pattern == "{ $.event = \"job_dead\" }"
    error_message = "The dead-job filter must match runner.ts's structured event in the worker's log group."
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
      for r in s.resources : r != "*"
    ]]))
    error_message = "Deploy policy resources must be specific ARNs."
  }
}
