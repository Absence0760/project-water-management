# ----------------------------------------------------------------------------
# Customer-managed KMS key for the database (var.rds_customer_managed_key)
#
# RDS fixes an instance's storage key at creation: it can't be changed later
# except by snapshot → copy under the new key → restore to a new instance (a
# new endpoint, downtime). Flipping the variable on a live stack forces that
# replacement, which the instance's prevent_destroy refuses at plan time. So
# this is decided once, before the first apply (docs/deployment.md § Decide
# before the first apply).
#
# Why on by default: a snapshot encrypted with the AWS-managed aws/rds key
# can't be shared with another account, and AWS Backup can't copy it into
# another account's vault (aws/rds's policy is immutable). A CMK keeps a
# cross-account backup copy (a backup account in the Organization) and a
# handover of the stack to the client's own AWS account open, adds CloudTrail
# audit of every use, and lets the key be revoked. Cost: $1/month, rising to
# $3 by the third year of automatic rotation; RDS's requests stay in the free
# tier.
#
# The risk is the key itself: disabling it stops the instance within hours
# and, after seven days, leaves it unusable; deleting it makes the database
# AND every backup and snapshot unrecoverable. Hence prevent_destroy, the
# maximum 30-day deletion window, and a key policy that lets only RDS use it.
#
# Deliberately not shared with anything else: the RDS master secret and the
# runtime secrets stay on aws/secretsmanager (the Lambdas' roles need no
# kms:Decrypt grant, and a restore re-creates the master secret anyway), the
# report and frontend buckets on SSE-S3 (docs/security.md § Accepted IaC
# findings). One key, one job: a mistake with it touches only the database.
# ----------------------------------------------------------------------------

resource "aws_kms_key" "rds" {
  count = var.rds_customer_managed_key ? 1 : 0

  description             = "${local.project}: RDS storage, backups and snapshots"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.rds_kms[0].json

  tags = { Name = "${local.project}-rds" }

  # Destroying the key destroys the database and its backups with it. A
  # teardown lifts this on purpose (infra/README.md § Tearing down).
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "rds" {
  count = var.rds_customer_managed_key ? 1 : 0

  name          = "alias/${local.project}-rds"
  target_key_id = aws_kms_key.rds[0].key_id
}

# Least privilege. The account (its IAM policies: the operator's SSO admin
# role) administers the key but can't use it directly; cryptographic use and
# grants happen only through RDS in this region, for this account. RDS takes
# one grant at instance creation and uses it for the instance's lifetime.
# A cross-account backup copy later adds a statement here for the backup
# account (docs/deployment.md § Decide before the first apply).
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.Keys.html
data "aws_iam_policy_document" "rds_kms" {
  count = var.rds_customer_managed_key ? 1 : 0

  statement {
    sid    = "KeyAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    # kms:PutKeyPolicy stays in, or a later policy edit locks the key out.
    actions = [
      "kms:CancelKeyDeletion",
      "kms:Create*",
      "kms:Delete*",
      "kms:Describe*",
      "kms:Disable*",
      "kms:Enable*",
      "kms:Get*",
      "kms:List*",
      "kms:Put*",
      "kms:Revoke*",
      "kms:RotateKeyOnDemand",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:Update*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "UseThroughRds"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["rds.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "GrantsForRds"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:CreateGrant"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["rds.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

# --- Alarm: the key disabled, scheduled for deletion or re-policied ----------
# Disabling the key stops the database about two hours later; deleting it
# (after the 30-day window) loses the database and every backup. The window
# only helps if someone hears about it, so these calls page the regional
# alerts topic the moment CloudTrail sees them:
#
# - DisableKey           the instance stops within hours (EnableKey undoes it)
# - ScheduleKeyDeletion  the database and its backups go when the window ends
#                        (CancelKeyDeletion, then EnableKey, undoes it)
# - PutKeyPolicy         a new policy can cut RDS off, or let someone else in
# - RevokeGrant          revoking RDS's grant cuts the instance off like a
#                        disable does (RetireGrant is left out: RDS retires its
#                        own grant when an instance is deleted, and that is
#                        already alarmed through the RDS event subscription)
#
# Not matched: DeleteAlias / UpdateAlias (RDS holds the key's ARN, not the
# alias, so an alias change can't reach the database), CancelKeyDeletion and
# EnableKey (the fixes). KMS's native "KMS CMK Deletion" event arrives only
# once the key is gone, too late to act on, so it isn't used.
#
# Matching the key: these four APIs accept only a key ID or key ARN, never an
# alias, and CloudTrail records requestParameters.keyId exactly as the caller
# passed it, so the pattern lists both, case-insensitively. EventBridge's
# top-level `resources` is empty for "AWS API Call via CloudTrail" events, so
# it can't be used. Failed calls (AccessDenied) match too, and the message
# carries their errorCode: an attempt is worth knowing about.
#
# "AWS API Call via CloudTrail" events reach EventBridge only while a
# CloudTrail trail logging write management events covers this region
# (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-service-event-cloudtrail.html).
# The stack deliberately doesn't create one: an Organization trail from the
# management account covers every account at once, and a second trail here
# would duplicate it (and a second copy of management events is billed).
# preapply-check.sh's `cloudtrail` check FAILs until some trail covers the
# region (infra/README.md § Operator steps, step 7a). A rule on the default
# bus matching AWS events is free.
resource "aws_cloudwatch_event_rule" "rds_kms_key_change" {
  count = var.rds_customer_managed_key ? 1 : 0

  name        = "${local.project}-rds-kms-key-change"
  description = "The database's KMS key disabled, scheduled for deletion, re-policied or a grant revoked"

  event_pattern = jsonencode({
    source        = ["aws.kms"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["kms.amazonaws.com"]
      eventName   = ["DisableKey", "ScheduleKeyDeletion", "PutKeyPolicy", "RevokeGrant"]
      requestParameters = {
        keyId = [
          { "equals-ignore-case" = aws_kms_key.rds[0].key_id },
          { "equals-ignore-case" = aws_kms_key.rds[0].arn },
        ]
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "rds_kms_key_change" {
  count = var.rds_customer_managed_key ? 1 : 0

  rule      = aws_cloudwatch_event_rule.rds_kms_key_change[0].name
  target_id = "alerts"
  arn       = aws_sns_topic.alerts.arn

  # A readable email instead of the raw CloudTrail JSON. The topic policy
  # admits this rule by ARN (alarms.tf AllowEventBridgeKmsKeyAlarm).
  input_transformer {
    input_paths = {
      event = "$.detail.eventName"
      key   = "$.detail.requestParameters.keyId"
      who   = "$.detail.userIdentity.arn"
      when  = "$.detail.eventTime"
      error = "$.detail.errorCode"
    }
    input_template = "\"${local.project}: <event> on the database's KMS key <key> (alias/${local.project}-rds) by <who> at <when> (error code, if the call failed: <error>). DisableKey or RevokeGrant stops the database within hours; ScheduleKeyDeletion loses the database and every backup when the window ends. Runbook: docs/deployment.md § Runbooks, The database's KMS key.\""
  }
}
