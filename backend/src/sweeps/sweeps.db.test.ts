// Scenario sweeps end to end (issue #53 R2, 062_scenario_sweeps.sql): the
// POST /sweeps checks, the `sweep` job run as its acting user (the memory
// transport: the test runs the tick itself), each member's stored summary or
// problems, RLS (with a positive control), write-once outcomes, the per-user
// limit, the project's cap, and the job failing closed when its user lost the
// editor role.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { SWEEP_MEMBERS_MAX, SWEEPS_KEPT } from './schema.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** A farm dam draining into an outlet gauge, 90 days of rain, one saved run. Invented values. */
async function catchment(owner: User, name = 'Sweep') {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 50_000, damInitialPct: 1, damMinPct: 0 });
	const crop = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, outlet, farm, runId: run.body.run.id as string };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error, progress FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null; progress: number | null };
const scale = (factor: number) => [{ op: 'demand.scale', factor }];
const demandLevels = [
	{ name: '100 %', ops: scale(1) },
	{ name: '85 %', ops: scale(0.85) },
	{ name: '70 %', ops: scale(0.7) }
];
const sweepOf = (runId: string, members: unknown[] = demandLevels, name = 'Demand levels') => ({ name, baseRunId: runId, members });

describe('POST /projects/:id/sweeps', () => {
	it('an editor sweeps demand at 1.0 / 0.85 / 0.7; the job stores each member’s run summary', async () => {
		const owner = await signUp('SweepOwner');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId));
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const { sweep, jobId } = res.body;
		expect(sweep).toMatchObject({ name: 'Demand levels', baseRunId: c.runId, baseRun: { id: c.runId, label: 'base' }, status: 'pending', engineVersion: null, createdBy: 'SweepOwner' });
		expect(sweep.job).toMatchObject({ id: jobId, status: 'queued' });
		expect(sweep.members.map((m: { name: string; status: string }) => [m.name, m.status])).toEqual([
			['100 %', 'pending'],
			['85 %', 'pending'],
			['70 %', 'pending']
		]);
		expect((await owner.call('GET', `/projects/${c.projectId}/jobs`)).body.jobs[0]).toMatchObject({ id: jobId, kind: 'sweep', status: 'queued' });

		await tick();
		expect(await job(jobId)).toMatchObject({ status: 'done', progress: 100 });
		const got = await owner.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}`);
		expect(got.status).toBe(200);
		const s = got.body.sweep;
		expect(s).toMatchObject({ status: 'complete', job: { status: 'done', progress: 100 } });
		expect(s.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(s.completedAt).not.toBeNull();
		for (const m of s.members) expect(m).toMatchObject({ status: 'done', problems: [], startDate: '2020-01-01', endDate: '2020-03-30' });

		// The 1.0 member is the base run itself; the others scale its demand.
		const [base] = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [c.runId])) as [{ summary: { farms: { avgDemandM3Day: number }[] } }];
		const demand = s.members.map((m: { summary: { farms: { avgDemandM3Day: number }[] } }) => m.summary.farms[0]!.avgDemandM3Day);
		expect(base.summary.farms[0]!.avgDemandM3Day).toBeGreaterThan(0);
		expect(demand[0]).toBeCloseTo(base.summary.farms[0]!.avgDemandM3Day, 9);
		expect(demand[1] / demand[0]).toBeCloseTo(0.85, 9);
		expect(demand[2] / demand[0]).toBeCloseTo(0.7, 9);

		// The catchment-level outcome series only when asked for; the 1.0 member's are the base run's.
		expect(s.members[0]).not.toHaveProperty('series');
		const withSeries = (await owner.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}?series=true`)).body.sweep;
		const series = withSeries.members[0].series as { nodeId: string | null; key: string; values: (number | null)[] }[];
		expect(series.map((x) => x.key).sort()).toEqual(['ewr', 'ewr_shortfall', 'natural_flow', 'simulated_outflow']);
		for (const x of series) expect(x).toMatchObject({ nodeId: null, unit: 'm³/day' });
		const baseSeries = (await asOwner(`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key = 'simulated_outflow'`, [c.runId])) as [{ values: number[] }];
		expect(series.find((x) => x.key === 'simulated_outflow')!.values).toEqual(baseSeries[0].values);
		expect((await owner.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}?series=yes`)).status).toBe(400);

		// The list leaves the summaries out.
		const list = await owner.call('GET', `/projects/${c.projectId}/sweeps`);
		expect(list.body.sweeps.map((x: { id: string }) => x.id)).toEqual([sweep.id]);
		expect(list.body.sweeps[0].members[0]).not.toHaveProperty('summary');
		expect((await owner.call('GET', `/projects/${c.projectId}/sweeps?baseRunId=${randomUUID()}`)).body.sweeps).toEqual([]);
		expect((await owner.call('GET', `/projects/${c.projectId}/sweeps?baseRunId=${c.runId}`)).body.sweeps).toHaveLength(1);
	});

	it('a member whose ops don’t apply records its problems; the others still run and the sweep completes', async () => {
		const owner = await signUp('SweepProblems');
		const c = await catchment(owner);
		const missing = randomUUID();
		const members = [
			{ name: 'Half', ops: scale(0.5) },
			{ name: 'Gone farm', ops: [{ op: 'demand.scale', factor: 0.5, nodeIds: [missing] }] },
			{ name: 'Outlet as a farm', ops: [{ op: 'demand.scale', factor: 0.5, nodeIds: [c.outlet.id] }] }
		];
		const { sweep, jobId } = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId, members))).body;
		await tick();
		expect((await job(jobId)).status).toBe('done');
		const s = (await owner.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}`)).body.sweep;
		expect(s.status).toBe('complete');
		expect(s.members[0]).toMatchObject({ status: 'done', problems: [] });
		expect(s.members[1]).toMatchObject({ status: 'problems', summary: null, startDate: null });
		expect(s.members[1].problems).toHaveLength(1);
		expect(s.members[1].problems[0]).toMatch(/^op 1 \(demand\.scale\)/);
		expect(s.members[1].problems[0]).toContain(missing);
		expect(s.members[2]).toMatchObject({ status: 'problems', summary: null });
		expect(s.members[2].finishedAt).not.toBeNull();
	});

	it('refuses a base run that isn’t this project’s, a body that fails the scenario op checks, and too many members', async () => {
		const owner = await signUp('SweepBad');
		const a = await catchment(owner, 'A');
		const b = await catchment(owner, 'B');
		const post = (body: unknown) => owner.call('POST', `/projects/${a.projectId}/sweeps`, body);
		expect((await post(sweepOf(b.runId))).status).toBe(404);
		expect((await post(sweepOf(randomUUID()))).status).toBe(404);
		const bad = await post(sweepOf(a.runId, [{ name: 'Too much', ops: scale(5) }]));
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toContain('factor');
		const many = Array.from({ length: SWEEP_MEMBERS_MAX + 1 }, (_, i) => ({ name: `m${i}`, ops: scale(i / 20) }));
		expect((await post(sweepOf(a.runId, many))).status).toBe(400);
		expect((await post(sweepOf(a.runId, [{ name: 'x', ops: [] }, { name: 'X', ops: [] }]))).status).toBe(400);
		expect((await owner.call('GET', `/projects/${a.projectId}/sweeps`)).body.sweeps).toEqual([]);
		expect((await owner.call('GET', `/projects/${a.projectId}/sweeps/not-a-uuid`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${a.projectId}/sweeps/${randomUUID()}`)).status).toBe(404);
	});

	it('at most 2 queued or running sweeps per user (429 for a third)', async () => {
		const owner = await signUp('SweepLimit');
		const c = await catchment(owner);
		const post = () => owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId, [{ name: 'one', ops: scale(0.9) }]));
		expect((await post()).status).toBe(202);
		expect((await post()).status).toBe(202);
		const third = await post();
		expect(third.status).toBe(429);
		expect(third.body.error).toBe('you already have 2 sweeps queued or running; wait for one to finish');
		await tick();
		expect((await post()).status).toBe(202);
		await tick();
	});

	it(`keeps the project’s newest ${SWEEPS_KEPT} sweeps`, async () => {
		const owner = await signUp('SweepKept');
		const c = await catchment(owner);
		const ids: string[] = [];
		for (let i = 0; i <= SWEEPS_KEPT; i++) {
			const res = await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId, [{ name: 'one', ops: [] }], `Sweep ${i}`));
			expect(res.status).toBe(202);
			ids.push(res.body.sweep.id);
			await tick();
		}
		const listed = (await owner.call('GET', `/projects/${c.projectId}/sweeps`)).body.sweeps.map((s: { id: string }) => s.id);
		expect(listed).toEqual(ids.slice(1).reverse());
		expect(await asOwner('SELECT id FROM scenario_sweep_member WHERE sweep_id = $1', [ids[0]])).toEqual([]);
	});

	it('the job fails closed when its user is no longer an editor: the sweep stays pending, its job says why', async () => {
		const owner = await signUp('SweepDemoteOwner');
		const ed = await signUp('SweepDemoted');
		const c = await catchment(owner);
		await member(owner, c.projectId, ed, 'editor');
		const res = await ed.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId));
		expect(res.status).toBe(202);
		expect((await owner.call('PATCH', `/projects/${c.projectId}/members/${ed.id}`, { role: 'viewer' })).status).toBe(200);
		await tick();
		const reason = 'the user who queued this job no longer has the editor role on the project';
		expect(await job(res.body.jobId)).toMatchObject({ status: 'dead', last_error: reason });
		const s = (await owner.call('GET', `/projects/${c.projectId}/sweeps/${res.body.sweep.id}`)).body.sweep;
		expect(s).toMatchObject({ status: 'pending', job: { status: 'dead', error: reason } });
		expect(s.members.every((m: { status: string }) => m.status === 'pending')).toBe(true);
	});

	it('goes with its base run', async () => {
		const owner = await signUp('SweepCascade');
		const c = await catchment(owner);
		const { sweep } = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId))).body;
		await tick();
		expect((await owner.call('DELETE', `/projects/${c.projectId}/runs/${c.runId}`)).status).toBe(204);
		expect((await owner.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}`)).status).toBe(404);
		expect(await asOwner('SELECT id FROM scenario_sweep_member WHERE project_id = $1', [c.projectId])).toEqual([]);
	});
});

