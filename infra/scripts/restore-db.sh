#!/usr/bin/env bash
# Restore the production database to a point in time (or from a snapshot)
# into the stack's own network and settings, then swap it in under the
# original identifier. The runbook around it: docs/deployment.md § Restoring
# the database. Dry-run by default: it prints every AWS and Terraform command
# it would run and changes nothing.
#
#   infra/scripts/restore-db.sh --region <r> --profile <p> --var-file <prod.tfvars> \
#     (--restore-time 2026-09-28T08:15:00Z | --latest | --snapshot <id>) [--execute [--yes]]
#
# Why a script: RestoreDBInstanceToPointInTime and
# RestoreDBInstanceFromDBSnapshot create the new instance with the default
# subnet group, security group and parameter group, and no deletion
# protection. A restore run with only the obvious flags lands in the account's
# default VPC, where no Lambda can reach it, without this project's TLS and
# logging parameters. This script passes every one of those from Terraform's
# outputs and the live instance, and checks the result before it swaps.
#
# What it does (--execute):
#   1. Preflight (read only, also in a dry run): the caller, Terraform's
#      outputs (identifier, subnet group, security group, parameter group,
#      region), the live instance's settings, and that the restore point is
#      inside the backup retention window (or that the snapshot is available).
#   2. Restores to <id>-restore-<ts> with the stack's subnet group, security
#      group and parameter group, not publicly accessible, deletion
#      protection on, tags copied to snapshots, and the live instance's class,
#      Multi-AZ, CA, backup retention and window, minor-upgrade setting,
#      storage autoscaling ceiling and tags. Storage encryption and its KMS key
#      are inherited from the backup (a restore can't change them); step 4
#      checks them.
#   3. Turns on RDS-managed master credentials on the restored instance: a
#      PostgreSQL restore can't keep or request them (ManageMasterUserPassword
#      on a restore is "RDS for Oracle only"), so the copy comes up with the
#      master password as it was at the restore point and no secret. The
#      modify gives it a new Secrets Manager secret (a new ARN).
#   4. Verifies the restored instance's network, parameter group, encryption
#      and KMS key, deletion protection, CA, backup retention, monitoring and
#      master secret. Any mismatch stops here, before production is touched.
#   5. Asks for the identifier to be typed (skip with --yes), then swaps:
#      stops the old instance's log export (so its renamed self doesn't start
#      a new, never-expiring log group), renames old → <id>-old-<ts>, renames
#      restored → <id> (same endpoint address, so DATABASE_URL is unchanged),
#      and turns the log export on for it, into the Terraform-managed group.
#      The API is down from the first rename until the second finishes
#      (minutes).
#   6. Points Terraform at the new instance. The swap alone is not enough:
#      the AWS provider (v5+) keys aws_db_instance by its DbiResourceId, not
#      its identifier, so a refresh would find the *old* instance under its
#      new name and plan to rename it back. So: `terraform state rm` and
#      `terraform import` by identifier, then `terraform plan` (never apply).
#      Import and plan evaluate the configuration, so they run through
#      tf.sh (the runtime secrets from sops, as ephemeral variables); the
#      preflight checks that sops and the secrets file are there.
#      The plan must show in-place changes only (the migrate Lambda's
#      MASTER_SECRET_ARN, the Secrets Manager endpoint policy and some
#      Terraform-only arguments); a replace or destroy stops the script.
#
# It never applies Terraform and never deletes an instance. It ends by
# printing the apply, the migrate invoke, and how to delete the old instance
# once the restored one is verified.
#
# RPO: RDS ships transaction logs to S3 every five minutes, so --latest loses
# up to ~5 minutes (LatestRestorableTime); a snapshot restore loses
# everything since the snapshot. Writes that reach the old instance after the
# restore point stay in <id>-old-<ts> only.
#
# Test hooks (restore-db.test.mjs): RESTORE_DB_TIMESTAMP fixes <ts>,
# RESTORE_DB_POLL_SECONDS / RESTORE_DB_TIMEOUT_SECONDS set the waits.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REGION=""
PROFILE=""
VAR_FILE=""
RESTORE_TIME=""
LATEST=0
SNAPSHOT=""
EXECUTE=0
ASSUME_YES=0
POLL="${RESTORE_DB_POLL_SECONDS:-30}"
TIMEOUT="${RESTORE_DB_TIMEOUT_SECONDS:-7200}"
TS="${RESTORE_DB_TIMESTAMP:-$(date -u +%Y%m%d%H%M%S)}"

