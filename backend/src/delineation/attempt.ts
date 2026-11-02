// The per-account cap on elevation-model work (184_dem_attempt, docs/security.md
// § Map uploads): delineate, start from the map and divide each begin an
// attempt in the transaction that checks the caller's role, before reading the
// DEM, and finish it whatever the outcome. Refused and failed attempts count
// for the hour like stored ones; at most DEM_ATTEMPTS.inFlight run at once
// per account. The Map's channel tiles (channelRoutes.ts) count apart, in
// their own pool with CHANNEL_ATTEMPTS (307), so the DEM rivers layer can
// never spend the hour a delineation needs.
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

/**
 * The channel tiles' own pool (307), apart from delineation's: a tile computed
 * (not cached) is about 0.4 s to a few seconds of CPU. One person panning hard
 * over new ground with the DEM rivers layer on asks about 30 tiles in a busy
 * 5 minutes (at most 9 a view, each once a session); an hour of real
 * exploring is a few dozen to a hundred new tiles. 150 an hour covers that
 * with room, and bounds one account at a few CPU-minutes an hour; two at
 * once covers a second tab (the layer fetches one at a time). The WAF's
 * waf_dem_rate_limit_per_ip stays the outer bound per address.
 */
export const CHANNEL_ATTEMPTS = { perHour: 150, inFlight: 2, lease: '2 minutes' } as const;

export type DemAttemptKind = 'delineation' | 'start' | 'divide' | 'channels';

/** The refusal's `details.reason` when the channel tiles' hourly pool is spent: the Map says the DEM rivers are paused, not an error. */
export const CHANNELS_HOURLY = 'channels_hourly';

/** Begins one attempt as the transaction's user, or throws 429. Returns its id, for finishDemAttempt. */
export async function beginDemAttempt(db: Db, kind: DemAttemptKind): Promise<string> {
	const caps = kind === 'channels' ? CHANNEL_ATTEMPTS : DEM_ATTEMPTS;
	const { rows } = await db.query<{ r: string }>('SELECT app_dem_attempt($1, $2, $3, $4::interval) AS r', [kind, caps.perHour, caps.inFlight, caps.lease]);
	const r = rows[0]!.r;
	if (kind === 'channels' && r === 'in_flight') {
		throw new ApiError(429, `You already have ${caps.inFlight} squares of DEM rivers being worked out; wait for one to finish.`);
	}
	if (kind === 'channels' && r === 'hourly') {
		throw new ApiError(429, `DEM rivers paused for this hour (${caps.perHour} new squares an hour); delineation still works.`, { reason: CHANNELS_HOURLY });
	}
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
