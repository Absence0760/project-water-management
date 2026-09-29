import { defaultDataQualitySettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { localDate } from './timeZone.js';

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

	it('lists each project with its recorded-rain end date and last run (null until there are any)', async () => {
		const u = await signUp('Fresh');
		const { projectId } = await projectWithModel(u);
		const find = async () =>
			(await u.call('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === projectId);
		expect(await find()).toMatchObject({ dataUntil: null, lastRunAt: null });

		const put = (kind: string, unit: string, startDate: string, n: number) =>
			u.call('PUT', `/projects/${projectId}/series`, { kind, unit, startDate, values: Array(n).fill(1) });
		await put('rain_catchment_mm', 'mm', '2020-09-01', 30); // → 2020-09-30
		expect((await find()).dataUntil).toBe('2020-09-30');
		// Freshness is recorded rain: observed flow and a forecast reaching later don't move it.
		await put('flow_observed_m3s', 'm3/s', '2020-09-15', 31); // → 2020-10-15
		await put('rain_forecast_mm', 'mm', '2020-09-25', 20); // → 2020-10-14
		expect((await find()).dataUntil).toBe('2020-09-30');
		await put('rain_chirps_mm', 'mm', '2020-09-01', 40); // → 2020-10-10, recorded rain too
		expect((await find()).dataUntil).toBe('2020-10-10');

		const before = Date.now();
		expect((await u.call('POST', `/projects/${projectId}/runs`, { label: 'one' })).status).toBe(201);
		const { lastRunAt, dataUntil } = await find();
		expect(dataUntil).toBe('2020-10-10');
		expect(Date.parse(lastRunAt)).toBeGreaterThanOrEqual(before - 5_000);
		// The single-project endpoint carries the same fields.
		expect((await u.call('GET', `/projects/${projectId}`)).body.project).toMatchObject({ dataUntil: '2020-10-10', lastRunAt });

		// A logger reporting "no reading" stores blank days: no data, so no fresher.
		const blanks = await u.call('POST', `/projects/${projectId}/series/merge`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2020-10-11', values: [null, null, null] });
		expect(blanks.status).toBe(200);
		expect(blanks.body).toMatchObject({ length: 43, lastValueDate: '2020-10-10' });
		expect((await find()).dataUntil).toBe('2020-10-10');
		// Positive control: a value after the blanks moves it.
		expect((await u.call('POST', `/projects/${projectId}/series/merge`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2020-10-14', values: [0] })).status).toBe(200);
		expect((await find()).dataUntil).toBe('2020-10-14');
	});

	it('lists each project with its own calendar day, in its time zone, for the list to count data age to (issue #137)', async () => {
		const u = await signUp('Zones');
		const ahead = (await u.call('POST', '/projects', { name: 'Ahead' })).body.project.id as string;
		const behind = (await u.call('POST', '/projects', { name: 'Behind' })).body.project.id as string;
		// UTC+14 and UTC−11: 25 hours apart, so their calendar days always differ.
		expect((await u.call('PATCH', `/projects/${ahead}`, { timeZone: 'Pacific/Kiritimati' })).status).toBe(200);
		expect((await u.call('PATCH', `/projects/${behind}`, { timeZone: 'Pacific/Pago_Pago' })).status).toBe(200);
		const before = new Date();
		const list = (await u.call('GET', '/projects')).body.projects as { id: string; today: string }[];
		const after = new Date();
		const today = (id: string) => list.find((p) => p.id === id)!.today;
		// Positive control: each row carries a date, and it is that project's, not the server's.
		expect([localDate(before, 'Pacific/Kiritimati'), localDate(after, 'Pacific/Kiritimati')]).toContain(today(ahead));
		expect([localDate(before, 'Pacific/Pago_Pago'), localDate(after, 'Pacific/Pago_Pago')]).toContain(today(behind));
		expect(today(ahead)).not.toBe(today(behind));
		// The single-project endpoint carries it too.
		expect([localDate(before, 'Pacific/Kiritimati'), localDate(new Date(), 'Pacific/Kiritimati')]).toContain((await u.call('GET', `/projects/${ahead}`)).body.project.today);
	});

	it('merges settings patches over defaults and drops keys the schema does not name', async () => {
		const u = await signUp('S');
		const { body } = await u.call('POST', '/projects', { name: 'S' });
		const id = body.project.id;
		const res = await u.call('PATCH', `/projects/${id}`, {
			settings: { effectiveRainFraction: 0.5, calibration: { rainThresholdMm: 3, a: 0.11 }, futureEngineKey: [1, 2] }
		});
		expect(res.status).toBe(200);
		expect(res.body.project.settings.effectiveRainFraction).toBe(0.5);
		expect(res.body.project.settings.calibration.rainThresholdMm).toBe(3);
		expect(res.body.project.settings.calibration.catchmentAreaKm2).toBeNull(); // default kept
		// The legacy runoff model's key is dropped (issue #16), and so is an unknown
		// top-level one: a body stores only what SettingsPatch names (mass assignment,
		// http/mass-assignment.security.db.test.ts).
		expect(res.body.project.settings.calibration).not.toHaveProperty('a');
		expect(res.body.project.settings).not.toHaveProperty('futureEngineKey');
		expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: [1, 2] } })).status).toBe(400);
	});

	it('stores the curtailment reporting window (null by default) and rejects non-dates', async () => {
		const u = await signUp('R');
		const { body } = await u.call('POST', '/projects', { name: 'R' });
		const id = body.project.id;
		expect(body.project.settings.reportStart).toBeNull();
		expect(body.project.settings.reportEnd).toBeNull();
		const res = await u.call('PATCH', `/projects/${id}`, { settings: { reportStart: '2020-12-01', reportEnd: '2021-02-28' } });
		expect(res.status).toBe(200);
		expect([res.body.project.settings.reportStart, res.body.project.settings.reportEnd]).toEqual(['2020-12-01', '2021-02-28']);
		expect((await u.call('PATCH', `/projects/${id}`, { settings: { reportStart: 'last summer' } })).status).toBe(400);
	});

	it('stores the calibration window and flow series, and rejects bad values', async () => {
		const u = await signUp('W');
		const { body } = await u.call('POST', '/projects', { name: 'W' });
		const id = body.project.id;
		expect(body.project.settings).toMatchObject({ calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null });
		const ok = await u.call('PATCH', `/projects/${id}`, {
			settings: { calibrationStart: '2005-10-01', calibrationEnd: '2012-09-30', calibrationFlowKind: 'flow_logger_m3s' }
		});
		expect(ok.status).toBe(200);
		expect(ok.body.project.settings).toMatchObject({ calibrationStart: '2005-10-01', calibrationFlowKind: 'flow_logger_m3s' });
		for (const settings of [{ calibrationStart: '1/10/2005' }, { calibrationEnd: 20120930 }, { calibrationFlowKind: 'rain_catchment_mm' }]) {
			expect((await u.call('PATCH', `/projects/${id}`, { settings })).status, JSON.stringify(settings)).toBe(400);
		}
	});

	it('stores a reference gauge (other catchment) that runs never calibrate against', async () => {
		const u = await signUp('Ref');
		const { projectId } = await projectWithModel(u);
		const days = 60;
		const put = (kind: string, values: number[]) =>
			u.call('PUT', `/projects/${projectId}/series`, { kind, name: 'x', unit: kind.startsWith('rain_') ? 'mm' : 'm3/s', startDate: '2020-10-01', values });
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
		expect(first.body.project.settings.dataQuality).toEqual(defaultDataQualitySettings());
		const ok = await u.call('PATCH', `/projects/${projectId}`, { settings: { dataQuality: { agreementMinRatio: 0.9, agreementMinDays: 30 } } });
		expect(ok.status).toBe(200);
		// A partial patch keeps the other threshold at its default.
		expect(ok.body.project.settings.dataQuality).toEqual({ ...defaultDataQualitySettings(), agreementMinRatio: 0.9, agreementMaxRatio: 1.5, agreementMinDays: 30 });
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
		// The flow flat-line limits (engine ≥ 1.20.0): 60 days of one gauge value is a flat stretch by default …
		const flat = (r: typeof run) => r.body.run.summary.dataQuality.seriesChecks.filter((c: { check: string; seriesKind: string }) => c.check === 'flatline' && c.seriesKind === 'flow_observed_m3s');
		expect(flat(run)).toHaveLength(1);
		// … a cap below its floor is refused on the merged settings, and nothing is stored …
		const bad = await u.call('PATCH', `/projects/${projectId}`, { settings: { dataQuality: { flatlineFlowMinDays: 100 } } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/flow flat-line cap \(90 days\) can't be below its floor \(100 days\)/);
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.settings.dataQuality.flatlineFlowMinDays).toBe(14);
		// … and a floor above the stretch, with its cap, clears it.
		const longer = await u.call('PATCH', `/projects/${projectId}`, { settings: { dataQuality: { flatlineFlowMinDays: 61, flatlineFlowMaxDays: 120 } } });
		expect(longer.status).toBe(200);
		expect(longer.body.project.settings.dataQuality).toMatchObject({ agreementMinRatio: 0.9, flatlineFlowMinDays: 61, flatlineFlowMaxDays: 120 });
		const rerun = await u.call('POST', `/projects/${projectId}/runs`, { label: 'flat-line limits' });
		expect(rerun.status).toBe(201);
		expect(flat(rerun)).toHaveLength(0);
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

	it('points a copied EWR rule table at the copy’s node, and keeps the outlet table (engine ≥ 0.21.0)', async () => {
		const a = await signUp('CopyRule');
		const { projectId, outlet } = await projectWithModel(a);
		// Synthetic table: round numbers.
		const table = (siteNodeId: string | null) => ({
			siteNodeId,
			source: 'Synthetic table',
			component: 'total',
			unit: 'mcm',
			points: [10, 50, 90],
			ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
			naturalSource: 'run',
			natural: null,
			scale: 1
		});
		const patched = await a.call('PATCH', `/projects/${projectId}`, { settings: { ewrRules: [table(null), table(outlet.id)] } });
		expect(patched.status).toBe(200);
		expect(patched.body.project.settings.ewrRules.map((t: { siteNodeId: string | null }) => t.siteNodeId)).toEqual([null, outlet.id]);
		// Two tables for one site are refused.
		expect((await a.call('PATCH', `/projects/${projectId}`, { settings: { ewrRules: [table(null), table(null)] } })).status).toBe(400);

		const copy = await a.call('POST', `/projects/${projectId}/copy`, { name: 'Catchment E' });
		expect(copy.status).toBe(201);
		const dup = (await a.call('GET', `/projects/${copy.body.project.id}/model`)).body;
		const gauge = dup.nodes.find((n: { name: string }) => n.name === 'Gauge');
		expect(gauge.id).not.toBe(outlet.id);
		expect(copy.body.project.settings.ewrRules.map((t: { siteNodeId: string | null }) => t.siteNodeId)).toEqual([null, gauge.id]);
		// The original is untouched.
		const orig = (await a.call('GET', `/projects/${projectId}`)).body.project;
		expect(orig.settings.ewrRules[1].siteNodeId).toBe(outlet.id);
	});
});

describe('the project’s time zone (058_project_time_zone, issue #45)', () => {
	it('starts in South Africa, takes a known zone from an editor, refuses an unknown one and a viewer, and is audited', async () => {
		const owner = await signUp('Zone');
		const viewer = await signUp('ZoneViewer');
		const { projectId } = await projectWithModel(owner);
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project.timeZone).toBe('Africa/Johannesburg');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		// Positive control first: the viewer reads it.
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.timeZone).toBe('Africa/Johannesburg');
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { timeZone: 'Africa/Windhoek' })).status).toBe(403);
		const bad = await owner.call('PATCH', `/projects/${projectId}`, { timeZone: 'Mars/Olympus_Mons' });
		expect(bad.status).toBe(400);
		const ok = await owner.call('PATCH', `/projects/${projectId}`, { timeZone: 'Africa/Windhoek' });
		expect(ok.status).toBe(200);
		expect(ok.body.project.timeZone).toBe('Africa/Windhoek');
		// A patch without it leaves it alone.
		expect((await owner.call('PATCH', `/projects/${projectId}`, { description: 'x' })).body.project.timeZone).toBe('Africa/Windhoek');
		const history = await owner.call('GET', `/projects/${projectId}/history`);
		const changed = history.body.items.find(
			(e: { kind: string; subject?: { fields?: string[] } }) => e.kind === 'project.changed' && e.subject?.fields?.includes('time_zone')
		);
		expect(changed?.subject).toMatchObject({ timeZone: { from: 'Africa/Johannesburg', to: 'Africa/Windhoek' } });
	});

	it('travels with a copy and through the project document', async () => {
		const a = await signUp('ZoneCopy');
		const { projectId } = await projectWithModel(a);
		expect((await a.call('PATCH', `/projects/${projectId}`, { timeZone: 'Europe/London' })).status).toBe(200);
		const copy = await a.call('POST', `/projects/${projectId}/copy`, { name: 'Zone copy 2' });
		expect(copy.body.project.timeZone).toBe('Europe/London');
		const doc = await a.call('GET', `/projects/${projectId}/export.json`);
		expect(doc.body.timeZone).toBe('Europe/London');
		const imported = await a.call('POST', '/projects/import', doc.body);
		expect(imported.status).toBe(201);
		expect(imported.body.project.timeZone).toBe('Europe/London');
		// A document from before the setting imports with the default.
		const { timeZone: _dropped, ...older } = doc.body;
		const old = await a.call('POST', '/projects/import', older);
		expect(old.body.project.timeZone).toBe('Africa/Johannesburg');
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
			u.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2002-04-15', values });
		expect((await put([1, 2])).body.length).toBe(2);
		expect((await put([1, 2, 3])).body.length).toBe(3);
		expect((await u.call('GET', `/projects/${projectId}/series`)).body.series).toHaveLength(1);
		expect((await put(['x'])).status).toBe(400);
		// Not on the calendar: a 400, not the 500 Postgres would give it (the merge route too).
		for (const [method, path] of [['PUT', `/projects/${projectId}/series`], ['POST', `/projects/${projectId}/series/merge`]] as const) {
			const bad = await u.call(method, path, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-02-30', values: [1] });
			expect(bad.status, method).toBe(400);
			expect(bad.body.details[0]).toMatchObject({ path: ['startDate'], message: 'not a calendar date' });
		}
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
		// A re-sent batch changes nothing, so it doesn't move updatedAt either.
		const resent = await merge('2025-01-03', [30, 4]);
		expect(resent.body).toMatchObject({ id: next.body.id, startDate: '2025-01-01', length: 5, updatedAt: first.body.updatedAt });
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

// Issue #43: a project that has nominated an evidence run keeps it, and its
// nomination history, for good. Refused by the route (409 naming the run) and
// by the project_evidence_guard trigger (035), whoever deletes.
describe('a project with a nominated evidence run', () => {
	type User = Awaited<ReturnType<typeof signUp>>;

	/** A project with one GR4J run; nominated as evidence unless `nominate` is false. */
	async function withEvidence(owner: User, name: string, nominate = true) {
		const { projectId } = await projectWithModel(owner, name);
		const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
		expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Calibrated GR4J' });
		expect(run.status).toBe(201);
		const runId = run.body.run.id as string;
		if (nominate) expect((await owner.call('POST', `/projects/${projectId}/evidence`, { runId, reason: 'the calibrated run' })).status).toBe(201);
		return { projectId, runId };
	}
	const sql = (u: User, text: string, params: unknown[] = []) => withUser(u.id, (db) => db.query(text, params));

	it('refuses DELETE /projects/:id with a 409 that names the run, and keeps everything', async () => {
		const owner = await signUp('EvKeep');
		const { projectId, runId } = await withEvidence(owner, 'Evidence kept');
		const res = await owner.call('DELETE', `/projects/${projectId}`);
		expect(res.status).toBe(409);
		expect(res.body.error).toBe(
			'this project can\'t be deleted: "Calibrated GR4J" is its nominated evidence run, and a project keeps its evidence run and nomination history for good, ' +
				'even once a nomination is withdrawn; copy the project to start again without it.'
		);
		expect(res.body.details).toEqual({ evidenceRun: { id: runId, label: 'Calibrated GR4J' }, nominations: 1 });
		expect((await owner.call('GET', `/projects/${projectId}`)).status).toBe(200);
		expect((await owner.call('GET', `/projects/${projectId}/evidence`)).body.nominations.map((n: { runId: string }) => n.runId)).toEqual([runId]);
	});

	it('still refuses once the nomination is replaced: the past one is history too', async () => {
		const owner = await signUp('EvReplace');
		const { projectId, runId } = await withEvidence(owner, 'Evidence replaced');
		const second = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Second' })).body.run.id as string;
		expect((await owner.call('POST', `/projects/${projectId}/evidence`, { runId: second, reason: 'replaces the first' })).status).toBe(201);
		const res = await owner.call('DELETE', `/projects/${projectId}`);
		expect(res.status).toBe(409);
		expect(res.body.details).toEqual({ evidenceRun: { id: second, label: 'Second' }, nominations: 2 });
		expect((await owner.call('GET', `/projects/${projectId}/evidence`)).body.nominations.map((n: { runId: string }) => n.runId)).toEqual([runId, second]);
	});

	it('refuses a direct DELETE as water_app, and as the schema owner, with restrict_violation', async () => {
		const owner = await signUp('EvSql');
		const { projectId } = await withEvidence(owner, 'Evidence SQL');
		await expect(sql(owner, 'DELETE FROM project WHERE id = $1', [projectId])).rejects.toMatchObject({ code: '23001' });
		await expect(asOwner('DELETE FROM project WHERE id = $1', [projectId])).rejects.toMatchObject({ code: '23001' });
		expect((await sql(owner, 'SELECT 1 FROM run_nomination WHERE project_id = $1', [projectId])).rowCount).toBe(1);
	});

	it('positive control: the same project without a nomination deletes, runs, pin and all, through the route and in SQL', async () => {
		const owner = await signUp('EvNone');
		const viaRoute = await withEvidence(owner, 'No evidence (route)', false);
		expect((await owner.call('PATCH', `/projects/${viaRoute.projectId}/runs/${viaRoute.runId}`, { pinned: true })).status).toBe(200);
		expect((await owner.call('DELETE', `/projects/${viaRoute.projectId}`)).status).toBe(204);
		expect((await owner.call('GET', `/projects/${viaRoute.projectId}`)).status).toBe(404);
		const viaSql = await withEvidence(owner, 'No evidence (SQL)', false);
		expect((await sql(owner, 'DELETE FROM project WHERE id = $1', [viaSql.projectId])).rowCount).toBe(1);
	});

	it('deleting its team leaves the project, and its evidence, in place (team_id → NULL, no cascade)', async () => {
		const owner = await signUp('EvTeam');
		const team = (await owner.call('POST', '/teams', { name: 'Evidence team' })).body.team.id as string;
		const { projectId, runId } = await withEvidence(owner, 'Team evidence');
		expect((await owner.call('PATCH', `/projects/${projectId}`, { teamId: team })).status).toBe(200);
		expect((await owner.call('DELETE', `/teams/${team}`)).status).toBe(204);
		const after = await owner.call('GET', `/projects/${projectId}`);
		expect(after.status).toBe(200);
		expect(after.body.project.team).toBeNull();
		expect((await owner.call('GET', `/projects/${projectId}/evidence`)).body.nominations.map((n: { runId: string }) => n.runId)).toEqual([runId]);
	});

	it('deleting the account is refused while it created the project (no cascade into project); there is no account-deletion route', async () => {
		const owner = await signUp('EvUser');
		const { projectId } = await withEvidence(owner, 'User evidence');
		await expect(asOwner('DELETE FROM app_user WHERE id = $1', [owner.id])).rejects.toMatchObject({ code: '23503' });
		expect((await owner.call('GET', `/projects/${projectId}`)).status).toBe(200);
	});

	it('the operator can still remove one out of band, as the schema owner, by disabling the guard for one transaction', async () => {
		const owner = await signUp('EvOperator');
		const { projectId } = await withEvidence(owner, 'Operator removal');
		expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
		await asOwner(
			`BEGIN; ALTER TABLE project DISABLE TRIGGER project_evidence_guard; DELETE FROM project WHERE id = '${projectId}'; ALTER TABLE project ENABLE TRIGGER project_evidence_guard; COMMIT;`
		);
		expect(await asOwner('SELECT 1 FROM project WHERE id = $1', [projectId])).toEqual([]);
		expect(await asOwner(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'project_evidence_guard'`)).toEqual([{ tgenabled: 'O' }]);
	});
});
