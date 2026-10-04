output "vpc_id" {
  description = "The ynm VPC; stores find it by its ynm:baseline tag"
  value       = aws_vpc.ynm.id
}

output "subnets" {
  description = "Public subnet per availability zone"
  value       = { for az, s in aws_subnet.public : az => s.id }
}

output "backup_bucket" {
  description = "Bucket for weekly git bundles; each store writes under <client>/"
  value       = aws_s3_bucket.backups.bucket
}

output "registry_credentials_parameter" {
  description = "SSM parameter holding user:token for the image registry, if created"
  value       = one(aws_ssm_parameter.registry_credentials[*].name)
}
