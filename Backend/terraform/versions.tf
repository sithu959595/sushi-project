terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

locals {
  # A workspace represents one independently managed deployment. Keeping the
  # account and stage together prevents a staging state from being applied with
  # production resource names (or against the wrong AWS account).
  deployment_targets = {
    default = {
      aws_account_id     = "058264296908"
      stage              = "dev"
      frontend_subdomain = null
    }
    default-staging = {
      aws_account_id     = "058264296908"
      stage              = "staging"
      frontend_subdomain = "www.staging"
    }
    default-prod = {
      aws_account_id     = "058264296908"
      stage              = "prod"
      frontend_subdomain = "www"
    }
    account-6528 = {
      aws_account_id     = "971431176528"
      stage              = "dev"
      frontend_subdomain = null
    }
    account-6528-staging = {
      aws_account_id     = "971431176528"
      stage              = "staging"
      frontend_subdomain = null
    }
    account-6528-prod = {
      aws_account_id     = "971431176528"
      stage              = "prod"
      frontend_subdomain = null
    }
  }

  # An unlisted workspace fails during configuration instead of silently
  # sharing another environment's state or naming scheme.
  deployment_target = local.deployment_targets[terraform.workspace]
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  # Keep each local workspace tied to its intended AWS account. This prevents
  # an accidental apply with credentials for the other project account.
  allowed_account_ids = [
    local.deployment_target.aws_account_id,
  ]
}

# CloudFront only accepts ACM viewer certificates issued in us-east-1. Keep a
# dedicated provider so the frontend remains valid if the regional backend is
# moved later.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile

  allowed_account_ids = [
    local.deployment_target.aws_account_id,
  ]
}
