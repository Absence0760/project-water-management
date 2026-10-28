// The assistant's Lambda (lambda-assistant.ts, issue #610): the API's app, in
// response-streaming mode, serving the assistant's paths only. Driven through
// the same stand-in for the runtime's streaming as the API's adapter test
// (__tests__/lambdaRuntime.ts). The production config check and the bundle's
// classified settings are production.security.test.ts's job; the 404 for
// every other path, and that the app's own checks still run on an assistant
// path, are this file's.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRuntime, invokeStreamed, urlEvent } from './__tests__/lambdaRuntime.js';
import { createApp } from './app.js';
import { assistantOnly, isAssistantPath } from './http/assistantOnly.js';

const SECRET = 'a-long-test-secret-value-for-the-edge';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('isAssistantPath', () => {
	it('takes the status and everything under it', () => {
		for (const p of ['/projects/abc/assistant', '/projects/abc/assistant/', '/projects/abc/assistant/messages', '/projects/0f9c-11/assistant/a/b']) expect(isAssistantPath(p), p).toBe(true);
	});

	it('refuses every other path, near misses included', () => {
		for (const p of [
			'/',
			'/health',
			'/auth/login',
			'/projects',
			'/projects/abc',
			'/projects/abc/runs',
			'/projects/abc/assistants',
			'/projects/abc/assistantx/messages',
			'/projects//assistant',
			'/projects/abc/def/assistant',
			'/api/projects/abc/assistant',
			'/me/assistant'
		])
			expect(isAssistantPath(p), p).toBe(false);
	});

	it('sees the path as the app does: dot segments resolve before the match', () => {
		// The Request the adapter builds resolves them, so this reaches the run routes and is refused here.
		expect(new URL('https://x/projects/abc/assistant/../runs').pathname).toBe('/projects/abc/runs');
		expect(isAssistantPath(new URL('https://x/projects/abc/assistant/%2e%2e/runs').pathname)).toBe(false);
	});
});

describe('the handler', () => {
	const app = () => assistantOnly(createApp());
	const headers = (extra: Record<string, string> = {}) => ({ 'x-cloudfront-shared-secret': SECRET, ...extra });

	it('answers 404 for a path the API serves, before the app runs (no edge-secret check, no session)', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', SECRET);
		for (const path of ['/health', '/auth/login', '/projects/abc/runs', '/projects/abc/assistant/../export']) {
			const out = await invokeStreamed(app(), urlEvent(path, { headers: headers() }));
			expect(out.metadata?.statusCode, path).toBe(404);
			expect(JSON.parse(out.body.toString()), path).toEqual({ error: 'not found' });
			expect(out.ended, path).toBe(true);
		}
	});

	it('runs the app on an assistant path: the shared secret, then the session (positive control for the 404s)', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', SECRET);
		const direct = await invokeStreamed(app(), urlEvent('/projects/abc/assistant'));
		expect(direct.metadata?.statusCode).toBe(403);
		const signedOut = await invokeStreamed(app(), urlEvent('/projects/abc/assistant', { headers: headers() }));
		expect(signedOut.metadata?.statusCode).toBe(401);
		// A message is a POST: CSRF refuses another origin before any route.
		const crossSite = await invokeStreamed(
			app(),
			urlEvent('/projects/abc/assistant/messages', { method: 'POST', headers: headers({ origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }), body: 'a=1' })
		);
		expect(crossSite.metadata?.statusCode).toBe(403);
	});

	it('hands an encoded path to the app, whose refuseAmbiguousPaths refuses it', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', SECRET);
		const out = await invokeStreamed(app(), urlEvent('/projects/abc/assistant/..%2F..%2Fauth', { headers: headers() }));
		expect(out.metadata?.statusCode).toBe(400);
	});

	it('the entry point exports the streaming handler of the assistant-only app, and infra/assistant.tf puts its URL in RESPONSE_STREAM mode', async () => {
		// Either alone breaks every message (as lambda.ts and infra/lambda.tf, docs/deployment.md § Response streaming).
		const entry = readFileSync(new URL('./lambda-assistant.ts', import.meta.url), 'utf8');
		expect(entry).toMatch(/^export const handler = streamingHandler\(assistantOnly\(createApp\(\)\)\);$/m);
		expect(entry).toMatch(/^await loadRuntimeSecrets\('assistant'\);$/m);
		expect(entry).toMatch(/^assertLambdaEnv\('assistant'\);$/m);
		const tf = readFileSync(new URL('../../infra/assistant.tf', import.meta.url), 'utf8');
		const url = /resource "aws_lambda_function_url" "assistant" \{[\s\S]*?\n\}/.exec(tf)?.[0] ?? '';
		expect(url).toMatch(/^\s*invoke_mode\s*=\s*"RESPONSE_STREAM"$/m);
		expect(url).toMatch(/^\s*authorization_type\s*=\s*"NONE"$/m);
		// And it loads: the handler is made from the runtime's awslambda global at import.
		vi.stubGlobal('awslambda', fakeRuntime);
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', SECRET);
		const mod = await import('./lambda-assistant.js');
		expect(typeof mod.handler).toBe('function');
	});
});
