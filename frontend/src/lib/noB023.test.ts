// "b023" (and "b02x") is the name of the client's Excel build, not a name
// users know the tool by, so no text the app shows may say it (issue #523):
// the workbook importer is "Import workbook", a workbook "a Water Balance Tool
// workbook". This guard reads every string a user can meet: the text of each
// .svelte template and the string literals of its script, and the string
// literals of every .ts module in the frontend, the backend (API errors,
// emails, report PDFs, CSVs) and the engine (run warnings, report text). Code
// comments, imports and type-level literals aren't read.
//
// Exempt, narrowly: stored values and ids (`EXEMPT_VALUES`, never shown), a
// help entry's `source` (the glossary doesn't show it, types.ts), and files
// that are test support or generated docs prose (`EXEMPT_FILES`).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const NAME = /b02[3x]/i;
const ROOT = resolve(import.meta.dirname, '../../..');
const TREES = ['frontend/src', 'backend/src', 'packages/engine/src'];

/** Stored values and ids that are never shown (DB values, API enums, option ids). */
const EXEMPT_VALUES = new Set(['b023-workbook', 'not-b023', 'b023', 'crop-factors-b023']);

/** Test support and generated docs prose, relative to the repo root. */
const EXEMPT_FILES = new Set([
	// Builds synthetic workbooks for tests; its strings are cells, not UI.
	'frontend/src/lib/spreadsheet/import/testWorkbook.ts',
	// The current methodology statement (docs/methodology), cited by hash and never shown in the app.
	'packages/engine/src/liability/methodology-text.generated.ts'
]);

/** Help entries keep their `source` for maintainers; the glossary doesn't show it. */
const HELP_SOURCE_FILE = /^frontend\/src\/lib\/help\/articles[\w-]*\.ts$/;

function offending(text: string): boolean {
	return NAME.test(text) && !EXEMPT_VALUES.has(text);
}

/** Every string literal of a TS module a user could see, with its line. */
function tsHits(file: string, source: string): { line: number; text: string }[] {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const helpSources = HELP_SOURCE_FILE.test(file);
	const out: { line: number; text: string }[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
		if (helpSources && ts.isPropertyAssignment(node) && node.name.getText(sf) === 'source') return;
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
		) {
			if (offending(node.text)) out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

/** The template text, attribute values and script string literals of a component, with their lines. */
function svelteHits(source: string): { line: number; text: string }[] {
	const ast = parse(source, { modern: true }) as unknown;
	const out: { line: number; text: string }[] = [];
	const lineOf = (pos: unknown) => (typeof pos === 'number' ? source.slice(0, pos).split('\n').length : 0);
	const seen = new WeakSet<object>();
	const walk = (node: unknown): void => {
		if (!node || typeof node !== 'object' || seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) return node.forEach(walk);
		const n = node as Record<string, unknown> & { type?: string; start?: number };
		const type = n.type ?? '';
		// Comments, styles, imports and type annotations are never shown.
		if (type === 'Comment' || type === 'StyleSheet' || type === 'ImportDeclaration' || type === 'ExportAllDeclaration' || type.startsWith('TS')) return;
		let text: unknown;
		if (type === 'Text') text = n.data;
		else if (type === 'Literal') text = n.value;
		else if (type === 'TemplateElement') text = (n.value as { cooked?: string } | undefined)?.cooked;
		if (typeof text === 'string' && offending(text)) out.push({ line: lineOf(n.start), text });
		for (const [key, value] of Object.entries(n)) {
			if (key === 'css' || key === 'loc' || key === 'metadata' || key === 'leadingComments' || key === 'trailingComments' || key === 'comments') continue;
			walk(value);
		}
	};
	walk(ast);
	return out.sort((a, b) => a.line - b.line);
}

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' || e.name === '__fixtures__' ? [] : files(path);
		if (/\.test\.ts$/.test(e.name)) return [];
		return /\.(ts|svelte)$/.test(e.name) ? [path] : [];
	});
}

describe('no "b023" in what the app shows (issue #523)', () => {
	it('finds it in a template, an attribute and a script string (positive control)', () => {
		const component = [
			'<script lang="ts">',
			'\t// a comment about the b023 workbook is fine',
			"\timport x from './b023.ts';",
			"\ttype S = 'b023-workbook' | 'b023x';",
			"\tconst label = 'Import b023 workbook';",
			"\tconst source = 'b023-workbook';",
			'</script>',
			'<!-- b023 in a comment is fine -->',
			'<button title="A B023 file">Read the b02x build</button>',
			'<style>.b023 { color: red; }</style>'
		].join('\n');
		expect(svelteHits(component).map((h) => h.text)).toEqual(['Import b023 workbook', 'A B023 file', 'Read the b02x build']);
	});

	it('finds it in a module string and a template literal, not in comments, ids or a help source (positive control)', () => {
		const module = [
			'// b023 in a comment',
			"import { a } from './b023';",
			"type S = 'b023-workbook';",
			"export const x = { source: 'b023 Farm spec', id: 'b023', title: 'A b023 workbook' };",
			'export const y = `This isn\'t a b023 workbook: ${1}`;'
		].join('\n');
		expect(tsHits('frontend/src/lib/help/articles.ts', module).map((h) => h.text)).toEqual(['A b023 workbook', "This isn't a b023 workbook: "]);
		// Outside the help articles, `source` is an ordinary property.
		expect(tsHits('frontend/src/lib/x.ts', module).map((h) => h.text)).toEqual(['b023 Farm spec', 'A b023 workbook', "This isn't a b023 workbook: "]);
	});

	it('no component, module or i18n catalogue in the frontend, backend or engine shows it', () => {
		const hits: string[] = [];
		for (const tree of TREES) {
			for (const path of files(join(ROOT, tree))) {
				const rel = relative(ROOT, path);
				if (EXEMPT_FILES.has(rel)) continue;
				const source = readFileSync(path, 'utf8');
				if (!NAME.test(source)) continue;
				const found = path.endsWith('.svelte') ? svelteHits(source) : tsHits(rel, source);
				for (const h of found) hits.push(`${rel}:${h.line}: ${h.text.trim().slice(0, 120)}`);
			}
		}
		expect(hits).toEqual([]);
	});
});
