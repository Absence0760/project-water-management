// Firm yield end to end (WP-3.6, 040_yield.sql): the POST /yield request
// checks, the `yield` job run as its acting user (the memory transport: the
// test runs the tick itself), the stored results and their RLS, progress on
// the job list, the per-user limit, and the job failing closed when the user
// lost the editor role.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(() => vi.unstubAllEnvs());

/** A dam draining into an outlet gauge, 90 days of rain, one saved run. */
async function catchment(owner: User, name = 'Yield') {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const dam = node('Dam', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 50_000, damInitialPct: 1, damMinPct: 0 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, dam], crops: [crop], cropAreas: [{ nodeId: dam.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, outlet, dam, runId: run.body.run.id as string };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

const tick = () => runTick({ feeds: false, reports: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error, progress FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null; progress: number | null };

describe('POST /projects/:id/yield', () => {
	it('an editor queues a firm yield; the job stores it and reports 100 % on the job list', async () => {
		const owner = await signUp('YieldOwner');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const jobId = res.body.jobId as string;
		// The same request while it waits is that job, not a second one.
		const again = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params: {} });
		expect(again.status).toBe(200);
		expect(again.body.jobId).toBe(jobId);

		await tick();
		expect(await job(jobId)).toMatchObject({ status: 'done', last_error: null, progress: 100 });
		const listed = (await owner.call('GET', `/projects/${c.projectId}/jobs`)).body.jobs.find((j: { id: string }) => j.id === jobId);
		expect(listed).toMatchObject({ kind: 'yield', status: 'done', progress: 100 });

		const got = await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`);
		expect(got.status).toBe(200);
		expect(got.body.results).toHaveLength(1);
		const r = got.body.results[0];
		expect(r).toMatchObject({ runId: c.runId, scenarioId: null, nodeId: c.dam.id, jobId, kind: 'firm', params: { pattern: 'constant', assurance: 1, tolerance: 0.001, points: 11 } });
		expect(r.points.point.capacityM3).toBe(50_000);
		expect(r.points.point.yieldM3Day).toBeGreaterThan(0);
		expect(r.points.point.failureDays).toBe(0);
		expect(r.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
		// And by job.
		expect((await owner.call('GET', `/projects/${c.projectId}/yield?jobId=${jobId}`)).body.results.map((x: { id: string }) => x.id)).toEqual([r.id]);
	});

	it('a storage–yield curve: 11 points from 0 to 2× the dam, non-decreasing here', async () => {
		const owner = await signUp('YieldCurve');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve', params: { pattern: 'demand' } });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		expect((await job(res.body.jobId)).status).toBe('done');
		const [r] = (await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}&nodeId=${c.dam.id}`)).body.results;
		expect(r.kind).toBe('curve');
		expect(r.points.baseCapacityM3).toBe(50_000);
		expect(r.points.points.map((p: { capacityM3: number }) => p.capacityM3)).toEqual(Array.from({ length: 11 }, (_, k) => k * 10_000));
		expect(r.points.monotone).toBe(true);
	});

	it('refuses a gauge, a node not in the run, both or neither target, and a curve for a farm with no dam', async () => {
		const owner = await signUp('YieldBad');
		const c = await catchment(owner);
		const post = (body: Record<string, unknown>) => owner.call('POST', `/projects/${c.projectId}/yield`, body);
		expect((await post({ nodeId: c.outlet.id, runId: c.runId, kind: 'firm' })).body.error).toBe('a yield is for a unit or dam node, not a gauge or other water user');
		expect((await post({ nodeId: crypto.randomUUID(), runId: c.runId, kind: 'firm' })).body.error).toBe('that node is not in this run or scenario');
		expect((await post({ nodeId: c.dam.id, kind: 'firm' })).status).toBe(400);
		expect((await post({ nodeId: c.dam.id, runId: c.runId, scenarioId: crypto.randomUUID(), kind: 'firm' })).status).toBe(400);
		expect((await post({ nodeId: c.dam.id, runId: c.runId, kind: 'curve', params: { points: 30 } })).status).toBe(400);
		expect((await post({ nodeId: c.dam.id, runId: crypto.randomUUID(), kind: 'firm' })).status).toBe(404);
		const noDam = await post({ nodeId: c.dam.id, runId: c.runId, kind: 'curve' });
		expect(noDam.status).toBe(202); // this one has a dam; the scenario below takes it away
		const sid = (
			await owner.call('POST', `/projects/${c.projectId}/scenarios`, {
				name: 'No dam',
				baseRunId: c.runId,
				ops: [{ op: 'node.set', nodeId: c.dam.id, field: 'damCapacityM3', value: 0 }]
			})
		).body.scenario.id;
		const res = await post({ nodeId: c.dam.id, scenarioId: sid, kind: 'curve' });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('a storage–yield curve needs a dam with a capacity above 0');
		await tick();
	});

	it('refuses a forecast run with 409 (a yield is judged on history, issue #51); an ordinary run of the same data is accepted', async () => {
		const owner = await signUp('YieldForecast');
		const c = await catchment(owner, 'Yield forecast');
		// 14 days of forecast rain after the 90-day record (2020-01-01 … 2020-03-30).
		const put = await owner.call('PUT', `/projects/${c.projectId}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2020-03-31', values: new Array(14).fill(5) });
		expect(put.status).toBe(200);
		const f = await owner.call('POST', `/projects/${c.projectId}/runs`, { label: 'forecast', forecast: true });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		const refused = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: f.body.run.id, kind: 'firm' });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/forecast run/);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'yield'`, [c.projectId]))[0].n).toBe(0);
		// Positive control: the ordinary run, made before the forecast was added.
		expect((await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).status).toBe(202);
	});

	it('a yield on a scenario runs its ops on the base run: a raised dam yields more', async () => {
		const owner = await signUp('YieldScenario');
		const c = await catchment(owner);
		const sid = (
			await owner.call('POST', `/projects/${c.projectId}/scenarios`, {
				name: 'Raise',
				baseRunId: c.runId,
				ops: [{ op: 'node.set', nodeId: c.dam.id, field: 'damCapacityM3', value: 200_000 }]
			})
		).body.scenario.id as string;
		const base = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' });
		const raised = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, scenarioId: sid, kind: 'firm' });
		expect([base.status, raised.status]).toEqual([202, 202]);
		await tick();
		const b = (await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).body.results[0];
		const s = (await owner.call('GET', `/projects/${c.projectId}/yield?scenarioId=${sid}`)).body.results[0];
		expect(s).toMatchObject({ scenarioId: sid, runId: null });
		expect(s.points.point.capacityM3).toBe(200_000);
		expect(s.points.point.yieldM3Day).toBeGreaterThan(b.points.point.yieldM3Day);
	});

	it('at most 2 queued or running yield jobs per user (429 for a third, never for a repeat)', async () => {
		const owner = await signUp('YieldLimit');
		const c = await catchment(owner);
		const post = (assurance: number) => owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params: { assurance } });
		expect((await post(1)).status).toBe(202);
		expect((await post(0.9)).status).toBe(202);
		const third = await post(0.8);
		expect(third.status).toBe(429);
		expect(third.body.error).toMatch(/already have 2 yield calculations/);
		expect((await post(0.9)).status).toBe(200);
		await tick();
		expect((await post(0.8)).status).toBe(202);
		await tick();
	});

	it('the job fails closed when its user is no longer an editor', async () => {
		const owner = await signUp('YieldDemoteOwner');
		const ed = await signUp('YieldDemoted');
		const c = await catchment(owner);
		await member(owner, c.projectId, ed, 'editor');
		const res = await ed.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' });
		expect(res.status).toBe(202);
		expect((await owner.call('PATCH', `/projects/${c.projectId}/members/${ed.id}`, { role: 'viewer' })).status).toBe(200);
		await tick();
		expect(await job(res.body.jobId)).toMatchObject({ status: 'dead', last_error: 'the user who queued this job no longer has the editor role on the project' });
		expect((await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).body.results).toEqual([]);
	});
});

