// Farm-scoped access for the `farmer` role (019/020, roadmap WP-2.1, issue
// #24): RLS lets a farmer read their linked farms and nothing about any other
// farm, the farmer-allowed routes answer them only that, and the owner-only
// /farmers routes manage who is linked to what (every other project route
// refusing a farmer is projects/role-ladder.db.test.ts). Every "cannot see" check has
// a positive control: the same farmer sees their own farm, and a viewer sees
// everything.
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User; // linked to farm A
let farmer2: User; // linked to farms B and C
let stranger: User;
let projectId: string;
// Outlet ← A ← B, and C also drains into the outlet.
const outlet = node('Outlet', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', farmA.id);
const farmC = node('Farm C', outlet.id);
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const apples = { id: crypto.randomUUID(), name: 'Apples', cropFactor: monthly(0.8) };
const transferAB = { id: crypto.randomUUID(), fromNodeId: farmA.id, toNodeId: farmB.id, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
const transferBC = { id: crypto.randomUUID(), fromNodeId: farmB.id, toNodeId: farmC.id, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
const patchB = { id: crypto.randomUUID(), nodeId: farmB.id, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null };
const boreholeB = { id: crypto.randomUUID(), nodeId: farmB.id, name: 'BH B1', capacityM3Day: 50, annualCapM3: 15_000, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0.2 };

beforeAll(async () => {
	[owner, viewer, farmer, farmer2, stranger] = (await Promise.all(['Fowner', 'Fviewer', 'Farmer', 'Farmertwo', 'Fstranger'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Farm scope' })).body.project.id;
	const model = {
		nodes: [outlet, farmA, farmB, farmC],
		crops: [citrus, apples],
		cropAreas: [
			{ nodeId: farmA.id, cropId: citrus.id, areaM2: 20_000 },
			{ nodeId: farmB.id, cropId: apples.id, areaM2: 30_000 }
		],
		transfers: [transferAB, transferBC],
		landCover: [patchB],
		boreholes: [boreholeB]
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 40 }, (_, i) => (i % 6 === 0 ? 18 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/runs`, { label: 'scope' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer2.email, nodeIds: [farmB.id, farmC.id] })).status).toBe(201);
});

/** Rows of `sql` as the user, through RLS (water_app with app.current_user_id). */
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
const ids = (rows: { id?: unknown; node_id?: unknown }[], key: 'id' | 'node_id' = 'id') => rows.map((r) => r[key]).sort();

describe('farm-scoped RLS', () => {
	it('lets a farmer read the project row and only their own membership', async () => {
		expect(ids(await rowsAs(farmer, 'SELECT id FROM project WHERE id = $1', [projectId]))).toEqual([projectId]);
		const members = await rowsAs<{ user_id: string; role: string }>(farmer, 'SELECT user_id, role FROM project_member WHERE project_id = $1', [projectId]);
		expect(members).toEqual([{ user_id: farmer.id, role: 'farmer' }]);
		// Positive control: a viewer sees the whole member list.
		expect((await rowsAs(viewer, 'SELECT user_id FROM project_member WHERE project_id = $1', [projectId])).length).toBe(4);
	});

	it('shows a farmer their linked farm and the gauges, never another farm', async () => {
		expect(ids(await rowsAs(farmer, 'SELECT id FROM node WHERE project_id = $1', [projectId]))).toEqual([farmA.id, outlet.id].sort());
		expect(ids(await rowsAs(farmer2, 'SELECT id FROM node WHERE project_id = $1', [projectId]))).toEqual([farmB.id, farmC.id, outlet.id].sort());
		expect((await rowsAs(viewer, 'SELECT id FROM node WHERE project_id = $1', [projectId])).length).toBe(4);
	});

	it('limits crops, crop areas, transfers, land cover and boreholes to the linked farms', async () => {
		expect(ids(await rowsAs(farmer, 'SELECT node_id FROM crop_area WHERE project_id = $1', [projectId]), 'node_id')).toEqual([farmA.id]);
		// Only crops planted on their own farm: Apples (grown only on B) stays hidden.
		expect((await rowsAs(farmer, 'SELECT name FROM crop WHERE project_id = $1', [projectId])).map((r) => r.name)).toEqual(['Citrus']);
		expect(ids(await rowsAs(farmer, 'SELECT id FROM transfer WHERE project_id = $1', [projectId]))).toEqual([transferAB.id]);
		expect(ids(await rowsAs(farmer2, 'SELECT id FROM transfer WHERE project_id = $1', [projectId]))).toEqual([transferAB.id, transferBC.id].sort());
		expect(await rowsAs(farmer, 'SELECT id FROM land_cover WHERE project_id = $1', [projectId])).toEqual([]);
		expect(ids(await rowsAs(farmer2, 'SELECT id FROM land_cover WHERE project_id = $1', [projectId]))).toEqual([patchB.id]);
		// Boreholes (WP-3.9): a neighbour's pumping stays hidden; positive controls, the farm's own farmer and a viewer see it.
		expect(await rowsAs(farmer, 'SELECT id FROM borehole WHERE project_id = $1', [projectId])).toEqual([]);
		expect(ids(await rowsAs(farmer2, 'SELECT id FROM borehole WHERE project_id = $1', [projectId]))).toEqual([boreholeB.id]);
		expect(ids(await rowsAs(viewer, 'SELECT id FROM borehole WHERE project_id = $1', [projectId]))).toEqual([boreholeB.id]);
		expect((await rowsAs(viewer, 'SELECT name FROM crop WHERE project_id = $1', [projectId])).length).toBe(2);
	});

	it('hides runs, run series and time series from a farmer entirely while nothing is published', async () => {
		for (const table of ['model_run', 'run_series', 'time_series']) {
			expect(await rowsAs(farmer, `SELECT 1 FROM ${table} WHERE project_id = $1`, [projectId]), table).toEqual([]);
			expect((await rowsAs(viewer, `SELECT 1 FROM ${table} WHERE project_id = $1`, [projectId])).length, `${table} (viewer)`).toBeGreaterThan(0);
		}
	});

	it('shows a farmer only their own links; viewers see all of them', async () => {
		const own = await rowsAs<{ node_id: string; user_id: string }>(farmer, 'SELECT node_id, user_id FROM farm_link WHERE project_id = $1', [projectId]);
		expect(own).toEqual([{ node_id: farmA.id, user_id: farmer.id }]);
		expect((await rowsAs(viewer, 'SELECT 1 FROM farm_link WHERE project_id = $1', [projectId])).length).toBe(3);
	});

	it('refuses every farmer write', async () => {
		await withUser(farmer.id, async (db) => {
			expect((await db.query('UPDATE node SET name = $2 WHERE id = $1', [farmA.id, 'Renamed'])).rowCount).toBe(0);
			expect((await db.query('DELETE FROM crop_area WHERE node_id = $1', [farmA.id])).rowCount).toBe(0);
			expect((await db.query('DELETE FROM farm_link WHERE node_id = $1', [farmA.id])).rowCount).toBe(0);
		});
		await expect(
			withUser(farmer.id, (db) => db.query(`INSERT INTO node (project_id, name, kind) VALUES ($1, 'Mine now', 'farm')`, [projectId]))
		).rejects.toMatchObject({ code: '42501' });
		await expect(
			withUser(farmer.id, (db) => db.query('INSERT INTO farm_link (project_id, node_id, user_id) VALUES ($1, $2, $3)', [projectId, farmB.id, farmer.id]))
		).rejects.toMatchObject({ code: '42501' });
		expect(ids(await rowsAs(viewer, 'SELECT id FROM node WHERE name = $1 AND project_id = $2', ['Farm A', projectId]))).toEqual([farmA.id]);
	});

	it('only links farm nodes, and only for farmer members', async () => {
		await expect(
			withUser(owner.id, (db) => db.query('INSERT INTO farm_link (project_id, node_id, user_id) VALUES ($1, $2, $3)', [projectId, outlet.id, farmer.id]))
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			withUser(owner.id, (db) => db.query('INSERT INTO farm_link (project_id, node_id, user_id) VALUES ($1, $2, $3)', [projectId, farmB.id, viewer.id]))
		).rejects.toMatchObject({ code: '23514' });
		// Not a member at all (the membership foreign key would refuse it too; the trigger runs first).
		await expect(
			withUser(owner.id, (db) => db.query('INSERT INTO farm_link (project_id, node_id, user_id) VALUES ($1, $2, $3)', [projectId, farmB.id, stranger.id]))
		).rejects.toMatchObject({ code: '23514' });
	});
});

describe('anonymised farm context and the holder count', () => {
	const context = (u: User, nodeId: string) =>
		rowsAs(u, 'SELECT farms_upstream, farms_downstream, farm_count FROM app_farm_context($1, $2)', [projectId, nodeId]);

	it('counts farms up- and downstream for a linked farmer or a viewer, and nobody else', async () => {
		expect(await context(farmer, farmA.id)).toEqual([{ farms_upstream: 1, farms_downstream: 0, farm_count: 3 }]);
		expect(await context(farmer2, farmB.id)).toEqual([{ farms_upstream: 0, farms_downstream: 1, farm_count: 3 }]);
		expect(await context(viewer, farmC.id)).toEqual([{ farms_upstream: 0, farms_downstream: 0, farm_count: 3 }]);
		expect(await context(farmer, farmB.id)).toEqual([]);
		expect(await context(stranger, farmA.id)).toEqual([]);
	});

	it('counts the other holders: farms linked to one user once, unlinked farms on their own', async () => {
		const holders = (u: User) => rowsAs<{ n: number | null }>(u, 'SELECT app_other_farm_holders($1) AS n', [projectId]);
		expect(await holders(farmer)).toEqual([{ n: 1 }]); // B and C are farmer2's: one holder
		expect(await holders(farmer2)).toEqual([{ n: 1 }]); // A is farmer's
		expect(await holders(viewer)).toEqual([{ n: 2 }]); // links nothing: both holders
		expect(await holders(stranger)).toEqual([{ n: null }]);
	});
});

// Which routes admit a farmer (and that every other one refuses them at the
// role check, with a request its validation accepts) is swept in
// projects/role-ladder.db.test.ts (BELOW_VIEWER); these pin what the allowed
// ones answer a farmer.
describe('project routes for a farmer', () => {
	const ZERO = '00000000-0000-4000-8000-000000000000';

	// The farmer-allowed routes answer a farmer: the publication list, their
	// farm index, and 404 (not 403) for a node that isn't theirs, which says
	// nothing about whether it exists. No publication exists in this project.
	it('lets a farmer read the publication and their own farm index, and 404s any other node', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/publication`)).body).toEqual({ current: null, history: [] });
		const index = await farmer.call('GET', `/projects/${projectId}/farm`);
		expect(index.status).toBe(200);
		expect(index.body).toEqual({ project: { id: projectId, name: 'Farm scope' }, farms: [{ nodeId: farmA.id, name: 'Farm A' }], publication: null });
		for (const n of [farmB.id, outlet.id, ZERO]) {
			expect((await farmer.call('GET', `/projects/${projectId}/farm/${n}`)).status, n).toBe(404);
			expect((await farmer.call('GET', `/projects/${projectId}/farm/${n}/export.csv`)).status, n).toBe(404);
		}
		// Their own farm is theirs, but nothing is published yet.
		expect(await farmer.call('GET', `/projects/${projectId}/farm/${farmA.id}`)).toEqual({ status: 404, body: { error: 'not published yet' } });
		// Positive control: a viewer's index lists every farm.
		expect((await viewer.call('GET', `/projects/${projectId}/farm`)).body.farms).toHaveLength(3);
	});

	// Notes admit a farmer; with no farm note on their farm they see none (the scoping itself is notes.db.test.ts).
	it('lets a farmer list notes, empty here, and refuses a note off their farm', async () => {
		expect(await farmer.call('GET', `/projects/${projectId}/notes`)).toEqual({ status: 200, body: { notes: [] } });
		expect((await farmer.call('POST', `/projects/${projectId}/notes`, { body: 'x' })).status).toBe(403);
		expect((await farmer.call('PATCH', `/projects/${projectId}/notes/${ZERO}`, { body: 'x' })).status).toBe(404);
	});

	// Alert events admit a farmer; none have fired in this project.
	it('lets a farmer list alert events, empty here', async () => {
		expect(await farmer.call('GET', `/projects/${projectId}/alert-events`)).toEqual({ status: 200, body: { events: [] } });
	});

	it('lists the project for a farmer with their role and no run or data dates', async () => {
		const mine = (await farmer.call('GET', '/projects')).body.projects;
		expect(mine).toEqual([expect.objectContaining({ id: projectId, role: 'farmer', lastRunAt: null, dataUntil: null })]);
		// Positive control: the viewer's listing has both.
		const theirs = (await viewer.call('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === projectId);
		expect(theirs.lastRunAt).not.toBeNull();
		expect(theirs.dataUntil).not.toBeNull();
	});
});

describe('/farmers', () => {
	it('lists farmers with their farms for viewers and above', async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/farmers`);
		expect(res.status).toBe(200);
		expect(res.body.farmers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ userId: farmer.id, nodeIds: [farmA.id] }),
				expect.objectContaining({ userId: farmer2.id, nodeIds: [farmB.id, farmC.id].sort() })
			])
		);
		expect((await farmer.call('GET', `/projects/${projectId}/farmers`)).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${projectId}/farmers`)).status).toBe(404);
	});

	it('adds only verified accounts, only to farms, only by an owner, and never an existing member', async () => {
		// An unverified account is invited instead (WP-2.2, farms/invites.db.test.ts), not added.
		const later = await signUp('Unverified', { verified: false });
		const invited = await owner.call('POST', `/projects/${projectId}/farmers`, { email: later.email, nodeIds: [farmA.id] });
		expect(invited.status).toBe(201);
		expect(invited.body.invited).toBe(true);
		expect(await rowsAs(later, 'SELECT 1 FROM project WHERE id = $1', [projectId])).toEqual([]);
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: stranger.email, nodeIds: [outlet.id] })).status).toBe(400);
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: viewer.email, nodeIds: [farmA.id] })).status).toBe(409);
		expect((await viewer.call('POST', `/projects/${projectId}/farmers`, { email: stranger.email, nodeIds: [farmA.id] })).status).toBe(403);
		expect((await rowsAs(stranger, 'SELECT 1 FROM project WHERE id = $1', [projectId]))).toEqual([]);
	});

	it('replaces a farmer’s farms, and the change applies to their next transaction', async () => {
		const extra = await signUp('Relinked');
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: extra.email, nodeIds: [farmA.id] })).status).toBe(201);
		expect(ids(await rowsAs(extra, `SELECT id FROM node WHERE project_id = $1 AND kind = 'farm'`, [projectId]))).toEqual([farmA.id]);
		const res = await owner.call('PUT', `/projects/${projectId}/farmers/${extra.id}`, { nodeIds: [farmC.id] });
		expect(res.status).toBe(200);
		expect(res.body.farmer.nodeIds).toEqual([farmC.id]);
		expect(ids(await rowsAs(extra, `SELECT id FROM node WHERE project_id = $1 AND kind = 'farm'`, [projectId]))).toEqual([farmC.id]);
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${viewer.id}`, { nodeIds: [farmC.id] })).status).toBe(404);
	});

	it('keeps links when the model is saved, and drops them when a farm stops being a farm', async () => {
		const other = await signUp('Kindchange');
		const b2 = node('Farm B2', outlet.id);
		const withB2 = { nodes: [outlet, farmA, farmB, farmC, b2], crops: [citrus, apples], cropAreas: [], transfers: [transferAB, transferBC], landCover: [patchB] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, withB2)).status).toBe(200);
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: other.email, nodeIds: [b2.id] })).status).toBe(201);
		// A plain save (the same document again) keeps the link: nodes are upserted by id.
		expect((await owner.call('PUT', `/projects/${projectId}/model`, withB2)).status).toBe(200);
		expect(ids(await rowsAs(other, `SELECT id FROM node WHERE project_id = $1 AND kind = 'farm'`, [projectId]))).toEqual([b2.id]);
		expect(ids(await rowsAs(farmer, `SELECT id FROM node WHERE project_id = $1 AND kind = 'farm'`, [projectId]))).toEqual([farmA.id]);
		// Turned into a water user: unlinked, so the farmer no longer sees it.
		const asUser = { ...withB2, nodes: [outlet, farmA, farmB, farmC, { ...b2, kind: 'user', userDemandM3Day: monthly(10) }] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, asUser)).status).toBe(200);
		expect(await rowsAs(other, 'SELECT id FROM node WHERE project_id = $1 AND id = $2', [projectId, b2.id])).toEqual([]);
		expect(await rowsAs(owner, 'SELECT 1 FROM farm_link WHERE node_id = $1', [b2.id])).toEqual([]);
	});

	it('lets a farmer leave, which removes their links and all access', async () => {
		const leaver = await signUp('Leaver');
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: leaver.email, nodeIds: [farmC.id] })).status).toBe(201);
		expect((await leaver.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBe(204);
		expect(await rowsAs(leaver, 'SELECT 1 FROM node WHERE project_id = $1', [projectId])).toEqual([]);
		expect(await rowsAs(owner, 'SELECT 1 FROM farm_link WHERE user_id = $1', [leaver.id])).toEqual([]);
		// A farmer may not remove anyone else.
		expect((await farmer.call('DELETE', `/projects/${projectId}/members/${farmer2.id}`)).status).toBe(403);
	});
});
