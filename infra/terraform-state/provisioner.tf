# The identity that applies infra/aws (the ynm-provisioner AWS profile): it can build hosted stores
# in this account and use state, and nothing else. Its access key is made with the AWS CLI, not
# here, so the secret never enters state.
#
# It can create IAM roles, which is how a scoped identity usually escalates: create a role with
# admin rights and hand it to an instance. So every role it creates or changes must carry the
# ynm-workload-boundary permissions boundary, which caps what any ynm workload can do whatever
# policy is attached to it, and the boundary sits under a path the provisioner cannot touch.

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Regions the provisioner may build in; every regional call is held to these.
  provisioner_regions = ["us-east-1"]

  # Record names the provisioner may create in Route 53: hosted stores are <client>.ynm.eyelock.net.
  provisioner_record_names = ["*.ynm.eyelock.net"]

  ynm_roles             = "arn:aws:iam::${local.account_id}:role/ynm/*"
  ynm_instance_profiles = "arn:aws:iam::${local.account_id}:instance-profile/ynm/*"
}

# The ceiling for every role infra/aws creates: the instance role of each store and the snapshot
# role. Effective permissions are the intersection of this and the role's own policies.
resource "aws_iam_policy" "workload_boundary" {
  name        = "ynm-workload-boundary"
  path        = "/ynm-boundary/"
  description = "Permissions boundary for every role infra/aws creates"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Session Manager and the SSM agent (AmazonSSMManagedInstanceCore).
      {
        Sid      = "SessionManager"
        Effect   = "Allow"
        Action   = ["ssm:*", "ssmmessages:*", "ec2messages:*"]
        Resource = "*"
      },
      # ...but parameters only under /ynm/, so a store cannot read another project's secrets.
      {
        Sid         = "OnlyYnmParameters"
        Effect      = "Deny"
        Action      = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
        NotResource = "arn:aws:ssm:*:${local.account_id}:parameter/ynm/*"
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = "arn:aws:logs:*:${local.account_id}:log-group:/ynm/*"
      },
      {
        Sid      = "Backups"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:AbortMultipartUpload"]
        Resource = "arn:aws:s3:::ynm-backups-*/*"
      },
      # Stores on the s3 provider (infra/aws/lambda).
      {
        Sid    = "Stores"
        Effect = "Allow"
        Action = [
          "s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketVersioning",
          "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject",
          "s3:DeleteObject", "s3:DeleteObjectVersion",
        ]
        Resource = ["arn:aws:s3:::ynm-store-*", "arn:aws:s3:::ynm-store-*/*"]
      },
      # Schedules calling a store's function.
      {
        Sid      = "InvokeStores"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:*:${local.account_id}:function:ynm-*"
      },
      # Data Lifecycle Manager taking and expiring volume snapshots.
      {
        Sid    = "Snapshots"
        Effect = "Allow"
        Action = [
          "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:DeleteSnapshot", "ec2:CopySnapshot",
          "ec2:CreateTags", "ec2:Describe*", "ec2:ModifySnapshotAttribute", "ec2:ModifySnapshotTier",
          "ec2:EnableFastSnapshotRestores", "ec2:DisableFastSnapshotRestores",
        ]
        Resource = "*"
      },
      {
        Sid      = "SnapshotSchedules"
        Effect   = "Allow"
        Action   = ["events:*"]
        Resource = "arn:aws:events:*:${local.account_id}:rule/AwsDataLifecycleRule.managed-cwe.*"
      },
    ]
  })
}

