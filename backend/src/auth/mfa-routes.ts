// Two-step sign-in's routes (issue #282; docs/api.md § Two-step sign-in,
// docs/security.md § Two-step sign-in). Mounted under /auth.
//
//   GET    /mfa                  the Account page's status
//   POST   /mfa/totp/enrol       { password } → a new secret and its otpauth URI
//   POST   /mfa/totp/confirm     { code } → recovery codes (shown once); the session now counts as two-step
//   DELETE /mfa/totp             { code } → off (a code from the app, or a recovery code)
//   POST   /mfa/recovery-codes   { code } → a new set, replacing the old (a code from the app)
//   POST   /mfa/verify           { code } + the sign-in challenge cookie → the session (public)
//
// Every code check counts on the account's code throttle first, in its own
// transaction (mfa.ts countCodeAttempt), so parallel guesses queue on its row
// lock and a stolen session guesses no faster than the sign-in page.
import { Hono } from 'hono';
import { z } from 'zod';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { readJson } from '../http/body.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { countAttempt, lockedMessage, toUser, USER_COLS, type UserRow } from './routes.js';
import { verifyPassword } from './password.js';
import { trustedDevice, issueDevice } from './device.js';
import { logLoginFailed, type LoginFailureRoute } from './loginFailed.js';
import {
	clearMfaChallenge,
	issueSession,
	PASSWORD_ONLY,
	readMfaChallenge,
	WITH_CODE
} from './session.js';
import {
	countCodeAttempt,
	isEnrolled,
	mfaStatus,
	recordSecurityEvent,
	removeFactor,
	replaceRecoveryCodes,
	startEnrolment,
	useCode
} from './mfa.js';

const Code = z.object({ code: z.string().trim().min(1).max(40) });
const EnrolBody = z.object({ password: z.string().min(1).max(200) });

