#!/usr/bin/env bash
# The catchment map's local basemap (issue #288, roadmap WP-3.12; docs/maps.md
# § Basemap). Optional: without it the map draws its features on a plain
# background, and nothing else needs it (CI never downloads tiles).
#
#   bin/tiles-dev.sh up       start the map's basemap in one step, safe to
#                             re-run: start MinIO, upload the cached extract
#                             and fonts if MinIO doesn't serve them (fetching
#                             them only when nothing is cached), and set the
#                             URLs in frontend/.env.development.local; the
#                             relief's DEM only if it is cached or served
#                             (never fetched here: run `terrain` once for it)
#   bin/tiles-dev.sh fetch    extract South Africa from the Protomaps daily
#                             build into ~/.cache/water-management-tiles/ and
#                             upload it to the local MinIO (pnpm dev:s3:up),
#                             then the labels' fonts (as `fonts`)
#   bin/tiles-dev.sh fonts    only the labels' glyph ranges (#326 A6): Noto Sans
#                             (SIL OFL 1.1) from the Protomaps basemaps-assets
#                             repository at a pinned commit, uploaded under
#                             tiles/fonts/ (no pmtiles CLI needed)
#   bin/tiles-dev.sh terrain  the relief's DEM (docs/maps.md § Relief): extract
#                             South Africa from the Mapterhorn planet build
#                             (Terrarium-encoded Copernicus GLO-30) and upload
#                             it to MinIO as tiles/terrain.pmtiles
#   bin/tiles-dev.sh rivers   the River network layer's data (issue #345,
#                             docs/maps.md § River network): download
#                             HydroRIVERS v1.0 (Africa), cut it to the bbox
#                             with ogr2ogr, and load it into this checkout's
#                             database (`pnpm import:rivers`); not tiles, but
#                             the same operator-run, never-in-CI fetch
#   bin/tiles-dev.sh water    tracing a dam's data (issue #326 C2, docs/maps.md
#                             § Assisted drawing): download JRC Global Surface
#                             Water v1.5's occurrence (the 10° tiles that meet
#                             the bbox), turn it into Terrarium PNG tiles at
#                             zoom 12 with GDAL, and upload it to MinIO as
#                             tiles/water.pmtiles; then WATER_URL in
#                             backend/.env.development.local
#   bin/tiles-dev.sh status   what is cached and whether MinIO serves it
#   bin/tiles-dev.sh env      the PUBLIC_TILES_URL, PUBLIC_TILES_GLYPHS_URL and
#                             PUBLIC_TERRAIN_URL lines for
#                             frontend/.env.development.local
#
# `fetch` needs the `pmtiles` CLI (go-pmtiles, https://github.com/protomaps/go-pmtiles
# releases; a single static binary, put it on PATH). It reads only the byte
# ranges of the bbox from the public build, so it downloads the extract, not
# the planet. TILES_MAXZOOM (default 15, the Protomaps build's deepest zoom:
# close enough to place a dam or trace a parcel; #326 D5 measured the extract
# at about 1.0 GB, against 490 MB at 14 and 250 MB at 13, docs/maps.md §
# Basemap), TILES_BBOX and TILES_BUILD (a build date, YYYYMMDD; default
# yesterday's) override it.
#
# `terrain` needs the same CLI. Over South Africa the Mapterhorn build has
# only its global layer, Copernicus GLO-30, to zoom 12 (about 30 m a pixel
# there, the DEM's own resolution); TERRAIN_MAXZOOM (default 12: about 2.2 GB,
# 570 MB at 11, 200 MB at 10) and TERRAIN_SOURCE (the archive's URL) override it.
#
# `water` needs GDAL (gdalwarp and gdal_translate: `sudo dnf install gdal`) or
# docker (it runs the pinned GDAL image, $GDAL_IMAGE, when gdalwarp isn't on
# PATH), and the pmtiles CLI. GSW is free of charge and without restriction of
# use (Copernicus; attribution "Source: EC JRC/Google"). Over South Africa its
# six 10° occurrence tiles are about 100 MB together; the archive is a few
# tens of MB. WATER_SOURCE (the download folder's URL) and TILES_BBOX override it.
#
# `rivers` needs ogr2ogr (GDAL: `sudo dnf install gdal`) and the database up
# (pnpm dev:db:up). HydroRIVERS is © WWF, free for commercial use with the
# attribution docs/maps.md § Sources records (HydroSHEDS licence). RIVERS_URL
# (the zip), TILES_BBOX and RIVERS_MIN_ORDER (a Strahler order, default 1:
# every reach) override it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/water-management-tiles"
FILE="$CACHE/south-africa.pmtiles"
BBOX="${TILES_BBOX:-16.3,-35.0,33.0,-22.0}"
MAXZOOM="${TILES_MAXZOOM:-15}"
URL="http://localhost:9002/tiles/south-africa.pmtiles"
TERRAIN_FILE="$CACHE/terrain.pmtiles"
TERRAIN_MAXZOOM="${TERRAIN_MAXZOOM:-12}"
TERRAIN_SRC="${TERRAIN_SOURCE:-https://download.mapterhorn.com/planet.pmtiles}"
TERRAIN_URL="http://localhost:9002/tiles/terrain.pmtiles"
WATER_SRC="${WATER_SOURCE:-https://s3.waw4-1.cloudferro.com/swift/v1/global-surface-water/download2024/Aggregated/VER1-5/occurrence}"
WATER_FILE="$CACHE/water.pmtiles"
WATER_URL="http://localhost:9002/tiles/water.pmtiles"
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:ubuntu-small-3.11.3}"
RIVERS_SRC="${RIVERS_URL:-https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_af_shp.zip}"
RIVERS_ZIP="$CACHE/$(basename "$RIVERS_SRC")"
RIVERS_FILE="$CACHE/rivers.geojson"
RIVERS_MIN_ORDER="${RIVERS_MIN_ORDER:-1}"
RIVERS_SOURCE="HydroRIVERS v1.0 (Lehner & Grill 2013, www.hydrosheds.org), incorporating data from the HydroSHEDS version 1 database © World Wildlife Fund, Inc. (2006-2022), used under license"
GLYPHS="http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf"
# The fonts: protomaps/basemaps-assets at a pinned commit (docs/maps.md § Sources).
FONTS_REF="${TILES_FONTS_REF:-028c18f713baecad011301ff7a69acc39bcc2ae7}"
FONT_STACKS=("Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic")
FONTS="$CACHE/fonts"

