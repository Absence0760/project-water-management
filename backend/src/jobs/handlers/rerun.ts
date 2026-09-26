// `rerun`: run the model on the project's current inputs and save the run,
// as the editor who queued it: what POST /projects/:id/runs does, off the
// request path. Two ways in:
//   - `manual`: POST /projects/:id/jobs (WP-2.8), labelled as asked;
//   - `auto`: the debounced re-run after new data (WP-2.11,
//     series/newData.ts onSeriesDaysChanged → app_enqueue_rerun). Labelled
//     `Auto · data to <day>`, stored with trigger 'auto', so the storage cap
//     keeps only the newest unkept auto run (runs/execute.ts trimRuns), and
//     then published if the project opted in (publish/autoPublish.ts).
// An auto re-run whose project has turned automatic runs off since it was
// queued does nothing, and so does one while an API key's anomalous push is
// held for review (series/hold.ts heldSinceLastRun).
//
// WP-2.13 (alerts) queues `alert_eval` here after an auto run; the kind has
// no handler yet, so queueing it now would only make dead jobs.
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { autoPublish } from '../../publish/autoPublish.js';
import { autoRunLabel, NEW_DATA_CAUSES, resolveAutoRun } from '../../runs/autoRun.js';
import { executeRun, trimRuns } from '../../runs/execute.js';
import { heldSinceLastRun } from '../../series/hold.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const RerunPayload = z
	.object({
		label: z.string().trim().max(200).default(''),
		trigger: z.enum(['manual', 'auto']).default('manual'),
		/** What brought the new data (auto re-runs only). */
		cause: z.enum(NEW_DATA_CAUSES).optional()
	})
	.strict();

/** One pending re-run per project (the dedupe key is per project already), manual or auto alike. */
export const RERUN_DEDUPE_KEY = 'rerun';

export const rerunHandler = defineHandler({
	role: 'editor',
	payload: RerunPayload,
	async run({ db, job, payload }) {
		const auto = payload.trigger === 'auto';
		let publish = false;
		if (auto) {
			const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [job.projectId]);
			const settings = resolveAutoRun(rows[0]?.settings);
			if (!settings.enabled) return;
			// An API key pushed days that look wrong since the last run a person made: wait for them (series/hold.ts).
			if (await heldSinceLastRun(db, job.projectId)) return;
			publish = settings.publish === 'if_no_new_warnings';
		}
		const { id } = await executeRun(db, job.projectId, auto ? autoRunLabel : payload.label, payload.trigger).catch((err: Error) => {
			// Engine problems (bad inputs, missing series) are the user's to fix,
			// and another attempt won't fix them (the manual route answers 400).
			if (err instanceof ApiError || (err as { code?: string }).code) throw err;
			throw new JobError(`model run failed: ${err.message}`, { retry: false });
		});
		await trimRuns(db, job.projectId);
		if (publish) await autoPublish(db, job.projectId, id);
	}
});
