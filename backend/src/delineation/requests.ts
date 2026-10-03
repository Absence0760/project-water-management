// Delineating on the background worker (191_delineation_request,
// docs/design/delineation.md § Where it runs): a click whose catchment is too
// large for the request's 20 s and 3 072-cell window becomes a `delineate`
// job, which runs the same code with larger windows (delineate.ts
// JOB_WINDOWS) in the worker's 300 s. The route queues it (queueDelineation)
// when the request stops at its cap, or at once when the editor asks for the
// background; the Map polls the request (loadRequest) until the job proposes
// the catchment or refuses it.
//
// Cost (docs/security.md § Map uploads): one waiting or running delineation
// per account (DELINEATE_JOBS_PER_USER, counted under a per-account advisory
// lock, and the job's dedupe key names the account); a new click in the same
// project supersedes that account's waiting one instead of queueing beside it.
// Each request also counts for the account's hourly elevation-model cap
// (attempt.ts), and the worker's reserved concurrency bounds the rest.
import type { Db } from '../db/tx.js';
import { ApiError, notFound } from '../http/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { UUID } from '../projects/access.js';
import { JOB_TIME_BUDGET_MS, JOB_WINDOWS, type LargerChannel, WINDOWS } from './delineate.js';
import { type DelineationProposal, loadProposal, toProposal } from './proposals.js';

/**
 * The windows the request and the job try, and the job's time budget.
 * Mutable for tests only: the synthetic DEM's catchments fit the request's
 * smallest window, so the DB tests narrow it to reach the worker's path.
 */
export const delineationLimits: { requestWindows: readonly number[]; jobWindows: readonly number[]; jobBudgetMs: number } = {
	requestWindows: WINDOWS,
	jobWindows: JOB_WINDOWS,
	jobBudgetMs: JOB_TIME_BUDGET_MS
};

/** Waiting or running delineate jobs per account, across projects. */
export const DELINEATE_JOBS_PER_USER = 1;
/** Finished requests kept per project (the newest); waiting ones are all kept. */
export const REQUESTS_KEPT = 20;
/**
 * Attempts a delineate job gets: retries for a DEM read that failed, or a
 * tick that had too little time left for it. A refusal is an outcome, never retried.
 */
export const DELINEATE_MAX_ATTEMPTS = 3;
/** The least time worth starting a delineate job with (ms): less, and it goes back to the queue for the next tick. */
export const MIN_JOB_TIME_MS = 20_000;

/**
 * The job's time budget: its own, or what is left before the worker's
 * deadline (JobContext.deadline, less a margin for its writes) when that is
 * sooner.
 */
export function jobBudget(deadline: number | null | undefined, now: number, full = delineationLimits.jobBudgetMs): number {
	return deadline ? Math.min(full, deadline - now - 5_000) : full;
}

/**
 * Whether a `too_large` refusal came from a budget cut short by the worker's
 * deadline, before the job's own last window: then the catchment wasn't
 * shown too large, and the job runs again rather than record it.
 */
export function cutShort(refusedAt: number | undefined, windows: readonly number[], budgetMs: number, full = delineationLimits.jobBudgetMs): boolean {
	return budgetMs < full && refusedAt !== undefined && refusedAt !== windows[windows.length - 1];
}

/**
 * The first window the worker tries for a request refused `too_large` at
 * `refusedAt` cells a side, or null when the worker goes no further (the
 * refusal stands).
 */
export function nextJobWindow(refusedAt: number | undefined, job: readonly number[] = delineationLimits.jobWindows): number | null {
	if (refusedAt === undefined) return null;
	return job.find((w) => w > refusedAt) ?? null;
}

/** The windows the job tries, from `from` cells a side (empty when none is that large: the job then refuses). */
export function jobWindowsFrom(from: number, job: readonly number[] = delineationLimits.jobWindows): number[] {
	return job.filter((w) => w >= from);
}

export type RequestStatus = 'queued' | 'proposed' | 'refused' | 'superseded';

export interface RequestRow {
	id: string;
	project_id: string;
	job_id: string | null;
	status: RequestStatus;
	click_kind: 'outlet' | 'dam_wall';
	click_lon: number;
	click_lat: number;
	keep_point: boolean;
	reach: { dataset: string; reachId: number } | null;
	from_window: number;
	proposal_id: string | null;
	refusal_code: string | null;
	refusal: string | null;
	larger: LargerChannel | null;
	check_note: string | null;
	created_at: Date;
	finished_at: Date | null;
}

export const REQUEST_COLS = `r.id, r.project_id, r.job_id, r.status, r.click_kind, r.click_lon, r.click_lat, r.keep_point, r.reach, r.from_window,
	r.proposal_id, r.refusal_code, r.refusal, r.larger, r.check_note, r.created_at, r.finished_at`;

/**
 * What the Map shows of a request: its own outcome, or while it has none,
 * its job's state. `failed`: the job died (a DEM it couldn't read twice, or
 * the purge took it), and `error` says why.
 */
export interface DelineationRequest {
	id: string;
	status: 'queued' | 'running' | 'failed' | 'proposed' | 'refused' | 'superseded';
	from: 'outlet' | 'dam_wall';
	click: [number, number];
	/** 0–100 while the job runs (one step per window), else null. */
	progress: number | null;
	error: string | null;
	/** With `proposed`: the proposal it made, as it is now (null once pruned). */
	proposal: DelineationProposal | null;
	/** With `proposed`: the river-network check that came with it. */
	check: string | null;
	/** With `refused`: the same reason and sentence the request would have answered with. */
	refusal: { reason: string; message: string; larger?: LargerChannel } | null;
	createdAt: string;
	finishedAt: string | null;
}

