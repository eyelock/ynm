output "bucket" {
  description = "State bucket"
  value       = aws_s3_bucket.state.bucket
}

output "user" {
  description = "IAM user for day-to-day runs; make its access key with the AWS CLI"
  value       = aws_iam_user.terraform.name
}

output "provisioner" {
  description = "IAM user that applies infra/aws; make its access key with the AWS CLI"
  value       = aws_iam_user.provisioner.name
}

output "workload_boundary" {
  description = "Permissions boundary every infra/aws role must carry"
  value       = aws_iam_policy.workload_boundary.arn
}
