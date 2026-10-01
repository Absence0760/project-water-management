// The catchment map (issue #288, WP-3.12; 152_catchment_map.sql,
// geo/routes.ts): the API end to end and RLS with positive controls.
//  - an editor imports a synthetic boundary (checked and measured on the
//    server); a viewer can't; the same file twice, a projected file and a
//    point as a boundary are refused, with reasons per feature;
//  - points placed from coordinates, linked to a node of a fitting kind;
//  - a polygon's area accepted into a farm records a model revision naming
//    the feature, and typing over the area sets it back to typed;
//  - viewers read; another project's member reads nothing; a farmer reads
//    the boundary and gauges and their own farm's features, not a neighbour's;
//  - the quaternary lookup proposes the synthetic dataset's values, marked
//    synthetic, and water_app can't write the dataset.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_FILE } from '../../scripts/import-quaternaries.js';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { quaternaryRecords, replaceDataset } from './loadQuaternaries.js';
import { SYNTHETIC_DATASET } from './quaternary.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const model = () => ({ nodes: [outlet, farmA, farmB], crops: [crop], cropAreas: [{ nodeId: farmA.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] });

/** A box `d` degrees on a side, inside the synthetic quaternary Z01B (21.25–21.5 E, 33.75–33.5 S). */
const box = (x: number, y: number, d: number) => [
	[x, y],
	[x + d, y],
	[x + d, y + d],
	[x, y + d],
	[x, y]
];
const boundaryFile = (name = 'Synthetic catchment', d = 0.1) =>
	JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, d)] } }] });
const parcelsFile = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{ type: 'Feature', properties: { name: 'Farm A', owner_id: 'refused' }, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.02)] } },
		{ type: 'Feature', properties: { name: 'farm b' }, geometry: { type: 'Polygon', coordinates: [box(21.35, -33.69, 0.02)] } }
	]
});
const at = (p = '') => `/projects/${projectId}/map${p}`;
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

beforeAll(async () => {
	[owner, editor, viewer, farmer, stranger] = (await Promise.all(['Mowner', 'Meditor', 'Mviewer', 'Mfarmer', 'Mstranger'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Map' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model())).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere map' })).body.project.id;
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await replaceDataset(client, SYNTHETIC_DATASET, quaternaryRecords(JSON.parse(readFileSync(SYNTHETIC_FILE, 'utf8')), '').records);
	} finally {
		await client.end();
	}
}, 60_000);

describe('importing a GeoJSON file', () => {
	it('imports a boundary as an editor, measuring its area on the server', async () => {
		const res = await editor.call('POST', at('/import'), { fileName: 'boundary.geojson', kind: 'catchment_boundary', text: boundaryFile() });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.source.sha256).toMatch(/^[0-9a-f]{64}$/);
		const [f] = res.body.features;
		expect(f).toMatchObject({ kind: 'catchment_boundary', name: 'Synthetic catchment', nodeId: null, geometry: { type: 'Polygon' } });
		// 0.1° × 0.1° at 33.7 S: about 9.27 × 11.09 km.
		expect(f.areaM2 / 1e6).toBeGreaterThan(102);
		expect(f.areaM2 / 1e6).toBeLessThan(104);
	});

	it('is refused to a viewer, and the same file twice', async () => {
		expect((await viewer.call('POST', at('/import'), { fileName: 'b.geojson', kind: 'catchment_boundary', text: boundaryFile('Other') })).status).toBe(403);
		const again = await editor.call('POST', at('/import'), { fileName: 'boundary.geojson', kind: 'catchment_boundary', text: boundaryFile() });
		expect(again.status).toBe(409);
		expect(again.body.error).toMatch(/imported already/);
	});

	it('refuses a projected file and a point as a boundary, listing the problems, and writes nothing', async () => {
		const lo = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [box(-45_000, 3_700_000, 1000)] } }] });
		const res = await editor.call('POST', at('/import'), { fileName: 'lo19.geojson', kind: 'catchment_boundary', text: lo });
		expect(res.status).toBe(422);
		expect(res.body.details).toEqual([{ feature: 1, message: expect.stringMatching(/looks projected/) }]);
		const pt = JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [21.3, -33.6] } });
		const res2 = await editor.call('POST', at('/import'), { fileName: 'pt.geojson', kind: 'catchment_boundary', text: pt });
		expect(res2.status).toBe(422);
		expect(res2.body.details[0].message).toMatch(/is a Point; a catchment boundary is a Polygon or MultiPolygon/);
		const [{ n }] = await asOwner('SELECT count(*)::int AS n FROM geo_source WHERE project_id = $1', [projectId]);
		expect(n).toBe(1);
	});

	it('replaces the boundary with a new one, removing the old import', async () => {
		const res = await editor.call('POST', at('/import'), { fileName: 'boundary-v2.geojson', kind: 'catchment_boundary', text: boundaryFile('Revised catchment', 0.12) });
		expect(res.status).toBe(201);
		const list = await viewer.call('GET', at('/features'));
		const boundaries = list.body.features.filter((f: { kind: string }) => f.kind === 'catchment_boundary');
		expect(boundaries.map((f: { name: string }) => f.name)).toEqual(['Revised catchment']);
		expect(list.body.sources.map((s: { fileName: string }) => s.fileName)).toEqual(['boundary-v2.geojson']);
	});

	it('imports farm parcels, linking each to the farm of the same name and dropping properties not on the allowlist', async () => {
		const res = await editor.call('POST', at('/import'), { fileName: 'parcels.geojson', kind: 'farm_parcel', text: parcelsFile });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.features.map((f: { nodeId: string }) => f.nodeId)).toEqual([farmA.id, farmB.id]);
		expect(res.body.features[0].properties).toEqual({});
	});
});

