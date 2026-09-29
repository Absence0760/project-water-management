// Server-side PDF reports end to end against Postgres (023_reports.sql,
// reports/*): the render token (single use, 5 minutes, one project and one
// run, as the requester), the session it buys (refused everywhere else), the
// report API and its RLS, report schedules (RLS, recipients, the tick), and
// impact reports (082): the baseline must be readable by the requester.
// The render itself (Chromium + MinIO) is reports/render.db.test.ts.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anon, app, asOwner, lastMailTo, monthly, node, signUp } from '../__tests__/helpers.js';
import { newToken } from '../auth/tokens.js';
import { withUser } from '../db/tx.js';
import { reportRenderHandler } from '../jobs/handlers/report-render.js';
import { SCHEDULE_NO_ACCESS, SCHEDULE_NO_RUNS, scheduleDueReports } from './schedule.js';
import { finishReport, loadReport, REPORTS_PER_HOUR } from './store.js';
import { cannedPolicy } from './cloudfrontSign.js';
import { issueRenderToken } from './tokens.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

afterEach(() => vi.unstubAllEnvs());

async function project(owner: User, name = 'Reports') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}

/** A project with one run (the jobs.db.test.ts fixture). */
async function withRun(u: User, name = 'Report run') {
	const projectId = await project(u, name);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await u.call('POST', `/projects/${projectId}/runs`, {});
	expect(run.status).toBe(201);
	return { projectId, runId: run.body.run.id as string, farmId: farm.id };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

/** Exchange a render token, returning the render session's cookie (or the refusal). */
async function exchange(token: string) {
	const res = await anon('POST', '/auth/render-session', { token });
	return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null, body: res.body };
}

/** A request with only the given cookie. */
async function as(cookie: string, method: string, path: string, body?: unknown) {
	const r = await app.request(path, {
		method,
		headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return r.status;
}

describe('render tokens', () => {
	it('the session says it is the renderer’s on /auth/me, so the page renders the report even for an account behind on the terms (positive control: that account’s own session doesn’t)', async () => {
		const owner = await signUp('RtTerms');
		const { projectId, runId } = await withRun(owner, 'Terms behind');
		// Accepted an older version: the app would ask again.
		await asOwner('UPDATE app_user SET terms_version = $2 WHERE id = $1', [owner.id, '2020-01-01']);
		const own = (await owner.call('GET', '/auth/me')).body.user;
		expect(own.termsCurrent).toBe(false);
		expect(own).not.toHaveProperty('renderSession');
		const { cookie } = await exchange(await withUser(owner.id, (db) => issueRenderToken(db, projectId, runId)));
		const res = await app.request('/auth/me', { headers: { cookie: cookie!, origin: ORIGIN } });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { user: unknown }).user).toMatchObject({ id: owner.id, termsCurrent: false, renderSession: true });
	});

	it('a viewer issues one; it buys a session that reads that project and run (positive control) and nothing else', async () => {
		const owner = await signUp('RtOwner');
		const viewer = await signUp('RtViewer');
		const { projectId, runId } = await withRun(owner, 'Scoped');
		const otherRun = (await owner.call('POST', `/projects/${projectId}/runs`, {})).body.run.id as string;
		await member(owner, projectId, viewer, 'viewer');
		// Another project the viewer can fully see, and one they can't.
		const { projectId: theirs } = await withRun(viewer, 'Viewer own');
		const strangers = await project(await signUp('RtStranger'), 'Elsewhere');

		const token = await withUser(viewer.id, (db) => issueRenderToken(db, projectId, runId));
		// Only the hash is stored.
		const stored = await asOwner('SELECT token_hash, user_id, expires_at - created_at AS ttl FROM render_token WHERE project_id = $1', [projectId]);
		expect(stored).toHaveLength(1);
		expect(stored[0].user_id).toBe(viewer.id);
		expect(Buffer.from(stored[0].token_hash).toString('base64url')).not.toBe(token);
		expect(stored[0].ttl).toMatchObject({ minutes: 5 });

		const s = await exchange(token);
		expect(s.status).toBe(200);
		const cookie = s.cookie!;
		expect(cookie).toMatch(/^wm_session=/);

		// Positive controls: exactly the report page's reads.
		expect(await as(cookie, 'GET', '/auth/me')).toBe(200);
		expect(await as(cookie, 'GET', `/projects/${projectId}`)).toBe(200);
		expect(await as(cookie, 'GET', `/projects/${projectId}/series`)).toBe(200);
		expect(await as(cookie, 'GET', `/projects/${projectId}/runs/${runId}`)).toBe(200);
		expect(await as(cookie, 'GET', `/projects/${projectId}/runs/${runId}/series?key=outflow_m3`)).not.toBe(403);

		// Everything else is refused, even what the viewer could see with a full session.
		for (const path of [
			`/projects/${theirs}`,
			`/projects/${theirs}/series`,
			`/projects/${strangers}`,
			`/projects/${projectId}/runs/${otherRun}`,
			`/projects/${projectId}/runs`,
			`/projects/${projectId}/members`,
			`/projects/${projectId}/model`,
			`/projects/${projectId}/jobs`,
			`/projects/${projectId}/export.json`,
			`/projects/${projectId}/reports/${crypto.randomUUID()}`,
			`/projects/${projectId}/runs/${runId}/../../${theirs}`,
			'/projects',
			'/teams',
			'/compare'
		]) {
			expect(await as(cookie, 'GET', path), path).toBe(403);
		}
		expect(await as(cookie, 'POST', `/projects/${projectId}/runs`, {})).toBe(403);
		expect(await as(cookie, 'PATCH', `/projects/${projectId}`, { name: 'Renamed' })).toBe(403);
		expect(await as(cookie, 'POST', `/projects/${projectId}/reports`, {})).toBe(403);
		expect(await as(cookie, 'DELETE', `/projects/${projectId}`)).toBe(403);
	});

	it('is single use, and dies after 5 minutes', async () => {
		const owner = await signUp('RtOnce');
		const { projectId, runId } = await withRun(owner);
		const token = await withUser(owner.id, (db) => issueRenderToken(db, projectId, runId));
		expect((await exchange(token)).status).toBe(200);
		const again = await exchange(token);
		expect(again.status).toBe(400);
		expect(again.cookie).toBeNull();
		// Coded: the renderer treats only this refusal as final (reports/render.ts sessionRefusal).
		expect(again.body).toEqual({ error: 'this render token is invalid, used or expired', code: 'render_token_refused' });

		const late = await withUser(owner.id, (db) => issueRenderToken(db, projectId, runId));
		await asOwner(`UPDATE render_token SET expires_at = now() - interval '1 second' WHERE project_id = $1`, [projectId]);
		expect((await exchange(late)).status).toBe(400);
		// A consumed or expired token is gone; nothing else is.
		expect(await asOwner('SELECT id FROM render_token WHERE project_id = $1', [projectId])).toEqual([]);
		// Malformed and unknown tokens: the same answer.
		expect((await exchange('not-a-token')).status).toBe(400);
		expect((await exchange(newToken().token)).status).toBe(400);
	});

	it('only a member can issue one, for a run of that project, as themselves; nobody reads or changes another’s', async () => {
		const owner = await signUp('RtIssuer');
		const stranger = await signUp('RtOutsider');
		const { projectId, runId } = await withRun(owner);
		const { runId: foreignRun } = await withRun(stranger, 'Stranger run');
		await expect(withUser(stranger.id, (db) => issueRenderToken(db, projectId, runId))).rejects.toMatchObject({ code: '42501' });
		// A run of another project, even one the issuer owns.
		await expect(withUser(owner.id, (db) => issueRenderToken(db, projectId, foreignRun))).rejects.toMatchObject({ code: '23514' });
		// Forging the user or a long life is overwritten by the trigger.
		const { hash } = newToken();
		const { rows } = await withUser(owner.id, (db) =>
			db.query(`INSERT INTO render_token (token_hash, user_id, project_id, run_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 year')
				RETURNING user_id, expires_at <= now() + interval '5 minutes' AS short`, [hash, stranger.id, projectId, runId])
		);
		expect(rows[0]).toEqual({ user_id: owner.id, short: true });
		// Positive control: the issuer sees their own; the stranger sees none, and no one updates or deletes.
		expect((await withUser(owner.id, (db) => db.query('SELECT id FROM render_token WHERE project_id = $1', [projectId]))).rows).toHaveLength(1);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM render_token WHERE project_id = $1', [projectId]))).rows).toHaveLength(0);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE render_token SET expires_at = now() + interval '1 day' WHERE project_id = $1`, [projectId]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM render_token WHERE project_id = $1', [projectId]))).rejects.toMatchObject({ code: '42501' });
	});

	it('is refused when the requester lost access between issue and use', async () => {
		const owner = await signUp('RtRevoke');
		const viewer = await signUp('RtRevoked');
		const { projectId, runId } = await withRun(owner);
		await member(owner, projectId, viewer, 'viewer');
		const token = await withUser(viewer.id, (db) => issueRenderToken(db, projectId, runId));
		expect((await owner.call('DELETE', `/projects/${projectId}/members/${viewer.id}`)).status).toBe(204);
		const res = await exchange(token);
		expect(res.status).toBe(403);
		expect(res.cookie).toBeNull();
		expect(res.body).toEqual({ error: 'the requester can no longer see this report', code: 'render_token_refused' });
	});
});

