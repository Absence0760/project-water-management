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
