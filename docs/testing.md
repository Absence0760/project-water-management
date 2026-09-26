# Testing: the fast loop and the gate

Run the smallest check that proves the change while working, and the full
suites once, before committing. Measured on the 20-core dev laptop
(2026-09-25):

| Command | What | Wall time |
| --- | --- | --- |
| `pnpm test:changed` | typecheck the touched workspaces + `vitest --changed` for only the tests the change reaches (db tests too when :5434 is up) | seconds for a leaf change; the full suites when a shared helper changed |
| `pnpm check` | typecheck everything | ~20 s |
| `pnpm test:engine` | engine unit | ~35 s |
| `pnpm test:frontend` | frontend unit (37 s of it is the local-only workbook parity test) | ~40 s |
| `pnpm test:backend` | backend unit | ~15 s |
| `pnpm test:backend:db` | API + RLS against Postgres (serial) | ~1.5 min |
| `pnpm test:e2e <spec…>` | Playwright, one or a few specs | 15–60 s + build |

## The loop

1. While editing: `pnpm test:changed` (or one file: `pnpm -C <ws> exec vitest run <path>`).
2. For UI work, the e2e specs for that surface only: `pnpm test:e2e tests/runs.spec.ts`.
   Never the whole e2e suite locally; CI runs it in 14 shards.
3. Before the commit: `pnpm check && pnpm test`, plus `pnpm test:backend:db`
   when backend or SQL changed. Don't re-run a full suite after every small
   edit: re-run the failing file until it passes, then the suite once.

## Why the slow ones are shaped the way they are

- **Engine random soak** (`packages/engine/src/fuzz/`): checkAll on 400 seeds ×
  2 runoff models, about four model runs per case. One vitest file runs in one
  worker, so it is split into 4 shard files per model (`fuzz/shard.ts`); the
  pinned regression seeds stay in `run.invariants.test.ts`. Soak with
  `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/fuzz`. The
  determinism check compares outputs value by value (`sameOutput`), not by
  serialising them twice, which cost as much as a run.
- **Workbook parity** (`frontend/src/lib/spreadsheet/import/sourceWorkbooks.test.ts`):
  local only (it skips without the client workbooks and Python/openpyxl); each
  case spawns `extract_project.py` for ~30 s, so the cases run concurrently.
- **Backend db suite**: runs serially (one Postgres test database). It took
  ~5 min until the RLS role functions moved to PL/pgSQL (026, security.md:
  policies were re-planning them for every row) and passwords were hashed at
  bcrypt's minimum cost under vitest (`auth/password.ts`; 12 elsewhere).
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
