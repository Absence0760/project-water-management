# Plan-only tests (mocked providers, no AWS credentials) for the fixed egress
# (egress.tf, modules/fixed-egress; docs/deployment.md § Fixed egress): off by
# default, the fetcher and mirror-ingest Lambdas stay outside any VPC; on,
# both run in the egress VPC's private subnets behind the NAT instance, with
# the ENI actions their roles then need, and the private VPC gains nothing.
# The module's own shape (routes, the Elastic IP on the ENI, the security
# groups, IMDSv2, the recovery alarms) is pinned by running it directly: the
# root's network guardrails (guardrails.tftest.hcl run "network") read only
# the root module's files, so these asserts are this module's guardrails.
#
# The mocks, overrides and variables below are copied from
# guardrails.tftest.hcl (a test file can't share them); keep them in step.
#
#   pnpm check:infra          (bin/check-infra.sh: fmt + validate + test)

mock_provider "aws" {
  # The fixed-egress module reads its region from the provider.
  mock_data "aws_region" {
    defaults = {
      region = "af-south-1"
    }
  }
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



# --- This file's own overrides: known ARNs for the mirror's resources -------------

override_resource {
  target          = aws_s3_bucket.mirror
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-mirror-000000000000"
    bucket = "water-management-mirror-000000000000"
  }
}

override_resource {
  target          = aws_ecr_repository.ingest
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:af-south-1:000000000000:repository/water-management-mirror-ingest"
    repository_url = "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-mirror-ingest"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mirror-ingest-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mirror-ingest-dlq"
  }
}

override_resource {
  target          = aws_iam_role.ingest_lambda
  override_during = plan
  values = {
    id  = "water-management-mirror-ingest-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-mirror-ingest-lambda"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.ingest["rnl"]
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-mirror-ingest-rnl"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.ingest["sat"]
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-mirror-ingest-sat"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.daily_ingest
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-daily-ingest"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.gefs_ingest
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-gefs-ingest"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.indices_ingest
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-indices-ingest"
  }
}

override_resource {
  target          = aws_iam_role.ingest_backfill
  override_during = plan
  values = {
    id  = "water-management-mirror-backfill"
    arn = "arn:aws:iam::000000000000:role/water-management-mirror-backfill"
  }
}

# --- The mirror bucket ---------------------------------------------------------------


# --- Off (the default) -----------------------------------------------------------

run "fixed_egress_off_by_default" {
  command = plan

  variables {
    ingest_image_tag = "0.7.0-0123456789ab"
  }

  assert {
    condition     = length(module.fixed_egress) == 0
    error_message = "No egress VPC unless fixed_egress_enabled is set."
  }
  assert {
    condition     = length(aws_lambda_function.fetcher.vpc_config) == 0 && length(aws_lambda_function.ingest[0].vpc_config) == 0
    error_message = "Off, the fetcher and mirror-ingest Lambdas run outside any VPC."
  }
  assert {
    condition     = !contains(keys(aws_iam_role_policy.lambda_vpc_eni), "fetcher") && !contains(keys(aws_iam_role_policy.lambda_vpc_eni), "ingest")
    error_message = "Off, neither the fetcher's nor the ingest job's role holds the VPC ENI actions."
  }
}

# --- On --------------------------------------------------------------------------

