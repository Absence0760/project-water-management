import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { UUID } from '../projects/access.js';

type TeamRole = 'member' | 'admin';
const RoleEnum = z.enum(['member', 'admin']);
const Name = z.string().trim().min(1).max(200);

/** 404 unless the current user is in the team; 403 if `admin` is required and they aren't. */
async function requireTeamRole(db: Db, teamId: string, min: TeamRole): Promise<TeamRole> {
	if (!UUID.test(teamId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<{ role: TeamRole | null }>('SELECT app_team_role($1) AS role', [teamId]);
	const role = rows[0]?.role;
	if (!role) throw new ApiError(404, 'not found');
	if (min === 'admin' && role !== 'admin') throw new ApiError(403, 'requires team admin');
	return role;
}

async function assertNotLastAdmin(db: Db, teamId: string, userId: string) {
	const { rows } = await db.query<{ admins: number; target_is_admin: boolean }>(
		`SELECT count(*) FILTER (WHERE role = 'admin')::int AS admins,
			bool_or(user_id = $2 AND role = 'admin') AS target_is_admin
		 FROM team_member WHERE team_id = $1`,
		[teamId, userId]
	);
	if (rows[0]?.target_is_admin && rows[0].admins <= 1) throw new ApiError(409, 'a team must keep at least one admin');
}

const TEAM_SUMMARY = `t.id, t.name, app_team_role(t.id) AS role, t.created_at AS "createdAt",
	(SELECT count(*)::int FROM team_member m WHERE m.team_id = t.id) AS "memberCount",
	(SELECT count(*)::int FROM project p WHERE p.team_id = t.id) AS "projectCount"`;

async function getTeam(db: Db, id: string) {
	const { rows } = await db.query(`SELECT ${TEAM_SUMMARY} FROM team t WHERE t.id = $1`, [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

export const teamRoutes = new Hono<AuthEnv>()
	.get('/', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query(`SELECT ${TEAM_SUMMARY} FROM team t ORDER BY t.name`);
			return c.json({ teams: rows });
		})
	)
	.post('/', async (c) => {
		const body = z.object({ name: Name }).parse(await c.req.json());
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
			await requireTeamRole(db, id, 'member');
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
		const body = z.object({ name: Name }).parse(await c.req.json());
		return withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'admin');
			await db.query('UPDATE team SET name = $2 WHERE id = $1', [id, body.name]);
			return c.json({ team: await getTeam(db, id) });
		});
	})
	.delete('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'admin');
			// Projects stay, owned by their direct members (team_id → NULL).
			await db.query('DELETE FROM team WHERE id = $1', [id]);
			return c.body(null, 204);
		})
	)
	.post('/:id/members', async (c) => {
		const body = z.object({ email: z.string().trim().toLowerCase().email(), role: RoleEnum }).parse(await c.req.json());
		return withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireTeamRole(db, id, 'admin');
			const { rows: users } = await db.query<{ id: string; email: string; display_name: string }>(
				'SELECT id, email, display_name FROM app_user WHERE email = $1',
				[body.email]
			);
			const user = users[0];
			if (!user) throw new ApiError(404, 'no account with that email — ask them to register first');
			const { rowCount } = await db.query(
				'INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
				[id, user.id, body.role]
			);
			if (!rowCount) throw new ApiError(409, 'already a member');
			return c.json({ member: { userId: user.id, email: user.email, displayName: user.display_name, role: body.role } }, 201);
		});
	})
	.patch('/:id/members/:userId', async (c) => {
		const body = z.object({ role: RoleEnum }).parse(await c.req.json());
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireTeamRole(db, id, 'admin');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			if (body.role !== 'admin') await assertNotLastAdmin(db, id, userId);
			const { rows } = await db.query(
				`UPDATE team_member m SET role = $3 FROM app_user u
				 WHERE m.team_id = $1 AND m.user_id = $2 AND u.id = m.user_id
				 RETURNING m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role`,
				[id, userId, body.role]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			return c.json({ member: rows[0] });
		});
	})
	.delete('/:id/members/:userId', async (c) => {
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireTeamRole(db, id, 'member');
			if (userId !== c.get('userId') && role !== 'admin') throw new ApiError(403, 'requires team admin');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			await assertNotLastAdmin(db, id, userId);
			const { rowCount } = await db.query('DELETE FROM team_member WHERE team_id = $1 AND user_id = $2', [id, userId]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});
