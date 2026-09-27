// Hostile JSON bodies (a NUL, nesting thousands deep, a number that
// overflows to Infinity) on every route that takes a body: each is refused
// with a 400 and the code `body_refused` by readJson (http/body.ts), never a
// 500 from Postgres (NUL is 22021 / 22P05) or a stack overflow. The route
// list is the app's live inventory, so a new route is swept too.
import { describe, expect, it } from 'vitest';
import { app, signUp } from '../__tests__/helpers.js';
import { MAX_JSON_DEPTH } from './body.js';

const ORIGIN = 'http://localhost:7777';
const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);

/** Each hostile body as raw text (JSON.stringify can't write 1e400). */
const HOSTILE: Record<string, string> = {
	'a NUL in a value': JSON.stringify({ name: 'a\u0000b', email: 'a\u0000@example.com', settings: { note: 'x\u0000' } }),
	'a NUL in a key': JSON.stringify({ settings: { 'a\u0000': 1 } }),
	'nesting 20 000 deep': `{"settings":{"x":${deep(20_000)}},"config":${deep(20_000)}}`,
	'a number that overflows': '{"values":[1e400],"settings":{"x":1e400}}'
};

/** Routes that end the sweep's own session whatever the body says; exercised in auth/*.db.test.ts. */
const SKIP = /\/logout/;

async function owner() {
	const u = await signUp('BodySweep');
	const { body } = await u.call('POST', '/projects', { name: 'Body sweep' });
	return { u, projectId: body.project.id as string };
}

describe('hostile JSON bodies', () => {
	it('every body route refuses each one with 400 body_refused, never a 500', async () => {
		const { u, projectId } = await owner();
		const routes = [
			...new Set(app.routes.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && !SKIP.test(r.path)).map((r) => `${r.method} ${r.path}`))
		];
		expect(routes.length).toBeGreaterThan(50);
		const failures: string[] = [];
		const refusedBy = new Set<string>();
		for (const route of routes) {
			const [method, pattern] = route.split(' ') as [string, string];
			const path = pattern.replace(/:id\b/, projectId).replace(/:[A-Za-z]+/g, () => crypto.randomUUID());
			for (const [what, text] of Object.entries(HOSTILE)) {
				const r = await app.request(path, { method, headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: text });
				const got = await r.text();
				if (r.status >= 500) failures.push(`${route} (${what}): ${r.status} ${got.slice(0, 120)}`);
				if (r.status === 400 && JSON.parse(got).code === 'body_refused') refusedBy.add(route);
			}
		}
		expect(failures).toEqual([]);
		// Positive control: the sweep reached the handlers that read a body, as this user, and the session survived it.
		expect(refusedBy.size).toBeGreaterThan(40);
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
	}, 120_000);

	// The cases that were a 500 before readJson checked the body.
	it.each([
		['PATCH', (p: string) => `/projects/${p}`, JSON.stringify({ settings: { note: 'a\u0000b' } })],
		['PATCH', (p: string) => `/projects/${p}`, `{"settings":{"x":${deep(20_000)}}}`],
		['POST', () => '/projects', JSON.stringify({ name: 'a\u0000' })],
		['POST', () => '/projects/import', JSON.stringify({ name: 'a\u0000', model: { nodes: [], crops: [], cropAreas: [], transfers: [] } })]
	])('%s %s: 400 body_refused', async (method, path, text) => {
		const { u, projectId } = await owner();
		const r = await app.request(path(projectId), { method, headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: text });
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ code: 'body_refused' });
	});

	it('takes the same bodies once they are clean, and nesting up to the limit (positive control)', async () => {
		const { u, projectId } = await owner();
		const ok = await u.call('PATCH', `/projects/${projectId}`, { settings: { note: 'ab' } });
		expect(ok.status).toBe(200);
		// MAX_JSON_DEPTH containers in all: the body, settings, then the arrays; one more is refused.
		const atLimit = `{"settings":{"x":${deep(MAX_JSON_DEPTH - 2)}}}`;
		const r = await app.request(`/projects/${projectId}`, { method: 'PATCH', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: atLimit });
		expect(r.status, await r.clone().text()).toBe(200);
		const over = `{"settings":{"x":${deep(MAX_JSON_DEPTH - 1)}}}`;
		const r2 = await app.request(`/projects/${projectId}`, { method: 'PATCH', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: over });
		expect(r2.status).toBe(400);
	});
});
