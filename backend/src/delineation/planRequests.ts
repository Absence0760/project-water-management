// Start and Divide plans on the background worker (#646 item 3,
// 272_plan_request; docs/design/delineation.md § Where it runs). A plan whose
// routing still reaches the edge of the request's last window (3 072 cells,
// about 100 km at zoom 11) or runs out of its 20 s goes to the worker's
// `delineate` job as Delineate's clicks do (requests.ts): the same code with
// the worker's larger windows (up to 6 144 cells) from the next one, the
// first placed over where the request's window cut the catchment (`aim`).
//
// A Start answers at once with the plan a server without a DEM makes from
// the same map (start.ts planWithoutDem, the F11 fallback: since start-16 the
// units' areas are their boundaries', so only the order and the checks wait),
// and the job's routed plan replaces that one while it is still open. A
// Divide has no plan without a DEM, so the route answers 202 with the request
// and the Map waits for it. With no worker running (`pnpm dev`, the local
// default), a Start keeps the fallback and a Divide waits.
//
// The request row keeps the plan's body as the editor sent it (the job reads
// the map again, as that editor, so a feature deleted since is refused, never
// routed); the cap, the dedupe key and the pruning are the clicks'.
import type { Db } from '../db/tx.js';
import { ApiError, notFound } from '../http/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { UUID } from '../projects/access.js';
import type { WindowAim } from './delineate.js';
import { DELINEATE_MAX_ATTEMPTS, pruneRequests, requestSelect, takeJobSlot, type RequestRow } from './requests.js';
import { loadProposal, toProposal } from './start.js';

export type PlanKind = 'start' | 'divide';

/** What the Map shows of a plan request: its outcome, or while it has none, its job's state (as DelineationRequest). */
export interface PlanRequest {
	id: string;
	kind: PlanKind;
	status: 'queued' | 'running' | 'failed' | 'proposed' | 'refused' | 'superseded';
	/** 0–100 while the job runs (one step per window), else null. */
	progress: number | null;
	error: string | null;
	/** With `proposed`: the routed proposal, as it is now (null once pruned). */
	proposal: ReturnType<typeof toProposal> | null;
	/** A Start's proposal without the order (F11) that the routed one replaces while it is open; null for a Divide. */
	fallbackId: string | null;
	/** With `refused`: why, in the request's own words. */
	refusal: { reason: string; message: string } | null;
	createdAt: string;
	finishedAt: string | null;
}

type ViewRow = RequestRow & { job_status: string | null; job_progress: number | null; job_error: string | null };

async function planView(db: Db, projectId: string, r: ViewRow): Promise<PlanRequest> {
	let status: PlanRequest['status'] = r.status;
	let error: string | null = null;
	if (r.status === 'queued') {
		if (r.job_status === 'running') status = 'running';
		else if (r.job_status === 'queued' || r.job_status === 'failed') status = 'queued';
		else {
			status = 'failed';
			error = r.job_error ?? 'The background job that had it is gone.';
		}
	}
	const proposal = r.status === 'proposed' && r.plan_proposal_id ? toProposal(await loadProposal(db, projectId, r.plan_proposal_id)) : null;
	return {
		id: r.id,
		kind: r.plan_kind!,
		status,
		progress: status === 'running' ? r.job_progress : null,
		error,
		proposal,
		fallbackId: r.fallback_proposal_id,
		refusal: r.status === 'refused' ? { reason: r.refusal_code!, message: r.refusal! } : null,
		createdAt: r.created_at.toISOString(),
		finishedAt: r.finished_at?.toISOString() ?? null
	};
}

/** One plan request of the project (404 when there is none, it is a click's, or another project's). */
export async function loadPlanRequest(db: Db, projectId: string, rid: string): Promise<PlanRequest> {
	if (!UUID.test(rid)) throw notFound();
	const { rows } = await db.query<ViewRow>(`${requestSelect(true)} AND r.id = $2`, [projectId, rid]);
	if (!rows[0]) throw notFound();
	return planView(db, projectId, rows[0]);
}

/** The project's newest plan request while it waits for its outcome (a reopened sheet resumes it), else null. */
export async function waitingPlanRequest(db: Db, projectId: string): Promise<PlanRequest | null> {
	const { rows } = await db.query<ViewRow>(`${requestSelect(true)} AND r.status = 'queued' ORDER BY r.created_at DESC, r.id LIMIT 1`, [projectId]);
	return rows[0] ? planView(db, projectId, rows[0]) : null;
}

export interface QueuePlanOptions {
	projectId: string;
	userId: string;
	kind: PlanKind;
	/** The plan's request body, already checked (ProposeBody, DivideBody). */
	body: unknown;
	/** The smallest window the job tries. */
	fromWindow: number;
	/** Where the request's last window cut the catchment, for the job's first window. */
	aim: WindowAim | null;
	/** A Start's proposal without the order (F11), made in this transaction. */
	fallbackId: string | null;
}

/**
 * Hand a plan to the worker, as the transaction's user (an editor; the caller has checked). Returns the request; wake the
 * worker with its job after the commit. 429 while the account has a delineation or plan running, or waiting elsewhere.
 */
export async function queuePlan(db: Db, o: QueuePlanOptions): Promise<{ request: PlanRequest; jobId: string }> {
	await takeJobSlot(db, o.projectId, true);
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO delineation_request (project_id, plan_kind, plan_body, from_window, aim, fallback_proposal_id, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
		[o.projectId, o.kind, JSON.stringify(o.body), o.fromWindow, o.aim ? JSON.stringify(o.aim) : null, o.fallbackId]
	);
	const requestId = rows[0]!.id;
	const { job, created } = await enqueueJob(db, {
		projectId: o.projectId,
		kind: 'delineate',
		payload: { requestId },
		// The account's one pending delineation (a click or a plan): the cap above holds it across projects.
		dedupeKey: `delineate:${o.userId}`,
		maxAttempts: DELINEATE_MAX_ATTEMPTS
	});
	if (!created) throw new ApiError(429, 'You have a large delineation waiting; wait for it to finish.');
	await db.query('UPDATE delineation_request SET job_id = $2 WHERE id = $1', [requestId, job.id]);
	await pruneRequests(db, o.projectId);
	return { request: await loadPlanRequest(db, o.projectId, requestId), jobId: job.id };
}
