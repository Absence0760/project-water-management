// Publication routes (roadmap WP-2.3, docs/api.md § Publication). Every
// member, farmers included, reads the current publication; editors publish
// and change the notice. RLS (022_publication.sql) enforces the same.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { listPublications, patchPublication, PatchBody, publishRun, PublishBody } from './publish.js';

export const publicationRoutes = new Hono<AuthEnv>()
	.get('/:id/publication', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, c.req.param('id'), 'farmer');
			// The modeller's note is for the project's staff, not its farmers.
			return c.json(await listPublications(db, c.req.param('id'), rank[role] >= rank.viewer));
		})
	)
	.post('/:id/publication', async (c) => {
		const body = PublishBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			return c.json(await publishRun(db, id, body), 201);
		});
	})
	.patch('/:id/publication/:pubId', async (c) => {
		const body = PatchBody.parse(await readJson(c));
		const { id, pubId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(pubId)) throw new ApiError(404, 'not found');
			return c.json({ publication: await patchPublication(db, id, pubId, body) });
		});
	});
