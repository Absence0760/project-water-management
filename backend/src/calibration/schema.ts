// Automated calibration run by the server (issue #153, 108_auto_calibration.sql,
// docs/api.md § Automated calibration): the job payloads and the caps.
import { z } from 'zod';

/** Runs of the rules kept per project, newest first; starting one deletes older ones (never an applied one). */
export const AUTO_CALIBRATIONS_KEPT = 20;
/** Queued or running automated calibrations one user may have across all projects: each is minutes of compute. */
export const AUTO_CALIBRATION_JOBS_PER_USER = 1;
/**
 * The longest one job of a run of the rules may run, in seconds: under the
 * job worker's 300 s Lambda timeout and 360 s lease (jobs/runner.ts
 * DEFAULT_LEASE_SECONDS), with room for its writes. A case's fit runs over as
 * many jobs as it needs (store.ts fitNextCase), each pausing its search by
 * the clock before this; what can't be cut (a case's last step, one model
 * run) must be estimated inside it, or the rules are refused.
 */
export const AUTO_JOB_SECONDS_MAX = 240;
/**
 * The longest a whole run of the rules may be estimated to take on the job
 * worker, in seconds (6 hours, every case and job): it holds the person's one
 * run (AUTO_CALIBRATION_JOBS_PER_USER) and a worker for that long, one job
 * after another. The default rules on a fifteen-year catchment of ten nodes
 * are estimated at about 3 hours (the estimate errs long).
 */
export const AUTO_RUN_SECONDS_MAX = 6 * 3600;
/** The same for the server's run of an uncertainty ensemble after an automated fit is applied. */
export const ENSEMBLE_SECONDS_MAX = 240;

/** `auto_calibration` job: fit the next piece of a run of the rules, or (queued by new data) start one. */
export const AutoCalibrationPayload = z
	.object({ calibrationId: z.string().uuid().optional(), start: z.literal('new_data').optional() })
	.strict()
	.refine((p) => (p.calibrationId === undefined) !== (p.start === undefined), 'exactly one of calibrationId or start');
export type AutoCalibrationPayload = z.infer<typeof AutoCalibrationPayload>;

/** `uncertainty` job: run a started ensemble on the server and store it. */
export const UncertaintyPayload = z.object({ uncertaintyId: z.string().uuid() }).strict();
