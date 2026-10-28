# Plan-only tests for the AI assistant in production (assistant.tf, issue
# #610): off by default (nothing created, the API's status says off); on, its
# Lambda (timeout, reserved concurrency, VPC, pool of 1, its settings and no
# secret in its environment), the streaming Function URL, the CloudFront
# behaviour ahead of /api/* with the shared-secret header, the one-model IAM
# policy for each kind of model id, the bedrock-runtime endpoint and its
# policy, the security groups, the runtime secret, the alarms and the
# assistant's budget, the deploy role, and the database-connection sum.
#
# The mocks, overrides and variables below are copied from
# guardrails.tftest.hcl (a test file can't share them); keep them in step.
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
      domain_name           = "icwbt.jaredhoward.com"
      resource_record_name  = "_0123abcd.icwbt.jaredhoward.com."
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
    arn = "arn:aws:ses:af-south-1:000000000000:identity/icwbt.jaredhoward.com"
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
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests.fifo"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.fetch_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests-dlq.fifo"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests-dlq.fifo"
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
  # The hostname before issue #551, kept as a redirect, in its own zone.
  redirect_domains = { "water-management.jaredhoward.com" = "Z1111111111111111111" }
  github_repo      = "Absence0760/project-water-management"
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
  budget_alert_email = "ops@icwbt.jaredhoward.com"
  # The fetcher's user-agent contact (feeds.tf); required, no default.
  feeds_contact = "ops@icwbt.jaredhoward.com"
}



# --- The assistant's own resources: known values, so references can be matched.

override_resource {
  target          = aws_iam_role.assistant_lambda[0]
  override_during = plan
  values = {
    id  = "water-management-assistant-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-assistant-lambda"
  }
}

override_resource {
  target          = aws_security_group.assistant_lambda[0]
  override_during = plan
  values = {
    id = "sg-000000assistant"
  }
}

override_resource {
  target          = aws_security_group.bedrock_vpce[0]
  override_during = plan
  values = {
    id = "sg-0000000vpcebedr"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["assistant"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/assistant-SsSsSs"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/assistant-SsSsSs"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["assistant"]
  override_during = plan
  values = {
    version_id = "dddddddd-0000-0000-0000-000000000004"
  }
}

override_resource {
  target          = aws_lambda_function_url.assistant[0]
  override_during = plan
  values = {
    url_id = "assistant0url0id0000000000000000"
  }
}

override_resource {
  target          = aws_lambda_function.assistant[0]
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-assistant"
  }
}

# --- Off (the default) ------------------------------------------------------

run "off_by_default" {
  command = plan

  assert {
    condition = (
      length(aws_lambda_function.assistant) == 0 &&
      length(aws_lambda_function_url.assistant) == 0 &&
      length(aws_vpc_endpoint.bedrock_runtime) == 0 &&
      length(aws_iam_role.assistant_lambda) == 0 &&
      length(aws_budgets_budget.assistant) == 0 &&
      length(aws_cloudwatch_metric_alarm.assistant_errors) == 0
    )
    error_message = "With assistant_enabled false (the default) no assistant resource exists: no Lambda, URL, endpoint, role, budget or alarm."
  }

  assert {
    condition     = !contains(keys(aws_secretsmanager_secret.runtime), "assistant") && !contains(keys(aws_iam_role_policy.lambda_logs), "assistant")
    error_message = "Off, no assistant runtime secret or log grant is created."
  }

  assert {
    condition     = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.target_origin_id != "lambda-assistant"]) && alltrue([for o in aws_cloudfront_distribution.frontend.origin : o.origin_id != "lambda-assistant"])
    error_message = "Off, CloudFront has no assistant origin or behaviour: the status and every message stay on the API, which answers off."
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables.ASSISTANT_PROVIDER == "off"
    error_message = "Off, the API says ASSISTANT_PROVIDER=off, so the page shows no chat."
  }
}

# --- On -----------------------------------------------------------------------

