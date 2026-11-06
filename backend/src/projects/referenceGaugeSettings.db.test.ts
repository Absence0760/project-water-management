// The reference gauge's areas (settings.referenceGauge; projects/referenceGaugeSettings.ts): Calibration scales a
// neighbouring river's record by them. Who reads and writes it (project RLS), validation through the API, and that it
// is no model input (saving it alone leaves updatedAt alone, a run doesn't record it). Synthetic data.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function project(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Reference gauge' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}
const ref = { areaKm2: 266, targetAreaKm2: null, name: 'Neighbour weir' };

describe('settings.referenceGauge', () => {
	it('an editor sets it, a viewer reads it but cannot change it, a non-member sees nothing', async () => {
		const owner = await signUp('RefOwner');
		const viewer = await signUp('RefViewer');
		const stranger = await signUp('RefStranger');
		const id = await project(owner);
		expect((await owner.call('POST', `/projects/${id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		// None, from the start.
		expect((await viewer.call('GET', `/projects/${id}`)).body.project.settings.referenceGauge).toBeNull();

		const set = await owner.call('PATCH', `/projects/${id}`, { settings: { referenceGauge: ref } });
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		// Positive control: the viewer reads it.
		expect((await viewer.call('GET', `/projects/${id}`)).body.project.settings.referenceGauge).toEqual(ref);
		expect((await viewer.call('PATCH', `/projects/${id}`, { settings: { referenceGauge: null } })).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${id}`)).status).toBe(404);

		// Taken away whole.
		const off = await owner.call('PATCH', `/projects/${id}`, { settings: { referenceGauge: null } });
		expect(off.body.project.settings.referenceGauge).toBeNull();
	});

	it('refuses a shape that isn’t one, and stores nothing', async () => {
		const u = await signUp('RefShape');
		const id = await project(u);
		for (const bad of [{ areaKm2: 0, targetAreaKm2: null, name: '' }, { areaKm2: 266 }, { ...ref, factor: 0.8 }, 266]) {
			expect((await u.call('PATCH', `/projects/${id}`, { settings: { referenceGauge: bad } })).status, JSON.stringify(bad)).toBe(400);
		}
		expect((await u.call('GET', `/projects/${id}`)).body.project.settings.referenceGauge).toBeNull();
	});

	it('is no model input: updatedAt stays and a run does not record it', async () => {
		const u = await signUp('RefInput');
		const id = await project(u);
		const before = (await u.call('GET', `/projects/${id}`)).body.project;
		// The Settings form sends every setting: the whole document with only the reference gauge changed.
		const res = await u.call('PATCH', `/projects/${id}`, { settings: { ...before.settings, referenceGauge: ref } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.project.updatedAt).toBe(before.updatedAt);

		const run = await u.call('POST', `/projects/${id}/runs`, { label: 'r' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const stored = (await u.call('GET', `/projects/${id}/runs/${run.body.run.id}`)).body.run;
		expect(stored.settings).not.toHaveProperty('referenceGauge');
		// Positive control: the run did record the model's settings.
		expect(stored.settings.apanMm).toEqual(monthly(150));

		// Positive control on updatedAt: a model input does move it.
		const moved = await u.call('PATCH', `/projects/${id}`, { settings: { februaryDays: 28 } });
		expect(moved.body.project.updatedAt).not.toBe(before.updatedAt);
	});
});
