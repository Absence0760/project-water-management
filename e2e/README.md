# End-to-end tests (Playwright)

Browser tests for the whole app: the SvelteKit frontend, the Hono backend and
Postgres. They run **fully locally**: no cloud account, and your dev servers
and dev database are left alone.

## Running

```bash
pnpm dev:db:up            # docker Postgres on :5434 (once per session)
pnpm dev:s3:up && pnpm dev:mail:up   # MinIO + Mailpit, for server-report.spec.ts, and Mailpit for alerts-mailpit.spec.ts (each skips, saying so, without them; never in CI)
pnpm test:e2e:install     # once: download Playwright's Chromium
pnpm test:e2e             # the whole suite, headless
pnpm test:e2e:ui          # Playwright UI mode (watch, time-travel debugging)
pnpm check:e2e            # typecheck the specs
pnpm test:e2e tests/model.spec.ts   # one file (extra args go to playwright test)
pnpm -C e2e e2e:list      # list the tests without running them
```

`pnpm test:e2e` does all of the setup itself:

1. **Database.** `support/global-setup.ts` connects as the schema owner, creates
   the checkout's e2e database (`water_e2e` in the main checkout; see
   [Several checkouts at once](#several-checkouts-at-once)) if it is missing, drops and recreates its `public`
   schema, and applies `backend/migrations` with the backend's own migrator.
   Every run starts from an empty schema.
2. **Servers.** Playwright's `webServer` starts the backend on **:3101** (as the
   RLS-bound `water_app` role, against the e2e database) and the frontend on
   **:7801** (in the main checkout). The frontend is a **production build**, not
   the Vite dev server: `support/build-site.ts` runs `vite build` with the
   checkout's API URL (`http://localhost:3101`) baked in as `PUBLIC_API_URL` (it
   is `$env/static/public`), written to `frontend/build-e2e/` (with
   `frontend/.svelte-kit-e2e/` as SvelteKit's working directory, both
   gitignored; any slot but 0 uses `build-e2e-<slot>/` and
   `.svelte-kit-e2e-<slot>/`) so the production output in `frontend/build/` is never touched,
   then served by `support/static-server.ts` (`support/site.ts`), which routes
   every request through CloudFront's own `spa_rewrite` function, loaded from
   `infra/s3_cloudfront.tf`, so e2e gets production's answers: the SPA fallback
   for an extension-less path, and a 404 for a file the build doesn't have. The build adds about 20 s to the start of a run.
   It never reuses an existing server, so a stray process on those ports fails
   the run loudly instead of testing the wrong build. `pnpm dev` (:7777 /
   :3001, database `water`) can keep running alongside.

   Why not the dev server: every full page load there fetches several hundred
   unbundled modules, and by the fourth `page.goto` in one test Chromium ran
   out of request resources (`net::ERR_INSUFFICIENT_RESOURCES`, "Failed to
   fetch dynamically imported module") and the page never rendered.
   `tests/repeated-loads.spec.ts` guards this. To debug against `vite dev`
   (HMR, unminified source) anyway, run `E2E_DEV_SERVER=1 pnpm test:e2e …`;
   specs that load a page many times may fail there.

### Several checkouts at once

Each checkout of the repo gets its own **slot**, and the slot picks the ports
and the database (`support/env.ts`), so two sessions can run `pnpm test:e2e`
in two worktrees at the same time:

| Checkout | Slot | API | Site | Database |
| --- | --- | --- | --- | --- |
| Main checkout (`.git` is a directory), and CI | 0 | :3101 | :7801 | `water_e2e` |
| A git worktree (`.git` is a file) | 1–98, from a hash of its path | :3101 + slot | :7801 + slot | `water_e2e_<slot>` |

`E2E_SLOT=<0–98> pnpm test:e2e` picks one by hand. Each slot also builds
into its own folder (`frontend/build-e2e/` for slot 0, `frontend/build-e2e-<slot>/`
otherwise, `env.ts` `buildDirsFor`), so parallel runs in one checkout on
different slots never replace the site another is serving. If two checkouts ever land on the same
slot, the second run stops at start-up on a port that is already in use,
before it touches the database: Playwright starts its web servers before the
global setup. Set `E2E_SLOT` in one of them. The two runs still share one
docker Postgres, so on a loaded laptop both run slower.

Locally it runs **6 workers** (`playwright.config.ts`; `E2E_WORKERS=n` for a
one-off run). They all share the one API process, which is single-threaded, so
more workers queue behind each other's heavy requests (multi-year runs, 20-run
setups) rather than finishing sooner: at Playwright's default of half the cores
(10 here) a full run on a clean main had 6 load timeouts and took 192 s; at 6
it passed in 167 s. CI is unaffected: 2 workers per shard, each shard with its
own API.

