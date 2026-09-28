import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

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
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}

	/**
	 * An error a farmer can meet on a translated page (the sign-in, account,
	 * alert and farm pages): the response carries `code` (and `params`), which
	 * the client words in the reader's language (docs/api.md § Errors). The
	 * English `message` stays for everyone else.
	 */
	static coded(status: ApiError['status'], code: ErrorCode, message: string, params?: Record<string, number | string>): ApiError {
		const e = new ApiError(status, message);
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
	'unsubscribe_link_gone',
	'export_throttled',
	'alerts_resume_throttled',
	'body_refused',
	'run_unverified'
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const notFound = () => new ApiError(404, 'not found');

/**
 * A write on the row a route already authorised must change it. Zero rows
 * means RLS, the second layer behind the route's role check, refused it:
 * answer what a non-member gets rather than a silent success (issue #56).
 */
export function mustChange(r: { rowCount: number | null }): void {
	if (!r.rowCount) throw notFound();
}

/** Postgres SQLSTATE codes we translate into client errors. */
const PG_UNIQUE = '23505';
const PG_FK = '23503';
const PG_CHECK = '23514';
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
	if (code === PG_CHECK) return c.json({ error: 'violates a data rule' }, 409);
	// RLS WITH CHECK failures surface as insufficient_privilege.
	if (code === PG_RLS) return c.json({ error: 'forbidden' }, 403);
	console.error('Unhandled error', err);
	return c.json({ error: 'Internal server error' }, 500);
}
