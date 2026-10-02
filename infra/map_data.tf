# ----------------------------------------------------------------------------
# The catchment map's data in production (issue #288, #326; docs/maps.md,
# docs/deployment.md § Map tiles and § Reference datasets)
#
# Two buckets, kept apart because one is public and the other is not:
#
#   - tiles: what the browser reads, the basemap (tiles/south-africa.pmtiles),
#     the relief's DEM (tiles/terrain.pmtiles) and the labels' glyph ranges
#     (tiles/fonts/<font stack>/<range>.pbf, with tiles/fonts/OFL.txt). Served
#     same-origin through the site's /tiles/* CloudFront behaviour
#     (s3_cloudfront.tf) with its own OAC, so the CSP's connect-src 'self'
#     covers it unchanged. The tiles_range function lets through only bounded
#     byte ranges of an archive, glyph ranges and the licence (the cost
#     bound). The API reads the DEM from here too, for delineation, by ranged
#     GetObject through the S3 interface endpoint (packs.tf), when
#     delineation_dem is on: one key, nothing else. And the water occurrence
#     tracing a dam reads (tiles/water.pmtiles, #326 C2), when dam_trace_water
#     is on: one more key. The browser never asks for it, but it sits under
#     tiles/ like the rest, so /tiles/* serves it by bounded ranges too (JRC
#     Global Surface Water allows that: docs/maps.md § Sources).
#   - reference: the operator's pre-processed reference datasets
#     (reference/<kind>/…), private. The migrate Lambda reads one object per
#     load (lambda-migrate.ts, geo/referenceLoad.ts) and writes it into RDS
#     as the schema owner, through .github/workflows/load-reference.yml,
#     which only runs in the `production` environment. Only the kinds
#     docs/maps.md § Sources marks allowed load; the code refuses the rest.
#
# The operator uploads the objects with their own SSO session (deployment.md);
# no role here can write either bucket, and the deploy role touches neither.
# Both SSE-S3, like the frontend, reports and packs buckets: the tiles are
# public, and the reference files are the operator's own downloads of
# licensed data, read by one role (docs/security.md § Accepted IaC findings).
#
# Cost: storage of ~3.5 GB of tiles and a few hundred MB of reference files
# (well under $1/month); multipart uploads that never finish are aborted after
# 7 days so a broken 2 GB upload doesn't sit there billed. Viewer traffic is
# CloudFront egress, bounded per request by tiles_range and per IP by the
# WAF's site-wide rate limit.
# ----------------------------------------------------------------------------

locals {
  # The DEM delineation reads (delineation/dem.ts), and the relief the browser draws.
  dem_key = "tiles/terrain.pmtiles"
  # The water occurrence tracing a dam reads (delineation/damTrace.ts): JRC GSW as Terrarium tiles.
  water_key = "tiles/water.pmtiles"
}

# ============================================================================
# The tiles bucket
# ============================================================================

