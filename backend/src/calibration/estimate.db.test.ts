// The time limits on a run of the calibration rules, end to end: the request
// refuses a search estimated past them from the model's size (./estimate.ts),
// whatever the server's clock does; a job pauses its fit by the clock before
// its own limit, so a worker slower than the estimate costs more jobs, never
// another result, and one far slower stops the run, saying so (store.ts
// fitNextCase). Invented values.
import { defaultCalibrationRules, runModel, type CalibrationRules, type ModelInput } from '@water-management/engine';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { JobRelease } from '../jobs/errors.js';
import { fitNextCase } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;
const projects: string[] = [];
afterAll(() => retirePendingJobs(...projects));
afterEach(() => {
	vi.restoreAllMocks();
});

const rulesWith = (starts: number, budget: number): CalibrationRules => ({
	...defaultCalibrationRules(),
	run: { seed: 3, starts, budget },
	cases: { bounds: ['typical'], objectives: ['kgePrime'] },
	selection: { test: 'split', score: 'kgePrime' },
	after: { onNewData: 'off', ensemble: false }
});

/** A farm draining to a gauge over `years` of daily record, its flow the model's own, and the rules saved. */
async function calibratable(owner: User, rules: CalibrationRules, years: number) {
	const projectId = (await owner.call('POST', '/projects', { name: 'Fit time' })).body.project.id as string;
	projects.push(projectId);
	const gauge = node('Gauge', null);
	const farm = node('Farm', gauge.id, { areaKm2: 40, pctRunoffToDam: 0 });
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [gauge, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { runoffModel: 'gr4j', apanMm: monthly(150) } })).status).toBe(200);
	const days = years * 365;
	const rain = Array.from({ length: days }, (_, t) => (t % 5 === 0 ? 12 + (t % 37) : t % 11 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2010-10-01', values: rain })).status).toBe(200);
	const input = (await owner.call('GET', `/projects/${projectId}/model-input`)).body.input as ModelInput;
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow' && s.nodeId === null)!.values;
	const observed = flow.map((q) => Math.round(((q ?? 0) / 86_400) * 1e6) / 1e6);
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2010-10-01', values: observed })).status).toBe(200);
	const current = (await owner.call('GET', `/projects/${projectId}`)).body.project.settings;
	const patched = await owner.call('PATCH', `/projects/${projectId}`, { settings: { gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7 }, calibrationRules: { ...rules, revision: current.calibrationRules.revision } } });
	expect(patched.status, JSON.stringify(patched.body)).toBe(200);
	return projectId;
}

const count = async (projectId: string) => Number((await asOwner('SELECT count(*) FROM auto_calibration WHERE project_id = $1', [projectId]))[0]!.count);

describe('the time limits on a run of the calibration rules', () => {
	it('refuses a search estimated past its whole limit, the same however slow the server’s clock, and queues nothing', async () => {
		const owner = await signUp('FitTimeRefused');
		// Thirty years at the largest search the rules allow: far past the limit.
		const big = await calibratable(owner, rulesWith(10, 10_000), 30);
		const first = await owner.call('POST', `/projects/${big}/auto-calibrations`, {});
		expect(first.status).toBe(400);
		expect(first.body.error).toMatch(
			/^the calibration rules can't run: the rules would take up to about \d+ hours on the server \(1 fit of 120000 model runs each\), more than a run of the rules may take \(6 hours\): lower the model runs per fit, the starts or the fits in the calibration rules$/
		);
		// A clock that leaps a minute a reading: the same refusal, word for word.
		let t = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (t += 60_000));
		expect(await owner.call('POST', `/projects/${big}/auto-calibrations`, {})).toEqual(first);
		expect(await count(big)).toBe(0);
		// Positive control: a small search on the same clock is queued.
		const small = await calibratable(owner, rulesWith(1, 60), 4);
		expect((await owner.call('POST', `/projects/${small}/auto-calibrations`, {})).status).toBe(202);
		expect(await count(small)).toBe(1);
	});

	it('pauses a fit by the clock and goes on in the next job; a worker far slower than estimated stops the run, saying so', async () => {
		const owner = await signUp('FitTimeSlow');
		const projectId = await calibratable(owner, rulesWith(1, 60), 4);
		const res = await owner.call('POST', `/projects/${projectId}/auto-calibrations`, {});
		expect(res.status).toBe(202);
		const id = res.body.calibration.id as string;
		const progress = async () => true;
		// The worker's clock as a far-too-short estimate would read it: a minute passes every reading.
		let t = 0;
		const slow = () => (t += 60_000);
		// Each job stops before its 4 minutes would pass, with its work stored for the next.
		expect(await withUser(owner.id, (db) => fitNextCase(db, projectId, id, progress, { now: slow }))).toBe('next');
		const [first] = await asOwner('SELECT work, cases, status FROM auto_calibration WHERE id = $1', [id]);
		expect(first).toMatchObject({ status: 'running', cases: [], work: { case: 0, jobs: 1, fits: [], total: 180 } });
		expect(first!.work.done).toBeGreaterThan(0);
		expect(first!.work.done).toBeLessThan(5);
		expect(first!.work.search.evaluations).toBe(first!.work.done);
		// At that pace a fit takes far more jobs than estimated: the run stops, saying why, its work cleared.
		let last: string | false = 'next';
		for (let i = 0; i < 20 && last === 'next'; i++) last = await withUser(owner.id, (db) => fitNextCase(db, projectId, id, progress, { now: slow }));
		expect(last).toBe('failed');
		const failed = (await owner.call('GET', `/projects/${projectId}/auto-calibrations/${id}`)).body.calibration;
		expect(failed).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/^a fit took more background jobs than estimated \(\d+\), so the server is far slower than the estimate: lower the model runs per fit or the starts in the calibration rules, and run them again$/),
			cases: [],
			work: null
		});
		expect((await asOwner('SELECT work FROM auto_calibration WHERE id = $1', [id]))[0]!.work).toBeNull();
	});

	it('hands back a job claimed too late in the worker’s tick, writing nothing; with time enough it fits', async () => {
		const owner = await signUp('FitTimeLate');
		const projectId = await calibratable(owner, rulesWith(1, 60), 4);
		const id = (await owner.call('POST', `/projects/${projectId}/auto-calibrations`, {})).body.calibration.id as string;
		const progress = async () => true;
		await expect(withUser(owner.id, (db) => fitNextCase(db, projectId, id, progress, { deadline: Date.now() + 20_000 }))).rejects.toBeInstanceOf(JobRelease);
		expect((await asOwner('SELECT work, cases FROM auto_calibration WHERE id = $1', [id]))[0]).toEqual({ work: null, cases: [] });
		// Positive control: a minute and a half left is time enough for this small fit.
		expect(['next', 'complete']).toContain(await withUser(owner.id, (db) => fitNextCase(db, projectId, id, progress, { deadline: Date.now() + 90_000 })));
		const fitted = (await owner.call('GET', `/projects/${projectId}/auto-calibrations/${id}`)).body.calibration;
		expect(fitted.cases).toHaveLength(1);
		expect(fitted.cases[0].error).toBeNull();
	});
});
