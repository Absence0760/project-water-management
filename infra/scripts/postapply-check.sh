#!/usr/bin/env bash
# Read-only checks the operator runs after an apply (the first one, and again
# after the renderer's second apply and the first frontend release):
# infra/README.md § Operator steps; issue #126. Each check prints PASS, WARN
# or FAIL; the script exits 1 if any check FAILED (a WARN doesn't), 2 on a
# usage error. It makes only Get/List/Describe AWS calls and plain GETs, and
# never prints a secret, an email address or the Function URL.
#
#   infra/scripts/postapply-check.sh --profile water-management --region af-south-1 \
#     [--var-file ../../infra-secrets/water-management/prod.tfvars] [--domain <site domain>] \
#     [--rds-event-test]
#
# Checks:
#   sns-<region>     Both alert topics (<region> and us-east-1, the budgets')
#                    have at least one confirmed email subscription; a
#                    PendingConfirmation one pages nobody.
#   rds-events       The RDS event subscription exists, is enabled and
#                    `active`, and targets the regional alerts topic.
#   rds-delivery     Only with --rds-event-test: did the RDS events of the
#                    last 24 hours reach the topic? See below.
#   ses-production   SES production access (WARN while in the sandbox: mail
#                    reaches verified addresses only; step 8a).
#   ecr-policy       The renderer repository policy holds exactly the one
#                    LambdaECRImageRetrievalPolicy statement Terraform wrote
#                    (Lambda added nothing of its own; reports.tf).
#   edge-*           Against https://<domain>: a missing /x.pdf and a missing
#                    file under /_app/ answer 404; /?list-type=2 and the
#                    other bucket-root-style requests never return an S3
#                    ListBucketResult.
#   function-url     The API's Function URL, called directly without the
#                    CloudFront shared secret, answers 403 (the /api prefix is
#                    CloudFront's, so the direct path is /health).
#
# --rds-event-test (opt-in; it changes nothing either): the topic policy lets
# events.rds.amazonaws.com publish only with aws:SourceAccount = this account
# and aws:SourceArn = the DB instance's ARN (alarms.tf AllowRdsEvents, the
# shape AWS documents in "Granting permissions to publish notifications to an
# Amazon SNS topic",
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.GrantingPermissions.html).
# A plan can't prove RDS sends that SourceArn, and a publish the policy denies
# is dropped silently: SNS counts nothing and nobody is paged. So the check
# compares the instance's subscribed-category events of the last 24 hours
# (rds describe-events) with the topic's NumberOfMessagesPublished and
# NumberOfNotificationsFailed over the same window: events but nothing
# published FAILS; no events at all is a WARN, because there was nothing to
# deliver. To produce an event on purpose, at the first deploy while the
# database holds no client data (a reboot is a minute of API downtime; never
# do it on a live system without a reason), run
#   aws rds reboot-db-instance --db-instance-identifier water-management --region <region> --profile water-management
# wait for the "DB instance restarted" email (an availability event), then
# re-run this script with --rds-event-test. The script never reboots anything.
#
# The domain comes from --domain, else domain_name in --var-file. Tested
# against a fake `aws` and `curl` (postapply-check.test.mjs, check-stubs/;
# `pnpm test:guards`).
set -euo pipefail

project="water-management"
topic="$project-prod-alerts"
repo="$project-renderer"
api_function="$project-backend"

usage() {
	sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' >&2
	exit 2
}

profile=""
region=""
var_file=""
domain=""
rds_event_test=0
while [ $# -gt 0 ]; do
	case "$1" in
	--profile) profile="${2:?--profile needs a value}"; shift 2 ;;
	--region) region="${2:?--region needs a value}"; shift 2 ;;
	--var-file) var_file="${2:?--var-file needs a value}"; shift 2 ;;
	--domain) domain="${2:?--domain needs a value}"; shift 2 ;;
	--rds-event-test) rds_event_test=1; shift ;;
	-h | --help) usage ;;
	*) echo "postapply-check: unknown argument: $1" >&2; usage ;;
	esac
done
if [ -n "$var_file" ] && [ ! -f "$var_file" ]; then
	echo "postapply-check: no such var file: $var_file" >&2
	exit 2
fi
var_set() {
	[ -n "$var_file" ] || return 0
	awk -v name="$1" '
		$0 ~ "^[ \t]*" name "[ \t]*=" {
			sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]*(#.*)?$/, ""); gsub(/"/, ""); v = $0
		}
		END { if (v != "") print v }
	' "$var_file"
}
[ -n "$region" ] || region="$(var_set aws_region)"
[ -n "$domain" ] || domain="$(var_set domain_name)"
[ -n "$region" ] || { echo "postapply-check: pass --region (or a --var-file that sets aws_region)" >&2; exit 2; }
[ -n "$domain" ] || { echo "postapply-check: pass --domain (or a --var-file that sets domain_name)" >&2; exit 2; }
for tool in aws jq curl; do
	command -v "$tool" >/dev/null || { echo "postapply-check: $tool not found" >&2; exit 2; }
