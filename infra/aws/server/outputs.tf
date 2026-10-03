output "url" {
  description = "MCP endpoint agents connect to"
  value       = local.public_url
}

output "hostname" {
  description = "Hostname the certificate is issued for"
  value       = local.hostname
}

output "public_ip" {
  description = "Elastic IP; point the hostname here when DNS is managed elsewhere"
  value       = aws_eip.server.public_ip
}

output "instance_id" {
  description = "Current server; connect with aws ssm start-session --target <id>"
  value       = aws_instance.server.id
}

output "data_volume_id" {
  description = "The data volume: the store itself"
  value       = aws_ebs_volume.data.id
}

output "secret_parameters" {
  description = "SSM parameters to set with aws ssm put-parameter --overwrite"
  value       = [for p in aws_ssm_parameter.secret_env : p.name]
}

output "alarm_topic" {
  description = "SNS topic alarms publish to"
  value       = aws_sns_topic.alarms.arn
}
