// Automated calibration run by the server (issue #153, 108_auto_calibration.sql,
// docs/model.md §2.10j, docs/api.md § Automated calibration).
//
// A run of the project's calibration rules is planned from the live model
// input (the water years the rules leave out, the cases in order), stored
// with the rules and the input's hash, and fitted by a chain of
// `auto_calibration` jobs (jobs/handlers/auto-calibration.ts), each queueing
// the next as the same user, so one runs at a time. A case's fit is cut into
// pieces across jobs (fitNextCase: its optimisations run in order, the one
// under way paused by the clock and resumed by the next job from its stored
// state, `work`), so no job runs longer than AUTO_JOB_SECONDS_MAX and the
// result is the unbroken fit's. The last case picks the fit to keep. Every score is the server's own, so a stored
// report is no client's claim, and the only way to put an automated fit in
// the settings is applyCalibration, which builds the fit record here.
import { createHash, randomUUID } from 'node:crypto';
import {
	autoFitRecordOf,
	ENGINE_VERSION,
	et0FitWindow,
	fitScoredThrough,
	finishAutoCalibration,
	locationCalibrationSettings,
	calibrationSeriesKey,
	fitRecordFromReport,
	planAutoCalibration,
	prepareAutoCase,
	resolveCalibrationRules,
	resolveEnsembleOptions,
	sameRules,
	sameSignOff,
	withoutForecastTail,
	type AutoCalibrationPlan,
	type AutoCalibrationReport,
	type AutoCase,
	type CalibrationFlowKind,
	type CalibrationRules,
	type ModelInput,
	type DailySeries,
	type DdsState,
	type Et0DailyFingerprint,
	type FitOutcome,
	type ProjectSettings
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { beginSettingsChange, recordModelRevision } from '../history/record.js';
import { enqueueJob, type JobMeta, type JobStatus } from '../jobs/queue.js';
import { JobRelease, LeaseLostError } from '../jobs/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { mergeSettings, patchSettings } from '../projects/settings.js';
import { loadModelInput, seriesHash } from '../runs/execute.js';

/** The daily reference ET series' fit fingerprint (issue #604 R5-E): its days through `through` hashed as a run's snapshot is; null without any. */
function et0Fingerprint(series: DailySeries | undefined, through: string): Et0DailyFingerprint | null {
	const w = series ? et0FitWindow(series, through) : null;
	return w ? { startDate: w.startDate, length: w.values.length, valuesSha256: seriesHash(w.values), through } : null;
}
import {
	calibrationSeconds,
	caseJobs,
	evaluationSeconds,
	FINISH_EVALUATIONS,
	finishSeconds,
	modelSize,
	pieceOverheadSeconds,
	wallClock,
	type Clock
} from './estimate.js';
import { AUTO_CALIBRATIONS_KEPT, AUTO_JOB_SECONDS_MAX, AUTO_RUN_SECONDS_MAX } from './schema.js';

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
	plan: Pick<AutoCalibrationPlan, 'flowKind' | 'siteNodeId' | 'validationRecord' | 'years' | 'ruleExclusions' | 'notes'> & { cases: AutoCalibrationPlan['cases'] };
	cases: CaseBrief[];
	/** The finished report's notes and verdicts (whether each case may be kept, and why not); null while running or when it failed. */
	report: StoredReport | null;
	chosen: number | null;
	error: string | null;
	engineVersion: string;
	/** The case under way when its fit has started: the model runs its fit has made and makes in all, over its jobs. */
	work: { done: number; total: number } | null;
	/** The job fitting the next piece (null once the purge removed it). */
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

const SELECT = `SELECT a.id, a."trigger", a.status, a.rules_revision AS "rulesRevision", a.rules, a.plan, a.cases, a.report, a.chosen, a.error, a.work,
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

type StoredRow = Omit<AutoCalibrationRow, 'cases' | 'work'> & { cases: AutoCase[]; work: CaseWork | null };
/** The fitted cases with the finished report's verdicts. */
const judged = (cases: AutoCase[], report: StoredReport | null): AutoCase[] =>
	report ? cases.map((c, i) => ({ ...c, eligible: report.eligible[i] ?? false, reasons: report.reasons[i] ?? c.reasons })) : cases;
const toRow = (r: StoredRow): AutoCalibrationRow => ({
	...r,
	cases: judged(r.cases, r.report).map(brief),
	work: r.status === 'running' && r.work && r.work.case === r.cases.length ? { done: r.work.done, total: r.work.total } : null
});

/** The model input a run of the rules fits: the live input without the forecast tail, as every fit and ordinary run (runs/execute.ts). */
export async function calibrationInput(db: Db, projectId: string): Promise<ModelInput> {
	return withoutForecastTail(await loadModelInput(db, projectId));
}

/** SHA-256 of a model input: the settings, the network and every series, as loaded. */
export const inputSha256 = (input: ModelInput): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Why the rules can't run here (the engine's refusal, or a fit longer than a job may run), as the user's to fix. */
export class CalibrationRefused extends Error {}

/**
 * The plan for a run of the rules on this input. Its time on the job worker
 * is estimated from the model's size × the model runs it makes (./estimate.ts:
 * no clock, so the same project and rules always get the same answer however
 * busy the server is). A case's fit runs over as many jobs as it needs, so
 * the rules are refused only for what can't be cut: a case's last step
 * (scoring the fit, then a run with it) past one job's `maxSeconds`
 * (AUTO_JOB_SECONDS_MAX), or the whole run past `maxRunSeconds`
 * (AUTO_RUN_SECONDS_MAX). Either is refused before anything is queued.
 */
export function planCalibration(input: ModelInput, maxSeconds = AUTO_JOB_SECONDS_MAX, maxRunSeconds = AUTO_RUN_SECONDS_MAX): AutoCalibrationPlan {
	let plan: AutoCalibrationPlan;
	let size: ReturnType<typeof modelSize>;
	try {
		plan = planAutoCalibration(input);
		size = modelSize(input);
	} catch (err) {
		throw new CalibrationRefused((err as Error).message);
	}
	const step = pieceOverheadSeconds(size) + finishSeconds(plan, size);
	if (step > maxSeconds) {
		throw new CalibrationRefused(
			`the model is too large to calibrate on the server: the last step of each fit (scoring it, ${plan.rules.run.starts + FINISH_EVALUATIONS} model runs, then a run with it) would take up to about ${Math.ceil(step / 60)} minutes there, more than a background job may run (${maxSeconds / 60} minutes): lower the starts in the calibration rules or shorten the simulation period`
		);
	}
	const total = calibrationSeconds(plan, size, maxSeconds);
	if (total > maxRunSeconds) {
		const n = plan.cases.length;
		throw new CalibrationRefused(
			`the rules would take up to about ${Math.ceil(total / 3600)} hours on the server (${n} fit${n === 1 ? '' : 's'} of ${plan.caseEvaluations} model runs each), more than a run of the rules may take (${maxRunSeconds / 3600} hours): lower the model runs per fit, the starts or the fits in the calibration rules`
		);
	}
	return plan;
}

/** Queued or running automated calibration jobs the user has, in any project they can see. One request at a time per user. */
export async function pendingCalibrationJobs(db: Db): Promise<{ projectId: string; projectName: string | null }[]> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('auto_calibration_job_cap:' || app_current_user_id()::text, 0))`);
	// The project's name only while the user can still see it (RLS); a project they've since left has none.
	const { rows } = await db.query<{ projectId: string; projectName: string | null }>(
		`SELECT j.project_id AS "projectId", p.name AS "projectName"
		   FROM job j LEFT JOIN project p ON p.id = j.project_id
		  WHERE j.kind = 'auto_calibration' AND j.acting_user_id = app_current_user_id() AND j.status IN ('queued', 'running', 'failed')
		  ORDER BY j.created_at`
	);
	return rows;
}

