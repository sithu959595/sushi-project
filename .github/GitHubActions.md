# GitHub Actions for the sushi app

The workflows follow the reference project's checks-then-deploy structure,
using this repository's React/Vite frontend, Node.js and Python Lambdas, and
Terraform stack. Deployment updates Terraform on every successful run so both
infrastructure and Lambda code changes are applied.

## Workflows and branches

| Event | Behavior |
| --- | --- |
| Push to a branch other than `main` or `prod` | Run `checks.yml` |
| Pull request targeting `main` or `prod` | Run `checks.yml`, without AWS credentials |
| Push to `main` | Run checks, deploy `default-staging`, then publish the frontend |
| Push to `prod` | Run checks, deploy `default-prod`, then publish the frontend |
| Manual **Sushi checks** run | Run checks only |
| Manual **Sushi deployment** run, `operation: plan` | Run checks and a Terraform plan for the selected `main` or `prod` branch |
| Manual **Sushi deployment** run, `operation: deploy` | Run checks, apply a saved plan, and publish the frontend |

Manual deployment defaults to `plan`. Selecting another branch runs checks but
skips the deployment job. Manual runs become available after the workflows are
present on the default branch. There is no automated destroy operation.

Checks include frontend tests, ESLint and production build, Node Lambda tests,
Python RAG tests, and Terraform formatting and validation. `deploy.yml` calls
the same reusable `checks.yml`, so pushes to deployment branches run checks
once. Checks require no deployment secrets and support fork pull requests.

Deployment runs for each branch are serialized, with an active deployment
allowed to finish. Plan and apply run in the same job, keeping generated Lambda
ZIPs and the saved plan together. A manual plan is a preview; a later deployment
creates and applies a new plan. Plans and state are not uploaded as artifacts.

## GitHub configuration

Create GitHub environments named **staging** and **prod** under repository
**Settings > Environments**. Restrict staging deployments to `main` and prod
deployments to `prod`. If production requires review, configure required
reviewers on the prod environment.

Set these Actions variables at repository level, or in each environment when
the values differ:

| Variable | Value |
| --- | --- |
| `AWS_REGION` | Stack region; defaults to `us-east-1`. Match the existing deployment. |
| `FRONTEND_ROOT_DOMAIN_NAME` | Root domain, such as `snowfoxcorvallis.com`, without a scheme or `www` prefix |
| `TF_STATE_BUCKET` | Existing private S3 bucket containing the migrated Terraform state |
| `TF_STATE_REGION` | State bucket region; defaults to `AWS_REGION`, then `us-east-1` |

Set these secrets in **each environment**:

| Secret | Purpose |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | AWS identity used to deploy the environment |
| `AWS_SECRET_ACCESS_KEY` | Matching secret access key |
| `AWS_SESSION_TOKEN` | Required only when using temporary STS credentials |
| `TFVARS_JSON` | Terraform variable values for this environment, as a JSON object |

The credentials use the same model as the reference workflow. Temporary
credentials must remain valid throughout the job. Both supported workspaces
belong to account `058264296908`, checked by the credential action and Terraform
providers. The alternate `account-6528-*` workspaces do not provision frontend
hosting and are not targeted by these workflows.

The AWS identity needs permission to manage the resources declared in
`Backend/terraform`, including IAM roles and pass-role permissions, and to
upload/delete frontend objects. It also needs S3 backend access: list the state
bucket, read/write workspace state objects, and read/write/delete their
`.tflock` objects. Include access to the default state path used during backend
initialization. If the bucket uses a customer-managed KMS key, grant the
corresponding KMS access. The workflows do not create AWS credentials, IAM
policies, a state bucket, or DNS/SES prerequisites.

### Terraform values

Example staging `TFVARS_JSON` (replace the email addresses with real values):

```json
{
  "ses_sender_email": "orders-staging@example.com",
  "admin_order_email": "restaurant-admin@example.com",
  "log_retention_days": 14
}
```

Use the existing environment's values from `staging.tfvars` or `prod.tfvars`,
translated to JSON. Include every existing nondefault override, such as
`service_name`, table names, RAG settings, retention settings, or an externally
managed `rag_credentials_secret_arn`; otherwise Terraform uses its defaults and
may plan unintended changes. The examples above are the minimum inputs, not a
replacement for an existing environment's configuration.

