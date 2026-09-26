// Guard: the project list (routes/+page.svelte) loads the import dialog on
// demand (issue #9; docs/architecture.md § Code splitting). The dialog, its
// preview, the workbook review and what they import (the series provenance
// and kinds code from the engine) are ~18 KB gzip that nobody needs until
// they press an import button; loaded with the page they were 16 KB of
// home's 81 KB first load. This fails if the page, or anything it imports
// statically, value-imports the import components or the spreadsheet code
// again. Type-only imports are erased and don't count.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const HOME = join(SRC, 'routes/+page.svelte');

/** Static value imports (and re-exports) of a module: `import type` is left out. */
function staticImports(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\b)([^;'"]*?)\s*from\s+['"]([^'"]+)['"]/gm)) {
		// `import { type A, type B } from …` is erased too.
		const names = m[1]!.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
		if (m[1]!.startsWith('{') && names.length && names.every((n) => n.startsWith('type '))) continue;
		out.push(m[2]!);
	}
	for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
	return out;
}

/** A frontend source file for an import specifier, or null for a package ($app, svelte, the engine). */
function resolve(from: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith('$lib/')) base = join(SRC, 'lib', spec.slice(5));
	else if (spec === '$lib') base = join(SRC, 'lib');
	else if (spec.startsWith('.')) base = join(dirname(from), spec);
	else return null;
	if (/\.(css|json|svg|png)$/.test(base)) return null;
	for (const c of [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts')]) {
		if (existsSync(c) && !c.endsWith('/') && /\.(ts|js|svelte)$/.test(c)) return c;
	}
	throw new Error(`${relative(SRC, from)}: cannot resolve ${spec}`);
}

/** Every frontend file the page reaches through static value imports. */
function reachable(entry: string): Map<string, string> {
	const seen = new Map<string, string>([[entry, '']]);
	const queue = [entry];
	while (queue.length) {
		const file = queue.shift()!;
		for (const spec of staticImports(readFileSync(file, 'utf8'))) {
			const target = resolve(file, spec);
			if (target && !seen.has(target)) {
				seen.set(target, relative(SRC, file));
				queue.push(target);
			}
		}
	}
	return seen;
}

describe('the project list loads the import dialog on demand', () => {
	it('imports the dialog dynamically', () => {
		expect(readFileSync(HOME, 'utf8')).toContain("import('$lib/components/import/ImportProjectDialog.svelte')");
	});

	it('reaches no import component or spreadsheet code through a static import', () => {
		const files = reachable(HOME);
		// The walk itself works: the page's own list components are reached.
		expect(files.has(join(SRC, 'lib/components/projects/ProjectTable.svelte'))).toBe(true);
		const bad = [...files]
			.map(([file, via]) => [relative(SRC, file), via])
			.filter(([file]) => /^lib\/(components\/import|spreadsheet)\//.test(file!))
			.map(([file, via]) => `${file} (imported by ${via})`);
		expect(bad).toEqual([]);
	});

	it('the import detector sees value imports and skips type-only ones', () => {
		expect(
			staticImports(
				[
					"import A from './a.svelte';",
					"import { b, type C } from './b';",
					"import type { D } from './d';",
					"import { type E } from './e';",
					"export { f } from './f';",
					"import './g.css';",
					"const h = () => import('./h.svelte');"
				].join('\n')
			)
		).toEqual(['./a.svelte', './b', './f', './g.css']);
	});
});
