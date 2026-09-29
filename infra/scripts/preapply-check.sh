#!/usr/bin/env bash
# Read-only checks the operator runs before the first `terraform apply`
# (infra/README.md § Operator steps; issue #126). Each check prints PASS or
# FAIL with what it saw; the script exits 1 if any check failed, 2 on a usage
# error. It makes only Get/Describe calls and never prints a secret.
#
#   infra/scripts/preapply-check.sh --profile water-management \
#     [--region af-south-1] [--var-file ../../infra-secrets/water-management/prod.tfvars] \
#     [--backend-config infra/backend.config] [--reserved <n>]
#
# Checks:
#   1. lambda-quota    The region's Lambda concurrent-executions quota
#                      (L-B99A9384) is at least the sum of the reserved
#                      concurrencies Terraform will set + 10 (AWS keeps 10
#                      unreserved; a new account's quota is 10).
#   2. state-bucket    The state bucket named in backend.config exists and is
#                      in us-east-1 (main.tf reads state from us-east-1 only).
#   3. sops-key        The KMS key alias/water-management-sops exists in
#                      us-east-1 and is Enabled (tf.sh decrypts with it).
#   4. ses-endpoint    The SES VPC endpoint service com.amazonaws.<region>.email
#                      exists (aws_vpc_endpoint.ses fails to create otherwise).
#   5. rds-orderable   The region offers the DB instance class for the
#                      PostgreSQL major version rds.tf pins.
#   6. cloudtrail      A CloudTrail trail (this account's, or an Organization
#                      trail) covering the region is logging and records
#                      write management events from kms.amazonaws.com. The
#                      database KMS key alarm (kms.tf) is an EventBridge rule
#                      on CloudTrail events, which reach EventBridge only
#                      through such a trail. Skipped (PASS) when the tfvars
#                      set rds_customer_managed_key = false.
#
# The reservations: nothing is applied yet, so there is no Terraform output to
# read them from. The script sums every `*_reserved_concurrency` variable in
# infra/variables.tf, each at its default unless --var-file sets it as a
# plain number (`name = 10`). A new Lambda's variable is picked up by its
# name, with no list here to keep in step. The renderer's reservation counts
# even before renderer_image_tag creates the function: the quota must cover
# the second apply too. --reserved <n> skips the parsing and uses n as the
# sum. The region and DB instance class come from --region / --var-file the
# same way (defaults: variables.tf). Tested against a fake `aws`
# (preapply-check.test.mjs, check-stubs/; `pnpm test:guards`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra="$(cd "$here/.." && pwd)"
project="water-management"
state_region="us-east-1"

usage() {
	sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' >&2
	exit 2
}

profile=""
region=""
var_file=""
backend_config="$infra/backend.config"
reserved=""
while [ $# -gt 0 ]; do
	case "$1" in
	--profile) profile="${2:?--profile needs a value}"; shift 2 ;;
	--region) region="${2:?--region needs a value}"; shift 2 ;;
	--var-file) var_file="${2:?--var-file needs a value}"; shift 2 ;;
	--backend-config) backend_config="${2:?--backend-config needs a value}"; shift 2 ;;
	--reserved) reserved="${2:?--reserved needs a value}"; shift 2 ;;
	-h | --help) usage ;;
	*) echo "preapply-check: unknown argument: $1" >&2; usage ;;
	esac
done
if [ -n "$var_file" ] && [ ! -f "$var_file" ]; then
	echo "preapply-check: no such var file: $var_file" >&2
	exit 2
fi
if [ -n "$reserved" ] && ! [[ "$reserved" =~ ^[0-9]+$ ]]; then
	echo "preapply-check: --reserved must be a whole number" >&2
	exit 2
