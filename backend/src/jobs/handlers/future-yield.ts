// `future_yield`: § 8 of an application's evidence report (issue #621 slice
// 4, 280_future_yield; docs/evidence-pack.md § Future yield). As the editor
// who queued it, under RLS: the pair checked again (futurePair), each climate
// model's monthly aggregates read from the copy over the catchment's 0.25°
// cells, the factor table worked out (future/copy.ts readFactorTable: engine
// buildFutureFactorTable, round 1's climateDeltaFactors), and every pair run
// (engine runFutureYieldAsync: about 40 runs and twice as many yield searches,
// one case at a time). Progress is reported after each model's read (0–10 %)
// and after the historical pair and each case (10–100 %), outside the
// transaction; a cancel (284_cancel_future_jobs) stops it at the next report,
// so no further model is read or case run, and nothing is stored. Writes one
// future_yield row and keeps the newest FUTURE_YIELD_RESULTS_KEPT per pair.
import { ENGINE_VERSION, runFutureYieldAsync, type FutureYieldResult } from '@water-management/engine';
import { ApiError } from '../../http/errors.js';
import { requireRole } from '../../projects/access.js';
import { mirrorStore } from '../../mirror/source.js';
import { Cmip6NotInCopyError, readFactorTable } from '../../future/copy.js';
import { FUTURE_YIELD_RESULTS_KEPT, futurePair, FutureYieldPayload } from '../../future/store.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

const CANCELLED = () => new JobError('cancelled', { retry: false });
/** The share of the job's progress the copy's read takes; the runs take the rest. */
const READ_PCT = 10;

export const futureYieldHandler = defineHandler({
	role: 'editor',
	payload: FutureYieldPayload,
	async run({ db, job, payload, progress }) {
		await requireRole(db, job.projectId, 'editor');
		// Also refuses FUTURE_YIELD=off, a run gone or changed into one that assumes a climate, the dam or boundary gone.
		const pair = await futurePair(db, job.projectId, payload.applicationRunId, payload.nodeId);
		let factors;
		let warnings: string[];
		try {
			({ factors, warnings } = await readFactorTable(mirrorStore(), pair.cells, async (done, total) => {
				if (!(await progress((READ_PCT * done) / total))) throw CANCELLED();
			}));
		} catch (err) {
			// The copy not holding cmip6 yet is the operator's to load; nothing a retry changes.
			if (err instanceof Cmip6NotInCopyError) throw new JobError(`${err.message}: the operator loads it (deployment.md § NEX-GDDP-CMIP6)`, { retry: false });
			throw err;
		}
		let result: FutureYieldResult;
		try {
			// The runs are the long part: checked after each case, so a cancel stops the next one starting.
			result = await runFutureYieldAsync({
				baseline: pair.baseline,
				application: pair.application,
				nodeId: pair.nodeId,
				ownedNodeIds: pair.ownedNodeIds,
				factors,
				onCase: async (done, total) => {
					if (!(await progress(READ_PCT + ((100 - READ_PCT) * done) / total))) throw CANCELLED();
				}
			});
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError) throw err;
			// The engine's own words (an op that doesn't apply, a dam gone): plain text, never DB text.
			throw new JobError(`the future yield failed: ${(err as Error).message}`, { retry: false });
		}
		result.warnings.push(...warnings);
		await db.query(
			`INSERT INTO future_yield (project_id, baseline_run_id, application_run_id, node_id, job_id, method, result, engine_version)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[job.projectId, pair.baselineRunId, pair.applicationRunId, pair.nodeId, job.id, result.method, JSON.stringify(result), ENGINE_VERSION]
		);
		await db.query(
			`DELETE FROM future_yield WHERE id IN (
				SELECT id FROM future_yield WHERE project_id = $1 AND application_run_id = $2 AND baseline_run_id = $3
				ORDER BY created_at DESC, id DESC OFFSET $4)`,
			[job.projectId, pair.applicationRunId, pair.baselineRunId, FUTURE_YIELD_RESULTS_KEPT]
		);
	}
});
