# Plan-only tests for the data-protection controls on the database and the
# frontend bucket (issue #126): the DB parameter group's TLS and logging pins,
# backups and snapshots (automated backups kept after deletion, tags copied,
# a unique final snapshot name, prevent_destroy), the RDS event subscription
# and the topic statement that lets RDS publish to it, the T4g Unlimited
# CPU-credit alarms, and the frontend bucket's TLS-only rule.
#
# The mocks, overrides and variables below are copied from
# guardrails.tftest.hcl (each test file needs its own); keep them in step.
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

run "db_parameters" {
  command = plan

  # rds.force_ssl: the server refuses a non-TLS connection, whatever the
  # client asks for (the Lambdas' sslmode=verify-full is the client half).
  assert {
    condition     = contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "rds.force_ssl=1")
    error_message = "The DB parameter group must pin rds.force_ssl = 1 (TLS only)."
  }
  # log_statement none: no statement is logged just for its type, so the
  # migrate Lambda's ALTER ROLE … PASSWORD isn't logged as DDL (rds.tf).
  assert {
    condition     = contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_statement=none")
    error_message = "The DB parameter group must pin log_statement = none (DDL, including ALTER ROLE … PASSWORD, is not logged for its type)."
  }
  assert {
    condition     = contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_min_duration_statement=1000")
    error_message = "Slow statements (over 1 s) must be logged, and only those."
  }
  assert {
    condition = alltrue([for n in ["log_parameter_max_length", "log_parameter_max_length_on_error"] :
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "${n}=0")
    ])
    error_message = "Bind values must never be logged: log_parameter_max_length and its _on_error twin must be 0."
  }
}

run "db_backups_and_snapshots" {
  command = plan

  # The automated backups (PITR) outlive the instance, so a deleted instance
  # can still be restored (docs/deployment.md § Restoring the database).
  assert {
    condition     = aws_db_instance.main.delete_automated_backups == false
    error_message = "delete_automated_backups must be false: the automated backups must outlive the instance."
  }
  assert {
    condition     = aws_db_instance.main.copy_tags_to_snapshot == true
    error_message = "copy_tags_to_snapshot must be on, so snapshots carry the instance's tags (cost allocation, ownership)."
  }
  # A fixed final snapshot name makes the second teardown fail: the first
  # teardown's snapshot still holds the name.
  assert {
    condition = (
      aws_db_instance.main.skip_final_snapshot == false
      && startswith(aws_db_instance.main.final_snapshot_identifier, "water-management-final-")
      && can(regex("final_snapshot_identifier\\s*=\\s*\"\\$\\{local\\.project\\}-final-\\$\\{random_id\\.final_snapshot_suffix\\.hex\\}\"", file("rds.tf")))
      && !can(regex("timestamp\\(\\)", regex("(?s)resource \"aws_db_instance\" \"main\" \\{.*?\\n\\}", file("rds.tf"))))
    )
    error_message = "The final snapshot must be taken, under a name made unique per stack by random_id.final_snapshot_suffix (never a fixed name, never timestamp(), which diffs on every plan)."
  }
  # Lifecycle settings aren't plan attributes: read the source (the resource
  # block, up to its closing brace at column 0).
  assert {
    condition     = aws_db_instance.main.deletion_protection && can(regex("prevent_destroy\\s*=\\s*true", regex("(?s)resource \"aws_db_instance\" \"main\" \\{.*?\\n\\}", file("rds.tf"))))
    error_message = "aws_db_instance.main must keep deletion_protection and carry lifecycle { prevent_destroy = true }: a destroy or a replacing plan must fail, not delete the database."
  }
}

