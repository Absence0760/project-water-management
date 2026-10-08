// The second-factor requirement for the roles that can do the most harm
// (issue #282; docs/security.md § Two-step sign-in). A project owner (or a
// team admin, who is an owner on every team project), a team admin and an
// assessor must have signed in with a code (from their authenticator app or
// their email, 206) before
// the actions those roles exist for: anything gated on the owner role
// (members, invites, API keys, data feeds, share links, deleting a project),
// anything gated on team admin, publishing to farmers (a restriction, a notice,
// an outlook), deciding an application, issuing or withdrawing an
// evidence pack, and signing a run or a pack (any editor may sign, so every
// signer needs a second factor: a sign-off is the professional record an
// authority relies on; operator decision, 2026-10-01). Everyone else may add a factor, and is asked for
// a code at sign-in once they have, but needs it for nothing.
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
//
// A fresh code (licensing positions item 9, provisional position, pre-counsel
// research, 2026-10-01): a sign-off (of a run or an evidence pack), issuing a
// pack and withdrawing one also need a code (from the app or by email) within the
// last ten minutes (FRESH_CODE_MS), not only at sign-in: a sign-off publishes
// a professional statement under a real name on the public verify page, so a
// session left open on a shared computer mustn't make one. requireFreshCode
// answers 401 `mfa_fresh_code` when the session's last code (the `otp_at`
// claim) is older; the client asks for a code, POSTs it to
// /auth/mfa/step-up, and repeats the action (lib/api/client.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { FRESH_CODE_MS, type Amr } from './session.js';

export interface RequestAuth {
	userId: string;
	amr: Amr;
	/** When the session last gave a code (epoch ms), or null. */
	otpAt?: number | null;
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
 * Whether `userId` has a confirmed second factor of any kind: an
 * authenticator app (user_totp, 150) or codes by email (user_email_otp, 206).
 * An unconfirmed one (enrolment waiting for its first code) doesn't count.
 * Read as the account (RLS shows only its own rows).
 */
export async function hasConfirmedFactor(db: Db, userId: string): Promise<boolean> {
	const { rows } = await db.query<{ enrolled: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL)
			OR EXISTS (SELECT 1 FROM user_email_otp WHERE user_id = $1 AND confirmed_at IS NOT NULL) AS enrolled`,
		[userId]
	);
	return rows[0]?.enrolled ?? false;
}

/**
 * The 403 this request would get for want of a second factor, or null when it
 * has one (or the requirement is off, or there is no request). `mfa_required`:
 * the person has no second factor yet (set one up on the Account page).
 * `mfa_step_up`: they have one, but this session signed in before it was
 * added: sign in again. A read can say so ahead of the action (a sign-off's
 * `cannotSign`), so nobody fills in a form the server will refuse.
 */
export async function stepUpRefusal(db: Db): Promise<ApiError | null> {
	const auth = requestAuth.getStore();
	if (!auth || !mfaRequired()) return null;
	if (!(await hasConfirmedFactor(db, auth.userId))) {
		return ApiError.coded(403, 'mfa_required', 'this needs two-step sign-in: set it up on your Account page first');
	}
	if (!auth.amr.includes('otp')) {
		return ApiError.coded(403, 'mfa_step_up', 'this needs two-step sign-in: sign out and sign in again with a code');
	}
	return null;
}

/** 403 mfa_required / mfa_step_up unless this request's session signed in with a second factor and the account still has one. */
export async function requireStepUp(db: Db): Promise<void> {
	const refusal = await stepUpRefusal(db);
	if (refusal) throw refusal;
}

/**
 * requireStepUp, and a code (from the app or by email) within the last ten
 * minutes (FRESH_CODE_MS): 401 `mfa_fresh_code` otherwise, which the client
 * answers by asking for a code (POST /auth/mfa/step-up) and trying again. For
 * a sign-off and for issuing or withdrawing an evidence pack. Off with the
 * requirement (MFA_REQUIRED=false) and outside a request, as requireStepUp.
 */
export async function requireFreshCode(db: Db, now = Date.now()): Promise<void> {
	await requireStepUp(db);
	const auth = requestAuth.getStore();
	if (!auth || !mfaRequired()) return;
	if (!freshCode(auth.otpAt ?? null, now)) {
		throw ApiError.coded(401, 'mfa_fresh_code', 'this needs a code from the last 10 minutes (from your authenticator app or your email): enter one, then try again');
	}
}

/** Whether a code given at `otpAt` (epoch ms) still counts at `now`: no older than FRESH_CODE_MS, and not from the future beyond a minute's clock skew. */
export function freshCode(otpAt: number | null, now = Date.now()): boolean {
	return otpAt !== null && now - otpAt <= FRESH_CODE_MS && otpAt - now <= 60_000;
}

