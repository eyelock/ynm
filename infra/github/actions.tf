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

resource "github_actions_variable" "milestone" {
  repository    = github_repository.ynm.name
  variable_name = "YNM_MILESTONE"
  value         = var.milestone
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
