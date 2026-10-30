// The time limit on a run of the calibration rules, end to end: the request
// refuses a search estimated past it from the model's size (./estimate.ts),
// whatever the server's clock does, and a fit that runs past it anyway is
// stopped by its job and the run failed, saying so, rather than cut off by
// the worker's timeout (store.ts fitNextCase). Invented values.
import { defaultCalibrationRules, runModel, type CalibrationRules, type ModelInput } from '@water-management/engine';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { AUTO_CASE_SECONDS_MAX } from './schema.js';
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

describe('the time limit on a run of the calibration rules', () => {
	it('refuses a search estimated past 4 minutes a fit, the same however slow the server’s clock, and queues nothing', async () => {
		const owner = await signUp('FitTimeRefused');
		// Thirty years at the largest search the rules allow: far past the limit.
		const big = await calibratable(owner, rulesWith(10, 10_000), 30);
		const first = await owner.call('POST', `/projects/${big}/auto-calibrations`, {});
		expect(first.status).toBe(400);
		expect(first.body.error).toMatch(
			/^the calibration rules can't run: each fit would take up to about \d+ minutes on the server \(120000 model runs\), more than a background job may run \(4 minutes\): lower the model runs per fit or the starts in the calibration rules$/
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

	it('stops a fit that runs past the limit anyway and fails the run, saying so; one inside it is fitted', async () => {
		const owner = await signUp('FitTimeOverran');
		const projectId = await calibratable(owner, rulesWith(1, 60), 4);
		const res = await owner.call('POST', `/projects/${projectId}/auto-calibrations`, {});
		expect(res.status).toBe(202);
		const id = res.body.calibration.id as string;
		const progress = async () => true;
		// The worker's clock as the estimate's miss would read it: a minute passes every model run.
		let t = 0;
		const slow = () => (t += 60_000);
		expect(await withUser(owner.id, (db) => fitNextCase(db, projectId, id, progress, { now: slow }))).toBe('failed');
		const failed = (await owner.call('GET', `/projects/${projectId}/auto-calibrations/${id}`)).body.calibration;
		expect(failed).toMatchObject({
			status: 'failed',
			error: `a fit ran past the ${AUTO_CASE_SECONDS_MAX / 60} minutes a background job may run, longer than it was estimated to take: lower the model runs per fit or the starts in the calibration rules, and run them again`,
			cases: []
		});

		// Positive control: the same rules on a clock that keeps time fit the case (the failed run's job retired first,
		// since one person has one run at a time).
		await retirePendingJobs(projectId);
		const again = await calibratable(owner, rulesWith(1, 60), 4);
		const res2 = await owner.call('POST', `/projects/${again}/auto-calibrations`, {});
		expect(res2.status).toBe(202);
		const id2 = res2.body.calibration.id as string;
		expect(['next', 'complete']).toContain(await withUser(owner.id, (db) => fitNextCase(db, again, id2, progress)));
		const fitted = (await owner.call('GET', `/projects/${again}/auto-calibrations/${id2}`)).body.calibration;
		expect(fitted).toMatchObject({ status: expect.stringMatching(/^(running|complete)$/), error: null });
		expect(fitted.cases).toHaveLength(1);
		expect(fitted.cases[0].error).toBeNull();
	});
});
