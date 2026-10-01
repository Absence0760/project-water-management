// Firm yield and storage–yield curves (roadmap WP-3.6, docs/api.md § Yield,
// 040_yield.sql): the request's shape, the input a yield runs on, and the
// stored results.
import { createHash } from 'node:crypto';
import type { ModelInput, StorageYieldCurve, YieldPoint } from '@water-management/engine';
import { canonicalJson } from '@water-management/engine';
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
		/** 0.5–1; 1 = the firm yield. */
		assurance: z.number().min(0.5).max(1).default(1),
		/** Relative tolerance of the bisection. */
		tolerance: z.number().min(1e-5).max(0.05).default(0.001),
		/** Curve points, 8–12 (WP-3.6). */
		points: z.number().int().min(8).max(12).default(11)
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
	});
export type YieldRequest = z.infer<typeof YieldRequest>;

/** The job's payload: the request as validated. */
export const YieldPayload = YieldRequest;

/** `yield:<run|scenario id>:<node>:<params hash>`: one pending job per identical request. */
export function yieldDedupeKey(r: YieldRequest): string {
	const hash = createHash('sha256').update(canonicalJson({ kind: r.kind, params: r.params })).digest('hex').slice(0, 16);
	return `yield:${r.runId ?? r.scenarioId}:${r.nodeId}:${hash}`;
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
export async function yieldInput(db: Db, projectId: string, r: Pick<YieldRequest, 'runId' | 'scenarioId'>): Promise<ModelInput> {
	if (r.scenarioId) {
		const scenario = await loadScenario(db, projectId, r.scenarioId);
		const check = checkScenario(await loadBaseInput(db, projectId, scenario.baseRunId), scenario);
		if (check.problems.length) throw new ApiError(422, "an op of this scenario doesn't apply to its base run", { problems: check.problems });
		return check.input;
	}
	const { rows } = await db.query<{ trigger: string }>('SELECT "trigger" FROM model_run WHERE project_id = $1 AND id = $2', [projectId, r.runId]);
	if (!rows[0]) throw new ApiError(404, 'run not found');
	if (rows[0].trigger === 'forecast') throw new ApiError(409, 'that run is a forecast run; a yield is judged on history, so use an ordinary run of the model');
	try {
		return await loadRunInput(db, r.runId!);
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
export async function yieldInputFor(db: Db, projectId: string, role: Role, userId: string, r: YieldRequest): Promise<ModelInput> {
	if (rank[role] >= rank.editor) {
		const input = await yieldInput(db, projectId, r);
		checkYieldNode(input, r.nodeId, r.kind);
		return input;
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
	if (!scenario.ownedNodeIds.includes(r.nodeId) && !added.includes(r.nodeId)) throw new ApiError(400, 'that node is not in this run or scenario');
	checkYieldNode(check.input, r.nodeId, r.kind);
	return check.input;
}

/** A dam node of the input, or 400 with why not. */
export function checkYieldNode(input: ModelInput, nodeId: string, kind: 'firm' | 'curve'): void {
	const n = input.model.nodes.find((x) => x.id === nodeId);
	if (!n) throw new ApiError(400, 'that node is not in this run or scenario');
	if (n.kind !== 'farm') throw new ApiError(400, 'a yield is for a unit or dam node, not a gauge or other water user');
	if (kind === 'curve' && !(n.damCapacityM3 > 0)) throw new ApiError(400, 'a storage–yield curve needs a dam with a capacity above 0');
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
	params: YieldParams;
	points: YieldPoints;
	engineVersion: string;
	createdBy: string | null;
	createdAt: string;
}

const SELECT = `SELECT y.id, y.run_id AS "runId", y.scenario_id AS "scenarioId", y.node_id AS "nodeId", y.job_id AS "jobId",
	y.kind, y.params, y.points, y.engine_version AS "engineVersion", u.display_name AS "createdBy", y.created_at AS "createdAt"
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
