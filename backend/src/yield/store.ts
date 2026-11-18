// Firm yield and storage–yield curves (roadmap WP-3.6, docs/api.md § Yield,
// 040_yield.sql): the request's shape, the input a yield runs on, and the
// stored results.
import { createHash } from 'node:crypto';
import type { ModelInput, StorageYieldCurve, YieldPoint } from '@water-management/engine';
import { canonicalJson, damInflowRoutes, irrigationDemandUnits, prepareYield, type DamInflowRoutes } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { JOB_META, type JobMeta } from '../jobs/queue.js';
import { rank, type Role } from '../projects/access.js';
import { loadRunInput, RunInputError } from '../runs/execute.js';
import { checkScenario, loadBaseInput, loadScenario } from '../scenarios/execute.js';

const Uuid = z.string().uuid();

/** Most queued or running yield jobs one user may have across all projects' (WP-3.6: 2). */
export const YIELD_JOBS_PER_USER = 2;
/** Results kept per run or scenario and dam; the job deletes older ones. */
export const YIELD_RESULTS_KEPT = 5;

export const YieldParams = z
	.object({
		/** 'constant', 'demand' (the node's own demand shape) or 12 factors, Oct–Sep. */
		pattern: z.union([z.enum(['constant', 'demand']), z.array(z.number().finite().min(0).max(1e6)).length(12)]).default('constant'),
		/**
		 * With pattern 'demand': the hydrological unit whose irrigation demand shapes the draft (engine ≥ 1.117.0).
		 * Absent: the dam's own unit, as every request before it. Checked against the model (checkPatternNode).
		 */
		patternNodeId: Uuid.optional(),
		/** 0.5–1; 1 = the firm yield. */
		assurance: z.number().min(0.5).max(1).default(1),
		/** Relative tolerance of the bisection. */
		tolerance: z.number().min(1e-5).max(0.05).default(0.001),
		/** Curve points, 8–12 (WP-3.6). */
		points: z.number().int().min(8).max(12).default(11),
		/**
		 * A curve's largest capacity, m³ (engine ≥ 1.117.0: sizing a proposed dam). Absent: twice the dam's own,
		 * as every curve before it; required for a unit with no dam (checkYieldNode).
		 */
		maxCapacityM3: z.number().finite().positive().max(1e12).optional()
	})
	.strict();
export type YieldParams = z.infer<typeof YieldParams>;

export const YieldRequest = z
	.object({
		nodeId: Uuid,
		runId: Uuid.optional(),
		scenarioId: Uuid.optional(),
		kind: z.enum(['firm', 'curve']),
		params: YieldParams.prefault({})
	})
	.strict()
	.superRefine((b, ctx) => {
		// What it runs on: a saved run, or a scenario (its ops on its base run).
		if (!b.runId === !b.scenarioId) ctx.addIssue({ code: 'custom', message: 'give exactly one of runId and scenarioId' });
		if (b.params.patternNodeId !== undefined && b.params.pattern !== 'demand')
			ctx.addIssue({ code: 'custom', path: ['params', 'patternNodeId'], message: "patternNodeId goes with the 'demand' pattern only" });
		if (b.params.maxCapacityM3 !== undefined && b.kind !== 'curve')
			ctx.addIssue({ code: 'custom', path: ['params', 'maxCapacityM3'], message: 'maxCapacityM3 goes with a storage–yield curve only' });
	});

/**
 * The request as stored and keyed: a patternNodeId naming the dam's own unit
 * is dropped, so it is the same request (and the same label) as one without.
 */
export function canonicalYieldRequest(r: YieldRequest): YieldRequest {
	if (r.params.patternNodeId !== r.nodeId) return r;
	const { patternNodeId: _own, ...params } = r.params;
	return { ...r, params };
}
export type YieldRequest = z.infer<typeof YieldRequest>;

/** The job's payload: the request as validated. */
export const YieldPayload = YieldRequest;

/**
 * `yield:<run|scenario id>:<node>:<params hash>`: one pending job per identical
 * request. A contributor's (an applicant's) ends `:<their user id>`: they see
 * only their own jobs (096 job_select_contributor), so another's pending job
 * with the same key, such as an assessor's on their submitted application,
 * can't stand for theirs; without it their enqueue collided with a job it
 * couldn't read (a 500).
 */