// Production (REPORT_RENDERER=sqs): the renderer Lambda's answer comes back as
// a report_render job carrying `result`. A retryable failure (a WAF block, a
// timeout) asks again with backoff, up to REPORT_MAX_ATTEMPTS requests; a
// final one fails the report at once.
describe('the renderer’s answer (production)', () => {
	it('asks again after 2, then 4 minutes for a retryable failure, then fails; a final failure fails at once', async () => {
		const owner = await signUp('RrRetry');
		const { projectId } = await withRun(owner, 'Retry');
		const queue = async () => {
			const res = await owner.call('POST', `/projects/${projectId}/reports`, {});
			expect(res.status).toBe(202);
			const [{ id }] = await asOwner('SELECT id FROM report WHERE job_id = $1', [res.body.jobId]);
			// The request went out (what the sqs branch does): the report waits for the answer.
			await asOwner(`UPDATE report SET status = 'rendering' WHERE id = $1`, [id]);
			await asOwner(`UPDATE job SET status = 'done', finished_at = now() WHERE id = $1`, [res.body.jobId]);
			return id as string;
		};
		const answer = (reportId: string, retry: boolean) => {
			const job = { id: crypto.randomUUID(), projectId, kind: 'report_render' as const, actingUserId: owner.id, leaseToken: crypto.randomUUID(), attempts: 1, maxAttempts: 3 };
			const result = { ok: false as const, error: 'the render session could not start (HTTP 403)', retry };
			return withUser(owner.id, (db) => reportRenderHandler.run({ db, job, payload: { reportId, result }, progress: async () => true }));
		};
		const requests = (reportId: string) =>
			asOwner(
				`SELECT status, round(extract(epoch FROM run_after - created_at) / 60)::int AS "delayMin", max_attempts AS "maxAttempts"
				 FROM job WHERE project_id = $1 AND payload->>'reportId' = $2 AND NOT (payload ? 'result') ORDER BY created_at`,
				[projectId, reportId]
			);
		const report = async (id: string) => (await asOwner('SELECT status, error FROM report WHERE id = $1', [id]))[0];

		const r = await queue();
		await answer(r, true);
		expect(await requests(r)).toEqual([
			{ status: 'done', delayMin: 0, maxAttempts: 3 },
			{ status: 'queued', delayMin: 2, maxAttempts: 3 }
		]);
		expect(await report(r)).toEqual({ status: 'rendering', error: null });
		await answer(r, true);
		expect((await requests(r)).map((j) => j.delayMin)).toEqual([0, 2, 4]);
		expect(await report(r)).toEqual({ status: 'rendering', error: null });
		// Three requests made: the third retryable failure is the last.
		await answer(r, true);
		expect(await requests(r)).toHaveLength(3);
		expect(await report(r)).toEqual({ status: 'failed', error: 'the renderer failed: the render session could not start (HTTP 403)' });

		// A final failure (the API's coded refusal) asks nothing again.
		const f = await queue();
		await answer(f, false);
		expect(await requests(f)).toHaveLength(1);
		expect((await report(f)).status).toBe('failed');
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});
});

