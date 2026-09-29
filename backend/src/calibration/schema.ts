// Automated calibration run by the server (issue #153, 108_auto_calibration.sql,
// docs/api.md § Automated calibration): the job payloads and the caps.
import { z } from 'zod';

/** Runs of the rules kept per project, newest first; starting one deletes older ones (never an applied one). */
export const AUTO_CALIBRATIONS_KEPT = 20;
/** Queued or running automated calibrations one user may have across all projects: each is minutes of compute. */
export const AUTO_CALIBRATION_JOBS_PER_USER = 1;
/**
 * The longest one case (a full fit with validation) may be estimated to take,
 * in seconds: under the job worker's 300 s Lambda timeout and 360 s lease
 * (jobs/runner.ts DEFAULT_LEASE_SECONDS), with room for the run and writes.
 */
export const AUTO_CASE_SECONDS_MAX = 240;
/** The same for the server's run of an uncertainty ensemble after an automated fit is applied. */
export const ENSEMBLE_SECONDS_MAX = 240;

/** `auto_calibration` job: fit the next case of a run of the rules, or (queued by new data) start one. */
export const AutoCalibrationPayload = z
	.object({ calibrationId: z.string().uuid().optional(), start: z.literal('new_data').optional() })
	.strict()
	.refine((p) => (p.calibrationId === undefined) !== (p.start === undefined), 'exactly one of calibrationId or start');
export type AutoCalibrationPayload = z.infer<typeof AutoCalibrationPayload>;

/** `uncertainty` job: run a started ensemble on the server and store it. */
export const UncertaintyPayload = z.object({ uncertaintyId: z.string().uuid() }).strict();
