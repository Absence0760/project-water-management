// The second-factor requirement for the roles that can do the most harm
// (issue #282; docs/security.md § Two-step sign-in). A project owner (or a
// team admin, who is an owner on every team project), a team admin and an
// assessor must have signed in with a code from their authenticator before
// the actions those roles exist for: anything gated on the owner role
// (members, invites, API keys, data feeds, share links, deleting a project),
// anything gated on team admin, publishing to farmers (a restriction, a notice,
// an outlook), deciding an application and issuing or withdrawing an
// evidence pack. Everyone else may add an authenticator, and is asked for
// its code at sign-in once they have, but needs it for nothing.
//
// Where it is checked: requireRole(…, 'owner') and requireTeamRole(…, 'admin')
// call requireStepUp after the role check passes (so a non-member still gets
// the 404 and learns nothing), and the editor-level actions above call it
// themselves. A new owner-only route gets it without doing anything.
//
// How the route knows the session: requireUser runs the rest of the request
// inside `requestAuth` (AsyncLocalStorage) with the session's `amr`. Work
// outside a request (the job runner acting for whoever queued a job) has no
// store and isn't stepped up: no job kind needs more than editor, and the
// request that queued the job was checked.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import type { Amr } from './session.js';

export interface RequestAuth {
	userId: string;
	amr: Amr;
}

export const requestAuth = new AsyncLocalStorage<RequestAuth>();

/**
 * Whether the requirement is on: always in production (config/production.ts
 * and mfaRequired refuse `false` on Lambda). MFA_REQUIRED=false turns it off
 * for the DB tests and the e2e API server, whose hundreds of owner fixtures
 * sign in with a password only; the tests of the requirement itself turn it
 * back on (stepUp.db.test.ts). Read on every call, so a test can switch it.
 */
export function mfaRequired(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.MFA_REQUIRED;
	if (raw === undefined || raw === '' || raw === 'true') return true;
	if (raw !== 'false') throw new Error('MFA_REQUIRED must be true or false');
	if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('MFA_REQUIRED=false is for local tests only; Lambda always requires a second factor');
	return false;
}

/**
 * 403 unless this request's session signed in with a second factor and the
 * account still has one. `mfa_required`: the person has no authenticator yet
 * (set one up on the Account page). `mfa_step_up`: they have one, but this
 * session signed in before it was added: sign in again.
 */
export async function requireStepUp(db: Db): Promise<void> {
	const auth = requestAuth.getStore();
	if (!auth || !mfaRequired()) return;
	const { rows } = await db.query<{ enrolled: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL) AS enrolled',
		[auth.userId]
	);
	const enrolled = rows[0]?.enrolled ?? false;
	if (!enrolled) {
		throw ApiError.coded(403, 'mfa_required', 'this needs two-step sign-in: set up an authenticator app on your Account page first');
	}
	if (!auth.amr.includes('otp')) {
		throw ApiError.coded(403, 'mfa_step_up', 'this needs two-step sign-in: sign out and sign in again with a code from your authenticator app');
	}
}
