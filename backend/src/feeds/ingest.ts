// Apply a fetch's result to its feed, inside the job's transaction as the
// feed's acting user: merge the days into the target series through the same
// path as POST /projects/:id/series/merge (series/merge.ts mergeSeries), then
// record the feed's health. The merge replaces only days this feed wrote
// itself, and fills empty ones: an uploaded or imported value is kept, and
// counted in last_meta.kept (031_feed_days, #30). The change history
// (030_history.sql) gets a series.merged event for days that changed (no
// series revision: a feed's merges are append-mostly and would push a
// person's restore points out) and a feed.failed event when a working feed
// starts failing, not on every failed attempt after that. A failed fetch records the failure and writes no
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
//
// A CHIRPS feed writes one product and version (feeds/config.ts
// feedProvenance) and the series records it (032_series_provenance.sql). A
// target that holds values of another product or version, or an unrecorded
// one, is never merged into: the fetch is recorded as failed, saying so,
// unless an owner confirmed replacing the series (data_feed.replace_series_from
// names what it held then). While it still holds exactly that, the fetched
// days are **staged** (feed_stage), not written into the live series, which
// keeps its old values and label: a run meanwhile uses the whole old record,
// never a partial new one. When the backfill reaches the newest day the
// source can have, the stage is swapped in whole, in this transaction (the
// old values kept as a `feed_replace` series revision, the label changed,
// the confirmation used up, the stage deleted). The fit record then flags the
// forcing as changed (engine fitRecordStatus), and the run comparison notes
// the new version.
//
// Days that changed in the live series (a merge, or the swap) go through the
// new-data hook (series/newData.ts onSeriesDaysChanged), which queues the project's
// debounced automatic re-run when it has them on (WP-2.11). Staged days don't:
// a run can't see them yet.
import { provenanceKey, provenanceLabel, type SeriesProvenance } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { lockSeries, recordAudit, seriesSubject } from '../history/record.js';
import { bodyOrigin, hasValues, MAX_SERIES_VALUES, mergeDaily, mergeSeries, rowProvenance, SeriesBody } from '../series/merge.js';
import { onSeriesDaysChanged } from '../series/newData.js';
import { replaceSeries } from '../series/replace.js';
import { type FeedSource, feedProvenance, feedSourceText, SOURCES } from './config.js';
import { FetchResult, type FetchWindow, utcToday } from './fetch.js';
import { GEFS_DAYS } from './sources/chirps.js';
import { enqueueJob } from '../jobs/queue.js';
import { type FeedRow, feedFetchDedupeKey, feedReplaceDone, lockFeedIssued, recordFeedChecked, recordFeedResult, seriesAccepts } from './store.js';

/** A backfill's next window waits this long, so one fetch after another never floods the source (or a test's tick). */
export const BACKFILL_NEXT_SECONDS = 60;

/**
 * A fetch whose window stopped short of the newest day the source can have
 * (a backfill capped at one window's days: 120 for CHIRPS) queues the next
 * window at once instead of waiting a day. Without this a replaced series
 * (issue #40 part c), or a feed with an early start date, took one window a
 * day: months for a CHIRPS record back to 1981. Each answer moves the window
 * on (its end is recorded as `through`), so the chain ends when the feed is
 * caught up. As the acting user, in the ingest's transaction.
 */
/** The window reached the newest day the source can have: a CHIRPS day is yesterday at best, a DWS day today. */
const caughtUp = (feed: FeedRow, window: FetchWindow) =>
	window.end >= (feed.source === 'chirps' ? fromEpochDay(toEpochDay(utcToday()) - 1) : utcToday());

async function continueBackfill(db: Db, feed: FeedRow, window: FetchWindow): Promise<void> {
	if (feed.source === 'chirps_gefs' || caughtUp(feed, window)) return;
	await enqueueJob(db, {
		projectId: feed.projectId,
		kind: 'feed_fetch',
		payload: { feedId: feed.id },
		dedupeKey: feedFetchDedupeKey(feed.id),
		delaySeconds: BACKFILL_NEXT_SECONDS
	});
}

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

type OkResult = Extract<FetchResult, { ok: true }>;

/**
 * A confirmed replacement's fetch (see the header): merge the days into the
 * feed's stage, and swap the stage in once the backfill is caught up. The
 * live series is untouched until then.
 */
