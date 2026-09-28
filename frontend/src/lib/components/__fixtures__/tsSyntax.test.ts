// Guard: TypeScript in a `.svelte` <script lang="ts"> must compile to JS that
// Rollup can parse, for both the client and the server (SSR) pass.
//
// svelte-check type-checks the TS but never compiles it, so a compiler bug in
// type stripping passes `pnpm check` and only surfaces in `vite build` (every
// build: production and the e2e site alike). svelte 5.56.0 printed optional
// parameters as `name?` (sveltejs/svelte#18455, fixed in 5.56.4); this pins
// that and any new case added to the fixture.
import { readFileSync } from 'node:fs';
import { compile, preprocess } from 'svelte/compiler';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import svelteConfig from '../../../../svelte.config.js';

const file = new URL('./TsSyntax.svelte', import.meta.url);

describe('TypeScript syntax in .svelte compiles to parseable JS', () => {
	it.each(['client', 'server'] as const)('%s output parses', async (generate) => {
		const source = readFileSync(file, 'utf8');
		// The same preprocess chain the builds use (svelte.config.js).
		const { code } = await preprocess(source, svelteConfig.preprocess ?? [], { filename: file.pathname });
		const { js } = compile(code, { generate, filename: file.pathname, runes: true });
		expect(() => parseAst(js.code)).not.toThrow();
	});

	it('loads through the Vite Svelte plugin', async () => {
		const mod = await import('./TsSyntax.svelte');
		expect(typeof mod.default).toBe('function');
	});
});
