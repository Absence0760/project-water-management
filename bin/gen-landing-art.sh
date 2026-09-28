#!/usr/bin/env bash
# Regenerate everything the landing page shows (issue #57; docs/design/landing-art.md)
# from committed sources, and write what the page reads:
#
#   frontend/static/landing/hero-{day,dusk}-<w>.{avif,webp}   the diorama, 800 … 1600 px
#   frontend/static/landing/og.jpg                             the 1200 × 630 social card
#   frontend/static/landing/contours.svg                       the contour texture
#   frontend/static/landing/screen-<name>-{light,dark}-<w>.{avif,webp}   app screens, framed
#   frontend/src/lib/components/landing/art.generated.ts       sizes, placeholders, overlay, icons
#   frontend/src/lib/components/landing/data.generated.ts      the engine's figures (charts, what-if)
#
#   pnpm gen:landing-art                          everything (GPU: LANDING_ART_DEVICE, default OPTIX)
#   LANDING_ART_ONLY=data,vector pnpm gen:landing-art   some steps: render, vector, screens, data
#
# The tools, all local, none needed to run or build the app (the output is committed):
#   Blender 5      scripts/landing-art/diorama.py: the scene, lit for day and dusk
#   python3        scripts/landing-art/contours.py: contour lines from the terrain
#   Inkscape 1.4   the icons, river divider and device frames (scripts/landing-art/vector/)
#   ImageMagick 7  resizing, placeholders, framing the screens, the social card's text
#   avifenc        AVIF (libavif-tools), since not every ImageMagick build writes it
#   FontForge      the display font (Outfit, frontend/static/fonts) as TTF for the card
#   Playwright     the app screens, from the example catchments (e2e/art/, the e2e servers;
#                  needs pnpm dev:db:up)
#   the engine     backend/scripts/landing-data.ts: the charts and the what-if grid
set -euo pipefail
cd "$(dirname "$0")/.."

ONLY=",${LANDING_ART_ONLY:-render,vector,screens,data},"
want() { [[ "$ONLY" == *",$1,"* ]]; }
need() { command -v "$1" >/dev/null || { echo "gen-landing-art: $1 not found ($2)" >&2; exit 1; }; }

STATIC=frontend/static/landing
MODULES=frontend/src/lib/components/landing
VECTOR=scripts/landing-art/vector
# Kept between runs, so a partial run (LANDING_ART_ONLY) can still write the module.
WORK=${LANDING_ART_WORK:-scripts/landing-art/.work}
mkdir -p "$STATIC" "$WORK" "$WORK/vector"

need magick "ImageMagick 7"
need avifenc "dnf install libavif-tools"
webp() { magick "$1" -strip -resize "${3}x" -quality "${4:-80}" -define webp:alpha-quality=90 "$2"; }
avif() {
	magick "$1" -strip -resize "${3}x" "$WORK/avif-src.png"
	avifenc --min 0 --max 63 -a end-usage=q -a cq-level="${4:-30}" -s 4 --jobs all "$WORK/avif-src.png" "$2" >/dev/null
}

if want render; then
	need blender "Blender 5"
	need fontforge "the opt-in asset tools"
	run=(blender -b --factory-startup --python-exit-code 1 --python scripts/landing-art/diorama.py -- \
		--outdir "$WORK" --samples "${LANDING_ART_SAMPLES:-160}" --device "${LANDING_ART_DEVICE:-OPTIX}" --width 1600)
	if command -v systemd-run >/dev/null; then
		systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 "${run[@]}"
	else
		"${run[@]}"
	fi
	python3 scripts/landing-art/contours.py "$WORK/heights.json" "$STATIC/contours.svg"

	w=$(magick identify -format '%w' "$WORK/hero-day.png")
	h=$(magick identify -format '%h' "$WORK/hero-day.png")
	printf '{"width":%s,"height":%s,"widths":[800,1200,1600]}\n' "$w" "$h" >"$WORK/hero.json"
	for mode in day dusk; do
		for size in 800 1200 1600; do
			webp "$WORK/hero-$mode.png" "$STATIC/hero-$mode-$size.webp" "$size" 78
			avif "$WORK/hero-$mode.png" "$STATIC/hero-$mode-$size.avif" "$size" 34
		done
		# A 24 px blur-up, inlined in the page: it holds the picture's place while it loads.
		magick "$WORK/hero-$mode.png" -strip -resize 24x -quality 40 "$WORK/placeholder-$mode.webp"
	done

	# The social card: the dusk backdrop, the headline in the display font.
	fontforge -lang=ff -c 'Open($1); Generate($2)' frontend/static/fonts/outfit-600.woff2 "$WORK/outfit-600.ttf" 2>/dev/null
	magick "$WORK/og-dusk.png" \
		\( -size 1200x630 gradient:'rgba(12,24,40,0.92)'-'rgba(12,24,40,0)' -rotate -90 -resize 1200x630! \) -composite \
		-font "$WORK/outfit-600.ttf" -fill '#36c6e0' -pointsize 24 -kerning 3 -annotate +72+150 'WATER MANAGEMENT' \
		-fill white -pointsize 58 -kerning 0 -interline-spacing 4 -annotate +72+238 $'Every drop in the\ncatchment,\naccounted for.' \
		-fill '#d9e6f2' -pointsize 26 -annotate +72+520 'Daily water balance, from rainfall to river.' \
		-strip -quality 86 "$STATIC/og.jpg"
