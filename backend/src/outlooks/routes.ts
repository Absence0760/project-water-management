// Seasonal outlooks (issue #53 R5, docs/api.md § Seasonal outlooks, 063_seasonal_outlook.sql).
//
//   POST /projects/:id/outlooks              editor   write an outlook and queue its job (202 { outlook, jobId, job })
//   GET  /projects/:id/outlooks              viewer   the project's outlooks, newest first (?baseRunId=), without results
//   GET  /projects/:id/outlooks/:outlookId   viewer   one outlook, with its result once complete
//
// Status and progress of the job: the outlook's `job`, or GET /projects/:id/jobs (WP-2.8).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { CreateOutlookBody, OUTLOOK_JOBS_PER_USER } from './schema.js';
import { createOutlook, getOutlook, listOutlooks, pendingOutlookJobs } from './store.js';

const ListQuery = z.object({ baseRunId: z.string().uuid().optional() }).strict();

export const outlookRoutes = new Hono<AuthEnv>()
	.post('/:id/outlooks', async (c) => {
		const body = CreateOutlookBody.parse(await readJson(c));
		const id = c.req.param('id');
		const { outlook, job } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const pending = await pendingOutlookJobs(db);
			if (pending >= OUTLOOK_JOBS_PER_USER) throw new ApiError(429, `you already have ${pending} outlooks queued or running; wait for one to finish`);
			return createOutlook(db, id, body);
		});
		await wakeWorker(job.id);
		return c.json({ outlook, jobId: job.id, job }, 202);
	})
	.get('/:id/outlooks', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ outlooks: await listOutlooks(db, c.req.param('id'), q) });
		});
	})
	.get('/:id/outlooks/:outlookId', async (c) => {
		const outlookId = c.req.param('outlookId');
		if (!UUID.test(outlookId)) throw new ApiError(404, 'not found');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const outlook = await getOutlook(db, c.req.param('id'), outlookId);
			if (!outlook) throw new ApiError(404, 'not found');
			return c.json({ outlook });
		});
	});
