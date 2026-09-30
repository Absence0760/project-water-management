import { createHash, randomUUID } from 'node:crypto';
import {
	type AllocationEntry,
	type ForecastRainSource,
	forecastSplit,
	gaugeSeriesKey,
	resolveFitRecord,
	runForecastChecked,
	runModelChecked,
	seriesDigest,
	type CalibrationFlowKind,
	type DailySeries,
	type ModelInput,
	type ModelOutput,
	type OpClass,
	type RunVerification,
	type ScenarioOp,
	type SeriesKind,
	seriesOrigin,
	type SeriesOrigin,
	type SeriesProvenance,
	withoutForecastTail
} from '@water-management/engine';
import { type Db, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { recordAudit } from '../history/record.js';
import { loadModel } from '../model/store.js';
import { requireRole } from '../projects/access.js';
import { mergeSettings } from '../projects/settings.js';
import { stampRun } from './stamp.js';
import { logEvent } from '../logging/logEvent.js';

/**
 * SHA-256 hex of a series' values (engine `seriesDigest`: the values as JSON,
 * null = missing day), stored in the run's input snapshot as `valuesSha256`
 * and the key of the values' `series_blob` (021_series_blob.sql).
 */
export const seriesHash = (values: readonly (number | null)[]): string => createHash('sha256').update(seriesDigest(values)).digest('hex');

/** Gather everything the engine needs for a project. */
export async function loadModelInput(db: Db, projectId: string): Promise<ModelInput> {
	return (await loadLiveInput(db, projectId)).input;
}

/** Which series each kind (or gauge record, `<kind>@<node id>`) of a live input was read from (run_input_series.series_id, 056_accepted_series). */
export type InputSeriesIds = Partial<Record<keyof ModelInput['series'], string>>;

/** loadModelInput, with the id of the series each kind came from. */
async function loadLiveInput(db: Db, projectId: string): Promise<{ input: ModelInput; seriesIds: InputSeriesIds }> {
	const { rows: p } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const model = await loadModel(db, projectId);
	// First series of each kind (ordered by name) — the engine takes one per kind.
	const { rows: s } = await db.query<{
		id: string;
		kind: SeriesKind;
		start_date: string;
		values: (number | null)[];
		product: string | null;
		product_version: string | null;
		site_node_id: string | null;
		source: string | null;
		source_unit: string | null;
		source_unit_factor: number | null;
	}>(
		// The outlet's: the first of each kind among the series with no site. A gauge node's own
		// flow records (084_gauge_records): the first of each kind per site, keyed `<kind>@<node id>`
		// (engine gaugeSeriesKey), which only the plausibility checks read.
		`SELECT DISTINCT ON (site_node_id, kind) id, kind, start_date, "values", product, product_version, site_node_id,
			source, source_unit, source_unit_factor
		 FROM time_series WHERE project_id = $1 ORDER BY site_node_id NULLS FIRST, kind, name`,
		[projectId]
	);
	const series: ModelInput['series'] = {};
	const seriesIds: InputSeriesIds = {};
	for (const r of s) {
		const key = r.site_node_id === null ? r.kind : gaugeSeriesKey(r.kind as CalibrationFlowKind, r.site_node_id);
		seriesIds[key] = r.id;
		// The product and version (032_series_provenance.sql) ride along for the run's snapshot; the model ignores them.
		const provenance = r.product !== null && r.product_version !== null ? { product: r.product, version: r.product_version } : null;
		// So do where the values came from and the unit they were given in (107_series_source.sql).
		const origin = seriesOrigin({ source: r.source, sourceUnit: r.source_unit, sourceUnitFactor: r.source_unit_factor });
		series[key] = { startDate: r.start_date, values: r.values, provenance, origin };
	}
	// settings.autoRun (runs/autoRun.ts) says when the project runs, not how, settings.outcomes
	// (projects/outcomeSettings.ts) how its results are read, and settings.outlook
	// (projects/outlookSettings.ts) how a seasonal outlook is set up: none is a model input, so runs don't record them.
	const { autoRun: _autoRun, outcomes: _outcomes, outlook: _outlook, ...settings } = mergeSettings(p[0]?.settings) as unknown as Record<string, unknown>;
	// Registered volumes (engine ≥ 1.18.0, issue #72): what settings.allocationMode caps or scales the run
	// to, and what its summary compares with. Only when the project has any, so a project without them
	// runs on the same input as before.
	const allocations = await allocationsForRun(db, projectId);
	return { input: { settings: settings as unknown as ModelInput['settings'], model: allocations.length ? { ...model, allocations } : model, series }, seriesIds };
}

/**
 * A project's allocations as a run reads them (engine AllocationEntry), in id
 * order: the volume, source, validity and match, and the licence conditions
 * (a cap run applies the months and the rate, engine ≥ 1.34.0). Never the holder's name, the
 * registration number or the property: a run's stored input is readable by
 * every viewer, and the engine needs none of them (D3, docs/allocations.md §
 * Who sees what). Read under the caller's RLS, like the rest of the input.
 */
export async function allocationsForRun(db: Db, projectId: string): Promise<AllocationEntry[]> {
	const { rows } = await db.query<AllocationEntry>(
		`SELECT id, node_id AS "nodeId", water_source AS "waterSource", volume_m3_year AS "volumeM3PerYear", storage_m3 AS "storageM3",
			valid_from AS "validFrom", valid_to AS "validTo", months::int[] AS months, max_rate_m3s AS "maxRateM3s"
		 FROM allocation WHERE project_id = $1 ORDER BY id`,
		[projectId]
	);
	return rows;
}

/**
 * Log a structured JSON line CloudWatch's self-check metric filter matches
 * (infra/alarms.tf, `aws_cloudwatch_log_metric_filter.self_check_failed`) when
 * a saved run fails one of the engine's own self-checks — a model bug, not a
 * user error (docs/followups.md "Alert on a failed self-check in production").
 * Only failed check ids go in the line: no user data, no farm names or
 * values, nothing that could identify the client. A run with no failed
 * checks (including one from an engine too old to carry `verification`)
 * logs nothing.
 */
export function logSelfCheckFailure(projectId: string, runId: string, output: { summary: { verification?: RunVerification } }): void {
	const checks = output.summary.verification?.checks.filter((c) => !c.passed).map((c) => c.id) ?? [];
	if (checks.length === 0) return;
	logEvent('error', { event: 'self_check_failed', projectId, runId, checks });
}

/**
 * What made a run (model_run.trigger, 042_auto_rerun.sql): a person (`manual`:
 * Run, a queued re-run, an import, a scenario), the debounced re-run after
 * new data (`auto`, WP-2.11), or a forecast run (`forecast`, WP-2.12).
 */
export const RUN_TRIGGERS = ['manual', 'auto', 'forecast'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * How many unkept runs of each automatic trigger a project keeps: the newest
 * auto run (and, with WP-2.12, forecast run) replaces the one before, so a
 * daily feed doesn't grow storage and never pushes a person's run out.
 */
export const AUTOMATIC_RUNS_KEPT = 1;

/** Default for RUNS_KEPT_PER_PROJECT. */
export const DEFAULT_RUNS_KEPT = 20;

/**
 * How many runs a project keeps (`RUNS_KEPT_PER_PROJECT`, default 20). A run
 * of a long catchment is several MB of daily outputs, so without a cap
 * storage grows with every press of Run. Invalid values fall back to the
 * default rather than disabling the cap.
 */
export function runsKeptPerProject(env: string | undefined = process.env.RUNS_KEPT_PER_PROJECT): number {
	const n = Number(env);
	return env !== undefined && env.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_RUNS_KEPT;
}

/**
 * Most pinned runs per project (the model_run_pin_limit trigger, 015_run_pinned.sql, enforces the same number).
 * A cited run's pin doesn't count (024_scenarios.sql): it is kept anyway.
 */
export const PINNED_RUNS_PER_PROJECT_MAX = 10;

/**
 * True for a run the storage cap never trims and the DELETE route refuses, as
 * a SQL expression over `model_run r`: one an editor pinned (015_run_pinned),
 * one the evidence history names, now or before (010_run_nomination), or one
 * something **cites** (`model_run_cited`, 021_series_blob.sql; a
 * publication in the project's history cites its run, 022_publication.sql,
 * so a published run is kept until its last publication is trimmed from the
 * history of 12). The single exemption path for all of them, so they can't
 * drift apart.
 *
 * A new kind of citation is not added here: its migration adds one EXISTS
 * clause to `model_run_cited` (CREATE OR REPLACE; the pattern is in
 * 021_series_blob.sql), as 024_scenarios.sql did for a scenario's base run,
 * and this expression, trimRuns and the DELETE route pick it up unchanged.
 *
 * It is `app_run_kept` (045_contributor_scope.sql), the SECURITY DEFINER
 * function the database's own trims use (an application's runs,
 * app_trim_application_runs in 046, and a deleted application's,
 * scenario_drop_application_runs): one definition, so the API and the
 * database can't disagree about which runs are kept (issue #77).
 */
export const RUN_KEPT_SQL = `app_run_kept(r.id)`;

/**
 * What cites a run, as a SQL expression over `model_run r`: a jsonb list of
 * `{ kind, id, name }`, oldest first, of the citations the caller can see
 * (RLS): publications (022_publication.sql; `name` is the day it was
 * published, YYYY-MM-DD, in the project's time zone, 058/059), scenarios (024_scenarios.sql) and sign-offs
 * (036_signoff.sql; `name` is the signer's full name) and evidence packs
 * (112_evidence_pack.sql; `name` is `version N`). Assessments add their kind
 * here with their migration. `model_run_cited`
 * answers "is it cited at all", including citations the caller can't see.
 */
export const CITED_BY_SQL = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', c.kind, 'id', c.id, 'name', c.name) ORDER BY c.at, c.id), '[]'::jsonb) FROM (
		SELECT 'publication' AS kind, p.id, to_char(p.published_at AT TIME ZONE app_time_zone((SELECT pj.time_zone FROM project pj WHERE pj.id = p.project_id)), 'YYYY-MM-DD') AS name, p.published_at AS at FROM run_publication p WHERE p.run_id = r.id
		UNION ALL
		SELECT 'scenario', s.id, s.name, s.created_at FROM scenario s WHERE s.base_run_id = r.id
		UNION ALL
		SELECT 'signoff', so.id, so.full_name, so.signed_at FROM signoff so WHERE so.run_id = r.id
		UNION ALL
		SELECT 'pack', ep.id, 'version ' || ep.version, ep.created_at FROM evidence_pack ep WHERE ep.baseline_run_id = r.id OR ep.scenario_run_id = r.id
	) c)`;

/** One citation of a run (RunMeta.citedBy). For a publication, `name` is the day it was published (YYYY-MM-DD, in the project's time zone). */
export interface RunCitation {
	kind: 'publication' | 'scenario' | 'signoff' | 'pack';
	id: string;
	name: string;
}

/**
 * Why a cited run is kept, for a 409: `this run is cited by the publication of
 * 2026-09-25, scenario "A", so it is kept`, or without names when the caller
 * can see none of its citations.
 */
export async function citedMessage(db: Db, projectId: string, runId: string, tail = 'so it is kept'): Promise<string> {
	const { rows } = await db.query<{ cited: RunCitation[] }>(`SELECT ${CITED_BY_SQL} AS cited FROM model_run r WHERE r.project_id = $1 AND r.id = $2`, [projectId, runId]);
	const cited = rows[0]?.cited ?? [];
	if (!cited.length) return `this run is cited, ${tail}`;
	const names = cited.slice(0, 3).map((c) => (c.kind === 'publication' ? `the publication of ${c.name}` : c.kind === 'signoff' ? `the sign-off by ${c.name}` : c.kind === 'pack' ? `the evidence pack ${c.name}` : `${c.kind} "${c.name}"`));
	const more = cited.length > 3 ? ` and ${cited.length - 3} more` : '';
	return `this run is cited by ${names.join(', ')}${more}, ${tail}`;
}

/**
 * Serialise the project's run writes and removals to the end of the caller's
 * transaction: trimRuns, the run DELETE route and storeRun's stored inputs
 * all take it. Without it a new run could reuse a stored input series
 * (series_blob) in the same moment a trim frees that series' last other
 * reference and garbage-collects it, failing one of the two.
 */
export async function lockProjectRuns(db: Db, projectId: string): Promise<void> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('model_run_trim:' || $1::text, 0))`, [projectId]);
}

