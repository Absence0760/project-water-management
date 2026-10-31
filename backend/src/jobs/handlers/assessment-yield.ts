// `assessment_yield`: one firm-yield search of a cumulative assessment
// (297_assessment_yield_jobs, assessments/yields.ts; docs/scenarios.md
// § Cumulative impact): a dam the applications touch, on one of the
// assessment's runs (the baseline, one application alone, or all together).
// The `assessment` job queues one per dam and run, as the editor who asked;
// each runs as them, under RLS, stores its yield on its row and, once every
// row has its yield, completes the assessment with the report it gathered.
//
// One search and the run that prepares it, about 5.6 s on a 30-year,
// 16-node catchment: well inside the worker's 300 s. Everything commits with
// the job's `done`, so a retry after a crash never stores a yield twice. A
// failure another attempt can't fix ends it at once. Once dead, onDead
// gathers the assessment as the same user, so it is stored as failed, naming
// the dam and run, even when no sibling job is left to see it. The API reads
// it so in any case (yields.ts stoppedYieldsSql), for a death no hook sees.
import { computeAssessmentYield, AssessmentYieldPayload, gatherAssessment } from '../../assessments/yields.js';
import { ApiError } from '../../http/errors.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const assessmentYieldHandler = defineHandler({
	role: 'editor',
	payload: AssessmentYieldPayload,
	async run({ db, job, payload }) {
		try {
			await computeAssessmentYield(db, job, payload);
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the firm yield failed: ${(err as Error).message}`, { retry: false });
		}
	},
	// Dead, its row still pending: fail the assessment now, the line naming the run and dam, not left to a sibling.
	async onDead({ db, job, payload }) {
		await gatherAssessment(db, job.projectId, payload.assessmentId);
	}
});
