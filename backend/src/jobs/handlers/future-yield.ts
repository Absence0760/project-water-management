// `future_yield`: § 8 of an application's evidence report (issue #621 slice
// 4, 279_future_yield; docs/evidence-pack.md § Future yield). As the editor
// who queued it, under RLS: the pair checked again (futurePair), each climate
// model's monthly aggregates read from the copy over the catchment's 0.25°
// cells, the factor table worked out (engine buildFutureFactorTable, round
// 1's climateDeltaFactors), and every pair run (engine runFutureYield: about
// 40 runs and twice as many yield searches; the engine is synchronous, so
// progress is reported once, at the end, before the write). Writes one
// future_yield row and keeps the newest FUTURE_YIELD_RESULTS_KEPT per pair.
import { buildFutureFactorTable, ENGINE_VERSION, runFutureYield, type FutureModelCells, type FutureSourceFile, type FutureYieldResult } from '@water-management/engine';
import { ApiError } from '../../http/errors.js';
import { requireRole } from '../../projects/access.js';
import { mirrorStore } from '../../mirror/source.js';
import { cmip6Copy, Cmip6NotInCopyError, readModelCells } from '../../future/copy.js';
import { FUTURE_YIELD_RESULTS_KEPT, futurePair, FutureYieldPayload } from '../../future/store.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const futureYieldHandler = defineHandler({
	role: 'editor',
	payload: FutureYieldPayload,
	async run({ db, job, payload, progress }) {
		await requireRole(db, job.projectId, 'editor');
		// Also refuses FUTURE_YIELD=off, a run gone or changed into one that assumes a climate, the dam or boundary gone.
		const pair = await futurePair(db, job.projectId, payload.applicationRunId, payload.nodeId);
		const store = mirrorStore();
		let factors;
		const warnings: string[] = [];
		try {
			const copy = await cmip6Copy(store);
			const models: FutureModelCells[] = [];
			const sources: FutureSourceFile[] = [];
			for (const model of copy.models) {
				const read = await readModelCells(store, model, pair.cells);
				if (read.dropped) warnings.push(`${model}: ${read.dropped} of the catchment's 0.25° cells hold no value (the sea, or a gap) and were left out`);
				models.push(read.cells);
				sources.push(...read.sources);
			}
			factors = buildFutureFactorTable(models, { sources, citation: copy.citation, licence: copy.licence });
		} catch (err) {
			// The copy not holding cmip6 yet is the operator's to load; nothing a retry changes.
			if (err instanceof Cmip6NotInCopyError) throw new JobError(`${err.message}: the operator loads it (deployment.md § NEX-GDDP-CMIP6)`, { retry: false });
			throw err;
		}
		let result: FutureYieldResult;
		try {
			result = runFutureYield({
				baseline: pair.baseline,
				application: pair.application,
				nodeId: pair.nodeId,
				ownedNodeIds: pair.ownedNodeIds,
				factors
			});
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError) throw err;
			// The engine's own words (an op that doesn't apply, a dam gone): plain text, never DB text.
			throw new JobError(`the future yield failed: ${(err as Error).message}`, { retry: false });
		}
		if (!(await progress(100))) throw new JobError('cancelled', { retry: false });
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
