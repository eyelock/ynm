# Authoritative: a label created in the UI and not listed here is removed on apply. GitHub's
# defaults plus the ones Dependabot applies (dependencies and one per ecosystem in
# .github/dependabot.yml); the issue templates use bug, enhancement and infrastructure, and the
# ideas discussion form uses idea.
locals {
  labels = {
    "accessibility"    = { color = "f143ab", description = "Barrier affecting people with disabilities" }
    "bug"              = { color = "d73a4a", description = "Something isn't working" }
    "dependencies"     = { color = "0366d6", description = "Pull requests that update a dependency file" }
    "docker"           = { color = "21ceff", description = "Pull requests that update docker code" }
    "documentation"    = { color = "0075ca", description = "Improvements or additions to documentation" }
    "duplicate"        = { color = "cfd3d7", description = "This issue or pull request already exists" }
    "enhancement"      = { color = "a2eeef", description = "New feature or request" }
    "github_actions"   = { color = "000000", description = "Pull requests that update GitHub Actions code" }
    "good first issue" = { color = "7057ff", description = "Good for newcomers" }
    "help wanted"      = { color = "008672", description = "Extra attention is needed" }
    "invalid"          = { color = "e4e669", description = "This doesn't seem right" }
    "idea"             = { color = "fbca04", description = "A suggestion from the ideas discussion form" }
    "infrastructure"   = { color = "5319e7", description = "CI, workflows, branch protection, deployment" }
    "javascript"       = { color = "168700", description = "Pull requests that update javascript code" }
    "question"         = { color = "d876e3", description = "Further information is requested" }
    "terraform"        = { color = "5c4ee5", description = "Pull requests that update Terraform code" }
    "wontfix"          = { color = "ffffff", description = "This will not be worked on" }
  }
}

resource "github_issue_labels" "ynm" {
  repository = github_repository.ynm.name

  dynamic "label" {
    for_each = local.labels
    content {
      name        = label.key
      color       = label.value.color
      description = label.value.description
    }
  }
}
