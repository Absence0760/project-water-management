// Run storage cap (RUNS_KEPT_PER_PROJECT, runs/execute.ts trimRuns) and the
// model-input read that in-browser calibration runs on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runModelChecked } from '@water-management/engine';
import { asOwner, makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { executeRun, trimRuns } from './execute.js';

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
	it('refuses a GR4J run with no evaporation and says how to fix it', async () => {
		const u = await signUp('Nopan');
		const projectId = await runnable(u);
		const set = async (settings: object) => expect((await u.call('PATCH', `/projects/${projectId}`, { settings })).status).toBe(200);
		await set({ apanMm: monthly(0) });
		const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'no pan' });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/GR4J needs potential evaporation.*Settings → Demand/);
		expect((await u.call('GET', `/projects/${projectId}/runs`)).body.runs).toEqual([]);
		// The legacy model, which didn't use evaporation, was removed in engine 1.0.0: no way round it.
		const legacy = await u.call('PATCH', `/projects/${projectId}`, { settings: { runoffModel: 'legacy' } });
		expect(legacy.status).toBe(400);
		expect(JSON.stringify(legacy.body)).toMatch(/legacy runoff model was removed in engine 1\.0\.0/);
		// Positive control: with evaporation it runs.
		await set({ apanMm: monthly(150) });
		expect((await u.call('POST', `/projects/${projectId}/runs`, { label: 'pan' })).status).toBe(201);
	});

	it('refuses flow shares over 100 % with the reason, stores no run, and runs once they fit (engine 0.27.1)', async () => {
		const u = await signUp('Overshare');
		const projectId = await runnable(u);
		// Each share is within 0–1 (the model save checks that); two farms at 0.75 make 150 %.
		const model = (await u.call('GET', `/projects/${projectId}/model`)).body as { nodes: (Omit<ReturnType<typeof node>, 'flowShareManual'> & { flowShareManual: number | null })[] };
		const outlet = model.nodes.find((n) => n.downstreamNodeId === null)!;
		model.nodes.push({ ...node('Lower', outlet.id), sortOrder: 2 });
		const share = async (v: number) => {
			for (const n of model.nodes) if (n.kind === 'farm') n.flowShareManual = v;
			expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		};
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { flowShareMethod: 'manual' } })).status).toBe(200);
		await share(0.75);
		const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'over' });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/flow shares sum to 150\.00%, more than 100%.*add up to 100%/);
		expect((await u.call('GET', `/projects/${projectId}/runs`)).body.runs).toEqual([]);
		// Positive control: the same farms at 50 % each run.
		await share(0.5);
		expect((await u.call('POST', `/projects/${projectId}/runs`, { label: 'fits' })).status).toBe(201);
	});

	it('reports which stored runs used the legacy runoff model (audit H1), on the list and on each run', async () => {
		const u = await signUp('Legacyflag');
		const projectId = await runnable(u);
		const gr4jRunId = (await u.call('POST', `/projects/${projectId}/runs`, { label: 'gr4j' })).body.run.id as string;
		// A run saved before engine 1.0.0 removed the legacy model (the API can't make one now).
		const legacyRunId = (await u.call('POST', `/projects/${projectId}/runs`, { label: 'legacy' })).body.run.id as string;
		await makeStoredLegacyRun(legacyRunId);

		const list = (await u.call('GET', `/projects/${projectId}/runs`)).body.runs as { id: string; legacy: boolean }[];
		expect(list.find((r) => r.id === gr4jRunId)?.legacy).toBe(false);
		expect(list.find((r) => r.id === legacyRunId)?.legacy).toBe(true);

		expect((await u.call('GET', `/projects/${projectId}/runs/${gr4jRunId}`)).body.run.legacy).toBe(false);
		expect((await u.call('GET', `/projects/${projectId}/runs/${legacyRunId}`)).body.run.legacy).toBe(true);
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

	it('holds the cap when two runs are saved at the same moment: the second trim waits for the first to commit', async () => {
		const u = await signUp('Racer');
		const projectId = await runnable(u);
		for (const label of ['old 1', 'old 2']) expect((await u.call('POST', `/projects/${projectId}/runs`, { label })).status).toBe(201);
		// Two saves in flight at once, as when two people press Run together. The first has saved
		// and trimmed but not committed; the second saves and trims before the first commits.
		let commitFirst = () => {};
		const firstMayCommit = new Promise<void>((r) => (commitFirst = r));
		let firstTrimmed = () => {};
		const firstHasTrimmed = new Promise<void>((r) => (firstTrimmed = r));
		const first = withUser(u.id, async (db) => {
			await executeRun(db, projectId, 'new 1');
			const removed = await trimRuns(db, projectId, 2);
			firstTrimmed();
			await firstMayCommit;
			return removed;
		});
		await firstHasTrimmed;
		let secondDone = false;
		const second = withUser(u.id, async (db) => {
			await executeRun(db, projectId, 'new 2');
			return trimRuns(db, projectId, 2);
		}).finally(() => (secondDone = true));
		// Let the first commit once the second has finished (no lock) or is waiting on the trim lock.
		const waitingOnTrim = async () =>
			(await asOwner(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).length > 0;
		await expect.poll(async () => secondDone || (await waitingOnTrim()), { timeout: 10_000 }).toBe(true);
		commitFirst();
		const removed = [...(await first), ...(await second)];
		// 4 runs, cap 2: both old runs go, each reported once.
		expect(removed).toHaveLength(2);
		expect(new Set(removed).size).toBe(2);
		const kept = (await u.call('GET', `/projects/${projectId}/runs`)).body.runs.map((r: { label: string }) => r.label);
		expect(kept.sort()).toEqual(['new 1', 'new 2']);
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
		// Running it in-process (as a saved run: with its self-checks) gives the stored run's summary.
		const run = (await u.call('POST', `/projects/${projectId}/runs`, {})).body.run;
		// (Compared through JSON, as stored: NaN and undefined don't survive the database.)
		expect(JSON.parse(JSON.stringify(runModelChecked(input).summary))).toEqual(run.summary);
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
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'wide',
		seed: 42,
		budget: 300,
		evaluations: 900,
		cancelled: false,
		free: ['x1', 'x3'],
		params: { x1: 500, x2: 0, x3: 60, x4: 1.7 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		calibrationStart: null,
		calibrationEnd: null,
		exclusions: [{ waterYear: 2015, reason: 'suspect rain' }],
		validate: true,
		validationRecord: null,
		fit: period,
		before: period,
		splitSample: { params: { x1: 510, x2: 0, x3: 58, x4: 1.7 }, calibration: period, validation: { ...period, scores: { days: 15, kgePrime: 0.4 } } },
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
			settings: { gr4j: { ...current.gr4j, x1: 500, x3: 60 }, calibrationExclusions: exclusions, fitRecord: record }
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
		const edited = await u.call('PATCH', `/projects/${projectId}`, { settings: { gr4j: { ...settings.gr4j, x3: 70 } } });
		expect(edited.body.project.settings.fitRecord.editedParams).toEqual(['x3']);
		const second = (await u.call('POST', `/projects/${projectId}/runs`, { label: 'edited' })).body.run.id;
		expect((await u.call('GET', `/projects/${projectId}/runs/${second}`)).body.run.settings.fitRecord.editedParams).toEqual(['x3']);
		// The first run keeps the record as it was when it ran.
		expect((await u.call('GET', `/projects/${projectId}/runs/${first}`)).body.run.settings.fitRecord.editedParams).toEqual([]);

		const cmp = await u.call('GET', `/compare/runs?a=${projectId}:${first}&b=${projectId}:${second}`);
		expect(cmp.status).toBe(200);
		expect(cmp.body.changes.map((c: { text: string }) => c.text)).toContain('Fit record: parameters edited since the fit (x3)');
	});

	it('a client cannot hide an edit by sending editedParams: []', async () => {
		const u = await signUp('Hider');
		const { projectId, settings } = await fitted(u);
		const res = await u.call('PATCH', `/projects/${projectId}`, {
			settings: { gr4j: { ...settings.gr4j, x1: 900 }, fitRecord: { ...record, editedParams: [] } }
		});
		expect(res.body.project.settings.fitRecord.editedParams).toEqual(['x1']);
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

describe('settings.pe (engine ≥ 0.31.0, issue #39)', () => {
	const pe = { kind: 'monthly', mm: [90, 120, 150, 170, 150, 130, 90, 60, 45, 45, 55, 70], source: 'Station FAO-56 ET₀ × 1.0' };

	it('stores a monthly PE, reads it back, and runs GR4J on it; the run records it', async () => {
		const u = await signUp('Pe');
		const projectId = await runnable(u);
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.settings.pe).toEqual({ kind: 'pan' });
		const panRun = await u.call('POST', `/projects/${projectId}/runs`, { label: 'pan' });
		expect(panRun.status).toBe(201);

		const patched = await u.call('PATCH', `/projects/${projectId}`, { settings: { pe: { ...pe, source: `  ${pe.source} ` } } });
		expect(patched.status).toBe(200);
		expect(patched.body.project.settings.pe).toEqual(pe);
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.settings.pe).toEqual(pe);

		const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'monthly PE' });
		expect(res.status).toBe(201);
		const run = (await u.call('GET', `/projects/${projectId}/runs/${res.body.run.id}`)).body.run;
		expect(run.settings.pe).toEqual(pe);
		expect((await u.call('GET', `/projects/${projectId}/runs/${panRun.body.run.id}`)).body.run.settings.pe).toEqual({ kind: 'pan' });

		// Back to pan: replaced whole, the monthly row doesn't linger.
		const back = await u.call('PATCH', `/projects/${projectId}`, { settings: { pe: { kind: 'pan' } } });
		expect(back.status).toBe(200);
		expect(back.body.project.settings.pe).toEqual({ kind: 'pan' });
	});

	it('rejects an invalid PE with a 400 and no raw DB error text, and leaves the stored one alone', async () => {
		const u = await signUp('Pebad');
		const projectId = await runnable(u);
		for (const bad of [{ kind: 'et0' }, { ...pe, mm: pe.mm.slice(1) }, { ...pe, mm: [...pe.mm.slice(1), -5] }, { ...pe, source: '' }, { ...pe, extra: 1 }]) {
			const res = await u.call('PATCH', `/projects/${projectId}`, { settings: { pe: bad } });
			expect(res.status, JSON.stringify(bad)).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/violates|constraint|relation|syntax error|column|pg_|SQLSTATE/i);
		}
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.settings.pe).toEqual({ kind: 'pan' });
	});

	it('refuses GR4J on a monthly PE of zeros with GR4J_NO_PET, even with A-pan set', async () => {
		const u = await signUp('Pezero');
		const projectId = await runnable(u); // A-pan 150 mm every month
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { pe: { ...pe, mm: monthly(0) } } })).status).toBe(200);
		const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'zero PE' });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/GR4J needs potential evaporation.*Settings → Demand/);
		expect((await u.call('GET', `/projects/${projectId}/runs`)).body.runs).toEqual([]);
		// Positive control: a non-zero monthly row runs.
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { pe } })).status).toBe(200);
		expect((await u.call('POST', `/projects/${projectId}/runs`, { label: 'PE' })).status).toBe(201);
	});
});
