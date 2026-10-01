// The API's streaming Lambda adapter (http/lambdaStream.ts, WP-1.29a): every
// route goes through it once the Function URL is in RESPONSE_STREAM mode, so
// it is checked with the real app (the CloudFront shared secret, the error
// JSON, the sign-out's empty body and cookie) as well as with a CSV download
// over Lambda's 6 MB buffered limit, and against the Node server, which must
// stream the same body the same way (docs/architecture.md § Request lifecycle).
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { invokeStreamed, urlEvent } from '../__tests__/lambdaRuntime.js';
import { createApp } from '../app.js';
import { BOM, EOL } from '../export/csv.js';
import { csvDownload, csvTooLarge } from '../export/download.js';
import { handleError } from './errors.js';
import { functionUrlRequest, streamingHandler } from './lambdaStream.js';

afterEach(() => vi.unstubAllEnvs());

const ORIGIN = 'http://localhost:7777';
const SECRET = 'a-long-test-secret-value-for-the-edge';

/** ~8.4 MB of CSV: past the 6 MB a buffered Lambda response stops at. */
const BIG_ROWS = 120_000;
const bigLines = () => (function* () {
	yield 'date,a,b,c,d';
	for (let i = 0; i < BIG_ROWS; i++) yield `2000-01-01,${i}.123456789,${i * 2}.987654321,${i * 3}.5,${-i}.25`;
})();
const bigBody = () => BOM + [...bigLines()].map((l) => l + EOL).join('');

/** A small app with the shapes the adapter has to carry. */
function testApp() {
	let walks = 0;
	return new Hono()
		.get('/cookies', (c) => {
			setCookie(c, 'a', '1', { path: '/', httpOnly: true });
			setCookie(c, 'b', '2', { path: '/', sameSite: 'Lax' });
			return c.json({ ok: true });
		})
		.post('/echo', async (c) => c.json({ cookie: getCookie(c, 'wm_session') ?? null, q: c.req.query('q') ?? null, body: await c.req.json() }))
		.get('/empty', (c) => c.body(null, 204))
		.get('/empty-string', (c) => c.text(''))
		.get('/big.csv', (c) => csvDownload(c, bigLines, 'big.csv', csvTooLarge('narrow it')))
		.get('/capped.csv', (c) => csvDownload(c, bigLines, 'big.csv', csvTooLarge('narrow it'), 1024 * 1024))
		// A body that comes out shorter than it measured: a bug that must fail the download, not end it.
		.get('/broken.csv', (c) => csvDownload(c, () => (walks++ % 2 === 0 ? bigLines() : ['date,a', '2000-01-01,1']), 'broken.csv', csvTooLarge('narrow it')))
		.onError(handleError);
}

describe('the handler and the Function URL stream together', () => {
	it('lambda.ts exports the streaming handler, and infra/lambda.tf puts the API’s URL in RESPONSE_STREAM mode', () => {
		// Either alone breaks every request (docs/deployment.md § Response streaming).
		const entry = readFileSync(new URL('../lambda.ts', import.meta.url), 'utf8');
		expect(entry).toMatch(/^export const handler = streamingHandler\(createApp\(\)\);$/m);
		expect(entry).not.toMatch(/from 'hono\/aws-lambda'/);
		const tf = readFileSync(new URL('../../../infra/lambda.tf', import.meta.url), 'utf8');
		const url = /resource "aws_lambda_function_url" "backend" \{[\s\S]*?\n\}/.exec(tf)?.[0] ?? '';
		expect(url).toMatch(/^\s*invoke_mode\s*=\s*"RESPONSE_STREAM"$/m);
	});
});

