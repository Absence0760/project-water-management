// Cumulative impact assessments (roadmap WP-3.11, 145_assessment.sql,
// docs/scenarios.md § Cumulative impact, docs/api.md § Assessments):
// checking that scenarios combine, writing an assessment with its job,
// reading them back, and the job's own work (computeAssessment, called by
// jobs/handlers/assessment.ts).
import { randomUUID } from 'node:crypto';
import {
	combineScenarios,
	cumulativeImpact,
	ENGINE_VERSION,
	runModelChecked,
	type CombineScenario,
	type CumulativeReport,
	type ModelInput,
	type RunSummary,
	type ScenarioConflict,
	type ScenarioOp
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { LeaseLostError } from '../jobs/errors.js';
import { enqueueJob, type JobMeta, type JobStatus } from '../jobs/queue.js';
import { applicationMask } from '../scenarios/applicant.js';
import { checkScenario, loadBaseInput, loadScenario, type ScenarioOrigin, type ScenarioRow } from '../scenarios/execute.js';
import { ASSESSMENTS_KEPT, type CreateAssessmentBody } from './schema.js';

export type AssessmentStatus = 'pending' | 'complete' | 'refused' | 'failed';
export type AssessmentMemberStatus = 'pending' | 'done' | 'problems' | 'failed';

export interface AssessmentMemberRow {
	id: string;
	position: number;
	/** The scenario it was copied from; null once a team scenario is deleted. */
	scenarioId: string | null;
	name: string;
	origin: ScenarioOrigin;
	opsSha256: string;
	opCount: number;
	status: AssessmentMemberStatus;
	problems: string[];
	startDate: string | null;
	endDate: string | null;
}

export interface AssessmentRow {
	id: string;
	name: string;
	baseRunId: string;
	baseRun: { id: string; label: string; createdAt: string };
	status: AssessmentStatus;
	/** Why it was refused or failed: the conflicts and ops that don't apply, or the engine's message. */
	problems: string[];
	/** The cumulative report (engine CumulativeReport); only on GET …/assessments/:aid, and only when complete. */
	report?: CumulativeReport | null;
	engineVersion: string | null;
	job: { id: string; status: JobStatus; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	members: AssessmentMemberRow[];
}

/** Whether a set of scenarios combine on their base run: the engine's conflicts, and the ops that don't apply alone or together. */
export interface AssessmentCheck {
	ok: boolean;
	conflicts: ScenarioConflict[];
	/** Ops that don't apply, each line prefixed by its scenario's name. */
	problems: string[];
}

const memberFields = `jsonb_build_object('id', m.id, 'position', m.position, 'scenarioId', m.scenario_id, 'name', m.name, 'origin', m.origin,
	'opsSha256', m.ops_sha256, 'opCount', jsonb_array_length(m.ops), 'status', m.status, 'problems', m.problems,
	'startDate', m.start_date, 'endDate', m.end_date)`;

const assessmentSelect = (withReport: boolean) => `SELECT a.id, a.name, a.base_run_id AS "baseRunId",
	jsonb_build_object('id', r.id, 'label', r.label, 'createdAt', r.created_at) AS "baseRun",
	a.status, a.problems${withReport ? ', a.report' : ''}, a.engine_version AS "engineVersion",
	CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object('id', j.id, 'status', j.status, 'error', j.last_error, 'progress', j.progress) END AS job,
	u.display_name AS "createdBy", a.created_at AS "createdAt", a.completed_at AS "completedAt",
	(SELECT COALESCE(jsonb_agg(${memberFields} ORDER BY m.position), '[]'::jsonb)
	 FROM assessment_member m WHERE m.assessment_id = a.id) AS members
	FROM assessment a JOIN model_run r ON r.id = a.base_run_id
	LEFT JOIN job j ON j.id = a.job_id LEFT JOIN app_user u ON u.id = a.created_by`;

/** What combineScenarios takes for one scenario: an application's ops judged under its applicant's mask, as its own runs are (checkScenario). */
function combineEntry(base: ModelInput, s: Pick<ScenarioRow, 'id' | 'name' | 'ops' | 'origin' | 'ownedNodeIds'>): CombineScenario {
	return { id: s.id, name: s.name, ops: s.ops, ...(s.origin === 'applicant' ? { mask: applicationMask(base, s.ownedNodeIds) } : {}) };
}

/** Each scenario alone, then all together (combineScenarios), on `base`: what refuses an assessment. Pure given the base. */
export function checkCombination(base: ModelInput, scenarios: readonly Pick<ScenarioRow, 'id' | 'name' | 'ops' | 'origin' | 'ownedNodeIds'>[]): AssessmentCheck {
	const problems: string[] = [];
	for (const s of scenarios) for (const p of checkScenario(base, s).problems) problems.push(`"${s.name}" alone: ${p}`);
	if (problems.length) return { ok: false, conflicts: [], problems };
	const combined = combineScenarios(
		base,
		scenarios.map((s) => combineEntry(base, s))
	);
	return { ok: !combined.conflicts.length && !combined.problems.length, conflicts: combined.conflicts, problems: combined.problems };
}

/**
 * The scenarios of a request, as the caller reads them (404 for one they
 * can't: another project's, or an application still a draft), each a team
 * scenario or a submitted or decided application, all on one base run;
 * and that base run's input (loadBaseInput: 404 / 409 as for a scenario).
 */
async function loadRequest(db: Db, projectId: string, ids: readonly string[]): Promise<{ scenarios: ScenarioRow[]; baseRunId: string; base: ModelInput }> {
	const scenarios: ScenarioRow[] = [];
	for (const id of ids) scenarios.push(await loadScenario(db, projectId, id));
	for (const s of scenarios) {
		if (s.origin === 'applicant' && s.status !== 'submitted' && s.status !== 'decided')
			throw new ApiError(409, `"${s.name}" is ${s.status === 'withdrawn' ? 'withdrawn' : 'a draft'}; an application is assessed once it is submitted`);
	}
	const bases = new Set(scenarios.map((s) => s.baseRunId));
	if (bases.size > 1) throw new ApiError(422, 'these scenarios are based on different runs; rebase them onto one run to assess them together');
	const baseRunId = scenarios[0]!.baseRunId;
	return { scenarios, baseRunId, base: await loadBaseInput(db, projectId, baseRunId) };
}

/**
 * Check that the scenarios combine and, unless `dryRun`, write the
 * assessment, its members and its job as the transaction's user (an editor,
 * RLS), keeping the project's newest ASSESSMENTS_KEPT. Refused (422, the
 * conflicts and problems in `details`) when they don't combine: never a run
 * that silently picks one scenario's edit over another's. Wake the worker
 * after the commit.
 */
export async function createAssessment(
	db: Db,
	projectId: string,
	body: CreateAssessmentBody
): Promise<{ check: AssessmentCheck; assessment: AssessmentRow | null; job: JobMeta | null }> {
	const { scenarios, baseRunId, base } = await loadRequest(db, projectId, body.scenarioIds);
	const check = checkCombination(base, scenarios);
	if (!check.ok) {
		const n = check.conflicts.length;
		throw new ApiError(
			422,
			n ? `these scenarios conflict (${n === 1 ? 'one conflict' : `${n} conflicts`}); they can't be assessed together` : "an op doesn't apply with these scenarios together",
			{ conflicts: check.conflicts, problems: check.problems }
		);
	}
	if (body.dryRun) return { check, assessment: null, job: null };
	const assessmentId = randomUUID();
	const { job } = await enqueueJob(db, { projectId, kind: 'assessment', payload: { assessmentId }, maxAttempts: 2 });
	await db.query('INSERT INTO assessment (id, project_id, base_run_id, job_id, name) VALUES ($1, $2, $3, $4, $5)', [assessmentId, projectId, baseRunId, job.id, body.name]);
	// The guard copies each scenario's name, origin, ops and own nodes; these columns are placeholders it overwrites.
	await db.query(
		`INSERT INTO assessment_member (assessment_id, project_id, scenario_id, position, name, origin, ops, ops_sha256)
		 SELECT $1, $2, s, p, '-', 'team', '[]', repeat('0', 64) FROM unnest($3::uuid[], $4::int[]) AS t(s, p)`,
		[assessmentId, projectId, body.scenarioIds, body.scenarioIds.map((_, i) => i)]
	);
	await db.query(
		`DELETE FROM assessment WHERE id IN (
			SELECT id FROM assessment WHERE project_id = $1 ORDER BY created_at DESC, id DESC OFFSET $2)`,
		[projectId, ASSESSMENTS_KEPT]
	);
	return { check, assessment: (await getAssessment(db, projectId, assessmentId, false))!, job };
}

/** A project's assessments, newest first, without their reports (RLS: editor). */
export async function listAssessments(db: Db, projectId: string): Promise<AssessmentRow[]> {
	const { rows } = await db.query<AssessmentRow>(`${assessmentSelect(false)} WHERE a.project_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT ${ASSESSMENTS_KEPT}`, [projectId]);
	return rows;
}

/** One assessment of a project, with its report unless `withReport` is false; null when there is none (RLS: editor). */
export async function getAssessment(db: Db, projectId: string, assessmentId: string, withReport = true): Promise<AssessmentRow | null> {
	const { rows } = await db.query<AssessmentRow>(`${assessmentSelect(withReport)} WHERE a.project_id = $1 AND a.id = $2`, [projectId, assessmentId]);
	return rows[0] ?? null;
}

/** Queued or running assessment jobs the user has, in any project they can still see. */
export async function pendingAssessmentJobs(db: Db): Promise<number> {
	// One request at a time per user (the lock is held to commit), so a burst can't all pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('assessment_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job WHERE kind = 'assessment' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	return rows[0]?.n ?? 0;
}

interface MemberRow {
	id: string;
	scenarioId: string | null;
	name: string;
	origin: ScenarioOrigin;
	ops: ScenarioOp[];
	ownedNodeIds: string[];
}

/** The engine on one input: its output, or its own words (plain text, never DB text). */
function run(input: ModelInput): { ok: true; out: ReturnType<typeof runModelChecked> } | { ok: false; message: string } {
	try {
		return { ok: true, out: runModelChecked(input) };
	} catch (err) {
		return { ok: false, message: `model run failed: ${(err as Error).message}` };
	}
}

/**
 * The assessment job's work, in the job's transaction as the user who
 * asked: run the baseline, each member alone (its ops copied at insert,
 * checkScenario under its applicant's mask) and all together
 * (combineScenarios, checked again: the base run is stored, so it can't have
 * changed, but the check is the rule), with the current engine for all of
 * them, so every column of the report is one engine's; then the cumulative
 * report. A member whose ops don't apply alone stores its problems and the
 * assessment is refused; an engine refusal fails it. `progress` is called
 * after each run (0–100); a false answer (the lease was lost) stops it with
 * nothing stored. Returns false when there was nothing to do.
 */
export async function computeAssessment(db: Db, projectId: string, assessmentId: string, progress: (pct: number) => Promise<boolean>): Promise<boolean> {
	const { rows } = await db.query<{ baseRunId: string; status: AssessmentStatus }>('SELECT base_run_id AS "baseRunId", status FROM assessment WHERE project_id = $1 AND id = $2', [
		projectId,
		assessmentId
	]);
	const a = rows[0];
	if (!a || a.status !== 'pending') return false;
	// A base run that can no longer be rebuilt fails the job (an ApiError: no retry); the assessment stays pending.
	const base = await loadBaseInput(db, projectId, a.baseRunId);
	const { rows: members } = await db.query<MemberRow>(
		`SELECT id, scenario_id AS "scenarioId", name, origin, ops, owned_node_ids::text[] AS "ownedNodeIds"
		 FROM assessment_member WHERE assessment_id = $1 ORDER BY position`,
		[assessmentId]
	);
	const total = members.length + 2;
	let done = 0;
	const step = async () => {
		if (!(await progress((100 * ++done) / total))) throw new LeaseLostError();
	};
	const finish = (status: Exclude<AssessmentStatus, 'pending' | 'complete'>, problems: string[]) =>
		db.query(`UPDATE assessment SET status = $2, problems = $3, engine_version = $4 WHERE id = $1`, [assessmentId, status, JSON.stringify(problems), ENGINE_VERSION]);

	const baseline = run(base);
	await step();
	const singles: { id: string; name: string; summary: RunSummary; startDate: string; endDate: string }[] = [];
	const memberProblems: string[] = [];
	let failed = !baseline.ok ? [`the baseline: ${baseline.message}`] : [];
	for (const m of members) {
		const entry = { id: m.scenarioId ?? m.id, name: m.name, ops: m.ops, origin: m.origin, ownedNodeIds: m.ownedNodeIds };
		const check = checkScenario(base, entry);
		if (check.problems.length) {
			await db.query(`UPDATE assessment_member SET status = 'problems', problems = $2 WHERE id = $1`, [m.id, JSON.stringify(check.problems)]);
			memberProblems.push(...check.problems.map((p) => `"${m.name}" alone: ${p}`));
		} else {
			const r = run(check.input);
			if (r.ok) {
				await db.query(`UPDATE assessment_member SET status = 'done', summary = $2, start_date = $3, end_date = $4 WHERE id = $1`, [
					m.id,
					JSON.stringify(r.out.summary),
					r.out.startDate,
					r.out.endDate
				]);
				singles.push({ id: entry.id, name: m.name, summary: r.out.summary, startDate: r.out.startDate, endDate: r.out.endDate });
			} else {
				await db.query(`UPDATE assessment_member SET status = 'failed', problems = $2 WHERE id = $1`, [m.id, JSON.stringify([r.message])]);
				failed = [...failed, `"${m.name}" alone: ${r.message}`];
			}
		}
		await step();
	}
	if (memberProblems.length) {
		await finish('refused', memberProblems);
		return true;
	}
	if (failed.length || !baseline.ok) {
		await finish('failed', failed);
		return true;
	}
	const combined = combineScenarios(
		base,
		members.map((m) => combineEntry(base, { id: m.scenarioId ?? m.id, name: m.name, ops: m.ops, origin: m.origin, ownedNodeIds: m.ownedNodeIds }))
	);
	if (!combined.input) {
		await finish('refused', [...combined.conflicts.map((c) => c.message), ...combined.problems]);
		return true;
	}
	const together = run(combined.input);
	await step();
	if (!together.ok) {
		await finish('failed', [`all together: ${together.message}`]);
		return true;
	}
	const report = cumulativeImpact(
		{ summary: baseline.out.summary, startDate: baseline.out.startDate, endDate: baseline.out.endDate },
		singles,
		{ summary: together.out.summary, startDate: together.out.startDate, endDate: together.out.endDate }
	);
	await db.query(
		`UPDATE assessment SET status = 'complete', report = $2, combined_summary = $3, start_date = $4, end_date = $5, engine_version = $6 WHERE id = $1`,
		[assessmentId, JSON.stringify(report), JSON.stringify(together.out.summary), together.out.startDate, together.out.endDate, ENGINE_VERSION]
	);
	return true;
}
