// The background job queue end to end (016_jobs.sql, jobs/*): RLS on the job
// table, the claim / finish / purge functions, retries and dead-lettering,
// the acting user failing closed, and the `rerun` consumer.
//
// The DB tests share one database and run files serially, so a tick here sees
// only this file's jobs; each test still asserts on its own job ids.
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { JobError } from './errors.js';
import { claimJobs, enqueueJob, finishJob } from './queue.js';
import { defineHandler, type HandlerRegistry } from './registry.js';
import { handlers } from './handlers/index.js';
import { runJob, runTick } from './runner.js';
import { z } from 'zod';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(() => vi.unstubAllEnvs());

async function project(owner: User, name = 'Queue') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}

/** A project the engine can run (the runs.db.test.ts fixture). */
async function runnable(u: User) {
	const projectId = await project(u, 'Runnable');
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

const jobRow = async (id: string) =>
	(await asOwner('SELECT status, attempts, last_error, run_after, finished_at, locked_until, lease_token FROM job WHERE id = $1', [id]))[0] as {
		status: string;
		attempts: number;
		last_error: string | null;
		run_after: Date;
		finished_at: Date | null;
		locked_until: Date | null;
		lease_token: string | null;
	};

/** Enqueue as `u` (an editor) straight through the queue API. */
const enqueue = (u: User, o: Parameters<typeof enqueueJob>[1]) => withUser(u.id, (db) => enqueueJob(db, o));

/** Make a job due now (tests can't wait out a backoff). */
const makeDue = (id: string) => asOwner(`UPDATE job SET run_after = now() - interval '1 second' WHERE id = $1`, [id]);

const noop = defineHandler({ role: 'editor', payload: z.object({}).passthrough(), run: async () => {} });

describe('job table RLS', () => {
	it('an editor enqueues as themselves; forged lifecycle fields are overwritten', async () => {
		const owner = await signUp('JobOwner');
		const pid = await project(owner);
		const other = await signUp('JobOther');
		const { rows } = await withUser(owner.id, (db) =>
			db.query(
				`INSERT INTO job (project_id, kind, status, attempts, finished_at, acting_user_id, run_after)
				 VALUES ($1, 'rerun', 'done', 4, now(), $2, now() - interval '1 day') RETURNING status, attempts, finished_at, acting_user_id, run_after <= now() AS due`,
				[pid, owner.id]
			)
		);
		expect(rows[0]).toMatchObject({ status: 'queued', attempts: 0, finished_at: null, acting_user_id: owner.id, due: true });
		// Acting as someone else is refused (the trigger stamps the enqueuer; the policy checks it).
		const forged = await withUser(owner.id, (db) =>
			db.query(`INSERT INTO job (project_id, kind, acting_user_id) VALUES ($1, 'rerun', $2) RETURNING acting_user_id`, [pid, other.id])
		);
		expect(forged.rows[0].acting_user_id).toBe(owner.id);
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('viewers read but cannot enqueue; non-members see nothing; nobody updates or deletes directly', async () => {
		const owner = await signUp('RlsOwner');
		const viewer = await signUp('RlsViewer');
		const stranger = await signUp('RlsStranger');
		const pid = await project(owner);
		await member(owner, pid, viewer, 'viewer');
		const { job } = await enqueue(owner, { projectId: pid, kind: 'rerun', delaySeconds: 3600 });

		// Positive control: the viewer sees it.
		const seen = await withUser(viewer.id, (db) => db.query('SELECT id FROM job WHERE id = $1', [job.id]));
		expect(seen.rows).toHaveLength(1);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM job WHERE id = $1', [job.id]))).rows).toHaveLength(0);

		await expect(withUser(viewer.id, (db) => db.query(`INSERT INTO job (project_id, kind) VALUES ($1, 'rerun')`, [pid]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(stranger.id, (db) => db.query(`INSERT INTO job (project_id, kind) VALUES ($1, 'rerun')`, [pid]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`UPDATE job SET status = 'done' WHERE id = $1`, [job.id]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM job WHERE id = $1', [job.id]))).rejects.toMatchObject({ code: '42501' });
		expect((await jobRow(job.id)).status).toBe('queued');
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('refuses an enqueue with no signed-in user, and a delay beyond 7 days', async () => {
		const owner = await signUp('NoUser');
		const pid = await project(owner);
		await expect(withoutUser((db) => db.query(`INSERT INTO job (project_id, kind, acting_user_id) VALUES ($1, 'rerun', $2)`, [pid, owner.id]))).rejects.toMatchObject({
			code: '42501'
		});
		await expect(enqueue(owner, { projectId: pid, kind: 'rerun', delaySeconds: 8 * 86400 })).rejects.toMatchObject({ code: '23514' });
	});
});

describe('GET / POST /projects/:id/jobs', () => {
	it('queues a re-run (editor), lists it for viewers without payload or lease, 404s strangers', async () => {
		const owner = await signUp('ApiOwner');
		const viewer = await signUp('ApiViewer');
		const stranger = await signUp('ApiStranger');
		const pid = await project(owner);
		await member(owner, pid, viewer, 'viewer');

		const res = await owner.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'Nightly' });
		expect(res.status).toBe(202);
		expect(res.body).toMatchObject({ created: true, job: { kind: 'rerun', status: 'queued', attempts: 0, maxAttempts: 5, createdBy: 'ApiOwner', error: null } });
		// One pending re-run per project.
		const again = await owner.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'Again' });
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({ created: false, job: { id: res.body.job.id } });

		const list = await viewer.call('GET', `/projects/${pid}/jobs`);
		expect(list.status).toBe(200);
		expect(list.body.jobs.map((j: { id: string }) => j.id)).toEqual([res.body.job.id]);
		expect(Object.keys(list.body.jobs[0]).sort()).toEqual(
			['attempts', 'createdAt', 'createdBy', 'error', 'finishedAt', 'id', 'kind', 'maxAttempts', 'progress', 'runAfter', 'startedAt', 'status'].sort()
		);
		expect((await viewer.call('GET', `/projects/${pid}/jobs?status=done`)).body.jobs).toEqual([]);
		expect((await viewer.call('GET', `/projects/${pid}/jobs?status=bogus`)).status).toBe(400);

		expect((await viewer.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun' })).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${pid}/jobs`)).status).toBe(404);
		expect((await stranger.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun' })).status).toBe(404);
		// Only re-runs are queued through the API.
		expect((await owner.call('POST', `/projects/${pid}/jobs`, { kind: 'feed_fetch' })).status).toBe(400);
		expect((await owner.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', payload: {} })).status).toBe(400);
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});
});

describe('the rerun consumer', () => {
	it('runs the model as the editor who queued it, in a tick', async () => {
		const u = await signUp('Rerunner');
		const pid = await runnable(u);
		const { body } = await u.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'Queued run' });
		expect((await u.call('GET', `/projects/${pid}/runs`)).body.runs).toEqual([]);

		const tick = await runTick();
		expect(tick.done).toBeGreaterThanOrEqual(1);
		const runs = (await u.call('GET', `/projects/${pid}/runs`)).body.runs;
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ label: 'Queued run', createdBy: 'Rerunner' });
		const [job] = (await u.call('GET', `/projects/${pid}/jobs`)).body.jobs;
		expect(job).toMatchObject({ id: body.job.id, status: 'done', attempts: 1, error: null });
		expect(job.finishedAt).not.toBeNull();
	});

	it('with JOB_TRANSPORT=memory the run exists when the request returns', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'memory');
		const u = await signUp('Inline');
		const pid = await runnable(u);
		expect((await u.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'Inline' })).status).toBe(202);
		expect((await u.call('GET', `/projects/${pid}/runs`)).body.runs.map((r: { label: string }) => r.label)).toEqual(['Inline']);
	});

	it('fails closed, writing nothing, when the acting user lost the editor role (positive control: an editor runs)', async () => {
		const owner = await signUp('Demoter');
		const editor = await signUp('Demoted');
		const pid = await runnable(owner);
		await member(owner, pid, editor, 'editor');

		// Positive control: while an editor, their queued run runs.
		await editor.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'as editor' });
		await runTick();
		expect((await owner.call('GET', `/projects/${pid}/runs`)).body.runs.map((r: { label: string }) => r.label)).toEqual(['as editor']);

		const { body } = await editor.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'after demotion' });
		expect((await owner.call('PATCH', `/projects/${pid}/members/${editor.id}`, { role: 'viewer' })).status).toBe(200);
		await runTick();
		expect((await owner.call('GET', `/projects/${pid}/runs`)).body.runs.map((r: { label: string }) => r.label)).toEqual(['as editor']);
		const row = await jobRow(body.job.id);
		expect(row).toMatchObject({ status: 'dead', attempts: 1, last_error: 'the user who queued this job no longer has the editor role on the project' });

		// Removed from the project entirely: the same.
		await owner.call('PATCH', `/projects/${pid}/members/${editor.id}`, { role: 'editor' });
		const { body: gone } = await editor.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'after removal' });
		expect((await owner.call('DELETE', `/projects/${pid}/members/${editor.id}`)).status).toBeLessThan(300);
		await runTick();
		expect((await jobRow(gone.job.id)).status).toBe('dead');
		expect((await owner.call('GET', `/projects/${pid}/runs`)).body.runs).toHaveLength(1);
	});

	it('a model the engine refuses is dead at once with the engine’s reason (no retry can fix it)', async () => {
		const u = await signUp('NoPanJob');
		const pid = await runnable(u);
		expect((await u.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(0) } })).status).toBe(200);
		const { body } = await u.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun' });
		await runTick();
		const row = await jobRow(body.job.id);
		expect(row.status).toBe('dead');
		expect(row.last_error).toMatch(/^model run failed: GR4J needs potential evaporation/);
	});
});

