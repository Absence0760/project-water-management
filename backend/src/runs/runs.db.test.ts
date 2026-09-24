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
	// GR4J (the default runoff model) refuses to run without A-pan evaporation.
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	const series = { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain };
	expect((await u.call('PUT', `/projects/${projectId}/series`, series)).status).toBe(200);
	return projectId;
}

afterEach(() => vi.unstubAllEnvs());

describe('POST /projects/:id/runs', () => {
	it('refuses a GR4J run with no evaporation and says how to fix it; legacy still runs', async () => {
		const u = await signUp('Nopan');
		const projectId = await runnable(u);
		const set = async (settings: object) => expect((await u.call('PATCH', `/projects/${projectId}`, { settings })).status).toBe(200);
		await set({ apanMm: monthly(0) });
		const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'no pan' });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/GR4J needs potential evaporation.*Settings → Demand/);
		expect((await u.call('GET', `/projects/${projectId}/runs`)).body.runs).toEqual([]);
		// Positive control: the same project runs under legacy, which doesn't use evaporation.
		await set({ runoffModel: 'legacy' });
		expect((await u.call('POST', `/projects/${projectId}/runs`, { label: 'legacy' })).status).toBe(201);
	});
});

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
		expect(input.settings.runoffModel).toBe('gr4j');
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

describe('fit provenance and calibration exclusions (issue #4)', () => {
	const period = { start: '2020-01-01', end: '2020-01-30', waterYears: [2019], scores: { days: 30, kgePrime: 0.7 } };
	const record = {
		fittedAt: '2026-09-24T10:00:00.000Z',
		engineVersion: '0.6.0',
		model: 'legacy',
		objective: 'kgePrime',
		bounds: 'wide',
		seed: 42,
		budget: 300,
		evaluations: 900,
		cancelled: false,
		free: ['a', 'b'],
		params: { a: 0.2, b: 1.4, summerFactor: 0.1, winterFactor: 1 },
		startParams: { a: 0.09, b: 1.2, summerFactor: 0.1, winterFactor: 1 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		calibrationStart: null,
		calibrationEnd: null,
		exclusions: [{ waterYear: 2015, reason: 'suspect rain' }],
		validate: true,
		validationRecord: null,
		fit: period,
		before: period,
		splitSample: { params: { a: 0.21, b: 1.3 }, calibration: period, validation: { ...period, scores: { days: 15, kgePrime: 0.4 } } },
		differential: null,
		independentRecord: null,
		notes: ['The record has 0 water years…'],
		editedParams: []
	};
	const exclusions = [{ waterYear: 2015, reason: 'suspect rain' }];

	async function fitted(u: User) {
		const projectId = await runnable(u);
		const current = (await u.call('GET', `/projects/${projectId}`)).body.project.settings;
		const res = await u.call('PATCH', `/projects/${projectId}`, {
			settings: { calibration: { ...current.calibration, a: 0.2, b: 1.4 }, calibrationExclusions: exclusions, fitRecord: record }
		});
		expect(res.status).toBe(200);
		return { projectId, settings: res.body.project.settings };
	}

	it('stores the fit record and exclusions, snapshots them in each run, and marks a later hand edit', async () => {
		const u = await signUp('Provenance');
		const { projectId, settings } = await fitted(u);
		expect(settings.fitRecord).toMatchObject({ seed: 42, objective: 'kgePrime', editedParams: [] });
		expect(settings.calibrationExclusions).toEqual(exclusions);

		const first = (await u.call('POST', `/projects/${projectId}/runs`, { label: 'fitted' })).body.run.id;
		const detail = (await u.call('GET', `/projects/${projectId}/runs/${first}`)).body.run;
		expect(detail.settings.fitRecord).toMatchObject({ seed: 42, budget: 300, engineVersion: '0.6.0', editedParams: [] });
		expect(detail.settings.fitRecord.splitSample.validation.scores.kgePrime).toBe(0.4);
		expect(detail.settings.calibrationExclusions).toEqual(exclusions);

		// Edit a fitted parameter by hand: the stored record is marked, not cleared.
		const edited = await u.call('PATCH', `/projects/${projectId}`, { settings: { calibration: { ...settings.calibration, b: 1.5 } } });
		expect(edited.body.project.settings.fitRecord.editedParams).toEqual(['b']);
		const second = (await u.call('POST', `/projects/${projectId}/runs`, { label: 'edited' })).body.run.id;
		expect((await u.call('GET', `/projects/${projectId}/runs/${second}`)).body.run.settings.fitRecord.editedParams).toEqual(['b']);
		// The first run keeps the record as it was when it ran.
		expect((await u.call('GET', `/projects/${projectId}/runs/${first}`)).body.run.settings.fitRecord.editedParams).toEqual([]);

		const cmp = await u.call('GET', `/compare/runs?a=${projectId}:${first}&b=${projectId}:${second}`);
		expect(cmp.status).toBe(200);
		expect(cmp.body.changes.map((c: { text: string }) => c.text)).toContain('Fit record: parameters edited since the fit (b)');
	});

	it('a client cannot hide an edit by sending editedParams: []', async () => {
		const u = await signUp('Hider');
		const { projectId, settings } = await fitted(u);
		const res = await u.call('PATCH', `/projects/${projectId}`, {
			settings: { calibration: { ...settings.calibration, a: 0.5 }, fitRecord: { ...record, editedParams: [] } }
		});
		expect(res.body.project.settings.fitRecord.editedParams).toEqual(['a']);
	});

	it('rejects an exclusion without a reason, and a fit record without its seed', async () => {
		const u = await signUp('Rejecter');
		const projectId = await runnable(u);
		const blank = await u.call('PATCH', `/projects/${projectId}`, { settings: { calibrationExclusions: [{ waterYear: 2015, reason: '' }] } });
		expect(blank.status).toBe(400);
		const { seed: _seed, ...noSeed } = record;
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { fitRecord: noSeed } })).status).toBe(400);
	});

	it("a run's provenance is visible to a viewer and hidden (404) from anyone without access", async () => {
		const owner = await signUp('Provowner');
		const { projectId } = await fitted(owner);
		const runId = (await owner.call('POST', `/projects/${projectId}/runs`, {})).body.run.id;
		const viewer = await signUp('Provviewer');
		const stranger = await signUp('Provstranger');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const seen = await viewer.call('GET', `/projects/${projectId}/runs/${runId}`);
		expect(seen.status).toBe(200);
		expect(seen.body.run.settings.fitRecord.seed).toBe(42);
		expect((await stranger.call('GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(404);
		// The snapshot is stored in model_run itself.
		const rows = await asOwner(`SELECT inputs->'settings'->'fitRecord'->>'seed' AS seed FROM model_run WHERE id = $1`, [runId]);
		expect(rows).toEqual([{ seed: '42' }]);
	});
});
