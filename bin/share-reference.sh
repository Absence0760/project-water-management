#!/usr/bin/env bash
# Keeps source files that other projects read too (EWR Compliance, and the next one) in this
# project's reference bucket, under originals/<kind>/<version>-<file>, beside a
# <version>-SHA256SUMS listing each file's SHA-256 (docs/deployment.md § Reference datasets,
# Shared with other projects). Nothing loads them: each project reads them at build time on the
# operator's workstation, with the water-management profile, and checks the hashes. The bucket's
# policy is unchanged: it grants nothing to any other account.
#
#   bin/share-reference.sh [--dry-run] <kind> <version> <file>...
#
#   kind     what the files are, such as dws-rivers-500k or hydrorivers: lowercase letters, digits, '-'
#   version  which release or delivery, such as 2026-11 or v10: letters, digits, '.', '-'
#
# A space in a file name becomes '-' in its key. A file already up with the same SHA-256 is
# skipped, and one up with a different hash is refused: a new delivery takes a new version.
# --dry-run prints the keys and hashes and uploads nothing; with REFERENCE_BUCKET set it needs no
# AWS login. The bucket comes from `terraform -chdir=infra output -raw reference_bucket` (after
# `terraform init -backend-config=backend.config` there), or REFERENCE_BUCKET.
set -euo pipefail
export AWS_PROFILE=water-management

ROOT=$(cd "$(dirname "$0")/.." && pwd)
usage() { echo "usage: bin/share-reference.sh [--dry-run] <kind> <version> <file>..." >&2; exit 2; }

dry_run=0
if [ "${1:-}" = --dry-run ]; then dry_run=1; shift; fi
[ $# -ge 3 ] || usage
kind=$1
version=$2
shift 2
[[ "$kind" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "kind must be lowercase letters, digits and '-' (got: $kind)" >&2; exit 2; }
[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,29}$ ]] || { echo "version must be letters, digits, '.' and '-' (got: $version)" >&2; exit 2; }
for f in "$@"; do
	[ -f "$f" ] || { echo "Not a file: $f" >&2; exit 1; }
done

bucket=${REFERENCE_BUCKET:-$(terraform -chdir="$ROOT/infra" output -raw reference_bucket 2>/dev/null || true)}
case $bucket in
	water-management-reference-*) ;;
	*) echo "No reference bucket (got: '${bucket}'). Run terraform init in infra/, or set REFERENCE_BUCKET." >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sums=$work/SHA256SUMS
prefix="originals/$kind/$version"
for f in "$@"; do
	name=$(basename "$f")
	name=${name// /-}
	key="$prefix-$name"
	hex=$(sha256sum "$f" | cut -d' ' -f1)
	printf '%s  %s\n' "$hex" "$version-$name" >>"$sums"
	if [ "$dry_run" = 1 ]; then
		echo "would upload  $hex  s3://$bucket/$key"
		continue
	fi
	have=$(aws s3api head-object --bucket "$bucket" --key "$key" --query 'Metadata.sha256' --output text 2>/dev/null || true)
	if [ "$have" = "$hex" ]; then
		echo "already up    $hex  $key"
		continue
	fi
	if [ "$have" = None ]; then
		echo "Refusing $key: it is already up, with no SHA-256 recorded. Compare it by hand:" >&2
		echo "  aws s3 cp s3://$bucket/$key - --profile water-management | sha256sum   (this file's: $hex)" >&2
		exit 1
	fi
	if [ -n "$have" ]; then
		echo "Refusing $key: it is already up with SHA-256 $have, not $hex. A new delivery takes a new version." >&2
		exit 1
	fi
	aws s3 cp --only-show-errors "$f" "s3://$bucket/$key" --metadata "sha256=$hex"
	echo "uploaded      $hex  $key"
done

sort -k2 -o "$sums" "$sums"
if [ "$dry_run" = 1 ]; then
	echo "would upload  s3://$bucket/$prefix-SHA256SUMS:"
	sed 's/^/  /' "$sums"
	exit 0
fi
aws s3 cp --only-show-errors "$sums" "s3://$bucket/$prefix-SHA256SUMS"
echo "uploaded      $prefix-SHA256SUMS ($(wc -l <"$sums") files)"
