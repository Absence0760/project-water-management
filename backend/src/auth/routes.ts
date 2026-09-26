import { Hono } from 'hono';
import { z } from 'zod';
import { withoutUser, withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { trySendMail } from '../mail/transport.js';
import { markVerified, verificationMail } from './email-routes.js';
import { buildSubjectExport, ExportThrottled } from './export.js';
import { attachment } from '../export/csv.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { clearSession, issueSession } from './session.js';
import { parseToken } from './tokens.js';
import { readJson } from '../http/body.js';
import { LOCALES } from '../mail/i18n/index.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);
const displayName = z.string().trim().min(1).max(100);
/** app_user.locale (050): the farmer-facing pages' and emails' language; null = not chosen (follow the browser). */
const locale = z.enum(LOCALES).nullable();
/** app_user.volume_unit (050): how the farm view shows volumes. */
const volumeUnit = z.enum(['m3', 'ML']);

const RegisterBody = z.object({
	email,
	password,
	displayName,
	/** Token from an invite link (`/register?invite=…`). Signing up with it,
	 *  for the invited address, proves the inbox: the account starts verified
	 *  and joins the invited projects/teams straight away. */
	inviteToken: z.string().max(200).optional(),
	/** The language the sign-up page was in, when the person picked one there. */
	locale: z.enum(LOCALES).optional()
});
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });
const MeBody = z
	.object({ displayName: displayName.optional(), locale: locale.optional(), volumeUnit: volumeUnit.optional() })
	.refine((b) => b.displayName !== undefined || b.locale !== undefined || b.volumeUnit !== undefined, {
		message: 'nothing to change: send displayName, locale or volumeUnit'
	});
const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });

/**
 * Sign-in lockout per address: the 5th attempt in a row without a correct
 * password locks the address for 1 minute, and each attempt after a lock
 * doubles it, up to 15 minutes. A correct password or a password reset clears
 * it; a day without attempts forgets it.
 */
export const LOGIN_THROTTLE = { freeAttempts: 5, baseLock: '1 minute', maxLock: '15 minutes' } as const;

/** Counts one attempt against the address's lockout; the seconds left on a lock, or 0 to go ahead. */
async function countAttempt(db: Db, address: string): Promise<number> {
	const { rows } = await db.query<{ locked: number }>(
		'SELECT app_login_attempt($1, $2, $3::interval, $4::interval) AS locked',
		[address, LOGIN_THROTTLE.freeAttempts, LOGIN_THROTTLE.baseLock, LOGIN_THROTTLE.maxLock]
	);
	return rows[0]?.locked ?? 0;
}

