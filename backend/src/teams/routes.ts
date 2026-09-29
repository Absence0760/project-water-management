import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { ApiError, mustChange } from '../http/errors.js';
import { accountByEmail, countInvites, inviteByEmail } from '../invites/invites.js';
import { trySendMail } from '../mail/transport.js';
import { UUID } from '../projects/access.js';
import { requireTeamRole, TEAM_ROLES, type TeamRole } from './access.js';
import { readJson } from '../http/body.js';
import { recordTeamAudit } from '../history/record.js';
import { applySettingsPatch, appliedThresholds, teamThresholds, TeamSettingsPatch } from './settings.js';

const RoleEnum = z.enum(TEAM_ROLES);
const Name = z.string().trim().min(1).max(200);

async function assertNotLastAdmin(db: Db, teamId: string, userId: string) {
	const { rows } = await db.query<{ admins: number; target_is_admin: boolean }>(
		`SELECT count(*) FILTER (WHERE role = 'admin')::int AS admins,
			bool_or(user_id = $2 AND role = 'admin') AS target_is_admin
		 FROM team_member WHERE team_id = $1`,
		[teamId, userId]
	);
	if (rows[0]?.target_is_admin && rows[0].admins <= 1) throw new ApiError(409, 'a team must keep at least one owner');
}

/** The project role a team role gives on every team project (app_project_role, 008_team_viewer). */
const PROJECT_ROLE: Record<TeamRole, string> = { viewer: 'viewer', member: 'editor', admin: 'owner' };

/** A team member as a team_member.* audit subject names them: the team, the person, their team role and what it makes them here. */
async function memberSubject(db: Db, teamId: string, userId: string): Promise<Record<string, unknown> | null> {
	const { rows } = await db.query<{ team: string; display_name: string; role: TeamRole }>(
		`SELECT t.name AS team, u.display_name, m.role FROM team_member m JOIN team t ON t.id = m.team_id JOIN app_user u ON u.id = m.user_id
		 WHERE m.team_id = $1 AND m.user_id = $2`,
		[teamId, userId]
	);
	const r = rows[0];
	return r ? { teamId, team: r.team, userId, displayName: r.display_name, teamRole: r.role, role: PROJECT_ROLE[r.role] } : null;
}

const TEAM_SUMMARY = `t.id, t.name, app_team_role(t.id) AS role, t.created_at AS "createdAt",
	(SELECT count(*)::int FROM team_member m WHERE m.team_id = t.id) AS "memberCount",
	(SELECT count(*)::int FROM project p WHERE p.team_id = t.id) AS "projectCount",
	t.settings`;

/** A team as the API returns it: the stored settings, and the portfolio thresholds they come to (the team's or the defaults). */
const toTeam = <T extends { settings: unknown }>(row: T) => ({ ...row, portfolioThresholds: appliedThresholds(row.settings) });

