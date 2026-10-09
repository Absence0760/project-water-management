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
import { z } from 'zod';
import { planFetch, uniqueCells } from '../../feeds/cellCache.js';
import { cacheOrigin, readCellCache } from '../../feeds/cellCacheStore.js';
import { chirpsProduct, type GridConfig, gridCells } from '../../feeds/config.js';
import { type CellsResult, type FetchRequest, fetchWindow, runFetch, utcToday } from '../../feeds/fetch.js';
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
			const plan = planFetch(cells, await readCellCache(db, cacheOrigin(), product, cells, window), window);
			if (!plan) {
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
			request.cells = { cells: plan.cells.map((c): [number, number] => [c.row, c.col]), plan: plan.plan };
		}
		if (feedFetcher() === 'sqs') {
			await beginFeedFetch(db, feed.id, job.id, window);
			const message: FetchRequestMessage = { v: 1, type: 'fetch', fetchJobId: job.id, feedId: feed.id, feedVersion: feed.version, request };
			await sendToQueue(process.env.FETCH_REQUESTS_QUEUE_URL, 'FETCH_REQUESTS_QUEUE_URL', message);
			return;
		}
		// Inline: the fetch holds this transaction open for its duration, which
		// is fine locally (fixtures answer at once); production never does this.
		await ingestResult(db, feed, await runFetch(request, await feedHttp()), window);
	}
});
