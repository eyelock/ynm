# Alarms: the function failing (a scheduled run, a cold start without auth or store, a timeout)
# and the API answering 5xx to a share of its requests. Both go to an SNS topic, mailed to
# alarm_email if set. Thresholds are variables (variables.tf, "Alarms").

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # The errors alarm looks back over two dream intervals (at least 30 minutes), so a dream that
  # fails every run raises it on its second failure while one transient failure does not.
  error_alarm_periods = coalesce(
    var.alarm_error_periods,
    min(288, max(6, ceil(2 * coalesce(var.dream_every_minutes, 15) / 5))),
  )
}

# Lambda errors: an invocation that threw or timed out. A request that fails inside ynm is
# answered 500 and counted by the API alarm instead; what lands here is a failed scheduled run
# (dream, compact, health), a cold start that cannot start, or a timeout.
resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.name}-errors"
  alarm_description   = "The ${var.client} function failed in ${var.alarm_error_datapoints} of the last ${local.error_alarm_periods} five-minute periods; its log group is ${local.log_group}"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.server.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = local.error_alarm_periods
  datapoints_to_alarm = var.alarm_error_datapoints
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# API 5xx as a share of requests: the percentage of requests answered 5xx in each five-minute
# period, counted only once the period has alarm_5xx_min_requests requests, so a burst of
# retries or one failure on an idle store does not page, while a sustained error rate does.
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "https://${local.hostname} answered more than ${var.alarm_5xx_rate_percent}% of requests with 5xx in ${var.alarm_5xx_datapoints} of the last ${var.alarm_5xx_periods} five-minute periods (periods under ${var.alarm_5xx_min_requests} requests are not counted); the function's log group is ${local.log_group}"
  evaluation_periods  = var.alarm_5xx_periods
  datapoints_to_alarm = var.alarm_5xx_datapoints
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_5xx_rate_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "rate"
    label       = "5xx share of requests (%)"
    expression  = "IF(FILL(requests, 0) >= ${var.alarm_5xx_min_requests}, 100 * FILL(errors, 0) / requests, 0)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApiGateway"
      metric_name = "5xx"
      dimensions  = { ApiId = aws_apigatewayv2_api.store.id, Stage = "$default" }
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApiGateway"
      metric_name = "Count"
      dimensions  = { ApiId = aws_apigatewayv2_api.store.id, Stage = "$default" }
      stat        = "Sum"
      period      = 300
    }
  }
}
