// Forecast runs (WP-2.12, 038_run_trigger.sql, engine forecast.ts): a run
// option that keeps the forecast days apart from the historical figures, its
// own storage limit, reproducibility, and the forecast in exports and in a
// published farm view. Every "not" has a positive control.
import { forecastSplit, runForecastChecked, runModelChecked, withoutForecastTail, type RunSummary } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput, loadRunInput, trimRuns } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const RAIN_START = '2021-10-01';
const DAYS = 400; // recorded rain to 2022-11-04
const FORECAST_FROM = '2022-11-05';
const FORECAST_DAYS = 14; // to 2022-11-18

let owner: User;
let viewer: User;
let farmer: User;
let projectId: string;
const outlet = node('Weir', null);
const farm = node('Farm One', outlet.id);
const other = node('Farm Two', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

async function makeProject(u: User, name: string, withForecast: boolean, ids = new Map<string, string>()) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const re = (v: string | null) => (v === null ? null : (ids.get(v) ?? v));
	const model = {
		nodes: [outlet, farm, other].map((n) => ({ ...n, id: re(n.id), downstreamNodeId: re(n.downstreamNodeId) })),
		crops: [{ ...crop, id: re(crop.id) }],
		cropAreas: [farm, other].map((f) => ({ nodeId: re(f.id), cropId: re(crop.id), areaM2: 200_000 })),
		transfers: []
	};
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RAIN_START, values: rain })).status).toBe(200);
	if (withForecast) {
		const forecast = Array.from({ length: FORECAST_DAYS }, (_, i) => (i % 5 === 0 ? 12 : 0));
		expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: FORECAST_FROM, values: forecast })).status).toBe(200);
	}
	return id;
}

