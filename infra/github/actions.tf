resource "github_actions_repository_permissions" "ynm" {
  repository      = github_repository.ynm.name
  enabled         = true
  allowed_actions = "all"
}

# Workflows get a read-only GITHUB_TOKEN unless a job asks for more, and cannot approve PRs.
resource "github_workflow_repository_permissions" "ynm" {
  repository                       = github_repository.ynm.name
  default_workflow_permissions     = "read"
  can_approve_pull_request_reviews = false
}

# The gate CI runs. Moving to the next milestone is a release step, not a repository setting:
# `gh variable set YNM_MILESTONE --body <id>`. Terraform owns that the variable exists and writes
# the value only when it creates it, so no milestone id lives here.
data "github_actions_variables" "ynm" {
  name = github_repository.ynm.name
}

resource "github_actions_variable" "milestone" {
  repository    = github_repository.ynm.name
  variable_name = "YNM_MILESTONE"
  # The placeholder is never written: the precondition stops a create without a real value, and
  # ignore_changes stops an update.
  value = coalesce(var.milestone, "unset")

  lifecycle {
    ignore_changes = [value]

    precondition {
      condition     = var.milestone != null || contains(data.github_actions_variables.ynm.variables[*].name, "YNM_MILESTONE")
      error_message = "YNM_MILESTONE does not exist yet: set TF_VAR_milestone to the gate CI should run."
    }
  }
}

# GitHub never returns a secret's value, so Terraform owns that the secret exists and writes
# the value only when it creates the secret; after that the value is ignored. To rotate it:
#   TF_VAR_release_token=... terraform apply -replace=github_actions_secret.release_token
data "github_actions_secrets" "ynm" {
  name = github_repository.ynm.name
}

resource "github_actions_secret" "release_token" {
  repository  = github_repository.ynm.name
  secret_name = "RELEASE_TOKEN"
  # The placeholder is never written: the precondition stops a create without a real value, and
  # ignore_changes stops an update.
  value = coalesce(var.release_token, "unset")

  lifecycle {
    ignore_changes = [value]

    precondition {
      condition     = var.release_token != null || contains(data.github_actions_secrets.ynm.secrets[*].name, "RELEASE_TOKEN")
      error_message = "RELEASE_TOKEN does not exist yet: set TF_VAR_release_token to a token with write access to eyelock/homebrew-tap."
    }
  }
}

# A classic token with read:packages only, for installing @eyelock/otel-spool-exporter from GitHub
# Packages in CI, release and the Docker build. Like RELEASE_TOKEN, Terraform owns that the secret
# exists and writes the value only when it creates it. Set or rotate the value with
# `gh secret set YNR_READ_PACKAGES`; ignore_changes keeps that from showing as drift.
resource "github_actions_secret" "ynr_read_packages" {
  repository  = github_repository.ynm.name
  secret_name = "YNR_READ_PACKAGES"
  # The placeholder is never written: the precondition stops a create without a real value, and
  # ignore_changes stops an update.
  value = coalesce(var.ynr_read_packages, "unset")

  lifecycle {
    ignore_changes = [value]

    precondition {
      condition     = var.ynr_read_packages != null || contains(data.github_actions_secrets.ynm.secrets[*].name, "YNR_READ_PACKAGES")
      error_message = "YNR_READ_PACKAGES does not exist yet: set TF_VAR_ynr_read_packages to a classic GitHub token with only the read:packages scope."
    }
  }
}

# The environment GitHub Pages deploys through: only main and gh-pages may deploy to it.
resource "github_repository_environment" "github_pages" {
  repository  = github_repository.ynm.name
  environment = "github-pages"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "github_pages" {
  for_each = toset(["main", "gh-pages"])

  repository     = github_repository.ynm.name
  environment    = github_repository_environment.github_pages.environment
  branch_pattern = each.key
}
