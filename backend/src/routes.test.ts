// Every route must require a session unless it is deliberately public. A new
// route that forgets `requireUser` fails here instead of shipping open.
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

/**
 * Public by design. The email flows are public because the emailed token is
 * the credential (the link may be opened signed out, on another device).
 * Each is exercised without credentials below and, end to end, in
 * auth/*.db.test.ts and invites/invites.db.test.ts.
 */
const PUBLIC = new Set([
	'GET /health',
	'POST /auth/register',
	'POST /auth/login',
	'POST /auth/logout',
	'POST /auth/forgot-password',
	'POST /auth/reset-password',
	'POST /auth/verify-email',
	'POST /auth/invite-info',
	// The headless report renderer's sign-in (WP-2.15 Phase B): the single-use
	// render token is the credential, and the session it buys reads one
	// project and run only (reports/reports.db.test.ts).
	'POST /auth/render-session',
	// Read-only share links (WP-2.3 phase 2): the link's token is the
	// credential, and it reads only the current publication's catchment view
	// and allowlisted catchment series, through SECURITY DEFINER functions
	// (share/share.db.test.ts).
	'POST /share/view',
	'POST /share/series'
]);

const app = createApp();
const routes = [
	...new Set(
		app.routes
			.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS')
			.map((r) => `${r.method} ${r.path}`)
	)
];

describe('route auth inventory', () => {
	it('finds the API routes', () => {
		expect(routes.length).toBeGreaterThan(20);
	});

	// The .xlsx workbook's per-node fetch (WP-1.28): auth-gated like every project read.
	it('inventories the bulk run-series route as auth-gated', () => {
		expect(routes).toContain('GET /projects/:id/runs/:runId/series/bulk');
		expect(PUBLIC.has('GET /projects/:id/runs/:runId/series/bulk')).toBe(false);
	});

	// The import report kept with a project (017_project_import): auth-gated like every project read.
	it('inventories the import-report route as auth-gated', () => {
		expect(routes).toContain('GET /projects/:id/import-report');
		expect(PUBLIC.has('GET /projects/:id/import-report')).toBe(false);
	});

	// The data feeds (WP-2.10): auth-gated like every project route.
	it('inventories the feed routes as auth-gated', () => {
		const feeds = ['GET /projects/:id/feeds', 'POST /projects/:id/feeds', 'PATCH /projects/:id/feeds/:feedId', 'DELETE /projects/:id/feeds/:feedId', 'POST /projects/:id/feeds/:feedId/run-now'];
		for (const r of feeds) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Scenarios (WP-3.2, 024_scenarios): auth-gated like every project route (and farmer-403, farms.db.test.ts).
	it('inventories the scenario routes as auth-gated', () => {
		const scenarios = [
			'GET /projects/:id/scenarios',
			'POST /projects/:id/scenarios',
			'GET /projects/:id/scenarios/:sid',
			'PATCH /projects/:id/scenarios/:sid',
			'DELETE /projects/:id/scenarios/:sid',
			'POST /projects/:id/scenarios/:sid/runs',
			'POST /projects/:id/scenarios/:sid/rebase'
		];
		for (const r of scenarios) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Server-side PDF reports and their schedules (WP-2.15 Phase B): auth-gated like every project route.
	it('inventories the report routes as auth-gated, and the render-session exchange as public', () => {
		const reports = [
			'POST /projects/:id/reports',
			'GET /projects/:id/reports/:jobId',
			'GET /projects/:id/report-schedules',
			'POST /projects/:id/report-schedules',
			'PATCH /projects/:id/report-schedules/:scheduleId',
			'DELETE /projects/:id/report-schedules/:scheduleId'
		];
		for (const r of reports) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
		expect(routes).toContain('POST /auth/render-session');
	});

	// Publication (WP-2.3) and the farmer's farm view (WP-2.6): auth-gated like every project route.
	it('inventories the publication and farm-view routes as auth-gated', () => {
		const added = [
			'GET /projects/:id/publication',
			'POST /projects/:id/publication',
			'PATCH /projects/:id/publication/:pubId',
			'GET /projects/:id/farm',
			'GET /projects/:id/farm/:nodeId',
			'GET /projects/:id/farm/:nodeId/export.csv',
			'GET /projects/:id/farm/:nodeId/access'
		];
		for (const r of added) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// The change history (WP-2.4): auth-gated like every project route.
	it('inventories the history routes as auth-gated', () => {
		const history = [
			'GET /projects/:id/history',
			'GET /projects/:id/history/revisions/:revId',
			'POST /projects/:id/history/revisions/:revId/restore',
			'GET /projects/:id/runs/:runId/changes-since',
			'POST /projects/:id/runs/:runId/restore-inputs',
			'GET /projects/:id/series/:seriesId/revisions',
			'POST /projects/:id/series/:seriesId/revisions/:revId/restore'
		];
		for (const r of history) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Share links (WP-2.3 phase 2): the owner's routes are auth-gated, the two reads are public.
	it('inventories the share-link routes as auth-gated, and the share reads as public', () => {
		for (const r of ['GET /projects/:id/share-links', 'POST /projects/:id/share-links', 'DELETE /projects/:id/share-links/:linkId']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
		expect(routes).toContain('POST /share/view');
		expect(routes).toContain('POST /share/series');
	});

	it.each(routes.filter((r) => !PUBLIC.has(r)))('%s rejects anonymous requests with 401', async (route) => {
		const [method, path] = route.split(' ') as [string, string];
		const url = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
		const res = await app.request(url, {
			method,
			headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: method === 'GET' || method === 'HEAD' ? undefined : '{}'
		});
		expect(res.status).toBe(401);
	});

	// Without a database: an invalid body is rejected by validation (400), which
	// proves the route answers anonymous callers instead of demanding a session.
	it.each([
		'POST /auth/register',
		'POST /auth/login',
		'POST /auth/forgot-password',
		'POST /auth/reset-password',
		'POST /auth/verify-email',
		'POST /auth/invite-info',
		'POST /auth/render-session',
		'POST /share/view',
		'POST /share/series'
	])('%s answers anonymous requests (400 on an empty body, not 401)', async (route) => {
		const path = route.split(' ')[1]!;
		const res = await app.request(path, {
			method: 'POST',
			headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: '{}'
		});
		expect(res.status).toBe(400);
	});

	it.each(['POST /auth/register', 'POST /auth/login', 'POST /auth/forgot-password'])(
		'%s answers a body that is not JSON with 400, not 500',
		async (route) => {
			const res = await app.request(route.split(' ')[1]!, {
				method: 'POST',
				headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
				body: '{"email":'
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid JSON' });
		}
	);

	it('includes POST /projects/import, which carries its own body cap behind the session check', async () => {
		expect(routes).toContain('POST /projects/import');
		// Signed out, even an oversized body is a 401: the session is checked before the body is read.
		const res = await app.request('/projects/import', {
			method: 'POST',
			headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: 'x'.repeat(6 * 1024 * 1024)
		});
		expect(res.status).toBe(401);
	});

	it('keeps the general 4 MB body cap on every other route', async () => {
		const res = await app.request('/auth/login', {
			method: 'POST',
			headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(4 * 1024 * 1024) })
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: 'request too large' });
	});

	it('logout and health answer anonymous requests', async () => {
		expect((await app.request('/health')).status).toBe(200);
		const res = await app.request('/auth/logout', { method: 'POST', headers: { origin: 'http://localhost:7777' } });
		expect(res.status).toBe(204);
	});

	it('every allowlisted public route exists', () => {
		for (const r of PUBLIC) expect(routes).toContain(r);
	});
});