fi
command -v aws >/dev/null || { echo "preapply-check: aws CLI not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "preapply-check: jq not found" >&2; exit 2; }

# --- tfvars / variables.tf reading ---------------------------------------------

# The default of variable $1 in variables.tf, as written (quotes stripped).
var_default() {
	awk -v name="$1" '
		$0 ~ "^variable \"" name "\"" { inside = 1; next }
		inside && /^variable "/ { exit }
		inside && /^  default[ \t]*=/ {
			sub(/^  default[ \t]*=[ \t]*/, ""); sub(/[ \t]*(#.*)?$/, ""); gsub(/"/, ""); print; exit
		}
	' "$infra/variables.tf"
}

# The value of $1 set in the var file, if it is set there (quotes stripped).
var_set() {
	[ -n "$var_file" ] || return 0
	awk -v name="$1" '
		$0 ~ "^[ \t]*" name "[ \t]*=" {
			sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]*(#.*)?$/, ""); gsub(/"/, ""); v = $0
		}
		END { if (v != "") print v }
	' "$var_file"
}

var_value() {
	local v
	v="$(var_set "$1")"
	[ -n "$v" ] || v="$(var_default "$1")"
	printf '%s' "$v"
}

[ -n "$region" ] || region="$(var_value aws_region)"
[ -n "$region" ] || { echo "preapply-check: no --region, and none in the var file or variables.tf" >&2; exit 2; }

# --- output ----------------------------------------------------------------------

failures=0
pass() { printf 'PASS  %-14s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-14s %s\n' "$1" "$2"; failures=$((failures + 1)); }

errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT
# The first non-blank line of the last AWS error (an error code and message, no secret).
aws_error() { { grep -m 1 -v "^[[:space:]]*$" "$errfile" || true; } | cut -c1-200; }

# aws <region> <args…>: a read-only call in the given region, JSON out.
aws_in() {
	local r="$1"
	shift
	local args=(--region "$r")
	[ -z "$profile" ] || args+=(--profile "$profile")
	aws "${args[@]}" --output json "$@" 2>"$errfile"
}

echo "Pre-apply checks: region $region${profile:+, profile $profile}"

# --- 1. Lambda concurrency quota -------------------------------------------------

breakdown=""
if [ -z "$reserved" ]; then
	reserved=0
	names="$(sed -n 's/^variable "\([a-z0-9_]*_reserved_concurrency\)".*/\1/p' "$infra/variables.tf")"
	if [ -z "$names" ]; then
		fail lambda-quota "no *_reserved_concurrency variable in variables.tf; pass --reserved <sum>"
		reserved=""
	fi
	for n in $names; do
		v="$(var_value "$n")"
		if ! [[ "$v" =~ ^[0-9]+$ ]]; then
			fail lambda-quota "can't read $n as a number ('$v'); pass --reserved <sum>"
			reserved=""
			break
		fi
		reserved=$((reserved + v))
		breakdown="$breakdown ${n%_reserved_concurrency}=$v"
	done
fi
if [ -n "$reserved" ]; then
	need=$((reserved + 10))
	if out="$(aws_in "$region" service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384)"; then
		quota="$(jq -r '.Quota.Value // empty' <<<"$out")"
		quota="${quota%%.*}"
		if ! [[ "$quota" =~ ^[0-9]+$ ]]; then
			fail lambda-quota "unreadable quota value"
		elif [ "$quota" -ge "$need" ]; then
			pass lambda-quota "quota $quota >= $need (reservations $reserved + 10 unreserved)${breakdown:+;$breakdown}"
		else
			fail lambda-quota "quota $quota < $need (reservations $reserved + 10 unreserved)${breakdown:+;$breakdown}. Request an increase (infra/README.md § Operator steps, step 3) and wait for the grant"
		fi
	else
		fail lambda-quota "get-service-quota failed: $(aws_error)"
	fi
fi

# --- 2. State bucket (us-east-1) --------------------------------------------------

bucket=""
if [ -f "$backend_config" ]; then
	bucket="$(sed -n 's/^[ \t]*bucket[ \t]*=[ \t]*"\([^"]*\)".*/\1/p' "$backend_config" | head -n 1)"
fi
if [ -z "$bucket" ]; then
	fail state-bucket "no bucket in $backend_config (write it: infra/README.md § Operator steps, step 7)"
elif [[ "$bucket" == *PLACEHOLDER* ]]; then
	fail state-bucket "$backend_config still holds the example's placeholder bucket"
elif out="$(aws_in "$state_region" s3api get-bucket-location --bucket "$bucket")"; then
	loc="$(jq -r '.LocationConstraint // "us-east-1"' <<<"$out")"
	if [ "$loc" = "$state_region" ]; then
		pass state-bucket "$bucket is in $state_region"
	else
		fail state-bucket "$bucket is in $loc, not $state_region (main.tf reads state from $state_region only)"
	fi
else
	fail state-bucket "$bucket: $(aws_error)"
fi

# --- 3. sops KMS key (us-east-1) --------------------------------------------------

key="alias/$project-sops"
if out="$(aws_in "$state_region" kms describe-key --key-id "$key")"; then
	st="$(jq -r '.KeyMetadata.KeyState // empty' <<<"$out")"
	if [ "$st" = "Enabled" ]; then
		pass sops-key "$key is Enabled in $state_region"
	else
		fail sops-key "$key is ${st:-in an unknown state} in $state_region"
	fi
else
	fail sops-key "$key in $state_region: $(aws_error) (infra/README.md § Operator steps, step 5)"
fi

# --- 4. SES VPC endpoint service ---------------------------------------------------

svc="com.amazonaws.$region.email"
if out="$(aws_in "$region" ec2 describe-vpc-endpoint-services --service-names "$svc")" &&
	jq -e --arg s "$svc" 'any(.ServiceDetails[]?; .ServiceName == $s)' <<<"$out" >/dev/null; then
	pass ses-endpoint "$svc exists"
else
	err="$(aws_error)"
	fail ses-endpoint "$svc is not offered in $region, so aws_vpc_endpoint.ses would fail${err:+ ($err)}"
fi

# --- 5. RDS orderable instance ----------------------------------------------------

major="$(sed -n 's/^[ \t]*db_major_version[ \t]*=[ \t]*"\([0-9]*\)".*/\1/p' "$infra/rds.tf" | head -n 1)"
class="$(var_value db_instance_class)"
if [ -z "$major" ] || [ -z "$class" ]; then
	fail rds-orderable "can't read db_major_version (rds.tf) or db_instance_class"
elif out="$(aws_in "$region" rds describe-orderable-db-instance-options --engine postgres --db-instance-class "$class")"; then
	# Filtered here rather than with --engine-version: rds.tf passes the major
	# version alone ("17"), which RDS resolves to its default minor, and the
	# filter wants a full version.
	versions="$(jq -r --arg m "$major." '[.OrderableDBInstanceOptions[]?.EngineVersion | select(startswith($m))] | unique | join(" ")' <<<"$out")"
	if [ -n "$versions" ]; then
		pass rds-orderable "$class offers PostgreSQL $major in $region ($versions)"
	else
		fail rds-orderable "$class offers no PostgreSQL $major version in $region"
	fi
else
	fail rds-orderable "describe-orderable-db-instance-options failed: $(aws_error)"
fi

# --- 6. CloudTrail trail for the KMS key alarm --------------------------------------

# The key alarm (kms.tf aws_cloudwatch_event_rule.rds_kms_key_change) matches
# "AWS API Call via CloudTrail" events, which EventBridge receives only while a
# trail logging write management events covers the region. The stack doesn't
# create a trail (an Organization trail covers every account; a second one
# here would be a billed duplicate), so this proves one exists. A trail
# counts when it is multi-region or homed in the region, IsLogging is true,
# and its event selectors record management events that are Write or All and
# not excluded for kms.amazonaws.com. Advanced selectors count only with
# eventCategory = Management and nothing but readOnly / eventSource narrowing
# them, in ways that keep KMS writes; anything else is not assumed to cover.
cmk="$(var_value rds_customer_managed_key)"
if [ "$cmk" = "false" ]; then
	pass cloudtrail "not needed: rds_customer_managed_key = false (no database key alarm)"
elif out="$(aws_in "$region" cloudtrail describe-trails --include-shadow-trails)"; then
	trails="$(jq -r --arg r "$region" '.trailList[]? | select(.IsMultiRegionTrail == true or .HomeRegion == $r) | .TrailARN' <<<"$out")"
	covered=""
	seen=""
	for t in $trails; do
		if ! st="$(aws_in "$region" cloudtrail get-trail-status --name "$t")"; then
			seen="$seen; ${t##*/}: get-trail-status failed ($(aws_error))"
			continue
		fi
		if [ "$(jq -r '.IsLogging // false' <<<"$st")" != "true" ]; then
			seen="$seen; ${t##*/}: not logging"
			continue
		fi
		if ! sel="$(aws_in "$region" cloudtrail get-event-selectors --trail-name "$t")"; then
			seen="$seen; ${t##*/}: get-event-selectors failed ($(aws_error))"
			continue
		fi
		if jq -e '
			def has($a; $x): any(($a // [])[]; . == $x);
			def kms_ok($f):
				($f.Equals == null or has($f.Equals; "kms.amazonaws.com"))
				and (has($f.NotEquals; "kms.amazonaws.com") | not)
				and all($f | keys[]; . == "Field" or . == "Equals" or . == "NotEquals");
			def ro_ok($f):
				($f.Equals == null or has($f.Equals; "false"))
				and all($f | keys[]; . == "Field" or . == "Equals");
			any(.EventSelectors[]?;
				.IncludeManagementEvents == true
				and (.ReadWriteType == "All" or .ReadWriteType == "WriteOnly")
				and (has(.ExcludeManagementEventSources; "kms.amazonaws.com") | not))
			or any(.AdvancedEventSelectors[]?;
				.FieldSelectors as $fs
				| any($fs[]; .Field == "eventCategory" and has(.Equals; "Management"))
				and all($fs[];
					(.Field == "eventCategory" and all(keys[]; . == "Field" or . == "Equals"))
					or (.Field == "readOnly" and ro_ok(.))
					or (.Field == "eventSource" and kms_ok(.))))
		' <<<"$sel" >/dev/null; then
			covered="$t"
			break
		fi
		seen="$seen; ${t##*/}: logging, but no selector records KMS write management events"
	done
	if [ -n "$covered" ]; then
		pass cloudtrail "$covered logs write management events (KMS included) in $region"
	elif [ -z "$trails" ]; then
		fail cloudtrail "no trail covers $region, so the database KMS key alarm (kms.tf) would never fire. Create an Organization trail from the management account (preferred) or a trail in this account (infra/README.md § Operator steps, step 7a)"
	else
		fail cloudtrail "no trail covering $region logs KMS write management events${seen:+ (${seen#; })}, so the database KMS key alarm (kms.tf) would never fire (infra/README.md § Operator steps, step 7a)"
	fi
else
	fail cloudtrail "describe-trails failed: $(aws_error); can't confirm the trail the database KMS key alarm (kms.tf) needs"
fi

echo
if [ "$failures" -gt 0 ]; then
	echo "$failures check(s) FAILED. Fix them before planning the first apply."
	exit 1
fi
echo "All pre-apply checks passed."
