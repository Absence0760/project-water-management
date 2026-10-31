# Client navigation can render a route before its CSS has loaded (double loader call + Vite preload `seen` map)

> **Status (2026-10-30): resolved upstream, not filed, workaround removed.** Vite fixed the cause in 8.3.4 (vitejs/vite#23662, issue #23652): the preload helper's `preloadOnce` now stores the in-flight promise in `seen` and returns it to later callers, so SvelteKit's second loader call waits for the CSS the first call is loading. SvelteKit's double loader call is harmless once Vite waits. `frontend/package.json` pins `vite` 8.3.4, and the root layout's `onNavigate(() => stylesheetsReady())` workaround (`lib/nav/stylesheets.ts`) is gone. See "Workaround we shipped (removed)" below for the evidence. The report below is kept as the record of the cause.

**Where to file:** `sveltejs/kit` (the double call is SvelteKit's). Cross-reference in `vitejs/vite`, because the preload helper's memo is what drops the wait.

## Versions

- `@sveltejs/kit` 2.61.1, `svelte` 5.56.x, `vite` 5.4.0, `adapter-static` (SPA, `ssr = false`)
- Chromium via Playwright 1.63
- In the Vite `main` source, the preload helper still has the same `if (dep in seen) return` early exit.

## What happens

During a client-side navigation to a route whose CSS chunk hasn't loaded yet, the new page can render (and run its effects) **before its stylesheet has loaded**. For a moment the page is unstyled, and anything the page measures then is wrong.

In our app, the glossary scrolls to `#term` after it renders. When the race hit, the scroll ran against the unstyled layout: the entry's `scroll-margin-top` was `0px` and the entries above it were about 3,000 px taller. The page landed at the end of the document, and the CSS arrived a few milliseconds later.

## Why

1. `load_route` in `src/runtime/client/client.js` warms up every node's module:
   `loaders.forEach((loader) => loader?.[1]().catch(noop));`
2. `load_node` then calls the same loader again: `const node = await loader();`
3. In a production build each loader is `() => __vitePreload(() => import('./nodes/N.js'), deps)`. Vite's preload helper stores each dep in a module-level `seen` map:
   ```js
   if (dep in seen) return;
   seen[dep] = true;
   ...
   if (isCss) return new Promise((res, rej) => { link.addEventListener('load', res); ... });
   ```
   The first call inserts the `<link rel="stylesheet">` and waits for it to load. The second call finds the dep in `seen`, returns `undefined` for it, and resolves as soon as `import()` resolves.
4. SvelteKit renders from the second call's result, so rendering waits for the JavaScript but not the CSS. When the CSS is slower (a loaded machine, a slow or lossy link, a cold CDN edge), the route paints unstyled.

## Reproduction

Any route with its own component CSS, reached by a client navigation while the machine is under load (for example many Playwright workers):

- Log `getComputedStyle(el).scrollMarginTop` (or any value the route's CSS sets) from a `MutationObserver` when the route's first element is inserted.
- In our runs, 1 to 6 in about 40 navigations showed the unstyled value, and the `<link>` for the route's CSS fired `load` only after the page had rendered.

A trace from one failing run (times in ms from page start):

```
84.4   link+ 15.Ds3sFQPt.css          <- inserted by the warm-up call
145.2  first render; element has scroll-margin-top: 0px
180.5  link loaded 15.Ds3sFQPt.css    <- CSS arrives after the render
```

## Expected

A client navigation shouldn't commit until the target route's CSS has loaded, the same as the first `__vitePreload` call already guarantees.

## Possible fixes

- **SvelteKit:** keep the warm-up promise and reuse it in `load_node` (for example, memoise `loader()` per navigation) so that the promise that waits for the CSS is the one that gets awaited. Or, before committing a navigation, await the CSS the route's nodes declare.
- **Vite:** store the pending promise in `seen` and return it on later calls (`seen[dep] = promise`), so every caller waits for the same CSS load. This would also fix other code that preloads a module twice at the same time.

## Workaround we shipped (removed 2026-10-30)

From 2026-09-26 the root layout had:

```ts
onNavigate(() => stylesheetsReady());
```

`stylesheetsReady()` resolved once every `<link rel="stylesheet">` without a `.sheet` had fired `load` or `error`, capped at 10 s. SvelteKit awaits `onNavigate` before updating the DOM, and by then the loaders had already inserted the route's links. It didn't cover the first page load (no `onNavigate` runs then; `lib/help/anchor.ts`'s `holdAnchor` covers the glossary's).

**Why it went.** With Vite 8.3.4 it adds nothing:

- The installed helper (`vite/dist/node/chunks/node.js`, `preloadOnce`) returns `seen[href]`, the pending promise, to every later caller, and clears it only when the stylesheet has loaded or failed. Every Vite-preloaded stylesheet is therefore awaited by the loader SvelteKit renders from, and `load_route` finishes before `onNavigate` runs, so by then the route's CSS has already arrived.
- The slow-link case is covered by the same wait: Vite waits for the CSS however long it takes. The workaround's 10 s cap never helped there, because `onNavigate` only runs after the loaders resolve.
- The app inserts no stylesheets of its own; every one comes through Vite's preload.
- Evidence (2026-10-30, a Playwright probe that held every `.css` response 1.5 s, then client-navigated from `/help/glossary` to a topic and read the first entry's `scroll-margin-top` when it entered the DOM; 5 runs each):
  - Vite 8.3.4 with the workaround: styled (14px) 5/5, rendered ~1.56 s after the click.
  - Vite 8.3.4 without it: styled 5/5, ~1.56 s: Vite alone holds the navigation.
  - Control, the helper patched back to the pre-8.3.4 `if (href in seen) return; seen[href] = true` memo: unstyled (0px) 5/5, rendered ~45 ms after the click.
  - `help.spec.ts` (24 tests) green with and without the workaround.

**The guard now.** `e2e/tests/help.spec.ts` › "a client navigation waits for a slow stylesheet before showing the page" is that probe as a test: it passes on 8.3.4 and failed 5/5 against the pre-8.3.4 helper. If a Vite or SvelteKit upgrade brings the race back, it fails there.
