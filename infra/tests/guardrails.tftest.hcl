# Plan-only tests against mocked providers — no AWS credentials, no state, no
# sops key (the runtime secrets are ephemeral variables, set to synthetic
# values below). They pin the production guardrails that `terraform validate` can't
# see: runtime/sizing of the Lambdas, the DB's durability + privacy settings,
# the DATABASE_URL shape, the single-origin CloudFront wiring, WAF + security
# headers + CSP, private S3, SES identity / DNS / least-privilege send, the
# background-job queues / worker / SQS endpoint policy, the data-feed queues and the fetcher outside the VPC,
# the report bucket / renderer image and Lambda / render queues, report downloads through CloudFront signed URLs, the SES bounce/complaint chain to the worker, the alarms, the deploy role's trust pin,
# the private-only network (no gateway or default route, the exact security-group graph, the Function
# URL's auth type, every security group's description), the runtime secrets (in Secrets Manager, never a Lambda
# environment), and the plan-time rejection of
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
      names    = ["af-south-1a", "af-south-1b", "af-south-1c"]
      zone_ids = ["afs1-az1", "afs1-az2", "afs1-az3"]
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
    id  = "E0000000000000"
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

# Known IDs for the rest of the security groups and the route table, so the
# network run can assert which group a rule, Lambda or DB points at.
override_resource {
  target          = aws_security_group.api_lambda
  override_during = plan
  values = {
    id = "sg-000000000000api"
  }
}

override_resource {
  target          = aws_security_group.migrate_lambda
  override_during = plan
  values = {
    id = "sg-00000000migrate"
  }
}

override_resource {
  target          = aws_security_group.rds
  override_during = plan
  values = {
    id = "sg-000000000000rds"
  }
}

override_resource {
  target          = aws_security_group.vpce
  override_during = plan
  values = {
    id = "sg-00000000000vpce"
  }
}

override_resource {
  target          = aws_security_group.vpce_sqs
  override_during = plan
  values = {
    id = "sg-000000000vpcesqs"
  }
}

override_resource {
  target          = aws_route_table.private
  override_during = plan
  values = {
    id = "rtb-00000000private"
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
    # The /reports/* origin (s3_cloudfront.tf).
    bucket_regional_domain_name = "water-management-reports-000000000000.s3.af-south-1.amazonaws.com"
  }
}

# Report downloads through CloudFront (reports.tf): known values so the key
# pair, key group, OAC and origin request policy can be matched by equality.
# Placeholder text, not a key: nothing is generated in a test.
# One id per trusted public key (the overlap run uses both), so a key-id
# check can tell them apart.
override_resource {
  target          = aws_cloudfront_public_key.report_downloads["2026-09"]
  override_during = plan
  values = {
    id = "K2026090000000A"
  }
}

override_resource {
  target          = aws_cloudfront_public_key.report_downloads["2027-03"]
  override_during = plan
  values = {
    id = "K2027030000000B"
  }
}

override_resource {
  target          = aws_cloudfront_key_group.report_downloads
  override_during = plan
  values = {
    id = "report-downloads-key-group-id"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.reports
  override_during = plan
  values = {
    id = "reports-oac-id"
  }
}

# Evidence pack PDFs (packs.tf, 119_pack_render)
override_resource {
  target          = aws_s3_bucket.packs
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-packs-000000000000"
    bucket = "water-management-packs-000000000000"
    # The /packs/* origin (s3_cloudfront.tf).
    bucket_regional_domain_name = "water-management-packs-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.packs
  override_during = plan
  values = {
    id = "packs-oac-id"
  }
}

# The map's data (map_data.tf, s3_cloudfront.tf's /tiles/*)
override_resource {
  target          = aws_s3_bucket.tiles
  override_during = plan
  values = {
    arn                         = "arn:aws:s3:::water-management-tiles-000000000000"
    bucket                      = "water-management-tiles-000000000000"
    bucket_regional_domain_name = "water-management-tiles-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.tiles
  override_during = plan
  values = {
    id = "tiles-oac-id"
  }
}

override_resource {
  target          = aws_cloudfront_function.tiles_range
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/water-management-tiles-range"
  }
}

override_resource {
  target          = aws_s3_bucket.reference
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-reference-000000000000"
    bucket = "water-management-reference-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_origin_request_policy.report_downloads
  override_during = plan
  values = {
    id = "report-downloads-origin-request-policy-id"
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

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:water-management-prod-alerts"
  }
}

override_resource {
  target          = aws_ce_anomaly_monitor.services
  override_during = plan
  values = {
    arn = "arn:aws:ce::000000000000:anomalymonitor/00000000-0000-0000-0000-000000000000"
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

# Runtime secrets (secrets.tf, issue #126): distinct known ARNs, so each
# role's grant and each endpoint statement can be matched to its own secret.
override_resource {
  target          = aws_iam_role.migrate_lambda
  override_during = plan
  values = {
    id  = "water-management-migrate-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-migrate-lambda"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["api"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AaAaAa"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AaAaAa"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["worker"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/worker-WwWwWw"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/worker-WwWwWw"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["migrate"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/migrate-MmMmMm"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/migrate-MmMmMm"
  }
}

# Distinct version IDs, so matching each Lambda's RUNTIME_SECRET_VERSION to its
# own secret's version can fail.
override_resource {
  target          = aws_secretsmanager_secret_version.runtime["api"]
  override_during = plan
  values = {
    version_id = "aaaaaaaa-0000-0000-0000-000000000001"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["worker"]
  override_during = plan
  values = {
    version_id = "bbbbbbbb-0000-0000-0000-000000000002"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["migrate"]
  override_during = plan
  values = {
    version_id = "cccccccc-0000-0000-0000-000000000003"
  }
}

# A known CloudFront header, for the ephemerality check's positive control.
override_resource {
  target          = random_password.cloudfront_shared_secret
  override_during = plan
  values = {
    result = "synthetic0cloudfront0header0000000000000000000000"
  }
}

variables {
  aws_region      = "af-south-1"
  route53_zone_id = "Z0000000000000000000"
  github_repo     = "Absence0760/project-water-management"
  # Synthetic runtime secrets (ephemeral variables, secrets.tf).
  auth_jwt_secret     = "0123456789abcdef0123456789abcdef0123456789abcdef"
  db_app_password     = "abcdef0123456789abcdef0123456789abcdef01234567"
  alerts_token_secret = "fedcba9876543210fedcba9876543210fedcba9876543210"
  app_encryption_key  = "0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd"
  # PEM armour around a placeholder: the shape the variable checks, not a key.
  cloudfront_private_key = "-----BEGIN PRIVATE KEY-----\ntestonlynotakey\n-----END PRIVATE KEY-----"
  # Report downloads (reports.tf): a public key generated for these tests (its
  # private half was never kept). Public keys aren't secret.
  report_download_public_keys = {
    "2026-09" = <<-EOT
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
      BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
      hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
      EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
      t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
      qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
      nQIDAQAB
      -----END PUBLIC KEY-----
    EOT
  }
  report_download_signing_key = "2026-09"
  # Required and validated. Not an example.* (or other RFC 2606) address,
  # which the variable refuses: the site's own domain, and a plan-only test
  # never subscribes it.
  budget_alert_email = "ops@water-management.jaredhoward.com"
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
    condition     = startswith(local.runtime_secrets.api.DATABASE_URL, "postgresql://water_app:") && endswith(local.runtime_secrets.api.DATABASE_URL, "@water-management.abc123.af-south-1.rds.amazonaws.com:5432/water?sslmode=verify-full")
    error_message = "DATABASE_URL (in the API's runtime secret) must connect as water_app to the RDS endpoint with sslmode=verify-full."
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
  # infra/scripts/restore-db.sh restores into these, read from the outputs
  # (the parameter group's name has a generated suffix). The two computed ones
  # are unknown under mocks, so their wiring is read from the source.
  assert {
    condition = (
      output.db_instance_identifier == "water-management"
      && output.db_subnet_group_name == "water-management-db"
      && can(regex("output \"db_security_group_id\" \\{[^}]*value\\s*=\\s*aws_security_group\\.rds\\.id\\s", file("outputs.tf")))
      && can(regex("output \"db_parameter_group_name\" \\{[^}]*value\\s*=\\s*aws_db_parameter_group\\.main\\.name\\s", file("outputs.tf")))
    )
    error_message = "restore-db.sh needs the db_instance_identifier, db_subnet_group_name, db_security_group_id and db_parameter_group_name outputs, wired to the live instance's."
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
    condition     = strcontains(aws_cloudfront_function.spa_rewrite.code, "var PRERENDERED = ['/welcome', '/welcome/af', '/privacy', '/terms', '/methods'];") && strcontains(aws_cloudfront_function.spa_rewrite.code, "if (PRERENDERED.indexOf(uri) !== -1) {") && strcontains(aws_cloudfront_function.spa_rewrite.code, "request.uri = uri + '.html'")
    error_message = "The prerendered pages (/welcome, /welcome/af, /privacy, /terms, /methods) must be served from their .html, not the SPA fallback."
  }
  assert {
    condition     = aws_acm_certificate.frontend.domain_name == "water-management.jaredhoward.com"
    error_message = "Certificate must cover the child-zone hostname."
  }
}

# ---------------------------------------------------------------------------
# Runtime secrets (secrets.tf, issue #126): Secrets Manager, never a Lambda
# environment, which any GetFunctionConfiguration caller can read.
# ---------------------------------------------------------------------------

run "runtime_secrets" {
  command = plan

  # The denylist, across every Lambda: no secret in any environment block.
  # (The renderer exists only with an image tag; reports_renderer_created_from_its_image
  # checks its block the same way.)
  assert {
    condition = alltrue(flatten([
      for f in [aws_lambda_function.backend, aws_lambda_function.worker, aws_lambda_function.migrate, aws_lambda_function.fetcher] : [
        for k in keys(f.environment[0].variables) : !contains(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET", "ALERTS_TOKEN_SECRET", "WATER_APP_PASSWORD"], k) && !can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$", k))
      ]
    ]))
    error_message = "No Lambda environment block may hold a secret (the session key, DATABASE_URL, the CloudFront header, the unsubscribe key, the water_app password): they belong in the runtime secret (secrets.tf)."
  }
  # Positive control: the denylist would see a secret if one were there.
  assert {
    condition     = contains(keys(local.runtime_secrets.api), "AUTH_JWT_SECRET") && contains(keys(local.runtime_secrets.migrate), "WATER_APP_PASSWORD") && can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$", "ALERTS_TOKEN_SECRET"))
    error_message = "The runtime secrets must hold the values the denylist keeps out of the environments."
  }

  # Exactly the keys each role uses (RUNTIME_SECRETS in backend/src/config/runtimeSecrets.ts).
  assert {
    condition = (
      toset(keys(local.runtime_secrets)) == toset(["api", "migrate", "worker"]) &&
      toset(keys(local.runtime_secrets.api)) == toset(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET", "CLOUDFRONT_PRIVATE_KEY", "APP_ENCRYPTION_KEY"]) &&
      toset(keys(local.runtime_secrets.worker)) == toset(["AUTH_JWT_SECRET", "DATABASE_URL", "ALERTS_TOKEN_SECRET"]) &&
      toset(keys(local.runtime_secrets.migrate)) == toset(["WATER_APP_PASSWORD"])
    )
    error_message = "Each runtime secret holds exactly its Lambda's keys: the edge secret, the download signing key and the TOTP sealing key for the API only, the unsubscribe key for the worker only, the water_app password for migrate only."
  }
  assert {
    condition = (
      local.runtime_secrets.migrate.WATER_APP_PASSWORD == var.db_app_password &&
      local.runtime_secrets.api.AUTH_JWT_SECRET == var.auth_jwt_secret &&
      local.runtime_secrets.api.APP_ENCRYPTION_KEY == var.app_encryption_key &&
      local.runtime_secrets.worker.ALERTS_TOKEN_SECRET == var.alerts_token_secret
    )
    error_message = "The runtime secrets carry the values from their sources (the sops-fed variables)."
  }

  # Out of state (issue #126). Every version is written write-only: the plan
  # holds no secret_string (a plain one would put the JSON in state), the
  # write-only argument reads back null (Terraform keeps no copy), and the
  # counter is the one thing that says when to write again.
  assert {
    condition = alltrue([for k, v in aws_secretsmanager_secret_version.runtime :
      v.secret_string == null && v.secret_string_wo == null && v.secret_string_wo_version == var.runtime_secret_version
    ])
    error_message = "Every runtime secret version must use secret_string_wo + secret_string_wo_version (var.runtime_secret_version), never secret_string: a plain secret_string puts the values in state."
  }
  assert {
    condition     = toset(keys(aws_secretsmanager_secret_version.runtime)) == toset(["api", "migrate", "worker"])
    error_message = "Each runtime secret has one write-only version (the check above ranges over them all)."
  }
  # The values are ephemeral, so Terraform refuses to store them anywhere:
  # ephemeralasnull() turns an ephemeral value into null and leaves any other
  # alone. Positive control: the CloudFront header is not ephemeral (its
  # custom_header argument is not write-only, so it stays in state by design;
  # secrets.tf), and ephemeralasnull keeps it.
  assert {
    condition = alltrue([
      ephemeralasnull(var.auth_jwt_secret) == null,
      ephemeralasnull(var.db_app_password) == null,
      ephemeralasnull(var.alerts_token_secret) == null,
      ephemeralasnull(var.cloudfront_private_key) == null,
      ephemeralasnull(var.app_encryption_key) == null,
      ephemeralasnull(local.runtime_secrets.api.CLOUDFRONT_PRIVATE_KEY) == null,
      ephemeralasnull(local.runtime_secrets.api.DATABASE_URL) == null,
      ephemeralasnull(local.runtime_secrets.worker.DATABASE_URL) == null,
      ephemeralasnull(local.runtime_secrets.migrate.WATER_APP_PASSWORD) == null,
    ])
    error_message = "The sops values, and DATABASE_URL built from one, must be ephemeral, so no state or plan can hold them."
  }
  assert {
    condition     = ephemeralasnull(local.runtime_secrets.api.CLOUDFRONT_SHARED_SECRET) != null
    error_message = "Positive control: ephemeralasnull keeps a non-ephemeral value (the CloudFront header, the one runtime value left in state)."
  }
  assert {
    condition     = local.runtime_secrets.api.CLOUDFRONT_PRIVATE_KEY == var.cloudfront_private_key
    error_message = "The API's runtime secret carries the report-download signing key from its sops-fed variable, the same path as the session key."
  }

  # Each Lambda names its own secret and the version Terraform wrote (a new
  # version changes the variable, so a rotation cold-starts every instance).
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["api"].version_id &&
      aws_lambda_function.worker.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["worker"].version_id &&
      aws_lambda_function.migrate.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["migrate"].version_id
    )
    error_message = "RUNTIME_SECRET_VERSION must be the version_id of the Lambda's own runtime secret version, which changes whenever runtime_secret_version is raised."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["api"].arn &&
      aws_lambda_function.worker.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["worker"].arn &&
      aws_lambda_function.migrate.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["migrate"].arn
    )
    error_message = "The API, worker and migrate Lambdas must each name their own runtime secret."
  }
  assert {
    condition = alltrue([for f in [aws_lambda_function.backend, aws_lambda_function.worker, aws_lambda_function.migrate] :
      contains(keys(f.environment[0].variables), "RUNTIME_SECRET_VERSION")
    ])
    error_message = "Each Lambda with a runtime secret must pin its version (RUNTIME_SECRET_VERSION), so a rotation reaches it."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "RUNTIME_SECRET_ARN")
    error_message = "The fetcher holds no secret."
  }
  assert {
    condition     = alltrue([for k, v in aws_secretsmanager_secret.runtime : v.name == "water-management/runtime/${k}"])
    error_message = "Runtime secrets are named water-management/runtime/<role>."
  }

  # IAM: each role reads its own secret, and only that one. (Positive control
  # first: the overrides give the three secrets distinct ARNs, so matching a
  # grant to "its own" secret can fail.)
  assert {
    condition     = length(toset([for s in aws_secretsmanager_secret.runtime : s.arn])) == 3
    error_message = "The test's secret ARN overrides must be distinct, or the per-role checks below prove nothing."
  }
  assert {
    condition = alltrue([for role, d in data.aws_iam_policy_document.runtime_secret :
      length(d.statement) == 1 && toset(d.statement[0].actions) == toset(["secretsmanager:GetSecretValue"]) && toset(d.statement[0].resources) == toset([aws_secretsmanager_secret.runtime[role].arn])
    ])
    error_message = "Each runtime-secret policy grants GetSecretValue on its own secret's ARN only."
  }
  assert {
    condition = (
      aws_iam_role_policy.runtime_secret["api"].role == aws_iam_role.lambda.id &&
      aws_iam_role_policy.runtime_secret["worker"].role == aws_iam_role.worker_lambda.id &&
      aws_iam_role_policy.runtime_secret["migrate"].role == aws_iam_role.migrate_lambda.id
    )
    error_message = "Each runtime-secret policy is attached to its own Lambda's role."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.migrate_lambda.statement :
      toset(s.resources) == toset([aws_db_instance.main.master_user_secret[0].secret_arn])
    ])
    error_message = "The migrate role's own policy reads the RDS master secret and nothing else (its runtime secret is granted separately)."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.github_deploy.statement : s if anytrue([for a in s.actions : startswith(a, "secretsmanager:")])]) == 0
    error_message = "The deploy role must not read any secret (it may read function configuration, which is why secrets left it)."
  }

  # The Secrets Manager endpoint: exactly the owning role per secret.
  assert {
    condition = (
      length(data.aws_iam_policy_document.secretsmanager_endpoint.statement) == 4 &&
      alltrue([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement :
        length(s.resources) == 1 && length(s.principals) == 1 && length(one(s.principals).identifiers) == 1 &&
        alltrue([for a in s.actions : !strcontains(a, "*")]) &&
        (
          (one(s.resources) == aws_db_instance.main.master_user_secret[0].secret_arn && one(one(s.principals).identifiers) == aws_iam_role.migrate_lambda.arn) ||
          (one(s.resources) == aws_secretsmanager_secret.runtime["api"].arn && one(one(s.principals).identifiers) == aws_iam_role.lambda.arn) ||
          (one(s.resources) == aws_secretsmanager_secret.runtime["worker"].arn && one(one(s.principals).identifiers) == aws_iam_role.worker_lambda.arn) ||
          (one(s.resources) == aws_secretsmanager_secret.runtime["migrate"].arn && one(one(s.principals).identifiers) == aws_iam_role.migrate_lambda.arn)
        )
      ])
    )
    error_message = "The Secrets Manager endpoint policy must let each role read only its own secret: migrate the RDS master and its runtime secret, the API and worker their runtime secrets."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement : [for p in s.principals : p.identifiers]])) == toset([
      aws_iam_role.lambda.arn, aws_iam_role.worker_lambda.arn, aws_iam_role.migrate_lambda.arn,
    ])
    error_message = "Only the API, worker and migrate roles may use the Secrets Manager endpoint."
  }

  # Network: the API and worker reach the endpoint (443 both ways), as migrate does.
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.vpce_from_api.referenced_security_group_id == aws_security_group.api_lambda.id &&
      aws_vpc_security_group_ingress_rule.vpce_from_worker.referenced_security_group_id == aws_security_group.worker_lambda.id &&
      aws_vpc_security_group_egress_rule.api_to_vpce.referenced_security_group_id == aws_security_group.vpce.id &&
      aws_vpc_security_group_egress_rule.worker_to_vpce.referenced_security_group_id == aws_security_group.vpce.id &&
      alltrue([for r in [aws_vpc_security_group_ingress_rule.vpce_from_api, aws_vpc_security_group_ingress_rule.vpce_from_worker, aws_vpc_security_group_egress_rule.api_to_vpce, aws_vpc_security_group_egress_rule.worker_to_vpce] :
        r.from_port == 443 && r.to_port == 443 && r.ip_protocol == "tcp"
      ])
    )
    error_message = "The API and worker must reach the Secrets Manager endpoint on 443 (their runtime secrets), and nothing wider."
  }
  assert {
    condition     = aws_vpc_endpoint.secretsmanager.private_dns_enabled && aws_vpc_endpoint.secretsmanager.security_group_ids == toset([aws_security_group.vpce.id])
    error_message = "Secrets Manager is reached through its private-DNS interface endpoint, guarded by the vpce security group."
  }
}