export function yieldDedupeKey(r: YieldRequest, contributorId?: string): string {
	const hash = createHash('sha256').update(canonicalJson({ kind: r.kind, params: r.params })).digest('hex').slice(0, 16);
	return `yield:${r.runId ?? r.scenarioId}:${r.nodeId}:${hash}${contributorId ? `:${contributorId}` : ''}`;
}

/**
 * The model input the yield runs on, under the caller's RLS: a run's stored
 * input, or a scenario's ops applied to its base run's (refused when an op
 * doesn't apply, as a scenario run is). A run or scenario of another project,
 * or one the caller can't see, is 404. A forecast run is 409 (issue #51): its
 * input runs on past the record on forecast rain (WP-2.12), and a firm yield
 * is a historical figure, so it is judged on history, as sweeps and
 * scenarios are (a scenario's base is refused the same way, loadBaseInput).
 */
export async function yieldInput(db: Db, projectId: string, r: Pick<YieldRequest, 'runId' | 'scenarioId'>): Promise<{ input: ModelInput; opsSha256: string | null }> {
	if (r.scenarioId) {
		const scenario = await loadScenario(db, projectId, r.scenarioId);
		const check = checkScenario(await loadBaseInput(db, projectId, scenario.baseRunId), scenario);
		if (check.problems.length) throw new ApiError(422, "an op of this scenario doesn't apply to its base run", { problems: check.problems });
		return { input: check.input, opsSha256: scenario.opsSha256 };
	}
	const { rows } = await db.query<{ trigger: string }>('SELECT "trigger" FROM model_run WHERE project_id = $1 AND id = $2', [projectId, r.runId]);
	if (!rows[0]) throw new ApiError(404, 'run not found');
	if (rows[0].trigger === 'forecast') throw new ApiError(409, 'that run is a forecast run; a yield is judged on history, so use an ordinary run of the model');
	try {
		return { input: await loadRunInput(db, r.runId!), opsSha256: null };
	} catch (err) {
		if (err instanceof RunInputError) throw new ApiError(err.problem === 'not_found' ? 404 : 409, err.problem === 'not_found' ? 'run not found' : err.message);
		throw err;
	}
}

/**
 * The input a yield runs on, for this user in this role (096_contributor_yield):
 * an editor's is yieldInput's, on any run or scenario. A contributor (an
 * applicant, WP-3.3) calculates only on an application they own, and only a
 * dam of it they may see: their own farm (the application's own nodes) or a
 * node its own `node.add` ops add. An added node that took a hidden node's id
 * (the engine's `reIds`) is refused with the words an unknown id gets, so the
 * answer never tells a hidden id from a free one. Anyone else is 403.
 * Checks the node too (checkYieldNode). Used by the route and, as the acting
 * user, by the job handler, so a job dies once its applicant loses the role.
 */
export async function yieldInputFor(db: Db, projectId: string, role: Role, userId: string, r: YieldRequest): Promise<{ input: ModelInput; opsSha256: string | null }> {
	const { input, opsSha256 } = await yieldTargetFor(db, projectId, role, userId, r);
	return { input, opsSha256 };
}

/**
 * yieldInputFor's input, and the units this user may see in it: null for
 * an editor, or a viewer with `read` (the whole model), else a contributor's own
 * farm and the nodes their ops add. Checks the dam (checkYieldNode) and the
 * unit shaping the draft (checkPatternNode) against them.
 */
