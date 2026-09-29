# ----------------------------------------------------------------------------
# S3 bucket hosting the static SvelteKit SPA build
# ----------------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  # Bucket names are global; the account ID suffix avoids collisions.
  bucket = "${local.project}-frontend-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, not a customer-managed key: the bucket holds the public static site,
# served to everyone through CloudFront, and a CMK would need a key policy for
# CloudFront's origin access control for no secrecy gained.
# docs/security.md § Accepted IaC findings.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Only CloudFront (via OAC) can read objects from the bucket.
data "aws_iam_policy_document" "frontend_bucket_policy" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

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
      aws_s3_bucket.frontend.arn,
      "${aws_s3_bucket.frontend.arn}/*",
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

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket_policy.json
}

# ----------------------------------------------------------------------------
# ACM certificate (must live in us-east-1 for CloudFront), DNS-validated in
# the delegated child zone. The zone's NS delegation from jaredhoward.com
# (bootstrap stage 3) must be live before the first apply, or validation
# hangs until it times out.
# ----------------------------------------------------------------------------

resource "aws_acm_certificate" "frontend" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.frontend.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "frontend" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ----------------------------------------------------------------------------
# CloudFront Functions (viewer-request)
#
# spa_rewrite  — default behaviour. The frontend is a pure SPA (adapter-static
#   fallback index.html, ssr = false): deep links like /projects/<id> have no
#   object in S3. Any path whose last segment has no file extension is served
#   /index.html with a 200, and the client router takes over. Done here rather
#   than with a distribution-wide custom_error_response because those also
#   rewrite the API's own 403/404 JSON responses into index.html. The
#   prerendered pages, the landing page (issue #57), the legal pages and the
#   methods page, are served from their own HTML: /welcome, /privacy, /terms,
#   /methods → <path>.html
#   (static HTML for crawlers and link previews).
#
# api_strip_prefix — /api/* behaviour. The browser calls same-origin
#   /api/auth/login; the Hono app routes /auth/login (dev hits it directly on
#   :3001 with no prefix). Stripping here keeps the app prefix-agnostic.
#   It also sets X-Viewer-Address to the viewer's IP as CloudFront saw the
#   connection (event.viewer.ip), overwriting any value the viewer sent: the
#   one client address the API trusts, and only on a request that carries the
#   shared secret (backend/src/http/clientAddress.ts; the sign-up throttle).
#
# Cost: $0.10 per million invocations.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.project}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Serve /index.html for extension-less SPA routes"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      var last = uri.substring(uri.lastIndexOf('/') + 1);
      if (uri === '/welcome' || uri === '/privacy' || uri === '/terms' || uri === '/methods') {
        request.uri = uri + '.html';
      } else if (last.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_function" "api_strip_prefix" {
  name    = "${local.project}-api-strip-prefix"
  runtime = "cloudfront-js-2.0"
  comment = "Strip the /api prefix and stamp the viewer address before forwarding to the Lambda Function URL"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      request.uri = request.uri.substring(4) || '/';
      request.headers['x-viewer-address'] = { value: event.viewer.ip };
      return request;
    }
  EOT
}

# ----------------------------------------------------------------------------
# CloudFront Origin Access Control + distribution
#
# One origin for the browser: water-management.jaredhoward.com.
#   - default    → S3 frontend bucket via OAC (signed sigv4)
#   - /api/*     → Lambda Function URL (custom origin + shared secret header)
#   - /reports/* → S3 reports bucket via its own OAC, CloudFront signed URLs
#                  only (reports.tf)
#
# The browser never calls the Function URL. CloudFront stamps every /api/*
# request with X-CloudFront-Shared-Secret (random_password below, also in
# the Lambda env) and the app rejects requests without it. Direct hits to the
# Function URL — publicly reachable by AWS design — therefore get 403, so the
# WAF + per-IP rate limit on this distribution covers the API too.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.project}-frontend-oac"
  description                       = "OAC for the ${local.project} frontend bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Shared secret — generated once, fed to both the origin custom_header (below)
# and the Lambda env (lambda.tf). Rotate with
# `terraform apply -replace=random_password.cloudfront_shared_secret`
# (a few seconds of 403s while CloudFront and Lambda converge).
resource "random_password" "cloudfront_shared_secret" {
  length  = 48
  special = false
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${local.project} frontend + API"
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class # PriceClass_All: the only class with South African edges
  web_acl_id          = aws_wafv2_web_acl.frontend.arn

  aliases = [var.domain_name]

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # Report PDFs (reports.tf): the private reports bucket, read only through
  # this OAC, for requests carrying a CloudFront signed URL.
  origin {
    domain_name              = aws_s3_bucket.reports.bucket_regional_domain_name
    origin_id                = "s3-reports"
    origin_access_control_id = aws_cloudfront_origin_access_control.reports.id
  }

  origin {
    # url_id is the per-Function-URL stable identifier; the full URL is
    # `https://<url_id>.lambda-url.<region>.on.aws/`. CloudFront needs
    # just the hostname here.
    domain_name = "${aws_lambda_function_url.backend.url_id}.lambda-url.${var.aws_region}.on.aws"
    origin_id   = "lambda-api"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # Above the Lambda's 30 s timeout so a slow model run surfaces as the
      # Lambda's own error rather than a CloudFront 504.
      origin_read_timeout = 35
    }
    custom_header {
      name  = "X-CloudFront-Shared-Secret"
      value = random_password.cloudfront_shared_secret.result
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  # /api/* -> Lambda Function URL. CachingDisabled is critical here —
  # CachingOptimized would serve other users' API responses, which is at
  # best a privacy leak and at worst session bleeding. AllViewerExceptHostHeader
  # forwards everything (cookies, body, query, Origin) except Host — Host has
  # to be the Function URL hostname for AWS to route it.
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "lambda-api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.api_strip_prefix.arn
    }
  }

  # /reports/* -> the reports bucket, for signed URLs only (trusted_key_groups:
  # CloudFront refuses an unsigned, expired or altered request with 403 before
  # the origin). The object keys are reports/<project>/<report>.pdf, so the
  # path needs no rewrite. The SPA must never own a URL under /reports (its
  # report pages live under /projects/:id/): scripts/guards/check_reports_path.mjs
  # fails CI on a top-level reports or dynamic route, or a static file there
  # (pnpm test:guards). CachingDisabled: a PDF is private to a
  # project's members, and every link is a fresh URL anyway. The API's header
  # policy (default-src 'none', nosniff, no-referrer) suits a download too.
  ordered_cache_behavior {
    path_pattern               = "/reports/*"
    target_origin_id           = "s3-reports"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false                                  # PDFs are compressed already
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.report_downloads.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
    trusted_key_groups         = [aws_cloudfront_key_group.report_downloads.id]
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# ----------------------------------------------------------------------------
# Route 53 alias records in the child zone
# ----------------------------------------------------------------------------

resource "aws_route53_record" "site_a" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}
