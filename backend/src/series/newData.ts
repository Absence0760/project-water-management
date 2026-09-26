// THE NEW-DATA HOOK: `onSeriesDaysChanged(db, projectId, change)` (WP-2.11).
//
// Every write that changed a series' days calls it once, inside the write's
// transaction, after the change is recorded in the history:
//   - a person's merge or whole-series replace (POST /projects/:id/series/merge,
//     PUT /projects/:id/series; series/routes.ts), via 'user';
//   - a data feed's merge, or its confirmed replacement swapping in
//     (feeds/ingest.ts), via 'feed';
//   - an API key's ingest (POST /ingest/v1/series/merge, WP-2.9), via 'api_key'.
// Call it only when days changed (daysChanged > 0): an idempotent re-send
// that changes nothing must not queue or push back a run. A restore puts back
// values the project had, not new data, and doesn't call it.
//
// Contract:
//   - `db` acts as an editor of the project (withUser, or a job as its acting
//     user; that person becomes the re-run's acting user), or as a live API
//     key of it (withApiKey), whose re-run runs as the key's creator
//     (app_rerun_acting_user, 041_auto_rerun.sql). A key whose creator's
//     account was deleted queues nothing (null): the ingest still commits.
//     Anyone else gets 42501, and the caller's transaction rolls back.
//   - Returns when the project's automatic re-run is due (ISO), or null when
//     the project hasn't turned automatic runs on: the `rerunQueuedFor` the
//     merge routes answer with. The enqueue itself is runs/autoRun.ts
//     enqueueRerun → app_enqueue_rerun (debounce, maximum wait, dedupe).
//   - It never wakes the worker (that has to wait for the commit): a route
//     wakes it after committing when the re-run is due at once
//     (series/routes.ts wakeForRerun); inside a job nothing is needed (the job
//     table's insert trigger NOTIFYs the local worker, and the production tick
//     finds due jobs every 5 minutes).
import type { Db } from '../db/tx.js';
import { enqueueRerun, type NewDataCause, type QueuedRerun } from '../runs/autoRun.js';

export interface SeriesDaysChanged {
	seriesId: string;
	kind: string;
	name: string;
	/** Days whose value changed (history/diff.ts seriesChange); > 0, or the series was created. */
	daysChanged: number;
	/** Who wrote them: a person, a data feed, or an API key's ingest. */
	via: 'user' | 'feed' | 'api_key';
}

const CAUSE: Record<SeriesDaysChanged['via'], NewDataCause> = { user: 'series', feed: 'feed', api_key: 'ingest' };

/** The re-run the change queued or pushed back, or null (automatic runs off, or no day changed). */
export async function queueRerunFor(db: Db, projectId: string, change: SeriesDaysChanged): Promise<QueuedRerun | null> {
	return change.daysChanged > 0 ? enqueueRerun(db, projectId, CAUSE[change.via]) : null;
}

/** The hook (see the header). Returns `rerunQueuedFor`: when the re-run is due, or null. */
export async function onSeriesDaysChanged(db: Db, projectId: string, change: SeriesDaysChanged): Promise<string | null> {
	return (await queueRerunFor(db, projectId, change))?.runAfter ?? null;
}