export async function yieldTargetFor(
	db: Db,
	projectId: string,
	role: Role,
	userId: string,
	r: Pick<YieldRequest, 'nodeId' | 'runId' | 'scenarioId'> & { kind: YieldRequest['kind'] | null; params?: Pick<YieldParams, 'patternNodeId' | 'maxCapacityM3'> },
	opts: { read?: boolean } = {}
): Promise<{ input: ModelInput; visible: Set<string> | null; opsSha256: string | null }> {
	// `read`: only reading the model's units (GET …/yield/patterns), which a viewer may, as they may preview a yield.
	if (rank[role] >= rank.editor || (opts.read && rank[role] >= rank.viewer)) {
		const { input, opsSha256 } = await yieldInput(db, projectId, r);
		checkYieldNode(input, r.nodeId, r.kind, r.params?.maxCapacityM3);
		checkPatternNode(input, r.params?.patternNodeId, null);
		return { input, visible: null, opsSha256 };
	}
	if (role !== 'contributor') throw new ApiError(403, 'requires editor role');
	if (!r.scenarioId) throw new ApiError(403, "an applicant calculates yields on their own application, not on a saved run");
	const scenario = await loadScenario(db, projectId, r.scenarioId);
	if (scenario.origin !== 'applicant' || scenario.ownerUserId !== userId) throw new ApiError(403, "only the application's owner calculates its yields");
	const base = await loadBaseInput(db, projectId, scenario.baseRunId, 'contributor');
	const check = checkScenario(base, scenario);
	if (check.problems.length) throw new ApiError(422, "an op of this scenario doesn't apply to its base run", { problems: check.problems });
	const baseIds = new Set(base.model.nodes.map((n) => n.id));
	const added = scenario.ops.flatMap((o) => ((o.op === 'node.add' || o.op === 'node.insert') && !baseIds.has(o.node.id) ? [o.node.id] : []));
	const visible = new Set([...scenario.ownedNodeIds, ...added]);
	if (!visible.has(r.nodeId)) throw new ApiError(400, 'that hydrological unit is not in this run or scenario');
	checkYieldNode(check.input, r.nodeId, r.kind, r.params?.maxCapacityM3);
	checkPatternNode(check.input, r.params?.patternNodeId, visible);
	return { input: check.input, visible, opsSha256: scenario.opsSha256 };
}

/**
 * A dam node of the input, or 400 with why not. A unit with no dam in this
 * model (capacity 0) has no yield of its own to work out: a firm yield is
 * 400 yield_no_dam, and so is a storage–yield curve unless it is sizing a
 * proposed dam to an entered largest capacity (`maxCapacityM3`). A dam
 * that receives no water in this model (no runoff or upstream share routed
 * into it, no River to dam, no transfer in: damInflowRoutes) yields 0 at any
 * size, so both are 400 yield_no_inflow. `kind` null: only the node (the
 * Yield panel's options).
 */
export function checkYieldNode(input: ModelInput, nodeId: string, kind: 'firm' | 'curve' | null, maxCapacityM3?: number): void {
	const n = input.model.nodes.find((x) => x.id === nodeId);
	if (!n) throw new ApiError(400, 'that hydrological unit is not in this run or scenario');
	if (n.kind !== 'farm') throw new ApiError(400, 'a yield is for a hydrological unit with land (a unit or its dam), not a gauge or other water user');
	if (kind === null) return;
	if (n.damCapacityM3 > 0) return checkInflow(input, n.id);
	if (kind === 'firm')
		throw ApiError.coded(400, 'yield_no_dam', 'this hydrological unit has no dam in this run or scenario (capacity 0 m³): set its dam capacity in a scenario first, or size one with a storage–yield curve to a largest capacity');
	if (maxCapacityM3 === undefined)
		throw ApiError.coded(400, 'yield_no_dam', 'a storage–yield curve of a unit with no dam (capacity 0 m³) needs the largest capacity to size it to (params.maxCapacityM3)');
	checkInflow(input, n.id);
}

/** 400 yield_no_inflow for a dam nothing routes water into (damInflowRoutes). */
function checkInflow(input: ModelInput, nodeId: string): void {
	if (damInflowRoutes(input, nodeId).receives) return;
	throw ApiError.coded(
		400,
		'yield_no_inflow',
		"this hydrological unit's dam receives no water in this run or scenario (Runoff to dam and Upstream inflow to dam are 0 %, with no River to dam or transfer into it), so its yield is 0 at any size: set the share of its runoff, or of the river above it, that the dam catches"
	);
}

/**
 * The unit a 'demand' draft takes its shape from, when it isn't the dam's
 * own: a hydrological unit (land) of this run's or scenario's model that the
 * caller may see (`visible`; null = all), else 400 yield_pattern_unit. A unit
 * hidden from an applicant gets the words an unknown id gets. Whether it has
 * irrigation demand needs the model built (checkPatternDemand).
 */
