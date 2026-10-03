// Delineating on the background worker (191_delineation_request,
// delineation/requests.ts, jobs/handlers/delineate.ts), end to end against
// Postgres and the committed synthetic DEM. Its catchments all fit the
// request's smallest window, so these tests narrow the windows
// (delineationLimits) to reach the worker's path:
//  - a click still at the edge of the request's window is queued (202), the
//    job proposes it, and the request says so (with its proposal);
//  - `background` queues at once, from the worker's first window;
//  - at the worker's own cap the request records the refusal, and the job is
//    done (an outcome, not a failure); with the DEM off it says so;
//  - one delineation per account: a new click in the project supersedes the
//    waiting one (its job cancelled, nothing stored when it would run); one
//    waiting in another project, or running, is 429; the dedupe key names the
//    account;
//  - viewers read a request, never queue one; strangers and other projects get 404;
//  - the request table's RLS, with a positive control.
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL, BASIN_AREA_M2 } from './fixture.js';
import { delineationLimits, nextJobWindow, jobWindowsFrom } from './requests.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = { dem: process.env.DEM_URL, limits: { ...delineationLimits } };

const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;
const point = (x: number, y: number) => {
	const [lon, lat] = fixtureLonLat(x + 0.5, y + 0.5);
	return { lon, lat };
};
const OUTLET = point(OUTLET_CELL.x, OUTLET_CELL.y);
const DAM = point(DAM_CELL.x, DAM_CELL.y + 1);
/** Only this file's projects' jobs: other files' ticks never run them, and these never run theirs. */
const tick = () => runTick({ feeds: false, reports: false, alerts: false, projectIds: [projectId, otherProjectId] });
const jobOf = async (requestId: string) =>
	(await asOwner(`SELECT j.id, j.status, j.kind, j.dedupe_key, j.payload, j.max_attempts, j.last_error FROM job j JOIN delineation_request r ON r.job_id = j.id WHERE r.id = $1`, [requestId]))[0];

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Qowner', 'Qeditor', 'Qviewer', 'Qstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Large delineation' })).body.project.id;
	otherProjectId = (await owner.call('POST', '/projects', { name: 'Another large delineation' })).body.project.id;
	for (const pid of [projectId, otherProjectId])
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const)
			expect((await owner.call('POST', at('/members', pid), { email: u.email, role })).status).toBe(201);
	process.env.DEM_URL = FIXTURE;
}, 60_000);

