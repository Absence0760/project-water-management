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

  # ListBucket makes S3 answer a missing key with 404 (NoSuchKey) instead of
  # 403 (AccessDenied): without it S3 won't say whether a key exists. It
  # can't expose a listing through CloudFront: a listing is a GET on the
  # bucket root, and spa_rewrite sends every path ending in "/" (the root
  # included) to /index.html and refuses dot segments, and the default
  # behaviour forwards no query string (CachingOptimized, no origin request
  # policy), so no list-type/prefix parameter reaches S3. The reports and
  # packs buckets keep GetObject only (reports.tf, packs.tf): their misses
  # stay 403, which leaks nothing about which reports or packs exist.
  statement {
    sid       = "AllowCloudFrontServicePrincipalList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn]

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
#   prerendered pages (PRERENDERED), the landing page in each language
#   (issues #57, #137), the legal pages and the methods page, are served from
#   their own HTML: /welcome, /welcome/af, /privacy, /terms, /methods,
#   /data-sources →
#   <path>.html (static HTML for crawlers and link previews). A language
#   added to the table (packages/engine/src/languages.ts) adds its
#   /welcome/<code> here; the test below fails until it does.
#   A path WITH an extension goes to S3 only where the build keeps files:
#   under STATIC_DIRS (/_app/… and frontend/static's directories) or one of
#   STATIC_FILES at the root (frontend/static's files and the HTML the build
#   writes). Anything else (/report.pdf, /wp-login.php, /.env) gets a small
#   404 page from the function itself, never reaching S3, whose miss would be
#   an XML error. A missing file inside those locations reaches S3 and gets
#   its 404 (ListBucket, above). infra/scripts/cloudfront-functions.test.mjs
#   runs this code and checks both lists against frontend/static and the
#   prerendered routes, so a new static file can't silently 404.
#
# api_strip_prefix — /api/* behaviour. The browser calls same-origin
#   /api/auth/login; the Hono app routes /auth/login (dev hits it directly on
#   :3001 with no prefix). Stripping here keeps the app prefix-agnostic.
#   It also sets X-Viewer-Address to the viewer's IP as CloudFront saw the
#   connection (event.viewer.ip), overwriting any value the viewer sent: the
#   one client address the API trusts, and only on a request that carries the
#   shared secret (backend/src/http/clientAddress.ts; the sign-up throttle).
#
# tiles_range — /tiles/* behaviour (map_data.tf). The map's self-hosted
#   basemap, relief and label glyphs are public objects the browser reads
#   same-origin, the archives with HTTP Range (docs/maps.md § Basemap). The
#   PMTiles archives are large (the basemap about 1 GB, the relief about
#   2 GB), so a whole-file GET would make one request cost gigabytes of
#   CloudFront egress, and the WAF's per-IP rate limits, which count
#   requests, would bound nothing. This function lets through only what the
#   map asks for:
#     - a .pmtiles archive by one closed byte range (`bytes=a-b`) of at most
#       MAX_RANGE bytes (2 MiB; PMTiles reads a 16 KiB header, then
#       directories and tiles, each far smaller). No Range, an open or
#       multi-part range, or a longer one gets 416 from the function itself.
#       HEAD passes (no body);
#     - a glyph range, /tiles/fonts/<font stack>/<n>-<n+255>.pbf (KBs each),
#       and the font licence, /tiles/fonts/OFL.txt;
#     - anything else under /tiles/ gets 404 without reaching S3.
#   So one request moves at most 2 MiB, and the site-wide per-IP limit
#   (waf_site_rate_limit_per_ip) bounds what one address can pull
#   (docs/deployment.md § Map tiles, the cost bound).
#   infra/scripts/cloudfront-functions.test.mjs runs it.
#
# Cost: $0.10 per million invocations.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.project}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Serve /index.html for extension-less SPA routes, 404 for files the build doesn't have"
  publish = true
  code    = <<-EOT
    var PRERENDERED = ['/welcome', '/welcome/af', '/privacy', '/terms', '/methods', '/data-sources'];
    var STATIC_DIRS = ['_app', 'fonts', 'help', 'landing'];
    var STATIC_FILES = [
      'index.html', 'welcome.html', 'privacy.html', 'terms.html', 'methods.html', 'data-sources.html',
      'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
      'icon-maskable-512.png', 'robots.txt', 'site.webmanifest'
    ];
    var NOT_FOUND = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>Page not found</title></head>' +
      '<body><h1>Page not found</h1><p>There is nothing at this address.</p>' +
      '<p><a href="/">Go to the home page</a></p></body></html>';

    function notFound() {
      return {
        statusCode: 404,
        statusDescription: 'Not Found',
        headers: {
          'content-type': { value: 'text/html; charset=utf-8' },
          'cache-control': { value: 'no-store' },
          'x-content-type-options': { value: 'nosniff' }
        },
        body: { encoding: 'text', data: NOT_FOUND }
      };
    }

    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (PRERENDERED.indexOf(uri) !== -1) {
        request.uri = uri + '.html';
        return request;
      }
      var segments = uri.split('/');
      for (var i = 0; i < segments.length; i++) {
        if (segments[i] === '.' || segments[i] === '..') return notFound();
      }
      var last = segments[segments.length - 1];
      if (last.indexOf('.') === -1) {
        request.uri = '/index.html';
        return request;
      }
      var known = segments.length === 2
        ? STATIC_FILES.indexOf(last) !== -1
        : STATIC_DIRS.indexOf(segments[1]) !== -1;
      return known ? request : notFound();
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

resource "aws_cloudfront_function" "tiles_range" {
  name    = "${local.project}-tiles-range"
  runtime = "cloudfront-js-2.0"
  comment = "Map tiles: PMTiles by one bounded byte range, glyph ranges and the font licence; 404 for anything else"
  publish = true
  code    = <<-EOT
    var MAX_RANGE = 2097152;
    var ARCHIVE = /^\/tiles\/[a-z0-9-]+\.pmtiles$/;
    var GLYPHS = /^\/tiles\/fonts\/[A-Za-z0-9%_,.-]+\/([0-9]+)-([0-9]+)\.pbf$/;
    var LICENCE = '/tiles/fonts/OFL.txt';
    var RANGE = /^bytes=([0-9]{1,15})-([0-9]{1,15})$/;

    function refuse(code, description) {
      return {
        statusCode: code,
        statusDescription: description,
        headers: {
          'content-type': { value: 'text/plain; charset=utf-8' },
          'cache-control': { value: 'no-store' },
          'x-content-type-options': { value: 'nosniff' }
        },
        body: { encoding: 'text', data: description }
      };
    }

    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.indexOf('..') !== -1) return refuse(404, 'Not Found');
      if (uri === LICENCE) return request;
      var g = GLYPHS.exec(uri);
      if (g) {
        var start = parseInt(g[1], 10);
        var end = parseInt(g[2], 10);
        return start % 256 === 0 && end === start + 255 && end <= 65535 ? request : refuse(404, 'Not Found');
      }
      if (!ARCHIVE.test(uri)) return refuse(404, 'Not Found');
      if (request.method === 'HEAD') return request;
      var r = RANGE.exec(request.headers.range ? request.headers.range.value : '');
      if (!r) return refuse(416, 'Range Not Satisfiable');
      var first = parseInt(r[1], 10);
      var last = parseInt(r[2], 10);
      if (last < first || last - first + 1 > MAX_RANGE) return refuse(416, 'Range Not Satisfiable');
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
#   - /packs/*   → S3 packs bucket (issued evidence packs' PDFs) via its own
#                  OAC, the same signed URLs only (packs.tf)
#   - /tiles/*   → S3 tiles bucket (the map's basemap, relief and glyphs) via
#                  its own OAC, public, bounded byte ranges only (map_data.tf)
#
# The browser never calls the Function URL. CloudFront stamps every /api/*
# request with X-CloudFront-Shared-Secret (random_password below, also in
# the API's runtime secret) and the app rejects requests without it. Direct hits to the
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
# and the API's runtime secret (secrets.tf, which rewrites it in the same
# apply through replace_triggered_by). Rotate with
# `scripts/tf.sh apply -var-file=… -replace=random_password.cloudfront_shared_secret`
# (a few seconds of 403s while CloudFront and Lambda converge).
#
# This is the one runtime value still in Terraform state: custom_header's
# value is not a write-only argument, so an ephemeral source couldn't reach it.
# A state reader could call the Function URL directly (past the WAF), not
# forge a session.
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

  # Evidence pack PDFs (packs.tf): the private, Object Lock packs bucket, read
  # only through this OAC, for requests carrying a CloudFront signed URL.
  origin {
    domain_name              = aws_s3_bucket.packs.bucket_regional_domain_name
    origin_id                = "s3-packs"
    origin_access_control_id = aws_cloudfront_origin_access_control.packs.id
  }

  # The map's tiles, relief and glyphs (map_data.tf): the tiles bucket, read
  # only through its own OAC, public to every viewer (no signed URLs).
  origin {
    domain_name              = aws_s3_bucket.tiles.bucket_regional_domain_name
    origin_id                = "s3-tiles"
    origin_access_control_id = aws_cloudfront_origin_access_control.tiles.id
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
      # Lambda's own error rather than a CloudFront 504. The Function URL
      # streams (lambda.tf invoke_mode): CloudFront passes the chunked
      # response through as it arrives, and this is also the longest wait
      # between two of its packets.
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

  # /packs/* -> the packs bucket, exactly as /reports/* (signed URLs from the
  # same key group, uncached, GET/HEAD, the file name the only thing
  # forwarded). The keys are packs/<project>/<pack>/<sha256>.pdf, so no
  # rewrite; the SPA must never own a URL under /packs (the pack pages live
  # under /projects/:id/packs/): check_reports_path.mjs reserves it too.
  ordered_cache_behavior {
    path_pattern               = "/packs/*"
    target_origin_id           = "s3-packs"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false                                  # PDFs are compressed already
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.report_downloads.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
    trusted_key_groups         = [aws_cloudfront_key_group.report_downloads.id]
  }

  # /tiles/* -> the tiles bucket (map_data.tf): the basemap and relief
  # PMTiles, the label glyphs and their licence. The keys are tiles/…, so no
  # rewrite; tiles_range (above) lets through only bounded byte ranges of an
  # archive, glyph ranges and the licence. CachingOptimized: the objects are
  # public and the same for every viewer, and CloudFront caches byte ranges
  # (Range is forwarded on its own, ETag comes back from S3, which the PMTiles
  # reader uses to notice a replaced archive). A replaced object is served
  # stale until an invalidation (docs/deployment.md § Map tiles). No
  # compression: the archives are compressed inside, and compressing a range
  # would break it. The API's header policy (default-src 'none', nosniff)
  # suits data files. The SPA must never own a URL under /tiles
  # (scripts/guards/check_reports_path.mjs reserves it).
  ordered_cache_behavior {
    path_pattern               = "/tiles/*"
    target_origin_id           = "s3-tiles"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.tiles_range.arn
    }
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