run "rejects_short_jwt_secret" {
  command = plan

  variables {
    auth_jwt_secret = "too-short"
  }

  expect_failures = [var.auth_jwt_secret]
}

run "rejects_dev_placeholder_jwt_secret" {
  command = plan

  # Long enough, so only the placeholder check can refuse it.
  variables {
    auth_jwt_secret = "dev-only-jwt-secret-change-me-0000000000"
  }

  expect_failures = [var.auth_jwt_secret]
}

run "rejects_non_alphanumeric_db_password" {
  command = plan

  variables {
    db_app_password = "has@special/chars-and-is-long-enough"
  }

  expect_failures = [var.db_app_password]
}

run "rejects_short_alerts_token_secret" {
  command = plan

  variables {
    alerts_token_secret = "0123456789abcdef"
  }

  expect_failures = [var.alerts_token_secret]
}

# The TOTP sealing key (two-step sign-in, issue #282): long, and not the
# committed dev placeholder.
run "rejects_short_app_encryption_key" {
  command = plan

  variables {
    app_encryption_key = "0123456789abcdef"
  }

  expect_failures = [var.app_encryption_key]
}

run "rejects_placeholder_app_encryption_key" {
  command = plan

  variables {
    app_encryption_key = "dev-only-app-encryption-key-0000000000000000"
  }

  expect_failures = [var.app_encryption_key]
}

run "rejects_fractional_runtime_secret_version" {
  command = plan

  variables {
    runtime_secret_version = 1.5
  }

  expect_failures = [var.runtime_secret_version]
}

run "rejects_zero_runtime_secret_version" {
  command = plan

  variables {
    runtime_secret_version = 0
  }

  expect_failures = [var.runtime_secret_version]
}

run "rejects_runtime_secret_version_past_16_digits" {
  command = plan

  variables {
    runtime_secret_version = 10000000000000000
  }

  expect_failures = [var.runtime_secret_version]
}

