// Security regressions for observed actual ET (277_et_observation, issue
// #623): who reads et_observation (a project's members and its farmers, each
// farmer only their own units; every "cannot see" with its positive
// control), that only the worker's functions, with no user, write it, and
// that the load marks are the owner's alone. The functions' behaviour is
// observations.db.test.ts.
//
// DB test files run one at a time; this one removes its rows after each test.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../../__tests__/helpers.js';
import { type Db, withoutUser, withUser } from '../../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let neighbour: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
const otherOutlet = node('Other weir', null);
const farmOther = node('Other farm', otherOutlet.id);

const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code ?? 'ok';
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

const parcel = async (u: User, pid: string, nodeId: string, x: number) => {
	const geometry = { type: 'Polygon', coordinates: [[[x, -33.7], [x + 0.01, -33.7], [x + 0.01, -33.69], [x, -33.69], [x, -33.7]]] };
	const res = await u.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: 'Parcel', nodeId, geometry });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
};

/** One dekad of WaPOR for a unit, as the worker loads it. */
const load = (db: Db, nodeId: string, eta = 4.2) =>
	db
		.query<{ written: number; applied: boolean }>(
			`SELECT written, applied FROM app_et_observation_load('wapor', $1, ARRAY['2024-01-11']::date[], ARRAY[$2]::float8[], ARRAY[0.98]::float8[],
				ARRAY[120000]::float8[], 'parcel', ARRAY['WAPOR-3.L2-AETI-D.2024-01-D2.tif'], ARRAY['"e1"'], 'WAPOR-3', now())`,
			[nodeId, eta]
		)
		.then((r) => r.rows[0]!);

beforeAll(async () => {
	[owner, viewer, farmer, neighbour, stranger] = (await Promise.all(['Eowner', 'Eviewer', 'Efarmer', 'Eneighbour', 'Estranger'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Observed ET (security)' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: neighbour.email, nodeIds: [farmB.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere ET (security)' })).body.project.id;
	expect((await stranger.call('PUT', `/projects/${otherProjectId}/model`, { nodes: [otherOutlet, farmOther], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	await parcel(owner, projectId, farmA.id, 21.3);
	await parcel(owner, projectId, farmB.id, 21.32);
	await parcel(stranger, otherProjectId, farmOther.id, 21.4);
}, 60_000);

afterEach(async () => {
	await asOwner('DELETE FROM et_observation');
	await asOwner('DELETE FROM et_observation_load_mark');
});
afterAll(async () => {
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

async function seed() {
	await withoutUser(async (db) => {
		for (const n of [farmA.id, farmB.id, farmOther.id]) expect(await load(db, n)).toEqual({ written: 1, applied: true });
	});
}

describe('observed ET: read by the project, written only by the worker', () => {
	it('a viewer reads every unit’s rows (positive control); another project’s member reads only their own', async () => {
		await seed();
		const seen = await rowsAs<{ node_id: string }>(viewer, 'SELECT node_id FROM et_observation');
		expect(new Set(seen.map((r) => r.node_id))).toEqual(new Set([farmA.id, farmB.id]));
		const theirs = await rowsAs<{ node_id: string }>(stranger, 'SELECT node_id FROM et_observation');
		expect(theirs.map((r) => r.node_id)).toEqual([farmOther.id]);
		expect(await rowsAs(stranger, 'SELECT id FROM et_observation WHERE project_id = $1', [projectId])).toEqual([]);
	});

	it('a farmer reads their own unit’s rows (positive control), never a neighbour’s, even asked by id', async () => {
		await seed();
		expect((await rowsAs<{ node_id: string }>(farmer, 'SELECT node_id FROM et_observation')).map((r) => r.node_id)).toEqual([farmA.id]);
		expect((await rowsAs<{ node_id: string }>(neighbour, 'SELECT node_id FROM et_observation')).map((r) => r.node_id)).toEqual([farmB.id]);
		expect(await rowsAs(farmer, 'SELECT id FROM et_observation WHERE node_id = $1', [farmB.id])).toEqual([]);
	});

	it('with no user, RLS shows nothing of the table itself', async () => {
		await seed();
		expect(await withoutUser(async (db) => (await db.query('SELECT count(*)::int AS n FROM et_observation')).rows[0].n)).toBe(0);
		// Positive control: the rows are there for the owner.
		expect((await asOwner('SELECT count(*)::int AS n FROM et_observation'))[0].n).toBe(3);
	});

	it('refuses every direct write as water_app, even to an owner (42501)', async () => {
		await seed();
		const [row] = await asOwner('SELECT id FROM et_observation WHERE node_id = $1', [farmA.id]);
		for (const sql of [
			`INSERT INTO et_observation (project_id, node_id, source, dekad, eta_mm_day, valid_share, area_m2, mask, upstream_file, upstream_version)
			 VALUES ('${projectId}', '${farmA.id}', 'wapor', '2024-02-01', 1, 1, 1, 'parcel', 'f', 'v')`,
			`UPDATE et_observation SET eta_mm_day = 9 WHERE id = '${row!.id}'`,
			`DELETE FROM et_observation WHERE id = '${row!.id}'`
		]) {
			expect(await code(withUser(owner.id, (db) => db.query(sql))), sql).toBe('42501');
		}
		expect((await asOwner('SELECT eta_mm_day FROM et_observation WHERE id = $1', [row!.id]))[0].eta_mm_day).toBe(4.2);
	});

	it('refuses the worker’s functions to a signed-in user, the owner included (42501); the worker (positive control) runs them', async () => {
		expect(await code(withUser(owner.id, (db) => load(db, farmA.id)))).toBe('42501');
		expect(await code(withUser(owner.id, (db) => db.query('SELECT * FROM app_et_load_marks()')))).toBe('42501');
		expect(await code(withUser(owner.id, (db) => db.query(`SELECT applied FROM app_et_load_mark_write('wapor', $1, now(), now(), false)`, [farmA.id])))).toBe('42501');
		expect((await withoutUser((db) => load(db, farmA.id))).applied).toBe(true);
		expect(await withoutUser(async (db) => (await db.query(`SELECT applied FROM app_et_load_mark_write('wapor', $1, now(), now(), false)`, [farmA.id])).rows[0].applied)).toBe(true);
	});

	it('keeps the load marks from water_app altogether, the worker’s own session included (42501)', async () => {
		await withoutUser((db) => db.query(`SELECT applied FROM app_et_load_mark_write('wapor', $1, now(), now(), false)`, [farmA.id]));
		expect(await code(withoutUser((db) => db.query('SELECT * FROM et_observation_load_mark')))).toBe('42501');
		expect(await code(withUser(owner.id, (db) => db.query('SELECT * FROM et_observation_load_mark')))).toBe('42501');
		// Positive control: the mark is there, and its function reads it.
		expect(await withoutUser(async (db) => (await db.query('SELECT node_id FROM app_et_load_marks()')).rows.map((r) => r.node_id))).toContain(farmA.id);
	});
});