describe('the streaming Lambda adapter', () => {
	it('refuses to start outside the Lambda runtime (no awslambda global)', () => {
		expect(() => streamingHandler(testApp())).toThrow(/awslambda/);
	});

	it('builds the request from a Function URL event: path, query, method, cookies and body', async () => {
		const req = functionUrlRequest(
			urlEvent('/echo', { method: 'POST', query: 'q=a%20b', cookies: ['wm_session=s1', 'x=y'], headers: { 'content-type': 'application/json' }, body: '{"n":1}' })
		);
		expect(req.url).toBe('https://example.lambda-url.af-south-1.on.aws/echo?q=a%20b');
		expect(req.headers.get('cookie')).toBe('wm_session=s1; x=y');
		const res = await invokeStreamed(
			testApp(),
			urlEvent('/echo', { method: 'POST', query: 'q=a%20b', cookies: ['wm_session=s1'], headers: { 'content-type': 'application/json' }, body: '{"n":1}' })
		);
		expect(res.metadata?.statusCode).toBe(200);
		expect(JSON.parse(res.body.toString())).toEqual({ cookie: 's1', q: 'a b', body: { n: 1 } });
	});

	it('puts every Set-Cookie in the prelude’s cookies list, one entry each, and none in its headers', async () => {
		const res = await invokeStreamed(testApp(), urlEvent('/cookies'));
		expect(res.metadata?.cookies).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/; SameSite=Lax']);
		expect(Object.keys(res.metadata!.headers)).not.toContain('set-cookie');
		expect(res.metadata?.headers['content-type']).toMatch(/^application\/json/);
		expect(res.ended).toBe(true);
	});

	it('writes an empty body once and ends, so a body-less response does not hang the URL', async () => {
		const res = await invokeStreamed(testApp(), urlEvent('/empty'));
		expect(res.metadata?.statusCode).toBe(204);
		expect(res.body.length).toBe(0);
		expect(res.writes).toBeGreaterThanOrEqual(1);
		expect(res.ended).toBe(true);
	});

	it('writes an empty-string body too, which is a non-null body with no bytes', async () => {
		const res = await invokeStreamed(testApp(), urlEvent('/empty-string'));
		expect(res.metadata?.statusCode).toBe(200);
		expect(res.body.length).toBe(0);
		expect(res.writes).toBeGreaterThanOrEqual(1);
		expect(res.ended).toBe(true);
	});

	it('streams a CSV past Lambda’s 6 MB buffered limit in pieces, byte for byte', async () => {
		const res = await invokeStreamed(testApp(), urlEvent('/big.csv'));
		expect(res.error).toBeNull();
		expect(res.metadata?.statusCode).toBe(200);
		expect(res.metadata?.headers['content-type']).toBe('text/csv; charset=utf-8');
		expect(res.metadata?.headers['content-disposition']).toBe('attachment; filename="big.csv"');
		expect(res.body.length).toBeGreaterThan(6 * 1024 * 1024);
		expect(res.writes).toBeGreaterThan(10);
		expect(res.body.toString('utf8')).toBe(bigBody());
		expect(res.ended).toBe(true);
	});

	it('answers 413 JSON before any CSV byte when the body passes the cap', async () => {
		const res = await invokeStreamed(testApp(), urlEvent('/capped.csv'));
		expect(res.metadata?.statusCode).toBe(413);
		expect(JSON.parse(res.body.toString())).toEqual({ error: 'export larger than 50 MB — narrow it' });
	});

	it('cuts the response off and fails the invocation when the body comes out unlike the one measured', async () => {
		const res = await invokeStreamed(testApp(), urlEvent('/broken.csv'));
		expect(res.metadata?.statusCode).toBe(200); // the prelude had gone
		expect(res.error).toBeInstanceOf(Error);
		expect(String(res.error)).toMatch(/measured/);
		expect(res.ended).toBe(false); // never a short file that looks complete
	});
});

describe('the real app through the streaming adapter', () => {
	it('still refuses a request without the CloudFront shared secret, and passes one with it (positive control)', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', SECRET);
		const app = createApp();
		const denied = await invokeStreamed(app, urlEvent('/health'));
		expect(denied.metadata?.statusCode).toBe(403);
		expect(JSON.parse(denied.body.toString())).toEqual({ error: 'forbidden' });
		const wrong = await invokeStreamed(app, urlEvent('/health', { headers: { 'x-cloudfront-shared-secret': `${SECRET.slice(0, -1)}X` } }));
		expect(wrong.metadata?.statusCode).toBe(403);
		const ok = await invokeStreamed(app, urlEvent('/health', { headers: { 'x-cloudfront-shared-secret': SECRET } }));
		expect(ok.metadata?.statusCode).toBe(200);
		expect(JSON.parse(ok.body.toString())).toEqual({ ok: true });
	});

	it('sends the app’s error JSON with its status (401 signed out, 404 unknown route, 400 escaped path)', async () => {
		const app = createApp();
		const signedOut = await invokeStreamed(app, urlEvent('/auth/me'));
		expect(signedOut.metadata?.statusCode).toBe(401);
		expect(JSON.parse(signedOut.body.toString())).toHaveProperty('error');
		const missing = await invokeStreamed(app, urlEvent('/no-such-route'));
		expect(missing.metadata?.statusCode).toBe(404);
		expect(JSON.parse(missing.body.toString())).toEqual({ error: 'not found' });
		expect((await invokeStreamed(app, urlEvent('/%61uth/me'))).metadata?.statusCode).toBe(400);
	});

	it('signs out with an empty 204 whose cookie clearing reaches the prelude', async () => {
		const res = await invokeStreamed(createApp(), urlEvent('/auth/logout', { method: 'POST', headers: { origin: ORIGIN } }));
		expect(res.metadata?.statusCode).toBe(204);
		expect(res.metadata?.cookies.some((c) => /^wm_session=;/.test(c) && /Max-Age=0/i.test(c))).toBe(true);
		expect(res.body.length).toBe(0);
		expect(res.ended).toBe(true);
	});
});

describe('the same download through the Node server (local dev)', () => {
	let server: ReturnType<typeof serve>;
	let base: string;
	beforeAll(async () => {
		server = serve({ fetch: testApp().fetch, port: 0 });
		await new Promise<void>((resolve) => server.once('listening', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it('streams it chunked, byte for byte', async () => {
		const res = await fetch(`${base}/big.csv`);
		expect(res.status).toBe(200);
		expect(res.headers.get('transfer-encoding')).toBe('chunked');
		const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
		expect(text).toBe(bigBody());
	});

	it('fails the download instead of ending a body unlike the one measured', async () => {
		const res = await fetch(`${base}/broken.csv`);
		expect(res.status).toBe(200);
		await expect(res.arrayBuffer()).rejects.toThrow();
	});
});
