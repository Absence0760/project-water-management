// `auto_calibration`: fit the next case of a run of the calibration rules
// (issue #153, 108_auto_calibration.sql, calibration/store.ts fitNextCase),
// as the editor it runs as, under RLS; or, queued by new data
// (app_enqueue_auto_calibration, settings.calibrationRules.after.onNewData),
// plan a new run and queue its first case. One case per job, so no job runs
// longer than one fit (calibration/schema.ts AUTO_CASE_SECONDS_MAX).
//
// When the last case of a run that new data queued completes, and the rules
// say `apply` and are signed off, the kept fit is applied in the same
// transaction, a run is made with it, and (after.ensemble) the uncertainty
// ensemble around it is queued for the server to compute.
import { resolveCalibrationRules } from '@water-management/engine';
import { AutoCalibrationPayload } from '../../calibration/schema.js';
import {
	appliedRunLabel,
	applyCalibration,
	CalibrationRefused,
	calibrationInput,
	fitNextCase,
	getCalibration,
	inputSha256,
	insertCalibration,
	planCalibration,
	recordAppliedRun,
	startCalibrationEnsemble
} from '../../calibration/store.js';
import { ApiError } from '../../http/errors.js';
import { executeRun, trimRuns } from '../../runs/execute.js';
import { runModelInput } from '../../runs/uncertainty.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const autoCalibrationHandler = defineHandler({
	role: 'editor',
	payload: AutoCalibrationPayload,
	async run({ db, job, payload, progress }) {
		try {
			if (payload.start) {
				const input = await calibrationInput(db, job.projectId);
				const rules = resolveCalibrationRules(input.settings.calibrationRules, []);
				// Turned off since the new data queued it: nothing to do.
				if (rules.after.onNewData === 'off') return;
				const plan = planCalibration(input);
				await insertCalibration(db, job.projectId, { trigger: 'new_data', rules, plan, inputSha256: inputSha256(input) });
				return;
			}
			const done = await fitNextCase(db, job.projectId, payload.calibrationId!, progress);
			if (done !== 'complete') return;
			const row = await getCalibration(db, job.projectId, payload.calibrationId!);
			if (!row || row.trigger !== 'new_data' || row.chosen === null || row.rules.after.onNewData !== 'apply' || !row.rules.signedOff) return;
			try {
				await applyCalibration(db, job.projectId, row.id);
			} catch (err) {
				// Refused (the rules or data moved on while it ran): the report stays for an editor.
				if (err instanceof ApiError) return;
				throw err;
			}
			const run = await executeRun(db, job.projectId, appliedRunLabel(row.rulesRevision), 'auto');
			await trimRuns(db, job.projectId);
			if (row.rules.after.ensemble) await startCalibrationEnsemble(db, job.projectId, row.id, run.id, await runModelInput(db, job.projectId, run.id));
			else await recordAppliedRun(db, row.id, run.id);
		} catch (err) {
			if (err instanceof CalibrationRefused) throw new JobError(`the calibration rules can't run: ${err.message}`, { retry: false });
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the automated calibration failed: ${(err as Error).message}`, { retry: false });
		}
	}
});