/**
 * Why the cap refuses another run: where the user's queued or running one is,
 * so a run in another project doesn't read as if it were running in this one.
 */
export function pendingCalibrationMessage(projectId: string, pending: { projectId: string; projectName: string | null }[]): string {
	const here = pending.some((p) => p.projectId === projectId);
	const elsewhere = pending.find((p) => p.projectId !== projectId);
	if (here || !elsewhere) return 'an automated calibration is already queued or running in this project; wait for it to finish';
	const where = elsewhere.projectName ? `in the project “${elsewhere.projectName}”` : 'in another project';
	return `you already have an automated calibration queued or running ${where}, and only one at a time is allowed; wait for it to finish, then start this one`;
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
	work: CaseWork | null;
	inputSha256: string;
	engineVersion: string;
}

/**
 * Where the case under way stands between two of its jobs (290_auto_calibration_work):
 * the optimisations of its fit finished, in order, and the search of the next
 * one paused where the last job stopped (the engine's DDS state). `done` and
 * `total` are the fit's model runs so far and in all, for the page; `jobs`
 * the jobs it has taken.
 */
interface CaseWork {
	case: number;
	fits: FitOutcome[];
	search: DdsState | null;
	done: number;
	total: number;
	jobs: number;
}

/**
 * Model runs a job may make, at most (tests narrow it to cut a small fit into
 * several jobs; the clock cuts it in production), and how soon a job claimed
 * late in the worker's tick hands itself back instead of starting.
 */
