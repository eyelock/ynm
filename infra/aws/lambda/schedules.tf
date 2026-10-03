# The work a server does on timers, as EventBridge Scheduler calls with the JSON input the
# function understands: dream (consolidation), compact (fold a shard's many small objects into
# one) and health (keep an instance warm, so most first requests skip the cold start).

locals {
  schedules = merge(
    var.dream_every_minutes == null ? {} : {
      dream = "rate(${var.dream_every_minutes} minutes)"
    },
    { compact = "rate(1 day)" },
    var.keep_warm ? { health = "rate(5 minutes)" } : {},
  )
}

resource "aws_iam_role" "scheduler" {
  name                 = "${local.name}-scheduler"
  path                 = "/ynm/"
  permissions_boundary = "arn:aws:iam::${var.account_id}:policy/ynm-boundary/ynm-workload-boundary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.server.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "work" {
  for_each = local.schedules

  name                = "${local.name}-${each.key}"
  schedule_expression = each.value

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.server.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ ynm = each.key })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
