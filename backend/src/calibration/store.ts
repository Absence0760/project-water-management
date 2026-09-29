// Automated calibration run by the server (issue #153, 108_auto_calibration.sql,
// docs/model.md §2.10j, docs/api.md § Automated calibration).
//
// A run of the project's calibration rules is planned from the live model
// input (the water years the rules leave out, the cases in order), stored
// with the rules and the input's hash, and fitted one case per
// `auto_calibration` job (jobs/handlers/auto-calibration.ts), each queueing
// the next as the same user, so no job runs longer than one fit. The last
// case picks the fit to keep. Every score is the server's own, so a stored
// report is no client's claim, and the only way to put an automated fit in
// the settings is applyCalibration, which builds the fit record here.
import { createHash, randomUUID } from 'node:crypto';
import {
	autoFitRecordOf,
	ENGINE_VERSION,
	finishAutoCalibration,
	fitRecordFromReport,
	planAutoCalibration,
	resolveCalibrationRules,
	resolveEnsembleOptions,
	runAutoCase,
	runModel,
	sameRules,
	sameSignOff,
	withoutForecastTail,
	type AutoCalibrationPlan,
	type AutoCalibrationReport,
	type AutoCase,
	type CalibrationFlowKind,
	type CalibrationRules,
	type ModelInput,
	type ProjectSettings
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { beginSettingsChange, recordModelRevision } from '../history/record.js';
import { enqueueJob, type JobMeta, type JobStatus } from '../jobs/queue.js';
import { LeaseLostError } from '../jobs/errors.js';
import { mergeSettings, patchSettings } from '../projects/settings.js';
import { loadModelInput, seriesHash } from '../runs/execute.js';
import { AUTO_CALIBRATIONS_KEPT, AUTO_CASE_SECONDS_MAX } from './schema.js';

export type AutoCalibrationStatus = 'running' | 'complete' | 'failed';
export type AutoCalibrationTrigger = 'manual' | 'new_data';

/** A case as a list shows it: no fit report. */
export interface CaseBrief {
	label: string;
	pan: AutoCase['pan'];
	bounds: AutoCase['bounds'];
	objective: AutoCase['objective'];
	score: number | null;
	naturalMarMm3: number | null;
	eligible: boolean;
	reasons: string[];
	filters: AutoCase['filters'];
	error: string | null;
	/** The case's fitted parameters (the free ones), null when it failed. */
	params: Record<string, number> | null;
}

export interface AutoCalibrationRow {
	id: string;
	trigger: AutoCalibrationTrigger;
	status: AutoCalibrationStatus;
	rulesRevision: number;
	rules: CalibrationRules;
	plan: Pick<AutoCalibrationPlan, 'flowKind' | 'validationRecord' | 'years' | 'ruleExclusions' | 'notes'> & { cases: AutoCalibrationPlan['cases'] };
	cases: CaseBrief[];
	/** The finished report's notes and verdicts (whether each case may be kept, and why not); null while running or when it failed. */
	report: StoredReport | null;
	chosen: number | null;
	error: string | null;
	engineVersion: string;
	/** The job fitting the next case (null once the purge removed it). */
	job: { id: string; status: JobStatus; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	appliedBy: string | null;
	appliedAt: string | null;
	appliedRunId: string | null;
	uncertaintyId: string | null;
}

/** A case's brief (the list's), from a fitted case. */
const brief = (c: AutoCase): CaseBrief => ({
	label: c.label,
	pan: c.pan,
	bounds: c.bounds,
	objective: c.objective,
	score: c.score,
	naturalMarMm3: c.naturalMarMm3,
	eligible: c.eligible,
	reasons: c.reasons,
	filters: c.filters,
	error: c.error,
	params: c.report ? Object.fromEntries(c.report.free.map((k) => [k, c.report!.params[k]!])) : null
});

const SELECT = `SELECT a.id, a."trigger", a.status, a.rules_revision AS "rulesRevision", a.rules, a.plan, a.cases, a.report, a.chosen, a.error,
	a.engine_version AS "engineVersion",
	CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object('id', j.id, 'status', j.status, 'error', j.last_error, 'progress', j.progress) END AS job,
	cu.display_name AS "createdBy", a.created_at AS "createdAt", a.completed_at AS "completedAt",
	au.display_name AS "appliedBy", a.applied_at AS "appliedAt", a.applied_run_id AS "appliedRunId", a.uncertainty_id AS "uncertaintyId"
	FROM auto_calibration a LEFT JOIN job j ON j.id = a.job_id
	LEFT JOIN app_user cu ON cu.id = a.created_by LEFT JOIN app_user au ON au.id = a.applied_by`;

/** The finished report as stored: the cases are stored as fitted (append-only), so the verdicts are kept here. */
export interface StoredReport {
	chosen: number | null;
	notes: string[];
	eligible: boolean[];
	reasons: string[][];
}

type StoredRow = Omit<AutoCalibrationRow, 'cases'> & { cases: AutoCase[] };
/** The fitted cases with the finished report's verdicts. */
const judged = (cases: AutoCase[], report: StoredReport | null): AutoCase[] =>
	report ? cases.map((c, i) => ({ ...c, eligible: report.eligible[i] ?? false, reasons: report.reasons[i] ?? c.reasons })) : cases;
const toRow = (r: StoredRow): AutoCalibrationRow => ({ ...r, cases: judged(r.cases, r.report).map(brief) });

/** The model input a run of the rules fits: the live input without the forecast tail, as every fit and ordinary run (runs/execute.ts). */
export async function calibrationInput(db: Db, projectId: string): Promise<ModelInput> {
	return withoutForecastTail(await loadModelInput(db, projectId));
}

/** SHA-256 of a model input: the settings, the network and every series, as loaded. */
export const inputSha256 = (input: ModelInput): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Why the rules can't run here (the engine's refusal, or a fit longer than a job may run), as the user's to fix. */
export class CalibrationRefused extends Error {}

/**
 * The plan for a run of the rules on this input, with nothing held open
 * while it computes. One case's time is estimated from a full model run
 * (the shortest of three: a fit's evaluations stop at the last scored day, so
 * this errs long) × the model runs one case makes; above
 * AUTO_CASE_SECONDS_MAX the rules are refused before anything is queued.
 */
export function planCalibration(input: ModelInput, maxSeconds = AUTO_CASE_SECONDS_MAX): AutoCalibrationPlan {
	let plan: AutoCalibrationPlan;
	try {
		plan = planAutoCalibration(input);
	} catch (err) {
		throw new CalibrationRefused((err as Error).message);
	}
	let fastest = Infinity;
	for (let i = 0; i < 3; i++) {
		const t0 = performance.now();
		runModel(input);
		fastest = Math.min(fastest, performance.now() - t0);
	}
	const seconds = (plan.caseEvaluations * fastest) / 1000;
	if (seconds > maxSeconds) {
		throw new CalibrationRefused(
			`each fit would take about ${Math.ceil(seconds / 60)} minutes (${plan.caseEvaluations} model runs), more than a background job may run (${maxSeconds / 60} minutes): lower the model runs per fit or the starts in the calibration rules`
		);
	}
	return plan;
}

/** Queued or running automated calibration jobs the user has, in any project they can see. One request at a time per user. */
export async function pendingCalibrationJobs(db: Db): Promise<number> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('auto_calibration_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job WHERE kind = 'auto_calibration' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	return rows[0]?.n ?? 0;
}

/**
 * Write a run of the rules and queue its first case, as the transaction's
 * user (an editor, RLS), and keep the project's newest AUTO_CALIBRATIONS_KEPT
 * (an applied run is never deleted: its fit record points at it).
 */
export async function insertCalibration(
	db: Db,
	projectId: string,
	o: { trigger: AutoCalibrationTrigger; rules: CalibrationRules; plan: AutoCalibrationPlan; inputSha256: string }
): Promise<{ calibration: AutoCalibrationRow; job: JobMeta }> {
	const id = randomUUID();
	const { job } = await enqueueJob(db, { projectId, kind: 'auto_calibration', payload: { calibrationId: id }, maxAttempts: 2 });
	await db.query(
		`INSERT INTO auto_calibration (id, project_id, job_id, "trigger", rules, rules_revision, input_sha256, plan, engine_version)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[id, projectId, job.id, o.trigger, JSON.stringify(o.rules), o.rules.revision, o.inputSha256, JSON.stringify(o.plan), ENGINE_VERSION]
	);
	await db.query(
		`DELETE FROM auto_calibration WHERE id IN (
			SELECT id FROM auto_calibration WHERE project_id = $1 AND applied_at IS NULL ORDER BY created_at DESC, id DESC OFFSET $2)`,
		[projectId, AUTO_CALIBRATIONS_KEPT]
	);
	return { calibration: (await getCalibration(db, projectId, id))!, job };
}

/** A project's runs of the rules, newest first (RLS: viewer). */
export async function listCalibrations(db: Db, projectId: string): Promise<AutoCalibrationRow[]> {
	const { rows } = await db.query<StoredRow>(`${SELECT} WHERE a.project_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT ${AUTO_CALIBRATIONS_KEPT}`, [projectId]);
	return rows.map(toRow);
}

/** One run of the rules; null when there is none (RLS: viewer). */
export async function getCalibration(db: Db, projectId: string, id: string): Promise<AutoCalibrationRow | null> {
	const { rows } = await db.query<StoredRow>(`${SELECT} WHERE a.project_id = $1 AND a.id = $2`, [projectId, id]);
	return rows[0] ? toRow(rows[0]) : null;
}

interface Working {
	id: string;
	status: AutoCalibrationStatus;
	trigger: AutoCalibrationTrigger;
	rules: CalibrationRules;
	plan: AutoCalibrationPlan;
	cases: AutoCase[];
	inputSha256: string;
}

/**
 * The job's work: fit the next case of a running calibration, as the user it
 * runs as, in the job's transaction (the engine is synchronous, as for
 * `yield`). The input must still hash as it did when the rules were planned,
 * or the run fails, saying so (the next new data or a new request runs them
 * again). After the case, the next case's job is queued; after the last, the
 * kept fit is picked and the run completed, and applied at once when new data
 * queued it and the rules say `apply` and are signed off. Returns what
 * happened; false when there was nothing to do.
 */
export async function fitNextCase(db: Db, projectId: string, id: string, progress: (pct: number) => Promise<boolean>): Promise<'next' | 'complete' | 'failed' | false> {
	const { rows } = await db.query<Working>(
		`SELECT id, status, "trigger", rules, plan, cases, input_sha256 AS "inputSha256" FROM auto_calibration WHERE project_id = $1 AND id = $2 FOR UPDATE`,
		[projectId, id]
	);
	const w = rows[0];
	if (!w || w.status !== 'running') return false;
	const input = await calibrationInput(db, projectId);
	if (inputSha256(input) !== w.inputSha256) {
		await db.query(`UPDATE auto_calibration SET status = 'failed', error = $2 WHERE id = $1`, [
			id,
			'the project’s data or settings changed while the rules ran, so the fits would not compare: run them again'
		]);
		return 'failed';
	}
	const i = w.cases.length;
	const fitted = runAutoCase(input, w.plan, i);
	await db.query(`UPDATE auto_calibration SET cases = cases || jsonb_build_array($2::jsonb) WHERE id = $1`, [id, JSON.stringify(fitted)]);
	if (!(await progress((100 * (i + 1)) / w.plan.cases.length))) throw new LeaseLostError();
	if (i + 1 < w.plan.cases.length) {
		const { job } = await enqueueJob(db, { projectId, kind: 'auto_calibration', payload: { calibrationId: id }, maxAttempts: 2 });
		await db.query('UPDATE auto_calibration SET job_id = $2 WHERE id = $1', [id, job.id]);
		return 'next';
	}
	const report = finishAutoCalibration(w.plan, [...w.cases, fitted]);
	const stored: StoredReport = { chosen: report.chosen, notes: report.notes, eligible: report.cases.map((c) => c.eligible), reasons: report.cases.map((c) => c.reasons) };
	await db.query(`UPDATE auto_calibration SET status = 'complete', report = $2, chosen = $3 WHERE id = $1`, [id, JSON.stringify(stored), report.chosen]);
	return 'complete';
}

interface Applicable {
	id: string;
	status: AutoCalibrationStatus;
	rules: CalibrationRules;
	plan: AutoCalibrationPlan;
	cases: AutoCase[];
	chosen: number | null;
	inputSha256: string;
	completedAt: Date | null;
	appliedAt: Date | null;
}

/**
 * Apply a complete run's kept fit, as the transaction's user (an editor):
 * its parameters, and the pan coefficient it was fitted under when a preset,
 * go into the settings with a fit record built here from the stored case
 * (FitRecord.auto: the rules and every case), recorded as a settings
 * revision. Refused (409) when there is no kept fit, it was applied already,
 * the rules have changed since (revision, content or sign-off), or the
 * project's inputs no longer hash as they did when the rules ran. Returns
 * the settings saved.
 */
export async function applyCalibration(db: Db, projectId: string, id: string): Promise<ProjectSettings> {
	const { rows } = await db.query<Applicable>(
		`SELECT id, status, rules, plan, cases, chosen, input_sha256 AS "inputSha256", completed_at AS "completedAt", applied_at AS "appliedAt"
		 FROM auto_calibration WHERE project_id = $1 AND id = $2 FOR UPDATE`,
		[projectId, id]
	);
	const a = rows[0];
	if (!a) throw new ApiError(404, 'not found');
	if (a.status !== 'complete') throw new ApiError(409, a.status === 'running' ? 'the rules are still running' : 'this run of the rules failed; run them again');
	if (a.chosen === null) throw new ApiError(409, 'no fit passed the rules, so there is nothing to apply');
	if (a.appliedAt) throw new ApiError(409, 'this fit was applied already');
	const input = await calibrationInput(db, projectId);
	const now = resolveCalibrationRules(input.settings.calibrationRules, []);
	const ran = resolveCalibrationRules(a.rules, []);
	if (now.revision !== ran.revision || !sameRules(now, ran) || !sameSignOff(now.signedOff, ran.signedOff))
		throw new ApiError(409, `the calibration rules have changed since this run (revision ${ran.revision}, now ${now.revision}): run them again`);
	if (inputSha256(input) !== a.inputSha256) throw new ApiError(409, 'the project’s data or settings have changed since the rules ran: run them again');
	const kept = a.cases[a.chosen]!;
	if (!kept.report) throw new ApiError(409, 'the kept fit has no report');

	const before = await beginSettingsChange(db, projectId);
	const { rows: p } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const current = mergeSettings(p[0]!.settings);
	const pan = kept.pan.values ? { panCoefficient: [...kept.pan.values], panCoefficientSource: `${kept.pan.label} preset (automated calibration)` } : {};
	const fitSettings = { ...current, ...pan } as ProjectSettings;
	const report: AutoCalibrationReport = finishAutoCalibration(a.plan, a.cases);
	const flowKind = kept.report.flowKind as CalibrationFlowKind;
	const apan = input.series.evap_apan_mm;
	const record = fitRecordFromReport(kept.report, {
		settings: fitSettings,
		validate: true,
		validationRecord: a.plan.validationRecord,
		engineVersion: ENGINE_VERSION,
		fittedAt: (a.completedAt ?? new Date()).toISOString(),
		chirpsSource: input.series.rain_chirps_mm ? (input.series.rain_chirps_mm.provenance ?? null) : null,
		apanDaily: apan ? { startDate: apan.startDate, length: apan.values.length, valuesSha256: seriesHash(apan.values) } : null,
		...(input.series[flowKind]?.origin !== undefined ? { observedOrigin: input.series[flowKind]!.origin ?? null } : {}),
		auto: autoFitRecordOf({ ...report, chosen: a.chosen })
	});
	const gr4j = { ...current.gr4j, ...Object.fromEntries(kept.report.free.map((k) => [k, kept.report!.params[k]!])) };
	const next = patchSettings(p[0]!.settings, { gr4j, ...pan, fitRecord: record } as Record<string, unknown>);
	await db.query('UPDATE project SET settings = $2, updated_at = now() WHERE id = $1', [projectId, JSON.stringify(next)]);
	await recordModelRevision(db, projectId, {
		source: 'settings_patch',
		before,
		reason: `Applied the automated calibration of ${record.fittedAt.slice(0, 10)} (calibration rules revision ${a.rules.revision}): ${kept.label}`
	});
	await db.query('UPDATE auto_calibration SET applied_at = now() WHERE id = $1', [id]);
	return next;
}

/**
 * Start the uncertainty ensemble around the applied fit on its run, for the
 * server to compute (`uncertainty` job), and record both on the calibration.
 * The options are the ensemble's defaults for this run (resolveEnsembleOptions
 * centres them on the fit record's bounds and objective); the database draws
 * the seed. As the transaction's user, an editor. Returns the ensemble's id and its job's.
 */
export async function startCalibrationEnsemble(db: Db, projectId: string, calibrationId: string, runId: string, runInput: ModelInput): Promise<{ uncertaintyId: string; jobId: string }> {
	const { options } = resolveEnsembleOptions(runInput, { model: 'gr4j', seed: 0 });
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO run_uncertainty (project_id, run_id, baseline_id, runoff_model, engine_version, method, seed, members, options, created_by)
		 VALUES ($1, $2, NULL, $3, $4, $5, 0, $6, $7, app_current_user_id()) RETURNING id`,
		[projectId, runId, options.model, ENGINE_VERSION, options.method, options.members, JSON.stringify(options)]
	);
	const uncertaintyId = rows[0]!.id;
	const { job } = await enqueueJob(db, { projectId, kind: 'uncertainty', payload: { uncertaintyId }, maxAttempts: 1 });
	await db.query('UPDATE auto_calibration SET applied_run_id = $2, uncertainty_id = $3 WHERE id = $1', [calibrationId, runId, uncertaintyId]);
	return { uncertaintyId, jobId: job.id };
}

/** Record the run an applied fit made, when the rules ask for no ensemble. */
export async function recordAppliedRun(db: Db, calibrationId: string, runId: string): Promise<void> {
	await db.query('UPDATE auto_calibration SET applied_run_id = $2 WHERE id = $1', [calibrationId, runId]);
}

/** The label of the run an applied automated fit makes. */
export const appliedRunLabel = (revision: number) => `Automated calibration · rules revision ${revision}`;
