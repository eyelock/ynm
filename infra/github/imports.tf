# Adopt the live repository into state. On a fresh state these import; once imported they are
# no-ops. To set the repository up from nothing (a new owner or name), delete this file first.

import {
  to = github_repository.ynm
  id = "ynm"
}

import {
  to = github_repository_pages.ynm
  id = "ynm"
}

import {
  to = github_branch_default.develop
  id = "ynm"
}

import {
  to = github_branch_protection.this["main"]
  id = "ynm:main"
}

import {
  to = github_branch_protection.this["develop"]
  id = "ynm:develop"
}

import {
  to = github_issue_labels.ynm
  id = "ynm"
}

import {
  to = github_actions_repository_permissions.ynm
  id = "ynm"
}

import {
  to = github_workflow_repository_permissions.ynm
  id = "ynm"
}

import {
  to = github_actions_variable.milestone
  id = "ynm:YNM_MILESTONE"
}

import {
  to = github_actions_secret.release_token
  id = "ynm:RELEASE_TOKEN"
}

import {
  to = github_actions_secret.ynr_read_packages
  id = "ynm:YNR_READ_PACKAGES"
}

import {
  to = github_repository_environment.github_pages
  id = "ynm:github-pages"
}

import {
  to = github_repository_environment_deployment_policy.github_pages["main"]
  id = "ynm:github-pages:61494374"
}

import {
  to = github_repository_environment_deployment_policy.github_pages["gh-pages"]
  id = "ynm:github-pages:61494372"
}

import {
  to = github_repository_vulnerability_alerts.ynm
  id = "ynm"
}

import {
  to = github_repository_dependabot_security_updates.ynm
  id = "ynm"
}
