// What a failed job records (job.last_error, shown to viewers by
// GET /projects/:id/jobs) and whether it is retried. The stored text is
// written by us, never taken from the database: a Postgres error's message
// can name tables, columns and constraint internals.
import { ZodError } from 'zod';
import { ApiError } from '../http/errors.js';

/** The longest stored error (016_jobs.sql CHECK). */
export const JOB_ERROR_MAX = 500;

/**
 * Throw from a handler to fail the job with this message. `retry: false` is
 * for failures another attempt can't fix (bad input, a missing series): the
 * job is dead at once instead of retrying with backoff.
 */
export class JobError extends Error {
	readonly retry: boolean;
	constructor(message: string, { retry = true }: { retry?: boolean } = {}) {
		super(message);
		this.retry = retry;
	}
}

/**
 * Throw from a handler to hand the job back to the queue without spending
 * the attempt its claim counted (app_release_job, 191): the tick had too
 * little time left for it, which says nothing about the job. It runs again
 * after `delaySeconds` (past the rest of this tick). Not a failure: no
 * error kept, no backoff.
 */
export class JobRelease extends Error {
	constructor(
		message: string,
		readonly delaySeconds: number
	) {
		super(message);
	}
}

/** The worker lost its lease (another worker claimed the job): roll back, record nothing. */
export class LeaseLostError extends Error {
	constructor() {
		super('lease lost');
	}
}

/** SQLSTATE classes worth another attempt: connection loss, serialisation, deadlock, shutdown, resources. */
const TRANSIENT_PG = /^(08|40|53|57)/;

/**
 * The stored message and retry decision for anything a job threw. `expected`
 * is false for an error we didn't author (the worker logs those in full, to
 * the server log only).
 */
export function describeFailure(err: unknown): { message: string; retry: boolean; expected: boolean } {
	const clip = (s: string) => (s.length > JOB_ERROR_MAX ? `${s.slice(0, JOB_ERROR_MAX - 1)}…` : s);
	if (err instanceof JobError) return { message: clip(err.message), retry: err.retry, expected: true };
	if (err instanceof ApiError) {
		// Rate limits pass; every other client error is about the input or the
		// user's rights, which a retry doesn't change.
		return { message: clip(err.message), retry: err.status === 429, expected: true };
	}
	if (err instanceof ZodError) return { message: 'the job’s payload is not valid', retry: false, expected: true };
	const code = (err as { code?: unknown }).code;
	if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
		if (code === '42501') return { message: 'not permitted', retry: false, expected: true };
		return { message: `a database error (SQLSTATE ${code})`, retry: true, expected: TRANSIENT_PG.test(code) };
	}
	return { message: 'an internal error', retry: true, expected: false };
}
