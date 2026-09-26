import { defineWorkspace } from 'vitest/config';

// Three projects:
//   unit — pure logic, no database, no wall-clock assertions (`pnpm test`).
//   db   — against real Postgres (`pnpm test:backend:db`, needs `pnpm dev:db:up`).
//          globalSetup rebuilds the water_test database from migrations first.
//   perf — timing budgets (`*.perf.test.ts`), run serially with a
//          median-of-several sampling so a loaded machine doesn't produce a
//          flake (`pnpm test:perf`, root `pnpm test:backend:perf`).
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
			// Tests share one database; run files serially. Vitest 2 ignores
			// this option inside a workspace project (two files overlapped with
			// it set), so the test:db script also passes --no-file-parallelism,
			// which does take effect: a tick in one file must never claim
			// another file's jobs.
			fileParallelism: false
		}
	},
	{
		test: {
			name: 'perf',
			environment: 'node',
			include: ['src/**/*.perf.test.ts'],
			// Timing runs share the machine's CPU; don't let them race each other.
			fileParallelism: false
		}
	}
]);
