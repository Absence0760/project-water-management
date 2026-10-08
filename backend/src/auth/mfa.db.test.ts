// Two-step sign-in end to end through the API (issue #282, 150_mfa.sql;
// docs/security.md § Two-step sign-in): adding an authenticator, the
// sign-in's second step, recovery codes, turning it off, the code throttle,
// and RLS on the new tables. Codes are made in the test from the secret the
// API hands out (totp.ts). The clock (Date only: pg and timers are real) is
// moved one 30-second step before each code, so every code is from a fresh
// step and the replay rule never refuses a code the test means to be good.
// The requirement (opt-in per project and team, always for the actions that reach outsiders) is stepUp.db.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
import { anon, asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { MFA_CHALLENGE_COOKIE, SESSION_COOKIE } from './session.js';
import { open } from './secretBox.js';
import { base32Decode, totp } from './totp.js';

type User = Awaited<ReturnType<typeof signUp>>;

beforeAll(() => {
	vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
});
afterAll(() => {
	vi.useRealTimers();
});
afterEach(() => vi.restoreAllMocks());

/** A code from the next time step: never one the account used before. */
function code(secret: string): string {
	vi.setSystemTime(Date.now() + 30_000);
	return totp(base32Decode(secret)!, Date.now());
}

/** `name=value` for each cookie a response sets. */
const cookies = (h: Headers) => Object.fromEntries(h.getSetCookie().map((c) => c.split(';')[0]!.split(/=(.*)/s).slice(0, 2) as [string, string]));
const cookieOf = (h: Headers, name: string) => {
	const v = cookies(h)[name];
	return v ? `${name}=${v}` : undefined;
};

/** Sign up and set up an authenticator: the user, the secret, the recovery codes and the two-step session the confirm gave. */
async function enrolled(name: string) {
	const u = await signUp(name);
	const started = await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' });
	expect(started.status).toBe(200);
	const secret = started.body.secret as string;
	const r = await anon('POST', '/auth/mfa/totp/confirm', { code: code(secret) }, u.cookie);
	expect(r.status).toBe(200);
	return { ...u, secret, recoveryCodes: r.body.recoveryCodes as string[], twoStep: cookieOf(r.headers, SESSION_COOKIE)! };
}

/** POST /auth/login: the answer and the challenge cookie it set, if any. */
async function login(u: { email: string }, password = 'correct horse') {
	const r = await anon('POST', '/auth/login', { email: u.email, password });
	return { ...r, challenge: cookieOf(r.headers, MFA_CHALLENGE_COOKIE), session: cookieOf(r.headers, SESSION_COOKIE) };
}

const amrOf = (cookie: string) => decodeJwt(cookie.split('=')[1]!).amr;

describe('adding an authenticator', () => {
	it('needs the current password, so a stolen session can’t put its own authenticator on the account', async () => {
		const u = await signUp('MfaPw');
		const r = await u.call('POST', '/auth/mfa/totp/enrol', { password: 'wrong horse' });
		expect(r).toMatchObject({ status: 403, body: { code: 'wrong_current_password' } });
		expect(await asOwner('SELECT 1 FROM user_totp WHERE user_id = $1', [u.id])).toEqual([]);
	});

	it('hands out the secret once, sealed at rest, and needs a first code to confirm it', async () => {
		const u = await signUp('MfaEnrol');
		const r = await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' });
		expect(r.status).toBe(200);
		expect(r.body.secret).toMatch(/^[A-Z2-7]{32}$/);
		expect(r.body.uri).toMatch(/^otpauth:\/\/totp\/Water%20Management:/);
		expect(new URL(r.body.uri).searchParams.get('secret')).toBe(r.body.secret);
		// Sealed: the stored bytes don't hold the secret, and open only for this account.
		const [row] = await asOwner('SELECT secret_enc, confirmed_at FROM user_totp WHERE user_id = $1', [u.id]);
		const raw = base32Decode(r.body.secret)!;
		expect(row.confirmed_at).toBeNull();
		expect((row.secret_enc as Buffer).includes(raw)).toBe(false);
		expect(open(row.secret_enc, u.id)).toEqual(raw);
		// Not on yet: GET /auth/mfa says so, and signing in is still one step.
		expect((await u.call('GET', '/auth/mfa')).body).toMatchObject({ enrolled: false, recoveryCodesLeft: 0, sessionVerified: false });
		expect((await login(u)).body.user).toMatchObject({ id: u.id });

		expect(await u.call('POST', '/auth/mfa/totp/confirm', { code: 'AAAAA-AAAAA' })).toMatchObject({
			status: 400,
			body: { code: 'mfa_code_wrong' }
		});
		const ok = await anon('POST', '/auth/mfa/totp/confirm', { code: code(r.body.secret) }, u.cookie);
		expect(ok.status).toBe(200);
		const codes = ok.body.recoveryCodes as string[];
		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		// This browser now counts as two-step; the session from before doesn't.
		const twoStep = cookieOf(ok.headers, SESSION_COOKIE)!;
		expect(amrOf(twoStep)).toEqual(['pwd', 'otp']);
		expect((await anon('GET', '/auth/mfa', undefined, twoStep)).body).toMatchObject({ enrolled: true, recoveryCodesLeft: 10, sessionVerified: true });
		expect((await u.call('GET', '/auth/mfa')).body).toMatchObject({ enrolled: true, sessionVerified: false });
		expect(await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1', [u.id])).toEqual([{ kind: 'mfa.enrolled' }]);
		// Only the hashes are kept.
		const stored = await asOwner('SELECT code_hash FROM user_recovery_code WHERE user_id = $1', [u.id]);
		expect(stored).toHaveLength(10);
		for (const c of codes) expect(stored.some((s) => (s.code_hash as Buffer).includes(Buffer.from(c.replace('-', ''))))).toBe(false);
	});

	it('refuses a second authenticator while one is on, and a confirm with nothing started', async () => {
		const u = await enrolled('MfaTwice');
		expect(await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).toMatchObject({ status: 409, body: { code: 'mfa_already_enrolled' } });
		const fresh = await signUp('MfaNothing');
		expect(await fresh.call('POST', '/auth/mfa/totp/confirm', { code: '123456' })).toMatchObject({ status: 409, body: { code: 'mfa_not_started' } });
	});

	it('starting again before confirming replaces the secret: the old one’s codes stop working', async () => {
		const u = await signUp('MfaRestart');
		const first = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body.secret;
		const second = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body.secret;
		expect(second).not.toBe(first);
		expect((await u.call('POST', '/auth/mfa/totp/confirm', { code: code(first) })).status).toBe(400);
		expect((await u.call('POST', '/auth/mfa/totp/confirm', { code: code(second) })).status).toBe(200);
	});
});

describe('signing in with two steps', () => {
	let u: Awaited<ReturnType<typeof enrolled>>;
	beforeAll(async () => {
		u = await enrolled('MfaLogin');
	});

	it('a right password buys a challenge, not a session, and says nothing more', async () => {
		const r = await login(u);
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ mfaRequired: true });
		expect(r.session).toBeUndefined();
		expect(r.challenge).toBeDefined();
		// The challenge can't stand in for a session, nor a session for a challenge.
		const asSession = `${SESSION_COOKIE}=${r.challenge!.split('=')[1]}`;
		expect((await anon('GET', '/auth/me', undefined, asSession)).status).toBe(401);
		const asChallenge = `${MFA_CHALLENGE_COOKIE}=${u.twoStep.split('=')[1]}`;
		expect(await anon('POST', '/auth/mfa/verify', { code: code(u.secret) }, asChallenge)).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
		// A wrong password still gets nothing.
		expect((await login(u, 'wrong horse')).status).toBe(401);
	});

	it('a code from the app trades the challenge for a two-step session, once', async () => {
		const { challenge } = await login(u);
		expect(await anon('POST', '/auth/mfa/verify', { code: '12345' }, challenge)).toMatchObject({ status: 400 });
		const c = code(u.secret);
		const ok = await anon('POST', '/auth/mfa/verify', { code: c }, challenge);
		expect(ok.status).toBe(200);
		expect(ok.body.user).toMatchObject({ id: u.id, email: u.email });
		const session = cookieOf(ok.headers, SESSION_COOKIE)!;
		expect(amrOf(session)).toEqual(['pwd', 'otp']);
		expect(cookies(ok.headers)).toHaveProperty('wm_device');
		expect((await anon('GET', '/auth/me', undefined, session)).status).toBe(200);
		// The challenge is used up, and the same code can't sign in again (replay).
		expect(await anon('POST', '/auth/mfa/verify', { code: code(u.secret) }, challenge)).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
		const again = await login(u);
		expect(await anon('POST', '/auth/mfa/verify', { code: c }, again.challenge)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
	});

	it('a recovery code works once, and is recorded', async () => {
		const rc = u.recoveryCodes[0]!;
		const first = await anon('POST', '/auth/mfa/verify', { code: rc.toLowerCase() }, (await login(u)).challenge);
		expect(first.status).toBe(200);
		expect(first.body.usedRecoveryCode).toBe(true);
		expect(amrOf(cookieOf(first.headers, SESSION_COOKIE)!)).toEqual(['pwd', 'otp']);
		expect((await anon('GET', '/auth/mfa', undefined, u.twoStep)).body.recoveryCodesLeft).toBe(9);
		expect((await anon('POST', '/auth/mfa/verify', { code: rc }, (await login(u)).challenge)).status).toBe(400);
		expect(await asOwner(`SELECT count(*)::int AS n FROM account_security_event WHERE user_id = $1 AND kind = 'mfa.recovery_used'`, [u.id])).toEqual([{ n: 1 }]);
	});

	it('no challenge, or one from before a password reset, is refused', async () => {
		expect(await anon('POST', '/auth/mfa/verify', { code: '123456' })).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
		const v = await enrolled('MfaReset');
		const { challenge } = await login(v);
		await asOwner(`UPDATE app_user SET sessions_revoked_at = now() + interval '1 hour' WHERE id = $1`, [v.id]);
		expect(await anon('POST', '/auth/mfa/verify', { code: code(v.secret) }, challenge)).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
	});

	it('the 5th wrong code locks the account’s code checks, right codes included, then lets go', async () => {
		const v = await enrolled('MfaLock');
		const { challenge } = await login(v);
		for (let i = 0; i < 5; i++) expect((await anon('POST', '/auth/mfa/verify', { code: 'AAAAA-AAAAA' }, challenge)).status).toBe(400);
		const locked = await anon('POST', '/auth/mfa/verify', { code: code(v.secret) }, challenge);
		expect(locked).toMatchObject({ status: 429, body: { code: 'mfa_locked', params: { seconds: expect.any(Number) } } });
		expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
		// The same lock holds on the signed-in code checks.
		expect(await anon('POST', '/auth/mfa/recovery-codes', { code: code(v.secret) }, v.twoStep)).toMatchObject({ status: 429, body: { code: 'mfa_locked' } });
		// The lock ends (moved in the database, never slept): a right code goes through and clears the count.
		await asOwner(`UPDATE mfa_throttle SET locked_until = now() - interval '1 second' WHERE user_id = $1`, [v.id]);
		expect((await anon('POST', '/auth/mfa/verify', { code: code(v.secret) }, challenge)).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM mfa_throttle WHERE user_id = $1', [v.id])).toEqual([]);
	});

	it('an account without an authenticator still signs in in one step, password-only', async () => {
		const plain = await signUp('MfaNone');
		const r = await login(plain);
		expect(r.body.user).toMatchObject({ id: plain.id });
		expect(amrOf(r.session!)).toEqual(['pwd']);
	});

	it('changing the password keeps the session two-step', async () => {
		const v = await enrolled('MfaChangePw');
		const r = await anon('POST', '/auth/change-password', { currentPassword: 'correct horse', newPassword: 'battery staple' }, v.twoStep);
		expect(r.status).toBe(200);
		expect(amrOf(cookieOf(r.headers, SESSION_COOKIE)!)).toEqual(['pwd', 'otp']);
	});
});

describe('turning it off, and new recovery codes', () => {
	it('turning off needs a right code; then the factor and the codes are gone and sign-in is one step again', async () => {
		const u = await enrolled('MfaOff');
		expect(await anon('DELETE', '/auth/mfa/totp', { code: 'AAAAA-AAAAA' }, u.twoStep)).toMatchObject({ status: 400, body: { code: 'mfa_code_wrong' } });
		expect(await asOwner('SELECT 1 FROM user_totp WHERE user_id = $1', [u.id])).toHaveLength(1);
		// The faked clock stands still between codes: move it on, as real time would, so the sessions above predate the sign-out.
		vi.setSystemTime(Date.now() + 1000);
		const off = await anon('DELETE', '/auth/mfa/totp', { code: u.recoveryCodes[3] }, u.twoStep);
		expect(off.status).toBe(204);
		const fresh = cookieOf(off.headers, SESSION_COOKIE)!;
		expect(amrOf(fresh)).toEqual(['pwd']);
		// Every other session is signed out (none signed in with a code outlives it); this browser's new one works.
		for (const [name, old] of [['password-only', u.cookie], ['two-step', u.twoStep]] as const) expect((await anon('GET', '/auth/me', undefined, old)).status, name).toBe(401);
		expect((await anon('GET', '/auth/me', undefined, fresh)).status).toBe(200);
		expect(cookies(off.headers)).toHaveProperty('wm_device');
		expect(await asOwner('SELECT 1 FROM user_totp WHERE user_id = $1', [u.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM user_recovery_code WHERE user_id = $1', [u.id])).toEqual([]);
		expect((await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1 ORDER BY id', [u.id])).map((r) => r.kind)).toEqual([
			'mfa.enrolled',
			'mfa.recovery_used',
			'mfa.disabled'
		]);
		expect((await login(u)).body.user).toMatchObject({ id: u.id });
		expect(await anon('DELETE', '/auth/mfa/totp', { code: '123456' }, fresh)).toMatchObject({ status: 409, body: { code: 'mfa_not_enrolled' } });
	});

	it('new recovery codes need a code from the app (not a recovery code) and void the old ones', async () => {
		const u = await enrolled('MfaRegen');
		expect(await anon('POST', '/auth/mfa/recovery-codes', { code: u.recoveryCodes[0] }, u.twoStep)).toMatchObject({ status: 400 });
		const r = await anon('POST', '/auth/mfa/recovery-codes', { code: code(u.secret) }, u.twoStep);
		expect(r.status).toBe(200);
		const fresh = r.body.recoveryCodes as string[];
		expect(fresh).toHaveLength(10);
		expect(fresh.some((c) => u.recoveryCodes.includes(c))).toBe(false);
		expect((await anon('POST', '/auth/mfa/verify', { code: u.recoveryCodes[1] }, (await login(u)).challenge)).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/verify', { code: fresh[0] }, (await login(u)).challenge)).status).toBe(200);
		expect(await asOwner(`SELECT count(*)::int AS n FROM account_security_event WHERE user_id = $1 AND kind = 'mfa.recovery_regenerated'`, [u.id])).toEqual([{ n: 1 }]);
	});
});

describe('RLS on the two-step tables (150)', () => {
	let victim: Awaited<ReturnType<typeof enrolled>>;
	let other: User;
	beforeAll(async () => {
		victim = await enrolled('MfaVictim');
		other = await signUp('MfaOther');
		// A count on the throttle for the victim.
		await anon('POST', '/auth/mfa/recovery-codes', { code: 'AAAAA-AAAAA' }, victim.twoStep);
	});

	it('a person reads their own authenticator, codes and events (positive control) and nobody else’s', async () => {
		const read = (id: string) =>
			withUser(id, async (db) => ({
				totp: (await db.query('SELECT user_id FROM user_totp')).rows.map((r) => r.user_id),
				codes: (await db.query('SELECT DISTINCT user_id FROM user_recovery_code')).rows.map((r) => r.user_id),
				events: (await db.query('SELECT DISTINCT user_id FROM account_security_event')).rows.map((r) => r.user_id)
			}));
		expect(await read(victim.id)).toEqual({ totp: [victim.id], codes: [victim.id], events: [victim.id] });
		expect(await read(other.id)).toEqual({ totp: [], codes: [], events: [] });
		expect(await withoutUser(async (db) => (await db.query('SELECT 1 FROM user_totp')).rowCount)).toBe(0);
	});

	it('nobody writes another person’s rows', async () => {
		await withUser(other.id, async (db) => {
			expect((await db.query('UPDATE user_totp SET last_used_step = 0 WHERE user_id = $1', [victim.id])).rowCount).toBe(0);
			expect((await db.query('DELETE FROM user_totp WHERE user_id = $1', [victim.id])).rowCount).toBe(0);
			expect((await db.query('DELETE FROM user_recovery_code WHERE user_id = $1', [victim.id])).rowCount).toBe(0);
		});
		for (const sql of [
			`INSERT INTO user_totp (user_id, secret_enc) VALUES ($1, decode(repeat('00', 49), 'hex'))`,
			`INSERT INTO user_recovery_code (user_id, code_hash) VALUES ($1, decode(repeat('00', 32), 'hex'))`,
			`INSERT INTO account_security_event (user_id, kind) VALUES ($1, 'mfa.disabled')`
		]) {
			await expect(withUser(other.id, (db) => db.query(sql, [victim.id])), sql).rejects.toMatchObject({ code: '42501' });
		}
		expect(await asOwner('SELECT 1 FROM user_totp WHERE user_id = $1', [victim.id])).toHaveLength(1);
		expect(await asOwner('SELECT 1 FROM user_recovery_code WHERE user_id = $1', [victim.id])).toHaveLength(10);
	});

	it('the security log is append-only, even for its owner', async () => {
		for (const sql of ['UPDATE account_security_event SET kind = $2 WHERE user_id = $1', 'DELETE FROM account_security_event WHERE user_id = $1']) {
			await expect(
				withUser(victim.id, (db) => db.query(sql, sql.startsWith('UPDATE') ? [victim.id, 'mfa.enrolled'] : [victim.id])),
				sql
			).rejects.toMatchObject({ code: '42501' });
		}
	});

	it('the code throttle is closed to everyone, its owner included: only its functions touch it', async () => {
		expect(await asOwner('SELECT failures FROM mfa_throttle WHERE user_id = $1', [victim.id])).toEqual([{ failures: 1 }]);
		await withUser(victim.id, async (db) => {
			expect((await db.query('SELECT 1 FROM mfa_throttle')).rowCount).toBe(0);
			expect((await db.query('DELETE FROM mfa_throttle WHERE user_id = $1', [victim.id])).rowCount).toBe(0);
		});
		expect(await asOwner('SELECT failures FROM mfa_throttle WHERE user_id = $1', [victim.id])).toEqual([{ failures: 1 }]);
		// Without a user, the functions refuse.
		await expect(withoutUser((db) => db.query(`SELECT app_mfa_attempt(5, '1 minute', '15 minutes')`))).rejects.toMatchObject({ code: '42501' });
		await expect(withoutUser((db) => db.query('SELECT app_mfa_succeeded()'))).rejects.toMatchObject({ code: '42501' });
	});
});
