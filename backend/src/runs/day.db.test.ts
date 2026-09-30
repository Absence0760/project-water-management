// GET /projects/:id/runs/:runId/day: one node's columns on one day, for the
// day trace in the results (docs/ui.md § Self-checks).
import { beforeAll, describe, expect, it } from 'vitest';
import { damCapacityOn, toEpochDay, type NetworkNode } from '@water-management/engine';
import { asOwner, makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
let projectId: string;
let runId: string;
const outlet = node('Outlet', null);
const farm = node('Upper', outlet.id, {
	damCapacityM3: 5_000,
	damInitialPct: 0.4,
	pctRunoffToDam: 0.5,
	pctUpstreamToDam: 0,
	irrigationEfficiency: 0.8,
	lossReturnFraction: 0.5,
	divertCapacityM3Day: 50
});
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };

beforeAll(async () => {
	owner = await signUp('Owner');
	viewer = await signUp('Viewer');
	stranger = await signUp('Stranger');
	projectId = (await owner.call('POST', '/projects', { name: 'Trace' })).body.project.id;
	await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } });
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Trace' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
});

const day = (u: User, date: string, nodeId = farm.id) => u.call('GET', `/projects/${projectId}/runs/${runId}/day?${new URLSearchParams({ date, nodeId })}`);
const valueOf = (body: { columns: { key: string; value: number | null }[] }, key: string) => body.columns.find((c) => c.key === key)!.value!;

