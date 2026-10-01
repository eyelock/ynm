# Dependabot version updates come from .github/dependabot.yml and need neither of these.
# Security alerts and automatic security fixes are off.
resource "github_repository_vulnerability_alerts" "ynm" {
  repository = github_repository.ynm.name
  enabled    = false
}

resource "github_repository_dependabot_security_updates" "ynm" {
  repository = github_repository.ynm.name
  enabled    = false
}