usage() {
	sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
	echo
	echo "Options: --region, --profile and --var-file are required, and exactly one of"
	echo "--restore-time (UTC, YYYY-MM-DDTHH:MM:SSZ), --latest or --snapshot."
	echo "--execute runs the commands (default: print them). --yes skips the typed confirmation."
	echo "--infra-dir <dir> overrides the Terraform directory (default: infra/)."
}

die() {
	echo "restore-db: $*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
		--region) REGION="${2:-}"; shift 2 ;;
		--profile) PROFILE="${2:-}"; shift 2 ;;
		--var-file) VAR_FILE="${2:-}"; shift 2 ;;
		--restore-time) RESTORE_TIME="${2:-}"; shift 2 ;;
		--latest) LATEST=1; shift ;;
		--snapshot) SNAPSHOT="${2:-}"; shift 2 ;;
		--execute) EXECUTE=1; shift ;;
		--yes) ASSUME_YES=1; shift ;;
		--infra-dir) INFRA_DIR="${2:-}"; shift 2 ;;
		-h | --help) usage; exit 0 ;;
		*) usage >&2; die "unknown argument: $1" ;;
	esac
done

[ -n "$REGION" ] || die "--region is required (the stack's aws_region). Nothing runs against an implied region."
[ -n "$PROFILE" ] || die "--profile is required (the AWS SSO profile). Nothing runs against an implied account."
[ -n "$VAR_FILE" ] || die "--var-file is required (the prod tfvars Terraform import and plan read)."
[ -f "$VAR_FILE" ] || die "--var-file $VAR_FILE: no such file."
# Absolute, since terraform -chdir would read a relative path from infra/.
VAR_FILE="$(cd "$(dirname "$VAR_FILE")" && pwd)/$(basename "$VAR_FILE")"
modes=$LATEST
[ -z "$RESTORE_TIME" ] || modes=$((modes + 1))
[ -z "$SNAPSHOT" ] || modes=$((modes + 1))
[ "$modes" -eq 1 ] || die "give exactly one of --restore-time, --latest or --snapshot."
if [ -n "$RESTORE_TIME" ]; then
	[[ "$RESTORE_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
		|| die "--restore-time must be UTC in the form 2026-09-28T08:15:00Z (got '$RESTORE_TIME')."
fi
for tool in aws terraform jq; do
	command -v "$tool" > /dev/null || die "$tool not found on PATH."
done
# Checked now, not at step 6: by then production has been swapped.
"$SCRIPTS_DIR/tf.sh" --preflight || die "step 6 (terraform import + plan) needs the runtime secrets from sops (tf.sh)."

AWS=(aws --region "$REGION" --profile "$PROFILE" --output json)
# output and state rm read state only; import and plan evaluate the
# configuration, which needs the sops-fed ephemeral variables (tf.sh).
TF=(env "AWS_PROFILE=$PROFILE" terraform "-chdir=$INFRA_DIR")
TFS=(env "AWS_PROFILE=$PROFILE" "$SCRIPTS_DIR/tf.sh" "-chdir=$INFRA_DIR")

# --- Printing and running -----------------------------------------------------------------
STAGE="preflight"
show() {
	printf '+'
	printf ' %q' "$@"
	printf '\n'
}
# A command that changes something: printed always, run only with --execute.
# The AWS CLI's JSON reply is dropped (the waits read the state); Terraform's
# output is kept.
act() {
	show "$@"
	[ "$EXECUTE" = 1 ] || return 0
	if [ "$1" = aws ]; then "$@" > /dev/null; else "$@"; fi
}
note() { printf '# %s\n' "$*"; }

# Epoch seconds of an RDS timestamp ("2026-09-28T08:15:00Z", "…+00:00", "….123Z").
epoch() {
	jq -rn --arg t "$1" '$t | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601'
}

ERRFILE=$(mktemp)
trap 'rm -f "$ERRFILE"' EXIT
# The instance's description as one JSON line, or nothing if there is no such
# instance. Any other failure (an expired SSO session, throttling) is fatal:
# read as "not there" it would let a wait for a rename finish early.
describe() {
	local out
	if out=$("${AWS[@]}" rds describe-db-instances --db-instance-identifier "$1" 2> "$ERRFILE"); then
		jq -c '.DBInstances[0]' <<< "$out"
	elif grep -q DBInstanceNotFound "$ERRFILE"; then
		return 0
	else
		cat "$ERRFILE" >&2
		return 1
	fi
}

# Wait until the instance exists and the jq predicate on its description holds.
wait_for() {
	local id="$1" pred="$2" what="$3" start d
	note "wait until $id: $what"
	[ "$EXECUTE" = 1 ] || return 0
	start=$(date +%s)
	while :; do
		d=$(describe "$id")
		if [ -n "$d" ] && jq -e "$pred" <<< "$d" > /dev/null; then return 0; fi
		[ $(( $(date +%s) - start )) -lt "$TIMEOUT" ] || die "timed out waiting for $id: $what"
		sleep "$POLL"
	done
}
wait_available() { wait_for "$1" '.DBInstanceStatus == "available"' "status available"; }
wait_gone() {
	local id="$1" start d
	note "wait until no instance is called $id"
	[ "$EXECUTE" = 1 ] || return 0
	start=$(date +%s)
	while :; do
		d=$(describe "$id")
		[ -n "$d" ] || return 0
		[ $(( $(date +%s) - start )) -lt "$TIMEOUT" ] || die "timed out waiting for $id to be renamed"
		sleep "$POLL"
	done
}

# --- 1. Preflight (read only) ------------------------------------------------------------
if [ "$EXECUTE" = 1 ]; then note "EXECUTE: commands below run against AWS."; else note "DRY RUN: nothing below changes anything (--execute to run it). Read-only calls run."; fi

caller=$("${AWS[@]}" sts get-caller-identity) || die "no AWS session for profile $PROFILE (aws sso login --profile $PROFILE)."
note "account $(jq -r .Account <<< "$caller") as $(jq -r .Arn <<< "$caller")"

tf_out() {
	local v
	v=$("${TF[@]}" output -raw "$1" 2> /dev/null) || die "terraform output $1 is missing: run terraform init (backend.config) in $INFRA_DIR, and apply the Terraform that defines it."
	[ -n "$v" ] || die "terraform output $1 is empty."
	printf '%s' "$v"
}
TF_REGION=$(tf_out aws_region)
[ "$TF_REGION" = "$REGION" ] || die "--region $REGION is not the stack's region ($TF_REGION)."
ID=$(tf_out db_instance_identifier)
SUBNET_GROUP=$(tf_out db_subnet_group_name)
SECURITY_GROUP=$(tf_out db_security_group_id)
PARAM_GROUP=$(tf_out db_parameter_group_name)
MIGRATE_FN=$(tf_out migrate_function_name)
TARGET="$ID-restore-$TS"
OLD="$ID-old-$TS"
[ "${#OLD}" -le 63 ] && [ "${#TARGET}" -le 63 ] || die "identifier too long for RDS (63 characters): $TARGET"

SRC=$(describe "$ID")
[ -n "$SRC" ] || die "no instance $ID in $REGION. A deleted instance is restored from its retained automated backups; see docs/deployment.md § Restoring the database."
src() { jq -rc "$1" <<< "$SRC"; }
[ "$(src .DBInstanceStatus)" = available ] \
	|| die "$ID is '$(src .DBInstanceStatus)', not available: the swap renames it. See docs/deployment.md § Restoring the database for an instance that won't come back."
for existing in "$TARGET" "$OLD"; do
	d=$(describe "$existing")
	[ -z "$d" ] || die "an instance called $existing already exists."
done

[ "$(src .DBSubnetGroup.DBSubnetGroupName)" = "$SUBNET_GROUP" ] || note "WARNING: $ID's subnet group is $(src .DBSubnetGroup.DBSubnetGroupName), Terraform's is $SUBNET_GROUP (the restore uses Terraform's)."
[ "$(src '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(",")')" = "$SECURITY_GROUP" ] || note "WARNING: $ID's security groups differ from Terraform's $SECURITY_GROUP (the restore uses Terraform's)."
[ "$(src '.DBParameterGroups[0].DBParameterGroupName')" = "$PARAM_GROUP" ] || note "WARNING: $ID's parameter group differs from Terraform's $PARAM_GROUP (the restore uses Terraform's)."

LATEST_TIME=$(src .LatestRestorableTime)
if [ -n "$SNAPSHOT" ]; then
	snap=$("${AWS[@]}" rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT" | jq -c '.DBSnapshots[0]') || die "no snapshot $SNAPSHOT in $REGION (the AWS error is above)."
	[ "$(jq -r .Status <<< "$snap")" = available ] || die "snapshot $SNAPSHOT is '$(jq -r .Status <<< "$snap")', not available."
	[ "$(jq -r .Encrypted <<< "$snap")" = true ] || die "snapshot $SNAPSHOT is not encrypted; refusing to restore it into production."
	[ "$(jq -r .DBInstanceIdentifier <<< "$snap")" = "$ID" ] || note "WARNING: snapshot $SNAPSHOT was taken of $(jq -r .DBInstanceIdentifier <<< "$snap"), not $ID."
	note "restore point: snapshot $SNAPSHOT taken $(jq -r .SnapshotCreateTime <<< "$snap"); everything written after it is lost."
else
	backups=$("${AWS[@]}" rds describe-db-instance-automated-backups --dbi-resource-id "$(src .DbiResourceId)")
	EARLIEST_TIME=$(jq -r '.DBInstanceAutomatedBackups[0].RestoreWindow.EarliestTime // empty' <<< "$backups")
	[ -n "$EARLIEST_TIME" ] && [ -n "$LATEST_TIME" ] && [ "$LATEST_TIME" != null ] \
		|| die "$ID has no restore window (automated backups off?)."
	note "restore window: $EARLIEST_TIME … $LATEST_TIME (retention $(src .BackupRetentionPeriod) days)"
	if [ "$LATEST" = 1 ]; then
		note "restore point: the latest restorable time; RPO ~5 minutes (RDS ships transaction logs every five minutes)."
	else
		t=$(epoch "$RESTORE_TIME")
		[ "$t" -ge "$(epoch "$EARLIEST_TIME")" ] || die "$RESTORE_TIME is before the earliest restorable time $EARLIEST_TIME."
		[ "$t" -le "$(epoch "$LATEST_TIME")" ] || die "$RESTORE_TIME is after the latest restorable time $LATEST_TIME (retry in a few minutes, or use --latest)."
		note "restore point: $RESTORE_TIME"
	fi
fi

# --- 2. Restore ---------------------------------------------------------------------------
STAGE="restore"
common=(
	--db-subnet-group-name "$SUBNET_GROUP"
	--vpc-security-group-ids "$SECURITY_GROUP"
	--db-parameter-group-name "$PARAM_GROUP"
	--no-publicly-accessible
	--deletion-protection
	--copy-tags-to-snapshot
	--db-instance-class "$(src .DBInstanceClass)"
	--ca-certificate-identifier "$(src .CACertificateIdentifier)"
	--backup-retention-period "$(src .BackupRetentionPeriod)"
	--preferred-backup-window "$(src .PreferredBackupWindow)"
	--tags "$(src '[.TagList[]? | {Key, Value}]')"
)
if [ "$(src .MultiAZ)" = true ]; then common+=(--multi-az); else common+=(--no-multi-az); fi
if [ "$(src .AutoMinorVersionUpgrade)" = true ]; then common+=(--auto-minor-version-upgrade); else common+=(--no-auto-minor-version-upgrade); fi
# Not passed, on purpose: log exports (turned on after the swap, so the
# temporary identifier doesn't create a never-expiring log group), monitoring
# and Performance Insights (a restore has no such parameters; both stay off,
# as rds.tf has them), storage type and encryption (inherited from the backup).
MAX_STORAGE=$(src '.MaxAllocatedStorage // empty')

note "restore into $TARGET (the stack's subnet group, security group and parameter group)"
if [ -n "$SNAPSHOT" ]; then
	act "${AWS[@]}" rds restore-db-instance-from-db-snapshot \
		--db-snapshot-identifier "$SNAPSHOT" --db-instance-identifier "$TARGET" "${common[@]}"
else
	point=(--use-latest-restorable-time)
	[ "$LATEST" = 1 ] || point=(--restore-time "$RESTORE_TIME")
	storage=()
	[ -z "$MAX_STORAGE" ] || storage=(--max-allocated-storage "$MAX_STORAGE")
	act "${AWS[@]}" rds restore-db-instance-to-point-in-time \
		--source-db-instance-identifier "$ID" --target-db-instance-identifier "$TARGET" \
		"${point[@]}" "${common[@]}" "${storage[@]}"
fi
wait_available "$TARGET"

# --- 3. RDS-managed master credentials ----------------------------------------------------
note "a PostgreSQL restore comes up without RDS-managed master credentials; turn them on (new secret, new ARN)"
modify=(--manage-master-user-password --preferred-maintenance-window "$(src .PreferredMaintenanceWindow)")
# A snapshot restore takes no autoscaling ceiling; set it here.
[ -z "$SNAPSHOT" ] || [ -z "$MAX_STORAGE" ] || modify+=(--max-allocated-storage "$MAX_STORAGE")
act "${AWS[@]}" rds modify-db-instance --db-instance-identifier "$TARGET" "${modify[@]}" --apply-immediately
wait_for "$TARGET" '.DBInstanceStatus == "available" and .MasterUserSecret.SecretStatus == "active"' "available, master secret active"

# --- 4. Verify before touching production -------------------------------------------------
STAGE="verify"
note "check $TARGET: network, parameter group, encryption + KMS key, deletion protection, CA, backups, monitoring, master secret"
if [ "$EXECUTE" = 1 ]; then
	got=$(describe "$TARGET")
	problems=$(jq -r \
		--arg subnet "$SUBNET_GROUP" --arg sg "$SECURITY_GROUP" --arg pg "$PARAM_GROUP" \
		--argjson src "$SRC" '
		[
			(select(.DBSubnetGroup.DBSubnetGroupName != $subnet) | "subnet group \(.DBSubnetGroup.DBSubnetGroupName), want \($subnet)"),
			(select([.VpcSecurityGroups[].VpcSecurityGroupId] != [$sg]) | "security groups \([.VpcSecurityGroups[].VpcSecurityGroupId] | join(",")), want \($sg)"),
			(select(.DBParameterGroups[0].DBParameterGroupName != $pg) | "parameter group \(.DBParameterGroups[0].DBParameterGroupName), want \($pg)"),
			(select(.StorageEncrypted != true) | "storage not encrypted"),
			(select(.KmsKeyId != $src.KmsKeyId) | "KMS key \(.KmsKeyId), want \($src.KmsKeyId)"),
			(select(.DeletionProtection != true) | "deletion protection off"),
			(select(.PubliclyAccessible != false) | "publicly accessible"),
			(select(.CACertificateIdentifier != $src.CACertificateIdentifier) | "CA \(.CACertificateIdentifier), want \($src.CACertificateIdentifier)"),
			(select(.BackupRetentionPeriod != $src.BackupRetentionPeriod) | "backup retention \(.BackupRetentionPeriod), want \($src.BackupRetentionPeriod)"),
			(select(.MonitoringInterval != $src.MonitoringInterval) | "monitoring interval \(.MonitoringInterval), want \($src.MonitoringInterval)"),
			(select(.MultiAZ != $src.MultiAZ) | "Multi-AZ \(.MultiAZ), want \($src.MultiAZ)"),
			(select(.DBInstanceClass != $src.DBInstanceClass) | "class \(.DBInstanceClass), want \($src.DBInstanceClass)"),
			(select(.MasterUserSecret.SecretStatus != "active") | "no active RDS-managed master secret")
		] | .[] | "  - " + .' <<< "$got")
	if [ -n "$problems" ]; then
		echo "restore-db: $TARGET does not match the stack; production is untouched:" >&2
		printf '%s\n' "$problems" >&2
		echo "Inspect it, then remove it: aws rds modify-db-instance --db-instance-identifier $TARGET --no-deletion-protection --apply-immediately --region $REGION --profile $PROFILE && aws rds delete-db-instance --db-instance-identifier $TARGET --skip-final-snapshot --region $REGION --profile $PROFILE" >&2
		exit 1
	fi
	note "OK"
fi

# --- 5. Swap identifiers ------------------------------------------------------------------
if [ "$EXECUTE" = 1 ] && [ "$ASSUME_YES" != 1 ]; then
	echo "Next: $ID goes offline (renamed to $OLD) and $TARGET takes its name. The API is down for a few minutes."
	printf 'Type %s to continue: ' "$ID"
	read -r answer < /dev/tty || die "no confirmation (use --yes to skip it)."
	[ "$answer" = "$ID" ] || die "not confirmed; $TARGET is left running beside $ID."
fi

on_exit() {
	local code=$?
	rm -f "$ERRFILE"
	[ "$code" -ne 0 ] && [ "$EXECUTE" = 1 ] || return 0
	case "$STAGE" in
		swap-old) echo "restore-db: stopped while renaming $ID. If $OLD exists and $ID doesn't, production is down: finish with the rename of $TARGET → $ID below, or put it back with: aws rds modify-db-instance --db-instance-identifier $OLD --new-db-instance-identifier $ID --apply-immediately --region $REGION --profile $PROFILE" >&2 ;;
		swap-new) echo "restore-db: stopped while renaming $TARGET → $ID. Finish with: aws rds modify-db-instance --db-instance-identifier $TARGET --new-db-instance-identifier $ID --apply-immediately --region $REGION --profile $PROFILE (then rerun the steps printed after it by a dry run)" >&2 ;;
		logs) echo "restore-db: the swap is done; turning on the log export failed. Rerun: aws rds modify-db-instance --db-instance-identifier $ID --cloudwatch-logs-export-configuration '{\"EnableLogTypes\":[\"postgresql\"]}' --apply-immediately --region $REGION --profile $PROFILE, then the terraform steps" >&2 ;;
		terraform) echo "restore-db: the swap is done; the Terraform step failed. If aws_db_instance.main is out of state, rerun: AWS_PROFILE=$PROFILE $SCRIPTS_DIR/tf.sh -chdir=$INFRA_DIR import -var-file=$VAR_FILE aws_db_instance.main $ID" >&2 ;;
	esac
}
trap on_exit EXIT

