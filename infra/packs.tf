# ----------------------------------------------------------------------------
# Issued evidence packs' PDFs (roadmap WP-3.14 "Rendering: reuse WP-2.15",
# issue #71; docs/evidence-pack.md § The PDF, docs/deployment.md § Evidence
# packs, backend/migrations/116_pack_render.sql)
#
# Issuing a pack queues a pack_render job, which the renderer Lambda
# (reports.tf) prints exactly as it prints a report: the pack's own page,
# through CloudFront, with a single-use render token. Unlike a report, the PDF
# is kept for good: its SHA-256 is recorded on the pack once and answered by
# the public verify lookup (GET /verify/:code), so the object behind that hash
# must never be deleted or replaced. Hence a bucket of its own:
#
#   - versioned, with Object Lock: every object is retained for
#     var.pack_retention_days from its upload (default retention), and no
#     lifecycle rule expires anything;
#   - keys are content-addressed, packs/<project>/<pack>/<sha256>.pdf
#     (app_record_pack_pdf derives the same key), so a second render is a
#     second object, never an overwrite of the recorded one;
#   - the renderer may only PutObject under packs/ (no read, list, delete or
#     retention change), with the upload's own SHA-256 checksum, which S3
#     checks against the bytes (and Object Lock requires of every put);
#   - downloads go through the site's /packs/* CloudFront behaviour
#     (s3_cloudfront.tf) with its own OAC, for CloudFront signed URLs from the
#     report-downloads key group only, like /reports/*: the API checks the
#     reader and signs; it never touches the bucket.
#
# Retention mode: GOVERNANCE, not COMPLIANCE. Governance keeps every object
# from deletion and overwrite for anyone without s3:BypassGovernanceRetention
# (which no role here holds), while still letting the account's
# administrator remove an object in an emergency, e.g. a court order or a
# personal-information request the retention can't override. COMPLIANCE would
# make that impossible for anyone, the root user included, for the whole
# retention period. An operator decision (docs/deployment.md § Evidence packs);
# switching to COMPLIANCE is a one-line change here and can't be undone for
# objects already written.
# ----------------------------------------------------------------------------

resource "aws_s3_bucket" "packs" {
  bucket = "${local.project}-packs-${data.aws_caller_identity.current.account_id}"
  # Object Lock needs versioning (below); set at creation.
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "packs" {
  bucket = aws_s3_bucket.packs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "packs" {
  bucket = aws_s3_bucket.packs.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.pack_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.packs]
}

resource "aws_s3_bucket_public_access_block" "packs" {
  bucket                  = aws_s3_bucket.packs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, as the reports bucket and for the same reasons (reports.tf,
# docs/security.md § Accepted IaC findings): private, written only by the
# renderer role, read only by CloudFront's OAC for short signed URLs.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "packs" {
  bucket = aws_s3_bucket.packs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "packs" {
  bucket = aws_s3_bucket.packs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Deliberately no aws_s3_bucket_lifecycle_configuration: nothing here expires.

data "aws_iam_policy_document" "packs_bucket_policy" {
  # Only this distribution (through the /packs/* behaviour's OAC) reads PDFs;
  # CloudFront itself refuses any request without a valid signature.
  statement {
    sid       = "AllowCloudFrontReadPackPdfs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.packs.arn}/packs/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.packs.arn,
      "${aws_s3_bucket.packs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "packs" {
  bucket = aws_s3_bucket.packs.id
  policy = data.aws_iam_policy_document.packs_bucket_policy.json

  depends_on = [aws_s3_bucket_public_access_block.packs]
}

# The renderer stores a pack's PDF: PutObject under packs/ only. Object Lock's
# default retention applies to each put without the caller naming it, so no
# s3:PutObjectRetention (which would let it shorten nothing, but name a
# retention); never a read, list, delete or bypass.
data "aws_iam_policy_document" "renderer_packs" {
  statement {
    sid       = "PutPackPdfs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.packs.arn}/packs/*"]
  }
}

resource "aws_iam_role_policy" "renderer_packs" {
  name   = "pack-pdfs"
  role   = aws_iam_role.renderer_lambda.id
  policy = data.aws_iam_policy_document.renderer_packs.json
}

resource "aws_cloudfront_origin_access_control" "packs" {
  name                              = "${local.project}-packs-oac"
  description                       = "OAC for the ${local.project} evidence pack PDFs bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
