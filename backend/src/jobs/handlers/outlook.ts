// `outlook`: a seasonal outlook (issue #53 R5, 063_seasonal_outlook.sql,
// docs/model.md §2.15): one base run × a season × demand levels over the
// record's analogue years, as the editor who asked for it, under RLS. Each
// level × year is one member run of the engine, stored as it finishes; then
// the engine's summary (outlooks/store.ts computeOutlook). Everything
// commits with the job's `done`, so a retry after a crash never stores a
// member twice.
//
// The engine runs inside the job's transaction, as for `sweep`: at most
// OUTLOOK_LEVELS_MAX × OUTLOOK_YEARS_MAX member runs (outlooks/schema.ts).
import { ApiError } from '../../http/errors.js';
import { OutlookPayload } from '../../outlooks/schema.js';
import { computeOutlook } from '../../outlooks/store.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const outlookHandler = defineHandler({
	role: 'editor',
	payload: OutlookPayload,
	async run({ db, job, payload, progress }) {
		try {
			// False: the outlook went (deleted, or with its base run) or is already complete. Nothing to do.
			await computeOutlook(db, job.projectId, payload.outlookId, progress);
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the outlook failed: ${(err as Error).message}`, { retry: false });
		}
	}
});
