// search_help's ranking (issue #610), over a small invented index and the real one.
import { describe, expect, it } from 'vitest';
import { HELP_INDEX, MAX_HITS, queryWords, searchHelpIndex, searchHelpTool, SNIPPET_CHARS, type HelpIndexEntry } from './searchHelp.js';
import type { ToolContext } from '../types.js';

const index: HelpIndexEntry[] = [
	{ kind: 'guide', id: 'g#1', title: 'Add data: rain', url: '/help/guides/g', text: 'Upload daily rain. The dam is mentioned once.' },
	{ kind: 'glossary', id: 'dam', title: 'Dam', aliases: ['reservoir'], url: '/help/glossary/units-and-dams#dam', summary: 'Where a unit stores water.', text: 'A dam fills from runoff.' },
	{ kind: 'glossary', id: 'x', title: 'Unrelated', url: '/u', text: 'nothing here' }
];

describe('searchHelpIndex', () => {
	it('ranks a title match first, an exact term highest, and leaves out entries with no word', () => {
		expect(searchHelpIndex('dam', 5, index).map((h) => h.title)).toEqual(['Dam', 'Add data: rain']);
		expect(searchHelpIndex('reservoir', 5, index).map((h) => h.title)).toEqual(['Dam']);
		expect(searchHelpIndex('upload rain', 5, index)[0]!.title).toBe('Add data: rain');
		expect(searchHelpIndex('the of', 5, index)).toEqual([]);
	});

	it('drops stop words and accents from the query', () => {
		expect(queryWords('What is the Ramírez dam?')).toEqual(['ramirez', 'dam']);
	});

	it('finds real help: GR4J, the EWR, calibration exclusions; each hit short', () => {
		expect(HELP_INDEX.length).toBeGreaterThan(100);
		for (const q of ['GR4J', 'EWR', 'calibration exclusions', 'Nash-Sutcliffe']) {
			const hits = searchHelpIndex(q, MAX_HITS);
			expect(hits.length, q).toBeGreaterThan(0);
			for (const h of hits) expect(h.text.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2);
		}
		expect(JSON.stringify(searchHelpIndex('dam storage', MAX_HITS)).length).toBeLessThan(12_000);
	});
});

describe('search_help', () => {
	const ctx = {} as ToolContext;
	it('validates its arguments and needs no database', async () => {
		expect((await searchHelpTool.run(ctx, { query: '' })).ok).toBe(false);
		expect((await searchHelpTool.run(ctx, { query: 'dam', limit: 99 })).ok).toBe(false);
		const r = await searchHelpTool.run(ctx, '{"query":"dam"}');
		expect(r.ok && (r.data as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
	});
});