# Rotation: scripts/tf.sh sets the counter from sops.lastmodified as
# YYYYMMDDhhmmss (14 digits: past 2^32, well inside the provider's 64-bit
# secret_string_wo_version). It must pass the variable's validation and reach
# every runtime secret version unchanged (the AWS provider replaces a version
# whose secret_string_wo_version changed, so its version_id, and each Lambda's
# RUNTIME_SECRET_VERSION with it, changes; the mocks can't show the
# replacement itself, runtime_secrets checks the wiring).
run "rotation_counter_from_sops_lastmodified" {
  command = plan

  variables {
    runtime_secret_version = 20260928081500
  }

  assert {
    condition     = alltrue([for k, v in aws_secretsmanager_secret_version.runtime : v.secret_string_wo_version == 20260928081500])
    error_message = "A lastmodified-derived runtime_secret_version (YYYYMMDDhhmmss) must pass validation and reach every runtime secret version unchanged."
  }
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
    condition     = aws_wafv2_web_acl.frontend.scope == "CLOUDFRONT" && length(aws_wafv2_web_acl.frontend.rule) == 4
    error_message = "WAF must be a CLOUDFRONT-scope ACL with the auth block, the sign-in CAPTCHA, and the API and site-wide rate rules."
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
    error_message = "Site CSP must not allow any third-party origin (everything is self-hosted; the one exception, the sign-in CAPTCHA SDK, appears only once waf_captcha_integration_url is set, run signin_captcha_with_integration_url)."
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

  # The SES endpoint policy: the API and worker send as no-reply@, only the
  # API releases a suppressed address, and nobody else uses the endpoint.
  assert {
    condition     = aws_vpc_endpoint.ses.service_name != "" && can(regex("policy\\s*=\\s*data\\.aws_iam_policy_document\\.ses_endpoint\\.json", regex("(?s)resource \"aws_vpc_endpoint\" \"ses\" \\{.*?\\n\\}", file("ses.tf"))))
    error_message = "The SES endpoint must carry an endpoint policy (ses_endpoint)."
  }
  assert {
    condition = toset([for s in data.aws_iam_policy_document.ses_endpoint.statement :
      "${s.sid} ${join(",", sort(tolist(s.actions)))} ${join(",", sort(flatten([for p in s.principals : p.identifiers])))}"
      ]) == toset([
      "ApiSendsAsNoReply ses:SendEmail ${aws_iam_role.lambda.arn}",
      "WorkerSendsAsNoReply ses:SendEmail ${aws_iam_role.worker_lambda.arn}",
      "ApiReleasesSuppressedAddress ses:DeleteSuppressedDestination ${aws_iam_role.lambda.arn}",
    ])
    error_message = "The SES endpoint policy must be exactly: the API and worker roles may SendEmail, and only the API role may DeleteSuppressedDestination."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.ses_endpoint.statement :
      toset(s.resources) == toset(["arn:aws:ses:af-south-1:000000000000:identity/*", aws_sesv2_configuration_set.main.arn]) &&
      length(s.condition) == 1 && one(s.condition).variable == "ses:FromAddress" && one(s.condition).values == tolist(["no-reply@water-management.jaredhoward.com"])
      if contains(s.actions, "ses:SendEmail")
    ])
    error_message = "A send through the SES endpoint must be pinned like the IAM policy: this account's identities and configuration set, From = no-reply@<domain>."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.ses_endpoint.statement : length(s.principals) == 1 && one(s.principals).type == "AWS" && alltrue([for a in s.actions : !strcontains(a, "*")])])
    error_message = "Every SES endpoint statement names one AWS principal and no wildcard action."
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

# --- Alert / report mailbox validation --------------------------------------
# budget_alert_email is required; an empty, malformed or reserved (RFC 2606 /
# RFC 6761) address is refused, case-insensitively. dmarc_report_email may be
# empty (no rua) but is held to the same rule when set.

run "rejects_empty_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = ""
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_malformed_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "ops at water-management.jaredhoward.com"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_example_com_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "You+AWS-Alerts@Example.COM"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_example_subdomain_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "ops@mail.example.org"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_reserved_tld_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "ops@water-management.INVALID"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_example_net_dmarc_report_email" {
  command = plan
  variables {
    dmarc_report_email = "dmarc@EXAMPLE.net"
  }
  expect_failures = [var.dmarc_report_email]
}

# Positive control: a real-looking address at a domain that merely contains
# "example" is accepted, and an empty dmarc_report_email still omits rua.
run "accepts_real_alert_mailboxes" {
  command = plan
  variables {
    budget_alert_email = "Ops+AWS@counterexample.com"
    dmarc_report_email = "dmarc@water-management.jaredhoward.com"
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "Ops+AWS@counterexample.com"
    error_message = "A non-reserved address is accepted and subscribed."
  }
}

run "alarms" {
  command = plan

  assert {
    condition = alltrue([for a in [
      aws_cloudwatch_metric_alarm.lambda_errors,
      aws_cloudwatch_metric_alarm.lambda_throttles,
      aws_cloudwatch_metric_alarm.lambda_duration,
      aws_cloudwatch_metric_alarm.unhandled_error,
      aws_cloudwatch_metric_alarm.login_failed,
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
  # CloudFront and CLOUDFRONT-scope WAF metrics exist only in us-east-1, and an
  # alarm can only notify a topic in its own region.
  assert {
    condition = alltrue([for a in [
      aws_cloudwatch_metric_alarm.cloudfront_5xx,
      aws_cloudwatch_metric_alarm.cloudfront_requests,
      aws_cloudwatch_metric_alarm.waf_blocked_requests,
    ] : a.alarm_actions == toset([aws_sns_topic.alerts_us_east_1.arn])])
    error_message = "Every us-east-1 alarm (CloudFront, WAF) must notify the us-east-1 alerts topic."
  }

  # --- Request-flood alarm (alarms.tf; issue #126, the audit's one High) -----
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.cloudfront_requests.namespace == "AWS/CloudFront" &&
      aws_cloudwatch_metric_alarm.cloudfront_requests.metric_name == "Requests" &&
      aws_cloudwatch_metric_alarm.cloudfront_requests.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.cloudfront_requests.period == 300 &&
      aws_cloudwatch_metric_alarm.cloudfront_requests.dimensions == tomap({ DistributionId = "E0000000000000", Region = "Global" })
    )
    error_message = "The request-flood alarm must sum this distribution's Requests (Region = Global) over 5 minutes."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_requests.threshold == 5000 && aws_cloudwatch_metric_alarm.cloudfront_requests.comparison_operator == "GreaterThanThreshold" && aws_cloudwatch_metric_alarm.cloudfront_requests.evaluation_periods == 1
    error_message = "By default the request-flood alarm fires on the first 5 minutes over 5,000 requests (a flood just under it costs $2.30-4.03/day)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.waf_blocked_requests.namespace == "AWS/WAFV2" &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests.metric_name == "BlockedRequests" &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests.dimensions == tomap({ WebACL = "water-management-frontend-acl", Rule = "ALL" })
    )
    error_message = "The WAF alarm must sum BlockedRequests across every rule (Rule = ALL) of the ACL, by its metric name, with no Region dimension (CLOUDFRONT scope)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.waf_blocked_requests.dimensions["WebACL"] == aws_wafv2_web_acl.frontend.visibility_config[0].metric_name
    error_message = "The WebACL dimension is the ACL's CloudWatch metric name."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.waf_blocked_requests.threshold == 100 &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests.period == 300 &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests.datapoints_to_alarm == 3
    )
    error_message = "The WAF alarm fires on sustained blocks only: over 100 in each of three 5-minute periods."
  }
  assert {
    condition     = strcontains(aws_cloudwatch_metric_alarm.cloudfront_requests.alarm_description, "docs/deployment.md, Runbooks, Request flood") && strcontains(aws_cloudwatch_metric_alarm.waf_blocked_requests.alarm_description, "docs/deployment.md, Runbooks, Request flood")
    error_message = "Both edge alarms must point the operator at the Request flood runbook."
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
  # --- Budgets, anomaly detection and the alert topic policies -------------
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "90" && aws_budgets_budget.monthly[0].time_unit == "MONTHLY"
    error_message = "A $90 monthly budget exists by default (above af-south-1's ~$59–64 idle)."
  }
  assert {
    condition = toset([for n in aws_budgets_budget.monthly[0].notification : "${n.notification_type}:${n.threshold}:${n.threshold_type}:${n.comparison_operator}"]) == toset([
      "FORECASTED:100:PERCENTAGE:GREATER_THAN",
      "ACTUAL:80:PERCENTAGE:GREATER_THAN",
      "ACTUAL:100:PERCENTAGE:GREATER_THAN",
    ])
    error_message = "The monthly budget alerts at FORECASTED 100%, ACTUAL 80% and ACTUAL 100% (no ACTUAL 50%, which fires every month at idle)."
  }
  assert {
    condition = (
      length(aws_budgets_budget.daily) == 1 &&
      aws_budgets_budget.daily[0].time_unit == "DAILY" &&
      aws_budgets_budget.daily[0].budget_type == "COST" &&
      aws_budgets_budget.daily[0].limit_amount == "7"
    )
    error_message = "A $7/day budget (ceil(90 × 2.25 / 30)) exists by default: the first-month guard while the monthly forecast has no history."
  }
  assert {
    condition = toset([for n in aws_budgets_budget.daily[0].notification : "${n.notification_type}:${n.threshold}:${n.threshold_type}:${n.comparison_operator}"]) == toset([
      "ACTUAL:100:PERCENTAGE:GREATER_THAN",
    ])
    error_message = "The daily budget has one ACTUAL 100% notification (daily budgets don't support FORECASTED)."
  }
  assert {
    condition = alltrue([for n in concat(tolist(aws_budgets_budget.monthly[0].notification), tolist(aws_budgets_budget.daily[0].notification)) :
      n.subscriber_sns_topic_arns == toset([aws_sns_topic.alerts_us_east_1.arn])
    ])
    error_message = "Every budget notification publishes to the us-east-1 alerts topic, not the opt-in region's."
  }
  # Off by default: an account holds one services monitor and AWS may have
  # made it, which would fail the first apply (infra/README.md step 11).
  assert {
    condition     = var.cost_anomaly_threshold_usd == 0 && length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "Cost Anomaly Detection is off by default (anomaly_detection_off_by_default): the operator turns it on after the first apply."
  }
  assert {
    condition = (
      # Three statements: CloudWatch alarms (here), RDS events (AllowRdsEvents,
      # pinned in data.tftest.hcl's db_events run) and the database KMS key
      # alarm's EventBridge rule (AllowEventBridgeKmsKeyAlarm, pinned in
      # kms.tftest.hcl; only with rds_customer_managed_key, the default).
      length(data.aws_iam_policy_document.alerts_publish.statement) == 3 &&
      data.aws_iam_policy_document.alerts_publish.statement[1].sid == "AllowRdsEvents" &&
      one(data.aws_iam_policy_document.alerts_publish.statement[0].principals).identifiers == toset(["cloudwatch.amazonaws.com"]) &&
      toset([for c in data.aws_iam_policy_document.alerts_publish.statement[0].condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
        "StringEquals|aws:SourceAccount|000000000000",
        "ArnLike|aws:SourceArn|arn:aws:cloudwatch:af-south-1:000000000000:alarm:*",
      ])
    )
    error_message = "The regional topic admits only this account's CloudWatch alarms in this region (aws:SourceAccount + aws:SourceArn), this instance's RDS events and the KMS key alarm's rule; Budgets no longer publish there."
  }
  assert {
    condition = {
      for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement :
      one(one(s.principals).identifiers) => toset([for c in s.condition : "${c.test}|${c.variable}|${join(",", c.values)}"])
      } == {
      "cloudwatch.amazonaws.com" = toset([
        "StringEquals|aws:SourceAccount|000000000000",
        "ArnLike|aws:SourceArn|arn:aws:cloudwatch:us-east-1:000000000000:alarm:*",
      ])
      "budgets.amazonaws.com" = toset([
        "StringEquals|aws:SourceAccount|000000000000",
        "ArnLike|aws:SourceArn|arn:aws:budgets::000000000000:*",
      ])
      "costalerts.amazonaws.com" = toset([
        "StringEquals|aws:SourceAccount|000000000000",
      ])
    }
    error_message = "The us-east-1 topic admits CloudWatch, Budgets and Cost Anomaly Detection, each only for this account (confused-deputy conditions as AWS documents them)."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement :
      length(one(s.principals).identifiers) == 1 && s.actions == toset(["sns:Publish"])
    ])
    error_message = "One service per statement, publish only, so each keeps its own conditions."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "ops@water-management.jaredhoward.com" && aws_sns_topic_subscription.alerts_us_east_1_email.endpoint == "ops@water-management.jaredhoward.com"
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
    condition     = aws_cloudwatch_log_metric_filter.self_check_failed.pattern == "{ $.message.event = \"self_check_failed\" }"
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

