// Firm yield and storage–yield curves (docs/api.md § Yield; roadmap WP-3.6).
//
//   POST /projects/:id/yield   editor   queue a yield job (202 { jobId }; 200 when an identical one is pending)
//   GET  /projects/:id/yield   viewer   stored results, ?runId= or ?scenarioId=, optional nodeId / jobId
//   GET  /projects/:id/yield/jobs   viewer   a dam's pending yield jobs, ?nodeId= (optional runId or scenarioId)
//   POST /projects/:id/yield/:jobId/cancel   the user who queued it, or an editor   stop a yield job
//
// Status and progress of the job: GET /projects/:id/jobs (WP-2.8).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { checkYieldNode, listPendingYieldJobs, listYieldResults, pendingYieldJobs, YIELD_JOBS_PER_USER, yieldDedupeKey, yieldInput, YieldRequest } from './store.js';

const Uuid = z.string().uuid();
const ListQuery = z
	.object({ runId: Uuid.optional(), scenarioId: Uuid.optional(), nodeId: Uuid.optional(), jobId: Uuid.optional() })
	.strict()
	.refine((q) => !q.runId !== !q.scenarioId || !!q.jobId, 'give runId, scenarioId or jobId');
const JobsQuery = z
	.object({ nodeId: Uuid, runId: Uuid.optional(), scenarioId: Uuid.optional() })
	.strict()
	.refine((q) => !(q.runId && q.scenarioId), 'give at most one of runId and scenarioId');

export const yieldRoutes = new Hono<AuthEnv>()
	.post('/:id/yield', async (c) => {
		const body = YieldRequest.parse(await readJson(c));
		const id = c.req.param('id');
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Checked now so a bad request is a 400/404 here, not a dead job later.
			checkYieldNode(await yieldInput(db, id, body), body.nodeId, body.kind);
			const dedupeKey = yieldDedupeKey(body);
			const pending = await pendingYieldJobs(db);
			const { rows: same } = await db.query(`SELECT 1 FROM job WHERE project_id = $1 AND dedupe_key = $2 AND status IN ('queued', 'failed')`, [id, dedupeKey]);
			if (!same[0] && pending >= YIELD_JOBS_PER_USER)
				throw new ApiError(429, `you already have ${pending} yield calculations queued or running; wait for one to finish`);
			return enqueueJob(db, { projectId: id, kind: 'yield', payload: body, dedupeKey, maxAttempts: 2 });
		});
		if (result.created) await wakeWorker(result.job.id);
		return c.json({ jobId: result.job.id, job: result.job, created: result.created }, result.created ? 202 : 200);
	})
	// A waiting job is dead at once; a running one stops at its next progress report.
	.post('/:id/yield/:jobId/cancel', async (c) => {
		const id = c.req.param('id');
		const jobId = c.req.param('jobId');
		if (!UUID.test(jobId)) throw new ApiError(404, 'not found');
		const status = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<{ status: string | null }>(
				`SELECT app_cancel_job(j.id) AS status FROM job j WHERE j.id = $1 AND j.project_id = $2`,
				[jobId, id]
			);
			return rows[0]?.status ?? null;
		});
		if (!status) throw new ApiError(404, 'not found');
		return c.json({ status, cancelled: status === 'dead' || status === 'running' });
	})
	// Read under RLS from the job's own payload (water_app may SELECT a job of a
	// project it can view), so no column mirrors it and GET /jobs stays payload-free.
	.get('/:id/yield/jobs', async (c) => {
		const q = JobsQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ jobs: await listPendingYieldJobs(db, c.req.param('id'), q) });
		});
	})
	.get('/:id/yield', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({ results: await listYieldResults(db, c.req.param('id'), q) });
		});
	});