afterEach(async () => {
	Object.assign(delineationLimits, before.limits);
	process.env.DEM_URL = FIXTURE;
	// Nothing waits into the next test: every pending delineate job of these projects is retired.
	await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), last_error = 'test over' WHERE project_id = ANY($1) AND status IN ('queued', 'failed')`, [
		[projectId, otherProjectId]
	]);
	await asOwner(`UPDATE delineation_request SET status = 'superseded', finished_at = now() WHERE project_id = ANY($1) AND status = 'queued'`, [[projectId, otherProjectId]]);
});

afterAll(() => {
	if (before.dem === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before.dem;
});

describe('which windows the worker tries', () => {
	it('goes on from the window after the one the request stopped at, and only past it', () => {
		expect(nextJobWindow(3072, [1024, 2048, 3072, 4096, 6144])).toBe(4096);
		expect(nextJobWindow(2048, [1024, 2048, 3072, 4096, 6144])).toBe(3072);
		expect(nextJobWindow(6144, [1024, 2048, 3072, 4096, 6144])).toBeNull();
		expect(nextJobWindow(undefined, [1024])).toBeNull();
		expect(jobWindowsFrom(4096, [1024, 2048, 3072, 4096, 6144])).toEqual([4096, 6144]);
		expect(jobWindowsFrom(8192, [1024, 6144])).toEqual([]);
	});
});

describe('a catchment too large for the request', () => {
	it('is queued (202), proposed by the worker as the request would have, and the request says so', async () => {
		// The valley above the outlet needs a 512-cell window; the request stops at 256 and the worker starts at 1 024.
		delineationLimits.requestWindows = [256];
		const res = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const r = res.body.request;
		expect(r).toMatchObject({ status: 'queued', from: 'outlet', click: [OUTLET.lon, OUTLET.lat], proposal: null, refusal: null, finishedAt: null });
		const job = await jobOf(r.id);
		expect(job).toMatchObject({ kind: 'delineate', status: 'queued', dedupe_key: `delineate:${editor.id}`, payload: { requestId: r.id }, max_attempts: 2 });
		expect((await asOwner('SELECT from_window FROM delineation_request WHERE id = $1', [r.id]))[0].from_window).toBe(1024);
		// The Map picks a waiting request up from the GET.
		expect((await viewer.call('GET', at('/map/delineation'))).body.request).toMatchObject({ id: r.id, status: 'queued' });

		await tick();
		expect((await jobOf(r.id)).status).toBe('done');
		const got = await viewer.call('GET', at(`/map/delineation/requests/${r.id}`));
		expect(got.status).toBe(200);
		const done = got.body.request;
		expect(done).toMatchObject({ status: 'proposed', refusal: null, error: null });
		expect(done.finishedAt).not.toBeNull();
		expect(done.proposal).toMatchObject({ status: 'proposed', from: 'outlet', zoom: 10, windowCells: 1024, createdBy: 'Qeditor', click: [OUTLET.lon, OUTLET.lat] });
		expect(Math.abs(done.proposal.areaM2 / BASIN_AREA_M2 - 1)).toBeLessThan(0.03);
		// It is the project's open proposal, decided the usual way, and audited as the editor's.
		const state = (await viewer.call('GET', at('/map/delineation'))).body;
		expect(state.request).toBeNull();
		expect(state.proposals[0]).toMatchObject({ id: done.proposal.id, status: 'proposed' });
		const audit = await asOwner(`SELECT subject, actor_user_id FROM audit_event WHERE project_id = $1 AND kind = 'map.delineation_proposed' AND subject->>'proposalId' = $2`, [
			projectId,
			done.proposal.id
		]);
		expect(audit[0]).toMatchObject({ actor_user_id: editor.id, subject: { from: 'outlet', background: true } });
		expect((await editor.call('POST', at(`/map/delineation/${done.proposal.id}/reject`))).status).toBe(200);
	});

	it('goes to the worker at once with `background`, from its first window', async () => {
		delineationLimits.jobWindows = [384, 1024];
		const res = await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		expect((await asOwner('SELECT from_window FROM delineation_request WHERE id = $1', [res.body.request.id]))[0].from_window).toBe(384);
		await tick();
		const done = (await editor.call('GET', at(`/map/delineation/requests/${res.body.request.id}`))).body.request;
		expect(done).toMatchObject({ status: 'proposed', proposal: { from: 'dam_wall', windowCells: 384 } });
		expect(done.proposal.areaM2).toBeLessThan(0.8 * BASIN_AREA_M2);
	});

	it('records the refusal at the worker’s own cap, in the request’s words; the job is done, not failed', async () => {
		delineationLimits.requestWindows = [128];
		delineationLimits.jobWindows = [256, 384];
		const res = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const proposalsBefore = (await asOwner('SELECT count(*)::int AS n FROM delineation_proposal WHERE project_id = $1', [projectId]))[0].n;
		await tick();
		expect((await jobOf(res.body.request.id)).status).toBe('done');
		const done = (await viewer.call('GET', at(`/map/delineation/requests/${res.body.request.id}`))).body.request;
		expect(done).toMatchObject({ status: 'refused', proposal: null, refusal: { reason: 'too_large', message: expect.stringMatching(/^The catchment above that point reaches beyond the \d+ km/) } });
		expect((await asOwner('SELECT count(*)::int AS n FROM delineation_proposal WHERE project_id = $1', [projectId]))[0].n).toBe(proposalsBefore);
	});

	it('refuses as before when the worker has no larger window than the request', async () => {
		delineationLimits.requestWindows = [256];
		delineationLimits.jobWindows = [128, 256];
		const res = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(res.status).toBe(422);
		expect(res.body).toMatchObject({ details: { reason: 'too_large' } });
		expect((await asOwner('SELECT count(*)::int AS n FROM delineation_request WHERE project_id = $1 AND status = $2', [projectId, 'queued']))[0].n).toBe(0);
	});

	it('says delineation is off when the DEM went away before the job ran', async () => {
		const res = await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true });
		expect(res.status).toBe(202);
		process.env.DEM_URL = '';
		await tick();
		const done = (await viewer.call('GET', at(`/map/delineation/requests/${res.body.request.id}`))).body.request;
		expect(done).toMatchObject({ status: 'refused', refusal: { reason: 'off' } });
	});
});

describe('one large delineation per account', () => {
	it('supersedes the account’s waiting click in the project: its job is cancelled and it stores nothing', async () => {
		const first = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet', background: true });
		const second = await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true });
		expect([first.status, second.status]).toEqual([202, 202]);
		expect(await jobOf(first.body.request.id)).toMatchObject({ status: 'dead', last_error: 'cancelled' });
		expect((await viewer.call('GET', at(`/map/delineation/requests/${first.body.request.id}`))).body.request.status).toBe('superseded');
		await tick();
		const proposed = await asOwner(`SELECT click_kind FROM delineation_proposal WHERE project_id = $1 AND status = 'proposed'`, [projectId]);
		expect(proposed.map((p) => p.click_kind)).toEqual(['dam_wall']);
	});

	it('queues one of two clicks at once from one account (the advisory lock and the dedupe key): the other supersedes it', async () => {
		const [a, b] = await Promise.all([
			editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet', background: true }),
			editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true })
		]);
		expect([a.status, b.status]).toEqual([202, 202]);
		const pending = await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'delineate' AND acting_user_id = $1 AND status IN ('queued', 'running', 'failed')`, [editor.id]);
		expect(pending[0].n).toBe(1);
		expect((await asOwner(`SELECT count(*)::int AS n FROM delineation_request WHERE project_id = $1 AND status = 'queued'`, [projectId]))[0].n).toBe(1);
	});

	it('refuses (429) one waiting in another catchment, or running; another account queues beside it (positive control)', async () => {
		const there = await editor.call('POST', at('/map/delineation', otherProjectId), { ...DAM, from: 'dam_wall', background: true });
		expect(there.status).toBe(202);
		const here = await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true });
		expect(here.status).toBe(429);
		expect(here.body.error).toMatch(/waiting in another catchment/);
		// The owner is another account: theirs queues.
		expect((await owner.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true })).status).toBe(202);
		// Running (claimed by a worker): even in its own project, a new click waits.
		const job = await jobOf(there.body.request.id);
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [job.id]);
		const again = await editor.call('POST', at('/map/delineation', otherProjectId), { ...OUTLET, from: 'outlet', background: true });
		expect(again.status).toBe(429);
		expect(again.body.error).toMatch(/still being worked out/);
		expect((await viewer.call('GET', at(`/map/delineation/requests/${there.body.request.id}`, otherProjectId))).body.request.status).toBe('running');
		await asOwner(`UPDATE job SET status = 'dead', locked_until = NULL, lease_token = NULL, finished_at = now() WHERE id = $1`, [job.id]);
		// A job that died: the request says it failed, and why.
		expect((await viewer.call('GET', at(`/map/delineation/requests/${there.body.request.id}`, otherProjectId))).body.request).toMatchObject({ status: 'failed', error: expect.any(String) });
	});
});

