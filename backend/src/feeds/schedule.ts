// The feed side of the job queue, both run with no user context and both
// crossing projects only through SECURITY DEFINER functions (018_feeds.sql):
//
//   scheduleDueFeeds   every tick (jobs/runner.ts): claim the feeds that are
//                      due and queue a `feed_fetch` job for each, as the
//                      feed's acting user, under RLS.
//   acceptIngestResult the production worker, for each `ingest-results`
//                      message (lambda-worker.ts): find the fetch job it
//                      answers and queue a `feed_ingest` job as that job's
//                      acting user.
import { withoutUser, withUser } from '../db/tx.js';
import { feedFetchDedupeKey } from '../jobs/handlers/feed-fetch.js';
import { enqueueJob } from '../jobs/queue.js';
import type { IngestResultMessage } from '../jobs/transport.js';
import { claimDueFeeds, markScheduleFailed } from './store.js';

/** Most feeds scheduled per tick; the rest wait for the next one. */
export const FEEDS_PER_TICK = 50;

export interface ScheduleResult {
	queued: number;
	/** Feeds whose acting user can no longer queue work (recorded on the feed). */
	refused: number;
}

/** Queue a fetch for each due feed (`all`: every enabled feed, for `pnpm dev:feeds:run`). */
export async function scheduleDueFeeds({ limit = FEEDS_PER_TICK, all = false }: { limit?: number; all?: boolean } = {}): Promise<ScheduleResult> {
	const due = await withoutUser((db) => claimDueFeeds(db, limit, all));
	const out: ScheduleResult = { queued: 0, refused: 0 };
	for (const f of due) {
		try {
			await withUser(f.actingUserId, (db) =>
				enqueueJob(db, { projectId: f.projectId, kind: 'feed_fetch', payload: { feedId: f.id }, dedupeKey: feedFetchDedupeKey(f.id) })
			);
			out.queued++;
		} catch (err) {
			// RLS refused the enqueue: the acting user is no longer an editor.
			if ((err as { code?: string }).code !== '42501') throw err;
			await withoutUser((db) => markScheduleFailed(db, f.id));
			out.refused++;
		}
	}
	return out;
}

/** What became of an ingest-results message. */
export type IngestAcceptance = 'queued' | 'unknown_fetch' | 'refused';

export async function acceptIngestResult(msg: IngestResultMessage): Promise<IngestAcceptance> {
	const { rows } = await withoutUser((db) =>
		db.query<{ projectId: string; actingUserId: string }>(
			'SELECT project_id AS "projectId", acting_user_id AS "actingUserId" FROM app_feed_fetch_job($1, $2)',
			[msg.fetchJobId, msg.feedId]
		)
	);
	const target = rows[0];
	// The fetch job was purged, or the message names a job that isn't this feed's fetch.
	if (!target) return 'unknown_fetch';
	try {
		await withUser(target.actingUserId, (db) =>
			enqueueJob(db, {
				projectId: target.projectId,
				kind: 'feed_ingest',
				payload: { feedId: msg.feedId, fetchJobId: msg.fetchJobId, feedVersion: msg.feedVersion, result: msg.result },
				// A redelivered message while the first is still pending is the same work.
				dedupeKey: `feed_ingest:${msg.fetchJobId}`
			})
		);
		return 'queued';
	} catch (err) {
		if ((err as { code?: string }).code !== '42501') throw err;
		return 'refused';
	}
}
