import { createMiddleware } from 'hono/factory';
import { ApiError } from '../http/errors.js';
import { scopeAllows } from '../reports/scope.js';
import { readSessionClaims } from './session.js';

/**
 * `edgeVerified`: the request passed the CloudFront shared-secret check (app.ts), so the edge's headers can be trusted (http/clientAddress.ts).
 * `renderSession`: the session is the report renderer's (a `scope` claim, reports/scope.ts), set by requireUser.
 */
export type AuthEnv = { Variables: { userId: string; edgeVerified: boolean; renderSession?: boolean } };

/**
 * Rejects with 401 unless the request carries a valid session. A render
 * session (the headless report renderer's, reports/scope.ts) is refused with
 * 403 outside the one project and run it was issued for (and, for an impact
 * report, its one comparison with the baseline).
 */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
	const session = await readSessionClaims(c);
	if (!session) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
	if (session.scope && !scopeAllows(session.scope, c.req.method, c.req.path, new URL(c.req.url).searchParams)) {
		throw new ApiError(403, 'this session can only read one report');
	}
	c.set('userId', session.userId);
	c.set('renderSession', !!session.scope);
	await next();
});
