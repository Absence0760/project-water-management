import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { dropInvite, inviteByEmail } from '../invites/invites.js';
import { trySendMail } from '../mail/transport.js';
import { loadModel, saveModel } from '../model/store.js';
import { requireRole, UUID, type Role } from './access.js';
import { mergeSettings, patchSettings, SettingsPatch } from './settings.js';
import { readJson } from '../http/body.js';

type ProjectRow = {
	id: string;
	name: string;
	description: string;
	team_id: string | null;
	team_name: string | null;
	settings: unknown;
	role: Role;
	created_at: Date;
	updated_at: Date;
	/** Last day covered by any of the project's time series ('YYYY-MM-DD'), or null. */
	data_until: string | null;
	last_run_at: Date | null;
};

const summary = (r: ProjectRow) => ({
	id: r.id,
	name: r.name,
	description: r.description,
	role: r.role,
	team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
	dataUntil: r.data_until,
	lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null
});
const full = (r: ProjectRow) => ({ ...summary(r), settings: mergeSettings(r.settings) });

// RLS already limits rows to projects the user can see (directly or via a
// team); app_project_role gives the effective role. The team name is only
// visible to team members (team RLS), so it may be null for direct members.
const SELECT_PROJECT = `
	SELECT p.id, p.name, p.description, p.settings, p.created_at, p.updated_at, p.team_id,
		t.name AS team_name, app_project_role(p.id) AS role,
		-- Data freshness and last run for the project list, in the same query
		-- (both subqueries use the (project_id…) indexes; no N+1 from the client).
		(SELECT max(ts.start_date + cardinality(ts."values") - 1) FROM time_series ts
			WHERE ts.project_id = p.id AND cardinality(ts."values") > 0) AS data_until,
		(SELECT max(r.created_at) FROM model_run r WHERE r.project_id = p.id) AS last_run_at
	FROM project p LEFT JOIN team t ON t.id = p.team_id`;

const name = z.string().trim().min(1).max(200);
const CreateBody = z.object({ name, description: z.string().max(5000).optional(), teamId: z.string().uuid().nullable().optional() });
const PatchBody = z.object({
	name: name.optional(),
	/** Move the project into a team you belong to (null = personal). Owner only. */
	teamId: z.string().uuid().nullable().optional(),
	description: z.string().max(5000).optional(),
	settings: SettingsPatch.optional()
});
const RoleEnum = z.enum(['viewer', 'editor', 'owner']);

