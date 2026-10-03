// Password reset, email verification and session revocation (004_email.sql,
// auth/email-routes.ts). Mail is captured by the in-memory transport.
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { hashToken } from './tokens.js';
import { anon, asOwner, lastMailTo, mailCount, signUp, tokenIn } from '../__tests__/helpers.js';

const verifyMail = (email: string) => {
	const m = lastMailTo(email);
	expect(m?.subject).toMatch(/Confirm your email/);
	return m;
};

describe('email verification', () => {
	it('sends a link on sign-up; the link verifies once and only once', async () => {
		const u = await signUp('Verify', { verified: false });
		expect((await u.call('GET', '/auth/me')).body.user.emailVerified).toBe(false);
		const token = tokenIn(verifyMail(u.email));
		expect(lastMailTo(u.email)!.text).toContain(`http://localhost:7777/verify-email?token=${token}`);

		// Anonymous on purpose: the token is the credential (link opened on another device).
		const ok = await anon('POST', '/auth/verify-email', { token });
		expect(ok.status).toBe(200);
		// The address it confirmed, so the page can tell it from the account a browser is signed in to.
		expect(ok.body).toEqual({ verified: true, email: u.email });
		expect((await u.call('GET', '/auth/me')).body.user.emailVerified).toBe(true);

		// Single use.
		const again = await anon('POST', '/auth/verify-email', { token });
		expect(again.status).toBe(400);
		expect(again.body.error).toMatch(/invalid or has expired/);
		expect(again.body.code).toBe('link_invalid');
	});

	it('rejects expired, malformed and unknown tokens', async () => {
		const u = await signUp('Expire', { verified: false });
		const token = tokenIn(verifyMail(u.email));
		await asOwner(`UPDATE email_token SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		expect((await anon('POST', '/auth/verify-email', { token })).status).toBe(400);
		expect((await u.call('GET', '/auth/me')).body.user.emailVerified).toBe(false);
		expect((await anon('POST', '/auth/verify-email', { token: 'not-a-token' })).status).toBe(400);
		expect((await anon('POST', '/auth/verify-email', { token: 'A'.repeat(43) })).status).toBe(400);
		expect((await anon('POST', '/auth/verify-email', {})).status).toBe(400);
	});

	it('a verify token cannot reset a password', async () => {
		const u = await signUp('Purpose', { verified: false });
		const token = tokenIn(verifyMail(u.email));
		expect((await anon('POST', '/auth/reset-password', { token, password: 'new password 1' })).status).toBe(400);
		// …and it wasn't burned by the attempt.
		expect((await anon('POST', '/auth/verify-email', { token })).status).toBe(200);
	});

	it('resend is throttled per address, replaces the old link, and stops once verified', async () => {
		const u = await signUp('Resend', { verified: false });
		const first = tokenIn(verifyMail(u.email));
		// The sign-up email went out moments ago.
		const throttled = await u.call('POST', '/auth/resend-verification');
		expect(throttled.status).toBe(429);
		expect(mailCount(u.email)).toBe(1);

		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [u.id]);
		const resent = await u.call('POST', '/auth/resend-verification');
		expect(resent.status).toBe(202);
		expect(mailCount(u.email)).toBe(2);
		const second = tokenIn(verifyMail(u.email));
		expect(second).not.toBe(first);

		// Only the newest link works.
		expect((await anon('POST', '/auth/verify-email', { token: first })).status).toBe(400);
		expect((await anon('POST', '/auth/verify-email', { token: second })).status).toBe(200);
		expect((await u.call('POST', '/auth/resend-verification')).status).toBe(409);
	});
});

describe('password reset', () => {
	it('answers 202 identically for known and unknown addresses (no enumeration)', async () => {
		const u = await signUp('Enum');
		const unknown = `nobody-${crypto.randomUUID()}@example.com`;
		const a = await anon('POST', '/auth/forgot-password', { email: u.email });
		const b = await anon('POST', '/auth/forgot-password', { email: unknown });
		expect(a.status).toBe(202);
		expect(b.status).toBe(202);
		expect(a.body).toEqual(b.body);
		expect(lastMailTo(u.email)?.subject).toMatch(/Reset your password/);
		expect(mailCount(unknown)).toBe(0);
		// Case-insensitive, like login.
		expect((await anon('POST', '/auth/forgot-password', { email: u.email.toUpperCase() })).status).toBe(202);
		expect((await anon('POST', '/auth/forgot-password', { email: 'not an email' })).status).toBe(400);
	});

	it('throttles reset mail per address but still answers 202', async () => {
		const u = await signUp('Throttle');
		const before = mailCount(u.email);
		for (let i = 0; i < 3; i++) expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1 AND purpose = 'reset'`, [u.id]);
		expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 2);
	});

	it('sets the new password, revokes existing sessions, verifies the address, and works once', async () => {
		const u = await signUp('Reset');
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const token = tokenIn(lastMailTo(u.email));
		expect(lastMailTo(u.email)!.text).toContain(`/reset-password?token=${token}`);

		expect((await anon('POST', '/auth/reset-password', { token, password: 'short' })).status).toBe(400);
		const res = await anon('POST', '/auth/reset-password', { token, password: 'brand new password' });
		expect(res.status).toBe(204);
		expect(res.headers.get('set-cookie')).toMatch(/wm_session=;/);

		// The session from before the reset is dead (e.g. a thief's).
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
		expect((await u.call('GET', '/projects')).status).toBe(401);

		// Old password out, new one in — and the new session is valid immediately.
		expect((await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' })).status).toBe(401);
		const login = await anon('POST', '/auth/login', { email: u.email, password: 'brand new password' });
		expect(login.status).toBe(200);
		expect(login.body.user.emailVerified).toBe(true);
		const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
		expect((await anon('GET', '/auth/me', undefined, cookie)).status).toBe(200);

		// Single use.
		expect((await anon('POST', '/auth/reset-password', { token, password: 'another password' })).status).toBe(400);
	});

	it('rejects an expired reset link', async () => {
		const u = await signUp('ResetExpired');
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const token = tokenIn(lastMailTo(u.email));
		await asOwner(`UPDATE email_token SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND purpose = 'reset'`, [u.id]);
		expect((await anon('POST', '/auth/reset-password', { token, password: 'brand new password' })).status).toBe(400);
		expect((await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' })).status).toBe(200);
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
	});

	it('stores only token hashes', async () => {
		const u = await signUp('Hash', { verified: false });
		const token = tokenIn(verifyMail(u.email));
		const rows = await asOwner(`SELECT encode(token_hash, 'hex') AS h FROM email_token WHERE user_id = $1`, [u.id]);
		expect(rows).toHaveLength(1);
		expect(rows[0].h).toBe(hashToken(token).toString('hex'));
		expect(rows[0].h).not.toContain(Buffer.from(token).toString('hex'));
	});
});

describe('session watermark', () => {
	const sign = (sub: string, iatSeconds: number) =>
		new SignJWT({})
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject(sub)
			.setIssuer('water-management')
			.setIssuedAt(iatSeconds)
			.setExpirationTime(iatSeconds + 3600)
			.setJti(crypto.randomUUID())
			.sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET!));

	it('rejects tokens issued before sessions_revoked_at, including ones without iat_ms', async () => {
		const u = await signUp('Watermark');
		const now = Math.floor(Date.now() / 1000);
		const legacy = `wm_session=${await sign(u.id, now - 60)}`;
		expect((await anon('GET', '/auth/me', undefined, legacy)).status).toBe(200);
		await asOwner(`UPDATE app_user SET sessions_revoked_at = now() - interval '30 seconds' WHERE id = $1`, [u.id]);
		expect((await anon('GET', '/auth/me', undefined, legacy)).status).toBe(401);
		// A session issued after the watermark is fine.
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
	});

	it('sign out everywhere revokes every session of the account, and only that account', async () => {
		const u = await signUp('Everywhere');
		const other = await signUp('Bystander');
		// A second device.
		const second = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
		const secondCookie = second.headers.get('set-cookie')!.split(';')[0]!;
		expect((await anon('GET', '/auth/me', undefined, secondCookie)).status).toBe(200);

		const res = await anon('POST', '/auth/logout-everywhere', undefined, secondCookie);
		expect(res.status).toBe(204);
		expect(res.headers.get('set-cookie')).toMatch(/wm_session=;/);
		expect((await anon('GET', '/auth/me', undefined, secondCookie)).status).toBe(401);
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
		expect((await u.call('GET', '/projects')).status).toBe(401);
		// Positive control: other accounts are untouched, and signing in again works at once.
		expect((await other.call('GET', '/auth/me')).status).toBe(200);
		const again = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
		expect(again.status).toBe(200);
		expect((await anon('GET', '/auth/me', undefined, again.headers.get('set-cookie')!.split(';')[0]!)).status).toBe(200);
	});

	it('rejects a validly signed session for an account that no longer exists', async () => {
		const u = await signUp('Gone');
		await asOwner('DELETE FROM app_user WHERE id = $1', [u.id]);
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
	});
});
