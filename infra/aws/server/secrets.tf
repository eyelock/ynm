# One SSM parameter per secret environment variable. Terraform creates it with the value "unset"
# and never reads it back, so the real value stays out of state:
#   aws ssm put-parameter --overwrite --type SecureString \
#     --name /ynm/<client>/env/TYPESAFE_API_KEY --value "$TYPESAFE_API_KEY"
# The server reads them at every start; restart it (README) to pick up a change.

resource "aws_ssm_parameter" "secret_env" {
  for_each = toset(var.secret_env)

  name        = "${local.env_path}${each.key}"
  description = "${each.key} for ynm ${var.client}; set with aws ssm put-parameter --overwrite"
  type        = "SecureString"
  value       = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}
