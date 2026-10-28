// GET /projects/:id/evaporation-stations and POST …/evaporation-from-station
// (issue #646 item 6; docs/api.md § Catchment map, docs/maps.md §
// Evaporation stations): the nearest DWS evaporation stations to the
// catchment boundary from evaporation_station_reference (274, the committed
// INVENTED dataset), and accepting one as the A-pan row (+ the daily series
// for a Class-A pan) with a settings revision citing the station. A viewer
// reads (positive control), a farmer gets 403, a stranger 404; a viewer
// can't accept; water_app can't write the table.
import { SPAN_FROM_APAN } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticEvaporationStations } from '../../scripts/import-evaporation-stations.js';
import { node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let noMapId: string;
const outlet = node('Outlet weir', null);
const farm = node('Farm A', outlet.id);
const model = () => ({ nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] });
const at = (path = '', id = projectId) => `/projects/${id}${path}`;
/** Round the synthetic stations: Z1E001 inside it, Z1E002 and Z1E003 within 100 km, Z2E001 ~200 km off. */
const SQUARE = [
	[21.25, -33.85],
	[21.4, -33.85],
	[21.4, -33.7],
	[21.25, -33.7],
	[21.25, -33.85]
];

const reasons = async (id: string) =>
	(await withUser(owner.id, (db) => db.query<{ reason: string }>(`SELECT reason FROM model_revision WHERE project_id = $1 AND source = 'settings_patch' ORDER BY created_at, id`, [id]))).rows.map((r) => r.reason);
const settingsOf = async (id: string) => (await owner.call('GET', at('', id))).body.project.settings as { apanMm: number[] };
const apanSeries = async (id: string) =>
	(await withUser(owner.id, (db) => db.query<{ name: string; source: string; start: string; n: number }>(`SELECT name, source, start_date::text AS start, cardinality("values") AS n FROM time_series WHERE project_id = $1 AND kind = 'evap_apan_mm' ORDER BY name`, [id]))).rows;

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['EVSowner', 'EVSviewer', 'EVSfarmer', 'EVSstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Evaporation stations' })).body.project.id;
	noMapId = (await owner.call('POST', '/projects', { name: 'Evaporation stations, no map' })).body.project.id;
	expect((await owner.call('PUT', at('/model'), model())).status).toBe(200);
	expect((await owner.call('POST', at('/members'), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', at('/farmers'), { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const r = await loadSyntheticEvaporationStations(process.env.TEST_MIGRATION_DATABASE_URL!);
	expect(r).toEqual({ written: 4, problems: [] });
	const b = await owner.call('POST', at('/map/features'), { kind: 'catchment_boundary', name: 'Test catchment', geometry: { type: 'Polygon', coordinates: [SQUARE] } });
	expect(b.status).toBe(201);
}, 60_000);

describe('the nearest evaporation stations', () => {
	it('with no boundary proposes nothing, but says the stations are loaded', async () => {
		const res = await owner.call('GET', at('/evaporation-stations', noMapId));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ boundary: null, stations: [], withinKm: 100 });
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 4 }]));
	});

	it('lists the stations within 100 km of the boundary, nearest first, each with pan, span, completeness and its monthly means', async () => {
		const res = await viewer.call('GET', at('/evaporation-stations'));
		expect(res.status).toBe(200);
		expect(res.body.boundary).toMatchObject({ name: 'Test catchment' });
		const s = res.body.stations as {
			code: string;
			pan: string;
			distanceKm: number;
			recordStart: string;
			recordEnd: string;
			completeness: number;
			synthetic: boolean;
			monthly: { meansMm: (number | null)[]; problem: string | null };
			apan: { ok: boolean } | null;
			conversions: { id: string; result: { ok: boolean } }[] | null;
		}[];
		expect(s.map((x) => x.code)).toEqual(['Z1E001', 'Z1E002', 'Z1E003']);
		expect(s[0]).toMatchObject({ pan: 'class_a', distanceKm: 0, recordStart: '2014-01-01', recordEnd: '2019-12-31', synthetic: true, apan: { ok: true }, conversions: null });
		expect(s[0]!.completeness).toBeGreaterThan(0.95);
		expect(s[1]).toMatchObject({ pan: 'symons', apan: null });
		expect(s[1]!.conversions!.map((c) => [c.id, c.result.ok])).toEqual([
			['taljaard2023', true],
			['wr90', false]
		]);
		expect(s[2]!.monthly.problem).toMatch(/fewer than 3/);
		expect(res.body.settings).toMatchObject({ dailyApan: [] });
		// The values arrays never reach the response.
		expect(JSON.stringify(res.body)).not.toContain('"values"');
		const far = await viewer.call('GET', at('/evaporation-stations?within=300'));
		expect(far.body.stations.map((x: { code: string }) => x.code)).toContain('Z2E001');
	});

	it('refuses a radius out of range', async () => {
		expect((await viewer.call('GET', at('/evaporation-stations?within=0'))).status).toBe(400);
		expect((await viewer.call('GET', at('/evaporation-stations?within=400'))).status).toBe(400);
	});

	it('is a viewer’s read: a farmer gets 403 and a stranger 404 (control: the viewer reads it above)', async () => {
		expect((await farmer.call('GET', at('/evaporation-stations'))).status).toBe(403);
		expect((await stranger.call('GET', at('/evaporation-stations'))).status).toBe(404);
	});

	it('is read-only to the app role (control: it reads it)', async () => {
		const rows = await withUser(viewer.id, async (db) => (await db.query('SELECT code FROM evaporation_station_reference WHERE code = $1', ['Z1E001'])).rows);
		expect(rows.length).toBe(1);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evaporation_station_reference SET name = 'x' WHERE code = 'Z1E001'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`DELETE FROM evaporation_station_reference`))).rejects.toThrow(/permission denied/);
	});
});