const freshIds = () => new Map([outlet, farm, other, crop].map((x) => [x.id, crypto.randomUUID()]));
const post = (u: User, pid: string, body: object) => u.call('POST', `/projects/${pid}/runs`, body);
const summaryOf = async (runId: string) => (await asOwner('SELECT summary FROM model_run WHERE id = $1', [runId]))[0].summary as RunSummary;
const text = async (u: User, path: string) => {
	const r = await app.request(path, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
	return { status: r.status, body: await r.text() };
};

beforeAll(async () => {
	[owner, viewer, farmer] = (await Promise.all(['Fcowner', 'Fcviewer', 'Fcfarmer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = await makeProject(owner, 'Forecast', true);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
}, 60_000);

describe('POST /runs { forecast }', () => {
	it('saves a forecast run: trigger forecast, forecastFrom, the forecast days summarised; an ordinary run of the same data stops before them', async () => {
		const f = await post(owner, projectId, { label: 'Next two weeks', forecast: true });
		expect(f.status).toBe(201);
		expect(f.body.run).toMatchObject({ trigger: 'forecast', forecastFrom: FORECAST_FROM, endDate: '2022-11-18', label: 'Next two weeks' });
		expect(f.body.run.summary.forecast).toMatchObject({ from: FORECAST_FROM, to: '2022-11-18', days: 14, lastObserved: '2022-11-04' });
		expect(f.body.run.summary.forecast.perFarm.map((p: { nodeId: string }) => p.nodeId)).toEqual([farm.id, other.id]);

		const o = await post(owner, projectId, { label: 'ordinary' });
		expect(o.status).toBe(201);
		expect(o.body.run).toMatchObject({ trigger: 'manual', forecastFrom: null, endDate: '2022-11-04' });
		expect(o.body.run.summary.forecast).toBeUndefined();
		// The acceptance criterion: historical figures bit-identical with and without the forecast.
		const [fs, os] = [await summaryOf(f.body.run.id), await summaryOf(o.body.run.id)];
		expect(JSON.stringify({ ...fs, forecast: undefined, forecastRain: undefined, warnings: undefined })).toBe(
			JSON.stringify({ ...os, forecastRain: undefined, warnings: undefined })
		);
		// An ordinary run no longer lets forecast rain in (positive control: the forecast run names those days).
		expect(os.forecastRain ?? null).toBeNull();
		expect(fs.forecastRain).toMatchObject({ days: 14, from: FORECAST_FROM });
		// Both kinds on the list, with their trigger.
		const list = (await viewer.call('GET', `/projects/${projectId}/runs`)).body.runs as { id: string; trigger: string; forecastFrom: string | null }[];
		expect(list.find((r) => r.id === f.body.run.id)).toMatchObject({ trigger: 'forecast', forecastFrom: FORECAST_FROM });
		expect(list.find((r) => r.id === o.body.run.id)).toMatchObject({ trigger: 'manual', forecastFrom: null });
		// Where the forecast rain came from (the report's line): an uploaded forecast is 'other', never CHIRPS-GEFS
		// (feeds/forecast.db.test.ts has the positive control); an ordinary run records none.
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${f.body.run.id}`)).body.run.forecastRainSource).toBe('other');
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${o.body.run.id}`)).body.run.forecastRainSource).toBeNull();
	});

	it('refuses a forecast run with no forecast tail (409, nothing stored), and a viewer (403)', async () => {
		const bare = await makeProject(owner, 'No forecast', false, freshIds());
		const res = await post(owner, bare, { forecast: true });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/no forecast rain after the last observed rain day/);
		expect((await owner.call('GET', `/projects/${bare}/runs`)).body.runs).toEqual([]);
		// Positive control: the same project runs as an ordinary run.
		expect((await post(owner, bare, {})).status).toBe(201);
		expect((await post(viewer, projectId, { forecast: true })).status).toBe(403);
	});

	it('keeps one forecast run per project: a new one removes the older, unless something keeps it (a pin)', async () => {
		const pid = await makeProject(owner, 'One forecast', true, freshIds());
		const first = (await post(owner, pid, { forecast: true })).body.run.id as string;
		const second = await post(owner, pid, { forecast: true });
		expect(second.body.removedRunIds).toEqual([first]);
		expect(await asOwner(`SELECT id FROM model_run WHERE project_id = $1 AND "trigger" = 'forecast'`, [pid])).toEqual([{ id: second.body.run.id }]);
		expect(await asOwner(`SELECT subject->>'reason' AS reason FROM audit_event WHERE project_id = $1 AND kind = 'run.deleted'`, [pid])).toEqual([
			{ reason: 'trimmed' }
		]);
		// A pinned forecast run stays (positive control above: an unpinned one went).
		expect((await owner.call('PATCH', `/projects/${pid}/runs/${second.body.run.id}`, { pinned: true })).status).toBe(200);
		const third = await post(owner, pid, { forecast: true });
		expect(third.body.removedRunIds).toEqual([]);
		expect((await asOwner(`SELECT count(*)::int AS n FROM model_run WHERE project_id = $1 AND "trigger" = 'forecast'`, [pid]))[0].n).toBe(2);
	});

	it('a forecast run neither counts toward the manual runs’ cap nor is trimmed by it', async () => {
		const pid = await makeProject(owner, 'Cap', true, freshIds());
		const oldManual = (await post(owner, pid, { label: 'old' })).body.run.id as string;
		const forecast = (await post(owner, pid, { forecast: true })).body.run.id as string;
		const newManual = (await post(owner, pid, { label: 'new' })).body.run.id as string;
		// Keep 1: the older manual run goes (positive control), the forecast run stays and didn't take the slot.
		const removed = await withUser(owner.id, (db) => trimRuns(db, pid, 1));
		expect(removed).toEqual([oldManual]);
		const left = (await asOwner('SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at', [pid])).map((r) => r.id);
		expect(left).toEqual([forecast, newManual]);
	});

	it('both kinds reproduce from their stored input: runForecastChecked for a forecast run, runModelChecked for an ordinary one', async () => {
		const pid = await makeProject(owner, 'Reproduce', true, freshIds());
		const f = (await post(owner, pid, { forecast: true })).body.run.id as string;
		const o = (await post(owner, pid, {})).body.run.id as string;
		await withUser(owner.id, async (db) => {
			const fin = await loadRunInput(db, f);
			expect(JSON.parse(JSON.stringify(runForecastChecked(fin).summary))).toEqual(await summaryOf(f));
			const oin = await loadRunInput(db, o);
			// The ordinary run stored its input without the tail.
			expect(oin.series.rain_forecast_mm).toBeUndefined();
			expect(oin.settings.simulationEnd).toBe('2022-11-04');
			expect(JSON.parse(JSON.stringify(runModelChecked(oin).summary))).toEqual(await summaryOf(o));
			// And it is exactly the live input without the tail.
			const live = await loadModelInput(db, pid);
			expect(forecastSplit(live).forecastFrom).toBe(FORECAST_FROM);
			expect(withoutForecastTail(live).settings.simulationEnd).toBe('2022-11-04');
		});
	});

	it('a forecast run is not a scenario base (409); an ordinary run is', async () => {
		const pid = await makeProject(owner, 'Scenario base', true, freshIds());
		const f = (await post(owner, pid, { forecast: true })).body.run.id as string;
		const o = (await post(owner, pid, {})).body.run.id as string;
		const refused = await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'On a forecast', baseRunId: f, ops: [] });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/forecast run/);
		expect((await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'On history', baseRunId: o, ops: [] })).status).toBe(201);
	});
});