describe('retries, backoff and dead-lettering', () => {
	it('backs off 2^attempts minutes, stores a sanitised error, and is dead after max_attempts', async () => {
		const u = await signUp('Backoff');
		const pid = await project(u);
		const failing: HandlerRegistry = {
			rerun: defineHandler({
				role: 'editor',
				payload: z.object({}).passthrough(),
				run: async () => {
					throw Object.assign(new Error('duplicate key value violates unique constraint "secret_internal_idx"'), { code: '23505', detail: 'Key (email)=(ann@example.com) already exists.' });
				}
			})
		};
		const { job } = await enqueue(u, { projectId: pid, kind: 'rerun', maxAttempts: 2 });
		// The raw error goes to the server log only; keep it out of the test output.
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const before = Date.now();
		await runTick({ handlers: failing });
		let row = await jobRow(job.id);
		expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: 'a database error (SQLSTATE 23505)', finished_at: null, lease_token: null });
		const delayMin = (row.run_after.getTime() - before) / 60_000;
		expect(delayMin).toBeGreaterThan(1.9);
		expect(delayMin).toBeLessThan(2.1);
		// Not due yet: a tick leaves it alone.
		expect((await runTick({ handlers: failing })).claimed).toBe(0);

		await makeDue(job.id);
		await runTick({ handlers: failing });
		row = await jobRow(job.id);
		expect(row).toMatchObject({ status: 'dead', attempts: 2, last_error: 'a database error (SQLSTATE 23505)' });
		expect(row.finished_at).not.toBeNull();
		expect(row.last_error).not.toContain('secret_internal_idx');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('"event":"job_dead"'));
		// The server log gets one JSON line per unexpected failure: the error's
		// name and SQLSTATE and where it was thrown, never its text or detail.
		const failed = spy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('"event":"job_failed"'));
		expect(failed).toHaveLength(2);
		expect(JSON.parse(failed[0]!)).toMatchObject({ event: 'job_failed', jobId: job.id, kind: 'rerun', error: 'Error', code: '23505' });
		expect(JSON.parse(failed[0]!).at.length).toBeGreaterThan(0);
		for (const l of spy.mock.calls.map((c) => c.join(' '))) {
			expect(l).not.toContain('ann@example.com');
			expect(l).not.toContain('secret_internal_idx');
		}
		spy.mockRestore();
	});

	it('a JobError with retry: false is dead on the first attempt; an unexpected error says only "an internal error"', async () => {
		const u = await signUp('Permanent');
		const pid = await project(u);
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const registry: HandlerRegistry = {
			rerun: defineHandler({ role: 'editor', payload: z.object({}).passthrough(), run: async () => { throw new JobError('the station was retired', { retry: false }); } }),
			alert_eval: defineHandler({ role: 'viewer', payload: z.object({}).passthrough(), run: async () => { throw new TypeError('cannot read x of undefined at /srv/app.js:12'); } })
		};
		const { job: a } = await enqueue(u, { projectId: pid, kind: 'rerun' });
		const { job: b } = await enqueue(u, { projectId: pid, kind: 'alert_eval' });
		await runTick({ handlers: registry });
		expect(await jobRow(a.id)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'the station was retired' });
		expect(await jobRow(b.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'an internal error' });
		spy.mockRestore();
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('a progress report that fails is logged by name and SQLSTATE only, and the job carries on', async () => {
		const u = await signUp('Progress');
		const pid = await project(u);
		const registry: HandlerRegistry = {
			rerun: defineHandler({
				role: 'editor',
				payload: z.object({}).passthrough(),
				// NaN reaches Postgres as "NaN", which an integer refuses with the value quoted in the error's text.
				run: async ({ progress }) => {
					expect(await progress(Number.NaN)).toBe(true);
				}
			})
		};
		const { job } = await enqueue(u, { projectId: pid, kind: 'rerun' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await runTick({ handlers: registry, projectIds: [pid], feeds: false, reports: false, alerts: false });
		const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('"event":"job_progress_failed"'));
		warn.mockRestore();
		expect(await jobRow(job.id)).toMatchObject({ status: 'done' });
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({ event: 'job_progress_failed', jobId: job.id, error: 'error', code: '22P02' });
	});

	it('a kind with no handler, or a payload its handler rejects, is dead at once', async () => {
		const u = await signUp('Unhandled');
		const pid = await project(u);
		// Every kind has a handler now (WP-2.13 added alert_eval), so leave one out of the registry.
		const { job: nohandler } = await enqueue(u, { projectId: pid, kind: 'alert_eval' });
		const { job: badPayload } = await enqueue(u, { projectId: pid, kind: 'rerun', payload: { label: 5 } });
		await runTick({ handlers: { rerun: handlers.rerun } });
		expect(await jobRow(nohandler.id)).toMatchObject({ status: 'dead', last_error: 'no handler for "alert_eval" jobs' });
		expect(await jobRow(badPayload.id)).toMatchObject({ status: 'dead', last_error: 'the job’s payload is not valid' });
	});
});

