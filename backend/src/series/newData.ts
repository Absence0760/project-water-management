// The "new data arrived" hook: every merge that changed a series' days calls
// it, inside the merge's transaction, after the change is recorded in the
// history. Today the callers are the shared merge (series/merge.ts mergeInto:
// POST /projects/:id/series/merge and POST /ingest/v1/series/merge).
//
// It is a deliberate no-op until WP-2.11 (auto re-run after new data) joins
// here: that work package enqueues the debounced `rerun` job from this
// function, when the project's settings.autoRun is on, and returns when the
// re-run is queued for. Both merge routes already pass the answer back as
// `rerunQueuedFor`, so WP-2.11 changes only this body (and adds the data
// feeds' ingest, feeds/ingest.ts, as a caller).
//
// Note for WP-2.11: an ingest request runs under an API key (withApiKey), with
// no user, so an enqueue from here can't take app_current_user_id() as the
// job's acting user, and the job table has no key policy yet (038_api_keys.sql).
import type { Db } from '../db/tx.js';

export interface SeriesDaysChanged {
	seriesId: string;
	kind: string;
	name: string;
	/** Days whose value changed (history/diff.ts seriesChange); > 0, or the series was created. */
	daysChanged: number;
	/** Who wrote them: a person's merge, or an API key's ingest. */
	via: 'user' | 'api_key';
}

/**
 * Called once per merge that changed days. Returns the time a re-run is queued
 * for (ISO), or null when none is. No-op until WP-2.11: always null.
 */
export async function onSeriesDaysChanged(_db: Db, _projectId: string, _change: SeriesDaysChanged): Promise<string | null> {
	return null;
}
