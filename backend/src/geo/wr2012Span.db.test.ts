// WR2012's S-pan per quaternary (310_quaternary_evaporation.sql; docs/maps.md
// § WR2012 S-pan, docs/api.md § Catchment map): the loader's MAE, zone and
// zones table, GET /projects/:id/evaporation-wr2012 (each quaternary the
// boundary overlaps with its share, zone, MAE and S-pan; the catchment's
// area-weighted S-pan; each S→A equation's A-pan) and POST
// …/evaporation-from-wr2012 (the A-pan row as one settings revision naming the
// dataset, quaternaries, zones, MAEs and equation). A viewer reads (positive
// control), a farmer gets 403, a stranger 404; a viewer can't accept;
// water_app can't write the zones table. Invented data only: the committed
// synthetic dataset (region Z) and an invented region Y out at sea.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importQuaternaries, parseArgs } from '../../scripts/import-quaternaries.js';
import { node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { quaternaryRecords, replaceDataset } from './loadQuaternaries.js';
import { spanFromMae } from './wr2012Span.js';

type User = Awaited<ReturnType<typeof signUp>>;

const OWNER_URL = () => process.env.TEST_MIGRATION_DATABASE_URL!;
/** An invented dataset in drainage region Y, out at sea (no other test's outlines are there). */
const YT = 'wr2012-span-test';
const box = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let noMapId: string;
let noEvapId: string;
const outlet = node('Outlet weir', null);
const farm = node('Farm A', outlet.id);
const model = () => ({ nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] });
const at = (path = '', id = projectId) => `/projects/${id}${path}`;

const asOwner = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
	const client = new pg.Client({ connectionString: OWNER_URL() });
	await client.connect();
	try {
		return (await client.query<T>(sql, params)).rows;
	} finally {
		await client.end();
	}
};
const reasons = async (id: string) =>
	(await withUser(owner.id, (db) => db.query<{ reason: string }>(`SELECT reason FROM model_revision WHERE project_id = $1 AND source = 'settings_patch' ORDER BY created_at, id`, [id]))).rows.map((r) => r.reason);
const settingsOf = async (id: string) => (await owner.call('GET', at('', id))).body.project.settings as { apanMm: number[] };
const boundary = async (id: string, ring: number[][], name = 'Test catchment') =>
	expect((await owner.call('POST', at('/map/features', id), { kind: 'catchment_boundary', name, geometry: { type: 'Polygon', coordinates: [ring] } })).status).toBe(201);

