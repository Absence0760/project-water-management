// Run storage cap (RUNS_KEPT_PER_PROJECT, runs/execute.ts trimRuns).
import { afterEach, describe, expect, it, vi } from 'vitest';
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
