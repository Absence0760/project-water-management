import type { Context } from 'hono';
import { ApiError } from './errors.js';

/**
 * The request body parsed as JSON. A body that isn't JSON is the client's
 * mistake, so it is a 400, not the 500 that `c.req.json()`'s SyntaxError
 * would become in `handleError`.
 */
export async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch (err) {
		if (err instanceof SyntaxError) throw new ApiError(400, 'invalid JSON');
		throw err;
	}
}