async function getTeam(db: Db, id: string) {
	const { rows } = await db.query<{ settings: unknown }>(`SELECT ${TEAM_SUMMARY} FROM team t WHERE t.id = $1`, [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return toTeam(rows[0]);
}

const TeamPatch = z
	.object({ name: Name.optional(), settings: TeamSettingsPatch.optional() })
	.strict()
	.refine((b) => b.name !== undefined || b.settings !== undefined, { message: 'nothing to change: send name or settings' });

/**
 * Change the team's settings (admin; the caller checked). Records
 * `team_thresholds.changed` on each of the team's projects when the
 * thresholds that apply changed; a save that changes nothing records nothing.
 */
async function patchSettings(db: Db, id: string, patch: TeamSettingsPatch) {
	// The row lock makes `before` the state this change replaces, even with two admins saving at once.
	const { rows } = await db.query<{ name: string; settings: unknown }>('SELECT name, settings FROM team WHERE id = $1 FOR UPDATE', [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	const next = applySettingsPatch(rows[0].settings, patch);
	const before = teamThresholds(rows[0].settings);
	const after = teamThresholds(next);
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	mustChange(await db.query('UPDATE team SET settings = $2 WHERE id = $1', [id, JSON.stringify(next)]));
	// null = the defaults: the log says which numbers applied before and after.
	await recordTeamAudit(db, id, 'team_thresholds.changed', {
		teamId: id,
		team: rows[0].name,
		from: appliedThresholds(rows[0].settings),
		to: appliedThresholds(next)
	});
}

export const teamRoutes = new Hono<AuthEnv>()
	.get('/', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<{ settings: unknown }>(`SELECT ${TEAM_SUMMARY} FROM team t ORDER BY t.name`);
			return c.json({ teams: rows.map(toTeam) });
		})
	)
	.post('/', async (c) => {
		const body = z.object({ name: Name }).parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			// Id generated here: RETURNING would be checked against team_select
			// before the AFTER trigger has made the creator a member.
			const id = crypto.randomUUID();
			await db.query('INSERT INTO team (id, name, created_by) VALUES ($1, $2, app_current_user_id())', [id, body.name]);
			return c.json({ team: await getTeam(db, id) }, 201);
		});
	})
	.get('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'viewer');
			const { rows: members } = await db.query(
				`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role
				 FROM team_member m JOIN app_user u ON u.id = m.user_id WHERE m.team_id = $1
				 ORDER BY m.role DESC, u.display_name`,
				[id]
			);
			return c.json({ team: await getTeam(db, id), members });
		})
	)
	.patch('/:id', async (c) => {
		const body = TeamPatch.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'admin');
			if (body.name !== undefined) mustChange(await db.query('UPDATE team SET name = $2 WHERE id = $1', [id, body.name]));
			if (body.settings) await patchSettings(db, id, body.settings);
			return c.json({ team: await getTeam(db, id) });
		});
	})
	.delete('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'admin');
			// Recorded first, while the projects are still the team's: every member
			// loses the access the team gave them on each one.
			const { rows } = await db.query<{ name: string; members: number }>(
				'SELECT t.name, (SELECT count(*)::int FROM team_member m WHERE m.team_id = t.id) AS members FROM team t WHERE t.id = $1',
				[id]
			);
			if (rows[0]) await recordTeamAudit(db, id, 'team.deleted', { teamId: id, team: rows[0].name, members: rows[0].members });
			// Projects stay, owned by their direct members (team_id → NULL).
			mustChange(await db.query('DELETE FROM team WHERE id = $1', [id]));
			return c.body(null, 204);
		})
	)
	// Every add by email is an invite (issue #136), as for a project's members:
	// one answer whether or not the address has an account.
	.post('/:id/members', async (c) => {
		const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: RoleEnum }).parse(await readJson(c));
		const invited = await withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'admin');
			// The daily cap on adding by email (101_invite_throttle), counted before the address is looked up.
			await countInvites(c, db, 'team', id, 1);
			const account = await accountByEmail(db, body.email);
			// Already on the member list the admin can read: saying so tells them nothing new.
			if (account?.verified) {
				const { rows } = await db.query('SELECT 1 FROM team_member WHERE team_id = $1 AND user_id = $2', [id, account.id]);
				if (rows[0]) throw new ApiError(409, 'already a member');
			}
			return inviteByEmail(db, 'team', id, body.email, body.role, account);
		});
		// Mail goes out after the transaction commits, and never fails the request.
		if (invited.mail) await trySendMail(invited.mail);
		return c.json({ invited: true, invite: invited.invite }, 201);
	})
	.patch('/:id/members/:userId', async (c) => {
		const body = z.object({ role: RoleEnum }).parse(await readJson(c));
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireTeamRole(db, id, 'admin');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			if (body.role !== 'admin') await assertNotLastAdmin(db, id, userId);
			const before = await memberSubject(db, id, userId);
			const { rows } = await db.query(
				`UPDATE team_member m SET role = $3 FROM app_user u
				 WHERE m.team_id = $1 AND m.user_id = $2 AND u.id = m.user_id
				 RETURNING m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role`,
				[id, userId, body.role]
			);
			if (!rows[0] || !before) throw new ApiError(404, 'not found');
			if (before.teamRole !== body.role) {
				await recordTeamAudit(db, id, 'team_member.role', { ...before, teamRole: body.role, role: PROJECT_ROLE[body.role], from: before.teamRole, to: body.role });
			}
			return c.json({ member: rows[0] });
		});
	})
	.delete('/:id/members/:userId', async (c) => {
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireTeamRole(db, id, 'viewer');
			if (userId !== c.get('userId') && role !== 'admin') throw new ApiError(403, 'requires team admin');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			await assertNotLastAdmin(db, id, userId);
			// Recorded before the row goes, while the leaver can still write events on the team's projects.
			const subject = await memberSubject(db, id, userId);
			if (!subject) throw new ApiError(404, 'not found');
			await recordTeamAudit(db, id, 'team_member.removed', { ...subject, self: userId === c.get('userId') });
			const { rowCount } = await db.query('DELETE FROM team_member WHERE team_id = $1 AND user_id = $2', [id, userId]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});
