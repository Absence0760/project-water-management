import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { safeError, stackFrames } from '../logging/safeError.js';
import { logEvent } from '../logging/logEvent.js';

/**
 * Throw from a handler to return `{ error }` with a status. `error` is
 * English for developers and integrators; the translated pages never show it.
 */
export class ApiError extends Error {
	/** A stable, farmer-visible error code (ERROR_CODES); the translated pages word it from their catalogue. */
	code?: ErrorCode;
	/** Values the client's wording fills in (e.g. `seconds` for a lockout). */
	params?: Record<string, number | string>;

	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}

	/**
	 * An error a farmer can meet on a translated page (the sign-in, account,
	 * alert and farm pages): the response carries `code` (and `params`), which
	 * the client words in the reader's language (docs/api.md § Errors). The
	 * English `message` stays for everyone else. `details`: data the page shows
	 * as it is (the names in account_sole_holder), never words.
	 */
	static coded(status: ApiError['status'], code: ErrorCode, message: string, params?: Record<string, number | string>, details?: unknown): ApiError {
		const e = new ApiError(status, message, details);
		e.code = code;
		if (params) e.params = params;
		return e;
	}
}

/**
 * Every error code the API sends (docs/api.md § Errors). A code is a
 * contract: the frontend words each one (`CODES` in
 * frontend/src/lib/i18n/apiError.ts; apiError.test.ts), so rename none; add new ones.
 * Errors without a code are worded on the client by their status.
 */
export const ERROR_CODES = [
	'not_signed_in',
	'account_exists',
	'wrong_credentials',
	'email_unconfirmed',
	'signin_locked',
	'signup_throttled',
	'terms_not_accepted',
	'farm_notice_changed',
	'wrong_current_password',
	'password_changed_elsewhere',
	'link_invalid',
	'already_verified',
	'verification_sent_recently',
	'verification_limit',
	'invite_invalid',
	'note_farmer_own_farm',
	'note_farm_visibility',
	'note_author_only',
	'note_delete_denied',
	'note_comment_closed',
	'note_audience_denied',
	'unsubscribe_link_gone',
	'feedback_link_gone',
	'export_throttled',
	'alerts_resume_throttled',
	'body_refused',
	'run_unverified',
	'account_sole_holder',
	// Two-step sign-in (issue #282, auth/mfa-routes.ts, auth/stepUp.ts).
	'mfa_code_wrong',
	'mfa_locked',
	'mfa_challenge_expired',
	'mfa_already_enrolled',
	'mfa_not_started',
	'mfa_not_enrolled',
	'mfa_required',
	'mfa_step_up',
	// A comment through a share link (166_public_participation, share/routes.ts): 10 an hour per account.
	'comment_throttled'
] as const;

/**
 * Codes a translated page never meets (a machine client reads them, or the
 * English workspace, which shows the server's message as it is), so they
 * have no words in the frontend's `CODES` (docs/api.md § Errors). The same
 * contract: add new ones, rename none.
 *   render_token_refused: POST /auth/render-session refused the token (used,
 *     expired, or the requester lost access). The report renderer
 *     (reports/render.ts) treats only this as final; any other refusal (a
 *     WAF or CloudFront 403, a 429, a 5xx) is retried.
 *   pack_errata_since_draft: POST …/packs/:packId/issue refused a draft
 *     because an erratum found since it was drafted applies to its runs'
 *     engines (or their fits') and its manifest doesn't record it: draft the
 *     pack again (evidence/packs.ts).
 *   registration_not_checked: POST …/packs/:packId/issue refused a draft
 *     whose specialist signer's registration has no current check against
 *     the professional register (167_signers, signoffs/registrationCheck.ts);
 *     `details.signers` names them.
 *   mfa_fresh_code (401): a sign-off, or issuing or withdrawing a pack,
 *     needs a code from the authenticator within the last 10 minutes
 *     (auth/stepUp.ts requireFreshCode). The client asks for one, POSTs it to
 *     /auth/mfa/step-up and repeats the request (lib/api/client.ts).
 *   role_conflict: the change would make someone who edits the project
 *     (editor or owner, directly or through its team) also part of an
 *     applying party there: in a party, owning an application or shared
 *     one (163_licensing_authority's conflict guard). The member list and
 *     sharing are English workspace pages.
 */
