# Plan-only tests (mocked providers, no AWS credentials) for the cutover's
# Terraform (issue #604 R3-C; feeds.tf local.per_feed_fetching): per-feed
# fetching (the fetch-requests and ingest-results queues, their DLQs and
# alarms, both SQS triggers, the roles' queue grants, the SQS endpoint's
# statement, the worker's FEED_FETCHER / FETCH_REQUESTS_QUEUE_URL and the
# fetcher's INGEST_RESULTS_QUEUE_URL) stays while either flag is on its old
# value, and goes only with chirps_source = "mirror" and dws_source = "store".
# The fetcher itself stays either way, for its scheduled modes.
#
# Station API feeds (issue #784): with station_api_feeds on, per-feed fetching
# stays after the cutover (a station's own API can't be read from our copy),
# and the fetcher gets its own runtime secret, the credential-opening key, with
# GetSecretValue on exactly that secret; the API gets the public key. Off (the
# default), the fetcher holds no secret.
#
# The mocks, overrides and variables below are copied from
# chirps_source.tftest.hcl (a test file can't share them); keep them in step.
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

# Station API feeds' own fetch queue and DLQ (feeds.tf), only with station_api_feeds on.
override_resource {
  target          = aws_sqs_queue.station_fetch_requests
  override_during = plan
  values = {
    arn  = "arn:aws:sqs:af-south-1:000000000000:water-management-station-fetch-requests.fifo"
    url  = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-station-fetch-requests.fifo"
    name = "water-management-station-fetch-requests.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.station_fetch_requests_dlq
  override_during = plan
  values = {
    arn  = "arn:aws:sqs:af-south-1:000000000000:water-management-station-fetch-requests-dlq.fifo"
    url  = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-station-fetch-requests-dlq.fifo"
    name = "water-management-station-fetch-requests-dlq.fifo"
  }
}

# The fetcher's, only with station_api_feeds on (secrets.tf).
override_resource {
  target          = aws_secretsmanager_secret.runtime["fetcher"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/fetcher-FfFfFf"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/fetcher-FfFfFf"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["fetcher"]
  override_during = plan
  values = {
    version_id = "ffffffff-0000-0000-0000-000000000006"
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

# --- Per-feed fetching on: the default, and either flag alone ---------------------------

run "per_feed_fetching_by_default" {
  command = plan

  assert {
    condition = (
      length(aws_sqs_queue.fetch_requests) == 1 && length(aws_sqs_queue.fetch_requests_dlq) == 1 &&
      length(aws_sqs_queue.ingest_results) == 1 && length(aws_sqs_queue.ingest_results_dlq) == 1 &&
      length(aws_lambda_event_source_mapping.fetcher_requests) == 1 &&
      length(aws_lambda_event_source_mapping.worker_ingest_results) == 1 &&
      length(aws_iam_role_policy.fetcher_lambda) == 1 && length(aws_iam_role_policy.worker_feeds) == 1
    )
    error_message = "Until the cutover the queues, their triggers and the roles' grants exist."
  }
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["FEED_FETCHER"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["FETCH_REQUESTS_QUEUE_URL"] == aws_sqs_queue.fetch_requests[0].url &&
      aws_lambda_function.fetcher.environment[0].variables["INGEST_RESULTS_QUEUE_URL"] == aws_sqs_queue.ingest_results[0].url
    )
    error_message = "Until the cutover the worker sends fetches to the fetcher, which answers on ingest-results."
  }
  assert {
    condition     = contains([for s in data.aws_iam_policy_document.sqs_endpoint.statement : s.sid], "WorkerSendsFetchRequests")
    error_message = "Until the cutover the SQS endpoint lets the worker send fetch requests."
  }
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth) == 1 &&
      length(aws_cloudwatch_metric_alarm.ingest_results_dlq_depth) == 1 &&
      length(aws_cloudwatch_metric_alarm.fetch_requests_age) == 1 &&
      length(aws_cloudwatch_metric_alarm.feed_fetch_failed) == 1
    )
    error_message = "Until the cutover the queues' alarms and the failed-fetch alarm exist (alarm_tier full)."
  }
}

