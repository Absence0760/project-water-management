# ----------------------------------------------------------------------------
# Budget + SNS + per-resource CloudWatch alarms
#
# The bootstrap deliberately does NOT create budgets per project (newly-
# org-created member accounts can't create budgets until "IAM access to
# billing information" is enabled in the account itself — a manual step
# the bootstrap can't perform). Each project owns its own budget here.
#
# Pre-condition: IAM billing access must be enabled in this account before
# the first apply that includes `aws_budgets_budget` (a one-time root toggle,
# infra/README.md § Operator steps). Until then set var.budget_monthly_usd = 0
# or the apply fails with AccessDeniedException on the budget.
# ----------------------------------------------------------------------------

# Budget alerts go through SNS so a single subscription covers budget +
# per-resource CloudWatch alarms.
# Not KMS-encrypted, deliberately: AWS Budgets and CloudWatch alarms can publish
# to an encrypted topic only through a customer-managed key whose policy grants
# them (the AWS-managed alias/aws/sns refuses both), and the messages are
# threshold notices with no client data. See docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts" {
  name = "${local.project}-prod-alerts"
}

# Subscribe operator email if configured. Empty var.budget_alert_email
# means no subscription is created (alarms still fire visibly in the
# console, just nobody is paged).
resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.budget_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# Allow Budgets + CloudWatch to publish to the topic.
data "aws_iam_policy_document" "alerts_publish" {
  statement {
    sid       = "AllowBudgetsAndCloudWatch"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_publish.json
}

# --- Monthly budget --------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 ? 1 : 0
  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Forecasted is the only notification that catches a runaway *during* the
  # month — actual lags by up to 24h.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 50
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }
}

# --- Lambda alarms ---------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.project}-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Backend Lambda emitted >5 errors in 5 minutes."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.project}-lambda-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Backend Lambda hit reserved_concurrent_executions — investigate."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

# --- API Lambda: runs approaching the timeout ------------------------------

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  alarm_name          = "${local.project}-lambda-duration-p95"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  extended_statistic  = "p95"
  threshold           = var.lambda_timeout_seconds * 1000 * 0.8
  alarm_description   = "Backend Lambda p95 duration above 80% of its timeout for 10 minutes — model runs are about to start timing out."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

# --- Backend self-checks ----------------------------------------------------
# executeRun (backend/src/runs/execute.ts) logs a structured JSON line when a
# saved run fails one of the engine's own invariant checks (docs/model.md §
# Verification) — a model bug, not a user error, that today is otherwise only
# a warning on that one run. The filter matches the event name only; the line
# never carries user data or a value that could identify the client (just the
# failed checks' ids, e.g. "balance", "ewrAttribution").
#
# Runs are saved by the API (a user's run) AND by the worker (the automatic
# re-run after new feed data, forecast runs: jobs/handlers/rerun.ts), so one
# filter per log group feeds the same metric, and the one alarm sees both.