export const MACHINE_ERROR_CODES = ['render_token_refused', 'pack_errata_since_draft', 'registration_not_checked', 'mfa_fresh_code', 'role_conflict'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number] | (typeof MACHINE_ERROR_CODES)[number];

export const notFound = () => new ApiError(404, 'not found');

/**
 * A write on the row a route already authorised must change it. Zero rows
 * means RLS, the second layer behind the route's role check, refused it:
 * answer what a non-member gets rather than a silent success (issue #56).
 */
export function mustChange(r: { rowCount: number | null }): void {
	if (!r.rowCount) throw notFound();
}

/** 409 role_conflict's words (163_licensing_authority): fixed, never the database's text. */
export const ROLE_CONFLICT_MESSAGE =
	'someone who edits this project (an editor or owner, directly or through its team) can’t also be in an applying party, own an application or be shared one here: take them out of the party, or keep them below editor';

/** Postgres SQLSTATE codes we translate into client errors. */
const PG_UNIQUE = '23505';
const PG_FK = '23503';
const PG_CHECK = '23514';
const PG_EXCLUSION = '23P01';
const PG_RLS = '42501';

export function handleError(err: unknown, c: Context) {
	if (err instanceof ApiError) {
		return c.json(
			{
				error: err.message,
				...(err.code ? { code: err.code } : {}),
				...(err.params ? { params: err.params } : {}),
				...(err.details ? { details: err.details } : {})
			},
			err.status
		);
	}
	if (err instanceof ZodError) {
		return c.json({ error: 'invalid request', details: err.issues }, 400);
	}
	// A body streamed without Content-Length that outgrows a bodyLimit fails
	// the handler's read; the bodyLimit middleware then answers with its own
	// 413 message. Not a server fault, so it isn't logged.
	if (err instanceof Error && err.name === 'BodyLimitError') {
		return c.json({ error: 'request too large' }, 413);
	}
	if (err instanceof HTTPException) {
		return c.json({ error: err.message || 'error' }, err.status);
	}
	const code = (err as { code?: string }).code;
	if (code === PG_UNIQUE) return c.json({ error: 'already exists' }, 409);
	// Never echo raw database error text — it leaks schema details.
	if (code === PG_FK) return c.json({ error: 'references something that does not exist in this project' }, 400);
	// 163's conflict guard names itself, so the client can say what to change.
	if (code === PG_CHECK && (err as { constraint?: string }).constraint === 'role_conflict')
		return c.json({ error: ROLE_CONFLICT_MESSAGE, code: 'role_conflict' satisfies ErrorCode }, 409);
	if (code === PG_CHECK) return c.json({ error: 'violates a data rule' }, 409);
	// An exclusion constraint (e.g. one issued evidence pack per application, 112): a conflict with another row.
	if (code === PG_EXCLUSION) return c.json({ error: 'conflicts with another record' }, 409);
	// RLS WITH CHECK failures surface as insufficient_privilege.
	if (code === PG_RLS) return c.json({ error: 'forbidden' }, 403);
	// Answering 500 means the Lambda invocation itself succeeds, so the
	// function's `Errors` metric never counts it. Log one structured line
	// instead, which the unhandled-error alarm counts (infra/alarms.tf,
	// `unhandled_error`). Only the error's name, code and stack frames and the
	// route's pattern go in (safeError): never its message, which for a pg
	// error can carry row values and for anything else user input, and never
	// the concrete path, which can hold a token.
	logEvent('error', {
		event: 'unhandled_error',
		method: c.req.method,
		route: c.req.routePath,
		...safeError(err),
		at: stackFrames(err)
	});
	return c.json({ error: 'Internal server error' }, 500);
}
