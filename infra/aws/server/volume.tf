# The data volume is the store. Everything durable lives on it: the bare memory repository, the
# index, the audit log and Caddy's certificates. It is its own resource with prevent_destroy, so
# replacing the server never touches it, and the server mounts it by filesystem label, so any
# instance type (and any device name) finds it.

resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.volume_size_gb
  type              = "gp3"
  encrypted         = true
  snapshot_id       = var.snapshot_id

  tags = {
    Name           = "${local.name}-data"
    "ynm:snapshot" = "daily" # picked up by the baseline's snapshot policy
  }

  lifecycle {
    prevent_destroy = true
    # snapshot_id only matters at creation; clearing it afterwards must not replace the volume.
    ignore_changes = [snapshot_id]
  }
}

# Detaching stops the old server first, so its containers shut down and flush before the new
# server attaches: there is never a moment with two writers.
resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.server.id
  stop_instance_before_detaching = true
}