done

failures=0
warnings=0
pass() { printf 'PASS  %-18s %s\n' "$1" "$2"; }
warn() { printf 'WARN  %-18s %s\n' "$1" "$2"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL  %-18s %s\n' "$1" "$2"; failures=$((failures + 1)); }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
errfile="$tmp/err"
# The first non-blank line of the last AWS or curl error (a code and message, no secret).
last_error() { { grep -m 1 -v "^[[:space:]]*$" "$errfile" || true; } | cut -c1-200; }
aws_in() {
	local r="$1"
	shift
	local args=(--region "$r")
	[ -z "$profile" ] || args+=(--profile "$profile")
	aws "${args[@]}" --output json "$@" 2>"$errfile"
}

echo "Post-apply checks: region $region, site https://$domain${profile:+, profile $profile}"

# --- SNS alert subscriptions --------------------------------------------------------

account=""
if out="$(aws_in "$region" sts get-caller-identity)"; then
	account="$(jq -r '.Account // empty' <<<"$out")"
fi
regions=("$region")
[ "$region" = "us-east-1" ] || regions+=(us-east-1)
for r in "${regions[@]}"; do
	name="sns-$r"
	if [ -z "$account" ]; then
		fail "$name" "can't read the account ID (sts get-caller-identity): $(last_error)"
		continue
	fi
	if out="$(aws_in "$r" sns list-subscriptions-by-topic --topic-arn "arn:aws:sns:$r:$account:$topic")"; then
		confirmed="$(jq '[.Subscriptions[]? | select(.Protocol == "email" and (.SubscriptionArn | startswith("arn:")))] | length' <<<"$out")"
		pending="$(jq '[.Subscriptions[]? | select(.Protocol == "email" and (.SubscriptionArn | startswith("arn:") | not))] | length' <<<"$out")"
		if [ "$confirmed" -gt 0 ]; then
			more=""
			[ "$pending" -eq 0 ] || more=", $pending pending"
			pass "$name" "$topic: $confirmed confirmed email subscription(s)$more"
		else
			fail "$name" "$topic: no confirmed email subscription ($pending pending): click the link AWS emailed to budget_alert_email, or re-apply to resend it"
		fi
	else
		fail "$name" "$topic: $(last_error)"
	fi
done

# --- SES production access ---------------------------------------------------------

if out="$(aws_in "$region" sesv2 get-account)"; then
	if [ "$(jq -r '.ProductionAccessEnabled' <<<"$out")" = "true" ]; then
		pass ses-production "SES production access is enabled in $region"
	else
		warn ses-production "SES is still in the sandbox in $region: mail reaches verified addresses only. Request production access (infra/README.md § Operator steps, step 8a)"
	fi
else
	fail ses-production "sesv2 get-account failed: $(last_error)"
fi

# --- ECR repository policy ---------------------------------------------------------

if out="$(aws_in "$region" ecr get-repository-policy --repository-name "$repo")"; then
	sids="$(jq -r '.policyText | fromjson | [.Statement] | flatten | map(.Sid // "(no Sid)") | join(",")' <<<"$out" 2>/dev/null || true)"
	if [ "$sids" = "LambdaECRImageRetrievalPolicy" ]; then
		pass ecr-policy "$repo: exactly the one LambdaECRImageRetrievalPolicy statement"
	else
		fail ecr-policy "$repo: statements [${sids:-unreadable}], expected only LambdaECRImageRetrievalPolicy (something other than Terraform wrote the policy: reports.tf, docs/deployment.md § Reports)"
	fi
else
	fail ecr-policy "$repo: $(last_error)"
fi

# --- RDS event subscription and (opt-in) delivery -------------------------------------

db="$project"
subscription="$project-db-events"
categories="[]"
if out="$(aws_in "$region" rds describe-event-subscriptions --subscription-name "$subscription")"; then
	sub="$(jq -c '.EventSubscriptionsList[0] // {}' <<<"$out")"
	status="$(jq -r '.Status // "missing"' <<<"$sub")"
	enabled="$(jq -r '.Enabled // false' <<<"$sub")"
	target="$(jq -r '.SnsTopicArn // "" | split(":") | last' <<<"$sub")"
	categories="$(jq -c '.EventCategoriesList // []' <<<"$sub")"
	if [ "$status" = "active" ] && [ "$enabled" = "true" ] && [ "$target" = "$topic" ]; then
		pass rds-events "$subscription is active and enabled, to $topic"
	else
		fail rds-events "$subscription: status $status, enabled $enabled, topic '${target:-none}' (expected active, true, $topic). A status like topic-not-exist or no-permission means RDS can't publish (rds.tf, alarms.tf AllowRdsEvents)"
	fi
else
	fail rds-events "$subscription: $(last_error)"
fi

if [ "$rds_event_test" = 1 ]; then
	# 24 hours back; GNU date first, then BSD (macOS).
	end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	start="$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)"
	metric() {
		aws_in "$region" cloudwatch get-metric-statistics --namespace AWS/SNS --metric-name "$1" \
			--dimensions "Name=TopicName,Value=$topic" --start-time "$start" --end-time "$end" \
			--period 86400 --statistics Sum |
			jq '[.Datapoints[]?.Sum] | add // 0 | floor'
	}
	if events="$(aws_in "$region" rds describe-events --source-type db-instance --source-identifier "$db" --duration 1440)" &&
		published="$(metric NumberOfMessagesPublished)" && failed="$(metric NumberOfNotificationsFailed)"; then
		n="$(jq --argjson c "$categories" '[.Events[]? | select(any(.EventCategories[]?; . as $e | $c | index($e)))] | length' <<<"$events")"
		if [ "$failed" -gt 0 ]; then
			fail rds-delivery "$topic: $failed notification(s) failed to deliver in the last 24 h (SNS NumberOfNotificationsFailed): check the email subscription"
		elif [ "$n" -eq 0 ]; then
			warn rds-delivery "no subscribed RDS event on $db in the last 24 h, so nothing to prove. Trigger one at the first deploy (the reboot in this script's header) and re-run"
		elif [ "$published" -eq 0 ]; then
			fail rds-delivery "$n RDS event(s) on $db in the last 24 h but $topic published nothing: the topic policy is denying RDS (alarms.tf AllowRdsEvents, its aws:SourceArn)"
		else
			pass rds-delivery "$n RDS event(s) on $db and $published message(s) published to $topic in the last 24 h. Alarms publish to the same topic, so the RDS email arriving is the proof"
		fi
	else
		fail rds-delivery "can't read the events or the topic's metrics: $(last_error)"
	fi
fi

# --- Edge: 404s and no bucket listing ------------------------------------------------

# get <url>: the status code, with the body in $tmp/body. No shared secret or
# any other credential is ever sent.
get() {
	local code
	rm -f "$tmp/body"
	: >"$tmp/body"
	code="$(curl -sS --max-time 20 -o "$tmp/body" -w '%{http_code}' "$1" 2>"$errfile")" || code="000"
	printf '%s' "${code:-000}"
}

site="https://$domain"
for path in /wm-postapply-check-missing.pdf /_app/immutable/wm-postapply-check-missing.js; do
	code="$(get "$site$path")"
	if [ "$code" = "404" ]; then
		pass edge-404 "$path answers 404"
	else
		fail edge-404 "$path answers $code, expected 404$([ "$code" = 000 ] && printf ' (%s)' "$(last_error)")"
	fi
done
for path in '/?list-type=2' '/?list-type=2&prefix=' '/_app/?list-type=2&prefix=_app/' '/_app/'; do
	code="$(get "$site$path")"
	if [ "$code" = "000" ]; then
		fail edge-no-listing "$path: request failed ($(last_error))"
	elif grep -q 'ListBucketResult' "$tmp/body"; then
		fail edge-no-listing "$path returns an S3 bucket listing (status $code): the default behaviour forwards a query string or the rewrite lets a directory through (s3_cloudfront.tf)"
	else
		pass edge-no-listing "$path returns no bucket listing (status $code)"
	fi
done

# --- Function URL without the shared secret ------------------------------------------

if out="$(aws_in "$region" lambda get-function-url-config --function-name "$api_function")"; then
	url="$(jq -r '.FunctionUrl // empty' <<<"$out")"
	if [ -z "$url" ]; then
		fail function-url "$api_function has no Function URL"
	else
		code="$(get "${url%/}/health")"
		if [ "$code" = "403" ]; then
			pass function-url "direct /health without the shared secret answers 403"
		else
			fail function-url "direct /health without the shared secret answers $code, expected 403: the API is reachable past CloudFront and the WAF (backend/src/app.ts, CLOUDFRONT_SHARED_SECRET)"
		fi
	fi
else
	fail function-url "$api_function: $(last_error)"
fi

echo
if [ "$failures" -gt 0 ]; then
	echo "$failures check(s) FAILED, $warnings warning(s)."
	exit 1
fi
if [ "$warnings" -gt 0 ]; then
	echo "No check failed; $warnings warning(s)."
else
	echo "All post-apply checks passed."
fi
