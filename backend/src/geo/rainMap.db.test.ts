// The MAP grid layer (geo/rainMapRoutes.ts, 207_rain_map_reference.sql):
// GET /projects/:id/map/map-grid?bbox=[&dataset=] over the committed
// synthetic grid (0.01° cells over region Z, an empty south-west corner) and a
// second, coarser grid loaded here. A viewer reads one dataset's points in the
// box, the default first, marked synthetic; a box holding more of the grid's
// cells than one answer carries comes back tooDense with no cells; an unknown
// dataset is 404; a bad or oversized bbox 400; a non-member gets 404 and a
// farmer 403, with a member's read as the positive control; water_app can't
// write the grid.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticMapGrid, parseMapGridArgs } from '../../scripts/import-map-grid.js';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { replaceRainMapDataset, type RainMapGrid } from './rainMap.js';
import { MAP_GRID_BBOX_MAX_DEG, MAP_GRID_LAYER_MAX } from './rainMapRoutes.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;

const outlet = node('Weir', null);
const farm = node('Farm M', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const url = (bbox: string, dataset?: string, id = projectId) =>
	`/projects/${id}/map/map-grid?${new URLSearchParams({ bbox, ...(dataset ? { dataset } : {}) })}`;

/** A coarse invented grid: 0.25° cells, four of them, centred on whole and half degrees plus 0.125. */
const COARSE: RainMapGrid = {
	cellDeg: 0.25,
	originLon: 0,
	originLat: 0,
	// Cells (row, col) from origin (0, 0): row −135 is the band −33.75…−33.5; col 85 is 21.25…21.5.
	cells: [
		{ row: -135, col: 85, mapMm: 410 },
		{ row: -135, col: 86, mapMm: 455.4 },
		{ row: -134, col: 85, mapMm: 520 },
		{ row: -134, col: 86, mapMm: 600 }
	]
};

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['MGowner', 'MGviewer', 'MGfarmer', 'MGstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'MAP grid layer' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	expect(await loadSyntheticMapGrid(process.env.TEST_MIGRATION_DATABASE_URL!)).toBe(1575);
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await replaceRainMapDataset(client, { dataset: 'coarse-test', source: 'Invented coarse grid', version: '1', attribution: 'test' }, COARSE);
	} finally {
		await client.end();
	}
}, 60_000);

describe('GET /projects/:id/map/map-grid', () => {
	it('gives a viewer the default dataset’s points in the box, each its centre and whole-mm MAP, with every dataset listed', async () => {
		const res = await viewer.call('GET', url('21.30,-33.65,21.33,-33.62'));
		expect(res.status).toBe(200);
		// The finest grid is the default after any real one; here both are test grids, the synthetic last.
		expect(res.body.dataset).toMatchObject({ dataset: 'coarse-test', cellDeg: 0.25, synthetic: false, cells: 4 });
		expect(res.body.datasets.map((d: { dataset: string }) => d.dataset)).toEqual(['coarse-test', 'synthetic']);
		// No 0.25° centre (21.375, 21.625 … −33.625 …) lies in this 0.03° box.
		expect(res.body.cells).toEqual([]);
		expect(res.body.tooDense).toBe(false);
		expect(res.body.max).toBe(MAP_GRID_LAYER_MAX);

		const coarse = await viewer.call('GET', url('21.25,-33.75,21.75,-33.25'));
		expect(coarse.body.cells).toEqual([
			[21.375, -33.625, 410],
			[21.625, -33.625, 455],
			[21.375, -33.375, 520],
			[21.625, -33.375, 600]
		]);
	});

	it('reads the dataset asked for: the synthetic grid’s 0.01° points, none in its empty corner', async () => {
		const res = await viewer.call('GET', url('21.30,-33.65,21.33,-33.62', 'synthetic'));
		expect(res.status).toBe(200);
		expect(res.body.dataset).toMatchObject({ dataset: 'synthetic', synthetic: true, cellDeg: 0.01 });
		// Centres 21.305 … 21.325 by −33.645 … −33.625: 3 × 3.
		expect(res.body.cells).toHaveLength(9);
		for (const [lon, lat, mm] of res.body.cells as [number, number, number][]) {
			expect(lon).toBeGreaterThanOrEqual(21.3);
			expect(lat).toBeLessThanOrEqual(-33.62);
			expect(Number.isInteger(mm)).toBe(true);
			expect(mm).toBeGreaterThan(300);
		}
		// The south-west corner (west of 21.25, south of −33.75) has no value.
		const corner = await viewer.call('GET', url('21.2,-33.8,21.24,-33.76', 'synthetic'));
		expect(corner.body.cells).toEqual([]);
	});

	it('says tooDense, with no cells, when the box holds more of the grid’s cells than one answer carries', async () => {
		// 0.8° × 0.8° of 0.01° cells is 6 400 > 5 000.
		const res = await viewer.call('GET', url('21.0,-34.0,21.8,-33.2', 'synthetic'));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ tooDense: true, cells: [] });
		// The same box over the coarse grid fits.
		expect((await viewer.call('GET', url('21.0,-34.0,21.8,-33.2', 'coarse-test'))).body.tooDense).toBe(false);
	});

	it('refuses an unknown dataset (404), and a malformed, inverted or oversized bbox (400), with no SQL in the answer', async () => {
		expect((await viewer.call('GET', url('21.3,-33.7,21.4,-33.6', 'nope'))).status).toBe(404);
		for (const bbox of ['21,-33', '21,-33,a,-32', '21.5,-33.7,21.4,-33.6', `21,-34,${21 + MAP_GRID_BBOX_MAX_DEG + 0.1},-33`]) {
			const res = await viewer.call('GET', url(bbox));
			expect(res.status, bbox).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/rain_map|SELECT/);
		}
	});

	it('is closed to a non-member (404) and to a farmer (403); the owner reads it (control)', async () => {
		expect((await stranger.call('GET', url('21.25,-33.75,21.75,-33.25'))).status).toBe(404);
		expect((await farmer.call('GET', url('21.25,-33.75,21.75,-33.25'))).status).toBe(403);
		const mine = await owner.call('GET', url('21.25,-33.75,21.75,-33.25'));
		expect(mine.status).toBe(200);
		expect(mine.body.cells).toHaveLength(4);
	});
});