describe('POST / GET /projects/:id/reports', () => {
	it('a viewer queues a PDF of the latest run and reads its status; a stranger gets 404', async () => {
		const owner = await signUp('RepOwner');
		const viewer = await signUp('RepViewer');
		const stranger = await signUp('RepStranger');
		const { projectId, runId } = await withRun(owner);
		await member(owner, projectId, viewer, 'viewer');

		const res = await viewer.call('POST', `/projects/${projectId}/reports`, { email: true });
		expect(res.status).toBe(202);
		const jobId = res.body.jobId as string;
		const status = await viewer.call('GET', `/projects/${projectId}/reports/${jobId}`);
		expect(status.status).toBe(200);
		expect(status.body).toEqual({
			report: expect.objectContaining({ jobId, status: 'queued', runId, scheduled: false, pages: null, error: null, emailed: 1 })
		});
		expect(status.body.url).toBeUndefined();
		// The job and the report are the viewer's: they run as them.
		const [row] = await asOwner('SELECT r.requested_by, r.email_to, j.kind, j.acting_user_id FROM report r JOIN job j ON j.id = r.job_id WHERE r.job_id = $1', [jobId]);
		expect(row).toEqual({ requested_by: viewer.id, email_to: [viewer.id], kind: 'report_render', acting_user_id: viewer.id });

		// Positive control above; the owner sees it too; a stranger sees nothing.
		expect((await owner.call('GET', `/projects/${projectId}/reports/${jobId}`)).status).toBe(200);
		expect((await stranger.call('GET', `/projects/${projectId}/reports/${jobId}`)).status).toBe(404);
		expect((await stranger.call('POST', `/projects/${projectId}/reports`, {})).status).toBe(404);
		expect((await viewer.call('GET', `/projects/${projectId}/reports/not-a-uuid`)).status).toBe(404);
		expect((await viewer.call('GET', `/projects/${projectId}/reports/${crypto.randomUUID()}`)).status).toBe(404);
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});

	it('emails others only for editors, and only members; picks the asked-for run, never another project’s', async () => {
		const owner = await signUp('MailOwner');
		const viewer = await signUp('MailViewer');
		const outsider = await signUp('MailOutsider');
		const { projectId, runId } = await withRun(owner);
		const { runId: foreignRun } = await withRun(outsider, 'Foreign');
		await member(owner, projectId, viewer, 'viewer');

		const viewerToOwner = await viewer.call('POST', `/projects/${projectId}/reports`, { email: [owner.id] });
		expect(viewerToOwner.status).toBe(403);
		expect(viewerToOwner.body.error).toBe('only editors and owners can email a report to other members');
		// A viewer listing only themselves is fine.
		expect((await viewer.call('POST', `/projects/${projectId}/reports`, { email: [viewer.id] })).status).toBe(202);

		const toOutsider = await owner.call('POST', `/projects/${projectId}/reports`, { email: [outsider.id] });
		expect(toOutsider.status).toBe(400);
		expect(toOutsider.body.error).toBe('every recipient must be a member of the project who can read its report (a viewer or above)');
		const ok = await owner.call('POST', `/projects/${projectId}/reports`, { runId, email: [viewer.id, owner.id] });
		expect(ok.status).toBe(202);
		const [row] = await asOwner('SELECT email_to, run_id FROM report WHERE job_id = $1', [ok.body.jobId]);
		expect(new Set(row.email_to)).toEqual(new Set([viewer.id, owner.id]));
		expect(row.run_id).toBe(runId);

		expect((await owner.call('POST', `/projects/${projectId}/reports`, { runId: foreignRun })).status).toBe(404);
		expect((await owner.call('POST', `/projects/${projectId}/reports`, { email: 'someone@example.com' })).status).toBe(400);
		const empty = await project(owner, 'No runs');
		const none = await owner.call('POST', `/projects/${empty}/reports`, {});
		expect(none.status).toBe(409);
		expect(none.body.error).toBe('the project has no runs to report on');
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});

	it(`limits on-demand PDFs to ${REPORTS_PER_HOUR} an hour per user and project`, async () => {
		const owner = await signUp('RateOwner');
		const { projectId } = await withRun(owner);
		for (let i = 0; i < REPORTS_PER_HOUR; i++) expect((await owner.call('POST', `/projects/${projectId}/reports`, {})).status).toBe(202);
		const over = await owner.call('POST', `/projects/${projectId}/reports`, {});
		expect(over.status).toBe(429);
		// An hour later it's allowed again.
		await asOwner(`UPDATE report SET created_at = now() - interval '61 minutes' WHERE project_id = $1`, [projectId]);
		expect((await owner.call('POST', `/projects/${projectId}/reports`, {})).status).toBe(202);
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});

	it('shows a dead render as failed with its sanitised reason, and a finished one as done, with no link in the status', async () => {
		vi.stubEnv('STORAGE', 'local');
		const owner = await signUp('StateOwner');
		const { projectId } = await withRun(owner);
		const { jobId } = (await owner.call('POST', `/projects/${projectId}/reports`, {})).body;
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), last_error = 'the render took longer than 90 s' WHERE id = $1`, [jobId]);
		const dead = await owner.call('GET', `/projects/${projectId}/reports/${jobId}`);
		expect(dead.body.report).toMatchObject({ status: 'failed', error: 'the render took longer than 90 s' });
		expect(dead.body.url).toBeUndefined();
		expect((await pdf(owner, projectId, jobId)).status).toBe(409);

		const { jobId: done } = (await owner.call('POST', `/projects/${projectId}/reports`, {})).body;
		const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [done]);
		await withUser(owner.id, (db) => db.query(`UPDATE report SET status = 'done', pages = 9, bytes = 1000, finished_at = now() WHERE id = $1`, [r.id]));
		const ok = await owner.call('GET', `/projects/${projectId}/reports/${done}`);
		expect(ok.body.report).toMatchObject({ status: 'done', pages: 9 });
		// The status never carries a pre-signed link: the download route mints one per click (issue #126).
		expect(ok.body).toEqual({ report: expect.objectContaining({ status: 'done' }) });
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});
});

/** GET the download route as `u`, without following the redirect. */
const pdf = (u: User, projectId: string, jobId: string) =>
	app.request(`/projects/${projectId}/reports/${jobId}/pdf`, { headers: { cookie: u.cookie, origin: ORIGIN }, redirect: 'manual' });

describe('GET /projects/:id/reports/:jobId/pdf', () => {
	it('redirects a member to a one-minute pre-signed GET, fresh each time; a stranger, a pending or an expired PDF gets none', async () => {
		vi.stubEnv('STORAGE', 'local');
		vi.stubEnv('REPORT_DOWNLOADS', 'presigned');
		const owner = await signUp('PdfOwner');
		const viewer = await signUp('PdfViewer');
		const stranger = await signUp('PdfStranger');
		const { projectId } = await withRun(owner);
		await member(owner, projectId, viewer, 'viewer');
		const { jobId } = (await owner.call('POST', `/projects/${projectId}/reports`, {})).body;
		// Not rendered yet: nothing to download.
		const pending = await pdf(viewer, projectId, jobId);
		expect(pending.status).toBe(409);
		expect(pending.headers.get('location')).toBeNull();

		const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [jobId]);
		await withUser(owner.id, (db) => db.query(`UPDATE report SET status = 'done', pages = 9, bytes = 1000, finished_at = now() WHERE id = $1`, [r.id]));
		// Positive control: a viewer is redirected. Signed locally: no request to storage is needed.
		const res = await pdf(viewer, projectId, jobId);
		expect(res.status).toBe(302);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
		const location = res.headers.get('location')!;
		expect(location).toContain(`/water-reports/reports/${projectId}/${r.id}.pdf?`);
		expect(location).toContain('X-Amz-Expires=60&');
		expect(location).toContain('response-content-disposition=attachment');
		expect(location).toMatch(/filename%3D%22[\w-]+-report-\d{4}-\d{2}-\d{2}\.pdf%22/);

		// No session, a stranger, another project's id, a bad or unknown job: no redirect.
		const nobody = await app.request(`/projects/${projectId}/reports/${jobId}/pdf`, { headers: { origin: ORIGIN }, redirect: 'manual' });
		expect(nobody.status).toBe(401);
		expect((await pdf(stranger, projectId, jobId)).status).toBe(404);
		const other = await project(stranger, 'Stranger’s own');
		expect((await pdf(stranger, other, jobId)).status).toBe(404);
		expect((await pdf(viewer, projectId, 'not-a-uuid')).status).toBe(404);
		expect((await pdf(viewer, projectId, crypto.randomUUID())).status).toBe(404);

		// Past the bucket's lifecycle the object is gone: say so instead of redirecting to S3's error.
		await withUser(owner.id, (db) => db.query(`UPDATE report SET finished_at = now() - interval '7 days 1 hour' WHERE id = $1`, [r.id]));
		const gone = await pdf(viewer, projectId, jobId);
		expect(gone.status).toBe(404);
		expect(((await gone.json()) as { error: string }).error).toBe('the PDF has expired: PDFs are kept for 7 days');
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});

	it('in production (REPORT_DOWNLOADS=cloudfront) redirects to a CloudFront signed URL on the site’s /reports/ path, never to S3', async () => {
		// A throwaway key pair: production's comes from Terraform (infra/reports.tf).
		const { privateKey, publicKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
		});
		vi.stubEnv('REPORT_DOWNLOADS', 'cloudfront');
		vi.stubEnv('SITE_URL', 'https://water.example.org');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', 'K2JCJMDEHXQW5F');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', privateKey);
		const owner = await signUp('PdfCfOwner');
		const stranger = await signUp('PdfCfStranger');
		const { projectId } = await withRun(owner, 'Upper Catchment');
		const { jobId } = (await owner.call('POST', `/projects/${projectId}/reports`, {})).body;
		const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [jobId]);
		await withUser(owner.id, (db) => db.query(`UPDATE report SET status = 'done', pages = 9, bytes = 1000, finished_at = now() WHERE id = $1`, [r.id]));

		const before = Math.floor(Date.now() / 1000);
		const res = await pdf(owner, projectId, jobId);
		expect(res.status).toBe(302);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const location = res.headers.get('location')!;
		const m = /^(.*)&Expires=(\d+)&Signature=([A-Za-z0-9~_-]+)&Key-Pair-Id=K2JCJMDEHXQW5F&Hash-Algorithm=SHA256$/.exec(location);
		expect(m, location).not.toBeNull();
		const [, resource, expires, signature] = m!;
		expect(resource).toMatch(
			new RegExp(`^https://water\\.example\\.org/reports/${projectId}/${r.id}\\.pdf\\?response-content-disposition=attachment%3B%20filename%3D%22upper-catchment-report-\\d{4}-\\d{2}-\\d{2}\\.pdf%22$`)
		);
		expect(Number(expires) - before).toBeGreaterThanOrEqual(59);
		expect(Number(expires) - before).toBeLessThanOrEqual(61);
		expect(location).not.toMatch(/X-Amz-|amazonaws\.com|9002/);
		// CloudFront's check: the canned policy rebuilt from the URL verifies with the public key.
		const sig = Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
		expect(createVerify('RSA-SHA256').update(cannedPolicy(resource!, Number(expires))).verify(publicKey, sig)).toBe(true);

		// Membership still gates the signing: a stranger gets no URL.
		expect((await pdf(stranger, projectId, jobId)).status).toBe(404);
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});
});

