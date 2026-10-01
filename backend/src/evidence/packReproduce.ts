// The server's re-run of an issued evidence pack from the API's side
// (154_pack_reproduce; docs/evidence-pack.md § Reproduction): queue it with
// the issue, and say where it is on the pack's page. The re-run itself is
// jobs/handlers/pack-reproduce.ts. Not on verify: it is the app's own claim.
import type { BundleCheck } from '@water-management/engine';
import type { Db } from '../db/tx.js';
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
 * with, when and every check; `checking` while its job is queued, running or
 * waiting to retry; `failed` when the job gave up (`error` says why); `none`
 * for a draft, or a pack issued before re-runs.
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
}

const NONE: PackReproductionState = { status: 'none', engineVersion: null, runEngines: [], checkedAt: null, checks: [], error: null };

/** A pack's re-run state (RLS: the caller reads the pack, its outcomes and its jobs as a viewer). The newest outcome stands. */
export async function packReproductionState(db: Db, projectId: string, packId: string): Promise<PackReproductionState> {
	const { rows } = await db.query<{ outcome: PackReproductionOutcome; engineVersion: string; runEngines: string[]; checkedAt: Date; checks: BundleCheck[] }>(
		`SELECT outcome, engine_version AS "engineVersion", run_engines AS "runEngines", checked_at AS "checkedAt", checks
		 FROM pack_reproduction WHERE project_id = $1 AND pack_id = $2 ORDER BY checked_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	const done = rows[0];
	if (done) return { status: done.outcome, engineVersion: done.engineVersion, runEngines: done.runEngines, checkedAt: done.checkedAt.toISOString(), checks: done.checks, error: null };
	const { rows: jobs } = await db.query<{ status: string; error: string | null }>(
		`SELECT status, last_error AS error FROM job WHERE project_id = $1 AND kind = 'pack_reproduce' AND payload->>'packId' = $2
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	const job = jobs[0];
	if (!job) return NONE;
	if (job.status === 'dead') return { ...NONE, status: 'failed', error: job.error };
	return { ...NONE, status: 'checking' };
}
