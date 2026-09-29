# ----------------------------------------------------------------------------
# Private-only VPC — no internet gateway, no NAT, no public subnets
#
# Nothing in the VPC needs the internet:
#   - the API Lambda talks to Postgres, to SES (SendEmail) through the SES
#     API interface endpoint in ses.tf, to SQS (job wake-ups) through the
#     SQS interface endpoint in jobs.tf, and to Secrets Manager (its runtime
#     secret, once per cold start, secrets.tf) through the endpoint below. It
#     makes no other outbound calls; CloudWatch Logs delivery is done by the
#     Lambda service, not through the function's ENI;
#   - RDS never initiates connections;
#   - the migrate Lambda needs Secrets Manager too (the RDS-managed master
#     credentials, and its runtime secret), through the same ONE endpoint;
#   - the worker Lambda (jobs.tf) talks to Postgres, to SQS, to SES for
#     report and alert emails (reports.tf), and to Secrets Manager (its
#     runtime secret).
#
# A NAT gateway would be ~$33/month + data before any traffic; an interface
# endpoint is ~$7.30/month per AZ. If a future feature needs outbound calls
# to another AWS service, add that service's VPC endpoint, and only reach for
# a NAT for genuinely external hosts.
#
# Two subnets in two AZs because an RDS subnet group requires >= 2 AZs, and
# the Lambdas get ENIs in both so an AZ outage doesn't take the API down with
# it (the single-AZ DB would still be the bottleneck).
# ----------------------------------------------------------------------------

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true # required for interface-endpoint private DNS
  enable_dns_support   = true

  tags = { Name = "${local.project}-vpc" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${local.project}-private-${count.index + 1}" }
}

# The main route table only has the implicit `local` route — no 0.0.0.0/0.
# Explicitly associate so a later default-route change can't leak in.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.project}-private-rt" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Lock down the default security group so nothing accidentally uses it.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.project}-default-unused" }
}

# ----------------------------------------------------------------------------
# Security groups. Rules are separate resources (not inline) so the
# Lambda ↔ RDS ↔ endpoint references can't form a dependency cycle.
# ----------------------------------------------------------------------------

resource "aws_security_group" "api_lambda" {
  name        = "${local.project}-api-lambda"
  description = "API Lambda ENIs: egress to Postgres and the SES, SQS and Secrets Manager endpoints only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-api-lambda" }
}

resource "aws_security_group" "migrate_lambda" {
  name        = "${local.project}-migrate-lambda"
  description = "Migrate Lambda ENIs: egress to Postgres and the Secrets Manager endpoint only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-migrate-lambda" }
}

resource "aws_security_group" "rds" {
  name        = "${local.project}-rds"
  description = "RDS Postgres: ingress 5432 from the two Lambda SGs only; no egress."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-rds" }
}

resource "aws_security_group" "vpce" {
  name        = "${local.project}-vpce"
  description = "Secrets Manager interface endpoint: 443 from the migrate, API and worker Lambdas only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.project}-vpce" }
}

resource "aws_vpc_security_group_egress_rule" "api_to_rds" {
  security_group_id            = aws_security_group.api_lambda.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_vpc_security_group_egress_rule" "migrate_to_rds" {
  security_group_id            = aws_security_group.migrate_lambda.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_vpc_security_group_egress_rule" "migrate_to_vpce" {
  security_group_id            = aws_security_group.migrate_lambda.id
  referenced_security_group_id = aws_security_group.vpce.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Secrets Manager endpoint"
}

resource "aws_vpc_security_group_egress_rule" "api_to_vpce" {
  security_group_id            = aws_security_group.api_lambda.id
  referenced_security_group_id = aws_security_group.vpce.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Secrets Manager endpoint (runtime secret)"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_vpce" {
  security_group_id            = aws_security_group.worker_lambda.id
  referenced_security_group_id = aws_security_group.vpce.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Secrets Manager endpoint (runtime secret)"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_api" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.api_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the API Lambda"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_migrate" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.migrate_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the migrate Lambda"
}

resource "aws_vpc_security_group_ingress_rule" "vpce_from_migrate" {
  security_group_id            = aws_security_group.vpce.id
  referenced_security_group_id = aws_security_group.migrate_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the migrate Lambda"
}

resource "aws_vpc_security_group_ingress_rule" "vpce_from_api" {
  security_group_id            = aws_security_group.vpce.id
  referenced_security_group_id = aws_security_group.api_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the API Lambda (runtime secret)"
}

resource "aws_vpc_security_group_ingress_rule" "vpce_from_worker" {
  security_group_id            = aws_security_group.vpce.id
  referenced_security_group_id = aws_security_group.worker_lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the worker Lambda (runtime secret)"
}

# ----------------------------------------------------------------------------
# Secrets Manager interface endpoint (migrate → the RDS master secret; the
# API, worker and migrate Lambdas → each its own runtime secret, secrets.tf)
# ----------------------------------------------------------------------------

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = slice(aws_subnet.private[*].id, 0, var.secretsmanager_endpoint_az_count)
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true

  # Only these secrets may be read through this endpoint, each only by the
  # role that owns it: the RDS master secret by migrate, and each runtime
  # secret by its Lambda.
  policy = data.aws_iam_policy_document.secretsmanager_endpoint.json

  tags = { Name = "${local.project}-secretsmanager" }
}

data "aws_iam_policy_document" "secretsmanager_endpoint" {
  statement {
    sid       = "ReadRdsMasterSecretOnly"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.migrate_lambda.arn]
    }
  }

  # One statement per runtime secret: its own Lambda's role, its own ARN.
  dynamic "statement" {
    for_each = aws_secretsmanager_secret.runtime
    content {
      sid       = "ReadRuntimeSecret${title(statement.key)}"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [statement.value.arn]
      principals {
        type        = "AWS"
        identifiers = [local.runtime_secret_roles[statement.key].arn]
      }
    }
  }
}
