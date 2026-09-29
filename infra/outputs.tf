# Pushed to GitHub by ~/github/templates/scripts/export-tf-vars.sh: each output
# name is uppercased verbatim (lambda_function_name → LAMBDA_FUNCTION_NAME);
# sensitive outputs become secrets, the rest variables.

output "aws_region" {
  description = "Primary AWS region — the deploy workflows' AWS_REGION."
  value       = var.aws_region
}

output "frontend_bucket" {
  description = "S3 bucket that hosts the built frontend. CI uploads to this bucket."
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID. CI uses this for cache invalidation."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "The *.cloudfront.net domain, useful while DNS is propagating."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "lambda_function_name" {
  description = "API Lambda function name. deploy-backend.yml updates its code."
  value       = aws_lambda_function.backend.function_name
}

output "migrate_function_name" {
  description = "Migrate Lambda function name. deploy-backend.yml updates and invokes it before the API."
  value       = aws_lambda_function.migrate.function_name
}

output "worker_function_name" {
  description = "Worker Lambda function name (background jobs, jobs.tf). deploy-backend.yml updates its code after the API."
  value       = aws_lambda_function.worker.function_name
}

output "fetcher_function_name" {
  description = "Fetcher Lambda function name (data feeds, feeds.tf). deploy-backend.yml updates its code after the worker."
  value       = aws_lambda_function.fetcher.function_name
}

output "renderer_function_name" {
  description = "Renderer Lambda function name (server-side reports, reports.tf). deploy-backend.yml moves it to each release's image once it exists (it is created only when renderer_image_tag is set)."
  value       = local.renderer_function_name
}

output "renderer_ecr_repository" {
  description = "Name of the renderer image's ECR repository. deploy-backend.yml pushes each release's image to it (the registry URL comes from the account at deploy time)."
  value       = aws_ecr_repository.renderer.name
}

output "reports_bucket" {
  description = "Private S3 bucket of report PDFs (7-day lifecycle)."
  value       = aws_s3_bucket.reports.bucket
}

# The database's names, for infra/scripts/restore-db.sh: a restore has to land
# in this subnet group, security group and parameter group, and the parameter
# group's name carries a generated suffix (name_prefix, rds.tf), so the script
# reads them here rather than guessing. Not secret; export-tf-vars.sh pushes
# them as plain GitHub variables, which no workflow reads.
output "db_instance_identifier" {
  description = "RDS instance identifier. restore-db.sh restores beside it and swaps identifiers."
  value       = aws_db_instance.main.identifier
}

output "db_subnet_group_name" {
  description = "RDS subnet group (the private subnets). restore-db.sh restores into it."
  value       = aws_db_subnet_group.main.name
}

output "db_security_group_id" {
  description = "Security group of the RDS instance (5432 from the VPC Lambdas only). restore-db.sh attaches it to the restored instance."
  value       = aws_security_group.rds.id
}

output "db_parameter_group_name" {
  description = "RDS parameter group (TLS enforced, slow-query logging without bind values). Its name has a generated suffix, so restore-db.sh reads it here."
  value       = aws_db_parameter_group.main.name
}

output "public_site_url" {
  description = "Public URL of the site."
  value       = local.site_origin
}

output "lambda_function_url" {
  description = "Direct HTTPS URL of the API Function URL. For debugging only — it returns 403 without the CloudFront shared secret."
  value       = aws_lambda_function_url.backend.function_url
  sensitive   = true
}

# Sensitive — embeds the AWS account ID. export-tf-vars.sh pushes sensitive
# outputs to GitHub *secrets*, read by the workflows as
# ${{ secrets.AWS_DEPLOY_ROLE_ARN }}.
output "aws_deploy_role_arn" {
  description = "ARN of the bootstrap-created deploy role that GitHub Actions assumes via OIDC."
  value       = data.aws_iam_role.github_deploy.arn
  sensitive   = true
}

# The sign-in CAPTCHA (waf.tf). deploy-frontend.yml bakes both into the build
# as PUBLIC_WAF_CAPTCHA_SCRIPT_URL / PUBLIC_WAF_CAPTCHA_API_KEY; empty script
# URL = no puzzle (the page says to wait). The key ships in the site's
# JavaScript by design, but the provider marks it sensitive, so it goes to a
# GitHub secret rather than a variable.
output "waf_captcha_script_url" {
  description = "The CAPTCHA JavaScript API script (jsapi.js) for this account, or empty until waf_captcha_integration_url is set."
  value       = var.waf_captcha_integration_url == "" ? "" : "${var.waf_captcha_integration_url}jsapi.js"
}

output "waf_captcha_api_key" {
  description = "The CAPTCHA JavaScript API key for the site's domain (aws_wafv2_api_key.captcha)."
  value       = aws_wafv2_api_key.captcha.api_key
  sensitive   = true
}