run "per_feed_fetching_with_chirps_on_the_copy_only" {
  command = plan

  variables {
    chirps_source = "mirror"
  }

  assert {
    condition = (
      length(aws_sqs_queue.fetch_requests) == 1 &&
      aws_lambda_function.worker.environment[0].variables["FEED_FETCHER"] == "sqs" &&
      length(aws_lambda_event_source_mapping.fetcher_requests) == 1
    )
    error_message = "DWS still fetches per feed (dws_source = live): the queues stay."
  }
}

run "per_feed_fetching_with_dws_on_the_store_only" {
  command = plan

  variables {
    dws_source = "store"
  }

  assert {
    condition = (
      length(aws_sqs_queue.ingest_results) == 1 &&
      aws_lambda_function.worker.environment[0].variables["FEED_FETCHER"] == "sqs" &&
      length(aws_lambda_event_source_mapping.worker_ingest_results) == 1
    )
    error_message = "CHIRPS still fetches per feed (chirps_source = chc): the queues stay."
  }
}

# --- Both flags on the new values: per-feed fetching retired --------------------------

run "cutover_removes_per_feed_fetching" {
  command = plan

  variables {
    chirps_source = "mirror"
    dws_source    = "store"
  }

  assert {
    condition = (
      length(aws_sqs_queue.fetch_requests) == 0 && length(aws_sqs_queue.fetch_requests_dlq) == 0 &&
      length(aws_sqs_queue.ingest_results) == 0 && length(aws_sqs_queue.ingest_results_dlq) == 0 &&
      length(aws_sqs_queue_redrive_allow_policy.fetch_requests_dlq) == 0 &&
      length(aws_sqs_queue_redrive_allow_policy.ingest_results_dlq) == 0
    )
    error_message = "After the cutover there are no fetch-requests or ingest-results queues, nor their DLQs."
  }
  assert {
    condition = (
      length(aws_lambda_event_source_mapping.fetcher_requests) == 0 &&
      length(aws_lambda_event_source_mapping.worker_ingest_results) == 0 &&
      length(aws_iam_role_policy.fetcher_lambda) == 0 && length(aws_iam_role_policy.worker_feeds) == 0
    )
    error_message = "After the cutover neither Lambda has an SQS trigger or a grant on the feed queues."
  }
  assert {
    condition = (
      !contains(keys(aws_lambda_function.worker.environment[0].variables), "FEED_FETCHER") &&
      !contains(keys(aws_lambda_function.worker.environment[0].variables), "FETCH_REQUESTS_QUEUE_URL") &&
      !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "INGEST_RESULTS_QUEUE_URL")
    )
    error_message = "After the cutover the worker has no FEED_FETCHER or queue URL, and the fetcher no answer queue."
  }
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["CHIRPS_SOURCE"] == "mirror" &&
      aws_lambda_function.worker.environment[0].variables["DWS_SOURCE"] == "store"
    )
    error_message = "The worker reads the copy and the store."
  }
  assert {
    condition     = !contains([for s in data.aws_iam_policy_document.sqs_endpoint.statement : s.sid], "WorkerSendsFetchRequests")
    error_message = "After the cutover the SQS endpoint has no statement for a queue that doesn't exist."
  }
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth) == 0 &&
      length(aws_cloudwatch_metric_alarm.ingest_results_dlq_depth) == 0 &&
      length(aws_cloudwatch_metric_alarm.fetch_requests_age) == 0 &&
      length(aws_cloudwatch_log_metric_filter.feed_fetch_failed) == 0 &&
      length(aws_cloudwatch_metric_alarm.feed_fetch_failed) == 0
    )
    error_message = "After the cutover the queues' alarms and the failed-fetch alarm (only the per-feed mode logs it) are gone."
  }
  # Positive control: the fetcher stays for its scheduled modes, with its errors alarm.
  assert {
    condition = (
      aws_lambda_function.fetcher.function_name == "water-management-fetcher" &&
      aws_lambda_function.fetcher.environment[0].variables["FEED_SOURCE"] == "live" &&
      length(aws_cloudwatch_metric_alarm.fetcher_errors) == 1
    )
    error_message = "The fetcher Lambda stays after the cutover (daily ingest, GEFS and DWS weekly passes)."
  }
}

