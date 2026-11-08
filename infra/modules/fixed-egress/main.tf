# ----------------------------------------------------------------------------
# Fixed egress: one public address for the Lambdas that reach upstreams
# with per-address limits (the data feeds' fetcher and the mirror-ingest job;
# docs/deployment.md § Fixed egress).
#
# Why: CHC limits by public address (its bot protection blocks one for hours
# above about 2 requests a second, and answers HTTP 429 past 20 open
# connections; their reply of 2026-10-27, issue #604). A Lambda outside a VPC
# leaves from AWS's shared addresses, which other accounts' functions use too,
# so someone else's crawler on the same address can get us throttled however
# politely we ask. 2026-11-05 to 11-08: the GEFS pass met HTTP 429 on 15 of 16
# runs, after 1 to 6 requests, and the preliminary pass on its first request,
# while our whole traffic to CHC was a few dozen requests a day.
#
# Shape: its OWN small VPC, apart from the private one (network.tf), so the
# private VPC keeps its no-internet guarantee and its endpoint policies
# untouched (the root module's network guardrails read only the root's *.tf
# files; this module is pinned by tests/egress.tftest.hcl instead):
#
#   two private subnets (the Lambdas' ENIs, two AZs)
#     └─ 0.0.0.0/0 ──► the NAT instance's primary ENI (public subnet, Elastic IP)
#                         └─► internet gateway ──► CHC, DWS, ECMWF, …
#   S3 in this region (the mirror bucket, DE Africa's buckets) through a free
#   gateway endpoint, off the NAT instance.
#
# A NAT instance, not a managed NAT gateway: about $13 a month (t4g.micro,
# the Elastic IP, 8 GB of gp3) against about $45 plus $0.06 a GB processed,
# and the ingest job downloads hundreds of MB a day. The trade is one EC2
# instance in one AZ: an AZ or instance failure stops the two Lambdas'
# outbound calls until EC2 recovers it (the recover and reboot alarms below),
# and the mirror lag and feed alarms page meanwhile. Nothing user-facing runs
# through it.
#
# The instance owns its primary ENI, with source/destination checking off on
# the instance. (A separate ENI attached as primary_network_interface can't
# carry that setting: the provider refuses source_dest_check beside it, and on
# 2026-11-08 an in-place update of the instance turned checking back on with
# ModifyInstanceAttribute, so the NAT dropped every forwarded packet.) The
# Elastic IP is associated with the instance; a replacement instance gets the
# same allocation, so the address never changes (patching: see
# docs/deployment.md § Fixed egress). While it boots, before the Elastic IP is
# moved onto it, a temporary public IP gives its first-boot script the internet.
# ----------------------------------------------------------------------------

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# The region from the provider, not a variable: Terraform 1.15's init
# evaluates a module call's arguments, and the root's var.aws_region carries a
# validation that reads another variable, which init can't evaluate.
data "aws_region" "current" {}

locals {
  name   = "${var.project}-egress"
  region = data.aws_region.current.region
}

resource "aws_vpc" "egress" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name}-vpc" }
}

# Lock down the default security group so nothing accidentally uses it.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "${local.name}-default-unused" }
}

resource "aws_internet_gateway" "egress" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "${local.name}-igw" }
}

# --- Public side: the NAT instance only --------------------------------------

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.egress.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  availability_zone_id    = var.zone_ids[0]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "${local.name}-public-rt" }
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.egress.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# --- Private side: the Lambdas' ENIs ------------------------------------------

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.egress.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone_id    = var.zone_ids[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "${local.name}-private-rt" }
}

resource "aws_route" "private_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat.primary_network_interface_id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# This region's S3 (the mirror bucket; DE Africa's open buckets the dam
# observations read) without the NAT instance: free, and the bulk of the
# fetcher's bytes. Other regions' buckets (ECMWF's, in eu-central-1) go
# through the NAT like any other host.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.egress.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${local.name}-s3" }
}

# --- Security groups ----------------------------------------------------------
# A group's description can't change in place (replacing a group a Lambda
# ENI holds can stall an apply for 20+ minutes); tests/egress.tftest.hcl pins
# them. Groups and rules alike take only a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*: no
# apostrophes (2026-11-08: one in a rule's description failed the first apply).

resource "aws_security_group" "lambda" {
  name        = "${local.name}-lambda"
  description = "Fixed-egress Lambda ENIs (fetcher, mirror-ingest): HTTPS out only, through the NAT instance or the S3 gateway endpoint."
  vpc_id      = aws_vpc.egress.id
  tags        = { Name = "${local.name}-lambda" }
}

