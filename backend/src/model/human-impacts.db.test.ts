// Human impacts on the model document (roadmap WP-1.33 …): they are stored,
// read back, validated and reach a run. Needs Postgres (pnpm dev:db:up).
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function project(u: User, name: string) {
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id as string;
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? 20 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}

describe('other water users (WP-1.33)', () => {
	it('stores a user node, reads it back, runs it, and refuses crops, transfers and a bad demand on it', async () => {
		const u = await signUp('Town');
		const projectId = await project(u, 'With a town');
		const outlet = node('Outlet', null);
		const town = node('Town', outlet.id, { kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: monthly(250), userReturnPct: 0.4, userPriority: 'junior' });
		const farm = node('Upper', town.id);
		const model = { nodes: [outlet, town, farm], crops: [], cropAreas: [], transfers: [] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.find((n) => n.id === town.id)).toMatchObject({ kind: 'user', userDemandM3Day: monthly(250), userReturnPct: 0.4, userPriority: 'junior' });
		// A farm keeps the inert defaults.
		expect(got.find((n) => n.id === farm.id)).toMatchObject({ kind: 'farm', userDemandM3Day: null, userReturnPct: 0, userPriority: 'senior' });

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'with town' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.users).toHaveLength(1);
		expect(summary.users[0]).toMatchObject({ nodeId: town.id, priority: 'junior', avgDemandM3Day: 250 });
		expect(summary.verification.passed).toBe(true);
		const keys = (await asOwner('SELECT key FROM run_series WHERE run_id = $1 AND node_id = $2 ORDER BY key', [run.body.run.id, town.id])).map((r) => r.key);
		expect(keys).toEqual(expect.arrayContaining(['demand', 'supplied', 'return_flow', 'outflow', 'ewr_charge']));

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		await bad({ ...model, crops: [crop], cropAreas: [{ nodeId: town.id, cropId: crop.id, areaM2: 1000 }] }, /other water user/);
		const tr = { id: crypto.randomUUID(), fromNodeId: farm.id, toNodeId: town.id, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
		await bad({ ...model, transfers: [tr] }, /other water user/);
		await bad({ ...model, nodes: [outlet, { ...town, userDemandM3Day: [1, 2, 3] }, farm] }, /userDemandM3Day/);
		await bad({ ...model, nodes: [outlet, { ...town, userDemandM3Day: monthly(-1) }, farm] }, /userDemandM3Day/);
		await bad({ ...model, nodes: [outlet, { ...town, userPriority: 'first' }, farm] }, /userPriority/);
		// The database refuses a malformed demand even past the API.
		await expect(asOwner('UPDATE node SET user_demand_m3_day = $2 WHERE id = $1', [town.id, [1, 2]])).rejects.toThrow(/check/i);
	});

	it('reads a model saved before the user fields (older document) as having none', async () => {
		const u = await signUp('Older');
		const projectId = await project(u, 'Older doc');
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id);
		// No user fields at all: the API fills the inert defaults.
		expect((await u.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.every((n) => n.userDemandM3Day === null && n.userReturnPct === 0 && n.userPriority === 'senior')).toBe(true);
	});
});
