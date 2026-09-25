// `rerun`: run the model on the project's current inputs and save the run,
// as the editor who queued it: what POST /projects/:id/runs does, off the
// request path. The first consumer of the queue (WP-2.8); WP-2.11 queues it
// automatically after new data arrives.
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { executeRun, trimRuns } from '../../runs/execute.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const RerunPayload = z.object({ label: z.string().trim().max(200).default('') }).strict();

/** One pending re-run per project (the dedupe key is per project already). */
export const RERUN_DEDUPE_KEY = 'rerun';

export const rerunHandler = defineHandler({
	role: 'editor',
	payload: RerunPayload,
	async run({ db, job, payload }) {
		await executeRun(db, job.projectId, payload.label).catch((err: Error) => {
			// Engine problems (bad inputs, missing series) are the user's to fix,
			// and another attempt won't fix them (the manual route answers 400).
			if (err instanceof ApiError || (err as { code?: string }).code) throw err;
			throw new JobError(`model run failed: ${err.message}`, { retry: false });
		});
		await trimRuns(db, job.projectId);
	}
});
