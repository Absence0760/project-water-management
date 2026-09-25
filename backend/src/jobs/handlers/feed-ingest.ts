// `feed_ingest`: apply a fetch result that came back from the production
// fetcher Lambda (the `ingest-results` queue; feeds/queue.ts turns each
// message into one of these jobs, as the feed's acting user). The result is
// untrusted input: feeds/ingest.ts validates it before anything merges, and
// records an invalid one as a failed fetch.
import { z } from 'zod';
import { ingestResult } from '../../feeds/ingest.js';
import { feedForJob } from '../../feeds/store.js';
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
		await ingestResult(db, feed, payload.result);
	}
});