fetch_fonts() {
	mkdir -p "$CACHE"
	local tgz="$CACHE/basemaps-assets-$FONTS_REF.tar.gz" top="basemaps-assets-$FONTS_REF"
	if [ ! -f "$tgz" ]; then
		echo "Downloading the label fonts (protomaps/basemaps-assets@${FONTS_REF:0:12}) …"
		curl -fsSL -o "$tgz.part" "https://codeload.github.com/protomaps/basemaps-assets/tar.gz/$FONTS_REF"
		mv "$tgz.part" "$tgz"
	fi
	rm -rf "$FONTS" && mkdir -p "$FONTS"
	local members=("$top/fonts/OFL.txt")
	for f in "${FONT_STACKS[@]}"; do members+=("$top/fonts/$f"); done
	tar -xzf "$tgz" -C "$FONTS" --strip-components=2 "${members[@]}"
	du -sh "$FONTS"
	(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts --fonts "$FONTS")
}

serves_tiles() { curl -fsS -o /dev/null -r 0-15 "$URL" 2>/dev/null; }
serves_terrain() { curl -fsS -o /dev/null -r 0-15 "$TERRAIN_URL" 2>/dev/null; }
serves_water() { curl -fsS -o /dev/null -r 0-15 "$WATER_URL" 2>/dev/null; }
serves_fonts() { curl -fsS -o /dev/null "http://localhost:9002/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf" 2>/dev/null; }

