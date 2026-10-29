# Plan-only tests (mocked providers, no AWS credentials) for the dam
# observations (dam_observations.tf, issue #604 R5): everything stays off until
# dam_observations_enabled is set, and the plan refuses it while the worker's
# environment lacks DAM_OBSERVATIONS = "on" (the gate); with it on, the hourly
# rule sends {"mode":"dams-weekly"} to the fetcher, never retried; the fetcher reaches
# only dams/ in the mirror bucket and the worker only dams/wanted.json; each
# source's heartbeat alarm and the WOfS recency alarm treat missing data as
# breaching, and waterbodies has no recency alarm (its public series are
# frozen upstream, docs/data-sources.md).
#
# The mocks, overrides and variables below are copied from
# ingest.tftest.hcl (a test file can't share them); keep them in step.
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
  target          = aws_iam_role.ingest_backfill
  override_during = plan
  values = {
    id  = "water-management-mirror-backfill"
    arn = "arn:aws:iam::000000000000:role/water-management-mirror-backfill"
  }
}

# --- The mirror bucket ---------------------------------------------------------------
override_resource {
  target          = aws_cloudwatch_event_rule.dams_weekly
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-dams-weekly"
  }
}

run "dam_observations_off_by_default" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_event_rule.dams_weekly.state == "DISABLED" &&
      length(aws_cloudwatch_event_target.dams_weekly) == 0 &&
      length(aws_lambda_permission.fetcher_dams_weekly) == 0 &&
      length(aws_iam_role_policy.fetcher_dams) == 0 &&
      length(aws_iam_role_policy.worker_dams) == 0 &&
      length(aws_cloudwatch_metric_alarm.dam_pass_heartbeat) == 0 &&
      length(aws_cloudwatch_metric_alarm.dam_recency_wofs) == 0 &&
      length(aws_cloudwatch_metric_alarm.dam_recency_s2) == 0 &&
      length(aws_cloudwatch_metric_alarm.dam_recency_s1) == 0 &&
      !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "DAM_OBSERVATIONS_S2") &&
      !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "DAM_OBSERVATIONS_S1") &&
      length(terraform_data.dam_observations_gate) == 0
    )
    error_message = "Until dam_observations_enabled is set the dams rule is disabled, targets nothing, may invoke nothing, neither Lambda may write dams/, and no alarm fires for passes that don't exist."
  }
}

# The gate (dam_observations.tf terraform_data.dam_observations_gate) refuses
# the flag unless the worker's environment turns the dams tick on. jobs.tf sets
# DAM_OBSERVATIONS from the same flag, so the gate passes with it on and the
# worker's tick follows it either way.
run "dam_observations_turn_the_worker_tick_on_with_the_flag" {
  command = plan

  variables {
    dam_observations_enabled = true
  }

  assert {
    condition     = aws_lambda_function.worker.environment[0].variables["DAM_OBSERVATIONS"] == "on" && length(terraform_data.dam_observations_gate) == 1
    error_message = "With dam_observations_enabled the worker runs the dams tick (DAM_OBSERVATIONS=on), so the gate passes."
  }
}

run "dam_observations_leave_the_worker_tick_off_by_default" {
  command = plan

  assert {
    condition     = aws_lambda_function.worker.environment[0].variables["DAM_OBSERVATIONS"] == "off"
    error_message = "Until dam_observations_enabled is set the worker's dams tick is off."
  }
}