/** A request as the Map shows it (RLS: viewer). */
export async function requestView(db: Db, projectId: string, r: RequestRow & { job_status: string | null; job_progress: number | null; job_error: string | null }): Promise<DelineationRequest> {
	let status: DelineationRequest['status'] = r.status;
	let error: string | null = null;
	if (r.status === 'queued') {
		if (r.job_status === 'running') status = 'running';
		else if (r.job_status === 'queued' || r.job_status === 'failed') status = 'queued';
		else {
			status = 'failed';
			error = r.job_error ?? 'The background job that had it is gone.';
		}
	}
	const proposal = r.status === 'proposed' && r.proposal_id ? toProposal(await loadProposal(db, projectId, r.proposal_id)) : null;
	return {
		id: r.id,
		status,
		from: r.click_kind,
		click: [r.click_lon, r.click_lat],
		progress: status === 'running' ? r.job_progress : null,
		error,
		proposal,
		check: r.check_note,
		refusal: r.status === 'refused' ? { reason: r.refusal_code!, message: r.refusal!, ...(r.larger ? { larger: r.larger } : {}) } : null,
		createdAt: r.created_at.toISOString(),
		finishedAt: r.finished_at?.toISOString() ?? null
	};
}

const VIEW = `SELECT ${REQUEST_COLS}, j.status AS job_status, j.progress AS job_progress, j.last_error AS job_error
	FROM delineation_request r LEFT JOIN job j ON j.id = r.job_id WHERE r.project_id = $1`;

/** One request of the project (404 when there is none, or it is another project's). */
export async function loadRequest(db: Db, projectId: string, rid: string): Promise<DelineationRequest> {
	if (!UUID.test(rid)) throw notFound();
	const { rows } = await db.query(`${VIEW} AND r.id = $2`, [projectId, rid]);
	if (!rows[0]) throw notFound();
	return requestView(db, projectId, rows[0]);
}

/** The project's newest request while it waits for its outcome (a reopened Map resumes it), else null. */
export async function waitingRequest(db: Db, projectId: string): Promise<DelineationRequest | null> {
	const { rows } = await db.query(`${VIEW} AND r.status = 'queued' ORDER BY r.created_at DESC, r.id LIMIT 1`, [projectId]);
	return rows[0] ? requestView(db, projectId, rows[0]) : null;
}

export interface QueueOptions {
	projectId: string;
	userId: string;
	from: 'outlet' | 'dam_wall';
	lon: number;
	lat: number;
	keepPoint?: boolean;
	reach?: { dataset: string; reachId: number } | null;
	/** The smallest window the job tries. */
	fromWindow: number;
}

/**
 * Hand a click to the worker, as the transaction's user (an editor; the
 * caller has checked). Returns the request; wake the worker with its job
 * after the commit. 429 while the account has a delineation running, or
 * waiting in another project.
 */
export async function queueDelineation(db: Db, o: QueueOptions): Promise<{ request: DelineationRequest; jobId: string }> {
	// Count and queue one request at a time per account, so a burst can't all pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('delineate_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows: mine } = await db.query<{ id: string; project_id: string; status: string }>(
		`SELECT id, project_id, status FROM job WHERE kind = 'delineate' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	let pending = 0;
	let running = false;
	for (const j of mine) {
		if (j.project_id === o.projectId && j.status !== 'running') {
			// This account's waiting click in this project gives way to the new one.
			const { rows } = await db.query<{ status: string | null }>('SELECT app_cancel_job($1) AS status', [j.id]);
			await db.query(`UPDATE delineation_request SET status = 'superseded', finished_at = now() WHERE job_id = $1 AND project_id = $2 AND status = 'queued'`, [
				j.id,
				o.projectId
			]);
			if (rows[0]?.status === 'dead') continue;
		}
		pending++;
		if (j.status === 'running') running = true;
	}
	if (pending >= DELINEATE_JOBS_PER_USER) {
		throw new ApiError(
			429,
			running
				? 'Your last large delineation is still being worked out; wait for it to finish (a few minutes at most).'
				: 'You have a large delineation waiting in another catchment; wait for it to finish.'
		);
	}
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, keep_point, reach, from_window, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, app_current_user_id()) RETURNING id`,
		[o.projectId, o.from, o.lon, o.lat, o.keepPoint === true, o.reach ? JSON.stringify(o.reach) : null, o.fromWindow]
	);
	const requestId = rows[0]!.id;
	const { job, created } = await enqueueJob(db, {
		projectId: o.projectId,
		kind: 'delineate',
		payload: { requestId },
		// The account's one pending delineation in this project (the cap above holds it across projects).
		dedupeKey: `delineate:${o.userId}`,
		maxAttempts: DELINEATE_MAX_ATTEMPTS
	});
	if (!created) throw new ApiError(429, 'You have a large delineation waiting; wait for it to finish.');
	await db.query('UPDATE delineation_request SET job_id = $2 WHERE id = $1', [requestId, job.id]);
	// Keep the table bounded: finished requests beyond the newest REQUESTS_KEPT go.
	await db.query(
		`DELETE FROM delineation_request WHERE project_id = $1 AND status <> 'queued' AND id NOT IN (
			SELECT id FROM delineation_request WHERE project_id = $1 AND status <> 'queued' ORDER BY created_at DESC, id LIMIT $2)`,
		[o.projectId, REQUESTS_KEPT]
	);
	return { request: await loadRequest(db, o.projectId, requestId), jobId: job.id };
}