run "cutover_with_essential_alarms" {
  command = plan

  variables {
    chirps_source = "mirror"
    dws_source    = "store"
    alarm_tier    = "essential"
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth) == 0 &&
      length(aws_cloudwatch_metric_alarm.ingest_results_dlq_depth) == 0 &&
      length(aws_cloudwatch_metric_alarm.jobs_dlq_depth) == 1
    )
    error_message = "The essential tier loses the two feed-queue DLQ alarms after the cutover, and keeps the rest (the jobs DLQ's, positive control)."
  }
}

# ---------------------------------------------------------------------------
# Station API feeds (issue #784)
# ---------------------------------------------------------------------------

run "station_api_feeds_off_by_default" {
  command = plan

  assert {
    condition = (
      !contains(keys(aws_secretsmanager_secret.runtime), "fetcher") &&
      !contains(keys(aws_iam_role_policy.runtime_secret), "fetcher") &&
      !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "RUNTIME_SECRET_ARN") &&
      !contains(keys(aws_lambda_function.fetcher.environment[0].variables), "RUNTIME_SECRET_VERSION")
    )
    error_message = "Without station API feeds the fetcher has no runtime secret, no grant on one, and names none."
  }
  assert {
    condition = (
      length(aws_sqs_queue.station_fetch_requests) == 0 && length(aws_sqs_queue.station_fetch_requests_dlq) == 0 &&
      length(aws_lambda_event_source_mapping.fetcher_station_requests) == 0 &&
      length(aws_iam_role_policy.fetcher_station_queue) == 0 && length(aws_iam_role_policy.worker_station_queue) == 0 &&
      length(aws_cloudwatch_metric_alarm.station_fetch_requests_dlq_depth) == 0 && length(aws_cloudwatch_metric_alarm.station_fetch_requests_age) == 0 &&
      !contains(keys(aws_lambda_function.worker.environment[0].variables), "STATION_FETCH_REQUESTS_QUEUE_URL") &&
      !contains([for s in data.aws_iam_policy_document.sqs_endpoint.statement : s.sid], "WorkerSendsStationFetchRequests")
    )
    error_message = "Without station API feeds there is no station fetch queue, DLQ, trigger, grant, alarm, endpoint statement or worker setting."
  }
  assert {
    condition     = aws_lambda_function.fetcher.reserved_concurrent_executions == var.fetcher_reserved_concurrency && var.fetcher_reserved_concurrency == 2
    error_message = "Without station API feeds the fetcher's reserved concurrency is fetcher_reserved_concurrency (2 by default), unchanged."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["STATION_API_FEEDS"] == "off" &&
      aws_lambda_function.worker.environment[0].variables["STATION_API_FEEDS"] == "off" &&
      aws_lambda_function.fetcher.environment[0].variables["STATION_API_FEEDS"] == "off" &&
      aws_lambda_function.backend.environment[0].variables["FEED_CREDENTIAL_PUBLIC_KEY"] == ""
    )
    error_message = "Station API feeds are off on the API, the worker and the fetcher by default, with no public key."
  }
  # Positive control for the run below: the other three secrets are there.
  assert {
    condition     = toset(keys(aws_secretsmanager_secret.runtime)) == toset(["api", "worker", "migrate"])
    error_message = "The API, worker and migrate secrets exist either way."
  }
}