run "fixed_egress_on" {
  command = plan

  variables {
    ingest_image_tag     = "0.7.0-0123456789ab"
    fixed_egress_enabled = true
  }

  # The module's IDs are unknown at plan; its insides are pinned by run
  # "fixed_egress_module" below.
  override_module {
    target          = module.fixed_egress
    override_during = plan
    outputs = {
      public_ip                = "203.0.113.10"
      private_subnet_ids       = ["subnet-0000egress1", "subnet-0000egress2"]
      lambda_security_group_id = "sg-00egresslambda"
    }
  }

  assert {
    condition     = length(module.fixed_egress) == 1
    error_message = "fixed_egress_enabled creates the egress VPC."
  }
  assert {
    condition     = output.fixed_egress_ip == "203.0.113.10"
    error_message = "The fixed_egress_ip output is the module's Elastic IP (the address to give CHC)."
  }
  assert {
    condition = (
      length(aws_lambda_function.fetcher.vpc_config) == 1 &&
      length(aws_lambda_function.ingest[0].vpc_config) == 1 &&
      toset(aws_lambda_function.fetcher.vpc_config[0].subnet_ids) == toset(module.fixed_egress[0].private_subnet_ids) &&
      toset(aws_lambda_function.ingest[0].vpc_config[0].subnet_ids) == toset(module.fixed_egress[0].private_subnet_ids) &&
      toset(aws_lambda_function.fetcher.vpc_config[0].security_group_ids) == toset([module.fixed_egress[0].lambda_security_group_id]) &&
      toset(aws_lambda_function.ingest[0].vpc_config[0].security_group_ids) == toset([module.fixed_egress[0].lambda_security_group_id])
    )
    error_message = "On, the fetcher and mirror-ingest Lambdas run in the egress VPC's private subnets, in its Lambda security group."
  }
  assert {
    # Never the private VPC: no path to Postgres or its endpoints. (Its
    # subnets' IDs are unknown at plan; the subnets are the module's, above.)
    condition = alltrue([
      for f in [aws_lambda_function.fetcher, aws_lambda_function.ingest[0]] :
      length(setintersection(toset(f.vpc_config[0].security_group_ids), toset([aws_security_group.api_lambda.id, aws_security_group.worker_lambda.id, aws_security_group.migrate_lambda.id, aws_security_group.rds.id]))) == 0
    ])
    error_message = "The fixed-egress Lambdas never get a security group of the private VPC (network.tf)."
  }
  assert {
    condition = (
      toset(keys(aws_iam_role_policy.lambda_vpc_eni)) == toset(["api", "migrate", "worker", "fetcher", "ingest"]) &&
      aws_iam_role_policy.lambda_vpc_eni["fetcher"].role == aws_iam_role.fetcher_lambda.id &&
      aws_iam_role_policy.lambda_vpc_eni["ingest"].role == aws_iam_role.ingest_lambda.id
    )
    error_message = "On, the fetcher's and the ingest job's roles get the VPC ENI actions (iam.tf), each on its own role."
  }
  assert {
    condition = (
      one(one([for s in data.aws_iam_policy_document.lambda_vpc_eni["fetcher"].statement : s if s.effect == "Deny"]).condition).values == tolist(["arn:aws:lambda:af-south-1:000000000000:function:water-management-fetcher"]) &&
      one(one([for s in data.aws_iam_policy_document.lambda_vpc_eni["ingest"].statement : s if s.effect == "Deny"]).condition).values == tolist(["arn:aws:lambda:af-south-1:000000000000:function:water-management-mirror-ingest"])
    )
    error_message = "Each fixed-egress role's ENI policy denies the ENI calls from that function's own code (AWS's recommended Deny)."
  }
}

# --- The module itself -------------------------------------------------------------

