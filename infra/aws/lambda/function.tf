# The function: the ynm Lambda package, its role and its logs. Secrets are not in its
# environment: it reads /ynm/<client>/env/* from Parameter Store at cold start.

resource "aws_cloudwatch_log_group" "function" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "function" {
  name                 = local.name
  path                 = "/ynm/"
  permissions_boundary = "arn:aws:iam::${var.account_id}:policy/ynm-boundary/ynm-workload-boundary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "function" {
  name = "store"
  role = aws_iam_role.function.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListStore"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketVersioning"]
        Resource = [aws_s3_bucket.store.arn]
      },
      {
        Sid    = "ReadWriteStore"
        Effect = "Allow"
        Action = [
          "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject",
          "s3:DeleteObject", "s3:DeleteObjectVersion",
        ]
        Resource = ["${aws_s3_bucket.store.arn}/*"]
      },
      {
        Sid    = "OwnSecrets"
        Effect = "Allow"
        Action = ["ssm:GetParametersByPath"]
        # The path is named as the function asks for it, with its trailing slash, and without.
        Resource = [
          "arn:aws:ssm:${var.region}:${var.account_id}:parameter${trimsuffix(local.env_path, "/")}",
          "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.env_path}",
        ]
      },
      {
        Sid      = "OwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.function.arn}:*"]
      },
    ]
  })
}

resource "aws_lambda_function" "server" {
  function_name    = local.name
  description      = "ynm ${var.package_version} for ${var.client}"
  role             = aws_iam_role.function.arn
  filename         = var.package_path
  source_code_hash = filebase64sha256(var.package_path)
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = var.memory_mb
  timeout          = 30

  environment {
    variables = local.function_env
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.function.name
  }

  tags = { "ynm:version" = var.package_version }

  depends_on = [aws_iam_role_policy.function]
}
