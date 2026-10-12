// Who acts for the project's responsible authority (233_authority_delegates,
// issue #523 G5; the licensing assessor's review, D1; docs/security.md
// § Authorization, docs/api.md § Acts for the authority).
//
// The authority, not the host, decides who acts for it. An owner may propose
// someone (an editor or owner of the project, directly or through its team);
// only a member already acting for the authority confirms them, or the
// operator on the authority's letter (authority_confirm_by_operator, the
// schema owner's; with no confirmed delegate in a project, that is the only
// way to confirm the first). Until confirmed a proposal grants nothing. The
// owner may withdraw a proposal but can't remove a confirmed delegate; any
// member acting for the authority can remove anyone who does, and anyone can
// step down. The database holds all of this (authority_delegate_guard, RLS)
// and writes every change to the History (authority_delegate_audit); the
// routes only ask first, to answer in words.
//
//  GET    /projects/:id/authority-delegates                   viewer
//  POST   /projects/:id/authority-delegates  { userId }       owner, or a member acting for the authority
//  POST   /projects/:id/authority-delegates/:userId/confirm   a member acting for the authority
//  DELETE /projects/:id/authority-delegates/:userId           withdraw / decline / remove / step down
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { requireProjectStepUp, requireStepUp } from '../auth/stepUp.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireRole, UUID } from './access.js';
import { actsForAuthority } from './authoritySettings.js';

export type DelegateStatus = 'proposed' | 'confirmed';

export interface AuthorityDelegate {
	userId: string;
	displayName: string;
	status: DelegateStatus;
	/** Confirmed and holding editor or above now: what app_acts_for_authority counts. */
	active: boolean;
	proposedBy: { userId: string; displayName: string } | null;
	proposedAt: string;
	confirmedBy: { userId: string; displayName: string } | null;
	confirmedAt: string | null;
	/** member: by a member acting for the authority; operator: on the authority's letter; grandfathered: an owner's flag from before 233. */
	confirmedVia: 'member' | 'operator' | 'grandfathered' | null;
	/** The operator's reference (the authority's letter); '' otherwise. */
	reference: string;
}

interface Row {
	userId: string;
	displayName: string;
	confirmedAt: Date | null;
	active: boolean;
	proposedById: string | null;
	proposedByName: string | null;
	proposedAt: Date;
	confirmedById: string | null;
	confirmedByName: string | null;
	confirmedVia: AuthorityDelegate['confirmedVia'];
	reference: string;
}

const SELECT = `SELECT d.user_id AS "userId", u.display_name AS "displayName", d.confirmed_at AS "confirmedAt",
		d.user_id IN (SELECT a.user_id FROM app_authority_members(d.project_id) a) AS active,
		d.proposed_by AS "proposedById", pb.display_name AS "proposedByName", d.proposed_at AS "proposedAt",
		d.confirmed_by AS "confirmedById", cb.display_name AS "confirmedByName", d.confirmed_via AS "confirmedVia", d.confirmation_note AS reference
	FROM authority_delegate d JOIN app_user u ON u.id = d.user_id
	LEFT JOIN app_user pb ON pb.id = d.proposed_by LEFT JOIN app_user cb ON cb.id = d.confirmed_by
	WHERE d.project_id = $1`;

const shape = (r: Row): AuthorityDelegate => ({
	userId: r.userId,
	displayName: r.displayName,
	status: r.confirmedAt ? 'confirmed' : 'proposed',
	active: r.active,
	proposedBy: r.proposedById ? { userId: r.proposedById, displayName: r.proposedByName ?? '' } : null,
	proposedAt: r.proposedAt.toISOString(),
	confirmedBy: r.confirmedById ? { userId: r.confirmedById, displayName: r.confirmedByName ?? '' } : null,
	confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
	confirmedVia: r.confirmedVia,
	reference: r.reference
});

/** The project's delegates, confirmed first, under the caller's RLS. */
export async function listDelegates(db: Db, projectId: string): Promise<AuthorityDelegate[]> {
	const { rows } = await db.query<Row>(`${SELECT} ORDER BY d.confirmed_at IS NULL, u.display_name, d.user_id`, [projectId]);
	return rows.map(shape);
}

