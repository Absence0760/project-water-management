# ----------------------------------------------------------------------------
# Amazon SES — transactional email (verify, password reset, invitations)
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