run "on" {
  command = plan

  variables {
    assistant_enabled = true
  }

  assert {
    condition = (
      aws_lambda_function.assistant[0].function_name == "water-management-assistant" &&
      aws_lambda_function.assistant[0].handler == "lambda-assistant.handler" &&
      aws_lambda_function.assistant[0].runtime == "nodejs24.x" &&
      aws_lambda_function.assistant[0].timeout == 120 &&
      aws_lambda_function.assistant[0].reserved_concurrent_executions == 2
    )
    error_message = "The assistant Lambda: lambda-assistant.handler on nodejs24.x, a 120 s timeout (a turn runs past the API's 30 s) and reserved concurrency 2."
  }

  assert {
    condition = (
      toset(aws_lambda_function.assistant[0].vpc_config[0].security_group_ids) == toset(["sg-000000assistant"])
    )
    error_message = "The assistant runs in the VPC, in its own security group."
  }

  assert {
    condition = (
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_PROVIDER == "bedrock" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MODEL == "global.anthropic.claude-sonnet-5-5" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_BEDROCK_REGION == "af-south-1" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH == "2000000" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MESSAGES_PER_HOUR == "30" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_HOPS == "6" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_KEEPALIVE_SECONDS == "15" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TURN_SECONDS == "105" &&
      aws_lambda_function.assistant[0].environment[0].variables.DB_POOL_MAX == "1" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_USER_MONTH == "1000000" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_TURN_TOKENS == "150000" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_TOOL_CALLS_PER_HOP == "4" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_OUTPUT_TOKENS == "1024" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_TOOL_RESULT_CHARS == "12000" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_INPUT_CHARS == "40000" &&
      aws_lambda_function.assistant[0].environment[0].variables.FEED_SOURCE == "live"
    )
    error_message = "The assistant calls Bedrock in its own region with the issue's limits (2 M weighted tokens a project a month, 1 M a person, 30 messages a user an hour, 6 hops, 150 K tokens and 4 tool calls a hop per turn, and the per-call caps pinned), a keepalive under the origin's read timeout, a turn 15 s inside the timeout and a pool of 1."
  }

  # The deployment-wide cap: the assistant's $50 budget at $2 per million
  # input tokens (weighted tokens are dollars at the input price).
  assert {
    condition     = aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL == "25000000"
    error_message = "Unset, the deployment-wide cap is assistant_budget_monthly_usd / assistant_input_usd_per_million x 1e6: 25 M weighted tokens for $50 at $2/M."
  }

  assert {
    condition = (
      aws_lambda_function.assistant[0].environment[0].variables.RUNTIME_SECRET_ARN == aws_secretsmanager_secret.runtime["assistant"].arn &&
      aws_lambda_function.assistant[0].environment[0].variables.RUNTIME_SECRET_VERSION == "dddddddd-0000-0000-0000-000000000004" &&
      alltrue([for k in keys(aws_lambda_function.assistant[0].environment[0].variables) : !contains(["AUTH_JWT_SECRET", "DATABASE_URL", "CLOUDFRONT_SHARED_SECRET", "ANTHROPIC_API_KEY"], k) && !can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$|API_KEY$", k))])
    )
    error_message = "The assistant names its own runtime secret and holds no secret or model key in its environment."
  }

  assert {
    condition = (
      local.runtime_secrets.assistant.CLOUDFRONT_SHARED_SECRET == random_password.cloudfront_shared_secret.result &&
      endswith(local.runtime_secrets.assistant.DATABASE_URL, "?sslmode=verify-full&application_name=assistant") &&
      local.runtime_secrets.assistant.AUTH_JWT_SECRET == var.auth_jwt_secret
    )
    error_message = "Its runtime secret carries the CloudFront header CloudFront stamps, the session key and its own water_app connection (verify-full)."
  }

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_PROVIDER == "bedrock" &&
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_MODEL == aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MODEL &&
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_TOKENS_PER_MONTH == aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH &&
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_TOKENS_PER_USER_MONTH == aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_USER_MONTH &&
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL == aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL &&
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_MESSAGES_PER_HOUR == aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MESSAGES_PER_HOUR
    )
    error_message = "The API, which answers the status, has the assistant's provider, model and limits, so the page shows what the assistant enforces."
  }

  assert {
    condition     = aws_lambda_function_url.assistant[0].invoke_mode == "RESPONSE_STREAM" && aws_lambda_function_url.assistant[0].authorization_type == "NONE"
    error_message = "The assistant's Function URL streams (its handler is a streaming one), NONE-auth like the API's: the shared secret is the check."
  }

  # CloudFront: the assistant's behaviour comes first, so /api/* doesn't take it.
  assert {
    condition = (
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].path_pattern == "/api/projects/*/assistant/*" &&
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].target_origin_id == "lambda-assistant" &&
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[1].path_pattern == "/api/*" &&
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].origin_request_policy_id == aws_cloudfront_distribution.frontend.ordered_cache_behavior[1].origin_request_policy_id &&
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].viewer_protocol_policy == "https-only" &&
      contains(aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].allowed_methods, "POST") &&
      [for f in aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].function_association : f.event_type] == ["viewer-request"] &&
      aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].compress == false
    )
    error_message = "/api/projects/*/assistant/* goes to the assistant ahead of /api/*, uncached, with the API's origin-request policy and its /api prefix strip."
  }

  assert {
    condition = length([
      for o in aws_cloudfront_distribution.frontend.origin : o
      if o.origin_id == "lambda-assistant" &&
      o.domain_name == "assistant0url0id0000000000000000.lambda-url.af-south-1.on.aws" &&
      o.custom_origin_config[0].origin_read_timeout == 60 &&
      o.custom_origin_config[0].origin_protocol_policy == "https-only" &&
      length([for h in o.custom_header : h if h.name == "X-CloudFront-Shared-Secret" && h.value == random_password.cloudfront_shared_secret.result]) == 1
    ]) == 1
    error_message = "The assistant's origin is its Function URL over https, stamped with the same shared secret as the API's, with a 60 s read timeout (keepalives every 15 s)."
  }

  # IAM: the one model, through the global profile (AWS's documented shape).
  assert {
    condition = (
      length(data.aws_iam_policy_document.assistant_bedrock[0].statement) == 3 &&
      alltrue([for s in data.aws_iam_policy_document.assistant_bedrock[0].statement : toset(s.actions) == toset(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]) && !contains(s.resources, "*")])
    )
    error_message = "The assistant may invoke (and stream) one model and nothing else: no wildcard resource."
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.assistant_bedrock[0].statement : s
      if s.sid == "InvokeTheInferenceProfile" &&
      toset(s.resources) == toset(["arn:aws:bedrock:af-south-1:000000000000:inference-profile/global.anthropic.claude-sonnet-5-5"]) &&
      length([for c in s.condition : c if c.variable == "aws:RequestedRegion" && toset(c.values) == toset(["af-south-1"])]) == 1
    ]) == 1
    error_message = "The global inference profile, in this region only."
  }

  # AWS's three-part global example: the model here with aws:RequestedRegion
  # = this region, the region-less model with "unspecified", each only
  # through the profile.
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.assistant_bedrock[0].statement : s
      if s.sid == "InvokeTheModelInRegionThroughTheProfile" &&
      toset(s.resources) == toset(["arn:aws:bedrock:af-south-1::foundation-model/anthropic.claude-sonnet-5-5"]) &&
      length(s.condition) == 2 &&
      length([for c in s.condition : c if c.test == "StringEquals" && c.variable == "aws:RequestedRegion" && toset(c.values) == toset(["af-south-1"])]) == 1 &&
      length([for c in s.condition : c if c.test == "StringEquals" && c.variable == "bedrock:InferenceProfileArn" && toset(c.values) == toset(["arn:aws:bedrock:af-south-1:000000000000:inference-profile/global.anthropic.claude-sonnet-5-5"])]) == 1
    ]) == 1
    error_message = "The model in this region, requested in this region, only through that profile."
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.assistant_bedrock[0].statement : s
      if s.sid == "InvokeTheGlobalModelThroughTheProfile" &&
      toset(s.resources) == toset(["arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5"]) &&
      length(s.condition) == 2 &&
      length([for c in s.condition : c if c.test == "StringEquals" && c.variable == "aws:RequestedRegion" && toset(c.values) == toset(["unspecified"])]) == 1 &&
      length([for c in s.condition : c if c.test == "StringEquals" && c.variable == "bedrock:InferenceProfileArn" && toset(c.values) == toset(["arn:aws:bedrock:af-south-1:000000000000:inference-profile/global.anthropic.claude-sonnet-5-5"])]) == 1
    ]) == 1
    error_message = "The region-less model (global routing), with aws:RequestedRegion unspecified as Bedrock evaluates it, only through that profile."
  }

  assert {
    condition = (
      aws_iam_role_policy.assistant_bedrock[0].role == "water-management-assistant-lambda" &&
      contains(keys(aws_iam_role_policy.lambda_logs), "assistant") &&
      contains(keys(aws_iam_role_policy.lambda_vpc_eni), "assistant") &&
      contains(keys(aws_iam_role_policy.runtime_secret), "assistant")
    )
    error_message = "The assistant's role gets the model, its own log group, the VPC ENI actions and its own runtime secret."
  }

  # The endpoint and its policy.
  assert {
    condition = (
      aws_vpc_endpoint.bedrock_runtime[0].service_name == "com.amazonaws.af-south-1.bedrock-runtime" &&
      aws_vpc_endpoint.bedrock_runtime[0].vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.bedrock_runtime[0].private_dns_enabled == true &&
      toset(aws_vpc_endpoint.bedrock_runtime[0].security_group_ids) == toset(["sg-0000000vpcebedr"]) &&
      length(aws_vpc_endpoint.bedrock_runtime[0].subnet_ids) == 1
    )
    error_message = "A bedrock-runtime interface endpoint with private DNS (no NAT, no internet), in one AZ by default, in its own security group."
  }

  assert {
    condition = (
      length(data.aws_iam_policy_document.bedrock_endpoint[0].statement) == 1 &&
      [for p in data.aws_iam_policy_document.bedrock_endpoint[0].statement[0].principals : toset(p.identifiers)] == [toset(["arn:aws:iam::000000000000:role/water-management-assistant-lambda"])] &&
      !contains(data.aws_iam_policy_document.bedrock_endpoint[0].statement[0].resources, "*") &&
      contains(data.aws_iam_policy_document.bedrock_endpoint[0].statement[0].resources, "arn:aws:bedrock:af-south-1:000000000000:inference-profile/global.anthropic.claude-sonnet-5-5")
    )
    error_message = "Through the endpoint, only the assistant's role, only the one model."
  }

  # Network: the endpoint admits the assistant only; the assistant reaches Postgres and the two endpoints only.
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.bedrock_vpce_from_assistant[0].security_group_id == "sg-0000000vpcebedr" &&
      aws_vpc_security_group_ingress_rule.bedrock_vpce_from_assistant[0].referenced_security_group_id == "sg-000000assistant" &&
      aws_vpc_security_group_ingress_rule.bedrock_vpce_from_assistant[0].from_port == 443 &&
      aws_vpc_security_group_ingress_rule.rds_from_assistant[0].security_group_id == "sg-000000000000rds" &&
      aws_vpc_security_group_ingress_rule.rds_from_assistant[0].from_port == 5432 &&
      aws_vpc_security_group_ingress_rule.vpce_from_assistant[0].security_group_id == "sg-00000000000vpce"
    )
    error_message = "The Bedrock endpoint, RDS and the Secrets Manager endpoint each admit the assistant's group on their one port."
  }

  # Verbatim, as guardrails.tftest.hcl pins the others: a description can't
  # change in place (the group is replaced under live ENIs).
  assert {
    condition = (
      aws_security_group.assistant_lambda[0].description == "Assistant Lambda ENIs: egress to Postgres and the Secrets Manager and Bedrock runtime endpoints only." &&
      aws_security_group.bedrock_vpce[0].description == "Bedrock runtime interface endpoint: 443 from the assistant Lambda only."
    )
    error_message = "An assistant security-group description changed. That replaces the group on the next apply; update this pin only if you mean it."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.assistant_to_rds[0].referenced_security_group_id == "sg-000000000000rds" &&
      aws_vpc_security_group_egress_rule.assistant_to_vpce[0].referenced_security_group_id == "sg-00000000000vpce" &&
      aws_vpc_security_group_egress_rule.assistant_to_bedrock[0].referenced_security_group_id == "sg-0000000vpcebedr"
    )
    error_message = "The assistant's group may reach Postgres, the Secrets Manager endpoint and the Bedrock endpoint, and nothing else."
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement : s
      if s.sid == "ReadRuntimeSecretAssistant" && toset(s.resources) == toset([aws_secretsmanager_secret.runtime["assistant"].arn])
    ]) == 1
    error_message = "The Secrets Manager endpoint lets the assistant read its own runtime secret."
  }

  # Alarms (the default tier is full) and the assistant's budget.
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.assistant_errors[0].dimensions.FunctionName == "water-management-assistant" &&
      aws_cloudwatch_metric_alarm.assistant_errors[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.assistant_throttles[0].dimensions.FunctionName == "water-management-assistant" &&
      aws_cloudwatch_metric_alarm.assistant_throttles[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.assistant_duration[0].threshold == 96000 &&
      aws_cloudwatch_log_metric_filter.origin_secret_rejected_assistant[0].metric_transformation[0].name == aws_cloudwatch_log_metric_filter.origin_secret_rejected[0].metric_transformation[0].name
    )
    error_message = "The assistant has its errors (any one), throttles and p95 duration alarms, and its direct-traffic refusals count toward the origin-secret alarm."
  }

  # Its unhandled 500s feed the API's metric, so the one alarm sees both.
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.unhandled_error_assistant[0].log_group_name == "/aws/lambda/water-management-assistant" &&
      aws_cloudwatch_log_metric_filter.unhandled_error_assistant[0].pattern == aws_cloudwatch_log_metric_filter.unhandled_error[0].pattern &&
      aws_cloudwatch_log_metric_filter.unhandled_error_assistant[0].metric_transformation[0].name == aws_cloudwatch_metric_alarm.unhandled_error[0].metric_name &&
      aws_cloudwatch_log_metric_filter.unhandled_error_assistant[0].metric_transformation[0].namespace == aws_cloudwatch_metric_alarm.unhandled_error[0].namespace
    )
    error_message = "The assistant's log group feeds unhandled_error's metric: its 500s page like the API's."
  }

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.assistant_charge_failed[0].log_group_name == "/aws/lambda/water-management-assistant" &&
      aws_cloudwatch_log_metric_filter.assistant_charge_failed[0].pattern == "{ $.message.event = \"assistant_charge_failed\" }" &&
      aws_cloudwatch_metric_alarm.assistant_charge_failed[0].metric_name == aws_cloudwatch_log_metric_filter.assistant_charge_failed[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.assistant_charge_failed[0].threshold == 0 &&
      aws_cloudwatch_log_metric_filter.assistant_provider_failed[0].pattern == "{ $.message.event = \"assistant_provider_failed\" }" &&
      aws_cloudwatch_metric_alarm.assistant_provider_failed[0].metric_name == aws_cloudwatch_log_metric_filter.assistant_provider_failed[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.assistant_provider_failed[0].threshold == 3 &&
      aws_cloudwatch_metric_alarm.assistant_provider_failed[0].period == 900
    )
    error_message = "A failed charge (any one) and failed model calls (more than 3 in 15 minutes) page: both leave the invocation a 200."
  }

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.assistant_tokens[0].log_group_name == "/aws/lambda/water-management-assistant" &&
      aws_cloudwatch_log_metric_filter.assistant_tokens[0].pattern == "{ $.message.event = \"assistant_turn\" }" &&
      aws_cloudwatch_log_metric_filter.assistant_tokens[0].metric_transformation[0].value == "$.message.weightedTokens" &&
      aws_cloudwatch_metric_alarm.assistant_tokens_hourly[0].metric_name == aws_cloudwatch_log_metric_filter.assistant_tokens[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.assistant_tokens_hourly[0].namespace == aws_cloudwatch_log_metric_filter.assistant_tokens[0].metric_transformation[0].namespace &&
      aws_cloudwatch_metric_alarm.assistant_tokens_hourly[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.assistant_tokens_hourly[0].period == 3600 &&
      aws_cloudwatch_metric_alarm.assistant_tokens_hourly[0].threshold == 2000000
    )
    error_message = "The hourly spend alarm sums the assistant_turn lines' weighted tokens over an hour, above 2 M by default."
  }

  assert {
    condition = (
      aws_budgets_budget.assistant[0].limit_amount == "50" &&
      aws_budgets_budget.assistant[0].time_unit == "MONTHLY" &&
      length([for f in aws_budgets_budget.assistant[0].cost_filter : f if f.name == "BillingEntity" && toset(f.values) == toset(["AWS Marketplace"])]) == 1 &&
      length(aws_budgets_budget.assistant[0].notification) == 2
    )
    error_message = "The assistant's budget: USD 50 a month on the account's AWS Marketplace charges (Anthropic's models on Bedrock), ACTUAL 80% and 100%."
  }

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if s.sid == "LambdaUpdate"]), "arn:aws:lambda:af-south-1:000000000000:function:water-management-assistant")
    error_message = "The deploy role may update the assistant's code."
  }
}

