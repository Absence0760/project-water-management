// Guard: the scoping class Svelte adds to each component's elements is
// `s<hash>` (svelte.config.js compilerOptions.cssHash; Svelte's default
// `svelte-<hash>` cost ~2.6 KB gzip more across the bundle, issue #9). A
// short class could in principle equal one the app writes itself (`small`,
// `steps`…), and that element would then pick up another component's scoped
// rules. This works out every component's class the way the build does (the
// real hash of its real file name) and checks none is also an app class.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import svelteConfig from '../../svelte.config.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((e) => {
		const p = join(dir, e);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

const files = walk(SRC);
const components = files.filter((f) => f.endsWith('.svelte'));

/** The class the build scopes `file`'s styles with: a one-rule component compiled under that file name. */
function scopeClass(file: string): string {
	const { js } = compile('<p class="x">a</p><style>.x { color: red; }</style>', { ...svelteConfig.compilerOptions, filename: file });
	const m = /class="x ([^"]+)"/.exec(js.code);
	if (!m) throw new Error(`no scope class in the output for ${file}`);
	return m[1]!;
}

/** Every class name the app writes: class attributes, class: directives, and selectors in styles. */
function appClasses(): Set<string> {
	const out = new Set<string>();
	for (const f of files.filter((f) => /\.(svelte|css|ts)$/.test(f) && !f.endsWith('.test.ts'))) {
		const text = readFileSync(f, 'utf8');
		for (const m of text.matchAll(/class="([^"]*)"/g)) for (const t of m[1]!.split(/\s+/)) if (/^[\w-]+$/.test(t)) out.add(t);
		for (const m of text.matchAll(/class:([\w-]+)/g)) out.add(m[1]!);
		if (!f.endsWith('.ts')) for (const m of text.matchAll(/\.([a-zA-Z_][\w-]*)/g)) out.add(m[1]!);
	}
	return out;
}

describe('the components’ style scoping class', () => {
	it('is s + Svelte’s hash of the file name', () => {
		const c = scopeClass(components[0]!);
		expect(c).toMatch(/^s[0-9a-z]+$/);
		expect(c).not.toMatch(/^svelte-/);
	});

	it('is never a class the app writes itself', () => {
		const mine = appClasses();
		expect(mine.has('small')).toBe(true); // the scan sees the app's classes
		const clashes = components.map((f) => [f, scopeClass(f)] as const).filter(([, c]) => mine.has(c));
		expect(clashes).toEqual([]);
	});

	it('is unique to each component', () => {
		const seen = new Map<string, string>();
		for (const f of components) {
			const c = scopeClass(f);
			expect(seen.get(c), `${f} and ${seen.get(c)} share ${c}`).toBeUndefined();
			seen.set(c, f);
		}
	});
});
