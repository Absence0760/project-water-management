// § 8 Future yield (issue #621 slice 4; docs/api.md § Future yield,
// docs/evidence-pack.md § Future yield, 280_future_yield): the switch, the
// request, the pair it runs on, and the stored results.
import { futureDamError, type FutureYieldResult, type ModelInput } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import type { Geometry } from '../geo/geojson.js';
import { loadRunInput, RunInputError } from '../runs/execute.js';
import { climateCells, type ClimateGridCell } from './cells.js';

/** FUTURE_YIELD: `on` runs § 8 and puts it in application reports; `off` (the default) leaves both out (deployment.md). */
export const FUTURE_YIELD_VALUES = ['on', 'off'] as const;
export function futureYieldEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const v = env.FUTURE_YIELD?.trim() || 'off';
	if (!(FUTURE_YIELD_VALUES as readonly string[]).includes(v)) throw new Error(`unknown FUTURE_YIELD "${v}" (expected on or off)`);
	return v === 'on';
}

/** Most future yield jobs one user may have queued or running at once (each is some 40 runs). */
export const FUTURE_YIELD_JOBS_PER_USER = 1;
/** Results kept per pair; the job deletes older ones. */
export const FUTURE_YIELD_RESULTS_KEPT = 3;

export const FutureYieldRequest = z.object({ nodeId: z.string().uuid().optional() }).strict();
export const FutureYieldPayload = z.object({ applicationRunId: z.string().uuid(), nodeId: z.string().uuid() }).strict();
export type FutureYieldPayload = z.infer<typeof FutureYieldPayload>;

export const futureYieldDedupeKey = (p: FutureYieldPayload) => `future_yield:${p.applicationRunId}:${p.nodeId}`;

const off = () => new ApiError(409, 'The future yield is off on this server (FUTURE_YIELD=off).', { code: 'future_yield_off' });

/** What a future yield runs on, under the caller's RLS: the application run, its baseline, the dam, the owned units and the catchment's cells. */
export interface FuturePair {
	applicationRunId: string;
	baselineRunId: string;
	nodeId: string;
	ownedNodeIds: string[];
	baseline: ModelInput;
	application: ModelInput;
	cells: ClimateGridCell[];
}

/**
 * The pair, checked: FUTURE_YIELD on; a run of an application (its inputs
 * record the scenario and base run), not a forecast, whose ops assume no
 * climate of their own; the dam (`nodeId`, else the application's only
 * owned unit with a dam); and the project's catchment boundary on the map.
 */
export async function futurePair(db: Db, projectId: string, applicationRunId: string, nodeId?: string): Promise<FuturePair> {
	if (!futureYieldEnabled()) throw off();
	const { rows } = await db.query<{ trigger: string; scenario: { baseRunId?: string; ops?: { op?: string }[]; ownedNodeIds?: string[] } | null }>(
		`SELECT "trigger", inputs->'scenario' AS scenario FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, applicationRunId]
	);
	const run = rows[0];
	if (!run) throw new ApiError(404, 'run not found');
	if (run.trigger === 'forecast') throw new ApiError(409, 'that run is a forecast run; a future yield replays the historical record, so use an ordinary run of the application');
	const sc = run.scenario;
	if (!sc?.baseRunId) throw new ApiError(409, 'the future yield is of an application: that run isn’t a run of a scenario on a baseline', { code: 'not_application' });
	if ((sc.ops ?? []).some((o) => o?.op === 'climate.delta'))
		throw new ApiError(409, 'the application already assumes a future climate (a climate.delta op): § 8 applies the change factors itself, so run it on the application without one');
	const load = async (id: string) => {
		try {
			return await loadRunInput(db, id);
		} catch (err) {
			if (err instanceof RunInputError) throw new ApiError(err.problem === 'not_found' ? 404 : 409, err.problem === 'not_found' ? 'run not found' : err.message);
			throw err;
		}
	};
	const application = await load(applicationRunId);
	const baseline = await load(sc.baseRunId);
	const owned = sc.ownedNodeIds ?? [];
	let dam = nodeId;
	if (!dam) {
		const dams = application.model.nodes.filter((n) => owned.includes(n.id) && n.kind === 'farm' && n.damCapacityM3 > 0);
		if (dams.length !== 1)
			throw new ApiError(400, dams.length ? 'the application has more than one dam of its own: say which (nodeId)' : 'the application has no unit of its own with a dam: the future yield is of a dam', { code: 'future_yield_dam' });
		dam = dams[0]!.id;
	}
	const damError = futureDamError(application, dam);
	if (damError) throw new ApiError(400, damError, { code: 'future_yield_dam' });
	const { rows: b } = await db.query<{ geometry: Geometry }>(`SELECT geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary'`, [projectId]);
	if (!b[0]) throw new ApiError(409, 'the project has no catchment boundary on its map: the change factors are read over it, so draw or upload one on the Map tab first', { code: 'no_boundary' });
	const cells = climateCells(b[0].geometry);
	if ('problem' in cells) throw new ApiError(409, cells.problem.charAt(0).toUpperCase() + cells.problem.slice(1), { code: 'boundary_cells' });
	return { applicationRunId, baselineRunId: sc.baseRunId, nodeId: dam, ownedNodeIds: [...owned], baseline, application, cells: cells.cells };
}

/** One user's future yield jobs queued or running (one request at a time per user, as pendingYieldJobs). */
export async function pendingFutureJobs(db: Db): Promise<number> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('future_yield_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job WHERE kind = 'future_yield' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	return rows[0]?.n ?? 0;
}

export interface FutureYieldRow {
	id: string;
	baselineRunId: string;
	applicationRunId: string;
	nodeId: string;
	jobId: string | null;
	result: FutureYieldResult;
	engineVersion: string;
	createdBy: string | null;
	createdAt: string;
}

/** The newest stored result for the application run (and its baseline, when given), under the reader's RLS; null when none. */
export async function latestFutureYield(db: Db, projectId: string, applicationRunId: string, baselineRunId?: string): Promise<FutureYieldRow | null> {
	const { rows } = await db.query<Omit<FutureYieldRow, 'createdAt'> & { createdAt: Date }>(
		`SELECT f.id, f.baseline_run_id AS "baselineRunId", f.application_run_id AS "applicationRunId", f.node_id AS "nodeId", f.job_id AS "jobId",
			f.result, f.engine_version AS "engineVersion", u.display_name AS "createdBy", f.created_at AS "createdAt"
		 FROM future_yield f LEFT JOIN app_user u ON u.id = f.created_by
		 WHERE f.project_id = $1 AND f.application_run_id = $2 AND ($3::uuid IS NULL OR f.baseline_run_id = $3)
		 ORDER BY f.created_at DESC, f.id DESC LIMIT 1`,
		[projectId, applicationRunId, baselineRunId ?? null]
	);
	const r = rows[0];
	return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
}