describe('GET /projects/:id/runs/:runId/day', () => {
	it("returns the farm's columns that day, matching the stored series", async () => {
		const res = await day(viewer, '2020-01-06');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ date: '2020-01-06', nodeId: farm.id, name: 'Upper', kind: 'farm' });
		expect(res.body.params).toEqual({
			pctUpstreamToDam: 0,
			pctRunoffToDam: 0.5,
			divertCapacityM3Day: 50,
			damCapacityM3: 5_000,
			damInitialPct: 0.4,
			damMinPct: 0.1,
			irrigationEfficiency: 0.8,
			lossReturnFraction: 0.5,
			damAreaFullM2: null,
			damAreaExponent: 0.7,
			damSeepagePerDay: 0
		});
		const keys = res.body.columns.map((c: { key: string }) => c.key);
		for (const k of ['gross_demand', 'effective_rain', 'soil_water', 'crop_requirement', 'demand', 'supplied', 'upstream_to_dam', 'dam_evaporation', 'rain_on_dam', 'dam_seepage', 'interim_storage', 'return_flow', 'balance_residual']) expect(keys).toContain(k);
		// Day index 5 of the stored series, and the day before's storage.
		for (const key of ['supplied', 'dam_storage']) {
			const s = await viewer.call('GET', `/projects/${projectId}/runs/${runId}/series?key=${key}&nodeId=${farm.id}`);
			expect(valueOf(res.body, key)).toBe(s.body.values[5]);
			if (key === 'dam_storage') expect(res.body.previousStorageM3).toBe(s.body.values[4]);
		}
		// 10 mm of rain on the 6th: effective rain is taken off the demand.
		expect(valueOf(res.body, 'effective_rain')).toBeGreaterThan(0);
		// The day closes from the returned numbers alone.
		const v = (k: string) => valueOf(res.body, k);
		// Rain on the dam in, evaporation out (N2); seepage is part of the outflow.
		const closes =
			v('inflow_upstream') + v('runoff') + v('transfer') + v('rain_on_dam') - (v('supplied') - v('return_flow')) - v('dam_evaporation') - (v('dam_storage') - res.body.previousStorageM3) - v('outflow');
		expect(Math.abs(closes)).toBeLessThan(1e-6);
	});

	it("uses the run's initial storage on its first day", async () => {
		const res = await day(owner, '2020-01-01');
		expect(res.status).toBe(200);
		expect(res.body.previousStorageM3).toBe(2_000); // 0.4 × 5 000 m³
		expect(res.body.previousSoilWaterMm).toBe(0); // the soil-water store starts empty
	});

	it("starts a dam whose capacity changes from its initial share of the first day's capacity (issue #67)", async () => {
		// Surveyed a year after the run with 10 % a year lost to sediment: on the first day it held more than 5 000 m³.
		const dev = { ...farm, damSurveyDate: '2021-01-01', damSedimentPctPerYear: 0.1 };
		const model = { nodes: [outlet, dev], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Sediment' });
		expect(run.status).toBe(201);
		const id = run.body.run.id as string;
		try {
			const at = (date: string) => owner.call('GET', `/projects/${projectId}/runs/${id}/day?${new URLSearchParams({ date, nodeId: farm.id })}`);
			const first = await at('2020-01-01');
			expect(first.status).toBe(200);
			const cap = damCapacityOn(dev as unknown as NetworkNode, toEpochDay('2020-01-01'));
			expect(cap).toBeGreaterThan(5_000);
			expect(first.body.previousStorageM3).toBeCloseTo(0.4 * cap, 9);
			// The first day closes from that start, as every other day does.
			const v = (k: string) => valueOf(first.body, k);
			const closes =
				v('inflow_upstream') + v('runoff') + v('transfer') + v('rain_on_dam') - (v('supplied') - v('return_flow')) - v('dam_evaporation') - (v('dam_storage') - first.body.previousStorageM3) - v('outflow');
			expect(Math.abs(closes)).toBeLessThan(1e-6);
		} finally {
			// Positive control, and the model back as the other tests expect it.
			expect((await owner.call('PUT', `/projects/${projectId}/model`, { ...model, nodes: [outlet, farm] })).status).toBe(200);
			expect((await day(owner, '2020-01-01')).body.previousStorageM3).toBe(2_000);
		}
	});

	it("gives River to dam by month's value for the day's month as divertCapacityM3Day (issue #204)", async () => {
		// Water-year order Oct–Sep: January is index 3.
		const byMonth = [50, 50, 50, 20, 50, 50, 50, 50, 50, 50, 50, 50];
		const monthly = { ...farm, divertMonthlyM3Day: byMonth, handsOffM3Day: Array(12).fill(5), handsOffEwr: true };
		const model = { nodes: [outlet, monthly], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		try {
			const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'River to dam by month' });
			expect(run.status).toBe(201);
			const res = await owner.call('GET', `/projects/${projectId}/runs/${run.body.run.id}/day?${new URLSearchParams({ date: '2020-01-06', nodeId: farm.id })}`);
			expect(res.status).toBe(200);
			expect(res.body.params.divertCapacityM3Day).toBe(20);
		} finally {
			// Positive control: the one value again once the months are gone.
			expect((await owner.call('PUT', `/projects/${projectId}/model`, { ...model, nodes: [outlet, farm] })).status).toBe(200);
			expect((await day(owner, '2020-01-06')).body.params.divertCapacityM3Day).toBe(50);
		}
	});

	it('reads River to dam by month across the water year’s turn: 30 September is Sep (index 11), 15 October is Oct (index 0)', async () => {
		const p = (await owner.call('POST', '/projects', { name: 'Trace, water-year turn' })).body.project.id as string;
		await owner.call('PATCH', `/projects/${p}`, { settings: { apanMm: monthly(150) } });
		// Each month's own value, so the index read is the value: Oct = 1 … Sep = 12.
		const byMonth = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
		// Its own ids: node and crop ids are unique across projects.
		const gauge = node('Outlet', null);
		const unit = { ...farm, id: crypto.randomUUID(), downstreamNodeId: gauge.id, divertMonthlyM3Day: byMonth };
		const c = { ...crop, id: crypto.randomUUID() };
		const model = { nodes: [gauge, unit], crops: [c], cropAreas: [{ nodeId: unit.id, cropId: c.id, areaM2: 10_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${p}/model`, model)).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${p}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-09-28', values: new Array(20).fill(1) })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${p}/runs`, { label: 'Turn' });
		expect(run.status).toBe(201);
		const at = (date: string, nodeId = unit.id) => owner.call('GET', `/projects/${p}/runs/${run.body.run.id}/day?${new URLSearchParams({ date, nodeId })}`);
		expect((await at('2020-09-30')).body.params.divertCapacityM3Day).toBe(12);
		expect((await at('2020-10-01')).body.params.divertCapacityM3Day).toBe(1);
		expect((await at('2020-10-15')).body.params.divertCapacityM3Day).toBe(1);

		// Only a farm's is replaced: a gauge's stored row (the save refuses one, so it is planted in the run's inputs) keeps its own value.
		await asOwner(
			`UPDATE model_run SET inputs = jsonb_set(inputs, '{model,nodes}',
				(SELECT jsonb_agg(CASE WHEN n->>'id' = $2 THEN n || '{"divertMonthlyM3Day": [9,9,9,9,9,9,9,9,9,9,9,9]}'::jsonb ELSE n END) FROM jsonb_array_elements(inputs->'model'->'nodes') n))
			 WHERE id = $1`,
			[run.body.run.id, gauge.id]
		);
		const atGauge = await at('2020-10-15', gauge.id);
		expect(atGauge.status).toBe(200);
		expect(atGauge.body.kind).toBe('gauge');
		expect(atGauge.body.params.divertCapacityM3Day).toBe(gauge.divertCapacityM3Day);
		// Positive control: the farm on the same stored run is still read by month.
		expect((await at('2020-10-15')).body.params.divertCapacityM3Day).toBe(1);
	});

	it('returns the soil-water store the day started from, so the carried-over rain can be redone (N3)', async () => {
		// 10 mm on the 6th: 10 000 m² × 0.65 × 10 / 1000 = 65 m³, more than the day's gross demand; the rest is kept.
		const res = await day(viewer, '2020-01-07');
		const s = await viewer.call('GET', `/projects/${projectId}/runs/${runId}/series?key=soil_water&nodeId=${farm.id}`);
		expect(res.body.previousSoilWaterMm).toBe(s.body.values[5]);
		expect(res.body.previousSoilWaterMm).toBeGreaterThan(0);
		// A dry day: the rain used is what the store held (in m³ over 10 000 m²), up to the gross demand.
		const v = (k: string) => valueOf(res.body, k);
		expect(v('effective_rain')).toBeCloseTo(Math.min((res.body.previousSoilWaterMm * 10_000) / 1000, v('gross_demand')), 9);
		expect(v('crop_requirement')).toBeCloseTo(v('gross_demand') - v('effective_rain'), 9);
		// The farm abstracts the crop requirement ÷ its 80 % efficiency (N1, engine 0.16.0).
		expect(v('demand')).toBeCloseTo(v('crop_requirement') / 0.8, 9);
	});

	it('takes the parameters from the run, not from the project as it is now', async () => {
		const edited = { ...farm, name: 'Renamed', irrigationEfficiency: 0.5 };
		const model = { nodes: [outlet, edited], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const res = await day(owner, '2020-01-02');
		expect(res.body.name).toBe('Upper');
		expect(res.body.params.irrigationEfficiency).toBe(0.8);
	});

	it('gives the efficiency the run used when a crop carries its own (engine 0.43.0), so D = F ÷ e redoes the day', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Trace crop efficiency' })).body.project.id;
		await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150) } });
		const out2 = node('Outlet', null);
		const farm2 = node('Upper', out2.id, { damCapacityM3: 50_000, damInitialPct: 1, irrigationEfficiency: 0.8, lossReturnFraction: 0.5 });
		const drip = { ...crop, id: crypto.randomUUID(), irrigationEfficiency: 0.9 };
		const model = { nodes: [out2, farm2], crops: [drip], cropAreas: [{ nodeId: farm2.id, cropId: drip.id, areaM2: 10_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: new Array(10).fill(0) });
		const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'Drip' });
		expect(run.status).toBe(201);
		const res = await owner.call('GET', `/projects/${pid}/runs/${run.body.run.id}/day?${new URLSearchParams({ date: '2020-01-03', nodeId: farm2.id })}`);
		expect(res.status).toBe(200);
		// The farm's own 0.8 is overridden by its only crop's 0.9.
		expect(res.body.params.irrigationEfficiency).toBeCloseTo(0.9, 12);
		expect(valueOf(res.body, 'demand')).toBeCloseTo(valueOf(res.body, 'crop_requirement') / 0.9, 9);
	});

	it('reads a run saved before engine 0.16.0 with its return flow % as migration 006 maps it', async () => {
		// Rewrite the stored snapshot as an engine 0.14 run held it (as the owner role: runs are immutable to the app).
		const pg = (await import('pg')).default;
		const db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await db.connect();
		try {
			await db.query(
				`UPDATE model_run SET inputs = jsonb_set(inputs, '{model,nodes}', (
					SELECT jsonb_agg((n - 'irrigationEfficiency' - 'lossReturnFraction') || '{"returnFlowPct": 0.2}'::jsonb)
					FROM jsonb_array_elements(inputs->'model'->'nodes') n)) WHERE id = $1`,
				[runId]
			);
		} finally {
			await db.end();
		}
		const res = await day(owner, '2020-01-02');
		expect(res.body.params).toMatchObject({ irrigationEfficiency: 0.8, lossReturnFraction: 1 });
		expect(res.body.params).not.toHaveProperty('returnFlowPct');
	});

	it('returns a gauge with its own columns and no storage', async () => {
		const res = await day(owner, '2020-01-02', outlet.id);
		expect(res.status).toBe(200);
		expect(res.body.kind).toBe('gauge');
		expect(res.body.previousStorageM3).toBeNull();
		expect(res.body.previousSoilWaterMm).toBeNull();
		expect(res.body.columns.map((c: { key: string }) => c.key).sort()).toEqual(['ewr_cumulative', 'ewr_shortfall', 'inflow_upstream', 'outflow']);
	});

	it('rejects dates that are not dates or outside the run, and unknown nodes', async () => {
		expect((await day(owner, '2020-02-31')).status).toBe(400);
		expect((await day(owner, '2020-1-5')).status).toBe(400);
		expect((await day(owner, '2019-12-31')).status).toBe(400);
		expect((await day(owner, '2020-01-31')).status).toBe(400);
		expect((await day(owner, '2020-01-02', crypto.randomUUID())).status).toBe(404);
		expect((await owner.call('GET', `/projects/${projectId}/runs/${runId}/day?date=2020-01-02&nodeId=nope`)).status).toBe(400);
	});

	it('is hidden (404) from anyone without access to the project', async () => {
		expect((await day(stranger, '2020-01-02')).status).toBe(404);
	});
});

