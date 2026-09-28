// Trusted devices for the sign-in lockout (070_login_device_trust.sql;
// docs/security.md § Authentication).
//
// The lockout is keyed by the typed address, so anyone can lock it. A browser
// that has proved it knows the address's password (a correct sign-in, a
// reset, a sign-up, a password change) gets a `wm_device` cookie for that
// address: a random device id and an HMAC over the address, the account's
// session watermark and the id. With it, that browser's attempts count on its
// own (address, device) record, so a stranger filling the shared record can't
// keep the owner out. Without a valid one (a stranger, another address, an
// older watermark) the attempt counts on the shared record, as before.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const DEVICE_COOKIE = 'wm_device';
/** How long a device stays trusted without signing in again. */
export const DEVICE_TTL_SECONDS = 180 * 24 * 3600;
const COOKIE_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function key(): Buffer {
	const s = process.env.AUTH_JWT_SECRET ?? '';
	if (s.length < 32) throw new Error('AUTH_JWT_SECRET must be set (≥ 32 characters)');
	// Its own key, derived from the session secret, so a device MAC is never a valid anything else.
	return createHmac('sha256', s).update('wm-device-key:v1').digest();
}

/** The session watermark as the MAC sees it: ms since the epoch, 0 for none. */
const stamp = (watermark: Date | null) => String(watermark?.getTime() ?? 0);

function mac(email: string, watermark: Date | null, device: string): Buffer {
	return createHmac('sha256', key()).update(`${email.toLowerCase()}\n${stamp(watermark)}\n${device}`).digest();
}

/** The cookie value for `device` (exported for tests). */
export function deviceCookieValue(email: string, watermark: Date | null, device: string): string {
	return `${device}.${mac(email, watermark, device).toString('base64url')}`;
}

/** Trust this browser for `email` until its watermark moves: a new device id each time. */
export function issueDevice(c: Context, email: string, watermark: Date | null): void {
	setCookie(c, DEVICE_COOKIE, deviceCookieValue(email, watermark, randomBytes(16).toString('base64url')), {
		httpOnly: true,
		sameSite: 'Lax',
		secure: process.env.COOKIE_SECURE !== 'false',
		path: '/',
		maxAge: DEVICE_TTL_SECONDS
	});
}

export function clearDevice(c: Context): void {
	deleteCookie(c, DEVICE_COOKIE, { path: '/' });
}

/**
 * The device id from a `wm_device` cookie issued for `email` under the
 * account's current watermark, or null (no cookie, malformed, another
 * address, an older watermark, a forged MAC).
 */
export function trustedDevice(c: Context, email: string, watermark: Date | null): string | null {
	const m = COOKIE_RE.exec(getCookie(c, DEVICE_COOKIE) ?? '');
	if (!m) return null;
	const device = m[1]!;
	const given = Buffer.from(m[2]!, 'base64url');
	const want = mac(email, watermark, device);
	return given.length === want.length && timingSafeEqual(given, want) ? device : null;
}
