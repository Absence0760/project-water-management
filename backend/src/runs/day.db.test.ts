// GET /projects/:id/runs/:runId/day: one node's columns on one day, for the
// day trace in the results (docs/ui.md § Self-checks).
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

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
			lossReturnFraction: 0.5
		});
		const keys = res.body.columns.map((c: { key: string }) => c.key);
		for (const k of ['gross_demand', 'effective_rain', 'soil_water', 'crop_requirement', 'demand', 'supplied', 'upstream_to_dam', 'interim_storage', 'return_flow', 'balance_residual']) expect(keys).toContain(k);
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
		const closes = v('inflow_upstream') + v('runoff') + v('transfer') - (v('supplied') - v('return_flow')) - (v('dam_storage') - res.body.previousStorageM3) - v('outflow');
		expect(Math.abs(closes)).toBeLessThan(1e-6);
	});

	it("uses the run's initial storage on its first day", async () => {
		const res = await day(owner, '2020-01-01');
		expect(res.status).toBe(200);
		expect(res.body.previousStorageM3).toBe(2_000); // 0.4 × 5 000 m³
		expect(res.body.previousSoilWaterMm).toBe(0); // the soil-water store starts empty
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
		// The farm abstracts the crop requirement ÷ its 80 % efficiency (N1, engine 0.15.0).
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

	it('reads a run saved before engine 0.15.0 with its return flow % as migration 006 maps it', async () => {
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