describe('placing and editing features', () => {
	let gaugeId: string;

	it('places a gauge from coordinates, linked to the gauge node, and refuses a gauge linked to a farm', async () => {
		const res = await editor.call('POST', at('/features'), { kind: 'gauge', name: 'Weir', lon: 21.33, lat: -33.61, nodeId: outlet.id });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.feature).toMatchObject({ kind: 'gauge', nodeId: outlet.id, nodeName: 'Weir', geometry: { type: 'Point', coordinates: [21.33, -33.61] }, areaM2: null, center: [21.33, -33.61] });
		gaugeId = res.body.feature.id;
		const bad = await editor.call('POST', at('/features'), { kind: 'gauge', lon: 21.3, lat: -33.6, nodeId: farmA.id });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/A gauge can stand for a gauge node, not a farm/);
		expect((await viewer.call('POST', at('/features'), { kind: 'gauge', lon: 21.3, lat: -33.6 })).status).toBe(403);
	});

	it('refuses a geometry that doesn’t fit the kind, a bad geometry, and coordinates out of range', async () => {
		expect((await editor.call('POST', at('/features'), { kind: 'river', lon: 21.3, lat: -33.6 })).status).toBe(400);
		const bad = await editor.call('POST', at('/features'), { kind: 'other', geometry: { type: 'Point', coordinates: [21, -33, 4] } });
		expect(bad.body.error).toMatch(/3D coordinates/);
		expect((await editor.call('POST', at('/features'), { kind: 'gauge', lon: 200, lat: -33.6 })).status).toBe(400);
	});

	it('moves and renames a feature', async () => {
		const res = await editor.call('PATCH', at(`/features/${gaugeId}`), { name: 'Outlet weir', lon: 21.34, lat: -33.62 });
		expect(res.status).toBe(200);
		expect(res.body.feature).toMatchObject({ name: 'Outlet weir', geometry: { coordinates: [21.34, -33.62] }, nodeId: outlet.id });
	});

	it('records each change in the audit log, without the geometry', async () => {
		const rows = await asOwner(`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND kind LIKE 'map.%' ORDER BY id`, [projectId]);
		expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['map.imported', 'map.feature_created', 'map.feature_changed']));
		for (const r of rows) expect(JSON.stringify(r.subject)).not.toMatch(/coordinates/);
	});
});

