// A model run holds no database connection while the engine runs
// (runs/execute.ts runOutsideTransaction, docs/architecture.md § A model run):
// its inputs are read in one transaction, the engine runs with none open,
// and the run is stored in a second, which checks again that the caller may
// run it. The engine is injected (`compute`), so each test acts at the exact
// moment the engine is running: no sleeps.
//  - with a pool of ONE connection, a query succeeds while a run computes;
//  - the project edited mid-run: the run stores the inputs it computed from,
//    so it still reproduces exactly;
//  - an editor removed mid-run stores nothing (positive control: one who
//    stays does);
//  - a scenario edited or deleted mid-run stores nothing; a renamed one does.
import { canonicalJson, type ModelOutput } from '@water-management/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { closePool, getPool } from '../db/pool.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { loadScenario, runScenario } from '../scenarios/execute.js';
import { computeRun, type ComputeRun, loadRunInput, runLiveModel } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function catchment(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Held' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { damCapacityM3: 50_000 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return { projectId, farm };
}

/** The engine, after `during` has run while it "computes". */
const engineAfter =
	(during: () => Promise<void>): ComputeRun =>
	async (plan) => {
		await during();
		return computeRun(plan);
	};

const runsOf = async (u: User, projectId: string) => (await u.call('GET', `/projects/${projectId}/runs`)).body.runs as { id: string; label: string }[];

afterEach(async () => {
	vi.unstubAllEnvs();
	// The next test gets a fresh pool of the usual size.
	await closePool();
});

describe('a model run and the connection pool', () => {
	it('holds no connection while the engine runs: a pool of one serves another query meanwhile', async () => {
		const u = await signUp('Pool');
		const { projectId } = await catchment(u);
		await closePool();
		vi.stubEnv('DB_POOL_MAX', '1');
		let checked = false;
		let other: unknown;
		const run = await runLiveModel(
			u.id,
			projectId,
			'held',
			'manual',
			async (db, r) => (await db.query<{ id: string }>('SELECT id FROM model_run WHERE id = $1', [r.id])).rows[0]!.id,
			engineAfter(async () => {
				const pool = getPool();
				expect(pool.options.max).toBe(1);
				// Fails at once, rather than waiting below, if the run still holds its connection.
				expect(pool.totalCount - pool.idleCount, 'connections checked out while the engine runs').toBe(0);
				checked = true;
				// With the run's connection still held, this would wait for ever on a pool of one.
				other = await withUser(u.id, async (db) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM model_run WHERE project_id = $1', [projectId])).rows[0]!.n);
			})
		);
		expect(checked).toBe(true);
		// The other query ran before the run was stored.
		expect(other).toBe(0);
		expect((await runsOf(u, projectId)).map((r) => r.id)).toEqual([run]);
	});

	it('stores the inputs the engine ran on when the project changes mid-run, so the run still reproduces', async () => {
		const u = await signUp('Edited');
		const { projectId } = await catchment(u);
		let output: ModelOutput | undefined;
		const id = await runLiveModel(
			u.id,
			projectId,
			'before the edit',
			'manual',
			async (_db, r) => r.id,
			async (plan) => {
				expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(90) } })).status).toBe(200);
				output = computeRun(plan);
				return output;
			}
		);
		const input = await withUser(u.id, (db) => loadRunInput(db, id));
		// The snapshot is the pre-edit input, and it reproduces the stored summary exactly.
		expect(input.settings.apanMm).toEqual(monthly(150));
		expect(canonicalJson(computeRun({ projectId, label: '', input, trigger: 'manual' }).summary)).toBe(canonicalJson(JSON.parse(JSON.stringify(output!.summary))));
		const repro = await u.call('GET', `/projects/${projectId}/runs/${id}/reproduce`);
		expect(repro.body.status).toBe('identical');
		// The live project did change: "what changed since this run" has the edit to show.
		const live = (await u.call('GET', `/projects/${projectId}/model-input`)).body.input;
		expect(live.settings.apanMm).toEqual(monthly(90));
	});

	it('stores nothing when the editor is removed while the engine runs (positive control: one who stays)', async () => {
		const owner = await signUp('Owner');
		const editor = await signUp('Editor');
		const { projectId } = await catchment(owner);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		const stored = await runLiveModel(editor.id, projectId, 'stays', 'manual', async (_db, r) => r.id, engineAfter(async () => {}));
		expect((await runsOf(owner, projectId)).map((r) => r.id)).toEqual([stored]);

		const removed = runLiveModel(
			editor.id,
			projectId,
			'removed',
			'manual',
			async (_db, r) => r.id,
			engineAfter(async () => {
				expect((await owner.call('DELETE', `/projects/${projectId}/members/${editor.id}`)).status).toBe(204);
			})
		);
		await expect(removed).rejects.toMatchObject({ status: 404 });
		await expect(removed).rejects.toBeInstanceOf(ApiError);
		expect((await runsOf(owner, projectId)).map((r) => r.label)).toEqual(['stays']);
	});

	it('stores nothing when an editor is made a viewer mid-run, and answers 403', async () => {
		const owner = await signUp('Owner');
		const editor = await signUp('Demoted');
		const { projectId } = await catchment(owner);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		const run = runLiveModel(
			editor.id,
			projectId,
			'demoted',
			'manual',
			async (_db, r) => r.id,
			engineAfter(async () => {
				expect((await owner.call('PATCH', `/projects/${projectId}/members/${editor.id}`, { role: 'viewer' })).status).toBe(200);
			})
		);
		await expect(run).rejects.toMatchObject({ status: 403 });
		expect(await runsOf(owner, projectId)).toEqual([]);
	});
});

