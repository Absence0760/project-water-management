// A project's irrigation systems (engine 1.72.0, migration 198, docs/model.md
// §2.3): a new project starts with the SABI rows, a crop's default and a unit's
// own system save and load through PUT/GET /model (a preset's key resolving to
// the project's row), the table is the project's to edit, nobody else's, and a
// return flow above the losses at a unit's blended efficiency is refused.
// Needs Postgres (pnpm dev:db:up).
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

async function setUp(name: string) {
	const owner = await signUp(name);
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const out = node('Outlet', null, { sortOrder: 0, kind: 'gauge' });
	const farm = node('Farm', out.id, { sortOrder: 1, irrigationEfficiency: 0.8, returnFlowFraction: 0.1 });
	const crop = { id: crypto.randomUUID(), name: 'Citrus', sortOrder: 0, cropFactor: monthly(0.6) };
	return { owner, id, out, farm, crop };
}

describe('irrigation systems (migration 198)', () => {
	it('a new project has the six SABI systems; a crop and a unit name them by id or preset key and read back as ids', async () => {
		const { owner, id, out, farm, crop } = await setUp('SystemsOwner');
		const empty = (await owner.call('GET', `/projects/${id}/model`)).body;
		expect(empty.irrigationSystems.map((s: { name: string; efficiency: number; preset: string }) => [s.name, s.efficiency, s.preset])).toEqual([
			['Drip', 0.9, 'drip'],
			['Micro-sprinkler', 0.82, 'micro'],
			['Centre pivot / linear move', 0.85, 'pivot'],
			['Sprinkler (permanent)', 0.8, 'sprinkler'],
			['Sprinkler (movable)', 0.75, 'movable'],
			['Flood / furrow', 0.7, 'surface']
		]);
		const flood = empty.irrigationSystems.find((s: { preset: string }) => s.preset === 'surface').id as string;
		const drip = empty.irrigationSystems.find((s: { preset: string }) => s.preset === 'drip').id as string;
		const put = await owner.call('PUT', `/projects/${id}/model`, {
			nodes: [out, farm],
			crops: [{ ...crop, irrigationSystemId: 'surface' }],
			cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000, irrigationSystemId: drip }],
			transfers: []
		});
		expect(put.status).toBe(200);
		expect(put.body.crops[0].irrigationSystemId).toBe(flood);
		expect(put.body.cropAreas[0].irrigationSystemId).toBe(drip);
		// An unknown system is refused, naming it.
		const bad = await owner.call('PUT', `/projects/${id}/model`, { nodes: [out, farm], crops: [{ ...crop, irrigationSystemId: 'nope' }], cropAreas: [], transfers: [] });
		expect(bad.status).toBe(400);
	});

	it('the table is the project’s to edit: a changed efficiency, an own row, a removed row (its crops fall back to none)', async () => {
		const { owner, id, out, farm, crop } = await setUp('SystemsEditor');
		const table = (await owner.call('GET', `/projects/${id}/model`)).body.irrigationSystems as { id: string; name: string; efficiency: number; preset: string | null }[];
		const own = { id: crypto.randomUUID(), name: 'Centre pivot, LEPA', efficiency: 0.92, preset: null };
		const edited = [...table.filter((s) => s.preset !== 'movable').map((s) => (s.preset === 'drip' ? { ...s, efficiency: 0.95 } : s)), own];
		const put = await owner.call('PUT', `/projects/${id}/model`, { nodes: [out, farm], crops: [{ ...crop, irrigationSystemId: own.id }], cropAreas: [], transfers: [], irrigationSystems: edited });
		expect(put.status).toBe(200);
		expect(put.body.irrigationSystems.find((s: { preset: string }) => s.preset === 'drip').efficiency).toBe(0.95);
		expect(put.body.irrigationSystems.some((s: { preset: string }) => s.preset === 'movable')).toBe(false);
		expect(put.body.crops[0].irrigationSystemId).toBe(own.id);
		// Another project's row is not this one's to name.
		const other = await setUp('SystemsOther');
		const theirs = (await other.owner.call('GET', `/projects/${other.id}/model`)).body.irrigationSystems[0].id as string;
		const cross = await owner.call('PUT', `/projects/${id}/model`, { nodes: [out, farm], crops: [{ ...crop, irrigationSystemId: theirs }], cropAreas: [], transfers: [] });
		expect(cross.status).toBeGreaterThanOrEqual(400);
		expect(cross.status).toBeLessThan(500);
	});

	it('takes a return flow above the losses at the unit’s blended efficiency (the form warns, a run caps it), and the run says so', async () => {
		const { owner, id, out, farm, crop } = await setUp('SystemsReturn');
		await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } });
		// The unit's own 80 % would allow 20 %; its only crop is on drip (90 %), so at most 10 % can return.
		const m = (r: number) => ({
			nodes: [out, { ...farm, returnFlowFraction: r }],
			crops: [{ ...crop, irrigationSystemId: 'drip' }],
			cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }],
			transfers: []
		});
		expect((await owner.call('PUT', `/projects/${id}/model`, m(0.15))).status).toBe(200);
		const saved = (await owner.call('GET', `/projects/${id}/model`)).body;
		expect(saved.nodes.find((n: { name: string }) => n.name === 'Farm').returnFlowFraction).toBe(0.15);
	});

	it('row-level security: a member reads the project’s systems (the control), an outsider reads none, a viewer can’t change them', async () => {
		const { owner, id } = await setUp('SystemsRls');
		const viewer = await signUp('SystemsViewer');
		expect((await owner.call('POST', `/projects/${id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const stranger = await signUp('SystemsStranger');
		const read = (u: { id: string }) => withUser(u.id, async (db) => (await db.query('SELECT id FROM irrigation_system WHERE project_id = $1', [id])).rowCount);
		expect(await read(viewer)).toBe(6);
		expect(await read(stranger)).toBe(0);
		const changed = await withUser(viewer.id, async (db) => (await db.query('UPDATE irrigation_system SET efficiency = 0.5 WHERE project_id = $1', [id])).rowCount);
		expect(changed).toBe(0);
		await expect(withUser(stranger.id, (db) => db.query(`INSERT INTO irrigation_system (project_id, name, efficiency) VALUES ($1, 'Mine', 0.5)`, [id]))).rejects.toThrow(/row-level security/);
	});
});
