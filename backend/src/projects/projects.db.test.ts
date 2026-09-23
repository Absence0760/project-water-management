import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

async function projectWithModel(owner: Awaited<ReturnType<typeof signUp>>, name = 'Catchment A') {
	const { body } = await owner.call('POST', '/projects', { name });
	const outlet = node('Gauge', null);
	const farm = node('Farm 1', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = {
		nodes: [outlet, farm],
		crops: [crop],
		cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }],
		transfers: []
	};
	const saved = await owner.call('PUT', `/projects/${body.project.id}/model`, model);
	expect(saved.status).toBe(200);
	return { projectId: body.project.id as string, model, outlet, farm, crop };
}

describe('projects', () => {
	it('creates a project with the creator as owner and default settings', async () => {
		const u = await signUp('Owner');
		const res = await u.call('POST', '/projects', { name: 'Client Catchment', description: 'Example region' });
		expect(res.status).toBe(201);
		expect(res.body.project).toMatchObject({ name: 'Client Catchment', role: 'owner' });
		expect(res.body.project.settings.effectiveRainFraction).toBe(0.65);
		const list = await u.call('GET', '/projects');
		expect(list.body.projects.map((p: { name: string }) => p.name)).toContain('Client Catchment');
	});

	it('hides other users’ projects entirely (404, not 403)', async () => {
		const a = await signUp('A');
		const b = await signUp('B');
		const { projectId } = await projectWithModel(a);
		expect((await b.call('GET', '/projects')).body.projects).toHaveLength(0);
		for (const [m, p] of [
			['GET', `/projects/${projectId}`],
			['GET', `/projects/${projectId}/model`],
			['GET', `/projects/${projectId}/series`],
			['GET', `/projects/${projectId}/runs`],
			['DELETE', `/projects/${projectId}`]
		] as const) {
			expect((await b.call(m, p)).status, `${m} ${p}`).toBe(404);
		}
	});

	it('merges settings patches over defaults and keeps unknown engine keys', async () => {
		const u = await signUp('S');
		const { body } = await u.call('POST', '/projects', { name: 'S' });
		const id = body.project.id;
		const res = await u.call('PATCH', `/projects/${id}`, {
			settings: { effectiveRainFraction: 0.5, calibration: { a: 0.12, recessionTable: [1, 2] } }
		});
		expect(res.status).toBe(200);
		expect(res.body.project.settings.effectiveRainFraction).toBe(0.5);
		expect(res.body.project.settings.calibration.a).toBe(0.12);
		expect(res.body.project.settings.calibration.b).toBe(1.2); // default kept
		expect(res.body.project.settings.calibration.recessionTable).toEqual([1, 2]);
		expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: [1, 2] } })).status).toBe(400);
	});

	it('stores the calibration window and flow series, and rejects bad values', async () => {
		const u = await signUp('W');
		const { body } = await u.call('POST', '/projects', { name: 'W' });
		const id = body.project.id;
		expect(body.project.settings).toMatchObject({ calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null });
		const ok = await u.call('PATCH', `/projects/${id}`, {
			settings: { calibrationStart: '2010-10-01', calibrationEnd: '2018-09-30', calibrationFlowKind: 'flow_logger_m3s' }
		});
		expect(ok.status).toBe(200);
		expect(ok.body.project.settings).toMatchObject({ calibrationStart: '2010-10-01', calibrationFlowKind: 'flow_logger_m3s' });
		for (const settings of [{ calibrationStart: '1/10/2010' }, { calibrationEnd: 20180930 }, { calibrationFlowKind: 'rain_catchment_mm' }]) {
			expect((await u.call('PATCH', `/projects/${id}`, { settings })).status, JSON.stringify(settings)).toBe(400);
		}
	});

	it('scores a run over the calibration window and stores the EWR compliance grid', async () => {
		const u = await signUp('R');
		const { projectId } = await projectWithModel(u);
		const days = 400; // 2020-09-01 … 2021-10-05: three water years
		const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
		const observed = Array.from({ length: days }, (_, i) => 0.5 + (i % 30) / 30);
		await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-09-01', values: rain });
		await u.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-09-01', values: observed });
		await u.call('PATCH', `/projects/${projectId}`, {
			settings: { calibrationStart: '2020-10-01', calibrationEnd: '2021-09-30', ewrPragmaticM3PerDay: monthly(50_000) }
		});
		const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'window' });
		expect(res.status).toBe(201);
		const { calibration, ewrCompliance } = res.body.run.summary;
		expect(calibration).toMatchObject({ days: 365, windowStart: '2020-10-01', windowEnd: '2021-09-30', flowKind: 'flow_observed_m3s' });
		expect(calibration.annualVolumes).toHaveLength(1);
		expect(ewrCompliance.waterYears).toEqual([2019, 2020, 2021]);
		expect(ewrCompliance.farms).toHaveLength(1);
		expect(ewrCompliance.days.flat().reduce((a: number, b: number) => a + b, 0)).toBe(days);
	});

	it('round-trips the model document and rejects invalid networks', async () => {
		const u = await signUp('M');
		const { projectId, model } = await projectWithModel(u);
		const got = await u.call('GET', `/projects/${projectId}/model`);
		expect(got.body.nodes).toHaveLength(2);
		expect(got.body.cropAreas).toEqual(model.cropAreas);

		const loop = structuredClone(model);
		loop.nodes[0]!.downstreamNodeId = loop.nodes[1]!.id; // outlet → farm → outlet
		const bad = await u.call('PUT', `/projects/${projectId}/model`, loop);
		expect(bad.status).toBe(400);
		expect(bad.body.details.join(' ')).toMatch(/outflow|loop/);
	});

	it('supports swapping two node names in one save and deletes removed rows', async () => {
		const u = await signUp('Swap');
		const { projectId, model } = await projectWithModel(u);
		const m = structuredClone(model);
		[m.nodes[0]!.name, m.nodes[1]!.name] = [m.nodes[1]!.name, m.nodes[0]!.name];
		expect((await u.call('PUT', `/projects/${projectId}/model`, m)).status).toBe(200);
		m.crops = [];
		m.cropAreas = [];
		const res = await u.call('PUT', `/projects/${projectId}/model`, m);
		expect(res.body.crops).toHaveLength(0);
	});

	it('refuses to adopt ids that belong to another project', async () => {
		const a = await signUp('IdA');
		const { model } = await projectWithModel(a, 'A1');
		const { body } = await a.call('POST', '/projects', { name: 'A2' });
		const res = await a.call('PUT', `/projects/${body.project.id}/model`, model);
		expect(res.status).toBe(409);
	});

	it('copies a project with fresh ids and its series, owned by the copier', async () => {
		const a = await signUp('Copy');
		const { projectId } = await projectWithModel(a);
		await a.call('PUT', `/projects/${projectId}/series`, {
			kind: 'rain_catchment_mm',
			unit: 'mm',
			startDate: '2020-01-01',
			values: [0, 1.5, null, 3]
		});
		const copy = await a.call('POST', `/projects/${projectId}/copy`, { name: 'Catchment D' });
		expect(copy.status).toBe(201);
		const orig = (await a.call('GET', `/projects/${projectId}/model`)).body;
		const dup = (await a.call('GET', `/projects/${copy.body.project.id}/model`)).body;
		expect(dup.nodes.map((n: { name: string }) => n.name).sort()).toEqual(orig.nodes.map((n: { name: string }) => n.name).sort());
		expect(dup.nodes.map((n: { id: string }) => n.id)).not.toContain(orig.nodes[0].id);
		const series = (await a.call('GET', `/projects/${copy.body.project.id}/series`)).body.series;
		expect(series).toHaveLength(1);
		const full = await a.call('GET', `/projects/${copy.body.project.id}/series/${series[0].id}`);
		expect(full.body.values).toEqual([0, 1.5, null, 3]);
	});
});

