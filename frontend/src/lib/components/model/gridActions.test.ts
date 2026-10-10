// Every grid in the grid modal opens with its actions in one row above it
// (add, sort, paste, load, download), not under up to 30 rows, totals and a
// field guide where the operator didn't find them (issue #463, the pattern
// #461 set for the EWR settings). Rendered with Svelte's server renderer; the
// browser flow is pinned by e2e (network-map, grid-paste, crop-library,
// demands-grid, transfers-page specs).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultProjectSettings, newNetworkNode, type ProjectModel, type ProjectSettings } from '@water-management/engine';
import { ModelEditor } from '$lib/model/editor.svelte';
import CropGrids from '$lib/components/crops/CropGrids.svelte';
import NetworkTab from '$lib/components/network/NetworkTab.svelte';
import DemandsTable from '$lib/components/network/DemandsTable.svelte';
import TransfersTab from '$lib/components/transfers/TransfersTab.svelte';

// Nothing here fetches: the network's map links and farmers load after mount, which the server renderer never runs.
vi.mock('$lib/api', () => ({ api: { map: { linkedNodes: () => Promise.resolve([]) } } }));
vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$app/navigation', () => ({ goto: () => {}, afterNavigate: () => {}, beforeNavigate: () => {}, replaceState: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://x/projects/p?tab=network&grid=nodes'), params: {}, state: {} } }));

function editor(): ModelEditor {
	const g = { ...newNetworkNode('g', 0, null), name: 'Outlet', kind: 'gauge' as const };
	const a = { ...newNetworkNode('a', 1, 'g'), name: 'Upper farm', areaKm2: 2 };
	const b = { ...newNetworkNode('b', 2, 'g'), name: 'Lower farm', areaKm2: 3 };
	const m: ProjectModel = {
		nodes: [g, a, b],
		crops: [{ id: 'c', name: 'Citrus', cropFactor: new Array<number>(12).fill(0.6) }],
		cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 10_000 }],
		transfers: []
	};
	const ed = new ModelEditor();
	ed.load(m);
	return ed;
}
const settings: ProjectSettings = { ...defaultProjectSettings(), apanMm: [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150] };

/** The grid-actions row comes before the grid's first body row, and holds these buttons in this order. */
function actionsBeforeGrid(html: string, first: string, buttons: string[]) {
	const row = html.indexOf('data-testid="grid-actions"');
	expect(row).toBeGreaterThan(-1);
	const body = html.indexOf('<tbody');
	const at = html.indexOf(first);
	expect(at).toBeGreaterThan(-1);
	expect(row).toBeLessThan(Math.min(body === -1 ? Infinity : body, at));
	const rowHtml = html.slice(row, html.indexOf('</div>', row + html.slice(row).indexOf('<button')) + 6);
	const got = [...rowHtml.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<!--[\s\S]*?-->/g, '').trim());
	expect(got).toEqual(buttons);
}

describe('grid actions sit above each grid (issue #463)', () => {
	it('the hydrological unit table: add, add other user, sort, paste, before the first row and the field guide', () => {
		const html = render(NetworkTab, { props: { editor: editor(), settings, readonly: false, only: 'table' as const } }).body;
		actionsBeforeGrid(html, 'id="node-row-g"', ['+ Add hydrological unit', '+ Add other user', 'Sort by flow path', 'Paste from a spreadsheet…']);
		expect(html.indexOf('data-testid="grid-actions"')).toBeLessThan(html.indexOf('Field guide'));
	});

	it('the crop factors: add, load, paste above the crop rows, under a one-line intro', () => {
		const html = render(CropGrids, { props: { editor: editor(), settings, readonly: false, sections: ['factors'] as const, inModal: true } }).body;
		actionsBeforeGrid(html, 'id="crop-name-c"', ['+ Add crop', 'Load crop factors…', 'Paste from a spreadsheet…']);
		const intro = html.slice(html.indexOf('data-testid="crop-factors-intro"'), html.indexOf('</p>', html.indexOf('data-testid="crop-factors-intro"')));
		expect(intro).toContain('not an FAO Kc');
		// The Kc conversion moved into the ⓘ and the glossary.
		expect(intro).not.toContain('FAO-56');
		expect(html.indexOf('data-testid="crop-factors-intro"')).toBeLessThan(html.indexOf('data-testid="grid-actions"'));
	});

	it('the planted areas: paste above the unit rows', () => {
		const html = render(CropGrids, { props: { editor: editor(), settings, readonly: false, sections: ['areas'] as const, inModal: true } }).body;
		actionsBeforeGrid(html, 'Upper farm', ['Paste from a spreadsheet…']);
	});

	it('the Demands grid: the unit, paste and download in one row above the table, not under its totals and note', () => {
		const html = render(DemandsTable, { props: { editor: editor(), settings, readonly: false, projectId: '' } }).body;
		actionsBeforeGrid(html, '<tbody', ['Paste from a spreadsheet…', 'Download the table as CSV']);
		const row = html.indexOf('data-testid="grid-actions"');
		expect(html.indexOf('Show demands in')).toBeGreaterThan(row);
		expect(html.indexOf('Show demands in')).toBeLessThan(html.indexOf('Paste from a spreadsheet…'));
		expect(row).toBeLessThan(html.indexOf('1 Mm³ = 1 million m³'));
	});

	it('the Transfers grid: + Add transfer above the rules', () => {
		const ed = editor();
		ed.addTransfer();
		const html = render(TransfersTab, { props: { editor: ed, readonly: false, inModal: true } }).body;
		const row = html.indexOf('data-testid="grid-actions"');
		expect(row).toBeGreaterThan(-1);
		expect(row).toBeLessThan(html.indexOf('data-testid="transfer-rules"'));
	});

	it('a viewer gets no actions row on the editable grids', () => {
		const net = render(NetworkTab, { props: { editor: editor(), settings, readonly: true, only: 'table' as const } }).body;
		expect(net).not.toContain('data-testid="grid-actions"');
		const crops = render(CropGrids, { props: { editor: editor(), settings, readonly: true, sections: ['factors', 'areas'] as const, inModal: true } }).body;
		expect(crops).not.toContain('data-testid="grid-actions"');
	});
});