# --- Budget variables ---------------------------------------------------------
# The daily budget follows the monthly unless set; it must stay below it, and
# neither amount (nor the anomaly threshold) may be negative.

run "daily_budget_follows_monthly" {
  command = plan
  variables {
    budget_monthly_usd = 170
  }
  assert {
    condition     = aws_budgets_budget.monthly[0].limit_amount == "170" && aws_budgets_budget.daily[0].limit_amount == "13"
    error_message = "The derived daily budget is ceil(monthly × 2.25 / 30): $13 on the full tier's $170."
  }
}

run "daily_budget_explicit" {
  command = plan
  variables {
    budget_daily_usd = 4.5
  }
  assert {
    condition     = aws_budgets_budget.daily[0].limit_amount == "4.5" && aws_budgets_budget.monthly[0].limit_amount == "90"
    error_message = "An explicit budget_daily_usd is used as given."
  }
}

# Cost Anomaly Detection is off by default, so the first apply can't fail
# on a services monitor AWS already made (one per account); the operator
# turns it on after the first apply (infra/README.md § Operator steps, step 11).
run "anomaly_detection_off_by_default" {
  command = plan
  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "No anomaly monitor unless cost_anomaly_threshold_usd is set: the first apply must not create one."
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && length(aws_budgets_budget.daily) == 1
    error_message = "The budgets stay on by default; only the anomaly monitor waits."
  }
}

run "anomaly_detection_on" {
  command = plan
  variables {
    cost_anomaly_threshold_usd = 10
  }
  assert {
    condition = (
      length(aws_ce_anomaly_monitor.services) == 1 &&
      aws_ce_anomaly_monitor.services[0].monitor_type == "DIMENSIONAL" &&
      aws_ce_anomaly_monitor.services[0].monitor_dimension == "SERVICE" &&
      aws_ce_anomaly_monitor.services[0].name == "water-management-services" &&
      aws_ce_anomaly_subscription.services[0].frequency == "IMMEDIATE" &&
      aws_ce_anomaly_subscription.services[0].monitor_arn_list == tolist([aws_ce_anomaly_monitor.services[0].arn])
    )
    error_message = "Cost Anomaly Detection, once on: one AWS-services monitor with an IMMEDIATE subscription."
  }
  assert {
    condition = (
      one(aws_ce_anomaly_subscription.services[0].subscriber).type == "SNS" &&
      one(aws_ce_anomaly_subscription.services[0].subscriber).address == aws_sns_topic.alerts_us_east_1.arn &&
      one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).key == "ANOMALY_TOTAL_IMPACT_ABSOLUTE" &&
      one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).values == toset(["10"])
    )
    error_message = "Anomalies with a total impact of the threshold ($10) or more page the us-east-1 alerts topic."
  }
}

run "daily_budget_off" {
  command = plan
  variables {
    budget_daily_usd           = 0
    cost_anomaly_threshold_usd = 0
  }
  assert {
    condition     = length(aws_budgets_budget.daily) == 0 && length(aws_budgets_budget.monthly) == 1
    error_message = "budget_daily_usd = 0 skips only the daily budget."
  }
  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "cost_anomaly_threshold_usd = 0 skips the anomaly monitor (an account holds only one services monitor)."
  }
}

run "no_budgets_before_billing_access" {
  command = plan
  variables {
    budget_monthly_usd = 0
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 0 && length(aws_budgets_budget.daily) == 0
    error_message = "budget_monthly_usd = 0 skips both budgets (billing access not yet enabled)."
  }
}

run "rejects_daily_budget_not_below_monthly" {
  command = plan
  variables {
    budget_daily_usd = 90
  }
  expect_failures = [var.budget_daily_usd]
}

run "rejects_daily_budget_without_monthly" {
  command = plan
  variables {
    budget_monthly_usd = 0
    budget_daily_usd   = 6
  }
  expect_failures = [var.budget_daily_usd]
}

run "rejects_negative_daily_budget" {
  command = plan
  variables {
    budget_daily_usd = -1
  }
  expect_failures = [var.budget_daily_usd]
}

run "rejects_negative_monthly_budget" {
  command = plan
  variables {
    budget_monthly_usd = -80
  }
  expect_failures = [var.budget_monthly_usd]
}

run "rejects_negative_anomaly_threshold" {
  command = plan
  variables {
    cost_anomaly_threshold_usd = -10
  }
  expect_failures = [var.cost_anomaly_threshold_usd]
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
      startswith(local.runtime_secrets.worker.DATABASE_URL, "postgresql://water_app:") &&
      strcontains(local.runtime_secrets.worker.DATABASE_URL, "sslmode=verify-full")
    )
    error_message = "The worker connects as the RLS-bound water_app over verified TLS."
  }
  assert {
    condition     = length(setintersection(keys(aws_lambda_function.worker.environment[0].variables), ["JOB_TRANSPORT", "JOBS_QUEUE_URL"])) == 0
    error_message = "The worker never wakes itself (it may not send to the jobs queue): only the API gets JOB_TRANSPORT and JOBS_QUEUE_URL."
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
    condition = (
      aws_cloudwatch_event_target.worker_tick.retry_policy[0].maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_target.worker_tick.retry_policy[0].maximum_event_age_in_seconds == 300 &&
      aws_lambda_function_event_invoke_config.worker_tick.function_name == aws_lambda_function.worker.function_name &&
      aws_lambda_function_event_invoke_config.worker_tick.maximum_retry_attempts == 0 &&
      aws_lambda_function_event_invoke_config.worker_tick.maximum_event_age_in_seconds == 300
    )
    error_message = "A worker tick must never be retried or outlive one tick (EventBridge target and Lambda's async queue): stale ticks would pile up for hours on a struggling worker."
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
    condition     = aws_cloudwatch_metric_alarm.jobs_dlq_depth.threshold == 0 && one([for m in aws_cloudwatch_metric_alarm.jobs_dlq_depth.metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.jobs_dlq.name
    error_message = "A new message in the jobs DLQ must alarm (the arrival expression: observability.tftest.hcl)."
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
    condition     = aws_cloudwatch_log_metric_filter.job_dead.log_group_name == aws_cloudwatch_log_group.worker.name && aws_cloudwatch_log_metric_filter.job_dead.pattern == "{ $.message.event = \"job_dead\" }"
    error_message = "The dead-job filter must match runner.ts's structured event in the worker's log group."
  }

  # --- Alert emails (WP-2.13) -------------------------------------------------------
  assert {
    condition = (
      contains(keys(local.runtime_secrets.worker), "ALERTS_TOKEN_SECRET") &&
      local.runtime_secrets.worker.ALERTS_TOKEN_SECRET == var.alerts_token_secret &&
      aws_lambda_function.worker.environment[0].variables["ALERTS_ENABLED"] == "true"
    )
    error_message = "The worker signs unsubscribe links (ALERTS_TOKEN_SECRET, ≥ 32 characters) and sends alerts unless the kill switch is off."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.backend.environment[0].variables), "ALERTS_TOKEN_SECRET") && !contains(keys(local.runtime_secrets.api), "ALERTS_TOKEN_SECRET")
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
      one([for m in aws_cloudwatch_metric_alarm.mail_events_dlq_depth.metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.mail_events_dlq.name &&
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth.threshold == 0 &&
      aws_cloudwatch_metric_alarm.mail_events_dlq_depth.alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "A new message in the mail-events DLQ must alarm."
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
    condition     = aws_iam_role_policy.lambda_logs["fetcher"].role == aws_iam_role.fetcher_lambda.id && !contains(keys(aws_iam_role_policy.lambda_vpc_eni), "fetcher")
    error_message = "The fetcher logs to its own log group only, with no VPC ENI policy (iam.tf; run lambda_logs_scoped in iam.tftest.hcl pins the statement)."
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
      one([for m in aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth.metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.fetch_requests_dlq.name &&
      one([for m in aws_cloudwatch_metric_alarm.ingest_results_dlq_depth.metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.ingest_results_dlq.name &&
      aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth.threshold == 0 &&
      aws_cloudwatch_metric_alarm.ingest_results_dlq_depth.threshold == 0
    )
    error_message = "A new message in either feed DLQ must alarm."
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

# The request-flood alarm stays a cost control: above 20,000 per 5 minutes a
# flood just under it costs $9-16/day unseen; below 1,000 one person at the
# WAF's per-IP limit pages.
run "rejects_loose_cloudfront_requests_alarm" {
  command = plan

  variables {
    cloudfront_requests_alarm_per_5min = 20001
  }

  expect_failures = [var.cloudfront_requests_alarm_per_5min]
}

run "rejects_tight_cloudfront_requests_alarm" {
  command = plan

  variables {
    cloudfront_requests_alarm_per_5min = 999
  }

  expect_failures = [var.cloudfront_requests_alarm_per_5min]
}

# The failed-sign-in alarm: below 10 one person locking themselves out pages;
# above 300 one IP at the WAF's auth limit (100 per 5 minutes) stays unseen.
run "rejects_loose_login_failed_alarm" {
  command = plan

  variables {
    login_failed_alarm_per_15min = 301
  }

  expect_failures = [var.login_failed_alarm_per_15min]
}

run "rejects_tight_login_failed_alarm" {
  command = plan

  variables {
    login_failed_alarm_per_15min = 9
  }

  expect_failures = [var.login_failed_alarm_per_15min]
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
    condition     = aws_iam_role_policy.lambda_logs["renderer"].role == aws_iam_role.renderer_lambda.id && !contains(keys(aws_iam_role_policy.lambda_vpc_eni), "renderer")
    error_message = "The renderer logs to its own log group only, with no VPC ENI policy (iam.tf; run lambda_logs_scoped in iam.tftest.hcl pins the statement)."
  }
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s if s.effect != "Deny"]) == 1 &&
      one([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s.sid if s.effect != "Deny"]) == "AllowCloudFrontReadReportPdfs"
    )
    error_message = "The bucket policy's only grant is CloudFront's read of PDFs (run report_downloads pins it); the API never reads the bucket, it signs CloudFront URLs."
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
      aws_lambda_function.backend.environment[0].variables["REPORTS_BUCKET"] == aws_s3_bucket.reports.bucket &&
      aws_lambda_function.backend.environment[0].variables["REPORT_DOWNLOADS"] == "cloudfront"
    )
    error_message = "The worker hands renders to the renderer and mails through SES; the API signs downloads as CloudFront URLs."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.worker_render_results.event_source_arn == aws_sqs_queue.render_results.arn && aws_lambda_event_source_mapping.worker_render_results.function_name == aws_lambda_function.worker.arn
    error_message = "render-results triggers the worker."
  }
  assert {
    condition = (
      one([for m in aws_cloudwatch_metric_alarm.render_requests_dlq_depth.metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.render_requests_dlq.name &&
      one([for m in aws_cloudwatch_metric_alarm.render_results_dlq_depth.metric_query : m.metric[0].dimensions["QueueName"] if m.id == "visible"]) == aws_sqs_queue.render_results_dlq.name &&
      aws_cloudwatch_metric_alarm.render_requests_dlq_depth.threshold == 0 &&
      aws_cloudwatch_metric_alarm.render_results_dlq_depth.threshold == 0
    )
    error_message = "A new message in either render DLQ must alarm."
  }
}

# ---------------------------------------------------------------------------
# Report downloads through CloudFront (reports.tf, s3_cloudfront.tf; issue
# #126): /reports/* serves the private bucket through its own OAC to signed
# URLs only, behind the WAF, and nothing else can read a PDF.
# ---------------------------------------------------------------------------

run "report_downloads" {
  command = plan

  # --- The behaviour: signed URLs only, uncached, GET/HEAD, https ----------------------
  assert {
    condition     = length([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b if b.path_pattern == "/reports/*"]) == 1
    error_message = "The distribution must have exactly one /reports/* behaviour (report PDF downloads)."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : (
      b.target_origin_id == "s3-reports" &&
      b.trusted_key_groups == tolist([aws_cloudfront_key_group.report_downloads.id]) &&
      b.viewer_protocol_policy == "https-only" &&
      toset(b.allowed_methods) == toset(["GET", "HEAD"]) &&
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
      b.origin_request_policy_id == aws_cloudfront_origin_request_policy.report_downloads.id &&
      b.response_headers_policy_id == "api-headers-policy-id"
    ) if b.path_pattern == "/reports/*"])
    error_message = "/reports/* must serve the reports bucket only to CloudFront signed URLs from the download key group, uncached (CachingDisabled), GET/HEAD over https, with the API's security headers."
  }
  # Positive control for the signer check: no other behaviour trusts a key
  # group, only /reports/* reaches the reports origin and only /packs/* the
  # packs origin (run packs pins that behaviour).
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior :
      (b.path_pattern == "/reports/*") == (b.target_origin_id == "s3-reports") &&
      (b.path_pattern == "/packs/*") == (b.target_origin_id == "s3-packs") &&
      contains(["/reports/*", "/packs/*"], b.path_pattern) == (length(coalesce(b.trusted_key_groups, [])) > 0)
    ]) && length(coalesce(aws_cloudfront_distribution.frontend.default_cache_behavior[0].trusted_key_groups, [])) == 0
    error_message = "Only the /reports/* behaviour reaches the reports bucket and only /packs/* the packs bucket, and they alone require signed URLs."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].path_pattern == "/api/*"
    error_message = "/api/* stays the first ordered behaviour (edge_security indexes it)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.web_acl_id == aws_wafv2_web_acl.frontend.arn
    error_message = "Downloads pass the distribution's WAF (the per-IP rate rule covers every path)."
  }

  # --- The origin: the reports bucket through its own OAC ----------------------------------
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.frontend.origin :
      o.domain_name == aws_s3_bucket.reports.bucket_regional_domain_name && o.origin_access_control_id == aws_cloudfront_origin_access_control.reports.id
    if o.origin_id == "s3-reports"]) && length([for o in aws_cloudfront_distribution.frontend.origin : o if o.origin_id == "s3-reports"]) == 1
    error_message = "The s3-reports origin must be the reports bucket, read through its OAC."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.reports.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.reports.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.reports.signing_protocol == "sigv4"
    )
    error_message = "The reports OAC must sign every origin request (sigv4)."
  }
  assert {
    condition = (
      one(aws_cloudfront_origin_request_policy.report_downloads.cookies_config).cookie_behavior == "none" &&
      one(aws_cloudfront_origin_request_policy.report_downloads.headers_config).header_behavior == "none" &&
      one(aws_cloudfront_origin_request_policy.report_downloads.query_strings_config).query_string_behavior == "whitelist" &&
      one(one(aws_cloudfront_origin_request_policy.report_downloads.query_strings_config).query_strings).items == toset(["response-content-disposition"])
    )
    error_message = "Only the download file name (response-content-disposition) may reach the bucket: no cookies, no viewer headers, no other query."
  }

  # --- The bucket policy: this distribution, GetObject on reports/ only ---------------------
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : (
      s.effect == null || s.effect == "Allow"
      ) ? (
      s.sid == "AllowCloudFrontReadReportPdfs" &&
      toset(s.actions) == toset(["s3:GetObject"]) &&
      toset(s.resources) == toset(["${aws_s3_bucket.reports.arn}/reports/*"]) &&
      one(s.principals).type == "Service" &&
      one(s.principals).identifiers == toset(["cloudfront.amazonaws.com"]) &&
      one(s.condition).test == "StringEquals" &&
      one(s.condition).variable == "AWS:SourceArn" &&
      one(s.condition).values == tolist([aws_cloudfront_distribution.frontend.arn])
    ) : true])
    error_message = "The reports bucket grants CloudFront s3:GetObject on reports/* for this distribution (AWS:SourceArn) only."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : s if s.sid == "AllowCloudFrontReadReportPdfs"]) == 1
    error_message = "The CloudFront read grant must be present (positive control for the check above)."
  }

  # --- The keys: operator-generated; public halves trusted, private half from sops -----------
  assert {
    condition = (
      keys(aws_cloudfront_public_key.report_downloads) == ["2026-09"] &&
      aws_cloudfront_public_key.report_downloads["2026-09"].encoded_key == var.report_download_public_keys["2026-09"] &&
      aws_cloudfront_public_key.report_downloads["2026-09"].name == "water-management-report-downloads-2026-09"
    )
    error_message = "One CloudFront public key per report_download_public_keys entry, from its PEM."
  }
  assert {
    condition     = aws_cloudfront_key_group.report_downloads.items == toset(["K2026090000000A"])
    error_message = "The key group trusts exactly the configured public keys."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_KEY_PAIR_ID"] == aws_cloudfront_public_key.report_downloads["2026-09"].id &&
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_PUBLIC_KEY"] == var.report_download_public_keys["2026-09"]
    )
    error_message = "The API names the signing key's id (Key-Pair-Id) and gets its public PEM, which it matches its private key against at cold start."
  }
}