async function getProject(db: import('../db/tx.js').Db, id: string) {
	const { rows } = await db.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

export const projectRoutes = new Hono<AuthEnv>()
	.get('/', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<ProjectRow>(`${SELECT_PROJECT} ORDER BY p.updated_at DESC`);
			return c.json({ projects: rows.map(summary) });
		})
	)
	.post('/', async (c) => {
		const body = CreateBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			// Id generated here, not via RETURNING: RLS checks RETURNING rows against
			// the SELECT policy before the AFTER trigger has made us a member.
			const id = crypto.randomUUID();
			if (body.teamId) await requireTeamMember(db, body.teamId);
			await db.query(
				`INSERT INTO project (id, name, description, created_by, team_id) VALUES ($1, $2, $3, app_current_user_id(), $4)`,
				[id, body.name, body.description ?? '', body.teamId ?? null]
			);
			return c.json({ project: full(await getProject(db, id)) }, 201);
		});
	})
	.get('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ project: full(await getProject(db, c.req.param('id'))) });
		})
	)
	.patch('/:id', async (c) => {
		const body = PatchBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, body.teamId !== undefined ? 'owner' : 'editor');
			if (body.teamId) await requireTeamMember(db, body.teamId);
			if (body.teamId !== undefined) {
				// Someone who owns the project only through the current team would
				// lose access by moving it out; keep them as a direct owner.
				await db.query(
					`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, app_current_user_id(), 'owner')
					 ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'`,
					[id]
				);
			}
			const current = await getProject(db, id);
			const settings = body.settings ? patchSettings(current.settings, body.settings) : undefined;
			await db.query(
				`UPDATE project SET
					name = COALESCE($2, name),
					description = COALESCE($3, description),
					settings = COALESCE($4::jsonb, settings),
					team_id = CASE WHEN $5 THEN $6::uuid ELSE team_id END,
					updated_at = now()
				 WHERE id = $1`,
				[id, body.name ?? null, body.description ?? null, settings ? JSON.stringify(settings) : null,
					body.teamId !== undefined, body.teamId ?? null]
			);
			return c.json({ project: full(await getProject(db, id)) });
		});
	})
	.delete('/:id', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'owner');
			await db.query('DELETE FROM project WHERE id = $1', [c.req.param('id')]);
			return c.body(null, 204);
		})
	)
	.post('/:id/copy', async (c) => {
		const body = z.object({ name }).parse(await readJson(c));
		const srcId = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, srcId, 'viewer');
			const src = await getProject(db, srcId);
			const newId = crypto.randomUUID();
			await db.query(
				`INSERT INTO project (id, name, description, settings, created_by, team_id)
				 VALUES ($1, $2, $3, $4, app_current_user_id(), $5)`,
				// The copy stays in the team only if the copier belongs to it.
				[newId, body.name, src.description, JSON.stringify(src.settings ?? {}), src.team_name !== null ? src.team_id : null]
			);
			await saveModel(db, newId, remapIds(await loadModel(db, srcId)));
			await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
				 SELECT $2, kind, name, unit, start_date, "values" FROM time_series WHERE project_id = $1`,
				[srcId, newId]
			);
			return c.json({ project: full(await getProject(db, newId)) }, 201);
		});
	})
	// --- members -------------------------------------------------------------
	.get('/:id/members', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const { rows } = await db.query(
				`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role
				 FROM project_member m JOIN app_user u ON u.id = m.user_id
				 WHERE m.project_id = $1 ORDER BY m.role DESC, u.display_name`,
				[c.req.param('id')]
			);
			return c.json({ members: rows });
		})
	)
	.post('/:id/members', async (c) => {
		const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: RoleEnum }).parse(await readJson(c));
		const id = c.req.param('id');
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const { rows: users } = await db.query<{ id: string; email: string; display_name: string; verified: boolean }>(
				'SELECT id, email, display_name, email_verified_at IS NOT NULL AS verified FROM app_user WHERE email = $1',
				[body.email]
			);
			const user = users[0];
			// No account yet, or one that never proved it owns the address: invite
			// by email (they join once the address is verified), so pre-registering
			// a colleague's address can't get you added in their place.
			if (!user?.verified) {
				return { invited: await inviteByEmail(db, 'project', id, body.email, body.role, user?.id) };
			}
			const { rowCount } = await db.query(
				`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				[id, user.id, body.role]
			);
			if (!rowCount) throw new ApiError(409, 'already a member');
			await dropInvite(db, 'project', id, user.email);
			return { member: { userId: user.id, email: user.email, displayName: user.display_name, role: body.role } };
		});
		// Mail goes out after the transaction commits, and never fails the request.
		if (result.invited) {
			if (result.invited.mail) await trySendMail(result.invited.mail);
			return c.json({ invited: true, invite: result.invited.invite }, 201);
		}
		return c.json({ member: result.member }, 201);
	})
	.patch('/:id/members/:userId', async (c) => {
		const body = z.object({ role: RoleEnum }).parse(await readJson(c));
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			if (body.role !== 'owner') await assertNotLastOwner(db, id, userId);
			const { rows } = await db.query(
				`UPDATE project_member m SET role = $3 FROM app_user u
				 WHERE m.project_id = $1 AND m.user_id = $2 AND u.id = m.user_id
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
			const role = await requireRole(db, id, 'viewer');
			const self = userId === c.get('userId');
			if (!self && role !== 'owner') throw new ApiError(403, 'requires owner role');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			await assertNotLastOwner(db, id, userId);
			const { rowCount } = await db.query('DELETE FROM project_member WHERE project_id = $1 AND user_id = $2', [
				id,
				userId
			]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});

/**
 * Friendly 409 before the deferred DB trigger would abort the commit. Checked
 * *before* the change: afterwards a member who just left can no longer see
 * the member list through RLS.
 */
async function assertNotLastOwner(db: import('../db/tx.js').Db, projectId: string, userId: string) {
	const { rows } = await db.query<{ owners: number; target_is_owner: boolean }>(
		`SELECT count(*) FILTER (WHERE role = 'owner')::int AS owners,
			bool_or(user_id = $2 AND role = 'owner') AS target_is_owner
		 FROM project_member WHERE project_id = $1`,
		[projectId, userId]
	);
	if (rows[0]?.target_is_owner && rows[0].owners <= 1) {
		throw new ApiError(409, 'a project must keep at least one owner');
	}
}

async function requireTeamMember(db: import('../db/tx.js').Db, teamId: string) {
	const { rows } = await db.query<{ role: string | null }>('SELECT app_team_role($1) AS role', [teamId]);
	if (!rows[0]?.role) throw new ApiError(404, 'team not found');
}

/** Fresh ids for a copied model, keeping every internal reference intact. */
function remapIds(model: import('@water-management/engine').ProjectModel) {
	const map = new Map<string, string>();
	const id = (old: string) => {
		let n = map.get(old);
		if (!n) map.set(old, (n = crypto.randomUUID()));
		return n;
	};
	return {
		nodes: model.nodes.map((n) => ({ ...n, id: id(n.id), downstreamNodeId: n.downstreamNodeId && id(n.downstreamNodeId) })),
		crops: model.crops.map((c) => ({ ...c, id: id(c.id) })),
		cropAreas: model.cropAreas.map((a) => ({ ...a, nodeId: id(a.nodeId), cropId: id(a.cropId) })),
		transfers: model.transfers.map((t) => ({ ...t, id: id(t.id), fromNodeId: id(t.fromNodeId), toNodeId: id(t.toNodeId) }))
	};
}
