// One structured log line per failed credential check, counted across every
// account by the `login-failed` alarm (infra/alarms.tf). Every per-account
// throttle (the sign-in lockout, the reset and verification cooldowns) is
// keyed on one address, so one password tried against many accounts from
// many addresses gets past each of them; only a count over all accounts sees
// that (issue #126, docs/security.md § Throttles that don't depend on the WAF).
//
// The line holds a reason code and the route's pattern only: never the typed
// address, the account's id, the client address or the token, so a log
// reader learns nothing about who was tried. The reason separates an unknown
// address from a wrong password for the operator; the client never sees the
// difference (both answer the same 401, after the same password-hash work).

import { logEvent } from '../logging/logEvent.js';

/**
 * Why a credential check failed.
 * - `unknown_account`: sign-in with an address that has no account.
 * - `bad_password`: a real account, the wrong password (sign-in, or the
 *   current password on change-password or on deleting the account).
 * - `locked`: refused by the per-address lockout before the password was checked.
 * - `invalid_link`: a reset or verification token that is malformed, used,
 *   expired or never existed.
 * - `bad_code`: a wrong two-step sign-in code (an authenticator or recovery
 *   code; auth/mfa-routes.ts). `locked` there is the code throttle.
 */
export type LoginFailureReason = 'unknown_account' | 'bad_password' | 'locked' | 'invalid_link' | 'bad_code';

/**
 * The routes that check a credential: the patterns, never a concrete path.
 * `DELETE /auth/me`: "Delete my account" asks for the password again (issue #112).
 */
export type LoginFailureRoute =
	| '/auth/login'
	| '/auth/change-password'
	| '/auth/me'
	| '/auth/reset-password'
	| '/auth/verify-email'
	| '/auth/mfa/verify'
	| '/auth/mfa/totp/enrol'
	| '/auth/mfa/totp/confirm'
	| '/auth/mfa/totp'
	| '/auth/mfa/recovery-codes'
	| '/auth/mfa/step-up';

/** Log `{"event":"login_failed","route","reason"}`: nothing that names a person. */
export function logLoginFailed(route: LoginFailureRoute, reason: LoginFailureReason): void {
	logEvent('warn', { event: 'login_failed', route, reason });
}
