// Two-step sign-in: who needs a second factor, and for what (docs/security.md
// § Two-step sign-in). Opt-in since the operator's decision of 2026-10-08,
// which replaced the role-based requirement of 2026-10-01 (issue #282):
//
// - Opt-in, per project and per team (204_mfa_opt_in). An owner's actions
//   (members, invites, API keys, data feeds, share links, deleting the
//   project: anything gated on requireRole(…, 'owner')) need it only when the
//   project requires it, or its team does; a team admin's (requireTeamRole(…,
//   'admin')) only when the team does. A run's sign-off follows the
//   project's setting too (requireProjectFreshCode). Off by default.
// - Always, whatever the settings: the actions that reach people outside the
//   team, where a stolen password would do harm the team can't undo:
//   publishing to farmers (a restriction, a notice, an outlook, and
//   withdrawing an outlook), deciding an application, endorsing a published
//   baseline, recording a signer's registration check, and signing, issuing
//   and withdrawing an evidence pack (requireStepUp / requireFreshCode).
// - Turning a project's or team's setting on needs the person to be signed in
//   with a second factor themselves (requireOwnSecondFactor), so a project
//   can't lock everyone out at once. Turning it off is an owner's (admin's)
//   action under the setting, so it is stepped up by the setting itself.
//
// Where it is checked: requireRole(…, 'owner') and requireTeamRole(…, 'admin')
// call requireProjectStepUp / requireTeamStepUp after the role check passes
// (so a non-member still gets the 404 and learns nothing), and the other
// actions above call the check they need themselves. A new owner-only route
// gets it without doing anything; the guard in stepUp.test.ts finds the
// owner and admin checks written by hand.
//
// How the route knows the session: requireUser runs the rest of the request
// inside `requestAuth` (AsyncLocalStorage) with the session's `amr`. Work
// outside a request (the job runner acting for whoever queued a job) has no
// store and isn't stepped up: no job kind needs more than editor, and the
// request that queued the job was checked.
//
// A fresh code (licensing positions item 9, provisional position, pre-counsel
// research, 2026-10-01): a sign-off (of a run or an evidence pack), issuing a
// pack and withdrawing one also need a code from the authenticator within the
// last ten minutes (FRESH_CODE_MS), not only at sign-in: a sign-off publishes
// a professional statement under a real name on the public verify page, so a
// session left open on a shared computer mustn't make one. requireFreshCode
// answers 401 `mfa_fresh_code` when the session's last code (the `otp_at`
// claim) is older; the client asks for a code, POSTs it to
// /auth/mfa/step-up, and repeats the action (lib/api/client.ts). A run's
// sign-off needs it only where the project requires two-step sign-in.
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
 * Whether `userId` has a confirmed second factor (an authenticator app). The
 * one place the step-up asks "is the account enrolled", so another kind of
 * factor is added here.
 */
export async function hasConfirmedFactor(db: Db, userId: string): Promise<boolean> {
	const { rows } = await db.query<{ enrolled: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL) AS enrolled',
		[userId]
	);
	return rows[0]?.enrolled ?? false;
}

/**
 * The 403 this request would get for want of a second factor, or null when it
 * has one (or the requirement is off, or there is no request). `mfa_required`:
 * the person has no authenticator yet (set one up on the Account page).
 * `mfa_step_up`: they have one, but this session signed in before it was
 * added: sign in again. A read can say so ahead of the action (a sign-off's
 * `cannotSign`), so nobody fills in a form the server will refuse. For the
 * actions that always need it; requireProjectStepUp for an owner's.
 */
export async function stepUpRefusal(db: Db, why = 'this needs two-step sign-in'): Promise<ApiError | null> {
	const auth = requestAuth.getStore();
	if (!auth || !mfaRequired()) return null;
	if (!(await hasConfirmedFactor(db, auth.userId))) {
		return ApiError.coded(403, 'mfa_required', `${why}: set up an authenticator app on your Account page first`);
	}
	if (!auth.amr.includes('otp')) {
		return ApiError.coded(403, 'mfa_step_up', `${why}: sign out and sign in again with a code from your authenticator app`);
	}
	return null;
}