describe('claiming', () => {
	it('two concurrent claimers never take the same job', async () => {
		const u = await signUp('Concurrent');
		const pid = await project(u);
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) ids.push((await enqueue(u, { projectId: pid, kind: 'rerun' })).job.id);
		const [a, b] = await Promise.all([withoutUser((db) => claimJobs(db, 8, 60)), withoutUser((db) => claimJobs(db, 8, 60))]);
		const mine = (c: typeof a) => c.map((j) => j.id).filter((id) => ids.includes(id));
		const claimedA = mine(a);
		const claimedB = mine(b);
		expect(claimedA.filter((id) => claimedB.includes(id))).toEqual([]);
		expect([...claimedA, ...claimedB].sort()).toEqual([...ids].sort());
		for (const j of [...a, ...b]) await withoutUser((db) => finishJob(db, j, { ok: true }));
	});

	it('a job whose worker died is claimed again after its lease; the old worker can no longer finish it', async () => {
		const u = await signUp('Lease');
		const pid = await project(u);
		const { job } = await enqueue(u, { projectId: pid, kind: 'rerun', maxAttempts: 2 });
		const [first] = (await withoutUser((db) => claimJobs(db, 10, 60))).filter((j) => j.id === job.id);
		expect(first).toBeDefined();
		// Still leased: nobody else gets it.
		expect((await withoutUser((db) => claimJobs(db, 10, 60))).map((j) => j.id)).not.toContain(job.id);

		await asOwner(`UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1`, [job.id]);
		const [second] = (await withoutUser((db) => claimJobs(db, 10, 60))).filter((j) => j.id === job.id);
		expect(second).toMatchObject({ attempts: 2 });
		expect(second!.leaseToken).not.toBe(first!.leaseToken);
		expect(await withoutUser((db) => finishJob(db, first!, { ok: true }))).toBeNull();
		expect(await withoutUser((db) => finishJob(db, second!, { ok: true }))).toBe('done');

		// A lease that runs out with no attempts left is dead, not claimed a third time.
		const { job: last } = await enqueue(u, { projectId: pid, kind: 'rerun', maxAttempts: 1 });
		await withoutUser((db) => claimJobs(db, 10, 60));
		await asOwner(`UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1`, [last.id]);
		expect((await withoutUser((db) => claimJobs(db, 10, 60))).map((j) => j.id)).not.toContain(last.id);
		expect(await jobRow(last.id)).toMatchObject({ status: 'dead', last_error: 'the worker stopped before the job finished, and it has no attempts left' });
	});

	it('rolls the handler’s writes back when the lease was lost mid-run', async () => {
		const u = await signUp('LostLease');
		const pid = await project(u, 'Before');
		const { job } = await enqueue(u, { projectId: pid, kind: 'rerun' });
		const [claimed] = (await withoutUser((db) => claimJobs(db, 10, 60))).filter((j) => j.id === job.id);
		const registry: HandlerRegistry = {
			rerun: defineHandler({
				role: 'editor',
				payload: z.object({}).passthrough(),
				run: async ({ db }) => {
					await db.query('UPDATE project SET name = $2 WHERE id = $1', [pid, 'After']);
					// Meanwhile the lease expired and another worker took the job.
					await asOwner('UPDATE job SET lease_token = gen_random_uuid() WHERE id = $1', [job.id]);
				}
			})
		};
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await runJob(claimed!, registry)).toBe('lost');
		spy.mockRestore();
		expect((await u.call('GET', `/projects/${pid}`)).body.project.name).toBe('Before');
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('one pending job per dedupe key, and it waits while one with its key is running', async () => {
		const u = await signUp('Dedupe');
		const pid = await project(u);
		const other = await project(u, 'Other');
		const a = await enqueue(u, { projectId: pid, kind: 'rerun', dedupeKey: 'k' });
		const dup = await enqueue(u, { projectId: pid, kind: 'rerun', dedupeKey: 'k' });
		expect(dup).toMatchObject({ created: false, job: { id: a.job.id } });
		// Keys are per project.
		expect((await enqueue(u, { projectId: other, kind: 'rerun', dedupeKey: 'k' })).created).toBe(true);

		const [running] = (await withoutUser((db) => claimJobs(db, 10, 60))).filter((j) => j.id === a.job.id);
		expect(running).toBeDefined();
		// Running doesn't count as pending: new work with the key queues…
		const b = await enqueue(u, { projectId: pid, kind: 'rerun', dedupeKey: 'k' });
		expect(b.created).toBe(true);
		// …but isn't claimed while its predecessor runs (positive control: a keyless job is).
		const { job: keyless } = await enqueue(u, { projectId: pid, kind: 'rerun' });
		const claimed = (await withoutUser((db) => claimJobs(db, 10, 60))).map((j) => j.id);
		expect(claimed).toContain(keyless.id);
		expect(claimed).not.toContain(b.job.id);
		await withoutUser((db) => finishJob(db, running!, { ok: true }));
		expect((await withoutUser((db) => claimJobs(db, 10, 60))).map((j) => j.id)).toContain(b.job.id);
		await asOwner('DELETE FROM job WHERE project_id IN ($1, $2)', [pid, other]);
	});

	it('a running job that fails while a newer one with its key is pending is superseded, and the tick goes on', async () => {
		const u = await signUp('Superseded');
		const pid = await project(u);
		let calls = 0;
		const registry: HandlerRegistry = {
			// The first attempt fails in a way worth retrying, after new work with its key was queued (a "Run now",
			// new data's re-run, a run's alert check) while it ran.
			rerun: defineHandler({
				role: 'editor',
				payload: z.object({}).passthrough(),
				run: async () => {
					if (calls++ > 0) return;
					await enqueue(u, { projectId: pid, kind: 'rerun', dedupeKey: 'k', payload: { label: 'newer' } });
					throw new JobError('the source timed out');
				}
			})
		};
		const { job: a } = await enqueue(u, { projectId: pid, kind: 'rerun', dedupeKey: 'k' });
		const { job: other } = await enqueue(u, { projectId: pid, kind: 'rerun', delaySeconds: 1 });
		await makeDue(other.id);
		await asOwner(`UPDATE job SET run_after = now() - interval '1 minute' WHERE id = $1`, [a.id]);

		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const tick = await runTick({ handlers: registry, projectIds: [pid], feeds: false, reports: false, alerts: false });
		const errors = spy.mock.calls.map((c) => c.join(' '));
		const infos = info.mock.calls.map((c) => c.join(' '));
		spy.mockRestore();
		info.mockRestore();
		// Retrying it would make two pending jobs with one key (job_dedupe_idx): the newer one does the work instead.
		expect(await jobRow(a.id)).toMatchObject({ status: 'dead', attempts: 1, lease_token: null, last_error: 'the source timed out (a newer job with the same key is queued)' });
		// Not a dead letter: no job_dead line (the alarm's metric filter), a job_superseded one instead.
		expect(errors.filter((l) => l.includes('"event":"job_dead"'))).toEqual([]);
		expect(infos.filter((l) => l.includes('"event":"job_superseded"'))).toHaveLength(1);
		// The tick carried on: the other due job ran, and so did the newer job with the key, once the old one was out of its way.
		expect(await jobRow(other.id)).toMatchObject({ status: 'done' });
		const [newer] = await asOwner(`SELECT id, status, payload FROM job WHERE project_id = $1 AND dedupe_key = 'k' AND id <> $2`, [pid, a.id]);
		expect(newer).toMatchObject({ status: 'done', payload: { label: 'newer' } });
		expect(tick).toMatchObject({ claimed: 3, done: 2, dead: 1 });
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});
});

