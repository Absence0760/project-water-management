// Sign-in, password reset and email verification are throttled per account
// address in the database, not per client address and not by the WAF (issue
// #126; docs/security.md § Throttles that don't depend on the WAF). The WAF's
// `/api/auth/` rate limit is per IP and matches the path, so it can be spread
// across many addresses, or dodged with an encoded path like `/api/%61uth/…`
// (which the WAF rule decodes since #132 and the app refuses, http/rawPath.ts).
// These tests run through an app that
// trusts the edge's viewer address (the CloudFront shared secret set) and send
// every request from a different one, so a limit keyed on the client address
// would never engage: each limit below still does. Every "cannot" has a
// positive control. Time is moved in the database, never by sleeping.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, mailCount, signUp } from '../__tests__/helpers.js';
import { createApp } from '../app.js';
import { VIEWER_ADDRESS_HEADER } from '../http/clientAddress.js';

const SECRET = 'a-test-edge-secret-of-enough-length-000';
const ORIGIN = 'http://localhost:7777';
let edge: ReturnType<typeof createApp>;

beforeAll(() => {
	vi.stubEnv('CLOUDFRONT_SHARED_SECRET', SECRET);
	edge = createApp();
});
afterAll(() => vi.unstubAllEnvs());

let n = 0;
/** A POST from a fresh viewer address each time, as a distributed attacker would send it. */
async function fromNewAddress(path: string, body: unknown) {
	n++;
	const r = await edge.request(path, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'content-type': 'application/json',
			'x-cloudfront-shared-secret': SECRET,
			[VIEWER_ADDRESS_HEADER]: `198.51.100.${n % 250}`
		},
		body: JSON.stringify(body)
	});
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : null };
}

describe('per-account throttles hold whatever address the requests come from', () => {
	it('sign-in: five wrong passwords from five addresses lock the account for a sixth', async () => {
		const u = await signUp('Spread');
		const other = await signUp('Bystander');
		for (let i = 0; i < 5; i++) expect((await fromNewAddress('/auth/login', { email: u.email, password: 'wrong guess' })).status).toBe(401);
		const locked = await fromNewAddress('/auth/login', { email: u.email, password: 'correct horse' });
		expect(locked).toMatchObject({ status: 429, body: { code: 'signin_locked' } });
		// Positive control: the lock is the address's, not the network's.
		expect((await fromNewAddress('/auth/login', { email: other.email, password: 'correct horse' })).status).toBe(200);
	});

	it('password reset: a second request from another address inside the cooldown sends nothing', async () => {
		const u = await signUp('ResetSpread');
		const before = mailCount(u.email);
		expect((await fromNewAddress('/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1); // positive control: the first one goes out
		expect((await fromNewAddress('/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
	});

	it('verification: a signed-out resend from another address inside the cooldown sends nothing', async () => {
		const u = await signUp('VerifySpread', { verified: false });
		// Sign-up mailed a link; move it past the cooldown so the first resend goes out.
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [u.id]);
		const before = mailCount(u.email);
		expect((await fromNewAddress('/auth/resend-confirmation', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
		expect((await fromNewAddress('/auth/resend-confirmation', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
	});

	it('an escaped path to the sign-in route is refused before it is counted or answered', async () => {
		const u = await signUp('Escaped');
		const res = await fromNewAddress('/%61uth/login', { email: u.email, password: 'wrong guess' });
		expect(res).toEqual({ status: 400, body: { error: 'bad request path' } });
		expect(await asOwner('SELECT failures FROM login_throttle WHERE email = $1', [u.email])).toEqual([]);
		// Positive control: the plain path is counted.
		expect((await fromNewAddress('/auth/login', { email: u.email, password: 'wrong guess' })).status).toBe(401);
		expect(await asOwner('SELECT failures FROM login_throttle WHERE email = $1', [u.email])).toEqual([{ failures: 1 }]);
	});
});
