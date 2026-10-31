# Plan-only tests (mocked providers, no AWS credentials) for the data mirror
# and its bulk ingest job (ingest.tf, issue #604 R1-D): the mirror bucket is
# private and versioned; the ingest Lambda, its schedules' targets and its
# freshness alarms exist only once ingest_image_tag is set; its role reaches
# the mirror bucket and nothing else; the worker may read the mirror, and so
# may the S3 interface endpoint's policy (without that statement every read
# from the VPC is AccessDenied); the freshness alarms treat missing data as
# breaching, so a job that stops running alarms too. Round 2 (R2-B): the
# fetcher's daily ingest (feeds.tf) and the preliminary freshness alarm stay
# off until daily_ingest_enabled is set, and the backfill state machine
# (ingest_backfill.tf) walks the months one at a time, paced, invoking only
# the ingest function. Round 3 (R3-B): the weekly DWS pass (feeds.tf) stays
# off until dws_weekly_enabled is set, and then reaches only dws/ in the
# mirror bucket (the worker only its station list).
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

run "mirror_bucket_is_private_and_versioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket.mirror.bucket == "water-management-mirror-000000000000"
    error_message = "The mirror bucket is <project>-mirror-<account>."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.mirror.bucket == aws_s3_bucket.mirror.id &&
      aws_s3_bucket_public_access_block.mirror.block_public_acls &&
      aws_s3_bucket_public_access_block.mirror.block_public_policy &&
      aws_s3_bucket_public_access_block.mirror.ignore_public_acls &&
      aws_s3_bucket_public_access_block.mirror.restrict_public_buckets
    )
    error_message = "The mirror bucket must block every kind of public access."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.mirror.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"
    error_message = "The mirror is encrypted at rest (SSE-S3)."
  }
  assert {
    condition     = one([for r in aws_s3_bucket_ownership_controls.mirror.rule : r.object_ownership]) == "BucketOwnerEnforced"
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.mirror.versioning_configuration).status == "Enabled"
    error_message = "The mirror is versioned, so a bad revision can be rolled back."
  }
  assert {
    condition = (
      length([for r in aws_s3_bucket_lifecycle_configuration.mirror.rule : r if r.id == "abort-incomplete-uploads" && r.status == "Enabled" && one(r.abort_incomplete_multipart_upload).days_after_initiation == 1 && length(r.expiration) == 0]) == 1 &&
      length([for r in aws_s3_bucket_lifecycle_configuration.mirror.rule : r if r.id == "expire-old-versions" && r.status == "Enabled" && one(r.noncurrent_version_expiration).noncurrent_days == 30 && length(r.expiration) == 1 && one(r.expiration).expired_object_delete_marker == true]) == 1 &&
      length(aws_s3_bucket_lifecycle_configuration.mirror.rule) == 2
    )
    error_message = "Old versions expire after 30 days, lone delete markers are cleaned up and incomplete uploads are aborted after a day; no other rule (current objects never expire)."
  }
  assert {
    condition = (
      aws_s3_bucket_policy.mirror.bucket == aws_s3_bucket.mirror.id &&
      length(data.aws_iam_policy_document.mirror_bucket_policy.statement) == 1 &&
      data.aws_iam_policy_document.mirror_bucket_policy.statement[0].sid == "DenyInsecureTransport" &&
      data.aws_iam_policy_document.mirror_bucket_policy.statement[0].effect == "Deny" &&
      toset(data.aws_iam_policy_document.mirror_bucket_policy.statement[0].resources) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/*"]) &&
      toset(one(data.aws_iam_policy_document.mirror_bucket_policy.statement[0].condition).values) == toset(["false"])
    )
    error_message = "The mirror's bucket policy only refuses non-TLS requests; it grants no one anything."
  }
}

# --- Off until the image exists ---------------------------------------------------

run "ingest_off_without_a_tag" {
  command = plan

  assert {
    condition = (
      length(aws_lambda_function.ingest) == 0 &&
      length(aws_lambda_function_event_invoke_config.ingest) == 0 &&
      length(aws_cloudwatch_event_target.ingest) == 0 &&
      length(aws_lambda_permission.ingest) == 0
    )
    error_message = "Without ingest_image_tag there is no ingest function, no schedule target and no invoke permission (Lambda can't be created before its image exists)."
  }
  assert {
    condition = (
      toset(keys(aws_cloudwatch_event_rule.ingest)) == toset(["rnl", "sat"]) &&
      alltrue([for r in aws_cloudwatch_event_rule.ingest : r.state == "DISABLED"])
    )
    error_message = "The schedules exist from the first apply but stay DISABLED until ingest_image_tag is set."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.mirror_lag) == 0 && length(aws_cloudwatch_metric_alarm.ingest_errors) == 0
    error_message = "No freshness or errors alarm before the job exists (a breaching freshness alarm would fire from the first apply)."
  }
  assert {
    condition = (
      aws_ecr_repository.ingest.image_tag_mutability == "IMMUTABLE" &&
      one(aws_ecr_repository.ingest.image_scanning_configuration).scan_on_push &&
      length(jsondecode(aws_ecr_lifecycle_policy.ingest.policy).rules) == 2
    )
    error_message = "The ingest repository has immutable, scanned tags, and with no pinned tag its lifecycle keeps the last 10 images."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ingest_dlq_depth) == 1 && aws_sqs_queue.ingest_dlq.sqs_managed_sse_enabled
    error_message = "The DLQ (encrypted) and its arrivals alarm exist from the first apply."
  }
}

# --- On, with a tag ------------------------------------------------------------------

run "ingest_on_with_a_tag" {
  command = plan

  variables {
    ingest_image_tag = "0.7.0-0123456789ab"
  }

  assert {
    condition = (
      aws_lambda_function.ingest[0].function_name == "water-management-mirror-ingest" &&
      aws_lambda_function.ingest[0].package_type == "Image" &&
      aws_lambda_function.ingest[0].image_uri == "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-mirror-ingest:0.7.0-0123456789ab" &&
      tolist(aws_lambda_function.ingest[0].architectures) == tolist(["arm64"]) &&
      aws_lambda_function.ingest[0].memory_size == 3008 &&
      one(aws_lambda_function.ingest[0].ephemeral_storage).size == 2048 &&
      aws_lambda_function.ingest[0].timeout == 900 &&
      aws_lambda_function.ingest[0].reserved_concurrent_executions == 2
    )
    error_message = "The ingest Lambda is the arm64 image ingest_image_tag names, 3 GB, 2 GB of /tmp, 900 s, at most 2 at once."
  }
  assert {
    condition     = length(aws_lambda_function.ingest[0].vpc_config) == 0
    error_message = "The ingest Lambda runs outside the VPC (it reaches CHC over the internet; no NAT)."
  }
  assert {
    condition = (
      aws_lambda_function.ingest[0].environment[0].variables["MIRROR_URL"] == "s3://water-management-mirror-000000000000" &&
      aws_lambda_function.ingest[0].environment[0].variables["FEED_SOURCE"] == "live" &&
      aws_lambda_function.ingest[0].environment[0].variables["INGEST_CONTACT"] == var.feeds_contact
    )
    error_message = "The job writes s3://<mirror bucket>, live, with the operator's one contact (feeds_contact) in its User-Agent."
  }
  assert {
    condition = (
      aws_lambda_function.ingest[0].role == aws_iam_role.ingest_lambda.arn &&
      aws_lambda_function.ingest[0].logging_config[0].log_group == aws_cloudwatch_log_group.ingest.name &&
      aws_cloudwatch_log_group.ingest.name == "/aws/lambda/water-management-mirror-ingest" &&
      aws_lambda_function.ingest[0].logging_config[0].log_format == "JSON"
    )
    error_message = "The job runs as its own role and logs (JSON) to its own Terraform-managed group."
  }
  assert {
    condition = (
      alltrue([for r in aws_cloudwatch_event_rule.ingest : r.state == "ENABLED"]) &&
      jsondecode(aws_cloudwatch_event_target.ingest["rnl"].input) == { product = "rnl", mode = "monthly" } &&
      jsondecode(aws_cloudwatch_event_target.ingest["sat"].input) == { product = "sat", mode = "monthly" } &&
      alltrue([for t in aws_cloudwatch_event_target.ingest : one(t.retry_policy).maximum_retry_attempts == 0]) &&
      aws_cloudwatch_event_rule.ingest["rnl"].schedule_expression != aws_cloudwatch_event_rule.ingest["sat"].schedule_expression
    )
    error_message = "With a tag the daily schedules are enabled, send each product's monthly-mode event, are never retried, and run at different times."
  }
  assert {
    condition = toset(keys(aws_lambda_permission.ingest)) == toset(["rnl", "sat"]) && alltrue([for k, p in aws_lambda_permission.ingest :
      p.principal == "events.amazonaws.com" && p.action == "lambda:InvokeFunction" && p.source_arn == aws_cloudwatch_event_rule.ingest[k].arn
    ])
    error_message = "Only each product's own rule may invoke the job."
  }
  assert {
    condition = (
      aws_lambda_function_event_invoke_config.ingest[0].maximum_retry_attempts == 0 &&
      one(one(aws_lambda_function_event_invoke_config.ingest[0].destination_config).on_failure).destination == aws_sqs_queue.ingest_dlq.arn
    )
    error_message = "A failed run is not retried (a 403 must stop it) and its event goes to the mirror-ingest DLQ."
  }
  assert {
    condition = (
      toset(keys(aws_cloudwatch_metric_alarm.mirror_lag)) == toset(["rnl", "sat"]) &&
      alltrue([for k, a in aws_cloudwatch_metric_alarm.mirror_lag :
        a.treat_missing_data == "breaching" &&
        a.namespace == "water-management/Mirror" &&
        a.metric_name == "MirrorLagDays" &&
        a.dimensions["Product"] == k &&
        a.comparison_operator == "GreaterThanThreshold" &&
        a.threshold == 75 &&
        a.period == 86400 &&
        a.alarm_actions == toset([aws_sns_topic.alerts.arn])
      ])
    )
    error_message = "Each product's freshness alarm reads water-management/Mirror MirrorLagDays{Product}, pages through the alerts topic, and treats missing data as breaching (a job that stops running alarms)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ingest_errors[0].dimensions["FunctionName"] == aws_lambda_function.ingest[0].function_name &&
      aws_cloudwatch_metric_alarm.ingest_errors[0].alarm_actions == toset([aws_sns_topic.alerts.arn]) &&
      aws_cloudwatch_metric_alarm.ingest_dlq_depth[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The job's errors and its DLQ arrivals alarm through the alerts topic."
  }
  assert {
    condition = (
      length(jsondecode(aws_ecr_lifecycle_policy.ingest.policy).rules) == 3 &&
      jsondecode(aws_ecr_lifecycle_policy.ingest.policy).rules[1].selection.tagPatternList == ["0.7.0-0123456789ab"] &&
      jsondecode(aws_ecr_lifecycle_policy.ingest.policy).rules[1].rulePriority < jsondecode(aws_ecr_lifecycle_policy.ingest.policy).rules[2].rulePriority
    )
    error_message = "ECR never expires the image ingest_image_tag pins."
  }
}

# Production runs alarm_tier "essential": the freshness alarms are in it (the
# one signal that the copy stopped moving), the errors and DLQ alarms are not.
run "essential_tier_keeps_the_freshness_alarms" {
  command = plan

  variables {
    ingest_image_tag = "0.7.0-0123456789ab"
    alarm_tier       = "essential"
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.mirror_lag) == 2 &&
      length(aws_cloudwatch_metric_alarm.backfill_failed) == 1 &&
      length(aws_cloudwatch_metric_alarm.ingest_errors) == 0 &&
      length(aws_cloudwatch_metric_alarm.ingest_dlq_depth) == 0
    )
    error_message = "alarm_tier = \"essential\" keeps the two freshness alarms and the failed-backfill alarm, and drops the ingest errors and DLQ alarms."
  }
}

# --- Least privilege -------------------------------------------------------------------

run "ingest_role_is_scoped_to_the_mirror" {
  command = plan

  assert {
    condition = (
      aws_iam_role_policy.ingest_lambda.role == aws_iam_role.ingest_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.ingest_lambda.statement : s.actions if anytrue([for a in s.actions : startswith(a, "s3:")])])) == toset(["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.ingest_lambda.statement : s.resources if anytrue([for a in s.actions : startswith(a, "s3:")])])) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/*"])
    )
    error_message = "The ingest role reads, writes, lists and deletes in the mirror bucket only."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.ingest_lambda.statement :
      s.effect != "Deny" && (
        anytrue([for a in s.actions : startswith(a, "s3:")]) ||
        (s.actions == toset(["sqs:SendMessage"]) && s.resources == toset([aws_sqs_queue.ingest_dlq.arn])) ||
        (s.actions == toset(["cloudwatch:PutMetricData"]) && one(s.condition).variable == "cloudwatch:namespace" && toset(one(s.condition).values) == toset(["water-management/Mirror"]))
      )
    ])
    error_message = "Beyond the mirror bucket the ingest role may only send to its own DLQ and publish metrics in water-management/Mirror."
  }
  assert {
    condition = (
      aws_iam_role_policy.ingest_ecr_pull.role == aws_iam_role.ingest_lambda.id &&
      length(data.aws_iam_policy_document.ingest_ecr_pull.statement) == 1 &&
      one(data.aws_iam_policy_document.ingest_ecr_pull.statement).resources == toset([aws_ecr_repository.ingest.arn]) &&
      one(data.aws_iam_policy_document.ingest_ecr.statement).condition != null
    )
    error_message = "The ingest role pulls from its own repository only."
  }
  assert {
    condition = (
      aws_iam_role_policy.lambda_logs["ingest"].role == aws_iam_role.ingest_lambda.id &&
      one(data.aws_iam_policy_document.lambda_logs["ingest"].statement).resources == toset(["arn:aws:logs:af-south-1:000000000000:log-group:/aws/lambda/water-management-mirror-ingest:*"])
    )
    error_message = "The ingest role writes to its own log group only (iam.tf)."
  }
}

run "worker_reads_the_mirror_through_the_endpoint" {
  command = plan

  assert {
    condition = (
      aws_iam_role_policy.worker_mirror.role == aws_iam_role.worker_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_mirror.statement : s.actions])) == toset(["s3:GetObject", "s3:ListBucket"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_mirror.statement : s.resources])) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/*"])
    )
    error_message = "The worker may read and list the mirror bucket, nothing more (it never writes the copy)."
  }
  assert {
    condition = length([for s in data.aws_iam_policy_document.s3_endpoint.statement : s if(
      s.sid == "WorkerReadsMirror" &&
      toset(s.actions) == toset(["s3:GetObject", "s3:ListBucket"]) &&
      toset(s.resources) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/*"]) &&
      toset(one(s.principals).identifiers) == toset([aws_iam_role.worker_lambda.arn])
    )]) == 1
    error_message = "The S3 interface endpoint's policy must name the mirror bucket for the worker, or every read from the VPC fails with AccessDenied (issue #604, What makes this hard, item 6)."
  }
}

run "deploy_role_pushes_the_ingest_image" {
  command = plan

  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid == "IngestImagePush" && toset(s.resources) == toset([aws_ecr_repository.ingest.arn]) && contains(s.actions, "ecr:PutImage")
    ])
    error_message = "The deploy role pushes the ingest image to its own repository only."
  }
  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid == "LambdaUpdate" && contains(s.resources, "arn:aws:lambda:af-south-1:000000000000:function:water-management-mirror-ingest")
    ])
    error_message = "The deploy role may move the ingest function to a release's image (by name: it exists only once ingest_image_tag is set)."
  }
  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.github_deploy.statement :
      s.sid == "IngestImageLambdaCheck" && s.actions == toset(["ecr:GetRepositoryPolicy"]) && s.resources == toset([aws_ecr_repository.ingest.arn])
    ])
    error_message = "The deploy role reads the ingest repository's policy for Lambda's check, and never writes it."
  }
}

# --- Variables -----------------------------------------------------------------------

run "rejects_an_ingest_tag_without_its_commit" {
  command = plan

  variables {
    ingest_image_tag = "0.7.0"
  }

  expect_failures = [var.ingest_image_tag]
}

run "rejects_a_lag_alarm_that_fires_on_a_healthy_copy" {
  command = plan

  variables {
    ingest_lag_alarm_days = 45
  }

  expect_failures = [var.ingest_lag_alarm_days]
}

run "the_api_judges_the_copy_by_the_lag_alarms_threshold" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["COPY_FINAL_LAG_DAYS"] == tostring(var.ingest_lag_alarm_days) && var.ingest_lag_alarm_days == 75
    error_message = "The API marks the copy's finals late at the lag alarm's own threshold (COPY_FINAL_LAG_DAYS = ingest_lag_alarm_days, 75 by default), so the Data feeds panel and the alarm agree."
  }
}

run "a_tuned_lag_alarm_moves_the_api_with_it" {
  command = plan

  variables {
    ingest_image_tag      = "0.7.0-0123456789ab"
    ingest_lag_alarm_days = 90
  }

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["COPY_FINAL_LAG_DAYS"] == "90" &&
      length(aws_cloudwatch_metric_alarm.mirror_lag) > 0 &&
      alltrue([for a in aws_cloudwatch_metric_alarm.mirror_lag : a.threshold == 90])
    )
    error_message = "A prod tfvars that tunes ingest_lag_alarm_days moves the API's COPY_FINAL_LAG_DAYS and the lag alarms together."
  }
}

run "rejects_a_lag_alarm_the_api_would_refuse" {
  command = plan

  variables {
    ingest_lag_alarm_days = 3651
  }

  expect_failures = [var.ingest_lag_alarm_days]
}

run "rejects_more_than_two_ingest_runs" {
  command = plan

  variables {
    ingest_reserved_concurrency = 3
  }

  expect_failures = [var.ingest_reserved_concurrency]
}

# --- The fetcher's daily ingest (feeds.tf, issue #604 R2-B) --------------------------

run "daily_ingest_off_by_default" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_event_rule.daily_ingest.state == "DISABLED" &&
      length(aws_cloudwatch_event_target.daily_ingest) == 0 &&
      length(aws_lambda_permission.fetcher_daily_ingest) == 0 &&
      length(aws_iam_role_policy.fetcher_mirror) == 0
    )
    error_message = "Until daily_ingest_enabled is set the daily rule is disabled, targets nothing, may invoke nothing, and the fetcher can't touch the mirror bucket beyond CHC's request slot."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.mirror_lag_prelim) == 0
    error_message = "No preliminary freshness alarm before the daily ingest is on: breaching on missing data, it would fire from the first apply."
  }
  assert {
    condition = (
      aws_cloudwatch_event_rule.gefs_ingest.state == "DISABLED" &&
      length(aws_cloudwatch_event_target.gefs_ingest) == 0 &&
      length(aws_lambda_permission.fetcher_gefs_ingest) == 0 &&
      length(aws_cloudwatch_metric_alarm.mirror_lag_gefs) == 0
    )
    error_message = "Until daily_ingest_enabled is set the GEFS pass's rule is disabled, targets nothing, may invoke nothing, and its breaching freshness alarm doesn't exist."
  }
  assert {
    condition = (
      aws_lambda_function_event_invoke_config.fetcher.maximum_retry_attempts == 0 &&
      aws_lambda_function_event_invoke_config.fetcher.function_name == aws_lambda_function.fetcher.function_name
    )
    error_message = "An asynchronous fetcher run (the daily ingest) is never retried: a 403 must stop it."
  }
  assert {
    condition     = aws_lambda_function.fetcher.environment[0].variables["MIRROR_URL"] == "s3://water-management-mirror-000000000000"
    error_message = "The fetcher knows the copy it writes (MIRROR_URL = s3://<mirror bucket>)."
  }
  # CHC's request slot (feeds.tf header, backend/src/feeds/hostSlot.ts): always,
  # since every mode that asks CHC takes it, and on that one object only.
  assert {
    condition = (
      aws_iam_role_policy.fetcher_chc_slot.role == aws_iam_role.fetcher_lambda.id &&
      length(data.aws_iam_policy_document.fetcher_chc_slot.statement) == 3 &&
      alltrue([for s in data.aws_iam_policy_document.fetcher_chc_slot.statement :
        s.effect != "Deny" && (
          (toset(s.actions) == toset(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]) && toset(s.resources) == toset(["${aws_s3_bucket.mirror.arn}/ingest-state/hosts/chc/lease.json"])) ||
          (toset(s.actions) == toset(["s3:GetObject"]) && toset(s.resources) == toset(["${aws_s3_bucket.mirror.arn}/ingest-state/hosts/chc/reserved.json"])) ||
          (toset(s.actions) == toset(["s3:ListBucket"]) && toset(s.resources) == toset([aws_s3_bucket.mirror.arn]))
        )
      ])
    )
    error_message = "The fetcher may read, create, take over and delete CHC's request slot (ingest-state/hosts/chc/lease.json), only read its reservation (reserved.json), and nothing else in the mirror bucket, daily ingest on or off."
  }
}

run "daily_ingest_on" {
  command = plan

  variables {
    daily_ingest_enabled = true
  }

  assert {
    condition = (
      aws_cloudwatch_event_rule.daily_ingest.state == "ENABLED" &&
      aws_cloudwatch_event_target.daily_ingest[0].arn == aws_lambda_function.fetcher.arn &&
      jsondecode(aws_cloudwatch_event_target.daily_ingest[0].input) == { mode = "daily-ingest" } &&
      one(aws_cloudwatch_event_target.daily_ingest[0].retry_policy).maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_rule.daily_ingest.schedule_expression != aws_cloudwatch_event_rule.ingest["rnl"].schedule_expression &&
      aws_cloudwatch_event_rule.daily_ingest.schedule_expression != aws_cloudwatch_event_rule.ingest["sat"].schedule_expression
    )
    error_message = "With daily_ingest_enabled the daily rule sends {\"mode\":\"daily-ingest\"} to the fetcher, never retried, at another time than the Python job's runs."
  }
  assert {
    condition = (
      aws_lambda_permission.fetcher_daily_ingest[0].principal == "events.amazonaws.com" &&
      aws_lambda_permission.fetcher_daily_ingest[0].source_arn == aws_cloudwatch_event_rule.daily_ingest.arn &&
      aws_lambda_permission.fetcher_daily_ingest[0].function_name == aws_lambda_function.fetcher.function_name
    )
    error_message = "Only the daily rule may invoke the fetcher on a schedule."
  }
  assert {
    condition = (
      aws_iam_role_policy.fetcher_mirror[0].role == aws_iam_role.fetcher_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_mirror.statement : s.actions])) == toset(["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_mirror.statement : s.resources])) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/*"]) &&
      alltrue([for s in data.aws_iam_policy_document.fetcher_mirror.statement : s.effect != "Deny"])
    )
    error_message = "The fetcher reads, writes, lists and deletes in the mirror bucket only (its lag metric is an embedded metric: no PutMetricData)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].namespace == "water-management/Mirror" &&
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].metric_name == "MirrorLagDays" &&
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].dimensions["Product"] == "prelim" &&
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].threshold == 12 &&
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].period == 86400 &&
      aws_cloudwatch_metric_alarm.mirror_lag_prelim[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The preliminary copy's freshness alarm reads MirrorLagDays{Product=prelim}, pages through the alerts topic, and treats missing data as breaching."
  }
  assert {
    condition = (
      aws_cloudwatch_event_rule.gefs_ingest.state == "ENABLED" &&
      aws_cloudwatch_event_target.gefs_ingest[0].arn == aws_lambda_function.fetcher.arn &&
      jsondecode(aws_cloudwatch_event_target.gefs_ingest[0].input) == { mode = "daily-ingest", pass = "gefs" } &&
      one(aws_cloudwatch_event_target.gefs_ingest[0].retry_policy).maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_rule.gefs_ingest.schedule_expression == "cron(38 8-11 * * ? *)" &&
      aws_lambda_permission.fetcher_gefs_ingest[0].principal == "events.amazonaws.com" &&
      aws_lambda_permission.fetcher_gefs_ingest[0].source_arn == aws_cloudwatch_event_rule.gefs_ingest.arn &&
      aws_lambda_permission.fetcher_gefs_ingest[0].function_name == aws_lambda_function.fetcher.function_name
    )
    error_message = "With daily_ingest_enabled the GEFS rule sends {\"mode\":\"daily-ingest\",\"pass\":\"gefs\"} to the fetcher at 08:38 UTC (before the 08:45 forecast feeds) and hourly to 11:38, never retried, and only it may invoke for that."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].namespace == "water-management/Mirror" &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].metric_name == "MirrorLagDays" &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].dimensions["Product"] == "gefs" &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].threshold == 2 &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].period == 86400 &&
      aws_cloudwatch_metric_alarm.mirror_lag_gefs[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The forecast copy's freshness alarm reads MirrorLagDays{Product=gefs}, fires at 2 days (neither today's nor yesterday's issue held), pages through the alerts topic, and treats missing data as breaching."
  }
  assert {
    condition     = length(aws_lambda_function.ingest) == 0 && length(aws_cloudwatch_metric_alarm.mirror_lag) == 0
    error_message = "The daily ingest is the Node fetcher's: turning it on doesn't need (or create) the Python ingest function or its alarms."
  }
}

# --- The climate indices pass (climate_indices.tf, issue #620) -------------------------

run "climate_indices_off_by_default" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_event_rule.indices_ingest.state == "DISABLED" &&
      length(aws_cloudwatch_event_target.indices_ingest) == 0 &&
      length(aws_lambda_permission.fetcher_indices_ingest) == 0 &&
      length(aws_iam_role_policy.fetcher_indices) == 0 &&
      length(aws_cloudwatch_metric_alarm.mirror_lag_indices) == 0
    )
    error_message = "Until climate_indices_enabled is set the indices rule is disabled, targets nothing, may invoke nothing, the fetcher can't write indices/, and its breaching freshness alarm doesn't exist."
  }
}

run "climate_indices_on" {
  command = plan

  variables {
    climate_indices_enabled = true
  }

  assert {
    condition = (
      aws_cloudwatch_event_rule.indices_ingest.state == "ENABLED" &&
      aws_cloudwatch_event_target.indices_ingest[0].arn == aws_lambda_function.fetcher.arn &&
      jsondecode(aws_cloudwatch_event_target.indices_ingest[0].input) == { mode = "daily-ingest", pass = "indices" } &&
      one(aws_cloudwatch_event_target.indices_ingest[0].retry_policy).maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_rule.indices_ingest.schedule_expression == "cron(50 5 * * ? *)" &&
      aws_lambda_permission.fetcher_indices_ingest[0].principal == "events.amazonaws.com" &&
      aws_lambda_permission.fetcher_indices_ingest[0].source_arn == aws_cloudwatch_event_rule.indices_ingest.arn &&
      aws_lambda_permission.fetcher_indices_ingest[0].function_name == aws_lambda_function.fetcher.function_name
    )
    error_message = "With climate_indices_enabled the indices rule sends {\"mode\":\"daily-ingest\",\"pass\":\"indices\"} to the fetcher once a day at 05:50 UTC, never retried, and only it may invoke for that."
  }
  assert {
    condition = (
      aws_iam_role_policy.fetcher_indices[0].role == aws_iam_role.fetcher_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_indices.statement : s.actions])) == toset(["s3:GetObject", "s3:PutObject", "s3:ListBucket"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_indices.statement : s.resources])) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/indices/*"]) &&
      length(aws_iam_role_policy.fetcher_mirror) == 0
    )
    error_message = "The indices pass reads and writes indices/ in the mirror bucket only (no delete), without turning on the daily ingest's whole-bucket write."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mirror_lag_indices[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.mirror_lag_indices[0].namespace == "water-management/Mirror" &&
      aws_cloudwatch_metric_alarm.mirror_lag_indices[0].metric_name == "MirrorLagDays" &&
      aws_cloudwatch_metric_alarm.mirror_lag_indices[0].dimensions["Product"] == "indices" &&
      aws_cloudwatch_metric_alarm.mirror_lag_indices[0].threshold == 75 &&
      aws_cloudwatch_metric_alarm.mirror_lag_indices[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The indices copy's freshness alarm reads MirrorLagDays{Product=indices}, fires at 75 days, pages through the alerts topic, and treats missing data as breaching."
  }
  assert {
    condition = alltrue([
      for r in [aws_cloudwatch_event_rule.daily_ingest, aws_cloudwatch_event_rule.gefs_ingest, aws_cloudwatch_event_rule.dws_weekly, aws_cloudwatch_event_rule.dams_weekly, aws_cloudwatch_event_rule.et_dekadal] :
      r.schedule_expression != aws_cloudwatch_event_rule.indices_ingest.schedule_expression
    ])
    error_message = "The indices pass runs at its own time, not on another fetcher pass's schedule."
  }
}

run "essential_tier_keeps_the_prelim_freshness_alarm" {
  command = plan

  variables {
    daily_ingest_enabled = true
    alarm_tier           = "essential"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.mirror_lag_prelim) == 1 && length(aws_cloudwatch_metric_alarm.mirror_lag_gefs) == 1
    error_message = "alarm_tier = \"essential\" keeps the preliminary and forecast copies' freshness alarms."
  }
}

run "no_alarm_tier_drops_the_prelim_freshness_alarm" {
  command = plan

  variables {
    daily_ingest_enabled = true
    alarm_tier           = "none"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.mirror_lag_prelim) == 0
    error_message = "alarm_tier = \"none\" creates no alarm, the preliminary freshness one included."
  }
}

run "rejects_a_prelim_lag_alarm_that_fires_on_a_healthy_copy" {
  command = plan

  variables {
    daily_ingest_lag_alarm_days = 7
  }

  expect_failures = [var.daily_ingest_lag_alarm_days]
}

# --- The backfill (ingest_backfill.tf, issue #604 R2-B) -------------------------------

run "backfill_off_without_the_ingest_function" {
  command = plan

  assert {
    condition = (
      length(aws_sfn_state_machine.ingest_backfill) == 0 &&
      length(aws_iam_role.ingest_backfill) == 0 &&
      length(aws_iam_role_policy.ingest_backfill) == 0 &&
      length(aws_cloudwatch_metric_alarm.backfill_failed) == 0
    )
    error_message = "No backfill state machine (or its role) before the ingest function exists."
  }
}

run "backfill_one_month_at_a_time_paced_and_never_retrying_a_refusal" {
  command = plan

  variables {
    ingest_image_tag = "0.7.0-0123456789ab"
  }

  assert {
    condition = (
      aws_sfn_state_machine.ingest_backfill[0].name == "water-management-mirror-backfill" &&
      aws_sfn_state_machine.ingest_backfill[0].type == "STANDARD" &&
      aws_sfn_state_machine.ingest_backfill[0].role_arn == aws_iam_role.ingest_backfill[0].arn
    )
    error_message = "The backfill is a Standard state machine running as its own role."
  }
  assert {
    condition = (
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.Type == "Map" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemsPath == "$.items" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.MaxConcurrency == 1
    )
    error_message = "The months run one at a time (MaxConcurrency = 1): a finals chunk holds a whole year, so two months of one year at once would lose one."
  }
  assert {
    condition = (
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Resource == "arn:aws:states:::lambda:invoke" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Parameters.FunctionName == "arn:aws:lambda:af-south-1:000000000000:function:water-management-mirror-ingest" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Next == "Pace" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Pace.Type == "Wait" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Pace.Seconds >= 60
    )
    error_message = "Each month invokes the ingest function, then waits at least 60 s (D4: one CHC file a minute)."
  }
  assert {
    condition = alltrue([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry :
      alltrue([for e in r.ErrorEquals : (startswith(e, "Lambda.") && e != "Lambda.Unknown") || e == "MirrorBusy" || e == "HostBusy" || e == "TruncatedDownload" || e == "RetryLater"])
    ])
    error_message = "Only Lambda's own service errors, MirrorBusy, HostBusy, TruncatedDownload and RetryLater are retried: never States.ALL, States.TaskFailed or StopRun, so a month that met HTTP 403 fails the execution at once."
  }
  assert {
    condition = anytrue([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry :
      r.ErrorEquals == ["TruncatedDownload"] && r.IntervalSeconds >= 60 && r.MaxAttempts >= 1 && r.MaxAttempts <= 5
    ])
    error_message = "A month whose file kept ending early (polite.py TruncatedDownload, a dropped connection) is retried a bounded number of times, at least a minute apart (D4), instead of ending the execution."
  }
  assert {
    condition = anytrue([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry :
      r.ErrorEquals == ["RetryLater"] && r.IntervalSeconds >= 600 && r.BackoffRate >= 1 && r.MaxAttempts >= 1 && r.MaxAttempts <= 5
    ])
    error_message = "A month that CHC kept answering 429/503 (polite.py RetryLater) is retried a bounded number of times, at least 10 minutes apart (CHC asking us to slow down), instead of ending the execution (2026-10-31)."
  }
  assert {
    condition     = length([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry : r if contains(r.ErrorEquals, "RetryLater") || contains(r.ErrorEquals, "TruncatedDownload")]) == 2 && !anytrue([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry : contains(r.ErrorEquals, "RetryLater") && contains(r.ErrorEquals, "TruncatedDownload")])
    error_message = "TruncatedDownload and RetryLater each have their own rule (Step Functions matches the exact error name, not polite.py's class hierarchy), so a dropped connection keeps its shorter waits."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.backfill_failed[0].alarm_name == "water-management-mirror-backfill-failed" &&
      aws_cloudwatch_metric_alarm.backfill_failed[0].namespace == "AWS/States" &&
      aws_cloudwatch_metric_alarm.backfill_failed[0].metric_name == "ExecutionsFailed" &&
      aws_cloudwatch_metric_alarm.backfill_failed[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.backfill_failed[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.backfill_failed[0].treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.backfill_failed[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "A failed backfill execution alarms to the alerts topic (the mirror-lag alarms are in ALARM throughout a backfill, so they can't say it stopped)."
  }
  assert {
    condition = anytrue([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry :
      contains(r.ErrorEquals, "MirrorBusy") && r.IntervalSeconds * r.MaxAttempts >= 1200
    ])
    error_message = "A month that meets the daily run's lease (MirrorBusy) is retried for longer than the lease's 20 minutes, not failed."
  }
  assert {
    condition = anytrue([for r in jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Retry :
      contains(r.ErrorEquals, "HostBusy") && r.IntervalSeconds * r.MaxAttempts >= 3600 && r.IntervalSeconds >= 60
    ])
    error_message = "A month that meets the fetcher holding CHC's request slot (HostBusy) waits it out, at least a minute between tries, for longer than a fetch's 900 s: it is not failed."
  }
  assert {
    condition = (
      aws_iam_role_policy.ingest_backfill[0].role == aws_iam_role.ingest_backfill[0].id &&
      length(data.aws_iam_policy_document.ingest_backfill.statement) == 1 &&
      one(data.aws_iam_policy_document.ingest_backfill.statement).actions == toset(["lambda:InvokeFunction"]) &&
      one(data.aws_iam_policy_document.ingest_backfill.statement).resources == toset([
        "arn:aws:lambda:af-south-1:000000000000:function:water-management-mirror-ingest",
        "arn:aws:lambda:af-south-1:000000000000:function:water-management-mirror-ingest:*",
      ])
    )
    error_message = "The backfill role may invoke the ingest function and nothing else."
  }
  # The execution's hold on CHC's request slot (issue #618 step 4; ingest/lease.py hold_host_for_backfill).
  assert {
    condition = (
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.ItemProcessor.States.Ingest.Parameters.Payload == {
        "product.$" = "$.product"
        "mode.$"    = "$.mode"
        "month.$"   = "$.month"
        hold        = { "execution.$" = "$$.Execution.Id", pauseSeconds = 60 }
      }
    )
    error_message = "Each month names its execution and the pause after it (the Pace's seconds), so every month of one execution holds CHC's slot as one owner through the pauses."
  }
  assert {
    condition = (
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.Next == "ReleaseHold" &&
      one(jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.Catch).ErrorEquals == ["States.ALL"] &&
      one(jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.Catch).ResultPath == "$.error" &&
      one(jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Months.Catch).Next == "ReleaseHold" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.ReleaseHold.Parameters.FunctionName == "arn:aws:lambda:af-south-1:000000000000:function:water-management-mirror-ingest" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.ReleaseHold.Parameters.Payload == { mode = "release_hold", hold = { "execution.$" = "$$.Execution.Id" } } &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.ReleaseHold.Next == "Outcome" &&
      one(jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.ReleaseHold.Catch).Next == "Outcome"
    )
    error_message = "The execution's hold is released after the months, on success and (through the Map's Catch) on failure, and a failed release doesn't change the outcome."
  }
  assert {
    condition = (
      one(jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Outcome.Choices).Variable == "$.error" &&
      one(jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Outcome.Choices).Next == "MonthFailed" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.MonthFailed.Type == "Fail" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.MonthFailed.ErrorPath == "$.error.Error" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Outcome.Default == "Done" &&
      jsondecode(aws_sfn_state_machine.ingest_backfill[0].definition).States.Done.Type == "Succeed"
    )
    error_message = "A month that failed (a 403 above all) still fails the execution, with its own error, after the release."
  }
}

run "rejects_a_backfill_faster_than_a_file_a_minute" {
  command = plan

  variables {
    ingest_backfill_wait_seconds = 30
  }

  expect_failures = [var.ingest_backfill_wait_seconds]
}

run "rejects_a_backfill_pause_longer_than_the_hold_accepts" {
  command = plan

  variables {
    ingest_backfill_wait_seconds = 3601
  }

  expect_failures = [var.ingest_backfill_wait_seconds]
}

# --- The weekly DWS pass (feeds.tf, issue #604 R3-B) ---------------------------------

run "dws_weekly_off_by_default" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_event_rule.dws_weekly.state == "DISABLED" &&
      length(aws_cloudwatch_event_target.dws_weekly) == 0 &&
      length(aws_lambda_permission.fetcher_dws_weekly) == 0 &&
      length(aws_iam_role_policy.fetcher_dws) == 0 &&
      length(aws_iam_role_policy.worker_dws) == 0 &&
      length(aws_cloudwatch_metric_alarm.mirror_lag_dws) == 0
    )
    error_message = "Until dws_weekly_enabled is set the DWS rule is disabled, targets nothing, may invoke nothing, neither Lambda may write dws/, and no freshness alarm fires for a pass that doesn't exist."
  }
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["DWS_SOURCE"] == "live" &&
      aws_lambda_function.worker.environment[0].variables["DWS_WEEKLY"] == "off"
    )
    error_message = "By default DWS feeds read DWS's page (DWS_SOURCE=live) and the worker hands nothing to a weekly pass (DWS_WEEKLY=off)."
  }
}

run "dws_weekly_on" {
  command = plan

  variables {
    dws_weekly_enabled = true
    dws_source         = "store"
  }

  assert {
    condition = (
      aws_cloudwatch_event_rule.dws_weekly.state == "ENABLED" &&
      aws_cloudwatch_event_target.dws_weekly[0].arn == aws_lambda_function.fetcher.arn &&
      jsondecode(aws_cloudwatch_event_target.dws_weekly[0].input) == { mode = "dws-weekly" } &&
      one(aws_cloudwatch_event_target.dws_weekly[0].retry_policy).maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_rule.dws_weekly.schedule_expression != aws_cloudwatch_event_rule.daily_ingest.schedule_expression
    )
    error_message = "With dws_weekly_enabled the DWS rule sends {\"mode\":\"dws-weekly\"} to the fetcher, never retried, at another time than the daily ingest."
  }
  assert {
    condition = (
      aws_lambda_permission.fetcher_dws_weekly[0].principal == "events.amazonaws.com" &&
      aws_lambda_permission.fetcher_dws_weekly[0].statement_id == "AllowEventBridgeDwsWeekly" &&
      can(regex("source_arn\\s*=\\s*aws_cloudwatch_event_rule\\.dws_weekly\\.arn", regex("(?s)resource \"aws_lambda_permission\" \"fetcher_dws_weekly\" \\{.*?\\n\\}", file("feeds.tf"))))
    )
    error_message = "Only the DWS rule may invoke the fetcher for the weekly pass."
  }
  assert {
    condition = (
      aws_iam_role_policy.fetcher_dws[0].role == aws_iam_role.fetcher_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_dws.statement : s.actions])) == toset(["s3:GetObject", "s3:PutObject", "s3:ListBucket"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_dws.statement : s.resources])) == toset([aws_s3_bucket.mirror.arn, "${aws_s3_bucket.mirror.arn}/dws/*"])
    )
    error_message = "The fetcher's weekly pass reads and writes dws/ in the mirror bucket only (no delete, nothing of the CHIRPS copy)."
  }
  assert {
    condition = (
      aws_iam_role_policy.worker_dws[0].role == aws_iam_role.worker_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_dws.statement : s.actions])) == toset(["s3:PutObject"]) &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_dws.statement : s.resources])) == toset(["${aws_s3_bucket.mirror.arn}/dws/stations.json"])
    )
    error_message = "The worker's one write to the mirror bucket is the station list."
  }
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["DWS_SOURCE"] == "store" &&
      aws_lambda_function.worker.environment[0].variables["DWS_WEEKLY"] == "on"
    )
    error_message = "The worker reads DWS from the store when dws_source says so, and runs the handover (DWS_WEEKLY=on)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].namespace == "water-management/Mirror" &&
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].metric_name == "MirrorLagDays" &&
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].dimensions["Product"] == "dws" &&
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].threshold == 10 &&
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].period == 86400 &&
      aws_cloudwatch_metric_alarm.mirror_lag_dws[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The DWS pass's freshness alarm reads MirrorLagDays{Product=dws}, pages through the alerts topic, and treats missing data as breaching."
  }
}

run "rejects_a_dws_lag_alarm_that_fires_on_a_healthy_pass" {
  command = plan

  variables {
    dws_weekly_lag_alarm_days = 7
  }

  expect_failures = [var.dws_weekly_lag_alarm_days]
}

run "rejects_an_unknown_dws_source" {
  command = plan

  variables {
    dws_source = "web"
  }

  expect_failures = [var.dws_source]
}

# --- The future climate (issue #621, FUTURE_YIELD) ---------------------------

run "future_yield_off_by_default" {
  command = plan

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["FUTURE_YIELD"] == "off" &&
      aws_lambda_function.worker.environment[0].variables["FUTURE_YIELD"] == "off"
    )
    error_message = "Until future_yield_enabled is set the API queues no future_yield or climate_factors job and puts no § 8 in a report, and the worker runs none (FUTURE_YIELD=off on both)."
  }
}

run "future_yield_on" {
  command = plan

  variables {
    future_yield_enabled = true
  }

  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["FUTURE_YIELD"] == "on" &&
      aws_lambda_function.worker.environment[0].variables["FUTURE_YIELD"] == "on"
    )
    error_message = "With future_yield_enabled the API and the worker agree: FUTURE_YIELD=on on both, so a job the API queues is one the worker runs."
  }
  assert {
    condition     = startswith(aws_lambda_function.worker.environment[0].variables["MIRROR_URL"], "s3://")
    error_message = "The future climate's jobs read cmip6/ from the copy: the worker's MIRROR_URL names the mirror bucket (the production check requires it with FUTURE_YIELD=on)."
  }
}
