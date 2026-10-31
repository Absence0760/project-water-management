// A cumulative assessment's firm yields, one job each (297_assessment_yield_jobs;
// docs/scenarios.md § Cumulative impact, docs/data-model.md § Assessments).
//
// The assessment job (store.ts computeAssessment) runs the baseline, each
// member alone and all together, builds the report with the dam rows' firm
// yields still empty, keeps it in `assessment.gathering` and fans out: one
// `assessment_yield` job and row per dam the applications touch and run that
// has it (fanOutYields). Each of those jobs, as the same editor under RLS,
// rebuilds its run's input from the stored base run and copied ops, works
// out its one firm yield (engine damFirmYields: a search that finds none is a
// warning, never a failure) and stores it on its row (computeAssessmentYield),
// then gathers (gatherAssessment): under a per-assessment lock, once every row
// has its yield, it fills the report's `dam_firm_yield` rows (engine
// cumulativeDamRow) and completes the assessment; the report's shape is what
// the single job stored. A row whose job died, or ended without storing it,
// fails the assessment; when no sibling is left to see that, the API reads
// it so (stoppedYieldsSql in assessmentSelect), so it never hangs pending.
import { randomUUID } from 'node:crypto';
import {
	combineScenarios,
	cumulativeDamRow,
	damFirmYields,
	ENGINE_VERSION,
	isCumulativeDam,
	type CumulativeDam,
	type ModelInput,
	type RunSummary
} from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { JobError } from '../jobs/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { checkScenario, loadBaseInput } from '../scenarios/execute.js';
import type { AssessmentReport } from './background.js';
import { combineEntry, loadMembers, memberEntry } from './members.js';

/** The `assessment_yield` job's payload: its row, and the assessment it belongs to. */
export const AssessmentYieldPayload = z.object({ assessmentId: z.string().uuid(), yieldId: z.string().uuid() }).strict();
export type AssessmentYieldPayload = z.infer<typeof AssessmentYieldPayload>;

/** Attempts per firm-yield job, as the assessment's own (store.ts). */
export const ASSESSMENT_YIELD_ATTEMPTS = 2;

type RunKind = 'baseline' | 'single' | 'combined';

/** One run the dams are searched on: which, how the report names it, and its input. */
export interface YieldRun {
	run: RunKind;
	/** The member's position, for a single. */
	memberPosition: number | null;
	label: string;
	input: ModelInput;
}

/** What the assessment keeps while its yields are out (assessment.gathering, never served). */
export interface Gathering {
	/** The engine the runs were made with; a yield job on another fails the assessment rather than mix two. */
	engineVersion: string;
	/** The report as the assessment job built it, the dam rows' firm yields empty. */
	report: AssessmentReport;
	combinedSummary: RunSummary;
	startDate: string;
	endDate: string;
	dams: CumulativeDam[];
	/** The members' positions, in the report's singles order. */
	members: number[];
	/** The warning naming the touched dams past the cap, added after the yields' own. */
	leftWarning: string | null;
}

/**
 * The yields of an assessment `ref` (a SQL expression) whose job stopped
 * without storing them: dead (its attempts spent, or its user no longer an
 * editor), done without a result, or purged. One line each, in the report's
 * order, as `problem`.
 */
export const stoppedYieldsSql = (ref: string) => `SELECT format('%s: the firm yield of "%s" didn''t finish (%s)', y.run_label, y.dam_name,
		CASE WHEN yj.id IS NULL THEN 'its job was cleared' WHEN yj.status = 'dead' THEN COALESCE(yj.last_error, 'its job stopped') ELSE 'its job ended without storing it' END) AS problem,
		CASE y.run WHEN 'baseline' THEN 0 WHEN 'single' THEN 1 ELSE 2 END AS o1, y.member_position AS o2, y.dam_position AS o3
	FROM assessment_yield y LEFT JOIN job yj ON yj.id = y.job_id
	WHERE y.assessment_id = ${ref} AND y.status = 'pending' AND (yj.id IS NULL OR yj.status IN ('dead', 'done'))`;

/**
 * Queue one job per dam and run that has it, each with its row, as the
 * transaction's user (whoever asked: the assessment job runs as them), and
 * keep `gathering` until they are back; then gather, which completes at once
 * when there was nothing to queue. Returns how many were queued.
 */
