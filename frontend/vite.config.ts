import { sveltekit } from '@sveltejs/kit/vite';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const AUTOCAL_WORKER = fileURLToPath(new URL('./src/lib/calibration/autocal.worker.ts', import.meta.url));
const AUTOCAL_WORKER_URL = 'virtual:autocal-worker-url';

/**
 * The calibration worker as a chunk of the page build (issue #9).
 *
 * Vite bundles `new Worker(new URL(…))` as a separate build, so the worker
 * carried its own copy of the engine, most of which the pages ship too. Here
 * `lib/calibration/runner.ts` takes the worker's URL from a virtual module
 * instead, and in the client build that module emits the worker as one more
 * entry of the page build: Rollup then puts the engine code it shares with
 * pages in shared chunks, which the worker imports as ES modules (it is a
 * module worker). The worker entry lands under `_app/immutable/workers/`, where
 * the bundle guard looks for it. In dev (and vitest) the URL is Vite's own
 * worker URL for the source file; the server build never starts a worker.
 */
function autocalWorkerChunk(): Plugin {
	const resolved = '\0' + AUTOCAL_WORKER_URL;
	let serve = false;
	let root = '';
	return {
		name: 'water:autocal-worker-chunk',
		configResolved(config) {
			serve = config.command === 'serve';
			root = config.root;
		},
		resolveId(id) {
			return id === AUTOCAL_WORKER_URL ? resolved : undefined;
		},
		load(id, options) {
			if (id !== resolved) return undefined;
			if (options?.ssr) return 'export default "";';
			// What Vite itself serves for `new Worker(new URL('./autocal.worker.ts', import.meta.url), { type: 'module' })`.
			if (serve) return `export default ${JSON.stringify('/' + relative(root, AUTOCAL_WORKER).split(sep).join('/') + '?worker_file&type=module')};`;
			const ref = this.emitFile({ type: 'chunk', id: AUTOCAL_WORKER });
			return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
		},
		// Rollup names an emitted chunk by chunkFileNames, which SvelteKit sets
		// to a bare hash; name the worker's entry so it lands under workers/.
		outputOptions(output) {
			const chunkFileNames = output.chunkFileNames;
			if (typeof chunkFileNames !== 'string' || !chunkFileNames.includes('/chunks/')) return undefined;
			const worker = chunkFileNames.replace(/\/chunks\/.*$/, '/workers/autocal.worker-[hash].js');
			return { ...output, chunkFileNames: (chunk) => (chunk.facadeModuleId === AUTOCAL_WORKER ? worker : chunkFileNames) };
		}
	};
}

/**
 * The engine is pure (no I/O, and no module does anything when it loads:
 * src/lib/engineSideEffects.test.ts guards that), so an engine module whose
 * exports a chunk doesn't use is no dependency of that chunk. Without this,
 * Rollup keeps every engine module a chunk reaches through the
 * `@water-management/engine` barrel "in case it has side effects".
 */
const engineIsPure = (id: string) => !id.includes('/packages/engine/src/');

export default defineConfig({
	plugins: [autocalWorkerChunk(), sveltekit()],
	// The spreadsheet workers (`new Worker(new URL(…))`) are separate Rollup
	// builds that don't read build.rollupOptions, so they need the same
	// treeshake rule: without it the import worker kept engine code it never
	// calls (scenario ops, fit provenance) because it reaches those modules
	// through the barrel: 26.6 → 25.9 KB gzip (issue #9).
	worker: {
		rollupOptions: { treeshake: { moduleSideEffects: engineIsPure } }
	},
	build: {
		// Ship ES2022 as written. Vite's default target ('modules': Safari 14,
		// Chrome 87) down-levels class fields, and Svelte 5's runtime and
		// compiled components are full of them, into defineProperty and WeakMap
		// helpers: ~6 KB gzip across the bundle. The app already needs newer
		// browsers than ES2022 does (HelpTip's popover: Chrome 114, Safari 17,
		// Firefox 125). Applies to the calibration worker too, which is part of
		// the page build.
		target: 'es2022',
		rollupOptions: {
			treeshake: {
				// See engineIsPure. Rollup otherwise groups engine code by phantom
				// edges: the farm and share pages loaded ~13 KB of engine code they
				// never call and the catchment page ~8 KB, which now loads with the
				// Data, Settings and Runs tabs that call it (issue #9; numbers in
				// the bundle guard's change log).
				moduleSideEffects: engineIsPure
			}
		}
	}
});
