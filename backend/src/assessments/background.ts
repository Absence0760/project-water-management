// A cumulative assessment's optional background at full allocation (295,
// WP-3.10 / WP-3.11; docs/scenarios.md § Cumulative impact, docs/api.md
// § Assessments): assessing the applications against *existing authorised
// use* as well as against the hydrologist's baseline.
//
// Licences never drive the baseline (the operator's rule, issue #507,
// docs/allocations.md § The allocation mode): the assessment's baseline stays
// the hydrologist's run, and its table is unchanged. The background is a
// second row set the assessor opts into, labelled as such: a scenario run on
// that same baseline whose input ran at full allocation (every registered or
// licensed volume taken in full), with each application alone and all of
// them together on it. It is stored beside the baseline's table, never in its
// place (report.background).
//
// Who reads it: an assessment is an editor's (145), and an editor reads every
// volume (decision D3). A reader kept from the volumes (a report render queued
// without them, 218) gets the background's verdicts and counts only, as for
// any full-allocation run (allocations/verdictsOnly.ts): the EWR days and
// Reserve months rows, no flow, volume or use row.
import {
	authorisedTakes,
	combineScenarios,
	cumulativeImpact,
	runModelChecked,
	type CumulativeMetric,
	type CumulativeReport,
	type ModelInput,
	type ScenarioOp
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { loadRunInput, RunInputError } from '../runs/execute.js';
import { applicationMask } from '../scenarios/applicant.js';
import { checkScenario, type ScenarioOrigin } from '../scenarios/execute.js';

/** The background's label, wherever it is shown: what it is, never "the baseline". */
export const BACKGROUND_LABEL = 'Existing authorised use (full allocation)';

/** The background run as the assessment records it (its label and scenario name as they were when assessed). */
export interface AssessmentBackgroundRun {
	id: string;
	label: string;
	scenarioName: string | null;
	createdAt: string;
}

/** The background row set: the cumulative table with the full-allocation run in the baseline's column. */
export interface AssessmentBackground {
	label: typeof BACKGROUND_LABEL;
	run: AssessmentBackgroundRun;
	report: CumulativeReport;
	/** Only for a reader kept from the registered volumes: the rows left are the EWR verdicts and counts. */
	verdictsOnly?: true;
}

/** The stored report: the baseline's cumulative table, and the background's beside it when one was asked for. */
export type AssessmentReport = CumulativeReport & { background?: AssessmentBackground };

/** A background run's ops: what may differ from the baseline (the mode, and registered volumes as assumptions of authorised use). */
function opProblem(op: ScenarioOp): string | null {
	if (op.op === 'settings.set' && op.path === 'allocationMode') return op.value === 'fullAllocation' ? null : `it sets the allocation mode to ${String(op.value)}`;
	if (op.op === 'allocation.set' || op.op === 'allocation.remove') return null;
	return `it changes more than the allocation mode and registered volumes (${op.op})`;
}

interface CandidateRow {
	id: string;
	label: string | null;
	scenarioName: string | null;
	createdAt: Date;
	fromScenario: boolean;
	baseRunId: string | null;
	allocationMode: string | null;
	ops: ScenarioOp[] | null;
}

const CANDIDATE_SELECT = `SELECT r.id, r.label, COALESCE(s.name, r.inputs->'scenario'->>'name') AS "scenarioName", r.created_at AS "createdAt",
	r.from_scenario AS "fromScenario", r.inputs->'scenario'->>'baseRunId' AS "baseRunId",
	r.inputs->'settings'->>'allocationMode' AS "allocationMode", r.inputs->'scenario'->'ops' AS ops
	FROM model_run r LEFT JOIN scenario s ON s.id = r.scenario_id`;

/** Why a run can't be the background of an assessment on `baseRunId`; null when it can (the volumes are checked on its input). */
function refusal(r: CandidateRow, baseRunId: string): string | null {
	if (!r.fromScenario || r.baseRunId !== baseRunId)
		return 'the background must be a scenario run on the same baseline run as the applications, with the allocation mode set to full allocation';
	if (r.allocationMode !== 'fullAllocation') return 'the background run didn’t run at full allocation: run a scenario on this baseline that sets the allocation mode to full allocation';
	for (const op of r.ops ?? []) {
		const p = opProblem(op);
		if (p) return `the background run isn’t the baseline at full allocation: ${p}`;
	}
	return null;
}

const toRun = (r: CandidateRow): AssessmentBackgroundRun => ({ id: r.id, label: r.label ?? '', scenarioName: r.scenarioName, createdAt: r.createdAt.toISOString() });

/**
 * The background run of a request or a job, as the caller reads it (RLS):
 * 404 when they can't (another project's run, or none), 422 when it isn't
 * this baseline at full allocation (a run of the model, a scenario on another
 * run, another mode, other changes, or no registered volume that takes), 409
 * when its input can't be rebuilt. Returns the run and its stored input.
 */
export async function loadBackground(db: Db, projectId: string, baseRunId: string, backgroundRunId: string): Promise<{ run: AssessmentBackgroundRun; input: ModelInput }> {
	const { rows } = await db.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE r.project_id = $1 AND r.id = $2`, [projectId, backgroundRunId]);
	const row = rows[0];
	if (!row) throw new ApiError(404, 'background run not found');
	const why = refusal(row, baseRunId);
	if (why) throw new ApiError(422, why);
	let input: ModelInput;
	try {
		input = await loadRunInput(db, backgroundRunId);
	} catch (err) {
		if (err instanceof RunInputError) throw new ApiError(err.problem === 'not_found' ? 404 : 409, err.problem === 'not_found' ? 'background run not found' : err.message);
		throw err;
	}
	if (input.settings.allocationMode !== 'fullAllocation') throw new ApiError(422, 'the background run didn’t run at full allocation');
	if (!authorisedTakes(input).length) throw new ApiError(422, 'the background run holds no registered or licensed volume (Allocations), so there is no authorised use to assess against');
	return { run: toRun(row), input };
}

/** The runs that can be the background of an assessment on `baseRunId`, newest first (RLS: what the caller reads). */
export async function listBackgroundRuns(db: Db, projectId: string, baseRunId: string): Promise<AssessmentBackgroundRun[]> {
	const { rows } = await db.query<CandidateRow>(
		`${CANDIDATE_SELECT} WHERE r.project_id = $1 AND r.from_scenario AND r.inputs->'scenario'->>'baseRunId' = $2
			AND r.inputs->'settings'->>'allocationMode' = 'fullAllocation'
		 ORDER BY r.created_at DESC, r.id LIMIT 50`,
		[projectId, baseRunId]
	);
	return rows.filter((r) => refusal(r, baseRunId) === null).map(toRun);
}

/** One member as the background's runs take it. */
export interface BackgroundMember {
	id: string;
	name: string;
	ops: ScenarioOp[];
	origin: ScenarioOrigin;
	ownedNodeIds: string[];
}

type Outcome = { ok: true; background: AssessmentBackground } | { ok: false; status: 'refused' | 'failed'; problems: string[] };

const AT = 'At full allocation';

function engineRun(input: ModelInput): { ok: true; out: ReturnType<typeof runModelChecked> } | { ok: false; message: string } {
	try {
		return { ok: true, out: runModelChecked(input) };
	} catch (err) {
		return { ok: false, message: `model run failed: ${(err as Error).message}` };
	}
}

/**
 * The background row set, in the assessment job (computeAssessment): the
 * background run's input, each member alone on it (checkScenario under its
 * applicant's mask, as on the baseline) and all together (combineScenarios),
 * with the current engine, then cumulativeImpact with the background in the
 * baseline's column. `step` is called after each run. A member whose ops
 * don't apply on the background refuses the assessment, an engine refusal
 * fails it, each line prefixed "At full allocation".
 */
export async function assessBackground(
	db: Db,
	projectId: string,
	baseRunId: string,
	backgroundRunId: string,
	members: readonly BackgroundMember[],
	step: () => Promise<void>
): Promise<Outcome> {
	const { run, input } = await loadBackground(db, projectId, baseRunId, backgroundRunId);
	const bg = engineRun(input);
	await step();
	if (!bg.ok) return { ok: false, status: 'failed', problems: [`${AT}, the background: ${bg.message}`] };
	const singles: Parameters<typeof cumulativeImpact>[1][number][] = [];
	for (const m of members) {
		const check = checkScenario(input, m);
		// The assessors' words (164): only editors read an assessment.
		if (check.problems.length) return { ok: false, status: 'refused', problems: check.assessorProblems.map((p) => `${AT}, "${m.name}" alone: ${p}`) };
		const r = engineRun(check.input);
		if (!r.ok) return { ok: false, status: 'failed', problems: [`${AT}, "${m.name}" alone: ${r.message}`] };
		singles.push({ id: m.id, name: m.name, summary: r.out.summary, startDate: r.out.startDate, endDate: r.out.endDate });
		await step();
	}
	const combined = combineScenarios(
		input,
		members.map((m) => ({ id: m.id, name: m.name, ops: m.ops, ...(m.origin === 'applicant' ? { mask: applicationMask(input, m.ownedNodeIds) } : {}) }))
	);
	if (!combined.input) return { ok: false, status: 'refused', problems: [...combined.conflicts.map((c) => c.message), ...combined.problems].map((p) => `${AT}: ${p}`) };
	const together = engineRun(combined.input);
	await step();
	if (!together.ok) return { ok: false, status: 'failed', problems: [`${AT}, all together: ${together.message}`] };
	const report = cumulativeImpact(
		{ summary: bg.out.summary, startDate: bg.out.startDate, endDate: bg.out.endDate },
		singles,
		{ summary: together.out.summary, startDate: together.out.startDate, endDate: together.out.endDate }
	);
	return { ok: true, background: { label: BACKGROUND_LABEL, run, report } };
}

/** The background rows a reader kept from the registered volumes reads: EWR verdicts and counts (allocations/verdictsOnly.ts). */
export const BACKGROUND_VERDICT_METRICS: ReadonlySet<CumulativeMetric> = new Set<CumulativeMetric>(['ewr_days_not_met', 'reserve_months_met']);

/**
 * An assessment's report as a reader kept from the registered volumes reads
 * it: the background's rows narrowed to BACKGROUND_VERDICT_METRICS and marked
 * `verdictsOnly`. In a full-allocation run every use, and every flow below a
 * unit, is worked out from the volumes, so its flows, shortfalls, deficits
 * and users' supply are withheld (decision D3, #523 I). The baseline's table
 * is a compare-only run's and stays. Idempotent; a report without a
 * background comes back as it is.
 */
export function backgroundVerdicts<R extends AssessmentReport | null | undefined>(report: R): R {
	const bg = report?.background;
	if (!report || !bg) return report;
	return { ...report, background: { ...bg, verdictsOnly: true, report: { ...bg.report, rows: bg.report.rows.filter((r) => BACKGROUND_VERDICT_METRICS.has(r.metric)) } } };
}
