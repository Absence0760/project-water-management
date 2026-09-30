# Plan-only IAM tests (issue #126 § IAM), against the same mocked providers as
# guardrails.tftest.hcl (the mocks, overrides and variables below are copied
# from it: a test file can't share them). A mocked aws_iam_policy_document
# renders a fixed JSON, so every assertion reads the data source's
# `statement` inputs, never its `json`.
#
# Pinned here: each Lambda role's logs policy (its own log group, no
# CreateLogGroup, no AWS-managed policy), the VPC Lambdas' ENI policy, the
# SQS endpoint's send-only policy, the renderer's image pull (repository
# policy + execution-role grant) and what the deploy role may do to that
# repository, the deploy role's frontend-bucket actions, the migrate role's
# policy, the Secrets Manager endpoint's actions and the alert topics'
# policies.
#
# Assertions reach statements as `data.<doc>.statement` (a literal key for a
# for_each document), never by iterating the data source object itself:
# Terraform 1.15 panics rendering a *failed* assertion whose expression holds
# a whole aws_iam_policy_document ("value has marks, so it cannot be
# serialized as JSON"), and the crash orphans the provider processes.
#
#   pnpm check:infra          (bin/check-infra.sh: fmt + validate + test)

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

# Evidence pack PDFs (packs.tf, 116_pack_render)
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

# ---------------------------------------------------------------------------
# Logs: each role writes to its own log group only (iam.tf)
# ---------------------------------------------------------------------------

run "lambda_logs_scoped" {
  command = plan

  assert {
    condition     = toset(keys(aws_iam_role_policy.lambda_logs)) == toset(["api", "migrate", "worker", "fetcher", "renderer"])
    error_message = "Every Lambda role (API, migrate, worker, fetcher, renderer) gets its own logs policy."
  }
  assert {
    condition = (
      aws_iam_role_policy.lambda_logs["api"].role == aws_iam_role.lambda.id &&
      aws_iam_role_policy.lambda_logs["migrate"].role == aws_iam_role.migrate_lambda.id &&
      aws_iam_role_policy.lambda_logs["worker"].role == aws_iam_role.worker_lambda.id &&
      aws_iam_role_policy.lambda_logs["fetcher"].role == aws_iam_role.fetcher_lambda.id &&
      aws_iam_role_policy.lambda_logs["renderer"].role == aws_iam_role.renderer_lambda.id
    )
    error_message = "Each logs policy is attached to its own Lambda's role."
  }
  # The literal ARNs: a positive control that the scoping names the real
  # groups (and each its own), not something that merely looks scoped.
  assert {
    condition = {
      api      = one(data.aws_iam_policy_document.lambda_logs["api"].statement).resources
      migrate  = one(data.aws_iam_policy_document.lambda_logs["migrate"].statement).resources
      worker   = one(data.aws_iam_policy_document.lambda_logs["worker"].statement).resources
      fetcher  = one(data.aws_iam_policy_document.lambda_logs["fetcher"].statement).resources
      renderer = one(data.aws_iam_policy_document.lambda_logs["renderer"].statement).resources
      } == {
      api      = toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/water-management-backend:*"])
      migrate  = toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/water-management-migrate:*"])
      worker   = toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/water-management-worker:*"])
      fetcher  = toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/water-management-fetcher:*"])
      renderer = toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/water-management-renderer:*"])
    }
    error_message = "Each role may write only to /aws/lambda/<its own function> (its streams, :*)."
  }
  assert {
    condition = (
      one(data.aws_iam_policy_document.lambda_logs["api"].statement).resources == toset(["arn:aws:logs:af-south-1:000000000000:log-group:${aws_cloudwatch_log_group.lambda.name}:*"]) &&
      one(data.aws_iam_policy_document.lambda_logs["migrate"].statement).resources == toset(["arn:aws:logs:af-south-1:000000000000:log-group:${aws_cloudwatch_log_group.migrate.name}:*"]) &&
      one(data.aws_iam_policy_document.lambda_logs["worker"].statement).resources == toset(["arn:aws:logs:af-south-1:000000000000:log-group:${aws_cloudwatch_log_group.worker.name}:*"]) &&
      one(data.aws_iam_policy_document.lambda_logs["fetcher"].statement).resources == toset(["arn:aws:logs:af-south-1:000000000000:log-group:${aws_cloudwatch_log_group.fetcher.name}:*"]) &&
      one(data.aws_iam_policy_document.lambda_logs["renderer"].statement).resources == toset(["arn:aws:logs:af-south-1:000000000000:log-group:${aws_cloudwatch_log_group.renderer.name}:*"])
    )
    error_message = "The ARNs follow the Terraform-managed log groups (a renamed group must move its grant)."
  }
  assert {
    condition = alltrue([for st in [
      data.aws_iam_policy_document.lambda_logs["api"].statement,
      data.aws_iam_policy_document.lambda_logs["migrate"].statement,
      data.aws_iam_policy_document.lambda_logs["worker"].statement,
      data.aws_iam_policy_document.lambda_logs["fetcher"].statement,
      data.aws_iam_policy_document.lambda_logs["renderer"].statement,
      ] : length(st) == 1 && one(st).actions == toset(["logs:CreateLogStream", "logs:PutLogEvents"]) && one(st).effect != "Deny"
    ])
    error_message = "A logs policy creates streams and puts events, nothing else: no logs:CreateLogGroup (Terraform owns every group)."
  }
  # No other policy a Lambda role carries touches CloudWatch Logs.
  assert {
    condition = alltrue(flatten([
      for st in [
        data.aws_iam_policy_document.lambda_vpc_eni["api"].statement,
        data.aws_iam_policy_document.lambda_vpc_eni["migrate"].statement,
        data.aws_iam_policy_document.lambda_vpc_eni["worker"].statement,
        data.aws_iam_policy_document.runtime_secret["api"].statement,
        data.aws_iam_policy_document.runtime_secret["worker"].statement,
        data.aws_iam_policy_document.runtime_secret["migrate"].statement,
        data.aws_iam_policy_document.migrate_lambda.statement,
        data.aws_iam_policy_document.worker_lambda.statement,
        data.aws_iam_policy_document.lambda_jobs_send.statement,
        data.aws_iam_policy_document.fetcher_lambda.statement,
        data.aws_iam_policy_document.worker_feeds.statement,
        data.aws_iam_policy_document.renderer_lambda.statement,
        data.aws_iam_policy_document.renderer_packs.statement,
        data.aws_iam_policy_document.renderer_ecr_pull.statement,
        data.aws_iam_policy_document.worker_reports.statement,
        data.aws_iam_policy_document.lambda_ses.statement,
        data.aws_iam_policy_document.lambda_ses_release.statement,
        data.aws_iam_policy_document.worker_mail_events.statement,
        ] : [
        for s in st : [for a in s.actions : !startswith(a, "logs:")]
      ]
    ]))
    error_message = "Only the per-role logs policy may grant CloudWatch Logs actions."
  }
}