resource "aws_vpc_security_group_egress_rule" "lambda_https" {
  security_group_id = aws_security_group.lambda.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to the upstreams and S3"
}

resource "aws_security_group" "nat" {
  name        = "${local.name}-nat"
  description = "NAT instance: HTTPS in from the fixed-egress Lambda SG only; HTTPS out to the internet."
  vpc_id      = aws_vpc.egress.id
  tags        = { Name = "${local.name}-nat" }
}

resource "aws_vpc_security_group_ingress_rule" "nat_from_lambda" {
  security_group_id            = aws_security_group.nat.id
  referenced_security_group_id = aws_security_group.lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the fixed-egress Lambdas"
}

resource "aws_vpc_security_group_egress_rule" "nat_https" {
  security_group_id = aws_security_group.nat.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS out (forwarded traffic and the instance package updates)"
}

# --- The NAT instance ---------------------------------------------------------

# The first version declared the NAT's ENI as a resource of its own and
# attached it as the instance's primary interface. That ENI is still the
# instance's primary interface (and holds the Elastic IP), so it is dropped
# from state, not destroyed: deleting it would cut the NAT off (2026-11-08,
# the plan for #737 wanted to). Its attachment is set to delete on
# termination, so a future replacement leaves nothing behind.
removed {
  from = aws_network_interface.nat

  lifecycle {
    destroy = false
  }
}

# The fixed address CHC sees (output public_ip; tell them it is ours).
# Associated with whichever instance is current: replacing the instance moves
# the same allocation onto the new one.
resource "aws_eip" "nat" {
  domain   = "vpc"
  instance = aws_instance.nat.id

  tags = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.egress]
}

# Amazon Linux 2023, arm64. Read at plan time, but the instance ignores later
# AMI changes (lifecycle below), so a new AMI never replaces it on an
# unrelated apply; patch by replacing it deliberately.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "nat" {
  ami           = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.instance_type

  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.nat.id]
  # Its own primary ENI forwards other hosts' packets: checking off, on the
  # instance (the header says why not on a separate ENI).
  source_dest_check = false
  # A temporary public IP for first boot (dnf needs the internet before the
  # Elastic IP is moved onto the instance); the Elastic IP then replaces it.
  associate_public_ip_address = true

  # Standard credits: a NAT this size idles; never pay for unlimited bursting.
  credit_specification {
    cpu_credits = "standard"
  }

  # IMDSv2 only, one hop: nothing on the box needs the metadata service from a container.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
  }

  # No key pair, no instance profile, no SSM: nothing logs in. A changed
  # script replaces the instance so it runs again (the address stays).
  user_data                   = file("${path.module}/nat-user-data.sh")
  user_data_replace_on_change = true

  tags = { Name = "${local.name}-nat" }

  lifecycle {
    ignore_changes = [ami]
  }

  depends_on = [aws_route.public_default]
}

# --- Recovery -----------------------------------------------------------------
# A failed host check: EC2 moves the instance to healthy hardware (same
# instance ID, so the same ENI and address). A failed instance check (a hung kernel): reboot. Both page.

resource "aws_cloudwatch_metric_alarm" "nat_system_check" {
  alarm_name          = "${local.name}-nat-system-check"
  alarm_description   = "The fixed-egress NAT instance failed its EC2 system status check; EC2 recovers it onto other hardware (same address). Until then the fetcher and mirror-ingest Lambdas reach no upstream (docs/deployment.md § Fixed egress)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed_System"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "missing"
  alarm_actions       = concat(["arn:aws:automate:${local.region}:ec2:recover"], var.alarm_topic_arns)
  ok_actions          = var.alarm_topic_arns

  dimensions = {
    InstanceId = aws_instance.nat.id
  }
}

resource "aws_cloudwatch_metric_alarm" "nat_instance_check" {
  alarm_name          = "${local.name}-nat-instance-check"
  alarm_description   = "The fixed-egress NAT instance failed its EC2 instance status check three minutes running; EC2 reboots it. Until then the fetcher and mirror-ingest Lambdas reach no upstream (docs/deployment.md § Fixed egress)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "StatusCheckFailed_Instance"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "missing"
  alarm_actions       = concat(["arn:aws:automate:${local.region}:ec2:reboot"], var.alarm_topic_arns)
  ok_actions          = var.alarm_topic_arns

  dimensions = {
    InstanceId = aws_instance.nat.id
  }
}
