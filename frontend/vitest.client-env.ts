// A Node test environment whose modules Vite transforms for the client
// (vitest.config.ts, the `runes` project): Svelte compiles `.svelte.ts`
// modules with the client runtime, so `$effect` and `$effect.root` run. No
// DOM: a test that needs one isn't a `*.svelte.test.ts` state test.
import type { Environment } from 'vitest/environments';

export default {
	name: 'client-node',
	viteEnvironment: 'client',
	setup() {
		return { teardown() {} };
	}
} satisfies Environment;