describe('a scenario run and the connection pool', () => {
	async function scenario(u: User) {
		const c = await catchment(u);
		const base = (await u.call('POST', `/projects/${c.projectId}/runs`, { label: 'base' })).body.run.id as string;
		const ops = [{ op: 'node.set', nodeId: c.farm.id, field: 'damCapacityM3', value: 80_000 }];
		const res = await u.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'Raise', baseRunId: base, ops });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return { ...c, base, sid: res.body.scenario.id as string };
	}
	// As the route authorizes a team scenario's run: an editor, and the scenario as they read it.
	const as = (u: User, projectId: string, sid: string) => ({
		run: (compute: ComputeRun) =>
			runScenario(
				u.id,
				projectId,
				undefined,
				async (db) => ({ role: await requireRole(db, projectId, 'editor'), scenario: await loadScenario(db, projectId, sid) }),
				async (_db, r) => r.id,
				compute
			)
	});
	const scenarioRuns = async (u: User, projectId: string, sid: string) =>
		withUser(u.id, async (db) => (await db.query<{ label: string }>('SELECT label FROM model_run WHERE project_id = $1 AND scenario_id = $2', [projectId, sid])).rows);

	it('holds no connection while the engine runs, and a rename mid-run still stores (positive control)', async () => {
		const u = await signUp('Scen');
		const { projectId, sid } = await scenario(u);
		await closePool();
		vi.stubEnv('DB_POOL_MAX', '1');
		let checked = false;
		await as(u, projectId, sid).run(
			engineAfter(async () => {
				const pool = getPool();
				// Fails at once, rather than waiting below, if the run still holds its connection.
				expect(pool.totalCount - pool.idleCount, 'connections checked out while the engine runs').toBe(0);
				checked = true;
				expect((await u.call('PATCH', `/projects/${projectId}/scenarios/${sid}`, { name: 'Raise, renamed' })).status).toBe(200);
			})
		);
		expect(checked).toBe(true);
		// The run records the scenario as it was computed: its name then.
		expect(await scenarioRuns(u, projectId, sid)).toEqual([{ label: 'Raise' }]);
	});

	it('stores nothing and answers 409 when the ops change mid-run', async () => {
		const u = await signUp('Scen');
		const { projectId, sid, farm } = await scenario(u);
		const run = as(u, projectId, sid).run(
			engineAfter(async () => {
				const ops = [{ op: 'node.set', nodeId: farm.id, field: 'damCapacityM3', value: 120_000 }];
				expect((await u.call('PATCH', `/projects/${projectId}/scenarios/${sid}`, { ops })).status).toBe(200);
			})
		);
		await expect(run).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed while it ran/) });
		expect(await scenarioRuns(u, projectId, sid)).toEqual([]);
	});

	it('stores nothing and answers 404 when the scenario is deleted mid-run', async () => {
		const u = await signUp('Scen');
		const { projectId, sid } = await scenario(u);
		const run = as(u, projectId, sid).run(
			engineAfter(async () => {
				expect((await u.call('DELETE', `/projects/${projectId}/scenarios/${sid}`)).status).toBe(204);
			})
		);
		await expect(run).rejects.toMatchObject({ status: 404 });
		expect(await scenarioRuns(u, projectId, sid)).toEqual([]);
	});

	it('stores nothing and answers 403 when the editor is made a viewer mid-run (positive control: before, they run it)', async () => {
		const owner = await signUp('Owner');
		const editor = await signUp('Editor');
		const { projectId, sid } = await scenario(owner);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		await as(editor, projectId, sid).run(engineAfter(async () => {}));
		const run = as(editor, projectId, sid).run(
			engineAfter(async () => {
				expect((await owner.call('PATCH', `/projects/${projectId}/members/${editor.id}`, { role: 'viewer' })).status).toBe(200);
			})
		);
		await expect(run).rejects.toMatchObject({ status: 403 });
		expect(await scenarioRuns(owner, projectId, sid)).toHaveLength(1);
	});
});
