import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		// Ship ES2022 as written. Vite's default target ('modules': Safari 14,
		// Chrome 87) down-levels class fields, and Svelte 5's runtime and
		// compiled components are full of them, into defineProperty and WeakMap
		// helpers: ~6 KB gzip across the bundle. The app already needs newer
		// browsers than ES2022 does (HelpTip's popover: Chrome 114, Safari 17,
		// Firefox 125). Applies to the calibration worker's bundle too.
		target: 'es2022',
		rollupOptions: {
			treeshake: {
				// The engine is pure (no I/O, and no module does anything when it
				// loads: src/lib/engineSideEffects.test.ts guards that), so an
				// engine module whose exports a chunk doesn't use is no dependency
				// of that chunk. Without this, Rollup keeps every engine module a
				// page reaches through the `@water-management/engine` barrel as a
				// dependency "in case it has side effects", and groups engine code
				// by those phantom edges: the farm and share pages loaded ~13 KB of
				// engine code they never call and the catchment page ~8 KB, which
				// now loads with the Data, Settings and Runs tabs that call it
				// (issue #9; numbers in the bundle guard's change log).
				moduleSideEffects: (id) => !id.includes('/packages/engine/src/')
			}
		}
	}
});
