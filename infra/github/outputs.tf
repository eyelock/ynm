output "html_url" {
  description = "Repository URL"
  value       = github_repository.ynm.html_url
}

output "pages_url" {
  description = "Docs site URL"
  value       = github_repository_pages.ynm.html_url
}
