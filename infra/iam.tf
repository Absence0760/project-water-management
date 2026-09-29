# ----------------------------------------------------------------------------
# The Lambdas' baseline execution permissions: logs, and for the three VPC
# Lambdas the ENI actions (issue #126 § IAM).
#
# No AWS-managed policy is attached. AWSLambdaBasicExecutionRole and
# AWSLambdaVPCAccessExecutionRole grant logs:CreateLogGroup,
# logs:CreateLogStream and logs:PutLogEvents on "*", so any one compromised
# function (the fetcher and renderer are the two with internet access) could
# write into another function's log group and forge the lines the alarms
# count, or create log groups of its own. Instead:
#
# - Each role may create streams and put events in its own function's log
#   group only. No role has logs:CreateLogGroup: every log group is
#   Terraform-managed (retention set) and exists before its function
#   (depends_on), so Lambda never needs to create one.
# - The API, worker and migrate roles get the six EC2 actions AWS lists for a
#   VPC Lambda, which have no resource-level scoping ("*", as AWS documents:
#   https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html#configuration-vpc-permissions),
#   plus AWS's recommended Deny on the same actions when the call comes from
#   the function's own code (lambda:SourceFunctionArn is set only on calls
#   the code makes, so the Lambda service still manages the ENIs).
# ----------------------------------------------------------------------------

locals {
  lambda_arn_prefix    = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:"
  log_group_arn_prefix = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:"

  # Every Lambda: its role and its own (Terraform-managed) log group.
  lambda_logging = {
    api      = { role = aws_iam_role.lambda, log_group = aws_cloudwatch_log_group.lambda.name }
    migrate  = { role = aws_iam_role.migrate_lambda, log_group = aws_cloudwatch_log_group.migrate.name }
    worker   = { role = aws_iam_role.worker_lambda, log_group = aws_cloudwatch_log_group.worker.name }
    fetcher  = { role = aws_iam_role.fetcher_lambda, log_group = aws_cloudwatch_log_group.fetcher.name }
    renderer = { role = aws_iam_role.renderer_lambda, log_group = aws_cloudwatch_log_group.renderer.name }
  }

  # The VPC Lambdas, by function ARN (built from the name: referencing the
  # function would cycle through its depends_on on these policies).
  lambda_vpc_functions = {
    api     = { role = aws_iam_role.lambda, function_arn = "${local.lambda_arn_prefix}${local.project}-backend" }
    migrate = { role = aws_iam_role.migrate_lambda, function_arn = "${local.lambda_arn_prefix}${local.project}-migrate" }
    worker  = { role = aws_iam_role.worker_lambda, function_arn = "${local.lambda_arn_prefix}${local.project}-worker" }
  }

  lambda_vpc_eni_actions = [
    "ec2:CreateNetworkInterface",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeSubnets",
    "ec2:DeleteNetworkInterface",
    "ec2:AssignPrivateIpAddresses",
    "ec2:UnassignPrivateIpAddresses",
  ]
}

data "aws_iam_policy_document" "lambda_logs" {
  for_each = local.lambda_logging

  statement {
    sid       = "WriteOwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.log_group_arn_prefix}${each.value.log_group}:*"]
  }
}

resource "aws_iam_role_policy" "lambda_logs" {
  for_each = local.lambda_logging

  name   = "own-log-group"
  role   = each.value.role.id
  policy = data.aws_iam_policy_document.lambda_logs[each.key].json
}

data "aws_iam_policy_document" "lambda_vpc_eni" {
  for_each = local.lambda_vpc_functions

  statement {
    sid       = "ManageVpcEnis"
    actions   = local.lambda_vpc_eni_actions
    resources = ["*"]
  }

  statement {
    sid       = "DenyEniCallsFromFunctionCode"
    effect    = "Deny"
    actions   = concat(local.lambda_vpc_eni_actions, ["ec2:DetachNetworkInterface"])
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "lambda:SourceFunctionArn"
      values   = [each.value.function_arn]
    }
  }
}

resource "aws_iam_role_policy" "lambda_vpc_eni" {
  for_each = local.lambda_vpc_functions

  name   = "vpc-enis"
  role   = each.value.role.id
  policy = data.aws_iam_policy_document.lambda_vpc_eni[each.key].json
}
