// The sign-up throttle (079_signup_throttle.sql, auth/signupThrottle.ts,
// docs/security.md § Password reset, email verification and invites):
//   - 10 sign-ups per client address an hour, then 429 signup_throttled with
//     Retry-After; a refused attempt doesn't count, so hammering never extends it;
//   - the window ends and sign-up works again;
//   - a taken and a free address get the same answer, throttled or not (a
//     sign-up answers 202 either way and a taken address's owner gets an
//     email instead, issue #57); the throttle also caps the emails sign-up sends;
//   - the client address is the edge's X-Viewer-Address only on a request
//     that passed the CloudFront shared-secret check: without it, a spoofed
//     header is ignored;
//   - one ceiling (500 an hour) across every client.
// The throttle is off for the rest of the suite (SIGNUP_THROTTLE=off in
// __tests__/setup.ts); each test here turns it on. Time is moved in the
// database (window_start), never by sleeping. Every "cannot" has a positive control.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { anon, asOwner, signUp } from '../__tests__/helpers.js';
import { VIEWER_ADDRESS_HEADER } from '../http/clientAddress.js';
import { SIGNUP_THROTTLE } from './signupThrottle.js';

const fresh = (name = 'new') => `${name}-${crypto.randomUUID()}@example.com`;
/** Sign up from the tests' one anonymous browser (no shared secret configured: the fixed local key). */
const register = (email: string) => anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'New', acceptTerms: LEGAL_VERSION });
/** Sign up through `edge`, an app made in the test, with these headers. */
const registerVia = (email: string, headers: Record<string, string>) =>
	edge!.request('/auth/register', {
		method: 'POST',
		headers: { origin: 'http://localhost:7777', 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ email, password: 'correct horse', displayName: 'New', acceptTerms: LEGAL_VERSION })
	});
const statusOf = async (r: { status: number } | Promise<{ status: number }>) => (await r).status;

/** Sign up `n` fresh addresses from the same client; every one must be accepted. */
async function fill(n: number, headers?: Record<string, string>) {
	for (let i = 0; i < n; i++) expect(await statusOf(headers ? registerVia(fresh(), headers) : register(fresh()))).toBe(202);
}

/** An existing account, made with the throttle off so it isn't counted. */
async function existing() {
	vi.stubEnv('SIGNUP_THROTTLE', 'off');
	const u = await signUp('Taken');
	vi.stubEnv('SIGNUP_THROTTLE', '');
	return u;
}

const EDGE_SECRET = 'a-long-test-secret-value-for-the-edge-0000';
let edge: ReturnType<typeof createApp> | undefined;
const viaEdge = (ip: string) => ({ 'x-cloudfront-shared-secret': EDGE_SECRET, [VIEWER_ADDRESS_HEADER]: ip });

beforeEach(async () => {
	vi.stubEnv('SIGNUP_THROTTLE', '');
	await asOwner('DELETE FROM signup_throttle');
});
afterEach(() => {
	vi.unstubAllEnvs();
	edge = undefined;
});

