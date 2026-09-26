// One tick of the queue: purge old jobs and reports, queue the data feeds
// (feeds/schedule.ts) and report schedules (reports/schedule.ts) that are
// due, then claim and run due jobs one at a
// time until none are due or the time budget is spent. Every transport ends
// here: the local worker loop (worker.ts), `pnpm dev:jobs:tick`, the memory
// transport (tests), and the production worker Lambda (lambda-worker.ts).
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { type ScheduleResult, scheduleDueFeeds } from '../feeds/schedule.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { purgeReports, type ReportScheduleResult, scheduleDueReports } from '../reports/schedule.js';
import { describeFailure, JobError, LeaseLostError } from './errors.js';
import { handlers as builtInHandlers } from './handlers/index.js';
import { claimJobs, finishJob, type JobStatus, purgeJobs, queueStats, type QueueStats } from './queue.js';
import type { ClaimedJob, HandlerRegistry } from './registry.js';

/** Default lease: longer than any job may run (the worker Lambda's timeout is 300 s). */
export const DEFAULT_LEASE_SECONDS = 360;

export type JobOutcome = Extract<JobStatus, 'done' | 'failed' | 'dead'> | 'lost';

/** Run one claimed job as its acting user and record the outcome. */
export async function runJob(job: ClaimedJob, registry: HandlerRegistry = builtInHandlers): Promise<JobOutcome> {
	const handler = registry[job.kind];
	try {
		if (!handler) throw new JobError(`no handler for "${job.kind}" jobs`, { retry: false });
		return await withUser(job.actingUserId, async (db) => {
			await requireRole(db, job.projectId, handler.role).catch((err) => {
				// Fail closed: whoever queued it can no longer do this. No retry.
				if (err instanceof ApiError) {
					throw new JobError(`the user who queued this job no longer has the ${handler.role} role on the project`, { retry: false });
				}
				throw err;
			});
			const payload = handler.payload.parse(await readPayload(db, job.id));
			await handler.run({ db, job, payload, progress: (pct) => reportProgress(job, pct) });
			// Same transaction as the work: both commit, or neither.
			if ((await finishJob(db, job, { ok: true })) !== 'done') throw new LeaseLostError();
			return 'done' as const;
		});
	} catch (err) {
		if (err instanceof LeaseLostError) {
			console.warn(JSON.stringify({ event: 'job_lease_lost', jobId: job.id, kind: job.kind }));
			return 'lost';
		}
		const failure = describeFailure(err);
		if (!failure.expected) console.error(`job ${job.id} (${job.kind}) failed:`, err);
		const status = await withoutUser((db) => finishJob(db, job, { ok: false, error: failure.message, retry: failure.retry }));
		if (status === 'dead') {
			// The alarm hook (infra/jobs.tf metric filter) until WP-2.13 emails the owners.
			console.error(JSON.stringify({ event: 'job_dead', jobId: job.id, projectId: job.projectId, kind: job.kind, attempts: job.attempts }));
		}
		return status === 'failed' || status === 'dead' ? status : 'lost';
	}
}

/** app_job_progress on its own connection, outside the job's transaction. Best effort: a failure is logged, never fails the job. */
async function reportProgress(job: ClaimedJob, pct: number): Promise<void> {
	const v = Math.max(0, Math.min(100, Math.round(pct)));
	await withoutUser((db) => db.query('SELECT app_job_progress($1, $2, $3)', [job.id, job.leaseToken, v])).catch((err) => {
		console.warn(JSON.stringify({ event: 'job_progress_failed', jobId: job.id, error: (err as Error).message }));
	});
}

async function readPayload(db: Db, jobId: string): Promise<unknown> {
	const { rows } = await db.query<{ payload: unknown }>('SELECT payload FROM job WHERE id = $1', [jobId]);
	if (!rows[0]) throw new JobError('the job is not visible to the user who queued it', { retry: false });
	return rows[0].payload;
}

export interface TickOptions {
	/** Most jobs to run in this tick. */
	maxJobs?: number;
	leaseSeconds?: number;
	/** Stop claiming once this much time has passed (a job already started still finishes). */
	budgetMs?: number;
	handlers?: HandlerRegistry;
	/** Queue due data feeds first (default true; tests of the queue alone turn it off). */
	feeds?: boolean;
	/** Queue every enabled feed, due or not (`pnpm dev:feeds:run`). */
	allFeeds?: boolean;
	/** Queue due report schedules and purge old reports first (default true; queue-only tests turn it off). */
	reports?: boolean;
}

export interface TickResult {
	purged: number;
	claimed: number;
	done: number;
	failed: number;
	dead: number;
	lost: number;
	/** The queue after the tick. */
	stats: QueueStats;
	/** Data feeds queued by this tick (absent when feeds were off). */
	feeds?: ScheduleResult;
	/** Scheduled reports queued by this tick (absent when reports were off). */
	reports?: ReportScheduleResult & { purged: number };
}

/** Positive integer from the environment, or the fallback. */
export function envInt(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function runTick(o: TickOptions = {}): Promise<TickResult> {
	const started = Date.now();
	const maxJobs = o.maxJobs ?? envInt(process.env.JOB_MAX_PER_TICK, 25);
	const leaseSeconds = o.leaseSeconds ?? envInt(process.env.JOB_LEASE_SECONDS, DEFAULT_LEASE_SECONDS);
	const budgetMs = o.budgetMs ?? 4 * 60_000;
	const result: TickResult = { purged: 0, claimed: 0, done: 0, failed: 0, dead: 0, lost: 0, stats: { due: 0, running: 0, oldestDueSeconds: 0 } };
	result.purged = await withoutUser((db) => purgeJobs(db));
	if (o.feeds !== false) result.feeds = await scheduleDueFeeds({ all: o.allFeeds });
	if (o.reports !== false) result.reports = { purged: await purgeReports(), ...(await scheduleDueReports()) };
	// One at a time, so a job's lease starts when it does, not when a batch was claimed.
	while (result.claimed < maxJobs && Date.now() - started < budgetMs) {
		const [job] = await withoutUser((db) => claimJobs(db, 1, leaseSeconds));
		if (!job) break;
		result.claimed++;
		result[await runJob(job, o.handlers)]++;
	}
	result.stats = await withoutUser(queueStats);
	return result;
}
