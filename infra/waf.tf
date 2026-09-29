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
# Three per-IP rate rules, tightest first:
#   - /api/auth/*: 100 per 5 minutes (credential stuffing);
#   - /api/*: waf_rate_limit_per_ip (default 1,000), the requests that cost
#     a Lambda invocation and usually a database query;
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
# Cost: ~$5/month per ACL + $1/month per rule + $0.60 per 1M requests.
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

  # The API: every request is a Lambda invocation (and usually a query).
  rule {
    name     = "RateLimitPerIP"
    priority = 1

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

  # Every path (the API's requests count here too): the static site's
  # backstop (header above).
  rule {
    name     = "RateLimitSitePerIP"
    priority = 2

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
