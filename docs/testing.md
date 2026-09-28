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
| `pnpm test:engine:perf` / `pnpm test:backend:perf` | wall-clock budgets, no database | seconds |
| `pnpm test:backend:perf:db` | wall-clock budgets against Postgres (`*.db.perf.test.ts`, the `perf-db` project): the team portfolio for 10 catchments × 60 farms under 500 ms, median of 7 (measured 41 ms); the RLS role check in a session with no user costs under 20 bare function calls (094_role_check_no_user; measured ~4) | ~55 s, nearly all fixture |

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
`app_has_role`). A
budget should sit well above the measured time (the portfolio's is ~12×),
so it catches a change in the query's shape, not machine noise.

## The loop

1. While editing: `pnpm test:changed` (or one file: `pnpm -C <ws> exec vitest run <path>`).
2. For UI work, the e2e specs for that surface only: `pnpm test:e2e tests/runs.spec.ts`.
   Never the whole e2e suite locally; CI runs it in 14 shards.
3. Before the commit: `pnpm check && pnpm test`, plus the DB test files for
   backend or SQL you changed (`pnpm -C backend exec vitest run --project db
   src/<area>`). Not the whole `test:backend:db`: CI runs it. Don't re-run a
   suite after every small edit: re-run the failing file until it passes.
4. Don't pipe e2e output into `grep`/`head`/`tail`: the web servers hold the
   pipe open and the command hangs after the tests finish. Redirect to a file.

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
| `e2e/tests/server-report.spec.ts` | MinIO + Mailpit | e2e shards |
| `e2e/tests/alerts-mailpit.spec.ts` | Mailpit | e2e shards |

`render.origin.db.test.ts` needs no database but is in the db project
(`.db.test.ts`) on purpose: `db-test` already needs a browser for
`render.db.test.ts`, so it is the one vitest job with Chromium, and the unit
job doesn't pay a second Chromium install (the cache restore plus the apt
`install-deps` step) for one file. Locally it runs with
`pnpm -C backend exec vitest run --project db src/reports`.
A new test of this kind follows the same rule and goes in the table.
The only skips CI allows are for the gitignored client data (`data/`, the
source workbooks), which CI never has (CLAUDE.md rule 10).

## Why the slow ones are shaped the way they are

- **Engine random soak** (`packages/engine/src/fuzz/`): checkAll on 400 seeds
  with GR4J runoff (the only model since engine 1.0.0, which dropped the
  legacy shards), about four model runs per case. One vitest file runs in one
  worker, so it is split into 4 shard files (`fuzz/gr4j.1–4.test.ts`, through
  `fuzz/shard.ts`); the pinned regression seeds stay in
  `run.invariants.test.ts`. Soak with
  `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/fuzz`
  (2026-09-26, engine 1.0.0: 20 000 cases clean with `FUZZ_MAX_FAILURES=100`). The
  determinism check compares outputs value by value (`sameOutput`), not by
  serialising them twice, which cost as much as a run.
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
  bcrypt's minimum cost under vitest (`auth/password.ts`; the e2e API server
  too, with `PASSWORD_HASH_COST=4`, e2e/README.md; 12 elsewhere).
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
  not the timeout.
