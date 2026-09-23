#!/usr/bin/env bash
# Seed a local demo: the invented example catchments (always), plus the client
# catchment client workbook from Original/ when present (extracted into data/,
# gitignored), imported with one model run.
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

imported=0
if extract "Original/Client_WBT_b023_v001_20260407_WORKING 007.xlsm" data/client-catchment; then
	pnpm -s import:project "$PWD/data/client-catchment/project.json" --email "$EMAIL" --password "$PASSWORD" --name "Client Catchment" --run
	imported=$((imported + 1))
fi
echo
echo "Imported $imported project(s). Sign in at http://localhost:7777 as $EMAIL / $PASSWORD"