# ---------------------------------------------------------------------------
# VPC ENIs: the three VPC Lambdas only, never callable from their own code
# ---------------------------------------------------------------------------

run "lambda_vpc_eni" {
  command = plan

  assert {
    condition     = toset(keys(aws_iam_role_policy.lambda_vpc_eni)) == toset(["api", "migrate", "worker"])
    error_message = "Only the VPC Lambdas (API, migrate, worker) get the ENI policy; the fetcher and renderer run outside the VPC."
  }
  assert {
    condition = (
      length(aws_lambda_function.backend.vpc_config) == 1 &&
      length(aws_lambda_function.migrate.vpc_config) == 1 &&
      length(aws_lambda_function.worker.vpc_config) == 1 &&
      length(aws_lambda_function.fetcher.vpc_config) == 0
    )
    error_message = "The ENI policy's keys must match the Lambdas that actually sit in the VPC."
  }
  assert {
    condition = (
      aws_iam_role_policy.lambda_vpc_eni["api"].role == aws_iam_role.lambda.id &&
      aws_iam_role_policy.lambda_vpc_eni["migrate"].role == aws_iam_role.migrate_lambda.id &&
      aws_iam_role_policy.lambda_vpc_eni["worker"].role == aws_iam_role.worker_lambda.id
    )
    error_message = "Each ENI policy is attached to its own Lambda's role."
  }
  assert {
    condition = alltrue([for st in [
      data.aws_iam_policy_document.lambda_vpc_eni["api"].statement,
      data.aws_iam_policy_document.lambda_vpc_eni["migrate"].statement,
      data.aws_iam_policy_document.lambda_vpc_eni["worker"].statement,
      ] :
      length([for s in st : s if s.effect != "Deny"]) == 1 &&
      one([for s in st : s.actions if s.effect != "Deny"]) == toset([
        "ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets",
        "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses",
      ])
    ])
    error_message = "The allow is exactly the six EC2 actions AWS lists for a VPC Lambda (configuration-vpc.html)."
  }
  # The deny names the function itself: its ARN as Terraform builds it must
  # match the function's (the overrides pin the real ARN shape).
  assert {
    condition = (
      one(one([for s in data.aws_iam_policy_document.lambda_vpc_eni["api"].statement : s if s.effect == "Deny"]).condition).values == tolist([aws_lambda_function.backend.arn]) &&
      one(one([for s in data.aws_iam_policy_document.lambda_vpc_eni["migrate"].statement : s if s.effect == "Deny"]).condition).values == tolist([aws_lambda_function.migrate.arn]) &&
      one(one([for s in data.aws_iam_policy_document.lambda_vpc_eni["worker"].statement : s if s.effect == "Deny"]).condition).values == tolist([aws_lambda_function.worker.arn])
    )
    error_message = "Each role denies the ENI calls to its own function's code (lambda:SourceFunctionArn = that function)."
  }
  assert {
    condition = alltrue([for st in [
      data.aws_iam_policy_document.lambda_vpc_eni["api"].statement,
      data.aws_iam_policy_document.lambda_vpc_eni["migrate"].statement,
      data.aws_iam_policy_document.lambda_vpc_eni["worker"].statement,
      ] :
      one([for s in st : s if s.effect == "Deny"]).resources == toset(["*"]) &&
      one(one([for s in st : s if s.effect == "Deny"]).condition).test == "ArnEquals" &&
      one(one([for s in st : s if s.effect == "Deny"]).condition).variable == "lambda:SourceFunctionArn" &&
      length(setsubtract(one([for s in st : s.actions if s.effect != "Deny"]), one([for s in st : s.actions if s.effect == "Deny"]))) == 0
    ])
    error_message = "The deny covers every allowed ENI action, on *, and only for calls made by the function's code."
  }
}

