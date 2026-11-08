variable "project" {
  description = "Name prefix (local.project in the root module)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR of the egress VPC; a /24 public subnet and two /24 private subnets are carved from it."
  type        = string
}

variable "zone_ids" {
  description = "Two availability-zone IDs for the private subnets; the first also holds the public subnet and the NAT instance."
  type        = list(string)

  validation {
    condition     = length(var.zone_ids) == 2
    error_message = "zone_ids takes exactly two zone IDs."
  }
}

variable "instance_type" {
  description = "The NAT instance's type (arm64: the AMI is Amazon Linux 2023 arm64)."
  type        = string
}

variable "alarm_topic_arns" {
  description = "SNS topics the NAT instance's recover and reboot alarms also notify (empty: they only act)."
  type        = list(string)
  default     = []
}
