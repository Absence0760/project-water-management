// Recovering a lost second factor, the person's own way (205_mfa_recovery;
// auth/mfaReset.ts; docs/api.md § Two-step sign-in, docs/security.md
// § Two-step sign-in → Recovery). Mounted under /auth. All three are public:
//
//   POST /mfa/reset          the `wm_mfa` challenge cookie (a right password, just now) → a confirmation link emailed
//   POST /mfa/reset/confirm  { token } from that email → the 3-day wait starts; its first cancel link emailed
//   POST /mfa/reset/cancel   { token } from any email of the wait → the wait ends, nothing removed
//
// Asking needs what the code step itself needs (the challenge only a right
// password buys), and answers only that person: an attacker without the
// password can't reach it. A team admin's reset of a member is
// teams/mfa-reset-routes.ts.
import { Hono } from 'hono';
import { z } from 'zod';
import { withoutUser, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { readJson } from '../http/body.js';
import { mfaResetMail, siteLink } from '../mail/templates.js';
import { trySendMail, type Mail } from '../mail/transport.js';
import type { AuthEnv } from './middleware.js';
import { logLoginFailed, type LoginFailureRoute } from './loginFailed.js';
import { clearMfaChallenge, readMfaChallenge } from './session.js';
import { cancelReset, confirmReset, MFA_RESET_CONFIRM_PATH, noticeFailed, requestReset } from './mfaReset.js';
import { parseToken } from './tokens.js';

const TokenBody = z.object({ token: z.string().max(200) });

/** Refuse a confirmation or cancel token, logging the failure (auth/loginFailed.ts), as the reset-password link does. */
function invalidLink(route: LoginFailureRoute): ApiError {
	logLoginFailed(route, 'invalid_link');
	return ApiError.coded(400, 'link_invalid', 'this link is invalid or has expired');
}

export const mfaResetRoutes = new Hono<AuthEnv>()
	// "Lost your phone and your recovery codes?" at the sign-in's code step.
	// 202 { sent }: a link is on its way (or, with no factor to reset, nothing
	// is, which only its owner can tell). 200 { pending, effectiveAt }: a
	// confirmed reset already waits. 429 mfa_reset_limit: MFA_RESET_CAP asks
	// a day. The challenge is not used up: the person may still find a code.
	.post('/mfa/reset', async (c) => {
		const challenge = await readMfaChallenge(c);
		if (!challenge) {
			clearMfaChallenge(c);
			throw ApiError.coded(401, 'mfa_challenge_expired', 'your sign-in timed out: enter your email and password again');
		}
		const userId = challenge.userId;
		const out = await withUser(userId, async (db) => {
			const r = await requestReset(db);
			if (r.status !== 'issued') return { r, mail: null as Mail | null };
			const { rows } = await db.query<{ email: string; locale: string | null }>('SELECT email, locale FROM app_user WHERE id = $1', [userId]);
			const me = rows[0]!;
			return { r, mail: mfaResetMail(me.email, { stage: 'confirm', url: siteLink(MFA_RESET_CONFIRM_PATH, r.token) }, me.locale) };
		});
		c.header('Cache-Control', 'no-store');
		if (out.r.status === 'capped') {
			logLoginFailed('/auth/mfa/reset', 'locked');
			throw ApiError.coded(429, 'mfa_reset_limit', 'you asked for this a few times today already: check your inbox, or try again tomorrow');
		}
		if (out.r.status === 'pending') return c.json({ pending: true as const, effectiveAt: out.r.effectiveAt.toISOString() });
		// Sent after the commit, so the link always names a stored request.
		if (out.mail) await trySendMail(out.mail);
		return c.json({ sent: true as const }, 202);
	})
	.post('/mfa/reset/confirm', async (c) => {
		const body = TokenBody.parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw invalidLink('/auth/mfa/reset/confirm');
		const started = await withoutUser((db) => confirmReset(db, hash));
		if (!started) throw invalidLink('/auth/mfa/reset/confirm');
		// Unsent, the owner would have no cancel link until tomorrow's reminder: the next tick sends one instead.
		if (!(await trySendMail(started.mail))) await withoutUser((db) => noticeFailed(db, started.cancelHash));
		return c.json({ effectiveAt: started.effectiveAt.toISOString() });
	})
	.post('/mfa/reset/cancel', async (c) => {
		const body = TokenBody.parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw invalidLink('/auth/mfa/reset/cancel');
		const userId = await withoutUser((db) => cancelReset(db, hash));
		if (!userId) throw invalidLink('/auth/mfa/reset/cancel');
		return c.json({ cancelled: true as const });
	});
