import { defineConfig } from 'vitest/config';

// Four projects:
//   unit — pure logic, no database, no wall-clock assertions (`pnpm test`).
//   db   — against real Postgres (`pnpm test:backend:db`, needs `pnpm dev:db:up`).
//          globalSetup rebuilds the water_test database from migrations first.
//   perf — timing budgets (`*.perf.test.ts`), run serially with a
//          median-of-several sampling so a loaded machine doesn't produce a
//          flake (`pnpm test:perf`, root `pnpm test:backend:perf`).
//   perf-db — timing budgets against Postgres (`*.db.perf.test.ts`), with the
//          db project's setup and global setup (a fresh water_test…), serial
//          (`pnpm test:perf:db`, root `pnpm test:backend:perf:db`). It rebuilds
//          the same test database as `db`, so never run the two at once.
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					setupFiles: ['./src/__tests__/setup.ts'],
					// scripts/**: operational CLI tools. pan-sensitivity.test.ts tests its
					// pure helpers (plus a skip-if-absent smoke test against the real client
					// catchment, never asserting its figures); fit-sweep.test.ts fits one
					// synthetic cell with a tiny budget; examples/catchments.test.ts
					// holds the seeded example catchments to the current schema and engine.
					// ../scripts/reproduce-pack: the root reproduce:pack command, which
					// runs on this workspace's tsx (package.json).
					include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', '../scripts/reproduce-pack/**/*.test.ts'],
					exclude: ['node_modules/**', 'dist/**', 'src/**/*.db.test.ts', 'src/**/*.perf.test.ts'],
					// No wall-clock claim here (the perf projects make those), so the
					// timeout only catches a hang. Vitest 2 never timed out a synchronous
					// test; vitest 4+ fails one that returns after the timeout, and the
					// engine-backed ones (examples.invariants, ~2 s alone) pass the
					// default 5 s with every file in parallel on a loaded machine.
					testTimeout: 60_000
				}
			},
			{
				test: {
					name: 'db',
					environment: 'node',
					// db-setup.ts: each file must leave no pending job behind (the queue is global).
					setupFiles: ['./src/__tests__/setup.ts', './src/__tests__/db-setup.ts'],
					globalSetup: ['./src/__tests__/db-global-setup.ts'],
					// After-hooks in reverse registration order, so db-setup.ts's afterAll runs after each file's own (the default, pinned).
					sequence: { hooks: 'stack' },
					include: ['src/**/*.db.test.ts'],
					// Tests share one database; run files serially: the job/feed queue
					// (feeds.db.test.ts, jobs.db.test.ts) uses claim/tick functions that are
					// deliberately global, not scoped per project or test file, so two of
					// these files running at once can claim, finish, retry-count or purge
					// each other's rows (the flake this fixed: 1 run in 2 failed, always in
					// those two files). Under vitest 2, `fileParallelism: false` alone did
					// not serialize a project of a multi-project workspace, and
					// `poolOptions.forks.singleFork` did. Vitest 4 removed `poolOptions`;
					// `maxWorkers: 1` is the one-worker limit now. Each file still gets its
					// own module graph (the default `isolate: true`, where the old
					// singleFork mapping would be `isolate: false`), so a pg pool or other
					// module singleton never carries from one file into the next.
					fileParallelism: false,
					maxWorkers: 1
				}
			},
			{
				test: {
					name: 'perf',
					environment: 'node',
					include: ['src/**/*.perf.test.ts'],
					exclude: ['node_modules/**', 'dist/**', 'src/**/*.db.perf.test.ts'],
					// Timing runs share the machine's CPU; don't let them race each other:
					// one worker, as for the db project.
					fileParallelism: false,
					maxWorkers: 1,
					// The budgets are the tests' own assertions on medians of several
					// runs; the timeout (vitest 4+ holds synchronous tests to it) only
					// catches a hang.
					testTimeout: 120_000
				}
			},
			{
				test: {
					name: 'perf-db',
					environment: 'node',
					// db-setup.ts: each file must leave no pending job behind (the queue is global).
					setupFiles: ['./src/__tests__/setup.ts', './src/__tests__/db-setup.ts'],
					globalSetup: ['./src/__tests__/db-global-setup.ts'],
					// After-hooks in reverse registration order, so db-setup.ts's afterAll runs after each file's own (the default, pinned).
					sequence: { hooks: 'stack' },
					include: ['src/**/*.db.perf.test.ts'],
					// Serial for both reasons above: timings share the CPU, and files share one database.
					fileParallelism: false,
					maxWorkers: 1,
					// As for perf: the budget is the test's assertion, not the timeout.
					testTimeout: 120_000
				}
			}
		]
	}
});