describe('accepting a station', () => {
	it('a viewer can’t accept (403), a stranger gets 404, and nothing changes', async () => {
		const before = await settingsOf(projectId);
		expect((await viewer.call('POST', at('/evaporation-from-station'), { station: 'Z1E001' })).status).toBe(403);
		expect((await stranger.call('POST', at('/evaporation-from-station'), { station: 'Z1E001' })).status).toBe(404);
		expect((await settingsOf(projectId)).apanMm).toEqual(before.apanMm);
	});

	it('refuses what can’t be used, with its reason', async () => {
		const post = (body: unknown, id = projectId) => owner.call('POST', at('/evaporation-from-station', id), body);
		expect((await post({ station: 'Z1E001' }, noMapId)).body.error).toMatch(/no catchment boundary/);
		expect((await post({ station: 'Z9E999' })).body.error).toMatch(/No evaporation station Z9E999/);
		expect((await post({ station: 'Z1E001', conversion: 'wr90' })).body.error).toMatch(/no conversion applies/);
		expect((await post({ station: 'Z1E002' })).body.error).toMatch(/pick the equation/);
		expect((await post({ station: 'Z1E002', conversion: 'wr90' })).body.error).toMatch(/Jul is below 32\.5 mm/);
		expect((await post({ station: 'Z1E002', conversion: 'taljaard2023', daily: true })).body.error).toMatch(/Symons pan’s daily record is not written/);
		expect((await post({ station: 'Z1E003' })).body.error).toMatch(/fewer than 3/);
		expect((await post({ station: 'Z1H001' })).status).toBe(400);
		expect((await post({ station: 'Z1E001', extra: 1 })).status).toBe(400);
		expect(await reasons(projectId)).toEqual([]);
	});

	it('a Class-A station writes the A-pan row and the daily series, with a revision citing it', async () => {
		const listed = (await owner.call('GET', at('/evaporation-stations'))).body.stations[0];
		const res = await owner.call('POST', at('/evaporation-from-station'), { station: 'z1e001' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ station: 'Z1E001', conversion: null, series: 'DWS Z1E001', revisionId: expect.any(String) });
		expect(res.body.apanMm).toEqual(listed.monthly.meansMm);
		expect((await settingsOf(projectId)).apanMm).toEqual(listed.monthly.meansMm);
		const [reason] = await reasons(projectId);
		expect(reason).toMatch(/^A-pan evaporation from DWS evaporation station Z1E001 “Testpan Dam \(invented\)” \(Class-A pan, inside the catchment boundary “Test catchment”\)/);
		expect(reason).toMatch(/monthly means of 2014-01–2019-12/);
		expect(reason).toMatch(/daily series “DWS Z1E001” written \(2014-01-01 to 2019-12-31\)/);
		expect(reason).toMatch(/dataset “synthetic”/);
		expect(await apanSeries(projectId)).toEqual([{ name: 'DWS Z1E001', source: 'DWS evaporation station Z1E001 (Class-A pan), dataset synthetic', start: '2014-01-01', n: 2191 }]);
		const after = (await owner.call('GET', at('/evaporation-stations'))).body.settings.dailyApan;
		expect(after).toEqual([{ name: 'DWS Z1E001', source: expect.stringMatching(/Z1E001/), from: '2014-01-01', to: '2019-12-31' }]);
	});

	it('a Symons station writes only the 12 means converted by the equation picked, cited, and leaves the daily series alone', async () => {
		const res = await owner.call('POST', at('/evaporation-from-station'), { station: 'Z1E002', conversion: 'taljaard2023' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ station: 'Z1E002', conversion: 'taljaard2023', series: null });
		const listed = (await owner.call('GET', at('/evaporation-stations'))).body.stations[1];
		const c = SPAN_FROM_APAN.taljaard2023;
		expect(res.body.apanMm[0]).toBeCloseTo((listed.monthly.meansMm[0] - c.interceptMm) / c.slope, 1);
		expect((await settingsOf(projectId)).apanMm).toEqual(res.body.apanMm);
		const reason = (await reasons(projectId)).at(-1)!;
		expect(reason).toMatch(/Z1E002 “Symons Testpan \(invented\)” \(Symons pan, /);
		expect(reason).toMatch(/A = \(S \+ 11\.1745\) ÷ 0\.8706, the inverse of the Taljaard \(2023\)/);
		expect(reason).toMatch(/the daily S-pan record not written/);
		// The Class-A station's series stays as it was.
		expect((await apanSeries(projectId)).map((s) => s.name)).toEqual(['DWS Z1E001']);
	});

	it('refuses a second daily A-pan series under another name (409); monthly only still works', async () => {
		const other = await owner.call('POST', '/projects', { name: 'Evaporation stations, own series' });
		const id = other.body.project.id as string;
		expect((await owner.call('POST', at('/map/features', id), { kind: 'catchment_boundary', name: 'B', geometry: { type: 'Polygon', coordinates: [SQUARE] } })).status).toBe(201);
		expect((await owner.call('PUT', at('/series', id), { kind: 'evap_apan_mm', name: 'My pan', unit: 'mm', startDate: '2020-01-01', values: [5, 6] })).status).toBe(200);
		const res = await owner.call('POST', at('/evaporation-from-station', id), { station: 'Z1E001' });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/already has a daily A-pan series, “My pan”/);
		const monthly = await owner.call('POST', at('/evaporation-from-station', id), { station: 'Z1E001', daily: false });
		expect(monthly.status).toBe(200);
		expect(monthly.body.series).toBeNull();
		expect((await apanSeries(id)).map((s) => s.name)).toEqual(['My pan']);
		expect((await reasons(id)).at(-1)).toMatch(/daily series not written/);
	});
});
