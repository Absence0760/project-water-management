// `feed_ingest`: apply a fetch result that came back from the production
// fetcher Lambda (the `ingest-results` queue; feeds/queue.ts turns each
// message into one of these jobs, as the feed's acting user). The result is
// untrusted input: feeds/ingest.ts validates it before anything merges, and
// records an invalid one as a failed fetch.
//
// The queue can redeliver and reorder, so only the answer to the feed's
// newest fetch is applied, once: takeFeedFetch claims the window that fetch
// recorded (feed-fetch.ts) and clears it. An answer to an older fetch, or one
// already applied, finds nothing and is dropped without touching the series
// or the feed's health (issue #31), logged as feed_answer_dropped.
//
// An answer that the fetch was deferred (feeds/hostSlot.ts HOST_BUSY_ANSWER:
// CHC's shared request slot was held by the mirror-ingest Lambda) isn't a
// failure: the feed's health is left alone and its fetch is queued again in
// HOST_BUSY_RETRY_SECONDS, as the feed's own next fetch (the window it
// claimed is released by takeFeedFetch first).
import { z } from 'zod';
import { HOST_BUSY_RETRY_SECONDS, HostBusyAnswer } from '../../feeds/hostSlot.js';
import { ingestResult } from '../../feeds/ingest.js';
import { feedFetchDedupeKey, feedForJob, takeFeedFetch } from '../../feeds/store.js';
import { enqueueJob } from '../queue.js';
import { logEvent } from '../../logging/logEvent.js';
import { defineHandler } from '../registry.js';

export const FeedIngestPayload = z
	.object({
		feedId: z.string().uuid(),
		fetchJobId: z.string().uuid(),
		feedVersion: z.string().max(40),
		result: z.unknown()
	})
	.strict();

export const feedIngestHandler = defineHandler({
	role: 'editor',
	payload: FeedIngestPayload,
	async run({ db, job, payload }) {
		// A dropped answer changes nothing the app shows, so it is logged (ids, the
		// reason and whether it was a success only): the one trace of a fetch whose
		// failure the feed never showed.
		const dropped = (reason: 'feed_gone' | 'feed_off' | 'feed_changed' | 'not_awaited') =>
			logEvent('warn', {
				event: 'feed_answer_dropped',
				feedId: payload.feedId,
				fetchJobId: payload.fetchJobId,
				reason,
				ok: typeof payload.result === 'object' && payload.result !== null && (payload.result as { ok?: unknown }).ok === true
			});
		const feed = await feedForJob(db, job.projectId, payload.feedId);
		// Removed, switched off, or saved with new settings since the fetch was
		// asked for: the days belong to a place or series the feed no longer means.
		if (!feed) return dropped('feed_gone');
		if (!feed.enabled) return dropped('feed_off');
		if (feed.version !== payload.feedVersion) return dropped('feed_changed');
		const window = await takeFeedFetch(db, feed.id, payload.fetchJobId);
		// The feed isn't waiting on this fetch: a newer one was sent since (its answer is the one applied), or this answer was applied already.
		if (!window) return dropped('not_awaited');
		if (HostBusyAnswer.safeParse(payload.result).success) {
			await enqueueJob(db, { projectId: feed.projectId, kind: 'feed_fetch', payload: { feedId: feed.id }, dedupeKey: feedFetchDedupeKey(feed.id), delaySeconds: HOST_BUSY_RETRY_SECONDS });
			logEvent('info', { event: 'feed_fetch_requeued', feedId: feed.id, fetchJobId: payload.fetchJobId, reason: 'host_busy', delaySeconds: HOST_BUSY_RETRY_SECONDS });
			return;
		}
		// Off ingest-results: the fetcher Lambda's answer, read from the real files (it refuses to run on the fixtures).
		await ingestResult(db, feed, payload.result, window, { origin: 'chc', fetchJobId: payload.fetchJobId });
	}
});
