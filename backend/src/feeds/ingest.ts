// Apply a fetch's result to its feed, inside the job's transaction as the
// feed's acting user: merge the days into the target series through the same
// path as POST /projects/:id/series/merge (series/merge.ts mergeInto), then
// record the feed's health. A failed fetch records the failure and writes no
// series data. The result is validated first: in production it arrived over a
// queue from the fetcher Lambda, so it is untrusted input. An answer holding a
// day after the newest the source can have (latestDay) is refused whole.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { mergeInto, SeriesBody } from '../series/merge.js';
import { type FeedSource, SOURCES } from './config.js';
import { FetchResult, utcToday } from './fetch.js';
import { GEFS_DAYS } from './sources/chirps.js';
import { type FeedRow, recordFeedResult } from './store.js';

/** The newest day a source can have on `today` (UTC): a forecast's 16th day, else today. */
export function latestDay(source: FeedSource, today: string): string {
	return source === 'chirps_gefs' ? fromEpochDay(toEpochDay(today) + GEFS_DAYS - 1) : today;
}

export interface IngestOutcome {
	merged: number;
	lastDate: string | null;
}

export async function ingestResult(db: Db, feed: FeedRow, raw: unknown): Promise<IngestOutcome> {
	const parsed = FetchResult.safeParse(raw);
	if (!parsed.success) {
		await recordFeedResult(db, feed.id, { ok: false, error: 'the fetcher’s answer was not valid, so nothing was written' });
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
	await recordFeedResult(db, feed.id, { ok: true, lastDate, lastValue, meta: { ...result.meta, merged } });
	return { merged, lastDate };
}
