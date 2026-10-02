// The river network on the map (issue #345; geo/rivers.ts) over the committed
// synthetic network (eleven invented reaches round the e2e and example maps).
// A viewer reads the reaches whose box meets the bbox, biggest order first,
// marked synthetic; a bad or oversized bbox is refused. An editor adds one
// reach as a river feature (its source in the description, its id in ref),
// once; a viewer can't, a farmer and a non-member read nothing, with members'
// reads as the positive controls. water_app never writes the network.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticRivers } from '../../scripts/import-rivers.js';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { replaceRivers, riverRecords } from './loadRivers.js';
import { RIVER_BBOX_MAX_DEG, riverRef } from './rivers.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;

const outlet = node('Weir', null);
const farm = node('Farm R', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const url = (bbox: string, id = projectId) => `/projects/${id}/map/rivers?bbox=${encodeURIComponent(bbox)}`;
const AROUND = '21.15,-33.85,21.5,-33.5';

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['RVowner', 'RVviewer', 'RVfarmer', 'RVstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'River network' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	await loadSyntheticRivers(process.env.TEST_MIGRATION_DATABASE_URL!);
}, 60_000);

describe('GET /projects/:id/map/rivers', () => {
	it('gives a viewer the reaches whose box meets the bbox, highest order first, marked synthetic, none added yet', async () => {
		const res = await viewer.call('GET', url(AROUND));
		expect(res.status).toBe(200);
		const reaches = res.body.reaches as { reachId: number; strahler: number; featureId: string | null; synthetic: boolean }[];
		expect(reaches).toHaveLength(10);
		expect(reaches.map((r) => r.strahler)).toEqual([...reaches.map((r) => r.strahler)].sort((a, b) => b - a));
		expect(reaches.map((r) => r.reachId)).not.toContain(90000011);
		expect(reaches[0]).toEqual({
			dataset: 'synthetic',
			reachId: 90000002,
			name: '',
			strahler: 3,
			upstreamKm2: 655,
			lengthKm: expect.any(Number),
			dischargeM3s: 1.84,
			synthetic: true,
			source: expect.stringMatching(/^SYNTHETIC/),
			geometry: { type: 'LineString', coordinates: expect.any(Array) },
			featureId: null
		});
		expect(res.body.truncated).toBe(false);
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 11 }]));
	});

	it('answers an empty list where nothing is loaded', async () => {
		const res = await viewer.call('GET', url('28,-26.5,28.5,-26'));
		expect(res.status).toBe(200);
		expect(res.body.reaches).toEqual([]);
	});

	it('refuses a malformed, inverted or oversized bbox, and a missing one', async () => {
		for (const bbox of ['21,-33', '21.5,-33.7,21.4,-33.6', `21,-34,${21 + RIVER_BBOX_MAX_DEG + 0.1},-33`]) {
			const res = await viewer.call('GET', url(bbox));
			expect(res.status, bbox).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/river_reference|SELECT/);
		}
		expect((await viewer.call('GET', `/projects/${projectId}/map/rivers`)).status).toBe(400);
	});

	it('is closed to a non-member (404) and to a farmer (403); the owner reads it (control)', async () => {
		expect((await stranger.call('GET', url(AROUND))).status).toBe(404);
		expect((await farmer.call('GET', url(AROUND))).status).toBe(403);
		expect((await owner.call('GET', url(AROUND))).body.reaches).toHaveLength(10);
	});
});

