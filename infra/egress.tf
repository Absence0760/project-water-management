# ----------------------------------------------------------------------------
# Fixed egress (var.fixed_egress_enabled; modules/fixed-egress,
# docs/deployment.md § Fixed egress)
#
# The fetcher (feeds.tf) and the mirror-ingest job (ingest.tf) are the
# Lambdas that call upstreams with per-address limits (CHC above all). Off,
# they run outside any VPC and leave from AWS's shared Lambda addresses; on,
# they run in their own small egress VPC and leave from one Elastic IP, ours
# alone. The private VPC (network.tf) is untouched either way: the egress VPC
# is a separate VPC, never peered, holding nothing but these two Lambdas'
# ENIs, so neither Lambda gains a path to the database.
# ----------------------------------------------------------------------------

locals {
  fixed_egress_on = var.fixed_egress_enabled

  # Both Lambdas' vpc_config while it is on (an empty list otherwise).
  fixed_egress_vpc_config = local.fixed_egress_on ? [{
    subnet_ids         = module.fixed_egress[0].private_subnet_ids
    security_group_ids = [module.fixed_egress[0].lambda_security_group_id]
  }] : []
}

module "fixed_egress" {
  source = "./modules/fixed-egress"
  count  = local.fixed_egress_on ? 1 : 0

  project       = local.project
  vpc_cidr      = var.fixed_egress_vpc_cidr
  zone_ids      = local.subnet_zone_ids
  instance_type = var.fixed_egress_instance_type
  # The NAT instance's recover and reboot alarms page at the essential tier.
  alarm_topic_arns = local.alarms_essential ? [aws_sns_topic.alerts.arn] : []
}
