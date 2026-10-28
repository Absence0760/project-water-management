// Guard: the build's copy of deepmerge carries this repo's patch for
// GHSA-gcqx-w48m-w2h4 (patches/deepmerge@4.3.1.patch, pnpm-workspace.yaml
// patchedDependencies). 4.3.1 is the last release and has no fix, so the
// patch is what stops a "__proto__" key from setting the merged object's
// prototype. vite-plugin-svelte merges the Svelte config with it.
//
// If this fails after a bump, either the patch no longer applies (re-make it
// with `pnpm patch deepmerge@<version>`) or a fixed release has landed (drop
// the patch and its osv-scanner.toml entry).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// deepmerge isn't a frontend dependency; load the copy the Svelte plugin resolves.
const pluginRequire = createRequire(createRequire(import.meta.url).resolve('@sveltejs/vite-plugin-svelte'));
const deepmerge = pluginRequire('deepmerge') as (target: object, source: object) => Record<string, unknown>;

describe('deepmerge prototype poisoning (GHSA-gcqx-w48m-w2h4)', () => {
	const poisoned = () => JSON.parse('{"__proto__": {"polluted": "yes"}}') as object;

	it('does not set the prototype from a "__proto__" key when the target has none', () => {
		const out = deepmerge(Object.create(null) as object, poisoned());
		expect(out.polluted).toBeUndefined();
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
	});

	it('does not set the prototype for a plain target either', () => {
		const out = deepmerge({}, poisoned());
		expect(out.polluted).toBeUndefined();
	});

	it('still merges ordinary keys deeply (positive control)', () => {
		expect(deepmerge({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
	});
});
