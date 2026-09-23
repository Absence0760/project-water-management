#!/usr/bin/env bash
# Credential-free Terraform checks for infra/: fmt, validate, and the
# plan-only `terraform test` suite against mocked providers
# (infra/tests/guardrails.tftest.hcl). Same commands CI runs (ci.yml, job
# `terraform`). No AWS credentials, state or sops key needed.
#
# Terraform 1.15's validate checks the S3 backend's required `bucket`, so a
# local-backend override is written for the duration of the run — and removed
# again, because a leftover override would silently send real state to a local
# file on the next `terraform init -backend-config=backend.config`. An override
# the operator created themselves is left alone.
set -euo pipefail

cd "$(dirname "$0")/../infra"

command -v terraform >/dev/null || { echo "terraform not found (brew install tfenv && tfenv install)" >&2; exit 1; }

override=backend_override.tf
created=0
if [ ! -e "$override" ]; then
	printf 'terraform {\n  backend "local" {}\n}\n' > "$override"
	created=1
fi
cleanup() { if [ "$created" = 1 ]; then rm -f "$override"; fi; }
trap cleanup EXIT

terraform fmt -check -recursive
terraform init -backend=false -input=false -lockfile=readonly >/dev/null
terraform validate
terraform test
