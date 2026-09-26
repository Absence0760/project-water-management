// A feed's health, as the status panel shows it: one state and the reason for
// it, a code with its facts (the client writes the sentence and formats the
// days, so no date is baked into server text). Pure, from the feed's health
// columns and today's UTC date.
//
//   disabled  switched off by an owner
//   failing   the last fetch failed (consecutive_failures > 0)
//   stale     no failure, but the newest day is older than the source's usual
//             lag allows (config.ts SOURCES staleAfterDays, or the feed's own
//             staleAfterDays): the source stopped publishing, or the fetch
//             keeps finding nothing new
//   pending   not fetched yet, or not since a new place or series was saved
//             (018_feeds.sql clears the data, success and failures then)
//   ok        otherwise
//
// `stale` is also reported on its own, so a failing feed that is out of date
// says both.
import { toEpochDay } from '@water-management/engine';
import { type FeedConfig, type FeedSource, SOURCES } from './config.js';

export const FEED_STATES = ['ok', 'stale', 'failing', 'pending', 'disabled'] as const;
export type FeedState = (typeof FEED_STATES)[number];

/**
 * Why the feed is in its state. Days are calendar days (YYYY-MM-DD, UTC).
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
 */
export type HealthReason =
	| { code: 'off'; newest: string | null }
	| { code: 'failing'; failures: number; error: string | null; newest: string | null }
	| { code: 'old-forecast'; newest: string }
	| { code: 'old-data'; newest: string }
	| { code: 'no-data' }
	| { code: 'not-fetched'; since: string; after: 'attached' | 'changed' }
	| { code: 'waiting' }
	| { code: 'ok'; newest: string | null; checked: string };

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
}

/** A feed with no data counts as stale this long after it was attached or last saved. */
const FIRST_DATA_GRACE_DAYS = 2;

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

export function feedHealth(f: HealthInput, today: string): FeedHealth {
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
	if (stale) {
		if (newest) return out('stale', staleAfterDays < 0 ? { code: 'old-forecast', newest } : { code: 'old-data', newest });
		if (!unfetched) return out('stale', { code: 'no-data' });
		return out('stale', { code: 'not-fetched', since: iso(since), after: iso(since) === iso(f.createdAt) ? 'attached' : 'changed' });
	}
	if (unfetched || !f.lastAttemptAt) return out('pending', { code: 'waiting' });
	return out('ok', { code: 'ok', newest, checked: iso(f.lastSuccessAt ?? f.lastAttemptAt) });
}
