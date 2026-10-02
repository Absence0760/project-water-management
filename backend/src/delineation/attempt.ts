// The per-account cap on elevation-model work (184_dem_attempt, docs/security.md
// § Map uploads): delineate, start from the map and divide each begin an
// attempt in the transaction that checks the caller's role, before reading the
// DEM, and finish it whatever the outcome. Refused and failed attempts count
// for the hour like stored ones; at most DEM_ATTEMPTS.inFlight run at once
// per account.
import { withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';

/**
 * Per account, across every project. An hour of real map work is a few dozen
 * proposals at most (the per-project cap is 30 stored ones); two at once
 * covers a second tab. The lease frees the slot of an attempt whose Lambda
 * died mid-work, well past the API Lambda's 30 s timeout.
 */
export const DEM_ATTEMPTS = { perHour: 60, inFlight: 2, lease: '2 minutes' } as const;

export type DemAttemptKind = 'delineation' | 'start' | 'divide';

/** Begins one attempt as the transaction's user, or throws 429. Returns its id, for finishDemAttempt. */
export async function beginDemAttempt(db: Db, kind: DemAttemptKind): Promise<string> {
	const { rows } = await db.query<{ r: string }>('SELECT app_dem_attempt($1, $2, $3, $4::interval) AS r', [
		kind,
		DEM_ATTEMPTS.perHour,
		DEM_ATTEMPTS.inFlight,
		DEM_ATTEMPTS.lease
	]);
	const r = rows[0]!.r;
	if (r === 'in_flight') {
		throw new ApiError(429, `You already have ${DEM_ATTEMPTS.inFlight} elevation-model requests running; wait for one to finish.`);
	}
	if (r === 'hourly') {
		throw new ApiError(429, `You have asked the elevation model ${DEM_ATTEMPTS.perHour} times in the last hour; try again later.`);
	}
	return r;
}

/**
 * Finishes the attempt (frees its in-flight slot). A failure here is logged,
 * not thrown: the answer the caller already has stands, and the lease frees
 * the slot anyway.
 */
export async function finishDemAttempt(userId: string, attemptId: string): Promise<void> {
	try {
		await withUser(userId, (db) => db.query('SELECT app_dem_attempt_done($1)', [attemptId]));
	} catch (err) {
		logEvent('warn', { event: 'dem_attempt_finish_failed', ...safeError(err) });
	}
}
