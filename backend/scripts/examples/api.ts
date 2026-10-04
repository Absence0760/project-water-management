// The app's own HTTP API, called in process as a signed-in demo user, for the
// seed steps that are easiest to get right the way the app does them: every
// body goes through the route's validation, role checks, RLS (withUser),
// audit events and side effects, exactly as a click in the browser would.
// DEV-ONLY: it mints a session for a local demo account, as signing in would.
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, signSession } from '../../src/auth/session.js';

export type ApiCall = <T = any>(method: string, path: string, body?: unknown) => Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: ReturnType<typeof createApp> | null = null;

/**
 * A caller acting as `userId`. A response outside 2xx throws with the
 * route's error, so a seed step never fails silently.
 *
 * Owner actions want a two-step sign-in (auth/stepUp.ts) unless MFA_REQUIRED
 * is false. The demo accounts have no authenticator, so the seed turns the
 * requirement off in its own process only, as `.env.development.local`
 * documents for local dev; nothing it does signs or issues anything.
 */
export async function apiAs(userId: string): Promise<ApiCall> {
	process.env.MFA_REQUIRED = 'false';
	app ??= createApp();
	const origin = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:7777').split(',')[0]!.trim();
	const cookie = `${SESSION_COOKIE}=${await signSession(userId)}`;
	return async (method, path, body) => {
		const r = await app!.request(path, {
			method,
			headers: { cookie, origin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		const text = await r.text();
		if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 4000)}`);
		return text ? JSON.parse(text) : null;
	};
}