export const calibrationPieces = { maxEvaluations: Infinity, minSeconds: 30 };
/** A job handed back for too little time left in the tick runs again after this (past the tick). */
export const RELEASE_DELAY_SECONDS = 120;
/** A case may take this many times the jobs estimated (and a few more) before the run is stopped: the worker would be far slower than the estimate. */
const JOBS_SLACK = 3;
const JOBS_EXTRA = 4;

export interface FitOptions {
	/** The clock the job's time is kept by (ms); tests pass their own. */
	now?: Clock;
	/** The longest the job may run (AUTO_JOB_SECONDS_MAX). */
	maxSeconds?: number;
	/** When the worker must be done (epoch ms, JobContext.deadline): the job stops sooner when that is sooner. */
	deadline?: number | null;
}

/**
 * The job's work: fit the next piece of a running calibration, as the user it
 * runs as, in the job's transaction (the engine is synchronous, as for
 * `yield`). The input must still hash as it did when the rules were planned,
 * or the run fails, saying so (the next new data or a new request runs them
 * again).
 *
 * A piece goes on with the case under way (or starts the next): it runs the
 * fit's optimisations in order, from where the stored `work` left off, until
 * the job's time (`maxSeconds`, or less before the worker's `deadline`) would
 * be passed by one more model run, by the clock. It then pauses the search
 * where it stands, stores it and queues the next piece as the same user. A
 * paused search resumes exactly (calibrate/dds.ts), so the case is the one an
 * unbroken fit gives, however the clock cut it. Once every optimisation has
 * run, the case is built (its report, the run with the fit, the filters) when
 * its estimate fits the time left, else in the next job, and appended; after
 * the last case the kept fit is picked and the run completed (applied at once
 * when new data queued it and the rules say `apply` and are signed off).
 *
 * Every job makes at least one model run or builds a case, so a run ends. A
 * case taking far more jobs than estimated (the worker far slower than the
 * estimate) stops the run, saying so. A job claimed with less than
 * calibrationPieces.minSeconds left before the deadline is handed back
 * (JobRelease, its attempt given back). Returns what happened; false when
 * there was nothing to do.
 */
