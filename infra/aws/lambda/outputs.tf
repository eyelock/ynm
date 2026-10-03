output "url" {
  description = "MCP endpoint agents connect to"
  value       = local.public_url
}

output "function" {
  description = "Function name; logs are in the log group below"
  value       = aws_lambda_function.server.function_name
}

output "log_group" {
  description = "CloudWatch log group of the function"
  value       = aws_cloudwatch_log_group.function.name
}

output "store" {
  description = "The store: s3://<bucket>/store/"
  value       = "s3://${aws_s3_bucket.store.bucket}/store/"
}

output "secret_parameters" {
  description = "SSM parameters to set with aws ssm put-parameter --overwrite"
  value       = [for p in aws_ssm_parameter.secret_env : p.name]
}

output "alarm_topic" {
  description = "SNS topic alarms publish to"
  value       = aws_sns_topic.alarms.arn
}
