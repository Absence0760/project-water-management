import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import { queryWithoutUser, withUser } from '../db/tx.js';
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
 * one run (and, for an impact report, compares it with one baseline), and
 * lives long enough for one render.
 */
export const RENDER_SESSION_TTL_SECONDS = 10 * 60;

/** The signed session token for a user (issueSession sets it as the cookie). */
export async function signSession(userId: string, scope?: RenderScope): Promise<string> {
	const ttl = scope ? RENDER_SESSION_TTL_SECONDS : TTL_SECONDS;
	// iat is whole seconds; iat_ms lets the revocation watermark compare
	// precisely, so a sign-in right after a password reset isn't rejected.
	const claim = scope ? { p: scope.projectId, r: scope.runId, ...(scope.against ? { a: { p: scope.against.projectId, r: scope.against.runId } } : {}) } : null;
	return new SignJWT({ iat_ms: Date.now(), ...(claim ? { scope: claim } : {}) })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(userId)
		.setIssuer(ISSUER)
		.setIssuedAt()
		.setExpirationTime(`${ttl}s`)
		// The session's own id, which POST /auth/logout revokes (102_session_revocation).
		.setJti(crypto.randomUUID())
		.sign(secret());
}

export async function issueSession(c: Context, userId: string, scope?: RenderScope): Promise<void> {
	const ttl = scope ? RENDER_SESSION_TTL_SECONDS : TTL_SECONDS;
	const token = await signSession(userId, scope);
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
	/** The token's id (`jti`), which signing out revokes (revokeSession). */
	jti: string;
	/** When the token expires, epoch seconds (`exp`). */
	expiresAt: number;
}

/** User id from a valid session cookie, or null (readSessionClaims). */
export async function readSession(c: Context): Promise<string | null> {
	return (await readSessionClaims(c))?.userId ?? null;
}

/**
 * The session from a valid cookie, or null. Besides the signature and
 * expiry, the account must still exist, the token must have been issued
 * after the user's `sessions_revoked_at` watermark (set by a password reset),
 * so resetting a password signs out every existing session, render sessions
 * included, and its id (`jti`, required) must not have been signed out
 * (POST /auth/logout, 102_session_revocation). A `scope` claim that isn't a well-formed project + run (with, if
 * any, a well-formed baseline project + run) makes the whole token invalid: a
 * render session never widens into a full one.
 */
export async function readSessionClaims(c: Context): Promise<Session | null> {
	const token = getCookie(c, SESSION_COOKIE);
	if (!token) return null;
	let userId: string;
	let issuedMs: number;
	let jti: string;
	let expiresAt: number;
	let scope: RenderScope | null = null;
	try {
		const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ['HS256'] });
		if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
		userId = payload.sub;
		// A token without an id couldn't be signed out, so it isn't a session (every one signSession makes has one).
		if (typeof payload.jti !== 'string' || !UUID.test(payload.jti) || typeof payload.exp !== 'number') return null;
		jti = payload.jti.toLowerCase();
		expiresAt = payload.exp;
		issuedMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : (payload.iat ?? 0) * 1000;
		if (payload.scope !== undefined) {
			const s = payload.scope as { p?: unknown; r?: unknown; a?: unknown } | null;
			if (!s || typeof s.p !== 'string' || typeof s.r !== 'string' || !UUID.test(s.p) || !UUID.test(s.r)) return null;
			scope = { projectId: s.p.toLowerCase(), runId: s.r.toLowerCase() };
			if (s.a !== undefined) {
				const a = s.a as { p?: unknown; r?: unknown } | null;
				if (!a || typeof a.p !== 'string' || typeof a.r !== 'string' || !UUID.test(a.p) || !UUID.test(a.r)) return null;
				scope.against = { projectId: a.p.toLowerCase(), runId: a.r.toLowerCase() };
			}
		}
	} catch {
		return null;
	}
	// Every authenticated request reads this: one statement, no transaction round trips.
	// app_user is under RLS (068) and this has no user yet: the narrow lookup.
	const [row] = await queryWithoutUser<{ sessions_revoked_at: Date | null; revoked: boolean }>(
		'SELECT sessions_revoked_at, revoked FROM app_session_state($1, $2)',
		[userId, jti]
	);
	if (!row || row.revoked) return null;
	if (row.sessions_revoked_at && issuedMs < row.sessions_revoked_at.getTime()) return null;
	return { userId, scope, jti, expiresAt };
}

/**
 * Sign out this request's session on the server: its id is recorded until
 * the token would have expired, so a copy of the cookie stops working too
 * (102_session_revocation). No valid session: nothing to do.
 */
export async function revokeSession(c: Context): Promise<void> {
	const session = await readSessionClaims(c);
	if (!session) return;
	await withUser(session.userId, (db) => db.query('SELECT app_revoke_session($1, to_timestamp($2))', [session.jti, session.expiresAt]));
}
