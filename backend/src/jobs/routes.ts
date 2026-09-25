// A project's background jobs (docs/api.md § Jobs): the status list, and
// queueing a re-run. Other kinds are queued by the server itself (feeds,
// alerts), never through this route.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { requireRole } from '../projects/access.js';
import { RERUN_DEDUPE_KEY, RerunPayload } from './handlers/rerun.js';
import { enqueueJob, JOB_STATUSES, listJobs } from './queue.js';
import { wakeWorker } from './transport.js';

const ListQuery = z.object({
	status: z.enum(JOB_STATUSES).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});

const EnqueueBody = z.object({ kind: z.literal('rerun') }).extend(RerunPayload.shape).strict();

export const jobRoutes = new Hono<AuthEnv>()
	.get('/:id/jobs', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ jobs: await listJobs(db, c.req.param('id'), q) });
		});
	})
	// Queue a model run in the background. One pending re-run per project: a
	// second request while one waits returns that one (200, created false).
	.post('/:id/jobs', async (c) => {
		const body = EnqueueBody.parse(await readJson(c));
		const id = c.req.param('id');
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			return enqueueJob(db, { projectId: id, kind: 'rerun', payload: { label: body.label }, dedupeKey: RERUN_DEDUPE_KEY });
		});
		if (result.created) await wakeWorker(result.job.id);
		return c.json(result, result.created ? 202 : 200);
	});