describe('scenario_sweep RLS', () => {
	it('a viewer reads sweeps but may not start one; an outsider sees nothing', async () => {
		const owner = await signUp('SweepRlsOwner');
		const viewer = await signUp('SweepRlsViewer');
		const outsider = await signUp('SweepRlsOutsider');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		const { sweep } = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId))).body;
		await tick();

		// Positive control: the viewer sees the owner's sweep and its members' summaries.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}`);
		expect(seen.status).toBe(200);
		expect(seen.body.sweep.members[1].summary.farms).toHaveLength(1);
		expect((await viewer.call('GET', `/projects/${c.projectId}/sweeps`)).body.sweeps).toHaveLength(1);
		const rowsAs = (u: User, table: string) => withUser(u.id, async (db) => (await db.query(`SELECT id FROM ${table} WHERE project_id = $1`, [c.projectId])).rows);
		expect(await rowsAs(viewer, 'scenario_sweep')).toHaveLength(1);
		expect(await rowsAs(viewer, 'scenario_sweep_member')).toHaveLength(3);

		expect((await viewer.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId))).status).toBe(403);
		await expect(
			withUser(viewer.id, (db) => db.query(`INSERT INTO scenario_sweep (project_id, base_run_id, name) VALUES ($1, $2, 'x')`, [c.projectId, c.runId]))
		).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(viewer.id, (db) => db.query('DELETE FROM scenario_sweep WHERE id = $1 RETURNING id', [sweep.id]))).resolves.toMatchObject({ rows: [] });

		expect((await outsider.call('GET', `/projects/${c.projectId}/sweeps`)).status).toBe(404);
		expect((await outsider.call('GET', `/projects/${c.projectId}/sweeps/${sweep.id}`)).status).toBe(404);
		expect(await rowsAs(outsider, 'scenario_sweep')).toEqual([]);
		expect(await rowsAs(outsider, 'scenario_sweep_member')).toEqual([]);
	});

	it('names a base run and job of its own project only, and an ordinary run', async () => {
		const owner = await signUp('SweepCross');
		const a = await catchment(owner, 'A');
		const b = await catchment(owner, 'B');
		const insert = (projectId: string, runId: string) =>
			withUser(owner.id, (db) => db.query(`INSERT INTO scenario_sweep (project_id, base_run_id, name) VALUES ($1, $2, 'x')`, [projectId, runId]));
		await expect(insert(a.projectId, b.runId)).rejects.toMatchObject({ code: '23503' });
		await asOwner(`UPDATE model_run SET "trigger" = 'forecast' WHERE id = $1`, [b.runId]);
		await expect(insert(b.projectId, b.runId)).rejects.toMatchObject({ code: '23514' });
		// A member of another project's sweep.
		const { sweep } = (await owner.call('POST', `/projects/${a.projectId}/sweeps`, sweepOf(a.runId))).body;
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO scenario_sweep_member (sweep_id, project_id, position, name, ops, ops_sha256) VALUES ($1, $2, 5, 'y', '[]', $3)`, [
					sweep.id,
					b.projectId,
					'a'.repeat(64)
				])
			)
		).rejects.toMatchObject({ code: '23503' });
		await tick();
	});

	it('an outcome is stored once, by whoever asked, and a member’s ops never change', async () => {
		const owner = await signUp('SweepOnceOwner');
		const ed = await signUp('SweepOnceEditor');
		const c = await catchment(owner);
		await member(owner, c.projectId, ed, 'editor');
		const { sweep } = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId))).body;
		const memberId = sweep.members[0].id;
		// Another editor can't write the result of a sweep they didn't ask for.
		await expect(
			withUser(ed.id, (db) => db.query(`UPDATE scenario_sweep_member SET status = 'problems', problems = '["forged"]' WHERE id = $1`, [memberId]))
		).rejects.toMatchObject({ code: '42501' });
		// Nor may anyone change a member's ops (not in the column grant).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE scenario_sweep_member SET ops = '[]' WHERE id = $1`, [memberId]))).rejects.toMatchObject({
			code: '42501'
		});
		// Nor complete a sweep with members still pending.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE scenario_sweep SET status = 'complete', engine_version = 'x' WHERE id = $1`, [sweep.id]))).rejects.toMatchObject({
			code: '23514'
		});
		await tick();
		// Once complete, nothing changes (the update policy sees only pending rows).
		const upd = await withUser(owner.id, (db) => db.query(`UPDATE scenario_sweep_member SET status = 'failed', problems = '["x"]' WHERE id = $1 RETURNING id`, [memberId]));
		expect(upd.rows).toEqual([]);
		expect(((await asOwner('SELECT status FROM scenario_sweep_member WHERE id = $1', [memberId])) as [{ status: string }])[0].status).toBe('done');
	});

	it('the 30-day job clean-up clears a sweep’s job and keeps the sweep, complete or pending (148_job_purge_clears_links)', async () => {
		const owner = await signUp('SweepPurge');
		const c = await catchment(owner);
		const done = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId))).body;
		await tick();
		const stuck = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, sweepOf(c.runId, demandLevels, 'Stuck'))).body;
		// The second sweep's job died before it ran: the sweep stays pending.
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now() WHERE id = $1`, [stuck.jobId]);
		const before = await asOwner('SELECT id, status, completed_at, engine_version FROM scenario_sweep WHERE project_id = $1 ORDER BY name', [c.projectId]);
		expect(before.map((r) => r.status)).toEqual(['complete', 'pending']);

		await asOwner(`UPDATE job SET finished_at = now() - interval '31 days' WHERE id = ANY($1)`, [[done.jobId, stuck.jobId]]);
		expect((await tick()).purged).toBeGreaterThanOrEqual(2);
		expect(await asOwner('SELECT id FROM job WHERE project_id = $1', [c.projectId])).toEqual([]);
		const after = await asOwner('SELECT id, status, completed_at, engine_version, job_id FROM scenario_sweep WHERE project_id = $1 ORDER BY name', [c.projectId]);
		expect(after).toEqual(before.map((r) => ({ ...r, job_id: null })));
		expect(await asOwner(`SELECT count(*)::int AS n FROM scenario_sweep_member WHERE sweep_id = $1 AND status = 'done'`, [done.sweep.id])).toEqual([{ n: 3 }]);
		const got = await owner.call('GET', `/projects/${c.projectId}/sweeps/${done.sweep.id}`);
		expect(got.status).toBe(200);
		expect(got.body.sweep).toMatchObject({ status: 'complete', job: null });

		// Positive control: the guard still refuses a real change, alone or beside a cleared link, even by the schema owner.
		await expect(asOwner(`UPDATE scenario_sweep SET name = 'Changed' WHERE id = $1`, [done.sweep.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE scenario_sweep SET created_by = NULL, name = 'Changed' WHERE id = $1`, [done.sweep.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE scenario_sweep SET job_id = $2 WHERE id = $1`, [done.sweep.id, done.jobId])).rejects.toMatchObject({ code: '23514' });
	});
});