# ---------------------------------------------------------------------------
# SQS endpoint: SendMessage only, from the roles whose code sends
# ---------------------------------------------------------------------------

run "sqs_endpoint_send_only" {
  command = plan

  assert {
    condition = {
      for s in data.aws_iam_policy_document.sqs_endpoint.statement :
      s.sid => { principal = one(one(s.principals).identifiers), queue = one(s.resources), actions = s.actions }
      } == {
      ApiSendsWakeUps           = { principal = aws_iam_role.lambda.arn, queue = aws_sqs_queue.jobs.arn, actions = toset(["sqs:SendMessage"]) }
      WorkerSendsRenderRequests = { principal = aws_iam_role.worker_lambda.arn, queue = aws_sqs_queue.render_requests.arn, actions = toset(["sqs:SendMessage"]) }
      WorkerSendsFetchRequests  = { principal = aws_iam_role.worker_lambda.arn, queue = aws_sqs_queue.fetch_requests.arn, actions = toset(["sqs:SendMessage"]) }
    }
    error_message = "The SQS endpoint allows SendMessage only: the API to jobs, the worker to render-requests and fetch-requests. Nothing receives or deletes through it."
  }
  # The consumed queues are read by event source mappings (outside the
  # endpoint): the positive control that dropping receive here loses nothing.
  assert {
    condition = (
      aws_lambda_event_source_mapping.worker_jobs.event_source_arn == aws_sqs_queue.jobs.arn &&
      aws_lambda_event_source_mapping.worker_ingest_results.event_source_arn == aws_sqs_queue.ingest_results.arn &&
      aws_lambda_event_source_mapping.worker_render_results.event_source_arn == aws_sqs_queue.render_results.arn &&
      aws_lambda_event_source_mapping.worker_mail_events.event_source_arn == aws_sqs_queue.mail_events.arn
    )
    error_message = "Every queue the worker consumes has its event source mapping."
  }
  # Only the API wakes the worker (jobs/wake.ts, called from routes only).
  assert {
    condition     = length([for s in data.aws_iam_policy_document.worker_lambda.statement : s if contains(s.actions, "sqs:SendMessage")]) == 0
    error_message = "The worker's role may not send to the jobs queue: no worker code path wakes the worker."
  }
  assert {
    condition = (
      one(data.aws_iam_policy_document.worker_lambda.statement).actions == toset(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]) &&
      one(data.aws_iam_policy_document.lambda_jobs_send.statement).actions == toset(["sqs:SendMessage"])
    )
    error_message = "The worker's role consumes the jobs queue (its event source mapping polls as the role); the API's sends to it."
  }
}

# ---------------------------------------------------------------------------
# The renderer's image: pulled with the execution role's own grant, and a
# repository policy Lambda has no reason to rewrite
# ---------------------------------------------------------------------------