run "station_api_feeds_keep_per_feed_fetching_after_the_cutover" {
  command = plan

  variables {
    chirps_source               = "mirror"
    dws_source                  = "store"
    station_api_feeds           = true
    feed_credential_public_key  = "synthetic-feed-public-key-0000000000000000A"
    feed_credential_private_key = "synthetic-feed-private-key-000000000000000A"
  }

  # The queues, triggers and the worker's hand-off stay: the station's API is fetched by the fetcher.
  assert {
    condition = (
      length(aws_sqs_queue.fetch_requests) == 1 && length(aws_sqs_queue.ingest_results) == 1 &&
      length(aws_lambda_event_source_mapping.fetcher_requests) == 1 &&
      length(aws_lambda_event_source_mapping.worker_ingest_results) == 1 &&
      aws_lambda_function.worker.environment[0].variables["FEED_FETCHER"] == "sqs" &&
      aws_lambda_function.worker.environment[0].variables["FETCH_REQUESTS_QUEUE_URL"] == aws_sqs_queue.fetch_requests[0].url &&
      aws_lambda_function.fetcher.environment[0].variables["INGEST_RESULTS_QUEUE_URL"] == aws_sqs_queue.ingest_results[0].url
    )
    error_message = "With station API feeds on, per-feed fetching stays after the cutover: both queues, both triggers, the worker's FEED_FETCHER=sqs and the fetcher's answer queue."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["STATION_API_FEEDS"] == "on" &&
      aws_lambda_function.worker.environment[0].variables["STATION_API_FEEDS"] == "on" &&
      aws_lambda_function.fetcher.environment[0].variables["STATION_API_FEEDS"] == "on" &&
      aws_lambda_function.backend.environment[0].variables["FEED_CREDENTIAL_PUBLIC_KEY"] == var.feed_credential_public_key &&
      aws_lambda_function.fetcher.environment[0].variables["FEED_CREDENTIAL_PUBLIC_KEY"] == var.feed_credential_public_key
    )
    error_message = "On: STATION_API_FEEDS=on on the API, the worker and the fetcher, and the public key on the API (it seals) and the fetcher (its pairing check)."
  }

  # The fetcher's own runtime secret: the private key alone, written write-only, named by ARN and version.
  assert {
    condition = (
      toset(keys(local.runtime_secrets.fetcher)) == toset(["FEED_CREDENTIAL_PRIVATE_KEY"]) &&
      local.runtime_secrets.fetcher.FEED_CREDENTIAL_PRIVATE_KEY == var.feed_credential_private_key &&
      ephemeralasnull(local.runtime_secrets.fetcher.FEED_CREDENTIAL_PRIVATE_KEY) == null &&
      aws_secretsmanager_secret.runtime["fetcher"].name == "water-management/runtime/fetcher" &&
      aws_secretsmanager_secret_version.runtime["fetcher"].secret_string == null &&
      aws_secretsmanager_secret_version.runtime["fetcher"].secret_string_wo_version == var.runtime_secret_version
    )
    error_message = "The fetcher's runtime secret holds exactly FEED_CREDENTIAL_PRIVATE_KEY from its ephemeral sops variable, written write-only."
  }
  assert {
    condition = (
      aws_lambda_function.fetcher.environment[0].variables["RUNTIME_SECRET_ARN"] == aws_secretsmanager_secret.runtime["fetcher"].arn &&
      aws_lambda_function.fetcher.environment[0].variables["RUNTIME_SECRET_VERSION"] == aws_secretsmanager_secret_version.runtime["fetcher"].version_id
    )
    error_message = "The fetcher names its own runtime secret and the version Terraform wrote."
  }
  # The key itself is in no environment block.
  assert {
    condition = alltrue(flatten([
      for f in [aws_lambda_function.backend, aws_lambda_function.worker, aws_lambda_function.fetcher] : [
        for k in keys(f.environment[0].variables) : !can(regex("PRIVATE_KEY", k))
      ]
    ]))
    error_message = "No environment block holds the credential-opening key: it is the fetcher's runtime secret alone."
  }
  # No proxy can route around the station client's pinned, checked lookup.
  assert {
    condition = alltrue([
      for k in keys(aws_lambda_function.fetcher.environment[0].variables) : !contains(["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NODE_USE_ENV_PROXY", "NO_PROXY", "NODE_OPTIONS"], k)
    ])
    error_message = "The fetcher sets no proxy (a proxy resolves the name itself, past the station client's pinned, checked lookup) and no NODE_OPTIONS."
  }

  # IAM: GetSecretValue on its own secret only, on its own role; the worker's grant stays its own.
  assert {
    condition = (
      length(data.aws_iam_policy_document.runtime_secret["fetcher"].statement) == 1 &&
      toset(data.aws_iam_policy_document.runtime_secret["fetcher"].statement[0].actions) == toset(["secretsmanager:GetSecretValue"]) &&
      toset(data.aws_iam_policy_document.runtime_secret["fetcher"].statement[0].resources) == toset([aws_secretsmanager_secret.runtime["fetcher"].arn]) &&
      aws_iam_role_policy.runtime_secret["fetcher"].role == aws_iam_role.fetcher_lambda.id &&
      aws_iam_role_policy.runtime_secret["worker"].role == aws_iam_role.worker_lambda.id
    )
    error_message = "The fetcher may read its own runtime secret, and nothing else; the worker's grant stays on the worker's role."
  }
  assert {
    condition     = !contains([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement : s.sid], "ReadRuntimeSecretFetcher") && contains([for s in data.aws_iam_policy_document.secretsmanager_endpoint.statement : s.sid], "ReadRuntimeSecretWorker")
    error_message = "The private VPC's Secrets Manager endpoint doesn't admit the fetcher (it is outside the VPC, on the public endpoint); the worker's statement stays (positive control)."
  }
  # Station fetches apart: their own FIFO queue, DLQ and trigger, and the fetcher's ceiling raised by exactly that trigger's 2.
  assert {
    condition = (
      length(aws_sqs_queue.station_fetch_requests) == 1 && aws_sqs_queue.station_fetch_requests[0].fifo_queue &&
      aws_sqs_queue.station_fetch_requests[0].content_based_deduplication == false &&
      aws_sqs_queue.station_fetch_requests[0].visibility_timeout_seconds == aws_sqs_queue.fetch_requests[0].visibility_timeout_seconds &&
      aws_sqs_queue.station_fetch_requests_dlq[0].fifo_queue &&
      jsondecode(aws_sqs_queue.station_fetch_requests[0].redrive_policy).maxReceiveCount == 5 &&
      jsondecode(aws_sqs_queue.station_fetch_requests[0].redrive_policy).deadLetterTargetArn == aws_sqs_queue.station_fetch_requests_dlq[0].arn
    )
    error_message = "Station API feeds have their own FIFO fetch queue (the fetch-requests visibility), dead-lettering after 5 receives into their own FIFO DLQ."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.fetcher_station_requests[0].event_source_arn == aws_sqs_queue.station_fetch_requests[0].arn &&
      aws_lambda_event_source_mapping.fetcher_station_requests[0].function_name == aws_lambda_function.fetcher.arn &&
      aws_lambda_event_source_mapping.fetcher_station_requests[0].batch_size == 1 &&
      aws_lambda_event_source_mapping.fetcher_station_requests[0].scaling_config[0].maximum_concurrency == 2 &&
      aws_lambda_event_source_mapping.fetcher_requests[0].event_source_arn == aws_sqs_queue.fetch_requests[0].arn &&
      aws_lambda_event_source_mapping.fetcher_requests[0].scaling_config[0].maximum_concurrency == 2
    )
    error_message = "The station queue has its own trigger into the fetcher, at most 2 at once; CHC's and DWS's trigger stays on fetch-requests at 2."
  }
  assert {
    # Station fetches hold at most their trigger's 2, so CHC, DWS and the scheduled modes keep fetcher_reserved_concurrency.
    condition = (
      aws_lambda_function.fetcher.reserved_concurrent_executions == var.fetcher_reserved_concurrency + aws_lambda_event_source_mapping.fetcher_station_requests[0].scaling_config[0].maximum_concurrency &&
      aws_lambda_function.fetcher.reserved_concurrent_executions == 4
    )
    error_message = "With station API feeds on, the fetcher's reserved concurrency is fetcher_reserved_concurrency plus the station trigger's 2 (4 by default)."
  }
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["STATION_FETCH_REQUESTS_QUEUE_URL"] == aws_sqs_queue.station_fetch_requests[0].url &&
      aws_lambda_function.worker.environment[0].variables["STATION_FETCH_REQUESTS_QUEUE_URL"] != aws_lambda_function.worker.environment[0].variables["FETCH_REQUESTS_QUEUE_URL"]
    )
    error_message = "The worker names the station queue, apart from fetch-requests."
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.worker_station_queue[0].statement : s.resources])) == toset([aws_sqs_queue.station_fetch_requests[0].arn]) &&
      toset(flatten([for s in data.aws_iam_policy_document.worker_station_queue[0].statement : s.actions])) == toset(["sqs:SendMessage"]) &&
      aws_iam_role_policy.worker_station_queue[0].role == aws_iam_role.worker_lambda.id &&
      toset(flatten([for s in data.aws_iam_policy_document.fetcher_station_queue[0].statement : s.resources])) == toset([aws_sqs_queue.station_fetch_requests[0].arn]) &&
      !contains(flatten([for s in data.aws_iam_policy_document.fetcher_station_queue[0].statement : s.actions]), "sqs:SendMessage") &&
      aws_iam_role_policy.fetcher_station_queue[0].role == aws_iam_role.fetcher_lambda.id &&
      contains([for s in data.aws_iam_policy_document.sqs_endpoint.statement : s.sid], "WorkerSendsStationFetchRequests")
    )
    error_message = "The worker may only send to the station queue (through the SQS endpoint too), and the fetcher only consume it."
  }
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.station_fetch_requests_dlq_depth) == 1 &&
      length(aws_cloudwatch_metric_alarm.station_fetch_requests_age) == 1 &&
      aws_cloudwatch_metric_alarm.station_fetch_requests_age[0].dimensions["QueueName"] == aws_sqs_queue.station_fetch_requests[0].name
    )
    error_message = "The station queue has the fetch-requests alarms: DLQ arrivals and the oldest message's age."
  }
  assert {
    condition     = length(toset([for s in aws_secretsmanager_secret.runtime : s.arn])) == 4
    error_message = "Positive control: four distinct secret ARNs, so matching the fetcher's grant to its own secret can fail."
  }
}

