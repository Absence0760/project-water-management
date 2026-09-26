// Scenarios (roadmap WP-3.2, docs/scenarios.md): loading one, checking its
// ops against its base run, and running it. A scenario applies to its base
// run's stored input (loadRunInput), never the live model, and its run goes
// through the same save path as any other (runAndStore), so it is an ordinary
// model_run with scenario_id set: compare, export and the 20-run cap treat it
// like any run.
import { applyScenario, classifyScenario, type AppliedOp, type ModelInput, type ModelOutput, type OpClass, type ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { loadRunInput, lockProjectRuns, RunInputError, runAndStore } from '../runs/execute.js';
import type { ScenarioStatus } from './schema.js';

/** A scenario row as the API returns it. */
export interface ScenarioRow {
	id: string;
	name: string;
	description: string;
	baseRunId: string;
	/** The base run's label and date, for the "Based on run X" banner. */
	baseRun: { id: string; label: string; createdAt: string };
	ops: ScenarioOp[];
	opsSha256: string;
	ownedNodeIds: string[];
	ownerUserId: string;
	owner: string | null;
	status: ScenarioStatus;
	createdAt: string;
	updatedAt: string;
	/** Runs of this scenario still stored, and the newest one. */
	runCount: number;
	lastRun: { id: string; label: string; createdAt: string } | null;
}

export const SCENARIO_SELECT = `SELECT s.id, s.name, s.description, s.base_run_id AS "baseRunId",
	jsonb_build_object('id', b.id, 'label', b.label, 'createdAt', b.created_at) AS "baseRun",
	s.ops, s.ops_sha256 AS "opsSha256", s.owned_node_ids AS "ownedNodeIds", s.owner_user_id AS "ownerUserId",
	u.display_name AS owner, s.status, s.created_at AS "createdAt", s.updated_at AS "updatedAt",
	(SELECT count(*)::int FROM model_run r WHERE r.scenario_id = s.id) AS "runCount",
	(SELECT jsonb_build_object('id', r.id, 'label', r.label, 'createdAt', r.created_at) FROM model_run r
	 WHERE r.scenario_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "lastRun"
	FROM scenario s JOIN model_run b ON b.id = s.base_run_id JOIN app_user u ON u.id = s.owner_user_id`;

/** One scenario of a project, or 404. `lock` holds it against a concurrent delete until the transaction ends. */
export async function loadScenario(db: Db, projectId: string, scenarioId: string, lock = false): Promise<ScenarioRow> {
	const { rows } = await db.query<ScenarioRow>(`${SCENARIO_SELECT} WHERE s.project_id = $1 AND s.id = $2${lock ? ' FOR KEY SHARE OF s' : ''}`, [projectId, scenarioId]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

/** What applying a scenario's ops to a base run gives: the input and, per op, whether it applied and how it is classed. */
export interface ScenarioCheck {
	input: ModelInput;
	base: ModelInput;
	applied: AppliedOp[];
	/** One line per op that doesn't apply to this base (`op 3 (node.remove): node … not found`). */
	problems: string[];
	/** classifyScenario, one per op: `proposal` or `baseline`. */
	classified: OpClass[];
}

/**
 * The base run's exact input (loadRunInput, under the caller's RLS). A run of
 * another project, or one the caller can't see, is 404; a run that can't be
 * rebuilt (saved before stored inputs, or failing its checks) is 409 with
 * loadRunInput's message.
 */
export async function loadBaseInput(db: Db, projectId: string, runId: string): Promise<ModelInput> {
	const { rows } = await db.query<{ scenarioId: string | null; trigger: string }>(
		'SELECT scenario_id AS "scenarioId", "trigger" FROM model_run WHERE project_id = $1 AND id = $2',
		[projectId, runId]
	);
	if (!rows[0]) throw new ApiError(404, 'base run not found');
	if (rows[0].scenarioId) throw new ApiError(409, 'that run is a scenario run; base a scenario on a run of the model itself');
	// A forecast run's input runs on past the record on forecast rain (WP-2.12); a scenario is judged on history.
	if (rows[0].trigger === 'forecast') throw new ApiError(409, 'that run is a forecast run; base a scenario on an ordinary run of the model');
	try {
		return await loadRunInput(db, runId);
	} catch (err) {
		if (err instanceof RunInputError) throw new ApiError(err.problem === 'not_found' ? 404 : 409, err.problem === 'not_found' ? 'base run not found' : err.message);
		throw err;
	}
}

/** Apply `ops` to the base run's input and classify them. Pure given the base. */
export function checkScenario(base: ModelInput, ops: readonly ScenarioOp[], ownedNodeIds: readonly string[]): ScenarioCheck {
	const { input, applied, problems } = applyScenario(base, ops);
	return { input, base, applied, problems, classified: classifyScenario(base, ops, ownedNodeIds) };
}

/**
 * Run a scenario: its base run's stored input → applyScenario → the same
 * checked run and save as any run (runAndStore), with scenario_id set and the
 * scenario's ops, hash and classification recorded in the run's snapshot.
 * Refuses (422, `details.problems`) when any op doesn't apply: a result with
 * an op silently skipped would not be the scenario its name says. Doesn't
 * trim; the route does, as for any run.
 */
export async function executeScenarioRun(
	db: Db,
	projectId: string,
	scenarioId: string,
	label: string | undefined
): Promise<{ id: string; output: ModelOutput; check: ScenarioCheck; scenario: ScenarioRow }> {
	// The project's run lock first, then the scenario row: the order the delete
	// and rebase routes take them in, so a run racing a delete waits instead of
	// deadlocking. (runAndStore and trimRuns take the same lock again later.)
	await lockProjectRuns(db, projectId);
	const scenario = await loadScenario(db, projectId, scenarioId, true);
	const base = await loadBaseInput(db, projectId, scenario.baseRunId);
	const check = checkScenario(base, scenario.ops, scenario.ownedNodeIds);
	if (check.problems.length)
		throw new ApiError(422, check.problems.length === 1 ? "an op of this scenario doesn't apply to its base run" : `${check.problems.length} ops of this scenario don't apply to its base run`, {
			problems: check.problems
		});
	const { id, output } = await runAndStore(db, projectId, label || scenario.name, check.input, {
		id: scenario.id,
		name: scenario.name,
		baseRunId: scenario.baseRunId,
		ops: scenario.ops,
		opsSha256: scenario.opsSha256,
		ownedNodeIds: scenario.ownedNodeIds,
		classified: check.classified
	});
	return { id, output, check, scenario };
}
