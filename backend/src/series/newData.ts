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
//     (app_rerun_acting_user, 042_auto_rerun.sql). A key whose creator's
//     account was deleted queues nothing (null): the ingest still commits.
//     Anyone else gets 42501, and the caller's transaction rolls back.
//   - Returns when the project's automatic re-run is due (ISO), or null when
//     the project hasn't turned automatic runs on: the `rerunQueuedFor` the
//     merge routes answer with. The enqueue itself is runs/autoRun.ts
//     enqueueRerun → app_enqueue_rerun (debounce, maximum wait, dedupe).
//   - A forecast feed's new days also queue the scheduled forecast run
//     (queueForecastFor, WP-2.12), under the same setting.
//   - New days of any other series also queue a run of the calibration rules
//     (queueAutoCalibrationFor, issue #153), when
//     settings.calibrationRules.after.onNewData asks for it (off by default):
//     app_enqueue_auto_calibration, 108_auto_calibration.sql, one pending per
//     project, debounced like the re-run, as the same acting user.
//   - It never wakes the worker (that has to wait for the commit): a route
//     wakes it after committing when the re-run is due at once
//     (series/routes.ts wakeForRerun); inside a job nothing is needed (the job
//     table's insert trigger NOTIFYs the local worker, and the production tick
//     finds due jobs every 5 minutes).
import type { Db } from '../db/tx.js';
import { enqueueForecastRun, enqueueRerun, type NewDataCause, type QueuedRerun } from '../runs/autoRun.js';

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

/**
 * A forecast feed's new days (a CHIRPS-GEFS issue merged into the forecast
 * series) also queue a scheduled forecast run (WP-2.12, runs/autoRun.ts
 * enqueueForecastRun), under the same opt-in: null when off, or for any
 * other change. Only a feed's: a person who uploads a forecast runs it from
 * the Runs tab (Run forecast), and an API key pushes observed data.
 */
export async function queueForecastFor(db: Db, projectId: string, change: SeriesDaysChanged): Promise<QueuedRerun | null> {
	return change.daysChanged > 0 && change.via === 'feed' && change.kind === 'rain_forecast_mm' ? enqueueForecastRun(db, projectId) : null;
}

/**
 * New observed or rain data queues a run of the calibration rules (issue
 * #153), when the rules ask for it; null when they don't, or for the
 * forecast (it is never fitted to). Returns the queued job's id.
 */
export async function queueAutoCalibrationFor(db: Db, projectId: string, change: SeriesDaysChanged): Promise<string | null> {
	if (change.daysChanged <= 0 || change.kind === 'rain_forecast_mm') return null;
	const { rows } = await db.query<{ id: string | null }>('SELECT app_enqueue_auto_calibration($1) AS id', [projectId]);
	return rows[0]?.id ?? null;
}

/** The hook (see the header). Returns `rerunQueuedFor`: when the re-run is due, or null. */
export async function onSeriesDaysChanged(db: Db, projectId: string, change: SeriesDaysChanged): Promise<string | null> {
	const rerun = await queueRerunFor(db, projectId, change);
	await queueForecastFor(db, projectId, change);
	await queueAutoCalibrationFor(db, projectId, change);
	return rerun?.runAfter ?? null;
}
