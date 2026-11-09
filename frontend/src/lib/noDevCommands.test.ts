// The people who use the app (hydrologists, farmers, an authority's staff)
// are never shown a developer's command (issue #586 C5): a missing dataset is
// said in plain words ("There’s no … on this server yet"), the way
// components/proposals/ProposalNoDataset.svelte does, and loading it is the
// operator's job, written up in docs/. This guard reads the text of each
// .svelte template, its attribute values and its script's string literals
// under frontend/src, and fails on `pnpm ` in any of them. Comments, styles,
// imports and type annotations aren't read, so a code comment may name a
// command.
//
// Allowed, narrowly (`ALLOWED`, by file and exact text): the evidence pack's
// reproduction command, which the pack page and the public verify page give
// on purpose to anyone holding a reproduction bundle and the app's source
// code (docs/evidence-pack.md § Reproduction): it is how a third party checks
// a pack, not a missing-data hint.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const COMMAND = /\bpnpm /;
const SRC = resolve(import.meta.dirname, '..');
const ROOT = resolve(SRC, '../..');

/** Files (relative to the repo root) and the exact texts in each that may name a command. */
const ALLOWED: Record<string, string[]> = {
	'frontend/src/routes/projects/[id]/packs/[packId]/+page.svelte': ['pnpm reproduce:pack'],
	'frontend/src/routes/verify/[[code]]/+page.svelte': ['pnpm reproduce:pack']
};

/** The template text, attribute values and script string literals of a component that name a command, with their lines. */
function commandHits(source: string): { line: number; text: string }[] {
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
		if (type === 'Comment' || type === 'StyleSheet' || type === 'ImportDeclaration' || type === 'ExportAllDeclaration' || type.startsWith('TS')) return;
		let text: unknown;
		if (type === 'Text') text = n.data;
		else if (type === 'Literal') text = n.value;
		else if (type === 'TemplateElement') text = (n.value as { cooked?: string } | undefined)?.cooked;
		if (typeof text === 'string' && COMMAND.test(text)) out.push({ line: lineOf(n.start), text: text.trim() });
		for (const [key, value] of Object.entries(n)) {
			if (key === 'css' || key === 'loc' || key === 'metadata' || key === 'leadingComments' || key === 'trailingComments' || key === 'comments') continue;
			walk(value);
		}
	};
	walk(ast);
	return out.sort((a, b) => a.line - b.line);
}

function components(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__fixtures__' ? [] : components(path);
		return e.name.endsWith('.svelte') ? [path] : [];
	});
}

describe('no developer command in what the app shows (issue #586 C5)', () => {
	it('finds one in a template, an attribute and a script string, not in comments (positive control)', () => {
		const component = [
			'<script lang="ts">',
			'\t// run `pnpm import:map-grid` first: a comment is fine',
			"\tconst hint = 'Run pnpm import:evaporation first';",
			'</script>',
			'<!-- pnpm dev in a comment is fine -->',
			'<p title="pnpm seed:examples">Load it (<code>pnpm import:map-grid &lt;grid.asc&gt;</code>).</p>',
			'<p>No pnpm-lock here, and nothing to run.</p>'
		].join('\n');
		expect(commandHits(component).map((h) => h.text)).toEqual(['Run pnpm import:evaporation first', 'pnpm seed:examples', 'pnpm import:map-grid <grid.asc>']);
	});

	it('no component under frontend/src names one, beyond the evidence pack’s reproduction command', () => {
		const hits: string[] = [];
		const allowedSeen: string[] = [];
		for (const path of components(SRC)) {
			const source = readFileSync(path, 'utf8');
			if (!COMMAND.test(source)) continue;
			const rel = relative(ROOT, path);
			for (const h of commandHits(source)) {
				if (ALLOWED[rel]?.some((t) => h.text.includes(t))) allowedSeen.push(rel);
				else hits.push(`${rel}:${h.line}: ${h.text.slice(0, 120)}`);
			}
		}
		expect(hits).toEqual([]);
		// Every allowance still has its text, so a stale one is dropped, not kept.
		expect([...new Set(allowedSeen)].sort()).toEqual(Object.keys(ALLOWED).sort());
	});
});
