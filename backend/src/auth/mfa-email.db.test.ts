// Codes by email as a second factor, end to end through the API
// (206_mfa_email_code.sql; docs/security.md § Two-step sign-in → Code by
// email): turning it on (the password, then the emailed code), signing in
// with an emailed code (right, wrong, expired, reused, replaced), the send
// limits, the step-up and the fresh code, the "enrolled" check, turning it
// off, living beside the authenticator, and RLS on the new tables. Codes are
// read from the memory outbox. Time is moved in the database, never slept.
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, lastMailTo, mailCount, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { hashEmailCode } from './emailCode.js';
import { MFA_CHALLENGE_COOKIE, SESSION_COOKIE } from './session.js';
import { hasConfirmedFactor, requestAuth, requireFreshCode, stepUpRefusal } from './stepUp.js';
import { base32Decode, totp } from './totp.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

/** `name=value` of a cookie a response set, if any. */
const cookieOf = (h: Headers, name: string) => {
	const set = h.getSetCookie().find((c) => c.startsWith(`${name}=`));
	const pair = set?.split(';')[0];
	return pair && pair !== `${name}=` ? pair : undefined;
};
const claimsOf = (cookie: string) => decodeJwt(cookie.split('=')[1]!);

/** The code in the newest email to `to` (a line of its own, six digits). */
function codeIn(to: string): string {
	const mail = lastMailTo(to);
	expect(mail?.kind).toBe('mfa_code');
	const m = mail!.text.match(/^(\d{6})$/m);
	if (!m) throw new Error('no code in the email');
	return m[1]!;
}

/** Past the minute between sends, so only the hourly cap (or nothing) decides. */
const pastGap = (userId: string) => asOwner(`UPDATE mfa_email_send SET sent_at = sent_at - interval '2 minutes' WHERE user_id = $1`, [userId]);

