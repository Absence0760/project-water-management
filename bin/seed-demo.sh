#!/usr/bin/env bash
# Seed a local demo: the invented example catchments (always), plus each client
# workbook present (extracted into data/, gitignored), imported as its own
# project with one model run. The workbooks are $WBT_CLIENT_WORKBOOK alone, or
# else every b023 workbook in $WBT_SOURCE_DIR/Original/ that isn't the Blank
# sample. Their file names name the clients, so they are never written into
# the repo: project names and data/ folders are derived at run time.
#
#   pnpm seed:demo            # uses $PYTHON, else .venv/bin/python, else python3 (needs openpyxl)
#   pnpm seed:demo:fixed      # the same, from the fixed workbooks instead (--fixed)
#
# --fixed imports each fixed workbook in $WBT_SOURCE_DIR/Fixed/workbooks/
# (*_WBT_b023_*_FIXED_recalculated.xlsx: the client workbook with the review's
# formula fixes, recalculated so its cells hold computed values; the source
# repo's Fixed/README.md) instead of Original/, as "<Name> (fixed)" into
# data/client-<name>-fixed-app/, beside the originals. The per-workbook
# settings below apply to both. The app reads only the workbook's inputs and
# recomputes everything, so the two load almost the same model; what differs
# is what a fix changed in the inputs themselves (a client decision such as a
# later record start).
#
# Local dev only — the demo password is not a secret and the user only exists
# in your docker Postgres.
#
# By default the workbook's gauge column is imported with --gauge-as-reference
# (a flow_reference_m3s series, never a calibration record; docs/model.md
# §2.10), the cautious choice when a gauge column may measure elsewhere, into
# data/client-<prefix>-app/. data/client-catchment/ stays the
# workbook-faithful extraction the engine's regression tests read. If a
# column was rescaled for part of its record, undo that with
# WBT_GAUGE_SCALING_FROM (YYYY-MM-DD) and WBT_GAUGE_SCALE_FACTOR in
# $WBT_SOURCE_DIR/wbt-import.<prefix>.env, <prefix> being the workbook's file
# name before _WBT_b023 (outside the repo, because the factor is client data;
# the shared wbt-import.env still applies to every workbook). Set
# WBT_GAUGE_AS_REFERENCE=0 there to import the column as observed flow instead.
# WBT_RUN_OF_RIVER=1 there imports the units the importer flags as probable
# run-of-river (a dummy dam or no dam taking all the upstream inflow) with the
# run-of-river supply rule and no dam (extract_project.py --run-of-river,
# issue #54 2c/2d); off by default, since the modeller confirms each unit.
# WBT_SETTINGS=<file> there applies a settings patch (a JSON object, validated
# like a PATCH of the project's settings; a path relative to $WBT_SOURCE_DIR)
# before the import, e.g. an areal rainfall correction, a calibration window
# and flow series; WBT_FIT=1 then fits GR4J to the calibration record and
# stores the fit, as Settings -> Fit automatically -> Apply does, so the
# initial run is the calibrated project (import-project.ts --settings / --fit,
# docs/model.md §2.10b "Fit at import"). WBT_TRANSFERS=<file> there applies a
# transfer patch (a JSON list of { from, to, set } naming rules by their end
# nodes; import-project.ts --transfers) before the fit, for what the workbook
# doesn't hold, e.g. switching a canal off-take on at an agreed capacity
# (docs/model.md §2.6a). A project already imported under the
# same name is left alone: delete it (or rename it) in the app to import it
# again with a changed setting.
set -euo pipefail
cd "$(dirname "$0")/.."

FIXED=0
for arg in "$@"; do
	case "$arg" in
	--fixed) FIXED=1 ;;
	*) echo "usage: $0 [--fixed]" >&2; exit 2 ;;
	esac
done

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
# workbook in Original/ that isn't the Blank template (with --fixed, every
# fixed workbook in Fixed/workbooks/). Each becomes its own project, named
# from its file name (the part before _WBT_b023, CamelCase split:
# "SomeRiver_WBT_b023_…" → "Some River", plus " (fixed)" with --fixed), at
# run time only.
if [ "$FIXED" = 1 ]; then
	folder="Fixed/workbooks"
	pattern="*_WBT_b023_*_FIXED_recalculated.xlsx"