resource "aws_s3_bucket" "tiles" {
  bucket = "${local.project}-tiles-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "tiles" {
  bucket                  = aws_s3_bucket.tiles.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3: the objects are public map data served through CloudFront's OAC (see
# frontend in s3_cloudfront.tf). docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "tiles" {
  bucket = aws_s3_bucket.tiles.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "tiles" {
  bucket = aws_s3_bucket.tiles.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tiles" {
  bucket = aws_s3_bucket.tiles.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_cloudfront_origin_access_control" "tiles" {
  name                              = "${local.project}-tiles-oac"
  description                       = "OAC for the ${local.project} map tiles bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Only this distribution reads, and only under tiles/. No ListBucket: a miss
# stays 403, and tiles_range answers 404 before S3 for every path it doesn't
# know anyway.
data "aws_iam_policy_document" "tiles_bucket_policy" {
  statement {
    sid       = "AllowCloudFrontReadTiles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.tiles.arn}/tiles/*"]

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
      aws_s3_bucket.tiles.arn,
      "${aws_s3_bucket.tiles.arn}/*",
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

resource "aws_s3_bucket_policy" "tiles" {
  bucket = aws_s3_bucket.tiles.id
  policy = data.aws_iam_policy_document.tiles_bucket_policy.json
}

# --- Delineation reads the DEM (issue #326 B-delineate) --------------------------
#
# With delineation_dem on, the API's DEM_URL is s3://<tiles>/tiles/terrain.pmtiles
# (lambda.tf) and its role may GetObject that one key (ranged reads; the
# endpoint policy in packs.tf allows the same). Off (the default), DEM_URL is
# empty, the Map offers no Delineate, and the role holds nothing here.

data "aws_iam_policy_document" "api_dem" {
  statement {
    sid       = "ReadDelineationDem"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.tiles.arn}/${local.dem_key}"]
  }
}

resource "aws_iam_role_policy" "api_dem" {
  count  = var.delineation_dem ? 1 : 0
  name   = "delineation-dem"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.api_dem.json
}

# --- Tracing a dam reads the water occurrence (issue #326 C2) ----------------------
#
# With dam_trace_water on, the API's WATER_URL is s3://<tiles>/tiles/water.pmtiles
# (lambda.tf) and its role may GetObject that one key. A trace reads a handful
# of small tiles (at most a 512-cell window) in milliseconds, so it needs no
# larger Lambda. Off (the default), WATER_URL is empty, the Map offers no
# Trace a dam, and the role holds nothing here.

data "aws_iam_policy_document" "api_water" {
  statement {
    sid       = "ReadDamTraceWater"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.tiles.arn}/${local.water_key}"]
  }
}

resource "aws_iam_role_policy" "api_water" {
  count  = var.dam_trace_water ? 1 : 0
  name   = "dam-trace-water"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.api_water.json
}

# ============================================================================
# The reference bucket
# ============================================================================

resource "aws_s3_bucket" "reference" {
  bucket = "${local.project}-reference-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "reference" {
  bucket                  = aws_s3_bucket.reference.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3: one reader (the migrate role), no cross-account access; a CMK
# would add a key policy for no secrecy gained. docs/security.md § Accepted IaC
# findings.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "reference" {
  bucket = aws_s3_bucket.reference.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "reference" {
  bucket = aws_s3_bucket.reference.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "reference" {
  bucket = aws_s3_bucket.reference.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# The policy names no reader: the migrate role's own policy is the grant
# (below), as the API's pack-bundle grant is (pack_bundles.tf).
data "aws_iam_policy_document" "reference_bucket_policy" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.reference.arn,
      "${aws_s3_bucket.reference.arn}/*",
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

resource "aws_s3_bucket_policy" "reference" {
  bucket = aws_s3_bucket.reference.id
  policy = data.aws_iam_policy_document.reference_bucket_policy.json
}

# The migrate Lambda reads one reference file per load (GetObject only: no
# list, put or delete). It reaches S3 through the interface endpoint in
# packs.tf, whose policy allows the same read.
data "aws_iam_policy_document" "migrate_reference" {
  statement {
    sid       = "ReadReferenceFiles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.reference.arn}/reference/*"]
  }
}

resource "aws_iam_role_policy" "migrate_reference" {
  name   = "read-reference-files"
  role   = aws_iam_role.migrate_lambda.id
  policy = data.aws_iam_policy_document.migrate_reference.json
}

resource "aws_vpc_security_group_ingress_rule" "vpce_s3_from_migrate" {
  security_group_id            = aws_security_group.vpce_s3.id
  referenced_security_group_id = aws_security_group.migrate_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the migrate Lambda (reference loads)"
}

resource "aws_vpc_security_group_egress_rule" "migrate_to_vpce_s3" {
  security_group_id            = aws_security_group.migrate_lambda.id
  referenced_security_group_id = aws_security_group.vpce_s3.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "S3 endpoint"
}