async function oneDelegate(db: Db, projectId: string, userId: string): Promise<AuthorityDelegate | null> {
	const { rows } = await db.query<Row>(`${SELECT} AND d.user_id = $2`, [projectId, userId]);
	return rows[0] ? shape(rows[0]) : null;
}

const NOT_AN_EDITOR = 'only an editor or owner of the project (directly or through its team) can act for the responsible authority';

export const authorityDelegateRoutes = new Hono<AuthEnv>()
	.get('/:id/authority-delegates', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			const role = await requireRole(db, id, 'viewer');
			const acting = await actsForAuthority(db, id);
			const canPropose = role === 'owner' || acting;
			const { rows: candidates } = canPropose
				? await db.query<{ userId: string; displayName: string; role: string; via: 'direct' | 'team' }>(
						`SELECT user_id AS "userId", display_name AS "displayName", role, via FROM app_authority_candidates($1)`,
						[id]
					)
				: { rows: [] };
			return c.json({ delegates: await listDelegates(db, id), candidates, canPropose, canConfirm: acting });
		})
	)
	.post('/:id/authority-delegates', async (c) => {
		const body = z.object({ userId: z.string().regex(UUID, 'userId must be a uuid') }).strict().parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'editor');
			const acting = await actsForAuthority(db, id);
			if (role !== 'owner' && !acting) throw new ApiError(403, 'only an owner of the project, or a member acting for the responsible authority, proposes who acts for it');
			// The authority's own action always needs two-step sign-in; an owner's where the project requires it.
			if (acting) await requireStepUp(db);
			else await requireProjectStepUp(db, id);
			const { rows: existing } = await db.query('SELECT 1 FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [id, body.userId]);
			if (existing[0]) throw new ApiError(409, 'already proposed or acting for the responsible authority');
			const { rows: ok } = await db.query<{ ok: boolean }>('SELECT app_authority_candidate($1, $2) AS ok', [id, body.userId]);
			if (!ok[0]?.ok) throw new ApiError(409, NOT_AN_EDITOR);
			await db.query('INSERT INTO authority_delegate (project_id, user_id) VALUES ($1, $2)', [id, body.userId]);
			return c.json({ delegate: await oneDelegate(db, id, body.userId) }, 201);
		});
	})
	.post('/:id/authority-delegates/:userId/confirm', async (c) => {
		const { id, userId } = c.req.param();
		z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!(await actsForAuthority(db, id)))
				throw new ApiError(403, 'only a member already acting for the responsible authority confirms who acts for it; with none yet, the authority asks the operator');
			await requireStepUp(db);
			if (!UUID.test(userId)) throw notFound();
			const was = await oneDelegate(db, id, userId);
			if (!was) throw notFound();
			if (was.status === 'confirmed') throw new ApiError(409, 'already confirmed');
			const { rows: ok } = await db.query<{ ok: boolean }>('SELECT app_authority_candidate($1, $2) AS ok', [id, userId]);
			if (!ok[0]?.ok) throw new ApiError(409, NOT_AN_EDITOR);
			await db.query('UPDATE authority_delegate SET confirmed_at = now() WHERE project_id = $1 AND user_id = $2', [id, userId]);
			return c.json({ delegate: await oneDelegate(db, id, userId) });
		});
	})
	.delete('/:id/authority-delegates/:userId', async (c) => {
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			// Every delegate is an editor or owner (a lapsed one is pruned), and so is everyone who may withdraw or remove one.
			const role = await requireRole(db, id, 'editor');
			if (!UUID.test(userId)) throw notFound();
			const was = await oneDelegate(db, id, userId);
			if (!was) throw notFound();
			const self = userId === c.get('userId');
			const acting = await actsForAuthority(db, id);
			if (!self && !acting && !(role === 'owner' && was.status === 'proposed')) {
				throw new ApiError(
					403,
					was.status === 'confirmed'
						? 'only a member acting for the responsible authority removes someone who acts for it'
						: 'only an owner, or a member acting for the responsible authority, withdraws a proposal'
				);
			}
			if (!self) {
				if (acting) await requireStepUp(db);
				else await requireProjectStepUp(db, id);
			}
			const { rowCount } = await db.query('DELETE FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [id, userId]);
			if (!rowCount) throw notFound();
			return c.body(null, 204);
		});
	});