resource "aws_cloudwatch_log_metric_filter" "self_check_failed" {
  name           = "${local.project}-self-check-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.event = \"self_check_failed\" }"

  metric_transformation {
    name          = "SelfCheckFailed"
    namespace     = "${local.project}/Application"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "self_check_failed" {
  alarm_name          = "${local.project}-self-check-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.self_check_failed.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.self_check_failed.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A saved run failed one of the engine's self-checks (invariant violation) — a model bug, not a user error. Open the run's Self-checks panel to see which check and trace the day; docs/model.md § Verification."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# The worker's half: same pattern, same metric (name + namespace), so the
# alarm above counts self-check failures from either Lambda.
resource "aws_cloudwatch_log_metric_filter" "self_check_failed_worker" {
  name           = "${local.project}-self-check-failed-worker"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = aws_cloudwatch_log_metric_filter.self_check_failed.pattern

  metric_transformation {
    name          = aws_cloudwatch_log_metric_filter.self_check_failed.metric_transformation[0].name
    namespace     = aws_cloudwatch_log_metric_filter.self_check_failed.metric_transformation[0].namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# --- Email that failed to send ----------------------------------------------
# trySendMail (backend/src/mail/transport.ts) never fails the request over a
# mail error (a sign-up or forgot-password answer must not depend on it), so
# without this a broken send is silent: the user is told "we sent you a
# link". It logs one structured line instead:
#   {"event":"mail_send_failed","kind":"reset","error":"MessageRejected"}
# the template's kind and the error's name/code only, never an address, a
# subject or the error's text. A sandbox rejection (MessageRejected: the
# recipient isn't verified), an IAM denial, throttling or the SES endpoint
# being unreachable are API errors, not SES events, so the configuration-set
# bounce/complaint alarms below never see them. The API sends the account
# emails and invitations; the worker sends report links, so both log groups
# feed one metric. (Alert emails have their own alarm, jobs.tf
# alert_mail_failures.)

resource "aws_cloudwatch_log_metric_filter" "mail_send_failed" {
  for_each = {
    api    = aws_cloudwatch_log_group.lambda.name
    worker = aws_cloudwatch_log_group.worker.name
  }
  name           = "${local.project}-mail-send-failed-${each.key}"
  log_group_name = each.value
  pattern        = "{ $.event = \"mail_send_failed\" }"

  metric_transformation {
    name          = "MailSendFailed"
    namespace     = "${local.project}/Application"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_send_failed" {
  alarm_name          = "${local.project}-mail-send-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MailSendFailed"
  namespace           = "${local.project}/Application"
  period              = 900
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "An account, invitation or report email failed to send (the user was still told it was sent). Search the API and worker log groups for event = mail_send_failed: kind says which email, error the SES/SMTP error code (MessageRejected in the SES sandbox = recipient not verified; AccessDenied = IAM). Runbook: docs/deployment.md § Email."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  depends_on = [aws_cloudwatch_log_metric_filter.mail_send_failed]
}

# --- Migrate Lambda --------------------------------------------------------
# A failed migration also fails the deploy workflow loudly; this catches a
# manual invocation (e.g. after a password rotation) that nobody watched.

resource "aws_cloudwatch_metric_alarm" "migrate_errors" {
  alarm_name          = "${local.project}-migrate-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Migrate Lambda failed — the schema or the water_app role may be out of sync with the deployed code."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.migrate.function_name
  }
}

# --- RDS alarms ------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.project}-rds-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS CPU above 80% for 15 minutes."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# t4g is burstable: once CPU credits run out the instance is throttled to its
# baseline (~10% of 2 vCPUs on micro). Warn well before that.
resource "aws_cloudwatch_metric_alarm" "rds_cpu_credits" {
  alarm_name          = "${local.project}-rds-cpu-credits"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUCreditBalance"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = 20
  alarm_description   = "RDS CPU credit balance below 20 — the burstable instance is about to be throttled. Consider db.t4g.small."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${local.project}-rds-free-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  # 4 GiB of the initial 20 GiB. Storage autoscaling (max_allocated_storage)
  # kicks in at 10% free, so this gets a human in the loop first.
  threshold          = 4 * 1024 * 1024 * 1024
  alarm_description  = "RDS free storage below 4 GiB."
  alarm_actions      = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.project}-rds-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Maximum"
  # db.t4g.micro allows ~80 connections. The API can open at most
  # reserved concurrency (10) x pool max (5) = 50; above 60 something is
  # leaking or the concurrency cap was lifted without resizing the DB.
  threshold          = 60
  alarm_description  = "RDS connections above 60 (t4g.micro max is ~80)."
  alarm_actions      = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory" {
  alarm_name          = "${local.project}-rds-freeable-memory"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "FreeableMemory"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = 64 * 1024 * 1024
  alarm_description   = "RDS freeable memory below 64 MiB — the 1 GiB instance is swapping."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# --- SES reputation --------------------------------------------------------
# Account-level rates SES publishes on its own (namespace AWS/SES, no
# dimensions). AWS puts an account under review at a 5% bounce rate or 0.1%
# complaint rate, and may pause sending above ~10% / 0.5%. Alarm at half of
# the review thresholds so there is time to act. Nothing to page on while
# nothing is sent, hence notBreaching.

resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  alarm_name          = "${local.project}-ses-bounce-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.BounceRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 0.025
  alarm_description   = "SES bounce rate above 2.5% (AWS reviews the account at 5%). Check who is being invited / registering with bad addresses."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  alarm_name          = "${local.project}-ses-complaint-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.ComplaintRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 0.0005
  alarm_description   = "SES complaint rate above 0.05% (AWS reviews the account at 0.1%). Someone is marking account emails as spam — check invitations for abuse."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# --- CloudFront alarms (must live in us-east-1) ----------------------------
# A CloudWatch alarm can only notify an SNS topic in its own region, so the
# us-east-1 alarm gets its own topic (same subscriber).

# Not KMS-encrypted, as aws_sns_topic.alerts (docs/security.md § Accepted IaC findings).
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.project}-prod-alerts"
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  provider  = aws.us_east_1
  count     = var.budget_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

data "aws_iam_policy_document" "alerts_us_east_1_publish" {
  statement {
    sid       = "AllowCloudWatch"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts_us_east_1" {
  provider = aws.us_east_1
  arn      = aws_sns_topic.alerts_us_east_1.arn
  policy   = data.aws_iam_policy_document.alerts_us_east_1_publish.json
}

resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "CloudFront 5xx rate above 1% over 5 minutes."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend.id
    Region         = "Global"
  }
}
