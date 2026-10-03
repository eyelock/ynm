# One client's hosted store: a disposable server and the durable data volume it mounts. The
# account's baseline (infra/aws/baseline) must be applied first; this finds its network by tag.

data "aws_vpc" "ynm" {
  tags = { "ynm:baseline" = "true" }
}

data "aws_subnet" "public" {
  vpc_id            = data.aws_vpc.ynm.id
  availability_zone = var.availability_zone
  tags              = { "ynm:tier" = "public" }
}

# Latest Amazon Linux 2023 for arm64. Read when the server is created; a newer AMI does not
# replace a running server (instance.tf ignores it), the next replacement picks it up.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_route53_zone" "public" {
  count = var.dns_zone_name == null ? 0 : 1

  name         = var.dns_zone_name
  private_zone = false
}

locals {
  name          = "ynm-${var.client}"
  hostname      = coalesce(var.hostname, "${var.client}.${var.base_domain}")
  public_url    = coalesce(var.auth.resource, "https://${local.hostname}/mcp")
  env_path      = "/ynm/${var.client}/env/"
  log_group     = "/ynm/${var.client}"
  backup_bucket = "ynm-backups-${var.account_id}"

  # The auth object as the server reads it: YNM_AUTH holds it as JSON, without the fields left
  # unset (resource then defaults to YNM_PUBLIC_URL). A client secret, when a preset needs one, is
  # YNM_AUTH_CLIENT_SECRET in secret_env, never here.
  auth_env = var.auth == null ? {} : {
    YNM_AUTH = jsonencode({ for k, v in var.auth : k => v if v != null })
  }

  # Audit: one event per request. stdout lands in the log group; s3 writes one object per request
  # under audit/ in the store's bucket (lambda) with its own retention.
  audit_env = { YNM_AUDIT = jsonencode({ sink = var.audit_sink }) }

  server_env = merge(local.auth_env, local.audit_env, var.env)
}
