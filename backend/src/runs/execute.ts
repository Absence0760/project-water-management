import { createHash } from 'node:crypto';
import {
	resolveFitRecord,
	runModelChecked,
	seriesDigest,
	type DailySeries,
	type ModelInput,
	type ModelOutput,
	type OpClass,
	type RunVerification,
	type ScenarioOp,
	type SeriesKind,
	type SeriesProvenance
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { loadModel } from '../model/store.js';
import { mergeSettings } from '../projects/settings.js';

/**
 * SHA-256 hex of a series' values (engine `seriesDigest`: the values as JSON,
 * null = missing day), stored in the run's input snapshot as `valuesSha256`
 * and the key of the values' `series_blob` (021_series_blob.sql).
 */
export const seriesHash = (values: readonly (number | null)[]): string => createHash('sha256').update(seriesDigest(values)).digest('hex');

/** Gather everything the engine needs for a project. */
export async function loadModelInput(db: Db, projectId: string): Promise<ModelInput> {
	const { rows: p } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const model = await loadModel(db, projectId);
	// First series of each kind (ordered by name) — the engine takes one per kind.
	const { rows: s } = await db.query<{ kind: SeriesKind; start_date: string; values: (number | null)[]; product: string | null; product_version: string | null }>(
		`SELECT DISTINCT ON (kind) kind, start_date, "values", product, product_version FROM time_series WHERE project_id = $1 ORDER BY kind, name`,
		[projectId]
	);
	const series: Partial<Record<SeriesKind, DailySeries>> = {};
	for (const r of s) {
		// The product and version (032_series_provenance.sql) ride along for the run's snapshot; the model ignores them.
		const provenance = r.product !== null && r.product_version !== null ? { product: r.product, version: r.product_version } : null;
		series[r.kind] = { startDate: r.start_date, values: r.values, provenance };
	}
	return { settings: mergeSettings(p[0]?.settings) as unknown as ModelInput['settings'], model, series };
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
	console.error(JSON.stringify({ event: 'self_check_failed', projectId, runId, checks }));
}

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
 * `app_run_kept` (036_contributor_scope.sql) is the same rule as a SECURITY
 * DEFINER function, for the contributor's delete policy on their own
 * application runs (a contributor can't read run_nomination): change both
 * together.
 */
export const RUN_KEPT_SQL = `(r.pinned OR EXISTS (SELECT 1 FROM run_nomination n WHERE n.run_id = r.id) OR model_run_cited(r.id))`;

/**
 * What cites a run, as a SQL expression over `model_run r`: a jsonb list of
 * `{ kind, id, name }`, oldest first, of the citations the caller can see
 * (RLS): publications (022_publication.sql; `name` is the day it was
 * published, YYYY-MM-DD) and scenarios (024_scenarios.sql). Evidence packs and
 * assessments add their kinds here with their migrations. `model_run_cited`
 * answers "is it cited at all", including citations the caller can't see.
 */
export const CITED_BY_SQL = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', c.kind, 'id', c.id, 'name', c.name) ORDER BY c.at, c.id), '[]'::jsonb) FROM (
		SELECT 'publication' AS kind, p.id, to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS name, p.published_at AS at FROM run_publication p WHERE p.run_id = r.id
		UNION ALL
		SELECT 'scenario', s.id, s.name, s.created_at FROM scenario s WHERE s.base_run_id = r.id
	) c)`;

/** One citation of a run (RunMeta.citedBy). For a publication, `name` is the day it was published (YYYY-MM-DD, UTC). */
export interface RunCitation {
	kind: 'publication' | 'scenario';
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
	const names = cited.slice(0, 3).map((c) => (c.kind === 'publication' ? `the publication of ${c.name}` : `${c.kind} "${c.name}"`));
	const more = cited.length > 3 ? ` and ${cited.length - 3} more` : '';
	return `this run is cited by ${names.join(', ')}${more}, ${tail}`;
}

/**
 * Serialise the project's run writes and removals to the end of the caller's
 * transaction: trimRuns, the run DELETE route and executeRun's stored inputs
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
 * newest `keep` runs that are neither.
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
			SELECT r.id FROM model_run r
			WHERE r.project_id = $1 AND NOT ${RUN_KEPT_SQL}
			ORDER BY r.created_at DESC, r.id DESC OFFSET $2
		) RETURNING id`,
		[projectId, keep]
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

/**
 * Run the live model and persist it. Returns the new run id.
 *
 * The run's input series are stored too (021_series_blob.sql): each kind's
 * values go to `series_blob` under their SHA-256 (only if the project doesn't
 * hold those exact values already) and `run_input_series` records which blob
 * and start date the run used, so loadRunInput can rebuild the exact input
 * later, whatever happens to the live series.
 */
