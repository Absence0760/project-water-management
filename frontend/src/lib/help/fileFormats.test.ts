// The File formats help page's list (issue #477): every format once, under a
// unique anchor, and every "Expected format" note in the app on a format the
// page lists, so the page can't miss a box. The note and the page show the
// same object (common/FormatHelp.svelte), so their words can't differ.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatPlain } from '$lib/components/common/formatHelp';
import { FILE_FORMATS, FORMAT_GROUPS } from './fileFormats';

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? svelteFiles(join(dir, e.name)) : e.name.endsWith('.svelte') ? [join(dir, e.name)] : []
	);
}

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const REGISTRY = readFileSync(fileURLToPath(new URL('./fileFormats.ts', import.meta.url)), 'utf8');
/** A format constant (`PLANTINGS_FORMAT`) or a format function (`drmFormat(`) named in a prop expression. */
const FORMAT_NAMES = /\b([A-Z][A-Z0-9_]*_FORMAT)\b|\b([a-z]\w*Format)\(/g;

describe('the File formats page lists every format', () => {
	it('each once, under a unique lowercase anchor, with what its box takes and its rules', () => {
		const ids = FILE_FORMATS.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const f of FILE_FORMATS) {
			expect(f.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(f.title.trim()).not.toBe('');
			expect(f.where.trim()).not.toBe('');
			expect(f.accepts.trim()).not.toBe('');
			expect(f.rules.length).toBeGreaterThan(0);
			// The markup reads back to words: no stray backtick or asterisk shows on the page.
			for (const r of [f.lead ?? '', ...f.rules]) expect(formatPlain(r), `${f.id}: ${r}`).not.toMatch(/[`]|\*\*/);
		}
		expect(new Set(FORMAT_GROUPS.map((g) => g.id)).size).toBe(FORMAT_GROUPS.length);
		expect(ids).toContain('plantings');
	});

	it('every Expected format note in the app is on a format the page lists', () => {
		const files = svelteFiles(SRC);
		const named = new Set<string>();
		for (const f of files) {
			const text = readFileSync(f, 'utf8');
			// The notes (FormatHelp) and the grids' paste dialog, which shows its grid's format in one.
			const props = [...text.matchAll(/<(?:FormatHelp|GridPasteDialog)\b/g)].map((m) => /\sformat=\{([^}\n]*)\}/.exec(text.slice(m.index, m.index + 2000))?.[1] ?? '');
			for (const p of props) for (const m of p.matchAll(FORMAT_NAMES)) named.add(m[1] ?? m[2]!);
		}
		// Forwarders: the grid dialog wraps its grid's format, DrmFormatHelp the DRM one (its callers are its targets).
		named.delete('gridFileFormat');
		expect(named.size).toBeGreaterThan(10);
		const missing = [...named].filter((n) => !new RegExp(`\\b${n}\\b`).test(REGISTRY));
		expect(missing, 'formats shown beside a box but not on the File formats page ($lib/help/fileFormats.ts)').toEqual([]);
	});
});
