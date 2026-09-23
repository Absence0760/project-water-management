// Every route must require a session unless it is deliberately public. A new
// route that forgets `requireUser` fails here instead of shipping open.
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

/** Public by design — each is exercised below without credentials. */
const PUBLIC = new Set(['GET /health', 'POST /auth/register', 'POST /auth/login', 'POST /auth/logout']);

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

	it('every allowlisted public route exists', () => {
		for (const r of PUBLIC) expect(routes).toContain(r);
	});
});
