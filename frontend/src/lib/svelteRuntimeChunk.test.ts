// Guard: Svelte's runtime ships as one chunk (frontend/vite.config.ts,
// svelteRuntimeChunk; issue #9). Without the rule Rollup cuts the runtime into
// ~15 chunks, several under 0.5 KB, and every page loads more (numbers in
// scripts/guards/check_web_bundle_budget.mjs's change log).
import { describe, expect, it } from 'vitest';
import config, { svelteRuntimeChunk } from '../../vite.config';

const SVELTE = '/repo/node_modules/.pnpm/svelte@5.56.10/node_modules/svelte/src';

describe('the Svelte runtime chunk', () => {
	it('puts every client runtime module of Svelte in the one chunk', () => {
		for (const m of ['internal/client/index.js', 'internal/client/dom/blocks/snippet.js', 'internal/disclose-version.js', 'index-client.js', 'store/shared/index.js', 'legacy/legacy-client.js']) {
			expect(svelteRuntimeChunk(`${SVELTE}/${m}`), m).toBe('svelte');
		}
	});

	it('leaves app code, the engine, other packages and the compiler to Rollup', () => {
		for (const id of ['/repo/frontend/src/lib/api/client.ts', '/repo/packages/engine/src/run.ts', '/repo/node_modules/.pnpm/uplot@1.6.32/node_modules/uplot/dist/uPlot.esm.js', `${SVELTE}/compiler/index.js`]) {
			expect(svelteRuntimeChunk(id), id).toBeUndefined();
		}
	});

	it('is the page build’s manualChunks', () => {
		const output = (config as { build: { rollupOptions: { output: { manualChunks: unknown } } } }).build.rollupOptions.output;
		expect(output.manualChunks).toBe(svelteRuntimeChunk);
	});
});
