variable "account_id" {
  description = "AWS account this baseline belongs to; a run with credentials for any other account fails"
  type        = string
}

variable "region" {
  description = "Region every store in this account runs in"
  type        = string
  default     = "us-east-1"
}

variable "owner" {
  description = "Owner tag on every resource"
  type        = string
}

variable "vpc_cidr" {
  description = "Address range of the ynm VPC"
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "Zones that get a public subnet; a store's data volume lives in one of them"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "snapshot_retain_days" {
  description = "Daily snapshots of every store's data volume are kept this many days"
  type        = number
  default     = 14
}

variable "backup_retain_days" {
  description = "Weekly git bundles in the backup bucket are kept this many days"
  type        = number
  default     = 90
}

variable "workload_boundary_arn" {
  description = "Permissions boundary every ynm role carries (the workload_boundary output of infra/terraform-state)"
  type        = string
}

variable "registry_credentials" {
  description = "Create the SSM parameter that holds user:token for a private image registry. Off once the image is public."
  type        = bool
  default     = false
}
