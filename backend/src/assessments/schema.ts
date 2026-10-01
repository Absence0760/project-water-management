// Cumulative impact assessments (roadmap WP-3.11, docs/scenarios.md
// § Cumulative impact, docs/api.md § Assessments): the request body and the
// job's payload.
import { z } from 'zod';

/** Fewest scenarios an assessment takes: one alone is the scenario's own run. */
export const ASSESSMENT_SCENARIOS_MIN = 2;
/**
 * Most scenarios an assessment takes (145_assessment CHECK on position). The
 * job runs the baseline, each alone and all together: 8 + 2 runs, well inside
 * one job's lease (runner.ts DEFAULT_LEASE_SECONDS) on an example catchment.
 */
export const ASSESSMENT_SCENARIOS_MAX = 8;
/** Most queued or running assessment jobs one user may have across all projects. */
export const ASSESSMENT_JOBS_PER_USER = 2;
/** Assessments kept per project, newest first; creating one deletes older ones. */
export const ASSESSMENTS_KEPT = 20;

const noNul = (s: string) => !s.includes('\u0000');

export const CreateAssessmentBody = z
	.object({
		name: z.string().trim().min(1, 'an assessment needs a name').max(200).refine(noNul, 'cannot contain NUL characters'),
		scenarioIds: z
			.array(z.string().uuid())
			.min(ASSESSMENT_SCENARIOS_MIN, `an assessment needs at least ${ASSESSMENT_SCENARIOS_MIN} scenarios`)
			.max(ASSESSMENT_SCENARIOS_MAX, `an assessment takes at most ${ASSESSMENT_SCENARIOS_MAX} scenarios`)
			.refine((ids) => new Set(ids).size === ids.length, 'a scenario can be in an assessment once'),
		/** Only check that the scenarios combine (conflicts and problems); write nothing, queue nothing. */
		dryRun: z.boolean().optional()
	})
	.strict();
export type CreateAssessmentBody = z.infer<typeof CreateAssessmentBody>;

/** The `assessment` job's payload: which assessment to compute (its members are in the table). */
export const AssessmentPayload = z.object({ assessmentId: z.string().uuid() }).strict();
