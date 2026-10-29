// Firm yield and storage–yield curves (docs/api.md § Yield; roadmap WP-3.6).
//
//   POST /projects/:id/yield   editor, or a contributor on their own application   queue a yield job (202 { jobId }; 200 when an identical one is pending)
//   GET  /projects/:id/yield   viewer (a contributor: their own results)   stored results, ?runId= or ?scenarioId=, optional nodeId / jobId
//   GET  /projects/:id/yield/jobs   viewer (a contributor: their own jobs)   a dam's pending yield jobs, ?nodeId= (optional runId or scenarioId)
//   POST /projects/:id/yield/:jobId/cancel   the user who queued it, or an editor   stop a yield job
//
// A contributor (an applicant, WP-3.3) calculates only on an application they
// own, for its dams they may see (yieldInputFor, 096_contributor_yield); RLS
// shows them their own jobs and results only.
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
import { listPendingYieldJobs, listYieldResults, pendingYieldJobs, YIELD_JOBS_PER_USER, yieldDedupeKey, yieldInputFor, YieldRequest, yieldsOnCapOrFull } from './store.js';
import { allocationUnitsHidden } from '../allocations/viewerUnits.js';

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
			const role = await requireRole(db, id, 'contributor');
			// Checked now so a bad request is a 400/403/404 here, not a dead job later.
			await yieldInputFor(db, id, role, c.get('userId'), body);
			const dedupeKey = yieldDedupeKey(body, role === 'contributor' ? c.get('userId') : undefined);
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
		const out = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'contributor');
			// cancelled: whether this call changed it (285_cancel_job_outcome); a second cancel answers false.
			const { rows } = await db.query<{ status: string | null; changed: boolean }>(
				`SELECT o.status, o.changed FROM job j CROSS JOIN LATERAL app_cancel_job_outcome(j.id) o WHERE j.id = $1 AND j.project_id = $2`,
				[jobId, id]
			);
			return rows[0];
		});
		if (!out?.status) throw new ApiError(404, 'not found');
		return c.json({ status: out.status, cancelled: out.changed });
	})
	// Read under RLS from the job's own payload (water_app may SELECT a job of a
	// project it can view), so no column mirrors it and GET /jobs stays payload-free.
	.get('/:id/yield/jobs', async (c) => {
		const q = JobsQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'contributor');
			return c.json({ jobs: await listPendingYieldJobs(db, c.req.param('id'), q) });
		});
	})
	.get('/:id/yield', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, c.req.param('id'), 'contributor');
			const results = await listYieldResults(db, c.req.param('id'), q);
			// A yield on a cap or full-allocation run or scenario: its dam's inflow carries the capped use of the units above it,
			// so a viewer kept from the volumes gets the result without its points (#523 I, round 5).
			if (!results.length || !(await allocationUnitsHidden(db, c.req.param('id'), role))) return c.json({ results });
			const bound = new Set(await yieldsOnCapOrFull(db, results.map((r) => r.id)));
			return c.json({ results: results.map((r) => (bound.has(r.id) ? { ...r, points: null, withheld: ['points'] } : r)) });
		});
	});
