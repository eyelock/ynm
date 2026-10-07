# Dependabot version updates come from .github/dependabot.yml and need neither of these.
# Alerts and automatic security fixes are on.
resource "github_repository_vulnerability_alerts" "ynm" {
  repository = github_repository.ynm.name
  enabled    = true
}

resource "github_repository_dependabot_security_updates" "ynm" {
  repository = github_repository.ynm.name
  enabled    = true

  # The security-updates API needs alerts on first.
  depends_on = [github_repository_vulnerability_alerts.ynm]
}

# Private vulnerability reporting is how SECURITY.md asks for reports. The github provider has no
# resource for it, so this calls the API with gh, which reads GITHUB_TOKEN. The API answers 404
# while the repository is private, so it runs only once visibility is public. The call is
# idempotent; it runs on the first apply after that, and again only if the owner or repository
# name changes.
resource "terraform_data" "private_vulnerability_reporting" {
  count            = var.visibility == "public" ? 1 : 0
  triggers_replace = [var.owner, var.repository]

  provisioner "local-exec" {
    command = "gh api -X PUT repos/${var.owner}/${var.repository}/private-vulnerability-reporting"
  }

  depends_on = [github_repository.ynm]
}

# Secret scanning and push protection are in repository.tf, on once visibility is public.
