// The farm view's chart series and per-farm history routes (WP-2.6, issue
// #74), the WUA's name on the farm index and view (095_wua_name) and the run's
// first date on the projection (`dataFrom`). Two farms in a line, as in
// series-privacy.db.test.ts, so every "cannot see" check has the neighbour to
// leak: the farmer on Down never gets Up's figures, id or name. Positive
// controls: the farmer reads their own farm, the owner reads both.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { FARM_HISTORY_LIMIT, FARM_SERIES_DEFAULT_DAYS } from './view.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let farmer: User; // linked to Down only
let stranger: User;
let projectId: string;
const outlet = node('Outlet weir', null);
const down = node('Lower farm', outlet.id, { damCapacityM3: 50_000 });
const up = node('Upper neighbour', down.id, { damCapacityM3: 80_000 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const RAIN_START = '2021-10-01';
const DAYS = 500; // to 2023-02-12
const DATA_UNTIL = '2023-02-12';

const runAndPublish = async (extra: Record<string, unknown> = {}) => {
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' });
	expect(run.status).toBe(201);
	const pub = await owner.call('POST', `/projects/${projectId}/publication`, { runId: run.body.run.id, ...extra });
	expect(pub.status).toBe(201);
	return run.body.run.id as string;
};
const series = (u: User, nodeId: string, query: string) => u.call('GET', `/projects/${projectId}/farm/${nodeId}/series?${query}`);
const noNeighbour = (body: unknown) => {
	const text = JSON.stringify(body);
	expect(text).not.toContain(up.id);
	expect(text).not.toContain(up.name);
};

let firstRun: string;
let currentRun: string;

beforeAll(async () => {
	[owner, farmer, stranger] = (await Promise.all([signUp('Hisowner'), signUp('Hisfarmer'), signUp('Hisstranger')])) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Farm history' })).body.project.id;
	const model = {
		nodes: [outlet, down, up],
		crops: [crop],
		cropAreas: [
			{ nodeId: down.id, cropId: crop.id, areaM2: 120_000 },
			{ nodeId: up.id, cropId: crop.id, areaM2: 150_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(2000) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 7 === 0 ? 30 : i % 3 === 0 ? 4 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RAIN_START, values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [down.id] })).status).toBe(201);
	firstRun = await runAndPublish();
	currentRun = await runAndPublish({ restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.' } } });
}, 60_000);

describe('GET …/farm/:nodeId/series', () => {
	it('gives the farmer the year to dataUntil of their own series by default, as stored', async () => {
		const res = await series(farmer, down.id, 'key=supplied');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ key: 'supplied', startDate: '2022-02-13', unit: expect.any(String) });
		expect(res.body.values).toHaveLength(FARM_SERIES_DEFAULT_DAYS);
		const [stored] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'supplied'`, [currentRun, down.id]);
		const all = stored.values as number[];
		expect(res.body.values).toEqual(all.slice(DAYS - FARM_SERIES_DEFAULT_DAYS, DAYS));
		expect(res.body.values.some((v: number) => v > 0)).toBe(true);
		noNeighbour(res.body);
	});

	it('narrows to from … to, starts no earlier than the run and ends no later than dataUntil', async () => {
		const [stored] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'dam_storage'`, [currentRun, down.id]);
		const all = stored.values as number[];
		const narrow = await series(farmer, down.id, 'key=dam_storage&from=2022-01-01&to=2022-01-10');
		expect(narrow.body.startDate).toBe('2022-01-01');
		expect(narrow.body.values).toEqual(all.slice(92, 102));
		const wide = await series(farmer, down.id, 'key=dam_storage&from=2020-01-01&to=2030-01-01');
		expect(wide.body.startDate).toBe(RAIN_START);
		expect(wide.body.values).toEqual(all);
	});

	it('refuses a key off the farm allowlist, a bad window and a window outside the figures', async () => {
		for (const q of ['key=outflow', 'key=inflow_upstream', 'key=ewr_charge', '', 'key=supplied&from=2022-02-01&to=2022-01-01', 'key=supplied&from=2022-02-30']) {
			expect((await series(farmer, down.id, q)).status, q).toBe(400);
		}
		expect((await series(farmer, down.id, 'key=supplied&from=2024-01-01')).status).toBe(400);
		expect((await series(farmer, down.id, 'key=supplied&to=2020-01-01')).status).toBe(400);
	});

	it('404s the neighbour’s farm, a gauge and a stranger alike (positive control: the owner reads the neighbour)', async () => {
		for (const n of [up.id, outlet.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
			expect((await series(farmer, n, 'key=supplied')).status, n).toBe(404);
		}
		expect((await series(stranger, down.id, 'key=supplied')).status).toBe(404);
		expect((await series(owner, up.id, 'key=supplied')).status).toBe(200);
	});
});

describe('GET …/farm/:nodeId/history', () => {
	it('lists the farm in every publication, newest first, with its own figures only', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${down.id}/history`);
		expect(res.status).toBe(200);
		const pubs = res.body.publications as { publishedAt: string; current: boolean }[];
		expect(pubs).toHaveLength(2);
		expect(pubs.map((p) => p.current)).toEqual([true, false]);
		expect(Date.parse(pubs[0]!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(pubs[1]!.publishedAt));
		expect(pubs[0]).toMatchObject({
			dataUntil: DATA_UNTIL,
			season: { from: '2022-10-01', to: DATA_UNTIL, demandM3: expect.any(Number), suppliedM3: expect.any(Number), shortDays: expect.any(Number) },
			damPct: expect.any(Number),
			model: { headline: expect.any(Number) },
			restriction: { level: 'advisory', pct: 10 }
		});
		expect(pubs[1]).toMatchObject({ restriction: { level: 'none', pct: null } });
		// The current entry is the farm view's own figures.
		const view = (await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body;
		expect(pubs[0]).toMatchObject({ season: { suppliedM3: view.farm.season.suppliedM3 }, damPct: view.farm.dam.pct });
		// Never the even share (a catchment ratio) nor the notice text.
		expect(JSON.stringify(res.body)).not.toMatch(/equitable|aboveBelow|notice|Please save water/);
		noNeighbour(res.body);
		expect(pubs.length).toBeLessThanOrEqual(FARM_HISTORY_LIMIT);
	});

	it('404s the neighbour’s farm and a stranger (positive control: the owner reads the neighbour’s history)', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${up.id}/history`)).status).toBe(404);
		expect((await stranger.call('GET', `/projects/${projectId}/farm/${down.id}/history`)).status).toBe(404);
		const ownerView = await owner.call('GET', `/projects/${projectId}/farm/${up.id}/history`);
		expect(ownerView.status).toBe(200);
		expect(ownerView.body.publications).toHaveLength(2);
	});
});