resource "aws_iam_policy" "provisioner" {
  name        = "ynm-provisioner"
  path        = "/ynm/"
  description = "Build ynm hosted stores (infra/aws) in this account"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Compute"
        Effect    = "Allow"
        Action    = ["ec2:*", "dlm:*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.provisioner_regions } }
      },
      # Roles only under /ynm/, and only with the boundary attached.
      {
        Sid    = "RolesWithBoundary"
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy",
          "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        ]
        Resource  = local.ynm_roles
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.workload_boundary.arn } }
      },
      {
        Sid    = "ManageRoles"
        Effect = "Allow"
        Action = [
          "iam:GetRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
          "iam:TagRole", "iam:UntagRole", "iam:GetRolePolicy", "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRoleTags",
        ]
        Resource = local.ynm_roles
      },
      {
        Sid    = "InstanceProfiles"
        Effect = "Allow"
        Action = [
          "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
          "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile",
          "iam:TagInstanceProfile", "iam:UntagInstanceProfile", "iam:ListInstanceProfileTags",
        ]
        Resource = local.ynm_instance_profiles
      },
      {
        Sid      = "PassRolesToEc2AndDlm"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = local.ynm_roles
        Condition = {
          StringEquals = {
            "iam:PassedToService" = [
              "ec2.amazonaws.com", "dlm.amazonaws.com", "lambda.amazonaws.com", "scheduler.amazonaws.com",
            ]
          }
        }
      },
      {
        Sid      = "ReadManagedPolicies"
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
        Resource = "*"
      },
      {
        Sid      = "KeepTheBoundary"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary"]
        Resource = "*"
      },
      {
        Sid    = "Parameters"
        Effect = "Allow"
        Action = [
          "ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:GetParameters",
          "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource",
        ]
        Resource = "arn:aws:ssm:*:${local.account_id}:parameter/ynm/*"
      },
      {
        Sid      = "PublicAmiParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:*::parameter/aws/service/*"
      },
      {
        Sid      = "DescribeParameters"
        Effect   = "Allow"
        Action   = ["ssm:DescribeParameters"]
        Resource = "*"
      },
      {
        Sid    = "ReadDns"
        Effect = "Allow"
        Action = [
          "route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetHostedZone",
          "route53:ListResourceRecordSets", "route53:GetChange", "route53:ListTagsForResource",
        ]
        Resource = "*"
      },
      {
        Sid      = "StoreRecords"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/*"
        Condition = {
          "ForAllValues:StringLike" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = local.provisioner_record_names
          }
        }
      },
      {
        Sid    = "HealthChecks"
        Effect = "Allow"
        Action = [
          "route53:CreateHealthCheck", "route53:DeleteHealthCheck", "route53:GetHealthCheck",
          "route53:UpdateHealthCheck", "route53:ChangeTagsForResource",
        ]
        Resource = "*"
      },
      {
        Sid    = "LogGroups"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy",
          "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource", "logs:ListTagsLogGroup",
        ]
        Resource = "arn:aws:logs:*:${local.account_id}:log-group:/ynm/*"
      },
      {
        Sid      = "DescribeLogGroups"
        Effect   = "Allow"
        Action   = ["logs:DescribeLogGroups"]
        Resource = "*"
      },
      {
        Sid    = "Alarms"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms",
          "cloudwatch:TagResource", "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource",
        ]
        Resource = "arn:aws:cloudwatch:*:${local.account_id}:alarm:ynm-*"
      },
      {
        Sid      = "AlarmTopics"
        Effect   = "Allow"
        Action   = ["sns:*"]
        Resource = "arn:aws:sns:*:${local.account_id}:ynm-*"
      },
      {
        Sid    = "Buckets"
        Effect = "Allow"
        Action = ["s3:*"]
        Resource = [
          "arn:aws:s3:::ynm-backups-*", "arn:aws:s3:::ynm-backups-*/*",
          "arn:aws:s3:::ynm-store-*", "arn:aws:s3:::ynm-store-*/*",
        ]
      },
      # infra/aws/lambda: the function, its API and certificate, its schedules.
      {
        Sid      = "Functions"
        Effect   = "Allow"
        Action   = ["lambda:*"]
        Resource = "arn:aws:lambda:*:${local.account_id}:function:ynm-*"
      },
      {
        Sid       = "ApisAndCertificates"
        Effect    = "Allow"
        Action    = ["apigateway:*", "acm:*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.provisioner_regions } }
      },
      {
        Sid      = "Schedules"
        Effect   = "Allow"
        Action   = ["scheduler:*"]
        Resource = "arn:aws:scheduler:*:${local.account_id}:schedule/default/ynm-*"
      },
      {
        Sid      = "ApiGatewayServiceRole"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "*"
        Condition = {
          StringEquals = { "iam:AWSServiceName" = ["ops.apigateway.amazonaws.com", "apigateway.amazonaws.com"] }
        }
      },
    ]
  })
}

resource "aws_iam_group" "provisioner" {
  name = "ynm-provisioner"
  path = "/ynm/"
}

resource "aws_iam_group_policy_attachment" "provisioner" {
  group      = aws_iam_group.provisioner.name
  policy_arn = aws_iam_policy.provisioner.arn
}

resource "aws_iam_user" "provisioner" {
  name = "ynm-provisioner"
  path = "/ynm/"
}

# Also in the ynm-terraform group, so one profile reaches both the state and the infrastructure.
resource "aws_iam_user_group_membership" "provisioner" {
  user   = aws_iam_user.provisioner.name
  groups = [aws_iam_group.provisioner.name, aws_iam_group.terraform.name]
}
