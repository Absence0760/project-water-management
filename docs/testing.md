# Testing: the fast loop and the gate

Run the smallest check that proves the change while working, and
`pnpm check && pnpm test` plus the targeted DB/e2e files before committing.
The full suite (all of `test:backend:db`, all of e2e in 14 shards) runs on
GitHub Actions on every push to `main` and every PR; don't run it locally,
and never run the suites one after another. Measured on the 20-core dev laptop
(2026-09-25):

| Command | What | Wall time |
| --- | --- | --- |
| `pnpm test:changed` | typecheck the touched workspaces + `vitest --changed` for only the tests the change reaches (db tests too when :5434 is up) | seconds for a leaf change; the full suites when a shared helper changed |
| `pnpm check` | typecheck everything | ~20 s |
| `pnpm test:engine` | engine unit | ~35 s |
| `pnpm test:frontend` | frontend unit (most of it is the local-only workbook parity test) | ~40 s |
| `pnpm test:backend` | backend unit | ~15 s |
| `pnpm test:backend:db` | API + RLS against Postgres (serial) | ~1.5 min |
| `pnpm test:e2e <spec…>` | Playwright, one or a few specs | 15–60 s + build |
| `pnpm test:engine:perf` / `pnpm test:backend:perf` | wall-clock budgets, no database; the backend's also the V8 deopt stress run of the assurance of supply (`model/assurance-jit.perf.test.ts`, issue #192: 8 child processes under `node --deopt-every-n-times`, timing-dependent, so alone) | seconds; the stress run ~1–5 min |
| `pnpm test:verify` | the independent cross-check of the engine (verify/README.md): a Python model written from the docs against `runModel` on the example catchments, the probes, 12 random and 12 dense networks (every phase-2a feature in most), and its 60-mutant self-test; Python 3.14, no DB (CI's `verify` job runs 200 of each with `VERIFY_TEST_RANDOM=200 VERIFY_TEST_DENSE=200`). Run it when you change `packages/engine` or `verify/`, or the model's docs | ~2–3 min |
| `pnpm test:backend:perf:db` | wall-clock budgets against Postgres (`*.db.perf.test.ts`, the `perf-db` project): the team portfolio for 10 catchments × 60 farms under 500 ms, median of 7 (measured 41 ms); the RLS role check in a session with no user costs under 20 bare function calls (094_role_check_no_user; measured ~4); the Step 2 load checks (`runs/load.db.perf.test.ts`, WP-2.16): a 60-farm ten-year manual run and auto re-run under 10 s, measured and scaled to the Lambda's 0.58 vCPU, and 30 simulated feed days keeping `run_series` flat | ~4 min, most of it the 30 simulated days |

## Several checkouts at once

Every checkout of the repo gets its own databases, so sessions in different
git worktrees can run DB tests and e2e at the same time without touching each
other's schema:

| Checkout | DB tests | Dev | e2e ports | e2e database |
| --- | --- | --- | --- | --- |
| Main checkout (`.git` is a directory), and CI | `water_test` | `water` | :3101, :7801 | `water_e2e` |
| A git worktree (`.git` is a file) | `water_test_w<tag>` | `water_w<tag>` | :3101 + slot, :7801 + slot | `water_e2e_w<tag>_<slot>` |

`<tag>` is 16 hex digits of a SHA-256 of the checkout's real path
(`backend/src/config/checkout.ts`; the e2e workspace computes the same in
`e2e/support/env.ts`), so two paths sharing a database is negligible (64
bits). The e2e slot (1–98) comes from a registry in the repo's shared git
directory, `.git/water-e2e-slots/` of the main checkout
(`e2e/support/slots.ts`): a worktree keeps the slot it first took, no two live
worktrees hold the same one, and a removed worktree's slot is taken back.
`E2E_SLOT` still overrides it ([e2e/README.md](../e2e/README.md#several-checkouts-at-once)).

Until 2026-10-03 every name came from a hash of the path into 98 slots
(`water_test_w<1–98>`, `water_w<1–98>`, `water_e2e_<1–98>`), and three
worktrees once shared `water_test_w3`: each run dropped the others' schema
mid-run (missing tables, 500s on sign-up). Those databases are no longer used
by a checkout on the new names. Once no worktree still on an older main is
running tests, drop them in one go (list them first by leaving out `\gexec`
and the `format`):

```bash
echo "SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE datname ~ '^water_(w|test_w|e2e_)[0-9]{1,2}(_migrate)?\$' \gexec" | docker exec -i water-management-db psql -U water -d water
```

## Performance budgets

The perf targets assert wall-clock ceilings, so they are **not** in
`pnpm test` or CI (a busy machine or a parallel suite would trip a hard
ceiling with no regression) and run **alone**. A timing takes the median of 7
calls after a warm-up. A budget that needs the database goes in a
`*.db.perf.test.ts` file: the backend's `perf-db` vitest project gives it
the db project's setup and global setup (a freshly migrated `water_test…`),
so it can't run beside `test:backend:db` either. Run them when you touch
what they time: the engine's run loop, the portfolio query
(`backend/src/portfolio/portfolio.ts`; a new join or per-row subquery), or
the role functions every RLS policy calls (`app_project_role`,
`app_has_role`), or a model run's path (the engine, `runs/execute.ts`
`storeRun`, the `rerun` job; the load checks). A
budget should sit well above the measured time (the portfolio's is ~12×),
so it catches a change in the query's shape, not machine noise.

The backend `perf` project also holds one test that isn't a budget:
`model/assurance-jit.perf.test.ts` (issue #192, engine-audit.md V1) runs the
Sandspruit example in child processes under `node --deopt-every-n-times=N`
and requires every run's `supplyAssurance` to match an unstressed child's,
with the `assurance` self-check passing. A V8 miscompile once broke that
only under JIT timing, so the stress is timing-dependent and can make V8
thrash: like the budgets, it runs alone. Run it when you touch
`network/reliability.ts` and on every Node version bump. Its unstressed half,
`model/assurance-jit.test.ts`, is in `pnpm test`.

`pnpm test:backend:v8-osr` (`backend/scripts/v8-osr-stress.ts`, issue #232)
is the same stress against the engine at any git revision, built with
`git archive` and no checkout. By default it builds the last revision with
the day loop V8 miscompiled (`47e1ddb1^`), so it answers "does this Node
still have the bug?": exit 1 when a stressed run differs from the
unstressed one. `--node <binary>` tries another Node, and V8 flags go after
`--`. It takes several minutes, so it is not in CI; run it alone, before and
after a Node major bump ([upstream/v8-maglev-osr.md](./upstream/v8-maglev-osr.md)).

## The loop

1. While editing: `pnpm test:changed` (or one file: `pnpm -C <ws> exec vitest run <path>`).
2. For UI work, the e2e specs for that surface only: `pnpm test:e2e tests/runs.spec.ts`.
   Never the whole e2e suite locally; CI runs it in 14 shards.
3. Before the commit: `pnpm check && pnpm test`, plus the DB test files for
   backend or SQL you changed (`pnpm -C backend exec vitest run --project db
   src/<area>`), and `pnpm test:verify` when the engine's behaviour or
   `verify/` changed (a phase-1 or phase-2a feature that changes on purpose changes
   `verify/model.py` and docs/model.md with it). Not the whole `test:backend:db`: CI runs it. Don't re-run a
   suite after every small edit: re-run the failing file until it passes.
4. Don't pipe e2e output into `grep`/`head`/`tail`: the web servers hold the
   pipe open and the command hangs after the tests finish. Redirect to a file.
5. In a fresh checkout or git worktree, run `pnpm check` (or
   `pnpm -C frontend exec svelte-kit sync`) once before the frontend's
   vitest: `frontend/tsconfig.json` extends `.svelte-kit/tsconfig.json`,
   which `svelte-kit sync` writes, and without it every frontend test file
   fails at startup with "Could not resolve 'node:module' … Tsconfig not
   found" (Vite's dependency optimiser can't find the tsconfig).
6. A test of a runes state class (a `.svelte.ts` module whose constructor
   starts an `$effect`, like the map's layers) is a `*.svelte.test.ts`
   file: the frontend's vitest runs those in its `runes` project
   (`frontend/vitest.config.ts`, `frontend/vitest.client-env.ts`), Node with
   Vite's client transforms. Under the plain `node` environment (the `unit`
   project, every other test) Svelte compiles the module for the server,
   where `$effect` and `$effect.root` do nothing, so the constructor's effect
   never runs and a test awaiting its request waits forever. Wrap the class
   in `$effect.root(…)`, call `flushSync()` after changing its inputs, and
   pass its requests in rather than importing `$lib/api` (whose
   `$env/static/public` exists only under SvelteKit;
   `components/map/riverLayer.svelte.test.ts` is the pattern).

## Layout checks and fonts

e2e renders with the pinned DejaVu fonts in `e2e/fonts/` on every machine
([e2e/README.md § Fonts](../e2e/README.md#fonts-the-same-on-every-machine)),
so a layout check that passes on a laptop passes in CI. Before the pin a laptop
set the body text in Noto Sans and CI in the wider DejaVu Sans, and tight
checks went red only in CI (issue #162).

## Tests that need a service or a browser

A test that needs something a fresh laptop may not run (MinIO, Mailpit,
Playwright's Chromium) skips locally, with a warning naming the command
that provides it, and **fails under CI** (`process.env.CI`) instead of
skipping, so CI can never go green on a check it never ran. CI provides each
one to the job the test runs in:

| Test | Needs | CI job that provides it |
| --- | --- | --- |
| `backend/src/reports/render.db.test.ts` | MinIO + Chromium | `db-test` (starts MinIO, cached Chromium) |
| `backend/src/reports/render.origin.db.test.ts` | Chromium (no DB) | `db-test` |
| `backend/src/evidence/packs.db.test.ts` (the describes that issue a pack) | MinIO (issuing stores the reproduction bundle) | `db-test` (starts MinIO) |
| `backend/src/history/write-routes.db.test.ts` (`POST …/packs/:packId/issue` only) | MinIO | `db-test` |
| `e2e/tests/evidence-pack.spec.ts` | MinIO (it issues packs) | e2e shards |
| `e2e/tests/server-report.spec.ts` | MinIO + Mailpit | e2e shards |
| `e2e/tests/alerts-mailpit.spec.ts` | Mailpit | e2e shards |

`render.origin.db.test.ts` needs no database but is in the db project
(`.db.test.ts`) on purpose: `db-test` already needs a browser for
`render.db.test.ts`, so it is the one vitest job with Chromium, and the unit
job doesn't pay a second Chromium install (the cache restore plus the apt
`install-deps` step) for one file. Locally it runs with
`pnpm -C backend exec vitest run --project db src/reports`.
A new test of this kind follows the same rule and goes in the table; the
MinIO check is `backend/src/__tests__/minio.ts` (`minioUp`).
The only skips CI allows are for the gitignored client data (`data/`, the
source workbooks), which CI never has (CLAUDE.md rule 10).

## Engine end-to-end tests

`packages/engine/src/e2e/` holds whole-run tests of the engine, one file set per
area (`demand`, `rain`, `network`, `balance`, `ewr`, `outputs`, `calibration`; then `cross` for
features together, `edge` for long, tiny, huge and boundary-date runs, `deep` for the off-takes
and allocations, `open` for questions the first round left):
small invented catchments run through `runModel` (or `calibrate`, the outlook,
a resumed run), checked against values worked by hand, or by a small
re-derivation inside the test, from docs/model.md, never against what the
engine returned before. The `*.differential.e2e.test.ts` files replay the
documented formulas over a few hundred random networks. `*.regressions.e2e.test.ts`
pin the bugs the suite found (engine 1.69.0, errata ER-13 … ER-29), and
`network.offtakeDecisions.e2e.test.ts` the decisions of engine 1.70.0
(issue #90 Q25–Q27: proportional rationing within a priority for off-takes
and dam rules, with a split-invariance property test, and the warning about a
licence entered twice; a fixed release counted in full in a room into a dam,
with a no-overfill property test over both paths; the pass-inflow target an
off-take keeps). They run in
`pnpm test` (a few seconds in all); run one area with
`pnpm -C packages/engine exec vitest run src/e2e/<area>`.

## Why the slow ones are shaped the way they are

- **Engine random soak** (`packages/engine/src/fuzz/`): checkAll on 400 seeds
  with GR4J runoff (the only model since engine 1.0.0, which dropped the
  legacy shards), about four model runs per case. One vitest file runs in one
  worker, so it is split into 4 shard files (`fuzz/gr4j.1–4.test.ts`, through
  `fuzz/shard.ts`); the pinned regression seeds stay in
  `run.invariants.test.ts`. Soak with
  `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/fuzz`
  (2026-09-26, engine 1.0.0: 20 000 cases clean with `FUZZ_MAX_FAILURES=100`).
  The web release runs it at 1 600 cases (`scripts/release/engine-build.mjs`,
  `deploy-frontend.yml`), under the shards' time budget of about 0.2 s a
  case (`fuzz/shard.ts`): raise that budget before raising the release's
  count. The
  determinism check compares outputs value by value (`sameOutput`), not by
  serialising them twice, which cost as much as a run. A shard is fixed,
  CPU-bound work, not a wait: 2026-10-02, shard 2 took 17 s alone, 34 s with
  the four shards side by side and about 20 s at a load average near 40,
  against its 120 s limit, and no seed passed 0.8 s.
- **Loading the Lambda entry points** (`backend/src/config/production.security.test.ts`):
  the test starts each Lambda's entry point to show it runs the production
  config check at init. It imports esbuild bundles of them natively (the same
  build its env-read inventory reads), not the source through vitest's module
  runner, which transformed the whole backend and the engine's source on the
  shared Vite server: ~3 s alone, and a timeout beside a full `pnpm test` on
  a loaded machine (2026-10-02). A test that needs a whole entry point's
  graph, fresh for each case, should do the same rather than `vi.resetModules()`
  and re-import it.
- **Forecast-mode prefix stability** (`packages/engine/src/forecast.invariants.test.ts`,
  WP-2.12): 40 random networks with a forecast tail in `pnpm test` (about
  6 s; three model runs a case). Soak with `FORECAST_FUZZ_CASES=20000 pnpm -C
  packages/engine exec vitest run src/forecast.invariants.test.ts` (about
  21 minutes, one worker; 2026-09-26: 20 000 cases clean once two seeds'
  invalid inputs were told apart).
- **Workbook parity** (`frontend/src/lib/spreadsheet/import/sourceWorkbooks.test.ts`):
  local only (it skips without the client workbooks and Python/openpyxl); each
  case spawns `extract_project.py`, which takes tens of seconds on a large
  workbook, so the cases run concurrently.
- **Backend db suite**: runs serially (one Postgres test database). It took
  ~5 min until the RLS role functions moved to PL/pgSQL (026, security.md:
  policies were re-planning them for every row) and passwords were hashed at
  the cheapest settings under vitest (`auth/password.ts`, now Argon2id's
  smallest parameters; the e2e API server too, with `PASSWORD_HASH_FAST=1`,
  e2e/README.md; production's elsewhere).
- **DB test files share the job queue, so each cleans up the jobs it
  queues.** Claim, tick and purge are global on purpose, and the files run
  one after another on one database, so a job one file leaves pending is
  claimed by the next file's `runTick` and shows up in its counts (a
  leftover yield, outlook, sweep and alert job made feeds.db.test.ts's
  "Run now" tick finish 5 jobs, not 1, whenever the file that left them
  happened to run first). A file that queues a job (a re-run, yield,
  outlook, sweep, calibration, report …) runs it (`runTick`) or retires it
  (`retirePendingJobs(projectId)` in `__tests__/helpers.ts`;
  `clearLadderJobs(ctx)` after `buildLadder`) before it ends. The guard is
  `backend/src/__tests__/db-setup.ts`, a per-file setup of the `db` and
  `perf-db` projects: after every file it fails that file if any job is
  still queued, retrying or running, naming each kind and project, then
  retires them so only the leaking file fails. It runs after the file's own
  `afterAll` (`sequence.hooks: 'stack'`, pinned in `backend/vitest.config.ts`);
  `__tests__/db-setup.db.test.ts` checks that order and the guard itself.
  The same guard covers the notice queues, which the tick also drains
  globally: a file that leaves a `pack_notice`, `erratum_notice` or
  `alert_delivery` pending, sending or waiting for the digest fails, so a
  file that issues or withdraws a pack, sweeps an erratum or fires an alert
  sends the mail (`runTick`) or settles it
  (`settlePendingNotices(projectId)` in `__tests__/helpers.ts`).
- **e2e ticks are scoped to the test's own projects.** Playwright's workers
  share one e2e database and run in parallel, so unlike the DB files an e2e
  test can't count on nobody else ticking: `runJobsTick` requires the
  test's `projects` and claims only their jobs (`worker.ts --once --project
  <id>`, `app_claim_jobs(limit, lease, projects)`, e2e/README.md § Rules for
  writing specs). Production and the DB tests' `runTick` stay global.
- A new test that loops over many random or real inputs should follow the
  same pattern: shard it across files, or run its child processes
  concurrently, rather than one long `it` in one file.
- **Big or repeated fixtures in db tests**: build state that isn't under
  test in one SQL statement (`asOwner` + `generate_series`), not through
  dozens of API calls, and make N of a thing from as few model runs as the
  assertion needs (a saved run is ~50 ms, mostly writing its ~200 `run_series`
  rows under RLS). The 413 export test and the 12-publication cap test were
  close to vitest's 5 s default under load until they did (8 × 60 000-value
  PUTs → one INSERT; 13 runs → 3 runs published 13 times). Size the fixture,
  not the timeout. A test about how a run's inputs are stored, not about the
  model, cuts its example catchment to two years (`runs/reproducible`,
  `series/apanDaily`). The DB tests share one database that grows as the
  suite runs, so a test that scans the whole schema scans only columns that
  could hold what it looks for: `auth/personal-data.security` skips number
  arrays, whose text casts of every stored run timed out its deletion check
  late in CI's suite.
- **Long e2e journeys**: Playwright gives each test 30 s. A UI step (a
  click, a fill, an expect) is ~30 ms of Playwright's own work on an idle
  laptop and three to four times that beside five other workers, so a test of
  ~165 steps, the old golden path, timed out on its length alone with no slow
  step in it (issue #138). Keep a test to a few dozen steps and arrange the
  rest through the API; the golden path is now four tests
  ([e2e/README.md § The golden path](../e2e/README.md#the-golden-path)).
  Split the journey, not the budget.