describe('members and roles', () => {
	it('enforces viewer < editor < owner', async () => {
		const owner = await signUp('Own');
		const editor = await signUp('Ed');
		const viewer = await signUp('View');
		const { projectId, model } = await projectWithModel(owner);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);

		// viewer: read yes, write no
		expect((await viewer.call('GET', `/projects/${projectId}/model`)).status).toBe(200);
		expect((await viewer.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { name: 'x' })).status).toBe(403);
		// editor: write yes, manage members / delete no
		expect((await editor.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		expect((await editor.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'owner' })).status).toBe(403);
		expect((await editor.call('DELETE', `/projects/${projectId}`)).status).toBe(403);
		// anyone may leave
		expect((await viewer.call('DELETE', `/projects/${projectId}/members/${viewer.id}`)).status).toBe(204);
		expect((await viewer.call('GET', `/projects/${projectId}`)).status).toBe(404);
	});

	it('never lets the last owner leave or be demoted', async () => {
		const owner = await signUp('Solo');
		const { projectId } = await projectWithModel(owner);
		expect((await owner.call('DELETE', `/projects/${projectId}/members/${owner.id}`)).status).toBe(409);
		expect((await owner.call('PATCH', `/projects/${projectId}/members/${owner.id}`, { role: 'editor' })).status).toBe(409);
	});

	it('404s when adding an email with no account', async () => {
		const owner = await signUp('Inv');
		const { projectId } = await projectWithModel(owner);
		const res = await owner.call('POST', `/projects/${projectId}/members`, { email: 'ghost@example.com', role: 'viewer' });
		expect(res.status).toBe(404);
	});

	it('deletes a project with everything in it', async () => {
		const owner = await signUp('Del');
		const { projectId } = await projectWithModel(owner);
		expect((await owner.call('DELETE', `/projects/${projectId}`)).status).toBe(204);
		expect((await owner.call('GET', `/projects/${projectId}`)).status).toBe(404);
	});
});

describe('time series', () => {
	it('upserts by kind+name and validates', async () => {
		const u = await signUp('TS');
		const { projectId } = await projectWithModel(u);
		const put = (values: unknown[]) =>
			u.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2013-04-15', values });
		expect((await put([1, 2])).body.length).toBe(2);
		expect((await put([1, 2, 3])).body.length).toBe(3);
		expect((await u.call('GET', `/projects/${projectId}/series`)).body.series).toHaveLength(1);
		expect((await put(['x'])).status).toBe(400);
		expect(
			(await u.call('PUT', `/projects/${projectId}/series`, { kind: 'bogus', unit: 'x', startDate: '2020-01-01', values: [1] })).status
		).toBe(400);
	});
});

describe('series append', () => {
	it('merges a daily batch into an existing series and creates missing ones', async () => {
		const u = await signUp('Append');
		const { projectId } = await projectWithModel(u);
		const merge = (startDate: string, values: (number | null)[]) =>
			u.call('POST', `/projects/${projectId}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate, values });
		expect((await merge('2025-01-01', [1, 2, 3])).body).toMatchObject({ startDate: '2025-01-01', length: 3 });
		const next = await merge('2025-01-03', [30, 4]);
		expect(next.body).toMatchObject({ startDate: '2025-01-01', length: 4 });
		const full = await u.call('GET', `/projects/${projectId}/series/${next.body.id}`);
		expect(full.body.values).toEqual([1, 2, 30, 4]);
	});
});

