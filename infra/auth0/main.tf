# One Auth0 tenant as the identity provider for ynm stores. MCP clients (Claude Code, Copilot CLI)
# find the tenant from a store's 401, register themselves and sign the person in, so the tenant
# needs: dynamic client registration, the `resource` parameter accepted as the audience, and a
# connection that third-party (self-registered) applications may use. Each store gets an API whose
# identifier is its URL, the memory scopes, and a role that grants them to its members.

# Tenant-wide settings. Destroying this resource leaves the tenant as it is.
resource "auth0_tenant" "tenant" {
  # MCP clients send the store's URL as `resource` (RFC 8707) rather than Auth0's `audience`.
  resource_parameter_profile = "compatibility"

  flags {
    enable_dynamic_client_registration = true
  }
}

# Self-registered clients are third-party applications, which can only use domain-level
# connections. Sign-up is off: people are added in the dashboard (or by invitation).
resource "auth0_connection" "people" {
  name                 = var.connection_name
  strategy             = "auth0"
  is_domain_connection = true

  options {
    disable_signup         = true
    brute_force_protection = true
    password_policy        = "good"
  }
}

resource "auth0_resource_server" "store" {
  for_each = var.stores

  name        = "ynm ${each.key}"
  identifier  = each.value.url
  signing_alg = "RS256"

  # Scopes in a token are only those the person's roles grant (RBAC), so signing in is not
  # enough to read or write a store.
  enforce_policies = true
  token_dialect    = "access_token_authz"

  allow_offline_access = true
  token_lifetime       = 3600
}

resource "auth0_resource_server_scopes" "store" {
  for_each = var.stores

  resource_server_identifier = auth0_resource_server.store[each.key].identifier

  scopes {
    name        = "memory:read"
    description = "Recall and read memories"
  }

  scopes {
    name        = "memory:write"
    description = "Remember, edit and consolidate memories"
  }
}

# Agents register themselves, so each is a third-party application, and Auth0 gives those no API
# until the API grants them default permissions. This lets any self-registered agent sign a
# person in for the memory scopes; RBAC above still issues only the scopes the person's roles hold.
resource "auth0_client_grant" "agents" {
  for_each = var.stores

  default_for  = "third_party_clients"
  subject_type = "user"
  audience     = auth0_resource_server.store[each.key].identifier
  scopes       = [for s in auth0_resource_server_scopes.store[each.key].scopes : s.name]
}

resource "auth0_role" "member" {
  for_each = var.stores

  name        = "ynm ${each.key} member"
  description = "Reads and writes the ${each.key} store"
}

resource "auth0_role_permissions" "member" {
  for_each = var.stores

  role_id = auth0_role.member[each.key].id

  dynamic "permissions" {
    for_each = auth0_resource_server_scopes.store[each.key].scopes
    content {
      name                       = permissions.value.name
      resource_server_identifier = auth0_resource_server.store[each.key].identifier
    }
  }
}

resource "auth0_user_role" "member" {
  for_each = {
    for pair in flatten([
      for store, s in var.stores : [for user in s.members : { store = store, user = user }]
    ]) : "${pair.store}/${pair.user}" => pair
  }

  user_id = each.value.user
  role_id = auth0_role.member[each.value.store].id
}
