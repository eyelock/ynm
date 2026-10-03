output "issuer" {
  description = "Token issuer for every store on this tenant"
  value       = "https://${var.domain}/"
}

output "auth" {
  description = "Per store, the auth object infra/aws/lambda and infra/aws/server take as its auth variable"
  value = {
    for name, s in var.stores : name => {
      provider = "oidc"
      preset   = "auth0"
      issuer   = "https://${var.domain}/"
      resource = s.url
      scopes   = { read = "memory:read", write = "memory:write" }
    }
  }
}
