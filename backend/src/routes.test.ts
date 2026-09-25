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
	'POST /auth/invite-info'
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
		'POST /auth/invite-info'
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