/** Also over `model_run r`: a publication (current or in the history) holds the run, for the DELETE route's message. */
export const RUN_PUBLISHED_SQL = `EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = r.id)`;

/**
 * Delete the project's oldest runs beyond the cap (run_series cascades).
 * Runs inside the caller's transaction as the signed-in editor, so RLS
 * (model_run_delete: editor) applies. Returns the ids removed.
 *
 * A kept run (RUN_KEPT_SQL: pinned, nominated as evidence now or before, or
 * cited, published runs included) is never trimmed and doesn't count against the cap: the cap keeps the
 * newest `keep` manual runs that are neither, and the newest
 * AUTOMATIC_RUNS_KEPT of each automatic trigger (`auto`, `forecast`;
 * model_run.trigger), counted apart: an auto run replaces the older auto run
 * and never pushes a person's run out, however often data arrives.
 *
 * One trim at a time per project, held to the end of the caller's
 * transaction (as the pin limit's trigger does, 015_run_pinned.sql). Without
 * it, runs saved at the same moment each trimmed before the others had
 * committed, so none saw the full count and the project kept more than
 * `keep`. With it, the second waits for the first to commit and its DELETE
 * (a new statement, READ COMMITTED) sees that run.
 *
 * A trimmed run's input references go with it (cascade), and the
 * run_input_series_gc trigger then removes every stored input series no
 * remaining run uses; kept runs keep theirs.
 */
