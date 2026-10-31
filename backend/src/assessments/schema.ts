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
 * The dams the applications touch get their firm yields from jobs of their
 * own, at most the engine's CUMULATIVE_YIELD_SEARCHES_MAX (yields.ts, 297).
 */
export const ASSESSMENT_SCENARIOS_MAX = 8;
/** Most assessments one user may have in flight across all projects: its own job, or any of its firm-yield jobs (297), queued or running. */
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
		/**
		 * Optional background at full allocation (295, WP-3.10): a scenario run on the same baseline at full
		 * allocation (assessments/background.ts). The members are also assessed on it, as a second row set;
		 * the baseline stays the hydrologist's run.
		 */
		backgroundRunId: z.string().uuid().optional(),
		/** Only check that the scenarios combine (conflicts and problems); write nothing, queue nothing. */
		dryRun: z.boolean().optional()
	})
	.strict();
export type CreateAssessmentBody = z.infer<typeof CreateAssessmentBody>;

/** The `assessment` job's payload: which assessment to compute (its members are in the table). */
export const AssessmentPayload = z.object({ assessmentId: z.string().uuid() }).strict();
