// The edge controls in app.ts (docs/security.md § Infrastructure): the
// CloudFront shared secret, the CORS allowlist and the cross-origin write check.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRuntime } from './__tests__/lambdaRuntime.js';
import { createApp } from './app.js';

const ORIGIN = 'http://localhost:7777';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('CloudFront shared secret', () => {
	it('checks the header CloudFront sends on the API origin (infra/s3_cloudfront.tf)', () => {
		const tf = readFileSync(new URL('../../infra/s3_cloudfront.tf', import.meta.url), 'utf8');
		const header = /name\s*=\s*"(X-CloudFront-Shared-Secret)"\s*\n\s*value\s*=\s*random_password\.cloudfront_shared_secret\.result/.exec(tf)?.[1];
		expect(header).toBe('X-CloudFront-Shared-Secret');
		const app = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
		expect(app).toContain(`c.req.header('${header!.toLowerCase()}')`);
		expect(app).toContain('process.env.CLOUDFRONT_SHARED_SECRET');
	});

	it('refuses a request without the header, or with a wrong one, and passes the right one (positive control)', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', 'a-long-test-secret-value');
		const app = createApp();
		expect((await app.request('/health')).status).toBe(403);
		expect((await app.request('/health', { headers: { 'x-cloudfront-shared-secret': 'a-long-test-secret-valuX' } })).status).toBe(403);
		expect((await app.request('/health', { headers: { 'x-cloudfront-shared-secret': 'short' } })).status).toBe(403);
		expect((await app.request('/health', { headers: { 'x-cloudfront-shared-secret': 'a-long-test-secret-value' } })).status).toBe(200);
	});

	it('logs each refusal as origin_secret_rejected with a reason and nothing else, and logs nothing for the right secret', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', 'a-long-test-secret-value');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const app = createApp();
			await app.request('/projects/11111111-1111-1111-1111-111111111111?x=1', { headers: { 'x-viewer-address': '203.0.113.9' } });
			await app.request('/health', { headers: { 'x-cloudfront-shared-secret': 'a-long-test-secret-valuX' } });
			const lines = warn.mock.calls.map((args) => JSON.parse(String(args[0])));
			expect(lines).toEqual([
				{ event: 'origin_secret_rejected', reason: 'missing' },
				{ event: 'origin_secret_rejected', reason: 'mismatch' }
			]);
			warn.mockClear();
			await app.request('/health', { headers: { 'x-cloudfront-shared-secret': 'a-long-test-secret-value' } });
			expect(warn.mock.calls.filter((args) => String(args[0]).includes('origin_secret_rejected'))).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('CORS', () => {
	it('allows only the configured origins', async () => {
		vi.stubEnv('ALLOWED_ORIGINS', ORIGIN);
		const app = createApp();
		const ok = await app.request('/health', { headers: { origin: ORIGIN } });
		expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
		const evil = await app.request('/health', { headers: { origin: 'https://evil.example' } });
		expect(evil.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('lets the sign-in retry carry the WAF token header, and nothing else new', async () => {
		vi.stubEnv('ALLOWED_ORIGINS', ORIGIN);
		const pre = await createApp().request('/auth/login', {
			method: 'OPTIONS',
			headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-aws-waf-token' }
		});
		expect(pre.headers.get('access-control-allow-headers')?.toLowerCase().split(/\s*,\s*/).sort()).toEqual(['content-type', 'x-aws-waf-token']);
	});
});

describe('cross-origin writes', () => {
	it('refuses a cross-site form post, and lets the same post through from the app origin (positive control)', async () => {
		vi.stubEnv('ALLOWED_ORIGINS', ORIGIN);
		const app = createApp();
		const post = (origin: string) =>
			app.request('/auth/logout', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
		expect((await post('https://evil.example')).status).toBe(403);
		expect((await post(ORIGIN)).status).not.toBe(403);
	});
});

describe('the Lambda entry point fails closed without the secret', () => {
	it('refuses a missing or short secret and accepts a Terraform-length one (positive control)', async () => {
		const { assertEdgeSecret } = await import('./app.js');
		expect(() => assertEdgeSecret({})).toThrow(/CLOUDFRONT_SHARED_SECRET/);
		expect(() => assertEdgeSecret({ CLOUDFRONT_SHARED_SECRET: 'short' })).toThrow(/CLOUDFRONT_SHARED_SECRET/);
		expect(() => assertEdgeSecret({ CLOUDFRONT_SHARED_SECRET: 'x'.repeat(48) })).not.toThrow();
	});

	it('lambda.ts will not load without it, and loads with it', async () => {
		// The streaming handler is made from the Lambda runtime's awslambda global (http/lambdaStream.ts).
		vi.stubGlobal('awslambda', fakeRuntime);
		vi.resetModules();
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', '');
		await expect(import('./lambda.js')).rejects.toThrow(/CLOUDFRONT_SHARED_SECRET/);
		vi.resetModules();
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', 'x'.repeat(48));
		await expect(import('./lambda.js')).resolves.toHaveProperty('handler');
	});
});
