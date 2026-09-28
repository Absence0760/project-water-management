import { defineWorkspace } from 'vitest/config';

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
export default defineWorkspace([
	{
		test: {
			name: 'unit',
			environment: 'node',
			setupFiles: ['./src/__tests__/setup.ts'],
			// scripts/**: operational CLI tools. pan-sensitivity.test.ts tests its
			// pure helpers (plus a skip-if-absent smoke test against the real client
			// catchment, never asserting its figures); examples/catchments.test.ts
			// holds the seeded example catchments to the current schema and engine.
			include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
			exclude: ['node_modules/**', 'dist/**', 'src/**/*.db.test.ts', 'src/**/*.perf.test.ts']
		}
	},
	{
		test: {
			name: 'db',
			environment: 'node',
			setupFiles: ['./src/__tests__/setup.ts'],
			globalSetup: ['./src/__tests__/db-global-setup.ts'],
			include: ['src/**/*.db.test.ts'],
			// Tests share one database; run files serially: the job/feed queue
			// (feeds.db.test.ts, jobs.db.test.ts) uses claim/tick functions that are
			// deliberately global, not scoped per project or test file, so two of
			// these files running at once can claim, finish, retry-count or purge
			// each other's rows (the flake this fixed: 1 run in 2 failed, always in
			// those two files). `fileParallelism: false` alone does NOT do this in a
			// multi-project vitest workspace (vitest@2.1.9): pool sizing is resolved
			// such that files still get dispatched to separate concurrent forks even
			// with `--project db` selected. `poolOptions.forks.singleFork` pins this
			// project to one fork, which does serialize it (verified: file-level
			// start/end timestamps no longer overlap across processes, and 5/5
			// `vitest run --project db` runs pass with matching serial wall-clock time).
			fileParallelism: false,
			poolOptions: { forks: { singleFork: true } }
		}
	},
	{
		test: {
			name: 'perf',
			environment: 'node',
			include: ['src/**/*.perf.test.ts'],
			exclude: ['node_modules/**', 'dist/**', 'src/**/*.db.perf.test.ts'],
			// Timing runs share the machine's CPU; don't let them race each other.
			// fileParallelism alone doesn't serialise a workspace project (see the
			// backend db project); singleFork does.
			fileParallelism: false,
			poolOptions: { forks: { singleFork: true } }
		}
	},
	{
		test: {
			name: 'perf-db',
			environment: 'node',
			setupFiles: ['./src/__tests__/setup.ts'],
			globalSetup: ['./src/__tests__/db-global-setup.ts'],
			include: ['src/**/*.db.perf.test.ts'],
			// Serial for both reasons above: timings share the CPU, and files share one database.
			fileParallelism: false,
			poolOptions: { forks: { singleFork: true } }
		}
	}
]);
