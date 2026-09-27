#!/usr/bin/env bash
# Seed a local demo: the invented example catchments (always), plus each client
# workbook present (extracted into data/, gitignored), imported as its own
# project with one model run. The workbooks are $WBT_CLIENT_WORKBOOK alone, or
# else every b023 workbook in $WBT_SOURCE_DIR/Original/ that isn't the Blank
# sample. Their file names name the clients, so they are never written into
# the repo: project names and data/ folders are derived at run time.
#
#   pnpm seed:demo            # uses $PYTHON, else .venv/bin/python, else python3 (needs openpyxl)
#
# Local dev only — the demo password is not a secret and the user only exists
# in your docker Postgres.
#
# By default the workbook's gauge column is imported with --gauge-as-reference
# (a flow_reference_m3s series, never a calibration record; docs/model.md
# §2.10), for a workbook whose gauge sits on a neighbouring river, into
# data/client-<prefix>-app/. data/client-catchment/ stays the
# workbook-faithful extraction the engine's regression tests read. If the
# column is area-scaled for part of the record, undo that with
# WBT_GAUGE_SCALING_FROM (YYYY-MM-DD) and WBT_GAUGE_SCALE_FACTOR in
# $WBT_SOURCE_DIR/wbt-import.<prefix>.env, <prefix> being the workbook's file
# name before _WBT_b023 (outside the repo, because the factor is client data;
# the shared wbt-import.env still applies to every workbook). Set
# WBT_GAUGE_AS_REFERENCE=0 there to import the column as observed flow instead.
set -euo pipefail
cd "$(dirname "$0")/.."

# Must match backend/scripts/seed-examples.ts (DEMO).
EMAIL="${DEMO_EMAIL:-demo@example.com}"
PASSWORD="${DEMO_PASSWORD:-demo-password}"
# Python with openpyxl: $PYTHON, else the checkout's .venv (scripts/wbt-import/README.md), else python3.
if [ -n "${PYTHON:-}" ]; then
	PY="$PYTHON"
elif [ -x .venv/bin/python ]; then
	PY=.venv/bin/python
else
	PY=python3
fi
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

# The client workbooks: $WBT_CLIENT_WORKBOOK alone if set, else every b023
# workbook in Original/ that isn't the Blank template. Each becomes its own
# project, named from its file name (the part before _WBT_b023, CamelCase
# split: "SomeRiver_WBT_b023_…" → "Some River"), at run time only.
shopt -s nullglob
if [ -n "${WBT_CLIENT_WORKBOOK:-}" ]; then
	workbooks=("$WBT_CLIENT_WORKBOOK")
else
	workbooks=()
	for f in "$WBT_SOURCE_DIR"/Original/*_WBT_b023_*.xlsm; do
		case "$(basename "$f")" in Blank_*) ;; *) workbooks+=("$f") ;; esac
	done
fi
shopt -u nullglob
if [ "${#workbooks[@]}" -eq 0 ]; then
	echo "✗ no client workbook in $WBT_SOURCE_DIR/Original/ — skipping" >&2
fi

imported=0
for wb in "${workbooks[@]}"; do
	prefix=$(basename "$wb" | sed 's/_WBT_b023.*//')
	slug=$(printf '%s' "$prefix" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')
	name=$(printf '%s' "$prefix" | sed 's/\([a-z]\)\([A-Z]\)/\1 \2/g')
	# Per-workbook import settings (the gauge scaling), beside the workbooks:
	# $WBT_SOURCE_DIR/wbt-import.<prefix>.env, read in a subshell so one
	# workbook's settings never reach the next.
	(
		if [ -f "$WBT_SOURCE_DIR/wbt-import.$prefix.env" ]; then
			# shellcheck disable=SC1090
			. "$WBT_SOURCE_DIR/wbt-import.$prefix.env"
		fi
		gauge_args=()
		if [ "${WBT_GAUGE_AS_REFERENCE:-1}" = 1 ]; then
			gauge_args+=(--gauge-as-reference)
			if [ -n "${WBT_GAUGE_SCALING_FROM:-}" ] || [ -n "${WBT_GAUGE_SCALE_FACTOR:-}" ]; then
				gauge_args+=(--gauge-scaling-from "${WBT_GAUGE_SCALING_FROM:-}" --gauge-scale-factor "${WBT_GAUGE_SCALE_FACTOR:-}")
			fi
		fi
		out="data/client-$slug-app"
		extract "$wb" "$out" "${gauge_args[@]}" || exit 1
		# A project the demo user already has under this name is left alone, so the seed can run again.
		pnpm -s import:project "$PWD/$out/project.json" --email "$EMAIL" --password "$PASSWORD" --name "$name" --run --skip-existing
	) && imported=$((imported + 1))
done
echo
echo "Client projects ready: $imported. Sign in at http://localhost:7777 as $EMAIL / $PASSWORD"
