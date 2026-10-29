// `climate_factors`: the Scenarios tab's future climate (issue #621 slice 5,
// 282_climate_factors; docs/scenarios.md § Future climate). As the editor who
// queued it, under RLS: FUTURE_YIELD on, the catchment boundary's 0.25° cells,
// each climate model's monthly aggregates read from the copy and the factor
// table worked out (future/copy.ts readFactorTable, as § 8's future_yield job
// does). Writes one climate_factors row and keeps the newest
// CLIMATE_FACTORS_KEPT per project. Runs nothing: a scenario takes one case's
// factors as a climate.delta op.
import { ApiError } from '../../http/errors.js';
import { requireRole } from '../../projects/access.js';
import { mirrorStore } from '../../mirror/source.js';
import { CLIMATE_FACTORS_KEPT, ClimateFactorsPayload } from '../../future/climate.js';
import { Cmip6NotInCopyError, readFactorTable } from '../../future/copy.js';
import { catchmentClimateCells, futureYieldEnabled } from '../../future/store.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const climateFactorsHandler = defineHandler({
	role: 'editor',
	payload: ClimateFactorsPayload,
	async run({ db, job, progress }) {
		await requireRole(db, job.projectId, 'editor');
		if (!futureYieldEnabled()) throw new JobError('the future climate is off on this server (FUTURE_YIELD=off)', { retry: false });
		let read;
		try {
			// The boundary as it is now: one drawn again since the request is the one the factors are read over.
			const { cells, boundarySha256 } = await catchmentClimateCells(db, job.projectId);
			read = { ...(await readFactorTable(mirrorStore(), cells)), boundarySha256 };
		} catch (err) {
			// A boundary gone or outside the copy, or the copy holding no cmip6 yet: nothing a retry changes.
			if (err instanceof ApiError) throw new JobError(err.message, { retry: false });
			if (err instanceof Cmip6NotInCopyError) throw new JobError(`${err.message}: the operator loads it (deployment.md § NEX-GDDP-CMIP6)`, { retry: false });
			throw err;
		}
		if (!(await progress(100))) throw new JobError('cancelled', { retry: false });
		await db.query(
			`INSERT INTO climate_factors (project_id, job_id, method, boundary_sha256, factors, warnings) VALUES ($1, $2, $3, $4, $5, $6)`,
			[job.projectId, job.id, read.factors.method, read.boundarySha256, JSON.stringify(read.factors), JSON.stringify(read.warnings)]
		);
		await db.query(
			`DELETE FROM climate_factors WHERE id IN (SELECT id FROM climate_factors WHERE project_id = $1 ORDER BY created_at DESC, id DESC OFFSET $2)`,
			[job.projectId, CLIMATE_FACTORS_KEPT]
		);
	}
});
