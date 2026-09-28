# ----------------------------------------------------------------------------
# Amazon SES — transactional email (verify, password reset, invitations, alerts)
#
# The API Lambda sends with the SES v2 API (`SendEmail`, backend/src/mail/
# transport.ts, MAIL_TRANSPORT=ses) using its own IAM role: no SMTP password
# exists anywhere. SES lives in the primary region (var.aws_region). It is
# available in af-south-1 and in every candidate region, and so is the SES API
# VPC interface endpoint the private-only Lambda reaches it through
# (docs/deployment.md § Region).
#
#   From:       no-reply@<domain>          DKIM-signed (Easy DKIM, RSA 2048)
#   MAIL FROM:  mail.<domain>              MX → feedback-smtp.<region>.amazonses.com,
#                                          SPF include:amazonses.com
#   DMARC:      _dmarc.<domain>            p=none to start (var.dmarc_policy)
#
# Both DKIM (d=<domain>) and SPF (MAIL FROM is a subdomain, relaxed alignment)
# align with the From domain, so DMARC can later be tightened to quarantine /
# reject without losing mail.
#
# Bounces and complaints also reach the app (the mail-events queue below), so
# a suppressed address's alert emails pause with a banner in the app.
#
# NOT done here — manual, one-time (infra/README.md § Operator steps):
#   leaving the SES sandbox (production access is an AWS support review).
#   Until it is granted SES only delivers to verified addresses.
# ----------------------------------------------------------------------------

locals {
  mail_from_address = "${var.mail_from_local_part}@${var.domain_name}"
  mail_from_domain  = "${var.mail_from_subdomain}.${var.domain_name}"

  # Easy DKIM CNAME target. Most regions share dkim.amazonses.com; the newer
  # opt-in regions use a regional domain (AWS General Reference → SES
  # endpoints → "DKIM domains"). Getting this wrong leaves the identity stuck
  # in PENDING, so it is spelled out rather than assumed.
  ses_regional_dkim_regions = [
    "af-south-1", "ap-south-2", "ap-southeast-3", "ap-southeast-5", "ca-west-1",
    "ap-northeast-3", "eu-south-1", "eu-central-2", "il-central-1", "me-central-1",
  ]
  ses_dkim_domain = contains(local.ses_regional_dkim_regions, var.aws_region) ? "dkim.${var.aws_region}.amazonses.com" : "dkim.amazonses.com"

  dmarc_record = join("; ", compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    var.dmarc_report_email != "" ? "rua=mailto:${var.dmarc_report_email}" : "",
    "adkim=r",
    "aspf=r",
  ]))
}

# --- Configuration set: TLS, suppression, reputation, event metrics --------

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = local.project

  delivery_options {
    # Emails carry live reset / verification tokens. REQUIRE refuses to hand
    # them to a receiving MX that can't do STARTTLS, rather than sending them
    # in the clear.
    tls_policy = var.ses_tls_policy
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # Bounce/complaint handling: an address that hard-bounces or complains is
  # put on the suppression list and never mailed again, which is what keeps
  # the account's reputation (and its sending rights) intact.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

# Per-event counts into CloudWatch (namespace AWS/SES, dimension
# ses:configuration-set). Free, and enough to see what failed without paging
# anyone per bounce; the account-level rate alarms live in alarms.tf.
resource "aws_sesv2_configuration_set_event_destination" "cloudwatch" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "cloudwatch"

  event_destination {
    enabled              = true
    matching_event_types = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"]

    cloud_watch_destination {
      dimension_configuration {
        dimension_name          = "ses:configuration-set"
        dimension_value_source  = "MESSAGE_TAG"
        default_dimension_value = local.project
      }
    }
  }
}

# --- Bounces and complaints → the app (WP-2.13 follow-up) ------------------
# The suppression list above keeps SES from mailing an address that
# hard-bounced or complained, but on its own the app never knows: that
# person's alert emails stay on and nothing tells them. So bounces and
# complaints are also published to the app:
#
#   configuration set --BOUNCE, COMPLAINT--> SNS `ses-events`
#     --raw message delivery--> SQS `mail-events` --event source--> worker Lambda
#
# The worker (backend/src/lambda-worker.ts, mail/suppression.ts) flags the
# address's person and pauses their alert emails; the account and alert pages
# show a banner, and turning mail back on (POST /me/alerts/resume) takes the
# address off the suppression list (ses:DeleteSuppressedDestination, the API
# role only). Trust runs down the chain: only SES, for this configuration set
# in this account, may publish to the topic; only the topic may send to the
# queue; and the worker reads a message as an SES event only when it came
# from this queue (MAIL_EVENTS_QUEUE_ARN), never from its other queues.
#
# The topic is not KMS-encrypted: SES can publish to an encrypted topic only
# through a customer-managed key whose policy admits it (about $1 a month and
# a key policy to maintain), and SNS keeps nothing at rest past delivery. The
# queue, where the events wait, is encrypted (SSE-SQS). Locally there is no
# SES: `pnpm dev:mail:bounce <email>` runs the same handler.

locals {
  mail_events_visibility_seconds = 6 * local.worker_timeout_seconds
}

# docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "ses_events" {
  name = "${local.project}-ses-events"
}

data "aws_iam_policy_document" "ses_events_topic" {
  statement {
    sid       = "SesPublishesThisConfigurationSetOnly"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ses_events.arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sesv2_configuration_set.main.arn]
    }
  }
}

resource "aws_sns_topic_policy" "ses_events" {
  arn    = aws_sns_topic.ses_events.arn
  policy = data.aws_iam_policy_document.ses_events_topic.json
}

resource "aws_sesv2_configuration_set_event_destination" "suppression" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "suppression"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  # SES checks it may publish when the destination is created.
  depends_on = [aws_sns_topic_policy.ses_events]
}