describe('the MAP grid tables', () => {
	it('are read-only to the app role: a member reads them (control), and no write goes through', async () => {
		await withUser(viewer.id, async (db) => {
			const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM rain_map_cell_reference WHERE dataset = 'coarse-test'");
			expect(rows[0]!.n).toBe(4);
		});
		await expect(
			withUser(viewer.id, (db) => db.query("INSERT INTO rain_map_cell_reference (dataset, row_idx, col_idx, map_mm) VALUES ('coarse-test', 0, 0, 1)"))
		).rejects.toThrow(/permission denied/);
		await expect(withUser(viewer.id, (db) => db.query("DELETE FROM rain_map_dataset WHERE dataset = 'coarse-test'"))).rejects.toThrow(/permission denied/);
	});

	it('show nothing to a session with no user (the policy), while a member reads them (control above)', async () => {
		const rows = await withoutUser(async (db) => (await db.query<{ n: number }>('SELECT (SELECT count(*) FROM rain_map_dataset)::int + (SELECT count(*) FROM rain_map_cell_reference)::int AS n')).rows);
		expect(rows[0]!.n).toBe(0);
	});

	it('refuse a MAP out of range and an origin outside its cell, and take a dataset’s cells with it when it goes', async () => {
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await expect(client.query("INSERT INTO rain_map_cell_reference (dataset, row_idx, col_idx, map_mm) VALUES ('coarse-test', 9, 9, 20001)")).rejects.toThrow(/check constraint/);
			await expect(client.query("INSERT INTO rain_map_cell_reference (dataset, row_idx, col_idx, map_mm) VALUES ('coarse-test', 9, 9, -1)")).rejects.toThrow(/check constraint/);
			await expect(
				client.query("INSERT INTO rain_map_dataset (dataset, source, version, attribution, cell_deg, origin_lon, origin_lat, cell_count) VALUES ('bad-origin', 's', 'v', 'a', 0.1, 0.1, 0, 1)")
			).rejects.toThrow(/check constraint/);
			await replaceRainMapDataset(client, { dataset: 'gone-test', source: 's', version: 'v', attribution: 'a' }, { cellDeg: 0.5, originLon: 0, originLat: 0, cells: [{ row: 1, col: 1, mapMm: 100 }] });
			await client.query("DELETE FROM rain_map_dataset WHERE dataset = 'gone-test'");
			const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM rain_map_cell_reference WHERE dataset = 'gone-test'");
			expect(rows[0]!.n).toBe(0);
		} finally {
			await client.end();
		}
	});

	it('loads the synthetic grid again in place (idempotent), and the CLI refuses the fixture’s label for a real file', async () => {
		expect(await loadSyntheticMapGrid(process.env.TEST_MIGRATION_DATABASE_URL!)).toBe(1575);
		expect(parseMapGridArgs(['grid.asc', '--dataset', 'synthetic', '--source', 'x'])).toMatch(/committed fixture/);
	});
});