describe('accepting an area from the map', () => {
	let parcelId: string;
	let parcelAreaKm2: number;

	beforeAll(async () => {
		const list = await editor.call('GET', at('/features'));
		const p = list.body.features.find((f: { kind: string; nodeId: string }) => f.kind === 'farm_parcel' && f.nodeId === farmA.id);
		parcelId = p.id;
		parcelAreaKm2 = p.areaM2 / 1e6;
	});

	it('sets the farm’s area, marks it from the map and records a revision naming the feature', async () => {
		expect((await viewer.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId: parcelId })).status).toBe(403);
		const res = await editor.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId: parcelId });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.areaKm2).toBeCloseTo(parcelAreaKm2, 9);
		const m = await editor.call('GET', `/projects/${projectId}/model`);
		expect(m.body.nodes.find((n: { id: string }) => n.id === farmA.id).areaKm2).toBeCloseTo(parcelAreaKm2, 9);
		const list = await editor.call('GET', at('/features'));
		expect(list.body.nodes.find((n: { id: string }) => n.id === farmA.id)).toMatchObject({ areaSource: 'map', areaFeatureId: parcelId });
		const [rev] = await asOwner(`SELECT reason, changes FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1`, [projectId]);
		expect(rev!.reason).toMatch(/^Area of Farm A from the map: “Farm A” \([\d.]+ km², computed from its polygon\)$/);
		expect(JSON.stringify(rev!.changes)).toMatch(/Farm A/);
	});

	it('refuses a point, a gauge node and another project’s feature', async () => {
		const gauge = (await editor.call('GET', at('/features'))).body.features.find((f: { kind: string }) => f.kind === 'gauge');
		expect((await editor.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId: gauge.id })).status).toBe(400);
		expect((await editor.call('POST', `/projects/${projectId}/nodes/${outlet.id}/area-from-map`, { featureId: parcelId })).status).toBe(400);
		const theirs = await stranger.call('POST', `/projects/${otherProjectId}/map/features`, { kind: 'other', geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.01)] } });
		expect(theirs.status).toBe(201);
		expect((await editor.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId: theirs.body.feature.id })).status).toBe(404);
	});

	it('refuses a dam’s polygon and the boundary as a unit’s catchment area, and leaves the area alone', async () => {
		const before = (await editor.call('GET', `/projects/${projectId}/model`)).body.nodes.find((n: { id: string }) => n.id === farmA.id).areaKm2;
		const dam = await editor.call('POST', at('/features'), { kind: 'dam', name: 'A dam polygon', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.002)] } });
		expect(dam.status).toBe(201);
		const boundary = (await editor.call('GET', at('/features'))).body.features.find((f: { kind: string }) => f.kind === 'catchment_boundary');
		for (const featureId of [dam.body.feature.id, boundary.id]) {
			const res = await editor.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId });
			expect(res.status).toBe(400);
			expect(res.body.error).toMatch(/area is not a hydrological unit’s catchment area; use a farm parcel\.$/);
		}
		// Positive control: the parcel is still accepted.
		expect((await editor.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId: parcelId })).status).toBe(200);
		expect((await editor.call('GET', `/projects/${projectId}/model`)).body.nodes.find((n: { id: string }) => n.id === farmA.id).areaKm2).toBeCloseTo(before, 9);
		expect((await editor.call('DELETE', at(`/features/${dam.body.feature.id}`))).status).toBe(204);
	});

	it('keeps “from the map” through a save that leaves the area alone, and drops it when the area is typed over', async () => {
		const saved = (await editor.call('GET', `/projects/${projectId}/model`)).body;
		expect((await editor.call('PUT', `/projects/${projectId}/model`, saved)).status).toBe(200);
		const source = async () => (await editor.call('GET', at('/features'))).body.nodes.find((n: { id: string }) => n.id === farmA.id);
		expect(await source()).toMatchObject({ areaSource: 'map', areaFeatureId: parcelId });
		saved.nodes.find((n: { id: string }) => n.id === farmA.id).areaKm2 = 3.5;
		expect((await editor.call('PUT', `/projects/${projectId}/model`, saved)).status).toBe(200);
		expect(await source()).toMatchObject({ areaKm2: 3.5, areaSource: 'typed', areaFeatureId: null });
	});

	it('keeps the area but forgets the feature when the feature is deleted', async () => {
		expect((await editor.call('POST', `/projects/${projectId}/nodes/${farmA.id}/area-from-map`, { featureId: parcelId })).status).toBe(200);
		expect((await editor.call('DELETE', at(`/features/${parcelId}`))).status).toBe(204);
		const n = (await editor.call('GET', at('/features'))).body.nodes.find((x: { id: string }) => x.id === farmA.id);
		expect(n).toMatchObject({ areaSource: 'map', areaFeatureId: null });
		expect(n.areaKm2).toBeCloseTo(parcelAreaKm2, 9);
	});
});

