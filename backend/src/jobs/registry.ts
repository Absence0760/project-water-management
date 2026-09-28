// The handler registry: what the worker runs for each job kind (016_jobs.sql,
// docs/architecture.md § Background work).
//
// A handler is a plain object. The worker, not the handler, does everything
// around it:
//   1. opens withUser(job.acting_user_id): a transaction as that user, under
//      normal RLS;
//   2. checks the acting user still holds `role` on the job's project, and
//      fails the job closed (dead, no retry) if not;
//   3. reads the payload as that user and validates it with `payload`
//      (a stored payload is untrusted input: a request or a fetcher wrote it);
//   4. calls `run`, then records success in the same transaction, so the
//      handler's writes and "done" commit together or not at all.
// A throw rolls the handler's writes back and is recorded as a failure
// (jobs/errors.ts decides whether it is retried and what the stored error says).
//
// To add a kind: write `handlers/<kind>.ts` exporting a `defineHandler(…)`,
// and list it in `handlers/index.ts`. The kind must be one of JOB_KINDS (the
// table's CHECK).
import type { z } from 'zod';
import type { Db } from '../db/tx.js';
import type { Role } from '../projects/access.js';

/** Every kind the job table accepts (016_jobs.sql CHECK; 040_yield added `yield`, 062_scenario_sweeps `sweep`, 063_seasonal_outlook `outlook`). */
export const JOB_KINDS = ['feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** A claimed job, as the worker routes it. */
export interface ClaimedJob {
	id: string;
	projectId: string;
	kind: JobKind;
	actingUserId: string;
	leaseToken: string;
	/** This attempt's number, from 1. */
	attempts: number;
	maxAttempts: number;
}

export interface JobContext<P> {
	/** The transaction, as the acting user (withUser). */
	db: Db;
	job: Readonly<ClaimedJob>;
	payload: P;
	/**
	 * Report how far the job is, 0–100 (040_yield app_job_progress). Written
	 * outside the job's transaction, so the status list sees it at once.
	 * Answers false when the job should stop: someone cancelled it
	 * (app_cancel_job) or the lease was lost. Optional to call.
	 */
	progress(pct: number): Promise<boolean>;
}

export interface JobHandler<P = unknown> {
	/** The least project role the acting user must still hold when the job runs. */
	role: Role;
	/**
	 * One role below `role` that may also run it (exactly that role, not the
	 * ones between), when the handler itself checks what that role may do:
	 * `yield`'s contributor, on their own application only (yieldInputFor,
	 * 095_contributor_yield). Allowlisted in trust.security.db.test.ts.
	 */
	alsoRole?: Role;
	/** Validates the stored payload. A payload that fails is dead at once. */
	payload: z.ZodType<P>;
	/**
	 * Do the work inside the acting user's transaction. Must be safe to run
	 * again after a failure (the transaction rolled back), which it is if all
	 * its effects are database writes through `db`. Keep network I/O out:
	 * it would hold the transaction open.
	 */
	run(ctx: JobContext<P>): Promise<void>;
}

export type HandlerRegistry = Partial<Record<JobKind, JobHandler<any>>>;

/** Identity, for inference: `export const fooHandler = defineHandler({ … })`. */
export const defineHandler = <P>(handler: JobHandler<P>): JobHandler<P> => handler;
