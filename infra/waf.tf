# ----------------------------------------------------------------------------
# WAF — per-IP rate limits on the CloudFront distribution
#
# CloudFront ACLs MUST live in us-east-1 (scope = CLOUDFRONT is a hard AWS
# constraint regardless of where the rest of the stack runs), hence the
# aws.us_east_1 provider alias in main.tf.
#
# Coverage: the whole site, API included. The browser calls same-origin
# /api/*, CloudFront proxies it to the Lambda Function URL with the shared
# secret header, and the app rejects requests that bypass CloudFront — so
# every API request passes through this ACL.
#
# Four per-IP rate rules, tightest first:
#   - /api/auth/*: 100 per 5 minutes (credential stuffing);
#   - /api/*: waf_rate_limit_per_ip (default 1,000), the requests that cost
#     a Lambda invocation and usually a database query;
#   - /tiles/*: waf_tiles_rate_limit_per_ip (default 1,000), the map's
#     archives. Each request may move up to 2 MiB (tiles_range,
#     s3_cloudfront.tf), so the bill here is bytes, not requests: under the
#     site-wide 5,000 alone one IP could pull ~10 GB of CloudFront egress
#     every 5 minutes (~$330 a day) without tripping the request alarm. At
#     1,000 it is ~2 GB per 5 minutes at worst, which the cloudfront-bytes
#     alarm (alarms.tf) catches in its first period; real map use is a few
#     hundred small range reads in a busy 5 minutes;
#   - every path: waf_site_rate_limit_per_ip (default 5,000), a backstop for
#     the static site. Its files are cached at the edge, so a person loading
#     the SPA (a cold visit is ~150 requests of shell and chunks) or the
#     report renderer (which opens the same SPA in a fresh Chromium for every
#     PDF, from a few shared AWS Lambda addresses) shouldn't count them
#     against the API's limit. But the static site can't go unlimited either:
#     a request the WAF allows costs WAF + CloudFront $1.60-2.80/M, one it
#     blocks $0.60/M, and the cloudfront-requests alarm (alarms.tf) needs a
#     person to act. At the defaults one IP is blocked at the alarm's own
#     threshold (5,000 per 5 minutes), so a single-source flood is capped;
#     a distributed one is the alarm's job.
# A renderer blocked by any of them retries with backoff (reports/render.ts
# treats only the API's coded refusal as final), and the waf-blocked-requests
# alarm says so (docs/deployment.md, Runbooks, Request flood).
#
# No AWS managed rule groups: AWSManagedRulesCommonRuleSet blocks request
# bodies over 8 KB, and time-series uploads are legitimately ~1 MB.
#
# Cost: ~$5/month per ACL + $1/month per rule (5 rules) + $0.60 per 1M requests.
# ----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "frontend" {
  provider = aws.us_east_1
  name     = "${local.project}-frontend-acl"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Tight limit on the unauthenticated auth endpoints (login / register):
  # slows credential stuffing well below anything a person would hit.
  rule {
    name     = "RateLimitAuthPerIP"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            # Match the path the API routes on, not its raw spelling: decode
            # first (`/api/%61uth/login` is `/api/auth/login` to Hono), then
            # collapse `//`, `/./` and `/../`, then fold case.
            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH"
            }
            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-frontend-RateLimitAuthPerIP"
    }
  }

  # A CAPTCHA on sign-in, only under pressure (issue #126). Past
  # waf_signin_captcha_per_5min sign-in POSTs from one IP in 5 minutes, a
  # sign-in without a valid CAPTCHA token gets the WAF's answer instead of the
  # API's: HTTP 405 with `x-amzn-waf-action: captcha` (an API request gets no
  # interstitial page). The sign-in page shows the puzzle through the CAPTCHA
  # JavaScript API (the key below) and sends the request again with the token
  # (frontend/src/lib/auth/wafCaptcha.ts). A request with a valid token is
  # counted and goes on to the next rule. Below the threshold nobody sees a
  # puzzle. After RateLimitAuthPerIP: an IP past 100 is blocked before it is
  # offered a puzzle (each solve is billed, $0.40 per 1,000).
  #
  # Only sign-in: forgot-password and the confirmation resends reveal nothing
  # and guess nothing (the same 202 for every address), and each address is
  # capped at 10 emails a day (docs/security.md § Throttles that don't depend
  # on the WAF), so spraying them is mail cost, not account takeover.
  #
  # COUNT (waf_signin_captcha_action) keeps the rule and its metrics but stops
  # the puzzle: the switch-off if it misfires.
  rule {
    name     = "SignInCaptchaPerIP"
    priority = 1

    action {
      dynamic "captcha" {
        for_each = var.waf_signin_captcha_action == "CAPTCHA" ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = var.waf_signin_captcha_action == "COUNT" ? [1] : []
        content {}
      }
    }

    # A solved puzzle keeps that browser puzzle-free for 5 minutes (AWS's
    # default, set here so it can't drift): long enough to sign in, short
    # enough that a guesser who pays a person to solve one gets at most 5
    # minutes, still under the 100-per-5-minute block.
    captcha_config {
      immunity_time_property {
        immunity_time = 300
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_signin_captcha_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"
                field_to_match {
                  method {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "/api/auth/login"
                positional_constraint = "EXACTLY"
                field_to_match {
                  uri_path {}
                }
                # As RateLimitAuthPerIP: the path the API routes on, not its spelling.
                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "NORMALIZE_PATH"
                }
                text_transformation {
                  priority = 2
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-frontend-SignInCaptchaPerIP"
    }
  }

  # The API: every request is a Lambda invocation (and usually a query).
  rule {
    name     = "RateLimitPerIP"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_ip
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            # As the auth rule: the path as the API routes it.
            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH"
            }
            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-frontend-RateLimitPerIP"
    }
  }

  # The map's tiles: the bytes bound (header above). The path as CloudFront
  # matches /tiles/* (decoded, normalised, lowercased, as the API rules).
  rule {
    name     = "RateLimitTilesPerIP"
    priority = 3

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_tiles_rate_limit_per_ip
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/tiles/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH"
            }
            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-frontend-RateLimitTilesPerIP"
    }
  }

  # Every path (the API's requests count here too): the static site's
  # backstop (header above).
  rule {
    name     = "RateLimitSitePerIP"
    priority = 4

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_site_rate_limit_per_ip
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-frontend-RateLimitSitePerIP"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.project}-frontend-acl"
  }
}

