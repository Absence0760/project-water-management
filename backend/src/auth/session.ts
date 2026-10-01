import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import { queryWithoutUser, withUser } from '../db/tx.js';
import { isPackScope, type RenderScope, type ReportScope } from '../reports/scope.js';

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
 * one run (and, for an impact report, compares it with one baseline), or one
 * evidence pack (119), and lives long enough for one render.
 */
export const RENDER_SESSION_TTL_SECONDS = 10 * 60;

/**
 * How the session's person proved who they are (RFC 8176 values): `pwd`, the
 * password, and `otp` once they also gave a code from their authenticator or
 * a recovery code (two-step sign-in, issue #282, auth/mfa.ts). The actions
 * that need a second factor check for `otp` (auth/stepUp.ts). A token from
 * before `amr` existed counts as `pwd` only.
 */
export type Amr = readonly ('pwd' | 'otp')[];
export const PASSWORD_ONLY: Amr = ['pwd'];
export const WITH_CODE: Amr = ['pwd', 'otp'];
const AMR_VALUES = new Set(['pwd', 'otp']);

/**
 * How long a code from the authenticator counts as fresh for the actions that
 * need a recent one (a sign-off, issuing or withdrawing an evidence pack;
 * auth/stepUp.ts requireFreshCode, licensing positions item 9): ten minutes.
 */
export const FRESH_CODE_MS = 10 * 60 * 1000;

/**
 * The signed session token for a user (issueSession sets it as the cookie). A render session carries no `amr`: it can't act.
 * `otpAt` (epoch ms, the `otp_at` claim): when this session last gave a code, set only where a code was just checked
 * (the sign-in step, confirming an enrolment, POST /auth/mfa/step-up), never carried over by a re-issue.
 */
export async function signSession(userId: string, scope?: RenderScope, amr: Amr = PASSWORD_ONLY, otpAt?: number): Promise<string> {
	const ttl = scope ? RENDER_SESSION_TTL_SECONDS : TTL_SECONDS;
	// iat is whole seconds; iat_ms lets the revocation watermark compare
	// precisely, so a sign-in right after a password reset isn't rejected.
	// A report's scope is a project and run (`a`: an impact report's baseline); a pack's, a project and pack (`k`).
	const claim = !scope
		? null
		: isPackScope(scope)
			? { p: scope.projectId, k: scope.packId }
			: { p: scope.projectId, r: scope.runId, ...(scope.against ? { a: { p: scope.against.projectId, r: scope.against.runId } } : {}) };
	return new SignJWT({ iat_ms: Date.now(), ...(claim ? { scope: claim } : { amr: [...amr], ...(otpAt !== undefined && amr.includes('otp') ? { otp_at: otpAt } : {}) }) })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(userId)
		.setIssuer(ISSUER)
		.setIssuedAt()
		.setExpirationTime(`${ttl}s`)
		// The session's own id, which POST /auth/logout revokes (102_session_revocation).
		.setJti(crypto.randomUUID())
		.sign(secret());
}

