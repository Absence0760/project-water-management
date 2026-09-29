# ----------------------------------------------------------------------------
# Response security headers (CloudFront response-headers policies)
#
# Two policies, because the two behaviours serve different things:
#   site — the static SvelteKit SPA from S3 (default behaviour)
#   api  — JSON from the Lambda (/api/*): nothing in it should ever render
#
# Both set HSTS (2 years, subdomains, no preload — preload is only accepted
# for a registrable domain, and jaredhoward.com is not ours to preload),
# nosniff, X-Frame-Options DENY + frame-ancestors 'none', a strict
# Referrer-Policy, X-XSS-Protection: 0 (the legacy auditor is itself an XSS
# vector; CSP replaces it), COOP and a Permissions-Policy. `override = true`
# everywhere so an origin can never weaken them.
#
# ---- The site CSP and SvelteKit's inline bootstrap ----------------------
#
# adapter-static emits ONE inline <script> into index.html (it sets the
# __sveltekit_<version> global and imports the entry chunks). Its text embeds
# the content-hashed chunk names, so its sha256 changes on every build. A hash
# pinned here would break the site on the next deploy, and rewriting this
# policy from the deploy job would mean Terraform drift plus a much broader
# deploy role.
#
# So the policy is split across two layers that the browser enforces
# TOGETHER (every CSP delivered must allow a resource for it to load):
#
#   1. This header — everything that must not depend on the build:
#      default-src 'self', object-src 'none', base-uri, form-action,
#      frame-ancestors (ignored in <meta>), connect-src 'self' (same-origin
#      /api only), and `script-src 'self' 'unsafe-inline'`.
#   2. SvelteKit's own <meta http-equiv="content-security-policy"> with
#      `script-src 'self' 'sha256-<bootstrap>'`, which kit computes per build
#      when `kit.csp.mode = 'hash'` is set in frontend/svelte.config.js.
#
# The effective script policy is the intersection: only same-origin files and
# the one hashed bootstrap run; an injected inline script passes the header
# but fails the meta policy. 'unsafe-inline' in the header is therefore NOT
# the effective policy — as long as the meta tag exists. deploy-frontend.yml
# runs infra/scripts/check-csp.mjs on the build and refuses to deploy an
# index.html whose inline scripts are not all covered by a meta-CSP hash, so
# that cannot silently regress.
#
# style-src keeps 'unsafe-inline' (accepted, documented in
# docs/security.md): Svelte templates and uPlot set inline style attributes,
# which only 'unsafe-inline' (or a per-value 'unsafe-hashes') allows, and
# app.html carries a small inline <style> (no-flash background). CSS
# injection cannot run script; the script policy above is what stops XSS.
#
# img-src allows data: for the inline SVG icons in the CSS. No third-party
# origin appears anywhere: fonts, scripts and styles are all self-hosted.
# ----------------------------------------------------------------------------

locals {
  # The sign-in CAPTCHA (waf.tf) is the one exception to "no third-party
  # origin": once waf_captcha_integration_url is set, script-src and
  # connect-src also allow exactly the account's CAPTCHA SDK origin and its
  # challenge script's (local.waf_captcha_origins), and media-src allows
  # data: for the puzzle's audio version (the SDK plays data:audio/aac).
  # Nothing else: no 'unsafe-eval' (the SDK doesn't need it), no blob: and no
  # wildcard. The SDK's web-font stylesheet on static.captcha.awswaf.com stays
  # blocked (the puzzle falls back to the system font). SvelteKit's meta CSP
  # adds the same two origins to its script-src (frontend/svelte.config.js).
  csp_site = join("; ", [
    "default-src 'self'",
    join(" ", concat(["script-src 'self' 'unsafe-inline'"], local.waf_captcha_origins)),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' data:",
    "font-src 'self'",
    join(" ", concat(["connect-src 'self'"], local.waf_captcha_origins)),
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ])

  # JSON only: nothing may load, run or frame.
  csp_api = join("; ", [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ])

  permissions_policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"

  hsts_max_age_seconds = 63072000 # 2 years
}

resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${local.project}-site-security-headers"
  comment = "SPA: CSP (script hash comes from SvelteKit's meta tag), HSTS, nosniff, DENY framing"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp_site
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    xss_protection {
      protection = false
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "api" {
  name    = "${local.project}-api-security-headers"
  comment = "API JSON: default-src 'none', HSTS, nosniff, DENY framing"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp_api
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    xss_protection {
      protection = false
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}
