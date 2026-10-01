// Scenarios (roadmap WP-3.2, docs/scenarios.md): loading one, checking its
// ops against its base run, and running it. A scenario applies to its base
// run's stored input (loadRunInput), never the live model, and its run goes
// through the same save path as any other (storeRun), so it is an ordinary
// model_run with scenario_id set: compare, export and the 20-run cap treat it
// like any run.
import { applyScenario, classifyScenario, type AppliedOp, type MaskedReId, type MaskedRename, type MaskedRuleRef, type ModelInput, type ModelOutput, type OpClass, type ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import type { Role } from '../projects/access.js';
import { applicationMask } from './applicant.js';
import {
	type ComputeRun,
	loadPublishedRunInput,
	loadRunInput,
	lockProjectRuns,
	RunInputError,
	runOutsideTransaction,
	type RunPlan,
	storeRun
} from '../runs/execute.js';
import type { OpName } from './names.js';
import type { ScenarioOutcome, ScenarioStatus } from './schema.js';

/** A scenario row as the API returns it. */
export interface ScenarioRow {
	id: string;
	name: string;
	description: string;
	/** Answers to Appendix C's fixed prompts (129_scenario_statement, engine APPLICANT_PROMPTS); '' = not given. */
	purposeAndNeed: string;
	mitigation: string;
	monitoring: string;
	baseRunId: string;
	/** The base run's label and date, for the "Based on run X" banner (label '' and createdAt null if the caller can't read it). */
	baseRun: { id: string; label: string; createdAt: string | null };
	ops: ScenarioOp[];
	opsSha256: string;
	ownedNodeIds: string[];
	/** Names of the nodes and crops the ops name, kept from the base run's snapshot when the ops were written (047_scenario_op_names). */
	opNames: OpName[];
	ownerUserId: string | null;
	owner: string | null;
	status: ScenarioStatus;
	/** 'team': a modelling scenario (WP-3.2). 'applicant': an application by a contributor (WP-3.3, 045_contributor_scope). */
	origin: ScenarioOrigin;
	/** When it was last submitted (null while a draft). */
	submittedAt: string | null;
	/** The assessor's decision, once decided. */
	decidedAt: string | null;
	decidedBy: string | null;
	outcome: ScenarioOutcome | null;
	decisionNote: string;
	/** Who else reads an application (scenario_member): the applicant's consultant or client. */
	members: { userId: string; displayName: string }[];
	createdAt: string;
	updatedAt: string;
	/** Runs of this scenario still stored, and the newest one. */
	runCount: number;
	lastRun: { id: string; label: string; createdAt: string } | null;
}

export type ScenarioOrigin = 'team' | 'applicant';

/** Most runs an application keeps (the newest; kept runs aside): its owner's runs never count against the project's cap, which they can't trim. */
export const APPLICATION_RUNS_KEPT = 5;

// The base run through app_run_brief (045): an applicant can't read the
// published run's row, only its label and date. The scenario's own runs
// through app_scenario_run_meta (046): an applicant reads no run row at all,
// not even their own application's (its inputs hold every farm). An
// application's own nodes, to a contributor, are those still its owner's farm
// links (app_application_own_nodes, 071): what the base projection, the check
// and a new run show them in full. Everyone else reads the stored list, the
// record the assessors judge.
export const SCENARIO_SELECT = `SELECT s.id, s.name, s.description,
	s.purpose_need AS "purposeAndNeed", s.mitigation, s.monitoring, s.base_run_id AS "baseRunId",
	COALESCE(app_run_brief(s.project_id, s.base_run_id), jsonb_build_object('id', s.base_run_id, 'label', '', 'createdAt', NULL)) AS "baseRun",
	s.ops, s.ops_sha256 AS "opsSha256",
	CASE WHEN s.origin = 'applicant' AND app_is_contributor(s.project_id) THEN app_application_own_nodes(s.id) ELSE s.owned_node_ids END AS "ownedNodeIds", s.op_names AS "opNames", s.owner_user_id AS "ownerUserId",
	u.display_name AS owner, s.status, s.origin, s.submitted_at AS "submittedAt", s.decided_at AS "decidedAt",
	du.display_name AS "decidedBy", s.outcome, s.decision_note AS "decisionNote",
	(SELECT COALESCE(jsonb_agg(jsonb_build_object('userId', m.user_id, 'displayName', mu.display_name) ORDER BY mu.display_name, m.user_id), '[]'::jsonb)
	 FROM scenario_member m JOIN app_user mu ON mu.id = m.user_id WHERE m.scenario_id = s.id) AS members,
	s.created_at AS "createdAt", s.updated_at AS "updatedAt",
	(SELECT count(*)::int FROM app_scenario_run_meta(s.project_id, s.id)) AS "runCount",
	(SELECT jsonb_build_object('id', r.id, 'label', r.label, 'createdAt', r.created_at) FROM app_scenario_run_meta(s.project_id, s.id) r
	 ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "lastRun"
	FROM scenario s LEFT JOIN app_user u ON u.id = s.owner_user_id LEFT JOIN app_user du ON du.id = s.decided_by`;

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
	/** An application's hidden nodes and crops renamed because an op took their name (applyScenario's `renamed`). Never shown to a contributor. */
	renamed: MaskedRename[];
	/** An application's new items moved off a hidden item's id (applyScenario's `reIds`). Never shown to a contributor. */
	reIds: MaskedReId[];
	/** `problems` in the real words of every rule, hidden names restored (applyScenario's `assessorProblems`, 164). Never shown to a contributor. */
	assessorProblems: string[];
	/** The problem lines a hidden rule broke, with their ops and the rules' kinds (applyScenario's `maskedRules`): what "Ask the assessors why" quotes. */
	maskedRules: MaskedRuleRef[];
	/** An application, checked under its applicant's mask: only then do `maskedRules` and `assessorProblems` say anything. */
	masked: boolean;
}

