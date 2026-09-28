// Scenario sweeps (issue #53 R2, docs/api.md § Sweeps, 062_scenario_sweeps.sql).
//
//   POST /projects/:id/sweeps            editor   write a sweep and queue its job (202 { sweep, jobId, job })
//   GET  /projects/:id/sweeps            viewer   the project's sweeps, newest first (?baseRunId=), members without summaries
//   GET  /projects/:id/sweeps/:sweepId   viewer   one sweep, each member with its run summary (and, ?series=true, its outcome series)
//
// Status and progress of the job: the sweep's `job`, or GET /projects/:id/jobs (WP-2.8).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { CreateSweepBody, SWEEP_JOBS_PER_USER } from './schema.js';
import { createSweep, getSweep, listSweeps, pendingSweepJobs } from './store.js';

const ListQuery = z.object({ baseRunId: z.string().uuid().optional() }).strict();
const GetQuery = z.object({ series: z.enum(['true', 'false']).optional() }).strict();

export const sweepRoutes = new Hono<AuthEnv>()
	.post('/:id/sweeps', async (c) => {
		const body = CreateSweepBody.parse(await readJson(c));
		const id = c.req.param('id');
		const { sweep, job } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const pending = await pendingSweepJobs(db);
			if (pending >= SWEEP_JOBS_PER_USER) throw new ApiError(429, `you already have ${pending} sweeps queued or running; wait for one to finish`);
			return createSweep(db, id, body);
		});
		await wakeWorker(job.id);
		return c.json({ sweep, jobId: job.id, job }, 202);
	})
	.get('/:id/sweeps', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ sweeps: await listSweeps(db, c.req.param('id'), q) });
		});
	})
	.get('/:id/sweeps/:sweepId', async (c) => {
		const sweepId = c.req.param('sweepId');
		if (!UUID.test(sweepId)) throw new ApiError(404, 'not found');
		const q = GetQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const sweep = await getSweep(db, c.req.param('id'), sweepId, q.series === 'true' ? 'series' : 'summary');
			if (!sweep) throw new ApiError(404, 'not found');
			return c.json({ sweep });
		});
	});
