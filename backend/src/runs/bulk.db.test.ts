// GET /projects/:id/runs/:runId/series/bulk: every series of one node in one
// response (the browser-built .xlsx workbook, docs/api.md § Export), bound by
// RLS like every project route.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';
import { csvRow } from '../export/csv.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
let projectId: string;
let runId: string;
const outlet = node('Gauge', null);
const farm = node('=Upper farm', outlet.id, { damCapacityM3: 100_000 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
const DAYS = 40;

beforeAll(async () => {
	owner = await signUp('Bulkowner');
	viewer = await signUp('Bulkviewer');
	stranger = await signUp('Bulkstranger');
	projectId = (await owner.call('POST', '/projects', { name: 'Bulk' })).body.project.id;
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 20_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 6 === 0 ? 18.25 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'bulk' })).body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
});

const bulk = (u: User, query = '') => u.call('GET', `/projects/${projectId}/runs/${runId}/series/bulk${query}`);

/**
 * The daily CSV's table lines (the header row may quote a header with a comma; value rows never do), after its
 * leading `#` provenance line, which the workbook carries on its Summary sheet instead.
 */
async function dailyCsv(u: User, nodeId?: string) {
	const res = await app.request(`/projects/${projectId}/runs/${runId}/export/daily.csv${nodeId ? `?nodeId=${nodeId}` : ''}`, {
		headers: { cookie: u.cookie, origin: 'http://localhost:7777' }
	});
	expect(res.status).toBe(200);
	const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
	const lines = text.replace('﻿', '').replace(/\r\n$/, '').split('\r\n');
	expect(lines[0]).toMatch(/^# run=bulk; /);
	return lines.slice(1);
}

describe('GET …/runs/:runId/series/bulk', () => {
	it("returns a node's every series in the daily CSV's column order, headers and values", async () => {
		const res = await bulk(viewer, `?nodeId=${farm.id}`);
		expect(res.status).toBe(200);
		const p = res.body;
		expect(p).toMatchObject({ nodeId: farm.id, name: '=Upper farm', kind: 'farm', startDate: '2021-10-01', days: DAYS, offset: 0, count: DAYS, next: null });
		const stored = (await owner.call('GET', `/projects/${projectId}/runs/${runId}`)).body.series.filter((s: { nodeId: string | null }) => s.nodeId === farm.id);
		expect(p.series).toHaveLength(stored.length);
		// The same columns and values as the daily CSV, which the workbook must equal.
		const csv = await dailyCsv(viewer, farm.id);
		expect(csv[0]).toBe(csvRow(['date', ...p.series.map((s: { header: string }) => s.header)]));
		for (const [r, line] of csv.slice(1).entries()) {
			const cells = line.split(',').slice(1);
			expect(cells).toEqual(p.series.map((s: { values: (number | null)[] }) => (s.values[r] === null ? '' : String(s.values[r]))));
		}
		const one = await owner.call('GET', `/projects/${projectId}/runs/${runId}/series?key=supplied&nodeId=${farm.id}`);
		expect(p.series.find((s: { key: string }) => s.key === 'supplied').values).toEqual(one.body.values);
	});

	it('returns the catchment series without a nodeId', async () => {
		const p = (await bulk(owner)).body;
		expect(p).toMatchObject({ nodeId: null, name: 'catchment', kind: 'catchment', days: DAYS, next: null });
		expect(p.series[0].key).toBe('natural_flow');
		expect((await dailyCsv(owner))[0]).toBe(csvRow(['date', ...p.series.map((s: { header: string }) => s.header)]));
	});

	it('pages from an offset and refuses one past the run', async () => {
		const p = (await bulk(owner, `?nodeId=${farm.id}&offset=30`)).body;
		expect(p).toMatchObject({ offset: 30, count: 10, next: null });
		const whole = (await bulk(owner, `?nodeId=${farm.id}`)).body;
		expect(p.series[0].values).toEqual(whole.series[0].values.slice(30));
		expect((await bulk(owner, `?nodeId=${farm.id}&offset=${DAYS}`)).status).toBe(400);
		expect((await bulk(owner, '?offset=-1')).status).toBe(400);
		expect((await bulk(owner, '?nodeId=not-a-uuid')).status).toBe(400);
	});

	it('is 404 for a node that is not in the run, and for another run id', async () => {
		expect((await bulk(owner, `?nodeId=${crypto.randomUUID()}`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${projectId}/runs/${crypto.randomUUID()}/series/bulk`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${projectId}/runs/nope/series/bulk`)).status).toBe(404);
	});

	it('hides the run from a non-member (404) while a member reads it', async () => {
		// Positive control: the viewer (a member) gets the data…
		expect((await bulk(viewer, `?nodeId=${farm.id}`)).status).toBe(200);
		// …a signed-in stranger gets 404, not 403, for the node and the catchment…
		expect((await bulk(stranger, `?nodeId=${farm.id}`)).status).toBe(404);
		expect((await bulk(stranger)).status).toBe(404);
		// …and can't reach the run through a project of their own either.
		const own = (await stranger.call('POST', '/projects', { name: 'Mine' })).body.project.id;
		expect((await stranger.call('GET', `/projects/${own}/runs/${runId}/series/bulk?nodeId=${farm.id}`)).status).toBe(404);
	});

	it('GET …/runs/:runId carries the run’s model snapshot', async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/runs/${runId}`);
		expect(res.body.run.model.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['=Upper farm', 'Gauge']);
		expect(res.body.run.model.crops[0].name).toBe('Lucerne');
	});
});
