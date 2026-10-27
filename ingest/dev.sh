#!/usr/bin/env bash
# The bulk ingest job on this machine (ingest/README.md):
#
#   pnpm dev:ingest:run [rnl|sat|era5l|imerg_late]
#                                   run the Lambda handler once in fixtures mode
#                                   (synthetic files and fake upstreams, no network) into
#                                   MIRROR_URL, default file://<repo>/ingest/.mirror (gitignored):
#                                   rnl, sat and era5l a monthly run (era5l's first run
#                                   submits to the fake CDS, the next collects), imerg_late
#                                   a recent run (the last ten days from the fake Earthdata)
#   pnpm test:ingest                the package's unittest suite
#   ingest/dev.sh verify [args]     verify_copy.py: check a backfilled copy at
#                                   MIRROR_URL against CHC and dynamical.org
#                                   (the operator, before the cutover)
#
# run and test use ingest/.venv (gitignored), created on first use from the
# hash-pinned requirements.txt and refreshed whenever that file changes;
# verify uses ingest/.venv-verify from requirements-verify.txt the same way.
# Needs Python 3.14 (PYTHON=<interpreter> to pick another). Optional tooling,
# like gen:help-art: pnpm dev, CI's other jobs and e2e never need Python.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$here/.venv"
py="${PYTHON:-python3.14}"

ensure_venv() {
	local venv="${1:-$venv}" req="${2:-$here/requirements.txt}"
	if [ -x "$venv/bin/python" ] && cmp -s "$req" "$venv/.requirements.txt"; then return; fi
	if ! command -v "$py" >/dev/null; then
		echo "ingest: $py not found; install Python 3.14 or set PYTHON=<interpreter>" >&2
		exit 1
	fi
	echo "ingest: installing $req into $venv" >&2
	"$py" -m venv "$venv"
	"$venv/bin/python" -m pip install --quiet --require-hashes -r "$req"
	cp "$req" "$venv/.requirements.txt"
}

case "${1:-}" in
run)
	product="${2:-rnl}"
	case "$product" in
	rnl | sat | era5l) mode=monthly ;;
	imerg_late) mode=recent ;;
	*)
		echo "ingest: dev:ingest:run runs rnl, sat, era5l or imerg_late, not $product" >&2
		exit 2
		;;
	esac
	export FEED_SOURCE=fixtures
	export MIRROR_URL="${MIRROR_URL:-file://$here/.mirror}"
	case "$MIRROR_URL" in
	file:///*) ;;
	*)
		echo "ingest: dev:ingest:run writes only to a local copy (MIRROR_URL=file:///abs/path), not $MIRROR_URL" >&2
		exit 1
		;;
	esac
	ensure_venv
	cd "$here"
	exec "$venv/bin/python" -c 'import json, logging, sys
import lambda_handler
logging.basicConfig(level=logging.INFO, format="%(message)s")
print(json.dumps(lambda_handler.handler({"product": sys.argv[1], "mode": sys.argv[2]}), indent=2))' "$product" "$mode"
	;;
test)
	ensure_venv
	cd "$here"
	exec "$venv/bin/python" -m unittest discover -s "$here"
	;;
verify)
	shift
	ensure_venv "$here/.venv-verify" "$here/requirements-verify.txt"
	exec "$here/.venv-verify/bin/python" "$here/verify_copy.py" "$@"
	;;
*)
	echo "usage: ingest/dev.sh run [rnl|sat|era5l|imerg_late] | test | verify [verify_copy.py args]" >&2
	exit 2
	;;
esac