describe('who reads the map (RLS)', () => {
	it('a viewer reads it; another project’s member gets 404 and reads no row', async () => {
		const res = await viewer.call('GET', at('/features'));
		expect(res.status).toBe(200);
		expect(res.body.features.length).toBeGreaterThan(0);
		expect((await stranger.call('GET', at('/features'))).status).toBe(404);
		expect(await rowsAs(stranger, 'SELECT id FROM map_feature WHERE project_id = $1', [projectId])).toEqual([]);
		// Positive control: the stranger reads their own project's feature.
		expect((await rowsAs(stranger, 'SELECT id FROM map_feature WHERE project_id = $1', [otherProjectId])).length).toBe(1);
	});

	it('a farmer reads the boundary, gauges and their own farm’s features, never a neighbour’s; the route stays closed to them', async () => {
		const rows = await rowsAs<{ kind: string; node_id: string | null }>(farmer, 'SELECT kind, node_id FROM map_feature WHERE project_id = $1', [projectId]);
		const kinds = rows.map((r) => r.kind);
		expect(kinds).toContain('catchment_boundary');
		expect(kinds).toContain('gauge');
		expect(rows.filter((r) => r.kind === 'farm_parcel').map((r) => r.node_id)).toEqual([]);
		// Farm A's parcel was deleted above: link a new one to see the positive control.
		const mine = await editor.call('POST', at('/features'), { kind: 'dam', name: 'A dam', lon: 21.32, lat: -33.68, nodeId: farmA.id });
		const theirs = await editor.call('POST', at('/features'), { kind: 'dam', name: 'B dam', lon: 21.36, lat: -33.68, nodeId: farmB.id });
		const dams = await rowsAs<{ id: string }>(farmer, `SELECT id FROM map_feature WHERE project_id = $1 AND kind = 'dam'`, [projectId]);
		expect(dams.map((r) => r.id)).toEqual([mine.body.feature.id]);
		expect(dams.map((r) => r.id)).not.toContain(theirs.body.feature.id);
		expect((await farmer.call('GET', at('/features'))).status).toBe(403);
		expect(await rowsAs(farmer, 'SELECT id FROM geo_source WHERE project_id = $1', [projectId])).toEqual([]);
	});
});

describe('the quaternary lookup', () => {
	it('proposes the synthetic quaternary’s values at a point in it, marked synthetic, with the source', async () => {
		const res = await viewer.call('GET', `${at('/quaternary')}?lon=21.35&lat=-33.65`);
		expect(res.status).toBe(200);
		expect(res.body.quaternary).toMatchObject({ code: 'Z01B', dataset: 'synthetic', synthetic: true, source: expect.stringMatching(/^SYNTHETIC/) });
		expect(res.body.quaternary.monthlyMm3).toHaveLength(12);
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 6 }]));
	});

	it('finds none outside the dataset, refuses a bad point and a stranger', async () => {
		expect((await viewer.call('GET', `${at('/quaternary')}?lon=28&lat=-26`)).body.quaternary).toBeNull();
		expect((await viewer.call('GET', `${at('/quaternary')}?lon=200&lat=-26`)).status).toBe(400);
		expect((await stranger.call('GET', `${at('/quaternary')}?lon=21.35&lat=-33.65`)).status).toBe(404);
	});

	it('is read-only to the app role (control: it reads it)', async () => {
		expect((await rowsAs(viewer, 'SELECT code FROM quaternary_reference WHERE code = $1', ['Z01B'])).length).toBe(1);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE quaternary_reference SET map_mm = 1 WHERE code = 'Z01B'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(editor.id, (db) => db.query(`DELETE FROM quaternary_reference`))).rejects.toThrow(/permission denied/);
	});
});

describe('the import’s body limit', () => {
	it('takes a body over the general 4 MB cap on this route, and refuses one over its own', async () => {
		// A valid file padded with whitespace to ~4.5 MB: past the general cap, under the file limit.
		const padded = boundaryFile('Padded', 0.05) + ' '.repeat(4.5 * 1024 * 1024);
		const res = await editor.call('POST', at('/import'), { fileName: 'padded.geojson', kind: 'other', text: padded });
		expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
		const huge = await app.request(at('/import'), {
			method: 'POST',
			headers: { cookie: editor.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: JSON.stringify({ fileName: 'huge.geojson', kind: 'other', text: 'x'.repeat(8 * 1024 * 1024) })
		});
		expect(huge.status).toBe(413);
	});
});
