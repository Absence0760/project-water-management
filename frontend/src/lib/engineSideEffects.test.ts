// Guard: no engine module does anything when it loads.
//
// frontend/vite.config.ts tells Rollup the engine has no module side effects
// (`treeshake.moduleSideEffects`), so a module none of whose exports a chunk
// uses is dropped from that chunk's dependencies (issue #9: ~13 KB off the
// farm and share pages, ~8 KB off a catchment's first load). That is only safe
// while it is true: a top-level statement that registers something, patches a
// global or logs would silently not run in the production build. Declarations
// (imports, exports, types, functions, classes, `const x = …`) are fine; a bare
// top-level statement is not. Move it into a function the caller runs, or drop
// the engine from moduleSideEffects in vite.config.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENGINE_SRC = fileURLToPath(new URL('../../../packages/engine/src', import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
	});
}

const DECLARATIONS = new Set([
	ts.SyntaxKind.ImportDeclaration,
	ts.SyntaxKind.ImportEqualsDeclaration,
	ts.SyntaxKind.ExportDeclaration,
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.TypeAliasDeclaration,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.EnumDeclaration,
	ts.SyntaxKind.ModuleDeclaration,
	ts.SyntaxKind.VariableStatement,
	ts.SyntaxKind.EmptyStatement
]);

/** Top-level statements of a module that aren't declarations, as `file:line  text`. */
function sideEffects(file: string): string[] {
	const text = readFileSync(file, 'utf8');
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
	return source.statements
		.filter((s) => !DECLARATIONS.has(s.kind))
		.map((s) => {
			const line = source.getLineAndCharacterOfPosition(s.getStart()).line + 1;
			return `${relative(ENGINE_SRC, file)}:${line}  ${s.getText().split('\n')[0]}`;
		});
}

describe('the engine has no module side effects (vite.config.ts treeshake.moduleSideEffects)', () => {
	const files = sources(ENGINE_SRC);

	it('finds the engine sources', () => {
		expect(files.length).toBeGreaterThan(20);
		expect(files.some((f) => f.endsWith('run.ts'))).toBe(true);
	});

	it('has only declarations at the top level of every module', () => {
		expect(files.flatMap(sideEffects)).toEqual([]);
	});

	it('would catch a top-level statement', () => {
		const probe = ts.createSourceFile('probe.ts', "import { x } from './x';\nexport const a = 1;\nx.register(a);\n", ts.ScriptTarget.ES2022, true);
		expect(probe.statements.filter((s) => !DECLARATIONS.has(s.kind)).map((s) => s.getText())).toEqual(['x.register(a);']);
	});
});

describe('vite.config.ts applies the rule to every build', () => {
	type Treeshake = { treeshake?: { moduleSideEffects?: (id: string) => boolean } };
	it('treats engine modules as pure in the page build and in the spreadsheet workers', async () => {
		const config = (await import('../../vite.config')).default as { build: { rollupOptions: Treeshake }; worker: { rollupOptions: Treeshake } };
		// The workers built with `new Worker(new URL(…))` are separate Rollup builds that ignore
		// build.rollupOptions; without their own rule the import worker kept engine code it never calls.
		for (const rule of [config.build.rollupOptions.treeshake?.moduleSideEffects, config.worker.rollupOptions.treeshake?.moduleSideEffects]) {
			expect(rule?.('/repo/packages/engine/src/run.ts')).toBe(false);
			expect(rule?.('/repo/frontend/src/lib/api/client.ts')).toBe(true);
		}
	});
});