// Without a nodeId: the catchment's day, how rain became natural flow (the runoff model's trace).
describe('GET /projects/:id/runs/:runId/day without a nodeId (catchment)', () => {
	let catchmentProject: string;
	let gr4jRun: string;
	let legacyRun: string;
	const catchmentDay = (u: User, run: string, date: string, project = catchmentProject) =>
		u.call('GET', `/projects/${project}/runs/${run}/day?${new URLSearchParams({ date })}`);
	const col = (body: { columns: { key: string; value: number | null }[] }, key: string) => body.columns.find((c) => c.key === key)?.value;
	const STORES = ['production_store', 'routing_store', 'uh_store'];

	beforeAll(async () => {
		catchmentProject = (await owner.call('POST', '/projects', { name: 'Catchment trace' })).body.project.id;
		// X2 ≠ 0 so the groundwater exchange is stored and enters the balance.
		const settings = { apanMm: monthly(150), runoffModel: 'gr4j', gr4j: { x1: 200, x2: -0.5, x3: 60, x4: 1.8, warmupDays: 30 } };
		expect((await owner.call('PATCH', `/projects/${catchmentProject}`, { settings })).status).toBe(200);
		// Node ids are unique across projects: a network of its own.
		const gauge = node('Outlet', null);
		const upper = node('Upper', gauge.id);
		const model = { nodes: [gauge, upper], crops: [], cropAreas: [], transfers: [] };
		expect((await owner.call('PUT', `/projects/${catchmentProject}/model`, model)).status).toBe(200);
		const rain = Array.from({ length: 30 }, (_, i) => (i % 7 === 0 ? 30 : i % 3 === 0 ? 2 : 0));
		expect((await owner.call('PUT', `/projects/${catchmentProject}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
		const a = await owner.call('POST', `/projects/${catchmentProject}/runs`, { label: 'GR4J' });
		expect(a.status).toBe(201);
		gr4jRun = a.body.run.id;
		// Saved on the legacy model before engine 1.0.0 removed it (the API can't make one now).
		const b = await owner.call('POST', `/projects/${catchmentProject}/runs`, { label: 'Legacy' });
		expect(b.status).toBe(201);
		legacyRun = b.body.run.id;
		await makeStoredLegacyRun(legacyRun);
		expect((await owner.call('POST', `/projects/${catchmentProject}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	});

	it("returns the runoff model's day with the stores the day started from, and the store balance closes", async () => {
		const res = await catchmentDay(viewer, gr4jRun, '2020-01-08');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ date: '2020-01-08', nodeId: null, name: 'Catchment', kind: 'catchment', runoffModel: 'gr4j', areaKm2: 10 });
		expect(res.body.params).toEqual({ x1: 200, x2: -0.5, x3: 60, x4: 1.8, warmupDays: 30 });
		for (const k of ['rain_used', 'pet', 'aet', 'exchange', 'natural_flow', ...STORES]) expect(typeof col(res.body, k), k).toBe('number');
		// The stores the day before are the stored series' previous day.
		for (const k of STORES) {
			const s = await viewer.call('GET', `/projects/${catchmentProject}/runs/${gr4jRun}/series?key=${k}`);
			expect(res.body.previousStores[k]).toBe(s.body.values[6]);
			expect(col(res.body, k)).toBe(s.body.values[7]);
		}
		expect(res.body.previousStorageMm).toBeCloseTo(STORES.reduce((s, k) => s + res.body.previousStores[k], 0), 12);
		// before + P + F − AET − Q (mm over the catchment) = after.
		const v = (k: string) => col(res.body, k)!;
		const after = STORES.reduce((s, k) => s + v(k), 0);
		const q = v('natural_flow') / (res.body.areaKm2 * 1000);
		expect(Math.abs(res.body.previousStorageMm + v('rain_used') + v('exchange') - v('aet') - q - after)).toBeLessThan(1e-9);
		expect(v('rain_used')).toBe(30); // 30 mm on the 8th
	});

	it("starts the run's first day from each store after the warm-up, and the day balances on them", async () => {
		const res = await catchmentDay(owner, gr4jRun, '2020-01-01');
		expect(res.status).toBe(200);
		const run = await owner.call('GET', `/projects/${catchmentProject}/runs/${gr4jRun}`);
		const start = run.body.run.summary.runoff;
		expect(res.body.previousStorageMm).toBe(start.storageStartMm);
		for (const k of STORES) {
			expect(typeof start.storesStartMm[k], k).toBe('number');
			expect(res.body.previousStores[k], k).toBe(start.storesStartMm[k]);
		}
		expect(STORES.reduce((s, k) => s + res.body.previousStores[k], 0)).toBeCloseTo(res.body.previousStorageMm, 9);
		// Each store's own step from its start: the production store holds X1 at most, and the day closes.
		expect(res.body.previousStores.production_store).toBeLessThanOrEqual(200);
		const v = (k: string) => col(res.body, k)!;
		const after = STORES.reduce((s, k) => s + v(k), 0);
		const q = v('natural_flow') / (res.body.areaKm2 * 1000);
		expect(Math.abs(res.body.previousStorageMm + v('rain_used') + v('exchange') - v('aet') - q - after)).toBeLessThan(1e-9);
	});

	it('a run from before engine 1.20.0 kept only the total at the start: each store is null on its first day', async () => {
		const made = await owner.call('POST', `/projects/${catchmentProject}/runs`, { label: 'Before 1.20.0' });
		expect(made.status).toBe(201);
		const old = made.body.run.id as string;
		await asOwner(`UPDATE model_run SET engine_version = '1.19.0', summary = summary #- '{runoff,storesStartMm}' WHERE id = $1`, [old]);
		const res = await catchmentDay(owner, old, '2020-01-01');
		expect(res.status).toBe(200);
		const run = await owner.call('GET', `/projects/${catchmentProject}/runs/${old}`);
		expect(run.body.run.summary.runoff.storesStartMm).toBeUndefined();
		expect(res.body.previousStorageMm).toBe(run.body.run.summary.runoff.storageStartMm);
		expect(res.body.previousStores).toEqual({ production_store: null, routing_store: null, uh_store: null });
		// Only the first day: the second reads the stored series.
		const next = await catchmentDay(owner, old, '2020-01-02');
		for (const k of STORES) expect(typeof next.body.previousStores[k], k).toBe('number');
	});

	it('traces a legacy run without stores: the [Flow data] columns only', async () => {
		const res = await catchmentDay(viewer, legacyRun, '2020-01-08');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ kind: 'catchment', runoffModel: 'legacy', areaKm2: null, params: null, previousStorageMm: null, previousStores: null });
		for (const k of ['rain_used', 'base_flow', 'response_flow', 'natural_flow']) expect(typeof col(res.body, k), k).toBe('number');
		expect(col(res.body, 'production_store')).toBeUndefined();
	});

	it('rejects dates outside the run, and is hidden (404) from anyone without access', async () => {
		expect((await catchmentDay(owner, gr4jRun, '2019-12-31')).status).toBe(400);
		expect((await catchmentDay(owner, gr4jRun, '2020-02-30')).status).toBe(400);
		expect((await catchmentDay(owner, crypto.randomUUID(), '2020-01-02')).status).toBe(404);
		// Another project's run through this project's URL: not found.
		expect((await catchmentDay(owner, runId, '2020-01-02')).status).toBe(404);
		expect((await catchmentDay(stranger, gr4jRun, '2020-01-02')).status).toBe(404);
		expect((await stranger.call('GET', `/projects/${projectId}/runs/${runId}/day?date=2020-01-02`)).status).toBe(404);
	});
});