/** Sign up and turn codes by email on: the user, the recovery codes and the two-step session the confirm gave. */
async function emailEnrolled(name: string) {
	const u = await signUp(name);
	expect((await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
	const r = await anon('POST', '/auth/mfa/email/confirm', { code: codeIn(u.email) }, u.cookie);
	expect(r.status).toBe(200);
	return { ...u, recoveryCodes: r.body.recoveryCodes as string[], twoStep: cookieOf(r.headers, SESSION_COOKIE)! };
}

/** POST /auth/login: the answer and the challenge cookie it set. */
async function login(u: { email: string }) {
	const r = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
	return { ...r, challenge: cookieOf(r.headers, MFA_CHALLENGE_COOKIE), session: cookieOf(r.headers, SESSION_COOKIE) };
}

/** Sign in up to the challenge and have a code emailed: the challenge and the code. */
async function challengeWithCode(u: User): Promise<{ challenge: string; code: string }> {
	const { challenge } = await login(u);
	expect((await anon('POST', '/auth/mfa/challenge/email', undefined, challenge)).status).toBe(202);
	return { challenge: challenge!, code: codeIn(u.email) };
}

/** A code that isn't `code`. */
const not = (code: string) => (code === '000000' ? '000001' : '000000');

const failures = async (userId: string) => (await asOwner('SELECT failures FROM mfa_throttle WHERE user_id = $1', [userId]))[0]?.failures ?? 0;

describe('turning codes by email on', () => {
	it('needs the current password, so a stolen session can’t put its own factor on the account', async () => {
		const u = await signUp('MePw');
		const before = mailCount(u.email);
		expect(await u.call('POST', '/auth/mfa/email/enrol', { password: 'wrong horse' })).toMatchObject({ status: 403, body: { code: 'wrong_current_password' } });
		expect(await asOwner('SELECT 1 FROM user_email_otp WHERE user_id = $1', [u.id])).toEqual([]);
		expect(mailCount(u.email)).toBe(before);
	});

	it('emails a code to the account’s address, stored as a keyed hash, and the code turns it on', async () => {
		const u = await signUp('MeEnrol');
		const r = await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' });
		expect(r).toMatchObject({ status: 202, body: { resendInSeconds: 60, expiresInSeconds: 600 } });
		const code = codeIn(u.email);
		const mail = lastMailTo(u.email)!;
		// No link to open, and the code isn't in the subject (a lock screen's preview).
		expect(mail.text).not.toMatch(/https?:\/\//);
		expect(mail.subject).not.toContain(code);
		// Stored as an HMAC under the server's key: not the code, not a plain SHA-256 of it (with or without the account).
		const [row] = await asOwner('SELECT code_hash, purpose, expires_at - now() AS ttl FROM mfa_email_code WHERE user_id = $1', [u.id]);
		expect(row.purpose).toBe('enrol');
		const stored = row.code_hash as Buffer;
		expect(stored).toHaveLength(32);
		expect(stored.includes(Buffer.from(code))).toBe(false);
		for (const plain of [code, `${u.id}${code}`, `${u.id}\0enrol\0${code}`]) expect(stored.equals(createHash('sha256').update(plain).digest())).toBe(false);
		expect(stored.equals(hashEmailCode(u.id, 'enrol', code))).toBe(true);
		// Not on yet: GET /auth/mfa says it is pending, and signing in is still one step.
		expect((await u.call('GET', '/auth/mfa')).body).toMatchObject({ enrolled: false, methods: [], emailPending: true, recoveryCodesLeft: 0 });
		expect((await login(u)).body.user).toMatchObject({ id: u.id });

		// A wrong code is refused and counts on the code throttle, like a wrong app code.
		const wrong = code === '000000' ? '000001' : '000000';
		expect(await u.call('POST', '/auth/mfa/email/confirm', { code: wrong })).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		expect(await failures(u.id)).toBe(1);
		const ok = await anon('POST', '/auth/mfa/email/confirm', { code: `${code.slice(0, 3)} ${code.slice(3)}` }, u.cookie);
		expect(ok.status).toBe(200);
		// The first factor: ten recovery codes, shown now.
		expect(ok.body.recoveryCodes).toHaveLength(10);
		const twoStep = cookieOf(ok.headers, SESSION_COOKIE)!;
		expect(claimsOf(twoStep)).toMatchObject({ amr: ['pwd', 'otp'], otp_at: expect.any(Number) });
		expect((await anon('GET', '/auth/mfa', undefined, twoStep)).body).toMatchObject({
			enrolled: true,
			methods: ['email'],
			emailPending: false,
			recoveryCodesLeft: 10,
			sessionVerified: true
		});
		expect(await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1', [u.id])).toEqual([{ kind: 'mfa.email_enrolled' }]);
		// A right code cleared the count; the code is spent.
		expect(await failures(u.id)).toBe(0);
		expect(await asOwner('SELECT code_hash FROM mfa_email_code WHERE user_id = $1', [u.id])).toEqual([{ code_hash: null }]);
		expect(await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).toMatchObject({ status: 409, body: { code: 'mfa_already_enrolled' } });
	});

	it('a confirm with nothing started is refused, and an enrolment code can’t be used to sign in', async () => {
		const u = await signUp('MeNothing');
		expect(await u.call('POST', '/auth/mfa/email/confirm', { code: '123456' })).toMatchObject({ status: 409, body: { code: 'mfa_not_started' } });
		// A code is bound to its purpose: the stored value for 'enrol' doesn't match as 'use'.
		expect((await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
		const code = codeIn(u.email);
		expect(await withUser(u.id, async (db) => (await db.query('SELECT app_mfa_email_use($1, $2) AS ok', [hashEmailCode(u.id, 'use', code), 'use'])).rows[0].ok)).toBe(false);
		// Positive control: the same code, for its own purpose, is accepted.
		expect((await u.call('POST', '/auth/mfa/email/confirm', { code })).status).toBe(200);
	});

	it('“Send again” while pending emails a new enrolment code that replaces the old', async () => {
		const u = await signUp('MeResend');
		expect((await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
		const first = codeIn(u.email);
		await pastGap(u.id);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		const second = codeIn(u.email);
		if (first !== second) expect((await u.call('POST', '/auth/mfa/email/confirm', { code: first })).status).toBe(400);
		expect((await u.call('POST', '/auth/mfa/email/confirm', { code: second })).status).toBe(200);
	});
});

describe('turning codes by email on: the edges', () => {
	it('goes through the sign-in lockout: past five wrong passwords even the right one is refused, and nothing is sent', async () => {
		const u = await signUp('MeLockout');
		const before = mailCount(u.email);
		let locked = false;
		for (let i = 0; i < 8 && !locked; i++) {
			const r = await u.call('POST', '/auth/mfa/email/enrol', { password: 'wrong horse' });
			if (r.status === 429) locked = true;
			else expect(r).toMatchObject({ status: 403, body: { code: 'wrong_current_password' } });
		}
		expect(locked).toBe(true);
		expect(await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).toMatchObject({ status: 429, body: { code: 'signin_locked' } });
		expect(await asOwner('SELECT 1 FROM user_email_otp WHERE user_id = $1', [u.id])).toEqual([]);
		expect(mailCount(u.email)).toBe(before);
	});

	it('an expired enrolment code is refused; a new one (positive control) turns it on', async () => {
		const u = await signUp('MeEnrolExpired');
		expect((await u.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
		const code = codeIn(u.email);
		await asOwner(`UPDATE mfa_email_code SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		expect(await u.call('POST', '/auth/mfa/email/confirm', { code })).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		expect((await u.call('GET', '/auth/mfa')).body).toMatchObject({ enrolled: false, emailPending: true });
		await pastGap(u.id);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		expect((await u.call('POST', '/auth/mfa/email/confirm', { code: codeIn(u.email) })).status).toBe(200);
	});

	it('turned off, it can be turned on again: a new first factor, a new set of recovery codes', async () => {
		const u = await emailEnrolled('MeAgain');
		await pastGap(u.id);
		expect((await anon('POST', '/auth/mfa/email/send', undefined, u.twoStep)).status).toBe(202);
		const off = await anon('DELETE', '/auth/mfa/email', { code: codeIn(u.email) }, u.twoStep);
		expect(off.status).toBe(204);
		const session = cookieOf(off.headers, SESSION_COOKIE)!;
		await pastGap(u.id);
		expect((await anon('POST', '/auth/mfa/email/enrol', { password: 'correct horse' }, session)).status).toBe(202);
		const r = await anon('POST', '/auth/mfa/email/confirm', { code: codeIn(u.email) }, session);
		expect(r.status).toBe(200);
		expect(r.body.recoveryCodes).toHaveLength(10);
		expect(r.body.recoveryCodes.some((c: string) => u.recoveryCodes.includes(c))).toBe(false);
		expect((await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1 ORDER BY id', [u.id])).map((e) => e.kind)).toEqual([
			'mfa.email_enrolled',
			'mfa.email_disabled',
			'mfa.email_enrolled'
		]);
	});

	it('beside the app: either order, one set of recovery codes, and the second shows none', async () => {
		const u = await signUp('MeAfterApp');
		const { secret } = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body;
		const app = await anon('POST', '/auth/mfa/totp/confirm', { code: totp(base32Decode(secret)!, Date.now()) }, u.cookie);
		expect(app.body.recoveryCodes).toHaveLength(10);
		const twoStep = cookieOf(app.headers, SESSION_COOKIE)!;
		expect((await anon('POST', '/auth/mfa/email/enrol', { password: 'correct horse' }, twoStep)).status).toBe(202);
		const r = await anon('POST', '/auth/mfa/email/confirm', { code: codeIn(u.email) }, twoStep);
		expect(r).toMatchObject({ status: 200, body: { recoveryCodes: null } });
		expect((await anon('GET', '/auth/mfa', undefined, twoStep)).body).toMatchObject({ methods: ['totp', 'email'], recoveryCodesLeft: 10 });
		// Removing the app with an emailed code: email stays, so do the codes.
		await pastGap(u.id);
		expect((await anon('POST', '/auth/mfa/email/send', undefined, twoStep)).status).toBe(202);
		const off = await anon('DELETE', '/auth/mfa/totp', { code: codeIn(u.email) }, twoStep);
		expect(off.status).toBe(204);
		expect(claimsOf(cookieOf(off.headers, SESSION_COOKIE)!).amr).toEqual(['pwd', 'otp']);
		expect(await asOwner('SELECT count(*)::int AS n FROM user_recovery_code WHERE user_id = $1', [u.id])).toEqual([{ n: 10 }]);
		expect((await login(u)).body).toEqual({ mfaRequired: true, methods: ['email'] });
	});

	it('turning codes by email off with a recovery code: recorded, and (the last factor) the rest of the codes go and other sessions are signed out', async () => {
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
		const u = await emailEnrolled('MeOffRecovery');
		vi.setSystemTime(Date.now() + 1000);
		const off = await anon('DELETE', '/auth/mfa/email', { code: u.recoveryCodes[2] }, u.twoStep);
		expect(off.status).toBe(204);
		expect((await anon('GET', '/auth/me', undefined, u.twoStep)).status).toBe(401);
		const [row] = await asOwner('SELECT sessions_revoked_at FROM app_user WHERE id = $1', [u.id]);
		expect(row.sessions_revoked_at).not.toBeNull();
		expect(await asOwner('SELECT 1 FROM user_recovery_code WHERE user_id = $1', [u.id])).toEqual([]);
		expect((await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1 ORDER BY id', [u.id])).map((e) => e.kind)).toEqual([
			'mfa.email_enrolled',
			'mfa.recovery_used',
			'mfa.email_disabled'
		]);
	});
});

describe('signing in with an emailed code', () => {
	it('the challenge says which factors the account has; the email step sends a code that buys a two-step session', async () => {
		const u = await emailEnrolled('MeLogin');
		await pastGap(u.id);
		const r = await login(u);
		expect(r.body).toEqual({ mfaRequired: true, methods: ['email'] });
		expect(r.session).toBeUndefined();
		// No challenge, no email.
		expect(await anon('POST', '/auth/mfa/challenge/email')).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
		expect(await anon('POST', '/auth/mfa/challenge/email', undefined, r.challenge)).toMatchObject({ status: 202, body: { resendInSeconds: 60 } });
		const code = codeIn(u.email);
		expect(lastMailTo(u.email)!.text).toContain('finish signing in');
		const wrong = code === '000000' ? '000001' : '000000';
		expect(await anon('POST', '/auth/mfa/verify', { code: wrong }, r.challenge)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		expect(await failures(u.id)).toBe(1);
		const ok = await anon('POST', '/auth/mfa/verify', { code }, r.challenge);
		expect(ok.status).toBe(200);
		expect(ok.body.user).toMatchObject({ id: u.id });
		const session = cookieOf(ok.headers, SESSION_COOKIE)!;
		// RFC 8176's `otp` covers any one-time code: no new amr value, and otp_at for the fresh-code actions.
		expect(claimsOf(session)).toMatchObject({ amr: ['pwd', 'otp'], otp_at: expect.any(Number) });
		expect((await anon('GET', '/auth/me', undefined, session)).status).toBe(200);
		expect(await failures(u.id)).toBe(0);
	});

	it('a code works once: used, it can’t sign in again', async () => {
		const u = await emailEnrolled('MeReuse');
		await pastGap(u.id);
		const { challenge, code } = await challengeWithCode(u);
		expect((await anon('POST', '/auth/mfa/verify', { code }, challenge)).status).toBe(200);
		const again = await login(u);
		expect(await anon('POST', '/auth/mfa/verify', { code }, again.challenge)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
	});

	it('an expired code is refused; a fresh one goes through (positive control)', async () => {
		const u = await emailEnrolled('MeExpired');
		await pastGap(u.id);
		const { challenge, code } = await challengeWithCode(u);
		await asOwner(`UPDATE mfa_email_code SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		expect(await anon('POST', '/auth/mfa/verify', { code }, challenge)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		await pastGap(u.id);
		expect((await anon('POST', '/auth/mfa/challenge/email', undefined, challenge)).status).toBe(202);
		expect((await anon('POST', '/auth/mfa/verify', { code: codeIn(u.email) }, challenge)).status).toBe(200);
	});

	it('a new send replaces the old code', async () => {
		const u = await emailEnrolled('MeReplaced');
		await pastGap(u.id);
		const { challenge, code: first } = await challengeWithCode(u);
		await pastGap(u.id);
		expect((await anon('POST', '/auth/mfa/challenge/email', undefined, challenge)).status).toBe(202);
		const second = codeIn(u.email);
		if (first !== second) expect((await anon('POST', '/auth/mfa/verify', { code: first }, challenge)).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/verify', { code: second }, challenge)).status).toBe(200);
	});

	it('wrong emailed codes lock the account’s code checks like wrong app codes, the right code included', async () => {
		const u = await emailEnrolled('MeLock');
		await pastGap(u.id);
		const { challenge, code } = await challengeWithCode(u);
		const wrong = code === '000000' ? '000001' : '000000';
		for (let i = 0; i < 5; i++) expect((await anon('POST', '/auth/mfa/verify', { code: wrong }, challenge)).status).toBe(400);
		expect(await anon('POST', '/auth/mfa/verify', { code }, challenge)).toMatchObject({ status: 429, body: { code: 'mfa_locked' } });
		await asOwner(`UPDATE mfa_throttle SET locked_until = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		// The lock didn't spend the code: once it ends, the right code goes through.
		expect((await anon('POST', '/auth/mfa/verify', { code }, challenge)).status).toBe(200);
	});

	it('an account with the app only isn’t sent a code under its challenge', async () => {
		const u = await signUp('MeAppOnly');
		const { secret } = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body;
		expect((await u.call('POST', '/auth/mfa/totp/confirm', { code: totp(base32Decode(secret)!, Date.now()) })).status).toBe(200);
		const r = await login(u);
		expect(r.body).toEqual({ mfaRequired: true, methods: ['totp'] });
		const before = mailCount(u.email);
		expect(await anon('POST', '/auth/mfa/challenge/email', undefined, r.challenge)).toMatchObject({ status: 409, body: { code: 'mfa_not_enrolled' } });
		expect(mailCount(u.email)).toBe(before);
	});
});

describe('signing in with an emailed code: the edges', () => {
	it('stored for 10 minutes: a second before the end it works, a second after it doesn’t', async () => {
		const u = await emailEnrolled('MeEdge');
		await pastGap(u.id);
		const { challenge, code } = await challengeWithCode(u);
		const [ttl] = await asOwner(`SELECT extract(epoch FROM expires_at - now())::float AS s FROM mfa_email_code WHERE user_id = $1`, [u.id]);
		expect(ttl.s).toBeGreaterThan(595);
		expect(ttl.s).toBeLessThanOrEqual(600);
		await asOwner(`UPDATE mfa_email_code SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		expect((await anon('POST', '/auth/mfa/verify', { code }, challenge)).status).toBe(400);
		await asOwner(`UPDATE mfa_email_code SET expires_at = now() + interval '1 second' WHERE user_id = $1`, [u.id]);
		// The same code, one second short of its end (the refusal above didn't spend it).
		expect((await anon('POST', '/auth/mfa/verify', { code }, challenge)).status).toBe(200);
	});

	it('one account’s code doesn’t sign in another, even with codes by email on both', async () => {
		const a = await emailEnrolled('MeAccountA');
		const b = await emailEnrolled('MeAccountB');
		await pastGap(a.id);
		await pastGap(b.id);
		const forA = await challengeWithCode(a);
		const forB = await challengeWithCode(b);
		if (forA.code !== forB.code) expect((await anon('POST', '/auth/mfa/verify', { code: forA.code }, forB.challenge)).status).toBe(400);
		// Positive controls: each code at its own challenge.
		expect((await anon('POST', '/auth/mfa/verify', { code: forB.code }, forB.challenge)).status).toBe(200);
		expect((await anon('POST', '/auth/mfa/verify', { code: forA.code }, forA.challenge)).status).toBe(200);
	});

	it('a code sent at sign-in works for a step-up, and one sent in the session works at sign-in: one purpose, `use`', async () => {
		const u = await emailEnrolled('MeCrossPurpose');
		await pastGap(u.id);
		const { code } = await challengeWithCode(u);
		expect((await anon('POST', '/auth/mfa/step-up', { code }, u.cookie)).status).toBe(200);
		await pastGap(u.id);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		const sessionCode = codeIn(u.email);
		const { challenge } = await login(u);
		expect((await anon('POST', '/auth/mfa/verify', { code: sessionCode }, challenge)).status).toBe(200);
	});

	it('wrong app codes, emailed codes and recovery codes add up on one throttle, across sign-in and the session', async () => {
		const u = await signUp('MeShared');
		const { secret } = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body;
		const app = await anon('POST', '/auth/mfa/totp/confirm', { code: totp(base32Decode(secret)!, Date.now()) }, u.cookie);
		const twoStep = cookieOf(app.headers, SESSION_COOKIE)!;
		expect((await anon('POST', '/auth/mfa/email/enrol', { password: 'correct horse' }, twoStep)).status).toBe(202);
		expect((await anon('POST', '/auth/mfa/email/confirm', { code: codeIn(u.email) }, twoStep)).status).toBe(200);
		await pastGap(u.id);
		const { challenge, code } = await challengeWithCode(u);
		// Two wrong six-digit codes at sign-in, two at step-up, one wrong recovery code: five in a row.
		for (let i = 0; i < 2; i++) expect((await anon('POST', '/auth/mfa/verify', { code: not(code) }, challenge)).status).toBe(400);
		for (let i = 0; i < 2; i++) expect((await anon('POST', '/auth/mfa/step-up', { code: not(code) }, twoStep)).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/verify', { code: 'AAAAA-AAAAA' }, challenge)).status).toBe(400);
		expect(await failures(u.id)).toBe(5);
		// Locked for every kind of code now, the right emailed one included.
		expect(await anon('POST', '/auth/mfa/verify', { code }, challenge)).toMatchObject({ status: 429, body: { code: 'mfa_locked' } });
	});

	it('the challenge can’t stand in for a session, nor a session for the challenge, at the email routes', async () => {
		const u = await emailEnrolled('MeConfusion');
		await pastGap(u.id);
		const { challenge } = await login(u);
		const asSession = `${SESSION_COOKIE}=${challenge!.split('=')[1]}`;
		expect((await anon('POST', '/auth/mfa/email/send', undefined, asSession)).status).toBe(401);
		const asChallenge = `${MFA_CHALLENGE_COOKIE}=${u.twoStep.split('=')[1]}`;
		expect(await anon('POST', '/auth/mfa/challenge/email', undefined, asChallenge)).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
		// Positive control: each in its own slot.
		expect((await anon('POST', '/auth/mfa/challenge/email', undefined, challenge)).status).toBe(202);
	});

	it('a used challenge sends nothing more', async () => {
		const u = await emailEnrolled('MeUsedChallenge');
		await pastGap(u.id);
		const { challenge, code } = await challengeWithCode(u);
		expect((await anon('POST', '/auth/mfa/verify', { code }, challenge)).status).toBe(200);
		await pastGap(u.id);
		expect(await anon('POST', '/auth/mfa/challenge/email', undefined, challenge)).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
	});
});

describe('the send limits', () => {
	it('a minute between sends: the second answers 429 mfa_email_wait with the seconds, and sends nothing', async () => {
		const u = await emailEnrolled('MeGap');
		await pastGap(u.id);
		const { challenge } = await challengeWithCode(u);
		const before = mailCount(u.email);
		const r = await anon('POST', '/auth/mfa/challenge/email', undefined, challenge);
		expect(r).toMatchObject({ status: 429, body: { code: 'mfa_email_wait', params: { seconds: expect.any(Number) } } });
		expect(r.body.params.seconds).toBeGreaterThan(0);
		expect(r.body.params.seconds).toBeLessThanOrEqual(60);
		expect(Number(r.headers.get('retry-after'))).toBe(r.body.params.seconds);
		expect(mailCount(u.email)).toBe(before);
		// Positive control: past the minute, the next goes.
		await pastGap(u.id);
		expect((await anon('POST', '/auth/mfa/challenge/email', undefined, challenge)).status).toBe(202);
	});

	it('five an hour: the sixth waits until the oldest is an hour old', async () => {
		const u = await emailEnrolled('MeHour');
		// Four more sends spread over the last 50 minutes, plus the enrolment's: five in the hour.
		await asOwner(`UPDATE mfa_email_send SET sent_at = now() - interval '50 minutes' WHERE user_id = $1`, [u.id]);
		await asOwner(`INSERT INTO mfa_email_send (user_id, sent_at) SELECT $1, now() - make_interval(mins => m) FROM unnest(ARRAY[40, 30, 20, 10]) m`, [u.id]);
		const r = await u.call('POST', '/auth/mfa/email/send');
		expect(r).toMatchObject({ status: 429, body: { code: 'mfa_email_wait' } });
		// The 50-minute-old send ages out in about 10 minutes.
		expect(r.body.params.seconds).toBeGreaterThan(9 * 60);
		expect(r.body.params.seconds).toBeLessThanOrEqual(10 * 60);
		await asOwner(`UPDATE mfa_email_send SET sent_at = sent_at - interval '15 minutes' WHERE user_id = $1`, [u.id]);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
	});

	it('at the edges: 59 seconds after a send is too soon, 61 is not; an hour’s oldest send 10 seconds short of an hour still counts', async () => {
		const u = await emailEnrolled('MeLimitEdge');
		await asOwner(`UPDATE mfa_email_send SET sent_at = now() - interval '59 seconds' WHERE user_id = $1`, [u.id]);
		const soon = await u.call('POST', '/auth/mfa/email/send');
		expect(soon).toMatchObject({ status: 429, body: { code: 'mfa_email_wait' } });
		expect(soon.body.params.seconds).toBeLessThanOrEqual(2);
		await asOwner(`UPDATE mfa_email_send SET sent_at = now() - interval '61 seconds' WHERE user_id = $1`, [u.id]);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		// Five in the hour, the oldest 59 min 50 s ago: wait about 10 s.
		await asOwner('DELETE FROM mfa_email_send WHERE user_id = $1', [u.id]);
		await asOwner(`INSERT INTO mfa_email_send (user_id, sent_at) SELECT $1, now() - make_interval(secs => s) FROM unnest(ARRAY[3590, 2400, 1800, 1200, 600]) s`, [u.id]);
		const capped = await u.call('POST', '/auth/mfa/email/send');
		expect(capped).toMatchObject({ status: 429, body: { code: 'mfa_email_wait' } });
		expect(capped.body.params.seconds).toBeGreaterThanOrEqual(9);
		expect(capped.body.params.seconds).toBeLessThanOrEqual(11);
		// The oldest past the hour: room for one.
		await asOwner(`UPDATE mfa_email_send SET sent_at = now() - interval '3610 seconds' WHERE user_id = $1 AND sent_at < now() - interval '3500 seconds'`, [u.id]);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
	});

	it('a send the transport refuses answers 503 mfa_email_failed and still counts, so a failing transport can’t be hammered', async () => {
		const u = await emailEnrolled('MeMailDown');
		await pastGap(u.id);
		const before = mailCount(u.email);
		vi.stubEnv('MAIL_TRANSPORT', 'refused-for-the-test');
		expect(await u.call('POST', '/auth/mfa/email/send')).toMatchObject({ status: 503, body: { code: 'mfa_email_failed' } });
		vi.unstubAllEnvs();
		expect(mailCount(u.email)).toBe(before);
		expect(await u.call('POST', '/auth/mfa/email/send')).toMatchObject({ status: 429, body: { code: 'mfa_email_wait' } });
		// Positive control: past the minute, the next send goes, and its code works.
		await pastGap(u.id);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		expect((await anon('POST', '/auth/mfa/step-up', { code: codeIn(u.email) }, u.cookie)).status).toBe(200);
	});

	it('the send log keeps a day: older rows go at the next send, newer stay', async () => {
		const u = await emailEnrolled('MePrune');
		await asOwner('DELETE FROM mfa_email_send WHERE user_id = $1', [u.id]);
		await asOwner(`INSERT INTO mfa_email_send (user_id, sent_at) SELECT $1, now() - i FROM unnest(ARRAY[interval '25 hours', interval '23 hours', interval '2 hours']) i`, [u.id]);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		const kept = await asOwner(`SELECT round(extract(epoch FROM now() - sent_at) / 3600)::int AS h FROM mfa_email_send WHERE user_id = $1 ORDER BY sent_at`, [u.id]);
		expect(kept.map((r) => r.h)).toEqual([23, 2, 0]);
	});

	it('the limits are per account: one account at its cap doesn’t hold another back', async () => {
		const a = await emailEnrolled('MeCapA');
		const b = await emailEnrolled('MeCapB');
		await asOwner(`INSERT INTO mfa_email_send (user_id, sent_at) SELECT $1, now() - make_interval(mins => m) FROM unnest(ARRAY[5, 10, 15, 20]) m`, [a.id]);
		await pastGap(a.id);
		await pastGap(b.id);
		expect((await a.call('POST', '/auth/mfa/email/send')).status).toBe(429);
		expect((await b.call('POST', '/auth/mfa/email/send')).status).toBe(202);
	});

	it('parallel sends queue on the account’s row lock: exactly one goes', async () => {
		const u = await emailEnrolled('MeRace');
		await pastGap(u.id);
		const before = mailCount(u.email);
		const all = await Promise.all(Array.from({ length: 5 }, () => u.call('POST', '/auth/mfa/email/send')));
		expect(all.filter((r) => r.status === 202)).toHaveLength(1);
		expect(all.filter((r) => r.status === 429)).toHaveLength(4);
		expect(mailCount(u.email)).toBe(before + 1);
	});

	it('nothing is sent while codes by email are off', async () => {
		const u = await signUp('MeOff');
		expect(await u.call('POST', '/auth/mfa/email/send')).toMatchObject({ status: 409, body: { code: 'mfa_not_enrolled' } });
	});
});

describe('step-up and the fresh code by email', () => {
	it('an emailed code steps the session up: amr gets otp and otp_at is now', async () => {
		const u = await emailEnrolled('MeStepUp');
		await pastGap(u.id);
		// The password-only session from sign-up.
		expect(claimsOf(u.cookie).amr).toEqual(['pwd']);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		expect(lastMailTo(u.email)!.text).toContain('confirm what you are doing');
		const code = codeIn(u.email);
		expect(await anon('POST', '/auth/mfa/step-up', { code: code === '000000' ? '000001' : '000000' }, u.cookie)).toMatchObject({ status: 400 });
		const before = Date.now();
		const r = await anon('POST', '/auth/mfa/step-up', { code }, u.cookie);
		expect(r.status).toBe(200);
		const claims = claimsOf(cookieOf(r.headers, SESSION_COOKIE)!);
		expect(claims.amr).toEqual(['pwd', 'otp']);
		expect(claims.otp_at as number).toBeGreaterThanOrEqual(before);
	});

	it('an owner with codes by email passes requireStepUp and requireFreshCode; a password-only session doesn’t', async () => {
		const u = await emailEnrolled('MeOwner');
		const projectId = (await u.call('POST', '/projects', { name: 'Email step-up' })).body.project.id;
		vi.stubEnv('MFA_REQUIRED', 'true');
		expect(await u.call('POST', `/projects/${projectId}/api-keys`, { name: 'logger' })).toMatchObject({ status: 403, body: { code: 'mfa_step_up' } });
		// Positive control: the two-step session the emailed code gave.
		expect((await anon('POST', `/projects/${projectId}/api-keys`, { name: 'logger' }, u.twoStep)).status).toBe(201);
		// The fresh code: a code from now passes, one from 11 minutes ago doesn't.
		const fresh = (otpAt: number | null) =>
			requestAuth.run({ userId: u.id, amr: ['pwd', 'otp'], otpAt }, () => withUser(u.id, (db) => requireFreshCode(db)));
		await expect(fresh(Date.now())).resolves.toBeUndefined();
		await expect(fresh(Date.now() - 11 * 60_000)).rejects.toMatchObject({ status: 401, code: 'mfa_fresh_code' });
	});
});

describe('the "enrolled" check knows the emailed factor', () => {
	it('hasConfirmedFactor and stepUpRefusal: confirmed counts, pending doesn’t, none doesn’t', async () => {
		vi.stubEnv('MFA_REQUIRED', 'true');
		const on = await emailEnrolled('MeEnrolledOn');
		const pending = await signUp('MeEnrolledPending');
		expect((await pending.call('POST', '/auth/mfa/email/enrol', { password: 'correct horse' })).status).toBe(202);
		const none = await signUp('MeEnrolledNone');
		const refusal = (id: string, amr: ('pwd' | 'otp')[]) =>
			requestAuth.run({ userId: id, amr, otpAt: null }, () => withUser(id, async (db) => ({ has: await hasConfirmedFactor(db, id), refusal: (await stepUpRefusal(db))?.code ?? null })));
		// Positive control: the confirmed factor is enrolled, and a two-step session passes.
		expect(await refusal(on.id, ['pwd', 'otp'])).toEqual({ has: true, refusal: null });
		expect(await refusal(on.id, ['pwd'])).toEqual({ has: true, refusal: 'mfa_step_up' });
		expect(await refusal(pending.id, ['pwd', 'otp'])).toEqual({ has: false, refusal: 'mfa_required' });
		expect(await refusal(none.id, ['pwd', 'otp'])).toEqual({ has: false, refusal: 'mfa_required' });
	});
});

describe('turning codes by email off, and living beside the app', () => {
	it('needs a code; then the factor and (the last factor) the recovery codes go, and other sessions are signed out', async () => {
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
		const u = await emailEnrolled('MeOffOnly');
		await pastGap(u.id);
		expect(await anon('DELETE', '/auth/mfa/email', { code: 'AAAAA-AAAAA' }, u.twoStep)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		vi.setSystemTime(Date.now() + 1000);
		const off = await anon('DELETE', '/auth/mfa/email', { code: codeIn(u.email) }, u.twoStep);
		expect(off.status).toBe(204);
		const fresh = cookieOf(off.headers, SESSION_COOKIE)!;
		expect(claimsOf(fresh).amr).toEqual(['pwd']);
		for (const old of [u.cookie, u.twoStep]) expect((await anon('GET', '/auth/me', undefined, old)).status).toBe(401);
		expect((await anon('GET', '/auth/me', undefined, fresh)).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM user_email_otp WHERE user_id = $1', [u.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM user_recovery_code WHERE user_id = $1', [u.id])).toEqual([]);
		expect((await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1 ORDER BY id', [u.id])).map((r) => r.kind)).toEqual([
			'mfa.email_enrolled',
			'mfa.email_disabled'
		]);
		expect((await login(u)).body.user).toMatchObject({ id: u.id });
		expect(await anon('DELETE', '/auth/mfa/email', { code: '123456' }, fresh)).toMatchObject({ status: 409, body: { code: 'mfa_not_enrolled' } });
	});

	it('with the app too: one set of recovery codes, both offered at sign-in, and removing one keeps the other and the codes', async () => {
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
		const u = await emailEnrolled('MeBoth');
		const { secret } = (await anon('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' }, u.twoStep)).body;
		vi.setSystemTime(Date.now() + 30_000);
		const confirmed = await anon('POST', '/auth/mfa/totp/confirm', { code: totp(base32Decode(secret)!, Date.now()) }, u.twoStep);
		expect(confirmed.status).toBe(200);
		// Not the first factor: the set made with codes by email stays, and none is shown again.
		expect(confirmed.body.recoveryCodes).toBeNull();
		const twoStep = cookieOf(confirmed.headers, SESSION_COOKIE)!;
		expect((await anon('GET', '/auth/mfa', undefined, twoStep)).body).toMatchObject({ methods: ['totp', 'email'], recoveryCodesLeft: 10 });
		expect((await login(u)).body).toEqual({ mfaRequired: true, methods: ['totp', 'email'] });
		// Off with a code from the app: the app stays, so do the codes, and this browser stays two-step.
		vi.setSystemTime(Date.now() + 30_000);
		const off = await anon('DELETE', '/auth/mfa/email', { code: totp(base32Decode(secret)!, Date.now()) }, twoStep);
		expect(off.status).toBe(204);
		expect(claimsOf(cookieOf(off.headers, SESSION_COOKIE)!).amr).toEqual(['pwd', 'otp']);
		expect(await asOwner('SELECT count(*)::int AS n FROM user_recovery_code WHERE user_id = $1', [u.id])).toEqual([{ n: 10 }]);
		expect((await login(u)).body).toEqual({ mfaRequired: true, methods: ['totp'] });
		// A recovery code still works (it stands in for the app now).
		expect((await anon('POST', '/auth/mfa/verify', { code: u.recoveryCodes[0] }, (await login(u)).challenge)).status).toBe(200);
	});

	it('new recovery codes take an emailed code', async () => {
		const u = await emailEnrolled('MeRegen');
		await pastGap(u.id);
		expect((await u.call('POST', '/auth/mfa/email/send')).status).toBe(202);
		const r = await anon('POST', '/auth/mfa/recovery-codes', { code: codeIn(u.email) }, u.twoStep);
		expect(r.status).toBe(200);
		expect(r.body.recoveryCodes).toHaveLength(10);
	});
});

describe('RLS on the emailed-code tables (206)', () => {
	it('a person reads and writes their own factor row (positive control) and nobody else’s', async () => {
		const victim = await emailEnrolled('MeVictim');
		const other = await signUp('MeOther');
		const read = (id: string) => withUser(id, async (db) => (await db.query('SELECT user_id FROM user_email_otp')).rows.map((r) => r.user_id));
		expect(await read(victim.id)).toEqual([victim.id]);
		expect(await read(other.id)).toEqual([]);
		expect(await withoutUser(async (db) => (await db.query('SELECT 1 FROM user_email_otp')).rowCount)).toBe(0);
		await withUser(other.id, async (db) => {
			expect((await db.query('UPDATE user_email_otp SET confirmed_at = NULL WHERE user_id = $1', [victim.id])).rowCount).toBe(0);
			expect((await db.query('DELETE FROM user_email_otp WHERE user_id = $1', [victim.id])).rowCount).toBe(0);
		});
		await expect(withUser(other.id, (db) => db.query('INSERT INTO user_email_otp (user_id, confirmed_at) VALUES ($1, now())', [victim.id]))).rejects.toMatchObject({
			code: '42501'
		});
		expect(await asOwner('SELECT 1 FROM user_email_otp WHERE user_id = $1 AND confirmed_at IS NOT NULL', [victim.id])).toHaveLength(1);
	});

	it('the code and the send log are closed to everyone, their owner included: only their functions touch them', async () => {
		const u = await emailEnrolled('MeClosed');
		expect(await asOwner('SELECT count(*)::int AS n FROM mfa_email_send WHERE user_id = $1', [u.id])).toEqual([{ n: 1 }]);
		await withUser(u.id, async (db) => {
			expect((await db.query('SELECT 1 FROM mfa_email_code')).rowCount).toBe(0);
			expect((await db.query('SELECT 1 FROM mfa_email_send')).rowCount).toBe(0);
			expect((await db.query('DELETE FROM mfa_email_send WHERE user_id = $1', [u.id])).rowCount).toBe(0);
			expect((await db.query('UPDATE mfa_email_code SET expires_at = now() + interval \'1 day\' WHERE user_id = $1', [u.id])).rowCount).toBe(0);
		});
		// Planting a code of one's choosing (and skipping the send limits) is refused.
		await expect(
			withUser(u.id, (db) =>
				db.query(`INSERT INTO mfa_email_code (user_id, code_hash, purpose, expires_at) VALUES ($1, $2, 'use', now() + interval '1 hour')`, [u.id, Buffer.alloc(32)])
			)
		).rejects.toMatchObject({ code: '42501' });
		expect(await asOwner('SELECT count(*)::int AS n FROM mfa_email_send WHERE user_id = $1', [u.id])).toEqual([{ n: 1 }]);
		// Without a user, the functions refuse.
		for (const sql of [
			`SELECT app_mfa_email_send(decode(repeat('00', 32), 'hex'), 'use', '10 minutes', '1 minute', 5)`,
			`SELECT app_mfa_email_use(decode(repeat('00', 32), 'hex'), 'use')`,
			'SELECT app_mfa_email_void()'
		]) {
			await expect(withoutUser((db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
		}
		// Bad arguments are refused, not stored.
		await expect(withUser(u.id, (db) => db.query(`SELECT app_mfa_email_send(decode('00', 'hex'), 'use', '10 minutes', '1 minute', 5)`))).rejects.toMatchObject({
			code: '22023'
		});
	});

	it('is in the data-subject export: whether it is on, never the code', async () => {
		const u = await emailEnrolled('MeExport');
		const r = await u.call('GET', '/auth/me/export');
		expect(r.status).toBe(200);
		expect(r.body.twoStepEmail).toEqual([{ createdAt: expect.any(String), confirmedAt: expect.any(String), recoveryCodesLeft: 10 }]);
		expect(r.body.securityEvents).toEqual([{ kind: 'mfa.email_enrolled', createdAt: expect.any(String) }]);
		expect(JSON.stringify(r.body)).not.toMatch(/code_?hash|codeHash/i);
	});

	it('goes with the account', async () => {
		const u = await emailEnrolled('MeGone');
		await asOwner('DELETE FROM app_user WHERE id = $1', [u.id]);
		for (const t of ['user_email_otp', 'mfa_email_code', 'mfa_email_send']) expect(await asOwner(`SELECT 1 FROM ${t} WHERE user_id = $1`, [u.id]), t).toEqual([]);
	});
});
