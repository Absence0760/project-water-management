# project-baseline: make the deploy role's use of the sops key opt-in

**Where to file:** the `templates` repo (`Absence0760/templates`), module
`infra/modules/project-baseline`. This repo doesn't edit it (base-owned,
cross-project); the proposal is here so the change can be made there once
and adopted by every project. Found by the pre-deploy infra audit, issue
#126 § IAM.

## What the module does today

`infra/modules/project-baseline/main.tf`, `data "aws_iam_policy_document"
"sops_key"`, statement `AllowDeployRoleUse`, grants the GitHub OIDC deploy
role `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey` and
`kms:DescribeKey` on the project's sops key (`alias/<project>-sops`). It is a
**key policy** statement, and in the same account a key policy grants on its
own: no identity policy is needed, so nothing in the project repo can take
it away.

## Why it's a problem here

- `water-management`'s deploy workflows (`deploy-backend.yml`,
  `deploy-frontend.yml`) never call sops or KMS. Runtime secrets reach the
  Lambdas through Secrets Manager, written by the operator's
  `terraform apply` under `sops exec-env` with their own SSO credentials,
  never by CI.
- That key encrypts `infra-secrets/water-management/prod.sops.yaml`: the JWT
  secret, the `water_app` password, the alerts token secret and the
  CloudFront signing key. With the grant, any approved deploy run (or a
  compromised action inside one) that gets hold of that ciphertext can
  decrypt every production secret. Without it, the deploy role can't.
- `docs/security.md § Secrets management` says decryption is gated by IAM;
  the grant widens that gate to CI.

## Proposed change

1. Add a variable to the module:

   ```hcl
   variable "deploy_role_sops_access" {
     description = "Let the GitHub deploy role use the sops key (Decrypt/Encrypt/GenerateDataKey). Only for projects whose CI decrypts sops files."
     type        = bool
     default     = true # flip to false once every consumer has opted in explicitly
   }
   ```

2. Make `AllowDeployRoleUse` a `dynamic "statement"` with
   `for_each = var.deploy_role_sops_access ? [1] : []`.
3. Set `deploy_role_sops_access = false` in `water-management`'s bootstrap
   tfvars, re-run the baseline stage, and confirm with
   `aws kms get-key-policy --key-id alias/water-management-sops --policy-name default`
   that only the account-root statement is left.
4. Once every project that needs it sets `true` explicitly (check each
   project's workflows for `sops`/`kms` use), flip the default to `false`,
   so a new project starts without it.

A narrower middle ground, if a project needs CI to *encrypt* but not
decrypt: split the statement so the deploy role gets `Encrypt` +
`GenerateDataKey` only.

## Test

The module's own plan tests (or a new one) should assert the key policy has
no statement naming the deploy role when the variable is false, and has
exactly the four actions when it's true.