export async function trimRuns(db: Db, projectId: string, keep = runsKeptPerProject()): Promise<string[]> {
	await lockProjectRuns(db, projectId);
	const { rows } = await db.query<{ id: string }>(
		`DELETE FROM model_run WHERE id IN (
			SELECT t.id FROM (
				SELECT r.id, r.trigger, row_number() OVER (PARTITION BY r.trigger ORDER BY r.created_at DESC, r.id DESC) AS n
				FROM model_run r
				WHERE r.project_id = $1 AND NOT ${RUN_KEPT_SQL}
			) t
			WHERE t.n > CASE WHEN t.trigger = 'manual' THEN $2::int ELSE $3::int END
		) RETURNING id`,
		[projectId, keep, AUTOMATIC_RUNS_KEPT]
	);
	// The storage cap's removals are in the project's history too (030_history.sql).
	if (rows.length) await recordAudit(db, projectId, 'run.deleted', { runIds: rows.map((r) => r.id), reason: 'trimmed' });
	return rows.map((r) => r.id);
}

/** One input series kind as a run snapshot records it (`model_run.inputs.series[kind]`). */
interface SnapshotSeries {
	startDate: string;
	length: number;
	/** SHA-256 of seriesDigest(values); absent on runs saved before the hash existed. */
	valuesSha256?: string;
	/** The series' product and version (032_series_provenance.sql), null = not recorded; absent on runs saved before it. */
	provenance?: SeriesProvenance | null;
	/** Where the values came from and the unit they were given in (107_series_source.sql), null = not recorded; absent on runs saved before it. */
	origin?: SeriesOrigin | null;
}

