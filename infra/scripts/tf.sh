#!/usr/bin/env bash
# Run Terraform with the production runtime secrets from sops, as ephemeral
# variables (infra/secrets.tf, issue #126).
#
#   cd infra && AWS_PROFILE=water-management ./scripts/tf.sh plan -var-file=… -out=…
#   infra/scripts/tf.sh --preflight     # sops on PATH and the secrets file there; decrypts nothing
#
# `sops exec-env` decrypts infra-secrets/water-management/prod.sops.yaml in
# memory (kms:Decrypt through the caller's AWS credentials) and runs a shell
# that exports each key as TF_VAR_<key>, drops the bare name, and execs
# `terraform <your arguments>` in the current directory. No plaintext file is
# written, nothing is printed, and Terraform keeps the values out of state and
# out of any saved plan (the variables are ephemeral; they reach only
# write-only arguments). A key missing from the file is refused by name.
#
# Needed for anything that evaluates the configuration: plan, apply, import,
# console, refresh. Not for init, fmt, validate, output or state rm/mv/list.
# A saved plan is applied through this script too: Terraform asks for the
# ephemeral values again at apply.
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

command -v sops > /dev/null || die "sops not found on PATH (docs/deployment.md § Prerequisites)."
[ -f "$secrets" ] || die "no sops file at $secrets. Clone Absence0760/infra-secrets beside this repo, or set WM_SECRETS_FILE."
if [ "${1:-}" = "--preflight" ]; then
	[ $# -eq 1 ] || die "--preflight takes no other arguments."
	exit 0
fi
[ $# -gt 0 ] || die "usage: tf.sh <terraform arguments> (e.g. tf.sh plan -var-file=…), or tf.sh --preflight"
command -v terraform > /dev/null || die "terraform not found on PATH."

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