run "renderer_ecr" {
  command = plan

  assert {
    condition = (
      length(data.aws_iam_policy_document.renderer_ecr.statement) == 1 &&
      one(data.aws_iam_policy_document.renderer_ecr.statement).sid == "LambdaECRImageRetrievalPolicy" &&
      one(data.aws_iam_policy_document.renderer_ecr.statement).effect != "Deny" &&
      one(data.aws_iam_policy_document.renderer_ecr.statement).actions == toset(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"])
    )
    error_message = "The repository policy is the one pull statement Lambda looks for (AWS's Sid, the two pull actions), nothing more."
  }
  assert {
    condition = (
      one(one(data.aws_iam_policy_document.renderer_ecr.statement).principals).type == "Service" &&
      one(one(data.aws_iam_policy_document.renderer_ecr.statement).principals).identifiers == toset(["lambda.amazonaws.com"]) &&
      one(one(data.aws_iam_policy_document.renderer_ecr.statement).condition).variable == "aws:sourceArn" &&
      one(one(data.aws_iam_policy_document.renderer_ecr.statement).condition).values == tolist(["arn:aws:lambda:af-south-1:000000000000:function:water-management-renderer"])
    )
    error_message = "Only the Lambda service may pull, and only for the renderer function (aws:sourceArn)."
  }
  assert {
    condition     = aws_ecr_repository_policy.renderer.repository == aws_ecr_repository.renderer.name
    error_message = "The pull statement is on the renderer's repository."
  }
  assert {
    condition = (
      aws_iam_role_policy.renderer_ecr_pull.role == aws_iam_role.renderer_lambda.id &&
      length(data.aws_iam_policy_document.renderer_ecr_pull.statement) == 1 &&
      one(data.aws_iam_policy_document.renderer_ecr_pull.statement).actions == toset(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) &&
      one(data.aws_iam_policy_document.renderer_ecr_pull.statement).resources == toset([aws_ecr_repository.renderer.arn])
    )
    error_message = "The renderer's role may pull from its own repository (same account: that grant alone suffices), nothing else in ECR."
  }
  # The deploy role never rewrites the repository policy; it may read it for
  # Lambda's check on UpdateFunctionCode.
  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for a in s.actions : !contains(["ecr:SetRepositoryPolicy", "ecr:DeleteRepositoryPolicy"], a)
    ]]))
    error_message = "The deploy role must not hold ecr:SetRepositoryPolicy or DeleteRepositoryPolicy."
  }
  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid == "RendererImageLambdaCheck" && s.actions == toset(["ecr:GetRepositoryPolicy"]) && s.resources == toset([aws_ecr_repository.renderer.arn])
    ])
    error_message = "The deploy role reads the renderer repository's policy (and only that repository's)."
  }
  assert {
    condition = alltrue(flatten([for st in [data.aws_iam_policy_document.renderer_lambda.statement, data.aws_iam_policy_document.renderer_ecr_pull.statement, data.aws_iam_policy_document.github_deploy.statement] : [
      for s in st : [for a in s.actions : !contains(["ecr:SetRepositoryPolicy", "ecr:GetAuthorizationToken"], a) if s.sid != "EcrLogin"]
    ]]))
    error_message = "Neither the renderer nor the deploy role (outside its docker login) holds repository-policy writes or registry logins."
  }
}

# ---------------------------------------------------------------------------
# The deploy role's frontend bucket actions
# ---------------------------------------------------------------------------

run "deploy_frontend_bucket" {
  command = plan

  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid == "FrontendBucketWrite" && s.actions == toset(["s3:PutObject", "s3:DeleteObject"]) && s.resources == toset(["${aws_s3_bucket.frontend.arn}/*"])
    ])
    error_message = "The frontend deploy (aws s3 sync local → bucket, --delete) puts and deletes objects; it never reads one."
  }
  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for a in s.actions : a != "s3:GetObject"
    ]]))
    error_message = "The deploy role has no s3:GetObject."
  }
  assert {
    condition = alltrue(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : [
      for a in s.actions : !startswith(a, "kms:")
    ]]))
    error_message = "This repo's deploy policy grants no KMS action (the baseline's sops-key grant is tracked upstream: docs/upstream/templates-baseline-sops-deploy-grant.md)."
  }
}

# ---------------------------------------------------------------------------
# The migrate role, the Secrets Manager endpoint, the alert topics
# ---------------------------------------------------------------------------

