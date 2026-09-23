# Brand — "Confluence"

Tributaries drain through farm junctions to a single outlet (ochre dot), inside a
water drop: the WBT network model in one shape. Chosen from eight concepts
(2026-09-23).

| Token | Hex | Use |
| --- | --- | --- |
| Teal | `#0E4A6B` | Drop, primary accent (`--accent`, `--brand-teal`) |
| Ink | `#0E3B55` | Wordmark on light |
| Mist | `#E8F4F2` | Branches; wordmark on dark |
| Ochre | `#C9892B` | Outlet dot only (`--brand-ochre`) |
| Ivory | `#F7F4EC` | Icon tiles, light backgrounds |

Type: **Fraunces** 600, optical size 72 (SIL OFL 1.1 — `fonts/OFL.txt`), for the
wordmark and display text only; UI text stays the system sans.

## Files

- `src/mark.svg` — editable master mark. `src/mark-small.svg` — ≤ 48 px variant
  (fewer, heavier branches).
- `fonts/Fraunces-Variable.ttf` — upstream variable font (google/fonts, OFL).
- `dist/` — generated lockups (`logo.svg`, `logo-reversed.svg`, wordmark as outlines).
- Generated into `frontend/static/`: `favicon.svg/.ico`, `apple-touch-icon.png`,
  `icon-192/512.png`, `icon-maskable-512.png`, `site.webmanifest`,
  `fonts/fraunces-600.woff2` (Latin subset).
- `frontend/src/lib/components/layout/BrandMark.svelte` inlines the mark for the UI —
  keep it in step with `src/mark.svg`.

## Rebuild

Needs Inkscape and ImageMagick (both on the workstation) plus fonttools:

```bash
python3 -m venv .venv-brand && .venv-brand/bin/pip install -r brand/requirements.txt && .venv-brand/bin/python brand/build.py
```
