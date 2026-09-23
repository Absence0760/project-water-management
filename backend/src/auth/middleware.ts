import { createMiddleware } from 'hono/factory';
import { ApiError } from '../http/errors.js';
import { readSession } from './session.js';

export type AuthEnv = { Variables: { userId: string } };

/** Rejects with 401 unless the request carries a valid session. */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
	const userId = await readSession(c);
	if (!userId) throw new ApiError(401, 'not signed in');
	c.set('userId', userId);
	await next();
});
