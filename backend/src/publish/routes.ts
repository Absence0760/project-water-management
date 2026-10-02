// Publication routes (roadmap WP-2.3, docs/api.md § Publication). Every
// member, farmers included, reads the current publication; editors publish
// and change the notice. RLS (022_publication.sql) enforces the same.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { queueAlertEval } from '../alerts/queue.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { requireStepUp } from '../auth/stepUp.js';
import { requireActsForAuthority } from '../projects/authoritySettings.js';
import { EndorseBody, endorsePublication, listPublications, patchPublication, PatchBody, publishRun, PublishBody } from './publish.js';
import { runPublication } from './runPublication.js';

export const publicationRoutes = new Hono<AuthEnv>()
	.get('/:id/publication', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, c.req.param('id'), 'farmer');
			// The modeller's note is for the project's staff, not its farmers.
			return c.json(await listPublications(db, c.req.param('id'), rank[role] >= rank.viewer));
		})
	)
	// One run's publication and the changes since the one before (the printable report, issue #70).
	// Viewer: the changes come from the change history, which farmers don't read.
	.get('/:id/runs/:runId/publication', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { id, runId } = c.req.param();
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query('SELECT 1 FROM model_run WHERE project_id = $1 AND id = $2', [id, runId]);
			if (!rows[0]) throw new ApiError(404, 'not found');
			return c.json(await runPublication(db, id, runId));
		})
	)
	.post('/:id/publication', async (c) => {
		const body = PublishBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Publishing to farmers needs two-step sign-in (auth/stepUp.ts).
			await requireStepUp(db);
			// publishRun records it in the decision log (publication.published, decision.ts).
			const published = await publishRun(db, id, body);
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
			await requireStepUp(db);
			if (!UUID.test(pubId)) throw new ApiError(404, 'not found');
			// patchPublication records it in the decision log (publication.notice_changed, decision.ts).
			const publication = await patchPublication(db, id, pubId, body);
			return { publication, alertJob: body.restriction ? await queueAlertEval(db, id, 'publish') : null };
		}).then(async ({ publication, alertJob }) => {
			if (alertJob?.created) await wakeWorker(alertJob.id);
			return c.json({ publication });
		});
	})
	// The responsible authority endorses a published baseline (163_licensing_authority):
	// an editor the owner marks as acting for it, once per publication.
	.post('/:id/publication/:pubId/endorse', async (c) => {
		const body = EndorseBody.parse(await readJson(c, { optional: true }));
		const { id, pubId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			await requireStepUp(db);
			await requireActsForAuthority(db, id);
			if (!UUID.test(pubId)) throw new ApiError(404, 'not found');
			return c.json({ publication: await endorsePublication(db, id, pubId, body.note) });
		});
	});
