# Landing page: art, motion and the pipeline

The public landing page (issue #57; [ui.md § Landing page](../ui.md#landing-page))
follows one idea: **follow the water**, from rain on the ridges, through the
dams and farms, to the river at the outlet. That journey is what the model
does, so the page shows it. This file records what the page is made of, how
every picture on it is produced, and the rules its motion keeps.

## Everything is generated, from committed sources

No stock photos, no AI images, no CDN icon sets, no mockups. One command
regenerates every render, vector export, raster variant, screenshot and chart:

```bash
pnpm gen:landing-art                                  # everything
LANDING_ART_ONLY=data pnpm gen:landing-art            # some steps: render, vector, screens, data
LANDING_ART_DEVICE=ONEAPI pnpm gen:landing-art        # the GPU backend (OPTIX default; CUDA, HIP, ONEAPI, CPU)
```

It is optional tooling, like `gen:help-art`: the output is committed, so
running or building the app needs none of it. `bin/gen-landing-art.sh` runs:

| Step | Tool | Source | Output |
|---|---|---|---|
| render | Blender 5 (Cycles) | `scripts/landing-art/diorama.py`, which runs the help pictures' scene (`scripts/help-art/catchment.py`) and relights it | the hero for day (light mode) and dusk (dark mode); the social card's backdrop; `overlay.json`, where the rivers, dams, clouds, gauge and farms fall in the hero (projected through its camera); `heights.json`, the terrain |
| render | python3 (stdlib) | `scripts/landing-art/contours.py` | `static/landing/contours.svg`, marching-squares contours of the same terrain |
| render | ImageMagick 7, avifenc | the renders | `hero-{day,dusk}-{800,1200,1600}.{avif,webp}` (the hero is never wider than ~800 CSS px, so 1600 covers 2× screens and keeps each file under the 100 KB asset ceiling), 24 px blur-up placeholders (inlined) |
| render | FontForge, ImageMagick | `static/fonts/outfit-600.woff2` | `og.jpg`: the dusk backdrop with the headline set in the display font (FontForge makes the TTF ImageMagick needs) |
| vector | Inkscape 1.4 | `scripts/landing-art/vector/*.svg` | the four audience icons and the river divider as plain SVG, every shape a path (their path data goes into the module); the laptop and phone frames at 1× |
| screens | Playwright | `e2e/art/landing-screens.spec.ts` on the e2e servers, `pnpm seed:examples` data | the Summary (1440 × 900), Network and River & reserve (1280 × 800) as the demo hydrologist, the farm view (390 × 844) as the demo farmer, light and dark; ImageMagick frames them (the frames' screens are transparent holes, so the screenshot goes under the frame) |
| data | the engine | `backend/scripts/landing-data.ts` on the Kleinberg example | `data.generated.ts`: the story's charts (one water year by week) and the what-if grid (7 orchard sizes × 5 dam sizes, 35 runs) |
| (always) | node | `scripts/landing-art/modules.mjs` | `art.generated.ts`: the hero's size and placeholders, the overlay, the framed screens' sizes, the icons' and divider's path data |

The screens step needs `pnpm dev:db:up` (it runs on the e2e database, which it
rebuilds, and seeds the examples there). Working files go to
`scripts/landing-art/.work/` (gitignored), so a partial run can still write the
module.

**Only invented data.** The screens come from the example catchments, never the
client catchment (CLAUDE.md rule 11). Where a figure is shown it is named as the
example catchment's (the gauge tag, the story's intro, the what-if); the page
carries no separate "invented data" disclaimers (the operator's call,
2026-09-27).

**The figures are honest.** The hero's tag ("Reserve met on 42 % of days") and
the what-if are what the engine gives on the example, not chosen numbers. On
Kleinberg most of the reserve's failures come from the farms' use, and one
farm's orchard moves them by a few days a year while its own supply falls
steeply: the what-if shows exactly that. `landing/data.test.ts` holds the
grid to the hydrology (more orchard never supplies more or spares the river;
a bigger dam never supplies less), so a regeneration can't ship a what-if
that contradicts itself.

## The page's pieces

- **Hero** (`landing/Hero.svelte`, `Diorama.svelte`): the render, with an SVG
  layer drawn from `overlay.json` so the motion sits on the picture: rain
  streaks drift from the clouds to the ridges, a pulse of water runs down the
  tributary and the river (`stroke-dashoffset`), the dams fill (a `scaleY`
  from the waterline), the gauge's needle settles and its tag fades in with
  the example's reserve figure. One loop is about 10 s, then 4 s of rest. On a
  phone the picture is cropped to the lower valley: the river, the dam below
  and the outlet. **Sign in** morphs the diorama into the sign-in panel's
  scene with a View Transition (`view-transition-name: catchment-scene` on
  both), and is a plain link where the browser has none or motion is reduced.
- **From rainfall to river** (`Story.svelte`, `MiniChart.svelte`): the diorama
  stays pinned while five steps scroll past (rain, runoff, dams, farms, the
  river); the one in the middle of the screen lights its part of the scene.
  Each step has a small plain-SVG chart of the example's 2012/13 water year by
  week, with a text summary for screen readers. Scroll-driven animations
  (`animation-timeline: view()`) fade the steps in where supported; an
  IntersectionObserver picks the lit step everywhere.
- **Try a what-if** (`WhatIf.svelte`): two sliders (more apples, 0–60 ha; dam
  size, ×1–×2) over the precomputed grid; the figures, the today/this-plan
  bars and a takeaway in Compare runs' words. The figures are a polite live
  region; the sliders have value texts.
- **What you get** (`Screens.svelte`, `Shot.svelte`): the laptop (Summary) with
  the phone (farm view) overlapping it, then Network and River & reserve. They
  rise 24 px into view once, the phone 150 ms after; a ≤ 12 px parallax on the
  phone where scroll-driven animations exist.
- **Who it's for** (`Audiences.svelte`, `DrawnIcon.svelte`): the four roadmap
  audiences, each icon drawing itself on once in view. The icons are one
  family: a 48 px grid, 1.75 px strokes, round caps, the brand navy with one
  water-blue accent.
- **How it works**, **Why trust it** (`HowItWorks.svelte`, `Trust.svelte`):
  three steps; four plain statements (no borrowed logos: no CHIRPS or DWS
  marks) and three example figures that count up once in view (the real figure
  is what assistive tech reads).
- **Texture**: the contours at 5 % behind the hero and the footer, drifting a
  pixel or two over 40 s; a meandering river line between sections instead of
  rules.

## Motion principles

1. Motion explains water moving through the system; nothing moves just to decorate.
2. One thing moves at a time in any viewport. The hero's loop is slow and
   rests; transitions are 250–400 ms, ease-out.
3. `prefers-reduced-motion`: every animation has a designed still frame. The
   hero rests on its last frame (the dams full, the rivers lit, the tag shown),
   which is also what the prerendered HTML shows before any script runs; the
   story's steps switch without transitions; the icons are drawn; the figures
   are final. The sliders still work.
4. CSS, SVG and a few lines of script only: no GSAP, Lottie, Three.js or video.
   Only `transform`, `opacity`, `stroke-dashoffset` and a scale animate. The
   hero pauses off screen and when the tab is hidden.
5. The copy is readable at first paint; motion starts after load.

## Quality bar

- [x] Art pipeline: `pnpm gen:landing-art` from committed sources (Blender,
  Inkscape, ImageMagick, avifenc, FontForge, Playwright, the engine).
- [x] Reduced motion: the page is complete with motion off (landing.spec.ts
  checks the still frame; screenshots at 1440/390 in light and dark).
- [x] a11y: the animated SVGs are `aria-hidden` with text equivalents (the
  hero picture's alt, each chart's summary, the figures' real values), the
  sliders are labelled with value texts and the results are announced; axe
  scans at desktop and phone, light and dark (landing.spec.ts).
- [x] Copy: plain, specific; figures are named as the example catchment's where shown.
- [x] Bundle: the landing is its own chunk (no workspace, no uPlot, no engine),
  guarded by `scripts/guards/check_web_bundle_budget.mjs`.
- [ ] Prototype and operator review: the operator chose to review the built
  page directly rather than a prototype first (2026-09-27).
- [ ] Lighthouse ≥ 95, LCP < 2 s on throttled 4G: to measure against the
  deployed site (plan.md Phase 6); not measurable on the local static server.
