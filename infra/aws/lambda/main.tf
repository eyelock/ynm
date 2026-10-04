# One client's hosted store as a Lambda: the store is an S3 bucket (the s3 provider), the server
# is a function that exists only while it answers, reached through API Gateway on the client's
# hostname. Nothing runs, and almost nothing is billed, while nobody calls it. Needs no baseline:
# no VPC, no volume, no snapshot policy.

data "aws_route53_zone" "public" {
  name         = var.dns_zone_name
  private_zone = false
}

locals {
  name       = "ynm-${var.client}"
  hostname   = coalesce(var.hostname, "${var.client}.${var.base_domain}")
  public_url = var.auth == null ? "https://${local.hostname}/mcp" : coalesce(var.auth.resource, "https://${local.hostname}/mcp")
  env_path   = "/ynm/${var.client}/env/"
  log_group  = "/ynm/${var.client}"
  bucket     = "ynm-store-${var.client}-${var.account_id}"

  mounts = [{
    id       = "hosted"
    level    = "distributed"
    provider = "s3"
    bucket   = local.bucket
    prefix   = "store"
    region   = var.region
  }]

  # The auth object as the server reads it: YNM_AUTH holds it as JSON, without the fields left
  # unset (resource then defaults to YNM_PUBLIC_URL). A client secret, when a preset needs one, is
  # YNM_AUTH_CLIENT_SECRET in secret_env, never here.
  auth_env = var.auth == null ? {} : merge(
    { YNM_AUTH = jsonencode({ for k, v in var.auth : k => v if v != null }) },
    # The same sign-in in the variables the server reads today, until it reads YNM_AUTH: tokens
    # are checked against the issuer's keys, for this store's URL, carrying the memory scopes.
    var.auth.provider != "oidc" ? {} : {
      YNM_JWKS_URL        = "${trimsuffix(var.auth.issuer, "/")}/.well-known/jwks.json"
      YNM_JWT_ISSUER      = var.auth.issuer
      YNM_JWT_AUDIENCE    = local.public_url
      YNM_REQUIRED_SCOPES = var.auth.scopes == null ? "" : "${var.auth.scopes.read},${var.auth.scopes.write}"
    },
  )

  # Audit: one event per request. stdout lands in the log group; s3 writes one object per request
  # under audit/ in the store's bucket (lambda) with its own retention.
  audit_env = { YNM_AUDIT = jsonencode({ sink = var.audit_sink }) }

  function_env = merge(
    local.auth_env,
    local.audit_env,
    var.env,
    {
      YNM_PUBLIC_URL   = local.public_url
      YNM_MOUNTS       = jsonencode(local.mounts)
      YNM_SSM_ENV_PATH = local.env_path
      YNM_USER         = local.name
    },
  )
}
