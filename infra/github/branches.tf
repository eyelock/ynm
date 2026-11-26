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
      # Not strict: a pull request need not be up to date with its base, only green. A stacked
      # or queued PR is not re-run every time its base moves.
      strict_required_status_checks_policy = false

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
      # Not strict: a pull request need not be up to date with its base, only green. A stacked
      # or queued PR is not re-run every time its base moves.
      strict_required_status_checks_policy = false

      required_check {
        context = "All Clear"
      }

      required_check {
        context = "Verify PR source branch"
      }
    }
  }
}

# Nobody deletes or force-pushes main or develop, repository admins included. This ruleset has no
# bypass actors on purpose. The two rulesets above let admins bypass for emergencies, which
# included deletion: on 2026-10-08 main was deleted by GitHub's delete-branch-on-merge, which ran
# as an admin, when a pull request with main as its head was merged. Rules from every active
# ruleset apply together, so an admin can still bypass the pull request and status checks, but
# not this. It was created by hand first and is adopted by the import in imports.tf.
resource "github_repository_ruleset" "never_delete" {
  repository  = github_repository.ynm.name
  name        = "Never Delete Main or Develop"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/main", "refs/heads/develop"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true
  }
}

# Only a release tag is created, and once created it cannot move or go. The release workflow runs
# on any `v*` tag, so who may create one is who may publish a release. Tag creation is limited to
# repository admins (role 5), who bypass the rules for the release itself; no one else may create,
# move or delete a tag, so a published version does not change underneath its checksums and
# attestations. Applying this is a human step: `terraform apply` in infra/github.
resource "github_repository_ruleset" "release_tags" {
  repository  = github_repository.ynm.name
  name        = "Release Tags"
  target      = "tag"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/tags/v*"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = 5
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  rules {
    creation         = true
    update           = true
    deletion         = true
    non_fast_forward = true
  }
}
