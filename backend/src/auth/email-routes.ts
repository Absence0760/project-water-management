// Email-driven account flows: password reset, email verification, and the
// public invite lookup for the sign-up page. Mounted under /auth next to
// routes.ts. Security notes: docs/security.md § "Password reset and email
// verification".
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { withoutUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { resetPasswordMail, siteLink, verifyEmailMail } from '../mail/templates.js';
import { trySendMail, type Mail } from '../mail/transport.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { hashPassword } from './password.js';
import { clearSession } from './session.js';
import { newToken, parseToken, RESEND_COOLDOWN, TOKEN_TTL } from './tokens.js';

const email = z.string().trim().toLowerCase().email().max(254);
const token = z.string().max(200);
const password = z.string().min(8).max(200);

const INVALID_LINK = 'this link is invalid or has expired — request a new one';

/**
 * Issue a verify/reset token for a user, unless one went out within the
 * cooldown. Returns the raw token to mail, or null when throttled.
 */
async function issueToken(db: Db, userId: string, purpose: 'verify' | 'reset'): Promise<string | null> {
	const { token: raw, hash } = newToken();
	const { rows } = await db.query<{ issued: boolean }>(
		'SELECT app_issue_email_token($1, $2, $3, $4::interval, $5::interval) AS issued',
		[userId, purpose, hash, TOKEN_TTL[purpose], RESEND_COOLDOWN[purpose]]
	);
	return rows[0]?.issued ? raw : null;
}

/** Mark the address verified and turn its pending invites into memberships. */
export async function markVerified(db: Db, userId: string): Promise<void> {
	await db.query('UPDATE app_user SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId]);
	await db.query('SELECT app_accept_invites($1)', [userId]);
}

/**
 * Issue a verification token and build its email (null when throttled). The
 * caller sends it after the transaction commits, so a mailed link always
 * refers to a stored token.
 */
export async function verificationMail(db: Db, userId: string, to: string): Promise<Mail | null> {
	const raw = await issueToken(db, userId, 'verify');
	return raw ? verifyEmailMail(to, siteLink('/verify-email', raw)) : null;
}

export const emailAuthRoutes = new Hono<AuthEnv>()
	// Always 202 with the same body, whether or not the address has an account,
	// so the endpoint can't be used to discover accounts. Throttled per address
	// through the token table (one mail per cooldown window).
	.post('/forgot-password', async (c) => {
		const body = z.object({ email }).parse(await c.req.json());
		const mail = await withoutUser(async (db) => {
			const { rows } = await db.query<{ id: string; email: string }>('SELECT id, email FROM app_user WHERE email = $1', [
				body.email
			]);
			const user = rows[0];
			if (!user) return null;
			const raw = await issueToken(db, user.id, 'reset');
			return raw ? resetPasswordMail(user.email, siteLink('/reset-password', raw)) : null;
		});
		if (mail) await trySendMail(mail);
		return c.json({ ok: true }, 202);
	})
	// Sets a new password, marks the address verified (the link proved the
	// inbox), and revokes every existing session — including a thief's.
	.post('/reset-password', async (c) => {
		const body = z.object({ token, password }).parse(await c.req.json());
		const hash = parseToken(body.token);
		if (!hash) throw new ApiError(400, INVALID_LINK);
		const newHash = await hashPassword(body.password);
		const ok = await withoutUser(async (db) => {
			const { rows } = await db.query<{ user_id: string | null }>(
				"SELECT app_consume_email_token($1, 'reset') AS user_id",
				[hash]
			);
			const userId = rows[0]?.user_id;
			if (!userId) return false;
			// Watermark from this server's clock, the same clock that stamps
			// session iat, so a sign-in right after this is never mistaken as older.
			await db.query('UPDATE app_user SET password_hash = $2, sessions_revoked_at = $3 WHERE id = $1', [
				userId,
				newHash,
				new Date()
			]);
			// Outstanding reset links are dead too.
			await db.query("DELETE FROM email_token WHERE user_id = $1 AND purpose = 'reset'", [userId]);
			await markVerified(db, userId);
			return true;
		});
		if (!ok) throw new ApiError(400, INVALID_LINK);
		clearSession(c);
		return c.body(null, 204);
	})
	.post('/verify-email', async (c) => {
		const body = z.object({ token }).parse(await c.req.json());
		const hash = parseToken(body.token);
		if (!hash) throw new ApiError(400, INVALID_LINK);
		const ok = await withoutUser(async (db) => {
			const { rows } = await db.query<{ user_id: string | null }>(
				"SELECT app_consume_email_token($1, 'verify') AS user_id",
				[hash]
			);
			const userId = rows[0]?.user_id;
			if (!userId) return false;
			await markVerified(db, userId);
			return true;
		});
		if (!ok) throw new ApiError(400, INVALID_LINK);
		return c.json({ verified: true });
	})
	.post('/resend-verification', requireUser, async (c) => {
		const mail = await withoutUser(async (db) => {
			const { rows } = await db.query<{ email: string; verified: boolean }>(
				'SELECT email, email_verified_at IS NOT NULL AS verified FROM app_user WHERE id = $1',
				[c.get('userId')]
			);
			const user = rows[0];
			if (!user) throw new ApiError(401, 'not signed in');
			if (user.verified) throw new ApiError(409, 'your email address is already verified');
			return verificationMail(db, c.get('userId'), user.email);
		});
		if (!mail) throw new ApiError(429, 'a confirmation email was sent a moment ago — check your inbox, or try again in a minute');
		await trySendMail(mail);
		return c.json({ sent: true }, 202);
	})
	// What an invite link is for, so the sign-up page can say "Ann invited you
	// to …" and prefill the address. The 256-bit token is the credential.
	.post('/invite-info', async (c) => {
		const body = z.object({ token }).parse(await c.req.json());
		const hash = parseToken(body.token);
		if (!hash) throw new ApiError(404, 'this invitation is invalid or has expired');
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<{
				email: string;
				project_name: string | null;
				team_name: string | null;
				inviter_name: string;
			}>('SELECT * FROM app_invite_for_token($1)', [hash]);
			return rows[0];
		});
		if (!row) throw new ApiError(404, 'this invitation is invalid or has expired');
		return c.json({
			invite: { email: row.email, projectName: row.project_name, teamName: row.team_name, invitedBy: row.inviter_name }
		});
	});
