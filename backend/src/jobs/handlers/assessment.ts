// `assessment`: a cumulative impact assessment (roadmap WP-3.11,
// 145_assessment.sql, docs/scenarios.md § Cumulative impact): the baseline,
// each scenario alone and all together, as the editor who asked for it,
// under RLS (assessments/store.ts computeAssessment). Everything commits
// with the job's `done`, so a retry after a crash never stores a member twice.
//
// The engine runs inside the job's transaction, as for `sweep`: at most
// ASSESSMENT_SCENARIOS_MAX + 2 runs.
import { AssessmentPayload } from '../../assessments/schema.js';
import { computeAssessment } from '../../assessments/store.js';
import { ApiError } from '../../http/errors.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const assessmentHandler = defineHandler({
	role: 'editor',
	payload: AssessmentPayload,
	async run({ db, job, payload, progress }) {
		try {
			// False: the assessment went (deleted, or with its base run) or is already done. Nothing to do.
			await computeAssessment(db, job.projectId, payload.assessmentId, progress);
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the assessment failed: ${(err as Error).message}`, { retry: false });
		}
	}
});
