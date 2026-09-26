import { createMiddleware } from 'hono/factory';
import { ApiError } from '../http/errors.js';
import { scopeAllows } from '../reports/scope.js';
import { readSessionClaims } from './session.js';

export type AuthEnv = { Variables: { userId: string } };

/**
 * Rejects with 401 unless the request carries a valid session. A render
 * session (the headless report renderer's, reports/scope.ts) is refused with
 * 403 outside the one project and run it was issued for.
 */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
	const session = await readSessionClaims(c);
	if (!session) throw new ApiError(401, 'not signed in');
	if (session.scope && !scopeAllows(session.scope, c.req.method, c.req.path)) {
		throw new ApiError(403, 'this session can only read one report');
	}
	c.set('userId', session.userId);
	await next();
});