/**
 * What a scenario run records about the scenario that made it, in its input
 * snapshot (`model_run.inputs.scenario`): the ops exactly as applied, their
 * hash, the base run and how each op was classed. Immutable with the run, so
 * compare shows the ops that produced it even after the scenario is edited,
 * rebased or deleted (docs/scenarios.md).
 */
export interface RunScenarioSnapshot {
	id: string;
	/** The scenario's name when the run was made. */
	name: string;
	baseRunId: string;
	ops: ScenarioOp[];
	opsSha256: string;
	ownedNodeIds: string[];
	/** classifyScenario(base, ops, ownedNodeIds), one per op. */
	classified: OpClass[];
}

/** A forecast run asked for with no forecast rain after the last observed day (409; a scheduled forecast run skips instead). */
export class NoForecastRainError extends ApiError {
	constructor() {
		super(409, 'there is no forecast rain after the last observed rain day to run: upload a forecast series or add a CHIRPS-GEFS feed');
	}
}

/**
 * Everything a run needs from the database, read before the engine runs:
 * the input, the label, the trigger and, for a scenario run, what the
 * scenario was. The input is what storeRun records as the run's snapshot and
 * input series, so a run's results always match its stored inputs, whatever
 * happens to the project while the engine runs.
 */
export interface RunPlan {
	projectId: string;
	label: string;
	input: ModelInput;
	trigger: RunTrigger;
	scenario?: RunScenarioSnapshot;
	/** A draft application's run: its label stays out of the project's log (storeRun's audit event). */
	privateLabel?: boolean;
	/** For a run of the live model: the series each input kind was read from (stored as run_input_series.series_id, 056). */
	seriesIds?: InputSeriesIds;
	/** A forecast run of the live model: where its forecast days' rain came from (inputs.forecastRainSource, forecastRainSource below). */
	forecastRainSource?: ForecastRainSource;
}

/** The engine half of a run: no database. Injectable in tests (runOutsideTransaction). */
export type ComputeRun = (plan: RunPlan) => ModelOutput | Promise<ModelOutput>;

/**
 * Run the engine on a plan. The engine's self-checks and water balance are
 * stored with the run (engine ≥ 0.12.0). A forecast run is reproduced by
 * runForecastChecked(loadRunInput(run)), an ordinary one by runModelChecked.
 */
export const computeRun = (plan: RunPlan): ModelOutput => (plan.trigger === 'forecast' ? runForecastChecked(plan.input) : runModelChecked(plan.input));

/**
 * The live model's plan: the project's current inputs (loadModelInput).
 * Forecast mode (WP-2.12): the history as an ordinary run, the forecast days
 * after it, summary.forecast over them. Every other run (manual, auto)
 * leaves the forecast tail out entirely (withoutForecastTail), so forecast
 * rain never reaches the figures farmers and regulators rely on; it stores
 * the input it ran on, so runModel(loadRunInput(run)) still reproduces it.
 */