export async function fanOutYields(db: Db, projectId: string, assessmentId: string, gathering: Gathering, runs: readonly YieldRun[]): Promise<number> {
	await db.query('UPDATE assessment SET gathering = $2 WHERE id = $1', [assessmentId, JSON.stringify(gathering)]);
	let queued = 0;
	for (const r of runs) {
		for (const [position, dam] of gathering.dams.entries()) {
			// A dam only some runs have (one an application adds) is null in the others: nothing to search.
			if (!isCumulativeDam(r.input, dam.nodeId)) continue;
			const yieldId = randomUUID();
			const { job } = await enqueueJob(db, { projectId, kind: 'assessment_yield', payload: { assessmentId, yieldId }, maxAttempts: ASSESSMENT_YIELD_ATTEMPTS });
			await db.query(
				`INSERT INTO assessment_yield (id, assessment_id, project_id, job_id, run, member_position, dam_position, node_id, dam_name, run_label)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				[yieldId, assessmentId, projectId, job.id, r.run, r.memberPosition, position, dam.nodeId, dam.name, r.label]
			);
			queued++;
		}
	}
	await gatherAssessment(db, projectId, assessmentId);
	return queued;
}

interface YieldRow {
	id: string;
	assessmentId: string;
	run: RunKind;
	memberPosition: number | null;
	nodeId: string;
	damName: string;
	runLabel: string;
	status: 'pending' | 'done';
	baseRunId: string;
	assessmentStatus: string;
	engineVersion: string | null;
}

/**
 * The `assessment_yield` job's work, as whoever asked for the assessment:
 * its row (of the job's own project, naming this job: a payload naming
 * another project's row, or another job's, does nothing), its run's input
 * rebuilt as the assessment job built it, one firm-yield search, the result
 * stored, then the gather. Nothing to do when the row or its assessment is
 * finished or gone. Ops that no longer apply, or a combination that no
 * longer holds, can't happen on a stored base run and copied ops; if they do,
 * the job fails without a retry, and the gather of a sibling (or the API's
 * read) fails the assessment.
 */
export async function computeAssessmentYield(db: Db, job: { id: string; projectId: string }, payload: AssessmentYieldPayload): Promise<void> {
	const { rows } = await db.query<YieldRow>(
		`SELECT y.id, y.assessment_id AS "assessmentId", y.run, y.member_position AS "memberPosition", y.node_id AS "nodeId",
			y.dam_name AS "damName", y.run_label AS "runLabel", y.status, a.base_run_id AS "baseRunId", a.status AS "assessmentStatus",
			a.gathering->>'engineVersion' AS "engineVersion"
		 FROM assessment_yield y JOIN assessment a ON a.id = y.assessment_id
		 WHERE y.id = $1 AND y.assessment_id = $2 AND y.project_id = $3 AND y.job_id = $4`,
		[payload.yieldId, payload.assessmentId, job.projectId, job.id]
	);
	const row = rows[0];
	if (!row || row.status !== 'pending' || row.assessmentStatus !== 'pending') return;
	// Another engine than the runs': no search; the gather fails the assessment rather than mix two engines in one report.
	if (row.engineVersion !== ENGINE_VERSION) return gatherAssessment(db, job.projectId, row.assessmentId);
	const base = await loadBaseInput(db, job.projectId, row.baseRunId);
	const input = await runInput(db, base, row);
	const dam = { nodeId: row.nodeId, name: row.damName };
	const y = damFirmYields(input, [dam], row.runLabel);
	await db.query(`UPDATE assessment_yield SET status = 'done', yield_m3_year = $2, warning = $3 WHERE id = $1`, [
		row.id,
		y.yields[0] ?? null,
		y.warnings.length ? y.warnings.join(' ').slice(0, 2000) : null
	]);
	await gatherAssessment(db, job.projectId, row.assessmentId);
}

/** The input of a yield's run, as the assessment job built it. */
async function runInput(db: Db, base: ModelInput, row: YieldRow): Promise<ModelInput> {
	if (row.run === 'baseline') return base;
	const members = await loadMembers(db, row.assessmentId);
	if (row.run === 'single') {
		const m = members.find((x) => x.position === row.memberPosition);
		if (!m) throw new JobError('the assessment no longer has this application', { retry: false });
		const check = checkScenario(base, memberEntry(m));
		if (check.problems.length) throw new JobError(`${row.runLabel}: its changes no longer apply`, { retry: false });
		return check.input;
	}
	const together = combineScenarios(
		base,
		members.map((m) => combineEntry(base, memberEntry(m)))
	);
	if (!together.input) throw new JobError('the applications no longer combine', { retry: false });
	return together.input;
}

interface DoneRow {
	run: RunKind;
	memberPosition: number | null;
	damPosition: number;
	status: 'pending' | 'done';
	yieldM3Year: number | null;
	warning: string | null;
}

/**
 * Gather an assessment's yields, holding its lock (so of two yield jobs
 * finishing at once, the second sees the first's row): nothing while one is
 * still queued or running; failed, saying which, when one stopped without
 * its yield or the engine changed; otherwise the report's `dam_firm_yield`
 * rows filled, the searches' warnings added (then the one naming dams past
 * the cap), and the assessment completed. Only for a pending assessment
 * that is gathering; as whoever asked (the complete-once guards, 145 and 297).
 */
export async function gatherAssessment(db: Db, projectId: string, assessmentId: string): Promise<void> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('assessment_gather:' || $1::text, 0))`, [assessmentId]);
	const { rows: found } = await db.query<{ status: string; gathering: Gathering | null }>('SELECT status, gathering FROM assessment WHERE project_id = $1 AND id = $2', [
		projectId,
		assessmentId
	]);
	const a = found[0];
	if (!a || a.status !== 'pending' || !a.gathering) return;
	const g = a.gathering;
	const fail = async (problems: string[]) => {
		await db.query(`UPDATE assessment SET status = 'failed', problems = $2, engine_version = $3, gathering = NULL WHERE id = $1`, [
			assessmentId,
			JSON.stringify(problems),
			g.engineVersion
		]);
	};
	if (g.engineVersion !== ENGINE_VERSION)
		return fail([`The engine changed (from ${g.engineVersion} to ${ENGINE_VERSION}) while the dams' firm yields were worked out; assess them together again.`]);
	const { rows: stopped } = await db.query<{ problem: string }>(`SELECT s.problem FROM (${stoppedYieldsSql('$1')}) s ORDER BY s.o1, s.o2, s.o3`, [assessmentId]);
	if (stopped.length) return fail(stopped.map((s) => s.problem));
	const { rows } = await db.query<DoneRow>(
		`SELECT run, member_position AS "memberPosition", dam_position AS "damPosition", status, yield_m3_year AS "yieldM3Year", warning
		 FROM assessment_yield WHERE assessment_id = $1
		 ORDER BY CASE run WHEN 'baseline' THEN 0 WHEN 'single' THEN 1 ELSE 2 END, member_position, dam_position`,
		[assessmentId]
	);
	if (rows.some((r) => r.status === 'pending')) return;
	const value = (run: RunKind, position: number | null, dam: number) =>
		rows.find((r) => r.run === run && r.memberPosition === position && r.damPosition === dam)?.yieldM3Year ?? null;
	const report = g.report;
	report.rows = report.rows.map((r) => {
		if (r.metric !== 'dam_firm_yield') return r;
		const i = g.dams.findIndex((d) => d.nodeId === r.siteNodeId);
		if (i < 0) return r;
		return cumulativeDamRow(
			'dam_firm_yield',
			g.dams[i]!,
			value('baseline', null, i),
			g.members.map((p) => value('single', p, i)),
			value('combined', null, i)
		);
	});
	// The searches' warnings in the report's order, each once (a run whose yield problem couldn't be built says so per dam).
	report.warnings.push(...new Set(rows.flatMap((r) => (r.warning ? [r.warning] : []))));
	if (g.leftWarning) report.warnings.push(g.leftWarning);
	await db.query(
		`UPDATE assessment SET status = 'complete', report = $2, combined_summary = $3, start_date = $4, end_date = $5, engine_version = $6, gathering = NULL WHERE id = $1`,
		[assessmentId, JSON.stringify(report), JSON.stringify(g.combinedSummary), g.startDate, g.endDate, g.engineVersion]
	);
}
