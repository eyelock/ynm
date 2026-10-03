# Logs from both containers, an alarm when the server fails its status checks, and an outside
# check of https://<hostname>/health. Alarms go to an SNS topic, mailed to alarm_email if set.

resource "aws_cloudwatch_log_group" "server" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${local.name}-status-check"
  alarm_description   = "The ${var.client} server is failing its EC2 status checks"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.server.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# /health is outside auth, so a plain HTTPS check works; it also proves the certificate is valid.
resource "aws_route53_health_check" "health" {
  fqdn              = local.hostname
  type              = "HTTPS"
  port              = 443
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3

  tags = { Name = "${local.name}-health" }
}

resource "aws_cloudwatch_metric_alarm" "health" {
  provider = aws.us_east_1

  alarm_name          = "${local.name}-health"
  alarm_description   = "https://${local.hostname}/health is not answering"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.health.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
