# ----------------------------------------------------------------------------
# Issued evidence packs' PDFs (roadmap WP-3.14 "Rendering: reuse WP-2.15",
# issue #71; docs/evidence-pack.md § The PDF, docs/deployment.md § Evidence
# packs, backend/migrations/119_pack_render.sql)
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

# --- The worker's check of the renderer's answer ---------------------------------
#
# The renderer's answer (render-results) names the PDF's SHA-256, which the
# worker records on the pack for good and verify publishes. So before
# recording, the worker HEADs the object under that hash's key with checksum
# mode on and records only when it exists and S3's stored checksum is that
# hash (reports/storage.ts headPackPdf, jobs/handlers/pack-render.ts): a buggy
# or compromised renderer can't fix a hash of bytes the bucket doesn't hold.
# HeadObject needs s3:GetObject; the worker gets it on packs/* only (it never
# reads a PDF's bytes: the code only HEADs).
#
# The worker is in the private VPC with no internet, so it reaches S3 through
# an S3 interface endpoint (network.tf: "add that service's VPC endpoint"),
# like SQS, SES and Secrets Manager: security-group rules reference groups
# only, and the endpoint policy allows only this read of this bucket's
# packs/ by the worker. One AZ (~$7.30/month): both subnets still reach it.
# A free S3 gateway endpoint would need a prefix-list egress rule, which the
# network guardrails refuse (tests/guardrails.tftest.hcl, run "network").

data "aws_iam_policy_document" "worker_packs" {
  statement {
    sid       = "HeadPackPdfs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.packs.arn}/packs/*"]
  }
}

resource "aws_iam_role_policy" "worker_packs" {
  name   = "pack-pdf-checks"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_packs.json
}

resource "aws_security_group" "vpce_s3" {
  name        = "${local.project}-vpce-s3"
  description = "S3 interface endpoint: 443 from the API and worker Lambdas only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-vpce-s3" }
}

resource "aws_vpc_security_group_ingress_rule" "vpce_s3_from_worker" {
  security_group_id            = aws_security_group.vpce_s3.id
  referenced_security_group_id = aws_security_group.worker_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the worker Lambda (pack PDF checks)"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_vpce_s3" {
  security_group_id            = aws_security_group.worker_lambda.id
  referenced_security_group_id = aws_security_group.vpce_s3.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "S3 endpoint"
}

# With private DNS, the SDK's default s3.<region>.amazonaws.com (and the
# bucket's virtual-hosted name) resolve to the endpoint's ENIs: no app change.
# private_dns_only_for_inbound_resolver_endpoint is false: there is no S3
# gateway endpoint in this VPC for the in-VPC names to fall back on.
resource "aws_vpc_endpoint" "s3" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = slice(aws_subnet.private[*].id, 0, 1)
  security_group_ids  = [aws_security_group.vpce_s3.id]
  private_dns_enabled = true

  dns_options {
    private_dns_only_for_inbound_resolver_endpoint = false
  }

  # Only the worker's read of packs/, and the API's put of a bundle
  # (pack_bundles.tf), in the packs bucket.
  policy = data.aws_iam_policy_document.s3_endpoint.json

  tags = { Name = "${local.project}-s3" }
}

data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid       = "WorkerHeadsPackPdfs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.packs.arn}/packs/*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker_lambda.arn]
    }
  }
  # The API stores a pack's reproduction bundle when it issues it (pack_bundles.tf).
  statement {
    sid       = "ApiPutsPackBundles"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.packs.arn}/packs/*.zip"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.lambda.arn]
    }
  }
}