describe('a tick scoped to some projects (123_scoped_job_claim.sql, the e2e tick)', () => {
	it('runs its own projects’ due jobs and leaves another project’s due job queued', async () => {
		const u = await signUp('Scoped');
		const mine = await project(u, 'Mine');
		const theirs = await project(u, 'Theirs');
		const { job: own } = await enqueue(u, { projectId: mine, kind: 'rerun' });
		const { job: other } = await enqueue(u, { projectId: theirs, kind: 'rerun' });

		const r = await runTick({ projectIds: [mine], handlers: { rerun: noop }, feeds: false, reports: false, alerts: false });
		// Positive control: its own job ran.
		expect(await jobRow(own.id)).toMatchObject({ status: 'done', attempts: 1 });
		expect(r.claimed).toBe(1);
		// The other project's job is untouched: still queued, never claimed.
		expect(await jobRow(other.id)).toMatchObject({ status: 'queued', attempts: 0, locked_until: null, lease_token: null });

		// An unscoped claim (production's) still takes it.
		expect((await withoutUser((db) => claimJobs(db, 10, 60))).map((j) => j.id)).toContain(other.id);
		await asOwner('DELETE FROM job WHERE project_id IN ($1, $2)', [mine, theirs]);
	});

	it('marks dead only its own projects’ expired jobs with no attempts left', async () => {
		const u = await signUp('ScopedDead');
		const mine = await project(u, 'Mine');
		const theirs = await project(u, 'Theirs');
		const { job: own } = await enqueue(u, { projectId: mine, kind: 'rerun', maxAttempts: 1 });
		const { job: other } = await enqueue(u, { projectId: theirs, kind: 'rerun', maxAttempts: 1 });
		const claimed = (await withoutUser((db) => claimJobs(db, 10, 60, [mine, theirs]))).map((j) => j.id);
		expect(claimed.sort()).toEqual([own.id, other.id].sort());
		await asOwner(`UPDATE job SET locked_until = now() - interval '1 second' WHERE id = ANY($1)`, [[own.id, other.id]]);

		expect(await withoutUser((db) => claimJobs(db, 10, 60, [mine]))).toEqual([]);
		expect(await jobRow(own.id)).toMatchObject({ status: 'dead' });
		expect(await jobRow(other.id)).toMatchObject({ status: 'running' });
		await asOwner('DELETE FROM job WHERE project_id IN ($1, $2)', [mine, theirs]);
	});
});

