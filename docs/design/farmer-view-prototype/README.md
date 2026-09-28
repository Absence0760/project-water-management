# Farmer view prototype (source)

The screens of the [farmer view design](../farmer-view.md), as the source of
the claude.ai design canvas
([Farmer view prototype](https://claude.ai/artifact/CtCfnC9duX1ku8FwiDoGG9),
private until shared). Committed so the design is reviewable and diffable
without claude.ai access. Synthetic data only.

Each `*.dc.html` is one 360 px phone screen in the canvas's Design Component
format (plain HTML plus `{{…}}` holes filled by the small script at the
bottom); `canvas.json` lays them out. They don't open in a browser on their
own (they need the canvas runtime), but the markup reads as the screen: the
visible text, the order and the inline styles are the design.

The figures are the engine's, not made up: re-run `figures.ts` after an
engine change and update the screens if they moved.

| File | Screen |
| --- | --- |
| `Main.dc.html` | 1 · My farm. Props: `dark`, `notice` (`advisory`, `restricted`, `none`) |
| `MainDark.dc.html` | 2 · My farm in dark mode (imports `Main`) |
| `Dam.dc.html` | 3 · Dam detail |
| `Why.dc.html` | 4 · "Why about 83 %?" (curtailment explained) |
| `Loading.dc.html`, `NoPublication.dc.html`, `Error.dc.html`, `Offline.dc.html` | 5–8 · States |
| `Farms.dc.html` | 9 · A farmer linked to several farms |
| `figures.ts` | Prints every figure the screens show, from an engine run of the synthetic Sandspruit example: `pnpm -C backend exec tsx ../docs/design/farmer-view-prototype/figures.ts [farm] [end]` |

If the canvas is edited, copy the changed files back here in the same change
as any spec edit, so the two don't drift.
