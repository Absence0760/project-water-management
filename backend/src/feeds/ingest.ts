// Apply a fetch's result to its feed, inside the job's transaction as the
// feed's acting user: merge the days into the target series through the same
// path as POST /projects/:id/series/merge (series/merge.ts mergeSeries), then
// record the feed's health. The change history (026_history.sql) gets a
// series.merged event for days that changed (no series revision: a feed's
// merges are append-mostly and would push a person's restore points out) and
// a feed.failed event when a working feed starts failing, not on every
// failed attempt after that. A failed fetch records the failure and writes no
// series data. The result is validated first: in production it arrived over a
// queue from the fetcher Lambda, so it is untrusted input.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { recordAudit, seriesSubject } from '../history/record.js';
import { mergeSeries, SeriesBody } from '../series/merge.js';
import { SOURCES } from './config.js';
import { FetchResult } from './fetch.js';
import { type FeedRow, recordFeedResult } from './store.js';

export interface IngestOutcome {
	merged: number;
	lastDate: string | null;
}

/** Record a failed fetch; the first failure after a success (or ever) goes in the project's history too. */
async function failed(db: Db, feed: FeedRow, error: string): Promise<IngestOutcome> {
	const { rows } = await db.query<{ n: number }>('SELECT consecutive_failures AS n FROM data_feed WHERE id = $1', [feed.id]);
	await recordFeedResult(db, feed.id, { ok: false, error });
	if ((rows[0]?.n ?? 0) === 0) {
		await recordAudit(db, feed.projectId, 'feed.failed', { feedId: feed.id, source: feed.source, targetKind: feed.targetKind, targetName: feed.targetName, error });
	}
	return { merged: 0, lastDate: null };
}

export async function ingestResult(db: Db, feed: FeedRow, raw: unknown): Promise<IngestOutcome> {
	const parsed = FetchResult.safeParse(raw);
	if (!parsed.success) return failed(db, feed, 'the fetcher’s answer was not valid, so nothing was written');
	const result = parsed.data;
	if (!result.ok) return failed(db, feed, result.error);

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
	await recordFeedResult(db, feed.id, { ok: true, lastDate, lastValue, meta: { ...result.meta, merged } });
	return { merged, lastDate };
}
