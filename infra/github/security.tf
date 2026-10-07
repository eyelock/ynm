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

# Private vulnerability reporting (SECURITY.md points reporters to it) has no resource in the
# integrations/github provider (checked at 6.13), so it is not managed here. It is a repository
# setting: Settings, Code security, "Private vulnerability reporting", or
#   gh api -X PUT repos/eyelock/ynm/private-vulnerability-reporting
# Secret scanning and push protection are in repository.tf, on once visibility is public.
