#!/usr/bin/env bash
# Render the /help landing illustration (scripts/help-art/catchment.py) and
# write what the page reads:
#   frontend/static/help/catchment-{1600,800}.webp   the picture, transparent
#   frontend/src/lib/help/catchment-hotspots.json    where each hotspot sits
#
#   pnpm gen:help-art                  # GPU (OptiX); HELP_ART_DEVICE=CUDA|CPU to change
#
# Optional tooling, not needed to run or build the app: needs Blender 5.x and
# ImageMagick 7 (`magick`). The output is committed, so only re-run it after
# changing the scene. Blender is capped at 3 GB so a runaway render can't take
# the desktop down with it.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v blender >/dev/null || { echo "gen-help-art: blender not found" >&2; exit 1; }
command -v magick >/dev/null || { echo "gen-help-art: ImageMagick 7 (magick) not found" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

run=(blender -b --factory-startup --python-exit-code 1 --python scripts/help-art/catchment.py -- \
	--out "$tmp/catchment.png" --hotspots "$tmp/hotspots.json" \
	--width 1600 --samples "${HELP_ART_SAMPLES:-128}" --device "${HELP_ART_DEVICE:-OPTIX}")
if command -v systemd-run >/dev/null; then
	systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 "${run[@]}"
else
	"${run[@]}"
fi

mkdir -p frontend/static/help
magick "$tmp/catchment.png" -strip -quality 82 -define webp:alpha-quality=90 frontend/static/help/catchment-1600.webp
magick "$tmp/catchment.png" -strip -resize 800x -quality 82 -define webp:alpha-quality=90 frontend/static/help/catchment-800.webp
cp "$tmp/hotspots.json" frontend/src/lib/help/catchment-hotspots.json
ls -l frontend/static/help/
