// The server's re-run of an issued evidence pack from the API's side
// (154_pack_reproduce; docs/evidence-pack.md § Reproduction): queue it with
// the issue, queue it again on an editor's request (POST …/packs/:packId/
// reproduce: after the job gave up, or on a newer engine), and say where it
// is on the pack's page. The re-run itself is jobs/handlers/pack-reproduce.ts.
// Not on verify: it is the app's own claim.
import { type BundleCheck, ENGINE_VERSION } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { enqueueJob } from '../jobs/queue.js';

/** One pending re-run per pack. */
export const packReproduceDedupeKey = (packId: string) => `pack_reproduce:${packId}`;

/** Attempts before a re-run that keeps failing (the store unreachable) is given up. */
export const PACK_REPRODUCE_MAX_ATTEMPTS = 3;

/**
 * Queue a pack's re-run as the transaction's user (an editor: job_insert's
 * RLS), in the issue's transaction. Wake the worker after the commit.
 */
export async function queuePackReproduce(db: Db, projectId: string, packId: string): Promise<{ jobId: string; created: boolean }> {
	const { job, created } = await enqueueJob(db, {
		projectId,
		kind: 'pack_reproduce',
		payload: { packId },
		dedupeKey: packReproduceDedupeKey(packId),
		maxAttempts: PACK_REPRODUCE_MAX_ATTEMPTS
	});
	return { jobId: job.id, created };
}

/** What a recorded re-run found (pack_reproduction.outcome). */
export const PACK_REPRODUCTION_OUTCOMES = ['reproduced', 'not_reproduced', 'other_engine', 'no_bundle'] as const;
export type PackReproductionOutcome = (typeof PACK_REPRODUCTION_OUTCOMES)[number];

/**
 * Where a pack's server re-run is: a recorded outcome (`reproduced`,
 * `not_reproduced`, `other_engine`, `no_bundle`) with the engine it re-ran
 * with, when and every check; `checking` while a job is queued, running or
 * waiting to retry; `failed` when the newest job gave up after the newest
 * outcome (`error` says why); `none` for a draft, or a pack issued before
 * re-runs and never re-run since.
 */
export interface PackReproductionState {
	status: PackReproductionOutcome | 'checking' | 'failed' | 'none';
	/** The engine version that re-ran the runs (a recorded outcome only). */
	engineVersion: string | null;
	/** The engines the runs were made with. */
	runEngines: string[];
	checkedAt: string | null;
	checks: BundleCheck[];
	error: string | null;
	/** The engine this server re-runs with (ENGINE_VERSION). */
	serverEngine: string;
	/**
	 * Whether an editor may ask for a re-run now (POST …/reproduce): the pack
	 * was issued, no re-run is pending, and no outcome is recorded on the
	 * server's engine (one per pack and engine stands).
	 */
	canRerun: boolean;
}

const none = (canRerun: boolean): PackReproductionState => ({ status: 'none', engineVersion: null, runEngines: [], checkedAt: null, checks: [], error: null, serverEngine: ENGINE_VERSION, canRerun });

/** The pack's re-run job that is still to finish (queued, running or waiting to retry), if any. */
async function pendingReproduce(db: Db, projectId: string, packId: string): Promise<string | null> {
	const { rows } = await db.query<{ id: string }>(
		`SELECT id FROM job WHERE project_id = $1 AND kind = 'pack_reproduce' AND payload->>'packId' = $2 AND status IN ('queued', 'running', 'failed')
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	return rows[0]?.id ?? null;
}

/** Whether an outcome is recorded for the pack on this server's engine. */
async function recordedHere(db: Db, projectId: string, packId: string): Promise<boolean> {
	const { rows } = await db.query<{ here: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM pack_reproduction WHERE project_id = $1 AND pack_id = $2 AND engine_version = $3) AS here',
		[projectId, packId, ENGINE_VERSION]
	);
	return rows[0]?.here ?? false;
}

/**
 * A pack's re-run state (RLS: the caller reads the pack, its outcomes and its
 * jobs as a viewer). A job newer than the newest outcome wins while it is
 * pending, or once it gave up; otherwise the newest outcome stands.
 */
export async function packReproductionState(db: Db, projectId: string, packId: string, issued: boolean): Promise<PackReproductionState> {
	const { rows } = await db.query<{ outcome: PackReproductionOutcome; engineVersion: string; runEngines: string[]; checkedAt: Date; checks: BundleCheck[] }>(
		`SELECT outcome, engine_version AS "engineVersion", run_engines AS "runEngines", checked_at AS "checkedAt", checks
		 FROM pack_reproduction WHERE project_id = $1 AND pack_id = $2 ORDER BY checked_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	const done = rows[0];
	const { rows: jobs } = await db.query<{ status: string; error: string | null; createdAt: Date }>(
		`SELECT status, last_error AS error, created_at AS "createdAt" FROM job WHERE project_id = $1 AND kind = 'pack_reproduce' AND payload->>'packId' = $2
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	const job = jobs[0];
	const pending = job !== undefined && ['queued', 'running', 'failed'].includes(job.status);
	const canRerun = issued && !pending && !(await recordedHere(db, projectId, packId));
	if (pending) return { ...none(canRerun), status: 'checking' };
	if (job?.status === 'dead' && (!done || job.createdAt > done.checkedAt)) return { ...none(canRerun), status: 'failed', error: job.error };
	if (done)
		return {
			status: done.outcome,
			engineVersion: done.engineVersion,
			runEngines: done.runEngines,
			checkedAt: done.checkedAt.toISOString(),
			checks: done.checks,
			error: null,
			serverEngine: ENGINE_VERSION,
			canRerun
		};
	return none(canRerun);
}

/**
 * An editor's "Re-run on the server" (POST …/packs/:packId/reproduce): queue
 * the pack's re-run again, as the caller. Idempotent while one is pending
 * (the pending job comes back, `created: false`). 409 for a pack never
 * issued, and for one with an outcome on this engine already, which stands
 * (154: one per pack and engine); on a newer engine a new outcome is recorded
 * beside the old one.
 */
export async function requestPackReproduce(db: Db, projectId: string, packId: string, issued: boolean): Promise<{ jobId: string; created: boolean }> {
	if (!issued) throw new ApiError(409, 'a pack that was never issued is not re-run');
	const pending = await pendingReproduce(db, projectId, packId);
	if (pending) return { jobId: pending, created: false };
	if (await recordedHere(db, projectId, packId))
		throw new ApiError(409, `this pack’s re-run on engine ${ENGINE_VERSION} is recorded already, and it stands; a newer engine may re-run it again`);
	return queuePackReproduce(db, projectId, packId);
}