else
	folder="Original"
	pattern="*_WBT_b023_*.xlsm"
fi
shopt -s nullglob
if [ -n "${WBT_CLIENT_WORKBOOK:-}" ]; then
	workbooks=("$WBT_CLIENT_WORKBOOK")
else
	workbooks=()
	for f in "$WBT_SOURCE_DIR/$folder"/$pattern; do
		case "$(basename "$f")" in Blank_*) ;; *) workbooks+=("$f") ;; esac
	done
fi
shopt -u nullglob
if [ "${#workbooks[@]}" -eq 0 ]; then
	echo "✗ no client workbook in $WBT_SOURCE_DIR/$folder/ — skipping" >&2
fi

imported=0
for wb in "${workbooks[@]}"; do
	prefix=$(basename "$wb" | sed 's/_WBT_b023.*//')
	slug=$(printf '%s' "$prefix" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')
	name=$(printf '%s' "$prefix" | sed 's/\([a-z]\)\([A-Z]\)/\1 \2/g')
	suffix=""
	if [ "$FIXED" = 1 ]; then
		name="$name (fixed)"
		suffix="-fixed"
	fi
	# Per-workbook import settings (the gauge scaling), beside the workbooks:
	# $WBT_SOURCE_DIR/wbt-import.<prefix>.env, read in a subshell so one
	# workbook's settings never reach the next.
	(
		if [ -f "$WBT_SOURCE_DIR/wbt-import.$prefix.env" ]; then
			# shellcheck disable=SC1090
			. "$WBT_SOURCE_DIR/wbt-import.$prefix.env"
		fi
		import_args=()
		if [ "${WBT_GAUGE_AS_REFERENCE:-1}" = 1 ]; then
			import_args+=(--gauge-as-reference)
			if [ -n "${WBT_GAUGE_SCALING_FROM:-}" ] || [ -n "${WBT_GAUGE_SCALE_FACTOR:-}" ]; then
				import_args+=(--gauge-scaling-from "${WBT_GAUGE_SCALING_FROM:-}" --gauge-scale-factor "${WBT_GAUGE_SCALE_FACTOR:-}")
			fi
		fi
		# Probable run-of-river units as run of river (issue #54, 2c/2d), when this workbook's settings ask for it.
		if [ "${WBT_RUN_OF_RIVER:-0}" = 1 ]; then
			import_args+=(--run-of-river)
		fi
		out="data/client-$slug$suffix-app"
		extract "$wb" "$out" "${import_args[@]}" || exit 1
		# A settings patch and a fit, applied to the document before it is imported (never to data/).
		project_args=()
		if [ -n "${WBT_SETTINGS:-}" ]; then
			case "$WBT_SETTINGS" in
			/*) patch="$WBT_SETTINGS" ;;
			*) patch="$(cd "$WBT_SOURCE_DIR" && pwd)/$WBT_SETTINGS" ;;
			esac
			[ -f "$patch" ] || { echo "✗ WBT_SETTINGS file $patch not found" >&2; exit 1; }
			project_args+=(--settings "$patch")
		fi
		if [ -n "${WBT_TRANSFERS:-}" ]; then
			case "$WBT_TRANSFERS" in
			/*) tpatch="$WBT_TRANSFERS" ;;
			*) tpatch="$(cd "$WBT_SOURCE_DIR" && pwd)/$WBT_TRANSFERS" ;;
			esac
			[ -f "$tpatch" ] || { echo "✗ WBT_TRANSFERS file $tpatch not found" >&2; exit 1; }
			project_args+=(--transfers "$tpatch")
		fi
		if [ "${WBT_FIT:-0}" = 1 ]; then
			project_args+=(--fit)
		fi
		# A project the demo user already has under this name is left alone, so the seed can run again.
		pnpm -s import:project "$PWD/$out/project.json" --email "$EMAIL" --password "$PASSWORD" --name "$name" --run --skip-existing "${project_args[@]}"
	) && imported=$((imported + 1))
done
echo
echo "Client projects ready: $imported. Sign in at http://localhost:7777 as $EMAIL / $PASSWORD"
