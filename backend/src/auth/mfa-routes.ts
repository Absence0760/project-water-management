// Two-step sign-in's routes (issue #282; docs/api.md § Two-step sign-in,
// docs/security.md § Two-step sign-in). Mounted under /auth.
//
//   GET    /mfa                  the Account page's status
//   POST   /mfa/totp/enrol       { password } → a new secret and its otpauth URI
//   POST   /mfa/totp/confirm     { code } → recovery codes (shown once); the session now counts as two-step
//   DELETE /mfa/totp             { code } → off (a code from the app, or a recovery code)
//   POST   /mfa/recovery-codes   { code } → a new set, replacing the old (a code from the app)
//   POST   /mfa/verify           { code } + the sign-in challenge cookie → the session (public)
//   POST   /mfa/step-up          { code } → this session counts as having just given a code (stepUp.ts requireFreshCode)
//
// Codes by email (206_mfa_email_code, beside or instead of the app):
//   POST   /mfa/email/enrol      { password } → a code to the account's address, to confirm
//   POST   /mfa/email/confirm    { code } → on; recovery codes if it is the first factor; the session counts as two-step
//   DELETE /mfa/email            { code } → off (a code from either factor, or a recovery code)
//   POST   /mfa/email/send       → a code by email, signed in: to finish turning it on, or for step-up and the actions above
//   POST   /mfa/challenge/email  + the sign-in challenge cookie → a code by email for the sign-in step (public)
// Every send is limited (a minute apart, five an hour, auth/emailCode.ts), and the
// emailed code is checked by the same routes and throttle as the app's.
//
// Every code check counts on the account's code throttle first, in its own
// transaction (mfa.ts countCodeAttempt), so parallel guesses queue on its row
// lock and a stolen session guesses no faster than the sign-in page.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { readJson } from '../http/body.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { countAttempt, lockedMessage, rehashFor, storeRehash, toUser, USER_COLS, type UserRow } from './routes.js';
import { verifyPassword } from './password.js';
import { mfaRequired } from './stepUp.js';
import { trySendMail } from '../mail/transport.js';
import { mfaCodeMail, type MfaCodeReason } from '../mail/templates.js';
import { EMAIL_CODE_SEND, EMAIL_CODE_TTL_SECONDS, normaliseEmailCode, type EmailCodePurpose } from './emailCode.js';
import type { Db } from '../db/tx.js';
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
	confirmedMethods,
	countCodeAttempt,
	isEnrolled,
	mfaStatus,
	newEmailCodeFor,
	recordSecurityEvent,
	removeFactor,
	replaceRecoveryCodes,
	spendEmailCode,
	startEnrolment,
	useCode,
	type MfaMethod
} from './mfa.js';
import { cancelOwnReset } from './mfaReset.js';

const Code = z.object({ code: z.string().trim().min(1).max(40) });
const EnrolBody = z.object({ password: z.string().min(1).max(200) });