export function codeLockedMessage(seconds: number): string {
	const wait = seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`;
	return `too many wrong codes — try again in ${wait}`;
}

const wrongCode = () => ApiError.coded(400, 'mfa_code_wrong', 'that code isn’t right: use the newest code from your authenticator app, or one of your recovery codes');

/**
 * Count one code check for `userId`; throws the 429 when locked. As the
 * account: the throttle function keys on app.current_user_id.
 */
async function throttle(c: { header: (k: string, v: string) => void }, userId: string, route: LoginFailureRoute): Promise<void> {
	const locked = await withUser(userId, countCodeAttempt);
	if (locked > 0) {
		logLoginFailed(route, 'locked');
		c.header('Retry-After', String(locked));
		throw ApiError.coded(429, 'mfa_locked', codeLockedMessage(locked), { seconds: locked });
	}
}

export const mfaRoutes = new Hono<AuthEnv>()
	.get('/mfa', requireUser, async (c) => {
		const status = await withUser(c.get('userId'), (db) => mfaStatus(db, c.get('userId')));
		// Whether this session signed in with a code: the actions that need one (stepUp.ts) check it.
		return c.json({ ...status, sessionVerified: (c.get('amr') ?? []).includes('otp') });
	})
	// Start adding an authenticator. The current password first, through the
	// sign-in lockout like change-password: a stolen session must not be able
	// to put its own authenticator on the account and lock its owner out.
	.post('/mfa/totp/enrol', requireUser, async (c) => {
		const body = EnrolBody.parse(await readJson(c));
		const userId = c.get('userId');
		const { lockedSeconds, row } = await withUser(userId, async (db) => {
			const { rows } = await db.query<{ email: string; password_hash: string; sessions_revoked_at: Date | null }>(
				'SELECT email, password_hash, sessions_revoked_at FROM app_user WHERE id = $1',
				[userId]
			);
			const row = rows[0];
			if (!row) return { lockedSeconds: 0, row: undefined };
			return { lockedSeconds: await countAttempt(db, row.email, trustedDevice(c, row.email, row.sessions_revoked_at)), row };
		});
		if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		if (lockedSeconds > 0) {
			logLoginFailed('/auth/mfa/totp/enrol', 'locked');
			c.header('Retry-After', String(lockedSeconds));
			throw ApiError.coded(429, 'signin_locked', lockedMessage(lockedSeconds), { seconds: lockedSeconds });
		}
		if (!(await verifyPassword(body.password, row.password_hash))) {
			logLoginFailed('/auth/mfa/totp/enrol', 'bad_password');
			throw ApiError.coded(403, 'wrong_current_password', 'your current password is wrong');
		}
		const started = await withUser(userId, async (db) => {
			await db.query('SELECT app_login_succeeded($1)', [row.email]);
			return startEnrolment(db, userId, row.email);
		});
		if (!started) throw ApiError.coded(409, 'mfa_already_enrolled', 'two-step sign-in is already on: turn it off first to set up another authenticator');
		c.header('Cache-Control', 'no-store');
		return c.json(started);
	})
	// The first code from the new authenticator proves it is set up: the
	// factor is confirmed, ten recovery codes are made (shown once, here), and
	// this session counts as signed in with a code from now on.
	.post('/mfa/totp/confirm', requireUser, async (c) => {
		const body = Code.parse(await readJson(c));
		const userId = c.get('userId');
		await throttle(c, userId, '/auth/mfa/totp/confirm');
		const result = await withUser(userId, async (db) => {
			const { rows } = await db.query<{ pending: boolean }>('SELECT confirmed_at IS NULL AS pending FROM user_totp WHERE user_id = $1', [userId]);
			if (!rows[0]?.pending) return { kind: 'none' as const };
			if (!(await useCode(db, userId, body.code, { pending: true }))) return { kind: 'wrong' as const };
			await db.query('UPDATE user_totp SET confirmed_at = now() WHERE user_id = $1 AND confirmed_at IS NULL', [userId]);
			const codes = await replaceRecoveryCodes(db, userId);
			await recordSecurityEvent(db, userId, 'mfa.enrolled');
			await db.query('SELECT app_mfa_succeeded()');
			return { kind: 'ok' as const, codes };
		});
		if (result.kind === 'none') throw ApiError.coded(409, 'mfa_not_started', 'start setting up two-step sign-in first');
		if (result.kind === 'wrong') {
			logLoginFailed('/auth/mfa/totp/confirm', 'bad_code');
			throw wrongCode();
		}
		await issueSession(c, userId, undefined, WITH_CODE);
		c.header('Cache-Control', 'no-store');
		return c.json({ recoveryCodes: result.codes });
	})
	// Turn two-step sign-in off: a code from the app or a recovery code. The
	// authenticator and the codes go; this session counts as password-only.
	.delete('/mfa/totp', requireUser, async (c) => {
		const body = Code.parse(await readJson(c));
		const userId = c.get('userId');
		await throttle(c, userId, '/auth/mfa/totp');
		const result = await withUser(userId, async (db) => {
			if (!(await isEnrolled(db, userId))) return 'none' as const;
			const via = await useCode(db, userId, body.code, { recovery: true });
			if (!via) return 'wrong' as const;
			if (via === 'recovery') await recordSecurityEvent(db, userId, 'mfa.recovery_used');
			await removeFactor(db, userId);
			await recordSecurityEvent(db, userId, 'mfa.disabled');
			await db.query('SELECT app_mfa_succeeded()');
			return 'ok' as const;
		});
		if (result === 'none') throw ApiError.coded(409, 'mfa_not_enrolled', 'two-step sign-in is already off');
		if (result === 'wrong') {
			logLoginFailed('/auth/mfa/totp', 'bad_code');
			throw wrongCode();
		}
		await issueSession(c, userId, undefined, PASSWORD_ONLY);
		return c.body(null, 204);
	})
	// A new set of recovery codes, the old ones void: a code from the app (not a recovery code).
	.post('/mfa/recovery-codes', requireUser, async (c) => {
		const body = Code.parse(await readJson(c));
		const userId = c.get('userId');
		await throttle(c, userId, '/auth/mfa/recovery-codes');
		const result = await withUser(userId, async (db) => {
			if (!(await isEnrolled(db, userId))) return { kind: 'none' as const };
			if (!(await useCode(db, userId, body.code))) return { kind: 'wrong' as const };
			const codes = await replaceRecoveryCodes(db, userId);
			await recordSecurityEvent(db, userId, 'mfa.recovery_regenerated');
			await db.query('SELECT app_mfa_succeeded()');
			return { kind: 'ok' as const, codes };
		});
		if (result.kind === 'none') throw ApiError.coded(409, 'mfa_not_enrolled', 'two-step sign-in is off');
		if (result.kind === 'wrong') {
			logLoginFailed('/auth/mfa/recovery-codes', 'bad_code');
			throw ApiError.coded(400, 'mfa_code_wrong', 'that code isn’t right: use the newest code from your authenticator app');
		}
		c.header('Cache-Control', 'no-store');
		return c.json({ recoveryCodes: result.codes });
	})
	// The sign-in's second step (public: the challenge cookie POST /auth/login
	// set is the credential, and only a right password gets one). A code from
	// the app or a recovery code buys the session; the challenge is used up.
	.post('/mfa/verify', async (c) => {
		const body = Code.parse(await readJson(c));
		const challenge = await readMfaChallenge(c);
		if (!challenge) {
			clearMfaChallenge(c);
			throw ApiError.coded(401, 'mfa_challenge_expired', 'your sign-in timed out: enter your email and password again');
		}
		const userId = challenge.userId;
		await throttle(c, userId, '/auth/mfa/verify');
		const result = await withUser(userId, async (db) => {
			const via = await useCode(db, userId, body.code, { recovery: true });
			if (!via) return null;
			if (via === 'recovery') await recordSecurityEvent(db, userId, 'mfa.recovery_used');
			await db.query('SELECT app_mfa_succeeded()');
			// The challenge is good once (revoked_session, 102).
			await db.query('SELECT app_revoke_session($1, to_timestamp($2))', [challenge.jti, challenge.expiresAt]);
			const { rows } = await db.query<UserRow & { sessions_revoked_at: Date | null }>(
				`SELECT ${USER_COLS}, sessions_revoked_at FROM app_user WHERE id = $1`,
				[userId]
			);
			return rows[0] ? { user: rows[0], via } : null;
		});
		if (!result) {
			logLoginFailed('/auth/mfa/verify', 'bad_code');
			throw wrongCode();
		}
		clearMfaChallenge(c);
		await issueSession(c, userId, undefined, WITH_CODE);
		issueDevice(c, result.user.email, result.user.sessions_revoked_at);
		return c.json({ user: toUser(result.user), ...(result.via === 'recovery' ? { usedRecoveryCode: true } : {}) });
	});
