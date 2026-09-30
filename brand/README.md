# Brand — "Outlet"

Farm nodes drain through junctions to a single gauge (the outlet), whose
ripples spread outward — the WBT network model, and the app's own network
screen, in one shape. Chosen from eight concepts on 2026-09-23 (concept #8;
the earlier pick, #1 "Confluence", was replaced the same day).

| Token | Hex | Use |
| --- | --- | --- |
| Navy | `#102A43` | Nodes and lines, wordmark on light (`--brand-navy`, `--brand-node`) |
| Cyan | `#1E9BB8` | Outlet and ripples (`--brand-outlet`) |
| Bright cyan | `#36C6E0` | Outlet on dark backgrounds |
| Mist | `#D9E6F2` | Nodes and wordmark on dark |
| UI accent | `#0B6E8A` | Links and buttons — a darker cyan so text meets 4.5:1 on white |

Type: **Outfit** 600 (SIL OFL 1.1 — `fonts/OFL.txt`) for the wordmark and
display text; **Inter** (SIL OFL 1.1 — `fonts/OFL-Inter.txt`) for all UI text,
self-hosted so every platform lays text out in the same metrics (it was the
system sans, which differed between a Mac, Linux and CI; #258).

## Files

- `src/mark.svg` — editable master mark. `src/mark-small.svg` — ≤ 48 px favicon
  variant on a navy tile (three nodes, heavier lines, one ripple).
- `fonts/Outfit-Variable.ttf` — upstream variable font (google/fonts, OFL).
- `fonts/OFL-Inter.txt` — Inter's licence. The font itself isn't committed
  (880 KB, over the repo's 500 KB file limit): `build.py` downloads Inter 4.1
  from the rsms/inter release `v4.1` (`Inter-4.1.zip`, sha256
  `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`) and uses
  its `InterVariable.ttf` (sha256
  `4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf`), refusing
  either on a hash mismatch.
- `dist/` — generated lockups (`logo.svg`, `logo-reversed.svg`, wordmark as outlines;
  `mark.svg`). Gitignored: `build.py` writes it.
- Generated into `frontend/static/`: `favicon.svg/.ico`, `apple-touch-icon.png`,
  `icon-192/512.png`, `icon-maskable-512.png`, `site.webmanifest`,
  `fonts/outfit-600.woff2` (Latin subset) with a copy of `fonts/OFL.txt`, and
  `fonts/inter-variable.woff2` (weights 400–700, text optical size; Latin,
  Greek and the UI's symbol blocks, `BODY_UNICODES`) with `fonts/OFL-Inter.txt`.
- `frontend/src/lib/components/layout/BrandMark.svelte` inlines the mark for the UI
  (theme-aware colours) — keep it in step with `src/mark.svg`.

## Rebuild

Needs Inkscape and ImageMagick (both on the workstation) plus fonttools:

```bash
python3 -m venv .venv-brand && .venv-brand/bin/pip install -r brand/requirements.txt && .venv-brand/bin/python brand/build.py
```

The body font alone (fonttools and network only, byte-for-byte reproducible):

```bash
uv run --no-project --with fonttools==4.66.0 --with brotli==1.2.0 python brand/build.py body-font
```
