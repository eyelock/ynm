terraform {
  required_version = ">= 1.10"

  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.58"
    }
  }

  # State bucket from infra/terraform-state. The key is per tenant and comes from
  # tenants/<tenant>.s3.tfbackend: terraform init -backend-config=tenants/<tenant>.s3.tfbackend
  # Runs need AWS credentials that can use it (the ynm-terraform profile).
  backend "s3" {
    bucket       = "ynm-terraform-state.eyelock.net"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

# Credentials for the tenant come from AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET (a machine-to-machine
# application authorised for the Management API); only the domain is configuration.
provider "auth0" {
  domain = var.domain
}
