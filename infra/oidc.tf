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

  # The trust policy is bootstrap-owned, but everything this file grants rides
  # on it, so the plan refuses to attach permissions to a role whose trust has
  # drifted from "this repo's production environment, and nothing else".
  # The subject may be the slug form (repo:<owner>/<repo>) or GitHub's
  # immutable-claims form (repo:<owner>@<id>/<repo>@<id>), which the bootstrap
  # reads from the API; both are accepted, anything wider is not.
  # (The provider returns assume_role_policy URL-decoded; IAM collapses
  # single-element lists to strings, hence the flatten([...]).)
  lifecycle {
    postcondition {
      condition = length([
        for s in flatten([try(jsondecode(self.assume_role_policy).Statement, [])]) : s if try(s.Effect, "") == "Allow"
        ]) > 0 && alltrue([
        for s in flatten([try(jsondecode(self.assume_role_policy).Statement, [])]) :
        try(s.Effect, "") != "Allow" || (
          toset(flatten([try(s.Action, [])])) == toset(["sts:AssumeRoleWithWebIdentity"]) &&
          length(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])])) == 1 &&
          alltrue([
            for sub in flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])]) :
            can(regex(local.deploy_sub_pattern, sub))
          ]) &&
          toset(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:aud"], [])])) == toset(["sts.amazonaws.com"]) &&
          length(keys(try(s.Condition.StringLike, {}))) == 0
        )
      ])
      error_message = "The bootstrap deploy role's trust policy must allow only sts:AssumeRoleWithWebIdentity, with exactly one StringEquals sub for ${var.github_repo}'s `production` environment and aud = sts.amazonaws.com (no StringLike / wildcards). Fix the bootstrap (new-project-account.sh) before planning."
    }
  }
}

locals {
  # ^repo:<owner>(@<id>)?/<repo>(@<id>)?:environment:production$
  deploy_sub_pattern = format(
    "^repo:%s(@[0-9]+)?/%s(@[0-9]+)?:environment:production$",
    replace(split("/", var.github_repo)[0], ".", "\\."),
    replace(split("/", var.github_repo)[1], ".", "\\."),
  )
}

# ----------------------------------------------------------------------------
# Project-specific deploy permissions, attached to the bootstrap role.
# Scope every action to a specific ARN; no `s3:*` / `iam:*` wildcards.
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy" {
  # `aws s3 sync` from local files to the bucket (deploy-frontend.yml) lists
  # the bucket, puts and, with --delete, deletes; it never reads an object.
  statement {
    sid = "FrontendBucketWrite"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
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
      aws_lambda_function.worker.arn,
      aws_lambda_function.fetcher.arn,
      # By name: the renderer exists only once renderer_image_tag is set (reports.tf).
      local.renderer_function_arn,
    ]
  }

  # The renderer's container image (reports.tf). GetAuthorizationToken has no
  # resource-level permissions (AWS): it only mints the docker login; what
  # the login may push is the repository statement below.
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "RendererImagePush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeRepositories",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.renderer.arn]
  }

  # Read-only: when UpdateFunctionCode moves the renderer to a new image,
  # Lambda checks the repository policy for its pull statement (reports.tf
  # renderer_ecr) and, finding none, tries to add one. AWS lists
  # GetRepositoryPolicy (with SetRepositoryPolicy, deliberately NOT granted)
  # for the principal that creates or updates an image function:
  # https://docs.aws.amazon.com/lambda/latest/dg/images-create.html#gettingstarted-images-permissions
  # Reading lets Lambda see the statement is already there; without write,
  # a missing statement fails the deploy loudly instead of being added.
  statement {
    sid       = "RendererImageLambdaCheck"
    actions   = ["ecr:GetRepositoryPolicy"]
    resources = [aws_ecr_repository.renderer.arn]
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
