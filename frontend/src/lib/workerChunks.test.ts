// Guard: the page-build workers land under workers/ (frontend/vite.config.ts,
// workerChunks; issues #9, #288), where the bundle guard measures them
// (scripts/guards/check_web_bundle_budget.mjs pageBuildWorkerViolations).
// SvelteKit 3 names client chunks with a function; SvelteKit 2 with a string.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workerChunks } from '../../vite.config';

type Chunk = { name: string; facadeModuleId: string | null };
type Out = { chunkFileNames?: string | ((c: Chunk) => string) };
const rewrite = workerChunks().outputOptions as unknown as (o: Out) => (Out & { chunkFileNames: (c: Chunk) => string }) | undefined;

const autocal = fileURLToPath(new URL('./calibration/autocal.worker.ts', import.meta.url));
const maplibre = realpathSync(fileURLToPath(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)));
const kit3 = (c: Chunk) => (c.name === 'sveltekit-manifest' ? '_app/manifest.js' : '_app/immutable/chunks/[hash:7].js');

describe('worker chunks', () => {
	it('puts each worker entry under workers/ when SvelteKit names chunks with a function', () => {
		const out = rewrite({ chunkFileNames: kit3 })!;
		expect(out.chunkFileNames({ name: 'autocal', facadeModuleId: autocal })).toBe('_app/immutable/workers/autocal.worker-[hash].js');
		expect(out.chunkFileNames({ name: 'w', facadeModuleId: maplibre })).toBe('_app/immutable/workers/maplibre.worker-[hash].js');
		// Positive controls: any other chunk, and the route manifest's fixed name, are SvelteKit's.
		expect(out.chunkFileNames({ name: 'x', facadeModuleId: '/src/lib/other.ts' })).toBe('_app/immutable/chunks/[hash:7].js');
		expect(out.chunkFileNames({ name: 'sveltekit-manifest', facadeModuleId: null })).toBe('_app/manifest.js');
	});

	it('does the same for a string pattern, and leaves the SSR pass (no "/chunks/") alone', () => {
		const out = rewrite({ chunkFileNames: '_app/immutable/chunks/[hash:7].js' })!;
		expect(out.chunkFileNames({ name: 'autocal', facadeModuleId: autocal })).toBe('_app/immutable/workers/autocal.worker-[hash].js');
		expect(out.chunkFileNames({ name: 'x', facadeModuleId: '/src/x.ts' })).toBe('_app/immutable/chunks/[hash:7].js');
		expect(rewrite({ chunkFileNames: 'chunks/[name].js' })).toBeUndefined();
	});
});
