terraform {
  # use_lockfile needs 1.10+; ephemeral variables and write-only arguments
  # (the runtime secrets, secrets.tf) need 1.11+, and aws_secretsmanager_
  # secret_version's secret_string_wo needs the AWS provider's 6.x line below.
  # The exact version is pinned for tfenv in infra/.terraform-version.
  required_version = ">= 1.11"

  # Partial backend config — the bucket name embeds the account ID, which
  # stays out of this public repo. The estate bootstrap
  # (~/github/templates/scripts/new-project-account.sh) creates the bucket as
  # `water-management-tfstate-<account-id>` with versioning + SSE. The
  # operator writes infra/backend.config (gitignored; shape in
  # backend.config.example) and runs:
  #
  #   terraform init -backend-config=backend.config
  #
  # Locking uses S3 conditional writes (`use_lockfile`). No DynamoDB table.
  # The state bucket is always us-east-1 (where the bootstrap puts it),
  # independent of var.aws_region.
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.44"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    # The key pair that signs report downloads (reports.tf).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# Primary region — VPC, RDS, Lambdas, the frontend bucket and their alarms.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# CloudFront requires its ACM certificate, its WAF web ACL and its CloudWatch
# metrics to live in us-east-1, regardless of where the rest of the stack runs.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

locals {
  project = "water-management"

  tags = {
    Project     = local.project
    ManagedBy   = "terraform"
    Environment = "production"
    Repository  = var.github_repo
  }

  site_origin = "https://${var.domain_name}"
}

data "aws_caller_identity" "current" {}
