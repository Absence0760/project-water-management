import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so the SvelteKit plugin (which needs a full
// dev-server lifecycle) isn't pulled into the Vitest runtime. The plain Svelte
// plugin is enough to compile runes in `.svelte.ts` modules. Tests that touch
// SvelteKit virtual modules like `$env/static/public` mock them with
// `vi.mock()` instead.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	resolve: {
		alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
		conditions: ['browser']
	},
	test: {
		environment: 'node',
		// Two projects. Under `environment: 'node'` vite-plugin-svelte compiles a
		// `.svelte.ts` module for the server, where `$effect` and `$effect.root`
		// are no-ops: a state class whose constructor starts an `$effect` (the
		// map's layers, lib/components/map/*Layer.svelte.ts) never runs it, and a
		// test awaiting its request waits forever. So a `*.svelte.test.ts` file
		// runs in a Node environment that asks Vite for client transforms
		// (vitest.client-env.ts): the client runtime, effects that run, still no
		// DOM. Every other test keeps the node environment (the components'
		// tests render with svelte/server, which needs the server compile).
		projects: [
			{ extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.svelte.test.ts'] } },
			{ extends: true, test: { name: 'runes', include: ['src/**/*.svelte.test.ts'], environment: './vitest.client-env.ts' } }
		],
		// The unit tests make no wall-clock claim, so the timeout only catches a
		// hang. Vitest 2 never timed out a synchronous test; vitest 4+ fails one
		// that returns after the timeout, and the source-scanning guards
		// (chartLabels, the engine-backed component tests) take 2–3 s alone and
		// past the default 5 s with every file in parallel on a loaded machine.
		testTimeout: 60_000
	}
});
