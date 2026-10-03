import { defineConfig } from 'vitest/config';

// Two projects:
//   unit — correctness only, no wall-clock assertions (`pnpm test`).
//   perf — timing budgets (`*.perf.test.ts`), run serially with a
//          median-of-several sampling so a loaded machine doesn't produce a
//          flake (`pnpm test:perf`, root `pnpm test:engine:perf`).
export default defineConfig({
	test: {
		// Coverage (`pnpm test:coverage`, CI's step summary): a report, not a
		// gate. No thresholds, on purpose: a number to hit invites tests written
		// for the number. Read it for what no test reaches (docs/testing.md
		// § Coverage).
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/testing/**'],
			reporter: ['text-summary', 'json-summary', 'html']
		},
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['node_modules/**', 'src/**/*.perf.test.ts'],
					// No wall-clock assertion here (that is the perf project's job), so
					// the timeout only catches a hang. Vitest 2 never timed out a
					// synchronous test; vitest 4+ fails one that returns after the
					// timeout. The fuzz and invariant tests run the engine synchronously
					// over hundreds of random networks: ~2–10 s alone, and up to ~40 s
					// with every file in parallel on a loaded machine, past the default
					// 5 s. The heaviest set their own (up to 300 s).
					testTimeout: 120_000
				}
			},
			{
				test: {
					name: 'perf',
					environment: 'node',
					include: ['src/**/*.perf.test.ts'],
					// Timing runs share the machine's CPU; don't let them race each
					// other: one worker, files one after another (see the backend db
					// project, backend/vitest.config.ts).
					fileParallelism: false,
					maxWorkers: 1,
					// The budgets are the tests' own assertions on medians; a test also
					// times the slow path it compares against (the outlook's re-run
					// path: ~7 s in all), which vitest 4+ holds to the 5 s default.
					testTimeout: 120_000
				}
			}
		]
	}
});
