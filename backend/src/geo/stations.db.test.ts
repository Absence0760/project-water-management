// GET /projects/:id/map/stations (issue #326 B-gauge; docs/api.md § Catchment
// map): the nearest river gauges in gauge_station_reference (156), measured
// from a given point or from the catchment's outlet by the rule in
// geo/stations.ts outletPoint (the map gauge linked to the outflow gauge node,
// else the boundary's centre). A viewer reads it (positive control); a farmer
// gets 403 and a stranger 404; water_app can't write the table.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_STATIONS_FILE } from '../../scripts/import-gauge-stations.js';
import { node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { replaceStations, stationRecords } from './loadGaugeStations.js';
import { SYNTHETIC_STATIONS } from './stations.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let emptyProjectId: string;
const outlet = node('Outlet weir', null);
const midGauge = node('Mid gauge', outlet.id, { kind: 'gauge' });
const farm = node('Farm A', midGauge.id);
const model = () => ({ nodes: [outlet, midGauge, farm], crops: [], cropAreas: [], transfers: [] });
/** The seeded Sandspruit outlet's place (backend/scripts/examples/map.ts), where the fixture's stations cluster. */
const OUTLET: [number, number] = [21.3133, -33.786];
const at = (q = '') => `/projects/${projectId}/map/stations${q}`;

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['Sowner', 'Sviewer', 'Sfarmer', 'Sstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Stations' })).body.project.id;
	emptyProjectId = (await owner.call('POST', '/projects', { name: 'Stations, no map' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model())).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await replaceStations(client, SYNTHETIC_STATIONS, stationRecords([{ name: 'fixture', text: readFileSync(SYNTHETIC_STATIONS_FILE, 'utf8') }], '').records);
	} finally {
		await client.end();
	}
}, 60_000);

describe('the nearest gauging stations', () => {
	it('with no map, has no point to measure from and proposes nothing, but says the list is loaded', async () => {
		const res = await owner.call('GET', `/projects/${emptyProjectId}/map/stations`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ point: null, pointFrom: null, stations: [] });
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 6 }]));
	});

	it('measures from the boundary’s centre when the outflow gauge has no point on the map', async () => {
		const d = 0.1;
		const [x, y] = [OUTLET[0] - d / 2, OUTLET[1] - d / 2];
		const ring = [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
		const text = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Test catchment' }, geometry: { type: 'Polygon', coordinates: [ring] } }] });
		expect((await owner.call('POST', `/projects/${projectId}/map/import`, { fileName: 'b.geojson', kind: 'catchment_boundary', text })).status).toBe(201);
		// A gauge linked to a gauge that is not the outlet doesn't count.
		expect((await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'gauge', name: 'Mid gauge', nodeId: midGauge.id, lon: 21.5, lat: -33.9 })).status).toBe(201);
		const res = await viewer.call('GET', at());
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ pointFrom: 'boundary_centre', pointName: 'Test catchment', withinKm: 50 });
		expect(res.body.point[0]).toBeCloseTo(OUTLET[0], 4);
		expect(res.body.point[1]).toBeCloseTo(OUTLET[1], 4);
	});

	it('measures from the map gauge linked to the outflow gauge, lists river gauges nearest first with distance, river and record, marked synthetic', async () => {
		expect((await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'gauge', name: 'Outlet weir', nodeId: outlet.id, lon: OUTLET[0], lat: OUTLET[1] })).status).toBe(201);
		const res = await viewer.call('GET', at());
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ point: OUTLET, pointFrom: 'outlet_gauge', pointName: 'Outlet weir' });
		const stations = res.body.stations as { code: string; distanceKm: number; river: string; recordYears: number | null; synthetic: boolean; source: string }[];
		expect(stations.map((s) => s.code)).toEqual(['Z1H001', 'Z1H003', 'Z1H002', 'Z1H004', 'Z1H005']);
		for (let i = 1; i < stations.length; i++) expect(stations[i]!.distanceKm).toBeGreaterThanOrEqual(stations[i - 1]!.distanceKm);
		expect(stations[0]).toMatchObject({ river: 'Sandspruit', synthetic: true, recordYears: 56, source: expect.stringMatching(/^SYNTHETIC/) });
		expect(stations[0]!.distanceKm).toBeCloseTo(2.83, 1);
		// The reservoir beside the outlet (Z1R001, nearer than any) is not a river gauge: the DWS feed can't read it.
		expect(stations.some((s) => s.code === 'Z1R001')).toBe(false);
	});

	it('takes a given point and a radius', async () => {
		const res = await viewer.call('GET', at(`?lon=${OUTLET[0]}&lat=${OUTLET[1]}&within=20`));
		expect(res.status).toBe(200);
		expect(res.body.pointFrom).toBe('query');
		expect(res.body.stations.map((s: { code: string }) => s.code)).toEqual(['Z1H001', 'Z1H003', 'Z1H002', 'Z1H004']);
		expect((await viewer.call('GET', at('?lon=28&lat=-26'))).body.stations).toEqual([]);
	});

	it('refuses half a point and a radius out of range', async () => {
		expect((await viewer.call('GET', at('?lon=21.3'))).status).toBe(400);
		expect((await viewer.call('GET', at('?within=0'))).status).toBe(400);
		expect((await viewer.call('GET', at('?within=500'))).status).toBe(400);
		expect((await viewer.call('GET', at('?lon=200&lat=-33'))).status).toBe(400);
	});

	it('is a viewer’s read: a farmer gets 403 and a stranger 404 (control: the viewer reads it above)', async () => {
		expect((await farmer.call('GET', at())).status).toBe(403);
		expect((await stranger.call('GET', at())).status).toBe(404);
	});

	it('is read-only to the app role (control: it reads it)', async () => {
		const rows = await withUser(viewer.id, async (db) => (await db.query('SELECT code FROM gauge_station_reference WHERE code = $1', ['Z1H001'])).rows);
		expect(rows.length).toBe(1);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE gauge_station_reference SET name = 'x' WHERE code = 'Z1H001'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`INSERT INTO gauge_station_reference (code, lon, lat, dataset, source) VALUES ('Z9H999', 21, -33, 'x', 'x')`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`DELETE FROM gauge_station_reference`))).rejects.toThrow(/permission denied/);
	});
});
