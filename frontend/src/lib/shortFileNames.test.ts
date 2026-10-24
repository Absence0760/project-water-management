// Guard: output file names are short (frontend/vite.config.ts,
// shortFileNames; issue #9): 7-character hashes and CSS files without the
// component name. The names sit in import statements, preload lists and the
// route manifest, where random characters compress badly (−2.7 KB gzip,
// the bundle budget's history, scripts/guards/bundle-budget/README.md).
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

	it('shortens what a pattern function returns: SvelteKit 3 names client chunks with one, the route manifest without a hash', () => {
		const kit = (info: { name: string }) => (info.name === 'sveltekit-manifest' ? '_app/manifest.js' : '_app/immutable/chunks/[hash].js');
		const out = rewrite({ chunkFileNames: kit }) as { chunkFileNames: typeof kit };
		expect(out.chunkFileNames({ name: 'x' })).toBe('_app/immutable/chunks/[hash:7].js');
		expect(out.chunkFileNames({ name: 'sveltekit-manifest' })).toBe('_app/manifest.js');
	});

	it('leaves patterns without a hash alone', () => {
		const out = rewrite({ entryFileNames: '[name].js', chunkFileNames: () => 'x.js', assetFileNames: 'assets/[name][extname]' }) as Names & { chunkFileNames: () => string };
		expect(out.entryFileNames).toBe('[name].js');
		expect(out.chunkFileNames()).toBe('x.js');
		expect(out.assetFileNames).toBe('assets/[name][extname]');
	});

	it('runs before the worker chunk plugin, which renames what it returns', () => {
		const names = (config as { plugins: { name?: string }[] }).plugins.flat().map((p) => p?.name);
		expect(names.indexOf('water:short-file-names')).toBeGreaterThanOrEqual(0);
		expect(names.indexOf('water:short-file-names')).toBeLessThan(names.indexOf('water:worker-chunks'));
	});
});
