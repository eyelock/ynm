variable "client" {
  description = "Client name: names every resource and is the first label of the default hostname"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.client))
    error_message = "client is lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "account_id" {
  description = "AWS account the store runs in; a run with credentials for any other account fails"
  type        = string
}

variable "region" {
  description = "Region of the function, its API and its store"
  type        = string
  default     = "us-east-1"
}

variable "owner" {
  description = "Owner tag on every resource"
  type        = string
}

# Where it is reached

variable "base_domain" {
  description = "Hostname is <client>.<base_domain> unless hostname is set"
  type        = string
  default     = "ynm.eyelock.net"
}

variable "hostname" {
  description = "Overrides <client>.<base_domain>"
  type        = string
  default     = null
}

variable "dns_zone_name" {
  description = "Route 53 public zone for the hostname's record and the certificate's validation record"
  type        = string
  default     = "eyelock.net"
}

# How it signs people in

variable "auth" {
  description = <<-EOT
    The store's sign-in, in the shape every identity configuration under infra/ outputs (infra/auth0
    for an Auth0 tenant) and the server reads as YNM_AUTH. null means a static bearer token instead,
    from the YNM_MCP_TOKEN parameter (secret_env): deprecated, allowed for one release after sign-in
    ships. Either way the function refuses to start without auth.
  EOT
  type = object({
    provider = string           # "oidc" or "introspection"
    preset   = optional(string) # "auth0", "keycloak", "okta", "entra", "google"
    issuer   = string           # e.g. https://your-tenant.us.auth0.com/
    resource = optional(string) # defaults to the store's https://<hostname>/mcp
    scopes   = optional(object({ read = string, write = string }))
  })
  default = null
}

# What it runs

variable "package_path" {
  description = "The Lambda package: dist/lambda.zip from `make lambda`, or ynm_<version>_lambda.zip from a release"
  type        = string
}

variable "package_version" {
  description = "ynm version the package was built from; a label on the function, nothing more"
  type        = string
}

variable "memory_mb" {
  description = "Function memory; CPU scales with it, and so does cold-start time"
  type        = number
  default     = 1024
}

variable "env" {
  description = "Extra non-secret environment for the function, e.g. YNM_TOKEN_BUDGET"
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Names of secret environment variables. Each gets an SSM parameter /ynm/<client>/env/<NAME>, set with the CLI and read by the function at cold start; one left at \"unset\" is not passed."
  type        = list(string)
  default     = []
}

# Background work

variable "dream_every_minutes" {
  description = "Run consolidation this often; null for never"
  type        = number
  default     = 15
}

variable "keep_warm" {
  description = "Call the function's health every 5 minutes, so most first requests find a warm instance"
  type        = bool
  default     = true
}

# Keeping it

variable "noncurrent_version_days" {
  description = "Old versions of store objects (replaced by compaction or purge) are kept this many days"
  type        = number
  default     = 30
}

variable "log_retention_days" {
  description = "Days the function's logs are kept"
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Address that gets alarm notifications (confirm the subscription email AWS sends); null for none"
  type        = string
  default     = null
}

variable "throttle" {
  description = "API rate limit (requests per second) and burst, a ceiling on cost if the URL is abused"
  type        = object({ rate = number, burst = number })
  default     = { rate = 20, burst = 50 }
}

variable "audit_sink" {
  description = "Where each request's audit event goes: stdout (the log group) or s3 (audit/ in the store bucket)"
  type        = string
  default     = "stdout"

  validation {
    condition     = contains(["stdout", "s3"], var.audit_sink)
    error_message = "audit_sink is stdout or s3."
  }
}

variable "audit_retention_days" {
  description = "Days audit objects are kept when audit_sink is s3"
  type        = number
  default     = 365
}
