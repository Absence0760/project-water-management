// A feed's health, as the status panel shows it: one state and a sentence.
// Pure, from the feed's health columns and today's UTC date.
//
//   disabled  switched off by an owner
//   failing   the last fetch failed (consecutive_failures > 0)
//   stale     no failure, but the newest day is older than the source's usual
//             lag allows (config.ts SOURCES staleAfterDays, or the feed's own
//             staleAfterDays): the source stopped publishing, or the fetch
//             keeps finding nothing new
//   pending   never fetched yet
//   ok        otherwise
//
// `stale` is also reported on its own, so a failing feed that is out of date
// says both.
import { toEpochDay } from '@water-management/engine';
import { type FeedConfig, type FeedSource, SOURCES } from './config.js';

export const FEED_STATES = ['ok', 'stale', 'failing', 'pending', 'disabled'] as const;
export type FeedState = (typeof FEED_STATES)[number];

export interface FeedHealth {
	state: FeedState;
	stale: boolean;
	staleAfterDays: number;
	message: string;
}

export interface HealthInput {
	source: FeedSource;
	config: FeedConfig;
	enabled: boolean;
	createdAt: Date | string;
	lastAttemptAt: Date | string | null;
	lastSuccessAt: Date | string | null;
	lastDataDate: string | null;
	consecutiveFailures: number;
	lastError: string | null;
}

/** A never-successful feed counts as stale this long after it was attached. */
const FIRST_DATA_GRACE_DAYS = 2;

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

export function feedHealth(f: HealthInput, today: string): FeedHealth {
	const staleAfterDays = f.config.staleAfterDays ?? SOURCES[f.source].staleAfterDays;
	const t = toEpochDay(today);
	const stale = f.lastDataDate
		? t - toEpochDay(f.lastDataDate) > staleAfterDays
		: t - toEpochDay(iso(f.createdAt)) > FIRST_DATA_GRACE_DAYS;
	const newest = f.lastDataDate ? `newest data ${f.lastDataDate}` : 'no data yet';
	if (!f.enabled) return { state: 'disabled', stale, staleAfterDays, message: `Switched off; ${newest}.` };
	if (f.consecutiveFailures > 0) {
		const n = f.consecutiveFailures;
		return {
			state: 'failing',
			stale,
			staleAfterDays,
			message: `${n === 1 ? 'The last fetch failed' : `The last ${n} fetches failed`}: ${f.lastError ?? 'unknown error'}. ${cap(newest)}.`
		};
	}
	if (stale) {
		return {
			state: 'stale',
			stale,
			staleAfterDays,
			message: f.lastDataDate
				? staleAfterDays < 0
					? `No new forecast: it reaches only ${f.lastDataDate}, less than ${-staleAfterDays} days ahead.`
					: `No new data: the newest day, ${f.lastDataDate}, is more than ${staleAfterDays} days old.`
				: f.lastAttemptAt
					? 'Fetches succeed but have found no data yet: check the cells or station.'
					: `Not fetched since it was attached on ${iso(f.createdAt)}: the background worker may not be running.`
		};
	}
	if (!f.lastAttemptAt) return { state: 'pending', stale, staleAfterDays, message: 'Waiting for its first fetch.' };
	return { state: 'ok', stale, staleAfterDays, message: `OK; ${newest}, checked ${iso(f.lastSuccessAt ?? f.lastAttemptAt)}.` };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