export async function prepareRun(
	db: Db,
	projectId: string,
	label: string | ((input: ModelInput) => string),
	trigger: RunTrigger = 'manual'
): Promise<RunPlan> {
	const { input: live, seriesIds } = await loadLiveInput(db, projectId);
	const forecastFrom = trigger === 'forecast' ? forecastSplit(live).forecastFrom : null;
	if (trigger === 'forecast' && !forecastFrom) throw new NoForecastRainError();
	const input = trigger === 'forecast' ? live : withoutForecastTail(live);
	const plan: RunPlan = { projectId, label: typeof label === 'function' ? label(input) : label, input, trigger, seriesIds };
	if (forecastFrom) plan.forecastRainSource = await forecastRainSource(db, seriesIds.rain_forecast_mm, forecastFrom);
	return plan;
}

/**
 * Where a forecast run's forecast rain came from, for the report's line
 * (engine FORECAST_RAIN_NOTE): 'chirps_gefs' only when a CHIRPS-GEFS data
 * feed wrote every day of the forecast series from the first forecast day to
 * its end (time_series.feed_id + feed_days, 031_feed_days: a person's upload
 * or edit releases the days it covers, so any such day makes it 'other').
 */
export async function forecastRainSource(db: Db, seriesId: string | undefined, from: string): Promise<ForecastRainSource> {
	if (!seriesId) return 'other';
	const { rows } = await db.query<{ gefs: boolean | null }>(
		`SELECT f.source = 'chirps_gefs' AND s.feed_days @> daterange($2::date, s.start_date + cardinality(s."values")) AS gefs
		 FROM time_series s LEFT JOIN data_feed f ON f.project_id = s.project_id AND f.id = s.feed_id
		 WHERE s.id = $1`,
		[seriesId, from]
	);
	return rows[0]?.gefs === true ? 'chirps_gefs' : 'other';
}

/**
 * Run the live model and persist it, all in the caller's transaction.
 * Returns the new run id. The job worker's re-run uses this
 * (jobs/handlers/rerun.ts): a job's writes commit with its `done`
 * (jobs/registry.ts), and the worker's connection serves no request. A
 * request uses runLiveModel, which holds no connection while the engine runs.
 */
export async function executeRun(
	db: Db,
	projectId: string,
	label: string | ((input: ModelInput) => string),
	trigger: RunTrigger = 'manual'
): Promise<{ id: string; output: ModelOutput }> {
	const plan = await prepareRun(db, projectId, label, trigger);
	return storeRun(db, plan, computeRun(plan));
}

/**
 * A model run in two transactions with the engine between them, so no pooled
 * connection (nor any lock or snapshot) is held while it computes
 * (docs/architecture.md § A model run):
 *
 * 1. `prepare`, as `userId` in a READ ONLY REPEATABLE READ transaction: check
 *    the caller may run it and read the plan, from one consistent snapshot;
 * 2. the engine (`compute`), with no transaction open;
 * 3. `commit`, as `userId` in a new transaction: check again that the caller
 *    may run it (a user removed from the project while the engine ran writes
 *    nothing; RLS would refuse the insert anyway, this answers 403/404
 *    first), then store the run and whatever follows (trim, read back).
 *
 * The plan read in 1 is what 3 stores (settings, model, input series), so
 * the run's results always match its stored inputs. The live project may
 * change in between: the run is then a run of the project as it stood when
 * it was read, exactly as reproducible, and "what changed since this run"
 * shows the edit, as it would an edit made a moment after the run. It is not
 * redone: under a steady stream of feed writes a redo could go on for ever,
 * and the new data queues its own re-run anyway. (One transaction had the
 * same gap: nothing locked the inputs, and under READ COMMITTED each of its
 * reads could see a different moment.) A scenario run's commit refuses if
 * the scenario itself changed (scenarios/execute.ts runScenario).
 */
export async function runOutsideTransaction<P extends { run: RunPlan }, T>(
	userId: string,
	prepare: (db: Db) => Promise<P>,
	commit: (db: Db, prepared: P, output: ModelOutput) => Promise<T>,
	compute: ComputeRun = computeRun
): Promise<T> {
	const prepared = await withUser(userId, prepare, { readOnly: true });
	const output = await compute(prepared.run);
	return withUser(userId, (db) => commit(db, prepared, output));
}

/**
 * POST /projects/:id/runs and an import's run: the live model as `userId`,
 * who must be an editor when it is read and again when it is stored
 * (runOutsideTransaction). `then` runs in the storing transaction, after the
 * run is written (the route trims and reads the run back there).
 */
