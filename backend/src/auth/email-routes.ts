// Email-driven account flows: password reset, email verification, and the
// public invite lookup for the sign-up page. Mounted under /auth next to
// routes.ts. Security notes: docs/security.md § "Password reset and email
// verification".
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { actAsUser, withoutUser, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { resetPasswordMail, siteLink, verifyEmailMail } from '../mail/templates.js';
import { trySendMail, type Mail } from '../mail/transport.js';
import { answerAlike } from './accountMail.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { hashPassword } from './password.js';
import { clearSession } from './session.js';
import { issueDevice, trustedDevice } from './device.js';
import { ACCOUNT_MAIL_CAP, ACCOUNT_MAIL_WINDOW, newToken, parseToken, RESEND_COOLDOWN, TOKEN_TTL } from './tokens.js';
import { readJson } from '../http/body.js';
import { logLoginFailed, type LoginFailureRoute } from './loginFailed.js';

const email = z.string().trim().toLowerCase().email().max(254);
const token = z.string().max(200);
const password = z.string().min(8).max(200);

const INVALID_LINK = 'this link is invalid or has expired — request a new one';

/** Refuse a reset or verification token, logging the failure (auth/loginFailed.ts). */
function invalidLink(route: LoginFailureRoute): ApiError {
	logLoginFailed(route, 'invalid_link');
	return ApiError.coded(400, 'link_invalid', INVALID_LINK);
}

/** Why no token was issued: inside the cooldown, or the address's daily cap (078) is used up. */
export type EmailTokenRefusal = 'cooldown' | 'capped';

/**
 * Issue a verify/reset token for a user, unless one went out within the
 * cooldown or the daily cap is used up (078). `device` is the id of a valid
 * `wm_device` cookie for the address (trustedDevice), whose own allowance the
 * email then counts on, or null for the address's shared count. Returns the
 * raw token to mail, or why none was issued.
 */
export async function issueEmailToken(
	db: Db,
	userId: string,
	purpose: 'verify' | 'reset',
	device: string | null = null
): Promise<{ token: string } | { refused: EmailTokenRefusal }> {
	const { token: raw, hash } = newToken();
	const { rows } = await db.query<{ status: 'issued' | EmailTokenRefusal }>(
		'SELECT app_issue_email_token($1, $2, $3, $4::interval, $5::interval, $6, $7, $8::interval) AS status',
		[userId, purpose, hash, TOKEN_TTL[purpose], RESEND_COOLDOWN[purpose], device, ACCOUNT_MAIL_CAP, ACCOUNT_MAIL_WINDOW]
	);
	const status = rows[0]!.status;
	return status === 'issued' ? { token: raw } : { refused: status };
}

/**
 * The trusted device of this request for the account (a valid `wm_device`
 * cookie for its address under its current watermark), or null.
 */
async function requestDevice(c: Context, db: Db, userId: string, email: string): Promise<string | null> {
	const { rows } = await db.query<{ sessions_revoked_at: Date | null }>(
		'SELECT sessions_revoked_at FROM app_session_revoked_at($1)',
		[userId]
	);
	return trustedDevice(c, email, rows[0]?.sessions_revoked_at ?? null);
}

/**
 * Mark the address verified and, when this is what verifies it, turn its
 * pending invites into memberships: the invites mailed to an address with no
 * account, or an unconfirmed one, said that confirming it accepts them. An
 * address verified already (a password reset on a confirmed account) accepts
 * nothing: its invites wait for its holder on the invitations page (issue #136).
 */
export async function markVerified(db: Db, userId: string): Promise<void> {
	const { rowCount } = await db.query('UPDATE app_user SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL', [userId]);
	if (rowCount) await db.query('SELECT app_accept_invites($1)', [userId]);
}

/**
 * Issue a verification token and build its email, or say why none was
 * issued. The caller sends it after the transaction commits, so a mailed
 * link always refers to a stored token.
 */
export async function verificationMail(
	db: Db,
	userId: string,
	to: string,
	device: string | null = null
): Promise<{ mail: Mail } | { refused: EmailTokenRefusal }> {
	const issued = await issueEmailToken(db, userId, 'verify', device);
	if ('refused' in issued) return issued;
	// In the person's language (app_user.locale, 050); English when unset.
	const { rows } = await db.query<{ locale: string | null }>('SELECT locale FROM app_user WHERE id = $1', [userId]);
	return { mail: verifyEmailMail(to, siteLink('/verify-email', issued.token), rows[0]?.locale) };
}

export const emailAuthRoutes = new Hono<AuthEnv>()
	// Always 202 with the same body, after the same time, whether or not the
	// address has an account, so the endpoint can't be used to discover
	// accounts (answerAlike, auth/accountMail.ts), and whether or not a
	// limit held the email back. Throttled per address through the token table
	// (one mail per cooldown window) and the daily cap (078), on which a
	// browser trusted for the address counts on its own allowance.
	.post('/forgot-password', async (c) => {
		const body = z.object({ email }).parse(await readJson(c));
		// The same time for a known and an unknown address too: the send isn't awaited (auth/accountMail.ts).
		await answerAlike(() =>
			withoutUser(async (db) => {
				// app_user is under RLS (068) and nobody is signed in: the one-address lookup.
				const { rows } = await db.query<{ id: string; email: string; locale: string | null }>(
					'SELECT id, email, locale FROM app_auth_account($1)',
					[body.email]
				);
				const user = rows[0];
				if (!user) return null;
				const issued = await issueEmailToken(db, user.id, 'reset', await requestDevice(c, db, user.id, user.email));
				return 'token' in issued ? resetPasswordMail(user.email, siteLink('/reset-password', issued.token), user.locale) : null;
			})
		);
		return c.json({ ok: true }, 202);
	})
	// Sets a new password, marks the address verified (the link proved the
	// inbox), and revokes every existing session — including a thief's.
	.post('/reset-password', async (c) => {
		const body = z.object({ token, password }).parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw invalidLink('/auth/reset-password');
		const newHash = await hashPassword(body.password);
		const watermark = new Date();
		const email = await withoutUser(async (db) => {
			const { rows } = await db.query<{ user_id: string | null }>(
				"SELECT app_consume_email_token($1, 'reset') AS user_id",
				[hash]
			);
			const userId = rows[0]?.user_id;
			if (!userId) return null;
			// The link proved the account: the rest runs as it (068, own-row policies).
			await actAsUser(db, userId);
			// Watermark from this server's clock, the same clock that stamps
			// session iat, so a sign-in right after this is never mistaken as older.
			const { rows: updated } = await db.query<{ email: string }>(
				'UPDATE app_user SET password_hash = $2, sessions_revoked_at = $3 WHERE id = $1 RETURNING email',
				[userId, newHash, watermark]
			);
			// No other reset link is outstanding: app_issue_email_token keeps one
			// per purpose and consuming it just deleted it. The address's sign-in
			// lockout is lifted (the link proved the inbox).
			await db.query('SELECT app_login_succeeded(email) FROM app_user WHERE id = $1', [userId]);
			await markVerified(db, userId);
			return updated[0]?.email ?? null;
		});
		if (!email) throw invalidLink('/auth/reset-password');
		clearSession(c);
		// The link proved the inbox: this browser signs in on its own lockout
		// record from now on (auth/device.ts), so whoever keeps the address's
		// shared record locked can't keep its owner out.
		issueDevice(c, email, watermark);
		return c.body(null, 204);
	})
	.post('/verify-email', async (c) => {
		const body = z.object({ token }).parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw invalidLink('/auth/verify-email');
		const account = await withoutUser(async (db) => {
			const { rows } = await db.query<{ user_id: string | null }>(
				"SELECT app_consume_email_token($1, 'verify') AS user_id",
				[hash]
			);
			const userId = rows[0]?.user_id;
			if (!userId) return null;
			await actAsUser(db, userId);
			await markVerified(db, userId);
			const { rows: me } = await db.query<{ email: string; sessions_revoked_at: Date | null }>(
				'SELECT email, sessions_revoked_at FROM app_user WHERE id = $1',
				[userId]
			);
			return me[0] ?? null;
		});
		if (!account) throw invalidLink('/auth/verify-email');
		// The link proved the inbox: this browser signs in on its own lockout
		// record (auth/device.ts), as after a password reset, so whoever keeps
		// the address's shared record locked can't keep a new account out.
		issueDevice(c, account.email, account.sessions_revoked_at);
		// The address the link confirmed (its holder has the inbox): the page
		// tells it from the account this browser is signed in to, if another.
		return c.json({ verified: true, email: account.email });
	})
	.post('/resend-verification', requireUser, async (c) => {
		const mail = await withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<{ email: string; verified: boolean }>(
				'SELECT email, email_verified_at IS NOT NULL AS verified FROM app_user WHERE id = $1',
				[c.get('userId')]
			);
			const user = rows[0];
			if (!user) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
			if (user.verified) throw ApiError.coded(409, 'already_verified', 'your email address is already verified');
			return verificationMail(db, c.get('userId'), user.email, await requestDevice(c, db, c.get('userId'), user.email));
		});
		if ('refused' in mail) {
			if (mail.refused === 'capped')
				throw ApiError.coded(429, 'verification_limit', 'too many confirmation emails were sent to this address today — check your inbox, or try again tomorrow');
			throw ApiError.coded(429, 'verification_sent_recently', 'a confirmation email was sent a moment ago — check your inbox, or try again in a minute');
		}
		await trySendMail(mail.mail);
		return c.json({ sent: true }, 202);
	})
	// What an invite link is for, so the sign-up page can say "Ann invited you
	// to …" and prefill the address. The 256-bit token is the credential.
	.post('/invite-info', async (c) => {
		const body = z.object({ token }).parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw ApiError.coded(404, 'invite_invalid', 'this invitation is invalid or has expired');
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<{
				email: string;
				project_name: string | null;
				team_name: string | null;
				inviter_name: string;
			}>('SELECT * FROM app_invite_for_token($1)', [hash]);
			return rows[0];
		});
		if (!row) throw ApiError.coded(404, 'invite_invalid', 'this invitation is invalid or has expired');
		return c.json({
			invite: { email: row.email, projectName: row.project_name, teamName: row.team_name, invitedBy: row.inviter_name }
		});
	});
