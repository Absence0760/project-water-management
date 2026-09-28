# Evidence report prototype (source)

The mock-up for the [licensing evidence report design](../evidence-report.md)
(issue #15), also published as a private claude.ai page,
[Licensing evidence report](https://claude.ai/artifact/3w5pxaf9NpmAKmp9ehRpTM)
(private until the operator shares it from its Share menu). It is committed
here so the design can be reviewed and diffed without claude.ai. Synthetic
data only.

| File | What it is |
| --- | --- |
| `evidence-report.html` | One self-contained page: two in-app boards (1: the draft preview with its issue checks; 2: the refusal for a run that isn't evidence), then the report's six A4 sheets. Open it in a browser. Printing it (A4, no margins, background graphics on) gives the A4 PDF mock-up: six pages. The sheets stay light in dark mode, as the app's print does. |
| `figures.ts` | Prints every figure the mock-up shows, as JSON, from engine runs of the synthetic Sandspruit example: `pnpm -C backend exec tsx ../docs/design/evidence-report-prototype/figures.ts [members] [seed]` (defaults 300 and 4242, about 30 s). |

What `figures.ts` runs: Sandspruit with a **synthetic Reserve rule table**
at the outlet (the example has none; each point is a fixed share of the
run's own natural flow, so it is plausible and invented), as the "published
baseline"; an application that raises Vaalbank's dam from 350 000 to
600 000 m³ and adds 40 ha of maize (two proposal ops); a 300-member
behavioural ensemble on the baseline; and the paired band on
application − baseline. The chart data in the page's `<script id="figures">`
block is pasted from its output.

Illustrative, not from the engine: the ensemble ids and the ledger of
starts, the nomination history rows, names such as "A. Modeller", the git
SHA, and anything in `[square brackets]` (the authority, the consultant,
the D10 disclaimer, the issued manifest hash). The draft's footer code is
the ops hash standing in for the manifest hash.

Re-run `figures.ts` after an engine change and update the page if a figure
moved. If the page is edited on claude.ai, copy it back here in the same
change as any spec edit, so the two don't drift.
