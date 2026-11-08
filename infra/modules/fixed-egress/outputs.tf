output "public_ip" {
  description = "The one address the fixed-egress Lambdas reach the internet from."
  value       = aws_eip.nat.public_ip
}

output "private_subnet_ids" {
  description = "Subnets for the fixed-egress Lambdas' vpc_config."
  value       = aws_subnet.private[*].id
}

output "lambda_security_group_id" {
  description = "Security group for the fixed-egress Lambdas' vpc_config."
  value       = aws_security_group.lambda.id
}
