# Plan-only tests for the edge (issue #126): the CloudFront behaviours' cache
# and origin-request policies, the API origin's protocol and shared-secret
# header (and that it is the value the API's runtime secret carries), the
# frontend bucket's 404-not-403 policy and the SPA function's 404 page, the
# subnets' zone-ID selection, and the direct-traffic alarm. Same mocks as
# guardrails.tftest.hcl (copied, so each file stands alone); the CloudFront
# Functions themselves are run as code in infra/scripts/cloudfront-functions.test.mjs.
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

# Known function ARNs, so each behaviour's function association can be
# matched to its own function (edge.tftest.hcl only).
override_resource {
  target          = aws_cloudfront_function.spa_rewrite
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/water-management-spa-rewrite"
  }
}

override_resource {
  target          = aws_cloudfront_function.api_strip_prefix
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/water-management-api-strip-prefix"
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
# CloudFront behaviours and the API origin
# ---------------------------------------------------------------------------

run "edge_behaviours" {
  command = plan

  # Every ordered behaviour is named here, so a new one needs its own checks.
  assert {
    condition     = [for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.path_pattern] == ["/api/*", "/reports/*", "/packs/*"]
    error_message = "The distribution has exactly three ordered behaviours, /api/*, /reports/* then /packs/*; a new one needs its cache and origin policies pinned here."
  }

  # /api/*: nothing cached, so a response can never be served to another
  # user. With CachingDisabled the cache key is irrelevant: the origin
  # request policy may forward cookies (the session) because no response is
  # stored under any key. AllViewerExceptHostHeader keeps Host out (the
  # Function URL routes on its own hostname).
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : alltrue([
      b.target_origin_id == "lambda-api",
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      b.origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac",
      b.viewer_protocol_policy == "https-only",
      b.trusted_key_groups == null ? true : length(b.trusted_key_groups) == 0,
      length(b.function_association) == 1,
    ]) if b.path_pattern == "/api/*"])
    error_message = "/api/* must go to the Lambda origin with Managed-CachingDisabled (4135ea2d-…; a caching policy would serve one user's API responses to another), Managed-AllViewerExceptHostHeader (b689b0a8-…), https-only, and only the prefix-strip function."
  }
  assert {
    condition     = [for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : [for f in b.function_association : "${f.event_type} ${f.function_arn}"] if b.path_pattern == "/api/*"] == [["viewer-request ${aws_cloudfront_function.api_strip_prefix.arn}"]]
    error_message = "/api/* runs api_strip_prefix on viewer-request (it strips /api and stamps the viewer address)."
  }

  # /reports/*: private PDFs, never cached, signed URLs only, read-only.
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : alltrue([
      b.target_origin_id == "s3-reports",
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      b.viewer_protocol_policy == "https-only",
      b.allowed_methods == toset(["GET", "HEAD"]),
      b.trusted_key_groups == tolist([aws_cloudfront_key_group.report_downloads.id]),
    ]) if b.path_pattern == "/reports/*"])
    error_message = "/reports/* must go to the reports bucket with Managed-CachingDisabled, https-only, GET/HEAD only and signed URLs (the report-downloads key group)."
  }

  # /packs/*: issued evidence packs' PDFs, the same as /reports/* but their own bucket.
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : alltrue([
      b.target_origin_id == "s3-packs",
      b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      b.viewer_protocol_policy == "https-only",
      b.allowed_methods == toset(["GET", "HEAD"]),
      b.trusted_key_groups == tolist([aws_cloudfront_key_group.report_downloads.id]),
    ]) if b.path_pattern == "/packs/*"])
    error_message = "/packs/* must go to the packs bucket with Managed-CachingDisabled, https-only, GET/HEAD only and signed URLs (the report-downloads key group)."
  }

  # The default (SPA) behaviour forwards no query string or cookie to S3:
  # CachingOptimized and no origin request policy. That is also what keeps
  # the frontend bucket's ListBucket grant from ever listing (see below).
  assert {
    condition = (
      aws_cloudfront_distribution.frontend.default_cache_behavior[0].target_origin_id == "s3-frontend" &&
      aws_cloudfront_distribution.frontend.default_cache_behavior[0].cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e58f6" &&
      (aws_cloudfront_distribution.frontend.default_cache_behavior[0].origin_request_policy_id == null ? "" : aws_cloudfront_distribution.frontend.default_cache_behavior[0].origin_request_policy_id) == "" &&
      [for f in aws_cloudfront_distribution.frontend.default_cache_behavior[0].function_association : "${f.event_type} ${f.function_arn}"] == ["viewer-request ${aws_cloudfront_function.spa_rewrite.arn}"]
    )
    error_message = "The default behaviour serves the frontend bucket with Managed-CachingOptimized, no origin request policy (no query string reaches S3) and spa_rewrite on viewer-request."
  }

  # The API origin: TLS only, and the shared secret the app checks.
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.frontend.origin : alltrue([
      o.custom_origin_config[0].origin_protocol_policy == "https-only",
      o.custom_origin_config[0].origin_ssl_protocols == toset(["TLSv1.2"]),
      o.custom_origin_config[0].https_port == 443,
    ]) if o.origin_id == "lambda-api"])
    error_message = "CloudFront must reach the Function URL over HTTPS only (TLSv1.2): the shared secret travels in a header."
  }
  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.frontend.origin : (
      length(o.custom_header) == 1 &&
      one(o.custom_header).name == "X-CloudFront-Shared-Secret" &&
      one(o.custom_header).value == random_password.cloudfront_shared_secret.result &&
      one(o.custom_header).value == local.runtime_secrets.api.CLOUDFRONT_SHARED_SECRET
    ) if o.origin_id == "lambda-api"])
    error_message = "The API origin must send X-CloudFront-Shared-Secret with exactly the value the API's runtime secret carries (CLOUDFRONT_SHARED_SECRET, secrets.tf), or every API request gets 403. That the app reads this header is pinned from the other side, in backend/src/app.security.test.ts (check:infra runs on a copy of infra/ alone, so file() can't reach backend/)."
  }
  assert {
    condition     = alltrue([for o in aws_cloudfront_distribution.frontend.origin : length(o.custom_header) == 0 if o.origin_id != "lambda-api"])
    error_message = "Only the API origin carries the shared secret; an S3 origin must never be sent it."
  }
}

