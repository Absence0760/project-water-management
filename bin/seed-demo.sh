#!/usr/bin/env bash
# Seed a local demo: the invented example catchments (always), plus the client
# workbook when present (extracted into data/, gitignored), imported with one
# model run. The workbook is $WBT_CLIENT_WORKBOOK, or else the one b023 workbook
# in $WBT_SOURCE_DIR/Original/ that isn't the Blank sample. Its file name names
# the client, so it is never written into the repo.
#
#   pnpm seed:demo            # uses $PYTHON or python3 with openpyxl installed
#
# Local dev only — the demo password is not a secret and the user only exists
# in your docker Postgres.
#
# The client workbook's gauge column is a neighbouring river's gauge, so it is
# imported with --gauge-as-reference (a flow_reference_m3s series, never a
# calibration record; docs/model.md §2.10) into data/client-catchment-app/.
# data/client-catchment/ stays the workbook-faithful extraction the engine's
# regression tests read. The column is area-scaled for part of the record; to
# undo that, set WBT_GAUGE_SCALING_FROM (YYYY-MM-DD) and WBT_GAUGE_SCALE_FACTOR,
# in the environment or in $WBT_SOURCE_DIR/wbt-import.env (outside the repo,
# because the factor is client data). Set WBT_GAUGE_AS_REFERENCE=0 to import the
# column as observed flow instead.
set -euo pipefail
cd "$(dirname "$0")/.."

# Must match backend/scripts/seed-examples.ts (DEMO).
EMAIL="${DEMO_EMAIL:-demo@example.com}"
PASSWORD="${DEMO_PASSWORD:-demo-password}"
PY="${PYTHON:-python3}"
# Client workbooks live OUTSIDE the repo (never committed): by default in a
# sibling folder, ../project-water-management-source/{Original,AI}/.
WBT_SOURCE_DIR="${WBT_SOURCE_DIR:-../project-water-management-source}"

# Per-workbook import options (the gauge scaling), kept beside the workbooks.
if [ -f "$WBT_SOURCE_DIR/wbt-import.env" ]; then
	# shellcheck disable=SC1091
	. "$WBT_SOURCE_DIR/wbt-import.env"
fi

# The importer's own code: an extraction made by an older importer has an
# older project.json shape (e.g. returnFlowPct before engine 0.16.0), so a
# change here re-extracts too.
importer_hash() {
	cat scripts/wbt-import/extract_project.py scripts/wbt-import/calibration.py | sha256sum | cut -c1-16
}

extract() { # <workbook> <outdir> [extract_project.py options…]
	local wb="$1" out="$2"
	shift 2
	# Re-extract when the options or the importer changed since the last extraction.
	local stamp="$out/.import-args" args="$* importer=$(importer_hash)"
	if [ -f "$out/project.json" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$args" ]; then
		echo "✓ $out/project.json already extracted"
	elif [ -f "$wb" ]; then
		echo "→ extracting $wb $args (large workbooks take a minute)…"
		"$PY" scripts/wbt-import/extract_project.py "$wb" "$out" "$@"
		printf '%s' "$args" >"$stamp"
	else
		echo "✗ $wb not found — skipping" >&2
		return 1
	fi
}

# Invented example catchments + demo users (no client data needed).
pnpm -s seed:examples

if ! "$PY" -c 'import openpyxl' 2>/dev/null; then
	echo "openpyxl missing for $PY — skipping client workbooks (see scripts/wbt-import/README.md, or set PYTHON=/path/to/venv/bin/python)" >&2
	exit 0
fi

# The client workbook: explicit, or the only non-Blank b023 workbook in Original/.
WORKBOOK="${WBT_CLIENT_WORKBOOK:-}"
if [ -z "$WORKBOOK" ]; then
	shopt -s nullglob
	candidates=()
	for f in "$WBT_SOURCE_DIR"/Original/*_WBT_b023_*.xlsm; do
		case "$(basename "$f")" in Blank_*) ;; *) candidates+=("$f") ;; esac
	done
	shopt -u nullglob
	if [ "${#candidates[@]}" -gt 1 ]; then
		echo "✗ ${#candidates[@]} client workbooks in $WBT_SOURCE_DIR/Original/ — set WBT_CLIENT_WORKBOOK to pick one" >&2
		exit 1
	fi
	WORKBOOK="${candidates[0]:-$WBT_SOURCE_DIR/Original/<client workbook>.xlsm}"
fi

gauge_args=()
if [ "${WBT_GAUGE_AS_REFERENCE:-1}" = 1 ]; then
	gauge_args+=(--gauge-as-reference)
	if [ -n "${WBT_GAUGE_SCALING_FROM:-}" ] || [ -n "${WBT_GAUGE_SCALE_FACTOR:-}" ]; then
		gauge_args+=(--gauge-scaling-from "${WBT_GAUGE_SCALING_FROM:-}" --gauge-scale-factor "${WBT_GAUGE_SCALE_FACTOR:-}")
	else
		echo "! WBT_GAUGE_SCALING_FROM / WBT_GAUGE_SCALE_FACTOR unset: the reference gauge keeps the workbook's partial area scaling" >&2
	fi
fi

imported=0
if extract "$WORKBOOK" data/client-catchment-app "${gauge_args[@]}"; then
	pnpm -s import:project "$PWD/data/client-catchment-app/project.json" --email "$EMAIL" --password "$PASSWORD" --name "Client Catchment" --run
	imported=$((imported + 1))
fi
echo
echo "Imported $imported project(s). Sign in at http://localhost:7777 as $EMAIL / $PASSWORD"
