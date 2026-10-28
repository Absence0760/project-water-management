// settings.flowMissing and the widened settings.rainStations.unreliable
// (engine ≥ 1.102.0, issue #611, projects/flowMissingSettings.ts,
// projects/rainStationSettings.ts): a save may name only a flow record of the
// project for the first and only a rain record of it for the second, by series
// id; another project's series, a series of the wrong kind and an id that
// names nothing are refused and nothing is stored. The run reads the record by
// its id (DailySeries.seriesId) and leaves the days out of its statistics; the
// run's snapshot keeps the id, and a copy follows the copy's series ids.
// Synthetic values only.
import { runModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput, loadRunInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const DAYS = 400;
const PERIOD = { start: '2020-03-01', end: '2020-04-30', reason: 'Weir silted up (synthetic)' };

/** Outlet ← farm with an area; catchment rain, an observed record, a logger record and the farm's own rain gauge. */
async function project(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null, { kind: 'gauge', areaKm2: 0 });
	const farm = node('Farm', outlet.id, { areaKm2: 20 });
	expect((await u.call('PUT', `/projects/${id}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150), runoffModel: 'gr4j' } })).status).toBe(200);
	const put = async (body: Record<string, unknown>) => {
		const r = await u.call('PUT', `/projects/${id}/series`, { startDate: '2020-01-01', ...body });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		return r.body.id as string;
	};
	const rain = await put({ kind: 'rain_catchment_mm', unit: 'mm', values: Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 12 : 0)) });
	const observed = await put({ kind: 'flow_observed_m3s', unit: 'm3/s', values: Array.from({ length: DAYS }, (_, i) => 1 + 0.5 * Math.sin(i / 9)) });
	const logger = await put({ kind: 'flow_logger_m3s', unit: 'm3/s', values: Array.from({ length: DAYS }, (_, i) => 1.1 + 0.5 * Math.sin(i / 9)) });
	const unitGauge = await put({ kind: 'rain_catchment_mm', name: 'Farm gauge', unit: 'mm', values: Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? 10 : 0)) });
	expect((await u.call('PATCH', `/projects/${id}/series/${unitGauge}`, { siteNodeId: farm.id })).status).toBe(200);
	return { id, farm: farm.id as string, rain, observed, logger, unitGauge };
}

const settingsOf = async (u: User, id: string) => (await u.call('GET', `/projects/${id}`)).body.project.settings as Record<string, unknown>;

describe('settings.flowMissing against the project', () => {
	it('takes the project’s own flow record and the run leaves its days out; refuses another project’s, a rain series and an unknown id', async () => {
		const u = await signUp('FlowMissingOwner');
		const p = await project(u, 'Flow missing');
		const other = await project(u, 'Another catchment');

		for (const id of [other.observed, p.rain, crypto.randomUUID()]) {
			const r = await u.call('PATCH', `/projects/${p.id}`, { settings: { flowMissing: { [id]: [PERIOD] } } });
			expect(r.status, id).toBe(400);
			expect(r.body.error).toBe('flow missing periods: one names a series that is not a flow record of this project (a gauge, logger or reference flow series)');
		}
		expect((await settingsOf(u, p.id)).flowMissing ?? null).toBeNull();

		// Positive control: the project's own record is taken, and is what the run reads.
		const ok = await u.call('PATCH', `/projects/${p.id}`, { settings: { flowMissing: { [p.observed]: [PERIOD] } } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect((await settingsOf(u, p.id)).flowMissing).toEqual({ [p.observed]: [PERIOD] });
		const input = await withUser(u.id, (db) => loadModelInput(db, p.id));
		expect(input.series.flow_observed_m3s!.seriesId).toBe(p.observed);
		expect(input.series.flow_logger_m3s!.seriesId).toBe(p.logger);
		const listed = runModel(input).summary.calibration!;
		const without = runModel({ ...input, settings: { ...input.settings, flowMissing: {} } }).summary.calibration!;
		expect(without.days - listed.days).toBe(61);

		// A save that keeps the record (since deleted, say) doesn't re-check it; a new foreign one still is refused.
		const again = await u.call('PATCH', `/projects/${p.id}`, { settings: { flowMissing: { [p.observed]: [PERIOD], [other.logger]: [PERIOD] } } });
		expect(again.status).toBe(400);
		expect((await settingsOf(u, p.id)).flowMissing).toEqual({ [p.observed]: [PERIOD] });
	});

	it('a viewer can’t set it; a stranger sees nothing', async () => {
		const owner = await signUp('FlowMissingViewerOwner');
		const viewer = await signUp('FlowMissingViewer');
		const stranger = await signUp('FlowMissingStranger');
		const p = await project(owner, 'Flow missing roles');
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await viewer.call('PATCH', `/projects/${p.id}`, { settings: { flowMissing: { [p.observed]: [PERIOD] } } })).status).toBe(403);
		expect((await stranger.call('PATCH', `/projects/${p.id}`, { settings: { flowMissing: { [p.observed]: [PERIOD] } } })).status).toBe(404);
		expect((await settingsOf(owner, p.id)).flowMissing ?? null).toBeNull();
	});

	it('the run’s snapshot keeps the series ids, so a re-run from stored inputs leaves the same days out', async () => {
		const u = await signUp('FlowMissingRun');
		const p = await project(u, 'Flow missing run');
		expect((await u.call('PATCH', `/projects/${p.id}`, { settings: { flowMissing: { [p.observed]: [PERIOD] } } })).status).toBe(200);
		const run = await u.call('POST', `/projects/${p.id}/runs`, { label: 'with missing periods' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const runId = run.body.run.id as string;
		const rows = await asOwner(`SELECT inputs->'series'->'flow_observed_m3s'->>'seriesId' AS id FROM model_run WHERE id = $1`, [runId]);
		expect(rows[0]!.id).toBe(p.observed);
		const stored = await withUser(u.id, (db) => loadRunInput(db, runId));
		expect(stored.series.flow_observed_m3s!.seriesId).toBe(p.observed);
		expect(runModel(stored).summary.calibration).toEqual(run.body.run.summary.calibration);
	});

	it('a copy follows the copy’s series ids, the kept checks’ and a rain record’s unreliable periods’ too', async () => {
		const u = await signUp('FlowMissingCopy');
		const p = await project(u, 'Flow missing source');
		const kept = `outlier:${p.logger}:2020-02-01:2020-02-01`;
		const saved = await u.call('PATCH', `/projects/${p.id}`, {
			settings: { flowMissing: { [p.observed]: [PERIOD] }, checksKept: [kept], rainStations: { unreliable: { [p.unitGauge]: [['2020-01-10', '2020-01-20']] } } }
		});
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		const copy = await u.call('POST', `/projects/${p.id}/copy`, { name: 'Flow missing copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const copyId = copy.body.project.id as string;
		const series = await asOwner(`SELECT id, kind, name FROM time_series WHERE project_id = $1`, [copyId]);
		const idOf = (kind: string, name: string) => series.find((s) => s.kind === kind && s.name === name)!.id as string;
		const settings = await settingsOf(u, copyId);
		expect(settings.flowMissing).toEqual({ [idOf('flow_observed_m3s', '')]: [PERIOD] });
		expect(settings.checksKept).toEqual([`outlier:${idOf('flow_logger_m3s', '')}:2020-02-01:2020-02-01`]);
		expect((settings.rainStations as { unreliable: unknown }).unreliable).toEqual({ [idOf('rain_catchment_mm', 'Farm gauge')]: [['2020-01-10', '2020-01-20']] });
	});
});

describe('settings.rainStations.unreliable on every rain record (issue #611)', () => {
	it('takes a unit’s own gauge; refuses a flow record, another project’s rain and an unknown id', async () => {
		const u = await signUp('UnreliableRecords');
		const p = await project(u, 'Unreliable records');
		const other = await project(u, 'Unreliable elsewhere');
		const periods = [['2020-01-10', '2020-01-20']];
		for (const id of [p.observed, other.unitGauge, crypto.randomUUID()]) {
			const r = await u.call('PATCH', `/projects/${p.id}`, { settings: { rainStations: { unreliable: { [id]: periods } } } });
			expect(r.status, id).toBe(400);
			expect(r.body.error).toBe('rainfall stations: a rain record’s unreliable periods is not a rain record of this project (a catchment rainfall series, a unit’s own gauge or the alternative catchment gauge)');
		}
		expect((await settingsOf(u, p.id)).rainStations ?? null).toBeNull();
		// Positive control: the unit's own gauge, which only stations could have before.
		const ok = await u.call('PATCH', `/projects/${p.id}`, { settings: { rainStations: { unreliable: { [p.unitGauge]: periods } } } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const input = await withUser(u.id, (db) => loadModelInput(db, p.id));
		expect((input.series as Record<string, { seriesId?: string }>)[`rain_catchment_mm@${p.farm}`]!.seriesId).toBe(p.unitGauge);
	});
});