describe('the WUA’s name (095_wua_name)', () => {
	it('is null until an editor names it, then the farm index and view carry it, trimmed', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/farm`)).body.project).toEqual({ id: projectId, name: 'Farm history', wuaName: null });
		const set = await owner.call('PATCH', `/projects/${projectId}`, { wuaName: '  Vaalbank WUA ' });
		expect(set.status).toBe(200);
		expect(set.body.project.wuaName).toBe('Vaalbank WUA');
		expect((await farmer.call('GET', `/projects/${projectId}/farm`)).body.project.wuaName).toBe('Vaalbank WUA');
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.project.wuaName).toBe('Vaalbank WUA');
		// An audit event names the change.
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'project.changed' ORDER BY created_at DESC, id DESC LIMIT 1`, [projectId]);
		expect(ev.subject).toMatchObject({ fields: ['wua_name'], wuaName: { from: null, to: 'Vaalbank WUA' } });
	});

	it('clears on an empty name, and only an editor may change it (a farmer can’t)', async () => {
		expect((await farmer.call('PATCH', `/projects/${projectId}`, { wuaName: 'Not mine' })).status).toBe(403);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { wuaName: '' })).body.project.wuaName).toBeNull();
		expect((await owner.call('PATCH', `/projects/${projectId}`, { wuaName: 'x'.repeat(201) })).status).toBe(400);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.project.wuaName).toBeNull();
	});
});

describe('the run’s first date on the projection (dataFrom)', () => {
	it('is on a new publication’s farm view, and filled from the catchment view on one stored before it', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.farm.dataFrom).toBe(RAIN_START);
		// A projection stored before the field existed.
		await asOwner(
			`UPDATE publication_farm f SET view = f.view - 'dataFrom'
			 FROM run_publication p WHERE p.id = f.publication_id AND p.run_id = $1 AND f.node_id = $2`,
			[currentRun, down.id]
		);
		const [stored] = await asOwner(
			`SELECT f.view ? 'dataFrom' AS has FROM publication_farm f JOIN run_publication p ON p.id = f.publication_id WHERE p.run_id = $1 AND f.node_id = $2`,
			[currentRun, down.id]
		);
		expect(stored.has).toBe(false);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.farm.dataFrom).toBe(RAIN_START);
		expect(firstRun).not.toBe(currentRun);
	});
});
