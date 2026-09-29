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
# (and leave var.cost_anomaly_threshold_usd at its default 0) or the apply
# fails with AccessDeniedException on the budgets.
# ----------------------------------------------------------------------------

# The regional topic carries the regional CloudWatch alarms. The budgets and
# Cost Anomaly Detection publish to the us-east-1 topic further down instead:
# af-south-1 is an opt-in region, and AWS documents Budgets → SNS only as
# "same account", not whether its publisher reaches an opt-in region's topic.
# us-east-1 is where Budgets and Cost Explorer themselves run, so the spend
# alerts can't be dropped by a region the service doesn't reach.
# Not KMS-encrypted, deliberately: AWS Budgets and CloudWatch alarms can publish
# to an encrypted topic only through a customer-managed key whose policy grants
# them (the AWS-managed alias/aws/sns refuses both), and the messages are
# threshold notices with no client data. See docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts" {
  name = "${local.project}-prod-alerts"
}

# Subscribe the operator's email. budget_alert_email is required and
# validated (variables.tf), so an alarm or budget breach always pages someone.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# Only this account's CloudWatch alarms in this region may publish
# (confused-deputy guard: without the conditions, cloudwatch.amazonaws.com
# acting for any account could post to the topic). The shape is AWS's own
# example: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Notify_Users_Alarm_Changes.html#SNS_Confused_Deputy
data "aws_iam_policy_document" "alerts_publish" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_publish.json
}

# --- Budgets ---------------------------------------------------------------
# Two budgets (AWS gives two free per account), both to the us-east-1 topic:
#
# - Monthly: FORECASTED 100% once AWS has ~5 weeks of cost history (it is
#   inert before that, i.e. through the first deploy), ACTUAL 80% as the
#   early warning (above the af-south-1 idle of ~$58–63 on the $80 default,
#   so it doesn't fire every month) and ACTUAL 100%.
# - Daily: ACTUAL only (daily budgets don't support FORECASTED). This is the
#   first-month guard: from day one, a day costing more than
#   budget_daily_usd (default monthly × 2.25 / 30, rounded up: $6 on $80,
#   ~3× the ~$2/day af-south-1 idle) pages when billing data next refreshes
#   (at least daily), so a runaway is caught in about a day, not after it has
#   burned half the month.
#
# Billing data lags all of these by up to a day. The Lambda concurrency caps
# and the per-resource alarms are what bound and report a runaway as it
# happens; the budgets are the backstop that says what it cost.

