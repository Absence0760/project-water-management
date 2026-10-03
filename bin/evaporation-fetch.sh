#!/usr/bin/env bash
# The evaporation grid's real data (issue #326 B-evap; docs/maps.md
# § Evaporation from the map): download dPET, the daily files of hPET
# (Singer et al. 2021, University of Bristol, CC BY 4.0; derived from
# ERA5-Land, docs/maps.md § Sources), one year at a time; cut each to the box
# and sum it into calendar-month totals (`import:evaporation --reduce`);
# delete the 2.4 GB year; then average the years into monthly means and load
# them into this checkout's database as the schema owner.
#
#   bin/evaporation-fetch.sh [first-year] [last-year]     default 1991 2020 (a 30-year normal)
#
# Operator-run, never in CI. Each year is about 2.4 GB to download; only its
# few-MB totals are kept (in ~/.cache/water-management-tiles/evaporation/),
# so a re-run skips the years already reduced. Needs the database up (pnpm
# dev:db:up). EVAP_BBOX (west,south,east,north; default South Africa,
# Lesotho and Eswatini), EVAP_DATASET (the label; default dPET-<first>-<last>)
# and EVAP_URL (the dataset's base URL) override it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FIRST="${1:-1991}"
LAST="${2:-2020}"
[[ "$FIRST" =~ ^(19|20)[0-9][0-9]$ && "$LAST" =~ ^(19|20)[0-9][0-9]$ && "$FIRST" -le "$LAST" ]] || { echo "usage: bin/evaporation-fetch.sh [first-year] [last-year] (1981 or later)" >&2; exit 2; }
BASE="${EVAP_URL:-https://data.bris.ac.uk/datasets/qb8ujazzda0s2aykkv0oq0ctp}"
BBOX="${EVAP_BBOX:-16,-35.2,33.2,-22}"
DATASET="${EVAP_DATASET:-dPET-$FIRST-$LAST}"
# Checked before use: HTTPS only (redirects too), a numeric box, a plain label.
NUM='-?[0-9]+(\.[0-9]+)?'
[[ "$BASE" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[^[:space:]]*$ ]] || { echo "EVAP_URL must be an https:// URL (got: $BASE)" >&2; exit 2; }
[[ "$BBOX" =~ ^$NUM,$NUM,$NUM,$NUM$ ]] || { echo "EVAP_BBOX must be west,south,east,north in degrees (got: $BBOX)" >&2; exit 2; }
[[ "$DATASET" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,49}$ ]] || { echo "EVAP_DATASET must be 1-50 letters, digits, spaces, dots, dashes or underscores (got: $DATASET)" >&2; exit 2; }
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/water-management-tiles/evaporation"
mkdir -p "$CACHE"

years=()
for ((y = FIRST; y <= LAST; y++)); do
	out="$CACHE/$y.dpet-monthly.json"
	years+=("$out")
	[ -f "$out" ] && { echo "$y: already reduced"; continue; }
	nc="$CACHE/${y}_daily_pet.nc"
	if [ ! -f "$nc" ]; then
		echo "$y: downloading ${y}_daily_pet.nc (about 2.4 GB) …"
		curl --proto '=https' --proto-redir '=https' -fSL -C - -o "$nc.part" "$BASE/${y}_daily_pet.nc"
		mv "$nc.part" "$nc"
	fi
	# No published checksum: held to bin/source-checksums.sha256, recorded on the first fetch (docs/maps.md § Checksums).
	node "$ROOT/scripts/guards/source_checksums.mjs" "$nc"
	(cd "$ROOT/backend" && pnpm exec tsx scripts/import-evaporation.ts --reduce "$CACHE" "$nc" --bbox "$BBOX")
	rm -f "$nc"
done

(cd "$ROOT/backend" && pnpm exec tsx scripts/import-evaporation.ts "${years[@]}" --dataset "$DATASET")
echo "Now: Settings → Flow calibration → Evaporation from the map."