fi

if want vector; then
	need inkscape "the opt-in asset tools"
	# Plain SVG, every shape a path: what modules.mjs reads.
	for src in "$VECTOR"/icon-*.svg "$VECTOR"/river-divider.svg; do
		inkscape "$src" --export-plain-svg --actions='select-all:all;object-to-path' --export-filename="$WORK/vector/$(basename "$src")" 2>/dev/null
	done
	# The device frames at 1× (the screens are captured at 1×), screen area transparent.
	inkscape "$VECTOR/frame-laptop.svg" --export-type=png --export-background-opacity=0 --export-filename="$WORK/frame-laptop.png" 2>/dev/null
	inkscape "$VECTOR/frame-phone.svg" --export-type=png --export-background-opacity=0 --export-filename="$WORK/frame-phone.png" 2>/dev/null
fi

if want screens; then
	[ -f "$WORK/frame-laptop.png" ] || { echo "gen-landing-art: run the vector step first (the frames)" >&2; exit 1; }
	# The app itself on the example catchments, light and dark (e2e/art/landing-screens.spec.ts).
	LANDING_SHOTS_DIR="$(pwd)/$WORK/shots" pnpm -C e2e exec playwright test --config art/playwright.config.ts >"$WORK/screens.log" 2>&1 \
		|| { tail -40 "$WORK/screens.log" >&2; exit 1; }
	echo '{' >"$WORK/screens.json.tmp"
	for theme in light dark; do
		# Laptop: the Summary, 1440 × 900 into the frame's screen at (80, 44).
		magick -size 1600x1036 xc:none "$WORK/shots/summary-$theme.png" -geometry +80+44 -composite "$WORK/frame-laptop.png" -composite "$WORK/laptop-$theme.png"
		# Phone: the farmer view, 390 × 844 at (22, 22).
		magick -size 434x888 xc:none "$WORK/shots/farm-$theme.png" -geometry +22+22 -composite "$WORK/frame-phone.png" -composite "$WORK/phone-$theme.png"
		for size in 800 1600; do
			webp "$WORK/laptop-$theme.png" "$STATIC/screen-laptop-$theme-$size.webp" "$size" 82
			avif "$WORK/laptop-$theme.png" "$STATIC/screen-laptop-$theme-$size.avif" "$size" 30
		done
		for size in 217 434; do
			webp "$WORK/phone-$theme.png" "$STATIC/screen-phone-$theme-$size.webp" "$size" 82
			avif "$WORK/phone-$theme.png" "$STATIC/screen-phone-$theme-$size.avif" "$size" 30
		done
		# Two more screens, unframed, for the outcome cards.
		for name in network river; do
			for size in 640 1280; do
				webp "$WORK/shots/$name-$theme.png" "$STATIC/screen-$name-$theme-$size.webp" "$size" 80
				avif "$WORK/shots/$name-$theme.png" "$STATIC/screen-$name-$theme-$size.avif" "$size" 30
			done
		done
	done
	sizes=()
	for name in laptop phone; do
		sizes+=("\"$name\":{\"width\":$(magick identify -format '%w' "$WORK/$name-light.png"),\"height\":$(magick identify -format '%h' "$WORK/$name-light.png")}")
	done
	for name in network river; do
		sizes+=("\"$name\":{\"width\":$(magick identify -format '%w' "$WORK/shots/$name-light.png"),\"height\":$(magick identify -format '%h' "$WORK/shots/$name-light.png")}")
	done
	(IFS=,; echo "{${sizes[*]}}") >"$WORK/screens.json"
	rm -f "$WORK/screens.json.tmp"
fi

if want data; then
	pnpm -C backend exec tsx scripts/landing-data.ts "$(pwd)/$MODULES/data.generated.ts"
fi

node scripts/landing-art/modules.mjs "$WORK" "$WORK/vector" "$MODULES/art.generated.ts"
ls -l "$STATIC"