export function runLiveModel<T>(
	userId: string,
	projectId: string,
	label: string,
	trigger: RunTrigger,
	then: (db: Db, run: { id: string; output: ModelOutput }) => Promise<T>,
	compute?: ComputeRun
): Promise<T> {
	return runOutsideTransaction(
		userId,
		async (db) => {
			await requireRole(db, projectId, 'editor');
			return { run: await prepareRun(db, projectId, label, trigger) };
		},
		async (db, { run }, output) => {
			await requireRole(db, projectId, 'editor');
			return then(db, await storeRun(db, run, output));
		},
		compute
	);
}

/**
 * Engine problems (bad inputs, missing series) are the user's to fix: a
 * failed run answers 400 with the engine's message. An ApiError, or a
 * database error (it carries a SQLSTATE `code`; its text never reaches a
 * response), passes through unchanged. For a run route's `.catch`.
 */
export function runFailure(err: Error): never {
	if (err instanceof ApiError || (err as { code?: string }).code) throw err;
	throw new ApiError(400, `model run failed: ${err.message}`);
}

/**
 * Persist a computed run, its outputs and its stored inputs, in the caller's
 * transaction: the one save path, for the live model (executeRun,
 * runLiveModel) and a scenario applied to its base run's input (`scenario`
 * set, scenarios/execute.ts runScenario). Doesn't trim; the caller does.
 *
 * The run's input series are stored too (021_series_blob.sql): each kind's
 * values go to `series_blob` under their SHA-256 (only if the project doesn't
 * hold those exact values already) and `run_input_series` records which blob
 * and start date the run used, so loadRunInput can rebuild the exact input
 * later, whatever happens to the live series, and (for a run of the live
 * model, `plan.seriesIds`) which series it was read from: a manual run's is
 * what the ingest hold takes as a person's accepted values
 * (056_accepted_series, series/hold.ts). Last, the run is stamped
 * (runs/stamp.ts, 077): sign-off and an application's decision take only a
 * run whose stamp still matches its rows.
 */
export async function storeRun(db: Db, plan: RunPlan, output: ModelOutput): Promise<{ id: string; output: ModelOutput }> {
	const { projectId, label, input, scenario, trigger } = plan;
	const opts = { privateLabel: plan.privateLabel };
	const hashes = Object.fromEntries(Object.entries(input.series).map(([k, v]) => [k, seriesHash(v.values)])) as Record<string, string>;
	const snapshot = {
		// The fit record as it stands for these parameters (edits since the
		// fit marked), so the run shows which fit and validation produced them.
		settings: { ...input.settings, fitRecord: resolveFitRecord(input.settings) },
		model: input.model,
		// The values themselves are in series_blob (below), keyed by this hash;
		// the hash also lets "what changed" catch values corrected within the
		// same dates (compare.ts diffSeries).
		series: Object.fromEntries(
			Object.entries(input.series).map(([k, v]) => [
				k,
				{
					startDate: v.startDate,
					length: v.values.length,
					valuesSha256: hashes[k]!,
					// Absent when the input didn't know it (a scenario rerun of a run from before 032).
					...(v.provenance !== undefined ? { provenance: v.provenance } : {}),
					...(v.origin !== undefined ? { origin: v.origin } : {})
				} satisfies SnapshotSeries
			])
		),
		...(scenario ? { scenario } : {}),
		// A forecast run: where its forecast rain came from (the report credits CHIRPS-GEFS only on 'chirps_gefs').
		...(plan.forecastRainSource ? { forecastRainSource: plan.forecastRainSource } : {})
	};
	// The id is made here, not RETURNING'd: RETURNING needs the new row to pass
	// a SELECT policy, and a contributor running their application reads no
	// run row (046_contributor_runs).
	const runId = randomUUID();
	await db.query(
		`INSERT INTO model_run (id, project_id, created_by, label, engine_version, start_date, end_date, inputs, summary, scenario_id, trigger)
		 VALUES ($1, $2, app_current_user_id(), $3, $4, $5, $6, $7, $8, $9, $10)`,
		[runId, projectId, label, output.engineVersion, output.startDate, output.endDate, JSON.stringify(snapshot), JSON.stringify(output.summary), scenario?.id ?? null, trigger]
	);
	// Batch the per-series inserts to keep round-trips low (~150 series per run).
	const BATCH = 25;
	for (let i = 0; i < output.series.length; i += BATCH) {
		const chunk = output.series.slice(i, i + BATCH);
		const params: unknown[] = [runId, projectId];
		const values = chunk.map((s, j) => {
			params.push(s.nodeId, s.key, JSON.stringify({ label: s.label, unit: s.unit }), s.values.map((v) => (Number.isFinite(v) ? v : null)));
			const b = 3 + j * 4;
			return `($1, $2, $${b}::uuid, $${b + 1}, $${b + 2}::jsonb, $${b + 3}::float8[])`;
		});
		await db.query(`INSERT INTO run_series (run_id, project_id, node_id, key, meta, "values") VALUES ${values.join(', ')}`, params);
	}
	await storeRunInputs(db, projectId, runId, input.series, hashes, plan.seriesIds ?? {});
	// Last of the run's rows: sign what was stored (077_run_stamp, runs/stamp.ts),
	// so a run written past this path (a direct insert as water_app) is told apart.
	await stampRun(db, runId);
	// Every way a run is made (POST /runs, the rerun job, an import's run, a scenario run) comes through here.
	await recordAudit(db, projectId, 'run.created', {
		runId,
		// A draft application's run (045_contributor_scope): its label, the
		// application's name by default, stays out of the project's log, which
		// every viewer reads.
		...(opts.privateLabel ? { application: true } : { label }),
		engineVersion: output.engineVersion,
		startDate: output.startDate,
		endDate: output.endDate,
		...(scenario ? { scenarioId: scenario.id } : {}),
		...(trigger !== 'manual' ? { trigger } : {})
	});
	logSelfCheckFailure(projectId, runId, output);
	return { id: runId, output };
}

