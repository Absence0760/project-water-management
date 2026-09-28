// Guard: the engine modules pages import small things from stay apart from
// the model code (issue #9).
//
// The calibration worker is a chunk of the page build (frontend/vite.config.ts,
// autocalWorkerChunk), so it shares engine chunks with the pages. A chunk
// holds whole modules, and a module shared by a page and the worker carries
// everything either of them uses, with its imports. So a constant a page reads
// must not sit in, or import, a module holding the run, the fit or the
// ensemble: the page would then load all of it (Runs +27 KB and compare
// +32 KB gzip when this was measured). The light modules below hold what
// pages read; this test fails if one of them reaches a heavy module through a
// value import. Type-only imports are erased and don't count.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENGINE_SRC = fileURLToPath(new URL('../../../packages/engine/src', import.meta.url));

/** Modules pages import constants, labels and small checks from. */
const LIGHT = [
	'version.ts',
	'calendar.ts',
	'project.ts',
	'calibrate/params.ts',
	'calibrate/objectives.ts',
	'runoff/params.ts',
	'runoff/pet.ts',
	'reference/wr2012Settings.ts',
	'uncertainty/options.ts',
	'uncertainty/sensitivityVerdict.ts',
	'network/damCurve.ts'
];

/** The run, the fit, the ensemble and the model code they need. */
const HEAVY = [
	'run.ts',
	'prepare.ts',
	'rain.ts',
	'quality.ts',
	'calibrate/calibrate.ts',
	'calibrate/objective.ts',
	'uncertainty/ensemble.ts',
	'uncertainty/sensitivity.ts',
	'network/simulate.ts',
	'network/dam.ts',
	'reference/wr2012.ts',
	'runoff/gr4j.ts',
	'runoff/simulate.ts'
];

/** Engine files a module imports values from (relative to ENGINE_SRC). */
function valueImports(file: string): string[] {
	const path = join(ENGINE_SRC, file);
	const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
	const out: string[] = [];
	for (const s of source.statements) {
		let spec: ts.Expression | undefined;
		if (ts.isImportDeclaration(s)) {
			const clause = s.importClause;
			if (!clause || clause.isTypeOnly) continue;
			const named = clause.namedBindings;
			const onlyTypes = !clause.name && named && ts.isNamedImports(named) && named.elements.every((e) => e.isTypeOnly);
			if (onlyTypes) continue;
			spec = s.moduleSpecifier;
		} else if (ts.isExportDeclaration(s) && s.moduleSpecifier) {
			if (s.isTypeOnly) continue;
			if (s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.every((e) => e.isTypeOnly)) continue;
			spec = s.moduleSpecifier;
		}
		if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue;
		const base = join(dirname(path), spec.text);
		const target = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
		if (target) out.push(relative(ENGINE_SRC, target));
	}
	return out;
}

/** Every engine file `file` reaches through value imports, with the path to each. */
function reach(file: string): Map<string, string[]> {
	const paths = new Map<string, string[]>([[file, [file]]]);
	const queue = [file];
	while (queue.length) {
		const f = queue.shift()!;
		for (const g of valueImports(f)) {
			if (paths.has(g)) continue;
			paths.set(g, [...paths.get(f)!, g]);
			queue.push(g);
		}
	}
	return paths;
}

describe('engine split: page-side modules stay apart from the model (issue #9)', () => {
	it('finds every listed module', () => {
		for (const f of [...LIGHT, ...HEAVY]) expect(existsSync(join(ENGINE_SRC, f)), f).toBe(true);
	});

	it.each(LIGHT)('%s reaches no heavy module through a value import', (file) => {
		const reached = reach(file);
		const bad = HEAVY.filter((h) => reached.has(h)).map((h) => reached.get(h)!.join(' → '));
		expect(bad).toEqual([]);
	});

	it("prepare.ts (the Data tab's series preview) doesn't reach the network, the fit or the WR2012 comparison", () => {
		const reached = reach('prepare.ts');
		const bad = ['run.ts', 'network/simulate.ts', 'calibrate/calibrate.ts', 'reference/wr2012.ts', 'uncertainty/ensemble.ts']
			.filter((h) => reached.has(h))
			.map((h) => reached.get(h)!.join(' → '));
		expect(bad).toEqual([]);
	});

	it('would catch a heavy import (positive control)', () => {
		// run.ts imports prepare.ts and the network simulation directly.
		const reached = reach('run.ts');
		expect(reached.has('prepare.ts')).toBe(true);
		expect(reached.has('network/simulate.ts')).toBe(true);
	});
});