Leave `aws_profile` absent or JSON `null`, since GitHub uses its configured
credentials. Set the region and root domain through the Actions variables above;
omit `aws_region` and `frontend_root_domain_name` from `TFVARS_JSON`. The workflow
derives CORS as `https://www.staging.<root-domain>` or `https://www.<root-domain>`.
An explicit `cors_allowed_origin` in the JSON takes precedence, so ensure it
matches the intended frontend.

The JSON is written to a temporary variable file and is not echoed or uploaded.
Terraform may display nonsensitive variable-derived resource values in its plan
logs. OpenAI, Weaviate, and Cohere API keys must remain in AWS Secrets Manager;
do not include them in this JSON or any `VITE_*` values. Follow the backend
README for populating the RAG secret and preparing SES and Route 53.

## Migrate local state before the first deployment

The existing Terraform configuration uses local state. A fresh GitHub runner
cannot see that state. The deployment workflow therefore requires a migrated,
nonempty remote workspace and fails before planning when it is missing.

1. Back up the existing local state and workspace state directories securely.
2. Create or choose a private, encrypted S3 state bucket with versioning enabled,
   managed separately from this application stack. Configure the access above.
3. From the repository root, copy the backend template into the Terraform folder
   and migrate using credentials that can access both the existing state and
   the chosen bucket:

   ```powershell
   Copy-Item .github/terraform/backend.tf Backend/terraform/ci-backend.tf
   terraform -chdir=Backend/terraform init -migrate-state `
     -backend-config="bucket=YOUR_STATE_BUCKET" `
     -backend-config="region=us-east-1"
   ```

   Use Terraform 1.14.3, matching CI, or a compatible newer release. Do not set
   `TF_WORKSPACE` during migration; let Terraform present its migration prompts.
   Review them before accepting: migration can copy all existing local
   workspaces. Do not use `-reconfigure` as a substitute for `-migrate-state`.

4. Verify both intended environments against the migrated backend:

   ```powershell
   terraform -chdir=Backend/terraform workspace select default-staging
   terraform -chdir=Backend/terraform state list
   terraform -chdir=Backend/terraform workspace select default-prod
   terraform -chdir=Backend/terraform state list
   ```

   Each environment must contain its existing managed resources. For an
   environment that has never been created, perform its first reviewed
   deployment using the [backend instructions](../Backend/terraform/README.md)
   before enabling automatic deployments to that branch.

5. Configure GitHub variables and secrets. Run **Sushi deployment** manually on
   each branch with `operation: plan`, and inspect the plan before deploying.

The backend template fixes the key to `sushi/terraform.tfstate` and the workspace
prefix to `workspaces`. The two state object keys are:

```text
workspaces/default-staging/sushi/terraform.tfstate
workspaces/default-prod/sushi/terraform.tfstate
```

The backend uses S3 lockfiles with `use_lockfile = true`; no DynamoDB lock table
is required. Keep the ignored `Backend/terraform/ci-backend.tf` file locally
after migration so subsequent local commands use the same remote backend.
Copy it and initialize the same bucket in any new checkout. CI copies this
template automatically. Do not continue applying from an older checkout that
still uses the old local state.

## Frontend publishing

After Terraform applies, the workflow reads `frontend_environment`,
`frontend_bucket_name`, and `frontend_url` from the selected workspace. Vite
builds with that environment's API URL, Cognito configuration, and image URL.
No endpoint substitutions or manually maintained Vite secrets are needed.

Fingerprinted `dist/assets` files upload first with immutable cache headers.
The remaining build files upload afterward with no-cache headers, removing
obsolete non-asset files. Previous hashed assets remain available to browsers
with an older application shell. Terraform's existing CloudFront configuration
disables caching for the application shell, so routine uploads need no
invalidation. The job summary links to the deployed site.

References: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[Terraform S3 backend and permissions](https://developer.hashicorp.com/terraform/language/backend/s3),
[Terraform state migration](https://developer.hashicorp.com/terraform/cli/commands/init#backend-initialization),
[AWS credentials action](https://github.com/aws-actions/configure-aws-credentials/tree/v5).
