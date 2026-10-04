variable "domain" {
  description = "Auth0 tenant domain, e.g. your-tenant.us.auth0.com (or its custom domain)"
  type        = string
}

variable "stores" {
  description = <<-EOT
    ynm stores this tenant signs people in to, by name. url is the store's MCP endpoint, which is
    also the API identifier and token audience. members are the Auth0 user ids (e.g.
    "auth0|65f…") allowed to read and write it; anyone else who signs in gets no scopes.
  EOT
  type = map(object({
    url     = string
    members = optional(list(string), [])
  }))
}

variable "connection_name" {
  description = "Name of the username-and-password connection people sign in with"
  type        = string
  default     = "ynm"
}