# The essential tier keeps every assistant alarm but duration's: 5 on top of
# the 13 (alarms.tf's tier comment counts them).
run "essential_tier_keeps_the_assistant_alarms" {
  command = plan

  variables {
    assistant_enabled = true
    alarm_tier        = "essential"
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.assistant_errors) == 1 &&
      length(aws_cloudwatch_metric_alarm.assistant_throttles) == 1 &&
      length(aws_cloudwatch_metric_alarm.assistant_charge_failed) == 1 &&
      length(aws_cloudwatch_metric_alarm.assistant_provider_failed) == 1 &&
      length(aws_cloudwatch_metric_alarm.assistant_tokens_hourly) == 1 &&
      length(aws_cloudwatch_log_metric_filter.unhandled_error_assistant) == 1 &&
      length(aws_cloudwatch_metric_alarm.assistant_duration) == 0
    )
    error_message = "Essential keeps the assistant's errors, throttles, failed-charge, failed-model-call and hourly-token alarms and its unhandled-500 filter."
  }
}

run "the_deployment_wide_cap_can_be_set_or_follows_the_budget" {
  command = plan

  variables {
    assistant_enabled               = true
    assistant_budget_monthly_usd    = 30
    assistant_input_usd_per_million = 3
    assistant_tokens_per_user_month = 500000
    assistant_tokens_alarm_per_hour = 500000
  }

  assert {
    condition = (
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL == "10000000" &&
      aws_lambda_function.backend.environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL == "10000000" &&
      aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_USER_MONTH == "500000" &&
      aws_cloudwatch_metric_alarm.assistant_tokens_hourly[0].threshold == 500000
    )
    error_message = "The deployment-wide cap follows the budget at the input price ($30 at $3/M is 10 M weighted tokens), on the assistant and the API alike."
  }
}

