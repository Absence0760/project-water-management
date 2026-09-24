import { defineWorkspace } from 'vitest/config';

// Two projects:
//   unit — pure logic, no database (`pnpm test`).
//   db   — against real Postgres (`pnpm test:backend:db`, needs `pnpm dev:db:up`).
//          globalSetup rebuilds the water_test database from migrations first.
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
			exclude: ['node_modules/**', 'dist/**', 'src/**/*.db.test.ts']
		}
	},
	{
		test: {
			name: 'db',
			environment: 'node',
			setupFiles: ['./src/__tests__/setup.ts'],
			globalSetup: ['./src/__tests__/db-global-setup.ts'],
			include: ['src/**/*.db.test.ts'],
			// Tests share one database; run files serially.
			fileParallelism: false
		}
	}
]);
