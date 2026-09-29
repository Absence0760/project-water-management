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
| screens | Playwright | `e2e/art/landing-screens.spec.ts` on the e2e servers, `pnpm seed:examples` data | the Summary (1440 × 900), Network and River & reserve (1280 × 800) as the demo hydrologist, the farm view (390 × 844) as the demo farmer, light and dark, on a pinned day (below); ImageMagick frames them (the frames' screens are transparent holes, so the screenshot goes under the frame; the phone's camera sits in the bezel, not over the screen, where it covered the farm view's EN button) |
| data | the engine | `backend/scripts/landing-data.ts` on the Kleinberg example | `data.generated.ts`: the story's charts (one water year by week), the what-if grid (7 orchard sizes × 5 dam sizes, 35 runs) and the example run's calibration NSE |
| (always) | node | `scripts/landing-art/modules.mjs` | `art.generated.ts`: the hero's size and placeholders, the overlay, the framed screens' sizes, the icons' and divider's path data; it **fails the run if the hero's outermost rows or columns hold anything** (the block ran off the camera's frame) |

The screens step needs `pnpm dev:db:up` (it runs on the e2e database, which it
rebuilds, and seeds the examples there). Working files go to
`scripts/landing-art/.work/` (gitignored), so a partial run can still write the
module.

**The screens are taken on a pinned day**, 3 January 2025: three days after
the examples' record ends (31 December 2024), inside the app's 7-day freshness
window. Taken on the day the seed ran, every screen warned that the rain was
20 months old ("Recorded rain ends 20 months ago", an amber rain pill, "ask
your WUA if newer figures are coming"), which is true only of the seed's age
and not what a kept-up catchment looks like. The browser's clock is pinned
(`page.clock.setFixedTime`); the server stamps the farm view's publication and
judges it stale by its own clock, so the spec answers that one request as the
server would on the pinned day (published that morning, stale by the server's
own 7-day rule).

**The hero camera frames the whole block.** At 42 mm the block's front corner
fell 16 % of the frame below the bottom edge, and the crop's clamp cut it off
(a flat bottom where the corner should be). The camera is now at 35 mm, aimed
lower (`diorama.py` `HERO`), which puts the block between 3 % and 95 % of the
frame's height; `modules.mjs` refuses a hero with anything on its edge, so a
change to the scene or the camera that clips it again fails the run.

**Only invented data.** The screens come from the example catchments, never the
client catchment (CLAUDE.md rule 11). Where a figure is shown it is named as the
example catchment's (the gauge tag, the story's intro, the what-if); the page
carries no separate "invented data" disclaimers (the operator's call,
2026-09-27).

**The figures are honest.** The hero's tag ("Reserve not met on 59 % of days", framed as "not met" like every EWR figure in the app, issue #162) and
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
  from the waterline), the gauge's needle settles. The gauge's tag, the
  example's reserve figure, never moves: it is text to read (it used to fade
  in for the loop's last ~3 s, so it was hidden 76 % of the time; issue #51).
  One loop is about 10 s, then 4 s of rest. A round **pause** toggle
  (*Pause the animation*, `aria-pressed`) sits in the art's bottom-right
  corner wherever the scene can move: pressed, the scene shows its still
  frame until pressed again (WCAG 2.2.2 Pause, Stop, Hide: the loop runs
  longer than 5 s).
  Every loop starts 11.2 s in (80 %, inside the rest), which is exactly the
  still frame the prerendered page shows, so the moment the script turns
  motion on nothing moves; the rest runs out and the rain starts. (It first
  started at 0 %: the dams emptied, the rivers went dark and the tag vanished
  the instant the page hydrated.) On a
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
  audiences, each icon drawing itself on once in view. The icons wait undrawn
  only once the script has run and motion is allowed (`armed`, set on mount,
  as `Screens.svelte` does for its rise): before that, without script and
  under reduced motion they are simply drawn. They were drawn in the HTML and
  blanked when the draw began, a flicker. The icons are one
  family: a 48 px grid, 1.75 px strokes, round caps, the brand navy with one
  water-blue accent.