async function stageReplacement(
	db: Db,
	feed: FeedRow,
	result: OkResult,
	window: FetchWindow,
	writes: SeriesProvenance,
	held: SeriesProvenance | null
): Promise<IngestOutcome> {
	const { rows } = await db.query<{ startDate: string; values: (number | null)[] }>(
		`SELECT to_char(start_date, 'YYYY-MM-DD') AS "startDate", "values" FROM feed_stage WHERE feed_id = $1 FOR UPDATE`,
		[feed.id]
	);
	let stage: { startDate: string; values: (number | null)[] } | null = rows[0] ?? null;
	let lastDate: string | null = null;
	let lastValue: number | null = null;
	let merged = 0;
	const unit = SOURCES[feed.source].unit;
	if (result.startDate !== null && result.values.some((v) => v !== null)) {
		// Canonical unit, as a series is stored (series/merge.ts).
		const body = SeriesBody.parse({ kind: feed.targetKind, name: feed.targetName, unit, startDate: result.startDate, values: result.values });
		const next = mergeDaily(stage, { startDate: body.startDate, values: body.values }, { keepOnNull: true });
		if (next.values.length > MAX_SERIES_VALUES) return failed(db, feed, `the series could not take the new days: series would exceed ${MAX_SERIES_VALUES} days`);
		await db.query(
			`INSERT INTO feed_stage (feed_id, project_id, start_date, "values", product, product_version, replace_from)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (feed_id) DO UPDATE SET start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now()`,
			[feed.id, feed.projectId, next.startDate, next.values, writes.product, writes.version, feed.replaceFrom ?? '']
		);
		stage = next;
		let lastIdx = result.values.length - 1;
		while (result.values[lastIdx] === null) lastIdx--;
		merged = result.values.filter((v) => v !== null).length;
		lastDate = fromEpochDay(toEpochDay(result.startDate) + lastIdx);
		lastValue = result.values[lastIdx]!;
	}
	const done = caughtUp(feed, window) && stage !== null;
	let meta: Record<string, string | number>;
	if (done) {
		// Caught up: the new record goes in whole, in this transaction.
		let replaced;
		try {
			replaced = await replaceSeries(
				db,
				feed.projectId,
				{
					kind: feed.targetKind,
					name: feed.targetName,
					unit,
					startDate: stage!.startDate,
					values: stage!.values,
					provenance: writes,
					// The feed is the replaced record's source (107); its values come in the stored unit.
					origin: { source: feedSourceText(feed.source, feed.config), unit, factor: 1 }
				},
				{ revisionReason: 'feed_replace', audit: { feedId: feed.id, source: feed.source }, feedId: feed.id }
			);
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			return failed(db, feed, `the series could not take the new days: ${err.message}`);
		}
		await db.query('DELETE FROM feed_stage WHERE feed_id = $1', [feed.id]);
		await feedReplaceDone(db, feed.id);
		// The whole new record went in: the new-data hook (series/newData.ts).
		const m = replaced.meta;
		await onSeriesDaysChanged(db, feed.projectId, { seriesId: m.id, kind: m.kind, name: m.name, daysChanged: replaced.daysChanged, via: 'feed' });
		meta = { ...result.meta, merged, replaced: provenanceLabel(held).slice(0, 100), through: window.end };
	} else {
		meta = { ...result.meta, merged, staged: stage?.values.length ?? 0, through: window.end };
	}
	await recordFeedResult(db, feed.id, { ok: true, lastDate, lastValue, meta });
	await continueBackfill(db, feed, window);
	return { merged, lastDate };
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

	const writes = feedProvenance(feed.source, feed.config);
	if (writes) {
		// The version guard, on the locked row: nothing can relabel or refill it between the check and the write.
		const cur = await lockSeries(db, feed.projectId, feed.targetKind, feed.targetName);
		const held = cur ? rowProvenance({ product: cur.product ?? null, productVersion: cur.productVersion ?? null }) : null;
		if (!seriesAccepts(writes, cur ? { filled: hasValues(cur.values), provenance: held } : null)) {
			if (feed.replaceFrom !== provenanceKey(held)) {
				return failed(
					db,
					feed,
					`the series holds ${provenanceLabel(held)} rainfall and this feed writes ${provenanceLabel(writes)}, so nothing was written: an owner must confirm replacing the series, or point the feed at another one`
				);
			}
			return stageReplacement(db, feed, result, window, writes, held);
		}
	}

	let lastDate: string | null = null;
	let lastValue: number | null = null;
	let merged = 0;
	let kept = 0;
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
				// feedId: only this feed's own days (and empty ones) are replaced; any
				// other value, an upload or an import, is kept (031_feed_days, #30).
				// provenance: labels a new or empty series with what the feed writes.
				// origin (107_series_source.sql): a new or empty series records the feed as its source.
				const r = await mergeSeries(db, feed.projectId, body, {
					keepOnNull: true,
					feedId: feed.id,
					origin: bodyOrigin({ ...body, source: feedSourceText(feed.source, feed.config) }),
					...(writes ? { provenance: writes } : {})
				});
				({ written: merged, kept } = r);
				const subject = seriesSubject(r.meta, r.before, r.after, { feedId: feed.id, source: feed.source });
				if (subject.daysChanged) {
					await recordAudit(db, feed.projectId, r.before ? 'series.merged' : 'series.created', subject);
					// The new-data hook (series/newData.ts): the project's automatic re-run, if it has them on.
					await onSeriesDaysChanged(db, feed.projectId, { seriesId: r.meta.id, kind: r.meta.kind, name: r.meta.name, daysChanged: subject.daysChanged as number, via: 'feed' });
				}
			} catch (err) {
				// The merge refuses before writing (e.g. the series would pass 60 000 days).
				if (!(err instanceof ApiError)) throw err;
				return failed(db, feed, `the series could not take the new days: ${err.message}`);
			}
			lastDate = fromEpochDay(toEpochDay(result.startDate) + lastIdx);
			lastValue = result.values[lastIdx]!;
		}
	}
	// Ours last, so a key of the same name in the fetcher's meta never stands.
	// kept: days holding a value the feed didn't write (the panel's "kept your own values").
	const meta = feed.source === 'chirps_gefs' ? { ...result.meta, merged, kept } : { ...result.meta, merged, kept, through: window.end };
	await recordFeedResult(db, feed.id, { ok: true, lastDate, lastValue, meta });
	await continueBackfill(db, feed, window);
	return { merged, lastDate };
}
