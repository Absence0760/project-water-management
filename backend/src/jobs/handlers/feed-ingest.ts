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
// or the feed's health (issue #31).
import { z } from 'zod';
import { ingestResult } from '../../feeds/ingest.js';
import { feedForJob, takeFeedFetch } from '../../feeds/store.js';
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
		const feed = await feedForJob(db, job.projectId, payload.feedId);
		// Removed, switched off, or saved with new settings since the fetch was
		// asked for: the days belong to a place or series the feed no longer means.
		if (!feed || !feed.enabled || feed.version !== payload.feedVersion) return;
		const window = await takeFeedFetch(db, feed.id, payload.fetchJobId);
		if (!window) return;
		// Off ingest-results: the fetcher Lambda's answer, read from the real files (it refuses to run on the fixtures).
		await ingestResult(db, feed, payload.result, window, { origin: 'chc', fetchJobId: payload.fetchJobId });
	}
});
