// The feed side of the job queue, both run with no user context and both
// crossing projects only through SECURITY DEFINER functions (018_feeds.sql,
// 027_feed_schedule.sql):
//
//   scheduleDueFeeds   every tick (jobs/runner.ts): list the feeds that are
//                      due, then for each one claim it and queue its
//                      `feed_fetch` job in one transaction as the feed's
//                      acting user, under RLS (027_feed_schedule.sql).
//   acceptIngestResult the production worker, for each `ingest-results`
//                      message (lambda-worker.ts): find the fetch job it
//                      answers and queue a `feed_ingest` job as that job's
//                      acting user.
import { withoutUser, withUser } from '../db/tx.js';
import { feedFetchDedupeKey } from '../jobs/handlers/feed-fetch.js';
import { enqueueJob } from '../jobs/queue.js';
import type { IngestResultMessage } from '../jobs/transport.js';
import { claimFeed, listDueFeeds, markScheduleFailed } from './store.js';

/** Most feeds scheduled per tick; the rest wait for the next one. */
export const FEEDS_PER_TICK = 50;

export interface ScheduleResult {
	queued: number;
	/** Feeds whose acting user can no longer queue work (recorded on the feed). */
	refused: number;
}

/**
 * Queue a fetch for each due feed (`all`: every enabled feed, for `pnpm dev:feeds:run`).
 *
 * Each feed's claim (stamping its schedule) and its enqueue share one
 * transaction, so a failure between them can't leave a feed claimed with no
 * job until its next interval (#32): the rollback releases the claim and the
 * next tick tries again. One feed's failure doesn't hold up the others; the
 * first error is rethrown once every feed has had its turn.
 */
export async function scheduleDueFeeds({ limit = FEEDS_PER_TICK, all = false }: { limit?: number; all?: boolean } = {}): Promise<ScheduleResult> {
	const due = await withoutUser((db) => listDueFeeds(db, limit, all));
	const out: ScheduleResult = { queued: 0, refused: 0 };
	let failure: unknown = null;
	for (const f of due) {
		try {
			const outcome = await withUser(f.actingUserId, async (db) => {
				// Another tick took it, or it changed since the listing.
				if (!(await claimFeed(db, f.id, all))) return 'skipped' as const;
				await db.query('SAVEPOINT feed_enqueue');
				try {
					await enqueueJob(db, { projectId: f.projectId, kind: 'feed_fetch', payload: { feedId: f.id }, dedupeKey: feedFetchDedupeKey(f.id) });
					return 'queued' as const;
				} catch (err) {
					// RLS refused the enqueue: the acting user is no longer an
					// editor. Keep the claim (the failure backs the feed off) and
					// record why, in the same transaction.
					if ((err as { code?: string }).code !== '42501') throw err;
					await db.query('ROLLBACK TO SAVEPOINT feed_enqueue');
					await markScheduleFailed(db, f.id);
					return 'refused' as const;
				}
			});
			if (outcome !== 'skipped') out[outcome]++;
		} catch (err) {
			failure ??= err;
		}
	}
	if (failure !== null) throw failure;
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
