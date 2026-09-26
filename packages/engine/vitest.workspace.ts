import { defineWorkspace } from 'vitest/config';

// Two projects:
//   unit — correctness only, no wall-clock assertions (`pnpm test`).
//   perf — timing budgets (`*.perf.test.ts`), run serially with a
//          median-of-several sampling so a loaded machine doesn't produce a
//          flake (`pnpm test:perf`, root `pnpm test:engine:perf`).
export default defineWorkspace([
	{
		test: {
			name: 'unit',
			environment: 'node',
			include: ['src/**/*.test.ts'],
			exclude: ['node_modules/**', 'src/**/*.perf.test.ts']
		}
	},
	{
		test: {
			name: 'perf',
			environment: 'node',
			include: ['src/**/*.perf.test.ts'],
			// Timing runs share the machine's CPU; don't let them race each other.
			// fileParallelism alone doesn't serialise a workspace project (see the
			// backend db project); singleFork does.
			fileParallelism: false,
			poolOptions: { forks: { singleFork: true } }
		}
	}
]);
