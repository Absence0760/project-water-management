// `yield`: a dam's firm yield, or its storage–yield curve, on a saved run or
// a scenario (roadmap WP-3.6, docs/model.md §2.13), as the editor who queued
// it, under RLS, or as the applicant who queued it on their own application
// (096_contributor_yield: yieldInputFor checks it again as they are now, so
// the job dies once they lose the role or the dam). Writes one yield_result row and keeps the newest
// YIELD_RESULTS_KEPT per run or scenario and dam.
//
// The engine is synchronous; a curve is one firm-yield search per capacity,
// with the job's progress reported (outside its transaction) between them.
// A cancel (app_cancel_job) stops it at the next report: dead, "cancelled",
// nothing stored.
import { ENGINE_VERSION, firmYield, isMonotone, prepareYield, storageYieldCapacities, type YieldPoint, type YieldProblem } from '@water-management/engine';
import { ApiError } from '../../http/errors.js';
import { requireRole } from '../../projects/access.js';
import { YIELD_RESULTS_KEPT, yieldInputFor, YieldPayload, type YieldPoints } from '../../yield/store.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

const CANCELLED = () => new JobError('cancelled', { retry: false });

export const yieldHandler = defineHandler({
	// And a contributor, on a dam of their own application only (yieldInputFor).
	role: 'editor',
	alsoRole: 'contributor',
	payload: YieldPayload,
	async run({ db, job, payload, progress }) {
		const role = await requireRole(db, job.projectId, 'contributor');
		// Also refuses a run or scenario changed since the request was checked (a node removed): the user's to fix.
		const input = await yieldInputFor(db, job.projectId, role, job.actingUserId, payload);
		const { pattern, assurance, tolerance, points: n } = payload.params;
		let problem: YieldProblem;
		try {
			problem = prepareYield(input);
		} catch (err) {
			// The model refused the input (no rainfall, over-allocated shares …): another attempt won't help.
			throw new JobError(`the model can't run this input: ${(err as Error).message}`, { retry: false });
		}
		const opts = { pattern, assurance, tolerance };
		let points: YieldPoints;
		try {
			if (payload.kind === 'firm') {
				points = { point: firmYield(problem, payload.nodeId, opts) };
				if (!(await progress(100))) throw CANCELLED();
			} else {
				const i = problem.nodeIds.indexOf(payload.nodeId);
				const caps = storageYieldCapacities(problem.plan.nodes[i]!.damCapacityM3, n);
				const out: YieldPoint[] = [];
				for (const c of caps) {
					out.push(firmYield(problem, payload.nodeId, { ...opts, capacityM3: c }));
					if (!(await progress((100 * out.length) / caps.length))) throw CANCELLED();
				}
				points = { baseCapacityM3: problem.plan.nodes[i]!.damCapacityM3, assurance, points: out, monotone: isMonotone(out, tolerance) };
			}
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError) throw err;
			// The engine's own words (an all-zero pattern, no demand to shape it): plain text, never DB text.
			throw new JobError(`the yield search failed: ${(err as Error).message}`, { retry: false });
		}
		const target = payload.runId ? { col: 'run_id', id: payload.runId } : { col: 'scenario_id', id: payload.scenarioId! };
		await db.query(
			`INSERT INTO yield_result (project_id, ${target.col}, node_id, job_id, kind, params, points, engine_version)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[job.projectId, target.id, payload.nodeId, job.id, payload.kind, JSON.stringify(payload.params), JSON.stringify(points), ENGINE_VERSION]
		);
		await db.query(
			`DELETE FROM yield_result WHERE id IN (
				SELECT id FROM yield_result WHERE project_id = $1 AND ${target.col} = $2 AND node_id = $3
				ORDER BY created_at DESC, id DESC OFFSET $4)`,
			[job.projectId, target.id, payload.nodeId, YIELD_RESULTS_KEPT]
		);
	}
});
