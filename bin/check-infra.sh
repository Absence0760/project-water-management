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
#   bin/check-infra.sh -filter=tests/logging.tftest.hcl
#                                           passes its arguments to `terraform test`
#   CHECK_INFRA_JOBS=4 bin/check-infra.sh   test files at once (default: the CPUs)
#
# With no arguments the test files run in parallel, each in its own copy of
# the checked tree (`terraform test` runs a file's run blocks one by one, and
# the whole suite one file at a time took CI's 10-minute job past its limit),
# longest first by size; each file's output prints in name order when all are
# done, and the run fails when any file does.
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

base="$(mktemp -d "${TMPDIR:-/tmp}/check-infra.XXXXXX")"
work="$base/infra"
mkdir "$work"
cleanup() {
	if [ "${CHECK_INFRA_KEEP:-}" = 1 ]; then echo "check-infra: kept $base" >&2; else rm -rf "$base"; fi
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

files="$(cd "$work" && ls -S tests/*.tftest.hcl 2>/dev/null || true)"
count="$(printf '%s\n' "$files" | grep -c . || true)"
jobs="${CHECK_INFRA_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}"
if [ "$#" -gt 0 ] || [ "$count" -le 1 ] || [ "$jobs" -le 1 ]; then
	terraform test "$@"
	exit
fi

# One file in one copy of the checked tree (.terraform/ included: its
# providers are links into the plugin cache), its output and status kept for
# the summary below.
run_file() {
	local f="$1" name slot
	name="$(basename "$f" .tftest.hcl)"
	slot="$(mktemp -d "$CHECK_INFRA_BASE/slot.XXXXXX")"
	cp -pR "$CHECK_INFRA_WORK/." "$slot/"
	if (cd "$slot" && terraform test -filter="$f") >"$CHECK_INFRA_BASE/$name.log" 2>&1; then
		echo 0 >"$CHECK_INFRA_BASE/$name.status"
	else
		echo "$?" >"$CHECK_INFRA_BASE/$name.status"
	fi
	rm -rf "$slot"
}
export -f run_file
export CHECK_INFRA_BASE="$base" CHECK_INFRA_WORK="$work"
echo "terraform test: $count files, $jobs at a time"
printf '%s\n' "$files" | xargs -P "$jobs" -I{} bash -c 'run_file "$1"' _ {}

failed=0
for f in $(printf '%s\n' "$files" | sort); do
	name="$(basename "$f" .tftest.hcl)"
	cat "$base/$name.log"
	if [ "$(cat "$base/$name.status" 2>/dev/null || echo 1)" != 0 ]; then
		failed=$((failed + 1))
		echo "check-infra: $f failed" >&2
	fi
done
if [ "$failed" -gt 0 ]; then
	echo "check-infra: $failed of $count test files failed" >&2
	exit 1
fi
echo "check-infra: all $count test files passed"
