// The app refuses a percent-encoded path that would route somewhere the WAF
// didn't see it going (http/rawPath.ts, issue #126): `/%61uth/login` is
// `/auth/login` to Hono, but not to a WAF rule matching the raw path. Checked
// through the app and through both real runtimes (the Node server and the
// Lambda adapter), since a dot segment is only visible in what the runtime
// received: building a Request resolves `/x/%2e%2e/auth` to `/auth`.
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeStreamed, urlEvent } from '../__tests__/lambdaRuntime.js';
import { createApp } from '../app.js';

const app = createApp();

describe('an escaped path through the app', () => {
	it('refuses an escaped letter that would route to a real endpoint, which without the check answers normally', async () => {
		// Without the check each would reach its route: /health → 200, /auth/me → 401.
		for (const p of ['/%68ealth', '/h%65alth', '/%61uth/me', '/auth/%6De']) {
			const res = await app.request(p);
			expect(res.status, p).toBe(400);
			expect(await res.json()).toEqual({ error: 'bad request path' });
		}
		const login = await app.request('/%61uth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(login.status).toBe(400);
		expect(await login.json()).toEqual({ error: 'bad request path' });
	});

	it('refuses an escaped slash in a route parameter', async () => {
		expect((await app.request('/projects/a%2Fb')).status).toBe(400);
	});

	it('lets the same routes, and a parameter with a space, non-ASCII or a reserved character, through (positive control)', async () => {
		expect((await app.request('/health')).status).toBe(200);
		expect((await app.request('/auth/me')).status).toBe(401);
		for (const p of ['/projects/a%20b', '/projects/caf%C3%A9', '/projects/x%3Ay']) {
			expect((await app.request(p)).status, p).toBe(401); // reached requireUser
		}
	});

	it('checks the Lambda event’s rawPath and the Node request target, which still show dot segments', async () => {
		// The Request's own URL is clean in each case; only the raw path gives it away.
		expect((await app.request('/auth/me', {}, { event: { rawPath: '/projects/%2e%2e/auth/me' } })).status).toBe(400);
		expect((await app.request('/auth/me', {}, { event: { rawPath: '/projects/../auth/me' } })).status).toBe(400);
		expect((await app.request('/auth/me', {}, { incoming: { url: '/x/%2E%2E/auth/me' } })).status).toBe(400);
		// Positive control: the same raw paths without the trick.
		expect((await app.request('/auth/me', {}, { event: { rawPath: '/auth/me' } })).status).toBe(401);
		expect((await app.request('/auth/me', {}, { incoming: { url: '/auth/me?next=%2F' } })).status).toBe(401);
	});
});

describe('through the Node server', () => {
	let server: ReturnType<typeof serve>;
	let port: number;
	beforeAll(async () => {
		server = serve({ fetch: app.fetch, port: 0 });
		await new Promise<void>((resolve) => server.once('listening', resolve));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	// node:http sends the request target exactly as given (fetch would normalise it first).
	const status = (path: string) =>
		new Promise<number>((resolve, reject) => {
			const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on('error', reject);
			req.end();
		});

	it('refuses an encoded dot segment the server would otherwise resolve, and an escaped letter', async () => {
		expect(await status('/x/%2e%2e/health')).toBe(400);
		expect(await status('/x/../health')).toBe(400);
		expect(await status('/%68ealth')).toBe(400);
	});

	it('answers the plain path (positive control)', async () => {
		expect(await status('/health')).toBe(200);
	});
});

describe('through the Lambda adapter (a Function URL event, streamed as production runs it: http/lambdaStream.ts)', () => {
	const status = async (rawPath: string) => (await invokeStreamed(app, urlEvent(rawPath))).metadata?.statusCode;

	it('refuses an escaped letter and an encoded dot segment', async () => {
		expect(await status('/%61uth/me')).toBe(400);
		expect(await status('/projects/%2e%2e/health')).toBe(400);
	});

	it('answers the plain path (positive control)', async () => {
		expect(await status('/health')).toBe(200);
		expect(await status('/auth/me')).toBe(401);
	});
});
