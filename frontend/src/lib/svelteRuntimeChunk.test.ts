// Guard: Svelte's runtime ships as one chunk (frontend/vite.config.ts,
// svelteRuntimeChunk; issue #9). Without the rule the bundler cuts the runtime into
// ~15 chunks, several under 0.5 KB, and every page loads more (numbers in
// the bundle budget's history, scripts/guards/bundle-budget/README.md).
import { describe, expect, it } from 'vitest';
import config, { helpArticlesChunk, svelteRuntimeChunk } from '../../vite.config';

const SVELTE = '/repo/node_modules/.pnpm/svelte@5.56.10/node_modules/svelte/src';

describe('the Svelte runtime chunk', () => {
	it('puts every client runtime module of Svelte in the one chunk', () => {
		for (const m of ['internal/client/index.js', 'internal/client/dom/blocks/snippet.js', 'internal/disclose-version.js', 'index-client.js', 'store/shared/index.js', 'legacy/legacy-client.js']) {
			expect(svelteRuntimeChunk(`${SVELTE}/${m}`), m).toBe('svelte');
		}
	});

	it('leaves app code, the engine, other packages and the compiler to the bundler', () => {
		for (const id of ['/repo/frontend/src/lib/api/client.ts', '/repo/packages/engine/src/run.ts', '/repo/node_modules/.pnpm/uplot@1.6.32/node_modules/uplot/dist/uPlot.esm.js', `${SVELTE}/compiler/index.js`]) {
			expect(svelteRuntimeChunk(id), id).toBeUndefined();
		}
	});

	it('is the page build’s first code-splitting group (Rolldown’s manualChunks), the help glossary’s data articles the second', () => {
		const output = (config as { build: { rolldownOptions: { output: { codeSplitting: { groups: { name: unknown }[] } } } } }).build.rolldownOptions.output;
		expect(output.codeSplitting.groups).toHaveLength(2);
		expect(output.codeSplitting.groups[0]!.name).toBe(svelteRuntimeChunk);
		expect(output.codeSplitting.groups[1]!.name).toBe(helpArticlesChunk);
	});

	it('puts only the help glossary’s "Input data" articles in their own chunk (issue #66)', () => {
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-data.ts')).toBe('help-articles-data');
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-licensing.ts')).toBe('help-articles-licensing');
		for (const id of ['/repo/frontend/src/lib/help/articles.ts', '/repo/frontend/src/lib/help/content.ts', '/repo/frontend/src/lib/help/tips.ts']) {
			expect(helpArticlesChunk(id), id).toBeUndefined();
		}
	});
});