/**
 * Write a new run's input series: each distinct content once per project
 * (series_blob), then the run's references to it (run_input_series). Last
 * in storeRun, so the project's run lock (taken here, held to commit, the
 * one trimRuns takes next anyway) covers as little of the run as it can.
 */
async function storeRunInputs(
	db: Db,
	projectId: string,
	runId: string,
	series: ModelInput['series'],
	hashes: Record<string, string>,
	seriesIds: InputSeriesIds
): Promise<void> {
	const kinds = Object.keys(series) as SeriesKind[];
	if (kinds.length === 0) return;
	await lockProjectRuns(db, projectId);
	// Most runs reuse every series of the run before, so ship only new values.
	const { rows: held } = await db.query<{ sha256: string }>(`SELECT sha256 FROM series_blob WHERE project_id = $1 AND sha256 = ANY($2::text[])`, [
		projectId,
		[...new Set(Object.values(hashes))]
	]);
	const have = new Set(held.map((r) => r.sha256));
	for (const kind of kinds) {
		const sha = hashes[kind]!;
		if (have.has(sha)) continue;
		have.add(sha);
		// The database keys the blob itself, by the SHA-256 of this very text
		// (seriesDigest, which seriesHash hashes), so no caller can plant other
		// values under a hash a later run uses (074_series_blob_digest).
		const { rows } = await db.query<{ sha: string }>('SELECT app_store_series_blob($1, $2) AS sha', [projectId, seriesDigest(series[kind]!.values)]);
		if (rows[0]!.sha !== sha) throw new Error(`stored run input ${kind} under ${rows[0]!.sha}, expected ${sha}`);
	}
	await db.query(
		`INSERT INTO run_input_series (run_id, project_id, kind, start_date, sha256, series_id)
		 SELECT $1, $2, k, d, h, s FROM unnest($3::text[], $4::date[], $5::text[], $6::uuid[]) AS t(k, d, h, s)`,
		[runId, projectId, kinds, kinds.map((k) => series[k]!.startDate), kinds.map((k) => hashes[k]!), kinds.map((k) => seriesIds[k] ?? null)]
	);
}

/** Why a run's input can't be rebuilt (loadRunInput). */
export type RunInputProblem =
	/** No such run, or not one the user can see. */
	| 'not_found'
	/** Saved before runs stored their input series (021_series_blob.sql): only hashes were kept. */
	| 'not_reproducible'
	/** The stored input disagrees with the run's own snapshot (a missing kind, a start, length or hash mismatch). */
	| 'inconsistent';

export class RunInputError extends Error {
	constructor(
		readonly problem: RunInputProblem,
		message: string
	) {
		super(message);
		this.name = 'RunInputError';
	}
}

/**
 * The exact ModelInput a run used, rebuilt from its snapshot
 * (`model_run.inputs`: settings and model) and its stored input series
 * (`run_input_series` → `series_blob`), so `runModel(await loadRunInput(db,
 * id))` recomputes the run whatever has happened to the live project since.
 * The settings are the snapshot's, with the fit record as the run resolved it
 * (provenance only; the engine never reads it).
 *
 * Runs under the caller's RLS: a run the user can't see is `not_found`, and
 * its blobs are unreadable. Throws RunInputError:
 * - `not_found`: no such run visible to the user;
 * - `not_reproducible`: a run saved before stored inputs (migration 021), which
 *   kept only hashes of its series;
 * - `inconsistent`: a stored series doesn't match the snapshot's start date,
 *   length or SHA-256 (each blob is re-hashed on the way out), or a kind is
 *   missing on either side. Should never happen; if it does the run must not
 *   be presented as reproduced.
 */
