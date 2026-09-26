// Apply a fetch's result to its feed, inside the job's transaction as the
// feed's acting user: merge the days into the target series through the same
// path as POST /projects/:id/series/merge (series/merge.ts mergeInto), then
// record the feed's health. A failed fetch records the failure and writes no
// series data. The result is validated first: in production it arrived over a
// queue from the fetcher Lambda, so it is untrusted input. An answer holding a
// day after the newest the source can have (latestDay), or a day outside the
// window the fetch asked for, is refused whole (issue #31). The window comes
// from our side, never from the answer: the inline fetch passes its own, and
// the production feed_ingest job claims the one its feed_fetch job recorded
// (store.ts takeFeedFetch), which also drops any answer but the newest
// fetch's. A successful answer records the window's end as last_meta.through,
// how far the feed has read, so fetchWindow moves past empty days (#29).
//
// A CHIRPS-GEFS result is one whole issue, keyed by its issue date: its days
// start on that date and number at most GEFS_DAYS. The newest issue merged
// wins: an older one (the ingest-results queue does not keep order, and a
// fetch before ~08:30 UTC reads yesterday's issue) is dropped without
// touching the series, so it never overwrites a newer forecast's days; the
// feed records only that it was checked (last_attempt_at).
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { mergeInto, SeriesBody } from '../series/merge.js';
import { type FeedSource, SOURCES } from './config.js';
import { FetchResult, type FetchWindow, utcToday } from './fetch.js';
import { GEFS_DAYS } from './sources/chirps.js';
import { type FeedRow, lockFeedIssued, recordFeedChecked, recordFeedResult } from './store.js';

/** The newest day a source can have on `today` (UTC): a forecast's 16th day, else today. */
export function latestDay(source: FeedSource, today: string): string {
	return source === 'chirps_gefs' ? fromEpochDay(toEpochDay(today) + GEFS_DAYS - 1) : today;
}

export interface IngestOutcome {
	merged: number;
	lastDate: string | null;
}

const INVALID = 'the fetcher’s answer was not valid, so nothing was written';

/** A forecast result is one issue: days from its issue date (meta.issued), at most GEFS_DAYS of them. */
const isKeyedIssue = (r: { startDate: string | null; values: unknown[]; meta: Record<string, string | number> }) =>
	r.startDate === null || (r.meta.issued === r.startDate && r.values.length <= GEFS_DAYS);

/**
 * `window` is what the fetch asked for. A forecast is checked by its issue
 * instead (it reads the newest issue, whatever the window), and records no
 * `through`.
 */
export async function ingestResult(db: Db, feed: FeedRow, raw: unknown, window: FetchWindow): Promise<IngestOutcome> {
	const parsed = FetchResult.safeParse(raw);
	if (!parsed.success || (feed.source === 'chirps_gefs' && parsed.data.ok && !isKeyedIssue(parsed.data))) {
		await recordFeedResult(db, feed.id, { ok: false, error: INVALID });
		return { merged: 0, lastDate: null };
	}
	const result = parsed.data;
	if (!result.ok) {
		await recordFeedResult(db, feed.id, { ok: false, error: result.error });
		return { merged: 0, lastDate: null };
	}
	// A day the source can't have published yet (a wrong clock or a bad
	// message) would become the feed's newest date, which only moves forward:
	// every later window would start after it and the feed would never read
	// real days again. Refuse the whole answer.
	const latest = latestDay(feed.source, utcToday());
	if (result.startDate !== null && toEpochDay(result.startDate) + result.values.length - 1 > toEpochDay(latest)) {
		await recordFeedResult(db, feed.id, { ok: false, error: `the fetcher’s answer had days after ${latest}, so nothing was written` });
		return { merged: 0, lastDate: null };
	}
	// A day the fetch didn't ask for: a bug, or an answer for another request.
	// Merging it could overwrite days the feed doesn't own (before startDate).
	if (
		feed.source !== 'chirps_gefs' &&
		result.startDate !== null &&
		(result.startDate < window.start || fromEpochDay(toEpochDay(result.startDate) + result.values.length - 1) > window.end)
	) {
		await recordFeedResult(db, feed.id, {
			ok: false,
			error: `the fetcher’s answer had days outside ${window.start} to ${window.end}, the days it was asked for, so nothing was written`
		});
		return { merged: 0, lastDate: null };
	}
	if (feed.source === 'chirps_gefs' && result.startDate !== null) {
		// ISO calendar dates compare as strings (startDate is checked; meta.issued equals it).
		const newest = await lockFeedIssued(db, feed.id);
		if (newest !== null && result.startDate < newest) {
			await recordFeedChecked(db, feed.id);
			return { merged: 0, lastDate: null };
		}
	}

	let lastDate: string | null = null;
	let lastValue: number | null = null;
	let merged = 0;
	if (result.startDate !== null) {
		let lastIdx = result.values.length - 1;
		while (lastIdx >= 0 && result.values[lastIdx] === null) lastIdx--;
		if (lastIdx >= 0) {
			const body = SeriesBody.parse({
				kind: feed.targetKind,
				name: feed.targetName,
				unit: SOURCES[feed.source].unit,
				startDate: result.startDate,
				values: result.values
			});
			try {
				// keepOnNull: a day the source has no value for leaves whatever is there.
				await mergeInto(db, feed.projectId, body, { keepOnNull: true });
			} catch (err) {
				// The merge refuses before writing (e.g. the series would pass 60 000 days).
				if (!(err instanceof ApiError)) throw err;
				await recordFeedResult(db, feed.id, { ok: false, error: `the series could not take the new days: ${err.message}` });
				return { merged: 0, lastDate: null };
			}
			merged = result.values.filter((v) => v !== null).length;
			lastDate = fromEpochDay(toEpochDay(result.startDate) + lastIdx);
			lastValue = result.values[lastIdx]!;
		}
	}
	// `through` last, so a key of that name in the fetcher's meta never stands.
	const meta = feed.source === 'chirps_gefs' ? { ...result.meta, merged } : { ...result.meta, merged, through: window.end };
	await recordFeedResult(db, feed.id, { ok: true, lastDate, lastValue, meta });
	return { merged, lastDate };
}
