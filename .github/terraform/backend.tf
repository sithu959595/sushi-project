# Copied into Backend/terraform/ci-backend.tf by the deployment workflow.
# Local migration instructions: ../GitHubActions.md
terraform {
  backend "s3" {
    key                  = "sushi/terraform.tfstate"
    workspace_key_prefix = "workspaces"
    encrypt              = true
    use_lockfile         = true
  }
}
