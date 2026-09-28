// Guard: output file names are short (frontend/vite.config.ts,
// shortFileNames; issue #9): 7-character hashes and CSS files without the
// component name. The names sit in import statements, preload lists and the
// route manifest, where random characters compress badly (−2.7 KB gzip,
// scripts/guards/check_web_bundle_budget.mjs's change log).
import { describe, expect, it } from 'vitest';
import config, { shortFileNames } from '../../vite.config';

type Names = { entryFileNames?: unknown; chunkFileNames?: unknown; assetFileNames?: unknown };
type Hook = (output: Names) => Names;
const rewrite = shortFileNames().outputOptions as unknown as Hook;

describe('short output file names', () => {
	it('shortens SvelteKit’s client patterns', () => {
		const out = rewrite({
			entryFileNames: '_app/immutable/[name].[hash].js',
			chunkFileNames: '_app/immutable/chunks/[hash].js',
			assetFileNames: '_app/immutable/assets/[name].[hash][extname]'
		});
		expect(out.entryFileNames).toBe('_app/immutable/[name].[hash:7].js');
		expect(out.chunkFileNames).toBe('_app/immutable/chunks/[hash:7].js');
		expect(out.assetFileNames).toBe('_app/immutable/assets/[hash:7][extname]');
	});

	it('leaves patterns without a hash, and functions, alone', () => {
		const fn = () => 'x.js';
		const out = rewrite({ entryFileNames: '[name].js', chunkFileNames: fn, assetFileNames: 'assets/[name][extname]' });
		expect(out.entryFileNames).toBe('[name].js');
		expect(out.chunkFileNames).toBe(fn);
		expect(out.assetFileNames).toBe('assets/[name][extname]');
	});

	it('runs before the calibration worker plugin, which needs the chunk pattern as a string', () => {
		const names = (config as { plugins: { name?: string }[] }).plugins.flat().map((p) => p?.name);
		expect(names.indexOf('water:short-file-names')).toBeGreaterThanOrEqual(0);
		expect(names.indexOf('water:short-file-names')).toBeLessThan(names.indexOf('water:autocal-worker-chunk'));
	});
});
