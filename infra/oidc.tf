# ----------------------------------------------------------------------------
# GitHub OIDC deploy role — bootstrap-aware
#
# The OIDC provider AND the deploy role are owned by the cross-project
# bootstrap (~/github/templates/scripts/new-project-account.sh). This file
# just LOOKS UP the role and attaches this project's per-resource deploy
# policy to it.
#
# Why not create the role here:
#   - One OIDC provider per AWS account is the AWS hard limit; two
#     projects in the same account would collide.
#   - The role's trust policy lives in the bootstrap — it pins `:sub` to
#     `repo:<owner>/<repo>:environment:production`, gated by the GitHub
#     environment's required-reviewer wall. This file can't override that
#     scope, which is the point: every project in the org gets the same
#     reviewer-gated deploy surface.
#
# Pre-condition: the bootstrap must have been run for this project (see
# infra/README.md "Bootstrap workflow"). A stale `var.bootstrap_slug`
# (default `water-management`) makes the lookup fail at plan time with a clear
# "role not found" error.
# ----------------------------------------------------------------------------

data "aws_iam_role" "github_deploy" {
  name = "${var.bootstrap_slug}-deploy"
}

# ----------------------------------------------------------------------------
# Project-specific deploy permissions, attached to the bootstrap role.
# Scope every action to a specific ARN; no `s3:*` / `iam:*` wildcards.
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid = "FrontendBucketWrite"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObject",
    ]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }

  statement {
    sid       = "FrontendBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn]
  }

  statement {
    sid       = "CloudFrontInvalidation"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.frontend.arn]
  }

  statement {
    sid = "LambdaUpdate"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = [
      aws_lambda_function.backend.arn,
      aws_lambda_function.migrate.arn,
    ]
  }

  # The backend deploy runs the migrate Lambda before shipping new API code.
  # Note the implication: whoever can deploy can run migrate code with the DB
  # owner's credentials. That is the same trust boundary as deploying the API
  # itself and is gated by the `production` environment's required reviewer.
  statement {
    sid       = "MigrateInvoke"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.migrate.arn]
  }
}

resource "aws_iam_policy" "github_deploy" {
  name   = "${local.project}-github-deploy"
  policy = data.aws_iam_policy_document.github_deploy.json
}

resource "aws_iam_role_policy_attachment" "github_deploy" {
  role       = data.aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.github_deploy.arn
}
