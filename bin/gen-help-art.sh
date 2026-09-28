#!/usr/bin/env bash
# Render the help illustrations (scripts/help-art/catchment.py: one scene,
# several camera shots) and write what the pages read:
#   frontend/static/help/<shot>-<width>.webp   each shot, full and half width
#   frontend/src/lib/help/pictures.json         size + marker positions per shot
#
#   pnpm gen:help-art                  # GPU (OptiX); HELP_ART_DEVICE=CUDA|CPU to change
#   HELP_ART_ONLY=farm,soil pnpm gen:help-art   # re-render some shots only
#
# Optional tooling, not needed to run or build the app: needs Blender 5.x,
# ImageMagick 7 (`magick`) and python3. The output is committed, so only re-run
# it after changing the scene. Blender is capped at 3 GB so a runaway render
# can't take the desktop down with it.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v blender >/dev/null || { echo "gen-help-art: blender not found" >&2; exit 1; }
command -v magick >/dev/null || { echo "gen-help-art: ImageMagick 7 (magick) not found" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

run=(blender -b --factory-startup --python-exit-code 1 --python scripts/help-art/catchment.py -- \
	--outdir "$tmp" --samples "${HELP_ART_SAMPLES:-128}" --device "${HELP_ART_DEVICE:-OPTIX}" --only "${HELP_ART_ONLY:-}")
if command -v systemd-run >/dev/null; then
	systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 "${run[@]}"
else
	"${run[@]}"
fi

mkdir -p frontend/static/help
for png in "$tmp"/*.png; do
	shot=$(basename "$png" .png)
	# The width the page asks for (a cropped render can be a pixel off it).
	w=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["width"])' "$tmp/shots.json" "$shot")
	magick "$png" -strip -resize "${w}x" -quality 82 -define webp:alpha-quality=90 "frontend/static/help/$shot-$w.webp"
	magick "$png" -strip -resize "$((w / 2))x" -quality 82 -define webp:alpha-quality=90 "frontend/static/help/$shot-$((w / 2)).webp"
done
# Merge into the committed map, so a partial run (HELP_ART_ONLY) keeps the rest.
python3 - "$tmp/shots.json" frontend/src/lib/help/pictures.json <<'PY'
import json, os, sys
new = json.load(open(sys.argv[1]))
path = sys.argv[2]
old = json.load(open(path)) if os.path.exists(path) else {}
old.update(new)
with open(path, "w") as f:
    json.dump(dict(sorted(old.items())), f, indent=1)
    f.write("\n")
PY
ls -l frontend/static/help/
