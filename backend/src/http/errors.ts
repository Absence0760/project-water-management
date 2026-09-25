import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

/** Throw from a handler to return `{ error }` with a status. */
export class ApiError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export const notFound = () => new ApiError(404, 'not found');

/** Postgres SQLSTATE codes we translate into client errors. */
const PG_UNIQUE = '23505';
const PG_FK = '23503';
const PG_CHECK = '23514';
const PG_RLS = '42501';

export function handleError(err: unknown, c: Context) {
	if (err instanceof ApiError) {
		return c.json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
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
