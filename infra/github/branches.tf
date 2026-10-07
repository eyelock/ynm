# Gitflow: develop is the default branch and takes feature PRs; main moves only by release or
# hotfix PRs and carries the release tags. Neither takes a direct push, admins included. The
# branches themselves are git history, pushed from a clone, not created here.

resource "github_branch_default" "develop" {
  repository = github_repository.ynm.name
  branch     = "develop"
}

# One repository ruleset per protected branch replaces classic branch protection, so each branch
# has a single list of rules. Neither branch takes a direct push, force push or deletion; a pull
# request is required, with every conversation resolved and no approving review. The one required
# check is "All Clear", the last job of the ci workflow, which depends on every other job, so jobs
# can change without touching this file. Repository admins (role 5) can bypass in an emergency.
resource "github_repository_ruleset" "develop" {
  repository  = github_repository.ynm.name
  name        = "Develop Branch Protection"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/develop"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = 5
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = false
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = true
    }

    required_status_checks {
      strict_required_status_checks_policy = true

      required_check {
        context = "All Clear"
      }
    }
  }
}

# main moves only by release or hotfix PRs, and also requires the source-branch check from
# protect-main.yml.
resource "github_repository_ruleset" "main" {
  repository  = github_repository.ynm.name
  name        = "Main Branch Protection"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = 5
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = false
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = true
    }

    required_status_checks {
      strict_required_status_checks_policy = true

      required_check {
        context = "All Clear"
      }

      required_check {
        context = "Verify PR source branch"
      }
    }
  }
}
