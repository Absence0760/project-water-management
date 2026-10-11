// The grids' paste dialog with a grid that adds rows and gives an Expected
// format (issue #477): the shared note with its example file, the summary
// counting the rows it adds, and Apply named for an add alone. Rendered with
// Svelte's server renderer; the browser flow is pinned by e2e (grid-paste.spec.ts).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import GridPasteDialog from './GridPasteDialog.svelte';
import type { PastePlan } from '$lib/spreadsheet/paste/grid';

vi.mock('$app/paths', () => ({ base: '' }));

const base = {
	open: true,
	title: 'Paste crop factors',
	layout: 'A row per crop.',
	onapply: () => {},
	csv: () => 'Crop\r\n',
	csvName: 'crop-factors.csv',
	rowNoun: ['crop', 'crops'] as const
};
const added = (changes: number): PastePlan => ({
	changes: Array.from({ length: changes }, (_, i) => ({ rowId: 'new:0', rowName: 'Maize (new crop)', key: String(i), column: 'Oct', unit: '', from: null, to: 0.3 })),
	unchanged: 0,
	notes: [],
	added: [{ id: 'new:0', name: 'Maize' }]
});

describe('GridPasteDialog (issue #477)', () => {
	it('shows the Expected format, its rules, the shared decimal rule and the example file', () => {
		const html = render(GridPasteDialog, {
			props: { ...base, text: '', plan: () => added(1), format: { id: 'crop-factors', title: 'Crop factors', where: 'Crops & demand', rules: ['A heading row: Crop, then Oct to Sep.'], example: 'Crop,Oct\r\nMaize,0.3\r\n', exampleName: 'crop-factors-example.csv' } }
		}).body;
		expect(html).toContain('data-testid="format-help"');
		expect(html).toContain('A heading row: Crop, then Oct to Sep.');
		expect(html).toContain('Decimals with a point (12.5) or a comma (12,5)');
		expect(html).toMatch(/download="crop-factors-example.csv"/);
		expect(html).toContain(encodeURIComponent('Crop,Oct\r\nMaize,0.3'));
	});

	it('has no format note without one', () => {
		expect(render(GridPasteDialog, { props: { ...base, text: '', plan: () => added(1) } }).body).not.toContain('data-testid="format-help"');
	});

	it('counts the rows a paste adds, and names Apply for an add alone', () => {
		const some = render(GridPasteDialog, { props: { ...base, text: 'x', plan: () => added(12) } }).body;
		expect(some).toContain('Adds 1 crop; 12 values change.');
		expect(some).toMatch(/Apply 12 changes/);
		const bare = render(GridPasteDialog, { props: { ...base, text: 'x', plan: () => added(0) } }).body;
		expect(bare).toContain('Adds 1 crop.');
		expect(bare).toMatch(/Add 1 crop/);
	});
});

describe('GridPasteDialog for a whole table (issue #521)', () => {
	const plan = (): PastePlan => ({ changes: [{ rowId: '0', rowName: 'Oct', key: '0', column: '10 %', unit: 'm³/s', from: 1, to: 2 }], unchanged: 0, notes: [] });
	it('says only its own layout, with no start-cell or blank-cell rule', () => {
		const html = render(GridPasteDialog, { props: { ...base, layout: 'The 12 month rows.', wholeTable: true, text: 'x', plan } }).body;
		expect(html).toContain('The 12 month rows.');
		expect(html).not.toContain('data-testid="paste-where"');
		expect(html).not.toContain('A blank cell or a dash');
		expect(html).toMatch(/Apply 1 change/);
	});
	it('keeps both rules for a grid that takes part of a block', () => {
		const html = render(GridPasteDialog, { props: { ...base, text: '', plan } }).body;
		expect(html).toContain('data-testid="paste-where"');
		expect(html).toContain('A blank cell or a dash');
	});
});