- **How it works**, **Why trust it** (`HowItWorks.svelte`, `Trust.svelte`):
  three steps; four plain statements (no borrowed logos: no CHIRPS or DWS
  marks) and three figures under "From Kleinberg, an invented example
  catchment:" that count up
  once in view (the real figure is what assistive tech reads): the years and
  days of the example's run, and how closely its fitted model follows its
  weir's measured flow, the run's calibration NSE (0.87, labelled in plain
  words: "fit to the measured river flow (1 is perfect)"), taken from the
  engine by `landing-data.ts` (`hero.calibrationNse`), never typed in. It
  replaced "35 runs behind the what-if above", a count of work done rather
  than a reason to trust the result.
- **The engine audit's public summary, `/methods`** ("How the model is
  checked"), is linked under the trust statements and from the footer. The site
  serves it itself (prerendered, like the legal pages) rather than linking
  straight to `docs/engine-audit.md`, which is written for the engine's
  maintainers; the page links the full audit in the public source for anyone
  who wants the evidence. Its known limitations and "pending" marks come from
  the engine's generated list, so it can't drift from the audit
  ([ui.md § Methods page](../ui.md#methods-page)).
- **Texture**: the contours at 5 % behind the hero and the footer, drifting a
  pixel or two over 40 s; a meandering river line between sections instead of
  rules. The texture is vector, drawn through `<use href="…/contours.svg#contours">`
  (the file's line group, `contours.py`) in an `<svg>` of its shape
  (`ART.contours`), in `var(--text)` at 5 %. It used to be a CSS mask over a
  filled box, and a masked box counts as an image: the page-sized texture was
  the page's Largest Contentful Paint, requested only once the styles had
  resolved; drawn as vector it isn't a candidate, and the hero render is.
  landing.spec.ts checks the LCP element (phone and desktop). The `href`
  resolves against the page, so the prerendered page's relative base (`./`)
  finds the file before hydration (a `url()` through a custom property once
  asked for `/_app/immutable/assets/landing/contours.svg`, a 404);
  landing.spec.ts checks that `/welcome` loads every asset it asks for, with
  and without script, and that the texture draws.

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
   hero pauses off screen and when the tab is hidden, and the visitor can stop
   it (its pause toggle). The sign-in panel's scene (`CatchmentScene.svelte`)
   is decoration, so it has no button: it moves for under 5 s and then holds
   still (WCAG 2.2.2).
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
- [x] The first animated frame is the still frame (the hero), and nothing drawn
  in the HTML is blanked when its animation arms (the icons): landing.spec.ts
  checks both.
- [x] Bundle: the landing is its own chunk (no workspace, no uPlot, no engine),
  guarded by `scripts/guards/check_web_bundle_budget.mjs`.
- [ ] Prototype and operator review: the operator chose to review the built
  page directly rather than a prototype first (2026-09-27).
- [ ] Lighthouse ≥ 95, LCP < 2 s on throttled 4G, CLS 0: **met locally**; the
  final check is on the deployed site (plan.md Phase 6, #92). **Local
  measurement, 2026-09-28** (Lighthouse 12.8, mobile preset: simulated slow 4G
  and a 4× CPU slowdown, against `frontend/build` served **over HTTP/2 with
  gzip** and the prerendered `.html` mapping, as CloudFront does,
  `http_version = "http2and3"`, `compress = true`): `/welcome` Performance
  100, Accessibility 100, Best Practices 96, SEO 100, **LCP 1.6 s**, FCP 1.1 s,
  CLS 0, total weight 161 KB; desktop preset 100 / 100 / 96 / 100, LCP 0.4 s.
  `/methods` 100 / 100 / 100 / 100, LCP 0.9 s. The LCP element is the hero
  render (load delay 0; the ~0.5 s render delay is the app's scripts booting).
  - **Serve over HTTP/2 when measuring.** The page asks for ~40 small
    modules and 9 stylesheets; over HTTP/1.1 Lighthouse models six
    connections to the origin, which queues them and alone put LCP at
    2.4–2.7 s (the first baseline's figure, and Performance 95–97). A
    self-signed certificate and Chrome's `--ignore-certificate-errors` are
    enough locally.
  - **Best Practices 96** is the root layout's session check: a signed-out
    `GET /api/auth/me` answers 401, which Chrome logs as a console error.
    The 401 is the API's contract, so it stays; a stub that answers 200 for
    `/api/*` scores 100 but doesn't measure the real site.
  - Fixed on the way: the LCP element was the 5 % contour texture (a CSS
    mask, above), not the render, which is why preloading the render and
    inlining the stylesheets moved nothing. The first pass also found and
    fixed no `robots.txt` (the SPA fallback served HTML there) and the
    contour texture's 404 above.
