#!/usr/bin/env bash
# The catchment map's local basemap (issue #288, roadmap WP-3.12; docs/maps.md
# § Basemap). Optional: without it the map draws its features on a plain
# background, and nothing else needs it (CI never downloads tiles).
#
#   bin/tiles-dev.sh fetch    extract South Africa from the Protomaps daily
#                             build into ~/.cache/water-management-tiles/ and
#                             upload it to the local MinIO (pnpm dev:s3:up)
#   bin/tiles-dev.sh status   what is cached and whether MinIO serves it
#   bin/tiles-dev.sh env      the PUBLIC_TILES_URL line for frontend/.env.development.local
#
# `fetch` needs the `pmtiles` CLI (go-pmtiles, https://github.com/protomaps/go-pmtiles
# releases; a single static binary, put it on PATH). It reads only the byte
# ranges of the bbox from the public build, so it downloads the extract, not
# the planet. TILES_MAXZOOM (default 15, the Protomaps build's deepest zoom:
# close enough to place a dam or trace a parcel; #326 D5 measured the extract
# at about 1.0 GB, against 490 MB at 14 and 250 MB at 13, docs/maps.md §
# Basemap), TILES_BBOX and TILES_BUILD (a build date, YYYYMMDD; default
# yesterday's) override it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/water-management-tiles"
FILE="$CACHE/south-africa.pmtiles"
BBOX="${TILES_BBOX:-16.3,-35.0,33.0,-22.0}"
MAXZOOM="${TILES_MAXZOOM:-15}"
URL="http://localhost:9002/tiles/south-africa.pmtiles"

case "${1:-}" in
	fetch)
		command -v pmtiles >/dev/null || { echo "pmtiles CLI not found: install go-pmtiles (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH." >&2; exit 1; }
		build="${TILES_BUILD:-$(date -u -d yesterday +%Y%m%d 2>/dev/null || date -u -v-1d +%Y%m%d)}"
		mkdir -p "$CACHE"
		echo "Extracting $BBOX at maxzoom $MAXZOOM from the Protomaps build $build …"
		pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$FILE" --bbox="$BBOX" --maxzoom="$MAXZOOM"
		du -h "$FILE"
		(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts "$FILE")
		echo "Now: pnpm dev:tiles:env >> frontend/.env.development.local (then restart pnpm dev)."
		;;
	status)
		if [ -f "$FILE" ]; then du -h "$FILE"; else echo "No extract in $CACHE (pnpm dev:tiles:fetch)."; fi
		if curl -fsS -o /dev/null -r 0-15 "$URL" 2>/dev/null; then echo "MinIO serves $URL"; else echo "MinIO doesn't serve $URL (pnpm dev:s3:up, then pnpm dev:tiles:fetch)."; fi
		;;
	env)
		echo "PUBLIC_TILES_URL=$URL"
		;;
	*)
		echo "usage: bin/tiles-dev.sh fetch | status | env" >&2
		exit 2
		;;
esac
