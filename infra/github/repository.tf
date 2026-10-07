resource "github_repository" "ynm" {
  name         = var.repository
  description  = "Your named memory: persistent memory for coding agents, stored as git notes, served over MCP and CLI"
  homepage_url = "https://eyelock.github.io/ynm/"
  visibility   = var.visibility
  topics = [
    "agent-memory",
    "ai-agents",
    "claude-code",
    "git-notes",
    "mcp",
    "model-context-protocol",
    "typescript",
  ]

  has_issues      = true
  has_discussions = true
  has_projects    = true
  has_wiki        = false
  is_template     = false

  # Feature PRs into develop are squash-merged; release and hotfix PRs into main use a true
  # merge so the back-merge into develop is clean (CONTRIBUTING.md, "Branches and pull requests").
  # Rebase merge is off: it rewrites SHAs.
  allow_squash_merge          = true
  allow_merge_commit          = true
  allow_rebase_merge          = false
  allow_auto_merge            = false
  allow_update_branch         = false
  delete_branch_on_merge      = true
  squash_merge_commit_title   = "COMMIT_OR_PR_TITLE"
  squash_merge_commit_message = "COMMIT_MESSAGES"
  merge_commit_title          = "MERGE_MESSAGE"
  merge_commit_message        = "PR_TITLE"
  web_commit_signoff_required = false

  # Secret scanning and push protection only work on a public repository (a private one needs
  # GitHub Advanced Security), so they follow the visibility variable.
  dynamic "security_and_analysis" {
    for_each = var.visibility == "public" ? [1] : []
    content {
      secret_scanning {
        status = "enabled"
      }
      secret_scanning_push_protection {
        status = "enabled"
      }
    }
  }

  # A destroy archives the repository instead of deleting it.
  archive_on_destroy = true

  lifecycle {
    prevent_destroy = true
  }
}

# The docs site, built by GitHub from /docs on main.
resource "github_repository_pages" "ynm" {
  repository = github_repository.ynm.name
  build_type = "legacy"

  source {
    branch = "main"
    path   = "/docs"
  }
}