export async function fitNextCase(
	db: Db,
	projectId: string,
	id: string,
	progress: (pct: number) => Promise<boolean>,
	o: FitOptions = {}
): Promise<'next' | 'complete' | 'failed' | false> {
	const now = o.now ?? wallClock;
	const t0 = now();
	const maxMs = (o.maxSeconds ?? AUTO_JOB_SECONDS_MAX) * 1000;
	const availableMs = o.deadline ? Math.min(maxMs, o.deadline - Date.now() - 5_000) : maxMs;
	const elapsed = () => now() - t0;
	const fail = async (error: string) => {
		await db.query(`UPDATE auto_calibration SET status = 'failed', error = $2, work = NULL WHERE id = $1`, [id, error]);
		return 'failed' as const;
	};
	const { rows } = await db.query<Working>(
		`SELECT id, status, "trigger", rules, plan, cases, work, input_sha256 AS "inputSha256", engine_version AS "engineVersion"
		 FROM auto_calibration WHERE project_id = $1 AND id = $2 FOR UPDATE`,
		[projectId, id]
	);
	const w = rows[0];
	if (!w || w.status !== 'running') return false;
	const input = await calibrationInput(db, projectId);
	if (inputSha256(input) !== w.inputSha256) return fail('the project’s data or settings changed while the rules ran, so the fits would not compare: run them again');
	// A release between two jobs: the fits so far (and a paused search) are another engine's, so the run would mix two.
	if (w.engineVersion !== ENGINE_VERSION)
		return fail(`the server’s model engine changed while the rules ran (${w.engineVersion} to ${ENGINE_VERSION}), so the fits would not compare: run them again`);
	const i = w.cases.length;
	const size = modelSize(input);
	const evalMs = evaluationSeconds(size) * 1000;
	const finishMs = finishSeconds(w.plan, size) * 1000;
	const job = prepareAutoCase(input, w.plan, i);
	let fitted: AutoCase | null = null;
	let work: CaseWork | null = null;
	let ran = 0;
	let finished = false;
	if (!('finish' in job)) fitted = job; // The fit can't start: the case says why, as in the browser.
	else {
		work = w.work && w.work.case === i ? w.work : { case: i, fits: [], search: null, done: 0, total: job.count * job.budget, jobs: 0 };
		const allDone = work.fits.length === job.count;
		// Claimed late in the worker's tick: hand it back for the next tick rather than start a sliver of work.
		if (availableMs < maxMs && availableMs - elapsed() < Math.max(calibrationPieces.minSeconds * 1000, allDone ? finishMs : evalMs))
			throw new JobRelease('too little time left in this tick', RELEASE_DELAY_SECONDS);
		const maxJobs = JOBS_SLACK * caseJobs(w.plan, size, maxMs / 1000) + JOBS_EXTRA;
		if (++work.jobs > maxJobs) {
			return fail(
				`a fit took more background jobs than estimated (${maxJobs}), so the server is far slower than the estimate: lower the model runs per fit or the starts in the calibration rules, and run them again`
			);
		}
		const quota = calibrationPieces.maxEvaluations;
		// One more model run would pass the job's time, or its quota: pause there.
		const full = () => ran >= quota || elapsed() + evalMs > availableMs;
		try {
			while (work.fits.length < job.count) {
				if (ran > 0 && full()) break;
				const from = work.search?.evaluations ?? 0;
				const before = ran;
				const r = job.fit(work.fits.length, {
					...(work.search ? { resume: work.search } : {}),
					pause: (n) => {
						ran = before + (n - from);
						return full();
					}
				});
				if ('paused' in r) {
					ran = before + (r.paused.evaluations - from);
					work.search = r.paused;
					break;
				}
				ran = before + (r.done.evaluations - from);
				work.fits.push(r.done);
				work.search = null;
			}
			work.done = work.fits.reduce((m, f) => m + f.evaluations, 0) + (work.search?.evaluations ?? 0);
			// Every optimisation run: build the case now if its last step fits the time left (or nothing else ran), else next job.
			if (work.fits.length === job.count && (ran === 0 || elapsed() + finishMs <= availableMs)) {
				finished = true;
				fitted = job.finish(work.fits);
			}
		} catch (err) {
			if (err instanceof JobRelease || err instanceof LeaseLostError) throw err;
			// A fit that throws fails this case only, as in the browser.
			fitted = job.failed(err);
		}
	}
	logEvent('info', {
		event: 'auto_calibration_piece',
		calibrationId: id,
		case: i,
		job: work?.jobs ?? 1,
		evaluations: ran,
		estimatedSeconds: Math.round(pieceOverheadSeconds(size) + (ran * evalMs + (finished ? finishMs : 0)) / 1000),
		seconds: Math.round(elapsed() / 1000),
		finished: fitted !== null
	});
	const n = w.plan.cases.length;
	if (!fitted) {
		await db.query('UPDATE auto_calibration SET work = $2 WHERE id = $1', [id, JSON.stringify(work)]);
		if (!(await progress((100 * (i + work!.done / work!.total)) / n))) throw new LeaseLostError();
		await queueNext(db, projectId, id);
		return 'next';
	}
	await db.query(`UPDATE auto_calibration SET cases = cases || jsonb_build_array($2::jsonb), work = NULL WHERE id = $1`, [id, JSON.stringify(fitted)]);
	if (!(await progress((100 * (i + 1)) / n))) throw new LeaseLostError();
	if (i + 1 < n) {
		await queueNext(db, projectId, id);
		return 'next';
	}
	const report = finishAutoCalibration(w.plan, [...w.cases, fitted]);
	const stored: StoredReport = { chosen: report.chosen, notes: report.notes, eligible: report.cases.map((c) => c.eligible), reasons: report.cases.map((c) => c.reasons) };
	await db.query(`UPDATE auto_calibration SET status = 'complete', report = $2, chosen = $3 WHERE id = $1`, [id, JSON.stringify(stored), report.chosen]);
	return 'complete';
}

