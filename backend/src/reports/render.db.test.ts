// The report_render job handler against real MinIO and the local Playwright
// Chromium (REPORT_RENDERER=inline, STORAGE=local): queue a PDF, run the
// handler, and the PDF is in the bucket, the report is done with its page
// count, the download link serves it, and the requester's email carries the
// link. (The queue around the handler, claim / finish / retry, is
// jobs/jobs.db.test.ts; e2e runs the whole thing through the worker.)
//
// The site here is a stub page, not the SvelteKit report route (e2e renders
// the real one: e2e/tests/server-report.spec.ts). It makes the report's kind
// of requests with the render session (the session check, the run) plus one
// it must be refused (the project list), and only then sets
// data-report-ready, so the token exchange, the session's scope, the ready
// wait, page.pdf(), storage and mail are all real.
//
// Skipped ONLY when MinIO isn't running (`pnpm dev:s3:up`), and only
// locally: under CI a missing MinIO FAILS the file (CI's db-test job starts
// MinIO and installs Chromium), so it can't pass by skipping. Chromium comes
// from `pnpm test:e2e:install`.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, lastMailTo, monthly, node, signUp } from '../__tests__/helpers.js';
import { createApp } from '../app.js';
import { withUser } from '../db/tx.js';
import { reportRenderHandler } from '../jobs/handlers/report-render.js';
import { enqueueJob } from '../jobs/queue.js';
import { resetStorageClient } from './storage.js';

const S3 = process.env.S3_ENDPOINT || 'http://127.0.0.1:9002';
const minioUp = await fetch(`${S3}/minio/health/live`, { signal: AbortSignal.timeout(1500) })
	.then((r) => r.ok)
	.catch(() => false);
if (!minioUp && process.env.CI) {
	throw new Error(`render.db.test.ts: MinIO is not reachable at ${S3} under CI; the job must start it (.github/workflows/ci.yml db-test)`);
}
if (!minioUp) console.warn(`render.db.test.ts skipped: MinIO is not running at ${S3} (pnpm dev:s3:up)`);

let api: ReturnType<typeof serve>;
let site: Server;
let apiUrl = '';
let siteUrl = '';
/** 'ok': the stub report; 'broken': the report page's own "no access" message. */
let mode: 'ok' | 'broken' = 'ok';

const stubPage = (apiBase: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stub report</title></head>
<body><main class="page report"><h1>Stub report</h1><p id="s">Preparing…</p>${'<p>Page filler.</p>'.repeat(40)}</main>
<script>
(async () => {
	const api = ${JSON.stringify(apiBase)};
	const p = location.pathname.split('/')[2];
	const q = new URLSearchParams(location.search);
	const r = q.get('run');
	const against = q.get('against');
	const get = (path) => fetch(api + path, { credentials: 'include' }).then((x) => x.status);
	const [me, run, list, cmp] = await Promise.all([
		get('/auth/me'),
		get('/projects/' + p + '/runs/' + r),
		get('/projects'),
		// An impact report's one extra read: the comparison with its baseline.
		against ? get('/compare/runs?' + new URLSearchParams({ a: against, b: p + ':' + r })) : 200
	]);
	const main = document.querySelector('main');
	document.getElementById('s').textContent = 'me ' + me + ', run ' + run + ', project list ' + list + ', compare ' + cmp;
	if (me === 200 && run === 200 && list === 403 && cmp === 200) main.setAttribute('data-report-ready', 'true');
	else { const a = document.createElement('div'); a.setAttribute('role', 'alert'); a.textContent = 'stub: ' + document.getElementById('s').textContent; main.prepend(a); }
})();
</script></body></html>`;

const brokenPage = `<!doctype html><html lang="en"><body><main class="page report">
<div class="alert alert-error" role="alert">This project doesn't exist or you don't have access to it.</div></main></body></html>`;

beforeAll(async () => {
	if (!minioUp) return;
	site = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(mode === 'broken' ? brokenPage : stubPage(apiUrl));
	});
	await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
	siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
	// The API the headless browser talks to: this checkout's app, allowing the stub site's origin.
	vi.stubEnv('ALLOWED_ORIGINS', siteUrl);
	const app = createApp();
	vi.unstubAllEnvs();
	await new Promise<void>((resolve) => {
		api = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
			apiUrl = `http://127.0.0.1:${info.port}`;
			resolve();
		});
	});
});

afterAll(async () => {
	await new Promise((r) => site?.close(r));
	await new Promise((r) => (api ? api.close(r) : r(undefined)));
	resetStorageClient();
});

async function projectWithRun(name: string) {
	const u = await signUp(name.split(' ')[0]);
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	await u.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] });
	await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } });
	await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: Array.from({ length: 30 }, () => 1) });
	expect((await u.call('POST', `/projects/${projectId}/runs`, {})).status).toBe(201);
	return { u, projectId };
}

/**
 * Queue a report as `u` whose job is NOT due (an hour out), so no other DB
 * test file's tick (they run alongside this one) can claim it, then run the
 * report_render handler on it directly, as the worker does: inside the
 * acting user's transaction.
 */
