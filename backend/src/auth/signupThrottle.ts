// The sign-up throttle (079_signup_throttle.sql, docs/security.md § Password
// reset, email verification and invites). POST /auth/register answers 409 for
// a taken address, so each attempt is counted, per client address and in all,
// before the address is looked at: once throttled, a taken and a free address
// get the same 429.
import { createHash } from 'node:crypto';
import type { Db } from '../db/tx.js';

/** Well above real use: a household or office signing up its people, a WUA's invite wave. */
export const SIGNUP_THROTTLE = { perClient: 10, global: 500, window: '1 hour' } as const;

/**
 * Off only when SIGNUP_THROTTLE=off, and never in Lambda. It is a test-only
 * setting: the backend test setup (src/__tests__/setup.ts) and the e2e API
 * server (e2e/playwright.config.ts) sign up far more accounts than a person
 * would, all from one address, while signupThrottle.security.db.test.ts turns
 * it back on to test the limit itself. config/production.ts refuses it at
 * the API Lambda's start as well.
 */
export function signupThrottleOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.SIGNUP_THROTTLE !== 'off' || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
}

/** The stored bucket for a client key (http/clientAddress.ts): a hash, never the address itself. */
export const clientBucket = (key: string) => `client:${createHash('sha256').update(key).digest('hex')}`;

/** Counts one sign-up attempt from `key`: 0 to go ahead, else the seconds to wait. */
export async function countSignup(db: Db, key: string): Promise<number> {
	if (!signupThrottleOn()) return 0;
	const { rows } = await db.query<{ wait: number }>('SELECT app_signup_attempt($1, $2, $3, $4::interval) AS wait', [
		clientBucket(key),
		SIGNUP_THROTTLE.perClient,
		SIGNUP_THROTTLE.global,
		SIGNUP_THROTTLE.window
	]);
	return rows[0]?.wait ?? 0;
}