/** Queue the run's next piece as the same user (the transaction's), one at a time: the chain is the only way it goes on. */
async function queueNext(db: Db, projectId: string, id: string): Promise<void> {
	const { job } = await enqueueJob(db, { projectId, kind: 'auto_calibration', payload: { calibrationId: id }, maxAttempts: 2 });
	await db.query('UPDATE auto_calibration SET job_id = $2 WHERE id = $1', [id, job.id]);
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
	// The fit is the headline location's (engine 1.110.0, issue #659): a gauge's goes into its row, the outlet's (or, with no
	// gauge location, the catchment's) into the top level, as the rules varied them (calibrate/auto.ts withHeadlineParams).
	// Its record reads that location's window, exclusions and quality flags.
	const at = kept.report.zoneUnits ? (kept.report.zoneNodeId ?? null) : null;
	if (at !== null && !(current.calibrationZones ?? []).some((z) => z.nodeId === at))
		throw new ApiError(409, 'the calibration location the rules fitted is no longer in the settings: run them again');
	const fitSettings = locationCalibrationSettings({ ...current, ...pan } as ProjectSettings, at);
	const report: AutoCalibrationReport = finishAutoCalibration(a.plan, a.cases);
	const flowKind = kept.report.flowKind as CalibrationFlowKind;
	// The fitted record: the outlet's, or the calibration site's gauge record (engine ≥ 1.41.0).
	const fitted = input.series[calibrationSeriesKey(flowKind, kept.report.siteNodeId ?? null)];
	const apan = input.series.evap_apan_mm;
	const et0 = input.series.evap_et0_mm;
	const record = fitRecordFromReport(kept.report, {
		settings: fitSettings,
		validate: true,
		validationRecord: a.plan.validationRecord,
		engineVersion: ENGINE_VERSION,
		fittedAt: (a.completedAt ?? new Date()).toISOString(),
		chirpsSource: input.series.rain_chirps_mm ? (input.series.rain_chirps_mm.provenance ?? null) : null,
		apanDaily: apan ? { startDate: apan.startDate, length: apan.values.length, valuesSha256: seriesHash(apan.values) } : null,
		// Through the fit's last scored day only (et0FitWindow): a feed's later days never reached the fit.
		et0Daily: et0Fingerprint(et0, fitScoredThrough(kept.report)),
		...(fitted?.origin !== undefined ? { observedOrigin: fitted.origin ?? null } : {}),
		auto: autoFitRecordOf({ ...report, chosen: a.chosen })
	});
	const fitted4 = Object.fromEntries(kept.report.free.map((k) => [k, kept.report!.params[k]!]));
	let patch: Record<string, unknown>;
	if (at === null) patch = { gr4j: { ...current.gr4j, ...fitted4 }, ...pan, fitRecord: record };
	else {
		const rows = current.calibrationZones ?? [];
		patch = { calibrationZones: rows.map((z) => (z.nodeId === at ? { ...z, gr4j: { ...(z.gr4j ?? pick4(current.gr4j)), ...fitted4 }, fitRecord: record } : z)), ...pan };
	}
	const next = patchSettings(p[0]!.settings, patch);
	await db.query('UPDATE project SET settings = $2, updated_at = now() WHERE id = $1', [projectId, JSON.stringify(next)]);
	await recordModelRevision(db, projectId, {
		source: 'settings_patch',
		before,
		reason: `Applied the automated calibration of ${record.fittedAt.slice(0, 10)} (calibration rules revision ${a.rules.revision}): ${kept.label}`
	});
	await db.query('UPDATE auto_calibration SET applied_at = now() WHERE id = $1', [id]);
	return next;
}

/** GR4J's X1–X4 of a parameter set (a row holds those four only). */
const pick4 = (g: ProjectSettings['gr4j']) => ({ x1: g.x1, x2: g.x2, x3: g.x3, x4: g.x4 });

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
