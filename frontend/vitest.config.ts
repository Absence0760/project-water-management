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
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