/** Region Y: Y01A with an MAE and a zone, Y01B with a zone its load has no distribution for. */
async function loadRegionY() {
	const features = [
		{ type: 'Feature', properties: { code: 'Y01A', maeMm: 1800, evapZone: '3B' }, geometry: { type: 'Polygon', coordinates: [box(40, -41, 40.25, -40.75)] } },
		{ type: 'Feature', properties: { code: 'Y01B', maeMm: 1700, evapZone: '9Z' }, geometry: { type: 'Polygon', coordinates: [box(40.25, -41, 40.5, -40.75)] } }
	];
	const got = quaternaryRecords({ type: 'FeatureCollection', evapZones: [{ zone: '3b', pct: new Array(12).fill(8.25) }], features }, 'INVENTED region Y (test)');
	expect(got.problems).toEqual(['Y01B: evaporation zone 9Z has no monthly distribution in this load; loaded without its evaporation']);
	const client = new pg.Client({ connectionString: OWNER_URL() });
	await client.connect();
	try {
		await replaceDataset(client, YT, got);
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['W12owner', 'W12viewer', 'W12farmer', 'W12stranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'WR2012 S-pan' })).body.project.id;
	noMapId = (await owner.call('POST', '/projects', { name: 'WR2012 S-pan, no map' })).body.project.id;
	noEvapId = (await owner.call('POST', '/projects', { name: 'WR2012 S-pan, no evaporation' })).body.project.id;
	expect((await owner.call('PUT', at('/model'), model())).status).toBe(200);
	expect((await owner.call('POST', at('/members'), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', at('/farmers'), { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const args = parseArgs([]);
	if (typeof args === 'string') throw new Error(args);
	expect(await importQuaternaries(OWNER_URL(), args)).toEqual({ written: 6, problems: [] });
	await loadRegionY();
	// 0.15° west of the Z01A/Z01B divide (21.25°E) and 0.05° east of it: 75 % and 25 %.
	await boundary(projectId, box(21.1, -33.7, 21.3, -33.6));
	// Inside Y01B, whose zone has no distribution.
	await boundary(noEvapId, box(40.3, -40.95, 40.4, -40.85));
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM quaternary_reference WHERE dataset = $1', [YT]);
	await asOwner('DELETE FROM quaternary_evap_zone WHERE dataset = $1', [YT]);
});

describe('loading the evaporation with the quaternaries', () => {
	it('stores each quaternary’s MAE and zone, and its dataset’s zones', async () => {
		const q = await asOwner<{ code: string; mae_mm: number | null; evap_zone: string | null }>(
			'SELECT code, mae_mm, evap_zone FROM quaternary_reference WHERE dataset = ANY($1) ORDER BY code',
			[['synthetic', YT]]
		);
		expect(q.map((r) => [r.code, r.mae_mm, r.evap_zone])).toEqual([
			['Y01A', 1800, '3B'],
			['Y01B', null, null],
			['Z01A', 1500, 'Z1'],
			['Z01B', 1560, 'Z1'],
			['Z01C', 1620, 'Z1'],
			['Z02A', 1450, 'Z2'],
			['Z02B', 1520, 'Z2'],
			['Z02C', 1600, 'Z2']
		]);
		const z = await asOwner<{ dataset: string; zone: string }>('SELECT dataset, zone FROM quaternary_evap_zone WHERE dataset = ANY($1) ORDER BY dataset, zone', [['synthetic', YT]]);
		expect(z).toEqual([
			{ dataset: 'synthetic', zone: 'Z1' },
			{ dataset: 'synthetic', zone: 'Z2' },
			{ dataset: YT, zone: '3B' }
		]);
	});

	it('a reload replaces the zones with the quaternaries, in one transaction', async () => {
		await loadRegionY();
		expect(await asOwner('SELECT zone FROM quaternary_evap_zone WHERE dataset = $1', [YT])).toEqual([{ zone: '3B' }]);
	});

	it('the table refuses what the loader refuses: a total outside 95–105 %, a missing month, a lone MAE', async () => {
		await expect(asOwner(`INSERT INTO quaternary_evap_zone (dataset, zone, pct) VALUES ($1, 'X1', $2)`, [YT, new Array(12).fill(7)])).rejects.toThrow(/check constraint/);
		await expect(asOwner(`INSERT INTO quaternary_evap_zone (dataset, zone, pct) VALUES ($1, 'X1', $2)`, [YT, [...new Array(11).fill(9), null]])).rejects.toThrow(/check constraint/);
		await expect(asOwner(`INSERT INTO quaternary_evap_zone (dataset, zone, pct) VALUES ($1, 'X1', $2)`, [YT, new Array(11).fill(9.1)])).rejects.toThrow(/check constraint/);
		await expect(asOwner(`UPDATE quaternary_reference SET evap_zone = NULL WHERE code = 'Y01A'`)).rejects.toThrow(/quaternary_reference_evaporation_pair/);
	});

	it('is read-only to the app role (control: a signed-in user reads it)', async () => {
		const rows = await withUser(viewer.id, async (db) => (await db.query('SELECT zone FROM quaternary_evap_zone WHERE dataset = $1', ['synthetic'])).rows);
		expect(rows.length).toBe(2);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE quaternary_evap_zone SET pct = pct WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`DELETE FROM quaternary_evap_zone`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`INSERT INTO quaternary_evap_zone (dataset, zone, pct) VALUES ('x', 'X1', $1)`, [new Array(12).fill(8.4)]))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE quaternary_reference SET mae_mm = 1 WHERE code = 'Z01A'`))).rejects.toThrow(/permission denied/);
	});
});

describe('GET …/evaporation-wr2012', () => {
	it('with no boundary proposes nothing, but says which quaternary datasets are loaded', async () => {
		const res = await owner.call('GET', at('/evaporation-wr2012', noMapId));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ boundary: null, span: null, settings: { dailyApan: [] } });
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 6 }]));
	});

	it('lists each quaternary the boundary overlaps with its share, zone, MAE and S-pan, and the catchment’s area-weighted S-pan', async () => {
		const res = await viewer.call('GET', at('/evaporation-wr2012'));
		expect(res.status).toBe(200);
		expect(res.body.boundary).toMatchObject({ name: 'Test catchment' });
		const span = res.body.span;
		expect(span.problem).toBeNull();
		expect(span.quaternaries.map((q: { code: string; zone: string; maeMm: number; synthetic: boolean }) => [q.code, q.zone, q.maeMm, q.synthetic])).toEqual([
			['Z01A', 'Z1', 1500, true],
			['Z01B', 'Z1', 1560, true]
		]);
		const [a, b] = span.quaternaries as { share: number; spanMm: number[]; pct: number[]; source: string }[];
		expect(a!.share).toBeCloseTo(0.75, 2);
		expect(b!.share).toBeCloseTo(0.25, 2);
		expect(a!.spanMm).toEqual(spanFromMae(1500, a!.pct));
		expect(a!.source).toMatch(/^SYNTHETIC/);
		expect(span.coverage).toBeCloseTo(1, 6);
		// Both in zone Z1: the catchment's S-pan is the zone's % of the weighted MAE.
		const mae = a!.share * 1500 + b!.share * 1560;
		expect(span.spanMm[0]).toBeCloseTo((mae * a!.pct[0]!) / 100, 1);
		expect(span.conversions.map((c: { id: string; result: { ok: boolean } }) => [c.id, c.result.ok])).toEqual([
			['taljaard2023', true],
			['wr90', true]
		]);
		expect(res.body.settings.apanMm).toHaveLength(12);
		// Outlines never reach the response.
		expect(JSON.stringify(res.body)).not.toContain('coordinates');
	});

	it('says so when the quaternary under the boundary has no evaporation loaded', async () => {
		const res = await owner.call('GET', at('/evaporation-wr2012', noEvapId));
		expect(res.status).toBe(200);
		expect(res.body.span).toMatchObject({ spanMm: null, coverage: 0, conversions: [], problem: 'the quaternary under the catchment boundary (Y01B) has no WR2012 evaporation loaded' });
		expect(res.body.span.quaternaries).toEqual([expect.objectContaining({ code: 'Y01B', zone: null, maeMm: null, spanMm: null })]);
	});

	it('is a viewer’s read: a farmer gets 403 and a stranger 404 (control: the viewer reads it above)', async () => {
		expect((await farmer.call('GET', at('/evaporation-wr2012'))).status).toBe(403);
		expect((await stranger.call('GET', at('/evaporation-wr2012'))).status).toBe(404);
	});
});

describe('POST …/evaporation-from-wr2012', () => {
	it('a viewer can’t accept (403), a farmer 403, a stranger 404, and nothing changes', async () => {
		const before = await settingsOf(projectId);
		expect((await viewer.call('POST', at('/evaporation-from-wr2012'), { conversion: 'wr90' })).status).toBe(403);
		expect((await farmer.call('POST', at('/evaporation-from-wr2012'), { conversion: 'wr90' })).status).toBe(403);
		expect((await stranger.call('POST', at('/evaporation-from-wr2012'), { conversion: 'wr90' })).status).toBe(404);
		expect((await settingsOf(projectId)).apanMm).toEqual(before.apanMm);
		expect(await reasons(projectId)).toEqual([]);
	});

	it('refuses what can’t be used, with its reason and never DB text', async () => {
		const post = (body: unknown, id = projectId) => owner.call('POST', at('/evaporation-from-wr2012', id), body);
		expect((await post({ conversion: 'wr90' }, noMapId)).body.error).toMatch(/no catchment boundary/);
		const none = await post({ conversion: 'wr90' }, noEvapId);
		expect(none.status).toBe(400);
		expect(none.body.error).toMatch(/Y01B\) has no WR2012 evaporation loaded/);
		expect(none.body.error).not.toMatch(/quaternary_|SELECT/);
		// The user picks the equation: none is picked for them.
		expect((await post({})).status).toBe(400);
		expect((await post({ conversion: 'pitman' })).status).toBe(400);
		expect((await post({ conversion: 'wr90', spanMm: new Array(12).fill(1) })).status).toBe(400);
		expect(await reasons(projectId)).toEqual([]);
		expect(await reasons(noEvapId)).toEqual([]);
	});

	it('writes the A-pan row from the equation picked, re-derived on the server, as one revision naming the dataset, quaternaries, zones, MAEs and equation', async () => {
		const listed = (await owner.call('GET', at('/evaporation-wr2012'))).body.span;
		const res = await owner.call('POST', at('/evaporation-from-wr2012'), { conversion: 'taljaard2023' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const taljaard = listed.conversions.find((c: { id: string }) => c.id === 'taljaard2023').result.values;
		expect(res.body).toMatchObject({ conversion: 'taljaard2023', quaternaries: ['Z01A', 'Z01B'], spanMm: listed.spanMm, apanMm: taljaard, revisionId: expect.any(String) });
		expect((await settingsOf(projectId)).apanMm).toEqual(taljaard);
		const r = await reasons(projectId);
		expect(r).toHaveLength(1);
		expect(r[0]).toMatch(/^A-pan evaporation from WR2012 S-pan \(dataset “synthetic”\): \d+ mm a year from \d+ mm of S-pan, the area-weighted mean of the quaternaries under the catchment boundary “Test catchment”: /);
		expect(r[0]).toMatch(/Z01A 75 % \(zone Z1, MAE 1500 mm\), Z01B 25 % \(zone Z1, MAE 1560 mm\)/);
		expect(r[0]).toMatch(/A = \(S \+ 11\.1745\) ÷ 0\.8706, the inverse of the Taljaard \(2023\)/);
		expect(r[0]).not.toMatch(/left out/);
	});

	it('a catchment in one quaternary takes its row; one partly outside every quaternary says how much is left out', async () => {
		const one = (await owner.call('POST', '/projects', { name: 'WR2012 S-pan, one quaternary' })).body.project.id as string;
		await boundary(one, box(21.55, -33.95, 21.65, -33.85), 'In Z02C');
		const got = await owner.call('POST', at('/evaporation-from-wr2012', one), { conversion: 'wr90' });
		expect(got.status, JSON.stringify(got.body)).toBe(200);
		const zones = await asOwner<{ pct: number[] }>(`SELECT pct FROM quaternary_evap_zone WHERE dataset = 'synthetic' AND zone = 'Z2'`);
		expect(got.body.spanMm).toEqual(spanFromMae(1600, zones[0]!.pct));
		expect((await reasons(one)).at(-1)).toMatch(/mm of S-pan, the quaternary under the catchment boundary “In Z02C”: Z02C 100 % \(zone Z2, MAE 1600 mm\).*the inverse of the WR90 monthly equation/);

		const edge = (await owner.call('POST', '/projects', { name: 'WR2012 S-pan, past the edge' })).body.project.id as string;
		// Half east of Z01C (21.75°E), where nothing is loaded.
		await boundary(edge, box(21.7, -33.7, 21.8, -33.6), 'Past the edge');
		const view = (await owner.call('GET', at('/evaporation-wr2012', edge))).body.span;
		expect(view.coverage).toBeCloseTo(0.5, 2);
		expect(view.spanMm).toEqual(spanFromMae(1620, view.quaternaries[0].pct));
		expect((await owner.call('POST', at('/evaporation-from-wr2012', edge), { conversion: 'wr90' })).status).toBe(200);
		expect((await reasons(edge)).at(-1)).toMatch(/; 50 % of the catchment has no WR2012 evaporation and is left out of the mean/);
	});
});
