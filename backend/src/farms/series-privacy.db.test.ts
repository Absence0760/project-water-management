// Two farms in a line (design docs/design/farmer-view.md §10.3, issue #24):
// the downstream farm's inflow from upstream *is* the upstream farm's daily
// outflow, so a farmer who could read it would see exactly when their
// neighbour pumps and stores. The positive control shows the leak is real for
// a viewer (Down's inflow_upstream equals Up's outflow); the farmer on Down
// gets no series, and no response, that carries it or names Up.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let farmer: User; // linked to Down only
let projectId: string;
const outlet = node('Outlet weir', null);
const down = node('Lower farm', outlet.id, { damCapacityM3: 50_000, pctUpstreamToDam: 0 });
const up = node('Upper neighbour', down.id, { damCapacityM3: 80_000 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

beforeAll(async () => {
	[owner, farmer] = (await Promise.all([signUp('Lineowner'), signUp('Linefarmer')])) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Two in a line' })).body.project.id;
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
	const rain = Array.from({ length: 500 }, (_, i) => (i % 7 === 0 ? 30 : i % 3 === 0 ? 4 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'line' });
	expect(run.status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId: run.body.run.id })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [down.id] })).status).toBe(201);
}, 60_000);

describe('two farms in a line', () => {
	it('the downstream farm’s inflow really is the upstream farm’s outflow (positive control, as a viewer-level owner)', async () => {
		const [upOut] = await rowsAs<{ values: number[] }>(owner, `SELECT "values" FROM run_series WHERE node_id = $1 AND key = 'outflow'`, [up.id]);
		const [downIn] = await rowsAs<{ values: number[] }>(owner, `SELECT "values" FROM run_series WHERE node_id = $1 AND key = 'inflow_upstream'`, [down.id]);
		expect(upOut!.values.some((v) => v > 0)).toBe(true);
		expect(downIn!.values).toEqual(upOut!.values);
	});

	it('gives the downstream farmer only their own allowlisted series, none equal to the neighbour’s outflow', async () => {
		const [upOut] = await rowsAs<{ values: number[] }>(owner, `SELECT "values" FROM run_series WHERE node_id = $1 AND key = 'outflow'`, [up.id]);
		const mine = await rowsAs<{ node_id: string | null; key: string; values: number[] }>(farmer, 'SELECT node_id, key, "values" FROM run_series WHERE project_id = $1', [projectId]);
		// Positive control: the farmer does read their own farm's series.
		expect(mine.map((r) => r.key).sort()).toEqual(expect.arrayContaining(['demand', 'dam_storage', 'supplied']));
		expect(new Set(mine.map((r) => r.node_id))).toEqual(new Set([down.id]));
		expect(mine.map((r) => r.key)).not.toContain('inflow_upstream');
		for (const r of mine) expect(r.values, r.key).not.toEqual(upOut!.values);
	});

	it('never names the upstream farm or gives its id in any farm response', async () => {
		const get = async (path: string) => {
			const r = await app.request(path, { headers: { cookie: farmer.cookie, origin: 'http://localhost:7777' } });
			expect(r.status, path).toBe(200);
			return r.text();
		};
		for (const path of [`/projects/${projectId}/farm`, `/projects/${projectId}/farm/${down.id}`, `/projects/${projectId}/farm/${down.id}/export.csv`, '/projects']) {
			const text = await get(path);
			expect(text, path).not.toContain(up.id);
			expect(text, path).not.toContain(up.name);
		}
		// Positive control: the farmer's own farm is named.
		expect(await get(`/projects/${projectId}/farm/${down.id}`)).toContain(down.name);
	});
});

describe('who can see my farm', () => {
	it('lists the people who can read the farm, by name and role, never an email, and nobody else asks', async () => {
		const neighbour = await signUp('Neighbourfarmer');
		const staff = await signUp('Wuastaff');
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: neighbour.email, nodeIds: [up.id] })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: staff.email, role: 'viewer' })).status).toBe(201);

		const res = await farmer.call('GET', `/projects/${projectId}/farm/${down.id}/access`);
		expect(res.status).toBe(200);
		const byName = new Map(res.body.people.map((p: { displayName: string; role: string; you: boolean }) => [p.displayName, p]));
		expect(byName.get('Linefarmer')).toEqual({ displayName: 'Linefarmer', role: 'farmer', you: true });
		expect(byName.get('Lineowner')).toMatchObject({ role: 'owner', you: false });
		expect(byName.get('Wuastaff')).toMatchObject({ role: 'viewer' });
		// The farmer on the other farm can't see this one, so isn't listed; nor is any email.
		expect(byName.has('Neighbourfarmer')).toBe(false);
		expect(JSON.stringify(res.body)).not.toMatch(/@example\.com/);
		// The neighbour may not ask about this farm; a viewer may.
		expect((await neighbour.call('GET', `/projects/${projectId}/farm/${down.id}/access`)).status).toBe(404);
		expect((await staff.call('GET', `/projects/${projectId}/farm/${down.id}/access`)).status).toBe(200);
	});
});