EXPORTS=$(src '.EnabledCloudwatchLogsExports // [] | tojson')
STAGE="swap-old"
if [ "$EXPORTS" != "[]" ]; then
	note "stop $ID's log export, so the renamed old instance doesn't start a new log group with no retention"
	act "${AWS[@]}" rds modify-db-instance --db-instance-identifier "$ID" \
		--cloudwatch-logs-export-configuration "{\"DisableLogTypes\":$EXPORTS}" --apply-immediately
	wait_for "$ID" '.DBInstanceStatus == "available" and ((.EnabledCloudwatchLogsExports // []) | length) == 0' "log export off"
fi
act "${AWS[@]}" rds modify-db-instance --db-instance-identifier "$ID" --new-db-instance-identifier "$OLD" --apply-immediately
wait_gone "$ID"
wait_available "$OLD"

STAGE="swap-new"
act "${AWS[@]}" rds modify-db-instance --db-instance-identifier "$TARGET" --new-db-instance-identifier "$ID" --apply-immediately
wait_gone "$TARGET"
wait_available "$ID"

STAGE="logs"
if [ "$EXPORTS" != "[]" ]; then
	act "${AWS[@]}" rds modify-db-instance --db-instance-identifier "$ID" \
		--cloudwatch-logs-export-configuration "{\"EnableLogTypes\":$EXPORTS}" --apply-immediately
	wait_for "$ID" '.DBInstanceStatus == "available" and ((.EnabledCloudwatchLogsExports // []) | length) > 0' "log export on"
