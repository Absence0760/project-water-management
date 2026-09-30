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
	// "Send the link again" on the sign-in page (issue #57): the same 202 for any address.
	'POST /auth/resend-confirmation',
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
	'POST /share/series',
	// A link to one submitted or decided scenario (WP-3.15): the same token
	// model, read only through app_share_scenario's redacted projection; a
	// link opens only its own target (share/scenario-share.db.test.ts).
	'POST /share/scenario',
	// One-click unsubscribe from alert emails (WP-2.13): the token is the
	// credential, and it can only turn off the one subscription it names,
	// through app_alert_unsubscribe (alerts/alerts.db.test.ts). The only
	// route exempt from the CSRF check (app.ts): a mail client form-posts it.
	'POST /alerts/unsubscribe',
	// Verify an evidence pack (WP-3.14): the code is printed on the pack, not
	// a secret; app_verify_pack returns only a pack's printed fields, and
	// nothing for a draft (evidence/packs.db.test.ts).
	'GET /verify/:code'
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

	// Evidence packs (WP-3.14), their PDF (116_pack_render) included: auth-gated like every project route; only verify is public.
	it('inventories the evidence pack routes as auth-gated, and verify as public', () => {
		for (const r of [
			'POST /projects/:id/packs',
			'GET /projects/:id/packs',
			'GET /projects/:id/packs/:packId',
			'DELETE /projects/:id/packs/:packId',
			'GET /projects/:id/packs/:packId/signoffs',
			'POST /projects/:id/packs/:packId/signoffs',
			'POST /projects/:id/packs/:packId/issue',
			'POST /projects/:id/packs/:packId/withdraw',
			'GET /projects/:id/packs/:packId/pdf',
			'POST /projects/:id/packs/:packId/pdf'
		]) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
		expect(routes).toContain('GET /verify/:code');
		expect(PUBLIC.has('GET /verify/:code')).toBe(true);
	});

	// Reproduction (WP-3.1): auth-gated like every project route.
	it('inventories the reproduce route as auth-gated', () => {
		for (const r of ['GET /projects/:id/runs/:runId/reproduce']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// The account page (WP-1.9): renaming and changing the password need a session (auth/auth.db.test.ts),
	// and so does "download my data" (POPIA; auth/export.db.test.ts), and accepting new terms (auth/auth.db.test.ts).
	it('inventories the account routes as auth-gated', () => {
		for (const r of ['PATCH /auth/me', 'POST /auth/change-password', 'GET /auth/me/export', 'POST /auth/me/farm-notice', 'POST /auth/me/accept-terms']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// The data feeds (WP-2.10): auth-gated like every project route.
	it('inventories the feed routes as auth-gated', () => {
		const feeds = ['GET /projects/:id/feeds', 'POST /projects/:id/feeds', 'PATCH /projects/:id/feeds/:feedId', 'DELETE /projects/:id/feeds/:feedId', 'POST /projects/:id/feeds/:feedId/run-now'];
		for (const r of feeds) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Sign-offs (WP-3.13, 036_signoff): auth-gated like every project route.
	it('inventories the sign-off routes as auth-gated', () => {
		for (const r of ['GET /projects/:id/runs/:runId/signoffs', 'POST /projects/:id/runs/:runId/signoffs']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Scenarios (WP-3.2, 024_scenarios): auth-gated like every project route (and farmer-403, projects/role-ladder.db.test.ts).
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

	// Firm yield (WP-3.6, 040_yield): auth-gated like every project route.
	it('inventories the yield routes as auth-gated', () => {
		for (const r of ['POST /projects/:id/yield', 'GET /projects/:id/yield', 'GET /projects/:id/yield/jobs', 'POST /projects/:id/yield/:jobId/cancel']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Scenario sweeps (issue #53 R2, 062_scenario_sweeps): auth-gated like every project route.
	it('inventories the sweep routes as auth-gated', () => {
		for (const r of ['POST /projects/:id/sweeps', 'GET /projects/:id/sweeps', 'GET /projects/:id/sweeps/:sweepId']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Automated calibration run by the server (issue #153, 108_auto_calibration): auth-gated like every project route.
	it('inventories the automated calibration routes as auth-gated', () => {
		for (const r of [
			'POST /projects/:id/auto-calibrations',
			'GET /projects/:id/auto-calibrations',
			'GET /projects/:id/auto-calibrations/:cid',
			'POST /projects/:id/auto-calibrations/:cid/apply'
		]) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Seasonal outlooks (issue #53 R5, 063_seasonal_outlook): auth-gated like every project route.
	it('inventories the outlook routes as auth-gated', () => {
		for (const r of [
			'POST /projects/:id/outlooks',
			'GET /projects/:id/outlooks',
			'GET /projects/:id/outlooks/:outlookId',
			// Publishing one level to farmers (106, issue #53 R5).
			'POST /projects/:id/outlooks/:outlookId/publish',
			'GET /projects/:id/outlook-publication',
			'DELETE /projects/:id/outlook-publication'
		]) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Applications (WP-3.3, 045_contributor_scope): auth-gated like every project
	// route; which a contributor may call is projects/role-ladder.db.test.ts (BELOW_VIEWER).
	it('inventories the application routes as auth-gated', () => {
		const applications = [
			'GET /projects/:id/applications',
			'GET /projects/:id/scenarios/:sid/base',
			'POST /projects/:id/scenarios/:sid/submit',
			'POST /projects/:id/scenarios/:sid/withdraw',
			'POST /projects/:id/scenarios/:sid/reopen',
			'POST /projects/:id/scenarios/:sid/decide',
			'POST /projects/:id/scenarios/:sid/members',
			'DELETE /projects/:id/scenarios/:sid/members/:userId'
		];
		for (const r of applications) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Server-side PDF reports and their schedules (WP-2.15 Phase B): auth-gated like every project route.
	it('inventories the report routes as auth-gated, and the render-session exchange as public', () => {
		const reports = [
			'POST /projects/:id/reports',
			'GET /projects/:id/reports/:jobId',
			'GET /projects/:id/reports/:jobId/pdf',
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
			'GET /projects/:id/runs/:runId/publication',
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

	// Farmers and farmer invites (WP-2.1, WP-2.2): auth-gated like every project route (and farmer-403, projects/role-ladder.db.test.ts).
	it('inventories the farmer routes as auth-gated', () => {
		for (const r of ['GET /projects/:id/farmers', 'POST /projects/:id/farmers', 'POST /projects/:id/farmers/bulk', 'PUT /projects/:id/farmers/:userId']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// The team portfolio (WP-2.14): team members only (portfolio/portfolio.db.test.ts, a farmer gets 404).
	it('inventories the portfolio route as auth-gated', () => {
		expect(routes).toContain('GET /teams/:id/portfolio');
		expect(PUBLIC.has('GET /teams/:id/portfolio')).toBe(false);
		// The same figures for the project list (issue #17), for the signed-in user only.
		expect(routes).toContain('GET /projects/outcomes');
		expect(PUBLIC.has('GET /projects/outcomes')).toBe(false);
	});

	// The change history (WP-2.4): auth-gated like every project route.
	it('inventories the history routes as auth-gated', () => {
		const history = [
			'GET /projects/:id/history',
			'GET /projects/:id/history/fields',
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

	// Notes and comments (WP-2.7, 037_notes): auth-gated; the min role is farmer and RLS scopes (notes/notes.db.test.ts).
	it('inventories the note routes as auth-gated', () => {
		const notes = [
			'GET /projects/:id/notes',
			'GET /projects/:id/notes/counts',
			'POST /projects/:id/notes',
			'PATCH /projects/:id/notes/:noteId',
			'DELETE /projects/:id/notes/:noteId',
			'GET /projects/:id/notes/:noteId/revisions'
		];
		for (const r of notes) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
	});

	// Share links (WP-2.3 phase 2): the owner's routes are auth-gated, the two reads are public.
	// Alerts (WP-2.13): preferences and rules need a session; only the unsubscribe is public.
	it('inventories the alert routes as auth-gated, and the unsubscribe as public', () => {
		for (const r of ['GET /me/alerts', 'PUT /me/alerts/:projectId', 'POST /me/alerts/resume', 'GET /projects/:id/alert-rules', 'PUT /projects/:id/alert-rules', 'GET /projects/:id/alert-events']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
		expect(routes).toContain('POST /alerts/unsubscribe');
	});

	it('exempts only POST /alerts/unsubscribe from the CSRF check: a form post with no Origin reaches it, and is refused elsewhere', async () => {
		const form = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' };
		// No token: the route itself answers (400), not the CSRF check (403).
		expect((await app.request('/alerts/unsubscribe', form)).status).toBe(400);
		// A malformed token is refused without a database (404: not a live link).
		expect((await app.request('/alerts/unsubscribe?token=not-a-token', form)).status).toBe(404);
		// Any other route: the CSRF check refuses the same form post.
		expect((await app.request('/auth/login', form)).status).toBe(403);
		expect((await app.request('/share/view', form)).status).toBe(403);
	});

	it('inventories the share-link routes as auth-gated, and the share reads as public', () => {
		for (const r of ['GET /projects/:id/share-links', 'POST /projects/:id/share-links', 'DELETE /projects/:id/share-links/:linkId']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
		expect(routes).toContain('POST /share/view');
		expect(routes).toContain('POST /share/series');
		expect(routes).toContain('POST /share/scenario');
		expect(PUBLIC.has('POST /share/scenario')).toBe(true);
	});

	// API keys (WP-2.9): the owner's routes need a session; the ingest routes
	// need an API key instead (ingest/auth.ts), so they are neither public nor
	// session-gated. Each answers 401 without a key (the loop below), and a
	// malformed key is refused before any database work (this test runs without one).
	it('inventories the API-key routes as auth-gated, and the ingest routes as key-gated', async () => {
		for (const r of ['GET /projects/:id/api-keys', 'POST /projects/:id/api-keys', 'DELETE /projects/:id/api-keys/:keyId']) {
			expect(routes).toContain(r);
			expect(PUBLIC.has(r)).toBe(false);
		}
		const ingest = routes.filter((r) => r.split(' ')[1]!.startsWith('/ingest/'));
		expect(ingest.sort()).toEqual(['GET /ingest/v1/whoami', 'POST /ingest/v1/series/merge']);
		for (const r of ingest) {
			expect(PUBLIC.has(r)).toBe(false);
			const [method, path] = r.split(' ') as [string, string];
			for (const authorization of ['Bearer not-a-key', 'Bearer wm_0000000_short', `Basic wm_00000000_${'a'.repeat(43)}`]) {
				const res = await app.request(path, {
					method,
					headers: { authorization, 'content-type': 'application/json' },
					body: method === 'GET' ? undefined : '{}'
				});
				expect(res.status, `${r} with ${authorization}`).toBe(401);
				expect(await res.json()).toEqual({ error: 'invalid or missing API key' });
			}
		}
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
		'POST /auth/resend-confirmation',
		'POST /auth/invite-info',
		'POST /auth/render-session',
		'POST /share/view',
		'POST /share/series',
		'POST /alerts/unsubscribe'
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
