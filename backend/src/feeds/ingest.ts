// Apply a fetch's result to its feed, inside the job's transaction as the
// feed's acting user: merge the days into the target series through the same
// path as POST /projects/:id/series/merge (series/merge.ts mergeSeries), then
// record the feed's health. The change history (030_history.sql) gets a
// series.merged event for days that changed (no series revision: a feed's
// merges are append-mostly and would push a person's restore points out) and
// a feed.failed event when a working feed starts failing, not on every
// failed attempt after that. A failed fetch records the failure and writes no
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
import { recordAudit, seriesSubject } from '../history/record.js';
import { mergeSeries, SeriesBody } from '../series/merge.js';
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

/** Record a failed fetch; the first failure after a success (or ever) goes in the project's history too. */
async function failed(db: Db, feed: FeedRow, error: string): Promise<IngestOutcome> {
	const { rows } = await db.query<{ n: number }>('SELECT consecutive_failures AS n FROM data_feed WHERE id = $1', [feed.id]);
	await recordFeedResult(db, feed.id, { ok: false, error });
	if ((rows[0]?.n ?? 0) === 0) {
		await recordAudit(db, feed.projectId, 'feed.failed', { feedId: feed.id, source: feed.source, targetKind: feed.targetKind, targetName: feed.targetName, error });
	}
	return { merged: 0, lastDate: null };
}

/**
 * `window` is what the fetch asked for. A forecast is checked by its issue
 * instead (it reads the newest issue, whatever the window), and records no
 * `through`.
 */
export async function ingestResult(db: Db, feed: FeedRow, raw: unknown, window: FetchWindow): Promise<IngestOutcome> {
	const parsed = FetchResult.safeParse(raw);
	if (!parsed.success || (feed.source === 'chirps_gefs' && parsed.data.ok && !isKeyedIssue(parsed.data))) {
		return failed(db, feed, INVALID);
	}
	const result = parsed.data;
	if (!result.ok) return failed(db, feed, result.error);
	// A day the source can't have published yet (a wrong clock or a bad
	// message) would become the feed's newest date, which only moves forward:
	// every later window would start after it and the feed would never read
	// real days again. Refuse the whole answer.
	const latest = latestDay(feed.source, utcToday());
	if (result.startDate !== null && toEpochDay(result.startDate) + result.values.length - 1 > toEpochDay(latest)) {
		return failed(db, feed, `the fetcher’s answer had days after ${latest}, so nothing was written`);
	}
	// A day the fetch didn't ask for: a bug, or an answer for another request.
	// Merging it could overwrite days the feed doesn't own (before startDate).
	if (
		feed.source !== 'chirps_gefs' &&
		result.startDate !== null &&
		(result.startDate < window.start || fromEpochDay(toEpochDay(result.startDate) + result.values.length - 1) > window.end)
	) {
		return failed(db, feed, `the fetcher’s answer had days outside ${window.start} to ${window.end}, the days it was asked for, so nothing was written`);
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
				const r = await mergeSeries(db, feed.projectId, body, { keepOnNull: true });
				const subject = seriesSubject(r.meta, r.before, r.after, { feedId: feed.id, source: feed.source });
				if (subject.daysChanged) await recordAudit(db, feed.projectId, r.before ? 'series.merged' : 'series.created', subject);
			} catch (err) {
				// The merge refuses before writing (e.g. the series would pass 60 000 days).
				if (!(err instanceof ApiError)) throw err;
				return failed(db, feed, `the series could not take the new days: ${err.message}`);
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
