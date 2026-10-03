# The server is disposable: everything it needs is in user data, the data volume and SSM.
# Replace it with: terraform apply -var-file=clients/<client>.tfvars -replace=aws_instance.server

resource "aws_security_group" "server" {
  name        = local.name
  description = "ynm ${var.client}: HTTPS in (80 for the certificate challenge and redirect)"
  vpc_id      = data.aws_vpc.ynm.id

  tags = { Name = local.name }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = toset(["80", "443"])

  security_group_id = aws_security_group.server.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.server.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "server" {
  ami                    = data.aws_ssm_parameter.al2023.insecure_value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.server.id]
  iam_instance_profile   = aws_iam_instance_profile.server.name

  # Changing the image tag, the auth settings or anything else in user data builds a new server.
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    client          = var.client
    hostname        = local.hostname
    region          = var.region
    volume_id       = aws_ebs_volume.data.id
    image           = "${var.image}:${var.image_tag}"
    registry        = split("/", var.image)[0]
    registry_param  = var.registry_credentials_parameter == null ? "" : var.registry_credentials_parameter
    env_path        = local.env_path
    server_env      = local.server_env
    server_args     = concat(["--allow-host", local.hostname], var.server_args)
    acme_email      = var.acme_email
    log_group       = local.log_group
    backup_bucket   = local.backup_bucket
    backup_schedule = var.backup_schedule
  })

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 16
    encrypted   = true
  }

  tags = { Name = local.name }

  lifecycle {
    # A newer AMI is picked up when the server is next replaced, not by replacing it on sight.
    ignore_changes = [ami]
  }

  depends_on = [aws_cloudwatch_log_group.server]
}

# The address survives the server, so DNS and clients do not change when it is replaced.
resource "aws_eip" "server" {
  domain = "vpc"
  tags   = { Name = local.name }
}

resource "aws_eip_association" "server" {
  allocation_id = aws_eip.server.id
  instance_id   = aws_instance.server.id
}
