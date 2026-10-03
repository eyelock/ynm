# The server's role: Session Manager instead of SSH, its own secrets, its own log group and its
# own prefix in the backup bucket. The workload boundary caps it whatever is attached here.

resource "aws_iam_role" "server" {
  name                 = local.name
  path                 = "/ynm/"
  permissions_boundary = "arn:aws:iam::${var.account_id}:policy/ynm-boundary/ynm-workload-boundary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "session_manager" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "server" {
  name = "store"
  role = aws_iam_role.server.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "OwnSecrets"
          Effect   = "Allow"
          Action   = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
          Resource = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter${trimsuffix(local.env_path, "/")}", "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.env_path}*"]
        },
        {
          Sid      = "OwnLogs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
          Resource = ["${aws_cloudwatch_log_group.server.arn}:*"]
        },
        {
          Sid      = "OwnBackups"
          Effect   = "Allow"
          Action   = ["s3:PutObject", "s3:AbortMultipartUpload"]
          Resource = ["arn:aws:s3:::${local.backup_bucket}/${var.client}/*"]
        },
      ],
      var.registry_credentials_parameter == null ? [] : [{
        Sid      = "RegistryCredentials"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter${var.registry_credentials_parameter}"]
      }],
    )
  })
}

resource "aws_iam_instance_profile" "server" {
  name = local.name
  path = "/ynm/"
  role = aws_iam_role.server.name
}
