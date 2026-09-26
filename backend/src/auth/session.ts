import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import { withoutUser } from '../db/tx.js';
import type { RenderScope } from '../reports/scope.js';

export const SESSION_COOKIE = 'wm_session';
const TTL_SECONDS = 7 * 24 * 3600;
const ISSUER = 'water-management';

function secret(): Uint8Array {
	const s = process.env.AUTH_JWT_SECRET ?? '';
	if (s.length < 32) throw new Error('AUTH_JWT_SECRET must be set (≥ 32 characters)');
	return new TextEncoder().encode(s);
}

/**
 * A render session (POST /auth/render-session, reports/scope.ts): what the
 * headless report renderer gets for a render token. It reads one project and
 * one run, and lives long enough for one render.
 */
export const RENDER_SESSION_TTL_SECONDS = 10 * 60;

export async function issueSession(c: Context, userId: string, scope?: RenderScope): Promise<void> {
	const ttl = scope ? RENDER_SESSION_TTL_SECONDS : TTL_SECONDS;
	// iat is whole seconds; iat_ms lets the revocation watermark compare
	// precisely, so a sign-in right after a password reset isn't rejected.
	const token = await new SignJWT({ iat_ms: Date.now(), ...(scope ? { scope: { p: scope.projectId, r: scope.runId } } : {}) })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(userId)
		.setIssuer(ISSUER)
		.setIssuedAt()
		.setExpirationTime(`${ttl}s`)
		.sign(secret());
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: 'Lax',
		// Local dev is plain http; everything deployed is https behind CloudFront.
		secure: process.env.COOKIE_SECURE !== 'false',
		path: '/',
		maxAge: ttl
	});
}

export function clearSession(c: Context): void {
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Session {
	userId: string;
	/** Set on a render session: the one project and run it may read. */
	scope: RenderScope | null;
}

/** User id from a valid session cookie, or null (readSessionClaims). */
export async function readSession(c: Context): Promise<string | null> {
	return (await readSessionClaims(c))?.userId ?? null;
}

/**
 * The session from a valid cookie, or null. Besides the signature and
 * expiry, the account must still exist and the token must have been issued
 * after the user's `sessions_revoked_at` watermark (set by a password reset),
 * so resetting a password signs out every existing session, render sessions
 * included. A `scope` claim that isn't a well-formed project + run makes the
 * whole token invalid: a render session never widens into a full one.
 */
export async function readSessionClaims(c: Context): Promise<Session | null> {
	const token = getCookie(c, SESSION_COOKIE);
	if (!token) return null;
	let userId: string;
	let issuedMs: number;
	let scope: RenderScope | null = null;
	try {
		const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ['HS256'] });
		if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
		userId = payload.sub;
		issuedMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : (payload.iat ?? 0) * 1000;
		if (payload.scope !== undefined) {
			const s = payload.scope as { p?: unknown; r?: unknown } | null;
			if (!s || typeof s.p !== 'string' || typeof s.r !== 'string' || !UUID.test(s.p) || !UUID.test(s.r)) return null;
			scope = { projectId: s.p.toLowerCase(), runId: s.r.toLowerCase() };
		}
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
	return { userId, scope };
}
