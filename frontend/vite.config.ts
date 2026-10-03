import { sveltekit } from '@sveltejs/kit/vite';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** The Web Workers built as entries of the page build: source, the virtual module serving its URL, its output name under workers/. */
const WORKERS = [
	// Calibration: the fit, the uncertainty ensemble, the sensitivity runs (lib/calibration/runner.ts).
	{ file: fileURLToPath(new URL('./src/lib/calibration/autocal.worker.ts', import.meta.url)), id: 'virtual:autocal-worker-url', name: 'autocal.worker' },
	// Preview: the engine on inputs the page holds, never stored (WP-1.17; the Yield panel's preview, lib/preview/runner.ts).
	{ file: fileURLToPath(new URL('./src/lib/preview/engine.worker.ts', import.meta.url)), id: 'virtual:preview-worker-url', name: 'preview.worker' },
	// MapLibre's own worker (the catchment map, issue #288): its ES module build imports the code it shares with
	// the main thread (maplibre-gl-shared.mjs), so as an entry of the page build that file is one shared chunk,
	// not a second copy (~150 KB gzip). lib/components/map/CatchmentMap.svelte hands this URL to setWorkerUrl;
	// same-origin, so CSP worker-src 'self' holds (no blob:).
	{ file: realpathSync(fileURLToPath(new URL('./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url))), id: 'virtual:maplibre-worker-url', name: 'maplibre.worker', vendor: true }
] as const satisfies readonly { file: string; id: string; name: string; vendor?: boolean }[];

/**
 * The engine's Web Workers as chunks of the page build (issue #9).
 *
 * Vite bundles `new Worker(new URL(…))` as a separate build, so the worker
 * carried its own copy of the engine, most of which the pages ship too. Here
 * each worker's runner (`lib/calibration/runner.ts`, `lib/preview/runner.ts`)
 * takes the worker's URL from a virtual module instead, and in the client
 * build that module emits the worker as one more entry of the page build:
 * Rolldown then puts the engine code it shares with pages (and with the other
 * worker) in shared chunks, which the worker imports as ES modules (it is a
 * module worker). The worker entries land under `_app/immutable/workers/`,
 * where the bundle guard looks for them. In dev (and vitest) the URL is Vite's
 * own worker URL for the source file; the server build never starts a worker.
 * One plugin for every worker: each would otherwise wrap chunkFileNames and
 * find the other's function there instead of the pattern.
 */
export function workerChunks(): Plugin {
	const byResolved = new Map<string, (typeof WORKERS)[number]>(WORKERS.map((w) => ['\0' + w.id, w]));
	let serve = false;
	let root = '';
	return {
		name: 'water:worker-chunks',
		configResolved(config) {
			serve = config.command === 'serve';
			root = config.root;
		},
		resolveId(id) {
			return WORKERS.some((w) => w.id === id) ? '\0' + id : undefined;
		},
		load(id, options) {
			const w = byResolved.get(id);
			if (!w) return undefined;
			if (options?.ssr) return 'export default "";';
			// What Vite itself serves for `new Worker(new URL('./<name>.ts', import.meta.url), { type: 'module' })`.
			// A vendor worker is plain ES modules already: in dev Vite serves the file as it is, outside the root through /@fs/.
			if (serve && 'vendor' in w) return `export default ${JSON.stringify('/@fs' + w.file.split(sep).join('/'))};`;
			if (serve) return `export default ${JSON.stringify('/' + relative(root, w.file).split(sep).join('/') + '?worker_file&type=module')};`;
			const ref = this.emitFile({ type: 'chunk', id: w.file });
			return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
		},
		// Rolldown names an emitted chunk by chunkFileNames, which SvelteKit sets
		// to a bare hash; name each worker's entry so it lands under workers/.
		outputOptions(output) {
			const chunkFileNames = output.chunkFileNames;
			if (typeof chunkFileNames !== 'string' || !chunkFileNames.includes('/chunks/')) return undefined;
			const names = new Map(WORKERS.map((w) => [w.file as string, chunkFileNames.replace(/\/chunks\/.*$/, `/workers/${w.name}-[hash].js`)]));
			return { ...output, chunkFileNames: (chunk) => (chunk.facadeModuleId && names.get(chunk.facadeModuleId)) || chunkFileNames };
		}
	};
}

/**
 * Preload lists without the chunks a page already has (issue #9).
 *
 * For every dynamic import Vite writes the whole static import tree of the
 * chunk it loads into the importing chunk (`__vite__mapDeps`), so the browser
 * can fetch it in parallel. Most of that tree (the Svelte runtime, the API
 * client, the shared UI chunks) is already a static import of the importer
 * itself, loaded before its code ran: preloading it again does nothing, but
 * its file name still ships in every list. This drops those entries and keeps
 * the rest (and every CSS file) as Vite wrote them. The chunk graph comes from
 * the finished bundle: generateBundle runs `pre` here, before Vite's own
 * import analysis asks resolveDependencies.
 */
export function preloadDedupe(): { plugin: Plugin; resolveDependencies: (file: string, deps: string[], ctx: { hostId: string; hostType: 'html' | 'js' }) => string[] } {
	let imports = new Map<string, readonly string[]>();
	const loaded = new Map<string, Set<string>>();
	function staticTree(file: string): Set<string> {
		let seen = loaded.get(file);
		if (seen) return seen;
		seen = new Set();
		const stack = [...(imports.get(file) ?? [])];
		while (stack.length) {
			const f = stack.pop()!;
			if (seen.has(f)) continue;
			seen.add(f);
			stack.push(...(imports.get(f) ?? []));
		}
		loaded.set(file, seen);
		return seen;
	}
	return {
		plugin: {
			name: 'water:preload-dedupe',
			generateBundle: {
				order: 'pre',
				handler(_options, bundle) {
					imports = new Map();
					loaded.clear();
					for (const [file, out] of Object.entries(bundle)) if (out.type === 'chunk') imports.set(file, out.imports);
				}
			}
		},
		resolveDependencies(_file, deps, { hostId, hostType }) {
			if (hostType !== 'js') return deps;
			const has = staticTree(hostId);
			return deps.filter((d) => !has.has(d));
		}
	};
}

const preload = preloadDedupe();

/**
 * Shorter output file names (issue #9). Every chunk's name is in the import
 * statements of the chunks that use it, and every CSS file's in the preload
 * lists and SvelteKit's route manifest: random characters that compress
 * badly. SvelteKit names chunks `[hash]` (the bundler's default, 8 characters);
 * here 7, the least Rollup accepted below 4 096 chunks, and CSS files drop the
 * component name (`LoadState.DaDhZLrP.css` → `DaDhZLr.css`), the way
 * SvelteKit already names JS chunks. 42 bits of hash still change whenever
 * the content does, so cache busting is unaffected. Output only: the SSR pass
 * has no hashes, and the spreadsheet workers are builds of their own.
 */
export function shortFileNames(): Plugin {
	const pattern = (n: unknown) => (typeof n === 'string' ? n.replace(/\[hash\]/g, '[hash:7]') : n);
	return {
		name: 'water:short-file-names',
		outputOptions(output) {
			return {
				...output,
				chunkFileNames: pattern(output.chunkFileNames) as typeof output.chunkFileNames,
				entryFileNames: pattern(output.entryFileNames) as typeof output.entryFileNames,
				assetFileNames: pattern(typeof output.assetFileNames === 'string' ? output.assetFileNames.replace('[name].', '') : output.assetFileNames) as typeof output.assetFileNames
			};
		}
	};
}

/** Where chunkModuleMap writes, relative to the client build's output directory. */
export const CHUNK_MODULES_FILE = '.vite/chunk-modules.json';

/**
 * Which source modules each emitted chunk holds, for the bundle guard.
 *
 * The guard gives the workspace's lazy tab chunks a ceiling of their own
 * (scripts/guards/check_web_bundle_budget.mjs), so it has to know which output
 * file each tab landed in. File names are bare hashes, and Vite's manifest
 * can't say either: it keys a chunk by its source only when the chunk is a
 * facade of one module, and Rolldown merges a tab with code its lazy panels
 * share (the Settings tab) or the page with its route node, so those keys
 * vanish. This writes `{ "<file>": { modules: [...], css: [...] } }` for every
 * JS chunk of the client build, module paths relative to frontend/, to
 * `.vite/` beside Vite's manifest: SvelteKit never copies `.vite/` into the
 * site (builder.writeClient), so it isn't shipped. The server build writes
 * nothing.
 */
export function chunkModuleMap(): Plugin {
	let root = '';
	let ssr = false;
	return {
		name: 'water:chunk-module-map',
		apply: 'build',
		configResolved(config) {
			root = config.root;
			ssr = !!config.build.ssr;
		},
		generateBundle(_options, bundle) {
			if (ssr) return;
			this.emitFile({ type: 'asset', fileName: CHUNK_MODULES_FILE, source: JSON.stringify(chunkModules(bundle, root)) });
		}
	};
}

type BundleChunk = { type: 'chunk'; moduleIds: string[]; viteMetadata?: { importedCss: Set<string> } } | { type: 'asset' };

/** chunkModuleMap's content: every chunk's modules under `root` (no virtual or outside ids), and its own CSS files. */
export function chunkModules(bundle: Record<string, BundleChunk>, root: string): Record<string, { modules: string[]; css: string[]; packages: string[] }> {
	const out: Record<string, { modules: string[]; css: string[]; packages: string[] }> = {};
	for (const [file, chunk] of Object.entries(bundle)) {
		if (chunk.type !== 'chunk') continue;
		const ids = chunk.moduleIds.filter((id) => !id.startsWith('\0')).map((id) => id.replace(/\?.*$/, '').split(sep).join('/'));
		const modules = ids.map((id) => relative(root, id).split(sep).join('/')).filter((p) => !p.startsWith('..'));
		// The npm packages the chunk holds code of (the bundle guard's map ceiling finds MapLibre's chunks by them).
		const packages = ids.flatMap((id) => {
			const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(id);
			return m ? [m[1]!] : [];
		});
		out[file] = { modules: [...new Set(modules)], css: [...(chunk.viteMetadata?.importedCss ?? [])], packages: [...new Set(packages)].sort() };
	}
	return out;
}

/**
 * The engine is pure (no I/O, and no module does anything when it loads:
 * src/lib/engineSideEffects.test.ts guards that), so an engine module whose
 * exports a chunk doesn't use is no dependency of that chunk. Without this,
 * Rolldown keeps every engine module a chunk reaches through the
 * `@water-management/engine` barrel "in case it has side effects".
 */
const engineIsPure = (id: string) => !id.includes('/packages/engine/src/');

/**
 * Svelte's runtime in one chunk of its own (issue #9). Left to Rollup, the
 * runtime was cut into ~15 chunks by which pages use which piece (snippets,
 * `bind:this`, `<svelte:head>`, stores…), several under 0.5 KB gzip, with the
 * largest part merged into an app chunk; every component chunk then imported
 * a long list of runtime names from several files. One chunk: total −12 KB
 * and every page's first load 3–6 KB lighter, although a page now also gets
 * the few runtime pieces it doesn't use. The chunk imports nothing, so it
 * can't join an import cycle. src/lib/svelteRuntimeChunk.test.ts checks this
 * rule stays in place.
 */
export function svelteRuntimeChunk(id: string): string | undefined {
	return /\/node_modules\/svelte\/src\//.test(id) && !id.includes('/svelte/src/compiler/') ? 'svelte' : undefined;
}

/**
 * The help glossary's "Input data" articles (src/lib/help/articles-data.ts)
 * as a chunk of their own (issue #66). Every /help page loads the glossary's
 * long text through content.ts, and as one module (articles.ts) it reached the
 * bundle guard's per-chunk ceiling. Split into two modules, Rolldown would
 * still put both in one chunk (the same importers), so this group names the
 * second: the /help pages load the same bytes as two files, in parallel, each
 * well under the ceiling. Nothing outside /help imports either (content.ts
 * says so), so no other page gains a request. A third module, the
 * "Scenarios and licensing" topic (articles-licensing.ts, 2026-10-02), is
 * its own chunk for the same reason.
 */
export function helpArticlesChunk(id: string): string | undefined {
	if (/\/src\/lib\/help\/articles-data\.ts$/.test(id)) return 'help-articles-data';
	// "Scenarios and licensing" (2026-10-02): articles.ts had grown past the ceiling again.
	if (/\/src\/lib\/help\/articles-licensing\.ts$/.test(id)) return 'help-articles-licensing';
	return undefined;
}

export default defineConfig({
	plugins: [shortFileNames(), workerChunks(), preload.plugin, chunkModuleMap(), sveltekit()],
	// The engine build record (WP-3.13): the web release workflow runs the
	// engine suite and a soak and puts the record in ENGINE_BUILD
	// (scripts/release/engine-build.mjs); the report's validation statement
	// prints it (lib/components/liability/engineBuild.ts). Any other build
	// (dev, e2e, CI) has none and says "Not recorded for this build".
	define: { __ENGINE_BUILD__: JSON.stringify(process.env.ENGINE_BUILD ?? '') },
	// The spreadsheet workers (`new Worker(new URL(…))`) are separate Rolldown
	// builds that don't read build.rolldownOptions, so they need the same
	// treeshake rule: without it the import worker kept engine code it never
	// calls (scenario ops, fit provenance) because it reaches those modules
	// through the barrel: 26.6 → 25.9 KB gzip (issue #9).
	worker: {
		rolldownOptions: { treeshake: { moduleSideEffects: engineIsPure } }
	},
	build: {
		// Ship ES2022 as written. Vite's default target ('modules': Safari 14,
		// Chrome 87) down-levels class fields, and Svelte 5's runtime and
		// compiled components are full of them, into defineProperty and WeakMap
		// helpers: ~6 KB gzip across the bundle. The app already needs newer
		// browsers than ES2022 does (HelpTip's popover: Chrome 114, Safari 17,
		// Firefox 125). Applies to the calibration and preview workers too,
		// which are part of the page build.
		target: 'es2022',
		// Oxc, Vite 8's own minifier (its default, spelled out). Under Vite 5
		// Terser beat esbuild by ~5% JS gzip, because its mangler reuses the
		// same short names in every scope (the bundle guard's change log,
		// 2026-09-27). Oxc does too: on 2026-09-28 it measured 1061 KB total
		// against Terser's 1066 KB on the same Vite 8 build, and Vite 8's Terser
		// path left the IIFE spreadsheet workers unminified (import worker
		// 27 → 30 KB gzip). So Terser is no longer a dependency.
		minify: 'oxc',
		modulePreload: { resolveDependencies: preload.resolveDependencies },
		rolldownOptions: {
			// svelteRuntimeChunk as a code-splitting group: Rolldown's replacement for
			// Rollup's manualChunks, which Rolldown deprecates; same result.
			// helpArticlesChunk likewise: the glossary's long text apart from the rest of /help.
			output: { codeSplitting: { groups: [{ name: svelteRuntimeChunk }, { name: helpArticlesChunk }] } },
			treeshake: {
				// See engineIsPure. Rolldown otherwise groups engine code by phantom
				// edges: the farm and share pages loaded ~13 KB of engine code they
				// never call and the catchment page ~8 KB, which now loads with the
				// Data, Settings and Runs tabs that call it (issue #9; numbers in
				// the bundle guard's change log).
				moduleSideEffects: engineIsPure
			}
		}
	}
});