describe('POST /projects/:id/yield/:jobId/cancel', () => {
	it('kills a waiting job at once; a viewer who didn’t queue it gets 404', async () => {
		const owner = await signUp('YieldCancel');
		const viewer = await signUp('YieldCancelViewer');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve' })).body.jobId;
		expect((await viewer.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`)).status).toBe(404);
		expect((await job(jobId)).status).toBe('queued');
		const res = await owner.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'dead', cancelled: true });
		expect(await job(jobId)).toMatchObject({ status: 'dead', last_error: 'cancelled' });
		await tick();
		expect((await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).body.results).toEqual([]);
		expect((await owner.call('POST', `/projects/${c.projectId}/yield/${crypto.randomUUID()}/cancel`)).status).toBe(404);
	});

	it('flags a running job, and its next progress report answers false', async () => {
		const owner = await signUp('YieldCancelRunning');
		const c = await catchment(owner);
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve' })).body.jobId;
		// Claim it as a worker would, without running it.
		const [claimed] = (await asOwner(
			`UPDATE job SET status = 'running', attempts = 1, locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now()
			 WHERE id = $1 RETURNING lease_token`,
			[jobId]
		)) as [{ lease_token: string }];
		const go = async () => ((await asOwner('SELECT app_job_progress($1, $2, 40) AS go', [jobId, claimed.lease_token])) as [{ go: boolean }])[0].go;
		expect(await go()).toBe(true);
		expect((await owner.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`)).body).toEqual({ status: 'running', cancelled: true });
		expect(await go()).toBe(false);
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
	});
});

