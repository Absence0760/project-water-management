import { Hono } from 'hono';
import { z } from 'zod';
import { withoutUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { trySendMail } from '../mail/transport.js';
import { markVerified, verificationMail } from './email-routes.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { clearSession, issueSession } from './session.js';
import { parseToken } from './tokens.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);

const RegisterBody = z.object({
	email,
	password,
	displayName: z.string().trim().min(1).max(100),
	/** Token from an invite link (`/register?invite=…`). Signing up with it,
	 *  for the invited address, proves the inbox: the account starts verified
	 *  and joins the invited projects/teams straight away. */
	inviteToken: z.string().max(200).optional()
});
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });

/**
 * Sign-in lockout per address: the 5th attempt in a row without a correct
 * password locks the address for 1 minute, and each attempt after a lock
 * doubles it, up to 15 minutes. A correct password or a password reset clears
 * it; a day without attempts forgets it.
 */
export const LOGIN_THROTTLE = { freeAttempts: 5, baseLock: '1 minute', maxLock: '15 minutes' } as const;

export function lockedMessage(seconds: number): string {
	const wait = seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`;
	return `too many sign-in attempts for this address — try again in ${wait}, or reset your password`;
}

type UserRow = { id: string; email: string; display_name: string; email_verified_at: Date | null };
const toUser = (r: UserRow) => ({
	id: r.id,
	email: r.email,
	displayName: r.display_name,
	emailVerified: r.email_verified_at !== null
});
const USER_COLS = 'id, email, display_name, email_verified_at';

export const authRoutes = new Hono<AuthEnv>()
	.post('/register', async (c) => {
		const body = RegisterBody.parse(await c.req.json());
		const hash = await hashPassword(body.password);
		const inviteHash = body.inviteToken ? parseToken(body.inviteToken) : null;
		const result = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow>(
				`INSERT INTO app_user (email, display_name, password_hash) VALUES ($1, $2, $3)
				 ON CONFLICT (email) DO NOTHING RETURNING ${USER_COLS}`,
				[body.email, body.displayName, hash]
			);
			const row = rows[0];
			if (!row) return null;
			// A live invite for exactly this address proves the inbox.
			if (inviteHash) {
				const { rows: inv } = await db.query<{ email: string }>('SELECT email FROM app_invite_for_token($1)', [
					inviteHash
				]);
				if (inv[0] && inv[0].email.toLowerCase() === row.email.toLowerCase()) {
					await markVerified(db, row.id);
					return { row: { ...row, email_verified_at: new Date() }, mail: null };
				}
			}
			return { row, mail: await verificationMail(db, row.id, row.email) };
		});
		if (!result) throw new ApiError(409, 'an account with that email already exists');
		if (result.mail) await trySendMail(result.mail);
		await issueSession(c, result.row.id);
		return c.json({ user: toUser(result.row) }, 201);
	})
	.post('/login', async (c) => {
		const body = LoginBody.parse(await c.req.json());
		// Per-address lockout (005_login_throttle.sql). Counted in its own
		// transaction before the password check, so parallel guesses queue on
		// the row lock and can't all get past it. Keyed by the typed address,
		// so an unknown address is locked exactly like a real one.
		const { lockedSeconds, row } = await withoutUser(async (db) => {
			const { rows: t } = await db.query<{ locked: number }>(
				'SELECT app_login_attempt($1, $2, $3::interval, $4::interval) AS locked',
				[body.email, LOGIN_THROTTLE.freeAttempts, LOGIN_THROTTLE.baseLock, LOGIN_THROTTLE.maxLock]
			);
			const lockedSeconds = t[0]?.locked ?? 0;
			if (lockedSeconds > 0) return { lockedSeconds, row: undefined };
			const { rows } = await db.query<UserRow & { password_hash: string }>(
				`SELECT ${USER_COLS}, password_hash FROM app_user WHERE email = $1`,
				[body.email]
			);
			return { lockedSeconds, row: rows[0] };
		});
		if (lockedSeconds > 0) {
			c.header('Retry-After', String(lockedSeconds));
			throw new ApiError(429, lockedMessage(lockedSeconds));
		}
		const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
		if (!row || !ok) throw new ApiError(401, 'wrong email or password');
		await withoutUser((db) => db.query('SELECT app_login_succeeded($1)', [body.email]));
		await issueSession(c, row.id);
		return c.json({ user: toUser(row) });
	})
	.post('/logout', (c) => {
		clearSession(c);
		return c.body(null, 204);
	})
	.get('/me', requireUser, async (c) => {
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [
				c.get('userId')
			]);
			return rows[0];
		});
		if (!row) throw new ApiError(401, 'not signed in');
		return c.json({ user: toUser(row) });
	});