run "an_explicit_deployment_wide_cap_needs_no_budget" {
  command = plan

  variables {
    assistant_enabled                = true
    assistant_budget_monthly_usd     = 0
    assistant_tokens_per_month_total = 5000000
  }

  assert {
    condition     = aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL == "5000000" && length(aws_budgets_budget.assistant) == 0
    error_message = "Set, the deployment-wide cap is that value, with or without an assistant budget."
  }
}

run "refuses_no_budget_and_no_deployment_wide_cap" {
  command = plan

  variables {
    assistant_enabled            = true
    assistant_budget_monthly_usd = 0
  }

  expect_failures = [var.assistant_tokens_per_month_total]
}

run "refuses_a_derived_cap_past_its_bound" {
  command = plan

  variables {
    assistant_budget_monthly_usd    = 1000
    assistant_input_usd_per_million = 2
  }

  expect_failures = [var.assistant_tokens_per_month_total]
}

# The bounds production.ts checks too: one past each refuses the plan.
run "refuses_caps_past_their_bounds" {
  command = plan

  variables {
    assistant_tokens_per_month       = 20000001
    assistant_tokens_per_user_month  = 0
    assistant_tokens_per_month_total = 200000001
    assistant_messages_per_hour      = 121
    assistant_max_output_tokens      = 255
    assistant_max_tool_result_chars  = 50001
    assistant_max_input_chars        = 999
    assistant_max_tool_calls_per_hop = 11
    assistant_max_turn_tokens        = 9999
    assistant_tokens_alarm_per_hour  = 9999
  }

  expect_failures = [
    var.assistant_tokens_per_month,
    var.assistant_tokens_per_user_month,
    var.assistant_tokens_per_month_total,
    var.assistant_messages_per_hour,
    var.assistant_max_output_tokens,
    var.assistant_max_tool_result_chars,
    var.assistant_max_input_chars,
    var.assistant_max_tool_calls_per_hop,
    var.assistant_max_turn_tokens,
    var.assistant_tokens_alarm_per_hour,
  ]
}

