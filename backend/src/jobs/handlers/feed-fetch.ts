// `feed_fetch`: fetch one data feed's new days, as the owner who set it up
// (who must still be an editor). Queued by the tick's feed scheduler
// (feeds/schedule.ts) and by "Run now" (POST /projects/:id/feeds/:feedId/run-now).
//
//   FEED_FETCHER=inline (default): fetch here, from FEED_SOURCE (fixtures
//     unless set to live), and ingest in this same transaction.
//   FEED_FETCHER=sqs (production): the worker has no internet, so hand the
//     request to the fetcher Lambda through the `fetch-requests` queue. Its
//     answer comes back on `ingest-results` and becomes a `feed_ingest` job.
//     First the job records itself and its window on the feed
//     (app_begin_feed_fetch, 029), in this transaction, so the answer is
//     checked against what was asked for and a late answer to an older fetch
//     is dropped (feed-ingest.ts, issue #31).
//
// A CHIRPS fetch goes through the shared cell cache (208_chirps_cell_cache,
// feeds/cellCache.ts): the request names only the cells and days the cache
// lacks or holds as preliminary. When it lacks none, nothing is fetched at
// all: the feed's days are computed from the cache here, at once.
//
// A CHIRPS fetch also carries its share of the re-check of cached finals CHC
// rewrites in place (210_chirps_final_recheck, cellCache.ts RECHECK_*): the
// days its cells hold stale or untagged to read again, and, once the feed is
// caught up, a few final files to HEAD, claimed for this job. With such work
// the request goes out even when the window needs nothing (its plan all
// skips).
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';
import { planFetch, RECHECK_HEAD_DAYS, RECHECK_INTERVAL_DAYS, RECHECK_READ_DAYS, uniqueCells } from '../../feeds/cellCache.js';
import { cacheOrigin, claimRecheck, readCellCache } from '../../feeds/cellCacheStore.js';
import { chirpsProduct, type GridConfig, gridCells } from '../../feeds/config.js';
import { type CellsResult, type FetchRequest, fetchWindow, runFetch, utcToday } from '../../feeds/fetch.js';
import { DAY_SKIP } from '../../feeds/sources/chirps.js';
import { feedHttp } from '../../feeds/http.js';
import { ingestResult } from '../../feeds/ingest.js';
import { beginFeedFetch, feedForJob, takeFeedFetch } from '../../feeds/store.js';
import { defineHandler } from '../registry.js';
import { feedFetcher, type FetchRequestMessage, sendToQueue } from '../transport.js';

export const FeedFetchPayload = z.object({ feedId: z.string().uuid() }).strict();

// One pending fetch per feed: the key lives in feeds/store.ts, so the ingest (which queues a backfill's next window) shares it.
export { feedFetchDedupeKey } from '../../feeds/store.js';

export const feedFetchHandler = defineHandler({
	role: 'editor',
	payload: FeedFetchPayload,
	async run({ db, job, payload }) {
		const feed = await feedForJob(db, job.projectId, payload.feedId);
		// Removed or switched off since it was queued: nothing to do.
		if (!feed || !feed.enabled) return;
		const today = utcToday();
		const window = fetchWindow(feed.source, feed.config, feed.lastDataDate, today, feed.readThrough, feed.finalThrough);
		const request: FetchRequest = { source: feed.source, config: feed.config, ...window, today };
		if (feed.source === 'chirps') {
			const product = chirpsProduct(feed.config);
			const cells = uniqueCells(gridCells(feed.config as GridConfig));
			const origin = cacheOrigin();
			const plan = planFetch(cells, await readCellCache(db, origin, product, cells, window), window);
			// HEADs only once the feed is caught up (a CHIRPS day is yesterday at best), so a backfill's windows don't carry them.
			const caughtUp = window.end >= fromEpochDay(toEpochDay(today) - 1);
			const recheck = await claimRecheck(db, feed.id, origin, product, cells, {
				heads: caughtUp ? RECHECK_HEAD_DAYS : 0,
				reads: RECHECK_READ_DAYS,
				intervalDays: RECHECK_INTERVAL_DAYS
			});
			if (!plan && !recheck) {
				// The cache holds every day the window can use, final: no fetch. In
				// production this still counts as the feed's newest fetch, so a late
				// answer to an older one is dropped (feed-ingest.ts).
				if (feedFetcher() === 'sqs') {
					await beginFeedFetch(db, feed.id, job.id, window);
					await takeFeedFetch(db, feed.id, job.id);
				}
				const fromCache: CellsResult = { ok: true, cells: { product, startDate: window.start, read: '', cells: [], values: [] }, meta: { product } };
				await ingestResult(db, feed, fromCache, window, { cacheOnly: true });
				return;
			}
			const grid = (cs: typeof cells) => cs.map((c): [number, number] => [c.row, c.col]);
			// Only re-check work: every cell, every day skipped, so the window reads nothing.
			const days = toEpochDay(window.end) - toEpochDay(window.start) + 1;
			request.cells = plan ? { cells: grid(plan.cells), plan: plan.plan } : { cells: grid(cells), plan: DAY_SKIP.repeat(days) };
			if (recheck) request.recheck = { cells: grid(cells), head: recheck.head, read: recheck.read };
		}
		if (feedFetcher() === 'sqs') {
			await beginFeedFetch(db, feed.id, job.id, window);
			const message: FetchRequestMessage = { v: 1, type: 'fetch', fetchJobId: job.id, feedId: feed.id, feedVersion: feed.version, request };
			await sendToQueue(process.env.FETCH_REQUESTS_QUEUE_URL, 'FETCH_REQUESTS_QUEUE_URL', message);
			return;
		}
		// Inline: the fetch holds this transaction open for its duration, which
		// is fine locally (fixtures answer at once); production never does this.
		await ingestResult(db, feed, await runFetch(request, await feedHttp()), window, { fetchJobId: job.id });
	}
});
