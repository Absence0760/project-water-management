import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** A small runnable catchment: outlet gauge + one farm with a crop, rain and observed flow. */
async function runnableProject(owner: User, name = 'Catchment C') {
	const { body } = await owner.call('POST', '/projects', { name });
	const projectId = body.project.id as string;
	const outlet = node('Gauge', null);
	const farm = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect(
		(await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain }))
			.status
	).toBe(200);
	expect(
		(
			await owner.call('PUT', `/projects/${projectId}/series`, {
				kind: 'flow_observed_m3s',
				unit: 'm3/s',
				startDate: '2020-01-01',
				values: new Array(days).fill(0.2)
			})
		).status
	).toBe(200);
	return { projectId, model, farm };
}

async function run(u: User, projectId: string, label: string) {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}

const compare = (u: User, a: string, b: string) => u.call('GET', `/compare/runs?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);

describe('GET /compare/runs', () => {
	it('compares two runs of one project: results, inputs snapshot and what changed', async () => {
		const u = await signUp('Hydro');
		const { projectId, model } = await runnableProject(u);
		const base = await run(u, projectId, 'Baseline');
		const raised = structuredClone(model);
		raised.nodes[1]!.damCapacityM3 = 150_000;
		expect((await u.call('PUT', `/projects/${projectId}/model`, raised)).status).toBe(200);
		const dam = await run(u, projectId, 'Dam raise');

		const res = await compare(u, `${projectId}:${base}`, `${projectId}:${dam}`);
		expect(res.status).toBe(200);
		expect(res.body.a.project).toEqual({ id: projectId, name: 'Catchment C' });
		expect(res.body.a.run).toMatchObject({ id: base, label: 'Baseline', startDate: '2020-01-01', endDate: '2020-02-29' });
		expect(res.body.b.run.label).toBe('Dam raise');
		// The stored inputs snapshot is exposed here (and only here).
		expect(res.body.a.run.inputs.model.nodes[1].damCapacityM3).toBe(100_000);
		expect(res.body.b.run.inputs.series.rain_catchment_mm).toEqual({ startDate: '2020-01-01', length: 60 });
		expect(res.body.b.run.summary.farms[0].name).toBe('Rooikloof');
		expect(res.body.changes).toEqual([
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 100,000 m³ → 150,000 m³' }
		]);
		expect(res.body.comparison.samePeriod).toBe(true);
		expect(res.body.comparison.farms).toHaveLength(1);
		expect(res.body.comparison.farms[0].name).toBe('Rooikloof');
		expect(res.body.comparison.calibration).not.toBeNull();
		expect(res.body.catchmentSeries.map((s: { key: string }) => s.key)).toEqual(
			expect.arrayContaining(['natural_flow', 'simulated_outflow', 'observed_flow', 'ewr'])
		);

		// The run's own detail endpoint still doesn't return inputs.
		expect((await u.call('GET', `/projects/${projectId}/runs/${base}`)).body.run.inputs).toBeUndefined();
	});

	it('compares runs across a copied project, matching farms by name', async () => {
		const u = await signUp('Copier');
		const { projectId: c } = await runnableProject(u);
		const baseC = await run(u, c, 'C baseline');
		const copy = await u.call('POST', `/projects/${c}/copy`, { name: 'Catchment D' });
		const d = copy.body.project.id as string;
		const modelD = (await u.call('GET', `/projects/${d}/model`)).body;
		const farmD = modelD.nodes.find((n: { name: string }) => n.name === 'Rooikloof');
		const apples = { id: crypto.randomUUID(), name: 'Apples', cropFactor: monthly(0.9) };
		modelD.crops.push(apples);
		modelD.cropAreas.push({ nodeId: farmD.id, cropId: apples.id, areaM2: 400_000 });
		expect((await u.call('PUT', `/projects/${d}/model`, modelD)).status).toBe(200);
		const runD = await run(u, d, 'D apples');

		const res = await compare(u, `${c}:${baseC}`, `${d}:${runD}`);
		expect(res.status).toBe(200);
		expect(res.body.b.project.name).toBe('Catchment D');
		const f = res.body.comparison.farms[0];
		expect(f.name).toBe('Rooikloof');
		expect(f.nodeIdA).not.toBe(f.nodeIdB);
		expect(res.body.comparison.onlyInA).toEqual([]);
		expect(res.body.comparison.onlyInB).toEqual([]);
		expect(res.body.changes.map((x: { text: string }) => x.text)).toEqual([
			'Crop "Apples" added',
			'Crop "Apples" added to Rooikloof (40 ha)'
		]);
	});

	it('returns 404 when either side is not visible, 200 for a viewer of both', async () => {
		const owner = await signUp('Owner');
		const other = await signUp('Other');
		const viewer = await signUp('Viewer');
		const { projectId: p1 } = await runnableProject(owner, 'P1');
		const r1 = await run(owner, p1, 'one');
		const { projectId: p2 } = await runnableProject(other, 'P2');
		const r2 = await run(other, p2, 'two');

		// Positive control: the owner sees their own comparison.
		expect((await compare(owner, `${p1}:${r1}`, `${p1}:${r1}`)).status).toBe(200);
		// A stranger sees neither side.
		expect((await compare(other, `${p1}:${r1}`, `${p1}:${r1}`)).status).toBe(404);
		// One visible side is not enough, in either position.
		expect((await compare(owner, `${p1}:${r1}`, `${p2}:${r2}`)).status).toBe(404);
		expect((await compare(other, `${p1}:${r1}`, `${p2}:${r2}`)).status).toBe(404);

		// A viewer on both projects can compare across them.
		expect((await owner.call('POST', `/projects/${p1}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await compare(viewer, `${p1}:${r1}`, `${p2}:${r2}`)).status).toBe(404);
		expect((await other.call('POST', `/projects/${p2}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const ok = await compare(viewer, `${p1}:${r1}`, `${p2}:${r2}`);
		expect(ok.status).toBe(200);
		expect(ok.body.b.project.name).toBe('P2');
	});

	it('404s a run named under the wrong project, 400s a malformed reference', async () => {
		const u = await signUp('Mixer');
		const { projectId: p1 } = await runnableProject(u, 'M1');
		const { projectId: p2 } = await runnableProject(u, 'M2');
		const r2 = await run(u, p2, 'two');
		expect((await compare(u, `${p1}:${r2}`, `${p2}:${r2}`)).status).toBe(404);
		expect((await compare(u, `${p1}:not-a-uuid`, `${p2}:${r2}`)).status).toBe(404);
		expect((await compare(u, p1, `${p2}:${r2}`)).status).toBe(400);
		expect((await u.call('GET', `/compare/runs?a=${p2}:${r2}`)).status).toBe(400);
	});
});