describe('impact reports (082): a run against a baseline the requester can read', () => {
	/** Owner of A and B; `viewer` reads A only. A has a baseline and a what-if; B has a run. */
	async function world(tag: string) {
		const owner = await signUp(`Imp${tag}Owner`);
		const viewer = await signUp(`Imp${tag}Viewer`);
		const a = await withRun(owner, `Impact ${tag} A`);
		const whatIf = (await owner.call('POST', `/projects/${a.projectId}/runs`, {})).body.run.id as string;
		const b = await withRun(owner, `Impact ${tag} B`);
		await member(owner, a.projectId, viewer, 'viewer');
		return { owner, viewer, a: a.projectId, baseline: a.runId, whatIf, b: b.projectId, bRun: b.runId };
	}
	const cleanUp = (...projects: string[]) => asOwner('DELETE FROM job WHERE project_id = ANY($1)', [projects]);

	it('queues one when the requester can read both runs (positive control), in this project or another; refuses a baseline they can’t read', async () => {
		const w = await world('Api');
		// Positive controls: the baseline in the same project, and in another project the owner reads.
		const same = await w.owner.call('POST', `/projects/${w.a}/reports`, { runId: w.whatIf, against: `${w.a}:${w.baseline}`, email: true });
		expect(same.status).toBe(202);
		const cross = await w.owner.call('POST', `/projects/${w.a}/reports`, { runId: w.whatIf, against: `${w.b}:${w.bRun}` });
		expect(cross.status).toBe(202);
		const rows = await asOwner('SELECT job_id, impact, against_run_id FROM report WHERE job_id = ANY($1)', [[same.body.jobId, cross.body.jobId]]);
		expect(new Set(rows.map((r) => `${r.job_id} ${r.impact} ${r.against_run_id}`))).toEqual(
			new Set([`${same.body.jobId} true ${w.baseline}`, `${cross.body.jobId} true ${w.bRun}`])
		);
		// The status says it's an impact report; a plain one says it isn't. Neither names the baseline.
		const status = await w.viewer.call('GET', `/projects/${w.a}/reports/${cross.body.jobId}`);
		expect(status.body.report).toMatchObject({ impact: true, runId: w.whatIf });
		expect(JSON.stringify(status.body)).not.toContain(w.bRun);
		const plain = await w.viewer.call('POST', `/projects/${w.a}/reports`, {});
		expect((await w.viewer.call('GET', `/projects/${w.a}/reports/${plain.body.jobId}`)).body.report).toMatchObject({ impact: false });

		// The viewer reads A (positive control: A's own baseline is fine) but not B: B's run is refused, and nothing is queued.
		expect((await w.viewer.call('POST', `/projects/${w.a}/reports`, { runId: w.whatIf, against: `${w.a}:${w.baseline}` })).status).toBe(202);
		const before = await asOwner('SELECT count(*)::int AS n FROM report WHERE project_id = $1', [w.a]);
		const refused = await w.viewer.call('POST', `/projects/${w.a}/reports`, { runId: w.whatIf, against: `${w.b}:${w.bRun}` });
		expect(refused.status).toBe(404);
		expect(refused.body.error).toBe("no such baseline run, or its project isn't shared with you");
		expect(await asOwner('SELECT count(*)::int AS n FROM report WHERE project_id = $1', [w.a])).toEqual(before);

		// Malformed or inconsistent requests.
		const bad = async (body: object) => (await w.owner.call('POST', `/projects/${w.a}/reports`, body)).status;
		expect(await bad({ against: `${w.a}:${w.baseline}` })).toBe(400); // no runId
		expect(await bad({ runId: w.whatIf, against: `${w.a}:${w.whatIf}` })).toBe(400); // against itself
		expect(await bad({ runId: w.whatIf, against: w.baseline })).toBe(400);
		expect(await bad({ runId: w.whatIf, against: `${w.b}:${w.baseline}` })).toBe(404); // the run, under the wrong project
		expect(await bad({ runId: w.whatIf, against: `${w.a}:${crypto.randomUUID()}` })).toBe(404);
		await cleanUp(w.a, w.b);
	});

	it('the database refuses an unreadable, missing or self baseline, whatever the route does', async () => {
		const w = await world('Db');
		const insert = (u: User, against: string | null, impact = true) =>
			withUser(u.id, (db) => db.query('INSERT INTO report (project_id, run_id, impact, against_run_id) VALUES ($1, $2, $3, $4) RETURNING against_run_id', [w.a, w.whatIf, impact, against]));
		// Positive control: the viewer's readable baseline is stored.
		expect((await insert(w.viewer, w.baseline)).rows).toEqual([{ against_run_id: w.baseline }]);
		// B's run: the viewer can't read it, so it's refused (the owner, who can, may).
		await expect(insert(w.viewer, w.bRun)).rejects.toMatchObject({ code: '42501' });
		expect((await insert(w.owner, w.bRun)).rows).toEqual([{ against_run_id: w.bRun }]);
		await expect(insert(w.owner, null)).rejects.toMatchObject({ code: '23514' });
		await expect(insert(w.owner, w.whatIf)).rejects.toMatchObject({ code: '23514' });
		// A plain report can't carry a baseline, and the baseline is fixed once queued.
		await expect(insert(w.owner, w.baseline, false)).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(w.owner.id, (db) => db.query('UPDATE report SET against_run_id = $2 WHERE project_id = $1', [w.a, w.bRun]))).rejects.toMatchObject({ code: '42501' });
		await asOwner('DELETE FROM report WHERE project_id = $1', [w.a]);
	});

	it('a render token for one reads the one comparison, and nothing of the baseline’s project; refused if the baseline becomes unreadable', async () => {
		const w = await world('Tok');
		// Positive control: the owner reads B, so its run can be the baseline.
		const token = await withUser(w.owner.id, (db) => issueRenderToken(db, w.a, w.whatIf, w.bRun));
		expect(await asOwner('SELECT against_run_id FROM render_token WHERE project_id = $1', [w.a])).toEqual([{ against_run_id: w.bRun }]);
		const { status, cookie } = await exchange(token);
		expect(status).toBe(200);
		const compare = (a: string, b: string, extra = '') => `/compare/runs?${new URLSearchParams({ a, b })}${extra}`;
		expect(await as(cookie!, 'GET', compare(`${w.b}:${w.bRun}`, `${w.a}:${w.whatIf}`))).toBe(200);
		expect(await as(cookie!, 'GET', `/projects/${w.a}/runs/${w.whatIf}`)).toBe(200);
		for (const path of [
			compare(`${w.a}:${w.whatIf}`, `${w.b}:${w.bRun}`), // swapped
			compare(`${w.a}:${w.baseline}`, `${w.a}:${w.whatIf}`), // another baseline the owner can read
			compare(`${w.b}:${w.bRun}`, `${w.a}:${w.baseline}`), // another run
			compare(`${w.b}:${w.bRun}`, `${w.a}:${w.whatIf}`, `&a=${w.a}:${w.baseline}`), // a second a
			compare(`${w.b}:${w.bRun}`, `${w.a}:${w.whatIf}`, '&x=1'),
			`/projects/${w.b}`,
			`/projects/${w.b}/runs/${w.bRun}`,
			`/projects/${w.b}/series`
		]) {
			expect(await as(cookie!, 'GET', path), path).toBe(403);
		}
		// A plain report's session never compares.
		const plain = await exchange(await withUser(w.owner.id, (db) => issueRenderToken(db, w.a, w.whatIf)));
		expect(await as(plain.cookie!, 'GET', compare(`${w.b}:${w.bRun}`, `${w.a}:${w.whatIf}`))).toBe(403);

		// The viewer can't issue one against B's run; against A's own baseline they can (positive control).
		await expect(withUser(w.viewer.id, (db) => issueRenderToken(db, w.a, w.whatIf, w.bRun))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(w.viewer.id, (db) => issueRenderToken(db, w.a, w.whatIf, w.whatIf))).rejects.toMatchObject({ code: '23514' });
		const own = await withUser(w.viewer.id, (db) => issueRenderToken(db, w.a, w.whatIf, w.baseline));
		expect((await exchange(own)).status).toBe(200);

		// Readable at issue, not at use: the viewer is given B, issues one, and loses B before the browser presents it.
		await member(w.owner, w.b, w.viewer, 'viewer');
		const late = await withUser(w.viewer.id, (db) => issueRenderToken(db, w.a, w.whatIf, w.bRun));
		expect((await w.owner.call('DELETE', `/projects/${w.b}/members/${w.viewer.id}`)).status).toBe(204);
		const lost = await exchange(late);
		expect(lost.status).toBe(403);
		expect(lost.cookie).toBeNull();
	});

	it('the render fails, without retrying, when the baseline was deleted or became unreadable after the request', async () => {
		const w = await world('Job');
		await member(w.owner, w.b, w.viewer, 'viewer');
		const queue = async (u: User, against: string) => {
			const res = await u.call('POST', `/projects/${w.a}/reports`, { runId: w.whatIf, against });
			expect(res.status).toBe(202);
			const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [res.body.jobId]);
			return { jobId: res.body.jobId as string, reportId: r.id as string };
		};
		const render = (u: User, q: { jobId: string; reportId: string }) => {
			const job = { id: q.jobId, projectId: w.a, kind: 'report_render' as const, actingUserId: u.id, leaseToken: crypto.randomUUID(), attempts: 1, maxAttempts: 3 };
			return withUser(u.id, (db) => reportRenderHandler.run({ db, job, payload: { reportId: q.reportId }, progress: async () => true }));
		};
		const why = "the baseline run was deleted, or its project isn't shared with you any more, before the impact report was made";

		// Unreadable since: the viewer lost B.
		const lostAccess = await queue(w.viewer, `${w.b}:${w.bRun}`);
		expect((await w.owner.call('DELETE', `/projects/${w.b}/members/${w.viewer.id}`)).status).toBe(204);
		await expect(render(w.viewer, lostAccess)).rejects.toMatchObject({ message: why, retry: false });

		// Deleted since: the report stays an impact report, so it doesn't print the plain one.
		const deleted = await queue(w.owner, `${w.a}:${w.baseline}`);
		expect((await w.owner.call('DELETE', `/projects/${w.a}/runs/${w.baseline}`)).status).toBe(204);
		expect(await asOwner('SELECT impact, against_run_id FROM report WHERE id = $1', [deleted.reportId])).toEqual([{ impact: true, against_run_id: null }]);
		await expect(render(w.owner, deleted)).rejects.toMatchObject({ message: why, retry: false });
		expect(await asOwner('SELECT id FROM render_token WHERE project_id = $1', [w.a])).toEqual([]);
		await cleanUp(w.a, w.b);
	});
});

