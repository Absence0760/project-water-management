// Share-link routes (roadmap WP-2.3 phase 2, docs/api.md § Share).
//
// Owners list, create and revoke links to the published baseline (RLS in
// 025_share_links.sql enforces the same). A link to one scenario (WP-3.15,
// 113_scenario_share_notes.sql) is made by an editor on a scenario they read,
// or by an applicant on their own, once it is submitted or decided; the
// assessors list and revoke every link to it, an applicant the ones they
// made. The public reads, POST /share/view, /share/series and
// /share/scenario, have no session: the token is the credential, read only
// through the SECURITY DEFINER app_share_view / app_share_series /
// app_share_scenario, and every dead link (unknown, malformed, revoked,
// expired, nothing published, a scenario no longer submitted) is the same 404.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { newToken, parseToken } from '../auth/tokens.js';
import { withoutUser, withUser, type Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { rank, requireRole, UUID, type Role } from '../projects/access.js';
import { stampMatches } from '../runs/stamp.js';
import {
	CreateBody,
	ListQuery,
	toShareScenario,
	type ShareScenarioRow,
	SELECT_LINKS,
	SeriesBody,
	SHARE_SERIES_KEYS,
	shareUrl,
	toLink,
	toShareSeries,
	toShareView,
	ViewBody,
	type ShareLinkRow,
	type ShareSeriesRow,
	type ShareViewRow
} from './links.js';

const deadLink = () => new ApiError(404, 'not found');

/**
 * The scenario a targeted link names, as the caller reads it (RLS): 404 when
 * they can't read it, 409 while it isn't submitted or decided, 403 when they
 * may read it but not share it (a viewer; someone the applicant shared it
 * with). The policies (app_share_link_creatable) hold the same rule.
 */
async function shareableScenario(db: Db, projectId: string, scenarioId: string, role: Role, userId: string): Promise<void> {
	const { rows } = await db.query<{ status: string; owner_user_id: string; origin: string }>('SELECT status, owner_user_id, origin FROM scenario WHERE id = $1 AND project_id = $2', [
		scenarioId,
		projectId
	]);
	const s = rows[0];
	if (!s) throw new ApiError(404, 'not found');
	// A team scenario's ops name the real farms with their values: only an application (its projection hides them) is shared.
	if (s.origin !== 'applicant') throw new ApiError(409, 'only an application can be shared by link: a team scenario names every farm');
	if (rank[role] < rank.editor && s.owner_user_id !== userId) throw new ApiError(403, 'only the assessors or the applicant can share this scenario');
	if (s.status !== 'submitted' && s.status !== 'decided')
		throw new ApiError(409, 'only a submitted or decided scenario can be shared: a draft is still changing');
}

/** GET/POST /projects/:id/share-links, DELETE /projects/:id/share-links/:linkId. */
export const shareLinkRoutes = new Hono<AuthEnv>()
	.get('/:id/share-links', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			if (!q.scenarioId) {
				// The published baseline's links: the owner's, exactly as before.
				await requireRole(db, id, 'owner');
				const { rows } = await db.query<ShareLinkRow>(`${SELECT_LINKS} WHERE s.project_id = $1 AND s.target_kind IS NULL ORDER BY s.created_at DESC, s.id`, [id]);
				return c.json({ links: rows.map(toLink) });
			}
			await requireRole(db, id, 'contributor');
			// RLS: the assessors see every link to it, an applicant the ones they made.
			const { rows: sc } = await db.query('SELECT 1 FROM scenario WHERE id = $1 AND project_id = $2', [q.scenarioId, id]);
			if (!sc[0]) throw new ApiError(404, 'not found');
			const { rows } = await db.query<ShareLinkRow>(
				`${SELECT_LINKS} WHERE s.project_id = $1 AND s.target_kind = 'scenario' AND s.target_id = $2 ORDER BY s.created_at DESC, s.id`,
				[id, q.scenarioId]
			);
			return c.json({ links: rows.map(toLink) });
		});
	})
	.post('/:id/share-links', async (c) => {
		const body = CreateBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		return withUser(userId, async (db) => {
			if (body.targetKind === undefined) await requireRole(db, id, 'owner');
			else await shareableScenario(db, id, body.targetId!, await requireRole(db, id, 'contributor'), userId);
			const kind = body.targetKind ?? null;
			const { token, hash } = newToken();
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO share_link (project_id, label, token_hash, created_by, expires_at, target_kind, target_id)
				 VALUES ($1, $2, $3, app_current_user_id(), now() + make_interval(days => $4), $5, $6) RETURNING id`,
				[id, body.label, hash, body.expiresInDays, kind, body.targetId ?? null]
			);
			const { rows: link } = await db.query<ShareLinkRow>(`${SELECT_LINKS} WHERE s.id = $1`, [rows[0]!.id]);
			// Never the token: the log says which link, to what, and for how long.
			await recordAudit(db, id, 'share_link.created', {
				linkId: rows[0]!.id,
				label: body.label,
				expiresInDays: body.expiresInDays,
				...(kind ? { targetKind: kind, targetId: body.targetId } : {})
			});
			// The only time the token leaves the server: it isn't stored, so it can't be shown again.
			return c.json({ link: { ...toLink(link[0]!), url: shareUrl(token, kind) } }, 201);
		});
	})
	.delete('/:id/share-links/:linkId', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { id, linkId } = c.req.param();
			const role = await requireRole(db, id, 'contributor');
			if (!UUID.test(linkId)) throw new ApiError(404, 'not found');
			// RLS: a link the caller may manage (the owner: all; module comment).
			const { rows: found } = await db.query<{ label: string; revoked: boolean; target_kind: string | null }>(
				'SELECT label, revoked_at IS NOT NULL AS revoked, target_kind FROM share_link WHERE id = $1 AND project_id = $2',
				[linkId, id]
			);
			if (!found[0]) {
				// Below owner: a baseline link is the owner's, and a link they can't manage is no different (403, as before).
				throw rank[role] < rank.owner ? new ApiError(403, 'requires owner role') : new ApiError(404, 'not found');
			}
			if (!found[0].revoked) {
				await db.query('UPDATE share_link SET revoked_at = now(), revoked_by = app_current_user_id() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL', [linkId, id]);
				await recordAudit(db, id, 'share_link.revoked', { linkId, label: found[0].label, ...(found[0].target_kind ? { targetKind: found[0].target_kind } : {}) });
			}
			// Already revoked is done.
			return c.body(null, 204);
		})
	);

/** POST /share/view, /share/series and /share/scenario: public, the token is the credential. */
export const sharePublicRoutes = new Hono<AuthEnv>()
	.post('/view', async (c) => {
		const body = ViewBody.parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw deadLink();
		const row = await withoutUser(async (db) => (await db.query<ShareViewRow>('SELECT * FROM app_share_view($1)', [hash])).rows[0]);
		if (!row) throw deadLink();
		c.header('Cache-Control', 'no-store');
		return c.json(toShareView(row));
	})
	.post('/series', async (c) => {
		const body = SeriesBody.parse(await readJson(c));
		const hash = parseToken(body.token);
		// The allowlist again in the database (app_share_series): a node's series never leaves through a link.
		if (!hash || !(SHARE_SERIES_KEYS as readonly string[]).includes(body.key)) throw deadLink();
		const row = await withoutUser(async (db) => (await db.query<ShareSeriesRow>('SELECT * FROM app_share_series($1, $2)', [hash, body.key])).rows[0]);
		// A farm key, a key the run doesn't have, too few farm holders, or a dead link: all "nothing here".
		if (!row) throw deadLink();
		c.header('Cache-Control', 'no-store');
		return c.json(toShareSeries(body.key, row));
	})
	.post('/scenario', async (c) => {
		const body = ViewBody.parse(await readJson(c));
		const hash = parseToken(body.token);
		if (!hash) throw deadLink();
		const row = await withoutUser(async (db) => (await db.query<ShareScenarioRow>('SELECT * FROM app_share_scenario($1)', [hash])).rows[0]);
		// Unknown, revoked, expired, a baseline link, or a scenario no longer submitted or decided.
		if (!row) throw deadLink();
		c.header('Cache-Control', 'no-store');
		return c.json(toShareScenario(row, stampMatches));
	});