run "accepts_caps_at_their_bounds" {
  command = plan

  variables {
    assistant_enabled                = true
    assistant_tokens_per_month       = 20000000
    assistant_tokens_per_user_month  = 1
    assistant_tokens_per_month_total = 200000000
    assistant_messages_per_hour      = 120
    assistant_max_output_tokens      = 8192
    assistant_max_tool_result_chars  = 1000
    assistant_max_input_chars        = 200000
    assistant_max_tool_calls_per_hop = 10
    assistant_max_turn_tokens        = 1000000
  }

  assert {
    condition     = aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_MAX_OUTPUT_TOKENS == "8192" && aws_lambda_function.assistant[0].environment[0].variables.ASSISTANT_TOKENS_PER_MONTH_TOTAL == "200000000"
    error_message = "Each cap at its bound is accepted, and reaches the environment as a whole number."
  }
}

run "geo_profile_routes_within_its_geography" {
  command = plan

  variables {
    assistant_enabled  = true
    assistant_model_id = "eu.anthropic.claude-sonnet-5-5"
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.assistant_bedrock[0].statement : s
      if s.sid == "InvokeTheModelThroughTheProfile" && toset(s.resources) == toset(["arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5"])
    ]) == 1 && length(data.aws_iam_policy_document.assistant_bedrock[0].statement) == 2
    error_message = "A geographic profile may route to its geography's regions, so the model in any region, still only through that profile."
  }
}

