import { describe, expect, it } from 'vitest';
import { DownloadError } from '$lib/export/download';
import { collectWorkbookInput, FORECAST_FLAG_HEADER, withForecastFlag, type ExportProgress } from './collect';

const P = 'p1';
const R = 'r1';
const req = { apiBase: 'http://api.test', projectId: P, runId: R };
const run = {
	summary: { farms: [], warnings: [] },
	settings: { runoffModel: 'gr4j' },
	model: {
		nodes: [
			{ id: 'g', name: 'Gauge' },
			{ id: 'f', name: 'Upper farm' },
			{ id: 'x', name: 'No series' }
		]
	}
};
// Series listed out of network order: the workbook follows the model's order.
const series = [{ nodeId: null }, { nodeId: 'f' }, { nodeId: 'g' }, { nodeId: 'gone' }];

/** A two-page bulk answer for node `f`, one page for the others. */
function bulk(nodeId: string | null, offset: number) {
	const days = 5;
	const paged = nodeId === 'f';
	const count = paged ? (offset === 0 ? 3 : 2) : days;
	return {
		nodeId,
		name: nodeId === 'f' ? 'Upper farm (renamed)' : nodeId === null ? 'catchment' : String(nodeId),
		kind: 'farm',
		startDate: '2021-10-01',
		days,
		offset,
		count,
		next: paged && offset === 0 ? 3 : null,
		series: [{ key: 'a', label: 'A', unit: 'm³/day', header: 'A (m³/day)', values: Array.from({ length: count }, (_, i) => (offset + i === 1 ? null : (offset + i) * 1.5)) }]
	};
}

function fakeFetch(overrides: Record<string, () => Response> = {}) {
	const calls: string[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		expect(init?.credentials).toBe('include');
		for (const [k, f] of Object.entries(overrides)) if (url.includes(k)) return f();
		const u = new URL(url);
		if (u.pathname === `/projects/${P}/runs/${R}`) return Response.json({ run, series });
		if (u.pathname.endsWith('/export/summary.csv')) {
			return new Response('\uFEFFProject,X\r\n', { headers: { 'content-disposition': 'attachment; filename="synthetic_baseline_summary_2026-09-25.csv"' } });
		}
		if (u.pathname.endsWith('/series/bulk')) return Response.json(bulk(u.searchParams.get('nodeId'), Number(u.searchParams.get('offset') ?? 0)));
		return new Response('{"error":"not found"}', { status: 404 });
	}) as typeof fetch;
	return { fn, calls };
}

describe('collectWorkbookInput', () => {
	it('fetches the run, its summary CSV and every node in network order, following pages, with progress per node', async () => {
		const { fn, calls } = fakeFetch();
		const progress: ExportProgress[] = [];
		const { input, filename } = await collectWorkbookInput(req, fn, (p) => progress.push(p));
		expect(filename).toBe('synthetic_baseline_workbook_2026-09-25.xlsx');
		// (Response.text() drops the BOM; parseCsv reads the text either way.)
		expect(input.summaryCsv).toBe('Project,X\r\n');
		expect(input.settings).toEqual({ runoffModel: 'gr4j' });
		expect(input.catchment!.name).toBe('Catchment');
		// Network order from the model snapshot; a node only the series know goes last. Sheet names are the bulk route's (current) names.
		expect(input.nodes.map((n) => n.name)).toEqual(['g', 'Upper farm (renamed)', 'gone']);
		// Two pages stitched into one column, nulls kept.
		expect(Array.from(input.nodes[1]!.columns[0]!.values)).toEqual([0, null, 3, 4.5, 6]);
		expect(input.nodes[1]!.columns[0]).toMatchObject({ header: 'A (m³/day)', unit: 'm³/day' });
		expect(calls.filter((c) => c.includes('nodeId=f'))).toEqual([
			`http://api.test/projects/${P}/runs/${R}/series/bulk?nodeId=f`,
			`http://api.test/projects/${P}/runs/${R}/series/bulk?nodeId=f&offset=3`
		]);
		expect(progress).toEqual([
			{ phase: 'fetch', done: 0, total: 4, label: 'Catchment' },
			{ phase: 'fetch', done: 1, total: 4, label: 'Gauge' },
			{ phase: 'fetch', done: 2, total: 4, label: 'Upper farm' },
			{ phase: 'fetch', done: 3, total: 4, label: 'node' },
			{ phase: 'build', done: 4, total: 4, label: '' }
		]);
	});

	it("stops with the server's message when a fetch fails", async () => {
		const { fn } = fakeFetch({ 'nodeId=g': () => new Response('{"error":"export larger than 5 MB — narrow it"}', { status: 413 }) });
		const err = await collectWorkbookInput(req, fn, () => {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DownloadError);
		expect(err).toMatchObject({ status: 413, message: 'export larger than 5 MB — narrow it' });
	});

	it('says so when the server cannot be reached or the session is gone', async () => {
		const offline = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		await expect(collectWorkbookInput(req, offline, () => {})).rejects.toThrow('Could not reach the server');
		const { fn } = fakeFetch({ [`/runs/${R}`]: () => new Response('', { status: 401 }) });
		await expect(collectWorkbookInput(req, fn, () => {})).rejects.toThrow('You are not signed in');
	});

	it('falls back to a generic file name without the server one', async () => {
		const { fn } = fakeFetch({ 'summary.csv': () => new Response('Project,X\r\n') });
		expect((await collectWorkbookInput(req, fn, () => {})).filename).toBe('run_workbook.xlsx');
	});
});

describe('withForecastFlag (WP-2.12)', () => {
	it('leads a forecast run’s daily sheet with 1 on each forecast day and 0 before', () => {
		const table = { name: 'Catchment', startDate: '2026-09-24', columns: [{ header: 'Rain', unit: 'mm', values: [1, 2, 3, 4, 5] }] };
		const flagged = withForecastFlag(table, '2026-09-27');
		expect(flagged.columns.map((c) => c.header)).toEqual([FORECAST_FLAG_HEADER, 'Rain']);
		expect(Array.from(flagged.columns[0]!.values)).toEqual([0, 0, 0, 1, 1]);
		expect(flagged.columns[1]).toBe(table.columns[0]);
	});
});