export function codeLockedMessage(seconds: number): string {
	const wait = seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`;
	return `too many wrong codes — try again in ${wait}`;
}

const wrongCode = () =>
	ApiError.coded(400, 'mfa_code_wrong', 'that code isn’t right: use the newest code from your authenticator app or your email, or one of your recovery codes');

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

/**
 * The current password, through the sign-in lockout like change-password (a
 * stolen session must not be able to put its own factor on the account and
 * lock its owner out). Upgrades a legacy hash while it is in hand. Returns
 * the account's address and language.
 */
async function checkPassword(
	c: Context<AuthEnv>,
	userId: string,
	typed: string,
	route: LoginFailureRoute
): Promise<{ email: string; locale: string | null; verified: boolean }> {
	const { lockedSeconds, row } = await withUser(userId, async (db) => {
		const { rows } = await db.query<{ email: string; locale: string | null; verified: boolean; password_hash: string; sessions_revoked_at: Date | null }>(
			'SELECT email, locale, email_verified_at IS NOT NULL AS verified, password_hash, sessions_revoked_at FROM app_user WHERE id = $1',
			[userId]
		);
		const row = rows[0];
		if (!row) return { lockedSeconds: 0, row: undefined };
		return { lockedSeconds: await countAttempt(db, row.email, trustedDevice(c, row.email, row.sessions_revoked_at)), row };
	});
	if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
	if (lockedSeconds > 0) {
		logLoginFailed(route, 'locked');
		c.header('Retry-After', String(lockedSeconds));
		throw ApiError.coded(429, 'signin_locked', lockedMessage(lockedSeconds), { seconds: lockedSeconds });
	}
	if (!(await verifyPassword(typed, row.password_hash))) {
		logLoginFailed(route, 'bad_password');
		throw ApiError.coded(403, 'wrong_current_password', 'your current password is wrong');
	}
	// A legacy bcrypt hash is upgraded here too, while the password is in hand (auth/routes.ts storeRehash).
	const upgraded = await rehashFor(typed, row.password_hash);
	await withUser(userId, async (db) => {
		await db.query('SELECT app_login_succeeded($1)', [row.email]);
		await storeRehash(db, userId, row.password_hash, upgraded);
	});
	return { email: row.email, locale: row.locale, verified: row.verified };
}

/** What a send answers: when the next may go, and how long this code works. */
const sentAnswer = () => ({ resendInSeconds: EMAIL_CODE_SEND.gapSeconds, expiresInSeconds: EMAIL_CODE_TTL_SECONDS });

/**
 * Email `userId` a new code for `purpose` (as the account, in its language):
 * 429 mfa_email_wait (params.seconds, Retry-After) while a send limit holds,
 * 503 mfa_email_failed when the mail didn't go (the send still counts, so a
 * failing transport can't be hammered). `check` runs first in the same
 * transaction and may refuse (the factor's state).
 */
async function emailCode(
	c: { header: (k: string, v: string) => void },
	userId: string,
	purpose: EmailCodePurpose,
	reason: MfaCodeReason,
	check?: (db: Db) => Promise<void>
): Promise<void> {
	const out = await withUser(userId, async (db) => {
		await check?.(db);
		const { rows } = await db.query<{ email: string; locale: string | null; verified: boolean }>(
			'SELECT email, locale, email_verified_at IS NOT NULL AS verified FROM app_user WHERE id = $1',
			[userId]
		);
		const row = rows[0];
		if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		// Only to an address the person proved (sign-in already needs it; this is the route's own check).
		if (!row.verified) throw ApiError.coded(403, 'email_unconfirmed', 'confirm your email address first: open the link we emailed you');
		return { ...row, sent: await newEmailCodeFor(db, userId, purpose) };
	});
	if ('waitSeconds' in out.sent) {
		c.header('Retry-After', String(out.sent.waitSeconds));
		throw ApiError.coded(429, 'mfa_email_wait', `we just emailed you a code: wait ${out.sent.waitSeconds} s before asking for another`, {
			seconds: out.sent.waitSeconds
		});
	}
	if (!(await trySendMail(mfaCodeMail(out.email, out.sent.code, reason, out.locale)))) {
		throw ApiError.coded(503, 'mfa_email_failed', 'we couldn’t send the email: try again in a minute');
	}
}

const emailNotOn = () => ApiError.coded(409, 'mfa_not_enrolled', 'codes by email are off');

/** Refuses unless emailed codes are on for `userId` (as the account). */
async function requireEmailFactor(db: Db, userId: string): Promise<void> {
	if (!(await confirmedMethods(db, userId)).includes('email')) throw emailNotOn();
}

export const mfaRoutes = new Hono<AuthEnv>()
	.get('/mfa', requireUser, async (c) => {
		const status = await withUser(c.get('userId'), (db) => mfaStatus(db, c.get('userId')));
		// Whether this session signed in with a code: the actions that need one (stepUp.ts) check it.
		// `required` only while the requirement is on (MFA_REQUIRED, off for the DB tests, the e2e server
		// and a dev's opt-out): the Account page's warning and the workspace's banner say what the routes do.
		return c.json({ ...status, required: status.required && mfaRequired(), sessionVerified: (c.get('amr') ?? []).includes('otp') });
	})
	// Start adding an authenticator. The current password first, through the
	// sign-in lockout like change-password: a stolen session must not be able
	// to put its own authenticator on the account and lock its owner out.
	.post('/mfa/totp/enrol', requireUser, async (c) => {
		const body = EnrolBody.parse(await readJson(c));
		const userId = c.get('userId');
		const { email } = await checkPassword(c, userId, body.password, '/auth/mfa/totp/enrol');
		const started = await withUser(userId, (db) => startEnrolment(db, userId, email));
		if (!started) throw ApiError.coded(409, 'mfa_already_enrolled', 'an authenticator app is already on: turn it off first to set up another');
		c.header('Cache-Control', 'no-store');
		return c.json(started);
	})
	// The first code from the new authenticator proves it is set up: the
	// factor is confirmed, ten recovery codes are made if it is the account's
	// first factor (shown once, here; with codes by email already on, the
	// existing set stays and `recoveryCodes` is null), and this session counts
	// as signed in with a code from now on.
	.post('/mfa/totp/confirm', requireUser, async (c) => {
		const body = Code.parse(await readJson(c));
		const userId = c.get('userId');
		await throttle(c, userId, '/auth/mfa/totp/confirm');
		const result = await withUser(userId, async (db) => {
			const { rows } = await db.query<{ pending: boolean }>('SELECT confirmed_at IS NULL AS pending FROM user_totp WHERE user_id = $1', [userId]);
			if (!rows[0]?.pending) return { kind: 'none' as const };
			if (!(await useCode(db, userId, body.code, { pending: true }))) return { kind: 'wrong' as const };
			const first = !(await isEnrolled(db, userId));
			await db.query('UPDATE user_totp SET confirmed_at = now() WHERE user_id = $1 AND confirmed_at IS NULL', [userId]);
			const codes = first ? await replaceRecoveryCodes(db, userId) : null;
			await recordSecurityEvent(db, userId, 'mfa.enrolled');
			await db.query('SELECT app_mfa_succeeded()');
			return { kind: 'ok' as const, codes };
		});
		if (result.kind === 'none') throw ApiError.coded(409, 'mfa_not_started', 'start setting up two-step sign-in first');
		if (result.kind === 'wrong') {
			logLoginFailed('/auth/mfa/totp/confirm', 'bad_code');
			throw wrongCode();
		}
		await issueSession(c, userId, undefined, WITH_CODE, Date.now());
		c.header('Cache-Control', 'no-store');
		return c.json({ recoveryCodes: result.codes });
	})
	// Remove the authenticator: a code (from the app, by email, or a recovery code).
	.delete('/mfa/totp', requireUser, (c) => removeRoute(c, 'totp'))
	// Turn codes by email on: the current password (as for the app), then a
	// code to the account's address, which …/email/confirm takes back. Starting
	// again before confirming replaces the pending one and sends a new code.
	.post('/mfa/email/enrol', requireUser, async (c) => {
		const body = EnrolBody.parse(await readJson(c));
		const userId = c.get('userId');
		await checkPassword(c, userId, body.password, '/auth/mfa/email/enrol');
		await emailCode(c, userId, 'enrol', 'enrol', async (db) => {
			const { rowCount } = await db.query(
				`INSERT INTO user_email_otp (user_id) VALUES ($1)
				 ON CONFLICT (user_id) DO UPDATE SET created_at = now() WHERE user_email_otp.confirmed_at IS NULL`,
				[userId]
			);
			if (!rowCount) throw ApiError.coded(409, 'mfa_already_enrolled', 'codes by email are already on');
		});
		return c.json(sentAnswer(), 202);
	})
	// The emailed code back: the address is proven, the factor is on, recovery
	// codes are made if it is the account's first factor (else null, the set
	// stays), and this session counts as signed in with a code.
	.post('/mfa/email/confirm', requireUser, async (c) => {
		const body = Code.parse(await readJson(c));
		const userId = c.get('userId');
		await throttle(c, userId, '/auth/mfa/email/confirm');
		const result = await withUser(userId, async (db) => {
			const { rows } = await db.query<{ pending: boolean }>('SELECT confirmed_at IS NULL AS pending FROM user_email_otp WHERE user_id = $1', [userId]);
			if (!rows[0]?.pending) return { kind: 'none' as const };
			const six = normaliseEmailCode(body.code);
			if (!six || !(await spendEmailCode(db, userId, 'enrol', six))) return { kind: 'wrong' as const };
			const first = !(await isEnrolled(db, userId));
			await db.query('UPDATE user_email_otp SET confirmed_at = now() WHERE user_id = $1 AND confirmed_at IS NULL', [userId]);
			const codes = first ? await replaceRecoveryCodes(db, userId) : null;
			await recordSecurityEvent(db, userId, 'mfa.email_enrolled');
			await db.query('SELECT app_mfa_succeeded()');
			return { kind: 'ok' as const, codes };
		});
		if (result.kind === 'none') throw ApiError.coded(409, 'mfa_not_started', 'start turning on codes by email first');
		if (result.kind === 'wrong') {
			logLoginFailed('/auth/mfa/email/confirm', 'bad_code');
			throw wrongCode();
		}
		await issueSession(c, userId, undefined, WITH_CODE, Date.now());
		c.header('Cache-Control', 'no-store');
		return c.json({ recoveryCodes: result.codes });
	})
	// Turn codes by email off: a code (by email, from the app, or a recovery code).
	.delete('/mfa/email', requireUser, (c) => removeRoute(c, 'email'))
	// A code by email inside a session: to finish turning codes by email on
	// (while one is pending, a code for that), or, once on, for the step-up and
	// for turning a factor off or making new recovery codes. Not for a render session.
	.post('/mfa/email/send', requireUser, async (c) => {
		if (c.get('renderSession')) throw new ApiError(403, 'this session can only read one report');
		const userId = c.get('userId');
		const state = await withUser(userId, async (db) => {
			const { rows } = await db.query<{ confirmed: boolean }>('SELECT confirmed_at IS NOT NULL AS confirmed FROM user_email_otp WHERE user_id = $1', [userId]);
			return rows[0] ? (rows[0].confirmed ? ('on' as const) : ('pending' as const)) : null;
		});
		if (!state) throw emailNotOn();
		await emailCode(
			c,
			userId,
			state === 'pending' ? 'enrol' : 'use',
			state === 'pending' ? 'enrol' : 'confirm',
			// The state again, inside the send's transaction: turned off meanwhile, nothing goes.
			async (db) => {
				const { rows } = await db.query<{ confirmed: boolean }>('SELECT confirmed_at IS NOT NULL AS confirmed FROM user_email_otp WHERE user_id = $1', [userId]);
				if (!rows[0] || rows[0].confirmed !== (state === 'on')) throw emailNotOn();
			}
		);
		return c.json(sentAnswer(), 202);
	})
	// The sign-in's second step by email (public: the challenge cookie POST
	// /auth/login set is the credential, and only a right password gets one).
	// Sends the code; …/mfa/verify takes it. The challenge isn't used up here.
	.post('/mfa/challenge/email', async (c) => {
		const challenge = await readMfaChallenge(c);
		if (!challenge) {
			clearMfaChallenge(c);
			throw ApiError.coded(401, 'mfa_challenge_expired', 'your sign-in timed out: enter your email and password again');
		}
		await emailCode(c, challenge.userId, 'use', 'sign-in', (db) => requireEmailFactor(db, challenge.userId));
		return c.json(sentAnswer(), 202);
	})
	// A new set of recovery codes, the old ones void: a code from the app or by email (not a recovery code).
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
			// A right code: the owner has their factor, so a waiting reset ends, as at every code check (205).
			await cancelOwnReset(db);
			return { kind: 'ok' as const, codes };
		});
		if (result.kind === 'none') throw ApiError.coded(409, 'mfa_not_enrolled', 'two-step sign-in is off');
		if (result.kind === 'wrong') {
			logLoginFailed('/auth/mfa/recovery-codes', 'bad_code');
			throw ApiError.coded(400, 'mfa_code_wrong', 'that code isn’t right: use the newest code from your authenticator app or your email');
		}
		c.header('Cache-Control', 'no-store');
		return c.json({ recoveryCodes: result.codes });
	})
	// The sign-in's second step (public: the challenge cookie POST /auth/login
	// set is the credential, and only a right password gets one). A code from
	// the app, the emailed code, or a recovery code buys the session; the
	// challenge is used up.
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
			// The owner has their factor: a waiting reset of it ends (auth/mfaReset.ts).
			await cancelOwnReset(db);
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
		await issueSession(c, userId, undefined, WITH_CODE, Date.now());
		issueDevice(c, result.user.email, result.user.sessions_revoked_at);
		return c.json({ user: toUser(result.user), ...(result.via === 'recovery' ? { usedRecoveryCode: true } : {}) });
	})
	// A code again, inside a session (licensing positions item 9): a sign-off and issuing or withdrawing an
	// evidence pack need one from the last 10 minutes (stepUp.ts requireFreshCode, 401 mfa_fresh_code). A code
	// from the app, the emailed code (POST /mfa/email/send) or a recovery code; the session is re-issued as signed
	// in with a code, just now, so a session that signed in with the password only (a factor added elsewhere) is
	// stepped up too. Same throttle as every code check.
	.post('/mfa/step-up', requireUser, async (c) => {
		if (c.get('renderSession')) throw new ApiError(403, 'this session can only read one report');
		const body = Code.parse(await readJson(c));
		const userId = c.get('userId');
		await throttle(c, userId, '/auth/mfa/step-up');
		const result = await withUser(userId, async (db) => {
			if (!(await isEnrolled(db, userId))) return 'none' as const;
			const via = await useCode(db, userId, body.code, { recovery: true });
			if (!via) return 'wrong' as const;
			if (via === 'recovery') await recordSecurityEvent(db, userId, 'mfa.recovery_used');
			await db.query('SELECT app_mfa_succeeded()');
			await cancelOwnReset(db);
			return via;
		});
		if (result === 'none') throw ApiError.coded(403, 'mfa_required', 'this needs two-step sign-in: set it up on your Account page first');
		if (result === 'wrong') {
			logLoginFailed('/auth/mfa/step-up', 'bad_code');
			throw wrongCode();
		}
		await issueSession(c, userId, undefined, WITH_CODE, Date.now());
		c.header('Cache-Control', 'no-store');
		return c.json({ ok: true, ...(result === 'recovery' ? { usedRecoveryCode: true } : {}) });
	});

/**
 * Turn one factor off (DELETE /mfa/totp, DELETE /mfa/email): a code from any
 * factor still on, or a recovery code. The right code ends a waiting reset
 * (205), as any right code does: the owner has a factor. The factor goes
 * (mfa.ts removeFactor: with the last one, the recovery codes too), and every
 * other session is signed out (the watermark), so none signed in with it
 * outlives it and counts as two-step again after a later re-enrolment. This
 * browser gets a fresh session and device cookie: two-step while another
 * factor is still on (the person just gave a code), else password-only.
 */
async function removeRoute(c: Context<AuthEnv>, method: MfaMethod) {
	const body = Code.parse(await readJson(c));
	const userId = c.get('userId');
	const route = method === 'totp' ? '/auth/mfa/totp' : '/auth/mfa/email';
	await throttle(c, userId, route);
	// This server's clock, the one that stamps session iat_ms (as change-password).
	const watermark = new Date();
	const result = await withUser(userId, async (db) => {
		if (!(await confirmedMethods(db, userId)).includes(method)) return { kind: 'none' as const };
		const via = await useCode(db, userId, body.code, { recovery: true });
		if (!via) return { kind: 'wrong' as const };
		if (via === 'recovery') await recordSecurityEvent(db, userId, 'mfa.recovery_used');
		await db.query('SELECT app_mfa_succeeded()');
		await cancelOwnReset(db);
		const left = await removeFactor(db, method, watermark);
		await recordSecurityEvent(db, userId, method === 'totp' ? 'mfa.disabled' : 'mfa.email_disabled');
		const { rows } = await db.query<{ email: string; sessions_revoked_at: Date | null }>(
			'SELECT email, sessions_revoked_at FROM app_user WHERE id = $1',
			[userId]
		);
		return { kind: 'ok' as const, left, email: rows[0]!.email, watermark: rows[0]!.sessions_revoked_at };
	});
	if (result.kind === 'none') throw ApiError.coded(409, 'mfa_not_enrolled', method === 'totp' ? 'no authenticator app is on' : 'codes by email are off');
	if (result.kind === 'wrong') {
		logLoginFailed(route, 'bad_code');
		throw wrongCode();
	}
	// Issued after the watermark: this browser stays signed in, and trusted.
	if (result.left) await issueSession(c, userId, undefined, WITH_CODE, Date.now());
	else await issueSession(c, userId, undefined, PASSWORD_ONLY);
	issueDevice(c, result.email, result.watermark);
	return c.body(null, 204);
}
