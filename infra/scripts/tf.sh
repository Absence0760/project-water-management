#!/usr/bin/env bash
# Run Terraform with the production runtime secrets from sops, as ephemeral
# variables (infra/secrets.tf, issue #126).
#
#   cd infra && AWS_PROFILE=water-management ./scripts/tf.sh plan -var-file=… -out=…
#   infra/scripts/tf.sh --preflight     # sops, the secrets file and its metadata; decrypts nothing
#
# `sops exec-env` decrypts infra-secrets/water-management/prod.sops.yaml in
# memory (kms:Decrypt through the caller's AWS credentials) and runs a shell
# that exports each key as TF_VAR_<key>, drops the bare name, and execs
# `terraform <your arguments>` in the current directory. No plaintext file is
# written, nothing secret is printed, and Terraform keeps the values out of
# state and out of any saved plan (the variables are ephemeral; they reach
# only write-only arguments). A key missing from the file is refused by name.
#
# The rotation counter is automatic. Terraform keeps no copy of a write-only
# value, so it can't see a changed sops value by itself; runtime_secret_version
# tells it when to write again. This script sets TF_VAR_runtime_secret_version
# from the file's own `sops.lastmodified` (plaintext metadata that sops
# rewrites on every edit, UTC RFC 3339, e.g. 2026-09-28T08:15:00Z) as the
# integer 20260928081500 (its digits: YYYYMMDDhhmmss). It reads that one line
# of the `sops:` block with awk; no encrypted value is touched for it. So any
# sops edit changes the counter, and the next apply rewrites every runtime
# secret and cold-starts the Lambdas.
#
# Forced rewrite of unchanged values: pass `-var runtime_secret_version=<n>`
# (any whole number other than the current one; `date -u +%Y%m%d%H%M%S` is
# always newer), or export TF_VAR_runtime_secret_version, which this script
# then leaves alone. The next plain run goes back to lastmodified, which is
# another change, so it rewrites once more (harmless: a cold start). A var
# file that sets runtime_secret_version would silently pin the counter
# (Terraform ranks var files above TF_VAR_*), so this script refuses one.
#
# Needed for anything that evaluates the configuration: plan, apply, import,
# console, refresh. Not for init, fmt, validate, output or state rm/mv/list.
# A saved plan is applied through this script too: Terraform asks for the
# ephemeral values again at apply (and the counter comes out the same).
#
# WM_SECRETS_FILE overrides the sops file (default: the infra-secrets clone
# beside this repo, ~/github/infra-secrets).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secrets="${WM_SECRETS_FILE:-$here/../../../infra-secrets/water-management/prod.sops.yaml}"
# The sops keys that become TF_VAR_<key> (variables.tf § Runtime secrets;
# infra/prod.sops.yaml.example).
keys=(auth_jwt_secret db_app_password alerts_token_secret)

die() {
	echo "tf.sh: $*" >&2
	exit 1
}

# `sops.lastmodified` as YYYYMMDDhhmmss. Plaintext metadata only: awk reads
# the lines of the top-level `sops:` block and prints the one lastmodified
# value; nothing else of the file leaves awk.
last_modified_version() {
	local raw
	raw=$(awk '
		/^sops:[[:space:]]*$/ { in_sops = 1; next }
		in_sops && /^[^[:space:]#]/ { in_sops = 0 }
		in_sops && /^[[:space:]]+lastmodified:/ {
			sub(/^[[:space:]]+lastmodified:[[:space:]]*/, "")
			gsub(/["\047[:space:]]/, "")
			print
			exit
		}
	' "$secrets")
	[ -n "$raw" ] || die "no sops.lastmodified in $secrets (not a sops-encrypted YAML file?). It sets runtime_secret_version; to set that by hand, export TF_VAR_runtime_secret_version."
	[[ "$raw" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
		|| die "sops.lastmodified in $secrets is '$raw', not a UTC RFC 3339 time (2026-09-28T08:15:00Z)."
	echo "${raw//[^0-9]/}"
}

command -v sops > /dev/null || die "sops not found on PATH (docs/deployment.md § Prerequisites)."
[ -f "$secrets" ] || die "no sops file at $secrets. Clone Absence0760/infra-secrets beside this repo, or set WM_SECRETS_FILE."
if [ "${1:-}" = "--preflight" ]; then
	[ $# -eq 1 ] || die "--preflight takes no other arguments."
	[ -n "${TF_VAR_runtime_secret_version:-}" ] || last_modified_version > /dev/null
	exit 0
fi
[ $# -gt 0 ] || die "usage: tf.sh <terraform arguments> (e.g. tf.sh plan -var-file=…), or tf.sh --preflight"
command -v terraform > /dev/null || die "terraform not found on PATH."

# Refuse a var file that pins the counter: the files named with -var-file, and
# the ones Terraform loads by itself from its working directory (-chdir).
workdir=.
var_files=()
prev=""
for a in "$@"; do
	case "$a" in
		-chdir=*) workdir="${a#-chdir=}" ;;
		-var-file=*) var_files+=("${a#-var-file=}") ;;
	esac
	[ "$prev" = "-var-file" ] && var_files+=("$a")
	prev="$a"
done
for f in "$workdir"/terraform.tfvars "$workdir"/terraform.tfvars.json "$workdir"/*.auto.tfvars "$workdir"/*.auto.tfvars.json; do
	[ -f "$f" ] && var_files+=("$f")
done
for f in ${var_files[@]+"${var_files[@]}"}; do
	# Terraform reads a relative -var-file from the -chdir directory.
	case "$f" in /*) ;; *) [ -f "$f" ] || f="$workdir/$f" ;; esac
	[ -f "$f" ] || continue
	# HCL (`runtime_secret_version = …`, at a line start) or JSON (the quoted
	# key anywhere, since a .tfvars.json may be one line).
	if grep -Eq '^[[:space:]]*runtime_secret_version[[:space:]]*=|"runtime_secret_version"[[:space:]]*:' "$f"; then
		die "$f sets runtime_secret_version, which would pin the rotation counter. Remove it: this script derives it from sops.lastmodified (for a forced rewrite, pass -var runtime_secret_version=…)."
	fi
done

if [ -n "${TF_VAR_runtime_secret_version:-}" ]; then
	echo "tf.sh: runtime_secret_version=$TF_VAR_runtime_secret_version from the environment (not sops.lastmodified)" >&2
else
	TF_VAR_runtime_secret_version=$(last_modified_version)
	export TF_VAR_runtime_secret_version
fi

# sops runs one /bin/sh command string, so each argument goes in single-quoted
# (POSIX: close the quote, an escaped quote, reopen).
quoted=""
for a in "$@"; do
	quoted+=" '${a//\'/\'\\\'\'}'"
done

inner='set -eu
for k in '"${keys[*]}"'; do
	v=$(printenv "$k") || { echo "tf.sh: $k is missing from the sops file" >&2; exit 1; }
	[ -n "$v" ] || { echo "tf.sh: $k is empty in the sops file" >&2; exit 1; }
	export "TF_VAR_$k=$v"
	unset "$k"
done
unset k v
exec terraform'"$quoted"

exec sops exec-env --same-process "$secrets" "$inner"
