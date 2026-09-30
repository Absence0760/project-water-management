// The job table's API (016_jobs.sql): enqueue as the signed-in editor, list
// for the status UI, and the worker's claim / finish / purge through the
// SECURITY DEFINER functions.
import type { Db } from '../db/tx.js';
import type { ClaimedJob, JobKind } from './registry.js';

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job as viewers see it (never the payload, never the lease). */
export interface JobMeta {
	id: string;
	kind: JobKind;
	status: JobStatus;
	attempts: number;
	maxAttempts: number;
	runAfter: string;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	/** Sanitised (jobs/errors.ts). */
	error: string | null;
	/** The acting user's display name. */
	createdBy: string;
	/** How far a running job is, 0–100, when its handler reports it (040_yield); null otherwise. */
	progress: number | null;
}

/** JobMeta's columns, over `job j JOIN app_user u ON u.id = j.acting_user_id`. */
export const JOB_META = `j.id, j.kind, j.status, j.attempts, j.max_attempts AS "maxAttempts", j.run_after AS "runAfter",
	j.created_at AS "createdAt", j.started_at AS "startedAt", j.finished_at AS "finishedAt", j.last_error AS error,
	u.display_name AS "createdBy", j.progress`;

export interface EnqueueOptions {
	projectId: string;
	kind: JobKind;
	payload?: Record<string, unknown>;
	/**
	 * At most one pending (queued, or failed and waiting to retry) job per key
	 * per project: a second enqueue returns the pending one instead. A pending
	 * job also waits while one with its key is running.
	 */
	dedupeKey?: string;
	/** Run no sooner than this many seconds from now (at most 7 days). */
	delaySeconds?: number;
	maxAttempts?: number;
}

/**
 * Queue a job as the transaction's user, who must be an editor of the project
 * (RLS) and becomes its acting user. Enqueue inside the same transaction as
 * the change that caused it, so both commit or neither does; wake the worker
 * after the commit (wake.ts `wakeWorker`).
 */
export async function enqueueJob(db: Db, o: EnqueueOptions): Promise<{ job: JobMeta; created: boolean }> {
	// Two tries: the pending job we collided with may be claimed (so no longer
	// pending) between the insert and the read, and then the insert succeeds.
	for (let attempt = 0; attempt < 2; attempt++) {
		const { rows } = await db.query<{ id: string }>(
			`INSERT INTO job (project_id, kind, payload, dedupe_key, run_after, max_attempts, acting_user_id)
			 VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, app_current_user_id())
			 ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING
			 RETURNING id`,
			[o.projectId, o.kind, JSON.stringify(o.payload ?? {}), o.dedupeKey ?? null, o.delaySeconds ?? 0, o.maxAttempts ?? 5]
		);
		const created = rows.length > 0;
		const { rows: job } = await db.query<JobMeta>(
			created
				? `SELECT ${JOB_META} FROM job j JOIN app_user u ON u.id = j.acting_user_id WHERE j.id = $1`
				: `SELECT ${JOB_META} FROM job j JOIN app_user u ON u.id = j.acting_user_id
				   WHERE j.project_id = $1 AND j.dedupe_key = $2 AND j.status IN ('queued', 'failed')`,
			created ? [rows[0]!.id] : [o.projectId, o.dedupeKey]
		);
		if (job[0]) return { job: job[0], created };
	}
	throw new Error('enqueue: the pending job with this dedupe key kept changing');
}

/** A project's jobs, newest first (RLS: viewer). */
export async function listJobs(db: Db, projectId: string, { status, limit = 50 }: { status?: JobStatus; limit?: number } = {}): Promise<JobMeta[]> {
	const { rows } = await db.query<JobMeta>(
		`SELECT ${JOB_META} FROM job j JOIN app_user u ON u.id = j.acting_user_id
		 WHERE j.project_id = $1 AND ($2::text IS NULL OR j.status = $2)
		 ORDER BY j.created_at DESC, j.id DESC LIMIT $3`,
		[projectId, status ?? null, limit]
	);
	return rows;
}

/**
 * Claim up to `limit` due jobs for `leaseSeconds` (app_claim_jobs). With
 * `projectIds`, only those projects' jobs (122_scoped_job_claim.sql: the e2e
 * suite's tick); without, every project's (production).
 */
export async function claimJobs(db: Db, limit: number, leaseSeconds: number, projectIds?: readonly string[]): Promise<ClaimedJob[]> {
	const { rows } = await db.query<ClaimedJob>(
		`SELECT id, project_id AS "projectId", kind, acting_user_id AS "actingUserId", lease_token AS "leaseToken",
			attempts, max_attempts AS "maxAttempts"
		 FROM app_claim_jobs($1, make_interval(secs => $2), $3::uuid[])`,
		[limit, leaseSeconds, projectIds ? [...projectIds] : null]
	);
	return rows;
}

/**
 * Record a claimed job's outcome (app_finish_job). Returns the new status, or
 * null when the lease was lost (the job was claimed again after it expired).
 */
export async function finishJob(
	db: Db,
	job: Pick<ClaimedJob, 'id' | 'leaseToken'>,
	outcome: { ok: true } | { ok: false; error: string; retry: boolean }
): Promise<JobStatus | null> {
	const { rows } = await db.query<{ status: JobStatus | null }>('SELECT app_finish_job($1, $2, $3, $4, $5) AS status', [
		job.id,
		job.leaseToken,
		outcome.ok,
		outcome.ok ? null : outcome.error,
		outcome.ok ? true : outcome.retry
	]);
	return rows[0]?.status ?? null;
}

/** Finished jobs are kept this long, then the tick deletes them. */
export const JOB_RETENTION_DAYS = 30;

export async function purgeJobs(db: Db, days = JOB_RETENTION_DAYS): Promise<number> {
	const { rows } = await db.query<{ n: number }>('SELECT app_purge_jobs(make_interval(days => $1)) AS n', [days]);
	return rows[0]?.n ?? 0;
}

export interface QueueStats {
	due: number;
	running: number;
	/** How long the oldest due job has waited past its run_after (0 when none). */
	oldestDueSeconds: number;
}

export async function queueStats(db: Db): Promise<QueueStats> {
	const { rows } = await db.query<QueueStats>(
		'SELECT due, running, oldest_due_seconds AS "oldestDueSeconds" FROM app_job_stats()'
	);
	return rows[0] ?? { due: 0, running: 0, oldestDueSeconds: 0 };
}
