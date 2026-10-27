// Security regressions for the dam observations (249_dam_observation, issue
// #604 R5): who reads the waterbody reference, the matches and the
// observations (a project's members and its farmers, each only their own;
// every "cannot see" with its positive control), and that only the worker's
// functions, with no user, write them. The functions' behaviour is
// observations.db.test.ts.
//
// DB test files run one at a time; this one removes its reference rows after each test.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../../__tests__/helpers.js';
import { type Db, withoutUser, withUser } from '../../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);

const box = (x: number, y: number, d: number) => [
	[x, y],
	[x + d, y],
	[x + d, y + d],
	[x, y + d],
	[x, y]
];
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code ?? 'ok';
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

/** A dam polygon in a project, as an editor (the owner) through the API. */
async function dam(u: User, pid: string, name: string, x: number, nodeId: string | null = null): Promise<string> {
	const res = await u.call('POST', `/projects/${pid}/map/features`, { kind: 'dam', name, nodeId, geometry: { type: 'Polygon', coordinates: [box(x, -33.68, 0.002)] } });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feature.id as string;
}

const updatedAt = async (featureId: string) => ((await asOwner('SELECT updated_at FROM map_feature WHERE id = $1', [featureId]))[0] as { updated_at: Date }).updated_at;
const match = (db: Db, featureId: string, status: string, uid: string | null, at: Date, shares: [number, number] | null = uid ? [0.95, 0.9] : null) =>
	db
		.query<{ applied: boolean; dropped: number }>('SELECT applied, dropped FROM app_dam_match_write($1, $2, $3, $4, $5, $6)', [featureId, status, uid, shares?.[0] ?? null, shares?.[1] ?? null, at])
		.then((r) => r.rows[0]!);
const load = (db: Db, source: string, key: string, rows: [string, number, number, string][], at: Date | string = new Date()) =>
	db
		.query<{ written: number; dams: number; applied: boolean }>(
			'SELECT written, dams, applied FROM app_dam_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::text[], $7)',
			[source, key, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), at]
		)
		.then((r) => r.rows[0]!);

let damA: string;
let damB: string;
let damOther: string;

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['Sowner', 'Sviewer', 'Sfarmer', 'Sstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Observed dams (security)' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere dams (security)' })).body.project.id;
	damA = await dam(owner, projectId, 'Dam A', 21.31, farmA.id);
	damB = await dam(owner, projectId, 'Dam B', 21.35, farmB.id);
	damOther = await dam(stranger, otherProjectId, 'Other dam', 21.4);
}, 60_000);

