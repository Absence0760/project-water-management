// The licensed-terms run, off the request path (293_scenario_run_job;
// docs/scenarios.md § Applications, docs/api.md § Scenarios).
//
// The evidence report's § 4 reads an issued licence from a run of the terms
// it counts with (evidence/report.ts COUNTED_SHA_SQL). When those are the ops
// applied for, the applicant's own runs of them serve. When the authority
// granted other terms, or an appeal varied them, nothing had run them until
// an assessor pressed **Run the licensed terms**. POST …/decide and
// POST …/appeals now call queueLicensedRun inside their transaction: when the
// licence in force afterwards has such terms and no run on the scenario's
// base has recorded them, a `scenario_run` job (jobs/handlers/scenario-run.ts)
// makes that run as the member who recorded the decision or event.
//
// Cost: one engine run per job, the same run the button makes. At most one
// pending per scenario (the dedupe key: a second decision or event while one
// waits keeps the one, which reads the terms in force when it runs), and at
// most SCENARIO_RUN_JOBS_PER_USER pending per user across projects, counted
// under an advisory lock as the other kinds' caps are. Past the cap nothing is
// queued and the decision is still recorded: the button stays, and § 4 still
// names the licence until it is run (evidence-20).
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { enqueueJob, type JobMeta } from '../jobs/queue.js';
import { licensedTerms } from './licence.js';
import type { ScenarioRow } from './execute.js';

/** Most queued, running or retrying scenario_run jobs one user may have across all projects. */
export const SCENARIO_RUN_JOBS_PER_USER = 5;

export const ScenarioRunPayload = z.object({ scenarioId: z.string().uuid() }).strict();
export type ScenarioRunPayload = z.infer<typeof ScenarioRunPayload>;

/** One pending licensed-terms run per scenario. */
export const scenarioRunDedupeKey = (scenarioId: string) => `scenario_run:${scenarioId}`;

/**
 * The terms a run must record for § 4 to read this scenario from it, when no
 * run of the ops applied for can serve: its licence in force's terms when
 * they differ from those ops. null: no licence in force, or it is on the ops
 * applied for.
 */
export function termsToRun(s: Pick<ScenarioRow, 'opsSha256' | 'licence' | 'grantedTerms' | 'decisionEvents'>): { opsSha256: string } | null {
	const t = licensedTerms(s);
	return t && t.opsSha256 !== s.opsSha256 ? { opsSha256: t.opsSha256 } : null;
}

/** Whether a run of the scenario on its base already recorded these terms (what § 4 matches on). */
export async function hasRunOfTerms(db: Db, projectId: string, s: Pick<ScenarioRow, 'id' | 'baseRunId'>, opsSha256: string): Promise<boolean> {
	const { rows } = await db.query(
		`SELECT 1 FROM model_run r WHERE r.project_id = $1 AND r.scenario_id = $2
			AND r.inputs->'scenario'->>'baseRunId' = $3::text AND r.inputs->'scenario'->>'opsSha256' = $4 LIMIT 1`,
		[projectId, s.id, s.baseRunId, opsSha256]
	);
	return rows.length > 0;
}

/**
 * Queue the run of a scenario's licensed terms, as the transaction's user
 * (an editor recording its decision or an appeal event), when it needs one
 * (termsToRun, and no such run yet). Call with the scenario as it is after the
 * change, in the change's transaction; wake the worker after the commit.
 * Returns the job (a new one, or the one already pending), or null when
 * nothing is queued (none needed, or the user's cap is full).
 */
export async function queueLicensedRun(db: Db, projectId: string, s: ScenarioRow): Promise<{ job: JobMeta; created: boolean } | null> {
	const terms = termsToRun(s);
	if (!terms || (await hasRunOfTerms(db, projectId, s, terms.opsSha256))) return null;
	const dedupeKey = scenarioRunDedupeKey(s.id);
	// Count and enqueue one at a time per user (the lock is held to commit), so a burst can't pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('scenario_run_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number; same: boolean }>(
		`SELECT count(*)::int AS n, bool_or(project_id = $1 AND dedupe_key = $2 AND status IN ('queued', 'failed')) AS same
		 FROM job WHERE kind = 'scenario_run' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`,
		[projectId, dedupeKey]
	);
	if (!rows[0]?.same && (rows[0]?.n ?? 0) >= SCENARIO_RUN_JOBS_PER_USER) return null;
	return enqueueJob(db, { projectId, kind: 'scenario_run', payload: { scenarioId: s.id }, dedupeKey, maxAttempts: 2 });
}

/**
 * The newest scenario_run job of a scenario (ScenarioRow.licensedRunJob), as
 * JobMeta: what the Application panel shows where the button is. Under the
 * reader's RLS on job (016: viewers and up), so a contributor reads none.
 */
export const LICENSED_RUN_JOB_SQL = `(SELECT jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
		'maxAttempts', j.max_attempts, 'runAfter', j.run_after, 'createdAt', j.created_at, 'startedAt', j.started_at,
		'finishedAt', j.finished_at, 'error', j.last_error, 'createdBy', ju.display_name, 'progress', j.progress)
	 FROM job j LEFT JOIN app_user ju ON ju.id = j.acting_user_id
	 WHERE j.project_id = s.project_id AND j.kind = 'scenario_run' AND j.dedupe_key = 'scenario_run:' || s.id::text
	 ORDER BY j.created_at DESC, j.id DESC LIMIT 1)`;