# ---------------------------------------------------------------------------
# Issued evidence packs' PDFs (packs.tf, s3_cloudfront.tf; 119_pack_render):
# a private bucket that keeps every PDF (versioned, Object Lock, nothing
# expires), written only by the renderer under packs/, read only by
# CloudFront's /packs/* behaviour for signed URLs.
# ---------------------------------------------------------------------------

run "packs" {
  command = plan

  # --- The bucket: private, encrypted, TLS only, kept ----------------------------------
  assert {
    condition = (
      aws_s3_bucket_public_access_block.packs.block_public_acls &&
      aws_s3_bucket_public_access_block.packs.block_public_policy &&
      aws_s3_bucket_public_access_block.packs.ignore_public_acls &&
      aws_s3_bucket_public_access_block.packs.restrict_public_buckets
    )
    error_message = "The packs bucket must block every kind of public access."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.packs.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"
    error_message = "Pack PDFs must be encrypted at rest (SSE-S3)."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_ownership_controls.packs.rule : r.object_ownership]) == "BucketOwnerEnforced"
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition = (
      aws_s3_bucket.packs.object_lock_enabled &&
      one(aws_s3_bucket_versioning.packs.versioning_configuration).status == "Enabled" &&
      one(one(aws_s3_bucket_object_lock_configuration.packs.rule).default_retention).mode == "GOVERNANCE" &&
      one(one(aws_s3_bucket_object_lock_configuration.packs.rule).default_retention).days == var.pack_retention_days &&
      var.pack_retention_days == 3650
    )
    error_message = "Every pack PDF is kept: a versioned bucket with an Object Lock default retention (GOVERNANCE, pack_retention_days, 10 years by default)."
  }
  assert {
    condition     = contains([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.sid if s.effect == "Deny"], "DenyInsecureTransport")
    error_message = "The packs bucket must refuse plain-HTTP access."
  }
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s if s.effect != "Deny"]) == 1 &&
      one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.sid if s.effect != "Deny"]) == "AllowCloudFrontReadPackPdfs" &&
      toset(one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.actions if s.effect != "Deny"])) == toset(["s3:GetObject"]) &&
      toset(one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.resources if s.effect != "Deny"])) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      tolist(one(one([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : s.condition if s.effect != "Deny"])).values) == tolist([aws_cloudfront_distribution.frontend.arn])
    )
    error_message = "The packs bucket policy's only grant is this distribution's GetObject of packs/* (the API never reads the bucket, it signs CloudFront URLs)."
  }

  # --- Least privilege: the renderer puts, and nothing else ----------------------------------
  assert {
    condition = (
      length(data.aws_iam_policy_document.renderer_packs.statement) == 1 &&
      toset(data.aws_iam_policy_document.renderer_packs.statement[0].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.renderer_packs.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      aws_iam_role_policy.renderer_packs.role == aws_iam_role.renderer_lambda.id
    )
    error_message = "The renderer may only put pack PDFs under packs/: never read, list, delete, change a retention or bypass it."
  }

  # --- The download behaviour and its origin ----------------------------------------------
  assert {
    condition = length([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b if b.path_pattern == "/packs/*"]) == 1 && alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : (
      b.target_origin_id == "s3-packs" &&
      b.trusted_key_groups == tolist([aws_cloudfront_key_group.report_downloads.id]) &&
      b.viewer_protocol_policy == "https-only" &&
      toset(b.allowed_methods) == toset(["GET", "HEAD"]) &&
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
      b.origin_request_policy_id == aws_cloudfront_origin_request_policy.report_downloads.id &&
      b.response_headers_policy_id == "api-headers-policy-id"
    ) if b.path_pattern == "/packs/*"])
    error_message = "/packs/* must serve the packs bucket only to CloudFront signed URLs from the download key group, uncached, GET/HEAD over https, with the API's security headers."
  }
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.frontend.origin :
      o.domain_name == aws_s3_bucket.packs.bucket_regional_domain_name && o.origin_access_control_id == aws_cloudfront_origin_access_control.packs.id
    if o.origin_id == "s3-packs"]) && length([for o in aws_cloudfront_distribution.frontend.origin : o if o.origin_id == "s3-packs"]) == 1
    error_message = "The s3-packs origin must be the packs bucket, read through its own OAC."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.packs.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.packs.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.packs.signing_protocol == "sigv4"
    )
    error_message = "The packs OAC must sign every origin request (sigv4)."
  }

  # --- The worker checks the renderer's answer against the stored object ------------------
  assert {
    condition = (
      length(data.aws_iam_policy_document.worker_packs.statement) == 1 &&
      toset(data.aws_iam_policy_document.worker_packs.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.worker_packs.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      aws_iam_role_policy.worker_packs.role == aws_iam_role.worker_lambda.id &&
      aws_lambda_function.worker.environment[0].variables["PACKS_BUCKET"] == aws_s3_bucket.packs.bucket
    )
    error_message = "The worker may only read (HEAD) pack PDFs under packs/, to check the renderer's answer before recording its hash; it knows the packs bucket (PACKS_BUCKET)."
  }
  assert {
    condition = (
      aws_vpc_endpoint.s3.vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.s3.service_name == "com.amazonaws.af-south-1.s3" &&
      aws_vpc_endpoint.s3.private_dns_enabled &&
      length(aws_vpc_endpoint.s3.subnet_ids) == 1 &&
      length(aws_vpc_endpoint.s3.security_group_ids) == 1 &&
      can(regex("security_group_ids\\s*=\\s*\\[aws_security_group\\.vpce_s3\\.id\\]", regex("(?s)resource \"aws_vpc_endpoint\" \"s3\" \\{.*?\\n\\}", file("packs.tf")))) &&
      length(data.aws_iam_policy_document.s3_endpoint.statement) == 5 &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[0].principals).identifiers) == toset([aws_iam_role.worker_lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[1].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[1].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*.zip"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[1].principals).identifiers) == toset([aws_iam_role.lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[2].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[2].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/terrain.pmtiles"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[2].principals).identifiers) == toset([aws_iam_role.lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[3].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[3].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/water.pmtiles"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[3].principals).identifiers) == toset([aws_iam_role.lambda.arn]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[4].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.s3_endpoint.statement[4].resources) == toset(["${aws_s3_bucket.reference.arn}/reference/*"]) &&
      toset(one(data.aws_iam_policy_document.s3_endpoint.statement[4].principals).identifiers) == toset([aws_iam_role.migrate_lambda.arn])
    )
    error_message = "The worker, the API and migrate reach S3 through one interface endpoint whose policy allows only the worker's read of packs/, the API's put of a bundle (packs/*.zip), the API's reads of the delineation DEM (tiles/terrain.pmtiles) and the dam-trace water (tiles/water.pmtiles), and migrate's read of a reference file (reference/*)."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.api_pack_bundles.statement) == 1 &&
      toset(data.aws_iam_policy_document.api_pack_bundles.statement[0].actions) == toset(["s3:PutObject"]) &&
      toset(data.aws_iam_policy_document.api_pack_bundles.statement[0].resources) == toset(["${aws_s3_bucket.packs.arn}/packs/*.zip"]) &&
      aws_iam_role_policy.api_pack_bundles.role == aws_iam_role.lambda.id &&
      aws_lambda_function.backend.environment[0].variables["PACKS_BUCKET"] == aws_s3_bucket.packs.bucket
    )
    error_message = "The API may only put a pack's reproduction bundle (packs/*.zip) in the packs bucket: no read, list, delete or retention change; it knows the bucket (PACKS_BUCKET)."
  }
}

# A pack is evidence: under a year's retention is refused (positive control: run packs plans the default).
run "rejects_short_pack_retention" {
  command = plan

  variables {
    pack_retention_days = 30
  }

  expect_failures = [var.pack_retention_days]
}

# ---------------------------------------------------------------------------
# The map's data (map_data.tf, s3_cloudfront.tf; docs/deployment.md § Map
# tiles and § Reference datasets): a tiles bucket read only by CloudFront's
# /tiles/* (and, with delineation_dem, the API's read of one key), and a
# private reference bucket read only by the migrate Lambda's loads.
# ---------------------------------------------------------------------------

run "map_data" {
  command = plan

  # --- Both buckets: private, encrypted, TLS only, ACLs off, broken uploads cleaned up -------
  assert {
    condition = alltrue([for b in [aws_s3_bucket_public_access_block.tiles, aws_s3_bucket_public_access_block.reference] :
    b.block_public_acls && b.block_public_policy && b.ignore_public_acls && b.restrict_public_buckets])
    error_message = "The tiles and reference buckets must block every kind of public access (the tiles reach viewers only through CloudFront's OAC)."
  }
  assert {
    condition = alltrue([for c in [aws_s3_bucket_server_side_encryption_configuration.tiles, aws_s3_bucket_server_side_encryption_configuration.reference] :
    one([for r in c.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"])
    error_message = "The tiles and reference buckets must be encrypted at rest (SSE-S3)."
  }
  assert {
    condition = alltrue([for c in [aws_s3_bucket_ownership_controls.tiles, aws_s3_bucket_ownership_controls.reference] :
    one([for r in c.rule : r.object_ownership]) == "BucketOwnerEnforced"])
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition = alltrue([for l in [aws_s3_bucket_lifecycle_configuration.tiles, aws_s3_bucket_lifecycle_configuration.reference] :
    length(l.rule) == 1 && l.rule[0].status == "Enabled" && one(l.rule[0].abort_incomplete_multipart_upload).days_after_initiation == 7 && length(l.rule[0].expiration) == 0])
    error_message = "Each bucket aborts multipart uploads left unfinished after 7 days (a broken 2 GB upload isn't billed for ever), and expires nothing else."
  }
  assert {
    condition = (
      contains([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.sid if s.effect == "Deny"], "DenyInsecureTransport") &&
      contains([for s in data.aws_iam_policy_document.reference_bucket_policy.statement : s.sid if s.effect == "Deny"], "DenyInsecureTransport")
    )
    error_message = "The tiles and reference buckets must refuse plain-HTTP access."
  }

  # --- Tiles: CloudFront reads tiles/*, nothing else is granted in the bucket policy -----
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s if s.effect != "Deny"]) == 1 &&
      one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.sid if s.effect != "Deny"]) == "AllowCloudFrontReadTiles" &&
      toset(one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.actions if s.effect != "Deny"])) == toset(["s3:GetObject"]) &&
      toset(one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.resources if s.effect != "Deny"])) == toset(["${aws_s3_bucket.tiles.arn}/tiles/*"]) &&
      tolist(one(one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.condition if s.effect != "Deny"])).values) == tolist([aws_cloudfront_distribution.frontend.arn])
    )
    error_message = "The tiles bucket policy's only grant is this distribution's GetObject of tiles/* (no list, so a miss reveals nothing)."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.tiles.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.tiles.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.tiles.signing_protocol == "sigv4"
    )
    error_message = "The tiles OAC must sign every origin request (sigv4)."
  }

  # --- Reference: the policy names no reader; migrate's own grant is a read of reference/* --
  assert {
    condition     = length([for s in data.aws_iam_policy_document.reference_bucket_policy.statement : s if s.effect != "Deny"]) == 0
    error_message = "The reference bucket policy grants nothing: the migrate role's own policy is the only read, and CloudFront never serves it."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.migrate_reference.statement) == 1 &&
      toset(data.aws_iam_policy_document.migrate_reference.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.migrate_reference.statement[0].resources) == toset(["${aws_s3_bucket.reference.arn}/reference/*"]) &&
      aws_iam_role_policy.migrate_reference.role == aws_iam_role.migrate_lambda.id &&
      aws_lambda_function.migrate.environment[0].variables["REFERENCE_BUCKET"] == aws_s3_bucket.reference.bucket
    )
    error_message = "The migrate role may only read reference files (reference/*): no list, put or delete, and it knows the bucket (REFERENCE_BUCKET)."
  }
  assert {
    condition     = aws_lambda_function.migrate.timeout == 900 && aws_lambda_function.migrate.memory_size == var.migrate_memory_mb && var.migrate_memory_mb == 3008 && aws_lambda_function.migrate.reserved_concurrent_executions == 1 && aws_lambda_function.migrate.environment[0].variables["NODE_OPTIONS"] == "--max-old-space-size=2556"
    error_message = "The migrate Lambda runs a load for up to 900 s with 3008 MB by default (V8's heap at 85% of it), one at a time (reserved concurrency 1)."
  }

  # --- Delineation off by default: no DEM, no grant -----------------------------------------
  assert {
    condition     = !var.delineation_dem && aws_lambda_function.backend.environment[0].variables["DEM_URL"] == "" && length(aws_iam_role_policy.api_dem) == 0
    error_message = "Delineation is off by default: DEM_URL empty and the API role holds no read of the tiles bucket."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.api_dem.statement) == 1 &&
      toset(data.aws_iam_policy_document.api_dem.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.api_dem.statement[0].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/terrain.pmtiles"])
    )
    error_message = "The API's DEM grant is GetObject on the one key, tiles/terrain.pmtiles."
  }

  # --- Tracing a dam off by default: no water raster, no grant (issue #326 C2) -------------
  assert {
    condition     = !var.dam_trace_water && aws_lambda_function.backend.environment[0].variables["WATER_URL"] == "" && length(aws_iam_role_policy.api_water) == 0
    error_message = "Tracing a dam is off by default: WATER_URL empty and the API role holds no read of the water raster."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.api_water.statement) == 1 &&
      toset(data.aws_iam_policy_document.api_water.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.api_water.statement[0].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/water.pmtiles"])
    )
    error_message = "The API's water grant is GetObject on the one key, tiles/water.pmtiles."
  }
}

run "map_data_with_dam_trace" {
  command = plan

  variables {
    dam_trace_water = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["WATER_URL"] == "s3://${aws_s3_bucket.tiles.bucket}/tiles/water.pmtiles"
    error_message = "With dam_trace_water the API reads the water occurrence from the tiles bucket (s3://<bucket>/tiles/water.pmtiles)."
  }
  assert {
    condition     = length(aws_iam_role_policy.api_water) == 1 && aws_iam_role_policy.api_water[0].role == aws_iam_role.lambda.id
    error_message = "With dam_trace_water the API role gets the water read."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DEM_URL"] == "" && length(aws_iam_role_policy.api_dem) == 0
    error_message = "Tracing a dam on leaves delineation off: each switch grants its own key only."
  }
}

run "map_data_with_delineation" {
  command = plan

  variables {
    delineation_dem = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DEM_URL"] == "s3://${aws_s3_bucket.tiles.bucket}/tiles/terrain.pmtiles"
    error_message = "With delineation_dem the API reads the DEM from the tiles bucket (s3://<bucket>/tiles/terrain.pmtiles)."
  }
  assert {
    condition     = length(aws_iam_role_policy.api_dem) == 1 && aws_iam_role_policy.api_dem[0].role == aws_iam_role.lambda.id
    error_message = "With delineation_dem the API role gets the DEM read."
  }
}

# Delineation keeps a 20 s budget and peaks near 460 MB: a smaller or shorter
# API Lambda is refused (positive control: map_data_with_delineation).
# A reference load's caps were measured against 3008 MB (geo/referenceLoad.ts).
run "rejects_a_small_migrate_lambda" {
  command = plan

  variables {
    migrate_memory_mb = 1024
  }

  expect_failures = [var.migrate_memory_mb]
}

run "rejects_delineation_on_a_small_api_lambda" {
  command = plan

  variables {
    delineation_dem  = true
    lambda_memory_mb = 512
  }

  expect_failures = [aws_lambda_function.backend]
}

run "rejects_delineation_on_a_short_api_lambda" {
  command = plan

  variables {
    delineation_dem        = true
    lambda_timeout_seconds = 15
  }

  expect_failures = [aws_lambda_function.backend]
}

# A rotation's overlap: two trusted keys, the API signing with the new one.
run "report_download_key_rotation_overlap" {
  command = plan

  variables {
    report_download_public_keys = {
      "2026-09" = <<-EOT
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
        BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
        hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
        EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
        t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
        qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
        nQIDAQAB
        -----END PUBLIC KEY-----
      EOT
      "2027-03" = <<-EOT
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvJouwFdIK8ScEDRGmkzG
        gTg3bwqCaj7lyU0ws6m8vQH2NazCuQYeiuEbG4Hrq19iNaAD0UwVmf4CCWR9X7Wt
        AXJQGo9bAGhIHhQiaTo/uAarQ8usWnuXCbUdzOMfg9/SEmc2PoCz3Y40rsPysWdC
        T+zv8UJjVUog6OixnQYQYxvlWjlEP/wgyEnTTw+JkTpItcECYwj0r3k1HirCdpZs
        Zp6JCjwnHK6OVtMIhsdN+ITAHicOECRXxIjQOoCfJVd1TK/g3Y14tMx1qm2HG6g0
        wwRSyAYT7tioKZnqvzkCxh/ayuW/Ak6vVCBREqSijnM2d8gpxppx8OCPbsyBxynC
        UwIDAQAB
        -----END PUBLIC KEY-----
      EOT
    }
    report_download_signing_key = "2027-03"
  }

  assert {
    condition     = aws_cloudfront_key_group.report_downloads.items == toset(["K2026090000000A", "K2027030000000B"])
    error_message = "During a rotation the key group trusts both keys, so links signed with either verify."
  }
  assert {
    condition = (
      aws_cloudfront_public_key.report_downloads["2026-09"].id != aws_cloudfront_public_key.report_downloads["2027-03"].id &&
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_KEY_PAIR_ID"] == aws_cloudfront_public_key.report_downloads["2027-03"].id &&
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_PUBLIC_KEY"] == var.report_download_public_keys["2027-03"]
    )
    error_message = "The API signs with report_download_signing_key's key (the new one), not the other."
  }
}

run "rejects_signing_key_outside_the_trusted_keys" {
  command = plan

  variables {
    report_download_signing_key = "2027-03"
  }

  expect_failures = [var.report_download_signing_key]
}

run "rejects_a_private_key_as_a_public_key" {
  command = plan

  variables {
    report_download_public_keys = {
      "2026-09" = "-----BEGIN PRIVATE KEY-----\ntestonlynotakey\n-----END PRIVATE KEY-----"
    }
  }

  expect_failures = [var.report_download_public_keys]
}

run "rejects_no_trusted_key" {
  command = plan

  variables {
    report_download_public_keys = {}
  }

  expect_failures = [var.report_download_public_keys]
}

run "rejects_a_malformed_private_key" {
  command = plan

  variables {
    cloudfront_private_key = "REPLACE_ME"
  }

  expect_failures = [var.cloudfront_private_key]
}

run "rejects_a_public_key_as_the_private_key" {
  command = plan

  variables {
    cloudfront_private_key = <<-EOT
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
        BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
        hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
        EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
        t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
        qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
        nQIDAQAB
        -----END PUBLIC KEY-----
      EOT
  }

  expect_failures = [var.cloudfront_private_key]
}

run "reports_renderer_created_from_its_image" {
  command = plan

  variables {
    renderer_image_tag = "0.4.0-0123456789ab"
  }

  assert {
    condition = (
      aws_lambda_function.renderer[0].package_type == "Image" &&
      aws_lambda_function.renderer[0].image_uri == "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-renderer:0.4.0-0123456789ab" &&
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
      aws_lambda_function.renderer[0].environment[0].variables["REPORTS_BUCKET"] == aws_s3_bucket.reports.bucket &&
      aws_lambda_function.renderer[0].environment[0].variables["PACKS_BUCKET"] == aws_s3_bucket.packs.bucket &&
      tonumber(aws_lambda_function.renderer[0].environment[0].variables["REPORT_RENDER_TIMEOUT_MS"]) < 120000 &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "DATABASE_URL") &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "AUTH_JWT_SECRET") &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "RUNTIME_SECRET_ARN") &&
      alltrue([for k in keys(aws_lambda_function.renderer[0].environment[0].variables) : !can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$", k))])
    )
    error_message = "The renderer opens the public site, stores to the reports and packs buckets, stops before Lambda's timeout, and holds no database URL or secret."
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
# and the route still answers 200), nor is an unhandled API 500 (handleError
# logs unhandled_error and the invocation succeeds, so Lambda Errors misses
# it), the worker's self-check failures alarm like the API's, and slow-query
# logging never records bind values.
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
      alltrue([for f in aws_cloudwatch_log_metric_filter.mail_send_failed : f.pattern == "{ $.message.event = \"mail_send_failed\" }"])
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
      aws_cloudwatch_log_metric_filter.unhandled_error.log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.unhandled_error.pattern == "{ $.message.event = \"unhandled_error\" }"
    )
    error_message = "unhandled_error must be counted from the API's log group, by the exact event name handleError logs."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.unhandled_error.metric_name == aws_cloudwatch_log_metric_filter.unhandled_error.metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.unhandled_error.namespace == aws_cloudwatch_log_metric_filter.unhandled_error.metric_transformation[0].namespace
    )
    error_message = "The unhandled-error alarm must watch the metric the filter emits."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.unhandled_error.threshold == 0 &&
      aws_cloudwatch_metric_alarm.unhandled_error.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.unhandled_error.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.unhandled_error.treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.unhandled_error.alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "One unhandled 500 must page the alerts topic."
  }

  # Failed sign-ins across all accounts (issue #126): the per-address lockout
  # can't see one password sprayed over many accounts.
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.login_failed.log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.login_failed.pattern == "{ $.message.event = \"login_failed\" }"
    )
    error_message = "login_failed must be counted from the API's log group, by the exact event name logLoginFailed logs (backend/src/auth/loginFailed.ts)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.login_failed.metric_name == aws_cloudwatch_log_metric_filter.login_failed.metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.login_failed.namespace == aws_cloudwatch_log_metric_filter.login_failed.metric_transformation[0].namespace
    )
    error_message = "The login-failed alarm must watch the metric the filter emits."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.login_failed.threshold == 30 &&
      aws_cloudwatch_metric_alarm.login_failed.period == 900 &&
      aws_cloudwatch_metric_alarm.login_failed.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.login_failed.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.login_failed.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.login_failed.treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.login_failed.alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "More than 30 failed sign-ins in 15 minutes (the default) must page the alerts topic."
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
    renderer_image_tag = "0.4.0-0123456789ab"
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

# The API's per-IP limit counts /api/* only, so the SPA's files (a cold visit
# is ~150 requests; the report renderer loads them for every PDF) don't eat
# it; the site-wide backstop still caps one IP on every path (waf.tf).
run "waf_rate_rules_scope" {
  command = plan

  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].limit == 1000 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].positional_constraint == "STARTS_WITH" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].field_to_match[0].uri_path) == 1
    )
    error_message = "The API rate rule must count only paths starting /api/ (the URI path), per IP, at waf_rate_limit_per_ip."
  }
  assert {
    condition = toset([
      for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation :
      "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    error_message = "The API rate rule must match the path as the API routes it (URL_DECODE, NORMALIZE_PATH, LOWERCASE), or /%61pi/… slips past it."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).statement[0].rate_based_statement[0].limit == 5000 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).statement[0].rate_based_statement[0].scope_down_statement) == 0 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitSitePerIP"]).action[0].block) == 1
    )
    error_message = "The site-wide backstop must block per IP on every path (no scope-down) at waf_site_rate_limit_per_ip."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/auth/" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].limit == 100
    )
    error_message = "The auth rate rule stays /api/auth/ at 100 per 5 minutes."
  }
  assert {
    condition     = { for r in aws_wafv2_web_acl.frontend.rule : r.name => r.priority } == { RateLimitAuthPerIP = 0, SignInCaptchaPerIP = 1, RateLimitPerIP = 2, RateLimitSitePerIP = 3 }
    error_message = "The rate rules run tightest first: auth, API, then the site-wide backstop."
  }
}

run "rejects_site_rate_limit_below_the_api_limit" {
  command = plan

  variables {
    waf_rate_limit_per_ip      = 2000
    waf_site_rate_limit_per_ip = 1999
  }

  expect_failures = [var.waf_site_rate_limit_per_ip]
}

# ---------------------------------------------------------------------------
# The sign-in CAPTCHA (waf.tf SignInCaptchaPerIP, issue #126): only sign-in
# POSTs, only past a per-IP rate below the auth block, a 5-minute immunity,
# COUNT as the switch-off; the API key for the site's domain; and a CSP that
# allows exactly the account's two SDK origins once they are known.
# ---------------------------------------------------------------------------

run "signin_captcha" {
  command = plan

  assert {
    condition     = toset([for r in aws_wafv2_web_acl.frontend.rule : "${r.priority}:${r.name}"]) == toset(["0:RateLimitAuthPerIP", "1:SignInCaptchaPerIP", "2:RateLimitPerIP", "3:RateLimitSitePerIP"])
    error_message = "Rule order: the auth block first (an IP past 100 is blocked, not offered a billed puzzle), then the sign-in CAPTCHA, then the site-wide limit."
  }
  assert {
    condition = (
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].captcha) == 1 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].count) == 0 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].block) == 0
    )
    error_message = "By default the sign-in rule's action is CAPTCHA, never a block."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).captcha_config[0].immunity_time_property[0].immunity_time == 300
    error_message = "A solved puzzle lasts 5 minutes (captcha_config immunity_time = 300)."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].limit == 20 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].evaluation_window_sec == 300 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].limit < one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "RateLimitAuthPerIP"]).statement[0].rate_based_statement[0].limit
    )
    error_message = "The puzzle starts past 20 sign-ins per IP in 5 minutes, below the auth block's limit."
  }
  # Scope: POST and exactly /api/auth/login (decoded, normalised, lower-cased).
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[0].byte_match_statement[0].search_string == "POST" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[0].byte_match_statement[0].field_to_match[0].method) == 1 &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[0].byte_match_statement[0].positional_constraint == "EXACTLY"
    )
    error_message = "The sign-in CAPTCHA applies to POST only."
  }
  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].search_string == "/api/auth/login" &&
      one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].positional_constraint == "EXACTLY" &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].field_to_match[0].uri_path) == 1 &&
      toset([for t in one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].byte_match_statement[0].text_transformation : "${t.priority}:${t.type}"]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH", "2:LOWERCASE"])
    )
    error_message = "The sign-in CAPTCHA matches exactly the path /api/auth/login, after URL_DECODE, NORMALIZE_PATH and LOWERCASE."
  }
  assert {
    condition = (
      aws_wafv2_api_key.captcha.scope == "CLOUDFRONT" &&
      aws_wafv2_api_key.captcha.token_domains == toset([var.domain_name])
    )
    error_message = "The CAPTCHA API key is CloudFront-scoped and valid for the site's domain only."
  }
  # No integration URL yet: no WAF origin in the CSP, and no script URL for the build.
  assert {
    condition = (
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "awswaf") &&
      strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "media-src 'self' data:") &&
      output.waf_captcha_script_url == ""
    )
    error_message = "Without waf_captcha_integration_url the CSP names no WAF origin (media-src allows data: for the puzzle's audio) and the build gets no script URL."
  }
}

run "signin_captcha_with_integration_url" {
  command = plan

  variables {
    waf_captcha_integration_url = "https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com/a1b2c3d4e5f6/"
  }

  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "script-src 'self' 'unsafe-inline' https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com https://a1b2c3d4e5f6.edge.sdk.awswaf.com;")
    error_message = "script-src allows exactly the CAPTCHA SDK origin and its challenge script's."
  }
  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "connect-src 'self' https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com https://a1b2c3d4e5f6.edge.sdk.awswaf.com;")
    error_message = "connect-src allows exactly the same two origins (the puzzle, verify and telemetry calls)."
  }
  assert {
    condition = (
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "*") &&
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval") &&
      !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "blob:") &&
      length(regexall("https://", aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy)) == 4
    )
    error_message = "The CAPTCHA adds exactly two origins to two directives: no wildcard, no unsafe-eval, no blob:."
  }
  assert {
    condition     = output.waf_captcha_script_url == "https://a1b2c3d4e5f6.edge.captcha-sdk.awswaf.com/a1b2c3d4e5f6/jsapi.js"
    error_message = "The build's script URL is the integration URL's jsapi.js."
  }
}

run "signin_captcha_count_mode" {
  command = plan

  variables {
    waf_signin_captcha_action = "COUNT"
  }

  assert {
    condition = (
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].count) == 1 &&
      length(one([for r in aws_wafv2_web_acl.frontend.rule : r if r.name == "SignInCaptchaPerIP"]).action[0].captcha) == 0
    )
    error_message = "COUNT switches the puzzle off and keeps the rule counting."
  }
}

run "rejects_signin_captcha_at_the_block_limit" {
  command = plan
  variables {
    waf_signin_captcha_per_5min = 100
  }
  expect_failures = [var.waf_signin_captcha_per_5min]
}

run "rejects_signin_captcha_below_aws_minimum" {
  command = plan
  variables {
    waf_signin_captcha_per_5min = 9
  }
  expect_failures = [var.waf_signin_captcha_per_5min]
}

run "rejects_unknown_signin_captcha_action" {
  command = plan
  variables {
    waf_signin_captcha_action = "BLOCK"
  }
  expect_failures = [var.waf_signin_captcha_action]
}

run "rejects_a_wildcard_captcha_integration_url" {
  command = plan
  variables {
    waf_captcha_integration_url = "https://*.awswaf.com/"
  }
  expect_failures = [var.waf_captcha_integration_url]
}

# ---------------------------------------------------------------------------
# Network: the private-only VPC and the security-group graph (network.tf)
# ---------------------------------------------------------------------------
#
# Terraform tests can't enumerate "every resource of a type", so the
# whole-module invariants (no gateway or default route anywhere, the complete
# set of security-group rules) read the source, like the parameter group's
# lifecycle check in production_guardrails; the plan-time asserts pin the
# same edges by resolved ID. `terraform test` refuses an assert that names no
# configuration object, so each source-reading one is anchored to the VPC it
# describes with `aws_vpc.main.cidr_block != ""`.

run "network" {
  command = plan

  # --- No way out: no gateway, no default route, no public addresses -------
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("resource \"aws_(internet_gateway|egress_only_internet_gateway|nat_gateway|eip|route|vpn_gateway|vpc_peering_connection|ec2_transit_gateway_vpc_attachment)\"", file(f))) == 0
    ])
    error_message = "The VPC is private-only: no internet, egress-only or NAT gateway, Elastic IP, aws_route, VPN, peering or transit attachment. External hosts are reached by a Lambda outside the VPC (feeds.tf), AWS APIs through interface endpoints."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("\"(0\\.0\\.0\\.0/0|::/0)\"", file(f))) == 0
    ])
    error_message = "No 0.0.0.0/0 or ::/0 anywhere in the module: not as a route, not in a security-group rule."
  }
  assert {
    condition     = aws_vpc.main.cidr_block != "" && length(regexall("\\broute\\s*\\{", regex("(?s)resource \"aws_route_table\" \"private\" \\{.*?\\n\\}", file("network.tf")))) == 0
    error_message = "The private route table holds only the implicit local route (no inline route blocks)."
  }
  assert {
    condition     = length(aws_route_table_association.private) == 2 && alltrue([for a in aws_route_table_association.private : a.route_table_id == aws_route_table.private.id])
    error_message = "Both private subnets must be explicitly associated with the route-less private route table."
  }
  assert {
    condition     = alltrue([for s in aws_subnet.private : s.map_public_ip_on_launch != true])
    error_message = "The private subnets never hand out public IPs (map_public_ip_on_launch unset or false)."
  }

  # --- Security-group rules: SG to SG only, the exact graph ------------------
  # Every rule references another security group (no CIDR, no prefix list),
  # rules are standalone resources (no aws_security_group_rule, no inline
  # blocks), and the full set of edges is exactly this.
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("\\b(cidr_ipv4|cidr_ipv6|cidr_blocks|ipv6_cidr_blocks|prefix_list_id|prefix_list_ids)\\s*=", file(f))) == 0
      && length(regexall("resource \"aws_security_group_rule\"", file(f))) == 0
      && length(regexall("(?m)^\\s*(ingress|egress)\\s*\\{", file(f))) == 0
    ])
    error_message = "Security-group rules reference security groups only (no CIDR or prefix list) and are aws_vpc_security_group_{ingress,egress}_rule resources, never inline blocks or aws_security_group_rule."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && toset(flatten([
      for f in fileset(".", "*.tf") : [
        for b in regexall("(?s)resource \"aws_vpc_security_group_ingress_rule\" \"[A-Za-z0-9_-]+\" \\{.*?\\n\\}", file(f)) :
        format("%s <- %s %s/%s-%s",
          try(regex("\\n\\s*security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)\\.id", b)[0], "?"),
          try(regex("\\n\\s*referenced_security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)\\.id", b)[0], "NOT-A-SECURITY-GROUP"),
          try(regex("\\n\\s*ip_protocol\\s*=\\s*\"([^\"]+)\"", b)[0], "?"),
          try(regex("\\n\\s*from_port\\s*=\\s*([0-9]+)", b)[0], "?"),
          try(regex("\\n\\s*to_port\\s*=\\s*([0-9]+)", b)[0], "?"),
        )
      ]
      ])) == toset([
      "rds <- api_lambda tcp/5432-5432",
      "rds <- migrate_lambda tcp/5432-5432",
      "rds <- worker_lambda tcp/5432-5432",
      "vpce <- api_lambda tcp/443-443",
      "vpce <- migrate_lambda tcp/443-443",
      "vpce <- worker_lambda tcp/443-443",
      "vpce_sqs <- api_lambda tcp/443-443",
      "vpce_sqs <- worker_lambda tcp/443-443",
      "vpce_ses <- api_lambda tcp/443-443",
      "vpce_ses <- worker_lambda tcp/443-443",
      "vpce_s3 <- worker_lambda tcp/443-443",
      "vpce_s3 <- api_lambda tcp/443-443",
      "vpce_s3 <- migrate_lambda tcp/443-443",
    ])
    error_message = "Ingress rules must be exactly: Postgres from the API, migrate and worker Lambdas; Secrets Manager endpoint from migrate; SQS and SES endpoints from the API and worker; the S3 endpoint from the worker (pack PDF checks, packs.tf), the API and migrate (reference loads, map_data.tf). A new edge is a deliberate change to this list."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && toset(flatten([
      for f in fileset(".", "*.tf") : [
        for b in regexall("(?s)resource \"aws_vpc_security_group_egress_rule\" \"[A-Za-z0-9_-]+\" \\{.*?\\n\\}", file(f)) :
        format("%s -> %s %s/%s-%s",
          try(regex("\\n\\s*security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)\\.id", b)[0], "?"),
          try(regex("\\n\\s*referenced_security_group_id\\s*=\\s*aws_security_group\\.([A-Za-z0-9_-]+)\\.id", b)[0], "NOT-A-SECURITY-GROUP"),
          try(regex("\\n\\s*ip_protocol\\s*=\\s*\"([^\"]+)\"", b)[0], "?"),
          try(regex("\\n\\s*from_port\\s*=\\s*([0-9]+)", b)[0], "?"),
          try(regex("\\n\\s*to_port\\s*=\\s*([0-9]+)", b)[0], "?"),
        )
      ]
      ])) == toset([
      "api_lambda -> rds tcp/5432-5432",
      "api_lambda -> vpce_sqs tcp/443-443",
      "api_lambda -> vpce_ses tcp/443-443",
      "api_lambda -> vpce tcp/443-443",
      "migrate_lambda -> rds tcp/5432-5432",
      "migrate_lambda -> vpce tcp/443-443",
      "worker_lambda -> rds tcp/5432-5432",
      "worker_lambda -> vpce_sqs tcp/443-443",
      "worker_lambda -> vpce_ses tcp/443-443",
      "worker_lambda -> vpce tcp/443-443",
      "worker_lambda -> vpce_s3 tcp/443-443",
      "api_lambda -> vpce_s3 tcp/443-443",
      "migrate_lambda -> vpce_s3 tcp/443-443",
    ])
    error_message = "Egress rules must be exactly the Lambdas' paths to Postgres and their endpoints; RDS and the endpoints have no egress."
  }

  # --- The database: only the three in-VPC Lambdas reach it ---------------
  assert {
    condition     = aws_db_instance.main.vpc_security_group_ids == toset([aws_security_group.rds.id]) && !aws_db_instance.main.publicly_accessible
    error_message = "RDS sits in its own security group only, and is not publicly accessible."
  }
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.rds_from_api.security_group_id == aws_security_group.rds.id &&
      aws_vpc_security_group_ingress_rule.rds_from_api.referenced_security_group_id == aws_security_group.api_lambda.id &&
      aws_vpc_security_group_ingress_rule.rds_from_migrate.security_group_id == aws_security_group.rds.id &&
      aws_vpc_security_group_ingress_rule.rds_from_migrate.referenced_security_group_id == aws_security_group.migrate_lambda.id &&
      aws_vpc_security_group_ingress_rule.rds_from_worker.security_group_id == aws_security_group.rds.id &&
      aws_vpc_security_group_ingress_rule.rds_from_worker.referenced_security_group_id == aws_security_group.worker_lambda.id &&
      alltrue([for r in [aws_vpc_security_group_ingress_rule.rds_from_api, aws_vpc_security_group_ingress_rule.rds_from_migrate, aws_vpc_security_group_ingress_rule.rds_from_worker] : r.ip_protocol == "tcp" && r.from_port == 5432 && r.to_port == 5432 && r.cidr_ipv4 == null && r.cidr_ipv6 == null])
    )
    error_message = "Postgres (5432/tcp) is reachable from the API, migrate and worker Lambda security groups only."
  }
  assert {
    condition = (
      aws_lambda_function.backend.vpc_config[0].security_group_ids == toset([aws_security_group.api_lambda.id]) &&
      aws_lambda_function.migrate.vpc_config[0].security_group_ids == toset([aws_security_group.migrate_lambda.id]) &&
      aws_lambda_function.worker.vpc_config[0].security_group_ids == toset([aws_security_group.worker_lambda.id]) &&
      length(aws_lambda_function.fetcher.vpc_config) == 0
    )
    error_message = "The API, migrate and worker Lambdas each run in their own security group; the fetcher stays outside the VPC (the renderer's no-VPC pin is in its own run)."
  }

  # --- The Function URL ------------------------------------------------------
  # NONE, with the CloudFront shared secret checked first in the app
  # (backend/src/app.ts) and InvokeFunction allowed only via the URL. Moving
  # to AWS_IAM means CloudFront OAC for Lambda plus a body-hash change in the
  # SPA; either way, a deliberate edit here.
  assert {
    condition = (
      aws_lambda_function_url.backend.authorization_type == "NONE" &&
      aws_lambda_permission.function_url_public.function_url_auth_type == "NONE" &&
      aws_lambda_permission.function_url_invoke.action == "lambda:InvokeFunction" &&
      aws_lambda_permission.function_url_invoke.invoked_via_function_url == true
    )
    error_message = "The Function URL is authorization_type NONE (shared secret in the app), and the public InvokeFunction permission is restricted to invocations via the URL."
  }

  # --- Security-group descriptions, verbatim -------------------------------
  # A description can't change in place: AWS replaces the group, and deleting
  # one a Lambda ENI still holds can stall an apply for 20+ minutes. Pinning
  # the text makes any edit a deliberate change here, made knowing that.
  assert {
    condition = {
      api_lambda     = aws_security_group.api_lambda.description
      migrate_lambda = aws_security_group.migrate_lambda.description
      worker_lambda  = aws_security_group.worker_lambda.description
      rds            = aws_security_group.rds.description
      vpce           = aws_security_group.vpce.description
      vpce_sqs       = aws_security_group.vpce_sqs.description
      vpce_ses       = aws_security_group.vpce_ses.description
      vpce_s3        = aws_security_group.vpce_s3.description
      } == {
      api_lambda     = "API Lambda ENIs: egress to Postgres and the SQS, SES, S3 and Secrets Manager endpoints only."
      migrate_lambda = "Migrate Lambda ENIs: egress to Postgres and the Secrets Manager and S3 endpoints only."
      worker_lambda  = "Worker Lambda ENIs: egress to Postgres and the SQS, SES, S3 and Secrets Manager endpoints only."
      rds            = "RDS Postgres: ingress 5432 from the API, migrate and worker Lambda SGs only; no egress."
      vpce           = "Secrets Manager interface endpoint: 443 from the migrate, API and worker Lambdas only."
      vpce_sqs       = "SQS interface endpoint: 443 from the API and worker Lambdas only."
      vpce_ses       = "SES API interface endpoint: 443 from the API and worker Lambdas only."
      vpce_s3        = "S3 interface endpoint: 443 from the API, worker and migrate Lambdas only."
    }
    error_message = "A security-group description changed. That replaces the group on the next apply (see the comment above); update this pin only if you mean it."
  }
  assert {
    condition = aws_vpc.main.cidr_block != "" && alltrue([
      for f in fileset(".", "*.tf") :
      length(regexall("resource \"aws_security_group\"", file(f))) == length(regexall("resource \"aws_security_group\" \"(api_lambda|migrate_lambda|worker_lambda|rds|vpce|vpce_sqs|vpce_ses|vpce_s3)\"", file(f)))
    ])
    error_message = "A new security group needs its description pinned in the assert above."
  }
  assert {
    condition = alltrue([
      for d in [
        aws_security_group.api_lambda.description, aws_security_group.migrate_lambda.description,
        aws_security_group.worker_lambda.description, aws_security_group.rds.description,
        aws_security_group.vpce.description, aws_security_group.vpce_sqs.description,
        aws_security_group.vpce_ses.description, aws_security_group.vpce_s3.description,
      ] : length(d) <= 255 && can(regex("^[a-zA-Z0-9. _:/()#,@\\[\\]+=&;{}!$*-]+$", d))
    ])
    error_message = "Security-group descriptions are limited to 255 characters of a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* (no apostrophes, no em dashes), or AWS rejects the create."
  }
}