locals {
  budget_daily_usd = (
    var.budget_daily_usd != null
    ? var.budget_daily_usd
    : ceil(var.budget_monthly_usd * 2.25 / 30)
  )
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 ? 1 : 0
  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # The month's forecast crosses the budget. Needs ~5 weeks of history, so
  # it is silent in the first month; the daily budget covers that window.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  # The topic policy must grant Budgets before the budget validates its
  # subscriber, or the create fails with "Invalid SNS topic".
  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

# Same billing-access pre-condition as the monthly budget, so it is skipped
# with it (budget_monthly_usd = 0); budget_daily_usd = 0 skips only this one.
resource "aws_budgets_budget" "daily" {
  count        = var.budget_monthly_usd > 0 && local.budget_daily_usd > 0 ? 1 : 0
  name         = "${local.project}-daily"
  budget_type  = "COST"
  limit_amount = tostring(local.budget_daily_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  # ACTUAL alerts go out once per budget period: at most one mail a day.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts_us_east_1.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

# --- Cost Anomaly Detection -------------------------------------------------
# Free. An AWS-managed "AWS services" monitor learns each service's normal
# spend and flags a jump in any one of them, which the budgets only see once
# the account total crosses a line. It needs ~10 days of history, so in the
# first month the daily budget is the guard, not this.
# An account may hold only ONE services monitor, and AWS auto-creates a
# default for some new Cost Explorer users, so creating ours could fail the
# first apply. Hence off by default (cost_anomaly_threshold_usd = 0), which
# loses nothing (no history yet): the operator turns it on after the first
# apply, importing an existing monitor if there is one (infra/README.md §
# Operator steps, step 11).
# Cost Explorer is a global API served from us-east-1, hence the provider.

resource "aws_ce_anomaly_monitor" "services" {
  count             = var.cost_anomaly_threshold_usd > 0 ? 1 : 0
  provider          = aws.us_east_1
  name              = "${local.project}-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

# IMMEDIATE ("individual alerts") is the frequency an SNS subscriber needs.
# An anomaly whose total cost impact reaches the threshold pages; smaller
# ones stay listed in the console's Detected anomalies tab.
resource "aws_ce_anomaly_subscription" "services" {
  count            = var.cost_anomaly_threshold_usd > 0 ? 1 : 0
  provider         = aws.us_east_1
  name             = "${local.project}-anomalies"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.alerts_us_east_1.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.cost_anomaly_threshold_usd)]
    }
  }

  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
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

# --- Unhandled API errors ---------------------------------------------------
# The API answers an unexpected exception with a generic 500 (handleError,
# backend/src/http/errors.ts), so the Lambda invocation itself succeeds and
# the function's Errors metric (lambda_errors above) never counts it. It logs
# one structured line instead:
#   {"event":"unhandled_error","method":"GET","route":"/projects/:id","error":"error","code":"42P01","at":["at …"]}
# the route's pattern (never the concrete path, which can carry a token), the
# error's name/code (safeError) and its stack frames, never its message. Only
# the API runs the Hono app, so only its log group is filtered; the worker's
# unexpected failures are job_failed / job_dead (jobs.tf).

resource "aws_cloudwatch_log_metric_filter" "unhandled_error" {
  name           = "${local.project}-unhandled-error"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.event = \"unhandled_error\" }"

  metric_transformation {
    name          = "UnhandledError"
    namespace     = "${local.project}/Application"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "unhandled_error" {
  alarm_name          = "${local.project}-unhandled-error"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.unhandled_error.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.unhandled_error.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The API answered a request with an unhandled 500 (invisible to the Lambda Errors metric). Search the API log group for event = unhandled_error: route says which endpoint, error/code the exception's name and code (a Postgres SQLSTATE for a database error), at the stack frames. Runbook: docs/deployment.md § Runbooks."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# --- Failed sign-ins across all accounts --------------------------------------
# Every sign-in throttle is keyed on one address (the lockout, the reset and
# verification cooldowns; docs/security.md § Throttles that don't depend on the
# WAF), so one password tried against many accounts from many IPs gets past
# each of them and the WAF's per-IP auth limit alone slows it. Only a count
# over all accounts sees that. Each failed credential check logs one line
# (backend/src/auth/loginFailed.ts):
#   {"event":"login_failed","route":"/auth/login","reason":"bad_password"}
# the route's pattern and a reason code (unknown_account, bad_password,
# locked, invalid_link), never the address, an id, the client IP or a token.
# Only the API checks credentials, so only its log group is filtered.
#
# Threshold (login_failed_alarm_per_15min, default 30 in 15 minutes): the
# pilot is a handful of users; one of them fumbling a password into a lock
# logs 5-10 lines, so 30 is several people locking themselves out at once, or
# someone guessing. One IP at the WAF auth limit (100 per 5 minutes) reaches it
# in under 5 minutes. Alarm, not a circuit breaker: why is in docs/security.md.

resource "aws_cloudwatch_log_metric_filter" "login_failed" {
  name           = "${local.project}-login-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.event = \"login_failed\" }"

  metric_transformation {
    name          = "LoginFailed"
    namespace     = "${local.project}/Application"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "login_failed" {
  alarm_name          = "${local.project}-login-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.login_failed.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.login_failed.metric_transformation[0].namespace
  period              = 900
  statistic           = "Sum"
  threshold           = var.login_failed_alarm_per_15min
  alarm_description   = "More than ${var.login_failed_alarm_per_15min} failed sign-ins (or bad reset/verification links) in 15 minutes across all accounts: possible password spraying or credential stuffing. Logs Insights on the API log group: filter event = \"login_failed\" | stats count() by reason, route, bin(5m). Runbook: docs/deployment.md § Runbooks, Credential stuffing / password spraying."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
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
  # reserved concurrency (10) x pool max (5) = 50, the worker 8 x 2 = 16 and
  # the migrator 1. Both saturated for 15 minutes is itself worth a look; above
  # 60 otherwise, something is leaking or a cap was raised without resizing the DB.
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

# --- us-east-1 topic: CloudFront + WAF alarms, budgets, cost anomalies -----
# CloudFront metrics and a CLOUDFRONT-scope WAF's metrics are published in
# us-east-1 only, and a CloudWatch alarm can only notify an SNS topic in its
# own region, so these alarms get their own topic (same subscriber). The
# budgets and Cost Anomaly Detection publish here too (see the regional
# topic's comment).

# Not KMS-encrypted, as aws_sns_topic.alerts (docs/security.md § Accepted IaC findings).
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.project}-prod-alerts"
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# One statement per publishing service, each pinned to this account
# (confused-deputy guard), with the conditions AWS documents for it:
# - CloudWatch: SourceAccount + ArnLike SourceArn on this region's alarms
#   (the link on alerts_publish above).
# - Budgets: SourceAccount + ArnLike SourceArn arn:aws:budgets::<acct>:*,
#   https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html
# - Cost Anomaly Detection: SourceAccount only, AWS's documented example
#   (https://docs.aws.amazon.com/cost-management/latest/userguide/ad-SNS.html).
#   The page doesn't give the SourceArn it sends, and a wrong guess would
#   drop every anomaly alert without an error.
data "aws_iam_policy_document" "alerts_us_east_1_publish" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:us-east-1:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }

  statement {
    sid       = "AllowBudgets"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${data.aws_caller_identity.current.account_id}:*"]
    }
  }

  statement {
    sid       = "AllowCostAnomalyDetection"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]
    principals {
      type        = "Service"
      identifiers = ["costalerts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
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

# --- Request volume: nothing caps the edge's bill ---------------------------
# CloudFront and WAF request charges have no ceiling. The per-IP WAF limits
# stop one client, not a botnet that keeps each IP under them. Every allowed
# request costs WAF $0.60/M + CloudFront $0.010 per 10k HTTPS ($1.00/M at
# US/EU edges, ~$2.20/M at Africa's) = $1.60-2.80 per million. A request the
# WAF blocks costs WAF's $0.60/M only: CloudFront stopped billing
# WAF-blocked requests on 2024-10-25.
#
# Normal traffic is a handful of concurrent users (docs/deployment-tiers.md).
# A cold visit loads the SPA shell and its chunks (~150 requests, immutable
# and cached after), plus API calls, so a busy 5 minutes is ~250 requests.
# The default threshold, 5,000 per 5 minutes
# (var.cloudfront_requests_alarm_per_5min), is 20x that, and five people each
# at the WAF's per-IP limit (1,000).
#   Unseen: a flood just under it is 16.7 req/s = 1.44M/day
#     = $2.30-4.03/day, 3-5% of the $80 monthly budget per day.
#   Seen: the infra audit's 1,000 req/s flood is 300,000 per 5 minutes, 60x
#     the threshold, so the first period fires, ~$0.48-0.84 in.
# The budget's ACTUAL notifications lag 8-24 h; this is the prompt signal.
resource "aws_cloudwatch_metric_alarm" "cloudfront_requests" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-requests"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Requests"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Sum"
  threshold           = var.cloudfront_requests_alarm_per_5min
  alarm_description   = "CloudFront served more than ${var.cloudfront_requests_alarm_per_5min} requests in 5 minutes, ~20x normal. Nothing caps this bill: each million costs $1.60-2.80 (WAF + CloudFront). In the WAF console (us-east-1), the ACL's traffic overview and sampled requests show the top IPs, paths and countries. A flood: block it (runbook: docs/deployment.md, Runbooks, Request flood). Real growth: raise cloudfront_requests_alarm_per_5min."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend.id
    Region         = "Global"
  }
}

# Sustained blocks. Only the three rate rules block (waf.tf has no managed
# rule groups), so a block means one IP went over 100 auth requests,
# waf_rate_limit_per_ip API requests, or waf_site_rate_limit_per_ip requests
# in all, in 5 minutes. 100 blocked in a period is a whole auth-rule
# window's worth; in each of 3 periods running (15 minutes) it is someone
# persisting (credential stuffing, a scraper) or a real client stuck behind
# a limit: the report renderer (<= 2 Lambda egress IPs, one
# /api/auth/render-session call and the SPA per render; a blocked render
# retries with backoff, reports/render.ts) or an office behind one NAT.
# Blocked requests cost WAF's $0.60/M only, so this is the attack and
# false-positive signal; cloudfront_requests is the cost one.
# Dimensions: the ACL's metric name and Rule = ALL (every rule). A
# CLOUDFRONT-scope ACL's metrics have no Region dimension (AWS WAF metrics
# and dimensions, developer guide).
resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-waf-blocked-requests"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "The WAF blocked more than 100 requests in each of the last three 5-minute periods: an attacker persisting, or a real client stuck behind a rate limit. Read the ACL's sampled requests (us-east-1): /api/auth/ from many IPs is credential stuffing; the renderer's IPs mean reports are being retried and may fail; one office IP means raise waf_rate_limit_per_ip (API paths) or waf_site_rate_limit_per_ip (the rest). Runbook: docs/deployment.md, Runbooks, Request flood."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = aws_wafv2_web_acl.frontend.visibility_config[0].metric_name
    Rule   = "ALL"
  }
}
