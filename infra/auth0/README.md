# Auth0 sign-in for hosted stores

An Auth0 tenant as the identity provider for hosted ynm stores. When an agent such as Claude Code
first calls a store, the store answers `401` and names this tenant; the agent registers itself
with the tenant, opens the browser for the person to sign in, and comes back with a token for
that store. This configuration sets the tenant up for that and registers each store.

It knows nothing about where stores run. Its output for each store is the `auth` object that
[`infra/aws`](../aws/README.md) takes, for a Lambda or a server store alike; a store signing
people in somewhere else (a client's own Okta or Entra, say) gets the same object from there.

| What | Where |
|---|---|
| Dynamic client registration on; the `resource` parameter accepted as the audience | tenant settings |
| Connection `ynm`: username and password, sign-up off, usable by self-registered agents | one per tenant |
| An API per store: identifier = the store's URL, scopes `memory:read` and `memory:write`, RBAC on | `stores` |
| Per store, default permissions for third-party applications: any self-registered agent may ask for the memory scopes on a person's behalf (without it Auth0 refuses them that API) | `stores` |
| A role per store, `ynm <store> member`, granting both scopes, given to `members` | `stores` |

With RBAC on, a token carries only the scopes the person's roles grant, so signing in to the
tenant is not enough to read or write a store: the person must be one of its `members`.

## Which tenant

Configuration, not code: `tenants/<tenant>.tfvars` (the domain and the stores) and
`tenants/<tenant>.s3.tfbackend` (its state key, `auth0/<tenant>/terraform.tfstate`). Both are
gitignored and yours to keep; start from `tenants/example.tfvars.example` and
`tenants/example.s3.tfbackend.example`.

## Credentials

- **The tenant**: a machine-to-machine application in the tenant, authorised for the Auth0
  Management API with `read:` and `update:` on tenant settings, connections, resource servers,
  roles and users. Create it once in the dashboard (Applications → Create Application → Machine
  to Machine) and export its credentials for the run:

  ```bash
  export AUTH0_CLIENT_ID=… AUTH0_CLIENT_SECRET=…
  ```

- **The state**: AWS credentials that can use the state bucket, the `ynm-terraform` (or
  `ynm-provisioner`) profile; see [`infra/terraform-state`](../terraform-state/README.md).

## Apply

```bash
cd infra/auth0
export AWS_PROFILE=ynm-terraform
terraform init -backend-config=tenants/<tenant>.s3.tfbackend
terraform apply -var-file=tenants/<tenant>.tfvars
terraform output -json auth      # copy a store's object into its infra/aws client settings
```

Use `terraform init -reconfigure -backend-config=…` when switching tenants in the same directory.

## Add a person to a store

1. Create the user in the dashboard (User Management → Users → Create User, connection `ynm`),
   or send them an invitation.
2. Add their user id (`auth0|…`) to the store's `members` and apply.

They then add the store's URL to their agent and sign in when it asks.

## Add a store

Add an entry to `stores` with the store's URL, apply, and pass `terraform output -json auth` for
that store to its `infra/aws` client settings. The URL is the token audience, so it must be exactly
what agents connect to, `https://<client>.ynm.eyelock.net/mcp` by default.

## Plan

The free plan covers this: unlimited social and database sign-ins up to 25,000 monthly active
users, and dynamic client registration. Its limit that matters is multi-factor authentication,
which it does not include for Auth0's own accounts.