describe('GET /projects/:id/yield/jobs', () => {
	it("lists a dam's pending yield jobs with their target to any viewer; another project's member sees nothing", async () => {
		const owner = await signUp('YieldJobsOwner');
		const viewer = await signUp('YieldJobsViewer');
		const other = await signUp('YieldJobsOther');
		const c = await catchment(owner);
		await catchment(other, 'Other'); // a member of a project, just not this one
		await member(owner, c.projectId, viewer, 'viewer');
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve', params: { assurance: 0.9 } })).body.jobId;

		// Positive control: a viewer who didn't queue it sees it, with what it is for.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&runId=${c.runId}`);
		expect(seen.status).toBe(200);
		expect(seen.body.jobs).toHaveLength(1);
		expect(seen.body.jobs[0]).toMatchObject({
			id: jobId,
			kind: 'yield',
			status: 'queued',
			target: { nodeId: c.dam.id, runId: c.runId, scenarioId: null, kind: 'curve', params: { assurance: 0.9, pattern: 'constant' } }
		});
		expect(seen.body.jobs[0]).not.toHaveProperty('payload');
		// Running, with its progress.
		const [claimed] = (await asOwner(
			`UPDATE job SET status = 'running', attempts = 1, locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now()
			 WHERE id = $1 RETURNING lease_token`,
			[jobId]
		)) as [{ lease_token: string }];
		await asOwner('SELECT app_job_progress($1, $2, 40)', [jobId, claimed.lease_token]);
		expect((await viewer.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}`)).body.jobs[0]).toMatchObject({ id: jobId, status: 'running', progress: 40 });

		// Another dam, another run, a scenario: not this one's.
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.outlet.id}`)).body.jobs).toEqual([]);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&runId=${crypto.randomUUID()}`)).body.jobs).toEqual([]);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&scenarioId=${crypto.randomUUID()}`)).body.jobs).toEqual([]);

		// Negative: another project's member gets 404, and RLS hides the row from them.
		expect((await other.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}`)).status).toBe(404);
		expect((await withUser(other.id, (db) => db.query('SELECT id FROM job WHERE id = $1', [jobId]))).rows).toEqual([]);

		// Bad queries.
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs`)).status).toBe(400);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=x`)).status).toBe(400);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&runId=${c.runId}&scenarioId=${crypto.randomUUID()}`)).status).toBe(400);

		// Finished jobs drop off the list.
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
		expect((await viewer.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}`)).body.jobs).toEqual([]);
	});
});

describe('yield_result RLS', () => {
	it('a viewer reads results but may not queue or write one; an outsider sees nothing', async () => {
		const owner = await signUp('YieldRlsOwner');
		const viewer = await signUp('YieldRlsViewer');
		const outsider = await signUp('YieldRlsOutsider');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		expect((await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).status).toBe(202);
		await tick();

		// Positive control: the viewer sees the owner's result.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`);
		expect(seen.status).toBe(200);
		expect(seen.body.results).toHaveLength(1);
		expect((await withUser(viewer.id, (db) => db.query('SELECT id FROM yield_result WHERE project_id = $1', [c.projectId]))).rows).toHaveLength(1);

		expect((await viewer.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).status).toBe(403);
		await expect(
			withUser(viewer.id, (db) =>
				db.query(`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', 'x')`, [c.projectId, c.runId, c.dam.id])
			)
		).rejects.toMatchObject({ code: '42501' });

		expect((await outsider.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).status).toBe(404);
		expect((await withUser(outsider.id, (db) => db.query('SELECT id FROM yield_result WHERE project_id = $1', [c.projectId]))).rows).toEqual([]);
	});

	it('a result names a run of its own project only', async () => {
		const owner = await signUp('YieldCross');
		const a = await catchment(owner, 'A');
		const b = await catchment(owner, 'B');
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', 'x')`, [a.projectId, b.runId, a.dam.id])
			)
		).rejects.toMatchObject({ code: '23503' });
	});

	it('progress is written only by the lease holder of a running job', async () => {
		const owner = await signUp('YieldProgress');
		const c = await catchment(owner);
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).body.jobId;
		const [{ ok }] = (await asOwner('SELECT app_job_progress($1, gen_random_uuid(), 50) AS ok', [jobId])) as [{ ok: boolean }];
		expect(ok).toBe(false);
		expect((await job(jobId)).progress).toBeNull();
		// An enqueue can't forge one.
		await expect(
			withUser(owner.id, (db) => db.query(`INSERT INTO job (project_id, kind, progress, acting_user_id) VALUES ($1, 'rerun', 70, $2) RETURNING progress`, [c.projectId, owner.id]))
		).resolves.toMatchObject({ rows: [{ progress: null }] });
		await tick();
	});
});