# ---------------------------------------------------------------------------
# A missing file: 404, not S3's AccessDenied XML
# ---------------------------------------------------------------------------

run "missing_files_are_404" {
  command = plan

  # statement[0] (GetObject) is pinned in guardrails' edge_security.
  assert {
    condition = (
      data.aws_iam_policy_document.frontend_bucket_policy.statement[1].actions == toset(["s3:ListBucket"]) &&
      data.aws_iam_policy_document.frontend_bucket_policy.statement[1].resources == toset([aws_s3_bucket.frontend.arn]) &&
      one(data.aws_iam_policy_document.frontend_bucket_policy.statement[1].principals).identifiers == toset(["cloudfront.amazonaws.com"]) &&
      one(data.aws_iam_policy_document.frontend_bucket_policy.statement[1].condition).variable == "AWS:SourceArn" &&
      tolist(one(data.aws_iam_policy_document.frontend_bucket_policy.statement[1].condition).values) == tolist([aws_cloudfront_distribution.frontend.arn])
    )
    error_message = "CloudFront (this distribution only) may ListBucket on the frontend bucket itself, not its objects, so S3 answers a missing key 404 instead of 403."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.reports_bucket_policy.statement : !contains(s.actions, "s3:ListBucket")])
    error_message = "The private reports bucket keeps GetObject only: its misses stay 403 and reveal nothing about which reports exist."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.packs_bucket_policy.statement : !contains(s.actions, "s3:ListBucket")])
    error_message = "The private packs bucket keeps GetObject only: its misses stay 403 and reveal nothing about which packs exist."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.frontend.custom_error_response) == 0
    error_message = "The 404 page comes from spa_rewrite, not a custom_error_response (which would also rewrite the API's JSON 404s)."
  }
  assert {
    condition = alltrue([for s in [
      "statusCode: 404",
      "var STATIC_DIRS = ['_app',",
      "segments[i] === '.' || segments[i] === '..'",
    ] : strcontains(aws_cloudfront_function.spa_rewrite.code, s)])
    error_message = "spa_rewrite must answer 404 itself for a file the build doesn't have, and for any dot segment (infra/scripts/cloudfront-functions.test.mjs runs it)."
  }
}

# ---------------------------------------------------------------------------
# Availability zones by zone ID
# ---------------------------------------------------------------------------

run "subnets_by_zone_id" {
  command = plan

  # Out of order, with a third zone: the two lowest IDs are chosen, whatever
  # order AWS lists them in.
  override_data {
    target = data.aws_availability_zones.available
    values = {
      names    = ["af-south-1c", "af-south-1a", "af-south-1b"]
      zone_ids = ["afs1-az3", "afs1-az1", "afs1-az2"]
    }
  }

  assert {
    condition     = [for s in aws_subnet.private : s.availability_zone_id] == ["afs1-az1", "afs1-az2"]
    error_message = "The subnets go in the two lowest available zone IDs (stable across accounts), not in the first two zone names."
  }
  assert {
    condition = (
      data.aws_availability_zones.available.state == "available" &&
      one(data.aws_availability_zones.available.filter).name == "opt-in-status" &&
      one(data.aws_availability_zones.available.filter).values == toset(["opt-in-not-required"])
    )
    error_message = "Only available, non-opt-in zones (no Local or Wavelength Zones) may be chosen."
  }
}

# ---------------------------------------------------------------------------
# Direct Function URL traffic is visible
# ---------------------------------------------------------------------------

run "direct_function_url_traffic_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.origin_secret_rejected.log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.origin_secret_rejected.pattern == "{ $.message.event = \"origin_secret_rejected\" }"
    )
    error_message = "origin_secret_rejected must be counted from the API's log group, by the exact event name backend/src/app.ts logs (app.security.test.ts pins the line)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.origin_secret_rejected.metric_name == aws_cloudwatch_log_metric_filter.origin_secret_rejected.metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.origin_secret_rejected.namespace == aws_cloudwatch_log_metric_filter.origin_secret_rejected.metric_transformation[0].namespace &&
      aws_cloudwatch_metric_alarm.origin_secret_rejected.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.origin_secret_rejected.alarm_actions == toset([aws_sns_topic.alerts.arn]) &&
      aws_cloudwatch_metric_alarm.origin_secret_rejected.treat_missing_data == "notBreaching"
    )
    error_message = "The direct-traffic alarm must sum the origin_secret_rejected metric and notify the alerts topic."
  }
}