resource "aws_sqs_queue" "mail_events_dlq" {
  name                      = "${local.project}-mail-events-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum: time to look
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "mail_events" {
  name                       = "${local.project}-mail-events"
  visibility_timeout_seconds = local.mail_events_visibility_seconds
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.mail_events_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "mail_events_dlq" {
  queue_url = aws_sqs_queue.mail_events_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.mail_events.arn]
  })
}

# Only the ses-events topic may send here.
data "aws_iam_policy_document" "mail_events_queue" {
  statement {
    sid       = "SesEventsTopicOnly"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.mail_events.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.ses_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "mail_events" {
  queue_url = aws_sqs_queue.mail_events.id
  policy    = data.aws_iam_policy_document.mail_events_queue.json
}

resource "aws_sns_topic_subscription" "mail_events" {
  topic_arn = aws_sns_topic.ses_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.mail_events.arn
  # The SES event itself is the message body (mail/suppression.ts parses it), not an SNS envelope.
  raw_message_delivery = true

  depends_on = [aws_sqs_queue_policy.mail_events]
}

# The worker consumes the queue (the event source mapping polls as its role).
data "aws_iam_policy_document" "worker_mail_events" {
  statement {
    sid       = "ConsumeMailEvents"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.mail_events.arn]
  }
}

resource "aws_iam_role_policy" "worker_mail_events" {
  name   = "mail-events-queue"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_mail_events.json
}

resource "aws_lambda_event_source_mapping" "worker_mail_events" {
  event_source_arn                   = aws_sqs_queue.mail_events.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  # Only the failed records are retried (lambda-worker.ts reports them).
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2 # counted in worker_reserved_concurrency (4 triggers x 2)
  }

  depends_on = [aws_iam_role_policy.worker_mail_events]
}

# Turning mail back on (POST /me/alerts/resume, the API) takes the person's
# address off the account-level suppression list, or SES would drop the next
# mail and report it as a bounce again. Suppression-list actions take no
# resource ARN in IAM, so "*" is the only resource; the action is the only
# one, and only the API role has it (the worker, which also sends mail, does
# not). The route allows it once a day per person (a bounce loop costs
# reputation).
data "aws_iam_policy_document" "lambda_ses_release" {
  statement {
    sid       = "ReleaseSuppressedAddress"
    actions   = ["ses:DeleteSuppressedDestination"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_ses_release" {
  name   = "ses-release-suppressed"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_ses_release.json
}

resource "aws_cloudwatch_metric_alarm" "mail_events_dlq_depth" {
  alarm_name          = "${local.project}-mail-events-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "An SES bounce or complaint was dead-lettered: the worker failed 5 times to record it (usually the database was unreachable). That person's alert emails are still on; redrive the DLQ once the worker is healthy."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.mail_events_dlq.name
  }
}

# --- Domain identity + Easy DKIM ------------------------------------------

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain_name
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Easy DKIM always returns three tokens.
resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.${local.ses_dkim_domain}"]
}

# --- Custom MAIL FROM (SPF alignment) --------------------------------------

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity   = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain = local.mail_from_domain
  # If the MX goes missing, fall back to amazonses.com rather than bouncing
  # every email (DKIM still aligns, so DMARC still passes).
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "ses_mail_from_mx" {
  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

# --- DMARC -----------------------------------------------------------------

resource "aws_route53_record" "dmarc" {
  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = [local.dmarc_record]
}

# --- IAM: the API Lambda may send, as no-reply@, through this identity only -

data "aws_iam_policy_document" "lambda_ses" {
  statement {
    sid     = "SendAsNoReplyOnly"
    actions = ["ses:SendEmail"]
    # SES v2 SendEmail authorises against the identity AND the configuration
    # set the message uses; both are named, nothing else.
    resources = [
      aws_sesv2_email_identity.domain.arn,
      aws_sesv2_configuration_set.main.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.mail_from_address]
    }
  }
}

resource "aws_iam_role_policy" "lambda_ses" {
  name   = "ses-send-no-reply"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_ses.json
}

# --- Network: SES API interface endpoint -----------------------------------
# The API Lambda has no route to the internet (network.tf), so SendEmail goes
# through PrivateLink. With private DNS, the SDK's default endpoint
# (email.<region>.amazonaws.com) resolves to the endpoint ENIs — no app
# change and no SES_REGION override. The SES API endpoint service
# (`com.amazonaws.<region>.email`) launched Dec 2025 in every SES region; the
# older `email-smtp` endpoint is SMTP-only and is not what the app uses.
#
# No custom endpoint policy: IAM above already pins the action, identity and
# From address, and the role is the only principal in the VPC that can reach
# the endpoint (security group below).

resource "aws_security_group" "vpce_ses" {
  name        = "${local.project}-vpce-ses"
  description = "SES API interface endpoint: 443 from the API Lambda only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-vpce-ses" }
}

resource "aws_vpc_security_group_ingress_rule" "vpce_ses_from_api" {
  security_group_id            = aws_security_group.vpce_ses.id
  referenced_security_group_id = aws_security_group.api_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the API Lambda"
}

resource "aws_vpc_security_group_egress_rule" "api_to_vpce_ses" {
  security_group_id            = aws_security_group.api_lambda.id
  referenced_security_group_id = aws_security_group.vpce_ses.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "SES API endpoint"
}

resource "aws_vpc_endpoint" "ses" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.email"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = slice(aws_subnet.private[*].id, 0, var.ses_endpoint_az_count)
  security_group_ids  = [aws_security_group.vpce_ses.id]
  private_dns_enabled = true

  tags = { Name = "${local.project}-ses" }
}