afterEach(async () => {
	await asOwner('DELETE FROM dam_observation');
	await asOwner('DELETE FROM dam_waterbody_match');
	await asOwner('DELETE FROM waterbody_reference');
});
afterAll(async () => {
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

/** Both project dams matched to their own waterbody, and a row of each source loaded for each. */
async function seed() {
	await withoutUser(async (db) => {
		expect((await match(db, damA, 'matched', 'zzzzza0001', await updatedAt(damA))).applied).toBe(true);
		expect((await match(db, damB, 'matched', 'zzzzzb0001', await updatedAt(damB))).applied).toBe(true);
		expect((await match(db, damOther, 'none', null, await updatedAt(damOther))).applied).toBe(true);
		expect(await load(db, 'waterbodies', 'zzzzza0001', [['2020-01-05', 1000, 90, 'zzzzza0001']])).toEqual({ written: 1, dams: 1, applied: true });
		expect(await load(db, 'waterbodies', 'zzzzzb0001', [['2020-01-05', 2000, 100, 'zzzzzb0001']])).toEqual({ written: 1, dams: 1, applied: true });
		for (const f of [damA, damB, damOther]) expect((await load(db, 'wofs', f, [['2020-01-06', 500, 80, 'ga_ls_wofs_synthetic_1']])).written).toBe(1);
	});
}

describe('dam observations: read by the project, written only by the worker', () => {
	it('a viewer reads every dam’s match and observations (positive control); another project’s member, nothing', async () => {
		await seed();
		const seen = await rowsAs<{ feature_id: string; source: string }>(viewer, 'SELECT feature_id, source FROM dam_observation ORDER BY feature_id, source');
		expect(seen.length).toBe(4);
		expect(new Set(seen.map((r) => r.feature_id))).toEqual(new Set([damA, damB]));
		expect((await rowsAs(viewer, 'SELECT feature_id FROM dam_waterbody_match')).length).toBe(2);
		const theirs = await rowsAs<{ feature_id: string }>(stranger, 'SELECT feature_id FROM dam_observation');
		expect(theirs.map((r) => r.feature_id)).toEqual([damOther]);
		expect(await rowsAs(stranger, 'SELECT feature_id FROM dam_observation WHERE project_id = $1', [projectId])).toEqual([]);
		expect(await rowsAs(stranger, 'SELECT feature_id FROM dam_waterbody_match WHERE project_id = $1', [projectId])).toEqual([]);
	});

	it('a farmer reads their own farm’s dam (positive control), never a neighbour’s', async () => {
		await seed();
		const obs = await rowsAs<{ feature_id: string }>(farmer, 'SELECT DISTINCT feature_id FROM dam_observation');
		expect(obs.map((r) => r.feature_id)).toEqual([damA]);
		const m = await rowsAs<{ feature_id: string }>(farmer, 'SELECT feature_id FROM dam_waterbody_match');
		expect(m.map((r) => r.feature_id)).toEqual([damA]);
	});

	it('an applicant (a contributor linked to their farm) reads their own dam’s rows (positive control), never another applicant’s', async () => {
		await seed();
		const [applicantA, applicantB] = (await Promise.all(['Sapplicanta', 'Sapplicantb'].map((n) => signUp(n)))) as [User, User];
		for (const [u, farm] of [
			[applicantA, farmA],
			[applicantB, farmB]
		] as const) {
			expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role: 'contributor' })).status).toBe(201);
			expect((await owner.call('PUT', `/projects/${projectId}/farmers/${u.id}`, { nodeIds: [farm.id] })).status).toBe(200);
		}
		const seen = async (u: User) => (await rowsAs<{ feature_id: string }>(u, 'SELECT DISTINCT feature_id FROM dam_observation ORDER BY feature_id')).map((r) => r.feature_id);
		expect(await seen(applicantA)).toEqual([damA]);
		expect(await seen(applicantB)).toEqual([damB]);
		// Asked for by id, the other applicant's dam is still nothing.
		expect(await rowsAs(applicantA, 'SELECT id FROM dam_observation WHERE feature_id = $1', [damB])).toEqual([]);
		expect(await rowsAs(applicantB, 'SELECT id FROM dam_observation WHERE feature_id = $1', [damA])).toEqual([]);
	});

	it('with no user, RLS shows nothing of the tables themselves', async () => {
		await seed();
		await asOwner(`INSERT INTO waterbody_reference (uid, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_m2, source)
			VALUES ('zzzzzc0001', 'test', '{"type":"Polygon","coordinates":[]}', 21, -34, 21.1, -33.9, 1000, 'test')`);
		expect(await withoutUser(async (db) => (await db.query('SELECT count(*)::int AS n FROM dam_observation')).rows[0].n)).toBe(0);
		expect(await withoutUser(async (db) => (await db.query('SELECT count(*)::int AS n FROM waterbody_reference')).rows[0].n)).toBe(0);
		expect((await rowsAs(viewer, 'SELECT uid FROM waterbody_reference')).length).toBe(1);
	});

	it('water_app can’t write the tables, as a member or the worker', async () => {
		await seed();
		const as = (sql: string) => code(withUser(owner.id, (db) => db.query(sql)));
		expect(await as(`UPDATE dam_observation SET wet_area_m2 = 9`)).toBe('42501');
		expect(await as(`DELETE FROM dam_observation`)).toBe('42501');
		expect(
			await as(
				`INSERT INTO dam_observation (project_id, feature_id, source, obs_date, wet_area_m2, pct_observed, upstream_key) VALUES ('${projectId}', '${damA}', 'wofs', '2021-01-01', 1, 100, 'x')`
			)
		).toBe('42501');
		expect(await as(`UPDATE dam_waterbody_match SET status = 'none', uid = NULL, dam_share = NULL, waterbody_share = NULL`)).toBe('42501');
		expect(await as(`DELETE FROM waterbody_reference`)).toBe('42501');
		expect(await code(withoutUser((db) => db.query(`DELETE FROM dam_observation`)))).toBe('42501');
	});

	it('the worker’s functions refuse a signed-in user, and run with no user (positive control)', async () => {
		const at = await updatedAt(damA);
		expect(await code(withUser(owner.id, (db) => match(db, damA, 'none', null, at)))).toBe('42501');
		expect(await code(withUser(owner.id, (db) => load(db, 'wofs', damA, [['2020-01-01', 1, 100, 'k']])))).toBe('42501');
		expect(await code(withUser(owner.id, (db) => db.query('SELECT * FROM app_dam_outlines()')))).toBe('42501');
		expect(await code(withUser(owner.id, (db) => db.query('SELECT * FROM app_waterbody_candidates(21, -34, 21.5, -33.5)')))).toBe('42501');
		const outlines = await withoutUser(async (db) => (await db.query<{ feature_id: string; match_stale: boolean }>('SELECT feature_id, match_stale FROM app_dam_outlines()')).rows);
		expect(outlines.map((o) => o.feature_id)).toEqual(expect.arrayContaining([damA, damB, damOther]));
		expect(outlines.find((o) => o.feature_id === damA)!.match_stale).toBe(true);
	});
});
