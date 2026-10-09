// A team admin removes a team member's second factor at once (205_mfa_recovery;
// docs/security.md § Two-step sign-in → Recovery, docs/api.md § Teams):
//
//   POST /teams/:id/members/:userId/mfa-reset → 204
//
// For a member who lost their phone and their recovery codes and can't wait
// the self-service reset's 3 days. Always behind a code from the last 10
// minutes (requireFreshCode), whatever the team's two-step setting: it takes
// a factor off someone else's account. Only for a member below admin
// (operator decision, 2026-10-08): another admin is refused (403
// mfa_reset_admin), so one admin's stolen session can't strip a co-admin's
// factor; a locked-out admin uses the self-service reset or the operator
// (deployment.md § Runbooks 14). Never the admin themselves either (the
// self-service reset is theirs). Every second factor of the
// member goes (mfa_remove_factors), every session of theirs is signed out,
// the member is emailed, and it is recorded on the team's projects
// (team_member.mfa_reset) and in the member's own security log
// (mfa.reset_by_admin). Someone outside the team gets the usual 404.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { requireFreshCode } from '../auth/stepUp.js';
import { withUser } from '../db/tx.js';
import { recordTeamAudit } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { mfaResetMail } from '../mail/templates.js';
import { trySendMail } from '../mail/transport.js';
import { UUID } from '../projects/access.js';
import { requireTeamRole } from './access.js';
import { memberSubject } from './routes.js';

export const teamMfaResetRoutes = new Hono<AuthEnv>().post('/:id/members/:userId/mfa-reset', async (c) => {
	const { id, userId } = c.req.param();
	// This server's clock, the one that stamps session iat_ms (as every watermark).
	const watermark = new Date();
	const mail = await withUser(c.get('userId'), async (db) => {
		await requireTeamRole(db, id, 'admin');
		await requireFreshCode(db);
		if (!UUID.test(userId)) throw new ApiError(404, 'not found');
		if (userId.toLowerCase() === c.get('userId').toLowerCase()) {
			throw new ApiError(409, 'you can’t remove your own two-step sign-in here: use “Lost your phone and your recovery codes?” when you sign in');
		}
		const subject = await memberSubject(db, id, userId);
		if (!subject) throw new ApiError(404, 'not found');
		const { rows } = await db.query<{ status: 'not_found' | 'self' | 'co_admin' | 'not_enrolled' | 'done'; email: string | null; locale: string | null }>(
			'SELECT status, email, locale FROM app_mfa_team_reset($1, $2, $3)',
			[id, userId, watermark]
		);
		const r = rows[0]!;
		if (r.status === 'not_found') throw new ApiError(404, 'not found');
		if (r.status === 'self') throw new ApiError(409, 'you can’t remove your own two-step sign-in here');
		if (r.status === 'co_admin') {
			throw ApiError.coded(
				403,
				'mfa_reset_admin',
				'a team admin can’t remove another admin’s two-step sign-in: they use “Lost your phone and your recovery codes?” when they sign in'
			);
		}
		if (r.status === 'not_enrolled') throw new ApiError(409, 'this member hasn’t set up two-step sign-in');
		await recordTeamAudit(db, id, 'team_member.mfa_reset', subject);
		return mfaResetMail(r.email!, { stage: 'admin', team: String(subject.team) }, r.locale);
	});
	// After the commit, and never failing the request.
	await trySendMail(mail);
	return c.body(null, 204);
});