describe('who reads and queues', () => {
	it('lets a viewer read a request, never queue one; strangers and other projects get 404', async () => {
		const res = await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true });
		expect(res.status).toBe(202);
		const rid = res.body.request.id;
		expect((await viewer.call('GET', at(`/map/delineation/requests/${rid}`))).status).toBe(200);
		expect((await viewer.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true })).status).toBe(403);
		expect((await stranger.call('GET', at(`/map/delineation/requests/${rid}`))).status).toBe(404);
		expect((await editor.call('GET', at(`/map/delineation/requests/${rid}`, otherProjectId))).status).toBe(404);
		expect((await editor.call('GET', at('/map/delineation/requests/not-a-uuid'))).status).toBe(404);
	});

	it('holds the request table to RLS: a viewer neither inserts nor updates; an editor does (positive control)', async () => {
		const insert = (u: User) =>
			withUser(u.id, (db) =>
				db.query(`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, from_window, created_by) VALUES ($1, 'outlet', 20, -33, 1024, $2) RETURNING id`, [
					projectId,
					u.id
				])
			);
		await expect(insert(viewer)).rejects.toThrow(/row-level security/);
		const { rows } = await insert(editor);
		expect(rows).toHaveLength(1);
		// Not in another's name.
		await expect(
			withUser(editor.id, (db) =>
				db.query(`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, from_window, created_by) VALUES ($1, 'outlet', 20, -33, 1024, $2)`, [projectId, owner.id])
			)
		).rejects.toThrow(/row-level security/);
		const upd = await withUser(viewer.id, (db) => db.query(`UPDATE delineation_request SET status = 'superseded', finished_at = now() WHERE id = $1`, [rows[0]!.id]));
		expect(upd.rowCount).toBe(0);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM delineation_request WHERE id = $1', [rows[0]!.id]))).rowCount).toBe(0);
		expect((await withUser(viewer.id, (db) => db.query('SELECT id FROM delineation_request WHERE id = $1', [rows[0]!.id]))).rowCount).toBe(1);
		// A finished request stays as it finished.
		await withUser(editor.id, (db) => db.query(`UPDATE delineation_request SET status = 'refused', refusal_code = 'off', refusal = 'x', finished_at = now() WHERE id = $1`, [rows[0]!.id]));
		await expect(withUser(editor.id, (db) => db.query(`UPDATE delineation_request SET refusal = 'y' WHERE id = $1`, [rows[0]!.id]))).rejects.toThrow(/finished once/);
	});
});