run "station_api_feeds_before_the_rain_copy_cutover" {
  command = plan

  variables {
    station_api_feeds           = true
    feed_credential_public_key  = "synthetic-feed-public-key-0000000000000000A"
    feed_credential_private_key = "synthetic-feed-private-key-000000000000000A"
  }

  assert {
    condition     = length(aws_sqs_queue.fetch_requests) == 1 && contains(keys(aws_secretsmanager_secret.runtime), "fetcher")
    error_message = "Before the cutover too, station API feeds keep the queues and give the fetcher its secret."
  }
}

run "station_api_feeds_need_both_keys" {
  command = plan

  variables {
    station_api_feeds          = true
    feed_credential_public_key = "synthetic-feed-public-key-0000000000000000A"
  }

  expect_failures = [var.station_api_feeds]
}

run "rejects_the_committed_dev_public_key" {
  command = plan

  variables {
    station_api_feeds           = true
    feed_credential_public_key  = "g-xo1mrWk9kZ42VUSOO8eMbk5xQjlQ3GlXFzlFjcKCs"
    feed_credential_private_key = "synthetic-feed-private-key-000000000000000A"
  }

  expect_failures = [var.feed_credential_public_key]
}

run "rejects_a_malformed_private_key" {
  command = plan

  variables {
    station_api_feeds           = true
    feed_credential_public_key  = "synthetic-feed-public-key-0000000000000000A"
    feed_credential_private_key = "-----BEGIN PRIVATE KEY-----"
  }

  expect_failures = [var.feed_credential_private_key]
}

run "station_api_feeds_add_their_two_to_a_raised_fetcher_ceiling" {
  command = plan

  variables {
    station_api_feeds            = true
    feed_credential_public_key   = "synthetic-feed-public-key-0000000000000000A"
    feed_credential_private_key  = "synthetic-feed-private-key-000000000000000A"
    fetcher_reserved_concurrency = 5
  }

  assert {
    condition     = aws_lambda_function.fetcher.reserved_concurrent_executions == 7
    error_message = "The station trigger's 2 is added to whatever fetcher_reserved_concurrency the operator chose (5 + 2)."
  }
}
