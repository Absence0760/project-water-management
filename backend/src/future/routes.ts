// § 8 Future yield of an application run (issue #621 slice 4; docs/api.md
// § Future yield):
//
//   POST /projects/:id/runs/:runId/future-yield   editor   queue the job (202 { jobId }; 200 when the same one is pending)
//   GET  /projects/:id/runs/:runId/future-yield   viewer (an applicant: their own application's)   whether it is on, and the newest result
//
// Off (409 `future_yield_off`; GET answers enabled: false) unless
// FUTURE_YIELD=on. The API never reads the data copy: the job does (the
// worker has MIRROR_URL), and dies saying so when the copy holds no cmip6.
// Status and progress of the job: GET /projects/:id/jobs.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { allocationUnitsHidden } from '../allocations/viewerUnits.js';
import { verdictsOnly } from '../allocations/verdictsOnly.js';
import { FUTURE_YIELD_JOBS_PER_USER, futurePair, futureYieldDedupeKey, futureYieldEnabled, FutureYieldRequest, latestFutureYield, pendingFutureJobs } from './store.js';

/** Either run caps use at, or scales demand to, the registered volumes. */
async function onCapOrFull(db: Db, projectId: string, runIds: string[]): Promise<boolean> {
	const { rows } = await db.query<{ a: unknown }>(`SELECT summary->'allocations' AS a FROM model_run WHERE project_id = $1 AND id = ANY($2::uuid[])`, [projectId, runIds]);
	return rows.some((r) => verdictsOnly(r.a as Parameters<typeof verdictsOnly>[0]));
}

export const futureYieldRoutes = new Hono<AuthEnv>()
	.post('/:id/runs/:runId/future-yield', async (c) => {
		const { id, runId } = c.req.param();
		if (!UUID.test(runId)) throw new ApiError(404, 'run not found');
		const body = FutureYieldRequest.parse(await readJson(c));
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Checked now, so a bad request is a 4xx here rather than a dead job later; the job checks again.
			const pair = await futurePair(db, id, runId, body.nodeId);
			const payload = { applicationRunId: runId, nodeId: pair.nodeId };
			const dedupeKey = futureYieldDedupeKey(payload);
			const { rows: same } = await db.query(`SELECT 1 FROM job WHERE project_id = $1 AND dedupe_key = $2 AND status IN ('queued', 'failed')`, [id, dedupeKey]);
			const pending = await pendingFutureJobs(db);
			if (!same[0] && pending >= FUTURE_YIELD_JOBS_PER_USER) throw new ApiError(429, 'you already have a future yield queued or running; wait for it to finish');
			return enqueueJob(db, { projectId: id, kind: 'future_yield', payload, dedupeKey, maxAttempts: 2 });
		});
		if (result.created) await wakeWorker(result.job.id);
		return c.json({ jobId: result.job.id, job: result.job, created: result.created }, result.created ? 202 : 200);
	})
	.get('/:id/runs/:runId/future-yield', async (c) => {
		const { id, runId } = c.req.param();
		if (!UUID.test(runId)) throw new ApiError(404, 'run not found');
		const enabled = futureYieldEnabled();
		return withUser(
			c.get('userId'),
			async (db) => {
				const role = await requireRole(db, id, 'contributor');
				const row = enabled ? await latestFutureYield(db, id, runId) : null;
				// A viewer kept from the registered volumes, on runs that cap use at or scale it to them, reads that one exists,
				// not its numbers: as the report withholds § 8 from them (verdictsOnly.ts) and GET …/yield its points.
				if (row && (await allocationUnitsHidden(db, id, role)) && (await onCapOrFull(db, id, [row.baselineRunId, row.applicationRunId]))) {
					const { result: _r, ...meta } = row;
					void _r;
					return c.json({ enabled, result: { ...meta, result: null, withheld: ['result'] } });
				}
				return c.json({ enabled, result: row });
			},
			{ readOnly: true }
		);
	});