async function renderAs(u: { id: string }, projectId: string, email: boolean, againstRunId?: string) {
	const reportId = crypto.randomUUID();
	const jobId = await withUser(u.id, async (db) => {
		const { job } = await enqueueJob(db, { projectId, kind: 'report_render', payload: { reportId }, delaySeconds: 3600, maxAttempts: 3 });
		await db.query(
			`INSERT INTO report (id, project_id, run_id, job_id, email_to, impact, against_run_id)
			 SELECT $1, $2, id, $3, $4::uuid[], $5::uuid IS NOT NULL, $5 FROM model_run WHERE project_id = $2 ORDER BY created_at DESC LIMIT 1`,
			[reportId, projectId, job.id, email ? [u.id] : [], againstRunId ?? null]
		);
		return job.id;
	});
	const job = { id: jobId, projectId, kind: 'report_render' as const, actingUserId: u.id, leaseToken: crypto.randomUUID(), attempts: 1, maxAttempts: 3 };
	const started = Date.now();
	const outcome = await withUser(u.id, (db) => reportRenderHandler.run({ db, job, payload: { reportId }, progress: async () => true })).then(
		() => null,
		(err: Error & { retry?: boolean }) => err
	);
	return { jobId, reportId, ms: Date.now() - started, outcome };
}

function renderEnv() {
	vi.stubEnv('REPORT_RENDERER', 'inline');
	vi.stubEnv('RENDER_SITE_URL', siteUrl);
	vi.stubEnv('RENDER_API_URL', apiUrl);
	vi.stubEnv('STORAGE', 'local');
	vi.stubEnv('S3_ENDPOINT', S3);
	vi.stubEnv('REPORTS_BUCKET', 'water-reports-test');
	vi.stubEnv('REPORT_RENDER_TIMEOUT_MS', '60000');
	resetStorageClient();
}

describe.skipIf(!minioUp)('report_render with local Chromium and MinIO', () => {
	it('renders, stores, records and emails a PDF, in under 60 s', async () => {
		renderEnv();
		const { u, projectId } = await projectWithRun('Rendered catchment');
		const { jobId, ms, outcome } = await renderAs(u, projectId, true);
		console.log(`report render: ${ms} ms`);
		expect(outcome).toBeNull();
		expect(ms).toBeLessThan(60_000);

		const status = await u.call('GET', `/projects/${projectId}/reports/${jobId}`);
		expect(status.body.report).toMatchObject({ status: 'done', error: null, emailed: 1 });
		expect(status.body.report.pages).toBeGreaterThanOrEqual(2);
		const pdf = Buffer.from(await (await fetch(status.body.url)).arrayBuffer());
		expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
		expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length).toBe(status.body.report.pages);
		// The render token was used up.
		expect(await asOwner('SELECT id FROM render_token WHERE project_id = $1', [projectId])).toEqual([]);

		const mail = lastMailTo(u.email);
		expect(mail?.subject).toBe('Catchment report: Rendered catchment — Water Management');
		expect(mail?.text).toContain(`/projects/${projectId}/reports/${jobId}`);
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
		vi.unstubAllEnvs();
	}, 90_000);

	it('an impact report: the browser opens the report with its baseline and the session makes the one comparison (082)', async () => {
		renderEnv();
		const { u, projectId } = await projectWithRun('Impact catchment');
		const [{ id: baseline }] = await asOwner('SELECT id FROM model_run WHERE project_id = $1', [projectId]);
		expect((await u.call('POST', `/projects/${projectId}/runs`, {})).status).toBe(201);
		const { jobId, outcome } = await renderAs(u, projectId, true, baseline);
		// The stub sets data-report-ready only when GET /compare/runs (baseline, run) answered 200.
		expect(outcome).toBeNull();
		const status = await u.call('GET', `/projects/${projectId}/reports/${jobId}`);
		expect(status.body.report).toMatchObject({ status: 'done', impact: true, error: null });
		expect(lastMailTo(u.email)?.text).toContain('made a PDF of the impact report for the run');
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
		vi.unstubAllEnvs();
	}, 90_000);

	it('a report page that says "no access" fails with its message and no retry, and leaves no download link', async () => {
		renderEnv();
		mode = 'broken';
		try {
			const { u, projectId } = await projectWithRun('Broken catchment');
			const { jobId, outcome } = await renderAs(u, projectId, false);
			// A JobError that a retry can't fix: the worker records the job dead with this text.
			expect(outcome).toMatchObject({ message: "the report page did not load: This project doesn't exist or you don't have access to it.", retry: false });
			const status = await u.call('GET', `/projects/${projectId}/reports/${jobId}`);
			// The handler's transaction rolled back: still waiting, and no download link.
			expect(status.body.report).toMatchObject({ status: 'queued' });
			expect(status.body.url).toBeUndefined();
			await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
		} finally {
			mode = 'ok';
			vi.unstubAllEnvs();
		}
	}, 90_000);
});
