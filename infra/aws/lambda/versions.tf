terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State bucket from infra/terraform-state. The key is per client and comes from
  # clients/<client>.s3.tfbackend: terraform init -backend-config=clients/<client>.s3.tfbackend
  backend "s3" {
    bucket       = "ynm-terraform-state.eyelock.net"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project   = "ynm"
      Owner     = var.owner
      Client    = var.client
      ManagedBy = "terraform"
    }
  }
}