run "dam_observations_on" {
  command = plan

  variables {
    dam_observations_enabled = true
  }

  assert {
    condition = (
      aws_cloudwatch_event_rule.dams_weekly.state == "ENABLED" &&
      aws_cloudwatch_event_target.dams_weekly[0].arn == aws_lambda_function.fetcher.arn &&
      jsondecode(aws_cloudwatch_event_target.dams_weekly[0].input) == { mode = "dams-weekly" } &&
      one(aws_cloudwatch_event_target.dams_weekly[0].retry_policy).maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_rule.dams_weekly.schedule_expression == "cron(20 * * * ? *)" &&
      alltrue([for r in [aws_cloudwatch_event_rule.daily_ingest, aws_cloudwatch_event_rule.dws_weekly, aws_cloudwatch_event_rule.gefs_ingest] : !startswith(r.schedule_expression, "cron(20 ")]) &&
      !contains([aws_cloudwatch_event_rule.daily_ingest.schedule_expression, aws_cloudwatch_event_rule.dws_weekly.schedule_expression], aws_cloudwatch_event_rule.dams_weekly.schedule_expression)
    )
    error_message = "With dam_observations_enabled the dams rule sends {\"mode\":\"dams-weekly\"} to the fetcher hourly at :20 (the WOfS backfill's pace; each pass keeps its own once-a-week or once-a-day per key), never retried, clear of the daily ingest, the DWS pass and the GEFS pass."
  }
  assert {
    condition = (
      aws_lambda_permission.fetcher_dams_weekly[0].principal == "events.amazonaws.com" &&
      aws_lambda_permission.fetcher_dams_weekly[0].statement_id == "AllowEventBridgeDamsWeekly" &&
      can(regex("source_arn\\s*=\\s*aws_cloudwatch_event_rule\\.dams_weekly\\.arn", regex("(?s)resource \"aws_lambda_permission\" \"fetcher_dams_weekly\" \\{.*?\\n\\}", file("dam_observations.tf"))))
    )
    error_message = "Only the dams rule may invoke the fetcher for the passes."
  }
  assert {
    condition = (
      aws_iam_role_policy.fetcher_dams[0].role == aws_iam_role.fetcher_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_dams.statement : s.actions])) == toset(["s3:GetObject", "s3:PutObject", "s3:ListBucket"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_dams.statement : s.resources])) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/dams/*"])
    )
    error_message = "The fetcher's passes read and write dams/ in the mirror bucket only (no delete, nothing of the CHIRPS copy or dws/)."
  }
  assert {
    condition = (
      aws_iam_role_policy.worker_dams[0].role == aws_iam_role.worker_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_dams.statement : s.actions])) == toset(["s3:PutObject"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_dams.statement : s.resources])) == toset(["${aws_s3_bucket.mirror.arn}/dams/wanted.json"])
    )
    error_message = "The worker's one write for the dams is the wanted list."
  }
  assert {
    condition = (
      toset(keys(aws_cloudwatch_metric_alarm.dam_pass_heartbeat)) == toset(["waterbodies", "wofs"]) &&
      alltrue([for k, a in aws_cloudwatch_metric_alarm.dam_pass_heartbeat : (
        a.treat_missing_data == "breaching" &&
        a.namespace == "water-management/DamObservations" &&
        a.metric_name == "DamPassCompleted" &&
        a.dimensions["Source"] == k &&
        a.comparison_operator == "LessThanThreshold" && a.threshold == 1 && a.statistic == "Sum" &&
        a.period == 21600 && a.evaluation_periods == 3 && a.datapoints_to_alarm == 3 &&
        a.alarm_actions == toset([aws_sns_topic.alerts.arn])
      )])
    )
    error_message = "Each source's heartbeat alarm reads DamPassCompleted{Source}, fires after 18 hours without a completed pass (inside a refusal's 24-hour pause), and treats missing data as breaching."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dam_recency_wofs[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.dam_recency_wofs[0].namespace == "water-management/DamObservations" &&
      aws_cloudwatch_metric_alarm.dam_recency_wofs[0].metric_name == "DamObservationAgeDays" &&
      aws_cloudwatch_metric_alarm.dam_recency_wofs[0].dimensions["Source"] == "wofs" &&
      aws_cloudwatch_metric_alarm.dam_recency_wofs[0].threshold == 60 &&
      aws_cloudwatch_metric_alarm.dam_recency_wofs[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The WOfS recency alarm reads DamObservationAgeDays{Source=wofs} against dam_wofs_recency_alarm_days (60) and treats missing data as breaching."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dam_recency_wofs) == 1 && !can(regex("metric_name\\s*=\\s*local\\.dam_recency_metric[^}]*Source\\s*=\\s*\"waterbodies\"", file("dam_observations.tf")))
    error_message = "No recency alarm for waterbodies: its public series are frozen upstream (docs/data-sources.md)."
  }
}

run "dam_alarms_follow_the_alarm_tier" {
  command = plan

  variables {
    dam_observations_enabled = true
    alarm_tier               = "none"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dam_pass_heartbeat) == 0 && length(aws_cloudwatch_metric_alarm.dam_recency_wofs) == 0 && aws_cloudwatch_event_rule.dams_weekly.state == "ENABLED"
    error_message = "alarm_tier none drops the dams alarms, not the passes."
  }
}

run "rejects_a_wofs_recency_alarm_that_fires_on_a_cloudy_month" {
  command = plan

  variables {
    dam_wofs_recency_alarm_days = 14
  }

  expect_failures = [var.dam_wofs_recency_alarm_days]
}

# Sentinel-2 (issue #624): off with the dam observations on, until its own
# flag; with it, the fetcher runs the pass and it gets its own heartbeat and
# recency alarms, both breaching on missing data.
run "dam_s2_off_until_its_own_flag" {
  command = plan

  variables {
    dam_observations_enabled = true
  }

  assert {
    condition     = aws_lambda_function.fetcher.environment[0].variables["DAM_OBSERVATIONS_S2"] == "off" && !contains(keys(aws_cloudwatch_metric_alarm.dam_pass_heartbeat), "s2") && length(aws_cloudwatch_metric_alarm.dam_recency_s2) == 0
    error_message = "Without dam_s2_enabled the fetcher runs no Sentinel-2 pass and no s2 alarm exists."
  }
}

run "dam_s2_needs_the_dam_observations_too" {
  command = plan

  variables {
    dam_s2_enabled = true
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "DAM_OBSERVATIONS_S2") && length(aws_cloudwatch_metric_alarm.dam_recency_s2) == 0 && length(aws_cloudwatch_metric_alarm.dam_pass_heartbeat) == 0
    error_message = "dam_s2_enabled alone turns nothing on: the passes need dam_observations_enabled."
  }
}

run "dam_s2_on" {
  command = plan

  variables {
    dam_observations_enabled = true
    dam_s2_enabled           = true
  }

  assert {
    condition = (
      aws_lambda_function.fetcher.environment[0].variables["DAM_OBSERVATIONS_S2"] == "on" &&
      toset(keys(aws_cloudwatch_metric_alarm.dam_pass_heartbeat)) == toset(["waterbodies", "wofs", "s2"]) &&
      aws_cloudwatch_metric_alarm.dam_pass_heartbeat["s2"].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.dam_pass_heartbeat["s2"].dimensions["Source"] == "s2"
    )
    error_message = "With dam_s2_enabled the fetcher runs the Sentinel-2 pass and its heartbeat alarm reads DamPassCompleted{Source=s2}, breaching on missing data."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dam_recency_s2[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.dam_recency_s2[0].metric_name == "DamObservationAgeDays" &&
      aws_cloudwatch_metric_alarm.dam_recency_s2[0].namespace == "water-management/DamObservations" &&
      aws_cloudwatch_metric_alarm.dam_recency_s2[0].dimensions["Source"] == "s2" &&
      aws_cloudwatch_metric_alarm.dam_recency_s2[0].threshold == 21 &&
      aws_cloudwatch_metric_alarm.dam_recency_s2[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The Sentinel-2 recency alarm reads DamObservationAgeDays{Source=s2} against dam_s2_recency_alarm_days (21) and treats missing data as breaching."
  }
}

run "rejects_an_s2_recency_alarm_shorter_than_the_publication_lag" {
  command = plan

  variables {
    dam_s2_recency_alarm_days = 5
  }

  expect_failures = [var.dam_s2_recency_alarm_days]
}

# Sentinel-1 radar (issue #624 step 5): the same pattern as Sentinel-2's,
# independent of it, off until its own flag.
run "dam_s1_off_until_its_own_flag" {
  command = plan

  variables {
    dam_observations_enabled = true
    dam_s2_enabled           = true
  }

  assert {
    condition     = aws_lambda_function.fetcher.environment[0].variables["DAM_OBSERVATIONS_S1"] == "off" && !contains(keys(aws_cloudwatch_metric_alarm.dam_pass_heartbeat), "s1") && length(aws_cloudwatch_metric_alarm.dam_recency_s1) == 0
    error_message = "Without dam_s1_enabled the fetcher runs no Sentinel-1 pass and no s1 alarm exists, even with Sentinel-2 on."
  }
}

run "dam_s1_needs_the_dam_observations_too" {
  command = plan

  variables {
    dam_s1_enabled = true
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "DAM_OBSERVATIONS_S1") && length(aws_cloudwatch_metric_alarm.dam_recency_s1) == 0 && length(aws_cloudwatch_metric_alarm.dam_pass_heartbeat) == 0
    error_message = "dam_s1_enabled alone turns nothing on: the passes need dam_observations_enabled."
  }
}

run "dam_s1_on" {
  command = plan

  variables {
    dam_observations_enabled = true
    dam_s1_enabled           = true
  }

  assert {
    condition = (
      aws_lambda_function.fetcher.environment[0].variables["DAM_OBSERVATIONS_S1"] == "on" &&
      aws_lambda_function.fetcher.environment[0].variables["DAM_OBSERVATIONS_S2"] == "off" &&
      toset(keys(aws_cloudwatch_metric_alarm.dam_pass_heartbeat)) == toset(["waterbodies", "wofs", "s1"]) &&
      aws_cloudwatch_metric_alarm.dam_pass_heartbeat["s1"].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.dam_pass_heartbeat["s1"].dimensions["Source"] == "s1" &&
      length(aws_cloudwatch_metric_alarm.dam_recency_s2) == 0
    )
    error_message = "With dam_s1_enabled the fetcher runs the Sentinel-1 pass and its heartbeat alarm reads DamPassCompleted{Source=s1}, breaching on missing data; Sentinel-2 stays off on its own flag."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dam_recency_s1[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.dam_recency_s1[0].metric_name == "DamObservationAgeDays" &&
      aws_cloudwatch_metric_alarm.dam_recency_s1[0].namespace == "water-management/DamObservations" &&
      aws_cloudwatch_metric_alarm.dam_recency_s1[0].dimensions["Source"] == "s1" &&
      aws_cloudwatch_metric_alarm.dam_recency_s1[0].threshold == 30 &&
      aws_cloudwatch_metric_alarm.dam_recency_s1[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The Sentinel-1 recency alarm reads DamObservationAgeDays{Source=s1} against dam_s1_recency_alarm_days (30) and treats missing data as breaching."
  }
}

run "dam_s1_and_s2_on_together" {
  command = plan

  variables {
    dam_observations_enabled = true
    dam_s2_enabled           = true
    dam_s1_enabled           = true
  }

  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.dam_pass_heartbeat)) == toset(["waterbodies", "wofs", "s2", "s1"]) && length(aws_cloudwatch_metric_alarm.dam_recency_s2) == 1 && length(aws_cloudwatch_metric_alarm.dam_recency_s1) == 1
    error_message = "With both Sentinel flags every source has its own heartbeat, and each Sentinel source its own recency alarm."
  }
}

run "rejects_an_s1_recency_alarm_shorter_than_the_revisit" {
  command = plan

  variables {
    dam_s1_recency_alarm_days = 10
  }

  expect_failures = [var.dam_s1_recency_alarm_days]
}