describe('the tick', () => {
	it('an enqueue NOTIFYs job_queued at commit (what wakes the local worker)', async () => {
		const u = await signUp('Notify');
		const pid = await project(u);
		const listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
		await listener.connect();
		try {
			await listener.query('LISTEN job_queued');
			const heard = new Promise<string>((resolve) => listener.once('notification', (n) => resolve(n.channel)));
			await enqueue(u, { projectId: pid, kind: 'rerun', delaySeconds: 60 });
			expect(await heard).toBe('job_queued');
		} finally {
			await listener.end();
		}
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('purges finished jobs older than 30 days, keeping newer ones and anything unfinished', async () => {
		const u = await signUp('Purge');
		const pid = await project(u);
		const ids = [];
		for (let i = 0; i < 3; i++) ids.push((await enqueue(u, { projectId: pid, kind: 'rerun' })).job.id);
		await runTick({ handlers: { rerun: noop } });
		const pending = (await enqueue(u, { projectId: pid, kind: 'rerun', delaySeconds: 3600 })).job.id;
		await asOwner(`UPDATE job SET finished_at = now() - interval '31 days', created_at = now() - interval '31 days' WHERE id = ANY($1)`, [ids.slice(0, 2)]);
		await asOwner(`UPDATE job SET finished_at = now() - interval '29 days' WHERE id = $1`, [ids[2]]);
		const tick = await runTick();
		expect(tick.purged).toBe(2);
		const left = (await asOwner('SELECT id FROM job WHERE project_id = $1', [pid])).map((r) => r.id);
		expect(left.sort()).toEqual([ids[2], pending].sort());
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('reports the queue: due, running, and how late the oldest due job is', async () => {
		const u = await signUp('Stats');
		const pid = await project(u);
		const { job } = await enqueue(u, { projectId: pid, kind: 'rerun' });
		await asOwner(`UPDATE job SET run_after = now() - interval '10 minutes' WHERE id = $1`, [job.id]);
		const tick = await runTick({ maxJobs: 0 });
		expect(tick.claimed).toBe(0);
		expect(tick.stats.due).toBeGreaterThanOrEqual(1);
		expect(tick.stats.oldestDueSeconds).toBeGreaterThanOrEqual(600);
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});
});