case "${1:-}" in
	up)
		(cd "$ROOT" && docker compose up -d --wait minio)
		if serves_tiles; then
			echo "MinIO serves $URL"
		elif [ -f "$FILE" ]; then
			(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts "$FILE")
		else
			"$0" fetch
		fi
		if serves_fonts; then
			echo "MinIO serves the label fonts"
		elif [ -d "$FONTS" ]; then
			(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts --fonts "$FONTS")
		else
			fetch_fonts
		fi
		# The relief's DEM is optional and ~2.2 GB: upload a cached one, never fetch it here.
		relief=()
		if serves_terrain; then
			echo "MinIO serves $TERRAIN_URL"
			relief=(--terrain)
		elif [ -f "$TERRAIN_FILE" ]; then
			(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts --terrain "$TERRAIN_FILE")
			relief=(--terrain)
		else
			echo "No relief DEM (optional: pnpm dev:tiles:terrain, then pnpm dev:tiles:up again)."
		fi
		(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts --env "$ROOT/frontend/.env.development.local" "${relief[@]}")
		;;
	fetch)
		command -v pmtiles >/dev/null || { echo "pmtiles CLI not found: install go-pmtiles (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH." >&2; exit 1; }
		build="${TILES_BUILD:-$(date -u -d yesterday +%Y%m%d 2>/dev/null || date -u -v-1d +%Y%m%d)}"
		mkdir -p "$CACHE"
		echo "Extracting $BBOX at maxzoom $MAXZOOM from the Protomaps build $build …"
		pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$FILE" --bbox="$BBOX" --maxzoom="$MAXZOOM"
		du -h "$FILE"
		(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts "$FILE")
		fetch_fonts
		echo "Now: pnpm dev:tiles:up (sets the URLs in frontend/.env.development.local), then restart pnpm dev."
		;;
	terrain)
		command -v pmtiles >/dev/null || { echo "pmtiles CLI not found: install go-pmtiles (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH." >&2; exit 1; }
		mkdir -p "$CACHE"
		echo "Extracting $BBOX at maxzoom $TERRAIN_MAXZOOM from $TERRAIN_SRC …"
		pmtiles extract "$TERRAIN_SRC" "$TERRAIN_FILE" --bbox="$BBOX" --maxzoom="$TERRAIN_MAXZOOM"
		du -h "$TERRAIN_FILE"
		(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts --terrain "$TERRAIN_FILE")
		echo "Now: pnpm dev:tiles:up (sets the URLs in frontend/.env.development.local), then restart pnpm dev and turn on Map → Layers → Relief."
		;;
	rivers)
		command -v ogr2ogr >/dev/null || { echo "ogr2ogr not found: install GDAL (sudo dnf install gdal)." >&2; exit 1; }
		mkdir -p "$CACHE"
		if [ ! -f "$RIVERS_ZIP" ]; then
			echo "Downloading $RIVERS_SRC (about 110 MB) …"
			curl -fSL -o "$RIVERS_ZIP.part" "$RIVERS_SRC"
			mv "$RIVERS_ZIP.part" "$RIVERS_ZIP"
		fi
		rm -rf "$CACHE/rivers-shp" && mkdir -p "$CACHE/rivers-shp"
		unzip -q -o "$RIVERS_ZIP" -d "$CACHE/rivers-shp"
		shp=$(find "$CACHE/rivers-shp" -name '*.shp' | head -n 1)
		[ -n "$shp" ] || { echo "No shapefile in $RIVERS_ZIP." >&2; exit 1; }
		echo "Cutting $(basename "$shp") to $BBOX …"
		rm -f "$RIVERS_FILE"
		# -spat keeps every reach that meets the bbox (whole, not clipped); five decimals is about 1 m.
		ogr2ogr -f GeoJSON -t_srs EPSG:4326 -spat ${BBOX//,/ } -select HYRIV_ID,ORD_STRA,UPLAND_SKM,LENGTH_KM,DIS_AV_CMS \
			-lco COORDINATE_PRECISION=5 "$RIVERS_FILE" "$shp"
		du -h "$RIVERS_FILE"
		(cd "$ROOT/backend" && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsx scripts/import-rivers.ts "$RIVERS_FILE" --dataset HydroRIVERS-v10 --source "$RIVERS_SOURCE" --min-order "$RIVERS_MIN_ORDER")
		echo "Now: Map → Layers → River network."
		;;
	water)
		command -v pmtiles >/dev/null || { echo "pmtiles CLI not found: install go-pmtiles (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH." >&2; exit 1; }
		if command -v gdalwarp >/dev/null; then
			gdal() { (cd "$CACHE/gsw" && "$@"); }
		elif command -v docker >/dev/null; then
			gdal() { docker run --rm -u "$(id -u):$(id -g)" -v "$CACHE/gsw":/w -w /w "$GDAL_IMAGE" "$@"; }
		else
			echo "GDAL not found: install it (sudo dnf install gdal), or docker to run $GDAL_IMAGE." >&2
			exit 1
		fi
		mkdir -p "$CACHE/gsw"
		IFS=, read -r west south east north <<<"$BBOX"
		# GSW's 10° tiles are named by their west and north edges: 20E_30S covers 20–30° E, 30–40° S.
		tiles=()
		for lon in $(seq "$(awk -v v="$west" 'BEGIN{print int((v+180)/10)*10-180}')" 10 "$(awk -v v="$east" 'BEGIN{print int((v+180-1e-9)/10)*10-180}')"); do
			for lat in $(seq "$(awk -v v="$north" 'BEGIN{t=int((v+90)/10)*10-90; if (t<v) t+=10; print t}')" -10 "$(awk -v v="$south" 'BEGIN{print int((v+90)/10)*10-90+10}')"); do
				name="occurrence_$([ "$lon" -lt 0 ] && echo "$((-lon))W" || echo "${lon}E")_$([ "$lat" -le 0 ] && echo "$((-lat))S" || echo "${lat}N")_v1_5_2024.tif"
				if [ ! -f "$CACHE/gsw/$name" ]; then
					echo "Downloading $name …"
					if curl -fsSL -o "$CACHE/gsw/$name.part" "$WATER_SRC/$name"; then mv "$CACHE/gsw/$name.part" "$CACHE/gsw/$name"; else rm -f "$CACHE/gsw/$name.part"; echo "  none there (open sea): skipped"; continue; fi
				fi
				tiles+=("$name")
			done
		done
		[ ${#tiles[@]} -gt 0 ] || { echo "No GSW tiles meet $BBOX." >&2; exit 1; }
		rm -f "$CACHE/gsw/water.vrt" "$CACHE/gsw/water-3857.tif" "$CACHE/gsw/water.mbtiles"
		echo "Warping ${#tiles[@]} tiles to zoom 12 (Web Mercator) …"
		gdal gdalbuildvrt -q water.vrt "${tiles[@]}"
		# Zoom 12's pixel (38.2 m at the equator, ~32 m over South Africa), aligned to the tile grid; a cell's share is the mean of the source cells in it.
		gdal gdalwarp -q -overwrite -t_srs EPSG:3857 -te "$west" "$south" "$east" "$north" -te_srs EPSG:4326 -tr 38.21851414258813 38.21851414258813 -tap \
			-r average -srcnodata 255 -dstnodata 255 -ot Byte -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER water.vrt water-3857.tif
		# Terrarium with the share as the height: R = 128, G = the share (0–100; 255 is no data), B = 0.
		gdal gdal_translate -q -b 1 -b 1 -b 1 -scale_1 0 255 128 128 -scale_2 0 255 0 255 -scale_3 0 255 0 0 -a_nodata none \
			-of MBTILES -co TILE_FORMAT=PNG -co ZOOM_LEVEL_STRATEGY=LOWER -co "NAME=JRC Global Surface Water occurrence v1.5 (1984-2024)" -co VERSION=1.5 water-3857.tif water.mbtiles
		rm -f "$WATER_FILE"
		pmtiles convert -q "$CACHE/gsw/water.mbtiles" "$WATER_FILE"
		pmtiles show --metadata "$WATER_FILE" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const m=JSON.parse(s);m.attribution="Source: EC JRC/Google";process.stdout.write(JSON.stringify(m));})' >"$CACHE/gsw/water-metadata.json"
		pmtiles edit -q "$WATER_FILE" --metadata="$CACHE/gsw/water-metadata.json"
		rm -f "$CACHE/gsw/water-3857.tif" "$CACHE/gsw/water.mbtiles" "$CACHE/gsw/water.vrt"
		du -h "$WATER_FILE"
		(cd "$ROOT/backend" && pnpm exec tsx scripts/tiles-upload.ts --water "$WATER_FILE")
		echo "Now: put WATER_URL=$WATER_URL in backend/.env.development.local and restart pnpm dev; the Map offers Trace a dam."
		;;
	fonts)
		fetch_fonts
		echo "Now: pnpm dev:tiles:up (sets the URLs in frontend/.env.development.local), then restart pnpm dev."
		;;
	status)
		if [ -f "$FILE" ]; then du -h "$FILE"; else echo "No extract in $CACHE (pnpm dev:tiles:fetch)."; fi
		if serves_tiles; then echo "MinIO serves $URL"; else echo "MinIO doesn't serve $URL (pnpm dev:s3:up, then pnpm dev:tiles:fetch)."; fi
		if [ -f "$TERRAIN_FILE" ]; then du -h "$TERRAIN_FILE"; else echo "No relief DEM in $CACHE (pnpm dev:tiles:terrain)."; fi
		if serves_terrain; then echo "MinIO serves $TERRAIN_URL"; else echo "MinIO doesn't serve $TERRAIN_URL (pnpm dev:tiles:terrain)."; fi
		if [ -f "$RIVERS_FILE" ]; then du -h "$RIVERS_FILE"; else echo "No river network in $CACHE (pnpm dev:tiles:rivers)."; fi
		if [ -f "$WATER_FILE" ]; then du -h "$WATER_FILE"; else echo "No water occurrence in $CACHE (pnpm dev:tiles:water)."; fi
		if serves_water; then echo "MinIO serves $WATER_URL"; else echo "MinIO doesn't serve $WATER_URL (pnpm dev:tiles:water)."; fi
		if [ -d "$FONTS" ]; then du -sh "$FONTS"; else echo "No fonts in $FONTS (pnpm dev:tiles:fonts)."; fi
		if serves_fonts; then echo "MinIO serves the label fonts"; else echo "MinIO doesn't serve the label fonts (pnpm dev:tiles:fonts)."; fi
		;;
	env)
		echo "PUBLIC_TILES_URL=$URL"
		echo "PUBLIC_TILES_GLYPHS_URL=$GLYPHS"
		echo "PUBLIC_TERRAIN_URL=$TERRAIN_URL"
		;;
	*)
		echo "usage: bin/tiles-dev.sh up | fetch | fonts | terrain | water | rivers | status | env" >&2
		exit 2
		;;
esac