describe('POST /projects/:id/map/rivers/add', () => {
	it('adds one reach as a river feature with its source, once; the layer then marks it added', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000003 });
		expect(res.status).toBe(201);
		expect(res.body.feature).toMatchObject({
			kind: 'river',
			name: 'Reach 90000003',
			nodeId: null,
			areaM2: null,
			geometry: { type: 'LineString', coordinates: [[21.22, -33.6], [21.26, -33.63], [21.3, -33.66]] },
			properties: { ref: riverRef('synthetic', 90000003), description: expect.stringMatching(/^From the river network, reach 90000003 \(Strahler order 2, 168 km² upstream\): SYNTHETIC/) }
		});
		const again = await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000003 });
		expect(again.status).toBe(409);

		const layer = await viewer.call('GET', url(AROUND));
		const added = layer.body.reaches.filter((r: { featureId: string | null }) => r.featureId);
		expect(added).toEqual([expect.objectContaining({ reachId: 90000003, featureId: res.body.feature.id })]);
		const [audit] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.feature_created' ORDER BY created_at DESC LIMIT 1`, [projectId]);
		expect(audit.subject).toMatchObject({ kind: 'river', from: 'river_network', dataset: 'synthetic', reachId: 90000003 });

		// Deleted from the map, it can be added again.
		expect((await owner.call('DELETE', `/projects/${projectId}/map/features/${res.body.feature.id}`)).status).toBe(204);
		expect((await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000003 })).status).toBe(201);
	});

	it('refuses an unknown reach (404), a bad body (400), a viewer (403) and a non-member (404)', async () => {
		expect((await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 1 })).status).toBe(404);
		expect((await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 'x' })).status).toBe(400);
		expect((await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 9, extra: 1 })).status).toBe(400);
		expect((await viewer.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000004 })).status).toBe(403);
		expect((await farmer.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000004 })).status).toBe(403);
		expect((await stranger.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000004 })).status).toBe(404);
		// Control: an editor of the project can add that reach.
		expect((await owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000004 })).status).toBe(201);
	});

	it('adds a reach once when two adds race: one 201, one 409, one feature', async () => {
		const add = () => owner.call('POST', `/projects/${projectId}/map/rivers/add`, { dataset: 'synthetic', reachId: 90000010 });
		const [a, b] = await Promise.all([add(), add()]);
		expect([a.status, b.status].sort()).toEqual([201, 409]);
		const rows = await asOwner(`SELECT id FROM map_feature WHERE project_id = $1 AND properties ->> 'ref' = $2`, [projectId, riverRef('synthetic', 90000010)]);
		expect(rows).toHaveLength(1);
	});

	it('leaves the network read-only to the app role', async () => {
		const read = await withUser(viewer.id, (db) => db.query('SELECT count(*)::int AS n FROM river_reference WHERE dataset = $1', ['synthetic']));
		expect(read.rows[0].n).toBe(11);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE river_reference SET name = 'x' WHERE reach_id = 90000001`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM river_reference'))).rejects.toThrow(/permission denied/);
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO river_reference (dataset, reach_id, geometry, min_lon, min_lat, max_lon, max_lat, source) VALUES ('x', 1, '{"type":"LineString","coordinates":[]}', 0, 0, 0, 0, 's')`)
			)
		).rejects.toThrow(/permission denied/);
	});
});

describe('replaceRivers (the loader, as the schema owner)', () => {
	const reach = (reachId: number, x: number) => ({
		name: 'r.geojson',
		text: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { HYRIV_ID: reachId, ORD_STRA: 1 }, geometry: { type: 'LineString', coordinates: [[x, -26], [x + 0.01, -26.01]] } }] })
	});
	const count = async (dataset: string) => (await asOwner('SELECT reach_id FROM river_reference WHERE dataset = $1 ORDER BY reach_id', [dataset])).map((r: { reach_id: string }) => Number(r.reach_id));
	const withOwner = async <T>(f: (c: pg.Client) => Promise<T>): Promise<T> => {
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			return await f(client);
		} finally {
			await client.end();
		}
	};

	it('replaces its own dataset on a reload, leaves every other dataset alone, and rolls back whole on a failure', async () => {
		const a1 = riverRecords([reach(1, 28), reach(2, 28.1)], 'Loader test A').records;
		const b1 = riverRecords([reach(5, 28.2)], 'Loader test B').records;
		expect(await withOwner((c) => replaceRivers(c, 'loader-test-a', a1))).toBe(2);
		expect(await withOwner((c) => replaceRivers(c, 'loader-test-b', b1))).toBe(1);
		// A reload of A with one reach: A is that one reach, B untouched.
		expect(await withOwner((c) => replaceRivers(c, 'loader-test-a', riverRecords([reach(3, 28.3)], 'Loader test A').records))).toBe(1);
		expect(await count('loader-test-a')).toEqual([3]);
		expect(await count('loader-test-b')).toEqual([5]);
		// A load the database refuses (an order the CHECK rejects) changes nothing.
		const bad = [{ ...riverRecords([reach(4, 28.4)], 'Loader test A').records[0]!, strahler: 99 }];
		await expect(withOwner((c) => replaceRivers(c, 'loader-test-a', bad))).rejects.toThrow();
		expect(await count('loader-test-a')).toEqual([3]);
		await asOwner(`DELETE FROM river_reference WHERE dataset IN ('loader-test-a', 'loader-test-b')`);
	});
});
