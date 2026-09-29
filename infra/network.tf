# ----------------------------------------------------------------------------
# Private-only VPC — no internet gateway, no NAT, no public subnets
#
# Nothing in the VPC needs the internet:
#   - the API Lambda talks to Postgres, to SES (SendEmail, and
#     DeleteSuppressedDestination when someone turns mail back on) through
#     the SES API interface endpoint in ses.tf (its endpoint policy names the
#     API and worker roles and their actions only), to SQS (job wake-ups) through the
#     SQS interface endpoint in jobs.tf, and to Secrets Manager (its runtime
#     secret, once per cold start, secrets.tf) through the endpoint below. It
#     makes no other outbound calls; CloudWatch Logs delivery is done by the
#     Lambda service, not through the function's ENI;
#   - RDS never initiates connections;
#   - the API, worker and migrate Lambdas read their runtime secret from
#     Secrets Manager (secrets.tf), and migrate also the RDS-managed master
#     credentials, all through ONE interface endpoint;
#   - the worker Lambda (jobs.tf) talks to Postgres, to SQS through the same
#     SQS interface endpoint (its jobs, fetch, ingest, render and mail-event
#     queues; jobs.tf), and to SES through the same SES API endpoint for
#     report and alert emails (the rules are in reports.tf).
#
# The two Lambdas that do need the internet run OUTSIDE the VPC, with no
# database access: the data feeds' fetcher (feeds.tf) and the report
# renderer (reports.tf).
#
# Security groups: API, migrate and worker Lambdas; RDS (5432 from those
# three only); one per interface endpoint (Secrets Manager here, SQS in
# jobs.tf, SES in ses.tf). tests/guardrails.tftest.hcl (run "network")
# pins all of this, and every security group's description.
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

# AZs are chosen by zone ID, not by name or list position. Zone names are
# shuffled per account (af-south-1a here may be another account's
# af-south-1b) and the list's order is not a contract, so `names[0..1]` could
# pick different physical zones in another account or after AWS adds one.
# Zone IDs (afs1-az1, afs1-az2, ...) name the same physical zone everywhere;
# the two lowest available IDs are taken, so the subnets only move if one of
# those zones stops being available. Opt-in zones (Local Zones, Wavelength)
# are excluded: an RDS subnet group and Lambda ENIs need regular AZs.
data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  subnet_zone_ids = slice(sort(data.aws_availability_zones.available.zone_ids), 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true # required for interface-endpoint private DNS
  enable_dns_support   = true

  tags = { Name = "${local.project}-vpc" }
}

resource "aws_subnet" "private" {
  count                = 2
  vpc_id               = aws_vpc.main.id
  cidr_block           = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone_id = local.subnet_zone_ids[count.index]

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
#
# A security group's `description` can't be changed in place: editing it
# replaces the group, and AWS won't delete a group while a Lambda ENI still
# uses it, which can stall an apply for 20+ minutes. Keep each description
# accurate before the first apply (AWS allows only a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
# there: no apostrophes or em dashes). The network test pins them verbatim,
# so a change is deliberate. Rule descriptions update in place.
# ----------------------------------------------------------------------------

resource "aws_security_group" "api_lambda" {
  name        = "${local.project}-api-lambda"
  description = "API Lambda ENIs: egress to Postgres and the SQS, SES and Secrets Manager endpoints only."
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
  description = "RDS Postgres: ingress 5432 from the API, migrate and worker Lambda SGs only; no egress."
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