/**
 * Whether the project's owner actions need two-step sign-in: its own setting,
 * or its team's (204_mfa_opt_in, app_project_requires_mfa). False when the
 * requirement is off (MFA_REQUIRED=false), outside a request, or for a
 * project the caller isn't a member of.
 */
export async function projectRequiresMfa(db: Db, projectId: string): Promise<boolean> {
	if (!requestAuth.getStore() || !mfaRequired()) return false;
	const { rows } = await db.query<{ required: boolean | null }>('SELECT app_project_requires_mfa($1) AS required', [projectId]);
	return rows[0]?.required ?? false;
}

/** Whether the team's admin actions need two-step sign-in (204_mfa_opt_in); false as projectRequiresMfa. */
export async function teamRequiresMfa(db: Db, teamId: string): Promise<boolean> {
	if (!requestAuth.getStore() || !mfaRequired()) return false;
	const { rows } = await db.query<{ required: boolean }>('SELECT require_mfa AS required FROM team WHERE id = $1', [teamId]);
	return rows[0]?.required ?? false;
}

/** stepUpRefusal, only where the project requires two-step sign-in (its setting or its team's). */
export async function projectStepUpRefusal(db: Db, projectId: string): Promise<ApiError | null> {
	return (await projectRequiresMfa(db, projectId)) ? stepUpRefusal(db, 'this project requires two-step sign-in') : null;
}

/** An owner's action on the project: 403 mfa_required / mfa_step_up when the project (or its team) requires two-step sign-in and this session hasn't it. */
export async function requireProjectStepUp(db: Db, projectId: string): Promise<void> {
	const refusal = await projectStepUpRefusal(db, projectId);
	if (refusal) throw refusal;
}

/** A team admin's action: 403 mfa_required / mfa_step_up when the team requires two-step sign-in and this session hasn't it. */
export async function requireTeamStepUp(db: Db, teamId: string): Promise<void> {
	if (!(await teamRequiresMfa(db, teamId))) return;
	const refusal = await stepUpRefusal(db, 'this team requires two-step sign-in');
	if (refusal) throw refusal;
}

/**
 * Turning a project's or team's requirement on: the person doing it must be
 * signed in with a second factor, so the setting can't lock out everyone at
 * once (the one who turned it on can always carry on). 403 mfa_required /
 * mfa_step_up otherwise, so the workspace's prompt shows as for any refused
 * action. Off with the requirement (MFA_REQUIRED=false).
 */
export async function requireOwnSecondFactor(db: Db): Promise<void> {
	const refusal = await stepUpRefusal(db, 'to require two-step sign-in here, you need it yourself');
	if (refusal) throw refusal;
}

/** 403 mfa_required / mfa_step_up unless this request's session signed in with a second factor and the account still has one. For the actions that always need it. */
export async function requireStepUp(db: Db): Promise<void> {
	const refusal = await stepUpRefusal(db);
	if (refusal) throw refusal;
}

/**
 * requireStepUp, and a code from the authenticator within the last ten
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
		throw ApiError.coded(401, 'mfa_fresh_code', 'this needs a code from your authenticator app from the last 10 minutes: enter one, then try again');
	}
}

/** Whether a code given at `otpAt` (epoch ms) still counts at `now`: no older than FRESH_CODE_MS, and not from the future beyond a minute's clock skew. */
export function freshCode(otpAt: number | null, now = Date.now()): boolean {
	return otpAt !== null && now - otpAt <= FRESH_CODE_MS && otpAt - now <= 60_000;
}

/** requireFreshCode, only where the project requires two-step sign-in: a run's sign-off (the setting off, it needs neither a factor nor a fresh code). */
export async function requireProjectFreshCode(db: Db, projectId: string, now = Date.now()): Promise<void> {
	if (await projectRequiresMfa(db, projectId)) await requireFreshCode(db, now);
}

