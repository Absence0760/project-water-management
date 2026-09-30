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
import { z } from 'zod';
import { fetchWindow, runFetch, utcToday } from '../../feeds/fetch.js';
import { feedHttp } from '../../feeds/http.js';
import { ingestResult } from '../../feeds/ingest.js';
import { beginFeedFetch, feedForJob } from '../../feeds/store.js';
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
		const request = { source: feed.source, config: feed.config, ...window, today };
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
