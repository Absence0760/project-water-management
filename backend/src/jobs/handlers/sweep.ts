// `sweep`: a scenario sweep (issue #53 R2, 062_scenario_sweeps.sql,
// docs/scenarios.md § Sweeps): one base run × named op sets, as the editor
// who asked for it, under RLS. Each member's ops are applied to the base
// run's stored input and the engine runs; the member stores its run summary,
// or its problems when its ops don't apply (sweeps/store.ts computeSweep).
// Everything commits with the job's `done`, so a retry after a crash never
// stores a member twice.
//
// The engine runs inside the job's transaction, as for `rerun`: at most
// SWEEP_MEMBERS_MAX runs, each well under a second on an example catchment.
import { ApiError } from '../../http/errors.js';
import { SweepPayload } from '../../sweeps/schema.js';
import { computeSweep } from '../../sweeps/store.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const sweepHandler = defineHandler({
	role: 'editor',
	payload: SweepPayload,
	async run({ db, job, payload, progress }) {
		try {
			// False: the sweep went (deleted, or with its base run) or is already complete. Nothing to do.
			await computeSweep(db, job.projectId, payload.sweepId, progress);
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the sweep failed: ${(err as Error).message}`, { retry: false });
		}
	}
});
