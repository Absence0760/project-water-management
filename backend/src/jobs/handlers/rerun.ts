// `rerun`: run the model on the project's current inputs and save the run,
// as the editor who queued it: what POST /projects/:id/runs does, off the
// request path. Two ways in:
//   - `manual`: POST /projects/:id/jobs (WP-2.8), labelled as asked;
//   - `auto`: the debounced re-run after new data (WP-2.11,
//     series/newData.ts onSeriesDaysChanged → app_enqueue_rerun). Labelled
//     `Auto · data to <day>`, stored with trigger 'auto', so the storage cap
//     keeps only the newest unkept auto run (runs/execute.ts trimRuns), and
//     then published if the project opted in (publish/autoPublish.ts).
//   - `forecast`: the scheduled forecast run after a forecast feed (CHIRPS-GEFS)
//     wrote new days (WP-2.12, series/newData.ts queueForecastFor → runs/autoRun.ts
//     enqueueForecastRun, dedupe key 'forecast'). Labelled `Forecast · from
//     <day>`, stored with trigger 'forecast' (trimRuns keeps the newest unkept
//     one). Never published automatically: a forecast is guidance, and
//     publishing one stays a person's act. With no forecast day after the last
//     observed day (an issue the observed data has overtaken) there is nothing
//     to run, and it does nothing rather than fail.
// An auto re-run or forecast run whose project has turned automatic runs off
// since it was queued does nothing, and so does one while an API key's
// anomalous push is held for review (series/hold.ts heldSinceLastRun).
//
// An auto run whose recorded rain changed after the newest forecast run was
// made also queues the forecast run again (runs/autoRun.ts
// forecastRunBehindRain), whatever brought the rain (a key, a feed, an
// upload): otherwise the forecast, and the EWR alert read from it, would keep
// running on days since recorded as if they were dry.
//
// After an auto run or a forecast run it queues `alert_eval` (WP-2.13,
// alerts/queue.ts; nothing when the project has no alert on), which runs
// next in the same tick and sees the new run (and publication).
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { queueAlertEval } from '../../alerts/queue.js';
import { autoPublish } from '../../publish/autoPublish.js';
import { autoRunLabel, enqueueForecastRun, forecastRunBehindRain, forecastRunLabel, NEW_DATA_CAUSES, resolveAutoRun } from '../../runs/autoRun.js';
import { executeRun, NoForecastRainError, trimRuns } from '../../runs/execute.js';
import { heldSinceLastRun } from '../../series/hold.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const RerunPayload = z
	.object({
		label: z.string().trim().max(200).default(''),
		trigger: z.enum(['manual', 'auto', 'forecast']).default('manual'),
		/** What brought the new data (auto re-runs and forecast runs only). */
		cause: z.enum(NEW_DATA_CAUSES).optional()
	})
	.strict();

/** One pending re-run per project (the dedupe key is per project already), manual or auto alike. */
export const RERUN_DEDUPE_KEY = 'rerun';

export const rerunHandler = defineHandler({
	role: 'editor',
	payload: RerunPayload,
	async run({ db, job, payload }) {
		const { trigger } = payload;
		let publish = false;
		if (trigger !== 'manual') {
			const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [job.projectId]);
			const settings = resolveAutoRun(rows[0]?.settings);
			if (!settings.enabled) return;
			// An API key pushed days that look wrong since the last run a person made: wait for them (series/hold.ts).
			if (await heldSinceLastRun(db, job.projectId)) return;
			publish = trigger === 'auto' && settings.publish === 'if_no_new_warnings';
		}
		const label = trigger === 'auto' ? autoRunLabel : trigger === 'forecast' ? forecastRunLabel : payload.label;
		// The engine runs inside the job's transaction, unlike POST …/runs
		// (runLiveModel): the run must commit with the job's `done`, so a
		// retry after a crash never stores it twice, and the worker's pool
		// serves one job at a time and no request (docs/architecture.md § A model run).
		const run = await executeRun(db, job.projectId, label, trigger).catch((err: Error) => {
			// A scheduled forecast with no forecast day left to run: nothing to do.
			if (trigger === 'forecast' && err instanceof NoForecastRainError) return null;
			// Engine problems (bad inputs, missing series) are the user's to fix,
			// and another attempt won't fix them (the manual route answers 400).
			if (err instanceof ApiError || (err as { code?: string }).code) throw err;
			throw new JobError(`model run failed: ${err.message}`, { retry: false });
		});
		if (!run) return;
		await trimRuns(db, job.projectId);
		if (publish) await autoPublish(db, job.projectId, run.id);
		// New recorded rain re-makes the forecast run too: it continues from the
		// history this run just caught up on (runs/autoRun.ts forecastRunBehindRain).
		if (trigger === 'auto' && (await forecastRunBehindRain(db, job.projectId))) await enqueueForecastRun(db, job.projectId);
		if (trigger !== 'manual') await queueAlertEval(db, job.projectId, trigger);
	}
});
