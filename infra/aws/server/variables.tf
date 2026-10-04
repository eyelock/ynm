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
  description = "Region of the account's baseline"
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
  description = "Route 53 public zone to create the hostname's A record in; null to manage DNS elsewhere (point the hostname at the public_ip output)"
  type        = string
  default     = "eyelock.net"
}

variable "acme_email" {
  description = "Contact address for the Let's Encrypt account that issues the store's certificate"
  type        = string
}

# How it signs people in

variable "auth" {
  description = <<-EOT
    The store's identity provider, in the shape every identity configuration under infra/ outputs
    (infra/auth0 for an Auth0 tenant). It holds no secrets; a secret the provider needs (an
    introspection client secret) goes in secret_env.
  EOT
  type = object({
    provider = string           # "oidc" or "introspection"
    preset   = optional(string) # "auth0", "keycloak", "okta", "entra", "google"
    issuer   = string           # e.g. https://your-tenant.us.auth0.com/
    resource = optional(string) # defaults to the store's https://<hostname>/mcp
    scopes   = optional(object({ read = string, write = string }))
  })
}

# What it runs

variable "image" {
  description = "Container image of the ynm server, without tag"
  type        = string
  default     = "ghcr.io/eyelock/ynm"
}

variable "image_tag" {
  description = "Release to run. Changing it replaces the server; the data volume moves to the new one."
  type        = string
}

variable "registry_credentials_parameter" {
  description = "SSM parameter with user:token for a private registry (the baseline's registry_credentials_parameter output); null pulls anonymously"
  type        = string
  default     = null
}

variable "env" {
  description = "Extra non-secret environment for the server, e.g. YNM_DREAM_EVERY"
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Names of secret environment variables (e.g. TYPESAFE_API_KEY). Each gets an SSM parameter /ynm/<client>/env/<NAME>, set with the CLI; a value left at \"unset\" is not passed."
  type        = list(string)
  default     = []
}

variable "server_args" {
  description = "Extra arguments for the server, after the ones the image's entrypoint passes"
  type        = list(string)
  default     = []
}

# The server and its disk

variable "availability_zone" {
  description = "Zone of the data volume, and so of the server. Moving zones goes through a snapshot (README)."
  type        = string
  default     = "us-east-1a"
}

variable "instance_type" {
  description = "Server size; an ARM (Graviton) type, because the AMI is arm64"
  type        = string
  default     = "t4g.small"
}

variable "volume_size_gb" {
  description = "Size of the data volume. It can grow in place; it cannot shrink."
  type        = number
  default     = 20
}

variable "snapshot_id" {
  description = "Create the data volume from this snapshot (restore, or a move to another zone). Only read when the volume is created."
  type        = string
  default     = null
}

# Watching it

variable "log_retention_days" {
  description = "Days the server's and Caddy's logs are kept in CloudWatch"
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Address that gets alarm notifications (confirm the subscription email AWS sends); null for none"
  type        = string
  default     = null
}

variable "backup_schedule" {
  description = "systemd OnCalendar expression for the git bundle to S3"
  type        = string
  default     = "Sun 04:00 UTC"
}

variable "audit_sink" {
  description = "Where each request's audit event goes: stdout (the log group, through the container's log driver)"
  type        = string
  default     = "stdout"

  validation {
    condition     = var.audit_sink == "stdout"
    error_message = "A server store writes audit to stdout; the S3 sink is for stores on the s3 provider."
  }
}
