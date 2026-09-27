// Scenario sweeps (issue #53 R2, 062_scenario_sweeps.sql, docs/api.md
// § Sweeps): writing one with its job, reading them back, and the job's own
// work (computeSweep, called by jobs/handlers/sweep.ts).
import { randomUUID } from 'node:crypto';
import { ENGINE_VERSION, runModelChecked, type RunSeries, type RunSummary, type ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { LeaseLostError } from '../jobs/errors.js';
import { enqueueJob, type JobMeta, type JobStatus } from '../jobs/queue.js';
import { checkScenario, loadBaseInput } from '../scenarios/execute.js';
import { opsSha256 } from '../scenarios/schema.js';
import { type CreateSweepBody, SWEEP_SERIES_KEYS, SWEEPS_KEPT } from './schema.js';

export type SweepStatus = 'pending' | 'complete';
export type SweepMemberStatus = 'pending' | 'done' | 'problems' | 'failed';

export interface SweepMemberRow {
	id: string;
	position: number;
	name: string;
	ops: ScenarioOp[];
	opsSha256: string;
	status: SweepMemberStatus;
	/** Why it didn't run: each op that doesn't apply, or the engine's refusal. Empty when done. */
	problems: string[];
	startDate: string | null;
	endDate: string | null;
	finishedAt: string | null;
	/** The run summary (model_run.summary's shape); only on GET …/sweeps/:sweepId, and only when done. */
	summary?: RunSummary | null;
	/**
	 * The catchment-level outcome series (SWEEP_SERIES_KEYS, nodeId null), a
	 * missing value as null; only on GET …/sweeps/:sweepId?series=true, and
	 * only when done.
	 */
	series?: StoredSeries[] | null;
}

/** A RunSeries as JSON stores it: NaN (no value) is null. */
export type StoredSeries = Omit<RunSeries, 'values'> & { values: (number | null)[] };

/** How much of each member a read returns: the list's brief, the summary, or the summary and series too. */
export type SweepDetail = 'brief' | 'summary' | 'series';

export interface SweepRow {
	id: string;
	name: string;
	baseRunId: string;
	/** The base run's label and date, for "Based on run X". */
	baseRun: { id: string; label: string; createdAt: string };
	status: SweepStatus;
	engineVersion: string | null;
	/** The job computing it (null once the 30-day purge removed it): a dead job's error says why a sweep stayed pending. */
	job: { id: string; status: JobStatus; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	members: SweepMemberRow[];
}

const memberFields = (detail: SweepDetail) => `jsonb_build_object('id', m.id, 'position', m.position, 'name', m.name, 'ops', m.ops,
	'opsSha256', m.ops_sha256, 'status', m.status, 'problems', m.problems, 'startDate', m.start_date, 'endDate', m.end_date,
	'finishedAt', m.finished_at${detail !== 'brief' ? `, 'summary', m.summary` : ''}${detail === 'series' ? `, 'series', m.series` : ''})`;

const sweepSelect = (detail: SweepDetail) => `SELECT s.id, s.name, s.base_run_id AS "baseRunId",
	jsonb_build_object('id', r.id, 'label', r.label, 'createdAt', r.created_at) AS "baseRun",
	s.status, s.engine_version AS "engineVersion",
	CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object('id', j.id, 'status', j.status, 'error', j.last_error, 'progress', j.progress) END AS job,
	u.display_name AS "createdBy", s.created_at AS "createdAt", s.completed_at AS "completedAt",
	(SELECT COALESCE(jsonb_agg(${memberFields(detail)} ORDER BY m.position), '[]'::jsonb)
	 FROM scenario_sweep_member m WHERE m.sweep_id = s.id) AS members
	FROM scenario_sweep s JOIN model_run r ON r.id = s.base_run_id
	LEFT JOIN job j ON j.id = s.job_id LEFT JOIN app_user u ON u.id = s.created_by`;

/**
 * Write a sweep, its members and its job, as the transaction's user (an
 * editor, RLS), and keep the project's newest SWEEPS_KEPT. The base run is
 * checked first (loadBaseInput: 404 when it isn't this project's or can't be
 * seen, 409 for a scenario or forecast run or one that can't be rebuilt), so
 * a bad request is an error here, not a dead job later. Wake the worker
 * after the commit.
 */
export async function createSweep(db: Db, projectId: string, body: CreateSweepBody): Promise<{ sweep: SweepRow; job: JobMeta }> {
	await loadBaseInput(db, projectId, body.baseRunId);
	const sweepId = randomUUID();
	// The job first, so the sweep row can name it (the guard checks it is this project's sweep job).
	const { job } = await enqueueJob(db, { projectId, kind: 'sweep', payload: { sweepId }, maxAttempts: 2 });
	await db.query('INSERT INTO scenario_sweep (id, project_id, base_run_id, job_id, name) VALUES ($1, $2, $3, $4, $5)', [
		sweepId,
		projectId,
		body.baseRunId,
		job.id,
		body.name
	]);
	await db.query(
		`INSERT INTO scenario_sweep_member (sweep_id, project_id, position, name, ops, ops_sha256)
		 SELECT $1, $2, p, n, o, h FROM unnest($3::int[], $4::text[], $5::jsonb[], $6::text[]) AS t(p, n, o, h)`,
		[
			sweepId,
			projectId,
			body.members.map((_, i) => i),
			body.members.map((m) => m.name),
			body.members.map((m) => JSON.stringify(m.ops)),
			body.members.map((m) => opsSha256(m.ops))
		]
	);
	await db.query(
		`DELETE FROM scenario_sweep WHERE id IN (
			SELECT id FROM scenario_sweep WHERE project_id = $1 ORDER BY created_at DESC, id DESC OFFSET $2)`,
		[projectId, SWEEPS_KEPT]
	);
	return { sweep: (await getSweep(db, projectId, sweepId, 'brief'))!, job };
}

/** A project's sweeps, newest first, optionally of one base run: members without their summaries (RLS: viewer). */
export async function listSweeps(db: Db, projectId: string, q: { baseRunId?: string } = {}): Promise<SweepRow[]> {
	const { rows } = await db.query<SweepRow>(
		`${sweepSelect('brief')} WHERE s.project_id = $1 AND ($2::uuid IS NULL OR s.base_run_id = $2)
		 ORDER BY s.created_at DESC, s.id DESC LIMIT ${SWEEPS_KEPT}`,
		[projectId, q.baseRunId ?? null]
	);
	return rows;
}

/** One sweep of a project, its members to `detail` (default: with their summaries); null when there is none (RLS: viewer). */
export async function getSweep(db: Db, projectId: string, sweepId: string, detail: SweepDetail = 'summary'): Promise<SweepRow | null> {
	const { rows } = await db.query<SweepRow>(`${sweepSelect(detail)} WHERE s.project_id = $1 AND s.id = $2`, [projectId, sweepId]);
	return rows[0] ?? null;
}

/** Queued or running sweep jobs the user has, in any project they can still see. */
export async function pendingSweepJobs(db: Db): Promise<number> {
	// Count and enqueue one request at a time per user (the lock is held to
	// commit), so a burst of requests can't all pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('sweep_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job WHERE kind = 'sweep' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	return rows[0]?.n ?? 0;
}

/**
 * The sweep job's work, in the job's transaction as the user who asked:
 * apply each pending member's ops to the base run's stored input
 * (scenarios/execute.ts checkScenario, as a team scenario with no owned
 * nodes) and run the engine, storing the member's run summary and its
 * catchment-level outcome series (SWEEP_SERIES_KEYS); a member
 * whose ops don't apply stores its problems instead, and one the engine
 * refuses stores the engine's message, and the sweep carries on. Then the
 * sweep is complete. `progress` is called after each member (0–100); a
 * false answer (the lease was lost) stops the sweep with nothing stored.
 * Returns false when there was nothing to do (the sweep was deleted, or is
 * already complete).
 */
export async function computeSweep(db: Db, projectId: string, sweepId: string, progress: (pct: number) => Promise<boolean>): Promise<boolean> {
	const { rows } = await db.query<{ baseRunId: string; status: SweepStatus }>(
		'SELECT base_run_id AS "baseRunId", status FROM scenario_sweep WHERE project_id = $1 AND id = $2',
		[projectId, sweepId]
	);
	const sweep = rows[0];
	if (!sweep || sweep.status === 'complete') return false;
	// A base run that can no longer be rebuilt fails the job (an ApiError: no retry), the sweep stays pending.
	const base = await loadBaseInput(db, projectId, sweep.baseRunId);
	const { rows: members } = await db.query<{ id: string; ops: ScenarioOp[] }>(
		`SELECT id, ops FROM scenario_sweep_member WHERE sweep_id = $1 AND status = 'pending' ORDER BY position`,
		[sweepId]
	);
	for (const [i, m] of members.entries()) {
		const check = checkScenario(base, { ops: m.ops, ownedNodeIds: [], origin: 'team' });
		if (check.problems.length) {
			await db.query(`UPDATE scenario_sweep_member SET status = 'problems', problems = $2 WHERE id = $1`, [m.id, JSON.stringify(check.problems)]);
		} else {
			let output: ReturnType<typeof runModelChecked> | null = null;
			let failure = '';
			try {
				output = runModelChecked(check.input);
			} catch (err) {
				// The engine's own words (a missing series, over-allocated shares …): plain text, never DB text.
				failure = `model run failed: ${(err as Error).message}`;
			}
			if (output) {
				// JSON has no NaN: a missing value is stored as null (JSON.stringify's own mapping).
				const series = output.series.filter((x) => x.nodeId === null && (SWEEP_SERIES_KEYS as readonly string[]).includes(x.key));
				await db.query(`UPDATE scenario_sweep_member SET status = 'done', summary = $2, series = $3, start_date = $4, end_date = $5 WHERE id = $1`, [
					m.id,
					JSON.stringify(output.summary),
					JSON.stringify(series),
					output.startDate,
					output.endDate
				]);
			} else {
				await db.query(`UPDATE scenario_sweep_member SET status = 'failed', problems = $2 WHERE id = $1`, [m.id, JSON.stringify([failure])]);
			}
		}
		// False only when the lease was lost (a sweep can't be cancelled): roll back, record nothing.
		if (!(await progress((100 * (i + 1)) / members.length))) throw new LeaseLostError();
	}
	await db.query(`UPDATE scenario_sweep SET status = 'complete', engine_version = $2 WHERE id = $1`, [sweepId, ENGINE_VERSION]);
	return true;
}