run "migrate_role_policy" {
  command = plan

  assert {
    condition = (
      aws_iam_role_policy.migrate_lambda.role == aws_iam_role.migrate_lambda.id &&
      length(data.aws_iam_policy_document.migrate_lambda.statement) == 1 &&
      one(data.aws_iam_policy_document.migrate_lambda.statement).sid == "ReadRdsMasterSecret" &&
      one(data.aws_iam_policy_document.migrate_lambda.statement).effect != "Deny" &&
      one(data.aws_iam_policy_document.migrate_lambda.statement).actions == toset(["secretsmanager:GetSecretValue"]) &&
      one(data.aws_iam_policy_document.migrate_lambda.statement).resources == toset([aws_db_instance.main.master_user_secret[0].secret_arn])
    )
    error_message = "The migrate role's own policy is one statement: GetSecretValue on the RDS master secret."
  }
  assert {
    condition     = aws_lambda_function.migrate.role == aws_iam_role.migrate_lambda.arn && aws_iam_role.migrate_lambda.assume_role_policy == data.aws_iam_policy_document.lambda_assume_role.json
    error_message = "The migrate Lambda runs as its own role, assumable by Lambda."
  }
  assert {
    condition = (
      one(data.aws_iam_policy_document.lambda_assume_role.statement).actions == toset(["sts:AssumeRole"]) &&
      one(one(data.aws_iam_policy_document.lambda_assume_role.statement).principals).identifiers == toset(["lambda.amazonaws.com"])
    )
    error_message = "The Lambda roles trust the Lambda service only."
  }
}

run "secretsmanager_endpoint_policy" {
  command = plan

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement :
      s.actions == toset(["secretsmanager:GetSecretValue"]) && s.effect != "Deny" && one(s.principals).type == "AWS"
    ])
    error_message = "The Secrets Manager endpoint allows GetSecretValue only (the one call the code makes, config/secretsManager.ts), to named roles."
  }
  assert {
    condition = toset([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement : s.sid]) == toset([
      "ReadRdsMasterSecretOnly", "ReadRuntimeSecretApi", "ReadRuntimeSecretWorker", "ReadRuntimeSecretMigrate",
    ])
    error_message = "One statement for the RDS master secret and one per runtime secret."
  }
  assert {
    condition     = aws_vpc_endpoint.secretsmanager.service_name == "com.amazonaws.af-south-1.secretsmanager" && aws_vpc_endpoint.secretsmanager.private_dns_enabled
    error_message = "The policy guards the private-DNS Secrets Manager endpoint."
  }
}

run "alert_topic_policies" {
  command = plan

  assert {
    condition = (
      aws_sns_topic_policy.alerts.arn == aws_sns_topic.alerts.arn &&
      length(data.aws_iam_policy_document.alerts_publish.statement) == 3 &&
      alltrue([for s in data.aws_iam_policy_document.alerts_publish.statement :
        s.actions == toset(["sns:Publish"]) && s.resources == toset([aws_sns_topic.alerts.arn]) && one(s.principals).type == "Service" && s.effect != "Deny"
      ])
    )
    error_message = "The regional topic's policy is on that topic: Publish on it, by service principals only (CloudWatch alarms, RDS events and the KMS key alarm's EventBridge rule)."
  }
  assert {
    condition = (
      aws_sns_topic_policy.alerts_us_east_1.arn == aws_sns_topic.alerts_us_east_1.arn &&
      length(data.aws_iam_policy_document.alerts_us_east_1_publish.statement) == 3 &&
      alltrue([for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement :
        s.actions == toset(["sns:Publish"]) && s.resources == toset([aws_sns_topic.alerts_us_east_1.arn]) && one(s.principals).type == "Service" && s.effect != "Deny"
      ])
    )
    error_message = "The us-east-1 topic's policy is on that topic: Publish on it, by service principals only."
  }
  # Every statement on either topic is pinned to this account (confused deputy).
  assert {
    condition = alltrue([for s in concat(data.aws_iam_policy_document.alerts_publish.statement, data.aws_iam_policy_document.alerts_us_east_1_publish.statement) :
      anytrue([for c in s.condition : c.test == "StringEquals" && c.variable == "aws:SourceAccount" && c.values == tolist(["000000000000"])])
    ])
    error_message = "Every publish statement on the alert topics carries aws:SourceAccount = this account."
  }
  assert {
    condition     = toset([for s in concat(data.aws_iam_policy_document.alerts_publish.statement, data.aws_iam_policy_document.alerts_us_east_1_publish.statement) : one(one(s.principals).identifiers)]) == toset(["cloudwatch.amazonaws.com", "events.rds.amazonaws.com", "events.amazonaws.com", "budgets.amazonaws.com", "costalerts.amazonaws.com"])
    error_message = "Only CloudWatch, RDS events, EventBridge (the KMS key alarm), Budgets and Cost Anomaly Detection may publish to the alert topics."
  }
}