export function checkPatternNode(input: ModelInput, patternNodeId: string | undefined, visible: Set<string> | null): void {
	if (patternNodeId === undefined) return;
	const n = input.model.nodes.find((x) => x.id === patternNodeId);
	if (!n || n.kind !== 'farm' || (visible && !visible.has(n.id)))
		throw ApiError.coded(400, 'yield_pattern_unit', 'the unit chosen to shape the draft is not a hydrological unit of this run or scenario');
}

export interface PatternUnit {
	nodeId: string;
	name: string;
	/** It has irrigation demand to shape a draft. */
	demand: boolean;
}

/** What the Yield panel offers for one dam (GET …/yield/options): its dam in this model, and the units that can shape its draft. */
export interface YieldOptionsRow {
	/** The dam's capacity in this run's or scenario's model, m³; 0 = no dam (a firm yield is refused, a curve needs a largest capacity). */
	damCapacityM3: number;
	/** What can bring water into the dam (damInflowRoutes): none, and its yield is 0 at any size (a yield is refused, 400 yield_no_inflow). */
	inflow: DamInflowRoutes;
	units: PatternUnit[];
}

export function yieldOptions(input: ModelInput, nodeId: string, visible: Set<string> | null): YieldOptionsRow {
	const n = input.model.nodes.find((x) => x.id === nodeId)!;
	return { damCapacityM3: n.damCapacityM3, inflow: damInflowRoutes(input, nodeId), units: patternUnits(input, visible) };
}

/**
 * The hydrological units of the input, in the model's node order, with
 * whether each has irrigation demand to shape a draft (the engine's
 * irrigationDemandUnits, on the same model the job runs). `visible`: only
 * these (a contributor's). 422 when the model can't run the input, in the
 * engine's words.
 */
export function patternUnits(input: ModelInput, visible: Set<string> | null): PatternUnit[] {
	let withDemand: Set<string>;
	try {
		withDemand = new Set(irrigationDemandUnits(prepareYield(input)));
	} catch (err) {
		throw new ApiError(422, `the model can't run this input: ${(err as Error).message}`);
	}
	return input.model.nodes.filter((n) => n.kind === 'farm' && (!visible || visible.has(n.id))).map((n) => ({ nodeId: n.id, name: n.name, demand: withDemand.has(n.id) }));
}

/** 400 yield_pattern_unit when the unit chosen to shape the draft has no irrigation demand in this model. */
export function checkPatternDemand(input: ModelInput, patternNodeId: string | undefined, visible: Set<string> | null): void {
	if (patternNodeId === undefined) return;
	if (!patternUnits(input, visible).some((u) => u.nodeId === patternNodeId && u.demand))
		throw ApiError.coded(400, 'yield_pattern_unit', 'the unit chosen to shape the draft has no irrigation demand in this run or scenario; choose another unit or a constant pattern');
}

/** What yield_result.points holds. */
export type YieldPoints = { point: YieldPoint } | Omit<StorageYieldCurve, 'nodeId'>;

export interface YieldResultRow {
	id: string;
	runId: string | null;
	scenarioId: string | null;
	nodeId: string;
	jobId: string | null;
	kind: 'firm' | 'curve';
	/** `patternNodeName`: the name the unit shaping the draft had when the job ran (with patternNodeId; the job adds it). */
	params: YieldParams & { patternNodeName?: string };
	points: YieldPoints;
	engineVersion: string;
	/** A scenario's yield: the scenario's ops_sha256 when the job ran (320); null on a run, or before 320. */
	opsSha256: string | null;
	createdBy: string | null;
	createdAt: string;
}

const SELECT = `SELECT y.id, y.run_id AS "runId", y.scenario_id AS "scenarioId", y.node_id AS "nodeId", y.job_id AS "jobId",
	y.kind, y.params, y.points, y.engine_version AS "engineVersion", y.ops_sha256 AS "opsSha256", u.display_name AS "createdBy", y.created_at AS "createdAt"
	FROM yield_result y LEFT JOIN app_user u ON u.id = y.created_by`;

