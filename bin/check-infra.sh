#!/usr/bin/env bash
# Credential-free Terraform checks for infra/: fmt, validate, and the
# plan-only `terraform test` suite against mocked providers
# (infra/tests/*.tftest.hcl). Same commands CI runs (terraform.yml, called by
# ci.yml's `terraform` job). No AWS credentials, state or sops key needed.
#
# Terraform runs against a private temporary copy of infra/, never infra/
# itself, so the checkout is never written to:
#   * Terraform 1.15's validate checks the S3 backend's required `bucket`, so
#     the run needs a local-backend override. It goes in the copy. An
#     override in infra/ that outlives a killed run would silently send real
#     state to a local file on the next `terraform init
#     -backend-config=backend.config`; with the copy there is nothing to
#     leave behind, even after a SIGKILL, which no trap can catch.
#   * Two runs at once (parallel sessions, worktrees sharing a checkout) each
#     get their own copy, `.terraform/` and stub zips, so they can't race.
# The copy is the files git would commit (tracked plus untracked, less
# ignored ones), so a gitignored terraform.tfvars, backend.config, state file
# or the operator's own *_override.tf never reaches the checks, and never
# leaves the checkout. Providers come from a shared plugin cache
# (TF_PLUGIN_CACHE_DIR, default ~/.terraform.d/plugin-cache), so only the
# first run downloads them; `terraform init` holds a lock on the cache where
# flock(1) exists, because Terraform doesn't make the cache safe for
# concurrent installs.
#
#   CHECK_INFRA_KEEP=1 bin/check-infra.sh   keeps the copy and prints its path
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/infra"

command -v terraform >/dev/null || { echo "terraform not found (brew install tfenv && tfenv install)" >&2; exit 1; }

# An override an earlier version of this script wrote into infra/ and could
# not remove (a hard kill): the exact file it wrote. Refuse rather than guess,
# because the operator's own override would look the same; they decide.
if [ -f "$src/backend_override.tf" ] && [ "$(cat "$src/backend_override.tf")" = "$(printf 'terraform {\n  backend "local" {}\n}')" ]; then
	echo "infra/backend_override.tf is a local-backend override, most likely left by an interrupted check:infra run." >&2
	echo "It sends state to a local file on the next real 'terraform init'. Delete it unless you made it on purpose; check:infra no longer needs it." >&2
	exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/check-infra.XXXXXX")"
cleanup() {
	if [ "${CHECK_INFRA_KEEP:-}" = 1 ]; then echo "check-infra: kept $work" >&2; else rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The files git would commit. Outside a git checkout (a source tarball), all
# of infra/ except .terraform/.
copy_tree() {
	if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		(cd "$src" && git ls-files -z --cached --others --exclude-standard -- .) |
			while IFS= read -r -d '' f; do
				[ -f "$src/$f" ] || continue # tracked but deleted in the working tree
				mkdir -p "$work/$(dirname "$f")"
				cp -p "$src/$f" "$work/$f"
			done
	else
		(cd "$src" && tar --exclude=./.terraform -cf - .) | (cd "$work" && tar -xf -)
	fi
}
copy_tree
rm -f "$work"/*_override.tf "$work"/*_override.tf.json
printf 'terraform {\n  backend "local" {}\n}\n' > "$work/backend_override.tf"

export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

cd "$work"
terraform fmt -check -recursive
if command -v flock >/dev/null; then
	flock "$TF_PLUGIN_CACHE_DIR/.check-infra.lock" terraform init -backend=false -input=false -lockfile=readonly >/dev/null
else
	terraform init -backend=false -input=false -lockfile=readonly >/dev/null
fi
terraform validate
terraform test