describe('forecast days in exports and in the farm view', () => {
	let forecastRun: string;
	beforeAll(async () => {
		forecastRun = (await post(owner, projectId, { forecast: true })).body.run.id as string;
	});

	it('the daily CSVs carry an F column on the forecast days, and the catchment file the rain source', async () => {
		const daily = await text(viewer, `/projects/${projectId}/runs/${forecastRun}/export/daily.csv`);
		expect(daily.status).toBe(200);
		const all = daily.body.replace(/^﻿/, '').trim().split('\r\n');
		// The disclaimer and the run's provenance on leading # lines, then the header (docs/api.md § Export).
		expect(all[0]).toMatch(/^# model estimates /);
		expect(all[1]).toMatch(/^# run=[^;]*; engine=/);
		const lines = all.slice(2);
		const head = lines[0]!.split(',');
		expect(head[1]).toBe('forecast (F = modelled on forecast rain)');
		expect(head.some((h) => h.startsWith('"Rain source') || h.startsWith('Rain source'))).toBe(true);
		const byDate = new Map(lines.slice(1).map((l) => [l.slice(0, 10), l.split(',')[1]]));
		expect(byDate.get('2022-11-04')).toBe('');
		expect(byDate.get(FORECAST_FROM)).toBe('F');
		expect(byDate.get('2022-11-18')).toBe('F');
		const farms = await text(viewer, `/projects/${projectId}/runs/${forecastRun}/export/farms.csv?key=supplied`);
		expect(farms.body.replace(/^﻿/, '').split('\r\n')[1]).toMatch(/^# run=/);
		expect(farms.body.replace(/^﻿/, '').split('\r\n')[2]!.split(',')[1]).toBe('forecast (F = modelled on forecast rain)');
		const summary = await text(viewer, `/projects/${projectId}/runs/${forecastRun}/export/summary.csv`);
		expect(summary.body).toContain('First forecast day,2022-11-05');
		// Positive control: an ordinary run's daily CSV has no forecast column.
		const o = (await post(owner, projectId, {})).body.run.id as string;
		const plain = await text(viewer, `/projects/${projectId}/runs/${o}/export/daily.csv`);
		expect(plain.body).not.toContain('forecast (F');
	});

	it('publishing a forecast run gives the farmer their own farm’s forecast days, and the history stops the day before', async () => {
		expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId: forecastRun })).status).toBe(201);
		const view = (await farmer.call('GET', `/projects/${projectId}/farm/${farm.id}`)).body;
		expect(view.farm.dataUntil).toBe('2022-11-04');
		expect(view.farm.forecast).toMatchObject({ from: FORECAST_FROM, to: '2022-11-18', days: 14 });
		expect(view.farm.forecast.madeOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const s = await summaryOf(forecastRun);
		expect(view.farm.forecast.deficitDays).toBe(s.forecast!.perFarm.find((p) => p.nodeId === farm.id)!.deficitDays);
		// Nothing about the other farm in it.
		expect(JSON.stringify(view)).not.toContain(other.id);
		// Positive control: publishing an ordinary run carries no forecast.
		const o = (await post(owner, projectId, {})).body.run.id as string;
		expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId: o })).status).toBe(201);
		const plain = (await farmer.call('GET', `/projects/${projectId}/farm/${farm.id}`)).body;
		expect(plain.farm.forecast).toBeUndefined();
		expect(plain.farm.dataUntil).toBe('2022-11-04');
	});
});