run "db_events" {
  command = plan

  assert {
    condition = (
      aws_db_event_subscription.main.sns_topic == aws_sns_topic.alerts.arn
      && aws_db_event_subscription.main.source_type == "db-instance"
      && aws_db_event_subscription.main.source_ids == toset(["water-management"])
      && aws_db_event_subscription.main.enabled
    )
    error_message = "The RDS event subscription must send this instance's events to the alerts topic."
  }
  # The categories that need a person; `backup` (every daily backup),
  # `configuration change` and `creation` (every apply) would drown them.
  assert {
    condition = aws_db_event_subscription.main.event_categories == toset([
      "availability", "deletion", "failover", "failure", "low storage",
      "maintenance", "notification", "recovery", "restoration", "security patching",
    ])
    error_message = "The RDS event subscription's categories changed: keep failure, low storage, availability, failover, recovery, restoration, deletion, maintenance, security patching and notification, and leave out the routine backup/configuration change/creation."
  }
  # A custom topic policy replaces SNS's default, so RDS needs its own
  # statement, and only for this account's instance (confused deputy).
  assert {
    condition = length([for s in data.aws_iam_policy_document.alerts_publish.statement : s if(
      s.sid == "AllowRdsEvents"
      && s.actions == toset(["sns:Publish"])
      && s.resources == toset([aws_sns_topic.alerts.arn])
      && one(s.principals).type == "Service"
      && one(s.principals).identifiers == toset(["events.rds.amazonaws.com"])
      && length(s.condition) == 2
      && contains([for c in s.condition : "${c.test}|${c.variable}|${join(",", c.values)}"], "StringEquals|aws:SourceAccount|000000000000")
      && contains([for c in s.condition : "${c.test}|${c.variable}|${join(",", c.values)}"], "ArnLike|aws:SourceArn|arn:aws:rds:af-south-1:000000000000:db:water-management")
    )]) == 1
    error_message = "The alerts topic policy must let events.rds.amazonaws.com publish, for this account's water-management instance only (aws:SourceAccount + aws:SourceArn)."
  }
}

run "db_cpu_credit_alarms" {
  command = plan

  # T4g on RDS runs Unlimited: an empty balance means billed surplus, not
  # throttling. The descriptions must say so.
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.rds_cpu_credits.metric_name == "CPUCreditBalance"
      && !strcontains(lower(aws_cloudwatch_metric_alarm.rds_cpu_credits.alarm_description), "about to be throttled")
      && strcontains(aws_cloudwatch_metric_alarm.rds_cpu_credits.alarm_description, "Unlimited")
    )
    error_message = "The CPU-credit balance alarm must describe T4g Unlimited (billed surplus), not throttling."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.metric_name == "CPUSurplusCreditsCharged"
      && aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.namespace == "AWS/RDS"
      && aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.statistic == "Sum"
      && aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.comparison_operator == "GreaterThanThreshold"
      && aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.threshold == 0
      && aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.dimensions["DBInstanceIdentifier"] == "water-management"
      && aws_cloudwatch_metric_alarm.rds_cpu_surplus_charged.alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "Any charged surplus CPU credit (CPUSurplusCreditsCharged, Sum > 0) on the DB must page the alerts topic."
  }
}

run "frontend_bucket_tls_only" {
  command = plan

  # Deny every S3 action on the bucket and its objects to everyone over plain
  # HTTP (aws:SecureTransport = false).
  assert {
    condition = length([for s in data.aws_iam_policy_document.frontend_bucket_policy.statement : s if(
      s.sid == "DenyInsecureTransport"
      && s.effect == "Deny"
      && s.actions == toset(["s3:*"])
      && s.resources == toset([aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"])
      && one(s.principals).type == "*"
      && one(s.principals).identifiers == toset(["*"])
      && length(s.condition) == 1
      && one(s.condition).test == "Bool"
      && one(s.condition).variable == "aws:SecureTransport"
      && join(",", one(s.condition).values) == "false"
    )]) == 1
    error_message = "The frontend bucket policy must deny s3:* on the bucket and its objects to every principal when aws:SecureTransport is false."
  }
  assert {
    # The policy JSON is unknown under mocks: the wiring is read from the source.
    condition     = aws_s3_bucket_policy.frontend.bucket == aws_s3_bucket.frontend.id && can(regex("resource \"aws_s3_bucket_policy\" \"frontend\" \\{[^}]*policy\\s*=\\s*data\\.aws_iam_policy_document\\.frontend_bucket_policy\\.json\\s", file("s3_cloudfront.tf")))
    error_message = "The frontend bucket must carry the frontend_bucket_policy document."
  }
}