export function lockedMessage(seconds: number): string {
	const wait = seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`;
	return `too many sign-in attempts for this address — try again in ${wait}, or reset your password`;
}

type UserRow = {
	id: string;
	email: string;
	display_name: string;
	email_verified_at: Date | null;
	locale: 'en' | 'af' | null;
	volume_unit: 'm3' | 'ML';
};
const toUser = (r: UserRow) => ({
	id: r.id,
	email: r.email,
	displayName: r.display_name,
	emailVerified: r.email_verified_at !== null,
	locale: r.locale,
	volumeUnit: r.volume_unit
});
const USER_COLS = 'id, email, display_name, email_verified_at, locale, volume_unit';

export const authRoutes = new Hono<AuthEnv>()
	.post('/register', async (c) => {
		const body = RegisterBody.parse(await readJson(c));
		const hash = await hashPassword(body.password);
		const inviteHash = body.inviteToken ? parseToken(body.inviteToken) : null;
		const result = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow>(
				`INSERT INTO app_user (email, display_name, password_hash, locale) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (email) DO NOTHING RETURNING ${USER_COLS}`,
				[body.email, body.displayName, hash, body.locale ?? null]
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
					// Accepting may have set the locale from the invite (050).
					const { rows: fresh } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [row.id]);
					return { row: fresh[0]!, mail: null };
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
		const body = LoginBody.parse(await readJson(c));
		// Per-address lockout (005_login_throttle.sql). Counted in its own
		// transaction before the password check, so parallel guesses queue on
		// the row lock and can't all get past it. Keyed by the typed address,
		// so an unknown address is locked exactly like a real one.
		const { lockedSeconds, row } = await withoutUser(async (db) => {
			const lockedSeconds = await countAttempt(db, body.email);
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
	// Sign out every device, this one included: move the session watermark to
	// now, so every session issued before it is rejected (session.ts).
	.post('/logout-everywhere', requireUser, async (c) => {
		// This server's clock, the one that stamps session iat_ms (see reset-password).
		await withoutUser((db) =>
			db.query('UPDATE app_user SET sessions_revoked_at = $2 WHERE id = $1', [c.get('userId'), new Date()])
		);
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
	})
	// "Download my data" (POPIA access; auth/export.ts): everything the app
	// keeps about the signed-in person, as a JSON file. One a minute per account.
	.get('/me/export', requireUser, async (c) => {
		let doc;
		try {
			doc = await buildSubjectExport(c.get('userId'));
		} catch (err) {
			if (!(err instanceof ExportThrottled)) throw err;
			c.header('Retry-After', String(err.retryAfter));
			throw new ApiError(429, 'you downloaded your data a moment ago — try again in a minute');
		}
		return c.body(JSON.stringify(doc, null, 2), 200, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Disposition': attachment(`my-data_${doc.exportedAt.slice(0, 10)}.json`),
			'Cache-Control': 'no-store'
		});
	})
	.patch('/me', requireUser, async (c) => {
		const body = MeBody.parse(await readJson(c));
		// Only the fields sent change; locale may be set back to null (follow the browser).
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow>(
				`UPDATE app_user SET
					display_name = coalesce($2, display_name),
					locale = CASE WHEN $3::boolean THEN $4 ELSE locale END,
					volume_unit = coalesce($5, volume_unit)
				 WHERE id = $1 RETURNING ${USER_COLS}`,
				[c.get('userId'), body.displayName ?? null, body.locale !== undefined, body.locale ?? null, body.volumeUnit ?? null]
			);
			return rows[0];
		});
		if (!row) throw new ApiError(401, 'not signed in');
		return c.json({ user: toUser(row) });
	})
	// Change the password while signed in. The current password is checked
	// through the sign-in lockout (a stolen session can't guess it any faster
	// than the login form can), then every session is revoked, and this device
	// gets a fresh cookie so it stays signed in.
	.post('/change-password', requireUser, async (c) => {
		const body = ChangePasswordBody.parse(await readJson(c));
		const userId = c.get('userId');
		// Counted in its own transaction before the bcrypt check, as in login.
		const { lockedSeconds, row } = await withoutUser(async (db) => {
			const { rows } = await db.query<{ email: string; password_hash: string }>(
				'SELECT email, password_hash FROM app_user WHERE id = $1',
				[userId]
			);
			const row = rows[0];
			if (!row) return { lockedSeconds: 0, row: undefined };
			return { lockedSeconds: await countAttempt(db, row.email), row };
		});
		if (!row) throw new ApiError(401, 'not signed in');
		if (lockedSeconds > 0) {
			c.header('Retry-After', String(lockedSeconds));
			throw new ApiError(429, lockedMessage(lockedSeconds));
		}
		if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
			throw new ApiError(403, 'your current password is wrong');
		}
		const newHash = await hashPassword(body.newPassword);
		// As the user (withUser), so email_token's RLS lets the reset links be deleted.
		const user = await withUser(userId, async (db) => {
			// Only if the hash is still the one just checked: a concurrent change
			// or reset in between wins, and this one is refused below.
			const { rows } = await db.query<UserRow>(
				`UPDATE app_user SET password_hash = $3, sessions_revoked_at = $4
				 WHERE id = $1 AND password_hash = $2 RETURNING ${USER_COLS}`,
				// Watermark from this server's clock, the one that stamps session iat_ms.
				[userId, row.password_hash, newHash, new Date()]
			);
			const updated = rows[0];
			if (!updated) return undefined;
			// Outstanding reset links die with the old password, and the lockout count clears.
			await db.query("DELETE FROM email_token WHERE user_id = $1 AND purpose = 'reset'", [userId]);
			await db.query('SELECT app_login_succeeded($1)', [updated.email]);
			return updated;
		});
		if (!user) throw new ApiError(409, 'your password was changed somewhere else a moment ago — sign in again');
		// Issued after the watermark, so this device stays signed in.
		await issueSession(c, userId);
		return c.json({ user: toUser(user) });
	});