describe('the report-ready email', () => {
	// An unlabelled run is named by the day it was made, where the catchment is
	// (the project's zone, 058): a run made at 22:30 UTC is the next day in South Africa.
	it('names an unlabelled run by the day it was made in the project’s time zone (positive control: a UTC project)', async () => {
		const owner = await signUp('RepDay');
		const { projectId, runId } = await withRun(owner, 'Report day');
		await asOwner(`UPDATE model_run SET created_at = '2026-09-25T22:30:00Z' WHERE id = $1`, [runId]);
		const finish = async () => {
			const res = await owner.call('POST', `/projects/${projectId}/reports`, { email: true });
			expect(res.status).toBe(202);
			const [{ id }] = await asOwner('SELECT id FROM report WHERE job_id = $1', [res.body.jobId]);
			await withUser(owner.id, async (db) => finishReport(db, (await loadReport(db, projectId, id))!, { pages: 3, bytes: 100 }));
			return (await lastMailTo(owner.email))!.text;
		};
		expect(await finish()).toContain('for the run of 26 Sep 2026 (3 pages)');
		expect((await owner.call('PATCH', `/projects/${projectId}`, { timeZone: 'UTC' })).status).toBe(200);
		expect(await finish()).toContain('for the run of 25 Sep 2026 (3 pages)');
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});
});