/** A run's or scenario's results, newest first, optionally for one node or one job (RLS: viewer). */
export async function listYieldResults(
	db: Db,
	projectId: string,
	q: { runId?: string; scenarioId?: string; nodeId?: string; jobId?: string }
): Promise<YieldResultRow[]> {
	const { rows } = await db.query<YieldResultRow>(
		`${SELECT}
		 WHERE y.project_id = $1
		   AND ($2::uuid IS NULL OR y.run_id = $2) AND ($3::uuid IS NULL OR y.scenario_id = $3)
		   AND ($4::uuid IS NULL OR y.node_id = $4) AND ($5::uuid IS NULL OR y.job_id = $5)
		 ORDER BY y.created_at DESC, y.id DESC LIMIT 50`,
		[projectId, q.runId ?? null, q.scenarioId ?? null, q.nodeId ?? null, q.jobId ?? null]
	);
	return rows;
}

/**
 * The results among `ids` computed on a run that caps use at, or scales
 * demand to, the registered volumes (#523 I): the mode the yield recorded it
 * ran with (221, #523 G1c), never the scenario's current state. A result from
 * before 221 (NULL) is judged conservatively: one on a run by the run's own
 * mode (its input never changes), one on a scenario counts as capped.
 */
export async function yieldsOnCapOrFull(db: Db, ids: readonly string[]): Promise<string[]> {
	const { rows } = await db.query<{ id: string }>(
		`SELECT y.id FROM yield_result y
		 LEFT JOIN model_run r ON r.id = y.run_id
		 WHERE y.id = ANY($1::uuid[])
		   AND (y.allocation_mode IN ('cap', 'fullAllocation')
			OR (y.allocation_mode IS NULL AND (y.scenario_id IS NOT NULL
				OR r.summary->'allocations'->>'mode' IN ('cap', 'fullAllocation'))))`,
		[ids]
	);
	return rows.map((r) => r.id);
}

/** A pending yield job with what it is for, read from its payload (the validated YieldRequest). */
export interface YieldJob extends JobMeta {
	target: { nodeId: string; runId: string | null; scenarioId: string | null; kind: 'firm' | 'curve'; params: YieldParams };
}

/**
 * A dam's pending yield jobs (queued, running, or failed and waiting to
 * retry), newest first, by anyone, optionally on one run or scenario (RLS:
 * viewer). So the Yield panel can follow a job it didn't queue itself: after
 * a reload, or one started in another tab or by a colleague.
 */
export async function listPendingYieldJobs(
	db: Db,
	projectId: string,
	q: { nodeId: string; runId?: string; scenarioId?: string }
): Promise<YieldJob[]> {
	const { rows } = await db.query<YieldJob>(
		`SELECT ${JOB_META},
			jsonb_build_object('nodeId', j.payload->'nodeId', 'runId', j.payload->'runId', 'scenarioId', j.payload->'scenarioId',
				'kind', j.payload->'kind', 'params', j.payload->'params') AS target
		 FROM job j JOIN app_user u ON u.id = j.acting_user_id
		 WHERE j.project_id = $1 AND j.kind = 'yield' AND j.status IN ('queued', 'running', 'failed')
		   AND j.payload->>'nodeId' = $2::text
		   AND ($3::text IS NULL OR j.payload->>'runId' = $3) AND ($4::text IS NULL OR j.payload->>'scenarioId' = $4)
		 ORDER BY j.created_at DESC, j.id DESC LIMIT 20`,
		[projectId, q.nodeId, q.runId ?? null, q.scenarioId ?? null]
	);
	// jsonb_build_object keeps a missing key as JSON null.
	return rows.map((r) => ({ ...r, target: { ...r.target, runId: r.target.runId ?? null, scenarioId: r.target.scenarioId ?? null } }));
}

/** Queued or running yield jobs the user has, in any project they can still see. */
export async function pendingYieldJobs(db: Db): Promise<number> {
	// Count and enqueue one request at a time per user (the lock is held to
	// commit), so a burst of requests can't all pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('yield_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job WHERE kind = 'yield' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	return rows[0]?.n ?? 0;
}