fi

# --- 6. Terraform state -------------------------------------------------------------------
STAGE="terraform"
note "Terraform tracks aws_db_instance by DbiResourceId: move its state to the restored instance"
act "${TF[@]}" state rm aws_db_instance.main
act "${TFS[@]}" import -input=false "-var-file=$VAR_FILE" aws_db_instance.main "$ID"
note "plan (no -out: a plan file holds a copy of state, CloudFront header included). Expect in-place changes only."
show "${TFS[@]}" plan -input=false -no-color "-var-file=$VAR_FILE"
if [ "$EXECUTE" = 1 ]; then
	plan=$("${TFS[@]}" plan -input=false -no-color "-var-file=$VAR_FILE")
	printf '%s\n' "$plan"
	if grep -Eq 'must be replaced|will be destroyed' <<< "$plan"; then
		echo "restore-db: the plan replaces or destroys something. Do NOT apply it; work out why first (docs/deployment.md § Restoring the database)." >&2
		exit 2
	fi
fi
STAGE="done"

cat << EOF

Next, by hand, in this order:
  1. Review the plan above, then apply it (repoints the migrate Lambda and the Secrets Manager endpoint at the new master secret):
     AWS_PROFILE=$PROFILE $SCRIPTS_DIR/tf.sh -chdir=$INFRA_DIR apply -var-file=$VAR_FILE
  2. Run the migrate Lambda (applies migrations newer than the restore point, resets water_app's password):
     aws lambda invoke --function-name $MIGRATE_FN --cli-binary-format raw-in-base64-out --payload '{}' --cli-read-timeout 320 --region $REGION --profile $PROFILE /dev/stdout
  3. Re-apply erasures and revocations made after the restore point, before traffic is back (docs/deployment.md § Restoring the database, step 6a):
     the apply in step 1 put the API's and worker's concurrency back, so first set both to 0 again (aws lambda put-function-concurrency ...
     --reserved-concurrent-executions 0, as in the runbook's step 1); on $OLD, as the schema owner, read erasure_log and the audit_event
     removals and revocations since the restore point; delete and revoke them again on $ID in one transaction; then re-run the apply in
     step 1, which restores the concurrency, and invoke the worker once at once (its purges catch up; reserved concurrency 0 would throttle it).
  4. Check the site, and that the data is as of the restore point with the erasures re-applied.
  5. Only then delete the old instance ($OLD). Writes made after the restore point exist only there; export anything you need first. Its master secret goes with it:
     aws rds modify-db-instance --db-instance-identifier $OLD --no-deletion-protection --apply-immediately --region $REGION --profile $PROFILE
     aws rds delete-db-instance --db-instance-identifier $OLD --skip-final-snapshot --region $REGION --profile $PROFILE
     Only if you may need its post-restore-point data, take a final snapshot instead (--final-db-snapshot-identifier $OLD-final) and delete it
     within 30 days (it holds what was erased since the restore point and never expires); note the delete-by date in the operator log.
EOF
