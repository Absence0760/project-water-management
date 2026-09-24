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
set -euo pipefail
cd "$(dirname "$0")/.."

# Must match backend/scripts/seed-examples.ts (DEMO).
EMAIL="${DEMO_EMAIL:-demo@example.com}"
PASSWORD="${DEMO_PASSWORD:-demo-password}"
PY="${PYTHON:-python3}"
# Client workbooks live OUTSIDE the repo (never committed): by default in a
# sibling folder, ../project-water-management-source/{Original,AI}/.
WBT_SOURCE_DIR="${WBT_SOURCE_DIR:-../project-water-management-source}"

extract() { # <workbook> <outdir>
	if [ -f "$2/project.json" ]; then
		echo "✓ $2/project.json already extracted"
	elif [ -f "$1" ]; then
		echo "→ extracting $1 (large workbooks take a minute)…"
		"$PY" scripts/wbt-import/extract_project.py "$1" "$2"
	else
		echo "✗ $1 not found — skipping" >&2
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

imported=0
if extract "$WORKBOOK" data/client-catchment; then
	pnpm -s import:project "$PWD/data/client-catchment/project.json" --email "$EMAIL" --password "$PASSWORD" --name "Client Catchment" --run
	imported=$((imported + 1))
fi
echo
echo "Imported $imported project(s). Sign in at http://localhost:7777 as $EMAIL / $PASSWORD"
