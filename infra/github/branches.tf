# Gitflow: develop is the default branch and takes feature PRs; main moves only by release or
# hotfix PRs and carries the release tags. Neither takes a direct push, admins included. The
# branches themselves are git history, pushed from a clone, not created here.

resource "github_branch_default" "develop" {
  repository = github_repository.ynm.name
  branch     = "develop"
}

locals {
  # Status checks each protected branch requires before a PR can merge. "verify" and
  # "coverage" (coverage of the lines a PR changes) are the ci workflow's jobs; "release gate"
  # (the M6 gate, frozen evals compared with the previous release) is a ci job that runs only on
  # PRs into main, as does "Verify PR source branch" from protect-main.yml.
  protected_branches = {
    main    = ["verify", "release gate", "Verify PR source branch"]
    develop = ["verify", "coverage"]
  }
}

resource "github_branch_protection" "this" {
  for_each = local.protected_branches

  repository_id  = github_repository.ynm.node_id
  pattern        = each.key
  enforce_admins = true

  required_status_checks {
    strict   = false
    contexts = each.value
  }

  # A pull request is required, with no approving review: changes go through a PR and green CI.
  required_pull_request_reviews {
    required_approving_review_count = 0
    dismiss_stale_reviews           = false
    require_code_owner_reviews      = false
    require_last_push_approval      = false
  }

  require_signed_commits          = false
  required_linear_history         = false
  require_conversation_resolution = false
  allows_force_pushes             = false
  allows_deletions                = false
  lock_branch                     = false
}
