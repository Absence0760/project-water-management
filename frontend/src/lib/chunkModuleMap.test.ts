// Guard: the client build writes which modules each chunk holds
// (frontend/vite.config.ts, chunkModuleMap), which the bundle guard reads to
// find the workspace tab chunks and measure them against their own ceiling
// (scripts/guards/check_web_bundle_budget.mjs).
import { describe, expect, it } from 'vitest';
import config, { CHUNK_MODULES_FILE, chunkModuleMap, chunkModules } from '../../vite.config';

const root = '/repo/frontend';

describe('chunk module map', () => {
	it('lists each chunk’s modules relative to frontend/ (once each, no virtual or outside ids), its own CSS and the npm packages it holds', () => {
		const out = chunkModules(
			{
				'_app/immutable/chunks/Aa1.js': {
					type: 'chunk',
					moduleIds: [
						'/repo/frontend/src/lib/components/settings/SettingsTab.svelte',
						'/repo/frontend/src/lib/components/settings/SettingsTab.svelte?svelte&type=style&lang.css',
						'\0virtual:autocal-worker-url',
						'/repo/packages/engine/src/run.ts'
					],
					viteMetadata: { importedCss: new Set(['_app/immutable/assets/Bb2.css']) }
				},
				'_app/immutable/assets/Bb2.css': { type: 'asset' },
				'_app/immutable/chunks/Cc3.js': { type: 'chunk', moduleIds: ['/repo/frontend/src/lib/api/index.ts'] },
				'_app/immutable/chunks/Dd4.js': {
					type: 'chunk',
					moduleIds: [
						'/repo/node_modules/.pnpm/maplibre-gl@6.10.0/node_modules/maplibre-gl/dist/maplibre-gl.mjs',
						'/repo/node_modules/.pnpm/pmtiles@4.5.0/node_modules/pmtiles/dist/esm/index.js',
						'/repo/node_modules/.pnpm/@types+x@1.0.0/node_modules/@scope/pkg/index.js'
					]
				}
			},
			root
		);
		expect(out).toEqual({
			'_app/immutable/chunks/Aa1.js': {
				modules: ['src/lib/components/settings/SettingsTab.svelte'],
				css: ['_app/immutable/assets/Bb2.css'],
				packages: []
			},
			'_app/immutable/chunks/Cc3.js': { modules: ['src/lib/api/index.ts'], css: [], packages: [] },
			// npm code: no module path (outside frontend/), but the package names, for the map ceiling.
			'_app/immutable/chunks/Dd4.js': { modules: [], css: [], packages: ['@scope/pkg', 'maplibre-gl', 'pmtiles'] }
		});
	});

	it('writes into .vite/, which SvelteKit never copies into the site', () => {
		expect(CHUNK_MODULES_FILE.startsWith('.vite/')).toBe(true);
	});

	it('writes nothing for the server build', () => {
		const plugin = chunkModuleMap() as unknown as {
			configResolved: (c: { root: string; build: { ssr: boolean } }) => void;
			generateBundle: (this: { emitFile: (f: unknown) => void }, o: unknown, b: Record<string, unknown>) => void;
		};
		const emitted: unknown[] = [];
		const ctx = { emitFile: (f: unknown) => emitted.push(f) };
		plugin.configResolved({ root, build: { ssr: true } });
		plugin.generateBundle.call(ctx, {}, {});
		expect(emitted).toEqual([]);
		plugin.configResolved({ root, build: { ssr: false } });
		plugin.generateBundle.call(ctx, {}, {});
		expect(emitted).toEqual([{ type: 'asset', fileName: CHUNK_MODULES_FILE, source: '{}' }]);
	});

	it('is one of the build’s plugins', () => {
		const names = (config as { plugins: { name?: string }[] }).plugins.flat().map((p) => p?.name);
		expect(names).toContain('water:chunk-module-map');
	});
});
