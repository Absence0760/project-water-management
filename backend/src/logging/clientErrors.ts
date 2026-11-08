// POST /client-errors: a page crash in the browser, reported by the SPA's
// handleError hook (frontend/src/hooks.client.ts) so the operator can find
// what threw from the error id the error page shows (docs/api.md § Client
// error reports). Signed-in users only. Nothing is stored: the report becomes
// one `client_error` log line in the API's log group, and the answer is an
// empty 204 that echoes nothing back (docs/security.md § Client error reports).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from './logEvent.js';

/** The longest each field may be; the frontend truncates to the same (frontend/src/clientErrors.ts). */
export const CLIENT_ERROR_LIMITS = { name: 200, message: 500, stack: 4000, path: 500, version: 100 } as const;

export const ClientErrorReport = z
	.object({
		/** The error id the error page shows: 8 hex digits. */
		id: z.string().regex(/^[0-9a-f]{8}$/),
		status: z.number().int().min(100).max(599),
		name: z.string().max(CLIENT_ERROR_LIMITS.name),
		message: z.string().max(CLIENT_ERROR_LIMITS.message),
		stack: z.string().max(CLIENT_ERROR_LIMITS.stack),
		path: z.string().max(CLIENT_ERROR_LIMITS.path),
		version: z.string().max(CLIENT_ERROR_LIMITS.version)
	})
	.strict();

export const clientErrorRoutes = new Hono<AuthEnv>();

clientErrorRoutes.post('/', async (c) => {
	const parsed = ClientErrorReport.safeParse(await readJson(c));
	// No zod details: an unknown key's name is the caller's own input, and nothing of it is echoed back.
	if (!parsed.success) throw new ApiError(400, 'invalid error report');
	const r = parsed.data;
	logEvent('error', {
		event: 'client_error',
		id: r.id,
		userId: c.get('userId'),
		status: r.status,
		name: r.name,
		message: r.message,
		stack: r.stack,
		path: r.path,
		version: r.version
	});
	return c.body(null, 204);
});
