// A feed's health, as the status panel shows it: one state and the reason for
// it, a code with its facts (the client writes the sentence and formats the
// days, so no date is baked into server text). Pure, from the feed's health
// columns, today and the project's time zone: every day it reports or counts
// to (today, when it was checked, attached or last grew) is the calendar day
// where the catchment is (project.time_zone, 058), not UTC's, which is a day
// behind a South African reader from 22:00 to 24:00 UTC. The source's own
// days (lastDataDate, a staged record's from/through) are the source's dates
// and pass through as they are.
//
//   disabled  switched off by an owner
//   failing   the last fetch failed (consecutive_failures > 0)
//   stale     no failure, but the newest day is older than the source's usual
//             lag allows (config.ts SOURCES staleAfterDays, or the feed's own
//             staleAfterDays): the source stopped publishing, or the fetch
//             keeps finding nothing new
//   pending   not fetched yet, or not since a new place or series was saved
//             (018_feeds.sql clears the data, success and failures then), or
//             a confirmed replacement still backfilling (feed_stage, 032)
//   ok        otherwise
//
// `stale` is also reported on its own, so a failing feed that is out of date
// says both.
import { toEpochDay } from '@water-management/engine/calendar';
import { localDate } from '../projects/timeZone.js';
import { type FeedConfig, type FeedSource, SOURCES } from './config.js';

export const FEED_STATES = ['ok', 'stale', 'failing', 'pending', 'disabled'] as const;
export type FeedState = (typeof FEED_STATES)[number];

/**
 * Why the feed is in its state. Days are calendar days (YYYY-MM-DD): the
 * source's own for `newest`, `from` and `through`, the project's time zone's
 * for `checked` and `since`.
 *
 *   off           switched off; `newest` is the newest day, or null
 *   failing       `failures` fetches in a row failed, the last with `error`
 *   old-forecast  the forecast reaches only `newest`, fewer than
 *                 -staleAfterDays days ahead
 *   old-data      the newest day, `newest`, is more than staleAfterDays old
 *   no-data       fetches succeed but have found nothing yet
 *   not-fetched   not fetched since it was attached / changed on `since`
 *   waiting       waiting for its first fetch
 *   ok            `newest` (or null), last checked on `checked`
 *   rebuilding    a confirmed replacement backfilling: the new record runs
 *                 `from` … `through` so far; the live series is unchanged
 *                 until it is caught up
 *   rebuild-stalled  the same, but it hasn't grown since `since` (over a
 *                 day): the stage waits, the live series is unchanged
 */
export type HealthReason =
	| { code: 'off'; newest: string | null }
	| { code: 'failing'; failures: number; error: string | null; newest: string | null }
	| { code: 'old-forecast'; newest: string }
	| { code: 'old-data'; newest: string }
	| { code: 'no-data' }
	| { code: 'not-fetched'; since: string; after: 'attached' | 'changed' }
	| { code: 'waiting' }
	| { code: 'ok'; newest: string | null; checked: string }
	| { code: 'rebuilding'; from: string; through: string }
	| { code: 'rebuild-stalled'; from: string; through: string; since: string };

export interface FeedHealth {
	state: FeedState;
	stale: boolean;
	staleAfterDays: number;
	reason: HealthReason;
}

export interface HealthInput {
	source: FeedSource;
	config: FeedConfig;
	enabled: boolean;
	createdAt: Date | string;
	/** The last save; a feed with no data counts its grace from here. */
	updatedAt?: Date | string;
	lastAttemptAt: Date | string | null;
	lastSuccessAt: Date | string | null;
	lastDataDate: string | null;
	consecutiveFailures: number;
	lastError: string | null;
	/** A staged replacement (FeedMeta.rebuilding), or null/absent. */
	rebuilding?: { startDate: string; through: string; updatedAt: Date | string } | null;
}

/** A staged replacement that hasn't grown for this long is stalled (its next window runs a minute after the last). */
export const REBUILD_STALL_DAYS = 1;

/** A feed with no data counts as stale this long after it was attached or last saved. */
const FIRST_DATA_GRACE_DAYS = 2;

/**
 * `f`'s health on `today`, the calendar day in `timeZone` (the caller's
 * localDate(now, project.time_zone)); the instants it reports are dated in
 * that zone too.
 */
export function feedHealth(f: HealthInput, today: string, timeZone: string): FeedHealth {
	const iso = (d: Date | string) => localDate(typeof d === 'string' ? new Date(d) : d, timeZone);
	const staleAfterDays = f.config.staleAfterDays ?? SOURCES[f.source].staleAfterDays;
	const t = toEpochDay(today);
	const since = f.updatedAt ?? f.createdAt;
	// No outcome recorded for the current place and series (a re-target keeps only last_attempt_at).
	const unfetched = !f.lastSuccessAt && f.consecutiveFailures === 0;
	const stale = f.lastDataDate
		? t - toEpochDay(f.lastDataDate) > staleAfterDays
		: t - toEpochDay(iso(since)) > FIRST_DATA_GRACE_DAYS;
	const newest = f.lastDataDate;
	const out = (state: FeedState, reason: HealthReason): FeedHealth => ({ state, stale, staleAfterDays, reason });
	if (!f.enabled) return out('disabled', { code: 'off', newest });
	if (f.consecutiveFailures > 0) return out('failing', { code: 'failing', failures: f.consecutiveFailures, error: f.lastError, newest });
	// A backfilling replacement reads old days, so "old data" says nothing: say how far it has got, or that it stopped.
	if (f.rebuilding) {
		const r = f.rebuilding;
		const since = iso(r.updatedAt);
		if (t - toEpochDay(since) > REBUILD_STALL_DAYS) return { state: 'stale', stale: true, staleAfterDays, reason: { code: 'rebuild-stalled', from: r.startDate, through: r.through, since } };
		return { state: 'pending', stale: false, staleAfterDays, reason: { code: 'rebuilding', from: r.startDate, through: r.through } };
	}
	if (stale) {
		if (newest) return out('stale', staleAfterDays < 0 ? { code: 'old-forecast', newest } : { code: 'old-data', newest });
		if (!unfetched) return out('stale', { code: 'no-data' });
		return out('stale', { code: 'not-fetched', since: iso(since), after: iso(since) === iso(f.createdAt) ? 'attached' : 'changed' });
	}
	if (unfetched || !f.lastAttemptAt) return out('pending', { code: 'waiting' });
	return out('ok', { code: 'ok', newest, checked: iso(f.lastSuccessAt ?? f.lastAttemptAt) });
}
