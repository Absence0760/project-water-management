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
	// GR4J (the default runoff model) refuses to run without A-pan evaporation.
	expect((await owner.call('PATCH', `/projects/${body.project.id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
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

	it('lists each project with its data end date and last run (null until there are any)', async () => {
		const u = await signUp('Fresh');
		const { projectId } = await projectWithModel(u);
		const find = async () =>
			(await u.call('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === projectId);
		expect(await find()).toMatchObject({ dataUntil: null, lastRunAt: null });

		const put = (kind: string, unit: string, startDate: string, n: number) =>
			u.call('PUT', `/projects/${projectId}/series`, { kind, unit, startDate, values: Array(n).fill(1) });
		await put('rain_catchment_mm', 'mm', '2020-09-01', 30); // → 2020-09-30
		expect((await find()).dataUntil).toBe('2020-09-30');
		await put('flow_observed_m3s', 'm3/s', '2020-09-15', 31); // → 2020-10-15, the later of the two
		expect((await find()).dataUntil).toBe('2020-10-15');

		const before = Date.now();
		expect((await u.call('POST', `/projects/${projectId}/runs`, { label: 'one' })).status).toBe(201);
		const { lastRunAt, dataUntil } = await find();
		expect(dataUntil).toBe('2020-10-15');
		expect(Date.parse(lastRunAt)).toBeGreaterThanOrEqual(before - 5_000);
		// The single-project endpoint carries the same fields.
		expect((await u.call('GET', `/projects/${projectId}`)).body.project).toMatchObject({ dataUntil: '2020-10-15', lastRunAt });
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

	it('stores the curtailment reporting window (null by default) and rejects non-dates', async () => {
		const u = await signUp('R');
		const { body } = await u.call('POST', '/projects', { name: 'R' });
		const id = body.project.id;
		expect(body.project.settings.reportStart).toBeNull();
		expect(body.project.settings.reportEnd).toBeNull();
		const res = await u.call('PATCH', `/projects/${id}`, { settings: { reportStart: '2015-12-31', reportEnd: '2016-03-01' } });
		expect(res.status).toBe(200);
		expect([res.body.project.settings.reportStart, res.body.project.settings.reportEnd]).toEqual(['2015-12-31', '2016-03-01']);
		expect((await u.call('PATCH', `/projects/${id}`, { settings: { reportStart: 'last summer' } })).status).toBe(400);
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

	it('stores a reference gauge (other catchment) that runs never calibrate against', async () => {
		const u = await signUp('Ref');
		const { projectId } = await projectWithModel(u);
		const days = 60;
		const put = (kind: string, values: number[]) =>
			u.call('PUT', `/projects/${projectId}/series`, { kind, name: 'x', unit: 'm3/s', startDate: '2020-10-01', values });
		expect((await put('rain_catchment_mm', new Array(days).fill(0))).status).toBe(200);
		expect((await put('flow_reference_m3s', new Array(days).fill(5))).status).toBe(200);
		expect((await put('flow_neighbour_m3s', new Array(days).fill(5))).status).toBe(400);
		const listed = await u.call('GET', `/projects/${projectId}/series`);
		expect(listed.body.series.map((s: { kind: string }) => s.kind)).toContain('flow_reference_m3s');
		// It can't be chosen as the calibration record …
		const pick = await u.call('PATCH', `/projects/${projectId}`, { settings: { calibrationFlowKind: 'flow_reference_m3s' } });
		expect(pick.status).toBe(400);
		// … and a run with only it has no observed record.
		const alone = await u.call('POST', `/projects/${projectId}/runs`, { label: 'reference only' });
		expect(alone.status).toBe(201);
		expect(alone.body.run.summary.calibration).toBeNull();
		// Positive control: with a logger, the logger is the record, and the reference changes nothing.
		expect((await put('flow_logger_m3s', new Array(days).fill(1))).status).toBe(200);
		const withLogger = await u.call('POST', `/projects/${projectId}/runs`, { label: 'logger' });
		expect(withLogger.status).toBe(201);
		expect(withLogger.body.run.summary.calibration.flowKind).toBe('flow_logger_m3s');
		expect(withLogger.body.run.summary.dataQuality.observedAgreement).toBeNull();
	});

	it('stores the gauge-vs-logger thresholds, rejects bad ones, and runs use them', async () => {
		const u = await signUp('Q');
		const { projectId } = await projectWithModel(u);
		const first = await u.call('GET', `/projects/${projectId}`);
		expect(first.body.project.settings.dataQuality).toEqual({ agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 });
		const ok = await u.call('PATCH', `/projects/${projectId}`, { settings: { dataQuality: { agreementMinRatio: 0.9, agreementMinDays: 30 } } });
		expect(ok.status).toBe(200);
		// A partial patch keeps the other threshold at its default.
		expect(ok.body.project.settings.dataQuality).toEqual({ agreementMinRatio: 0.9, agreementMaxRatio: 1.5, agreementMinDays: 30 });
		for (const dataQuality of [{ agreementMinRatio: 0 }, { agreementMinRatio: 1.2 }, { agreementMaxRatio: 0.5 }, { agreementMinDays: 12.5 }, { agreementMinDays: 400 }, { other: 1 }]) {
			expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { dataQuality } })).status, JSON.stringify(dataQuality)).toBe(400);
		}
		// Gauge at 80 % of the logger: inside the defaults, outside 90 %.
		const days = 60;
		await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-10-01', values: new Array(days).fill(0) });
		await u.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-10-01', values: new Array(days).fill(0.8) });
		await u.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_logger_m3s', unit: 'm3/s', startDate: '2020-10-01', values: new Array(days).fill(1) });
		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'thresholds' });
		expect(run.status).toBe(201);
		expect(run.body.run.summary.dataQuality.observedAgreement).toMatchObject({ minRatio: 0.9, minDays: 30, flaggedYears: [2020] });
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

	it('invites (rather than 404s) an email with no account — see invites.db.test.ts', async () => {
		const owner = await signUp('Inv');
		const { projectId } = await projectWithModel(owner);
		const res = await owner.call('POST', `/projects/${projectId}/members`, { email: 'ghost@example.com', role: 'viewer' });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ invited: true, invite: { email: 'ghost@example.com', role: 'viewer' } });
		expect((await owner.call('GET', `/projects/${projectId}/members`)).body.members).toHaveLength(1);
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
		// updatedAt moves forward with each change (drives "new data since the last run").
		const first = await merge('2025-01-05', [5]);
		expect(Date.parse(first.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(next.body.updatedAt));
		const list = await u.call('GET', `/projects/${projectId}/series`);
		expect(list.body.series[0].updatedAt).toBe(first.body.updatedAt);
	});
});

describe('display order', () => {
	it('keeps the crop order the client saves (defaults to document order)', async () => {
		const u = await signUp('Order');
		const { projectId, model } = await projectWithModel(u);
		const m = structuredClone(model);
		m.crops = [
			{ id: crypto.randomUUID(), name: 'Zucchini', cropFactor: monthly(0.5) },
			{ id: crypto.randomUUID(), name: 'Apples', cropFactor: monthly(0.5) },
			...m.crops
		];
		m.cropAreas = [];
		const saved = await u.call('PUT', `/projects/${projectId}/model`, m);
		expect(saved.body.crops.map((c: { name: string }) => c.name)).toEqual(['Zucchini', 'Apples', 'Citrus']);
		const reordered = structuredClone(saved.body);
		reordered.crops = reordered.crops.map((c: { sortOrder: number }, i: number) => ({ ...c, sortOrder: 2 - i }));
		const again = await u.call('PUT', `/projects/${projectId}/model`, reordered);
		expect(again.body.crops.map((c: { name: string }) => c.name)).toEqual(['Citrus', 'Apples', 'Zucchini']);
	});
});

