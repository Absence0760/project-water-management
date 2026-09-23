import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import { withoutUser } from '../db/tx.js';

export const SESSION_COOKIE = 'wm_session';
const TTL_SECONDS = 7 * 24 * 3600;
const ISSUER = 'water-management';

function secret(): Uint8Array {
	const s = process.env.AUTH_JWT_SECRET ?? '';
	if (s.length < 32) throw new Error('AUTH_JWT_SECRET must be set (≥ 32 characters)');
	return new TextEncoder().encode(s);
}

export async function issueSession(c: Context, userId: string): Promise<void> {
	// iat is whole seconds; iat_ms lets the revocation watermark compare
	// precisely, so a sign-in right after a password reset isn't rejected.
	const token = await new SignJWT({ iat_ms: Date.now() })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(userId)
		.setIssuer(ISSUER)
		.setIssuedAt()
		.setExpirationTime(`${TTL_SECONDS}s`)
		.sign(secret());
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: 'Lax',
		// Local dev is plain http; everything deployed is https behind CloudFront.
		secure: process.env.COOKIE_SECURE !== 'false',
		path: '/',
		maxAge: TTL_SECONDS
	});
}

export function clearSession(c: Context): void {
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * User id from a valid session cookie, or null. Besides the signature and
 * expiry, the account must still exist and the token must have been issued
 * after the user's `sessions_revoked_at` watermark (set by a password reset),
 * so resetting a password signs out every existing session.
 */
export async function readSession(c: Context): Promise<string | null> {
	const token = getCookie(c, SESSION_COOKIE);
	if (!token) return null;
	let userId: string;
	let issuedMs: number;
	try {
		const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ['HS256'] });
		if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
		userId = payload.sub;
		issuedMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : (payload.iat ?? 0) * 1000;
	} catch {
		return null;
	}
	const row = await withoutUser(async (db) => {
		const { rows } = await db.query<{ sessions_revoked_at: Date | null }>(
			'SELECT sessions_revoked_at FROM app_user WHERE id = $1',
			[userId]
		);
		return rows[0];
	});
	if (!row) return null;
	if (row.sessions_revoked_at && issuedMs < row.sessions_revoked_at.getTime()) return null;
	return userId;
}
