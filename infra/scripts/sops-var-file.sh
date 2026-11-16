# Sourced by tf.sh, preapply-check.sh and postapply-check.sh (not run).
#
# The production var file lives sops-encrypted, in sops' binary format, as
# infra-secrets/water-management/prod.tfvars.sops. A var file whose name ends
# in .sops is decrypted (kms:Decrypt through the caller's AWS credentials,
# e.g. AWS_PROFILE=water-management) to a 0600 file in a private temporary
# directory outside the repo, named without the .sops suffix (prod.tfvars),
# and that path is used in its place. The caller owns the directory and
# removes it on exit. Plaintext var files pass through unchanged.
#
# Edit the encrypted file in place:
#   AWS_PROFILE=water-management sops ~/github/infra-secrets/water-management/prod.tfvars.sops

# sops_var_file <file> <dir>: print the path to read <file> from. A *.sops
# file is decrypted into a new subdirectory of <dir> (one per file, so two
# var files with the same name don't collide); nothing of it is printed.
sops_var_file() {
	local src="$1" dir="$2" name sub
	case "$src" in
	*.sops) ;;
	*)
		printf '%s\n' "$src"
		return 0
		;;
	esac
	[ -f "$src" ] || { echo "${0##*/}: no such var file: $src" >&2; return 1; }
	command -v sops > /dev/null || { echo "${0##*/}: sops not found on PATH; it decrypts $src" >&2; return 1; }
	name="${src##*/}"
	name="${name%.sops}"
	sub="$(umask 077 && mktemp -d "$dir/var-file.XXXXXX")" || return 1
	if ! (umask 077 && sops --decrypt --input-type binary --output-type binary "$src" > "$sub/$name"); then
		echo "${0##*/}: could not decrypt $src (an AWS session that may use alias/water-management-sops: AWS_PROFILE=water-management)" >&2
		return 1
	fi
	printf '%s\n' "$sub/$name"
}
