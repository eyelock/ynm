variable "owner" {
  description = "GitHub account that owns the repository"
  type        = string
  default     = "eyelock"
}

variable "repository" {
  description = "Repository name"
  type        = string
  default     = "ynm"
}

variable "visibility" {
  description = "Repository visibility: private until the first public release, then public"
  type        = string
  default     = "private"

  validation {
    condition     = contains(["private", "public"], var.visibility)
    error_message = "visibility must be private or public."
  }
}

variable "milestone" {
  description = <<-EOT
    The gate CI runs (the YNM_MILESTONE Actions variable). Needed only when the variable is
    created; after that it changes with `gh variable set`, and an existing value is never read back.
  EOT
  type        = string
  default     = null
}

variable "release_token" {
  description = <<-EOT
    RELEASE_TOKEN for the release workflow: a token with write access to eyelock/homebrew-tap.
    Needed only when the secret is created or rotated; an existing value is never read back.
  EOT
  type        = string
  sensitive   = true
  default     = null
}
