#!/usr/bin/env python3
"""Build every brand asset from the editable sources in brand/src and brand/fonts.

    python brand/build.py          # needs fonttools + brotli (brand/requirements.txt),
                                   # inkscape and ImageMagick (`magick`) on PATH

Outputs (all committed, all regenerated deterministically):
    brand/dist/logo.svg              horizontal lockup, wordmark as outlines (no font needed)
    brand/dist/logo-reversed.svg     same, for dark backgrounds
    brand/dist/mark.svg              the mark alone
    frontend/static/favicon.svg      small-size mark
    frontend/static/favicon.ico      16/32/48 px
    frontend/static/apple-touch-icon.png, icon-192.png, icon-512.png, icon-maskable-512.png
    frontend/static/site.webmanifest
    frontend/static/fonts/outfit-600.woff2     Latin subset, static 600 weight (OFL)
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "src"
DIST = ROOT / "brand" / "dist"
STATIC = ROOT / "frontend" / "static"
FONT_SRC = ROOT / "brand" / "fonts" / "Outfit-Variable.ttf"

NAVY = "#102A43"
CYAN = "#1E9BB8"
MIST = "#D9E6F2"
CYAN_BRIGHT = "#36C6E0"
PAPER = "#F5F7FB"
NAME = "Water Management"

# Display settings for the wordmark and the web font.
AXES = {"wght": 600}


def static_font() -> TTFont:
    font = TTFont(FONT_SRC)
    return instantiateVariableFont(font, AXES, inplace=False)


def build_webfont(font: TTFont) -> None:
    out = STATIC / "fonts" / "outfit-600.woff2"
    out.parent.mkdir(parents=True, exist_ok=True)
    opts = Options()
    opts.flavor = "woff2"
    opts.layout_features = ["kern", "liga", "lnum", "tnum"]
    sub = Subsetter(options=opts)
    # Basic Latin + Latin-1 + common punctuation (enough for names/place names).
    sub.populate(unicodes=list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026])
    f = font  # subset in place (called last, after the wordmark is outlined)
    sub.subset(f)
    f.flavor = "woff2"
    f.save(out)
    shutil.copy(FONT_SRC.parent / "OFL.txt", STATIC / "fonts" / "OFL.txt")


def kerning(font: TTFont) -> dict[tuple[str, str], int]:
    """Pair kerning from GPOS PairPos format 1 (glyph pairs) — good enough for a wordmark."""
    pairs: dict[tuple[str, str], int] = {}
    if "GPOS" not in font:
        return pairs
    for lookup in font["GPOS"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            st = getattr(st, "ExtSubTable", st)
            if getattr(st, "LookupType", None) != 2:
                continue
            if st.Format == 1:
                cov = st.Coverage.glyphs
                for i, ps in enumerate(st.PairSet):
                    for rec in ps.PairValueRecord:
                        v = getattr(rec.Value1, "XAdvance", 0) or 0
                        if v:
                            pairs.setdefault((cov[i], rec.SecondGlyph), v)
            elif st.Format == 2:
                cov = set(st.Coverage.glyphs)
                c1 = st.ClassDef1.classDefs
                c2 = st.ClassDef2.classDefs
                for g1 in cov:
                    k1 = c1.get(g1, 0)
                    row = st.Class1Record[k1]
                    for g2, k2 in c2.items():
                        v = getattr(row.Class2Record[k2].Value1, "XAdvance", 0) or 0
                        if v:
                            pairs.setdefault((g1, g2), v)
    return pairs


def wordmark_path(font: TTFont, text: str, size: float) -> tuple[str, float, float]:
    """Outline `text` as one SVG path at `size` px. Returns (d, width, cap_height)."""
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    upm = font["head"].unitsPerEm
    scale = size / upm
    kern = kerning(font)
    pen = SVGPathPen(gs)
    x = 0.0
    prev = None
    for ch in text:
        g = cmap[ord(ch)]
        if prev:
            x += kern.get((prev, g), 0)
        # Flip y (font units are y-up) and scale.
        gs[g].draw(TransformPen(pen, (scale, 0, 0, -scale, x * scale, 0)))
        x += gs[g].width
        prev = g
    cap = font["OS/2"].sCapHeight * scale
    return pen.getCommands(), x * scale, cap


def inner(svg_text: str) -> str:
    """The children of an <svg> element (drops comments)."""
    body = re.sub(r"<!--.*?-->", "", svg_text, flags=re.S)
    return re.sub(r"^.*?<svg[^>]*>|</svg>\s*$", "", body.strip(), flags=re.S).strip()


def lockup(mark_inner: str, word_d: str, word_w: float, cap: float, ink: str, mark_swap: dict[str, str] | None = None) -> str:
    mark = mark_inner
    for a, b in (mark_swap or {}).items():
        mark = mark.replace(a, b)
    mark_size = 120
    gap = 26
    baseline = 60 + cap / 2  # centre the caps on the mark
    w = mark_size + gap + word_w
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.1f} {mark_size}" role="img" aria-label="{NAME}">\n'
        f"  <g>{mark}</g>\n"
        f'  <path transform="translate({mark_size + gap} {baseline:.1f})" fill="{ink}" d="{word_d}"/>\n'
        "</svg>\n"
    )


def run(*cmd: str) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def png(svg: Path, out: Path, size: int, background: str | None = None) -> None:
    args = ["inkscape", "--export-type=png", f"--export-width={size}", f"--export-height={size}", f"--export-filename={out}"]
    if background:
        args += [f"--export-background={background}", "--export-background-opacity=1"]
    run(*args, str(svg))


def main() -> None:
    DIST.mkdir(parents=True, exist_ok=True)
    STATIC.mkdir(parents=True, exist_ok=True)

    mark_src = (SRC / "mark.svg").read_text()
    shutil.copy(SRC / "mark.svg", DIST / "mark.svg")

    font = static_font()
    d, w, cap = wordmark_path(font, NAME, 64)
    (DIST / "logo.svg").write_text(lockup(inner(mark_src), d, w, cap, NAVY))
    # Reversed: mist nodes and lines, bright cyan outlet, mist wordmark.
    (DIST / "logo-reversed.svg").write_text(
        lockup(inner(mark_src), d, w, cap, MIST, {NAVY: MIST, CYAN: CYAN_BRIGHT})
    )

    shutil.copy(SRC / "mark-small.svg", STATIC / "favicon.svg")

    reversed_mark = inner(mark_src).replace(NAVY, MIST).replace(CYAN, CYAN_BRIGHT)
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        # Icons: the reversed mark on a navy tile with safe padding (maskable-friendly).
        tile = t / "tile.svg"
        tile.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
            f'<rect width="120" height="120" fill="{NAVY}"/>'
            f'<g transform="translate(18 14) scale(0.7)">{reversed_mark}</g></svg>'
        )
        maskable = t / "maskable.svg"
        maskable.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
            f'<rect width="120" height="120" fill="{NAVY}"/>'
            f'<g transform="translate(27 25) scale(0.55)">{reversed_mark}</g></svg>'
        )
        png(tile, STATIC / "apple-touch-icon.png", 180)
        png(tile, STATIC / "icon-192.png", 192)
        png(tile, STATIC / "icon-512.png", 512)
        png(maskable, STATIC / "icon-maskable-512.png", 512)
        sizes = []
        for s in (16, 32, 48):
            p = t / f"fav-{s}.png"
            png(SRC / "mark-small.svg", p, s)
            sizes.append(str(p))
        run("magick", *sizes, str(STATIC / "favicon.ico"))

    (STATIC / "site.webmanifest").write_text(
        json.dumps(
            {
                "name": NAME,
                "short_name": "Water Mgmt",
                "icons": [
                    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
                    {"src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
                ],
                "theme_color": NAVY,
                "background_color": NAVY,
                "display": "standalone",
            },
            indent=2,
        )
        + "\n"
    )

    build_webfont(font)
    print("brand assets built")


if __name__ == "__main__":
    main()
