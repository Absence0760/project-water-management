// § 8 Future yield of an application run (issue #621 slice 4; docs/api.md
// § Future yield), and the Scenarios tab's future climate (slice 5,
// 282_climate_factors; docs/api.md § Future climate):
//
//   POST /projects/:id/runs/:runId/future-yield   editor   queue the job (202 { jobId }; 200 when the same one is pending)
//   GET  /projects/:id/runs/:runId/future-yield   viewer (an applicant: their own application's)   whether it is on, the newest result and the newest job
//   POST /projects/:id/climate-factors            editor   queue the factor table's job (202; 200 when one is pending)
//   GET  /projects/:id/climate-factors            viewer   whether it is on, the newest table, whether the boundary changed since, the newest job
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
import { catchmentClimateCells, FUTURE_YIELD_JOBS_PER_USER, futurePair, futureYieldDedupeKey, futureYieldEnabled, FutureYieldRequest, latestFutureYield, pendingFutureJobs } from './store.js';
import { CLIMATE_FACTORS_DEDUPE_KEY, ClimateFactorsPayload, climateFactorsState, latestJobOf } from './climate.js';

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
				// The newest job for this run (RLS: a contributor sees their own), so § 8's Run button shows its state after a reload.
				const job = enabled ? await latestJobOf(db, id, 'future_yield', { applicationRunId: runId }) : null;
				// A viewer kept from the registered volumes, on runs that cap use at or scale it to them, reads that one exists,
				// not its numbers: as the report withholds § 8 from them (verdictsOnly.ts) and GET …/yield its points.
				if (row && (await allocationUnitsHidden(db, id, role)) && (await onCapOrFull(db, id, [row.baselineRunId, row.applicationRunId]))) {
					const { result: _r, ...meta } = row;
					void _r;
					return c.json({ enabled, result: { ...meta, result: null, withheld: ['result'] }, job });
				}
				return c.json({ enabled, result: row, job });
			},
			{ readOnly: true }
		);
	})
	.post('/:id/climate-factors', async (c) => {
		const id = c.req.param('id');
		ClimateFactorsPayload.parse(await readJson(c, { optional: true }));
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!futureYieldEnabled()) throw new ApiError(409, 'The future climate is off on this server (FUTURE_YIELD=off).', { code: 'future_yield_off' });
			// Checked now, so a missing or unreadable boundary is a 409 here rather than a dead job; the job reads it again.
			await catchmentClimateCells(db, id);
			return enqueueJob(db, { projectId: id, kind: 'climate_factors', payload: {}, dedupeKey: CLIMATE_FACTORS_DEDUPE_KEY, maxAttempts: 2 });
		});
		if (result.created) await wakeWorker(result.job.id);
		return c.json({ jobId: result.job.id, job: result.job, created: result.created }, result.created ? 202 : 200);
	})
	.get('/:id/climate-factors', async (c) => {
		const id = c.req.param('id');
		const enabled = futureYieldEnabled();
		return withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'viewer');
				if (!enabled) return c.json({ enabled, factors: null, boundary: 'none', job: null });
				return c.json({ enabled, ...(await climateFactorsState(db, id)) });
			},
			{ readOnly: true }
		);
	});
