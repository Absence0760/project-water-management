// `uncertainty`: the server's own run of an uncertainty ensemble (issue #153:
// the ensemble around a fit automated calibration applied,
// calibration/store.ts startCalibrationEnsemble), as whoever started it, under
// RLS. The browser-run ensemble (runs/uncertainty.ts) posts members for the
// server to check; here the server computes every member itself, so there is
// nothing to check, and completes the row once, as the result route does.
//
// A run is timed first: an ensemble estimated past ENSEMBLE_SECONDS_MAX is
// refused (dead, saying so) rather than cut off by the worker's timeout; it
// can still be run from the Runs tab in the browser.
import { ENGINE_VERSION, runEnsemble, runModel, summariseEnsemble, type ResolvedEnsembleOptions } from '@water-management/engine';
import { ENSEMBLE_SECONDS_MAX, UncertaintyPayload } from '../../calibration/schema.js';
import { ApiError } from '../../http/errors.js';
import { runModelInput } from '../../runs/uncertainty.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const uncertaintyHandler = defineHandler({
	role: 'editor',
	payload: UncertaintyPayload,
	async run({ db, job, payload, progress }) {
		const { rows } = await db.query<{ runId: string; status: string; createdBy: string; baselineId: string | null; options: ResolvedEnsembleOptions; engineVersion: string }>(
			`SELECT run_id AS "runId", status, created_by AS "createdBy", baseline_id AS "baselineId", options, engine_version AS "engineVersion"
			 FROM run_uncertainty WHERE project_id = $1 AND id = $2`,
			[job.projectId, payload.uncertaintyId]
		);
		const row = rows[0];
		// Gone with its run, or stored already: nothing to do.
		if (!row || row.status !== 'started') return;
		if (row.createdBy !== job.actingUserId || row.baselineId) throw new JobError('only an ensemble this job started can be run here', { retry: false });
		if (row.engineVersion !== ENGINE_VERSION) throw new JobError(`this ensemble was started on engine ${row.engineVersion}; start a new one`, { retry: false });
		try {
			const input = await runModelInput(db, job.projectId, row.runId);
			const t0 = performance.now();
			runModel(input);
			const seconds = ((performance.now() - t0) * row.options.members) / 1000;
			if (seconds > ENSEMBLE_SECONDS_MAX)
				throw new JobError(
					`the ensemble would take about ${Math.ceil(seconds / 60)} minutes on the server, more than a background job may run: run it from the Runs tab instead`,
					{ retry: false }
				);
			const result = runEnsemble(input, row.options);
			const summary = summariseEnsemble({ options: row.options, header: result.header, members: result.members, coverage: result.coverage });
			if (!(await progress(100))) throw new LeaseLostError();
			await db.query(`UPDATE run_uncertainty SET status = 'complete', accepted = $2, summary = $3, result = $4 WHERE id = $1 AND status = 'started'`, [
				payload.uncertaintyId,
				summary.accepted,
				JSON.stringify(summary),
				JSON.stringify({ engineVersion: ENGINE_VERSION, header: result.header, members: result.members, coverage: result.coverage })
			]);
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the ensemble failed: ${(err as Error).message}`, { retry: false });
		}
	}
});
