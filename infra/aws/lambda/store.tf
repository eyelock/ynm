# The store: an S3 bucket the s3 provider writes one object per append into. Versioned, so a
# compaction or purge never loses the only copy of anything until noncurrent_version_days pass.

resource "aws_s3_bucket" "store" {
  bucket = local.bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "store" {
  bucket = aws_s3_bucket.store.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "store" {
  bucket = aws_s3_bucket.store.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    # AWS sets these on new buckets; declared so the plan does not try to remove them.
    blocked_encryption_types = ["SSE-C"]
    bucket_key_enabled       = false
  }
}

resource "aws_s3_bucket_public_access_block" "store" {
  bucket = aws_s3_bucket.store.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "store" {
  bucket = aws_s3_bucket.store.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }

    expiration {
      expired_object_delete_marker = true
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # Audit events (audit_sink = "s3") live under audit/, never under the store's prefix, so this
  # rule can expire them without touching memory.
  rule {
    id     = "expire-audit"
    status = "Enabled"

    filter {
      prefix = "audit/"
    }

    expiration {
      days = var.audit_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.store]
}
