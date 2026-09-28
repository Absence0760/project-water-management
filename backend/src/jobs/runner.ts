// One tick of the queue: purge old jobs, reports, alerts and lapsed invites, queue the data feeds
// (feeds/schedule.ts), report schedules (reports/schedule.ts) and scheduled
// alert checks (app_alert_schedule) that are due, then claim and run due
// jobs one at a time until none are due or the time budget is spent, then
// send the alert mails those jobs queued (alerts/send.ts). Every transport ends
// here: the local worker loop (worker.ts), `pnpm dev:jobs:tick`, the memory
// transport (tests), and the production worker Lambda (lambda-worker.ts).
import { sendAlerts, type SendResult } from '../alerts/send.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { type ScheduleResult, scheduleDueFeeds } from '../feeds/schedule.js';
import { ApiError } from '../http/errors.js';
import { purgeInvites } from '../invites/invites.js';
import { rank, requireRole } from '../projects/access.js';
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
			const refused = () => new JobError(`the user who queued this job no longer has the ${handler.role} role on the project`, { retry: false });
			const least = handler.alsoRole && rank[handler.alsoRole] < rank[handler.role] ? handler.alsoRole : handler.role;
			const role = await requireRole(db, job.projectId, least).catch((err) => {
				// Fail closed: whoever queued it can no longer do this. No retry.
				if (err instanceof ApiError) throw refused();
				throw err;
			});
			// Between alsoRole and role (an editor demoted to viewer, for a contributor's kind): refused too.
			if (rank[role] < rank[handler.role] && role !== handler.alsoRole) throw refused();
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
			// The alarm hook (infra/jobs.tf metric filter), and the owners' job_dead alert
			// when the project has it on (a check queued now; never for a dead alert check).
			console.error(JSON.stringify({ event: 'job_dead', jobId: job.id, projectId: job.projectId, kind: job.kind, attempts: job.attempts }));
			if (job.kind !== 'alert_eval') await scheduleAlertCheck(job.projectId);
		}
		return status === 'failed' || status === 'dead' ? status : 'lost';
	}
}

/**
 * app_job_progress on its own connection, outside the job's transaction:
 * false when the job was cancelled or its lease lost. Best effort: a failure
 * to write is logged and the job carries on (true).
 */
async function reportProgress(job: ClaimedJob, pct: number): Promise<boolean> {
	const v = Math.max(0, Math.min(100, Math.round(pct)));
	try {
		const { rows } = await withoutUser((db) => db.query<{ go: boolean }>('SELECT app_job_progress($1, $2, $3) AS go', [job.id, job.leaseToken, v]));
		return rows[0]?.go !== false;
	} catch (err) {
		console.warn(JSON.stringify({ event: 'job_progress_failed', jobId: job.id, error: (err as Error).message }));
		return true;
	}
}

/** Scheduled alert checks are spaced this far apart per project (data going stale, feeds failing, dead jobs). */
export const ALERT_CHECK_GAP = '1 hour';
/** Alert deliveries (and events cleared this long ago) are kept this long, then the tick deletes them. */
export const ALERT_RETENTION_DAYS = 180;

/** Queue a job_dead check for one project at once (app_alert_schedule); a failure is logged, never thrown. */
async function scheduleAlertCheck(projectId: string): Promise<void> {
	try {
		await withoutUser((db) => db.query("SELECT app_alert_schedule($1, interval '0', 1)", [projectId]));
	} catch (err) {
		console.error(JSON.stringify({ event: 'alert_schedule_failed', projectId, error: (err as Error).message }));
	}
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
	/** Queue scheduled alert checks and purge old alerts first (default true; `--no-schedule` turns it off). Alert mails are sent either way. */
	alerts?: boolean;
}

export interface TickResult {
	purged: number;
	/** Lapsed invites deleted (invites/invites.ts purgeInvites). */
	invitesPurged: number;
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
	/** Alert checks queued, alert rows purged (0 when alerts scheduling was off), and alert mails sent by this tick. */
	alerts: SendResult & { scheduled: number; purged: number };
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
	const result: TickResult = {
		purged: 0,
		invitesPurged: 0,
		claimed: 0,
		done: 0,
		failed: 0,
		dead: 0,
		lost: 0,
		stats: { due: 0, running: 0, oldestDueSeconds: 0 },
		alerts: { scheduled: 0, purged: 0, sent: 0, skipped: 0, failed: 0, digests: 0 }
	};
	result.purged = await withoutUser((db) => purgeJobs(db));
	result.invitesPurged = await withoutUser((db) => purgeInvites(db));
	if (o.feeds !== false) result.feeds = await scheduleDueFeeds({ all: o.allFeeds });
	if (o.reports !== false) result.reports = { purged: await purgeReports(), ...(await scheduleDueReports()) };
	let alertsScheduled = 0;
	let alertsPurged = 0;
	if (o.alerts !== false) {
		alertsPurged = await withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_purge_alerts(make_interval(days => $1)) AS n', [ALERT_RETENTION_DAYS])).rows[0]?.n ?? 0);
		alertsScheduled = await withoutUser(
			async (db) => (await db.query<{ n: number }>(`SELECT app_alert_schedule(NULL, interval '${ALERT_CHECK_GAP}', 100) AS n`)).rows[0]?.n ?? 0
		);
	}
	// One at a time, so a job's lease starts when it does, not when a batch was claimed.
	while (result.claimed < maxJobs && Date.now() - started < budgetMs) {
		const [job] = await withoutUser((db) => claimJobs(db, 1, leaseSeconds));
		if (!job) break;
		result.claimed++;
		result[await runJob(job, o.handlers)]++;
	}
	// After the jobs, so every delivery an alert_eval queued is sent once it committed.
	result.alerts = { scheduled: alertsScheduled, purged: alertsPurged, ...(await sendAlerts()) };
	result.stats = await withoutUser(queueStats);
	return result;
}
