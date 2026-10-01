// One-click unsubscribe tokens (roadmap WP-2.13; docs/security.md § Alerts).
//
// Each subscription has a random 32-byte nonce. Its token is
// HMAC-SHA256(ALERTS_TOKEN_SECRET, "wm-alert-unsubscribe/v1/" + nonce),
// base64url (43 characters, the emailed tokens' format, auth/tokens.ts), and
// only the token's SHA-256 is stored (alert_subscription.unsubscribe_hash).
//   * The worker derives the same token for every mail, so a link in an old
//     mail keeps working: the token doesn't expire.
//   * A tampered token hashes to nothing. Neither a database leak (nonce and
//     hash) nor the secret alone makes a valid token.
//   * Turning a subscription back on draws a new nonce, so an old link can't
//     undo the person's later choice (a replayed token is refused).
//   * A token only ever turns its own subscription off.
// Only the worker needs the secret (it builds the mails); the API checks a
// token by its hash alone.
import { createHmac, randomBytes } from 'node:crypto';
import { hashToken } from '../auth/tokens.js';

const LABEL = 'wm-alert-unsubscribe/v1/';

/** ALERTS_TOKEN_SECRET, at least 32 characters, or a throw (the worker then sends nothing: better than unsigned links). */
export function alertsTokenSecret(): string {
	const s = process.env.ALERTS_TOKEN_SECRET ?? '';
	if (s.length < 32) throw new Error('ALERTS_TOKEN_SECRET must be set (≥ 32 characters)');
	return s;
}

export const newNonce = (): Buffer => randomBytes(32);

/** The unsubscribe token of a subscription's nonce. */
export function unsubscribeToken(nonce: Buffer, secret: string = alertsTokenSecret()): string {
	return createHmac('sha256', secret).update(LABEL).update(nonce.toString('hex')).digest('base64url');
}

/** A new nonce and the hash to store for it. */
export function newSubscriptionSecret(secret: string = alertsTokenSecret()): { nonce: Buffer; hash: Buffer } {
	const nonce = newNonce();
	return { nonce, hash: hashToken(unsubscribeToken(nonce, secret)) };
}

const FEEDBACK_LABEL = 'wm-alert-feedback/v1/';

/**
 * The "Was this useful?" token of a feedback row's nonce (147_alert_feedback):
 * the unsubscribe token's scheme under its own label, so one can never stand
 * in for the other. Only its SHA-256 is stored; the API looks it up by that.
 */
export function feedbackToken(nonce: Buffer, secret: string = alertsTokenSecret()): string {
	return createHmac('sha256', secret).update(FEEDBACK_LABEL).update(nonce.toString('hex')).digest('base64url');
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * The feedback page a mail's "Yes" / "No" link opens, the answer chosen. The
 * token and the answer ride the fragment, so neither reaches a server log,
 * and opening the link records nothing: the page asks before it sends.
 */
export function feedbackPageUrl(token: string, useful: boolean): string {
	return `${trimSlash(process.env.SITE_URL || 'http://localhost:7777')}/alerts/feedback#t=${token}&a=${useful ? 'yes' : 'no'}`;
}

/** The landing page a mail links to; the token rides the fragment, so it never reaches a server log. */
export function unsubscribePageUrl(token: string): string {
	return `${trimSlash(process.env.SITE_URL || 'http://localhost:7777')}/alerts/unsubscribe#t=${token}`;
}

/**
 * The RFC 8058 one-click address (List-Unsubscribe). A mail provider POSTs
 * "List-Unsubscribe=One-Click" to it with no way to add a body token, so the
 * token is in the query string here (docs/security.md § Alerts on what that
 * means for logs). The API's public base is API_PUBLIC_URL, else SITE_URL/api
 * (CloudFront's /api/* behaviour).
 */
export function oneClickUrl(token: string): string {
	const api = process.env.API_PUBLIC_URL || `${trimSlash(process.env.SITE_URL || 'http://localhost:7777')}/api`;
	return `${trimSlash(api)}/alerts/unsubscribe?token=${encodeURIComponent(token)}`;
}