describe('the 30-day job clean-up', () => {
	it('clears a request’s job and keeps the request, finished or waiting (148_job_purge_clears_links)', async () => {
		const done = (await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall', background: true })).body.request;
		await tick();
		const stuck = (await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet', background: true })).body.request;
		// The second's job died before it ran: the request still waits for an outcome.
		const stuckJob = await jobOf(stuck.id);
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now() WHERE id = $1`, [stuckJob.id]);
		const doneJob = await jobOf(done.id);
		await asOwner(`UPDATE job SET finished_at = now() - interval '31 days' WHERE id = ANY($1)`, [[doneJob.id, stuckJob.id]]);
		expect((await tick()).purged).toBeGreaterThanOrEqual(2);
		const after = await asOwner('SELECT id, status, job_id FROM delineation_request WHERE id = ANY($1) ORDER BY created_at', [[done.id, stuck.id]]);
		expect(after).toEqual([
			{ id: done.id, status: 'proposed', job_id: null },
			{ id: stuck.id, status: 'queued', job_id: null }
		]);
		expect((await viewer.call('GET', at(`/map/delineation/requests/${done.id}`))).body.request).toMatchObject({ status: 'proposed', proposal: { from: 'dam_wall' } });
		expect((await viewer.call('GET', at(`/map/delineation/requests/${stuck.id}`))).body.request).toMatchObject({ status: 'failed', error: 'The background job that had it is gone.' });
	});
});
