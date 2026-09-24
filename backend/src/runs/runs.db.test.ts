// Run storage cap (RUNS_KEPT_PER_PROJECT, runs/execute.ts trimRuns) and the
// model-input read that in-browser calibration runs on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runModel } from '@water-management/engine';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function runnable(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Capped' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	const series = { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain };
	expect((await u.call('PUT', `/projects/${projectId}/series`, series)).status).toBe(200);
	return projectId;
}

afterEach(() => vi.unstubAllEnvs());

describe('run storage cap', () => {
	it('keeps only the newest RUNS_KEPT_PER_PROJECT runs and says which were removed', async () => {
		vi.stubEnv('RUNS_KEPT_PER_PROJECT', '2');
		const u = await signUp('Capper');
		const projectId = await runnable(u);
		const ids: string[] = [];
		for (const label of ['one', 'two']) {
			const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
			expect(res.status).toBe(201);
			expect(res.body.removedRunIds).toEqual([]);
			ids.push(res.body.run.id);
		}
		const third = await u.call('POST', `/projects/${projectId}/runs`, { label: 'three' });
		expect(third.status).toBe(201);
		expect(third.body.removedRunIds).toEqual([ids[0]]);

		const list = (await u.call('GET', `/projects/${projectId}/runs`)).body.runs.map((r: { label: string }) => r.label);
		expect(list).toEqual(['three', 'two']);
		expect((await u.call('GET', `/projects/${projectId}/runs/${ids[0]}`)).status).toBe(404);
		// Its outputs went with it; the kept runs still have theirs (positive control).
		expect(await asOwner('SELECT 1 FROM run_series WHERE run_id = $1', [ids[0]])).toHaveLength(0);
		expect((await asOwner('SELECT 1 FROM run_series WHERE run_id = $1', [ids[1]])).length).toBeGreaterThan(0);
	});

	it('trims only the project it runs in', async () => {
		vi.stubEnv('RUNS_KEPT_PER_PROJECT', '1');
		const u = await signUp('Twoprojects');
		const a = await runnable(u);
		const b = await runnable(u);
		const runA = (await u.call('POST', `/projects/${a}/runs`, {})).body.run.id;
		const res = await u.call('POST', `/projects/${b}/runs`, {});
		expect(res.body.removedRunIds).toEqual([]);
		expect((await u.call('GET', `/projects/${a}/runs/${runA}`)).status).toBe(200);
	});
});

describe('GET /projects/:id/model-input', () => {
	it('returns what a run uses: merged settings, the model, the first series of each kind by name', async () => {
		const u = await signUp('Inputter');
		const projectId = await runnable(u);
		// A second rainfall series, named to sort after the unnamed one: the run ignores it.
		const other = { kind: 'rain_catchment_mm', name: 'zz backup', unit: 'mm', startDate: '2020-01-01', values: new Array(30).fill(99) };
		expect((await u.call('PUT', `/projects/${projectId}/series`, other)).status).toBe(200);
		const res = await u.call('GET', `/projects/${projectId}/model-input`);
		expect(res.status).toBe(200);
		const input = res.body.input;
		expect(input.settings.runoffModel).toBe('legacy');
		expect(input.settings.gr4j).toEqual({ x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 });
		expect(input.model.nodes).toHaveLength(2);
		expect(Object.keys(input.series)).toEqual(['rain_catchment_mm']);
		expect(input.series.rain_catchment_mm.values[0]).toBe(10);
		// Running it in-process gives the stored run's summary.
		const run = (await u.call('POST', `/projects/${projectId}/runs`, {})).body.run;
		// (Compared through JSON, as stored: NaN and undefined don't survive the database.)
		expect(JSON.parse(JSON.stringify(runModel(input).summary))).toEqual(run.summary);
	});

	it('is readable by a viewer, and hidden (404) from anyone without access', async () => {
		const owner = await signUp('Inputowner');
		const projectId = await runnable(owner);
		const viewer = await signUp('Inputviewer');
		const stranger = await signUp('Inputstranger');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await viewer.call('GET', `/projects/${projectId}/model-input`)).status).toBe(200);
		expect((await stranger.call('GET', `/projects/${projectId}/model-input`)).status).toBe(404);
	});
});