# ----------------------------------------------------------------------------
# The CAPTCHA JavaScript API's key for the site's domain (the sign-in page
# renders the puzzle itself; an API request gets a 405, not the interstitial).
# The key only lets pages on its token domains render this account's puzzles:
# it ships in the site's JavaScript, like any CAPTCHA site key. Terraform
# marks it sensitive and outputs.tf's waf_captcha_api_key sends it to a GitHub
# secret, so it sits in no variable file or log, but it protects nothing.
# CLOUDFRONT-scope keys live in us-east-1, like the ACL.
# ----------------------------------------------------------------------------

resource "aws_wafv2_api_key" "captcha" {
  provider      = aws.us_east_1
  scope         = "CLOUDFRONT"
  token_domains = [var.domain_name]
}

locals {
  # The CAPTCHA script's origin, and its challenge script's: jsapi.js loads
  # challenge.js from the same id on sdk.awswaf.com, and without it no token
  # is issued (checked against AWS's SDK, 2026-09; docs/security.md).
  waf_captcha_origin   = var.waf_captcha_integration_url == "" ? "" : regex("^https://[^/]+", var.waf_captcha_integration_url)
  waf_challenge_origin = replace(local.waf_captcha_origin, ".captcha-sdk.awswaf.com", ".sdk.awswaf.com")
  waf_captcha_origins  = var.waf_captcha_integration_url == "" ? [] : [local.waf_captcha_origin, local.waf_challenge_origin]
}
