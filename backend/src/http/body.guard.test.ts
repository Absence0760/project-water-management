// Every request body is read through readJson (http/body.ts), which refuses a
// NUL, an overflowing number or nesting past MAX_JSON_DEPTH with 400
// body_refused. A route that reads the body itself (`c.req.json()`, often as
// `.catch(() => ({}))`) skips those checks, and a NUL in, say, a run label
// then reaches Postgres as a 500. This scan fails on any such read outside the
// allowlist.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that may read a raw body, each with why. Keep it short: a raw read
 * must do readJson's checks itself or never hand the text to Postgres.
 */
const ALLOWED: Record<string, string> = {
	'http/body.ts': 'readJson itself: the one place a JSON body is read'
};

/** A raw body read: `req.json()`, `req.text()`, `req.parseBody()`, … or the same on `req.raw`, or the raw stream. */
const RAW_READ = /\breq\s*(?:\.\s*raw\s*)?\.\s*(?:json|text|parseBody|arrayBuffer|blob|formData)\s*\(|\breq\s*\.\s*raw\s*\.\s*body\b/;

/** The source with comments removed, so a comment that names `c.req.json()` isn't a read. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function rawReads(text: string): number[] {
	return code(text)
		.split('\n')
		.flatMap((line, i) => (RAW_READ.test(line) ? [i + 1] : []));
}

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === '__tests__' || e.name === '__fixtures__' ? [] : sources(p);
		return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
	});
}

describe('request bodies go through readJson', () => {
	it('no source file under backend/src reads a body any other way', () => {
		const files = sources(SRC);
		expect(files.length).toBeGreaterThan(100);
		const offenders: string[] = [];
		const readers = new Set<string>();
		for (const file of files) {
			const rel = relative(SRC, file).split('\\').join('/');
			const lines = rawReads(readFileSync(file, 'utf8'));
			if (!lines.length) continue;
			readers.add(rel);
			if (!ALLOWED[rel]) offenders.push(`${rel}:${lines.join(',')}`);
		}
		expect(offenders, 'read the body with readJson(c) (or readJson(c, { optional: true }) when an empty body means {})').toEqual([]);
		// Positive control, and no stale allowlist entry: each allowed file still reads a body.
		expect([...readers].sort()).toEqual(Object.keys(ALLOWED).sort());
	});

	it.each([
		'const b = await c.req.json().catch(() => ({}));',
		'const json = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json();',
		'const t = await c.req.text();',
		'const f = await c.req.parseBody();',
		'const r = await c.req.raw.json();',
		'const s = c.req.raw.body;',
		'const { req } = c; await req.json();'
	])('flags %s', (line) => {
		// Line numbers survive a block comment above the read.
		expect(rawReads(`import x from 'y';\n/**\n * doc\n */\n${line}\n`)).toEqual([5]);
	});

	it.each([
		'const b = await readJson(c);',
		'// c.req.json() would make a SyntaxError a 500',
		'/* c.req.text() */ const b = await readJson(c, { optional: true });',
		"const url = 'http://x'; const q = c.req.query('token');"
	])('does not flag %s', (line) => {
		expect(rawReads(line)).toEqual([]);
	});
});