run "in_region_model_needs_no_profile" {
  command = plan

  variables {
    assistant_enabled  = true
    assistant_model_id = "anthropic.claude-haiku-5-5"
  }

  assert {
    condition = (
      length(data.aws_iam_policy_document.assistant_bedrock[0].statement) == 1 &&
      data.aws_iam_policy_document.assistant_bedrock[0].statement[0].sid == "InvokeTheModelInRegion" &&
      toset(data.aws_iam_policy_document.assistant_bedrock[0].statement[0].resources) == toset(["arn:aws:bedrock:af-south-1::foundation-model/anthropic.claude-haiku-5-5"])
    )
    error_message = "A model served in this region: that model here, and no profile."
  }
}

run "refuses_a_model_that_is_not_anthropic_on_bedrock" {
  command = plan

  variables {
    assistant_enabled  = true
    assistant_model_id = "claude-sonnet-5-5"
  }

  expect_failures = [var.assistant_model_id]
}

run "refuses_unreserved_assistant_concurrency" {
  command = plan

  variables {
    assistant_enabled              = true
    assistant_reserved_concurrency = -1
  }

  expect_failures = [var.assistant_reserved_concurrency]
}

# The database-connection sum (lambda.tf): at the defaults the assistant's 2 x 1
# fits exactly (25 x 2 + 8 x 2 + 2 + 2 = 70); one more slot is refused.
run "assistant_connections_count_toward_the_database_sum" {
  command = plan

  variables {
    assistant_enabled              = true
    assistant_reserved_concurrency = 3
  }

  expect_failures = [aws_lambda_function.backend]
}
