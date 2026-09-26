// Share-link routes (roadmap WP-2.3 phase 2, docs/api.md § Share).
//
// Owners list, create and revoke links (RLS in 025_share_links.sql enforces
// the same). The public reads, POST /share/view and /share/series, have no
// session: the token is the credential, read only through the SECURITY
// DEFINER app_share_view / app_share_series, and every dead link (unknown,
// malformed, revoked, expired, nothing published) is the same 404.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { newToken, parseToken } from '../auth/tokens.js';
import { withoutUser, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import {
	CreateBody,
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

/** GET/POST /projects/:id/share-links, DELETE /projects/:id/share-links/:linkId (owner). */
export const shareLinkRoutes = new Hono<AuthEnv>()
	.get('/:id/share-links', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'owner');
			const { rows } = await db.query<ShareLinkRow>(`${SELECT_LINKS} WHERE s.project_id = $1 ORDER BY s.created_at DESC, s.id`, [id]);
			return c.json({ links: rows.map(toLink) });
		})
	)
	.post('/:id/share-links', async (c) => {
		const body = CreateBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const { token, hash } = newToken();
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO share_link (project_id, label, token_hash, created_by, expires_at)
				 VALUES ($1, $2, $3, app_current_user_id(), now() + make_interval(days => $4)) RETURNING id`,
				[id, body.label, hash, body.expiresInDays]
			);
			const { rows: link } = await db.query<ShareLinkRow>(`${SELECT_LINKS} WHERE s.id = $1`, [rows[0]!.id]);
			// Never the token: the log says which link and for how long.
			await recordAudit(db, id, 'share_link.created', { linkId: rows[0]!.id, label: body.label, expiresInDays: body.expiresInDays });
			// The only time the token leaves the server: it isn't stored, so it can't be shown again.
			return c.json({ link: { ...toLink(link[0]!), url: shareUrl(token) } }, 201);
		});
	})
	.delete('/:id/share-links/:linkId', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { id, linkId } = c.req.param();
			await requireRole(db, id, 'owner');
			if (!UUID.test(linkId)) throw new ApiError(404, 'not found');
			const { rows: revoked } = await db.query<{ label: string }>(
				'UPDATE share_link SET revoked_at = now(), revoked_by = app_current_user_id() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING label',
				[linkId, id]
			);
			if (revoked[0]) await recordAudit(db, id, 'share_link.revoked', { linkId, label: revoked[0].label });
			else {
				// Already revoked is done; not this project's link is not found.
				const { rows } = await db.query('SELECT 1 FROM share_link WHERE id = $1 AND project_id = $2', [linkId, id]);
				if (!rows[0]) throw new ApiError(404, 'not found');
			}
			return c.body(null, 204);
		})
	);

/** POST /share/view and /share/series: public, the token is the credential. */
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
	});
