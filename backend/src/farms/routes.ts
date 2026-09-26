// Farmers on a project (roadmap WP-2.1, issue #24): members with the
// `farmer` role, each linked to the farm nodes they may read
// (020_farm_scope.sql). The WUA side manages them here; the farmer's own view
// comes with WP-2.6. Adding someone who has no verified account yet needs an
// invite, which is WP-2.2; until then this adds existing accounts only.
//
// A farmer leaves (or an owner removes one) through DELETE /members/:userId:
// their links go with the membership (farm_link's foreign key cascades).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { farmLinks, recordAudit, recordLinkChanges } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';

/** A farmer can hold several farms; 50 is far above any real catchment. */
const NodeIds = z.array(z.string().uuid()).min(1).max(50);
const AddBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), nodeIds: NodeIds });
const LinksBody = z.object({ nodeIds: NodeIds });

export interface Farmer {
	userId: string;
	email: string;
	displayName: string;
	nodeIds: string[];
}

async function listFarmers(db: Db, projectId: string): Promise<Farmer[]> {
	const { rows } = await db.query<Farmer>(
		`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName",
			coalesce(array_agg(fl.node_id ORDER BY fl.node_id) FILTER (WHERE fl.node_id IS NOT NULL), '{}') AS "nodeIds"
		 FROM project_member m
		 JOIN app_user u ON u.id = m.user_id
		 LEFT JOIN farm_link fl ON fl.project_id = m.project_id AND fl.user_id = m.user_id
		 WHERE m.project_id = $1 AND m.role = 'farmer'
		 GROUP BY m.user_id, u.email, u.display_name
		 ORDER BY u.display_name, u.email`,
		[projectId]
	);
	return rows;
}

/** Every id must be a farm of this project; a clear 400 before the trigger would refuse it. */
async function assertFarms(db: Db, projectId: string, nodeIds: string[]) {
	const unique = [...new Set(nodeIds)];
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM node WHERE project_id = $1 AND kind = 'farm' AND id = ANY($2::uuid[])`,
		[projectId, unique]
	);
	if (rows[0]!.n !== unique.length) throw new ApiError(400, 'every node must be a farm in this project');
	return unique;
}

async function setLinks(db: Db, projectId: string, userId: string, nodeIds: string[], addedBy: string) {
	await db.query('DELETE FROM farm_link WHERE project_id = $1 AND user_id = $2 AND NOT (node_id = ANY($3::uuid[]))', [projectId, userId, nodeIds]);
	await db.query(
		`INSERT INTO farm_link (project_id, node_id, user_id, added_by)
		 SELECT $1, n, $2, $4 FROM unnest($3::uuid[]) n
		 ON CONFLICT DO NOTHING`,
		[projectId, userId, nodeIds, addedBy]
	);
}

export const farmerRoutes = new Hono<AuthEnv>()
	// Viewer and above: the WUA's staff see who is linked to which farm, as they see the member list.
	.get('/:id/farmers', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'viewer');
			return c.json({ farmers: await listFarmers(db, id) });
		})
	)
	.post('/:id/farmers', async (c) => {
		const body = AddBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const nodeIds = await assertFarms(db, id, body.nodeIds);
			const { rows: users } = await db.query<{ id: string; verified: boolean }>(
				'SELECT id, email_verified_at IS NOT NULL AS verified FROM app_user WHERE email = $1',
				[body.email]
			);
			const user = users[0];
			// Same rule as adding a member: only an account that proved it owns the
			// address, so pre-registering a farmer's email can't get you their farm.
			if (!user?.verified) throw new ApiError(409, 'no verified account with that email yet');
			const { rowCount } = await db.query(
				`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer') ON CONFLICT DO NOTHING`,
				[id, user.id]
			);
			if (!rowCount) throw new ApiError(409, 'already a member');
			await setLinks(db, id, user.id, nodeIds, c.get('userId'));
			const farmer = (await listFarmers(db, id)).find((f) => f.userId === user.id)!;
			await recordAudit(db, id, 'member.added', { userId: user.id, displayName: farmer.displayName, role: 'farmer' });
			await recordLinkChanges(db, id, [], (await farmLinks(db, id)).filter((l) => l.userId === user.id), 'farmers_set');
			return c.json({ farmer }, 201);
		});
	})
	// Replace a farmer's farms.
	.put('/:id/farmers/:userId', async (c) => {
		const body = LinksBody.parse(await readJson(c));
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			const nodeIds = await assertFarms(db, id, body.nodeIds);
			const { rows } = await db.query(`SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2 AND role = 'farmer'`, [id, userId]);
			if (!rows[0]) throw new ApiError(404, 'not found');
			const before = (await farmLinks(db, id)).filter((l) => l.userId === userId);
			await setLinks(db, id, userId, nodeIds, c.get('userId'));
			await recordLinkChanges(db, id, before, (await farmLinks(db, id)).filter((l) => l.userId === userId), 'farmers_set');
			const farmer = (await listFarmers(db, id)).find((f) => f.userId === userId)!;
			return c.json({ farmer });
		});
	});