export async function issueSession(c: Context, userId: string, scope?: RenderScope, amr: Amr = PASSWORD_ONLY, otpAt?: number): Promise<void> {
	const ttl = scope ? RENDER_SESSION_TTL_SECONDS : TTL_SECONDS;
	const token = await signSession(userId, scope, amr, otpAt);
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

/**
 * The sign-in challenge (two-step sign-in, issue #282): after a right
 * password for an account with an authenticator, POST /auth/login sets this
 * instead of a session, and POST /auth/mfa/verify trades it and a code for
 * one. A JWT under the session key with its own issuer, so it can never pass
 * as a session (readSessionClaims checks the issuer) nor a session as it.
 * Five minutes; its id is revoked once used (revoked_session, 102), and a
 * password reset (the watermark) voids it like a session.
 */
export const MFA_CHALLENGE_COOKIE = 'wm_mfa';
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_ISSUER = 'water-management/mfa-challenge';
/** The cookie's path: only the routes that read it get it. */
const CHALLENGE_PATH = '/';

export async function issueMfaChallenge(c: Context, userId: string): Promise<void> {
	const token = await new SignJWT({ iat_ms: Date.now() })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(userId)
		.setIssuer(CHALLENGE_ISSUER)
		.setIssuedAt()
		.setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
		.setJti(crypto.randomUUID())
		.sign(secret());
	setCookie(c, MFA_CHALLENGE_COOKIE, token, {
		httpOnly: true,
		sameSite: 'Strict',
		secure: process.env.COOKIE_SECURE !== 'false',
		path: CHALLENGE_PATH,
		maxAge: MFA_CHALLENGE_TTL_SECONDS
	});
}

export function clearMfaChallenge(c: Context): void {
	deleteCookie(c, MFA_CHALLENGE_COOKIE, { path: CHALLENGE_PATH });
}

export interface MfaChallenge {
	userId: string;
	jti: string;
	expiresAt: number;
}

/** The challenge from a valid cookie (signature, expiry, not used, issued after the watermark), or null. */
export async function readMfaChallenge(c: Context): Promise<MfaChallenge | null> {
	const token = getCookie(c, MFA_CHALLENGE_COOKIE);
	if (!token) return null;
	let challenge: MfaChallenge;
	let issuedMs: number;
	try {
		const { payload } = await jwtVerify(token, secret(), { issuer: CHALLENGE_ISSUER, algorithms: ['HS256'] });
		if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
		if (typeof payload.jti !== 'string' || !UUID.test(payload.jti) || typeof payload.exp !== 'number' || typeof payload.iat_ms !== 'number') return null;
		challenge = { userId: payload.sub.toLowerCase(), jti: payload.jti.toLowerCase(), expiresAt: payload.exp };
		issuedMs = payload.iat_ms;
	} catch {
		return null;
	}
	const [row] = await queryWithoutUser<{ sessions_revoked_at: Date | null; revoked: boolean }>(
		'SELECT sessions_revoked_at, revoked FROM app_session_state($1, $2)',
		[challenge.userId, challenge.jti]
	);
	if (!row || row.revoked) return null;
	if (row.sessions_revoked_at && issuedMs < row.sessions_revoked_at.getTime()) return null;
	return challenge;
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
	/** How the person signed in (`amr`): `['pwd']`, or `['pwd', 'otp']` after a second factor. Empty on a render session. */
	amr: Amr;
	/** When this session last gave a code from the authenticator (`otp_at`, epoch ms), or null (FRESH_CODE_MS). */
	otpAt: number | null;
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
 * any, a well-formed baseline project + run), or a well-formed project + pack and nothing else, makes the whole token invalid: a
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
	let amr: Amr = PASSWORD_ONLY;
	let otpAt: number | null = null;
	try {
		const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ['HS256'] });
		if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
		userId = payload.sub;
		// A token without an id couldn't be signed out, so it isn't a session (every one signSession makes has one).
		if (typeof payload.jti !== 'string' || !UUID.test(payload.jti) || typeof payload.exp !== 'number') return null;
		jti = payload.jti.toLowerCase();
		expiresAt = payload.exp;
		issuedMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : (payload.iat ?? 0) * 1000;
		// Only values we issue; anything else makes the token invalid rather than quietly password-only.
		if (payload.amr !== undefined) {
			if (!Array.isArray(payload.amr) || !payload.amr.every((v) => typeof v === 'string' && AMR_VALUES.has(v))) return null;
			amr = payload.amr as Amr;
		}
		// Only a number we issue, and only beside `otp`; anything else makes the token invalid.
		if (payload.otp_at !== undefined) {
			if (typeof payload.otp_at !== 'number' || !Number.isFinite(payload.otp_at) || !amr.includes('otp')) return null;
			otpAt = payload.otp_at;
		}
		if (payload.scope !== undefined) {
			const s = payload.scope as { p?: unknown; r?: unknown; a?: unknown; k?: unknown } | null;
			if (!s || typeof s.p !== 'string' || !UUID.test(s.p)) return null;
			if (s.k !== undefined) {
				// A pack's scope: a pack and nothing else.
				if (typeof s.k !== 'string' || !UUID.test(s.k) || s.r !== undefined || s.a !== undefined) return null;
				scope = { projectId: s.p.toLowerCase(), packId: s.k.toLowerCase() };
			} else {
				if (typeof s.r !== 'string' || !UUID.test(s.r)) return null;
				const report: ReportScope = { projectId: s.p.toLowerCase(), runId: s.r.toLowerCase() };
				if (s.a !== undefined) {
					const a = s.a as { p?: unknown; r?: unknown } | null;
					if (!a || typeof a.p !== 'string' || typeof a.r !== 'string' || !UUID.test(a.p) || !UUID.test(a.r)) return null;
					report.against = { projectId: a.p.toLowerCase(), runId: a.r.toLowerCase() };
				}
				scope = report;
			}
			amr = [];
			otpAt = null;
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
	return { userId, scope, jti, expiresAt, amr, otpAt };
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
