// Publication routes (roadmap WP-2.3, docs/api.md § Publication). Every
// member, farmers included, reads the current publication; editors publish
// and change the notice. RLS (022_publication.sql) enforces the same.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { queueAlertEval } from '../alerts/queue.js';
import { withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
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
			const published = await publishRun(db, id, body);
			const p = published.publication;
			await recordAudit(db, id, 'publication.published', {
				publicationId: p.id,
				runId: p.runId,
				restriction: { level: p.restriction.level, pct: p.restriction.pct },
				farms: published.farms
			});
			return { published, alertJob: await queueAlertEval(db, id, 'publish') };
		}).then(async ({ published, alertJob }) => {
			if (alertJob?.created) await wakeWorker(alertJob.id);
			return c.json(published, 201);
		});
	})
	.patch('/:id/publication/:pubId', async (c) => {
		const body = PatchBody.parse(await readJson(c));
		const { id, pubId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(pubId)) throw new ApiError(404, 'not found');
			const publication = await patchPublication(db, id, pubId, body);
			// Which parts were sent, not their text: the notice is on the publication itself.
			const fields = (['note', 'restriction', 'nextExpectedOn'] as const).filter((k) => body[k] !== undefined);
			await recordAudit(db, id, 'publication.notice_changed', {
				publicationId: publication.id,
				runId: publication.runId,
				fields,
				restriction: { level: publication.restriction.level, pct: publication.restriction.pct }
			});
			return { publication, alertJob: body.restriction ? await queueAlertEval(db, id, 'publish') : null };
		}).then(async ({ publication, alertJob }) => {
			if (alertJob?.created) await wakeWorker(alertJob.id);
			return c.json({ publication });
		});
	});
