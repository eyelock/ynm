# What every store in one AWS account shares: a small public network, daily snapshots of the
# data volumes, a bucket for weekly git bundles, and (while the image is private) the registry
# credentials. Stores find these by name and tag, not through this configuration's state.

# Network: public subnets only. A store has an Elastic IP and a security group that admits 80
# and 443; there is no NAT gateway to pay for.

resource "aws_vpc" "ynm" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "ynm", "ynm:baseline" = "true" }
}

resource "aws_internet_gateway" "ynm" {
  vpc_id = aws_vpc.ynm.id
  tags   = { Name = "ynm" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.ynm.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.ynm.id
  }

  tags = { Name = "ynm-public" }
}

resource "aws_subnet" "public" {
  for_each = { for i, az in var.availability_zones : az => i }

  vpc_id            = aws_vpc.ynm.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value)

  tags = { Name = "ynm-public-${each.key}", "ynm:tier" = "public" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# Snapshots: every volume tagged ynm:snapshot = daily, kept for snapshot_retain_days.

resource "aws_iam_role" "snapshots" {
  name                 = "ynm-snapshots"
  path                 = "/ynm/"
  permissions_boundary = var.workload_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "snapshots" {
  role       = aws_iam_role.snapshots.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "daily" {
  description        = "ynm data volumes daily"
  execution_role_arn = aws_iam_role.snapshots.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { "ynm:snapshot" = "daily" }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }

      retain_rule {
        interval      = var.snapshot_retain_days
        interval_unit = "DAYS"
      }

      tags_to_add = { "ynm:snapshot-of" = "data" }
    }
  }
}

# Backups: each store's instance writes a weekly git bundle under <client>/.

resource "aws_s3_bucket" "backups" {
  bucket = "ynm-backups-${var.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    # AWS sets these on new buckets; declared so the plan does not try to remove them.
    blocked_encryption_types = ["SSE-C"]
    bucket_key_enabled       = false
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-bundles"
    status = "Enabled"

    filter {}

    expiration {
      days = var.backup_retain_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

# Registry credentials while the image is private: user:token for a token with read:packages.
# Terraform creates the parameter; the value is set with the CLI and never enters state.

resource "aws_ssm_parameter" "registry_credentials" {
  count = var.registry_credentials ? 1 : 0

  name        = "/ynm/registry/credentials"
  description = "user:token for pulling the ynm image; set with aws ssm put-parameter --overwrite"
  type        = "SecureString"
  value       = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}