/**
 * How many farm holders an application's hidden farms have, capped at
 * FARMER_K (app_application_hidden_holders, 164): what lets the check give a
 * catchment-wide rule's aggregate (engine MASKED_RULE_AGGREGATE). 0 for a
 * team scenario or one the caller can't read. Server-side only.
 */
export async function hiddenHolders(db: Db, s: Pick<ScenarioRow, 'id' | 'origin'>): Promise<number> {
	if (s.origin !== 'applicant') return 0;
	const { rows } = await db.query<{ n: number }>('SELECT app_application_hidden_holders($1) AS n', [s.id]);
	return rows[0]?.n ?? 0;
}

/**
 * The base run's exact input (loadRunInput, under the caller's RLS). A run of
 * another project, or one the caller can't see, is 404; a run that can't be
 * rebuilt (saved before stored inputs, or failing its checks) is 409 with
 * loadRunInput's message.
 *
 * A contributor can't read a run's row: for them the base is a **published**
 * run, rebuilt past RLS (loadPublishedRunInput), and 404 for any other. The
 * input stays on the server (scenarios/applicant.ts projects what they see).
 */
export async function loadBaseInput(db: Db, projectId: string, runId: string, role?: Role): Promise<ModelInput> {
	if (role === 'contributor') {
		let base: Awaited<ReturnType<typeof loadPublishedRunInput>>;
		try {
			base = await loadPublishedRunInput(db, projectId, runId);
		} catch (err) {
			if (err instanceof RunInputError) throw new ApiError(err.problem === 'not_found' ? 404 : 409, err.problem === 'not_found' ? 'published run not found' : err.message);
			throw err;
		}
		// As below: an application is judged on history, not on forecast rain (WP-2.12).
		if (base.trigger === 'forecast') throw new ApiError(409, 'the published run is a forecast run; an application needs an ordinary run of the model published');
		return base.input;
	}
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

/**
 * Apply a scenario's ops to the base run's input and classify them. Pure
 * given the base. An application's ops meet every node and crop its
 * applicant can't see under the anonymous name they see it by
 * (applicationMask, WP-3.3), whoever checks it: the application is judged
 * in its applicant's namespace, so no message quotes a hidden name, a
 * hidden item's id or name answers as a free one, and nothing counts what
 * they can't see (docs/scenarios.md § Applications).
 */
export function checkScenario(base: ModelInput, s: Pick<ScenarioRow, 'ops' | 'ownedNodeIds' | 'origin'>, holders = 0): ScenarioCheck {
	const masked = s.origin === 'applicant';
	const options = masked ? { mask: { ...applicationMask(base, s.ownedNodeIds), hiddenHolders: holders } } : {};
	const { input, applied, problems, renamed, reIds, assessorProblems, maskedRules } = applyScenario(base, s.ops, options);
	return { input, base, applied, problems, renamed, reIds, assessorProblems, maskedRules, masked, classified: classifyScenario(base, s.ops, s.ownedNodeIds, options) };
}

/** Who may run a scenario, and the scenario as they read it: the route's check, made when the run is read and again when it is stored. */
export type AuthorizeScenarioRun = (db: Db) => Promise<{ role: Role; scenario: ScenarioRow }>;

/** What a scenario run was computed from (runScenario): its plan, the check that made its input, and the scenario then. */
interface ScenarioRunPlan {
	run: RunPlan;
	check: ScenarioCheck;
	scenario: ScenarioRow;
}

/**
 * A scenario run's plan: its base run's stored input → applyScenario, with
 * the scenario's ops, hash and classification for the run's snapshot.
 * Refuses (422, `details.problems`) when any op doesn't apply: a result with
 * an op silently skipped would not be the scenario its name says.
 */
export async function prepareScenarioRun(db: Db, projectId: string, scenario: ScenarioRow, label: string | undefined, role: Role): Promise<ScenarioRunPlan> {
	const base = await loadBaseInput(db, projectId, scenario.baseRunId, role);
	const check = checkScenario(base, scenario, await hiddenHolders(db, scenario));
	// Ops, not problem lines: an edit group that breaks a rule is one line for all its ops.
	const skipped = scenario.ops.length - check.applied.length;
	if (check.problems.length)
		throw new ApiError(422, skipped === 1 ? "an op of this scenario doesn't apply to its base run" : `${skipped} ops of this scenario don't apply to its base run`, {
			problems: check.problems
		});
	const run: RunPlan = {
		projectId,
		label: label || scenario.name,
		input: check.input,
		trigger: 'manual',
		scenario: {
			id: scenario.id,
			name: scenario.name,
			baseRunId: scenario.baseRunId,
			ops: scenario.ops,
			opsSha256: scenario.opsSha256,
			ownedNodeIds: scenario.ownedNodeIds,
			classified: check.classified
		},
		privateLabel: scenario.origin === 'applicant'
	};
	return { run, check, scenario };
}

/**
 * True when the scenario as it is now would not give the run computed from
 * `then`: its ops, base run, owned nodes or origin moved (an edit, a rebase).
 * A new name, description or status doesn't change the result.
 */
export function scenarioChanged(then: ScenarioRow, now: ScenarioRow): boolean {
	return (
		then.opsSha256 !== now.opsSha256 ||
		then.baseRunId !== now.baseRunId ||
		then.origin !== now.origin ||
		JSON.stringify([...then.ownedNodeIds].sort()) !== JSON.stringify([...now.ownedNodeIds].sort())
	);
}

/**
 * Run a scenario (POST …/scenarios/:sid/runs) as `userId`, with no
 * connection held while the engine runs (runOutsideTransaction): the same
 * checked run and save as any run (storeRun), with scenario_id set and the
 * scenario's ops, hash and classification recorded in the run's snapshot.
 *
 * `authorize` runs in both transactions. In the second, after the project's
 * run lock (the delete and rebase routes take it before they touch the row,
 * so they can't slip in between the check and the save): a caller who lost
 * the right to run it while the engine ran gets its 403/404 and nothing is
 * stored, and a scenario that was deleted (404) or changed so the result
 * would differ (409, scenarioChanged) stores nothing either: run it again.
 * The row is read without FOR KEY SHARE: that lock needs the UPDATE policy
 * (045), which a shared member or an assessor running an application doesn't
 * pass. `then` runs in the second transaction after the run is stored, with
 * the role as it then is. Doesn't trim; `then` does, as for any run.
 */
export function runScenario<T>(
	userId: string,
	projectId: string,
	label: string | undefined,
	authorize: AuthorizeScenarioRun,
	then: (db: Db, run: { id: string; output: ModelOutput; check: ScenarioCheck; scenario: ScenarioRow }, role: Role) => Promise<T>,
	compute?: ComputeRun
): Promise<T> {
	return runOutsideTransaction(
		userId,
		async (db) => {
			const { role, scenario } = await authorize(db);
			return prepareScenarioRun(db, projectId, scenario, label, role);
		},
		async (db, plan, output) => {
			await lockProjectRuns(db, projectId);
			const { role, scenario } = await authorize(db);
			if (scenarioChanged(plan.scenario, scenario)) throw new ApiError(409, 'this scenario changed while it ran (its ops or base run); run it again');
			const { id } = await storeRun(db, plan.run, output);
			return then(db, { id, output, check: plan.check, scenario: plan.scenario }, role);
		},
		compute
	);
}

/**
 * Keep an application's newest APPLICATION_RUNS_KEPT runs, as its owner
 * (app_trim_application_runs, 046: SECURITY DEFINER, since a contributor
 * can't read the rows a DELETE needs; it spares a kept run and deletes
 * nothing for anyone but the owner). Its owner's runs are hidden from the
 * editors whose runs trimRuns counts, so they have a cap of their own.
 * Returns the ids removed.
 */
export async function trimApplicationRuns(db: Db, projectId: string, scenarioId: string, keep = APPLICATION_RUNS_KEPT): Promise<string[]> {
	await lockProjectRuns(db, projectId);
	const { rows } = await db.query<{ id: string }>('SELECT t AS id FROM app_trim_application_runs($1, $2, $3) AS t', [projectId, scenarioId, keep]);
	return rows.map((r) => r.id);
}