export async function loadRunInput(db: Db, runId: string): Promise<ModelInput> {
	const { rows: run } = await db.query<StoredRun>(
		'SELECT created_at, inputs, (SELECT p.time_zone FROM project p WHERE p.id = model_run.project_id) AS time_zone FROM model_run WHERE id = $1',
		[runId]
	);
	if (!run[0]) throw new RunInputError('not_found', 'run not found');
	const { rows: refs } = await db.query<StoredRef>(
		`SELECT i.kind, i.start_date, i.sha256, b."values"
		 FROM run_input_series i LEFT JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
		 WHERE i.run_id = $1`,
		[runId]
	);
	return rebuildRunInput(run[0], refs);
}

/**
 * loadRunInput for a **published** run of the project, read past RLS through
 * app_published_run_input / app_published_run_series (045_contributor_scope):
 * how the server rebuilds the baseline an application applies to, though a
 * contributor can't read the run's row. Answers a contributor or above; a run
 * no publication of the project names (current or in the history) is
 * `not_found`. The same checks as loadRunInput. The input is for the server
 * only: never return it to a contributor (scenarios/applicant.ts projects
 * what they may see of it).
 */
export async function loadPublishedRunInput(db: Db, projectId: string, runId: string): Promise<{ input: ModelInput; trigger: RunTrigger }> {
	const { rows: run } = await db.query<StoredRun & { trigger: RunTrigger }>(
		'SELECT created_at, inputs, "trigger", (SELECT p.time_zone FROM project p WHERE p.id = $1) AS time_zone FROM app_published_run_input($1, $2)',
		[projectId, runId]
	);
	if (!run[0]) throw new RunInputError('not_found', 'run not found');
	const { rows: refs } = await db.query<StoredRef>('SELECT kind, start_date, sha256, "values" FROM app_published_run_series($1, $2)', [projectId, runId]);
	return { input: rebuildRunInput(run[0], refs), trigger: run[0].trigger };
}

interface StoredRun {
	created_at: Date;
	/** The project's (058): the run's date in a message is the day there. */
	time_zone: string | null;
	inputs: { settings: ModelInput['settings']; model: ModelInput['model']; series?: Record<string, SnapshotSeries> };
}
interface StoredRef {
	kind: string;
	start_date: string;
	sha256: string;
	values: (number | null)[] | null;
}

/** A run's input from its snapshot and its stored series, checked against each other (loadRunInput's rules). */
function rebuildRunInput(r: StoredRun, refs: StoredRef[]): ModelInput {
	const snap = r.inputs.series ?? {};
	const kinds = Object.keys(snap);
	if (refs.length === 0 && kinds.length > 0) {
		throw new RunInputError(
			'not_reproducible',
			`this run is not reproducible from stored inputs: it was made on ${localDate(r.created_at, r.time_zone ?? DEFAULT_TIME_ZONE)}, before runs stored their input series (only hashes of them were kept)`
		);
	}
	const byKind = new Map(refs.map((x) => [x.kind, x]));
	const series: Partial<Record<SeriesKind, DailySeries>> = {};
	for (const kind of kinds) {
		const want = snap[kind]!;
		const got = byKind.get(kind);
		const bad = (why: string) => new RunInputError('inconsistent', `the stored ${kind} series of this run ${why}`);
		if (!got || got.values === null) throw bad('is missing');
		if (got.start_date !== want.startDate) throw bad(`starts on ${got.start_date}, not ${want.startDate} as the run recorded`);
		if (got.values.length !== want.length) throw bad(`has ${got.values.length} days, not ${want.length} as the run recorded`);
		if (got.sha256 !== want.valuesSha256 || seriesHash(got.values) !== got.sha256) throw bad('fails its SHA-256 check');
		series[kind as SeriesKind] = {
			startDate: got.start_date,
			values: got.values,
			...(want.provenance !== undefined ? { provenance: want.provenance } : {}),
			...(want.origin !== undefined ? { origin: want.origin } : {})
		};
	}
	const extra = refs.find((x) => !(x.kind in snap));
	if (extra) throw new RunInputError('inconsistent', `the run stored a ${extra.kind} series its snapshot doesn't list`);
	return { settings: r.inputs.settings, model: r.inputs.model, series };
}