export async function executeRun(db: Db, projectId: string, label: string): Promise<{ id: string; output: ModelOutput }> {
	return runAndStore(db, projectId, label, await loadModelInput(db, projectId));
}

/**
 * Run the engine on `input` and persist the run, its outputs and its stored
 * inputs: the one save path, shared by executeRun (the live model) and
 * executeScenarioRun (a scenario applied to its base run's input, with
 * `scenario` set, scenarios/execute.ts). Doesn't trim; the caller does.
 */
export async function runAndStore(
	db: Db,
	projectId: string,
	label: string,
	input: ModelInput,
	scenario?: RunScenarioSnapshot,
	opts: { privateLabel?: boolean } = {}
): Promise<{ id: string; output: ModelOutput }> {
	// The engine's self-checks and water balance are stored with the run (engine ≥ 0.12.0).
	const output = runModelChecked(input);
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
					...(v.provenance !== undefined ? { provenance: v.provenance } : {})
				} satisfies SnapshotSeries
			])
		),
		...(scenario ? { scenario } : {})
	};
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, summary, scenario_id)
		 VALUES ($1, app_current_user_id(), $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		[projectId, label, output.engineVersion, output.startDate, output.endDate, JSON.stringify(snapshot), JSON.stringify(output.summary), scenario?.id ?? null]
	);
	const runId = rows[0]!.id;
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
	await storeRunInputs(db, projectId, runId, input.series, hashes);
	// Every way a run is made (POST /runs, the rerun job, an import's run, a scenario run) comes through here.
	await recordAudit(db, projectId, 'run.created', {
		runId,
		// A draft application's run (036_contributor_scope): its label, the
		// application's name by default, stays out of the project's log, which
		// every viewer reads.
		...(opts.privateLabel ? { application: true } : { label }),
		engineVersion: output.engineVersion,
		startDate: output.startDate,
		endDate: output.endDate,
		...(scenario ? { scenarioId: scenario.id } : {})
	});
	logSelfCheckFailure(projectId, runId, output);
	return { id: runId, output };
}

/**
 * Write a new run's input series: each distinct content once per project
 * (series_blob), then the run's references to it (run_input_series). Last
 * in executeRun, so the project's run lock (taken here, held to commit, the
 * one trimRuns takes next anyway) covers as little of the run as it can.
 */
async function storeRunInputs(
	db: Db,
	projectId: string,
	runId: string,
	series: ModelInput['series'],
	hashes: Record<string, string>
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
		await db.query(`INSERT INTO series_blob (project_id, sha256, "values") VALUES ($1, $2, $3::float8[]) ON CONFLICT DO NOTHING`, [
			projectId,
			sha,
			series[kind]!.values
		]);
	}
	await db.query(
		`INSERT INTO run_input_series (run_id, project_id, kind, start_date, sha256)
		 SELECT $1, $2, k, d, h FROM unnest($3::text[], $4::date[], $5::text[]) AS t(k, d, h)`,
		[runId, projectId, kinds, kinds.map((k) => series[k]!.startDate), kinds.map((k) => hashes[k]!)]
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
	const { rows: run } = await db.query<StoredRun>('SELECT created_at, inputs FROM model_run WHERE id = $1', [runId]);
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
 * app_published_run_input / app_published_run_series (036_contributor_scope):
 * how the server rebuilds the baseline an application applies to, though a
 * contributor can't read the run's row. Answers a contributor or above; a run
 * no publication of the project names (current or in the history) is
 * `not_found`. The same checks as loadRunInput. The input is for the server
 * only: never return it to a contributor (scenarios/applicant.ts projects
 * what they may see of it).
 */
export async function loadPublishedRunInput(db: Db, projectId: string, runId: string): Promise<ModelInput> {
	const { rows: run } = await db.query<StoredRun>('SELECT created_at, inputs FROM app_published_run_input($1, $2)', [projectId, runId]);
	if (!run[0]) throw new RunInputError('not_found', 'run not found');
	const { rows: refs } = await db.query<StoredRef>('SELECT kind, start_date, sha256, "values" FROM app_published_run_series($1, $2)', [projectId, runId]);
	return rebuildRunInput(run[0], refs);
}

interface StoredRun {
	created_at: Date;
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
			`this run is not reproducible from stored inputs: it was made on ${r.created_at.toISOString().slice(0, 10)}, before runs stored their input series (only hashes of them were kept)`
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
		series[kind as SeriesKind] = { startDate: got.start_date, values: got.values, ...(want.provenance !== undefined ? { provenance: want.provenance } : {}) };
	}
	const extra = refs.find((x) => !(x.kind in snap));
	if (extra) throw new RunInputError('inconsistent', `the run stored a ${extra.kind} series its snapshot doesn't list`);
	return { settings: r.inputs.settings, model: r.inputs.model, series };
}