describe('farmers (019_farmer_role) never get the catchment report', () => {
	it('a farmer can’t queue one, read one, issue a render token, or be a recipient; a viewer can (positive control)', async () => {
		const owner = await signUp('FarmRepOwner');
		const farmer = await signUp('FarmRepFarmer');
		const viewer = await signUp('FarmRepViewer');
		const { projectId, runId, farmId } = await withRun(owner);
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmId] })).status).toBe(201);
		await member(owner, projectId, viewer, 'viewer');
		const { jobId } = (await owner.call('POST', `/projects/${projectId}/reports`, {})).body;

		expect((await farmer.call('POST', `/projects/${projectId}/reports`, {})).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${projectId}/reports/${jobId}`)).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${projectId}/report-schedules`)).status).toBe(403);
		expect((await viewer.call('GET', `/projects/${projectId}/reports/${jobId}`)).status).toBe(200);
		await expect(withUser(farmer.id, (db) => issueRenderToken(db, projectId, runId))).rejects.toMatchObject({ code: '42501' });
		expect((await withUser(farmer.id, (db) => db.query('SELECT id FROM report WHERE project_id = $1', [projectId]))).rows).toEqual([]);
		await expect(withUser(farmer.id, (db) => db.query(`INSERT INTO job (project_id, kind) VALUES ($1, 'report_render')`, [projectId]))).rejects.toMatchObject({
			code: '42501'
		});

		// Emailing it, or scheduling it, to a farmer is refused; to the viewer it isn't.
		expect((await owner.call('POST', `/projects/${projectId}/reports`, { email: [farmer.id] })).status).toBe(400);
		expect((await owner.call('POST', `/projects/${projectId}/report-schedules`, { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [farmer.id] })).status).toBe(400);
		const ok = await owner.call('POST', `/projects/${projectId}/report-schedules`, { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [viewer.id] });
		expect(ok.status).toBe(201);
		await expect(
			withUser(owner.id, (db) => db.query('INSERT INTO report_schedule_recipient (schedule_id, user_id) VALUES ($1, $2)', [ok.body.schedule.id, farmer.id]))
		).rejects.toMatchObject({ code: '23514' });
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
		await asOwner('DELETE FROM report_schedule WHERE project_id = $1', [projectId]);
	});
});