That API hashes passwords at bcrypt's minimum cost (`PASSWORD_HASH_COST=4` in
the config's server env; `backend/src/auth/password.ts`, refused on Lambda).
Every test registers at least one user, and at the production cost of 12 each
hash holds the shared event loop for ~250 ms: in a 16-spec parallel run that
was over a third of the server's time, and model saves (then ~40 round trips
each), member lists and the login error queued past their 5 s waits behind it
(issue #41). Anything that blocks this one event loop slows every worker, so
look there first when a spec only times out in a parallel run.

### CI: 14 shards

`ci.yml` runs the suite as 14 parallel jobs, `E2E (Playwright) 1/14 … 14/14`,
balanced by time rather than by count:

1. **`e2e-build`** builds the site once (`pnpm -C e2e build:site`) and uploads
   it. Every CI runner is slot 0, so the build's API URL is :3101 for all.
2. **Each shard** gets its own Postgres service, downloads the site and runs
   with `E2E_PREBUILT=1` (serve that build, don't rebuild). The config refuses a
   prebuilt site whose stamp (`e2e-api-url.txt`) names another API URL.
   It plans its tests first (`support/shard-list.ts N/14 <file>`, then
   `playwright test --test-list <file>`; see "Balancing the shards" below).
   Chromium is cached by Playwright version; only its apt libraries install on
   every run, from `.deb`s cached per runner image (`apt-debs-e2e-…`), since
   Azure's Ubuntu mirror throttles 14 shards fetching them at once (one took
   7 min 21 s for 32 MB). `E2E_BLOB=1` writes a blob report, and failure traces upload as
   `playwright-results-<shard>`.
3. **`e2e-report`** merges the blobs into one HTML report
   (`playwright-report` artifact), whether or not a shard failed. When every
   shard passed it also checks that each test in the suite ran on exactly one
   shard, and uploads the run's per-test timings as the `e2e-timings`
   artifact (30 days).

All three are in the `CI gate`'s `needs`. To reproduce one shard locally:
`node support/shard-list.ts 3/14 /tmp/shard.txt && pnpm exec playwright test --test-list /tmp/shard.txt`
(from `e2e/`).

#### Balancing the shards

Playwright's `--shard=N/14` cuts the suite into equal counts of tests in
file order, so the shard that drew the slow a11y and phone-layout specs took
four times as long as the lightest (39 s to 165 s of test time in September
2026). Instead every shard plans the whole suite (`support/shards.ts`):
`playwright test --list`, each test's duration from the committed
`shard-timings.json`, then largest first onto the lightest shard. A file
with `test.describe.configure({ mode: 'serial' })` or `'default'` anywhere
stays whole on one shard. A test with no timing yet is planned at the
median, so a new spec costs a little balance, never coverage; the plan is
deterministic, so the 14 shards agree without talking to each other.

When the shards drift apart (compare the `E2E tests` step times on a run;
each shard's `Plan this shard` step prints the planned range across all
shards), refresh the timings from the newest green run on main and commit
the file:

```bash
pnpm gen:e2e:timings
```

`--test-list` splits a line on `›` and trims each part, so a test title
can't contain `›` or start or end with a space; the plan refuses such a
title rather than silently dropping the test.

Only Chromium is configured. On Fedora, Playwright prints "your OS is not
officially supported" and downloads its Ubuntu build, which runs fine here.
`playwright install-deps` is apt-only, so it doesn't work on Fedora, and you
don't need it. CI (Ubuntu) caches the browser and runs `playwright install-deps chromium`
(`install --with-deps` on a cache miss).

Failures keep a trace and a screenshot under `e2e/test-results/`. Open one
with `pnpm -C e2e exec playwright show-trace <path>/trace.zip`.

### Fonts: the same on every machine

The browser sees only the DejaVu fonts in `e2e/fonts/` (`fonts.conf`, passed
to Chromium as `FONTCONFIG_FILE` in `playwright.config.ts`), so a laptop lays
text out exactly as CI does. The body text is `system-ui`, which is a
different font on each machine (Noto Sans on Fedora, DejaVu Sans on the
Ubuntu runner, which sets text wider), and layout checks such as "one row",
"the bar has no More" or "the page doesn't scroll" used to pass locally and
fail in CI (issue #162). `tests/fonts.spec.ts` fails if the pin stops reaching
the browser. Nothing to install: the font files are committed (DejaVu's
licence is `fonts/LICENSE-DejaVu`). The display face, Outfit, is a web font
and the same everywhere anyway. When a layout check fails, fix the layout or
measure what fits; don't widen a margin until it passes on one machine.

## Layout

| Path | What |
| --- | --- |
| `playwright.config.ts` | Web servers (backend + built frontend; `E2E_DEV_SERVER=1` for `vite dev`, `E2E_PREBUILT=1` to serve an existing build), `timezoneId: 'UTC'`, no retries, blob reports for CI shards (`E2E_BLOB=1`) |
| `support/env.ts` | The checkout's slot, and from it the ports and database URLs (dev-only docker credentials); `env.test.ts` tests the slot (`pnpm test`) |
| `support/build-site.ts` | Builds the site under test with the checkout's API URL baked in (`pnpm -C e2e build:site`) |
| `support/shards.ts`, `shard-list.ts`, `shard-timings.ts`, `../shard-timings.json` | CI's time-balanced shards: the packing (tested by `shards.test.ts`), one shard's `--test-list`, the report job's check and timings, and `pnpm gen:e2e:timings` (§ CI) |
| `support/global-setup.ts` | Rebuilds the checkout's e2e database |
| `support/api.ts` | API helpers for arranging state (users, projects, model, series, runs) plus a small synthetic catchment |
| `support/db.ts` | Plants reset / verify / invite link tokens straight into the e2e database (as the owner). Mail goes to the backend log in e2e (`MAIL_TRANSPORT=log`) and the database keeps only token hashes, so a spec that follows an emailed link plants one whose plaintext it knows. `plantLegacyRun` turns a run into a stored legacy-runoff run (engine < 1.0.0), which the API can no longer make |
| `support/static-server.ts`, `support/site.ts` | Serves the e2e frontend build on the site port, routed by CloudFront's `spa_rewrite` function itself (run from `infra/s3_cloudfront.tf` through `infra/scripts/cloudfront-functions.mjs`, so the two can't drift): `index.html` for an extension-less path (the SPA fallback), `/welcome` and the other prerendered pages from their HTML, the build's files as they are, the function's 404 page for a path with an extension outside the build's file locations (`/nope.pdf`), and a plain 404, as S3 answers, for a missing file inside them. `support/site.test.ts` (`pnpm -C e2e test`) pins each case. No dependencies |
| `support/a11y.ts` | The shared axe scan every spec uses (`expectNoViolations(page, { tags?, rules?, include? })`, WCAG 2.0–2.2 A/AA tags by default; don't call `AxeBuilder` directly). It runs `axe.run()` in the page (legacy mode) and keeps node details for violations only: the default `runPartial` mode opens a blank page per scan and ships every passing node across the protocol, 2–3× slower (the glossary 5.5 s → 2.3 s). Legacy mode skips cross-origin frames, and the app has none, so the scan refuses a page with a frame |
| `support/fixtures.ts` | `owner` (a fresh user signed in to `page`) and `signIn(name)` (another user in their own browser context) |
| `fixtures/*.csv` | Synthetic daily rainfall and observed flow: a 92-day pair (ISO dates; DD/MM/YYYY with one gap) and a two-water-year pair for the golden path, with a two-year daily A-pan (`apan-2y.csv`) beside it; `farmers.csv`, a synthetic bulk farmer invite (`email,farm,language`) with a two-farm address, an unknown farm and a bad address |
| `tests/golden-path.spec.ts` | The new-user journey, in four tests ([The golden path](#the-golden-path)): register, create "Catchment D", build the network, upload two years of rain, flow and daily A-pan, run the model and read the results, all through the UI; then, on that catchment arranged through the API, crops and a transfer into a run and each unit's results; monthly A-pan and EWR into the run's summary, and a reload; two more catchments beside one with a run |
| `tests/landing.spec.ts` | The public landing page (issue #57): a signed-out `/` shows it and its buttons lead to sign-in and sign-up; a signed-in `/` is still the project list; other signed-out routes still go to `/login?next=`; `/welcome` is prerendered HTML with its description, Open Graph and canonical tags and the social card; the what-if answers from the generated grid in words and figures; the hero moves only with motion allowed, pauses off screen and rests on its still frame otherwise; axe at desktop and phone in light and dark, no sideways scroll; Afrikaans |
| `tests/legal.spec.ts` | The legal pages (`/privacy`, `/terms`): prerendered HTML naming the operator and contact (and, for privacy, the Information Regulator and the hosting region); open signed out and in; axe and no sideways scroll at desktop and phone; linked from the landing footer, the sign-in pages' Legal nav and the sign-up form's sentence; the methods page (`/methods`): prerendered with the engine version, the known limitations and the full audit's link, linked from the trust strip and footer, axe light and dark at desktop and phone |
| `art/landing-screens.spec.ts` | Not part of the suite: `pnpm gen:landing-art` runs it (`art/playwright.config.ts`, the e2e servers) to capture the app screens the landing page shows, from the seeded example catchments, light and dark |
| `tests/auth.spec.ts` | Register, sign out and in, wrong password, deep link → login → back, open-redirect guard; "Forgot password?" → request acknowledged; reset link → new password works (also opened while signed in; spent link); confirm-email banner cleared by the link, and the link working signed out |
| `tests/projects.spec.ts` | Create several projects, copy one (with its model), delete, roles in the list; data-freshness badge, last run and the editors-only "Add data" link (`?add=data`); the list and the workspace header count the same local days under a UTC+14 clock |
| `tests/project-import.spec.ts` | Import project file (.json) on the project list: an invented example catchment (built by the seeding code) into a team with a first run; an imported project exports back to the same series; a non-JSON file refused in the browser and an invalid one refused by the server with nothing created; axe on each dialog step in light and dark; full width on a phone |
| `tests/workbook-import.spec.ts` | Import b023 workbook on the project list (WP-1.31): the committed synthetic workbook read in the browser's worker; the review's counts, importer notes and unmapped report (Echo Farm's hand-written InOut formula); the gauge-as-reference option re-extracting in place; import with a first run, the project opens with a run summary and its series equal the Python importer's output; a non-b023 `.xlsx` (built in the test) names the ranges it lacks and a non-workbook is unreadable, nothing created; closing the dialog mid-import leaves a reopened dialog alone; a farm name that is an HTML payload shows as text; axe on the review in light and dark; full width on a phone |
| `tests/farmer-invites.spec.ts` | Farmer invites (WP-2.2): an owner invites one farmer from the Overview's Invite farmers dialog, the invite is pending in the Farmers panel (not the Members panel), the farmer signs up through the link and lands on the farm view with exactly that farm; a CSV upload previewed row by row (line, outcome, per-row errors, nothing sent), then sent, one invite per address; axe on the dialog in both modes |
| `tests/sharing.spec.ts` | Owner shares with a viewer (read-only everywhere, unshared project → not found); editor rights; inviting an address with no account (pending list, re-send throttle, revoke); signing up through an invite link lands in the project; a dead invite link falls back to plain sign-up; an invite link opened while signed in (another account: sign out and accept; own unconfirmed address: confirm first; dead link) |
| `tests/model.spec.ts` | Build gauge + farms, crops, planted areas, a transfer; save; reload. Second outlet and loop block saving; unsaved-changes guard; thousands separators in the one-node form and the view-only table |
| `tests/model-phone.spec.ts` | On a phone, crop factors, planted areas and a transfer rule render as cards with every field on screen; a desktop keeps the crop and transfer tables' column headers |
| `tests/settings.spec.ts` | Monthly A-pan and EWR save and reload; discard; date validation |
| `tests/settings-drought-restriction.spec.ts` | Settings › Drought restrictions (engine 1.46.0, WP-3.8): on from the template, a deeper level cutting less blocks Save, a level removed and a review date added saved whole, a viewer reads it disabled, off saves null; axe at desktop and phone, the level cards stacked with no sideways scroll |
| `tests/drought-restrictions-run.spec.ts` | Drought restrictions in use (engine 1.46.0): a scenario's "Change a setting" sets the rule (a baseline assumption); an outlook's review triggers saved as the project's rule, then the panel says it is the rule; a run under it shows the Units & supply tables and menu entry; axe, no sideways scroll at phone width |
| `tests/auto-calibration.spec.ts` | Fitting GR4J fills the form and only Save stores it; turning on groundwater exchange offers X2 without resetting the other ticks; a fit can be cancelled; a viewer can fit but not apply; with a gauge and a logger record, the fit can be validated against the other one |
| `tests/fit-provenance.spec.ts` | An applied fit is saved with its record, and the run shows which fit and validation produced its parameters; hand-editing a fitted parameter marks the fit record as edited (form, run, run comparison); a calibration exclusion needs a reason and shows in What changed and on the run |
| `tests/series.spec.ts` | Upload rainfall + observed-flow CSVs, preview, chart; malformed CSV |
| `tests/series-preview.spec.ts` | A row's Preview opens the daily table (search narrows it, Escape closes and returns focus); the card header's "Preview data" opens every column with a column picker to hide one; the preview fills the viewport and renders rows to the bottom of its taller scroll box; the column picker keeps each checkbox beside its label |
| `tests/data-quality.spec.ts` | Gauge-vs-logger thresholds are a project setting the Time series tab applies; the tab flags zero-rain runs and water years far below CHIRPS; a flagged zero-rain run is shaded as missing until Settings keeps it as recorded |
| `tests/escape.spec.ts` | The "Data up to" dropdown closes on Escape and on an outside click; Add data closes the same way, but asks first when a file has been read and not uploaded |
| `tests/runs.spec.ts` | Run the model: run listed, farm summary table, charts, persisted; the result-sections menu lands each panel below the sticky header |
| `tests/publication.spec.ts` | An editor publishes a run from the Runs tab through the confirm dialog (with the no-stop-level warning and a notice), the run gets its Published tag and loses its delete button, the notice changes without re-publishing, and a linked farmer reads the published figures and notice through the farm API (WP-2.3) |
| `tests/share-links.spec.ts` | Read-only share links (WP-2.3 phase 2): an owner makes a link on the Overview's Share links panel and copies it; opened signed out in a fresh phone context it shows the reserve status and the WUA's notice in under 2 s, the token gone from the address bar, no farm name or note, and the flow chart (five farm holders); the list records the visit; withdrawing it gives the dead-link state (the same tab, only the fragment changed); a two-farm catchment gets no chart; a link without its token; axe on the panel and on `/share` in light and dark |
| `tests/runoff-model.spec.ts` | GR4J is the only runoff model (engine 1.0.0): Settings has no model picker and no legacy parameters, GR4J's parameters save and a new run reports the runoff balance with no legacy badge; an old legacy run (planted in the database with `support/db.ts` `plantLegacyRun`, as the API can't make one) opens badged Workbook comparison, with no runoff model panel, and can't be nominated, published or signed off; run comparison shows it against a GR4J run; GR4J without A-pan evaporation is refused with the reason, after Settings warns |
| `tests/gr4j-pe.spec.ts` | GR4J's PE input (issue #39): switching to a monthly PE row starts it from pan coefficient × A-pan and hides the pan coefficient; Save waits for a source; a lower monthly row saves, reloads, lowers the run's PET and raises natural flow, and leaves irrigation demand the same on every farm and day; the FAO-56 Table 5 helper waits for every month and a source, then fills the pan-coefficient row without saving |
| `tests/chirps-bias.spec.ts` | A run lists the CHIRPS bias-correction factors it applied, and Settings can turn the correction off |
| `tests/self-checks.spec.ts` | A run shows its self-checks, its water balance and a traced day that closes |
| `tests/wr2012.spec.ts` | Entering WR2012 reference data is checked for plausibility, saved, and every run reports against it; run comparison lists the WR2012 inputs that changed and compares the ratios |
| `tests/overview.spec.ts` | Overview checklist and headline counts (fresh and complete projects), counts updating after "Add data" on the tab, a long member email wrapping at its break points on a phone |
| `tests/auth-layout.spec.ts` | The split sign-in / register layout beside a classic 15 px scrollbar (`html { overflow-y: scroll }`), desktop and phone, light and dark: no sideways overflow, full-height brand panel, gutter in the form's colour; saves a screenshot of each |
| `tests/examples.spec.ts` | Seeds the invented example catchments (`backend/scripts/seed-examples.ts`, once per run) and checks both demo users' lists and roles (owned, team-shared, directly shared) and a read-only shared example with its seeded run, and the seeded farmer reading their published farm and Sandspruit's advisory notice |
| `tests/teams.spec.ts` | A team owns catchments together (add a colleague, create in the team, both lists, filters); the last admin can't leave; inviting an address with no account and revoking it |
| `tests/help.spec.ts` | The in-app help system: network-table tips stay unclipped and close on Escape/outside click, neighbouring tips show a close-up with the feature ringed, the sidebar follows the section being read (folding behind a button on a phone), the catchment tour links picture markers to their stops, a guide shows a close-up with its own numbered stops and its diagrams and links into the glossary, search finds guides and glossary terms as you type, an old `/help#term` link lands on the glossary entry, and an unknown guide says so and links back to help |
| `tests/repeated-loads.spec.ts` | Six full loads of the Settings tab in a row, with no failed request or page error (the dev-server resource-exhaustion regression) |
| `tests/a11y.spec.ts` | axe WCAG 2.2 A/AA scan of every page (sign-in pages, emailed-link dead states, project list, teams, a team, help, compare), every workspace tab, dialogs, save bar, one-node form, view-only workspace and a signed-in invitation, in light and dark; GR4J settings with a monthly PE row; every tab again at phone width; sideways-scrolling boxes take focus and scroll by keyboard. One page state per test, so each scan has the 30 s budget to itself; a positive control proves the scan still reports violations; every tab (desktop and phone) and a GR4J run are also checked for axe's `empty-table-header` and `landmark-unique` |

## Rules for writing specs

These follow the project rules in `CLAUDE.md`. Keep to them:

- **Every test makes its own users** through the API (`owner`, `signIn`,
  `register`). Tests share nothing and run fully in parallel against the one
  database. Don't depend on another test's data or on the order tests run in.
- **Arrange through the API, act through the UI.** Only drive the UI a test is
  actually about. Everything else goes through `support/api.ts`.
- **Wait on real UI signals**: a heading, a status message, a table row, an
  `aria-current`, a response (`page.waitForResponse`), an app readiness
  attribute (a chart's `data-ready`; after a resize, the Network map's
  `data-fit` through `waitForMapFit` in `support/diagrams.ts`). Never use
  `networkidle`, never `waitForTimeout`, and never inflate a timeout to get past
  a slow step. Fix whatever is slow.
- **Measure layout (page height, box positions) only after the page's
  readiness attribute** (the Summary's `data-ready`, a section's
  `data-notes-ready`, a chart's `data-ready`): a region that is visible while
  it loads isn't at its final size, and the page grows as its neighbours
  fill in. See `docs/design/ui-playbook.md` § Testing.
- **Select by role and accessible name** (`getByRole`, `getByLabel`). If an
  element can't be reached that way, fix its accessibility in the component
  (a label, an `aria-label`) rather than reaching for CSS or a test id.
- **No retries** (`retries: 0`). A flaky test is a bug. Find the race.
- **A background job runs only in its own test's tick.** The e2e backend has
  no worker; `runJobsTick({ projects: [project.id], schedule: false })`
  (`support/jobs.ts`) runs one tick of `backend/src/jobs/worker.ts` that
  claims only the named projects' jobs (`--project`, `app_claim_jobs`'
  scope, 123_scoped_job_claim.sql). `projects` is required: a tick that
  claimed every due job in the shared database ran other tests' freshly
  queued jobs, so a test asserting "Queued" (a yield, a sweep, an outlook, a
  due re-run) saw "Running…". Pass `schedule: false` unless the test needs
  the feed schedule (only `data-feeds.spec.ts`, which runs its tests one at
  a time because that schedule looks at every project).
- `timezoneId` is pinned to `UTC`, so date output is deterministic.
- **Fixtures are synthetic.** The repo is public, so never commit client names,
  values or workbook-derived data.
- A spec that finds an app bug gets the fix in the app, in its own commit.
  Never loosen the assertion to make it pass.
- **One test, one 30 s budget.** A test drives at most a few dozen UI steps.
  Every step costs ~30 ms of Playwright's own work on an idle laptop (a
  `getByLabel` walks the DOM; a fill is ~25 ms, almost none of it in the app)
  and three to four times that beside five other workers, so a long journey
  fails on its length alone. Split it, arranging each later part through the
  API (below).

### The golden path

`tests/golden-path.spec.ts` was one test: register, build Catchment D through
every screen, run it, read the results, reload, add two more catchments, about
165 UI steps. It went past Playwright's 30 s budget in 2 of 24 runs beside the
model, scenarios, runs, transfers-page and diagram-labels specs at 6 workers
(issue #138). The traces showed no slow step: 7 s alone, 15–24 s in that mix,
with the time spread evenly over the steps (settings' 24 fills 1.1 s → 3.6 s,
the network 0.7 → 2.1 s, registering 0.7 → 2.6 s). Its 103 API requests took
1.5 s in all alone and 5–7.5 s in the mix; the slowest, the model run, 0.2 s
and 0.9 s. A CPU profile of twelve Settings fills (~300 ms) put ~5 ms in the
app's code, no long tasks, and a third in Playwright's selector engine
resolving `getByLabel`; the rest was idle and protocol round trips. There was
nothing in the app to fix.

It is now four tests, each well inside the budget:

| Test | Through the UI | Arranged through the API |
| --- | --- | --- |
| a new user builds a catchment through the UI, runs it and reads the results | register, new project, the network, save, upload rain, flow and daily A-pan, run, the summary, calibration and chart | nothing |
| crops and a transfer … feed a run and each unit's results | a crop, planted areas, a transfer, save, run, Units & supply | the catchment, its data and monthly A-pan (`seedCatchmentD`) |
| A-pan and EWR, entered in Settings, feed the run's summary … after a reload | monthly A-pan and EWR, run, the plain-words summary, reload | the catchment with its crop and transfer, and its data |
| a user with a catchment adds more catchments … | two new projects, the list, reopening the first | a runnable catchment and its run |

The first still does a new user's critical path through the UI alone, so a
UI-built model that the API would build differently still reaches a run. What
the split gives up: no single test enters every screen's data and then runs
it, so crops typed into the UI and A-pan typed into Settings each reach a run
only in their own test. Each of those tests checks its screen's effect on the
run, which is what the one journey checked too.

Measured on the same laptop, 6 workers, `--repeat-each=5 --retries=0`, beside
model, scenarios, runs, transfers-page and diagram-labels (other sessions
running too, load average 16–20 on 20 cores):

| | Longest golden-path test | Result |
| --- | --- | --- |
| Before (one test) | 7.0–23.3 s, median 20.3 s (37 s and two timeouts in a heavier run) | 230 passed |
| After, run 1 | 9.4–10.6 s, median 10.3 s (the others ≤ 8.4 s) | 245 passed |
| After, run 2 | 7.6–11.6 s, median 11.0 s (the others ≤ 10.7 s) | 245 passed |

Alone, the four take 4.6, 3.6, 3.2 and 2.2 s, against the one test's 9.3 s in
the same run.