run "fixed_egress_module" {
  command = plan

  module {
    source = "./modules/fixed-egress"
  }

  variables {
    project          = "water-management"
    vpc_cidr         = "10.61.0.0/16"
    zone_ids         = ["afs1-az1", "afs1-az2"]
    instance_type    = "t4g.nano"
    alarm_topic_arns = ["arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts"]
  }

  # Resolved IDs, so the asserts can follow the edges at plan.
  override_resource {
    target          = aws_internet_gateway.egress
    override_during = plan
    values = {
      id = "igw-000000egress"
    }
  }
  override_resource {
    target          = aws_subnet.public
    override_during = plan
    values = {
      id = "subnet-0000public"
    }
  }
  override_resource {
    target          = aws_route_table.public
    override_during = plan
    values = {
      id = "rtb-0000public"
    }
  }
  override_resource {
    target          = aws_route_table.private
    override_during = plan
    values = {
      id = "rtb-000private"
    }
  }
  override_resource {
    target          = aws_network_interface.nat
    override_during = plan
    values = {
      id = "eni-000000000nat"
    }
  }
  override_resource {
    target          = aws_security_group.lambda
    override_during = plan
    values = {
      id = "sg-00egresslambda"
    }
  }
  override_resource {
    target          = aws_security_group.nat
    override_during = plan
    values = {
      id = "sg-000000egressnat"
    }
  }

  # --- The way out: private subnets → the NAT ENI → the internet gateway ----
  assert {
    condition = (
      aws_route.private_default.destination_cidr_block == "0.0.0.0/0" &&
      aws_route.private_default.route_table_id == aws_route_table.private.id &&
      aws_route.private_default.network_interface_id == aws_network_interface.nat.id &&
      aws_route.private_default.gateway_id == null &&
      aws_route.public_default.destination_cidr_block == "0.0.0.0/0" &&
      aws_route.public_default.route_table_id == aws_route_table.public.id &&
      aws_route.public_default.gateway_id == aws_internet_gateway.egress.id
    )
    error_message = "The private subnets' only way out is the NAT instance's ENI; only the public subnet routes to the internet gateway."
  }
  assert {
    condition = (
      length(aws_route_table_association.private) == 2 &&
      alltrue([for a in aws_route_table_association.private : a.route_table_id == aws_route_table.private.id]) &&
      aws_route_table_association.public.subnet_id == aws_subnet.public.id &&
      aws_route_table_association.public.route_table_id == aws_route_table.public.id
    )
    error_message = "Both private subnets use the private route table; the public subnet alone uses the public one."
  }
  assert {
    condition     = alltrue([for s in concat(aws_subnet.private, [aws_subnet.public]) : s.map_public_ip_on_launch == false])
    error_message = "No subnet hands out public IPs: the Elastic IP on the NAT ENI is the only public address."
  }
  assert {
    condition     = [for s in aws_subnet.private : s.availability_zone_id] == ["afs1-az1", "afs1-az2"] && aws_subnet.public.availability_zone_id == "afs1-az1"
    error_message = "The private subnets span the two zones; the public subnet (and the NAT) sits in the first."
  }
  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" && aws_vpc_endpoint.s3.service_name == "com.amazonaws.af-south-1.s3" && toset(aws_vpc_endpoint.s3.route_table_ids) == toset([aws_route_table.private.id])
    error_message = "This region's S3 goes through a gateway endpoint on the private route table, off the NAT instance."
  }

  # --- The NAT instance -------------------------------------------------------
  assert {
    condition     = aws_network_interface.nat.source_dest_check == false && aws_network_interface.nat.subnet_id == aws_subnet.public.id && toset(aws_network_interface.nat.security_groups) == toset([aws_security_group.nat.id])
    error_message = "The NAT ENI sits in the public subnet, in the NAT security group, with source/destination checking off (it forwards)."
  }
  assert {
    condition     = aws_eip.nat.domain == "vpc" && aws_eip.nat.network_interface == aws_network_interface.nat.id
    error_message = "The Elastic IP is on the NAT ENI itself, so it is there before the instance boots and survives the instance's replacement."
  }
  assert {
    condition = (
      one(aws_instance.nat.primary_network_interface).network_interface_id == aws_network_interface.nat.id &&
      aws_instance.nat.instance_type == "t4g.nano" &&
      one(aws_instance.nat.credit_specification).cpu_credits == "standard" &&
      one(aws_instance.nat.metadata_options).http_tokens == "required" &&
      one(aws_instance.nat.metadata_options).http_put_response_hop_limit == 1 &&
      one(aws_instance.nat.root_block_device).encrypted == true &&
      aws_instance.nat.user_data_replace_on_change == true
    )
    error_message = "The NAT instance: its ENI as primary, standard credits, IMDSv2 only (one hop), an encrypted root volume, replaced when its script changes."
  }
  assert {
    # Unknown at plan when unset, so read the source: nothing logs in.
    condition     = aws_instance.nat.instance_type != "" && !can(regex("\\n\\s*(key_name|iam_instance_profile|associate_public_ip_address)\\s*=", file("modules/fixed-egress/main.tf")))
    error_message = "The NAT instance has no key pair, no instance profile and no public IP of its own (only the Elastic IP on its ENI)."
  }
  assert {
    condition = (
      strcontains(aws_instance.nat.user_data, "masquerade") &&
      strcontains(aws_instance.nat.user_data, "policy drop") &&
      strcontains(aws_instance.nat.user_data, "tcp dport 443 ct state new accept") &&
      strcontains(aws_instance.nat.user_data, "nft -c -f /etc/sysconfig/nftables.conf") &&
      strcontains(aws_instance.nat.user_data, "echo latest > /etc/dnf/vars/releasever") &&
      strcontains(aws_instance.nat.user_data, "net.ipv4.ip_forward = 1")
    )
    error_message = "The first-boot script forwards (ip_forward), masquerades, drops all forwarding but new HTTPS connections and their replies, checks the ruleset before loading it, and follows the latest AL2023 release for its security updates."
  }

  # --- Security groups --------------------------------------------------------
  assert {
    condition = (
      aws_vpc_security_group_egress_rule.lambda_https.security_group_id == aws_security_group.lambda.id &&
      aws_vpc_security_group_egress_rule.lambda_https.cidr_ipv4 == "0.0.0.0/0" &&
      aws_vpc_security_group_egress_rule.lambda_https.ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.lambda_https.from_port == 443 &&
      aws_vpc_security_group_egress_rule.lambda_https.to_port == 443 &&
      aws_vpc_security_group_ingress_rule.nat_from_lambda.security_group_id == aws_security_group.nat.id &&
      aws_vpc_security_group_ingress_rule.nat_from_lambda.referenced_security_group_id == aws_security_group.lambda.id &&
      aws_vpc_security_group_ingress_rule.nat_from_lambda.from_port == 443 &&
      aws_vpc_security_group_ingress_rule.nat_from_lambda.to_port == 443 &&
      aws_vpc_security_group_ingress_rule.nat_from_lambda.cidr_ipv4 == null &&
      aws_vpc_security_group_egress_rule.nat_https.security_group_id == aws_security_group.nat.id &&
      aws_vpc_security_group_egress_rule.nat_https.from_port == 443 &&
      aws_vpc_security_group_egress_rule.nat_https.to_port == 443
    )
    error_message = "Only HTTPS: the Lambdas out on 443, the NAT in on 443 from the Lambda security group alone (nothing from the internet), and out on 443."
  }
  assert {
    condition = {
      lambda = aws_security_group.lambda.description
      nat    = aws_security_group.nat.description
      } == {
      lambda = "Fixed-egress Lambda ENIs (fetcher, mirror-ingest): HTTPS out only, through the NAT instance or the S3 gateway endpoint."
      nat    = "NAT instance: HTTPS in from the fixed-egress Lambda SG only; HTTPS out to the internet."
    }
    error_message = "A security-group description changed. That replaces the group on the next apply (a Lambda ENI can stall it 20+ minutes); update this pin only if you mean it."
  }
  assert {
    condition = alltrue([
      for d in [aws_security_group.lambda.description, aws_security_group.nat.description] :
      length(d) <= 255 && can(regex("^[a-zA-Z0-9. _:/()#,@\\[\\]+=&;{}!$*-]+$", d))
    ])
    error_message = "Security-group descriptions are limited to 255 characters of a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*, or AWS rejects the create."
  }
  assert {
    # The rules take the same set (AuthorizeSecurityGroup*: "Invalid rule
    # description"); 2026-11-08 an apostrophe failed the first apply.
    condition = alltrue([
      for d in [
        aws_vpc_security_group_egress_rule.lambda_https.description,
        aws_vpc_security_group_ingress_rule.nat_from_lambda.description,
        aws_vpc_security_group_egress_rule.nat_https.description,
      ] : length(d) <= 255 && can(regex("^[a-zA-Z0-9. _:/()#,@\\[\\]+=&;{}!$*-]+$", d))
    ])
    error_message = "Security-group rule descriptions take the same 255 characters of a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* (no apostrophes), or AWS rejects the rule."
  }
  assert {
    # Every description in the module, rules and groups, read from the source,
    # so a new rule can't skip the check above.
    condition = aws_vpc.egress.cidr_block != "" && alltrue([
      for d in regexall("(?m)^\\s*description\\s*=\\s*\"([^\"]*)\"", file("modules/fixed-egress/main.tf")) :
      can(regex("^[a-zA-Z0-9. _:/()#,@\\[\\]+=&;{}!$*-]+$", d[0]))
    ])
    error_message = "A description in modules/fixed-egress/main.tf uses a character AWS refuses in security groups and their rules (an apostrophe, an em dash)."
  }

  # --- Recovery ---------------------------------------------------------------
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.nat_system_check.metric_name == "StatusCheckFailed_System" &&
      contains(aws_cloudwatch_metric_alarm.nat_system_check.alarm_actions, "arn:aws:automate:af-south-1:ec2:recover") &&
      contains(aws_cloudwatch_metric_alarm.nat_system_check.alarm_actions, "arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts") &&
      aws_cloudwatch_metric_alarm.nat_instance_check.metric_name == "StatusCheckFailed_Instance" &&
      contains(aws_cloudwatch_metric_alarm.nat_instance_check.alarm_actions, "arn:aws:automate:af-south-1:ec2:reboot") &&
      contains(aws_cloudwatch_metric_alarm.nat_instance_check.alarm_actions, "arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts")
    )
    error_message = "A failed system check recovers the NAT instance and a failed instance check reboots it; both page."
  }
}

run "fixed_egress_rejects_an_x86_type" {
  command = plan

  variables {
    fixed_egress_enabled       = true
    fixed_egress_instance_type = "t3.nano"
  }

  expect_failures = [var.fixed_egress_instance_type]
}