describe('per client address', () => {
	it('positive control: sign-up works with the throttle on, and the helpers’ signUp works with it off', async () => {
		expect(await statusOf(register(fresh()))).toBe(202);
		vi.stubEnv('SIGNUP_THROTTLE', 'off');
		await asOwner(`UPDATE signup_throttle SET attempts = 1000`);
		expect((await signUp('Helper')).email).toMatch(/@example\.com$/);
	});

	it('accepts the 10th sign-up in the hour and refuses the 11th with a coded 429 and Retry-After', async () => {
		expect(SIGNUP_THROTTLE.perClient).toBe(10);
		// A taken address counts too (it sends its owner an email), and answers like a free one.
		const taken = await existing();
		expect((await register(taken.email)).status).toBe(202);
		await fill(9);
		const refused = await register(fresh());
		expect(refused.status).toBe(429);
		expect(refused.body.code).toBe('signup_throttled');
		const retry = Number(refused.headers.get('retry-after'));
		expect(retry).toBeGreaterThan(3500);
		expect(retry).toBeLessThanOrEqual(3600);
		expect(refused.body.params).toEqual({ seconds: retry });
	});

	it('does not count a refused attempt, so hammering never extends the wait', async () => {
		await fill(10);
		await asOwner(`UPDATE signup_throttle SET window_start = now() - interval '59 minutes'`);
		for (let i = 0; i < 5; i++) expect(await statusOf(register(fresh()))).toBe(429);
		const last = await register(fresh());
		expect(Number(last.headers.get('retry-after'))).toBeLessThanOrEqual(60);
		const rows = await asOwner(`SELECT attempts FROM signup_throttle WHERE bucket <> 'global'`);
		expect(rows).toEqual([{ attempts: 10 }]);
	});

	it('starts again once the window is over, and not a moment before', async () => {
		await fill(10);
		await asOwner(`UPDATE signup_throttle SET window_start = now() - interval '59 minutes 50 seconds'`);
		expect(await statusOf(register(fresh()))).toBe(429);
		await asOwner(`UPDATE signup_throttle SET window_start = now() - interval '1 hour 1 second'`);
		await fill(10);
		expect(await statusOf(register(fresh()))).toBe(429);
	});

	it('answers a taken and a free address the same once throttled, and makes no account for the free one', async () => {
		const taken = await existing();
		// Within the limit, the taken address answers like a free one too.
		expect((await register(taken.email)).status).toBe(202);
		await fill(9);
		const free = fresh('free');
		const a = await register(taken.email);
		const b = await register(free);
		expect(a.status).toBe(429);
		expect(b.status).toBe(429);
		const { params: pa, ...restA } = a.body;
		const { params: pb, ...restB } = b.body;
		expect(restA).toEqual(restB);
		expect(Math.abs(pa.seconds - pb.seconds)).toBeLessThanOrEqual(1);
		// The free address got no account: signing in to it is a plain wrong-credentials.
		expect((await anon('POST', '/auth/login', { email: free, password: 'correct horse' })).status).toBe(401);
	});
});

describe('the client address', () => {
	it('behind the edge, each viewer address has its own limit (positive control for the spoof test)', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', EDGE_SECRET);
		edge = createApp();
		await fill(10, viaEdge('203.0.113.9'));
		expect(await statusOf(registerVia(fresh(), viaEdge('203.0.113.9')))).toBe(429);
		// Another viewer is not held up by the first one's limit.
		expect(await statusOf(registerVia(fresh(), viaEdge('198.51.100.4')))).toBe(202);
		// Rotating within one IPv6 /64 is the same client.
		await fill(10, viaEdge('2001:db8:1:2::1'));
		expect(await statusOf(registerVia(fresh(), viaEdge('2001:db8:1:2::ffff')))).toBe(429);
	});

	it('ignores a spoofed viewer address (or X-Forwarded-For) on a request without the shared secret', async () => {
		// No shared secret configured (local, tests): a changing header is still one client.
		edge = createApp();
		for (let i = 0; i < 10; i++) {
			expect(await statusOf(registerVia(fresh(), { [VIEWER_ADDRESS_HEADER]: `203.0.113.${i}`, 'x-forwarded-for': `198.51.100.${i}` }))).toBe(202);
		}
		expect(await statusOf(registerVia(fresh(), { [VIEWER_ADDRESS_HEADER]: '203.0.113.200', 'x-forwarded-for': '198.51.100.200' }))).toBe(429);
		// Behind the edge, a request with the wrong secret never reaches the route.
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', EDGE_SECRET);
		edge = createApp();
		expect(await statusOf(registerVia(fresh(), { 'x-cloudfront-shared-secret': 'x'.repeat(EDGE_SECRET.length), [VIEWER_ADDRESS_HEADER]: '192.0.2.1' }))).toBe(403);
	});
});

describe('the global ceiling', () => {
	it('refuses every client once the hour’s sign-ups reach the ceiling, and lets the last one in', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', EDGE_SECRET);
		edge = createApp();
		expect(await statusOf(registerVia(fresh(), viaEdge('192.0.2.1')))).toBe(202);
		await asOwner(`UPDATE signup_throttle SET attempts = $1 WHERE bucket = 'global'`, [SIGNUP_THROTTLE.global - 1]);
		expect(await statusOf(registerVia(fresh(), viaEdge('192.0.2.2')))).toBe(202);
		const refused = await registerVia(fresh(), viaEdge('192.0.2.3'));
		expect(refused.status).toBe(429);
		expect(((await refused.json()) as { code: string }).code).toBe('signup_throttled');
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(3500);
		// The global window ending lets everyone in again.
		await asOwner(`UPDATE signup_throttle SET window_start = now() - interval '1 hour 1 second' WHERE bucket = 'global'`);
		expect(await statusOf(registerVia(fresh(), viaEdge('192.0.2.3')))).toBe(202);
	});
});