describe('report RLS', () => {
	it('viewers read; only the requester records an outcome; nobody rewrites what a report is of', async () => {
		const owner = await signUp('RlsRepOwner');
		const viewer = await signUp('RlsRepViewer');
		const stranger = await signUp('RlsRepStranger');
		const { projectId } = await withRun(owner);
		await member(owner, projectId, viewer, 'viewer');
		const { jobId } = (await viewer.call('POST', `/projects/${projectId}/reports`, {})).body;
		const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [jobId]);

		// Positive control, then the stranger.
		expect((await withUser(owner.id, (db) => db.query('SELECT id FROM report WHERE id = $1', [r.id]))).rows).toHaveLength(1);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM report WHERE id = $1', [r.id]))).rows).toHaveLength(0);
		// The owner can't mark the viewer's report done; the viewer (its requester) can.
		expect((await withUser(owner.id, (db) => db.query(`UPDATE report SET status = 'done', finished_at = now() WHERE id = $1`, [r.id]))).rowCount).toBe(0);
		expect((await withUser(viewer.id, (db) => db.query(`UPDATE report SET status = 'done', finished_at = now() WHERE id = $1`, [r.id]))).rowCount).toBe(1);
		// Which project, run, requester and recipients are fixed.
		await expect(withUser(viewer.id, (db) => db.query('UPDATE report SET project_id = $2 WHERE id = $1', [r.id, projectId]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(viewer.id, (db) => db.query('UPDATE report SET email_to = $2 WHERE id = $1', [r.id, [stranger.id]]))).rejects.toMatchObject({ code: '42501' });
		// A stranger can't file a report (or its job) against the project.
		await expect(withUser(stranger.id, (db) => db.query(`INSERT INTO job (project_id, kind) VALUES ($1, 'report_render')`, [projectId]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(stranger.id, (db) => db.query('INSERT INTO report (project_id) VALUES ($1)', [projectId]))).rejects.toMatchObject({ code: '42501' });
		// The job insert policy widened for report renders only: a viewer still can't queue a re-run.
		await expect(withUser(viewer.id, (db) => db.query(`INSERT INTO job (project_id, kind) VALUES ($1, 'rerun')`, [projectId]))).rejects.toMatchObject({ code: '42501' });
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});
});

describe('report schedules', () => {
	const weekly = (recipients: string[]) => ({ frequency: 'weekly', weekday: 1, hour: 7, timezone: 'Africa/Johannesburg', recipients });

	it('editors write, viewers read, strangers see nothing; recipients must be members', async () => {
		const owner = await signUp('SchOwner');
		const editor = await signUp('SchEditor');
		const viewer = await signUp('SchViewer');
		const stranger = await signUp('SchStranger');
		const { projectId } = await withRun(owner);
		await member(owner, projectId, editor, 'editor');
		await member(owner, projectId, viewer, 'viewer');

		const created = await editor.call('POST', `/projects/${projectId}/report-schedules`, weekly([viewer.id, owner.id]));
		expect(created.status).toBe(201);
		const s = created.body.schedule;
		expect(s).toMatchObject({ frequency: 'weekly', weekday: 1, monthDay: null, hour: 7, timezone: 'Africa/Johannesburg', enabled: true, actingUser: 'SchEditor', lastError: null });
		expect(s.recipients.map((r: { userId: string }) => r.userId).sort()).toEqual([viewer.id, owner.id].sort());
		// Next Monday 07:00 SAST = 05:00 UTC, after now.
		expect(new Date(s.nextAt).getUTCDay()).toBe(1);
		expect(new Date(s.nextAt).getUTCHours()).toBe(5);
		expect(new Date(s.nextAt).getTime()).toBeGreaterThan(Date.now());

		expect((await viewer.call('GET', `/projects/${projectId}/report-schedules`)).body.schedules).toHaveLength(1);
		expect((await stranger.call('GET', `/projects/${projectId}/report-schedules`)).status).toBe(404);
		expect((await viewer.call('POST', `/projects/${projectId}/report-schedules`, weekly([viewer.id]))).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${projectId}/report-schedules/${s.id}`, { hour: 8 })).status).toBe(403);
		expect((await viewer.call('DELETE', `/projects/${projectId}/report-schedules/${s.id}`)).status).toBe(403);

		const bad = await editor.call('POST', `/projects/${projectId}/report-schedules`, weekly([stranger.id]));
		expect(bad.status).toBe(400);
		expect(bad.body.error).toBe('every recipient must be a member of the project who can read its report (a viewer or above)');
		expect((await editor.call('POST', `/projects/${projectId}/report-schedules`, { ...weekly([owner.id]), timezone: 'Mars/Olympus' })).status).toBe(400);
		expect((await editor.call('POST', `/projects/${projectId}/report-schedules`, { ...weekly([owner.id]), weekday: null })).status).toBe(400);
		expect((await editor.call('POST', `/projects/${projectId}/report-schedules`, { frequency: 'monthly', monthDay: 29, hour: 7, timezone: 'UTC', recipients: [owner.id] })).status).toBe(400);

		// The database refuses a non-member recipient too (a direct insert).
		await expect(
			withUser(editor.id, (db) => db.query('INSERT INTO report_schedule_recipient (schedule_id, user_id) VALUES ($1, $2)', [s.id, stranger.id]))
		).rejects.toMatchObject({ code: '23514' });
		// RLS: a viewer can't write rows directly either; the editor can (positive control).
		await expect(
			withUser(viewer.id, (db) => db.query(`INSERT INTO report_schedule (project_id, frequency, weekday, hour) VALUES ($1, 'weekly', 1, 7)`, [projectId]))
		).rejects.toMatchObject({ code: '42501' });
		expect((await withUser(viewer.id, (db) => db.query('UPDATE report_schedule SET hour = 9 WHERE id = $1', [s.id]))).rowCount).toBe(0);
		expect((await withUser(viewer.id, (db) => db.query('DELETE FROM report_schedule_recipient WHERE schedule_id = $1', [s.id]))).rowCount).toBe(0);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM report_schedule WHERE id = $1', [s.id]))).rows).toHaveLength(0);

		// An owner changes it to monthly and becomes its acting user.
		const patched = await owner.call('PATCH', `/projects/${projectId}/report-schedules/${s.id}`, { frequency: 'monthly', monthDay: 1, recipients: [editor.id] });
		expect(patched.status).toBe(200);
		expect(patched.body.schedule).toMatchObject({ frequency: 'monthly', weekday: null, monthDay: 1, actingUser: 'SchOwner' });
		expect(patched.body.schedule.recipients.map((r: { userId: string }) => r.userId)).toEqual([editor.id]);
		expect((await editor.call('DELETE', `/projects/${projectId}/report-schedules/${s.id}`)).status).toBe(204);
		expect((await editor.call('DELETE', `/projects/${projectId}/report-schedules/${s.id}`)).status).toBe(404);
	});

	it('the tick queues a due schedule once, as its acting user, emailed to its recipients', async () => {
		const owner = await signUp('TickOwner');
		const viewer = await signUp('TickViewer');
		const { projectId, runId } = await withRun(owner);
		await member(owner, projectId, viewer, 'viewer');
		const s = (await owner.call('POST', `/projects/${projectId}/report-schedules`, weekly([viewer.id]))).body.schedule;
		// Not due: saved just now, and its latest Monday 07:00 was before that.
		expect(await scheduleDueReports()).toMatchObject({ queued: 0 });
		// Saved three weeks ago, sent never: the latest Monday is due, once.
		await asOwner(`UPDATE report_schedule SET anchor_at = now() - interval '21 days' WHERE id = $1`, [s.id]);
		const first = await scheduleDueReports();
		expect(first.queued).toBeGreaterThanOrEqual(1);
		const reports = await asOwner('SELECT r.run_id, r.email_to, r.schedule_id, r.requested_by, j.dedupe_key FROM report r JOIN job j ON j.id = r.job_id WHERE r.project_id = $1', [projectId]);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ run_id: runId, email_to: [viewer.id], schedule_id: s.id, requested_by: owner.id });
		expect(reports[0].dedupe_key).toMatch(new RegExp(`^report_schedule:${s.id}:\\d{4}-\\d{2}-\\d{2}T05:00:00.000Z$`));
		await scheduleDueReports();
		expect(await asOwner('SELECT id FROM report WHERE project_id = $1', [projectId])).toHaveLength(1);
		const listed = (await viewer.call('GET', `/projects/${projectId}/report-schedules`)).body.schedules[0];
		expect(listed.lastSentFor).not.toBeNull();
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
		await asOwner('DELETE FROM report_schedule WHERE project_id = $1', [projectId]);
	});

	it('a due time with no runs, or whose editor lost the role, queues nothing and says why', async () => {
		const owner = await signUp('SkipOwner');
		const editor = await signUp('SkipEditor');
		const empty = await project(owner, 'Empty');
		const s1 = (await owner.call('POST', `/projects/${empty}/report-schedules`, weekly([owner.id]))).body.schedule;
		const { projectId } = await withRun(owner);
		await member(owner, projectId, editor, 'editor');
		const s2 = (await editor.call('POST', `/projects/${projectId}/report-schedules`, weekly([owner.id]))).body.schedule;
		expect((await owner.call('PATCH', `/projects/${projectId}/members/${editor.id}`, { role: 'viewer' })).status).toBe(200);
		await asOwner(`UPDATE report_schedule SET anchor_at = now() - interval '21 days' WHERE id = ANY($1)`, [[s1.id, s2.id]]);

		const r = await scheduleDueReports();
		expect(r.skipped).toBeGreaterThanOrEqual(2);
		const rows = await asOwner('SELECT id, last_error, last_fired_for IS NOT NULL AS claimed FROM report_schedule WHERE id = ANY($1) ORDER BY id', [[s1.id, s2.id]]);
		expect(Object.fromEntries(rows.map((x) => [x.id, x.last_error]))).toEqual({ [s1.id]: SCHEDULE_NO_RUNS, [s2.id]: SCHEDULE_NO_ACCESS });
		expect(rows.every((x) => x.claimed)).toBe(true);
		expect(await asOwner('SELECT id FROM report WHERE project_id = ANY($1)', [[empty, projectId]])).toEqual([]);
		await asOwner('DELETE FROM report_schedule WHERE id = ANY($1)', [[s1.id, s2.id]]);
	});
});
